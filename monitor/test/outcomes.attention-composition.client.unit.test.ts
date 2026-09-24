// Client unit tests for the attention-first composition of public/src/screens/outcomes.jsx —
// the status band, the ledger partition, the by-agent failure rows and the three
// disclosure summary lines that replaced the result cards, the stacked bar and the heatmap.
//
// Harness mirrors outcomes.closed-badge.client.unit.test.ts: ui.jsx evaluates in its own
// vm context (it exports window.UI), then outcomes.jsx evaluates with that real UI injected,
// so the tone thresholds under test are the shared SoT and not a test-local copy.
//
// Runner: npx tsx --test test/outcomes.attention-composition.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(__dirname, "../public/src/ui.jsx");
const OUTCOMES_SRC = resolve(__dirname, "../public/src/screens/outcomes.jsx");

type PayloadStatus = "loading" | "error" | "unavailable" | "ready";
interface PayloadState<T> {
  status: PayloadStatus;
  data?: T;
  error?: string;
}
interface BandTile {
  key: string;
  label: string;
  count: number | null;
  population: number;
  tone: "crit" | "warn" | "ok" | "neutral";
  hint: string;
}
interface LedgerRow {
  id: number;
  result: string;
  review_flag?: boolean;
  closed_at?: string | null;
}
interface ClosureState {
  pendingIds: Set<number>;
  closedOverrides: Map<number, string>;
}
interface AnalyticsData {
  overall: { total: number; reconstructed_total?: number; excluded_poisoned_count?: number };
  byResultCount: Record<string, number>;
}
interface AgentStackEntry {
  agent: string;
  total: number;
  byResult: Record<string, number>;
}
interface OutcomesHelpers {
  buildAttentionParamsO: (days: number | string) => URLSearchParams;
  buildPayloadGroupsO: (states: {
    attentionState: unknown;
    searchState: unknown;
    analyticsState: unknown;
  }) => { key: string; label: string; state: unknown }[];
  buildStatusBandTilesO: (data: unknown, attentionCount: number | null) => BandTile[];
  buildByResultCountMapO: (byResult: unknown) => Record<string, number>;
  StatusBandO: (props: {
    analyticsState: PayloadState<AnalyticsData>;
    attentionState: PayloadState<{ total: number }>;
    windowDays: number;
  }) => RenderNode;
  KpiSkeletonO: unknown;
  PayloadUnavailableO: unknown;
  buildAgentFailureRowsO: (
    agentStack: unknown,
    byAgentTop?: unknown,
  ) => { agent: string; failed: number; blocked: number; openCaveats: number | null; total: number }[];
  buildAnalyticsDataO: (overall: unknown) => { overall: { by_agent_top_10?: unknown }; agentStack: unknown };
  isNeedsYouRowO: (row: LedgerRow, closedAt: string | null) => boolean;
  buildLedgerSectionsO: (
    rows: LedgerRow[],
    closure?: ClosureState,
  ) => { key: string; label: string; rows: LedgerRow[] }[];
  reportingHealthSummaryO: (state: PayloadState<{ alerting?: string[] }>) => string;
  selfReportSummaryO: (state: PayloadState<AnalyticsData>) => string;
  loopEventsSummaryO: (state: PayloadState<{ events?: unknown[] }>) => string;
  getChannelLivenessBadgeO: (state: PayloadState<{ alerting?: string[]; days?: number }>) => { tone: string; text: string };
  AgentFailureBodyO: (props: { state: PayloadState<unknown>; onRetry: () => void; stickyStyle?: unknown }) => RenderNode;
}

interface RenderNode {
  type: unknown;
  props: Record<string, unknown> | null;
  children: unknown[];
}

async function transform(src: string, format: "iife" | "esm"): Promise<string> {
  const built = await esbuild.build({
    entryPoints: [src],
    bundle: false,
    write: false,
    loader: { ".jsx": "jsx" },
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    target: "es2022",
    format,
  });
  return built.outputFiles[0].text;
}

// Element trees stay inspectable — a render branch is asserted by the component it names.
function createElementStub(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): RenderNode {
  return { type, props, children };
}

function getReactStub(): unknown {
  return new Proxy(
    {
      createElement: createElementStub,
      Fragment: "frag",
      useState: () => [undefined, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useCallback: (fn: unknown) => fn,
      useMemo: (fn: () => unknown) => fn(),
    },
    { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => ({})) },
  );
}

