// Element-tree behaviour tests for the Wiki screen: disclosure affordance and the
// notes-per-day bars' labels. Exercises the shipped JSX through test/lib/render-screen.ts.
//
// Runner: npx tsx --test test/wiki.screen-render.client.test.ts

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
const WIKI_SRC = resolve(__dirname, "../public/src/screens/wiki.jsx");
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const uiModule = (await loadScreenModule(UI_SRC)) as { UI: Record<string, unknown>; React: { createElement: (t: unknown, p: unknown) => unknown } };
const realUi = uiModule.UI;

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
  React: { createElement: (t: unknown, p: unknown, ...children: unknown[]) => unknown };
  [name: string]: unknown;
}

async function loadWikiScreen(): Promise<ScreenModule> {
  return (await loadScreenModule(WIKI_SRC, { UI: uiStub(), React: createReactStub() })) as ScreenModule;
}

function classOf(node: RenderedNode): string {
  return String(node.props.className ?? "");
}

// StatRow is a stub atom here → the band's stats render through the real atom
function renderStatsOf(mod: ScreenModule, band: RenderedNode | string | null): RenderedNode | string | null {
  const rows = findNodes(band, (n) => n.props.atom === "StatRow");
  assert.equal(rows.length, 1, "the band mounts one stat row");
  return renderScreen(mod.React.createElement(realUi.StatRow, rows[0].props));
}

test("every disclosure leads its summary with the shared chevron the disclosure atom turns on open", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.ScreenWiki as Component, {}));

  const disclosures = findNodes(tree, (n) => n.type === "details");
  assert.ok(disclosures.length > 0, "the loading screen still renders its run-history disclosure");
  for (const details of disclosures) {
    const summary = details.children[0] as RenderedNode;
    assert.equal(summary.type, "summary");
    assert.ok(classOf(summary).split(/\s+/).includes("disclosure"), "the summary sits on the shared disclosure atom");
    const chevron = summary.children[0] as RenderedNode;
    assert.equal(chevron.type, "DisclosureChevron", "the shared decorative chevron is the summary's first child");
  }

  const style = collectText(findNodes(tree, (n) => n.type === "style")[0]);
  assert.doesNotMatch(style, /details-marker|rotate\(/, "the marker and the open turn come from the atom, not the screen");
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

test("a day with no notes draws no bar on the notes-per-day chart, only the shared baseline", async () => {
  const mod = await loadWikiScreen();
  const series = [1, 0, 9, 3, 0, 0, 4];
  const dates = series.map((_, i) => `2026-09-0${i + 1}`);
  const tree = renderScreen(mod.React.createElement(mod.SparseTrendW as Component, { label: "Notes per day", series, dates }));
  const [chart] = findNodes(tree, (n) => n.props.atom === "TrendChart");

  const drawn = renderScreen(uiModule.React.createElement(realUi.TrendChart, chart.props));

  assert.equal(findNodes(drawn, (n) => n.type === "rect").length, series.filter((count) => count > 0).length, "one bar per day with notes");
  assert.equal(findNodes(drawn, (n) => n.props["data-chart-baseline"] !== undefined).length, 1);
});

test("a series with too few active days states the gap through the shared empty state instead of a chart", async () => {
  const mod = await loadWikiScreen();
  const dates = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];

  const tree = renderScreen(mod.React.createElement(mod.SparseTrendW as Component, { label: "Notes per day", series: [0, 3, 0, 5, 1], dates }));

  const empty = findNodes(tree, (n) => n.props.atom === "EmptyState");
  assert.equal(empty.length, 1, "the shared empty-state atom carries the sparse note");
  assert.equal(empty[0].props.message, "Too few active days to draw a trend.");
  assert.equal(findNodes(tree, (n) => n.props.atom === "TrendChart").length, 0, "no chart is drawn for a sparse series");
  assert.equal(findNodes(tree, (n) => /\bplaceholder\b/.test(classOf(n))).length, 0, "the screen sets no placeholder class of its own");
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
    assert.ok(collectText(tree).includes(`in ${shown}d`), "the headline total covers the same days");
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

test("detail sections fold behind an h2 in their summary; status sections render open as titled cards", async () => {
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
    if (!row.folds) {
      assert.deepEqual(findCardTitles(tree), [row.name], `${row.name} names itself through the shared card's heading`);
      assert.equal(findNodes(tree, (n) => n.type === "details").length, 0, `${row.name} is open, never behind a click`);
      continue;
    }
    const heading = findNodes(tree, (n) => n.type === "h2").find((h2) => collectText(h2) === row.name);
    assert.ok(heading, `${row.name} names itself with an h2`);
    const summary = findNodes(tree, (n) => n.type === "summary").find((s) => findNodes(s, (n) => n === heading).length > 0);
    assert.ok(summary, `${row.name} keeps its h2 inside the toggling summary`);
    assert.equal((summary?.children[0] as RenderedNode).type, "DisclosureChevron", `${row.name} keeps the chevron first`);
    const [card] = findNodes(tree, (n) => classOf(n).split(/\s+/).includes("card"));
    assert.equal(findNodes(card ?? null, (n) => n.type === "details").length, 1, `${row.name}'s fold is itself the card`);
    for (const node of findNodes(card ?? null, () => true).filter((n) => n !== card)) {
      assert.doesNotMatch(classOf(node), /(^|\s)(border|bg-sunken|rounded-md)(\s|$)/, `${row.name} draws no second box inside its card`);
    }
  }
});

// Visible prose under a node — an ⓘ drawer's content is opened on demand, so it is not part of the line.
function getVisibleStrings(node: RenderedNode | string | null): string[] {
  if (node === null) return [];
  if (typeof node === "string") return node.trim() ? [node.trim()] : [];
  if (node.props.atom === "CardInfo") return [];
  return node.children.flatMap(getVisibleStrings);
}

test("the Per-run fold's body prose fits the 90-char footnote cap, a longer qualifier behind its ⓘ", async () => {
  const FOOTNOTE_CAP = 90;
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.WikiRunTableSection as Component, RUN_TABLE_LOADING));
  const [fold] = findNodes(tree, (n) => n.type === "details");
  const body = fold.children.filter((child) => typeof child === "string" || child.type !== "summary");
  const lines = body.flatMap(getVisibleStrings);

  assert.ok(lines.length > 0, "the fold body carries a note");
  for (const line of lines) assert.ok(line.length <= FOOTNOTE_CAP, `"${line.slice(0, 40)}…" is ${line.length} chars`);
  assert.equal(findNodes(fold, (n) => n.props.atom === "CardInfo").length, 1, "the change definition opens from one ⓘ");
});

