// Shared focus + colour-free state pins (plan 39859 S2): one focus token, no per-component rings, glyph+word dots.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { contrastRatio, type Rgba } from "./lib/wcag-contrast.js";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, "../public");
const SRC = resolve(PUBLIC, "src");
const THEME_CSS = readFileSync(resolve(PUBLIC, "styles/tokens.css"), "utf8");
const BASE_CSS = readFileSync(resolve(PUBLIC, "styles/base.css"), "utf8");

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

test("one global focus-visible rule draws the focus colour as an offset outline, never a box-shadow", () => {
  const rule = BASE_CSS.match(/(?:^|\n)\s*:focus-visible\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(rule, /outline:\s*var\(--focus-ring-width\)\s+solid\s+rgb\(var\(--focus-ring\)\)/);
  assert.match(rule, /outline-offset:\s*var\(--focus-ring-offset\)/);
  assert.doesNotMatch(rule, /box-shadow/, "box-shadow would overwrite rings drawn with box-shadow");
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
