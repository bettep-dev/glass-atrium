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
//   - production attachment · main.ts calls registerRequestGuards before registerRoutes
//
// Test infra:
//   - No DB: the guards are route-agnostic, so two echo routes stand in for the 17 real
//     mutation routes and keep the assertions about the guards alone.
//   - App: stripped Fastify + registerRequestGuards() attached exactly as buildApp does,
//     then app.inject() — no port binding.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";

import { BODY_LIMIT_BYTES, registerRequestGuards } from "../src/server/request-guards.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_SRC = resolve(__dirname, "../src/server/main.ts");

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

// main.ts self-executes main() on import, so no test can import it and exercise buildApp —
// which leaves the single production attachment of the guards covered by nothing. Every test
// above would stay green with that one line deleted while all 17 mutation routes went
// unguarded. Anchor it on the source text instead (same shape as ui.review-flag-reasons.unit).
// Order is asserted too, not just presence: the body-limit leg rides an onRoute hook, which
// only sees routes registered after it.
test("attachment: main.ts registers the guards before the routes", () => {
  const src = readFileSync(MAIN_SRC, "utf8");
  const guardsAt = src.search(/registerRequestGuards\(\s*app\s*\)/);
  const routesAt = src.search(/registerRoutes\(\s*app\s*\)/);

  assert.notStrictEqual(guardsAt, -1, "main.ts must call registerRequestGuards(app)");
  assert.notStrictEqual(routesAt, -1, "main.ts must call registerRoutes(app)");
  assert.ok(
    guardsAt < routesAt,
    `registerRequestGuards(app) must precede registerRoutes(app) (got ${guardsAt} vs ${routesAt})`,
  );
});