async function loadHelpers(): Promise<OutcomesHelpers> {
  const uiWindow: Record<string, unknown> = {};
  const uiCtx: Record<string, unknown> = {
    window: uiWindow,
    React: getReactStub(),
    document: { documentElement: {} },
    Intl,
    console,
  };
  uiCtx.globalThis = uiCtx;
  vm.createContext(uiCtx);
  vm.runInContext(await transform(UI_SRC, "iife"), uiCtx);

  const outCtx: Record<string, unknown> = {
    window: { UI: uiWindow.UI },
    React: getReactStub(),
    document: { documentElement: {} },
    Intl,
    console,
    URLSearchParams,
    fetch: () => Promise.reject(new Error("no network in unit test")),
  };
  outCtx.globalThis = outCtx;
  vm.createContext(outCtx);
  vm.runInContext(await transform(OUTCOMES_SRC, "esm"), outCtx);
  return outCtx as unknown as OutcomesHelpers;
}

const helpers = await loadHelpers();

// Arrays originate in the vm realm; re-materialize into this one before deep-equality
// (cross-realm prototype mismatch otherwise) — same seam as outcomes.client.unit.test.ts.
const sameRealm = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

// LOW_N_MIN = 30 · breakage crit at 5% · open-caveat warn at 10% (ui.jsx tone SoT).
const aboveFloor = (byResultCount: Record<string, number>, reconstructed = 0): AnalyticsData => ({
  overall: { total: 200, reconstructed_total: reconstructed },
  byResultCount,
});
const toneOf = (tiles: BandTile[], key: string): string => tiles.find((t) => t.key === key)!.tone;
const tileOf = (tiles: BandTile[], key: string): BandTile => tiles.find((t) => t.key === key)!;
const flattenNodes = (node: unknown): RenderNode[] => {
  if (Array.isArray(node)) return node.flatMap(flattenNodes);
  if (node === null || typeof node !== "object" || !("type" in node)) return [];
  const el = node as RenderNode;
  return [el, ...el.children.flatMap(flattenNodes)];
};

// --- status band: every tile welds a value to a population, and tone is the shared verdict ---

test("buildStatusBandTilesO: every tile carries a value welded to a population and a tone", () => {
  for (const data of [aboveFloor({ done: 150, fail: 4, blocked: 2 }), aboveFloor({}), null]) {
    const tiles = helpers.buildStatusBandTilesO(data, 3);
    assert.deepStrictEqual(
      sameRealm(tiles.map((t) => t.key)),
      ["attention", "broken", "recorded", "done"],
      "band composition is fixed at four facts",
    );
    for (const tile of tiles) {
      assert.ok(typeof tile.population === "number", `${tile.key} states its population`);
      assert.ok(["crit", "warn", "ok", "neutral"].includes(tile.tone), `${tile.key} carries a canonical tone`);
      assert.ok(tile.hint.length > 0, `${tile.key} states what its population is`);
    }
  }
});

test("buildStatusBandTilesO: a population below the low-N floor claims no risk tone", () => {
  const smallWindow = { overall: { total: 12, reconstructed_total: 0 }, byResultCount: { fail: 6, blocked: 3 } };
  const tiles = helpers.buildStatusBandTilesO(smallWindow, 9);
  // 9/12 and 6+3/12 both clear the shares — only the low-N guard can hold the tone back.
  assert.strictEqual(toneOf(tiles, "attention"), "neutral");
  assert.strictEqual(toneOf(tiles, "broken"), "neutral");
});

test("buildStatusBandTilesO: above the floor, the shared thresholds decide the tone", () => {
  const breached = helpers.buildStatusBandTilesO(aboveFloor({ done: 150, fail: 8, blocked: 4 }), 25);
  assert.strictEqual(toneOf(breached, "broken"), "crit", "12/200 = 6% ≥ the 5% breakage share");
  assert.strictEqual(toneOf(breached, "attention"), "warn", "25/200 = 12.5% ≥ the 10% open-caveat share");

  const steady = helpers.buildStatusBandTilesO(aboveFloor({ done: 190, fail: 2 }), 4);
  assert.strictEqual(toneOf(steady, "broken"), "ok", "2/200 = 1% stays below the breakage share");
  assert.strictEqual(toneOf(steady, "attention"), "ok", "4/200 = 2% stays below the caveat share");
});

