// Owner queue sweep: no socket delivery, the stale / exited rule, overdue and exited-row item moves,
// the token directory drain, the unused image clean-up and the `claude` child env allowlist.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/queue.sweep.test.ts
// Every sweep pass is scoped to this file's session ids → rows other test files seed are never probed or moved.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import type { QueueDelivery, QueueDeliveryRoute, QueueItemStatus, QueueSessionState } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { buildClaudeChildEnv } from "../src/server/queue/child-env.js";
import { UNUSED_IMAGE_TTL_MS, createImage } from "../src/server/queue/images.js";
import { getProcessStartTime } from "../src/server/queue/process-start-time.js";
import { createMessages } from "../src/server/queue/owner-sessions.js";
import { registerSession } from "../src/server/queue/registry.js";
import { startQueueScheduler } from "../src/server/queue/scheduler.js";
import { type SweepDeps, deleteTokenFiles, deleteUnusedImages, runSweepPass } from "../src/server/queue/sweep.js";
import { deleteDirectory } from "./lib/remove-dir.js";
import { lockQueueRows, unlockQueueRows } from "./lib/queue-rows-lock.js";

const CLI_PATH = "/opt/atrium-test/scripts/atrium-queue.sh";
const MINUTE_MS = 60_000;
const OLD_START_TIME = "Mon Jan  1 00:00:00 2026";

const fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "queue-sweep-")));
const dir = { tokens: path.join(fixtureRoot, "tokens"), home: path.join(fixtureRoot, "home"), cwd: path.join(fixtureRoot, "cwd"), images: path.join(fixtureRoot, "images") };
const trackedSessionIds: string[] = [];
const children: ChildProcess[] = [];
let livePid: { pid: number; startTime: string };

before(async () => {
  await lockQueueRows();
  mkdirSync(dir.tokens, { recursive: true, mode: 0o700 });
  mkdirSync(dir.home, { recursive: true });
  mkdirSync(dir.cwd, { recursive: true });
  livePid = await spawnLiveProcess();
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
});

async function spawnLiveProcess(): Promise<{ pid: number; startTime: string }> {
  const child = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  children.push(child);
  const pid = child.pid;
  if (pid === undefined) throw new Error("sleep child spawn failed");
  const startTime = await getProcessStartTime(pid);
  if (startTime === null) throw new Error(`start time unreadable for pid ${pid}`);
  return { pid, startTime };
}

async function getGonePid(): Promise<number> {
  const child = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  if (child.pid === undefined) throw new Error("sleep child spawn failed");
  return child.pid;
}

function buildDeps(sessionIds: string[], overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    readStartTime: getProcessStartTime,
    now: () => new Date(),
    cliPath: CLI_PATH,
    tokenDir: dir.tokens,
    imageDir: dir.images,
    scope: { sessionIds },
    ...overrides,
  };
}

interface SessionSeed {
  state?: QueueSessionState;
  pid?: number;
  startTime?: string;
  socketPath?: string;
}

async function seedSession(seed: SessionSeed = {}): Promise<string> {
  const sessionId = randomUUID();
  trackedSessionIds.push(sessionId);
  const pid = seed.pid ?? livePid.pid;
  const state = seed.state ?? "live";
  await getPrisma().queueSession.create({
    data: {
      sessionId,
      isConfigDirSet: false,
      profileLabel: "default",
      cwd: dir.cwd,
      pid,
      processStartTime: seed.startTime ?? livePid.startTime,
      socketPath: seed.socketPath ?? null,
      state,
      exitReason: state === "exited" ? "ended" : null,
      lastSeenAt: new Date(),
    },
  });
  return sessionId;
}

async function seedItem(sessionId: string, status: QueueItemStatus, nextAttempt = 1): Promise<bigint> {
  const item = await getPrisma().queueItem.create({
    data: {
      kind: "report",
      sessionId,
      title: "Nightly sweep report",
      body: "Sweep finished with 3 stale branches.",
      isFreeTextAllowed: true,
      status,
      answerText: "Delete the stale branches.",
      nextAttempt,
      answeredAt: new Date(),
    },
  });
  return item.id;
}

