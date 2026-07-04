// Improvement API: read-only endpoints joining learning + autoagent for the
// unified self-improvement dashboard.
//
// 2-tier surface over a 4-value PG enum:
//   public 'auto'   ← DB ApprovalTier 'auto'
//   public 'safety' ← DB ApprovalTier 'user' OR 'user-pending' OR legacy 'llm'
//   'llm' is frozen/legacy but stays readable → folds into 'safety' in both the
//   tier_distribution count (foldTierCounts) AND the safety tier filter
//   (buildProposalWhere), so count and filter share the same 3-value safety set —
//   no orphan legacy row. The actionable feed (buildActionableProposalWhere) is
//   safety-only by construction (auto-tier is terminal — no auto actionable row).
//
// Index coverage:
//   autoagent_proposals_cycle_idx       (cycle_date)            — window filter
//   autoagent_proposals_status_tier_idx (status, approval_tier) — distribution
//   autoagent_proposals_agent_cycle_idx (target_agent, cycle_date) — agent filter
//   outcomes_ts_idx                     (record_ts)             — window filter
//
// tier_distribution is process-cached for STATS_CACHE_TTL_MS to absorb FE card
// polling (monotonic clock — no expiry-during-request races); main
// /api/improvement re-computes per-request.

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "../../generated/prisma/client.js";
import {
  buildAgentMembershipFilter,
  buildAgentMembershipFragment,
  loadCanonicalAgentKeys,
} from "../agents/registry.js";
import { getPrisma } from "../db.js";
import { respondDbFailure } from "../db-failure.js";
import { parseIdParam } from "../route-params.js";
import { TASK_TYPES } from "../task-types.js";
import type {
  ApproveProposalResponse,
  ImprovementConfidenceDistribution,
  ImprovementConfidenceTierBucket,
  ImprovementCtmEpmBuckets,
  ImprovementErrorBody,
  ImprovementFilterEcho,
  ImprovementJoinMeta,
  ImprovementLearningLogResponse,
  ImprovementLearningLogRow,
  ImprovementLearningLogStatusBucket,
  ImprovementLoopEventResultBucket,
  ImprovementLoopEventRow,
  ImprovementLoopEventsResponse,
  ImprovementMutationErrorBody,
  ImprovementOutcomeSummary,
  ImprovementProposalRow,
  ImprovementResponse,
  ImprovementStatsResponse,
  ImprovementStyleRefAgentRow,
  ImprovementStyleRefSummary,
  ImprovementTier,
  ImprovementTierBreakdown,
  ImprovementTierDistribution,
  PreVerifyAxes,
  RejectProposalResponse,
} from "../types/improvement.js";

const execFileAsync = promisify(execFile);

const ALLOWED_TIERS: ReadonlySet<ImprovementTier> = new Set(["auto", "safety"]);

// Pagination — keep ceilings defensive even though current dataset is small.
const LIMIT_MAX = 200;
const LIMIT_DEFAULT = 50;

// Actionable feed defensive cap. The actionable fetch (status ∈ pending/snoozed)
// is decoupled from the user `limit` so action rows are never truncated by the
// recency LIMIT; this ceiling guards a pathological pending backlog from
// unbounded payload.
const ACTIONABLE_FETCH_CAP = 200;

// Recent-row bound for the orphan-table read surfaces. Each endpoint returns a
// bounded recency slice + table-wide aggregate rollups, so the LIMIT caps the
// row payload while the summary stays complete.
const ORPHAN_LIMIT_DEFAULT = 50;
const ORPHAN_LIMIT_MAX = 200;

const WINDOW_DAYS_DEFAULT = 30;
const WINDOW_DAYS_MAX = 180;
const WINDOW_DAYS_MIN = 1;

// Always-present zero-init keys so the FE renders stable skeletons. task_type
// keys come from the shared 9-type TASK_TYPES SoT (task-types.ts) — a local
// subset would zero-init only part of the by_metric surface.
const RESULT_KEYS = ["done", "done_with_concerns", "blocked", "needs_context", "fail"] as const;

// tier_distribution / haiku_skipped_rate cache TTL (30s).
const STATS_CACHE_TTL_MS = 30_000;

// style_ref telemetry window fixed at 7 days, independent of the `window` query
// param (which controls the generic outcome/proposal aggregation) so the
// graduation-evaluation telemetry signal stays stable when users toggle the
// broader window filter.
const STYLE_REF_WINDOW_DAYS = 7;

// 3-Tier baseline cohort split window fixed at 30 days, independent of the user
// `window` param so cohort attribution stays comparable across panel refreshes
// (post-wire-in cohort needs ~30d to accumulate signal).
const TIER_BREAKDOWN_WINDOW_DAYS = 30;

// Cross-layer SoT for the greenfield sentinel string, mirrored verbatim in:
//   - bash:    ~/.glass-atrium/hooks/lib/style-ref-consts.sh   STYLE_REF_GREENFIELD
//   - python:  ~/.glass-atrium/hooks/_style_ref_consts.py      STYLE_REF_GREENFIELD
//   - TypeScript: this file (module-private — types/ stays type-only)
// The JSX consumer (public/src/screens/improvement.jsx) cannot import this const
// (Babel-standalone in-browser, public/ outside tsconfig include) — it tracks the
// value via this cross-layer reference comment only.
const STYLE_REF_GREENFIELD = 'greenfield' as const;

// style_ref telemetry is a DEV-only graduation signal — non-DEV agents do not
// emit style_ref, so including them corrupts overall_emission_rate (inflates the
// denominator). DEV membership is derived at RUNTIME from the agent-registry
// (canonical SoT) via this 'glass-atrium-dev-' name prefix — the registry has no `scope`
// field, so the prefix is the DEV discriminator per core-compliance-matrix Scope
// Legend. No hardcoded DEV_AGENTS array.
const DEV_AGENT_PREFIX = 'glass-atrium-dev-';

interface TierCountDbRow {
  approval_tier: string;
  count: bigint;
}

interface ProposalListDbRow {
  id: bigint;
  cycle_date: Date;
  pattern_label: string;
  target_file: string;
  target_agent: string | null;
  classification: string;
  haiku_status: string | null;
  approval_tier: string;
  status: string;
  cost_guard_state: string | null;
  reviewed_at: Date | null;
  // Provenance columns surfacing the pre-verify chain to the UI.
  rationale: string | null;
  pre_verify_rationale: string | null;
  pre_verify_axes: Prisma.JsonValue | null;
  pre_verify_status: string | null;
  pre_verify_passed: boolean | null;
  // Daemon-populated empirical posterior + project partition + promotion lane.
  // REAL → number | null on the Prisma raw mapping; all NULL until the
  // daemon-wiring populates them.
  confidence_observed: number | null;
  project_key: string | null;
  promotion_tier: string | null;
}

interface MetricCountDbRow {
  metric_type: string;
  count: bigint;
}

interface ResultCountDbRow {
  result: string;
  count: bigint;
}

// One row of the collapsed outcome aggregate (GROUPING SETS over the identical
// outcomeWhere window). A single scan yields three granularities in one row set:
//   - grand-total set ()        → grp_metric=1 AND grp_result=1; carries the four
//                                 scalar buckets (total/review_flag/ctm/epm) which
//                                 are valid ONLY on this row.
//   - per-task_type set (task)  → grp_metric=0; metric_type is the group key.
//   - per-result set (result)   → grp_result=0; result is the group key.
// grp_metric/grp_result are GROUPING(col) flags (1 = column folded out of this
// grouping set, 0 = column is the active group key). The conditional FILTER
// columns are computed on every set row but read only from the grand-total row.
interface OutcomeAggDbRow {
  grp_metric: number;
  grp_result: number;
  metric_type: string | null;
  result: string | null;
  total: bigint;
  review_flag_count: bigint;
  ctm_count: bigint;
  epm_count: bigint;
}

interface BigintRow {
  total: bigint;
}

interface AgentJoinRow {
  agent: string;
}

interface CycleCountRow {
  total_cycles: bigint;
  haiku_skipped: bigint;
  generated_applied: bigint;
  generated_not_applied: bigint;
  nothing_generated: bigint;
}

// No-window lifetime apply volume — surfaces the historical applied burst that the
// 7d/30d windows structurally hide. Single scan, two FILTER counts so apply_rate
// = applied/(applied+rejected) carries both numerator and denominator.
interface LifetimeCountRow {
  applied_all_time: bigint;
  rejected_all_time: bigint;
}

// Per-agent style_ref aggregation row shape — feeds rowToStyleRefAgentSummary.
// All counts are bigint from PG COUNT()/FILTER. `agent` matches
// core.outcomes.agent (TEXT, free-form — no PG enum).
interface StyleRefAgentDbRow {
  agent: string;
  emission_count: bigint;
  emission_total: bigint;
  verified_true_count: bigint;
  verified_eligible: bigint;
}

// 3-Tier baseline cohort split row — single-row PG result (3 parallel COUNT()
// FILTER aggregates in one SELECT). Feeds foldTierBreakdownRow →
// ImprovementTierBreakdown shape.
interface TierBreakdownDbRow {
  code_based_pass_30d: bigint;
  code_based_fail_30d: bigint;
  pre_3tier_baseline_count: bigint;
}

// confidence_observed × promotion_tier distribution row — one row per distinct
// promotion_tier in the window (NULL folded to 'unassigned' via COALESCE in SQL).
// Feeds foldConfidenceDistribution.
//
//   promotion_tier          : COALESCE(promotion_tier, 'unassigned') — TEXT.
//   proposal_count          : COUNT(*) per lane — bigint.
//   confidence_observed_avg : AVG(confidence_observed) — NULL when every row in
//                             the lane has NULL value (PG AVG skips NULLs and
//                             returns NULL for an all-NULL group). REAL → number
//                             | null on the Prisma raw mapping.
interface ConfidenceTierDbRow {
  promotion_tier: string;
  proposal_count: bigint;
  confidence_observed_avg: number | null;
}

// Orphan-table read row shapes. Decimal columns (jaccard_threshold / rice) are
// cast ::float8 in SQL so Prisma raw maps them to plain `number` (not a
// Prisma.Decimal object) — same numeric handling as confidence_observed.
interface LearningLogDbRow {
  id: bigint;
  pattern_signature: string;
  frequency: number;
  agent: string | null;
  status: string;
  approval_tier: string;
  discovered_date: Date;
  last_updated: Date;
  last_transition_at: Date | null;
  last_transition_reason: string | null;
}

interface LearningLogStatusDbRow {
  status: string;
  approval_tier: string;
  count: bigint;
}

interface LoopEventDbRow {
  id: bigint;
  event_ts: Date;
  agent: string;
  rice: number | null; // ::float8 cast (NULL preserved)
  eval_result: string;
  changes_added: number;
  changes_removed: number;
}

