// Owner queue automatic resume: the per-attempt and per-session bounds, the worktree occupancy rule with its root
// refresh and claim lock, the session marker, the pre-spawn re-read, the payload and the captured bg id.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/queue.resume.test.ts
// A fake launcher runs /bin/sh in place of `claude` and counts every spawn; sweeps are scoped to this file's sessions.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import type { QueueDelivery, QueueItemStatus, QueueSessionState } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { ackItem } from "../src/server/queue/delivery.js";
import { buildResumePayload } from "../src/server/queue/envelope.js";
import { putResend } from "../src/server/queue/owner-items.js";
import { createMessages } from "../src/server/queue/owner-sessions.js";
import { getOwnerItemOrThrow } from "../src/server/queue/owner-views.js";
import { getProcessStartTime } from "../src/server/queue/process-start-time.js";
import { deregisterSession, findWorktreeRoot, registerSession } from "../src/server/queue/registry.js";
import { buildWorktreeLockKey, claimResume, findClaimableSessionIds, getRereadOutcome } from "../src/server/queue/resume-claim.js";
import { type ClaudeLauncher, type LaunchRequest, buildResumeArgs, spawnClaudeLauncher } from "../src/server/queue/resume-spawn.js";
import { startQueueScheduler } from "../src/server/queue/scheduler.js";
import { type SweepDeps, runSweepPass } from "../src/server/queue/sweep.js";
import { deleteDirectory } from "./lib/remove-dir.js";
import { lockQueueRows, unlockQueueRows } from "./lib/queue-rows-lock.js";

const CLI_PATH = "/opt/atrium-test/scripts/atrium-queue.sh";
const CLAUDE_PATH = "/opt/atrium-test/bin/claude";
const MINUTE_MS = 60_000;
const CAPTURE_TIME_BOUND_MS = 30_000;

const fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "queue-resume-")));
// Under /tmp itself → registers as /tmp/… and stores /private/tmp/… on macOS
const tmpRoot = mkdtempSync("/tmp/queue-resume-");
const dir = { home: path.join(fixtureRoot, "home"), tokens: path.join(fixtureRoot, "tokens"), plain: path.join(fixtureRoot, "plain"), images: path.join(fixtureRoot, "images") };
const trackedSessionIds: string[] = [];
const children: ChildProcess[] = [];

before(async () => {
  await lockQueueRows();
  for (const fixtureDir of Object.values(dir)) mkdirSync(fixtureDir, { recursive: true, mode: 0o700 });
});

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  const prisma = getPrisma();
  await prisma.queueDelivery.deleteMany({ where: { item: { sessionId: { in: trackedSessionIds } } } });
  await prisma.queueItem.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await prisma.queueSession.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await unlockQueueRows();
  await disconnectPrisma();
  deleteDirectory(fixtureRoot);
  deleteDirectory(realpathSync(tmpRoot));
});

async function spawnLiveProcess(): Promise<{ pid: number; startTime: string }> {
  const child = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  children.push(child);
  if (child.pid === undefined) throw new Error("sleep child spawn failed");
  const startTime = await getProcessStartTime(child.pid);
  if (startTime === null) throw new Error(`start time unreadable for pid ${child.pid}`);
  return { pid: child.pid, startTime };
}

/** A directory holding a `.git` entry: a directory for a main checkout, a file for a linked worktree. */
function makeRepo(repoDir: string, kind: "main" | "linked" = "main"): string {
  mkdirSync(repoDir, { recursive: true });
  if (kind === "main") mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  else writeFileSync(path.join(repoDir, ".git"), "gitdir: /nowhere/.git/worktrees/wt\n");
  return repoDir;
}

