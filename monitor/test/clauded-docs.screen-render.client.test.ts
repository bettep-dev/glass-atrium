// Element-tree behaviour tests for the Documents screen header and stage pill,
// exercised through test/lib/render-screen.ts — no DOM, no react-dom, no DB.
//
// Runner: npx tsx --test test/clauded-docs.screen-render.client.test.ts

import test from "node:test";
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

function uiStub(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name in UI_SCALARS
          ? UI_SCALARS[name]
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

async function loadDocsScreen(): Promise<Record<string, unknown>> {
  return loadScreenModule(DOCS_SRC, { UI: uiStub(), React: createReactStub() });
}

function cssRuleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `CSS rule ${selector} must exist`);
  return match[1];
}

test("the terminal stage pill carries the ok tone on border and glyph, never on its label text", () => {
  const source = readFileSync(DOCS_SRC, "utf8");
  const terminalPill = cssRuleBody(source, ".doc-stage-pill.is-terminal");
  const glyph = cssRuleBody(source, ".doc-stage-glyph.is-terminal");

  assert.doesNotMatch(terminalPill, /(^|[;\s])color\s*:/, "terminal pill must not recolor its text");
  assert.match(terminalPill, /border-color\s*:\s*rgb\(var\(--ok\)/);
  assert.match(glyph, /(^|[;\s])color\s*:\s*rgb\(var\(--ok\)\)/);
});

test("a done pill renders its check glyph inside the ok-toned glyph slot and its label outside it", async () => {
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