test("buildStatusBandTilesO: an unloaded attention payload stays null, never a resolved zero", () => {
  const tiles = helpers.buildStatusBandTilesO(aboveFloor({ done: 190 }), null);
  const attention = tileOf(tiles, "attention");
  assert.strictEqual(attention.count, null, "null is what the em-dash render branch reads");
  assert.notStrictEqual(attention.count, 0);
  assert.strictEqual(attention.tone, "neutral", "an unloaded fact asserts nothing");
});

test("buildStatusBandTilesO: the recorded tile weds writer-emitted records to the whole window", () => {
  const clean = tileOf(helpers.buildStatusBandTilesO(aboveFloor({ done: 190 }), 0), "recorded");
  assert.deepStrictEqual([clean.count, clean.population, clean.tone], [200, 200, "ok"]);

  // 40/200 reconstructed = 20% of the window never reached the recorder as a writer emit.
  const lossy = tileOf(helpers.buildStatusBandTilesO(aboveFloor({ done: 190 }, 40), 0), "recorded");
  assert.deepStrictEqual([lossy.count, lossy.population, lossy.tone], [160, 200, "warn"]);
});

test("buildStatusBandTilesO: the attention tile weds its count to the whole window, not the writer-only subset", () => {
  // The server predicate counts reconstructed rows too, so a writer-only denominator would let the
  // share exceed 100% — 40 of these 200 records never reached the recorder as a writer emit.
  const attention = tileOf(helpers.buildStatusBandTilesO(aboveFloor({ done: 150 }, 40), 200), "attention");
  assert.deepStrictEqual([attention.count, attention.population], [200, 200]);
  assert.ok(attention.count! <= attention.population, "a value is never more than its stated population");
});

test("buildStatusBandTilesO: the attention population keeps the quarantined rows the /search predicate counts", () => {
  // /search never drops poisoned-window rows; the analytics total does — excluded_poisoned_count restores them.
  const data = { overall: { total: 200, reconstructed_total: 0, excluded_poisoned_count: 30 }, byResultCount: {} };
  const attention = tileOf(helpers.buildStatusBandTilesO(data, 230), "attention");
  assert.strictEqual(attention.population, 230);
  assert.ok(attention.count! <= attention.population, "every quarantined attention row stays inside the population");
});

test("status band: done and broken count writer-emitted rows only, never above their writer population", () => {
  // structuredoutput-derived syntheses are result=done yet reconstructed — the raw count would exceed writerTotal.
  const overall = {
    total: 200,
    reconstructed_total: 60,
    excluded_poisoned_count: 0,
    by_result: [
      { result: "done", count: 180, reconstructed_count: 50 },
      { result: "fail", count: 12, reconstructed_count: 6 },
      { result: "blocked", count: 8, reconstructed_count: 4 },
    ],
  };
  const byResultCount = helpers.buildByResultCountMapO(overall.by_result);
  const tiles = helpers.buildStatusBandTilesO({ overall, byResultCount }, 0);
  assert.deepStrictEqual([tileOf(tiles, "done").count, tileOf(tiles, "broken").count], [130, 10]);
  for (const key of ["done", "broken"]) {
    const tile = tileOf(tiles, key);
    assert.strictEqual(tile.population, 140);
    assert.ok(tile.count! <= tile.population, `${key} never exceeds its writer-emitted population`);
  }
});

test("StatusBandO: an analytics failure renders as unavailable, never as the loading skeleton", () => {
  const render = (status: PayloadStatus) => flattenNodes(helpers.StatusBandO({
    analyticsState: { status },
    attentionState: { status: "loading" },
    windowDays: 30,
  }));
  const loading = render("loading");
  assert.ok(loading.some((n) => n.type === helpers.KpiSkeletonO), "loading draws the pulsing skeleton");
  for (const status of ["error", "unavailable"] as PayloadStatus[]) {
    const nodes = render(status);
    assert.ok(!nodes.some((n) => n.type === helpers.KpiSkeletonO), `${status} draws no skeleton`);
    assert.ok(nodes.some((n) => n.type === helpers.PayloadUnavailableO), `${status} says the payload is unavailable`);
    assert.ok(!nodes.some((n) => n.props?.["aria-busy"] === true || n.props?.["aria-busy"] === "true"), `${status} is not busy`);
  }
});

