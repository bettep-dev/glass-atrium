// Element-tree behaviour tests for the Dashboard lane and tiles: the alarm lane as a live
// region, drill links as real anchors, tile headings and the value scale. Exercises the
// shipped JSX through test/lib/render-screen.ts.
//
// Runner: npx tsx --test test/dashboard.screen-render.client.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  collectText,
  createReactStub,
  findNodes,
  loadScreenModule,
  renderScreen,
  type RenderedNode,
} from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASH_SRC = resolve(__dirname, "../public/src/screens/dashboard.jsx");

// window.UI stub — every atom resolves to a transparent host element.
function uiStub(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name === "TONE_ICON"
          ? new Proxy({}, { get: () => "dot" })
          : Object.defineProperty(
              (props: Record<string, unknown>) => ({
                __element: true,
                type: "ui-atom",
                props: { ...props, atom: name },
              }),
              "name",
              { value: name },
            ),
      has: () => true,
    },
  );
}

type Component = (props: unknown) => unknown;
interface ScreenModule {
  React: { createElement: (t: unknown, p: unknown) => unknown };
  [name: string]: unknown;
}

const mod = (await loadScreenModule(DASH_SRC, { UI: uiStub(), React: createReactStub() })) as ScreenModule;

function render(name: string, props: Record<string, unknown>): RenderedNode {
  return renderScreen(mod.React.createElement(mod[name] as Component, props)) as RenderedNode;
}
function classOf(node: RenderedNode): string {
  return String(node.props.className ?? "");
}

const HARNESS_ALARM = {
  id: "harness", tone: "crit", title: "1 harness part is down", detail: "autoagent",
  target: "architecture", targetLabel: "System map",
};
const READY_TILE = {
  id: "outcomes", label: "Task results", window: "7 d", status: "ready", tone: "neutral",
  value: "40", hint: "40 outcomes", target: "outcomes", targetLabel: "Task results",
};

test("the alarm lane is a polite live region that exists before any alarm arrives", () => {
  for (const alarms of [[], [HARNESS_ALARM]]) {
    const lane = render("AlarmLane", { alarms, onNav: () => {} });
    const regions = findNodes(lane, (n) => n.props["aria-live"] === "polite");
    assert.equal(regions.length, 1, `one polite region with ${alarms.length} alarms`);
    assert.equal(regions[0].props["aria-label"], "Alarms");
    const rows = findNodes(regions[0], (n) => n.props.role === "listitem");
    assert.equal(rows.length, alarms.length, "every alarm row sits inside the region");
  }
});

test("every drill is an anchor to its screen's hash; a plain click routes in-app, a modified one is left to the browser", () => {
  const trees = [
    render("AlarmLane", { alarms: [HARNESS_ALARM], onNav: (t: string) => navs.push(t) }),
    render("StatusTile", { tile: READY_TILE, onNav: (t: string) => navs.push(t), onRetry: () => {} }),
  ];
  const navs: string[] = [];
  for (const [tree, target] of [[trees[0], "architecture"], [trees[1], "outcomes"]] as const) {
    const anchors = findNodes(tree, (n) => n.type === "a");
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].props.href, `#${target}`);
    assert.equal(findNodes(tree, (n) => n.type === "button").length, 0, "no drill stays a button");

    const onClick = anchors[0].props.onClick as (e: unknown) => void;
    let prevented = 0;
    const event = (extra: Record<string, unknown>) => ({ button: 0, preventDefault: () => { prevented += 1; }, ...extra });
    navs.length = 0;
    onClick(event({}));
    assert.deepEqual(navs, [target]);
    assert.equal(prevented, 1);
    for (const extra of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      onClick(event(extra));
    }
    assert.deepEqual(navs, [target], "modified clicks open the href natively");
    assert.equal(prevented, 1);
  }
});

test("a tile heads with an h2 whose window keeps its own case, and leads with the KPI-scale value", () => {
  const tree = render("StatusTile", { tile: READY_TILE, onNav: () => {}, onRetry: () => {} });
  const headings = findNodes(tree, (n) => n.type === "h2");
  assert.equal(headings.length, 1);
  const windowSpan = findNodes(headings[0], (n) => classOf(n).includes("normal-case"));
  assert.equal(windowSpan.length, 1, "the window escapes the label's uppercase");
  assert.equal(collectText(windowSpan[0]).replace(/\s+/g, ""), "(7d)");
  const value = findNodes(tree, (n) => n.props.atom === "KpiValue");
  assert.equal(value.length, 1, "the value uses the Cost page's KPI scale");
  assert.equal(collectText(value[0]), "40");
});

// Real-enough UI for the outcome tile builder: the rate passes through untouched so each judged status can be driven directly.
const rateMod = (await loadScreenModule(DASH_SRC, {
  UI: {
    resolveOutcomeRate: (data: unknown) => data,
    formatInt: (n: number) => String(n),
    formatPctWithDenominator: (num: number, den: number) => `${num}/${den}`,
    LOW_N_MIN: 20,
  },
  React: createReactStub(),
})) as Record<string, unknown>;
const buildOutcomeTile = rateMod.buildOutcomeTile as (state: unknown) => Record<string, string>;