// R-c: the trend note hands its sentence to the shared DayTokens atom, so "30-day" never breaks at its hyphen
test("the Per-run fold's trend note rides DayTokens, so its N-day window stays whole", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.WikiRunTableSection as Component, RUN_TABLE_LOADING));
  const notes = findNodes(tree, (n) => n.props.atom === "DayTokens").map((n) => String(n.props.children));
  assert.equal(notes.length, 1, "one note rides DayTokens");
  assert.match(notes[0], /^The window drives the table only — the trend keeps a fixed \d+-day window\.$/);
});

test("the Per-run fold body is flush so the table's edge cells hold the one card-pad column, controls on the card bar", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.WikiRunTableSection as Component, RUN_TABLE_LOADING));
  const [fold] = findNodes(tree, (n) => n.type === "details");
  const [body] = fold.children.filter((child): child is RenderedNode => typeof child !== "string" && child.type !== "summary");
  const [controls] = findNodes(fold, (n) => n.props.atom === "Cluster");

  assert.doesNotMatch(classOf(body), /\bp[xb]-card-pad\b/, "the body adds no inline inset of its own");
  assert.match(String(controls.props.className), /\bcard-bar\b/);
});

test("the Per-run failure block takes the card inset itself inside the flush fold", async () => {
  const mod = await loadWikiScreen();
  const failed = { status: "error", data: null, error: OUTAGE, busy: false };
  const tree = renderScreen(mod.React.createElement(mod.WikiReportsBody as Component, { state: failed, days: 30, shared: null, onRetry: () => {} }));
  const insets = findNodes(tree, (n) => /\bpx-card-pad\b/.test(classOf(n)) && findNodes(n, (m) => m.props.atom === "RegionFailure").length > 0);

  assert.equal(insets.length, 1);
});

test("the Per-run fold's ⓘ is described by the fold's own heading", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.WikiRunTableSection as Component, RUN_TABLE_LOADING));
  const [trigger] = findNodes(tree, (n) => n.props.atom === "CardInfo");
  const [described] = findNodes(tree, (n) => n.props.id !== undefined && n.props.id === trigger.props.describedBy);

  assert.equal(described?.type, "h2", "the described-by id names a heading");
  assert.deepEqual(described?.children, ["Per-run table"]);
});

test("the run-history trend and notes by type share one split row, the trend on the wider side", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.WikiStatusRow as Component, {
    cyclesState: LOADING, summaryState: LOADING, indexState: LOADING, onRetry: () => {},
  }));
  const split = findNodes(tree, (n) => n.props.atom === "SplitRow");
  assert.equal(split.length, 1);
  assert.equal(split[0].props.ratio, "2:1");
  assert.equal(split[0].props.layout, "equal", "the peers stretch to one edge");
  assert.deepEqual(findCardTitles(split[0]), ["Run history", "Notes by type"]);
});

// Card stays a stub here → its title prop is the heading the real atom renders.
function findCardTitles(tree: RenderedNode | string | null): string[] {
  return findNodes(tree, (n) => n.props.atom === "Card").map((card) => String(card.props.title));
}

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
  // each control rides its own named slot
  const refresh = findNodes(renderScreen(header.props.refresh), (n) => n.props.atom === "RefreshButton");
  assert.equal(refresh.length, 1, "the header carries one Refresh control");
  assert.equal(refresh[0].props.label, "Refresh wiki", "the accessible name stays stable");
  assert.equal(refresh[0].props.isBusy, true, "the mount wave is in flight");
  assert.equal(refresh[0].props.hasRead, false, "nothing has been read yet, so the first wave reads as loading");

  const stamp = findNodes(renderScreen(header.props.freshness), (n) => n.props.atom === "FreshnessStamp")[0];
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

