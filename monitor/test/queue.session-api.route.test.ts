// Owner queue session-side API (/api/queue/*): request gate, register/deregister, post/get, pull, ack, withdraw, count.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/queue.session-api.route.test.ts
// Home is a mktemp fixture passed as a plugin option → no live config dir is read.
// Every session id a test creates is tracked and its rows are deleted in after().

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";

import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";

import type { Prisma } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { WAIT_FRESH_MS, isSessionWaiting } from "../src/server/queue/delivery.js";
import { registerQueueRoutes } from "../src/server/routes/queue.js";
import { deleteDirectory } from "./lib/remove-dir.js";
import { lockQueueRows, unlockQueueRows, withQueueRowsExclusive } from "./lib/queue-rows-lock.js";

const PORT = 16145;
const CLI_PATH = "/opt/atrium-test/scripts/atrium-queue.sh";
const HOST = `127.0.0.1:${PORT}`;
const ACK_DEADLINE_MS = 120_000;
const QUEUE_CLI_SOURCE = fileURLToPath(new URL("../../scripts/atrium-queue.sh", import.meta.url));

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "queue-api-"));
const dir = { home: path.join(fixtureRoot, "home") };
const trackedSessionIds: string[] = [];
let app: FastifyInstance;

before(async () => {
  await lockQueueRows();
  mkdirSync(path.join(dir.home, ".claude-work"), { recursive: true });
  mkdirSync(path.join(dir.home, "elsewhere"), { recursive: true });
  app = await buildApp();
});

after(async () => {
  await app.close();
  const prisma = getPrisma();
  await prisma.queueDelivery.deleteMany({ where: { item: { sessionId: { in: trackedSessionIds } } } });
  await prisma.queueItem.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await prisma.queueSession.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await unlockQueueRows();
  await disconnectPrisma();
  deleteDirectory(fixtureRoot);
});

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  instance.get("/api/root-probe", async () => ({ ok: true }));
  await registerQueueRoutes(instance, { port: PORT, homeDir: dir.home, cliPath: CLI_PATH });
  await instance.ready();
  return instance;
}

function send(method: "GET" | "POST", url: string, body?: object, options: { host?: string } = {}): Promise<LightMyRequestResponse> {
  const headers = { host: options.host ?? HOST };
  return app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body }) });
}

function trackSessionId(): string {
  const sessionId = randomUUID();
  trackedSessionIds.push(sessionId);
  return sessionId;
}

async function seedSession(overrides: Partial<Prisma.QueueSessionUncheckedCreateInput> = {}): Promise<string> {
  const sessionId = trackSessionId();
  const pid = overrides.pid ?? 700_000 + Math.floor(Math.random() * 100_000);
  await getPrisma().queueSession.create({
    data: {
      sessionId,
      isConfigDirSet: false,
      profileLabel: "default",
      cwd: "/Users/owner/Desktop/git/glass-atrium",
      worktreeRoot: "/Users/owner/Desktop/git/glass-atrium",
      processStartTime: "Mon Nov  9 08:01:12 2026",
      socketPath: `/private/tmp/cc-socks/${pid}.sock`,
      state: "live",
      lastSeenAt: new Date(),
      ...overrides,
      pid,
    },
  });
  return sessionId;
}

async function seedItem(sessionId: string, overrides: Partial<Prisma.QueueItemUncheckedCreateInput> = {}): Promise<bigint> {
  const item = await getPrisma().queueItem.create({
    data: { kind: "report", sessionId, title: "Build finished", body: "All 12 suites green.", isFreeTextAllowed: true, ...overrides },
  });
  return item.id;
}

async function seedDelivery(itemId: bigint, attempt = 1): Promise<string> {
  const msgId = randomUUID();
  const sentAt = new Date();
  await getPrisma().queueDelivery.create({
    data: { msgId, itemId, route: "socket", attempt, result: "sent", sentAt, ackDeadlineAt: new Date(sentAt.getTime() + ACK_DEADLINE_MS) },
  });
  return msgId;
}

async function getStatus(itemId: bigint): Promise<string> {
  const item = await getPrisma().queueItem.findUniqueOrThrow({ where: { id: itemId } });
  return item.status;
}

function makeFixtureDir(name: string): string {
  const fixtureDir = path.join(fixtureRoot, `${name}-${randomUUID().slice(0, 8)}`);
  mkdirSync(fixtureDir, { recursive: true });
  return realpathSync(fixtureDir);
}