test("buildStatusBandTilesO: the missing-report level honours the same low-N floor as its sibling tiles", () => {
  const smallWindow = { overall: { total: 12, reconstructed_total: 4 }, byResultCount: { done: 8 } };
  assert.strictEqual(
    toneOf(helpers.buildStatusBandTilesO(smallWindow, 0), "recorded"),
    "neutral",
    "4 reconstructed rows in a 12-record window is too small a sample to grade",
  );
});

// --- wiring: the request literal the route parses, and the lane row that covers its failure ---

test("buildAttentionParamsO: emits a needs_attention literal the route's parser accepts", () => {
  // routes/outcomes.ts parseFilters: 'true' applies the filter, 'false'/absent applies none,
  // anything else is a 400 — which lands the tile in error with no banner behind it.
  const routeAccepted = ["true", "false"];
  for (const days of [7, 30, 90]) {
    const params = helpers.buildAttentionParamsO(days);
    assert.ok(routeAccepted.includes(params.get("needs_attention")!), "a value outside the vocabulary is a 400");
    assert.strictEqual(params.get("needs_attention"), "true", "the tile asks for the filtered population");
    assert.strictEqual(params.get("days"), String(days), "the query carries the band's own window");
    assert.strictEqual(params.get("limit"), "1", "only the total is consumed");
  }
});

test("buildPayloadGroupsO: every above-the-fold payload owns a lane row carrying its own state", () => {
  const attentionState = { status: "error", error: "boom" };
  const searchState = { status: "ready" };
  const analyticsState = { status: "loading" };
  const groups = helpers.buildPayloadGroupsO({ attentionState, searchState, analyticsState });

  assert.deepStrictEqual(
    sameRealm(groups.map((g) => g.key)),
    ["attention", "ledger", "analytics"],
    "a read that owns a tile but no lane row fails silently",
  );
  for (const [key, state] of [["attention", attentionState], ["ledger", searchState], ["analytics", analyticsState]] as const) {
    assert.strictEqual(groups.find((g) => g.key === key)!.state, state, `${key} row reads its own payload`);
    assert.ok(groups.find((g) => g.key === key)!.label.length > 0, `${key} row names the payload in words`);
  }
});

// --- by-agent failures: the table exists to name who broke, so silent rows never render ---

test("buildAgentFailureRowsO: keeps only rows with a failure and orders them worst-first", () => {
  const stack: AgentStackEntry[] = [
    { agent: "dev-react", total: 40, byResult: { done: 40 } },
    { agent: "dev-node", total: 30, byResult: { done: 27, fail: 3 } },
    { agent: "qa-code-reviewer", total: 20, byResult: { done: 12, fail: 5, blocked: 3 } },
    { agent: "intel-planner", total: 10, byResult: { done: 9, blocked: 1 } },
  ];
  const rows = sameRealm(helpers.buildAgentFailureRowsO(stack));

  assert.deepStrictEqual(
    rows.map((r) => r.agent),
    ["qa-code-reviewer", "dev-node", "intel-planner"],
    "clean agents drop out; the rest sort by failed+blocked descending",
  );
  for (const row of rows) assert.ok(row.failed + row.blocked > 0, `${row.agent} earns its row`);
});

test("buildAnalyticsDataO → buildAgentFailureRowsO: every failing registry agent gets a row, however low its volume", () => {
  const busy = Array.from({ length: 12 }, (_, i) => ({ agent: `busy-${i}`, result: "done", count: 100 + i }));
  const quiet = [
    { agent: "quiet-fail", result: "done", count: 1 },
    { agent: "quiet-fail", result: "fail", count: 1 },
    { agent: "quiet-blocked", result: "blocked", count: 1 },
  ];
  const data = helpers.buildAnalyticsDataO({ by_agent_result: [...busy, ...quiet], by_agent_top_10: [] });
  const rows = sameRealm(helpers.buildAgentFailureRowsO(data.agentStack, data.overall.by_agent_top_10));

  assert.deepStrictEqual(
    rows.map((r) => r.agent).sort(),
    ["quiet-blocked", "quiet-fail"],
    "a volume cap must not hide a failing agent from a table headed 'non-zero rows'",
  );
});

