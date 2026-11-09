// Display atoms: the two empty states, the page header's one-line slots and the pagination bar.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;

const ui = await loadScreenModule(UI_SRC);
const React = ui.React as { createElement: (t: unknown, p: unknown, ...c: unknown[]) => unknown };

function render(name: string, props: Record<string, unknown>): RenderedNode {
  return renderScreen(React.createElement(ui[name] as Component, props)) as RenderedNode;
}

const getButtons = (tree: RenderedNode) => findNodes(tree, (n) => n.type === "button");
const getButton = (tree: RenderedNode, name: string) =>
  getButtons(tree).find((n) => n.props["aria-label"] === name || collectText(n).trim() === name) as RenderedNode;
const press = (button: RenderedNode) => (button.props.onClick as (e: unknown) => void)({});

describe("empty state kinds", () => {
  test("a first-use state keeps the caller's message and hint and offers no reset", () => {
    const tree = render("EmptyState", { message: "No runs yet", hint: "the wiki compiles nightly at 04:30" });
    const text = collectText(tree);
    assert.match(text, /No runs yet/);
    assert.match(text, /compiles nightly/);
    assert.equal(getButtons(tree).length, 0);
  });

  test("a no-results state reads the fixed sentence whatever message the caller passed, and its reset calls back", () => {
    const resets: number[] = [];
    const tree = render("EmptyState", { kind: "no-results", message: "Nothing for agent x", onReset: () => resets.push(1) });
    assert.match(collectText(tree), /No records match these filters\./);
    assert.doesNotMatch(collectText(tree), /Nothing for agent x/);
    press(getButton(tree, "Reset filters"));
    assert.equal(resets.length, 1);
  });

  test("a no-results state with no reset handler offers no dead button", () => {
    assert.equal(getButtons(render("EmptyState", { kind: "no-results" })).length, 0);
  });
});

describe("page header slots", () => {
  test("back link, title and status read before the right group, and the primary is the last control", () => {
    const tree = render("PageHeader", {
      title: "Run 42",
      back: React.createElement("a", { href: "#/runs" }, "Runs"),
      status: React.createElement("span", { "data-slot": "status" }, "Done"),
      refresh: React.createElement("button", { type: "button" }, "Refresh"),
      primary: React.createElement("button", { type: "button" }, "Approve"),
    });
    const order = collectText(tree).split(/\s+/).filter(Boolean);
    const at = (word: string) => order.indexOf(word);
    assert.ok(at("Runs") < at("Run") && at("42") < at("Done") && at("Done") < at("Refresh") && at("Refresh") < at("Approve"), order.join(" "));
  });

  test("a header with only a title renders no empty right group", () => {
    assert.equal(findNodes(render("PageHeader", { title: "Runs" }), (n) => String(n.props.className ?? "").includes("page-head-cluster")).length, 0);
  });
});

describe("pagination", () => {
  const rows = [
    { name: "first page", page: 0, pageSize: 20, total: 1284, range: "1–20 of 1,284" },
    { name: "middle page", page: 3, pageSize: 20, total: 1284, range: "61–80 of 1,284" },
    { name: "short last page ends at the total", page: 64, pageSize: 20, total: 1284, range: "1,281–1,284 of 1,284" },
  ];
  for (const row of rows) {
    test(`the range covers exactly the page's rows: ${row.name}`, () => {
      const tree = render("Pagination", { page: row.page, pageSize: row.pageSize, total: row.total, onPageChange: () => {} });
      assert.match(collectText(tree), new RegExp(row.range));
    });
  }

  test("Previous and Next step one page, and each is inert yet focusable at its end", () => {
    const calls: number[] = [];
    const onPageChange = (next: number) => calls.push(next);
    const first = render("Pagination", { page: 0, pageSize: 20, total: 50, onPageChange });
    const last = render("Pagination", { page: 2, pageSize: 20, total: 50, onPageChange });
    press(getButton(first, "Previous page"));
    press(getButton(last, "Next page"));
    press(getButton(first, "Next page"));
    press(getButton(last, "Previous page"));
    assert.deepEqual(calls, [1, 1]);
    assert.equal(getButton(first, "Previous page").props["aria-disabled"], "true");
    assert.equal(getButton(last, "Next page").props["aria-disabled"], "true");
    assert.equal(getButton(first, "Previous page").props.disabled, undefined);
  });

  test("the current page is marked for assistive tech with its number", () => {
    const current = findNodes(render("Pagination", { page: 3, pageSize: 20, total: 1284, onPageChange: () => {} }), (n) => n.props["aria-current"] === "page");
    assert.equal(current.length, 1);
    assert.match(collectText(current[0]), /Page\s*4\s*of 65/);
  });

  test("an empty result renders no pagination", () => {
    const tree = render("Pagination", { page: 0, pageSize: 20, total: 0, onPageChange: () => {} });
    assert.equal(findNodes(tree, (n) => n.type === "nav" || n.type === "button").length, 0);
  });
});
