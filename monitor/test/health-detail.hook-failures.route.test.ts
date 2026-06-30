// Integration tests for /api/health/hook-failures recency aggregates (F08).
// Runner: npx tsx --test test/health-detail.hook-failures.route.test.ts
// DB: real Postgres (read-only) — asserts shape + invariants, not fixture values.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerHealthDetailRoutes } from "../src/server/routes/health-detail.js";

let app: FastifyInstance;

before(async () => {
  app = Fastify({ logger: false });
  await registerHealthDetailRoutes(app);
  await app.ready();
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  await disconnectPrisma();
});

test("GET /api/health/hook-failures: count_24h/unretried_count_24h shape + invariants", async () => {
  const res = await app.inject({ method: "GET", url: "/api/health/hook-failures" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    days: number;
    failures: Array<{ failure_ts: string; retry_attempted: boolean }>;
    count_24h: number;
    unretried_count_24h: number;
    timezone: string;
  };

  assert.ok(Number.isInteger(body.count_24h) && body.count_24h >= 0, "count_24h is a non-negative integer");
  assert.ok(
    Number.isInteger(body.unretried_count_24h) && body.unretried_count_24h >= 0,
    "unretried_count_24h is a non-negative integer",
  );
  // unretried is a strict subset of the 24h population.
  assert.ok(
    body.unretried_count_24h <= body.count_24h,
    `unretried_count_24h (${body.unretried_count_24h}) <= count_24h (${body.count_24h})`,
  );

  // Cross-check against direct DB ground truth — the aggregate must be
  // days-param independent (fixed 24h window, not the row-list window).
  const prisma = getPrisma();
  const truth = await prisma.$queryRaw<Array<{ cnt: bigint; unretried: bigint }>>`
    SELECT
      COUNT(*)::bigint AS cnt,
      COUNT(*) FILTER (WHERE retry_attempted = FALSE)::bigint AS unretried
    FROM core.hook_failures
    WHERE failure_ts >= NOW() - INTERVAL '24 hours'
  `;
  assert.strictEqual(body.count_24h, Number(truth[0]?.cnt ?? 0n), "count_24h matches DB ground truth");
  assert.strictEqual(
    body.unretried_count_24h,
    Number(truth[0]?.unretried ?? 0n),
    "unretried_count_24h matches DB ground truth",
  );
});
