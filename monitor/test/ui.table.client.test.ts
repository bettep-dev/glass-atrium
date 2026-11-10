// Table sections and cell atoms on the client render path: the mode compare, wide-mode markup, the cell kinds and the row-action pair.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;
interface View { isStacked: boolean; columnCount: number }

const ui = await loadScreenModule(UI_SRC);
const React = ui.React as { createElement: (t: unknown, p: unknown, ...c: unknown[]) => unknown };
const h = React.createElement;
const getTableMode = ui.getTableMode as (widthPx: unknown, stackBelowPx: unknown) => string;

const render = (name: string, props: Record<string, unknown>, ...children: unknown[]): RenderedNode =>
  renderScreen(h(ui[name] as Component, props, ...children)) as RenderedNode;
const byType = (tree: RenderedNode, type: string) => findNodes(tree, (n) => n.type === type);

const COLUMNS = [
  { key: "agent", label: "Agent" },
  { key: "runs", label: "Runs", isNumeric: true, sort: "descending" },
  { key: "cost", label: "Cost", isNumeric: true },
];
const WIDE: View = { isStacked: false, columnCount: 3 };
const STACKED: View = { isStacked: true, columnCount: 3 };
const onKeyDown = () => undefined;

// one fixture table with every section → the wide markup each test reads
const getFixture = (stackBelowPx?: number) => render("Table", {
  caption: "Runs by agent",
  columns: COLUMNS,
  widths: ["40%", "30%", "30%"],
  stackBelowPx,
  bodies: [
    { key: "agents", onKeyDown, rows: (view: View) => h(ui.TableRow as Component, { view },
      h(ui.TableCell as Component, { view, kind: "row-header" }, "glass-atrium-dev-react-with-a-long-name"),
      h(ui.TableCell as Component, { view, textRole: "meta", label: "Runs", isNumeric: true }, "1,284"),
      h(ui.TableCell as Component, { view, textRole: "meta", label: "Cost", isNumeric: true }, "None")) },
    { key: "pseudo", isBusy: true, className: "tbl-body--pseudo", onKeyDown, rows: (view: View) => h(ui.TableRow as Component, { view },
      h(ui.TableCell as Component, { view, kind: "span" }, "Loading pseudo-agents…")) },
  ],
  foot: (view: View) => h(ui.TableRow as Component, { view },
    h(ui.TableCell as Component, { view, kind: "row-header" }, "Total"),
    h(ui.TableCell as Component, { view, kind: "span", start: 1 }, "1,284")),
});

describe("table mode compare", () => {
  const rows = [
    { name: "an unmeasured width (0) is wide", width: 0, threshold: 700, mode: "wide" },
    { name: "an absent width is wide", width: undefined, threshold: 700, mode: "wide" },
    { name: "a non-number width is wide", width: "500", threshold: 700, mode: "wide" },
    { name: "a width with no threshold is wide", width: 500, threshold: undefined, mode: "wide" },
    { name: "a width below the threshold is stacked", width: 699, threshold: 700, mode: "stacked" },
    { name: "a width at the threshold is wide", width: 700, threshold: 700, mode: "wide" },
  ];
  for (const row of rows) {
    test(row.name, () => assert.equal(getTableMode(row.width, row.threshold), row.mode));
  }
});

