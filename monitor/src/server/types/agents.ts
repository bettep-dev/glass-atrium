// Response shapes for /api/agents/* endpoints — backed by core.outcomes
// (lifecycle-stats reads core.agent_events for Start↔Stop pairing). PG bigint /
// numeric values coerce to JSON-safe number via bigintToNumber / decimalToNumber.

import type { TaskType } from "../task-types.js";

export type AgentsWindowDays = 7 | 30 | 90;

// Mirrors PG enum core.TaskType — 9-type canonical set derived from the shared
// TASK_TYPES SoT (task-types.ts) so this union cannot drift from the runtime
// allowlist. Literal union keeps the generated Prisma enum out of the browser bundle.
export type AgentTaskType = TaskType;

export interface AgentSuccessRateRow {
  agent: string;
  task_type: AgentTaskType;
  // 'YYYY-MM-DD' (UTC). Zero-outcome (agent, task_type) days NOT emitted → FE gap-renders.
  event_date: string;
  // result IN ('done', 'done_with_concerns').
  success_count: number;
  // result IN ('blocked', 'fail') — needs_context excluded (user-fault, not agent).
  failure_count: number;
  total_count: number;
  // Reconstructed (harness-synthesized) portion of total_count — writer-emitted
  // headline = total_count - reconstructed_count (0 <= reconstructed_count <= total_count).
  reconstructed_count: number;
  // null when total_count = 0 (defensive — emitted rows always have ≥1 outcome).
  success_rate: number | null;
}

export interface AgentSuccessRateResponse {
  days: AgentsWindowDays;
  rows: AgentSuccessRateRow[];
  // True when the SUCCESS_RATE_LIMIT cap (routes/agents.ts) was hit → FE disclosure banner.
  truncated: boolean;
  fetched_at: string;
}

// 5-bucket histogram: revision_count exact 0/1/2/3, plus '4+' aggregating >=4.
// SQL CASE produces strings; the literal union locks downstream typing.
export type AgentRevisionBucket = "0" | "1" | "2" | "3" | "4+";

export interface AgentRevisionDistributionRow {
  agent: string;
  revision_bucket: AgentRevisionBucket;
  occurrence_count: number;
}

export interface AgentRevisionDistributionResponse {
  days: AgentsWindowDays;
  rows: AgentRevisionDistributionRow[];
  fetched_at: string;
}

export interface AgentReviewFlagTimeseriesRow {
  event_date: string;
  total_count: number;
  // review_flag=true count — set by outcome-record.sh on polar mismatch / empty signal.
  review_flagged_count: number;
  // metric_pass IS NULL — instruction ambiguity signal.
  empty_metric_count: number;
  // confidence='high' AND metric_pass=false OR confidence='low' AND metric_pass=true.
  polar_mismatch_count: number;
  // review_flagged_count / total_count, 0.0-1.0; 0 when total_count = 0 (gap-fill day).
  review_flag_ratio: number;
  // empty_metric_count / total_count, 0.0-1.0; 0 when total_count = 0.
  empty_metric_ratio: number;
}

export interface AgentReviewFlagTimeseriesResponse {
  days: AgentsWindowDays;
  rows: AgentReviewFlagTimeseriesRow[];
  fetched_at: string;
}

// Per-agent review_flag aggregation — adds the agent dimension (GROUP BY agent)
// the date-bucketed timeseries lacks, so the Health Index becomes two-signal.
// `agent` == FE agent_id/agent_name (agent_id == agent_name convention) → FE joins directly.
export interface AgentReviewFlagByAgentRow {
  agent: string;
  // review_flag_ratio denominator — total outcome rows for this agent in the window.
  total_count: number;
  // review_flag=true count — set by outcome-record.sh on polar mismatch / empty signal.
  review_flagged_count: number;
  // Reconstructed (harness-synthesized) portion of review_flagged_count — the
  // synthesis backstop records metric_pass=EMPTY → review_flag=true, so this is
  // the artifact share of the flagged headline. writer-emitted flagged =
  // review_flagged_count - reconstructed_count (0 <= reconstructed_count <= review_flagged_count).
  reconstructed_count: number;
  // review_flagged_count / total_count, 0.0-1.0. Never null — GROUP BY agent only
  // yields agents with ≥1 outcome.
  review_flag_ratio: number;
}

export interface AgentReviewFlagByAgentResponse {
  days: AgentsWindowDays;
  rows: AgentReviewFlagByAgentRow[];
  fetched_at: string;
}

export interface AgentFailurePatternRow {
  agent: string;
  // result='fail' count.
  fail_count: number;
  // result='blocked' count.
  blocked_count: number;
  // fail_count + blocked_count.
  total_breakages: number;
  // Reconstructed (harness-synthesized) portion of total_breakages — writer-emitted
  // headline = total_breakages - reconstructed_count (0 <= reconstructed_count <= total_breakages).
  reconstructed_count: number;
  // Deprecated alias of breakage_rate (name implied fail-only while the numerator
  // includes blocked) — kept one release.
  fail_rate: number;
  // total_breakages / total outcomes for this agent in window, 0.0-1.0.
  breakage_rate: number;
  // ISO8601 timestamp of the most recent breakage (UTC).
  last_breakage_at: string;
  // Top 5 most-frequent concern strings from breakage rows only; empty when none populated.
  top_concerns: string[];
}

