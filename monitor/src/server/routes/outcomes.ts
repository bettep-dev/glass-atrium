// Outcomes API — Outcome explorer 상세 화면용 read-only 엔드포인트 (Prisma 7 driver-adapter, raw SQL 은 $queryRaw template-tag 만).
// WHERE 는 활성 필터별 Prisma.Sql fragment 수집 → Prisma.join — 문자열 연결 없이 모든 사용자값이 파라미터 바인딩 경계 통과 (SQL injection 차단).
// 성능 주의: agent/task_type/review_flag 없는 `q` 키워드 /search 는 seq scan (summary/lesson full-text 인덱스 없음) — 4K행 규모 허용, >50K 시 pg_trgm/GIN 권장.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "../../generated/prisma/client.js";
import {
  buildAgentMembershipFilter,
  buildAgentMembershipFragment,
  loadCanonicalAgentKeys,
} from "../agents/registry.js";
import { getPrisma } from "../db.js";
import { respondDbFailure } from "../db-failure.js";
import { parseIdParam, parseOffsetParam } from "../route-params.js";
import { DAY_BUCKET_TIMEZONE } from "../timezone.js";
import { TASK_TYPES } from "../task-types.js";
import type {
  AttributionDailyPoint,
  AttributionDailyResponse,
  AttributionDailyWindowDays,
  BudgetTruncationAgentCount,
  LiteralOmissionBreakdown,
  OutcomeConfidenceLiteral,
  OutcomeCrossAnalysisByAgent,
  OutcomeCrossAnalysisByResult,
  OutcomeCrossAnalysisCell,
  OutcomeCrossAnalysisFilterEcho,
  OutcomeCrossAnalysisResponse,
  OutcomeDetailResponse,
  OutcomeDowngradeOrigin,
  OutcomeGraderBreakdown,
  OutcomeGraderVerdict,
  OutcomeHeatmapResponse,
  OutcomeHeatmapResultFilter,
  OutcomeResultLiteral,
  OutcomeSearchFilterEcho,
  OutcomeSearchResponse,
  OutcomeSearchRow,
  OutcomeSortToken,
  OutcomesErrorBody,
  OutcomesWindowDays,
  OutcomeTaskType,
  OutcomeTaskTypeGraderRow,
} from "../types/outcomes.js";

// allowlists

// 고정 allowlist — 쿼리 파라미터로의 임의 INTERVAL 주입 차단 · 'all' 은 sentinel (day-window 절이 Prisma.empty 로 무필터).
const ALLOWED_DAYS_NUMERIC: ReadonlySet<number> = new Set<number>([7, 30, 90]);

// 9-type canonical set — shared TASK_TYPES SoT (task-types.ts · rules/core-outcome-record.md 미러). The 4 non-code types (review/diagnosis/doc/cleanup) MUST be members or the defensive flatMap guard in handleSearch / handleDetail / handleCrossAnalysis silently drops those rows off the registered surface.
const ALLOWED_TASK_TYPES: ReadonlySet<OutcomeTaskType> = new Set<OutcomeTaskType>(TASK_TYPES);

const ALLOWED_RESULTS: ReadonlySet<OutcomeResultLiteral> = new Set<OutcomeResultLiteral>([
  "done",
  "done_with_concerns",
  "blocked",
  "needs_context",
  "fail",
]);

const ALLOWED_CONFIDENCES: ReadonlySet<OutcomeConfidenceLiteral> =
  new Set<OutcomeConfidenceLiteral>(["high", "medium", "low"]);

// Sort token allowlist: column + direction baked into a single literal so a
// substring match cannot synthesize a new token. Maps the validated token to
// the actual SQL fragment via getSortFragment().
const ALLOWED_SORTS: ReadonlySet<OutcomeSortToken> = new Set<OutcomeSortToken>([
  "record_ts:desc",
  "record_ts:asc",
  "revision_count:desc",
]);

// Pagination caps — defensive ceilings.
const SEARCH_LIMIT_MAX = 200;
const SEARCH_LIMIT_DEFAULT = 50;
const Q_MAX_LENGTH = 200; // Truncate longer queries silently per delegation spec.
const TOP_AGENTS_LIMIT = 10;
const LESSON_TRUNCATE_LENGTH = 200;
const CONCERNS_PREVIEW_LIMIT = 5;
const FILES_PREVIEW_LIMIT = 5;

// /heatmap: integer-range days param (1-90, default 30). Diverges from the
// {7|30|90} allowlist used by /search — the FE renders the DOW×Hour grid for
// arbitrary windows.
const HEATMAP_DAYS_MIN = 1;
const HEATMAP_DAYS_MAX = 90;
const HEATMAP_DAYS_DEFAULT = 30;
const HEATMAP_ROWS = 7; // DOW: 0=Sun … 6=Sat — bucket tz (PG EXTRACT(DOW AT TIME ZONE <config>)).
const HEATMAP_COLS = 24; // Hours: 0..23 — bucket tz (PG EXTRACT(HOUR AT TIME ZONE <config>)).
const ALLOWED_HEATMAP_RESULTS: ReadonlySet<OutcomeHeatmapResultFilter> = new Set<OutcomeHeatmapResultFilter>(
  ["all", "empty", "failed", "done"],
);

// /attribution-daily: discrete days allowlist {7,30,90} (membership gate, NOT
// the /heatmap 1-90 range gate). Reuses ALLOWED_DAYS_NUMERIC's {7,30,90}
// membership but excludes /search's 'all' sentinel — a daily-series card needs
// a bounded window. Out-of-set → 400. Blocks arbitrary INTERVAL injection.
const ATTRIBUTION_DAILY_DAYS_DEFAULT = 30;

// ±window (minutes) for matching a `subagent-stop-missing` outcome to a backing
// core.agent_events 'SubagentStop'. The outcome's record_ts (record write time)
// and the agent_event's event_ts (hook fire time) are co-located within seconds
// on a genuine lifecycle; 5 min is a generous bound that tolerates clock skew /
// hook lag without admitting unrelated Stops. Generous-but-bounded by design:
// false negatives (genuine loss missed) cost more than a handful of false
// positives, and genuine loss is ~0 anyway (the honest expected value).
const ATTRIBUTION_LOSS_AGENT_EVENT_WINDOW_MINUTES = 5;

// Attribution-source → semantic-category map. Folds all 8 CHECK-canonical
// values into 4 sum-complete categories. Any value NOT listed here (incl. a
// future canonical addition) falls through to 'synthesized' via the
// categorize() else-branch, so it can never silently drop from `total`.
const HEALTHY_SOURCE = "hook-input";
// Raw sentinel for SubagentStop-without-completion. NOT genuine attribution loss
// by itself — qualified at query time against a real core.agent_events backing
// (see handleAttributionDaily). Only the query-qualified subset reaches the
// 'attribution_loss' category; the unbacked majority is rewritten to
// ATTRIBUTION_LOSS_PHANTOM_SOURCE and folds to 'synthesized'.
const ATTRIBUTION_LOSS_SOURCE = "subagent-stop-missing";
// Query-only derived sentinel (never persisted): a `subagent-stop-missing` row
// with NO backing real SubagentStop agent_event = harness phantom / mislabeled
// main-session Stop noise, not real loss → mapped to 'synthesized'.
const ATTRIBUTION_LOSS_PHANTOM_SOURCE = "subagent-stop-phantom";
// Sentinel agent_type values that are NOT real subagents (synthetic fallback
// buckets). A SubagentStop agent_event carrying one of these does NOT evidence a
// genuine subagent lifecycle, so it must not qualify a `subagent-stop-missing`
// outcome as real loss. Mirrors improvement.ts TIER_BREAKDOWN_INFRA_AGENTS +
// agents.jsx SYNTHETIC_SENTINEL_AGENT_ID.
const SENTINEL_AGENT_TYPES: readonly string[] = [
  "subagent_stop_missing",
  "agent_id_missing",
  "unknown",
];
// budget-truncation: a subagent hard-killed at its tool_use budget ceiling before
// emitting [COMPLETION] — a named cause of a literally-truncated completion, so it
// buckets with truncated_completion here (NOT the 'synthesized' catch-all) to stay
// distinguishable + countable rather than folding into completion-synthesized noise.
// Single-SoT literal so the raw value stays byte-identical with track-outcome.sh.
const BUDGET_TRUNCATION_SOURCE = "budget-truncation";
const LITERAL_OMISSION_SOURCES: ReadonlySet<string> = new Set<string>([
  "truncated_completion",
  "completion-missing",
  BUDGET_TRUNCATION_SOURCE,
]);
// Raw literal_omission attribution_source → breakdown-field key. The set of keys
// here MUST equal LITERAL_OMISSION_SOURCES so the breakdown sub-counts sum to the
// literal_omission total. Raw literals use hyphens; DTO fields use underscores.
const LITERAL_OMISSION_BREAKDOWN_KEYS: ReadonlyMap<string, keyof LiteralOmissionBreakdown> =
  new Map<string, keyof LiteralOmissionBreakdown>([
    ["truncated_completion", "truncated_completion"],
    ["completion-missing", "completion_missing"],
    [BUDGET_TRUNCATION_SOURCE, "budget_truncation"],
  ]);
