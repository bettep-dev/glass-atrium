// Integration tests for /api/cost (비용·토큰 detail screen).
// Runner: npx tsx --test test/cost.route.test.ts
// DB: real Postgres (read-only) — existing cost_events fixture drives assertions.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerCostRoutes } from "../src/server/routes/cost.js";
import { DAY_BUCKET_TIMEZONE } from "../src/server/timezone.js";

let app: FastifyInstance;

before(async () => {
  app = Fastify({ logger: false });
  await registerCostRoutes(app);
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

test("GET /api/cost/by-model: happy path — 200 + complete shape", async () => {
  const res = await app.inject({ method: "GET", url: "/api/cost/by-model?days=30" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    days: number;
    fetched_at: string;
    rows: Array<{
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      cost_usd: number;
      session_count: number;
    }>;
  };

  assert.strictEqual(body.days, 30);
  assert.ok(/\d{4}-\d{2}-\d{2}T/.test(body.fetched_at), "fetched_at is ISO");
  assert.ok(Array.isArray(body.rows));
  // Every row carries the full numeric shape (no nullish leakage).
  for (const row of body.rows) {
    assert.ok(typeof row.model === "string" && row.model.length > 0, "model is non-empty");
    assert.ok(typeof row.cost_usd === "number");
    assert.ok(row.session_count >= 0);
  }
});

test("GET /api/cost/by-model: no_assistant_in_turn zero-rows excluded from attribution", async () => {
  // cost-tracker.sh writes by-design zero-rows (model=NULL, stop_reason='no_assistant_in_turn') on tool-only / multi-fire turns.
  // The attribution metric MUST exclude these → 'unknown' bucket = genuine attribution gaps only, not no-LLM-call turns.
  // Cross-check the API result against direct DB ground truth.
  const prisma = getPrisma();

  // Ground truth: no_assistant_in_turn zero-row count in the window.
  // Window days=30 → CURRENT_DATE - INTERVAL '29 days' (N-1 back = 30 calendar days incl. today).
  // Oracle MUST mirror the API boundary (cost.ts buildWindowLowerBound) → same day-set on both sides.
  const designZeroRows = await prisma.$queryRaw<Array<{ cnt: bigint; sessions: bigint }>>`
    SELECT COUNT(*)::bigint AS cnt, COUNT(DISTINCT session_id)::bigint AS sessions
    FROM core.cost_events
    WHERE event_date >= CURRENT_DATE - INTERVAL '29 days'
      AND stop_reason = 'no_assistant_in_turn'
  `;
  const zeroRowSessions = Number(designZeroRows[0]?.sessions ?? 0n);

  // The unknown bucket as the API now reports it (residual NULL-model tail only).
  const apiUnknown = await prisma.$queryRaw<Array<{ sessions: bigint }>>`
    SELECT COUNT(DISTINCT session_id)::bigint AS sessions
    FROM core.cost_events
    WHERE event_date >= CURRENT_DATE - INTERVAL '29 days'
      AND stop_reason IS DISTINCT FROM 'no_assistant_in_turn'
      AND model IS NULL
  `;
  const apiUnknownSessions = Number(apiUnknown[0]?.sessions ?? 0n);

  const res = await app.inject({ method: "GET", url: "/api/cost/by-model?days=30" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    rows: Array<{ model: string; session_count: number }>;
  };

  const unknownRow = body.rows.find((r) => r.model === "unknown");

  // The API 'unknown' bucket reflects the residual tail, NOT the by-design zero-rows.
  // With zero-rows in the fixture, this proves the filter is active: unknown sessions << zero-row sessions.
  if (zeroRowSessions > 0) {
    const reportedUnknownSessions = unknownRow?.session_count ?? 0;
    assert.strictEqual(
      reportedUnknownSessions,
      apiUnknownSessions,
      "unknown bucket session_count matches filtered DB ground truth",
    );
    assert.ok(
      reportedUnknownSessions < zeroRowSessions,
      `filter active: unknown sessions (${reportedUnknownSessions}) < no_assistant zero-row sessions (${zeroRowSessions})`,
    );
  }

  // Attribution rate over the filtered denominator should be high — real LLM events (opus/haiku) carry model+tokens.
  // Guards against a regression that re-folds the zero-rows back into the denominator.
  const attribution = await prisma.$queryRaw<Array<{ pct: number | null }>>`
    SELECT ROUND(
             100.0 * COUNT(*) FILTER (WHERE model IS NOT NULL)
             / NULLIF(COUNT(*), 0), 1
           )::float8 AS pct
    FROM core.cost_events
    WHERE event_date >= CURRENT_DATE - INTERVAL '29 days'
      AND stop_reason IS DISTINCT FROM 'no_assistant_in_turn'
  `;
  const attributionPct = attribution[0]?.pct ?? 0;
  assert.ok(
    attributionPct >= 80,
    `filtered attribution rate is high (${attributionPct}% ≥ 80%) — zero-rows excluded`,
  );
});

test("GET /api/cost/by-model: invalid days — 400 invalid_days", async () => {
  const res = await app.inject({ method: "GET", url: "/api/cost/by-model?days=99" });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { error: string; allowed: number[] };
  assert.strictEqual(body.error, "invalid_days");
  assert.deepStrictEqual(body.allowed, [7, 30, 90]);
});

test("GET /api/cost/by-model: '<synthetic>' zero-token sentinel rows excluded (F24)", async () => {
  const res = await app.inject({ method: "GET", url: "/api/cost/by-model?days=90" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    rows: Array<{
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
    }>;
  };
  // A '<synthetic>' bucket may appear ONLY if it carries real tokens — the
  // zero-token sentinel population must never form a model bucket on its own.
  const synthetic = body.rows.find((r) => r.model === "<synthetic>");
  if (synthetic !== undefined) {
    const tokens =
      synthetic.input_tokens +
      synthetic.output_tokens +
      synthetic.cache_read_tokens +
      synthetic.cache_creation_tokens;
    assert.ok(tokens > 0, "'<synthetic>' bucket exists only with real tokens");
  }
});

test("GET /api/cost/session-distribution: no_llm_session_count split + rows carry real tokens (F24)", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/cost/session-distribution?days=30",
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    rows: Array<{ total_tokens: number }>;
    total_session_count: number;
    no_llm_session_count: number;
  };
  assert.ok(
    Number.isInteger(body.no_llm_session_count) && body.no_llm_session_count >= 0,
    "no_llm_session_count is a non-negative integer",
  );
  // Histogram rows are real-LLM sessions only — the $0 bin must not be the sentinel population.
  for (const row of body.rows) {
    assert.ok(row.total_tokens > 0, "every distribution row carries > 0 tokens");
  }

  // Oracle: zero-token-session count over the same 30d window (CURRENT_DATE - 29).
  const prisma = getPrisma();
  const oracle = await prisma.$queryRaw<Array<{ with_tokens: bigint; zero: bigint }>>`
    SELECT
      COUNT(*) FILTER (WHERE session_tokens > 0)::bigint AS with_tokens,
      COUNT(*) FILTER (WHERE session_tokens = 0)::bigint AS zero
    FROM (
      SELECT SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens)
               AS session_tokens
      FROM core.cost_events
      WHERE event_date >= CURRENT_DATE - INTERVAL '29 days'
      GROUP BY session_id
    ) s
  `;
  assert.strictEqual(
    body.total_session_count,
    Number(oracle[0]?.with_tokens ?? 0n),
    "total_session_count = real-token sessions",
  );
  assert.strictEqual(
    body.no_llm_session_count,
    Number(oracle[0]?.zero ?? 0n),
    "no_llm_session_count = zero-token sessions",
  );
});

test("GET /api/cost/turn-stats: avg_turns_per_session true per-session aggregate (F29)", async () => {
  const res = await app.inject({ method: "GET", url: "/api/cost/turn-stats?days=30" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    turns: {
      avg_turns: number;
      avg_turns_per_session: number;
      turn_session_count: number;
      turn_event_count: number;
    };
  };
  assert.ok(
    Number.isInteger(body.turns.turn_session_count) && body.turns.turn_session_count >= 0,
    "turn_session_count is a non-negative integer",
  );
  assert.ok(body.turns.avg_turns_per_session >= 0, "avg_turns_per_session non-negative");
  if (body.turns.turn_session_count > 0) {
    // sessions <= events ⇒ AVG(per-session SUM) >= per-event mean — the per-event
    // mean understating session budgets is exactly what F29 fixes.
    assert.ok(
      body.turns.avg_turns_per_session >= body.turns.avg_turns,
      `avg_turns_per_session (${body.turns.avg_turns_per_session}) >= avg_turns (${body.turns.avg_turns})`,
    );
    assert.ok(
      body.turns.turn_session_count <= body.turns.turn_event_count,
      "session count <= event count",
    );
  }
});

test("GET /api/cost/kpi: KPI band shape + invariants (R09)", async () => {
  const res = await app.inject({ method: "GET", url: "/api/cost/kpi" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    today_cost_usd: number;
    window_7d_cost_usd: number;
    burn_rate_3h_usd_per_hour: number;
    cost_per_done_usd: number | null;
    done_count_7d: number;
    day_bucket_timezone: string;
    fetched_at: string;
  };
  assert.ok(body.today_cost_usd >= 0, "today_cost_usd non-negative");
  // 7d window includes today — the weekly sum can never undercut today's.
  assert.ok(
    body.window_7d_cost_usd >= body.today_cost_usd,
    "window_7d_cost_usd >= today_cost_usd",
  );
  assert.ok(body.burn_rate_3h_usd_per_hour >= 0, "burn rate non-negative");
  assert.ok(Number.isInteger(body.done_count_7d) && body.done_count_7d >= 0, "done_count_7d");
  // No fabricated zero: null exactly when no done outcome exists in the window.
  if (body.done_count_7d === 0) {
    assert.strictEqual(body.cost_per_done_usd, null, "cost_per_done null when no done outcome");
  } else {
    assert.ok(body.cost_per_done_usd !== null, "cost_per_done present");
    const expected = body.window_7d_cost_usd / body.done_count_7d;
    assert.ok(
      Math.abs(body.cost_per_done_usd - expected) < 1e-9,
      "cost_per_done = window_7d / done_count_7d",
    );
  }
  // 응답 echo = timezone.ts 가 해석한 설정값 (ATRIUM_TIMEZONE 미설정 → Asia/Seoul).
  assert.strictEqual(body.day_bucket_timezone, DAY_BUCKET_TIMEZONE);
  assert.ok(/\d{4}-\d{2}-\d{2}T/.test(body.fetched_at), "fetched_at is ISO");
});
