// The Task results header stamp and verdict read the page's region states: a refresh in flight keeps
// the stamp busy, a failed panel read never reads as fresh, and a warm error never reads Healthy.
//
// Runner: npx tsx --test test/outcomes.freshness-stamp.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

import { buildScreenSandbox } from "./client-sandbox.js";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTCOMES_SRC = resolve(__dirname, "../public/src/screens/outcomes.jsx");
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

interface RegionState {
  status: string;
  data: unknown;
  error: string | null;
  busy: boolean;
}

interface FreshnessInput {
  at: string | null;
  regions: ReadonlyArray<RegionState>;
}

interface StampSandbox {
  window: {
    UI: { getFreshnessState: (input: FreshnessInput & { now: number }) => string; INITIAL_REGION_STATE: RegionState };
  };
  getFreshnessInputO: (asOfAt: string | null, regions: ReadonlyArray<RegionState>) => FreshnessInput;
}

const sandbox = await buildScreenSandbox<StampSandbox>(OUTCOMES_SRC);

const NOW = Date.parse("2026-01-10T12:00:00.000Z");
const READ_AT = new Date(NOW - 60_000).toISOString();

const first = sandbox.window.UI.INITIAL_REGION_STATE;
const ready: RegionState = { ...first, status: "ready", data: {}, busy: false };
const refreshing: RegionState = { ...ready, busy: true };
const failedOverHeld: RegionState = { ...ready, error: "HTTP 500" };
const failedFirst: RegionState = { ...first, status: "error", busy: false, error: "HTTP 500" };

function getState(asOfAt: string | null, regions: RegionState[]): string {
  return sandbox.window.UI.getFreshnessState({ ...sandbox.getFreshnessInputO(asOfAt, regions), now: NOW });
}

const rows = [
  { name: "every panel read and settled reads as fresh", at: READ_AT, regions: [ready, ready], expected: "fresh" },
  { name: "a refresh over held data reads as refreshing, never fresh", at: READ_AT, regions: [ready, refreshing], expected: "refreshing" },
  { name: "the first wave reads as loading", at: null, regions: [first, first], expected: "loading" },
  { name: "one failed refresh beside a good panel reads as partial", at: READ_AT, regions: [ready, failedOverHeld], expected: "partial" },
  { name: "every panel failing after a read reads as stale", at: READ_AT, regions: [failedOverHeld, failedOverHeld], expected: "stale" },
  { name: "every panel failing before any read reads as not read", at: null, regions: [failedFirst, failedFirst], expected: "not-read" },
];

for (const row of rows) {
  test(`the stamp: ${row.name}`, () => {
    assert.strictEqual(getState(row.at, row.regions), row.expected);
  });
}

// ----- verdict, fold tone, retry, tile role and cell contrast (element-tree harness) -----