function makeDir(dirPath: string): string {
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function newFixtureDir(name: string): string {
  return mkdtempSync(path.join(fixtureRoot, `${name}-`));
}

interface FakeLauncher {
  launcher: ClaudeLauncher;
  calls: LaunchRequest[];
  exits: { count: number };
}

/** Runs `script` under /bin/sh with the request's cwd, env and stdout fd; `fail` names a missing binary (no process). */
function buildFakeLauncher(script = "exit 0", options: { fail?: boolean; onLaunch?: (request: LaunchRequest) => void } = {}): FakeLauncher {
  const calls: LaunchRequest[] = [];
  const exits = { count: 0 };
  const launcher: ClaudeLauncher = (request) => {
    calls.push(request);
    options.onLaunch?.(request);
    const command = options.fail === true ? path.join(fixtureRoot, "missing-claude") : "/bin/sh";
    const launch = spawnClaudeLauncher({ ...request, command, args: ["-c", script] });
    void launch.exited.then(() => (exits.count += 1));
    return launch;
  };
  return { launcher, calls, exits };
}

interface ResumeHarness {
  deps: SweepDeps;
  fake: FakeLauncher;
  captures: Array<Promise<void>>;
  clock: { ms: number };
  captureDir: string;
  abort: AbortController;
}

function buildHarness(sessionIds: string[], fake: FakeLauncher = buildFakeLauncher(), resumeOverrides: Partial<NonNullable<SweepDeps["resume"]>> = {}): ResumeHarness {
  const captures: Array<Promise<void>> = [];
  const clock = { ms: Date.now() };
  const captureDir = path.join(newFixtureDir("capture"), "resume-capture");
  const abort = new AbortController();
  const deps: SweepDeps = {
    readStartTime: getProcessStartTime,
    now: () => new Date(clock.ms),
    cliPath: CLI_PATH,
    tokenDir: dir.tokens,
    imageDir: dir.images,
    scope: { sessionIds },
    resume: { launcher: fake.launcher, claudePath: CLAUDE_PATH, captureDir, signal: abort.signal, onCapture: (capture) => captures.push(capture), ...resumeOverrides },
  };
  return { deps, fake, captures, clock, captureDir, abort };
}

interface SessionSeed {
  state?: QueueSessionState;
  cwd?: string;
  worktreeRoot?: string | null;
  identity?: { pid: number; startTime: string };
  isMarked?: boolean;
  configDir?: string;
}

async function seedSession(seed: SessionSeed = {}): Promise<string> {
  const sessionId = randomUUID();
  trackedSessionIds.push(sessionId);
  const identity = seed.identity ?? { pid: 999_999, startTime: "Mon Jan  1 00:00:00 2026" };
  const state = seed.state ?? "exited";
  await getPrisma().queueSession.create({
    data: {
      sessionId,
      isConfigDirSet: seed.configDir !== undefined,
      configDir: seed.configDir ?? null,
      profileLabel: seed.configDir === undefined ? "default" : path.basename(seed.configDir),
      cwd: seed.cwd ?? dir.plain,
      worktreeRoot: seed.worktreeRoot ?? null,
      pid: identity.pid,
      processStartTime: identity.startTime,
      socketPath: null,
      state,
      exitReason: state === "exited" ? "ended" : null,
      lastSeenAt: new Date(),
      resumeAwaitingRegisterAt: seed.isMarked === true ? new Date() : null,
    },
  });
  return sessionId;
}

/** A live row for a fresh process: its own pid, so no register marks another row replaced. */
async function seedLiveSession(cwd: string, worktreeRoot: string | null = null): Promise<string> {
  return seedSession({ state: "live", cwd, worktreeRoot, identity: await spawnLiveProcess() });
}

async function seedItem(sessionId: string, status: QueueItemStatus, options: { isApprovalClass?: boolean; nextAttempt?: number } = {}): Promise<bigint> {
  const item = await getPrisma().queueItem.create({
    data: {
      kind: "decision",
      sessionId,
      title: "Pick the branch cleanup scope",
      body: "Three stale branches remain after the nightly sweep.",
      options: [
        { code: "R1", label: "Delete all three", pros: "clean tree", cons: "no undo" },
        { code: "R2", label: "Keep them", pros: "safe", cons: "clutter" },
      ],
      recommendedCode: "R2",
      isFreeTextAllowed: false,
      isApprovalClass: options.isApprovalClass ?? false,
      status,
      answerCode: "R2",
      nextAttempt: options.nextAttempt ?? 1,
      answeredAt: new Date(),
    },
  });
  return item.id;
}

async function seedResumeInFlight(sessionId: string): Promise<bigint> {
  const itemId = await seedItem(sessionId, "delivering");
  await getPrisma().queueDelivery.create({
    data: { msgId: randomUUID(), itemId, route: "resume", attempt: 1, result: "sent", sentAt: new Date(), ackDeadlineAt: new Date(Date.now() + 30 * MINUTE_MS) },
  });
  return itemId;
}

async function getStatus(itemId: bigint): Promise<QueueItemStatus> {
  return (await getPrisma().queueItem.findUniqueOrThrow({ where: { id: itemId } })).status;
}

function getResumeRows(itemId: bigint): Promise<QueueDelivery[]> {
  return getPrisma().queueDelivery.findMany({ where: { itemId, route: "resume" }, orderBy: { id: "asc" } });
}

async function isMarked(sessionId: string): Promise<boolean> {
  return (await getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId } })).resumeAwaitingRegisterAt !== null;
}

async function setExited(sessionId: string): Promise<void> {
  await getPrisma().queueSession.update({ where: { sessionId }, data: { state: "exited", exitReason: "ended" } });
}

async function runPasses(harness: ResumeHarness, count: number): Promise<void> {
  for (let pass = 0; pass < count; pass += 1) await runSweepPass(harness.deps);
  await Promise.all(harness.captures);
}

async function getSkipReason(itemId: bigint) {
  return (await getOwnerItemOrThrow(Number(itemId))).skipReason;
}

