// Shared disclosure rule: status cards start open, detail folds start collapsed and open themselves on warn/crit.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, createReactStub, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;
type SetState = (next: unknown) => void;

// Slot-persistent hooks so a component keeps its state across renders and runs effects on dep change.
function createHookRuntime() {
  let slots: unknown[] = [];
  let pending: Array<() => void> = [];
  let cursor = 0;

  const react = {
    ...createReactStub(),
    useState: (initial: unknown) => {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      const setState: SetState = (next) => {
        slots[slot] = typeof next === "function" ? (next as (prev: unknown) => unknown)(slots[slot]) : next;
      };
      return [slots[slot], setState];
    },
    useRef: (initial: unknown) => {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot];
    },
    useEffect: (effect: () => void, deps?: unknown[]) => {
      const slot = cursor++;
      const prev = slots[slot] as unknown[] | undefined;
      if (!prev || !deps || deps.some((dep, i) => !Object.is(dep, prev[i]))) {
        slots[slot] = deps;
        pending.push(effect);
      }
    },
  };

  const renderOnce = (element: unknown) => {
    cursor = 0;
    const tree = renderScreen(element) as RenderedNode;
    const effects = pending.splice(0);
    effects.forEach((effect) => effect());
    return { tree, hasEffects: effects.length > 0 };
  };

  // Render, flush effects, and re-render once so effect-driven state is visible.
  const render = (element: unknown): RenderedNode => {
    const first = renderOnce(element);
    return first.hasEffects ? renderOnce(element).tree : first.tree;
  };

  // ui.jsx destructures its hooks once at load → one runtime per module, reset per test.
  const reset = () => {
    slots = [];
    pending = [];
  };

  return { react, render, reset };
}

const runtime = createHookRuntime();
const ui = await loadScreenModule(UI_SRC, { React: runtime.react });
const h = (runtime.react as Record<string, unknown>).createElement as (t: unknown, p: unknown, ...c: unknown[]) => unknown;

// A fresh component instance: cleared hook state, then renders of successive props.
function mountDisclosure() {
  runtime.reset();
  return (props: Record<string, unknown>) => runtime.render(h(ui.Disclosure as Component, props, "body text"));
}

const triggerOf = (tree: RenderedNode) => findNodes(tree, (n) => n.type === "button")[0];
const bodyOf = (tree: RenderedNode) => findNodes(tree, (n) => n.type === "div" && typeof n.props.id === "string")[0];

describe("initial open state follows the status/detail rule", () => {
  const rows = [
    { name: "a status card starts open with no tone", kind: "status", tone: undefined, isOpen: true },
    { name: "a status card starts open when ok", kind: "status", tone: "ok", isOpen: true },
    { name: "a status card starts open when crit", kind: "status", tone: "crit", isOpen: true },
    { name: "a detail fold starts collapsed with no tone", kind: "detail", tone: undefined, isOpen: false },
    { name: "a detail fold starts collapsed when ok", kind: "detail", tone: "ok", isOpen: false },
    { name: "a detail fold starts collapsed when info", kind: "detail", tone: "info", isOpen: false },
    { name: "a detail fold starts open when it holds a warn item", kind: "detail", tone: "warn", isOpen: true },
    { name: "a detail fold starts open when it holds a crit item", kind: "detail", tone: "crit", isOpen: true },
  ];

  for (const row of rows) {
    test(row.name, () => {
      assert.equal((ui.getDisclosureOpen as (k: string, t?: string) => boolean)(row.kind, row.tone), row.isOpen);
      const tree = mountDisclosure()({ kind: row.kind, tone: row.tone, title: "Card" });
      assert.equal(triggerOf(tree).props["aria-expanded"], row.isOpen);
      assert.equal(bodyOf(tree) !== undefined, row.isOpen, "the body is mounted only when open");
    });
  }
});

test("the open trigger controls the mounted body and the collapsed trigger points nowhere", () => {
  const open = mountDisclosure()({ kind: "status", title: "Card" });
  assert.equal(triggerOf(open).props["aria-controls"], bodyOf(open).props.id);
  assert.ok(collectText(bodyOf(open)).includes("body text"));

  const closed = mountDisclosure()({ kind: "detail", title: "Card" });
  assert.equal(triggerOf(closed).props["aria-controls"], undefined);
});

test("a collapsed detail fold opens itself when its content escalates to crit", () => {
  const render = mountDisclosure();
  assert.equal(triggerOf(render({ kind: "detail", tone: "ok", title: "History" })).props["aria-expanded"], false);
  assert.equal(triggerOf(render({ kind: "detail", tone: "crit", title: "History" })).props["aria-expanded"], true);
});

test("the trigger toggles the fold, and a user collapse survives an unchanged alert tone", () => {
  const render = mountDisclosure();
  const props = { kind: "detail", tone: "warn", title: "History" };
  const tree = render(props);
  (triggerOf(tree).props.onClick as () => void)();
  assert.equal(triggerOf(render(props)).props["aria-expanded"], false);
});

test("a fold opened on alert stays open when the tone recovers", () => {
  const render = mountDisclosure();
  render({ kind: "detail", tone: "crit", title: "History" });
  assert.equal(triggerOf(render({ kind: "detail", tone: "ok", title: "History" })).props["aria-expanded"], true);
});
