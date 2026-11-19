// Token contrast floors in public/styles/tokens.css, the one :root block parsed from the shipped file.
// Runner: npx tsx --test test/tokens.contrast.unit.test.ts
// Body/primary text on --surface ≥ 4.5. --crit carries words (form errors, destructive labels) → ≥ 4.5 on every
// opaque surface; every tone is at least a glyph → ≥ 3.0 there.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { getRootBlock, getTripletOrFail } from "./lib/css-source.js";
import { compositeOver, contrastRatio, type Rgba } from "./lib/wcag-contrast.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_CSS = resolve(__dirname, "../public/styles/tokens.css");

const css = readFileSync(TOKENS_CSS, "utf8");

const root = getRootBlock(css);
const surface = getTripletOrFail(root, "--surface");
const dim = getTripletOrFail(root, "--dim");
const ink = getTripletOrFail(root, "--ink");

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

const SURFACES = ["--elev", "--surface", "--sunken", "--elev-2"] as const;
const UI_GLYPH = 3;

// `--name: var(--target)` in the :root block → the target's name, since the triplet parser reads literals only
function getAliasTarget(name: string): string {
  const target = root.match(new RegExp(`${name}\\s*:\\s*var\\((--[\\w-]+)\\)`))?.[1];
  assert.ok(target, `the :root block must declare ${name} as the var() of one token`);
  return target;
}

test("the resting control edge of toggles and fields clears 3:1 against every surface it sits on", () => {
  const edge = getAliasTarget("--control-edge");
  for (const ground of SURFACES) {
    const ratio = contrastRatio(getTripletOrFail(root, edge), getTripletOrFail(root, ground));
    assert.ok(ratio >= UI_GLYPH, `--control-edge (${edge}) on ${ground} = ${ratio.toFixed(2)}:1 < ${UI_GLYPH}:1`);
  }
});

test("the hover edge stays a visible step above the resting control edge", () => {
  const edge = getAliasTarget("--control-edge");
  const elev = getTripletOrFail(root, "--elev");
  const rest = contrastRatio(getTripletOrFail(root, edge), elev);
  const hover = contrastRatio(getTripletOrFail(root, "--faint"), elev);
  assert.ok(hover > rest, `hover --faint ${hover.toFixed(2)}:1 must exceed the resting edge ${rest.toFixed(2)}:1 on --elev`);
});

// text the base looks set on the sunken track and the raised thumb clears 4.5:1 on every surface; the focus ring clears 3:1 on the page
test("base-look text and the focus ring clear their floors on every surface they sit on", () => {
  for (const fg of ["--ink", "--dim", "--faint", "--accent"]) {
    for (const ground of SURFACES) {
      const ratio = contrastRatio(getTripletOrFail(root, fg), getTripletOrFail(root, ground));
      assert.ok(ratio >= AA_NORMAL, `${fg} on ${ground} = ${ratio.toFixed(2)}:1 < ${AA_NORMAL}:1`);
    }
  }
  const ring = contrastRatio(getTripletOrFail(root, "--focus-ring"), surface);
  assert.ok(ring >= UI_GLYPH, `--focus-ring on --surface = ${ring.toFixed(2)}:1 < ${UI_GLYPH}:1`);
});

test("--crit carries words on every opaque surface at 4.5:1", () => {
  for (const ground of SURFACES) {
    const ratio = contrastRatio(getTripletOrFail(root, "--crit"), getTripletOrFail(root, ground));
    assert.ok(ratio >= AA_NORMAL, `--crit on ${ground} = ${ratio.toFixed(2)}:1 < ${AA_NORMAL}:1`);
  }
});

test("every tone reads as a glyph on every opaque surface at 3:1", () => {
  for (const tone of ["--crit", "--warn", "--ok", "--info"]) {
    for (const ground of SURFACES) {
      const ratio = contrastRatio(getTripletOrFail(root, tone), getTripletOrFail(root, ground));
      assert.ok(ratio >= UI_GLYPH, `${tone} on ${ground} = ${ratio.toFixed(2)}:1 < ${UI_GLYPH}:1`);
    }
  }
});

