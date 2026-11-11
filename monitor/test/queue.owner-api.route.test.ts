// Owner queue API (/api/queue/owner/*): owner-session auth, list and item detail, answer, later, seen, reply, resend.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/queue.owner-api.route.test.ts
// Secrets are mktemp fixtures passed as plugin options → the live ~/.glass-atrium/secrets is never read.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";

import type { Prisma } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { setSocketDeliveryOn } from "../src/server/queue/drift-guard.js";
import { registerRoutes } from "../src/server/routes/index.js";
import { registerQueueRoutes, resolveQueueRouteOptions } from "../src/server/routes/queue.js";
import { deleteDirectory } from "./lib/remove-dir.js";
import { lockQueueRows, unlockQueueRows } from "./lib/queue-rows-lock.js";

const PORT = 16145;
const CLI_PATH = "/opt/atrium-test/scripts/atrium-queue.sh";
const HOST = `127.0.0.1:${PORT}`;
const PASSPHRASE = "owner passphrase for tests";
const QUEUE_KEY = "test-queue-key-0123456789abcdef";
const COOKIE_NAME = "atrium_queue_owner";
const ACK_DEADLINE_MS = 120_000;

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "queue-owner-api-"));
const dir = { secrets: path.join(fixtureRoot, "secrets"), home: path.join(fixtureRoot, "home") };
const trackedSessionIds: string[] = [];
let app: FastifyInstance;
let ownerCookie: string;

before(async () => {
  await lockQueueRows();
  mkdirSync(dir.secrets, { mode: 0o700 });
  mkdirSync(dir.home);
  writeSecrets(dir.secrets);
  app = await buildApp(dir.secrets);
  ownerCookie = await loginOrThrow(app);
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

function writeSecrets(secretsDir: string): void {
  const salt = randomBytes(16);
  const hash = scryptSync(PASSPHRASE, salt, 32, { N: 16_384, r: 8, p: 1 });
  const record = { algorithm: "scrypt", N: 16_384, r: 8, p: 1, keyLength: 32, salt: salt.toString("base64"), hash: hash.toString("base64") };
  writeFileSync(path.join(secretsDir, "owner-passphrase.json"), JSON.stringify(record), { mode: 0o600 });
  writeFileSync(path.join(secretsDir, "queue-key"), `${QUEUE_KEY}\n`, { mode: 0o600 });
}

async function buildApp(secretsDir: string): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  instance.get("/api/root-probe", async (request) => ({ hasCookies: "cookies" in request }));
  await registerQueueRoutes(instance, { secretsDir, port: PORT, homeDir: dir.home, cliPath: CLI_PATH });
  await instance.ready();
  return instance;
}

interface SendOptions {
  host?: string;
  cookie?: string | null;
  headers?: Record<string, string>;
  target?: FastifyInstance;
}

function send(method: "GET" | "POST", url: string, body?: object, options: SendOptions = {}): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { host: options.host ?? HOST, ...options.headers };
  const cookie = options.cookie === undefined ? ownerCookie : options.cookie;
  if (cookie !== null) headers.cookie = `${COOKIE_NAME}=${cookie}`;
  return (options.target ?? app).inject({ method, url, headers, ...(body === undefined ? {} : { payload: body }) });
}

async function loginOrThrow(target: FastifyInstance): Promise<string> {
  const response = await send("POST", "/api/queue/owner/login", { passphrase: PASSPHRASE }, { target, cookie: null });
  const cookie = response.cookies.find((entry) => entry.name === COOKIE_NAME);
  if (response.statusCode !== 200 || cookie === undefined) throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  return cookie.value;
}

async function seedSession(overrides: Partial<Prisma.QueueSessionUncheckedCreateInput> = {}): Promise<string> {
  const sessionId = randomUUID();
  trackedSessionIds.push(sessionId);
  const pid = 700_000 + Math.floor(Math.random() * 100_000);
  await getPrisma().queueSession.create({
    data: {
      sessionId,
      isConfigDirSet: false,
      profileLabel: "default",
      cwd: "/Users/owner/Desktop/git/glass-atrium/monitor",
      worktreeRoot: `/Users/owner/Desktop/git/wt-${sessionId.slice(0, 8)}`,
      processStartTime: "Mon Nov  9 08:01:12 2026",
      socketPath: `/private/tmp/cc-socks/${pid}.sock`,
      state: "live",
      lastSeenAt: new Date(),
      pid,
      ...overrides,
    },
  });
  return sessionId;
}

