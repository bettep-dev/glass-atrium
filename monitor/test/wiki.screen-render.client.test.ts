// Element-tree behaviour tests for the Wiki screen: disclosure affordance and the
// notes-per-day bars' labels. Exercises the shipped JSX through test/lib/render-screen.ts.
//
// Runner: npx tsx --test test/wiki.screen-render.client.test.ts

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
const WIKI_SRC = resolve(__dirname, "../public/src/screens/wiki.jsx");
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const realUi = ((await loadScreenModule(UI_SRC)) as { UI: Record<string, unknown> }).UI;

// window.UI stub — components resolve to transparent host elements; state helpers and constants stay real.
function uiStub(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        !/^[A-Z][a-z]/.test(name) && name in realUi
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

type Component = (props: unknown) => unknown;
interface ScreenModule {
  React: { createElement: (t: unknown, p: unknown) => unknown };
  [name: string]: unknown;
}

async function loadWikiScreen(): Promise<ScreenModule> {
  return (await loadScreenModule(WIKI_SRC, { UI: uiStub(), React: createReactStub() })) as ScreenModule;
}

function classOf(node: RenderedNode): string {
  return String(node.props.className ?? "");
}

test("every disclosure leads its summary with a chevron the screen's own style turns on open", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.ScreenWiki as Component, {}));

  const disclosures = findNodes(tree, (n) => n.type === "details");
  assert.ok(disclosures.length > 0, "the loading screen still renders its run-history disclosure");
  for (const details of disclosures) {
    assert.ok(classOf(details).includes("w-disclosure"), "the details carries the class the screen style targets");
    const summary = details.children[0] as RenderedNode;
    assert.equal(summary.type, "summary");
    const chevron = summary.children[0] as RenderedNode;
    assert.ok(classOf(chevron).includes("w-chevron"), "the chevron is the summary's first child");
    assert.equal(chevron.props["aria-hidden"], "true", "the chevron is decoration — the details reports its own state");
  }

  const style = collectText(findNodes(tree, (n) => n.type === "style")[0]);
  assert.match(style, /\.w-disclosure > summary::-webkit-details-marker\s*\{\s*display:\s*none/);
  assert.match(style, /\.w-disclosure\[open\] > summary \.w-chevron\s*\{\s*transform:\s*rotate\(90deg\)/);
});

test("the notes-per-day chart fills its panel with one dated bar per day and keeps the peak caption", async () => {
  const mod = await loadWikiScreen();
  const SparseTrendW = mod.SparseTrendW as Component;

  const dates = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];
  for (const [series, peakDate, peak] of [
    [[1, 2, 9, 3, 4], "2026-09-03", "9"],
    [[7, 1, 2, 3, 0], "2026-09-01", "7"],
  ] as const) {
    const tree = renderScreen(mod.React.createElement(SparseTrendW, { label: "Notes per day", series, dates }));
    const chart = findNodes(tree, (n) => n.props.atom === "TrendChart");
    assert.equal(chart.length, 1, "the shared chart atom draws the bars");
    assert.equal(chart[0].props.kind, "bars");
    assert.equal(chart[0].props.label, "Notes per day");
    assert.deepEqual(
      (chart[0].props.points as Array<{ label: string; value: number }>).map((p) => [p.label, p.value]),
      dates.map((d, i) => [d, series[i]]),
      "each bar carries its own date and count for the readout",
    );
    assert.ok(collectText(tree).includes(`peak ${peak} on ${peakDate}`), "the visible caption carries the peak value and date");
  }
});

test("the notes-per-day chart takes its edge labels and y-scale from the shared chart atom", async () => {
  const mod = await loadWikiScreen();
  const series = [1, 2, 9, 3, 4];
  const dates = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];
  const chartTree = renderScreen(mod.React.createElement(mod.SparseTrendW as Component, { label: "Notes per day", series, dates }));
  const screenTree = renderScreen(mod.React.createElement(mod.ScreenWiki as Component, {}));
  const getAnchor = realUi.getChartTickAnchor as (order: number, total: number) => string;

  const chart = findNodes(chartTree, (n) => n.props.atom === "TrendChart");
  assert.equal(chart[0].props.yScale, true, "the chart draws its max/min scale");
  assert.deepEqual([getAnchor(0, series.length), getAnchor(series.length - 1, series.length)], ["start", "end"], "the shared rule keeps the edge dates inside the panel");
  const style = collectText(findNodes(screenTree, (n) => n.type === "style")[0]);
  assert.doesNotMatch(style, /data-chart-tick/, "the screen no longer overrides the shared edge rule");
});