function registerBody(sessionId: string, extra: object = {}): object {
  return { sessionId, pid: process.pid, cwd: makeFixtureDir("cwd"), ...extra };
}

describe("queue request gate", () => {
  test("the Host allowlist is the only gate a session route has: no key header, no secrets directory", async () => {
    const rows = [
      { name: "rebinding host", host: `evil.example:${PORT}`, status: 403 },
      { name: "allowlisted name on another port", host: "127.0.0.1:1", status: 403 },
      { name: "127.0.0.1 with no key header reaches the handler", host: HOST, status: 404 },
      { name: "localhost with no key header reaches the handler", host: `localhost:${PORT}`, status: 404 },
      { name: "[::1] with no key header reaches the handler", host: `[::1]:${PORT}`, status: 404 },
    ];
    for (const row of rows) {
      const response = await send("POST", "/api/queue/pending", { sessionId: randomUUID() }, { host: row.host });
      assert.equal(response.statusCode, row.status, row.name);
    }
  });

  test("a root route outside the queue plugin sees no queue hook", async () => {
    const response = await send("GET", "/api/root-probe", undefined, { host: `evil.example:${PORT}` });
    assert.equal(response.statusCode, 200);
  });

  test("the count route refuses a rebinding host", async () => {
    const refused = await send("GET", "/api/queue/count", undefined, { host: `evil.example:${PORT}` });
    const counted = await send("GET", "/api/queue/count");
    assert.equal(refused.statusCode, 403);
    assert.equal(counted.statusCode, 200);
    assert.deepEqual(Object.keys(counted.json()).sort(), ["awaiting", "deviations", "oldestAgeSeconds"]);
  });
});

