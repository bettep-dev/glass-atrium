// Side-by-side layout atoms: ratio-preset split rows (xl and up) and the tile-internal two-column slot (below xl).
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
// top-level consts stay out of the vm context — read the exported map off window.UI.
const ratios = (ui.UI as Record<string, unknown>).SPLIT_ROW_RATIOS as Record<string, string>;
const layouts = (ui.UI as Record<string, unknown>).SPLIT_ROW_LAYOUTS as Record<string, string>;

function render(name: string, props: Record<string, unknown>, ...children: unknown[]): RenderedNode {
  return renderScreen(React.createElement(ui[name] as Component, props, ...children)) as RenderedNode;
}

const classesOf = (n: RenderedNode) => String(n.props.className ?? "").split(/\s+/);

describe("split row ratio presets", () => {
  for (const [ratio, modifier] of Object.entries(ratios)) {
    test(`${ratio} renders its modifier`, () => {
      const row = findNodes(render("SplitRow", { ratio }, "a", "b"), (n) => classesOf(n).includes("split-row"))[0];
      assert.ok(classesOf(row).includes(`split-row--${modifier}`));
    });
  }

  test("the four presets the plan names are all offered", () => {
    assert.deepEqual(Object.keys(ratios).sort(), ["1:1", "2:1", "3:2", "7:5"]);
  });

  test("an unknown ratio falls back to the even split rather than a missing modifier", () => {
    const row = findNodes(render("SplitRow", { ratio: "9:1" }, "a"), (n) => classesOf(n).includes("split-row"))[0];
    assert.ok(classesOf(row).includes(`split-row--${ratios["1:1"]}`));
  });

  test("columns keep their reading order", () => {
    assert.equal(collectText(render("SplitRow", {}, "first", "second")).replace(/\s+/g, ""), "firstsecond");
  });
});

describe("split row layout variants", () => {
  const rowOf = (props: Record<string, unknown>) =>
    findNodes(render("SplitRow", props, "a", "b"), (n) => classesOf(n).includes("split-row"))[0];

  for (const [layout, modifier] of Object.entries(layouts)) {
    test(`${layout} renders its modifier beside the ratio modifier`, () => {
      const classes = classesOf(rowOf({ ratio: "3:2", layout }));
      assert.ok(classes.includes(`split-row--${modifier}`));
      assert.ok(classes.includes(`split-row--${ratios["3:2"]}`));
    });
  }

  test("content-sized is the default, so a short card never stretches unasked", () => {
    assert.ok(classesOf(rowOf({})).includes(`split-row--${layouts.content}`));
  });

  test("an unknown layout falls back to content-sized rather than a missing modifier", () => {
    assert.ok(classesOf(rowOf({ layout: "masonry" })).includes(`split-row--${layouts.content}`));
  });
});

describe("split column stack", () => {
  test("a column stack renders its cards in order inside one column", () => {
    const tree = render("SplitColumn", {}, "first", "second", "third");
    const columns = findNodes(tree, (n) => classesOf(n).includes("split-col"));
    assert.equal(columns.length, 1);
    assert.equal(collectText(columns[0]).replace(/\s+/g, ""), "firstsecondthird");
  });

  test("only a rail column carries the sticky rail modifier", () => {
    const railOf = (props: Record<string, unknown>) =>
      findNodes(render("SplitColumn", props, "x"), (n) => classesOf(n).includes("split-col--rail")).length;
    assert.equal(railOf({ isRail: true }), 1);
    assert.equal(railOf({}), 0);
  });
});

describe("tile split", () => {
  test("the value side reads before the detail side", () => {
    const tree = render("TileSplit", { lead: "42", detail: "since 09:00" });
    assert.equal(collectText(tree).replace(/\s+/g, ""), "42since09:00");
    assert.equal(findNodes(tree, (n) => classesOf(n).includes("tile-split-detail")).length, 1);
  });

  test("with no detail the tile renders no empty second column", () => {
    const tree = render("TileSplit", { lead: "42" });
    assert.equal(findNodes(tree, (n) => classesOf(n).includes("tile-split-detail")).length, 0);
  });
});