test("the run-history chart title states the number of days its bars show", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  for (const length of [5, 12]) {
    const cycles = Array.from({ length }, (_, i) => ({ run_date: `2026-09-${String(i + 1).padStart(2, "0")}`, compiled_count: i + 1, status: "ok" }));
    const tree = renderScreen(
      mod.React.createElement(mod.WikiRunHistorySection as Component, { cyclesState: ready({ cycles }), summaryState: ready({}), onRetry: () => {} }),
    );
    const chart = findNodes(tree, (n) => n.props.atom === "TrendChart")[0];
    const shown = (chart.props.points as unknown[]).length;
    assert.match(String(chart.props.label), new RegExp(`\\b${shown} days\\b`), "the title's day count is the bar count");
    assert.ok(collectText(tree).includes(`in ${shown} d`), "the headline total covers the same days");
  }
});

const LOADING = { status: "loading", data: null, error: null, busy: true };
const READY_BACKLOG = {
  status: "ready",
  error: null,
  data: { backlog: { run_date: "2026-09-24", dedup_proposals: { proposals: [{ cluster_hash: "c1", notes: ["a", "b"] }] } } },
};

function findSummaryHeading(tree: RenderedNode | string | null, label: string): RenderedNode | undefined {
  return findNodes(tree, (n) => n.type === "summary")
    .flatMap((summary) => findNodes(summary, (n) => n.type === "h2"))
    .find((h2) => collectText(h2) === label);
}

const RUN_HISTORY_LOADING = { cyclesState: LOADING, summaryState: LOADING, onRetry: () => {} };
const RUN_TABLE_LOADING = { reportState: LOADING, days: 30, onChangeDays: () => {}, onRetry: () => {} };

test("detail sections fold behind an h2 in their summary; status sections render open with a plain h2", async () => {
  const mod = await loadWikiScreen();
  const { createElement } = mod.React;
  const rows: Array<{ name: string; folds: boolean; element: unknown }> = [
    { name: "Merge proposals", folds: true, element: createElement(mod.WikiMaintenanceSection, { backlogState: READY_BACKLOG, onRetry: () => {} }) },
    { name: "Per-run table", folds: true, element: createElement(mod.WikiRunTableSection, RUN_TABLE_LOADING) },
    { name: "Run history", folds: false, element: createElement(mod.WikiRunHistorySection, RUN_HISTORY_LOADING) },
    { name: "Notes by type", folds: false, element: createElement(mod.WikiNotesByTypeSection, { state: LOADING, onRetry: () => {} }) },
  ];

  for (const row of rows) {
    const tree = renderScreen(row.element);
    const heading = findNodes(tree, (n) => n.type === "h2").find((h2) => collectText(h2) === row.name);
    assert.ok(heading, `${row.name} names itself with an h2`);
    if (!row.folds) {
      assert.equal(findNodes(tree, (n) => n.type === "details").length, 0, `${row.name} is open, never behind a click`);
      continue;
    }
    const summary = findNodes(tree, (n) => n.type === "summary").find((s) => findNodes(s, (n) => n === heading).length > 0);
    assert.ok(summary, `${row.name} keeps its h2 inside the toggling summary`);
    assert.equal((summary?.children[0] as RenderedNode).props["aria-hidden"], "true", `${row.name} keeps the chevron first`);
  }
});

test("the run-history trend and notes by type share one split row, the trend on the wider side", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.WikiStatusRow as Component, {
    cyclesState: LOADING, summaryState: LOADING, indexState: LOADING, onRetry: () => {},
  }));
  const split = findNodes(tree, (n) => n.props.atom === "SplitRow");
  assert.equal(split.length, 1);
  assert.equal(split[0].props.ratio, "2:1");
  const headings = findNodes(split[0], (n) => n.type === "h2").map((h) => collectText(h));
  assert.deepEqual(headings, ["Run history", "Notes by type"]);
});

test("one polite live region announces a wave in flight as loading", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.ScreenWiki as Component, {}));
  const regions = findNodes(tree, (n) => n.props["aria-live"] != null);
  assert.equal(regions.length, 1, "the screen owns exactly one live region");
  assert.equal(regions[0].props["aria-live"], "polite");
  assert.match(collectText(regions[0]), /^Loading/, "a wave in flight is announced as loading");
});

