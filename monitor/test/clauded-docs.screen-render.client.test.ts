// Element-tree behaviour tests for the Documents screen header and stage pill,
// exercised through test/lib/render-screen.ts — no DOM, no react-dom, no DB.
//
// Runner: npx tsx --test test/clauded-docs.screen-render.client.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createReactStub,
  findNodes,
  loadScreenModule,
  renderScreen,
  collectText,
} from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_SRC = resolve(__dirname, "../public/src/screens/clauded-docs.jsx");

// Formatters tag their input so a test can tell which one the screen called.
const UI_SCALARS: Record<string, unknown> = {
  formatInt: (n: number) => String(n),
  formatKstDateTime: (iso: string) => `datetime(${iso})`,
  formatKstDate: (iso: string) => `date(${iso})`,
};

function uiStub(extra: Record<string, unknown> = {}): unknown {
  const scalars = { ...UI_SCALARS, ...extra };
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name in scalars
          ? scalars[name]
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

const ui = await loadScreenModule(resolve(__dirname, "../public/src/ui.jsx"));
const shippedUi = ui.UI as Record<string, unknown>;
const SHIPPED_ATOMS = {
  ROW_CONTROL_PROPS: shippedUi.ROW_CONTROL_PROPS,
  getRowKeyAction: shippedUi.getRowKeyAction,
  getDisplayName: shippedUi.getDisplayName,
  getRegionView: shippedUi.getRegionView,
  TONE_GLYPH: shippedUi.TONE_GLYPH,
  TONE_ICON: shippedUi.TONE_ICON,
};

// in-memory Storage → the screen's group-expand hydrate reads an empty store instead of failing
function createMemoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, String(value)); },
    removeItem: (key) => { items.delete(key); },
  };
}

async function loadDocsScreen(react: Record<string, unknown> = createReactStub()): Promise<Record<string, unknown>> {
  return loadScreenModule(DOCS_SRC, { UI: uiStub(SHIPPED_ATOMS), React: react, localStorage: createMemoryStorage() });
}

function getScreenCss(screen: Record<string, unknown>): string {
  const tree = renderScreen((screen.ScreenClaudedDocs as Component)({}));
  return findNodes(tree, (n) => n.type === "style").map((n) => collectText(n)).join("\n");
}

function cssRuleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `CSS rule ${selector} must exist`);
  return match[1];
}

test("a done stage reads in the neutral tone like every other stage, on the pill and on its filter chip", async () => {
  const screen = await loadDocsScreen();
  const source = getScreenCss(screen);
  for (const selector of [".doc-stage-pill.is-terminal", ".doc-stage-glyph.is-terminal"]) {
    const rule = source.match(new RegExp(`${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`));
    assert.doesNotMatch(rule ? rule[1] : "", /--ok/, `${selector} carries no success tone`);
  }

  const donePips = findNodes(renderScreen((screen.DocStagePillCD as Component)({ docStatus: "done" })),
    (n) => String(n.props.className ?? "").includes("stage-pip"));
  for (const pip of donePips) assert.doesNotMatch(String(pip.props.className), /is-terminal/, "done pips fill like any stage");

  const tree = renderScreen((screen.DocListCardCD as Component)(listCardProps(() => undefined)));
  const stageGroup = findNodes(tree, (n) => n.props.atom === "ChipGroup" && n.props.label === "Stage filter")[0];
  const doneChip = (stageGroup.props.chips as Array<Record<string, unknown>>).filter((c) => c.key === "done");
  assert.equal(doneChip.length, 1);
  assert.equal("style" in doneChip[0], false, "the shared pressed state draws the chip, never a per-stage tint");
});

test("a done pill renders its check glyph inside the terminal glyph slot and its label outside it", async () => {
  const screen = await loadDocsScreen();
  const tree = renderScreen((screen.DocStagePillCD as Component)({ docStatus: "done" }));

  const glyphSlots = findNodes(tree, (node) => node.props.className === "doc-stage-glyph is-terminal");
  assert.equal(glyphSlots.length, 1);
  const icons = findNodes(glyphSlots[0], (node) => node.props.atom === "Icon");
  assert.equal(icons.length, 1);
  assert.equal(icons[0].props.name, "check");

  const labels = findNodes(tree, (node) => node.props.className === "doc-stage-label");
  assert.equal(labels.length, 1);
  assert.equal(findNodes(glyphSlots[0], (node) => node === labels[0]).length, 0);
});

