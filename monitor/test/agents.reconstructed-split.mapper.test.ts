// Pure unit tests for the writer-vs-reconstructed split extended to the per-agent
// aggregations (finding #34). No DB — the mappers + the shared discriminator
// fragment are pure, so these exercise the boundary that turns a synthesized-heavy
// agent's inflated headline into a writer-emitted count.
//
// Runner: npx tsx --test test/agents.reconstructed-split.mapper.test.ts
//
// Pinned invariants:
//   (a) each per-agent mapper passes reconstructed_count through (bigint→number).
//   (b) reconstructed_count is CLAMPED to its headline count so writer-emitted
//       (headline - reconstructed) can never go negative on a malformed row.
//   (c) the shared buildReconstructedRowFilter() binds the discriminator literals as
//       PARAMETERS (Prisma.join), never string-concatenated — the reuse point that
//       keeps every aggregation on one discriminator (do-not-reimplement).

import test from "node:test";
import assert from "node:assert/strict";

import {
  mapFailurePatternRows,
  mapReviewFlagByAgentRows,
  mapSuccessRateRows,
} from "../src/server/routes/agents.js";
import {
  BUDGET_TRUNCATION_SOURCE,
  COMPLETION_SYNTHESIZED_SOURCE,
  RECONSTRUCTED_ATTRIBUTION_SOURCES,
  RECONSTRUCTED_DOWNGRADE_ORIGIN,
  buildReconstructedRowFilter,
  STRUCTUREDOUTPUT_DERIVED_SOURCE,
} from "../src/server/attribution-sources.js";

// DB row factories (interfaces are module-private → cast at the boundary, mirroring
// agents.mapper.test.ts).
function makeSuccessRateRow(
  overrides: Record<string, unknown> = {},
): Parameters<typeof mapSuccessRateRows>[0][number] {
  return {
    agent: "qa-code-reviewer",
    task_type: "review",
    event_date: new Date("2026-06-01T00:00:00.000Z"),
    success_count: 8n,
    failure_count: 0n,
    total_count: 10n,
    reconstructed_count: 0n,
    success_rate: null,
    ...overrides,
  } as Parameters<typeof mapSuccessRateRows>[0][number];
}

function makeReviewFlagRow(
  overrides: Record<string, unknown> = {},
): Parameters<typeof mapReviewFlagByAgentRows>[0][number] {
  return {
    agent: "qa-code-reviewer",
    total_count: 25n,
    review_flagged_count: 20n,
    reconstructed_count: 0n,
    review_flag_ratio: null,
    ...overrides,
  } as Parameters<typeof mapReviewFlagByAgentRows>[0][number];
}

function makeFailurePatternRow(
  overrides: Record<string, unknown> = {},
): Parameters<typeof mapFailurePatternRows>[0][number] {
  return {
    agent: "dev-nestjs",
    fail_count: 3n,
    blocked_count: 2n,
    total_breakages: 5n,
    reconstructed_count: 0n,
    fail_rate: null,
    last_breakage_at: new Date("2026-06-10T12:00:00.000Z"),
    top_concerns: [],
    ...overrides,
  } as Parameters<typeof mapFailurePatternRows>[0][number];
}

// (a)+(b) success-rate mapper — reconstructed portion of total_count.

test("mapSuccessRateRows: reconstructed_count passes through (bigint→number)", () => {
  const mapped = mapSuccessRateRows([makeSuccessRateRow({ total_count: 10n, reconstructed_count: 8n })]);
  const row = mapped[0];
  assert.ok(row);
  assert.strictEqual(row.total_count, 10);
  assert.strictEqual(row.reconstructed_count, 8);
  // writer-emitted headline = total_count - reconstructed_count = 2 (the non-inflated count).
  assert.strictEqual(row.total_count - row.reconstructed_count, 2);
});

// (a)+(b) review-flag-by-agent — reconstructed portion of the flagged headline.
// This is the finding's core surface: synthesized rows carry review_flag=true, so a
// QA agent's flagged headline is mostly recording artifact.