// `--tint-*: rgb(var(--base) / alpha)` → the base token at that alpha
function getTintColour(name: string): Rgba {
  const m = root.match(new RegExp(`${name}\\s*:\\s*rgb\\(var\\((--[\\w-]+)\\)\\s*/\\s*([\\d.]+)\\)`));
  assert.ok(m, `the :root block must declare ${name} as rgb(var(--token) / alpha)`);
  return { ...getTripletOrFail(root, m[1]), a: Number(m[2]) };
}

// a ground stack, bottom first: one opaque token, then the tints laid over it → the colour a person sees there
function getGroundColour(stack: readonly string[]): Rgba {
  const [base, ...tints] = stack;
  return tints.reduce((ground, tint) => compositeOver(getTintColour(tint), ground), getTripletOrFail(root, base));
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

interface ContrastPair {
  readonly name: string;
  readonly fgs: readonly string[];
  readonly grounds: readonly (readonly string[])[];
  readonly floor: number;
}

function assertPairFloors(pair: ContrastPair): void {
  for (const fg of pair.fgs) {
    for (const ground of pair.grounds) {
      const ratio = contrastRatio(getTripletOrFail(root, fg), getGroundColour(ground));
      assert.ok(ratio >= pair.floor, `${fg} on ${ground.join(" + ")} = ${ratio.toFixed(2)}:1 < ${pair.floor}:1`);
    }
  }
}

describe("the desk's tints and badge fills clear their floors", () => {
  for (const pair of DESK_PAIRS) {
    test(pair.name, () => assertPairFloors(pair));
  }
});

const ROW_LADDER = ["--tint-row-1", "--tint-row-2", "--tint-row-3"] as const;
// the Documents ledger row states on the card: what a row holds — text, the tone glyphs and the empty stage pip
const ROW_LADDER_PAIRS: readonly ContrastPair[] = [
  { name: "ink, dim and faint text on every row-state fill", fgs: ["--ink", "--dim", "--faint"], grounds: ROW_LADDER.map((tint) => ["--elev", tint]), floor: AA_NORMAL },
  { name: "the crit and warn glyphs and the empty stage pip on every row-state fill", fgs: ["--crit", "--warn", "--pip-empty"], grounds: ROW_LADDER.map((tint) => ["--elev", tint]), floor: UI_GLYPH },
];

describe("the Documents row-state ladder keeps every row mark above its floor", () => {
  for (const pair of ROW_LADDER_PAIRS) {
    test(pair.name, () => assertPairFloors(pair));
  }
});

test("the chart data colour reads as a mark on the card, the page and the sunken fill at 3:1", () => {
  assertPairFloors({ name: "--data", fgs: ["--data"], grounds: [["--elev"], ["--surface"], ["--sunken"]], floor: UI_GLYPH });
});

const HEAT_RAMP = ["--heat-1", "--heat-2", "--heat-3", "--heat-4"] as const;
const HEAT_STEP_MIN = 1.4;

describe("the hour-grid heat ramp on the card", () => {
  test("its lowest step reads as a mark against the card at 3:1", () => {
    const ratio = contrastRatio(getGroundColour(["--elev", HEAT_RAMP[0]]), getTripletOrFail(root, "--elev"));
    assert.ok(ratio >= UI_GLYPH, `${HEAT_RAMP[0]} on --elev = ${ratio.toFixed(2)}:1 < ${UI_GLYPH}:1`);
  });

  test("each step stands apart from the step below it by 1.4:1", () => {
    const steps = HEAT_RAMP.map((heat) => getGroundColour(["--elev", heat]));
    for (let i = 1; i < steps.length; i++) {
      const ratio = contrastRatio(steps[i], steps[i - 1]);
      assert.ok(ratio >= HEAT_STEP_MIN, `${HEAT_RAMP[i]} over ${HEAT_RAMP[i - 1]} = ${ratio.toFixed(2)}:1 < ${HEAT_STEP_MIN}:1`);
    }
  });
});
