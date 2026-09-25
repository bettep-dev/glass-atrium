// Chart readout atom: a named image, a hover/focus readout per day, day ticks, and a width that follows its panel.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ui = await loadScreenModule(resolve(__dirname, "../public/src/ui.jsx"));

type Point = { label: string; value: number | null };
type Component = (props: Record<string, unknown>) => unknown;
const getChartTicks = ui.getChartTicks as (count: number, maxTicks?: number) => number[];
const getChartIndexAtRatio = ui.getChartIndexAtRatio as (ratio: number, count: number, kind?: string) => number | null;
const getChartKeyIndex = ui.getChartKeyIndex as (key: string, index: number | null, count: number) => number | undefined;
const getChartReadout = ui.getChartReadout as (point: Point | undefined, formatValue?: (v: number) => string) => string;
const getChartSummary = ui.getChartSummary as (name: string, points: Point[], formatValue?: (v: number) => string) => string;
const React = ui.React as { createElement: (t: unknown, p: unknown) => unknown };

const pct = (v: number): string => `${v}%`;
const WEEK: Point[] = ["09-18", "09-19", "09-20", "09-21", "09-22", "09-23", "09-24"].map((label, i) => ({
  label,
  value: [80, 90, 85, 95, 88, 91, 92][i],
}));

// the harness wraps each component in a node named after it → return what the component itself rendered
const render = (name: string, props: Record<string, unknown>): RenderedNode =>
  (renderScreen(React.createElement(ui[name] as Component, props)) as RenderedNode).children[0] as RenderedNode;

describe("day ticks", () => {
  test("an empty series has no ticks", () => assert.equal(getChartTicks(0, 7).length, 0));

  for (const count of [1, 2, 7, 8, 14, 30, 90]) {
    test(`${count} points: ticks start at the first day, end at the last, rise strictly and stay within the cap`, () => {
      const ticks = getChartTicks(count, 7);
      assert.equal(ticks[0], 0);
      assert.equal(ticks[ticks.length - 1], count - 1);
      assert.ok(ticks.length <= Math.min(count, 7), `ticks ${ticks.length} within cap`);
      assert.ok(ticks.every((t, i) => i === 0 || t > ticks[i - 1]), `strictly rising: ${ticks}`);
      if (count <= 7) assert.equal(ticks.length, count, "a short range labels every day");
    });
  }
});

describe("pointer position picks the nearest day", () => {
  const rows = [
    { name: "left edge of a line is the first day", ratio: 0, count: 7, kind: "line", index: 0 },
    { name: "right edge of a line is the last day", ratio: 1, count: 7, kind: "line", index: 6 },
    { name: "a line snaps to the nearest point", ratio: 0.55, count: 7, kind: "line", index: 3 },
    { name: "a bar is the one under the pointer", ratio: 0.99, count: 4, kind: "bars", index: 3 },
    { name: "a bar left of its centre is still that bar", ratio: 0.26, count: 4, kind: "bars", index: 1 },
    { name: "a bar right of its centre is still that bar, not the next one", ratio: 0.45, count: 4, kind: "bars", index: 1 },
    { name: "a pointer past the edge clamps to the last day", ratio: 1.4, count: 7, kind: "line", index: 6 },
    { name: "a pointer before the edge clamps to the first day", ratio: -0.2, count: 4, kind: "bars", index: 0 },
    { name: "an empty chart has no day", ratio: 0.5, count: 0, kind: "line", index: null },
  ];
  for (const row of rows) {
    test(row.name, () => assert.equal(getChartIndexAtRatio(row.ratio, row.count, row.kind), row.index));
  }
});

