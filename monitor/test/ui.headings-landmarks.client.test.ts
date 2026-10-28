// Shared heading + landmark pins (plan 39859 S1): page h1 = nav label, card titles = h2, named shell regions.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../public/src");
const APP_SRC = readFileSync(resolve(SRC, "app.jsx"), "utf8");

type Component = (props: Record<string, unknown>) => unknown;

async function getNavEntries(): Promise<Array<{ id: string; label: string }>> {
  const app = await loadScreenModule(resolve(SRC, "app.jsx"), {
    ReactDOM: { createRoot: () => ({ render: () => {} }) },
    document: { getElementById: () => null },
  });
  // vm read is untyped; the entry-count check in the caller fails on a missing or reshaped NAV
  return vm.runInContext("NAV", app) as Array<{ id: string; label: string }>;
}

test("every screen's page h1 is its nav label", async () => {
  const entries = await getNavEntries();
  assert.ok(entries.length >= 9, `NAV parse found ${entries.length} entries`);
  for (const { id, label } of entries) {
    const path = resolve(SRC, "screens", `${id}.jsx`);
    assert.ok(existsSync(path), `screen file for nav id ${id}`);
    const title = readFileSync(path, "utf8").match(/<PageHeader\b[^>]*?\btitle="([^"]+)"/)?.[1];
    assert.equal(title, label, `${id}.jsx PageHeader title matches the nav label`);
  }
});

// slice 0b-7 callers; the remaining screens join when the free `right` prop is retired
const SLOT_HEADER_SCREENS = ["dashboard", "cost", "model-config", "agents", "outcomes"];

test("a migrated screen passes its header controls through the named slots, the title ahead of them", () => {
  for (const id of SLOT_HEADER_SCREENS) {
    const src = readFileSync(resolve(SRC, "screens", `${id}.jsx`), "utf8");
    // the element runs to the `/>` at its own indent — slot JSX inside self-closes deeper
    const open = src.match(/^([ \t]*)<PageHeader\b[\s\S]*?\n\1\/>/m)?.[0] ?? "";
    assert.ok(open, `${id}.jsx renders a PageHeader`);
    assert.doesNotMatch(open, /\bright=/, `${id}.jsx header carries no free right cluster`);
    assert.match(open, /\brefresh=\{\s*<RefreshButton\b/, `${id}.jsx Refresh rides the refresh slot`);
    assert.match(open, /\bfreshness=\{[\s\S]*?<FreshnessStamp\b/, `${id}.jsx stamp rides the freshness slot`);
    const slotAt = open.search(/\b(?:actions|freshness|range|refresh)=\{/);
    assert.ok(open.indexOf('title="') < slotAt, `${id}.jsx title comes before the first JSX slot prop`);
  }
});

test("the page title line is one control high and its sub-line clears the focus ring", () => {
  const css = readFileSync(resolve(__dirname, "../public/styles/base.css"), "utf8");
  const rule = (selector: string) => css.match(new RegExp(`(?:^|(?<!,)\\n)${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  assert.match(rule("\\.page-head"), /align-items:\s*flex-start/, "the header row is top-aligned");
  assert.match(rule("\\.page-head"), /margin-bottom:\s*var\(--space-4\)/, "header → content 16");
  assert.match(rule("\\.page-head-title"), /line-height:\s*var\(--ctl-min-h\)/, "controls center on the title line");
  assert.match(rule("\\.page-head-sub"), /margin-top:\s*max\(var\(--space-1\),\s*calc\(var\(--focus-ring-width\)\s*\+\s*var\(--focus-ring-offset\)\)\)/,
    "title → sub-line gap is the larger of 4 and the ring reach");
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
  const styles = resolve(__dirname, "../public/styles");
  const css = readFileSync(resolve(styles, "base.css"), "utf8");
  const tokens = readFileSync(resolve(styles, "tokens.css"), "utf8");
  // a font-size → px, through one var() hop into the tokens.css type steps
  const px = (value: string): number => {
    const name = value.match(/^var\((--[\w-]+)\)$/)?.[1];
    const resolved = name ? tokens.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))?.[1] ?? "" : value;
    return Number(resolved.match(/^(\d+)px$/)?.[1]);
  };
  const fontSize = (selector: string): number => px(css.match(new RegExp(`${selector}\\s*\\{[^}]*?font-size:\\s*([^;]+);`))?.[1].trim() ?? "");
  const h1 = px("var(--fs-display)");
  const h2 = fontSize("\\.card-title");
  const th = fontSize("\\.tbl th");
  const kpi = fontSize("\\.kpi-value");
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
