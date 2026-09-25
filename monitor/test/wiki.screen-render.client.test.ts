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

// window.UI stub — every atom resolves to a transparent host element.
function uiStub(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name === "TONE_ICON"
          ? new Proxy({}, { get: () => "dot" })
          : name === "formatInt"
          ? (n: number) => String(n)
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

test("the notes-per-day bars name their date range and their peak value with its date", async () => {
  const mod = await loadWikiScreen();
  const SparseTrendW = mod.SparseTrendW as Component;

  const dates = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];
  for (const [series, peakDate, peak] of [
    [[1, 2, 9, 3, 4], "2026-09-03", "9"],
    [[7, 1, 2, 3, 0], "2026-09-01", "7"],
  ] as const) {
    const tree = renderScreen(
      mod.React.createElement(SparseTrendW, { label: "Notes per day", series, dates, w: 10, h: 44, tone: "accent" }),
    );
    const figure = findNodes(tree, (n) => n.props.role === "img");
    assert.equal(figure.length, 1, "the bars sit inside one labelled image");
    const label = String(figure[0].props["aria-label"]);
    for (const part of [dates[0], dates[dates.length - 1], `peak ${peak} on ${peakDate}`]) {
      assert.ok(label.includes(part), `aria label names ${part}: ${label}`);
    }
    const visible = collectText(tree);
    assert.ok(visible.includes(dates[0]) && visible.includes(dates[dates.length - 1]), "the axis shows both end dates");
    assert.ok(visible.includes(`peak ${peak} on ${peakDate}`), "the visible caption carries the peak value and date");
  }
});

const LOADING = { status: "loading", data: null, error: null };
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
  ];
  for (const row of cases) {
    const message = describe(row.sections);
    assert.match(message, row.match, row.name);
    if (row.absent) assert.doesNotMatch(message, row.absent, row.name);
  }
});

test("Refresh reports busy while a wave is in flight and idle once it settles", async () => {
  const mod = await loadWikiScreen();
  for (const [busy, text] of [[true, "Refreshing…"], [false, "Refresh"]] as const) {
    const tree = renderScreen(mod.React.createElement(mod.WikiRefreshButtonW as Component, { busy, onRefresh: () => {} }));
    const button = findNodes(tree, (n) => n.type === "button")[0];
    assert.equal(button.props["aria-label"], "Refresh wiki", "the accessible name stays stable");
    assert.equal(button.props["aria-busy"], busy ? "true" : undefined, `busy=${busy}`);
    assert.ok(collectText(button).includes(text), `busy=${busy} shows ${text}`);
  }
});

test("the page header carries one Refresh control, busy while the mount wave is in flight", async () => {
  const mod = await loadWikiScreen();
  const screen = renderScreen(mod.React.createElement(mod.ScreenWiki as Component, {}));
  const header = findNodes(screen, (n) => n.props.atom === "PageHeader")[0];
  const headerRight = renderScreen(header.props.right);
  const refresh = findNodes(headerRight, (n) => n.props["aria-label"] === "Refresh wiki");
  assert.equal(refresh.length, 1, "the header carries one Refresh control");
  assert.equal(refresh[0].props["aria-busy"], "true", "the mount wave is in flight, so Refresh reads busy");
});
