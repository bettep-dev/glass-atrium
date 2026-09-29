// Shared type, control and surface atoms in public/styles — the tokens page streams adopt.
// Runner: npx tsx --test test/styles.shared-atoms.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { contrastRatio, type Rgba } from "./lib/wcag-contrast.js";

const STYLES = resolve(dirname(fileURLToPath(import.meta.url)), "../public/styles");
const TOKENS_CSS = readFileSync(resolve(STYLES, "tokens.css"), "utf8");
const BASE_CSS = readFileSync(resolve(STYLES, "base.css"), "utf8");
const SOURCES = [
  ["tokens.css", TOKENS_CSS],
  ["base.css", BASE_CSS],
] as const;

const CONTROL_FLOOR_PX = 32;
const META_FLOOR_PX = 12;

function getBlock(source: string, selector: string): string {
  const open = source.indexOf("{", source.indexOf(selector));
  return source.slice(open + 1, source.indexOf("}", open));
}

// Every rule whose comma-separated selector list names `selector` exactly.
function getRuleBodies(source: string, selector: string): string[] {
  const bodies: string[] = [];
  for (const m of source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(",").some((s) => s.trim() === selector)) bodies.push(m[2]);
  }
  return bodies;
}

function getDecl(body: string, prop: string): string | undefined {
  return body.match(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`))?.[1].trim();
}

// Custom properties declared in any light-theme :root block of either stylesheet.
function getRootVars(): Map<string, string> {
  const vars = new Map<string, string>();
  for (const [, css] of SOURCES) {
    for (const m of css.matchAll(/(?:^|\n):root\s*\{([^}]*)\}/g)) {
      for (const d of m[1].replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        vars.set(d[1], d[2].trim());
      }
    }
  }
  return vars;
}
const ROOT_VARS = getRootVars();

function resolveVars(value: string, depth = 0): string {
  assert.ok(depth < 8, `var() chain too deep: ${value}`);
  const next = value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/, (_, name: string, fallback?: string) => {
    const hit = ROOT_VARS.get(name) ?? fallback;
    assert.ok(hit !== undefined, `${name} is declared nowhere and has no fallback`);
    return hit;
  });
  return next === value ? value : resolveVars(next, depth + 1);
}

function getPx(value: string): number {
  const m = resolveVars(value).match(/^(\d+(?:\.\d+)?)px$/);
  assert.ok(m, `${value} does not resolve to a px length`);
  return Number(m[1]);
}

function getTriplet(block: string, name: string): Rgba {
  const m = block.match(new RegExp(`${name}\\s*:\\s*(\\d{1,3})\\s+(\\d{1,3})\\s+(\\d{1,3})`));
  assert.ok(m, `theme block declares ${name} as an RGB triplet`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: 1 };
}

const THEMES = [
  ["light", getBlock(TOKENS_CSS, ":root")],
  ["dark", getBlock(TOKENS_CSS, '[data-theme="dark"]')],
] as const;

test("every font size in the shared stylesheets is a whole-pixel step at or above the 12px meta floor", () => {
  const offenders: string[] = [];
  for (const [file, css] of SOURCES) {
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?<![\w-])font-size\s*:\s*([^;}]+)/g)) {
      const px = getPx(m[1].trim());
      if (!Number.isInteger(px) || px < META_FLOOR_PX) offenders.push(`${file}: font-size ${m[1].trim()} → ${px}px`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the named type steps descend strictly and bottom out at the meta floor", () => {
  const steps = ["--fs-display", "--fs-stat", "--fs-title", "--fs-body", "--fs-control", "--fs-meta"].map((name) =>
    getPx(`var(${name})`),
  );
  for (let i = 1; i < steps.length; i += 1) assert.ok(steps[i - 1] > steps[i], `step ${i} ${steps.join(" > ")}`);
  assert.equal(steps.at(-1), META_FLOOR_PX);
});

test("mono stays on numeric atoms and off word-carrying atoms", () => {
  const rows = [
    { selector: ".pill", isMono: false },
    { selector: ".pill--count", isMono: true },
    { selector: ".kpi-value", isMono: true },
    { selector: ".tbl td.num", isMono: true },
  ];
  for (const row of rows) {
    const family = getRuleBodies(BASE_CSS, row.selector)
      .map((b) => getDecl(b, "font-family"))
      .find(Boolean);
    assert.equal(/mono/i.test(family ?? ""), row.isMono, `${row.selector} font-family ${family}`);
  }
});

test("every interactive control atom is at least 32px tall", () => {
  for (const selector of [".btn", ".btn.sm", ".btn.icon", ".seg button", ".tab", ".pill--interactive", ".field"]) {
    const heights = getRuleBodies(BASE_CSS, selector).flatMap((b) =>
      ["min-height", "height"].map((p) => getDecl(b, p)).filter((v): v is string => !!v && v !== "auto"),
    );
    // .btn.sm inherits the .btn floor → only an override it declares is checked
    if (selector !== ".btn.sm") assert.ok(heights.length > 0, `${selector} declares a height`);
    for (const h of heights) assert.ok(getPx(h) >= CONTROL_FLOOR_PX, `${selector} height ${h} → ${getPx(h)}px`);
  }
});

test("every pressed or selected control draws the one filled selected-state token", () => {
  const selectors = [
    '.btn[aria-pressed="true"]',
    '.seg button[aria-pressed="true"]',
    ".seg button.active",
    '.tab[aria-selected="true"]',
    ".tab.active",
    '.pill--interactive[aria-pressed="true"]',
  ];
  for (const selector of selectors) {
    const body = getRuleBodies(BASE_CSS, selector).join(";");
    assert.match(body, /background:\s*rgb\(var\(--selected-fill\)\)/, `${selector} fill`);
    assert.match(body, /color:\s*rgb\(var\(--selected-ink\)\)/, `${selector} ink`);
  }
});

test("the selected fill reads as text-safe and stands apart from the resting control fill in both themes", () => {
  for (const [theme, block] of THEMES) {
    const fill = getTriplet(block, "--selected-fill");
    const ink = getTriplet(block, "--selected-ink");
    const elev = getTriplet(block, "--elev");
    assert.ok(contrastRatio(ink, fill) >= 4.5, `${theme} selected ink on fill ${contrastRatio(ink, fill).toFixed(2)}`);
    assert.ok(contrastRatio(fill, elev) >= 3, `${theme} selected fill on elev ${contrastRatio(fill, elev).toFixed(2)}`);
  }
});

test("a segmented-control child draws its focus ring inside its own box, so the clipping group cannot hide it", () => {
  const body = getRuleBodies(BASE_CSS, ".seg button:focus-visible").join(";");
  const offset = getDecl(body, "outline-offset") ?? "";
  assert.match(offset, /calc\(\s*var\(--focus-ring-width\)\s*\*\s*-1\s*\)/, `offset ${offset}`);
});

test("an empty stage pip clears 3:1 against every surface it sits on, in both themes", () => {
  for (const [theme, block] of THEMES) {
    const pip = getTriplet(block, "--pip-empty");
    for (const surface of ["--surface", "--elev", "--sunken"]) {
      const ratio = contrastRatio(pip, getTriplet(block, surface));
      assert.ok(ratio >= 3, `${theme} --pip-empty on ${surface} = ${ratio.toFixed(2)}:1`);
    }
  }
  const pip = getRuleBodies(BASE_CSS, ".stage-pip").join(";");
  assert.match(pip, /background:\s*rgb\(var\(--pip-empty\)\)/);
  assert.ok(getPx(getDecl(pip, "width") ?? "") >= 8 && getPx(getDecl(pip, "height") ?? "") >= 8, "pip is ≥8px square");
});

test("every corner radius in base.css comes from a role token", () => {
  const offenders: string[] = [];
  for (const m of BASE_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
    const value = m[1].trim();
    const alias = ROOT_VARS.get(value.match(/^var\((--[\w-]+)\)$/)?.[1] ?? "") ?? value; // --ctl-radius → role token
    const isRole = (v: string) => /^(var\(--radius-[\w-]+\)|0|999px|50%|inherit)$/.test(v);
    if (!isRole(value) && !isRole(alias)) offenders.push(value);
  }
  assert.deepEqual(offenders, []);
  const roles = ["--radius-inline", "--radius-control", "--radius-tile", "--radius-card"].map((r) => getPx(`var(${r})`));
  for (let i = 1; i < roles.length; i += 1) assert.ok(roles[i] > roles[i - 1], `radius roles ascend: ${roles.join(" < ")}`);
});

test("an alarm row is a flat hairline row whose tone rides on its glyph, never a left stripe or tinted fill", () => {
  const row = getRuleBodies(BASE_CSS, ".alarm-row").join(";");
  assert.match(row, /border-bottom:\s*1px solid rgb\(var\(--line\)\)/);
  assert.doesNotMatch(row, /border-left|background:\s*rgb\(var\(--(crit|warn|info|ok)\)/);
  for (const tone of ["crit", "warn", "info", "ok"]) {
    const glyph = getRuleBodies(BASE_CSS, `.alarm-row[data-tone="${tone}"] .alarm-row-glyph`).join(";");
    assert.match(glyph, new RegExp(`color:\\s*rgb\\(var\\(--${tone}\\)\\)`), `${tone} glyph tone`);
  }
});
