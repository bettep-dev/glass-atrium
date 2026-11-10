// Element-tree behaviour tests for the Documents screen header and stage status,
// exercised through test/lib/render-screen.ts — no DOM, no react-dom, no DB.
//
// Runner: npx tsx --test test/clauded-docs.screen-render.client.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createReactStub,
  findNodes,
  loadScreenModule,
  renderScreen,
  collectText,
} from "./lib/render-screen.js";
import { getRoleKeys, type RoleSection } from "./lib/role-keys.js";

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
  Card: shippedUi.Card,
  Table: shippedUi.Table,
  TableRow: shippedUi.TableRow,
  TableCell: shippedUi.TableCell,
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

// a ledger header's floor rule, found by the header's position → the rule the browser applies to it
function headerFloorRule(screen: Record<string, unknown>, tree: ReturnType<typeof renderScreen>, label: string): string {
  const headers = findNodes(tree, (n) => n.type === "th" && n.props.scope === "col");
  const position = headers.findIndex((th) => collectText(th) === label) + 1;
  assert.ok(position > 0, `${label} header present`);
  return cssRuleBody(getScreenCss(screen), `.doc-ledger:not(.tbl--stacked) thead th:nth-child(${position})`);
}

function cssRuleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `CSS rule ${selector} must exist`);
  return match[1];
}