async function seedDelivery(itemId: bigint, route: QueueDeliveryRoute, deadlineOffsetMs: number): Promise<void> {
  const deadline = new Date(Date.now() + deadlineOffsetMs);
  await getPrisma().queueDelivery.create({
    data: { msgId: randomUUID(), itemId, route, attempt: 1, result: "sent", sentAt: new Date(deadline.getTime() - 10 * MINUTE_MS), ackDeadlineAt: deadline },
  });
}

async function getStatus(itemId: bigint): Promise<QueueItemStatus> {
  return (await getPrisma().queueItem.findUniqueOrThrow({ where: { id: itemId } })).status;
}

async function getSession(sessionId: string): Promise<{ state: string; exitReason: string | null }> {
  return getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId }, select: { state: true, exitReason: true } });
}

function getDeliveries(itemId: bigint): Promise<QueueDelivery[]> {
  return getPrisma().queueDelivery.findMany({ where: { itemId } });
}

describe("no socket delivery", () => {
  test("an answered item and an owner message on a live row with a socket path stay answered for the session's pull, with no Delivery row", async () => {
    const sessionId = await seedSession({ socketPath: `/private/tmp/cc-socks/${livePid.pid}.sock` });
    const itemId = await seedItem(sessionId, "answered");
    const { items: [message] } = await createMessages({ sessionIds: [sessionId], text: "Rebase onto main before the review.", attachmentIds: [] }, "origin");
    assert.ok(message !== undefined);

    await runSweepPass(buildDeps([sessionId]));

    const ids = [itemId, BigInt(message.id)];
    assert.deepEqual(await Promise.all(ids.map(getStatus)), ["answered", "answered"]);
    assert.deepEqual((await Promise.all(ids.map(getDeliveries))).flat(), []);
  });
});