test("buildAgentFailureRowsO: open caveats are known only for agents the top-10 rollup loaded", () => {
  const stack: AgentStackEntry[] = [
    { agent: "in-rollup-open", total: 10, byResult: { fail: 2 } },
    { agent: "in-rollup-clear", total: 10, byResult: { fail: 1 } },
    { agent: "off-rollup", total: 3, byResult: { blocked: 1 } },
  ];
  const byAgentTop = [
    { agent: "in-rollup-open", count: 10, writer_open_count: 4 },
    { agent: "in-rollup-clear", count: 10, writer_open_count: 0 },
  ];
  const openOf = (top: unknown) =>
    Object.fromEntries(sameRealm(helpers.buildAgentFailureRowsO(stack, top)).map((r) => [r.agent, r.openCaveats]));

  assert.deepStrictEqual(openOf(byAgentTop), { "in-rollup-open": 4, "in-rollup-clear": 0, "off-rollup": null });
  assert.deepStrictEqual(
    openOf(undefined),
    { "in-rollup-open": null, "in-rollup-clear": null, "off-rollup": null },
    "no rollup loaded → no agent reads as a zero",
  );
});

test("buildAgentFailureRowsO: an absent or malformed stack yields no rows", () => {
  for (const input of [null, undefined, "nope", {}, []]) {
    assert.deepStrictEqual(sameRealm(helpers.buildAgentFailureRowsO(input)), [], `${JSON.stringify(input)} → no rows`);
  }
});

// --- ledger partition: Needs you before Routine, every row in exactly one section ---

test("buildLedgerSectionsO: partitions the page — every row lands in exactly one section", () => {
  const rows: LedgerRow[] = [
    { id: 1, result: "done" },
    { id: 2, result: "fail" },
    { id: 3, result: "done_with_concerns", closed_at: null },
    { id: 4, result: "done_with_concerns", closed_at: "2026-08-10T10:00:00.000Z" },
    { id: 5, result: "done", review_flag: true },
    { id: 6, result: "blocked" },
  ];
  const sections = sameRealm(helpers.buildLedgerSectionsO(rows));

  assert.deepStrictEqual(
    sameRealm(sections.map((s) => s.key)),
    ["needs-you", "routine"],
    "the attention section leads the routine one",
  );
  const seen = sameRealm(sections.flatMap((s) => s.rows.map((r) => r.id)).sort((a, b) => a - b));
  assert.deepStrictEqual(seen, [1, 2, 3, 4, 5, 6], "no row is dropped or duplicated");
  assert.deepStrictEqual(sameRealm(sections[0].rows.map((r) => r.id)), [2, 3, 5, 6]);
  assert.deepStrictEqual(sameRealm(sections[1].rows.map((r) => r.id)), [1, 4]);
});

test("isNeedsYouRowO: the predicate is flagged, broken, or an unclosed caveat — nothing else", () => {
  assert.strictEqual(helpers.isNeedsYouRowO({ id: 1, result: "done", review_flag: true }, null), true);
  assert.strictEqual(helpers.isNeedsYouRowO({ id: 2, result: "fail" }, null), true);
  assert.strictEqual(helpers.isNeedsYouRowO({ id: 3, result: "blocked" }, null), true);
  assert.strictEqual(helpers.isNeedsYouRowO({ id: 4, result: "done_with_concerns" }, null), true);
  assert.strictEqual(
    helpers.isNeedsYouRowO({ id: 5, result: "done_with_concerns" }, "2026-08-10T10:00:00.000Z"),
    false,
    "a closed caveat is settled work",
  );
  assert.strictEqual(helpers.isNeedsYouRowO({ id: 6, result: "done" }, null), false);
  assert.strictEqual(helpers.isNeedsYouRowO({ id: 7, result: "needs_context" }, null), false);
});

test("buildLedgerSectionsO: an optimistic closure moves the row to Routine before the refetch", () => {
  const rows: LedgerRow[] = [{ id: 7, result: "done_with_concerns", closed_at: null }];
  const closure: ClosureState = {
    pendingIds: new Set(),
    closedOverrides: new Map([[7, "2026-08-10T10:00:00.000Z"]]),
  };
  assert.deepStrictEqual(sameRealm(helpers.buildLedgerSectionsO(rows)[0].rows.map((r) => r.id)), [7]);

  const sections = sameRealm(helpers.buildLedgerSectionsO(rows, closure));
  assert.deepStrictEqual(sections[0].rows, [], "the attention section empties");
  assert.deepStrictEqual(sameRealm(sections[1].rows.map((r) => r.id)), [7]);
});