const ui = await loadScreenModule(UI_SRC);
const screen = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
const create = (screen.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;

type Component = (props: Record<string, unknown>) => unknown;

function render(name: string, props: Record<string, unknown>): RenderedNode {
  return renderScreen(create(screen[name] as Component, props)) as RenderedNode;
}

const OK_OVERALL = { total: 200, reconstructed_total: 0, by_result: [{ result: "done", count: 200 }] };
const settled: RegionState = { ...first, status: "ready", data: { overall: OK_OVERALL }, busy: false };
const warmError: RegionState = { ...settled, error: "HTTP 500" };
const channelsOk: RegionState = { ...first, status: "ready", data: { alerting: [] }, busy: false };

function getVerdictText(analytics: RegionState, at: string | null, regions: RegionState[]): string {
  const tree = render("PageVerdictO", {
    analyticsState: analytics, channelLivenessState: regions.includes(first) ? first : channelsOk,
    windowDays: 7, freshness: { at, regions, now: NOW },
  });
  return collectText(tree);
}

const verdictRows = [
  { name: "a settled fresh read with an ok rate reads Healthy", analytics: settled, at: READ_AT, regions: [settled, channelsOk], has: "Healthy", lacks: "Last known" },
  { name: "a warm error over an ok rate reads Last known, never Healthy", analytics: warmError, at: READ_AT, regions: [warmError, channelsOk], has: "Last known", lacks: "Healthy" },
  { name: "a cold load reads No signal with a checking note, never Healthy", analytics: first, at: null, regions: [first, first], has: "No signal", lacks: "Healthy" },
];

for (const row of verdictRows) {
  test(`the verdict: ${row.name}`, () => {
    const text = getVerdictText(row.analytics, row.at, row.regions);
    assert.ok(text.includes(row.has), `expected "${row.has}" in: ${text}`);
    assert.ok(!text.includes(row.lacks), `unexpected "${row.lacks}" in: ${text}`);
  });
}

test("a cold-error Retry in flight keeps the status band's failure card instead of a loader", () => {
  const retrying: RegionState = { ...first, status: "loading", busy: true, error: "HTTP 500" };
  const tree = render("StatusBandO", { analyticsState: retrying, attentionState: first, windowDays: 7, onRetry: () => undefined });
  const retry = findNodes(tree, (n) => n.type === "button" && collectText(n).includes("Retrying"));
  assert.strictEqual(retry.length, 1, collectText(tree));
  assert.strictEqual(retry[0].props["aria-disabled"], "true");
});

const foldRows = [
  { name: "a checkable type failing its check past the breakage share tones the fold crit", rows: [{ task_type: "feature", total: 100, verified_fail: 20, verified_pass: 80 }], expected: "crit" },
  { name: "every checkable type passing leaves the fold untoned", rows: [{ task_type: "feature", total: 100, verified_fail: 0, verified_pass: 100 }], expected: undefined },
  { name: "a low-sample failing type claims no tone", rows: [{ task_type: "feature", total: 4, verified_fail: 4 }], expected: undefined },
  { name: "a type with nothing to check never tones the fold", rows: [{ task_type: "doc", total: 100, verified_fail: 50, by_design_unverified: true }], expected: undefined },
];

for (const row of foldRows) {
  test(`the By task type fold: ${row.name}`, () => {
    assert.strictEqual((screen.getTaskTypeFoldToneO as (r: unknown) => unknown)(row.rows), row.expected);
  });
}

test("each reporting-health tile is a named group, so a tab or reader lands on one unit", () => {
  const summary = { healthy_rate: 0.9, attribution_loss_rate: 0.05, literal_omission_rate: 0.03, synthesized_rate: 0.02 };
  const tree = render("AttributionSummaryRow", { summary, totalAttributed: 100 });
  const tiles = findNodes(tree, (n) => n.props.role === "group");
  const names = tiles.map((n) => String(n.props["aria-label"]));
  for (const label of ["Recorded properly", "Untraceable"]) {
    assert.ok(names.some((name) => name.startsWith(label)), `no group named ${label}: ${names.join(" | ")}`);
  }
});

// WCAG relative luminance over "R G B" token triplets
function getLuminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// One token map per theme — the dark theme spans its main block and the root-only accent default.
function getThemeTokens(): Array<Record<string, number[]>> {
  const css = readFileSync(resolve(__dirname, "../public/styles/tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const themes = { light: {} as Record<string, number[]>, dark: {} as Record<string, number[]> };
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const theme = selector.trim() === ":root" ? themes.light : selector.includes('[data-theme="dark"]') ? themes.dark : null;
    if (!theme) continue;
    for (const m of body.matchAll(/--([a-z-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) theme[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return [themes.light, themes.dark].filter((tokens) => tokens.ink && tokens.elev && tokens.accent && tokens.warn);
}

function getContrast(a: number[], b: number[]): number {
  const [hi, lo] = [getLuminance(a), getLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

for (const isPolar of [false, true]) {
  test(`the busiest ${isPolar ? "polar" : "plain"} crosstab cell keeps its count at 4.5:1 and its fill at 3:1 in every theme`, () => {
    const tree = render("CrosstabCell", { cell: { count: 8623, isPolar }, max: 8623, rowLabel: "high", colLabel: "pass" });
    const td = findNodes(tree, (n) => n.type === "td")[0];
    assert.strictEqual((td.props.style as { background?: string } | undefined)?.background, undefined, "the count sits on the plain card");
    const fill = findNodes(tree, (n) => /^rgb\(var\(--[a-z]+\)\)$/.test(String((n.props.style as { background?: string } | undefined)?.background)))[0];
    assert.ok(fill, "solid fill not found");
    const fillVar = /--([a-z]+)/.exec(String((fill.props.style as { background: string }).background))![1];
    const themes = getThemeTokens();
    assert.strictEqual(themes.length, 2);
    for (const tokens of themes) {
      assert.ok(getContrast(tokens.ink, tokens.elev) >= 4.5, "count contrast");
      const fillContrast = getContrast(tokens[fillVar], tokens.elev);
      assert.ok(fillContrast >= 3, `fill contrast ${fillContrast.toFixed(2)}`);
    }
  });
}
