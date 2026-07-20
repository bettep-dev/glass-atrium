// Unit tests for rowToProposalSummary — DB row → API payload mapper (provenance restore).
// Runner: npx tsx --test test/improvement.mapper.test.ts
// No DB dependency — pure mapper unit test.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStyleRefSummary,
  foldConfidenceDistribution,
  foldTierBreakdownRow,
  rowToProposalSummary,
} from "../src/server/routes/improvement.js";

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

test("foldTierBreakdownRow: large bigint counts within MAX_SAFE_INTEGER", () => {
  // bigintToNumber boundary check — sanity test for large cohorts (12M+ rows).
  const rows = [
    {
      code_based_pass_30d: 12_345_678n,
      code_based_fail_30d: 987_654n,
      pre_3tier_baseline_count: 5_000_000n,
    },
  ];
  const out = foldTierBreakdownRow(rows);

  assert.strictEqual(out.code_based_pass_30d, 12_345_678);
  assert.strictEqual(out.code_based_fail_30d, 987_654);
  assert.strictEqual(out.pre_3tier_baseline_count, 5_000_000);
});

test("foldTierBreakdownRow: column-absence degradation → type-stable zero-init partial (F4 regression guard)", () => {
  // Graceful degradation contract — route isolates tier_breakdown in Promise.allSettled.
  // On rejection (PG 42703 undefined_column) the handler feeds foldTierBreakdownRow([]) — same empty-array input as the rejected branch.
  // Degradation output = fully-formed 4-field object (non-null, type-stable) → tier_breakdown_30d never null/undefined → FE hits the "no data" path, not a crash → endpoint stays 200, NOT 503.
  const degraded = foldTierBreakdownRow([]);

  // type-stable shape: all 4 ImprovementTierBreakdown fields present + numeric
  assert.strictEqual(typeof degraded.window_days, "number");
  assert.strictEqual(typeof degraded.code_based_pass_30d, "number");
  assert.strictEqual(typeof degraded.code_based_fail_30d, "number");
  assert.strictEqual(typeof degraded.pre_3tier_baseline_count, "number");
  // FE "no data" trigger: totalCnt === 0 (pass + fail + baseline all zero)
  const totalCnt =
    degraded.code_based_pass_30d +
    degraded.code_based_fail_30d +
    degraded.pre_3tier_baseline_count;
  assert.strictEqual(totalCnt, 0, "zero-init total → FE renders 데이터 부재 indicator, not crash");
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

// ----- buildStyleRefSummary split counts + fake_rate (P13) -------------------

function styleRow(o: Partial<Record<string, bigint | string>> = {}) {
  return {
    agent: "dev-a",
    emission_count: 0n,
    emission_total: 0n,
    verified_true_count: 0n,
    verified_eligible: 0n,
    ...o,
  } as Parameters<typeof buildStyleRefSummary>[0][number];
}

test("buildStyleRefSummary: split derivation verified/unverified/greenfield", () => {
  // emission=10, eligible=6, verified=4 → unverified=2, greenfield=4.
  const out = buildStyleRefSummary([
    styleRow({ emission_count: 10n, emission_total: 12n, verified_true_count: 4n, verified_eligible: 6n }),
  ]);

  assert.strictEqual(out.overall_verified_count, 4);
  assert.strictEqual(out.overall_unverified_count, 2, "eligible - verified");
  assert.strictEqual(out.overall_greenfield_count, 4, "emission - eligible");
  assert.strictEqual(out.overall_fake_rate, Number((2 / 6).toFixed(4)), "unverified / eligible");
});

test("buildStyleRefSummary: fake_rate null on zero verify-eligible (no fake zero)", () => {
  // all greenfield: emission=5, eligible=0 → fake_rate null, greenfield=5.
  const out = buildStyleRefSummary([
    styleRow({ emission_count: 5n, emission_total: 5n, verified_true_count: 0n, verified_eligible: 0n }),
  ]);

  assert.strictEqual(out.overall_fake_rate, null, "eligible=0 → honest null, not 0");
  assert.strictEqual(out.overall_greenfield_count, 5);
  assert.strictEqual(out.overall_unverified_count, 0);
});

test("buildStyleRefSummary: empty rows → all-zero counts + null rates", () => {
  const out = buildStyleRefSummary([]);

  assert.strictEqual(out.overall_verified_count, 0);
  assert.strictEqual(out.overall_unverified_count, 0);
  assert.strictEqual(out.overall_greenfield_count, 0);
  assert.strictEqual(out.overall_fake_rate, null);
  assert.strictEqual(out.overall_emission_rate, null);
});
