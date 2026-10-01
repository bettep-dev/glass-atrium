// Page verdict line and low-sample marker: tone always travels with a word, small samples always say their n.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, createFakeDocument, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;
type CreateElement = (type: unknown, props: unknown, ...children: unknown[]) => unknown;

const doc = createFakeDocument();
const ui = await loadScreenModule(UI_SRC, { document: doc });
const h = (ui.React as { createElement: CreateElement }).createElement;
// top-level consts stay off the sandbox context → read them through the window.UI export.
const exported = ui.UI as Record<string, unknown>;
const TONE_GLYPH = exported.TONE_GLYPH as Record<string, string>;
const LOW_N_MIN = exported.LOW_N_MIN as number;
const VERDICT_TONE_LABEL = exported.VERDICT_TONE_LABEL as Record<string, string> | undefined;

type RegionInput = { busy?: boolean; error?: string | null };
type FreshnessInput = { at?: string | null; loading?: boolean; failed?: boolean; regions?: RegionInput[]; staleAfterMs?: number; now?: number };
type Verdict = { state: string; tone: string; label?: string; note: string | null; isBusy: boolean };
const getFreshnessVerdict = ui.getFreshnessVerdict as (input: FreshnessInput & { tone?: string; label?: string }) => Verdict;
const getFreshnessState = ui.getFreshnessState as (input: FreshnessInput) => string;

// the verdict's own root div — renderScreen wraps it in a node carrying the component's props.
function renderVerdict(props: Record<string, unknown>, sentence = "Spend is on track."): RenderedNode {
  const tree = renderScreen(h(ui.PageVerdict as Component, props, sentence)) as RenderedNode;
  return tree.children[0] as RenderedNode;
}

function getToneParts(tree: RenderedNode) {
  const tone = findNodes(tree, (n: RenderedNode) => n.props.className === "page-verdict-tone")[0];
  const glyph = findNodes(tone, (n: RenderedNode) => n.props["aria-hidden"] === "true")[0];
  const word = collectText(tone).replace(collectText(glyph), "").trim();
  return { glyph: collectText(glyph), word };
}

describe("PageVerdict", () => {
  for (const tone of ["ok", "warn", "crit", "info", "neutral"]) {
    test(`a ${tone} verdict pairs the canonical glyph with a visible word, never colour alone`, () => {
      const tree = renderVerdict({ tone });
      const parts = getToneParts(tree);

      assert.equal(parts.glyph, TONE_GLYPH[tone]);
      assert.ok(parts.word.length > 0, "a word names the tone");
      assert.match(String(tree.props.className), new RegExp(`page-verdict--${tone}\\b`));
    });
  }

  test("a caller label replaces the default word and the sentence follows it", () => {
    const tree = renderVerdict({ tone: "crit", label: "3 daemons down" }, "Restart the monitor daemon first.");

    assert.equal(getToneParts(tree).word, "3 daemons down");
    assert.match(collectText(tree), /Restart the monitor daemon first\./);
  });

  test("an unknown tone reads as neutral instead of borrowing a colour", () => {
    const tree = renderVerdict({ tone: "bogus" });

    assert.equal(getToneParts(tree).glyph, TONE_GLYPH.neutral);
    assert.match(String(tree.props.className), /page-verdict--neutral\b/);
  });

  test("a chip with href drills to another view as a link", () => {
    const tree = renderVerdict({ tone: "warn", chips: [{ label: "Open budgets", href: "#/model-config" }] });
    const links = findNodes(tree, (n: RenderedNode) => n.type === "a");

    assert.equal(links.length, 1);
    assert.equal(links[0].props.href, "#/model-config");
  });

  test("a chip with targetId scrolls to its card and moves focus there, making the card focusable", () => {
    const calls: string[] = [];
    const attributes = new Map<string, string>();
    const card = {
      hasAttribute: (name: string) => attributes.has(name),
      setAttribute: (name: string, value: string) => { attributes.set(name, value); },
      addEventListener: () => undefined,
      scrollIntoView: () => { calls.push("scroll"); },
      focus: () => { calls.push("focus"); },
    };
    doc.reset();
    doc.elements.set("cost-burn", card);
    const tree = renderVerdict({ tone: "warn", chips: [{ label: "Burn rate", targetId: "cost-burn" }] });
    const button = findNodes(tree, (n: RenderedNode) => n.type === "button")[0];

    (button.props.onClick as () => void)();

    assert.deepEqual(calls, ["scroll", "focus"]);
    assert.equal(attributes.get("tabindex"), "-1");
  });

  test("a chip handoff scrolls only as far as needed and rings the card until it loses focus", () => {
    const attributes = new Map<string, string>();
    const blurListeners: Array<() => void> = [];
    let scrollOptions: unknown = null;
    const card = {
      hasAttribute: (name: string) => attributes.has(name),
      setAttribute: (name: string, value: string) => { attributes.set(name, value); },
      removeAttribute: (name: string) => { attributes.delete(name); },
      addEventListener: (type: string, listener: () => void) => { if (type === "blur") blurListeners.push(listener); },
      scrollIntoView: (options: unknown) => { scrollOptions = options; },
      focus: () => undefined,
    };
    doc.reset();
    doc.elements.set("cost-burn", card);
    const tree = renderVerdict({ tone: "warn", chips: [{ label: "Burn rate", targetId: "cost-burn" }] });
    (findNodes(tree, (n: RenderedNode) => n.type === "button")[0].props.onClick as () => void)();

    assert.equal((scrollOptions as { block?: string } | null)?.block, "nearest", "a card already in view does not jump");
    assert.ok(attributes.has("data-focus-handoff"), "the handoff marker draws the ring a mouse-driven focus would miss");
    blurListeners.forEach((listener) => listener());
    assert.ok(!attributes.has("data-focus-handoff"), "the ring leaves with focus");
  });
});

