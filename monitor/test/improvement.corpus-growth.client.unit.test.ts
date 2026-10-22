// Unit test for the instrumentation view's gauge helpers in
// public/src/screens/improvement-instrumentation.jsx: the per-gauge verdicts the Operator view
// reads through window.ImprovementInstrumentationVerdicts, the flagged-reason ranking, and
// formatRateI, which the corpus-growth card reuses for compliance_rate /
// override_rate. Those two are nullable end to end
// because a null is insufficient data and a 0 is a measured total failure; a
// renderer that folds them together destroys the distinction the column carries.
// The view's cards are rendered too: their tone rides on a glyph, never on a word or a figure.
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

interface RecordedElement {
  type: unknown;
  props: Record<string, unknown>;
}

type Component = (props: Record<string, unknown>) => unknown;

interface ImprovementHelpers {
  React: { createElement: unknown };
  [card: string]: unknown;
  formatRateI: (rate: number | null | undefined) => string;
  styleRefGradeBadgeI: (emission: number | null, uncorroborated: number | null) => GaugeVerdict;
  getCorpusGrowthVerdictI: (latest: Record<string, unknown> | undefined) => GaugeVerdict;
  getRankedReasonsI: (segments: { items: ReasonSegment[] } | null) => ReasonSegment[];
  window: {
    ImprovementInstrumentationVerdicts?: Record<string, unknown>;
    ImprovementShared?: Record<string, unknown>;
    UI: Record<string, unknown>;
  };
}

const helpers = await buildScreenSandbox<ImprovementHelpers>(INSTRUMENTATION_SRC);
const IMPROVEMENT_SRC = resolve(__dirname, "../public/src/screens/improvement.jsx");
const improvement = await buildScreenSandbox<{ window: { ImprovementShared: Record<string, unknown> } }>(IMPROVEMENT_SRC);
const GlyphMarker = () => null;
helpers.window.ImprovementShared = { ...improvement.window.ImprovementShared, SymI: GlyphMarker };
helpers.React.createElement = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => ({
  type,
  props: { ...(props ?? {}), children: rest.length > 1 ? rest : rest[0] },
});
const TONE_GLYPH = helpers.window.UI.TONE_GLYPH as Record<string, string>;

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

describe("every gauge verdict speaks the shared severity glyph of its own tone", () => {
  const rows = [
    { name: "style check: nothing read yet", verdict: () => helpers.styleRefGradeBadgeI(null, null) },
    { name: "style check: no outcomes in the window", verdict: () => helpers.styleRefGradeBadgeI(null, 0.2) },
    { name: "style check: emission below the gate blocks", verdict: () => helpers.styleRefGradeBadgeI(0.3, 0.05) },
    { name: "style check: nothing adjudicated", verdict: () => helpers.styleRefGradeBadgeI(0.6, null) },
    { name: "style check: passes the gate", verdict: () => helpers.styleRefGradeBadgeI(0.6, 0.05) },
    { name: "style check: too much uncorroborated", verdict: () => helpers.styleRefGradeBadgeI(0.6, 0.2) },
    { name: "corpus growth: an alert", verdict: () => helpers.getCorpusGrowthVerdictI({ trend_alert: true }) },
    { name: "corpus growth: quiet", verdict: () => helpers.getCorpusGrowthVerdictI({}) },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const verdict = row.verdict();
      const toneKey = verdict.tone.replace(/^text-/, "");
      assert.equal(verdict.symbol, TONE_GLYPH[toneKey], `${verdict.label} draws ${verdict.symbol} for the ${toneKey} tone`);
    });
  }
});

function isElement(value: unknown): value is RecordedElement {
  return typeof value === "object" && value !== null && "props" in value && "type" in value;
}

// Flattening walk over every prop value; renders view-local components, never the shared UI atoms or the glyph.
function viewTree(node: unknown, out: RecordedElement[] = []): RecordedElement[] {
  if (Array.isArray(node)) {
    for (const child of node) viewTree(child, out);
    return out;
  }
  if (!isElement(node)) return out;
  out.push(node);
  const isViewLocal =
    typeof node.type === "function" &&
    node.type !== GlyphMarker &&
    !Object.values(helpers.window.UI).includes(node.type);
  if (isViewLocal) return viewTree((node.type as Component)(node.props), out);
  for (const value of Object.values(node.props)) viewTree(value, out);
  return out;
}

const READY = { status: "ready" };

describe("instrumentation cards leave their tone on the glyph, never on a word or a figure", () => {
  const card = (name: string) => helpers[name] as Component;
  const rows = [
    {
      name: "results by check status",
      render: () =>
        card("TierBreakdownCardI")({
          state: READY,
          tierBreakdown: { window_days: 30, code_based_pass_30d: 10, code_based_fail_30d: 2, pre_3tier_baseline_count: 1 },
        }),
    },
    {
      name: "suggestion confidence and its lane table",
      render: () =>
        card("ConfidenceDistCardI")({
          state: READY,
          confidenceDist: {
            buckets: [
              { promotion_tier: "candidate", proposal_count: 3, confidence_observed_avg: 0.8 },
              { promotion_tier: "mention", proposal_count: 1, confidence_observed_avg: 0.3 },
            ],
            overall_confidence_observed_avg: 0.7,
          },
        }),
    },
    {
      name: "style-check rate, its split and its per-agent table",
      render: () =>
        card("StyleRefCardI")({
          state: READY,
          styleRef: {
            overall_emission_rate: 0.6,
            overall_uncorroborated_rate: 0.2,
            overall_corroborated_count: 3,
            overall_uncorroborated_count: 1,
            overall_unverifiable_count: 1,
            overall_greenfield_count: 1,
            agents: [
              {
                agent: "glass-atrium-dev-node",
                emission_count: 2,
                emission_total: 3,
                emission_rate: 0.66,
                corroborated_count: 2,
                uncorroborated_count: 1,
                unverifiable_count: 0,
                eligible_count: 3,
              },
            ],
          },
        }),
    },
    {
      name: "detection agreement",
      render: () =>
        card("CorrectionSignalsCardI")({
          state: {
            status: "ready",
            data: {
              total_signals: 5,
              agreement: { total: 5, agreement_count: 3, both_matched: 2, stage1_only: 1, stage2_only: 1, neither_matched: 1 },
              revision_delta_sum: 2,
              revision_delta_max: 1,
            },
          },
        }),
    },
    {
      name: "corpus growth under an alert",
      render: () =>
        card("CorpusGrowthCardI")({
          state: {
            status: "ready",
            data: {
              total_audits: 1,
              audits: [
                {
                  cycle_date: "2026-10-01",
                  word_count: 1000,
                  trend_delta: 12,
                  file_count: 3,
                  token_estimate: 900,
                  seeded_threshold: 900,
                  gate_pass_count: 4,
                  gate_trip_count: 1,
                  gate_total_count: 5,
                  compliance_rate: 0.9,
                  override_rate: 0.1,
                  trend_alert: true,
                  absolute_alert: false,
                },
              ],
            },
          },
        }),
    },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = viewTree(row.render());
      assert.ok(tree.some((el) => el.type === GlyphMarker), "the card renders its tone glyphs");
      const toneOnText = tree
        .filter((el) => el.props.s === undefined && /\btext-(ok|warn|crit|info)\b/.test(String(el.props.className ?? "")))
        .map((el) => String(el.props.className));
      assert.deepEqual(toneOnText, [], "a word or figure repeats the tone its glyph already declares");
    });
  }
});
