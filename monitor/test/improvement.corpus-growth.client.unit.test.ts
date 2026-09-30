// Unit test for the instrumentation view's gauge helpers in
// public/src/screens/improvement-instrumentation.jsx: the per-gauge verdicts the Operator view
// reads through window.ImprovementInstrumentationVerdicts, the flagged-reason ranking, and
// formatRateI, which the corpus-growth card reuses for compliance_rate /
// override_rate. Those two are nullable end to end
// because a null is insufficient data and a 0 is a measured total failure; a
// renderer that folds them together destroys the distinction the column carries.
//
// Sandbox harness (esbuild + node:vm over the real shipped view source): client-sandbox.ts.
//
// Runner: npx tsx --test test/improvement.corpus-growth.client.unit.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTRUMENTATION_SRC = resolve(
  __dirname,
  "../public/src/screens/improvement-instrumentation.jsx",
);

interface GaugeVerdict {
  symbol: string;
  tone: string;
  label: string;
  hint: string;
}

interface ReasonSegment {
  key: string;
  count: number;
}

interface ImprovementHelpers {
  formatRateI: (rate: number | null | undefined) => string;
  styleRefGradeBadgeI: (emission: number | null, uncorroborated: number | null) => GaugeVerdict;
  getCorpusGrowthVerdictI: (latest: Record<string, unknown> | undefined) => GaugeVerdict;
  getRankedReasonsI: (segments: { items: ReasonSegment[] } | null) => ReasonSegment[];
  window: { ImprovementInstrumentationVerdicts?: Record<string, unknown> };
}

const helpers = await buildScreenSandbox<ImprovementHelpers>(INSTRUMENTATION_SRC);

test("null rate renders as the insufficient-data dash, never a percentage", () => {
  assert.equal(helpers.formatRateI(null), "—");
  assert.equal(helpers.formatRateI(undefined), "—");
});

// The discriminating case: a falsy-check renderer passes the null case above and
// fails here, collapsing a measured zero into "no data".
test("a measured zero rate stays a zero percentage", () => {
  assert.equal(helpers.formatRateI(0), "0.0%");
});

test("a fractional rate renders as a one-decimal percentage", () => {
  assert.equal(helpers.formatRateI(0.9532), "95.3%");
  assert.equal(helpers.formatRateI(1), "100.0%");
});

// The Operator view's health strip must read these verdicts, never a copy that can drift.
test("the verdict export is the very helpers the instrumentation tab renders with", () => {
  const exported = helpers.window.ImprovementInstrumentationVerdicts;

  assert.equal(exported?.styleRefGradeBadgeI, helpers.styleRefGradeBadgeI);
  assert.equal(exported?.getCorpusGrowthVerdictI, helpers.getCorpusGrowthVerdictI);
});

describe("the corpus-growth verdict warns exactly when a raised alert exists", () => {
  const rows = [
    { name: "no reading yet stays informational", latest: undefined, tone: "text-info", alerts: [] },
    { name: "a quiet reading is ok", latest: { trend_alert: false, absolute_alert: false }, tone: "text-ok", alerts: [] },
    { name: "a trend alert warns and names it", latest: { trend_alert: true, absolute_alert: false }, tone: "text-warn", alerts: ["trend"] },
    { name: "an absolute alert warns and names it", latest: { trend_alert: false, absolute_alert: true }, tone: "text-warn", alerts: ["absolute"] },
    { name: "both alerts warn and name both", latest: { trend_alert: true, absolute_alert: true }, tone: "text-warn", alerts: ["trend", "absolute"] },
  ];

  for (const row of rows) {
    test(row.name, () => {
      const verdict = helpers.getCorpusGrowthVerdictI(row.latest);

      assert.equal(verdict.tone, row.tone);
      for (const alert of row.alerts) assert.match(verdict.label, new RegExp(alert));
    });
  }
});

test("flagged reasons rank by count, largest first, ties keeping the shared reason order", () => {
  const items = [
    { key: "a", count: 3 },
    { key: "b", count: 121 },
    { key: "c", count: 3 },
    { key: "d", count: 40 },
  ];

  // Spread → host-realm arrays; the sandbox's own Array prototype fails deepStrictEqual.
  const ranked = [...helpers.getRankedReasonsI({ items })];

  assert.deepEqual([...ranked.map((r) => r.key)], ["b", "d", "a", "c"]);
  assert.deepEqual(items.map((r) => r.key), ["a", "b", "c", "d"], "the caller's order is left untouched");
  assert.equal(helpers.getRankedReasonsI(null).length, 0);
});