// a rule moved onto utilities has no body → nothing it could set
function cssRuleBodyIfAny(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

test("a done stage reads in the neutral tone like every other stage, on its status glyph and on its filter chip", async () => {
  const screen = await loadDocsScreen();
  assert.doesNotMatch(cssRuleBodyIfAny(getScreenCss(screen), ".doc-stage-glyph"), /--ok/, "the stage glyph carries no success tone");
  for (const docStatus of ["done", "implementing"]) {
    const glyph = findNodes(renderScreen((screen.DocStageCD as Component)({ docStatus })), (n) => n.props.atom === "Icon")[0];
    assert.doesNotMatch(String(glyph.props.className), /\btext-(?!dim\b)[a-z]+/, `${docStatus} glyph takes no per-stage tone class`);
  }

  const tree = renderScreen((screen.DocListCardCD as Component)(listCardProps(() => undefined)));
  const showTrigger = findNodes(tree, (n) => n.props.atom === "FilterTrigger" && n.props.axis === "Show")[0];
  const doneOption = (showTrigger.props.options as Array<Record<string, unknown>>).filter((o) => o.key === "done");
  assert.equal(doneOption.length, 1);
  assert.equal("style" in doneOption[0], false, "the menu check marks the chosen stage, never a per-stage tint");
});

describe("a stage status is a glyph and its stage word inline, with no container", () => {
  const rows = [
    { name: "the terminal stage takes a check", docStatus: "done", glyph: "check", word: "Done", rank: "stage 5 of 5" },
    { name: "a non-terminal stage takes an open circle", docStatus: "implementing", glyph: "circle", word: "Implementing", rank: "stage 2 of 5" },
    { name: "the retired in-flight token reads as the first stage", docStatus: "progress", glyph: "circle", word: "Doc review", rank: "stage 1 of 5" },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const tree = renderScreen((screen.DocStageCD as Component)({ docStatus: row.docStatus, docTitle: "Plan" }));
      const icons = findNodes(tree, (n) => n.props.atom === "Icon");
      assert.deepEqual(icons.map((n) => n.props.name), [row.glyph]);
      assert.deepEqual(findNodes(tree, (n) => n.props.className === "doc-stage-label").map((n) => collectText(n)), [row.word]);
      assert.match(collectText(tree), new RegExp(`—\\s+${row.rank}\\s*$`), "the rank reaches assistive tech, not the face");
      assert.equal(findNodes(tree, (n) => /\bpill\b|stage-pip/.test(String(n.props.className ?? ""))).length, 0, "no pill shell, no pip meter");
    });
  }
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

// the title x comes from the title row's own lead slot + gap → a line reusing that row shares it, no indent sum to drift
test("the snippet line starts at the title's x: it follows an empty lead slot in a title row and sets no indent of its own", async () => {
  const screen = await loadDocsScreen();
  const row = { id: 31, title: "Auth rollout plan", snippet: "the <mark>auth</mark> gate ships", doc_status: "open", format: "md",
    audience: "exposed", author: "glass-atrium-intel-planner", created_at: "2026-09-01T00:00:00Z" };
  const has = (n: RenderedNode, name: string) => String(n.props?.className ?? "").split(/\s+/).includes(name);
  const tree = renderListCard(screen, { isSearchMode: true, rows: [row] });
  const [line] = findNodes(tree, (n) => has(n, "doc-title-row") && findNodes(n, (c) => has(c, "doc-snippet")).length > 0);

  assert.ok(line, "the snippet sits in a title row");
  const parts = findNodes(line, (n) => has(n, "doc-title-lead") || has(n, "doc-snippet"));
  assert.deepEqual(parts.map((n) => (has(n, "doc-title-lead") ? "lead" : "snippet")), ["lead", "snippet"]);
  assert.equal(collectText(parts[0]), "", "the snippet's lead slot is empty");
  assert.doesNotMatch(cssRuleBody(getScreenCss(screen), ".doc-snippet"), /(^|[;\s])margin(-left|-inline)?\s*:/);
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

// stacked rows prefix a meta cell with its column label → a Tags cell with no exception chip prints no bare "Tags"
test("a stacked Tags cell prints its column label only when it carries a chip", async () => {
  const screen = await loadDocsScreen();
  const DocTagsCell = screen.DocTagsCellCD as Component;
  const view = { isStacked: true, columnCount: 7 };
  const labelsOf = (props: Record<string, unknown>) =>
    findNodes(renderScreen(DocTagsCell({ view, ...props })), (n) => String(n.props.className).includes("tbl-cell-label")).map((n) => collectText(n));

  const rows = [
    { name: "no exception → no label", props: { audience: "exposed", format: "md", commonFormat: "md" }, labels: [] },
    { name: "format exception → labelled", props: { audience: "exposed", format: "html", commonFormat: "md" }, labels: ["Tags"] },
    { name: "audience exception → labelled", props: { audience: "hidden", format: "md", commonFormat: "md" }, labels: ["Tags"] },
  ];
  for (const row of rows) assert.deepEqual(labelsOf(row.props), row.labels, row.name);
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
  const stageMenus = rows.flatMap((tr) => findNodes(tr, (n) => n.props.atom === "RowActions"));
  assert.ok(stageMenus.length > 0, "a stage menu is among the row controls");
  for (const menu of stageMenus) assert.equal(menu.props.isRowControl, true, `${String(menu.props.label)} leaves the Tab order`);
  for (const control of controls) {
    assert.equal(control.props.tabIndex, -1, `${String(control.props["aria-label"] ?? control.props.className)} leaves the Tab order`);
    assert.equal(control.props["data-row-control"], "", "it is reachable by arrows from its row");
  }
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

// the viewer is a DetailSurface → it opens on its panel like every other; its actions bar moves focus nowhere
test("mounting the viewer's actions bar focuses none of its controls, so the opened viewer stays on its panel", async () => {
  const effects: Array<() => void> = [];
  const react = { ...createReactStub(), useEffect: (fn: () => void) => { effects.push(fn); } };
  const screen = await loadDocsScreen(react);
  const tree = renderScreen((screen.ViewerActionsCD as Component)({
    doc: { id: 9, title: "Doc 9" }, onClose: () => undefined, showToast: () => undefined,
  }));
  const focused: string[] = [];
  const refHolders = findNodes(tree, (n) => n.props.ref != null);
  for (const node of refHolders) {
    (node.props.ref as { current: unknown }).current = { focus: () => focused.push(String(node.props["aria-label"])) };
  }

  for (const effect of effects) effect();
  await new Promise((settle) => setImmediate(settle));

  assert.deepEqual(focused, []);
});

// the width at which Tags hides is owned by the e2e ledger-columns table → this pins only the hooks it hides by
test("the Tags header and every row's Tags cell are what the narrow-ledger rule hides", async () => {
  const screen = await loadDocsScreen();
  const props = listCardProps(() => undefined);
  (props.rows as Array<Record<string, unknown>>)[0].format = "html";
  const tree = renderScreen((screen.DocListCardCD as Component)(props));

  const tagCells = findNodes(tree, (n) => n.type === "td" && String(n.props.className).includes("doc-col-tags"));
  assert.equal(tagCells.length, 2, "both row cells carry the column class");
  const [ledger] = findNodes(tree, (n) => n.type === "table");
  assert.match(String(ledger.props.className), /\bdoc-ledger--tags\b/);
  const headers = findNodes(tree, (n) => n.type === "th" && n.props.scope === "col");
  const position = headers.findIndex((th) => collectText(th) === "Tags") + 1;
  const hideRule = getScreenCss(screen).match(/@container doc-ledger \([^)]*\) \{ ([^{]*) \{ display: none; \} \}/);
  assert.ok(hideRule, "one container rule hides the Tags column");
  assert.deepEqual(hideRule[1].split(", "), [".doc-col-tags", `.doc-ledger--tags thead th:nth-child(${position})`]);
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

test("every cell of a ledger row renders through the shared cell atom", async () => {
  const screen = await loadDocsScreen();
  const tree = renderListCard(screen, { state: { status: "ready", data: {}, error: null, busy: false } });
  const rowCells = findNodes(tree, (n) => n.type === "tr" && String(n.props.className).split(" ").includes("doc-row"))
    .flatMap((row) => findNodes(row, (n) => n.type === "td"));

  assert.ok(rowCells.length > 0, "the ledger renders its rows");
  assert.deepEqual(
    rowCells.filter((cell) => !String(cell.props.className).split(" ").includes("tbl-cell")).map((cell) => cell.props.className),
    [],
    "a raw cell bypasses the atom's cell classes",
  );
});

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
    const [body] = findNodes(tables[0], (n) => n.type === "tbody");
    assert.equal(body.props["aria-busy"], row.isDimmed ? "true" : undefined, row.name);
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
    assert.equal(findNodes(targets[0], (n) => /(^|\s)card(\s|$)/.test(String(n.props.className ?? ""))).length, 1, `${row.name}: the target wraps the list card`);
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
  assert.deepEqual(headings.map((n) => collectText(n)), ["Doc review 1", "Implementing 1"], "stage name, then its section count");
  for (const heading of headings) assert.equal(heading.props["aria-level"], 2, "one level below the page H1");
});

const HANGUL = /\p{Script=Hangul}/u;

describe("the ledger names the Tags column only when a row differs, and states a shared value once", () => {
  const tagCellsOf = (tree: ReturnType<typeof renderScreen>) =>
    [...findNodes(tree, (n) => n.type === "th" && collectText(n) === "Tags"),
      ...findNodes(tree, (n) => n.type === "td" && String(n.props.className).includes("doc-col-tags"))];
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

test("the filter menus and the stage names speak the English of the rest of the screen", async () => {
  const screen = await loadDocsScreen();
  const tree = renderScreen((screen.DocListCardCD as Component)(listCardProps(() => undefined)));
  const triggers = findTriggers(tree);
  assert.equal(triggers.length, 2);
  for (const trigger of triggers) {
    for (const option of trigger.props.options as Array<{ label: unknown }>) assert.doesNotMatch(collectText(renderScreen(option.label as never)), HANGUL);
  }
  assert.doesNotMatch(collectText(tree), HANGUL);
  for (const stage of ["doc_review", "implementing", "impl_review", "impl_done", "done"]) {
    const status = renderScreen((screen.DocStageCD as Component)({ docStatus: stage }));
    assert.doesNotMatch(collectText(status), HANGUL, stage);
  }
});

test("every row status names its stage in words, inside a stage section as in search", async () => {
  const screen = await loadDocsScreen();
  const labelsIn = (tree: ReturnType<typeof renderScreen>) => findNodes(tree, (n) => n.props.className === "doc-stage-label");
  const inReview = (props: Record<string, unknown>) => {
    for (const r of props.rows as Array<Record<string, unknown>>) r.doc_status = "doc_review";
    return props;
  };
  const sectioned = renderScreen((screen.DocListCardCD as Component)(inReview(listCardProps(() => undefined))));
  const rowMenus = findNodes(sectioned, (n) => n.props.atom === "RowActions");
  assert.deepEqual(labelsIn(sectioned).map((n) => collectText(n)), ["Doc review", "Doc review"], "no status is a bare glyph");
  const titles = (listCardProps(() => undefined).rows as Array<{ title: string }>).map((row) => `Change stage of ${row.title}`);
  assert.deepEqual(rowMenus.map((n) => n.props.label), titles, "each stage menu names its own row");

  const searched = renderListCard(screen, { isSearchMode: true, rows: inReview(listCardProps(() => undefined)).rows });
  assert.equal(labelsIn(searched).length, 2);
});

describe("a status that can change its stage offers every other stage on its row menu", () => {
  const stageMenu = async (props: Record<string, unknown>) => {
    const screen = await loadDocsScreen();
    return findNodes(renderScreen((screen.DocStageCD as Component)({ docStatus: "implementing", docTitle: "Plan", ...props })), (n) => n.props.atom === "RowActions")[0];
  };
  test("the menu lists the four other stages as moves, never the current one", async () => {
    const menu = await stageMenu({ onPickStage: noop });
    assert.equal(menu.props.label, "Change stage of Plan");
    assert.deepEqual(Array.from(menu.props.items as Array<{ key: string; label: string }>, (item) => [item.key, item.label]),
      [["doc_review", "Move to Doc review"], ["impl_review", "Move to Impl review"], ["impl_done", "Move to Impl done"], ["done", "Move to Done"]]);
  });
  const picks = [
    { name: "a pick sends the chosen stage", isChanging: false, sent: ["done"] },
    { name: "a pick while a change is in flight sends nothing", isChanging: true, sent: [] },
  ];
  for (const row of picks) {
    test(row.name, async () => {
      const sent: string[] = [];
      const menu = await stageMenu({ onPickStage: (stage: string) => sent.push(stage), isChanging: row.isChanging });
      (menu.props.onPick as (key: string) => void)("done");
      assert.deepEqual(sent, row.sent);
    });
  }
  test("a status with no stage handler has no menu", async () => {
    assert.equal(await stageMenu({}), undefined);
  });
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

function findTriggers(tree: ReturnType<typeof renderScreen>) {
  return findNodes(tree, (n) => n.props.atom === "FilterTrigger");
}

test("stage and audience filters are two filter triggers on one labelled bar, each checking its current value", async () => {
  const screen = await loadDocsScreen();
  const picked: string[] = [];
  const props = listCardProps(() => undefined);
  (props.inlineFilterProps as Record<string, unknown>).onDocStatusChange = (value: string) => picked.push(value);
  const tree = renderScreen((screen.DocListCardCD as Component)(props));

  const [bar] = findNodes(tree, (n) => n.props.atom === "FilterBar");
  assert.equal(bar.props.label, "Document filters");
  const triggers = findTriggers(bar);
  assert.deepEqual(triggers.map((t) => t.props.axis), ["Show", "Audience"]);
  assert.deepEqual(triggers.map((t) => [...(t.props.chosenKeys as string[])]), [[""], ["all"]]);
  // every option sits in the value cell, so the widest one sizes the trigger; only the chosen one is seen and named
  const values = triggers.map((t) => renderScreen(t.props.value) as Exclude<ReturnType<typeof renderScreen>, string>);
  assert.deepEqual(values.map((value) => findNodes(value, (n) => n.type === "span" && !n.props.className).map(collectText)), [["All"], ["All"]]);
  assert.deepEqual(values.map((value) => findNodes(value, (n) => n.props["aria-hidden"] === "true").length), [2, 2]);

  (triggers[0].props.onPick as (key: string) => void)("done");
  assert.deepEqual(picked, ["done"]);
});

test("the Show menu counts each stage it has a count for, and the caption counts documents, naming revisions as their own unit", async () => {
  const screen = await loadDocsScreen();
  const optionTexts = (tree: ReturnType<typeof renderScreen>) =>
    Array.from(findTriggers(tree)[0].props.options as Array<{ label: unknown }>, (o) => collectText(renderScreen(o.label as never)).replace(/\s+/g, " ").trim()); // Array.from → a test-realm array for strict deep-equal

  const counted = renderListCard(screen, { total: 3, docTotal: 5, groupCounts: { total: 3, open: 2, done: 1 } });
  assert.deepEqual(optionTexts(counted), ["Open 2", "Done 1", "All 3"]);
  assert.match(collectText(counted), /\b3 documents · 5 with revisions\b/);
  assert.doesNotMatch(collectText(counted), /\bgroups\b/, "no internal grouping unit in the caption");

  assert.deepEqual(optionTexts(renderListCard(screen, {})), ["Open", "Done", "All"], "a count the payload lacks renders as nothing, never 0");
});

describe("the filter bar's reset shows only off the entry view", () => {
  const entry = { keyword: "", docStatusFilter: "open", audienceFilter: "all" };
  const rows = [
    { name: "the entry view is not applied", filters: entry, isApplied: false },
    { name: "a blank search is not applied", filters: { ...entry, keyword: "  " }, isApplied: false },
    { name: "a search applies", filters: { ...entry, keyword: "plan" }, isApplied: true },
    { name: "another stage applies", filters: { ...entry, docStatusFilter: "done" }, isApplied: true },
    { name: "every stage applies", filters: { ...entry, docStatusFilter: "" }, isApplied: true },
    { name: "another audience applies", filters: { ...entry, audienceFilter: "visible" }, isApplied: true },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const filters = { ...(listCardProps(() => undefined).inlineFilterProps as Record<string, unknown>), ...row.filters };
      const [bar] = findNodes(renderListCard(screen, { inlineFilterProps: filters }), (n) => n.props.atom === "FilterBar");
      assert.equal(bar.props.isApplied, row.isApplied);
    });
  }

  test("reset returns every axis to the entry view", async () => {
    const screen = await loadDocsScreen();
    const calls: Array<[string, string]> = [];
    const filters = {
      keyword: "plan", docStatusFilter: "done", audienceFilter: "visible",
      onKeywordChange: (v: string) => calls.push(["keyword", v]),
      onDocStatusChange: (v: string) => calls.push(["docStatusFilter", v]),
      onAudienceChange: (v: string) => calls.push(["audienceFilter", v]),
    };
    const [bar] = findNodes(renderListCard(screen, { inlineFilterProps: filters }), (n) => n.props.atom === "FilterBar");
    (bar.props.onReset as () => void)();
    assert.deepEqual(Object.fromEntries(calls), entry);
  });
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

test("while searching, a note says every stage is read, the stored stage stays chosen, and the empty state does not claim it", async () => {
  const screen = await loadDocsScreen();
  const props = listCardProps(() => undefined);
  const filters = { ...(props.inlineFilterProps as Record<string, unknown>), keyword: "plan", docStatusFilter: "open" };
  const searching = renderListCard(screen, { isSearchMode: true, inlineFilterProps: filters });

  const findNote = (tree: ReturnType<typeof renderScreen>) => findNodes(tree, (n) => String(n.props.className ?? "").includes("doc-show-note"));
  const [note] = findNote(searching);
  assert.match(collectText(note), /All stages while searching/);
  assert.doesNotMatch(String(note.props.className), /(^|\s)invisible(\s|$)/, "the note shows while searching");
  assert.deepEqual([...(findTriggers(searching)[0].props.chosenKeys as string[])], ["open"], "the stored stage applies once the search clears");
  const [listed] = findNote(renderListCard(screen, { inlineFilterProps: filters }));
  assert.match(String(listed.props.className), /(^|\s)invisible(\s|$)/, "outside search mode the note keeps its slot, idle");

  const empty = renderScreen((screen.DocEmptyStateCD as Component)({ isSearchMode: true, inlineFilterProps: filters }));
  const [state] = findNodes(empty, (n) => n.props.atom === "EmptyState");
  assert.doesNotMatch(String(state.props.hint), /status:/);
  assert.match(String(state.props.hint), /“plan”/);
});

// an empty corpus → first use in every view · else the bar's applied rule picks no-results + reset, off the entry view (open stage, all audiences, no query)
describe("an empty list shows first use on an empty corpus, else no-results only while a filter is applied", () => {
  const entry = { keyword: "", docStatusFilter: "open", audienceFilter: "all" };
  const rows = [
    { name: "the entry view on an empty corpus", filters: entry, groupCounts: { open: 0, done: 0, total: 0 }, kind: undefined, hasReset: false, isApplied: false, hint: /once an agent posts/ },
    { name: "the entry view while done documents exist", filters: entry, groupCounts: { open: 0, done: 3, total: 3 }, kind: undefined, hasReset: false, isApplied: false, hint: /All in Show/ },
    { name: "the all stage on an empty corpus", filters: { ...entry, docStatusFilter: "" }, groupCounts: { open: 0, done: 0, total: 0 }, kind: undefined, hasReset: false, isApplied: true, hint: /once an agent posts/ },
    { name: "an audience", filters: { ...entry, audienceFilter: "agent-only" }, groupCounts: null, kind: "no-results", hasReset: true, isApplied: true, hint: /audience:/ },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const props = listCardProps(() => undefined);
      const filters = { ...(props.inlineFilterProps as Record<string, unknown>), ...row.filters };
      const tree = renderScreen((screen.DocEmptyStateCD as Component)({ isSearchMode: false, groupCounts: row.groupCounts, inlineFilterProps: filters }));

      const states = findNodes(tree, (n) => n.props.atom === "EmptyState");
      assert.equal(states.length, 1);
      assert.equal(states[0].props.kind, row.kind);
      assert.equal(typeof states[0].props.onReset === "function", row.hasReset);
      assert.equal((screen.isFilterAppliedCD as (f: unknown) => boolean)(filters), row.isApplied, "the bar keeps its own applied rule");
      if (row.hint) assert.match(String(states[0].props.hint), row.hint);
    });
  }
});

test("resetting an empty filtered list returns search, stage and audience to the entry view", async () => {
  const screen = await loadDocsScreen();
  const calls: string[] = [];
  const filters = {
    keyword: "plan", docStatusFilter: "open", audienceFilter: "exposed",
    onKeywordChange: (v: string) => calls.push(`keyword=${v}`),
    onDocStatusChange: (v: string) => calls.push(`stage=${v}`),
    onAudienceChange: (v: string) => calls.push(`audience=${v}`),
  };
  const tree = renderScreen((screen.DocEmptyStateCD as Component)({ isSearchMode: false, inlineFilterProps: filters }));
  const [state] = findNodes(tree, (n) => n.props.atom === "EmptyState");
  (state.props.onReset as () => void)();
  assert.deepEqual(calls, ["keyword=", "stage=open", "audience=all"]);
});

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
// the screen runs in its own vm realm → compare its objects by value
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
type DocAge = { days: number; label: string; bucket: string; isStale: boolean };

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
  // the Created floor holds the glyph only → the word is screen-reader text, and the glyph's tooltip says it too
  const flag = findNodes(staleCell, (n) => n.type === "span" && String(n.props.className).split(/\s+/).includes("doc-age-flag"))[0];
  assert.ok(flag, "the stale flag sits inline in the age line");
  assert.match(String(flag.props.title), /stale/i);
  assert.equal(collectText(findNodes(flag, (n) => n.props.className === "sr-only")[0]), "stale");
  assert.equal(findNodes(staleCell, (n) => n.props.atom === "Icon" && n.props.className === "text-warn").length, 1, "the warn tone rides a glyph");
  assert.equal(ageCells.filter((td) => /stale/i.test(collectText(td))).length, 1);
});

test("the Status column keeps room for the stage name inside stage sections as in a flat list", async () => {
  const screen = await loadDocsScreen();
  const statusFloor = (overrides: Record<string, unknown>) => headerFloorRule(screen, renderListCard(screen, overrides), "Status");
  const sectioned = statusFloor({});
  assert.match(sectioned, /min-width: \d+px/);
  assert.equal(sectioned, statusFloor({ isSearchMode: true }));
});

// the page header's freshness and refresh slots, rendered side by side the way PageHeader groups them
function renderHeaderSlots(screen: Record<string, unknown>, props: Record<string, unknown>) {
  return renderScreen({
    __element: true,
    type: "div",
    props: { children: [(screen.DocHeaderFreshnessCD as Component)(props), (screen.DocHeaderRefreshCD as Component)(props)] },
  });
}

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
      const tree = renderHeaderSlots(screen, { asOf: row.asOf, listState, onRefresh: () => undefined });

      assert.equal(findNodes(tree, (n) => n.props.atom === "FreshnessStamp").length, row.hasStamp ? 1 : 0);
      const buttons = findNodes(tree, (n) => n.props.atom === "RefreshButton");
      assert.equal(buttons.length, 1, "Refresh stays reachable");
      assert.equal(buttons[0].props.isBusy, row.isBusy);
    });
  }
});

