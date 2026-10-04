// Unit pins for the PURE derivations behind the cost screen's decision tier (screens/cost.jsx):
// alarm-lane triggers, the tile-1 hot verdict, the window-total delta rule, the session Other-row
// rollup. Each pins a relationship the composition rests on, not a sampled pair.
//
// Runner: npx tsx --test test/cost.client.unit.test.ts
// Sandbox harness (esbuild + node:vm over the real shipped cost.jsx): client-sandbox.ts.

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";
import { collectText, createReactStub, findNodes, loadScreenModule, renderScreen, type RenderedNode } from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COST_SRC = resolve(__dirname, "../public/src/screens/cost.jsx");

type PanelStatus = "loading" | "error" | "empty" | "unavailable" | "ready";

interface PanelState {
  status: string;
  data: unknown;
  error: string | null;
  busy?: boolean;
  key?: string | null;
  pendingKey?: string | null;
}

interface HotVerdict {
  todayCost: number | null;
  normalDaily: number | null;
  ratio: number | null;
  paceRatio: number | null;
  isHot: boolean;
  isPaceHot: boolean;
  verdict: string;
}

interface AlarmRow {
  key: string;
  tone: string;
  text: string;
}

interface WindowTotal {
  total: number | null;
  delta: number | null;
  prior: { days: number; period_end: string } | null;
  avgDaily: number | null;
  peakCost: number | null;
  isEmpty: boolean;
}

interface SessionRollup {
  top: ReadonlyArray<{ session_id: string; total_cost_usd: number }>;
  other: { count: number; cost_usd: number } | null;
  total: number;
}

interface ModelTokenRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

interface CostHelpers {
  window: {
    getTokenRate?: (model: string) => Record<string, number> | null;
    UI: {
      CARD_SLOTS: Record<"S" | "M" | "L", { rowCount: number; plotPx: number }>;
      INITIAL_REGION_STATE: PanelState;
      formatUsdCompact: (value: number | null) => string;
      getFreshnessState: (input: {
        at: string | null;
        regions: ReadonlyArray<PanelState>;
        now: number;
      }) => string;
      getFreshnessVerdict: (input: Record<string, unknown>) => { tone: string; label: string };
    };
  };
  computeAlarmRows: (input: {
    hot: HotVerdict;
    latestOutsideBand: boolean;
    parseError: { crit: number; total: number };
  }) => AlarmRow[];
  computeHotVerdict: (kpi: Record<string, unknown>) => HotVerdict;
  computeWindowTotal: (state: PanelState) => WindowTotal;
  getShownDays: (state: PanelState, requestedDays: number) => number;
  computeCacheShare: (state: PanelState) => {
    share: number | null;
    cacheCost: number | null;
    isEmpty: boolean;
  };
  getParseErrorDayCounts: (state: PanelState) => { crit: number; total: number };
  isLatestOutsideBand: (state: PanelState) => boolean;
  rollupSessionRows: (
    sessions: ReadonlyArray<{ session_id: string; total_cost_usd: number }>,
    topN: number,
  ) => SessionRollup;
  getModelTokenDetail: (row: ModelTokenRow) => string;
  getSpendConcentration: (
    sessions: ReadonlyArray<{ session_id: string; total_cost_usd: number }>,
    topN: number,
  ) => { count: number; share: number } | null;
  turnStopReasonMeta: (reason: string | null) => { label: string; raw: string; desc: string };
  getTileStatus: (state: PanelState, value: unknown, isEmpty: boolean) => PanelStatus;
  getTileNote: (status: PanelStatus, unavailableNote: string) => string;
  getFreshnessInputC: (
    asOfAt: string | null,
    panelStates: ReadonlyArray<PanelState>,
  ) => { at: string | null; regions: ReadonlyArray<PanelState> };
  runFetchC: (
    url: string,
    request: AbortController,
    setter: (update: (prev: PanelState) => PanelState) => void,
    onReceived?: () => void,
  ) => Promise<void>;
  getCostSourceFailuresC: (states: Record<string, PanelState>) => {
    banner: { sources: string[]; error: string } | null;
    speakers: Map<string, string>;
  };
  fetch: (url: string, init?: unknown) => Promise<unknown>;
  getModelLabelC: (model: string | null | undefined) => string;
  getClampedInstantC: (iso: string | null | undefined, nowMs: number) => string | null;
  getSessionShortId: (id: string) => string;
  getSessionFactsC: (
    session: Record<string, unknown>,
    nowMs: number,
  ) => ReadonlyArray<readonly [string, string]>;
  getTileVerdictTextC: (hot: HotVerdict) => string;
  getSpendVerdictC: (input: {
    hot: HotVerdict;
    latestOutsideBand: boolean;
    kpiStatus: string;
  }) => { tone: string; label: string; text: string };
  getStopReasonSessionShare: (sessionCount: number, population: number) => number | null;
  markPartialDay: (rows: ReadonlyArray<{ actual: number }>) => ReadonlyArray<{
    actual: number;
    isPartial: boolean;
    completeCost: number | null;
    partialCost: number | null;
  }>;
  getUsdAxisFormatter: (maxValue: number) => (value: number) => string;
  getParseErrorChartRows: (
    rows: readonly { event_date: string; error_count: number; total_count: number; error_ratio: number }[],
  ) => { error_count: number; threshold_count: number; isCrit: boolean }[];
  getNoDataLabelC: (values: readonly (number | null)[]) => string | null;
  getCacheTicks: (domain: readonly [number, number]) => number[];
  getUsdTicksC: (maxValue: number) => number[];
  getFlatCacheRate: (rows: readonly { rate_pct: number | null }[]) => number | null;
  getCacheTotalNoteC: (input: { listTotal: number | null; recordedTotal: number | null; days: number }) => string;
  getTokenAxisFormatter: (maxValue: number) => (value: number) => string;
  computeTokenShares: (
    points: readonly Record<string, number>[],
  ) => ReadonlyArray<{ key: string; label: string; total: number; share: number }> | null;
  getTokenStackOrder: (
    shares: ReadonlyArray<{ key: string; total: number }>,
  ) => ReadonlyArray<{ key: string; total: number }>;
  getTurnHeadline: (
    turns: { avg_turns_per_session?: number; turn_session_count?: number },
    sessionPopulation: number,
  ) => { value: string | null; note: string };
  getTrendReadout: (
    row: {
      fullDate: string;
      actual: number | null;
      isPartial: boolean;
      rollingMean?: number | null;
      lowerBand?: number | null;
      upperBand?: number | null;
    },
    bandOn: boolean,
  ) => string;
}

const cost = await buildScreenSandbox<CostHelpers>(COST_SRC);

// buildModelCostRows prices each row through the shipped catalog global, which the browser
// loads from its own script and the sandbox does not. Flat rates keep the split a pure
// token-share computation, so the cache-share relationship stays the thing under test.
cost.window.getTokenRate = () => ({ input: 1, output: 1, cache_read: 1, cache_creation: 1 });

// vm-realm arrays carry the sandbox's own Array.prototype, so a host-side deep compare
// fails on the prototype alone — copy into a host array before comparing.
function getKeys(rows: ReadonlyArray<AlarmRow>): string[] {
  return [...rows].map((r) => r.key);
}

const ready = (data: unknown): PanelState => ({ status: "ready", data, error: null, busy: false });
const loading: PanelState = { status: "loading", data: null, error: null, busy: true };
const failed: PanelState = { status: "error", data: null, error: "HTTP 500 Internal Server Error", busy: false };

// Fetched at UTC noon in a UTC day bucket → 12 hours of the day remain.
const NOON_UTC = "2026-01-10T12:00:00.000Z";
const NOON_HOURS_LEFT = 12;

// kpi payload for a chosen today-vs-normal ratio: the normal is the 7-day cost over 7.
// The burn rate is solved so so-far spend + burn × hours left lands on the chosen pace ratio.
function getKpiAtRatio(ratio: number, paceRatio: number | null): Record<string, unknown> {
  const week7Cost = 70;
  const normalDaily = week7Cost / 7;
  return {
    window_7d_cost_usd: week7Cost,
    today_cost_usd: normalDaily * ratio,
    burn_rate_3h_usd_per_hour:
      paceRatio === null ? null : ((paceRatio - ratio) * normalDaily) / NOON_HOURS_LEFT,
    day_bucket_timezone: "UTC",
    fetched_at: NOON_UTC,
  };
}

function getTrendPoints(costs: readonly number[]): PanelState {
  return ready({ points: costs.map((c, i) => ({ day: `d${i}`, cost_usd: c })) });
}

const CALM: HotVerdict = {
  todayCost: 1,
  normalDaily: 1,
  ratio: 1,
  paceRatio: 1,
  isHot: false,
  isPaceHot: false,
  verdict: "Today is 100% of the 7-day daily normal so far.",
};

test("the lane stays empty unless a trigger fires, and every trigger fires it alone", () => {
  assert.strictEqual(
    cost.computeAlarmRows({ hot: CALM, latestOutsideBand: false, parseError: { crit: 0, total: 9 } })
      .length,
    0,
    "no trigger must render zero rows — the lane is structural and zero-height when calm",
  );

  const hotTriggers: ReadonlyArray<readonly [string, Partial<HotVerdict>, boolean]> = [
    ["so-far ratio", { isHot: true }, false],
    ["pace ratio", { isPaceHot: true }, false],
    ["latest day outside band", {}, true],
  ];
  for (const [name, hotDelta, outsideBand] of hotTriggers) {
    const rows = cost.computeAlarmRows({
      hot: { ...CALM, ...hotDelta },
      latestOutsideBand: outsideBand,
      parseError: { crit: 0, total: 9 },
    });
    assert.deepStrictEqual(getKeys(rows), ["hot"], name);
    assert.ok(rows[0]!.text.length > 0, `${name} must state itself in words`);
  }

  const withParse = cost.computeAlarmRows({
    hot: { ...CALM, isHot: true },
    latestOutsideBand: false,
    parseError: { crit: 3, total: 9 },
  });
  assert.deepStrictEqual(
    getKeys(withParse),
    ["hot", "parse-error"],
    "the parse-error row is conditional and follows the hot row",
  );
  assert.match(
    withParse[1]!.text,
    /\b3 of 9\b/,
    "the parse-error row states its count beside the population it came from — never a count alone",
  );
});

