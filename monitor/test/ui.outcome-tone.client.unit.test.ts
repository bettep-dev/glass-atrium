// Unit tests for the shared per-fact tone rule in public/src/ui.jsx — the one place a
// count becomes a tone, so no screen re-derives "greater than zero means trouble".
//
// Pinned relationships:
//   (a) outcomeShareTone carries the tone iff count/population reaches the share — the
//       threshold itself is inside, and an absent population is never a risk.
//   (b) worstTone is the severity maximum, with info/neutral ranked not-risky.
//   (c) the writer-population helpers subtract exactly the harness-reconstructed rows
//       and fall back to the legacy closure count on an old payload.
//
// Sandbox harness (esbuild + node:vm over the real shipped ui.jsx): client-sandbox.ts.
//
// Runner: npx tsx --test test/ui.outcome-tone.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Tone = "ok" | "warn" | "crit" | "info" | "neutral";
interface OutcomeRow {
  count?: number;
  closed_count?: number;
  reconstructed_count?: number;
  writer_open_count?: number;
}
interface UiHelpers {
  outcomeShareTone: (
    count: number,
    population: number,
    minShare: number,
    tone: Tone,
  ) => Tone | null;
  worstTone: (a: Tone, b: Tone) => Tone;
  getOutcomeCount: (row: OutcomeRow | undefined) => number;
  getOutcomeOpenCount: (row: OutcomeRow | undefined) => number;
  getWriterTotal: (data: { total?: number; reconstructed_total?: number } | undefined) => number;
  getWriterOpenCount: (row: OutcomeRow | undefined) => number;
  getWriterCount: (row: OutcomeRow | undefined) => number;
  OUTCOME_BREAKAGE_CRIT_SHARE: number;
  OUTCOME_OPEN_CAVEAT_WARN_SHARE: number;
}

// window.UI, not the context globals: a top-level `const` (the share thresholds) never
// lands on the vm global, so the shipped export object is the only complete surface.
const sandbox = await buildScreenSandbox<{ window: { UI: UiHelpers } }>(UI_SRC);
const ui = sandbox.window.UI;

// (a) 임계 관계 — 경계 포함, 분모 부재는 위험 아님.

test("outcomeShareTone carries the tone exactly when the share is reached", () => {
  const share = 0.1;
  const cases: readonly { count: number; population: number; toned: boolean }[] = [
    { count: 10, population: 100, toned: true },   // 경계값 자체는 포함
    { count: 11, population: 100, toned: true },
    { count: 9, population: 100, toned: false },
    { count: 0, population: 100, toned: false },
    { count: 1, population: 1, toned: true },
  ];

  for (const c of cases) {
    assert.strictEqual(
      ui.outcomeShareTone(c.count, c.population, share, "warn"),
      c.toned ? "warn" : null,
      `${c.count}/${c.population} at ${share}`,
    );
  }
});

test("outcomeShareTone never fabricates a tone from an absent population", () => {
  for (const population of [0, -5, Number.NaN]) {
    assert.strictEqual(
      ui.outcomeShareTone(3, population, 0.05, "crit"),
      null,
      `population ${population} is unknown, not critical`,
    );
  }
});

test("the outcome share thresholds stay the breakage/caveat pair the screens read", () => {
  assert.strictEqual(ui.outcomeShareTone(5, 100, ui.OUTCOME_BREAKAGE_CRIT_SHARE, "crit"), "crit");
  assert.strictEqual(ui.outcomeShareTone(4, 100, ui.OUTCOME_BREAKAGE_CRIT_SHARE, "crit"), null);
  assert.strictEqual(ui.outcomeShareTone(10, 100, ui.OUTCOME_OPEN_CAVEAT_WARN_SHARE, "warn"), "warn");
  assert.strictEqual(ui.outcomeShareTone(9, 100, ui.OUTCOME_OPEN_CAVEAT_WARN_SHARE, "warn"), null);
});

// (b) worst-of 축약.

test("worstTone returns the more severe of the two tones, in either argument order", () => {
  const pairs: readonly [Tone, Tone, Tone][] = [
    ["ok", "crit", "crit"],
    ["warn", "crit", "crit"],
    ["ok", "warn", "warn"],
    ["ok", "info", "ok"],
  ];

  for (const [a, b, worst] of pairs) {
    assert.strictEqual(ui.worstTone(a, b), worst, `${a} vs ${b}`);
    assert.strictEqual(ui.worstTone(b, a), worst, `${b} vs ${a} — order must not matter`);
  }
});

test("worstTone keeps the incumbent tone when neither is more severe", () => {
  // info 와 neutral 은 같은 '위험 아님' 등급 — 동급끼리는 먼저 쥔 톤이 남는다(rollup 누산 순서 안정).
  assert.strictEqual(ui.worstTone("neutral", "info"), "neutral");
  assert.strictEqual(ui.worstTone("info", "neutral"), "info");
  assert.strictEqual(ui.worstTone("warn", "warn"), "warn");
});

// (c) 모집단 헬퍼.

test("the writer population is the total minus the harness-reconstructed rows", () => {
  assert.strictEqual(ui.getWriterTotal({ total: 100, reconstructed_total: 40 }), 60);
  assert.strictEqual(ui.getWriterTotal({ total: 100 }), 100, "legacy payload keeps the old denominator");
  assert.strictEqual(ui.getWriterTotal(undefined), 0, "an unloaded payload is not a zero population");
  assert.strictEqual(ui.getWriterTotal({ total: 10, reconstructed_total: 40 }), 0, "never negative");
});

test("the per-row writer helpers subtract the reconstructed sub-count", () => {
  const row = { count: 50, reconstructed_count: 40, writer_open_count: 6, closed_count: 4 };
  assert.strictEqual(ui.getWriterCount(row), 10);
  assert.strictEqual(ui.getWriterOpenCount(row), 6);
  assert.strictEqual(ui.getOutcomeCount(row), 50);
  assert.strictEqual(ui.getOutcomeOpenCount(row), 46);
});

test("getWriterOpenCount falls back to the closure-only open count on a legacy row", () => {
  assert.strictEqual(ui.getWriterOpenCount({ count: 10, closed_count: 4 }), 6);
  assert.strictEqual(ui.getWriterOpenCount(undefined), 0);
});
