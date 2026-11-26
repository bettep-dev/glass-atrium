// Scan-approval routes: the session-only register and consume routes, the owner's no-store read of a pending
// request's lines, and the item views that carry the request facts but never a line.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/queue.scan-approvals.route.test.ts
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import "dotenv/config";

import Fastify, { type FastifyBaseLogger, type FastifyInstance, type LightMyRequestResponse } from "fastify";
import pino from "pino";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerAuditLogHook } from "../src/server/middleware/audit-log.js";
import { SECRET_APPROVAL_CODE } from "../src/server/queue/items.js";
import { getLineDisplay, getLineHash, secretRequests } from "../src/server/queue/scan-approvals.js";
import { getRouteClass } from "../src/server/remote/route-classes.js";
import { registerQueueRoutes } from "../src/server/routes/queue.js";
import { lockQueueRows, unlockQueueRows } from "./lib/queue-rows-lock.js";
import { deleteDirectory } from "./lib/remove-dir.js";

const PORT = 16145;
const HOST = `127.0.0.1:${PORT}`;
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" } as const;
const REGISTER = "/api/queue/scan-approvals";
const CONSUME = "/api/queue/scan-approvals/consume";
const WRITE_PATH = "/Users/owner/Desktop/git/glass-atrium/monitor/src/server/config.ts";
const AGENT = { id: "a3f9c2d17b4e8f05", type: "glass-atrium-dev-node" } as const;

const AUDITED_RESOURCES = ["queue-scan-approval", "queue-item"];

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "queue-scan-approvals-"));
const suiteStart = new Date();
const trackedSessionIds: string[] = [];
let logged = "";
let app: FastifyInstance;

before(async () => {
  await lockQueueRows();
  const sink = new Writable({
    write(chunk, _encoding, done) {
      logged += String(chunk);
      done();
    },
  });
  const loggerInstance: FastifyBaseLogger = pino({ level: "trace" }, sink);
  app = Fastify({ loggerInstance });
  registerAuditLogHook(app);
  const options = { port: PORT, homeDir: path.join(fixtureRoot, "home"), cliPath: "/opt/atrium-test/scripts/atrium-queue.sh" };
  await registerQueueRoutes(app, { ...options, imageDir: path.join(fixtureRoot, "images"), scannerPath: "/opt/atrium-test/scripts/lib/secret-scan.sh" });
  await app.ready();
});

after(async () => {
  await app.close();
  const prisma = getPrisma();
  await prisma.queueDelivery.deleteMany({ where: { item: { sessionId: { in: trackedSessionIds } } } });
  await prisma.queueItem.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await prisma.queueSession.deleteMany({ where: { sessionId: { in: trackedSessionIds } } });
  await prisma.auditLog.deleteMany({ where: { targetTable: { in: AUDITED_RESOURCES }, eventTs: { gte: suiteStart } } });
  await unlockQueueRows();
  await disconnectPrisma();
  deleteDirectory(fixtureRoot);
});

/** A captured line holding a fresh sentinel → its absence from a response, a log or a dump is checkable. */
interface CapturedLine {
  sentinel: string;
  text: string;
}

function createLine(): CapturedLine {
  const sentinel = `sentinel${randomUUID().replaceAll("-", "")}`;
  return { sentinel, text: `${sentinel} = "${randomUUID()}"` };
}

function send(method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return app.inject({ method, url, headers: { host: HOST, ...headers }, ...(body === undefined ? {} : { payload: body as object }) });
}

async function seedSession(): Promise<string> {
  const sessionId = randomUUID();
  trackedSessionIds.push(sessionId);
  await getPrisma().queueSession.create({
    data: {
      sessionId,
      isConfigDirSet: false,
      profileLabel: "default",
      cwd: "/Users/owner/Desktop/git/glass-atrium/monitor",
      processStartTime: "Mon Nov  9 08:01:12 2026",
      state: "live",
      lastSeenAt: new Date(),
      pid: 700_000 + Math.floor(Math.random() * 100_000),
    },
  });
  return sessionId;
}

function getRegisterBody(sessionId: string, line: CapturedLine): object {
  return { sessionId, agent: AGENT, path: WRITE_PATH, rule: "SEC-013", lines: [{ text: line.text, hash: getLineHash(line.text) }] };
}

function getConsumeBody(sessionId: string, line: CapturedLine): object {
  return { sessionId, path: WRITE_PATH, rule: "SEC-013", hashes: [getLineHash(line.text)] };
}

async function register(sessionId: string, line: CapturedLine): Promise<string> {
  const response = await send("POST", REGISTER, getRegisterBody(sessionId, line));
  assert.equal(response.statusCode, 200, response.body);
  return response.json().requestId;
}