const DECISION_OPTIONS = [
  { code: "R1", label: "Keep the index", pros: "fast reads", cons: "slower writes" },
  { code: "R2", label: "Drop the index", pros: "fast writes", cons: "slow reads" },
];

async function seedItem(sessionId: string, overrides: Partial<Prisma.QueueItemUncheckedCreateInput> = {}): Promise<bigint> {
  const item = await getPrisma().queueItem.create({
    data: { kind: "report", sessionId, title: "Build finished", body: "All 12 suites green.", isFreeTextAllowed: true, ...overrides },
  });
  return item.id;
}

function seedDecision(sessionId: string, overrides: Partial<Prisma.QueueItemUncheckedCreateInput> = {}): Promise<bigint> {
  return seedItem(sessionId, { kind: "decision", options: DECISION_OPTIONS, recommendedCode: "R1", ...overrides });
}

type ResumeRowFields = Pick<Prisma.QueueDeliveryUncheckedCreateInput, "result" | "abortReason">;

async function seedResumeDelivery(itemId: bigint, attempt: number, bgId: string | null = null, fields: ResumeRowFields = { result: "sent" }): Promise<void> {
  const sentAt = new Date();
  await getPrisma().queueDelivery.create({
    data: { msgId: randomUUID(), itemId, route: "resume", attempt, sentAt, ackDeadlineAt: new Date(sentAt.getTime() + ACK_DEADLINE_MS), bgId, ...fields },
  });
}

async function getItemRow(itemId: bigint) {
  return getPrisma().queueItem.findUniqueOrThrow({ where: { id: itemId } });
}

async function countDeliveries(itemId: bigint): Promise<number> {
  return getPrisma().queueDelivery.count({ where: { itemId } });
}