interface LoopEventResultDbRow {
  eval_result: string;
  count: bigint;
}

interface LoopEventAggDbRow {
  total: bigint;
  latest_event_ts: Date | null;
}

export async function registerImprovementRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/improvement", handleImprovement);
  app.get("/api/improvement/stats", handleImprovementStats);
  // Read-only surfaces for the orphan learning tables (learning_log /
  // autoagent_loop_events) populated by hooks/daemons.
  app.get("/api/improvement/learning-log", handleLearningLog);
  app.get("/api/improvement/loop-events", handleLoopEvents);
  // Interactive approval UI terminal-state writers. approve shells out to
  // daemon-apply.sh (high-impact; an unwanted apply is recoverable via the
  // agents-bak before-image restore below, within the retention window). reject
  // is a status-only, low-risk transition to 'rejected'.
  app.post("/api/improvement/:id/approve", handleApprove);
  app.post("/api/improvement/:id/reject", handleReject);
  // Git-free recovery for an applied proposal: rolls the touched agent .md files
  // back from the agents-bak before-image snapshot captured at apply time
  // (handleRestore → scripts/update.sh --restore-agents). Replaces the retired
  // VCS rollback path — the git-free daemon keeps no in-repo history to lean on.
  app.post("/api/improvement/:id/restore", handleRestore);
}

// GET /api/improvement
interface ImprovementQuerystring {
  limit?: string;
  window?: string;
  tier?: string;
  agent?: string;
}

// Fastify does not strip/reject unrecognized querystring keys without a route
// schema — a misspelled or legacy key (e.g. `window_days`) previously fell
// through silently, leaving the `window` default in effect with no error.
// parseImprovementQuery rejects any key outside this set so misuse is loud.
const IMPROVEMENT_QUERY_KEYS: ReadonlySet<string> = new Set([
  "limit",
  "window",
  "tier",
  "agent",
]);

