// Unit tests for rowToProposalSummary — DB row → API payload mapper (provenance restore).
// Runner: npx tsx --test test/improvement.mapper.test.ts
// No DB dependency — pure mapper unit test.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildStyleRefChargeableFilter,
  buildStyleRefEligibleFilter,
  buildStyleRefSummary,
  buildGraderCrosscheckSummary,
  foldConfidenceDistribution,
  foldTierBreakdownRow,
  rowToProposalSummary,
} from "../src/server/routes/improvement.js";

// Cross-layer SoT paths — the bash declarations the route's two literal mirrors track,
// plus the registry the third condition is derived from rather than copied.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STYLE_REF_CONSTS_LIB = resolve(REPO_ROOT, "hooks/lib/style-ref-consts.sh");
const REVIEW_FLAG_REASONS_LIB = resolve(REPO_ROOT, "hooks/lib/review-flag-reasons.sh");
const STYLEREF_ROSTER_LIB = resolve(REPO_ROOT, "hooks/lib/styleref-roster.sh");
const AGENT_REGISTRY = resolve(REPO_ROOT, "agent-registry.json");

// Minimal DB row factory — only fields the mapper reads.
// (matches ProposalListDbRow interface in routes/improvement.ts)
function makeRow(overrides: Record<string, unknown> = {}): Parameters<typeof rowToProposalSummary>[0] {
  return {
    id: 42n,
    cycle_date: new Date("2026-05-19T00:00:00.000Z"),
    pattern_label: "test-pattern",
    target_file: "agents/test.md",
    target_agent: "test-agent",
    classification: "apply",
    haiku_status: "ok",
    approval_tier: "auto",
    status: "applied",
    cost_guard_state: null,
    reviewed_at: null,
    rationale: null,
    pre_verify_rationale: null,
    pre_verify_axes: null,
    pre_verify_status: null,
    pre_verify_passed: null,
    // Default all-NULL (current DB state: 25 rows NULL).
    confidence_observed: null,
    project_key: null,
    promotion_tier: null,
    ...overrides,
  } as Parameters<typeof rowToProposalSummary>[0];
}

test("rowToProposalSummary: 5 provenance fields populated → all present on output", () => {
  const row = makeRow({
    rationale: "단일 agent 5+ 발생 — 1줄 변경",
    pre_verify_rationale: "C3 scope 정합 통과",
    pre_verify_axes: { c1: true, c2: true, c3: true, c4: true },
    pre_verify_status: "passed",
    pre_verify_passed: true,
  });
  const out = rowToProposalSummary(row);

  assert.strictEqual(out.rationale, "단일 agent 5+ 발생 — 1줄 변경");
  assert.strictEqual(out.pre_verify_rationale, "C3 scope 정합 통과");
  assert.deepStrictEqual(out.pre_verify_axes, { c1: true, c2: true, c3: true, c4: true });
  assert.strictEqual(out.pre_verify_status, "passed");
  assert.strictEqual(out.pre_verify_passed, true);
});

test("rowToProposalSummary: 5 provenance fields null → null pass-through (no drop)", () => {
  const row = makeRow();
  const out = rowToProposalSummary(row);

  // Keys MUST be present even when null — FE filters on truthiness, not has().
  assert.ok("rationale" in out, "rationale key present");
  assert.ok("pre_verify_rationale" in out, "pre_verify_rationale key present");
  assert.ok("pre_verify_axes" in out, "pre_verify_axes key present");
  assert.ok("pre_verify_status" in out, "pre_verify_status key present");
  assert.ok("pre_verify_passed" in out, "pre_verify_passed key present");

  assert.strictEqual(out.rationale, null);
  assert.strictEqual(out.pre_verify_rationale, null);
  assert.strictEqual(out.pre_verify_axes, null);
  assert.strictEqual(out.pre_verify_status, null);
  assert.strictEqual(out.pre_verify_passed, null);
});

test("rowToProposalSummary: pre_verify_axes preserved as object (no JSON.stringify)", () => {
  // Mapper contract — JSONB pass-through; FE handles render
  // (no premature stringify here, otherwise FE cannot iterate axes).
  const axesObj = { c1: false, c2: true, c3: true, c4: true };
  const row = makeRow({ pre_verify_axes: axesObj });
  const out = rowToProposalSummary(row);

  assert.strictEqual(typeof out.pre_verify_axes, "object", "axes stays object, not string");
  assert.notStrictEqual(out.pre_verify_axes, null);
  assert.deepStrictEqual(out.pre_verify_axes, axesObj);
});