describe("owner auth", () => {
  test("owner routes accept only a live owner session cookie", async () => {
    const noHeaders: Record<string, string> = {};
    const rows = [
      { name: "no cookie", cookie: null, headers: noHeaders, status: 401 },
      { name: "unknown session id", cookie: randomBytes(32).toString("base64url"), headers: noHeaders, status: 401 },
      { name: "the queue key instead of a cookie", cookie: null, headers: { "x-atrium-queue-key": QUEUE_KEY }, status: 401 },
      { name: "rebinding Host with a valid cookie", cookie: undefined, headers: noHeaders, host: `evil.example:${PORT}`, status: 403 },
      { name: "valid owner session", cookie: undefined, headers: noHeaders, status: 200 },
    ];
    for (const row of rows) {
      const response = await send("GET", "/api/queue/owner/items", undefined, { cookie: row.cookie, headers: row.headers, host: row.host });
      assert.equal(response.statusCode, row.status, `${row.name}: ${response.body}`);
    }
  });

  test("a wrong passphrase is refused with no cookie", async () => {
    const target = await buildApp(dir.secrets);
    try {
      const response = await send("POST", "/api/queue/owner/login", { passphrase: "not the passphrase" }, { target, cookie: null });
      assert.equal(response.statusCode, 401, response.body);
      assert.equal(response.cookies.length, 0);
    } finally {
      await target.close();
    }
  });

  test("a second failed login right after the free failures is throttled without checking the passphrase", async () => {
    const target = await buildApp(dir.secrets);
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await send("POST", "/api/queue/owner/login", { passphrase: "wrong" }, { target, cookie: null });
        statuses.push(response.statusCode);
      }
      assert.deepEqual(statuses, [401, 401, 401, 401, 429]);
      const right = await send("POST", "/api/queue/owner/login", { passphrase: PASSPHRASE }, { target, cookie: null });
      assert.equal(right.statusCode, 429, "the right passphrase also waits while throttled");
      assert.ok(Number(right.headers["retry-after"]) >= 1, "Retry-After names the wait");
    } finally {
      await target.close();
    }
  });

  test("the owner cookie is httpOnly, SameSite=Strict, host-only, scoped to the queue API, 7 days, never Secure", async () => {
    const response = await send("POST", "/api/queue/owner/login", { passphrase: PASSPHRASE }, { cookie: null });
    const header = String(response.headers["set-cookie"]);
    const attributes = header.split(";").map((part) => part.trim().toLowerCase());
    assert.ok(attributes.includes("httponly"), header);
    assert.ok(attributes.includes("samesite=strict"), header);
    assert.ok(attributes.includes("path=/api/queue"), header);
    assert.ok(attributes.includes("max-age=604800"), header);
    assert.ok(!attributes.some((part) => part.startsWith("domain=")), `host-only: ${header}`);
    assert.ok(!attributes.includes("secure"), header);
  });

  test("owner activity renews the cookie", async () => {
    const response = await send("GET", "/api/queue/owner/items");
    const renewed = response.cookies.find((entry) => entry.name === COOKIE_NAME);
    assert.equal(renewed?.value, ownerCookie);
    assert.equal(renewed?.maxAge, 604_800);
  });

  test("the session check answers the sign-in state and never renews the cookie", async () => {
    const ended = await loginOrThrow(app);
    await send("POST", "/api/queue/owner/logout", undefined, { cookie: ended });
    const rows = [
      { name: "live session", cookie: undefined, status: 200 },
      { name: "no cookie", cookie: null, status: 401 },
      { name: "unknown session id", cookie: randomBytes(32).toString("base64url"), status: 401 },
      { name: "signed-out session", cookie: ended, status: 401 },
    ];
    for (const row of rows) {
      const response = await send("GET", "/api/queue/owner/session", undefined, { cookie: row.cookie });
      assert.equal(response.statusCode, row.status, `${row.name}: ${response.body}`);
      assert.equal(response.cookies.length, 0, `${row.name}: no Set-Cookie`);
    }
  });

  test("logout ends the owner session", async () => {
    const cookie = await loginOrThrow(app);
    const out = await send("POST", "/api/queue/owner/logout", undefined, { cookie });
    assert.equal(out.statusCode, 200, out.body);
    const after = await send("GET", "/api/queue/owner/items", undefined, { cookie });
    assert.equal(after.statusCode, 401);
  });

  test("a root route outside the queue gets no cookie parsing", async () => {
    const response = await send("GET", "/api/root-probe", undefined, { cookie: ownerCookie });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { hasCookies: false });
  });
});

describe("provisioning", () => {
  test("missing secrets answer not provisioned, and files written afterwards work on the next request with no restart", async () => {
    const secretsDir = path.join(fixtureRoot, `late-${randomUUID().slice(0, 8)}`);
    mkdirSync(secretsDir, { mode: 0o700 });
    const target = await buildApp(secretsDir);
    try {
      const login = await send("POST", "/api/queue/owner/login", { passphrase: PASSPHRASE }, { target, cookie: null });
      assert.equal(login.statusCode, 503, login.body);
      assert.equal(login.json().error, "not_provisioned");
      const list = await send("GET", "/api/queue/owner/items", undefined, { target, cookie: null });
      assert.equal(list.statusCode, 503, list.body);
      writeSecrets(secretsDir);
      const cookie = await loginOrThrow(target);
      const listed = await send("GET", "/api/queue/owner/items", undefined, { target, cookie });
      assert.equal(listed.statusCode, 200, listed.body);
    } finally {
      await target.close();
    }
  });

  test("registerRoutes on a bare instance reads no secret file: an unreadable secrets layout surfaces only on the first request", async () => {
    const secretsDir = path.join(fixtureRoot, `unreadable-${randomUUID().slice(0, 8)}`);
    mkdirSync(path.join(secretsDir, "owner-passphrase.json"), { recursive: true });
    mkdirSync(path.join(secretsDir, "queue-key"), { recursive: true });
    const target = Fastify({ logger: false });
    try {
      await registerRoutes(target, { secretsDir });
      await target.ready();
      const login = await send("POST", "/api/queue/owner/login", { passphrase: PASSPHRASE }, { target, cookie: null });
      assert.equal(login.statusCode, 500, login.body);
      assert.equal(login.json().error, "queue_environment_failure");
    } finally {
      await target.close();
    }
  });
});

