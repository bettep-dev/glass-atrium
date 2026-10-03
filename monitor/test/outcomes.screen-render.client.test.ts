// Element-tree behaviour tests for the Task results screen's failure surfaces: a shared outage keeps
// one working Retry, and the record drawer's body failure reads as plain copy with the raw answer behind Details.
//
// Runner: npx tsx --test test/outcomes.screen-render.client.test.ts

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
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const OUTCOMES_SRC = resolve(__dirname, "../public/src/screens/outcomes.jsx");

const SERVER_ERROR = "HTTP 500 Internal Server Error — relation core.outcomes does not exist";

type Component = (props: Record<string, unknown>) => unknown;
type SetterCall = { initial: unknown; next: unknown };

interface ScreenHarness {
  tree: RenderedNode;
  setterCalls: SetterCall[];
}

const ui = await loadScreenModule(UI_SRC);
const UI = ui.UI as { INITIAL_REGION_STATE: Record<string, unknown> };

// the first `failedRegionCount` region states start failed with one shared cause; every setter call is recorded
function buildReactStub(failedRegionCount: number, setterCalls: SetterCall[]): Record<string, unknown> {
  const base = createReactStub();
  let failedSoFar = 0;
  const useState = (initial: unknown) => {
    const isRegion = initial === UI.INITIAL_REGION_STATE && failedSoFar < failedRegionCount;
    if (isRegion) failedSoFar += 1;
    const value = isRegion
      ? { ...UI.INITIAL_REGION_STATE, status: "error", busy: false, error: SERVER_ERROR }
      : typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [value, (next: unknown) => { setterCalls.push({ initial, next }); }];
  };
  return { ...base, useState };
}

async function renderOutcomesScreen(failedRegionCount: number, uiOverrides: Record<string, unknown> = {}): Promise<ScreenHarness> {
  const setterCalls: SetterCall[] = [];
  const React = buildReactStub(failedRegionCount, setterCalls);
  const mod = await loadScreenModule(OUTCOMES_SRC, {
    UI: { ...(ui.UI as Record<string, unknown>), ...uiOverrides },
    React,
    location: { hash: "" },
    URLSearchParams,
  });
  const create = React.createElement as (t: unknown, p: unknown) => unknown;
  const tree = renderScreen(create(mod.ScreenOutcomes as Component, {})) as RenderedNode;
  return { tree, setterCalls };
}

function getVisibleText(node: RenderedNode | string): string {
  if (typeof node === "string") return node;
  if (node.type === "details") return "";
  return node.children.map(getVisibleText).join(" ");
}

function getRetryButtons(tree: RenderedNode): RenderedNode[] {
  return findNodes(tree, (n) => n.type === "button" && collectText(n).trim() === "Retry");
}

test("a shared outage shows one Retry, and pressing it re-reads the page", async () => {
  const { tree, setterCalls } = await renderOutcomesScreen(2);

  const banners = findNodes(tree, (n) => n.type === "PageErrorBanner");
  const retries = getRetryButtons(tree);
  assert.equal(banners.length, 1, "two regions failing with one cause share one banner");
  assert.equal(retries.length, 1, "one outage carries exactly one Retry");
  assert.equal(findNodes(banners[0], (n) => n === retries[0]).length, 1, "the one Retry is the banner's");

  const onClick = retries[0].props.onClick;
  assert.equal(typeof onClick, "function", "the banner's Retry is wired to a handler");
  setterCalls.length = 0;
  (onClick as () => void)();

  const refreshes = setterCalls.filter((call) => call.initial === 0 && typeof call.next === "function");
  assert.equal(refreshes.length, 1, "Retry advances the refresh tick once");
  assert.equal((refreshes[0].next as (t: number) => number)(0), 1);
});

test("a cold error shows one banner, and every region it covers is a quiet placeholder with no Retry", async () => {
  const { tree } = await renderOutcomesScreen(8);
  const covered = findNodes(tree, (n) => n.type === "RegionCovered").map((n) => String(n.props.source));

  assert.equal(findNodes(tree, (n) => n.type === "PageErrorBanner").length, 1);
  assert.equal(findNodes(tree, (n) => n.type === "RegionUnavailable").length, 0, "no covered region repeats the error");
  assert.equal(getRetryButtons(tree).length, 1, "the banner holds the only Retry");
  for (const source of ["the status band", "the record ledger", "by-agent failures", "reporting health", "recording channels", "check results", "cross table"]) {
    assert.ok(covered.includes(source), `${source} is covered by the banner`);
  }
});

