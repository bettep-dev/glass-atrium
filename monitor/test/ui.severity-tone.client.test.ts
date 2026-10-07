// One severity map: amber or red only past a stated threshold, the worst tone wins a rollup, icons match their tone.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ui = await loadScreenModule(resolve(__dirname, "../public/src/ui.jsx"));

type Thresholds = { warnAbove?: number; critAbove?: number };
const getSeverityTone = ui.getSeverityTone as (value: unknown, thresholds?: Thresholds) => string | null;
const getWorstTone = ui.getWorstTone as (tones: unknown[]) => string | null;
// top-level consts stay module-scoped in the harness → read them through the window.UI export
const UI = ui.UI as Record<string, unknown>;
const TONE_ICON = UI.TONE_ICON as Record<string, string>;
const TONE_GLYPH = UI.TONE_GLYPH as Record<string, string>;
type Component = (props: Record<string, unknown>) => unknown;
const RESULT_META = UI.RESULT_META as Record<string, { tone: string; icon: string; glyph: string }>;

const rows: Array<{ name: string; value: unknown; thresholds?: Thresholds; tone: string | null }> = [
  { name: "no stated threshold never warns, however large the value", value: 9_999, tone: null },
  { name: "a value at the warn threshold stays quiet", value: 2_000, thresholds: { warnAbove: 2_000 }, tone: null },
  { name: "a value just past the warn threshold is amber", value: 2_001, thresholds: { warnAbove: 2_000 }, tone: "warn" },
  { name: "a value past the crit threshold is red, not amber", value: 9_000, thresholds: { warnAbove: 2_000, critAbove: 8_000 }, tone: "crit" },
  { name: "a zero count is quiet", value: 0, thresholds: { warnAbove: 0 }, tone: null },
  { name: "a positive count is amber", value: 1, thresholds: { warnAbove: 0 }, tone: "warn" },
  { name: "a missing value is quiet", value: null, thresholds: { warnAbove: 0 }, tone: null },
  { name: "a non-numeric value is quiet", value: "n/a", thresholds: { warnAbove: 0 }, tone: null },
];

for (const row of rows) {
  test(`severity tone: ${row.name}`, () => {
    assert.equal(getSeverityTone(row.value, row.thresholds), row.tone);
  });
}

test("the worst tone wins a rollup, and a rollup with no severity carries none", () => {
  assert.equal(getWorstTone(["ok", "warn", "info", "crit", "warn"]), "crit");
  assert.equal(getWorstTone(["ok", null, "warn"]), "warn");
  assert.equal(getWorstTone(["neutral", null, undefined]), null);
  assert.equal(getWorstTone([]), null);
});

test("every result's icon and glyph are the ones its tone stands for", () => {
  for (const [result, meta] of Object.entries(RESULT_META)) {
    assert.equal(meta.icon, TONE_ICON[meta.tone], `${result} icon`);
    assert.equal(meta.glyph, TONE_GLYPH[meta.tone], `${result} glyph`);
  }
});

const TONES = ["crit", "warn", "ok", "info"] as const;
const getToneNodes = (tree: RenderedNode | string | null, tone: string) =>
  findNodes(tree, (n) => String(n.props?.className ?? "").split(" ").includes(`text-${tone}`));

// A label in a tone colour fails contrast on the --sunken badge shell, so the tone rides on a glyph.
test("a toned status badge or pill never paints its label in the tone, and a pill shows the tone glyph", () => {
  for (const tone of TONES) {
    const forms = [
      ["status badge without glyph", (ui.Badge as Component)({ role: "status", tone, glyph: false, children: "Label" }), false],
      ["status badge", (ui.Badge as Component)({ role: "status", tone, children: "Label" }), true],
      ["pill", (ui.Pill as Component)({ tone, children: "Label" }), true],
    ] as const;
    for (const [form, element, hasGlyph] of forms) {
      const toned = getToneNodes(renderScreen(element), tone);
      assert.ok(toned.every((n) => !collectText(n).includes("Label")), `${tone} ${form} label is neutral`);
      assert.equal(toned.some((n) => collectText(n).includes(TONE_GLYPH[tone])), hasGlyph, `${tone} ${form} glyph`);
    }
  }
});

test("a KPI delta carries its tone on the arrow only, the numeral staying neutral", () => {
  const rows = [
    { name: "a rise is bad", value: 5, tone: "crit" },
    { name: "a fall is good", value: -5, tone: "ok" },
    { name: "an inverse rise is good", value: 5, inverse: true, tone: "ok" },
    { name: "an inverse fall is bad", value: -5, inverse: true, tone: "crit" },
    { name: "no change is faint", value: 0, tone: "faint" },
  ];
  for (const row of rows) {
    const tree = renderScreen((ui.Delta as Component)({ value: row.value, inverse: row.inverse }));
    const [arrow] = findNodes(tree, (n) => n.type === "Icon");
    assert.equal(arrow?.props.className, `text-${row.tone}`, `${row.name}: arrow tone`);
    const toned = findNodes(tree, (n) => /(^|\s)text-/.test(String(n.props?.className ?? "")));
    assert.ok(toned.every((n) => !collectText(n).includes("%")), `${row.name}: numeral neutral`);
  }
  const css = readFileSync(resolve(__dirname, "../public/styles/base.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const deltaRules = [...css.matchAll(/([^{}]*\.kpi-delta[^{}]*)\{([^{}]*)\}/g)];
  assert.ok(deltaRules.length > 0, "base.css styles .kpi-delta");
  for (const [, selector, body] of deltaRules) {
    const color = body.match(/(?:^|[;\s])color\s*:\s*([^;]+)/)?.[1].trim();
    if (color !== undefined) assert.equal(color, "rgb(var(--dim))", `${selector.trim()} numeral colour`);
  }
});