test("rowToProposalSummary: error:* pre_verify_status (budget-wall) preserved verbatim", () => {
  // Error pattern from spec — "error:exit-1: Exceeded USD budget".
  const row = makeRow({
    pre_verify_status: "error:exit-1: Exceeded USD budget",
    pre_verify_passed: false,
  });
  const out = rowToProposalSummary(row);

  assert.strictEqual(out.pre_verify_status, "error:exit-1: Exceeded USD budget");
  assert.strictEqual(out.pre_verify_passed, false);
});

// per-proposal confidence fields.

test("rowToProposalSummary: 3 confidence fields null → null pass-through (current DB state)", () => {
  // All 25 existing rows are NULL — forward-looking until daemon-wiring spawn.
  const row = makeRow();
  const out = rowToProposalSummary(row);

  // Keys MUST be present even when null — FE renders its "not computed" placeholder on null, not crash.
  assert.ok("confidence_observed" in out, "confidence_observed key present");
  assert.ok("project_key" in out, "project_key key present");
  assert.ok("promotion_tier" in out, "promotion_tier key present");

  assert.strictEqual(out.confidence_observed, null);
  assert.strictEqual(out.project_key, null);
  assert.strictEqual(out.promotion_tier, null);
});

test("rowToProposalSummary: 3 confidence fields populated → pass-through (post-wire-in)", () => {
  const row = makeRow({
    confidence_observed: 0.7321,
    project_key: "sample-project",
    promotion_tier: "auto",
  });
  const out = rowToProposalSummary(row);

  assert.strictEqual(out.confidence_observed, 0.7321);
  assert.strictEqual(out.project_key, "sample-project");
  assert.strictEqual(out.promotion_tier, "auto");
});

test("rowToProposalSummary: confidence_observed 0.0 → preserved (not coerced to null)", () => {
  // Boundary: 0.0 is a valid empirical posterior (all-failure pattern), MUST NOT
  // be folded to null (that would mis-render as "not computed" instead of "0%").
  const row = makeRow({ confidence_observed: 0 });
  const out = rowToProposalSummary(row);

  assert.strictEqual(out.confidence_observed, 0, "0.0 stays 0, not null");
});

// pattern_label — pure passthrough invariant (guards G1: the pattern-1 FAIL→SOFT
// decouple lives ENTIRELY in the Python daemon; the TS mapper must add NO relabel
// logic, so whatever pattern_label the DB row carries renders verbatim).

test("rowToProposalSummary: pattern_label SOFT label → verbatim passthrough (no TS relabel)", () => {
  const row = makeRow({ pattern_label: "recurring negative-signal concentration" });
  const out = rowToProposalSummary(row);

  assert.strictEqual(out.pattern_label, "recurring negative-signal concentration");
});

test("rowToProposalSummary: pattern_label FAIL literal → verbatim passthrough (no TS remap injected)", () => {
  // If a TS-side swap were ever (wrongly) added, this stored FAIL literal would be
  // mutated to the SOFT label — assert it is NOT, locking the daemon-side-only fix.
  const row = makeRow({ pattern_label: "repeated failure by same agent" });
  const out = rowToProposalSummary(row);

  assert.strictEqual(out.pattern_label, "repeated failure by same agent");
});

test("rowToProposalSummary: pattern_label KO multi-signal join → verbatim passthrough", () => {
  const label =
    "dev-shell multi-signal consolidation (recurring negative-signal concentration / 반복적 부정 신호 집중)";
  const row = makeRow({ pattern_label: label });
  const out = rowToProposalSummary(row);

  assert.strictEqual(out.pattern_label, label, "join string preserved byte-for-byte");
});

// foldTierBreakdownRow — 3-Tier baseline cohort split mapper.

test("foldTierBreakdownRow: 3 bigint counts → 4-field response (window_days fixed at 30)", () => {
  // Typical post-migration shape — code-based cohort + backfilled baseline.
  const rows = [
    {
      code_based_pass_30d: 120n,
      code_based_fail_30d: 45n,
      pre_3tier_baseline_count: 1223n,
    },
  ];
  const out = foldTierBreakdownRow(rows);

  assert.strictEqual(out.window_days, 30, "window_days hard-coded to TIER_BREAKDOWN_WINDOW_DAYS");
  assert.strictEqual(out.code_based_pass_30d, 120);
  assert.strictEqual(out.code_based_fail_30d, 45);
  assert.strictEqual(out.pre_3tier_baseline_count, 1223);
});