test("a payload that failed or never arrived contributes no lane trigger", () => {
  for (const state of [loading, failed]) {
    const counts = cost.getParseErrorDayCounts(state);
    assert.strictEqual(counts.crit, 0, `${state.status} crit`);
    assert.strictEqual(counts.total, 0, `${state.status} population`);
    assert.strictEqual(cost.isLatestOutsideBand(state), false, state.status);
  }
  // Below the rolling window the band has no answer, and no answer must not fire the lane.
  assert.strictEqual(cost.isLatestOutsideBand(getTrendPoints([1, 9, 1])), false);
});

test("tile-1 tone follows the so-far ratio alone, never the pace figure", () => {
  const hotSoFar = cost.computeHotVerdict(getKpiAtRatio(2, null));
  assert.strictEqual(hotSoFar.isHot, true);
  assert.strictEqual(hotSoFar.isPaceHot, false);

  const hotPaceOnly = cost.computeHotVerdict(getKpiAtRatio(0.1, 2));
  assert.strictEqual(hotPaceOnly.isHot, false, "a hot pace must not make the tone hot");
  assert.strictEqual(hotPaceOnly.isPaceHot, true);

  // The cut is a threshold, so it holds across the class, not at one hand-picked value.
  for (const ratio of [0.5, 1, 1.24]) {
    assert.strictEqual(cost.computeHotVerdict(getKpiAtRatio(ratio, null)).isHot, false, `${ratio}`);
  }
  for (const ratio of [1.25, 2, 10]) {
    assert.strictEqual(cost.computeHotVerdict(getKpiAtRatio(ratio, null)).isHot, true, `${ratio}`);
  }
});

test("the verdict always carries the so-far clause and adds the pace clause only when measured", () => {
  const withPace = cost.computeHotVerdict(getKpiAtRatio(1.5, 2));
  assert.match(withPace.verdict, /so far/);
  assert.match(withPace.verdict, /pace/);

  const withoutPace = cost.computeHotVerdict(getKpiAtRatio(1.5, null));
  assert.match(withoutPace.verdict, /so far/);
  assert.doesNotMatch(withoutPace.verdict, /pace/, "a missing burn rate must drop the clause, not guess it");
});

test("the pace lands today's spend so far plus the burn over the hours left, never below what is spent", () => {
  const normalDaily = 10;
  const today = 6.3; // 63% already spent
  const burn = (0.31 * normalDaily) / 24; // a 3h burn that alone extrapolates to 31% of a day

  for (const hour of [0, 6, 12, 18, 23]) {
    const fetchedAt = new Date(Date.UTC(2026, 0, 10, hour)).toISOString();
    const hot = cost.computeHotVerdict({
      window_7d_cost_usd: normalDaily * 7,
      today_cost_usd: today,
      burn_rate_3h_usd_per_hour: burn,
      day_bucket_timezone: "UTC",
      fetched_at: fetchedAt,
    });
    const expected = (today + burn * (24 - hour)) / normalDaily;
    assert.ok(hot.paceRatio !== null && Math.abs(hot.paceRatio - expected) < 1e-9, `${hour}h: ${hot.paceRatio}`);
    assert.ok(hot.paceRatio >= hot.ratio!, `${hour}h: the pace cannot undercut the spend already made`);
  }
});

test("the hours left are read in the day bucket's zone, and an unreadable instant or zone drops the pace", () => {
  const base = { window_7d_cost_usd: 70, today_cost_usd: 5, burn_rate_3h_usd_per_hour: 1, fetched_at: NOON_UTC };
  const utc = cost.computeHotVerdict({ ...base, day_bucket_timezone: "UTC" });
  const kst = cost.computeHotVerdict({ ...base, day_bucket_timezone: "Asia/Seoul" }); // 21:00 KST → 3h left

  assert.ok(Math.abs(utc.paceRatio! - (5 + 12) / 10) < 1e-9);
  assert.ok(Math.abs(kst.paceRatio! - (5 + 3) / 10) < 1e-9);

  for (const broken of [{ day_bucket_timezone: "Not/AZone" }, { day_bucket_timezone: "UTC", fetched_at: "x" }, {}]) {
    const hot = cost.computeHotVerdict({ window_7d_cost_usd: 70, today_cost_usd: 5, burn_rate_3h_usd_per_hour: 1, ...broken });
    assert.strictEqual(hot.paceRatio, null, JSON.stringify(broken));
    assert.doesNotMatch(hot.verdict, /pace/);
  }
});

test("a missing or unusable kpi figure stays null rather than collapsing to zero", () => {
  for (const kpi of [{}, { today_cost_usd: null, window_7d_cost_usd: 0 }, { today_cost_usd: "x", window_7d_cost_usd: "y" }]) {
    const hot = cost.computeHotVerdict(kpi);
    assert.strictEqual(hot.ratio, null, JSON.stringify(kpi));
    assert.strictEqual(hot.isHot, false);
    assert.strictEqual(hot.verdict, "", "no ratio means no verdict sentence to state");
  }
});

test("the window total sums the series, and an unloaded window is distinguishable from an empty one", () => {
  const total = cost.computeWindowTotal(getTrendPoints([1, 2, 3, 4]));
  assert.strictEqual(total.total, 10);
  assert.strictEqual(total.avgDaily, 2.5);
  assert.strictEqual(total.peakCost, 4);
  assert.strictEqual(total.isEmpty, false);

  const emptyWindow = cost.computeWindowTotal(ready({ points: [] }));
  assert.strictEqual(emptyWindow.total, null, "an empty window has no total, not a zero total");
  assert.strictEqual(emptyWindow.isEmpty, true);

  for (const state of [loading, failed]) {
    const unloaded = cost.computeWindowTotal(state);
    assert.strictEqual(unloaded.total, null, state.status);
    assert.strictEqual(unloaded.isEmpty, false, `${state.status} must not read as an empty window`);
  }
});

test("a window tag names the range its figures were read for, never the range still in flight", () => {
  const rows = [
    { name: "a 30d payload on screen while 7d loads", state: { status: "ready", data: {}, error: null, busy: true, key: "/api/cost/by-model?days=30", pendingKey: "/api/cost/by-model?days=7" }, requested: 7, shown: 30 },
    { name: "the 7d payload landed", state: { status: "ready", data: {}, error: null, busy: false, key: "/api/cost/by-model?days=7", pendingKey: null }, requested: 7, shown: 7 },
    { name: "the 7d request failed over the held 90d payload", state: { status: "ready", data: {}, error: "boom", busy: false, key: "/api/dashboard/cost-timeseries?days=90&prior_window=1", pendingKey: null }, requested: 7, shown: 90 },
    { name: "nothing landed yet", state: { status: "loading", data: null, error: null, busy: true, key: null, pendingKey: "/api/cost/by-model?days=7" }, requested: 7, shown: 7 },
  ];
  for (const row of rows) {
    assert.strictEqual(cost.getShownDays(row.state, row.requested), row.shown, row.name);
  }
});

// The shown window's prior span, as the server returns it on the opt-in.
const PRIOR_BOUNDS = { period_start: "2025-12-30", period_end: "2026-01-03", cut_time: "14:05:00" };

// Tokens split over all four categories → a delta reading one category alone misses the total.
function getPriorBlock(costUsd: number, tokens = 0): Record<string, unknown> {
  return {
    ...PRIOR_BOUNDS, cost_usd: costUsd,
    input_tokens: tokens / 2, cache_read_tokens: tokens / 4, output_tokens: tokens / 8, cache_creation_tokens: tokens / 8,
  };
}

function getTrendWithPrior(costs: readonly number[], prior: Record<string, unknown> | null): PanelState {
  return ready({
    days: costs.length,
    points: costs.map((c, i) => ({ day: `d${i}`, cost_usd: c })),
    ...(prior === null ? {} : { prior_window: prior }),
  });
}

describe("the cost tile's delta compares the window total with the server's prior window", () => {
  const rows = [
    { name: "a total above the prior window reads up", costs: [1, 2, 3, 4], prior: 5, delta: 100 },
    { name: "a total below the prior window reads down", costs: [1, 2, 3, 4], prior: 20, delta: -50 },
    { name: "a total equal to the prior window reads unchanged, whatever the shape", costs: [4, 3, 2, 1], prior: 10, delta: 0 },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.strictEqual(cost.computeWindowTotal(getTrendWithPrior(row.costs, getPriorBlock(row.prior))).delta, row.delta);
    });
  }
});

test("every shown day moves the cost delta — the first day and today's partial point included", () => {
  const base = [2, 2, 2, 2];
  const flat = cost.computeWindowTotal(getTrendWithPrior(base, getPriorBlock(8))).delta;
  for (const index of [0, base.length - 1]) {
    const raised = base.map((c, i) => (i === index ? c + 4 : c));
    const delta = cost.computeWindowTotal(getTrendWithPrior(raised, getPriorBlock(8))).delta;
    assert.ok(delta !== null && flat !== null && delta > flat, `raising day ${index} raises the delta`);
  }
});

test("the cost delta states no percentage without a prior window or against a zero one", () => {
  const absent = cost.computeWindowTotal(getTrendWithPrior([1, 2], null));
  assert.strictEqual(absent.delta, null);
  assert.strictEqual(absent.prior, null, "an absent block is no comparison, never a fallback rule");

  const zero = cost.computeWindowTotal(getTrendWithPrior([1, 2], getPriorBlock(0)));
  assert.strictEqual(zero.delta, null, "a zero base has no percentage change");
  assert.strictEqual(zero.prior?.period_end, PRIOR_BOUNDS.period_end, "a zero prior still names its window");
});

