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

// the lane's rows ride the shared AlarmRow atom → its words are the title and detail each row is handed
function alarmRowsOfW(tree: RenderedNode | string | null): RenderedNode[] {
  return findNodes(tree, (n) => n.props.atom === "AlarmRow");
}
function laneTextOf(tree: RenderedNode | string | null): string {
  return alarmRowsOfW(tree).map((row) => [row.props.title, row.props.detail].filter(Boolean).join(" ")).join("\n");
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

test("the notes-per-day chart fills its panel with one MM-DD dated bar per day and keeps the peak caption", async () => {
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
    const points = (chart[0].props.points as Array<{ label: string; value: number }>).map((p) => [p.label, p.value]);
    assert.deepEqual(points, dates.map((d, i) => [d.slice(5), series[i]]), "each bar carries its own day and count for the readout");
    for (const [label] of points) assert.match(String(label), /^\d{2}-\d{2}$/, "ticks read in the Day form");
    assert.ok(collectText(tree).includes(`peak ${peak} on ${peakDate.slice(5)}`), "the visible caption carries the peak value and its day");
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

test("the run-history chart is titled Notes per day over a stat line of notes, active days and the peak day", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const rows = [
    { name: "five busy days", compiled: [1, 2, 3, 4, 5], stat: "15 notes · 5 active days · peak 5 on 09-05" },
    { name: "quiet days between", compiled: [3, 0, 1, 0, 2, 1, 0], stat: "7 notes · 4 active days · peak 3 on 09-01" },
  ];
  for (const row of rows) {
    const cycles = row.compiled.map((compiled_count, i) => ({ run_date: `2026-09-0${i + 1}`, compiled_count, status: "ok" }));
    const tree = renderScreen(
      mod.React.createElement(mod.WikiRunHistorySection as Component, { cyclesState: ready({ cycles }), summaryState: ready({}), onRetry: () => {} }),
    );
    const [chart] = findNodes(tree, (n) => n.props.atom === "TrendChart");
    assert.equal(chart.props.label, "Notes per day", row.name);
    assert.ok(collectText(tree).includes(row.stat), `${row.name}: "${collectText(tree)}"`);
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
    { name: "Runs", folds: true, element: createElement(mod.WikiRunTableSection, RUN_TABLE_LOADING) },
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

test("the Runs fold's body prose fits the 90-char footnote cap, a longer qualifier behind its ⓘ", async () => {
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

test("the Runs fold's bar line says the range sets this table only and names the trend's fixed window", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.WikiRunTableSection as Component, RUN_TABLE_LOADING));
  const [bar] = findNodes(tree, (n) => /\bcard-bar\b/.test(classOf(n)));
  const [note] = findNodes(bar, (n) => n.type === "span" && /\btext-faint\b/.test(classOf(n)));
  assert.equal(collectText(note), "Sets this table only; the trend keeps 30d.");
});

test("the Runs fold body is flush so the table's edge cells hold the one card-pad column, controls on the card bar", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.WikiRunTableSection as Component, RUN_TABLE_LOADING));
  const [fold] = findNodes(tree, (n) => n.type === "details");
  const [body] = fold.children.filter((child): child is RenderedNode => typeof child !== "string" && child.type !== "summary");
  const [controls] = findNodes(fold, (n) => n.props.atom === "Cluster");

  assert.doesNotMatch(classOf(body), /\bp[xb]-card-pad\b/, "the body adds no inline inset of its own");
  assert.match(String(controls.props.className), /\bcard-bar\b/);
});

test("the Runs failure block takes the card inset itself inside the flush fold", async () => {
  const mod = await loadWikiScreen();
  const failed = { status: "error", data: null, error: OUTAGE, busy: false };
  const tree = renderScreen(mod.React.createElement(mod.WikiReportsBody as Component, { state: failed, shared: null, onRetry: () => {} }));
  const insets = findNodes(tree, (n) => /\bpx-card-pad\b/.test(classOf(n)) && findNodes(n, (m) => m.props.atom === "RegionFailure").length > 0);

  assert.equal(insets.length, 1);
});

test("the Runs fold's ⓘ is described by the fold's own heading", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.WikiRunTableSection as Component, RUN_TABLE_LOADING));
  const [trigger] = findNodes(tree, (n) => n.props.atom === "CardInfo");
  const [described] = findNodes(tree, (n) => n.props.id !== undefined && n.props.id === trigger.props.describedBy);

  assert.equal(described?.type, "h2", "the described-by id names a heading");
  assert.deepEqual(described?.children, ["Runs"]);
});

