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
import { getCssRules, getReducedMotionCss } from "./lib/css-source.js";

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
  for (const source of ["the status band", "the record ledger", "by-agent failures", "record attribution", "recording channels", "check results", "cross table"]) {
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

// a fold whose body holds a block of the page's own → its body is boxless, every block and nested fold on the host's inset
function getFold(tree: RenderedNode, title: string): RenderedNode {
  const [fold] = findNodes(tree, (n) => n.type === "Disclosure" && n.props.title === title);
  assert.ok(fold, `${title} renders as a fold`);
  return fold;
}

function hasClass(node: RenderedNode, name: string): boolean {
  return String(node.props.className ?? "").split(/\s+/).includes(name);
}

describe("a status fold's body holds its two blocks and its detail fold with no card inside", () => {
  const rows = [
    { name: "Reporting health", blocks: ["Record attribution", "Recording channels"], nested: "Daily breakdown" },
    { name: "Self-report quality", blocks: ["Automatic check results", "Confident but failed"], nested: "By task type" },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const fold = getFold((await renderOutcomesScreen(0)).tree, row.name);
      const [split] = findNodes(fold, (n) => hasClass(n, "split-row"));

      assert.equal(findNodes(fold, (n) => hasClass(n, "card")).length, 1, "the fold's own box is its one card");
      assert.ok(hasClass(split, "split-row--divided"), "the two blocks part on one hairline");
      assert.deepEqual(findNodes(split, (n) => n.type === "SectionLabel").map((n) => collectText(n)), row.blocks);
      assert.equal(getFold(fold, row.nested).props.isInline, true, `${row.nested} folds inline`);
    });
  }
});

test("the per-agent table spans the full width", async () => {
  const { tree } = await renderOutcomesScreen(0);
  const splitRows = findNodes(tree, (n) => String(n.props.className ?? "").includes("split-row"));

  // no half-width column → no empty stretch under the per-agent table beside the taller Reporting health stack
  assert.ok(!splitRows.some((n) => collectText(n).includes("Failures by agent")), "per-agent table sits in no split row");
});

// design.md copy caps → a longer header wraps the 48px card head; the long form belongs in the card's ⓘ drawer
const COPY_CAP = { title: 24, meta: 32 };

// the caps bound painted copy → a screen-reader-only word is no part of it
function collectPaintedText(node: RenderedNode | string | null): string {
  if (node === null || typeof node === "string") return collectText(node);
  if (String(node.props.className ?? "").split(/\s+/).includes("sr-only")) return "";
  return node.children.map(collectPaintedText).join(" ");
}

function getHeaderCopy(tree: RenderedNode): { kind: string; title: string; sub: unknown }[] {
  return findNodes(tree, (n) => n.type === "CardHead" || n.type === "Disclosure" || n.type === "FoldBlockO")
    .map((n) => ({ kind: String(n.type), title: String(n.props.title), sub: n.props.sub ?? n.props.status }));
}

test("every card and fold header on the screen fits the title and header-meta caps, loaded or not", async () => {
  const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
  const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
  const crosstab = { total: 12_000, polarTotal: 1_500, byCell: { "high|false": { count: 1_234 } } };
  const readyCrosstab = { status: "ready", busy: false, data: { crosstab }, error: null };
  const headers = [
    ...getHeaderCopy((await renderOutcomesScreen(0)).tree),
    ...getHeaderCopy(renderScreen(create(mod.CrosstabBlock as Component, { state: readyCrosstab, onRetry: () => undefined })) as RenderedNode),
  ];

  assert.ok(headers.length >= 8, `the screen's headers are all collected (${headers.length})`);
  for (const header of headers) {
    assert.ok(header.title.length <= COPY_CAP.title, `${header.kind} title "${header.title}" is ${header.title.length} chars`);
    const meta = typeof header.sub === "string" ? header.sub : collectPaintedText(renderScreen(header.sub) as RenderedNode | null);
    assert.ok(meta.length <= COPY_CAP.meta, `${header.kind} "${header.title}" meta "${meta}" is ${meta.length} chars`);
  }
});