test("the wave announcement reads loading, then ready or the sections that failed", async () => {
  const mod = await loadWikiScreen();
  const describe = mod.describeWikiWaveW as (sections: Array<[{ status: string }, string]>) => string;
  const ready = { status: "ready" };
  const failed = { status: "error" };
  const cases: Array<{ name: string; sections: Array<[{ status: string }, string]>; match: RegExp; absent?: RegExp }> = [
    { name: "any read still loading", sections: [[ready, "run history"], [LOADING, "notes by type"]], match: /^Loading/ },
    { name: "every read ready", sections: [[ready, "run history"], [ready, "notes by type"]], match: /loaded/, absent: /couldn't/i },
    { name: "one read failed", sections: [[ready, "run history"], [failed, "notes by type"]], match: /couldn't load notes by type/i, absent: /run history/ },
    { name: "failure outranks nothing still loading", sections: [[failed, "run history"], [failed, "notes by type"]], match: /run history, notes by type/ },
    { name: "every read failed", sections: [[failed, "run history"], [failed, "notes by type"]], match: /^Couldn't load/, absent: /loaded/i },
    { name: "a refresh over held data", sections: [[{ status: "ready", busy: true } as { status: string }, "run history"], [ready, "notes by type"]], match: /^Refreshing/ },
  ];
  for (const row of cases) {
    const message = describe(row.sections);
    assert.match(message, row.match, row.name);
    if (row.absent) assert.doesNotMatch(message, row.absent, row.name);
  }
});

test("the page header carries the shared Refresh control, busy on the mount wave, and feeds every region to the stamp", async () => {
  const mod = await loadWikiScreen();
  const screen = renderScreen(mod.React.createElement(mod.ScreenWiki as Component, {}));
  const header = findNodes(screen, (n) => n.props.atom === "PageHeader")[0];
  const headerRight = renderScreen(header.props.right);

  const refresh = findNodes(headerRight, (n) => n.props.atom === "RefreshButton");
  assert.equal(refresh.length, 1, "the header carries one Refresh control");
  assert.equal(refresh[0].props.label, "Refresh wiki", "the accessible name stays stable");
  assert.equal(refresh[0].props.isBusy, true, "the mount wave is in flight");
  assert.equal(refresh[0].props.hasRead, false, "nothing has been read yet, so the first wave reads as loading");

  const stamp = findNodes(headerRight, (n) => n.props.atom === "FreshnessStamp")[0];
  assert.equal((stamp.props.regions as unknown[]).length, 5, "every fetched region feeds the stamp");
});

const OUTAGE = "HTTP 500 Internal Server Error — <html><body>relation wiki.notes does not exist</body></html>";

test("a failed section with no shared banner names its source in plain words and keeps its own Retry", async () => {
  const mod = await loadWikiScreen();
  const { createElement } = mod.React;
  const failed = { status: "error", data: null, error: OUTAGE, busy: false };
  const onRetry = () => {};
  const tree = renderScreen(createElement(mod.WikiNotesByTypeSection, { state: failed, shared: null, onRetry }));
  const cards = findNodes(tree, (n) => n.props.atom === "RegionFailure");
  assert.equal(cards.length, 1, "the section renders one failed-region card");
  assert.equal(cards[0].props.source, "notes by type");
  assert.equal(cards[0].props.shared, null, "no banner covers it, so the card speaks for itself");
  assert.equal(cards[0].props.onRetry, onRetry, "the section keeps its own Retry");
  assert.doesNotMatch(collectText(tree), /HTTP|relation/, "the raw answer stays behind the card's Details");
});

// Every failed region under one cause → each card is handed a banner that names its own label, so it renders covered.
test("under a shared outage every failed region defers to the banner under its own label", async () => {
  const mod = await loadWikiScreen();
  const { createElement } = mod.React;
  const failed = { status: "error", data: null, error: OUTAGE, busy: false };
  const shared = { sources: ["summary", "run history", "notes by type", "maintenance backlog", "per-run table"], error: OUTAGE };
  const onRetry = () => {};
  const rows = [
    { name: "tile band", element: createElement(mod.WikiTileBand, { summaryState: failed, indexState: failed, backlogState: failed, cyclesState: failed, at: null, shared, onRetry }) },
    { name: "run history", element: createElement(mod.WikiRunHistorySection, { cyclesState: failed, summaryState: failed, shared, onRetry }) },
    { name: "notes by type", element: createElement(mod.WikiNotesByTypeSection, { state: failed, shared, onRetry }) },
    { name: "per-run table", element: createElement(mod.WikiReportsBody, { state: failed, days: 30, shared, onRetry }) },
    { name: "maintenance backlog", element: createElement(mod.WikiMaintenanceSection, { backlogState: failed, cyclesState: failed, shared, onRetry }) },
  ];
  for (const row of rows) {
    const cards = findNodes(renderScreen(row.element), (n) => n.props.atom === "RegionFailure");
    assert.equal(cards.length, 1, `${row.name}: one failed-region card`);
    const covered = cards[0].props.shared as { sources: string[] } | null;
    assert.deepEqual(covered ? [...covered.sources] : null, [cards[0].props.source], `${row.name}: the banner covers the card's own label`);
    assert.ok(cards[0].props.focusTargetId, `${row.name}: the covered slot names a card for the banner's Retry to land on`);
  }
});

test("a tile-band feeder the banner does not cover keeps its own sentence beside a covered one", async () => {
  const mod = await loadWikiScreen();
  const failed = { status: "error", data: null, error: OUTAGE, busy: false };
  const shared = { sources: ["summary", "run history"], error: OUTAGE };
  const tree = renderScreen(mod.React.createElement(mod.WikiTileBand, {
    summaryState: failed, indexState: failed, backlogState: LOADING, cyclesState: failed, at: null, shared, onRetry: () => {},
  }));
  const cards = findNodes(tree, (n) => n.props.atom === "RegionFailure");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].props.source, "the search index", "only the uncovered feeder is named");
  assert.equal(cards[0].props.shared, null, "the uncovered feeder is not quieted by the banner");
});

test("the page banner shows its Retry in flight and hands focus to the verdict, which outlives recovery", async () => {
  const initial = realUi.INITIAL_REGION_STATE as Record<string, unknown>;
  // the state putRegionRequest leaves behind when Retry is clicked on a region that never loaded
  const retrying = { ...initial, status: "loading", data: null, error: OUTAGE, busy: true };
  const ui = new Proxy(uiStub() as Record<string, unknown>, {
    get: (target, name: string) => (name === "INITIAL_REGION_STATE" ? retrying : target[name]),
  });
  const mod = (await loadScreenModule(WIKI_SRC, { UI: ui, React: createReactStub() })) as ScreenModule;
  const tree = renderScreen(mod.React.createElement(mod.ScreenWiki as Component, {}));

  const banners = findNodes(tree, (n) => n.props.atom === "PageErrorBanner");
  assert.equal(banners.length, 1, "every section failing on one cause lifts to one page banner");
  assert.equal(banners[0].props.isBusy, true, "a Retry in flight marks the banner busy");
  // host nodes only — a stubbed atom also appears as its component node
  const targets = findNodes(tree, (n) => /^[a-z]/.test(n.type) && n.props.id === banners[0].props.focusTargetId);
  assert.equal(targets.length, 1, `focus target ${String(banners[0].props.focusTargetId)} is one rendered element`);
  assert.notEqual(targets[0].props.atom, "PageErrorBanner", "focus lands outside the banner that unmounts on recovery");
});

test("the page banner covers an outage only when two or more sections fail for one cause", async () => {
  const mod = await loadWikiScreen();
  const readOutage = mod.readWikiOutageW as (sections: Array<[unknown, string]>) => { sources: string[] } | null;
  const ok = { status: "ready", data: {}, error: null };
  const down = { status: "error", data: null, error: OUTAGE };
  const offline = { status: "error", data: null, error: "Failed to fetch" };
  const rows = [
    { name: "one failure stays in its section", sections: [[down, "run history"], [ok, "notes by type"]], sources: null },
    { name: "a shared cause lifts to the page", sections: [[down, "run history"], [down, "notes by type"], [ok, "summary"]], sources: ["run history", "notes by type"] },
    { name: "different causes stay per section", sections: [[down, "run history"], [offline, "notes by type"]], sources: null },
  ] as const;
  for (const row of rows) {
    const outage = readOutage(row.sections as unknown as Array<[unknown, string]>);
    assert.deepEqual(outage ? [...outage.sources] : null, row.sources, row.name);
  }
});

test("the run table sits in page scroll with a caption and scoped column heads", async () => {
  const mod = await loadWikiScreen();
  const reports = [{ run_date: "2026-09-24", status: "ok", deadlinks_count: 0, dedup_count: 3 }];
  const tree = renderScreen(mod.React.createElement(mod.WikiReportsTable as Component, { reports }));
  const table = findNodes(tree, (n) => n.props.atom === "Table");
  assert.equal(table.length, 1, "the shared Table atom carries the caption and th scope");
  assert.ok(String(table[0].props.caption).length > 0, "the table has a caption");
  for (const node of findNodes(tree, () => true)) {
    const style = (node.props.style ?? {}) as Record<string, unknown>;
    assert.equal(style.maxHeight, undefined, "no inner vertical scroller clips the rows");
    assert.doesNotMatch(classOf(node), /overflow-y-auto|max-h-/, "no inner vertical scroller clips the rows");
  }
});

const ERRORED = { status: "error", data: null, error: "boom" };

test("the merge-proposals disclosure stays in place while loading and after a failure, with its state in the count", async () => {
  const mod = await loadWikiScreen();
  const rows = [
    { name: "loading", state: LOADING, count: "Loading…" },
    { name: "error", state: ERRORED, count: "Unavailable" },
    { name: "ready", state: READY_BACKLOG, count: "1" },
  ];
  for (const row of rows) {
    const tree = renderScreen(mod.React.createElement(mod.WikiMaintenanceSection as Component, { backlogState: row.state, onRetry: () => {} }));
    const heading = findSummaryHeading(tree, "Merge proposals");
    assert.ok(heading, `${row.name}: the disclosure renders`);
    const summary = findNodes(tree, (n) => n.type === "summary").find((s) => findNodes(s, (n) => n === heading).length > 0);
    assert.ok(collectText(summary ?? null).includes(row.count), `${row.name}: the count reads ${row.count}`);
  }
});

function backlogFirstSeen(daysAgo: number): unknown {
  const since = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const { backlog } = READY_BACKLOG.data;
  return { ...READY_BACKLOG, data: { backlog: { ...backlog, proposal_first_seen: { c1: since } } } };
}

test("the merge-proposals fold opens itself only while it holds a waiting (warn) proposal", async () => {
  const mod = await loadWikiScreen();
  const rows = [
    { name: "a proposal inside its waiting window", state: backlogFirstSeen(1), isOpen: true },
    { name: "an undated proposal with no run streak yet", state: READY_BACKLOG, isOpen: true },
    { name: "only parked pairs", state: backlogFirstSeen(30), isOpen: false },
    { name: "the backlog still loading", state: LOADING, isOpen: false },
  ];
  for (const row of rows) {
    const tree = renderScreen(mod.React.createElement(mod.WikiMaintenanceSection as Component, { backlogState: row.state, onRetry: () => {} }));
    const fold = findNodes(tree, (n) => n.type === "details" && n.props.id === "wiki-merge-proposals")[0];
    assert.ok(fold, `${row.name}: the fold renders`);
    assert.equal(fold.props.open === true, row.isOpen, `${row.name}: starts ${row.isOpen ? "open" : "folded"}`);
  }
});

test("a merge proposal's reasons wrap in full", async () => {
  const mod = await loadWikiScreen();
  const proposal = { cluster_hash: "c1", target_slug: "t", source_slugs: ["s"], suggested_action: "merge because both notes describe one concept" };
  const tree = renderScreen(mod.React.createElement(mod.MergeSuggestionItem as Component, { proposal }));
  for (const node of findNodes(tree, () => true)) {
    assert.doesNotMatch(classOf(node), /\btruncate\b/, "no part of the proposal hides behind a hover title");
  }
});

test("the alarm lane keeps actionable rows only; waiting proposals ride the verdict line instead", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const tree = renderScreen(
    mod.React.createElement(mod.WikiAlarmLane as Component, {
      summaryState: ready({}),
      indexState: ready({ has_dirty_flag: true, dirty: true, last_dirty_ms: 1 }),
      backlogState: READY_BACKLOG,
      cyclesState: ready({ cycles: [] }),
    }),
  );
  const rows = findNodes(tree, (n) => classOf(n).split(/\s+/).includes("alarm-row"));
  assert.equal(rows.length, 1, "the dirty index only");
  assert.doesNotMatch(collectText(tree), /Merge proposal/);
  assert.equal(findNodes(tree, (n) => n.type === "button").length, 0);
});