// every region of the page starts from this one state
async function renderWikiInState(region: Record<string, unknown>): Promise<RenderedNode> {
  const ui = new Proxy(uiStub() as Record<string, unknown>, {
    get: (target, name: string) => (name === "INITIAL_REGION_STATE" ? region : target[name]),
  });
  const mod = (await loadScreenModule(WIKI_SRC, { UI: ui, React: createReactStub() })) as ScreenModule;
  return renderScreen(mod.React.createElement(mod.ScreenWiki as Component, {})) as RenderedNode;
}

describe("the page banner's Retry hands focus to a region card every page state renders", () => {
  const initial = realUi.INITIAL_REGION_STATE as Record<string, unknown>;
  // the state putRegionRequest leaves behind when Retry is clicked on a region that never loaded
  const retrying = { ...initial, status: "loading", data: null, error: OUTAGE, busy: true };
  const getBanners = (tree: RenderedNode) => findNodes(tree, (n) => n.props.atom === "PageErrorBanner");

  test("an outage over every section is one banner with its Retry in flight", async () => {
    const banners = getBanners(await renderWikiInState(retrying));

    assert.equal(banners.length, 1, "every section failing on one cause lifts to one page banner");
    assert.equal(banners[0].props.isBusy, true, "a Retry in flight marks the banner busy");
  });

  const rows = [
    { name: "loading", region: { ...initial, status: "loading", data: null, error: null, busy: true } },
    { name: "error with the Retry in flight", region: retrying },
    { name: "ready", region: { status: "ready", data: {}, error: null, busy: false } },
  ];
  for (const row of rows) {
    test(`${row.name}: the fallback card renders once, outside the banner`, async () => {
      const fallbackId = getBanners(await renderWikiInState(retrying))[0].props.focusTargetId;
      // host nodes only — a stubbed atom also appears as its component node
      const targets = findNodes(await renderWikiInState(row.region), (n) => /^[a-z]/.test(n.type) && n.props.id === fallbackId);

      assert.equal(targets.length, 1, `focus target ${String(fallbackId)} is one rendered element`);
      assert.notEqual(String(targets[0].props.atom), "PageErrorBanner", "never the banner that unmounts on recovery");
    });
  }
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
    assert.doesNotMatch(classOf(node), /overflow-x-auto|\bborder\b|rounded-md/, "the Table's own wrapper is the only box");
  }
});

// Table is a stub atom here → its row function renders against a wide view
function renderTableRowsOf(mod: ScreenModule, tree: RenderedNode | string | null): RenderedNode | string | null {
  const [table] = findNodes(tree, (n) => n.props.atom === "Table");
  // the stub's createElement keeps children as an array → the one child is the row function
  const [rows] = [table.props.children].flat() as Array<(view: unknown) => unknown>;
  const columnCount = (table.props.columns as unknown[]).length;
  return renderScreen(mod.React.createElement("tbody", null, rows({ isStacked: false, columnCount })));
}

function renderRunRowsOf(mod: ScreenModule, reports: unknown[]): RenderedNode | string | null {
  return renderTableRowsOf(mod, renderScreen(mod.React.createElement(mod.WikiReportsTable as Component, { reports })));
}

const WIDE_VIEW = { isStacked: false, columnCount: 4 };

describe("the run table drops its Status column only when every run in the window is healthy", () => {
  const run = (run_date: string, status: string, deadlinks_count: number) => ({ run_date, status, deadlinks_count, dedup_count: 3 });
  const rows = [
    {
      name: "a uniform healthy window, its backlog still moving, states the shared status once in the caption",
      reports: [run("2026-09-26", "ok", 2), run("2026-09-25", "ok", 1), run("2026-09-24", "ok", 1)],
      hasStatusColumn: false,
      shownWords: [],
    },
    {
      name: "a mixed window states each run's status in its own cell",
      reports: [run("2026-09-26", "ok", 1), run("2026-09-25", "partial", 1), run("2026-09-24", "ok", 1)],
      hasStatusColumn: true,
      shownWords: ["Healthy", "Warning"],
    },
    {
      name: "a uniform failing window, its backlog still moving, shows the failure in every row",
      reports: [run("2026-09-26", "fail", 2), run("2026-09-25", "fail", 1), run("2026-09-24", "fail", 1)],
      hasStatusColumn: true,
      shownWords: ["Failed"],
    },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const mod = await loadWikiScreen();
      const tree = renderScreen(mod.React.createElement(mod.WikiReportsTable as Component, { reports: row.reports }));
      const [table] = findNodes(tree, (n) => n.props.atom === "Table");
      const heads = Array.from(table.props.columns as Array<{ label: string }>, (c) => c.label);
      const tbody = renderTableRowsOf(mod, tree);
      const statusCells = findNodes(tbody, (n) => n.props.atom === "TableCell" && n.props.label === "Status");

      assert.equal(heads.includes("Status"), row.hasStatusColumn, "the Status head follows the window's health");
      assert.equal(statusCells.length, row.hasStatusColumn ? row.reports.length : 0, "status cells match the head");
      assert.equal(/Healthy/.test(String(table.props.caption)), !row.hasStatusColumn, "only a shared healthy status is named once, in the caption");
      // the caption is sr-only → a non-healthy status must reach sighted users through visible row text
      for (const word of row.shownWords) assert.match(collectText(tbody), new RegExp(word), `the rows show ${word}`);
    });
  }
});

