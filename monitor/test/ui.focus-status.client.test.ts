// Shared focus + colour-free state pins (plan 39859 S2): one focus token, no per-component rings, glyph+word dots.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { contrastRatio, type Rgba } from "./lib/wcag-contrast.js";
import { collectText, createEffectReact, createFakeDocument, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, "../public");
const SRC = resolve(PUBLIC, "src");
const THEME_CSS = readFileSync(resolve(PUBLIC, "styles/tokens.css"), "utf8");

type Component = (props: Record<string, unknown>) => unknown;

function getBlock(source: string, selector: string): string {
  const open = source.indexOf("{", source.indexOf(selector));
  return source.slice(open + 1, source.indexOf("}", open));
}

function getTriplet(block: string, name: string): Rgba | null {
  const m = block.match(new RegExp(`${name}\\s*:\\s*(\\d{1,3})\\s+(\\d{1,3})\\s+(\\d{1,3})`));
  return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: 1 } : null;
}

function getSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? getSourceFiles(resolve(dir, e.name)) : /\.(jsx|css)$/.test(e.name) ? [resolve(dir, e.name)] : [],
  );
}

test("the focus colour clears 3:1 against every surface it can sit on, in both themes", () => {
  const light = getBlock(THEME_CSS, ":root");
  const dark = getBlock(THEME_CSS, '[data-theme="dark"]');
  for (const [theme, block] of [["light", light], ["dark", dark]] as const) {
    const ring = getTriplet(block, "--focus-ring");
    assert.ok(ring, `${theme} theme declares --focus-ring`);
    for (const surface of ["--surface", "--elev", "--sunken"]) {
      const bg = getTriplet(block, surface);
      assert.ok(bg, `${theme} ${surface}`);
      const ratio = contrastRatio(ring, bg);
      assert.ok(ratio >= 3, `${theme} --focus-ring on ${surface} = ${ratio.toFixed(2)}:1`);
    }
  }
});

