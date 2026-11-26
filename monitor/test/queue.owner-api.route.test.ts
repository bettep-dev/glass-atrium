// Owner queue API (/api/queue/owner/*): page-origin leg, list and item detail, answer, later, seen, reply, resend.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/queue.owner-api.route.test.ts

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import "dotenv/config";

import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import { Client } from "pg";

import type { Prisma } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerAuditLogHook } from "../src/server/middleware/audit-log.js";
import { SECRET_APPROVAL_CODE } from "../src/server/queue/items.js";
import { RELAY_REDACTION_MARKER } from "../src/server/queue/owner-items.js";
import { SECRET_REQUEST_LIMIT, getLineHash, secretRequests } from "../src/server/queue/scan-approvals.js";
import { registerQueueRoutes, resolveQueueRouteOptions } from "../src/server/routes/queue.js";
import { deleteDirectory } from "./lib/remove-dir.js";
import { lockQueueRows, unlockQueueRows } from "./lib/queue-rows-lock.js";

const PORT = 16145;
const CLI_PATH = "/opt/atrium-test/scripts/atrium-queue.sh";
const HOST = `127.0.0.1:${PORT}`;
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" } as const;
const ACK_DEADLINE_MS = 120_000;

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "queue-owner-api-"));
const trackedSessionIds: string[] = [];
const suiteStart = new Date();
let app: FastifyInstance;

before(async () => {
  await lockQueueRows();
  app = await buildApp();
});

after(async () => {
  await app.close();
  const prisma = getPrisma();
  await prisma.queueDelivery.deleteMany({ where: { item: { sessionId: { in: trackedSessionIds } } } });
  await prisma.queueItem.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await prisma.queueSession.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await prisma.auditLog.deleteMany({ where: { actionKind: { in: ["queue-relay.relay", "queue-relay.redact"] }, eventTs: { gte: suiteStart } } });
  await unlockQueueRows();
  await disconnectPrisma();
  deleteDirectory(fixtureRoot);
});

async function buildApp(isAudited = false): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await registerQueueRoutes(instance, { port: PORT, homeDir: path.join(fixtureRoot, "home"), cliPath: CLI_PATH, imageDir: path.join(fixtureRoot, "images"), scannerPath: "/opt/atrium-test/scripts/lib/secret-scan.sh" });
  if (isAudited) registerAuditLogHook(instance);
  await instance.ready();
  return instance;
}

interface SendOptions {
  host?: string;
  /** Replaces the default same-origin fetch metadata; `{}` sends neither page-origin header. */
  headers?: Record<string, string>;
}

function send(method: "GET" | "POST", url: string, body?: object, options: SendOptions = {}): Promise<LightMyRequestResponse> {
  const headers = { host: options.host ?? HOST, ...(options.headers ?? SAME_ORIGIN) };
  return app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body }) });
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
      socketPath: null,
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

describe("page origin", () => {
  test("an owner mutation is accepted only from the monitor's own page", async () => {
    const sessionId = await seedSession();
    const rows: Array<{ name: string; headers: Record<string, string>; status: number }> = [
      { name: "fetch metadata same-origin", headers: { "sec-fetch-site": "same-origin" }, status: 200 },
      { name: "Origin only, 127.0.0.1 at the monitor port", headers: { origin: `http://127.0.0.1:${PORT}` }, status: 200 },
      { name: "Origin only, localhost at the monitor port", headers: { origin: `http://localhost:${PORT}` }, status: 200 },
      { name: "Origin only, [::1] at the monitor port", headers: { origin: `http://[::1]:${PORT}` }, status: 200 },
      { name: "neither header", headers: {}, status: 403 },
      { name: "fetch metadata cross-site", headers: { "sec-fetch-site": "cross-site" }, status: 403 },
      { name: "fetch metadata same-site", headers: { "sec-fetch-site": "same-site" }, status: 403 },
      { name: "fetch metadata none (address bar)", headers: { "sec-fetch-site": "none" }, status: 403 },
      { name: "a foreign Origin", headers: { origin: "https://evil.example" }, status: 403 },
      { name: "a loopback Origin on another port", headers: { origin: `http://127.0.0.1:${PORT + 1}` }, status: 403 },
      { name: "a loopback Origin over https", headers: { origin: `https://127.0.0.1:${PORT}` }, status: 403 },
      { name: "the opaque Origin null", headers: { origin: "null" }, status: 403 },
    ];
    for (const row of rows) {
      const itemId = await seedDecision(sessionId);
      const response = await send("POST", `/api/queue/owner/items/${itemId}/answer`, { code: "R1" }, { headers: row.headers });
      assert.equal(response.statusCode, row.status, `${row.name}: ${response.body}`);
      assert.equal((await getItemRow(itemId)).status, row.status === 200 ? "answered" : "open", row.name);
    }
  });

  test("every owner mutation route refuses a request with neither page-origin header", async () => {
    const sessionId = await seedSession({ state: "exited", exitReason: "dead" });
    const rows = [
      { action: "answer", itemId: await seedDecision(sessionId), body: { code: "R1" } },
      { action: "reply", itemId: await seedItem(sessionId), body: { text: "merge it" } },
      { action: "seen", itemId: await seedItem(sessionId), body: undefined },
      { action: "later", itemId: await seedItem(sessionId), body: undefined },
      { action: "resend", itemId: await seedDecision(sessionId, { status: "unacked", answerCode: "R1", answeredAt: new Date() }), body: undefined },
    ];
    for (const row of rows) {
      const before = await getItemRow(row.itemId);
      const response = await send("POST", `/api/queue/owner/items/${row.itemId}/${row.action}`, row.body, { headers: {} });
      assert.equal(response.statusCode, 403, `${row.action}: ${response.body}`);
      const item = await getItemRow(row.itemId);
      assert.deepEqual([item.status, item.queuePosition, item.nextAttempt], [before.status, before.queuePosition, before.nextAttempt], row.action);
    }
  });

  test("owner reads need no sign-in and no page-origin header", async () => {
    assert.equal((await send("GET", "/api/queue/owner/items?limit=1", undefined, { headers: {} })).statusCode, 200);
  });

  test("a foreign Host is refused on owner and session routes even with same-origin fetch metadata", async () => {
    const itemId = await seedDecision(await seedSession());
    const rows = [
      { name: "owner mutation", method: "POST" as const, url: `/api/queue/owner/items/${itemId}/answer`, body: { code: "R1" } },
      { name: "owner read", method: "GET" as const, url: "/api/queue/owner/items", body: undefined },
      { name: "session route", method: "POST" as const, url: "/api/queue/pending", body: { sessionId: randomUUID() } },
    ];
    for (const row of rows) {
      const response = await send(row.method, row.url, row.body, { host: `evil.example:${PORT}` });
      assert.equal(response.statusCode, 403, `${row.name}: ${response.body}`);
    }
    assert.equal((await getItemRow(itemId)).status, "open");
  });

  test("the sign-in routes no longer exist", async () => {
    const rows = [
      { method: "POST" as const, url: "/api/queue/owner/login", body: { passphrase: "owner passphrase" } },
      { method: "POST" as const, url: "/api/queue/owner/logout", body: {} },
      { method: "GET" as const, url: "/api/queue/owner/session", body: undefined },
    ];
    for (const row of rows) {
      assert.equal((await send(row.method, row.url, row.body)).statusCode, 404, row.url);
    }
  });
});

describe("request validation", () => {
  // a key name may be text the caller wrote → a refusal never repeats it
  test("every owner route answers an unknown key without its name", async () => {
    const itemId = await seedDecision(await seedSession());
    const key = `unknownkey${randomUUID().replaceAll("-", "")}`;
    const rows = [
      { route: `GET /api/queue/owner/items?${key}=1`, body: undefined },
      { route: `GET /api/queue/owner/items/${itemId}?${key}=1`, body: undefined },
      { route: `GET /api/queue/owner/items/${itemId}/scan-approval?${key}=1`, body: undefined },
      { route: `GET /api/queue/owner/resumes?${key}=1`, body: undefined },
      { route: `GET /api/queue/owner/orders?kind=item&${key}=1`, body: undefined },
      { route: `GET /api/queue/owner/sessions?${key}=1`, body: undefined },
      { route: `POST /api/queue/owner/items/${itemId}/redact`, body: {} },
      { route: `POST /api/queue/owner/items/${itemId}/answer`, body: { code: "R1" } },
      { route: `POST /api/queue/owner/items/${itemId}/reply`, body: { text: "Hold it." } },
      { route: `POST /api/queue/owner/items/${itemId}/later`, body: {} },
      { route: `POST /api/queue/owner/items/${itemId}/seen`, body: {} },
      { route: `POST /api/queue/owner/items/${itemId}/resend`, body: {} },
      { route: "POST /api/queue/owner/messages/send", body: { sessionIds: [randomUUID()], text: "Rebase onto main." } },
      { route: `POST /api/queue/owner/images?name=shot.png&${key}=1`, body: {} },
    ];
    const replies = [];
    for (const row of rows) {
      const [method, url] = row.route.split(" ") as ["GET" | "POST", string];
      const isQueryKey = url.includes(key);
      const response = await send(method, url, row.body === undefined || isQueryKey ? row.body : { ...row.body, [key]: 1 });
      replies.push([row.route, response.statusCode, response.json().error, response.body.includes(key)]);
    }
    assert.deepEqual(replies, rows.map((row) => [row.route, 400, "invalid_input", false]));
    assert.equal((await getItemRow(itemId)).status, "open");
  });
});