test("the stamp reads the region states: busy is never fresh, and one failed region of several is partial", () => {
  const ui = cost.window.UI;
  const now = Date.parse(NOON_UTC);
  const readAt = new Date(now - 60_000).toISOString();
  const getState = (at: string | null, panels: PanelState[]) =>
    ui.getFreshnessState({ ...cost.getFreshnessInputC(at, panels), now });
  const refreshing: PanelState = { ...ready({}), busy: true };
  const heldFailure: PanelState = { ...ready({}), error: "HTTP 500 Internal Server Error" };

  const rows: ReadonlyArray<{ name: string; at: string | null; panels: PanelState[]; expected: string }> = [
    { name: "every region settled", at: readAt, panels: [ready({}), ready({})], expected: "fresh" },
    { name: "a refresh over held data", at: readAt, panels: [refreshing, ready({})], expected: "refreshing" },
    { name: "the first wave", at: null, panels: [loading, loading], expected: "loading" },
    { name: "one region failed with nothing held", at: readAt, panels: [ready({}), failed], expected: "partial" },
    { name: "one region failed over held data", at: readAt, panels: [ready({}), heldFailure], expected: "partial" },
    { name: "every region failed after a read", at: readAt, panels: [failed, failed], expected: "stale" },
    { name: "every region failed before any read", at: null, panels: [failed, failed], expected: "not-read" },
  ];
  for (const row of rows) {
    assert.strictEqual(getState(row.at, row.panels), row.expected, row.name);
  }
});

test("a refresh keeps the last payload on screen while in flight and after the request fails", async () => {
  const held = { points: [{ day: "d0", cost_usd: 4 }] };
  let state: PanelState = { ...cost.window.UI.INITIAL_REGION_STATE, ...ready(held) };
  const setter = (update: (prev: PanelState) => PanelState) => { state = update(state); };
  cost.fetch = async () => ({
    ok: false,
    status: 500,
    statusText: "Internal Server Error",
    text: async () => "<html><b>relation core.outcomes does not exist</b></html>",
  });

  const pending = cost.runFetchC("/api/cost/kpi", new AbortController(), setter);
  assert.strictEqual(state.busy, true, "the request is in flight");
  assert.strictEqual(state.data, held, "held data stays while the request is in flight");

  await pending;
  assert.strictEqual(state.data, held, "a failed refresh never wipes the held payload");
  assert.strictEqual(state.status, "ready");
  assert.strictEqual(state.busy, false);
  assert.match(String(state.error), /^HTTP 500\b/, "the failure is recorded for the stamp and the error copy");
  assert.doesNotMatch(String(state.error), /</, "response markup never reaches the operator");
});

function getCostStates(overrides: Record<string, PanelState>): Record<string, PanelState> {
  const names = ["kpiState", "tokenState", "modelState", "cacheState", "sessionState", "errorState", "turnState"];
  return { ...Object.fromEntries(names.map((name) => [name, ready({})])), ...overrides };
}

test("an outage shared by two payloads is one banner naming both, and a lone failure stays on its region", () => {
  const withTrend = cost.getCostSourceFailuresC(getCostStates({ kpiState: failed, tokenState: { ...ready({}), error: failed.error } }));
  assert.deepEqual(withTrend.banner && [...withTrend.banner.sources], ["cost KPIs", "cost trend"], "a failure over held data still joins the outage");
  assert.strictEqual(cost.getCostSourceFailuresC(getCostStates({ kpiState: failed })).banner, null, "one failed payload is no page-level outage");
});

test("the payload drawn in two regions counts once toward the outage and speaks from its first region", async () => {
  const lone = cost.getCostSourceFailuresC(getCostStates({ tokenState: failed }));
  assert.strictEqual(lone.banner, null, "one payload in two regions is still one failed source");
  assert.strictEqual(lone.speakers.get("cost trend"), "cost trend", "the trend chart speaks, the token chart defers to it");
  const all = cost.getCostSourceFailuresC(getCostStates(Object.fromEntries(Object.keys(getCostStates({})).map((k) => [k, failed]))));
  assert.strictEqual(all.banner?.sources.length, 7, "seven payloads, seven named sources");

  const mod = (await loadScreenModule(COST_SRC, { UI: getAtomUi(), React: createReactStub() })) as RenderModule;
  const token = renderIn(mod, "TokenStackedBody", { state: failed, days: 30, onRetry: () => {}, failures: lone });
  const card = findNodes(token, (n) => n.props.atom === "RegionFailure")[0];
  assert.deepEqual([card.props.source, card.props.region, card.props.failures], ["cost trend", "token trend", lone]);
});

test("cache share is a share of priced cost, and a zero-cost window yields no share", () => {
  const share = cost.computeCacheShare(
    ready({
      rows: [
        {
          model: "claude-opus-5",
          cost_usd: 100,
          input_tokens: 10,
          output_tokens: 10,
          cache_read_tokens: 60,
          cache_creation_tokens: 20,
        },
      ],
    }),
  );
  assert.ok(share.share !== null);
  assert.ok(Math.abs(share.share - 0.8) < 1e-9, "cache read + write over the priced total");
  assert.strictEqual(share.cacheCost, 80);

  const freeWindow = cost.computeCacheShare(
    ready({ rows: [{ model: "claude-opus-5", cost_usd: 0, input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 1 }] }),
  );
  assert.strictEqual(freeWindow.share, null, "0% would read as 'cache is free' rather than 'no share to state'");

  assert.strictEqual(cost.computeCacheShare(ready({ rows: [] })).isEmpty, true);
  assert.strictEqual(cost.computeCacheShare(loading).isEmpty, false);
});

test("the session Other row closes the population it was cut from", () => {
  const sessions = Array.from({ length: 12 }, (_, i) => ({
    session_id: `s${i}`,
    total_cost_usd: i + 1,
  }));
  const topN = 5;
  const rollup = cost.rollupSessionRows(sessions, topN);

  assert.strictEqual(rollup.total, sessions.length);
  assert.strictEqual(rollup.top.length, topN);
  assert.ok(rollup.other !== null);
  assert.strictEqual(
    rollup.top.length + rollup.other.count,
    rollup.total,
    "top rows plus the Other count must exhaust the population — no session may vanish",
  );

  const wholeSum = sessions.reduce((s, r) => s + r.total_cost_usd, 0);
  const topSum = rollup.top.reduce((s, r) => s + Number(r.total_cost_usd), 0);
  assert.ok(
    Math.abs(topSum + rollup.other.cost_usd - wholeSum) < 1e-9,
    "the Other cost must be the remainder, so the panel's arithmetic closes",
  );

  const topCosts = [...rollup.top].map((r) => Number(r.total_cost_usd));
  assert.deepStrictEqual(topCosts, [...topCosts].sort((a, b) => b - a), "the top rows read most-expensive first");
  const restMax = (wholeSum - topSum) / rollup.other.count;
  assert.ok(
    Math.min(...topCosts) >= restMax,
    "every top row must outrank the rows folded into Other",
  );
});

test("nothing is rolled into Other when the population fits", () => {
  const sessions = [
    { session_id: "a", total_cost_usd: 3 },
    { session_id: "b", total_cost_usd: 1 },
  ];
  for (const topN of [2, 5]) {
    const rollup = cost.rollupSessionRows(sessions, topN);
    assert.strictEqual(rollup.other, null, `topN=${topN}`);
    assert.strictEqual(rollup.top.length, sessions.length);
  }
  const none = cost.rollupSessionRows([], 5);
  assert.strictEqual(none.other, null);
  assert.strictEqual(none.total, 0);
});

test("every tile state is distinct, and only ready renders a measured value", () => {
  const cases: ReadonlyArray<readonly [PanelState, unknown, boolean, PanelStatus]> = [
    [loading, 1, false, "loading"],
    [failed, 1, false, "error"],
    [{ ...failed, status: "loading", busy: true }, 1, false, "error"],
    [{ ...ready({}), error: "HTTP 500 Internal Server Error" }, 0, false, "ready"],
    [ready({}), 1, true, "empty"],
    [ready({}), null, false, "unavailable"],
    [ready({}), undefined, false, "unavailable"],
    [ready({}), 0, false, "ready"],
  ];
  for (const [state, value, isEmpty, expected] of cases) {
    const status = cost.getTileStatus(state, value, isEmpty);
    assert.strictEqual(status, expected, `${state.status}/${String(value)}/${isEmpty}`);
  }

  for (const status of ["error", "empty", "unavailable"] as const) {
    assert.ok(cost.getTileNote(status, "no normal to compare against").length > 0, status);
  }
  assert.strictEqual(cost.getTileNote("ready", "x"), "", "a ready tile states its value, not a note");
});

test("a model reads by one display name in every table, and an unattributed model never reads as a model name", () => {
  assert.equal(
    cost.getModelLabelC("claude-opus-5"),
    cost.getModelLabelC("opus-5"),
    "the full id and its short form are one model, so they must read the same",
  );
  assert.notEqual(cost.getModelLabelC("claude-opus-5"), "claude-opus-5", "a raw id is not a display name");
  for (const model of [null, undefined, "", "unknown", "<synthetic>"]) {
    assert.equal(cost.getModelLabelC(model), "Unattributed", `model ${String(model)}`);
  }
});

test("a session's last-seen instant never lands after now, and a past instant passes through", () => {
  const now = Date.parse("2026-09-25T00:48:00.000Z");
  const rows: ReadonlyArray<readonly [string, string, number]> = [
    ["future by hours", "2026-09-25T06:54:20.000Z", now],
    ["future by a second", "2026-09-25T00:48:01.000Z", now],
    ["past", "2026-09-24T21:00:00.000Z", Date.parse("2026-09-24T21:00:00.000Z")],
    ["exactly now", "2026-09-25T00:48:00.000Z", now],
  ];
  for (const [name, iso, expectedMs] of rows) {
    assert.equal(Date.parse(cost.getClampedInstantC(iso, now)!), expectedMs, name);
  }
  for (const blank of [null, undefined, "", "not a date"]) {
    assert.equal(cost.getClampedInstantC(blank, now), null, `blank ${String(blank)}`);
  }
});

