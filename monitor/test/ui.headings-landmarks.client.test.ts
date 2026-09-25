// Shared heading + landmark pins (plan 39859 S1): page h1 = nav label, card titles = h2, named shell regions.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../public/src");
const APP_SRC = readFileSync(resolve(SRC, "app.jsx"), "utf8");

type Component = (props: Record<string, unknown>) => unknown;

function getNavEntries(): Array<{ id: string; label: string }> {
  return [...APP_SRC.matchAll(/\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)].map((m) => ({ id: m[1], label: m[2] }));
}

test("every screen's page h1 is its nav label", () => {
  const entries = getNavEntries();
  assert.ok(entries.length >= 9, `NAV parse found ${entries.length} entries`);
  for (const { id, label } of entries) {
    const path = resolve(SRC, "screens", `${id}.jsx`);
    assert.ok(existsSync(path), `screen file for nav id ${id}`);
    const title = readFileSync(path, "utf8").match(/<PageHeader\b[^>]*?\btitle="([^"]+)"/)?.[1];
    assert.equal(title, label, `${id}.jsx PageHeader title matches the nav label`);
  }
});

test("a card heading is a section h2, below the page h1 in the outline", async () => {
  const ui = await loadScreenModule(resolve(SRC, "ui.jsx"));
  const React = ui.React as { createElement: (t: unknown, p: unknown) => unknown };
  const card = renderScreen(React.createElement(ui.CardHead as Component, { title: "Spend by model", sub: "last 7 days" }));
  const h2 = findNodes(card, (n) => n.type === "h2");
  assert.equal(h2.length, 1);
  assert.equal(collectText(h2[0]), "Spend by model");
  assert.equal(findNodes(card, (n) => n.type === "h1").length, 0);
});

test("the shell's sidebar and primary navigation are named landmarks", () => {
  assert.match(APP_SRC, /<aside\b[^>]*\baria-label="[^"]+"/, "aside carries an accessible name");
  assert.match(APP_SRC, /<nav\b[^>]*\baria-label="[^"]+"/, "nav carries an accessible name");
  assert.match(APP_SRC, /<main\b/, "a single main landmark holds the screen");
});

test("type scale keeps h1 > section h2 > column header, with the KPI value largest", () => {
  const css = readFileSync(resolve(__dirname, "../public/styles/base.css"), "utf8");
  const ui = readFileSync(resolve(SRC, "ui.jsx"), "utf8");
  const px = (re: RegExp, text: string): number => Number(text.match(re)?.[1]);
  const h1 = px(/--fs-display:\s*(\d+)px/, ui);
  const h2 = px(/\.card-title\s*\{[^}]*?font-size:\s*var\(--fs-title,\s*(\d+)px\)/, css);
  const th = px(/\.tbl th\s*\{[^}]*?font-size:\s*(\d+)px/, css);
  const kpi = px(/\.kpi-value\s*\{[^}]*?font-size:\s*(\d+)px/, css);
  assert.ok(kpi > h1 && h1 > h2 && h2 > th, `kpi ${kpi} > h1 ${h1} > h2 ${h2} > th ${th}`);
});

describe("structure atoms carry headings, captions and column scope", async () => {
  const ui = await loadScreenModule(resolve(SRC, "ui.jsx"));
  const React = ui.React as { createElement: (t: unknown, p: unknown, ...c: unknown[]) => unknown };
  // the harness wraps each component in a node named after it → return what the component itself rendered
  const render = (name: string, props: Record<string, unknown>, ...children: unknown[]): RenderedNode =>
    (renderScreen(React.createElement(ui[name] as Component, props, ...children)) as RenderedNode).children[0] as RenderedNode;

  test("a section label is an h2 by default and keeps the uppercase section-label style", () => {
    const tree = render("SectionLabel", {}, "Pinned models");
    assert.equal(tree.type, "h2");
    assert.match(String(tree.props.className), /\bsection-label\b/);
    assert.equal(collectText(tree), "Pinned models");
  });

  test("a sub-card label is a heading one level below the card or dialog title", () => {
    const tree = render("SubCard", { label: "Recent runs" }, "body");
    const h3 = findNodes(tree, (n) => n.type === "h3");
    assert.equal(h3.length, 1);
    assert.equal(collectText(h3[0]), "Recent runs");
  });

  test("the table atom names itself with a caption and scopes every column header", () => {
    const columns = [
      { key: "model", label: "Model" },
      { key: "spend", label: "Spend", isNumeric: true },
    ];
    const tree = render("Table", { caption: "Spend by model", columns }, React.createElement("tr", {}));
    const caption = findNodes(tree, (n) => n.type === "caption");
    const headers = findNodes(tree, (n) => n.type === "th");
    assert.equal(collectText(caption[0]), "Spend by model");
    assert.deepEqual(headers.map((th) => th.props.scope), ["col", "col"]);
    assert.deepEqual(headers.map((th) => collectText(th)), ["Model", "Spend"]);
    assert.match(String(headers[1].props.className), /\bnum\b/, "numeric column right-aligns through .num");
  });

  test("a table header renders the one shared header idiom whatever the caller passes", () => {
    const plain = render("TableHead", {}, "Agent");
    const sticky = render("TableHead", { isSticky: true, isNumeric: true }, "Runs");
    assert.equal(plain.type, "th");
    assert.equal(plain.props.scope, "col");
    assert.equal(sticky.props.scope, "col");
    assert.equal((sticky.props.style as Record<string, unknown>).position, "sticky");
  });

  test("a disclosure button exposes its state and names itself by its label", () => {
    for (const isOpen of [false, true]) {
      const tree = render("DisclosureButton", { isOpen, onToggle: () => {}, label: "Details" });
      assert.equal(tree.type, "button");
      assert.equal(tree.props["aria-expanded"], isOpen);
      assert.match(String(tree.props.className), /\bgroup\b/, "the button is the hover target for its chevron");
      assert.equal(collectText(tree).trim(), "Details");
      assert.equal(findNodes(tree, (n) => n.type === "svg").length, 1, "one chevron inside the button");
    }
  });

  test("a disclosure chevron is at least 12px, brightens on hover and turns only when open", () => {
    const closed = findNodes(render("DisclosureChevron", { isOpen: false }), (n) => n.type === "svg")[0];
    const open = findNodes(render("DisclosureChevron", { isOpen: true }), (n) => n.type === "svg")[0];
    for (const chevron of [closed, open]) {
      assert.ok(Number(chevron.props.width) >= 12, `chevron width ${chevron.props.width}`);
      assert.match(String(chevron.props.className), /group-hover:text-ink/);
    }
    assert.doesNotMatch(String(closed.props.className), /\brotate-90\b/);
    assert.match(String(open.props.className), /\brotate-90\b/);
  });
});