test("the page opens on one verdict line that carries no signal before anything loads", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.ScreenWiki as Component, {}));
  const verdict = findNodes(tree, (n) => n.props.atom === "PageVerdict");
  assert.equal(verdict.length, 1);
  assert.equal(verdict[0].props.tone, "neutral", "nothing loaded yet → no signal");
});

test("the verdict's proposals chip targets the merge-proposals fold, which opens on focus", async () => {
  const mod = await loadWikiScreen();
  const fold = renderScreen(mod.React.createElement(mod.WikiMaintenanceSection as Component, { backlogState: READY_BACKLOG, onRetry: () => {} }));
  const details = findNodes(fold, (n) => n.type === "details")[0];
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const chip = (mod.buildWikiVerdictW as (...states: unknown[]) => { chips: Array<{ targetId: string }> })(
    ready({}), ready({}), READY_BACKLOG, ready({ cycles: [] }),
  ).chips[0];
  assert.ok(details.props.id, "the fold carries an id");
  assert.equal(chip.targetId, details.props.id, "the chip's target is the fold itself");
  assert.equal(typeof details.props.onFocus, "function", "focus from the chip opens the fold");
});

test("the per-run table gives every run its own row, unchanged runs included", async () => {
  const mod = await loadWikiScreen();
  const dates = ["2026-09-24", "2026-09-23", "2026-09-22"];
  const reports = dates.map((run_date) => ({ run_date, status: "ok", deadlinks_count: 0, dedup_count: 3 }));
  const tree = renderScreen(mod.React.createElement(mod.WikiReportsTable as Component, { reports }));
  const rows = findNodes(tree, (n) => n.type === "tr");
  assert.deepEqual(rows.map((row) => dates.find((d) => collectText(row).includes(d))), dates);
});

