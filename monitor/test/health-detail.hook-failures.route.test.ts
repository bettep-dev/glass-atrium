// Integration tests for /api/health/hook-failures recency aggregates (F08) and the
// window-independent last-record time: an empty days window and an empty table are
// different facts, and only the second one means the hook has never failed.
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

interface HookFailuresBody {
  days: number;
  failures: Array<{ failure_ts: string }>;
  last_failure_ts: string | null;
}

async function getFailures(query = ""): Promise<HookFailuresBody> {
  const res = await app.inject({ method: "GET", url: `/api/health/hook-failures${query}` });
  assert.strictEqual(res.statusCode, 200);
  return res.json() as HookFailuresBody;
}

test("GET /api/health/hook-failures: last_failure_ts is the whole-table MAX, not the windowed one", async () => {
  const body = await getFailures();
  // The new field is an addition — the default window it sits beside stays 30.
  assert.strictEqual(body.days, 30, "default days window must stay 30");
  assert.ok(
    body.last_failure_ts === null || !Number.isNaN(Date.parse(body.last_failure_ts)),
    "last_failure_ts is null or an ISO instant",
  );

  const prisma = getPrisma();
  const truth = await prisma.$queryRaw<Array<{ cnt: bigint; last_failure_ts: Date | null }>>`
    SELECT COUNT(*)::bigint AS cnt, MAX(failure_ts) AS last_failure_ts FROM core.hook_failures
  `;
  const expected = truth[0]?.last_failure_ts ?? null;
  assert.strictEqual(
    body.last_failure_ts,
    expected === null ? null : expected.toISOString(),
    "an aggregate computed inside the window predicate would go null on a quiet 30 days",
  );
  // The one flip the field is allowed: empty table, not empty window. Pinned against the
  // table count so it stays an assertion whatever the corpus holds on the day it runs.
  assert.strictEqual(
    body.last_failure_ts === null,
    Number(truth[0]?.cnt ?? 0n) === 0,
    "a quiet window must never read as 'this hook has never failed'",
  );
});

test("GET /api/health/hook-failures: last_failure_ts does not move with the days param", async () => {
  const narrow = await getFailures("?days=7");
  const wide = await getFailures("?days=90");
  assert.strictEqual(narrow.days, 7);
  assert.strictEqual(wide.days, 90);
  // Two absent fields compare equal, so presence is asserted before the comparison.
  assert.ok("last_failure_ts" in narrow, "every response carries the field, not only the default one");
  assert.ok("last_failure_ts" in wide, "every response carries the field, not only the default one");
  assert.strictEqual(
    narrow.last_failure_ts,
    wide.last_failure_ts,
    "the last-record time is a property of the table, not of the requested window",
  );
  // Rows inside a window can never be newer than the whole-table maximum.
  for (const failure of narrow.failures) {
    assert.ok(
      narrow.last_failure_ts !== null && failure.failure_ts <= narrow.last_failure_ts,
      `windowed failure ${failure.failure_ts} must not postdate ${narrow.last_failure_ts}`,
    );
  }
});