describe("automatic resume of an exited session", () => {
  test("a resume-pending item on an exited row is resumed with no owner action, recording the spawn time and attempt", async () => {
    const cwd = newFixtureDir("own");
    const sessionId = await seedSession({ cwd, configDir: dir.home });
    const itemId = await seedItem(sessionId, "resume_pending", { nextAttempt: 3 });
    const harness = buildHarness([sessionId]);

    await runPasses(harness, 1);

    const [call] = harness.fake.calls;
    const [row] = await getResumeRows(itemId);
    assert.ok(call !== undefined && row !== undefined);
    assert.equal(harness.fake.calls.length, 1);
    assert.deepEqual(call.args.slice(0, 3), ["--resume", sessionId, "--bg"]);
    assert.equal(call.command, CLAUDE_PATH);
    assert.equal(call.cwd, cwd);
    assert.equal(call.env.CLAUDE_CONFIG_DIR, dir.home);
    assert.equal(call.env.DATABASE_URL, undefined);
    assert.deepEqual([row.attempt, row.result], [3, "sent"]);
    assert.equal(row.sentAt.getTime(), harness.clock.ms);
    assert.equal(await getStatus(itemId), "delivering");
    assert.equal(await isMarked(sessionId), true);
  });

  test("an owner message to an exited session is resumed exactly once, under the message header", async () => {
    const sessionId = await seedSession({ cwd: newFixtureDir("message") });
    const { items: [message] } = await createMessages({ sessionIds: [sessionId], text: "Rebase onto main before the review.", attachmentIds: [] }, "fetch_metadata");
    assert.ok(message !== undefined);
    const harness = buildHarness([sessionId]);

    await runPasses(harness, 3);

    const [call] = harness.fake.calls;
    assert.equal(harness.fake.calls.length, 1);
    assert.ok(call?.args[3]?.includes(`[ATRIUM-MESSAGE v1] item ${message.id}`), "the resume payload carries the message envelope");
    assert.ok(!call?.args[3]?.includes("Rebase onto main"), "the message text is fetched, never put in the payload");
    assert.equal((await getResumeRows(BigInt(message.id))).length, 1);
  });

  const neverResumed: Array<{ name: string; state: QueueSessionState }> = [
    { name: "live row", state: "live" },
    { name: "stale row", state: "stale" },
  ];
  for (const row of neverResumed) {
    test(`a resume-pending item never spawns a resume on a ${row.name}`, async () => {
      const sessionId = await seedSession({ state: row.state, identity: await spawnLiveProcess() });
      await seedItem(sessionId, "resume_pending");
      const harness = buildHarness([sessionId]);

      await runPasses(harness, 2);

      assert.equal(harness.fake.calls.length, 0, row.name);
    });
  }

  test("an attempt gets exactly one automatic resume across any number of sweeps, and a Resend allows exactly one more", async () => {
    const sessionId = await seedSession();
    const itemId = await seedItem(sessionId, "resume_pending");
    const harness = buildHarness([sessionId]);
    await runPasses(harness, 1);
    // the resumed process registered, then exited again without an ack; its deadline passes
    await getPrisma().queueSession.update({ where: { sessionId }, data: { resumeAwaitingRegisterAt: null } });
    harness.clock.ms += 31 * MINUTE_MS;

    await runPasses(harness, 4);
    const beforeResend = { spawns: harness.fake.calls.length, status: await getStatus(itemId), skip: await getSkipReason(itemId) };
    await putResend(Number(itemId));
    await runPasses(harness, 4);

    assert.deepEqual(beforeResend, { spawns: 1, status: "resume_pending", skip: { kind: "resume_used" } });
    assert.equal(harness.fake.calls.length, 2);
    assert.deepEqual((await getResumeRows(itemId)).map((row) => row.attempt), [1, 2]);
  });

  test("an item whose attempt already used its automatic resume does not hold back a fresh item of the same session", async () => {
    const sessionId = await seedSession();
    const usedItemId = await seedItem(sessionId, "resume_pending");
    await getPrisma().queueDelivery.create({
      data: { msgId: randomUUID(), itemId: usedItemId, route: "resume", attempt: 1, result: "failed", sentAt: new Date(Date.now() - 40 * MINUTE_MS), ackDeadlineAt: new Date(Date.now() - 10 * MINUTE_MS) },
    });
    const freshItemId = await seedItem(sessionId, "resume_pending");
    const harness = buildHarness([sessionId]);

    await runPasses(harness, 1);

    const payload = harness.fake.calls[0]?.args[3] ?? "";
    assert.equal(harness.fake.calls.length, 1);
    assert.ok(payload.includes(`${CLI_PATH} get ${freshItemId} `) && !payload.includes(`${CLI_PATH} get ${usedItemId} `));
    assert.deepEqual([await getStatus(usedItemId), await getStatus(freshItemId)], ["resume_pending", "delivering"]);
  });

  test("a spawn that starts no process fails its row, clears the marker, puts the item back to resume-pending with Resend open, frees the worktree and is never retried for that attempt", async () => {
    const repo = makeRepo(newFixtureDir("failed-spawn"));
    const ids = [await seedSession({ cwd: repo }), await seedSession({ cwd: repo })];
    const itemIds = [await seedItem(ids[0] ?? "", "resume_pending"), await seedItem(ids[1] ?? "", "resume_pending")];
    const harness = buildHarness(ids, buildFakeLauncher("exit 0", { fail: true }));

    await runPasses(harness, 3);

    // one spawn each: the first failed spawn leaves no resume in flight that would block its worktree neighbour
    assert.equal(harness.fake.calls.length, 2);
    for (const [index, itemId] of itemIds.entries()) {
      assert.deepEqual((await getResumeRows(itemId)).map((row) => row.result), ["failed"], `item ${index}`);
      assert.equal(await getStatus(itemId), "resume_pending", `item ${index}`);
      assert.equal(await isMarked(ids[index] ?? ""), false, `session ${index}`);
      assert.equal((await getOwnerItemOrThrow(Number(itemId))).canResend, true, `item ${index}`);
    }
  });

  test("the resume batch lists only exited sessions holding a claimable item, so items waiting on the owner never crowd it", async () => {
    const claimableId = await seedSession();
    await seedItem(claimableId, "resume_pending");
    const approvalId = await seedSession();
    await seedItem(approvalId, "resume_pending", { isApprovalClass: true });
    const usedId = await seedSession();
    const usedItemId = await seedItem(usedId, "resume_pending");
    await getPrisma().queueDelivery.create({
      data: { msgId: randomUUID(), itemId: usedItemId, route: "resume", attempt: 1, result: "failed", sentAt: new Date(Date.now() - 40 * MINUTE_MS), ackDeadlineAt: new Date(Date.now() - 10 * MINUTE_MS) },
    });
    const liveId = await seedSession({ state: "live" });
    await seedItem(liveId, "resume_pending");

    const listed = await findClaimableSessionIds({ sessionIds: [claimableId, approvalId, usedId, liveId] });

    assert.deepEqual(listed, [claimableId]);
  });

  test("two resume-pending items of one session go out in one spawn carrying both envelopes, and no second spawn runs while it is in flight", async () => {
    const sessionId = await seedSession();
    const itemIds = [await seedItem(sessionId, "resume_pending"), await seedItem(sessionId, "resume_pending")];
    const harness = buildHarness([sessionId]);

    await runPasses(harness, 1);
    await getPrisma().queueSession.update({ where: { sessionId }, data: { resumeAwaitingRegisterAt: null } });
    await runPasses(harness, 3);

    const payload = harness.fake.calls[0]?.args[3] ?? "";
    assert.equal(harness.fake.calls.length, 1);
    for (const itemId of itemIds) {
      const [row] = await getResumeRows(itemId);
      assert.ok(row !== undefined, `item ${itemId} has its resume row`);
      assert.ok(payload.includes(`${CLI_PATH} ack ${itemId} ${row.msgId}`), `payload carries the envelope of item ${itemId}`);
    }
  });

  test("two overlapping sweep passes on one item and attempt insert one resume row and spawn once", async () => {
    const sessionId = await seedSession({ cwd: makeRepo(newFixtureDir("overlap")) });
    const itemId = await seedItem(sessionId, "resume_pending");
    const harness = buildHarness([sessionId]);

    await Promise.all([runSweepPass(harness.deps), runSweepPass(harness.deps)]);
    await Promise.all(harness.captures);

    assert.equal(harness.fake.calls.length, 1);
    assert.equal((await getResumeRows(itemId)).length, 1);
  });

  test("a Resend on an exited row's item leaves no Delivery row on its way to resume-pending, and the next sweep spawns once", async () => {
    const sessionId = await seedSession();
    const itemId = await seedItem(sessionId, "unacked");
    const harness = buildHarness([sessionId]);
    await putResend(Number(itemId));

    await runSweepPass(harness.deps);
    const afterClaim = { status: await getStatus(itemId), rows: (await getPrisma().queueDelivery.count({ where: { itemId } })), spawns: harness.fake.calls.length };
    await runPasses(harness, 1);

    assert.deepEqual(afterClaim, { status: "resume_pending", rows: 0, spawns: 0 });
    assert.equal(harness.fake.calls.length, 1);
  });

  test("an approval-class item is never resumed, carries the terminal reason, and waits answered for the session's pull once its row registers live", async () => {
    const identity = await spawnLiveProcess();
    const cwd = newFixtureDir("approval");
    const sessionId = await seedSession({ cwd, identity });
    const itemId = await seedItem(sessionId, "resume_pending", { isApprovalClass: true });
    const harness = buildHarness([sessionId]);

    await runPasses(harness, 3);
    const skip = await getSkipReason(itemId);
    await registerSession({ sessionId, pid: identity.pid, cwd }, dir.home);
    await runPasses(harness, 1);

    assert.equal(harness.fake.calls.length, 0);
    assert.deepEqual(skip, { kind: "approval" });
    assert.equal(await getStatus(itemId), "answered");
    assert.equal(await getPrisma().queueDelivery.count({ where: { itemId } }), 0);
  });
});

