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
