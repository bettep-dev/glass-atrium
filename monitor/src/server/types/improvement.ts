// Response shapes for /api/improvement endpoints — learning + autoagent join
// view, 2-tier. Tier semantics: "auto" = daemon-applied without review (PG enum
// 'auto') · "safety" = user-approval queue (PG enum 'user' + 'user-pending',
// folded into safety; the schema retains the 4-value ApprovalTier enum for back-compat).

// Public 2-tier surface.
export type ImprovementTier = "auto" | "safety";

// PG ProposalStatus enum mirror. pending/approved/snoozed = non-terminal ·
// applied/rejected/reverted = terminal. Every non-terminal status reaches a
// terminal one via the daemon (auto) or the user (approve/reject); 'reverted'
// is set ONLY by a human/CLI back-out of an applied row (the daemon-side
// post-apply regression watch is detection-only — it never writes it).
export type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "applied"
  | "snoozed"
  | "reverted";

// Terminal states — no further transition (applied = git-reversible only;
// rejected = learning-log EPM feed candidate; reverted = human/CLI back-out).
// approve/reject re-call → 409.
export const TERMINAL_PROPOSAL_STATUSES: ReadonlySet<ProposalStatus> = new Set([
  "applied",
  "rejected",
  "reverted",
]);

// Statuses the approve/reject endpoints act on. Mirrors daemon-apply.sh
// single-mode selection (`status IN ('pending','snoozed')`) + the reject UPDATE
// predicate. Anything else → already-terminal 409.
export const ACTIONABLE_PROPOSAL_STATUSES: ReadonlySet<ProposalStatus> = new Set([
  "pending",
  "snoozed",
]);

// POST /api/improvement/:id/approve — shells out to daemon-apply.sh
// --proposal-id --auto-regen, mapping the exit code to HTTP status. The daemon
// flips the PG status itself (the route does NOT double-write on the apply path).
// --auto-regen regenerates + pre-verifies + re-applies a stale diff inline, so
// the 200 surface keys off how the change landed: direct apply (exit 0) →
// neither flag · after-regen (exit 10) → regenerated · already-present (exit 12)
// → already_applied. The two flags are mutually exclusive; absence = direct apply.
export interface ApproveProposalResponse {
  id: number;
  status: "applied";
  // exit 10 — stale diff regenerated + pre-verify passed → re-applied + committed.
  regenerated?: true;
  // exit 12 — change already present in the file → row marked applied, NO new commit.
  already_applied?: true;
}

// Reject (200) — status flipped to `rejected` + reviewed_at/reviewed_by stamped.
export interface RejectProposalResponse {
  id: number;
  status: "rejected";
  reviewed_at: string; // ISO8601 UTC
}

// Discriminated mutation-error envelope — `status` literal is the discriminator
// (distinct from the GET-side ImprovementErrorBody, which keys on `error`).
// Branch → daemon-apply exit code + HTTP status:
//   noop (409)             ← exit 8: id not found OR already terminal (idempotent no-op)
//   apply_failed (422)     ← exit 9: git apply rejected the stored diff (row pending).
//                            --auto-regen routes stale diffs through 10-14, so kept as a
//                            defensive fallback only.
//   regen_failed (422)     ← exit 11: regenerated diff still would not land (row pending)
//   regen_invalid (422)    ← exit 13: regenerated diff failed 4-axis pre-verify (row pending);
//                            carries failing C1-C4 axes when stderr-parseable
//   unrecoverable (422)    ← exit 14: no landable diff regenerable (row pending)
//   already_terminal (409) ← reject UPDATE matched 0 rows (already terminal)
//   invalid_param (400)    ← :id not a positive integer
//   apply_error (500)      ← infra failure (exit 2 bad-arg / 3 no-psql / 6 DB-update-fail / other)
//   internal (500)         ← unexpected route-level failure
export type ImprovementMutationErrorBody =
  | { status: "noop"; id: number; reason: string }
  | { status: "apply_failed"; id: number; reason: string }
  | { status: "regen_failed"; id: number; reason: string }
  | { status: "regen_invalid"; id: number; reason: string; axes?: PreVerifyAxes }
  | { status: "unrecoverable"; id: number; reason: string }
  | { status: "already_terminal"; id: number; reason: string }
  | { status: "invalid_param"; param: string }
  | { status: "apply_error"; id: number; reason: string }
  | { status: "internal"; id: number };