describe("register", () => {
  test("rejects a body outside the registration rules and stores no row", async () => {
    const regularFile = path.join(makeFixtureDir("file"), "plain.txt");
    writeFileSync(regularFile, "x");
    const rows = [
      { name: "client-sent start time", extra: { processStartTime: "Mon Nov  9 08:01:12 2026" }, error: "invalid_input" },
      { name: "relative cwd", extra: { cwd: "relative/dir" }, error: "invalid_input" },
      { name: "cwd is a file", extra: { cwd: regularFile }, error: "invalid_cwd" },
      { name: "config dir outside $HOME/.claude*", extra: { configDir: path.join(dir.home, "elsewhere") }, error: "invalid_config_dir" },
      { name: "socket path, even one naming the registered pid", extra: { socketPath: `/tmp/cc-socks/${process.pid}.sock` }, error: "invalid_input" },
      { name: "accept-wrapper launch hint", extra: { launchHint: "accept_wrapper" }, error: "invalid_input" },
      { name: "pid of no running process", extra: { pid: 2_147_483_646 }, error: "invalid_pid" },
      { name: "name past 100 characters", extra: { name: "n".repeat(101) }, error: "invalid_input" },
      { name: "blank name", extra: { name: "   " }, error: "invalid_input" },
      { name: "name carrying a line break", extra: { name: "queue sessions\nsecond line" }, error: "invalid_input" },
      { name: "derived name carrying a line break", extra: { derivedName: "queue sessions\nsecond line" }, error: "invalid_input" },
    ];
    for (const row of rows) {
      const sessionId = trackSessionId();
      const response = await send("POST", "/api/queue/sessions/register", registerBody(sessionId, row.extra));
      const stored = await getPrisma().queueSession.findUnique({ where: { sessionId } });
      assert.deepEqual([response.statusCode, response.json().error], [400, row.error], row.name);
      assert.equal(stored, null, row.name);
    }
  });

  test("rejects a non-UUID session id", async () => {
    const response = await send("POST", "/api/queue/sessions/register", registerBody("not-a-uuid"));
    assert.equal(response.statusCode, 400);
  });

  test("a cwd the monitor may not read is an environment failure, never a database outage", async () => {
    const locked = makeFixtureDir("locked");
    const cwd = path.join(locked, "inner");
    mkdirSync(cwd);
    chmodSync(locked, 0o000);
    try {
      const sessionId = trackSessionId();
      const response = await send("POST", "/api/queue/sessions/register", registerBody(sessionId, { cwd }));
      assert.deepEqual([response.statusCode, response.json()], [500, { error: "queue_environment_failure" }]);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("stores the realpath of a /tmp cwd", async () => {
    const tmpCwd = mkdtempSync("/tmp/queue-api-cwd-");
    try {
      const sessionId = trackSessionId();
      const response = await send("POST", "/api/queue/sessions/register", { sessionId, pid: process.pid, cwd: tmpCwd });
      const stored = await getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId } });
      assert.equal(response.statusCode, 200);
      assert.equal(stored.cwd, `/private${tmpCwd}`);
    } finally {
      deleteDirectory(tmpCwd);
    }
  });

  test("derives the worktree root from the nearest .git entry above the cwd", async () => {
    const dirCheckout = makeFixtureDir("checkout");
    mkdirSync(path.join(dirCheckout, ".git"));
    const linkedWorktree = makeFixtureDir("linked");
    writeFileSync(path.join(linkedWorktree, ".git"), "gitdir: /elsewhere/.git/worktrees/linked\n");
    const rows = [
      { name: "directory .git", root: dirCheckout as string | null },
      { name: "file .git", root: linkedWorktree as string | null },
      { name: "no .git above", root: null },
    ];
    for (const row of rows) {
      const base = row.root ?? makeFixtureDir("plain");
      const cwd = path.join(base, "monitor", "src");
      mkdirSync(cwd, { recursive: true });
      const sessionId = trackSessionId();
      await send("POST", "/api/queue/sessions/register", { sessionId, pid: process.pid, cwd });
      const stored = await getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId } });
      assert.equal(stored.worktreeRoot, row.root, row.name);
    }
  });

  test("stores the start time the server reads under TZ=UTC, never one the client sends", async () => {
    const sessionId = trackSessionId();
    await send("POST", "/api/queue/sessions/register", registerBody(sessionId));
    const stored = await getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId } });
    const psRead = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], {
      env: { TZ: "UTC", LC_ALL: "C", PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    }).trim();
    assert.equal(stored.processStartTime, psRead);
  });

  test("labels the profile by the config dir basename, or default when unset", async () => {
    const rows = [
      { name: "config dir set", extra: { configDir: path.join(dir.home, ".claude-work") }, label: ".claude-work", isSet: true },
      { name: "config dir unset", extra: {}, label: "default", isSet: false },
    ];
    for (const row of rows) {
      const sessionId = trackSessionId();
      await send("POST", "/api/queue/sessions/register", registerBody(sessionId, row.extra));
      const stored = await getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId } });
      assert.equal(stored.profileLabel, row.label, row.name);
      assert.equal(stored.isConfigDirSet, row.isSet, row.name);
    }
  });

  test("a derived name labels a session until it registers an explicit name, which only another explicit name replaces", async () => {
    const sessionId = trackSessionId();
    const steps = [
      { name: "a derived name labels an unnamed session", extra: { derivedName: "Fix the flaky sweep test" }, stored: "Fix the flaky sweep test" },
      { name: "a later derived name replaces a derived one", extra: { derivedName: "queue sessions" }, stored: "queue sessions" },
      { name: "an explicit name replaces a derived one", extra: { name: "queue-sessions M2" }, stored: "queue-sessions M2" },
      { name: "a derived name never replaces an explicit one", extra: { derivedName: "nightly-backup" }, stored: "queue-sessions M2" },
      { name: "a nameless re-register keeps the stored name", extra: {}, stored: "queue-sessions M2" },
      { name: "a new explicit name replaces the old one", extra: { name: "queue-sessions M3" }, stored: "queue-sessions M3" },
    ];
    for (const step of steps) {
      const response = await send("POST", "/api/queue/sessions/register", registerBody(sessionId, step.extra));
      const stored = await getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId } });
      assert.deepEqual([response.statusCode, stored.name], [200, step.stored], step.name);
    }
  });

  test("a new session id on the same pid and start time marks the old row replaced", async () => {
    const id = { old: trackSessionId(), new: trackSessionId() };
    await send("POST", "/api/queue/sessions/register", registerBody(id.old));
    await send("POST", "/api/queue/sessions/register", registerBody(id.new));
    const row = await Promise.all([id.old, id.new].map((sessionId) => getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId } }))).then(
      ([old, current]) => ({ old, new: current }),
    );
    assert.deepEqual([row.old.state, row.old.exitReason], ["exited", "replaced"]);
    assert.deepEqual([row.new.state, row.new.exitReason], ["live", null]);
  });

  test("clears the marker, returns resume-pending items to answered and reports the answered count", async () => {
    const sessionId = await seedSession({ pid: process.pid, socketPath: null, state: "exited", exitReason: "dead", resumeAwaitingRegisterAt: new Date() });
    const resumePending = await seedItem(sessionId, { status: "resume_pending" });
    await seedItem(sessionId, { status: "answered" });
    await seedItem(sessionId, { status: "open" });
    const response = await send("POST", "/api/queue/sessions/register", registerBody(sessionId));
    const stored = await getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { answeredWaiting: 2 });
    assert.deepEqual([stored.state, stored.exitReason, stored.resumeAwaitingRegisterAt], ["live", null, null]);
    assert.equal(await getStatus(resumePending), "answered");
  });

  test("a row still holding a retired socket path of its old process registers live from a new process and drops the path", async () => {
    const sessionId = await seedSession({ state: "exited", exitReason: "dead" });
    const response = await send("POST", "/api/queue/sessions/register", registerBody(sessionId));
    const stored = await getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual([stored.state, stored.pid, stored.socketPath], ["live", process.pid, null]);
  });
});

