// Shared freshness-stamp atom: four states, glyph-borne tone, a word for AT.
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");

type Component = (props: Record<string, unknown>) => unknown;
type RegionInput = { busy?: boolean; error?: string | null };
type FreshnessInput = { at?: string | null; loading?: boolean; failed?: boolean; regions?: RegionInput[]; staleAfterMs?: number; now?: number };

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

test("state follows the read history: never read → loading or not read, read → fresh only when idle, unfailed and inside the stale window", () => {
  const cases: Array<[FreshnessInput, string]> = [
    [{ at: null, loading: true }, "loading"],
    [{ at: null, loading: false }, "not-read"],
    [{ at: "not-a-date", loading: false }, "not-read"],
    [{ at: isoAgo(0) }, "fresh"],
    [{ at: isoAgo(STALE_MS) }, "fresh"],
    [{ at: isoAgo(STALE_MS + 1) }, "stale"],
    [{ at: isoAgo(1_000), failed: true }, "stale"],
    [{ at: isoAgo(1_000), loading: true }, "refreshing"],
    [{ at: isoAgo(STALE_MS + 1), loading: true }, "refreshing"],
    [{ at: null, regions: [{ busy: true }, { busy: false }] }, "loading"],
    [{ at: null, regions: [{ error: "down" }, { error: "down" }] }, "not-read"],
    [{ at: isoAgo(1_000), regions: [{ busy: true }, { busy: false }] }, "refreshing"],
    [{ at: isoAgo(1_000), regions: [{ error: "down" }, { busy: false }] }, "partial"],
    [{ at: isoAgo(1_000), regions: [{ error: "down" }, { error: "down" }] }, "stale"],
    [{ at: isoAgo(1_000), regions: [{ busy: false }, { busy: false }] }, "fresh"],
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

test("the success tone appears only on an idle, unfailed, in-window read", () => {
  const inputs: FreshnessInput[] = [
    { at: null, loading: true },
    { at: null },
    { at: isoAgo(1_000), loading: true },
    { at: isoAgo(1_000), failed: true },
    { at: isoAgo(1_000), regions: [{ busy: true }] },
    { at: isoAgo(1_000), regions: [{ error: "down" }, {}] },
    { at: isoAgo(1_000), regions: [{ error: "down" }] },
    { at: isoAgo(STALE_MS + 1) },
    { at: isoAgo(1_000) },
  ];
  for (const input of inputs) {
    const isFresh = getFreshnessState({ now: NOW, staleAfterMs: STALE_MS, ...input }) === "fresh";
    const okNodes = findNodes(renderStamp(input), (n) => /\btext-ok\b/.test(String(n.props.className ?? "")));
    assert.equal(okNodes.length, isFresh ? 1 : 0, JSON.stringify(input));
  }
});

test("a partial failure names how many regions failed out of how many, in text and for AT", () => {
  const tree = renderStamp({ at: isoAgo(1_000), regions: [{ error: "down" }, {}, {}] });
  const srWord = collectText(findNodes(tree, (n) => String(n.props.className ?? "").includes("sr-only"))[0]);
  const visible = collectText(findNodes(tree, (n) => n.props["data-stamp-text"] === "true")[0]);
  assert.match(srWord, /Partial.*1 of 3 failed/);
  assert.match(visible, /1 of 3 failed/);
});

test("a busy region marks the stamp busy and keeps the last stamp, whichever input carries the busy bit", () => {
  const at = isoAgo(1_000);
  for (const input of [{ at, loading: true }, { at, regions: [{ busy: true }, {}] }]) {
    const tree = renderStamp(input);
    assert.equal(findNodes(tree, (n) => n.props["aria-busy"] === "true").length, 1, JSON.stringify(input));
    assert.match(collectText(tree), new RegExp(`as of ${formatKstTime(at)}`));
    assert.match(collectText(findNodes(tree, (n) => String(n.props.className ?? "").includes("sr-only"))[0]), /Refreshing/);
  }
});

type RefreshProps = { isBusy?: boolean; hasRead?: boolean; onRefresh?: () => void; label?: string };
function renderRefresh(props: RefreshProps): RenderedNode {
  const tree = renderScreen(React.createElement(ui.RefreshButton as Component, { label: "Refresh cost data", onRefresh: () => {}, ...props })) as RenderedNode;
  return findNodes(tree, (n) => n.type === "button")[0];
}

test("the Refresh atom is busy and disabled exactly while a request is in flight, and names the wave", () => {
  const rows: Array<{ name: string; props: RefreshProps; busy: boolean; text: RegExp }> = [
    { name: "first wave", props: { isBusy: true, hasRead: false }, busy: true, text: /Loading…/ },
    { name: "refresh over held data", props: { isBusy: true, hasRead: true }, busy: true, text: /Refreshing…/ },
    { name: "idle after a read", props: { isBusy: false, hasRead: true }, busy: false, text: /^\s*Refresh\s*$/ },
    { name: "idle, never read", props: { isBusy: false, hasRead: false }, busy: false, text: /^\s*Refresh\s*$/ },
  ];
  for (const row of rows) {
    const button = renderRefresh(row.props);
    assert.equal(button.props.disabled === true, row.busy, `${row.name}: disabled`);
    assert.equal(button.props["aria-busy"] === "true", row.busy, `${row.name}: aria-busy`);
    assert.match(collectText(button), row.text, row.name);
    assert.equal(button.props["aria-label"], "Refresh cost data", `${row.name}: stable accessible name`);
  }
});

test("the Refresh atom keeps one width across its labels and spins only when motion is allowed", () => {
  const idle = renderRefresh({ isBusy: false, hasRead: true });
  const busy = renderRefresh({ isBusy: true, hasRead: true });
  assert.equal(idle.props.className, busy.props.className, "same box across states");
  assert.match(String(busy.props.className), /\bw-\d+\b/, "a fixed width class");
  const spinning = findNodes(busy, (n) => /animate-spin/.test(String(n.props.className ?? "")));
  assert.ok(spinning.length > 0, "the busy icon spins");
  for (const node of spinning) assert.match(String(node.props.className), /(^|\s)motion-safe:animate-spin\b/, "never an unconditional spin");
  assert.equal(findNodes(idle, (n) => /animate-spin/.test(String(n.props.className ?? ""))).length, 0);
});

test("getRegionSummary tallies busy and failed regions over any region list", () => {
  const getRegionSummary = ui.getRegionSummary as (regions: unknown) => { isBusy: boolean; failedCount: number; regionCount: number };
  // spread → a plain object of this realm; the vm-loaded module returns objects with a foreign prototype
  assert.deepEqual({ ...getRegionSummary(undefined) }, { isBusy: false, failedCount: 0, regionCount: 0 });
  assert.deepEqual({ ...getRegionSummary([{ busy: true, error: null }, { busy: false, error: "x" }, null, { busy: false, error: null }]) }, { isBusy: true, failedCount: 1, regionCount: 3 });
});

test("the PageHeader right cluster wraps under the title instead of overflowing", () => {
  const tree = renderScreen(React.createElement(ui.PageHeader as Component, { title: "Cost", right: "controls" })) as RenderedNode;
  const [outer] = findNodes(tree, (n) => n.type === "div");
  const right = findNodes(tree, (n) => n.type === "div" && collectText(n) === "controls")[0];
  for (const node of [outer, right]) assert.match(String(node.props.className), /\bflex-wrap\b/);
  assert.match(String(right.props.className), /\bmin-w-0\b/);
});

// Recording React whose state setter and effects the test drives by hand, plus a settable clock.
function createTickHarness(startMs: number) {
  const clock = { now: startMs };
  const effects: Array<() => unknown> = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let rerenders = 0;
  const RealDate = Date;
  class ClockDate extends RealDate {
    static now() {
      return clock.now;
    }
  }
  const baseReact = ui.React as Record<string, unknown>;
  const React = {
    ...baseReact,
    useState: (initial: unknown) => [initial, () => { rerenders += 1; }],
    useEffect: (effect: () => unknown) => { effects.push(effect); },
  };
  const globals = {
    React,
    Date: ClockDate,
    setInterval: (fn: () => void, ms: number) => timers.push({ fn, ms, cleared: false }) - 1,
    clearInterval: (id: number) => { if (timers[id]) timers[id].cleared = true; },
  };
  return { clock, effects, timers, globals, getRerenders: () => rerenders };
}

test("with no injected clock, a read stamp re-checks its own age: time passing alone turns Fresh into Stale", async () => {
  const harness = createTickHarness(NOW);
  const tickUi = await loadScreenModule(UI_SRC, harness.globals);
  const at = isoAgo(1_000);
  const render = () => renderScreen(React.createElement(tickUi.FreshnessStamp as Component, { at, staleAfterMs: STALE_MS })) as RenderedNode;
  const srWord = (tree: RenderedNode) => collectText(findNodes(tree, (n) => String(n.props.className ?? "").includes("sr-only"))[0]).trim();

  assert.equal(srWord(render()), "Fresh");
  const cleanups = harness.effects.map((effect) => effect());
  const live = harness.timers.filter((t) => !t.cleared);
  assert.equal(live.length, 1, "one tick scheduled");
  assert.ok(live[0].ms <= STALE_MS / 2, `tick ${live[0].ms}ms is fine-grained enough to catch the stale edge`);

  harness.clock.now = NOW + STALE_MS + 1;
  live[0].fn();
  assert.ok(harness.getRerenders() >= 1, "the tick requests a re-render");
  assert.equal(srWord(render()), "Stale");

  for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
  assert.ok(harness.timers.every((t) => t.cleared), "unmount clears the tick");
});

test("no tick is scheduled when nothing time-dependent is shown or the clock is injected", async () => {
  for (const props of [{ at: null }, { at: null, loading: true }, { at: isoAgo(1_000), now: NOW }]) {
    const harness = createTickHarness(NOW);
    const tickUi = await loadScreenModule(UI_SRC, harness.globals);
    renderScreen(React.createElement(tickUi.FreshnessStamp as Component, { staleAfterMs: STALE_MS, ...props }));
    harness.effects.forEach((effect) => effect());
    assert.equal(harness.timers.length, 0, JSON.stringify(props));
  }
});