// Pre-verify axis outcome (daemon-apply exit 13). Mirrors the daemon's
// `preverify_axes` C1-C4 booleans surfaced on the stderr line
// `axes: C1=true,...`. Each axis optional — the parse omits any axis not present
// (a missing/garbled line yields no `axes` field at all).
export interface PreVerifyAxes {
  C1?: boolean;
  C2?: boolean;
  C3?: boolean;
  C4?: boolean;
}

// 2-tier proposal counts across the window. DB enum 'user'/'user-pending' fold into 'safety'.
export type ImprovementTierDistribution = Record<ImprovementTier, number>;

// Outcome-record histogram across the window (core.outcomes — learning loop write side).
export interface ImprovementOutcomeSummary {
  total_records: number;
  // Keys mirror TaskType enum values; all 5 always present (zero-init) — FE skeleton stability.
  by_metric: Record<string, number>;
  // Keys mirror OutcomeResult enum values; all 5 always present (zero-init).
  by_result: Record<string, number>;
  review_flag_count: number;
}

// CTM (success) / EPM (failure) bucket counts. CTM = confidence='high' +
// metric_pass=true + result='done' · EPM = revision_count >= 2 OR result='fail'.
export interface ImprovementCtmEpmBuckets {
  ctm_count: number;
  epm_count: number;
}

// Per-agent style_ref telemetry (7-day rolling) — Project Convention Probe
// emission + Gaming-the-Judge cross-verify signal. v1.0 OPTIONAL phase, sparse
// until the style_ref + style_ref_verified columns populate. v1.1 graduation:
// emission_rate ≥ 0.50 AND (1 - verified_rate) < 0.10 across the DEV agents (FE-side).
export interface ImprovementStyleRefAgentRow {
  agent: string;
  // rows where style_ref IS NOT NULL (path or 'greenfield').
  emission_count: number;
  // denominator — per-agent outcomes total in window.
  emission_total: number;
  // emission_count / emission_total · null when total = 0.
  emission_rate: number | null;
  // rows with style_ref_verified = TRUE.
  verified_true_count: number;
  // denominator — style_ref IS NOT NULL AND != 'greenfield' (greenfield not verify-applicable).
  verified_eligible: number;
  // verified_true_count / verified_eligible · null when eligible = 0.
  verified_rate: number | null;
}

// 3-Tier Eval Grader rollout telemetry — baseline cohort split separating
// post-wire-in pass/fail from pre-3Tier baseline noise. Fixed 30-day window.
// Author-side filter: agent NOT IN ('orchestrator', 'subagent_stop_missing',
// 'unknown') — 3 infra-attribution agents out-of-scope.
export interface ImprovementTierBreakdown {
  window_days: number;
  // metric_pass=TRUE AND baseline_pre_3tier IS NULL (post-wire-in genuine pass).
  code_based_pass_30d: number;
  // metric_pass=FALSE AND baseline_pre_3tier IS NULL (post-wire-in genuine fail).
  code_based_fail_30d: number;
  // baseline_pre_3tier=TRUE (legacy EMPTY rows backfilled).
  pre_3tier_baseline_count: number;
}

// confidence_observed distribution by promotion_tier — daemon-populated
// empirical-posterior partition for the FE promotion-lane histogram. NULL
// promotion_tier rows fold into the 'unassigned' key (no silent drop).
export interface ImprovementConfidenceTierBucket {
  // lane label, OR 'unassigned' for NULL promotion_tier.
  promotion_tier: string;
  proposal_count: number;
  // mean confidence_observed across the lane; null when every lane row is NULL (FE → "—").
  confidence_observed_avg: number | null;
}