test("a run's status reads as a tone glyph and a word, never a pill", async () => {
  const mod = await loadWikiScreen();
  const tbody = renderRunRowsOf(mod, [
    { run_date: "2026-09-24", status: "fail", deadlinks_count: 0, dedup_count: 0 },
    { run_date: "2026-09-23", status: "ok", deadlinks_count: 0, dedup_count: 0 },
  ]);
  const [status] = findNodes(tbody, (n) => n.props.atom === "TableCell" && n.props.label === "Status");
  const [glyph] = findNodes(status, (n) => n.props["aria-hidden"] === "true");
  assert.match(classOf(glyph), /\btext-crit\b/, "the glyph carries the tone");
  assert.match(collectText(status), /Failed/, "the word names the state");
  assert.equal(findNodes(tbody, (n) => n.props.atom === "Badge" || /\bpill\b/.test(classOf(n))).length, 0);
});

test("an unrecorded run cell reads None in faint ink, never a blank or a dash", async () => {
  const mod = await loadWikiScreen();
  const tbody = renderRunRowsOf(mod, [{ run_date: "2026-09-24", status: "ok", deadlinks_count: null, dedup_count: 3 }]);
  const cells = findNodes(tbody, (n) => n.props.atom === "TableCell");
  const byLabel = (label: string) => cells.find((c) => c.props.label === label) ?? null;
  for (const label of ["Broken links", "Started"]) {
    const [none] = findNodes(byLabel(label), (n) => collectText(n) === "None" && n.type === "span");
    assert.match(classOf(none), /\btext-faint\b/, `${label} reads None in faint ink`);
  }
  assert.equal(collectText(byLabel("Duplicates")), "3", "a recorded count reads as itself");
  assert.doesNotMatch(collectText(tbody), /\u2014/, "no dash stands in for a value");
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

// Producer shape: scripts/wiki_dedup.py → DedupProposal, its suggested_action f-string copied verbatim.
function dedupProposal(target: string, sources: string[], rationale: string) {
  return {
    cluster_hash: `c-${target}`,
    target_slug: target,
    source_slugs: sources,
    similarity_score: 0.9312,
    llm_verdict: "duplicate",
    llm_rationale: rationale,
    suggested_action:
      `Merge content of notes/${sources.join("/notes/")}.md into notes/${target}.md, ` +
      "then delete source note(s). All wikilinks to source slug(s) need updating. DRY-RUN — requires user approval.",
  };
}

test("a merge proposal's reasons wrap in full", async () => {
  const mod = await loadWikiScreen();
  const proposal = dedupProposal("t", ["s"], "merge because both notes describe one concept");
  const tree = renderScreen(mod.React.createElement(mod.MergeSuggestionItem as Component, { proposal, view: WIDE_VIEW }));
  const [reason] = findNodes(tree, (n) => n.props.atom === "TableCell" && n.props.label === "Reason");
  assert.match(classOf(reason), /\bbreak-words\b/, "a long reason breaks inside its cell");
  for (const node of findNodes(tree, () => true)) {
    assert.doesNotMatch(classOf(node), /\btruncate\b/, "no part of the proposal hides behind a hover title");
  }
});

test("the alarm lane keeps actionable rows only; waiting proposals stay in their own fold", async () => {
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

test("the page mounts no page verdict: each card states its own status", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.ScreenWiki as Component, {}));
  assert.equal(findNodes(tree, (n) => n.props.atom === "PageVerdict").length, 0);
});

test("a failed backlog read points its Retry at the merge-proposals fold, which opens on focus", async () => {
  const mod = await loadWikiScreen();
  const failed = { status: "error", data: null, error: "HTTP 500", busy: false };
  const fold = renderScreen(mod.React.createElement(mod.WikiMaintenanceSection as Component, { backlogState: failed, onRetry: () => {} }));
  const details = findNodes(fold, (n) => n.type === "details")[0];
  const failure = findNodes(fold, (n) => n.props.atom === "RegionFailure")[0];
  assert.ok(details.props.id, "the fold carries an id");
  assert.equal(failure.props.focusTargetId, details.props.id, "the Retry target is the fold itself");
  assert.equal(typeof details.props.onFocus, "function", "focus from the Retry opens the fold");
});

test("the per-run table gives every run its own row, unchanged runs included", async () => {
  const mod = await loadWikiScreen();
  const dates = ["2026-09-24", "2026-09-23", "2026-09-22"];
  const reports = dates.map((run_date) => ({ run_date, status: "ok", deadlinks_count: 0, dedup_count: 3 }));
  const rows = findNodes(renderRunRowsOf(mod, reports), (n) => n.props.atom === "TableRow");
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
  const [list] = findNodes(lane, (n) => n.type === "ul");
  assert.doesNotMatch(classOf(list), /\b(border|rounded)/, "the lane is rows on the page, never a bordered box");
  const table = renderScreen(
    mod.React.createElement(mod.WikiReportsTable as Component, { reports: [{ run_date: "2026-09-24", status: "error", deadlinks_count: 0, dedup_count: 0 }] }),
  );
  for (const tree of [lane, table]) {
    assert.equal(findNodes(tree, (n) => /\bsev-bar\b/.test(classOf(n))).length, 0, "no left-border stripe");
  }
});

test("wiki text never uses the retired micro type step and words are never set in mono", async () => {
  const mod = await loadWikiScreen();
  const { createElement } = mod.React;
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const trees = [
    renderScreen(createElement(mod.WikiAlarmLane, { summaryState: ready({}), indexState: ready({ has_dirty_flag: true, dirty: true, last_dirty_ms: 1 }), backlogState: READY_BACKLOG, cyclesState: ready({ cycles: [] }) })),
    renderStatsOf(mod, renderScreen(createElement(mod.WikiTileBand, { summaryState: ready({}), indexState: ready({ has_dirty_flag: true, dirty: false, last_dirty_ms: 1 }), backlogState: READY_BACKLOG, onRetry: () => {} }))),
    renderScreen(createElement(mod.WikiRunHistorySection, { cyclesState: ready({ cycles: [] }), summaryState: ready({}), reportState: ready({ reports: [] }), days: 30, onChangeDays: () => {}, onRetry: () => {} })),
    renderScreen(createElement(mod.WikiMaintenanceSection, { backlogState: READY_BACKLOG, onRetry: () => {} })),
    renderScreen(createElement(mod.MergeSuggestionItem, { proposal: dedupProposal("t", ["s"], "merge because both notes describe one concept"), view: WIDE_VIEW })),
  ];
  // Card titles render through the shared atom, outside this stub tree → not listed.
  const words = ["Search index", "Clean", "Merge proposals", "merge because both notes describe one concept"];
  const seen = new Set<string>();
  for (const tree of trees) {
    for (const node of findNodes(tree, () => true)) {
      assert.doesNotMatch(classOf(node), /\bfs-micro\b/, "the micro step is retired");
      const ownText = node.children.filter((c) => typeof c === "string").join("").trim();
      if (words.includes(ownText)) {
        seen.add(ownText);
        assert.doesNotMatch(classOf(node), /\bfont-mono\b/, `"${ownText}" is words, not an id or figure`);
      }
    }
  }
  assert.deepEqual(words.filter((w) => !seen.has(w)), [], "every listed word renders, so the mono check ran for each");
});

test("figures read in sans and only note slugs ride the machine-string atom", async () => {
  const mod = await loadWikiScreen();
  const { createElement } = mod.React;
  const notes = renderScreen(createElement(mod.WikiNotesByTypeSection, { state: { status: "ready", error: null, data: { by_type: [{ note_type: "raw", count: 1204 }] } }, onRetry: () => {} }));
  const proposal = { cluster_hash: "c1", target_slug: "agent-routing", source_slugs: ["routing-confidence"], similarity_score: 0.91 };
  const item = renderScreen(createElement(mod.MergeSuggestionItem, { proposal, view: WIDE_VIEW }));
  const machine = findNodes(item, (n) => n.props.atom === "MachineString").map(collectText);

  assert.deepEqual(machine, ["agent-routing", "routing-confidence"], "the target and source slugs are machine strings");
  for (const tree of [notes, item]) {
    for (const node of findNodes(tree, () => true)) assert.doesNotMatch(classOf(node), /\bfont-mono\b/, "mono only through the atom");
  }
  const figures = findNodes(notes, (n) => ["1,204", "100%"].includes(collectText(n)) && n.type === "span");
  assert.equal(figures.length, 2, "both figures render");
  for (const figure of figures) assert.match(classOf(figure), /\btabular-nums\b/, "a figure aligns on sans tabular digits");
});

test("cyan tints no wiki text: the similarity reads as a figure and the lane stays uncoloured", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const proposal = { cluster_hash: "c1", target_slug: "t", source_slugs: ["s"], similarity_score: 1 };
  const item = renderScreen(mod.React.createElement(mod.MergeSuggestionItem as Component, { proposal, view: WIDE_VIEW }));
  const lane = renderScreen(
    mod.React.createElement(mod.WikiAlarmLane as Component, {
      summaryState: ready({}), indexState: ready({}), backlogState: READY_BACKLOG, cyclesState: ready({ cycles: [] }),
    }),
  );
  const [sim] = findNodes(item, (n) => n.props.atom === "TableCell" && n.props.label === "Similarity");
  assert.equal(collectText(sim), "100%", "the similarity reads as a figure under its column head");
  assert.equal(sim.props.isNumeric, true, "the figure aligns as a number");
  for (const tree of [item, lane]) {
    for (const node of findNodes(tree, () => true)) assert.doesNotMatch(classOf(node), /\btext-info\b/);
  }
});