const MARK_SYNTAX = /[#*`|>[\]~]/;

test("a search snippet reads as plain words: markdown syntax and a leading title echo go, highlights stay balanced", async () => {
  const screen = await loadDocsScreen();
  const getSnippetText = screen.getSnippetTextCD as (snippet: string, title: string) => string;
  const cases = [
    { title: "Auth rollout plan", snippet: "# <mark>Auth</mark> rollout plan ## Goal | **ship** the <mark>auth</mark> gate ... `code` > quote" },
    { title: "Other", snippet: "- [link](http://x.y) **bold** <mark>term</mark> | cell" },
    { title: "Wiki compile", snippet: "Wiki <mark>compile</mark>: — nightly <mark>compile</mark> runs" },
  ];

  for (const { title, snippet } of cases) {
    const text = getSnippetText(snippet, title);
    const bare = text.replace(/<\/?mark>/g, "");
    assert.doesNotMatch(bare, MARK_SYNTAX, `syntax left in ${JSON.stringify(text)}`);
    assert.doesNotMatch(bare, /http/, "link targets are not prose");
    assert.ok(!bare.toLowerCase().startsWith(title.toLowerCase()), `title echoed in ${JSON.stringify(text)}`);
    assert.match(bare, /^[\p{L}\p{N}]/u, `must start at a word: ${JSON.stringify(text)}`);
    assert.equal((text.match(/<mark>/g) || []).length, (text.match(/<\/mark>/g) || []).length);
  }
});

test("the snippet line clamps at two lines", async () => {
  const rule = cssRuleBody(getScreenCss(await loadDocsScreen()), ".doc-snippet");
  assert.match(rule, /-webkit-line-clamp\s*:\s*2/);
  assert.match(rule, /overflow\s*:\s*hidden/);
});

test("the snippet line starts at the title's x: indented by the lead slot plus the title row gap", async () => {
  const source = getScreenCss(await loadDocsScreen());
  const px = (rule: string, property: string) => {
    const match = rule.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*(\\d+)px`));
    assert.ok(match, `${property} is set in px`);
    return Number(match[1]);
  };
  const leadWidth = px(cssRuleBody(source, ".doc-title-lead"), "width");
  const rowGap = px(cssRuleBody(source, ".title-cell .doc-title-row"), "gap");
  assert.equal(px(cssRuleBody(source, ".doc-snippet"), "margin-left"), leadWidth + rowGap);
});

test("the Tags column states the page's majority format once and prints only exceptions per row", async () => {
  const screen = await loadDocsScreen();
  const getCommonFormat = screen.getCommonFormatCD as (rows: Array<{ format: string }>) => string | null;
  const DocTagsCell = screen.DocTagsCellCD as Component;

  assert.equal(getCommonFormat([{ format: "md" }, { format: "md" }, { format: "html" }]), "md");
  assert.equal(getCommonFormat([{ format: "md" }, { format: "html" }]), null);
  assert.equal(getCommonFormat([]), null);

  const chips = (props: Record<string, unknown>) =>
    findNodes(renderScreen(DocTagsCell(props)), (n) => n.props.atom === "Badge").map((n) => collectText(n));
  assert.deepEqual(chips({ audience: "exposed", format: "md", commonFormat: "md" }), []);
  assert.deepEqual(chips({ audience: "hidden", format: "html", commonFormat: "md" }), ["agent-only", "html"]);
  assert.deepEqual(chips({ audience: "hidden", format: "md", commonFormat: "md", commonAudience: "hidden" }), []);
  assert.deepEqual(chips({ audience: "exposed", format: "md", commonFormat: null }), ["md"]);
});

function listCardProps(onSelect: (id: number) => void): Record<string, unknown> {
  const row = (id: number, extra: Record<string, unknown> = {}) => ({
    id, title: `Doc ${id}`, doc_status: "open", format: "md", audience: "exposed",
    author: "glass-atrium-intel-planner", created_at: "2026-09-01T00:00:00Z", member_count: 1, folder_id: null, ...extra,
  });
  const noop = () => undefined;
  return {
    state: { status: "ready", data: {} }, rows: [row(11, { supersedes_id: 7 }), row(12)], isSearchMode: false,
    selectedId: 12, pendingDelete: null, hiddenCount: 0, total: 2, docTotal: 2, groupCounts: null, visibleCount: 2,
    canLoadMore: false, loadMoreRemaining: 0, isLoadingMore: false, onLoadMore: noop, selectedIds: new Set(),
    onToggleSelection: noop, onSelectAll: noop, onClearSelection: noop, expandedFolderIds: new Set(), onToggleExpand: noop,
    onGroupCreate: noop, onUngroup: noop, onExportZip: noop, onReorder: noop, onPickStage: noop, togglingIds: new Set(),
    optimisticStatusOverrides: new Map(), onSelect, onRetry: noop,
    inlineFilterProps: { keyword: "", docStatusFilter: "", audienceFilter: "all", onKeywordChange: noop, onDocStatusChange: noop, onAudienceChange: noop },
  };
}

test("the ledger is a captioned table with column scopes and one Tab stop, and no row claims the button role", async () => {
  const screen = await loadDocsScreen();
  const tree = renderScreen((screen.DocListCardCD as Component)(listCardProps(() => undefined)));

  assert.equal(findNodes(tree, (n) => n.type === "caption").length, 1);
  const headCells = findNodes(findNodes(tree, (n) => n.type === "thead")[0], (n) => n.type === "th");
  assert.ok(headCells.length > 0);
  for (const th of headCells) assert.equal(th.props.scope, "col");

  const rows = findNodes(tree, (n) => n.type === "tr" && String(n.props.className).includes("doc-row"));
  assert.equal(rows.length, 2);
  for (const tr of rows) assert.notEqual(tr.props.role, "button");
  assert.deepEqual(rows.map((tr) => tr.props.tabIndex), [-1, 0], "the Tab stop sits on the selected row");
});

test("every control inside a ledger row leaves the Tab order as a row control, so the row keeps the one Tab stop", async () => {
  const screen = await loadDocsScreen();
  const props = listCardProps(() => undefined);
  (props.rows as Array<Record<string, unknown>>)[1] = { ...(props.rows as Array<Record<string, unknown>>)[1], doc_status: "doc_review", member_count: 3, folder_id: 5 };
  const tree = renderScreen((screen.DocListCardCD as Component)(props));

  const rows = findNodes(tree, (n) => n.type === "tr" && String(n.props.className).includes("doc-row"));
  const controls = rows.flatMap((tr) => findNodes(tr, (n) => n.type === "button" || n.type === "input"));
  const names = controls.map((n) => String(n.props["aria-label"] ?? n.props.className));
  assert.ok(names.some((name) => name.includes("doc-lineage")), "the lineage link is among the controls");
  assert.ok(names.some((name) => name.startsWith("Expand group")), "the group toggle is among the controls");
  assert.ok(names.some((name) => name.includes("change stage")), "the stage pill is among the controls");
  for (const control of controls) {
    assert.equal(control.props.tabIndex, -1, `${String(control.props["aria-label"] ?? control.props.className)} leaves the Tab order`);
    assert.equal(control.props["data-row-control"], "", "it is reachable by arrows from its row");
  }
});

// the shipped verdict, not the atom stub → the rendered words are what a reader sees
async function renderVerdictText(state: Record<string, unknown>): Promise<string> {
  const screen = await loadScreenModule(DOCS_SRC, {
    UI: uiStub({ ...SHIPPED_ATOMS, PageVerdict: shippedUi.PageVerdict }),
    React: createReactStub(),
  });
  const props = listCardProps(() => undefined);
  const createdAt = new Date().toISOString();
  props.rows = (props.rows as Array<Record<string, unknown>>).map((row) => ({ ...row, doc_status: "doc_review", created_at: createdAt }));
  const tree = renderScreen((screen.DocListCardCD as Component)({ ...props, asOf: createdAt, state }));
  const verdicts = findNodes(tree, (n) => String(n.props.className).includes("page-verdict "));
  assert.equal(verdicts.length, 1, "the open list states one verdict");
  return collectText(verdicts[0]);
}

test("a failed refresh over held rows turns the open verdict to Last known, and only the failure does", async () => {
  const settled = await renderVerdictText({ status: "ready", data: {}, busy: false, error: null });
  const warmError = await renderVerdictText({ status: "ready", data: {}, busy: false, error: "HTTP 500" });

  assert.doesNotMatch(settled, /Last known/, "a settled read keeps its own verdict");
  assert.match(warmError, /Last known/, "held rows under a failed read never read as the all-clear");
  assert.doesNotMatch(warmError, /Healthy/);
});

test("a cold list error keeps its alert and shows no loader while its Retry is in flight", async () => {
  const screen = await loadDocsScreen();
  const state = { status: "loading", data: null, busy: true, error: "HTTP 500" };
  const tree = renderScreen((screen.DocListCardCD as Component)({ ...listCardProps(() => undefined), state }));

  assert.equal(findNodes(tree, (n) => n.props.atom === "LoadingPlaceholder").length, 0);
  const alerts = findNodes(tree, (n) => n.props.atom === "RegionUnavailable");
  assert.equal(alerts.length, 1, "the focused Retry stays mounted");
  assert.equal(alerts[0].props.isBusy, true, "the Retry reads busy while the read is in flight");
});

type FakeNode = { name: string; closest: (s: string) => FakeNode | null; querySelectorAll: (s: string) => FakeNode[]; focus: () => void };

function fakeLedger(focused: string[]) {
  const make = (name: string): FakeNode => ({ name, closest: () => null, querySelectorAll: () => [], focus: () => focused.push(name) });
  const rows = ["row-0", "row-1"].map((rowName) => {
    const row = make(rowName);
    const controls = ["checkbox", "stage"].map((c) => make(`${rowName}/${c}`));
    const menuItem = make(`${rowName}/menu-item`);
    for (const node of [row, ...controls, menuItem]) node.closest = () => row;
    row.querySelectorAll = () => controls;
    return { row, controls, menuItem };
  });
  const tbody = { querySelectorAll: () => rows.map((r) => r.row) };
  return { rows, tbody };
}

describe("ledger keys walk rows and a row's controls, never leaving the ledger for a background control", () => {
  const cases = [
    { name: "ArrowRight on a row enters its first control", key: "ArrowRight", at: (l: Ledger) => l.rows[0].row, lands: "row-0/checkbox" },
    { name: "ArrowRight on a control moves to the next control", key: "ArrowRight", at: (l: Ledger) => l.rows[0].controls[0], lands: "row-0/stage" },
    { name: "ArrowLeft on the first control returns to its row", key: "ArrowLeft", at: (l: Ledger) => l.rows[1].controls[0], lands: "row-1" },
    { name: "Escape on a control returns to its row", key: "Escape", at: (l: Ledger) => l.rows[1].controls[1], lands: "row-1" },
    { name: "ArrowDown on a row moves to the next row", key: "ArrowDown", at: (l: Ledger) => l.rows[0].row, lands: "row-1" },
    { name: "a key inside the stage menu stays with the menu", key: "ArrowDown", at: (l: Ledger) => l.rows[0].menuItem, lands: null },
  ];
  type Ledger = ReturnType<typeof fakeLedger>;
  for (const row of cases) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const focused: string[] = [];
      const ledger = fakeLedger(focused);
      let isPrevented = false;
      (screen.moveRowFocusCD as (e: unknown) => void)({
        key: row.key, target: row.at(ledger), currentTarget: ledger.tbody, preventDefault: () => { isPrevented = true; },
      });
      assert.deepEqual(focused, row.lands ? [row.lands] : []);
      assert.equal(isPrevented, row.lands !== null);
    });
  }
});

test("the opened viewer settles focus on Close after the dialog's own first-control focus, never leaving it on Delete", async () => {
  const effects: Array<() => void> = [];
  const react = { ...createReactStub(), useEffect: (fn: () => void) => { effects.push(fn); } };
  const screen = await loadDocsScreen(react);
  const tree = renderScreen((screen.ViewerActionsCD as Component)({
    doc: { id: 9, title: "Doc 9" }, pendingDelete: null, onDelete: () => undefined, onClose: () => undefined, showToast: () => undefined,
  }));
  const close = findNodes(tree, (n) => n.props["aria-label"] === "Close viewer")[0];
  const focused: string[] = [];
  (close.props.ref as { current: unknown }).current = { focus: () => focused.push("close") };

  for (const effect of effects) effect();
  focused.push("dialog-first-control");
  await new Promise((settle) => setImmediate(settle));

  assert.deepEqual(focused, ["dialog-first-control", "close"]);
});

// the width at which Tags hides is owned by the e2e rail table → this pins only the column hook it hides by
test("the Tags header and every row's Tags cell carry the doc-col-tags column class", async () => {
  const screen = await loadDocsScreen();
  const props = listCardProps(() => undefined);
  (props.rows as Array<Record<string, unknown>>)[0].format = "html";
  const tree = renderScreen((screen.DocListCardCD as Component)(props));

  const tagCells = findNodes(tree, (n) => (n.type === "th" || n.type === "td") && String(n.props.className).includes("doc-col-tags"));
  assert.equal(tagCells.length, 3, "the Tags header and both row cells carry the column class");
});

test("'rev of #N' is a control that opens the predecessor", async () => {
  const screen = await loadDocsScreen();
  const opened: number[] = [];
  const tree = renderScreen((screen.DocListCardCD as Component)(listCardProps((id) => opened.push(id))));

  const lineage = findNodes(tree, (n) => String(n.props.className).includes("doc-lineage"));
  assert.equal(lineage.length, 1);
  assert.equal(lineage[0].type, "button");
  (lineage[0].props.onClick as (e: unknown) => void)({ stopPropagation: () => undefined });
  assert.deepEqual(opened, [7]);
});

function renderListCard(screen: Record<string, unknown>, overrides: Record<string, unknown>) {
  const props = { ...listCardProps(() => undefined), ...overrides };
  return renderScreen((screen.DocListCardCD as Component)(props));
}

test("a read in flight over held rows keeps them on screen, dimmed and busy, with the held count; only a search names itself inline", async () => {
  const screen = await loadDocsScreen();
  const rows = [
    { name: "a settled list is neither dimmed nor announced", busy: false, isSearchMode: false, isLoadingMore: false, isDimmed: false, status: null },
    { name: "a search in flight dims the held rows and says so", busy: true, isSearchMode: true, isLoadingMore: false, isDimmed: true, status: "Searching…" },
    { name: "a refresh in flight dims the held rows and leaves the one Refreshing… to the header button", busy: true, isSearchMode: false, isLoadingMore: false, isDimmed: true, status: null },
    { name: "a load-more in flight leaves the held rows undimmed", busy: true, isSearchMode: false, isLoadingMore: true, isDimmed: false, status: null },
  ];

  for (const row of rows) {
    const tree = renderListCard(screen, {
      state: { status: "ready", data: {}, error: null, busy: row.busy },
      isSearchMode: row.isSearchMode,
      isLoadingMore: row.isLoadingMore,
    });
    const tables = findNodes(tree, (n) => n.type === "table");
    assert.equal(tables.length, 1, `${row.name}: held rows stay`);
    assert.equal(tables[0].props["aria-busy"], row.isDimmed ? "true" : undefined, row.name);
    assert.doesNotMatch(collectText(tree), /Refreshing/, `${row.name}: the ledger never repeats the header's busy word`);
    assert.match(collectText(tree), row.isSearchMode ? /2 matched/ : /2 documents/, `${row.name}: held count stays`);

    const inline = findNodes(tree, (n) => n.props.role === "status" && String(n.props.className).includes("doc-list-busy"));
    assert.deepEqual(inline.map((n) => collectText(n)), row.status ? [row.status] : [], row.name);
  }
});

test("a first read with nothing held shows one status placeholder instead of rows", async () => {
  const screen = await loadDocsScreen();
  const tree = renderListCard(screen, { state: { status: "loading", data: null, error: null, busy: true }, rows: [] });

  assert.equal(findNodes(tree, (n) => n.props.atom === "LoadingPlaceholder").length, 1);
  assert.equal(findNodes(tree, (n) => n.type === "table").length, 0);
});

test("a failed read announces one plain-sentence card with one Retry as an alert and never the raw HTTP answer", async () => {
  const screen = await loadDocsScreen();
  const error = 'HTTP 500 Internal Server Error — {"error":"boom"}';
  const rows = [
    { name: "nothing held", state: { status: "error", data: null, error, busy: false }, rows: [], tables: 0 },
    { name: "rows held", state: { status: "ready", data: {}, error, busy: false }, rows: undefined, tables: 1 },
  ];

  for (const row of rows) {
    const overrides: Record<string, unknown> = { state: row.state };
    if (row.rows) overrides.rows = row.rows;
    const tree = renderListCard(screen, overrides);

    const cards = findNodes(tree, (n) => n.props.atom === "RegionUnavailable");
    assert.equal(cards.length, 1, row.name);
    assert.equal(cards[0].props.error, error, row.name);
    assert.equal(typeof cards[0].props.onRetry, "function", row.name);
    const alerts = findNodes(tree, (n) => n.props.role === "alert");
    assert.equal(alerts.length, 1, `${row.name}: one announced failure`);
    assert.equal(findNodes(alerts[0], (n) => n === cards[0]).length, 1, `${row.name}: the alert is the failure card`);
    assert.doesNotMatch(collectText(tree), /HTTP \d/, row.name);
    assert.equal(findNodes(tree, (n) => n.type === "table").length, row.tables, `${row.name}: held rows stay`);
  }
});

test("a list error hands its Retry focus to the list card, so a successful Retry never drops focus to the page body", async () => {
  const screen = await loadDocsScreen();
  const rows = [
    { name: "nothing held", state: { status: "error", data: null, error: "HTTP 500", busy: false }, rows: [] },
    { name: "rows held", state: { status: "ready", data: {}, error: "HTTP 500", busy: false }, rows: undefined },
  ];

  for (const row of rows) {
    const overrides: Record<string, unknown> = { state: row.state };
    if (row.rows) overrides.rows = row.rows;
    const tree = renderListCard(screen, overrides);

    const [card] = findNodes(tree, (n) => n.props.atom === "RegionUnavailable");
    const targetId = card.props.focusTargetId;
    assert.equal(typeof targetId, "string", `${row.name}: Retry names a focus target`);
    const targets = findNodes(tree, (n) => n.props.id === targetId);
    assert.equal(targets.length, 1, `${row.name}: the target id is on the page`);
    assert.match(String(targets[0].props.className), /\bcard\b/, `${row.name}: the target is the list card`);
    assert.equal(findNodes(targets[0], (n) => n === card).length, 1, `${row.name}: the card holds the failed Retry`);
  }
});

test("each stage group opens with a level-2 heading under the page H1, and the ledger holds no other heading", async () => {
  const screen = await loadDocsScreen();
  const props = listCardProps(() => undefined);
  const rows = props.rows as Array<Record<string, unknown>>;
  rows[0] = { ...rows[0], doc_status: "doc_review" };
  rows[1] = { ...rows[1], doc_status: "implementing" };
  const tree = renderScreen((screen.DocListCardCD as Component)(props));
  const [ledger] = findNodes(tree, (n) => n.type === "table");

  const headings = findNodes(ledger, (n) => n.props.role === "heading" || /^h[1-6]$/.test(String(n.type)));
  assert.deepEqual(headings.map((n) => collectText(n)), ["Doc review", "Implementing"]);
  for (const heading of headings) assert.equal(heading.props["aria-level"], 2, "one level below the page H1");
});

const HANGUL = /\p{Script=Hangul}/u;

describe("the ledger names the Tags column only when a row differs, and states a shared value once", () => {
  const tagCellsOf = (tree: ReturnType<typeof renderScreen>) =>
    findNodes(tree, (n) => (n.type === "th" || n.type === "td") && String(n.props.className).includes("doc-col-tags"));
  const rows = [
    { name: "every row agent-only md → no column, the audience said once in words", patch: [{ audience: "hidden" }, { audience: "hidden" }], cells: 0, onceText: "agent records" },
    { name: "one row in another format → the column stays", patch: [{ format: "html" }, {}], cells: 3, onceText: null },
    { name: "one agent-only row among public rows → the column stays", patch: [{ audience: "hidden" }, {}], cells: 3, onceText: null },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const props = listCardProps(() => undefined);
      (props.rows as Array<Record<string, unknown>>).forEach((r, i) => Object.assign(r, row.patch[i]));
      const tree = renderScreen((screen.DocListCardCD as Component)(props));

      assert.equal(tagCellsOf(tree).length, row.cells);
      assert.equal(findNodes(tree, (n) => n.props.className === "doc-th-note").length, 0, "no two-line header note");
      if (row.onceText) assert.equal(collectText(tree).split(row.onceText).length - 1, 1);
    });
  }
});