describe("answer, reply, seen", () => {
  test("an answer is accepted only as the item allows it", async () => {
    const sessionId = await seedSession();
    const unanswered = { code: null, text: null };
    const rows = [
      { name: "an option code", seed: {}, body: { code: "R2" }, status: 200, after: { status: "answered", answer: { code: "R2", text: null } } },
      { name: "a code and free text", seed: {}, body: { code: "R1", text: "and keep it partial" }, status: 200, after: { status: "answered", answer: { code: "R1", text: "and keep it partial" } } },
      { name: "a code that is not an option", seed: {}, body: { code: "R3" }, status: 400, after: { status: "open", answer: unanswered } },
      { name: "free text when the item forbids it", seed: { isFreeTextAllowed: false }, body: { text: "my own idea" }, status: 400, after: { status: "open", answer: unanswered } },
      { name: "neither code nor text", seed: {}, body: {}, status: 400, after: { status: "open", answer: unanswered } },
      { name: "an unknown key", seed: {}, body: { code: "R1", sessionId }, status: 400, after: { status: "open", answer: unanswered } },
      { name: "an item already answered", seed: { status: "answered" as const }, body: { code: "R1" }, status: 409, after: { status: "answered", answer: unanswered } },
    ];
    for (const row of rows) {
      const itemId = await seedDecision(sessionId, row.seed);
      const response = await send("POST", `/api/queue/owner/items/${itemId}/answer`, row.body);
      assert.equal(response.statusCode, row.status, `${row.name}: ${response.body}`);
      const item = await getItemRow(itemId);
      assert.deepEqual({ status: item.status, answer: { code: item.answerCode, text: item.answerText } }, row.after, row.name);
      assert.equal(item.answeredAt !== null, row.status === 200, `${row.name}: answeredAt set only on acceptance`);
    }
  });

  test("an answer to a report and a reply to a decision are refused", async () => {
    const sessionId = await seedSession();
    const report = await seedItem(sessionId);
    const decision = await seedDecision(sessionId);
    const answer = await send("POST", `/api/queue/owner/items/${report}/answer`, { text: "ok" });
    const reply = await send("POST", `/api/queue/owner/items/${decision}/reply`, { text: "ok" });
    assert.equal(answer.statusCode, 409, answer.body);
    assert.equal(reply.statusCode, 409, reply.body);
    assert.equal((await getItemRow(report)).status, "open");
    assert.equal((await getItemRow(decision)).status, "open");
  });

  test("a reply answers an open report with its text, Seen closes it, and neither works twice", async () => {
    const sessionId = await seedSession();
    const replied = await seedItem(sessionId);
    const seen = await seedItem(sessionId);
    assert.equal((await send("POST", `/api/queue/owner/items/${replied}/reply`, { text: "Thanks, merge it." })).statusCode, 200);
    assert.equal((await send("POST", `/api/queue/owner/items/${seen}/seen`)).statusCode, 200);
    const repliedRow = await getItemRow(replied);
    assert.deepEqual([repliedRow.status, repliedRow.answerText], ["answered", "Thanks, merge it."]);
    assert.equal((await getItemRow(seen)).status, "seen");
    assert.equal((await send("POST", `/api/queue/owner/items/${replied}/reply`, { text: "again" })).statusCode, 409);
    assert.equal((await send("POST", `/api/queue/owner/items/${seen}/seen`)).statusCode, 409);
  });

  test("a reply on a report that forbids free text is refused", async () => {
    const itemId = await seedItem(await seedSession(), { isFreeTextAllowed: false });
    const response = await send("POST", `/api/queue/owner/items/${itemId}/reply`, { text: "noted" });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal((await getItemRow(itemId)).status, "open");
  });

  test("an unknown item id answers 404 and a malformed one 400", async () => {
    assert.equal((await send("POST", "/api/queue/owner/items/999999999999/seen")).statusCode, 404);
    assert.equal((await send("POST", "/api/queue/owner/items/abc/seen")).statusCode, 400);
    assert.equal((await send("GET", "/api/queue/owner/items/999999999999")).statusCode, 404);
  });
});

