// AD-11 composite utility (SICA precedent) — pins the advisory composite that folds
// token cost + duration into the per-pattern success-rate score. Two contracts:
//   1. computeCompositeUtility — the pure fold (quality × efficiency discount).
//   2. mapSuccessRateRows — the composite_utility field travels on each per-pattern
//      row WITHOUT disturbing the existing success_rate/count fields (advisory-first).
// Both helpers are pure (no DB) → node:test with no fixture cluster.

import test from "node:test";
import assert from "node:assert/strict";

import {
  computeCompositeUtility,
  mapSuccessRateRows,
} from "../src/server/routes/agents.js";

// SuccessRateDbRow factory (interface is module-private → cast at the boundary).
// success_rate is a Prisma.Decimal | null; decimalToNumber only calls .toString(),
// so a minimal { toString } stub stands in without the generated client.
function makeRow(
  overrides: Record<string, unknown> = {},
): Parameters<typeof mapSuccessRateRows>[0][number] {
  return {
    agent: "ad11-agent",
    task_type: "feature",
    event_date: new Date("2026-07-01T00:00:00.000Z"),
    success_count: 9n,
    failure_count: 1n,
    total_count: 10n,
    reconstructed_count: 0n,
    success_rate: { toString: () => "0.9" },
    ...overrides,
  } as Parameters<typeof mapSuccessRateRows>[0][number];
}

test("computeCompositeUtility: null success_rate → null (no quality signal)", () => {
  assert.strictEqual(
    computeCompositeUtility(null, { avgTokens: 5000, avgDurationMs: 5000 }),
    null,
  );
});

test("computeCompositeUtility: null efficiency → degrades to pure success_rate", () => {
  assert.strictEqual(computeCompositeUtility(0.9, null), 0.9);
});

test("computeCompositeUtility: zero/null cost+time → unchanged success_rate (no penalty)", () => {
  assert.strictEqual(
    computeCompositeUtility(0.9, { avgTokens: 0, avgDurationMs: 0 }),
    0.9,
  );
  assert.strictEqual(
    computeCompositeUtility(0.9, { avgTokens: null, avgDurationMs: null }),
    0.9,
  );
});

test("computeCompositeUtility: token cost discounts the score (composite < success_rate)", () => {
  const composite = computeCompositeUtility(1, {
    avgTokens: 20000, // == token ref → cost penalty 0.5 → discount 0.25*0.5
    avgDurationMs: 0,
  });
  assert.ok(composite !== null);
  assert.ok(composite < 1, "cost folded → discounted");
  assert.ok(composite > 0.8, "small weight → modest discount, never inverts");
  assert.ok(Math.abs((composite as number) - 0.875) < 1e-9);
});

test("computeCompositeUtility: duration discounts the score independently", () => {
  const composite = computeCompositeUtility(1, {
    avgTokens: 0,
    avgDurationMs: 120000, // == duration ref → time penalty 0.5 → discount 0.25*0.5
  });
  assert.ok(composite !== null);
  assert.ok(Math.abs((composite as number) - 0.875) < 1e-9);
});

test("computeCompositeUtility: cost+time compound but stay clamped to [0,1]", () => {
  const composite = computeCompositeUtility(1, {
    avgTokens: 20000,
    avgDurationMs: 120000,
  });
  assert.ok(composite !== null);
  assert.ok(Math.abs((composite as number) - 0.75) < 1e-9);
  assert.ok((composite as number) >= 0 && (composite as number) <= 1);
});

test("computeCompositeUtility: a failing pattern (0) stays 0 regardless of efficiency", () => {
  // Advisory-first invariant: the fold can only DISCOUNT quality, never resurrect a
  // zero-quality pattern into a positive score.
  assert.strictEqual(
    computeCompositeUtility(0, { avgTokens: 999999, avgDurationMs: 999999 }),
    0,
  );
});

test("mapSuccessRateRows: composite_utility present + existing fields untouched (advisory-additive)", () => {
  const efficiency = { avgTokens: 20000, avgDurationMs: 0 };
  const mapped = mapSuccessRateRows([makeRow()], efficiency);
  const row = mapped[0];
  assert.ok(row);
  // Existing contract unchanged.
  assert.strictEqual(row.agent, "ad11-agent");
  assert.strictEqual(row.success_count, 9);
  assert.strictEqual(row.total_count, 10);
  assert.strictEqual(row.success_rate, 0.9);
  // New advisory field equals the pure fold of the same inputs.
  assert.strictEqual(
    row.composite_utility,
    computeCompositeUtility(0.9, efficiency),
  );
  assert.ok((row.composite_utility as number) < 0.9, "efficiency folded in");
});

test("mapSuccessRateRows: null success_rate → composite_utility null", () => {
  const mapped = mapSuccessRateRows([makeRow({ success_rate: null })], {
    avgTokens: 20000,
    avgDurationMs: 20000,
  });
  assert.strictEqual(mapped[0]?.success_rate, null);
  assert.strictEqual(mapped[0]?.composite_utility, null);
});

test("mapSuccessRateRows: efficiency omitted (1-arg legacy call) → composite == success_rate", () => {
  // Backward-compat: existing callers pass only rows; composite degrades to quality.
  const mapped = mapSuccessRateRows([makeRow()]);
  assert.strictEqual(mapped[0]?.composite_utility, 0.9);
  assert.ok("composite_utility" in (mapped[0] ?? {}), "key always present");
});
