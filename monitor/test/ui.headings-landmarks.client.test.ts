// Shared heading + landmark pins (plan 39859 S1): page h1 = nav label, card titles = h2, named shell regions.
// Screen headers are read from each screen's rendered tree, so a screen edit never reaches this file.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import { collectText, createReactStub, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../public/src");
const APP_SRC = readFileSync(resolve(SRC, "app.jsx"), "utf8");

type Component = (props: Record<string, unknown>) => unknown;
interface ElementLike { type?: unknown; props?: { children?: unknown } }

async function getNavEntries(): Promise<Array<{ id: string; label: string }>> {
  const app = await loadScreenModule(resolve(SRC, "app.jsx"), {
    ReactDOM: { createRoot: () => ({ render: () => {} }) },
    document: { getElementById: () => null },
  });
  // vm read is untyped; the entry-count check in the caller fails on a missing or reshaped NAV
  return vm.runInContext("NAV", app) as Array<{ id: string; label: string }>;
}

const realUi = ((await loadScreenModule(resolve(SRC, "ui.jsx"))) as { UI: Record<string, unknown> }).UI;

// window.UI stub — components become `ui-atom` nodes carrying their props; helpers and constants stay real
function getUiStub(): unknown {
  const getAtom = (name: string) =>
    Object.defineProperty((props: Record<string, unknown>) => ({ __element: true, type: "ui-atom", props: { ...props, atom: name } }), "name", { value: name });
  return new Proxy({}, { get: (_target, name: string) => (!/^[A-Z][a-z]/.test(name) && name in realUi ? realUi[name] : getAtom(name)), has: () => true });
}

// the PageHeader props a screen renders on its first, unread pass
async function getScreenHeader(id: string): Promise<Record<string, unknown>> {
  const path = resolve(SRC, "screens", `${id}.jsx`);
  assert.ok(existsSync(path), `screen file for nav id ${id}`);
  // browser globals a screen reads on mount: storage, and the hash its filters persist in
  const screen = await loadScreenModule(path, {
    UI: getUiStub(),
    React: createReactStub(),
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { hash: `#${id}` },
    history: { replaceState: () => {} },
    URLSearchParams,
  });
  const name = Object.keys(screen).find((key) => /^Screen[A-Z]/.test(key) && typeof screen[key] === "function");
  assert.ok(name, `${id}.jsx defines a Screen component`);
  const React = screen.React as { createElement: (t: unknown, p: unknown) => unknown };
  const headers = findNodes(renderScreen(React.createElement(screen[name], { onNav: () => {} })) as RenderedNode, (n) => n.props.atom === "PageHeader");
  assert.equal(headers.length, 1, `${id} renders one PageHeader`);
  return headers[0].props;
}

// component names in an unrendered element tree — a slot may wrap its atom in a fragment or a screen-local component
function getElementNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(getElementNames);
  if (!value || typeof value !== "object") return [];
  const element = value as ElementLike;
  const name = typeof element.type === "function" ? element.type.name : "";
  return [name, ...getElementNames(element.props?.children)].filter(Boolean);
}

test("every screen's page h1 is its nav label", async () => {
  const entries = await getNavEntries();
  assert.ok(entries.length >= 9, `NAV parse found ${entries.length} entries`);
  for (const { id, label } of entries) {
    assert.equal((await getScreenHeader(id)).title, label, `${id} PageHeader title matches the nav label`);
  }
});

// Documents wraps each slot's atom in a screen-local component (its stamp waits for a first read);
// clauded-docs.screen-render pins that the wrappers render FreshnessStamp and RefreshButton.
// Queue re-reads itself, so its slot states its cadence or its last good read (queue.owner-page pins the text)
const SLOT_ATOMS: Record<string, { freshness: string; refresh: string }> = {
  "clauded-docs": { freshness: "DocHeaderFreshnessCD", refresh: "DocHeaderRefreshCD" },
  queue: { freshness: "QueueFreshnessQ", refresh: "RefreshButton" },
};

test("every screen passes its stamp and Refresh through the named slots, never a free right cluster", async () => {
  const entries = await getNavEntries();
  assert.ok(entries.length >= 9, `NAV parse found ${entries.length} entries`);
  for (const { id } of entries) {
    const header = await getScreenHeader(id);
    const atoms = SLOT_ATOMS[id] ?? { freshness: "FreshnessStamp", refresh: "RefreshButton" };
    assert.equal(header.right, undefined, `${id} header carries no free right cluster`);
    assert.deepEqual(getElementNames(header.refresh), [atoms.refresh], `${id} Refresh rides the refresh slot`);
    assert.ok(getElementNames(header.freshness).includes(atoms.freshness), `${id} stamp rides the freshness slot`);
  }
});

describe("the page header atom", async () => {
  const ui = await loadScreenModule(resolve(SRC, "ui.jsx"));
  const React = ui.React as { createElement: (t: unknown, p: unknown) => unknown };
  const render = (props: Record<string, unknown>) => renderScreen(React.createElement(ui.PageHeader as Component, props)) as RenderedNode;
  const byClass = (tree: RenderedNode, name: string) =>
    findNodes(tree, (n) => n.type === "div" && new RegExp(`(^|\\s)${name}(\\s|$)`).test(String(n.props.className ?? "")));

  test("renders only its named slots — a free right cluster is no longer drawn", () => {
    const tree = render({ title: "Wiki", right: "legacy", refresh: "refresh" });
    assert.doesNotMatch(collectText(tree), /legacy/, "the retired prop renders nothing");
    assert.deepEqual(byClass(tree, "page-head-group").map((g) => collectText(g)), ["refresh"], "one status group, holding the refresh slot");
  });

  test("keeps back link, h1 and status on its lead line and renders no sub-line, whatever the caller passes", () => {
    const tree = render({ title: "Agents", sub: "Triage — who is unsafe", back: "Back", status: "Draft", primary: "Save" });
    const [lead] = byClass(tree, "page-head-lead");
    const [heading] = findNodes(tree, (n) => n.type === "h1");
    assert.equal(collectText(heading), "Agents");
    assert.equal(collectText(lead), "Back Agents Draft", "back, then title, then status — nothing else on the lead line");
    assert.doesNotMatch(collectText(tree), /Triage/, "the retired sub-line renders nothing");
  });
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

  test("a section label is an h2 by default and carries the section-label style", () => {
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
