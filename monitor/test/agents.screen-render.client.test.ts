// Element-tree behaviour tests for the Agents screen, closing the plan's standing
// decision that screen behaviour is proved against a render harness. Exercises the
// shipped JSX through test/lib/render-screen.ts — no DOM, no react-dom, no DB.
//
// Runner: npx tsx --test test/agents.screen-render.client.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import {
  collectText,
  createReactStub,
  findNodes,
  loadScreenModule,
  renderScreen,
  type RenderedNode,
} from "./lib/render-screen.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_SRC = resolve(__dirname, "../public/src/screens/agents.jsx");

// window.UI stub — every atom resolves to a transparent host element so the tree
// stays inspectable; the few non-component members carry their real shapes.
const UI_SCALARS: Record<string, unknown> = {
  LOW_N_MIN: 5,
  // a per-tone name → a test can tell which tone a glyph was drawn for
  TONE_ICON: new Proxy({}, { get: (_, tone) => `tone-glyph-${String(tone)}` }),
  resolveBadge: () => ({ label: "badge", tone: "warn" }),
  formatPctWithDenominator: (pct: number) => `${pct}%`,
  formatKstFull: (iso: string) => iso,
  // Same rule as ui.jsx outcomeShareTone — the share at or above the step takes the tone.
  outcomeShareTone: (count: number, population: number, minShare: number, tone: string) =>
    population > 0 && count / population >= minShare ? tone : null,
  OUTCOME_BREAKAGE_CRIT_SHARE: 0.05,
};

// Region-state members come from the shipped ui.jsx so the page is exercised against the real contract.
const REAL_UI = (await loadScreenModule(resolve(__dirname, "../public/src/ui.jsx"))).UI as Record<string, unknown>;
const REGION_MEMBERS = ["INITIAL_REGION_STATE", "getRegionView", "hasRegionRows", "getRegionSummary", "getSharedFailure", "getSourceFailures", "putRegionRequest", "putRegionData", "putRegionFailure", "getRowFocusProps", "ROW_CONTROL_PROPS"];
for (const name of REGION_MEMBERS) UI_SCALARS[name] = REAL_UI[name];
// Count text rides the shipped formatter, so a KPI sub reads as it does on the page.
UI_SCALARS.formatInt = REAL_UI.formatInt;
UI_SCALARS.formatPct = REAL_UI.formatPct;
UI_SCALARS.formatDecimal = REAL_UI.formatDecimal;
// Tables ride the shipped Table and cell atoms → head cells and body rows render as on the page.
for (const name of ["Table", "TableRow", "TableCell"]) UI_SCALARS[name] = REAL_UI[name];
// The status band rides the shipped stat row → labels, values and context lines render as on the page.
UI_SCALARS.StatRow = REAL_UI.StatRow;
// Health marks and lists name agents with the shipped helper.
UI_SCALARS.getAgentDisplayName = REAL_UI.getAgentDisplayName;
// Recharts charts take their image name and edge tick from the shipped chart helpers.
UI_SCALARS.getChartImageProps = REAL_UI.getChartImageProps;
UI_SCALARS.ChartAxisTick = REAL_UI.ChartAxisTick;
UI_SCALARS.getChartXAxisProps = REAL_UI.getChartXAxisProps;
// Paired cards cap their lists with the shipped slot budget.
UI_SCALARS.CARD_SLOTS = REAL_UI.CARD_SLOTS;
UI_SCALARS.getSlotRows = REAL_UI.getSlotRows;
// RegionFailure's contract (ui.jsx): covered when the banner names its `source` or another region speaks for it, else the error card with its own Retry.
UI_SCALARS.RegionFailure = Object.defineProperty(
  (props: Record<string, unknown>) => {
    const failures = props.failures as { banner: { sources: unknown[] } | null; speakers: Map<unknown, unknown> } | undefined;
    const banner = failures ? failures.banner : (props.shared as { sources?: unknown[] } | null | undefined);
    const speaker = failures?.speakers.get(props.source);
    const isCovered = Boolean(banner?.sources?.includes(props.source)) || (speaker != null && speaker !== (props.region ?? props.source));
    const atom = isCovered ? "RegionCovered" : "RegionUnavailable";
    return { __element: true, type: "ui-atom", props: { ...props, atom } };
  },
  "name",
  { value: "RegionFailure" },
);

function uiStub(overrides: Record<string, unknown> = {}): unknown {
  const scalars = { ...UI_SCALARS, ...overrides };
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name in scalars
          ? scalars[name]
          : Object.defineProperty(
              (props: Record<string, unknown>) => ({
                __element: true,
                type: "ui-atom",
                props: { ...props, atom: name },
              }),
              "name",
              { value: name },
            ),
      has: () => true,
    },
  );
}

async function loadAgentsScreen(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  // Recharts rides the same transparent-atom stub — the matrix sparkline only needs its components to exist.
  return loadScreenModule(AGENTS_SRC, { UI: uiStub(overrides), Recharts: uiStub(), React: createReactStub() });
}

type Component = (props: unknown) => unknown;

test("the harness expands a function component and surfaces a throw rather than swallowing it", () => {
  const React = createReactStub() as {
    createElement: (type: unknown, props: unknown, ...kids: unknown[]) => unknown;
  };
  const Leaf = () => React.createElement("span", null, "leaf");
  const Parent = () => React.createElement(Leaf, null);

  const tree = renderScreen(React.createElement(Parent, null));
  assert.equal(collectText(tree), "leaf");
  assert.equal(findNodes(tree, (n) => n.type === "span").length, 1);

  const Boom = () => {
    throw new ReferenceError("MISSING is not defined");
  };
  assert.throws(() => renderScreen(React.createElement(Boom, null)), /MISSING is not defined/);
});

test("the drawer's latency row renders its bars for every paired percentile it is given", async () => {
  const mod = await loadAgentsScreen();
  const AgentLatencyRow = mod.AgentLatencyRow as Component;
  assert.equal(typeof AgentLatencyRow, "function", "the unwrapped module exposes its top-level components");
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };

  for (const latency of [
    { agent_id: "glass-atrium-dev-react", agent_name: "dev-react", p50_ms: 1000, p95_ms: 9000, p99_ms: 21000 },
    { agent_id: "solo", agent_name: "solo", p50_ms: 10, p95_ms: 10, p99_ms: 10 },
  ]) {
    const tree = renderScreen(
      React.createElement(AgentLatencyRow, { latency, state: { status: "ready", data: { rows: [] } }, onRetry: () => undefined }),
    );
    const bars = findNodes(
      tree,
      (n: RenderedNode) => typeof n.props["aria-label"] === "string" && String(n.props["aria-label"]).includes("p95"),
    );
    assert.equal(bars.length, 1, "one labelled bar per latency row");
    assert.equal(bars[0].children.length, 3, "one absolute layer per percentile");
    const legend = collectText(tree);
    for (const label of ["P50", "P95", "P99"]) {
      assert.ok(legend.includes(label), `legend keeps ${label}`);
    }
  }
});

const LEDGER_AGENTS = ["dev-react", "dev-shell", "dev-db"].map((name) => ({
  agent_id: `glass-atrium-${name}`, agent_name: name, status: "active", success_pct: 92, runs: 40, needs_context_count: 2,
}));

function renderLedger(mod: Record<string, unknown>, onSelect: (id: string) => void = () => {}): RenderedNode | string | null {
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  return renderScreen(
    React.createElement(mod.AgentSummaryTable as Component, {
      agents: LEDGER_AGENTS, pseudoAgents: [], days: 30, selectedAgent: null, onSelect,
      trendByAgent: null, failureByAgent: null, overageByAgent: null, failureStatus: "ready", trendStatus: "ready",
    }),
  );
}

function getRovingRows(tree: RenderedNode | string | null): RenderedNode[] {
  return findNodes(tree, (n) => n.type === "tr" && "data-roving-row" in n.props);
}

// DOM stand-in for the row a keydown bubbles through: one in-row control, no sibling rows.
function pressRowKey(row: RenderedNode, key: string, from: "row" | "control"): boolean {
  const control = { control: true };
  const currentTarget = { querySelectorAll: () => [control], parentElement: { querySelectorAll: () => [] } };
  let prevented = false;
  (row.props.onKeyDown as (e: unknown) => void)({
    key, target: from === "row" ? currentTarget : control, currentTarget, preventDefault: () => { prevented = true; },
  });
  return prevented;
}

test("the ledger is one Tab stop", async () => {
  const tree = renderLedger(await loadAgentsScreen());
  const rows = getRovingRows(tree);

  assert.deepEqual(rows.map((r) => r.props.tabIndex), [0, -1, -1]);
  assert.ok(rows.every((r) => r.props.role === undefined), "rows keep table-row semantics");
});

test("Enter on a ledger row opens its drawer", async () => {
  const selected: string[] = [];
  const [row] = getRovingRows(renderLedger(await loadAgentsScreen(), (id) => selected.push(id)));

  assert.equal(pressRowKey(row, "Enter", "row"), true);
  assert.deepEqual(selected, ["glass-atrium-dev-react"]);
});

test("the ledger grows with the page instead of a nested vertical scroller that clips its last rows", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const tree = renderScreen(
    React.createElement(mod.AgentSummaryCard as Component, {
      state: { status: "ready", data: { agents: LEDGER_AGENTS, meta: { total_agents: 3 } } },
      days: 30, sortBy: "name", onSortChange: () => {}, selectedAgent: null, onSelect: () => {}, onRetry: () => {},
      trendByAgent: null, failureByAgent: null, overageByAgent: null, failureStatus: "ready", trendStatus: "ready",
    }),
  );
  const classOf = (n: RenderedNode) => String(n.props.className ?? "");

  const [region] = findNodes(tree, (n) => n.props.id === "agents-summary");
  assert.match(classOf(region), /\bmin-w-0\b/, "a wide ledger cannot widen the page grid");
  const [card] = findAtoms(region, "Card");
  assert.equal(card.props.isFlush, true, "the ledger sits flush in the shared card");
  // the Card lifts its body cap; the sticky e2e measures that the ledger then scrolls with the page
  assert.match(classOf(card), /\[&>\.card-body\]:max-h-none/, "no card-body height cap on the ledger");
  // a child-targeted overflow-y-visible is the cap lift itself, not a scroll box
  assert.deepEqual(findNodes(tree, (n) => /(^|\s)overflow-|:overflow-(?!y-visible)/.test(classOf(n))).map(classOf), [], "no screen scroll box around the ledger");
  assert.equal(findNodes(tree, (n) => /\btbl-wrap\b/.test(classOf(n))).length, 1, "the Table wrapper holds the ledger");
});

test("the lifecycle table is one Tab stop and Enter on a row opens that agent", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const selected: string[] = [];
  const tree = renderScreen(
    React.createElement(mod.LifecycleStatsTable as Component, {
      rows: ["dev-react", "dev-shell"].map((agent_type) => ({ agent_type, start_count: 4, stop_count: 4, completed_count: 3, p95_duration_sec: 60 })),
      onSelect: (id: string) => selected.push(id),
    }),
  );
  const rows = getRovingRows(tree);

  assert.deepEqual(rows.map((r) => r.props.tabIndex), [0, -1]);
  assert.ok(rows.every((r) => r.props.role === undefined));
  pressRowKey(rows[1], "Enter", "row");
  assert.deepEqual(selected, ["dev-shell"]);
});

test("the failing-pairs denominator counts judged agent x task_type pairs, not the daily rows they came from", async () => {
  const mod = await loadAgentsScreen();
  const buildTopNFailing = mod.buildTopNFailing as (
    rows: unknown[],
    limit: number,
  ) => { failingPairs: unknown[]; measuredPairs: number };

  const row = (agent: string, task: string, date: string, ok: number, fail: number) => ({
    agent, task_type: task, event_date: date,
    total_count: ok + fail, success_count: ok, failure_count: fail, reconstructed_count: 0,
  });
  // One pair split across three days must measure the same as the identical pair on one day.
  const split = [row("a", "feature", "2026-09-01", 2, 4), row("a", "feature", "2026-09-02", 2, 4), row("a", "feature", "2026-09-03", 2, 4)];
  const single = [row("a", "feature", "2026-09-01", 6, 12)];

  const splitOut = buildTopNFailing(split, 5);
  const singleOut = buildTopNFailing(single, 5);
  assert.equal(splitOut.measuredPairs, singleOut.measuredPairs);
  assert.equal(splitOut.measuredPairs, 1);
  assert.equal(splitOut.failingPairs.length, 1);

  // A second pair adds exactly one to the denominator, whatever its row count.
  const two = [...split, row("b", "review", "2026-09-01", 30, 0)];
  assert.equal(buildTopNFailing(two, 5).measuredPairs, 2);
  assert.equal(buildTopNFailing([], 5).measuredPairs, 0);
});

// Circuit-breaker state split — loading, error, unavailable and a loaded zero are
// four different answers, so no two of them may render alike.
const BREAKER_LOADED_ZERO = { source: "loaded", registry_agents: 3, suspended_count: 0, streak_count: 0, alarms: [] };
const BREAKER_UNAVAILABLE = { ...BREAKER_LOADED_ZERO, source: "unavailable" };
const LOADING_STATE = { status: "loading", data: null, error: null };
const ERROR_STATE = { status: "error", data: null, error: "HTTP 500" };

function getSummaryState(breaker: unknown, agents: unknown[] = []): unknown {
  return { status: "ready", data: { agents, meta: { circuit_breaker: breaker } }, error: null };
}

// a stat's count text — a loading mark, a badge or an error card in the value slot is no count
function getValueTexts(tree: RenderedNode | string | null): string[] {
  return findNodes(tree, (n) => n.type === "dd" && /(^|\s)stat-value(\s|$)/.test(String(n.props.className ?? "")))
    .map((n) => collectText(n).match(/\d[\d,.]*%?/)?.[0]).filter((text): text is string => Boolean(text));
}

// the tone a stat's glyph carries; a calm stat draws none
function getStatTone(tree: RenderedNode | string | null): string | null {
  const glyph = findNodes(tree, (n) => n.props["aria-hidden"] === "true" && /(^|\s)text-(crit|warn)(\s|$)/.test(String(n.props.className ?? "")))[0];
  return String(glyph?.props.className ?? "").match(/text-(crit|warn)/)?.[1] ?? null;
}

function getBadgeTexts(tree: RenderedNode | string | null): string[] {
  return findNodes(tree, (n) => n.props.atom === "Badge").map((n) => collectText(n));
}

function getUnavailableSources(tree: RenderedNode | string | null): string[] {
  return findNodes(tree, (n) => n.props.atom === "RegionUnavailable").map((n) => String(n.props.source));
}

function isBusy(tree: RenderedNode | string | null): boolean {
  return findNodes(tree, (n) => n.props["aria-busy"] === "true").length > 0;
}

async function renderComponent(name: string, props: Record<string, unknown>): Promise<RenderedNode | string | null> {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  return renderScreen(React.createElement(mod[name] as Component, props));
}

// The band renders the tile list the page builds once, so a test builds it the same way.
async function renderStatusBand({ onRetry, failures, ...sources }: Record<string, unknown>): Promise<RenderedNode | string | null> {
  const mod = await loadAgentsScreen();
  const buildTiles = mod.buildAgentStatusTiles as (s: Record<string, unknown>) => unknown[];
  return renderComponent("AgentStatusBand", { tiles: buildTiles(sources), failures, onRetry });
}

test("the alarm lane renders loading, error, unavailable and a loaded zero distinctly", async () => {
  const onRetry = () => undefined;
  const loading = await renderComponent("AgentAlarmLane", { state: LOADING_STATE, onRetry });
  const failed = await renderComponent("AgentAlarmLane", { state: ERROR_STATE, onRetry });
  const unavailable = await renderComponent("AgentAlarmLane", { state: getSummaryState(BREAKER_UNAVAILABLE), onRetry });
  const loadedZero = await renderComponent("AgentAlarmLane", { state: getSummaryState(BREAKER_LOADED_ZERO), onRetry });

  assert.ok(isBusy(loading));
  assert.deepEqual(getBadgeTexts(loading), []);
  assert.deepEqual(getUnavailableSources(failed), ["agent summary"], "the failure names the read that failed");
  assert.deepEqual(getBadgeTexts(failed), []);
  assert.deepEqual(getBadgeTexts(unavailable), ["unavailable"]);
  assert.equal(collectText(loadedZero), "", "a clear fleet renders no alarm lane");
});

test("a Retry on a cold failure keeps the error card busy and hands focus to a card that outlives recovery", async () => {
  const putRegionRequest = REAL_UI.putRegionRequest as (state: unknown, key: string, request: unknown) => Record<string, unknown>;
  const retrying = putRegionRequest(ERROR_STATE, "k", new AbortController());
  const ready = { status: "ready", data: [], error: null };
  const lane = await renderComponent("AgentAlarmLane", { state: retrying, onRetry: () => undefined });
  const band = await renderStatusBand({
    summaryState: retrying, failureState: ready, overageState: ready,
    failureByAgent: new Map(), overageByAgent: new Map(), onRetry: () => undefined,
  });

  const [laneCard] = findAtoms(lane, "RegionUnavailable");
  assert.equal(laneCard?.props.isBusy, true, "the lane keeps its error card, marked busy, while the Retry runs");
  assert.equal(laneCard?.props.focusTargetId, "agents-status", "an emptied lane hands focus to the status band");
  assert.equal(findNodes(band, (n) => n.props.id === "agents-status").length, 1, "the band carries the lane's focus target");

  const tileCards = findAtoms(band, "RegionUnavailable");
  assert.ok(tileCards.length > 0, "the summary-backed tiles keep their error cards through the Retry");
  for (const card of tileCards) {
    assert.equal(card.props.isBusy, true);
    assert.equal(card.props.focusTargetId, "agents-status", "a stat's error card hands focus to the band card, which outlives recovery");
  }
});

test("the unsafe-to-route tile shows a count only when the breaker state actually loaded", async () => {
  const ready = { status: "ready", data: [], error: null };
  const bandProps = {
    failureState: ready,
    overageState: ready,
    failureByAgent: new Map(),
    overageByAgent: new Map(),
    onRetry: () => undefined,
  };
  const getUnsafeTile = async (summaryState: unknown) => {
    const tree = await renderStatusBand({ ...bandProps, summaryState });
    // Pre-order → the first div holding only this tile's text is the tile's own card.
    return findNodes(tree, (n) => n.type === "div" && collectText(n).startsWith("Unsafe to route")
      && !collectText(n).includes("Failed"))[0] ?? null;
  };

  const loadedZero = await getUnsafeTile(getSummaryState(BREAKER_LOADED_ZERO));
  assert.deepEqual(getValueTexts(loadedZero), ["0"], "the count reads as the stat value");
  assert.deepEqual(getBadgeTexts(loadedZero), [], "the count is not a micro-sized pill");
  assert.match(collectText(loadedZero), /of 3 registered agents/);

  const unavailable = await getUnsafeTile(getSummaryState(BREAKER_UNAVAILABLE));
  assert.deepEqual(getBadgeTexts(unavailable), ["unavailable"]);
  assert.deepEqual(getValueTexts(unavailable), []);

  const loading = await getUnsafeTile(LOADING_STATE);
  assert.ok(isBusy(loading));
  assert.deepEqual(getBadgeTexts(loading), []);
  assert.deepEqual(getValueTexts(loading), []);

  const failed = await getUnsafeTile(ERROR_STATE);
  assert.deepEqual(getUnavailableSources(failed), ["agent summary"], "the tile names the read that failed");
  assert.deepEqual(getBadgeTexts(failed), []);
});