test("the Task results tile headlines a verdict for every judged status and keeps the count as secondary detail", () => {
  const judged = [["low-n", "neutral"], ["ok", "ok"], ["warn", "warn"], ["crit", "crit"]] as const;
  const verdicts = judged.map(([status, tone]) => {
    const tile = buildOutcomeTile({ status: "ready", data: { status, tone, writerTotal: 40, breakage: 7, openCaveats: 9 } });
    assert.doesNotMatch(tile.value, /\d|—/, `${status}: the headline is a verdict, not a number or a blank`);
    assert.match(String(tile.detail), /40/, `${status}: the count stays visible beside the verdict`);
    return tile.value;
  });
  assert.equal(new Set(verdicts).size, judged.length, "each judged status reads as its own verdict");
});

test("a tile with detail renders the headline first and the detail outside the KPI-scale value", () => {
  const tile = { ...READY_TILE, value: "Within lines", detail: "40 outcomes", hint: "Shares of writer-emitted outcomes." };
  const tree = render("StatusTile", { tile, onNav: () => {}, onRetry: () => {} });
  const value = findNodes(tree, (n) => n.props.atom === "KpiValue");
  assert.equal(value.length, 1);
  assert.equal(collectText(value[0]), "Within lines");
  const text = collectText(tree);
  assert.ok(text.includes("40 outcomes"), "the detail renders");
  assert.ok(text.indexOf("Within lines") < text.indexOf("40 outcomes"), "the verdict precedes the count");
});

const FAILED_TILE = {
  id: "fleet", label: "Fleet", window: "7 d", status: "error", tone: "neutral", value: "—", hint: "",
  region: "agents", source: "the fleet summary", error: "HTTP 500 Internal Server Error",
  target: "agents", targetLabel: "Agents",
};

test("a failed tile shows the shared unavailable card, whose Retry reloads only that tile's region", () => {
  const retried: string[] = [];
  const tree = render("StatusTile", { tile: FAILED_TILE, onNav: () => {}, onRetry: (region: string) => retried.push(region) });
  const cards = findNodes(tree, (n) => n.props.atom === "RegionUnavailable");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].props.source, "the fleet summary");
  assert.equal(cards[0].props.error, "HTTP 500 Internal Server Error");
  (cards[0].props.onRetry as () => void)();
  assert.deepEqual(retried, ["agents"]);
  assert.equal(findNodes(tree, (n) => n.type === "button").length, 0, "the card owns the tile's only Retry");
});

test("a tile whose outage the page banner already carries offers no Retry of its own", () => {
  const tree = render("StatusTile", { tile: FAILED_TILE, onNav: () => {}, onRetry: () => {}, isRetryShared: true });
  const cards = findNodes(tree, (n) => n.props.atom === "RegionUnavailable");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].props.onRetry, undefined);
});

test("a loading tile says so in a status placeholder and reserves the detail slot the loaded tile fills", () => {
  const loadingTile = { ...READY_TILE, status: "loading", value: "—", hint: null };
  for (const tile of [loadingTile, READY_TILE]) {
    const tree = render("StatusTile", { tile, onNav: () => {}, onRetry: () => {} });
    const detailSlots = findNodes(tree, (n) => classOf(n).includes("dash-tile-detail"));
    assert.equal(detailSlots.length, 1, `${tile.status}: the detail line is reserved whether or not it has text`);
  }
  const loading = render("StatusTile", { tile: loadingTile, onNav: () => {}, onRetry: () => {} });
  assert.equal(findNodes(loading, (n) => n.props.atom === "LoadingPlaceholder").length, 1);
  assert.equal(findNodes(loading, (n) => n.props.atom === "KpiValue").length, 0, "no value renders before one loads");
});

test("a tile refreshing over held data keeps its value and marks itself busy", () => {
  for (const isBusy of [true, false]) {
    const tree = render("StatusTile", { tile: { ...READY_TILE, isBusy }, onNav: () => {}, onRetry: () => {} });
    const card = findNodes(tree, (n) => classOf(n).includes("card"))[0];
    assert.equal(card.props["aria-busy"], isBusy ? "true" : undefined);
    assert.equal(collectText(findNodes(tree, (n) => n.props.atom === "KpiValue")[0]), "40");
  }
});

test("the status band reflows to two columns until it has room for four", () => {
  const tree = render("StatusBand", { tiles: [READY_TILE], onNav: () => {}, onRetry: () => {} });
  const band = findNodes(tree, (n) => classOf(n).includes("grid"))[0];
  const classes = classOf(band).split(/\s+/);
  assert.ok(classes.includes("grid-cols-2"), classOf(band));
  assert.ok(classes.includes("xl:grid-cols-4"), classOf(band));
  assert.ok(!classes.includes("grid-cols-4"), "four columns never apply at the narrowest widths");
});

test("the alarm lane reserves its slot with a status line while alarm sources are still loading", () => {
  const pending = render("AlarmLane", { alarms: [], isPending: true, onNav: () => {} });
  const region = findNodes(pending, (n) => n.props["aria-live"] === "polite")[0];
  assert.equal(findNodes(region, (n) => n.props.atom === "LoadingPlaceholder").length, 1);

  const settled = render("AlarmLane", { alarms: [], isPending: false, onNav: () => {} });
  assert.equal(findNodes(settled, (n) => n.props.atom === "LoadingPlaceholder").length, 0);
  assert.match(collectText(settled), /No alarms/, "a settled empty lane keeps its line instead of collapsing");

  const alarmed = render("AlarmLane", { alarms: [HARNESS_ALARM], isPending: true, onNav: () => {} });
  assert.equal(findNodes(alarmed, (n) => n.props.atom === "LoadingPlaceholder").length, 0, "a landed alarm replaces the placeholder");
});