describe("deregister", () => {
  test("on a marked row only another process's pid clears the marker", async () => {
    const storedPid = 812_345;
    const rows = [
      { name: "another pid", extra: { pid: storedPid + 1 }, isCleared: true },
      { name: "the stored pid", extra: { pid: storedPid }, isCleared: false },
      { name: "no pid", extra: {}, isCleared: false },
      { name: "socket path naming another pid", extra: { socketPath: `/tmp/cc-socks/${storedPid + 1}.sock` }, isCleared: true },
      { name: "socket path naming the stored pid", extra: { socketPath: `/private/tmp/cc-socks/${storedPid}.sock` }, isCleared: false },
    ];
    for (const row of rows) {
      const sessionId = await seedSession({ pid: storedPid, state: "exited", exitReason: "dead", resumeAwaitingRegisterAt: new Date() });
      const response = await send("POST", "/api/queue/sessions/deregister", { sessionId, ...row.extra });
      const stored = await getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId } });
      assert.equal(response.statusCode, 200, row.name);
      assert.equal(stored.resumeAwaitingRegisterAt === null, row.isCleared, row.name);
    }
  });

  test("ends a live row whose own process deregisters", async () => {
    const sessionId = await seedSession({ pid: 823_456 });
    await send("POST", "/api/queue/sessions/deregister", { sessionId, pid: 823_456 });
    const stored = await getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId } });
    assert.deepEqual([stored.state, stored.exitReason], ["exited", "ended"]);
  });

  test("refuses an unknown session and an unconfined socket path", async () => {
    const sessionId = await seedSession();
    const unknown = await send("POST", "/api/queue/sessions/deregister", { sessionId: randomUUID() });
    const unconfined = await send("POST", "/api/queue/sessions/deregister", { sessionId, socketPath: "/tmp/elsewhere/1.sock" });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unconfined.statusCode, 400);
  });
});