test("the run-history trend and notes by type share one split row, the trend on the wider side", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.WikiStatusRow as Component, {
    cyclesState: LOADING, summaryState: LOADING, indexState: LOADING, onRetry: () => {},
  }));
  const split = findNodes(tree, (n) => n.props.atom === "SplitRow");
  assert.equal(split.length, 1);
  assert.equal(split[0].props.ratio, "2:1");
  assert.equal(split[0].props.layout, "content", "each card ends at its own content");
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
  const shared = { sources: ["Health", "Run history", "Notes by type", "Merge proposals", "Runs"], error: OUTAGE };
  const onRetry = () => {};
  const rows = [
    { name: "tile band", element: createElement(mod.WikiTileBand, { summaryState: failed, indexState: failed, backlogState: failed, cyclesState: failed, at: null, shared, onRetry }) },
    { name: "run history", element: createElement(mod.WikiRunHistorySection, { cyclesState: failed, summaryState: failed, shared, onRetry }) },
    { name: "notes by type", element: createElement(mod.WikiNotesByTypeSection, { state: failed, shared, onRetry }) },
    { name: "runs", element: createElement(mod.WikiReportsBody, { state: failed, shared, onRetry }) },
    { name: "merge proposals", element: createElement(mod.WikiMaintenanceSection, { backlogState: failed, cyclesState: failed, shared, onRetry }) },
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
  const shared = { sources: ["Health", "Run history"], error: OUTAGE };
  const tree = renderScreen(mod.React.createElement(mod.WikiTileBand, {
    summaryState: failed, indexState: failed, backlogState: LOADING, cyclesState: failed, at: null, shared, onRetry: () => {},
  }));
  const cards = findNodes(tree, (n) => n.props.atom === "RegionFailure");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].props.source, "the search index", "only the uncovered feeder is named");
  assert.equal(cards[0].props.shared, null, "the uncovered feeder is not quieted by the banner");
});

describe("a failed read speaks inside the card it feeds, never bare on the page", () => {
  const failed = { status: "error", data: null, error: OUTAGE, busy: false };
  const rows = [
    {
      name: "a failed tile-band feeder sits in the Health card",
      render: (mod: ScreenModule) => mod.React.createElement(mod.WikiTileBand, {
        summaryState: failed, indexState: { status: "ready", data: {}, error: null }, backlogState: READY_BACKLOG, at: null, shared: null, onRetry: () => {},
      }),
      isHost: (n: RenderedNode) => n.props.atom === "Card" && n.props.title === "Health",
    },
    {
      name: "a failed backlog sits in the Merge proposals fold",
      render: (mod: ScreenModule) => mod.React.createElement(mod.WikiMaintenanceSection, {
        backlogState: failed, cyclesState: failed, shared: null, onRetry: () => {},
      }),
      isHost: (n: RenderedNode) => n.type === "details" && n.props.id === "wiki-merge-proposals",
    },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const tree = renderScreen(row.render(await loadWikiScreen()));
      const isFailure = (n: RenderedNode) => n.props.atom === "RegionFailure";
      const [host] = findNodes(tree, row.isHost);

      assert.equal(findNodes(tree, isFailure).length, 1, "one failure for the region");
      assert.equal(findNodes(host, isFailure).length, 1, "the failure renders inside its card");
      assert.doesNotMatch(collectText(tree), /see above/, "no second line points at a failure elsewhere");
    });
  }
});

