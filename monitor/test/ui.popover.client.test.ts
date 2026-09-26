// Popover: a non-modal panel under its trigger — Esc and outside press close it, focus comes back only when it was lost.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createEffectReact, createFakeDocument, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;
type CreateElement = (type: unknown, props: unknown, ...children: unknown[]) => unknown;

const effects = createEffectReact();
const doc = createFakeDocument();
const ui = await loadScreenModule(UI_SRC, { React: effects.react, document: doc });
const h = (ui.React as { createElement: CreateElement }).createElement;

interface FakeElement {
  name: string;
  inert: boolean;
  focus: () => void;
  contains: (node: unknown) => boolean;
  querySelectorAll: () => FakeElement[];
}

function createElement(name: string, inside: FakeElement[] = []): FakeElement {
  const element: FakeElement = {
    name,
    inert: false,
    focus: () => { doc.activeElement = element; },
    contains: (node) => node === element || inside.some((child) => child.contains(node)),
    querySelectorAll: () => inside,
  };
  return element;
}

function mountPanel(onClose: () => void) {
  const trigger = createElement("trigger");
  const firstControl = createElement("first-control");
  const panel = createElement("panel", [firstControl]);
  const root = createElement("root", [trigger, panel]);
  const neighbour = createElement("neighbour");
  const focused: string[] = [];
  trigger.focus = () => { focused.push("trigger"); doc.activeElement = trigger; };
  doc.reset();
  doc.activeElement = trigger;

  const mounted = effects.mount(
    () => (ui.PopoverPanel as Component)({ id: "filters", title: "Filters", rootRef: { current: root }, onClose, children: "fields" }),
    () => panel,
  );
  return { ...mounted, trigger, firstControl, panel, neighbour, focused };
}

describe("Popover trigger", () => {
  test("the closed trigger announces a dialog popup and its collapsed state, with no panel rendered", () => {
    const tree = renderScreen(h(ui.Popover as Component, { label: "Filters" }, "fields")) as RenderedNode;
    const buttons = findNodes(tree, (n: RenderedNode) => n.type === "button");

    assert.equal(buttons.length, 1);
    assert.equal(buttons[0].props["aria-expanded"], false);
    assert.equal(buttons[0].props["aria-haspopup"], "dialog");
    assert.equal(findNodes(tree, (n: RenderedNode) => n.props.role === "dialog").length, 0);
  });
});

describe("PopoverPanel", () => {
  test("stays non-modal: no aria-modal, no scroll lock, the page beside it untouched", () => {
    const popover = mountPanel(() => undefined);
    const dialog = findNodes(renderScreen(popover.tree) as RenderedNode, (n: RenderedNode) => n.props.role === "dialog")[0];

    assert.equal(dialog.props["aria-label"], "Filters");
    assert.equal(dialog.props["aria-modal"], undefined);
    assert.equal(doc.body.style.overflow, "auto");
    assert.equal(popover.neighbour.inert, false);
    popover.unmount();
  });

  test("opening moves focus to the first control inside the panel", () => {
    const popover = mountPanel(() => undefined);

    assert.equal(doc.activeElement, popover.firstControl);
    popover.unmount();
  });

  test("Esc closes it", () => {
    let closes = 0;
    const popover = mountPanel(() => { closes += 1; });

    doc.dispatch("keydown", { key: "Escape" });
    popover.unmount();

    assert.equal(closes, 1);
  });

  const pressRows = [
    { name: "a press outside the popover closes it", target: "neighbour", closes: 1 },
    { name: "a press inside the panel keeps it open", target: "firstControl", closes: 0 },
    { name: "a press on the trigger leaves the toggle to the trigger's own click", target: "trigger", closes: 0 },
  ] as const;

  for (const row of pressRows) {
    test(row.name, () => {
      let closes = 0;
      const popover = mountPanel(() => { closes += 1; });

      doc.dispatch("pointerdown", { target: popover[row.target] });
      popover.unmount();

      assert.equal(closes, row.closes);
    });
  }

  const focusRows = [
    { name: "focus dropped with the closed panel returns to the trigger", activeAtClose: "body", focused: ["trigger"] },
    { name: "focus still inside the closing panel returns to the trigger", activeAtClose: "firstControl", focused: ["trigger"] },
    { name: "a control an outside press focused keeps its focus", activeAtClose: "neighbour", focused: [] },
  ] as const;

  for (const row of focusRows) {
    test(row.name, () => {
      const popover = mountPanel(() => undefined);

      doc.activeElement = row.activeAtClose === "body" ? doc.body : popover[row.activeAtClose];
      popover.unmount();

      assert.deepEqual(popover.focused, row.focused);
    });
  }
});
