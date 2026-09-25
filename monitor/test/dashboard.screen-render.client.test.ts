// Element-tree behaviour tests for the Dashboard lane and tiles: the alarm lane as a live
// region, drill links as real anchors, tile headings and the value scale. Exercises the
// shipped JSX through test/lib/render-screen.ts.
//
// Runner: npx tsx --test test/dashboard.screen-render.client.test.ts

import test, { describe } from "node:test";
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
    assert.match(classOf(anchors[0]), /\bbtn\b/, "the drill takes the shared .btn 32px control floor");
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

test("the Task results tile headlines a bare failed share on one line, with its counts and caveat share on the lines below", () => {
  const judged = [["ok", "ok"], ["warn", "warn"], ["crit", "crit"]] as const;
  const verdicts = judged.map(([status, tone]) => {
    const tile = buildOutcomeTile({ status: "ready", data: { status, tone, writerTotal: 40, breakage: 7, openCaveats: 9 } });
    assert.equal(tile.value, "17.5%", `${status}: the headline is the share alone, no denominator to wrap`);
    assert.match(String(tile.detail), /\b7 of 40\b/, `${status}: the failed count and its denominator stay visible`);
    assert.match(String(tile.hint), /22\.5%.*\b9\b/, `${status}: the caveat share and count stay visible`);
    assert.doesNotMatch(String(tile.badge), /\d/, `${status}: the badge is a verdict`);
    return tile.badge;
  });
  assert.equal(new Set(verdicts).size, judged.length, "each judged status reads as its own verdict");

  const lowN = buildOutcomeTile({ status: "ready", data: { status: "low-n", tone: "neutral", writerTotal: 12, breakage: 1, openCaveats: 0 } });
  assert.equal(lowN.value, "12", "too small a sample still shows how many there are");
  assert.match(String(lowN.detail), /too few to judge/i);
});

const buildFleetTile = rateMod.buildFleetTile as (state: unknown) => Record<string, string>;

test("the fleet tile names suspension once across its value, verdict and detail, whatever the breaker state", () => {
  const rows: Array<[string, number, number]> = [["nothing tripped", 0, 0], ["a streak", 0, 2], ["a suspended agent", 1, 2]];
  for (const [name, suspended, streak] of rows) {
    const breaker = { source: "loaded", suspended_count: suspended, streak_count: streak };
    const tile = buildFleetTile({ status: "ready", data: { meta: { total_agents: 12, circuit_breaker: breaker } } });
    const visible = [tile.value, tile.badge, tile.detail].join(" ");
    assert.equal(visible.match(/suspend/gi)?.length, 1, `${name}: "${visible}" says suspended exactly once`);
  }
});

test("a tile renders its number as the KPI value, its verdict as the badge, and the detail after both", () => {
  const tile = { ...READY_TILE, tone: "crit", value: "17.5% (7/40)", badge: "Failures above line", detail: "failed · 9/40 with caveats" };
  const tree = render("StatusTile", { tile, onNav: () => {}, onRetry: () => {} });
  const value = findNodes(tree, (n) => n.props.atom === "KpiValue");
  assert.equal(value.length, 1);
  assert.equal(collectText(value[0]), "17.5% (7/40)");
  const badges = findNodes(tree, (n) => n.props.atom === "Badge");
  assert.equal(badges.length, 1);
  assert.equal(collectText(badges[0]), "Failures above line");
  const text = collectText(tree);
  assert.ok(text.indexOf("17.5%") < text.indexOf("with caveats"), "the number precedes the detail");
});

test("a tile's drill sits at the tile foot, and a tile whose destination the lane drills has none", () => {
  const drills = findNodes(render("StatusTile", { tile: READY_TILE, onNav: () => {}, onRetry: () => {} }), (n) => n.type === "a");
  assert.equal(drills.length, 1);
  assert.match(classOf(drills[0]), /\bmt-auto\b/, "the CTA is pinned to the foot so baselines line up");
  const undrilled = render("StatusTile", { tile: { ...READY_TILE, target: null }, onNav: () => {}, onRetry: () => {} });
  assert.equal(findNodes(undrilled, (n) => n.type === "a").length, 0);
});