export interface AgentFailurePatternsResponse {
  days: AgentsWindowDays;
  rows: AgentFailurePatternRow[];
  fetched_at: string;
}

export interface AgentLifecycleStatsRow {
  agent_type: string;
  // SubagentStart event count (every spawn, orphans included).
  start_count: number;
  // SubagentStop event count.
  stop_count: number;
  // agent_ids with BOTH a Start and a Stop in the window — duration-aggregate denominator.
  completed_count: number;
  // null when completed_count = 0 (no paired Start↔Stop in window).
  avg_duration_sec: number | null;
  p95_duration_sec: number | null;
  max_duration_sec: number | null;
}

export interface AgentLifecycleStatsResponse {
  days: AgentsWindowDays;
  rows: AgentLifecycleStatsRow[];
  fetched_at: string;
}

// summary/latency/failure-reasons (G2/G3/G4) use INTEGER-RANGE day validation
// (1-90 / 1-30) rather than the {7|30|90} allowlist → arbitrary recent windows
// (e.g. 14d) without allowlist churn.

// active ← outcome ≤24h · idle ← 24h-7d · inactive ← >7d or none ·
// error ← above bucket + most-recent outcome result='fail'.
export type AgentSummaryStatus = "active" | "idle" | "inactive" | "error";

// 'cost' excluded — cost attribution unavailable.
export type AgentSummarySortKey = "name" | "runs" | "success" | "p95";

// Cost attribution honesty flag. unavailable = outcomes ⟂ cost_events join key
// absent (current cycle MUST always emit this) · approximate/exact = future.
export type AgentSummaryCostAttribution = "unavailable" | "approximate" | "exact";

export interface AgentSummaryItem {
  // Both hold the agent NAME (e.g. "react-dev") — no separate hash id this cycle; the
  // agent_id hash in core.agent_events is internal pairing-key only.
  agent_id: string;
  agent_name: string;
  // outcomes row count for the agent within the window (group by `agent`).
  runs: number;
  // Matrix semantics — success ÷ (done+dwc+blocked+fail), 0..100 (percentage).
  // needs_context excluded from the denominator (user-fault, not agent) and
  // surfaced separately as needs_context_count.
  success_pct: number;
  // result='needs_context' count — excluded from the success denominator.
  needs_context_count: number;
  // Always null — cost attribution unavailable. FE disables the cell via the meta flag.
  cost: null;
  // p95 of (Stop - Start) durations in ms; null when no Start/Stop pair exists in window.
  p95_ms: number | null;
  status: AgentSummaryStatus;
  // ISO 8601 UTC timestamp of the most recent outcome; null when none in window.
  last_run_at: string | null;
  // agent-registry.json runtime-precondition declaration (e.g. "monitor running at
  // 127.0.0.1:16145"). Undeclared/missing registry → null. Orthogonal to the frontmatter
  // `tools:` array — not a tool-authorization bypass.
  compatibility: string | null;
  // 1-line role description from the agent .md frontmatter (SoT); null when absent/unusable.
  description: string | null;
  // agent-registry.json dual_phase flag — two-lifecycle-phase agent. false when undeclared.
  dual_phase: boolean;
  // agent-registry.json origin — "user" (ADD-created) or "shipped" (built-in). FE gates
  // the delete affordance on origin === "user". null when undeclared.
  origin: string | null;
  // core.agent_events SubagentStart count over the ACTIVE ?days window — spawn frequency,
  // distinct from `runs` (outcomes-derived). Null when agent_type absent from agent_events
  // (outcomes-only agent, e.g. orchestrator); 0 = zero spawns in the window.
  invocations: number | null;
  // Deprecated alias of `invocations` (name implied fixed 30d; tracks ?days) — kept one release.
  invocations_30d: number | null;
}

export interface AgentSummaryMeta {
  days: number;
  total_agents: number;
  // ISO date strings (YYYY-MM-DD, UTC midnight floor of the window).
  period_start: string;
  period_end: string;
  // Honesty flag — current cycle MUST be "unavailable".
  cost_attribution: AgentSummaryCostAttribution;
}

export interface AgentSummaryResponse {
  agents: AgentSummaryItem[];
  meta: AgentSummaryMeta;
  fetched_at: string;
}

export interface AgentLatencyItem {
  agent_id: string;
  agent_name: string;
  // Percentile of paired (SubagentStart → SubagentStop) durations in ms. All three
  // null when the (agent, window) pairing yields zero rows — no default injection.
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
}

export interface AgentLatencyMeta {
  days: number;
  total_agents: number;
  period_start: string;
  period_end: string;
}

export interface AgentLatencyResponse {
  agents: AgentLatencyItem[];
  meta: AgentLatencyMeta;
  fetched_at: string;
}