test("the maintenance section adds no broken-link line of its own", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.WikiMaintenanceSection as Component, { backlogState: READY_BACKLOG, onRetry: () => {} }));
  assert.doesNotMatch(collectText(tree), /broken link/i);
});

test("alarms are flat hairline rows whose tone rides a leading glyph, with no stripe", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const lane = renderScreen(
    mod.React.createElement(mod.WikiAlarmLane as Component, {
      summaryState: ready({ hours_since_last_cycle: 40, last_run_date: "2026-09-20" }),
      indexState: ready({ has_dirty_flag: true, dirty: true, last_dirty_ms: 1 }),
      backlogState: READY_BACKLOG, cyclesState: ready({ cycles: [] }),
    }),
  );
  const rows = findNodes(lane, (n) => classOf(n).split(/\s+/).includes("alarm-row"));
  assert.equal(rows.length, 2, "the dirty index and the missed cycle");
  for (const row of rows) {
    assert.ok(row.props["data-tone"], "each row names its tone");
    assert.equal(findNodes(row, (n) => /\balarm-row-glyph\b/.test(classOf(n))).length, 1);
  }
  const table = renderScreen(
    mod.React.createElement(mod.WikiReportsTable as Component, { reports: [{ run_date: "2026-09-24", status: "error", deadlinks_count: 0, dedup_count: 0 }] }),
  );
  for (const tree of [lane, table]) {
    assert.equal(findNodes(tree, (n) => /\bsev-bar\b/.test(classOf(n))).length, 0, "no left-border stripe");
  }
});

