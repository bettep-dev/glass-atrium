// Integration tests for the mutation request guards (request-guards.ts).
//
// Runner: node:test (built-in) via tsx — npx tsx --test test/improvement.csrf-gate.test.ts
//
// Coverage:
//   - gate leg · sec-fetch-site decision rows (same-origin / none / cross-site / same-site)
//   - gate leg · origin fallback rows (absent / loopback / foreign / opaque / unparseable)
//   - gate leg · header-absence pass-through (curl + agent paths) and GET exemption
//   - parser leg · text/plain with a body → 415 (the one row a gate 403 cannot mask)
//   - body-limit leg · over-limit JSON → 413
//   - production assembly · guards ahead of the routes (queue owner route: text/plain → 415) and attached (cross-site → 403)
//
// Test infra:
//   - Stripped-app rows need no DB: the guards are route-agnostic, so two echo routes stand in for
//     the real mutation routes and keep the assertions about the guards alone.
//   - Assembly rows run the real buildApp with a mktemp secrets dir; their fire-and-forget audit
//     rows land in the test DB and are scrubbed in after().
//   - App: stripped Fastify + registerRequestGuards() attached exactly as buildApp does,
//     then app.inject() — no port binding.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { buildApp } from "../src/server/app.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { BODY_LIMIT_BYTES, registerRequestGuards } from "../src/server/request-guards.js";
import { deleteDirectory } from "./lib/remove-dir.js";


const EVIL_ORIGIN = "https://evil.example";
const LOOPBACK_ORIGIN = "http://127.0.0.1:16145";
const MUTATION_URL = "/api/test/mutate";
const READ_URL = "/api/test/read";

let app: FastifyInstance;

before(async () => {
  app = Fastify({ logger: false });
  registerRequestGuards(app);
  app.post(MUTATION_URL, async () => ({ ok: true }));
  app.get(READ_URL, async () => ({ ok: true }));
  await app.ready();
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
});

async function postMutation(
  headers: Record<string, string | string[]>,
  payload?: string,
): Promise<number> {
  const res = await app.inject({ method: "POST", url: MUTATION_URL, headers, payload });
  return res.statusCode;
}

// The strong form of the instruction requirement: onRequest runs before the body parser, so a
// cross-site simple POST is a deterministic 403 rather than "403 or 415".
test("gate: cross-origin simple POST (text/plain + cross-site) → 403, not 415", async () => {
  const res = await app.inject({
    method: "POST",
    url: MUTATION_URL,
    headers: {
      "content-type": "text/plain",
      origin: EVIL_ORIGIN,
      "sec-fetch-site": "cross-site",
    },
    payload: "{}",
  });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual((res.json() as { error: string }).error, "cross_origin_blocked");
});

test("gate: cross-origin JSON with sec-fetch-site cross-site → 403", async () => {
  const status = await postMutation(
    { "content-type": "application/json", origin: EVIL_ORIGIN, "sec-fetch-site": "cross-site" },
    "{}",
  );
  assert.strictEqual(status, 403);
});

// same-site (same host, different port) never reaches the port-agnostic loopback rule — the
// intended asymmetry between rule 2 and rule 4.
test("gate: sec-fetch-site same-site → 403 even from a loopback origin", async () => {
  const status = await postMutation(
    { "content-type": "application/json", origin: LOOPBACK_ORIGIN, "sec-fetch-site": "same-site" },
    "{}",
  );
  assert.strictEqual(status, 403);
});

test("gate: agent/curl JSON path — both signal headers absent → passes gate and parser", async () => {
  const status = await postMutation({ "content-type": "application/json" }, "{}");
  assert.strictEqual(status, 200);
});

// The existing `curl -X POST` agent habit: no body, no content-type, no signal headers.
test("gate: agent/curl body-less POST → passes (parsers only apply to bodied requests)", async () => {
  const res = await app.inject({ method: "POST", url: MUTATION_URL });
  assert.strictEqual(res.statusCode, 200);
});

// Proves the parser leg is really wired — the one row where a gate 403 cannot mask it.
test("parser: text/plain with a body and no signal headers → 415", async () => {
  const status = await postMutation({ "content-type": "text/plain" }, "hello");
  assert.strictEqual(status, 415);
});

test("gate: same-origin UI click → passes", async () => {
  const status = await postMutation(
    { "content-type": "application/json", origin: LOOPBACK_ORIGIN, "sec-fetch-site": "same-origin" },
    "{}",
  );
  assert.strictEqual(status, 200);
});

test("gate: address bar / bookmark (sec-fetch-site none) → passes", async () => {
  const status = await postMutation(
    { "content-type": "application/json", "sec-fetch-site": "none" },
    "{}",
  );
  assert.strictEqual(status, 200);
});

test("gate: older browser on loopback origin (no sec-fetch) → passes", async () => {
  const status = await postMutation(
    { "content-type": "application/json", origin: LOOPBACK_ORIGIN },
    "{}",
  );
  assert.strictEqual(status, 200);
});

