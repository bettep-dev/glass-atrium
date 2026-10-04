// Behaviour of the dev-only Tweaks panel's own stylesheet (the __TWEAKS_STYLE string tweaks-panel.jsx mounts).
//
// Runner: npx tsx --test test/tweaks-panel.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadScreenModule } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TWEAKS_SRC = resolve(__dirname, "../public/src/tweaks-panel.jsx");

// top-level consts live in the sandbox's script scope, not on its global object → read them by name
const ctx = await loadScreenModule(TWEAKS_SRC);
const TWEAKS_CSS = String(vm.runInContext("__TWEAKS_STYLE", ctx)).replace(/\/\*[\s\S]*?\*\//g, "");

function getRules(css: string): { selectors: string[]; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(",").map((s) => s.trim()),
    body: m[2],
  }));
}

function getReducedMotionCss(css: string): string {
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

const getTransition = (body: string): string | undefined => body.match(/(?:^|[;\s{])transition\s*:\s*([^;}]+)/)?.[1].trim();

test("every transitioning rule in the panel drops its transition under reduced motion", () => {
  const reduced = getRules(getReducedMotionCss(TWEAKS_CSS));
  const transitioned = getRules(TWEAKS_CSS)
    .filter((rule) => !/^none\b/.test(getTransition(rule.body) ?? "none"))
    .flatMap((rule) => rule.selectors);

  assert.ok(transitioned.length >= 3, "precondition: the scan finds the thumb, toggle and knob transitions");
  for (const selector of transitioned) {
    const gate = reduced.filter((rule) => rule.selectors.includes(selector)).map((rule) => getTransition(rule.body));
    assert.ok(gate.some((value) => value && /^none\b/.test(value)), `${selector} keeps its transition under prefers-reduced-motion`);
  }
});