test("no component draws its own focus ring beside the shared one", () => {
  const offenders: string[] = [];
  for (const file of getSourceFiles(PUBLIC)) {
    const text = readFileSync(file, "utf8");
    if (/focus-visible:ring/.test(text)) offenders.push(`${file}: tailwind focus ring`);
    for (const m of text.matchAll(/:focus(?:-visible|-within)?[^{}\n]*\{([^}]*)\}/g)) {
      const body = m[1];
      const ownRing = /outline:\s*\d|box-shadow:\s*0 0 0|stroke:\s*rgb\(var\(--accent\)/.test(body);
      if (ownRing && !/--focus-ring/.test(body)) offenders.push(`${file}: ${m[0].slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("every status dot tone carries a distinct glyph and a word, so state survives without colour", async () => {
  const ui = await loadScreenModule(resolve(SRC, "ui.jsx"));
  const React = ui.React as { createElement: (t: unknown, p: unknown) => unknown };
  const tones = ["ok", "warn", "crit", "info", "unknown-tone"];
  const glyphs = new Set<string>();
  const words = new Set<string>();
  for (const status of tones) {
    const dot = renderScreen(React.createElement(ui.StatusDot as Component, { status }));
    const glyph = findNodes(dot, (n: RenderedNode) => n.props["aria-hidden"] === "true");
    const word = findNodes(dot, (n: RenderedNode) => String(n.props.className ?? "").includes("sr-only"));
    assert.equal(glyph.length, 1, `${status}: one decorative glyph`);
    assert.equal(word.length, 1, `${status}: one screen-reader word`);
    glyphs.add(collectText(glyph[0]).trim());
    words.add(collectText(word[0]).trim());
  }
  assert.equal(glyphs.size, tones.length, `glyphs distinct per tone: ${[...glyphs].join(" ")}`);
  assert.equal(words.size, tones.length, `words distinct per tone: ${[...words].join(" ")}`);
  assert.ok(![...glyphs, ...words].includes(""), "no empty glyph or word");
});

test("the document root declares the UI copy language, English", () => {
  const html = readFileSync(resolve(PUBLIC, "index.html"), "utf8");
  assert.match(html, /<html[^>]*\blang="en"/);
});

const effects = createEffectReact();
const fxDoc = createFakeDocument();
const fxUi = await loadScreenModule(resolve(SRC, "ui.jsx"), { React: effects.react, document: fxDoc });
const fxH = (fxUi.React as { createElement: (t: unknown, p: unknown) => unknown }).createElement;
const RETRY_ATOMS = [
  { name: "RegionUnavailable", props: { source: "Agents", error: "HTTP 500" } },
  { name: "PageErrorBanner", props: { sources: ["Agents", "Outcomes"], error: "HTTP 500" } },
];

function getRetry(tree: RenderedNode): RenderedNode {
  return findNodes(tree, (n) => n.type === "button" && /Retry/.test(collectText(n)))[0];
}

test("a busy Retry stays focusable, says it is busy, and ignores clicks until the request settles", () => {
  for (const atom of RETRY_ATOMS) {
    for (const isBusy of [false, true]) {
      let calls = 0;
      const tree = renderScreen(fxH(fxUi[atom.name], { ...atom.props, isBusy, onRetry: () => { calls += 1; } })) as RenderedNode;
      const retry = getRetry(tree);
      (retry.props.onClick as (event?: unknown) => void)({});

      assert.equal(retry.props.disabled, undefined, `${atom.name} busy=${isBusy}: never natively disabled`);
      assert.equal(retry.props["aria-disabled"] === "true", isBusy, `${atom.name} busy=${isBusy}: aria-disabled`);
      assert.equal(retry.props["aria-busy"] === "true", isBusy, `${atom.name} busy=${isBusy}: aria-busy`);
      assert.equal(calls, isBusy ? 0 : 1, `${atom.name} busy=${isBusy}: click`);
    }
  }
});

test("a Retry that unmounts while focused hands focus to its region card; an unfocused one leaves focus alone", () => {
  const rows = [
    { name: "focused Retry", isRetryFocused: true, expected: "card" },
    { name: "focus elsewhere", isRetryFocused: false, expected: "elsewhere" },
  ];
  for (const atom of RETRY_ATOMS) {
    for (const row of rows) {
      fxDoc.reset();
      const card = { name: "card", hasAttribute: () => true, setAttribute: () => undefined, addEventListener: () => undefined, scrollIntoView: () => undefined, focus: () => { fxDoc.activeElement = card; } };
      const retry = { name: "retry" };
      const elsewhere = { name: "elsewhere" };
      fxDoc.elements.set("agents-alarms", card);
      // renderScreen output is not attachable by mount → commit the Retry host ref the way React would, before layout effects run
      const render = () => {
        const tree = renderScreen(fxH(fxUi[atom.name], { ...atom.props, onRetry: () => undefined, focusTargetId: "agents-alarms" })) as RenderedNode;
        (getRetry(tree).props.ref as { current: unknown }).current = retry;
        return tree;
      };
      const { unmount } = effects.mount(render, () => ({}));
      fxDoc.activeElement = row.isRetryFocused ? retry : elsewhere;

      unmount();

      assert.equal((fxDoc.activeElement as { name: string }).name, row.expected, `${atom.name}: ${row.name}`);
    }
  }
});

function getFakeCard(name: string): Record<string, unknown> {
  const card = { name, hasAttribute: () => true, setAttribute: () => undefined, addEventListener: () => undefined, scrollIntoView: () => undefined, focus: () => { fxDoc.activeElement = card; } };
  return card;
}

test("a shared-outage banner leaving with its Retry focused hands focus to the first covered region's card, else to its fallback", () => {
  const shared = { sources: ["cost trend", "token trend"], error: "HTTP 500" };
  const rows = [
    { name: "covered regions declared their cards", regionCardIds: ["cost-trend", "cost-tokens"], expected: "cost-trend" },
    { name: "no covered region declared a card", regionCardIds: [undefined, undefined], expected: "cost-verdict" },
  ];
  for (const row of rows) {
    fxDoc.reset();
    for (const id of ["cost-trend", "cost-tokens", "cost-verdict"]) fxDoc.elements.set(id, getFakeCard(id));
    shared.sources.forEach((source, index) => {
      const covered = renderScreen(fxH(fxUi.RegionFailure, { source, error: shared.error, shared, focusTargetId: row.regionCardIds[index] })) as RenderedNode;
      fxDoc.attached.push(...findNodes(covered, (n) => n.type === "div"));
    });
    const retry = { name: "retry" };
    let banner = null as RenderedNode | null;
    const render = () => {
      banner = renderScreen(fxH(fxUi.PageErrorBanner, { ...shared, onRetry: () => undefined, focusTargetId: "cost-verdict" })) as RenderedNode;
      (getRetry(banner).props.ref as { current: unknown }).current = retry;
      return banner;
    };
    const { unmount } = effects.mount(render, () => ({}));
    const alert = findNodes(banner as unknown as RenderedNode, (n) => n.props.role === "alert")[0];
    fxDoc.activeElement = retry;
    (alert.props.onFocus as () => void)();

    unmount();

    assert.equal((fxDoc.activeElement as { name: string }).name, row.expected, row.name);
  }
});

test("a region reads as its error card while a Retry is in flight over a cold error, never as a loader", () => {
  const getRegionView = fxUi.getRegionView as (region: Record<string, unknown>) => string;
  const rows = [
    { name: "first load", region: { data: null, error: null, busy: true }, expected: "loading" },
    { name: "cold error, idle", region: { data: null, error: "HTTP 500", busy: false }, expected: "error" },
    { name: "cold error, Retry in flight", region: { data: null, error: "HTTP 500", busy: true }, expected: "error" },
    { name: "held data over a warm error", region: { data: { n: 1 }, error: "HTTP 500", busy: true }, expected: "ready" },
    { name: "held data", region: { data: { n: 1 }, error: null, busy: false }, expected: "ready" },
  ];
  for (const row of rows) assert.equal(getRegionView(row.region), row.expected, row.name);
});