describe("keyboard moves the readout one day at a time", () => {
  const rows = [
    { name: "the first arrow press starts on the latest day", key: "ArrowLeft", index: null, next: 6 },
    { name: "ArrowLeft steps back one day", key: "ArrowLeft", index: 4, next: 3 },
    { name: "ArrowRight steps forward one day", key: "ArrowRight", index: 4, next: 5 },
    { name: "ArrowRight stops at the latest day", key: "ArrowRight", index: 6, next: 6 },
    { name: "ArrowLeft stops at the first day", key: "ArrowLeft", index: 0, next: 0 },
    { name: "Home jumps to the first day", key: "Home", index: 4, next: 0 },
    { name: "End jumps to the latest day", key: "End", index: 1, next: 6 },
    { name: "an unrelated key is left to the page", key: "Tab", index: 4, next: undefined },
  ];
  for (const row of rows) {
    test(row.name, () => assert.equal(getChartKeyIndex(row.key, row.index, 7), row.next));
  }
});

test("the readout names the day and its formatted value, and says so when the day has none", () => {
  assert.equal(getChartReadout(WEEK[6], pct), "09-24: 92%");
  assert.equal(getChartReadout({ label: "09-20", value: null }, pct), "09-20: no data");
  assert.equal(getChartReadout(undefined, pct), "");
});

test("the accessible summary states the range, latest, low and high in formatted values", () => {
  assert.equal(
    getChartSummary("Success rate", WEEK, pct),
    "Success rate, 7 days from 09-18 to 09-24: latest 92%, low 80%, high 95%",
  );
  assert.equal(getChartSummary("Success rate", [], pct), "Success rate: no data");
});

describe("TrendChart renders a named, focusable image that fills its panel", () => {
  for (const kind of ["line", "bars"]) {
    test(`${kind}: role img with the summary as its name, reachable by Tab`, () => {
      const tree = render("TrendChart", { label: "Success rate", points: WEEK, kind, formatValue: pct });
      const [img] = findNodes(tree, (n) => n.props.role === "img");
      assert.ok(img, "an element carries role=img");
      assert.equal(img.props["aria-label"], getChartSummary("Success rate", WEEK, pct));
      assert.equal(img.props.tabIndex, 0);
      assert.equal(typeof img.props.onKeyDown, "function");
      assert.equal(typeof img.props.onPointerMove, "function");
      const [svg] = findNodes(tree, (n) => n.type === "svg");
      assert.equal(svg.props.width, "100%", "width follows the panel, not a fixed px");
      assert.equal(svg.props.preserveAspectRatio, "none");
    });
  }

  test("the day ticks under the chart are the labels of the tick days", () => {
    const tree = render("TrendChart", { label: "Spend", points: WEEK, maxTicks: 4 });
    const ticks = findNodes(tree, (n) => n.props["data-chart-tick"] !== undefined).map((n) => collectText(n));
    assert.deepEqual(ticks, Array.from(getChartTicks(WEEK.length, 4), (i) => WEEK[i].label));
  });

  test("the readout is a polite live region, empty until a day is pointed at", () => {
    const tree = render("TrendChart", { label: "Spend", points: WEEK });
    const [live] = findNodes(tree, (n) => n.props["aria-live"] === "polite");
    assert.ok(live, "a polite live region holds the readout");
    assert.equal(collectText(live), "");
  });

  test("an empty series renders a plain no-data line instead of an image", () => {
    const tree = render("TrendChart", { label: "Spend", points: [] });
    assert.equal(findNodes(tree, (n) => n.props.role === "img").length, 0);
    assert.match(collectText(tree), /No data in range/);
  });
});

describe("the small trend atoms are named when labelled and hidden when decorative", () => {
  for (const name of ["Sparkline", "MiniBars"]) {
    test(`${name} with a label is an image named by it`, () => {
      const svg = render(name, { data: [1, 3, 2], label: "Success rate, last 7 days" });
      assert.equal(svg.props.role, "img");
      assert.equal(svg.props["aria-label"], "Success rate, last 7 days");
    });
    test(`${name} without a label is hidden from assistive tech`, () => {
      const svg = render(name, { data: [1, 3, 2] });
      assert.equal(svg.props["aria-hidden"], "true");
      assert.equal(svg.props.role, undefined);
    });
  }
});