test("the drawer's breaker line keeps loading and error apart from an unavailable state", async () => {
  const agent = { agent_id: "dev-react", circuit_breaker: { suspended: false, consecutive_fails: 0, suspended_at: null } };
  const unloadedAgent = { agent_id: "dev-react", circuit_breaker: null };

  const loading = await renderComponent("AgentCircuitBreakerLine", { agent: null, summaryState: LOADING_STATE });
  assert.ok(isBusy(loading));
  assert.deepEqual(getBadgeTexts(loading), []);

  const failed = await renderComponent("AgentCircuitBreakerLine", { agent: null, summaryState: ERROR_STATE });
  assert.deepEqual(getBadgeTexts(failed), []);
  assert.doesNotMatch(collectText(failed), /unavailable/);

  const unavailable = await renderComponent("AgentCircuitBreakerLine", {
    agent: unloadedAgent,
    summaryState: getSummaryState(BREAKER_UNAVAILABLE, [unloadedAgent]),
  });
  assert.deepEqual(getBadgeTexts(unavailable), ["unavailable"]);

  const loadedZero = await renderComponent("AgentCircuitBreakerLine", {
    agent,
    summaryState: getSummaryState(BREAKER_LOADED_ZERO, [agent]),
  });
  assert.deepEqual(getBadgeTexts(loadedZero), ["safe to route"]);
});

test("every in-screen hash link resolves to a hash-router screen id", async () => {
  const { readFile } = await import("node:fs/promises");
  const screenSource = await readFile(AGENTS_SRC, "utf8");
  const app = await loadScreenModule(resolve(__dirname, "../public/src/app.jsx"), {
    ReactDOM: { createRoot: () => ({ render: () => {} }) },
    document: { getElementById: () => null },
  });
  // vm read is untyped; the "improvement" check below fails on a missing or reshaped NAV
  const navIds = new Set((vm.runInContext("NAV", app) as Array<{ id: string }>).map(({ id }) => id));
  const hashTargets = Array.from(screenSource.matchAll(/href="#([^"]*)"/g), (m) => m[1]);

  assert.ok(navIds.has("improvement"), "the NAV block parsed");
  assert.ok(hashTargets.length > 0, "the screen carries at least one hash link");
  for (const target of hashTargets) {
    assert.ok(navIds.has(target), `href="#${target}" names no NAV screen id`);
  }
});

function renderSummaryRow(mod: Record<string, unknown>, overage: unknown): RenderedNode | string | null {
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  return renderScreen(
    React.createElement(mod.AgentSummaryRow as Component, {
      agent: { agent_id: "glass-atrium-dev-react", agent_name: "dev-react", status: "active", success_pct: 92, runs: 40, needs_context_count: 2, p95_ms: 120_000 },
      days: 30,
      isSelected: false,
      onSelect: () => {},
      trend: null,
      failure: null,
      overage,
    }),
  );
}

test("a budget crossing rides the P95 fill-bar instead of a pill that contradicts the fast-tier glyph", async () => {
  const mod = await loadAgentsScreen();
  const crossed = renderSummaryRow(mod, { overage_count: 3, max_crossed_pct: 112 });
  const clean = renderSummaryRow(mod, null);

  const badgesIn = (tree: RenderedNode | string | null) => findNodes(tree, (n) => n.props?.atom === "Badge");
  assert.equal(badgesIn(crossed).length, 0, "no near-cap pill sits beside the P95 glyph");

  const p95BarLabel = (tree: RenderedNode | string | null) =>
    String(findNodes(tree, (n) => n.props?.atom === "Bar" && String(n.props.ariaLabel).startsWith("p95"))[0]?.props.ariaLabel);
  assert.match(p95BarLabel(crossed), /3 tool_use-budget crossings.*peak 112%/);
  assert.doesNotMatch(p95BarLabel(clean), /crossing/, "an uncrossed row's bar claims no crossing");
});

test("the ledger and instrumentation card adopt the shared labels", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };

  const table = renderScreen(
    React.createElement(mod.AgentSummaryTable as Component, { agents: [], pseudoAgents: [], days: 30, selectedAgent: null, onSelect: () => {} }),
  );
  const headers = findColumnHeads(table).map((n) => collectText(n).trim());
  assert.ok(headers.includes("Failed or blocked"), `ledger headers: ${headers.join(" | ")}`);
  assert.ok(!headers.includes("Breakages"));

  const card = renderScreen(
    React.createElement(mod.LifecycleStatsCard as Component, { state: { status: "loading" }, days: 30, onSelect: () => {}, onRetry: () => {} }),
  );
  const [lifecycleCard] = findAtoms(card, "Card");
  assert.equal(lifecycleCard?.props.title, "No completion record");
});

const HIGH_FAIL_WORD = "high failure share";

test("the summary row marks the shared crit step from its own failed share, and only on an adequate sample", async () => {
  const toneVarColor = REAL_UI.toneVarColor as (tone: string) => string;
  const mod = await loadAgentsScreen({ toneVarColor });
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  // failed share = 1 − passed/denominator, denominator = runs − needs_context.
  const cases = [
    { success_pct: 95, runs: 42, needs_context_count: 2, crit: true, why: "2 of 40 failed sits on the 5% step" },
    { success_pct: 98, runs: 50, needs_context_count: 0, crit: false, why: "1 of 50 failed stays under the step" },
    { success_pct: 50, runs: 4, needs_context_count: 0, crit: false, why: "n below LOW_N_MIN carries no tone" },
  ];
  for (const c of cases) {
    const tree = renderScreen(
      React.createElement(mod.AgentSummaryRow as Component, {
        agent: { agent_id: "glass-atrium-dev-react", agent_name: "dev-react", status: "active", ...c },
        days: 30, isSelected: false, onSelect: () => {}, trend: [3, 5, 2], trendStatus: "ready", failure: null, overage: null,
      }),
    );
    assert.equal(collectText(tree).includes(HIGH_FAIL_WORD), c.crit, c.why);
    const toned = findNodes(tree, (n) => /\btext-(ok|warn)\b/.test(String(n.props?.className ?? "")));
    assert.equal(toned.length, 0, `${c.why}: the success numeral carries no second scale`);
    const [trendBars] = findAtoms(tree, "MiniBars");
    assert.equal(trendBars?.props.color, toneVarColor(c.crit ? "crit" : "neutral"), `${c.why}: the trend bars carry no band of their own`);
  }
});

test("a matrix cell takes the crit step from failures over its rate denominator, reconstructed rows excluded", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const cases = [
    { successCount: 19, failureCount: 1, reconstructed: 10, crit: true, why: "1 of 20 judged hits the step; 10 reconstructed do not dilute it" },
    { successCount: 39, failureCount: 1, reconstructed: 0, crit: false, why: "1 of 40 stays under the step" },
    { successCount: 2, failureCount: 1, reconstructed: 0, crit: false, why: "n below LOW_N_MIN carries no tone" },
  ];
  for (const c of cases) {
    const rateDenominator = c.successCount + c.failureCount;
    const cell = { ...c, rateDenominator, totalCount: rateDenominator + c.reconstructed, pooledRate: c.successCount / rateDenominator, points: [] };
    const tree = renderScreen(React.createElement(mod.SuccessRateCell as Component, { agent: "a", taskType: "feature", cell }));
    assert.equal(collectText(tree).includes(HIGH_FAIL_WORD), c.crit, c.why);
    const [cellNode] = findNodes(tree, (n) => n.type === "td");
    const style = (cellNode?.props.style as Record<string, unknown> | undefined) ?? {};
    assert.deepEqual([style.background, style.outline], [undefined, undefined], `${c.why}: the tone rides the glyph, never a cell fill or outline`);
  }
});

describe("the drawer hero's success figure carries no tone at any rate, which rides its fail-share glyph alone", () => {
  // rates straddle 90 and 95, where a second rate scale would key on them
  const rows = [
    { name: "98%, 1 of 50 failed: under the crit step, no glyph", success_pct: 98, crit: false },
    { name: "92%, 4 of 50 failed: over the crit step, glyph", success_pct: 92, crit: true },
    { name: "80%, 10 of 50 failed: over the crit step, glyph", success_pct: 80, crit: true },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const agent = { agent_id: "glass-atrium-dev-react", agent_name: "dev-react", status: "active", runs: 50, needs_context_count: 0, success_pct: row.success_pct };
      const emptyRows = { status: "ready", data: { rows: [] }, error: null };
      const tree = await renderComponent("AgentOverviewSection", {
        agent, drawerAgent: agent.agent_id, summaryState: { status: "ready", data: { agents: [agent] }, error: null },
        revisionState: emptyRows, reviewByAgentState: emptyRows, onRetry: () => undefined,
      });
      const figures = findNodes(tree, (n) => /\bhero-stat\b/.test(String(n.props?.className ?? "")));
      assert.equal(figures.length, 1, "one hero figure");
      assert.doesNotMatch(String(figures[0].props.className), /\btext-(ok|warn|crit|info)\b/);
      assert.equal(collectText(figures[0]).includes(HIGH_FAIL_WORD), row.crit);
    });
  }
});

test("the Agents ledger shows no initial avatar, which reads G for every glass-atrium agent", async () => {
  const mod = await loadAgentsScreen();
  const tree = renderSummaryRow(mod, null);
  assert.equal(findNodes(tree, (n) => n.props?.atom === "AgentBadge").length, 0);
});

test("a failing pair drills to Task results filtered by its agent, task type and window", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const pair = { agent: "glass-atrium-dev-react", task_type: "feature", successCount: 1, rateDenominator: 5, pooledRate: 0.2, totalCount: 5 };
  const tree = renderScreen(
    React.createElement(mod.TopNFailingAgentsTable as Component, { pairs: [pair], failureByAgent: new Map(), days: 14 }),
  );
  const hrefs = findNodes(tree, (n) => n.type === "a").map((n) => String(n.props.href));
  assert.deepEqual(hrefs, ["#outcomes?agent=glass-atrium-dev-react&task_type=feature&days=14"]);
});

test("an empty cell in an agents table reads None in faint ink, never a dash or a blank", async () => {
  const mod = await loadAgentsScreen({ formatInt: REAL_UI.formatInt });
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const pair = { agent: "glass-atrium-dev-react", task_type: "feature", successCount: 1, rateDenominator: 5, pooledRate: 0.2, totalCount: 5 };
  const lifecycle = { agent_type: "glass-atrium-dev-react", start_count: 10, stop_count: 9, completed_count: 9, p95_duration_sec: null };
  const rows = [
    { name: "ledger row with no launches, breakages, p95 or trend", noneCount: 4, render: () => renderToneRow(mod, { invocations: null, p95_ms: null }, null) },
    { name: "failing pair with no breakage time", noneCount: 1, render: () => renderScreen(
      React.createElement(mod.TopNFailingAgentsTable as Component, { pairs: [pair], failureByAgent: new Map(), days: 14 })) },
    { name: "lifecycle row with no p95", noneCount: 1, render: () => renderScreen(
      React.createElement(mod.LifecycleStatsRow as Component, { row: lifecycle, onSelect: null })) },
  ];
  const isFaint = (n: RenderedNode) => /\btext-faint\b/.test(String(n.props?.className ?? ""));
  for (const row of rows) {
    // the name cell's text comes from the stubbed AgentName atom → judged by the atom, not its text
    const cells = findNodes(row.render(), (n) => n.type === "td" && findAtoms(n, "AgentName").length === 0);
    const texts = cells.map((n) => getVisibleText(n).trim());
    assert.deepEqual(texts.filter((t) => t === "" || t === "—"), [], `${row.name}: no blank or dash cell in ${texts.join(" | ")}`);
    const noneCells = cells.filter((_, i) => texts[i] === "None");
    assert.equal(noneCells.length, row.noneCount, `${row.name}: None cells in ${texts.join(" | ")}`);
    noneCells.forEach((cell) => assert.ok(isFaint(cell) || findNodes(cell, isFaint).length > 0, `${row.name}: None is faint`));
  }
});

test("the status band is one card holding one stat row, a stat per fleet question", async () => {
  const ready = { status: "ready", data: [], error: null };
  const tree = await renderStatusBand({
    summaryState: getSummaryState(BREAKER_LOADED_ZERO), failureState: ready, overageState: ready,
    failureByAgent: new Map(), overageByAgent: new Map(), onRetry: () => undefined,
  });
  const hasClass = (name: string) => (n: RenderedNode) => new RegExp(`(^|\\s)${name}(\\s|$)`).test(String(n.props.className ?? ""));
  assert.equal(findAtoms(tree, "Card").length, 1, "one card, no card per stat");
  const [band] = findNodes(tree, (n) => n.props.id === "agents-status");
  assert.equal(findAtoms(band, "Card").length, 1, "the card sits inside the band's focus target");
  const statRows = findNodes(tree, hasClass("stat-row"));
  assert.equal(statRows.length, 1);
  // each label's own span — the ⓘ beside it carries the counting rule, not the label
  assert.deepEqual(findNodes(statRows[0], (n) => n.type === "dt").map((n) => collectText(findNodes(n, (c) => c.type === "span")[0]).trim()),
    ["Unsafe to route", "Failed", "Over tool-use cap", "Needs info"]);
});

test("every status-band tile names the window its count covers", async () => {
  const ready = { status: "ready", data: [], error: null };
  const tree = await renderStatusBand({
    days: 14,
    summaryState: getSummaryState(BREAKER_LOADED_ZERO),
    failureState: ready,
    overageState: ready,
    failureByAgent: new Map(),
    overageByAgent: new Map(),
    onRetry: () => undefined,
  });
  const labels = ["Unsafe to route", "Failed", "Over tool-use cap", "Needs info"];
  const tiles = labels.map((label) => findNodes(tree, (n) => n.type === "div" && collectText(n).startsWith(label))
    .filter((n) => labels.every((other) => other === label || !collectText(n).includes(other)))[0]);
  assert.match(collectText(tiles[0]), /\bnow\b/, "breaker state is current, not windowed");
  for (const tile of tiles.slice(1)) {
    assert.match(collectText(tile), /last 14d/);
  }
});

test("the ledger opens sorted by breakages, riskiest agents first", async () => {
  // every region reads this one payload: the summary its agents in run order, the breakage map its rows
  const data = {
    agents: [
      { agent_id: "glass-atrium-dev-busy", agent_name: "busy", status: "active", runs: 90 },
      { agent_id: "glass-atrium-dev-risky", agent_name: "risky", status: "active", runs: 10 },
    ],
    meta: { total_agents: 2 },
    rows: [{ agent: "glass-atrium-dev-risky", total_breakages: 7, fail_count: 7, blocked_count: 0 }],
  };
  const tree = await renderScreenAgents({ status: "ready", data, error: null, busy: false });
  const order = findNodes(tree, (n) => n.type === "AgentSummaryRow").map((n) => (n.props.agent as { agent_id: string }).agent_id);
  assert.deepEqual(order, ["glass-atrium-dev-risky", "glass-atrium-dev-busy"], "the agent with breakages leads the busier one");
  const sorted = readSortHeads(tree).filter(([, sort]) => sort !== "none" && sort != null);
  assert.deepEqual(sorted, [["Failed", "descending", "arrow-down"]], "the Failed or blocked head shows the breakage sort it opens on");
});

const NOT_LOADED_WORD = "not loaded";

function renderLoadRow(mod: Record<string, unknown>, failureStatus: string, trendStatus: string): RenderedNode | string | null {
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  return renderScreen(
    React.createElement(mod.AgentSummaryRow as Component, {
      agent: { agent_id: "glass-atrium-dev-react", agent_name: "dev-react", status: "active", success_pct: 92, runs: 40, needs_context_count: 2, p95_ms: 120_000 },
      days: 30, isSelected: false, onSelect: () => {}, trend: null, failure: null, overage: null,
      failureStatus, trendStatus,
    }),
  );
}

test("an unread breakage or trend payload shows 'not loaded', and only a loaded zero reads None", async () => {
  const mod = await loadAgentsScreen();
  const rows = [
    { name: "both loading", failureStatus: "loading", trendStatus: "loading", notLoaded: 2 },
    { name: "both failed", failureStatus: "error", trendStatus: "error", notLoaded: 2 },
    { name: "breakages read, trend loading", failureStatus: "ready", trendStatus: "loading", notLoaded: 1 },
    { name: "both read with no data", failureStatus: "ready", trendStatus: "ready", notLoaded: 0 },
  ];
  for (const row of rows) {
    const tree = renderLoadRow(mod, row.failureStatus, row.trendStatus);
    const marks = findNodes(tree, (n) => n.type === "span" && collectText(n) === NOT_LOADED_WORD);
    assert.equal(marks.length, row.notLoaded, `${row.name}: not-loaded marks`);
    const failCell = findNodes(tree, (n) => n.type === "td" && String(n.props?.title ?? "").length > 0)
      .find((n) => /breakage/.test(String(n.props.title)));
    const failText = collectText(failCell ?? null);
    assert.equal(failText === "None", row.failureStatus === "ready", `${row.name}: None means a read zero only`);
  }
});

function renderSortedCard(mod: Record<string, unknown>, failureStatus: string): RenderedNode | string | null {
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const agents = [
    { agent_id: "glass-atrium-dev-busy", agent_name: "busy", status: "active", runs: 90 },
    { agent_id: "glass-atrium-dev-risky", agent_name: "risky", status: "active", runs: 10 },
  ];
  const failureByAgent = new Map([["glass-atrium-dev-risky", { total_breakages: 7, fail_count: 7, blocked_count: 0, breakage_rate: 0.7 }]]);
  return renderScreen(
    React.createElement(mod.AgentSummaryCard as Component, {
      state: { status: "ready", data: { agents, meta: { total_agents: 2 } }, error: null },
      days: 30, sortBy: "failures", onSortChange: () => {}, selectedAgent: null, onSelect: () => {}, onRetry: () => {},
      trendByAgent: new Map(), failureByAgent, overageByAgent: new Map(), failureStatus, trendStatus: "ready",
      revisionState: LOADING_STATE, reviewByAgentState: LOADING_STATE,
    }),
  );
}

// the card head's right cluster, rendered → the sort control and its note as the head draws them
function renderHeadRight(tree: RenderedNode | string | null): RenderedNode | string | null {
  const [head] = findAtoms(tree, "Card");
  assert.ok(head, "the card draws the shared card head");
  return renderScreen(head.props.right);
}

// rows in rendered order, then the sort note the card head announces
function renderSortedBody(mod: Record<string, unknown>, failureStatus: string): string[] {
  const tree = renderSortedCard(mod, failureStatus);
  const order = findNodes(tree, (n) => n.type === "AgentSummaryRow").map((n) => String((n.props.agent as { agent_id: string }).agent_id));
  const note = findNodes(renderHeadRight(tree), (n) => n.props?.role === "status").map((n) => collectText(n)).join(" ");
  return [...order, `note:${note}`];
}

// each column head as [label start, aria-sort, sort icon] → the heads the ledger sorts from
function readSortHeads(tree: RenderedNode | string | null): Array<[string, unknown, unknown]> {
  return findColumnHeads(tree).map((th) => [
    collectText(th).trim().split(/\s/)[0],
    th.props["aria-sort"],
    findAtoms(th, "Icon")[0]?.props.name,
  ]);
}

