// Agents API: read-only endpoints feeding the agent-performance detail screen
// over core.outcomes + core.agent_events. All queries via $queryRaw template-tag
// (Prisma parameter binding → no injection). Result/task_type columns are cast
// ::text so IN-list literals skip server-side enum binding (query stays portable).

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "../../generated/prisma/client.js";
import { buildReconstructedRowFilter } from "../attribution-sources.js";
import {
  buildAgentMembershipFilter,
  invalidateAgentRegistryCache,
  loadAgentRegistry,
  loadCanonicalAgentKeys,
} from "../agents/registry.js";
import { getPrisma } from "../db.js";
import { respondDbFailure } from "../db-failure.js";
import { TASK_TYPES } from "../task-types.js";
import type {
  AgentMutationErrorBody,
  AgentMutationInternalBody,
  DeleteAgentCommitResult,
  DeleteAgentPreviewResult,
  DeleteAgentResponse,
} from "../types/agents.js";
import type {
  AgentBudgetOverageRow,
  AgentBudgetOveragesResponse,
  AgentFailurePatternRow,
  AgentFailurePatternsResponse,
  AgentFailureReasonCategory,
  AgentFailureReasonResultType,
  AgentFailureReasonRow,
  AgentFailureReasonsResponse,
  AgentLatencyItem,
  AgentLatencyResponse,
  AgentLifecycleStatsResponse,
  AgentLifecycleStatsRow,
  AgentReviewFlagByAgentResponse,
  AgentReviewFlagByAgentRow,
  AgentReviewFlagTimeseriesResponse,
  AgentReviewFlagTimeseriesRow,
  AgentRevisionBucket,
  AgentRevisionDistributionResponse,
  AgentRevisionDistributionRow,
  AgentsErrorBody,
  AgentsWindowDays,
  AgentSuccessRateResponse,
  AgentSuccessRateRow,
  AgentSummaryItem,
  AgentSummaryResponse,
  AgentSummarySortKey,
  AgentSummaryStatus,
  AgentTaskType,
} from "../types/agents.js";

// Why fixed allowlist: prevents arbitrary INTERVAL injection through query param.
// Mirrors the cost.ts pattern (ALLOWED_DAYS).
const ALLOWED_DAYS: ReadonlyArray<AgentsWindowDays> = [7, 30, 90];
const ALLOWED_DAYS_SET: ReadonlySet<number> = new Set<number>(ALLOWED_DAYS);

// Defensive cap: 9 task_types × 90 days × ~12 agents = 9720 → 10000 absorbs a +1 agent burst.
// Saturating surfaces `truncated: true` so the FE discloses missing data, not a silent partial matrix.
// Test-visible export — the truncated-flag contract test compares a live group-count oracle to this cap.
export const SUCCESS_RATE_LIMIT = 10000;

// Hard cap for failure-patterns: top-N agents by total_breakages.
const FAILURE_PATTERNS_LIMIT = 50;

// /summary, /latency, /failure-reasons use INTEGER-RANGE windows (not the
// {7|30|90} allowlist) so the FE can render arbitrary 1-90 day windows.

// /summary: days 1-90 default 7, limit 1-50 default 20.
const SUMMARY_DAYS_MIN = 1;
const SUMMARY_DAYS_MAX = 90;
const SUMMARY_DAYS_DEFAULT = 7;
const SUMMARY_LIMIT_MIN = 1;
const SUMMARY_LIMIT_MAX = 50;
const SUMMARY_LIMIT_DEFAULT = 20;
const ALLOWED_SUMMARY_SORTS: ReadonlySet<AgentSummarySortKey> = new Set<AgentSummarySortKey>([
  "name",
  "runs",
  "success",
  "p95",
]);

// /latency: days 1-30 default 7. Tighter ceiling because the percentile_cont
// aggregate over agent_events_dedup index gets expensive past the 30-day
// window — keeps p95 < 400 ms.
const LATENCY_DAYS_MIN = 1;
const LATENCY_DAYS_MAX = 30;
const LATENCY_DAYS_DEFAULT = 7;

// /failure-reasons: days 1-90 default 30 (1-90 range mirrors the other
// validators to avoid an inconsistent third bound).
const FAILURE_REASONS_DAYS_MIN = 1;
const FAILURE_REASONS_DAYS_MAX = 90;
const FAILURE_REASONS_DAYS_DEFAULT = 30;
// Bound the agent param length — outcomes.agent column is varchar(64).
const AGENT_PARAM_MAX_LENGTH = 64;

// /failure-reasons `result` param: scope cause analysis to fail OR blocked
// breakages. Default 'fail' keeps existing consumers unchanged; 'blocked'
// surfaces the dominant breakage type. The allowlist gates the value bound into
// the SQL filter — no arbitrary result literal can reach the query.
const FAILURE_REASONS_RESULT_DEFAULT: AgentFailureReasonResultType = "fail";
const ALLOWED_FAILURE_RESULT_TYPES: ReadonlySet<AgentFailureReasonResultType> =
  new Set<AgentFailureReasonResultType>(["fail", "blocked"]);

// Status-bucket cutoffs in ms.
const STATUS_ACTIVE_MS = 24 * 3_600_000; // 24h
const STATUS_IDLE_MS = 7 * 24 * 3_600_000; // 7d

// Keyword-classification table — first-match-wins by array order, so most-specific
// failure modes come first (a hint with both "context" and "timeout" → context_overflow).
// Unmatched → implicit 'other'. Hard-coded because the keyword catalog IS the policy.
const FAILURE_KEYWORDS: ReadonlyArray<{
  category: Exclude<AgentFailureReasonCategory, "other">;
  keywords: ReadonlyArray<string>;
}> = [
  { category: "context_overflow", keywords: ["context", "token limit", "초과", "context window"] },
  { category: "rate_limit", keywords: ["rate limit", "429", "quota"] },
  { category: "api_timeout", keywords: ["timeout", "타임아웃", "504", "deadline exceeded"] },
  { category: "parse_error", keywords: ["parse", "json", "구문", "syntax"] },
  { category: "tool_failure", keywords: ["tool", "mcp", "exec", "execfile"] },
];

// Allowed task_type literals — gates the SQL value list at runtime against
// drift between PG enum and the FE union type. Derived from the shared 9-type
// TASK_TYPES SoT (task-types.ts): the 4 non-code types (review/diagnosis/doc/
// cleanup) MUST be members or mapSuccessRateRows silently drops those rows.
const ALLOWED_TASK_TYPES: ReadonlySet<AgentTaskType> = new Set<AgentTaskType>(TASK_TYPES);

// DB row shapes

interface SuccessRateDbRow {
  agent: string;
  task_type: string;
  event_date: Date;
  success_count: bigint;
  failure_count: bigint;
  total_count: bigint;
  // FILTER sub-count of total_count — reconstructed (harness-synthesized) rows only.
  reconstructed_count: bigint;
  success_rate: Prisma.Decimal | null;
}

interface RevisionDistributionDbRow {
  agent: string;
  revision_bucket: string;
  occurrence_count: bigint;
}

interface ReviewFlagTimeseriesDbRow {
  event_date: Date;
  total_count: bigint;
  review_flagged_count: bigint;
  empty_metric_count: bigint;
  polar_mismatch_count: bigint;
  review_flag_ratio: Prisma.Decimal | null;
  empty_metric_ratio: Prisma.Decimal | null;
}

interface ReviewFlagByAgentDbRow {
  agent: string;
  total_count: bigint;
  review_flagged_count: bigint;
  // FILTER sub-count of review_flagged_count — flagged rows that are reconstructed
  // (harness-synthesized). writer-emitted flagged = review_flagged_count - reconstructed_count.
  reconstructed_count: bigint;
  review_flag_ratio: Prisma.Decimal | null;
}

interface FailurePatternsDbRow {
  agent: string;
  fail_count: bigint;
  blocked_count: bigint;
  total_breakages: bigint;
  // FILTER sub-count of total_breakages — reconstructed (harness-synthesized) breakages.
  reconstructed_count: bigint;
  fail_rate: Prisma.Decimal | null;
  last_breakage_at: Date;
  top_concerns: string[];
}

interface LifecycleStatsDbRow {
  agent_type: string;
  start_count: bigint;
  stop_count: bigint;
  completed_count: bigint;
  avg_duration_sec: Prisma.Decimal | null;
  p95_duration_sec: Prisma.Decimal | null;
  max_duration_sec: Prisma.Decimal | null;
}

// /budget-overages: per-agent_type tool_use-budget crossing rollup over the
// raw-SQL core.budget_overages table (outside schema.prisma). max_crossed_pct is
// already an integer column; COUNT casts to bigint.
interface BudgetOverageDbRow {
  agent_type: string;
  overage_count: bigint;
  max_crossed_pct: number;
  latest_ts: Date;
}

// /summary: per-agent runs / success / last_run_at / last_result.
// denom_count = done+dwc+blocked+fail (matrix semantics — needs_context excluded).
interface SummaryOutcomeDbRow {
  agent: string;
  runs: bigint;
  success_count: bigint;
  denom_count: bigint;
  needs_context_count: bigint;
  last_run_at: Date;
  last_result: string;
}

// /summary: per-agent_type p95_ms via Start↔Stop pairing on agent_events.
interface SummaryLatencyDbRow {
  agent_type: string;
  p95_ms: Prisma.Decimal | null;
}

// Per-agent_type SubagentStart count — spawn frequency, distinct from the
// outcomes-derived `runs` (spawn vs outcome emit).
interface SummaryInvocationsDbRow {
  agent_type: string;
  invocations: bigint;
}

// /latency: per-agent_type P50/P95/P99 via Start↔Stop pairing.
interface LatencyDbRow {
  agent_type: string;
  p50_ms: Prisma.Decimal | null;
  p95_ms: Prisma.Decimal | null;
  p99_ms: Prisma.Decimal | null;
}

