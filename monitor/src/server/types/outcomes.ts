// Response shapes for /api/outcomes/* endpoints, backed by core.outcomes (single
// table, no joins). PG bigint/numeric coerced to JSON-safe `number` via
// bigintToNumber/decimalToNumber (cost.ts pattern); literal-narrow unions let the
// FE switch on values without runtime assertions.

import type { TaskType } from "../task-types.js";

// 'all' adds an unbounded window for the historical-search use case; the route
// maps 'all' to "no day clause" rather than CURRENT_DATE - INTERVAL.
export type OutcomesWindowDays = 7 | 30 | 90 | "all";

// Mirrors PG enum core.TaskType (9-type canonical set — SoT:
// rules/core-outcome-record.md), derived from shared TASK_TYPES (task-types.ts) so it
// cannot drift. The 4 non-code types must be present or the allowlist guard drops those rows.
export type OutcomeTaskType = TaskType;

// Mirrors PG enum core.GraderVerdict — deterministic 3-state grader signal, SEPARATE
// from metric_pass (advisory, never overwrites the writer self-report). NULLable:
// legacy rows predate grader instrumentation.
export type OutcomeGraderVerdict = "verified_pass" | "unverified" | "verified_fail";

// Mirrors PG enum core.DowngradeOrigin — provenance of how a graded outcome
// arose, recorded alongside grader_verdict. DB column is NULLable (legacy rows).
export type OutcomeDowngradeOrigin =
  | "writer_true_downgraded"
  | "writer_false"
  | "synthesized";

// Mirrors PG enum core.OutcomeResult.
export type OutcomeResultLiteral =
  | "done"
  | "done_with_concerns"
  | "blocked"
  | "needs_context"
  | "fail";

// Mirrors PG enum core.Confidence (DB column is NULLable).
export type OutcomeConfidenceLiteral = "high" | "medium" | "low";

// Allowed sort tokens for /search. Format: '<column>:<direction>'. Allowlist
// enforced server-side; values outside this set yield 400.
export type OutcomeSortToken = "record_ts:desc" | "record_ts:asc" | "revision_count:desc";

// /api/outcomes/search

// Filter echo — every applied filter appears here so the FE can reconstruct the query.
// `metric_pass`: 'unset' = param absent (no SQL filter); null = explicit IS NULL; true/false filter the boolean.
export interface OutcomeSearchFilterEcho {
  days: OutcomesWindowDays;
  agent: string | null;
  task_type: OutcomeTaskType | null;
  result: OutcomeResultLiteral | null;
  confidence: OutcomeConfidenceLiteral | null;
  metric_pass: boolean | null | "unset";
  review_flag: boolean | null;
  q: string | null;
  // Exact-match attribution_source filter; null when no filter applied.
  attribution_source: string | null;
  sort: OutcomeSortToken;
  limit: number;
  offset: number;
}

// Per-row payload for the /search list view. `body_md` omitted — fetch via /:id on detail open.
export interface OutcomeSearchRow {
  id: number;
  record_ts: string;
  agent: string;
  task_type: OutcomeTaskType;
  result: OutcomeResultLiteral;
  confidence: OutcomeConfidenceLiteral | null;
  metric_pass: boolean | null;
  // Deterministic grader signal, advisory + separate from metric_pass. NULL = legacy un-graded row.
  grader_verdict: OutcomeGraderVerdict | null;
  downgrade_origin: OutcomeDowngradeOrigin | null;
  revision_count: number;
  review_flag: boolean;
  summary: string;
  // Truncated to 200 chars in route layer; null when DB column is NULL.
  lesson: string | null;
  // concerns/files_modified: first 5 entries only — full list lives on /:id.
  concerns: string[];
  files_modified: string[];
  cid: string | null;
  has_body_md: boolean;
  // Analytics aggregates exclude poisoned-window rows; search keeps them visible (row badge).
  poisoned_window: boolean;
  // Raw core.outcomes.attribution_source (verbatim, NOT re-categorized). NULL = legacy row.
  attribution_source: string | null;
  // QA-review score string (shape cov=N,ins=N,instr=N,clar=N). NULL for non-QA rows — FE renders no dots.
  qa_score: string | null;
}

export interface OutcomeSearchResponse {
  filter: OutcomeSearchFilterEcho;
  // Total matching rows BEFORE pagination — drives "showing N of M" disclosure.
  total: number;
  rows: OutcomeSearchRow[];
  fetched_at: string;
}

// /api/outcomes/:id