describe("LowSampleMark", () => {
  const isLowSample = ui.isLowSample as (n: unknown) => boolean;
  const rows = [
    { name: "one below the threshold", n: LOW_N_MIN - 1, expected: true },
    { name: "an empty sample", n: 0, expected: true },
    { name: "exactly the threshold", n: LOW_N_MIN, expected: false },
    { name: "a missing count", n: undefined, expected: false },
    { name: "a non-numeric count", n: Number.NaN, expected: false },
  ];

  for (const row of rows) {
    test(`${row.name} ${row.expected ? "is" : "is not"} a low sample`, () => {
      assert.equal(isLowSample(row.n), row.expected);
    });
  }

  test("a low sample names its n and a trustworthy one renders nothing", () => {
    const low = renderScreen(h(ui.LowSampleMark as Component, { n: 12 }));
    const enough = renderScreen(h(ui.LowSampleMark as Component, { n: LOW_N_MIN }));

    assert.equal(collectText(low).replace(/\s+/g, ""), "(n=12)");
    assert.equal(collectText(enough), "");
  });
});

describe("freshness-driven verdict", () => {
  const NOW = Date.parse("2026-09-25T05:30:00.000Z");
  const STALE_MS = 5 * 60_000;
  const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();
  const freshAt = isoAgo(1_000);
  const rows: Array<{ name: string; input: FreshnessInput; tone: string; label?: string; expectTone: string; expectLabel: RegExp; busy: boolean }> = [
    { name: "never read", input: { at: null }, tone: "ok", expectTone: "neutral", expectLabel: /^No signal$/, busy: false },
    { name: "first wave in flight", input: { at: null, loading: true }, tone: "ok", expectTone: "neutral", expectLabel: /^No signal$/, busy: true },
    { name: "cold error", input: { at: null, regions: [{ error: "down" }] }, tone: "ok", expectTone: "neutral", expectLabel: /^No signal$/, busy: false },
    { name: "fresh read", input: { at: freshAt }, tone: "ok", label: "All clear", expectTone: "ok", expectLabel: /^All clear$/, busy: false },
    { name: "ok read past the stale window", input: { at: isoAgo(STALE_MS + 1) }, tone: "ok", label: "All clear", expectTone: "neutral", expectLabel: /^Last known$/, busy: false },
    { name: "crit read then a failed read", input: { at: freshAt, failed: true }, tone: "crit", label: "3 daemons down", expectTone: "crit", expectLabel: /^Last known: 3 daemons down$/, busy: false },
    { name: "warn read then a failed read", input: { at: freshAt, failed: true }, tone: "warn", expectTone: "warn", expectLabel: /^Last known: Needs attention$/, busy: false },
    { name: "partial failure over an ok read", input: { at: freshAt, regions: [{ error: "down" }, {}] }, tone: "ok", expectTone: "neutral", expectLabel: /^Last known$/, busy: false },
    { name: "refresh over a fresh read", input: { at: freshAt, loading: true }, tone: "ok", label: "All clear", expectTone: "ok", expectLabel: /^All clear$/, busy: true },
    { name: "refresh over a warm error", input: { at: freshAt, regions: [{ busy: true, error: "down" }, { busy: true, error: "down" }] }, tone: "ok", expectTone: "neutral", expectLabel: /^Last known$/, busy: true },
    { name: "refresh over a stale crit", input: { at: freshAt, loading: true, failed: true }, tone: "crit", expectTone: "crit", expectLabel: /^Last known: Action needed$/, busy: true },
  ];

  for (const row of rows) {
    test(`${row.name} → ${row.expectTone} verdict${row.busy ? ", busy" : ""}`, () => {
      const verdict = getFreshnessVerdict({ ...row.input, now: NOW, staleAfterMs: STALE_MS, tone: row.tone, label: row.label });

      assert.equal(verdict.tone, row.expectTone);
      assert.match(String(verdict.label ?? VERDICT_TONE_LABEL?.[verdict.tone]), row.expectLabel);
      assert.equal(verdict.isBusy, row.busy);
    });
  }

  test("stale or partial data never raises an all-clear and never hides an alarm, and the stamp agrees on state and busy", () => {
    for (const row of rows) {
      for (const tone of ["ok", "warn", "crit"]) {
        const input = { ...row.input, now: NOW, staleAfterMs: STALE_MS };
        const verdict = getFreshnessVerdict({ ...input, tone });
        const stampState = getFreshnessState(input);
        const stamp = renderScreen(h(ui.FreshnessStamp as Component, input)) as RenderedNode;
        const stampRoot = findNodes(stamp, (n: RenderedNode) => n.type === "span")[0];
        const isRead = stampState !== "loading" && stampState !== "not-read";

        assert.equal(verdict.state, stampState, `${row.name}/${tone}: one state`);
        assert.equal(stampRoot.props["aria-busy"] === "true", verdict.isBusy, `${row.name}/${tone}: busy agrees`);
        if (verdict.tone === "ok") assert.ok(stampState === "fresh" || stampState === "refreshing", `${row.name}: ok only over a fresh read`);
        if (tone !== "ok" && isRead) assert.equal(verdict.tone, tone, `${row.name}/${tone}: alarm kept`);
      }
    }
  });

  test("a partial verdict names the failed count and a stale one names the read age", () => {
    const partial = getFreshnessVerdict({ at: freshAt, regions: [{ error: "down" }, {}, {}], now: NOW, staleAfterMs: STALE_MS, tone: "ok" });
    const stale = getFreshnessVerdict({ at: isoAgo(STALE_MS + 1), now: NOW, staleAfterMs: STALE_MS, tone: "ok" });

    assert.match(String(partial.note), /1 of 3 sources failed/);
    assert.equal(stale.note, "Read 5m ago", "the age is measured against the injected clock, not the wall clock");
  });

  test("an unread page says whether its first read failed or was never tried", () => {
    const rows: Array<{ name: string; input: FreshnessInput; note: RegExp }> = [
      { name: "never tried", input: { at: null }, note: /^Nothing has been read yet\.$/ },
      { name: "first read failed", input: { at: null, failed: true }, note: /first read failed/ },
      { name: "every first-read region failed", input: { at: null, regions: [{ error: "down" }, { error: "down" }] }, note: /first read failed/ },
      { name: "one first-read region failed", input: { at: null, regions: [{ error: "down" }, {}] }, note: /first read failed/ },
      { name: "first read in flight", input: { at: null, loading: true }, note: /^Checking the first read…$/ },
    ];
    for (const row of rows) {
      const verdict = getFreshnessVerdict({ ...row.input, now: NOW, staleAfterMs: STALE_MS, tone: "ok" });
      const tree = renderVerdict({ tone: "ok", freshness: { ...row.input, now: NOW } }, "Every agent is healthy.");

      assert.equal(verdict.tone, "neutral", `${row.name}: no tone without a read`);
      assert.match(String(verdict.note), row.note, row.name);
      assert.ok(collectText(tree).includes(String(verdict.note)), `${row.name}: rendered`);
      assert.doesNotMatch(collectText(tree), /Every agent is healthy/, `${row.name}: no data sentence without data`);
    }
  });

  test("PageVerdict with a freshness input shows the derived verdict and replaces an unread page sentence with a checking one", () => {
    const tree = renderVerdict({ tone: "ok", label: "All clear", freshness: { at: null, loading: true } }, "Every agent is healthy.");
    const parts = getToneParts(tree);

    assert.equal(parts.glyph, TONE_GLYPH.neutral);
    assert.equal(parts.word, "No signal");
    assert.doesNotMatch(collectText(tree), /Every agent is healthy/);
    assert.match(collectText(tree), /Checking/);
    assert.equal(tree.props["aria-busy"], "true");
  });
});