// /failure-reasons: per-breakage classification signals. concerns[] + summary
// carry the populated cause text (directive_hint is near-always NULL on breakage
// rows — classifying on it alone left the breakdown 100% 'other'). Pulled raw
// (one row per breakage) because the keyword table is JS-side.
interface FailureReasonDbRow {
  directive_hint: string | null;
  concerns: string[] | null;
  summary: string;
}

export async function registerAgentsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/agents/success-rate", handleSuccessRate);
  app.get("/api/agents/revision-distribution", handleRevisionDistribution);
  app.get("/api/agents/review-flag-timeseries", handleReviewFlagTimeseries);
  // Per-agent review_flag aggregation — agent dimension for the Health Index.
  app.get("/api/agents/review-flag-by-agent", handleReviewFlagByAgent);
  app.get("/api/agents/failure-patterns", handleFailurePatterns);
  app.get("/api/agents/lifecycle-stats", handleLifecycleStats);
  app.get("/api/agents/summary", handleSummary);
  app.get("/api/agents/latency", handleLatency);
  app.get("/api/agents/failure-reasons", handleFailureReasons);
  app.get("/api/agents/budget-overages", handleBudgetOverages);
  // Writable DEV-agent DELETE — preview(--dry-run)/commit(--confirm) two-step,
  // gated by the 127.0.0.1 local-only human-in-the-loop model. The CLI's
  // `run_delete` is the single owner of the registry-mutation lock.
  app.delete("/api/agents/:name", handleDeleteAgent);
}

// GET /api/agents/budget-overages?days={7|30|90}
// Near-cap tool_use-budget crossings per agent_type. The source table is
// created post-deploy (oss-db-setup.sh) and may be absent on a fresh DB — a
// missing table surfaces as a normal DB failure (503), and the FE degrades to
// "no badge" rather than fabricating a zero.
async function handleBudgetOverages(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<AgentBudgetOveragesResponse | AgentsErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days);
  if (days === null) {
    return reply.code(400).send(invalidDays());
  }

  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    // NULL agent_type rows (sidecar recovery miss) can't map to a summary row →
    // excluded. Grouped per agent_type so the FE keys the badge by agent_id
    // (agent_type == agent_id == agent_name in the current convention).
    const rows = await prisma.$queryRaw<BudgetOverageDbRow[]>`
      SELECT
        agent_type,
        COUNT(*)::bigint    AS overage_count,
        MAX(crossed_pct)    AS max_crossed_pct,
        MAX(ts)             AS latest_ts
      FROM core.budget_overages
      WHERE ts >= ${windowLowerBound}
        AND agent_type IS NOT NULL
      GROUP BY agent_type
      ORDER BY overage_count DESC
    `;

    const payload: AgentBudgetOveragesResponse = {
      rows: rows.map(mapBudgetOverageRow),
      days,
      fetched_at: new Date().toISOString(),
    };

    request.log.info(
      { route: "/api/agents/budget-overages", durationMs: Date.now() - start },
      "agents budget-overages query complete",
    );
    return payload;
  } catch (error) {
    return failWithDb(request, reply, "/api/agents/budget-overages", error);
  }
}

function mapBudgetOverageRow(row: BudgetOverageDbRow): AgentBudgetOverageRow {
  return {
    agent_type: row.agent_type,
    overage_count: bigintToNumber(row.overage_count),
    max_crossed_pct: Number(row.max_crossed_pct),
    latest_ts: row.latest_ts.toISOString(),
  };
}

// GET /api/agents/success-rate?days={7|30|90}
async function handleSuccessRate(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<AgentSuccessRateResponse | AgentsErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days);
  if (days === null) {
    return reply.code(400).send(invalidDays());
  }

  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    // Canonical-membership gate — show only Atrium-system agents (registry SoT).
    // Applied SQL-SIDE (not a post-query JS filter) because the query carries a
    // LIMIT + truncation flag: non-canonical rows must not consume the LIMIT
    // budget or skew `truncated`. buildAgentMembershipFilter is the shared SoT
    // for this gate and fail-opens on an empty registry (skips the predicate).
    const agentMembershipFilter = buildAgentMembershipFilter(
      await loadCanonicalAgentKeys(),
    );

    // Date bucket uses server-local TZ (`record_ts::date`) — matches cost.ts and
    // dashboard.ts conventions where derived day-buckets follow PG server TZ
    // (KST), so the FE 'last N days' window aligns with the user's wall clock.
    // FILTER (WHERE …) avoids correlated subqueries — single index scan.
    const rows = await prisma.$queryRaw<SuccessRateDbRow[]>`
      SELECT
        agent,
        task_type::text                                                AS task_type,
        record_ts::date                                                AS event_date,
        COUNT(*) FILTER (
          WHERE result::text IN ('done', 'done_with_concerns')
        )::bigint                                                      AS success_count,
        COUNT(*) FILTER (
          WHERE result::text IN ('blocked', 'fail')
        )::bigint                                                      AS failure_count,
        COUNT(*)::bigint                                               AS total_count,
        COUNT(*) FILTER (
          WHERE ${buildReconstructedRowFilter()}
        )::bigint                                                      AS reconstructed_count,
        CASE
          WHEN COUNT(*) FILTER (
            WHERE result::text IN ('done', 'done_with_concerns', 'blocked', 'fail')
          ) = 0 THEN NULL
          ELSE (
            COUNT(*) FILTER (WHERE result::text IN ('done', 'done_with_concerns'))::numeric
            / NULLIF(
                COUNT(*) FILTER (WHERE result::text IN ('done', 'done_with_concerns', 'blocked', 'fail')),
                0
              )
          )::numeric(8,6)
        END                                                            AS success_rate
      FROM core.outcomes
      WHERE record_ts >= ${windowLowerBound}
        ${agentMembershipFilter}
      GROUP BY agent, task_type, record_ts::date
      ORDER BY agent ASC, task_type ASC, event_date ASC
      LIMIT ${SUCCESS_RATE_LIMIT}
    `;

    const mapped = mapSuccessRateRows(rows);

    const truncated = rows.length >= SUCCESS_RATE_LIMIT;
    request.log.info(
      {
        route: "/api/agents/success-rate",
        days,
        rowCount: mapped.length,
        truncated,
        durationMs: Date.now() - start,
      },
      "agents query complete",
    );
    return {
      days,
      rows: mapped,
      truncated,
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/agents/success-rate", error);
  }
}

// Test-visible — drops rows whose task_type drifted off the registered enum
// surface (defensive — should not happen given PG enum constraint, but a future
// migration could add a value the FE doesn't know about; safer to skip than emit
// garbage). The allowlist is the shared 9-type TASK_TYPES SoT — narrowing it
// silently excludes whole task_type populations from the matrix.
export function mapSuccessRateRows(
  rows: ReadonlyArray<SuccessRateDbRow>,
): AgentSuccessRateRow[] {
  return rows.flatMap((row) => {
    if (!ALLOWED_TASK_TYPES.has(row.task_type as AgentTaskType)) {
      return [];
    }
    return [
      {
        agent: row.agent,
        task_type: row.task_type as AgentTaskType,
        event_date: formatDateOnly(row.event_date),
        success_count: bigintToNumber(row.success_count),
        failure_count: bigintToNumber(row.failure_count),
        total_count: bigintToNumber(row.total_count),
        reconstructed_count: bigintToNumber(row.reconstructed_count),
        success_rate:
          row.success_rate === null ? null : decimalToNumber(row.success_rate),
      },
    ];
  });
}

// GET /api/agents/revision-distribution?days={7|30|90}
async function handleRevisionDistribution(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<AgentRevisionDistributionResponse | AgentsErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days);
  if (days === null) {
    return reply.code(400).send(invalidDays());
  }

  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    // Canonical-membership gate (registry SoT) — this is the MASTER set driving
    // the Top-N "improve first" ranking, so it must not fold in non-registry
    // noise (orchestrator/main-session token, cron:* parents, sentinels like
    // subagent_stop_missing, one-off correlation-id strings). Shares the same
    // gate builder as the sibling per-agent endpoints; fail-opens on an empty
    // registry.
    const agentMembershipFilter = buildAgentMembershipFilter(
      await loadCanonicalAgentKeys(),
    );
    // CASE folds revision_count >= 4 into a single '4+' bucket per spec, leaving
    // 0/1/2/3 as exact buckets. The inner query also computes a `sort_key` numeric
    // column ('4+' → 4) so the outer ORDER BY can render buckets in numeric order
    // without referencing the raw revision_count (which isn't in the GROUP BY).
    const rows = await prisma.$queryRaw<RevisionDistributionDbRow[]>`
      SELECT agent, revision_bucket, occurrence_count
      FROM (
        SELECT
          agent,
          CASE
            WHEN revision_count >= 4 THEN '4+'
            ELSE revision_count::text
          END                                                          AS revision_bucket,
          CASE
            WHEN revision_count >= 4 THEN 4
            ELSE revision_count
          END                                                          AS sort_key,
          COUNT(*)::bigint                                             AS occurrence_count
        FROM core.outcomes
        WHERE record_ts >= ${windowLowerBound}
          ${agentMembershipFilter}
        GROUP BY agent, revision_bucket, sort_key
      ) buckets
      ORDER BY agent ASC, sort_key ASC
    `;

    // Defensive: only emit buckets the FE union type recognizes ('0'..'3' | '4+').
    // PG could in principle yield unexpected strings if revision_count is negative
    // (constraint absent in schema); skip those rows rather than corrupt the FE shape.
    const allowedBuckets: ReadonlySet<AgentRevisionBucket> = new Set<AgentRevisionBucket>([
      "0",
      "1",
      "2",
      "3",
      "4+",
    ]);
    const mapped: AgentRevisionDistributionRow[] = rows.flatMap((row) => {
      if (!allowedBuckets.has(row.revision_bucket as AgentRevisionBucket)) {
        return [];
      }
      return [
        {
          agent: row.agent,
          revision_bucket: row.revision_bucket as AgentRevisionBucket,
          occurrence_count: bigintToNumber(row.occurrence_count),
        },
      ];
    });

    request.log.info(
      {
        route: "/api/agents/revision-distribution",
        days,
        rowCount: mapped.length,
        durationMs: Date.now() - start,
      },
      "agents query complete",
    );
    return { days, rows: mapped, fetched_at: new Date().toISOString() };
  } catch (error) {
    return failWithDb(request, reply, "/api/agents/revision-distribution", error);
  }
}

