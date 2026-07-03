// Cost API: read-only endpoints feeding the cost·token detail screen over
// core.cost_events. All queries via Prisma $queryRaw template-tag (parameter
// binding → no injection). cost-timeseries lives in dashboard.ts, not here —
// the frontend consumes both files together.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "../../generated/prisma/client.js";
import { buildAgentMembershipFilter, loadCanonicalAgentKeys } from "../agents/registry.js";
import { getPrisma } from "../db.js";
import { respondDbFailure } from "../db-failure.js";
import { DAY_BUCKET_TIMEZONE } from "../timezone.js";
import type {
  CacheHitResponse,
  CacheHitRow,
  CostByModelResponse,
  CostByModelRow,
  CostErrorBody,
  CostKpiResponse,
  CostWindowDays,
  ParseErrorResponse,
  ParseErrorRow,
  SessionDistributionResponse,
  SessionDistributionRow,
  StopReasonBucket,
  TurnStatsResponse,
  TurnStatsRow,
} from "../types/cost.js";

// Why fixed allowlist: prevents arbitrary INTERVAL injection through query param.
// Mirrors the dashboard.ts pattern (ALLOWED_TIMESERIES_DAYS).
const ALLOWED_DAYS: ReadonlyArray<CostWindowDays> = [7, 30, 90];
const ALLOWED_DAYS_SET: ReadonlySet<number> = new Set<number>(ALLOWED_DAYS);

// Per-session payload cap — prevents unbounded JSON growth at high session counts.
const SESSION_DISTRIBUTION_LIMIT = 200;

// cost-tracker.sh writes a session-tracking zero-row (model=NULL, tokens=0,
// parse_error=false) on every Stop-hook turn that fired with no LLM call
// (tool-only / multi-fire turns) — by-design, NOT a parse defect. The model
// attribution metric MUST exclude these so the rate reflects real LLM-call
// cost only; folding them into 'unknown' deflated attribution 91%→37%.
// IS DISTINCT FROM (not <>) keeps NULL-stop_reason legacy parse_error rows in
// the denominator — those are real unattributed events, unlike the zero-rows.
const SESSION_TRACKING_STOP_REASON = "no_assistant_in_turn";

// Subagent-scan sentinel rows carry model='<synthetic>' with zero tokens — not a
// real model bucket; excluded from by-model so the split reflects billable models.
const SYNTHETIC_MODEL = "<synthetic>";

interface ByModelRow {
  model: string;
  input_tokens: bigint;
  output_tokens: bigint;
  cache_read_tokens: bigint;
  cache_creation_tokens: bigint;
  cost_usd: Prisma.Decimal;
  session_count: bigint;
}

interface CacheHitDbRow {
  event_date: Date;
  total_cache_read: bigint;
  total_input: bigint;
  cache_hit_rate: Prisma.Decimal | null;
}

interface SessionDistributionDbRow {
  session_id: string;
  total_cost_usd: Prisma.Decimal;
  total_tokens: bigint;
  event_count: bigint;
  last_event_at: Date;
}

interface SessionCountRow {
  total: bigint;
  no_llm_total: bigint;
}

interface SessionTurnsDbRow {
  avg_turns_per_session: Prisma.Decimal | null;
  turn_session_count: bigint;
}

interface CostKpiDbRow {
  today_cost: Prisma.Decimal | null;
  window_7d_cost: Prisma.Decimal | null;
  cost_3h: Prisma.Decimal | null;
  done_count_7d: bigint;
}

interface ParseErrorDbRow {
  event_date: Date;
  error_count: bigint;
  total_count: bigint;
  error_ratio: Prisma.Decimal | null;
}

interface StopReasonDbRow {
  // COALESCE(stop_reason, 'unknown') — never NULL in the mapped row.
  stop_reason: string;
  event_count: bigint;
  session_count: bigint;
}