describe("table on the client render path", () => {
  test("an unmeasured table renders wide with no label prefix in its text", () => {
    const tree = getFixture(700);

    assert.equal(tree.children[0] && (tree.children[0] as RenderedNode).props["data-table-mode"], "wide");
    assert.deepEqual(byType(tree, "td").map((td) => collectText(td)), ["1,284", "None", "Loading pseudo-agents…", "1,284"]);
    assert.equal(byType(tree, "col").length, 3);
    assert.equal(findNodes(tree, (n) => typeof n.props.role === "string").length, 0, "wide markup restates no role");
  });

  test("each body keeps its own busy state, key handler and class, and the foot follows the last body", () => {
    const table = byType(getFixture(700), "table")[0];
    // a component node (the column head) → its host element
    const getHost = (n: RenderedNode): RenderedNode => (/^[A-Z]/.test(n.type) ? getHost(n.children[0] as RenderedNode) : n);
    const sections = table.children.filter((n): n is RenderedNode => typeof n !== "string")
      .map(getHost).filter((n) => n.type !== "caption" && n.type !== "colgroup");
    const bodies = sections.filter((n) => n.type === "tbody");

    assert.deepEqual(sections.map((n) => n.type), ["thead", "tbody", "tbody", "tfoot"]);
    assert.deepEqual(bodies.map((n) => [n.props["aria-busy"], n.props.onKeyDown === onKeyDown, n.props.className]),
      [[undefined, true, undefined], ["true", true, "tbl-body--pseudo"]]);
  });

  test("a sorted column header carries aria-sort", () => {
    const heads = byType(getFixture(700), "th").filter((n) => n.props.scope === "col");

    assert.deepEqual(heads.map((n) => n.props["aria-sort"]), [undefined, "descending", undefined]);
  });
});

describe("table cell kinds", () => {
  test("a span cell spans the rest of the row from its start column", () => {
    const rows = [{ start: 0, span: 3 }, { start: 1, span: 2 }, { start: 3, span: 1 }];
    for (const row of rows) {
      const cell = render("TableCell", { view: WIDE, kind: "span", start: row.start }, "x");
      assert.equal(cell.children[0] && (cell.children[0] as RenderedNode).props.colSpan, row.span, `start ${row.start}`);
    }
  });

  test("a group header is a focusable heading anchor across the whole row", () => {
    const th = byType(render("TableCell", { view: WIDE, kind: "group-header", level: 3, id: "group-fail" }, "Failures"), "th")[0];

    assert.deepEqual([th.props.role, th.props["aria-level"], th.props.id, th.props.tabIndex, th.props.colSpan],
      ["heading", 3, "group-fail", -1, 3]);
  });

  test("a row header is scoped to its row", () => {
    const th = byType(render("TableCell", { view: WIDE, kind: "row-header" }, "Total"), "th")[0];

    assert.equal(th.props.scope, "row");
  });

  test("stacked mode restates the cell roles and prefixes a meta cell with its hidden label", () => {
    const meta = byType(render("TableCell", { view: STACKED, textRole: "meta", label: "Cost" }, "$1.20"), "td")[0];
    const primary = byType(render("TableCell", { view: STACKED, textRole: "primary", label: "Agent" }, "dev-react"), "td")[0];
    const prefix = byType(meta, "span")[0];

    assert.equal(meta.props.role, "cell");
    assert.equal(byType(render("TableCell", { view: STACKED, kind: "row-header" }, "Total"), "th")[0].props.role, "rowheader");
    assert.equal(byType(render("TableRow", { view: STACKED }), "tr")[0].props.role, "row");
    assert.deepEqual([collectText(prefix), prefix.props["aria-hidden"]], ["Cost", "true"]);
    assert.equal(byType(primary, "span").length, 0, "only a meta cell carries the prefix");
  });
});

describe("row actions", () => {
  test("the visible action renders, and the overflow menu trigger only when items exist", () => {
    const action = h("button", { type: "button", id: "open" }, "Open");
    const withMenu = render("RowActions", { label: "More actions for dev-react", action, items: [{ key: "copy", label: "Copy id" }], onPick: () => undefined });
    const without = render("RowActions", { label: "More actions for dev-react", action, items: [], onPick: () => undefined });
    const triggers = (tree: RenderedNode) => findNodes(tree, (n) => n.props["aria-haspopup"] === "menu");

    assert.deepEqual([byType(withMenu, "button").length, triggers(withMenu)[0]?.props["aria-label"]], [2, "More actions for dev-react"]);
    assert.deepEqual([byType(without, "button").length, triggers(without).length], [1, 0]);
  });
});