// confidence-distribution card summary. Always present; empty `buckets` during
// the forward-looking NULL phase before the daemon populates the columns.
export interface ImprovementConfidenceDistribution {
  window_days: number;
  buckets: ImprovementConfidenceTierBucket[];
  // Cross-lane mean confidence_observed; null when no row has a populated value.
  overall_confidence_observed_avg: number | null;
}

// style_ref KPI-card rollup.
export interface ImprovementStyleRefSummary {
  window_days: number;
  // DEV-agent allowlist (v1.1 escalation gate); FE renders sorted-by-agent.
  agents: ImprovementStyleRefAgentRow[];
  // Cross-agent headline rollups; null when no eligible rows exist in the window.
  overall_emission_rate: number | null;
  overall_verified_rate: number | null;
  // Verified/unverified/greenfield split counts (P13 Gaming-the-Judge card):
  //   verified   = style_ref_verified TRUE
  //   unverified = verify-eligible but not verified (the fake-rate numerator)
  //   greenfield = emitted 'greenfield' sentinel (verify structurally N/A)
  overall_verified_count: number;
  overall_unverified_count: number;
  overall_greenfield_count: number;
  // 1 - overall_verified_rate; null when no verify-eligible rows (honest "—", no fake zero).
  overall_fake_rate: number | null;
}

// Per-proposal compact summary (UI card row). snake_case matches project convention.
export interface ImprovementProposalRow {
  id: number;
  cycle_date: string; // 'YYYY-MM-DD'
  approval_tier: ImprovementTier;
  status: string; // ProposalStatus enum text (pending / approved / rejected / applied / snoozed / reverted)
  target_agent: string | null;
  target_file: string;
  pattern_label: string;
  classification: string; // 'apply' | 'reject'
  haiku_status: string | null;
  reviewed_at: string | null; // ISO8601
  cost_guard_state: string | null;
  // Pre-verify chain provenance (DB → API → FE). pre_verify_axes is JSONB
  // { c1..c4: bool } — `unknown` to force an FE type guard at the render site.
  rationale: string | null;
  pre_verify_rationale: string | null;
  pre_verify_axes: unknown;
  pre_verify_status: string | null;
  pre_verify_passed: boolean | null;
  // Daemon-populated, all NULL until the daemon-wiring spawn populates them.
  // confidence_observed = Beta-Binomial posterior mean (0.0-1.0) from the
  // EMPIRICAL signal tuple, NOT the writer self-report confidence enum ·
  // project_key = per-project partition (NULL = global) · promotion_tier = lane label.
  confidence_observed: number | null;
  project_key: string | null;
  promotion_tier: string | null;
}

// Surfaces orphan proposals (no matching outcome trace).
export interface ImprovementJoinMeta {
  // DISTINCT outcome agents appearing in proposals.target_agent within the window.
  // Agent-level only — no proposal→outcome FK exists, so record-level linkage is
  // unmeasurable here.
  linked_agent_count: number;
  orphan_proposals: number;
}

// Echo of the resolved query parameters — lets the FE reconstruct the request.
export interface ImprovementFilterEcho {
  limit: number;
  window_days: number;
  tier: ImprovementTier | null;
  agent: string | null;
}