// completion-synthesized (recovery artifact) + conversation-only + cron-derived
// + agent-id-missing + subagent-stop-phantom (query-derived noise sentinel) are
// explicit synthesized members; the else-branch catch-all covers any future
// value identically.
const SYNTHESIZED_SOURCES: ReadonlySet<string> = new Set<string>([
  "completion-synthesized",
  "conversation-only",
  "cron-derived",
  "agent-id-missing",
  ATTRIBUTION_LOSS_PHANTOM_SOURCE,
]);

// DB row shapes

interface OutcomeSearchDbRow {
  id: bigint;
  record_ts: Date;
  agent: string;
  task_type: string;
  result: string;
  confidence: string | null;
  metric_pass: boolean | null;
  // ::text-cast enum columns — null for legacy un-graded rows.
  grader_verdict: string | null;
  downgrade_origin: string | null;
  revision_count: number;
  review_flag: boolean;
  summary: string;
  lesson: string | null;
  concerns: string[];
  files_modified: string[];
  cid: string | null;
  has_body_md: boolean;
  poisoned_window: boolean;
  // Raw attribution_source, selected verbatim (no ::text cast — column is text).
  attribution_source: string | null;
}

interface OutcomeDetailDbRow {
  id: bigint;
  record_ts: Date;
  agent: string;
  task_type: string;
  result: string;
  confidence: string | null;
  metric_pass: boolean | null;
  // ::text-cast enum columns — null for legacy un-graded rows.
  grader_verdict: string | null;
  downgrade_origin: string | null;
  metric_type: string | null;
  revision_count: number;
  evaluative_signal: number | null;
  directive_hint: string | null;
  lesson: string | null;
  concerns: string[];
  files_modified: string[];
  correlation_id: string | null;
  cid: string | null;
  summary: string;
  review_flag: boolean;
  body_md: string | null;
  inserted_at: Date;
}

interface CountRow {
  total: bigint;
}

interface CrossCellDbRow {
  confidence: string | null;
  metric_pass: boolean | null;
  count: bigint;
}

interface ByResultDbRow {
  result: string;
  count: bigint;
}

interface ByAgentDbRow {
  agent: string;
  count: bigint;
}

// One (grader_verdict-or-NULL, count) group for the artifact-vs-quality
// breakdown. NULL grader_verdict (legacy un-graded rows) arrives as a distinct
// group and is folded into `not_measured` — never into a fail bucket.
interface GraderVerdictDbRow {
  grader_verdict: string | null;
  count: bigint;
}

// One (task_type, grader_verdict-or-NULL, count) group for the 9-type ×
// grader_verdict crosstab. Same NULL semantics as GraderVerdictDbRow.
interface TaskTypeGraderDbRow {
  task_type: string;
  grader_verdict: string | null;
  count: bigint;
}

// /heatmap row shape: PG EXTRACT(DOW/HOUR ... AT TIME ZONE <configured bucket tz>)
// returns numeric (bucket-tz-localized) → cast to int in SQL.
interface HeatmapDbRow {
  dow: number;
  hour: number;
  cell_count: bigint;
}

// /attribution-daily row shape: one (day, attribution_source) group. `day` is
// emitted as 'YYYY-MM-DD' text via to_char(date_trunc(...)) so no client-side
// date math is needed. value-set-agnostic — the pivot happens in the handler.
interface AttributionDailyDbRow {
  day: string;
  attribution_source: string;
  cnt: bigint;
}

// query-string types

interface SearchQuerystring {
  days?: string;
  agent?: string;
  task_type?: string;
  result?: string;
  confidence?: string;
  metric_pass?: string;
  review_flag?: string;
  q?: string;
  limit?: string;
  offset?: string;
  sort?: string;
  // Exact-match filter on the raw attribution_source column (e.g.
  // attribution_source=budget-truncation). /search-only per contract.
  attribution_source?: string;
  // O2 forensic toggle — truthy lifts the default registry-membership gate on
  // /search so de-registered / sentinel / noise agents reappear (T7 / AC-2).
  include_all?: string;
}

interface CrossAnalysisQuerystring {
  days?: string;
  agent?: string;
  task_type?: string;
  result?: string;
  confidence?: string;
  metric_pass?: string;
  review_flag?: string;
  q?: string;
  // Mirrors /search's forensic show-all toggle (parseIncludeAll) — lifts the
  // registry-membership default so the cross-tab/by-result/grader distributions
  // (siblings of by_agent_top_10, which stays independently gated regardless of
  // this toggle) can be inspected un-scoped.
  include_all?: string;
}

// Parsed filter set shared by /search and /cross-analysis. metric_pass is a
// 3-state value: undefined = no filter, null = IS NULL filter, boolean = equality.
interface ParsedFilters {
  days: OutcomesWindowDays;
  agent: string | null;
  task_type: OutcomeTaskType | null;
  result: OutcomeResultLiteral | null;
  // Tri-state, mirroring metric_pass: a literal = equality filter, `null` =
  // explicit IS-NULL filter (confidence=null in the wire format), `undefined` =
  // no filter. buildWhereClause reads it idempotently — no side-channel state.
  confidence: OutcomeConfidenceLiteral | null | undefined;
  metric_pass: boolean | null | undefined;
  review_flag: boolean | null;
  q: string | null;
  // Exact-match filter on attribution_source; null = no filter. /search-only —
  // /cross-analysis never supplies the key, so it stays null there (behavior
  // unchanged for that endpoint).
  attribution_source: string | null;
}

// registration

export async function registerOutcomesRoutes(app: FastifyInstance): Promise<void> {
  // /cross-analysis and /heatmap registered BEFORE /:id so Fastify routes
  // them to the literal handlers, not the :id parameter handler. Route order
  // matters for parametric segments — same-prefix literals must come first.
  app.get("/api/outcomes/search", handleSearch);
  app.get("/api/outcomes/cross-analysis", handleCrossAnalysis);
  app.get("/api/outcomes/heatmap", handleHeatmap);
  app.get("/api/outcomes/attribution-daily", handleAttributionDaily);
  app.get("/api/outcomes/:id", handleDetail);
}

