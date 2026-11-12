// Owner queue API (/api/queue/owner/*): page-origin leg, list and item detail, answer, later, seen, reply, resend.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/queue.owner-api.route.test.ts

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";

import type { Prisma } from "../src/generated/prisma/client.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
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
  await unlockQueueRows();
  await disconnectPrisma();
  deleteDirectory(fixtureRoot);
});

async function buildApp(): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  await registerQueueRoutes(instance, { port: PORT, homeDir: path.join(fixtureRoot, "home"), cliPath: CLI_PATH });
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

  test("one unknown or replaced target refuses the whole send", async () => {
    const live = await seedSession();
    const replaced = await seedSession({ state: "exited", exitReason: "replaced" });
    const rows = [
      { name: "an unknown session id", sessionIds: [live, randomUUID()], status: 404, error: "unknown_session" },
      { name: "a replaced session", sessionIds: [live, replaced], status: 409, error: "session_replaced" },
    ];
    for (const row of rows) {
      const response = await send("POST", "/api/queue/owner/messages/send", { sessionIds: row.sessionIds, text: "Rebase onto main." });
      assert.deepEqual([response.statusCode, response.json().error], [row.status, row.error], row.name);
    }
    assert.equal((await getMessages([live, replaced])).length, 0);
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