test("wiki text never drops below the 12px step and words are never set in mono", async () => {
  const mod = await loadWikiScreen();
  const { createElement } = mod.React;
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const trees = [
    renderScreen(createElement(mod.WikiAlarmLane, { summaryState: ready({}), indexState: ready({ has_dirty_flag: true, dirty: true, last_dirty_ms: 1 }), backlogState: READY_BACKLOG, cyclesState: ready({ cycles: [] }) })),
    renderScreen(createElement(mod.WikiTileBand, { summaryState: ready({}), indexState: ready({ has_dirty_flag: true, dirty: false, last_dirty_ms: 1 }), backlogState: READY_BACKLOG, onRetry: () => {} })),
    renderScreen(createElement(mod.WikiRunHistorySection, { cyclesState: ready({ cycles: [] }), summaryState: ready({}), reportState: ready({ reports: [] }), days: 30, onChangeDays: () => {}, onRetry: () => {} })),
    renderScreen(createElement(mod.WikiMaintenanceSection, { backlogState: READY_BACKLOG, onRetry: () => {} })),
    renderScreen(createElement(mod.MergeSuggestionItem, { proposal: { cluster_hash: "c1", target_slug: "t", source_slugs: ["s"], suggested_action: "merge because both notes describe one concept" } })),
  ];
  const words = ["Search index", "Clean", "Merge proposals", "Run history", "merge because both notes describe one concept"];
  const seen = new Set<string>();
  for (const tree of trees) {
    for (const node of findNodes(tree, () => true)) {
      assert.doesNotMatch(classOf(node), /\bfs-micro\b/, "the 11px step is retired");
      const ownText = node.children.filter((c) => typeof c === "string").join("").trim();
      if (words.includes(ownText)) {
        seen.add(ownText);
        assert.doesNotMatch(classOf(node), /\bfont-mono\b/, `"${ownText}" is words, not an id or figure`);
      }
    }
  }
  assert.deepEqual(words.filter((w) => !seen.has(w)), [], "every listed word renders, so the mono check ran for each");
});