// GET /api/agents/review-flag-timeseries?days={7|30|90}
async function handleReviewFlagTimeseries(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<AgentReviewFlagTimeseriesResponse | AgentsErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days);
  if (days === null) {
    return reply.code(400).send(invalidDays());
  }

  // generate_series gap-fills empty days with zero counts so the FE chart shows
  // continuous coverage (mirrors the cost.ts cache-hit pattern). The empty_metric
  // FILTERs carry an `o.id IS NOT NULL` guard: a gap day's LEFT JOIN emits a phantom
  // all-NULL `o` row for which `metric_pass IS NULL` is TRUE — without the guard it
  // would inflate empty_metric_count/ratio to 1 on a zero-activity day.
  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    // Canonical-membership gate (registry SoT) — excludes non-registry noise
    // from the daily review-flag series. Uses the `o.agent` column ref so the
    // predicate lands INSIDE the LEFT JOIN ... ON clause below (a top-level
    // WHERE on o.agent would collapse the LEFT JOIN into an inner join and drop
    // the generate_series gap-fill days, breaking continuous chart coverage).
    // Fail-opens on an empty registry.
    const agentMembershipFilter = buildAgentMembershipFilter(
      await loadCanonicalAgentKeys(),
      Prisma.sql`o.agent`,
    );
    const rows = await prisma.$queryRaw<ReviewFlagTimeseriesDbRow[]>`
      SELECT
        d::date                                                        AS event_date,
        COUNT(o.id)::bigint                                            AS total_count,
        COUNT(*) FILTER (WHERE o.review_flag = true)::bigint           AS review_flagged_count,
        COUNT(*) FILTER (WHERE o.metric_pass IS NULL AND o.id IS NOT NULL)::bigint AS empty_metric_count,
        COUNT(*) FILTER (
          WHERE (o.confidence::text = 'high' AND o.metric_pass = false)
             OR (o.confidence::text = 'low'  AND o.metric_pass = true)
        )::bigint                                                      AS polar_mismatch_count,
        CASE
          WHEN COUNT(o.id) = 0 THEN NULL
          ELSE (
            COUNT(*) FILTER (WHERE o.review_flag = true)::numeric
            / NULLIF(COUNT(o.id), 0)
          )::numeric(8,6)
        END                                                            AS review_flag_ratio,
        CASE
          WHEN COUNT(o.id) = 0 THEN NULL
          ELSE (
            COUNT(*) FILTER (WHERE o.metric_pass IS NULL AND o.id IS NOT NULL)::numeric
            / NULLIF(COUNT(o.id), 0)
          )::numeric(8,6)
        END                                                            AS empty_metric_ratio
      FROM generate_series(
        ${windowLowerBound},
        CURRENT_DATE,
        '1 day'
      ) d
      LEFT JOIN core.outcomes o
        ON o.record_ts >= d::date
        AND o.record_ts <  (d::date + INTERVAL '1 day')
        ${agentMembershipFilter}
      GROUP BY d
      ORDER BY d ASC
    `;

    // Spec: ratios are `number` (not nullable) — coerce NULL (zero-row days) to 0
    // so the FE can chart without nullish handling.
    const mapped: AgentReviewFlagTimeseriesRow[] = rows.map((row) => ({
      event_date: formatDateOnly(row.event_date),
      total_count: bigintToNumber(row.total_count),
      review_flagged_count: bigintToNumber(row.review_flagged_count),
      empty_metric_count: bigintToNumber(row.empty_metric_count),
      polar_mismatch_count: bigintToNumber(row.polar_mismatch_count),
      review_flag_ratio:
        row.review_flag_ratio === null ? 0 : decimalToNumber(row.review_flag_ratio),
      empty_metric_ratio:
        row.empty_metric_ratio === null ? 0 : decimalToNumber(row.empty_metric_ratio),
    }));

    request.log.info(
      {
        route: "/api/agents/review-flag-timeseries",
        days,
        rowCount: mapped.length,
        durationMs: Date.now() - start,
      },
      "agents query complete",
    );
    return { days, rows: mapped, fetched_at: new Date().toISOString() };
  } catch (error) {
    return failWithDb(request, reply, "/api/agents/review-flag-timeseries", error);
  }
}

// GET /api/agents/review-flag-by-agent?days={7|30|90}
//
// Per-agent review_flag ratio (the agent dimension the date-only
// review-flag-timeseries lacks). The FE Health Index
// (1 − (0.6×revision + 0.4×review_flag)) joins these rows by `agent`.
async function handleReviewFlagByAgent(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<AgentReviewFlagByAgentResponse | AgentsErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days);
  if (days === null) {
    return reply.code(400).send(invalidDays());
  }

  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    // Canonical-membership gate (registry SoT) — the FE Health Index joins these
    // per-agent rows by `agent`, so non-registry noise would surface phantom
    // agents in the ranking. Shares the same gate builder; fail-opens on an
    // empty registry.
    const agentMembershipFilter = buildAgentMembershipFilter(
      await loadCanonicalAgentKeys(),
    );
    // GROUP BY agent over the window — same record_ts >= CURRENT_DATE - INTERVAL
    // bound as success-rate/failure-patterns. Denominator excludes only
    // needs_context (matches the success-rate result-set convention: keeps
    // blocked+fail, drops the not-an-evaluation needs_context rows). Both the
    // total_count denominator and the review_flagged numerator filter on the
    // same result set so the ratio is internally consistent. review_flag_ratio
    // is NULL when the filtered denominator is 0 (an agent with only
    // needs_context rows) — coerced to 0 defensively at map time.
    const rows = await prisma.$queryRaw<ReviewFlagByAgentDbRow[]>`
      SELECT
        agent,
        COUNT(*) FILTER (
          WHERE result::text IN ('done', 'done_with_concerns', 'blocked', 'fail')
        )::bigint                                                    AS total_count,
        COUNT(*) FILTER (
          WHERE review_flag = true
            AND result::text IN ('done', 'done_with_concerns', 'blocked', 'fail')
        )::bigint                                                    AS review_flagged_count,
        COUNT(*) FILTER (
          WHERE review_flag = true
            AND result::text IN ('done', 'done_with_concerns', 'blocked', 'fail')
            AND ${buildReconstructedRowFilter()}
        )::bigint                                                    AS reconstructed_count,
        CASE
          WHEN COUNT(*) FILTER (
            WHERE result::text IN ('done', 'done_with_concerns', 'blocked', 'fail')
          ) = 0 THEN NULL
          ELSE (
            COUNT(*) FILTER (
              WHERE review_flag = true
                AND result::text IN ('done', 'done_with_concerns', 'blocked', 'fail')
            )::numeric
            / NULLIF(
                COUNT(*) FILTER (
                  WHERE result::text IN ('done', 'done_with_concerns', 'blocked', 'fail')
                ),
                0
              )
          )::numeric(8,6)
        END                                                          AS review_flag_ratio
      FROM core.outcomes
      WHERE record_ts >= ${windowLowerBound}
        ${agentMembershipFilter}
      GROUP BY agent
      ORDER BY total_count DESC, agent ASC
    `;

    const mapped = mapReviewFlagByAgentRows(rows);

    request.log.info(
      {
        route: "/api/agents/review-flag-by-agent",
        days,
        rowCount: mapped.length,
        durationMs: Date.now() - start,
      },
      "agents query complete",
    );
    return { days, rows: mapped, fetched_at: new Date().toISOString() };
  } catch (error) {
    return failWithDb(request, reply, "/api/agents/review-flag-by-agent", error);
  }
}

// Test-visible — bigint→number coercion + reconstructed sub-count pass-through.
// reconstructed_count isolates the harness-synthesized portion of
// review_flagged_count, so the FE defaults the flagged headline to writer-emitted
// (review_flagged_count - reconstructed_count). Clamp keeps the derivation safe
// (0 <= reconstructed_count <= review_flagged_count) even on a malformed row.
export function mapReviewFlagByAgentRows(
  rows: ReadonlyArray<ReviewFlagByAgentDbRow>,
): AgentReviewFlagByAgentRow[] {
  return rows.map((row) => {
    const reviewFlaggedCount = bigintToNumber(row.review_flagged_count);
    const reconstructedCount = Math.min(
      bigintToNumber(row.reconstructed_count),
      reviewFlaggedCount,
    );
    return {
      agent: row.agent,
      total_count: bigintToNumber(row.total_count),
      review_flagged_count: reviewFlaggedCount,
      reconstructed_count: reconstructedCount,
      review_flag_ratio:
        row.review_flag_ratio === null ? 0 : decimalToNumber(row.review_flag_ratio),
    };
  });
}