describe("stale / exited rule", () => {
  test("the same pid read twice gives the same start time under any parent TZ", async () => {
    const savedTz = process.env.TZ;
    try {
      process.env.TZ = "Asia/Seoul";
      const first = await getProcessStartTime(livePid.pid);
      process.env.TZ = "America/Los_Angeles";
      const second = await getProcessStartTime(livePid.pid);
      assert.ok(first !== null && first !== "");
      assert.equal(second, first);
      assert.equal(first, livePid.startTime);
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });

  const rows: Array<{ name: string; state: QueueSessionState; getIdentity: () => Promise<{ pid: number; startTime: string }>; expected: { state: string; exitReason: string | null } }> = [
    { name: "live row whose process still runs stays live", state: "live", getIdentity: spawnLiveProcess, expected: { state: "live", exitReason: null } },
    { name: "stale row whose process still runs returns to live", state: "stale", getIdentity: spawnLiveProcess, expected: { state: "live", exitReason: null } },
    { name: "stale row whose start time changed ends dead", state: "stale", getIdentity: async () => ({ pid: (await spawnLiveProcess()).pid, startTime: OLD_START_TIME }), expected: { state: "exited", exitReason: "dead" } },
    { name: "live row whose pid is gone ends dead", state: "live", getIdentity: async () => ({ pid: await getGonePid(), startTime: OLD_START_TIME }), expected: { state: "exited", exitReason: "dead" } },
    { name: "live row whose start time changed ends dead", state: "live", getIdentity: async () => ({ pid: (await spawnLiveProcess()).pid, startTime: OLD_START_TIME }), expected: { state: "exited", exitReason: "dead" } },
  ];
  for (const row of rows) {
    test(`the process start time alone decides the row state: ${row.name}`, async () => {
      const identity = await row.getIdentity();
      const sessionId = await seedSession({ ...identity, state: row.state });

      await runSweepPass(buildDeps([sessionId]));

      assert.deepEqual(await getSession(sessionId), row.expected, row.name);
    });
  }

  test("an answered item whose row ends in the pass goes to resume-pending with no Delivery row", async () => {
    const sessionId = await seedSession({ pid: await getGonePid(), startTime: OLD_START_TIME });
    const itemId = await seedItem(sessionId, "answered");

    await runSweepPass(buildDeps([sessionId]));

    assert.equal(await getStatus(itemId), "resume_pending");
    assert.equal((await getDeliveries(itemId)).length, 0);
  });

  test("a resume-pending item returns to answered when its row registers live and stays answered through the next sweep", async () => {
    const identity = await spawnLiveProcess();
    const sessionId = await seedSession({ ...identity, state: "exited" });
    const itemId = await seedItem(sessionId, "resume_pending");

    await registerSession({ sessionId, pid: identity.pid, cwd: dir.cwd }, dir.home);
    await runSweepPass(buildDeps([sessionId]));

    assert.equal(await getStatus(itemId), "answered");
    assert.equal((await getDeliveries(itemId)).length, 0);
  });
});

describe("sweep moves of delivering and deviating items", () => {
  const rows: Array<{ name: string; state: QueueSessionState; status: QueueItemStatus; route?: QueueDeliveryRoute; deadlineOffsetMs?: number; expected: QueueItemStatus }> = [
    { name: "pull delivery past its deadline on a live row → unacked", state: "live", status: "delivering", route: "pull", deadlineOffsetMs: -MINUTE_MS, expected: "unacked" },
    { name: "socket delivery before its deadline on a live row stays", state: "live", status: "delivering", route: "socket", deadlineOffsetMs: MINUTE_MS, expected: "delivering" },
    { name: "socket delivery past its deadline on a stale row → unacked", state: "stale", status: "delivering", route: "socket", deadlineOffsetMs: -MINUTE_MS, expected: "unacked" },
    { name: "held past its latest delivery's deadline on a live row → unacked", state: "live", status: "held", route: "socket", deadlineOffsetMs: -MINUTE_MS, expected: "unacked" },
    { name: "held past its latest delivery's deadline on a stale row → unacked", state: "stale", status: "held", route: "socket", deadlineOffsetMs: -MINUTE_MS, expected: "unacked" },
    { name: "held before its latest delivery's deadline on a live row stays", state: "live", status: "held", route: "socket", deadlineOffsetMs: MINUTE_MS, expected: "held" },
    { name: "socket delivery past its deadline on an exited row → resume-pending", state: "exited", status: "delivering", route: "socket", deadlineOffsetMs: -MINUTE_MS, expected: "resume_pending" },
    { name: "socket delivery before its deadline on an exited row → resume-pending", state: "exited", status: "delivering", route: "socket", deadlineOffsetMs: MINUTE_MS, expected: "resume_pending" },
    { name: "pull delivery before its deadline on an exited row → resume-pending", state: "exited", status: "delivering", route: "pull", deadlineOffsetMs: MINUTE_MS, expected: "resume_pending" },
    { name: "resume delivery before its deadline on an exited row stays delivering", state: "exited", status: "delivering", route: "resume", deadlineOffsetMs: MINUTE_MS, expected: "delivering" },
    { name: "resume delivery past its deadline on an exited row → resume-pending", state: "exited", status: "delivering", route: "resume", deadlineOffsetMs: -MINUTE_MS, expected: "resume_pending" },
    { name: "unacked on an exited row → resume-pending", state: "exited", status: "unacked", expected: "resume_pending" },
    { name: "held on an exited row → resume-pending", state: "exited", status: "held", expected: "resume_pending" },
    { name: "expired on an exited row → resume-pending", state: "exited", status: "expired", expected: "resume_pending" },
    { name: "unacked on a live row stays", state: "live", status: "unacked", expected: "unacked" },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const sessionId = await seedSession({ state: row.state });
      const itemId = await seedItem(sessionId, row.status);
      if (row.route !== undefined) await seedDelivery(itemId, row.route, row.deadlineOffsetMs ?? 0);

      await runSweepPass(buildDeps([sessionId]));

      assert.equal(await getStatus(itemId), row.expected, row.name);
    });
  }
});

describe("scheduler start sweep", () => {
  test("a scheduler started after a restart moves an overdue delivering item to unacked in its start pass", async () => {
    const sessionId = await seedSession();
    const itemId = await seedItem(sessionId, "delivering");
    await seedDelivery(itemId, "pull", -MINUTE_MS);

    const scheduler = startQueueScheduler(buildDeps([sessionId]), 60 * MINUTE_MS);
    await scheduler.stop();

    assert.equal(await getStatus(itemId), "unacked");
  });
});