describe("answer record", () => {
  test("an answer and a reply stamp the route and the page-origin signal in the same write as the answer", async () => {
    const sessionId = await seedSession();
    const rows = [
      { name: "answer, fetch metadata", itemId: await seedDecision(sessionId), action: "answer", body: { code: "R1" }, headers: SAME_ORIGIN, route: "answer", signal: "fetch_metadata" },
      { name: "answer, Origin only", itemId: await seedDecision(sessionId), action: "answer", body: { code: "R2" }, headers: { origin: `http://localhost:${PORT}` }, route: "answer", signal: "origin" },
      { name: "reply, fetch metadata", itemId: await seedItem(sessionId), action: "reply", body: { text: "merge it" }, headers: SAME_ORIGIN, route: "reply", signal: "fetch_metadata" },
      { name: "reply, Origin only", itemId: await seedItem(sessionId), action: "reply", body: { text: "hold it" }, headers: { origin: `http://127.0.0.1:${PORT}` }, route: "reply", signal: "origin" },
    ];
    for (const row of rows) {
      const response = await send("POST", `/api/queue/owner/items/${row.itemId}/${row.action}`, row.body, { headers: row.headers });
      assert.equal(response.statusCode, 200, `${row.name}: ${response.body}`);
      const item = await getItemRow(row.itemId);
      assert.deepEqual([item.status, item.answerRoute, item.answerSignal], ["answered", row.route, row.signal], row.name);
      assert.ok(item.answeredAt !== null, `${row.name}: answered time set`);
    }
  });

  test("a refused answer leaves no stamp", async () => {
    const itemId = await seedDecision(await seedSession());
    await send("POST", `/api/queue/owner/items/${itemId}/answer`, { code: "R9" });
    const item = await getItemRow(itemId);
    assert.deepEqual([item.status, item.answerRoute, item.answerSignal], ["open", null, null]);
  });

  test("the item view carries the record and flags an answered item with no stamp as answered outside the Queue page", async () => {
    const sessionId = await seedSession({ state: "exited", exitReason: "dead" });
    const answeredAt = new Date("2026-11-12T04:05:06.789Z");
    const stamped = { answerCode: "R1", answeredAt, answerRoute: "answer" as const, answerSignal: "fetch_metadata" as const };
    const unstamped = { answerCode: "R1", answeredAt };
    const rows = [
      { name: "stamped answered", seed: { status: "answered" as const, ...stamped }, record: { route: "answer", signal: "fetch_metadata" }, isOutside: false },
      { name: "backfilled before the record", seed: { status: "unacked" as const, ...stamped, answerSignal: "before_record" as const }, record: { route: "answer", signal: "before_record" }, isOutside: false },
      ...(["answered", "delivering", "unacked", "held", "expired", "resume_pending", "delivered"] as const).map((status) => (
        { name: `unstamped ${status}`, seed: { status, ...unstamped }, record: null, isOutside: true }
      )),
      { name: "open, never answered", seed: { status: "open" as const }, record: null, isOutside: false },
      { name: "withdrawn by its session", seed: { status: "withdrawn" as const }, record: null, isOutside: false },
    ];
    for (const row of rows) {
      const itemId = await seedDecision(sessionId, row.seed);
      const detail = (await send("GET", `/api/queue/owner/items/${itemId}`)).json();
      assert.deepEqual([detail.answerRecord, detail.isAnsweredOutside], [row.record, row.isOutside], row.name);
    }
  });

  test("a relay, answered by its sender on insert, is never flagged as answered outside in any state", async () => {
    const [recipient, sender] = [await seedSession(), await seedSession()];
    for (const status of ["answered", "delivering", "unacked", "held", "expired", "delivered", "withdrawn"] as const) {
      const relayId = await seedItem(recipient, {
        kind: "relay", fromSessionId: sender, relayHop: 0, sendId: randomUUID(), title: "Rebased feature/queue-mcp onto main", body: "The relay suite is green.",
        isFreeTextAllowed: false, status, relayClosedAt: status === "withdrawn" ? new Date() : null,
      });
      const detail = (await send("GET", `/api/queue/owner/items/${relayId}`)).json();
      assert.deepEqual([detail.answerRecord, detail.isAnsweredOutside], [null, false], status);
    }
  });

  test("a report closed with Seen carries no answer and is never flagged as answered outside", async () => {
    const itemId = await seedItem(await seedSession());
    await send("POST", `/api/queue/owner/items/${itemId}/seen`);
    const detail = (await send("GET", `/api/queue/owner/items/${itemId}`)).json();
    assert.deepEqual([detail.status, detail.answerRecord, detail.isAnsweredOutside], ["seen", null, false]);
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

describe("scan-approval answer and withdraw", () => {
  interface PostedApproval {
    sessionId: string;
    requestId: string;
    itemId: number;
    /** The captured line's text, unique per request → its absence from a response is checkable. */
    line: string;
  }

  const writePath = "/Users/owner/Desktop/git/glass-atrium/monitor/src/server/config.ts";

  /** A request as the hook registers it, and its item as the session's secret-approval post creates it. */
  const postApproval = async (): Promise<PostedApproval> => {
    const sessionId = await seedSession();
    const line = `sentinel_${randomUUID().replaceAll("-", "")} = 3`;
    const requestId = secretRequests.create({
      sessionId,
      agent: { id: "a3f9c2d17b4e8f05", type: "glass-atrium-dev-node" },
      path: writePath,
      rule: "SEC-013",
      lines: [{ text: line, hash: getLineHash(line) }],
    });
    const posted = await send("POST", "/api/queue/items", { kind: "secret-approval", sessionId, requestId }, { headers: {} });
    assert.equal(posted.statusCode, 201, posted.body);
    return { sessionId, requestId, itemId: posted.json().id, line };
  };
  const answer = (itemId: number, code: string) => send("POST", `/api/queue/owner/items/${itemId}/answer`, { code });
  /** The hook's retry of the refused write: same session, path and rule, the captured line's hash. */
  const consumeWrite = (posted: PostedApproval) => secretRequests.consume({ sessionId: posted.sessionId, path: writePath, rule: "SEC-013", hashes: [getLineHash(posted.line)] });

  /** An approve answered while another connection holds the item row; `whileWaiting` runs once the answer waits on it. */
  const approveAgainstHeldRow = async (itemId: number, whileWaiting: (blocker: Client) => Promise<void>): Promise<LightMyRequestResponse> => {
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT 1 FROM "monitor"."queue_items" WHERE "id" = $1 FOR UPDATE`, [itemId]);
      const answering = answer(itemId, SECRET_APPROVAL_CODE.APPROVE);
      await waitForBlockedBackend(blocker);
      await whileWaiting(blocker);
      await blocker.query("COMMIT");
      return await answering;
    } finally {
      await blocker.end();
    }
  };

  test("the owner's approve turns the request approved for exactly ten minutes from the recorded yes, its line removed and its hash kept", async () => {
    const { requestId, itemId, line } = await postApproval();
    const response = await answer(itemId, SECRET_APPROVAL_CODE.APPROVE);
    const item = await getItemRow(BigInt(itemId));
    const request = secretRequests.find(requestId);
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(item.answeredAt !== null && request !== null, "approve recorded no answer or kept no request");
    assert.deepEqual([item.answerCode, request.state, request.hashes, secretRequests.findLines(requestId)], [SECRET_APPROVAL_CODE.APPROVE, "approved", [getLineHash(line)], null]);
    assert.equal(request.expiresAt.getTime() - item.answeredAt.getTime(), SECRET_REQUEST_LIMIT.APPROVED_MS);
    assert.ok(!response.body.includes(line), "the approve response echoes the captured line");
  });

  test("a write retried while the approve's answer waits on the item row is refused; once the answer commits it passes", async () => {
    const posted = await postApproval();
    let waitingConsume: string | null = "not run";
    const response = await approveAgainstHeldRow(posted.itemId, async () => {
      waitingConsume = consumeWrite(posted);
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual([waitingConsume, consumeWrite(posted)], [null, posted.requestId]);
  });

  test("a request that leaves the store while the approve's answer waits keeps the recorded answer and approves nothing", async () => {
    const posted = await postApproval();
    const response = await approveAgainstHeldRow(posted.itemId, async () => {
      secretRequests.delete(posted.requestId);
    });
    const item = await getItemRow(BigInt(posted.itemId));
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual([item.status, item.answerCode, secretRequests.find(posted.requestId), consumeWrite(posted)], ["answered", SECRET_APPROVAL_CODE.APPROVE, null, null]);
  });

  test("the owner's decline records the answer and removes the request", async () => {
    const { requestId, itemId } = await postApproval();
    const response = await answer(itemId, SECRET_APPROVAL_CODE.DECLINE);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual([(await getItemRow(BigInt(itemId))).answerCode, secretRequests.find(requestId)], [SECRET_APPROVAL_CODE.DECLINE, null]);
  });

  test("an approve of a request no longer in the store is a conflict that records no answer and carries ids only; the item still takes a decline", async () => {
    const { requestId, itemId, line } = await postApproval();
    secretRequests.delete(requestId);
    const refused = await answer(itemId, SECRET_APPROVAL_CODE.APPROVE);
    const item = await getItemRow(BigInt(itemId));
    assert.deepEqual([refused.statusCode, refused.json().error, item.status, item.answerCode], [409, "secret_request_gone", "open", null]);
    assert.ok(!refused.body.includes(line), "the conflict response echoes the captured line");
    assert.equal((await answer(itemId, SECRET_APPROVAL_CODE.DECLINE)).statusCode, 200);
  });

  test("an approve whose answer write loses to a concurrent close approves nothing: the request stays pending", async () => {
    const { requestId, itemId } = await postApproval();
    const response = await approveAgainstHeldRow(itemId, async (blocker) => {
      await blocker.query(`UPDATE "monitor"."queue_items" SET "status" = 'withdrawn' WHERE "id" = $1`, [itemId]);
    });
    assert.deepEqual([response.statusCode, response.json().error, secretRequests.find(requestId)?.state], [409, "not_open", "pending"]);
  });

  test("the owner list, done thread and item detail carry a scan approval's path, rule, agent type and request id while the store holds it, all null once gone; never a line, a hash, the session id or the agent id", async () => {
    const pending = await postApproval();
    const approved = await postApproval();
    await answer(approved.itemId, SECRET_APPROVAL_CODE.APPROVE);
    const gone = await postApproval();
    await answer(gone.itemId, SECRET_APPROVAL_CODE.APPROVE);
    assert.equal(consumeWrite(gone), gone.requestId);
    const plainSessionId = await seedSession();
    const plainItemId = Number(await seedDecision(plainSessionId));
    const getHeldFacts = (posted: PostedApproval, state: string) => ({
      state,
      lineCount: 1,
      expiresAt: secretRequests.find(posted.requestId)?.expiresAt.toISOString(),
      path: writePath,
      rule: "SEC-013",
      agentType: "glass-atrium-dev-node",
      requestId: posted.requestId,
    });
    const rows = [
      { name: "pending", itemId: pending.itemId, sessionId: pending.sessionId, facts: getHeldFacts(pending, "pending") },
      { name: "approved", itemId: approved.itemId, sessionId: approved.sessionId, facts: getHeldFacts(approved, "approved") },
      { name: "gone after its consume", itemId: gone.itemId, sessionId: gone.sessionId, facts: { state: "gone", lineCount: null, expiresAt: null, path: null, rule: null, agentType: null, requestId: null } },
      { name: "not a scan approval", itemId: plainItemId, sessionId: plainSessionId, facts: null },
    ];
    const capturedTexts = [pending, approved, gone].flatMap((posted) => [posted.line, getLineHash(posted.line)]).concat("a3f9c2d17b4e8f05");
    const forbiddenKeys = ["hash", "hashes", "lines", "sessionId", "agentId", "agent", "id"];
    for (const row of rows) {
      const payloads = [
        await send("GET", `/api/queue/owner/items?sessionId=${row.sessionId}`),
        await send("GET", `/api/queue/owner/orders?kind=item&sessionIds=${row.sessionId}`),
        await send("GET", `/api/queue/owner/items/${row.itemId}`),
      ];
      const [listed, done, detail] = payloads.map((response) => response.json());
      const views = [...listed.items, ...done.items].filter((item: { id: number }) => item.id === row.itemId).concat(detail);
      const facts = views.map((view: { scanApproval: Record<string, unknown> | null }) => view.scanApproval);
      assert.ok(views.length >= 2, `${row.name}: the item is in neither owner list`);
      assert.deepEqual(facts, views.map(() => row.facts), row.name);
      assert.deepEqual(facts.flatMap((fact) => Object.keys(fact ?? {}).filter((key) => forbiddenKeys.includes(key))), [], row.name);
      assert.deepEqual(payloads.map((response) => capturedTexts.filter((text) => response.body.includes(text))), payloads.map(() => []), row.name);
    }
  });

  test("the session's withdraw removes its item's request, pending or approved; a refused withdraw keeps it", async () => {
    const rows = [
      { name: "open item, pending request", prepare: async (_: PostedApproval) => {}, status: 200, isKept: false },
      { name: "approved, not yet acked", prepare: async (posted: PostedApproval) => void (await answer(posted.itemId, SECRET_APPROVAL_CODE.APPROVE)), status: 200, isKept: false },
      {
        name: "delivering, not withdrawable",
        prepare: async (posted: PostedApproval) => void (await getPrisma().queueItem.update({ where: { id: BigInt(posted.itemId) }, data: { status: "delivering" } })),
        status: 409,
        isKept: true,
      },
    ];
    for (const row of rows) {
      const posted = await postApproval();
      await row.prepare(posted);
      const response = await send("POST", `/api/queue/items/${posted.itemId}/withdraw`, { sessionId: posted.sessionId }, { headers: {} });
      assert.deepEqual([response.statusCode, secretRequests.find(posted.requestId) !== null], [row.status, row.isKept], `${row.name}: ${response.body}`);
    }
  });
});

/** Resolves once another backend waits on a lock `blocker` holds; bounded, so a request that never blocks fails the test. */
async function waitForBlockedBackend(blocker: Client): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await blocker.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))",
    );
    if (rows[0].n > 0) return;
    await delay(25);
  }
  throw new Error("the answer never waited on the held item row");
}

describe("close time", () => {
  test("an owner act that leaves open closes the item, at the answer time when it answers; one that stays open does not", async () => {
    const sessionId = await seedSession();
    const rows = [
      { name: "answer", itemId: await seedDecision(sessionId), action: "answer", body: { code: "R1" }, closedAt: "answer" },
      { name: "reply", itemId: await seedItem(sessionId), action: "reply", body: { text: "Merge it after the review." }, closedAt: "answer" },
      { name: "Seen", itemId: await seedItem(sessionId), action: "seen", body: undefined, closedAt: "write" },
      { name: "Later", itemId: await seedItem(sessionId), action: "later", body: undefined, closedAt: null },
      { name: "a refused answer", itemId: await seedDecision(sessionId), action: "answer", body: { code: "R9" }, closedAt: null },
    ] as const;
    for (const row of rows) {
      const sentAt = new Date();
      await send("POST", `/api/queue/owner/items/${row.itemId}/${row.action}`, row.body);
      const { closedAt, answeredAt } = await getItemRow(row.itemId);
      const isAnswerTime = closedAt !== null && closedAt.getTime() === answeredAt?.getTime();
      const isWriteTime = closedAt !== null && closedAt >= sentAt && closedAt <= new Date();
      assert.deepEqual([isAnswerTime, isWriteTime], [row.closedAt === "answer", row.closedAt !== null], row.name);
    }
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
      sessionIdPrefix: sessionId.slice(0, 8),
      name: "monitor",
      isNameRegistered: false,
      profileLabel,
      cwd: "/Users/owner/Desktop/git/glass-atrium/monitor",
      cwdTail: "glass-atrium/monitor",
      configDir: `/Users/owner/${profileLabel}`,
      state: "live",
      isWaiting: false,
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

  test("the list carries a relay while it is on its way to its recipient, never once delivered, lapsed or redacted", async () => {
    const [recipient, sender] = [await seedSession(), await seedSession({ name: "relay sender" })];
    const sentAt = new Date(Date.now() - 60_000);
    const seedRelay = (overrides: Partial<Prisma.QueueItemUncheckedCreateInput>) => seedItem(recipient, {
      kind: "relay", fromSessionId: sender, relayHop: 0, sendId: randomUUID(), title: "Rebased feature/queue-mcp onto main", body: "The relay suite is green.",
      isFreeTextAllowed: false, status: "answered", askedAt: sentAt, ...overrides,
    });
    const orderId = await seedItem(recipient);
    const onItsWay = { notFetched: await seedRelay({}), unackedFetched: await seedRelay({ status: "unacked", relayFetchedAt: sentAt }) };
    await seedRelay({ status: "delivered", deliveredAt: sentAt, relayFetchedAt: sentAt });
    await seedRelay({ status: "withdrawn", relayClosedAt: sentAt });
    await seedRelay({ relayRedactedAt: sentAt, relayRedactedLength: 25, title: RELAY_REDACTION_MARKER, body: RELAY_REDACTION_MARKER });

    const items = (await send("GET", `/api/queue/owner/items?sessionId=${recipient}`)).json().items as Array<{ id: number; relay: { sender: { sessionIdPrefix: string } } | null }>;

    assert.deepEqual(items.map((item) => item.id), [orderId, onItsWay.notFetched, onItsWay.unackedFetched].map(Number));
    assert.deepEqual(items.map((item) => item.relay?.sender.sessionIdPrefix ?? null), [null, sender.slice(0, 8), sender.slice(0, 8)], "listed in the relay's own view");
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

  test("an answered item carries no deviation", async () => {
    const itemId = await seedDecision(await seedSession(), { status: "answered", answerCode: "R1", answeredAt: new Date() });

    const detail = (await send("GET", `/api/queue/owner/items/${itemId}`)).json();

    assert.equal(detail.deviation, null);
  });

  test("an item's session carries the same name and registered flag as its session-list row", async () => {
    const profileLabel = `.claude-name-${randomUUID().slice(0, 8)}`;
    const ids = [await seedSession({ profileLabel, name: "gersona" }), await seedSession({ profileLabel, cwd: "/Users/owner/Desktop/git/library" })];
    const itemIds = await Promise.all(ids.map((sessionId) => seedItem(sessionId)));

    const listed = (await send("GET", `/api/queue/owner/sessions?profile=${profileLabel}`)).json().sessions as Array<Record<string, unknown>>;
    const details = await Promise.all(itemIds.map(async (itemId) => (await send("GET", `/api/queue/owner/items/${itemId}`)).json()));

    const nameById = new Map(listed.map((row) => [row.id, [row.name, row.isNameRegistered]]));
    assert.deepEqual(
      details.map((detail) => [detail.session.name, detail.session.isNameRegistered]),
      ids.map((id) => nameById.get(id)),
    );
    assert.deepEqual(nameById.get(ids[0]), ["gersona", true], "a registered name outranks the start directory");
  });

  test("an item's session and the session list carry the session's waiting fact", async () => {
    const profileLabel = `.claude-wait-${randomUUID().slice(0, 8)}`;
    const pid = 700_000 + Math.floor(Math.random() * 100_000);
    const id = { waiting: await seedSession({ profileLabel, pid }), idle: await seedSession({ profileLabel }) };
    const itemIds = { waiting: await seedItem(id.waiting), idle: await seedItem(id.idle) };

    const pull = await send("POST", "/api/queue/pending", { sessionId: id.waiting, pid, wait: true }, { headers: {} });
    const listed = (await send("GET", `/api/queue/owner/sessions?profile=${profileLabel}`, undefined, { headers: {} })).json().sessions;
    const details = await Promise.all([itemIds.waiting, itemIds.idle].map(async (itemId) => (await send("GET", `/api/queue/owner/items/${itemId}`)).json()));

    assert.equal(pull.statusCode, 200, pull.body);
    const isWaitingById = new Map(listed.map((row: { id: string; isWaiting: boolean }) => [row.id, row.isWaiting]));
    assert.deepEqual([isWaitingById.get(id.waiting), isWaitingById.get(id.idle)], [true, false]);
    assert.deepEqual(details.map((detail) => detail.session.isWaiting), [true, false]);
  });

  test("a resume-pending item carries its resume rows and the first skip reason by card precedence", async () => {
    const root = `/Users/owner/Desktop/git/wt-skip-${randomUUID().slice(0, 8)}`;
    const exited = { state: "exited" as const, exitReason: "dead" as const };
    const marked = { ...exited, resumeAwaitingRegisterAt: new Date() };
    const cases = [
      { name: "marker set beats a used attempt", session: marked, item: {}, used: true, hasOccupant: false, hasResumeInFlight: false, kind: "marker" },
      { name: "an approval-class item with a used attempt asks for Resend like any other", session: exited, item: { isApprovalClass: true }, used: true, hasOccupant: false, hasResumeInFlight: false, kind: "resume_used" },
      { name: "an approval-class item with nothing blocking has no skip reason", session: exited, item: { isApprovalClass: true }, used: false, hasOccupant: false, hasResumeInFlight: false, kind: null },
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

  test("the CLI path, the image folder and the secret scanner follow GA_ROOT, so a non-default install uses its own", () => {
    const saved = process.env.GA_ROOT;
    process.env.GA_ROOT = "/Volumes/tools/atrium";
    try {
      const options = resolveQueueRouteOptions();
      assert.equal(options.cliPath, "/Volumes/tools/atrium/scripts/atrium-queue.sh");
      assert.equal(options.imageDir, "/Volumes/tools/atrium/data/queue/images");
      assert.equal(options.scannerPath, "/Volumes/tools/atrium/scripts/lib/secret-scan.sh");
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

describe("probe sessions in the item list", () => {
  test("a probe session's items are left out of the owner item list", async () => {
    const profileLabel = `.claude-probe-${randomUUID().slice(0, 8)}`;
    const id = { probe: await seedSession({ profileLabel, isProbe: true }), plain: await seedSession({ profileLabel }) };
    await seedItem(id.probe);
    const plainItemId = await seedItem(id.plain);

    const response = await send("GET", `/api/queue/owner/items?profile=${encodeURIComponent(profileLabel)}`);

    assert.deepEqual(response.json().items.map((item: { id: number }) => item.id), [Number(plainItemId)]);
  });
});

describe("recent automatic resumes", () => {
  test("lists resume rows newest first with item and account, keeping a resume whose item was delivered", async () => {
    const sessionId = await seedSession({ state: "exited", exitReason: "dead", profileLabel: ".claude-work", cwd: "/Users/owner/Desktop/git/atrium/hooks" });
    const delivered = await seedDecision(sessionId, { title: "Pick the index", status: "delivered", answerCode: "R1", answeredAt: new Date(), deliveredAt: new Date() });
    await seedResumeDelivery(delivered, 1, "bg-41", { result: "acked" });
    const pending = await seedDecision(sessionId, { title: "Pick the lock order", status: "resume_pending", answerCode: "R2", answeredAt: new Date() });
    await seedResumeDelivery(pending, 1, null, { result: "aborted", abortReason: "session_returned" });
    // the resume suite writes resume rows in parallel under the same shared lock → read a window, keep this test's rows
    const response = await send("GET", "/api/queue/owner/resumes?limit=50");
    assert.equal(response.statusCode, 200, response.body);
    const session = { profileLabel: ".claude-work", cwdTail: "atrium/hooks" };
    const ownIds = new Set([Number(pending), Number(delivered)]);
    const resumes = (response.json().resumes as Array<{ sentAt: string; item: { id: number } }>)
      .filter((resume) => ownIds.has(resume.item.id))
      .map(({ sentAt: _sentAt, ...rest }) => rest);
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

  test("the record takes a bounded limit", async () => {
    assert.equal((await send("GET", "/api/queue/owner/resumes?limit=51")).statusCode, 400);
  });
});

describe("session list", () => {
  test("lists live, stale and item-owning exited sessions of an account, live first then by last activity, with name, state and counts", async () => {
    const profileLabel = `.claude-list-${randomUUID().slice(0, 8)}`;
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const id = {
      liveOld: await seedSession({ profileLabel, name: "queue-sessions M2", lastSeenAt: minutesAgo(30) }),
      liveNew: await seedSession({ profileLabel, cwd: "/Users/owner/Desktop/git/library", lastSeenAt: minutesAgo(1) }),
      stale: await seedSession({ profileLabel, state: "stale", lastSeenAt: minutesAgo(5) }),
      exitedWithItems: await seedSession({ profileLabel, state: "exited", exitReason: "ended", lastSeenAt: minutesAgo(60), resumeAwaitingRegisterAt: minutesAgo(2) }),
      replaced: await seedSession({ profileLabel, state: "exited", exitReason: "replaced", lastSeenAt: minutesAgo(70) }),
      exitedBare: await seedSession({ profileLabel, state: "exited", exitReason: "dead", lastSeenAt: minutesAgo(3) }),
    };
    await seedItem(id.liveOld, { status: "open", askedAt: minutesAgo(40) });
    await seedDecision(id.liveOld, { status: "unacked", answerCode: "R1", answeredAt: minutesAgo(35), askedAt: minutesAgo(40) });
    await seedItem(id.exitedWithItems, { status: "delivered", askedAt: minutesAgo(10) });
    await seedItem(id.replaced, { status: "open", askedAt: minutesAgo(70) });
    await seedSession({ name: "another account" });

    const response = await send("GET", `/api/queue/owner/sessions?profile=${profileLabel}`, undefined, { headers: {} });

    assert.equal(response.statusCode, 200, response.body);
    const { sessions, hasMore } = response.json();
    assert.equal(hasMore, false);
    assert.deepEqual(
      sessions.map((row: { id: string }) => row.id),
      [id.liveNew, id.liveOld, id.stale, id.exitedWithItems, id.replaced],
      "exited without items left out; live first, then newest activity",
    );
    const [liveNew, liveOld, , exitedWithItems, replaced] = sessions;
    assert.deepEqual([liveNew.name, liveNew.isNameRegistered], ["library", false], "start-directory fallback");
    assert.deepEqual([liveOld.name, liveOld.isNameRegistered], ["queue-sessions M2", true]);
    assert.deepEqual(liveOld.count, { awaiting: 1, inDelivery: 1 });
    assert.deepEqual([liveOld.profileLabel, liveOld.cwdTail, liveOld.sessionIdPrefix], [profileLabel, "glass-atrium/monitor", id.liveOld.slice(0, 8)]);
    assert.equal(exitedWithItems.lastActivityAt, new Date(exitedWithItems.lastActivityAt).toISOString());
    assert.ok(new Date(exitedWithItems.lastActivityAt) > minutesAgo(11), "an item asked after the last register counts as activity");
    assert.deepEqual([exitedWithItems.state, exitedWithItems.exitReason, exitedWithItems.isSelectable], ["exited", "ended", true]);
    assert.ok(exitedWithItems.markerSetAt !== null, "the resume-marker note");
    assert.deepEqual([replaced.exitReason, replaced.isSelectable], ["replaced", false]);
  });

  test("hides probe rows and item-less rows whose transcript file is missing; the include-hidden option lists them flagged", async () => {
    const profileLabel = `.claude-hidden-${randomUUID().slice(0, 8)}`;
    const transcript = { missing: path.join(fixtureRoot, `${randomUUID()}.jsonl`), present: path.join(fixtureRoot, `${randomUUID()}.jsonl`) };
    writeFileSync(transcript.present, "{}\n");
    const id = {
      probe: await seedSession({ profileLabel, isProbe: true }),
      probeWithItem: await seedSession({ profileLabel, isProbe: true }),
      unused: await seedSession({ profileLabel, transcriptPath: transcript.missing }),
      unusedWithItem: await seedSession({ profileLabel, transcriptPath: transcript.missing }),
      started: await seedSession({ profileLabel, transcriptPath: transcript.present }),
      noPath: await seedSession({ profileLabel }),
    };
    await seedItem(id.probeWithItem);
    await seedItem(id.unusedWithItem);

    const read = async (query: string) => {
      const response = await send("GET", `/api/queue/owner/sessions?profile=${profileLabel}${query}`, undefined, { headers: {} });
      assert.equal(response.statusCode, 200, response.body);
      return new Map((response.json().sessions as Array<{ id: string; isHidden: boolean }>).map((row) => [row.id, row.isHidden]));
    };
    const [listed, all] = [await read(""), await read("&includeHidden=true")];

    assert.deepEqual([...listed.keys()].sort(), [id.unusedWithItem, id.started, id.noPath].sort());
    assert.deepEqual(
      Object.entries(id).map(([name, sessionId]) => [name, all.get(sessionId)]),
      [["probe", true], ["probeWithItem", true], ["unused", true], ["unusedWithItem", false], ["started", false], ["noPath", false]],
    );
  });

  test("rejects an unknown query key", async () => {
    const response = await send("GET", "/api/queue/owner/sessions?state=live");
    assert.deepEqual([response.statusCode, response.json().error], [400, "invalid_input"]);
  });
});

describe("owner message send", () => {
  const getMessages = (sessionIds: string[]) =>
    getPrisma().queueItem.findMany({ where: { sessionId: { in: sessionIds }, kind: "message" }, orderBy: { id: "asc" } });

  test("one send puts one answered message item per target, stamped with the send route and the page-origin signal", async () => {
    const targets = [await seedSession(), await seedSession({ state: "exited", exitReason: "ended" }), await seedSession({ state: "stale" })];
    const firstLine = "Rebase onto main before the review " + "x".repeat(200);
    const text = `\n   \n  ${firstLine}  \nthen rerun the suite.`;
    const rows = [
      { name: "fetch metadata", headers: SAME_ORIGIN as Record<string, string>, signal: "fetch_metadata" },
      { name: "Origin only", headers: { origin: `http://localhost:${PORT}` }, signal: "origin" },
    ];
    for (const row of rows) {
      const before = (await getMessages(targets)).length;
      const response = await send("POST", "/api/queue/owner/messages/send", { sessionIds: targets, text }, { headers: row.headers });
      assert.equal(response.statusCode, 201, `${row.name}: ${response.body}`);
      const created = (await getMessages(targets)).slice(before);
      assert.deepEqual(created.map((item) => item.sessionId).sort(), [...targets].sort(), row.name);
      assert.deepEqual(response.json().items.map((item: { id: number }) => item.id).sort(), created.map((item) => Number(item.id)).sort(), row.name);
      for (const item of created) {
        assert.deepEqual(
          [item.status, item.answerRoute, item.answerSignal, item.body, item.title, item.isFreeTextAllowed, item.answeredAt !== null],
          ["answered", "message", row.signal, text, firstLine.trim().slice(0, 200), false, true],
          row.name,
        );
      }
    }
  });

  test("the copies of one send share one send id that no other send carries, returned by the send and the item view", async () => {
    const targets = [await seedSession(), await seedSession()];
    const sends = [];
    for (const text of ["Rebase onto main.", "Rebase onto main."]) {
      sends.push((await send("POST", "/api/queue/owner/messages/send", { sessionIds: targets, text })).json());
    }

    const views = await Promise.all(sends.flatMap((sent) => sent.items.map(async (item: { id: number }) => (await send("GET", `/api/queue/owner/items/${item.id}`)).json())));

    const [first, second] = sends.map((sent) => sent.sendId);
    assert.match(String(first), /^[0-9a-f-]{36}$/);
    assert.notEqual(first, second, "an equal text sent again is another send");
    assert.deepEqual(views.map((view) => view.sendId), [first, first, second, second]);
  });

  test("an item no send created carries no send id", async () => {
    const detail = (await send("GET", `/api/queue/owner/items/${await seedItem(await seedSession())}`)).json();

    assert.equal(detail.sendId, null);
  });

  test("a send outside the body rules is refused and creates nothing", async () => {
    const target = await seedSession();
    const tooMany = [target, ...Array.from({ length: 20 }, () => randomUUID())];
    const rows = [
      { name: "no target", body: { sessionIds: [], text: "Rebase onto main." } },
      { name: "21 targets", body: { sessionIds: tooMany, text: "Rebase onto main." } },
      { name: "a repeated id", body: { sessionIds: [target, target], text: "Rebase onto main." } },
      { name: "one id repeated in another letter case", body: { sessionIds: [target, target.toUpperCase()], text: "Rebase onto main." } },
      { name: "blank text", body: { sessionIds: [target], text: " \n " } },
      { name: "text past 20000 characters", body: { sessionIds: [target], text: "t".repeat(20_001) } },
      { name: "an unknown key", body: { sessionIds: [target], text: "Rebase onto main.", isApprovalClass: true } },
    ];
    for (const row of rows) {
      const response = await send("POST", "/api/queue/owner/messages/send", row.body);
      assert.deepEqual([response.statusCode, response.json().error], [400, "invalid_input"], row.name);
    }
    assert.equal((await getMessages([target])).length, 0);
  });

  test("one unknown, replaced or probe target refuses the whole send", async () => {
    const live = await seedSession();
    const replaced = await seedSession({ state: "exited", exitReason: "replaced" });
    const probe = await seedSession({ isProbe: true });
    const rows = [
      { name: "an unknown session id", sessionIds: [live, randomUUID()], status: 404, error: "unknown_session" },
      { name: "a replaced session", sessionIds: [live, replaced], status: 409, error: "session_replaced" },
      { name: "a probe session", sessionIds: [live, probe], status: 409, error: "session_probe" },
    ];
    for (const row of rows) {
      const response = await send("POST", "/api/queue/owner/messages/send", { sessionIds: row.sessionIds, text: "Rebase onto main." });
      assert.deepEqual([response.statusCode, response.json().error], [row.status, row.error], row.name);
    }
    assert.equal((await getMessages([live, replaced, probe])).length, 0);
  });

  test("a send without the monitor page's origin is refused and creates nothing", async () => {
    const target = await seedSession();
    const refused: Array<Record<string, string>> = [{}, { "sec-fetch-site": "cross-site" }, { origin: "https://evil.example" }];
    for (const headers of refused) {
      const response = await send("POST", "/api/queue/owner/messages/send", { sessionIds: [target], text: "Rebase onto main." }, { headers });
      assert.equal(response.statusCode, 403, JSON.stringify(headers));
    }
    assert.equal((await getMessages([target])).length, 0);
  });

  test("a sent message reaches its session through pending, get and ack, and no other session can read it", async () => {
    const target = await seedSession();
    const other = await seedSession();
    const sent = await send("POST", "/api/queue/owner/messages/send", { sessionIds: [target], text: "Rebase onto main." });
    const [item] = sent.json().items;

    const pending = await send("POST", "/api/queue/pending", { sessionId: target }, { headers: {} });
    const [claim] = pending.json().items;
    const fetched = await send("GET", `/api/queue/items/${item.id}?sessionId=${target}`, undefined, { headers: {} });
    const foreign = await send("GET", `/api/queue/items/${item.id}?sessionId=${other}`, undefined, { headers: {} });
    const ack = await send("POST", `/api/queue/items/${item.id}/ack`, { sessionId: target, msgId: claim.id.msg }, { headers: {} });

    assert.equal(claim.id.item, item.id);
    assert.deepEqual([fetched.statusCode, fetched.json().kind, fetched.json().body], [200, "message", "Rebase onto main."]);
    assert.equal(foreign.statusCode, 404);
    assert.deepEqual(ack.json(), { result: "first" });
    assert.equal((await getItemRow(BigInt(item.id))).status, "delivered");
  });
});

describe("order history", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const getOrders = (query: string) => send("GET", `/api/queue/owner/orders?${query}`, undefined, { headers: {} });

  function seedMessage(sessionId: string, answeredAt: Date, overrides: Partial<Prisma.QueueItemUncheckedCreateInput> = {}): Promise<bigint> {
    return seedItem(sessionId, {
      kind: "message",
      title: "Rebase onto main.",
      body: "Rebase onto main.",
      isFreeTextAllowed: false,
      status: "delivered",
      answeredAt,
      answerRoute: "message",
      answerSignal: "fetch_metadata",
      ...overrides,
    });
  }

  function seedReply(sessionId: string, answeredAt: Date, status: Prisma.QueueItemUncheckedCreateInput["status"]): Promise<bigint> {
    return seedItem(sessionId, { status, answerText: "Ship it after the rebase.", answeredAt, answerRoute: "reply", answerSignal: "fetch_metadata" });
  }

  test("lists the owner's orders and replied reports in every status, newest first, and nothing else", async () => {
    const [mine, other] = [await seedSession(), await seedSession()];
    const ids = {
      deliveredMessage: await seedMessage(mine, minutesAgo(50), { sendId: randomUUID() }),
      withdrawnReply: await seedReply(mine, minutesAgo(40), "withdrawn"),
      unackedMessage: await seedMessage(mine, minutesAgo(30), { status: "unacked", sendId: randomUUID() }),
      deliveredReply: await seedReply(mine, minutesAgo(20), "delivered"),
    };
    await seedItem(mine, { status: "open" });
    await seedItem(mine, { status: "seen" });
    await seedDecision(mine, { status: "delivered", answerCode: "R1", answeredAt: minutesAgo(10), answerRoute: "answer", answerSignal: "fetch_metadata" });
    await seedMessage(other, minutesAgo(5), { sendId: randomUUID() });

    const response = await getOrders(`sessionIds=${mine}`);

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      response.json().items.map((item: { id: number }) => item.id),
      [ids.deliveredReply, ids.unackedMessage, ids.withdrawnReply, ids.deliveredMessage].map(Number),
    );
    assert.equal(response.json().items[0].session.id, mine, "in the owner item view");
  });

  test("an order to several sessions comes whole, every recipient included, when one recipient is asked for", async () => {
    const targets = [await seedSession(), await seedSession(), await seedSession()];
    const sent = (await send("POST", "/api/queue/owner/messages/send", { sessionIds: targets, text: "Rebase onto main." })).json();

    const listed = (await getOrders(`sessionIds=${targets[1]}`)).json().items as Array<{ sendId: string; session: { id: string } }>;

    assert.deepEqual(listed.map((item) => item.sendId), [sent.sendId, sent.sendId, sent.sendId]);
    assert.deepEqual(listed.map((item) => item.session.id).sort(), [...targets].sort());
  });

  test("paging by cursor returns every order once, newest first, with all its copies on one page", async () => {
    const [left, right] = [await seedSession(), await seedSession()];
    const orders: bigint[][] = [];
    for (const [index, minutes] of [60, 50, 40, 30, 20].entries()) {
      const answeredAt = minutesAgo(minutes);
      // the second order predates send ids → its copies fold by their equal time and text
      const fields = index === 1 ? { body: "Run the bats suite again." } : { sendId: randomUUID() };
      orders.unshift([await seedMessage(left, answeredAt, fields), await seedMessage(right, answeredAt, fields)]);
    }
    orders.splice(2, 0, [await seedReply(left, minutesAgo(35), "answered")]);

    const pages: number[][] = [];
    let query = `sessionIds=${left},${right}&limit=2`;
    for (let round = 0; round < 10; round += 1) {
      const page = (await getOrders(query)).json() as { items: Array<{ id: number }>; nextCursor: string | null };
      pages.push(page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      query = `sessionIds=${left},${right}&limit=2&before=${encodeURIComponent(page.nextCursor)}`;
    }

    const expected = orders.map((copies) => copies.map(Number));
    assert.deepEqual(pages, [[...expected[0]!, ...expected[1]!], [...expected[2]!, ...expected[3]!], [...expected[4]!, ...expected[5]!]]);
  });

  test("leaves out the orders, replied reports and relays of a session that registered again as a probe", async () => {
    const [kept, probe] = [await seedSession(), await seedSession()];
    const sendId = randomUUID();
    const keptCopy = await seedMessage(kept, minutesAgo(30), { sendId });
    await seedMessage(probe, minutesAgo(30), { sendId });
    await seedReply(probe, minutesAgo(20), "delivered");
    const relay = { kind: "relay" as const, fromSessionId: kept, relayHop: 0, sendId: randomUUID(), isFreeTextAllowed: false, status: "answered" as const };
    await seedItem(probe, relay);
    await getPrisma().queueSession.update({ where: { sessionId: probe }, data: { isProbe: true } });

    const orders = await getOrders(`sessionIds=${kept},${probe}`);
    const relays = await getOrders(`kind=relay&sessionIds=${kept},${probe}`);

    assert.deepEqual(orders.json().items.map((item: { id: number }) => item.id), [Number(keptCopy)], "order thread");
    assert.deepEqual(relays.json().items, [], "relay thread");
  });

  test("refuses a malformed session list, limit or cursor", async () => {
    const rows = [
      { name: "a session id that is no uuid", query: "sessionIds=not-a-uuid" },
      { name: "an empty session id in the list", query: `sessionIds=${randomUUID()},` },
      { name: "a limit past the page cap", query: "limit=101" },
      { name: "a cursor of another shape", query: "before=12" },
      { name: "an unknown key", query: "status=delivered" },
      { name: "an item kind with no history", query: "kind=decision" },
      { name: "a profile filter on the order thread", query: "profile=default" },
      { name: "a profile filter on the relay thread", query: "kind=relay&profile=default" },
    ];
    for (const row of rows) {
      const response = await getOrders(row.query);
      assert.deepEqual([response.statusCode, response.json().error], [400, "invalid_input"], row.name);
    }
  });
});

describe("relay history", () => {
  const text = "Rebased feature/queue-mcp onto main; the relay suite is green.";
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const getHistory = (query: string) => send("GET", `/api/queue/owner/orders?kind=relay&${query}`, undefined, { headers: {} });
  const getOrders = (query: string) => send("GET", `/api/queue/owner/orders?${query}`, undefined, { headers: {} });
  // refusal rows placed in the past fall before suiteStart → removed here by id
  const placedRefusalIds: bigint[] = [];

  after(async () => {
    await getPrisma().auditLog.deleteMany({ where: { id: { in: placedRefusalIds } } });
  });

  function seedRelay(from: string, to: string, askedAt: Date, overrides: Partial<Prisma.QueueItemUncheckedCreateInput> = {}): Promise<bigint> {
    return seedItem(to, {
      kind: "relay", fromSessionId: from, relayHop: 0, sendId: randomUUID(), title: "Rebased feature/queue-mcp onto main", body: text,
      isFreeTextAllowed: false, status: "delivered", askedAt, deliveredAt: askedAt, relayFetchedAt: askedAt, ...overrides,
    });
  }

  // The relay route writes the refusal record, then the row is placed at the given time
  async function seedRefusal(sender: string, recipients: string[], eventTs: Date): Promise<string> {
    const response = await send("POST", "/api/queue/relay", { sessionId: sender, recipients: recipients.map((id) => id.slice(0, 8)), text }, { headers: {} });
    assert.match(response.json().error, /^relay_/, response.body);
    const row = await getPrisma().auditLog.findFirstOrThrow({
      where: { targetTable: "queue-relay", resultCode: "blocked", payload: { path: ["change", "senderId"], equals: sender } },
      orderBy: { id: "desc" },
    });
    await getPrisma().auditLog.update({ where: { id: row.id }, data: { eventTs } });
    placedRefusalIds.push(row.id);
    return eventTs.toISOString();
  }

  test("lists every relay in every state with either end in the filter, newest send first, each send whole, and leaves them out of the orders thread", async () => {
    const [sender, left, right, stranger] = [await seedSession(), await seedSession(), await seedSession(), await seedSession()];
    const sendId = randomUUID();
    const ids = {
      toBoth: [await seedRelay(sender, left, minutesAgo(40), { sendId }), await seedRelay(sender, right, minutesAgo(40), { sendId })],
      lapsedToSender: await seedRelay(right, sender, minutesAgo(30), { status: "withdrawn", deliveredAt: null, relayFetchedAt: null, relayClosedAt: minutesAgo(1) }),
      unackedFetched: await seedRelay(sender, right, minutesAgo(25), { status: "unacked", deliveredAt: null }),
      onItsWay: await seedRelay(sender, left, minutesAgo(20), { status: "answered", deliveredAt: null, relayFetchedAt: null }),
    };
    await seedRelay(stranger, left, minutesAgo(10));

    const history = await getHistory(`sessionIds=${sender}`);
    const orders = await getOrders(`sessionIds=${sender},${left},${right}`);

    assert.equal(history.statusCode, 200, history.body);
    assert.deepEqual(history.json().items.map((item: { id: number }) => item.id), [ids.onItsWay, ids.unackedFetched, ids.lapsedToSender, ...ids.toBoth].map(Number));
    assert.deepEqual(orders.json().items, [], "a relay is no order");
  });

  test("an entry carries hop, parent, sender, fetch, redaction and lapse facts; an owner order carries none", async () => {
    const [sender, recipient] = [await seedSession({ name: "relay sender" }), await seedSession({ name: "parent sender" })];
    const parentSentAt = minutesAgo(30);
    const parentId = await seedRelay(recipient, sender, parentSentAt);
    const childId = await seedRelay(sender, recipient, minutesAgo(20), { relayHop: 1, relayParentId: parentId });
    const lapsedAt = minutesAgo(1);
    const lapsedId = await seedRelay(sender, recipient, minutesAgo(10), { status: "withdrawn", deliveredAt: null, relayFetchedAt: null, relayClosedAt: lapsedAt });
    assert.equal((await send("POST", `/api/queue/owner/items/${childId}/redact`)).statusCode, 200);
    const redacted = await getItemRow(childId);
    await send("POST", "/api/queue/owner/messages/send", { sessionIds: [recipient], text: "Rebase onto main." });

    const items = (await getHistory(`sessionIds=${sender}`)).json().items as Array<{ id: number; relay: unknown }>;
    const order = (await getOrders(`sessionIds=${recipient}`)).json().items[0];

    assert.deepEqual(items.find((item) => item.id === Number(childId))?.relay, {
      hop: 1,
      parent: { id: Number(parentId), sender: { sessionIdPrefix: recipient.slice(0, 8), profileLabel: "default", selfDeclaredName: "parent sender", cwdTail: "glass-atrium/monitor" }, sentAt: parentSentAt.toISOString() },
      sender: { sessionIdPrefix: sender.slice(0, 8), profileLabel: "default", selfDeclaredName: "relay sender", cwdTail: "glass-atrium/monitor" },
      fetchedAt: redacted.relayFetchedAt?.toISOString(),
      redaction: { at: redacted.relayRedactedAt?.toISOString(), length: text.length },
      lapsedAt: null,
    });
    assert.deepEqual(items.find((item) => item.id === Number(lapsedId))?.relay, {
      hop: 0, parent: null, sender: { sessionIdPrefix: sender.slice(0, 8), profileLabel: "default", selfDeclaredName: "relay sender", cwdTail: "glass-atrium/monitor" },
      fetchedAt: null, redaction: null, lapsedAt: lapsedAt.toISOString(),
    });
    assert.equal(order.relay, null);
  });

  test("an entry names its recipient by the 8-character id prefix beside its sender's", async () => {
    const [sender, recipient] = [await seedSession(), await seedSession()];
    const relayId = await seedRelay(sender, recipient, minutesAgo(5));

    const entry = (await getHistory(`sessionIds=${recipient}`)).json().items.find((item: { id: number }) => item.id === Number(relayId));

    assert.deepEqual([entry.session.sessionIdPrefix, entry.relay.sender.sessionIdPrefix], [recipient.slice(0, 8), sender.slice(0, 8)]);
  });

  test("a relay carries no deviation and no Resend in any state, and Resend refuses it", async () => {
    const [sender, recipient] = [await seedSession(), await seedSession()];
    const states = ["answered", "delivering", "unacked", "held", "expired", "delivered", "withdrawn"] as const;
    for (const status of states) {
      const relayId = await seedRelay(sender, recipient, minutesAgo(5), { status, deliveredAt: status === "delivered" ? minutesAgo(4) : null, relayClosedAt: status === "withdrawn" ? minutesAgo(1) : null });
      const view = (await send("GET", `/api/queue/owner/items/${relayId}`, undefined, { headers: {} })).json();
      const before = await getItemRow(relayId);

      const resend = await send("POST", `/api/queue/owner/items/${relayId}/resend`);

      assert.deepEqual([view.deviation, view.canResend, resend.statusCode], [null, false, 409], status);
      assert.deepEqual(await getItemRow(relayId), before, status);
    }
  });

  test("each page carries the refusal records of its own time span, either end in the filter, once across pages, with no text", async () => {
    const [sender, recipient, stranger] = [await seedSession(), await seedSession(), await seedSession()];
    await seedRelay(sender, recipient, minutesAgo(50));
    const olderRefusal = await seedRefusal(sender, [sender], minutesAgo(45));
    await seedRelay(recipient, sender, minutesAgo(40));
    const middleRefusal = await seedRefusal(sender, [sender], minutesAgo(35));
    await seedRelay(sender, recipient, minutesAgo(30));
    // the filtered session as a resolved recipient, beside a prefix no session has
    const newestRefusal = await seedRefusal(recipient, [sender, randomUUID()], minutesAgo(25));
    await seedRefusal(stranger, [stranger], minutesAgo(36));

    const pages: Array<Array<{ at: string; reason: string; senderIdPrefix: string; recipientIdPrefixes: string[]; unresolvedCount: number | null }>> = [];
    let query = `sessionIds=${sender}&limit=1`;
    for (let round = 0; round < 10; round += 1) {
      const page = (await getHistory(query)).json() as { refusals: (typeof pages)[number]; nextCursor: string | null };
      pages.push(page.refusals);
      if (page.nextCursor === null) break;
      query = `sessionIds=${sender}&limit=1&before=${encodeURIComponent(page.nextCursor)}`;
    }

    const selfRefusal = (at: string) => ({ at, reason: "self", senderIdPrefix: sender.slice(0, 8), recipientIdPrefixes: [sender.slice(0, 8)], unresolvedCount: null });
    const unresolvedRefusal = { at: newestRefusal, reason: "recipient", senderIdPrefix: recipient.slice(0, 8), recipientIdPrefixes: [sender.slice(0, 8)], unresolvedCount: 1 };
    assert.deepEqual(pages, [[unresolvedRefusal], [selfRefusal(middleRefusal)], [selfRefusal(olderRefusal)]]);
  });

  test("a page's refusal records stop at the cap, newest kept, and say they were cut", async () => {
    // spread over senders that each stay under the per-sender refusal bound
    const senders = await Promise.all(Array.from({ length: 6 }, () => seedSession()));
    await seedRelay(await seedSession(), senders[0] ?? "", minutesAgo(10));
    const cap = 100;
    for (let index = 0; index <= cap; index += 1) {
      const sender = senders[index % senders.length] ?? "";
      await send("POST", "/api/queue/relay", { sessionId: sender, recipients: [sender.slice(0, 8)], text }, { headers: {} });
    }
    const stored = await getPrisma().auditLog.findMany({
      where: { targetTable: "queue-relay", OR: senders.map((sender) => ({ payload: { path: ["change", "senderId"], equals: sender } })) },
      orderBy: [{ eventTs: "desc" }, { id: "desc" }],
    });

    const page = (await getHistory(`sessionIds=${senders.join(",")}`)).json() as { refusals: Array<{ at: string }>; isRefusalListCut: boolean };

    assert.equal(stored.length, cap + 1);
    assert.deepEqual(page.refusals.map((refusal) => refusal.at), stored.slice(0, cap).map((row) => row.eventTs.toISOString()));
    assert.equal(page.isRefusalListCut, true);
  });
});

describe("done items", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const getDone = (query: string) => send("GET", `/api/queue/owner/orders?kind=item&${query}`, undefined, { headers: {} });
  const getIdTimes = (response: LightMyRequestResponse) =>
    (response.json().items as Array<{ id: number; closedAt: string | null }>).map((item) => [item.id, item.closedAt]);

  test("lists decisions and reports no longer open, newest close time first, with no order and no probe session's item", async () => {
    const [mine, probe] = [await seedSession(), await seedSession({ isProbe: true })];
    const answeredAt = { decision: minutesAgo(10), reply: minutesAgo(20) };
    const closedAt = { withdrawn: minutesAgo(30), seen: minutesAgo(40) };
    const ids = {
      answeredDecision: await seedDecision(mine, { status: "answered", answerCode: "R1", answeredAt: answeredAt.decision, answerRoute: "answer", answerSignal: "fetch_metadata" }),
      repliedReport: await seedItem(mine, { status: "delivered", answerText: "Ship it after the rebase.", answeredAt: answeredAt.reply, answerRoute: "reply", answerSignal: "fetch_metadata" }),
      withdrawnDecision: await seedDecision(mine, { status: "withdrawn", closedAt: closedAt.withdrawn }),
      seenReport: await seedItem(mine, { status: "seen", closedAt: closedAt.seen }),
    };
    await seedItem(mine);
    await seedItem(mine, { kind: "message", title: "Rebase onto main.", body: "Rebase onto main.", isFreeTextAllowed: false, status: "delivered", answeredAt: minutesAgo(5), answerRoute: "message", answerSignal: "fetch_metadata" });
    await seedItem(probe, { status: "seen", closedAt: minutesAgo(5) });

    const response = await getDone(`sessionIds=${mine},${probe}`);

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(getIdTimes(response), [
      [Number(ids.answeredDecision), answeredAt.decision.toISOString()],
      [Number(ids.repliedReport), answeredAt.reply.toISOString()],
      [Number(ids.withdrawnDecision), closedAt.withdrawn.toISOString()],
      [Number(ids.seenReport), closedAt.seen.toISOString()],
    ]);
  });

  test("the profile filter keeps only the items of that account's sessions", async () => {
    const suffix = randomUUID().slice(0, 8);
    const [work, personal] = [await seedSession({ profileLabel: `.claude-work-${suffix}` }), await seedSession({ profileLabel: `.claude-personal-${suffix}` })];
    const workItemId = await seedItem(work, { status: "seen" });
    await seedItem(personal, { status: "seen" });

    const response = await getDone(`profile=${encodeURIComponent(`.claude-work-${suffix}`)}`);

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().items.map((item: { id: number }) => item.id), [Number(workItemId)]);
  });

  test("paging by cursor returns every item once, newest close time first, an equal time broken by the higher id", async () => {
    const sessionId = await seedSession();
    const tie = minutesAgo(40);
    const seeded: Array<{ id: bigint; closedAt: Date }> = [];
    for (const closedAt of [minutesAgo(50), tie, tie, minutesAgo(30), minutesAgo(20)]) {
      seeded.push({ id: await seedItem(sessionId, { status: "seen", closedAt }), closedAt });
    }

    const pages: number[][] = [];
    let query = `sessionIds=${sessionId}&limit=2`;
    for (let round = 0; round < 10; round += 1) {
      const page = (await getDone(query)).json() as { items: Array<{ id: number }>; nextCursor: string | null };
      pages.push(page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      query = `sessionIds=${sessionId}&limit=2&before=${encodeURIComponent(page.nextCursor)}`;
    }

    const newestFirst = [...seeded].sort((a, b) => b.closedAt.getTime() - a.closedAt.getTime() || Number(b.id - a.id)).map((item) => Number(item.id));
    assert.deepEqual(pages, [newestFirst.slice(0, 2), newestFirst.slice(2, 4), newestFirst.slice(4)]);
  });

  test("a done page carries no relay refusal records", async () => {
    const sessionId = await seedSession();
    await seedItem(sessionId, { status: "seen" });

    const response = await getDone(`sessionIds=${sessionId}`);

    assert.deepEqual(Object.keys(response.json()).sort(), ["items", "nextCursor"]);
  });
});