describe("post and get by id", () => {
  const decision = (sessionId: string, extra: object = {}): object => ({
    kind: "decision",
    sessionId,
    title: "Pick the cache backend",
    body: "Two options fit the measured load.",
    options: [
      { code: "R1", label: "Postgres table", pros: "no new service", cons: "slower reads" },
      { code: "R2", label: "Redis", pros: "fast", cons: "one more daemon" },
    ],
    recommendedCode: "R1",
    isFreeTextAllowed: true,
    ...extra,
  });

  test("a posted decision is readable by its own session and by no other", async () => {
    const sessionId = await seedSession();
    const posted = await send("POST", "/api/queue/items", decision(sessionId, { isApprovalClass: true }));
    const id = posted.json().id;
    const own = await send("GET", `/api/queue/items/${id}?sessionId=${sessionId}`);
    const foreign = await send("GET", `/api/queue/items/${id}?sessionId=${await seedSession()}`);
    assert.equal(posted.statusCode, 201);
    assert.equal(own.statusCode, 200);
    assert.deepEqual(
      [own.json().kind, own.json().status, own.json().recommendedCode, own.json().isApprovalClass, own.json().options.length, own.json().answer],
      ["decision", "open", "R1", true, 2, { code: null, text: null }],
    );
    assert.equal(foreign.statusCode, 404);
  });

  test("accepts linked doc ids that exist", async () => {
    const doc = await getPrisma().claudedDoc.create({
      data: { title: "Queue fixture doc", author: "queue-test", createdAt: new Date(), contentHash: "0".repeat(64), htmlPath: "queue-fixture.html", indexableText: "fixture" },
    });
    try {
      const sessionId = await seedSession();
      const posted = await send("POST", "/api/queue/items", decision(sessionId, { linkedDocIds: [Number(doc.id)] }));
      const fetched = await send("GET", `/api/queue/items/${posted.json().id}?sessionId=${sessionId}`);
      assert.equal(posted.statusCode, 201);
      assert.deepEqual(fetched.json().linkedDocIds, [Number(doc.id)]);
    } finally {
      await getPrisma().queueItem.deleteMany({ where: { linkedDocIds: { has: doc.id } } });
      await getPrisma().claudedDoc.delete({ where: { id: doc.id } });
    }
  });

  test("rejects an item outside the post rules", async () => {
    const sessionId = await seedSession();
    const rows = [
      { name: "recommended code not among the options", body: decision(sessionId, { recommendedCode: "R3" }), error: "invalid_input" },
      { name: "duplicate option codes", body: decision(sessionId, { options: [{ code: "R1", label: "a", pros: "", cons: "" }, { code: "R1", label: "b", pros: "", cons: "" }] }), error: "invalid_input" },
      { name: "report carrying options", body: { ...(decision(sessionId) as Record<string, unknown>), kind: "report" }, error: "invalid_input" },
      { name: "unknown linked doc id", body: decision(sessionId, { linkedDocIds: [9_007_199_254_740_000] }), error: "unknown_linked_doc" },
      { name: "unknown key", body: decision(sessionId, { status: "answered" }), error: "invalid_input" },
      { name: "blank title", body: decision(sessionId, { title: "   " }), error: "invalid_input" },
      { name: "message kind, which only the owner send creates", body: { ...(decision(sessionId) as Record<string, unknown>), kind: "message", options: undefined, recommendedCode: undefined }, error: "invalid_input" },
    ];
    for (const row of rows) {
      const response = await send("POST", "/api/queue/items", row.body);
      assert.deepEqual([response.statusCode, response.json().error], [400, row.error], row.name);
    }
  });

  test("answers 404 for an unknown session or item and 400 for a malformed id", async () => {
    const sessionId = await seedSession();
    const unknownSession = await send("POST", "/api/queue/items", decision(randomUUID()));
    const unknownItem = await send("GET", `/api/queue/items/9007199254740000?sessionId=${sessionId}`);
    const malformed = await send("GET", `/api/queue/items/abc?sessionId=${sessionId}`);
    assert.equal(unknownSession.statusCode, 404);
    assert.equal(unknownItem.statusCode, 404);
    assert.equal(malformed.statusCode, 400);
  });
});