test("cyan tints no wiki text: the similarity reads as a figure and the lane stays uncoloured", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const proposal = { cluster_hash: "c1", target_slug: "t", source_slugs: ["s"], similarity_score: 1 };
  const item = renderScreen(mod.React.createElement(mod.MergeSuggestionItem as Component, { proposal }));
  const lane = renderScreen(
    mod.React.createElement(mod.WikiAlarmLane as Component, {
      summaryState: ready({}), indexState: ready({}), backlogState: READY_BACKLOG, cyclesState: ready({ cycles: [] }),
    }),
  );
  const sim = findNodes(item, (n) => n.children.join("") === "100% similar").pop();
  assert.ok(sim, "the similarity reads in words");
  for (const tree of [item, lane]) {
    for (const node of findNodes(tree, () => true)) assert.doesNotMatch(classOf(node), /\btext-info\b/);
  }
});

test("the window control rides the per-run table fold and never the open trend", async () => {
  const mod = await loadWikiScreen();
  const control = (tree: RenderedNode | string | null) => findNodes(tree, (n) => n.props["aria-label"] === "Run table time range");
  assert.equal(control(renderScreen(mod.React.createElement(mod.WikiRunTableSection as Component, RUN_TABLE_LOADING))).length, 1);
  assert.equal(control(renderScreen(mod.React.createElement(mod.WikiRunHistorySection as Component, RUN_HISTORY_LOADING))).length, 0);
});

test("the dry-run notice is stated once above the proposals instead of on every proposal", async () => {
  const mod = await loadWikiScreen();
  const action = (slug: string) => `Merge notes/${slug}.md into notes/t.md. DRY-RUN \u2014 requires user approval.`;
  const backlog = {
    status: "ready",
    error: null,
    data: { backlog: { run_date: "2026-09-24", dedup_proposals: { proposals: [
      { cluster_hash: "c1", target_slug: "t", source_slugs: ["s1"], suggested_action: action("s1") },
      { cluster_hash: "c2", target_slug: "t", source_slugs: ["s2"], suggested_action: action("s2") },
    ] } } },
  };
  const text = collectText(renderScreen(mod.React.createElement(mod.WikiMaintenanceSection as Component, { backlogState: backlog, onRetry: () => {} })));

  assert.equal(text.match(/dry[ -]run/gi)?.length, 1, "one notice for the whole list");
  assert.ok(text.search(/dry[ -]run/i) < text.indexOf("s1"), "the notice sits above the first proposal");
});

test("every merge proposal states in text which note absorbs which, not only by the arrow glyph", async () => {
  const mod = await loadWikiScreen();
  const backlog = {
    status: "ready",
    error: null,
    data: { backlog: { run_date: "2026-09-24", dedup_proposals: { proposals: [
      { cluster_hash: "c1", target_slug: "keep-a", source_slugs: ["drop-1"], suggested_action: "Merge notes/drop-1.md into notes/keep-a.md." },
      { cluster_hash: "c2", target_slug: "keep-b", source_slugs: ["drop-2", "drop-3"], suggested_action: "Merge notes/drop-2.md into notes/keep-b.md." },
    ] } } },
  };
  const tree = renderScreen(mod.React.createElement(mod.WikiMaintenanceSection as Component, { backlogState: backlog, onRetry: () => {} }));
  const rows = findNodes(tree, (n) => n.type === "li").map((n) => collectText(n));

  assert.equal(rows.length, 2);
  assert.match(rows[0], /keep-a\s*absorbs\s*drop-1/);
  assert.match(rows[1], /keep-b\s*absorbs\s*drop-2, drop-3/);
});

