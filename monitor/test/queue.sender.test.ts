// Owner queue sender and sweep: socket frames, the stale / exited rule, overdue and exited-row item moves,
// orphan token cleanup and the `claude` child env allowlist.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/queue.sender.test.ts
// Every sweep pass is scoped to this file's session ids → rows other test files seed are never probed or moved.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { type Server, Socket, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import type { QueueDelivery, QueueDeliveryRoute, QueueItemStatus, QueueSessionState } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { buildClaudeChildEnv } from "../src/server/queue/child-env.js";
import { getProcessStartTime } from "../src/server/queue/process-start-time.js";
import { registerSession } from "../src/server/queue/registry.js";
import { startQueueScheduler } from "../src/server/queue/scheduler.js";
import { type SweepDeps, removeOrphanTokenFiles, runSweepPass } from "../src/server/queue/sweep.js";
import { deleteDirectory } from "./lib/remove-dir.js";

const CLI_PATH = "/opt/atrium-test/scripts/atrium-queue.sh";
const authValue = randomUUID();
const MINUTE_MS = 60_000;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "queue-sender-")));
const dir = { tokens: path.join(fixtureRoot, "tokens"), home: path.join(fixtureRoot, "home"), cwd: path.join(fixtureRoot, "cwd") };
const trackedSessionIds: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];
// confined cc-socks path → fixture socket path; an unmapped path connects to a missing file (ENOENT)
const socketMap = new Map<string, string>();
const received = new Map<string, string[]>();
let livePid: { pid: number; startTime: string };

before(async () => {
  mkdirSync(dir.tokens, { recursive: true, mode: 0o700 });
  mkdirSync(dir.home, { recursive: true });
  mkdirSync(dir.cwd, { recursive: true });
  livePid = await spawnLiveProcess();
});

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  const prisma = getPrisma();
  await prisma.queueDelivery.deleteMany({ where: { item: { sessionId: { in: trackedSessionIds } } } });
  await prisma.queueItem.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await prisma.queueSession.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
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

function confinedSocketPath(pid: number): string {
  return `/private/tmp/cc-socks/${pid}.sock`;
}

/** Fake session socket: records every line each connection writes, keyed by the confined path. */
async function serveSocket(confinedPath: string): Promise<void> {
  const fixturePath = path.join(fixtureRoot, `s${socketMap.size}.sock`);
  const lines: string[] = [];
  received.set(confinedPath, lines);
  const server = createServer((socket: Socket) => {
    let buffer = "";
    socket.on("data", (chunk) => (buffer += chunk.toString("utf8")));
    socket.on("end", () => lines.push(...buffer.split("\n").filter((line) => line !== "")));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(fixturePath, resolve));
  socketMap.set(confinedPath, fixturePath);
}

function buildDeps(sessionIds: string[], overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    connector: (socketPath) => createConnection({ path: socketMap.get(socketPath) ?? path.join(fixtureRoot, "missing.sock") }),
    readStartTime: getProcessStartTime,
    isSocketDeliveryOn: () => true,
    now: () => new Date(),
    cliPath: CLI_PATH,
    tokenDir: dir.tokens,
    scope: { sessionIds },
    ...overrides,
  };
}

interface SessionSeed {
  state?: QueueSessionState;
  pid?: number;
  startTime?: string;
  socket?: "served" | "missing" | "none";
}