/** Register, the session's secret-approval post, and optionally the owner's approve → the item id. */
async function postApproval(sessionId: string, line: CapturedLine, isApproved = false): Promise<{ itemId: number; requestId: string }> {
  const requestId = await register(sessionId, line);
  const posted = await send("POST", "/api/queue/items", { kind: "secret-approval", sessionId, requestId });
  assert.equal(posted.statusCode, 201, posted.body);
  const itemId: number = posted.json().id;
  if (isApproved) {
    const answered = await send("POST", `/api/queue/owner/items/${itemId}/answer`, { code: SECRET_APPROVAL_CODE.APPROVE }, SAME_ORIGIN);
    assert.equal(answered.statusCode, 200, answered.body);
  }
  return { itemId, requestId };
}

/** The session's scan-approval audit payloads, oldest first, once `count` have landed → the hook writes after the reply, unawaited. */
async function findAuditPayloads(sessionId: string, count: number): Promise<unknown[]> {
  const where = { targetTable: "queue-scan-approval", payload: { path: ["change", "sessionId"], equals: sessionId } };
  for (let attempt = 0; attempt < 40 && (await getPrisma().auditLog.count({ where })) < count; attempt += 1) await delay(25);
  const rows = await getPrisma().auditLog.findMany({ where, orderBy: { id: "asc" }, select: { payload: true } });
  return rows.map((row) => row.payload);
}

/** The scratch database's data as pg_dump writes it; the connection comes from the environment, never an argument. */
function dumpDatabase(): Promise<string> {
  const url = new URL(process.env.DATABASE_URL ?? "");
  const env = {
    PATH: process.env.PATH ?? "",
    PGHOST: url.searchParams.get("host") ?? url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
  };
  return new Promise((resolve, reject) => {
    const child = spawn("pg_dump", ["--data-only"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (errors += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`pg_dump exited ${code}: ${errors}`))));
  });
}

describe("register and consume — session-only routes", () => {
  test("a browser signal on either route is refused 403 before any work; an approval survives a refused consume and passes header-less", async () => {
    const sessionId = await seedSession();
    const line = createLine();
    await postApproval(sessionId, line, true);
    const rows: Array<{ name: string; headers: Record<string, string> }> = [
      { name: "foreign Origin", headers: { origin: "https://evil.example" } },
      { name: "loopback Origin on another port", headers: { origin: "http://127.0.0.1:5173" } },
      { name: "fetch metadata same-origin", headers: { "sec-fetch-site": "same-origin" } },
      { name: "fetch mode alone", headers: { "sec-fetch-mode": "cors" } },
      { name: "Referer alone", headers: { referer: `http://${HOST}/queue` } },
      { name: "Cookie alone", headers: { cookie: "theme=dark" } },
    ];
    for (const row of rows) {
      const registered = await send("POST", REGISTER, getRegisterBody(sessionId, createLine()), row.headers);
      const consumed = await send("POST", CONSUME, getConsumeBody(sessionId, line), row.headers);
      const replies = [registered, consumed].map((response) => [response.statusCode, response.json().error]);
      assert.deepEqual(replies, [[403, "browser_request_refused"], [403, "browser_request_refused"]], row.name);
    }
    const passed = await send("POST", CONSUME, getConsumeBody(sessionId, line));
    assert.deepEqual([passed.statusCode, passed.json().decision], [200, "pass"]);
  });

  test("the register and consume routes are agent class, absent from the remote listener; the owner read is page class, as the answer route", () => {
    const rows = [
      { route: ["POST", REGISTER], cls: "agent" },
      { route: ["POST", CONSUME], cls: "agent" },
      { route: ["GET", "/api/queue/owner/items/:id/scan-approval"], cls: "page" },
      { route: ["POST", "/api/queue/owner/items/:id/answer"], cls: "page" },
    ] as const;
    assert.deepEqual(rows.map((row) => getRouteClass(row.route[0], row.route[1])), rows.map((row) => row.cls));
  });

  test("consume reads its hashes from a POST body only: no GET route, and hashes in the query string are not read", async () => {
    const sessionId = await seedSession();
    const line = createLine();
    const { requestId } = await postApproval(sessionId, line, true);
    const hash = getLineHash(line.text);
    const query = `sessionId=${sessionId}&path=${encodeURIComponent(WRITE_PATH)}&rule=SEC-013&hashes=${hash}`;
    const asGet = await send("GET", `${CONSUME}?${query}`);
    const bodyless = await send("POST", `${CONSUME}?${query}`, { sessionId, path: WRITE_PATH, rule: "SEC-013" });
    assert.deepEqual([asGet.statusCode, bodyless.statusCode, secretRequests.find(requestId)?.state], [404, 400, "approved"]);
  });

  test("two parallel consumes of one approval over HTTP: exactly one passes, the other is refused, and each reply holds ids only", async () => {
    const sessionId = await seedSession();
    const line = createLine();
    const { requestId } = await postApproval(sessionId, line, true);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo; // listening on a TCP port → an AddressInfo, never a pipe name
    const payload = JSON.stringify(getConsumeBody(sessionId, line));
    const post = () =>
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const request = httpRequest({ host: "127.0.0.1", port, method: "POST", path: CONSUME, headers: { host: HOST, "content-type": "application/json" } }, (response) => {
          let text = "";
          response.on("data", (chunk) => (text += String(chunk)));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
        });
        request.on("error", reject);
        request.end(payload);
      });
    const replies = await Promise.all([post(), post()]);
    const sorted = replies.map((reply) => [reply.status, reply.body]).sort((left, right) => Number(left[0]) - Number(right[0]));
    assert.deepEqual(sorted, [
      [200, { decision: "pass", requestId }],
      [409, { error: "scan_approval_refused", decision: "refuse" }],
    ]);
  });
});