describe("pending (pull claim)", () => {
  test("claims only the caller's answered items and inserts one pull delivery each", async () => {
    const caller = await seedSession();
    const other = await seedSession();
    const answered = [await seedItem(caller, { status: "answered", nextAttempt: 2 }), await seedItem(caller, { status: "answered" })];
    const open = await seedItem(caller);
    const foreign = await seedItem(other, { status: "answered" });
    const response = await send("POST", "/api/queue/pending", { sessionId: caller });
    const deliveries = await getPrisma().queueDelivery.findMany({ where: { itemId: { in: [...answered, open, foreign] } } });
    const claims: Array<{ id: { item: number; msg: string } }> = response.json().items;
    const ids = { claimed: claims.map((claim) => BigInt(claim.id.item)).sort(), msg: new Set(deliveries.map((row) => row.msgId)) };
    assert.deepEqual(ids.claimed, [...answered].sort());
    assert.ok(claims.every((claim) => ids.msg.has(claim.id.msg)), "every claim names its own pull delivery");
    assert.deepEqual(await Promise.all(answered.map(getStatus)), ["delivering", "delivering"]);
    assert.deepEqual([await getStatus(open), await getStatus(foreign)], ["open", "answered"]);
    assert.deepEqual(deliveries.map((row) => [row.itemId, row.route, row.attempt]).sort(), [[answered[0], "pull", 2], [answered[1], "pull", 1]].sort());
  });

  const notLiveRows = [
    { name: "row ended by its own process", seed: { state: "exited" as const, exitReason: "ended" as const }, pidOffset: 0 },
    { name: "row replaced after a clear", seed: { state: "exited" as const, exitReason: "replaced" as const }, pidOffset: 0 },
    { name: "live row of another process", seed: {}, pidOffset: 1 },
  ];
  for (const row of notLiveRows) {
    test(`a wait pull from a process the row is not live for is refused and claims nothing: ${row.name}`, async () => {
      const pid = 700_000 + Math.floor(Math.random() * 100_000);
      const sessionId = await seedSession({ ...row.seed, pid });
      const itemId = await seedItem(sessionId, { status: "answered" });

      const response = await send("POST", "/api/queue/pending", { sessionId, pid: pid + row.pidOffset, wait: true });

      assert.deepEqual([response.statusCode, response.json().error], [409, "session_not_live"], row.name);
      assert.equal(await getStatus(itemId), "answered", row.name);
      assert.equal(await getPrisma().queueDelivery.count({ where: { itemId } }), 0, row.name);
      assert.equal(isSessionWaiting(sessionId), false, row.name);
    });
  }

  test("a wait pull from the row's own live process claims like a plain pull", async () => {
    const pid = 700_000 + Math.floor(Math.random() * 100_000);
    const sessionId = await seedSession({ pid });
    const itemId = await seedItem(sessionId, { status: "answered" });

    const response = await send("POST", "/api/queue/pending", { sessionId, pid, wait: true });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().items.map((claim: { id: { item: number } }) => claim.id.item), [Number(itemId)]);
    assert.equal(await getStatus(itemId), "delivering");
  });

  test("rejects a wait flag with no pid and a pid with no wait flag", async () => {
    const sessionId = await seedSession();
    for (const body of [{ sessionId, wait: true }, { sessionId, pid: 4242 }]) {
      const response = await send("POST", "/api/queue/pending", body);
      assert.equal(response.statusCode, 400, JSON.stringify(body));
    }
  });
});

describe("waiting fact", () => {
  test("a wait pull makes its session waiting until the freshness window passes; a plain pull never does", async () => {
    const pid = 700_000 + Math.floor(Math.random() * 100_000);
    const waiting = await seedSession({ pid });
    const plain = await seedSession();

    await send("POST", "/api/queue/pending", { sessionId: waiting, pid, wait: true });
    await send("POST", "/api/queue/pending", { sessionId: plain });
    const now = Date.now();

    assert.deepEqual(
      [isSessionWaiting(waiting, new Date(now)), isSessionWaiting(waiting, new Date(now + WAIT_FRESH_MS + 1_000)), isSessionWaiting(plain, new Date(now))],
      [true, false, false],
    );
  });

  test("the freshness window is two of the queue CLI's wait poll intervals", () => {
    const pollSeconds = Number(/^readonly WAIT_POLL_S=(\d+)$/m.exec(readFileSync(QUEUE_CLI_SOURCE, "utf8"))?.[1]);

    assert.equal(WAIT_FRESH_MS, 2 * pollSeconds * 1_000);
  });
});

describe("ack", () => {
  test("the first valid ack wins in every ackable state and a repeat is already handled", async () => {
    const sessionId = await seedSession();
    for (const status of ["answered", "delivering", "unacked", "held", "expired", "resume_pending"] as const) {
      const itemId = await seedItem(sessionId, { status });
      const msgId = await seedDelivery(itemId);
      const first = await send("POST", `/api/queue/items/${itemId}/ack`, { sessionId, msgId });
      const repeat = await send("POST", `/api/queue/items/${itemId}/ack`, { sessionId, msgId });
      assert.deepEqual([first.json().result, repeat.json().result], ["first", "already_handled"], status);
      assert.equal(await getStatus(itemId), "delivered", status);
    }
  });

  test("a late ack for an earlier msg id after a Resend still wins", async () => {
    const sessionId = await seedSession();
    const itemId = await seedItem(sessionId, { status: "answered", nextAttempt: 2 });
    const earlierMsgId = await seedDelivery(itemId, 1);
    const response = await send("POST", `/api/queue/items/${itemId}/ack`, { sessionId, msgId: earlierMsgId });
    assert.equal(response.json().result, "first");
  });

  test("an ack on a terminal item is already handled and changes nothing", async () => {
    const sessionId = await seedSession();
    for (const status of ["delivered", "seen", "withdrawn"] as const) {
      const itemId = await seedItem(sessionId, { status });
      const msgId = await seedDelivery(itemId);
      const response = await send("POST", `/api/queue/items/${itemId}/ack`, { sessionId, msgId });
      assert.equal(response.json().result, "already_handled", status);
      assert.equal(await getStatus(itemId), status, status);
    }
  });

  test("rejects a msg id of another item and a caller naming another session", async () => {
    const sessionId = await seedSession();
    const itemId = await seedItem(sessionId, { status: "delivering" });
    await seedDelivery(itemId);
    const msgId = { foreign: await seedDelivery(await seedItem(sessionId, { status: "delivering" })), own: await seedDelivery(itemId) };
    const foreignMsg = await send("POST", `/api/queue/items/${itemId}/ack`, { sessionId, msgId: msgId.foreign });
    const foreignCaller = await send("POST", `/api/queue/items/${itemId}/ack`, { sessionId: await seedSession(), msgId: msgId.own });
    assert.deepEqual([foreignMsg.statusCode, foreignCaller.statusCode], [404, 404]);
    assert.equal(await getStatus(itemId), "delivering");
  });
});

