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

  test("only the even and the two-to-one spans are offered", () => {
    assert.deepEqual(Object.keys(ratios).sort(), ["1:1", "2:1"]);
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
      const classes = classesOf(rowOf({ ratio: "2:1", layout }));
      assert.ok(classes.includes(`split-row--${modifier}`));
      assert.ok(classes.includes(`split-row--${ratios["2:1"]}`));
    });
  }

  test("equal is the default, so peer cards end at one edge unless the row opts out", () => {
    assert.ok(classesOf(rowOf({})).includes(`split-row--${layouts.equal}`));
  });

  test("an unknown layout falls back to equal rather than a missing modifier", () => {
    assert.ok(classesOf(rowOf({ layout: "masonry" })).includes(`split-row--${layouts.equal}`));
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

// useState stub whose state starts at `state` and records every setter call → open/closed states without a DOM
function loadWithState(state: unknown) {
  const calls: unknown[] = [];
  const react = { ...React, useState: () => [state, (next: unknown) => calls.push(next)] };
  return { calls, mod: loadScreenModule(UI_SRC, { React: react }) };
}

describe("card header", () => {
  const headOf = (props: Record<string, unknown>) => render("CardHead", props);

  test("title and meta share one header line rather than stacking", () => {
    const tree = headOf({ title: "Spend by model", sub: "last 7 days" });
    const [line] = findNodes(tree, (n) => classesOf(n).includes("card-head-text"));
    assert.ok(line, "a one-line text group");
    assert.equal(findNodes(line, (n) => n.type === "h2").length, 1);
    assert.equal(findNodes(line, (n) => classesOf(n).includes("card-sub")).length, 1);
  });

  test("an ellipsised text meta keeps its whole text in the hover title; a node meta sets none", () => {
    const rows = [
      { name: "text meta", sub: "1,234 · 10.3% of 11,352 records this window", title: "1,234 · 10.3% of 11,352 records this window" },
      { name: "node meta", sub: React.createElement("span", null, "3 sources"), title: undefined },
    ];
    for (const row of rows) {
      const [meta] = findNodes(headOf({ title: "Confident but failed", sub: row.sub }), (n) => classesOf(n).includes("card-sub"));
      assert.equal(meta?.props.title, row.title, row.name);
    }
  });

  test("the info trigger is a real button described by the card title", () => {
    const tree = headOf({ title: "Spend by model", info: "Counted once per model." });
    const [h2] = findNodes(tree, (n) => n.type === "h2");
    const [button] = findNodes(tree, (n) => n.type === "button");
    assert.ok(h2.props.id, "the title carries an id to be described by");
    assert.equal(button.props.type, "button");
    assert.equal(button.props["aria-describedby"], h2.props.id);
    assert.equal(button.props["aria-haspopup"], "dialog");
    assert.ok(String(button.props["aria-label"] ?? "").length > 0, "an accessible name");
    assert.equal(typeof button.props.onClick, "function", "opens on click and keyboard, not on hover");
  });

  test("a header with no info renders no trigger", () => {
    assert.equal(findNodes(headOf({ title: "Spend by model" }), (n) => n.type === "button").length, 0);
  });

  test("activating the trigger opens the drawer that holds the info text", async () => {
    const closed = loadWithState(false);
    const closedUi = await closed.mod;
    const create = (closedUi.React as typeof React).createElement;
    const closedTree = renderScreen(create(closedUi.CardHead as Component, { title: "Spend", info: "Counted once per model." })) as RenderedNode;
    assert.ok(!collectText(closedTree).includes("Counted once per model."), "closed → info stays off the page");
    (findNodes(closedTree, (n) => n.type === "button")[0].props.onClick as () => void)();
    assert.deepEqual(closed.calls, [true]);

    const openUi = await loadWithState(true).mod;
    const openTree = renderScreen(create(openUi.CardHead as Component, { title: "Spend", info: "Counted once per model." })) as RenderedNode;
    const [drawer] = findNodes(openTree, (n) => n.type === "DetailSurface");
    assert.ok(drawer, "open → a detail drawer");
    assert.ok(collectText(drawer).includes("Counted once per model."));
  });
});

describe("card slots", () => {
  const slots = (ui.UI as Record<string, unknown>).CARD_SLOTS as Record<string, { rowCount: number; plotPx: number }>;
  const getSlotRows = (ui.UI as Record<string, unknown>).getSlotRows as (items: unknown[], size?: string) => { rows: unknown[]; hiddenCount: number };

  test("S, M and L grow in both visible rows and plot height", () => {
    assert.deepEqual(Object.keys(slots), ["S", "M", "L"]);
    const [s, m, l] = [slots.S, slots.M, slots.L];
    assert.ok(s.rowCount < m.rowCount && m.rowCount < l.rowCount);
    assert.ok(s.plotPx < m.plotPx && m.plotPx < l.plotPx);
  });

  for (const size of ["S", "M", "L"]) {
    for (const total of [0, slots[size].rowCount, slots[size].rowCount + 7]) {
      test(`a ${size} card shows at most its row budget and counts the rest (${total} items)`, () => {
        const items = Array.from({ length: total }, (_, i) => i);
        const { rows, hiddenCount } = getSlotRows(items, size);
        assert.deepEqual(rows, items.slice(0, rows.length), "rows keep their order");
        assert.ok(rows.length <= slots[size].rowCount);
        assert.equal(rows.length + hiddenCount, total);
      });
    }
  }

  test("an unknown size budgets as M", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    assert.equal(getSlotRows(items, "XL").rows.length, slots.M.rowCount);
  });
});

describe("card", () => {
  test("a sized card carries its slot modifier, and an unsized one none", () => {
    const sized = findNodes(render("Card", { size: "M", title: "Runs" }, "body"), (n) => classesOf(n).includes("card"))[0];
    const plain = findNodes(render("Card", { title: "Runs" }, "body"), (n) => classesOf(n).includes("card"))[0];
    assert.ok(classesOf(sized).includes("card--m"));
    assert.equal(classesOf(plain).filter((c) => c.startsWith("card--")).length, 0);
  });

  test("the foot renders after the body, so it pins to the card's bottom edge", () => {
    const card = findNodes(render("Card", { title: "Runs", foot: "Show all 12" }, "rows"), (n) => classesOf(n).includes("card"))[0];
    const parts = card.children.filter((c): c is RenderedNode => typeof c !== "string").map((c) => classesOf(c));
    const bodyAt = parts.findIndex((c) => c.includes("card-body"));
    const footAt = parts.findIndex((c) => c.includes("card-foot"));
    assert.ok(bodyAt >= 0 && footAt > bodyAt, `parts ${JSON.stringify(parts)}`);
  });

  test("a card with no foot renders no empty foot strip", () => {
    assert.equal(findNodes(render("Card", { title: "Runs" }, "rows"), (n) => classesOf(n).includes("card-foot")).length, 0);
  });
});

describe("clamping helpers", () => {
  const long = "a rejection reason long enough to need clamping in a narrow column";

  test("a one-line table cell carries its full text as a tooltip", () => {
    const [cell] = findNodes(render("ClampCell", { text: long }), (n) => n.type === "td");
    assert.ok(classesOf(cell).includes("cell-clamp"));
    assert.equal(cell.props.title, long);
    assert.equal(collectText(cell), long);
  });

  test("a two-line clamp carries its full text as a tooltip", () => {
    const [node] = findNodes(render("ClampText", { text: long }), (n) => classesOf(n).includes("clamp-2"));
    assert.equal(node.props.title, long);
    assert.equal(collectText(node), long);
  });
});

describe("disclosure in a stretched row", () => {
  test("only a collapsed fold is marked collapsed", () => {
    const cardOf = (kind: string) => findNodes(render("Disclosure", { kind, title: "History" }, "rows"), (n) => classesOf(n).includes("card"))[0];
    assert.ok(classesOf(cardOf("detail")).includes("is-collapsed"), "detail starts collapsed");
    assert.ok(!classesOf(cardOf("status")).includes("is-collapsed"), "status starts open");
  });
});