test("failure copy names each region by the label the screen shows", async () => {
  const mod = await loadWikiScreen();
  const { createElement } = mod.React;
  const failed = { status: "error", data: null, error: OUTAGE, busy: false };
  const sourceOf = (element: unknown) => findNodes(renderScreen(element), (n) => n.props.atom === "RegionFailure")[0].props.source;
  const banner = findNodes(await renderWikiInState(failed), (n) => n.props.atom === "PageErrorBanner")[0];

  assert.deepEqual([...(banner.props.sources as string[])], ["Health", "Run history", "Notes by type", "Merge proposals", "Runs"]);
  assert.equal(sourceOf(createElement(mod.WikiMaintenanceSection, { backlogState: failed, cyclesState: failed, shared: null, onRetry: () => {} })), "merge proposals");
  assert.equal(sourceOf(createElement(mod.WikiReportsBody, { state: failed, shared: null, onRetry: () => {} })), "runs");
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

const RUN_COLUMN_LABELS = ["Run date", "Started", "Broken links", "Duplicates"];

describe("the run table keeps one column set, and a run that is not healthy states its glyph and word after its date", () => {
  const run = (run_date: string, status: string, deadlinks_count: number) => ({ run_date, status, deadlinks_count, dedup_count: 3 });
  const rows = [
    { name: "a healthy window", reports: [run("2026-09-26", "ok", 2), run("2026-09-25", "ok", 1)], dateTexts: ["09-26", "09-25"] },
    { name: "a mixed window", reports: [run("2026-09-26", "ok", 1), run("2026-09-25", "partial", 1)], dateTexts: ["09-26", "09-25 ⚠ Warning"] },
    { name: "a failing window", reports: [run("2026-09-26", "fail", 2), run("2026-09-25", "error", 1)], dateTexts: ["09-26 ✕ Failed", "09-25 ✕ Down"] },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const mod = await loadWikiScreen();
      const tree = renderScreen(mod.React.createElement(mod.WikiReportsTable as Component, { reports: row.reports }));
      const [table] = findNodes(tree, (n) => n.props.atom === "Table");
      const heads = Array.from(table.props.columns as Array<{ label: string }>, (c) => c.label);
      const dateCells = findNodes(renderTableRowsOf(mod, tree), (n) => n.props.atom === "TableCell" && n.props.kind === "row-header");

      assert.deepEqual(heads, RUN_COLUMN_LABELS, "no Status column, in the ruled order");
      const widths = Array.from(table.props.widths as Array<string | undefined>);
      assert.equal(widths[0], undefined, "the run date takes the slack");
      assert.ok(widths.length === heads.length && widths.slice(1).every(Boolean), "every other column has a set width");
      assert.deepEqual(dateCells.map((cell) => collectText(cell).replace(/\s+/g, " ")), row.dateTexts);
    });
  }
});

test("a run's status reads as a tone glyph and a word in its date cell, never a pill", async () => {
  const mod = await loadWikiScreen();
  const tbody = renderRunRowsOf(mod, [
    { run_date: "2026-09-24", status: "fail", deadlinks_count: 0, dedup_count: 0 },
    { run_date: "2026-09-23", status: "ok", deadlinks_count: 0, dedup_count: 0 },
  ]);
  const [failed] = findNodes(tbody, (n) => n.props.atom === "TableCell" && n.props.kind === "row-header");
  const [glyph] = findNodes(failed, (n) => n.props["aria-hidden"] === "true");
  assert.match(classOf(glyph), /\btext-crit\b/, "the glyph carries the tone");
  assert.match(collectText(failed), /Failed/, "the word names the state");
  assert.equal(findNodes(tbody, (n) => n.props.atom === "Badge" || /\bpill\b/.test(classOf(n))).length, 0);
});

test("a run's start reads as its clock time, the full stamp in the cell title", async () => {
  const mod = await loadWikiScreen();
  const tbody = renderRunRowsOf(mod, [{ run_date: "2026-09-24", status: "ok", deadlinks_count: 0, dedup_count: 3, started_at: "2026-09-24T19:30:00Z" }]);
  const [started] = findNodes(tbody, (n) => n.props.atom === "TableCell" && n.props.label === "Started");
  assert.match(collectText(started), /^\d{2}:\d{2}$/);
  assert.match(String(started.props.title), /^2026-09-2\d \d{2}:\d{2}:\d{2}/);
});

