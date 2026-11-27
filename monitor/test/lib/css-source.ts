// CSS-source probes shared by the static stylesheet suites (tokens.css, base.css, the Tweaks panel, screen style blocks).

import assert from "node:assert/strict";

import type { Rgba } from "./wcag-contrast.js";

/** Body of the top-level `:root` block, comments stripped — never a `:root` nested in an @media block; "" when absent. */
export function getRootBlock(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").match(/(?:^|\n):root\s*\{([^}]*)\}/)?.[1] ?? "";
}

/** `name: R G B;` in a declaration block → that token as an opaque colour. */
export function getTripletOrFail(block: string, name: string): Rgba {
  const m = block.match(new RegExp(`(?:^|[\\s;])${name}\\s*:\\s*(\\d{1,3})\\s+(\\d{1,3})\\s+(\\d{1,3})\\s*;`));
  assert.ok(m, `${name} is not declared as an R G B triplet in the :root block`);
  const [r, g, b] = m.slice(1, 4).map(Number);
  assert.ok([r, g, b].every((c) => c <= 255), `${name} has a channel above 255`);
  return { r, g, b, a: 1 };
}

/** The rules inside every `@media (prefers-reduced-motion: reduce)` block, comments stripped. */
export function getReducedMotionCss(source: string): string {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: string[] = [];
  for (const m of css.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let end = start;
    for (; end < css.length && depth > 0; end++) depth += css[end] === "{" ? 1 : css[end] === "}" ? -1 : 0;
    blocks.push(css.slice(start, end - 1));
  }
  return blocks.join("\n");
}

/** [selector, body] for every flat rule of a stylesheet; nested @-blocks contribute their inner rules. */
export function getCssRules(css: string): Array<[string, string]> {
  return getCssRuleLists(css).flatMap(([selectors, body]) => selectors.map((selector) => [selector, body] as [string, string]));
}

/** [selector list, body] for every flat rule — a comma inside `:is()` / `:not()` parentheses stays in its selector. */
export function getCssRuleLists(css: string): Array<[string[], string]> {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [getSelectorList(m[1]), m[2]]);
}

function getSelectorList(prelude: string): string[] {
  const selectors = [""];
  let depth = 0;
  for (const char of prelude) {
    depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    if (char === "," && depth === 0) selectors.push("");
    else selectors[selectors.length - 1] += char;
  }
  return selectors.map((selector) => selector.trim());
}