test("the window control rides the per-run table fold and never the open trend", async () => {
  const mod = await loadWikiScreen();
  const control = (tree: RenderedNode | string | null) => findNodes(tree, (n) => n.props.atom === "Segmented" && n.props.label === "Run table time range");
  assert.equal(control(renderScreen(mod.React.createElement(mod.WikiRunTableSection as Component, RUN_TABLE_LOADING))).length, 1);
  assert.equal(control(renderScreen(mod.React.createElement(mod.WikiRunHistorySection as Component, RUN_HISTORY_LOADING))).length, 0);
});

test("the dry-run notice is stated once above the proposals instead of on every proposal", async () => {
  const mod = await loadWikiScreen();
  const backlog = {
    status: "ready",
    error: null,
    data: { backlog: { run_date: "2026-09-24", dedup_proposals: { proposals: [
      dedupProposal("t1", ["s1"], "Both notes describe one concept."),
      dedupProposal("t2", ["s2"], "Same source, summarised twice."),
    ] } } },
  };
  const tree = renderScreen(mod.React.createElement(mod.WikiMaintenanceSection as Component, { backlogState: backlog, onRetry: () => {} }));
  const order = findNodes(tree, () => true);
  const notice = order.findIndex((n) => /^dry[ -]run/i.test(collectText(n)) && n.type === "div");
  const table = order.findIndex((n) => n.props.atom === "Table");

  assert.equal(collectText(tree).match(/dry[ -]run/gi)?.length, 1, "one notice for the whole list");
  assert.doesNotMatch(collectText(renderTableRowsOf(mod, tree)), /dry[ -]run/i, "no row repeats it");
  assert.ok(notice >= 0 && notice < table, "the notice sits above the proposals table");
});