describe("an unrecorded cell reads the shared None look, never a blank or a dash", () => {
  const run = { run_date: "2026-09-24", status: "ok", deadlinks_count: null, dedup_count: 3 };
  const rows = [
    { name: "a run's missing broken-link count", table: "WikiReportsTable", props: { reports: [run] }, isCell: (c: RenderedNode) => c.props.label === "Broken links" },
    { name: "a run's missing start", table: "WikiReportsTable", props: { reports: [run] }, isCell: (c: RenderedNode) => c.props.label === "Started" },
    { name: "a broken link's empty source note", table: "WikiBrokenLinksTable", props: { links: [{ source_slug: "", link_target: "missing-note" }] }, isCell: (c: RenderedNode) => c.props.kind === "row-header" },
    { name: "a broken link's missing target", table: "WikiBrokenLinksTable", props: { links: [{ source_slug: "kept-note", link_target: null }] }, isCell: (c: RenderedNode) => c.props.label === "Target" },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const mod = await loadWikiScreen();
      const tbody = renderTableRowsOf(mod, renderScreen(mod.React.createElement(mod[row.table] as Component, row.props)));
      const [cell] = findNodes(tbody, (n) => n.props.atom === "TableCell" && row.isCell(n));
      assert.deepEqual(findNodes(cell, (n) => n.props.atom === "AbsentValue").map((n) => n.props.kind), ["none"]);
    });
  }
});

test("a recorded run count reads as itself", async () => {
  const mod = await loadWikiScreen();
  const tbody = renderRunRowsOf(mod, [{ run_date: "2026-09-24", status: "ok", deadlinks_count: null, dedup_count: 3 }]);
  const [dedup] = findNodes(tbody, (n) => n.props.atom === "TableCell" && n.props.label === "Duplicates");
  assert.equal(collectText(dedup), "3");
});

const ERRORED = { status: "error", data: null, error: "boom" };

test("the merge-proposals disclosure stays in place while loading and after a failure, with its state in the count", async () => {
  const mod = await loadWikiScreen();
  const rows = [
    { name: "loading", state: LOADING, count: "Loading…" },
    { name: "error", state: ERRORED, count: "Not loaded" },
    { name: "ready", state: READY_BACKLOG, count: "1 waiting" },
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
  assert.equal(alarmRowsOfW(tree).length, 1, "the dirty index only");
  assert.doesNotMatch(laneTextOf(tree), /Merge proposal/);
  assert.equal(findNodes(tree, (n) => n.type === "button").length, 0);
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
  assert.deepEqual(rows.map((row) => dates.find((d) => collectText(row).includes(d.slice(5)))), dates);
});

test("the Broken links fold is a table of each link's source and target, one row per link, never a data dump", async () => {
  const mod = await loadWikiScreen();
  const deadlinks = [
    { source_slug: "agent-engineering", broken_link: "[[prompt-cache]]", link_target: "prompt-cache", fix_status: "dry-run-no-match" },
    { source_slug: "rag-eval", broken_link: "[[bm25-tuning]]", link_target: "bm25-tuning", fix_status: "dry-run-ambiguous" },
  ];
  const backlogState = { status: "ready", error: null, data: { backlog: { run_date: "2026-09-24", deadlink_dryrun: deadlinks } } };
  const tree = renderScreen(mod.React.createElement(mod.WikiMaintenanceSection as Component, { backlogState, onRetry: () => {} }));
  const [fold] = findNodes(tree, (n) => n.type === "details" && findSummaryHeading(n, "Broken links") !== undefined);
  const [table] = findNodes(fold, (n) => n.props.atom === "Table");
  const rows = findNodes(renderTableRowsOf(mod, fold), (n) => n.props.atom === "TableRow");

  assert.deepEqual(Array.from(table.props.columns as Array<{ label: string }>, (c) => c.label), ["Source", "Target"]);
  assert.deepEqual(rows.map((row) => findNodes(row, (n) => n.props.atom === "MachineString").map(collectText)), [
    ["agent-engineering", "prompt-cache"],
    ["rag-eval", "bm25-tuning"],
  ]);
  assert.equal(findNodes(fold, (n) => n.type === "pre").length, 0, "no raw record dump");
});

test("the maintenance section adds no broken-link line of its own", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.WikiMaintenanceSection as Component, { backlogState: READY_BACKLOG, onRetry: () => {} }));
  assert.doesNotMatch(collectText(tree), /broken link/i);
});