describe("later", () => {
  test("Later moves an open report to the end of the queue and counts the deferral", async () => {
    const sessionId = await seedSession();
    const report = await seedItem(sessionId);
    const newer = await seedDecision(sessionId);
    const response = await send("POST", `/api/queue/owner/items/${report}/later`);
    assert.equal(response.statusCode, 200, response.body);
    const [reportRow, newerRow] = [await getItemRow(report), await getItemRow(newer)];
    assert.ok(reportRow.queuePosition > newerRow.queuePosition, "moved behind an item posted after it");
    assert.equal(reportRow.deferCount, 1);
    assert.equal(reportRow.status, "open");
  });

  test("two concurrent Later clicks get distinct positions behind every earlier item", async () => {
    const sessionId = await seedSession();
    const [first, second] = [await seedDecision(sessionId), await seedItem(sessionId)];
    const marker = await seedItem(sessionId);
    const responses = await Promise.all([first, second].map((id) => send("POST", `/api/queue/owner/items/${id}/later`)));
    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
    const positions = [(await getItemRow(first)).queuePosition, (await getItemRow(second)).queuePosition];
    const markerPosition = (await getItemRow(marker)).queuePosition;
    assert.notEqual(positions[0], positions[1]);
    assert.ok(positions.every((position) => position > markerPosition), "both behind the last earlier item");
  });

  test("Later on an item that is no longer open is refused", async () => {
    const itemId = await seedDecision(await seedSession(), { status: "answered" });
    assert.equal((await send("POST", `/api/queue/owner/items/${itemId}/later`)).statusCode, 409);
  });
});

describe("resend", () => {
  test("Resend moves an unacked, expired or used resume-pending item to answered with the next attempt and no Delivery row", async () => {
    const sessionId = await seedSession({ state: "exited", exitReason: "dead" });
    const rows = [
      { name: "unacked", status: "unacked" as const, resumeAttempt: null },
      { name: "expired", status: "expired" as const, resumeAttempt: null },
      { name: "resume-pending with a resume row for its current attempt", status: "resume_pending" as const, resumeAttempt: 2 },
    ];
    for (const row of rows) {
      const itemId = await seedDecision(sessionId, { status: row.status, nextAttempt: 2, answerCode: "R1", answeredAt: new Date() });
      if (row.resumeAttempt !== null) await seedResumeDelivery(itemId, row.resumeAttempt);
      const before = await countDeliveries(itemId);
      const response = await send("POST", `/api/queue/owner/items/${itemId}/resend`);
      assert.equal(response.statusCode, 200, `${row.name}: ${response.body}`);
      const item = await getItemRow(itemId);
      assert.deepEqual([item.status, item.nextAttempt], ["answered", 3], row.name);
      assert.equal(await countDeliveries(itemId), before, `${row.name}: no Delivery row`);
    }
  });

  test("Resend is refused with a conflict and changes nothing when its conditions do not hold", async () => {
    const rows = [
      { name: "resume-pending with no resume row for the current attempt", marked: false, status: "resume_pending" as const, resumeAttempt: 1 },
      { name: "marked session, resume-pending with a used attempt", marked: true, status: "resume_pending" as const, resumeAttempt: 2 },
      { name: "marked session, unacked", marked: true, status: "unacked" as const, resumeAttempt: null },
      { name: "an answered item", marked: false, status: "answered" as const, resumeAttempt: null },
    ];
    for (const row of rows) {
      const sessionId = await seedSession({ state: "exited", exitReason: "dead", resumeAwaitingRegisterAt: row.marked ? new Date() : null });
      const itemId = await seedDecision(sessionId, { status: row.status, nextAttempt: 2, answerCode: "R1", answeredAt: new Date() });
      if (row.resumeAttempt !== null) await seedResumeDelivery(itemId, row.resumeAttempt);
      const before = { item: await getItemRow(itemId), deliveries: await countDeliveries(itemId) };
      const response = await send("POST", `/api/queue/owner/items/${itemId}/resend`);
      assert.equal(response.statusCode, 409, `${row.name}: ${response.body}`);
      const item = await getItemRow(itemId);
      assert.deepEqual([item.status, item.nextAttempt], [before.item.status, before.item.nextAttempt], row.name);
      assert.equal(await countDeliveries(itemId), before.deliveries, row.name);
    }
  });
});

