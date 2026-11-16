// Remote audit rows name their target: a remote mutation's row records what it acted on —
// numeric id from the route, member ids, image id, agent name and mode, the document fields a PUT changed, and the
// deleted document's id, title and content hash — never a body or a credential value.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/remote-audit-target.route.test.ts

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { buildRemoteApp } from "../src/server/app.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { resetDocsRootCache } from "../src/server/clauded-docs/storage.js";
import type { AuditTarget } from "../src/server/middleware/audit-log.js";
import { DeviceConnections } from "../src/server/remote/connections.js";
import type { DeviceSummary } from "../src/server/remote/devices.js";
import type { RemoteAuditEntry, RemoteAuditResult } from "../src/server/remote/gate.js";
import { RegistrationCodes } from "../src/server/remote/registration-code.js";
import { getRouteClass } from "../src/server/remote/route-classes.js";
import { CSRF_HEADER, DEVICE_COOKIE, getCsrfToken } from "../src/server/remote/session.js";
import { registerClaudedDocsRoutes } from "../src/server/routes/clauded-docs.js";
import { deleteDirectory } from "./lib/remove-dir.js";
import { lockQueueRows, unlockQueueRows } from "./lib/queue-rows-lock.js";
import { createStandInTls } from "./lib/remote-tls.js";

const HOST = "owner-mac.local:16146";
const ORIGIN = `https://${HOST}`;
const PHONE = "192.168.0.31";
const SUITE_MARKER = `remote-audit-target-${randomUUID()}`;
// a real 3 × 2 PNG (queue.images.route.test.ts → IMAGE.png)
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEElEQVR4nGP4z8AAQQxwFgBB0gX7h/C5SAAAAABJRU5ErkJggg==", "base64");

interface AuditRow {
  entry: RemoteAuditEntry;
  result?: RemoteAuditResult;
  target?: AuditTarget;
}

const fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "remote-audit-target-")));
const rows = new Map<bigint, AuditRow>();
const presented = randomBytes(32).toString("base64url");
const device: DeviceSummary = { id: 41n, label: "Owner phone" };
const trackedImageIds: string[] = [];
let nextAuditId = 1n;
let remote: FastifyInstance;
let local: FastifyInstance;
let tlsDir = "";

before(async () => {
  await lockQueueRows();
  process.env.CLAUDED_DOCS_HTML_ROOT = path.join(fixtureRoot, "docs");
  // the agent delete spawns nothing real → a missing interpreter answers 500 after the handler names its target
  process.env.AGENT_LIFECYCLE_PYTHON = path.join(fixtureRoot, "no-python");
  process.env.AGENT_LIFECYCLE_CWD = fixtureRoot;
  resetDocsRootCache();
  const tls = await createStandInTls();
  tlsDir = tls.dir;
  const getHosts = () => new Set([HOST]);
  const getPageOrigins = () => new Set([ORIGIN]);
  remote = await buildRemoteApp({
    tls,
    listener: { kind: "remote", getHosts, getPageOrigins },
    gate: {
      getHosts,
      getPageOrigins,
      findDevice: async (value) => (value === presented ? device : null),
      getRouteClass,
      preAuthRoutes: new Set(),
      connections: new DeviceConnections(),
      audit: {
        insertIntent: async (entry) => {
          const id = nextAuditId++;
          rows.set(id, { entry });
          return id;
        },
        setResult: async (id, result, target) => {
          const row = rows.get(id);
          if (row !== undefined) rows.set(id, { ...row, result, ...(target === undefined ? {} : { target }) });
        },
        insertEvent: async () => undefined,
      },
    },
    registration: { codes: new RegistrationCodes(), createDevice: async () => ({ outcome: "cap_reached" }) },
    device: { revoke: async () => false, revokeAll: async () => [], turnOff: () => undefined },
    queue: { port: 16145, homeDir: path.join(fixtureRoot, "home"), cliPath: "/opt/atrium-test/scripts/atrium-queue.sh", imageDir: path.join(fixtureRoot, "images") },
  });
  await remote.ready();
  // documents are created by local agents only (POST /api/clauded-docs is agent class) → seeded over a loopback-style app
  local = Fastify({ logger: false });
  await registerClaudedDocsRoutes(local);
  await local.ready();
});

after(async () => {
  await remote.close();
  await local.close();
  const prisma = getPrisma();
  await prisma.$executeRaw`DELETE FROM monitor.documents WHERE title LIKE ${`%${SUITE_MARKER}%`}`;
  await prisma.queueImage.deleteMany({ where: { id: { in: trackedImageIds } } });
  await unlockQueueRows();
  await disconnectPrisma();
  delete process.env.CLAUDED_DOCS_HTML_ROOT;
  delete process.env.AGENT_LIFECYCLE_PYTHON;
  delete process.env.AGENT_LIFECYCLE_CWD;
  resetDocsRootCache();
  deleteDirectory(fixtureRoot);
  deleteDirectory(tlsDir);
});

