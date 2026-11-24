// Shared type, control and surface atoms in public/styles — the tokens page streams adopt.
// Runner: npx tsx --test test/styles.shared-atoms.unit.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { getReducedMotionCss, getRootBlock, getTripletOrFail } from "./lib/css-source.js";
import { contrastRatio, type Rgba } from "./lib/wcag-contrast.js";

const STYLES = resolve(dirname(fileURLToPath(import.meta.url)), "../public/styles");
const UI_JSX = readFileSync(resolve(STYLES, "../src/ui.jsx"), "utf8");
const TOKENS_CSS = readFileSync(resolve(STYLES, "tokens.css"), "utf8");
const BASE_CSS = readFileSync(resolve(STYLES, "base.css"), "utf8");
const SOURCES = [
  ["tokens.css", TOKENS_CSS],
  ["base.css", BASE_CSS],
] as const;

const CONTROL_FLOOR_PX = 32;
const META_FLOOR_PX = 13;

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

// Custom properties declared in any :root block of either stylesheet.
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

const TOKENS = getRootBlock(TOKENS_CSS);

// each served page → the one stylesheet that holds its :root (sign-in.html loads no tokens.css)
const PAGE_ROOTS = [
  { page: "index.html", root: TOKENS },
  { page: "sign-in.html", root: getRootBlock(readFileSync(resolve(STYLES, "../sign-in.css"), "utf8")) },
];

test("every page declares the one dark colour scheme, so native widgets draw dark under any OS setting", () => {
  for (const { page, root } of PAGE_ROOTS) assert.equal(getDecl(root, "color-scheme"), "dark", page);
});