export interface ImprovementResponse {
  fetched_at: string; // ISO8601 UTC
  window_days: number;
  filter: ImprovementFilterEcho;
  tier_distribution: ImprovementTierDistribution;
  outcome_summary: ImprovementOutcomeSummary;
  ctm_epm_buckets: ImprovementCtmEpmBuckets;
  proposals: ImprovementProposalRow[];
  // Status-aware actionable feed for the Kanban "Awaiting approval" column: status ∈
  // {pending, snoozed} AND safety-tier ONLY (auto-tier is terminal — no actionable row),
  // fetched WITHOUT the LIMIT that bounds `proposals` so actionable rows are never crowded
  // out. Same row shape; bounded by ACTIONABLE_FETCH_CAP (guards only a pathological backlog).
  actionable_proposals: ImprovementProposalRow[];
  join_meta: ImprovementJoinMeta;
  // Project Convention Probe telemetry. Always present; empty `agents` array +
  // null rates during v1.0 OPTIONAL phase before the style_ref columns are
  // populated. FE skeleton-stable.
  style_ref_summary: ImprovementStyleRefSummary;
  // 3-Tier baseline cohort split.
  // Fixed 30d window — separates post-wire-in pass/fail from backfilled baseline.
  // Pre-migration apply: all counts = 0 (column absent — SELECT returns 0 via
  // COUNT(*) FILTER on missing column would error; route gates query on column
  // presence via try/catch fallback OR migration apply confirmed via /api/health).
  tier_breakdown_30d: ImprovementTierBreakdown;
  // confidence_observed × promotion_tier distribution. Isolated SELECT (Promise.allSettled)
  // — touches late-added NULL-heavy columns, so a column gap degrades to empty buckets, not a
  // 503. Always present (empty buckets during the forward-looking NULL phase).
  confidence_distribution: ImprovementConfidenceDistribution;
}

// /api/improvement/stats (UI cards)

export interface ImprovementStatsResponse {
  fetched_at: string;
  tier_distribution: ImprovementTierDistribution;
  applied_last_7d: number;
  rejected_last_7d: number;
  // No-window lifetime counts — surface the historical applied burst the windowed
  // counts above structurally hide. apply_rate = applied/(applied+rejected) uses both.
  applied_all_time: number;
  rejected_all_time: number;
  review_flag_last_7d: number;
  // Deprecated alias of zero_apply_cycle_rate — the value measures zero APPLIED
  // patches per cycle, not generation failure; kept one release.
  haiku_skipped_rate: number;
  // 0.000..1.000 — cycles with zero applied patches / total cycles (7d).
  zero_apply_cycle_rate: number;
  // 3-way cycle decomposition over the same 7d window; the three counts partition
  // cycle_total_7d exactly (generated⇔patches_count>0, applied⇔patches_apply_count>0).
  cycle_total_7d: number;
  cycles_generated_applied_7d: number;
  cycles_generated_not_applied_7d: number;
  cycles_nothing_generated_7d: number;
}

// orphan learning-table read surfaces
//
// 3 core tables populated by hooks/daemons (learning-aggregator.py + autoagent loop),
// surfaced read-only. All 3 are bounded (LIMIT) + recency-ordered (ORDER BY) + summarized
// (aggregate rollups alongside recent rows), mirroring the /api/improvement/stats card shape.

// GET /api/improvement/learning-log — canonical learning-aggregator patterns
// (core.learning_log). Replaces the proposals+outcomes CTM/EPM re-derivation as
// the authoritative pattern feed. Recent rows ordered by last_updated DESC.
//
// Field semantics (mirror schema.prisma model LearningLog):
//   - pattern_signature       : aggregated learning-log pattern key (unique).
//   - frequency               : occurrence count feeding the pattern.
//   - agent                   : attributed agent (NULL = cross-agent pattern).
//   - status                  : LearningStatus lifecycle stage.
//   - approval_tier           : ApprovalTier enum text (auto / llm / user-pending / user).
//   - discovered_date         : 'YYYY-MM-DD' first-seen date.
//   - last_updated            : ISO8601 last aggregation touch.
//   - last_transition_at      : ISO8601 status-transition audit timestamp (NULL until transitioned).
//   - last_transition_reason  : status-transition audit note (NULL until transitioned).
export interface ImprovementLearningLogRow {
  id: number;
  pattern_signature: string;
  frequency: number;
  agent: string | null;
  status: string;
  approval_tier: string;
  discovered_date: string; // 'YYYY-MM-DD'
  last_updated: string; // ISO8601 UTC
  last_transition_at: string | null; // ISO8601 UTC
  last_transition_reason: string | null;
}

// Status × tier rollup bucket — one per distinct (status, approval_tier) pair.
export interface ImprovementLearningLogStatusBucket {
  status: string;
  approval_tier: string;
  count: number;
}