describe("validation failures", () => {
  test("a malformed or refused register body holding a sentinel is answered and logged without it", async () => {
    const sessionId = await seedSession();
    const rows = [
      { name: "a key named by the line", status: 400, build: (line: CapturedLine) => ({ ...getRegisterBody(sessionId, line), [line.text]: 1 }) },
      { name: "a line key inside a line entry", status: 400, build: (line: CapturedLine) => ({ ...getRegisterBody(sessionId, line), lines: [{ text: line.text, hash: getLineHash(line.text), [line.text]: 1 }] }) },
      { name: "the line where an array belongs", status: 400, build: (line: CapturedLine) => ({ ...getRegisterBody(sessionId, line), lines: line.text }) },
      { name: "the line as the session id", status: 400, build: (line: CapturedLine) => ({ ...getRegisterBody(sessionId, line), sessionId: line.text }) },
      { name: "a hash that is not its line's", status: 400, build: (line: CapturedLine) => ({ ...getRegisterBody(sessionId, line), lines: [{ text: line.text, hash: getLineHash(`${line.text} `) }] }) },
      { name: "a rule other than SEC-013", status: 400, build: (line: CapturedLine) => ({ ...getRegisterBody(sessionId, line), rule: "SEC-015" }) },
      { name: "an LF inside the line", status: 400, build: (line: CapturedLine) => ({ ...getRegisterBody(sessionId, line), lines: [{ text: `${line.text}\nx`, hash: getLineHash(`${line.text}\nx`) }] }) },
      { name: "a line over the store's byte limit in fewer characters, refused at the schema", status: 400, build: (line: CapturedLine) => ({ ...getRegisterBody(sessionId, line), lines: [{ text: `${line.text}${"é".repeat(2048)}`, hash: getLineHash(`${line.text}${"é".repeat(2048)}`) }] }) },
      { name: "more lines than a request holds", status: 422, build: (line: CapturedLine) => ({ ...getRegisterBody(sessionId, line), lines: Array.from({ length: 17 }, (_, index) => ({ text: `${line.text}${index}`, hash: getLineHash(`${line.text}${index}`) })) }) },
    ];
    for (const row of rows) {
      const line = createLine();
      const response = await send("POST", REGISTER, row.build(line));
      assert.deepEqual([response.statusCode, response.body.includes(line.sentinel), logged.includes(line.sentinel)], [row.status, false, false], `${row.name}: ${response.body}`);
    }
    const line = createLine();
    const unparsable = await app.inject({ method: "POST", url: REGISTER, headers: { host: HOST, "content-type": "application/json" }, payload: `{"lines":[{"text":"${line.text}"` });
    assert.deepEqual([unparsable.statusCode, unparsable.body.includes(line.sentinel), logged.includes(line.sentinel)], [400, false, false], unparsable.body);
  });
});