test("merge proposals are table rows on the fold's flush body, never bordered boxes", async () => {
  const mod = await loadWikiScreen();
  const backlog = {
    status: "ready",
    error: null,
    data: { backlog: { run_date: "2026-09-24", dedup_proposals: { proposals: [
      { cluster_hash: "c1", target_slug: "agent-routing-confidence-thresholds", source_slugs: ["routing-confidence"] },
      { cluster_hash: "c2", target_slug: "keep-b", source_slugs: ["drop-2", "drop-3"] },
    ] } } },
  };
  const tree = renderScreen(mod.React.createElement(mod.WikiMaintenanceSection as Component, { backlogState: backlog, onRetry: () => {} }));
  const fold = findNodes(tree, (n) => n.type === "details" && n.props.id === "wiki-merge-proposals")[0];
  const [body] = fold.children.filter((child): child is RenderedNode => typeof child !== "string" && child.type !== "summary");
  const rows = findNodes(renderTableRowsOf(mod, tree), (n) => n.props.atom === "TableRow");

  assert.doesNotMatch(classOf(body), /\bp[xb]-card-pad\b/, "the body is flush, so the table's edge cells hold the card-pad column");
  assert.equal(rows.length, 2, "one table row per proposal");
  assert.equal(findNodes(fold, (n) => n.type === "li" || /\brounded|\bbg-|(^|\s)border(-b)?(\s|$)/.test(classOf(n))).length, 0, "no box, fill or edge of its own");
});

test("the merge-proposals loading line takes the card inset itself inside the flush fold", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.WikiMaintenanceSection as Component, { backlogState: LOADING, onRetry: () => {} }));
  const [body] = findNodes(tree, (n) => n.type === "details")[0].children.filter((child): child is RenderedNode => typeof child !== "string" && child.type !== "summary");
  const insets = findNodes(body, (n) => /\bpx-card-pad\b.*\bpb-card-pad\b/.test(classOf(n)) && findNodes(n, (m) => m.props.atom === "LoadingPlaceholder").length > 0);

  assert.equal(insets.length, 1, "one inset wrapper holds the loading line");
  assert.notEqual(insets[0], body, "the inset is the loading line's own, not the fold body's");
});

test("the page's meters share the small radius, never a full pill", async () => {
  const mod = await loadWikiScreen();
  const ready = { status: "ready", error: null, data: { by_type: [{ note_type: "raw", count: 3 }] } };
  const mix = renderScreen(mod.React.createElement(mod.WikiStatusMixW as Component, { mix: { ok: 70, partial: 10, error: 10, quota: 10 } }));
  const types = renderScreen(mod.React.createElement(mod.WikiNotesByTypeSection as Component, { state: ready, onRetry: () => {} }));
  const tracks = [...findNodes(mix, (n) => n.props.role === "img"), ...findNodes(types, (n) => /\boverflow-hidden\b/.test(classOf(n)))];

  assert.equal(tracks.length, 2, "the mix bar and the type bar both render");
  for (const track of tracks) assert.match(classOf(track), /\brounded-sm\b/);
});