describe("relay redaction", () => {
  const text ="Rebased feature/queue-mcp onto main; the relay suite is green.";

  async function seedRelay(overrides: Partial<Prisma.QueueItemUncheckedCreateInput> = {}): Promise<bigint> {
    const [sender, recipient] = [await seedSession(), await seedSession()];
    const deliveredAt = new Date(Date.now() - 60_000);
    return seedItem(recipient, {
      kind: "relay", fromSessionId: sender, relayHop: 1, sendId: randomUUID(), title: "Rebased feature/queue-mcp onto main", body: text,
      isFreeTextAllowed: false, status: "delivered", deliveredAt, relayFetchedAt: deliveredAt, askedAt: new Date(Date.now() - 120_000), ...overrides,
    });
  }

  function redact(itemId: bigint, body?: object, options: SendOptions = {}): Promise<LightMyRequestResponse> {
    return send("POST", `/api/queue/owner/items/${itemId}/redact`, body, options);
  }

  // Every field but the text, its two redaction stamps and the row's own update time
  async function getKeptFields(itemId: bigint) {
    const { title, body, relayRedactedAt, relayRedactedLength, updatedAt, ...kept } = await getItemRow(itemId);
    return kept;
  }

  test("replaces the relay's text with the fixed marker, keeps every other field and adds the redaction time and the original length", async () => {
    const itemId = await seedRelay();
    const kept = await getKeptFields(itemId);
    const start = new Date();

    const response = await redact(itemId);

    assert.equal(response.statusCode, 200, response.body);
    const row = await getItemRow(itemId);
    assert.deepEqual([row.title, row.body, row.relayRedactedLength], [RELAY_REDACTION_MARKER, RELAY_REDACTION_MARKER, text.length]);
    assert.ok(row.relayRedactedAt !== null && row.relayRedactedAt >= start, "redaction time set");
    assert.deepEqual(await getKeptFields(itemId), kept);
  });

  test("leaves no line of the text in any stored column, audit row or read, the title included", async () => {
    const lines = ["Rebased feature/queue-mcp onto main", "the relay suite is green, merge when ready"];
    const recipient = await seedSession();
    const itemId = await seedRelay({ sessionId: recipient, title: lines[0], body: lines.join("\n"), status: "answered", deliveredAt: null, relayFetchedAt: null });
    assert.equal((await redact(itemId)).statusCode, 200);
    const asJson = (value: unknown) => JSON.stringify(value, (_key, field: unknown) => (typeof field === "bigint" ? field.toString() : field));

    const sources = {
      "stored row": asJson(await getItemRow(itemId)),
      "audit rows": asJson(await getPrisma().auditLog.findMany({ where: { targetId: itemId } })),
      "owner item": (await send("GET", `/api/queue/owner/items/${itemId}`, undefined, { headers: {} })).body,
      "relay history": (await send("GET", `/api/queue/owner/orders?kind=relay&sessionIds=${recipient}`, undefined, { headers: {} })).body,
      "session get": (await send("GET", `/api/queue/items/${itemId}?sessionId=${recipient}`, undefined, { headers: {} })).body,
      "session claim": (await send("POST", "/api/queue/pending", { sessionId: recipient }, { headers: {} })).body,
    };

    for (const [name, source] of Object.entries(sources)) {
      assert.ok(source.includes(String(itemId)), `${name} reads the relay`);
      for (const line of lines) assert.ok(!source.includes(line), `${name} holds "${line}"`);
    }
  });

  test("is first-wins: a second redaction changes nothing, its stamp included", async () => {
    const itemId = await seedRelay();
    assert.equal((await redact(itemId)).statusCode, 200);
    const first = await getItemRow(itemId);

    const second = await redact(itemId);

    assert.deepEqual([second.statusCode, second.json().error], [409, "already_redacted"]);
    assert.deepEqual(await getItemRow(itemId), first);
  });

  test("writes its audit row before it answers, naming the relay and the page-origin signal that admitted it", async () => {
    const itemId = await seedRelay();

    const response = await redact(itemId, undefined, { headers: { origin: `http://127.0.0.1:${PORT}` } });

    assert.equal(response.statusCode, 200, response.body);
    const rows = await getPrisma().auditLog.findMany({ where: { actionKind: "queue-relay.redact", targetId: itemId } });
    assert.deepEqual(rows.map((row) => [row.resultCode, row.targetTable, (row.payload as { change?: unknown } | null)?.change]), [["success", "queue-relay", { signal: "origin" }]]);
  });

  test("a redaction whose transaction rolls back after its audit row is written changes nothing and leaves the response's own error row", async () => {
    const itemId = await seedRelay();
    const before = await getItemRow(itemId);
    const prisma = getPrisma();
    const originalTransaction = prisma.$transaction.bind(prisma);
    (prisma as { $transaction: unknown }).$transaction = ((work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      originalTransaction(async (tx) => { await work(tx); throw new Error("forced rollback after the audit row"); })) as unknown as typeof prisma.$transaction;
    const audited = await buildApp(true);
    let response: LightMyRequestResponse;
    try {
      response = await audited.inject({ method: "POST", url: `/api/queue/owner/items/${itemId}/redact`, headers: { host: HOST, ...SAME_ORIGIN } });
      await delay(150);
    } finally {
      (prisma as { $transaction: unknown }).$transaction = originalTransaction;
      await audited.close();
    }

    assert.equal(response.statusCode, 503, response.body);
    assert.deepEqual(await getItemRow(itemId), before);
    const rows = await prisma.auditLog.findMany({ where: { actionKind: "queue-relay.redact", targetId: itemId } });
    assert.deepEqual(rows.map((row) => row.resultCode), ["error"]);
  });

  test("refuses replacement text, an owner message, a report, a request without the page-origin signal and any session route", async () => {
    const rows = [
      { name: "replacement text in the body", itemId: await seedRelay(), call: (id: bigint) => redact(id, { text: "nothing happened" }), status: 400 },
      { name: "an owner message", itemId: await seedItem(await seedSession(), { kind: "message", isFreeTextAllowed: false, status: "delivered", answeredAt: new Date(), answerRoute: "message", answerSignal: "fetch_metadata" }), call: (id: bigint) => redact(id), status: 409 },
      { name: "a report", itemId: await seedItem(await seedSession()), call: (id: bigint) => redact(id), status: 409 },
      { name: "no page-origin header", itemId: await seedRelay(), call: (id: bigint) => redact(id, undefined, { headers: {} }), status: 403 },
      { name: "a session route", itemId: await seedRelay(), call: (id: bigint) => send("POST", `/api/queue/items/${id}/redact`, { sessionId: randomUUID() }, { headers: {} }), status: 404 },
    ];
    for (const row of rows) {
      const before = await getItemRow(row.itemId);
      const response = await row.call(row.itemId);
      assert.equal(response.statusCode, row.status, `${row.name}: ${response.body}`);
      assert.deepEqual(await getItemRow(row.itemId), before, row.name);
    }
  });
});