test("the last stage actor reads one display name for a model id with or without its context-window tag", async () => {
  const screen = await loadDocsScreen();
  const actorText = (model: string) => {
    const props = listCardProps(() => undefined);
    (props.rows as Array<Record<string, unknown>>)[0].last_status_model = model;
    const tree = renderScreen((screen.DocListCardCD as Component)(props));
    const actorCells = findNodes(tree, (n) => n.type === "td" && typeof n.props.title === "string" && n.props.title.startsWith("Set by"));
    assert.equal(actorCells.length, 1, model);
    return actorCells[0].props.title;
  };

  assert.equal(actorText("claude-opus-5-5[1m]"), actorText("claude-opus-5-5"));
  assert.equal(actorText("claude-opus-5-5"), "Set by Opus 5.5");
});

test("the filter chips and the stage names speak the English of the rest of the screen", async () => {
  const screen = await loadDocsScreen();
  const tree = renderScreen((screen.DocListCardCD as Component)(listCardProps(() => undefined)));
  const chipGroups = findNodes(tree, (n) => n.props.atom === "ChipGroup");
  assert.equal(chipGroups.length, 2);
  for (const group of chipGroups) {
    for (const chip of group.props.chips as Array<{ label: unknown }>) assert.doesNotMatch(collectText(renderScreen(chip.label)), HANGUL);
  }
  assert.doesNotMatch(collectText(tree), HANGUL);
  for (const stage of ["doc_review", "implementing", "impl_review", "impl_done", "done"]) {
    const pill = renderScreen((screen.DocStagePillCD as Component)({ docStatus: stage }));
    assert.doesNotMatch(collectText(pill), HANGUL, stage);
  }
});

