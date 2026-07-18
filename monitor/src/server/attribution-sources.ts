// Single SoT for the synthesis-branch attribution_source literals and the
// reconstructed-row discriminator shared by the /cross-analysis by_result split
// (routes/outcomes.ts) and every per-agent aggregation (routes/agents.ts). The
// raw literal values stay byte-identical with track-outcome.sh — a rename there
// must land here too.

import { Prisma } from "../generated/prisma/client.js";

// structuredoutput-derived: schema-mode recovery artifact — a terminal
// StructuredOutput tool call with no [COMPLETION] block, synthesized by
// track-outcome.sh (done/low/false). Explicit member so an audit distinguishes
// it from an unrecognized fall-through.
export const STRUCTUREDOUTPUT_DERIVED_SOURCE = "structuredoutput-derived";
// structuredoutput-completion: WRITER-emitted, NOT a synthesis artifact — the sibling
// of structuredoutput-derived where track-outcome.sh recovered a VALID [COMPLETION] block
// from the terminal StructuredOutput input's completion_block field (writer fields flow
// normally: result/confidence/metric_pass/lesson from the block, downgrade_origin empty).
// DELIBERATELY absent from RECONSTRUCTED_ATTRIBUTION_SOURCES below so the recovered signal
// is NOT folded as a harness recovery artifact — it is a clean writer-emitted (healthy) row.
export const STRUCTUREDOUTPUT_COMPLETION_SOURCE = "structuredoutput-completion";
// completion-synthesized: SubagentStop transcript-synthesis recovery artifact.
export const COMPLETION_SYNTHESIZED_SOURCE = "completion-synthesized";
// budget-truncation: a subagent hard-killed at its tool_use budget ceiling before
// emitting [COMPLETION] — a named literally-truncated completion.
export const BUDGET_TRUNCATION_SOURCE = "budget-truncation";

// Reconstructed-row discriminator: a row is a harness recovery artifact (NOT
// writer-emitted) when downgrade_origin='synthesized' OR attribution_source is a
// synthesis-branch token. Consumer-side split only — the record-write path and
// every enum stay untouched; the writer-emitted headline is count - reconstructed.
// structuredoutput-derived rows also carry downgrade_origin='synthesized', so the
// attribution arm is belt-and-braces — it keeps the fold correct even for rows
// whose origin column is NULL. Each OR arm qualifies a row alone.
export const RECONSTRUCTED_DOWNGRADE_ORIGIN = "synthesized";
export const RECONSTRUCTED_ATTRIBUTION_SOURCES: readonly string[] = [
  COMPLETION_SYNTHESIZED_SOURCE,
  BUDGET_TRUNCATION_SOURCE,
  STRUCTUREDOUTPUT_DERIVED_SOURCE,
];

// SQL FILTER predicate for the reconstructed-row discriminator — the single
// reused fragment for every per-result / per-agent reconstructed split. Returns
// a parenthesized boolean so it composes safely inside a larger
// `FILTER (WHERE <other> AND <this>)` clause without precedence surprises. All
// current call sites query `core.outcomes` un-aliased, so bare column names are
// used; parameter binding (Prisma.join) keeps the literal list injection-safe.
export function buildReconstructedRowFilter(): Prisma.Sql {
  return Prisma.sql`(downgrade_origin::text = ${RECONSTRUCTED_DOWNGRADE_ORIGIN} OR attribution_source IN (${Prisma.join(RECONSTRUCTED_ATTRIBUTION_SOURCES)}))`;
}
