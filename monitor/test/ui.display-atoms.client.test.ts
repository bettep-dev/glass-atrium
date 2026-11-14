// Display atoms: the two empty states, the page header's one-line slots, the pagination bar and the stat row.
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
    { name: "a page past the end after the total shrank reads the last page", page: 70, pageSize: 20, total: 1284, range: "1,281–1,284 of 1,284" },
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

  test("a page past the end steps from the last page: Next is inert and Previous lands one before it", () => {
    const calls: number[] = [];
    const past = render("Pagination", { page: 70, pageSize: 20, total: 50, onPageChange: (next: number) => calls.push(next) });
    press(getButton(past, "Next page"));
    press(getButton(past, "Previous page"));
    assert.deepEqual(calls, [1]);
    assert.equal(getButton(past, "Next page").props["aria-disabled"], "true");
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

describe("stat row", () => {
  const getTerms = (tree: RenderedNode) => findNodes(tree, (n) => n.type === "dt").map((n) => collectText(n).trim());
  const getValues = (tree: RenderedNode) => findNodes(tree, (n) => n.type === "dd" && /\bstat-value\b/.test(String(n.props.className)));

  test("each stat pairs its label term with its value and unit, in the caller's order", () => {
    const tree = render("StatRow", { stats: [
      { label: "Spend", value: "$41.20", context: "last 7 days" },
      { label: "Runs", value: "1,284" },
      { label: "Median run", value: "38", unit: "s" },
    ] });
    assert.equal(findNodes(tree, (n) => n.type === "dl").length, 1);
    assert.deepEqual(getTerms(tree), ["Spend", "Runs", "Median run"]);
    assert.deepEqual(getValues(tree).map((n) => collectText(n).replace(/\s+/g, "")), ["$41.20", "1,284", "38s"]);
  });

  test("a context line renders only for the stat that has one", () => {
    const tree = render("StatRow", { stats: [{ label: "Spend", value: "$41.20", context: "last 7 days" }, { label: "Runs", value: "1,284" }] });
    const contexts = findNodes(tree, (n) => n.type === "dd" && /\bstat-context\b/.test(String(n.props.className)));
    assert.deepEqual(contexts.map((n) => collectText(n)), ["last 7 days"]);
  });

  test("only a stat with a drill-down target makes its value a link to that target", () => {
    const tree = render("StatRow", { stats: [{ label: "Failed", value: "3", href: "#/outcomes?result=fail" }, { label: "Runs", value: "1,284" }] });
    const links = findNodes(tree, (n) => n.type === "a");
    assert.equal(links.length, 1);
    assert.equal(links[0].props.href, "#/outcomes?result=fail");
    assert.match(collectText(links[0]), /^3/);
    assert.equal(findNodes(tree, (n) => n.type === "button").length, 0);
  });

  const valueRows = [
    { name: "zero is a real value", value: 0, text: "0" },
    { name: "null reads None", value: null, text: "None" },
    { name: "a missing value reads None", value: undefined, text: "None" },
  ];
  for (const row of valueRows) {
    test(`an absent value reads None, a present one as given: ${row.name}`, () => {
      const tree = render("StatRow", { stats: [{ label: "Runs", value: row.value }] });
      assert.equal(collectText(getValues(tree)[0]).trim(), row.text);
    });
  }

  test("an unread value reads Not loaded in faint ink, never None", () => {
    const tree = render("StatRow", { stats: [{ label: "Spend", value: null, absent: "not-loaded", context: "Cost read failed" }] });
    const value = getValues(tree)[0];
    assert.equal(collectText(value).trim(), "Not loaded");
    assert.ok(findNodes(value, (n) => /\btext-faint\b/.test(String(n.props.className))).length > 0, "faint ink");
  });
});

describe("absent value", () => {
  const rows = [
    { name: "an empty value", kind: "none", text: "None" },
    { name: "an unread value", kind: "not-loaded", text: "Not loaded" },
    { name: "a value whose caller names no kind is not claimed empty", kind: undefined, text: "Not loaded" },
  ];
  for (const row of rows) {
    test(`each kind of nothing has its own words, in faint ink with the cause on hover: ${row.name}`, () => {
      const tree = render("AbsentValue", { kind: row.kind, title: "Outcomes read failed" });
      const span = findNodes(tree, (n) => n.type === "span")[0];
      assert.equal(collectText(span).trim(), row.text);
      assert.match(String(span.props.className), /\btext-faint\b/);
      assert.equal(span.props.title, "Outcomes read failed");
    });
  }
});
