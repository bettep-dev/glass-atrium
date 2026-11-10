// Owner queue session-side API (/api/queue/*): request gate, register/deregister, post/get, pull, ack, withdraw, count.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/queue.session-api.route.test.ts
// Secrets and home are mktemp fixtures passed as plugin options → the live ~/.glass-atrium/secrets is never read.
// Every session id a test creates is tracked and its rows are deleted in after().

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";

import type { Prisma } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { setSocketDeliveryOn } from "../src/server/queue/drift-guard.js";
import { registerQueueRoutes } from "../src/server/routes/queue.js";
import { deleteDirectory } from "./lib/remove-dir.js";
import { lockQueueRows, unlockQueueRows, withQueueRowsExclusive } from "./lib/queue-rows-lock.js";

const PORT = 16145;
const CLI_PATH = "/opt/atrium-test/scripts/atrium-queue.sh";
const QUEUE_KEY = "test-queue-key-0123456789abcdef";
const HOST = `127.0.0.1:${PORT}`;
const ACK_DEADLINE_MS = 120_000;

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "queue-api-"));
const dir = { secrets: path.join(fixtureRoot, "secrets"), home: path.join(fixtureRoot, "home") };
const trackedSessionIds: string[] = [];
let app: FastifyInstance;

before(async () => {
  await lockQueueRows();
  mkdirSync(dir.secrets, { mode: 0o700 });
  writeFileSync(path.join(dir.secrets, "queue-key"), `${QUEUE_KEY}\n`, { mode: 0o600 });
  mkdirSync(path.join(dir.home, ".claude-work"), { recursive: true });
  mkdirSync(path.join(dir.home, "elsewhere"), { recursive: true });
  app = await buildApp(dir.secrets);
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

async function buildApp(secrets: string): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  instance.get("/api/root-probe", async () => ({ ok: true }));
  await registerQueueRoutes(instance, { secretsDir: secrets, port: PORT, homeDir: dir.home, cliPath: CLI_PATH });
  await instance.ready();
  return instance;
}

interface SendOptions {
  host?: string;
  key?: string | null;
  target?: FastifyInstance;
}

function send(method: "GET" | "POST", url: string, body?: object, options: SendOptions = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { host: options.host ?? HOST };
  const key = options.key === undefined ? QUEUE_KEY : options.key;
  if (key !== null) headers["x-atrium-queue-key"] = key;
  return (options.target ?? app).inject({ method, url, headers, ...(body === undefined ? {} : { payload: body }) });
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
  test("Host allowlist runs first, then the queue key", async () => {
    const rows = [
      { name: "rebinding host", host: `evil.example:${PORT}`, key: QUEUE_KEY, status: 403 },
      { name: "rebinding host with no key is refused by the Host check", host: `evil.example:${PORT}`, key: null, status: 403 },
      { name: "allowlisted name on another port", host: "127.0.0.1:1", key: QUEUE_KEY, status: 403 },
      { name: "no key", host: HOST, key: null, status: 401 },
      { name: "wrong key", host: `localhost:${PORT}`, key: "not-the-key", status: 401 },
      { name: "right key over [::1] reaches the handler", host: `[::1]:${PORT}`, key: QUEUE_KEY, status: 404 },
    ];
    for (const row of rows) {
      const response = await send("POST", "/api/queue/pending", { sessionId: randomUUID() }, { host: row.host, key: row.key });
      assert.equal(response.statusCode, row.status, row.name);
    }
  });

  test("a root route outside the queue plugin sees no queue hook", async () => {
    const response = await send("GET", "/api/root-probe", undefined, { host: `evil.example:${PORT}`, key: null });
    assert.equal(response.statusCode, 200);
  });

  test("the count route needs no queue key but still refuses a rebinding host", async () => {
    const refused = await send("GET", "/api/queue/count", undefined, { host: `evil.example:${PORT}`, key: null });
    const counted = await send("GET", "/api/queue/count", undefined, { key: null });
    assert.equal(refused.statusCode, 403);
    assert.equal(counted.statusCode, 200);
    assert.deepEqual(Object.keys(counted.json()).sort(), ["awaiting", "deviations", "oldestAgeSeconds"]);
  });

  test("a key file written after a not-provisioned answer is picked up with no restart", async () => {
    const lateSecrets = makeFixtureDir("late-secrets");
    const lateApp = await buildApp(lateSecrets);
    try {
      const before = await send("POST", "/api/queue/pending", { sessionId: randomUUID() }, { target: lateApp });
      writeFileSync(path.join(lateSecrets, "queue-key"), QUEUE_KEY, { mode: 0o600 });
      const afterWrite = await send("POST", "/api/queue/pending", { sessionId: randomUUID() }, { target: lateApp });
      assert.equal(before.statusCode, 503);
      assert.equal(afterWrite.statusCode, 404);
    } finally {
      await lateApp.close();
    }
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
      { name: "socket path naming another pid", extra: { socketPath: `/tmp/cc-socks/${process.pid + 1}.sock` }, error: "invalid_socket_path" },
      { name: "pid of no running process", extra: { pid: 2_147_483_646 }, error: "invalid_pid" },
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
});

describe("count", () => {
  test("counts open items as awaiting and every deviation, delivery off and not reachable included", async () => {
    const readCount = async (): Promise<{ awaiting: number; deviations: number; oldestAgeSeconds: number | null }> =>
      (await send("GET", "/api/queue/count", undefined, { key: null })).json();
    const readCountWith = async (isOn: boolean): Promise<{ awaiting: number; deviations: number; oldestAgeSeconds: number | null }> => {
      setSocketDeliveryOn(isOn);
      return readCount();
    };
    const measureSeedDelta = async (): Promise<{ awaiting: number; deviations: number; degradedDeviations: number; oldestAgeSeconds: number | null }> => {
      const baseline = await readCountWith(true);
      const degradedBaseline = await readCountWith(false);
      const live = await seedSession();
      const deliveryOff = await seedSession({ socketPath: null });
      const notReachable = await seedSession({ state: "stale" });
      await seedItem(live, { status: "open", askedAt: new Date(Date.now() - 3_600_000) });
      await seedItem(live, { status: "answered" });
      for (const status of ["unacked", "held", "expired", "resume_pending"] as const) await seedItem(live, { status });
      await seedItem(deliveryOff, { status: "answered" });
      await seedItem(notReachable, { status: "answered" });
      const counted = await readCountWith(true);
      const degraded = await readCountWith(false);
      return {
        awaiting: counted.awaiting - baseline.awaiting,
        deviations: counted.deviations - baseline.deviations,
        degradedDeviations: degraded.deviations - degradedBaseline.deviations,
        oldestAgeSeconds: counted.oldestAgeSeconds,
      };
    };
    // the count is database-wide → measured while no other suite holds queue items
    const delta = await withQueueRowsExclusive(measureSeedDelta).finally(() => setSocketDeliveryOn(false));
    assert.deepEqual(
      { awaiting: delta.awaiting, deviations: delta.deviations, degradedDeviations: delta.degradedDeviations },
      { awaiting: 1, deviations: 6, degradedDeviations: 7 },
      "degraded: the live row's answered item counts as delivery off too",
    );
    assert.ok((delta.oldestAgeSeconds ?? 0) >= 3600, `oldest age ${delta.oldestAgeSeconds}`);
  });
});