test("a session reads by the leading 8 characters of its id", () => {
  const id = "b81996da-3c1e-4f7a-9d2b-0e5c6a7b8c9d";
  assert.equal(cost.getSessionShortId(id), "b81996da");
  assert.ok(id.startsWith(cost.getSessionShortId(id)), "the short form is a prefix, so it can be searched");
  assert.equal(cost.getSessionShortId("short"), "short", "an id at or under 8 characters is kept whole");
});

test("the session drawer hides a field it has no value for, and keeps the full id", () => {
  const now = Date.parse("2026-09-25T00:48:00.000Z");
  const full = {
    session_id: "b81996da-3c1e-4f7a-9d2b-0e5c6a7b8c9d",
    top_model: "claude-opus-5",
    total_cost_usd: 12.5,
    total_tokens: 1000,
    event_count: 4,
    last_event_at: "2026-09-24T21:00:00.000Z",
  };
  const terms = (session: Record<string, unknown>) => [...cost.getSessionFactsC(session, now)].map((f) => f[0]);
  assert.ok(terms(full).includes("Last seen"));
  assert.equal(cost.getSessionFactsC(full, now)[0]![1], full.session_id, "the drawer is where the whole id lives");
  assert.ok(!terms({ ...full, last_event_at: null }).includes("Last seen"), "no instant → no Last seen row");
});

test("the session drawer's task-results link does not promise a session-scoped view it cannot open", async () => {
  interface DrawerElement {
    type: unknown;
    props: Record<string, unknown>;
  }
  interface DrawerSandbox {
    React: { createElement: unknown };
    SessionDetailDrawerC: (props: Record<string, unknown>) => DrawerElement;
  }
  // Own sandbox → the element-recording factory never leaks into the shared `cost` one.
  const sandbox = await buildScreenSandbox<DrawerSandbox>(COST_SRC);
  sandbox.React.createElement = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => ({
    type,
    props: { ...(props ?? {}), children: rest.length > 1 ? rest : rest[0] },
  });
  const collectButtons = (node: unknown, out: DrawerElement[]): DrawerElement[] => {
    if (Array.isArray(node)) {
      for (const child of node) collectButtons(child, out);
      return out;
    }
    if (typeof node !== "object" || node === null || !("props" in node)) return out;
    const el = node as DrawerElement;
    if (el.type === "button") out.push(el);
    return collectButtons(el.props.children, out);
  };
  const navCalls: unknown[][] = [];
  const session = { session_id: "b81996da-3c1e-4f7a-9d2b-0e5c6a7b8c9d", total_cost_usd: 1 };
  const drawer = sandbox.SessionDetailDrawerC({ session, onClose: () => {}, onNav: (...args: unknown[]) => navCalls.push(args) });

  const [link] = collectButtons(drawer, []).filter((b) => {
    const before = navCalls.length;
    (b.props.onClick as () => void)();
    return navCalls.length > before;
  });
  assert.ok(link, "the drawer still links to Task results");
  assert.deepEqual(navCalls, [["outcomes"]], "the destination carries no session scope");
  assert.match(String(link.props.children), /^All task results/, "an unscoped destination is labelled as the whole list");
});

test("the running-hot sentence is stated once — in the lane when it fires, on tile 1 otherwise", () => {
  const cases: ReadonlyArray<readonly [string, Partial<HotVerdict>, boolean]> = [
    ["calm", {}, false],
    ["so-far ratio", { isHot: true }, false],
    ["pace ratio", { isPaceHot: true }, false],
    ["outlier day only", {}, true],
    ["both ratios", { isHot: true, isPaceHot: true }, true],
  ];
  const verdict = "Today is 81% of the 7-day daily normal so far, on pace for 3.1x it.";
  for (const [name, delta, outsideBand] of cases) {
    const hot = { ...CALM, verdict, ...delta };
    const laneTexts = [...cost.computeAlarmRows({ hot, latestOutsideBand: outsideBand, parseError: { crit: 0, total: 9 } })]
      .map((r) => r.text);
    const pageVerdict = cost.getSpendVerdictC({ hot, latestOutsideBand: outsideBand, kpiStatus: "ready" }).text;
    assert.ok(!pageVerdict.includes(verdict), `${name}: the page verdict names the state, never the figures`);
    const places = [...laneTexts, cost.getTileVerdictTextC(hot)].filter((t) => t.includes(verdict)).length;
    assert.equal(places, 1, name);
  }
});

test("the page verdict carries the lane's hot tone when it fires, and reads on pace when nothing fires", () => {
  const cases: ReadonlyArray<readonly [string, Partial<HotVerdict>, boolean]> = [
    ["calm", {}, false],
    ["so-far ratio", { isHot: true }, false],
    ["pace only", { isPaceHot: true }, false],
    ["outlier day only", {}, true],
    ["so-far and pace", { isHot: true, isPaceHot: true }, true],
  ];
  for (const [name, delta, outsideBand] of cases) {
    const hot = { ...CALM, ...delta };
    const hotRow = [...cost.computeAlarmRows({ hot, latestOutsideBand: outsideBand, parseError: { crit: 0, total: 9 } })]
      .find((r) => r.key === "hot");
    const verdict = cost.getSpendVerdictC({ hot, latestOutsideBand: outsideBand, kpiStatus: "ready" });
    assert.equal(verdict.tone, hotRow ? hotRow.tone : "ok", name);
    assert.equal(verdict.label, hotRow ? "Above normal" : "On pace", name);
  }
});

test("the page verdict claims no spend state without a measured normal", () => {
  const rows: ReadonlyArray<{ name: string; hot: HotVerdict; kpiStatus: string }> = [
    { name: "kpi still loading", hot: CALM, kpiStatus: "loading" },
    { name: "kpi failed", hot: { ...CALM, isHot: true }, kpiStatus: "error" },
    { name: "no 7-day normal", hot: { ...CALM, ratio: null, normalDaily: null }, kpiStatus: "ready" },
  ];
  for (const row of rows) {
    const verdict = cost.getSpendVerdictC({ hot: row.hot, latestOutsideBand: true, kpiStatus: row.kpiStatus });
    assert.equal(verdict.tone, "neutral", row.name);
    assert.ok(verdict.text.length > 0, `${row.name}: the line still says why there is no verdict`);
  }
});

test("the hot row is red only past the so-far cut; a projection or an outlier day is amber", () => {
  const cases: ReadonlyArray<readonly [string, Partial<HotVerdict>, boolean, string]> = [
    ["so-far ratio", { isHot: true }, false, "crit"],
    ["so-far and pace", { isHot: true, isPaceHot: true }, true, "crit"],
    ["pace only", { isPaceHot: true }, false, "warn"],
    ["outlier day only", {}, true, "warn"],
  ];
  for (const [name, delta, outsideBand, tone] of cases) {
    const rows = cost.computeAlarmRows({ hot: { ...CALM, ...delta }, latestOutsideBand: outsideBand, parseError: { crit: 0, total: 9 } });
    assert.equal(rows[0]!.tone, tone, name);
  }
});

test("a stop reason's session share is taken over the whole session population, never over the column sum", () => {
  // Two reasons each hit by 6 of 10 sessions: the column sums to 12, yet each share stays 0.6.
  assert.equal(cost.getStopReasonSessionShare(6, 10), 0.6);
  assert.equal(cost.getStopReasonSessionShare(10, 10), 1);
  assert.equal(cost.getStopReasonSessionShare(0, 0), null, "an empty population has no share");
});

test("only today's point is partial, and its dashed segment joins the last complete day", () => {
  for (const count of [1, 2, 5]) {
    const rows = [...cost.markPartialDay(Array.from({ length: count }, (_, i) => ({ actual: i + 1 })))];
    const last = count - 1;
    rows.forEach((row, i) => {
      assert.strictEqual(row.isPartial, i === last, `row ${i} of ${count}`);
      assert.strictEqual(row.completeCost, i === last ? null : row.actual, `complete line, row ${i} of ${count}`);
      assert.strictEqual(row.partialCost, i >= last - 1 ? row.actual : null, `so-far segment, row ${i} of ${count}`);
    });
  }
});

test("every tick on one cost axis carries the same decimals and reads back as its own value", () => {
  const axes = [
    { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] },
    { max: 10, ticks: [0, 2.5, 5, 7.5, 10] },
    { max: 600, ticks: [0, 150, 300, 450, 600] },
    { max: 12000, ticks: [0, 3000, 6000, 9000, 12000] },
  ];
  for (const { max, ticks } of axes) {
    const format = cost.getUsdAxisFormatter(max);
    const labels = ticks.map((t) => format(t));
    const decimals = new Set(labels.map((l) => (l.split(".")[1] ?? "").length));
    assert.strictEqual(decimals.size, 1, `max ${max}: ${labels.join(" ")}`);
    labels.forEach((label, i) => {
      assert.strictEqual(Number(label.replace(/[$,]/g, "")), ticks[i], `max ${max}: ${label}`);
    });
  }
});