test("mapReviewFlagByAgentRows: writer-emitted flagged = review_flagged_count - reconstructed_count (synthesized-heavy agent)", () => {
  // 20 flagged, 18 of them harness-synthesized (90% recording artifact) → writer-emitted 2.
  const mapped = mapReviewFlagByAgentRows([
    makeReviewFlagRow({ agent: "qa-code-reviewer", review_flagged_count: 20n, reconstructed_count: 18n }),
  ]);
  const row = mapped[0];
  assert.ok(row);
  assert.strictEqual(row.review_flagged_count, 20, "headline count keeps ALL-flagged semantics");
  assert.strictEqual(row.reconstructed_count, 18, "reconstructed sub-count exposed for the artifact sub-line");
  assert.strictEqual(
    row.review_flagged_count - row.reconstructed_count,
    2,
    "writer-emitted flagged is the non-inflated number (not the inflated 20)",
  );
});

test("mapReviewFlagByAgentRows: reconstructed_count clamped to review_flagged_count (writer-emitted never negative)", () => {
  // Malformed row: reconstructed > flagged. Clamp keeps writer-emitted derivation >= 0.
  const mapped = mapReviewFlagByAgentRows([
    makeReviewFlagRow({ review_flagged_count: 5n, reconstructed_count: 9n }),
  ]);
  const row = mapped[0];
  assert.ok(row);
  assert.strictEqual(row.reconstructed_count, 5, "clamped to the flagged headline");
  assert.ok(row.review_flagged_count - row.reconstructed_count >= 0);
});

test("mapReviewFlagByAgentRows: DEV agent with genuine (non-reconstructed) flags is unaffected", () => {
  // The finding: DEV concerns are genuine — reconstructed 0 → writer-emitted == raw.
  const mapped = mapReviewFlagByAgentRows([
    makeReviewFlagRow({ agent: "dev-nestjs", review_flagged_count: 6n, reconstructed_count: 0n }),
  ]);
  const row = mapped[0];
  assert.ok(row);
  assert.strictEqual(row.reconstructed_count, 0);
  assert.strictEqual(row.review_flagged_count - row.reconstructed_count, 6, "genuine flags survive the split intact");
});

// (a)+(b) failure-patterns — reconstructed portion of total_breakages.

test("mapFailurePatternRows: reconstructed_count passes through + clamped to total_breakages", () => {
  const mapped = mapFailurePatternRows([
    makeFailurePatternRow({ total_breakages: 5n, reconstructed_count: 2n }),
  ]);
  const row = mapped[0];
  assert.ok(row);
  assert.strictEqual(row.total_breakages, 5);
  assert.strictEqual(row.reconstructed_count, 2);
  assert.strictEqual(row.total_breakages - row.reconstructed_count, 3, "writer-emitted breakages");

  const clamped = mapFailurePatternRows([
    makeFailurePatternRow({ total_breakages: 4n, reconstructed_count: 7n }),
  ]);
  assert.strictEqual(clamped[0]?.reconstructed_count, 4, "clamped to total_breakages");
});

// (c) discriminator reuse — one shared fragment, parameter-bound.

test("buildReconstructedRowFilter: binds the discriminator literals as PARAMETERS (no string concat)", () => {
  const frag = buildReconstructedRowFilter();
  // Prisma.Sql exposes bound values separately from the SQL text — proves parameterized binding.
  assert.ok(Array.isArray(frag.values), "fragment carries a bound-values array");
  // downgrade_origin literal + the 3 synthesis attribution literals are all bound values.
  assert.ok(frag.values.includes(RECONSTRUCTED_DOWNGRADE_ORIGIN), "downgrade-origin literal bound");
  assert.ok(frag.values.includes(COMPLETION_SYNTHESIZED_SOURCE), "completion-synthesized literal bound");
  assert.ok(frag.values.includes(BUDGET_TRUNCATION_SOURCE), "budget-truncation literal bound");
  assert.ok(frag.values.includes(STRUCTUREDOUTPUT_DERIVED_SOURCE), "structuredoutput-derived literal bound");
  // The columns are referenced in the SQL text, the literals are NOT (they are $-params).
  assert.match(frag.sql, /downgrade_origin/);
  assert.match(frag.sql, /attribution_source/);
  assert.doesNotMatch(frag.sql, /budget-truncation/, "literals must not be concatenated into the SQL text");
});

test("RECONSTRUCTED_ATTRIBUTION_SOURCES: exactly the 3 synthesis-branch tokens (discriminator SoT)", () => {
  assert.deepStrictEqual(
    [...RECONSTRUCTED_ATTRIBUTION_SOURCES].sort(),
    [COMPLETION_SYNTHESIZED_SOURCE, BUDGET_TRUNCATION_SOURCE, STRUCTUREDOUTPUT_DERIVED_SOURCE].sort(),
  );
});