// a block's head line: its level-3 title, then its own status on the same line
function getBlockHead(tree: RenderedNode): RenderedNode {
  const [block] = findNodes(tree, (n) => n.type === "FoldBlockO");
  assert.ok(block, "the region renders as a fold block");
  const [head] = findNodes(block, (n) => n.children.some((child) => typeof child !== "string" && child.type === "SectionLabel"));
  return head;
}

describe("the cross-table head shows its share meta, count in the hover title, only when there are records, and a warn status only over a counted mismatch", () => {
  const rows = [
    {
      name: "a ready cross table with mismatches",
      crosstab: { total: 12_000, polarTotal: 1_500, byCell: { "high|false": { count: 1_234 } } },
      metas: [{ text: "10.3%", title: "1,234 of 12,000 records · 10.3%" }],
      status: "1,500 mismatches",
    },
    {
      name: "a ready cross table with records and no mismatch",
      crosstab: { total: 40, polarTotal: 0, byCell: { "high|true": { count: 40 } } },
      metas: [{ text: "0%", title: "0 of 40 records · 0%" }],
      status: null,
    },
    { name: "a ready cross table with no records", crosstab: { total: 0, polarTotal: 0, byCell: {} }, metas: [], status: null },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
      const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
      const state = { status: "ready", busy: false, data: { crosstab: row.crosstab }, error: null };
      const head = getBlockHead(renderScreen(create(mod.CrosstabBlock as Component, { state, onRetry: () => undefined })) as RenderedNode);

      const metas = findNodes(head, (n) => typeof n.props.title === "string" && n.type === "span")
        .map((meta) => ({ text: collectText(meta), title: meta.props.title }));
      assert.deepEqual(metas, row.metas);
      const statuses = findNodes(head, (n) => n.type === "HeadStatus");
      assert.deepEqual(statuses.map((status) => [status.props.tone, collectPaintedText(status).replace(/\s+/g, " ").trim()]),
        row.status ? [["warn", row.status]] : [], "the warn status names the mismatches, and only when one was counted");
    });
  }
});

test("a recording channel's name stays on one line in regular weight, and Status and Quiet shrink to their content", async () => {
  const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
  const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
  const channel = { attribution_source: "structuredoutput-completion", alerting: false, eligible: true, peak_daily_count: 120, recent_peak_daily_count: 90, silent_hours: 2 };
  const state = { status: "ready", busy: false, data: { channels: [channel], alerting: [], days: 7 }, error: null };
  const tree = renderScreen(create(mod.ChannelLivenessBlock as Component, { state, onRetry: () => undefined, shared: {} })) as RenderedNode;
  const [table] = findNodes(tree, (n) => n.type === "Table");
  const [name] = findNodes(table, (n) => n.type === "th" && n.props.scope === "row");
  const cellClass = String(name.props.className).split(/\s+/);

  assert.ok(cellClass.includes("whitespace-nowrap") && cellClass.includes("font-normal"), String(name.props.className));
  assert.deepEqual(Array.from(table.props.widths as unknown[]), [undefined, "1%", undefined, undefined, "1%"]);
});

describe("the Recording channels head that read no channel shows faint None or Not loaded, with no status mark", () => {
  const failed = { status: "error", busy: false, data: null, error: SERVER_ERROR };
  const rows = [
    { name: "Recording channels, no channel in the window", component: "ChannelLivenessBlock", word: "None",
      state: { status: "ready", busy: false, data: { channels: [], alerting: [], days: 7 }, error: null } },
    { name: "Recording channels, a failed read", component: "ChannelLivenessBlock", word: "Not loaded", state: failed },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
      const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
      const tree = renderScreen(create(mod[row.component] as Component, { state: row.state, period: 30, onRetry: () => undefined, shared: {} })) as RenderedNode;
      const head = getBlockHead(tree);

      assert.equal(findNodes(head, (n) => n.type === "HeadStatus").length, 0, "no status mark");
      const words = findNodes(head, (n) => n.type === "AbsentValue").map((n) => collectText(n).trim());
      assert.deepEqual(words, [row.word]);
      assert.doesNotMatch(collectText(head), /All recording/);
    });
  }
});