test("the ledger sorts from its column heads: the sorted head carries its arrow and aria-sort, every other sortable head the two-way icon", async () => {
  const mod = await loadAgentsScreen();
  const tree = renderSortedCard(mod, "ready");
  assert.deepEqual(readSortHeads(tree), [
    ["Agent", "none", "arrow-up-down"],
    ["Runs", "none", "arrow-up-down"],
    ["No", undefined, undefined],
    ["Success", "none", "arrow-up-down"],
    ["Failed", "descending", "arrow-down"],
    ["P95", "none", "arrow-up-down"],
    ["Trend", undefined, undefined],
  ]);
  assert.equal(findNodes(tree, (n) => n.type === "select").length, 0, "no separate sort select remains");
  assert.equal(findNodes(tree, (n) => n.props?.role === "status").length, 0, "the note lives in the head, not in a band above the rows");
});

test("a sortable head asks for its own key, and the name sort reads ascending", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const asked: string[] = [];
  const tree = renderScreen(React.createElement(mod.AgentSummaryTable as Component, {
    agents: [{ agent_id: "glass-atrium-dev-node", agent_name: "dev-node", status: "active", runs: 12 }],
    pseudoAgents: [], days: 30, sortBy: "name", onSortChange: (key: string) => asked.push(key),
    selectedAgent: null, onSelect: () => {}, failureStatus: "ready", trendStatus: "ready",
  }));
  assert.deepEqual(readSortHeads(tree)[0], ["Agent", "ascending", "arrow-up"]);
  for (const button of findNodes(tree, (n) => n.type === "button" && /tbl-sort/.test(String(n.props.className)))) {
    (button.props.onClick as () => void)();
  }
  assert.deepEqual(asked, ["name", "runs", "success", "failures", "p95"]);
});

test("the card head offers no sort while there is no row to order", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  for (const state of [
    { status: "loading", data: null, error: null },
    { status: "ready", data: { agents: [], meta: { total_agents: 0 } }, error: null },
  ]) {
    const tree = renderScreen(React.createElement(mod.AgentSummaryCard as Component, {
      state, days: 30, sortBy: "failures", onSortChange: () => {}, selectedAgent: null, onSelect: () => {}, onRetry: () => {},
      trendByAgent: null, failureByAgent: null, overageByAgent: null, failureStatus: "ready", trendStatus: "ready",
    }));
    assert.equal(findNodes(tree, (n) => n.type === "th" && n.props["aria-sort"] != null).length, 0, `${state.status}: no sortable head`);
    assert.equal(findNodes(renderHeadRight(tree), (n) => n.props?.role === "status").length, 0, `${state.status}: no sort note`);
  }
});

test("the breakage sort orders by breakages only once they are read, and says so while they are not", async () => {
  const mod = await loadAgentsScreen();
  const [readFirst, , readNote] = renderSortedBody(mod, "ready");
  assert.equal(readFirst, "glass-atrium-dev-risky", "read breakages put the riskiest agent first");
  assert.equal(readNote, "note:", "a read sort carries no caveat");

  for (const status of ["loading", "error"]) {
    const [first, , note] = renderSortedBody(mod, status);
    assert.equal(first, "glass-atrium-dev-busy", `${status}: unread breakages fall back to run order`);
    assert.match(note, /breakages not loaded/i, `${status}: the fallback order is announced`);
    const sorted = readSortHeads(renderSortedCard(mod, status)).filter(([, sort]) => sort !== "none" && sort != null);
    assert.deepEqual(sorted.map(([label]) => label), ["Runs"], `${status}: the Runs head carries the order the rows really have`);
  }
});

// The stub's useState hands back each initial value, so the screen renders with every region in that state.
async function renderScreenAgents(initialRegion?: Record<string, unknown>): Promise<RenderedNode | string | null> {
  const overrides = initialRegion ? { INITIAL_REGION_STATE: initialRegion } : {};
  const mod = await loadAgentsScreen(overrides);
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  return renderScreen(React.createElement(mod.ScreenAgents as Component, {}));
}

function findAtoms(tree: RenderedNode | string | null, atom: string): RenderedNode[] {
  return findNodes(tree, (n) => n.props.atom === atom);
}

// Table renders its column heads through the shipped TableHead → a th scoped to its column.
function findColumnHeads(tree: RenderedNode | string | null): RenderedNode[] {
  return findNodes(tree, (n) => n.type === "th" && n.props.scope === "col");
}

test("the header's Refresh and freshness stamp read every region, so a first load is never announced as fresh", async () => {
  const [header] = findAtoms(await renderScreenAgents(), "PageHeader");
  // The stub header keeps its named slots as props, so render each slot on its own.
  const [refresh] = findAtoms(renderScreen(header.props.refresh), "RefreshButton");
  assert.equal(refresh?.props.isBusy, true, "a region in flight keeps Refresh busy");
  assert.equal(refresh?.props.hasRead, false, "before the first read Refresh says it is loading, not refreshing");
  const [stamp] = findAtoms(renderScreen(header.props.freshness), "FreshnessStamp");
  assert.equal((stamp?.props.regions as unknown[]).length, 9, "the stamp sees all nine page regions");
});

test("an outage every region shares shows one page banner with the only Retry, and every region it covers stays quiet", async () => {
  const initial = REAL_UI.INITIAL_REGION_STATE as Record<string, unknown>;
  const failed = { ...initial, status: "error", busy: false, error: "HTTP 503 Service Unavailable — down" };
  const tree = await renderScreenAgents(failed);
  const banners = findAtoms(tree, "PageErrorBanner");
  assert.equal(banners.length, 1);
  assert.equal(typeof banners[0].props.onRetry, "function");
  assert.deepEqual(findAtoms(tree, "RegionUnavailable").map((n) => n.props.source), [], "no region repeats the error card");
  assert.ok(findAtoms(tree, "RegionCovered").length > 1, "each covered region holds its place with the quiet placeholder");
});

test("a region that fails alone keeps its own Retry and no page banner appears", async () => {
  const tree = await renderComponent("AgentAlarmLane", { state: ERROR_STATE, onRetry: () => undefined });
  assert.deepEqual(findAtoms(tree, "RegionCovered"), []);
  const [region] = findAtoms(tree, "RegionUnavailable");
  assert.equal(typeof region?.props.onRetry, "function");
  assert.deepEqual(findAtoms(tree, "PageErrorBanner"), []);
});

describe("the agents banner reads Retrying only while a failed region is re-read", () => {
  const firstLoad = { status: "loading", data: null, error: null, busy: true };
  const outage = { status: "error", data: null, error: "HTTP 503 Service Unavailable — down", busy: false };
  const rows = [
    { name: "two failed regions beside other regions' first loads are not retrying", regions: [outage, outage], isBusy: false },
    { name: "a failed region being re-read is retrying", regions: [outage, { ...outage, busy: true }], isBusy: true },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      // each region state reads its initial value from this queue, in declaration order; the rest are first loads
      const regionInitial = {};
      const queue = [...row.regions];
      const react = {
        ...createReactStub(),
        useState: (initial: unknown) => [initial === regionInitial ? (queue.shift() ?? firstLoad) : initial, () => undefined],
      };
      const mod = await loadScreenModule(AGENTS_SRC, { UI: uiStub({ INITIAL_REGION_STATE: regionInitial }), Recharts: uiStub(), React: react });
      const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
      const tree = renderScreen(React.createElement(mod.ScreenAgents as Component, {}));
      const [banner] = findAtoms(tree, "PageErrorBanner");
      assert.equal(banner?.props.isBusy, row.isBusy);
    });
  }
});

test("the drawer's health word takes the page verdict's tone for the same agent: a failed run is never Healthy, a blocked run changes nothing", async () => {
  const mod = await loadAgentsScreen();
  const buildTiles = mod.buildAgentStatusTiles as (args: Record<string, unknown>) => Array<{ key: string; tone: string }>;
  const getVerdict = mod.getDrawerHealthVerdictAg as (entry: unknown, hasSignal: boolean, failure: unknown) => { tone: string; label: string };
  const healthyEntry = { agent: "dev-react", healthIndex: 0.95, totalRevisions: 20, dominantDriver: null };
  const rows = [
    { name: "a failed run on a healthy rework index", failure: { fail_count: 2, blocked_count: 0 }, hasSignal: true },
    { name: "a failed run with too few runs to judge rework", failure: { fail_count: 1, blocked_count: 0 }, hasSignal: false },
    { name: "a blocked run only", failure: { fail_count: 0, blocked_count: 3 }, hasSignal: true },
  ];
  for (const row of rows) {
    const tiles = buildTiles({
      days: 30, summaryState: LOADING_STATE, overageState: LOADING_STATE, overageByAgent: new Map(),
      failureState: { status: "ready", data: { rows: [] }, error: null }, failureByAgent: new Map([["dev-react", row.failure]]),
    });
    const isListed = tiles.find((tile) => tile.key === "failed")?.tone === "crit";
    const verdict = getVerdict(healthyEntry, row.hasSignal, row.failure);
    assert.equal(verdict.tone === "crit", isListed, `${row.name}: drawer tone follows the Failed tile`);
    assert.equal(verdict.label === "Healthy", !isListed && row.hasSignal, `${row.name}: health word`);
  }
});

test("a matrix cell draws its sparkline only in wide mode and, stacked, reads as one fact behind its task-type label", async () => {
  const cell = { totalCount: 40, pooledRate: 0.5, rateDenominator: 40, successCount: 20, failureCount: 20, reconstructed: 0, points: [] };
  const rows = [
    { name: "wide", view: { isStacked: false, columnCount: 10 }, hasSpark: true, hasLabel: false },
    { name: "stacked", view: { isStacked: true, columnCount: 10 }, hasSpark: false, hasLabel: true },
  ];
  for (const row of rows) {
    const tree = await renderComponent("SuccessRateCell", { view: row.view, agent: "dev-react", taskType: "feature", cell });
    const sparks = findNodes(tree, (n) => n.type === "SuccessRateSparkline" || n.props?.role === "img");
    const labels = findNodes(tree, (n) => /\btbl-cell-label\b/.test(String(n.props?.className ?? "")));
    assert.equal(sparks.length > 0, row.hasSpark, `${row.name}: sparkline`);
    assert.equal(labels.length > 0 && collectText(labels[0]).includes("feature"), row.hasLabel, `${row.name}: task-type label prefix`);
    assert.match(collectText(tree), /50\s*%/, `${row.name}: rate shown`);
  }
});

test("a crosstab cell stacks its rate over its sample, each an unbroken line, so a column is as wide as its longest line", async () => {
  const rows = [
    { name: "settled sample", cell: { totalCount: 40, pooledRate: 0.5, rateDenominator: 40, successCount: 20, reconstructed: 0, points: [] } },
    { name: "low sample", cell: { totalCount: 3, pooledRate: 0.5, rateDenominator: 2, successCount: 1, reconstructed: 0, points: [] } },
  ];
  for (const row of rows) {
    const tree = await renderComponent("SuccessRateCell", { agent: "dev-react", taskType: "feature", cell: row.cell });
    const lines = findNodes(tree, (n) => /\bwhitespace-nowrap\b/.test(String(n.props?.className ?? "")));
    const rateLine = lines.find((n) => /50\s*%/.test(collectText(n)));
    const sampleLine = lines.find((n) => collectText(n).includes(`n=${row.cell.rateDenominator}`)
      || findAtoms(n, "LowSampleMark").some((mark) => mark.props.n === row.cell.rateDenominator));
    assert.ok(rateLine && sampleLine, `${row.name}: rate and sample each sit on a nowrap line`);
    assert.notEqual(rateLine, sampleLine, `${row.name}: the sample is its own line, not appended to the rate`);
  }
});

test("No record and Unfinished each name the other count and say why the two can differ", async () => {
  const mod = await loadAgentsScreen();
  const ledger = renderLedger(mod);
  const lifecycle = await renderComponent("LifecycleStatsTable", { rows: [{ agent_type: "dev-react", start_count: 5, stop_count: 4, completed_count: 3 }], onSelect: () => undefined });
  const getTitle = (tree: RenderedNode | string | null, label: string) =>
    String(findNodes(tree, (n) => n.props?.title != null && collectText(n).trim() === label)[0]?.props.title ?? "");
  const noRecord = getTitle(ledger, "No record");
  const unfinished = getTitle(lifecycle, "Unfinished");
  assert.match(noRecord, /Unfinished/, "the ledger column names the lifecycle count");
  assert.match(unfinished, /No record/, "the lifecycle column names the ledger count");
  for (const title of [noRecord, unfinished]) assert.match(title, /can differ/, title);
});

test("a loading region shows a labelled status placeholder with its height reserved, never an empty box", async () => {
  const tree = await renderComponent("TopNFailingAgentsCard", { state: LOADING_STATE, days: 30, onRetry: () => undefined, failureByAgent: new Map() });
  const [placeholder] = findAtoms(tree, "LoadingPlaceholder");
  assert.ok(placeholder, "the pairs region renders the shared loading placeholder");
  assert.equal(placeholder.props.label, "most-failing pairs", "the placeholder names what is loading");
  assert.ok(Number(placeholder.props.minHeight) > 0, "the settled height is reserved");
});

const TONED_CLASS = /\btext-(warn|crit)\b/;

function renderToneRow(mod: Record<string, unknown>, agent: Record<string, unknown>, failure: unknown): RenderedNode | string | null {
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  return renderScreen(
    React.createElement(mod.AgentSummaryRow as Component, {
      agent: { agent_id: "glass-atrium-dev-react", agent_name: "dev-react", status: "active", success_pct: 92, runs: 40, needs_context_count: 2, p95_ms: 120_000, ...agent },
      days: 30, isSelected: false, onSelect: () => {}, trend: null, failure, overage: null,
      failureStatus: "ready", trendStatus: "ready",
    }),
  );
}

function findCellByTitle(tree: RenderedNode | string | null, pattern: RegExp): RenderedNode | null {
  return findNodes(tree, (n) => n.type === "td" && pattern.test(String(n.props?.title ?? "")))[0] ?? null;
}

// Text a sighted reader sees — sr-only words excluded.
function getVisibleText(node: RenderedNode | string): string {
  if (typeof node === "string") return node;
  if (/\bsr-only\b/.test(String(node.props?.className ?? ""))) return "";
  return node.children.map(getVisibleText).join("");
}

// Toned classes wrapping visible words or figures — a tone may wrap a glyph alone.
function getToneTextClasses(cell: RenderedNode | null): string[] {
  return findNodes(cell, (n) => TONED_CLASS.test(String(n.props?.className ?? "")) && getVisibleText(n).trim() !== "")
    .map((n) => String(n.props.className));
}

test("the breakage count takes a crit glyph only once its share of the agent's outcomes crosses the shared crit step, the numeral staying neutral", async () => {
  const mod = await loadAgentsScreen();
  // breakage_rate = total_breakages / total outcomes, so the population is recoverable from the pair.
  const rows = [
    { name: "one of forty stays under the 5% step", total_breakages: 1, breakage_rate: 0.025, crit: false },
    { name: "two of forty sits on the step", total_breakages: 2, breakage_rate: 0.05, crit: true },
    { name: "two of four is a sample below LOW_N_MIN", total_breakages: 2, breakage_rate: 0.5, crit: false },
  ];
  for (const row of rows) {
    const failure = { total_breakages: row.total_breakages, fail_count: row.total_breakages, blocked_count: 0, breakage_rate: row.breakage_rate };
    const cell = findCellByTitle(renderToneRow(mod, {}, failure), /^breakages/);
    assert.deepEqual(getToneTextClasses(cell), [], `${row.name}: numeral tone`);
    const glyphs = findNodes(cell, (n) => n.type === "FailShareGlyph" && n.props.tone === "crit");
    assert.equal(glyphs.length, row.crit ? 1 : 0, `${row.name}: crit glyph beside the numeral`);
    const bar = findNodes(cell, (n) => n.props?.atom === "Bar")[0];
    assert.equal(bar?.props.tone, row.crit ? "crit" : "neutral", `${row.name}: bar tone follows the glyph`);
  }
});

test("a lifecycle row's orphan figure stays neutral, its warn or crit share carried by a glyph alone", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  // Steps: warn at a 20% orphan share, crit at 35%.
  const rows = [
    { name: "under the warn step", start_count: 10, completed_count: 9, glyph: [] as string[] },
    { name: "on the warn step", start_count: 10, completed_count: 8, glyph: ["warn"] },
    { name: "on the crit step", start_count: 20, completed_count: 13, glyph: ["crit"] },
  ];
  for (const row of rows) {
    const tree = renderScreen(
      React.createElement(mod.LifecycleStatsRow as Component, {
        row: { agent_type: "glass-atrium-dev-react", stop_count: row.completed_count, p95_duration_sec: 60, ...row },
        onSelect: null,
      }),
    );
    const cell = findNodes(tree, (n) => n.type === "td" && /%|^0$/.test(getVisibleText(n).trim()))[0] ?? null;
    assert.ok(cell, `${row.name}: orphan cell renders`);
    assert.deepEqual(getToneTextClasses(cell), [], `${row.name}: the orphan figure takes no tone`);
    const glyphTones = findAtoms(cell, "StatusDot").map((n) => String(n.props.status));
    assert.deepEqual(glyphTones, row.glyph, `${row.name}: the status glyph names the share's tier`);
  }
});

test("the drawer breakage badge takes the same crit step as the ledger numeral", async () => {
  const idle = { status: "idle", data: null, error: null };
  const rows = [
    { name: "one of forty stays under the 5% step", total_breakages: 1, breakage_rate: 0.025, tone: "neutral" },
    { name: "four of forty crosses the step", total_breakages: 4, breakage_rate: 0.1, tone: "crit" },
    { name: "two of four is a sample below LOW_N_MIN", total_breakages: 2, breakage_rate: 0.5, tone: "neutral" },
  ];
  for (const row of rows) {
    const failureByAgent = new Map([["glass-atrium-dev-react", { total_breakages: row.total_breakages, reconstructed: 0, breakage_rate: row.breakage_rate }]]);
    const tree = await renderComponent("AgentReliabilityBreakages", {
      drawerAgent: "glass-atrium-dev-react", failureByAgent, failureState: { status: "ready", data: { rows: [] }, error: null },
      detailState: idle, blockedState: idle, days: 30, onRetry: () => undefined,
    });
    const badge = findNodes(tree, (n) => n.props?.atom === "Badge" && /failed or blocked/.test(collectText(n)))[0];
    assert.equal(badge?.props.tone, row.tone, `${row.name}: drawer badge tone`);
  }
});

test("a P95 numeral stays neutral at every tier, the glyph alone carrying the tier while amber stays off the routine warn tier", async () => {
  const mod = await loadAgentsScreen();
  const rows = [
    { name: "fast tier", p95_ms: 300_000, numeral: [] as string[], glyph: "text-ok" },
    { name: "warn tier, the bulk of live agents", p95_ms: 900_000, numeral: [] as string[], glyph: "text-dim" },
    { name: "crit tier", p95_ms: 1_500_000, numeral: [] as string[], glyph: "text-crit" },
  ];
  for (const row of rows) {
    const cell = findCellByTitle(renderToneRow(mod, { p95_ms: row.p95_ms }, null), /^p95 latency tier/);
    const glyph = findNodes(cell, (n) => n.type === "span" && n.props?.["aria-hidden"] === "true")[0];
    assert.equal(glyph?.props.className, row.glyph, `${row.name}: glyph tier`);
    const numeralTones = findNodes(cell, (n) => n.props?.["aria-hidden"] !== "true" && TONED_CLASS.test(String(n.props?.className ?? "")))
      .map((n) => String(n.props.className));
    assert.deepEqual(numeralTones, row.numeral, `${row.name}: numeral tone`);
  }
});

