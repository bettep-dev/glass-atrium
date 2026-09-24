// Shared agent-name display atom (plan 39859 S4a): short form on screen, full name for AT and hover.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;

const ui = await loadScreenModule(UI_SRC);
const React = ui.React as { createElement: (t: unknown, p: unknown) => unknown };
const getAgentDisplayName = ui.getAgentDisplayName as (name: unknown) => string;

const PREFIX = "glass-atrium-";
const PREFIXED = ["glass-atrium-dev-react", "glass-atrium-intel-planner", "glass-atrium-qa-code-reviewer"];
const UNPREFIXED = ["writer", "main", "dev-react", "my-glass-atrium-tool", "glass-atrium"];

function renderName(name: unknown): RenderedNode {
  return renderScreen(React.createElement(ui.AgentName as Component, { name })) as RenderedNode;
}

function titles(tree: RenderedNode): unknown[] {
  return findNodes(tree, (n) => n.props.title !== undefined).map((n) => n.props.title);
}

function visibleText(tree: RenderedNode): string {
  const hidden = findNodes(tree, (n) => n.props["aria-hidden"] === "true");
  return hidden.length ? collectText(hidden[0]).trim() : collectText(tree).trim();
}

test("display form drops exactly the leading prefix and round-trips back to the full name", () => {
  for (const name of PREFIXED) {
    const short = getAgentDisplayName(name);
    assert.ok(!short.startsWith(PREFIX), short);
    assert.equal(PREFIX + short, name);
  }
});

test("names without the leading prefix, or with nothing after it, keep their full form", () => {
  for (const name of [...UNPREFIXED, PREFIX]) {
    assert.equal(getAgentDisplayName(name), name);
  }
});

test("a missing name renders the shared absent dash, never an empty string", () => {
  for (const name of [undefined, null, "", "   "]) {
    assert.equal(getAgentDisplayName(name), "—", JSON.stringify(name));
  }
});

test("the atom shows the short form while hover and screen readers get the full name", () => {
  for (const name of PREFIXED) {
    const tree = renderName(name);
    const srOnly = findNodes(tree, (n) => String(n.props.className ?? "").includes("sr-only"));
    assert.equal(visibleText(tree), getAgentDisplayName(name));
    assert.deepEqual(titles(tree), [name]);
    assert.equal(srOnly.length, 1);
    assert.equal(collectText(srOnly[0]).trim(), name);
  }
});

test("an unshortened name renders once, with no duplicate screen-reader copy or redundant title", () => {
  for (const name of UNPREFIXED) {
    const tree = renderName(name);
    assert.equal(collectText(tree).trim(), name);
    assert.equal(findNodes(tree, (n) => String(n.props.className ?? "").includes("sr-only")).length, 0);
    assert.deepEqual(titles(tree), []);
  }
});
