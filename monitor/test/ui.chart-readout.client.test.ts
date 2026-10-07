// Chart readout atom: a named image, a hover/focus readout per day, day ticks, and a width that follows its panel.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ui = await loadScreenModule(resolve(__dirname, "../public/src/ui.jsx"));

type Point = { label: string; value: number | null };
type Component = (props: Record<string, unknown>) => unknown;
const getChartTicks = ui.getChartTicks as (count: number, maxTicks?: number) => number[];
const getChartIndexAtRatio = ui.getChartIndexAtRatio as (ratio: number, count: number, kind?: string) => number | null;
const getRovingIndex = ui.getRovingIndex as (key: string, index: number | null, count: number, orientation?: string, start?: string) => number | undefined;
const getChartReadout = ui.getChartReadout as (point: Point | undefined, formatValue?: (v: number) => string) => string;
const getChartSummary = ui.getChartSummary as (name: string, points: Point[], formatValue?: (v: number) => string) => string;
const React = ui.React as { createElement: (t: unknown, p: unknown) => unknown };
type TickAnchor = "start" | "middle" | "end";
type TickSlot = { index: number; left: number; anchor: TickAnchor };
const getChartTickAnchor = ui.getChartTickAnchor as (order: number, total: number) => TickAnchor;
const getChartTickLayout = ui.getChartTickLayout as (labels: string[], kind: string, widthPx: number, maxTicks?: number) => TickSlot[];
const getChartYScale = ui.getChartYScale as (points: Point[], kind: string, formatValue?: (v: number) => string) => { top: string; bottom: string } | null;
const getChartImageProps = ui.getChartImageProps as (name: string, points: Point[], formatValue?: (v: number) => string) => Record<string, unknown>;
const getChartXAxisProps = ui.getChartXAxisProps as (labels: string[]) => { tick: unknown; interval: string; minTickGap: number };
// module consts are not context globals → read the window.UI export
const { CHART_TICK_MIN_GAP_PX, CHART_TICK_CHAR_PX } = ui.UI as { CHART_TICK_MIN_GAP_PX: number; CHART_TICK_CHAR_PX: number };

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
    test(row.name, () => assert.equal(getRovingIndex(row.key, row.index, 7, 'horizontal', 'last'), row.next));
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

describe("edge ticks anchor by visible order, so neither end label spills past the plot", () => {
  for (const total of [2, 6, 7]) {
    test(`${total} visible ticks: the first starts at its point, the last ends at its point, the rest centre`, () => {
      for (let order = 0; order < total; order++) {
        const expected = order === 0 ? "start" : order === total - 1 ? "end" : "middle";
        assert.equal(getChartTickAnchor(order, total), expected, `tick ${order} of ${total}`);
      }
    });
  }

  test("a lone tick centres on its point", () => assert.equal(getChartTickAnchor(0, 1), "middle"));

  for (const kind of ["line", "bars"]) {
    test(`${kind}: the rendered tick row shifts the first label right of its point and the last left of it`, () => {
      const tree = render("TrendChart", { label: "Spend", points: WEEK, kind });
      const shifts = findNodes(tree, (n) => n.props["data-chart-tick"] !== undefined)
        .map((n) => (n.props.style as { transform: string }).transform);
      assert.equal(shifts[0], "translateX(0)");
      assert.equal(shifts[shifts.length - 1], "translateX(-100%)");
      assert.ok(shifts.slice(1, -1).every((shift) => shift === "translateX(-50%)"), `interior labels centre: ${shifts}`);
    });
  }

  test("the shared Recharts tick anchors by the same order rule, ends on their own point", () => {
    // Recharts clamps an end label's x inward (the reserved slot) while coordinate stays on the day's point
    const rows = [
      { name: "first visible tick", index: 0, anchor: "start", x: 12 },
      { name: "interior tick", index: 2, anchor: "middle", x: 40 },
      { name: "last visible tick", index: 4, anchor: "end", x: 12 },
    ];
    for (const row of rows) {
      const text = render("ChartAxisTick", { x: 40, y: 8, payload: { value: "09-20", coordinate: 12 }, index: row.index, visibleTicksCount: 5 });
      assert.equal(text.type, "text", row.name);
      assert.equal(text.props.textAnchor, row.anchor, row.name);
      assert.equal(text.props.x, row.x, row.name);
      assert.equal(collectText(text), "09-20", row.name);
    }
  });

  test("the shared x-axis gap adds half the widest label to the minimum gap", () => {
    for (const labels of [["09-01", "09-30"], ["2026-09-01", "09-30"], []]) {
      const props = getChartXAxisProps(labels);
      const widest = Math.max(0, ...labels.map((label) => label.length));
      assert.equal(props.tick, ui.ChartAxisTick, "the shared tick");
      assert.equal(props.interval, "preserveStartEnd", "both ends kept");
      assert.ok(props.minTickGap >= CHART_TICK_MIN_GAP_PX + (widest * CHART_TICK_CHAR_PX) / 2, `gap ${props.minTickGap} covers the overhang of ${labels.join(",")}`);
    }
  });
});