test("the run-history empty state tells a wiki that never ran from a quiet window", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const rows = [
    { name: "never ran", summaryState: ready({ last_cycle_started_at: null }), message: "No runs yet", hint: /first daily wiki cycle/ },
    { name: "ran before the window", summaryState: ready({ last_cycle_started_at: "2026-08-01T04:30:00Z", last_run_date: "2026-08-01" }), message: "No runs in the last 30 days", hint: /^Last run 2026-08-01$/ },
    { name: "summary still loading", summaryState: LOADING, message: "No runs in the last 30 days", hint: null },
  ];
  for (const row of rows) {
    const tree = renderScreen(
      mod.React.createElement(mod.WikiRunHistorySection as Component, { cyclesState: ready({ cycles: [] }), summaryState: row.summaryState, onRetry: () => {} }),
    );
    const [empty] = findNodes(tree, (n) => n.props.atom === "EmptyState");
    assert.ok(empty, `${row.name}: an empty state renders`);
    assert.equal(empty.props.message, row.message, row.name);
    if (row.hint) assert.match(String(empty.props.hint), row.hint, row.name);
    else assert.equal(empty.props.hint ?? null, null, row.name);
  }
});

test("a wiki empty state takes the shared atom's own inset, adding no margin of its own", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const tree = renderScreen(
    mod.React.createElement(mod.WikiRunHistorySection as Component, { cyclesState: ready({ cycles: [] }), summaryState: ready({ last_cycle_started_at: null }), onRetry: () => {} }),
  );
  const [empty] = findNodes(tree, (n) => n.props.atom === "EmptyState");
  assert.ok(empty, "an empty state renders");
  assert.doesNotMatch(String(empty.props.className ?? ""), /(^|\s)-?m[trblxy]?-/);
});

test("every merge proposal states in text which note absorbs which, and why, with the shared merge steps stated once", async () => {
  const mod = await loadWikiScreen();
  const backlog = {
    status: "ready",
    error: null,
    data: { backlog: { run_date: "2026-09-24", dedup_proposals: { proposals: [
      dedupProposal("keep-a", ["drop-1"], "Both notes define routing confidence thresholds with the same 0.7 cut-off."),
      dedupProposal("keep-b", ["drop-2", "drop-3"], "The three notes summarise one source on prompt caching."),
    ] } } },
  };
  const tree = renderScreen(mod.React.createElement(mod.WikiMaintenanceSection as Component, { backlogState: backlog, onRetry: () => {} }));
  const [table] = findNodes(tree, (n) => n.props.atom === "Table");
  const tbody = renderTableRowsOf(mod, tree);
  const cells = (kind: string) => findNodes(tbody, (n) => n.props.atom === "TableCell" && (n.props.kind === kind || n.props.label === kind)).map(collectText);

  // the screen module runs in its own realm → copy its array before a strict deep compare
  const heads = Array.from(table.props.columns as Array<{ label: string }>, (c) => c.label);
  assert.deepEqual(heads, ["Kept note", "Absorbs", "Similarity", "Reason"]);
  assert.deepEqual(cells("row-header"), ["keep-a", "keep-b"], "the kept note heads each row");
  assert.deepEqual(cells("Absorbs"), ["drop-1", "drop-2, drop-3"], "the absorbed notes sit under their own head");
  assert.deepEqual(
    cells("Reason"),
    ["Both notes define routing confidence thresholds with the same 0.7 cut-off.", "The three notes summarise one source on prompt caching."],
    "each row gives the verifier's own reason",
  );
  assert.doesNotMatch(collectText(tbody), /wikilinks|delete/i, "no row repeats the shared merge steps");
  assert.equal(collectText(tree).match(/links to them need updating/g)?.length, 1, "the shared merge steps are stated once");
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
  const age = findNodes(renderStatsOf(mod, band), (n) => n.children.some((c) => typeof c === "string" && /^\d+h ago$/.test(c)));
  assert.equal(age.length, 1, "the tile shows the run's age");
  assert.doesNotMatch(classOf(age[0]), /\bfont-mono\b/);
});

test("stat context lines wrap instead of cutting the figure's words, and each keeps its full detail in its title", async () => {
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
  const stats = renderStatsOf(mod, band);
  assert.ok(collectText(stats).includes("22 in 29d"), "the window total is on the page");
  for (const node of findNodes(stats, () => true)) assert.doesNotMatch(classOf(node), /\btruncate\b/);
  const contexts = findNodes(stats, (n) => /\bstat-context\b/.test(classOf(n)));
  assert.equal(contexts.length, 4);
  for (const context of contexts) {
    const [line] = findNodes(context, (n) => typeof n.props.title === "string");
    assert.ok(line, `"${collectText(context)}" keeps a title`);
    assert.ok(String(line.props.title).trim().length > 0, `"${collectText(line)}" has an empty title`);
  }
});