test("an alarm row is a flat hairline row whose tone rides on the leading glyph, with sans detail text", () => {
  const tree = render("AlarmRow", { alarm: HARNESS_ALARM, onNav: () => {} });
  const rows = findNodes(tree, (n) => classOf(n).split(/\s+/).includes("alarm-row"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].props["data-tone"], "crit");
  assert.equal(rows[0].props.style, undefined, "no tinted fill or stripe");
  assert.equal(findNodes(tree, (n) => classOf(n).includes("alarm-row-glyph")).length, 1);
  assert.equal(findNodes(tree, (n) => classOf(n).includes("font-mono")).length, 0, "part names are words, not mono");
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

test("a tile whose outage the page banner already carries stays one level: no nested card, no repeated error, no Retry", () => {
  const tree = render("StatusTile", { tile: FAILED_TILE, onNav: () => {}, onRetry: () => {}, isRetryShared: true });
  assert.equal(findNodes(tree, (n) => n.props.atom === "RegionUnavailable").length, 0, "the banner already states the error");
  assert.equal(findNodes(tree, (n) => /\b(sub-)?card\b/.test(classOf(n))).length, 1, "only the tile itself is a card");
  assert.equal(findNodes(tree, (n) => n.type === "button").length, 0, "the banner owns the only Retry");
  assert.equal(collectText(findNodes(tree, (n) => n.props.atom === "KpiValue")[0]), "—", "the value slot keeps its unknown dash");
});

test("an unavailable harness tile offers a Retry that re-polls the harness, unless the page banner lists it", () => {
  const harnessTile = {
    id: "harness", label: "Harness health", status: "unavailable", tone: "neutral", value: "—",
    hint: "Harness readings unavailable.", region: "harness", canRetry: true, target: "architecture", targetLabel: "System map",
  };
  const retried: string[] = [];
  const tree = render("StatusTile", { tile: harnessTile, onNav: () => {}, onRetry: (region: string) => retried.push(region) });
  const buttons = findNodes(tree, (n) => n.type === "button" && collectText(n).includes("Retry"));
  assert.equal(buttons.length, 1);
  (buttons[0].props.onClick as () => void)();
  assert.deepEqual(retried, ["harness"]);

  // one Retry per outage → a tile whose source the banner already lists defers to the banner's Retry
  const shared = render("StatusTile", { tile: harnessTile, onNav: () => {}, onRetry: () => {}, isRetryShared: true });
  assert.equal(findNodes(shared, (n) => n.type === "button" && collectText(n).includes("Retry")).length, 0);
  const readyTree = render("StatusTile", { tile: READY_TILE, onNav: () => {}, onRetry: () => {} });
  assert.equal(findNodes(readyTree, (n) => n.type === "button").length, 0, "a read tile carries no Retry");
});

test("a tile Retry routes the harness region to the shell re-poll and every other region to its own reload", () => {
  const polled: string[] = [];
  const loaded: string[] = [];
  const retry = (mod.getTileRetry as (load: (r: string) => void, poll: () => void) => (r: string) => void)(
    (region) => loaded.push(region),
    () => polled.push("harness"),
  );
  retry("harness");
  retry("cost");
  assert.deepEqual(polled, ["harness"]);
  assert.deepEqual(loaded, ["cost"]);
});

describe("the page-wide re-reads also re-poll the shell's harness", async () => {
  const FAILED = { status: "error", data: null, error: "HTTP 500" };
  // every region failed on one cause → the page banner mounts beside the header Refresh
  const failedUi = new Proxy(uiStub() as Record<string, unknown>, {
    get: (target, name: string) => ({
      INITIAL_REGION_STATE: FAILED,
      getRegionSummary: () => ({ isBusy: false }),
      getSharedFailure: () => ({ sources: ["today's spend", "harness health"], error: "HTTP 500" }),
      formatUsd: String,
      formatInt: String,
    } as Record<string, unknown>)[name] ?? target[name],
  });
  const screen = (await loadScreenModule(DASH_SRC, { UI: failedUi, React: createReactStub() })) as ScreenModule;
  const rows = [
    { name: "the header Refresh", atom: "RefreshButton", handler: "onRefresh" },
    { name: "the page banner Retry", atom: "PageErrorBanner", handler: "onRetry" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      let polls = 0;
      const tree = renderScreen(screen.React.createElement(screen.ScreenDashboard as Component, {
        onNav: () => {}, harness: FAILED, onRetryHarness: () => { polls += 1; },
      })) as RenderedNode;
      // the header's controls ride the PageHeader atom's `right` slot, outside its children
      const [header] = findNodes(tree, (n) => n.props.atom === "PageHeader");
      const slots = [tree, renderScreen(header.props.right) as RenderedNode];
      const controls = slots.flatMap((slot) => findNodes(slot, (n) => n.props.atom === row.atom));
      assert.equal(controls.length, 1, `${row.name} is mounted`);
      (controls[0].props[row.handler] as () => void)();
      assert.equal(polls, 1, `${row.name} re-polls the harness once`);
    });
  }
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
  const struts = findNodes(loading, (n) => n.type === "span" && classOf(n) === "kpi-value");
  assert.equal(struts.length, 1, "an empty KPI-scale strut holds the value row's height");
  assert.equal(struts[0].props["aria-hidden"], "true");
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
  const pending = render("AlarmLane", { alarms: [], readiness: { status: "loading", unread: [] }, onNav: () => {} });
  const region = findNodes(pending, (n) => n.props["aria-live"] === "polite")[0];
  assert.equal(findNodes(region, (n) => n.props.atom === "LoadingPlaceholder").length, 1);

  const settled = render("AlarmLane", { alarms: [], readiness: { status: "read", unread: [] }, onNav: () => {} });
  assert.equal(findNodes(settled, (n) => n.props.atom === "LoadingPlaceholder").length, 0);
  assert.match(collectText(settled), /No alarms/, "a settled empty lane keeps its line instead of collapsing");

  // a source still loading may add a row → an early alarm keeps the reserved slot below it, so a late alarm fills it
  const slotsFor = (readiness: unknown) => findNodes(
    render("AlarmLane", { alarms: [HARNESS_ALARM], readiness, onNav: () => {} }),
    (n) => n.props.atom === "LoadingPlaceholder" && classOf(n).includes("dash-lane-slot"),
  ).length;
  assert.equal(slotsFor({ status: "loading", unread: [] }), 1, "an early alarm keeps the reserved slot while a source loads");
  assert.equal(slotsFor({ status: "read", unread: [] }), 0, "a settled lane holds only its rows");
});

// The lane's height is its rows plus its one trailing line → a source settling must not change that sum either way.
describe("a source settling never changes the lane's height, whether or not it adds a row", () => {
  type LaneSlots = { reserved: number; trailer: string | null };
  const getLaneSlots = mod.getLaneSlots as (rowCount: number, readiness: unknown, reserved: number) => LaneSlots;
  const heightOf = (rowCount: number, slots: LaneSlots) => rowCount + (slots.trailer === null ? 0 : 1);
  const LOADING = { status: "loading", unread: [] };
  const rows = [
    { name: "an early alarm, the loading source adds none", before: 1, after: 1, settled: { status: "read", unread: [] } },
    { name: "an early alarm, the loading source adds one", before: 1, after: 2, settled: { status: "read", unread: [] } },
    { name: "an early alarm, the loading source fails", before: 1, after: 1, settled: { status: "unknown", unread: ["today's spend"] } },
    { name: "no alarm yet, the loading source adds none", before: 0, after: 0, settled: { status: "read", unread: [] } },
    { name: "no alarm yet, the loading source adds one", before: 0, after: 1, settled: { status: "read", unread: [] } },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const loading = getLaneSlots(row.before, LOADING, 0);
      const settled = getLaneSlots(row.after, row.settled, loading.reserved);
      assert.equal(heightOf(row.after, settled), heightOf(row.before, loading));
    });
  }

  test("the held line clears once a later row takes its slot", () => {
    const loading = getLaneSlots(1, LOADING, 0);
    const held = getLaneSlots(1, { status: "read", unread: [] }, loading.reserved);
    const filled = getLaneSlots(2, { status: "read", unread: [] }, held.reserved);
    assert.equal(heightOf(2, filled), heightOf(1, held), "a late alarm fills the held slot instead of pushing the band");
  });
});