interface TurnStatsDbRow {
  // SUM/MAX over num_turns > 0 events; all NULL when no qualifying row exists.
  total_turns: bigint | null;
  avg_turns: Prisma.Decimal | null;
  max_turns: number | null;
  turn_event_count: bigint;
}

export async function registerCostRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/cost/by-model", handleByModel);
  app.get("/api/cost/cache-hit", handleCacheHit);
  app.get("/api/cost/session-distribution", handleSessionDistribution);
  app.get("/api/cost/parse-errors", handleParseErrors);
  app.get("/api/cost/turn-stats", handleTurnStats);
  app.get("/api/cost/kpi", handleCostKpi);
}

// GET /api/cost/by-model?days={7|30|90}
async function handleByModel(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<CostByModelResponse | CostErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days);
  if (days === null) {
    return reply.code(400).send(invalidDays());
  }

  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    // COALESCE(model, 'unknown') folds residual NULL-model rows (legacy parse
    // failures + real model-extract misses) into a single 'unknown' bucket. The
    // by-design session-tracking zero-rows are excluded upfront (see
    // SESSION_TRACKING_STOP_REASON) so 'unknown' reflects genuine attribution
    // gaps, not no-LLM-call turns.
    // subagent rows (kind='subagent') are INCLUDED — they carry their own model
    // and real token usage (~69% of total tokens), so per-model totals must
    // count them. The zero-row exclusion is scoped to kind='turn' because only
    // turn rows carry the 'no_assistant_in_turn' marker; subagent rows have
    // stop_reason NULL and would survive `IS DISTINCT FROM` regardless, but the
    // explicit kind scope keeps the filter intent unambiguous.
    const rows = await prisma.$queryRaw<ByModelRow[]>`
      SELECT
        COALESCE(model, 'unknown')          AS model,
        SUM(input_tokens)::bigint           AS input_tokens,
        SUM(output_tokens)::bigint          AS output_tokens,
        SUM(cache_read_tokens)::bigint      AS cache_read_tokens,
        SUM(cache_creation_tokens)::bigint  AS cache_creation_tokens,
        COALESCE(SUM(cost_usd), 0)::numeric(12,6) AS cost_usd,
        COUNT(DISTINCT session_id)::bigint  AS session_count
      FROM core.cost_events
      WHERE event_date >= ${windowLowerBound}
        AND NOT (kind = 'turn'
                 AND stop_reason IS NOT DISTINCT FROM ${SESSION_TRACKING_STOP_REASON})
        AND NOT (model IS NOT DISTINCT FROM ${SYNTHETIC_MODEL}
                 AND input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens = 0)
      GROUP BY 1
      ORDER BY cost_usd DESC
    `;

    const mapped: CostByModelRow[] = rows.map((row) => ({
      model: row.model,
      input_tokens: bigintToNumber(row.input_tokens),
      output_tokens: bigintToNumber(row.output_tokens),
      cache_read_tokens: bigintToNumber(row.cache_read_tokens),
      cache_creation_tokens: bigintToNumber(row.cache_creation_tokens),
      cost_usd: decimalToNumber(row.cost_usd),
      session_count: bigintToNumber(row.session_count),
    }));

    request.log.info(
      {
        route: "/api/cost/by-model",
        days,
        rowCount: mapped.length,
        durationMs: Date.now() - start,
      },
      "cost query complete",
    );
    return { days, rows: mapped, fetched_at: new Date().toISOString() };
  } catch (error) {
    return failWithDb(request, reply, "/api/cost/by-model", error);
  }
}