// Full detail payload — everything the detail panel needs in one fetch.
export interface OutcomeDetailResponse {
  id: number;
  record_ts: string;
  agent: string;
  task_type: OutcomeTaskType;
  result: OutcomeResultLiteral;
  confidence: OutcomeConfidenceLiteral | null;
  metric_pass: boolean | null;
  // Deterministic grader signal, advisory + separate from metric_pass. NULL = legacy un-graded row.
  grader_verdict: OutcomeGraderVerdict | null;
  downgrade_origin: OutcomeDowngradeOrigin | null;
  metric_type: string | null;
  revision_count: number;
  evaluative_signal: number | null;
  directive_hint: string | null;
  lesson: string | null;
  summary: string;
  concerns: string[];
  files_modified: string[];
  correlation_id: string | null;
  cid: string | null;
  review_flag: boolean;
  // QA-review score string (shape cov=N,ins=N,instr=N,clar=N). NULL for non-QA rows — FE renders no dots.
  qa_score: string | null;
  // Full markdown body (no truncation) — null when DB column is NULL.
  body_md: string | null;
  inserted_at: string;
}

// /api/outcomes/cross-analysis

// Filter echo for cross-analysis — same axes as /search minus pagination/sort.
export interface OutcomeCrossAnalysisFilterEcho {
  days: OutcomesWindowDays;
  agent: string | null;
  task_type: OutcomeTaskType | null;
  result: OutcomeResultLiteral | null;
  confidence: OutcomeConfidenceLiteral | null;
  metric_pass: boolean | null | "unset";
  review_flag: boolean | null;
  q: string | null;
}

// One cell of the confidence × metric_pass cross-tab. Always exactly 12 cells
// (3 confidence + null × 4 metric_pass); empty cells return count: 0.
// `is_polar_mismatch`: high+false = overconfidence; low+true = underconfidence.
export interface OutcomeCrossAnalysisCell {
  confidence: OutcomeConfidenceLiteral | null;
  metric_pass: boolean | null;
  count: number;
  is_polar_mismatch: boolean;
}

// Per-result aggregate with the reconstructed sub-count split out. `count` = ALL
// matching rows (additive, so result→count consumers stay correct). `reconstructed_count`
// isolates harness recovery artifacts (downgrade_origin='synthesized' OR attribution_source
// IN (completion-synthesized, budget-truncation, structuredoutput-derived)). Invariants:
// 0 <= reconstructed_count <= count; writer-emitted = count - reconstructed_count.
export interface OutcomeCrossAnalysisByResult {
  result: OutcomeResultLiteral;
  count: number;
  reconstructed_count: number;
}

// Per-agent aggregate with the reconstructed sub-count split out. `count` = ALL
// matching rows for the agent; `reconstructed_count` isolates harness recovery
// artifacts (same discriminator as OutcomeCrossAnalysisByResult). Invariants:
// 0 <= reconstructed_count <= count; writer-emitted headline = count - reconstructed_count.
export interface OutcomeCrossAnalysisByAgent {
  agent: string;
  count: number;
  reconstructed_count: number;
}

// Per-(agent, result) exact count over the matching set — the single-query SoT for
// the "Results by agent" stacked bar. Replaces the former 4-list per-result stitching
// (which silently dropped an agent ranked #11+ in any single result bucket). Registry-
// scoped identically to by_agent_top_10; every canonical agent's ALL results arrive so
// client-side per-agent totals reconcile exactly. `reconstructed_count` isolates harness
// recovery artifacts (same discriminator as OutcomeCrossAnalysisByAgent).
export interface OutcomeCrossAnalysisByAgentResult {
  agent: string;
  result: OutcomeResultLiteral;
  count: number;
  reconstructed_count: number;
}

// downgrade_origin distribution over the matching set — provenance of how graded
// outcomes arose. `writer_true_downgraded` (writer claimed pass, grader disagreed) is
// the most actionable writer/grader disagreement signal. `not_recorded` = legacy NULL
// rows (predate downgrade_origin instrumentation), reported separately, never a failure.
export interface OutcomeDowngradeBreakdown {
  writer_true_downgraded: number;
  writer_false: number;
  synthesized: number;
  not_recorded: number;
}