test("every row pill names its stage in words, inside a stage section as in search", async () => {
  const screen = await loadDocsScreen();
  const labelsIn = (tree: ReturnType<typeof renderScreen>) => findNodes(tree, (n) => n.props.className === "doc-stage-label");
  const inReview = (props: Record<string, unknown>) => {
    for (const r of props.rows as Array<Record<string, unknown>>) r.doc_status = "doc_review";
    return props;
  };
  const sectioned = renderScreen((screen.DocListCardCD as Component)(inReview(listCardProps(() => undefined))));
  const rowPills = findNodes(sectioned, (n) => n.type === "button" && n.props["aria-haspopup"] === "menu");
  assert.equal(rowPills.length, 2);
  assert.deepEqual(labelsIn(sectioned).map((n) => collectText(n)), ["Doc review", "Doc review"], "no pill is a bare row of dots");
  for (const pill of rowPills) assert.match(String(pill.props["aria-label"]), /^Doc review — stage 1 of 5/);

  const searched = renderListCard(screen, { isSearchMode: true, rows: inReview(listCardProps(() => undefined)).rows });
  assert.equal(labelsIn(searched).length, 2);
});

test("a pill that changes the stage shows a menu caret, and a read-only pill does not", async () => {
  const screen = await loadDocsScreen();
  const carets = (props: Record<string, unknown>) =>
    findNodes(renderScreen((screen.DocStagePillCD as Component)(props)), (n) => n.props.atom === "Icon" && n.props.name === "chevron-down").length;
  assert.equal(carets({ docStatus: "implementing", onPickStage: () => undefined }), 1);
  assert.equal(carets({ docStatus: "implementing" }), 0);
});

test("Delete leaves the viewer's icon bar and sits apart in the metadata rail as a labelled button", async () => {
  const screen = await loadDocsScreen();
  const bar = renderScreen((screen.ViewerActionsCD as Component)({
    doc: { id: 9, title: "Doc 9" }, onClose: () => undefined, showToast: () => undefined,
  }));
  assert.equal(findNodes(bar, (n) => /delete/i.test(String(n.props["aria-label"] ?? ""))).length, 0);

  const deleted: number[] = [];
  const rail = renderScreen((screen.DocMetaPanelCD as Component)({
    doc: { id: 9, title: "Doc 9", doc_status: "open", format: "md" }, pendingDelete: null, onDelete: (id: number) => deleted.push(id),
    togglingIds: new Set(), optimisticStatusOverrides: new Map(),
  }));
  const buttons = findNodes(rail, (n) => n.type === "button" && /Delete/.test(collectText(n)));
  assert.equal(buttons.length, 1);
  (buttons[0].props.onClick as () => void)();
  assert.deepEqual(deleted, [9]);
});

type Chip = { key: string; label: unknown; isPressed: boolean };

test("stage and audience filters are two separately labelled pressed-chip groups, one chip pressed in each, with no radio role", async () => {
  const screen = await loadDocsScreen();
  const picked: string[] = [];
  const props = listCardProps(() => undefined);
  (props.inlineFilterProps as Record<string, unknown>).onDocStatusChange = (value: string) => picked.push(value);
  const tree = renderScreen((screen.DocListCardCD as Component)(props));

  const groups = findNodes(tree, (n) => n.props.atom === "ChipGroup");
  assert.deepEqual(groups.map((g) => g.props.label), ["Stage filter", "Audience filter"]);
  assert.deepEqual(groups.map((g) => Array.from((g.props.chips as Chip[]).filter((c) => c.isPressed), (c) => c.key)), [[""], ["all"]]);
  assert.equal(findNodes(tree, (n) => n.props.role === "radio" || n.props.role === "radiogroup").length, 0);
  assert.equal(findNodes(tree, (n) => n.props.className === "doc-filter-label").length, 2, "each group carries its own visible label");

  (groups[0].props.onToggle as (key: string) => void)("done");
  assert.deepEqual(picked, ["done"]);
});

test("the filter label reads Show, and the caption counts documents, naming revisions as their own unit", async () => {
  const screen = await loadDocsScreen();
  const filterLabel = (tree: ReturnType<typeof renderScreen>) =>
    collectText(findNodes(tree, (n) => n.props.className === "doc-filter-label")[0]);

  const counted = renderListCard(screen, { total: 3, docTotal: 5, groupCounts: { total: 3, open: 2, done: 1 } });
  assert.equal(filterLabel(counted), "Show");
  assert.match(collectText(counted), /\b3 documents · 5 with revisions\b/);
  assert.doesNotMatch(collectText(counted), /\bgroups\b/, "no internal grouping unit in the caption");

  assert.equal(filterLabel(renderListCard(screen, {})), "Show");
});

describe("a stage pill draws the shared stage pip, filled up to its stage", () => {
  const rows = [
    { name: "doc review fills one of five", stage: "doc_review", filled: 1 },
    { name: "implementing fills two of five", stage: "implementing", filled: 2 },
    { name: "done fills all five", stage: "done", filled: 5 },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const pips = findNodes(renderScreen((screen.DocStagePillCD as Component)({ docStatus: row.stage })),
        (n) => String(n.props.className ?? "").split(" ").includes("stage-pip"));
      assert.equal(pips.length, 5);
      assert.equal(pips.filter((n) => String(n.props.className).includes("is-filled")).length, row.filled);
    });
  }
});

test("the Documents style block and the rendered list card's size classes and inline sizes stay at or above the 13px meta floor", async () => {
  const META_FLOOR_PX = 13;
  const screen = await loadDocsScreen();
  const listCard = renderScreen((screen.DocListCardCD as Component)(listCardProps(() => undefined)));
  const classNames = findNodes(listCard, (n) => typeof n.props.className === "string").map((n) => String(n.props.className));
  const inlineSizes = findNodes(listCard, (n) => typeof (n.props.style as { fontSize?: unknown } | undefined)?.fontSize === "number")
    .map((n) => (n.props.style as { fontSize: number }).fontSize);
  assert.doesNotMatch([getScreenCss(screen), ...classNames].join("\n"), /fs-micro/);

  // the rendered style block, the rendered card's arbitrary text-[Npx] classes and its inline fontSize numbers
  const sizes = [
    ...[...getScreenCss(screen).matchAll(/font-size\s*:\s*([\d.]+)px/g)].map((m) => ({ at: m[0], px: Number(m[1]) })),
    ...classNames.flatMap((name) => [...name.matchAll(/text-\[([\d.]+)px\]/g)].map((m) => ({ at: m[0], px: Number(m[1]) }))),
    ...inlineSizes.map((px) => ({ at: `fontSize: ${px}`, px })),
  ];
  assert.deepEqual(sizes.filter((size) => size.px < META_FLOOR_PX).map((size) => size.at), []);
});

test("a markdown body never nests an h1 under the viewer's h2 title", async () => {
  const screen = await loadDocsScreen();
  const html = (screen.injectMdTypographyClassesCD as (h: string) => string)("<h1>Part</h1><h2>Sub</h2>");
  assert.doesNotMatch(html, /<\/?h1\b/);
  assert.equal(html.match(/<h2\b/g)?.length, 2);
  assert.ok(html.indexOf("Part") < html.indexOf("Sub"));
});

describe("a leading markdown heading that repeats the viewer title is dropped, any other heading stays", () => {
  const rows = [
    { name: "an h1 equal to the title goes", md: "# Plan A\n\nBody", kept: false },
    { name: "the match ignores case and edge spaces", md: "#  plan a  \nBody", kept: false },
    { name: "an h1 with other words stays", md: "# Plan A notes\nBody", kept: true },
    { name: "an h2 equal to the title stays", md: "## Plan A\nBody", kept: true },
    { name: "a title heading after prose stays", md: "Intro\n# Plan A\n", kept: true },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const out = (screen.dropTitleHeadingCD as (md: string, title: string) => string)(row.md, "Plan A");
      assert.equal(out === row.md, row.kept);
      if (!row.kept) assert.match(out, /^Body/);
    });
  }
});

test("the viewer rail leaves out Last action when no actor was recorded, and names it when one was", async () => {
  const screen = await loadDocsScreen();
  const railText = (extra: Record<string, unknown>) => collectText(renderScreen((screen.DocMetaPanelCD as Component)({
    doc: { id: 9, title: "Doc 9", doc_status: "open", format: "md", ...extra }, pendingDelete: null, onDelete: () => undefined,
    togglingIds: new Set(), optimisticStatusOverrides: new Map(),
  })));
  const unrecorded = railText({});
  assert.doesNotMatch(unrecorded, /Last action/i);
  assert.doesNotMatch(unrecorded, /\bunknown\b/i);
  assert.match(railText({ last_status_model: "claude-opus-5-5" }), /Last action/i);
});