// GET /api/cost/cache-hit?days={7|30|90}
async function handleCacheHit(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<CacheHitResponse | CostErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days);
  if (days === null) {
    return reply.code(400).send(invalidDays());
  }

  // generate_series fills gap days with zero rows so the FE chart has continuous
  // x-axis values (no missing-day skips). NULLIF guards against divide-by-zero.
  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    const rows = await prisma.$queryRaw<CacheHitDbRow[]>`
      SELECT
        d::date AS event_date,
        COALESCE(SUM(c.cache_read_tokens), 0)::bigint AS total_cache_read,
        COALESCE(SUM(c.input_tokens), 0)::bigint      AS total_input,
        CASE
          WHEN COALESCE(SUM(c.input_tokens + c.cache_read_tokens), 0) = 0 THEN NULL
          ELSE (SUM(c.cache_read_tokens)::numeric
                / NULLIF(SUM(c.input_tokens + c.cache_read_tokens), 0))::numeric(8,6)
        END AS cache_hit_rate
      FROM generate_series(
        ${windowLowerBound},
        CURRENT_DATE,
        '1 day'
      ) d
      LEFT JOIN core.cost_events c ON c.event_date = d::date
      GROUP BY d
      ORDER BY d ASC
    `;

    const mapped: CacheHitRow[] = rows.map((row) => ({
      event_date: formatDateOnly(row.event_date),
      cache_hit_rate: row.cache_hit_rate === null ? null : decimalToNumber(row.cache_hit_rate),
      total_cache_read: bigintToNumber(row.total_cache_read),
      total_input: bigintToNumber(row.total_input),
    }));

    request.log.info(
      {
        route: "/api/cost/cache-hit",
        days,
        rowCount: mapped.length,
        durationMs: Date.now() - start,
      },
      "cost query complete",
    );
    return { days, rows: mapped, fetched_at: new Date().toISOString() };
  } catch (error) {
    return failWithDb(request, reply, "/api/cost/cache-hit", error);
  }
}

// GET /api/cost/session-distribution?days={7|30|90}
async function handleSessionDistribution(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<SessionDistributionResponse | CostErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days);
  if (days === null) {
    return reply.code(400).send(invalidDays());
  }

  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    // Two parallel queries: top-N rows + counts. Sessions whose every event is
    // zero-token (tracking sentinels / synthetic rows — no LLM call) are excluded
    // from rows + total and surfaced separately as no_llm_session_count, so the
    // $0 bin reflects cheap real sessions, not the sentinel population.
    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw<SessionDistributionDbRow[]>`
        SELECT
          session_id,
          COALESCE(SUM(cost_usd), 0)::numeric(12,6) AS total_cost_usd,
          SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens)::bigint
            AS total_tokens,
          COUNT(*)::bigint AS event_count,
          MAX(event_date + event_time) AS last_event_at
        FROM core.cost_events
        WHERE event_date >= ${windowLowerBound}
        GROUP BY session_id
        HAVING SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) > 0
        ORDER BY total_cost_usd DESC
        LIMIT ${SESSION_DISTRIBUTION_LIMIT}
      `,
      prisma.$queryRaw<SessionCountRow[]>`
        SELECT
          COUNT(*) FILTER (WHERE session_tokens > 0)::bigint AS total,
          COUNT(*) FILTER (WHERE session_tokens = 0)::bigint AS no_llm_total
        FROM (
          SELECT SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens)
                   AS session_tokens
          FROM core.cost_events
          WHERE event_date >= ${windowLowerBound}
          GROUP BY session_id
        ) s
      `,
    ]);

    const totalRow = countRows[0];
    if (totalRow === undefined) {
      throw new Error("session count query returned no row");
    }
    const totalSessionCount = bigintToNumber(totalRow.total);
    const noLlmSessionCount = bigintToNumber(totalRow.no_llm_total);

    const mapped: SessionDistributionRow[] = rows.map((row) => ({
      session_id: row.session_id,
      total_cost_usd: decimalToNumber(row.total_cost_usd),
      total_tokens: bigintToNumber(row.total_tokens),
      event_count: bigintToNumber(row.event_count),
      last_event_at: row.last_event_at.toISOString(),
    }));

    request.log.info(
      {
        route: "/api/cost/session-distribution",
        days,
        rowCount: mapped.length,
        totalSessionCount,
        truncated: totalSessionCount > SESSION_DISTRIBUTION_LIMIT,
        durationMs: Date.now() - start,
      },
      "cost query complete",
    );
    return {
      days,
      rows: mapped,
      truncated: totalSessionCount > SESSION_DISTRIBUTION_LIMIT,
      total_session_count: totalSessionCount,
      no_llm_session_count: noLlmSessionCount,
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/cost/session-distribution", error);
  }
}

