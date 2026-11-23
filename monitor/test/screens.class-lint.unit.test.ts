// Screen class-string lock: the plan-owned screens take spacing, type and colour only through role keys,
// atoms and tokens. Read as a syntax tree, never evaluated; queue.jsx stays outside (the Queue track owns it).

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

import { getCssRules, getReducedMotionCss } from "./lib/css-source.js";
import { ROLE_PREFIXES, getRoleKeys, type RoleSection } from "./lib/role-keys.js";

const SCREEN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../public/src/screens");
const SCREENS = [
  "agents", "architecture", "clauded-docs", "cost", "dashboard",
  "improvement", "improvement-instrumentation", "model-config", "outcomes", "remote-access", "wiki",
];

// design.md §12.1 W1-T3 names · §12.11 and base.css deprecations · the deleted verdict, KPI and split-tile classes
const RETIRED_CLASS = /^(?:gap-card|space-cards|space-sections|pill--ctl-h|placeholder|hero-stat|live-dot|page-verdict(?:-\S+)?|kpi(?:-\S+)?|tile-split(?:-\S+)?)$/;
const RETIRED_PROPERTY = /--(?:fs-kpi|kpi-spark-w|tile-split-detail-basis|radius-badge|fs-micro)\b/g;

const SPACING_PREFIXES = [
  ...Object.values(ROLE_PREFIXES).flatMap((prefixes) => Object.keys(prefixes)),
  "ps", "pe", "ms", "me",
];
const RESET_PREFIXES = [...Object.keys(ROLE_PREFIXES.padding), ...Object.keys(ROLE_PREFIXES.margin), "ps", "pe", "ms", "me"];
const VARIANTS = "(?:[a-z0-9-]+:|\\[[^\\]]+\\]:)*";
const NUMERIC_SPACING = new RegExp(`^${VARIANTS}-?(?:${SPACING_PREFIXES.join("|")})-(?:\\d+(?:\\.\\d+)?|px|\\[[^\\]]+\\])$`);
const ZERO_RESET = new RegExp(`^${VARIANTS}-?(?:${RESET_PREFIXES.join("|")})-0$`);
const CASE_TRACKING_ITALIC = new RegExp(`^${VARIANTS}(?:uppercase|italic|tracking-\\S+)$`);
const FONT_MONO = new RegExp(`^${VARIANTS}font-mono$`);
const RAW_COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(\s*[-\d.]/i;
const STYLE_SPACING = /^(?:padding|margin|gap|row-gap|column-gap|grid-gap)(?:-|$)/;
const STYLE_TYPE = /^(?:font|line-height|letter-spacing|text-transform|word-spacing)(?:-|$)/;
const INLINE_SPACING = /^(?:padding|margin|gap|rowGap|columnGap)/;
const RAW_TABLE_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col"]);

interface Site { text: string; line: number }
interface StyleDecl { selector: string; prop: string; value: string; line: number }
interface ScreenSource { classWords: Site[]; styleText: string; styleDecls: StyleDecl[]; inlineStyles: StyleDecl[]; tags: Site[] }

// rule name → the hits it finds in one screen; a later ruling drops or narrows a rule here, in one place
const RULES: Record<string, (source: ScreenSource) => string[]> = {
  "numeric-spacing": (source) => getClassHits(source, (word) => NUMERIC_SPACING.test(word) && !ZERO_RESET.test(word)),
  "zero-reset": (source) => getClassHits(source, (word) => ZERO_RESET.test(word)),
  "role-key-family": (source) => getClassHits(source, isRoleKeyOutsideFamily),
  "inline-spacing": (source) => source.inlineStyles.filter((d) => INLINE_SPACING.test(d.prop)).map(formatDecl),
  "retired-class": (source) => getClassHits(source, (word) => RETIRED_CLASS.test(word)),
  "retired-property": getRetiredProperties,
  "case-tracking-italic": (source) => getClassHits(source, (word) => CASE_TRACKING_ITALIC.test(word)),
  "font-mono": (source) => getClassHits(source, (word) => FONT_MONO.test(word)),
  "raw-table": (source) => source.tags.filter((site) => RAW_TABLE_TAGS.has(site.text)).map(formatSite),
  "style-spacing-type": (source) =>
    source.styleDecls.filter((d) => STYLE_SPACING.test(d.prop) || STYLE_TYPE.test(d.prop)).map(formatDecl),
  "raw-colour": getRawColours,
};

interface BaselineRow { rule: string; count: number; owner: string }

// pairs still red; a count above its row fails, a count below it fails until the row is lowered, a row at zero is deleted
// one block per screen, so lanes lowering their own screen's rows do not collide
const BASELINE: Record<string, BaselineRow[]> = {
  agents: [
    { rule: "inline-spacing", count: 6, owner: "B3" },
    { rule: "retired-class", count: 3, owner: "B3" },
  ],
  architecture: [
    { rule: "numeric-spacing", count: 4, owner: "C3" },
    { rule: "zero-reset", count: 2, owner: "C3" },
    { rule: "inline-spacing", count: 2, owner: "C3" },
    { rule: "retired-class", count: 1, owner: "C3" },
    { rule: "font-mono", count: 13, owner: "C3" },
    { rule: "style-spacing-type", count: 79, owner: "C3" },
  ],
  "clauded-docs": [
    { rule: "retired-property", count: 4, owner: "B6" },
    { rule: "style-spacing-type", count: 45, owner: "B6" },
    { rule: "raw-colour", count: 14, owner: "B6" },
  ],
  cost: [
    { rule: "zero-reset", count: 1, owner: "B1" },
    { rule: "inline-spacing", count: 1, owner: "B1" },
  ],
  dashboard: [
    { rule: "numeric-spacing", count: 1, owner: "C1" },
    { rule: "zero-reset", count: 1, owner: "C1" },
    { rule: "retired-class", count: 2, owner: "C1" },
    { rule: "font-mono", count: 1, owner: "C1" },
    { rule: "style-spacing-type", count: 10, owner: "C1" },
  ],
  improvement: [
    { rule: "numeric-spacing", count: 84, owner: "C2" },
    { rule: "zero-reset", count: 2, owner: "C2" },
    { rule: "inline-spacing", count: 1, owner: "C2" },
    { rule: "retired-class", count: 4, owner: "C2" },
    { rule: "font-mono", count: 4, owner: "C2" },
    { rule: "raw-table", count: 24, owner: "C2" },
    { rule: "style-spacing-type", count: 21, owner: "C2" },
  ],
  "model-config": [
    { rule: "raw-table", count: 11, owner: "B5" },
  ],
  outcomes: [
    { rule: "zero-reset", count: 5, owner: "B2" },
    { rule: "retired-class", count: 1, owner: "B2" },
    { rule: "style-spacing-type", count: 38, owner: "B2" },
  ],
};

const roleKeys = getRoleKeys();
const sources = new Map(SCREENS.map((name) => [name, readScreen(name)]));

describe("screen class-string hits hold at their baseline row, and a pair with no row stays clean", () => {
  for (const [name, source] of sources) {
    for (const [rule, getHits] of Object.entries(RULES)) {
      test(`${name}.jsx ${rule} hits equal its baseline count`, () => {
        const hits = getHits(source);
        const expected = BASELINE[name]?.find((row) => row.rule === rule)?.count ?? 0;
        assert.equal(hits.length, expected, getRatchetMessage(hits, expected));
      });
    }
  }

  test("every baseline row names a linted screen and rule once, with a count above zero and an owner", () => {
    const rows = Object.entries(BASELINE).flatMap(([name, block]) => block.map((row) => ({ name, ...row })));
    const invalid = rows.filter((row, i) =>
      !sources.has(row.name) || !(row.rule in RULES) || row.count < 1 || !row.owner ||
      rows.findIndex((other) => other.name === row.name && other.rule === row.rule) !== i,
    );
    assert.deepEqual(invalid, []);
  });
});

// the motion rules a screen <style> keeps until the follow-up motion item retires them
const MOTION_ROWS = [
  { screen: "dashboard", selector: ".ga-spin", prop: "animation", keyframes: "ga-spin", arm: ".ga-spin" },
  { screen: "improvement", selector: ".i-act-spin", prop: "animation", keyframes: "spinI", arm: ".i-act-spin" },
  { screen: "clauded-docs", selector: ".doc-action-spinner", prop: "animation", keyframes: "docSpinCD", arm: ".doc-action-spinner" },
  { screen: "clauded-docs", selector: ".doc-row", prop: "transition", arm: ".doc-row" },
  { screen: "clauded-docs", selector: ".tbl.doc-ledger-busy", prop: "transition", arm: ".tbl.doc-ledger-busy" },
  { screen: "outcomes", selector: ".skel-pulse-o", prop: "animation", keyframes: "skelPulseO", arm: ".skel-pulse-o" },
  { screen: "outcomes", selector: ".outcome-row", prop: "transition", arm: ".outcome-row" },
  { screen: "architecture", selector: " .node > ", prop: "transition", arm: ".arch-mermaid-canvas .node > *" },
];

describe("the named screen motion rules keep their reduced-motion arm", () => {
  for (const row of MOTION_ROWS) {
    test(`${row.screen}.jsx ${row.selector.trim()} ${row.prop}`, () => {
      const source = sources.get(row.screen);
      assert.ok(source, `${row.screen} is not a linted screen`);
      const moving = source.styleDecls.filter((d) => d.selector.includes(row.selector) && d.prop === row.prop && !/^none\b/.test(d.value));
      assert.ok(moving.length > 0, `${row.selector} lost its ${row.prop}`);
      if (row.keyframes) assert.match(source.styleText, new RegExp(`@keyframes\\s+${row.keyframes}\\s*\\{`));
      const arms = getCssRules(getReducedMotionCss(source.styleText)).filter(([selector]) => selector === row.arm);
      assert.ok(arms.some(([, body]) => body.includes(row.prop)), `${row.arm} lost its reduced-motion ${row.prop} arm`);
    });
  }
});

function getRatchetMessage(hits: string[], expected: number): string {
  if (hits.length < expected) return `${hits.length} hits under a baseline of ${expected}: lower the row to the new count, delete it at zero`;
  const advice = expected ? `above its baseline of ${expected}: convert the new hits` : "with no baseline row: the pair stays clean";
  return `${hits.length} hits ${advice}\n${hits.join("\n")}`;
}

function readScreen(name: string): ScreenSource {
  const file = ts.createSourceFile(`${name}.jsx`, readFileSync(resolve(SCREEN_DIR, `${name}.jsx`), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const consts = getConstInitializers(file);
  const source: ScreenSource = { classWords: [], styleText: "", styleDecls: [], inlineStyles: [], tags: [] };
  const styleTexts: string[] = [];
  const visit = (node: ts.Node): void => {
    readNode(node, file, consts, source, styleTexts);
    ts.forEachChild(node, visit);
  };
  visit(file);
  source.styleText = styleTexts.join("\n");
  return source;
}

function readNode(node: ts.Node, file: ts.SourceFile, consts: Map<string, ts.Expression[]>, source: ScreenSource, styleTexts: string[]): void {
  if ((ts.isJsxAttribute(node) || ts.isPropertyAssignment(node)) && /classname$/i.test(node.name.getText(file)) && node.initializer) {
    for (const site of getStrings(node.initializer, consts)) {
      for (const text of site.text.split(/\s+/).filter(Boolean)) source.classWords.push({ text, line: site.line });
    }
  }
  if (ts.isJsxAttribute(node) && node.name.getText(file) === "style" && node.initializer) {
    source.inlineStyles.push(...getInlineStyle(node.initializer, consts));
  }
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    source.tags.push({ text: node.tagName.getText(file), line: getLine(node) });
  }
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === "style") {
    const css = node.children.flatMap((child) => getStrings(child, consts)).map((site) => site.text).join("");
    styleTexts.push(css);
    source.styleDecls.push(...getDecls(css, getLine(node)));
  }
}

// every `name = <initializer>` in the file, any scope; a className or <style> naming one reads through it
function getConstInitializers(file: ts.SourceFile): Map<string, ts.Expression[]> {
  const found = new Map<string, ts.Expression[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      found.set(node.name.text, [...(found.get(node.name.text) ?? []), node.initializer]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function getStrings(root: ts.Node, consts: Map<string, ts.Expression[]>, seen = new Set<ts.Node>()): Site[] {
  if (seen.has(root)) return [];
  seen.add(root);
  if (ts.isStringLiteral(root) || ts.isNoSubstitutionTemplateLiteral(root) || ts.isTemplateLiteralToken(root) || ts.isJsxText(root)) {
    return [{ text: root.text, line: getLine(root) }];
  }
  if (ts.isIdentifier(root)) return (consts.get(root.text) ?? []).flatMap((init) => getStrings(init, consts, seen));
  const sites: Site[] = [];
  ts.forEachChild(root, (child) => {
    if (!ts.isPropertyAccessExpression(root) || child === root.expression) sites.push(...getStrings(child, consts, seen));
  });
  return sites;
}

function getInlineStyle(initializer: ts.Node, consts: Map<string, ts.Expression[]>): StyleDecl[] {
  let node: ts.Node | undefined = ts.isJsxExpression(initializer) ? initializer.expression : initializer;
  if (node && ts.isIdentifier(node)) node = consts.get(node.text)?.find(ts.isObjectLiteralExpression);
  if (!node || !ts.isObjectLiteralExpression(node)) return [];
  return node.properties.filter(ts.isPropertyAssignment).map((prop) => ({
    selector: "style",
    prop: prop.name.getText(),
    value: ts.isStringLiteralLike(prop.initializer) ? prop.initializer.text : prop.initializer.getText(),
    line: getLine(prop),
  }));
}

function getDecls(css: string, line: number): StyleDecl[] {
  return getCssRules(css.replace(/\/\*[\s\S]*?\*\//g, "")).flatMap(([selector, body]) =>
    body.split(";").map((decl) => decl.split(":")).filter((parts) => parts.length > 1).map(([prop, ...value]) => ({
      selector, prop: prop.trim().toLowerCase(), value: value.join(":").trim(), line,
    })),
  );
}

function getClassHits(source: ScreenSource, isHit: (word: string) => boolean): string[] {
  return source.classWords.filter((site) => isHit(site.text)).map(formatSite);
}

function getRetiredProperties(source: ScreenSource): string[] {
  const texts = [source.styleText, ...source.inlineStyles.map((d) => d.value), ...source.classWords.map((site) => site.text)];
  return texts.flatMap((text) => [...text.matchAll(RETIRED_PROPERTY)].map((m) => m[0]));
}

function getRawColours(source: ScreenSource): string[] {
  const decls = [...source.styleDecls, ...source.inlineStyles].filter((d) => RAW_COLOUR.test(d.value));
  return [...decls.map(formatDecl), ...getClassHits(source, (word) => /\[/.test(word) && RAW_COLOUR.test(word))];
}

function isRoleKeyOutsideFamily(word: string): boolean {
  const bare = word.replace(new RegExp(`^${VARIANTS}-?`), "");
  return (Object.entries(ROLE_PREFIXES) as Array<[RoleSection, Record<string, string[]>]>).some(([section, prefixes]) =>
    Object.keys(prefixes).some((prefix) => {
      if (!bare.startsWith(`${prefix}-`)) return false;
      const key = bare.slice(prefix.length + 1);
      const isRoleKey = Object.values(roleKeys).some((keys) => key in keys);
      return isRoleKey && !(key in roleKeys[section]);
    }),
  );
}

function getLine(node: ts.Node): number {
  return node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function formatSite(site: Site): string {
  return `${site.text} @ line ${site.line}`;
}

function formatDecl(decl: StyleDecl): string {
  return `${decl.selector} { ${decl.prop}: ${decl.value} } @ line ${decl.line}`;
}