test("a hit-rate axis ticks on one even step inside its domain, whole percents on a wide one, and a top clamped at 100 is always a tick", () => {
  const rows = [
    { name: "the [0,100] fallback", domain: [0, 100] as const },
    { name: "a wide window clamped at 100", domain: [88.5, 100] as const },
    { name: "a narrow window clamped at 100", domain: [96, 100] as const },
    { name: "a window below 100", domain: [40.3, 62.7] as const },
  ];
  for (const { name, domain } of rows) {
    const ticks = cost.getCacheTicks(domain);
    const steps = new Set(ticks.slice(1).map((t, i) => (t - ticks[i]!).toFixed(6)));
    assert.ok(ticks.length >= 2 && ticks.length <= 6, `${name}: ${ticks.join(" ")}`);
    assert.ok(ticks.every((t) => t >= domain[0] && t <= domain[1]), `${name}: ${ticks.join(" ")}`);
    assert.strictEqual(steps.size, 1, `${name}: ${ticks.join(" ")}`);
    if (domain[1] - domain[0] >= 5) assert.ok(ticks.every(Number.isInteger), `${name}: ${ticks.join(" ")}`);
    if (domain[1] === 100) assert.strictEqual(ticks.at(-1), 100, `${name}: ${ticks.join(" ")}`);
  }
});

test("the focus readout names the normal range exactly when the band is on and the day has one", () => {
  const banded = { fullDate: "Sep 20", actual: 12, isPartial: false, rollingMean: 10, lowerBand: 4, upperBand: 16 };
  const unbanded = { fullDate: "Sep 14", actual: 3, isPartial: false, rollingMean: null, lowerBand: null, upperBand: null };
  const rows = [
    { name: "band on, day inside the rolling window", row: banded, bandOn: true, hasRange: true },
    { name: "band off hides the range the tooltip also hides", row: banded, bandOn: false, hasRange: false },
    { name: "band on, day before the window fills", row: unbanded, bandOn: true, hasRange: false },
  ];
  for (const { name, row, bandOn, hasRange } of rows) {
    const text = cost.getTrendReadout(row, bandOn);
    assert.ok(text.startsWith("Sep "), `${name}: ${text}`);
    assert.ok(text.includes(cost.window.UI.formatUsdCompact(row.actual)), `${name}: ${text}`);
    assert.strictEqual(/normal range/i.test(text), hasRange, `${name}: ${text}`);
    if (hasRange) {
      const low = cost.window.UI.formatUsdCompact(4);
      const high = cost.window.UI.formatUsdCompact(16);
      assert.ok(text.includes(low) && text.includes(high), `${name}: ${text}`);
    }
  }
});

test("the focus readout marks today's point as so far, never as a finished day", () => {
  const today = { fullDate: "Sep 25", actual: 2, isPartial: true, rollingMean: null, lowerBand: null, upperBand: null };
  assert.match(cost.getTrendReadout(today, false), /Sep 25 so far/);
  assert.doesNotMatch(cost.getTrendReadout({ ...today, isPartial: false }, false), /so far/);
});

test("an expanded model detail line names the model it belongs to", () => {
  const tokens = { input_tokens: 1_190_000, output_tokens: 5_840_000, cache_read_tokens: 9e8, cache_creation_tokens: 2e7 };
  const models = ["opus 5", "fable 5.1", "Unattributed"];
  const lines = models.map((model) => cost.getModelTokenDetail({ model, ...tokens }));
  models.forEach((model, i) => assert.ok(lines[i].startsWith(model), lines[i]));
  assert.strictEqual(new Set(lines).size, models.length);
});

test("the spend headline's share is held by exactly the rows the table shows", () => {
  const toSessions = (costs: readonly number[]) =>
    costs.map((c, i) => ({ session_id: `s${i}`, total_cost_usd: c }));
  const rows = [
    { name: "more sessions than the table shows", costs: [30, 10, 40, 10, 5, 5, 1] },
    { name: "fewer sessions than the table holds", costs: [10, 80, 10] },
    { name: "flat spend", costs: Array.from({ length: 20 }, () => 1) },
  ];
  const topN = 5;
  for (const { name, costs } of rows) {
    const got = cost.getSpendConcentration(toSessions(costs), topN);
    assert.ok(got, name);
    const shown = cost.rollupSessionRows(toSessions(costs), topN).top;
    const total = costs.reduce((s, c) => s + c, 0);
    assert.equal(got.count, shown.length, `${name}: the lead counts the shown rows`);
    const shownSum = [...shown].reduce((s, r) => s + r.total_cost_usd, 0);
    assert.ok(Math.abs(got.share - shownSum / total) < 1e-9, name);
  }
  assert.strictEqual(cost.getSpendConcentration(toSessions([0, 0]), topN), null);
});

test("stop reasons read as plain words, with the raw id kept as the secondary label", () => {
  for (const reason of ["no_assistant_in_turn", "end_turn", "tool_use", "unknown", "max_tokens"]) {
    const meta = cost.turnStopReasonMeta(reason);
    assert.strictEqual(meta.raw, reason);
    if (reason !== "max_tokens") assert.doesNotMatch(meta.label, /_|^unknown$/, reason);
  }
});

test("a log-integrity bar reads as over threshold exactly when it rises above the threshold line on the same count axis", () => {
  const rows = [
    { event_date: "2026-09-01", error_count: 6, total_count: 100 },
    { event_date: "2026-09-02", error_count: 5, total_count: 100 },
    { event_date: "2026-09-03", error_count: 0, total_count: 40 },
    { event_date: "2026-09-04", error_count: 3, total_count: 20 },
    { event_date: "2026-09-05", error_count: 0, total_count: 0 },
  ].map((r) => ({ ...r, error_ratio: r.total_count > 0 ? r.error_count / r.total_count : 0 }));
  const chartRows = cost.getParseErrorChartRows(rows);
  assert.strictEqual(chartRows.length, rows.length);
  chartRows.forEach((r, i) => {
    assert.strictEqual(r.isCrit, r.error_count > r.threshold_count, rows[i].event_date);
  });
  assert.ok(chartRows.some((r) => r.isCrit) && chartRows.some((r) => !r.isCrit));
});

test("the hit-rate strip names its no-data days, and says nothing when every day has a rate", () => {
  const rows = [
    { name: "no gaps", rates: [98.1, 97.5, 99.0], gaps: 0 },
    { name: "one gap", rates: [98.1, null, 99.0], gaps: 1 },
    { name: "all gaps", rates: [null, null], gaps: 2 },
  ];
  for (const { name, rates, gaps } of rows) {
    const label = cost.getNoDataLabelC(rates);
    if (gaps === 0) {
      assert.strictEqual(label, null, name);
      continue;
    }
    assert.ok(label, name);
    assert.match(label, new RegExp(`^${gaps} of ${rates.length} days? no data$`), name);
  }
});