test("every font size in the shared stylesheets is a whole-pixel step at or above the 13px meta floor", () => {
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

test("the retired micro step renders at the meta floor", () => {
  assert.equal(getPx("var(--fs-micro)"), getPx("var(--fs-meta)"));
});

test("tokens.css is the only place a type step is declared", () => {
  const declared = (source: string) => [...source.matchAll(/(--fs-[\w-]+)\s*:/g)].map((m) => m[1]);
  assert.deepEqual({ base: declared(BASE_CSS), ui: declared(UI_JSX) }, { base: [], ui: [] });
  assert.ok(declared(TOKENS_CSS).includes("--fs-meta"), "tokens.css declares the steps");
});

test("each atom sets the sans face its role names: words, counts, the stat figure and table numbers", () => {
  const rows = [
    { selector: ".pill", isMono: false },
    { selector: ".pill--count", isMono: false },
    { selector: ".stat-value", isMono: false },
    { selector: ".tbl td.num", isMono: false },
  ];
  for (const row of rows) {
    const family = getRuleBodies(BASE_CSS, row.selector)
      .map((b) => getDecl(b, "font-family"))
      .find(Boolean);
    assert.equal(/mono/i.test(family ?? ""), row.isMono, `${row.selector} font-family ${family}`);
  }
});

test("every interactive control atom is at least 32px tall", () => {
  for (const selector of [".btn", ".btn.sm", ".btn.icon", ".seg button", ".pill--interactive", ".field", ".disclosure"]) {
    const heights = getRuleBodies(BASE_CSS, selector).flatMap((b) =>
      ["min-height", "height"].map((p) => getDecl(b, p)).filter((v): v is string => !!v && v !== "auto"),
    );
    // .btn.sm inherits the .btn floor → only an override it declares is checked
    if (selector !== ".btn.sm") assert.ok(heights.length > 0, `${selector} declares a height`);
    for (const h of heights) assert.ok(getPx(h) >= CONTROL_FLOOR_PX, `${selector} height ${h} → ${getPx(h)}px`);
  }
});

test("a pressed toggle keeps its fill and draws an ink edge, never the selected-fill inversion", () => {
  const body = getRuleBodies(BASE_CSS, '.btn[aria-pressed="true"]').join(";");
  assert.match(body, /border-color:\s*rgb\(var\(--ink\)\)/, "edge");
  assert.doesNotMatch(body, /--selected-fill/, "fill");
});

test("a selected segment is a raised thumb on the control edge, on a track with no outer edge", () => {
  for (const selector of ['.seg button[aria-pressed="true"]', '.seg button[aria-checked="true"]', ".seg button.active"]) {
    const body = getRuleBodies(BASE_CSS, selector).join(";");
    assert.match(body, /background:\s*rgb\(var\(--surface-raised-2\)\)/, `${selector} thumb`);
    assert.match(body, /box-shadow:\s*inset 0 0 0 1px rgb\(var\(--control-edge\)\)/, `${selector} edge`);
  }
  assert.doesNotMatch(getRuleBodies(BASE_CSS, ".seg").join(";"), /box-shadow|border:/, ".seg outer edge");
});

test("section and sub-card labels keep sentence case: no uppercase transform or eyebrow tracking", () => {
  for (const selector of [".section-label", ".sub-card-label"]) {
    const body = getRuleBodies(BASE_CSS, selector).join(";");
    assert.doesNotMatch(body, /text-transform:\s*uppercase|letter-spacing/, selector);
  }
});

test("the selected fill reads as text-safe and stands apart from the resting control fill", () => {
  const fill = getTripletOrFail(TOKENS, "--selected-fill");
  const ink = getTripletOrFail(TOKENS, "--selected-ink");
  const elev = getTripletOrFail(TOKENS, "--elev");
  assert.ok(contrastRatio(ink, fill) >= 4.5, `selected ink on fill ${contrastRatio(ink, fill).toFixed(2)}`);
  assert.ok(contrastRatio(fill, elev) >= 3, `selected fill on elev ${contrastRatio(fill, elev).toFixed(2)}`);
});

test("a segmented-control child draws its focus ring inside its own box, so the clipping group cannot hide it", () => {
  const body = getRuleBodies(BASE_CSS, ".seg button:focus-visible").join(";");
  const offset = getDecl(body, "outline-offset") ?? "";
  assert.match(offset, /calc\(\s*var\(--focus-ring-width\)\s*\*\s*-1\s*\)/, `offset ${offset}`);
});

test("an empty stage pip clears 3:1 against every surface it sits on", () => {
  for (const surface of ["--surface", "--elev", "--sunken"]) {
    const ratio = contrastRatio(getTripletOrFail(TOKENS, "--pip-empty"), getTripletOrFail(TOKENS, surface));
    assert.ok(ratio >= 3, `--pip-empty on ${surface} = ${ratio.toFixed(2)}:1`);
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
  // the alert card's tone set → a neutral row draws its glyph in --dim, as a neutral alert card does
  const TONE_TOKEN = { crit: "--crit", warn: "--warn", info: "--info", ok: "--ok", neutral: "--dim" } as const;
  for (const [tone, token] of Object.entries(TONE_TOKEN)) {
    const glyph = getRuleBodies(BASE_CSS, `.alarm-row[data-tone="${tone}"] .alarm-row-glyph`).join(";");
    assert.equal(getDecl(glyph, "color"), `rgb(var(${token}))`, `${tone} glyph tone`);
  }
});

// spec 44084 §5: --surface-raised-2 is 1.08:1 on the sidebar, so the current item takes the select tint instead
test("the current nav item sits on the select tint while hover keeps the sunken fill, both in ink", () => {
  const current = getRuleBodies(BASE_CSS, ".nav-item.active").join(";");
  const hover = getRuleBodies(BASE_CSS, ".nav-item:hover").join(";");
  assert.deepEqual(
    [getDecl(current, "background"), getDecl(current, "color"), getDecl(current, "font-weight")],
    ["var(--tint-select)", "rgb(var(--ink))", "500"],
  );
  assert.deepEqual([getDecl(hover, "background"), getDecl(hover, "color")], ["rgb(var(--sunken))", "rgb(var(--ink))"]);
});

// where the kept count sits (under its icon, never over it) is measured in dashboard.render-density.e2e
test("on the icon rail every nav count after the first is clipped", () => {
  const later = getRuleBodies(BASE_CSS, ".shell-sidebar .nav-count ~ .nav-count").join(";");
  assert.equal(getDecl(later, "clip"), "rect(0 0 0 0)");
});

// spec 44084 §3.2: the row adds up from the control, line and spacing tokens, so a token move keeps the 48 row whole
test("the shared alarm-row geometry takes every length from a token", () => {
  const selectors = [".alert-card-grid", ".alarm-row-glyph", ".alarm-row > .alarm-row-glyph + *"];
  for (const selector of selectors) {
    const bodies = getRuleBodies(BASE_CSS, selector);
    assert.ok(bodies.length > 0, `${selector} has a rule`);
    assert.doesNotMatch(bodies.join(";"), /(?<![\w-])\d+(\.\d+)?(px|rem|em)\b/, `${selector} writes no length literal`);
  }
});

test("an alert card carries its tone only on its bare glyph, and the glyph clears 3:1 on --elev and --sunken", () => {
  const TONE_TOKEN = { crit: "--crit", warn: "--warn", info: "--info", ok: "--ok", neutral: "--dim" } as const;
  const shell = getRuleBodies(BASE_CSS, ".alert-card").join(";");
  const glyph = getRuleBodies(BASE_CSS, ".alert-card-glyph").join(";");

  assert.doesNotMatch(shell, /border|background/, "card shell stays neutral: no stripe, tone fill or tone border");
  assert.equal(getDecl(glyph, "color"), "rgb(var(--alert-tone))", "the glyph is drawn in the card's tone");
  assert.doesNotMatch(glyph, /background|border|box-shadow/, "no well, fill or radius behind the glyph");
  for (const [tone, token] of Object.entries(TONE_TOKEN)) {
    const toneRule = getRuleBodies(BASE_CSS, `.alert-card[data-tone="${tone}"]`).join(";");
    assert.equal(getDecl(toneRule, "--alert-tone"), `var(${token})`, `${tone} → ${token}`);
    for (const ground of ["--elev", "--sunken"]) {
      const ratio = contrastRatio(getTripletOrFail(TOKENS, token), getTripletOrFail(TOKENS, ground));
      assert.ok(ratio >= 3, `${tone} glyph on ${ground} = ${ratio.toFixed(2)}:1`);
    }
  }
});

test("every animated rule in the base layer stops its animation under reduced motion", () => {
  const css = BASE_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const reduced = getReducedMotionCss(BASE_CSS);
  const animated = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => !/^none\b/.test(getDecl(m[2], "animation") ?? "none"))
    .flatMap((m) => m[1].split(",").map((s) => s.trim()));

  assert.ok(animated.length > 0, "the scan finds the base layer's animated rules");
  for (const selector of animated) {
    const gate = getRuleBodies(reduced, selector).join(";");
    assert.match(gate, /animation:\s*none|animation-duration:\s*0\.01ms/, `${selector} stops under prefers-reduced-motion`);
  }
});

test("every transitioning rule in the shared stylesheets drops its transition under reduced motion", () => {
  const transitioned = SOURCES.flatMap(([file, source]) => {
    const reduced = getReducedMotionCss(source);
    return [...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((m) => !/^none\b/.test(getDecl(m[2], "transition") ?? "none"))
      .flatMap((m) => m[1].split(",").map((s) => [file, s.trim(), reduced] as const));
  });

  assert.ok(transitioned.length > 0, "the scan finds the shared transitioning rules");
  for (const [file, selector, reduced] of transitioned) {
    const gate = getRuleBodies(reduced, selector).join(";");
    assert.match(gate, /transition:\s*none/, `${file} ${selector} keeps its transition under prefers-reduced-motion`);
  }
});

// rgb(var(--name)) → its triplet; the white keyword → 255 255 255
function getTokenColor(decl: string | undefined): Rgba {
  if (decl === "white") return { r: 255, g: 255, b: 255, a: 1 };
  const name = decl?.match(/^rgb\(var\((--[\w-]+)\)\)$/)?.[1];
  assert.ok(name, `colour ${decl} is rgb(var(--token)) or white`);
  return getTripletOrFail(TOKENS, name);
}

test("a danger button's label clears 4.5:1 on its crit fill", () => {
  const body = getRuleBodies(BASE_CSS, ".btn.danger").join(";");
  const ratio = contrastRatio(getTokenColor(getDecl(body, "color")), getTokenColor(getDecl(body, "background")));
  assert.ok(ratio >= 4.5, `danger label on fill = ${ratio.toFixed(2)}:1`);
});

test("a transient shell stays neutral in every tone, and a toast's tone rides only on its glyph", () => {
  const toast = getRuleBodies(BASE_CSS, ".doc-toast").join(";");
  assert.equal(getDecl(toast, "background"), "rgb(var(--overlay-surface))", "toast fill is the opaque overlay surface");
  assert.equal(getDecl(toast, "color"), "rgb(var(--ink))", "toast text is ink");
  assert.match(toast, /border(-color)?\s*:[^;]*rgb\(var\(--line\)\)/, "toast edge is the neutral line");

  const glyph = getRuleBodies(BASE_CSS, ".doc-toast-glyph").join(";");
  for (const tone of ["crit", "warn", "info", "ok"]) {
    const toned = getRuleBodies(BASE_CSS, `.doc-toast.${tone}`).join(";");
    assert.doesNotMatch(toned, /(^|[;\s])(background|border|border-color|color)\s*:/, `.doc-toast.${tone} paints its shell or text`);
    assert.equal(getDecl(toned, "--toast-tone"), `var(--${tone})`, `.doc-toast.${tone} names its glyph tone`);
    const ratio = contrastRatio(getTripletOrFail(TOKENS, `--${tone}`), getTripletOrFail(TOKENS, "--overlay-surface"));
    assert.ok(ratio >= 3, `${tone} toast glyph = ${ratio.toFixed(2)}:1`);
  }
  assert.equal(getDecl(glyph, "color"), "rgb(var(--toast-tone))", "the glyph draws the toast's tone");
});

// the Queue draws .prose-pre on every decision text → the block form joins its rule, never restyles it
test("a block machine string wears the fenced block's face from that one rule and adds only a sunken plate at the control radius", () => {
  const fence = getRuleBodies(BASE_CSS, ".prose-pre");
  const block = getRuleBodies(BASE_CSS, ".machine--block");
  assert.ok(block.some((body) => fence.includes(body)), "the block form sits in the fence rule's selector list");
  const plate = block.filter((body) => !fence.includes(body))
    .map((body) => ({ fill: getDecl(body, "background"), inset: getDecl(body, "padding"), radius: getDecl(body, "border-radius") }));
  assert.deepEqual(plate, [{ fill: "rgb(var(--sunken))", inset: "var(--space-2) var(--space-3)", radius: "var(--radius-control)" }]);
});

// a screen rule reaching into an atom's inner part becomes the atom's own variant (spec 44084 §14.2 row 3)
describe("each atom variant a screen names sets only its own declarations, in one rule", () => {
  const rows = [
    { name: "a flush sub-card drops its padding", selector: ".sub-card.flush", decls: { padding: "0" } },
    { name: "a fill card hands its whole body to one self-sizing child, with no cap and no scroller of its own", selector: ".card--fill > .card-body",
      decls: { flex: "1", "max-height": "none", overflow: "hidden", display: "flex", "flex-direction": "column" } },
    { name: "a compact card head sets its title at the control size", selector: ".card-head--compact .card-title", decls: { "font-size": "var(--fs-control)" } },
    { name: "a flush card bar leaves the inset to its content and draws a hairline under it", selector: ".card--bar-flush > .card-bar",
      decls: { padding: "0", "border-bottom": "1px solid rgb(var(--line))" } },
    { name: "an inline-flush empty state keeps its block inset and drops its inline one", selector: ".placeholder--flush-inline", decls: { "padding-inline": "0" } },
    { name: "the row-line key sets only the row line box, doubled to outrank a same-element type step", selector: ".leading-row.leading-row",
      decls: { "line-height": "var(--lh-row)" } },
    { name: "a disclosure body sets only its start inset: the chevron plus the trigger's gap", selector: ".disclosure-body",
      decls: { "padding-inline-start": "calc(14px + var(--space-1))" } },
    { name: "the map-legend count key fits its mark at a 4 inline pad in the crit tone", selector: ".arch-legend-swatch-count",
      decls: { width: "auto", padding: "0 var(--space-1)", "border-color": "rgb(var(--crit))", color: "rgb(var(--crit))" } },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const bodies = getRuleBodies(BASE_CSS, row.selector);
      const decls = bodies.map((body) => Object.fromEntries([...body.matchAll(/([\w-]+)\s*:\s*([^;]+)/g)].map((m) => [m[1], m[2].trim()])));
      assert.deepEqual(decls, [row.decls]);
    });
  }
});

test("a flush sub-card and a flush card body share the one flush rule", () => {
  const cardBody = getRuleBodies(BASE_CSS, ".card-body.flush");
  assert.ok(getRuleBodies(BASE_CSS, ".sub-card.flush").some((body) => cardBody.includes(body)));
});

// a label-only body row (a ledger group-label th spanning the row) would otherwise stop at its 36px line box
test("a body row header takes the same row step as a body cell", () => {
  const cell = getRuleBodies(BASE_CSS, ".tbl td").map((body) => getDecl(body, "height")).filter(Boolean);
  const rowHeader = getRuleBodies(BASE_CSS, ".tbl tbody th").map((body) => getDecl(body, "height")).filter(Boolean);
  assert.deepEqual(rowHeader, ["var(--row-h)"]);
  assert.ok(cell.includes("var(--row-h)"), "the body cell keeps the row step");
});
