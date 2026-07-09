// Response shapes for /api/cost/* endpoints — backed by core.cost_events
// (prisma CostEvent model). PG bigint / numeric(12,6) values map to JSON-safe
// number via bigintToNumber (guarded against MAX_SAFE_INTEGER overflow) /
// decimalToNumber (toString() → Number(), Decimal(12,6) fits safely).

// Literal-narrow so the FE switches on the value without runtime assertions.
export type CostWindowDays = 7 | 30 | 90;

export interface CostByModelRow {
  // 'unknown' when DB column is NULL (legacy rows lack model attribution) — preserved.
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  session_count: number;
}

export interface CostByModelResponse {
  days: CostWindowDays;
  rows: CostByModelRow[];
  fetched_at: string;
}

export interface CacheHitRow {
  event_date: string;
  // null when (input_tokens + cache_read_tokens) = 0 — surfaces gaps honestly vs a misleading 0.0.
  cache_hit_rate: number | null;
  total_cache_read: number;
  total_input: number;
}

export interface CacheHitResponse {
  days: CostWindowDays;
  rows: CacheHitRow[];
  fetched_at: string;
}

export interface SessionDistributionRow {
  session_id: string;
  total_cost_usd: number;
  // Sum of input + output + cache_read + cache_creation token columns.
  total_tokens: number;
  event_count: number;
  last_event_at: string;
}

export interface SessionDistributionResponse {
  days: CostWindowDays;
  rows: SessionDistributionRow[];
  // True when total_session_count exceeds the 200-row cap → FE "top 200 of N" disclosure.
  truncated: boolean;
  // Sessions with at least one real-token event — no-LLM sessions excluded.
  total_session_count: number;
  // Sessions whose every event carries zero tokens (tracking sentinels / synthetic
  // rows, no LLM call) — excluded from rows + total, disclosed beside the histogram.
  no_llm_session_count: number;
  fetched_at: string;
}

export interface ParseErrorRow {
  event_date: string;
  error_count: number;
  total_count: number;
  // error_count / total_count, 0.0–1.0; 0 when total_count = 0 (gap-fill day).
  error_ratio: number;
}

export interface ParseErrorResponse {
  days: CostWindowDays;
  rows: ParseErrorRow[];
  fetched_at: string;
}

// Surfaces stop_reason distribution + num_turns aggregate. duration_ms NOT
// surfaced — 100% zero in production (collected but never populated with real
// latency), so charting it would show a misleading flat-zero metric.

export interface StopReasonBucket {
  // 'no_assistant_in_turn' = tool-only / no-LLM-call turn (by-design zero-rows) ·
  // 'end_turn' = completed LLM turn · 'unknown' = NULL-stop_reason legacy rows folded.
  stop_reason: string;
  event_count: number;
  session_count: number;
}

export interface TurnStatsRow {
  // Over events with a real turn count (num_turns > 0); tool-only zero-rows
  // excluded from the denominator → average reflects LLM-call turns.
  total_turns: number;
  // Per-EVENT mean — skew-sensitive; avg_turns_per_session is the budgeting metric.
  avg_turns: number;
  max_turns: number;
  // Events contributing to the turn aggregate (num_turns > 0).
  turn_event_count: number;
  // True per-session aggregate: AVG over SUM(num_turns) per session_id — owner sizes
  // maxTurns budgets with this, not the per-event mean. 0 when no qualifying session in window.
  avg_turns_per_session: number;
  // Sessions contributing to avg_turns_per_session.
  turn_session_count: number;
}

export interface TurnStatsResponse {
  days: CostWindowDays;
  // stop_reason distribution, ORDER BY event_count DESC.
  stop_reasons: StopReasonBucket[];
  // Single-row turn aggregate over the window.
  turns: TurnStatsRow;
  fetched_at: string;
}

// GET /api/cost/kpi
// Top KPI band of the cost screen: 오늘 비용 · 7일 비용 · 시간당 burn (3h) ·
// 성공 작업당 비용. Day buckets KST-pinned; the 3h burn window is rolling
// (liveness-style signal, not a calendar rate aggregate).
export interface CostKpiResponse {
  today_cost_usd: number;
  window_7d_cost_usd: number;
  // SUM(cost_usd) over the trailing 3 hours / 3.
  burn_rate_3h_usd_per_hour: number;
  // window_7d_cost_usd / done_count_7d; null when no done outcome exists (no fake 0).
  cost_per_done_usd: number | null;
  done_count_7d: number;
  // Configured day-bucket timezone echo (timezone.ts DAY_BUCKET_TIMEZONE).
  day_bucket_timezone: string;
  fetched_at: string;
}

export type CostErrorBody =
  | { error: "internal" }
  | { error: "database_unavailable" }
  // DB-rejected client input (SQLSTATE class 22/23) — db-failure.ts taxonomy split.
  | { error: "invalid_input"; reason: string }
  | { error: "invalid_days"; allowed: ReadonlyArray<CostWindowDays> };
