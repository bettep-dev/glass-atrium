// Route test for /api/architecture/live — pins the response key set, so a field retired from the
// contract cannot return through the route composition unnoticed.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/architecture.live.route.test.ts
// DB: real Postgres (read-only) — overlay signals degrade to fallbacks, never abort.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { resetOverlayCache } from "../src/server/architecture/live-overlay.js";
import { disconnectPrisma } from "../src/server/db.js";
import { registerArchitectureRoutes } from "../src/server/routes/architecture.js";

const LIVE_RESPONSE_KEYS = [
  "computed_at",
  "daemons",
  "governance",
  "part_bindings",
  "recent_activity",
  "writers",
];

let app: FastifyInstance;

before(async () => {
  resetOverlayCache();
  app = Fastify({ logger: false });
  await registerArchitectureRoutes(app);
  await app.ready();
});

after(async () => {
  resetOverlayCache();
  try {
    await app.close();
  } catch {
    // best-effort
  }
  await disconnectPrisma();
});

test("GET /api/architecture/live: 200 body carries exactly the overlay keys plus governance", async () => {
  const res = await app.inject({ method: "GET", url: "/api/architecture/live" });

  assert.strictEqual(res.statusCode, 200, `unexpected status, body: ${res.body}`);
  assert.deepStrictEqual(Object.keys(res.json() as object).sort(), LIVE_RESPONSE_KEYS);
});
