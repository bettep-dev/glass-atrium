// Element-tree behaviour tests for the Dashboard lane, stat row and week panels: the alarm lane
// as a live region, stat values as Links, the one ⓘ of the status card. Exercises the
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
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const realUi = ((await loadScreenModule(UI_SRC)) as { UI: Record<string, unknown> }).UI;

// window.UI stub — every atom resolves to a transparent host element; shared words and maps come from the real ui.jsx.
function uiStub(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name === "TONE_ICON"
          ? new Proxy({}, { get: () => "dot" })
          : name === "getRegionView"
          ? getRegionViewStub
          : name === "AlertCard"
          ? alertCardStub
          : name === "ALERT_SEVERITY_WORD"
          ? realUi[name]
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

// mirrors ui.jsx getRegionView → the stat builders branch as they do in the browser
function getRegionViewStub(region: { data?: unknown; error?: unknown } | null): string {
  if (region?.data != null) return "ready";
  return region?.error != null ? "error" : "loading";
}


// the shared alert card keeps its slot props for assertions and renders title, body and actions as walkable children
function alertCardStub(props: Record<string, unknown>): unknown {
  const children = [props.title, props.body, props.actions].filter((slot) => slot != null && slot !== false);
  return { __element: true, type: "ui-atom", props: { ...props, atom: "AlertCard", children } };
}
// PageHeader named slots, left → right
const HEADER_SLOTS = ["actions", "freshness", "range", "refresh"];
const alertCardsOf = (tree: RenderedNode) => findNodes(tree, (n) => n.props.atom === "AlertCard");
const alarmRowsOf = (tree: RenderedNode) => findNodes(tree, (n) => hasClass(n, "alarm-row"));
// a slot prop (a Card's info, a stat's value or context) is outside children → render it on its own
const nodeOf = (slot: unknown) => renderScreen(slot) as RenderedNode;

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
function hasClass(node: RenderedNode, name: string): boolean {
  return classOf(node).split(/\s+/).includes(name);
}
// a rendered element, not the component node that passed it its props (render-screen keeps both)
const isHost = (n: RenderedNode) => /^[a-z]/.test(n.type);

const HARNESS_ALARM = {
  id: "harness", tone: "crit", title: "1 harness part is down", detail: "autoagent",
  target: "architecture", targetLabel: "System map",
};
test("the alarm lane is a polite live region named Needs you that exists before any alarm arrives", () => {
  for (const alarms of [[], [HARNESS_ALARM]]) {
    const lane = render("AlarmLane", { alarms, onNav: () => {} });
    const sections = findNodes(lane, (n) => n.props["aria-label"] === "Needs you");
    assert.equal(sections.length, 1, "the lane is one labelled section");
    const regions = findNodes(sections[0], (n) => n.props["aria-live"] === "polite");
    assert.equal(regions.length, 1, `one polite region with ${alarms.length} alarms`);
    assert.equal(alarmRowsOf(regions[0]).length, alarms.length, "every alarm row sits inside the region");
    assert.ok(alarmRowsOf(regions[0]).every((row) => row.props.role === undefined), "the region announces each row, so no row carries its own role");
    assert.equal(alertCardsOf(regions[0]).length, 0, "an alarm is a row, never a card of its own");
  }
});
// Real-enough UI for the outcome stat and results panel: the rate passes through untouched, writer counts follow ui.jsx (count minus reconstructed).
const rateMod = (await loadScreenModule(DASH_SRC, {
  UI: {
    resolveOutcomeRate: (data: unknown) => data,
    formatInt: (n: number) => String(n),
    formatPct: realUi.formatPct,
    RESULT_META: realUi.RESULT_META,
    resolveResultMeta: realUi.resolveResultMeta,
    LOW_N_MIN: 20,
    OUTCOME_BREAKAGE_CRIT_SHARE: 0.05,
    OUTCOME_OPEN_CAVEAT_WARN_SHARE: 0.1,
    getRegionView: getRegionViewStub,
    getWriterCount: (row?: { count: number; reconstructed_count?: number }) => (row ? row.count - (row.reconstructed_count ?? 0) : 0),
    getWriterTotal: (data: { total: number; reconstructed_total?: number }) => data.total - (data.reconstructed_total ?? 0),
  },
  React: createReactStub(),
})) as ScreenModule;
const buildOutcomeStat = rateMod.buildOutcomeStat as (state: unknown) => { value: string | null; absent?: string; context: string | null; notes: string[] };

test("the Task results stat headlines a bare failed share, its counts on the context line and its caveat share behind ⓘ", () => {
  for (const [status, tone] of [["ok", "ok"], ["warn", "warn"], ["crit", "crit"]] as const) {
    const stat = buildOutcomeStat({ status: "ready", data: { status, tone, writerTotal: 40, breakage: 7, openCaveats: 9 } });
    assert.equal(stat.value, "17.5%", `${status}: the headline is the share alone, no denominator to wrap`);
    assert.equal(stat.context, "7 of 40 failed or blocked", `${status}: the failed count and its denominator stay visible`);
    assert.ok(stat.notes.some((note) => /22\.5% \(9\)/.test(note)), `${status}: the caveat share and count sit behind ⓘ`);
  }

  const lowN = buildOutcomeStat({ status: "ready", data: { status: "low-n", tone: "neutral", writerTotal: 12, breakage: 1, openCaveats: 0 } });
  assert.equal(lowN.value, "12", "too small a sample still shows how many there are");
  assert.match(String(lowN.context), /too few to judge/i);
});

test("a Task results stat with nothing to judge reads None, never a dash", () => {
  for (const status of ["empty", "unavailable"]) {
    const stat = buildOutcomeStat({ status: "ready", data: { status, tone: "neutral", writerTotal: 0, breakage: 0, openCaveats: 0 } });
    assert.equal(stat.absent, "none", `${status}: the share has no writer-reported outcomes behind it`);
    assert.equal(stat.value, null, `${status}: no figure stands in for the missing share`);
  }
});

function renderResultPanel(byResult: Array<{ result: string; count: number }>): RenderedNode {
  const total = byResult.reduce((sum, row) => sum + row.count, 0);
  const panel = (rateMod.buildResultPanel as (data: unknown) => unknown)({ total, reconstructed_total: 0, by_result: byResult, by_agent_result: [] });
  return renderScreen(rateMod.React.createElement(rateMod.ResultPanel as Component, { panel })) as RenderedNode;
}

test("spend and result bars carry the data colour; today's partial day keeps its outline in it", () => {
  const strip = (mod.buildSpendStrip as (points: unknown) => unknown)(
    ["2026-09-22", "2026-09-23", "2026-09-24"].map((date, i) => ({ date, cost_usd: 12.5 + i, session_count: 1 })),
  );
  const spend = render("SpendStrip", { strip });
  const results = renderResultPanel([{ result: "done", count: 40 }, { result: "fail", count: 2 }, { result: "needs_context", count: 1 }]);
  const tracks = findNodes(spend, (n) => classOf(n).includes("dash-strip-track"));
  assert.equal(tracks.length, 3);
  for (const track of tracks) assert.match(classOf(track), /\btext-data\b/, "the bar and the dashed outline inherit --data");
  assert.equal(findNodes(spend, (n) => classOf(n).includes("dash-strip-partial")).length, 1, "only today is outlined");
  const fills = findNodes(results, (n) => classOf(n).includes("dash-result-fill"));
  assert.equal(fills.length, findNodes(results, (n) => classOf(n).includes("dash-result-row")).length, "one bar per result row");
  for (const fill of fills) assert.match(classOf(fill), /\btext-data\b/, "the row's word names the result, not its bar's colour");
  for (const node of [...findNodes(spend, () => true), ...findNodes(results, () => true)]) {
    assert.doesNotMatch(classOf(node), /\btext-(?:info|ok|warn|crit)\b/);
  }
});

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

  test("points at no other card in its body — how its counts relate to the Task results stat rides its ⓘ", () => {
    const panelText = collectText(renderResultPanel([{ result: "done", count: 10 }, { result: "done_with_concerns", count: 5 }]));
    assert.doesNotMatch(panelText, /\btile\b|\bstat\b/i, `"${panelText}"`);
    const stat = buildOutcomeStat({ status: "ready", data: { status: "ok", tone: "ok", writerTotal: 40, breakage: 1, openCaveats: 2 } });
    assert.ok(stat.notes.some((note) => /open caveats/i.test(note)), "the stat's caveat figure says it counts open caveats");
  });

  test("every prose line on the panel fits the 90-char footnote cap", () => {
    const FOOTNOTE_CAP = 90;
    const tree = renderResultPanel([{ result: "done", count: 4_400 }, { result: "done_with_concerns", count: 83 }, { result: "fail", count: 52 }]);
    const lines = findNodes(tree, (n) => n.type === "p").map((n) => collectText(n).replace(/\s+/g, " ").trim());
    assert.ok(lines.length > 0, "the panel carries prose lines");
    for (const line of lines) assert.ok(line.length <= FOOTNOTE_CAP, `"${line}" is ${line.length} chars`);
  });
});