describe("tick labels thin out before they collide", () => {
  // a JetBrains Mono glyph advances 0.6em, so the estimate must cover 0.6 × the meta step ticks render at
  test("the per-character label estimate is never narrower than a mono glyph at the meta step", () => {
    const tokens = readFileSync(resolve(__dirname, "../public/styles/tokens.css"), "utf8");
    const metaPx = Number(tokens.match(/--fs-meta\s*:\s*(\d+)px/)?.[1]);
    assert.ok(metaPx > 0, "tokens.css declares --fs-meta in px");
    assert.ok(CHART_TICK_CHAR_PX >= metaPx * 0.6, `${CHART_TICK_CHAR_PX}px per char under a ${metaPx * 0.6}px glyph`);
  });

  const dayLabels = (count: number): string[] => Array.from({ length: count }, (_, i) => `09-${String(i + 1).padStart(2, "0")}`);
  const getBoxes = (labels: string[], slots: TickSlot[], widthPx: number) => slots.map((slot) => {
    const width = labels[slot.index].length * CHART_TICK_CHAR_PX;
    const x = (slot.left / 100) * widthPx;
    const start = slot.anchor === "start" ? x : slot.anchor === "end" ? x - width : x - width / 2;
    return { start, end: start + width };
  });

  for (const kind of ["line", "bars"]) {
    for (const widthPx of [160, 320, 480, 1024]) {
      for (const count of [7, 27, 30, 90]) {
        test(`${kind}, ${count} days in ${widthPx}px: no two labels sit closer than the minimum gap and the latest day is labelled`, () => {
          const labels = dayLabels(count);
          const slots = getChartTickLayout(labels, kind, widthPx);
          const boxes = getBoxes(labels, slots, widthPx);
          assert.ok(slots.length >= 2, `at least the two ends fit: ${slots.length}`);
          assert.equal(slots[slots.length - 1].index, count - 1);
          boxes.forEach((box, i) => {
            if (i > 0) assert.ok(box.start - boxes[i - 1].end >= CHART_TICK_MIN_GAP_PX, `labels ${i - 1} and ${i} clear by the gap`);
          });
        });
      }
    }
  }

  test("a panel wide enough for every candidate keeps the full tick cap", () => {
    assert.equal(getChartTickLayout(dayLabels(30), "bars", 2000, 7).length, 7);
  });

  test("an unmeasured row (width 0) keeps the count-based ticks", () => {
    assert.deepEqual(getChartTickLayout(dayLabels(30), "line", 0, 7).map((slot) => slot.index), getChartTicks(30, 7));
  });

  test("a cap that lands on even steps keeps them even while the row thins out", () => {
    for (const { count, maxTicks } of [{ count: 13, maxTicks: 7 }, { count: 25, maxTicks: 7 }, { count: 7, maxTicks: 7 }]) {
      for (let widthPx = 60; widthPx <= 1200; widthPx += 10) {
        const indexes = getChartTickLayout(dayLabels(count), "line", widthPx, maxTicks).map((slot) => slot.index);
        const steps = new Set(indexes.slice(1).map((index, i) => index - indexes[i]));
        assert.ok(steps.size <= 1, `${count} days at ${widthPx}px: ticks ${indexes.join(",")} step unevenly`);
      }
    }
  });
});

describe("the optional y-scale states the plotted extent", () => {
  const rows: Array<{ name: string; values: Array<number | null>; kind: string; top: number; bottom: number }> = [
    { name: "a line runs from its low to its high", values: [80, 90, 85, 95], kind: "line", top: 95, bottom: 80 },
    { name: "bars rise from zero to their high", values: [3, 7, 5], kind: "bars", top: 7, bottom: 0 },
    { name: "a missing day never counts toward the extent", values: [40, null, 60], kind: "line", top: 60, bottom: 40 },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const points = row.values.map((value, i) => ({ label: `d${i}`, value }));
      assert.deepEqual({ ...getChartYScale(points, row.kind, pct) }, { top: pct(row.top), bottom: pct(row.bottom) });
    });
  }

  test("a series with no value has no scale", () => {
    assert.equal(getChartYScale([{ label: "d0", value: null }], "line", pct), null);
  });

  test("TrendChart shows the scale only when asked", () => {
    const withScale = render("TrendChart", { label: "Rate", points: WEEK, formatValue: pct, yScale: true });
    const [scale] = findNodes(withScale, (n) => n.props["data-chart-y-scale"] !== undefined);
    assert.ok(scale, "the scale column renders");
    assert.equal(scale.props["aria-hidden"], "true", "the summary already names low and high");
    assert.match(collectText(scale), /95%[\s\S]*80%/);
    const without = render("TrendChart", { label: "Rate", points: WEEK, formatValue: pct });
    assert.equal(findNodes(without, (n) => n.props["data-chart-y-scale"] !== undefined).length, 0);
  });
});

test("a Recharts chart wrapper gets a focusable image role named by the chart summary", () => {
  assert.deepEqual({ ...getChartImageProps("Daily cost", WEEK, pct) }, {
    role: "img",
    tabIndex: 0,
    "aria-label": getChartSummary("Daily cost", WEEK, pct),
  });
});