describe("list and item detail", () => {
  test("the list carries awaiting items in queue order with account, session and the canResend flag, filtered by account", async () => {
    const profileLabel = `.claude-p${randomUUID().slice(0, 6)}`;
    const sessionId = await seedSession({ profileLabel, isConfigDirSet: true, configDir: `/Users/owner/${profileLabel}`, launchHint: "accept_wrapper" });
    const first = await seedItem(sessionId);
    const second = await seedDecision(sessionId, { status: "unacked", answerCode: "R1", answeredAt: new Date() });
    await seedItem(sessionId, { status: "delivered" });
    const response = await send("GET", `/api/queue/owner/items?profile=${encodeURIComponent(profileLabel)}`);
    assert.equal(response.statusCode, 200, response.body);
    const items = response.json().items as Array<Record<string, any>>;
    assert.deepEqual(items.map((item) => item.id), [Number(first), Number(second)], "non-terminal items only, queue order");
    assert.deepEqual(items[0]?.session, {
      id: sessionId,
      profileLabel,
      cwd: "/Users/owner/Desktop/git/glass-atrium/monitor",
      cwdTail: "glass-atrium/monitor",
      configDir: `/Users/owner/${profileLabel}`,
      state: "live",
      launchHint: "accept_wrapper",
      permissionHint: null,
      marker: null,
    });
    assert.deepEqual(items.map((item) => [item.deviation, item.canResend]), [[null, false], ["unacked", true]]);
  });

  test("the list filters by session id and rejects unknown filters", async () => {
    const [mine, other] = [await seedSession(), await seedSession()];
    const itemId = await seedItem(mine);
    await seedItem(other);
    const response = await send("GET", `/api/queue/owner/items?sessionId=${mine}`);
    assert.deepEqual((response.json().items as Array<{ id: number }>).map((item) => item.id), [Number(itemId)]);
    assert.equal((await send("GET", "/api/queue/owner/items?colour=red")).statusCode, 400);
  });

  test("paging with nextCursor returns every awaiting item exactly once, in queue order", async () => {
    const profileLabel = `.claude-page${randomUUID().slice(0, 6)}`;
    const sessionId = await seedSession({ profileLabel });
    const seeded = [await seedItem(sessionId), await seedItem(sessionId), await seedItem(sessionId)].map(Number);
    const listUrl = `/api/queue/owner/items?profile=${encodeURIComponent(profileLabel)}&limit=2`;
    const first = (await send("GET", listUrl)).json() as { items: Array<{ id: number }>; nextCursor: number | null };
    assert.ok(first.nextCursor !== null, "a full page announces a next page");
    const second = (await send("GET", `${listUrl}&after=${first.nextCursor}`)).json() as { items: Array<{ id: number }>; nextCursor: number | null };
    assert.deepEqual([...first.items, ...second.items].map((item) => item.id), seeded);
    assert.equal(second.nextCursor, null, "the last page announces none");
  });

  test("an answered item's deviation follows its session's reachability and the drift guard's switch", async () => {
    const rows = [
      { name: "live with a socket", session: { state: "live" as const }, isOn: true, deviation: null },
      { name: "stale with a socket", session: { state: "stale" as const }, isOn: true, deviation: "session_not_reachable" },
      { name: "live with no socket", session: { state: "live" as const, socketPath: null }, isOn: true, deviation: "delivery_off" },
      { name: "stale with no socket", session: { state: "stale" as const, socketPath: null }, isOn: true, deviation: "delivery_off" },
      { name: "exited with a socket", session: { state: "exited" as const, exitReason: "dead" as const }, isOn: true, deviation: null },
      { name: "live with a socket, delivery degraded", session: { state: "live" as const }, isOn: false, deviation: "delivery_off" },
      { name: "stale with a socket, delivery degraded", session: { state: "stale" as const }, isOn: false, deviation: "delivery_off" },
      { name: "exited with a socket, delivery degraded", session: { state: "exited" as const, exitReason: "dead" as const }, isOn: false, deviation: null },
    ];
    try {
      for (const row of rows) {
        setSocketDeliveryOn(row.isOn);
        const itemId = await seedDecision(await seedSession(row.session), { status: "answered", answerCode: "R1", answeredAt: new Date() });
        const detail = (await send("GET", `/api/queue/owner/items/${itemId}`)).json();
        assert.equal(detail.deviation, row.deviation, row.name);
      }
    } finally {
      setSocketDeliveryOn(false);
    }
  });

  test("the list carries the drift guard's socket delivery switch for the degraded banner", async () => {
    const seen: boolean[] = [];
    try {
      for (const isOn of [true, false]) {
        setSocketDeliveryOn(isOn);
        seen.push((await send("GET", "/api/queue/owner/items?limit=1")).json().isSocketDeliveryOn);
      }
    } finally {
      setSocketDeliveryOn(false);
    }

    assert.deepEqual(seen, [true, false]);
  });

  test("a resume-pending item carries its resume rows and the first skip reason by card precedence", async () => {
    const root = `/Users/owner/Desktop/git/wt-skip-${randomUUID().slice(0, 8)}`;
    const exited = { state: "exited" as const, exitReason: "dead" as const };
    const marked = { ...exited, resumeAwaitingRegisterAt: new Date() };
    const cases = [
      { name: "marker set beats approval", session: marked, item: { isApprovalClass: true }, used: false, hasOccupant: false, hasResumeInFlight: false, kind: "marker" },
      { name: "approval beats a used attempt", session: exited, item: { isApprovalClass: true }, used: true, hasOccupant: false, hasResumeInFlight: false, kind: "approval" },
      { name: "a used attempt beats a shared worktree", session: exited, item: {}, used: true, hasOccupant: true, hasResumeInFlight: false, kind: "resume_used" },
      { name: "a shared worktree beats a resume in flight", session: exited, item: {}, used: false, hasOccupant: true, hasResumeInFlight: true, kind: "shared_worktree" },
      { name: "a resume in flight for another item of the session", session: exited, item: {}, used: false, hasOccupant: false, hasResumeInFlight: true, kind: "in_flight" },
      { name: "nothing blocks the next sweep", session: exited, item: {}, used: false, hasOccupant: false, hasResumeInFlight: false, kind: null },
    ];
    for (const [index, row] of cases.entries()) {
      const worktreeRoot = `${root}-${index}`;
      const sessionId = await seedSession({ ...row.session, worktreeRoot });
      if (row.hasOccupant) await seedSession({ state: "live", worktreeRoot });
      if (row.hasResumeInFlight) await seedResumeDelivery(await seedDecision(sessionId, { status: "delivering", answerCode: "R2", answeredAt: new Date() }), 1);
      const itemId = await seedDecision(sessionId, { status: "resume_pending", answerCode: "R1", answeredAt: new Date(), ...row.item });
      if (row.used) await seedResumeDelivery(itemId, 1, "bg42");
      const detail = (await send("GET", `/api/queue/owner/items/${itemId}`)).json();
      assert.equal(detail.skipReason?.kind ?? null, row.kind, row.name);
      assert.deepEqual(detail.resumes.map((resume: { attempt: number; result: string }) => [resume.attempt, resume.result]), row.used ? [[1, "sent"]] : [], row.name);
    }
  });

  test("a shared-worktree skip names each marked occupant and flags the unmarked ones", async () => {
    const root = `/Users/owner/Desktop/git/wt-shared-${randomUUID().slice(0, 8)}`;
    const waiting = await seedSession({ state: "exited", exitReason: "dead", worktreeRoot: root });
    const marked = await seedSession({ state: "exited", exitReason: "dead", worktreeRoot: root, profileLabel: ".claude-work", cwd: `${root}/hooks`, resumeAwaitingRegisterAt: new Date() });
    const itemId = await seedDecision(waiting, { status: "resume_pending", answerCode: "R1", answeredAt: new Date() });
    const markedOnly = (await send("GET", `/api/queue/owner/items/${itemId}`)).json();
    assert.deepEqual(markedOnly.skipReason, {
      kind: "shared_worktree",
      markedOccupants: [{ profileLabel: ".claude-work", cwdTail: `${path.basename(root)}/hooks`, sessionIdPrefix: marked.slice(0, 8) }],
      hasUnmarkedOccupant: false,
    });
    await seedSession({ state: "live", worktreeRoot: root });
    const mixed = (await send("GET", `/api/queue/owner/items/${itemId}`)).json();
    assert.equal(mixed.skipReason.markedOccupants.length, 1);
    assert.equal(mixed.skipReason.hasUnmarkedOccupant, true);
  });

  test("the list names the installed queue CLI the pull command runs", async () => {
    assert.equal((await send("GET", "/api/queue/owner/items?limit=1")).json().cliPath, CLI_PATH);
  });

  test("the CLI path follows GA_ROOT, so a non-default install shows its own path", () => {
    const saved = process.env.GA_ROOT;
    process.env.GA_ROOT = "/Volumes/tools/atrium";
    try {
      assert.equal(resolveQueueRouteOptions().cliPath, "/Volumes/tools/atrium/scripts/atrium-queue.sh");
    } finally {
      if (saved === undefined) delete process.env.GA_ROOT;
      else process.env.GA_ROOT = saved;
    }
  });

  test("an item of a marked session carries the marker with the bg id of the spawn that set it", async () => {
    const sessionId = await seedSession({ state: "exited", exitReason: "dead", resumeAwaitingRegisterAt: new Date() });
    const resumed = await seedDecision(sessionId, { status: "delivering", answerCode: "R1", answeredAt: new Date() });
    await seedResumeDelivery(resumed, 1, "abc123");
    const unacked = await seedDecision(sessionId, { status: "unacked", answerCode: "R2", answeredAt: new Date() });
    const detail = (await send("GET", `/api/queue/owner/items/${unacked}`)).json();
    assert.equal(detail.session.marker.bgId, "abc123");
    assert.equal(detail.canResend, false, "no Resend while the marker is set");
  });
});