// Artifact-vs-quality breakdown — grader_verdict distribution over the matching set.
// Only the 3 graded buckets contribute to ratio denominators; legacy NULL-verdict rows
// are reported SEPARATELY as `not_measured` and EXCLUDED from `graded_total` so they
// cannot contaminate the ratios. A rate is null when graded_total is 0 (undefined, not 0).
export interface OutcomeGraderBreakdown {
  verified_pass: number;
  unverified: number;
  verified_fail: number;
  // Legacy rows with NULL grader_verdict — counted, but NOT in graded_total.
  not_measured: number;
  // verified_pass + unverified + verified_fail (excludes not_measured).
  graded_total: number;
  // Fractions of graded_total; null when graded_total is 0.
  verified_pass_rate: number | null;
  unverified_rate: number | null;
  verified_fail_rate: number | null;
}

// One row of the 9-type × grader_verdict crosstab. Always exactly 9 rows in TASK_TYPES
// order; absent types emit zero counts. NULL/drifted verdicts land in `not_measured`
// (never a fail bucket). `by_design_unverified` marks the 4 non-code types whose grader
// skips to `unverified` by design (review/diagnosis/doc/cleanup — SoT:
// rules/core-outcome-record.md) so the FE separates them without hardcoding the set.
export interface OutcomeTaskTypeGraderRow {
  task_type: OutcomeTaskType;
  verified_pass: number;
  unverified: number;
  verified_fail: number;
  not_measured: number;
  // Row sum — Σ total over the 9 rows equals the response `total`.
  total: number;
  by_design_unverified: boolean;
}

export interface OutcomeCrossAnalysisResponse {
  filter: OutcomeCrossAnalysisFilterEcho;
  // Matching rows AFTER poisoned_window exclusion — the aggregate population.
  total: number;
  // poisoned_window=TRUE rows excluded from every aggregate above — feeds the
  // on-screen '오염 제외 N건' disclosure chip.
  excluded_poisoned_count: number;
  // Always 12 cells (4 metric_pass values × 3 confidence values).
  cells: OutcomeCrossAnalysisCell[];
  by_result: OutcomeCrossAnalysisByResult[];
  // Top 10 agents in the matching set by row count.
  by_agent_top_10: OutcomeCrossAnalysisByAgent[];
  // Per-(agent, result) exact counts (all canonical agents, all results) — the stacked-bar SoT.
  by_agent_result: OutcomeCrossAnalysisByAgentResult[];
  // grader_verdict distribution with legacy NULL rows excluded from the ratios.
  grader_breakdown: OutcomeGraderBreakdown;
  // downgrade_origin distribution — writer/grader disagreement provenance.
  downgrade_breakdown: OutcomeDowngradeBreakdown;
  // 9-type × grader_verdict crosstab (always 9 rows, TASK_TYPES order).
  task_type_grader_breakdown: OutcomeTaskTypeGraderRow[];
  fetched_at: string;
}

// /api/outcomes/heatmap

// DOW × Hour grid filter token.
//   'all'    → no result filter
//   'empty'  → metric_pass IS NULL (Empty-signal cohort)
//   'failed' → result IN ('blocked','fail') — agents.ts failure_count semantics
//   'done'   → result IN ('done','done_with_concerns') — agents.ts success_count semantics
export type OutcomeHeatmapResultFilter = "all" | "empty" | "failed" | "done";

export interface OutcomeHeatmapMeta {
  // Echoed days param (1-90, default 30).
  days: number;
  result: OutcomeHeatmapResultFilter;
  // Sum of every cell — the FE asserts equality vs. the row/col totals.
  total_count: number;
  // ISO date strings (YYYY-MM-DD, UTC midnight floor).
  period_start: string;
  period_end: string;
  // EXTRACT(DOW/HOUR) runs against record_ts AT TIME ZONE <this value> (config.toml
  // [meta].timezone → ATRIUM_TIMEZONE), so the grid is tz-bucketed server-side — callers
  // render Sun~Sat / hours 0-23 directly, no client-side shift.
  timezone: string;
}

export interface OutcomeHeatmapResponse {
  // 7 rows × 24 cols 2D integer array (bucket-tz-bucketed). Row 0 = Sun … Row 6 = Sat;
  // Col 0 = hour 0 (bucket-tz midnight) … Col 23. Zero-filled, no sparse representation.
  data: number[][];
  meta: OutcomeHeatmapMeta;
  fetched_at: string;
}

// /api/outcomes/attribution-daily

