// Token contrast floors in public/styles/tokens.css, both theme blocks parsed from the shipped file.
// Runner: npx tsx --test test/tokens.contrast.unit.test.ts
// Dark: body/primary text on --surface ≥ 4.5. Both themes: --crit carries words (form errors, destructive
// labels) → ≥ 4.5 on every opaque surface; every tone is at least a glyph → ≥ 3.0 there.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { compositeOver, contrastRatio, type Rgba } from "./lib/wcag-contrast.js";

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

// the dark accent sits on the root-only dark rule, apart from the dark block (a nested dark scope keeps the user's accent tweak)
const darkAccentBlock = css.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] ?? "";

// text the base looks set on the sunken track and the raised thumb clears 4.5:1 on every surface; the focus ring clears 3:1 on the page
test("base-look text and the focus ring clear their floors on every surface they sit on, in both themes", () => {
  for (const [theme, block, surfaces] of THEMES) {
    for (const fg of ["--ink", "--dim", "--faint", "--accent"]) {
      for (const surface of surfaces) {
        const fgBlock = fg === "--accent" && theme === "dark" ? darkAccentBlock : block;
        const ratio = contrastRatio(parseTriplet(fgBlock, fg), parseTriplet(block, surface));
        assert.ok(ratio >= AA_NORMAL, `${theme} ${fg} on ${surface} = ${ratio.toFixed(2)}:1 < ${AA_NORMAL}:1`);
      }
    }
    const ring = contrastRatio(parseTriplet(block, "--focus-ring"), parseTriplet(block, "--surface"));
    assert.ok(ring >= UI_GLYPH, `${theme} --focus-ring on --surface = ${ring.toFixed(2)}:1 < ${UI_GLYPH}:1`);
  }
});

test("--crit carries words on every opaque surface at 4.5:1, in both themes", () => {
  for (const [theme, block, surfaces] of THEMES) {
    for (const surface of surfaces) {
      const ratio = contrastRatio(parseTriplet(block, "--crit"), parseTriplet(block, surface));
      assert.ok(ratio >= AA_NORMAL, `${theme} --crit on ${surface} = ${ratio.toFixed(2)}:1 < ${AA_NORMAL}:1`);
    }
  }
});

test("every tone reads as a glyph on every opaque surface at 3:1, in both themes", () => {
  for (const [theme, block, surfaces] of THEMES) {
    for (const tone of ["--crit", "--warn", "--ok", "--info"]) {
      for (const surface of surfaces) {
        const ratio = contrastRatio(parseTriplet(block, tone), parseTriplet(block, surface));
        assert.ok(ratio >= UI_GLYPH, `${theme} ${tone} on ${surface} = ${ratio.toFixed(2)}:1 < ${UI_GLYPH}:1`);
      }
    }
  }
});

// `--tint-*: rgb(var(--base) / alpha)` in the alias rule → the base token at that alpha, read from each theme's own triplet
function getTintColour(block: string, name: string): Rgba {
  const rule = css.match(/:root,\s*\[data-theme\]\s*\{([^}]*)\}/)?.[1] ?? "";
  const m = rule.match(new RegExp(`${name}\\s*:\\s*rgb\\(var\\((--[\\w-]+)\\)\\s*/\\s*([\\d.]+)\\)`));
  assert.ok(m, `the alias rule must declare ${name} as rgb(var(--token) / alpha)`);
  return { ...parseTriplet(block, m[1]), a: Number(m[2]) };
}

// a ground stack, bottom first: one opaque token, then the tints laid over it → the colour a person sees there
function getGroundColour(block: string, stack: readonly string[]): Rgba {
  const [base, ...tints] = stack;
  return tints.reduce((ground, tint) => compositeOver(getTintColour(block, tint), ground), parseTriplet(block, base));
}

const ON_SELECTED_ROW = ["--elev", "--tint-select"] as const;
// the desk's pairs: text and glyphs on the three tints and the solid badge, the tinted shells on every ground they stand on
const DESK_PAIRS = [
  { name: "ink and dim text on a selected row", fgs: ["--ink", "--dim"], grounds: [ON_SELECTED_ROW], floor: AA_NORMAL },
  { name: "the checkbox edge, the ok glyph and the focus ring on a selected row", fgs: ["--faint", "--ok", "--focus-ring"], grounds: [ON_SELECTED_ROW], floor: UI_GLYPH },
  { name: "the focus ring on the card, the sunken fill and the page", fgs: ["--focus-ring"], grounds: [["--elev"], ["--sunken"], ["--surface"]], floor: UI_GLYPH },
  { name: "solid badge text and primary button text: surface on ink", fgs: ["--surface"], grounds: [["--ink"]], floor: AA_NORMAL },
  { name: "the solid badge shell on the card, a selected row and the nav ground", fgs: ["--ink"], grounds: [["--elev"], ON_SELECTED_ROW, ["--surface"]], floor: UI_GLYPH },
  { name: "tag badge and order bubble text: ink on the tag fill over every ground it stands on", fgs: ["--ink"],
    grounds: [["--elev", "--tint-fill"], ["--sunken", "--tint-fill"], [...ON_SELECTED_ROW, "--tint-fill"], ["--surface", "--tint-fill"]], floor: AA_NORMAL },
  { name: "a failed image's file name in a bubble: dim on the tag fill", fgs: ["--dim"], grounds: [["--elev", "--tint-fill"]], floor: AA_NORMAL },
  { name: "amber badge text and glyph: ink on the warn tint over every ground it stands on", fgs: ["--ink"],
    grounds: [["--elev", "--tint-warn"], ["--sunken", "--tint-warn"], [...ON_SELECTED_ROW, "--tint-warn"]], floor: AA_NORMAL },
  { name: "a checked radio or checkbox on the card, the sunken fill and a band", fgs: ["--selected-fill"], grounds: [["--elev"], ["--sunken"], ["--surface"]], floor: UI_GLYPH },
  { name: "the checkbox mark on its checked fill", fgs: ["--selected-ink"], grounds: [["--selected-fill"]], floor: UI_GLYPH },
] as const;

describe("the desk's tints and badge fills clear their floors, in both themes", () => {
  for (const pair of DESK_PAIRS) {
    test(pair.name, () => {
      for (const [theme, block] of THEMES) {
        for (const fg of pair.fgs) {
          for (const ground of pair.grounds) {
            const ratio = contrastRatio(parseTriplet(block, fg), getGroundColour(block, ground));
            assert.ok(ratio >= pair.floor, `${theme} ${fg} on ${ground.join(" + ")} = ${ratio.toFixed(2)}:1 < ${pair.floor}:1`);
          }
        }
      }
    });
  }
});