// GET /api/outcomes/search
async function handleSearch(
  request: FastifyRequest<{ Querystring: SearchQuerystring }>,
  reply: FastifyReply,
): Promise<OutcomeSearchResponse | OutcomesErrorBody> {
  const start = Date.now();

  const filtersResult = parseFilters(request.query);
  if (filtersResult.error !== null) {
    return reply.code(400).send(filtersResult.error);
  }
  const filters = filtersResult.filters;

  const limit = parseLimitParam(request.query.limit);
  if (limit === null) {
    return reply.code(400).send(invalidParam("limit"));
  }
  const offset = parseOffsetParam(request.query.offset);
  if (offset === null) {
    return reply.code(400).send(invalidParam("offset"));
  }
  const sort = parseSortParam(request.query.sort);
  if (sort === null) {
    return reply.code(400).send({
      error: "invalid_param",
      param: "sort",
      allowed: Array.from(ALLOWED_SORTS),
    } satisfies OutcomesErrorBody);
  }

  // T7 (O2) — default-scope /search to the canonical registry so de-registered /
  // sentinel / one-off-cid noise is hidden from the record-log; a truthy
  // include_all lifts the gate for the forensic all-records view (AC-2). Keys load
  // once and gate BOTH the rows and count queries (consistent total). On an empty
  // registry loadCanonicalAgentKeys() → [] → the predicate is skipped (fail-open).
  // The two cross-analysis callers pass NO scopeAgentKeys, so buildWhereClause
  // stays behavior-unchanged there — the by-agent dimension is gated at its own
  // call site (T6), never inside the shared builder.
  const includeAll = parseIncludeAll(request.query.include_all);
  const scopeAgentKeys = includeAll ? undefined : await loadCanonicalAgentKeys();
  const whereClause = buildWhereClause(filters, { scopeAgentKeys });
  const sortFragment = getSortFragment(sort);

  const prisma = getPrisma();
  try {
    // Two parallel queries: paginated rows + total count for pagination disclosure.
    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw<OutcomeSearchDbRow[]>`
        SELECT
          id,
          record_ts,
          agent,
          task_type::text                AS task_type,
          result::text                   AS result,
          confidence::text               AS confidence,
          metric_pass,
          grader_verdict::text           AS grader_verdict,
          downgrade_origin::text         AS downgrade_origin,
          revision_count,
          review_flag,
          summary,
          lesson,
          concerns,
          files_modified,
          cid,
          (body_md IS NOT NULL)          AS has_body_md,
          poisoned_window,
          attribution_source
        FROM core.outcomes
        ${whereClause}
        ${sortFragment}
        LIMIT ${limit}
        OFFSET ${offset}
      `,
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::bigint AS total
        FROM core.outcomes
        ${whereClause}
      `,
    ]);

    const totalRow = countRows[0];
    if (totalRow === undefined) {
      throw new Error("count query returned no row");
    }
    const total = bigintToNumber(totalRow.total);

    // Defensive: skip rows whose enum text drifted off the registered surface.
    // Should never happen given PG enum constraint, but a future migration could
    // add a value the FE doesn't know about.
    const mapped: OutcomeSearchRow[] = rows.flatMap((row) => {
      if (!ALLOWED_TASK_TYPES.has(row.task_type as OutcomeTaskType)) return [];
      if (!ALLOWED_RESULTS.has(row.result as OutcomeResultLiteral)) return [];
      const confidence = row.confidence;
      if (confidence !== null && !ALLOWED_CONFIDENCES.has(confidence as OutcomeConfidenceLiteral)) {
        return [];
      }
      return [
        {
          id: bigintToNumber(row.id),
          record_ts: row.record_ts.toISOString(),
          agent: row.agent,
          task_type: row.task_type as OutcomeTaskType,
          result: row.result as OutcomeResultLiteral,
          confidence: confidence === null ? null : (confidence as OutcomeConfidenceLiteral),
          metric_pass: row.metric_pass,
          grader_verdict: normalizeGraderVerdict(row.grader_verdict),
          downgrade_origin: normalizeDowngradeOrigin(row.downgrade_origin),
          revision_count: row.revision_count,
          review_flag: row.review_flag,
          summary: row.summary,
          lesson: truncateLesson(row.lesson),
          concerns: row.concerns.slice(0, CONCERNS_PREVIEW_LIMIT),
          files_modified: row.files_modified.slice(0, FILES_PREVIEW_LIMIT),
          cid: row.cid,
          has_body_md: row.has_body_md,
          poisoned_window: row.poisoned_window,
          attribution_source: row.attribution_source,
        },
      ];
    });

    const filterEcho = toSearchFilterEcho(filters, sort, limit, offset);

    request.log.info(
      {
        route: "/api/outcomes/search",
        days: filters.days,
        rowCount: mapped.length,
        total,
        durationMs: Date.now() - start,
      },
      "outcomes query complete",
    );
    return {
      filter: filterEcho,
      total,
      rows: mapped,
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/outcomes/search", error);
  }
}

// GET /api/outcomes/:id
async function handleDetail(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<OutcomeDetailResponse | OutcomesErrorBody> {
  const start = Date.now();
  const idNumeric = parseIdParam(request.params.id);
  if (idNumeric === null) {
    return reply.code(400).send(invalidParam("id"));
  }
  // BigInt because core.outcomes.id is bigint (the Prisma model column type);
  // ids above Number.MAX_SAFE_INTEGER are already rejected by parseIdParam.
  const idBigint = BigInt(idNumeric);

  const prisma = getPrisma();
  try {
    const rows = await prisma.$queryRaw<OutcomeDetailDbRow[]>`
      SELECT
        id,
        record_ts,
        agent,
        task_type::text       AS task_type,
        result::text          AS result,
        confidence::text      AS confidence,
        metric_pass,
        grader_verdict::text  AS grader_verdict,
        downgrade_origin::text AS downgrade_origin,
        metric_type,
        revision_count,
        evaluative_signal,
        directive_hint,
        lesson,
        concerns,
        files_modified,
        correlation_id,
        cid,
        summary,
        review_flag,
        body_md,
        inserted_at
      FROM core.outcomes
      WHERE id = ${idBigint}
      LIMIT 1
    `;

    const row = rows[0];
    if (row === undefined) {
      reply.code(404);
      return { error: "not_found", id: idNumeric };
    }

    // Drop rows with unrecognized enum text (defensive; see /search).
    if (
      !ALLOWED_TASK_TYPES.has(row.task_type as OutcomeTaskType) ||
      !ALLOWED_RESULTS.has(row.result as OutcomeResultLiteral) ||
      (row.confidence !== null &&
        !ALLOWED_CONFIDENCES.has(row.confidence as OutcomeConfidenceLiteral))
    ) {
      throw new Error(`outcome ${idNumeric} has unrecognized enum value`);
    }

    request.log.info(
      {
        route: "/api/outcomes/:id",
        id: idNumeric,
        durationMs: Date.now() - start,
      },
      "outcome detail query complete",
    );

    const confidence = row.confidence;
    return {
      id: bigintToNumber(row.id),
      record_ts: row.record_ts.toISOString(),
      agent: row.agent,
      task_type: row.task_type as OutcomeTaskType,
      result: row.result as OutcomeResultLiteral,
      confidence: confidence === null ? null : (confidence as OutcomeConfidenceLiteral),
      metric_pass: row.metric_pass,
      grader_verdict: normalizeGraderVerdict(row.grader_verdict),
      downgrade_origin: normalizeDowngradeOrigin(row.downgrade_origin),
      metric_type: row.metric_type,
      revision_count: row.revision_count,
      evaluative_signal: row.evaluative_signal,
      directive_hint: row.directive_hint,
      lesson: row.lesson,
      summary: row.summary,
      concerns: row.concerns,
      files_modified: row.files_modified,
      correlation_id: row.correlation_id,
      cid: row.cid,
      review_flag: row.review_flag,
      body_md: row.body_md,
      inserted_at: row.inserted_at.toISOString(),
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/outcomes/:id", error);
  }
}

// GET /api/outcomes/cross-analysis
async function handleCrossAnalysis(
  request: FastifyRequest<{ Querystring: CrossAnalysisQuerystring }>,
  reply: FastifyReply,
): Promise<OutcomeCrossAnalysisResponse | OutcomesErrorBody> {
  const start = Date.now();

  const filtersResult = parseFilters(request.query);
  if (filtersResult.error !== null) {
    return reply.code(400).send(filtersResult.error);
  }
  const filters = filtersResult.filters;
  // Registry-scoped by default (closes the by_result/cross-tab/grader gap — the
  // original 65/605 `done_with_concerns` cross-analysis miscount included
  // non-fleet agents like general-purpose/Explore); `include_all=1` lifts the
  // gate for a forensic all-population view, mirroring /search's `include_all`
  // (T7) convention. Applied to BOTH whereClause and analyticsWhere so their
  // delta (excluded_poisoned_count) isolates ONLY the poisoned-window exclusion,
  // never a mix of poisoned + registry exclusion.
  const includeAll = parseIncludeAll(request.query.include_all);
  const canonicalKeys = await loadCanonicalAgentKeys();
  const scopeAgentKeys = includeAll ? undefined : canonicalKeys;
  const whereClause = buildWhereClause(filters, { scopeAgentKeys });
  // Aggregates run on the poisoned-excluded population; the base-count query
  // (whereClause) only sizes the exclusion for the on-screen disclosure chip.
  const analyticsWhere = buildWhereClause(filters, { excludePoisoned: true, scopeAgentKeys });

  // T6 — by-agent-ONLY registry gate, UNCONDITIONAL (independent of the
  // include_all toggle above — by_agent_top_10 stays registry-scoped even under
  // a forensic all-population request). Scopes the by_agent_top_10 dimension
  // (AgentStackedBar + KPI sparkline) to the canonical registry so orchestrator /
  // cron / sentinel / one-off-cid noise cannot occupy a ranking slot. Applied at
  // THIS call site (appended to the byAgentRows query below) — redundant-but-
  // harmless when analyticsWhere already carries scopeAgentKeys, and the ONLY
  // gate on by_agent_top_10 when include_all lifts analyticsWhere's scope.
  // analyticsWhere always emits a complete WHERE (excludePoisoned pushes
  // poisoned_window = FALSE), so the AND-prefixed helper is the correct
  // connector; Prisma.empty on an empty registry → the tail renders as no-op
  // (fail-open).
  const byAgentMembership = buildAgentMembershipFilter(canonicalKeys);

  const prisma = getPrisma();
  try {
    // Parallel queries over the same filtered set: cross-tab cells + per-result
    // counts + per-agent top-N + grader_verdict distribution + total count. The
    // PostgreSQL planner reuses buffer cache across them since the predicate set
    // is identical.
    const [
      cellRows,
      byResultRows,
      byAgentRows,
      graderRows,
      taskTypeGraderRows,
      countRows,
      baseCountRows,
    ] =
      await Promise.all([
        prisma.$queryRaw<CrossCellDbRow[]>`
          SELECT
            confidence::text AS confidence,
            metric_pass,
            COUNT(*)::bigint AS count
          FROM core.outcomes
          ${analyticsWhere}
          GROUP BY confidence, metric_pass
        `,
        prisma.$queryRaw<ByResultDbRow[]>`
          SELECT
            result::text     AS result,
            COUNT(*)::bigint AS count
          FROM core.outcomes
          ${analyticsWhere}
          GROUP BY result
          ORDER BY count DESC, result ASC
        `,
        prisma.$queryRaw<ByAgentDbRow[]>`
          SELECT
            agent,
            COUNT(*)::bigint AS count
          FROM core.outcomes
          ${analyticsWhere}
          ${byAgentMembership}
          GROUP BY agent
          ORDER BY count DESC, agent ASC
          LIMIT ${TOP_AGENTS_LIMIT}
        `,
        // Artifact-vs-quality: count per grader_verdict bucket. NULL (legacy
        // un-graded) arrives as its own group and is folded into `not_measured`
        // by the pivot below — NEVER into a fail bucket, and NEVER in the ratio
        // denominator.
        prisma.$queryRaw<GraderVerdictDbRow[]>`
          SELECT
            grader_verdict::text AS grader_verdict,
            COUNT(*)::bigint     AS count
          FROM core.outcomes
          ${analyticsWhere}
          GROUP BY grader_verdict
        `,
        // 9-type × grader_verdict crosstab ('측정 분포' 9-type render support).
        prisma.$queryRaw<TaskTypeGraderDbRow[]>`
          SELECT
            task_type::text      AS task_type,
            grader_verdict::text AS grader_verdict,
            COUNT(*)::bigint     AS count
          FROM core.outcomes
          ${analyticsWhere}
          GROUP BY task_type, grader_verdict
        `,
        prisma.$queryRaw<CountRow[]>`
          SELECT COUNT(*)::bigint AS total
          FROM core.outcomes
          ${analyticsWhere}
        `,
        prisma.$queryRaw<CountRow[]>`
          SELECT COUNT(*)::bigint AS total
          FROM core.outcomes
          ${whereClause}
        `,
      ]);

    const totalRow = countRows[0];
    const baseTotalRow = baseCountRows[0];
    if (totalRow === undefined || baseTotalRow === undefined) {
      throw new Error("count query returned no row");
    }
    const total = bigintToNumber(totalRow.total);
    const excludedPoisonedCount = bigintToNumber(baseTotalRow.total) - total;

    const graderBreakdown = buildGraderBreakdown(graderRows);
    const taskTypeGraderBreakdown = buildTaskTypeGraderBreakdown(taskTypeGraderRows);

    // Build the 12-cell grid: 4 confidence values (high/medium/low/null) ×
    // 3 metric_pass values (true/false/null). Lookup observed counts; missing
    // combinations get count=0 per the API contract.
    const observed = new Map<string, number>();
    for (const row of cellRows) {
      observed.set(cellKey(row.confidence, row.metric_pass), bigintToNumber(row.count));
    }
    const cells: OutcomeCrossAnalysisCell[] = [];
    const confidenceValues: ReadonlyArray<OutcomeConfidenceLiteral | null> = [
      "high",
      "medium",
      "low",
      null,
    ];
    const metricPassValues: ReadonlyArray<boolean | null> = [true, false, null];
    for (const conf of confidenceValues) {
      for (const mp of metricPassValues) {
        cells.push({
          confidence: conf,
          metric_pass: mp,
          count: observed.get(cellKey(conf, mp)) ?? 0,
          // Polar mismatch per outcome-record.md:
          //   high + metric_pass=false  → overconfidence
          //   low  + metric_pass=true   → underconfidence
          is_polar_mismatch: (conf === "high" && mp === false) || (conf === "low" && mp === true),
        });
      }
    }

    // Defensive enum filter — drop rows with unrecognized result/agent values.
    const byResult: OutcomeCrossAnalysisByResult[] = byResultRows.flatMap((row) => {
      if (!ALLOWED_RESULTS.has(row.result as OutcomeResultLiteral)) return [];
      return [{ result: row.result as OutcomeResultLiteral, count: bigintToNumber(row.count) }];
    });
    const byAgentTop10: OutcomeCrossAnalysisByAgent[] = byAgentRows.map((row) => ({
      agent: row.agent,
      count: bigintToNumber(row.count),
    }));

    const filterEcho = toCrossAnalysisFilterEcho(filters);

    request.log.info(
      {
        route: "/api/outcomes/cross-analysis",
        days: filters.days,
        total,
        cellCount: cells.length,
        agentCount: byAgentTop10.length,
        gradedTotal: graderBreakdown.graded_total,
        notMeasured: graderBreakdown.not_measured,
        durationMs: Date.now() - start,
      },
      "outcomes query complete",
    );
    return {
      filter: filterEcho,
      total,
      excluded_poisoned_count: excludedPoisonedCount,
      cells,
      by_result: byResult,
      by_agent_top_10: byAgentTop10,
      grader_breakdown: graderBreakdown,
      task_type_grader_breakdown: taskTypeGraderBreakdown,
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/outcomes/cross-analysis", error);
  }
}

// GET /api/outcomes/heatmap?days={1-90}&result={all|empty|failed|done} — DOW × Hour 7×24 grid.
async function handleHeatmap(
  request: FastifyRequest<{ Querystring: { days?: string; result?: string } }>,
  reply: FastifyReply,
): Promise<OutcomeHeatmapResponse | OutcomesErrorBody> {
  const start = Date.now();

  const days = parseHeatmapDaysParam(request.query.days);
  if (days === null) {
    return reply.code(400).send({
      error: "invalid_param",
      param: "days",
      allowed: [`${HEATMAP_DAYS_MIN}-${HEATMAP_DAYS_MAX}`],
    } satisfies OutcomesErrorBody);
  }

  const resultFilter = parseHeatmapResultParam(request.query.result);
  if (resultFilter === null) {
    return reply.code(400).send({
      error: "invalid_param",
      param: "result",
      allowed: Array.from(ALLOWED_HEATMAP_RESULTS),
    } satisfies OutcomesErrorBody);
  }

  // Build the result-filter clause. `all` → no extra predicate; the day-window
  // clause below carries the only WHERE term in that case.
  const resultClause = buildHeatmapResultClause(resultFilter);
  // Registry-membership scope — no `agent` querystring param exists on this
  // endpoint, so ad-hoc/non-fleet agents would otherwise pollute the DOW×Hour
  // activity grid. AND-prefixed helper appended after the day-window WHERE.
  const agentMembership = buildAgentMembershipFilter(await loadCanonicalAgentKeys());
  // Day-window literal — `days` came through the integer-range gate, no user
  // string reaches SQL.
  const intervalLiteral = Prisma.raw(`INTERVAL '${days} days'`);

  const prisma = getPrisma();
  try {
    // `record_ts AT TIME ZONE <bucket tz>` converts the UTC timestamptz to the
    // configured day-bucket timezone before EXTRACT → DOW/HOUR are that tz's
    // day-of-week / hour-of-day, matching the FE's Sun~Sat / 0-23 labels. The
    // day-WINDOW clause below stays UTC-anchored (CURRENT_DATE) — only the
    // time-of-day bucket is tz-localized. The tz flows in as a bind parameter
    // (config-sourced, never user input). GROUP BY uses ordinals because each
    // `${}` placeholder is a distinct $n — repeating the EXTRACT expression
    // would no longer match the SELECT expression tree.
    const rows = await prisma.$queryRaw<HeatmapDbRow[]>`
      SELECT
        EXTRACT(DOW  FROM record_ts AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::int AS dow,
        EXTRACT(HOUR FROM record_ts AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::int AS hour,
        COUNT(*)::bigint                                                            AS cell_count
      FROM core.outcomes
      WHERE record_ts >= CURRENT_DATE - ${intervalLiteral}
        AND poisoned_window = FALSE
        ${resultClause}
        ${agentMembership}
      GROUP BY 1, 2
    `;

    // Pre-allocate the 7×24 zero grid; only observed (dow, hour) cells overwrite.
    // Spec: row 0 = Sunday … row 6 = Saturday — bucket-tz day-of-week
    // (PG EXTRACT(DOW AT TIME ZONE <config>) range 0-6).
    const data: number[][] = Array.from({ length: HEATMAP_ROWS }, () =>
      new Array<number>(HEATMAP_COLS).fill(0),
    );
    let totalCount = 0;
    for (const row of rows) {
      // Defensive bounds — EXTRACT(DOW AT TIME ZONE <config>) is 0-6 and
      // EXTRACT(HOUR ...) is 0-23 (timezone conversion shifts the bucket but not
      // the range). Drop out-of-range cells rather than crash on
      // `data[row][col]` undefined.
      if (row.dow < 0 || row.dow >= HEATMAP_ROWS) continue;
      if (row.hour < 0 || row.hour >= HEATMAP_COLS) continue;
      const count = bigintToNumber(row.cell_count);
      // Guarded above — index is in-range.
      const grid = data[row.dow];
      if (grid !== undefined) {
        grid[row.hour] = count;
      }
      totalCount += count;
    }

    // Period bounds: report the [start, end) window in date-only form so the FE
    // can label the heatmap. UTC midnight floor (matches existing formatDateOnly
    // semantics across this file).
    const now = new Date();
    const periodEnd = formatDateOnly(now);
    const periodStartMs = now.getTime() - days * 86_400_000;
    const periodStart = formatDateOnly(new Date(periodStartMs));

    request.log.info(
      {
        route: "/api/outcomes/heatmap",
        days,
        resultFilter,
        totalCount,
        durationMs: Date.now() - start,
      },
      "outcomes query complete",
    );
    return {
      data,
      meta: {
        days,
        result: resultFilter,
        total_count: totalCount,
        period_start: periodStart,
        period_end: periodEnd,
        timezone: DAY_BUCKET_TIMEZONE,
      },
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/outcomes/heatmap", error);
  }
}

function parseHeatmapDaysParam(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") {
    return HEATMAP_DAYS_DEFAULT;
  }
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < HEATMAP_DAYS_MIN ||
    parsed > HEATMAP_DAYS_MAX
  ) {
    return null;
  }
  return parsed;
}

function parseHeatmapResultParam(raw: string | undefined): OutcomeHeatmapResultFilter | null {
  if (raw === undefined || raw === "") {
    return "all";
  }
  if (!ALLOWED_HEATMAP_RESULTS.has(raw as OutcomeHeatmapResultFilter)) {
    return null;
  }
  return raw as OutcomeHeatmapResultFilter;
}

function buildHeatmapResultClause(filter: OutcomeHeatmapResultFilter): Prisma.Sql {
  // Each branch hard-codes the validated literal — no user input reaches SQL.
  // Returns Prisma.empty when no extra filter is needed; embedded into the
  // outer template literal where AND-prefix is conditional.
  switch (filter) {
    case "all":
      return Prisma.empty;
    case "empty":
      // Empty-signal cohort: writer-side metric_pass omitted.
      return Prisma.sql`AND metric_pass IS NULL`;
    case "failed":
      // Mirrors agents.ts failure_count semantics — needs_context excluded
      // (it's a user-fault context-shortage signal, not an agent breakage).
      return Prisma.sql`AND result::text IN ('blocked', 'fail')`;
    case "done":
      // Mirrors agents.ts success_count semantics.
      return Prisma.sql`AND result::text IN ('done', 'done_with_concerns')`;
  }
}

// GET /api/outcomes/attribution-daily?days={7|30|90, default 30} — daily
// attribution-health series. Honest 4-category decomposition of
// attribution_source (healthy / attribution_loss / literal_omission /
// synthesized) over a bounded window. NULL attribution_source excluded.
async function handleAttributionDaily(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<AttributionDailyResponse | OutcomesErrorBody> {
  const start = Date.now();

  const days = parseAttributionDailyDaysParam(request.query.days);
  if (days === null) {
    return reply.code(400).send({
      error: "invalid_param",
      param: "days",
      allowed: Array.from(ALLOWED_DAYS_NUMERIC),
    } satisfies OutcomesErrorBody);
  }

  const prisma = getPrisma();
  try {
    // Host-default-timezone unification — KEEP-AS-IS, surfaced not changed:
    // this daily-trend series buckets days with `date_trunc('day', o.record_ts)`,
    // a 2-arg date_trunc that operates in the PG SESSION timezone — pinned to UTC
    // in db.ts (POOL_STARTUP_OPTIONS + assertSessionTimezoneIsUtc) — so the trend
    // buckets in UTC. The SAME screen's heatmap (handleHeatmap above) buckets via
    // EXTRACT(DOW/HOUR FROM record_ts AT TIME ZONE ${DAY_BUCKET_TIMEZONE}), which
    // follows the RESOLVED day-bucket tz. On a non-Seoul deploy these two diverge
    // (UTC trend vs resolved-tz heatmap) — an INTENTIONAL, documented
    // inconsistency, out of scope for the timezone-unification change. Unifying the
    // trend onto AT TIME ZONE is a separate future decision, not a bug to fix here.
    //
    // Value-set-agnostic aggregate: COUNT(*) per (day, effective_source).
    // WHERE attribution_source IS NOT NULL excludes legacy NULL rows from every
    // total/ratio. record_ts predicate uses outcomes_ts_idx; the
    // attribution_source seq-scan is sub-1ms at current scale (partial index
    // deferred to a >50K-row future migration). `days` is parameter-bound (clean int).
    //
    // Registry-membership scope on the OUTER query only — appended to
    // `o.attribution_source`'s WHERE below. Deliberately NOT applied inside the
    // internal EXISTS sub-select (the ae.agent_type sentinel check a few lines
    // down): that check is a genuine-vs-phantom-loss VALIDATION query, not an
    // agent-dimensioned display field, so it is out of scope for this gate.
    const agentMembership = buildAgentMembershipFilter(
      await loadCanonicalAgentKeys(),
      Prisma.sql`o.agent`,
    );
    // The raw `subagent-stop-missing` sentinel is NOT genuine loss — its
    // population is mostly harness phantom + mislabeled main-session Stops, with
    // near-zero real subagent failures. A GENUINE attribution loss requires a
    // real subagent to have actually terminated — i.e. a core.agent_events
    // 'SubagentStop' row with a real, non-sentinel agent_type — for which no real
    // outcome was recorded. So a `subagent-stop-missing` row is kept as genuine
    // loss ONLY when a backing SubagentStop agent_event exists within
    // ±${ATTRIBUTION_LOSS_AGENT_EVENT_WINDOW_MINUTES} min of record_ts; otherwise
    // it is rewritten to the `subagent-stop-phantom` sentinel and folds into
    // 'synthesized' (the noise catch-all). The EXISTS sub-select uses
    // agent_events_type_ts_idx (agent_type, event_ts). All other sources pass
    // through unchanged. Honest series is expected to flat-line near 0 — correct.
    const rows = await prisma.$queryRaw<AttributionDailyDbRow[]>`
      SELECT
        to_char(date_trunc('day', o.record_ts), 'YYYY-MM-DD') AS day,
        CASE
          WHEN o.attribution_source = ${ATTRIBUTION_LOSS_SOURCE}
               AND NOT EXISTS (
                 SELECT 1
                 FROM core.agent_events ae
                 WHERE ae.event_name = 'SubagentStop'
                   AND ae.agent_type IS NOT NULL
                   AND ae.agent_type NOT IN (${Prisma.join(SENTINEL_AGENT_TYPES)})
                   AND ae.event_ts BETWEEN
                         o.record_ts - (${ATTRIBUTION_LOSS_AGENT_EVENT_WINDOW_MINUTES}::int * INTERVAL '1 minute')
                     AND o.record_ts + (${ATTRIBUTION_LOSS_AGENT_EVENT_WINDOW_MINUTES}::int * INTERVAL '1 minute')
               )
          THEN ${ATTRIBUTION_LOSS_PHANTOM_SOURCE}
          ELSE o.attribution_source
        END                                                   AS attribution_source,
        COUNT(*)::bigint                                      AS cnt
      FROM core.outcomes o
      WHERE o.attribution_source IS NOT NULL
        AND o.record_ts > NOW() - (${days}::int * INTERVAL '1 day')
        ${agentMembership}
      GROUP BY date_trunc('day', o.record_ts), 2
      ORDER BY date_trunc('day', o.record_ts) ASC
    `;

    const { series, totals, breakdown } = pivotAttributionDaily(rows);

    // budget-truncation rows grouped by agent over the SAME window + membership
    // scope as the main series, so the by-agent counts reconcile with the
    // breakdown.budget_truncation sub-count. count DESC, agent ASC tiebreak.
    const byAgentRows = await prisma.$queryRaw<ByAgentDbRow[]>`
      SELECT o.agent AS agent, COUNT(*)::bigint AS count
      FROM core.outcomes o
      WHERE o.attribution_source = ${BUDGET_TRUNCATION_SOURCE}
        AND o.record_ts > NOW() - (${days}::int * INTERVAL '1 day')
        ${agentMembership}
      GROUP BY o.agent
      ORDER BY COUNT(*) DESC, o.agent ASC
    `;
    const budgetTruncationByAgent: BudgetTruncationAgentCount[] = byAgentRows.map((r) => ({
      agent: r.agent,
      count: bigintToNumber(r.count),
    }));

    const totalAttributed =
      totals.healthy + totals.attribution_loss + totals.literal_omission + totals.synthesized;

    request.log.info(
      {
        route: "/api/outcomes/attribution-daily",
        days,
        activeDays: series.length,
        totalAttributed,
        durationMs: Date.now() - start,
      },
      "outcomes query complete",
    );

    return {
      fetched_at: new Date().toISOString(),
      days,
      days_series: series,
      window_summary: {
        healthy_rate: ratioOrNull(totals.healthy, totalAttributed),
        attribution_loss_rate: ratioOrNull(totals.attribution_loss, totalAttributed),
        literal_omission_rate: ratioOrNull(totals.literal_omission, totalAttributed),
        synthesized_rate: ratioOrNull(totals.synthesized, totalAttributed),
        total_attributed: totalAttributed,
        literal_omission_breakdown: breakdown,
        budget_truncation_by_agent: budgetTruncationByAgent,
      },
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/outcomes/attribution-daily", error);
  }
}

function parseAttributionDailyDaysParam(raw: string | undefined): AttributionDailyWindowDays | null {
  if (raw === undefined || raw === "") {
    return ATTRIBUTION_DAILY_DAYS_DEFAULT as AttributionDailyWindowDays;
  }
  if (!/^-?\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  // Discrete membership gate {7,30,90} — NOT the /heatmap 1-90 range gate.
  if (!Number.isInteger(parsed) || !ALLOWED_DAYS_NUMERIC.has(parsed)) {
    return null;
  }
  return parsed as AttributionDailyWindowDays;
}

// Per-category running totals over the window.
interface AttributionCategoryTotals {
  healthy: number;
  attribution_loss: number;
  literal_omission: number;
  synthesized: number;
}

// Pivot (day, attribution_source) DB rows into the per-day category series +
// window totals. Sum-complete by construction: every source maps to exactly one
// of the 4 categories (unknown → synthesized), so the per-day `total` always
// equals healthy+attribution_loss+literal_omission+synthesized.
//
// Exported for the literal_omission_breakdown unit test — the budget-truncation
// split cannot be route-seeded (outcomes_attribution_source_check rejects the
// value on INSERT), so its breakdown increment is verified at the pure-fn level.
export function pivotAttributionDaily(rows: AttributionDailyDbRow[]): {
  series: AttributionDailyPoint[];
  totals: AttributionCategoryTotals;
  breakdown: LiteralOmissionBreakdown;
} {
  // Map keyed by day → accumulating point. Insertion order preserves the ASC
  // day ordering from the SQL ORDER BY (Map iterates in insertion order).
  const byDay = new Map<string, AttributionDailyPoint>();
  const totals: AttributionCategoryTotals = {
    healthy: 0,
    attribution_loss: 0,
    literal_omission: 0,
    synthesized: 0,
  };
  // Sub-counts of the literal_omission total, keyed off the RAW literal (not
  // categorizeAttributionSource) so they sum exactly to totals.literal_omission.
  const breakdown: LiteralOmissionBreakdown = {
    truncated_completion: 0,
    completion_missing: 0,
    budget_truncation: 0,
  };

  for (const row of rows) {
    const count = bigintToNumber(row.cnt);
    const category = categorizeAttributionSource(row.attribution_source);

    let point = byDay.get(row.day);
    if (point === undefined) {
      point = {
        day: row.day,
        healthy: 0,
        attribution_loss: 0,
        literal_omission: 0,
        synthesized: 0,
        total: 0,
      };
      byDay.set(row.day, point);
    }
    point[category] += count;
    point.total += count;
    totals[category] += count;

    // Raw-literal split of literal_omission. The breakdown key map shares its
    // key set with LITERAL_OMISSION_SOURCES, so every row that lands in the
    // literal_omission category increments exactly one breakdown field.
    const breakdownKey = LITERAL_OMISSION_BREAKDOWN_KEYS.get(row.attribution_source);
    if (breakdownKey !== undefined) {
      breakdown[breakdownKey] += count;
    }
  }

  return { series: Array.from(byDay.values()), totals, breakdown };
}

// Map an attribution_source value to its semantic category. The else-branch
// folds any unlisted value (incl. future canonical additions) into 'synthesized'
// so no value can silently drop from the sum-complete total.
//
// `source` here is the QUERY-EFFECTIVE source, not the raw persisted column: the
// handleAttributionDaily SQL has already rewritten unbacked `subagent-stop-missing`
// rows to ATTRIBUTION_LOSS_PHANTOM_SOURCE. So a value reaching this fn equal to
// ATTRIBUTION_LOSS_SOURCE is the genuine-loss subset (real agent_events backing);
// the phantom/mislabeled majority arrives as ATTRIBUTION_LOSS_PHANTOM_SOURCE and
// is classified 'synthesized' via SYNTHESIZED_SOURCES.
export function categorizeAttributionSource(
  source: string,
): keyof AttributionCategoryTotals {
  if (source === HEALTHY_SOURCE) return "healthy";
  if (source === ATTRIBUTION_LOSS_SOURCE) return "attribution_loss";
  if (LITERAL_OMISSION_SOURCES.has(source)) return "literal_omission";
  // SYNTHESIZED_SOURCES explicit members OR else→catch-all (any future canonical
  // value) — both fold to 'synthesized'. The membership check is a no-op for
  // correctness but pins the documented intent so an audit can tell an explicit
  // synthesized source from an unrecognized fall-through.
  if (SYNTHESIZED_SOURCES.has(source)) return "synthesized";
  return "synthesized";
}

// Fraction of total, or null when the denominator is 0 (no attributed rows in
// window → a rate is undefined, not 0). 6-dp rounding avoids float noise.
function ratioOrNull(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

// grader_verdict normalization + artifact-vs-quality breakdown

const ALLOWED_GRADER_VERDICTS: ReadonlySet<OutcomeGraderVerdict> =
  new Set<OutcomeGraderVerdict>(["verified_pass", "unverified", "verified_fail"]);

const ALLOWED_DOWNGRADE_ORIGINS: ReadonlySet<OutcomeDowngradeOrigin> =
  new Set<OutcomeDowngradeOrigin>(["writer_true_downgraded", "writer_false", "synthesized"]);

// Coerce a ::text-cast enum value to the narrow literal, mapping NULL and any
// unrecognized value to null (advisory field — a drifted value degrades to "not
// graded" rather than dropping the whole row, unlike the task_type guard).
function normalizeGraderVerdict(value: string | null): OutcomeGraderVerdict | null {
  if (value === null) return null;
  return ALLOWED_GRADER_VERDICTS.has(value as OutcomeGraderVerdict)
    ? (value as OutcomeGraderVerdict)
    : null;
}

function normalizeDowngradeOrigin(value: string | null): OutcomeDowngradeOrigin | null {
  if (value === null) return null;
  return ALLOWED_DOWNGRADE_ORIGINS.has(value as OutcomeDowngradeOrigin)
    ? (value as OutcomeDowngradeOrigin)
    : null;
}

// Pivot the (grader_verdict, count) groups into the artifact-vs-quality
// breakdown. Invariant: legacy un-graded rows (NULL grader_verdict, and any
// unrecognized drifted value) accumulate into `not_measured` ONLY — they are
// excluded from `graded_total` and therefore from every ratio denominator, so
// the ~2424 legacy rows cannot contaminate the pass/fail ratios. Rates are null
// when graded_total is 0 (a rate over zero graded rows is undefined, not 0).
function buildGraderBreakdown(rows: GraderVerdictDbRow[]): OutcomeGraderBreakdown {
  let verifiedPass = 0;
  let unverified = 0;
  let verifiedFail = 0;
  let notMeasured = 0;

  for (const row of rows) {
    const count = bigintToNumber(row.count);
    const verdict = normalizeGraderVerdict(row.grader_verdict);
    switch (verdict) {
      case "verified_pass":
        verifiedPass += count;
        break;
      case "unverified":
        unverified += count;
        break;
      case "verified_fail":
        verifiedFail += count;
        break;
      case null:
        // NULL or drifted → not measured; never folded into a fail bucket.
        notMeasured += count;
        break;
    }
  }

  const gradedTotal = verifiedPass + unverified + verifiedFail;
  return {
    verified_pass: verifiedPass,
    unverified,
    verified_fail: verifiedFail,
    not_measured: notMeasured,
    graded_total: gradedTotal,
    verified_pass_rate: ratioOrNull(verifiedPass, gradedTotal),
    unverified_rate: ratioOrNull(unverified, gradedTotal),
    verified_fail_rate: ratioOrNull(verifiedFail, gradedTotal),
  };
}

// The 4 non-code task_types whose grader explicitly skips to `unverified` (no
// test artifact expected — SoT: rules/core-outcome-record.md grader_verdict).
// Server-emitted flag so the FE never hardcodes the set.
const BY_DESIGN_UNVERIFIED_TASK_TYPES: ReadonlySet<OutcomeTaskType> = new Set<OutcomeTaskType>([
  "review",
  "diagnosis",
  "doc",
  "cleanup",
]);

// Pivot the (task_type, grader_verdict, count) groups into the fixed 9-row
// crosstab (TASK_TYPES order; absent types stay zero-filled). NULL/drifted
// verdicts accumulate into `not_measured` (buildGraderBreakdown contract);
// rows with a drifted task_type are dropped (mirrors the search guard).
function buildTaskTypeGraderBreakdown(rows: TaskTypeGraderDbRow[]): OutcomeTaskTypeGraderRow[] {
  const out: OutcomeTaskTypeGraderRow[] = TASK_TYPES.map((taskType) => ({
    task_type: taskType,
    verified_pass: 0,
    unverified: 0,
    verified_fail: 0,
    not_measured: 0,
    total: 0,
    by_design_unverified: BY_DESIGN_UNVERIFIED_TASK_TYPES.has(taskType),
  }));
  const byType = new Map<string, OutcomeTaskTypeGraderRow>(out.map((row) => [row.task_type, row]));

  for (const row of rows) {
    const entry = byType.get(row.task_type);
    if (entry === undefined) continue;
    const count = bigintToNumber(row.count);
    switch (normalizeGraderVerdict(row.grader_verdict)) {
      case "verified_pass":
        entry.verified_pass += count;
        break;
      case "unverified":
        entry.unverified += count;
        break;
      case "verified_fail":
        entry.verified_fail += count;
        break;
      case null:
        entry.not_measured += count;
        break;
    }
    entry.total += count;
  }
  return out;
}

interface FiltersParseResult {
  filters: ParsedFilters;
  error: OutcomesErrorBody | null;
}

function parseFilters(query: SearchQuerystring | CrossAnalysisQuerystring): FiltersParseResult {
  const days = parseDaysParam(query.days);
  if (days === null) {
    return {
      filters: emptyFilters(),
      error: {
        error: "invalid_param",
        param: "days",
        allowed: [7, 30, 90, "all"],
      },
    };
  }

  const agentRaw = query.agent;
  const agent = typeof agentRaw === "string" && agentRaw.length > 0 ? agentRaw : null;

  const taskTypeRaw = query.task_type;
  let taskType: OutcomeTaskType | null = null;
  if (taskTypeRaw !== undefined && taskTypeRaw !== "") {
    if (!ALLOWED_TASK_TYPES.has(taskTypeRaw as OutcomeTaskType)) {
      return {
        filters: emptyFilters(),
        error: {
          error: "invalid_param",
          param: "task_type",
          allowed: Array.from(ALLOWED_TASK_TYPES),
        },
      };
    }
    taskType = taskTypeRaw as OutcomeTaskType;
  }

  const resultRaw = query.result;
  let resultLit: OutcomeResultLiteral | null = null;
  if (resultRaw !== undefined && resultRaw !== "") {
    if (!ALLOWED_RESULTS.has(resultRaw as OutcomeResultLiteral)) {
      return {
        filters: emptyFilters(),
        error: {
          error: "invalid_param",
          param: "result",
          allowed: Array.from(ALLOWED_RESULTS),
        },
      };
    }
    resultLit = resultRaw as OutcomeResultLiteral;
  }

  // confidence is 3-state in the wire format ('high'|'medium'|'low' / 'null' /
  // absent) and tri-state internally: literal = equality, null = IS-NULL
  // filter, undefined = no filter (same encoding as metric_pass).
  const confidenceRaw = query.confidence;
  let confidence: OutcomeConfidenceLiteral | null | undefined = undefined;
  if (confidenceRaw !== undefined && confidenceRaw !== "") {
    if (confidenceRaw === "null") {
      confidence = null;
    } else if (!ALLOWED_CONFIDENCES.has(confidenceRaw as OutcomeConfidenceLiteral)) {
      return {
        filters: emptyFilters(),
        error: {
          error: "invalid_param",
          param: "confidence",
          allowed: [...Array.from(ALLOWED_CONFIDENCES), "null"],
        },
      };
    } else {
      confidence = confidenceRaw as OutcomeConfidenceLiteral;
    }
  }

  // metric_pass is 3-state in the wire format ('true' / 'false' / 'null') and
  // 4-state internally (boolean | null IS-NULL filter | undefined no-filter).
  // Encode IS-NULL as `null` and absent-filter as `undefined`. The filter echo
  // surfaces 'unset' for the absent case so the FE can disambiguate.
  const metricPassRaw = query.metric_pass;
  let metricPass: boolean | null | undefined = undefined;
  if (metricPassRaw !== undefined && metricPassRaw !== "") {
    if (metricPassRaw === "true") metricPass = true;
    else if (metricPassRaw === "false") metricPass = false;
    else if (metricPassRaw === "null") metricPass = null;
    else {
      return {
        filters: emptyFilters(),
        error: {
          error: "invalid_param",
          param: "metric_pass",
          allowed: ["true", "false", "null"],
        },
      };
    }
  }

  const reviewFlagRaw = query.review_flag;
  let reviewFlag: boolean | null = null;
  if (reviewFlagRaw !== undefined && reviewFlagRaw !== "") {
    if (reviewFlagRaw === "true") reviewFlag = true;
    else if (reviewFlagRaw === "false") reviewFlag = false;
    else {
      return {
        filters: emptyFilters(),
        error: {
          error: "invalid_param",
          param: "review_flag",
          allowed: ["true", "false"],
        },
      };
    }
  }

  // q is unbounded user text — truncate to Q_MAX_LENGTH chars per delegation.
  const qRaw = query.q;
  const q =
    typeof qRaw === "string" && qRaw.length > 0 ? qRaw.slice(0, Q_MAX_LENGTH) : null;

  // attribution_source: exact-match equality filter, /search-only. The `in`
  // guard keeps /cross-analysis (whose querystring lacks the key) at null, so
  // that endpoint's WHERE is unchanged. Bound as a parameter in buildWhereClause.
  const attributionSourceRaw =
    "attribution_source" in query ? query.attribution_source : undefined;
  const attributionSource =
    typeof attributionSourceRaw === "string" && attributionSourceRaw.length > 0
      ? attributionSourceRaw
      : null;

  const filters: ParsedFilters = {
    days,
    agent,
    task_type: taskType,
    result: resultLit,
    confidence,
    metric_pass: metricPass,
    review_flag: reviewFlag,
    q,
    attribution_source: attributionSource,
  };

  return { filters, error: null };
}

function buildWhereClause(
  filters: ParsedFilters,
  options?: { excludePoisoned?: boolean; scopeAgentKeys?: string[] },
): Prisma.Sql {
  const fragments: Prisma.Sql[] = [];

  // Analytics aggregates exclude poisoned-window rows (matches the
  // improvement-side buildOutcomeWhere contract); /search keeps them visible
  // (row badge + filter chip live on the FE).
  if (options?.excludePoisoned === true) {
    fragments.push(Prisma.sql`poisoned_window = FALSE`);
  }

  // Day window — Prisma.empty when 'all' (no time filter).
  if (filters.days !== "all") {
    const intervalLiteral = buildIntervalLiteral(filters.days);
    fragments.push(Prisma.sql`record_ts >= CURRENT_DATE - ${intervalLiteral}`);
  }

  if (filters.agent !== null) {
    fragments.push(Prisma.sql`agent = ${filters.agent}`);
  }

  if (filters.task_type !== null) {
    // Allowlist-validated; safe to cast in SQL via column::text comparison.
    fragments.push(Prisma.sql`task_type::text = ${filters.task_type}`);
  }

  if (filters.result !== null) {
    fragments.push(Prisma.sql`result::text = ${filters.result}`);
  }

  // confidence: undefined = no filter; null = IS-NULL filter; literal = equality.
  // Read-only — safe to call N times on the same ParsedFilters (count + data
  // queries share one object on /cross-analysis).
  if (filters.confidence === null) {
    fragments.push(Prisma.sql`confidence IS NULL`);
  } else if (filters.confidence !== undefined) {
    fragments.push(Prisma.sql`confidence::text = ${filters.confidence}`);
  }

  // metric_pass: undefined = no filter; null = IS-NULL filter; bool = equality.
  if (filters.metric_pass === null) {
    fragments.push(Prisma.sql`metric_pass IS NULL`);
  } else if (filters.metric_pass !== undefined) {
    fragments.push(Prisma.sql`metric_pass = ${filters.metric_pass}`);
  }

  if (filters.review_flag !== null) {
    fragments.push(Prisma.sql`review_flag = ${filters.review_flag}`);
  }

  // Keyword search: case-insensitive ILIKE across summary, lesson, and
  // concerns array (via unnest). Parameter binding via ${pattern} — no string
  // concatenation reaches SQL.
  if (filters.q !== null) {
    const pattern = `%${escapeLikePattern(filters.q)}%`;
    fragments.push(
      Prisma.sql`(summary ILIKE ${pattern} OR lesson ILIKE ${pattern} OR EXISTS (SELECT 1 FROM unnest(concerns) c WHERE c ILIKE ${pattern}))`,
    );
  }

  // Exact-match attribution_source equality — parameter-bound (no cast: column
  // is text). null = no filter (the /cross-analysis path always lands here).
  if (filters.attribution_source !== null) {
    fragments.push(Prisma.sql`attribution_source = ${filters.attribution_source}`);
  }

  // T7 (O2) — caller-opt-in registry gate. Fires ONLY when a caller supplies a
  // non-empty scopeAgentKeys (handleSearch does, UNLESS include_all); the two
  // cross-analysis callers omit it → this builder stays behavior-unchanged for
  // cross-analysis. BARE fragment (no leading AND) because it joins into the
  // fragments array via the Prisma.join separator below. Empty keys → skip
  // (fail-open; never push an empty fragment / never emit IN ()).
  if (options?.scopeAgentKeys !== undefined && options.scopeAgentKeys.length > 0) {
    fragments.push(buildAgentMembershipFragment(options.scopeAgentKeys));
  }

  if (fragments.length === 0) {
    return Prisma.empty;
  }
  // Prisma.join wraps each fragment with the separator; prefix WHERE so the
  // outer template doesn't need a sentinel `WHERE 1=1`.
  return Prisma.join(fragments, " AND ", "WHERE ");
}

// Escape ILIKE wildcards in user input so a literal `%` in the query does NOT
// match arbitrary content. PG default escape char is backslash; we double the
// percent/underscore/backslash chars themselves.
function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function getSortFragment(sort: OutcomeSortToken): Prisma.Sql {
  // Each branch hard-codes the validated literal — no user input reaches the
  // raw fragment. The id tiebreaker ensures pagination stability when the
  // primary sort key has duplicates.
  switch (sort) {
    case "record_ts:desc":
      return Prisma.raw("ORDER BY record_ts DESC, id DESC");
    case "record_ts:asc":
      return Prisma.raw("ORDER BY record_ts ASC, id ASC");
    case "revision_count:desc":
      return Prisma.raw("ORDER BY revision_count DESC, record_ts DESC, id DESC");
  }
}

// query-param parsers

function parseDaysParam(raw: string | undefined): OutcomesWindowDays | null {
  if (raw === undefined || raw === "") {
    // Default to 'all' for the search/cross-analysis endpoints (historical-search
    // use case where the user typically lifts the time filter).
    return "all";
  }
  if (raw === "all") {
    return "all";
  }
  if (!/^-?\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || !ALLOWED_DAYS_NUMERIC.has(parsed)) {
    return null;
  }
  return parsed as OutcomesWindowDays;
}

function parseLimitParam(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") {
    return SEARCH_LIMIT_DEFAULT;
  }
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > SEARCH_LIMIT_MAX) {
    return null;
  }
  return parsed;
}

function parseSortParam(raw: string | undefined): OutcomeSortToken | null {
  if (raw === undefined || raw === "") {
    return "record_ts:desc";
  }
  if (!ALLOWED_SORTS.has(raw as OutcomeSortToken)) {
    return null;
  }
  return raw as OutcomeSortToken;
}

// O2 show-all (forensic) toggle for /search. Lenient truthy parse — only '1' /
// 'true' lift the registry gate; any other value (absent / '0' / 'false' /
// garbage) falls back to the SAFE registry-scoped default rather than a 400 (a
// display toggle should never hard-fail a search). Pure + idempotent: no
// side-channel state (the confidence=null WeakSet delete-on-read regression is
// the anti-pattern this avoids).
function parseIncludeAll(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

// filter echo builders

function toSearchFilterEcho(
  filters: ParsedFilters,
  sort: OutcomeSortToken,
  limit: number,
  offset: number,
): OutcomeSearchFilterEcho {
  return {
    days: filters.days,
    agent: filters.agent,
    task_type: filters.task_type,
    result: filters.result,
    // Echo type is narrow (literal | null) with no 'unset' variant — collapse
    // the no-filter `undefined` to null, matching the pre-tri-state behavior.
    confidence: filters.confidence ?? null,
    metric_pass: filters.metric_pass === undefined ? "unset" : filters.metric_pass,
    review_flag: filters.review_flag,
    q: filters.q,
    attribution_source: filters.attribution_source,
    sort,
    limit,
    offset,
  };
}

function toCrossAnalysisFilterEcho(filters: ParsedFilters): OutcomeCrossAnalysisFilterEcho {
  return {
    days: filters.days,
    agent: filters.agent,
    task_type: filters.task_type,
    result: filters.result,
    // Echo type is narrow (literal | null) with no 'unset' variant — collapse
    // the no-filter `undefined` to null, matching the pre-tri-state behavior.
    confidence: filters.confidence ?? null,
    metric_pass: filters.metric_pass === undefined ? "unset" : filters.metric_pass,
    review_flag: filters.review_flag,
    q: filters.q,
  };
}

function emptyFilters(): ParsedFilters {
  return {
    days: "all",
    agent: null,
    task_type: null,
    result: null,
    confidence: undefined,
    metric_pass: undefined,
    review_flag: null,
    q: null,
    attribution_source: null,
  };
}

// Why Prisma.raw for the INTERVAL: parameterized INTERVAL binding requires a
// `($1 || ' days')::interval` text-cast that Prisma's template-tag does not
// emit cleanly. The literal form is clearer; safe because daysValue was
// allowlist-validated to a known integer ({7, 30, 90}). No user-controlled
// input reaches SQL.
function buildIntervalLiteral(daysValue: number | "all"): Prisma.Sql {
  if (daysValue === "all") {
    // Caller never invokes this with 'all' (gated upstream), but keep the
    // type-safe branch so the cast below cannot fail at runtime.
    return Prisma.empty;
  }
  return Prisma.raw(`INTERVAL '${daysValue} days'`);
}

function bigintToNumber(value: bigint): number {
  // PG SUM/COUNT and bigint columns return bigint; values realistic for this
  // app fit in safe-int range. Surface a clear error rather than silent truncation.
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`bigint ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

function formatDateOnly(date: Date): string {
  // PG DATE / Date#toISOString → midnight-UTC; slice keeps Y-M-D for /heatmap meta.
  return date.toISOString().slice(0, 10);
}

function truncateLesson(lesson: string | null): string | null {
  if (lesson === null) return null;
  if (lesson.length <= LESSON_TRUNCATE_LENGTH) return lesson;
  // Append ellipsis sentinel so the FE can render "show full" affordance.
  return `${lesson.slice(0, LESSON_TRUNCATE_LENGTH)}…`;
}

function cellKey(confidence: string | null, metric_pass: boolean | null): string {
  // Stable composite key for the cross-tab Map lookup. Use distinct tokens for
  // null vs. boolean values so they cannot collide ('true' vs the string 'true').
  const conf = confidence === null ? "_null_" : confidence;
  const mp = metric_pass === null ? "_null_" : metric_pass ? "true" : "false";
  return `${conf}|${mp}`;
}

function failWithDb(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  error: unknown,
): OutcomesErrorBody {
  return respondDbFailure(request, reply, route, error, "outcomes query failed");
}

function invalidParam(param: string): OutcomesErrorBody {
  return { error: "invalid_param", param };
}