test("foldTierBreakdownRow: empty result array → zero-init fallback (defensive)", () => {
  // PG aggregate SELECT always returns 1 row even on 0 matches, but defensive
  // fallback preserves response shape if query ever changes (DB error / schema mismatch).
  const out = foldTierBreakdownRow([]);

  assert.strictEqual(out.window_days, 30);
  assert.strictEqual(out.code_based_pass_30d, 0);
  assert.strictEqual(out.code_based_fail_30d, 0);
  assert.strictEqual(out.pre_3tier_baseline_count, 0);
});

test("foldTierBreakdownRow: all-zero PG row → all-zero response (empty cohort window)", () => {
  // Pre-wire-in OR truly empty 30d window — distinguished from migration
  // failure at FE layer (totalCnt === 0 → "no data" indicator).
  const rows = [
    {
      code_based_pass_30d: 0n,
      code_based_fail_30d: 0n,
      pre_3tier_baseline_count: 0n,
    },
  ];
  const out = foldTierBreakdownRow(rows);

  assert.strictEqual(out.code_based_pass_30d, 0);
  assert.strictEqual(out.code_based_fail_30d, 0);
  assert.strictEqual(out.pre_3tier_baseline_count, 0);
});

// foldConfidenceDistribution — confidence_observed × promotion_tier distribution mapper.

test("foldConfidenceDistribution: empty rows → empty buckets + null overall (current DB state)", () => {
  // No proposals in window OR column-gap degradation → empty-array input.
  const out = foldConfidenceDistribution([], 30);

  assert.strictEqual(out.window_days, 30, "window_days echoes the passed param");
  assert.deepStrictEqual(out.buckets, [], "empty buckets array");
  assert.strictEqual(out.overall_confidence_observed_avg, null, "null overall → FE 데이터 부재");
});

test("foldConfidenceDistribution: all-NULL avg lanes → buckets present, null avgs (forward-looking)", () => {
  // Current state: 25 rows NULL confidence_observed — PG AVG returns NULL per lane.
  // Buckets still surface (lane labels + counts) but avgs are null → "not computed".
  const rows = [
    { promotion_tier: "unassigned", proposal_count: 25n, confidence_observed_avg: null },
  ];
  const out = foldConfidenceDistribution(rows, 30);

  assert.strictEqual(out.buckets.length, 1);
  assert.strictEqual(out.buckets[0].promotion_tier, "unassigned");
  assert.strictEqual(out.buckets[0].proposal_count, 25);
  assert.strictEqual(out.buckets[0].confidence_observed_avg, null, "all-NULL lane → null avg");
  assert.strictEqual(out.overall_confidence_observed_avg, null, "no populated rows → null rollup");
});

test("foldConfidenceDistribution: mixed lanes → per-lane avgs + row-weighted rollup", () => {
  // 'auto' lane: 10 rows avg 0.80 · 'hold' lane: 5 rows avg 0.50.
  // True row-level mean = (0.80*10 + 0.50*5) / 15 = 10.5/15 = 0.70 (NOT 0.65
  // mean-of-means — weighting matters).
  const rows = [
    { promotion_tier: "auto", proposal_count: 10n, confidence_observed_avg: 0.8 },
    { promotion_tier: "hold", proposal_count: 5n, confidence_observed_avg: 0.5 },
  ];
  const out = foldConfidenceDistribution(rows, 30);

  assert.strictEqual(out.buckets.length, 2);
  assert.strictEqual(out.buckets[0].confidence_observed_avg, 0.8);
  assert.strictEqual(out.buckets[1].confidence_observed_avg, 0.5);
  assert.strictEqual(out.overall_confidence_observed_avg, 0.7, "row-weighted, not mean-of-means");
});

test("foldConfidenceDistribution: NULL-avg lane excluded from rollup (no inflation/deflation)", () => {
  // 'auto': 10 rows avg 0.90 · 'unassigned': 30 rows NULL avg. Rollup MUST be
  // 0.90 (the NULL lane's 30 rows contribute 0 to both numerator + denominator),
  // NOT diluted toward 0 by the larger NULL lane.
  const rows = [
    { promotion_tier: "auto", proposal_count: 10n, confidence_observed_avg: 0.9 },
    { promotion_tier: "unassigned", proposal_count: 30n, confidence_observed_avg: null },
  ];
  const out = foldConfidenceDistribution(rows, 30);

  assert.strictEqual(out.overall_confidence_observed_avg, 0.9, "NULL lane excluded from weighted rollup");
});