test("alarms sit as shared alarm rows in one list card, each naming its tone", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const lane = renderScreen(
    mod.React.createElement(mod.WikiAlarmLane as Component, {
      summaryState: ready({ hours_since_last_cycle: 40, last_run_date: "2026-09-20" }),
      indexState: ready({ has_dirty_flag: true, dirty: true, last_dirty_ms: 1 }),
      backlogState: READY_BACKLOG, cyclesState: ready({ cycles: [] }),
    }),
  );
  const [card] = findNodes(lane, (n) => classOf(n).split(/\s+/).includes("card"));
  assert.ok(card, "the rows are framed by one list card");
  const rows = alarmRowsOfW(card);
  assert.deepEqual(rows.map((row) => row.props.tone), ["warn", "crit"], "the dirty index and the missed cycle, each with its tone");
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

test("only note slugs ride the machine-string atom, and no other wiki text is set in mono", async () => {
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

test("the run-status mix bar takes the small radius, never a full pill", async () => {
  const mod = await loadWikiScreen();
  const mix = renderScreen(mod.React.createElement(mod.WikiStatusMixW as Component, { mix: { ok: 70, partial: 10, error: 10, quota: 10 } }));
  const [track] = findNodes(mix, (n) => n.props.role === "img");

  assert.match(classOf(track), /\brounded-sm\b/);
});

test("an empty Runs window leaves its fact to the fold count, with no body line repeating it", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(mod.React.createElement(mod.WikiReportsBody as Component, {
    state: { status: "ready", data: { reports: [] }, error: null }, shared: null, onRetry: () => {},
  }));

  assert.equal(findNodes(tree, (n) => n.props.atom === "EmptyState").length, 0, "no empty-state line");
  assert.equal(collectText(tree), "", "no text of its own");
});

test("the run-history empty state tells a wiki that never ran from a quiet window", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const rows = [
    { name: "never ran", summaryState: ready({ last_cycle_started_at: null }), message: "No runs yet", hint: /first daily wiki cycle/ },
    { name: "ran before the window", summaryState: ready({ last_cycle_started_at: "2026-08-01T04:30:00Z", last_run_date: "2026-08-01" }), message: "No runs in the last 30 days", hint: /^Last run 08-01$/ },
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

test("the missed-cycle alarm dates its run once, as MM-DD, with the Last run tile's own age", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const startedAt = new Date(Date.now() - 45 * 86_400_000).toISOString();
  const summaryState = ready({ last_cycle_started_at: startedAt, hours_since_last_cycle: 45 * 24, last_run_date: "2026-10-10" });
  const lane = renderScreen(
    mod.React.createElement(mod.WikiAlarmLane as Component, {
      summaryState, indexState: ready({}), backlogState: READY_BACKLOG, cyclesState: ready({ cycles: [] }),
    }),
  );
  const tile = (mod.buildLastRunTileW as (state: unknown) => { value: string })(summaryState);
  const text = laneTextOf(lane);

  assert.match(text, new RegExp(`Last run 10-10 · ${tile.value} —`));
  assert.doesNotMatch(text, /2026-10-10|\d+h ago/, "no year-long date, no second age form");
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

test("each Health context states the one fact it owns, wraps rather than cuts, and keeps its full detail in its title", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const band = renderScreen(
    mod.React.createElement(mod.WikiTileBand as Component, {
      summaryState: ready({ last_cycle_started_at: new Date().toISOString(), hours_since_last_cycle: 3, latest_compiled_count: 0, last_status: "ok", cycle_p95_ms: 550 }),
      indexState: ready({ has_dirty_flag: true, dirty: true, last_dirty_ms: Date.now() - 3 * 3_600_000, notes_total: 40 }),
      backlogState: ready({ backlog: { run_date: new Date().toISOString().slice(0, 10), true_backlog: 0, deadlink_dryrun: [] } }),
      onRetry: () => {},
    }),
  );
  const stats = renderStatsOf(mod, band);
  for (const node of findNodes(stats, () => true)) assert.doesNotMatch(classOf(node), /\btruncate\b/);
  const contexts = findNodes(stats, (n) => /\bstat-context\b/.test(classOf(n)));
  const texts = contexts.map((context) => collectText(context));
  assert.deepEqual(texts.map((text) => text.replace(/^Since .+/, "Since …")), ["Healthy", "Idle", "Since …", "None waiting · 0 broken links"]);
  assert.doesNotMatch(collectText(stats), /p95|\bin \d+d\b/, "the p95 and the window total belong to Run history");
  for (const context of contexts) {
    const [line] = findNodes(context, (n) => typeof n.props.title === "string");
    assert.ok(line, `"${collectText(context)}" keeps a title`);
    assert.ok(String(line.props.title).trim().length > 0, `"${collectText(line)}" has an empty title`);
  }
});

test("detail moved off the stat captions opens from the card's one info trigger as the shared stat notes, one per stat with detail", async () => {
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
  const [notes] = findNodes(renderScreen(card.props.info), (n) => n.props.atom === "StatNotes");
  assert.ok(notes, "the shared stat-notes body");
  const stats = notes.props.stats as Array<{ label: string; info: string }>;
  assert.deepEqual(Array.from(stats, (stat) => stat.label), ["Compiled last cycle", "Library notes"]);
  assert.match(stats[0].info, /13 saved originals are waiting and the last cycle compiled none/);
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
  const text = laneTextOf(lane);
  assert.doesNotMatch(text, /\blane\b|incomplete/i);
  assert.match(text, /Alarms hidden: search index unread\./);
});

describe("every wiki-owned sentence on the screen stays within 12 words", () => {
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const rows = [
    {
      name: "the alarm list's unread feeders",
      read: (mod: ScreenModule) => laneTextOf(renderScreen(mod.React.createElement(mod.WikiAlarmLane as Component, {
        summaryState: ERRORED, indexState: ERRORED, backlogState: ERRORED, cyclesState: ready({ cycles: [] }),
      }))),
    },
    {
      name: "the Library notes counting note",
      read: (mod: ScreenModule) => (mod.buildLibraryTileW as (...states: unknown[]) => { info: string })(
        ready({ notes_total: 1016 }), ready({}), ready({ backlog: { true_backlog: 0, deadlink_dryrun: [], run_date: "2026-11-22" } }),
      ).info,
    },
    {
      name: "the proposals' cost-guard residue",
      read: (mod: ScreenModule) => (mod.buildMaintenanceModel as (state: unknown) => { residueLine: string })(
        ready({ backlog: { dedup_proposals: { proposals: [], not_verified: 4 } } }),
      ).residueLine,
    },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const text = row.read(await loadWikiScreen());
      const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);

      assert.ok(sentences.length > 0, "the copy renders");
      for (const sentence of sentences) {
        assert.ok(sentence.trim().split(/\s+/).length <= 12, `over 12 words: ${sentence}`);
      }
    });
  }
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
  const [row] = findNodes(trees[2], (n) => n.props.atom === "StatRow");
  const stats = Array.from(row.props.stats as Array<Record<string, unknown>>);
  assert.equal(stats.length, 4, "four stats");
  for (const stat of stats) {
    assert.equal(stat.isLoading, true, `${stat.label} states loading through the shared stat row`);
    assert.equal(stat.value ?? null, null, `${stat.label} carries no value of its own`);
    assert.equal(stat.context ?? null, null, `${stat.label} carries no caption`);
  }
});

test("a failed or unreported stat reads Not loaded with its cause in the title, an empty one None, never a dash", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const band = renderScreen(
    mod.React.createElement(mod.WikiTileBand as Component, { summaryState: ready({}), indexState: ERRORED, backlogState: READY_BACKLOG, onRetry: () => {} }),
  );
  const [row] = findNodes(band, (n) => n.props.atom === "StatRow");
  const byLabel = Object.fromEntries(Array.from(row.props.stats as Array<{ label: string; value: unknown }>, (stat) => [stat.label, stat.value]));
  const absent = (label: string) => findNodes(renderScreen(byLabel[label] as RenderedNode), (n) => n.props.atom === "AbsentValue")[0];

  assert.equal(byLabel["Last run"] ?? null, null, "an empty read leaves the slot to the stat row's None");
  for (const label of ["Compiled last cycle", "Search index", "Library notes"]) {
    const value = absent(label);
    assert.ok(value, `${label} reads through the shared absent word`);
    assert.equal(value.props.kind, "not-loaded", label);
    assert.ok(String(value.props.title ?? "").trim().length > 0, `${label} names its cause`);
  }
  const text = collectText(renderStatsOf(mod, band));
  assert.match(text, /None/);
  assert.doesNotMatch(text, /—/);
});