describe("pre-spawn re-read", () => {
  test("a register racing the resume claim on one session id ends with no deadlock error and at most one spawn", async () => {
    const identity = await spawnLiveProcess();
    const cwd = makeRepo(newFixtureDir("race"));
    const sessionId = await seedSession({ cwd, identity: { pid: identity.pid, startTime: "Mon Jan  1 00:00:00 2026" } });
    await seedItem(sessionId, "resume_pending");

    // raced directly, not through the sweep → a claim picked as the deadlock victim rejects here instead of being logged
    const [claim] = await Promise.all([claimResume(sessionId, new Date()), registerSession({ sessionId, pid: identity.pid, cwd }, dir.home)]);

    // both committed → a claim that won the race meets the live row at the pre-spawn re-read, so nothing spawns
    assert.ok(claim === null || (await getRereadOutcome(claim)) === "session_returned");
  });

  test("a register committing after the claim stops the spawn, aborts its row as session returned, and the item waits answered for the session's pull", async () => {
    const identity = await spawnLiveProcess();
    const cwd = newFixtureDir("returned");
    const sessionId = await seedSession({ cwd, identity });
    const itemId = await seedItem(sessionId, "resume_pending");
    const register = () => registerSession({ sessionId, pid: identity.pid, cwd }, dir.home).then(() => undefined);
    const harness = buildHarness([sessionId], undefined, { hooks: { beforeReread: register } });

    await runPasses(harness, 1);

    const routes = (await getPrisma().queueDelivery.findMany({ where: { itemId }, orderBy: { id: "asc" } })).map((row) => [row.route, row.result, row.abortReason]);
    assert.equal(harness.fake.calls.length, 0);
    assert.deepEqual(routes, [["resume", "aborted", "session_returned"]]);
    assert.equal(await getStatus(itemId), "answered");
  });

  test("a session registering in the worktree after the claim stops the spawn, aborts the row as shared worktree and leaves the attempt used", async () => {
    const repo = makeRepo(newFixtureDir("late-neighbour"));
    const sessionId = await seedSession({ cwd: repo });
    const itemId = await seedItem(sessionId, "resume_pending");
    const neighbour = await spawnLiveProcess();
    const registerNeighbour = async () => {
      const neighbourId = randomUUID();
      trackedSessionIds.push(neighbourId);
      await registerSession({ sessionId: neighbourId, pid: neighbour.pid, cwd: repo }, dir.home);
    };
    const harness = buildHarness([sessionId], undefined, { hooks: { beforeReread: registerNeighbour } });

    await runPasses(harness, 1);
    await runPasses(harness, 2);

    assert.equal(harness.fake.calls.length, 0);
    assert.deepEqual((await getResumeRows(itemId)).map((row) => [row.result, row.abortReason]), [["aborted", "shared_worktree"]]);
    assert.equal(await getStatus(itemId), "resume_pending");
    assert.equal(await isMarked(sessionId), false);
    assert.deepEqual(await getSkipReason(itemId), { kind: "resume_used" });
  });
});

