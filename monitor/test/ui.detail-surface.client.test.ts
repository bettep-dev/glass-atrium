// DetailSurface dialog naming: every variant announces its title, and an element title never lands in aria-label.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;
type CreateElement = (type: unknown, props: unknown, ...children: unknown[]) => unknown;

const ui = await loadScreenModule(UI_SRC);
const h = (ui.React as { createElement: CreateElement }).createElement;

function renderSurface(props: Record<string, unknown>): RenderedNode {
  const tree = renderScreen(h(ui.DetailSurface as Component, { open: true, onClose: () => undefined, ...props }, "body"));
  assert.ok(tree && typeof tree !== "string", "DetailSurface rendered");
  return tree;
}

function getDialog(tree: RenderedNode): RenderedNode {
  const dialogs = findNodes(tree, (n: RenderedNode) => n.props.role === "dialog");
  assert.equal(dialogs.length, 1, "one dialog node");
  return dialogs[0];
}

// Resolves the name the way assistive tech does: aria-labelledby ids (each must resolve once) win over aria-label.
function getAccessibleName(tree: RenderedNode): string | undefined {
  const dialog = getDialog(tree);
  const labelledBy = dialog.props["aria-labelledby"];
  if (typeof labelledBy !== "string") return dialog.props["aria-label"] as string | undefined;
  return labelledBy
    .split(/\s+/)
    .map((id) => {
      const targets = findNodes(tree, (n: RenderedNode) => n.props.id === id);
      assert.equal(targets.length, 1, `aria-labelledby id "${id}" resolves to exactly one rendered node`);
      return collectText(targets[0]).replace(/\s+/g, " ").trim();
    })
    .join(" ");
}

const elementTitle = () => h("span", null, "Agent ", h("b", null, "alpha"));

describe("DetailSurface accessible name", () => {
  const rows = [
    { name: "string title on a drawer", props: { title: "Session cost" }, expected: "Session cost" },
    { name: "string title on a bare fullscreen surface", props: { title: "Doc viewer", bare: true, variant: "fullscreen" }, expected: "Doc viewer" },
    { name: "string title on a confirm dialog", props: { title: "Delete agent?", variant: "confirm" }, expected: "Delete agent?" },
    { name: "element title on a drawer", props: { title: elementTitle() }, expected: "Agent alpha" },
    { name: "element title on a bare surface", props: { title: elementTitle(), bare: true, variant: "fullscreen" }, expected: "Agent alpha" },
    { name: "caller-supplied labelledBy", props: { title: "Node", labelledBy: "ar-node-detail-title" }, expected: "Node" },
  ];

  for (const row of rows) {
    test(`${row.name}: the dialog is named by the title text, never by a non-string aria-label`, () => {
      const tree = renderSurface(row.props);
      const label = getDialog(tree).props["aria-label"];

      assert.ok(label === undefined || typeof label === "string", `aria-label is a string or absent, got ${typeof label}`);
      assert.equal(getAccessibleName(tree), row.expected);
    });
  }

  test("a string title keeps aria-label and adds no labelledby indirection", () => {
    const dialog = getDialog(renderSurface({ title: "Session cost" }));

    assert.equal(dialog.props["aria-label"], "Session cost");
    assert.equal(dialog.props["aria-labelledby"], undefined);
  });

  test("two element-titled surfaces point their labelledby at distinct ids", () => {
    const first = getDialog(renderSurface({ title: elementTitle() })).props["aria-labelledby"];
    const second = getDialog(renderSurface({ title: elementTitle() })).props["aria-labelledby"];

    assert.equal(typeof first, "string");
    assert.notEqual(first, second);
  });
});

interface FakeNode {
  name: string;
  tagName: string;
  inert: boolean;
  parentElement: FakeNode | null;
  children: FakeNode[];
}

function createNode(name: string, children: FakeNode[] = [], inert = false): FakeNode {
  const node: FakeNode = { name, tagName: name.toUpperCase(), inert, parentElement: null, children };
  for (const child of children) child.parentElement = node;
  return node;
}

describe("DetailSurface focus containment", () => {
  type TrapArgs = { focusables: unknown[]; active: unknown; panel: unknown; shiftKey: boolean };
  const getTrapFocusTarget = ui.getTrapFocusTarget as (args: TrapArgs) => unknown;

  const first = { name: "close" };
  const middle = { name: "link" };
  const last = { name: "summary" };
  const outside = { name: "trigger" };
  const focusables = [first, middle, last];
  const panel = { name: "panel", contains: (node: unknown) => node === panel || focusables.includes(node as typeof first) };

  const rows = [
    { name: "opening moves focus to the first control", args: { focusables, active: null, shiftKey: false }, expected: first },
    { name: "opening a surface with no control focuses the panel itself", args: { focusables: [], active: null, shiftKey: false }, expected: panel },
    { name: "Tab in an empty panel keeps focus on the panel", args: { focusables: [], active: panel, shiftKey: false }, expected: panel },
    { name: "Tab from outside the panel pulls focus to the first control", args: { focusables, active: outside, shiftKey: false }, expected: first },
    { name: "Shift+Tab from outside the panel pulls focus to the last control", args: { focusables, active: outside, shiftKey: true }, expected: last },
    { name: "Tab from the focused panel enters at the first control", args: { focusables, active: panel, shiftKey: false }, expected: first },
    { name: "Tab from the last control wraps to the first", args: { focusables, active: last, shiftKey: false }, expected: first },
    { name: "Shift+Tab from the first control wraps to the last", args: { focusables, active: first, shiftKey: true }, expected: last },
    { name: "Tab between inner controls stays native", args: { focusables, active: middle, shiftKey: false }, expected: null },
  ];

  for (const row of rows) {
    test(`${row.name}`, () => {
      assert.equal(getTrapFocusTarget({ ...row.args, panel }), row.expected);
    });
  }

  test("the panel is focusable by script so an empty surface can still hold focus", () => {
    const dialog = getDialog(renderSurface({ title: "Doc viewer", bare: true, variant: "fullscreen" }));

    assert.equal(dialog.props.tabIndex, -1);
  });
});

describe("DetailSurface inert background", () => {
  const getInertTargets = ui.getInertTargets as (overlay: FakeNode) => FakeNode[];

  function buildPage() {
    const overlay = createNode("overlay");
    const list = createNode("list");
    const screen = createNode("screen", [list, overlay]);
    const nav = createNode("nav");
    const main = createNode("main", [nav, screen]);
    const sidebar = createNode("sidebar");
    const toast = createNode("toast", [], true);
    const body = createNode("body", [sidebar, main, toast]);
    const head = createNode("head");
    createNode("html", [head, body]);
    return { overlay, ancestors: [screen, main, body], background: [list, nav, sidebar], toast, head };
  }

  test("every sibling along the overlay's ancestor path up to body is marked, never an ancestor", () => {
    const page = buildPage();
    const names = Array.from(getInertTargets(page.overlay), (node) => node.name);

    assert.deepEqual(names.sort(), page.background.map((node) => node.name).sort());
    for (const ancestor of page.ancestors) assert.ok(!names.includes(ancestor.name), `${ancestor.name} stays live`);
  });

  test("a node already inert is left out so closing the surface does not revive it", () => {
    const page = buildPage();
    const targets = getInertTargets(page.overlay);

    assert.ok(!targets.includes(page.toast));
    assert.ok(!targets.includes(page.head), "the walk stops at body");
  });
});