// --- disclosure summaries: a closed section answers without opening, and never fakes calm ---

test("disclosure summaries: loading and failure read as distinct tokens, never as 'all clear'", () => {
  const summaries = [helpers.reportingHealthSummaryO, helpers.selfReportSummaryO, helpers.loopEventsSummaryO];
  for (const summarize of summaries) {
    const loading = summarize({ status: "loading" });
    for (const status of ["error", "unavailable"] as const) {
      const failed = summarize({ status });
      assert.notStrictEqual(failed, loading, `${summarize.name}: ${status} is not drawn as loading`);
      assert.match(failed, /unavailable/i, `${summarize.name}: ${status} says the payload is unavailable`);
    }
    assert.match(loading, /loading/i, `${summarize.name}: loading says so`);
  }
});

test("getChannelLivenessBadgeO: only a loaded payload may claim 'All recording' or carry a tone", () => {
  for (const status of ["loading", "error", "unavailable"] as const) {
    const badge = helpers.getChannelLivenessBadgeO({ status });
    assert.strictEqual(badge.tone, "neutral", `${status} carries no live tone`);
    assert.doesNotMatch(badge.text, /all recording/i, `${status} is no all-clear`);
  }
  assert.notStrictEqual(
    helpers.getChannelLivenessBadgeO({ status: "loading" }).text,
    helpers.getChannelLivenessBadgeO({ status: "error" }).text,
    "loading and failure read differently",
  );
  const live = helpers.getChannelLivenessBadgeO({ status: "ready", data: { alerting: [], days: 7 } });
  assert.deepStrictEqual(sameRealm(live), { tone: "ok", text: "All recording · 7d" });
  const silent = helpers.getChannelLivenessBadgeO({ status: "ready", data: { alerting: ["stop"] } });
  assert.deepStrictEqual(sameRealm(silent), { tone: "crit", text: "Silent: stop" });
});

test("AgentFailureBodyO: loading draws the table's own skeleton rows, not a blank body", () => {
  const body = helpers.AgentFailureBodyO({ state: { status: "loading" }, onRetry: () => {} });
  // the body returns its skeleton element — render that one level to read the markup it draws
  const skeleton = typeof body.type === "function" ? (body.type as (p: unknown) => RenderNode)(body.props) : body;
  const nodes = flattenNodes(skeleton);
  const table = nodes.find((n) => n.type === "table");
  assert.ok(table, "the loading body keeps the table shape");
  assert.ok(nodes.some((n) => n.props?.["aria-busy"] === true), "the loading body is marked busy");
  const text = nodes.flatMap((n) => n.children.filter((c) => typeof c === "string")).join(" ");
  assert.match(text, /Failed/, "the column headers render while loading");
  assert.ok(nodes.filter((n) => n.type === "tr").length > 1, "skeleton rows sit under the header");
});

test("reportingHealthSummaryO: a silent channel is named in the closed summary line", () => {
  assert.strictEqual(
    helpers.reportingHealthSummaryO({ status: "ready", data: { alerting: ["subagent_stop", "stop"] } }),
    "Silent: subagent_stop, stop",
  );
  assert.strictEqual(helpers.reportingHealthSummaryO({ status: "ready", data: { alerting: [] } }), "All channels recording");
  assert.strictEqual(helpers.reportingHealthSummaryO({ status: "ready", data: {} }), "All channels recording");
});

test("selfReportSummaryO / loopEventsSummaryO: the summary counts what the section holds", () => {
  assert.strictEqual(
    helpers.selfReportSummaryO({ status: "ready", data: aboveFloor({ done: 190 }, 40) }),
    "160 writer-emitted records",
  );
  assert.strictEqual(helpers.loopEventsSummaryO({ status: "ready", data: { events: [{}, {}, {}] } }), "3 recent cycle events");
  assert.strictEqual(helpers.loopEventsSummaryO({ status: "ready", data: {} }), "0 recent cycle events");
});
