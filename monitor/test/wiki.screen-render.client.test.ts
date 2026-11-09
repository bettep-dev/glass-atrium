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
    renderScreen(createElement(mod.MergeSuggestionItem, { proposal: { cluster_hash: "c1", target_slug: "t", source_slugs: ["s"], suggested_action: "merge because both notes describe one concept" } })),
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

test("merge proposals are hairline rows, never bordered boxes", async () => {
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
  const rows = findNodes(tree, (n) => n.type === "li");

  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(classOf(row), /\bborder-b\b/, "a hairline under each row");
    assert.doesNotMatch(classOf(row), /\brounded|\bbg-|(^|\s)border(\s|$)/, "no box, fill or four-side edge");
  }
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