const buildFleetStat = rateMod.buildFleetStat as (state: unknown) => Record<string, string>;

test("the fleet stat names suspension once across its value, unit and context, whatever the breaker state", () => {
  const rows: Array<[string, number, number]> = [["nothing tripped", 0, 0], ["a streak", 0, 2], ["a suspended agent", 1, 2]];
  for (const [name, suspended, streak] of rows) {
    const breaker = { source: "loaded", suspended_count: suspended, streak_count: streak };
    const stat = buildFleetStat({ status: "ready", data: { meta: { total_agents: 12, circuit_breaker: breaker } } });
    const visible = [stat.value, stat.unit, stat.context].join(" ");
    assert.equal(visible.match(/suspend/gi)?.length, 1, `${name}: "${visible}" says suspended exactly once`);
  }
});

test("the results panel's counting note opens from its Card's ⓘ, never from a hover-only title", () => {
  const loading = { data: null, error: null, busy: true };
  const row = render("WeekRow", { spendState: loading, outcomesState: loading, heatmapState: loading, onRetrySpend: () => {}, onRetryHeatmap: () => {} });
  const panels = findNodes(row, (n) => n.type === "section");
  const infoOf = (panel: RenderedNode) => findNodes(panel, (n) => n.props.atom === "Card")[0].props.info;
  const hasInfo = Object.fromEntries(panels.map((panel) => [panel.props.id, Boolean(infoOf(panel))]));
  assert.deepEqual(hasInfo, { "dash-week-results": true, "dash-week-hours": true, "dash-week-spend": false }, "the results and hour panels carry a counting note");

  const results = panels.find((panel) => panel.props.id === "dash-week-results")!;
  assert.match(collectText(nodeOf(infoOf(results))), /writer-emitted/, "the drawer carries the note");
  assert.match(collectText(nodeOf(infoOf(results))), /open caveats only/i, "and names how the Task results stat's caveat figure differs");

  const panel = renderResultPanel([{ result: "done", count: 40 }, { result: "fail", count: 2 }]);
  assert.equal(findNodes(panel, (n) => n.props.title != null).length, 0, "no hover-only title on the panel body");
});