describe("search hits collapse to one row per revision chain: its newest hit, at the chain's best rank, counting the rest", () => {
  const rows = [
    {
      name: "three revisions of one chain and a lone document",
      hits: [{ id: 5, chain_root_id: 1 }, { id: 9, chain_root_id: 9 }, { id: 1, chain_root_id: 1 }, { id: 3, chain_root_id: 1 }],
      expected: [{ id: 5, revision_count: 2 }, { id: 9, revision_count: 0 }],
    },
    {
      name: "a chain whose newest revision ranks below an older one keeps the older one's place",
      hits: [{ id: 2, chain_root_id: 2 }, { id: 8, chain_root_id: 8 }, { id: 4, chain_root_id: 2 }],
      expected: [{ id: 4, revision_count: 1 }, { id: 8, revision_count: 0 }],
    },
    {
      name: "hits from a server that names no chain root stay one row each",
      hits: [{ id: 2 }, { id: 1 }],
      expected: [{ id: 2, revision_count: 0 }, { id: 1, revision_count: 0 }],
    },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const collapsed = (screen.getCollapsedSearchRowsCD as (r: unknown[]) => Array<{ id: number; revision_count: number }>)(row.hits);
      assert.deepEqual(Array.from(collapsed, ({ id, revision_count }) => ({ id, revision_count })), row.expected);
    });
  }
});

describe("the search caption counts collapsed documents, and names the server's hit total as its own unit", () => {
  const rows = [
    {
      name: "a 9-revision chain beside a hidden lone document reads 1 of 2 shown, never 1 of 10",
      visibleCount: 1, hiddenCount: 1, total: 10, expected: "1 of 2 shown · 10 hits",
    },
    {
      name: "collapsed revisions with nothing hidden read the document count, then the hits",
      visibleCount: 2, hiddenCount: 0, total: 5, expected: "2 matched · 5 hits",
    },
    {
      name: "hits that collapse into nothing need no second unit",
      visibleCount: 2, hiddenCount: 0, total: 2, expected: "2 matched",
    },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const tree = renderListCard(screen, {
        isSearchMode: true, docTotal: null, visibleCount: row.visibleCount, hiddenCount: row.hiddenCount, total: row.total,
      });
      const captions = findNodes(tree, (n) => n.props["aria-live"] === "polite");
      assert.deepEqual(captions.map((n) => collectText(n)), [row.expected]);
    });
  }
});

test("a collapsed search row says how many older revisions it stands for", async () => {
  const screen = await loadDocsScreen();
  const base = listCardProps(() => undefined);
  const [first, second] = base.rows as Array<Record<string, unknown>>;
  const tree = renderListCard(screen, { isSearchMode: true, rows: [{ ...first, revision_count: 2 }, { ...second, revision_count: 0 }] });

  const marks = findNodes(tree, (n) => String(n.props.className ?? "").includes("doc-revision-count"));
  assert.deepEqual(marks.map((n) => collectText(n)), ["+2 revisions"]);
});

test("while searching, the stage filter visibly steps aside for all stages, and the empty state does not claim it", async () => {
  const screen = await loadDocsScreen();
  const props = listCardProps(() => undefined);
  const filters = { ...(props.inlineFilterProps as Record<string, unknown>), keyword: "plan", docStatusFilter: "open" };
  const searching = renderListCard(screen, { isSearchMode: true, inlineFilterProps: filters });

  const groups = findNodes(searching, (n) => n.props.atom === "ChipGroup");
  assert.deepEqual(groups.map((g) => g.props.label), ["Audience filter"], "no stage chip reads as pressed while it is not applied");
  assert.match(collectText(searching), /All stages while searching/);

  const empty = renderScreen((screen.DocEmptyStateCD as Component)({ isSearchMode: true, inlineFilterProps: filters }));
  assert.doesNotMatch(collectText(empty), /status:/);
  assert.match(collectText(empty), /“plan”/);
});

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
// the screen runs in its own vm realm → compare its objects by value
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
type DocAge = { days: number; label: string; bucket: string; isStale: boolean };
type OpenSummary = {
  stages: Array<{ value: string; label: string; count: number }>;
  buckets: Record<string, number>;
  oldest: { id: number; days: number } | null;
  openCount: number;
};

describe("a document's age reads relative to now, buckets it, and past seven days marks it stale", () => {
  const rows = [
    { name: "created today → under 3 days, not stale", days: 0, label: "today", bucket: "fresh", isStale: false },
    { name: "2 days → under 3 days", days: 2, label: "2d", bucket: "fresh", isStale: false },
    { name: "3 days → 3-7 days", days: 3, label: "3d", bucket: "aging", isStale: false },
    { name: "7 days → still 3-7 days, not stale", days: 7, label: "7d", bucket: "aging", isStale: false },
    { name: "8 days → over 7 days and stale", days: 8, label: "8d", bucket: "stale", isStale: true },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const age = (screen.getDocAgeCD as (iso: string, nowMs: number) => DocAge)(daysAgo(row.days), Date.now());
      assert.deepEqual(plain(age), { days: row.days, label: row.label, bucket: row.bucket, isStale: row.isStale });
    });
  }
});

function pipelineRows() {
  const base = { format: "md", audience: "exposed", author: "a", member_count: 1, folder_id: null };
  return [
    { ...base, id: 11, title: "Doc 11", doc_status: "doc_review", created_at: daysAgo(15) },
    { ...base, id: 12, title: "Doc 12", doc_status: "doc_review", created_at: daysAgo(1) },
    { ...base, id: 13, title: "Doc 13", doc_status: "implementing", created_at: daysAgo(4) },
    { ...base, id: 14, title: "Doc 14", doc_status: "done", created_at: daysAgo(40) },
  ];
}

test("the open summary counts only open documents: stage counts and age buckets each add up to the open total", async () => {
  const screen = await loadDocsScreen();
  const summary = (screen.getOpenSummaryCD as (rows: unknown[], nowMs: number) => OpenSummary)(pipelineRows(), Date.now());

  assert.equal(summary.openCount, 3, "the done document is not open");
  assert.deepEqual(plain(summary.stages.map((s) => [s.label, s.count])), [["Doc review", 2], ["Implementing", 1]]);
  assert.equal(summary.stages.reduce((sum, s) => sum + s.count, 0), summary.openCount);
  assert.deepEqual(plain(summary.buckets), { fresh: 1, aging: 1, stale: 1 });
  assert.deepEqual(plain(summary.oldest), { id: 11, days: 15 }, "the oldest open document, never the older done one");
  assert.equal((screen.getOpenHeadlineCD as (s: OpenSummary) => string)(summary),
    "2 awaiting doc review · 1 implementing · oldest open 15 days (#11)");
});

describe("the sectioned list leads with a headline verdict and an open summary; search and a single-stage filter do not", () => {
  const rows = [
    { name: "open filter → headline and summary", filter: "open", isSearchMode: false, shown: true },
    { name: "all filter, every row loaded → headline and summary over the open rows", filter: "", isSearchMode: false, shown: true },
    { name: "done filter → neither, nothing there is open", filter: "done", isSearchMode: false, shown: false },
    { name: "search → neither, hits are not the pipeline", filter: "open", isSearchMode: true, shown: false },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const props = listCardProps(() => undefined);
      props.rows = pipelineRows();
      props.isSearchMode = row.isSearchMode;
      (props.inlineFilterProps as Record<string, unknown>).docStatusFilter = row.filter;
      const tree = renderScreen((screen.DocListCardCD as Component)(props));

      const verdicts = findNodes(tree, (n) => n.props.atom === "PageVerdict");
      assert.equal(verdicts.length, row.shown ? 1 : 0);
      assert.equal(findNodes(tree, (n) => String(n.props.className ?? "").split(" ").includes("doc-open-summary")).length, row.shown ? 1 : 0);
      if (row.shown) {
        assert.equal(verdicts[0].props.tone, "warn", "an open document past seven days needs attention");
        assert.match(collectText(verdicts[0]), /2 awaiting doc review · 1 implementing · oldest open 15 days \(#11\)/);
      }
    });
  }
});

describe("with more pages to load, the headline says it covers the loaded rows and names the open total the chip shows", () => {
  const rows = [
    { name: "all filter, open total known → loaded share of the open total", filter: "", groupCounts: { open: 20, done: 576, total: 596 }, lead: /^Loaded rows only — 3 of 20 open: / },
    { name: "open filter, open total known → loaded share of the open total", filter: "open", groupCounts: { open: 20, done: 576, total: 596 }, lead: /^Loaded rows only — 3 of 20 open: / },
    { name: "open total unknown → loaded-rows note without a total", filter: "", groupCounts: null, lead: /^Loaded rows only: / },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const props = listCardProps(() => undefined);
      props.rows = pipelineRows();
      props.canLoadMore = true;
      props.groupCounts = row.groupCounts;
      (props.inlineFilterProps as Record<string, unknown>).docStatusFilter = row.filter;
      const tree = renderScreen((screen.DocListCardCD as Component)(props));

      const text = collectText(findNodes(tree, (n) => n.props.atom === "PageVerdict")[0]);
      assert.match(text, row.lead);
      assert.match(text, /2 awaiting doc review · 1 implementing · oldest open 15 days \(#11\)$/);
    });
  }
});

