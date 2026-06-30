// Unit tests locking the DARK-theme body/UI text contrast in
// public/styles/tokens.css against the WCAG 2.1 4.5:1 normal-text floor.
// Runner: npx tsx --test test/tokens.contrast.unit.test.ts
//
// Wave 1 swapped body/description text from a too-faint token onto --dim;
// this test makes that decision durable. It parses the actual shipped
// tokens.css (no drift-prone copy), extracts the dark-theme RGB triplets,
// and computes the WCAG relative-luminance contrast ratio against --surface.
// A future palette edit that dropped --dim/--ink below AA would now fail.
// Dependency-free: node:test + node:assert + node:fs only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_CSS = resolve(__dirname, "../public/styles/tokens.css");

const css = readFileSync(TOKENS_CSS, "utf8");

type RGB = [number, number, number];

// Isolate the [data-theme="dark"] block so light-theme triplets (the same
// var names appear in :root) can't be matched by mistake. The block runs from
// the selector's opening brace to its matching closing brace.
function darkThemeBlock(source: string): string {
  const sel = source.indexOf('[data-theme="dark"]');
  assert.ok(sel !== -1, 'tokens.css must contain a [data-theme="dark"] block');
  const open = source.indexOf("{", sel);
  const close = source.indexOf("}", open);
  assert.ok(open !== -1 && close !== -1, "dark-theme block must be brace-delimited");
  return source.slice(open + 1, close);
}

// Parse a space-separated `R G B` triplet for the given custom property,
// e.g. `--dim: 214 211 209` → [214, 211, 209].
function parseTriplet(block: string, name: string): RGB {
  const m = block.match(
    new RegExp(`${name}\\s*:\\s*(\\d{1,3})\\s+(\\d{1,3})\\s+(\\d{1,3})`),
  );
  assert.ok(m, `dark-theme block must define ${name} as a space-separated RGB triplet`);
  const rgb: RGB = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (const c of rgb) assert.ok(c >= 0 && c <= 255, `${name} channel out of 0-255 range`);
  return rgb;
}

// sRGB → linear transfer function, then WCAG 2.1 relative luminance.
function relativeLuminance([r, g, b]: RGB): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// (L_light + 0.05) / (L_dark + 0.05) — order-independent.
function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

const dark = darkThemeBlock(css);
const surface = parseTriplet(dark, "--surface");
const dim = parseTriplet(dark, "--dim");
const ink = parseTriplet(dark, "--ink");

const AA_NORMAL = 4.5;

test("dark-theme --surface is the deep base (not the light 250 250 249)", () => {
  // Guards against accidentally parsing the :root light triplet.
  assert.deepStrictEqual(surface, [12, 10, 9]);
});

test("--dim on --surface meets WCAG AA 4.5:1 (body/description text floor)", () => {
  const ratio = contrastRatio(dim, surface);
  assert.ok(
    ratio >= AA_NORMAL,
    `--dim (${dim.join(" ")}) on --surface contrast ${ratio.toFixed(2)}:1 < ${AA_NORMAL}:1`,
  );
  // Sanity-pin the expected magnitude (~13.26:1) so a silent regression that
  // still clears 4.5 but darkens --dim is also visible in test output.
  assert.ok(ratio > 13 && ratio < 14, `--dim ratio ${ratio.toFixed(2)} outside expected ~13.26 band`);
});

test("--ink on --surface meets WCAG AA 4.5:1 (primary text floor)", () => {
  const ratio = contrastRatio(ink, surface);
  assert.ok(
    ratio >= AA_NORMAL,
    `--ink (${ink.join(" ")}) on --surface contrast ${ratio.toFixed(2)}:1 < ${AA_NORMAL}:1`,
  );
  assert.ok(ratio > 18 && ratio < 19, `--ink ratio ${ratio.toFixed(2)} outside expected ~18.9 band`);
});