describe("worktree occupancy", () => {
  interface Layout {
    exitedCwd: string;
    occupantCwd: string;
  }
  const rows: Array<{ name: string; build: () => Layout; spawns: number }> = [
    { name: "a live session in the same checkout blocks", build: () => ((repo) => ({ exitedCwd: repo, occupantCwd: repo }))(makeRepo(newFixtureDir("same"))), spawns: 0 },
    { name: "a live session in a subdirectory of the checkout blocks", build: () => ((repo) => ({ exitedCwd: repo, occupantCwd: makeDir(path.join(repo, "monitor")) }))(makeRepo(newFixtureDir("sub"))), spawns: 0 },
    {
      name: "a live session in a linked worktree nested under the checkout does not block",
      build: () => ((repo) => ({ exitedCwd: repo, occupantCwd: makeRepo(path.join(repo, ".claude", "worktrees", "wt-a"), "linked") }))(makeRepo(newFixtureDir("linked"))),
      spawns: 1,
    },
    { name: "a live session in a non-git ancestor does not block", build: () => ((parent) => ({ exitedCwd: makeRepo(path.join(parent, "repo")), occupantCwd: parent }))(newFixtureDir("ancestor")), spawns: 1 },
    { name: "two sessions in one non-git cwd do not block each other", build: () => ((plain) => ({ exitedCwd: plain, occupantCwd: plain }))(newFixtureDir("nogit")), spawns: 1 },
  ];
  for (const row of rows) {
    test(`shared-worktree rule: ${row.name}`, async () => {
      const layout = row.build();
      const occupantId = await seedLiveSession(layout.occupantCwd);
      const sessionId = await seedSession({ cwd: layout.exitedCwd });
      const itemId = await seedItem(sessionId, "resume_pending");
      const harness = buildHarness([sessionId, occupantId]);

      await runPasses(harness, 2);

      assert.equal(harness.fake.calls.length, row.spawns, row.name);
      if (row.spawns === 0) assert.deepEqual(await getSkipReason(itemId), { kind: "shared_worktree", markedOccupants: [], hasUnmarkedOccupant: true }, row.name);
    });
  }

  test("a cwd registered as /tmp/x and a row stored as /private/tmp/x inside one .git fixture share a worktree", async () => {
    const repo = makeRepo(path.join(tmpRoot, "repo"));
    const live = await spawnLiveProcess();
    const liveId = randomUUID();
    trackedSessionIds.push(liveId);
    await registerSession({ sessionId: liveId, pid: live.pid, cwd: repo }, dir.home);
    const sessionId = await seedSession({ cwd: realpathSync(repo) });
    await seedItem(sessionId, "resume_pending");
    const harness = buildHarness([sessionId, liveId]);

    await runPasses(harness, 2);

    assert.ok(repo.startsWith("/tmp/"));
    assert.equal(harness.fake.calls.length, 0);
  });

  test("a replaced row always shares its worktree with the row that replaced it and is not resumed", async () => {
    const repo = makeRepo(newFixtureDir("replaced"));
    const identity = await spawnLiveProcess();
    const [oldId, newId] = [randomUUID(), randomUUID()];
    trackedSessionIds.push(oldId, newId);
    await registerSession({ sessionId: oldId, pid: identity.pid, cwd: repo }, dir.home);
    const itemId = await seedItem(oldId, "resume_pending");
    await registerSession({ sessionId: newId, pid: identity.pid, cwd: repo }, dir.home);
    await getPrisma().queueItem.update({ where: { id: itemId }, data: { status: "resume_pending" } });
    const harness = buildHarness([oldId, newId]);

    await runPasses(harness, 2);

    assert.equal((await getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId: oldId } })).exitReason, "replaced");
    assert.equal(harness.fake.calls.length, 0);
    assert.equal((await getSkipReason(itemId))?.kind, "shared_worktree");
  });

  const refreshRows: Array<{ name: string; occupant: "live-empty-root" | "marked-empty-root" | "in-flight-empty-root"; exitedRootStored: boolean; expected: { markedOccupants: number; hasUnmarkedOccupant: boolean } }> = [
    { name: "an exited row with an empty stored root re-derives it at claim and sees the live row", occupant: "live-empty-root", exitedRootStored: false, expected: { markedOccupants: 0, hasUnmarkedOccupant: true } },
    { name: "a live row registered before the .git appeared blocks after one pass", occupant: "live-empty-root", exitedRootStored: true, expected: { markedOccupants: 0, hasUnmarkedOccupant: true } },
    { name: "a marked exited row registered before the .git appeared blocks and is named", occupant: "marked-empty-root", exitedRootStored: true, expected: { markedOccupants: 1, hasUnmarkedOccupant: false } },
    { name: "an exited row with a resume in flight registered before the .git appeared blocks", occupant: "in-flight-empty-root", exitedRootStored: true, expected: { markedOccupants: 0, hasUnmarkedOccupant: true } },
  ];
  for (const row of refreshRows) {
    test(`root refresh: ${row.name}`, async () => {
      const repo = newFixtureDir("late-git");
      const occupantId =
        row.occupant === "live-empty-root" ? await seedLiveSession(repo) : await seedSession({ cwd: repo, isMarked: row.occupant === "marked-empty-root" });
      if (row.occupant === "in-flight-empty-root") await seedResumeInFlight(occupantId);
      makeRepo(repo);
      const sessionId = await seedSession({ cwd: repo, worktreeRoot: row.exitedRootStored ? repo : null });
      const itemId = await seedItem(sessionId, "resume_pending");
      const harness = buildHarness([sessionId, occupantId]);

      await runPasses(harness, 1);

      const skip = await getSkipReason(itemId);
      assert.equal(harness.fake.calls.length, 0, row.name);
      assert.ok(skip?.kind === "shared_worktree", row.name);
      assert.deepEqual({ markedOccupants: skip.markedOccupants.length, hasUnmarkedOccupant: skip.hasUnmarkedOccupant }, row.expected, row.name);
    });
  }

  test("two exited sessions in one worktree answered together get one spawn in one pass, and the other names the resumed one as its marked occupant", async () => {
    const repo = makeRepo(newFixtureDir("pair"));
    const ids = [await seedSession({ cwd: repo }), await seedSession({ cwd: repo })];
    const itemIds = [await seedItem(ids[0] ?? "", "resume_pending"), await seedItem(ids[1] ?? "", "resume_pending")];
    const harness = buildHarness(ids);

    await runPasses(harness, 1);

    const skips = await Promise.all(itemIds.map(getSkipReason));
    assert.equal(harness.fake.calls.length, 1);
    const waiting = skips.find((skip) => skip?.kind === "shared_worktree");
    assert.ok(waiting?.kind === "shared_worktree");
    assert.equal(waiting.markedOccupants.length, 1);
  });

  test("two concurrent passes over two exited sessions in one worktree spawn once: the second claim waits on the worktree lock and then reads the first one's marker", async () => {
    const repo = makeRepo(newFixtureDir("locked-pair"));
    const [firstId, secondId] = [await seedSession({ cwd: repo }), await seedSession({ cwd: repo })];
    await seedItem(firstId, "resume_pending");
    const secondItemId = await seedItem(secondId, "resume_pending");
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const shared = buildFakeLauncher();
    const first = buildHarness([firstId], shared, { hooks: { afterClaimRead: () => held } });
    const second = buildHarness([secondId], shared);

    const firstPass = runSweepPass(first.deps);
    await waitForWorktreeLock(repo, true);
    const secondPass = runSweepPass(second.deps);
    await waitForWorktreeLock(repo, false);
    release();
    await Promise.all([firstPass, secondPass]);
    await Promise.all([...first.captures, ...second.captures]);

    assert.equal(shared.calls.length, 1);
    // the second claim itself saw the marker: no row of its own, so no attempt spent on a pre-spawn abort
    assert.equal((await getResumeRows(secondItemId)).length, 0);
  });
});