test("'rev of #N' trails the title as an unboxed link that never wraps or shrinks, so the ID cell holds the id alone", async () => {
  const screen = await loadDocsScreen();
  const tree = renderListCard(screen, {});
  const [revisionRow] = findNodes(tree, (n) => n.type === "tr" && n.props["aria-label"] === "Doc 11");

  const [titleMain] = findNodes(revisionRow, (n) => String(n.props.className ?? "").split(/\s+/).includes("doc-title-main"));
  const lineage = findNodes(titleMain, (n) => String(n.props.className ?? "").includes("doc-lineage"));
  assert.equal(lineage.length, 1);
  assert.match(collectText(lineage[0]), /^rev of #\s*7$/);
  assert.match(String(lineage[0].props.className), /\blink\b/);
  assert.doesNotMatch(String(lineage[0].props.className), /\bpill/, "no pill box around the link");
  assert.match(cssRuleBody(getScreenCss(screen), ".doc-lineage"), /flex\s*:\s*none/);

  const idCell = findNodes(revisionRow, (n) => n.type === "td" && findNodes(n, (c) => c.props?.atom === "MachineString").length > 0)[0];
  assert.match(collectText(idCell), /^#\s*11$/);

  // a six-digit id in 13px mono (0.6em a glyph) plus the cell padding fits the ID column
  const width = Number(headerFloorRule(screen, tree, "ID").match(/min-width: (\d+)px/)?.[1]);
  assert.ok(width >= 28 + 13 * 0.6 * "#123456".length, `ID column ${width}px`);
});

// mono marks machine strings only → the id is one, an age, a count or a note never is
describe("the list sets only the document id in the machine-string face", () => {
  test("a ledger row's one machine string is its id, and no list node carries a mono class", async () => {
    const tree = renderListCard(await loadDocsScreen(), { totalLabel: "12 documents" });
    const [row] = findNodes(tree, (n) => n.type === "tr" && n.props["aria-label"] === "Doc 11");
    const machine = findNodes(row, (n) => n.props?.atom === "MachineString").map((n) => collectText(n).replace(/\s+/g, ""));
    assert.deepEqual(machine, ["#11"]);
    assert.equal(findNodes(tree, (n) => String(n.props?.className ?? "").includes("doc-list-count")).length, 1, "the count line renders");
    const monoClassed = findNodes(tree, (n) => /\b(font-mono|doc-meta-text-mono)\b/.test(String(n.props?.className ?? "")));
    assert.deepEqual(monoClassed.map((n) => n.props.className), []);
  });

  test("the viewer rail's one machine string is the id, and its labels read sentence case in the body face", async () => {
    const screen = await loadDocsScreen();
    const rail = renderScreen((screen.DocMetaPanelCD as Component)({
      doc: { id: 9, title: "Doc 9", doc_status: "open", format: "md", author: "planner", created_at: "2026-11-09T10:15:42.318Z", supersedes_id: 7 },
      pendingDelete: null, onDelete: () => undefined, togglingIds: new Set(), optimisticStatusOverrides: new Map(),
    }));
    const machine = findNodes(rail, (n) => n.props?.atom === "MachineString").map((n) => collectText(n).replace(/\s+/g, ""));
    assert.deepEqual(machine, ["#9"]);
    const styled = findNodes(rail, (n) => /\b(font-mono|uppercase|tracking-\w+)\b/.test(String(n.props?.className ?? "")));
    assert.deepEqual(styled.map((n) => n.props.className), []);
    assert.doesNotMatch(cssRuleBodyIfAny(getScreenCss(screen), ".doc-meta-label"), /text-transform|letter-spacing|font-family/);
  });

  const sansRules = [
    { name: "a stage section's count", selector: ".doc-stage-section-count" },
    { name: "the bulk bar selection count", selector: ".doc-group-action-bar .selection-count" },
    { name: "a reorder rollback message", selector: ".doc-reorder-error" },
  ];
  for (const row of sansRules) {
    test(`${row.name} keeps the sans face`, async () => {
      assert.doesNotMatch(cssRuleBodyIfAny(getScreenCss(await loadDocsScreen()), row.selector), /monospace/);
    });
  }
});

// spacing reads the role-key ladder (index.html tailwind config) → a number or a px value in a list node or its rule is drift
const NUMERIC_SPACING_CLASS = /(^|\s)-?(p|m|gap|space)(x|y|t|r|b|l|s|e)?-(\d|\[)/;

describe("the bulk bar and the whole-word note space on role keys only", () => {
  const nodes = [
    {
      name: "the bulk bar",
      render: (screen: Record<string, unknown>) => renderScreen((screen.GroupActionBarCD as Component)({ selectionSize: 2, canGroup: true, canUngroup: true })),
      pick: (n: RenderedNode) => n.props.role === "toolbar",
      rule: ".doc-group-action-bar",
    },
    {
      name: "the whole-word search note",
      render: (screen: Record<string, unknown>) => renderListCard(screen, { isSearchMode: true, state: { status: "ready", data: { bigmEnabled: false } } }),
      pick: (n: RenderedNode) => n.props.role === "note" && /Whole-word/.test(collectText(n)),
      rule: null,
    },
  ];
  for (const row of nodes) {
    test(`${row.name} carries role-key spacing and no number`, async () => {
      const screen = await loadDocsScreen();
      const [container] = findNodes(row.render(screen), row.pick);
      assert.ok(container, `${row.name} renders`);
      assert.match(String(container.props.className ?? ""), /(^|\s)px-card-pad(\s|$)/, row.name);
      const classes = findNodes(container, () => true).map((n) => String(n.props?.className ?? ""));
      assert.deepEqual(classes.filter((c) => NUMERIC_SPACING_CLASS.test(c)), [], row.name);
      if (row.rule) assert.doesNotMatch(cssRuleBody(getScreenCss(screen), row.rule), /(^|[;\s])(padding|gap)\s*:/, row.rule);
    });
  }
});

// every list-card state → role keys and atom slots space it, never a number or an inline px
describe("the list card spaces on role keys in every state", () => {
  const rows = [
    { name: "ready with Load More", overrides: { canLoadMore: true, loadMoreRemaining: 40, rows: undefined } },
    { name: "a failed read", overrides: { state: { status: "error", data: null, error: new Error("down"), busy: false }, rows: [] } },
    { name: "an empty filtered list", overrides: { rows: [], inlineFilterProps: undefined } },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen();
      const overrides = Object.fromEntries(Object.entries(row.overrides).filter(([, v]) => v !== undefined));
      const nodes = findNodes(renderListCard(screen, overrides), () => true);
      assert.deepEqual(nodes.map((n) => String(n.props?.className ?? "")).filter((c) => NUMERIC_SPACING_CLASS.test(c)), [], row.name);
      assert.deepEqual(nodes.filter((n) => n.props?.style && /(min|max)?(width|height|padding|margin)/i.test(Object.keys(n.props.style as object).join(" ")) && n.type === "button"), [], `${row.name}: no sized button`);
    });
  }
});

test("Load More sits in the card foot and keeps one label cell for both states", async () => {
  const screen = await loadDocsScreen();
  const tree = renderListCard(screen, { canLoadMore: true, loadMoreRemaining: 1200, isLoadingMore: true });
  const [foot] = findNodes(tree, (n) => n.props.className === "card-foot");
  assert.ok(foot, "the Card renders a foot");
  const [button] = findNodes(foot, (n) => n.type === "button");
  assert.equal(button.props["aria-label"], "Loading more");
  assert.match(collectText(button), /Show 1200 more/, "the idle label holds the width while loading");
});

// content inside a ledger cell → its inline gap is the label-inline role; the cell padding stays the table's
describe("a ledger head count and a group toggle space their content on the label-inline role", () => {
  const groupRoot = { id: 21, title: "Doc 21", doc_status: "open", format: "md", audience: "exposed", author: "glass-atrium-intel-planner",
    created_at: "2026-09-01T00:00:00Z", member_count: 3, folder_id: 5 };
  const nodes = [
    { name: "a stage section's count", rule: ".doc-stage-section-count", property: "margin", roleClass: "ml-label-inline" },
    { name: "a group root's member toggle", rule: ".doc-group-toggle", property: "gap", roleClass: "gap-label-inline" },
    { name: "a group root's member toggle hit area", rule: ".doc-group-toggle", property: "padding", roleClass: "inline-target" },
    { name: "a group root's member toggle label", rule: ".doc-group-toggle", property: "font-size", roleClass: "fs-meta" },
    { name: "a ledger title line", rule: ".doc-title-main", property: "gap", roleClass: "gap-label-inline" },
    { name: "a stage section's count size", rule: ".doc-stage-section-count", property: "font-size", roleClass: "fs-meta" },
  ];
  for (const row of nodes) {
    test(`${row.name} takes ${row.roleClass} and its rule sets no ${row.property}`, async () => {
      const screen = await loadDocsScreen();
      const tree = renderListCard(screen, { rows: [groupRoot] });
      const className = row.rule.slice(1);
      const [node] = findNodes(tree, (n) => String(n.props?.className ?? "").split(/\s+/).includes(className));
      assert.ok(node, `${row.name} renders`);
      assert.match(String(node.props.className), new RegExp(`(^|\\s)${row.roleClass}(\\s|$)`), row.name);
      assert.doesNotMatch(cssRuleBodyIfAny(getScreenCss(screen), row.rule), new RegExp(`(^|[;\\s])${row.property}(-left)?\\s*:`), row.rule);
    });
  }
});

// the filter bar and its count line lay out and tone on house utilities → the screen style block holds no rule a utility already ships
describe("the filter bar and its count line take their layout and tone from utilities, not the screen style block", () => {
  const rows = [
    { name: "the count line", find: (n: RenderedNode) => hasClass(n, "doc-list-meta"), hook: ".doc-list-meta",
      utilities: ["basis-full", "flex", "flex-wrap", "justify-end", "items-center", "gap-x-list"] },
    { name: "the document count", find: (n: RenderedNode) => hasClass(n, "doc-list-count"), hook: ".doc-list-count",
      utilities: ["whitespace-nowrap", "text-dim", "fs-meta", "tabular-nums"] },
    { name: "the search note", find: (n: RenderedNode) => hasClass(n, "doc-show-note"), hook: ".doc-show-note",
      utilities: ["text-dim", "whitespace-nowrap", "fs-meta"] },
    { name: "the filter bar", find: (n: RenderedNode) => n.props?.atom === "FilterBar", hook: ".doc-filter-bar",
      utilities: ["flex-auto", "min-w-0"] },
  ];
  const hasClass = (n: RenderedNode, name: string) => String(n.props?.className ?? "").split(/\s+/).includes(name);
  for (const row of rows) {
    test(`${row.name} carries its utilities, no inline style, and no screen rule`, async () => {
      const screen = await loadDocsScreen();
      const tree = renderListCard(screen, { state: { status: "ready", data: {}, error: null, busy: false }, total: 3, docTotal: 3 });
      const [node] = findNodes(tree, row.find);
      assert.ok(node, `${row.name} renders`);
      const classes = String(node.props.className ?? "").split(/\s+/);
      assert.deepEqual(row.utilities.filter((utility) => !classes.includes(utility)), [], row.name);
      assert.equal(node.props.style, undefined, `${row.name} has no inline style`);
      assert.doesNotMatch(getScreenCss(screen), new RegExp(`${row.hook.replace(".", "\\.")}[\\s,.:{]`), `${row.hook} has no screen rule`);
    });
  }
});

// a ledger text node's tone and inline layout read utilities → a screen rule restating them is a second declaration
describe("ledger text nodes take their tone and inline layout from utilities, not the screen style block", () => {
  const groupRoot = { id: 21, title: "Doc 21", doc_status: "open", format: "md", audience: "exposed", author: "glass-atrium-intel-planner",
    created_at: "2026-09-01T00:00:00Z", member_count: 3, folder_id: 5 };
  const ledger = (screen: Record<string, unknown>) => renderListCard(screen, { rows: [groupRoot] });
  const bulkBar = (screen: Record<string, unknown>) =>
    renderScreen((screen.GroupActionBarCD as Component)({ selectionSize: 2, canGroup: true, canUngroup: true }));
  const staleAgeCell = (screen: Record<string, unknown>) =>
    renderScreen((screen.DocAgeCellCD as Component)({ createdAt: "2026-10-04T00:00:00Z", age: { label: "15d" }, isStale: true }));
  const rows = [
    { name: "a Created cell's age line", render: staleAgeCell, hook: "doc-age-line", rule: ".doc-age-line",
      utilities: ["flex", "justify-end", "items-center", "gap-label-inline"] },
    { name: "a Created cell's age value", render: staleAgeCell, hook: "doc-age-value", rule: ".doc-age-value",
      utilities: ["flex-none"] },
    { name: "a Created cell's stale flag", render: staleAgeCell, hook: "doc-age-flag", rule: ".doc-age-flag",
      utilities: ["relative", "inline-flex", "items-center", "flex-none", "text-dim"] },
    { name: "a stage section's count", render: ledger, hook: "doc-stage-section-count", rule: ".doc-stage-section-count",
      utilities: ["text-faint", "fs-meta", "tabular-nums", "ml-label-inline"] },
    { name: "a ledger title line", render: ledger, hook: "doc-title-main", rule: ".doc-title-main",
      utilities: ["flex", "flex-auto", "min-w-0", "items-center", "flex-nowrap", "gap-label-inline"] },
    { name: "the bulk bar selection count", render: bulkBar, hook: "selection-count", rule: ".doc-group-action-bar .selection-count",
      utilities: ["text-ink", "fs-body", "font-semibold", "tabular-nums"] },
  ];
  for (const row of rows) {
    test(`${row.name} carries its utilities, no inline style, and no screen rule`, async () => {
      const screen = await loadDocsScreen();
      const [node] = findNodes(row.render(screen), (n) => String(n.props?.className ?? "").split(/\s+/).includes(row.hook));
      assert.ok(node, `${row.name} renders`);
      const classes = String(node.props.className).split(/\s+/);
      assert.deepEqual(row.utilities.filter((utility) => !classes.includes(utility)), [], row.name);
      assert.equal(node.props.style, undefined, `${row.name} has no inline style`);
      assert.equal(cssRuleBodyIfAny(getScreenCss(screen), row.rule), "", `${row.rule} has no screen rule`);
    });
  }

  // a grouped selector (".doc-age-value, .doc-age-flag") escapes the per-row rule lookup → match any selector naming the hook
  test("a Created cell's age line, value and stale flag have no screen rule", async () => {
    assert.doesNotMatch(getScreenCss(await loadDocsScreen()), /\.doc-age-(line|value|flag)[\s,.:{]/);
  });

  test("a reorder rollback message has no screen rule", async () => {
    assert.doesNotMatch(getScreenCss(await loadDocsScreen()), /\.doc-reorder-error[\s,.:{]/);
  });
});

// a ledger text tone is the house utility on its node → an inline color is a second declaration of the same token
describe("ledger meta cells, title lines, the search snippet and the Show counts tone through utilities, never an inline color", () => {
  const member = { id: 21, title: "Member", doc_status: "open", format: "md", audience: "exposed", author: "glass-atrium-intel-planner",
    created_at: "2026-09-01T00:00:00Z" };
  // a factory: the shared noop stub is declared further down the file
  const memberProps = () => ({
    folderId: 5, representativeId: 21, memberCount: 2, onReorder: noop, isSearchMode: false, hasTagsColumn: false,
    selectedId: null, selectedIds: new Set(), pendingDelete: null, onSelect: noop, onToggleSelection: noop, onPickStage: noop,
    togglingIds: new Set(), optimisticStatusOverrides: new Map(),
  });
  const classOf = (n: RenderedNode) => String(n.props?.className ?? "").split(/\s+/);
  const rootLedger = async () =>
    renderListCard(await loadDocsScreen(), { isSearchMode: true, rows: [{ ...member, id: 31, snippet: "the <mark>auth</mark> gate ships" }] });
  const memberRows = async () => {
    const screen = await loadDocsScreen(stubbedStateReact({ status: "ready", data: [member, { ...member, id: 22 }], error: null }));
    return renderScreen(inTbody((screen.GroupMembersRowsCD as Component)(memberProps())));
  };
  const showCounts = async () => {
    const react = createReactStub();
    const screen = await loadDocsScreen(react);
    const options = (screen.getStageOptionsCD as (counts: Record<string, number>) => Array<{ label: unknown }>)({ open: 3, done: 1, total: 4 });
    return renderScreen((react.createElement as (...args: unknown[]) => unknown)("div", null, ...options.map((option) => option.label)));
  };
  const rows = [
    { name: "a root row's Author, ID and Created cells", render: rootLedger, utility: "text-dim", count: 3,
      find: (n: RenderedNode) => n.type === "td" && classOf(n).includes("tbl-cell--meta") },
    { name: "a member row's Author, ID and Created cells", render: memberRows, utility: "text-dim", count: 6,
      find: (n: RenderedNode) => n.type === "td" && classOf(n).includes("tbl-cell--meta") },
    { name: "a root row's search snippet", render: rootLedger, utility: "text-dim", count: 1,
      find: (n: RenderedNode) => classOf(n).includes("doc-snippet") },
    { name: "each Show option's document count", render: showCounts, utility: "text-dim", count: 3,
      find: (n: RenderedNode) => n.type === "span" && classOf(n).includes("tabular-nums") },
    { name: "a root row's title line", render: rootLedger, utility: "text-ink", count: 1,
      find: (n: RenderedNode) => classOf(n).includes("doc-title-row") && classOf(n).includes("font-medium") },
    { name: "a member row's title line", render: memberRows, utility: "text-ink", count: 2,
      find: (n: RenderedNode) => classOf(n).includes("doc-title-row") && classOf(n).includes("font-medium") },
  ];
  for (const row of rows) {
    test(`${row.name} take ${row.utility} and carry no inline color`, async () => {
      const nodes = findNodes(await row.render(), row.find);
      assert.equal(nodes.length, row.count, `${row.name} render`);
      for (const node of nodes) {
        assert.ok(classOf(node).includes(row.utility), `${row.name}: ${classOf(node).join(" ")}`);
        assert.equal((node.props.style as { color?: string } | undefined)?.color, undefined, `${row.name}: no inline color`);
      }
    });
  }
});

// a section head is a house body header → a declaration its rule restates drifts from the table the moment base.css moves
describe("a stage section head's rule restates nothing the house table header sets", () => {
  for (const property of ["height", "text-align", "font-size", "color", "background", "border-bottom"]) {
    test(`it sets no ${property}`, async () => {
      const screen = await loadDocsScreen();
      assert.doesNotMatch(cssRuleBody(getScreenCss(screen), "tr.doc-stage-section > th"), new RegExp(`(^|[;\\s])${property}\\s*:`));
    });
  }
});

// a role utility the Tailwind config has no key for emits no CSS → the node silently keeps its UA spacing
test("every spacing utility on the ledger names a key its Tailwind config section holds", async () => {
  const sectionOf: Record<string, RoleSection> = {
    p: "padding", px: "padding", py: "padding", pt: "padding", pr: "padding", pb: "padding", pl: "padding",
    gap: "gap", "gap-x": "gap", "gap-y": "gap",
    m: "margin", mx: "margin", my: "margin", mt: "margin", mr: "margin", mb: "margin", ml: "margin",
    "space-x": "space", "space-y": "space",
  };
  const keys = getRoleKeys();
  const screen = await loadDocsScreen();
  const groupRoot = { id: 21, title: "Doc 21", snippet: "the <mark>auth</mark> gate", doc_status: "open", format: "md",
    audience: "exposed", author: "glass-atrium-intel-planner", created_at: "2026-09-01T00:00:00Z", member_count: 3, folder_id: 5 };
  const tree = renderListCard(screen, { isSearchMode: true, rows: [groupRoot] });
  const utilities = findNodes(tree, (n) => typeof n.props?.className === "string")
    .flatMap((n) => String(n.props.className).split(/\s+/))
    .map((cls) => /^(p[xytrbl]?|gap(?:-[xy])?|m[xytrbl]?|space-[xy])-(.+)$/.exec(cls))
    .filter((match): match is RegExpExecArray => match !== null);
  assert.ok(utilities.length > 0, "the ledger renders spacing utilities");
  // margin auto → Tailwind's core centring value, never a spacing step
  const isMarginAuto = (prefix: string, key: string) => sectionOf[prefix] === "margin" && key === "auto";
  const unknown = utilities
    .filter(([, prefix, key]) => !isMarginAuto(prefix, key) && !(key in keys[sectionOf[prefix]]))
    .map(([cls]) => cls);
  assert.deepEqual([...new Set(unknown)], []);
});

test("a search snippet sits under its title on the stack role, with no number in its class or its rule", async () => {
  const screen = await loadDocsScreen();
  const row = { id: 31, title: "Auth rollout plan", snippet: "the <mark>auth</mark> gate ships", doc_status: "open", format: "md",
    audience: "exposed", author: "glass-atrium-intel-planner", created_at: "2026-09-01T00:00:00Z" };
  const tree = renderListCard(screen, { isSearchMode: true, rows: [row] });
  const has = (n: RenderedNode, name: string) => String(n.props?.className ?? "").split(/\s+/).includes(name);
  const [line] = findNodes(tree, (n) => has(n, "doc-title-row") && findNodes(n, (c) => has(c, "doc-snippet")).length > 0);

  assert.ok(line, "the snippet line renders");
  assert.match(String(line.props.className), /(^|\s)mt-stack(\s|$)/);
  for (const node of [line, ...findNodes(line, (n) => has(n, "doc-snippet"))]) {
    assert.doesNotMatch(String(node.props.className), /(^|\s)-?m[trblxy]?-(\d|\[)/);
  }
  assert.doesNotMatch(cssRuleBody(getScreenCss(screen), ".doc-snippet"), /(^|[;\s])margin-top\s*:/);
});

// a list type size is the type-scale class on its node → no screen rule restates it
test("a ledger row's meta cells and its search snippet take fs-meta, and no screen rule sets their size", async () => {
  const screen = await loadDocsScreen();
  const row = { id: 31, title: "Auth rollout plan", snippet: "the <mark>auth</mark> gate ships", doc_status: "open", format: "md",
    audience: "exposed", author: "glass-atrium-intel-planner", created_at: "2026-09-01T00:00:00Z" };
  const tree = renderListCard(screen, { isSearchMode: true, rows: [row] });
  const classOf = (n: RenderedNode) => String(n.props?.className ?? "");
  const metaCells = findNodes(tree, (n) => n.type === "td" && /(^|\s)tbl-cell--meta(\s|$)/.test(classOf(n)));
  const [snippet] = findNodes(tree, (n) => classOf(n).split(/\s+/).includes("doc-snippet"));

  assert.equal(metaCells.length, 3, "Author, ID and Created render as meta cells");
  for (const node of [...metaCells, snippet]) assert.match(classOf(node), /(^|\s)fs-meta(\s|$)/, classOf(node));
  assert.doesNotMatch(getScreenCss(screen), /\.doc-meta-text\s*\{/);
});

test("the bulk bar selection count takes fs-body and its rule sets no size or weight", async () => {
  const screen = await loadDocsScreen();
  const tree = renderScreen((screen.GroupActionBarCD as Component)({ selectionSize: 2, canGroup: true, canUngroup: true }));
  const [count] = findNodes(tree, (n) => String(n.props?.className ?? "").split(/\s+/).includes("selection-count"));

  assert.match(String(count.props.className), /(^|\s)fs-body(\s|$)/);
  assert.doesNotMatch(cssRuleBodyIfAny(getScreenCss(screen), ".doc-group-action-bar .selection-count"), /(^|[;\s])font-(size|weight)\s*:/);
});

test("the last stage actor rides the Status cell's tooltip, never a line under the status", async () => {
  const screen = await loadDocsScreen();
  const base = listCardProps(() => undefined);
  const [first, second] = base.rows as Array<Record<string, unknown>>;
  const tree = renderListCard(screen, { rows: [{ ...first, last_status_model: "operator" }, second] });

  assert.equal(findNodes(tree, (n) => String(n.props.className ?? "").includes("doc-stage-actor")).length, 0);
  const statusCells = findNodes(tree, (n) => n.type === "td" && findNodes(n, (c) => c.type === "DocStageCD").length > 0);
  assert.deepEqual(statusCells.map((td) => td.props.title), ["Set by operator", undefined]);
});

test("the Title header starts at the title text's x: its label follows an empty lead slot in a title row and no rule indents it", async () => {
  const screen = await loadDocsScreen();
  const has = (n: RenderedNode, name: string) => String(n.props?.className ?? "").split(/\s+/).includes(name);
  const titleHeader = findNodes(renderListCard(screen, {}), (n) => n.type === "th" && collectText(n).trim() === "Title")[0];
  assert.ok(titleHeader, "the Title header renders");
  const [line] = findNodes(titleHeader, (n) => has(n, "doc-title-row"));

  assert.ok(line, "the header label sits in a title row");
  const parts = findNodes(line, (n) => has(n, "doc-title-lead") || (n.type === "span" && n !== line && collectText(n).trim() === "Title"));
  assert.deepEqual(parts.map((n) => (has(n, "doc-title-lead") ? "lead" : "label")), ["lead", "label"]);
  assert.equal(collectText(parts[0]), "", "the header's lead slot is empty");
  assert.doesNotMatch(getScreenCss(screen), /\.doc-col-title-text\s*\{/);
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
    { name: "idle", state: { status: "idle" }, shown: isAtom("EmptyState") },
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
  // the glyph → words gap is the label-inline role on the alert line, never a number in the screen rule
  for (const row of rows.filter((r) => r.tone === "crit")) {
    test(`${row.name} spaces its glyph and words on the label-inline role`, async () => {
      const screen = await loadDocsScreen(row.react());
      const [alert] = findNodes(renderScreen(row.render(screen)), (n) => String(n.props?.className ?? "").split(/\s+/).includes("doc-inline-alert"));
      assert.ok(alert, `${row.name}: the alert line renders`);
      const classes = String(alert.props.className).split(/\s+/);
      assert.deepEqual(["inline-flex", "items-center", "gap-label-inline"].filter((utility) => !classes.includes(utility)), []);
      assert.doesNotMatch(getScreenCss(screen), /\.doc-inline-alert[\s,.:{]/, "the alert line has no screen rule");
    });
  }
});

// table cells are atom-owned padding (plan S3 role tokens) → a member state line restates no inset and takes its colour from a class
describe("a group member state line keeps the cell atom's padding and colours its words on a class", () => {
  const member = { id: 21, title: "Member", doc_status: "open", format: "md", audience: "exposed", author: "a", created_at: "2026-09-01T00:00:00Z" };
  const memberProps = {
    folderId: 5, representativeId: 21, memberCount: 2, onReorder: noop, isSearchMode: false, hasTagsColumn: false,
    selectedId: null, selectedIds: new Set(), pendingDelete: null, onSelect: noop, onToggleSelection: noop, onPickStage: noop,
    togglingIds: new Set(), optimisticStatusOverrides: new Map(),
  };
  const rows = [
    { name: "loading members", state: { status: "loading", data: null, error: null }, nullAs: null, wordsClass: "text-faint" },
    { name: "a failed member load", state: { status: "error", data: null, error: "HTTP 500" }, nullAs: null, wordsClass: "text-ink" },
    { name: "an empty group", state: { status: "ready", data: [], error: null }, nullAs: null, wordsClass: "text-faint" },
    {
      name: "a reorder that did not save", state: { status: "ready", data: [member, { ...member, id: 22 }], error: null },
      nullAs: "Order not saved — reverted", wordsClass: "text-ink",
    },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const screen = await loadDocsScreen(stubbedStateReact(row.state, row.nullAs));
      const tree = renderScreen(inTbody((screen.GroupMembersRowsCD as Component)(memberProps)));
      const [spanCell] = findNodes(tree, (n) => n.type === "td" && String(n.props.className ?? "").split(/\s+/).includes("tbl-cell--span"));
      assert.ok(spanCell, `${row.name}: the state line renders in a span cell`);
      assert.equal(spanCell.props.style, undefined, `${row.name}: no inline style on the span cell`);
      const classed = findNodes(spanCell, (n) => String(n.props?.className ?? "").split(/\s+/).includes(row.wordsClass));
      assert.equal(classed.length, 1, `${row.name}: words coloured by ${row.wordsClass}`);
    });
  }
});

test("the version history names the current revision in ink, never in a severity tone", async () => {
  const screen = await loadDocsScreen();
  const tree = renderScreen((screen.PredecessorPanelCD as Component)({ predecessorId: 7, currentDoc: viewerDoc(), onNavigate: noop }));
  const [label] = findNodes(tree, (n) => n.type === "span" && collectText(n).trim() === "Current revision");
  const classes = String(label.props.className ?? "").split(/\s+/);
  assert.ok(classes.includes("text-ink"), "ink utility");
  assert.equal(classes.some((c) => /^text-(crit|warn|ok|info)$/.test(c)), false, "no severity tone");
  assert.equal(label.props.style, undefined, "no inline colour");
});

// the viewer rail's spacing and type ride role utilities → the screen style block keeps only its grid templates
describe("the viewer rail spaces and sets type on role utilities, not the screen style block", () => {
  const nodes = [
    { name: "a fact row's label-to-value gap", hook: "doc-meta-row", rule: ".doc-meta-row", property: "gap", roleClass: "gap-x-label-inline" },
    { name: "a fact row's grid", hook: "doc-meta-row", rule: ".doc-meta-row", property: "display", roleClass: "grid" },
    { name: "a fact row's size", hook: "doc-meta-row", rule: ".doc-meta-row", property: "font-size", roleClass: "fs-meta" },
    { name: "a fact label's tone", hook: "doc-meta-label", rule: ".doc-meta-label", property: "color", roleClass: "text-faint" },
    { name: "a fact value's tone", hook: "doc-meta-value", rule: ".doc-meta-value", property: "color", roleClass: "text-ink" },
    { name: "the stage's glyph-to-word gap", hook: "doc-stage", rule: ".doc-stage", property: "gap", roleClass: "gap-label-inline" },
    { name: "the stage word's face", hook: "doc-stage", rule: ".doc-stage-label", property: "font-family", roleClass: "font-sans" },
    { name: "the stage glyph's tone", hook: "doc-stage-glyph", rule: ".doc-stage-glyph", property: "color", roleClass: "text-dim" },
    { name: "the stage-to-menu gap", hook: "doc-stage-cell", rule: ".doc-stage-cell", property: "column-gap", roleClass: "gap-x-label-inline" },
  ];
  for (const row of nodes) {
    test(`${row.name} takes ${row.roleClass} and ${row.rule} sets no ${row.property}`, async () => {
      const screen = await loadDocsScreen();
      // the rail mounts its stage as an element → the stage renders on its own
      const tree = row.hook.startsWith("doc-stage")
        ? renderScreen((screen.DocStageCD as Component)({ docStatus: "implementing", docTitle: "Plan", onPickStage: noop }))
        : renderScreen((screen.DocMetaPanelCD as Component)({
          doc: viewerDoc(), pendingDelete: null, onDelete: noop, onPickStage: noop,
          togglingIds: new Set(), optimisticStatusOverrides: new Map(),
        }));
      const [node] = findNodes(tree, hasClass(row.hook));
      assert.ok(node, `${row.hook} renders`);
      assert.ok(hasClass(row.roleClass)(node), row.name);
      assert.doesNotMatch(cssRuleBodyIfAny(getScreenCss(screen), row.rule), new RegExp(`(^|[;\\s])${row.property}[\\w-]*\\s*:`), row.rule);
    });
  }
});

// a flex child's margin adds to its Stack's gap → one sub-block margin turns the 16 block gap into 24, no role value
test("the viewer rail parts its sub-blocks by one block gap and its facts by one list gap, and no sub-block adds a margin or rule of its own", async () => {
  const screen = await loadDocsScreen();
  const tree = renderScreen((screen.DocMetaPanelCD as Component)({
    doc: viewerDoc({ supersedes_id: 7 }), pendingDelete: null, onDelete: noop, onPickStage: noop,
    togglingIds: new Set(), optimisticStatusOverrides: new Map(),
  }));
  const [rail, ...innerStacks] = findNodes(tree, isAtom("Stack"));
  assert.equal(rail?.props.gap, "block", "the rail is a block Stack");
  const facts = innerStacks.find((n) => findNodes(n, hasClass("doc-meta-row")).length > 0);
  assert.ok(facts, "the facts sit in a Stack");
  assert.equal(facts.props.gap, "list", "a list Stack");
  assert.equal(findNodes(facts, hasClass("doc-meta-row")).length, findNodes(tree, hasClass("doc-meta-row")).length, "every fact row is in it");
  const subBlocks = rail.children.filter((c): c is RenderedNode => typeof c !== "string").map(getHostNode);
  assert.equal(subBlocks.length, 4, "facts, stage, version history, delete");
  for (const block of subBlocks) {
    assert.doesNotMatch(String(block.props.className ?? ""), /(^|\s)m[tbylrx]?-/, `${block.type} margin class`);
    assert.equal(block.props.style, undefined, `${block.type} inline style`);
  }
  for (const rule of [".doc-meta-row", ".doc-meta-danger", ".doc-version-history"]) {
    assert.doesNotMatch(cssRuleBodyIfAny(getScreenCss(screen), rule), /(^|[;\s])(margin|padding|border)[\w-]*\s*:/, rule);
  }
});

// a component node wraps the element it renders → the element that takes the layout classes
function getHostNode(node: RenderedNode): RenderedNode {
  const [only] = node.children;
  const isWrapper = node.type !== "ui-atom" && /^[A-Z]/.test(node.type) && node.children.length === 1;
  return isWrapper && only !== undefined && typeof only !== "string" ? getHostNode(only) : node;
}

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
});

test("a ledger checkbox draws the shared checkbox on theme tokens: neutral at rest, the one selected state when checked or mixed, and no transition", async () => {
  const screen = await loadDocsScreen();
  const css = readFileSync(resolve(__dirname, "../public/styles/base.css"), "utf8");
  for (const props of [{ checked: false }, { checked: true }, { checked: false, indeterminate: true }]) {
    const tree = renderScreen((screen.DocCheckboxCD as Component)({ ...props, onChange: noop, ariaLabel: "Select" }));
    const [input] = findNodes(tree, (n) => n.type === "input");
    const classes = String(input.props.className);
    assert.ok(hasClass("ctl-checkbox")(input), "token-drawn class");
    assert.doesNotMatch(classes, /zinc-|emerald-|transition|duration-/);
    const marks = findNodes(tree, (n) => n.props.atom === "Icon");
    assert.equal(marks.length, props.checked || props.indeterminate ? 1 : 0);
    for (const mark of marks) assert.ok(String(mark.props.className).includes("ctl-checkbox-mark"));
  }
  assert.match(cssRuleBody(css, ".ctl-checkbox"), /background\s*:\s*rgb\(var\(--elev\)\)/);
  assert.match(cssRuleBody(css, ".ctl-checkbox"), /border\s*:\s*1\.5px solid rgb\(var\(--faint\)\)/);
  assert.match(cssRuleBody(css, ".ctl-checkbox:checked,\n.ctl-checkbox:indeterminate"), /background\s*:\s*rgb\(var\(--selected-fill\)\)/);
  assert.match(cssRuleBody(css, ".ctl-checkbox-mark"), /color\s*:\s*rgb\(var\(--selected-ink\)\)/);
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