test("an alarm lane holding a settled source's slot says no other alarm is waiting", () => {
  const text = collectText(render("LaneTrailer", { trailer: "clear", hasAlarms: true, unread: [] }));
  assert.match(text, /No other alarms/);
  assert.doesNotMatch(text, /No alarms need you/, "the all-clear stays for an empty lane");
});

describe("the empty alarm lane shows the all-clear only when every alarm source was read", () => {
  const READY = { status: "ready", data: {} };
  const rows = [
    { name: "every source read → all-clear", sources: { harness: READY, costState: READY, updateState: READY }, status: "read", unread: [] },
    { name: "a source still loading → loading, even beside a failed one", sources: { harness: { status: "loading" }, costState: { status: "error" }, updateState: READY }, status: "loading", unread: [] },
    { name: "harness fold unavailable → unknown", sources: { harness: { status: "unavailable" }, costState: READY, updateState: READY }, status: "unknown", unread: ["harness health"] },
    { name: "spend read failed → unknown", sources: { harness: READY, costState: { status: "error" }, updateState: READY }, status: "unknown", unread: ["today's spend"] },
    { name: "install read failed → unknown", sources: { harness: READY, costState: READY, updateState: { status: "error" } }, status: "unknown", unread: ["install state"] },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const readiness = (mod.getAlarmReadiness as (s: unknown) => { status: string; unread: string[] })(row.sources);
      assert.equal(readiness.status, row.status);
      assert.deepEqual([...readiness.unread], row.unread);

      const text = collectText(render("AlarmLane", { alarms: [], readiness, onNav: () => {} }));
      assert.equal(/No alarms need you/.test(text), row.status === "read", `all-clear shown only when read: ${text}`);
      if (row.status === "unknown") {
        assert.match(text, /Alarms unknown/);
        for (const source of row.unread) assert.ok(text.includes(source), `names the unread source ${source}`);
      }
    });
  }
});