test("a failing pair keeps its failure glyph at any sample beside a neutral rate, and a small sample carries the shared low-sample mark instead of grey italics", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const rows = [
    { name: "n under LOW_N_MIN", successCount: 1, rateDenominator: 3, isLowSample: true },
    { name: "n at LOW_N_MIN", successCount: 2, rateDenominator: 5, isLowSample: false },
  ];
  for (const row of rows) {
    const pair = { agent: "glass-atrium-dev-react", task_type: "feature", ...row, pooledRate: row.successCount / row.rateDenominator, totalCount: row.rateDenominator };
    const tree = renderScreen(
      React.createElement(mod.TopNFailingAgentsTable as Component, { pairs: [pair], failureByAgent: new Map(), days: 14 }),
    );
    const rateCell = findCellByTitle(tree, /^pooled passed/);
    const style = (rateCell?.props.style as Record<string, unknown> | undefined) ?? {};
    assert.equal(style.color, undefined, `${row.name}: the rate numeral takes no tone`);
    assert.equal(findNodes(rateCell, (n) => n.type === "FailShareGlyph" && n.props.tone === "crit").length, 1, `${row.name}: the failure glyph sits beside the rate`);
    assert.notEqual(style.fontStyle, "italic", `${row.name}: no unexplained italics`);
    const mark = findNodes(rateCell, (n) => n.props?.atom === "LowSampleMark")[0];
    assert.equal(mark?.props.n, row.isLowSample ? row.rateDenominator : undefined, `${row.name}: shared low-sample mark`);
    const bar = findNodes(rateCell, (n) => n.props?.atom === "Bar")[0];
    assert.equal(bar?.props.tone, row.isLowSample ? "neutral" : "crit", `${row.name}: bar tint`);
  }
});

test("the ledger's activity mark names activity under a labelled column, never a health word that contradicts the success rate", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const table = renderScreen(
    React.createElement(mod.AgentSummaryTable as Component, { agents: [], pseudoAgents: [], days: 30, selectedAgent: null, onSelect: () => {} }),
  );
  const headers = findColumnHeads(table).map((n) => collectText(n).trim());
  assert.ok(headers.some((h) => /activity/i.test(h)), `ledger headers: ${headers.join(" | ")}`);

  const rows = [
    { status: "active", word: "Active" },
    { status: "inactive", word: "Inactive" },
    { status: "idle", word: "Idle" },
  ];
  for (const row of rows) {
    const tree = renderToneRow(mod, { status: row.status, last_run_at: "2026-09-25T00:00:00Z" }, null);
    assert.equal(findNodes(tree, (n) => n.props?.atom === "StatusDot").length, 0, `${row.status}: no OK/Warning health dot`);
    const mark = findNodes(tree, (n) => /^Activity: /.test(String(n.props?.title ?? "")))[0];
    assert.match(String(mark?.props.title), new RegExp(`^Activity: ${row.word}`), `${row.status}: mark names activity`);
    assert.doesNotMatch(String(mark?.props.className), /text-(ok|warn)/, `${row.status}: no health tone`);
  }
});

test("the drawer's rework count sums revisions across runs rather than repeating the run count", async () => {
  const revisionRows = [
    { agent: "glass-atrium-dev-react", revision_bucket: "0", occurrence_count: 40 },
    { agent: "glass-atrium-dev-react", revision_bucket: "1", occurrence_count: 5 },
    { agent: "glass-atrium-dev-react", revision_bucket: "2", occurrence_count: 1 },
  ];
  const mod = await loadAgentsScreen({ formatInt: (n: number) => String(n) });
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const tree = renderScreen(
    React.createElement(mod.AgentQualitySignalsSection as Component, {
      drawerAgent: "glass-atrium-dev-react",
      revisionState: { status: "ready", data: { rows: revisionRows }, error: null },
      reviewByAgentState: { status: "ready", data: { rows: [] }, error: null },
      onRetry: () => undefined,
    }),
  );
  const text = collectText(tree);
  assert.match(text, /reworks\s*7 in 46 runs/, text);
});

test("the drawer's average rework and flag share read at most one decimal", async () => {
  const revisionRows = [
    { agent: "glass-atrium-dev-react", revision_bucket: "0", occurrence_count: 40 },
    { agent: "glass-atrium-dev-react", revision_bucket: "1", occurrence_count: 5 },
    { agent: "glass-atrium-dev-react", revision_bucket: "2", occurrence_count: 1 },
  ];
  const mod = await loadAgentsScreen({ formatInt: (n: number) => String(n) });
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const tree = renderScreen(
    React.createElement(mod.AgentQualitySignalsSection as Component, {
      drawerAgent: "glass-atrium-dev-react",
      revisionState: { status: "ready", data: { rows: revisionRows }, error: null },
      reviewByAgentState: { status: "ready", data: { rows: [{ agent: "glass-atrium-dev-react", review_flagged_count: 10, total_count: 40 }] }, error: null },
      onRetry: () => undefined,
    }),
  );
  const text = collectText(tree);
  assert.match(text, /\(avg 0\.2\)/, `7 reworks over 46 runs is 0.152 → one decimal: ${text}`);
  assert.match(text, /25%/, `a 10-of-40 flag share drops the .0: ${text}`);
  assert.doesNotMatch(text, /25\.0%/, text);
});

test("the health verdict pill labels its index instead of trailing a bare number", async () => {
  const tree = await renderComponent("QualityHealthVerdictPill", {
    entry: { healthIndex: 0.9, dominantDriver: { kind: "flag", value: 0.22 } },
    hasSignal: true,
  });
  // The Badge atom stays unexpanded here, so its label is read from the element's own children.
  const getLabel = (v: unknown): string => {
    if (typeof v === "string" || typeof v === "number") return String(v);
    if (Array.isArray(v)) return v.map(getLabel).join("");
    if (!v || typeof v !== "object") return "";
    const node = v as { props?: { children?: unknown }; children?: unknown };
    return getLabel(node.props?.children ?? node.children);
  };
  assert.match(getLabel(tree), /health 90/);
});

test("the matrix legend states which outcomes its n leaves out", async () => {
  const tree = await renderComponent("SuccessRateLegend", {});
  assert.match(collectText(tree), /reconstructed/);
});

test("the matrix legend carries only the crit step and its below-the-step swatch", async () => {
  const tree = await renderComponent("SuccessRateLegend", {});
  const swatches = findNodes(tree, (n) => n.type === "LegendSwatch").map((n) => n.props.colorVar);
  assert.deepEqual(swatches, ["--crit", "--faint"]);
});

test("a compatibility requirement rides a short row tag with the full text on hover, never a truncated sentence", async () => {
  const mod = await loadAgentsScreen();
  const requirement = "Requires monitor running at http://127.0.0.1:16145 with a live daemon";
  const tree = renderToneRow(mod, { compatibility: requirement }, null);
  const badge = findNodes(tree, (n) => n.props?.atom === "Badge")[0];
  assert.equal(badge?.props.title, `Requires: ${requirement}`);
  assert.doesNotMatch(collectText(badge), /…/);
});

const FS_MICRO = /\bfs-micro\b/;

test("the Agents page never sets text in the retired micro type step", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const trees = [
    renderLedger(mod),
    renderLoadRow(mod, "error", "error"),
    renderScreen(React.createElement(mod.AgentDisclosure as Component, { title: "By task type", sub: "Success rate" })),
    await renderStatusBand({
      summaryState: getSummaryState(BREAKER_LOADED_ZERO), failureState: { status: "ready", data: [], error: null }, overageState: { status: "ready", data: [], error: null },
      failureByAgent: new Map(), overageByAgent: new Map(), onRetry: () => undefined,
    }),
  ];
  for (const tree of trees) {
    const micro = findNodes(tree, (n) => FS_MICRO.test(String(n.props?.className ?? "")));
    assert.equal(micro.length, 0, micro.map((n) => collectText(n)).join(" | "));
  }
});

function getMatrixRow(agent: string, success: number, failure: number, taskType = "feature"): Record<string, unknown> {
  const total = success + failure;
  return { agent, task_type: taskType, event_date: "2026-01-01", total_count: total, success_count: success, failure_count: failure, success_rate: success / total };
}

const TASK_TYPE_FOLD_STATES = [
  { name: "a crit pair leaves it closed", state: { status: "ready", data: { rows: [getMatrixRow("a", 19, 1), getMatrixRow("b", 40, 0)] }, error: null } },
  { name: "an unread matrix leaves it closed", state: LOADING_STATE },
];

describe("the By task type fold starts collapsed whatever its pairs, so a failing pair first paints once, in Most-failing pairs", () => {
  for (const row of TASK_TYPE_FOLD_STATES) {
    test(row.name, async () => {
      const tree = await renderComponent("TaskTypeFold", { state: row.state, days: 30, onRetry: () => undefined });
      const [fold] = findAtoms(tree, "Disclosure");
      assert.ok(fold, "the fold is the shared Disclosure");
      assert.equal(fold.props.title, "By task type");
      const getDisclosureOpen = REAL_UI.getDisclosureOpen as (kind: string, tone: unknown) => boolean;
      assert.equal(getDisclosureOpen(String(fold.props.kind ?? "detail"), fold.props.tone), false);
    });
  }
});

const ROW_LIMIT_STATES = [
  { name: "an empty fleet", rows: [] },
  { name: "a measured fleet", rows: [getMatrixRow("a", 19, 1)] },
];

describe("a truncated matrix reports the row limit as a warn glyph and a word with no status container", () => {
  for (const row of ROW_LIMIT_STATES) {
    test(row.name, async () => {
      const tree = await renderComponent("SuccessRateMatrixRegion", { state: { status: "ready", data: { rows: row.rows, truncated: true }, error: null }, days: 30, onRetry: () => undefined });
      assert.deepEqual([...findAtoms(tree, "Pill"), ...findAtoms(tree, "Badge")].map((n) => n.props.atom), [], "no pill or badge container");
      const [note] = findNodes(tree, (n) => /matrix incomplete/.test(String(n.props?.title ?? "")));
      assert.ok(note, "the notice keeps its hover title");
      assert.match(collectText(note), /Row limit hit/);
      assert.doesNotMatch(String(note.props.className), /\btext-warn\b/, "the word stays neutral");
      const glyphs = findNodes(note, (n) => /\btext-warn\b/.test(String(n.props?.className ?? "")));
      assert.equal(glyphs.length, 1, "the tone rides one glyph");
      assert.equal(glyphs[0].props["aria-hidden"], "true");
    });
  }
});

describe("the matrix legend and its counting method sit behind the fold's info button, never on the page", () => {
  for (const row of [{ name: "with the Full matrix closed", isOpen: false }, { name: "with the Full matrix open", isOpen: true }]) {
    test(row.name, async () => {
      // the Full matrix toggle is the only boolean state in this tree → the stub seats it open or closed
      const react = { ...createReactStub(), useState: (initial: unknown) => [initial === false ? row.isOpen : initial, () => undefined] };
      const mod = await loadScreenModule(AGENTS_SRC, { UI: uiStub(), Recharts: uiStub(), React: react });
      const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
      const state = { status: "ready", data: { rows: [getMatrixRow("a", 19, 1)] }, error: null };
      const tree = renderScreen(React.createElement(mod.SuccessRateMatrixBody as Component, { state, days: 30, onRetry: () => undefined }));
      const swatchCount = (root: RenderedNode | string | null) => findNodes(root, (n) => n.type === "LegendSwatch").length;

      const [info] = findAtoms(tree, "CardInfo");
      assert.ok(info, "the fold carries an info button");
      assert.equal(findNodes(tree, (n) => n.type === "SuccessRateMatrixRow").length, row.isOpen ? 1 : 0, "the table mounts only while open");
      assert.equal(swatchCount(info), 2, "the legend rides the info button");
      assert.equal(swatchCount(tree), 2, "no second legend anywhere on the fold");
      assert.equal(collectText(tree).match(/n = passed \+ failed/g)?.length, 1, "the counting method appears once, behind the info button");
    });
  }
});

const OFF_TARGET_ROWS = [
  {
    name: "an agent lists only its pairs at the crit step",
    rows: [getMatrixRow("a", 19, 1), getMatrixRow("a", 40, 0, "plan"), getMatrixRow("b", 40, 0)],
    expected: [{ agent: "a", taskTypes: ["feature"] }],
  },
  {
    name: "a failing pair below the crit step is not off-target",
    rows: [getMatrixRow("a", 39, 1)],
    expected: [],
  },
  {
    name: "a failing small sample under the low-N floor is not off-target",
    rows: [getMatrixRow("a", 2, 1)],
    expected: [],
  },
  {
    name: "an agent's pairs keep the matrix column order",
    rows: [getMatrixRow("a", 19, 1, "review"), getMatrixRow("a", 19, 1, "bug-fix")],
    expected: [{ agent: "a", taskTypes: ["bug-fix", "review"] }],
  },
];

describe("the off-target list holds each agent's pairs at the matrix crit glyph and nothing else", () => {
  for (const row of OFF_TARGET_ROWS) {
    test(row.name, async () => {
      const mod = await loadAgentsScreen();
      const matrix = (mod.buildSuccessRateMatrix as (rows: unknown[]) => unknown)(row.rows);
      const offTarget = (mod.getOffTargetRowsAg as (m: unknown) => Array<{ agent: string; pairs: Array<{ taskType: string }> }>)(matrix);

      // the vm realm's arrays carry its own prototype → compare by value, not by realm
      const actual = JSON.parse(JSON.stringify(offTarget.map((r) => ({ agent: r.agent, taskTypes: r.pairs.map((p) => p.taskType) }))));
      assert.deepEqual(actual, row.expected);
    });
  }
});

test("the task-type body lists the off-target pairs above the full matrix, which stays behind a closed disclosure", async () => {
  const state = { status: "ready", data: { rows: [getMatrixRow("a", 19, 1), getMatrixRow("b", 40, 0)] }, error: null };
  const tree = await renderComponent("SuccessRateMatrixBody", { state, days: 30, onRetry: () => undefined });

  const [list] = findNodes(tree, (n) => n.props["aria-label"] === "Off-target pairs per agent");
  assert.equal(findNodes(list, (n) => n.props["aria-label"] === "a off-target task types").length, 1, "the crit agent gets a row");
  assert.equal(findNodes(list, (n) => n.props["aria-label"] === "b off-target task types").length, 0, "a clear agent gets none");
  const [toggle] = findAtoms(tree, "DisclosureButton");
  assert.equal(toggle.props.isOpen, false, "the full matrix starts collapsed");
  const [panel] = findNodes(tree, (n) => n.props.id === toggle.props.controls);
  assert.equal(panel?.props.hidden, true, "the toggle controls the hidden matrix panel");
  assert.equal(findNodes(tree, (n) => n.type === "SuccessRateMatrixRow").length, 0, "no matrix row mounts while collapsed");
});

test("a fleet with no off-target pair says so instead of an empty list", async () => {
  const state = { status: "ready", data: { rows: [getMatrixRow("b", 40, 0)] }, error: null };
  const tree = await renderComponent("SuccessRateMatrixBody", { state, days: 30, onRetry: () => undefined });

  assert.match(collectText(tree), /No agent × task type pair at failed or blocked ≥ 5%/);
  assert.equal(findNodes(tree, (n) => n.props["aria-label"] === "Off-target pairs per agent").length, 0);
});

test("the matrix region draws no card inside its fold and nothing in it scrolls vertically", async () => {
  const tree = await renderComponent("SuccessRateMatrixRegion", { state: { status: "ready", data: { rows: [getMatrixRow("a", 9, 1)] }, error: null }, days: 30, onRetry: () => undefined });
  const classOf = (n: RenderedNode) => String(n.props.className ?? "");
  const cards = findNodes(tree, (n) => /(^|\s)card(-body|-head)?(\s|$)/.test(classOf(n)));
  assert.deepEqual(cards.map(classOf), [], "the By task type fold is the card — no card in card");
  const verticalScrollers = findNodes(tree, (n) => /\boverflow-(auto|y-auto|hidden)\b/.test(classOf(n)));
  assert.deepEqual(verticalScrollers.map(classOf), [], "nothing inside the matrix scrolls or clips vertically");
});

const OFF_TARGET_BOUNDARY_ROWS = [
  { name: "a pair at exactly the crit step (95.0% success)", success: 19, failure: 1, isMostFailing: true, isCrit: true },
  { name: "a pair well under the crit step", success: 15, failure: 5, isMostFailing: true, isCrit: true },
  { name: "a pair just inside the target", success: 39, failure: 1, isMostFailing: false, isCrit: false },
  { name: "a clear pair", success: 40, failure: 0, isMostFailing: false, isCrit: false },
  { name: "an off-target pair under the low-N floor ranks without the glyph", success: 3, failure: 1, isMostFailing: true, isCrit: false },
];

describe("the matrix crit glyph marks exactly the Most-failing pairs whose sample clears the low-N floor", () => {
  for (const row of OFF_TARGET_BOUNDARY_ROWS) {
    test(row.name, async () => {
      const mod = await loadAgentsScreen();
      const rows = [getMatrixRow("a", row.success, row.failure)];
      const matrix = (mod.buildSuccessRateMatrix as (r: unknown[]) => { cells: Record<string, unknown> })(rows);
      const isCrit = (mod.getCellFailShareTone as (c: unknown) => string | null)(matrix.cells["a|feature"]) === "crit";
      const { failingTotal } = (mod.buildTopNFailing as (r: unknown[], l: number) => { failingTotal: number })(rows, Number.POSITIVE_INFINITY);

      assert.equal(isCrit, row.isCrit, "matrix crit glyph");
      assert.equal(failingTotal === 1, row.isMostFailing, "Most-failing membership");
    });
  }
});

test("the ledger carries Runs and No record as columns instead of a per-row expander", async () => {
  const mod = await loadAgentsScreen({ formatInt: REAL_UI.formatInt });
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const rows = [
    { name: "launches past runs leave that many without a record", invocations: 50, noRecord: "10" },
    { name: "unmeasured launches read None", invocations: null, noRecord: "None" },
    { name: "fewer launches than runs never go negative", invocations: 30, noRecord: "0" },
  ];
  const agents = rows.map((row, i) => ({ ...LEDGER_AGENTS[0], agent_id: `glass-atrium-dev-${i}`, runs: 40, invocations: row.invocations }));
  const tree = renderScreen(
    React.createElement(mod.AgentSummaryTable as Component, {
      agents, pseudoAgents: [], days: 30, selectedAgent: null, onSelect: () => {},
      trendByAgent: null, failureByAgent: null, overageByAgent: null, failureStatus: "ready", trendStatus: "ready",
    }),
  );
  const headers = findColumnHeads(tree).map((n) => collectText(n).trim());
  assert.ok(headers.includes("Runs") && headers.includes("No record"), `ledger headers: ${headers.join(" | ")}`);
  assert.equal(findAtoms(tree, "DisclosureChevron").length, 0, "no per-row expander");
  const cells = findNodes(tree, (n) => n.type === "td" && /^no completion record/.test(String(n.props?.title ?? "")));
  rows.forEach((row, i) => assert.equal(collectText(cells[i]), row.noRecord, row.name));
});