// spec 44084 §2.2: a failed read's stats state its cause on a visible context line; an unreported fact is no fetch failure
test("a stat whose read failed states the read's cause on its context line", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const failed = { status: "error", data: null, error: "HTTP 500 Internal Server Error" };
  const band = renderScreen(
    mod.React.createElement(mod.WikiTileBand as Component, { summaryState: ready({}), indexState: failed, backlogState: READY_BACKLOG, onRetry: () => {} }),
  );
  const [row] = findNodes(band, (n) => n.props.atom === "StatRow");
  const contextOf = Object.fromEntries(Array.from(row.props.stats as Array<{ label: string; context: unknown }>, (stat) => [stat.label, stat.context ?? null]));

  assert.deepEqual([contextOf["Search index"], contextOf["Library notes"]], ["Server error, not read.", "Server error, not read."]);
  assert.equal(contextOf["Compiled last cycle"], "Cycle not reported", "an unreported count names its source, not read-failure words");
});

describe("a stat its source never reported reads Not loaded and names that source on its context line", () => {
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const rows = [
    { name: "a cycle without a compiled count", label: "Compiled last cycle", summary: {}, index: { notes_total: 40, has_dirty_flag: true, dirty: false }, context: "Cycle not reported" },
    { name: "an index without a dirty flag", label: "Search index", summary: {}, index: { notes_total: 40, has_dirty_flag: false }, context: "Index not reported" },
    { name: "an index and cycle without a note total", label: "Library notes", summary: {}, index: { has_dirty_flag: true, dirty: false }, context: "Index not reported" },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const mod = await loadWikiScreen();
      const band = renderScreen(
        mod.React.createElement(mod.WikiTileBand as Component, { summaryState: ready(row.summary), indexState: ready(row.index), backlogState: READY_BACKLOG, onRetry: () => {} }),
      );
      const [statRow] = findNodes(band, (n) => n.props.atom === "StatRow");
      const stat = Array.from(statRow.props.stats as Array<{ label: string; value: unknown; context: unknown }>).find((s) => s.label === row.label);
      const [absent] = findNodes(renderScreen(stat?.value as RenderedNode), (n) => n.props.atom === "AbsentValue");

      assert.equal(absent?.props.kind, "not-loaded", "the value reads Not loaded");
      assert.equal(stat?.context, row.context, "the context line names the source");
      assert.notEqual(absent?.props.title, row.context, "the title keeps the long form");
    });
  }
});