// Only this worktree's advisory lock: a bigint key shows in pg_locks as classid = high 32 bits, objid = low 32 bits, objsubid 1
async function waitForWorktreeLock(repo: string, isGranted: boolean): Promise<void> {
  const root = await findWorktreeRoot(repo);
  if (root === null) throw new Error(`no worktree root for ${repo}`);
  const lockKey = buildWorktreeLockKey(root);
  await waitFor(async () => {
    const rows = await getPrisma().$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_locks l CROSS JOIN (SELECT hashtextextended(${lockKey}, 0) AS k) h
      WHERE l.locktype = 'advisory' AND l.granted = ${isGranted} AND l.objsubid = 1
        AND l.classid::bigint = (h.k >> 32) & 4294967295 AND l.objid::bigint = h.k & 4294967295`;
    return (rows[0]?.n ?? 0n) > 0n;
  });
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached within 2 s");
}

describe("session marker", () => {
  async function seedAckedResume(): Promise<{ sessionId: string; secondItemId: bigint; harness: ResumeHarness; identity: { pid: number; startTime: string } }> {
    const identity = await spawnLiveProcess();
    const sessionId = await seedSession({ cwd: newFixtureDir("marker"), identity: { pid: 999_998, startTime: "Mon Jan  1 00:00:00 2026" } });
    const firstItemId = await seedItem(sessionId, "resume_pending");
    const harness = buildHarness([sessionId]);
    await runPasses(harness, 1);
    const [row] = await getResumeRows(firstItemId);
    await ackItem(Number(firstItemId), sessionId, row?.msgId ?? "");
    const secondItemId = await seedItem(sessionId, "resume_pending");
    return { sessionId, secondItemId, harness, identity };
  }

  test("an ack after a resume with no register leaves the marker set: a second item is not resumed and shows the marker reason", async () => {
    const { secondItemId, harness } = await seedAckedResume();

    await runPasses(harness, 3);

    assert.equal(harness.fake.calls.length, 1);
    assert.deepEqual(await getSkipReason(secondItemId), { kind: "marker" });
  });

  test("a register after the ack clears the marker and the second item waits answered for the session's pull", async () => {
    const { sessionId, secondItemId, harness, identity } = await seedAckedResume();

    await registerSession({ sessionId, pid: identity.pid, cwd: (await getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId } })).cwd }, dir.home);
    await runPasses(harness, 1);

    assert.equal(await isMarked(sessionId), false);
    assert.equal(harness.fake.calls.length, 1);
    assert.equal(await getStatus(secondItemId), "answered");
    assert.equal(await getPrisma().queueDelivery.count({ where: { itemId: secondItemId } }), 0);
  });

  test("a deregister carrying another pid clears the marker and the next sweep resumes the second item once", async () => {
    const { sessionId, secondItemId, harness, identity } = await seedAckedResume();

    await deregisterSession({ sessionId, pid: identity.pid });
    await runPasses(harness, 3);

    assert.equal(harness.fake.calls.length, 2);
    assert.equal((await getResumeRows(secondItemId)).length, 1);
  });

  test("a deregister carrying the stored pid between the claim commit and the spawn leaves the marker set, and a second item is not resumed", async () => {
    const sessionId = await seedSession({ cwd: newFixtureDir("stale-end"), identity: { pid: 999_997, startTime: "Mon Jan  1 00:00:00 2026" } });
    await seedItem(sessionId, "resume_pending");
    const harness = buildHarness([sessionId], undefined, { hooks: { beforeReread: () => deregisterSession({ sessionId, pid: 999_997 }) } });
    await runPasses(harness, 1);
    const secondItemId = await seedItem(sessionId, "resume_pending");

    await runPasses(harness, 2);

    assert.equal(await isMarked(sessionId), true);
    assert.equal(harness.fake.calls.length, 1);
    assert.equal((await getResumeRows(secondItemId)).length, 0);
  });

  test("a hook register clears the marker while the resume is in flight; once the row exits again a second item is not resumed and carries no skip text", async () => {
    const identity = await spawnLiveProcess();
    const cwd = newFixtureDir("in-flight");
    const sessionId = await seedSession({ cwd, identity: { pid: 999_996, startTime: "Mon Jan  1 00:00:00 2026" } });
    const firstItemId = await seedItem(sessionId, "resume_pending");
    const harness = buildHarness([sessionId]);
    await runPasses(harness, 1);

    await registerSession({ sessionId, pid: identity.pid, cwd }, dir.home);
    await setExited(sessionId);
    const secondItemId = await seedItem(sessionId, "resume_pending");
    await runPasses(harness, 2);

    assert.equal(await isMarked(sessionId), false);
    assert.equal(await getStatus(firstItemId), "delivering");
    assert.equal(harness.fake.calls.length, 1);
    assert.deepEqual(await getSkipReason(secondItemId), { kind: "in_flight" });
  });
});

describe("resume payload and argv", () => {
  test("the payload carries every envelope, the not-user-approval clause and the register-then-wait instruction with the CLI literal", () => {
    const items = [
      { id: 41, kind: "decision" as const, msgId: randomUUID() },
      { id: 42, kind: "report" as const, msgId: randomUUID() },
    ];

    const payload = buildResumePayload(items, CLI_PATH);

    for (const item of items) assert.ok(payload.includes(`${CLI_PATH} ack ${item.id} ${item.msgId}`), `envelope of item ${item.id}`);
    assert.match(payload, /not user approval/i);
    assert.match(payload, /no permission or consent for any high-impact action/i);
    assert.ok(payload.includes(`${CLI_PATH} register`), "register-after-ack names the CLI literal");
    assert.ok(payload.indexOf(`${CLI_PATH} register`) > payload.lastIndexOf(" ack "), "the register step comes after the ack steps");
    assert.ok(payload.indexOf(`${CLI_PATH} wait`) > payload.indexOf(`${CLI_PATH} register`), "the wait step comes after the register step");
  });

  test("an owner message goes out under its own header and subject, and the preamble names messages beside answers", () => {
    const message = { id: 43, kind: "message" as const, msgId: randomUUID() };

    const payload = buildResumePayload([message], CLI_PATH);

    assert.ok(payload.includes(`[ATRIUM-MESSAGE v1] item ${message.id} · msg ${message.msgId}`), "message header with ids");
    assert.match(payload, /the owner sent you a message/i);
    assert.match(payload, /queue answers or messages/i);
    assert.ok(payload.includes(`${CLI_PATH} ack ${message.id} ${message.msgId}`), "same fetch → ack steps as an answer");
  });

  const badIds = ["--all", "-h", "not-a-uuid", `${randomUUID()} --bg`];
  test("a non-UUID session id is rejected before any argv is built", () => {
    for (const badId of badIds) assert.throws(() => buildResumeArgs(badId, "payload"), /session id/, badId);
    const goodId = randomUUID();
    assert.deepEqual(buildResumeArgs(goodId, "payload"), ["--resume", goodId, "--bg", "payload"]);
  });
});

describe("captured bg id", () => {
  const rows: Array<{ name: string; script: string; expected: string | null }> = [
    { name: "a valid id on its first line", script: "printf 'bg-7f3a9\\n'", expected: "bg-7f3a9" },
    { name: "a valid id with no newline, then the launcher exits", script: "printf 'abc123'", expected: "abc123" },
    { name: "output after the first line never reaches the field", script: "printf 'first1\\nsecond2\\n'", expected: "first1" },
    { name: "no output", script: "exit 0", expected: null },
    { name: "an oversized line", script: `printf '${"a".repeat(300)}\\n'`, expected: null },
    { name: "a token outside the accepted shape", script: "printf 'abc_def\\n'", expected: null },
    { name: "a leading-hyphen token -h", script: "printf -- '-h\\n'", expected: null },
    { name: "a leading-hyphen token --all", script: "printf -- '--all\\n'", expected: null },
  ];
  for (const row of rows) {
    test(`bg id on every resume row of the spawn: ${row.name}`, async () => {
      const sessionId = await seedSession({ cwd: newFixtureDir("capture") });
      const itemIds = [await seedItem(sessionId, "resume_pending"), await seedItem(sessionId, "resume_pending")];
      const harness = buildHarness([sessionId], buildFakeLauncher(row.script));

      await runPasses(harness, 1);

      for (const itemId of itemIds) assert.equal((await getResumeRows(itemId))[0]?.bgId ?? null, row.expected, row.name);
      assert.deepEqual(readdirSync(harness.captureDir), [], `${row.name}: capture file unlinked and its directory removed`);
    });
  }

  test("the launcher's stdout is a 0600 regular file inside a fresh 0700 per-spawn directory, never a pipe", async () => {
    const sessionId = await seedSession({ cwd: newFixtureDir("stdout") });
    await seedItem(sessionId, "resume_pending");
    const seen: Array<{ isFile: boolean; mode: number; dirMode: number; captureMode: number; sameInode: boolean }> = [];
    let captureDir = "";
    const onLaunch = (request: LaunchRequest): void => {
      const fdStat = fstatSync(request.stdoutFd);
      const [spawnDir] = readdirSync(captureDir);
      const spawnPath = path.join(captureDir, spawnDir ?? "");
      const [fileName] = readdirSync(spawnPath);
      seen.push({
        isFile: fdStat.isFile(),
        mode: fdStat.mode & 0o777,
        dirMode: statSync(spawnPath).mode & 0o777,
        captureMode: statSync(captureDir).mode & 0o777,
        sameInode: statSync(path.join(spawnPath, fileName ?? "")).ino === fdStat.ino,
      });
    };
    const harness = buildHarness([sessionId], buildFakeLauncher("exit 0", { onLaunch }));
    captureDir = harness.captureDir;

    await runPasses(harness, 1);

    assert.deepEqual(seen, [{ isFile: true, mode: 0o600, dirMode: 0o700, captureMode: 0o700, sameInode: true }]);
  });

  const boundRows: Array<{ name: string; script: string; expected: string | null }> = [
    { name: "a launcher still writing past its first line keeps the first-line id", script: "printf 'live42\\n'; i=0; while [ $i -lt 40 ]; do printf x; sleep 0.05; i=$((i+1)); done", expected: "live42" },
    { name: "a launcher alive with no output leaves it empty", script: "sleep 5", expected: null },
    { name: "a partial token then a stall leaves it empty", script: "printf 'abc1'; sleep 5", expected: null },
  ];
  for (const row of boundRows) {
    test(`the sweep pass never waits on the read, and the time bound on the test clock ends it: ${row.name}`, async () => {
      const sessionId = await seedSession({ cwd: newFixtureDir("bound") });
      const itemId = await seedItem(sessionId, "resume_pending");
      const harness = buildHarness([sessionId], buildFakeLauncher(row.script));

      await runSweepPass(harness.deps);
      const exitsAfterPass = harness.fake.exits.count;
      // an id ends the read on its own; an id-less read stays open until the bound passes on the test clock
      const waitMs = row.expected === null ? 300 : 5_000;
      const isReadDoneBeforeBound = await Promise.race([Promise.all(harness.captures).then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), waitMs))]);
      harness.clock.ms += CAPTURE_TIME_BOUND_MS + 1;
      await Promise.all(harness.captures);

      assert.equal(exitsAfterPass, 0, `${row.name}: the pass returned while the launcher still ran`);
      assert.equal(isReadDoneBeforeBound, row.expected !== null, row.name);
      assert.equal((await getResumeRows(itemId))[0]?.bgId ?? null, row.expected, row.name);
    });
  }

  test("a launcher still writing after the capture reader stops (a monitor restart) keeps running and its writes succeed", async () => {
    const sessionId = await seedSession({ cwd: newFixtureDir("restart") });
    await seedItem(sessionId, "resume_pending");
    const doneFile = path.join(newFixtureDir("restart-done"), "done");
    const script = `set -e; printf 'keep9\\n'; i=0; while [ $i -lt 10 ]; do printf 'more\\n'; sleep 0.05; i=$((i+1)); done; printf ok > '${doneFile}'`;
    const harness = buildHarness([sessionId], buildFakeLauncher(script));

    await runSweepPass(harness.deps);
    harness.abort.abort();
    await Promise.all(harness.captures);
    await waitFor(async () => existsSync(doneFile));

    assert.equal(existsSync(doneFile), true);
  });

  test("the start sweep removes a per-spawn directory a restart left behind and keeps one holding anything else", async () => {
    const harness = buildHarness([]);
    const leftover = path.join(harness.captureDir, "spawn-left");
    const foreign = path.join(harness.captureDir, "spawn-foreign");
    for (const spawnDir of [leftover, foreign]) {
      mkdirSync(spawnDir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(spawnDir, "stdout"), "old1\n", { mode: 0o600 });
    }
    writeFileSync(path.join(foreign, "notes.txt"), "keep");

    const scheduler = startQueueScheduler(harness.deps, 60 * MINUTE_MS);
    await scheduler.stop();

    assert.deepEqual(readdirSync(harness.captureDir), ["spawn-foreign"]);
  });
});