test("foldConfidenceDistribution: 4-decimal rounding on rollup", () => {
  // (0.3333*3) / 3 = 0.3333 — verify roundRate 4-decimal precision applied.
  const rows = [
    { promotion_tier: "shadow", proposal_count: 3n, confidence_observed_avg: 0.33333333 },
  ];
  const out = foldConfidenceDistribution(rows, 7);

  assert.strictEqual(out.window_days, 7);
  assert.strictEqual(out.buckets[0].confidence_observed_avg, 0.3333, "per-lane avg 4-decimal rounded");
  assert.strictEqual(out.overall_confidence_observed_avg, 0.3333, "rollup 4-decimal rounded");
});

// ----- buildStyleRefSummary 3-count partition (P13) --------------------------

function styleRow(o: Partial<Record<string, bigint | string>> = {}) {
  return {
    agent: "dev-a",
    emission_count: 0n,
    emission_total: 0n,
    corroborated_count: 0n,
    uncorroborated_count: 0n,
    unverifiable_count: 0n,
    ...o,
  } as Parameters<typeof buildStyleRefSummary>[0][number];
}

test("buildStyleRefSummary: three counted buckets partition the eligible rows", () => {
  // emission=10 → eligible = 4+2+1 = 7, greenfield = 10 - 7 = 3.
  const out = buildStyleRefSummary([
    styleRow({
      emission_count: 10n,
      emission_total: 12n,
      corroborated_count: 4n,
      uncorroborated_count: 2n,
      unverifiable_count: 1n,
    }),
  ]);

  assert.strictEqual(out.overall_corroborated_count, 4);
  assert.strictEqual(out.overall_uncorroborated_count, 2);
  assert.strictEqual(out.overall_unverifiable_count, 1);
  assert.strictEqual(out.overall_eligible_count, 7, "sum of the three buckets");
  assert.strictEqual(out.overall_greenfield_count, 3, "emission - eligible");
});

test("buildStyleRefSummary: unverifiable rows stay OUT of the uncorroborated rate", () => {
  // The regression this cycle exists for: an unadjudicated row must not be counted
  // as one the cross-check examined and failed to corroborate. Both rows below hold
  // corroborated=9 / uncorroborated=1 and differ ONLY in the blind spot, so the rate
  // is identical and the widening is readable from unverifiable_count alone.
  const noBlindSpot = buildStyleRefSummary([
    styleRow({ emission_count: 10n, emission_total: 10n, corroborated_count: 9n, uncorroborated_count: 1n }),
  ]);
  const wideBlindSpot = buildStyleRefSummary([
    styleRow({
      emission_count: 110n,
      emission_total: 110n,
      corroborated_count: 9n,
      uncorroborated_count: 1n,
      unverifiable_count: 100n,
    }),
  ]);

  assert.strictEqual(noBlindSpot.overall_uncorroborated_rate, 0.1);
  assert.strictEqual(
    wideBlindSpot.overall_uncorroborated_rate,
    0.1,
    "denominator is the adjudicated subset — the rate does not drift with the blind spot",
  );
  assert.strictEqual(wideBlindSpot.overall_unverifiable_count, 100);
  assert.strictEqual(wideBlindSpot.overall_eligible_count, 110);
});

test("buildStyleRefSummary: all-unverifiable window → null rate, never a clean zero", () => {
  const out = buildStyleRefSummary([
    styleRow({ emission_count: 5n, emission_total: 5n, unverifiable_count: 5n }),
  ]);

  assert.strictEqual(out.overall_uncorroborated_rate, null, "adjudicated=0 → honest null");
  assert.strictEqual(out.overall_unverifiable_count, 5);
  assert.strictEqual(out.overall_greenfield_count, 0);
});

test("buildStyleRefSummary: all-greenfield window → null rate, greenfield outside the partition", () => {
  const out = buildStyleRefSummary([
    styleRow({ emission_count: 5n, emission_total: 5n }),
  ]);

  assert.strictEqual(out.overall_uncorroborated_rate, null, "adjudicated=0 → honest null, not 0");
  assert.strictEqual(out.overall_greenfield_count, 5);
  assert.strictEqual(out.overall_eligible_count, 0);
});