test("an alarm renders as one alarm row: its tone on the glyph, its title, its detail, and a Link to the owning page", () => {
  const navs: string[] = [];
  const tree = render("AlarmLane", { alarms: [HARNESS_ALARM], onNav: (target: string) => navs.push(target) });
  const [list] = findNodes(tree, (n) => hasClass(n, "dash-alarm-list"));
  assert.ok(hasClass(list, "card"), "the rows sit in one list card");
  const [row] = alarmRowsOf(list);
  assert.equal(row.props["data-tone"], "crit");
  assert.equal(findNodes(row, (n) => hasClass(n, "alarm-row-glyph")).length, 1, "one bare glyph slot");
  assert.match(collectText(row), /^\s*Critical:\s+1 harness part is down\s+autoagent\s+System map$/, "sr-only tone word, the title, then the detail");
  const links = findNodes(row, (n) => n.props.atom === "Link");
  assert.equal(links.length, 1, "one Link, never a bordered drill button");
  assert.equal(links[0].props.href, "#architecture");
  assert.equal(findNodes(row, (n) => hasClass(n, "btn")).length, 0);

  const onClick = links[0].props.onClick as (e: unknown) => void;
  onClick({ button: 0, preventDefault: () => {} });
  onClick({ button: 0, metaKey: true, preventDefault: () => {} });
  assert.deepEqual(navs, ["architecture"], "a plain click routes in-app, a modified one is left to the browser");
});

