// Token contrast floors in public/styles/tokens.css, both theme blocks parsed from the shipped file.
// Runner: npx tsx --test test/tokens.contrast.unit.test.ts
// Dark: body/primary text on --surface ≥ 4.5. Light: --crit carries words (form errors, destructive
// labels) → ≥ 4.5 on every opaque surface; every tone is at least a glyph → ≥ 3.0 there.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { contrastRatio, type Rgba } from "./lib/wcag-contrast.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_CSS = resolve(__dirname, "../public/styles/tokens.css");

const css = readFileSync(TOKENS_CSS, "utf8");

// Isolate the [data-theme="dark"] block so light-theme triplets (the same
// var names appear in :root) can't be matched by mistake. The block runs from
// the selector's opening brace to its matching closing brace.
function getDarkThemeBlock(source: string): string {
  const sel = source.indexOf('[data-theme="dark"]');
  assert.ok(sel !== -1, 'tokens.css must contain a [data-theme="dark"] block');
  const open = source.indexOf("{", sel);
  const close = source.indexOf("}", open);
  assert.ok(open !== -1 && close !== -1, "dark-theme block must be brace-delimited");
  return source.slice(open + 1, close);
}

// Parse a space-separated `R G B` triplet for the given custom property,
// e.g. `--dim: 214 211 209` → { r: 214, g: 211, b: 209, a: 1 }.
function parseTriplet(block: string, name: string): Rgba {
  const m = block.match(
    new RegExp(`${name}\\s*:\\s*(\\d{1,3})\\s+(\\d{1,3})\\s+(\\d{1,3})`),
  );
  assert.ok(m, `theme block must define ${name} as a space-separated RGB triplet`);
  const rgb: Rgba = { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: 1 };
  for (const c of [rgb.r, rgb.g, rgb.b]) {
    assert.ok(c >= 0 && c <= 255, `${name} channel out of 0-255 range`);
  }
  return rgb;
}

// The light theme is the plain `:root` block — not the alias rule that also names a nested scope.
function getLightThemeBlock(source: string): string {
  const m = source.match(/(?:^|\n):root\s*\{([^}]*)\}/);
  assert.ok(m, "tokens.css must contain a plain :root block");
  return m[1];
}

const dark = getDarkThemeBlock(css);
const surface = parseTriplet(dark, "--surface");
const dim = parseTriplet(dark, "--dim");
const ink = parseTriplet(dark, "--ink");

const AA_NORMAL = 4.5;

test("--dim on --surface meets WCAG AA 4.5:1 (body/description text floor)", () => {
  const ratio = contrastRatio(dim, surface);
  assert.ok(
    ratio >= AA_NORMAL,
    `--dim (${dim.r} ${dim.g} ${dim.b}) on --surface contrast ${ratio.toFixed(2)}:1 < ${AA_NORMAL}:1`,
  );
  // Sanity-pin the expected magnitude (~13.26:1) so a silent regression that
  // still clears 4.5 but darkens --dim is also visible in test output.
  assert.ok(ratio > 13 && ratio < 14, `--dim ratio ${ratio.toFixed(2)} outside expected ~13.26 band`);
});

test("--ink on --surface meets WCAG AA 4.5:1 (primary text floor)", () => {
  const ratio = contrastRatio(ink, surface);
  assert.ok(
    ratio >= AA_NORMAL,
    `--ink (${ink.r} ${ink.g} ${ink.b}) on --surface contrast ${ratio.toFixed(2)}:1 < ${AA_NORMAL}:1`,
  );
  assert.ok(ratio > 18 && ratio < 19, `--ink ratio ${ratio.toFixed(2)} outside expected ~18.9 band`);
});

const light = getLightThemeBlock(css);
const LIGHT_SURFACES = ["--elev", "--surface", "--sunken"] as const;
const UI_GLYPH = 3;

test("light --crit carries words on every opaque light surface at 4.5:1", () => {
  const crit = parseTriplet(light, "--crit");
  for (const surface of LIGHT_SURFACES) {
    const ratio = contrastRatio(crit, parseTriplet(light, surface));
    assert.ok(ratio >= AA_NORMAL, `light --crit on ${surface} = ${ratio.toFixed(2)}:1 < ${AA_NORMAL}:1`);
  }
});

test("every light tone reads as a glyph on every opaque light surface at 3:1", () => {
  for (const tone of ["--crit", "--warn", "--ok", "--info"]) {
    const fg = parseTriplet(light, tone);
    for (const surface of LIGHT_SURFACES) {
      const ratio = contrastRatio(fg, parseTriplet(light, surface));
      assert.ok(ratio >= UI_GLYPH, `light ${tone} on ${surface} = ${ratio.toFixed(2)}:1 < ${UI_GLYPH}:1`);
    }
  }
});

// `--name: var(--target)` in the `:root, [data-theme]` alias rule → the target's name, since the triplet parser reads literals only
function getAliasTarget(source: string, name: string): string {
  const m = source.match(/:root,\s*\[data-theme\]\s*\{([^}]*)\}/);
  assert.ok(m, "tokens.css must contain the :root, [data-theme] alias rule");
  const target = m[1].match(new RegExp(`${name}\\s*:\\s*var\\((--[\\w-]+)\\)`))?.[1];
  assert.ok(target, `the alias rule must declare ${name} as the var() of one token`);
  return target;
}

const THEMES = [
  ["light", light, LIGHT_SURFACES],
  ["dark", dark, [...LIGHT_SURFACES, "--elev-2"]],
] as const;

test("the resting control edge of toggles and fields clears 3:1 against every surface it sits on, in both themes", () => {
  const edge = getAliasTarget(css, "--control-edge");
  for (const [theme, block, surfaces] of THEMES) {
    for (const surface of surfaces) {
      const ratio = contrastRatio(parseTriplet(block, edge), parseTriplet(block, surface));
      assert.ok(ratio >= UI_GLYPH, `${theme} --control-edge (${edge}) on ${surface} = ${ratio.toFixed(2)}:1 < ${UI_GLYPH}:1`);
    }
  }
});

test("the hover edge stays a visible step above the resting control edge, in both themes", () => {
  const edge = getAliasTarget(css, "--control-edge");
  for (const [theme, block] of THEMES) {
    const elev = parseTriplet(block, "--elev");
    const rest = contrastRatio(parseTriplet(block, edge), elev);
    const hover = contrastRatio(parseTriplet(block, "--faint"), elev);
    assert.ok(hover > rest, `${theme} hover --faint ${hover.toFixed(2)}:1 must exceed the resting edge ${rest.toFixed(2)}:1 on --elev`);
  }
});