test("buildStyleRefSummary: empty rows → all-zero counts + null rates", () => {
  const out = buildStyleRefSummary([]);

  assert.strictEqual(out.overall_corroborated_count, 0);
  assert.strictEqual(out.overall_uncorroborated_count, 0);
  assert.strictEqual(out.overall_unverifiable_count, 0);
  assert.strictEqual(out.overall_eligible_count, 0);
  assert.strictEqual(out.overall_greenfield_count, 0);
  assert.strictEqual(out.overall_uncorroborated_rate, null);
  assert.strictEqual(out.overall_emission_rate, null);
});

test("buildStyleRefSummary: per-agent rows carry the same partition", () => {
  const out = buildStyleRefSummary([
    styleRow({
      agent: "dev-b",
      emission_count: 6n,
      emission_total: 8n,
      corroborated_count: 1n,
      uncorroborated_count: 2n,
      unverifiable_count: 3n,
    }),
  ]);

  const row = out.agents[0];
  assert.strictEqual(row.agent, "dev-b");
  assert.strictEqual(row.eligible_count, 6, "sum of the three, not an independent count");
  assert.strictEqual(row.unverifiable_count, 3);
  assert.strictEqual(row.emission_rate, 0.75);
});

// buildGraderCrosscheckSummary — grader write/edit cross-check state distribution fold.

test("buildGraderCrosscheckSummary: empty rows → empty buckets + zero counts (column absent)", () => {
  // Pre-migration degradation path: the isolated query rejects, the route folds [].
  const out = buildGraderCrosscheckSummary([], 30);

  assert.strictEqual(out.window_days, 30, "window_days echoes the passed param");
  assert.deepStrictEqual(out.buckets, [], "empty buckets array");
  assert.strictEqual(out.recorded_total, 0);
  assert.strictEqual(out.withheld_count, 0);
  assert.strictEqual(out.not_applicable_count, 0);
});

test("buildGraderCrosscheckSummary: withheld is separated from not-applicable", () => {
  // The single distinction the state column exists for — review_flag_reasons collapses
  // both branches into the same unverified verdict with no reason token.
  const rows = [
    { state: "contradicted", row_count: 2n },
    { state: "na", row_count: 7n },
    { state: "verified", row_count: 11n },
    { state: "withhold", row_count: 3n },
  ];
  const out = buildGraderCrosscheckSummary(rows, 7);

  assert.strictEqual(out.withheld_count, 3);
  assert.strictEqual(out.not_applicable_count, 7);
  assert.strictEqual(out.recorded_total, 23, "sum over recorded state tokens");
  assert.strictEqual(out.buckets.length, 4);
});

test("buildGraderCrosscheckSummary: unrecorded rows stay outside every recorded count", () => {
  // Rows written before the column existed are unrecoverable (no session/transcript key
  // on an outcome row), so they must not read as a recorded not-applicable.
  const rows = [
    { state: "unrecorded", row_count: 278n },
    { state: "withhold", row_count: 1n },
  ];
  const out = buildGraderCrosscheckSummary(rows, 30);

  assert.strictEqual(out.recorded_total, 1, "unrecorded excluded from the recorded total");
  assert.strictEqual(out.not_applicable_count, 0, "absence of a state is not a state");
  assert.strictEqual(out.withheld_count, 1, "floor over recorded rows, not a historical total");
  assert.strictEqual(out.buckets.length, 2, "the unrecorded bucket still surfaces");
});

// ----- buildStyleRefChargeableFilter — published-denominator gate ------------
// The published style_ref rates must describe the population the probe-omission
// charging function can hold a writer responsible on. Two of its three conditions
// are mirrored in the route (task_type + attribution_source), so each is pinned
// against the bash declaration it mirrors; the third is a roster the route derives
// rather than copies, and the derivation's premise is pinned too.