// GET /api/cost/parse-errors?days={7|30|90}
async function handleParseErrors(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<ParseErrorResponse | CostErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days);
  if (days === null) {
    return reply.code(400).send(invalidDays());
  }

  // generate_series gap-fills empty days with zero counts so the FE chart shows
  // continuous coverage. error_ratio = error_count / NULLIF(total_count, 0).
  // kind='turn' scope on the JOIN — this metric measures main-session Stop-hook
  // parse health. subagent rows derive from a separate transcript-scan path
  // (always parse_error=false) and would dilute the denominator, understating the
  // true turn-parse error rate; excluded to keep the metric meaningful.
  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    const rows = await prisma.$queryRaw<ParseErrorDbRow[]>`
      SELECT
        d::date AS event_date,
        COUNT(*) FILTER (WHERE c.parse_error = true)::bigint AS error_count,
        COUNT(c.id)::bigint AS total_count,
        CASE
          WHEN COUNT(c.id) = 0 THEN NULL
          ELSE (COUNT(*) FILTER (WHERE c.parse_error = true)::numeric
                / NULLIF(COUNT(c.id), 0))::numeric(8,6)
        END AS error_ratio
      FROM generate_series(
        ${windowLowerBound},
        CURRENT_DATE,
        '1 day'
      ) d
      LEFT JOIN core.cost_events c
        ON c.event_date = d::date
       AND c.kind = 'turn'
      GROUP BY d
      ORDER BY d ASC
    `;

    // Spec: error_ratio is `number` (not nullable) — coerce NULL (zero-row days)
    // to 0 so the FE can chart without nullish handling.
    const mapped: ParseErrorRow[] = rows.map((row) => ({
      event_date: formatDateOnly(row.event_date),
      error_count: bigintToNumber(row.error_count),
      total_count: bigintToNumber(row.total_count),
      error_ratio: row.error_ratio === null ? 0 : decimalToNumber(row.error_ratio),
    }));

    request.log.info(
      {
        route: "/api/cost/parse-errors",
        days,
        rowCount: mapped.length,
        durationMs: Date.now() - start,
      },
      "cost query complete",
    );
    return { days, rows: mapped, fetched_at: new Date().toISOString() };
  } catch (error) {
    return failWithDb(request, reply, "/api/cost/parse-errors", error);
  }
}

