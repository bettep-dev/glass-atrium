// Side-by-side layout atoms: ratio-preset split rows (xl and up) and the tile-internal two-column slot (below xl).
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const BASE_CSS = readFileSync(resolve(__dirname, "../public/styles/base.css"), "utf8");

type Component = (props: Record<string, unknown>) => unknown;

const ui = await loadScreenModule(UI_SRC);
const React = ui.React as { createElement: (t: unknown, p: unknown, ...c: unknown[]) => unknown };
// top-level consts stay out of the vm context — read the exported map off window.UI.
const ratios = (ui.UI as Record<string, unknown>).SPLIT_ROW_RATIOS as Record<string, string>;

function render(name: string, props: Record<string, unknown>, ...children: unknown[]): RenderedNode {
  return renderScreen(React.createElement(ui[name] as Component, props, ...children)) as RenderedNode;
}

const classesOf = (n: RenderedNode) => String(n.props.className ?? "").split(/\s+/);

// The xl media block — the only place a split row may leave its stacked single column.
function getXlBlock(css: string): string {
  const start = css.indexOf("@media (min-width: 1280px)");
  assert.ok(start >= 0, "base.css declares an xl block");
  return css.slice(start, css.indexOf("\n}", start));
}

describe("split row ratio presets", () => {
  for (const [ratio, modifier] of Object.entries(ratios)) {
    test(`${ratio} renders its modifier and base.css sets two columns for it only at xl`, () => {
      const row = findNodes(render("SplitRow", { ratio }, "a", "b"), (n) => classesOf(n).includes("split-row"))[0];
      assert.ok(classesOf(row).includes(`split-row--${modifier}`));
      assert.match(getXlBlock(BASE_CSS), new RegExp(`\\.split-row--${modifier}\\s*\\{[^}]*grid-template-columns`));
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

  test("base.css splits the tile into two columns below xl and never inside the xl block", () => {
    assert.match(BASE_CSS, /@media \(min-width: 641px\) and \(max-width: 1279px\)\s*\{[^}]*\.tile-split\s*\{[^}]*grid-template-columns/);
    assert.doesNotMatch(getXlBlock(BASE_CSS), /\.tile-split\b/);
  });
});