describe("owner read of a request's lines", () => {
  test("a pending request's lines come as the server's display form, no-store and private, beside its path, rule and agent type", async () => {
    const sessionId = await seedSession();
    const line = createLine();
    const { itemId } = await postApproval(sessionId, line);
    const response = await send("GET", `/api/queue/owner/items/${itemId}/scan-approval`);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual([response.headers["cache-control"], response.json()], [
      "private, no-store",
      { path: WRITE_PATH, rule: "SEC-013", agentType: AGENT.type, lines: [{ hash: getLineHash(line.text), ...getLineDisplay(line.text) }] },
    ]);
  });

  test("an item with no pending lines has nothing to read, and every refusal is private, no-store: approved, declined, a plain decision, an unknown id, a malformed id or query", async () => {
    const sessionId = await seedSession();
    const declined = await postApproval(sessionId, createLine());
    await send("POST", `/api/queue/owner/items/${declined.itemId}/answer`, { code: SECRET_APPROVAL_CODE.DECLINE }, SAME_ORIGIN);
    const plain = await send("POST", "/api/queue/items", {
      kind: "decision",
      sessionId,
      title: "Index",
      body: "Keep the index?",
      options: [{ code: "R1", label: "Keep", pros: "reads", cons: "writes" }, { code: "R2", label: "Drop", pros: "writes", cons: "reads" }],
      recommendedCode: "R1",
    });
    const rows = [
      { name: "approved", itemId: (await postApproval(sessionId, createLine(), true)).itemId, reply: [409, "secret_request_gone"] },
      { name: "declined", itemId: declined.itemId, reply: [409, "secret_request_gone"] },
      { name: "a plain decision", itemId: plain.json().id as number, reply: [404, "not_scan_approval"] },
      { name: "an unknown id", itemId: 2_000_000_000, reply: [404, "unknown_item"] },
      { name: "a malformed id, refused before the work", itemId: "1x", reply: [400, "invalid_id"] },
      { name: "a query key, refused before the work", itemId: declined.itemId, query: "?view=raw", reply: [400, "invalid_input"] },
    ];
    for (const row of rows) {
      const response = await send("GET", `/api/queue/owner/items/${row.itemId}/scan-approval${row.query ?? ""}`);
      assert.deepEqual([response.statusCode, response.json().error, response.headers["cache-control"]], [...row.reply, "private, no-store"], row.name);
    }
  });
});

describe("the line never leaves the store but by the owner read", () => {
  test("no read carries the line: the owner list, item detail and done thread carry the request facts beside the server-written title and body; the badge count, listener count and the session's own claim and fetch carry neither", async () => {
    const sessionId = await seedSession();
    const { pid } = await getPrisma().queueSession.findUniqueOrThrow({ where: { sessionId }, select: { pid: true } });
    const line = createLine();
    const { itemId } = await postApproval(sessionId, line);
    const listed = await send("GET", `/api/queue/owner/items?sessionId=${sessionId}`);
    const pendingFacts = listed.json().items.find((item: { id: number }) => item.id === itemId)?.scanApproval;
    assert.deepEqual({ ...pendingFacts, expiresAt: typeof pendingFacts?.expiresAt }, { state: "pending", lineCount: 1, expiresAt: "string" });
    await send("POST", `/api/queue/owner/items/${itemId}/answer`, { code: SECRET_APPROVAL_CODE.APPROVE }, SAME_ORIGIN);
    const payloads = [
      listed,
      await send("GET", `/api/queue/owner/items/${itemId}`),
      await send("GET", `/api/queue/owner/orders?kind=item&sessionIds=${sessionId}`),
      await send("GET", "/api/queue/count"),
      await send("POST", "/api/queue/pending/count", { sessionId, pid }),
      await send("POST", "/api/queue/pending", { sessionId }),
      await send("GET", `/api/queue/items/${itemId}?sessionId=${sessionId}`),
    ];
    assert.deepEqual(payloads.map((response) => [response.statusCode, response.body.includes(line.sentinel)]), payloads.map(() => [200, false]));
    // the listener count and the claim name this item → their line-free replies are about it, not empty
    const claimedIds = payloads[5]?.json().items.map((claim: { id: { item: number } }) => claim.id.item);
    assert.deepEqual([payloads[1]?.json().scanApproval.state, payloads[4]?.json().answeredItemIds, claimedIds], ["approved", [itemId], [itemId]]);
  });

  test("a sentinel line through register, approve, consume and a spent consume, and a rejected register, leave it in no monitor log and no database row; the audit rows name route, session and request id only", async () => {
    const sessionId = await seedSession();
    const line = createLine();
    const { requestId } = await postApproval(sessionId, line, true);
    const consumed = await send("POST", CONSUME, getConsumeBody(sessionId, line));
    const spent = await send("POST", CONSUME, getConsumeBody(sessionId, line));
    const rejected = createLine();
    const refused = await send("POST", REGISTER, { ...getRegisterBody(sessionId, rejected), rule: "SEC-015" });
    const audited = await findAuditPayloads(sessionId, 3);
    const dump = await dumpDatabase();
    // the item row's request id in the dump → the dump holds this test's rows
    assert.deepEqual(
      [consumed.statusCode, spent.statusCode, refused.statusCode, dump.includes(requestId), dump.includes(line.sentinel), dump.includes(rejected.sentinel), dump.includes(getLineHash(line.text)), logged.includes(line.sentinel), logged.includes(rejected.sentinel)],
      [200, 409, 400, true, false, false, false, false, false],
    );
    assert.deepEqual(audited, [
      { method: "POST", route: REGISTER, status_code: 200, change: { sessionId, requestId } },
      { method: "POST", route: CONSUME, status_code: 200, change: { sessionId, requestId } },
      { method: "POST", route: CONSUME, status_code: 409, change: { sessionId } },
    ]);
  });
});