test("detail moved off the stat captions opens from the card's one info trigger, each note led by its stat label", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const band = renderScreen(
    mod.React.createElement(mod.WikiTileBand as Component, {
      summaryState: ready({ last_cycle_started_at: new Date().toISOString(), latest_compiled_count: 0, last_status: "ok" }),
      indexState: ready({ notes_total: 40 }),
      backlogState: ready({ backlog: { run_date: "2026-01-01", true_backlog: 13, deadlink_dryrun: [] } }),
      onRetry: () => {},
    }),
  );
  assert.deepEqual(findNodes(band, (n) => n.props.atom === "CardInfo"), [], "no per-stat trigger");
  const [card] = findNodes(band, (n) => n.props.atom === "Card");
  const notes = findNodes(renderScreen(card.props.info), (n) => n.type === "p");
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => collectText(n.children[0] ?? null)), ["Compiled last cycle", "Library notes"]);
  assert.match(collectText(notes[0]), /13 saved originals are waiting and the last cycle compiled none/);
});

test("a steady band carries no info trigger, since no stat has detail past its caption", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const band = renderScreen(
    mod.React.createElement(mod.WikiTileBand as Component, {
      summaryState: ready({ last_cycle_started_at: new Date().toISOString(), latest_compiled_count: 4, last_status: "ok" }),
      indexState: ready({ has_dirty_flag: true, dirty: false, last_dirty_ms: 1 }), backlogState: ready({ backlog: null }), onRetry: () => {},
    }),
  );
  const [card] = findNodes(band, (n) => n.props.atom === "Card");
  assert.ok(!card.props.info, "a steady band has nothing behind an ⓘ");
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
  for (const tree of trees.slice(0, 2)) assert.doesNotMatch(collectText(tree), /loading/i);
  assert.equal(findNodes(trees[0], (n) => n.props.atom === "LoadingPlaceholder").length, 1);
  assert.equal(findNodes(trees[1], (n) => n.props.atom === "LoadingPlaceholder").length, 1);
  assert.equal(findNodes(trees[2], (n) => n.props["aria-busy"] === "true").length, 1, "the stat row reports busy once");
  const stats = findNodes(renderStatsOf(mod, trees[2]), (n) => /^stat$/.test(classOf(n)));
  assert.equal(stats.length, 4, "four stats");
  for (const stat of stats) {
    const placeholders = findNodes(stat, (n) => n.props.atom === "LoadingPlaceholder");
    assert.equal(placeholders.length, 1, "each stat states loading once, through its placeholder");
    const outside = (n: RenderedNode | string): string =>
      typeof n === "string" ? n : n.props.atom === "LoadingPlaceholder" ? "" : n.children.map(outside).join(" ");
    assert.doesNotMatch(outside(stat), /loading|…/i, "not through its count or caption");
  }
});

test("the two status cards share the S slot inside their region hosts, the coverage line pinned to the foot", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const row = renderScreen(
    mod.React.createElement(mod.WikiStatusRow as Component, {
      cyclesState: ready({ cycles: [] }),
      summaryState: ready({}),
      indexState: ready({ by_type: [{ note_type: "raw", count: 120 }, { note_type: "source-summary", count: 96 }] }),
      onRetry: () => {},
    }),
  );
  const cards = findNodes(row, (n) => n.props.atom === "Card");
  assert.deepEqual(cards.map((card) => card.props.size), ["S", "S"], "peers in one row share a slot");

  const hostIds = findNodes(row, (n) => n.type === "div" && typeof n.props.id === "string").map((n) => n.props.id);
  assert.deepEqual(hostIds, ["wiki-run-history", "wiki-notes-by-type"], "the region ids stay focus targets");

  const notes = cards[1];
  assert.equal(collectText(renderScreen(notes.props.foot)), "96 summary notes for 120 saved originals");
  assert.doesNotMatch(collectText(notes), /summary notes for/, "the coverage line leaves the body once it sits in the foot");
});

// The legend keys four bar segments by colour — each toned status also needs its own shape, or the key is colour-only.
test("the run-status legend marks each toned status with its tone's own shape, usage limit with a neutral dot", async () => {
  const mod = await loadWikiScreen();
  const toneIcon = realUi.TONE_ICON as Record<string, string>;
  const tree = renderScreen(mod.React.createElement(mod.WikiStatusMixW as Component, { mix: { ok: 70, partial: 15, error: 10, quota: 5 } }));
  const keys = [
    { label: "Healthy", icon: toneIcon.ok, tone: "text-ok" },
    { label: "Warning", icon: toneIcon.warn, tone: "text-warn" },
    { label: "Down", icon: toneIcon.crit, tone: "text-crit" },
    { label: "Usage limit", icon: "circle", tone: "text-faint" },
  ];

  assert.equal(new Set(keys.map((k) => k.icon)).size, keys.length, "precondition: four distinct shapes");
  for (const key of keys) {
    const [item] = findNodes(tree, (n) => n.type === "span" && collectText(n).trim().startsWith(key.label));
    const [glyph] = findNodes(item, (n) => n.props.atom === "Icon");
    assert.equal(glyph?.props.name, key.icon, `${key.label} legend shape`);
    assert.ok(classOf(glyph).split(/\s+/).includes(key.tone), `${key.label} legend glyph tone`);
  }
});