async function handleImprovement(
  request: FastifyRequest<{ Querystring: ImprovementQuerystring }>,
  reply: FastifyReply,
): Promise<ImprovementResponse | ImprovementErrorBody> {
  const start = Date.now();

  const parsed = parseImprovementQuery(request.query);
  if (parsed.kind === "error") {
    return reply.code(400).send(parsed.body);
  }
  const { limit, windowDays, tier, agent } = parsed.value;

  // Registry load hoisted above the WHERE builders: T8 gates the proposal +
  // actionable feeds on target_agent registry-membership, T9 gates the
  // tier_breakdown cohort, and the style_ref DEV subset below derives from the
  // same cached entries. Cached singleton, so the early load adds no cost.
  const canonicalKeys = await loadCanonicalAgentKeys();

  const proposalWhere = buildProposalWhere(windowDays, tier, agent, canonicalKeys);
  // Actionable feed WHERE — status ∈ pending/snoozed AND safety-tier only
  // (auto-tier is terminal by construction → no auto actionable surface). `agent`
  // filter preserved (FE drill-down consistency); recency window dropped so
  // actionable rows are never crowded out of the safety column by the
  // recent-terminal slice.
  const actionableWhere = buildActionableProposalWhere(agent, canonicalKeys);
  // Registry-membership scope for outcome_summary + join_meta.linked_agent_count
  // — closes the gap T8/T9/T10 deliberately left open. buildOutcomeWhere now
  // takes canonicalKeys directly (in-builder gate, mirrors
  // buildProposalWhere/buildActionableProposalWhere) — the external
  // buildAgentMembershipFilter concatenation this call site used to bolt on is
  // gone.
  const outcomeWhere = buildOutcomeWhere(windowDays, agent, canonicalKeys);
  // style_ref telemetry window fixed at 7 days, independent of `windowDays`.
  // Agent filter still applies so the per-agent drill-down stays consistent.
  // canonicalKeys now applies to THIS base too (safe — devAgents below is
  // already a registry subset, so no double-gating concern). DEV-subset gate
  // appended to THIS where var ALONE, over its OWN buildOutcomeWhere(...) call
  // (not the outcomeWhere above) — unaffected by the registry-membership
  // scoping on outcomeWhere. DEV keys derived at runtime from the registry
  // ('glass-atrium-dev-' prefix). Fail-soft: an empty DEV set skips the predicate
  // (fail-open) — Prisma.join([]) is invalid SQL.
  const devAgents = canonicalKeys.filter((name) =>
    name.startsWith(DEV_AGENT_PREFIX),
  );
  const baseStyleRefWhere = buildOutcomeWhere(STYLE_REF_WINDOW_DAYS, agent, canonicalKeys);
  const styleRefWhere =
    devAgents.length === 0
      ? baseStyleRefWhere
      : Prisma.sql`${baseStyleRefWhere} AND agent IN (${Prisma.join(devAgents)})`;

  const prisma = getPrisma();
  try {
    const [
      tierRows,
      proposalRows,
      actionableRows,
      outcomeAggRows,
      linkedAgentRows,
      styleRefAgentRows,
    ] = await Promise.all([
      // tier_distribution — UNFILTERED by `tier` param so the FE chip badges
      // stay stable when the user toggles a tier filter. `agent` + window apply.
      prisma.$queryRaw<TierCountDbRow[]>`
        SELECT approval_tier::text AS approval_tier, COUNT(*)::bigint AS count
        FROM core.autoagent_proposals
        ${buildProposalWhere(windowDays, null, agent, canonicalKeys)}
        GROUP BY approval_tier
      `,
      // proposals — limit-bounded paginated rows, including the rationale +
      // pre_verify_* provenance chain.
      prisma.$queryRaw<ProposalListDbRow[]>`
        SELECT
          id,
          cycle_date,
          pattern_label,
          target_file,
          target_agent,
          classification::text AS classification,
          haiku_status,
          approval_tier::text AS approval_tier,
          status::text AS status,
          cost_guard_state,
          reviewed_at,
          rationale,
          pre_verify_rationale,
          pre_verify_axes,
          pre_verify_status,
          pre_verify_passed,
          confidence_observed,
          project_key,
          promotion_tier
        FROM core.autoagent_proposals
        ${proposalWhere}
        ORDER BY cycle_date DESC, id DESC
        LIMIT ${limit}
      `,
      // Actionable feed — status ∈ pending/snoozed AND safety-tier, recency-window-
      // independent (no user LIMIT) so the Kanban "Awaiting approval" column is
      // never crowded out by the recent-terminal slice. Same column projection +
      // row shape as `proposals`. Bounded by ACTIONABLE_FETCH_CAP. actionableWhere
      // supplies the status gate + safety-tier gate + agent filter (auto-
      // parameterized by Prisma.sql).
      // Index: autoagent_proposals_status_tier_idx covers the status predicate.
      prisma.$queryRaw<ProposalListDbRow[]>`
        SELECT
          id,
          cycle_date,
          pattern_label,
          target_file,
          target_agent,
          classification::text AS classification,
          haiku_status,
          approval_tier::text AS approval_tier,
          status::text AS status,
          cost_guard_state,
          reviewed_at,
          rationale,
          pre_verify_rationale,
          pre_verify_axes,
          pre_verify_status,
          pre_verify_passed,
          confidence_observed,
          project_key,
          promotion_tier
        FROM core.autoagent_proposals
        ${actionableWhere}
        ORDER BY cycle_date DESC, id DESC
        LIMIT ${ACTIONABLE_FETCH_CAP}
      `,
      // outcome_summary buckets — collapsed into ONE scan over the identical
      // outcomeWhere window. GROUP BY GROUPING SETS yields three granularities in
      // a single row set: grand total (the () set, carrying the scalar
      // total/review_flag/ctm/epm FILTER counts), per-task_type (by_metric), and
      // per-result (by_result). The four conditional FILTER columns are evaluated
      // on every set row but read only from the grand-total row (foldOutcomeAgg),
      // so each bucket is reassembled byte-identically to the former 6 separate
      // COUNT/GROUP BY queries. Index: outcomes_ts_idx covers the window predicate.
      prisma.$queryRaw<OutcomeAggDbRow[]>`
        SELECT
          GROUPING(task_type)::int AS grp_metric,
          GROUPING(result)::int AS grp_result,
          task_type::text AS metric_type,
          result::text AS result,
          COUNT(*)::bigint AS total,
          COUNT(*) FILTER (WHERE review_flag = TRUE)::bigint AS review_flag_count,
          COUNT(*) FILTER (
            WHERE confidence = 'high'::core."Confidence"
              AND metric_pass = TRUE
              AND result = 'done'::core."OutcomeResult"
          )::bigint AS ctm_count,
          COUNT(*) FILTER (
            WHERE revision_count >= 2 OR result = 'fail'::core."OutcomeResult"
          )::bigint AS epm_count
        FROM core.outcomes
        ${outcomeWhere}
        GROUP BY GROUPING SETS ((), (task_type), (result))
      `,
      // join_meta.linked_agent_count — DISTINCT outcome agents whose `agent`
      // appears in proposals.target_agent for the same window. Coarse linkage (no
      // proposal id → outcome id FK exists in the schema); used as a sanity counter.
      prisma.$queryRaw<AgentJoinRow[]>`
        SELECT DISTINCT o.agent
        FROM core.outcomes o
        ${outcomeWhere}
          AND EXISTS (
            SELECT 1
            FROM core.autoagent_proposals p
            ${buildProposalWhere(windowDays, null, null, canonicalKeys)}
              AND p.target_agent = o.agent
          )
      `,
      // style_ref telemetry — per-agent 7-day rolling aggregation. Two parallel
      // ratios:
      //   1. emission_rate    = emission_count / emission_total
      //        (style_ref IS NOT NULL — path OR 'greenfield')
      //   2. verified_rate    = verified_true_count / verified_eligible
      //        (eligibility excludes 'greenfield' rows — structurally no path to
      //         cross-verify against tool_use Read history)
      // Index usage: outcomes_style_ref_agent_ts_idx (partial, predicate
      // `style_ref IS NOT NULL`) covers emission_count + verified counts;
      // emission_total uses outcomes_agent_ts_idx. ${STYLE_REF_GREENFIELD} is
      // auto-parameterized (bound at execute time, not inlined) — the partial
      // index predicate carries no greenfield literal, only the FILTER clause uses
      // the bound parameter, so the index stays usable.
      prisma.$queryRaw<StyleRefAgentDbRow[]>`
        SELECT
          agent,
          COUNT(*) FILTER (WHERE style_ref IS NOT NULL)::bigint AS emission_count,
          COUNT(*)::bigint AS emission_total,
          COUNT(*) FILTER (WHERE style_ref_verified = TRUE)::bigint AS verified_true_count,
          COUNT(*) FILTER (
            WHERE style_ref IS NOT NULL AND style_ref <> ${STYLE_REF_GREENFIELD}
          )::bigint AS verified_eligible
        FROM core.outcomes
        ${styleRefWhere}
        GROUP BY agent
        ORDER BY agent
      `,
    ]);

    // Graceful degradation: tier_breakdown and confidence_distribution are
    // optional metrics, the only queries touching the late-added
    // `baseline_pre_3tier` / confidence_observed / promotion_tier columns.
    // Isolated out of the main Promise.all so a single optional-column absence
    // (PG 42703 undefined_column) degrades to a zero-init partial instead of
    // collapsing the endpoint to 503 — the DB is available, just one column
    // missing. The other queries stay in the Promise.all: their failure IS a
    // genuine DB-down signal so 503 stays correct (failWithDb catch). allSettled
    // never rejects → the catch is reserved for real infra failures.
    //
    // Degradation shape: foldTierBreakdownRow([]) zero-init keeps
    // `tier_breakdown_30d` a non-null object so the FE renders its no-data
    // indicator rather than crashing on a null/missing field.
    const [tierBreakdownResult, confidenceDistResult] = await Promise.allSettled([
      // 3-Tier baseline cohort split — fixed 30d window
      // (TIER_BREAKDOWN_WINDOW_DAYS, independent of the `windowDays` user filter).
      // 3 parallel COUNT() FILTER aggregates in one SELECT (single-row return,
      // folded by foldTierBreakdownRow). T9 — scoped to the positive registry
      // allowlist (agent IN loadAgentRegistry()) instead of the former 3-item
      // infra denylist; the registry excludes those infra tokens (orchestrator /
      // subagent_stop_missing / unknown) AND every other non-registry noise agent,
      // so the allowlist subsumes the retired denylist. Fail-open on an empty
      // registry (buildAgentMembershipFilter → Prisma.empty → predicate skipped).
      // poisoned_window rows excluded — they are metric_pass=false mis-measurements
      // that would inflate code_based_fail_30d (mirrors the baseline_pre_3tier
      // exclusion style above).
      //
      // Index usage: outcomes_baseline_pre_3tier_idx (partial, predicate
      // `WHERE baseline_pre_3tier IS NOT NULL`) supports pre_3tier_baseline_count
      // directly. code_based_pass/fail_30d use outcomes_ts_idx + bitmap AND on the
      // metric_pass column (partial COUNT acceptable at the 30d cohort scale).
      prisma.$queryRaw<TierBreakdownDbRow[]>`
        SELECT
          COUNT(*) FILTER (WHERE metric_pass = TRUE AND baseline_pre_3tier IS NULL)::bigint AS code_based_pass_30d,
          COUNT(*) FILTER (WHERE metric_pass = FALSE AND baseline_pre_3tier IS NULL)::bigint AS code_based_fail_30d,
          COUNT(*) FILTER (WHERE baseline_pre_3tier = TRUE)::bigint AS pre_3tier_baseline_count
        FROM core.outcomes
        WHERE record_ts > NOW() - (${TIER_BREAKDOWN_WINDOW_DAYS}::int * INTERVAL '1 day')
          ${buildAgentMembershipFilter(canonicalKeys)}
          AND poisoned_window = FALSE
      `,
      // confidence_observed × promotion_tier distribution — isolated in the same
      // allSettled batch as tier_breakdown because it is the only proposal-side
      // aggregate touching the late-added confidence_observed/promotion_tier
      // columns: a future add/drop (PG 42703 undefined_column) degrades to empty
      // buckets, not a 503.
      //
      // GROUP BY the COALESCE'd lane so NULL promotion_tier rows surface under the
      // 'unassigned' label (no silent drop). AVG(confidence_observed) returns NULL
      // for an all-NULL lane (PG skips NULLs), which foldConfidenceDistribution
      // maps to a null avg → FE renders "not computed".
      //
      // The window filter reuses the user `windowDays` (proposal-side metric,
      // unlike the fixed-30d cohort-attribution tier_breakdown).
      // Index usage: autoagent_proposals_confidence_idx (partial, predicate
      // `WHERE confidence_observed IS NOT NULL`) assists the AVG; the cycle_date
      // window uses autoagent_proposals_cycle_idx.
      prisma.$queryRaw<ConfidenceTierDbRow[]>`
        SELECT
          COALESCE(promotion_tier, 'unassigned') AS promotion_tier,
          COUNT(*)::bigint AS proposal_count,
          AVG(confidence_observed)::double precision AS confidence_observed_avg
        FROM core.autoagent_proposals
        WHERE cycle_date >= CURRENT_DATE - (${windowDays}::int * INTERVAL '1 day')
        GROUP BY COALESCE(promotion_tier, 'unassigned')
        ORDER BY COALESCE(promotion_tier, 'unassigned')
      `,
    ]);

    // Isolated fold: fulfilled → real rows; rejected (column absent / query
    // error) → empty-array fold = zero-init partial. Logged warn (not error)
    // since the endpoint still 200s.
    let tierBreakdownRows: TierBreakdownDbRow[];
    if (tierBreakdownResult.status === "fulfilled") {
      tierBreakdownRows = tierBreakdownResult.value;
    } else {
      tierBreakdownRows = [];
      request.log.warn(
        { err: tierBreakdownResult.reason, route: "/api/improvement" },
        "tier_breakdown query failed — degrading to zero-init partial (optional metric)",
      );
    }

    // Same isolated-fold contract — fulfilled → real rows; rejected (column gap /
    // query error) → empty buckets = forward-looking NULL partial.
    let confidenceDistRows: ConfidenceTierDbRow[];
    if (confidenceDistResult.status === "fulfilled") {
      confidenceDistRows = confidenceDistResult.value;
    } else {
      confidenceDistRows = [];
      request.log.warn(
        { err: confidenceDistResult.reason, route: "/api/improvement" },
        "confidence_distribution query failed — degrading to empty buckets (optional metric)",
      );
    }

    const tierDistribution = foldTierCounts(tierRows);
    const proposals = proposalRows.map(rowToProposalSummary);
    // Actionable feed → same compact summary mapper.
    const actionableProposals = actionableRows.map(rowToProposalSummary);
    const outcomeAgg = foldOutcomeAgg(outcomeAggRows);

    const outcomeSummary: ImprovementOutcomeSummary = {
      total_records: outcomeAgg.totalRecords,
      // Payload-only on this screen by F16 decision: the 9-type distribution
      // renders on outcomes via /api/outcomes/cross-analysis
      // task_type_grader_breakdown. Kept under the ADDITIVE-only API contract —
      // not dead code (drop stays a deferred option only if outcomes un-adopts).
      by_metric: outcomeAgg.byMetric,
      by_result: outcomeAgg.byResult,
      review_flag_count: outcomeAgg.reviewFlagCount,
    };
    const buckets: ImprovementCtmEpmBuckets = {
      ctm_count: outcomeAgg.ctmCount,
      epm_count: outcomeAgg.epmCount,
    };

    // orphan_proposals = proposals whose target_agent has zero outcome records
    // in the window (proposal exists but no observable behavioural trace).
    const linkedAgents = new Set(linkedAgentRows.map((r) => r.agent));
    const orphanProposals = proposals.filter(
      (p) => p.target_agent === null || !linkedAgents.has(p.target_agent),
    ).length;
    const joinMeta: ImprovementJoinMeta = {
      linked_agent_count: linkedAgents.size,
      orphan_proposals: orphanProposals,
    };

    const filterEcho: ImprovementFilterEcho = {
      limit,
      window_days: windowDays,
      tier,
      agent,
    };

    // Always emitted — empty agents array + null rates during the sparse-emission
    // phase.
    const styleRefSummary = buildStyleRefSummary(styleRefAgentRows);

    const tierBreakdown = foldTierBreakdownRow(tierBreakdownRows);

    const confidenceDistribution = foldConfidenceDistribution(confidenceDistRows, windowDays);

    request.log.info(
      {
        route: "/api/improvement",
        windowDays,
        tier,
        agent,
        proposalCount: proposals.length,
        actionableProposalCount: actionableProposals.length,
        styleRefAgentCount: styleRefSummary.agents.length,
        durationMs: Date.now() - start,
      },
      "improvement query complete",
    );

    return {
      fetched_at: new Date().toISOString(),
      window_days: windowDays,
      filter: filterEcho,
      tier_distribution: tierDistribution,
      outcome_summary: outcomeSummary,
      ctm_epm_buckets: buckets,
      proposals,
      actionable_proposals: actionableProposals,
      join_meta: joinMeta,
      style_ref_summary: styleRefSummary,
      tier_breakdown_30d: tierBreakdown,
      confidence_distribution: confidenceDistribution,
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/improvement", error);
  }
}

// GET /api/improvement/stats
interface StatsCacheEntry {
  expiresAt: number; // monotonic ms — Date.now() comparison
  payload: ImprovementStatsResponse;
}

// Process-singleton — reset only on daemon restart. Single-key map (no window
// parameter on stats endpoint), so we cache the latest payload directly.
let statsCache: StatsCacheEntry | null = null;

async function handleImprovementStats(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<ImprovementStatsResponse | ImprovementErrorBody> {
  const start = Date.now();
  const now = Date.now();

  if (statsCache !== null && statsCache.expiresAt > now) {
    return statsCache.payload;
  }

  const prisma = getPrisma();
  try {
    const canonicalKeys = await loadCanonicalAgentKeys();
    // Registry allowlist for THIS card's own tier_distribution query — separate
    // from the main /api/improvement handler's windowed tierRows query (which T9
    // already gates via buildProposalWhere). Bare fragment because this query
    // carries NO WHERE at all today (unlike buildProposalWhere/
    // buildActionableProposalWhere, which always have >=1 predicate to join
    // against); wrap manually and omit entirely on an empty registry (fail-open —
    // never emit a bare `WHERE`).
    const tierDistMembership = buildAgentMembershipFragment(canonicalKeys, Prisma.sql`target_agent`);
    const tierDistWhere = toBareWhere(tierDistMembership);
    const last7dWhere = Prisma.sql`WHERE cycle_date >= CURRENT_DATE - INTERVAL '7 days'`;
    // poisoned_window exclusion matches buildOutcomeWhere — stats and main
    // endpoint must report the same review_flag population.
    const last7dOutcomeWhere = Prisma.sql`WHERE record_ts > NOW() - INTERVAL '7 days' AND poisoned_window = FALSE`;
    const last7dRunsWhere = Prisma.sql`
      WHERE daemon_name = 'autoagent'
        AND run_date >= CURRENT_DATE - INTERVAL '7 days'
    `;

    const [tierRows, appliedRows, rejectedRows, reviewFlagRows, cycleRows, lifetimeRows] =
      await Promise.all([
      // tier_distribution — across all proposals (not windowed) so the card stays
      // representative of the steady state; registry-scoped via tierDistWhere.
      prisma.$queryRaw<TierCountDbRow[]>`
        SELECT approval_tier::text AS approval_tier, COUNT(*)::bigint AS count
        FROM core.autoagent_proposals
        ${tierDistWhere}
        GROUP BY approval_tier
      `,
      prisma.$queryRaw<BigintRow[]>`
        SELECT COUNT(*)::bigint AS total
        FROM core.autoagent_proposals
        ${last7dWhere}
          AND status = 'applied'::core."ProposalStatus"
      `,
      prisma.$queryRaw<BigintRow[]>`
        SELECT COUNT(*)::bigint AS total
        FROM core.autoagent_proposals
        ${last7dWhere}
          AND status = 'rejected'::core."ProposalStatus"
      `,
      prisma.$queryRaw<BigintRow[]>`
        SELECT COUNT(*)::bigint AS total
        FROM core.outcomes
        ${last7dOutcomeWhere}
          AND review_flag = TRUE
      `,
      // zero-apply rate = cycles with zero APPLIED patches / total (the old
      // "generation failure" framing was wrong — generation may have succeeded).
      // 3-way decomposition: generated⇔patches_count>0, applied⇔patches_apply_count>0;
      // the three buckets partition total_cycles exactly.
      prisma.$queryRaw<CycleCountRow[]>`
        SELECT
          COUNT(*)::bigint AS total_cycles,
          SUM(CASE WHEN COALESCE(patches_apply_count, 0) = 0 THEN 1 ELSE 0 END)::bigint AS haiku_skipped,
          COUNT(*) FILTER (
            WHERE COALESCE(patches_count, 0) > 0 AND COALESCE(patches_apply_count, 0) > 0
          )::bigint AS generated_applied,
          COUNT(*) FILTER (
            WHERE COALESCE(patches_count, 0) > 0 AND COALESCE(patches_apply_count, 0) = 0
          )::bigint AS generated_not_applied,
          COUNT(*) FILTER (
            WHERE COALESCE(patches_count, 0) = 0
          )::bigint AS nothing_generated
        FROM core.daemon_runs
        ${last7dRunsWhere}
      `,
      // No-window lifetime apply volume — the 7d/30d windows hide the historical
      // applied burst, so a denominator-bearing apply_rate needs both counts here.
      prisma.$queryRaw<LifetimeCountRow[]>`
        SELECT
          COUNT(*) FILTER (WHERE status = 'applied'::core."ProposalStatus")::bigint
            AS applied_all_time,
          COUNT(*) FILTER (WHERE status = 'rejected'::core."ProposalStatus")::bigint
            AS rejected_all_time
        FROM core.autoagent_proposals
      `,
    ]);

    const tierDistribution = foldTierCounts(tierRows);
    const appliedRow = appliedRows[0];
    const rejectedRow = rejectedRows[0];
    const reviewFlagRow = reviewFlagRows[0];
    const cycleRow = cycleRows[0];
    const lifetimeRow = lifetimeRows[0];

    const totalCycles = cycleRow === undefined ? 0 : bigintToNumber(cycleRow.total_cycles);
    const haikuSkipped = cycleRow === undefined ? 0 : bigintToNumber(cycleRow.haiku_skipped);
    const haikuSkippedRate = totalCycles === 0 ? 0 : haikuSkipped / totalCycles;

    const payload: ImprovementStatsResponse = {
      fetched_at: new Date().toISOString(),
      tier_distribution: tierDistribution,
      applied_last_7d: appliedRow === undefined ? 0 : bigintToNumber(appliedRow.total),
      rejected_last_7d: rejectedRow === undefined ? 0 : bigintToNumber(rejectedRow.total),
      applied_all_time:
        lifetimeRow === undefined ? 0 : bigintToNumber(lifetimeRow.applied_all_time),
      rejected_all_time:
        lifetimeRow === undefined ? 0 : bigintToNumber(lifetimeRow.rejected_all_time),
      review_flag_last_7d: reviewFlagRow === undefined ? 0 : bigintToNumber(reviewFlagRow.total),
      haiku_skipped_rate: Number(haikuSkippedRate.toFixed(4)),
      zero_apply_cycle_rate: Number(haikuSkippedRate.toFixed(4)),
      cycle_total_7d: totalCycles,
      cycles_generated_applied_7d:
        cycleRow === undefined ? 0 : bigintToNumber(cycleRow.generated_applied),
      cycles_generated_not_applied_7d:
        cycleRow === undefined ? 0 : bigintToNumber(cycleRow.generated_not_applied),
      cycles_nothing_generated_7d:
        cycleRow === undefined ? 0 : bigintToNumber(cycleRow.nothing_generated),
    };

    statsCache = {
      expiresAt: Date.now() + STATS_CACHE_TTL_MS,
      payload,
    };

    request.log.info(
      { route: "/api/improvement/stats", durationMs: Date.now() - start },
      "improvement stats query complete",
    );
    return payload;
  } catch (error) {
    return failWithDb(request, reply, "/api/improvement/stats", error);
  }
}

// GET /api/improvement/learning-log

// Shared querystring for the orphan-table read surfaces — only a recency `limit`.
interface OrphanQuerystring {
  limit?: string;
}

// `limit` parser bounded by the orphan-table ceilings (independent of the main
// LIMIT_MAX). null = 400 invalid_param. Empty/absent → ORPHAN_LIMIT_DEFAULT.
function parseOrphanLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") {
    return ORPHAN_LIMIT_DEFAULT;
  }
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > ORPHAN_LIMIT_MAX) {
    return null;
  }
  return parsed;
}