// GET /api/cost/turn-stats?days={7|30|90}
async function handleTurnStats(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<TurnStatsResponse | CostErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days);
  if (days === null) {
    return reply.code(400).send(invalidDays());
  }

  // Surfaces two collected-but-previously-unqueried columns:
  //   - stop_reason distribution → tool-only-turn counts ('no_assistant_in_turn'
  //     zero-rows) vs real LLM turns ('end_turn'), folding NULL → 'unknown'.
  //   - num_turns aggregate, restricted to num_turns > 0 so the by-design
  //     tool-only zero-rows do NOT deflate the average.
  // duration_ms deliberately omitted — 100% zero in production (collected but
  // never populated), so an aggregate would be a misleading flat zero.
  // kind='turn' filter REQUIRED on both queries — subagent rows (kind='subagent',
  // stop_reason NULL, num_turns 0) are not turns; without the filter they would
  // appear as an 'unknown' stop_reason bucket and dilute the turn metrics.
  // Two parallel queries share the window lower bound.
  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    const [stopReasonRows, turnRows, sessionTurnRows] = await Promise.all([
      prisma.$queryRaw<StopReasonDbRow[]>`
        SELECT
          COALESCE(stop_reason, 'unknown')   AS stop_reason,
          COUNT(*)::bigint                   AS event_count,
          COUNT(DISTINCT session_id)::bigint AS session_count
        FROM core.cost_events
        WHERE event_date >= ${windowLowerBound}
          AND kind = 'turn'
        GROUP BY 1
        ORDER BY event_count DESC
      `,
      prisma.$queryRaw<TurnStatsDbRow[]>`
        SELECT
          SUM(num_turns) FILTER (WHERE num_turns > 0)::bigint        AS total_turns,
          AVG(num_turns) FILTER (WHERE num_turns > 0)::numeric(10,4) AS avg_turns,
          MAX(num_turns) FILTER (WHERE num_turns > 0)               AS max_turns,
          COUNT(*) FILTER (WHERE num_turns > 0)::bigint             AS turn_event_count
        FROM core.cost_events
        WHERE event_date >= ${windowLowerBound}
          AND kind = 'turn'
      `,
      // True per-session aggregate (SUM per session, then AVG) — the per-event
      // mean understates session-level turn budgets when sessions multi-fire.
      prisma.$queryRaw<SessionTurnsDbRow[]>`
        SELECT
          AVG(session_turns)::numeric(10,4) AS avg_turns_per_session,
          COUNT(*)::bigint                  AS turn_session_count
        FROM (
          SELECT SUM(num_turns) AS session_turns
          FROM core.cost_events
          WHERE event_date >= ${windowLowerBound}
            AND kind = 'turn'
            AND num_turns > 0
          GROUP BY session_id
        ) s
      `,
    ]);

    const turnRow = turnRows[0];
    const sessionTurnRow = sessionTurnRows[0];
    if (turnRow === undefined || sessionTurnRow === undefined) {
      throw new Error("turn-stats aggregate query returned no row");
    }

    const stopReasons: StopReasonBucket[] = stopReasonRows.map((row) => ({
      stop_reason: row.stop_reason,
      event_count: bigintToNumber(row.event_count),
      session_count: bigintToNumber(row.session_count),
    }));

    // All-NULL aggregate (no num_turns > 0 row in window) → zero-valued shape so
    // the FE charts without nullish handling, mirroring parse-errors error_ratio.
    const turns: TurnStatsRow = {
      total_turns: turnRow.total_turns === null ? 0 : bigintToNumber(turnRow.total_turns),
      avg_turns: turnRow.avg_turns === null ? 0 : decimalToNumber(turnRow.avg_turns),
      max_turns: turnRow.max_turns ?? 0,
      turn_event_count: bigintToNumber(turnRow.turn_event_count),
      avg_turns_per_session:
        sessionTurnRow.avg_turns_per_session === null
          ? 0
          : decimalToNumber(sessionTurnRow.avg_turns_per_session),
      turn_session_count: bigintToNumber(sessionTurnRow.turn_session_count),
    };

    request.log.info(
      {
        route: "/api/cost/turn-stats",
        days,
        stopReasonCount: stopReasons.length,
        turnEventCount: turns.turn_event_count,
        durationMs: Date.now() - start,
      },
      "cost query complete",
    );
    return { days, stop_reasons: stopReasons, turns, fetched_at: new Date().toISOString() };
  } catch (error) {
    return failWithDb(request, reply, "/api/cost/turn-stats", error);
  }
}

