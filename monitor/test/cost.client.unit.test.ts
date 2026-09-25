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

const __dirname = dirname(fileURLToPath(import.meta.url));
const COST_SRC = resolve(__dirname, "../public/src/screens/cost.jsx");

type PanelStatus = "loading" | "error" | "empty" | "unavailable" | "ready";

interface PanelState {
  status: string;
  data: unknown;
  error: string | null;
  busy?: boolean;
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

interface CostHelpers {
  window: {
    getTokenRate?: (model: string) => Record<string, number> | null;
    UI: {
      INITIAL_REGION_STATE: PanelState;
      getFreshnessState: (input: {
        at: string | null;
        regions: ReadonlyArray<PanelState>;
        now: number;
      }) => string;
    };
  };
  computeAlarmRows: (input: {
    hot: HotVerdict;
    latestOutsideBand: boolean;
    parseError: { crit: number; total: number };
  }) => AlarmRow[];
  computeHotVerdict: (kpi: Record<string, unknown>) => HotVerdict;
  computeWindowTotal: (state: PanelState) => WindowTotal;
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
  getSessionModelLabel: (model: string | null | undefined) => string;
  getStopReasonSessionShare: (sessionCount: number, population: number) => number | null;
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

test("a session's model label names the model, and an unattributed model never reads as a model name", () => {
  assert.equal(cost.getSessionModelLabel("claude-opus-4-1"), "claude-opus-4-1");
  for (const model of [null, undefined, "", "unknown", "<synthetic>"]) {
    assert.equal(cost.getSessionModelLabel(model), "Unattributed", `model ${String(model)}`);
  }
});

test("a stop reason's session share is taken over the whole session population, never over the column sum", () => {
  // Two reasons each hit by 6 of 10 sessions: the column sums to 12, yet each share stays 0.6.
  assert.equal(cost.getStopReasonSessionShare(6, 10), 0.6);
  assert.equal(cost.getStopReasonSessionShare(10, 10), 1);
  assert.equal(cost.getStopReasonSessionShare(0, 0), null, "an empty population has no share");
});