test("a region failing alone keeps its own error card and Retry, with no page banner", async () => {
  const { tree } = await renderOutcomesScreen(1);
  const cards = findNodes(tree, (n) => n.type === "RegionUnavailable");

  assert.equal(findNodes(tree, (n) => n.type === "PageErrorBanner").length, 0);
  assert.deepEqual(cards.map((n) => n.props.source), ["the record ledger"]);
  assert.equal(typeof cards[0].props.onRetry, "function", "the lone card keeps its Retry");
});

test("a failed record body reads as a plain sentence, with the raw answer only behind Details", async () => {
  const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
  const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
  const detailState = { status: "error", data: null, error: SERVER_ERROR };

  const tree = renderScreen(create(mod.DetailBody as Component, { detailState, markdown: "" })) as RenderedNode;
  const visible = getVisibleText(tree);
  const details = findNodes(tree, (n) => n.type === "details");

  assert.match(visible, /Couldn't load the record body\./);
  assert.doesNotMatch(visible, /HTTP|500|—/, "no raw status or response text outside Details");
  assert.equal(details.length, 1);
  assert.match(collectText(details[0]), /HTTP 500 Internal Server Error/);
});

function getFoldButton(tree: RenderedNode, title: string): RenderedNode | undefined {
  return findNodes(tree, (n) => n.type === "button" && "aria-expanded" in n.props && collectText(n).includes(title))[0];
}

test("status folds render open while their detail breakdowns start collapsed", async () => {
  const { tree } = await renderOutcomesScreen(0);
  const rows = [
    { title: "Reporting health", isOpen: true },
    { title: "Self-report quality", isOpen: true },
    { title: "Daily breakdown", isOpen: false },
    { title: "By task type", isOpen: false },
  ];

  for (const row of rows) {
    const button = getFoldButton(tree, row.title);
    assert.ok(button, `${row.title} renders as a fold`);
    assert.equal(button.props["aria-expanded"], row.isOpen, `${row.title} open state`);
  }
});

// the shared SplitRow with another default layout → a row that names its own layout renders the same under either
function withSplitRowDefault(layout: string): Record<string, unknown> {
  const SplitRow = (ui.UI as Record<string, Component>).SplitRow;
  return { SplitRow: (props: Record<string, unknown>) => SplitRow({ layout, ...props }) };
}

for (const sharedDefault of ["content", "equal"]) {
  test(`paired cards sit side by side in one split row, each row naming its own layout (shared default ${sharedDefault})`, async () => {
    const { tree } = await renderOutcomesScreen(0, withSplitRowDefault(sharedDefault));
    const rows = [
      // equal: peer reporting cards end level · content: each card keeps its own height
      { name: "record attribution beside recording channels, ending level", ratio: "split-row--1-1", layout: "split-row--equal", titles: ["Record attribution", "Recording channels"] },
      { name: "check results beside the crosstab", ratio: "split-row--1-1", layout: "split-row--content", titles: ["Automatic check results", "Confident but failed"] },
    ];

    for (const row of rows) {
      const splitRows = findNodes(tree, (n) => String(n.props.className ?? "").includes(row.ratio));
      const pair = splitRows.find((n) => row.titles.every((title) => collectText(n).includes(title)));
      assert.ok(pair, row.name);
      assert.equal(pair.children.filter((child) => typeof child !== "string").length, 2, `${row.name}: exactly two columns`);
      assert.ok(String(pair.props.className).includes(row.layout), `${row.name}: ${row.layout}`);
    }
  });
}

test("the per-agent table spans the full width", async () => {
  const { tree } = await renderOutcomesScreen(0);
  const splitRows = findNodes(tree, (n) => String(n.props.className ?? "").includes("split-row"));

  // no half-width column → no empty stretch under the per-agent table beside the taller Reporting health stack
  assert.ok(!splitRows.some((n) => collectText(n).includes("Failures by agent")), "per-agent table sits in no split row");
});

// design.md copy caps → a longer header wraps the 48px card head; the long form belongs in the card's ⓘ drawer
const COPY_CAP = { title: 24, meta: 32 };

function getHeaderCopy(tree: RenderedNode): { kind: string; title: string; sub: unknown }[] {
  return findNodes(tree, (n) => n.type === "CardHead" || n.type === "Disclosure")
    .map((n) => ({ kind: String(n.type), title: String(n.props.title), sub: n.props.sub }));
}

test("every card and fold header on the screen fits the title and header-meta caps, loaded or not", async () => {
  const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
  const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
  const crosstab = { total: 12_000, polarTotal: 1_500, byCell: { "high|false": { count: 1_234 } } };
  const readyCrosstab = { status: "ready", busy: false, data: { crosstab }, error: null };
  const headers = [
    ...getHeaderCopy((await renderOutcomesScreen(0)).tree),
    ...getHeaderCopy(renderScreen(create(mod.CrosstabCard as Component, { state: readyCrosstab, onRetry: () => undefined })) as RenderedNode),
  ];

  assert.ok(headers.length >= 8, `the screen's headers are all collected (${headers.length})`);
  for (const header of headers) {
    assert.ok(header.title.length <= COPY_CAP.title, `${header.kind} title "${header.title}" is ${header.title.length} chars`);
    if (typeof header.sub === "string") {
      assert.ok(header.sub.length <= COPY_CAP.meta, `${header.kind} "${header.title}" meta "${header.sub}" is ${header.sub.length} chars`);
    }
  }
});

describe("the cross-table header shows its count meta only when there are records, and always shows the mismatch badge", () => {
  const rows = [
    { name: "a ready cross table with records", crosstab: { total: 12_000, polarTotal: 1_500, byCell: { "high|false": { count: 1_234 } } }, hasMeta: true },
    { name: "a ready cross table with no records", crosstab: { total: 0, polarTotal: 0, byCell: {} }, hasMeta: false },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
      const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
      const state = { status: "ready", busy: false, data: { crosstab: row.crosstab }, error: null };
      const [head] = findNodes(renderScreen(create(mod.CrosstabCard as Component, { state, onRetry: () => undefined })) as RenderedNode,
        (n) => n.type === "CardHead");

      assert.equal(findNodes(head, (n) => n.props.className === "card-sub").length, row.hasMeta ? 1 : 0);
      const badges = findNodes(head, (n) => n.type === "Badge");
      assert.equal(badges.length, 1);
      assert.match(collectText(badges[0]), new RegExp(`${row.crosstab.polarTotal.toLocaleString("en-US")}\\s+mismatches`));
    });
  }
});