// Surfaces core.learning_log — the canonical learning-aggregator patterns and
// authoritative pattern feed. List = last-7-day window (discovered_date DESC) so
// only recent patterns show; total + status × tier rollup stay table-wide for the
// KPI cards. Read-only — monitor matches system.
async function handleLearningLog(
  request: FastifyRequest<{ Querystring: OrphanQuerystring }>,
  reply: FastifyReply,
): Promise<ImprovementLearningLogResponse | ImprovementErrorBody> {
  const start = Date.now();

  const limit = parseOrphanLimit(request.query.limit);
  if (limit === null) {
    return reply.code(400).send(invalidParam("limit"));
  }

  const prisma = getPrisma();
  try {
    // T10 — registry-membership gate (columnRef default `agent`) applied
    // CONSISTENTLY across total + status-distribution + list, so the KPI totals
    // agree with the registry-scoped list (a list-only gate would leave
    // total_patterns counting noise while the list shows registry-only). NULL-agent
    // learning_log rows are correctly excluded (a NULL-agent pattern is not a
    // registry agent). Fail-open: an empty registry skips the predicate (never
    // emit a bare WHERE / invalid IN ()).
    const canonicalKeys = await loadCanonicalAgentKeys();
    const agentFragment = buildAgentMembershipFragment(canonicalKeys);
    // No-WHERE queries (total + status-dist) → bare fragment prefixed with their
    // own WHERE, omitted entirely on an empty registry.
    const agentWhere = toBareWhere(agentFragment);
    // The list query already carries a WHERE (discovered_date window) → append the
    // AND-prefixed form to it.
    const agentAndFilter = buildAgentMembershipFilter(canonicalKeys);

    const [totalRows, statusRows, patternRows] = await Promise.all([
      prisma.$queryRaw<BigintRow[]>`
        SELECT COUNT(*)::bigint AS total FROM core.learning_log ${agentWhere}
      `,
      prisma.$queryRaw<LearningLogStatusDbRow[]>`
        SELECT status::text AS status, approval_tier::text AS approval_tier, COUNT(*)::bigint AS count
        FROM core.learning_log
        ${agentWhere}
        GROUP BY status, approval_tier
        ORDER BY count DESC
      `,
      prisma.$queryRaw<LearningLogDbRow[]>`
        SELECT id, pattern_signature, frequency, agent,
               status::text AS status, approval_tier::text AS approval_tier,
               discovered_date, last_updated, last_transition_at, last_transition_reason
        FROM core.learning_log
        WHERE discovered_date >= CURRENT_DATE - 7
          ${agentAndFilter}
        ORDER BY discovered_date DESC NULLS LAST, last_updated DESC, id DESC
        LIMIT ${limit}
      `,
    ]);

    const totalRow = totalRows[0];
    const patterns = patternRows.map(rowToLearningLogSummary);
    const payload: ImprovementLearningLogResponse = {
      fetched_at: new Date().toISOString(),
      total_patterns: totalRow === undefined ? 0 : bigintToNumber(totalRow.total),
      returned: patterns.length,
      status_distribution: statusRows.map(rowToLearningLogStatusBucket),
      patterns,
    };

    request.log.info(
      { route: "/api/improvement/learning-log", durationMs: Date.now() - start },
      "improvement learning-log query complete",
    );
    return payload;
  } catch (error) {
    return failWithDb(request, reply, "/api/improvement/learning-log", error);
  }
}

// GET /api/improvement/loop-events

// Surfaces core.autoagent_loop_events — the per-cycle stage event stream.
// Recent events (event_ts DESC) + table-wide eval_result distribution + latest
// event timestamp.
async function handleLoopEvents(
  request: FastifyRequest<{ Querystring: OrphanQuerystring }>,
  reply: FastifyReply,
): Promise<ImprovementLoopEventsResponse | ImprovementErrorBody> {
  const start = Date.now();

  const limit = parseOrphanLimit(request.query.limit);
  if (limit === null) {
    return reply.code(400).send(invalidParam("limit"));
  }

  const prisma = getPrisma();
  try {
    // T10 — registry-membership gate (columnRef default `agent`). All three
    // loop-events queries are no-WHERE, so the bare fragment is prefixed with its
    // own WHERE (omitted on an empty registry — fail-open). Gated consistently
    // (agg + result-distribution + event-list) so the KPI totals agree with the
    // registry-scoped event list. AutoagentLoopEvent.agent is NOT NULL.
    const canonicalKeys = await loadCanonicalAgentKeys();
    const agentFragment = buildAgentMembershipFragment(canonicalKeys);
    const agentWhere = toBareWhere(agentFragment);

    const [aggRows, resultRows, eventRows] = await Promise.all([
      prisma.$queryRaw<LoopEventAggDbRow[]>`
        SELECT COUNT(*)::bigint AS total, MAX(event_ts) AS latest_event_ts
        FROM core.autoagent_loop_events
        ${agentWhere}
      `,
      prisma.$queryRaw<LoopEventResultDbRow[]>`
        SELECT eval_result, COUNT(*)::bigint AS count
        FROM core.autoagent_loop_events
        ${agentWhere}
        GROUP BY eval_result
        ORDER BY count DESC
      `,
      // rice (Decimal) cast ::float8 → plain number | null on the raw map.
      prisma.$queryRaw<LoopEventDbRow[]>`
        SELECT id, event_ts, agent, rice::float8 AS rice, eval_result, changes_added, changes_removed
        FROM core.autoagent_loop_events
        ${agentWhere}
        ORDER BY event_ts DESC
        LIMIT ${limit}
      `,
    ]);

    const aggRow = aggRows[0];
    const events = eventRows.map(rowToLoopEventSummary);
    const payload: ImprovementLoopEventsResponse = {
      fetched_at: new Date().toISOString(),
      total_events: aggRow === undefined ? 0 : bigintToNumber(aggRow.total),
      returned: events.length,
      result_distribution: resultRows.map(rowToLoopEventResultBucket),
      latest_event_ts: aggRow === undefined || aggRow.latest_event_ts === null
        ? null
        : aggRow.latest_event_ts.toISOString(),
      events,
    };

    request.log.info(
      { route: "/api/improvement/loop-events", durationMs: Date.now() - start },
      "improvement loop-events query complete",
    );
    return payload;
  } catch (error) {
    return failWithDb(request, reply, "/api/improvement/loop-events", error);
  }
}