test("a ledger row leads with its failed count and keeps blocked as an untoned secondary", async () => {
  const mod = await loadAgentsScreen({ formatInt: REAL_UI.formatInt });
  // 29 blocked of 100 outcomes: a 30% breakage rate, but a failed share of 1% or none.
  const rows = [
    { name: "one failed run", fail: 1, lead: /^1\b/ },
    { name: "blocked runs only — the failed count still reads as a zero", fail: 0, lead: /^0\b/ },
  ];
  for (const row of rows) {
    const failure = { total_breakages: row.fail + 29, fail_count: row.fail, blocked_count: 29, breakage_rate: 0.3 };
    const cell = findCellByTitle(renderToneRow(mod, {}, failure), /^breakages/);
    const text = collectText(cell).trim();
    assert.match(text, row.lead, `${row.name}: the failed count leads`);
    assert.match(text, /29\s+blocked/, `${row.name}: blocked rides as the secondary`);
    const tonedClasses = findNodes(cell, (n) => TONED_CLASS.test(String(n.props?.className ?? "")));
    assert.equal(tonedClasses.length, 0, `${row.name}: compliant halts do not raise the failure tone`);
  }
});

test("a stat count reads grouped by thousands, as every other count on the page", async () => {
  const rows = [
    { name: "under a thousand stays bare", value: 999, tone: null, text: "999" },
    { name: "a thousand and over groups", value: 1284, tone: null, text: "1,284" },
    { name: "a toned count groups after its screen-reader word", value: 12840, tone: "crit", text: "Needs attention: 12,840" },
  ];
  for (const row of rows) {
    const tree = await renderComponent("StatusStatValueAg", { label: "Failed", status: "ready", value: row.value, tone: row.tone });
    // collectText joins sibling spans with a space → whitespace folded before the compare
    assert.equal(collectText(tree).replace(/\s+/g, " ").trim(), row.text, row.name);
  }
});

test("the status band counts failed agents in red and carries blocked-only agents as a neutral note", async () => {
  const ready = { status: "ready", data: [], error: null };
  const rows = [
    { name: "a failing agent marks the stat crit", fails: [1, 0], value: 1, tone: "crit", srWord: "Needs attention" },
    { name: "blocked-only agents keep the stat calm", fails: [0, 0], value: 0, tone: null, srWord: null },
  ];
  for (const row of rows) {
    const failureByAgent = new Map(row.fails.map((fail, i) => [`glass-atrium-dev-${i}`, { fail_count: fail, blocked_count: 5, total_breakages: fail + 5, breakage_rate: 0.1 }]));
    const tree = await renderStatusBand({
      days: 14, summaryState: getSummaryState(BREAKER_LOADED_ZERO), failureState: ready, overageState: ready,
      failureByAgent, overageByAgent: new Map(), onRetry: () => undefined,
    });
    const tile = findNodes(tree, (n) => n.type === "div" && collectText(n).startsWith("Failed") && !collectText(n).includes("Unsafe"))[0];
    assert.equal(getStatTone(tile), row.tone, `${row.name}: tone`);
    assert.deepEqual(getValueTexts(tile), [String(row.value)], `${row.name}: value`);
    assert.equal(collectText(tile).match(/(Needs attention|Watch):/)?.[1] ?? null, row.srWord, `${row.name}: the glyph's word for screen readers`);
    // the ledger's Failed or blocked column counts runs over the same window, so the tile states runs too
    assert.match(collectText(tile), /last 14d · 10 blocked runs in 2 agents/, `${row.name}: blocked runs and agents over the tile window`);
  }
});

test("the failures sort puts agents with failures before compliant halts, then the higher failure rate", async () => {
  const mod = await loadAgentsScreen();
  const sort = mod.sortAgentSummary as (a: unknown[], by: string, m: Map<string, unknown>) => Array<{ agent_id: string }>;
  const failureByAgent = new Map([
    ["shell", { fail_count: 1, blocked_count: 29, total_breakages: 30, breakage_rate: 0.3 }],
    ["designer", { fail_count: 3, blocked_count: 0, total_breakages: 3, breakage_rate: 0.053 }],
    ["rare", { fail_count: 1, blocked_count: 0, total_breakages: 1, breakage_rate: 0.5 }],
  ]);
  const agents = ["shell", "designer", "rare", "clean"].map((agent_id) => ({ agent_id, agent_name: agent_id, runs: 10 }));
  assert.deepEqual(sort(agents, "failures", failureByAgent).map((a) => a.agent_id), ["designer", "rare", "shell", "clean"]);
});

test("Instrumentation is an open status fold whose head states the verdict, and the failing pairs sit beside the no-record list", async () => {
  const tree = await renderScreenAgents();
  const fold = findAtoms(tree, "Disclosure").find((n) => n.props.title === "Instrumentation");
  assert.equal(fold?.props.kind, "status");
  const split = findAtoms(tree, "SplitRow")[0];
  assert.equal(split?.props.ratio, "1:1");
  assert.equal(split?.props.layout, "equal", "the two peer cards end at one edge");
  for (const card of ["TopNFailingAgentsCard", "LifecycleStatsCard"]) {
    assert.equal(findNodes(split, (n) => n.type === card).length, 1, `${card} inside the split`);
  }
});

test("the instrumentation head names the first loaded source's lead figure within the 32-character meta cap, and warns on unfinished runs", async () => {
  const mod = await loadAgentsScreen({ formatInt: REAL_UI.formatInt });
  const verdict = mod.getInstrumentationVerdict as (l: unknown, r: unknown, a?: unknown) => { tone: string; sub: string };
  const lifecycle = (start: number, done: number) => ({ status: "ready", data: { rows: [{ agent_type: "a", start_count: start, completed_count: done }] } });
  const review = { status: "ready", data: { rows: [{ review_flagged_count: 14, total_count: 100 }] } };
  const loading = { status: "loading" };
  const rows = [
    { name: "unfinished runs warn", l: lifecycle(20, 8), r: review, tone: "warn", sub: "12 runs with no record" },
    { name: "every run finished", l: lifecycle(8, 8), r: review, tone: "ok", sub: "0 runs with no record" },
    { name: "only review flags read", l: loading, r: review, tone: "neutral", sub: "14% flagged" },
    { name: "nothing read yet", l: loading, r: loading, tone: "neutral", sub: "Is the measuring apparatus sound" },
    { name: "activations never lengthen a head that already has a lead", l: lifecycle(8, 8), r: review, a: ACTIVATIONS_READY, tone: "ok", sub: "0 runs with no record" },
    { name: "only activations read", l: loading, r: loading, a: ACTIVATIONS_READY, tone: "neutral", sub: "2.5% activation false-positive" },
    { name: "a window with no activations states that, never a rate over an empty denominator", l: loading, r: loading, a: ACTIVATIONS_EMPTY, tone: "neutral", sub: "no activations" },
    { name: "an unread activation source adds nothing, never 0 %", l: loading, r: review, a: ACTIVATIONS_FAILED, tone: "neutral", sub: "14% flagged" },
    { name: "widest: a 5-digit orphan total", l: lifecycle(99_999, 0), r: review, a: ACTIVATIONS_READY, tone: "warn", sub: "99,999 runs with no record" },
    { name: "widest: a full false-positive share leads alone", l: loading, r: loading, a: ACTIVATIONS_ALL_FALSE, tone: "neutral", sub: "100% activation false-positive" },
  ];
  for (const row of rows) {
    const got = verdict(row.l, row.r, row.a);
    assert.deepEqual({ ...got }, { tone: row.tone, sub: row.sub }, row.name);
    assert.ok(got.sub.length <= 32, `${row.name}: "${got.sub}" is ${got.sub.length} chars`);
  }
});

const ACTIVATIONS_READY = { status: "ready", data: { summary: { total_activations: 1200, overall_false_positive_rate: 0.025 } }, error: null };
const ACTIVATIONS_EMPTY = { status: "ready", data: { summary: { total_activations: 0, overall_false_positive_rate: 0 } }, error: null };
const ACTIVATIONS_FAILED = { status: "error", data: null, error: { message: "HTTP 503" } };
const ACTIVATIONS_ALL_FALSE = { status: "ready", data: { summary: { total_activations: 9999, overall_false_positive_rate: 1 } }, error: null };

test("the Instrumentation fold body carries every clause the head leaves out, and an unread source says unavailable rather than 0 %", async () => {
  const idle = { status: "loading", data: null, error: null };
  const lifecycle = { status: "ready", data: { rows: [{ agent_type: "a", start_count: 2000, completed_count: 127 }] }, error: null };
  const review = { status: "ready", data: { rows: [{ review_flagged_count: 14, total_count: 100 }] }, error: null };
  const rows = [
    { name: "read", l: idle, r: idle, a: ACTIVATIONS_READY, line: /activation false-positive 2\.5% of 1,200 activations · last 30d/ },
    { name: "every source read", l: lifecycle, r: review, a: ACTIVATIONS_READY, line: /^1,873 runs with no completion record · 14% flagged · activation false-positive 2\.5% of 1,200 activations · last 30d$/ },
    { name: "read with no activations", l: idle, r: idle, a: ACTIVATIONS_EMPTY, line: /no activations · last 30d/ },
    { name: "failed", l: idle, r: idle, a: ACTIVATIONS_FAILED, line: /Activation rate unavailable/ },
    { name: "not yet read", l: idle, r: idle, a: idle, line: /Activation rate unavailable/ },
  ];
  for (const row of rows) {
    const tree = await renderComponent("InstrumentationFold", {
      lifecycleState: row.l, reviewState: row.r, activationState: row.a, days: 30, onRetry: () => undefined,
    });
    const [line] = findNodes(tree, (n) => n.type === "p" && row.line.test(collectText(n)));
    assert.ok(line, `${row.name}: ${collectText(tree)}`);
    if (row.a !== ACTIVATIONS_READY) assert.doesNotMatch(collectText(tree), /\b0(\.0)?\s*%/, `${row.name}: no zero rate`);
    // only dim/faint are registered secondary-ink colors — any other text-* class falls back to full ink
    assert.match(String(line?.props.className ?? ""), /\btext-(dim|faint)\b/, `${row.name}: secondary-ink tone`);
  }
});

test("the drawer's Performance section states the agent's budget crossings and peak, and an unread overage source says unavailable rather than 0", async () => {
  const agent = { agent_id: "glass-atrium-dev-react", agent_name: "glass-atrium-dev-react", runs: 40, needs_context_count: 0, invocations: 40 };
  const summaryState = { status: "ready", data: { agents: [agent] }, error: null };
  const latencyState = { status: "ready", data: { agents: [] }, error: null };
  const crossed = new Map([["glass-atrium-dev-react", { overage_count: 3, max_crossed_pct: 140 }]]);
  const rows = [
    { name: "crossed", state: { status: "ready", data: { rows: [] }, error: null }, map: crossed, count: "3", peak: "140% of budget" },
    { name: "loaded with no crossing", state: { status: "ready", data: { rows: [] }, error: null }, map: new Map(), count: "0", peak: "absent:none" },
    { name: "overage read failed", state: { status: "error", data: null, error: { message: "HTTP 503" } }, map: new Map(), count: "unavailable", peak: "unavailable" },
  ];
  for (const row of rows) {
    const tree = await renderComponent("AgentPerformanceSection", {
      agent, drawerAgent: agent.agent_id, summaryState, latencyState, overageState: row.state, overageByAgent: row.map, onRetry: () => undefined,
    });
    // an absent value is the shared AbsentValue element → read back as its kind
    const metric = (label: string) => {
      const value = findNodes(tree, (n) => n.type === "DetailMetric" && n.props.label === label)[0]?.props.value as { props?: { kind?: string } } | string;
      return typeof value === "object" && value?.props?.kind ? `absent:${value.props.kind}` : value;
    };
    assert.equal(metric("Budget crossings"), row.count, `${row.name}: count`);
    assert.equal(metric("Peak crossing"), row.peak, `${row.name}: peak`);
  }
});

test("every ledger and pairs column header comes from the shared header atom", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const pairs = renderScreen(React.createElement(mod.TopNFailingAgentsTable as Component, { pairs: [], failureByAgent: new Map(), days: 14 }));
  for (const [name, tree] of [["ledger", renderLedger(mod)], ["pairs", pairs]] as const) {
    const heads = findNodes(tree, (n) => n.type === "th");
    assert.ok(heads.length > 0, `${name}: column heads rendered`);
    assert.deepEqual(heads.filter((n) => n.props.scope !== "col").map((n) => collectText(n)), [], `${name}: no hand-rolled th`);
  }
});

test("a ledger trend chart is announced by its agent and by the metric it plots, runs per day", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const tree = renderScreen(
    React.createElement(mod.AgentSummaryRow as Component, {
      agent: { agent_id: "glass-atrium-dev-react", agent_name: "dev-react", status: "active", success_pct: 92, runs: 40, needs_context_count: 2, p95_ms: 120_000 },
      days: 30, isSelected: false, onSelect: () => {}, trend: [3, 5, 2], failure: null, overage: null,
      failureStatus: "ready", trendStatus: "ready",
    }),
  );
  const label = String(findAtoms(tree, "MiniBars")[0]?.props.label);
  assert.match(label, /dev-react/);
  assert.match(label, /runs per day/i, "the series is buildAgentTrendMap's daily total_count, so the name must say runs");
  assert.doesNotMatch(label, /success/i, "a runs series must not be announced as a success rate");
});

test("a matrix sparkline is a named image rather than an unlabelled drawing", async () => {
  const tree = await renderComponent("SuccessRateSparkline", { points: [{ rate: 1 }, { rate: 0.5 }], colorVar: "--ok", name: "dev-react feature" });
  const img = findNodes(tree, (n) => n.props?.role === "img")[0];
  assert.match(String(img?.props["aria-label"]), /dev-react feature/);
});

test("drawer section titles are h2 headings under the dialog's own name", async () => {
  const tree = await renderComponent("AgentDrawerSection", { title: "Reliability" });
  assert.equal(findAtoms(tree, "SubCard")[0]?.props.labelLevel, 2);
});

test("the drawer's name reads its parts apart and never repeats the surface's own title id", async () => {
  const idle = { status: "idle", data: null, error: null };
  const agent = { agent_id: "glass-atrium-dev-shell", agent_name: "glass-atrium-dev-shell", status: "active", origin: "system" };
  const tree = await renderComponent("AgentDetailDrawer", {
    drawerAgent: agent.agent_id, sortedAgents: [agent], summaryState: { status: "ready", data: { agents: [agent] }, error: null },
    revisionState: idle, reviewByAgentState: idle, latencyState: idle, successState: idle, failureState: idle, lifecycleState: idle,
    detailState: idle, blockedState: idle, recentState: idle, trendByAgent: null, failureByAgent: null, days: 30,
    onClose: () => undefined, onNav: () => undefined, onRetry: () => undefined, onDeleted: () => undefined,
  });
  const surface = findAtoms(tree, "DetailSurface")[0];
  // DetailSurface names the dialog by the node wrapping the whole title, so every part of it is read out.
  const title = renderScreen(surface.props.title);
  const labelledBy = surface.props.labelledBy;
  assert.deepEqual(labelledBy === undefined ? [] : findNodes(title, (n) => n.props?.id === labelledBy), [], "no second node carries the dialog's name id");
  const [name] = findAtoms(title, "AgentName");
  assert.equal(name?.props.name, "glass-atrium-dev-shell", "the name part is the shared agent name");
  const separators = findNodes(title, (n) => n.props?.className === "sr-only" && collectText(n).trim() === ",");
  assert.equal(separators.length, 2, "name, activity and health are read as three parts");
});

test("the review-flag total sits under a card title in every state, never as a heading-less tile", async () => {
  const rows = [
    { name: "loading", state: { status: "loading", data: null, error: null } },
    { name: "ready", state: { status: "ready", data: { rows: [{ event_date: "2026-09-24", total_count: 20, review_flagged_count: 3 }] }, error: null } },
  ];
  for (const row of rows) {
    const tree = await renderComponent("ReviewFlagTimelineCard", { state: row.state, days: 30, onRetry: () => undefined });
    const cardHead = findAtoms(tree, "Card")[0];
    assert.equal(cardHead?.props.title, "Review flags", row.name);
    assert.match(String(cardHead?.props.sub), /30 days/, row.name);
  }
});

// whitespace-normalized: collectText pads node boundaries, and a caption may hold an inline NoWrap token ("7 days")
function findCaption(tree: RenderedNode | string | null, text: string): RenderedNode | undefined {
  return findNodes(tree, (n) => typeof n.type === "string" && collectText(n).replace(/\s+/g, " ").trim() === text).at(-1);
}

const PERFORMANCE_AGENT = { agent_id: "glass-atrium-dev-react", agent_name: "dev-react", status: "active", runs: 12, needs_context_count: 0 };

function getPerformanceProps(trend: number[] | null, trendDates: string[]): Record<string, unknown> {
  return {
    agent: PERFORMANCE_AGENT, drawerAgent: PERFORMANCE_AGENT.agent_id,
    summaryState: { status: "ready", data: { agents: [PERFORMANCE_AGENT] }, error: null },
    latencyState: { status: "idle", data: null, error: null },
    trendByAgent: trend ? new Map([[PERFORMANCE_AGENT.agent_id, trend]]) : null, trendDates, onRetry: () => undefined,
  };
}

describe("the drawer trend chart paints runs in the data colour, whatever the status or failed share", () => {
  const rows = [
    { name: "a low sample", agent: { runs: 4, success_pct: 50 } },
    { name: "a rate under the crit step", agent: { runs: 50, success_pct: 98 } },
    { name: "a rate over the crit step", agent: { runs: 50, success_pct: 92 } },
    { name: "an errored agent", agent: { status: "error", runs: 50, success_pct: 98 } },
  ];
  for (const row of rows) {
    test(`${row.name}: the chart carries no tone, so a severity never becomes the series colour`, async () => {
      const tree = await renderComponent("AgentPerformanceSection", {
        ...getPerformanceProps([3, 5, 2], ["2026-09-22", "2026-09-23", "2026-09-24"]),
        agent: { ...PERFORMANCE_AGENT, ...row.agent },
      });
      const charts = findAtoms(tree, "TrendChart");
      assert.equal(charts.length, 1, "one trend chart");
      assert.equal(charts[0].props.tone, undefined);
    });
  }
});

test("the drawer trend is a readable chart with one dated point per day", async () => {
  const dates = ["2026-09-22", "2026-09-23", "2026-09-24"];
  const tree = await renderComponent("AgentPerformanceSection", getPerformanceProps([3, 0, 5], dates));
  const [chart] = findAtoms(tree, "TrendChart");
  // The screen module runs in its own realm → compare plain copies.
  assert.deepEqual(JSON.parse(JSON.stringify(chart?.props.points)), [
    { label: "2026-09-22", value: 3 },
    { label: "2026-09-23", value: 0 },
    { label: "2026-09-24", value: 5 },
  ]);
  assert.match(String(chart?.props.label), /dev-react/);
  assert.equal(findAtoms(tree, "MiniBars").length, 0, "no unreadable bar strip beside it");
});

