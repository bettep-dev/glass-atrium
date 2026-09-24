// Unit tests for the SHARED outcome-rate rule in public/src/ui.jsx —
// resolveOutcomeRate and the writer-population accessors it reads. The Dashboard band
// and Task results both consume this one export, so the thresholds, the denominator and
// the low-n gate are asserted here once instead of on each screen.
//
// Re-homed from dashboard.dwc-closure.client.unit.test.ts and
// dashboard.synthesized-exclusion.client.unit.test.ts (plan clauded-docs/39728, stream 6):
// the closure and synthesized-exclusion relationships moved with the code they pin. The
// computeWorstRollup cases retired with the worst-severity badge the plan removed.
//
// Runner: npx tsx --test test/ui.outcome-rate.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { buildUiSandbox } from "./client-sandbox.js";

interface ByResultRow {
  result: string;
  count: number;
  closed_count?: number;
  reconstructed_count?: number;
  writer_open_count?: number;
}
interface CrossAnalysis {
  total: number;
  reconstructed_total?: number;
  by_result: ByResultRow[];
}
interface Verdict {
  status: string;
  tone: string;
  total: number;
  writerTotal: number;
  breakage: number;
  openCaveats: number;
}
interface UiSurface {
  resolveOutcomeRate: (data: CrossAnalysis | null | undefined) => Verdict;
  getOutcomeOpenCount: (row: ByResultRow | undefined) => number;
  getOutcomeWriterOpenCount: (row: ByResultRow | undefined) => number;
  getOutcomeWriterTotal: (data: CrossAnalysis | undefined) => number;
  LOW_N_MIN: number;
  OUTCOME_BREAKAGE_RATE: number;
  OUTCOME_OPEN_CAVEAT_RATE: number;
}

const UI = await buildUiSandbox<UiSurface>();

// A done-heavy population padded to `total`, so every case below clears the low-n gate
// and only the facet under test moves.
function population(rows: ByResultRow[], total = 200): CrossAnalysis {
  const named = rows.reduce((s, r) => s + r.count, 0);
  return { total, by_result: [...rows, { result: "done", count: Math.max(0, total - named) }] };
}

// --- The open-count derivation: closure subtracts, and never goes negative ---

test("open count is count minus closed across the whole input class", () => {
  for (const [count, closed] of [[10, 0], [10, 3], [10, 10], [0, 0], [5, 9]]) {
    const row = { result: "done_with_concerns", count, closed_count: closed };
    assert.equal(UI.getOutcomeOpenCount(row), Math.max(0, count - closed));
  }
  assert.equal(UI.getOutcomeOpenCount(undefined), 0, "a missing row is 0 open, never NaN");
});

test("writer open count falls back to the closure derivation when the field is absent", () => {
  const legacy = { result: "done_with_concerns", count: 10, closed_count: 4 };
  assert.equal(UI.getOutcomeWriterOpenCount(legacy), 6, "old payloads keep their previous reading");
  assert.equal(
    UI.getOutcomeWriterOpenCount({ ...legacy, writer_open_count: 2 }),
    2,
    "the explicit field wins once it is present",
  );
});

// --- The denominator: harness-reconstructed rows leave BOTH sides of the share ---

test("the quality denominator drops exactly the reconstructed rows", () => {
  for (const reconstructed of [0, 1, 50, 200, 500]) {
    const data = { total: 200, reconstructed_total: reconstructed, by_result: [] };
    assert.equal(UI.getOutcomeWriterTotal(data), Math.max(0, 200 - reconstructed));
  }
});

test("a fully reconstructed population carries no quality signal", () => {
  const verdict = UI.resolveOutcomeRate({ total: 120, reconstructed_total: 120, by_result: [] });
  assert.equal(verdict.status, "unavailable", "no writer rows = nothing to judge, not 'ok'");
  assert.equal(verdict.tone, "neutral");
});

test("synthesized breakage rows leave the numerator with their denominator", () => {
  // 40 fails of which every one is reconstructed: a writer-blind population must not alarm.
  const allSynth = population([{ result: "fail", count: 40, reconstructed_count: 40 }]);
  assert.equal(UI.resolveOutcomeRate({ ...allSynth, reconstructed_total: 40 }).status, "ok");
  // The same 40 fails, writer-emitted, clear the breakage line.
  assert.equal(UI.resolveOutcomeRate(population([{ result: "fail", count: 40 }])).status, "crit");
});

// --- The thresholds: the relationship each line asserts ---

test("breakage at or above its line is crit, and below it is not", () => {
  const cut = UI.OUTCOME_BREAKAGE_RATE;
  const total = 200;
  for (const [count, expected] of [
    [Math.ceil(total * cut), "crit"],
    [Math.ceil(total * cut) - 1, "ok"],
  ] as [number, string][]) {
    const verdict = UI.resolveOutcomeRate(population([{ result: "fail", count }], total));
    assert.equal(verdict.status, expected, `${count}/${total} breakage`);
  }
});

test("fail and blocked are summed into one breakage numerator", () => {
  const split = population([{ result: "fail", count: 5 }, { result: "blocked", count: 5 }]);
  assert.equal(UI.resolveOutcomeRate(split).breakage, 10);
  assert.equal(UI.resolveOutcomeRate(split).status, "crit", "10/200 crosses the 5% line");
});

test("open caveats at or above their line warn, and closed ones stop warning", () => {
  const cut = UI.OUTCOME_OPEN_CAVEAT_RATE;
  const total = 200;
  const count = Math.ceil(total * cut);
  const open = population([{ result: "done_with_concerns", count, closed_count: 0 }], total);
  assert.equal(UI.resolveOutcomeRate(open).status, "warn");

  const closed = population([{ result: "done_with_concerns", count, closed_count: count }], total);
  assert.equal(UI.resolveOutcomeRate(closed).status, "ok", "closed caveats are not open work");
});

test("breakage outranks open caveats when both lines are crossed", () => {
  const both = population([
    { result: "fail", count: 20 },
    { result: "done_with_concerns", count: 40, closed_count: 0 },
  ]);
  assert.equal(UI.resolveOutcomeRate(both).status, "crit", "the worse fact wins the verdict");
});

// --- The states that are not verdicts ---

test("each non-verdict state is distinct from a healthy reading", () => {
  assert.equal(UI.resolveOutcomeRate(null).status, "unavailable", "never loaded");
  assert.equal(UI.resolveOutcomeRate({ total: 0, by_result: [] }).status, "empty", "loaded, nothing in it");
  const small = population([{ result: "fail", count: UI.LOW_N_MIN }], UI.LOW_N_MIN - 1);
  assert.equal(UI.resolveOutcomeRate(small).status, "low-n", "a tiny sample must not alarm");
  assert.equal(UI.resolveOutcomeRate(small).tone, "neutral");
});