// POST /api/improvement/:id/approve

// Resolves the daemon-apply.sh path. The script flips status itself (single SoT
// — the route does NOT double-write on apply). Path defaults to the fixed
// user-home autoagent dir — never taken from request input, so this execFile is
// not a shell-injection / SSRF surface. The AUTOAGENT_APPLY_SCRIPT env override
// is a server-startup testing seam — process-env, never request-derived.
function resolveApplyScript(): string {
  const override = process.env.AUTOAGENT_APPLY_SCRIPT;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return path.join(homedir(), ".claude", "autoagent", "daemon-apply.sh");
}

// daemon-apply.sh --proposal-id --auto-regen exit-code contract:
//   0  = applied (direct — diff landed, no regen needed; status flipped by script)
//   8  = no-op / not actionable (id not found OR status not pending/snoozed)
//   9  = apply failed without auto-regen (won't occur on this route — we always
//        pass --auto-regen — but kept as a defensive fallback branch)
//   10 = applied-after-regen (stale diff → regenerated + pre-verify passed →
//        re-applied + committed; status flipped by script)
//   11 = regen-still-failed (regenerated but the NEW diff still would not land;
//        row left pending)
//   12 = already-applied (change already present in the file → row marked
//        applied, no new commit)
//   13 = regen-invalid (regenerated but 4-axis pre-verify failed; row left
//        pending; failing axes on stderr — "axes: C1=..,C2=..,C3=..,C4=..")
//   14 = regen-unrecoverable (no landable diff could be produced; row left pending)
//   2 = bad arg · 3 = no psql · 6 = DB update failed (infra-class failures)
const APPLY_EXIT_APPLIED = 0;
const APPLY_EXIT_NOOP = 8;
const APPLY_EXIT_FAILED = 9;
const APPLY_EXIT_APPLIED_AFTER_REGEN = 10;
const APPLY_EXIT_REGEN_FAILED = 11;
const APPLY_EXIT_ALREADY_APPLIED = 12;
const APPLY_EXIT_REGEN_INVALID = 13;
const APPLY_EXIT_REGEN_UNRECOVERABLE = 14;