// GET /api/cost/kpi — top KPI band (오늘 비용 · 7일 비용 · 3h burn · 성공 작업당 비용).
// Day buckets pinned in SQL to the configured day-bucket timezone (bind param;
// event_date is that timezone's calendar day); the 3h burn compares against the
// same wall-clock (event_date + event_time carries no tz).
async function handleCostKpi(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<CostKpiResponse | CostErrorBody> {
  const start = Date.now();
  const prisma = getPrisma();
  try {
    // Registry-membership scope for done_count_7d — this KPI feeds the derived
    // cost_per_done_usd ratio, so a non-registry-agent row (noise) would both
    // inflate the numerator's implied population and skew the ratio. AND-prefixed
    // helper appended after the sub-select's existing complete WHERE.
    const agentMembership = buildAgentMembershipFilter(await loadCanonicalAgentKeys());
    const rows = await prisma.$queryRaw<CostKpiDbRow[]>`
      SELECT
        (SELECT COALESCE(SUM(cost_usd), 0) FROM core.cost_events
          WHERE event_date = (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date) AS today_cost,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM core.cost_events
          WHERE event_date >= (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date - 6) AS window_7d_cost,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM core.cost_events
          WHERE event_date + event_time
                  >= (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text) - INTERVAL '3 hours') AS cost_3h,
        (SELECT COUNT(*) FROM core.outcomes
          WHERE result = 'done'
            AND (record_ts AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date
                  >= (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date - 6
            ${agentMembership}) AS done_count_7d
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error("cost kpi query returned no row");
    }

    const window7dCost = decimalToNumber(row.window_7d_cost);
    const doneCount7d = bigintToNumber(row.done_count_7d);
    const body: CostKpiResponse = {
      today_cost_usd: decimalToNumber(row.today_cost),
      window_7d_cost_usd: window7dCost,
      burn_rate_3h_usd_per_hour: decimalToNumber(row.cost_3h) / 3,
      cost_per_done_usd: doneCount7d === 0 ? null : window7dCost / doneCount7d,
      done_count_7d: doneCount7d,
      day_bucket_timezone: DAY_BUCKET_TIMEZONE,
      fetched_at: new Date().toISOString(),
    };

    request.log.info(
      { route: "/api/cost/kpi", durationMs: Date.now() - start },
      "cost query complete",
    );
    return body;
  } catch (error) {
    return failWithDb(request, reply, "/api/cost/kpi", error);
  }
}

// ----- helpers ---------------------------------------------------------------

function parseDaysParam(raw: string | undefined): CostWindowDays | null {
  // Days is required for all 4 cost endpoints (no fallback) — empty value rejected.
  if (raw === undefined || raw === "") {
    return null;
  }
  // Reject non-integer literals before parseInt swallows trailing fragments
  // (e.g., "7.5" → 7). Strict allowlist enforcement requires exact-match input.
  if (!/^-?\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || !ALLOWED_DAYS_SET.has(parsed)) {
    return null;
  }
  // Type-narrow back to literal union — allowlist guarantees the cast is safe.
  return parsed as CostWindowDays;
}

// Canonical "last N days" window lower bound (single SoT across all cost
// endpoints, so every "last N days" card covers the identical day-set).
// Window = [CURRENT_DATE - (days-1) .. CURRENT_DATE] inclusive = exactly `days`
// calendar days (today counted); matches the generate_series form.
// Prisma.raw, not a bind: parameterized INTERVAL needs a `($1 || ' days')::interval`
// text-cast the template-tag won't emit cleanly. Safe — `days` is allowlist-validated
// ({7,30,90}), `days - 1` is derived; no user input reaches SQL.
function buildWindowLowerBound(days: number): Prisma.Sql {
  return Prisma.raw(`CURRENT_DATE - INTERVAL '${days - 1} days'`);
}

function bigintToNumber(value: bigint): number {
  // PG SUM/COUNT returns bigint; values realistic for this app fit in safe-int range.
  // Guard against future scale: surface a clear error rather than silent truncation.
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`bigint ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

function decimalToNumber(value: Prisma.Decimal | null): number {
  if (value === null) {
    return 0;
  }
  // Cost values are bounded (Decimal(12,6)); JSON-safe conversion via toString.
  return Number(value.toString());
}

function formatDateOnly(date: Date): string {
  // Why manual UTC slice: PG DATE arrives as midnight UTC; toISOString preserves Y-M-D.
  return date.toISOString().slice(0, 10);
}

function failWithDb(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  error: unknown,
): CostErrorBody {
  return respondDbFailure(request, reply, route, error, "cost query failed");
}

function invalidDays(): CostErrorBody {
  return { error: "invalid_days", allowed: ALLOWED_DAYS };
}