async function seedSession(seed: SessionSeed = {}): Promise<string> {
  const sessionId = randomUUID();
  trackedSessionIds.push(sessionId);
  const pid = seed.pid ?? livePid.pid;
  const socketPath = seed.socket === "none" ? null : confinedSocketPath(pid);
  if (seed.socket === "served" && socketPath !== null && !socketMap.has(socketPath)) await serveSocket(socketPath);
  const state = seed.state ?? "live";
  await getPrisma().queueSession.create({
    data: {
      sessionId,
      isConfigDirSet: false,
      profileLabel: "default",
      cwd: dir.cwd,
      pid,
      processStartTime: seed.startTime ?? livePid.startTime,
      socketPath,
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

function getUserFrames(pid: number): string[] {
  return (received.get(confinedSocketPath(pid)) ?? []).filter((line) => JSON.parse(line).type === "user");
}

describe("socket delivery of an answered item", () => {
  test("a live row's answered item goes out as an auth line then one user frame naming the session and the Delivery msg id", async () => {
    const sessionId = await seedSession({ socket: "served" });
    writeFileSync(path.join(dir.tokens, sessionId), `${authValue}\n`, { mode: 0o600 });
    const itemId = await seedItem(sessionId, "answered", 2);

    await runSweepPass(buildDeps([sessionId]));

    const lines = received.get(confinedSocketPath(livePid.pid)) ?? [];
    const [delivery] = await getDeliveries(itemId);
    assert.ok(delivery !== undefined, "one Delivery row inserted");
    const authFrame = JSON.parse(lines.at(-2) ?? "null");
    assert.equal(authFrame.type, "auth");
    assert.equal(authFrame.token, authValue);
    const frame = JSON.parse(lines.at(-1) ?? "null");
    assert.equal(frame.type, "user");
    assert.equal(frame.session_id, sessionId);
    assert.match(frame.msg_id, UUID_SHAPE);
    assert.equal(frame.msg_id, delivery.msgId);
    assert.equal(frame.message.role, "user");
    assert.ok(frame.message.content.includes(`${CLI_PATH} get ${itemId}`), "the fetch step names the absolute CLI literal");
    assert.ok(frame.message.content.includes(`${CLI_PATH} ack ${itemId} ${delivery.msgId}`), "the ack step names the msg id");
    assert.ok(!frame.message.content.includes("Delete the stale branches."), "the answer text is fetched, never framed");
    assert.equal(await getStatus(itemId), "delivering");
    assert.deepEqual([delivery.route, delivery.attempt, delivery.result], ["socket", 2, "sent"]);
    assert.ok(delivery.ackDeadlineAt > delivery.sentAt);
  });

  test("two overlapping sweep passes over one answered item send one frame and insert one Delivery row", async () => {
    const identity = await spawnLiveProcess();
    const sessionId = await seedSession({ ...identity, socket: "served" });
    const itemId = await seedItem(sessionId, "answered");

    // both passes read the item as answered and hold an open socket before either claims
    const pendingConnects: Array<() => void> = [];
    const barrierConnector = (socketPath: string): Socket => {
      const socket = new Socket();
      pendingConnects.push(() => socket.connect({ path: socketMap.get(socketPath) ?? "" }));
      if (pendingConnects.length === 2) for (const connect of pendingConnects) connect();
      return socket;
    };
    const deps = buildDeps([sessionId], { connector: barrierConnector });

    await Promise.all([runSweepPass(deps), runSweepPass(deps)]);

    assert.equal(getUserFrames(identity.pid).length, 1);
    assert.equal((await getDeliveries(itemId)).length, 1);
  });

  const offRows = [
    { name: "socket delivery off (degraded)", socket: "served" as const, isOn: false },
    { name: "row with no socket path", socket: "none" as const, isOn: true },
  ];
  for (const row of offRows) {
    test(`a live row's answered item stays answered with no frame and no Delivery row: ${row.name}`, async () => {
      const identity = await spawnLiveProcess();
      const sessionId = await seedSession({ ...identity, socket: row.socket });
      const itemId = await seedItem(sessionId, "answered");

      await runSweepPass(buildDeps([sessionId], { isSocketDeliveryOn: () => row.isOn }));

      assert.equal(await getStatus(itemId), "answered", row.name);
      assert.equal((await getDeliveries(itemId)).length, 0, row.name);
      assert.equal(getUserFrames(identity.pid).length, 0, row.name);
    });
  }
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

  test("a refused probe with a live pid keeps the row stale with no Delivery row, and a later working socket brings it back live", async () => {
    const identity = await spawnLiveProcess();
    const sessionId = await seedSession({ ...identity, socket: "missing" });
    const itemId = await seedItem(sessionId, "answered");

    await runSweepPass(buildDeps([sessionId]));
    const afterRefusal = { session: await getSession(sessionId), status: await getStatus(itemId), deliveries: (await getDeliveries(itemId)).length };
    await serveSocket(confinedSocketPath(identity.pid));
    await runSweepPass(buildDeps([sessionId]));

    assert.deepEqual(afterRefusal, { session: { state: "stale", exitReason: null }, status: "answered", deliveries: 0 });
    assert.equal((await getSession(sessionId)).state, "live");
    assert.equal(await getStatus(itemId), "delivering");
  });

  const deadRows = [
    { name: "pid gone", getIdentity: async () => ({ pid: await getGonePid(), startTime: "Mon Jan  1 00:00:00 2026" }) },
    { name: "start time changed", getIdentity: async () => ({ pid: (await spawnLiveProcess()).pid, startTime: "Mon Jan  1 00:00:00 2026" }) },
  ];
  for (const row of deadRows) {
    test(`a refused probe marks the row exited (dead) and its answered item resume-pending: ${row.name}`, async () => {
      const identity = await row.getIdentity();
      const sessionId = await seedSession({ ...identity, socket: "missing" });
      const itemId = await seedItem(sessionId, "answered");

      await runSweepPass(buildDeps([sessionId]));

      assert.deepEqual(await getSession(sessionId), { state: "exited", exitReason: "dead" }, row.name);
      assert.equal(await getStatus(itemId), "resume_pending", row.name);
      assert.equal((await getDeliveries(itemId)).length, 0, row.name);
    });
  }

  test("an answered item whose row is already exited goes to resume-pending with no Delivery row", async () => {
    const sessionId = await seedSession({ state: "exited", socket: "served" });
    const itemId = await seedItem(sessionId, "answered");

    await runSweepPass(buildDeps([sessionId]));

    assert.equal(await getStatus(itemId), "resume_pending");
    assert.equal((await getDeliveries(itemId)).length, 0);
  });

  test("a resume-pending item returns to answered when its row registers live, and the next sweep sends it over the socket", async () => {
    const identity = await spawnLiveProcess();
    const sessionId = await seedSession({ ...identity, state: "exited", socket: "served" });
    const itemId = await seedItem(sessionId, "resume_pending");

    await registerSession({ sessionId, pid: identity.pid, cwd: dir.cwd, socketPath: confinedSocketPath(identity.pid) }, dir.home);
    const afterRegister = await getStatus(itemId);
    await runSweepPass(buildDeps([sessionId]));

    assert.equal(afterRegister, "answered");
    assert.equal(await getStatus(itemId), "delivering");
    assert.equal((await getDeliveries(itemId))[0]?.route, "socket");
  });
});

describe("sweep moves of delivering and deviating items", () => {
  const rows: Array<{ name: string; state: QueueSessionState; status: QueueItemStatus; route?: QueueDeliveryRoute; deadlineOffsetMs?: number; expected: QueueItemStatus }> = [
    { name: "socket delivery past its deadline on a live row → unacked", state: "live", status: "delivering", route: "socket", deadlineOffsetMs: -MINUTE_MS, expected: "unacked" },
    { name: "socket delivery before its deadline on a live row stays", state: "live", status: "delivering", route: "socket", deadlineOffsetMs: MINUTE_MS, expected: "delivering" },
    { name: "socket delivery past its deadline on a stale row → unacked", state: "stale", status: "delivering", route: "socket", deadlineOffsetMs: -MINUTE_MS, expected: "unacked" },
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
      const sessionId = await seedSession({ state: row.state, socket: row.state === "live" ? "served" : "missing" });
      const itemId = await seedItem(sessionId, row.status);
      if (row.route !== undefined) await seedDelivery(itemId, row.route, row.deadlineOffsetMs ?? 0);

      await runSweepPass(buildDeps([sessionId]));

      assert.equal(await getStatus(itemId), row.expected, row.name);
    });
  }
});

describe("scheduler start sweep", () => {
  test("a scheduler started after a restart moves an overdue delivering item to unacked in its start pass", async () => {
    const sessionId = await seedSession({ socket: "served" });
    const itemId = await seedItem(sessionId, "delivering");
    await seedDelivery(itemId, "socket", -MINUTE_MS);

    const scheduler = startQueueScheduler(buildDeps([sessionId]), 60 * MINUTE_MS);
    await scheduler.stop();

    assert.equal(await getStatus(itemId), "unacked");
  });
});

describe("orphan token files", () => {
  test("only token files of exited or unknown sessions older than the grace period are removed", async () => {
    const liveId = await seedSession({ socket: "missing" });
    const exitedId = await seedSession({ state: "exited", socket: "missing" });
    const files = { live: liveId, exited: exitedId, unknownOld: randomUUID(), unknownFresh: randomUUID(), notUuid: "notes.txt" };
    const tokenDir = path.join(fixtureRoot, "orphan-tokens");
    mkdirSync(tokenDir, { mode: 0o700 });
    const hourAgo = new Date(Date.now() - 60 * MINUTE_MS);
    for (const [key, name] of Object.entries(files)) {
      writeFileSync(path.join(tokenDir, name), authValue, { mode: 0o600 });
      if (key !== "unknownFresh") utimesSync(path.join(tokenDir, name), hourAgo, hourAgo);
    }

    await removeOrphanTokenFiles(buildDeps([liveId, exitedId, files.unknownOld, files.unknownFresh], { tokenDir }));

    assert.deepEqual(readdirSync(tokenDir).sort(), [files.live, files.unknownFresh, files.notUuid].sort());
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
