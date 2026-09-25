// Element-tree behaviour tests for the Documents screen header and stage pill,
// exercised through test/lib/render-screen.ts — no DOM, no react-dom, no DB.
//
// Runner: npx tsx --test test/clauded-docs.screen-render.client.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const ROW_FOCUS_ATOMS = {
  ROW_CONTROL_PROPS: shippedUi.ROW_CONTROL_PROPS,
  getRowKeyAction: shippedUi.getRowKeyAction,
  getDisplayName: shippedUi.getDisplayName,
};

async function loadDocsScreen(react: Record<string, unknown> = createReactStub()): Promise<Record<string, unknown>> {
  return loadScreenModule(DOCS_SRC, { UI: uiStub(ROW_FOCUS_ATOMS), React: react });
}

function cssRuleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `CSS rule ${selector} must exist`);
  return match[1];
}

test("a done stage reads in the neutral tone like every other stage, on the pill and on its filter chip", async () => {
  const source = readFileSync(DOCS_SRC, "utf8");
  for (const selector of [".doc-stage-pill.is-terminal", ".doc-stage-glyph.is-terminal"]) {
    const rule = source.match(new RegExp(`${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`));
    assert.doesNotMatch(rule ? rule[1] : "", /--ok/, `${selector} carries no success tone`);
  }

  const screen = await loadDocsScreen();
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

test("the snippet line clamps at two lines", () => {
  const rule = cssRuleBody(readFileSync(DOCS_SRC, "utf8"), ".doc-snippet");
  assert.match(rule, /-webkit-line-clamp\s*:\s*2/);
  assert.match(rule, /overflow\s*:\s*hidden/);
});

test("the snippet line starts at the title's x: indented by the lead slot plus the title row gap", () => {
  const source = readFileSync(DOCS_SRC, "utf8");
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

test("below the icon-rail width the ledger drops its Tags column and lets the title column narrow", async () => {
  const source = readFileSync(DOCS_SRC, "utf8");
  const screen = await loadDocsScreen();
  const props = listCardProps(() => undefined);
  (props.rows as Array<Record<string, unknown>>)[0].format = "html";
  const tree = renderScreen((screen.DocListCardCD as Component)(props));

  const tagCells = findNodes(tree, (n) => (n.type === "th" || n.type === "td") && String(n.props.className).includes("doc-col-tags"));
  assert.equal(tagCells.length, 3, "the Tags header and both row cells carry the column class");
  const narrow = source.match(/@media \(max-width: 1199px\) \{([\s\S]*?)\n\s*\}/);
  assert.ok(narrow, "a narrow-pane rule exists");
  assert.match(narrow[1], /\.doc-col-tags\s*\{\s*display:\s*none/);
  assert.match(narrow[1], /\.doc-col-title\s*\{\s*min-width:\s*\d+px/);
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

test("a read in flight over held rows keeps them on screen, dimmed and busy, with the held count and an inline status", async () => {
  const screen = await loadDocsScreen();
  const rows = [
    { name: "a settled list is neither dimmed nor announced", busy: false, isSearchMode: false, isLoadingMore: false, status: null },
    { name: "a search in flight dims the held rows and says so", busy: true, isSearchMode: true, isLoadingMore: false, status: "Searching…" },
    { name: "a refresh in flight dims the held rows and says so", busy: true, isSearchMode: false, isLoadingMore: false, status: "Refreshing…" },
    { name: "a load-more in flight leaves the held rows undimmed", busy: true, isSearchMode: false, isLoadingMore: true, status: null },
  ];

  for (const row of rows) {
    const tree = renderListCard(screen, {
      state: { status: "ready", data: {}, error: null, busy: row.busy },
      isSearchMode: row.isSearchMode,
      isLoadingMore: row.isLoadingMore,
    });
    const tables = findNodes(tree, (n) => n.type === "table");
    assert.equal(tables.length, 1, `${row.name}: held rows stay`);
    assert.equal(tables[0].props["aria-busy"], row.status ? "true" : undefined, row.name);
    assert.match(collectText(tree), row.isSearchMode ? /2 matched/ : /2 groups/, `${row.name}: held count stays`);

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

test("a failed read shows one plain-sentence card with one Retry and never the raw HTTP answer", async () => {
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
    assert.equal(findNodes(tree, (n) => n.props.role === "alert").length, 0, `${row.name}: no red alert box`);
    assert.doesNotMatch(collectText(tree), /HTTP \d/, row.name);
    assert.equal(findNodes(tree, (n) => n.type === "table").length, row.tables, `${row.name}: held rows stay`);
  }
});

const HANGUL = /\p{Script=Hangul}/u;

describe("the ledger names the Tags column only when a row differs, and states a shared value once", () => {
  const tagCellsOf = (tree: ReturnType<typeof renderScreen>) =>
    findNodes(tree, (n) => (n.type === "th" || n.type === "td") && String(n.props.className).includes("doc-col-tags"));
  const rows = [
    { name: "every row agent-only md → no column, 'agent-only' said once", patch: [{ audience: "hidden" }, { audience: "hidden" }], cells: 0, onceText: "agent-only" },
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

test("the last stage actor under a pill is labelled as such, never a bare model id", async () => {
  const screen = await loadDocsScreen();
  const props = listCardProps(() => undefined);
  (props.rows as Array<Record<string, unknown>>)[0].last_status_model = "claude-opus-5-5[1m]";
  const actors = findNodes(renderScreen((screen.DocListCardCD as Component)(props)), (n) => n.props.className === "doc-stage-actor");
  assert.equal(actors.length, 1);
  assert.match(collectText(actors[0]), /^set by \S/);
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

test("inside a stage section the pill drops the word its section header already says, keeping its accessible name", async () => {
  const screen = await loadDocsScreen();
  const labelsIn = (tree: ReturnType<typeof renderScreen>) => findNodes(tree, (n) => n.props.className === "doc-stage-label");
  const inReview = (props: Record<string, unknown>) => {
    for (const r of props.rows as Array<Record<string, unknown>>) r.doc_status = "doc_review";
    return props;
  };
  const sectioned = renderScreen((screen.DocListCardCD as Component)(inReview(listCardProps(() => undefined))));
  const rowPills = findNodes(sectioned, (n) => n.type === "button" && n.props["aria-haspopup"] === "menu");
  assert.equal(rowPills.length, 2);
  assert.equal(labelsIn(sectioned).length, 0);
  for (const pill of rowPills) assert.match(String(pill.props["aria-label"]), /^Doc review — stage 1 of 5/);

  const searched = renderListCard(screen, { isSearchMode: true, rows: inReview(listCardProps(() => undefined)).rows });
  assert.equal(labelsIn(searched).length, 2, "search mode has no section header, so the pill names the stage");
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

test("the stage chips name their count unit, and it is the unit the caption leads with", async () => {
  const screen = await loadDocsScreen();
  const stageLabel = (tree: ReturnType<typeof renderScreen>) =>
    collectText(findNodes(tree, (n) => n.props.className === "doc-filter-label")[0]);

  const counted = renderListCard(screen, { total: 3, docTotal: 5, groupCounts: { total: 3, open: 2, done: 1 } });
  const unit = stageLabel(counted).match(/\b(groups|documents)\b/i);
  assert.ok(unit, "the stage label names what its counts count");
  assert.match(collectText(counted), new RegExp(`\\b3 ${unit[1].toLowerCase()} · 5 documents`));

  assert.doesNotMatch(stageLabel(renderListCard(screen, {})), /groups|documents/i, "no unit claimed while no count is shown");
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

test("no Documents style or class draws text on the 11px micro step below the 12px floor", () => {
  assert.doesNotMatch(readFileSync(DOCS_SRC, "utf8"), /fs-micro/);
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