// Daily attribution-health series. Decomposes core.outcomes.attribution_source into
// 4 sum-complete categories over ALL 11 CHECK-canonical values (no value drops from
// `total`); NULL rows excluded from every ratio (legacy, predate attribution tracking).
//
// attribution_loss qualification: raw `subagent-stop-missing` is ~100% harness phantom
// noise, NOT loss — counts as loss ONLY when a real core.agent_events 'SubagentStop'
// (non-sentinel agent_type) backs it within ±5min of record_ts; unbacked rows rewrite to
// `subagent-stop-phantom` and fold into 'synthesized'. Series sits near 0 (flat 0 = no genuine loss).
//
// Category → attribution_source mapping (server-side pivot):
//   healthy          ← hook-input, structuredoutput-completion (writer-emitted: block recovered
//                      from the terminal StructuredOutput input, writer fields intact)
//   attribution_loss ← subagent-stop-missing, GENUINE-ONLY (real SubagentStop backing ±5min)
//   literal_omission ← truncated_completion, completion-missing, budget-truncation
//   synthesized      ← completion-synthesized, conversation-only, cron-derived,
//                      agent-id-missing, structuredoutput-derived, subagent-stop-phantom,
//                      + else→catch-all (future canonical values fold here, total stays sum-complete)
//   total = healthy + attribution_loss + literal_omission + synthesized

// Allowlist for the days window — discrete membership {7,30,90}, NOT a range
// gate. Mirrors /search's allowlist discipline; blocks arbitrary INTERVAL.
export type AttributionDailyWindowDays = 7 | 30 | 90;

// One activity-bearing day. days_series carries active days only (inactive days
// omitted — FE zero-fills the grid). Each row satisfies the sum invariant:
// healthy + attribution_loss + literal_omission + synthesized === total.
export interface AttributionDailyPoint {
  // 'YYYY-MM-DD' (UTC, date_trunc('day', record_ts)).
  day: string;
  healthy: number;
  attribution_loss: number;
  literal_omission: number;
  synthesized: number;
  total: number;
}

// Integer sub-counts of the literal_omission window count — the three raw
// attribution_source literals that fold into 'literal_omission'. Invariant:
// truncated_completion + completion_missing + budget_truncation === the window's
// literal_omission total (so literal_omission_rate is unaffected by this split).
export interface LiteralOmissionBreakdown {
  truncated_completion: number;
  completion_missing: number;
  budget_truncation: number;
}

// One (agent, count) group for budget-truncation rows over the window.
export interface BudgetTruncationAgentCount {
  agent: string;
  count: number;
}

// DEV-scoped subset of the window telemetry — SAME aggregation as the parent summary,
// filtered to registry DEV agents (glass-atrium-dev-* prefix, dual-matched to legacy dev-*).
// Rates are fractions of DEV total_attributed; null when the DEV window holds no attributed
// rows. An empty DEV registry yields zeros + null rates — never fails open to all agents.
export interface AttributionDailyDevScope {
  total_attributed: number;
  synthesized_rate: number | null;
  literal_omission_rate: number | null;
  budget_truncation_count: number;
  budget_truncation_rate: number | null;
}

// Window-level summary over the whole [days] window (single SoT for the
// improvement.jsx pointer tile). Rates are fractions of total_attributed;
// null when total_attributed is 0 (no attributed rows in window → no rate).
export interface AttributionDailySummary {
  healthy_rate: number | null;
  attribution_loss_rate: number | null;
  literal_omission_rate: number | null;
  synthesized_rate: number | null;
  // Live windowed IS-NOT-NULL count (no frozen magic number).
  total_attributed: number;
  // Sub-counts of the literal_omission window total (sum-invariant, see above).
  literal_omission_breakdown: LiteralOmissionBreakdown;
  // budget-truncation rows grouped by agent over the window, sorted count DESC.
  // [] when the window holds no budget-truncation rows.
  budget_truncation_by_agent: BudgetTruncationAgentCount[];
  // DEV-scoped view of the same truncation/synthesized telemetry (subset of the
  // rates above, filtered to registry DEV agents).
  dev_scope: AttributionDailyDevScope;
}

export interface AttributionDailyResponse {
  fetched_at: string;
  days: AttributionDailyWindowDays;
  // Activity-bearing days only, ascending by day.
  days_series: AttributionDailyPoint[];
  window_summary: AttributionDailySummary;
}

// error envelope

export type OutcomesErrorBody =
  | { error: "internal" }
  | { error: "database_unavailable" }
  // DB-rejected client input (SQLSTATE class 22/23) — db-failure.ts taxonomy split.
  | { error: "invalid_input"; reason: string }
  | { error: "invalid_param"; param: string; allowed?: ReadonlyArray<string | number> }
  | { error: "not_found"; id: number };
