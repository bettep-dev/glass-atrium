// Shared freshness-stamp atom: four states, glyph-borne tone, a word for AT.
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { collectText, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const BASE_CSS = resolve(__dirname, "../public/styles/base.css");

type Component = (props: Record<string, unknown>) => unknown;
type RegionInput = { busy?: boolean; error?: string | null };
type FreshnessInput = { at?: string | null; loading?: boolean; failed?: boolean; regions?: RegionInput[]; staleAfterMs?: number; now?: number };

const ui = await loadScreenModule(UI_SRC);
const React = ui.React as { createElement: (t: unknown, p: unknown) => unknown };
const getFreshnessState = ui.getFreshnessState as (input: FreshnessInput) => string;
type Verdict = { state: string; tone: string; label?: string; note: string | null; isBusy: boolean };
const getFreshnessVerdict = ui.getFreshnessVerdict as (input: FreshnessInput & { tone?: string; label?: string }) => Verdict;
const formatRelativeTime = ui.formatRelativeTime as (iso: string | null | undefined, now?: number) => string;

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

test("every shown state carries a distinct decorative glyph and names its state word exactly once", () => {
  const inputs: Array<{ input: FreshnessInput; word: string }> = [
    { input: { at: null, loading: true }, word: "Loading" },
    { input: { at: null }, word: "Not read" },
    { input: { at: isoAgo(STALE_MS + 60_000) }, word: "Stale" },
  ];
  const glyphs = new Set<string>();
  for (const { input, word } of inputs) {
    const tree = renderStamp(input);
    const glyph = findNodes(tree, (n) => n.props["aria-hidden"] === "true");
    const mentions = collectText(tree).toLowerCase().split(word.toLowerCase()).length - 1;
    assert.equal(glyph.length, 1, `${JSON.stringify(input)}: one glyph`);
    assert.equal(mentions, 1, `${JSON.stringify(input)}: "${collectText(tree)}" names ${word} once`);
    glyphs.add(collectText(glyph[0]).trim());
  }
  assert.equal(glyphs.size, inputs.length, [...glyphs].join(" "));
  assert.ok(![...glyphs].includes(""));
});

test("a first read in flight leaves the visible loading label to the paired Refresh control", () => {
  const tree = renderStamp({ at: null, loading: true });
  assert.equal(findNodes(tree, (n) => n.props["data-stamp-text"] === "true").length, 0);
  assert.equal(collectText(findNodes(tree, (n) => String(n.props.className ?? "").includes("sr-only"))[0]).trim(), "Loading");
});

test("tone colours the glyph only — the stamp text stays in the neutral ink", () => {
  for (const input of [{ at: isoAgo(STALE_MS + 1) }, { at: null }, { at: isoAgo(1_000), regions: [{ error: "down" }, {}] }]) {
    const tree = renderStamp(input);
    const toned = findNodes(tree, (n) => /\btext-(ok|warn|crit)\b/.test(String(n.props.className ?? "")));
    assert.equal(toned.length, 1, `${JSON.stringify(input)}: exactly one toned node`);
    assert.equal(toned[0].props["aria-hidden"], "true", "the toned node is the glyph");
  }
});

test("the stamp renders exactly when the settled read is not fresh — a refresh over a fresh read stays hidden", () => {
  const rows: Array<{ name: string; input: FreshnessInput; isShown: boolean }> = [
    { name: "fresh, idle", input: { at: isoAgo(1_000) }, isShown: false },
    { name: "fresh at the window edge", input: { at: isoAgo(STALE_MS) }, isShown: false },
    { name: "fresh, refreshing", input: { at: isoAgo(1_000), loading: true }, isShown: false },
    { name: "fresh, a region refreshing", input: { at: isoAgo(1_000), regions: [{ busy: true }, {}] }, isShown: false },
    { name: "past the window", input: { at: isoAgo(STALE_MS + 1) }, isShown: true },
    { name: "past the window, refreshing", input: { at: isoAgo(STALE_MS + 1), loading: true }, isShown: true },
    { name: "the last read failed", input: { at: isoAgo(1_000), failed: true }, isShown: true },
    { name: "some regions failed", input: { at: isoAgo(1_000), regions: [{ error: "down" }, {}] }, isShown: true },
    { name: "never read", input: { at: null }, isShown: true },
    { name: "first read in flight", input: { at: null, loading: true }, isShown: true },
  ];
  // the component node always wraps its output → shown means it rendered a child
  for (const row of rows) assert.equal(renderStamp(row.input).children.length > 0, row.isShown, row.name);
});

test("a stale read reads as last known with its age, a read under a minute old as just now, whatever input made it stale", () => {
  const rows = [
    { name: "past the window", input: { at: isoAgo(STALE_MS + 60_000) }, age: "6m ago" },
    { name: "an hour old", input: { at: isoAgo(3_600_000) }, age: "1h ago" },
    { name: "a second old, then a failed read", input: { at: isoAgo(1_000), failed: true }, age: "just now" },
    { name: "the same instant, then a failed read", input: { at: isoAgo(0), failed: true }, age: "just now" },
    { name: "59 seconds old, then a failed read", input: { at: isoAgo(59_000), failed: true }, age: "just now" },
    { name: "a minute old, then a failed read", input: { at: isoAgo(60_000), failed: true }, age: "1m ago" },
  ];
  for (const row of rows) {
    const visible = findNodes(renderStamp(row.input), (n) => n.props["data-stamp-text"] === "true");
    assert.equal(visible.length, 1, row.name);
    assert.equal(collectText(visible[0]).trim(), `Last known · read ${row.age}`, row.name);
  }
});

test("a never-read stamp shows the unread note: never tried, a first read that failed whole, or the failed share with no age", () => {
  const rows: Array<{ name: string; input: FreshnessInput; note: string; glyph: string }> = [
    { name: "never tried", input: { at: null }, note: "Nothing has been read yet.", glyph: "✕" },
    { name: "first read failed", input: { at: null, failed: true }, note: "First read failed", glyph: "⚠" },
    { name: "every region failed", input: { at: null, regions: [{ error: "down" }, { error: "down" }] }, note: "First read failed", glyph: "⚠" },
    { name: "some regions failed", input: { at: null, regions: [{ error: "down" }, { error: "down" }, {}, {}, {}, {}, {}] }, note: "2 of 7 failed", glyph: "⚠" },
  ];
  for (const row of rows) {
    const tree = renderStamp(row.input);
    const visible = findNodes(tree, (n) => n.props["data-stamp-text"] === "true");
    const [glyph] = findNodes(tree, (n) => n.props["aria-hidden"] === "true");
    assert.equal(collectText(visible[0]).trim(), row.note, row.name);
    assert.equal(collectText(glyph).trim(), row.glyph, row.name);
  }
});

test("held data over a partly failed refresh reads last known, its age and the failed share", () => {
  const tree = renderStamp({ at: isoAgo(3 * 60_000), regions: [{ error: "down" }, { error: "down" }, {}, {}, {}, {}, {}] });
  const visible = findNodes(tree, (n) => n.props["data-stamp-text"] === "true");
  const [glyph] = findNodes(tree, (n) => n.props["aria-hidden"] === "true");
  assert.equal(collectText(visible[0]).trim(), "Last known · read 3m ago · 2 of 7 failed");
  assert.equal(collectText(glyph).trim(), "⚠");
});

test("a partial failure names how many regions failed out of how many, in text and for AT", () => {
  const tree = renderStamp({ at: isoAgo(1_000), regions: [{ error: "down" }, {}, {}] });
  const srWord = collectText(findNodes(tree, (n) => String(n.props.className ?? "").includes("sr-only"))[0]);
  const visible = collectText(findNodes(tree, (n) => n.props["data-stamp-text"] === "true")[0]);
  assert.match(srWord, /Partial.*1 of 3 failed/);
  assert.match(visible, /1 of 3 failed/);
});

test("a busy region marks a shown stamp busy and keeps the last stamp, whichever input carries the busy bit", () => {
  const at = isoAgo(STALE_MS + 60_000);
  for (const input of [{ at, loading: true }, { at, regions: [{ busy: true }, {}] }]) {
    const tree = renderStamp(input);
    assert.equal(findNodes(tree, (n) => n.props["aria-busy"] === "true").length, 1, JSON.stringify(input));
    assert.match(collectText(tree), new RegExp(`Last known · read ${formatRelativeTime(at, NOW)}`));
    assert.match(collectText(findNodes(tree, (n) => String(n.props.className ?? "").includes("sr-only"))[0]), /Refreshing/);
  }
});

type RefreshProps = { isBusy?: boolean; hasRead?: boolean; onRefresh?: () => void; label?: string };
function renderRefresh(props: RefreshProps): RenderedNode {
  const tree = renderScreen(React.createElement(ui.RefreshButton as Component, { label: "Refresh cost data", onRefresh: () => {}, ...props })) as RenderedNode;
  return findNodes(tree, (n) => n.type === "button")[0];
}

test("the Refresh atom is busy and inert exactly while a request is in flight, stays focusable, and names the wave", () => {
  const rows: Array<{ name: string; props: RefreshProps; busy: boolean; text: RegExp }> = [
    { name: "first wave", props: { isBusy: true, hasRead: false }, busy: true, text: /Loading…/ },
    { name: "refresh over held data", props: { isBusy: true, hasRead: true }, busy: true, text: /Refreshing…/ },
    { name: "idle after a read", props: { isBusy: false, hasRead: true }, busy: false, text: /^\s*Refresh\s*$/ },
    { name: "idle, never read", props: { isBusy: false, hasRead: false }, busy: false, text: /^\s*Refresh\s*$/ },
  ];
  for (const row of rows) {
    const button = renderRefresh(row.props);
    assert.equal(button.type, "button", `${row.name}: one element across states — React keeps the focused node`);
    assert.equal(button.props.disabled, undefined, `${row.name}: never natively disabled — focus stays on it`);
    assert.equal(button.props["aria-disabled"] === "true", row.busy, `${row.name}: aria-disabled`);
    assert.equal(button.props["aria-busy"] === "true", row.busy, `${row.name}: aria-busy`);
    assert.match(collectText(button), row.text, row.name);
    assert.equal(button.props["aria-label"], "Refresh cost data", `${row.name}: stable accessible name`);
  }
});

test("a click on the Refresh atom starts a read only when idle", () => {
  for (const isBusy of [false, true]) {
    let calls = 0;
    const button = renderRefresh({ isBusy, hasRead: true, onRefresh: () => { calls += 1; } });
    (button.props.onClick as (event?: unknown) => void)({});
    assert.equal(calls, isBusy ? 0 : 1, `busy=${isBusy}`);
  }
});

test("the Refresh atom keeps one fixed-width box across its idle and busy labels", () => {
  const idle = renderRefresh({ isBusy: false, hasRead: true });
  const busy = renderRefresh({ isBusy: true, hasRead: true });
  assert.equal(idle.props.className, busy.props.className, "same box across states");
  assert.match(String(busy.props.className), /\bw-\d+\b/, "a fixed width class");
});

test("the Refresh atom spins only while busy and only when motion is allowed", () => {
  const idle = renderRefresh({ isBusy: false, hasRead: true });
  const busy = renderRefresh({ isBusy: true, hasRead: true });
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

test("the PageHeader cluster wraps under the title instead of overflowing, Refresh right-most after freshness and range", () => {
  const tree = renderScreen(React.createElement(ui.PageHeader as Component, {
    title: "Cost", actions: "export", freshness: "stamp", range: "range", refresh: "refresh",
  })) as RenderedNode;
  const byClass = (name: string) => findNodes(tree, (n) => n.type === "div" && new RegExp(`(^|\\s)${name}(\\s|$)`).test(String(n.props.className ?? "")));
  const [outer] = byClass("page-head");
  const [cluster] = byClass("page-head-cluster");
  const groups = byClass("page-head-group");
  assert.ok(outer && cluster, "the header row and its right-hand cluster render");
  assert.deepEqual(groups.map((g) => collectText(g)), ["export", "stamp range refresh"], "actions stand apart, then freshness · range · refresh");
  // the wrap and shrink rules live on the classes → read them from the shared stylesheet
  const css = readFileSync(BASE_CSS, "utf8");
  // a rule whose selector list starts with `selector` (not a later line of a grouped list)
  const rule = (selector: string) => css.match(new RegExp(`(?:^|(?<!,)\\n)${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  assert.match(rule("\\.page-head"), /flex-wrap:\s*wrap/);
  const shared = rule("\\.page-head-cluster,\\s*\\.page-head-group");
  assert.match(shared, /flex-wrap:\s*wrap/);
  assert.match(shared, /min-width:\s*0/);
  assert.match(rule("\\.page-head-cluster"), /column-gap:\s*var\(--space-6\)/, "24 between the actions and the status group");
  assert.match(rule("\\.page-head-group"), /column-gap:\s*var\(--space-3\)/, "12 inside a group");
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

test("with no injected clock, a read stamp re-checks its own age: time passing alone turns a hidden fresh stamp into a shown Stale one", async () => {
  const harness = createTickHarness(NOW);
  const tickUi = await loadScreenModule(UI_SRC, harness.globals);
  const at = isoAgo(1_000);
  const render = () => renderScreen(React.createElement(tickUi.FreshnessStamp as Component, { at, staleAfterMs: STALE_MS })) as RenderedNode;
  const srWord = (tree: RenderedNode) => collectText(findNodes(tree, (n) => String(n.props.className ?? "").includes("sr-only"))[0]).trim();

  assert.equal(render().children.length, 0, "fresh → hidden");
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

describe("freshness-driven verdict", () => {
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
      assert.match(String(verdict.label), row.expectLabel);
      assert.equal(verdict.isBusy, row.busy);
    });
  }

  test("stale or partial data never raises an all-clear and never hides an alarm, and the stamp agrees on state, visibility and busy", () => {
    for (const row of rows) {
      for (const tone of ["ok", "warn", "crit"]) {
        const input = { ...row.input, now: NOW, staleAfterMs: STALE_MS };
        const verdict = getFreshnessVerdict({ ...input, tone });
        const stampState = getFreshnessState(input);
        const stamp = renderScreen(React.createElement(ui.FreshnessStamp as Component, input)) as RenderedNode;
        const stampRoot = findNodes(stamp, (n: RenderedNode) => n.type === "span")[0];
        const isRead = stampState !== "loading" && stampState !== "not-read";

        assert.equal(verdict.state, stampState, `${row.name}/${tone}: one state`);
        // a fresh settled read hides the stamp → the stamp shows exactly the reads the verdict annotates
        assert.equal(stampRoot !== undefined, verdict.note !== null, `${row.name}/${tone}: stamp shown exactly when the verdict carries a note`);
        assert.equal(stampRoot?.props["aria-busy"] === "true", stampRoot !== undefined && verdict.isBusy, `${row.name}/${tone}: busy agrees`);
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

  test("a held read under a minute old notes its age as just now, never 0s ago", () => {
    const verdict = getFreshnessVerdict({ at: isoAgo(0), failed: true, now: NOW, staleAfterMs: STALE_MS, tone: "ok" });

    assert.equal(verdict.note, "Read just now");
  });

  test("an unread page says whether its first read failed or was never tried", () => {
    const rows: Array<{ name: string; input: FreshnessInput; note: RegExp }> = [
      { name: "never tried", input: { at: null }, note: /^Nothing has been read yet\.$/ },
      { name: "first read failed", input: { at: null, failed: true }, note: /^First read failed$/ },
      { name: "every first-read region failed", input: { at: null, regions: [{ error: "down" }, { error: "down" }] }, note: /^First read failed$/ },
      { name: "one first-read region failed", input: { at: null, regions: [{ error: "down" }, {}] }, note: /^1 of 2 failed$/ },
      { name: "first read in flight", input: { at: null, loading: true }, note: /^Checking the first read…$/ },
    ];
    for (const row of rows) {
      const verdict = getFreshnessVerdict({ ...row.input, now: NOW, staleAfterMs: STALE_MS, tone: "ok" });

      assert.equal(verdict.tone, "neutral", `${row.name}: no tone without a read`);
      assert.match(String(verdict.note), row.note, row.name);
    }
  });
});