// SECURITY (LLM06 — Excessive Agency / human-in-the-loop): approve mutates the
// agent .md files via daemon-apply.sh. High-impact, but (1) gated behind an
// explicit user button-click in the local 127.0.0.1 monitor UI (the click IS the
// human-in-the-loop decision), and (2) recoverable — daemon-apply is git-free, so
// BEFORE applying it captures a per-proposal before-image copy of each touched
// file under agents-bak/<cycle_date>_p<id>; an unwanted apply is rolled back by
// restoring that snapshot via POST :id/restore (handleRestore →
// scripts/update.sh --restore-agents), within the 14-day retention window. The DB
// holds only the forward proposedDiff (no before-image bytes), so a VCS-based
// rollback is unavailable — the agents-bak before-image is the sole recovery
// anchor. The script bypasses the auto-tier + pre_verify gates precisely because
// the user explicitly approved. `id` is validated to a positive integer before it
// reaches execFile, and the script path is a fixed home-dir constant — no
// request-derived shell input.
async function handleApprove(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<ApproveProposalResponse | ImprovementMutationErrorBody> {
  const start = Date.now();
  const id = parseIdParam(request.params.id);
  if (id === null) {
    reply.code(400);
    return { status: "invalid_param", param: "id" };
  }

  // execFile (not exec) — argv array, no shell interpolation. The proposal id is
  // passed as a discrete argv element, so even a hypothetical non-integer could
  // not break out into a shell command (defense-in-depth atop the int guard).
  // --auto-regen: on a stale stored diff the script regenerates + pre-verifies +
  // re-applies inline instead of dead-ending at exit 9, so the user is never left
  // stuck on a 422 needs_regen — see the exit 10-14 branches.
  let exitCode: number;
  let stderr: string;
  try {
    await execFileAsync(resolveApplyScript(), ["--proposal-id", String(id), "--auto-regen"]);
    // Resolved promise → exit 0.
    exitCode = APPLY_EXIT_APPLIED;
    stderr = "";
  } catch (error) {
    const parsed = parseExecFileError(error);
    exitCode = parsed.code;
    stderr = parsed.stderr;
  }

  // Loud-fail logging — never swallow the exit code / stderr. info on the
  // actionable branches, error on the infra-class failures so a 500 is observable
  // in the daemon log.
  const logBase = { route: "/api/improvement/:id/approve", id, exitCode, durationMs: Date.now() - start };

  if (exitCode === APPLY_EXIT_APPLIED) {
    request.log.info(logBase, "proposal approved + applied via daemon-apply --proposal-id");
    return { id, status: "applied" };
  }
  if (exitCode === APPLY_EXIT_APPLIED_AFTER_REGEN) {
    // Stored diff was stale → regenerated, 4-axis pre-verify passed, new diff
    // landed + committed. Same 200 `applied` surface, flagged `regenerated`.
    request.log.info(logBase, "proposal approved + applied AFTER auto-regen via daemon-apply --auto-regen");
    return { id, status: "applied", regenerated: true };
  }
  if (exitCode === APPLY_EXIT_ALREADY_APPLIED) {
    // Change already present in the file (no diff to apply) → row marked applied
    // without a new commit. 200 `applied`, flagged `already_applied`.
    request.log.info(logBase, "proposal already applied in-file — row marked applied, no new commit");
    return { id, status: "applied", already_applied: true };
  }
  if (exitCode === APPLY_EXIT_NOOP) {
    // Idempotent no-op: id absent OR already terminal/approved — nothing changed.
    request.log.warn({ ...logBase, stderr }, "approve no-op (id not found or already terminal)");
    reply.code(409);
    return {
      status: "noop",
      id,
      reason: "proposal not found or not in an actionable (pending/snoozed) state",
    };
  }
  if (exitCode === APPLY_EXIT_FAILED) {
    // Defensive fallback: with --auto-regen the stale path no longer emits exit 9
    // (it routes through 10-14). Reaching here means an unexpected exit-9 — row
    // left pending. 422 = request well-formed but cannot be fulfilled.
    request.log.warn({ ...logBase, stderr }, "approve apply failed (diff rejected — needs regen)");
    reply.code(422);
    return { status: "apply_failed", id, reason: "needs_regen" };
  }
  if (exitCode === APPLY_EXIT_REGEN_FAILED) {
    // Diff was regenerated but the NEW diff still would not land → row left
    // pending. Distinct from a pre-verify failure — the regen produced a
    // syntactically-valid patch that the file state still rejected.
    request.log.warn(
      { ...logBase, stderr },
      "approve regen failed (regenerated diff still would not land — row left pending)",
    );
    reply.code(422);
    return {
      status: "regen_failed",
      id,
      reason: "regenerated diff still could not be applied",
    };
  }
  if (exitCode === APPLY_EXIT_REGEN_INVALID) {
    // Diff was regenerated but the 4-axis pre-verify failed → row left pending.
    // Surface the failing C1-C4 axes when the daemon's loud-fail stderr line
    // carries them (omit `axes` entirely if not parseable).
    const axes = parsePreVerifyAxes(stderr);
    request.log.warn(
      { ...logBase, stderr, axes },
      "approve regen invalid (pre-verify failed — row left pending)",
    );
    reply.code(422);
    return axes
      ? { status: "regen_invalid", id, reason: "pre-verify failed", axes }
      : { status: "regen_invalid", id, reason: "pre-verify failed" };
  }
  if (exitCode === APPLY_EXIT_REGEN_UNRECOVERABLE) {
    // No landable diff could be regenerated at all → row left pending. Terminal
    // for this approve attempt; the user must revisit the proposal.
    request.log.warn(
      { ...logBase, stderr },
      "approve unrecoverable (no applyable diff could be regenerated — row left pending)",
    );
    reply.code(422);
    return {
      status: "unrecoverable",
      id,
      reason: "no applyable diff could be regenerated",
    };
  }

  // Infra-class failure (exit 2 bad-arg / 3 no-psql / 6 DB-update-fail / other).
  // The status was NOT flipped — surface the cause and let the user retry.
  request.log.error(
    { ...logBase, stderr },
    "approve failed — daemon-apply infra error (status NOT flipped)",
  );
  reply.code(500);
  return {
    status: "apply_error",
    id,
    reason: `daemon-apply exited ${exitCode}: ${truncateStderr(stderr)}`,
  };
}

// POST /api/improvement/:id/reject

// Sole writer of status='rejected' on core.autoagent_proposals. Low-risk:
// status-only transition, no file mutation. Idempotent — a re-call on an
// already-terminal proposal matches 0 rows → 409.
//
// EPM-feed note: no code path feeds proposals.status='rejected' into the
// learning-log EPM (Error-Pattern Memory) bucket. EPM is sourced exclusively
// from core.outcomes (revision_count >= 2 OR result='fail' — see the GET
// /api/improvement EPM query). The only reader of proposals.status='rejected' is
// the stats endpoint's `rejected_last_7d` counter; daemon_cycle.py reads
// autoagent_proposals only for status='pending'. So the EPM aggregation from
// rejected proposals is a follow-up — this endpoint only reaches the terminal
// status.
async function handleReject(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<RejectProposalResponse | ImprovementMutationErrorBody> {
  const start = Date.now();
  const id = parseIdParam(request.params.id);
  if (id === null) {
    reply.code(400);
    return { status: "invalid_param", param: "id" };
  }

  const prisma = getPrisma();
  // UPDATE ... RETURNING — the returned row count IS the idempotency gate:
  //   - 1 row  → transitioned pending/snoozed → rejected (200).
  //   - 0 rows → predicate matched nothing = already terminal/approved (409).
  // reviewed_by stamped 'monitor-user' — local single-user trust boundary (no
  // auth layer, 127.0.0.1 only).
  interface RejectedRow {
    id: bigint;
    reviewed_at: Date;
  }
  let rows: RejectedRow[];
  try {
    rows = await prisma.$queryRaw<RejectedRow[]>`
      UPDATE core.autoagent_proposals
      SET status = 'rejected'::core."ProposalStatus",
          reviewed_at = NOW(),
          reviewed_by = 'monitor-user'
      WHERE id = ${BigInt(id)}
        AND status IN ('pending'::core."ProposalStatus", 'snoozed'::core."ProposalStatus")
      RETURNING id, reviewed_at
    `;
  } catch (error) {
    return failWithDbMutation(request, reply, "/api/improvement/:id/reject", id, error);
  }

  const row = rows[0];
  if (row === undefined) {
    // 0 rows — already applied/rejected/approved (terminal) → idempotent no-op.
    request.log.warn(
      { route: "/api/improvement/:id/reject", id, durationMs: Date.now() - start },
      "reject no-op (proposal already terminal)",
    );
    reply.code(409);
    return {
      status: "already_terminal",
      id,
      reason: "proposal already terminal (applied/rejected/approved) — not actionable",
    };
  }

  request.log.info(
    { route: "/api/improvement/:id/reject", id, durationMs: Date.now() - start },
    "proposal rejected (status='rejected' + reviewed_by stamped)",
  );
  return { id, status: "rejected", reviewed_at: row.reviewed_at.toISOString() };
}

// POST /api/improvement/:id/restore

// Resolves scripts/update.sh — P3-T2's git-free recovery entry point. Its
// --restore-agents <cycle-id> mode rolls the touched agent .md files back from the
// agents-bak before-image, and acquires the shared pause + .apply-lock itself, so
// this route does NOT double-lock (weakening the serialization invariant). Fixed
// home-dir install path — never request-derived, so this execFile is not a
// shell-injection / SSRF surface. ATRIUM_UPDATE_SCRIPT is a server-startup testing
// seam (process-env, never request-derived), mirroring resolveApplyScript's
// AUTOAGENT_APPLY_SCRIPT.
function resolveRestoreScript(): string {
  const override = process.env.ATRIUM_UPDATE_SCRIPT;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return path.join(homedir(), ".glass-atrium", "scripts", "update.sh");
}

// scripts/update.sh --restore-agents <cycle-id> exit-code contract (P3-T2):
//   0  = restored (touched agent .md files rolled back from the before-image)
//   10 = restore failed — no agents-bak snapshot for the cycle-id (pruned past the
//        14-day retention window OR the proposal never landed via the git-free
//        transaction) OR a per-file write failure; update.sh loud-fails the reason.
//   2 (bad arg — the route always passes a cycle-id) / other (lock held / no
//        python3 / spawn ENOENT) fold into the infra-class default → 500.
const RESTORE_EXIT_OK = 0;
const RESTORE_EXIT_FAILED = 10;

// Restore (200) — the applied proposal's touched agent .md files rolled back from
// its agents-bak before-image snapshot (git-free recovery; see the SECURITY note
// above handleApprove).
interface RestoreProposalResponse {
  id: number;
  status: "restored";
  cycle_id: string; // the agents-bak <cycle_date>_p<id> snapshot restored from
}

// Restore-specific mutation errors. The invalid_param (400) + internal (500) DB
// failure cases reuse the shared ImprovementMutationErrorBody discriminator; the
// rest stay local rather than widening the approve/reject union in
// types/improvement.ts (not this route file's concern).
type RestoreErrorBody =
  | { status: "not_found"; id: number }
  | { status: "not_restorable"; id: number; reason: string }
  | { status: "restore_failed"; id: number; reason: string }
  | { status: "restore_error"; id: number; reason: string };

interface ProposalRestoreRow {
  status: string;
  cycle_id: string;
}

// The recovery net the approve SECURITY note promises: undo an applied proposal by
// restoring the before-image snapshot daemon-apply captured under
// agents-bak/<cycle_date>_p<id>. Only an 'applied' proposal has a snapshot, so the
// route gates on status before shelling out. The cycle-id is built server-side
// from the validated integer id + the row's DB-rendered cycle_date (never request
// text) and passed as a discrete execFile argv element — no shell, no
// request-derived path.
async function handleRestore(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<RestoreProposalResponse | ImprovementMutationErrorBody | RestoreErrorBody> {
  const start = Date.now();
  const id = parseIdParam(request.params.id);
  if (id === null) {
    reply.code(400);
    return { status: "invalid_param", param: "id" };
  }

  const prisma = getPrisma();
  // Derive the agents-bak cycle-id (<cycle_date>_p<id>) directly in SQL, matching
  // daemon-apply.sh's `${patch_cycle}_p${patch_id}` sink naming. to_char pins the
  // date text to the psql rendering the daemon used (no JS-side TZ drift).
  let rows: ProposalRestoreRow[];
  try {
    rows = await prisma.$queryRaw<ProposalRestoreRow[]>`
      SELECT status::text AS status,
             to_char(cycle_date, 'YYYY-MM-DD') || '_p' || id::text AS cycle_id
      FROM core.autoagent_proposals
      WHERE id = ${BigInt(id)}
    `;
  } catch (error) {
    return failWithDbMutation(request, reply, "/api/improvement/:id/restore", id, error);
  }

  const row = rows[0];
  const logBase = { route: "/api/improvement/:id/restore", id, durationMs: Date.now() - start };
  if (row === undefined) {
    request.log.warn(logBase, "restore no-op (proposal id not found)");
    reply.code(404);
    return { status: "not_found", id };
  }
  if (row.status !== "applied") {
    // Only an applied proposal has a captured before-image: pending/snoozed never
    // touched a file, rejected/approved never landed a diff → nothing to roll back.
    request.log.warn(
      { ...logBase, status: row.status },
      "restore no-op (proposal not applied — no before-image)",
    );
    reply.code(409);
    return {
      status: "not_restorable",
      id,
      reason: `proposal status '${row.status}' has no agents-bak before-image (only 'applied' is restorable)`,
    };
  }

  const cycleId = row.cycle_id;
  let exitCode: number;
  let stderr: string;
  try {
    // execFile (not exec) — argv array, no shell interpolation. cycleId is a
    // server-derived <date>_p<int> token; update.sh independently rejects path
    // separators in it (defense-in-depth atop the int + DB-date derivation).
    await execFileAsync(resolveRestoreScript(), ["--restore-agents", cycleId]);
    exitCode = RESTORE_EXIT_OK;
    stderr = "";
  } catch (error) {
    const parsed = parseExecFileError(error);
    exitCode = parsed.code;
    stderr = parsed.stderr;
  }

  if (exitCode === RESTORE_EXIT_OK) {
    request.log.info({ ...logBase, cycleId }, "proposal restored from agents-bak before-image");
    return { id, status: "restored", cycle_id: cycleId };
  }
  if (exitCode === RESTORE_EXIT_FAILED) {
    // No snapshot (pruned past retention / never applied via the txn) OR a per-file
    // write failure — update.sh already loud-failed the specific reason to stderr.
    request.log.warn(
      { ...logBase, cycleId, stderr },
      "restore failed (no before-image snapshot or write failure)",
    );
    reply.code(422);
    return {
      status: "restore_failed",
      id,
      reason: `no restorable before-image for cycle-id ${cycleId}: ${truncateStderr(stderr)}`,
    };
  }

  // Infra-class failure (exit 2 bad-arg / lock held / missing python3 / spawn
  // ENOENT). Nothing was restored — surface the cause and let the user retry.
  request.log.error(
    { ...logBase, cycleId, exitCode, stderr },
    "restore failed — update.sh infra error (nothing restored)",
  );
  reply.code(500);
  return {
    status: "restore_error",
    id,
    reason: `update.sh --restore-agents exited ${exitCode}: ${truncateStderr(stderr)}`,
  };
}

interface ParsedImprovementQuery {
  limit: number;
  windowDays: number;
  tier: ImprovementTier | null;
  agent: string | null;
}

type ParseResult =
  | { kind: "ok"; value: ParsedImprovementQuery }
  | { kind: "error"; body: ImprovementErrorBody };

// Object.keys(q) reflects the ACTUAL keys Fastify parsed off the wire,
// regardless of the ImprovementQuerystring TS shape (which only documents the
// known/accepted subset) — so this correctly catches a key the type never
// declared.
function findUnknownQueryKey(q: ImprovementQuerystring): string | null {
  for (const key of Object.keys(q)) {
    if (!IMPROVEMENT_QUERY_KEYS.has(key)) {
      return key;
    }
  }
  return null;
}

function parseImprovementQuery(q: ImprovementQuerystring): ParseResult {
  const unknownKey = findUnknownQueryKey(q);
  if (unknownKey !== null) {
    return { kind: "error", body: invalidParam(unknownKey) };
  }
  const limit = parseLimit(q.limit);
  if (limit === null) {
    return { kind: "error", body: invalidParam("limit") };
  }
  const windowDays = parseWindow(q.window);
  if (windowDays === null) {
    return { kind: "error", body: invalidParam("window") };
  }
  const tierRaw = q.tier;
  let tier: ImprovementTier | null = null;
  if (tierRaw !== undefined && tierRaw !== "") {
    if (!ALLOWED_TIERS.has(tierRaw as ImprovementTier)) {
      return {
        kind: "error",
        body: {
          error: "invalid_param",
          param: "tier",
          allowed: Array.from(ALLOWED_TIERS),
        },
      };
    }
    tier = tierRaw as ImprovementTier;
  }
  const agentRaw = q.agent;
  const agent =
    typeof agentRaw === "string" && agentRaw.length > 0 ? agentRaw : null;

  return { kind: "ok", value: { limit, windowDays, tier, agent } };
}

function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") {
    return LIMIT_DEFAULT;
  }
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > LIMIT_MAX) {
    return null;
  }
  return parsed;
}

// `window` query param accepts either bare integer ("30") or trailing-`d`
// form ("30d") for ergonomics. Out-of-range values yield null.
function parseWindow(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") {
    return WINDOW_DAYS_DEFAULT;
  }
  const normalized = raw.endsWith("d") ? raw.slice(0, -1) : raw;
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed < WINDOW_DAYS_MIN || parsed > WINDOW_DAYS_MAX) {
    return null;
  }
  return parsed;
}

