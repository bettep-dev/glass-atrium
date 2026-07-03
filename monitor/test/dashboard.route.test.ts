// Integration tests for /api/dashboard/kpi (KPI panel).
// Runner: npx tsx --test test/dashboard.route.test.ts
// DB: real Postgres (read-only) — existing cost_events fixture drives assertions.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import {
  buildAgentMembershipFilter,
  loadCanonicalAgentKeys,
} from "../src/server/agents/registry.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerDashboardRoutes } from "../src/server/routes/dashboard.js";
import { DAY_BUCKET_TIMEZONE } from "../src/server/timezone.js";

let app: FastifyInstance;

before(async () => {
  app = Fastify({ logger: false });
  await registerDashboardRoutes(app);
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

test("GET /api/dashboard/kpi: happy path — 200 + full shape incl. 24h split fields", async () => {
  const res = await app.inject({ method: "GET", url: "/api/dashboard/kpi" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    today_cost_usd: number;
    yesterday_cost_usd: number;
    yesterday_same_time_cost_usd: number;
    last_1h_fail_count: number;
    fail_count_24h: number;
    blocked_count_24h: number;
    last_etl_at: string | null;
    today_session_count: number;
    yesterday_session_count: number;
    yesterday_same_time_session_count: number;
    timezone: "UTC";
    day_bucket_timezone: string;
  };

  assert.strictEqual(typeof body.yesterday_session_count, "number");
  assert.ok(Number.isInteger(body.yesterday_session_count), "yesterday_session_count is an integer");
  assert.ok(body.yesterday_session_count >= 0, "yesterday_session_count is non-negative");
  // Symmetric session-count pair both delivered so the client can compute a delta.
  assert.strictEqual(typeof body.today_session_count, "number");
  // 24h split (F05) — blocked separated from fail; both non-negative integers.
  assert.ok(Number.isInteger(body.fail_count_24h) && body.fail_count_24h >= 0, "fail_count_24h");
  assert.ok(
    Number.isInteger(body.blocked_count_24h) && body.blocked_count_24h >= 0,
    "blocked_count_24h",
  );
  // 1h legacy merge ⊆ 24h split — the widened window can never count fewer rows.
  assert.ok(
    body.last_1h_fail_count <= body.fail_count_24h + body.blocked_count_24h,
    "last_1h_fail_count <= fail_count_24h + blocked_count_24h",
  );
  // last_etl_at is a TRUE UTC instant (F01) — parseable, Z-suffixed, no fake-Z wall clock.
  if (body.last_etl_at !== null) {
    assert.ok(body.last_etl_at.endsWith("Z"), "last_etl_at carries a real Z suffix");
    assert.ok(!Number.isNaN(Date.parse(body.last_etl_at)), "last_etl_at parses as a date");
  }
  assert.strictEqual(body.timezone, "UTC");
  // 응답 echo = timezone.ts 가 해석한 설정값 (ATRIUM_TIMEZONE 미설정 → Asia/Seoul).
  assert.strictEqual(body.day_bucket_timezone, DAY_BUCKET_TIMEZONE);
});

test("GET /api/dashboard/kpi: yesterday_session_count mirrors the yesterday day-bucket", async () => {
  // Ground truth via the same config-tz-pinned bucket the route uses (F03) —
  // session-tz independent. Proves the field is bucketed identically to
  // yesterday_cost_usd. Oracle binds the same DAY_BUCKET_TIMEZONE as the route.
  const prisma = getPrisma();
  const oracle = await prisma.$queryRaw<Array<{ sessions: bigint }>>`
    SELECT COUNT(DISTINCT session_id)::bigint AS sessions
    FROM core.cost_events
    WHERE event_date = (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date - 1
  `;
  const expected = Number(oracle[0]?.sessions ?? 0n);

  const res = await app.inject({ method: "GET", url: "/api/dashboard/kpi" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as { yesterday_session_count: number };

  assert.strictEqual(
    body.yesterday_session_count,
    expected,
    "API yesterday_session_count matches the day-bucket ground truth",
  );
});

test("GET /api/dashboard/kpi: 24h fail/blocked split matches DB ground truth", async () => {
  const prisma = getPrisma();
  // Oracle binds the same registry-membership scope handleKpi applies to its
  // fail/blocked band. Concurrent membership-gate suites seed non-registry rows
  // into the shared 24h window the scoped route excludes → an unscoped oracle
  // would over-count against the route.
  const agentMembership = buildAgentMembershipFilter(await loadCanonicalAgentKeys());
  const oracle = await prisma.$queryRaw<Array<{ fails: bigint; blocked: bigint }>>`
    SELECT
      COUNT(*) FILTER (WHERE result = 'fail')::bigint    AS fails,
      COUNT(*) FILTER (WHERE result = 'blocked')::bigint AS blocked
    FROM core.outcomes
    WHERE result IN ('blocked', 'fail')
      AND record_ts > NOW() - INTERVAL '24 hours'
      ${agentMembership}
  `;
  const expectedFails = Number(oracle[0]?.fails ?? 0n);
  const expectedBlocked = Number(oracle[0]?.blocked ?? 0n);

  const res = await app.inject({ method: "GET", url: "/api/dashboard/kpi" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as { fail_count_24h: number; blocked_count_24h: number };

  assert.strictEqual(body.fail_count_24h, expectedFails, "fail_count_24h matches DB");
  assert.strictEqual(body.blocked_count_24h, expectedBlocked, "blocked_count_24h matches DB");
});

test("GET /api/dashboard/kpi: last_1h_fail_count counts fail-only, excluding blocked", async () => {
  // F-2: the 1h FILTER must carry result = 'fail' like its 24h sibling — a
  // blocked row inside the window must NOT inflate the fail counter. Oracle
  // applies the same fail-only predicate so a fail+blocked merge would diverge.
  const prisma = getPrisma();
  // Same registry-membership scope as the 24h oracle and handleKpi's band.
  const agentMembership = buildAgentMembershipFilter(await loadCanonicalAgentKeys());
  const oracle = await prisma.$queryRaw<Array<{ fails: bigint }>>`
    SELECT COUNT(*) FILTER (WHERE result = 'fail')::bigint AS fails
    FROM core.outcomes
    WHERE result IN ('blocked', 'fail')
      AND record_ts > NOW() - INTERVAL '1 hour'
      ${agentMembership}
  `;
  const expectedFails = Number(oracle[0]?.fails ?? 0n);

  const res = await app.inject({ method: "GET", url: "/api/dashboard/kpi" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as { last_1h_fail_count: number };

  assert.strictEqual(
    body.last_1h_fail_count,
    expectedFails,
    "last_1h_fail_count matches the fail-only 1h ground truth (blocked excluded)",
  );
});

// F10: yesterday cumulative cut at the current bucket-tz wall-clock time — the
// '어제 동시각 대비' delta basis must be a subset of the full-day aggregates.
test("GET /api/dashboard/kpi: same-time-of-day fields — shape + cumulative ⊆ full-day invariant", async () => {
  const res = await app.inject({ method: "GET", url: "/api/dashboard/kpi" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    yesterday_cost_usd: number;
    yesterday_same_time_cost_usd: number;
    yesterday_session_count: number;
    yesterday_same_time_session_count: number;
  };

  assert.strictEqual(typeof body.yesterday_same_time_cost_usd, "number");
  assert.ok(body.yesterday_same_time_cost_usd >= 0, "same-time cost is non-negative");
  assert.ok(
    Number.isInteger(body.yesterday_same_time_session_count) &&
      body.yesterday_same_time_session_count >= 0,
    "same-time session count is a non-negative integer",
  );
  // Cut-at-time subset can never exceed the full-day aggregate (cost_usd >= 0).
  // 1e-9 tolerance only absorbs float-conversion noise on the Decimal sums.
  assert.ok(
    body.yesterday_same_time_cost_usd <= body.yesterday_cost_usd + 1e-9,
    "yesterday_same_time_cost_usd <= yesterday_cost_usd",
  );
  assert.ok(
    body.yesterday_same_time_session_count <= body.yesterday_session_count,
    "yesterday_same_time_session_count <= yesterday_session_count",
  );
});

test("GET /api/dashboard/kpi: same-time-of-day fields match the time-cut ground truth", async () => {
  // Ground truth via the same config-tz-pinned bucket + wall-clock cut the route
  // uses. event_time is a bucket-tz wall-clock TIME column, so the ::time of
  // NOW() in that tz compares directly. Yesterday's rows are immutable; the
  // ms-scale NOW() drift between oracle and API queries is the same accepted
  // race as the 24h-window oracle.
  const prisma = getPrisma();
  const oracle = await prisma.$queryRaw<Array<{ cost: unknown; sessions: bigint }>>`
    SELECT
      COALESCE(SUM(cost_usd), 0)                AS cost,
      COUNT(DISTINCT session_id)::bigint        AS sessions
    FROM core.cost_events
    WHERE event_date = (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date - 1
      AND event_time <= (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::time
  `;
  const expectedCost = Number(String(oracle[0]?.cost ?? 0));
  const expectedSessions = Number(oracle[0]?.sessions ?? 0n);

  const res = await app.inject({ method: "GET", url: "/api/dashboard/kpi" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    yesterday_same_time_cost_usd: number;
    yesterday_same_time_session_count: number;
  };

  assert.ok(
    Math.abs(body.yesterday_same_time_cost_usd - expectedCost) < 1e-6,
    `yesterday_same_time_cost_usd matches the time-cut ground truth (api=${body.yesterday_same_time_cost_usd}, oracle=${expectedCost})`,
  );
  assert.strictEqual(
    body.yesterday_same_time_session_count,
    expectedSessions,
    "yesterday_same_time_session_count matches the time-cut ground truth",
  );
});

// GET /api/dashboard/daemon-status
test("GET /api/dashboard/daemon-status: board carries role-qualified daily-restart entries", async () => {
  const res = await app.inject({ method: "GET", url: "/api/dashboard/daemon-status" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    items: Array<{ daemon_name: string; expected_next_at: string | null }>;
    timezone: string;
  };
  assert.deepStrictEqual(
    body.items.map((i) => i.daemon_name),
    ["autoagent", "wiki", "daily-restart-autoagent", "daily-restart-wiki"],
    "fixed board order — legacy merged 'daily-restart' carries no card",
  );
  for (const item of body.items) {
    assert.ok(item.expected_next_at !== null, `${item.daemon_name} carries a next-fire schedule`);
  }
  assert.strictEqual(body.timezone, "UTC");
});