// component nodes keep their name as type; the region's card is the first host element beneath them
function getRootHost(node: RenderedNode): RenderedNode {
  const [child] = node.children;
  const isComponent = /^[A-Z]/.test(String(node.type));
  return isComponent && child && typeof child !== "string" ? getRootHost(child) : node;
}

test("a region's error card hands a focused, successful Retry to that region's own card, which stays mounted", async () => {
  const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
  const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
  const retrying = { status: "error", busy: true, data: null, error: SERVER_ERROR };
  const ready = { status: "ready", busy: false, data: { overall: {} }, error: null };
  const onRetry = () => undefined;
  const rows = [
    { name: "status band", component: "StatusBandO", props: { analyticsState: retrying, attentionState: ready, windowDays: 30, freshness: null, onRetry } },
    { name: "needs-you count", component: "StatusBandO", props: { analyticsState: ready, attentionState: retrying, windowDays: 30, freshness: null, onRetry } },
    { name: "by-agent failures", component: "AgentFailureTableO", props: { state: retrying, onRetry } },
    { name: "record attribution", component: "AttributionHealthCard", props: { state: retrying, period: 30, onRetry } },
    { name: "recording channels", component: "ChannelLivenessCard", props: { state: retrying, onRetry } },
    { name: "check results", component: "GraderBreakdownCard", props: { state: retrying, onRetry } },
    { name: "cross table", component: "CrosstabCard", props: { state: retrying, onRetry } },
    { name: "run events", component: "LoopEventsCard", props: { state: retrying, onRetry } },
    {
      name: "record ledger",
      component: "ResultTableCard",
      props: {
        state: retrying, rows: [], totalMatched: 0, page: 0, limit: 50, sort: "newest", filter: {}, onRetry,
        closure: { pendingIds: new Set(), closedOverrides: new Map() }, needsYou: { rows: [], hiddenCount: 0 }, needsYouCap: 5,
      },
    },
  ];

  for (const row of rows) {
    const tree = renderScreen(create(mod[row.component] as Component, row.props)) as RenderedNode;
    const errorCards = findNodes(tree, (n) => n.type === "RegionUnavailable");
    assert.equal(errorCards.length, 1, `${row.name}: one error card`);

    const [errorCard] = errorCards;
    const targetId = errorCard.props.focusTargetId;
    assert.equal(errorCard.props.isBusy, true, `${row.name}: the card stays up, busy, through the Retry`);
    assert.ok(typeof targetId === "string" && targetId.length > 0, `${row.name}: the Retry names a focus target`);
    assert.equal(getRootHost(tree).props.id, targetId, `${row.name}: the target is the region's own card, mounted in every state`);
  }
});