// Pushes the target_agent registry-membership fragment onto `fragments` only
// when non-empty (fail-open — an empty registry never contributes a stray
// predicate). Shared by buildProposalWhere/buildActionableProposalWhere,
// whose T8 gate was previously duplicated verbatim at each call site.
function pushMembershipFragment(
  fragments: Prisma.Sql[],
  canonicalKeys: ReadonlyArray<string>,
  columnRef: Prisma.Sql = Prisma.sql`target_agent`,
): void {
  const membership = buildAgentMembershipFragment(canonicalKeys, columnRef);
  if (membership !== Prisma.empty) {
    fragments.push(membership);
  }
}

// Turns a bare membership fragment into a full WHERE clause, or a no-op when
// the fragment is empty (fail-open on an empty registry — never emit a bare
// `WHERE`). Shared by the no-WHERE-base queries (handleImprovementStats,
// handleLearningLog, handleLoopEvents), whose ternary was previously
// duplicated verbatim at each call site.
function toBareWhere(fragment: Prisma.Sql): Prisma.Sql {
  return fragment === Prisma.empty ? Prisma.empty : Prisma.sql`WHERE ${fragment}`;
}

function buildProposalWhere(
  windowDays: number,
  tier: ImprovementTier | null,
  agent: string | null,
  canonicalKeys: ReadonlyArray<string>,
): Prisma.Sql {
  // PG INTERVAL bind via Prisma — windowDays is integer-validated, so the
  // multiplication is parameter-safe.
  const fragments: Prisma.Sql[] = [
    Prisma.sql`cycle_date >= CURRENT_DATE - (${windowDays}::int * INTERVAL '1 day')`,
  ];
  // T8 — registry-membership gate on target_agent. Display SoT is
  // loadAgentRegistry() (agent-registry.json), NOT the daemon's fail-open
  // _agent_roster glob; the monitor deliberately uses the registry as the display
  // source of truth regardless of upstream roster divergence. Bare fragment
  // (this builder ends in Prisma.join(fragments, " AND ", "WHERE ") — an
  // AND-prefixed form would inject a stray leading AND). Fail-open: an empty
  // registry yields Prisma.empty → the predicate is skipped (never emit IN ()).
  pushMembershipFragment(fragments, canonicalKeys);
  if (tier === "auto") {
    fragments.push(Prisma.sql`approval_tier = 'auto'::core."ApprovalTier"`);
  } else if (tier === "safety") {
    // 'user' + 'user-pending' + legacy 'llm' fold into the 'safety' public
    // bucket — filter set MUST match foldTierCounts so a legacy 'llm' row is not
    // counted in the safety badge yet dropped by the safety filter (orphan).
    fragments.push(
      Prisma.sql`approval_tier IN ('user'::core."ApprovalTier", 'user-pending'::core."ApprovalTier", 'llm'::core."ApprovalTier")`,
    );
  }
  if (agent !== null) {
    fragments.push(Prisma.sql`target_agent = ${agent}`);
  }
  return Prisma.join(fragments, " AND ", "WHERE ");
}

// Actionable feed WHERE — status ∈ {pending, snoozed} AND safety-tier ONLY.
// Auto-tier is fully terminal by construction: an apply-ineligible auto candidate
// is rewritten to a terminal reject at generation
// (daemon_cycle.py resolve_floor_terminalization), so an auto row can never sit
// pending → the former auto+pending "New suggestions" limbo no longer exists. The
// feed therefore serves the single human-approval column (Awaiting approval) and
// is hard-gated to the 3-value safety set so a legacy stuck auto row could never
// resurface in a feed whose only consumer is the safety column. The `tier` param
// no longer routes this feed (auto has no actionable surface); only `agent`
// filters, preserving FE drill-down consistency with `proposals`. No recency
// window, so actionable rows surface regardless of age.
function buildActionableProposalWhere(
  agent: string | null,
  canonicalKeys: ReadonlyArray<string>,
): Prisma.Sql {
  const fragments: Prisma.Sql[] = [
    Prisma.sql`status IN ('pending'::core."ProposalStatus", 'snoozed'::core."ProposalStatus")`,
    // 'user' + 'user-pending' + legacy 'llm' fold into the 'safety' public bucket
    // (mirrors buildProposalWhere + foldTierCounts — same 3-value safety filter set).
    Prisma.sql`approval_tier IN ('user'::core."ApprovalTier", 'user-pending'::core."ApprovalTier", 'llm'::core."ApprovalTier")`,
  ];
  // T8 — same target_agent registry gate as buildProposalWhere (display SoT =
  // loadAgentRegistry(), not the daemon _agent_roster). Bare fragment, fail-open
  // on an empty registry.
  pushMembershipFragment(fragments, canonicalKeys);
  if (agent !== null) {
    fragments.push(Prisma.sql`target_agent = ${agent}`);
  }
  return Prisma.join(fragments, " AND ", "WHERE ");
}

function buildOutcomeWhere(
  windowDays: number,
  agent: string | null,
  canonicalKeys: ReadonlyArray<string> = [],
): Prisma.Sql {
  const fragments: Prisma.Sql[] = [
    Prisma.sql`record_ts > NOW() - (${windowDays}::int * INTERVAL '1 day')`,
    // Rows flagged poisoned_window carry unreliable learning signal — excluded
    // always-on from every outcome aggregate this builder feeds (same exclusion
    // contract as the Python read_outcomes_since chokepoint in
    // hooks/_pg_learning_dualwrite.py).
    Prisma.sql`poisoned_window = FALSE`,
  ];
  // T8/T9/T10 registry-membership gate, brought in-builder (mirrors
  // buildProposalWhere/buildActionableProposalWhere) — replaces the external
  // buildAgentMembershipFilter concatenation previously bolted on at the
  // outcomeWhere call site only, and now applies uniformly to every caller.
  pushMembershipFragment(fragments, canonicalKeys, Prisma.sql`agent`);
  if (agent !== null) {
    fragments.push(Prisma.sql`agent = ${agent}`);
  }
  return Prisma.join(fragments, " AND ", "WHERE ");
}

// Folds the 4-value DB ApprovalTier into the 2-value public ImprovementTier:
//   'auto'                          → 'auto'
//   'user' / 'user-pending' / 'llm' → 'safety'
// ('llm' is frozen/legacy — see file header. The safety tier filters apply the
//  same 3-value safety set so count and filter never diverge.)
function foldTierCounts(rows: TierCountDbRow[]): ImprovementTierDistribution {
  const out: ImprovementTierDistribution = { auto: 0, safety: 0 };
  for (const row of rows) {
    const count = bigintToNumber(row.count);
    if (row.approval_tier === "auto") {
      out.auto += count;
    } else {
      // user / user-pending / llm — all routed to safety bucket.
      out.safety += count;
    }
  }
  return out;
}

function foldMetricCounts(rows: MetricCountDbRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of TASK_TYPES) {
    out[key] = 0;
  }
  for (const row of rows) {
    out[row.metric_type] = bigintToNumber(row.count);
  }
  return out;
}

function foldResultCounts(rows: ResultCountDbRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of RESULT_KEYS) {
    out[key] = 0;
  }
  for (const row of rows) {
    out[row.result] = bigintToNumber(row.count);
  }
  return out;
}

interface FoldedOutcomeAgg {
  totalRecords: number;
  byMetric: Record<string, number>;
  byResult: Record<string, number>;
  reviewFlagCount: number;
  ctmCount: number;
  epmCount: number;
}

// Demultiplexes the single GROUPING SETS scan back into the six former buckets.
// Each row carries a GROUPING() flag pair identifying its grouping set:
//   grp_metric=1 & grp_result=1 → grand-total () row: the only row whose scalar
//     FILTER columns (total/review_flag/ctm/epm) are meaningful.
//   grp_metric=0                → per-task_type row → feeds foldMetricCounts.
//   grp_result=0                → per-result row    → feeds foldResultCounts.
// foldMetricCounts/foldResultCounts are reused verbatim so the zero-init skeleton
// + overwrite semantics stay byte-identical to the pre-collapse response. An empty
// PG result (the GROUPING SETS () set always returns ≥1 row, but the defensive
// `undefined` path mirrors the former rows[0] guards) folds to all-zero buckets.
function foldOutcomeAgg(rows: OutcomeAggDbRow[]): FoldedOutcomeAgg {
  const metricRows: MetricCountDbRow[] = [];
  const resultRows: ResultCountDbRow[] = [];
  let grandTotal: OutcomeAggDbRow | undefined;

  for (const row of rows) {
    if (row.grp_metric === 1 && row.grp_result === 1) {
      grandTotal = row;
    } else if (row.grp_metric === 0 && row.metric_type !== null) {
      metricRows.push({ metric_type: row.metric_type, count: row.total });
    } else if (row.grp_result === 0 && row.result !== null) {
      resultRows.push({ result: row.result, count: row.total });
    }
  }

  return {
    totalRecords: grandTotal === undefined ? 0 : bigintToNumber(grandTotal.total),
    byMetric: foldMetricCounts(metricRows),
    byResult: foldResultCounts(resultRows),
    reviewFlagCount: grandTotal === undefined ? 0 : bigintToNumber(grandTotal.review_flag_count),
    ctmCount: grandTotal === undefined ? 0 : bigintToNumber(grandTotal.ctm_count),
    epmCount: grandTotal === undefined ? 0 : bigintToNumber(grandTotal.epm_count),
  };
}

// 3-Tier baseline cohort folder — single-row DB result → 4-field response shape.
// Test-visible export (mirrors rowToProposalSummary pattern) for unit testing via
// node:test.
//
// Empty-result fallback: PG always returns 1 row from `SELECT COUNT() FROM ...`
// even when the FROM has 0 matching rows (PG aggregate produces 0-valued row).
// Defensive `rows[0] === undefined` check kept for parity with other folders in
// case the query shape ever changes (DB error, schema mismatch).
export function foldTierBreakdownRow(rows: TierBreakdownDbRow[]): ImprovementTierBreakdown {
  const row = rows[0];
  if (row === undefined) {
    return {
      window_days: TIER_BREAKDOWN_WINDOW_DAYS,
      code_based_pass_30d: 0,
      code_based_fail_30d: 0,
      pre_3tier_baseline_count: 0,
    };
  }
  return {
    window_days: TIER_BREAKDOWN_WINDOW_DAYS,
    code_based_pass_30d: bigintToNumber(row.code_based_pass_30d),
    code_based_fail_30d: bigintToNumber(row.code_based_fail_30d),
    pre_3tier_baseline_count: bigintToNumber(row.pre_3tier_baseline_count),
  };
}