test("buildStyleRefEligibleFilter: greenfield excluded and bound, not inlined", () => {
  const frag = buildStyleRefEligibleFilter();

  // Both halves are load-bearing. Dropping `IS NOT NULL` admits non-emitting rows;
  // dropping the greenfield exclusion pulls every greenfield row into the
  // unverifiable bucket, since a greenfield row also carries a NULL verify state.
  assert.match(
    frag.sql,
    /^style_ref IS NOT NULL AND style_ref <> \?$/,
    "eligibility = emitted AND not the greenfield sentinel",
  );
  // LLM05 — the sentinel is a bound value, so it must not appear in the SQL text.
  assert.strictEqual(frag.values.length, 1, "one bound value");
  assert.ok(
    !frag.sql.includes(frag.values[0] as string),
    "greenfield sentinel must be bound, not inlined",
  );
});

test("buildStyleRefChargeableFilter: AND-prefixed, both predicates bound not inlined", () => {
  const frag = buildStyleRefChargeableFilter();

  assert.match(
    frag.sql,
    /^AND task_type::text IN \((?:\?,)*\?\) AND attribution_source IN \((?:\?,)*\?\)$/,
    "AND-prefixed pair, placeholder-only",
  );
  // LLM05 — every literal is a bound value, so none may appear in the SQL text.
  for (const value of frag.values as string[]) {
    assert.ok(!frag.sql.includes(value), `'${value}' must be bound, not inlined`);
  }
  assert.strictEqual(
    (frag.sql.match(/\?/g) ?? []).length,
    frag.values.length,
    "one placeholder per bound value",
  );
});

// Partitions the bound values by each IN group's own placeholder count, so an
// added or dropped member shifts the partition instead of hiding outside a slice
// sized from the expectation.
function chargeableBoundSets(): { taskTypes: string[]; sources: string[] } {
  const frag = buildStyleRefChargeableFilter();
  const groups = [...frag.sql.matchAll(/IN \(((?:\?,)*\?)\)/g)].map(
    (m) => m[1].split(",").length,
  );
  assert.strictEqual(groups.length, 2, "two IN groups expected");
  const values = frag.values as string[];
  assert.strictEqual(
    groups[0] + groups[1],
    values.length,
    "every bound value belongs to one of the two IN groups",
  );
  return {
    taskTypes: values.slice(0, groups[0]).sort(),
    sources: values.slice(groups[0]).sort(),
  };
}

test("buildStyleRefChargeableFilter: task_type set matches the charging function's case-glob", () => {
  const src = readFileSync(STYLE_REF_CONSTS_LIB, "utf8");
  // The allowlist is an in-function case-glob, deliberately not an exported constant.
  const m = src.match(/case\s+"\$\{TASK_TYPE\}"\s+in\s*\n\s*([^)\n]+)\)/);
  assert.ok(m, "charging function must declare a TASK_TYPE case-glob");
  const bashTaskTypes = m[1].split("|").map((s) => s.trim()).filter(Boolean).sort();

  assert.deepStrictEqual(
    chargeableBoundSets().taskTypes,
    bashTaskTypes,
    "route mirror drifted from bash SoT",
  );
});

test("buildStyleRefChargeableFilter: attribution set matches WRITER_ATTRIBUTION_SOURCES", () => {
  const src = readFileSync(REVIEW_FLAG_REASONS_LIB, "utf8");
  const m = src.match(/WRITER_ATTRIBUTION_SOURCES='([^']*)'/);
  assert.ok(m, "recorder lib must declare WRITER_ATTRIBUTION_SOURCES");
  const bashSources = m[1].split(/\s+/).filter(Boolean).sort();

  assert.deepStrictEqual(
    chargeableBoundSets().sources,
    bashSources,
    "route mirror drifted from bash SoT",
  );
});

test("style_ref roster: registry DEV prefix set equals STYLEREF_AGENTS (third condition, derived not copied)", () => {
  // The route gates agents by the runtime 'glass-atrium-dev-' registry prefix instead of
  // re-declaring STYLEREF_AGENTS. That omission is only sound while the two sets coincide.
  const registry = JSON.parse(readFileSync(AGENT_REGISTRY, "utf8")) as {
    agents: Record<string, unknown>;
  };
  const registryDev = Object.keys(registry.agents)
    .filter((name) => name.startsWith("glass-atrium-dev-"))
    .sort();

  const rosterSrc = readFileSync(STYLEREF_ROSTER_LIB, "utf8");
  const m = rosterSrc.match(/STYLEREF_AGENTS="([^"]*)"/);
  assert.ok(m, "roster lib must declare STYLEREF_AGENTS");
  const roster = m[1].split(/\s+/).filter(Boolean).sort();

  assert.deepStrictEqual(registryDev, roster, "prefix derivation no longer covers the roster");
});
