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
          : name === "getRegionView"
          ? getRegionViewStub
          : name === "TileSplit"
          ? tileSplitStub
          : name === "AlertCard"
          ? alertCardStub
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

// mirrors ui.jsx getRegionView → the tile builders branch as they do in the browser
function getRegionViewStub(region: { data?: unknown; error?: unknown } | null): string {
  if (region?.data != null) return "ready";
  return region?.error != null ? "error" : "loading";
}

// the tile-internal split keeps its two slots walkable → lead and detail stay findable by the tests below
function tileSplitStub({ lead, detail }: { lead: unknown; detail?: unknown }): unknown {
  const slot = (className: string, child: unknown) => ({ __element: true, type: "div", props: { className, children: child } });
  return { __element: true, type: "ui-atom", props: { atom: "TileSplit", children: [slot("tile-split-lead", lead), slot("tile-split-detail", detail)] } };
}

// the shared alert card keeps its slot props for assertions and renders title, body and actions as walkable children
function alertCardStub(props: Record<string, unknown>): unknown {
  const children = [props.title, props.body, props.actions].filter((slot) => slot != null && slot !== false);
  return { __element: true, type: "ui-atom", props: { ...props, atom: "AlertCard", children } };
}
const alertCardsOf = (tree: RenderedNode) => findNodes(tree, (n) => n.props.atom === "AlertCard");

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
    const sections = findNodes(lane, (n) => n.props["aria-label"] === "Alarms");
    assert.equal(sections.length, 1, "the lane is one labelled section");
    const regions = findNodes(sections[0], (n) => n.props["aria-live"] === "polite");
    assert.equal(regions.length, 1, `one polite region with ${alarms.length} alarms`);
    const cards = alertCardsOf(regions[0]);
    assert.equal(cards.length, alarms.length, "every alarm card sits inside the region");
    assert.ok(cards.every((card) => card.props.hasLiveHost === true), "the region announces each card, so no card carries its own role");
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

// Real-enough UI for the outcome tile and results panel: the rate passes through untouched, writer counts follow ui.jsx (count minus reconstructed).
const rateMod = (await loadScreenModule(DASH_SRC, {
  UI: {
    resolveOutcomeRate: (data: unknown) => data,
    formatInt: (n: number) => String(n),
    // ui.jsx contract "x% (n/d)" → the tile must drop the denominator tail itself
    formatPctWithDenominator: (num: number, den: number) => `${((num / den) * 100).toFixed(1)}% (${num}/${den})`,
    LOW_N_MIN: 20,
    OUTCOME_BREAKAGE_CRIT_SHARE: 0.05,
    OUTCOME_OPEN_CAVEAT_WARN_SHARE: 0.1,
    getRegionView: getRegionViewStub,
    getWriterCount: (row?: { count: number; reconstructed_count?: number }) => (row ? row.count - (row.reconstructed_count ?? 0) : 0),
    getWriterTotal: (data: { total: number; reconstructed_total?: number }) => data.total - (data.reconstructed_total ?? 0),
  },
  React: createReactStub(),
})) as ScreenModule;
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

function renderResultPanel(byResult: Array<{ result: string; count: number }>): RenderedNode {
  const total = byResult.reduce((sum, row) => sum + row.count, 0);
  const panel = (rateMod.buildResultPanel as (data: unknown) => unknown)({ total, reconstructed_total: 0, by_result: byResult, by_agent_result: [] });
  return renderScreen(rateMod.React.createElement(rateMod.ResultPanel as Component, { panel })) as RenderedNode;
}

