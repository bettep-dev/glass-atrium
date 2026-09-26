// Page verdict line and low-sample marker: tone always travels with a word, small samples always say their n.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, createFakeDocument, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;
type CreateElement = (type: unknown, props: unknown, ...children: unknown[]) => unknown;

const doc = createFakeDocument();
const ui = await loadScreenModule(UI_SRC, { document: doc });
const h = (ui.React as { createElement: CreateElement }).createElement;
// top-level consts stay off the sandbox context → read them through the window.UI export.
const exported = ui.UI as Record<string, unknown>;
const TONE_GLYPH = exported.TONE_GLYPH as Record<string, string>;
const LOW_N_MIN = exported.LOW_N_MIN as number;

// the verdict's own root div — renderScreen wraps it in a node carrying the component's props.
function renderVerdict(props: Record<string, unknown>, sentence = "Spend is on track."): RenderedNode {
  const tree = renderScreen(h(ui.PageVerdict as Component, props, sentence)) as RenderedNode;
  return tree.children[0] as RenderedNode;
}

function getToneParts(tree: RenderedNode) {
  const tone = findNodes(tree, (n: RenderedNode) => n.props.className === "page-verdict-tone")[0];
  const glyph = findNodes(tone, (n: RenderedNode) => n.props["aria-hidden"] === "true")[0];
  const word = collectText(tone).replace(collectText(glyph), "").trim();
  return { glyph: collectText(glyph), word };
}

describe("PageVerdict", () => {
  for (const tone of ["ok", "warn", "crit", "info", "neutral"]) {
    test(`a ${tone} verdict pairs the canonical glyph with a visible word, never colour alone`, () => {
      const tree = renderVerdict({ tone });
      const parts = getToneParts(tree);

      assert.equal(parts.glyph, TONE_GLYPH[tone]);
      assert.ok(parts.word.length > 0, "a word names the tone");
      assert.match(String(tree.props.className), new RegExp(`page-verdict--${tone}\\b`));
    });
  }

  test("a caller label replaces the default word and the sentence follows it", () => {
    const tree = renderVerdict({ tone: "crit", label: "3 daemons down" }, "Restart the monitor daemon first.");

    assert.equal(getToneParts(tree).word, "3 daemons down");
    assert.match(collectText(tree), /Restart the monitor daemon first\./);
  });

  test("an unknown tone reads as neutral instead of borrowing a colour", () => {
    const tree = renderVerdict({ tone: "bogus" });

    assert.equal(getToneParts(tree).glyph, TONE_GLYPH.neutral);
    assert.match(String(tree.props.className), /page-verdict--neutral\b/);
  });

  test("a chip with href drills to another view as a link", () => {
    const tree = renderVerdict({ tone: "warn", chips: [{ label: "Open budgets", href: "#/model-config" }] });
    const links = findNodes(tree, (n: RenderedNode) => n.type === "a");

    assert.equal(links.length, 1);
    assert.equal(links[0].props.href, "#/model-config");
  });

  test("a chip with targetId scrolls to its card and moves focus there, making the card focusable", () => {
    const calls: string[] = [];
    const attributes = new Map<string, string>();
    const card = {
      hasAttribute: (name: string) => attributes.has(name),
      setAttribute: (name: string, value: string) => { attributes.set(name, value); },
      scrollIntoView: () => { calls.push("scroll"); },
      focus: () => { calls.push("focus"); },
    };
    doc.reset();
    doc.elements.set("cost-burn", card);
    const tree = renderVerdict({ tone: "warn", chips: [{ label: "Burn rate", targetId: "cost-burn" }] });
    const button = findNodes(tree, (n: RenderedNode) => n.type === "button")[0];

    (button.props.onClick as () => void)();

    assert.deepEqual(calls, ["scroll", "focus"]);
    assert.equal(attributes.get("tabindex"), "-1");
  });
});

describe("LowSampleMark", () => {
  const isLowSample = ui.isLowSample as (n: unknown) => boolean;
  const rows = [
    { name: "one below the threshold", n: LOW_N_MIN - 1, expected: true },
    { name: "an empty sample", n: 0, expected: true },
    { name: "exactly the threshold", n: LOW_N_MIN, expected: false },
    { name: "a missing count", n: undefined, expected: false },
    { name: "a non-numeric count", n: Number.NaN, expected: false },
  ];

  for (const row of rows) {
    test(`${row.name} ${row.expected ? "is" : "is not"} a low sample`, () => {
      assert.equal(isLowSample(row.n), row.expected);
    });
  }

  test("a low sample names its n and a trustworthy one renders nothing", () => {
    const low = renderScreen(h(ui.LowSampleMark as Component, { n: 12 }));
    const enough = renderScreen(h(ui.LowSampleMark as Component, { n: LOW_N_MIN }));

    assert.equal(collectText(low).replace(/\s+/g, ""), "(n=12)");
    assert.equal(collectText(enough), "");
  });
});