// GET /api/agents/failure-patterns?days={7|30|90}
async function handleFailurePatterns(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<AgentFailurePatternsResponse | AgentsErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days);
  if (days === null) {
    return reply.code(400).send(invalidDays());
  }

  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    // CTE strategy:
    //   breakages: per-agent fail/blocked aggregates — drives ORDER BY + LIMIT.
    //   agent_totals: per-agent total outcome count — denominator for fail_rate.
    //   ranked_concerns: unnest concerns from breakage rows, rank top 5 per agent.
    // array_agg ORDER BY concern_rank yields the top_concerns array in rank order.
    // The outer LEFT JOIN keeps agents whose breakage rows had empty `concerns`.
    // Canonical-membership gate (registry SoT) — applied to the breakage-ranking
    // source CTEs so non-registry noise (Claude Code built-ins, plugin/cron
    // parents, sentinels, one-off cids) can't occupy a top-N ranking slot or skew
    // the fail_rate denominator. `breakages` drives ORDER BY + LIMIT, so gating it
    // is essential; `agent_totals` (fail_rate denominator) and `ranked_concerns`
    // (top_concerns) are gated too for a consistent registry-only picture. The
    // aliased ranked_concerns read takes the o.agent column ref. Fail-opens on an
    // empty registry.
    const canonicalAgentKeys = await loadCanonicalAgentKeys();
    const agentMembershipFilter = buildAgentMembershipFilter(canonicalAgentKeys);
    const agentMembershipFilterO = buildAgentMembershipFilter(
      canonicalAgentKeys,
      Prisma.sql`o.agent`,
    );
    const rows = await prisma.$queryRaw<FailurePatternsDbRow[]>`
      WITH breakages AS (
        SELECT
          agent,
          COUNT(*) FILTER (WHERE result::text = 'fail')::bigint    AS fail_count,
          COUNT(*) FILTER (WHERE result::text = 'blocked')::bigint AS blocked_count,
          COUNT(*)::bigint                                          AS total_breakages,
          COUNT(*) FILTER (
            WHERE ${buildReconstructedRowFilter()}
          )::bigint                                                 AS reconstructed_count,
          MAX(record_ts)                                            AS last_breakage_at
        FROM core.outcomes
        WHERE record_ts >= ${windowLowerBound}
          AND result::text IN ('fail', 'blocked')
          ${agentMembershipFilter}
        GROUP BY agent
      ),
      agent_totals AS (
        SELECT
          agent,
          COUNT(*)::bigint AS total_outcomes
        FROM core.outcomes
        WHERE record_ts >= ${windowLowerBound}
          ${agentMembershipFilter}
        GROUP BY agent
      ),
      ranked_concerns AS (
        SELECT
          agent,
          concern,
          ROW_NUMBER() OVER (
            PARTITION BY agent
            ORDER BY occurrences DESC, concern ASC
          ) AS concern_rank
        FROM (
          SELECT
            o.agent,
            unnest(o.concerns) AS concern,
            COUNT(*)           AS occurrences
          FROM core.outcomes o
          WHERE o.record_ts >= ${windowLowerBound}
            AND o.result::text IN ('fail', 'blocked')
            AND o.concerns IS NOT NULL
            AND array_length(o.concerns, 1) > 0
            ${agentMembershipFilterO}
          GROUP BY o.agent, concern
        ) per_concern
      ),
      top_concerns_agg AS (
        SELECT
          agent,
          array_agg(concern ORDER BY concern_rank ASC) AS top_concerns
        FROM ranked_concerns
        WHERE concern_rank <= 5
        GROUP BY agent
      )
      SELECT
        b.agent,
        b.fail_count,
        b.blocked_count,
        b.total_breakages,
        b.reconstructed_count,
        (b.total_breakages::numeric / NULLIF(t.total_outcomes, 0))::numeric(8,6) AS fail_rate,
        b.last_breakage_at,
        COALESCE(c.top_concerns, ARRAY[]::text[]) AS top_concerns
      FROM breakages b
      JOIN agent_totals t ON t.agent = b.agent
      LEFT JOIN top_concerns_agg c ON c.agent = b.agent
      ORDER BY b.total_breakages DESC, b.agent ASC
      LIMIT ${FAILURE_PATTERNS_LIMIT}
    `;

    const mapped = mapFailurePatternRows(rows);

    request.log.info(
      {
        route: "/api/agents/failure-patterns",
        days,
        rowCount: mapped.length,
        durationMs: Date.now() - start,
      },
      "agents query complete",
    );
    return { days, rows: mapped, fetched_at: new Date().toISOString() };
  } catch (error) {
    return failWithDb(request, reply, "/api/agents/failure-patterns", error);
  }
}

// Test-visible — bigint→number coercion + reconstructed sub-count pass-through.
// reconstructed_count isolates the harness-synthesized portion of total_breakages
// so the FE defaults the breakages headline to writer-emitted (total_breakages -
// reconstructed_count). Clamp keeps 0 <= reconstructed_count <= total_breakages.
export function mapFailurePatternRows(
  rows: ReadonlyArray<FailurePatternsDbRow>,
): AgentFailurePatternRow[] {
  return rows.map((row) => {
    const totalBreakages = bigintToNumber(row.total_breakages);
    // breakage_rate NULL only if total_outcomes was 0 — impossible here because
    // the breakages CTE proves at least one outcome exists for the agent. Coerce
    // to 0 defensively rather than leak a null through the `number` field.
    // fail_rate = deprecated alias (numerator includes blocked — name was wrong).
    const breakageRate = row.fail_rate === null ? 0 : decimalToNumber(row.fail_rate);
    return {
      agent: row.agent,
      fail_count: bigintToNumber(row.fail_count),
      blocked_count: bigintToNumber(row.blocked_count),
      total_breakages: totalBreakages,
      reconstructed_count: Math.min(bigintToNumber(row.reconstructed_count), totalBreakages),
      fail_rate: breakageRate,
      breakage_rate: breakageRate,
      last_breakage_at: row.last_breakage_at.toISOString(),
      top_concerns: row.top_concerns,
    };
  });
}

// GET /api/agents/lifecycle-stats?days={7|30|90}
async function handleLifecycleStats(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<AgentLifecycleStatsResponse | AgentsErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days);
  if (days === null) {
    return reply.code(400).send(invalidDays());
  }

  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    // CTE strategy:
    //   per_agent_id: pair MIN(Start) ↔ MAX(Stop) per agent_id, keeping rows that
    //                 have both events (HAVING). Orphan starts (no matching Stop)
    //                 are excluded from duration math but counted in start_count.
    //   per_type: aggregate Start/Stop/completed counts per agent_type independently
    //             of the pairing CTE, so orphan starts still increment start_count.
    //   Final SELECT joins the two for per-agent_type roll-up.
    // PERCENTILE_CONT(0.95) returns double precision; cast to numeric for the
    // shared decimalToNumber helper.
    // Canonical-membership gate (registry SoT) — applied to BOTH source CTEs that
    // read raw core.agent_events (per_agent_id feeds the duration percentiles,
    // per_type_counts feeds start_count/stop_count) so start_count cannot diverge
    // from the duration stats. The derived per_type_durations inherits the gate
    // (reads FROM per_agent_id) and the final `LEFT JOIN per_type_durations d ON
    // d.agent_type = c.agent_type` stays ungated (a safe roll-up — a predicate in
    // that ON clause is not needed). columnRef = agent_type; fail-opens on an
    // empty registry.
    const agentMembershipFilter = buildAgentMembershipFilter(
      await loadCanonicalAgentKeys(),
      Prisma.sql`agent_type`,
    );
    const rows = await prisma.$queryRaw<LifecycleStatsDbRow[]>`
      WITH per_agent_id AS (
        SELECT
          agent_type,
          agent_id,
          EXTRACT(EPOCH FROM (
            MAX(event_ts) FILTER (WHERE event_name = 'SubagentStop')
            - MIN(event_ts) FILTER (WHERE event_name = 'SubagentStart')
          )) AS duration_sec
        FROM core.agent_events
        WHERE event_ts >= ${windowLowerBound}
          ${agentMembershipFilter}
        GROUP BY agent_type, agent_id
        HAVING
          MIN(event_ts) FILTER (WHERE event_name = 'SubagentStart') IS NOT NULL
          AND MAX(event_ts) FILTER (WHERE event_name = 'SubagentStop') IS NOT NULL
      ),
      per_type_counts AS (
        SELECT
          agent_type,
          COUNT(*) FILTER (WHERE event_name = 'SubagentStart')::bigint AS start_count,
          COUNT(*) FILTER (WHERE event_name = 'SubagentStop')::bigint  AS stop_count
        FROM core.agent_events
        WHERE event_ts >= ${windowLowerBound}
          ${agentMembershipFilter}
        GROUP BY agent_type
      ),
      per_type_durations AS (
        SELECT
          agent_type,
          COUNT(*)::bigint                                                       AS completed_count,
          AVG(duration_sec)::numeric(12,3)                                       AS avg_duration_sec,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_sec)::numeric(12,3) AS p95_duration_sec,
          MAX(duration_sec)::numeric(12,3)                                       AS max_duration_sec
        FROM per_agent_id
        WHERE duration_sec IS NOT NULL AND duration_sec >= 0
        GROUP BY agent_type
      )
      SELECT
        c.agent_type,
        c.start_count,
        c.stop_count,
        COALESCE(d.completed_count, 0)::bigint AS completed_count,
        d.avg_duration_sec,
        d.p95_duration_sec,
        d.max_duration_sec
      FROM per_type_counts c
      LEFT JOIN per_type_durations d ON d.agent_type = c.agent_type
      ORDER BY c.start_count DESC, c.agent_type ASC
    `;

    const mapped: AgentLifecycleStatsRow[] = rows.map((row) => ({
      agent_type: row.agent_type,
      start_count: bigintToNumber(row.start_count),
      stop_count: bigintToNumber(row.stop_count),
      completed_count: bigintToNumber(row.completed_count),
      avg_duration_sec:
        row.avg_duration_sec === null ? null : decimalToNumber(row.avg_duration_sec),
      p95_duration_sec:
        row.p95_duration_sec === null ? null : decimalToNumber(row.p95_duration_sec),
      max_duration_sec:
        row.max_duration_sec === null ? null : decimalToNumber(row.max_duration_sec),
    }));

    request.log.info(
      {
        route: "/api/agents/lifecycle-stats",
        days,
        rowCount: mapped.length,
        durationMs: Date.now() - start,
      },
      "agents query complete",
    );
    return { days, rows: mapped, fetched_at: new Date().toISOString() };
  } catch (error) {
    return failWithDb(request, reply, "/api/agents/lifecycle-stats", error);
  }
}