describe("the week results panel", () => {
  const rowTexts = (tree: RenderedNode) =>
    findNodes(tree, (n) => classOf(n).includes("dash-result-row")).map((row) => collectText(row).replace(/\s+/g, " ").trim());

  test("names every result in words and keeps a known result with no runs as a zero row", () => {
    const tree = renderResultPanel([
      { result: "done", count: 400 },
      { result: "done_with_concerns", count: 250 },
      { result: "needs_context", count: 88 },
    ]);
    const rows = rowTexts(tree);
    for (const row of rows) assert.doesNotMatch(row, /[a-z]+_[a-z]+/, `"${row}" shows a label, not a raw result enum`);
    assert.ok(rows.some((row) => /^Failed ?0$/.test(row)), `a zero Failed row stays visible: ${JSON.stringify(rows)}`);
  });

  test("names each result with the shared registry word every other screen uses", async () => {
    const uiMod = await loadScreenModule(resolve(__dirname, "../public/src/ui.jsx"), { document: { documentElement: {} }, Intl });
    const resultMeta = (uiMod.UI as { RESULT_META: Record<string, { label: string }> }).RESULT_META;
    const rows = rowTexts(renderResultPanel(Object.keys(resultMeta).map((result) => ({ result, count: 7 }))));
    for (const [result, { label }] of Object.entries(resultMeta)) {
      assert.ok(rows.some((row) => row.startsWith(label) && /^ ?7$/.test(row.slice(label.length))), `${result} reads "${label}": ${JSON.stringify(rows)}`);
    }
  });

  test("states that the tile, unlike its caveat row, counts only open caveats", () => {
    const panelText = collectText(renderResultPanel([{ result: "done", count: 10 }, { result: "done_with_concerns", count: 5 }]));
    const tile = buildOutcomeTile({ status: "ready", data: { status: "ok", tone: "ok", writerTotal: 40, breakage: 1, openCaveats: 2 } });
    assert.match(String(tile.hint), /open caveats/i, "the tile's caveat figure says it counts open caveats");
    assert.match(panelText, /tile: open caveats only/i, "the panel names how the tile's figure differs");
  });

  test("every prose line on the panel fits the 90-char footnote cap", () => {
    const FOOTNOTE_CAP = 90;
    const tree = renderResultPanel([{ result: "done", count: 4_400 }, { result: "done_with_concerns", count: 83 }, { result: "fail", count: 52 }]);
    const lines = findNodes(tree, (n) => n.type === "p").map((n) => collectText(n).replace(/\s+/g, " ").trim());
    assert.ok(lines.length > 0, "the panel carries prose lines");
    for (const line of lines) assert.ok(line.length <= FOOTNOTE_CAP, `"${line}" is ${line.length} chars`);
  });
});

const buildFleetTile = rateMod.buildFleetTile as (state: unknown) => Record<string, string>;