describe("recent automatic resumes", () => {
  test("lists resume rows newest first with item and account, keeping a resume whose item was delivered", async () => {
    const sessionId = await seedSession({ state: "exited", exitReason: "dead", profileLabel: ".claude-work", cwd: "/Users/owner/Desktop/git/atrium/hooks" });
    const delivered = await seedDecision(sessionId, { title: "Pick the index", status: "delivered", answerCode: "R1", answeredAt: new Date(), deliveredAt: new Date() });
    await seedResumeDelivery(delivered, 1, "bg-41", { result: "acked" });
    const pending = await seedDecision(sessionId, { title: "Pick the lock order", status: "resume_pending", answerCode: "R2", answeredAt: new Date() });
    await seedResumeDelivery(pending, 1, null, { result: "aborted", abortReason: "session_returned" });
    const response = await send("GET", "/api/queue/owner/resumes?limit=2");
    assert.equal(response.statusCode, 200, response.body);
    const session = { profileLabel: ".claude-work", cwdTail: "atrium/hooks" };
    const resumes = (response.json().resumes as Array<Record<string, unknown>>).map(({ sentAt: _sentAt, ...rest }) => rest);
    assert.deepEqual(resumes, [
      { attempt: 1, result: "aborted", abortReason: "session_returned", bgId: null, item: { id: Number(pending), title: "Pick the lock order" }, session },
      { attempt: 1, result: "acked", abortReason: null, bgId: "bg-41", item: { id: Number(delivered), title: "Pick the index" }, session },
    ]);
  });

  test("socket and pull rows stay off the resume record", async () => {
    const itemId = await seedDecision(await seedSession(), { status: "unacked", answerCode: "R1", answeredAt: new Date() });
    const sentAt = new Date();
    await getPrisma().queueDelivery.create({
      data: { msgId: randomUUID(), itemId, route: "socket", attempt: 1, result: "expired", sentAt, ackDeadlineAt: new Date(sentAt.getTime() + ACK_DEADLINE_MS) },
    });
    const items = (await send("GET", "/api/queue/owner/resumes?limit=50")).json().resumes as Array<{ item: { id: number } }>;
    assert.equal(items.some((resume) => resume.item.id === Number(itemId)), false);
  });

  test("the record needs an owner session and a bounded limit", async () => {
    assert.equal((await send("GET", "/api/queue/owner/resumes", undefined, { cookie: null })).statusCode, 401);
    assert.equal((await send("GET", "/api/queue/owner/resumes?limit=51")).statusCode, 400);
  });
});