test("the ledger table scrolls inside its own column, so the open-summary rail beside it never covers a column", async () => {
  const screen = await loadDocsScreen();
  const props = listCardProps(() => undefined);
  props.rows = pipelineRows();
  const tree = renderScreen((screen.DocListCardCD as Component)(props));

  const tableColumn = findNodes(tree, (n) => n.type === "div" && findNodes(n, (c) => c.type === "table").length > 0
    && String(n.props.className ?? "").split(" ").includes("flex-1"));
  assert.equal(tableColumn.length, 1);
  const classes = String(tableColumn[0].props.className).split(" ");
  assert.ok(classes.includes("min-w-0") && classes.includes("overflow-x-auto"), `table column classes: ${classes.join(" ")}`);
});

test("the summary's oldest-open link opens that document", async () => {
  const screen = await loadDocsScreen();
  const opened: number[] = [];
  const props = listCardProps((id) => opened.push(id));
  props.rows = pipelineRows();
  const tree = renderScreen((screen.DocListCardCD as Component)(props));

  const links = findNodes(tree, (n) => n.type === "button" && String(n.props.className ?? "").includes("doc-open-oldest"));
  assert.equal(links.length, 1);
  assert.match(collectText(links[0]), /#11/);
  (links[0].props.onClick as () => void)();
  assert.deepEqual(opened, [11]);
});

test("Created shows relative age with the date in a tooltip, and only an open row past seven days is marked stale with a glyph and a text label", async () => {
  const screen = await loadDocsScreen();
  const props = listCardProps(() => undefined);
  props.rows = pipelineRows();
  (props.inlineFilterProps as Record<string, unknown>).docStatusFilter = "";
  const tree = renderScreen((screen.DocListCardCD as Component)(props));

  const docRows = findNodes(tree, (n) => n.type === "tr" && String(n.props.className).includes("doc-row"));
  const stale = docRows.filter((tr) => String(tr.props.className).includes("is-stale")).map((tr) => tr.props["aria-label"]);
  assert.deepEqual(stale, ["Doc 11"], "the 40-day done row is not stale");

  const ageCells = findNodes(tree, (n) => n.type === "td" && String(n.props.className ?? "").includes("doc-age-cell"));
  assert.equal(ageCells.length, 4);
  const staleCell = ageCells.find((td) => /15d/.test(collectText(td)));
  assert.ok(staleCell, "age is the primary value");
  assert.match(String(staleCell.props.title), /^Created date\(/);
  assert.match(collectText(staleCell), /stale/i, "stale is said in words, not colour alone");
  assert.equal(findNodes(staleCell, (n) => n.props.atom === "Icon" && n.props.className === "text-warn").length, 1, "the warn tone rides a glyph");
  assert.equal(ageCells.filter((td) => /stale/i.test(collectText(td))).length, 1);
});

test("the Status column keeps room for the stage name inside stage sections as in a flat list", async () => {
  const screen = await loadDocsScreen();
  const statusWidth = (overrides: Record<string, unknown>) => {
    const tree = renderListCard(screen, overrides);
    const th = findNodes(tree, (n) => n.type === "th" && collectText(n) === "Status")[0];
    return (th.props.style as { width: number }).width;
  };
  const sectioned = statusWidth({});
  const flat = statusWidth({ isSearchMode: true });
  assert.equal(sectioned, flat);
});

describe("the header speaks about loading only after a first read; before it the list placeholder is the one loading label", () => {
  const rows = [
    { name: "a first read in flight shows no stamp and no busy Refresh", asOf: null, busy: true, hasStamp: false, isBusy: false },
    { name: "a refresh over a held read shows the stamp and a busy Refresh", asOf: "2026-09-30T00:00:00Z", busy: true, hasStamp: true, isBusy: true },
    { name: "a settled read shows the stamp and an idle Refresh", asOf: "2026-09-30T00:00:00Z", busy: false, hasStamp: true, isBusy: false },
  ];

  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const listState = { status: row.asOf ? "ready" : "loading", data: null, error: null, busy: row.busy };
      const tree = renderScreen((screen.DocHeaderActionsCD as Component)({ asOf: row.asOf, listState, onRefresh: () => undefined }));

      assert.equal(findNodes(tree, (n) => n.props.atom === "FreshnessStamp").length, row.hasStamp ? 1 : 0);
      const buttons = findNodes(tree, (n) => n.props.atom === "RefreshButton");
      assert.equal(buttons.length, 1, "Refresh stays reachable");
      assert.equal(buttons[0].props.isBusy, row.isBusy);
    });
  }
});