describe("a block's own status is the shared head Status on its title's line", () => {
  const rows = [
    { name: "Record attribution", component: "AttributionHealthBlock", data: { days_series: [], window_summary: { literal_omission_rate: 0.0123, total_attributed: 81 } } },
    { name: "Recording channels", component: "ChannelLivenessBlock", data: { channels: [{ attribution_source: "stop", alerting: true, eligible: true }], alerting: ["stop"], days: 7 } },
    { name: "Confident but failed", component: "CrosstabBlock", data: { crosstab: { total: 10, polarTotal: 4, byCell: {} } } },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
      const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
      const state = { status: "ready", busy: false, data: row.data, error: null };
      const tree = renderScreen(create(mod[row.component] as Component, { state, period: 30, onRetry: () => undefined, shared: {} })) as RenderedNode;
      const head = getBlockHead(tree);

      assert.equal(collectText(findNodes(head, (n) => n.type === "SectionLabel")[0]), row.name);
      assert.equal(findNodes(tree, (n) => n.props["data-role"] === "head-status").length, 1, "one head status");
      assert.equal(findNodes(head, (n) => n.type === "HeadStatus").length, 1, "the shared Status, on the title line");
    });
  }
});

describe("an empty ledger names the window when no filter is applied, and offers the reset when one is", () => {
  const onResetFilter = () => undefined;
  const rows = [
    { name: "no filter, the 30-day window", filter: { days: 30 }, includeAll: false, text: "No task results in the last 30 days.", canReset: false },
    { name: "no filter, the 7-day window", filter: { days: 7 }, includeAll: false, text: "No task results in the last 7 days.", canReset: false },
    { name: "an agent filter", filter: { days: 30, agent: "glass-atrium-dev-front" }, includeAll: false, text: "No records match these filters.", canReset: true },
    { name: "the include-all toggle", filter: { days: 30 }, includeAll: true, text: "No records match these filters.", canReset: true },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
      const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
      const tree = renderScreen(create(mod.ResultTableCard as Component, {
        state: { status: "ready", busy: false, data: { rows: [] }, error: null }, rows: [], totalMatched: 0, page: 0, limit: 50,
        sort: "record_ts:desc", filter: row.filter, filterControls: { includeAll: row.includeAll }, onResetFilter,
        closure: { pendingIds: new Set(), closedOverrides: new Map() }, needsYou: { rows: [], hiddenCount: 0 }, needsYouCap: 5,
      })) as RenderedNode;
      const [empty] = findNodes(tree, (n) => n.type === "EmptyState");
      const resets = findNodes(empty, (n) => n.type === "button" && collectText(n).trim() === "Reset filters");

      // collectText joins child nodes with a space → compare with whitespace dropped
      const squash = (text: string) => text.replace(/\s+/g, "");
      assert.ok(squash(collectText(empty)).startsWith(squash(row.text)), collectText(empty));
      assert.equal(resets.length, row.canReset ? 1 : 0, "a reset only when a filter is applied");
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
    { name: "record attribution", component: "AttributionHealthBlock", props: { state: retrying, period: 30, onRetry } },
    { name: "recording channels", component: "ChannelLivenessBlock", props: { state: retrying, onRetry } },
    { name: "check results", component: "GraderBreakdownBlock", props: { state: retrying, onRetry } },
    { name: "cross table", component: "CrosstabBlock", props: { state: retrying, onRetry } },
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

// the error card carries no outer margin → the band's own atoms own its inset and its gap from the Status card
test("a status band failure takes its inset from a card and its distance from the Status card from the band's block stack", async () => {
  const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
  const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
  const failed = { status: "error", busy: false, data: null, error: SERVER_ERROR };
  const ready = { status: "ready", busy: false, data: { overall: {} }, error: null };
  const render = (props: Record<string, unknown>) => renderScreen(create(mod.StatusBandO as Component,
    { windowDays: 30, freshness: null, onRetry: () => undefined, ...props })) as RenderedNode;
  const isRegionError = (n: RenderedNode) => n.type === "RegionUnavailable";

  const bandFailed = render({ analyticsState: failed, attentionState: ready });
  const insetCards = findNodes(bandFailed, (n) => n.type === "Card" && findNodes(n, isRegionError).length === 1);
  assert.equal(insetCards.length, 1, "the band's own failure sits inside one card");

  const countFailed = render({ analyticsState: ready, attentionState: failed });
  const stacks = findNodes(countFailed, (n) => n.type === "Stack" && findNodes(n, isRegionError).length === 1);
  assert.equal(stacks.length, 1, "one stack holds the needs-you failure");
  const [stack] = stacks;
  assert.equal(stack.props.gap ?? "block", "block", "the stack spaces on the block gap");
  const [statusCard] = findNodes(stack, (n) => n.type === "Card");
  assert.ok(statusCard, "the Status card shares the stack");
  assert.equal(findNodes(statusCard, isRegionError).length, 0, "the failure is the card's sibling, never inside it");
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

describe("the task ledger takes the .tbl cell geometry under its own header and body face", async () => {
  const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
  const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
  // 12 needs-you rows shown uncapped → the Show-first control row; the open caveat among them → its Close caveat button; a routine row
  const rows = [
    ...Array.from({ length: 11 }, (_, i) => ({ id: i + 1, agent: "glass-atrium-dev-react", task_type: "feature", result: "fail", record_ts: "2026-09-01T10:00:00.000Z", summary: "Broke" })),
    { id: 20, agent: "glass-atrium-dev-react", task_type: "feature", result: "done_with_concerns", closed_at: null, record_ts: "2026-09-01T10:00:00.000Z", summary: "Caveat" },
    { id: 21, agent: "glass-atrium-dev-react", task_type: "review", result: "done", record_ts: "2026-09-01T10:00:00.000Z", summary: "Routine" },
  ];
  const closure = { pendingIds: new Set(), closedOverrides: new Map(), onMarkClosed: () => undefined };
  const tree = renderScreen(create(mod.ResultTable as Component, {
    rows, sort: "record_ts:desc", onSortChange: () => undefined, onRowClick: () => undefined, closure,
    needsYouCap: null, onToggleNeedsYou: () => undefined,
  })) as RenderedNode;
  const tokensOf = (node: RenderedNode): string[] => String(node.props.className ?? "").split(/\s+/).filter(Boolean);
  const columnHeads = findNodes(tree, (n) => n.type === "th" && n.props.scope === "col");

  test("the ledger is a .tbl table marked own-face, drawn by the shared Table component", () => {
    const tables = findNodes(tree, (n) => n.type === "table");
    assert.equal(tables.length, 1);
    assert.ok(tokensOf(tables[0]).includes("tbl"), "the .tbl cell geometry applies");
    assert.ok(tokensOf(tables[0]).includes("tbl--own-face"), "the house header face and row states stay off");
    assert.equal(findNodes(tree, (n) => n.type === "Table").length, 1);
  });

  test("every column header is the shared TableHead in the ledger's own sentence-case face, one line each", () => {
    assert.deepEqual(findNodes(tree, (n) => n.type === "TableHead").length, 7);
    assert.deepEqual(columnHeads.map((th) => collectText(th).trim()), ["Time", "Agent", "Task type", "Result", "Why", "Summary", "Actions"]);
    const actionsHead = findNodes(columnHeads.at(-1)!, (n) => tokensOf(n).includes("sr-only"));
    assert.equal(collectText(actionsHead[0]).trim(), "Actions", "the action column's head is for assistive tech only");
    // the head face rides the table's thead variants → every column head takes it, none spells it out
    const [table] = findNodes(tree, (n) => n.type === "table");
    const faces = ["text-dim", "font-medium", "whitespace-nowrap"].map((t) => `[&_thead_th]:${t}`);
    assert.ok(faces.every((t) => tokensOf(table).includes(t)), `the head face: ${tokensOf(table)}`);
    for (const th of columnHeads) {
      const tokens = tokensOf(th);
      assert.ok(!tokens.includes("uppercase"), `'${collectText(th)}' is not upper-cased`);
      assert.equal((th.props.style as Record<string, unknown>).position, "sticky");
    }
  });

  test("the Time header sorts through one native button holding its label and arrow, the cell keeping aria-sort", () => {
    const [time] = columnHeads;
    assert.equal(time.props["aria-sort"], "descending");
    assert.equal(time.props.onClick, undefined, "the cell is not the click target");
    const buttons = findNodes(time, (n) => n.type === "button");
    assert.equal(buttons.length, 1);
    const [button] = buttons;
    assert.equal(button.props.type, "button", "a native button → Enter and Space activate it");
    assert.ok(["btn", "ghost", "sm"].every((t) => tokensOf(button).includes(t)), `the shared small ghost control: ${tokensOf(button)}`);
    assert.match(collectText(button), /Time/);
    assert.equal(findNodes(button, (n) => n.type === "svg").length, 1, "the arrow is inside the button");
  });

  describe("activating the Time button requests the other direction, and the first press on an inactive column asks for newest first", () => {
    const rows = [
      { name: "active descending → ascending", sort: "record_ts:desc", next: "record_ts:asc" },
      { name: "active ascending → descending", sort: "record_ts:asc", next: "record_ts:desc" },
      { name: "another column active → descending", sort: "agent:asc", next: "record_ts:desc" },
    ];
    for (const row of rows) {
      test(row.name, () => {
        const requested: string[] = [];
        const sorted = renderScreen(create(mod.ResultTable as Component, {
          rows: [], sort: row.sort, onSortChange: (next: string) => requested.push(next), onRowClick: () => undefined, closure,
          needsYouCap: null, onToggleNeedsYou: () => undefined,
        })) as RenderedNode;
        const [time] = findNodes(sorted, (n) => n.type === "th" && n.props.scope === "col");
        const [button] = findNodes(time, (n) => n.type === "button");
        assert.ok(button, "the Time header holds a button");
        (button.props.onClick as () => void)();
        assert.deepEqual(requested, [row.next]);
      });
    }
  });

  test("no cell, and no control in a cell, carries its own padding, margin or rule", () => {
    const cells = findNodes(tree, (n) => n.type === "th" || n.type === "td");
    const controls = findNodes(tree, (n) => n.type === "button");
    assert.ok(cells.some((n) => n.type === "td") && controls.length >= 2, "rows, the Close caveat button and the Show-all control render");
    for (const node of [...cells, ...controls]) {
      const adHoc = tokensOf(node).filter((t) => /^-?(p|m)[xytblrse]?-/.test(t) || /^border-b$/.test(t));
      assert.deepEqual(adHoc, [], `${node.type} '${collectText(node).trim().slice(0, 24)}'`);
    }
  });

  test("a section heading is a level-3 heading on the cell atom's group-header face, sans and sentence case", () => {
    const headings = findNodes(tree, (n) => n.type === "th" && n.props.scope === "colgroup");
    assert.ok(headings.length >= 2, "Needs you and Routine");
    for (const heading of headings) {
      const label = collectText(heading).trim();
      assert.equal(heading.props.role, "heading", label);
      assert.equal(heading.props["aria-level"], 3, label);
      assert.ok(tokensOf(heading).includes("tbl-cell--group-header"), label);
      assert.deepEqual(tokensOf(heading).filter((t) => ["font-mono", "uppercase", "tracking-wider"].includes(t)), [], label);
    }
  });
});

describe("Recording channels is one table, silent channels first, each by its full name with its units attached", () => {
  const channels = [
    { attribution_source: "structuredoutput-completion", alerting: false, eligible: true, silent_hours: 3.4, recent_peak_daily_count: 171, peak_daily_count: 1204 },
    { attribution_source: "transcript-synthesis", alerting: false, eligible: false, silent_hours: 50, recent_peak_daily_count: 4, peak_daily_count: 12 },
    { attribution_source: "subagent-stop", alerting: true, eligible: true, silent_hours: 30.8, recent_peak_daily_count: 0, peak_daily_count: 640 },
  ];
  const data = { channels, alerting: ["subagent-stop"], days: 7, thresholds: { eligibility_daily_floor: 100, eligibility_recency_days: 2, silence_hours: 24 } };
  const renderBody = async () => {
    const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
    const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
    return renderScreen(create(mod.ChannelLivenessBody as Component, { state: { status: "ready", busy: false, data, error: null }, onRetry: () => undefined, shared: {} })) as RenderedNode;
  };
  // what a screen reader reads: aria-hidden marks dropped, sr-only words kept → a state word read twice shows here
  const getSpokenText = (node: RenderedNode | string | null): string => {
    if (node === null || typeof node === "string") return collectText(node);
    return node.props["aria-hidden"] === "true" ? "" : node.children.map(getSpokenText).join("");
  };
  const getRows = (tree: RenderedNode) => findNodes(tree, (n) => n.type === "tr" && findNodes(n, (c) => c.type === "td").length > 0)
    .map((tr) => findNodes(tr, (c) => c.type === "td" || c.type === "th").map((cell) => getSpokenText(cell).replace(/\s+/g, " ").trim()));

  test("the columns read Channel, Status, the window peak, the busiest recent day and the quiet time, with no bar", async () => {
    const tree = await renderBody();
    const [table] = findNodes(tree, (n) => n.type === "Table");

    assert.deepEqual(Array.from(table.props.columns as { label: string }[], (col) => col.label), ["Channel", "Status", "Peak, 7d", "Busiest, 2d", "Quiet"]);
    assert.equal(findNodes(tree, (n) => n.type === "BulletBar").length, 0);
  });

  test("silent rows lead, and each row reads its name, state word and figures with units", async () => {
    assert.deepEqual(getRows(await renderBody()), [
      ["subagent-stop", "Silent", "640/day", "0/day", "30h"],
      ["structuredoutput-completion", "Recording", "1,204/day", "171/day", "3h"],
      ["transcript-synthesis", "Below floor", "12/day", "4/day", "50h"],
    ]);
  });

  test("each channel name appears once, never cut short", async () => {
    const tree = await renderBody();
    for (const channel of channels) {
      const names = findNodes(tree, (n) => n.type === "MachineString" && collectText(n) === channel.attribution_source);
      assert.equal(names.length, 1, channel.attribution_source);
      assert.equal(findNodes(tree, (n) => String(n.props.className ?? "").split(" ").includes("truncate")).length, 0);
    }
  });
});

test("the task ledger scrolls with the page, never inside a box of its own", async () => {
  const { tree } = await renderOutcomesScreen(0);
  const [ledger] = findNodes(tree, (n) => n.type === "ResultTableCard");
  assert.ok(ledger, "the ledger card renders");

  const [card] = findNodes(ledger, (n) => String(n.props.className ?? "").split(" ").includes("card"));
  assert.ok(card, "the ledger renders a card");
  // the shared .card-body caps at 70vh with overflow-y auto → the Routine rows would sit in a nested scroller
  const classes = String(card.props.className).split(" ");
  assert.ok(classes.includes("[&>.card-body]:max-h-none"), "no height cap on its body");
  assert.ok(classes.includes("[&>.card-body]:overflow-y-visible"), "no inner vertical scroll");
});

function getDecl(body: string, prop: string): string | undefined {
  return body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`))?.[1].trim();
}

describe("the screen's own stylesheet keeps to the motion standard", async () => {
  const { tree } = await renderOutcomesScreen(0);
  const css = findNodes(tree, (n) => n.type === "style").map(collectText).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const reduced = getReducedMotionCss(css);
  const moving = getCssRules(css).flatMap(([selector, body]) =>
    (["animation", "transition"] as const)
      .filter((prop) => !/^none\b/.test(getDecl(body, prop) ?? "none"))
      .map((prop) => ({ selector, prop, value: getDecl(body, prop) ?? "" })),
  );

  test("the scan finds the sheet's one moving rule, a row transition, and no loop of its own", () => {
    assert.deepEqual(moving.map((m) => `${m.selector} ${m.prop}`), [".outcome-row transition"]);
  });

  for (const { selector, prop, value } of moving) {
    test(`${selector} stops its ${prop} under reduced motion`, () => {
      const gate = getCssRules(reduced).filter(([s]) => s === selector).map(([, body]) => body).join(";");
      assert.match(gate, new RegExp(`${prop}:\\s*none`));
    });
    if (prop === "transition") {
      test(`${selector} changes state at the 120ms standard`, () => {
        assert.deepStrictEqual(value.match(/\d+m?s/g), ["120ms"], `transition: ${value}`);
      });
    }
  }
});

test("the daily chart's idle hint fits the word cap, and the arrow-key note is the chart's description, not its name", async () => {
  const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
  const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
  const grid = [{ day: "2026-11-23", total: 4, counts: {} }, { day: "2026-11-24", total: 6, counts: {} }];
  const tree = renderScreen(create(mod.AttributionDailyChart as Component, { grid })) as RenderedNode;
  const [hint] = findNodes(tree, (n) => n.props["aria-live"] === "polite");
  const [plot] = findNodes(tree, (n) => n.props.role === "img");
  const [note] = findNodes(tree, (n) => n.props.id !== undefined && n.props.id === plot.props["aria-describedby"]);

  assert.ok(collectText(hint).trim().split(/\s+/).length <= 12, collectText(hint));
  assert.match(collectText(note), /arrow keys/);
  assert.match(String(note.props.className), /\bsr-only\b/);
  assert.doesNotMatch(String(plot.props["aria-label"]), /arrow keys/);
});

test("a link in an outcome body draws in ink with a currentColor underline, never the user-picked accent", async () => {
  const { tree } = await renderOutcomesScreen(0);
  const css = findNodes(tree, (n) => n.type === "style").map(collectText).join("\n");
  const link = getCssRules(css).filter(([s]) => s === ".outcome-md a").map(([, body]) => body).join(";");

  assert.equal(getDecl(link, "color"), "rgb(var(--ink))");
  assert.match(getDecl(link, "text-decoration") ?? "", /^underline\b/);
  assert.match(getDecl(link, "text-decoration-color") ?? "currentColor", /^currentColor$/);
  assert.doesNotMatch(link, /--accent/);
});

test("while the first read is in flight, the ledger and Failures by agent draw still skeleton rows under their real heads, and no region pulses", async () => {
  const { tree } = await renderOutcomesScreen(0);
  const skeletonHeads = findNodes(tree, (n) => n.type === "Table")
    .filter((table) => findNodes(table, (n) => n.type === "SkeletonRows").length > 0)
    .map((table) => findNodes(table, (n) => n.type === "th").map((th) => collectText(th).trim()).filter(Boolean).join(", "));
  const animated = findNodes(tree, (n) => (n.props.style as Record<string, unknown> | undefined)?.animation !== undefined
    || /\bskel-pulse/.test(String(n.props.className ?? "")));

  assert.deepEqual(skeletonHeads.sort(), [
    "Agent, Failure rate, Failed, Blocked, Open caveats, Total records",
    "Time, Agent, Task type, Result, Why, Summary, Actions",
  ]);
  const ledgerWidths = findNodes(tree, (n) => n.type === "Table" && n.props.caption === "Loading outcome records")
    .map((table) => Array.from(table.props.widths as unknown[], (width) => width === undefined));
  assert.deepEqual(ledgerWidths, [[false, false, false, false, false, true, false]], "the skeleton sizes every ledger column but Summary");
  assert.equal(animated.length, 0, "a skeleton is still; only the shared loading status turns");
});

describe("the Record attribution head names the missing-report level with no rate or window: faint None with no mark only over a read window with no records, faint Not loaded with its cause and no mark after a failed read or a payload without its window summary, and nothing while the first read is in flight", () => {
  const rows = [
    { name: "failed", state: { status: "error", busy: false, data: null, error: { message: SERVER_ERROR } }, kinds: ["not-loaded"], text: /Not loaded/, isRead: false, title: SERVER_ERROR },
    { name: "read, no attributed records", state: { status: "ready", busy: false, data: { days_series: [], window_summary: { literal_omission_rate: null, total_attributed: 0 } }, error: null }, kinds: [], text: /None$/, isRead: true, isBodyEmpty: true },
    { name: "read, a payload without its window summary", state: { status: "ready", busy: false, data: { days_series: [] }, error: null }, kinds: ["not-loaded"], text: /Not loaded/, isRead: false, title: "no window summary", isBodyEmpty: false },
    { name: "read, a share under the watch band", state: { status: "ready", busy: false, data: { days_series: [], window_summary: { literal_omission_rate: 0.0123, total_attributed: 81 } }, error: null }, kinds: [], text: /Missing reports\s+normal$/, isRead: true, isBodyEmpty: false },
    { name: "read, a share in the watch band", state: { status: "ready", busy: false, data: { days_series: [], window_summary: { literal_omission_rate: 0.05, total_attributed: 81 } }, error: null }, kinds: [], text: /Missing reports\s+high$/, isRead: true, isBodyEmpty: false },
    { name: "read, a share past the watch band", state: { status: "ready", busy: false, data: { days_series: [], window_summary: { literal_omission_rate: 0.2, total_attributed: 81 } }, error: null }, kinds: [], text: /Missing reports\s+critical$/, isRead: true, isBodyEmpty: false },
  ];
  const severityWord = (ui.UI as { ALERT_SEVERITY_WORD: Record<string, string> }).ALERT_SEVERITY_WORD;
  const renderCard = async (state: unknown) => {
    const mod = await loadScreenModule(OUTCOMES_SRC, { UI: ui.UI, location: { hash: "" }, URLSearchParams });
    const create = (mod.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
    return renderScreen(create(mod.AttributionHealthBlock as Component, { state, period: 30, onRetry: () => undefined, shared: {} })) as RenderedNode;
  };
  const getHeads = (tree: RenderedNode) => findNodes(tree, (n) => n.props["data-role"] === "head-status");

  test("loading: the head stays empty, leaving the loading look to the body's skeleton", async () => {
    const tree = await renderCard({ status: "loading", busy: true, data: null, error: null });
    assert.equal(getHeads(tree).length, 0);
    assert.doesNotMatch(collectText(tree), /Not loaded|None/);
  });

  test("a payload without its window summary: the body reads Not loaded with the same cause, as the head does", async () => {
    const tree = await renderCard({ status: "ready", busy: false, data: { days_series: [] }, error: null });
    const head = getBlockHead(tree);
    const bodyAbsent = findNodes(tree, (n) => n.type === "AbsentValue").filter((n) => !findNodes(head, (h) => h === n).length);
    assert.deepEqual(bodyAbsent.map((n) => n.props.kind), ["not-loaded"]);
    assert.ok(String(bodyAbsent[0]?.props.title).includes("no window summary"), "the body states the cause in its title");
  });

  for (const row of rows) {
    test(row.name, async () => {
      const tree = await renderCard(row.state);
      const isMarked = row.isRead && row.isBodyEmpty !== true;
      const heads = getHeads(tree);
      assert.equal(heads.length, isMarked ? 1 : 0, "a status mark only over a read window with records");
      const status = isMarked ? heads[0] : getBlockHead(tree);
      const absent = findNodes(status, (n) => n.type === "AbsentValue");
      assert.deepEqual(absent.map((n) => n.props.kind), isMarked ? [] : [...row.kinds, ...(row.isRead ? ["none"] : [])]);
      assert.match(collectText(status).trim(), row.text);
      assert.doesNotMatch(collectText(status), /%|days/, "no rate and no window in the head");
      assert.doesNotMatch(collectText(tree), /remaining/, "no Untraceable sentence beside its stat");
      assert.doesNotMatch(collectText(status), row.isRead ? /Not loaded/ : /None/);
      if (isMarked) {
        const tone = String(status.props["data-tone"]);
        assert.notEqual(tone, "neutral", "a read window carries its band's tone");
        assert.ok(collectText(status).trimStart().startsWith(`${severityWord[tone]}: `), "the severity word is read first");
        assert.equal(status.children.filter((child) => typeof child !== "string").length, 2, "the glyph, then the sentence as one inline element");
      }
      if (row.title) assert.ok(String(absent[0]?.props.title).includes(row.title), "the failed read's own cause is in the title");
      if (row.isBodyEmpty !== undefined) {
        const isBodyEmpty = /No attributed runs in this period/.test(collectText(tree));
        assert.equal(isBodyEmpty, row.isBodyEmpty, "the head reads None exactly when the body reads the window as empty");
      }
    });
  }
});