test("the install alarm carries its update control in place of a Link", () => {
  const install = { id: "install", tone: "warn", title: "An update is ready to apply", detail: null, target: null, targetLabel: null };
  const [row] = alarmRowsOf(render("AlarmLane", { alarms: [install], onNav: () => {},
    updateState: { status: "loading" }, updateJobState: { status: "loading" }, onRefetchJob: () => {} }));
  assert.equal(findNodes(row, (n) => n.type === "UpdateBadge").length, 1);
  assert.equal(findNodes(row, (n) => n.props.atom === "Link").length, 0);
});
test("an alarm row whose source's latest read failed says Last known in plain words after its title; a fresh row says nothing", () => {
  for (const isHeld of [true, false]) {
    const [row] = alarmRowsOf(render("AlarmLane", { alarms: [{ ...HARNESS_ALARM, isHeld }], onNav: () => {} }));
    assert.equal(findNodes(row, (n) => n.props.atom === "Badge").length, 0, `isHeld=${isHeld}: never a badge`);
    const held = findNodes(row, (n) => hasClass(n, "dash-alarm-held"));
    assert.deepEqual(held.map(collectText), isHeld ? ["Last known"] : [], `isHeld=${isHeld}`);
  }
});
test("a spend alarm's detail keeps its 7-day token whole through the shared DayTokens atom", () => {
  const SPEND_ALARM = { id: "spend", tone: "warn", title: "$842 so far today", detail: "1.3× the 7-day average ($1,380/day)", isHeld: true, target: "cost" };
  const [row] = alarmRowsOf(render("AlarmLane", { alarms: [SPEND_ALARM], onNav: () => {} }));
  const tokens = findNodes(row, (n) => n.props.atom === "DayTokens").map((n) => collectText(n));
  assert.ok(tokens.includes(SPEND_ALARM.detail), "the detail rides DayTokens");
});
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

