// Unit pins for the PURE derivations behind the cost screen's decision tier (screens/cost.jsx):
// alarm-lane triggers, the tile-1 hot verdict, the window-total delta rule, the session Other-row
// rollup. Each pins a relationship the composition rests on, not a sampled pair.
//
// Runner: npx tsx --test test/cost.client.unit.test.ts
// Sandbox harness (esbuild + node:vm over the real shipped cost.jsx): client-sandbox.ts.

import test from "node:test";
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
  deltaSpan: number;
  dayCount: number;
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
  getSharedFailureC: (
    namedStates: ReadonlyArray<readonly [string, PanelState]>,
  ) => { sources: string[]; error: string } | null;
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
  getCacheGapLabel: (rows: readonly { rate_pct: number | null }[]) => string | null;
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
  assert.strictEqual(total.dayCount, 4);
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
    { name: "the 7d request failed over the held 90d payload", state: { status: "ready", data: {}, error: "boom", busy: false, key: "/api/dashboard/cost-timeseries?days=90", pendingKey: null }, requested: 7, shown: 90 },
    { name: "nothing landed yet", state: { status: "loading", data: null, error: null, busy: true, key: null, pendingKey: "/api/cost/by-model?days=7" }, requested: 7, shown: 7 },
  ];
  for (const row of rows) {
    assert.strictEqual(cost.getShownDays(row.state, row.requested), row.shown, row.name);
  }
});

test("the trend delta states direction, which the total alone cannot", () => {
  const rising = cost.computeWindowTotal(getTrendPoints([1, 2, 3, 4]));
  const falling = cost.computeWindowTotal(getTrendPoints([4, 3, 2, 1]));

  // Both windows total 10: the delta is the only figure that separates them.
  assert.strictEqual(rising.total, falling.total);
  assert.ok(rising.delta !== null && rising.delta > 0, "a rising window reads up");
  assert.ok(falling.delta !== null && falling.delta < 0, "a falling window reads down");
  assert.strictEqual(
    cost.computeWindowTotal(getTrendPoints([5])).delta,
    null,
    "one day has no first-to-last pair, so there is no change to state",
  );
  assert.strictEqual(cost.computeWindowTotal(getTrendPoints([2, 2, 2])).delta, 0);
});

test("the trend compares the recent half of the complete days with the equal span before it", () => {
  for (const firstDay of [0, 10, 1000]) {
    const flat = cost.computeWindowTotal(getTrendPoints([firstDay, 1, 1, 1, 1, 9]));
    assert.strictEqual(flat.delta, 0, `a first day of ${firstDay} outside both halves never moves it`);
    assert.strictEqual(flat.deltaSpan, 2);
  }
  const doubled = cost.computeWindowTotal(getTrendPoints([7, 1, 1, 2, 2, 9]));
  assert.strictEqual(doubled.delta, 100, "the recent two days spent twice the two before");
  assert.strictEqual(cost.computeWindowTotal(getTrendPoints([5])).deltaSpan, 0);
});

test("the trend reads complete days only — today's partial point never moves it", () => {
  for (const today of [0, 0.1, 4, 100]) {
    assert.strictEqual(cost.computeWindowTotal(getTrendPoints([4, 4, 4, today])).delta, 0, `today=${today}`);
  }
  assert.strictEqual(
    cost.computeWindowTotal(getTrendPoints([3, 1])).delta,
    null,
    "one complete day plus today has no first-to-last pair",
  );
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

test("an outage shared by two payloads is one banner naming both, and a lone failure stays on its region", () => {
  const named = (kpi: PanelState, trend: PanelState) =>
    [["cost KPIs", kpi], ["cost trend", trend], ["cost by model", ready({})]] as const;

  const shared = cost.getSharedFailureC(named(failed, { ...ready({}), error: failed.error }));
  assert.deepEqual(shared && [...shared.sources], ["cost KPIs", "cost trend"], "a failure over held data still joins the outage");
  assert.strictEqual(cost.getSharedFailureC(named(failed, ready({}))), null, "one failed payload is no page-level outage");
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
    const label = cost.getCacheGapLabel(rates.map((rate_pct) => ({ rate_pct })));
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
      // the 48px axis at 12px mono holds five characters
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