test("the trend dates are the last seven days any agent reported, oldest first", async () => {
  const mod = await loadAgentsScreen();
  const getTrendDates = mod.getTrendDates as (rows: unknown[]) => string[];
  const rows = Array.from({ length: 9 }, (_, i) => ({ agent: "a", event_date: `2026-09-${String(20 - i).padStart(2, "0")}`, total_count: 1 }));
  assert.deepEqual([...getTrendDates(rows)], ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"]);
});

test("caption words render in the sans face, leaving mono to ids and numbers", async () => {
  const rows = [
    { name: "drawer trend", component: "AgentPerformanceSection", props: getPerformanceProps([1, 2], ["2026-09-23", "2026-09-24"]), caption: "Runs per day · last 7 days" },
    { name: "compatibility", component: "CompatibilityDetailBlock", props: { compatibility: "monitor daemon running" }, caption: "Requires" },
    { name: "matrix legend", component: "SuccessRateLegend", props: {}, caption: "Legend" },
  ];
  for (const row of rows) {
    const caption = findCaption(await renderComponent(row.component, row.props), row.caption);
    assert.ok(caption, `${row.name}: caption rendered`);
    assert.doesNotMatch(String(caption.props.className ?? ""), /font-mono|uppercase/, row.name);
  }
});

const REVIEW_FLAG_ROWS = [
  { date: "09-23", fullDate: "2026-09-23", empty_metric_count: 1, polar_mismatch_count: 0, review_flag_ratio_pct: 5 },
  { date: "09-24", fullDate: "2026-09-24", empty_metric_count: 2, polar_mismatch_count: 1, review_flag_ratio_pct: 12.5 },
];

test("review-flag chart dates take the shared day-axis tick, end-keeping interval and label gap, and its value axes read the meta token", async () => {
  const tree = await renderComponent("QualityHealthTimelineChart", { rows: REVIEW_FLAG_ROWS });
  const [dateAxis] = findAtoms(tree, "XAxis");
  const getDayAxisProps = REAL_UI.getChartXAxisProps as (labels: string[]) => Record<string, unknown>;
  const expected = getDayAxisProps(REVIEW_FLAG_ROWS.map((row) => row.date));
  for (const key of ["tick", "interval", "minTickGap"]) {
    assert.equal(dateAxis?.props[key], expected[key], `date axis ${key}`);
  }
  const valueAxes = findAtoms(tree, "YAxis");
  assert.equal(valueAxes.length, 2);
  // an SVG presentation attribute cannot resolve a var() → the token rides the CSS style
  for (const axis of valueAxes) {
    for (const part of [axis.props.tick, axis.props.label] as Array<{ fontSize?: unknown; style?: { fontSize?: unknown } } | undefined>) {
      if (!part) continue;
      assert.equal(part.fontSize, undefined, "no numeric size beside the token");
      assert.equal(part.style?.fontSize, "var(--fs-meta)");
    }
    const tick = axis.props.tick as { fontFamily?: unknown; style?: { fontFamily?: unknown; fontVariantNumeric?: unknown } };
    assert.equal(tick.fontFamily ?? tick.style?.fontFamily, undefined, "the tick numerals inherit the sans face");
    assert.equal(tick.style?.fontVariantNumeric, "tabular-nums", "the tick numerals keep tabular figures");
  }
});

const metricValueOf = (tree: RenderedNode | string | null, label: string) =>
  findNodes(tree, (n) => n.type === "div" && /flex-col/.test(String(n.props.className)) && collectText(n).startsWith(label));

test("a drawer duration with nothing behind it reads None when its row was read and Not loaded when it was not, never a dash", async () => {
  const absentKinds = (tree: RenderedNode | string | null) => findAtoms(tree, "AbsentValue").map((n) => n.props.kind);
  const latencyRow = await renderComponent("AgentLatencyRow", {
    latency: { agent_id: "solo", agent_name: "solo", p50_ms: 1000, p95_ms: null, p99_ms: null },
    state: { status: "ready", data: { rows: [] } }, onRetry: () => undefined,
  });
  assert.deepEqual(absentKinds(latencyRow), ["none", "none"], "a read latency row with no P95 or P99 holds None");
  assert.ok(!collectText(latencyRow).includes("\u2014"), "no dash stands in a value slot");

  const performance = await renderComponent("AgentPerformanceSection", getPerformanceProps(null, []));
  const [p95] = metricValueOf(performance, "P95");
  assert.deepEqual(absentKinds(p95 ?? null), ["not-loaded"], "the drawer P95 before the latency read says Not loaded");
});

// a chart mark that resolves to a tone or the accent paints severity or emphasis as a series colour
const getToneOrAccentPaints = (tree: RenderedNode | string | null): string[] =>
  findNodes(tree, () => true).flatMap((n) => {
    const paints = [n.props.fill, n.props.stroke, (n.props.style as Record<string, unknown> | undefined)?.background]
      .map(String).filter((paint) => /--(?:accent|info|crit|warn|ok)\b/.test(paint));
    const classes = String(n.props.className ?? "").split(/\s+/).filter((name) => /^bg-(?:accent|info|crit|warn|ok)\b/.test(name));
    return [...paints, ...classes];
  });

test("review-flag chart: the reason bars carry the data colour and the rate is a straight ink line over a card-ground under-stroke", async () => {
  const tree = await renderComponent("QualityHealthTimelineChart", { rows: REVIEW_FLAG_ROWS });
  const bars = findAtoms(tree, "Bar");
  assert.equal(bars.length, 2, "both flag reasons stack");
  for (const bar of bars) assert.equal(bar.props.fill, "rgb(var(--data))", `${bar.props.dataKey} bar`);
  const rateLines = findAtoms(tree, "Line").filter((line) => line.props.dataKey === "review_flag_ratio_pct");
  assert.deepEqual(rateLines.map((line) => [line.props.stroke, line.props.strokeWidth]),
    [["rgb(var(--elev))", 3.5], ["rgb(var(--ink))", 1.5]], "the under-stroke is drawn first, the ink line over it");
  for (const line of rateLines) {
    assert.equal(line.props.type, "linear", "no smoothing");
    assert.equal(line.props.dot, false, "no dots");
    assert.equal(line.props.strokeDasharray, undefined, "a solid series line");
  }
  assert.deepEqual(getToneOrAccentPaints(tree), [], "no mark of a quantity takes a tone or the accent");
});

test("latency layers and failure-category bars carry the data colour, never a tone", async () => {
  const latency = await renderComponent("LatencyBars", { agents: [{ agent_name: "glass-atrium-dev-react", p50_ms: 1000, p95_ms: 3000, p99_ms: 5000 }] });
  const breakage = await renderComponent("MergedBreakageBody", {
    merged: { total: 5, failTotal: 4, blockedTotal: 1, reasons: [{ category: "timeout", count: 3, failCount: 3, blockedCount: 0 }, { category: "tool_error", count: 2, failCount: 1, blockedCount: 1 }] },
    days: 30,
  });
  const dataMarks = (tree: RenderedNode | string | null) => findNodes(tree, (n) => /\bbg-data\b/.test(String(n.props.className ?? ""))).length;
  assert.equal(dataMarks(latency), 6, "three latency layers and their three keys");
  assert.equal(dataMarks(breakage), 2, "one bar per failure category");
  assert.deepEqual([...getToneOrAccentPaints(latency), ...getToneOrAccentPaints(breakage)], []);
});

test("review-flag chart is a focusable image named by the flagged-rate range, latest, low and high", async () => {
  const tree = await renderComponent("QualityHealthTimelineChart", { rows: REVIEW_FLAG_ROWS });
  const [image] = findNodes(tree, (n) => n.props.role === "img");
  assert.equal(image?.props.tabIndex, 0);
  assert.equal(image?.props["aria-label"],
    "Daily flagged rate, 2 days from 2026-09-23 to 2026-09-24: latest 12.5%, low 5%, high 12.5%");
});

test("a drawer metric sits flat on its section rather than as a card inside a card", async () => {
  const tree = await renderComponent("DetailMetric", { label: "Runs", value: "12" });
  const root = tree as RenderedNode;
  assert.doesNotMatch(String(root.props.className), /ring-|bg-sunken|rounded/);
  assert.equal(collectText(root), "Runs 12");
});

function getBandTile(tree: RenderedNode | string | null, label: string): RenderedNode | null {
  const labels = ["Unsafe to route", "Failed", "Over tool-use cap", "Needs info"];
  return findNodes(tree, (n) => n.type === "div" && collectText(n).startsWith(label))
    .filter((n) => labels.every((other) => other === label || !collectText(n).includes(other)))[0] ?? null;
}

test("the over-cap and needs-context tiles state their rate over runs, and the tone follows the rate rather than presence", async () => {
  const ready = { status: "ready", data: [], error: null };
  const agents = [{ agent_id: "a", runs: 600, needs_context_count: 2 }, { agent_id: "b", runs: 400, needs_context_count: 1 }];
  const rows = [
    { name: "none crossed", overCap: 0, tone: null, ratePct: "0" },
    { name: "3 of 1,000 stays under the 5% step", overCap: 3, tone: null, ratePct: "0.3" },
    { name: "60 of 1,000 crosses the 5% step", overCap: 60, tone: "warn", ratePct: "6" },
  ];
  for (const row of rows) {
    const overageByAgent = new Map(Array.from({ length: row.overCap }, (_, i) => [`run-${i}`, { overage_count: 1 }]));
    const tree = await renderStatusBand({
      days: 14, summaryState: getSummaryState(null, agents), failureState: ready, overageState: ready,
      failureByAgent: new Map(), overageByAgent, onRetry: () => undefined,
    });
    const overCap = getBandTile(tree, "Over tool-use cap");
    assert.equal(getStatTone(overCap), row.tone, `${row.name}: tone`);
    assert.equal(collectText(overCap).match(/([\d.]+)% of 1,?000 runs/)?.[1] ?? null, row.ratePct, `${row.name}: rate`);
    const needsContext = getBandTile(tree, "Needs info");
    assert.match(collectText(needsContext), /0\.3% of 1,?000 runs/, "needs context states its rate over the same runs");
    assert.equal(getStatTone(needsContext), null, "3 of 1,000 needs-context outcomes stay untoned");
  }
});

test("the P95 warn cut follows the fleet's upper quartile, so warn stays rare while the 10-minute floor holds", async () => {
  const mod = await loadAgentsScreen();
  const getP95WarnSec = mod.getP95WarnSecAg as (agents: unknown[]) => number;
  const toAgents = (secs: number[]) => secs.map((s, i) => ({ agent_id: `a${i}`, agent_name: `a${i}`, status: "active", runs: 40, success_pct: 100, p95_ms: s * 1000 }));
  const rows = [
    { name: "a slow fleet raises the cut to its p75", secs: [300, 700, 800, 900, 1000, 1100, 1150, 1190], cut: 1100 },
    { name: "a fast fleet keeps the 10-minute floor", secs: [60, 120, 180, 240, 300], cut: 600 },
    { name: "fewer than four measured agents keep the floor", secs: [900, 1000, 1100], cut: 600 },
  ];
  for (const row of rows) {
    const cut = getP95WarnSec([...toAgents(row.secs), { agent_id: "unmeasured", p95_ms: null }]);
    assert.equal(cut, row.cut, row.name);
  }
});

test("every ledger row reads the fleet P95 cut, and only a p95 above it takes the warn glyph", async () => {
  const mod = await loadAgentsScreen();
  const slowFleetSecs = [300, 700, 800, 900, 1000, 1100, 1150, 1190];
  const agents = slowFleetSecs.map((s, i) => ({ agent_id: `a${i}`, agent_name: `a${i}`, status: "active", runs: 40, success_pct: 100, p95_ms: s * 1000 }));
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const table = renderScreen(React.createElement(mod.AgentSummaryTable as Component, {
    agents, pseudoAgents: [], days: 30, selectedAgent: null, onSelect: () => {},
  }));
  const cuts = findNodes(table, (n) => n.type === "AgentSummaryRow").map((n) => n.props.p95WarnSec);
  assert.deepEqual(Array.from(new Set(cuts)), [1100], "every ledger row reads the fleet cut");
  const glyphOf = (sec: number) => {
    const row = findNodes(table, (n) => n.type === "AgentSummaryRow" && (n.props.agent as { p95_ms: number }).p95_ms === sec * 1000)[0];
    const cell = findCellByTitle(row, /^p95 latency tier/);
    return findNodes(cell, (n) => n.type === "span" && n.props?.["aria-hidden"] === "true")[0]?.props.className;
  };
  assert.equal(glyphOf(1000), "text-ok", "under the fleet cut reads fast");
  assert.equal(glyphOf(1150), "text-dim", "above the fleet cut takes the warn glyph");
});

test("the success cell shows the rate alone, its fraction kept in the tooltip", async () => {
  const mod = await loadAgentsScreen();
  const rows = [
    { name: "a measured rate", agent: { success_pct: 97.5, runs: 40, needs_context_count: 0 }, text: "97.5%", title: /^passed 39 ÷ denominator 40 / },
    { name: "a near-total rate never rounds up to the whole", agent: { success_pct: 99.975, runs: 4000, needs_context_count: 0 }, text: ">99.9%", title: /^passed 3999 ÷ denominator 4000 / },
    { name: "a whole rate keeps the column's one decimal", agent: { success_pct: 100, runs: 40, needs_context_count: 0 }, text: "100.0%", title: /^passed 40 ÷ denominator 40 / },
    { name: "no outcome to rate", agent: { success_pct: 0, runs: 0, needs_context_count: 0 }, text: "None", title: /success rate undefined/ },
  ];
  for (const row of rows) {
    const cell = findCellByTitle(renderToneRow(mod, row.agent, null), /^passed|success rate undefined/);
    const text = collectText(cell);
    assert.ok(text.includes(row.text), `${row.name}: ${text}`);
    assert.doesNotMatch(text, /\(\d/, `${row.name}: no fraction in the cell`);
    assert.match(String(cell?.props.title), row.title, `${row.name}: the tooltip keeps the fraction`);
    assert.equal(findAtoms(cell, "BulletBar").length, 0, `${row.name}: no bar beside the rate`);
  }
});

test("the failing-pairs limit keeps a solid signal over a worse small sample while the total still counts both", async () => {
  const mod = await loadAgentsScreen();
  const buildTopNFailing = mod.buildTopNFailing as (rows: unknown[], l: number) => { failingPairs: Array<{ task_type: string }>; failingTotal: number; measuredPairs: number };
  const day = (task_type: string, success: number, failure: number) => ({ agent: "glass-atrium-dev-node", task_type, event_date: "2026-09-01", success_count: success, failure_count: failure, total_count: success + failure });
  const rows = [day("tiny", 0, 3), day("solid", 5, 5), day("healthy", 20, 0)];
  const out = buildTopNFailing(rows, 1);
  assert.deepEqual(Array.from(out.failingPairs, (p) => p.task_type), ["solid"], "the limit keeps the solid signal over a worse small sample");
  assert.equal(out.failingTotal, 2);
});

test("the failing-pairs header meta counts failing over judged pairs within the 32-character meta cap", async () => {
  const mod = await loadAgentsScreen();
  const getSub = mod.getFailingPairsSub as (...a: unknown[]) => string;
  const sub = getSub("ready", 120, 1500, 90);
  assert.equal(sub, "120 of 1500 ≤ 95% · 90d");
  assert.ok(sub.length <= 32, `${sub.length} chars`);
});

test("the review-flag and task-type headers keep their meta within the 32-character cap", async () => {
  const headers = [
    ...findAtoms(await renderComponent("ReviewFlagTimelineCard", { state: LOADING_STATE, days: 90, onRetry: () => undefined }), "Card"),
    ...findAtoms(await renderComponent("TaskTypeFold", { state: LOADING_STATE, days: 90, onRetry: () => undefined }), "Disclosure"),
  ];
  assert.equal(headers.length, 2, "both headers render");
  for (const header of headers) {
    const sub = String(header.props.sub);
    assert.ok(sub.length <= 32, `${header.props.title}: "${sub}" is ${sub.length} chars`);
  }
});

test("the review-flag card and the task-type fold keep their titles within the 24-character cap", async () => {
  const props = { state: LOADING_STATE, days: 90, onRetry: () => undefined };
  const heads = [
    ...findAtoms(await renderComponent("ReviewFlagTimelineCard", props), "Card"),
    ...findAtoms(await renderComponent("TaskTypeFold", { ...props, failures: undefined }), "Disclosure"),
  ];
  assert.equal(heads.length, 2, "both heads render");
  for (const head of heads) {
    const title = String(head.props.title);
    assert.ok(title.length <= 24, `"${title}" is ${title.length} chars`);
  }
});

test("the failing-pairs table ranks solid pairs above a divider that names the low-sample group", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const pair = (task_type: string, successCount: number, rateDenominator: number) =>
    ({ agent: "glass-atrium-dev-node", task_type, successCount, rateDenominator, pooledRate: successCount / rateDenominator, totalCount: rateDenominator });
  const table = renderScreen(React.createElement(mod.TopNFailingAgentsTable as Component, {
    pairs: [pair("low", 1, 3), pair("solid", 5, 10)], failureByAgent: new Map(), days: 14,
  }));
  const bodyRows = findNodes(table, (n) => n.type === "tr").slice(1).map((n) => collectText(n));
  assert.equal(bodyRows.length, 3);
  assert.match(bodyRows[0], /solid/);
  assert.match(bodyRows[1], /low sample/i, "a divider names the low-sample group");
  assert.match(bodyRows[2], /low/);
});

test("a drawer concern shows as a whole item clamped to two lines, with the full text on hover", async () => {
  const idle = { status: "idle", data: null, error: null };
  const concern = "hook exits 0 on empty history with no stderr, so the daemon cycle reads the gap as a pass";
  const failureByAgent = new Map([["glass-atrium-dev-react", { total_breakages: 2, fail_count: 2, blocked_count: 0, reconstructed: 0, breakage_rate: 0.05 }]]);
  const tree = await renderComponent("AgentReliabilityBreakages", {
    drawerAgent: "glass-atrium-dev-react", failureByAgent, days: 30, onRetry: () => undefined, detailState: idle, blockedState: idle,
    failureState: { status: "ready", data: { rows: [{ agent: "glass-atrium-dev-react", top_concerns: [concern] }] }, error: null },
  });
  const item = findNodes(tree, (n) => n.type === "li" && collectText(n) === concern && n.props?.title !== undefined)[0];
  assert.equal(item?.props.title, concern, "the tooltip carries the whole item");
  assert.equal((item?.props.style as Record<string, unknown> | undefined)?.WebkitLineClamp, 2, "clamped to two lines");
});

test("a drawer section spaces its sub-blocks through the block role, whatever each sub-block renders", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown, ...kids: unknown[]) => unknown };
  const tree = renderScreen(React.createElement(
    mod.AgentDrawerSection as Component,
    { id: "drawer-overview", title: "Overview" },
    React.createElement("div", null, "breaker line"),
    React.createElement("div", null, "success-rate hero"),
  ));
  const stack = findNodes(tree, (n) => n.props.atom === "Stack")[0];
  assert.equal(stack?.props.gap, "block", "the sub-blocks share one block-role stack");
  assert.equal(collectText(stack), "breaker line success-rate hero", "both sub-blocks sit inside it");
});