// GET /api/agents/summary?days={1-90}&order={runs|success|p95}&limit={1-50}
//
// cost ALWAYS null + meta.cost_attribution = "unavailable": core.cost_events
// lacks an `agent` column and core.outcomes lacks session_id, so no per-agent
// join key exists. Distributing cost evenly or estimating is FORBIDDEN.
async function handleSummary(
  request: FastifyRequest<{
    Querystring: { days?: string; order?: string; limit?: string };
  }>,
  reply: FastifyReply,
): Promise<AgentSummaryResponse | AgentsErrorBody> {
  const start = Date.now();

  const days = parseRangeIntParam(
    request.query.days,
    SUMMARY_DAYS_MIN,
    SUMMARY_DAYS_MAX,
    SUMMARY_DAYS_DEFAULT,
  );
  if (days === null) {
    return reply.code(400).send(invalidRangeParam("days", SUMMARY_DAYS_MIN, SUMMARY_DAYS_MAX));
  }
  const order = parseSummaryOrderParam(request.query.order);
  if (order === null) {
    return reply.code(400).send({
      error: "invalid_param",
      param: "order",
      reason: `must be one of ${Array.from(ALLOWED_SUMMARY_SORTS).join("|")}`,
    } satisfies AgentsErrorBody);
  }
  const limit = parseRangeIntParam(
    request.query.limit,
    SUMMARY_LIMIT_MIN,
    SUMMARY_LIMIT_MAX,
    SUMMARY_LIMIT_DEFAULT,
  );
  if (limit === null) {
    return reply.code(400).send(invalidRangeParam("limit", SUMMARY_LIMIT_MIN, SUMMARY_LIMIT_MAX));
  }

  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    // 4-way parallel (independent fetches) — outcomes-side aggregates +
    // agent_events latency + agent_events invocation count + registry.
    // The outcome side drives the agent set (agent NAME column); latency +
    // invocations join by agent_type back to that name (existing lifecycle-stats
    // convention). DISTINCT ON yields the latest outcome per agent for
    // last_result/last_run_at. Registry maps agent name → compatibility metadata;
    // a missing/corrupt registry yields an empty Map → all agents get
    // compatibility = null (backwards-compat).
    const [outcomeRows, latencyRows, invocationsRows, registryEntries] = await Promise.all([
      prisma.$queryRaw<SummaryOutcomeDbRow[]>`
        WITH last_per_agent AS (
          SELECT DISTINCT ON (agent)
            agent,
            record_ts AS last_run_at,
            result::text AS last_result
          FROM core.outcomes
          WHERE record_ts >= ${windowLowerBound}
          ORDER BY agent, record_ts DESC
        ),
        rollup AS (
          SELECT
            agent,
            COUNT(*)::bigint                                              AS runs,
            COUNT(*) FILTER (
              WHERE result::text IN ('done', 'done_with_concerns')
            )::bigint                                                     AS success_count,
            COUNT(*) FILTER (
              WHERE result::text IN ('done', 'done_with_concerns', 'blocked', 'fail')
            )::bigint                                                     AS denom_count,
            COUNT(*) FILTER (
              WHERE result::text = 'needs_context'
            )::bigint                                                     AS needs_context_count
          FROM core.outcomes
          WHERE record_ts >= ${windowLowerBound}
          GROUP BY agent
        )
        SELECT
          r.agent,
          r.runs,
          r.success_count,
          r.denom_count,
          r.needs_context_count,
          l.last_run_at,
          l.last_result
        FROM rollup r
        JOIN last_per_agent l ON l.agent = r.agent
      `,
      prisma.$queryRaw<SummaryLatencyDbRow[]>`
        WITH paired AS (
          SELECT
            agent_type,
            EXTRACT(EPOCH FROM (
              MAX(event_ts) FILTER (WHERE event_name = 'SubagentStop')
              - MIN(event_ts) FILTER (WHERE event_name = 'SubagentStart')
            )) * 1000.0 AS duration_ms
          FROM core.agent_events
          WHERE event_ts >= ${windowLowerBound}
          GROUP BY agent_type, agent_id
          HAVING
            MIN(event_ts) FILTER (WHERE event_name = 'SubagentStart') IS NOT NULL
            AND MAX(event_ts) FILTER (WHERE event_name = 'SubagentStop') IS NOT NULL
        )
        SELECT
          agent_type,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric(14,3) AS p95_ms
        FROM paired
        WHERE duration_ms IS NOT NULL AND duration_ms >= 0
        GROUP BY agent_type
      `,
      // SubagentStart count = spawn frequency — a signal distinct from the
      // outcomes-derived `runs` (outcome emit frequency). Feeds low-utilization
      // agent triage. Index: agent_events_type_ts_idx (agent_type, event_ts).
      // Orphan Stops excluded (Start only) — matches the invocation-count definition.
      prisma.$queryRaw<SummaryInvocationsDbRow[]>`
        SELECT
          agent_type,
          COUNT(*)::bigint AS invocations
        FROM core.agent_events
        WHERE event_ts >= ${windowLowerBound}
          AND event_name = 'SubagentStart'
        GROUP BY agent_type
      `,
      loadAgentRegistry(),
    ]);

    // Index latency by agent_type (matches outcomes.agent semantically — both
    // hold the agent NAME string).
    const p95ByAgent = new Map<string, number | null>();
    for (const row of latencyRows) {
      p95ByAgent.set(
        row.agent_type,
        row.p95_ms === null ? null : Math.round(decimalToNumber(row.p95_ms)),
      );
    }

    // agent_type → SubagentStart count lookup.
    // Map miss = outcomes-only agent (e.g., orchestrator emits outcomes but
    // is not a SubagentStart target) → null per type contract (informational).
    const invocationsByAgent = buildInvocationsMap(invocationsRows);

    const now = Date.now();
    const items: AgentSummaryItem[] = outcomeRows.map((row) =>
      rowToSummaryItem(row, {
        now,
        p95ByAgent,
        invocationsByAgent,
        compatibility: registryEntries.get(row.agent)?.compatibility ?? null,
        description: registryEntries.get(row.agent)?.description ?? null,
        dualPhase: registryEntries.get(row.agent)?.dual_phase ?? false,
        origin: registryEntries.get(row.agent)?.origin ?? null,
      }),
    );

    // Canonical-membership filter — show only Atrium-system agents (registry SoT).
    // Applied BEFORE sort+slice so LIMIT operates on canonical rows. Fail-soft:
    // an empty registry (read/parse failure) skips the predicate (fail-open).
    const canonicalItems =
      registryEntries.size === 0
        ? items
        : items.filter((item) => registryEntries.has(item.agent_name));

    // Sort + limit per `order` allowlist. Tiebreaker on agent_name keeps output
    // deterministic across pagination (FE depends on stable order for diff highlighting).
    const sorted = sortSummaryItems(canonicalItems, order);
    const limited = sorted.slice(0, limit);

    const periodEnd = formatDateOnly(new Date(now));
    const periodStart = formatDateOnly(new Date(now - days * 86_400_000));

    request.log.info(
      {
        route: "/api/agents/summary",
        days,
        order,
        limit,
        totalAgents: canonicalItems.length,
        returned: limited.length,
        durationMs: Date.now() - start,
      },
      "agents query complete",
    );
    return {
      agents: limited,
      meta: {
        days,
        total_agents: canonicalItems.length,
        period_start: periodStart,
        period_end: periodEnd,
        // honesty flag — cost attribution is unavailable (see handler note above).
        cost_attribution: "unavailable",
      },
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/agents/summary", error);
  }
}

function classifySummaryStatus(
  lastRunAtMs: number,
  lastResult: string,
  nowMs: number,
): AgentSummaryStatus {
  const ageMs = nowMs - lastRunAtMs;
  // status semantics: 24h → active, 24h-7d → idle, > 7d → inactive,
  // most-recent fail → error overrides above.
  if (lastResult === "fail") {
    return "error";
  }
  if (ageMs <= STATUS_ACTIVE_MS) {
    return "active";
  }
  if (ageMs <= STATUS_IDLE_MS) {
    return "idle";
  }
  return "inactive";
}

// Test-visible — invocation count lookup builder.
// Map miss = outcomes-only agent (orchestrator etc.) → caller emits null.
export function buildInvocationsMap(
  rows: ReadonlyArray<SummaryInvocationsDbRow>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.agent_type, bigintToNumber(row.invocations));
  }
  return map;
}

// Per-row projection — context bag avoids 6-param signature. Test-visible export.
interface SummaryItemContext {
  now: number;
  p95ByAgent: ReadonlyMap<string, number | null>;
  invocationsByAgent: ReadonlyMap<string, number>;
  compatibility: string | null;
  description: string | null;
  dualPhase: boolean;
  origin: string | null;
}

export function rowToSummaryItem(
  row: SummaryOutcomeDbRow,
  ctx: SummaryItemContext,
): AgentSummaryItem {
  const runs = bigintToNumber(row.runs);
  const successCount = bigintToNumber(row.success_count);
  const denomCount = bigintToNumber(row.denom_count);
  // Matrix semantics — success/(done+dwc+blocked+fail); needs_context excluded
  // from the denominator and surfaced as its own count.
  const successPct = denomCount === 0 ? 0 : (successCount / denomCount) * 100;
  // p95 lookup — null when agent has no Start/Stop pair in window.
  const p95 = ctx.p95ByAgent.has(row.agent) ? (ctx.p95ByAgent.get(row.agent) ?? null) : null;
  // invocations — Map miss = null (outcomes-only agent · informational).
  const invocations = ctx.invocationsByAgent.has(row.agent)
    ? (ctx.invocationsByAgent.get(row.agent) ?? null)
    : null;
  return {
    // agent_id == agent_name in current cycle (outcomes uses NAME column).
    // Schema migration with stable id will widen this contract.
    agent_id: row.agent,
    agent_name: row.agent,
    runs,
    // Round to 2 dp for stable JSON output.
    success_pct: Math.round(successPct * 100) / 100,
    needs_context_count: bigintToNumber(row.needs_context_count),
    // cost attribution unavailable — always null (see handleSummary note).
    cost: null,
    p95_ms: p95,
    status: classifySummaryStatus(row.last_run_at.getTime(), row.last_result, ctx.now),
    last_run_at: row.last_run_at.toISOString(),
    compatibility: ctx.compatibility,
    description: ctx.description,
    dual_phase: ctx.dualPhase,
    origin: ctx.origin,
    invocations,
    invocations_30d: invocations,
  };
}