test("the missed-cycle alarm states its age in the short relative form", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const lane = renderScreen(
    mod.React.createElement(mod.WikiAlarmLane as Component, {
      summaryState: ready({ hours_since_last_cycle: 40, last_run_date: "2026-09-20" }),
      indexState: ready({}), backlogState: READY_BACKLOG, cyclesState: ready({ cycles: [] }),
    }),
  );
  assert.match(collectText(lane), /· 40h ago —/);
});

test("the last-run age reads as words, so its space never widens into a mono gap", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const startedAt = new Date(Date.now() - 21 * 3_600_000).toISOString();
  const band = renderScreen(
    mod.React.createElement(mod.WikiTileBand as Component, {
      summaryState: ready({ last_cycle_started_at: startedAt, hours_since_last_cycle: 21, last_status: "ok", last_run_date: "2026-09-29" }),
      indexState: ready({}), backlogState: READY_BACKLOG, onRetry: () => {},
    }),
  );
  const age = findNodes(band, (n) => n.children.some((c) => typeof c === "string" && /^\d+h ago$/.test(c)));
  assert.equal(age.length, 1, "the tile shows the run's age");
  assert.doesNotMatch(classOf(age[0]), /\bfont-mono\b/);
});

test("tile labels and captions wrap instead of cutting the figure's words", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const band = renderScreen(
    mod.React.createElement(mod.WikiTileBand as Component, {
      summaryState: ready({ last_cycle_started_at: new Date().toISOString(), latest_compiled_count: 0, last_status: "ok" }),
      indexState: ready({}), backlogState: READY_BACKLOG,
      cyclesState: ready({ cycles: [{ run_date: "2026-09-01", compiled_count: 22 }, { run_date: "2026-09-29", compiled_count: 0 }] }),
      onRetry: () => {},
    }),
  );
  assert.ok(collectText(band).includes("22 in 29 d"), "the window total is on the page");
  for (const node of findNodes(band, () => true)) assert.doesNotMatch(classOf(node), /\btruncate\b/);
});

test("a feeder the alarm list could not read is named in plain words", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const lane = renderScreen(
    mod.React.createElement(mod.WikiAlarmLane as Component, {
      summaryState: ready({ hours_since_last_cycle: 2 }), indexState: ERRORED, backlogState: READY_BACKLOG, cyclesState: ready({ cycles: [] }),
    }),
  );
  const text = collectText(lane);
  assert.doesNotMatch(text, /\blane\b|incomplete/i);
  assert.match(text, /alarms? from .+ (are|is) not shown/i);
});

test("a loading open card or tile states loading once, through its placeholder, not its count or caption", async () => {
  const mod = await loadWikiScreen();
  const trees = [
    renderScreen(mod.React.createElement(mod.WikiRunHistorySection as Component, RUN_HISTORY_LOADING)),
    renderScreen(mod.React.createElement(mod.WikiNotesByTypeSection as Component, { state: LOADING, onRetry: () => {} })),
    renderScreen(mod.React.createElement(mod.WikiTileBand as Component, { summaryState: LOADING, indexState: LOADING, backlogState: LOADING, cyclesState: LOADING, onRetry: () => {} })),
  ];
  for (const tree of trees) assert.doesNotMatch(collectText(tree), /loading/i);
  assert.equal(findNodes(trees[0], (n) => n.props.atom === "LoadingPlaceholder").length, 1);
  assert.equal(findNodes(trees[1], (n) => n.props.atom === "LoadingPlaceholder").length, 1);
  assert.equal(findNodes(trees[2], (n) => n.props["aria-busy"] === "true").length, 4, "each tile still reports busy");
});

test("the two status cards fill their shared row, so Notes by type ends level with Run history", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const row = renderScreen(
    mod.React.createElement(mod.WikiStatusRow as Component, {
      cyclesState: ready({ cycles: [] }), summaryState: ready({}), indexState: ready({ by_type: [{ note_type: "raw", count: 3 }] }), onRetry: () => {},
    }),
  );
  const cards = findNodes(row, (n) => n.type === "section");
  assert.equal(cards.length, 2);
  for (const card of cards) assert.match(classOf(card), /\bh-full\b/);
});
