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

test("each wiki section names itself with an h2 inside the summary that toggles its disclosure", async () => {
  const mod = await loadWikiScreen();
  const { createElement } = mod.React;
  const rows: Array<{ name: string; element: unknown }> = [
    { name: "Merge proposals", element: createElement(mod.WikiMaintenanceSection, { backlogState: READY_BACKLOG, onRetry: () => {} }) },
    {
      name: "Run history",
      element: createElement(mod.WikiRunHistorySection, {
        cyclesState: LOADING, summaryState: LOADING, reportState: LOADING, days: 30, onChangeDays: () => {}, onRetry: () => {},
      }),
    },
    { name: "Notes by type", element: createElement(mod.WikiNotesByTypeSection, { state: LOADING, onRetry: () => {} }) },
  ];

  for (const row of rows) {
    const tree = renderScreen(row.element);
    const heading = findSummaryHeading(tree, row.name);
    assert.ok(heading, `${row.name} renders as an h2 inside its summary`);
    const summary = findNodes(tree, (n) => n.type === "summary").find((s) => findNodes(s, (n) => n === heading).length > 0);
    assert.equal((summary?.children[0] as RenderedNode).props["aria-hidden"], "true", `${row.name} keeps the chevron first`);
  }
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

test("a failed section names its source in plain words and offers Retry only when the page has no shared banner", async () => {
  const mod = await loadWikiScreen();
  const { createElement } = mod.React;
  const failed = { status: "error", data: null, error: OUTAGE, busy: false };
  for (const onRetry of [() => {}, undefined]) {
    const tree = renderScreen(createElement(mod.WikiNotesByTypeSection, { state: failed, onRetry }));
    const cards = findNodes(tree, (n) => n.props.atom === "RegionUnavailable");
    assert.equal(cards.length, 1, "the section renders one quiet unavailable card");
    assert.equal(cards[0].props.source, "notes by type");
    assert.equal(cards[0].props.onRetry, onRetry, "Retry follows the page's choice");
    assert.doesNotMatch(collectText(tree), /HTTP|relation/, "the raw answer stays behind the card's Details");
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

test("a merge proposal's reasons wrap in full and its item is the anchor its alarm opens", async () => {
  const mod = await loadWikiScreen();
  const proposal = { cluster_hash: "c1", target_slug: "t", source_slugs: ["s"], suggested_action: "merge because both notes describe one concept" };
  const tree = renderScreen(mod.React.createElement(mod.MergeSuggestionItem as Component, { proposal }));
  const item = findNodes(tree, (n) => n.type === "li")[0];
  assert.equal(item.props.id, (mod.getProposalAnchorIdW as (h: string) => string)("c1"));
  assert.equal(item.props.tabIndex, -1, "focus can land on the item without adding a Tab stop");
  for (const node of findNodes(tree, () => true)) {
    assert.doesNotMatch(classOf(node), /\btruncate\b/, "no part of the proposal hides behind a hover title");
  }
});

test("a proposal alarm is a button that opens its proposal; other alarms stay plain rows", async () => {
  const mod = await loadWikiScreen();
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const tree = renderScreen(
    mod.React.createElement(mod.WikiAlarmLane as Component, {
      summaryState: ready({}),
      indexState: ready({}),
      backlogState: READY_BACKLOG,
      cyclesState: ready({ cycles: [] }),
    }),
  );
  const buttons = findNodes(tree, (n) => n.type === "button");
  assert.equal(buttons.length, 1, "one waiting proposal → one button");
  assert.equal(buttons[0].props.type, "button");
  assert.equal(typeof buttons[0].props.onClick, "function");
});

test("constant runs render as one row naming the range and the run count", async () => {
  const mod = await loadWikiScreen();
  const reports = ["2026-09-24", "2026-09-23", "2026-09-22"].map((run_date) => ({ run_date, status: "ok", deadlinks_count: 0, dedup_count: 3 }));
  const tree = renderScreen(mod.React.createElement(mod.WikiReportsTable as Component, { reports }));
  const rows = findNodes(tree, (n) => n.type === "tr");
  assert.equal(rows.length, 1);
  const text = collectText(rows[0]);
  assert.ok(text.includes("2026-09-22") && text.includes("2026-09-24") && text.includes("3 runs"), text);
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
      summaryState: ready({}), indexState: ready({ has_dirty_flag: true, dirty: true, last_dirty_ms: 1 }),
      backlogState: READY_BACKLOG, cyclesState: ready({ cycles: [] }),
    }),
  );
  const rows = findNodes(lane, (n) => classOf(n).split(/\s+/).includes("alarm-row"));
  assert.equal(rows.length, 2, "the dirty index and the waiting proposal");
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
    renderScreen(createElement(mod.MergeSuggestionItem, { proposal: { cluster_hash: "c1", target_slug: "t", source_slugs: ["s"], suggested_action: "merge because both notes describe one concept" } })),
  ];
  const words = ["Search index", "Clean", "Merge proposals", "Run history", "merge because both notes describe one concept"];
  for (const tree of trees) {
    for (const node of findNodes(tree, () => true)) {
      assert.doesNotMatch(classOf(node), /\bfs-micro\b/, "the 11px step is retired");
      const ownText = node.children.filter((c) => typeof c === "string").join("");
      if (words.includes(ownText.trim())) {
        assert.doesNotMatch(classOf(node), /\bfont-mono\b/, `"${ownText}" is words, not an id or figure`);
      }
    }
  }
});

test("the similarity figure is not tinted with the accent cyan", async () => {
  const mod = await loadWikiScreen();
  const proposal = { cluster_hash: "c1", target_slug: "t", source_slugs: ["s"], similarity_score: 1 };
  const tree = renderScreen(mod.React.createElement(mod.MergeSuggestionItem as Component, { proposal }));
  const sim = findNodes(tree, (n) => n.children.includes("sim ")).pop();
  assert.ok(sim, "the similarity renders");
  assert.doesNotMatch(classOf(sim), /\btext-info\b/);
});

test("the per-run table is introduced by an h3 under the Run history h2", async () => {
  const mod = await loadWikiScreen();
  const tree = renderScreen(
    mod.React.createElement(mod.WikiRunHistorySection as Component, {
      cyclesState: LOADING, summaryState: LOADING, reportState: LOADING, days: 30, onChangeDays: () => {}, onRetry: () => {},
    }),
  );
  const label = findNodes(tree, (n) => n.props.atom === "SectionLabel" && collectText(n).includes("Per-run table"))[0];
  assert.ok(label, "the table label is the shared SectionLabel");
  assert.equal(label.props.level, 3);
});