describe("a drawer sub-block label sits on its own content through the label role", () => {
  const idle = { status: "idle", data: null, error: null };
  const agentId = "glass-atrium-dev-react";
  const breakages = (failure: unknown) => ({
    component: "AgentReliabilityBreakages",
    props: {
      drawerAgent: agentId, days: 30, onRetry: () => undefined, detailState: idle, blockedState: idle,
      failureByAgent: new Map(failure ? [[agentId, failure]] : []),
      failureState: { status: "ready", data: { rows: [] }, error: null },
    },
  });
  const lifecycle = (rows: unknown[]) => ({
    component: "AgentReliabilityLifecycle",
    props: { agent: null, drawerAgent: agentId, onRetry: () => undefined, lifecycleState: { status: "ready", data: { rows }, error: null } },
  });
  const rows = [
    { name: "Breakages with breakages", label: "Breakages", ...breakages({ total_breakages: 3, fail_count: 2, blocked_count: 1, reconstructed: 0, breakage_rate: 0.1 }) },
    { name: "Breakages with none", label: "Breakages", ...breakages(null) },
    { name: "Lifecycle with a row", label: "Lifecycle", ...lifecycle([{ agent_type: agentId, start_count: 10, completed_count: 9, avg_duration_sec: 30, p95_duration_sec: 60, max_duration_sec: 90 }]) },
    { name: "Lifecycle with no row", label: "Lifecycle", ...lifecycle([]) },
  ];

  for (const row of rows) {
    test(row.name, async () => {
      const tree = await renderComponent(row.component, row.props);
      const label = findNodes(tree, (n) => n.type === "div" && collectText(n) === row.label)[0];
      assert.match(String(label?.props.className), /\bmb-label\b/, "the label carries the label role");
      const parent = findNodes(tree, (n) => n.children.includes(label!))[0];
      assert.doesNotMatch(String(parent?.props.className ?? ""), /space-y-|\bstack\b/, "no stacking parent widens the label gap to its own");
    });
  }
});

// Stub LOW_N_MIN = 5. revision bucket '0' → health 1 (ok) · avg 0.3 → health 0.64 (warn) · bucket '4+' → health 0.4 (crit).
describe("the ledger head names the agents the health rule flags, and stays silent otherwise", () => {
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const revision = (agent: string, buckets: Record<string, number>) =>
    Object.entries(buckets).map(([revision_bucket, occurrence_count]) => ({ agent, revision_bucket, occurrence_count }));
  const healthy = revision("a-healthy", { "0": 10 });
  const watched = revision("a-watch", { "0": 7, "1": 3 });
  const critical = revision("a-crit", { "4+": 10 });
  const thin = revision("a-thin", { "4+": 2 });
  const renderMarks = async (revisionState: unknown, reviewByAgentState: unknown = ready({ rows: [] })) => {
    const tree = await renderComponent("HealthMarkAg", { revisionState, reviewByAgentState });
    return findNodes(tree, (n) => n.props?.["data-health-mark"] !== undefined).map((n) => ({ tone: n.props["data-health-mark"], text: collectText(n).trim() }));
  };
  const rows = [
    { name: "a crit and a watch agent each get a mark, crit first, in the drawer's words", revision: ready({ rows: [...healthy, ...watched, ...critical] }), marks: [{ tone: "crit", text: "Needs attention · a-crit" }, { tone: "warn", text: "Watch · a-watch" }] },
    { name: "a watch-band agent alone gets only the watch mark", revision: ready({ rows: [...healthy, ...watched] }), marks: [{ tone: "warn", text: "Watch · a-watch" }] },
    { name: "a healthy fleet is silent, the agent below the low-N floor left out", revision: ready({ rows: [...healthy, ...thin] }), marks: [] },
    { name: "a pending revision read marks nothing", revision: LOADING_STATE, marks: [] },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      assert.deepEqual(await renderMarks(row.revision), row.marks);
    });
  }

  test("each mark draws its tone's shared glyph, the one the stat row draws for that tone", async () => {
    const tree = await renderComponent("HealthMarkAg", { revisionState: ready({ rows: [...healthy, ...watched, ...critical] }), reviewByAgentState: ready({ rows: [] }) });
    const marks = findNodes(tree, (n) => n.props?.["data-health-mark"] !== undefined);
    assert.deepEqual(
      marks.map((n) => findAtoms(n, "Icon").map((icon) => icon.props.name)),
      marks.map((n) => [`tone-glyph-${String(n.props["data-health-mark"])}`]),
    );
    assert.equal(marks.length, 2, "a crit and a watch mark");
  });

  test("an unread flag rate marks nothing rather than judging on rework alone", async () => {
    assert.deepEqual(await renderMarks(ready({ rows: critical }), ERROR_STATE), []);
  });

  test("the page mounts no verdict and carries the mark in the ledger head", async () => {
    const tree = await renderScreenAgents({
      status: "ready", busy: false, key: null, error: null,
      data: { rows: critical, agents: [{ agent: "a-crit", runs: 10 }], meta: { total_agents: 1 }, fetched_at: "2026-01-10T11:59:00.000Z" },
    });
    assert.equal(findAtoms(tree, "PageVerdict").length, 0);
    const [head] = findAtoms(tree, "Card").filter((n) => n.props.title === "Performance by agent");
    assert.ok(head, "the ledger card draws its head");
    const marks = findNodes(renderScreen(head.props.right), (n) => n.props?.["data-health-mark"] === "crit");
    assert.equal(marks.length, 1, "the crit agent is named in the ledger head");
  });
});

test("a lifecycle row names its agent through the shared agent name, never a raw id the cell truncates", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const tree = renderScreen(
    React.createElement(mod.LifecycleStatsTable as Component, {
      rows: [{ agent_type: "glass-atrium-dev-shell", start_count: 4, stop_count: 4, completed_count: 3, p95_duration_sec: 60 }],
      onSelect: () => undefined,
    }),
  );
  assert.deepEqual(findAtoms(tree, "AgentName").map((n) => n.props.name), ["glass-atrium-dev-shell"]);
});

// component nodes keep their name as type; the region's card is the first host element beneath them
function getRootHost(node: RenderedNode): RenderedNode {
  const [child] = node.children;
  const isComponent = /^[A-Z]/.test(String(node.type));
  return isComponent && child && typeof child !== "string" ? getRootHost(child) : node;
}

describe("a focused Retry that succeeds leaves focus on its region's card", () => {
  const putRegionRequest = REAL_UI.putRegionRequest as (state: unknown, key: string, request: unknown) => Record<string, unknown>;
  const retrying = putRegionRequest(ERROR_STATE, "k", new AbortController());
  const onRetry = () => undefined;

  test("each page card hands its error card's Retry to the card itself", async () => {
    const rows = [
      { name: "success rates", component: "SuccessRateMatrixRegion", props: { state: retrying, days: 30, onRetry } },
      { name: "failure rates", component: "TopNFailingAgentsCard", props: { state: retrying, days: 30, onRetry, failureByAgent: new Map() } },
      { name: "review flags", component: "ReviewFlagTimelineCard", props: { state: retrying, days: 30, onRetry } },
      { name: "lifecycle stats", component: "LifecycleStatsCard", props: { state: retrying, days: 30, onSelect: () => undefined, onRetry } },
    ];

    for (const row of rows) {
      const tree = await renderComponent(row.component, row.props) as RenderedNode;
      const [errorCard] = findAtoms(tree, "RegionUnavailable");
      assert.equal(errorCard?.props.isBusy, true, `${row.name}: the card stays up, busy, through the Retry`);
      assert.ok(errorCard.props.focusTargetId, `${row.name}: the Retry names a focus target`);
      assert.equal(getRootHost(tree).props.id, errorCard.props.focusTargetId, `${row.name}: the target is the region's own card`);
    }
  });

  test("each drawer section hands its error card's Retry to the section that encloses it", async () => {
    const agent = { agent_id: "glass-atrium-dev-shell", agent_name: "glass-atrium-dev-shell", status: "active", origin: "system" };
    const idle = { status: "idle", data: null, error: null };
    const base = {
      drawerAgent: agent.agent_id, sortedAgents: [agent], trendByAgent: null, trendDates: [], days: 30,
      onClose: onRetry, onNav: onRetry, onRetry, onDeleted: onRetry,
    };
    const rows = [
      {
        name: "summary-backed sections failing",
        sources: ["overview", "performance", "failure patterns", "lifecycle stats", "quality signals", "recent activity"],
        props: {
          ...base, summaryState: retrying, revisionState: retrying, reviewByAgentState: retrying, latencyState: retrying,
          failureState: retrying, lifecycleState: retrying, detailState: idle, blockedState: idle, recentState: retrying, failureByAgent: new Map(),
        },
      },
      {
        name: "nested rows failing under a loaded summary",
        sources: ["latency", "failure causes"],
        props: {
          ...base, summaryState: { status: "ready", data: { agents: [agent] }, error: null }, revisionState: idle, reviewByAgentState: idle,
          latencyState: retrying, failureState: { status: "ready", data: { rows: [] }, error: null }, lifecycleState: idle,
          detailState: retrying, blockedState: retrying, recentState: idle,
          failureByAgent: new Map([[agent.agent_id, { total_breakages: 2, reconstructed: 0, breakage_rate: 0.1 }]]),
        },
      },
    ];

    for (const row of rows) {
      const tree = await renderComponent("AgentDetailDrawer", row.props) as RenderedNode;
      const errorCards = findAtoms(tree, "RegionUnavailable");
      const sources = errorCards.map((card) => String(card.props.source));
      for (const source of row.sources) assert.ok(sources.includes(source), `${row.name}: ${source} renders its error card`);

      for (const card of errorCards) {
        const label = `${row.name}: ${String(card.props.source)}`;
        const targetId = card.props.focusTargetId;
        assert.equal(card.props.isBusy, true, `${label} stays up, busy, through the Retry`);
        assert.ok(targetId, `${label} names a focus target`);
        const [section] = findNodes(tree, (n) => n.type === "section" && n.props.id === targetId);
        assert.ok(section, `${label}: the target is a drawer section`);
        assert.equal(findNodes(section, (n) => n === card).length, 1, `${label}: the target section encloses the card`);
      }
    }
  });
});

test("one failed read gives one error card, and every other region it feeds points at that card", async () => {
  const mod = await loadAgentsScreen();
  const ready = { status: "ready", data: [], error: null };
  const failed = { ...ERROR_STATE, busy: false };
  const getFailures = mod.getAgentSourceFailures as (entries: [string, unknown][]) => { banner: unknown };
  const failures = getFailures([["agent summary", failed], ["success rates", ready], ["failure patterns", ready], ["budget overages", ready]]);
  assert.equal(failures.banner, null, "one failed source raises no page banner");
  const onRetry = () => undefined;
  const trees = [
    await renderComponent("AgentAlarmLane", { failures, state: failed, onRetry }),
    await renderStatusBand({
      failures, days: 30, summaryState: failed, failureState: ready, overageState: ready,
      failureByAgent: new Map(), overageByAgent: new Map(), onRetry,
    }),
    await renderComponent("AgentSummaryCard", { failures, state: failed, days: 30, onRetry }),
  ];
  const cards = trees.flatMap((tree) => findAtoms(tree, "RegionUnavailable"));
  assert.deepEqual(cards.map((card) => card.props.source), ["agent summary"], "the summary read speaks once, named by its read");
  assert.equal(typeof cards[0].props.onRetry, "function");
  const covered = trees.flatMap((tree) => findAtoms(tree, "RegionCovered"));
  assert.equal(covered.length, 3, "the unsafe and needs-context tiles and the ledger point at that card");
});

test("the drawer's breakage headline names what it counts and sets the blocked part apart as a compliant halt", async () => {
  const agent = "glass-atrium-dev-shell";
  const row = { fail_count: 3, blocked_count: 5, total_breakages: 8, breakage_rate: 0.2, reconstructed: 0 };
  const idle = { status: "idle", data: null, error: null };
  const tree = await renderComponent("AgentReliabilityBreakages", {
    drawerAgent: agent, failureByAgent: new Map([[agent, row]]), failureState: { status: "ready", data: { rows: [] }, error: null },
    detailState: idle, blockedState: idle, days: 30, onRetry: () => undefined,
  });
  assert.match(collectText(findAtoms(tree, "Badge")[0]), /^8\s+failed or blocked\s+·\s+20\s*%/);
  assert.match(collectText(tree), /of which\s+5\s+blocked — a compliant halt, not a defect/);
});

test("with reconstructed rows present, the drawer's writer headline and its all-records figures each state their basis", async () => {
  const agent = "glass-atrium-dev-shell";
  const row = { fail_count: 3, blocked_count: 5, total_breakages: 8, breakage_rate: 0.2, reconstructed: 3 };
  const idle = { status: "idle", data: null, error: null };
  const tree = await renderComponent("AgentReliabilityBreakages", {
    drawerAgent: agent, failureByAgent: new Map([[agent, row]]), failureState: { status: "ready", data: { rows: [] }, error: null },
    detailState: idle, blockedState: idle, days: 30, onRetry: () => undefined,
  });
  const text = collectText(tree);

  assert.doesNotMatch(collectText(findAtoms(tree, "Badge")[0]), /%/, "the writer-basis badge carries no all-records rate");
  assert.match(text, /3\s+reconstructed, left out of this count/, "the headline names what it leaves out");
  assert.match(text, /All records,\s+3\s+reconstructed included ·\s+20\s*%\s+of outcomes\s*Failed\s*3\s*Blocked\s*5/, "the rate and the Failed/Blocked figures sit under their basis caption");
});

test("a top concern reads as plain text, without the stray punctuation a cut fragment starts with", async () => {
  const mod = await loadAgentsScreen();
  const getConcernText = mod.getConcernTextAg as (raw: string) => string;
  const rows = [
    { name: "a fragment cut after a bracket drops the stray closers", raw: "[]) on empty history with", text: "on empty history with" },
    { name: "a real opening bracket is kept", raw: "[Not Executed: live run]", text: "[Not Executed: live run]" },
    { name: "an opening backtick is kept", raw: "`path` missing", text: "`path` missing" },
    { name: "a leading separator a cut leaves is dropped", raw: ", then retried", text: "then retried" },
    { name: "a path keeps its own characters", raw: "agents/glass-atrium-dev-shell.md return EPERM", text: "agents/glass-atrium-dev-shell.md return EPERM" },
    { name: "runs of whitespace fold to one space", raw: "  gate   not\nrun ", text: "gate not run" },
  ];
  for (const row of rows) assert.equal(getConcernText(row.raw), row.text, row.name);
});

test("each review-flag reason in the day tooltip names the runs it counts over, since reasons are not a split of the flagged runs", async () => {
  const row = {
    fullDate: "2026-09-24", total_count: 20, review_flagged_count: 3, empty_metric_count: 5, polar_mismatch_count: 4,
    review_flag_ratio_pct: 15, empty_metric_ratio_pct: 25,
  };
  const tree = await renderComponent("QualityHealthTimelineTooltip", { active: true, payload: [{ payload: row }] });
  const text = collectText(tree).replace(/\s+/g, " ");
  assert.match(text, /No self-check 5 of 20 runs/, "the self-check count states its own denominator");
  assert.match(text, /Confidence mismatch 4 of 20 runs/, "the mismatch count states its own denominator");
});

test("a lifecycle row with no completion takes no focus and opens nothing, and the roving order skips it", async () => {
  const tree = await renderComponent("LifecycleStatsTable", {
    rows: [
      { agent_type: "glass-atrium-dev-shell", start_count: 4, stop_count: 0, completed_count: 0 },
      { agent_type: "glass-atrium-dev-react", start_count: 3, stop_count: 2, completed_count: 2 },
    ],
    onSelect: () => undefined,
  });
  const [unfinished, finished] = findNodes(tree, (n) => n.type === "tr" && String(n.props?.title ?? "").startsWith("glass-atrium-dev-"));
  assert.equal(unfinished?.props.tabIndex, undefined, "a row with nothing to open is not a Tab stop");
  assert.equal(unfinished?.props.onClick, undefined, "a row with nothing to open is not clickable");
  assert.equal(finished?.props["data-roving-row"], 0, "the roving order counts only rows that open the drawer");
  assert.equal(finished?.props.tabIndex, 0, "the first openable row holds the Tab stop");
});

test("the day tooltip heads its reasons with how many runs have one, the two reasons never sharing a run", async () => {
  const row = {
    fullDate: "2026-09-24", total_count: 20, review_flagged_count: 3, empty_metric_count: 5, polar_mismatch_count: 4,
    review_flag_ratio_pct: 15, empty_metric_ratio_pct: 25,
  };
  const tree = await renderComponent("QualityHealthTimelineTooltip", { active: true, payload: [{ payload: row }] });
  const text = collectText(tree).replace(/\s+/g, " ");
  assert.match(text, /9 of 20 have a recorded reason/, "a run with no self-check cannot also mismatch its confidence, so the reasons add up");
});

test("the No record and Unfinished counts state their definitions on the page, where the two cards that differ sit", async () => {
  const rows = [
    {
      name: "the ledger defines No record",
      component: "AgentSummaryCard",
      props: { state: { status: "ready", data: { agents: [], meta: { total_agents: 0 } }, error: null }, days: 30, onRetry: () => undefined },
      definition: /No record = launches − runs/,
      info: /Launches minus runs, from the agent summary/,
    },
    {
      name: "the lifecycle card defines Unfinished",
      component: "LifecycleStatsCard",
      props: {
        state: { status: "ready", data: { rows: [{ agent_type: "glass-atrium-dev-shell", start_count: 4, stop_count: 3, completed_count: 3 }] }, error: null },
        days: 30, onSelect: () => undefined, onRetry: () => undefined,
      },
      definition: /Unfinished = started − completed/,
      info: /SubagentStart events minus completed outcomes/,
    },
  ];
  for (const row of rows) {
    const tree = await renderComponent(row.component, row.props) as RenderedNode;
    const footText = findNodes(tree, (n) => n.props.foot != null).map((n) => collectText(renderScreen(n.props.foot))).join(" ");
    assert.match(`${collectText(tree)} ${footText}`.replace(/\s+/g, " "), row.definition, `${row.name}: short form on the page`);
    const infos = findNodes(tree, (n) => typeof n.props.info === "string").map((n) => String(n.props.info));
    assert.ok(infos.some((info) => row.info.test(info)), `${row.name}: full definition in the card's info drawer`);
  }
});

// More rows than the S slot holds, so each paired card has a remainder for its foot.
function getLifecycleRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ agent_type: `glass-atrium-dev-${i}`, start_count: 40 - i, stop_count: 4, completed_count: 3, p95_duration_sec: 60 }));
}

function getFailingRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    agent: `glass-atrium-dev-${i}`, task_type: "feature", event_date: "2026-09-01", total_count: 20, success_count: 10, failure_count: 10, reconstructed_count: 0,
  }));
}

describe("the paired failing-pairs and no-record cards keep the S row budget and roll the rest into the card foot", () => {
  const rows = [
    {
      name: "Most-failing pairs",
      component: "TopNFailingAgentsCard",
      props: { state: { status: "ready", data: { rows: getFailingRows(9) }, error: null }, days: 30, onRetry: () => undefined, failureByAgent: new Map() },
      total: 9,
    },
    {
      name: "No completion record",
      component: "LifecycleStatsCard",
      props: { state: { status: "ready", data: { rows: getLifecycleRows(12) }, error: null }, days: 30, onSelect: () => undefined, onRetry: () => undefined },
      total: 12,
    },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const tree = await renderComponent(row.component, row.props) as RenderedNode;
      const [card] = findAtoms(tree, "Card");
      assert.equal(card?.props.size, "S", "both peers take the S slot");
      const bodyRows = findNodes(card, (n) => n.type === "tr").slice(1);
      assert.equal(bodyRows.length, 5, "the body shows the S budget of five rows");
      const foot = collectText(renderScreen(card.props.foot));
      assert.match(foot, new RegExp(`Show all ${row.total}`), `foot: ${foot}`);
    });
  }
});