// confidence_observed distribution folder — per-lane DB rows → buckets array +
// cross-lane weighted rollup. Test-visible export (mirrors foldTierBreakdownRow)
// for unit testing via node:test.
//
// Empty-rows path: `[]` (no proposals in window OR F4 column-gap degradation)
// → empty buckets + null overall avg → FE renders its no-data indicator.
//
// Rollup math: cross-lane mean weighted by each lane's row count, computed from
// per-lane (avg × count) sums so it equals the true row-level mean — NOT a naive
// mean-of-means (which would over-weight sparse lanes). Lanes with a NULL avg
// (all-NULL confidence_observed) contribute 0 to both numerator and denominator,
// so they neither inflate nor deflate the rollup.
export function foldConfidenceDistribution(
  rows: ConfidenceTierDbRow[],
  windowDays: number,
): ImprovementConfidenceDistribution {
  const buckets: ImprovementConfidenceTierBucket[] = rows.map((row) => ({
    promotion_tier: row.promotion_tier,
    proposal_count: bigintToNumber(row.proposal_count),
    // PG AVG returns NULL for an all-NULL group — pass through as null.
    confidence_observed_avg:
      row.confidence_observed_avg === null
        ? null
        : roundRate(row.confidence_observed_avg),
  }));

  let weightedSum = 0;
  let weightedCount = 0;
  for (const bucket of buckets) {
    if (bucket.confidence_observed_avg === null) continue;
    weightedSum += bucket.confidence_observed_avg * bucket.proposal_count;
    weightedCount += bucket.proposal_count;
  }

  return {
    window_days: windowDays,
    buckets,
    overall_confidence_observed_avg:
      weightedCount === 0 ? null : roundRate(weightedSum / weightedCount),
  };
}

// style_ref summary builder — folds bigint DB counts into number-typed rates
// with null-safe denominators. Test-visible export (mirrors rowToProposalSummary
// pattern) for unit testing via node:test.
//
// Null-rate semantics (FE renders "—" or "no data yet" instead of "0/0"):
//   - emission_rate null    → no rows for this agent in 7d window
//   - verified_rate null    → no non-greenfield emissions (all 'greenfield' OR
//                              all NULL); verify check structurally N/A
//   - overall_*    null     → no eligible rows ANYWHERE in window (typical
//                              during v1.0 OPTIONAL phase before style_ref columns
//                              are populated)
export function buildStyleRefSummary(
  rows: StyleRefAgentDbRow[],
): ImprovementStyleRefSummary {
  const agents: ImprovementStyleRefAgentRow[] = rows.map(rowToStyleRefAgentSummary);

  // Cross-agent rollup — sum the per-agent counts then divide. Sum order does
  // not matter (all bigint → number conversions are individually MAX_SAFE_INTEGER
  // bounded; row count cap = number of distinct agents in 7d window, ~12 max).
  let emissionCountTotal = 0;
  let emissionTotalTotal = 0;
  let verifiedTrueTotal = 0;
  let verifiedEligibleTotal = 0;
  for (const row of agents) {
    emissionCountTotal += row.emission_count;
    emissionTotalTotal += row.emission_total;
    verifiedTrueTotal += row.verified_true_count;
    verifiedEligibleTotal += row.verified_eligible;
  }

  return {
    window_days: STYLE_REF_WINDOW_DAYS,
    agents,
    overall_emission_rate: safeRatio(emissionCountTotal, emissionTotalTotal),
    overall_verified_rate: safeRatio(verifiedTrueTotal, verifiedEligibleTotal),
  };
}

export function rowToStyleRefAgentSummary(
  row: StyleRefAgentDbRow,
): ImprovementStyleRefAgentRow {
  const emissionCount = bigintToNumber(row.emission_count);
  const emissionTotal = bigintToNumber(row.emission_total);
  const verifiedTrueCount = bigintToNumber(row.verified_true_count);
  const verifiedEligible = bigintToNumber(row.verified_eligible);
  return {
    agent: row.agent,
    emission_count: emissionCount,
    emission_total: emissionTotal,
    emission_rate: safeRatio(emissionCount, emissionTotal),
    verified_true_count: verifiedTrueCount,
    verified_eligible: verifiedEligible,
    verified_rate: safeRatio(verifiedTrueCount, verifiedEligible),
  };
}

// Null-safe ratio — null when denominator = 0 (FE skips render of "0/0" → "—").
function safeRatio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  // 4-decimal precision matches haiku_skipped_rate convention (handleImprovementStats).
  return Number((numerator / denominator).toFixed(4));
}

// 4-decimal rounder for already-computed rates (confidence_observed avgs). Same
// precision convention as safeRatio — kept separate because the value
// is pre-divided (PG AVG / weighted rollup), not a numerator/denominator pair.
function roundRate(value: number): number {
  return Number(value.toFixed(4));
}

// Test-visible export — provenance mapper unit-tested in
// test/improvement.mapper.test.ts.
export function rowToProposalSummary(row: ProposalListDbRow): ImprovementProposalRow {
  return {
    id: bigintToNumber(row.id),
    cycle_date: formatDateOnly(row.cycle_date),
    approval_tier: row.approval_tier === "auto" ? "auto" : "safety",
    status: row.status,
    target_agent: row.target_agent,
    target_file: row.target_file,
    pattern_label: row.pattern_label,
    classification: row.classification,
    haiku_status: row.haiku_status,
    reviewed_at: row.reviewed_at === null ? null : row.reviewed_at.toISOString(),
    cost_guard_state: row.cost_guard_state,
    // Provenance — snake_case PG → camelCase TS. pre_verify_axes preserved as
    // Prisma.JsonValue (no JSON.stringify; FE handles render).
    rationale: row.rationale,
    pre_verify_rationale: row.pre_verify_rationale,
    pre_verify_axes: row.pre_verify_axes,
    pre_verify_status: row.pre_verify_status,
    pre_verify_passed: row.pre_verify_passed,
    // Empirical posterior + partition + lane. Direct pass-through (all NULL
    // until daemon-wiring spawn populates them).
    confidence_observed: row.confidence_observed,
    project_key: row.project_key,
    promotion_tier: row.promotion_tier,
  };
}

function rowToLearningLogSummary(row: LearningLogDbRow): ImprovementLearningLogRow {
  return {
    id: bigintToNumber(row.id),
    pattern_signature: row.pattern_signature,
    frequency: row.frequency,
    agent: row.agent,
    status: row.status,
    approval_tier: row.approval_tier,
    discovered_date: formatDateOnly(row.discovered_date),
    last_updated: row.last_updated.toISOString(),
    last_transition_at: row.last_transition_at === null ? null : row.last_transition_at.toISOString(),
    last_transition_reason: row.last_transition_reason,
  };
}

function rowToLearningLogStatusBucket(
  row: LearningLogStatusDbRow,
): ImprovementLearningLogStatusBucket {
  return {
    status: row.status,
    approval_tier: row.approval_tier,
    count: bigintToNumber(row.count),
  };
}

function rowToLoopEventSummary(row: LoopEventDbRow): ImprovementLoopEventRow {
  return {
    id: bigintToNumber(row.id),
    event_ts: row.event_ts.toISOString(),
    agent: row.agent,
    rice: row.rice,
    eval_result: row.eval_result,
    changes_added: row.changes_added,
    changes_removed: row.changes_removed,
  };
}

function rowToLoopEventResultBucket(
  row: LoopEventResultDbRow,
): ImprovementLoopEventResultBucket {
  return {
    eval_result: row.eval_result,
    count: bigintToNumber(row.count),
  };
}

function bigintToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`bigint ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

// Result of inspecting a rejected execFileAsync promise. `code` is the child
// process exit code; -1 sentinel when the failure was a spawn error (e.g. ENOENT
// — script missing) with no numeric exit code, which we treat as an infra-class
// failure (500) rather than a daemon exit-code branch.
interface ExecFileFailure {
  code: number;
  stderr: string;
}

// Type-safe extraction (unknown + guards, no `any`) of the exit code + stderr
// from a rejected promisified execFile. The rejection reason is an Error
// augmented by child_process with optional `code` (number | string) and
// `stderr` (string | Buffer) fields — neither is on the base Error type, so we
// narrow defensively.
function parseExecFileError(error: unknown): ExecFileFailure {
  if (typeof error !== "object" || error === null) {
    return { code: -1, stderr: String(error) };
  }
  const record = error as Record<string, unknown>;

  let code = -1;
  const rawCode = record.code;
  if (typeof rawCode === "number") {
    code = rawCode;
  } else if (typeof rawCode === "string") {
    // Spawn errors surface a string code (e.g. 'ENOENT'); leave numeric code as
    // the -1 infra sentinel and fold the string into stderr for the log.
    code = -1;
  }

  let stderr = "";
  const rawStderr = record.stderr;
  if (typeof rawStderr === "string") {
    stderr = rawStderr;
  } else if (rawStderr instanceof Buffer) {
    stderr = rawStderr.toString("utf8");
  } else if (typeof record.message === "string") {
    stderr = record.message;
  }
  if (typeof rawCode === "string" && stderr.length === 0) {
    stderr = rawCode;
  }

  return { code, stderr };
}

// Clamp stderr in the user-facing reason so a multi-KB daemon dump does not
// bloat the JSON body. Single-line, trailing whitespace trimmed.
function truncateStderr(stderr: string): string {
  const oneLine = stderr.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine;
}

// Exit-13 axis extraction. daemon-apply.sh emits a loud-fail stderr line
// `... (axes: C1=true,C2=true,C3=false,C4=true)` — parse the C1-C4 booleans out
// of it. Tolerant of casing (jq path → 'true'/'false'; python fallback →
// 'True'/'False') and of any subset of axes being present. Returns undefined
// when no axes pair is found, so the caller omits the `axes` field gracefully.
function parsePreVerifyAxes(stderr: string): PreVerifyAxes | undefined {
  const axes: PreVerifyAxes = {};
  // Match each Cn=<bool> token independently — does not assume all 4 are present
  // or contiguous, so a partial/garbled daemon line still yields what it can.
  const axisPattern = /\bC([1-4])\s*=\s*(true|false)\b/gi;
  for (const match of stderr.matchAll(axisPattern)) {
    const key = `C${match[1]}` as keyof PreVerifyAxes;
    axes[key] = match[2].toLowerCase() === "true";
  }
  return Object.keys(axes).length > 0 ? axes : undefined;
}

// Mutation-side DB failure → 500 with the discriminated mutation-error envelope
// (distinct from failWithDb's GET-side 503 `database_unavailable` body). A reject
// UPDATE failure is a genuine server error, not a transient read outage.
function failWithDbMutation(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  id: number,
  error: unknown,
): ImprovementMutationErrorBody {
  request.log.error({ err: error, route, id }, "improvement mutation query failed");
  reply.code(500);
  return { status: "internal", id };
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function failWithDb(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  error: unknown,
): ImprovementErrorBody {
  return respondDbFailure(request, reply, route, error, "improvement query failed");
}

function invalidParam(param: string): ImprovementErrorBody {
  return { error: "invalid_param", param };
}

// Exposed for tests — reset stats cache between test files.
export function __resetImprovementStatsCacheForTests(): void {
  statsCache = null;
}