function sortSummaryItems(
  items: ReadonlyArray<AgentSummaryItem>,
  order: AgentSummarySortKey,
): AgentSummaryItem[] {
  // Sort key allowlist: order is one of {name, runs, success, p95}. Ascending
  // localeCompare for name; descending for runs/success (higher = more
  // interesting); ascending for p95 (lower = faster). Null p95 sinks regardless.
  const copy = [...items];
  switch (order) {
    case "name":
      copy.sort((a, b) => a.agent_name.localeCompare(b.agent_name));
      break;
    case "runs":
      copy.sort((a, b) => b.runs - a.runs || a.agent_name.localeCompare(b.agent_name));
      break;
    case "success":
      copy.sort(
        (a, b) => b.success_pct - a.success_pct || a.agent_name.localeCompare(b.agent_name),
      );
      break;
    case "p95":
      copy.sort((a, b) => {
        const aP = a.p95_ms;
        const bP = b.p95_ms;
        if (aP === null && bP === null) return a.agent_name.localeCompare(b.agent_name);
        if (aP === null) return 1; // nulls sink
        if (bP === null) return -1;
        return aP - bP || a.agent_name.localeCompare(b.agent_name);
      });
      break;
  }
  return copy;
}

// GET /api/agents/latency?days={1-30} — P50/P95/P99 via Start↔Stop pairing.
async function handleLatency(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<AgentLatencyResponse | AgentsErrorBody> {
  const start = Date.now();
  const days = parseRangeIntParam(
    request.query.days,
    LATENCY_DAYS_MIN,
    LATENCY_DAYS_MAX,
    LATENCY_DAYS_DEFAULT,
  );
  if (days === null) {
    return reply.code(400).send(invalidRangeParam("days", LATENCY_DAYS_MIN, LATENCY_DAYS_MAX));
  }

  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    // Canonical-membership gate (registry SoT) — filter raw core.agent_events by
    // agent_type BEFORE the Start↔Stop pairing so non-registry spawn noise
    // (general-purpose, Explore, plugin agents, sentinels) cannot skew the
    // percentile buckets. Single gate point — the outer SELECT ... FROM paired
    // needs no predicate. columnRef = agent_type; fail-opens on an empty registry.
    const agentMembershipFilter = buildAgentMembershipFilter(
      await loadCanonicalAgentKeys(),
      Prisma.sql`agent_type`,
    );
    // Pairing CTE same as lifecycle-stats — but now compute three percentiles
    // in one pass. duration_ms is float (epoch * 1000); cast to numeric so the
    // shared decimalToNumber helper applies without precision loss.
    const rows = await prisma.$queryRaw<LatencyDbRow[]>`
      WITH paired AS (
        SELECT
          agent_type,
          EXTRACT(EPOCH FROM (
            MAX(event_ts) FILTER (WHERE event_name = 'SubagentStop')
            - MIN(event_ts) FILTER (WHERE event_name = 'SubagentStart')
          )) * 1000.0 AS duration_ms
        FROM core.agent_events
        WHERE event_ts >= ${windowLowerBound}
          ${agentMembershipFilter}
        GROUP BY agent_type, agent_id
        HAVING
          MIN(event_ts) FILTER (WHERE event_name = 'SubagentStart') IS NOT NULL
          AND MAX(event_ts) FILTER (WHERE event_name = 'SubagentStop') IS NOT NULL
      )
      SELECT
        agent_type,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms)::numeric(14,3) AS p50_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric(14,3) AS p95_ms,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms)::numeric(14,3) AS p99_ms
      FROM paired
      WHERE duration_ms IS NOT NULL AND duration_ms >= 0
      GROUP BY agent_type
      ORDER BY agent_type ASC
    `;

    const items: AgentLatencyItem[] = rows.map((row) => ({
      // agent_id == agent_name (same convention as /summary).
      agent_id: row.agent_type,
      agent_name: row.agent_type,
      // when pairing absent, percentile_cont returns NULL; emit null rather than
      // substituting a default (default-value injection is banned).
      p50_ms: row.p50_ms === null ? null : Math.round(decimalToNumber(row.p50_ms)),
      p95_ms: row.p95_ms === null ? null : Math.round(decimalToNumber(row.p95_ms)),
      p99_ms: row.p99_ms === null ? null : Math.round(decimalToNumber(row.p99_ms)),
    }));

    const now = Date.now();
    const periodEnd = formatDateOnly(new Date(now));
    const periodStart = formatDateOnly(new Date(now - days * 86_400_000));

    request.log.info(
      {
        route: "/api/agents/latency",
        days,
        totalAgents: items.length,
        durationMs: Date.now() - start,
      },
      "agents query complete",
    );
    return {
      agents: items,
      meta: {
        days,
        total_agents: items.length,
        period_start: periodStart,
        period_end: periodEnd,
      },
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/agents/latency", error);
  }
}

// GET /api/agents/failure-reasons?agent=<name>&days={1-90}&result={fail|blocked}
// (keyword-approximate classification on directive_hint, scoped to the requested
// breakage result-type)
//
// `result` selects which breakage dimension is classified. Default 'fail'
// preserves the fail-only contract for existing consumers; 'blocked' surfaces
// the dominant breakage type otherwise invisible in cause analysis. Same
// classification logic across both result-types — only the SQL result filter
// and the response `result_type` dimension differ.

async function handleFailureReasons(
  request: FastifyRequest<{
    Querystring: { agent?: string; days?: string; result?: string };
  }>,
  reply: FastifyReply,
): Promise<AgentFailureReasonsResponse | AgentsErrorBody> {
  const start = Date.now();
  const agent = parseAgentParam(request.query.agent);
  if (agent === null) {
    return reply.code(400).send({
      error: "invalid_param",
      param: "agent",
      reason: `required, length 1-${AGENT_PARAM_MAX_LENGTH}`,
    } satisfies AgentsErrorBody);
  }
  const days = parseRangeIntParam(
    request.query.days,
    FAILURE_REASONS_DAYS_MIN,
    FAILURE_REASONS_DAYS_MAX,
    FAILURE_REASONS_DAYS_DEFAULT,
  );
  if (days === null) {
    return reply
      .code(400)
      .send(invalidRangeParam("days", FAILURE_REASONS_DAYS_MIN, FAILURE_REASONS_DAYS_MAX));
  }
  const resultType = parseResultTypeParam(request.query.result);
  if (resultType === null) {
    return reply.code(400).send({
      error: "invalid_param",
      param: "result",
      reason: `must be one of ${Array.from(ALLOWED_FAILURE_RESULT_TYPES).join("|")}`,
    } satisfies AgentsErrorBody);
  }

  const windowLowerBound = buildWindowLowerBound(days);
  const prisma = getPrisma();
  try {
    // Canonical-membership gate (registry SoT) — a non-registry `agent` query
    // param yields an empty breakdown, so the cause analysis is registry-only.
    // columnRef = default `agent`; fail-opens on an empty registry.
    const agentMembershipFilter = buildAgentMembershipFilter(
      await loadCanonicalAgentKeys(),
    );
    // Pull the classification-signal columns — classification is JS-side because
    // the keyword catalog lives there. result filter is parameterized to the
    // allowlist-validated resultType (fail | blocked) — Prisma binds it as a
    // value, so no result literal is interpolated into the SQL text.
    const rows = await prisma.$queryRaw<FailureReasonDbRow[]>`
      SELECT directive_hint, concerns, summary
      FROM core.outcomes
      WHERE record_ts >= ${windowLowerBound}
        AND result::text = ${resultType}
        AND agent = ${agent}
        ${agentMembershipFilter}
    `;

    // Breakage count for the requested result-type — denominator for pct.
    const totalBreakages = rows.length;
    // Bucket counts initialized to 0; classified rows increment one bucket.
    // Rows with no signal in any source column go to 'other'.
    const counts = new Map<AgentFailureReasonCategory, number>();
    for (const row of rows) {
      const category = classifyFailureReason(buildFailureReasonHaystack(row));
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }

    // emit only categories with count > 0; pct sums to 100.
    // Stable ordering: deterministic by keyword-table order, then 'other'.
    const allCategories: ReadonlyArray<AgentFailureReasonCategory> = [
      ...FAILURE_KEYWORDS.map((k) => k.category),
      "other",
    ];
    const reasons: AgentFailureReasonRow[] = [];
    for (const category of allCategories) {
      const count = counts.get(category) ?? 0;
      if (count === 0) continue;
      // Round to 1 dp; final row absorbs rounding drift so sum = 100 exactly.
      const pctRaw = totalBreakages === 0 ? 0 : (count / totalBreakages) * 100;
      reasons.push({ category, count, pct: Math.round(pctRaw * 10) / 10 });
    }
    rebalancePctSum(reasons);

    request.log.info(
      {
        route: "/api/agents/failure-reasons",
        agent,
        days,
        resultType,
        totalBreakages,
        categoriesEmitted: reasons.length,
        durationMs: Date.now() - start,
      },
      "agents query complete",
    );
    return {
      reasons,
      meta: {
        agent,
        days,
        // Backward-compat field name; reflects the requested result-type count.
        total_failures: totalBreakages,
        result_type: resultType,
        // FE renders an approximate-classification badge on this flag.
        classification_method: "keyword_approximate",
      },
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/agents/failure-reasons", error);
  }
}

// Concatenated cause text per breakage row — concerns[] first (most specific),
// then summary, then directive_hint (legacy, near-always NULL).
function buildFailureReasonHaystack(row: FailureReasonDbRow): string {
  return [...(row.concerns ?? []), row.summary, row.directive_hint ?? ""]
    .join(" ")
    .trim();
}

function classifyFailureReason(signalText: string | null): AgentFailureReasonCategory {
  // No signal to classify against → bucket as 'other'.
  if (signalText === null || signalText.length === 0) {
    return "other";
  }
  const haystack = signalText.toLowerCase();
  for (const entry of FAILURE_KEYWORDS) {
    for (const keyword of entry.keywords) {
      if (haystack.includes(keyword)) {
        return entry.category;
      }
    }
  }
  return "other";
}

function rebalancePctSum(reasons: AgentFailureReasonRow[]): void {
  // After per-row Math.round to 1 dp, the sum can drift by ±0.1 across rows.
  // Absorb the drift in the LAST row so the `pct sum = 100` invariant holds
  // exactly. Mutates in place.
  if (reasons.length === 0) return;
  const total = reasons.reduce((acc, r) => acc + r.pct, 0);
  const drift = Math.round((100 - total) * 10) / 10;
  if (drift === 0) return;
  const last = reasons[reasons.length - 1];
  if (last !== undefined) {
    last.pct = Math.round((last.pct + drift) * 10) / 10;
  }
}

function parseDaysParam(raw: string | undefined): AgentsWindowDays | null {
  // Days is required for all 5 agent endpoints (no fallback) — empty value rejected.
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
  return parsed as AgentsWindowDays;
}

// Canonical "last N days" window lower bound — repo-wide SoT semantics from
// cost.ts buildWindowLowerBound: [CURRENT_DATE - (days-1) .. CURRENT_DATE]
// inclusive = exactly `days` calendar days (today counted), so every "최근 N일"
// card covers the identical day-set. Rolling NOW()-N is reserved for liveness
// fields only, never rate aggregates — /summary last_run_at/status stay liveness
// signals but derive from rows inside this calendar window.
// Prisma.raw is safe: `days` is allowlist/range-validated; `days - 1` is derived.
function buildWindowLowerBound(days: number): Prisma.Sql {
  return Prisma.raw(`CURRENT_DATE - INTERVAL '${days - 1} days'`);
}

// buildAgentMembershipFilter now lives in the shared `agents/registry.js` module
// (co-located with loadAgentRegistry) as the canonical-membership gate SoT — see
// its doc there. Re-exported (of the imported local binding) from this route
// module so the LIVE import surface consumed by
// test/agents.membership-filter.unit.test.ts (imports it from routes/agents.js)
// stays resolvable after the relocation.
export { buildAgentMembershipFilter };

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
  // Ratios fit in numeric(8,6); duration aggregates fit in numeric(12,3).
  // toString() → Number() yields a JSON-safe finite double.
  return Number(value.toString());
}

function formatDateOnly(date: Date): string {
  // PG DATE arrives as midnight UTC; toISOString preserves Y-M-D.
  return date.toISOString().slice(0, 10);
}

function failWithDb(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  error: unknown,
): AgentsErrorBody {
  return respondDbFailure(request, reply, route, error, "agents query failed");
}

function invalidDays(): AgentsErrorBody {
  return { error: "invalid_days", allowed: ALLOWED_DAYS };
}

// Integer-range parser for /summary, /latency, /failure-reasons. Empty value
// → fallback; non-integer or out-of-range → null (caller emits HTTP 400).
function parseRangeIntParam(
  raw: string | undefined,
  min: number,
  max: number,
  fallback: number,
): number | null {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

function parseSummaryOrderParam(raw: string | undefined): AgentSummarySortKey | null {
  if (raw === undefined || raw === "") {
    return "runs";
  }
  if (!ALLOWED_SUMMARY_SORTS.has(raw as AgentSummarySortKey)) {
    return null;
  }
  return raw as AgentSummarySortKey;
}

function parseAgentParam(raw: string | undefined): string | null {
  if (raw === undefined || raw.length === 0) {
    return null;
  }
  if (raw.length > AGENT_PARAM_MAX_LENGTH) {
    return null;
  }
  return raw;
}

// /failure-reasons `result` param. Empty/absent → default 'fail'
// (backward-compat); out-of-allowlist → null (caller emits HTTP 400).
function parseResultTypeParam(raw: string | undefined): AgentFailureReasonResultType | null {
  if (raw === undefined || raw === "") {
    return FAILURE_REASONS_RESULT_DEFAULT;
  }
  if (!ALLOWED_FAILURE_RESULT_TYPES.has(raw as AgentFailureReasonResultType)) {
    return null;
  }
  return raw as AgentFailureReasonResultType;
}

function invalidRangeParam(name: string, min: number, max: number): AgentsErrorBody {
  return { error: "invalid_param", param: name, reason: `must be integer in [${min}, ${max}]` };
}

// DELETE /api/agents/:name — writable DEV-agent DELETE via the agent_lifecycle
// CLI. The CLI owns the registry-mutation lock (single owner); this route only
// invokes it and maps the named exit codes to HTTP states.

const execFileAsync = promisify(execFile);

// server-startup seams (NEVER request-derived)

// Python interpreter + the agent_lifecycle package cwd are pinned at server
// startup. `python -m agent_lifecycle` resolves the package only when cwd is the
// `scripts/` dir that contains it, so cwd is part of the contract — not an
// argv element a request could influence. Env overrides are process-env test
// seams (mirrors improvement.ts resolveApplyScript + model-config.ts path seams).
function resolvePythonBin(): string {
  const override = process.env.AGENT_LIFECYCLE_PYTHON;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return "python3";
}

function resolveAgentLifecycleCwd(): string {
  const override = process.env.AGENT_LIFECYCLE_CWD;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  // The package lives under ~/.glass-atrium/scripts/agent_lifecycle — cwd is its
  // parent so `-m agent_lifecycle` imports it. Pinned home-dir constant.
  return path.join(homedir(), ".glass-atrium", "scripts");
}

// timeout + exit-code contract

// Generous ceiling for the long commit path — manifest regenerate + symlink
// swap dominate and can run several seconds on a cold farm. Well above the
// preview round-trip (gate+preflight only) so a slow commit is not killed
// mid-symlink-swap, which would itself need recovery.
const COMMIT_TIMEOUT_MS = 120_000;
const PREVIEW_TIMEOUT_MS = 20_000;

// agent_lifecycle CLI named exit codes (cli.py:46-50) → API result states.
//   0 EXIT_OK             committed
//   2 EXIT_USAGE          argv bug (post-validation) → 500 internal, NOT a client 400
//   4 EXIT_HALT           gate / pre-flight refusal, zero writes → 409
//   5 EXIT_TX_FAILED      forward step failed, rolled back cleanly → 500
//   6 EXIT_ROLLBACK_FAILED rollback failed, recovery marker written → 500
const CLI_EXIT_OK = 0;
const CLI_EXIT_USAGE = 2;
const CLI_EXIT_HALT = 4;
const CLI_EXIT_TX_FAILED = 5;
const CLI_EXIT_ROLLBACK_FAILED = 6;

// Agent-name charset — defense-in-depth alongside the CLI re-validation.
// Lowercase-slug shape; the DELETE :name param + --confirm token are gated on it.
// Leading char MUST be alphanumeric: a leading hyphen (e.g. "--dry-run") would be
// parsed by argparse as a CLI flag once passed positionally to agent_lifecycle.
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// Reconcile of the three inject-scope-rules.sh arrays is now executable: the
// named skill drives the tested CLI sync-inject verb (transactional .bak +
// atomic write + rollback), replacing the former manual hand-edit instruction.
const RECONCILE_SKILL = "glass-atrium-ops-reconcile-inject";
const RECONCILE_HINT = "run: python -m agent_lifecycle orphan-scan --mode reconcile";

// execFile invocation + exit-code → state mapping

interface CliInvocation {
  code: number;
  stdout: string;
  stderr: string;
}

// Run the CLI / preview snippet. cwd is pinned at server startup; env (PATH +
// PYTHONUNBUFFERED) is inherited. stdin carries the preview JSON (commit passes
// no stdin). Resolves with {code:0,...} on success; a non-zero exit rejects and
// is normalized by parseCliError into the same shape.
async function runCli(
  args: string[],
  opts: { timeoutMs: number; stdin?: string },
): Promise<CliInvocation> {
  try {
    const child = execFileAsync(resolvePythonBin(), args, {
      cwd: resolveAgentLifecycleCwd(),
      timeout: opts.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (opts.stdin !== undefined && child.child.stdin !== null) {
      child.child.stdin.end(opts.stdin);
    }
    const { stdout, stderr } = await child;
    return { code: CLI_EXIT_OK, stdout, stderr };
  } catch (error) {
    return parseCliError(error);
  }
}

// Type-safe extraction of exit code + stdout + stderr from a rejected
// promisified execFile (mirrors improvement.ts parseExecFileError). -1 sentinel
// = spawn error (ENOENT — python missing / cwd wrong), treated as infra 500.
function parseCliError(error: unknown): CliInvocation {
  if (typeof error !== "object" || error === null) {
    return { code: -1, stdout: "", stderr: String(error) };
  }
  const record = error as Record<string, unknown>;

  let code = -1;
  if (typeof record.code === "number") {
    code = record.code;
  }
  const stdout = readStream(record.stdout);
  let stderr = readStream(record.stderr);
  if (stderr.length === 0 && typeof record.message === "string") {
    stderr = record.message;
  }
  if (typeof record.code === "string" && stderr.length === 0) {
    stderr = record.code; // spawn error string code (ENOENT)
  }
  return { code, stdout, stderr };
}

function readStream(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Buffer) {
    return raw.toString("utf8");
  }
  return "";
}

// CLI HALT stderr carries one or more "HALT: ..." lines (gate reasons joined by
// "; "). Split into discrete reason strings for the client; fall back to the
// trimmed whole on no recognizable structure.
function splitReasons(stderr: string): string[] {
  const cleaned = stderr.replace(/^HALT:\s*/im, "").trim();
  if (cleaned.length === 0) {
    return ["gate refused (no reason text emitted)"];
  }
  return cleaned
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Recovery marker is printed by cli.py as `  recovery marker: <path>` on stderr
// (exit 6). Extract the path; empty string when not parseable.
function parseRecoveryMarker(stderr: string): string {
  const match = /recovery marker:\s*(.+)\s*$/im.exec(stderr);
  return match === null ? "" : match[1].trim();
}

// Single-line, length-clamped CLI output for user-facing bodies + logs.
function truncateCli(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 400 ? `${oneLine.slice(0, 399)}…` : oneLine;
}

// T2 — DELETE /api/agents/:name — gated DEV-agent DELETE via the CLI `delete`.

// The delete dry-run report (delete.py render_dry_run) carries `-> ALLOWED` or
// `-> REFUSED` on its first line, the reason on the `reason:` line, and the
// numbered target lines after `targets (nothing mutated):`. Parsed read-only;
// nothing in the report is a write.
function parseDeleteDryRun(stdout: string): DeleteAgentPreviewResult | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const lines = trimmed.split("\n");
  const header = lines[0] ?? "";
  // First line: `delete dry-run: <name> -> ALLOWED|REFUSED`.
  const headerMatch = /delete dry-run:\s*(\S+)\s*->\s*(ALLOWED|REFUSED)/.exec(header);
  if (headerMatch === null) {
    return null;
  }
  const name = headerMatch[1] ?? "";
  const allowed = headerMatch[2] === "ALLOWED";
  // `  reason: ...` line — the single authorization explanation.
  const reasonLine = lines.find((l) => /^\s*reason:/.test(l));
  const reason =
    reasonLine === undefined ? "" : reasonLine.replace(/^\s*reason:\s*/, "").trim();
  // The numbered `N. ...` target lines between the `targets ...:` marker and the
  // trailing `(dry-run: ...)` notice.
  const targets = lines
    .filter((l) => /^\s*\d+\.\s/.test(l))
    .map((l) => l.trim());
  return { result: "preview", name, allowed, reason, targets };
}

// Build the delete preview argv (`delete <name> --dry-run`). `name` is the sole
// positional; --dry-run forces the pure-read path (exit 0 even when REFUSED).
function buildDeletePreviewArgv(name: string): string[] {
  return ["-m", "agent_lifecycle", "delete", name, "--dry-run"];
}

// Build the delete commit argv (`delete <name> --confirm <confirm>`). Both are
// discrete execFile elements; the CLI re-checks `confirm === name` (hard gate),
// so a mismatch returns exit 4 (refused), never a silent delete.
export function buildDeleteCommitArgv(name: string, confirm: string): string[] {
  return ["-m", "agent_lifecycle", "delete", name, "--confirm", confirm];
}

export type DeleteBodyValidation =
  | { kind: "preview"; name: string }
  | { kind: "commit"; name: string; confirm: string }
  | { kind: "error"; body: AgentMutationErrorBody };

// Validate the :name route param + body BEFORE any child-process spawn. `name`
// is charset-gated (the CLI re-validates as the chokepoint — defense-in-depth).
export function validateDeleteRequest(rawName: string, rawBody: unknown): DeleteBodyValidation {
  if (typeof rawName !== "string" || !NAME_RE.test(rawName)) {
    return { kind: "error", body: invalidMutationBody("name", "must match ^[a-z0-9][a-z0-9-]*$") };
  }
  if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return { kind: "error", body: invalidMutationBody("body", "must be a JSON object") };
  }
  const body = rawBody as Record<string, unknown>;
  const mode = body.mode;
  if (mode === "preview") {
    return { kind: "preview", name: rawName };
  }
  if (mode === "commit") {
    const confirm = body.confirm;
    if (typeof confirm !== "string" || !NAME_RE.test(confirm)) {
      return {
        kind: "error",
        body: invalidMutationBody("confirm", "must match ^[a-z0-9][a-z0-9-]*$ (the typed agent name)"),
      };
    }
    return { kind: "commit", name: rawName, confirm };
  }
  return { kind: "error", body: invalidMutationBody("mode", "must be 'preview' or 'commit'") };
}

function invalidMutationBody(field: string, reason: string): AgentMutationErrorBody {
  return { error: "invalid_body", field, reason };
}

async function handleDeleteAgent(
  request: FastifyRequest<{ Params: { name: string }; Body: unknown }>,
  reply: FastifyReply,
): Promise<DeleteAgentResponse | AgentMutationErrorBody | AgentMutationInternalBody> {
  const start = Date.now();

  const validation = validateDeleteRequest(request.params.name, request.body);
  if (validation.kind === "error") {
    return reply.code(400).send(validation.body);
  }

  if (validation.kind === "preview") {
    return runDeletePreview(request, reply, validation.name, start);
  }
  return runDeleteCommit(request, reply, validation.name, validation.confirm, start);
}

async function runDeletePreview(
  request: FastifyRequest,
  reply: FastifyReply,
  name: string,
  start: number,
): Promise<DeleteAgentPreviewResult | AgentMutationInternalBody> {
  const cli = await runCli(buildDeletePreviewArgv(name), { timeoutMs: PREVIEW_TIMEOUT_MS });
  const logBase = {
    route: "DELETE /api/agents/:name",
    mode: "preview",
    name,
    code: cli.code,
    durationMs: Date.now() - start,
  };

  if (cli.code !== CLI_EXIT_OK) {
    // The dry-run is a pure read — any non-zero exit is an infra/usage bug
    // (a policy refusal still returns exit 0 with REFUSED in stdout).
    request.log.error({ ...logBase, stderr: truncateCli(cli.stderr) }, "agent-delete preview failed");
    reply.code(500);
    return { error: "internal", reason: `delete preview failed: ${truncateCli(cli.stderr)}` };
  }

  const parsed = parseDeleteDryRun(cli.stdout);
  if (parsed === null) {
    request.log.error({ ...logBase, stdout: truncateCli(cli.stdout) }, "agent-delete preview unparseable");
    reply.code(500);
    return { error: "internal", reason: "delete dry-run output was not parseable" };
  }

  request.log.info({ ...logBase, allowed: parsed.allowed }, "agent-delete preview complete");
  return parsed;
}

async function runDeleteCommit(
  request: FastifyRequest,
  reply: FastifyReply,
  name: string,
  confirm: string,
  start: number,
): Promise<DeleteAgentCommitResult | AgentMutationInternalBody> {
  // No route-level lock: the CLI's `run_delete` is the single owner of the
  // registry-mutation lock (flock, kernel-released on process exit — crash-safe).
  // A concurrent mutation surfaces as CLI EXIT_HALT → mapped to 409 `refused`.
  const cli = await runCli(buildDeleteCommitArgv(name, confirm), { timeoutMs: COMMIT_TIMEOUT_MS });
  return mapDeleteExit(request, reply, name, cli, start);
}

// exit-code → state mapper. Exit 4 is CONFLATED (block-list / fail-closed /
// policy / unconfirmed) → all map to `refused` with the CLI HALT reason.
function mapDeleteExit(
  request: FastifyRequest,
  reply: FastifyReply,
  name: string,
  cli: CliInvocation,
  start: number,
): DeleteAgentCommitResult | AgentMutationInternalBody {
  const logBase = {
    route: "DELETE /api/agents/:name",
    mode: "commit",
    name,
    code: cli.code,
    durationMs: Date.now() - start,
  };

  if (cli.code === CLI_EXIT_OK) {
    // The CLI rewrote agent-registry.json — evict the in-process singleton so the
    // next /summary (and every membership gate) excludes the deleted agent without
    // a server restart. mtime revalidation would also catch it, but explicit
    // eviction closes the same-millisecond-rewrite window.
    invalidateAgentRegistryCache();
    request.log.info(logBase, "agent-delete committed");
    return {
      result: "deleted",
      name,
      summary: cli.stdout.trim(),
      skill_to_run: RECONCILE_SKILL,
    };
  }

  if (cli.code === CLI_EXIT_HALT) {
    // Safety-gate refusal — block-list / fail-closed / policy / unconfirmed.
    // Zero writes. 409 (conflict with policy). Reason surfaced verbatim.
    request.log.warn({ ...logBase, stderr: truncateCli(cli.stderr) }, "agent-delete refused");
    reply.code(409);
    return { result: "refused", name, reasons: splitReasons(cli.stderr) };
  }

  if (cli.code === CLI_EXIT_TX_FAILED) {
    // A cleanup step failed, transaction rolled back cleanly — store left intact. 500.
    request.log.error({ ...logBase, stderr: truncateCli(cli.stderr) }, "agent-delete rolled back");
    reply.code(500);
    return { result: "rolled_back", name, detail: truncateCli(cli.stderr) };
  }

  if (cli.code === CLI_EXIT_ROLLBACK_FAILED) {
    // Rollback itself failed — recovery marker written; hand off to orphan-scan.
    request.log.error({ ...logBase, stderr: truncateCli(cli.stderr) }, "agent-delete recovery needed");
    reply.code(500);
    return {
      result: "recovery_needed",
      name,
      recovery_marker_path: parseRecoveryMarker(cli.stderr),
      remediation: RECONCILE_HINT,
      detail: truncateCli(cli.stderr),
    };
  }

  // exit 2 (USAGE) post-validation = a server-side argv bug; -1 = spawn error.
  // Both are 500 internal (the validation gate already rejected bad client input).
  request.log.error(
    { ...logBase, stderr: truncateCli(cli.stderr) },
    cli.code === CLI_EXIT_USAGE
      ? "agent-delete USAGE exit — argv-composition bug"
      : "agent-delete infra error (spawn/unknown exit)",
  );
  reply.code(500);
  return {
    error: "internal",
    reason: `agent_lifecycle exited ${cli.code}: ${truncateCli(cli.stderr)}`,
  };
}