export interface ImprovementLearningLogResponse {
  fetched_at: string; // ISO8601 UTC
  total_patterns: number; // unfiltered table-wide count
  returned: number; // recent rows returned (≤ limit)
  // Status × approval_tier distribution across the whole table (skim card).
  status_distribution: ImprovementLearningLogStatusBucket[];
  // Most-recently-updated patterns (bounded by limit, ORDER BY last_updated DESC).
  patterns: ImprovementLearningLogRow[];
}

// GET /api/improvement/loop-events — per-cycle stage event stream
// (core.autoagent_loop_events). Recent events ordered by event_ts DESC.
//
// Field semantics (mirror schema.prisma model AutoagentLoopEvent):
//   - event_ts         : ISO8601 cycle-event timestamp.
//   - agent            : agent the cycle event targeted.
//   - rice             : RICE score (Decimal → number via ::float8 cast; NULL when unscored).
//   - eval_result      : daemon eval verdict text (e.g. 'verified' / 'reject' / 'fail').
//   - changes_added    : rule/instruction lines added by the cycle.
//   - changes_removed  : rule/instruction lines removed by the cycle.
export interface ImprovementLoopEventRow {
  id: number;
  event_ts: string; // ISO8601 UTC
  agent: string;
  rice: number | null;
  eval_result: string;
  changes_added: number;
  changes_removed: number;
}

// eval_result rollup bucket — one per distinct verdict.
export interface ImprovementLoopEventResultBucket {
  eval_result: string;
  count: number;
}

export interface ImprovementLoopEventsResponse {
  fetched_at: string; // ISO8601 UTC
  total_events: number; // unfiltered table-wide count
  returned: number; // recent rows returned (≤ limit)
  // eval_result distribution across the whole table (skim card).
  result_distribution: ImprovementLoopEventResultBucket[];
  // Most-recent event timestamp present in the table; null if empty.
  latest_event_ts: string | null; // ISO8601 UTC
  // Recent events (bounded by limit, ORDER BY event_ts DESC).
  events: ImprovementLoopEventRow[];
}

// GET /api/improvement/correction-signals — detection-quality view over the
// orphaned core.correction_signals table. Surfaces the stage1-vs-stage2
// detection agreement + revision_count delta that sit behind the aggregated
// revision_count elsewhere.
//
// stage1_matched / stage2_matched = whether each detection stage flagged a
// correction; agreement = the two stages concurred (both true OR both false).
export interface CorrectionSignalAgreement {
  both_matched: number; // stage1 && stage2
  stage1_only: number; // stage1 && !stage2
  stage2_only: number; // !stage1 && stage2
  neither_matched: number; // !stage1 && !stage2
  // both_matched + neither_matched (the two stages concurred).
  agreement_count: number;
  // Sum of the four disjoint buckets.
  total: number;
}

export interface CorrectionSignalRow {
  id: number;
  event_ts: string; // ISO8601 UTC
  task_type: string;
  stage1_matched: boolean;
  stage2_matched: boolean;
  final_detected: boolean;
  revision_count_delta: number;
}

export interface ImprovementCorrectionSignalsResponse {
  fetched_at: string; // ISO8601 UTC
  total_signals: number; // table-wide count
  // Stage1-vs-stage2 agreement rollup across the whole table.
  agreement: CorrectionSignalAgreement;
  // Sum + max of revision_count_delta table-wide (0 when the table is empty).
  revision_delta_sum: number;
  revision_delta_max: number;
  latest_event_ts: string | null; // ISO8601 UTC
  returned: number; // recent rows returned (≤ limit)
  // Most-recent signals (bounded by limit, ORDER BY event_ts DESC).
  signals: CorrectionSignalRow[];
}

// error envelope

// Discriminated union — every branch carries the `error` literal as discriminator.
export type ImprovementErrorBody =
  | { error: "internal" }
  | { error: "database_unavailable" }
  // DB-rejected client input (SQLSTATE class 22/23) — db-failure.ts taxonomy split.
  | { error: "invalid_input"; reason: string }
  | { error: "invalid_param"; param: string; allowed?: ReadonlyArray<string | number> };