test("a closed caveat row shows its result and its closure as two separate groups", async () => {
  const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
  const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
  const row = { id: 41, agent: "glass-atrium-dev-react", task_type: "feature", result: "done_with_concerns", closed_at: "2026-09-01T10:00:00.000Z", summary: "Split the ledger" };
  const closure = { pendingIds: new Set(), closedOverrides: new Map() };
  const tree = renderScreen(create(mod.ResultTableRow as Component, { row, onRowClick: () => undefined, closure })) as RenderedNode;

  const resultGroup = findNodes(tree, (n) => n.props["data-group"] === "result")[0];
  const closureGroup = findNodes(tree, (n) => n.props["data-group"] === "closure")[0];
  assert.ok(resultGroup && closureGroup, "both groups render");
  assert.equal(collectText(resultGroup).trim(), "Done with caveats");
  assert.equal(collectText(closureGroup).trim(), "Closed");
  assert.equal(findNodes(resultGroup, (n) => n === closureGroup).length, 0, "the closure group is not nested inside the result group");
});

test("a channel row keeps to two single lines, the detail line carrying its full text as a tooltip", async () => {
  const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
  const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
  const channel = {
    attribution_source: "structuredoutput-completion", alerting: false, eligible: true,
    silent_hours: 3.4, recent_peak_daily_count: 171, peak_daily_count: 1204,
  };
  const tree = renderScreen(create(mod.ChannelLivenessRow as Component, { channel, days: 30, recencyDays: 7 })) as RenderedNode;

  const lines = getRootHost(tree).children.filter((child): child is RenderedNode => typeof child !== "string");
  assert.equal(lines.length, 2, "status line + detail line");
  for (const line of lines) {
    assert.match(String(line.props.className ?? ""), /whitespace-nowrap|truncate/, `"${collectText(line)}" cannot wrap`);
  }
  const detail = lines[1];
  assert.match(String(detail.props.className), /truncate/);
  assert.equal(detail.props.title, collectText(detail).trim());
});

test("the task ledger scrolls with the page, never inside a box of its own", async () => {
  const { tree } = await renderOutcomesScreen(0);
  const [ledger] = findNodes(tree, (n) => n.type === "ResultTableCard");
  assert.ok(ledger, "the ledger card renders");

  const bodies = findNodes(ledger, (n) => String(n.props.className ?? "").split(" ").includes("card-body"));
  assert.ok(bodies.length > 0, "the ledger has a card body");
  for (const body of bodies) {
    // the shared .card-body caps at 70vh with overflow-y auto → the Routine rows would sit in a nested scroller
    const style = (body.props.style ?? {}) as Record<string, unknown>;
    assert.equal(style.maxHeight, "none", "no height cap");
    assert.equal(style.overflowY, "visible", "no inner vertical scroll");
  }
});

test("each recording channel's busiest recent day is drawn against the watch floor", async () => {
  const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
  const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
  const floor = 100;
  const rows = [
    { name: "a channel above the floor", source: "structuredoutput-completion", peak: 678 },
    { name: "a channel just under the floor", source: "hook-input", peak: 99 },
    { name: "a channel exactly at the floor", source: "completion-synthesized", peak: 100 },
    { name: "a channel that wrote nothing recently", source: "budget-truncation", peak: 0 },
  ];
  const channels = rows.map((row) => ({
    attribution_source: row.source, recent_peak_daily_count: row.peak, peak_daily_count: row.peak + 40,
    silent_hours: 2, eligible: row.peak >= floor, alerting: false,
  }));
  const data = { days: 30, channels, alerting: [], thresholds: { eligibility_daily_floor: floor, eligibility_recency_days: 2, silence_hours: 24 } };
  const state = { status: "ready", busy: false, data, error: null };
  const tree = renderScreen(create(mod.ChannelLivenessBody as Component, { state, onRetry: () => undefined })) as RenderedNode;

  const text = collectText(tree);
  assert.match(text, /last 2d/, "the block names its window");
  assert.match(text, /100\/day/, "the block names the floor");
  const bars = findNodes(tree, (n) => n.type === "BulletBar");
  assert.equal(bars.length, rows.length, "one bar per channel");
  for (const row of rows) {
    const bar = bars.find((b) => String(b.props.ariaLabel ?? "").includes(row.source));
    assert.ok(bar, `${row.name}: has a bar`);
    const { value, target } = bar.props as { value: number; target: number };
    assert.ok(value >= 0 && value <= 1 && target > 0 && target <= 1, `${row.name}: bar stays on its track`);
    assert.equal(value >= target, row.peak >= floor, `${row.name}: fill reaches the floor marker only at or above the floor`);
  }
});