test("the two status cards share the S slot inside their region hosts", async () => {
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
});

test("notes by type is a caption-only table of label and tabular count, with no meter, share, sub or foot", async () => {
  const mod = await loadWikiScreen();
  const ready = { status: "ready", error: null, data: { by_type: [{ note_type: "source-summary", count: 480 }, { note_type: "raw", count: 1474 }, { note_type: "source", count: 1 }] } };
  const tree = renderScreen(mod.React.createElement(mod.WikiNotesByTypeSection as Component, { state: ready, onRetry: () => {} }));
  const [card] = findNodes(tree, (n) => n.props.atom === "Card");
  const [table] = findNodes(tree, (n) => n.props.atom === "Table");

  assert.ok(!card.props.sub && !card.props.foot, "the card carries no sub and no foot");
  assert.ok(String(table.props.caption).length > 0 && table.props.columns === undefined, "a caption and no column heads");
  const [rows] = [table.props.children].flat() as Array<(view: unknown) => unknown>;
  const body = renderScreen(mod.React.createElement("tbody", null, rows({ isStacked: false, columnCount: 0 })));
  const cells = (pick: (n: RenderedNode) => boolean) => findNodes(body, (n) => n.props.atom === "TableCell" && pick(n));
  assert.deepEqual(cells((n) => n.props.kind === "row-header").map(collectText), ["Summary notes", "Saved originals", "Other · source"]);
  assert.deepEqual(cells((n) => n.props.isNumeric === true).map(collectText), ["480", "1,474", "1"], "the count sits in the numeric column");
  assert.equal(findNodes(tree, (n) => n.props.role === "img" || /\boverflow-hidden\b/.test(classOf(n))).length, 0, "no meter");
  assert.doesNotMatch(collectText(body), /%/, "no share");
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