function getHtmlBody(salt: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>x</title></head><body><main><h1>${salt}</h1><p>body ${salt}</p></main></body></html>`;
}

async function createDoc(label: string): Promise<{ id: number; title: string; contentHash: string }> {
  const title = `${SUITE_MARKER}-${label}-${randomUUID()}`;
  const response = await local.inject({ method: "POST", url: "/api/clauded-docs", payload: { title, author: "test", html_body: getHtmlBody(randomUUID()) } });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json() as { id: number; content_hash: string };
  return { id: body.id, title, contentHash: body.content_hash };
}

/** One admitted remote mutation → the audit row the gate wrote for it. */
async function sendRemote(input: { method: "POST" | "PUT" | "PATCH" | "DELETE"; url: string; payload?: object | Buffer; contentType?: string }): Promise<{ status: number; body: string; row: AuditRow }> {
  const before = nextAuditId;
  const response = await remote.inject({
    method: input.method,
    url: input.url,
    remoteAddress: PHONE,
    headers: {
      host: HOST,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      cookie: `${DEVICE_COOKIE.NAME}=${presented}`,
      [CSRF_HEADER]: getCsrfToken(presented),
      ...(input.contentType === undefined ? {} : { "content-type": input.contentType }),
    },
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  });
  const row = rows.get(before);
  assert.ok(row !== undefined && nextAuditId === before + 1n, `one intent row for ${input.method} ${input.url}: ${response.statusCode} ${response.body}`);
  return { status: response.statusCode, body: response.body, row };
}

describe("a remote mutation's audit row", () => {
  test("the multi-document export records the requested ids, even when none of them exists", async () => {
    const ids = [987654301, 987654302];
    const { row } = await sendRemote({ method: "POST", url: "/api/clauded-docs/html-export", payload: { ids } });
    assert.deepEqual(row.target, { ids });
  });

  test("names the numeric id from the route at intent, before the handler runs", async () => {
    const { row } = await sendRemote({ method: "PATCH", url: "/api/outcomes/987654321/close" });
    assert.equal(row.entry.targetId, 987654321n);
  });

  test("the document PUT records its id and exactly which of title, audience, doc_status and format changed", async () => {
    const doc = await createDoc("put");
    const { status, body, row } = await sendRemote({
      method: "PUT",
      url: `/api/clauded-docs/${doc.id}`,
      payload: { expected_hash: doc.contentHash, html_body: getHtmlBody(randomUUID()), title: `${doc.title}-renamed`, doc_status: "done" },
    });
    assert.equal(status, 200, body);
    assert.deepEqual([row.entry.targetId, row.result, row.target], [BigInt(doc.id), "success", { id: doc.id, changed: ["title", "doc_status"] }]);
  });

  test("the document DELETE records the id, title and content hash taken from the deleted row", async () => {
    const doc = await createDoc("delete");
    const { status, row } = await sendRemote({ method: "DELETE", url: `/api/clauded-docs/${doc.id}` });
    assert.equal(status, 200);
    assert.deepEqual([row.entry.targetId, row.result, row.target], [BigInt(doc.id), "success", { id: doc.id, title: doc.title, contentHash: doc.contentHash }]);
  });

  test("group create and ungroup record the member ids", async () => {
    const [first, second] = [await createDoc("group-a"), await createDoc("group-b")];
    const memberIds = [first.id, second.id];
    const grouped = await sendRemote({ method: "POST", url: "/api/clauded-docs/group", payload: { member_ids: memberIds } });
    const ungrouped = await sendRemote({ method: "POST", url: "/api/clauded-docs/ungroup", payload: { member_ids: memberIds } });
    assert.deepEqual(
      [grouped.status, grouped.row.target, ungrouped.status, ungrouped.row.target],
      [200, { memberIds }, 200, { memberIds }],
    );
  });

  test("the image upload records the stored image's id", async () => {
    const { status, body, row } = await sendRemote({ method: "POST", url: "/api/queue/owner/images?name=shot.png", payload: PNG, contentType: "image/png" });
    assert.equal(status, 201, body);
    const imageId = (JSON.parse(body) as { id: string }).id;
    trackedImageIds.push(imageId);
    assert.deepEqual(row.target, { imageId });
  });

  test("the agent delete records the agent name and mode the handler validated", async () => {
    const { row } = await sendRemote({ method: "DELETE", url: "/api/agents/no-such-agent-audit", payload: { mode: "preview" } });
    assert.deepEqual(row.target, { agent: "no-such-agent-audit", mode: "preview" });
  });

  test("never carries the request body or the device cookie", async () => {
    const doc = await createDoc("no-body");
    const secretSalt = randomUUID();
    const { row } = await sendRemote({ method: "PUT", url: `/api/clauded-docs/${doc.id}`, payload: { expected_hash: doc.contentHash, html_body: getHtmlBody(secretSalt) } });
    const recorded = JSON.stringify(row, (_key, value: unknown) => (typeof value === "bigint" ? String(value) : value));
    assert.ok(!recorded.includes(secretSalt) && !recorded.includes(presented), recorded);
  });
});