describe("token directory drain", () => {
  test("every session token file is removed whatever its session's state or age; a non-session entry stays", async () => {
    const liveId = await seedSession();
    const exitedId = await seedSession({ state: "exited" });
    const files = { live: liveId, exited: exitedId, unknownOld: randomUUID(), unknownFresh: randomUUID(), notUuid: "notes.txt" };
    const tokenDir = path.join(fixtureRoot, "drain-tokens");
    mkdirSync(tokenDir, { mode: 0o700 });
    const hourAgo = new Date(Date.now() - 60 * MINUTE_MS);
    for (const [key, name] of Object.entries(files)) {
      writeFileSync(path.join(tokenDir, name), randomUUID(), { mode: 0o600 });
      if (key !== "unknownFresh") utimesSync(path.join(tokenDir, name), hourAgo, hourAgo);
    }

    await deleteTokenFiles(buildDeps([liveId, exitedId, files.unknownOld, files.unknownFresh], { tokenDir }));

    assert.deepEqual(readdirSync(tokenDir), [files.notUuid]);
  });
});

describe("unused image clean-up", () => {
  // a real 3 × 2 PNG
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==", "base64");

  test("an upload no send claimed within the window is deleted with its file; a fresh, a claimed or another folder's upload stays", async (t) => {
    const imageDir = path.join(fixtureRoot, "clean-images");
    const otherDir = path.join(fixtureRoot, "other-images");
    const now = new Date();
    const pastWindow = new Date(now.getTime() - UNUSED_IMAGE_TTL_MS - MINUTE_MS);
    const images = {
      unusedOld: await createImage(imageDir, png, "old.png"),
      unusedFresh: await createImage(imageDir, png, "fresh.png"),
      usedOld: await createImage(imageDir, png, "used.png"),
      otherFolderOld: await createImage(otherDir, png, "elsewhere.png"),
    };
    const ids = Object.values(images).map((image) => image.id);
    t.after(() => getPrisma().queueImage.deleteMany({ where: { id: { in: ids } } }));
    await getPrisma().queueImage.updateMany({ where: { id: { in: [images.unusedOld.id, images.otherFolderOld.id] } }, data: { createdAt: pastWindow } });
    await getPrisma().queueImage.update({ where: { id: images.usedOld.id }, data: { createdAt: pastWindow, usedAt: pastWindow } });
    writeFileSync(path.join(imageDir, "notes.txt"), "kept");

    await deleteUnusedImages(buildDeps([], { imageDir, now: () => now }));

    const kept = await getPrisma().queueImage.findMany({ where: { id: { in: ids } }, select: { id: true } });
    assert.deepEqual(new Set(kept.map((row) => row.id)), new Set([images.unusedFresh.id, images.usedOld.id, images.otherFolderOld.id]));
    assert.deepEqual(readdirSync(imageDir).sort(), [`${images.unusedFresh.id}.png`, `${images.usedOld.id}.png`, "notes.txt"].sort());
    assert.deepEqual(readdirSync(otherDir), [`${images.otherFolderOld.id}.png`]);
  });
});

describe("claude child env", () => {
  const source = { HOME: "/Users/owner", PATH: "/opt/homebrew/bin:/usr/bin", USER: "owner", LANG: "en_US.UTF-8", TMPDIR: "/var/tmp/", DATABASE_URL: "fixture", CLAUDE_CONFIG_DIR: "/Users/owner/.claude-other", GA_ROOT: "/x" };
  const base = { HOME: source.HOME, PATH: source.PATH, USER: source.USER, LANG: source.LANG, TMPDIR: source.TMPDIR };
  const rows = [
    { name: "default profile: no CLAUDE_CONFIG_DIR even when the monitor env has one", configDir: null, expected: base },
    { name: "recorded config dir: CLAUDE_CONFIG_DIR is the row's value", configDir: "/Users/owner/.claude-work", expected: { ...base, CLAUDE_CONFIG_DIR: "/Users/owner/.claude-work" } },
  ];
  for (const row of rows) {
    test(`the child env is exactly the allowlist: ${row.name}`, () => {
      assert.deepEqual(buildClaudeChildEnv(row.configDir, source), row.expected);
    });
  }
});