test("gate: older browser on a foreign origin (no sec-fetch) → 403", async () => {
  const status = await postMutation(
    { "content-type": "application/json", origin: EVIL_ORIGIN },
    "{}",
  );
  assert.strictEqual(status, 403);
});

// `Origin: null` is the literal opaque-origin string, not header absence.
test("gate: opaque origin (literal null) → 403", async () => {
  const status = await postMutation({ "content-type": "application/json", origin: "null" }, "{}");
  assert.strictEqual(status, 403);
});

// An unparseable Origin must be a 403, never a URL-constructor 500.
test("gate: unparseable origin → 403, no 500", async () => {
  const status = await postMutation(
    { "content-type": "application/json", origin: "not a url" },
    "{}",
  );
  assert.strictEqual(status, 403);
});

// A duplicated Sec-Fetch-Site must not slip the check.
test("gate: duplicated sec-fetch-site carrying cross-site → 403", async () => {
  const status = await postMutation(
    { "content-type": "application/json", "sec-fetch-site": ["cross-site", "same-origin"] },
    "{}",
  );
  assert.strictEqual(status, 403);
});

test("gate: GET with sec-fetch-site cross-site → unaffected (non-mutation)", async () => {
  const res = await app.inject({
    method: "GET",
    url: READ_URL,
    headers: { origin: EVIL_ORIGIN, "sec-fetch-site": "cross-site" },
  });
  assert.strictEqual(res.statusCode, 200);
});

test("bodyLimit: JSON body over the stated limit → 413", async () => {
  const oversized = `{"pad":"${"x".repeat(BODY_LIMIT_BYTES)}"}`;
  const status = await postMutation({ "content-type": "application/json" }, oversized);
  assert.strictEqual(status, 413);
});

// Production assembly: the real buildApp, aimed at a queue owner mutation route inside the first
// encapsulated plugin. A child plugin copies its parent's content-type parsers when it loads, so the
// text/plain row fails if the guards ever move after registerRoutes; the cross-site row fails if the
// guards are missing from the assembly.
const ASSEMBLY = {
  HOST: "127.0.0.1:16145",
  PASSPHRASE: "csrf-gate assembly passphrase",
  ANSWER_URL: "/api/queue/owner/items/1/answer",
} as const;

async function withOwnerAssembly(run: (assembly: FastifyInstance, cookie: string) => Promise<void>): Promise<void> {
  const secretsDir = mkdtempSync(path.join(tmpdir(), "csrf-assembly-"));
  const salt = randomBytes(16);
  const hash = scryptSync(ASSEMBLY.PASSPHRASE, salt, 32, { N: 16_384, r: 8, p: 1 });
  const record = { algorithm: "scrypt", N: 16_384, r: 8, p: 1, keyLength: 32, salt: salt.toString("base64"), hash: hash.toString("base64") };
  writeFileSync(path.join(secretsDir, "owner-passphrase.json"), JSON.stringify(record), { mode: 0o600 });
  const assembly = await buildApp({ secretsDir });
  try {
    const login = await assembly.inject({
      method: "POST",
      url: "/api/queue/owner/login",
      headers: { host: ASSEMBLY.HOST },
      payload: { passphrase: ASSEMBLY.PASSPHRASE },
    });
    const cookie = login.cookies.find((entry) => entry.name === "atrium_queue_owner");
    assert.ok(cookie !== undefined, `owner login through the assembly failed: ${login.statusCode} ${login.body}`);
    await run(assembly, `atrium_queue_owner=${cookie.value}`);
  } finally {
    await assembly.close();
    deleteDirectory(secretsDir);
  }
}

test("assembly: text/plain with a body to a queue owner route, with a valid owner session → 415", async () => {
  await withOwnerAssembly(async (assembly, cookie) => {
    const res = await assembly.inject({
      method: "POST",
      url: ASSEMBLY.ANSWER_URL,
      headers: { host: ASSEMBLY.HOST, cookie, "content-type": "text/plain" },
      payload: '{"code":"R1"}',
    });
    assert.strictEqual(res.statusCode, 415, res.body);
  });
});

test("assembly: a cross-site mutation to a queue owner route is refused with 403 before its handler", async () => {
  await withOwnerAssembly(async (assembly, cookie) => {
    const res = await assembly.inject({
      method: "POST",
      url: ASSEMBLY.ANSWER_URL,
      headers: { host: ASSEMBLY.HOST, cookie, "content-type": "application/json", "sec-fetch-site": "cross-site", origin: EVIL_ORIGIN },
      payload: { code: "R1" },
    });
    assert.strictEqual(res.statusCode, 403, res.body);
  });
});

after(async () => {
  try {
    await getPrisma().$executeRaw`
      DELETE FROM monitor.audit_log
      WHERE actor = 'monitor-web'
        AND ((target_table = 'queue-owner' AND target_id IS NULL) OR (target_table = 'queue-item' AND target_id = 1))
        AND event_ts >= NOW() - INTERVAL '10 minutes'
    `;
  } finally {
    await disconnectPrisma();
  }
});