const TOKEN_UNIT: Record<string, number> = { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

test("every tick on one token axis carries one unit, fits the axis, and reads back as its own value", () => {
  // Recharts rounds its top tick up past the data max, so each row's ticks reach beyond it.
  const axes = [
    { name: "hundreds of millions", max: 8.7e8, ticks: [0, 2.5e8, 5e8, 7.5e8, 1e9] },
    { name: "tens of billions", max: 3.6e10, ticks: [0, 1e10, 2e10, 3e10, 4e10] },
    { name: "a single-digit lead needs one decimal", max: 1.5e9, ticks: [0, 4e8, 8e8, 1.2e9, 1.6e9] },
    { name: "thousands", max: 8000, ticks: [0, 2500, 5000, 7500, 10000] },
    { name: "below a thousand", max: 60, ticks: [0, 15, 30, 45, 60] },
  ];
  for (const { name, max, ticks } of axes) {
    const format = cost.getTokenAxisFormatter(max);
    const labels = ticks.map((t) => format(t));
    const suffixes = new Set(labels.filter((l) => l !== "0").map((l) => l.replace(/[\d.]/g, "")));
    assert.strictEqual(suffixes.size, 1, `${name}: ${labels.join(" ")}`);
    labels.forEach((label, i) => {
      // the 48px axis at the 13px mono meta step holds five characters
      assert.ok(label.length <= 5, `${name}: ${label}`);
      const digits = label.replace(/[^\d.]/g, "");
      const unit = TOKEN_UNIT[label.replace(/[\d.]/g, "")]!;
      const step = unit * 10 ** -((digits.split(".")[1] ?? "").length);
      assert.ok(Math.abs(Number(digits) * unit - ticks[i]!) <= step / 2, `${name}: ${label} vs ${ticks[i]}`);
    });
  }
});

test("token shares split the window total by category and sum to the whole", () => {
  const points = [
    { input_tokens: 1_000, output_tokens: 5_000, cache_read_tokens: 900_000, cache_creation_tokens: 20_000 },
    { input_tokens: 3_000, output_tokens: 1_000, cache_read_tokens: 700_000, cache_creation_tokens: 0 },
  ];
  const shares = cost.computeTokenShares(points);
  assert.ok(shares);
  const total = points.reduce((s, p) => s + Object.values(p).reduce((a, b) => a + b, 0), 0);
  for (const row of shares) {
    const expected = points.reduce((s, p) => s + (p[row.key as keyof typeof p] ?? 0), 0);
    assert.strictEqual(row.total, expected, row.key);
    assert.ok(Math.abs(row.share - expected / total) < 1e-12, row.key);
  }
  assert.ok(Math.abs(shares.reduce((s, r) => s + r.share, 0) - 1) < 1e-12);
  assert.strictEqual(cost.computeTokenShares([{ input_tokens: 0, output_tokens: 0 }]), null, "a zero window has no share");
});

test("the stack draws the largest category last, so the top edge carries that series' own stroke", () => {
  const rows = [
    { name: "cache read dominates", totals: { cache_creation_tokens: 2e7, cache_read_tokens: 9e8, input_tokens: 1e6, output_tokens: 6e6 } },
    { name: "output dominates", totals: { cache_creation_tokens: 10, cache_read_tokens: 20, input_tokens: 30, output_tokens: 400 } },
  ];
  for (const { name, totals } of rows) {
    const shares = Object.entries(totals).map(([key, total]) => ({ key, total }));
    const order = [...cost.getTokenStackOrder(shares)];
    assert.deepStrictEqual(order.map((r) => r.key).sort(), Object.keys(totals).sort(), name);
    order.slice(1).forEach((r, i) => assert.ok(r.total >= order[i]!.total, `${name}: ${order.map((o) => o.key).join(" ")}`));
  }
});

test("the turn headline states one per-session figure and reconciles its session count with the population", () => {
  const rows = [
    { name: "fewer sessions logged a turn count", counted: 257, population: 582 },
    { name: "every session logged a turn count", counted: 582, population: 582 },
  ];
  for (const { name, counted, population } of rows) {
    const { value, note } = cost.getTurnHeadline({ avg_turns_per_session: 91.25, turn_session_count: counted }, population);
    assert.strictEqual(value, "91.3", name);
    const numbers = note.match(/\d+/g) ?? [];
    assert.deepStrictEqual([...new Set(numbers)].sort(), [...new Set([String(counted), String(population)])].sort(), `${name}: ${note}`);
    assert.strictEqual(numbers.length, new Set(numbers).size, `${name}: each count stated once — ${note}`);
  }
  const none = cost.getTurnHeadline({ avg_turns_per_session: 0, turn_session_count: 0 }, 40);
  assert.strictEqual(none.value, null, "no counted session has no average");
});

// --- Error cards survive their Retry, and a held read under a failure never reads current ---

type ElementFactory = (props: unknown) => unknown;
interface RenderModule {
  React: { createElement: (type: unknown, props: unknown) => unknown };
  [name: string]: unknown;
}

// real ui.jsx helpers, with every rendered atom a host element carrying its props
function getAtomUi(overrides: Record<string, unknown> = {}): unknown {
  const real = cost.window.UI as Record<string, unknown>;
  return new Proxy({}, {
    get: (_target, name: string) => {
      if (name in overrides) return overrides[name];
      const value = real[name];
      if (typeof value !== "function" || /^[a-z]/.test(name)) return value;
      return (props: Record<string, unknown>) => ({ __element: true, type: "ui-atom", props: { ...props, atom: name } });
    },
    has: () => true,
  });
}

function renderIn(mod: RenderModule, name: string, props: Record<string, unknown>): RenderedNode {
  return renderScreen(mod.React.createElement(mod[name] as ElementFactory, props)) as RenderedNode;
}

test("a cold-failed region keeps its error card mounted and busy while its Retry is in flight", async () => {
  const mod = (await loadScreenModule(COST_SRC, { UI: getAtomUi(), React: createReactStub() })) as RenderModule;
  const retrying: PanelState = { status: "loading", data: null, error: "HTTP 500 Internal Server Error", busy: true };
  const bodies = [
    "CostTrendBody", "TokenStackedBody", "ModelCostBody", "CacheHitBody", "SessionDistributionBody", "ParseErrorBody", "TurnStatsBody",
  ];
  // the ids the page renders on its region wrappers, which stay mounted through any recovery
  const page = renderIn(mod, "ScreenCost", { onNav: () => {} });
  const regionIds = new Set(findNodes(page, (n) => n.type === "div" && typeof n.props.id === "string").map((n) => n.props.id));
  for (const name of bodies) {
    const tree = renderIn(mod, name, { state: retrying, days: 30, onRetry: () => {}, onNav: () => {} });
    const cards = findNodes(tree, (n) => n.props.atom === "RegionFailure");
    assert.equal(cards.length, 1, `${name} keeps its error card`);
    assert.equal(findNodes(tree, (n) => n.props.atom === "LoadingPlaceholder").length, 0, `${name} never swaps in a loader`);
    assert.equal(cards[0].props.isBusy, true, `${name} shows the Retry in flight`);
    assert.ok(regionIds.has(String(cards[0].props.focusTargetId)), `${name} hands focus to a region wrapper`);
  }
});

test("a cold-failed KPI payload retrying reads as failed on its tiles, never a skeleton beside its busy error card", async () => {
  const mod = (await loadScreenModule(COST_SRC, { UI: getAtomUi(), React: createReactStub() })) as RenderModule;
  const kpiState: PanelState = { status: "loading", data: null, error: "HTTP 500 Internal Server Error", busy: true };
  const settled = ready({ points: [{ day: "2026-01-09", cost_usd: 2 }], rows: [] });
  const tree = renderIn(mod, "KpiRowC", {
    kpiState, hot: cost.computeHotVerdict({}), trendState: settled, modelState: settled, days: 30, onRetry: () => {},
  });

  const cards = findNodes(tree, (n) => n.props.atom === "RegionFailure");
  assert.equal(cards.length, 1, "the KPI error card stays mounted");
  assert.equal(cards[0].props.isBusy, true);
  const tiles = findNodes(tree, (n) => n.type === "div" && n.props.className === "kpi");
  assert.equal(tiles.length, 4);
  assert.equal(tiles.filter((t) => t.props["aria-busy"] === "true").length, 0, "no tile reads as loading beside the card");
});

test("every cost region error card carries the page Retry, so a region the banner does not cover still offers one", async () => {
  const mod = (await loadScreenModule(COST_SRC, {
    UI: getAtomUi({ INITIAL_REGION_STATE: failed }), React: createReactStub(),
  })) as RenderModule;
  const tree = renderIn(mod, "ScreenCost", { onNav: () => {} });

  assert.equal(findNodes(tree, (n) => n.props.atom === "PageErrorBanner").length, 1, "the shared outage shows its banner");
  const cards = findNodes(tree, (n) => n.props.atom === "RegionFailure");
  assert.ok(cards.length >= 7, "every payload's region renders its error card");
  for (const card of cards) {
    assert.equal(typeof card.props.onRetry, "function", `${String(card.props.source)} keeps its Retry for RegionFailure to hide or show`);
  }
});

// each ScreenCost region state reads its initial value from this queue, in declaration order; the rest are first loads
function renderCostWithRegions(regions: PanelState[]): Promise<RenderedNode> {
  const regionInitial = {};
  const queue = [...regions];
  const react = {
    ...createReactStub(),
    useState: (initial: unknown) => [initial === regionInitial ? (queue.shift() ?? loading) : initial, () => undefined],
  };
  return loadScreenModule(COST_SRC, { UI: getAtomUi({ INITIAL_REGION_STATE: regionInitial }), React: react })
    .then((mod) => renderIn(mod as RenderModule, "ScreenCost", { onNav: () => {} }));
}

describe("the cost banner reads Retrying only while a failed region is re-read", () => {
  const rows = [
    { name: "two failed regions beside other panels' first loads are not retrying", regions: [failed, failed], isBusy: false },
    { name: "a failed region being re-read is retrying", regions: [failed, { ...failed, busy: true }], isBusy: true },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const [banner] = findNodes(await renderCostWithRegions(row.regions), (n) => n.props.atom === "PageErrorBanner");
      assert.equal(banner?.props.isBusy, row.isBusy);
    });
  }
});

test("the page verdict over a warm error reads Last known, never the all-clear", async () => {
  const ui = cost.window.UI;
  const now = Date.parse(NOON_UTC);
  const readAt = new Date(now - 60_000).toISOString();
  const warmError: PanelState = { ...ready({ ...getKpiAtRatio(1, 1), points: [], rows: [] }), error: "HTTP 500 Internal Server Error" };
  // ScreenCost's only null-initial state is the read instant → a settled earlier read
  const react = { ...createReactStub(), useState: (initial: unknown) => [initial === null ? readAt : initial, () => undefined] };
  const mod = (await loadScreenModule(COST_SRC, {
    UI: getAtomUi({ INITIAL_REGION_STATE: warmError }), React: react,
  })) as RenderModule;
  const tree = renderIn(mod, "ScreenCost", { onNav: () => {} });
  const [verdict] = findNodes(tree, (n) => n.props.id === "cost-verdict");
  const props = verdict.props as { tone: string; label?: string; freshness?: Record<string, unknown> };
  const shown = ui.getFreshnessVerdict({ ...props.freshness, tone: props.tone, label: props.label, now });
  assert.match(String(shown.label), /^Last known/, `the verdict reads ${String(shown.label)}`);
  assert.notEqual(shown.tone, "ok", "a held read under a failure never reads healthy");
});

// every Recharts part renders as a host node named after it, so a chart's wrapper and data are inspectable
const RECHARTS_STUB = new Proxy({}, {
  get: (_target, name: string) => (props: Record<string, unknown>) => ({ __element: true, type: `recharts-${name}`, props }),
  has: () => true,
});

async function loadCostRender(overrides: Record<string, unknown> = {}): Promise<RenderModule> {
  return (await loadScreenModule(COST_SRC, {
    UI: getAtomUi(overrides), React: createReactStub(), Recharts: RECHARTS_STUB,
  })) as RenderModule;
}

const isChart = (n: RenderedNode): boolean => typeof n.type === "string" && /^recharts-\w+Chart$/.test(n.type);

function getTokenDay(date: string, costUsd: number, sessions: number): Record<string, unknown> {
  return {
    date, cost_usd: costUsd, session_count: sessions,
    input_tokens: costUsd * 10, output_tokens: costUsd * 5, cache_read_tokens: costUsd * 100, cache_creation_tokens: costUsd * 20,
  };
}

// the server zero-fills a day nothing was recorded on → 01-06 is that day
const TREND_WITH_GAP = ready({
  points: [
    getTokenDay("2026-01-05", 3, 2), getTokenDay("2026-01-06", 0, 0), getTokenDay("2026-01-07", 4, 3),
    getTokenDay("2026-01-08", 2, 2), getTokenDay("2026-01-09", 5, 4), getTokenDay("2026-01-10", 1, 1),
  ],
});

const CACHE_ROWS = ["2026-01-08", "2026-01-09", "2026-01-10"].map((event_date, i) => ({
  event_date, cache_hit_rate: [0.97, 0.99, 0.985][i], total_cache_read: 900, total_input: 20,
}));