test("the fleet tile names suspension once across its value, verdict and detail, whatever the breaker state", () => {
  const rows: Array<[string, number, number]> = [["nothing tripped", 0, 0], ["a streak", 0, 2], ["a suspended agent", 1, 2]];
  for (const [name, suspended, streak] of rows) {
    const breaker = { source: "loaded", suspended_count: suspended, streak_count: streak };
    const tile = buildFleetTile({ status: "ready", data: { meta: { total_agents: 12, circuit_breaker: breaker } } });
    const visible = [tile.value, tile.unit, tile.badge, tile.detail].join(" ");
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

test("a tile's drill sits at the tile foot, and a tile with no destination has none", () => {
  const drills = findNodes(render("StatusTile", { tile: READY_TILE, onNav: () => {}, onRetry: () => {} }), (n) => n.type === "a");
  assert.equal(drills.length, 1);
  assert.match(classOf(drills[0]), /\bmt-auto\b/, "the CTA is pinned to the foot so baselines line up");
  const undrilled = render("StatusTile", { tile: { ...READY_TILE, target: null }, onNav: () => {}, onRetry: () => {} });
  assert.equal(findNodes(undrilled, (n) => n.type === "a").length, 0);
});

test("a ready tile puts its value on the lead side and its detail and hint on the detail side", () => {
  const tile = { ...READY_TILE, detail: "7 of 40 failed" };
  const tree = render("StatusTile", { tile, onNav: () => {}, onRetry: () => {} });
  const [lead] = findNodes(tree, (n) => classOf(n) === "tile-split-lead");
  const [detail] = findNodes(tree, (n) => classOf(n) === "tile-split-detail");
  assert.equal(findNodes(lead, (n) => n.props.atom === "KpiValue").length, 1, "the value leads");
  assert.equal(findNodes(detail, (n) => classOf(n).includes("dash-tile-detail")).length, 1);
  assert.equal(findNodes(detail, (n) => classOf(n).includes("dash-tile-hint")).length, 1);
});

test("a hint carrying data clamps only the data on one line, keeping its authored words and figure whole", () => {
  const hintData = { lead: "Most runs: ", data: "glass-atrium-intel-researcher", tail: ", 12,345" };
  const tile = { ...READY_TILE, hint: "Most runs: glass-atrium-intel-researcher, 12,345", hintData };
  const tree = render("StatusTile", { tile, onNav: () => {}, onRetry: () => {} });
  const [hint] = findNodes(tree, (n) => classOf(n).includes("dash-tile-hint"));
  assert.match(classOf(hint), /\bdash-tile-hint-line\b/, "the hint is one unwrapped line");
  const parts = hint.children.map((child) => [classOf(child as RenderedNode), collectText(child as RenderedNode)]);
  assert.deepEqual(parts, [
    ["dash-tile-hint-fixed", hintData.lead],
    ["dash-tile-hint-data", hintData.data],
    ["dash-tile-hint-fixed", hintData.tail],
  ], "only the data part takes the ellipsis; the label and the figure stay whole");
  const plain = render("StatusTile", { tile: READY_TILE, onNav: () => {}, onRetry: () => {} });
  const [plainHint] = findNodes(plain, (n) => classOf(n).includes("dash-tile-hint"));
  assert.doesNotMatch(classOf(plainHint), /dash-tile-hint-line/, "an authored hint keeps its two-line wrap");
});

test("a tile's note opens from a focusable ⓘ described by the tile heading, never from a hover-only title", () => {
  const rows = [
    { name: "a tile with a note", tile: { ...READY_TILE, note: "Counts writer-emitted outcomes only." }, infoCount: 1 },
    { name: "a tile without one", tile: READY_TILE, infoCount: 0 },
  ];
  for (const row of rows) {
    const tree = render("StatusTile", { tile: row.tile, onNav: () => {}, onRetry: () => {} });
    const infos = findNodes(tree, (n) => n.props.atom === "CardInfo");
    assert.equal(infos.length, row.infoCount, row.name);
    assert.equal(findNodes(tree, (n) => n.props.title != null && n.props.atom == null).length, 0, `${row.name}: no hover-only title`);
  }
  const tree = render("StatusTile", { tile: rows[0].tile, onNav: () => {}, onRetry: () => {} });
  const [heading] = findNodes(tree, (n) => n.type === "h2");
  const [info] = findNodes(tree, (n) => n.props.atom === "CardInfo");
  assert.ok(heading.props.id, "the heading carries an id");
  assert.equal(info.props.describedBy, heading.props.id, "the ⓘ is described by the tile heading");
  assert.match(collectText(info), /writer-emitted/, "the drawer carries the note");
});

test("the results panel's counting note opens from a focusable ⓘ described by the panel heading, never from a hover-only title", () => {
  const loading = { data: null, error: null, busy: true };
  const row = render("WeekRow", { spendState: loading, outcomesState: loading, heatmapState: loading, onRetrySpend: () => {}, onRetryHeatmap: () => {} });
  const panels = findNodes(row, (n) => n.type === "section");
  const infoCounts = Object.fromEntries(panels.map((panel) => [panel.props.id, findNodes(panel, (n) => n.props.atom === "CardInfo").length]));
  assert.deepEqual(infoCounts, { "dash-week-results": 1, "dash-week-hours": 0, "dash-week-spend": 0 }, "only the results panel carries a counting note");

  const results = panels.find((panel) => panel.props.id === "dash-week-results")!;
  const [heading] = findNodes(results, (n) => n.type === "h2");
  const [info] = findNodes(results, (n) => n.props.atom === "CardInfo");
  assert.equal(info.props.describedBy, heading.props.id, "the ⓘ is described by the panel heading");
  assert.match(collectText(info), /writer-emitted/, "the drawer carries the note");

  const panel = renderResultPanel([{ result: "done", count: 40 }, { result: "fail", count: 2 }]);
  assert.equal(findNodes(panel, (n) => n.props.title != null).length, 0, "no hover-only title on the panel body");
});

test("a unit renders on the value's own line so the number and its word read as one phrase", () => {
  const tree = render("StatusTile", { tile: { ...READY_TILE, value: "0", unit: "suspended" }, onNav: () => {}, onRetry: () => {} });
  const [lead] = findNodes(tree, (n) => classOf(n) === "tile-split-lead");
  assert.match(collectText(lead), /^0\s*suspended/);
});

test("an alarm renders as one raised alert card with its tone, its detail as body, and its drill as the action", () => {
  const tree = render("AlarmCard", { alarm: HARNESS_ALARM, onNav: () => {} });
  const cards = alertCardsOf(tree);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].props.tone, "crit");
  assert.notEqual(cards[0].props.surface, "inset", "the lane card is page-level");
  assert.equal(cards[0].props.body, "autoagent");
  assert.equal(findNodes(cards[0], (n) => n.type === "a" && n.props.href === "#architecture").length, 1, "the drill is the card's action");
});

test("an alarm card whose source's latest read failed says Last known beside its title; a fresh card says nothing", () => {
  for (const isHeld of [true, false]) {
    const tree = render("AlarmCard", { alarm: { ...HARNESS_ALARM, isHeld }, onNav: () => {} });
    const badges = findNodes(tree, (n) => n.props.atom === "Badge").map((n) => collectText(n));
    assert.deepEqual(badges, isHeld ? ["Last known"] : [], `isHeld=${isHeld}`);
  }
});

test("a failed tile keeps its drill to the owning screen, whether it shows its own error card or defers to the banner", () => {
  for (const isRetryShared of [false, true]) {
    const tree = render("StatusTile", { tile: FAILED_TILE, onNav: () => {}, onRetry: () => {}, isRetryShared });
    const drills = findNodes(tree, (n) => n.type === "a" && String(n.props.href).endsWith("agents"));
    assert.equal(drills.length, 1, `isRetryShared=${isRetryShared}`);
  }
});

const FAILED_TILE = {
  id: "fleet", label: "Fleet", window: "7 d", status: "error", tone: "neutral", value: "—",
  region: "agents", source: "the fleet summary", error: "HTTP 500 Internal Server Error",
  detail: "Couldn't load the fleet summary.", hint: "The server answered with an error.", canRetry: true,
  target: "agents", targetLabel: "Agents",
};

test("a failed week panel whose cause the page banner carries points up to it instead of offering a second Retry", () => {
  const rows = [
    { name: "its own failure", isRetryShared: false, retries: 1, isPointingUp: false },
    { name: "a failure the banner carries", isRetryShared: true, retries: 0, isPointingUp: true },
  ];

  for (const row of rows) {
    const tree = render("WeekPanel", {
      id: "dash-week-hours", title: "Runs by hour", source: "runs by hour", state: { data: null, error: "HTTP 500", busy: false },
      onRetry: () => {}, render: () => null, isRetryShared: row.isRetryShared,
    });
    assert.equal(findNodes(tree, (n) => n.props.atom === "RetryButton").length, row.retries, `${row.name}: Retry count`);
    assert.equal(/notice above/.test(collectText(tree)), row.isPointingUp, `${row.name}: points to the banner`);
  }
});

describe("a week panel's own failure is one inset alert card carrying its Retry: crit when nothing loaded, neutral over a held reading", () => {
  const rows = [
    { name: "nothing loaded", state: { data: null, error: "HTTP 500", busy: false }, tone: "crit" },
    { name: "a held reading", state: { data: {}, error: "HTTP 500", busy: false }, tone: "neutral" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = render("WeekPanel", {
        id: "dash-week-hours", title: "Runs by hour", source: "runs by hour", state: row.state, onRetry: () => {}, render: () => null,
      });
      const cards = alertCardsOf(tree);
      assert.equal(cards.length, 1, "one card");
      assert.equal(cards[0].props.surface, "inset", "inside the panel");
      assert.equal(cards[0].props.tone, row.tone, "tone");
      assert.equal(findNodes(cards[0], (n) => n.props.atom === "RetryButton").length, 1, "the Retry is the card's action");
    });
  }
});