// Breakage result-type the cause analysis scopes to. fail = result='fail' rows
// (default). blocked = result='blocked' rows — breakages are blocked-dominant, so
// the fail-only default hides the dominant type. Parameterized → either dimension,
// no new endpoint.
export type AgentFailureReasonResultType = "fail" | "blocked";

// Approximate keyword-matching categories. 'other' catches rows whose
// directive_hint matched no category.
export type AgentFailureReasonCategory =
  | "context_overflow"
  | "api_timeout"
  | "parse_error"
  | "rate_limit"
  | "tool_failure"
  | "other";

export interface AgentFailureReasonRow {
  category: AgentFailureReasonCategory;
  count: number;
  // 0..100 (percentage of total_failures). Emitted rows sum to 100 when
  // total_failures > 0; zero-count categories excluded (matched only).
  pct: number;
}

export interface AgentFailureReasonsMeta {
  agent: string;
  days: number;
  // Breakage count classified, scoped to `result_type`. Name kept for
  // backward compatibility (was fail-only); now reflects the requested dimension.
  total_failures: number;
  // Breakdown dimension — defaults to 'fail' when the `result` query param is
  // absent (existing fail-only consumers unchanged).
  result_type: AgentFailureReasonResultType;
  // Honesty label — keyword classification is heuristic, not ground-truth.
  classification_method: "keyword_approximate";
}

export interface AgentFailureReasonsResponse {
  reasons: AgentFailureReasonRow[];
  meta: AgentFailureReasonsMeta;
  fetched_at: string;
}

export type AgentsErrorBody =
  | { error: "internal" }
  | { error: "database_unavailable" }
  // DB-rejected client input (SQLSTATE class 22/23) — db-failure.ts taxonomy split.
  | { error: "invalid_input"; reason: string }
  | { error: "invalid_days"; allowed: ReadonlyArray<AgentsWindowDays> }
  | { error: "invalid_param"; param: string; reason?: string };

// DELETE /api/agents/:name — gated DEV-agent DELETE (wires the agent_lifecycle CLI
// `delete`). CLI gate semantics (NON-DEV block list, fail-closed-on-missing-scope/origin,
// --confirm hard gate) consumed unchanged; the mutation lock is owned solely by run_delete.

// preview = `delete <name> --dry-run` (zero-write: 4 targets + ALLOWED/REFUSED verdict);
// commit = `delete <name> --confirm <name>` (live, irreversible mv-to-Trash + chain prune).
export type DeleteAgentMode = "preview" | "commit";

export interface DeleteAgentRequestBody {
  mode: DeleteAgentMode;
  name: string;
  // commit only — the typed name confirming the irreversible delete. The CLI
  // re-checks it equals `name` (hard gate); a mismatch surfaces as `refused`.
  confirm?: string;
}

// preview result — the CLI dry-run is a pure read (exit 0 even when the policy
// REFUSES), so allowed=false is a normal preview outcome, not an error.
export interface DeleteAgentPreviewResult {
  result: "preview";
  name: string;
  // Authorization verdict parsed from the dry-run report (`-> ALLOWED|REFUSED`).
  allowed: boolean;
  // The single reason line from the dry-run (`reason: ...`); empty when absent.
  reason: string;
  // The 4-or-5 target lines (real .md / registry row / manifest / symlink farm /
  // optional scope-dev stanza) — shown to the operator before they confirm.
  targets: string[];
}

// commit result-state union — mirrors the CLI named exit-code contract.
// Exit 4 (EXIT_HALT) is CONFLATED across block-list / fail-closed / policy /
// unconfirmed, so every exit-4 cause maps to the one `refused` state.
export type DeleteAgentCommitResult =
  // exit 0 — the agent was deleted; reconcile the now-stale inject arrays.
  | {
      result: "deleted";
      name: string;
      // CLI summary line (step trace).
      summary: string;
      // The bidirectional reconcile skill — remove-stale (this delete) mirrors
      // add's insert-missing. The operator runs it to prune the deleted name
      // from the 3 inject-scope-rules.sh arrays.
      skill_to_run: string;
    }
  // exit 4 — refused by a safety gate (block-list / fail-closed / policy /
  // unconfirmed), zero writes (HTTP 409).
  | {
      result: "refused";
      name: string;
      reasons: string[];
    }
  // exit 5 — a cleanup step failed, transaction rolled back cleanly (HTTP 500).
  | {
      result: "rolled_back";
      name: string;
      detail: string;
    }
  // exit 6 — rollback itself failed, recovery marker written (HTTP 500).
  | {
      result: "recovery_needed";
      name: string;
      recovery_marker_path: string;
      remediation: string;
      detail: string;
    };

export type DeleteAgentResponse = DeleteAgentPreviewResult | DeleteAgentCommitResult;

// Body-shape rejection for the delete handler.
export interface AgentMutationErrorBody {
  error: "invalid_body";
  field: string;
  reason: string;
}

// CLI exit 2 (USAGE) post-validation OR a spawn error — a server-side bug, not
// a client error.
export interface AgentMutationInternalBody {
  error: "internal";
  reason: string;
}