test("a stat Retry routes the harness region to the shell re-poll and every other region to its own reload", () => {
  const polled: string[] = [];
  const loaded: string[] = [];
  const retry = (mod.getStatRetry as (load: (r: string) => void, poll: () => void) => (r: string) => void)(
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
  test("the page banner shows its Retry in flight and hands focus to the status card, which outlives recovery", () => {
    const tree = renderScreen(screen.React.createElement(screen.ScreenDashboard as Component, {
      onNav: () => {}, harness: FAILED, onRetryHarness: () => {},
    })) as RenderedNode;
    const [banner] = findNodes(tree, (n) => n.props.atom === "PageErrorBanner");
    assert.equal(banner.props.isBusy, true, "a wave in flight marks the banner Retry busy");
    const targets = findNodes(tree, (n) => n.props.id === banner.props.focusTargetId);
    assert.equal(targets.length, 1, `focus target ${String(banner.props.focusTargetId)} is one rendered element`);
    assert.equal(findNodes(targets[0], (n) => n.props.atom === "StatRow").length, 1, "the target holds the stat row, not the banner itself");
  });
  for (const row of rows) {
    test(row.name, () => {
      let polls = 0;
      const tree = renderScreen(screen.React.createElement(screen.ScreenDashboard as Component, {
        onNav: () => {}, harness: FAILED, onRetryHarness: () => { polls += 1; },
      })) as RenderedNode;
      // the header's controls ride the PageHeader atom's named slots, outside its children
      const [header] = findNodes(tree, (n) => n.props.atom === "PageHeader");
      const slots = [tree, ...HEADER_SLOTS.map((slot) => renderScreen(header.props[slot]) as RenderedNode)];
      const controls = slots.flatMap((slot) => findNodes(slot, (n) => n.props.atom === row.atom));
      assert.equal(controls.length, 1, `${row.name} is mounted`);
      (controls[0].props[row.handler] as () => void)();
      assert.equal(polls, 1, `${row.name} re-polls the harness once`);
    });
  }
});

// an idle lane is no text and no space → it leaves the flow but keeps its polite region for a later card
test("a lane with no alarm renders no text and leaves the layout, whether its sources are loading or read", () => {
  for (const status of ["loading", "read"]) {
    const lane = render("AlarmLane", { alarms: [], readiness: { status, unread: [] }, onNav: () => {} });
    assert.equal(collectText(lane).trim(), "", `${status}: no text`);
    assert.equal(findNodes(lane, (n) => n.props.atom === "LoadingPlaceholder").length, 0, `${status}: no loading line`);
    assert.equal(findNodes(lane, (n) => n.props["aria-live"] === "polite").length, 1, `${status}: the polite region stays mounted`);
    const [section] = findNodes(lane, (n) => n.props["aria-label"] === "Needs you");
    assert.ok(classOf(section).split(/\s+/).includes("sr-only"), `${status}: the idle lane is out of flow`);
    assert.equal(findNodes(lane, (n) => hasClass(n, "dash-alarm-list")).length, 0, `${status}: no list card`);
  }
});

test("a lane holding an alarm while another source loads shows only that row, in flow", () => {
  const lane = render("AlarmLane", { alarms: [HARNESS_ALARM], readiness: { status: "loading", unread: [] }, onNav: () => {} });
  const rows = alarmRowsOf(lane);
  assert.equal(rows.length, 1);
  assert.equal(findNodes(lane, (n) => n.props.atom === "LoadingPlaceholder").length, 0, "no loading line under the row");
  const [section] = findNodes(lane, (n) => n.props["aria-label"] === "Needs you");
  assert.ok(!classOf(section).split(/\s+/).includes("sr-only"));
  assert.equal(collectText(lane), collectText(rows[0]), "the lane carries no text beyond its row");
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

test("alarm rows stack worst first in one list card, with no list roles", () => {
  const lane = render("AlarmLane", { alarms: [HARNESS_ALARM, { ...HARNESS_ALARM, id: "spend", tone: "warn" }], readiness: { status: "read", unread: [] }, onNav: () => {} });
  const lists = findNodes(lane, (n) => hasClass(n, "dash-alarm-list"));
  assert.equal(lists.length, 1, "one card holds every row");
  assert.deepEqual(alarmRowsOf(lists[0]).map((row) => row.props["data-tone"]), ["crit", "warn"]);
  assert.equal(findNodes(lane, (n) => n.props.role === "list" || n.props.role === "listitem").length, 0);
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

// "Wed ×2" is one unbreakable token → it never splits, in the ⓘ fold sentence or in the row-label column
test("a folded weekday keeps its ×2 token on one line in the fold sentence and the row label", () => {
  const counts = Array.from({ length: 24 }, (_, hour) => (hour === 14 ? 9 : 0));
  const grid = {
    rows: [{ day: "Wed", counts, fold: "09-23 + today" }], total: 9, max: 9, span: "Sep 24 – Sep 30",
    folds: [{ day: "Wed", fold: "09-23 + today" }], peak: { day: "Wed", hour: 14, count: 9, fold: "09-23 + today" },
  };
  const tokens = findNodes(render("HourGridNote", { grid }), (n) => n.props.atom === "NoWrap").map(collectText);
  assert.deepEqual(tokens, ["Wed ×2"], "the fold sentence holds the token in one nowrap span");
  const [chart] = findNodes(render("HourGrid", { grid }), (n) => n.props.role === "img");
  const [label] = findNodes(chart, (n) => n.props.title === "09-23 + today");
  assert.equal(label && collectText(label), "Wed ×2", "the row label names the folded weekday");
  assert.match(classOf(label), /\bwhitespace-nowrap\b/, "the row label never wraps inside its track");
});

describe("Runs by hour heat ramp", () => {
  const counts = [0, 1, 25, 50, 75, 100, ...Array.from({ length: 18 }, () => 0)];
  const grid = {
    rows: [{ day: "Mon", counts, fold: null }], total: 251, max: 100, span: "Sep 24 – Sep 30", folds: [],
    peak: { day: "Mon", hour: 5, count: 100, fold: null },
  };
  const tree = render("HourGrid", { grid });
  const [chart] = findNodes(tree, (n) => n.props.role === "img");
  const cells = findNodes(chart, (n) => hasClass(n, "dash-hour-cell"));

  test("each cell paints the heat step its count falls in, never the info hue or an opacity", () => {
    assert.deepEqual(cells.slice(0, 6).map((cell) => cell.props["data-heat"]), [0, 1, 1, 2, 3, 4]);
    for (const cell of cells) {
      assert.ok(!hasClass(cell, "text-info"), "no cell takes the info hue");
      assert.equal((cell.props.style as Record<string, unknown> | undefined)?.opacity, undefined, "no cell is quieted by opacity");
    }
  });

  test("the key states the zero swatch, the four steps and the peak, outside the accessible label", () => {
    const [key] = findNodes(tree, (n) => hasClass(n, "dash-hour-key"));
    assert.equal(key.props["aria-hidden"], "true");
    assert.deepEqual(findNodes(key, (n) => hasClass(n, "dash-hour-swatch")).map((n) => n.props["data-heat"]), [0, 1, 2, 3, 4]);
    // formatInt is a stubbed atom here → the peak figure itself is asserted in the e2e
    assert.match(collectText(key), /^0\s*1\s*runs per hour$/);
  });

  test("the method sentences leave the card body for its ⓘ", () => {
    assert.doesNotMatch(collectText(tree), /reconstructed|counted by weekday/, "the body carries no method sentence");
    assert.match(collectText(render("HourGridNote", { grid: { ...grid, folds: [{ day: "Wed", fold: "09-23 + today" }] } })),
      /reconstructed included, poisoned excluded[\s\S]*counted by weekday/);
  });
});

test("a zero spend day draws no bar, and every day's track stands on the baseline", () => {
  const strip = (mod.buildSpendStrip as (points: unknown) => unknown)(
    [["2026-11-10", 12.5], ["2026-11-11", 0], ["2026-11-12", 3.25]].map(([date, cost]) => ({ date, cost_usd: cost, session_count: 1 })),
  );
  const days = findNodes(render("SpendStrip", { strip }), (n) => n.type === "li");
  const barsOf = (day: RenderedNode) => findNodes(day, (n) => /\bdash-strip-(?:bar|partial)\b/.test(classOf(n))).length;
  assert.deepEqual(days.map(barsOf), [1, 0, 1], "only the zero day is bare");
  for (const day of days) {
    assert.equal(findNodes(day, (n) => n.props["data-chart-baseline"] === "").length, 1, "one baseline segment per day track");
  }
});

// --- The status card: one card, one StatRow of four stats (spec 44084 §9) ---

const READY_STAT = {
  id: "outcomes", label: "Task results", window: "7d", status: "ready", tone: "ok", value: "40",
  context: "7 of 40 failed or blocked", notes: [] as string[], target: "outcomes", region: "outcomes", source: "task results",
};
const FAILED_STAT = {
  ...READY_STAT, id: "fleet", label: "Fleet", status: "error", tone: "neutral", value: null, absent: "not-loaded",
  context: "Couldn't load the fleet summary.", region: "agents", source: "the fleet summary", error: "HTTP 500", canRetry: true,
  target: "agents",
};
interface StatItem { key: string; label: string; value: unknown; unit?: string; context: unknown; href?: string }

function renderStatusCard(stats: unknown[], extra: Record<string, unknown> = {}): { tree: RenderedNode; items: StatItem[] } {
  const tree = render("StatusCard", { stats, onRetry: () => {}, ...extra });
  const rows = findNodes(tree, (n) => n.props.atom === "StatRow");
  assert.equal(rows.length, 1, "one StatRow");
  return { tree, items: rows[0].props.stats as StatItem[] };
}

test("the status row is one card holding one StatRow of four stats, its labels in sentence case with the window joined", () => {
  const stats = ["harness", "outcomes", "fleet", "spend"].map((id) => ({ ...READY_STAT, id, label: id === "outcomes" ? "Task results" : "Harness health" }));
  const { tree, items } = renderStatusCard(stats);
  const cards = findNodes(tree, (n) => n.props.atom === "Card");
  assert.equal(cards.length, 1, "one card, never a tile per stat");
  assert.equal(items.length, 4);
  assert.equal(items[1].label, "Task results, 7d", "the window rides the label as 7d");
  assert.equal(findNodes(tree, (n) => /\b(uppercase|tracking-wide)\b/.test(classOf(n))).length, 0, "no uppercase or tracked label");
  assert.notEqual(String(cards[0].props.title), String(cards[0].props.title).toUpperCase(), "the card title is sentence case");
});

test("each stat's value is a Link to its owning screen; a loading stat links nowhere, says so in a placeholder and reserves its context line", () => {
  const { items } = renderStatusCard([READY_STAT, { ...READY_STAT, id: "spend", status: "loading", value: null, target: "cost" }]);
  assert.equal(items[0].href, "#outcomes");
  assert.equal(items[1].href, undefined);
  assert.equal(findNodes(nodeOf(items[1].value), (n) => n.props.atom === "LoadingPlaceholder").length, 1);
  const reserved = nodeOf(items[1].context);
  assert.equal(collectText(reserved).trim(), "", "a loading stat says nothing on its context line yet");
  assert.equal(reserved.props["aria-hidden"], "true", "the reserved line is hidden from assistive tech");
});

test("a firing stat shows its value and tone glyph only; a calm stat shows the value alone, and no stat carries a badge", () => {
  const rows = [
    { tone: "crit", hasGlyph: true }, { tone: "warn", hasGlyph: true },
    { tone: "ok", hasGlyph: false }, { tone: "info", hasGlyph: false }, { tone: "neutral", hasGlyph: false },
  ];
  for (const row of rows) {
    const { tree, items } = renderStatusCard([{ ...READY_STAT, tone: row.tone, value: "2 of 7 down" }]);
    const value = nodeOf(items[0].value);
    assert.equal(findNodes(value, (n) => n.props.atom === "Icon").length, row.hasGlyph ? 1 : 0, `${row.tone}: glyph`);
    assert.equal(findNodes(tree, (n) => n.props.atom === "Badge").length, 0, `${row.tone}: never a badge`);
    const text = collectText(value).replace(/\s+/g, " ").trim();
    assert.equal(text, row.hasGlyph ? `${realUi.ALERT_SEVERITY_WORD && (realUi.ALERT_SEVERITY_WORD as Record<string, string>)[row.tone]}: 2 of 7 down` : "2 of 7 down",
      `${row.tone}: the sr-only tone word is the only word beside the figure`);
    assert.equal(findNodes(value, (n) => hasClass(n, "whitespace-nowrap")).length, 1, `${row.tone}: the figure never wraps`);
  }
});

test("an absent value paints its kind's word through the shared AbsentValue, and a unit rides only a real figure", () => {
  const rows = [
    { name: "unread", stat: { ...READY_STAT, value: null, absent: "not-loaded", unit: "suspended" }, kind: "not-loaded", unit: undefined },
    { name: "empty", stat: { ...READY_STAT, value: null, absent: "none", unit: "suspended" }, kind: "none", unit: undefined },
    { name: "a figure", stat: { ...READY_STAT, value: "0", unit: "suspended" }, kind: null, unit: "suspended" },
  ];
  for (const row of rows) {
    const { items } = renderStatusCard([row.stat]);
    const absent = findNodes(nodeOf(items[0].value), (n) => n.props.atom === "AbsentValue");
    assert.equal(absent[0]?.props.kind ?? null, row.kind, row.name);
    assert.equal(items[0].unit, row.unit, `${row.name}: unit`);
  }
});

test("a failed stat states its error on the context line with its own Retry; a banner-covered one points up with none", () => {
  const retried: string[] = [];
  const own = renderStatusCard([FAILED_STAT], { onRetry: (region: string) => retried.push(region) });
  const context = nodeOf(own.items[0].context);
  assert.match(collectText(context), /Couldn't load the fleet summary/);
  const retries = findNodes(context, (n) => n.props.atom === "RetryButton");
  assert.equal(retries.length, 1, "one Retry, on the stat's own line");
  (retries[0].props.onRetry as () => void)();
  assert.deepEqual(retried, ["agents"], "the Retry reloads only the stat's own region");
  assert.equal(alertCardsOf(own.tree).length, 0, "no card nests inside the status card");

  const covered = renderStatusCard([FAILED_STAT], { sharedSources: ["the fleet summary"] });
  const coveredText = collectText(nodeOf(covered.items[0].context));
  assert.match(coveredText, /see the notice above/);
  assert.doesNotMatch(coveredText, /Couldn't load/, "the stat does not repeat the banner's sentence");
  assert.equal(findNodes(nodeOf(covered.items[0].context), (n) => n.props.atom === "RetryButton").length, 0, "the banner owns the only Retry");
});

test("a held stat's Retry is the shared control: in flight while busy, handing focus to the status card on recovery", () => {
  const heldStat = { ...READY_STAT, isHeld: true, context: "Last known — couldn't refresh task results", error: "HTTP 500", canRetry: true };
  for (const isBusy of [true, false]) {
    const { tree, items } = renderStatusCard([{ ...heldStat, isBusy }]);
    const [retry] = findNodes(nodeOf(items[0].context), (n) => n.props.atom === "RetryButton");
    assert.equal(retry.props.isBusy, isBusy);
    const targets = findNodes(tree, (n) => isHost(n) && n.props.id === retry.props.focusTargetId);
    assert.equal(targets.length, 1, "the focus target is the status card that outlives the Retry");
    assert.equal(targets[0].props["aria-busy"], isBusy ? "true" : undefined, "a refresh over held data marks the card busy");
  }
});

test("every stat note opens from the card's one ⓘ, each led by its stat's label; no note, no ⓘ", () => {
  const noted = { ...READY_STAT, notes: ["Counts only writer-emitted outcomes."] };
  const { tree } = renderStatusCard([noted, { ...READY_STAT, id: "spend", label: "Spend today", window: undefined }]);
  const [card] = findNodes(tree, (n) => n.props.atom === "Card");
  assert.match(collectText(nodeOf(card.props.info)).replace(/\s+/g, " "), /^Task results, 7d — Counts only writer-emitted outcomes\.$/);
  const bare = renderStatusCard([READY_STAT]);
  assert.ok(!findNodes(bare.tree, (n) => n.props.atom === "Card")[0].props.info, "no note → no ⓘ");
});

// the shared error copy is real here → a failed stat's next step and raw answer come from ui.jsx, not from the test
const failMod = (await loadScreenModule(DASH_SRC, {
  UI: new Proxy(uiStub() as Record<string, unknown>, {
    get: (stub, name: string) => (name === "getErrorCopy" ? realUi.getErrorCopy : stub[name]),
  }),
  React: createReactStub(),
})) as ScreenModule;

test("a failed stat hands the next step and the raw error to the card's one ⓘ, never only to its context line", () => {
  const unread = { status: "loading", data: null, error: null };
  const stats = (failMod.buildStats as (args: unknown) => Array<{ id: string; notes: string[] }>)({
    harness: { status: "loading" }, costState: unread, outcomesState: unread,
    agentsState: { status: "error", data: null, error: "HTTP 500 Internal Server Error" },
  });
  const copy = (realUi.getErrorCopy as (error: string, source: string) => { next: string; detail: string })(
    "HTTP 500 Internal Server Error", "the fleet summary",
  );
  const tree = renderScreen(failMod.React.createElement(failMod.StatusCard as Component, { stats, onRetry: () => {} })) as RenderedNode;
  const [card] = findNodes(tree, (n) => n.props.atom === "Card");
  const info = collectText(nodeOf(card.props.info)).replace(/\s+/g, " ");
  assert.ok(info.includes(copy.next), `the next step rides ⓘ: ${info}`);
  assert.ok(info.includes(copy.detail), `the raw error rides ⓘ: ${info}`);
});

test("a week panel heads with the shared Card head, and a held reading says Last known in plain words beside its title", () => {
  for (const [name, state, sub] of [["fresh", { data: {}, error: null }, null], ["held", { data: {}, error: "HTTP 500" }, "Last known"]] as const) {
    const tree = render("WeekPanel", { id: "dash-week-hours", title: "Runs by hour", source: "runs by hour", state, onRetry: () => {}, render: () => null });
    const cards = findNodes(tree, (n) => n.props.atom === "Card");
    assert.equal(cards.length, 1, name);
    assert.equal(cards[0].props.title, "Runs by hour", `${name}: the title rides the shared head`);
    assert.equal(cards[0].props.sub ?? null, sub, `${name}: sub`);
    assert.equal(findNodes(tree, (n) => n.props.atom === "Badge").length, 0, `${name}: never a badge`);
    assert.equal(findNodes(tree, (n) => n.type === "h2").length, 0, `${name}: no hand-built heading`);
  }
});