describe("withdraw", () => {
  test("withdraws every non-terminal state except delivering, which is a conflict", async () => {
    const sessionId = await seedSession();
    const rows = [
      ...(["open", "answered", "unacked", "held", "expired", "resume_pending"] as const).map((status) => ({ status, code: 200, after: "withdrawn" })),
      ...(["delivering", "delivered", "seen", "withdrawn"] as const).map((status) => ({ status, code: 409, after: status })),
    ];
    for (const row of rows) {
      const itemId = await seedItem(sessionId, { status: row.status });
      const response = await send("POST", `/api/queue/items/${itemId}/withdraw`, { sessionId });
      assert.equal(response.statusCode, row.code, row.status);
      assert.equal(await getStatus(itemId), row.after, row.status);
    }
  });

  test("refuses an owner message in every withdrawable state and leaves it in place", async () => {
    const sessionId = await seedSession();
    for (const status of ["answered", "unacked", "held", "expired", "resume_pending"] as const) {
      const itemId = await seedItem(sessionId, {
        kind: "message",
        title: "Rebase onto main",
        body: "Rebase onto main before the review.",
        isFreeTextAllowed: false,
        status,
        answeredAt: new Date(),
        answerRoute: "message",
        answerSignal: "fetch_metadata",
      });
      const response = await send("POST", `/api/queue/items/${itemId}/withdraw`, { sessionId });
      assert.deepEqual([response.statusCode, response.json().error], [409, "not_withdrawable"], status);
      assert.equal(await getStatus(itemId), status, status);
    }
  });
});

describe("count", () => {
  test("counts open items as awaiting and only the unacked, held, expired and resume-pending items as deviations", async () => {
    const readCount = async (): Promise<{ awaiting: number; deviations: number; oldestAgeSeconds: number | null }> =>
      (await send("GET", "/api/queue/count")).json();
    const measureSeedDelta = async (): Promise<{ awaiting: number; deviations: number; oldestAgeSeconds: number | null }> => {
      const baseline = await readCount();
      const live = await seedSession();
      const noSocket = await seedSession({ socketPath: null });
      const stale = await seedSession({ state: "stale" });
      await seedItem(live, { status: "open", askedAt: new Date(Date.now() - 3_600_000) });
      for (const status of ["unacked", "held", "expired", "resume_pending"] as const) await seedItem(live, { status });
      for (const sessionId of [live, noSocket, stale]) await seedItem(sessionId, { status: "answered" });
      const counted = await readCount();
      return { awaiting: counted.awaiting - baseline.awaiting, deviations: counted.deviations - baseline.deviations, oldestAgeSeconds: counted.oldestAgeSeconds };
    };
    // the count is database-wide → measured while no other suite holds queue items
    const delta = await withQueueRowsExclusive(measureSeedDelta);
    assert.deepEqual({ awaiting: delta.awaiting, deviations: delta.deviations }, { awaiting: 1, deviations: 4 }, "an answered item waits for its session's pull, never a deviation");
    assert.ok((delta.oldestAgeSeconds ?? 0) >= 3600, `oldest age ${delta.oldestAgeSeconds}`);
  });
});
