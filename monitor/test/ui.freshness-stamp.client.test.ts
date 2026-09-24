// Shared freshness-stamp atom: four states, glyph-borne tone, a word for AT.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;
type FreshnessInput = { at?: string | null; loading?: boolean; failed?: boolean; staleAfterMs?: number; now?: number };

const ui = await loadScreenModule(UI_SRC);
const React = ui.React as { createElement: (t: unknown, p: unknown) => unknown };
const getFreshnessState = ui.getFreshnessState as (input: FreshnessInput) => string;
const formatKstTime = ui.formatKstTime as (iso: string) => string;

const NOW = Date.parse("2026-09-25T05:30:00.000Z");
const STALE_MS = 5 * 60_000;
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

function renderStamp(props: FreshnessInput): RenderedNode {
  return renderScreen(React.createElement(ui.FreshnessStamp as Component, { now: NOW, staleAfterMs: STALE_MS, ...props })) as RenderedNode;
}

test("state follows the read history: never read → loading or not read, read → fresh until the stale window passes", () => {
  const cases: Array<[FreshnessInput, string]> = [
    [{ at: null, loading: true }, "loading"],
    [{ at: null, loading: false }, "not-read"],
    [{ at: "not-a-date", loading: false }, "not-read"],
    [{ at: isoAgo(0) }, "fresh"],
    [{ at: isoAgo(STALE_MS) }, "fresh"],
    [{ at: isoAgo(STALE_MS + 1) }, "stale"],
    [{ at: isoAgo(1_000), failed: true }, "stale"],
    [{ at: isoAgo(1_000), loading: true }, "fresh"],
    [{ at: isoAgo(STALE_MS + 1), loading: true }, "stale"],
  ];
  for (const [input, expected] of cases) {
    const state = getFreshnessState({ now: NOW, staleAfterMs: STALE_MS, ...input });
    assert.equal(state, expected, JSON.stringify(input));
  }
});

test("every state carries a distinct decorative glyph and a distinct screen-reader word", () => {
  const inputs: FreshnessInput[] = [
    { at: null, loading: true },
    { at: null },
    { at: isoAgo(STALE_MS + 60_000) },
    { at: isoAgo(1_000) },
  ];
  const glyphs = new Set<string>();
  const words = new Set<string>();
  for (const input of inputs) {
    const tree = renderStamp(input);
    const glyph = findNodes(tree, (n) => n.props["aria-hidden"] === "true");
    const word = findNodes(tree, (n) => String(n.props.className ?? "").includes("sr-only"));
    assert.equal(glyph.length, 1, `${JSON.stringify(input)}: one glyph`);
    assert.equal(word.length, 1, `${JSON.stringify(input)}: one word`);
    glyphs.add(collectText(glyph[0]).trim());
    words.add(collectText(word[0]).trim());
  }
  assert.equal(glyphs.size, inputs.length, [...glyphs].join(" "));
  assert.equal(words.size, inputs.length, [...words].join(" "));
  assert.ok(![...glyphs, ...words].includes(""));
});

test("tone colours the glyph only — the stamp text stays in the neutral ink", () => {
  for (const input of [{ at: isoAgo(1_000) }, { at: isoAgo(STALE_MS + 1) }, { at: null }]) {
    const tree = renderStamp(input);
    const toned = findNodes(tree, (n) => /\btext-(ok|warn|crit)\b/.test(String(n.props.className ?? "")));
    assert.equal(toned.length, 1, `${JSON.stringify(input)}: exactly one toned node`);
    assert.equal(toned[0].props["aria-hidden"], "true", "the toned node is the glyph");
  }
});

test("a read stamp shows the display-clock time of the read, whatever its age", () => {
  for (const ageMs of [1_000, STALE_MS + 1, 3_600_000]) {
    const at = isoAgo(ageMs);
    const visible = findNodes(renderStamp({ at }), (n) => n.props["data-stamp-text"] === "true");
    assert.equal(visible.length, 1);
    assert.equal(collectText(visible[0]).trim(), `as of ${formatKstTime(at)}`);
  }
});

test("a refresh in flight keeps the last stamp and marks the atom busy", () => {
  const at = isoAgo(1_000);
  const tree = renderStamp({ at, loading: true });
  assert.equal(findNodes(tree, (n) => n.props["aria-busy"] === "true").length, 1);
  assert.match(collectText(tree), new RegExp(`as of ${formatKstTime(at)}`));
});