test("a failed tile states its error in one inset alert card inside the tile, whose Retry reloads only that tile's region", () => {
  const retried: string[] = [];
  const tree = render("StatusTile", { tile: FAILED_TILE, onNav: () => {}, onRetry: (region: string) => retried.push(region) });
  const cards = alertCardsOf(tree);
  assert.equal(cards.length, 1, "one alert card per failed tile");
  assert.equal(cards[0].props.surface, "inset", "the card sits inside the tile, not on the page");
  assert.equal(cards[0].props.tone, "crit");
  assert.match(collectText(cards[0]), /Couldn't load the fleet summary/);
  const retries = findNodes(tree, (n) => n.props.atom === "RetryButton");
  assert.equal(retries.length, 1, "one Retry per failed tile");
  assert.equal(findNodes(cards[0], (n) => n.props.atom === "RetryButton").length, 1, "the Retry is the card's action");
  (retries[0].props.onRetry as () => void)();
  assert.deepEqual(retried, ["agents"]);
});

test("a failed tile hands its raw error to the card's Details disclosure, never only to a hover title", () => {
  const failureDetail = "PrismaClientKnownRequestError: P1001";
  const tree = render("StatusTile", { tile: { ...FAILED_TILE, failureDetail }, onNav: () => {}, onRetry: () => {} });
  assert.equal(alertCardsOf(tree)[0].props.details, failureDetail);
  assert.equal(findNodes(tree, (n) => n.props.title === failureDetail).length, 0, "no hover-only copy");
});

test("a failed tile's Retry shows itself in flight and hands focus to its own tile card on recovery", () => {
  for (const isBusy of [true, false]) {
    const tree = render("StatusTile", { tile: { ...FAILED_TILE, isBusy }, onNav: () => {}, onRetry: () => {} });
    const [retry] = findNodes(tree, (n) => n.props.atom === "RetryButton");
    assert.equal(retry.props.isBusy, isBusy);
    const targets = findNodes(tree, (n) => n.props.id === retry.props.focusTargetId);
    assert.equal(targets.length, 1, "the focus target is the tile card that stays mounted");
    assert.ok(/\bcard\b/.test(classOf(targets[0])), classOf(targets[0]));
  }
});

test("a tile whose outage the page banner already carries stays one level: no nested card, no repeated error, no Retry", () => {
  const tree = render("StatusTile", { tile: FAILED_TILE, onNav: () => {}, onRetry: () => {}, isRetryShared: true });
  assert.equal(findNodes(tree, (n) => n.props.atom === "RegionUnavailable").length, 0, "the banner already states the error");
  assert.doesNotMatch(collectText(tree), /Couldn't load/, "the tile does not repeat the banner's sentence");
  assert.equal(findNodes(tree, (n) => n.props.atom === "RetryButton").length, 0, "the banner owns the only Retry");
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
  const retries = getRetryControls(tree);
  assert.equal(retries.length, 1);
  (retries[0].props.onRetry as () => void)();
  assert.deepEqual(retried, ["harness"]);

  // one Retry per outage → a tile whose source the banner already lists defers to the banner's Retry
  const shared = render("StatusTile", { tile: harnessTile, onNav: () => {}, onRetry: () => {}, isRetryShared: true });
  assert.equal(getRetryControls(shared).length, 0);
  const readyTree = render("StatusTile", { tile: READY_TILE, onNav: () => {}, onRetry: () => {} });
  assert.equal(getRetryControls(readyTree).length, 0, "a read tile carries no Retry");
});

// the shared RetryButton atom → busy wording, aria-busy and the focus handoff come with it
function getRetryControls(tree: RenderedNode): RenderedNode[] {
  return findNodes(tree, (n) => n.props.atom === "RetryButton");
}

test("a held tile's Retry is the shared control: in flight while busy, handing focus to its own tile card on recovery", () => {
  const heldTile = {
    ...READY_TILE, region: "outcomes", isHeld: true, badge: "Last known", error: "HTTP 500 Internal Server Error", canRetry: true,
  };
  for (const isBusy of [true, false]) {
    const retried: string[] = [];
    const tree = render("StatusTile", { tile: { ...heldTile, isBusy }, onNav: () => {}, onRetry: (region: string) => retried.push(region) });
    const retries = getRetryControls(tree);
    assert.equal(retries.length, 1, `busy=${isBusy}: one Retry`);
    assert.equal(findNodes(tree, (n) => n.type === "button").length, 0, `busy=${isBusy}: no bare button beside it`);
    assert.equal(retries[0].props.isBusy, isBusy);
    (retries[0].props.onRetry as () => void)();
    assert.deepEqual(retried, ["outcomes"], "the Retry reloads only the tile's own region");
    const targets = findNodes(tree, (n) => n.props.id === retries[0].props.focusTargetId);
    assert.equal(targets.length, 1, "the focus target is the tile card that outlives the Retry");
    assert.ok(/\bcard\b/.test(classOf(targets[0])), classOf(targets[0]));
  }
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
      getRegionSummary: () => ({ isBusy: true }),
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
  test("the page banner shows its Retry in flight and hands focus to the status band, which outlives recovery", () => {
    const tree = renderScreen(screen.React.createElement(screen.ScreenDashboard as Component, {
      onNav: () => {}, harness: FAILED, onRetryHarness: () => {},
    })) as RenderedNode;
    const [banner] = findNodes(tree, (n) => n.props.atom === "PageErrorBanner");
    assert.equal(banner.props.isBusy, true, "a wave in flight marks the banner Retry busy");
    const targets = findNodes(tree, (n) => n.props.id === banner.props.focusTargetId);
    assert.equal(targets.length, 1, `focus target ${String(banner.props.focusTargetId)} is one rendered element`);
    assert.ok(classOf(targets[0]).includes("grid"), "the target is the status band, not the banner itself");
  });
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

// an idle lane is no text and no space → it leaves the flow but keeps its polite region for a later card
test("a lane with no alarm renders no text and leaves the layout, whether its sources are loading or read", () => {
  for (const status of ["loading", "read"]) {
    const lane = render("AlarmLane", { alarms: [], readiness: { status, unread: [] }, onNav: () => {} });
    assert.equal(collectText(lane).trim(), "", `${status}: no text`);
    assert.equal(findNodes(lane, (n) => n.props.atom === "LoadingPlaceholder").length, 0, `${status}: no loading line`);
    assert.equal(findNodes(lane, (n) => n.props["aria-live"] === "polite").length, 1, `${status}: the polite region stays mounted`);
    const [section] = findNodes(lane, (n) => n.props["aria-label"] === "Alarms");
    assert.ok(classOf(section).split(/\s+/).includes("sr-only"), `${status}: the idle lane is out of flow`);
  }
});

test("a lane holding an alarm while another source loads shows only that card, in flow", () => {
  const lane = render("AlarmLane", { alarms: [HARNESS_ALARM], readiness: { status: "loading", unread: [] }, onNav: () => {} });
  const cards = alertCardsOf(lane);
  assert.equal(cards.length, 1);
  assert.equal(findNodes(lane, (n) => n.props.atom === "LoadingPlaceholder").length, 0, "no loading line under the card");
  const [section] = findNodes(lane, (n) => n.props["aria-label"] === "Alarms");
  assert.ok(!classOf(section).split(/\s+/).includes("sr-only"));
  assert.equal(collectText(lane), collectText(cards[0]), "the lane carries no text beyond its card");
});

describe("an empty alarm lane stays silent once its sources are read, and says it couldn't check when one went unread", () => {
  const READY = { status: "ready", data: {} };
  const rows = [
    { name: "every source read → silent", sources: { harness: READY, costState: READY, updateState: READY }, status: "read", unread: [] },
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

      const lane = render("AlarmLane", { alarms: [], readiness, onNav: () => {} });
      const cards = alertCardsOf(lane);
      assert.equal(cards.length, row.status === "unknown" ? 1 : 0, "only an unread source earns a card");
      if (row.status !== "unknown") return assert.equal(collectText(lane).trim(), "");
      assert.equal(cards[0].props.tone, "neutral");
      assert.match(collectText(cards[0]), /Couldn't check for alarms/);
      for (const source of row.unread) assert.ok(collectText(cards[0]).includes(source), `names the unread source ${source}`);
    });
  }
});

test("alarm cards stack in one full-width column with no list roles", () => {
  const lane = render("AlarmLane", { alarms: [HARNESS_ALARM, { ...HARNESS_ALARM, id: "spend" }], readiness: { status: "read", unread: [] }, onNav: () => {} });
  const [region] = findNodes(lane, (n) => n.props["aria-live"] === "polite");
  assert.equal(alertCardsOf(region).length, 2);
  assert.ok(classOf(region).split(/\s+/).includes("flex-col"), classOf(region));
  assert.ok(!/grid-cols-2/.test(classOf(region)), "never a second column");
  assert.equal(findNodes(lane, (n) => n.props.role === "list" || n.props.role === "listitem").length, 0);
});

test("a tile's headline value never wraps, so its badge moves to the next line instead", () => {
  const tile = { ...READY_TILE, id: "harness", tone: "crit", value: "2 of 7 down", badge: "Action needed" };
  const tree = render("StatusTile", { tile, onNav: () => {}, onRetry: () => {} });
  const [value] = findNodes(tree, (n) => n.props.atom === "KpiValue");
  const unbroken = findNodes(value, (n) => classOf(n).includes("whitespace-nowrap"));
  assert.equal(unbroken.length, 1);
  assert.equal(collectText(unbroken[0]), "2 of 7 down");
  const [row] = findNodes(tree, (n) => findNodes(n, (m) => m.props.atom === "Badge").length === 1 && classOf(n).includes("flex-wrap"));
  assert.ok(row, "the value row lets the badge wrap below the value");
});

test("a tile's trend renders on the lead side under its value, and a tile without one renders none", () => {
  const trend = "Up 20% on $10.00 yesterday by this time";
  const withTrend = render("StatusTile", { tile: { ...READY_TILE, trend }, onNav: () => {}, onRetry: () => {} });
  const [lead] = findNodes(withTrend, (n) => classOf(n) === "tile-split-lead");
  assert.match(collectText(lead), /yesterday by this time/);
  const text = collectText(lead);
  assert.ok(text.indexOf("40") < text.indexOf("Up 20%"), "the value precedes its trend");
  const without = render("StatusTile", { tile: READY_TILE, onNav: () => {}, onRetry: () => {} });
  assert.doesNotMatch(collectText(without), /yesterday/);
});

describe("the week block", () => {
  const LOADING = { data: null, error: null, busy: true };
  const sectionIds = (node: RenderedNode) =>
    findNodes(node, (n) => n.type === "section" && String(n.props.id ?? "").startsWith("dash-week-")).map((n) => n.props.id);

  test("pairs Runs by hour with the task results and gives Spend per day its own row after them", () => {
    const tree = render("WeekRow", {
      spendState: LOADING, outcomesState: LOADING, heatmapState: LOADING, onRetrySpend: () => {}, onRetryHeatmap: () => {},
    });
    assert.deepEqual(sectionIds(tree), ["dash-week-results", "dash-week-hours", "dash-week-spend"]);
    const pairs = findNodes(tree, (n) => classOf(n).split(/\s+/).includes("xl:grid-cols-2"));
    assert.equal(pairs.length, 1, "one two-column row from xl");
    assert.deepEqual(sectionIds(pairs[0]), ["dash-week-results", "dash-week-hours"], "Spend stays out of the paired row");
  });
});

test("hour ticks read as bare two-digit hours while each cell's tooltip keeps the full hour", () => {
  const counts = Array.from({ length: 24 }, (_, hour) => (hour === 5 ? 4 : 0));
  const grid = {
    rows: [{ day: "Mon", counts, fold: null }], total: 4, max: 4, span: "Sep 24 – Sep 30", folds: [],
    peak: { day: "Mon", hour: 5, count: 4, fold: null },
  };
  const tree = render("HourGrid", { grid });
  const [chart] = findNodes(tree, (n) => n.props.role === "img");
  const ticks = chart.children.slice(-24).map(collectText).filter(Boolean);
  assert.deepEqual(ticks, ["00", "06", "12", "18"]);
  const cells = findNodes(chart, (n) => typeof n.props.title === "string" && String(n.props.title).includes("runs"));
  assert.equal(cells.length, 24, "one tooltip cell per hour");
  // formatInt is a stubbed atom here → the hour prefix is the asserted part
  assert.match(String(cells[5].props.title), /^Mon 05:00 — /);
});