test("'rev of #N' trails the title as a pill that never wraps or shrinks, so the ID cell holds the id alone", async () => {
  const screen = await loadDocsScreen();
  const tree = renderListCard(screen, {});
  const [revisionRow] = findNodes(tree, (n) => n.type === "tr" && n.props["aria-label"] === "Doc 11");

  const [titleMain] = findNodes(revisionRow, (n) => n.props.className === "doc-title-main");
  const lineage = findNodes(titleMain, (n) => String(n.props.className ?? "").includes("doc-lineage"));
  assert.equal(lineage.length, 1);
  assert.match(collectText(lineage[0]), /^rev of #\s*7$/);
  assert.match(String(lineage[0].props.className), /\bpill\b/);
  assert.match(cssRuleBody(getScreenCss(screen), ".doc-lineage"), /flex\s*:\s*none/);

  const idCell = findNodes(revisionRow, (n) => n.type === "td" && String(n.props.className).includes("doc-meta-text-mono"))[0];
  assert.match(collectText(idCell), /^#\s*11$/);

  // a six-digit id in 13px mono (0.6em a glyph) plus the cell padding fits the ID column
  const idHeader = findNodes(tree, (n) => n.type === "th" && collectText(n) === "ID")[0];
  const width = (idHeader.props.style as { width: number }).width;
  assert.ok(width >= 28 + 13 * 0.6 * "#123456".length, `ID column ${width}px`);
});

test("the last stage actor rides the Status cell's tooltip, never a line under the pill", async () => {
  const screen = await loadDocsScreen();
  const base = listCardProps(() => undefined);
  const [first, second] = base.rows as Array<Record<string, unknown>>;
  const tree = renderListCard(screen, { rows: [{ ...first, last_status_model: "operator" }, second] });

  assert.equal(findNodes(tree, (n) => String(n.props.className ?? "").includes("doc-stage-actor")).length, 0);
  const statusCells = findNodes(tree, (n) => n.type === "td" && findNodes(n, (c) => c.type === "DocStagePillCD").length > 0);
  assert.deepEqual(statusCells.map((td) => td.props.title), ["Set by operator", undefined]);
});

test("the Title header starts at the title text's x: indented by the lead slot plus the title row gap", async () => {
  const screen = await loadDocsScreen();
  const source = getScreenCss(screen);
  const px = (rule: string, property: string) => Number(rule.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*(\\d+)px`))?.[1]);
  const indent = px(cssRuleBody(source, ".doc-title-lead"), "width") + px(cssRuleBody(source, ".title-cell .doc-title-row"), "gap");

  const titleHeader = findNodes(renderListCard(screen, {}), (n) => n.type === "th" && collectText(n) === "Title")[0];
  const label = findNodes(titleHeader, (n) => n.type === "span" && n.props.className === "doc-col-title-text");
  assert.equal(label.length, 1);
  assert.equal(px(cssRuleBody(source, ".doc-col-title-text"), "margin-left"), indent);
});

function renderPipelineCard(screen: Record<string, unknown>, state: Record<string, unknown>) {
  const props = listCardProps(() => undefined);
  props.rows = pipelineRows();
  return renderScreen((screen.DocListCardCD as Component)({ ...props, asOf: "2026-09-30T00:00:00Z", state }));
}

const SETTLED_LIST = { status: "ready", data: {}, error: null, busy: false };
const WARM_ERROR_LIST = { status: "ready", data: {}, error: "HTTP 500", busy: false };

test("the open-summary rail titles each group with a level-2 heading and pairs every label with its own count", async () => {
  const screen = await loadDocsScreen();
  const [rail] = findNodes(renderPipelineCard(screen, SETTLED_LIST), (n) => n.type === "aside");

  assert.deepEqual(findNodes(rail, (n) => n.type === "h2").map((n) => collectText(n)), ["Open by stage", "Age"]);
  for (const list of findNodes(rail, (n) => n.type === "dl")) {
    const cells = findNodes(list, (n) => n.type === "dt" || n.type === "dd").map((n) => n.type);
    assert.equal(cells.length % 2, 0, "every label has a count");
    cells.forEach((type, i) => assert.equal(type, i % 2 === 0 ? "dt" : "dd", `cell ${i} alternates label then count`));
  }
  const ageTerms = findNodes(rail, (n) => n.type === "dt").map((n) => collectText(n).trim());
  assert.ok(ageTerms.includes("Over 7 days"), `age labels stand alone: ${ageTerms.join(" | ")}`);
});

test("a warm list error marks the rail counts Last known, and a settled read does not", async () => {
  const screen = await loadDocsScreen();
  const railText = (state: Record<string, unknown>) =>
    collectText(findNodes(renderPipelineCard(screen, state), (n) => n.type === "aside")[0]);

  assert.doesNotMatch(railText(SETTLED_LIST), /Last known/);
  assert.match(railText(WARM_ERROR_LIST), /Last known/);
});

describe("the header hands its read state to the shell exactly once, with or without a first read", () => {
  const rows = [
    { name: "a failed first read reaches the shell directly", asOf: null, state: { status: "error", data: null, error: "HTTP 500", busy: false }, direct: 1 },
    { name: "a first read in flight reaches the shell directly", asOf: null, state: { status: "loading", data: null, error: null, busy: true }, direct: 1 },
    { name: "after a read the stamp reaches the shell, so the page does not", asOf: "2026-09-30T00:00:00Z", state: SETTLED_LIST, direct: 0 },
  ];

  for (const row of rows) {
    test(row.name, async () => {
      const calls: unknown[] = [];
      const screen = await loadScreenModule(DOCS_SRC, {
        UI: uiStub({ ...SHIPPED_ATOMS, useShellPageState: (input: unknown) => calls.push(input) }),
        React: createReactStub(),
      });
      const tree = renderScreen((screen.DocHeaderActionsCD as Component)({ asOf: row.asOf, listState: row.state, onRefresh: () => undefined }));

      const stamps = findNodes(tree, (n) => n.props.atom === "FreshnessStamp").length;
      assert.equal(calls.length + stamps, 1, "one shell caller");
      assert.equal(calls.length, row.direct);
      if (row.direct) assert.deepEqual(plain(calls[0]), { at: null, regions: [row.state] });
    });
  }
});

const noop = () => undefined;
const isDarkScope = (n: RenderedNode) => n.props["data-theme"] === "dark";
const hasClass = (name: string) => (n: RenderedNode) => String(n.props.className ?? "").split(/\s+/).includes(name);
const isAtom = (atom: string) => (n: RenderedNode) => n.props.atom === atom;
type RenderedNode = ReturnType<typeof findNodes>[number];

function isInDarkScope(tree: ReturnType<typeof renderScreen>, predicate: (n: RenderedNode) => boolean): boolean {
  return findNodes(tree, isDarkScope).some((scope) => findNodes(scope, predicate).length > 0);
}

function viewerDoc(extra: Record<string, unknown> = {}) {
  return { id: 9, title: "Doc 9", format: "txt", body: "probe", doc_status: "open", supersedes_id: null, superseded_by_id: null, ...extra };
}

function renderViewerPanel(screen: Record<string, unknown>, state: Record<string, unknown>) {
  return renderScreen((screen.ViewerPanelCD as Component)({
    state, pendingDelete: null, onDelete: noop, onClose: noop, onPickStage: noop, togglingIds: new Set(),
    optimisticStatusOverrides: new Map(), onNavigate: noop, showToast: noop,
  }));
}

test("the viewer chrome resolves the dark theme in either app theme, and the rendered document never takes that scope", async () => {
  const screen = await loadDocsScreen();
  const tree = renderViewerPanel(screen, { status: "ready", data: viewerDoc({ superseded_by_id: 10 }) });

  assert.ok(isInDarkScope(tree, isAtom("CardHead")), "the viewer head");
  assert.ok(isInDarkScope(tree, isAtom("AlertCard")), "the newer-version notice");
  assert.ok(isInDarkScope(tree, (n) => n.type === "aside" && n.props["aria-label"] === "Document metadata"), "the metadata rail");
  assert.equal(findNodes(tree, hasClass("doc-body-isolation")).length, 1);
  assert.equal(isInDarkScope(tree, hasClass("doc-body-isolation")), false, "the rendered document keeps its own canvas");
});

describe("a viewer with no rendered document shows its state inside the dark chrome scope", () => {
  const rows = [
    { name: "idle", state: { status: "idle" }, shown: hasClass("doc-empty") },
    { name: "loading", state: { status: "loading" }, shown: isAtom("LoadingPlaceholder") },
    { name: "failed read", state: { status: "error", error: "HTTP 500" }, shown: isAtom("RegionUnavailable") },
    { name: "body that cannot render", state: { status: "ready", data: viewerDoc({ format: "md", body: "# x" }) }, shown: isAtom("AlertCard") },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const tree = renderViewerPanel(screen, row.state);
      assert.ok(isInDarkScope(tree, row.shown), `${row.name}: state shown in the dark scope`);
    });
  }
});

test("a newer revision announces itself as one inset warn alert card whose action opens the latest revision", async () => {
  const screen = await loadDocsScreen();
  const opened: unknown[] = [];
  const tree = renderScreen((screen.ViewerPanelCD as Component)({
    state: { status: "ready", data: viewerDoc({ superseded_by_id: 10 }) }, pendingDelete: null, onDelete: noop, onClose: noop,
    onPickStage: noop, togglingIds: new Set(), optimisticStatusOverrides: new Map(), onNavigate: (id: unknown) => opened.push(id), showToast: noop,
  }));

  const cards = findNodes(tree, isAtom("AlertCard"));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].props.tone, "warn");
  assert.equal(cards[0].props.surface, "inset");
  const action = renderScreen(cards[0].props.actions);
  const [button] = findNodes(action, (n) => n.type === "button");
  assert.match(collectText(button), /View latest/);
  (button.props.onClick as () => void)();
  assert.deepEqual(opened, [10]);
});

test("an error banner speaks through the shared crit alert card, keeping its detail and its Retry", async () => {
  const screen = await loadDocsScreen();
  const retried: number[] = [];
  const tree = renderScreen((screen.ErrorBannerCD as Component)({ title: "Couldn't load", detail: "HTTP 500", onRetry: () => retried.push(1) }));

  const [card] = findNodes(tree, isAtom("AlertCard"));
  assert.ok(card, "one alert card");
  assert.equal(card.props.tone, "crit");
  assert.equal(card.props.title, "Couldn't load");
  assert.equal(card.props.body, "HTTP 500");
  const [retry] = findNodes(renderScreen(card.props.actions), (n) => n.type === "button");
  (retry.props.onClick as () => void)();
  assert.deepEqual(retried, [1]);
});

test("a toast keeps a neutral shell with its tone class on the root, and its tone rides a leading glyph", async () => {
  const screen = await loadDocsScreen();
  const glyphs = shippedUi.TONE_GLYPH as Record<string, string>;
  for (const tone of ["ok", "info", "warn", "crit"]) {
    const tree = renderScreen((screen.DocToastCD as Component)({ toast: { tone, message: "Grouped 3" } }));
    const [root] = findNodes(tree, hasClass("doc-toast"));
    assert.ok(hasClass(tone)(root), `${tone}: tone class on the root`);
    const [glyph] = findNodes(root, hasClass("doc-toast-glyph"));
    assert.equal(glyph.props["aria-hidden"], "true");
    assert.equal(collectText(glyph), glyphs[tone]);
    assert.match(collectText(root), /Grouped 3/);
  }
});

// stub state: the first object-shaped state with a status reads as the given one; null-initialised state reads as `nullAs`
function stubbedStateReact(statusState: Record<string, unknown>, nullAs: unknown = null) {
  return {
    ...createReactStub(),
    useState: (initial: unknown) => {
      const value = typeof initial === "function" ? (initial as () => unknown)() : initial;
      if (value && typeof value === "object" && "status" in value) return [statusState, noop];
      return [value === null ? nullAs : value, noop];
    },
  };
}

// member rows come back as a bare array of rows → hosted in a tbody like the ledger does
function inTbody(rows: unknown) {
  return { __element: true, type: "tbody", props: { children: [rows] } };
}

const TONED_WORDS = /(?:^|[;{\s])(?:color|background(?:-color)?)\s*:\s*rgb\(var\(--(?:crit|warn|ok|info)\)/;

test("no rule in the Documents style block paints words or a row fill in a severity tone", async () => {
  const css = getScreenCss(await loadDocsScreen());
  const toned = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => TONED_WORDS.test(m[2])).map((m) => m[1].trim());
  assert.deepEqual(toned, []);
});

describe("a tone in the Documents screen rides a leading glyph while its words stay neutral", () => {
  const member = { id: 21, title: "Member", doc_status: "open", format: "md", audience: "exposed", author: "a", created_at: "2026-09-01T00:00:00Z" };
  const memberProps = {
    folderId: 5, representativeId: 21, memberCount: 2, onReorder: noop, isSearchMode: false, hasTagsColumn: false,
    selectedId: null, selectedIds: new Set(), pendingDelete: null, onSelect: noop, onToggleSelection: noop, onPickStage: noop,
    togglingIds: new Set(), optimisticStatusOverrides: new Map(),
  };
  const rows = [
    {
      name: "a failed member load", tone: "crit", text: /Couldn't load group members/,
      render: (s: Record<string, unknown>) => inTbody((s.GroupMembersRowsCD as Component)(memberProps)),
      react: () => stubbedStateReact({ status: "error", data: null, error: "HTTP 500" }),
    },
    {
      name: "a reorder that did not save", tone: "crit", text: /Order not saved/,
      render: (s: Record<string, unknown>) => inTbody((s.GroupMembersRowsCD as Component)(memberProps)),
      react: () => stubbedStateReact({ status: "ready", data: [member, { ...member, id: 22 }], error: null }, "Order not saved — reverted"),
    },
    {
      name: "a previous revision that failed to load", tone: "warn", text: /Couldn't load previous revision/,
      render: (s: Record<string, unknown>) => (s.PredecessorPanelCD as Component)({ predecessorId: 7, currentDoc: viewerDoc(), onNavigate: noop }),
      react: () => stubbedStateReact({ status: "error", data: null, error: "HTTP 404" }),
    },
    {
      name: "the stale age bucket in the open summary", tone: "warn", text: /Over 7 days/,
      render: (s: Record<string, unknown>) => (s.DocOpenSummaryCD as Component)({
        summary: { stages: [], buckets: { fresh: 0, aging: 0, stale: 2 }, oldest: null, openCount: 2 }, isPartial: false, onSelect: noop,
      }),
      react: () => createReactStub(),
    },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen(row.react());
      const tree = renderScreen(row.render(screen));
      assert.match(collectText(tree), row.text);
      const glyphs = findNodes(tree, (n) => n.props.atom === "Icon" && n.props.className === `text-${row.tone}`);
      assert.equal(glyphs.length, 1, `${row.name}: one ${row.tone} glyph`);
      const tonedInline = findNodes(tree, (n) => /--(?:crit|warn|ok|info)\)/.test(String((n.props.style as { color?: unknown } | undefined)?.color ?? "")));
      assert.deepEqual(tonedInline.map((n) => collectText(n)), [], `${row.name}: no word painted in a tone`);
    });
  }
});

test("the version history names the current revision in ink, never in a severity tone", async () => {
  const screen = await loadDocsScreen();
  const tree = renderScreen((screen.PredecessorPanelCD as Component)({ predecessorId: 7, currentDoc: viewerDoc(), onNavigate: noop }));
  const [label] = findNodes(tree, (n) => n.type === "span" && collectText(n).trim() === "Current revision");
  assert.equal((label.props.style as { color: string }).color, "rgb(var(--ink))");
});

test("the viewer row and a pending delete each carry a non-colour cue: the open row is current, a pending row is busy behind a crit glyph", async () => {
  const screen = await loadDocsScreen();
  const tree = renderListCard(screen, { selectedId: 12, pendingDelete: { id: 11, expiresAt: Date.now() + 5000 } });
  const docRows = findNodes(tree, (n) => n.type === "tr" && hasClass("doc-row")(n));
  const byLabel = (label: string) => docRows.find((tr) => tr.props["aria-label"] === label) as RenderedNode;

  assert.equal(byLabel("Doc 12").props["aria-current"], "true");
  assert.equal(byLabel("Doc 11").props["aria-busy"], "true");
  assert.equal(byLabel("Doc 12").props["aria-busy"], undefined);
  assert.equal(findNodes(byLabel("Doc 11"), (n) => n.props.atom === "Icon" && n.props.className === "text-crit").length, 1);
  assert.equal(findNodes(byLabel("Doc 12"), (n) => n.props.atom === "Icon" && n.props.className === "text-crit").length, 0);
});

test("the Documents style block draws shadows only from the shadow tokens, a 1px ring or none", async () => {
  const css = getScreenCss(await loadDocsScreen());
  const shadows = [...css.matchAll(/box-shadow\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
  const allowed = (value: string) => value === "none" || /^var\(--shadow-[\w-]+\)$/.test(value) || /^inset 0 0 0 1px /.test(value);
  assert.deepEqual(shadows.filter((value) => !allowed(value)), []);
  assert.match(cssRuleBody(css, ".doc-stage-menu"), /border-radius\s*:\s*var\(--radius-card\)/);
});

test("the stage menu floats on the opaque overlay surface, ringed by the line token under the overlay shadow", async () => {
  const menu = cssRuleBody(getScreenCss(await loadDocsScreen()), ".doc-stage-menu");
  assert.match(menu, /background\s*:\s*rgb\(var\(--overlay-surface\)\)/);
  assert.match(menu, /border\s*:\s*1px solid rgb\(var\(--line\)\)/);
  assert.match(menu, /box-shadow\s*:\s*var\(--shadow-overlay\)/);
});

test("a ledger checkbox draws on theme tokens: neutral at rest, the one selected state when checked or mixed, and no transition", async () => {
  const screen = await loadDocsScreen();
  const css = getScreenCss(screen);
  for (const props of [{ checked: false }, { checked: true }, { checked: false, indeterminate: true }]) {
    const tree = renderScreen((screen.DocCheckboxCD as Component)({ ...props, onChange: noop, ariaLabel: "Select" }));
    const [input] = findNodes(tree, (n) => n.type === "input");
    const classes = String(input.props.className);
    assert.ok(hasClass("doc-checkbox")(input), "token-drawn class");
    assert.doesNotMatch(classes, /zinc-|emerald-|transition|duration-/);
    const marks = findNodes(tree, (n) => n.props.atom === "Icon");
    assert.equal(marks.length, props.checked || props.indeterminate ? 1 : 0);
    for (const mark of marks) assert.ok(String(mark.props.className).includes("doc-checkbox-mark"));
  }
  assert.match(cssRuleBody(css, ".doc-checkbox"), /background\s*:\s*rgb\(var\(--elev\)\)/);
  assert.match(cssRuleBody(css, ".doc-checkbox"), /border\s*:\s*1\.5px solid rgb\(var\(--faint\)\)/);
  assert.match(cssRuleBody(css, ".doc-checkbox:checked, .doc-checkbox:indeterminate"), /background\s*:\s*rgb\(var\(--selected-fill\)\)/);
  assert.match(cssRuleBody(css, ".doc-checkbox-mark"), /color\s*:\s*rgb\(var\(--selected-ink\)\)/);
});

function getReduceBlocks(css: string): { inside: string; outside: string } {
  const opener = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  let inside = "";
  let outside = "";
  let cursor = 0;
  for (let match = opener.exec(css); match; match = opener.exec(css)) {
    outside += css.slice(cursor, match.index);
    let depth = 1;
    let index = match.index + match[0].length;
    for (; depth > 0 && index < css.length; index++) depth += css[index] === "{" ? 1 : css[index] === "}" ? -1 : 0;
    inside += css.slice(match.index + match[0].length, index - 1);
    cursor = index;
    opener.lastIndex = index;
  }
  return { inside, outside: outside + css.slice(cursor) };
}

test("every transition and animation in the Documents style block stops under reduced motion, and a disclosure chevron turns instantly", async () => {
  const css = getScreenCss(await loadDocsScreen()).replace(/\/\*[\s\S]*?\*\//g, "");
  const { inside, outside } = getReduceBlocks(css);
  const rules = (source: string) => [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: m[1].split(",").map((s) => s.trim()), body: m[2] }));
  const moving = rules(outside).filter((r) => /(?:^|[;\s])(?:transition|animation)\s*:\s*(?!none)/.test(r.body)).flatMap((r) => r.selectors);
  const stopped = new Set(rules(inside).filter((r) => /(?:transition|animation)\s*:\s*none/.test(r.body)).flatMap((r) => r.selectors));
  assert.ok(moving.length > 0);
  assert.deepEqual(moving.filter((selector) => !stopped.has(selector)), []);
  assert.doesNotMatch(css, /\.chevron\s*\{[^}]*transition/);
});

test("a loading previous revision shows the shared loading placeholder, never an inline animated block", async () => {
  const screen = await loadDocsScreen();
  const tree = renderScreen((screen.PredecessorPanelCD as Component)({ predecessorId: 7, currentDoc: viewerDoc(), onNavigate: noop }));
  assert.equal(findNodes(tree, isAtom("LoadingPlaceholder")).length, 1);
  assert.deepEqual(findNodes(tree, (n) => (n.props.style as { animation?: unknown } | undefined)?.animation != null), []);
});
