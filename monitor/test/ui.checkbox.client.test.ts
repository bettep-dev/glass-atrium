// The one shared checkbox atom: its mark per state, the DOM's mixed state, the 24 hit area and its row-control form, on theme tokens.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadScreenModule } from "./lib/render-screen.js";
import { getCssRules } from "./lib/css-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ui = await loadScreenModule(resolve(__dirname, "../public/src/ui.jsx"));
const BASE_CSS = readFileSync(resolve(__dirname, "../public/styles/base.css"), "utf8");

interface Element { type: unknown; props: Record<string, unknown> }

// the atom's own element, before render → the Icon children keep their names
const render = (props: Record<string, unknown>) =>
  (ui.Checkbox as (props: Record<string, unknown>) => Element)({ onChange: () => undefined, ariaLabel: "Select Plan", ...props });
const childrenOf = (tree: Element) => [tree.props.children].flat(2).filter(Boolean) as Element[];
const inputOf = (tree: Element): Element => {
  const input = childrenOf(tree).find((child) => child.type === "input");
  assert.ok(input, "the hit area holds the input");
  return input;
};

describe("Checkbox", () => {
  const states = [
    { name: "unticked draws no mark", props: { isChecked: false }, marks: [] },
    { name: "ticked draws a check", props: { isChecked: true }, marks: ["check"] },
    { name: "mixed draws a dash", props: { isChecked: false, isMixed: true }, marks: ["minus"] },
  ];
  for (const row of states) {
    test(`${row.name}, on the token-drawn box with no transition`, () => {
      const tree = render(row.props);
      const marks = childrenOf(tree).filter((child) => child.type === ui.Icon);
      assert.deepEqual(marks.map((mark) => mark.props.name), row.marks);
      for (const mark of marks) assert.match(String(mark.props.className), /\bctl-checkbox-mark\b/);
      const input = inputOf(tree);
      assert.deepEqual([input.props.type, input.props.className, input.props.checked], ["checkbox", "ctl-checkbox", row.props.isChecked]);
    });
  }

  test("the mixed state reaches the DOM as indeterminate, which no attribute can set", () => {
    for (const isMixed of [true, false]) {
      const element = { indeterminate: !isMixed };
      (inputOf(render({ isMixed })).props.ref as (el: unknown) => void)(element);
      assert.equal(element.indeterminate, isMixed);
    }
  });

  test("the box's hit area is a label, or a span inside a label the caller already draws, never a nested label", () => {
    const hitOf = (isInLabel: boolean) => {
      const tree = render({ isInLabel });
      inputOf(tree);
      return [tree.type, String(tree.props.className).split(" ").includes("inline-target")];
    };
    assert.deepEqual([hitOf(false), hitOf(true)], [["label", true], ["span", true]]);
  });

  test("names reach assistive technology, and a row control leaves the tab order for the row's arrows", () => {
    const plain = inputOf(render({ describedBy: "hint" })).props;
    const control = inputOf(render({ isRowControl: true })).props;
    assert.deepEqual([plain["aria-label"], plain["aria-describedby"], plain["data-row-control"], plain.tabIndex], ["Select Plan", "hint", undefined, undefined]);
    assert.deepEqual([control["data-row-control"], control.tabIndex], ["", -1]);
  });

  test("the box is neutral at rest and takes the one selected state when ticked or mixed", () => {
    const rules = new Map(getCssRules(BASE_CSS.replace(/\/\*[\s\S]*?\*\//g, "")));
    assert.match(rules.get(".ctl-checkbox") ?? "", /background\s*:\s*rgb\(var\(--elev\)\)/);
    assert.match(rules.get(".ctl-checkbox") ?? "", /border\s*:\s*1\.5px solid rgb\(var\(--faint\)\)/);
    for (const selected of [".ctl-checkbox:checked", ".ctl-checkbox:indeterminate"]) {
      assert.match(rules.get(selected) ?? "", /background\s*:\s*rgb\(var\(--selected-fill\)\)/, selected);
    }
    assert.match(rules.get(".ctl-checkbox-mark") ?? "", /color\s*:\s*rgb\(var\(--selected-ink\)\)/);
  });
});