describe("the paired failing-pairs and no-record tables take the shared .tbl face and cell geometry", () => {
  const tokensOf = (node: RenderedNode): string[] => String(node.props.className ?? "").split(/\s+/).filter(Boolean);
  const isAdHocGeometry = (t: string) => /^-?(p|m)[xytblrse]?-/.test(t) || /^border-b$/.test(t) || t === "border-line";
  const pair = (task_type: string, successCount: number, rateDenominator: number) =>
    ({ agent: "glass-atrium-dev-node", task_type, successCount, rateDenominator, pooledRate: successCount / rateDenominator, totalCount: rateDenominator });
  const tables = [
    { name: "Most-failing pairs", component: "TopNFailingAgentsTable", props: { pairs: [pair("solid", 5, 10), pair("low", 1, 3)], failureByAgent: new Map(), days: 14 }, rightCols: 2 },
    { name: "No completion record", component: "LifecycleStatsTable", props: { rows: getLifecycleRows(2), onSelect: () => undefined }, rightCols: 4 },
  ];
  for (const row of tables) {
    test(`${row.name}: a sans .tbl table with a sticky head and cells that carry no padding, margin or rule of their own`, async () => {
      const tree = await renderComponent(row.component, row.props) as RenderedNode;
      const [table] = findNodes(tree, (n) => n.type === "table");
      assert.ok(tokensOf(table).includes("tbl"), `table: ${tokensOf(table)}`);
      assert.deepEqual(tokensOf(table).filter((t) => ["tbl--own-face", "font-mono"].includes(t)), [], "the body takes the shared sans face");
      assert.ok(findNodes(tree, (n) => n.type === "thead" && /\bis-sticky\b/.test(String(n.props.className ?? ""))).length === 1, "the head sticks");
      const heads = findColumnHeads(tree);
      assert.ok(heads.length >= 4, "every column header is the shared TableHead");
      for (const head of heads) {
        const tokens = tokensOf(head);
        assert.deepEqual(tokens.filter((t) => /^(uppercase|tracking-|font-mono)/.test(t)), [], `header in sentence case and sans: ${tokens}`);
        assert.deepEqual(tokens.filter(isAdHocGeometry), [], `header '${collectText(head).trim()}'`);
      }
      const cells = findNodes(tree, (n) => n.type === "td");
      assert.ok(cells.length > 0);
      for (const cell of cells) {
        assert.deepEqual(tokensOf(cell).filter(isAdHocGeometry), [], `cell '${collectText(cell).trim().slice(0, 24)}'`);
      }
      const [firstRow] = findNodes(tree, (n) => n.type === "tr").slice(1);
      const rightCells = findNodes(firstRow, (n) => n.type === "td").filter((td) => tokensOf(td).includes("num"));
      assert.equal(rightCells.length, row.rightCols, "numeric columns sit on the numeric cell atom");
    });
  }

  test("neither paired table takes a screen-local row-height class, and the screen CSS defines none", async () => {
    const screenCss = findNodes(await renderScreenAgents(), (n) => n.type === "style").map((n) => collectText(n)).join("\n");
    assert.ok(screenCss.trim().length > 0, "the screen renders its own style block");
    assert.doesNotMatch(screenCss, /ag-paired-tbl/, "the screen's style block defines no paired-table override");
    for (const row of tables) {
      const [table] = findNodes(await renderComponent(row.component, row.props) as RenderedNode, (n) => n.type === "table");
      assert.ok(!tokensOf(table).includes("ag-paired-tbl"), `${row.name}: the table takes no screen-local class`);
    }
  });

  const cards = [
    { name: "Most-failing pairs", component: "TopNFailingAgentsCard", ready: { rows: getFailingRows(3) }, extra: { failureByAgent: new Map() } },
    { name: "No completion record", component: "LifecycleStatsCard", ready: { rows: getLifecycleRows(3) }, extra: { onSelect: () => undefined } },
  ];
  for (const row of cards) {
    test(`${row.name}: the body is flush while its table renders and padded for loading and empty`, async () => {
      const flushOf = async (state: unknown) => {
        const tree = await renderComponent(row.component, { state, days: 30, onRetry: () => undefined, ...row.extra }) as RenderedNode;
        return findAtoms(tree, "Card")[0]?.props.isFlush;
      };
      assert.equal(await flushOf({ status: "ready", data: row.ready, error: null }), true, "table → flush");
      assert.equal(await flushOf(LOADING_STATE), false, "loading → padded");
      assert.equal(await flushOf({ status: "ready", data: { rows: [] }, error: null }), false, "empty → padded");
    });
  }
});

test("every status-band hint fits the 40-character KPI-hint cap", async () => {
  const ready = { status: "ready", data: [], error: null };
  const failureByAgent = new Map([0, 1].map((i) => [`glass-atrium-dev-${i}`, { fail_count: 1, blocked_count: 5, total_breakages: 6, breakage_rate: 0.1 }]));
  const agents = [{ agent_id: "a", runs: 11352, needs_context_count: 20 }];
  const mod = await loadAgentsScreen();
  const tiles = (mod.buildAgentStatusTiles as (s: Record<string, unknown>) => Array<{ label: string; sub: string }>)({
    days: 30, summaryState: getSummaryState(BREAKER_LOADED_ZERO, agents), failureState: ready, overageState: ready,
    failureByAgent, overageByAgent: new Map([["run-1", { overage_count: 1 }]]),
  });
  for (const tile of tiles) assert.ok(tile.sub.length <= 40, `${tile.label}: "${tile.sub}" is ${tile.sub.length} chars`);
});

test("the drawer names its agent in words for a screen reader, the hyphenated id staying visual only", async () => {
  const tree = await renderComponent("AgentDrawerNameAg", { name: "glass-atrium-dev-shell" }) as RenderedNode;
  const [spoken] = findNodes(tree, (n) => n.props?.className === "sr-only");
  const [hidden] = findNodes(tree, (n) => n.props?.["aria-hidden"] === "true");
  assert.equal(collectText(spoken).trim(), "dev shell", "the spoken name splits the id at its hyphens");
  assert.deepEqual(findAtoms(hidden, "AgentName").map((n) => n.props.name), ["glass-atrium-dev-shell"], "the shared atom still draws the id");
});

// --- Tone rides a glyph or an alert card, never a word, a numeral or a tinted shell ---

const TONE_TINT = /\b(?:bg|border)-(?:ok|warn|crit|info)\b|rgb\(var\(--(?:ok|warn|crit|info)\)\s*\/\s*0?\.\d+\)/;

function getTintedNodes(tree: RenderedNode | string | null): RenderedNode[] {
  return findNodes(tree, (n) => TONE_TINT.test(String(n.props?.className ?? "")) || TONE_TINT.test(JSON.stringify(n.props?.style ?? {})));
}

test("the compatibility requirement reads on a neutral sunken sub-card, not an info tint", async () => {
  const tree = await renderComponent("CompatibilityDetailBlock", { compatibility: "monitor daemon running" });
  const [card] = findAtoms(tree, "SubCard");
  assert.equal(card?.props.sunken, true, "the requirement sits on the sunken sub-card");
  assert.match(collectText(card), /monitor daemon running/);
  assert.deepEqual(getTintedNodes(tree), [], "no tone tint on an explanation block");
});

test("the delete panel states its warning and its failure as inset alert cards, the failure titled and the cause in the body", async () => {
  const rows: Array<{ name: string; error: string | null; cards: Array<{ tone: string; title: string; body?: string }> }> = [
    { name: "before a failure", error: null, cards: [{ tone: "warn", title: "This removes a real agent." }] },
    {
      name: "after a failure", error: "HTTP 500 — busy",
      cards: [{ tone: "warn", title: "This removes a real agent." }, { tone: "crit", title: "Delete failed.", body: "HTTP 500 — busy" }],
    },
  ];
  for (const row of rows) {
    const tree = await renderComponent("AgentDeleteConfirmPanel", { agentName: "dev-react", value: "", committing: false, error: row.error, onChange: () => undefined });
    const cards = findAtoms(tree, "AlertCard");
    assert.deepEqual(cards.map((card) => card.props.tone), row.cards.map((card) => card.tone), `${row.name}: one alert card per message`);
    row.cards.forEach((expected, i) => {
      assert.equal(cards[i]?.props.surface, "inset", `${row.name}: ${expected.tone} card sits inset in the drawer`);
      assert.equal(collectText(renderScreen(cards[i]?.props.title)), expected.title, `${row.name}: ${expected.tone} title`);
      if (expected.body) assert.equal(collectText(renderScreen(cards[i]?.props.body)), expected.body, `${row.name}: the cause rides the body`);
    });
    assert.deepEqual(getTintedNodes(tree), [], `${row.name}: no tinted shell beside the cards`);
  }
});

test("a drawer activity row and the drawer empty note draw no box", async () => {
  const BOX_CLASS = /(^|\s)(rounded(-[a-z]+)?|border(-dashed)?)(\s|$)/;
  const rows = [
    { name: "activity row", atom: "RecentActivityRow", props: { row: { result: "done", task_type: "feature", confidence: "high", revision_count: 0, record_ts: "2026-10-04T00:00:00Z" } } },
    { name: "empty note", atom: "DrawerSectionEmpty", props: { message: "No outcomes recorded for this agent." } },
  ];
  for (const row of rows) {
    const tree = await renderComponent(row.atom, row.props);
    const boxed = findNodes(tree, (n) => BOX_CLASS.test(String(n.props?.className ?? "")));
    assert.deepEqual(boxed.map((n) => n.props.className), [], `${row.name}: no bordered or rounded box`);
    assert.ok(collectText(tree).trim().length > 0, `${row.name}: still renders its content`);
  }
});

test("an unidentified agent reads its label dim in upright type, the row at full opacity", async () => {
  const rows = [
    { name: "ledger row", atom: "AgentSummaryRow", props: { agent: { agent_id: "unknown", agent_name: "unknown", status: "active", runs: 12 }, days: 30, isSelected: false, onSelect: () => {}, trend: null, failure: null, overage: null } },
    { name: "task-type matrix row", atom: "SuccessRateMatrixRow", props: { agent: "unknown", cells: {} } },
    { name: "off-target row", atom: "SuccessRateOffTargetRow", props: { agent: "unknown", pairs: [] } },
  ];
  for (const row of rows) {
    const tree = await renderComponent(row.atom, row.props);
    const label = findNodes(tree, (n) => collectText(n).trim() === "Unidentified (old)" && typeof n.props?.className === "string").at(-1); // innermost node holding the label
    assert.ok(label, `${row.name}: renders the unidentified label`);
    assert.match(String(label.props.className), /\btext-dim\b/, `${row.name}: label in dim ink`);
    assert.doesNotMatch(String(label.props.className), /\bitalic\b/, `${row.name}: label upright`);
    const faded = findNodes(tree, (n) => (n.props?.style as Record<string, unknown> | undefined)?.opacity != null);
    assert.deepEqual(faded.map((n) => n.type), [], `${row.name}: no faded row hides its numbers`);
  }
});

test("a machine string reads through the mono atom and every other agents string in sans, sentence case and upright", async () => {
  const TYPE_TROPE = /(^|\s)(font-mono|uppercase|italic|tracking-[a-z]+)(\s|$)/;
  const rows = [
    { name: "drawer activity row", atom: "RecentActivityRow", props: { row: { result: "done", task_type: "feature", confidence: "high", revision_count: 2, record_ts: "2026-10-04T00:00:00Z" } }, machine: ["feature"] },
    { name: "failure-cause split", atom: "MergedBreakageBody", props: { merged: { total: 5, failTotal: 3, blockedTotal: 2, reasons: [{ category: "timeout", count: 5, failCount: 3, blockedCount: 2 }] }, days: 30 }, machine: ["timeout"] },
    { name: "delete confirm", atom: "AgentDeleteConfirmPanel", props: { agentName: "glass-atrium-dev-node", value: "", committing: false, error: null, onChange: () => {} }, machine: ["glass-atrium-dev-node"] },
    { name: "drawer metric", atom: "DetailMetric", props: { label: "Runs", value: "1,284" }, machine: [] },
    { name: "drawer info row", atom: "DrawerInfoRow", props: { label: "last active", value: "3h ago" }, machine: [] },
    { name: "latency bars", atom: "LatencyBars", props: { agents: [{ agent_id: "glass-atrium-dev-node", agent_name: "glass-atrium-dev-node", p50_ms: 1_000, p95_ms: 2_000, p99_ms: 3_000 }] }, machine: [] },
    { name: "breaker alarm row", atom: "AgentAlarmRow", props: { alarm: { agent: "glass-atrium-dev-node", consecutive_fails: 3, suspended_at: null } }, machine: [] },
  ];
  for (const row of rows) {
    const tree = await renderComponent(row.atom, row.props);
    const tropes = findNodes(tree, (n) => TYPE_TROPE.test(String(n.props?.className ?? "")));
    assert.deepEqual(tropes.map((n) => n.props.className), [], `${row.name}: no mono, caps, tracking or italic class`);
    const machine = [...new Set(findAtoms(tree, "MachineString").map((n) => collectText(n).trim()))];
    assert.deepEqual(machine, row.machine, `${row.name}: machine strings on the atom`);
  }
});

test("a run's rework count reads in the row meta tier, its warn tone on a glyph alone", async () => {
  const rows = [
    { name: "a reworked run", revision_count: 2, hasMark: true },
    { name: "a first-try run", revision_count: 0, hasMark: false },
  ];
  for (const row of rows) {
    const tree = await renderComponent("RecentActivityRow", {
      row: { result: "done", task_type: "feature", confidence: "high", revision_count: row.revision_count, record_ts: "2026-10-04T00:00:00Z" },
    });
    const [mark] = findNodes(tree, (n) => n.props?.title === "revision_count");
    assert.equal(Boolean(mark), row.hasMark, `${row.name}: rework mark shown`);
    if (!mark) continue;
    assert.match(collectText(mark), /rev\s+2/);
    const toned = findNodes(mark, (n) => /\btext-warn\b/.test(String(n.props?.className ?? "")));
    assert.equal(toned.length, 1, `${row.name}: one toned node`);
    assert.equal(toned[0]?.props["aria-hidden"], "true", `${row.name}: the tone sits on the decorative glyph`);
    assert.equal(collectText(toned[0]).trim(), "", `${row.name}: no word or numeral inside the tone`);
  }
});

test("the failure-cause split tones its icons only, never its words or counts", async () => {
  const merged = { total: 5, failTotal: 3, blockedTotal: 2, reasons: [{ category: "timeout", count: 5, failCount: 3, blockedCount: 2 }] };
  const tree = await renderComponent("MergedBreakageBody", { merged, days: 30 });
  const text = collectText(tree).replace(/\s+/g, " ");
  assert.match(text, /fail 3/);
  assert.match(text, /blocked 2/);
  const toned = findNodes(tree, (n) => /\btext-(?:crit|info)\b/.test(String(n.props?.className ?? "")));
  assert.equal(toned.length, 2, "one toned node per split term");
  for (const node of toned) assert.equal(collectText(node).trim(), "", "the tone wraps the icon, never the word or count");
});

test("an empty failure-cause window reads as the shared empty state with no tone border", async () => {
  const empty = await renderComponent("MergedBreakageBody", { merged: { total: 0, failTotal: 0, blockedTotal: 0, reasons: [] }, days: 30 });
  const [state] = findAtoms(empty, "EmptyState");
  assert.match(String(state?.props.message ?? ""), /No failed or blocked tasks in the last 30 days/);
  assert.deepEqual(getTintedNodes(empty), [], "an empty state carries no tone border");
});

test("the day tooltip floats on the overlay surface and keys the flagged rate by its line swatch beside neutral text", async () => {
  const row = {
    fullDate: "2026-09-24", total_count: 20, review_flagged_count: 3, empty_metric_count: 5, polar_mismatch_count: 4,
    review_flag_ratio_pct: 15, empty_metric_ratio_pct: 25,
  };
  const tree = await renderComponent("QualityHealthTimelineTooltip", { active: true, payload: [{ payload: row }] });
  const [root] = findNodes(tree, (n) => n.type === "div");
  const rootStyle = root?.props.style as Record<string, unknown>;
  assert.equal(rootStyle.background, "rgb(var(--overlay-surface))", "an opaque overlay surface");
  assert.equal(rootStyle.boxShadow, "var(--shadow-overlay)", "the overlay shadow token");
  assert.equal(rootStyle.borderRadius, "var(--radius-tile)", "the tile radius token");
  const [flagged] = findNodes(tree, (n) => n.type === "div" && /^Flagged rate/.test(collectText(n).trim()));
  assert.doesNotMatch(String((flagged?.props.style as Record<string, unknown> | undefined)?.color ?? ""), /--crit/, "the rate words stay neutral");
  const swatches = findNodes(flagged, (n) => n.type === "span" && /--ink/.test(JSON.stringify(n.props.style ?? {})));
  assert.equal(swatches.length, 1, "the ink of the rate line rides the series swatch");
  assert.match(JSON.stringify(swatches[0]?.props.style), /solid/, "the swatch draws the solid series line");
  assert.deepEqual(getToneOrAccentPaints(tree), [], "the reason keys show the bar's data colour, never a tone or the accent");
});

test("the review-flag chart's tooltip follows the pointer without motion, like its series", async () => {
  const tree = await renderComponent("QualityHealthTimelineChart", { rows: REVIEW_FLAG_ROWS });
  const tooltips = findAtoms(tree, "Tooltip");
  assert.equal(tooltips.length, 1);
  for (const tooltip of tooltips) assert.equal(tooltip.props.isAnimationActive, false);
});

// a transition or animation utility runs only under motion-safe, and a state transition takes the 120ms state timing
function getMotionGateGaps(tree: RenderedNode | string | null): string[] {
  return findNodes(tree, (n) => typeof n.props?.className === "string").flatMap((n) => {
    const tokens = String(n.props.className).split(/\s+/);
    const ungated = tokens.filter((t) => /^(?:transition|animate-|duration-)/.test(t)).map((t) => `ungated ${t}`);
    const isTransitioning = tokens.some((t) => /^motion-safe:transition/.test(t));
    const isTimed = tokens.includes("motion-safe:duration-[120ms]");
    return isTransitioning && !isTimed ? [...ungated, `untimed ${n.props.className}`] : ungated;
  });
}

test("an openable lifecycle row eases its hover fill at the 120ms state timing, and only when motion is allowed", async () => {
  const tree = await renderComponent("LifecycleStatsTable", {
    rows: [{ agent_type: "glass-atrium-dev-react", start_count: 3, stop_count: 2, completed_count: 2 }],
    onSelect: () => undefined,
  });
  const [row] = findNodes(tree, (n) => n.type === "tr" && String(n.props?.title ?? "").startsWith("glass-atrium-dev-react"));
  assert.match(String(row?.props.className), /\bhover:bg-sunken\b/, "the row keeps its hover fill");
  assert.deepEqual(getMotionGateGaps(tree), []);
});