// Prior cost far above the shown cost → a delta reading cost instead of tokens would read down.
function getTokenTrend(tokens: readonly number[], priorTokens: number | null): PanelState {
  return ready({
    days: tokens.length,
    points: tokens.map((count, i) => ({
      date: `2026-01-0${i + 3}`, cost_usd: 1, session_count: 1,
      input_tokens: count, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    })),
    ...(priorTokens === null ? {} : { prior_window: getPriorBlock(1000, priorTokens) }),
  });
}

// text a screen reader announces \u2014 an aria-hidden subtree is skipped whole
function getSpokenText(node: RenderedNode | string | null): string {
  if (node === null || typeof node === "string") return collectText(node);
  if (node.props["aria-hidden"] === "true" || node.props["aria-hidden"] === true) return "";
  return node.children.map(getSpokenText).join(" ");
}

describe("the token volume total compares with the server's prior window, cut at this time of day", () => {
  const span = "vs the 4 days before 01-03, cut at this time of day";
  const rows = [
    { name: "more tokens than the prior window read up, whatever cost did", tokens: [100, 100, 100, 100], prior: 200, glyph: "\u25b2", spoken: new RegExp(`\\bup\\s+100\\s*%\\s*${span}`) },
    { name: "fewer tokens read down", tokens: [50, 50, 50, 50], prior: 400, glyph: "\u25bc", spoken: new RegExp(`\\bdown\\s+50\\s*%\\s*${span}`) },
    { name: "equal totals read unchanged", tokens: [100, 100, 100, 100], prior: 400, glyph: "\u2014", spoken: new RegExp(`\\bunchanged\\s+0\\s*%\\s*${span}`) },
    { name: "today's partial day counts toward the total it sits under", tokens: [100, 100, 100, 500], prior: 400, glyph: "\u25b2", spoken: new RegExp(`\\bup\\s+100\\s*%\\s*${span}`) },
    { name: "an absent prior window reads as no comparison", tokens: [100, 100], prior: null, glyph: null, spoken: /No comparison — the prior window did not arrive/ },
    { name: "a zero prior window states no percentage", tokens: [100, 100], prior: 0, glyph: null, spoken: /No comparison — the 2 days before 01-03 held no tokens\./ },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const mod = await loadCostRender();
      const tree = renderIn(mod, "TokenStackedBody", { state: getTokenTrend(row.tokens, row.prior), days: 30, onRetry: () => {} });
      const text = collectText(tree);
      if (row.glyph === null) assert.doesNotMatch(text, /[\u25b2\u25bc]/, "no direction glyph is drawn without a comparison");
      else assert.ok(text.includes(row.glyph), `the direction glyph ${row.glyph} is drawn`);
      assert.match(getSpokenText(tree), row.spoken, "the direction is announced in words, not only drawn");
    });
  }
});

describe("the cost tile names its prior window in words", () => {
  const rows = [
    { name: "a measured change names the window it compares with", prior: 5, spoken: /\bup\s+100\s*%\s*vs the 4 days before 01-03, cut at this time of day/ },
    { name: "a zero prior says the window held no cost", prior: 0, spoken: /No comparison — the 4 days before 01-03 held no cost\./ },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const mod = await loadCostRender();
      const kpi = getKpiAtRatio(1, 1);
      const tree = renderIn(mod, "KpiRowC", {
        kpiState: ready(kpi), hot: cost.computeHotVerdict(kpi), trendState: getTrendWithPrior([1, 2, 3, 4], getPriorBlock(row.prior)),
        modelState: ready({ rows: [] }), days: 30, onRetry: () => {},
      });
      assert.match(getSpokenText(tree), row.spoken);
    });
  }
});

test("every KPI hint fits the 40-character KPI-hint cap at the widest realistic figures", async () => {
  const mod = (await loadScreenModule(COST_SRC, {
    UI: getAtomUi(), React: createReactStub(), Recharts: RECHARTS_STUB,
    getTokenRate: () => ({ input: 1, output: 1, cache_read: 1, cache_creation: 1 }),
  })) as RenderModule;
  const kpi = {
    window_7d_cost_usd: 699_999.93, today_cost_usd: 123_456.78, burn_rate_3h_usd_per_hour: 9_999.99,
    cost_per_done_usd: 1_234.56, done_count_7d: 123_456, day_bucket_timezone: "UTC", fetched_at: NOON_UTC,
  };
  const modelRows = [{
    model: "claude-opus-4", cost_usd: 999_999.99, session_count: 12_345,
    input_tokens: 9e9, output_tokens: 9e9, cache_read_tokens: 9e11, cache_creation_tokens: 9e10,
  }];
  const tree = renderIn(mod, "KpiRowC", {
    kpiState: ready(kpi), hot: cost.computeHotVerdict(kpi), modelState: ready({ rows: modelRows }), days: 90, onRetry: () => {},
    trendState: ready({ days: 90, points: Array.from({ length: 90 }, (_, i) => ({ date: `d${i}`, cost_usd: 123_456.78 - i })) }),
  });
  const hints = findNodes(tree, (n) => /\bkpi-hint\b/.test(String(n.props.className ?? ""))).map((n) => collectText(n));
  assert.equal(hints.length, 4, "every tile states a hint at these figures");
  for (const hint of hints) assert.ok(hint.length <= 40, `"${hint}" is ${hint.length} chars`);
});

test("the window-cost tile keeps its counting rule behind an info trigger described by the tile label", async () => {
  const mod = await loadCostRender();
  const kpi = getKpiAtRatio(1, 1);
  const tree = renderIn(mod, "KpiRowC", {
    kpiState: ready(kpi), hot: cost.computeHotVerdict(kpi), trendState: getTrendPoints([1, 2, 3]),
    modelState: ready({ rows: [] }), days: 30, onRetry: () => {},
  });
  const infos = findNodes(tree, (n) => n.props.atom === "CardInfo");
  assert.equal(infos.length, 1, "one tile carries a counting rule");
  const [info] = infos;
  const [label] = findNodes(tree, (n) => n.props.id === info.props.describedBy);
  assert.equal(label ? collectText(label) : null, "Cost, last 30 days");
  assert.match(collectText(info), /recorded cost/i);
});

test("every chart is a focusable image carrying its own name", async () => {
  const mod = await loadCostRender();
  const rows = [
    { name: "cost over time", component: "CostTrendBody", props: { state: TREND_WITH_GAP, days: 30, bandOn: false } },
    { name: "token volume, area", component: "TokenStackedBody", props: { state: TREND_WITH_GAP, days: 30 } },
    { name: "token volume, columns", component: "TokenStackedBody", props: { state: TREND_WITH_GAP, days: 7 } },
    { name: "cache hit rate", component: "CacheHitBody", props: { state: ready({ rows: CACHE_ROWS }), days: 30 } },
    {
      name: "log integrity", component: "ParseErrorBody",
      props: { state: ready({ rows: [{ event_date: "2026-01-09", error_count: 3, total_count: 40, error_ratio: 0.075 }] }), days: 30 },
    },
    {
      name: "session cost distribution", component: "SessionHistogramDrawerC",
      props: { bins: [{ label: "$0–0.01", count: 3, isOutlier: false }, { label: "$1–5", count: 2, isOutlier: false }], total: 5 },
    },
  ];
  for (const row of rows) {
    const tree = renderIn(mod, row.component, { onRetry: () => {}, onClose: () => {}, ...row.props });
    const charts = findNodes(tree, isChart);
    const images = findNodes(tree, (n) => n.props.role === "img" && findNodes(n, isChart).length > 0);
    assert.ok(charts.length > 0, `${row.name} draws a chart`);
    assert.equal(images.reduce((sum, n) => sum + findNodes(n, isChart).length, 0), charts.length, `${row.name}: every chart sits in an image`);
    for (const image of images) {
      assert.equal(image.props.tabIndex, 0, `${row.name} is reachable by keyboard`);
      assert.match(String(image.props["aria-label"] ?? ""), /\S/, `${row.name} is named`);
    }
  }
});

test("a no-data day is a gap in both trend charts and in their names, never $0", async () => {
  const mod = await loadCostRender();
  const rows = [
    { name: "cost over time", component: "CostTrendBody", field: "completeCost" },
    { name: "token volume", component: "TokenStackedBody", field: "cache_read_tokens" },
  ];
  for (const row of rows) {
    const tree = renderIn(mod, row.component, { state: TREND_WITH_GAP, days: 30, bandOn: false, onRetry: () => {} });
    const [chart] = findNodes(tree, isChart);
    const gapDay = (chart.props.data as ReadonlyArray<Record<string, unknown>>)[1];
    assert.strictEqual(gapDay[row.field], null, `${row.name} draws the gap day as a gap`);
    const [image] = findNodes(tree, (n) => n.props.role === "img" && findNodes(n, isChart).length > 0);
    const label = String(image.props["aria-label"]);
    assert.match(label, /1 of 6 days no data/, `${row.name} names its gap`);
    assert.doesNotMatch(label, /\$0(\.0+)?(?![.\d])/, `${row.name} never names a $0 day`);
  }
});

test("the pace figure is stated once on the page", async () => {
  const state = ready({ ...getKpiAtRatio(1, 1.5), points: (TREND_WITH_GAP.data as { points: unknown[] }).points, rows: [] });
  const mod = await loadCostRender({ INITIAL_REGION_STATE: state });
  const text = collectText(renderIn(mod, "ScreenCost", { onNav: () => {} }));
  assert.equal(text.match(/\bpace\b|heading past/gi)?.length ?? 0, 1, text);
});

test("the token legend is printed once", async () => {
  const state = ready({ ...getKpiAtRatio(1, 1), points: (TREND_WITH_GAP.data as { points: unknown[] }).points, rows: [] });
  const mod = await loadCostRender({ INITIAL_REGION_STATE: state });
  const tree = renderIn(mod, "ScreenCost", { onNav: () => {} });
  const [volume] = findNodes(tree, (n) => n.props.atom === "Disclosure" && n.props.title === "Token volume");
  const swatches = findNodes(volume, (n) => String(n.props.className ?? "").includes("rounded-sm") && n.props.style !== undefined);
  const colors = swatches.map((n) => String((n.props.style as { background?: string }).background));
  assert.ok(colors.length > 0);
  assert.equal(new Set(colors).size, colors.length, `each category colour once: ${colors.join(", ")}`);
});

test("the trend card names its band in plain words and keeps its live echo off screen", async () => {
  const mod = await loadCostRender();
  const tree = renderIn(mod, "CostTrendCard", { state: TREND_WITH_GAP, days: 30, onRetry: () => {} });
  const [head] = findNodes(tree, (n) => n.props.atom === "CardHead");
  const toggle = renderScreen(head.props.right) as RenderedNode;
  assert.doesNotMatch(collectText(toggle) + String(toggle.props.title ?? ""), /σ/);
  const echoes = findNodes(tree, (n) => n.props["aria-live"] === "polite");
  assert.ok(echoes.length > 0);
  for (const echo of echoes) assert.match(String(echo.props.className), /\bsr-only\b/);
});

test("a flat hit-rate strip collapses to one line instead of an empty chart", async () => {
  const mod = await loadCostRender();
  const flat = CACHE_ROWS.map((r) => ({ ...r, cache_hit_rate: 1 }));
  const tree = renderIn(mod, "CacheHitBody", { state: ready({ rows: flat }), days: 30, onRetry: () => {} });
  assert.equal(findNodes(tree, isChart).length, 0);
  assert.match(collectText(tree), /100\.0%.*every day/);
});

// --- Cost & usage: every figure pair agrees or names its difference; the legend lists only drawn series ---

describe("the cost trend y-axis steps in round amounts", () => {
  const rows = [
    { name: "a $2,750 peak (the old $550-step case)", max: 2750 },
    { name: "a sub-dollar window", max: 0.37 },
    { name: "a two-digit peak", max: 87 },
    { name: "a five-digit peak", max: 12_345 },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const ticks = cost.getUsdTicksC(row.max);
      const step = ticks[1] - ticks[0];
      const mantissa = Number((step / 10 ** Math.floor(Math.log10(step))).toFixed(6));
      assert.strictEqual(ticks[0], 0, "the axis starts at zero");
      assert.ok([1, 2, 5].includes(mantissa), `step ${step} is 1, 2 or 5 times a power of ten`);
      assert.ok(ticks.at(-1)! >= row.max, "the top tick covers the peak");
      assert.ok(ticks.length <= 7, `${ticks.length} ticks stay readable`);
      ticks.forEach((t, i) => assert.ok(Math.abs(t - i * step) < 1e-9, "every tick is a multiple of one step"));
    });
  }
});

test("a hit-rate series that reads as one figure at the shown precision is flat, one that reads as two is not", () => {
  const toRows = (values: (number | null)[]) => values.map((rate_pct) => ({ rate_pct }));
  assert.strictEqual(cost.getFlatCacheRate(toRows([99.97, 100, null, 99.99])), 100, "every day reads 100.0%");
  assert.strictEqual(cost.getFlatCacheRate(toRows([99.5, 100])), null, "99.5% and 100.0% are two figures");
});

test("the cache tile says the list-price total matches the recorded total when both read the same, and names the gap when not", () => {
  const match = cost.getCacheTotalNoteC({ listTotal: 29_267.2, recordedTotal: 29_267.4, days: 30 });
  assert.doesNotMatch(match, /not the recorded total/);
  assert.match(match, /matches the recorded total/);
  const differ = cost.getCacheTotalNoteC({ listTotal: 120, recordedTotal: 100, days: 30 });
  assert.match(differ, /\$120/);
  assert.match(differ, /\$100 recorded/);
});

test("the cost trend legend names the no-data days on screen, not only in the chart label", async () => {
  const mod = (await loadScreenModule(COST_SRC, { UI: getAtomUi(), React: createReactStub() })) as RenderModule;
  const gapped = collectText(renderIn(mod, "CostTrendLegendC", { bandOn: false, rows: [{ actual: 3 }, { actual: null }, { actual: 4 }] }));
  assert.match(gapped, /1 of 3 days no data/);
  const whole = collectText(renderIn(mod, "CostTrendLegendC", { bandOn: false, rows: [{ actual: 3 }, { actual: 4 }] }));
  assert.doesNotMatch(whole, /no data/);
});

test("the log integrity legend lists the over-threshold swatch only when such a day is drawn", async () => {
  const mod = (await loadScreenModule(COST_SRC, { UI: getAtomUi(), React: createReactStub() })) as RenderModule;
  assert.doesNotMatch(collectText(renderIn(mod, "ParseErrorLegendC", { hasCritDay: false })), /Day over threshold/);
  assert.match(collectText(renderIn(mod, "ParseErrorLegendC", { hasCritDay: true })), /Day over threshold/);
});

describe("the card pairs share one edge", () => {
  const LG_SPLIT = /lg:grid-cols-\[minmax\(0,(\d+)fr\)_minmax\(0,(\d+)fr\)\]/;

  test("every pair stretches as peers, and the one lg override names the same split as its ratio", async () => {
    const mod = await loadCostRender();
    const rows = findNodes(renderIn(mod, "ScreenCost", { onNav: () => {} }), (n) => n.props.atom === "SplitRow");
    assert.equal(rows.length, 2, "the decision pair and the instrumentation pair");
    assert.deepEqual(rows.map((row) => row.props.layout), ["equal", "equal"]);
    const overrides = rows.flatMap((row) => {
      const split = String(row.props.className ?? "").match(LG_SPLIT);
      return split ? [{ ratio: row.props.ratio, lg: `${split[1]}:${split[2]}` }] : [];
    });
    assert.deepEqual(overrides, [{ ratio: "2:1", lg: "2:1" }]);
  });
});

describe("the decision lists keep to their slot's row budget and roll the rest into the card foot", () => {
  const getCard = async (name: string, data: unknown): Promise<RenderedNode> => {
    const mod = (await loadScreenModule(COST_SRC, {
      UI: getAtomUi(), React: createReactStub(), Recharts: RECHARTS_STUB,
      getTokenRate: () => ({ input: 1, output: 1, cache_read: 1, cache_creation: 1 }),
    })) as RenderModule;
    const tree = renderIn(mod, name, { state: ready(data), days: 30, onRetry: () => {}, onNav: () => {} });
    const [card] = findNodes(tree, (n) => n.props.atom === "Card");
    assert.ok(card, `${name} renders the shared Card`);
    return card;
  };
  const slots = cost.window.UI.CARD_SLOTS;
  // the ledger card also carries the share bar, Total row and footnote → sessions take the larger slot
  const modelBudget = slots.M.rowCount;
  const sessionBudget = slots.L.rowCount;
  const getPopulations = (budget: number) => [
    { name: "a population inside the budget", count: budget },
    { name: "one past the budget", count: budget + 1 },
    { name: "far past the budget", count: budget + 12 },
  ];

  for (const { name, count } of getPopulations(modelBudget)) {
    const budget = modelBudget;
    test(`models — ${name}`, async () => {
      const rows = Array.from({ length: count }, (_, i) => ({
        model: `model-${i}`, cost_usd: 100 - i, session_count: 2,
        input_tokens: 10, output_tokens: 10, cache_read_tokens: 10, cache_creation_tokens: 10,
      }));
      const card = await getCard("ModelCostCard", { rows });
      assert.equal(card.props.size, "M");
      const shown = findNodes(card, (n) => n.type === "button" && n.props["aria-expanded"] !== undefined).length;
      const hidden = count - shown;
      assert.equal(shown, Math.min(count, budget), "rows shown never pass the budget");
      assert.equal(Boolean(card.props.foot), hidden > 0, "the card carries a foot exactly when rows are rolled up");
      const foot = card.props.foot ? collectText(renderScreen(card.props.foot)) : "";
      assert.equal(foot.includes(`Other · ${hidden} more model`), hidden > 0, foot || "no foot");
      assert.equal(foot.includes(`Show all ${count}`), hidden > 0, foot || "no foot");
    });
  }

  for (const { name, state } of [
    { name: "a loading", state: loading },
    { name: "a failed", state: failed },
    { name: "an empty", state: ready({ rows: [] }) },
  ]) {
    test(`models — ${name} ledger carries no foot`, async () => {
      const mod = await loadCostRender();
      const [card] = findNodes(renderIn(mod, "ModelCostCard", { state, days: 30, onRetry: () => {}, onNav: () => {} }), (n) => n.props.atom === "Card");
      assert.ok(card, "ModelCostCard renders the shared Card");
      assert.equal(Boolean(card.props.foot), false, "no foot strip without a rolled-up row");
    });
  }

  for (const { name, count } of getPopulations(sessionBudget)) {
    const budget = sessionBudget;
    test(`sessions — ${name}`, async () => {
      const rows = Array.from({ length: count }, (_, i) => ({ session_id: `session-${i}`, total_cost_usd: 50 - i }));
      const card = await getCard("SessionDistributionCard", { rows, total_session_count: count, truncated: false });
      assert.equal(card.props.size, "L");
      const shown = findNodes(card, (n) => n.type === "tr" && /^Session /.test(String(n.props["aria-label"] ?? ""))).length;
      const hidden = count - shown;
      assert.equal(shown, Math.min(count, budget), "rows shown never pass the budget");
      assert.equal(findNodes(card, (n) => /^Other /.test(String(n.props["aria-label"] ?? ""))).length, 0, "Other is no table row");
      assert.equal(Boolean(card.props.foot), hidden > 0, "the card carries a foot exactly when rows are rolled up");
      const foot = card.props.foot ? collectText(renderScreen(card.props.foot)) : "";
      assert.equal(foot.includes(`Other · ${hidden} of ${count} sessions`), hidden > 0, foot || "no foot");
    });
  }
});
