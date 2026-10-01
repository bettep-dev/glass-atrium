// Element-tree behaviour tests for the Agents screen, closing the plan's standing
// decision that screen behaviour is proved against a render harness. Exercises the
// shipped JSX through test/lib/render-screen.ts — no DOM, no react-dom, no DB.
//
// Runner: npx tsx --test test/agents.screen-render.client.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
  TONE_ICON: new Proxy({}, { get: () => "dot" }),
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
const REGION_MEMBERS = ["INITIAL_REGION_STATE", "getRegionView", "getRegionSummary", "getSharedFailure", "getSourceFailures", "putRegionRequest", "putRegionData", "putRegionFailure", "getRowFocusProps", "ROW_CONTROL_PROPS"];
for (const name of REGION_MEMBERS) UI_SCALARS[name] = REAL_UI[name];
// Count text rides the shipped formatter, so a KPI sub reads as it does on the page.
UI_SCALARS.formatInt = REAL_UI.formatInt;
// The page verdict rolls tones up and names agents with the shipped helpers.
UI_SCALARS.getWorstTone = REAL_UI.getWorstTone;
UI_SCALARS.getAgentDisplayName = REAL_UI.getAgentDisplayName;
// Recharts charts take their image name and edge tick from the shipped chart helpers.
UI_SCALARS.getChartImageProps = REAL_UI.getChartImageProps;
UI_SCALARS.ChartAxisTick = REAL_UI.ChartAxisTick;
UI_SCALARS.getChartXAxisProps = REAL_UI.getChartXAxisProps;
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

  const [card] = findNodes(tree, (n) => /\bcard\b/.test(classOf(n)) && !/card-body/.test(classOf(n)));
  assert.match(classOf(card), /\bmin-w-0\b/, "a wide ledger cannot widen the page grid");
  const [body] = findNodes(tree, (n) => /card-body flush/.test(classOf(n)));
  assert.equal((body.props.style as Record<string, unknown>)?.maxHeight, "none", "no card-body height cap on the ledger");
  const [scroller] = findNodes(tree, (n) => /agent-table-minibars/.test(classOf(n)));
  assert.match(classOf(scroller), /\boverflow-x-auto\b/, "wide columns scroll inside the card");
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
    threshold: number,
    limit: number,
  ) => { failingPairs: unknown[]; measuredPairs: number };

  const row = (agent: string, task: string, date: string, ok: number, fail: number) => ({
    agent, task_type: task, event_date: date,
    total_count: ok + fail, success_count: ok, failure_count: fail, reconstructed_count: 0,
  });
  // One pair split across three days must measure the same as the identical pair on one day.
  const split = [row("a", "feature", "2026-09-01", 2, 4), row("a", "feature", "2026-09-02", 2, 4), row("a", "feature", "2026-09-03", 2, 4)];
  const single = [row("a", "feature", "2026-09-01", 6, 12)];

  const splitOut = buildTopNFailing(split, 0.95, 5);
  const singleOut = buildTopNFailing(single, 0.95, 5);
  assert.equal(splitOut.measuredPairs, singleOut.measuredPairs);
  assert.equal(splitOut.measuredPairs, 1);
  assert.equal(splitOut.failingPairs.length, 1);

  // A second pair adds exactly one to the denominator, whatever its row count.
  const two = [...split, row("b", "review", "2026-09-01", 30, 0)];
  assert.equal(buildTopNFailing(two, 0.95, 5).measuredPairs, 2);
  assert.equal(buildTopNFailing([], 0.95, 5).measuredPairs, 0);
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

function getValueTexts(tree: RenderedNode | string | null): string[] {
  return findNodes(tree, (n) => n.props.atom === "KpiValue").map((n) => collectText(n));
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
    const targets = findNodes(band, (n) => n.type === "div" && n.props.id === card.props.focusTargetId);
    assert.equal(targets.length, 1, `tile focus target ${String(card.props.focusTargetId)} is the tile's own card`);
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
  assert.deepEqual(getValueTexts(loadedZero), ["0"], "the count rides the KPI value scale");
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
  const appSource = await readFile(resolve(__dirname, "../public/src/app.jsx"), "utf8");
  const navBlock = appSource.slice(appSource.indexOf("const NAV = ["), appSource.indexOf("];", appSource.indexOf("const NAV = [")));
  const navIds = new Set(Array.from(navBlock.matchAll(/\bid: "([^"]+)"/g), (m) => m[1]));
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
  const headers = findAtoms(table, "TableHead").map((n) => collectText(n));
  assert.ok(headers.includes("Failed or blocked"), `ledger headers: ${headers.join(" | ")}`);
  assert.ok(!headers.includes("Breakages"));

  const card = renderScreen(
    React.createElement(mod.LifecycleStatsCard as Component, { state: { status: "loading" }, days: 30, onSelect: () => {}, onRetry: () => {} }),
  );
  const cardHead = findNodes(card, (n) => n.props?.atom === "CardHead")[0];
  assert.equal(cardHead?.props.title, "No completion record");
});

test("the page header renders every title as the page h1 with the sub-line under it", async () => {
  const ui = await loadScreenModule(resolve(__dirname, "../public/src/ui.jsx"));
  const React = ui.React as { createElement: (t: unknown, p: unknown) => unknown };
  const PageHeader = ui.PageHeader as Component;

  const titled = renderScreen(React.createElement(PageHeader, { title: "Agents", sub: "Triage — who is unsafe" }));
  const heading = findNodes(titled, (n) => n.type === "h1")[0];
  assert.equal(heading && collectText(heading), "Agents");
  assert.ok(collectText(titled).indexOf("Agents") < collectText(titled).indexOf("Triage"), "the sub-line sits under the title");

  const echoed = renderScreen(React.createElement(PageHeader, { title: "Models & budgets", sub: "Models & budgets" }));
  assert.equal(collectText(echoed), "Models & budgets", "a sub-line repeating the title is not rendered twice");

  const src = await import("node:fs").then((fs) => fs.readFileSync(AGENTS_SRC, "utf8"));
  assert.doesNotMatch(src, /shouldRenderTitle/, "the retired opt-in is gone from the Agents screen");
});

const HIGH_FAIL_WORD = "high failure share";

test("the summary row marks the shared crit step from its own failed share, and only on an adequate sample", async () => {
  const mod = await loadAgentsScreen();
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
        days: 30, isSelected: false, onSelect: () => {}, trend: null, failure: null, overage: null,
      }),
    );
    assert.equal(collectText(tree).includes(HIGH_FAIL_WORD), c.crit, c.why);
    const toned = findNodes(tree, (n) => /\btext-(ok|warn)\b/.test(String(n.props?.className ?? "")));
    assert.equal(toned.length, 0, `${c.why}: the success numeral carries no second scale`);
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
  }
});

test("Agents keeps one rate scale — the retired thresholds and the hardcoded trend band are gone", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(AGENTS_SRC, "utf8");
  for (const name of ["SUMMARY_SUCCESS_OK_PCT", "SUMMARY_SUCCESS_WARN_PCT", "SUCCESS_RATE_OK_THRESHOLD", "SUCCESS_RATE_WARN_THRESHOLD", "successRateTone"]) {
    assert.equal(source.includes(name), false, `${name} is retired`);
  }
  assert.doesNotMatch(source, /successPct\s*<\s*90/, "trendBarColor no longer carries its own 90% band");
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
  const labels = ["Unsafe to route", "Failed", "Over tool-use cap", "Needs context"];
  const tiles = labels.map((label) => findNodes(tree, (n) => n.type === "div" && collectText(n).startsWith(label))
    .filter((n) => labels.every((other) => other === label || !collectText(n).includes(other)))[0]);
  assert.match(collectText(tiles[0]), /\bnow\b/, "breaker state is current, not windowed");
  for (const tile of tiles.slice(1)) {
    assert.match(collectText(tile), /last 14d/);
  }
});

test("the ledger opens sorted by breakages, riskiest agents first", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(AGENTS_SRC, "utf8");
  assert.match(source, /\[sortBy, setSortBy\] = useStateAg\('failures'\)/);
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

test("an unread breakage or trend payload shows 'not loaded', and only a loaded zero keeps the dash", async () => {
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
    assert.equal(failText === "—", row.failureStatus === "ready", `${row.name}: the dash means a read zero only`);
  }
});

function renderSortedBody(mod: Record<string, unknown>, failureStatus: string): string[] {
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const agents = [
    { agent_id: "glass-atrium-dev-busy", agent_name: "busy", status: "active", runs: 90 },
    { agent_id: "glass-atrium-dev-risky", agent_name: "risky", status: "active", runs: 10 },
  ];
  const failureByAgent = new Map([["glass-atrium-dev-risky", { total_breakages: 7, fail_count: 7, blocked_count: 0, breakage_rate: 0.7 }]]);
  const tree = renderScreen(
    React.createElement(mod.AgentSummaryBody as Component, {
      state: { status: "ready", data: { agents }, error: null },
      days: 30, sortBy: "failures", onSortChange: () => {}, selectedAgent: null, onSelect: () => {}, onRetry: () => {},
      trendByAgent: new Map(), failureByAgent, overageByAgent: new Map(), failureStatus, trendStatus: "ready",
    }),
  );
  const order = findNodes(tree, (n) => n.type === "AgentSummaryRow").map((n) => String((n.props.agent as { agent_id: string }).agent_id));
  const note = findNodes(tree, (n) => n.props?.role === "status").map((n) => collectText(n)).join(" ");
  return [...order, `note:${note}`];
}

test("the breakage sort orders by breakages only once they are read, and says so while they are not", async () => {
  const mod = await loadAgentsScreen();
  const [readFirst, , readNote] = renderSortedBody(mod, "ready");
  assert.equal(readFirst, "glass-atrium-dev-risky", "read breakages put the riskiest agent first");
  assert.equal(readNote, "note:", "a read sort carries no caveat");

  for (const status of ["loading", "error"]) {
    const [first, , note] = renderSortedBody(mod, status);
    assert.equal(first, "glass-atrium-dev-busy", `${status}: unread breakages fall back to run order`);
    assert.match(note, /breakages not loaded/i, `${status}: the fallback order is announced`);
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

test("the header's Refresh and freshness stamp read every region, so a first load is never announced as fresh", async () => {
  const [header] = findAtoms(await renderScreenAgents(), "PageHeader");
  // The stub header keeps its right-hand slot as a prop, so render that slot on its own.
  const tree = renderScreen(header.props.right);
  const [refresh] = findAtoms(tree, "RefreshButton");
  assert.equal(refresh?.props.isBusy, true, "a region in flight keeps Refresh busy");
  assert.equal(refresh?.props.hasRead, false, "before the first read Refresh says it is loading, not refreshing");
  const [stamp] = findAtoms(tree, "FreshnessStamp");
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

test("the task-type matrix scroller is a named tab stop, so a keyboard reaches the columns it clips", async () => {
  const tree = await renderComponent("SuccessRateMatrixTable", { matrix: { agents: [], cells: {} } });
  const [scroller] = findNodes(tree, (n) => /overflow-x-auto/.test(String(n.props?.className ?? "")));
  assert.equal(scroller?.props.tabIndex, 0);
  assert.equal(scroller?.props.role, "region");
  assert.match(String(scroller?.props["aria-label"]), /success rate/i);
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

test("the breakage count takes a tone only once its share of the agent's outcomes crosses the shared crit step", async () => {
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
    const tonedClasses = findNodes(cell, (n) => TONED_CLASS.test(String(n.props?.className ?? ""))).map((n) => String(n.props.className));
    assert.deepEqual(tonedClasses, row.crit ? ["text-crit"] : [], `${row.name}: numeral tone`);
    const bar = findNodes(cell, (n) => n.props?.atom === "Bar")[0];
    assert.equal(bar?.props.tone, row.crit ? "crit" : "neutral", `${row.name}: bar tone follows the numeral`);
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

test("a P95 numeral is coloured only past the crit cut, and the glyph keeps every tier while amber stays off the routine warn tier", async () => {
  const mod = await loadAgentsScreen();
  const rows = [
    { name: "fast tier", p95_ms: 300_000, numeral: [] as string[], glyph: "text-ok" },
    { name: "warn tier, the bulk of live agents", p95_ms: 900_000, numeral: [] as string[], glyph: "text-dim" },
    { name: "crit tier", p95_ms: 1_500_000, numeral: ["text-crit"], glyph: "text-crit" },
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

test("a failing pair keeps its failure tint at any sample, and a small sample carries the shared low-sample mark instead of grey italics", async () => {
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
    assert.ok(String(style.color ?? "").includes("--crit"), `${row.name}: rate text keeps the failure tint`);
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
  const headers = findAtoms(table, "TableHead").map((n) => collectText(n));
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

test("a compatibility requirement rides a short row tag with the full text on hover, never a truncated sentence", async () => {
  const mod = await loadAgentsScreen();
  const requirement = "Requires monitor running at http://127.0.0.1:16145 with a live daemon";
  const tree = renderToneRow(mod, { compatibility: requirement }, null);
  const badge = findNodes(tree, (n) => n.props?.atom === "Badge")[0];
  assert.equal(badge?.props.title, `Requires: ${requirement}`);
  assert.doesNotMatch(collectText(badge), /…/);
});

const FS_MICRO = /\bfs-micro\b/;

test("the Agents page never renders text below the 12px meta step", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const trees = [
    renderLedger(mod),
    renderLoadRow(mod, "error", "error"),
    renderScreen(React.createElement(mod.AgentDisclosure as Component, { title: "By task type", sub: "Success rate" })),
    renderScreen(React.createElement(mod.AgentStatusTile as Component, { label: "Failed or blocked", sub: "last 30 days", status: "ready", value: 3 })),
  ];
  for (const tree of trees) {
    const micro = findNodes(tree, (n) => FS_MICRO.test(String(n.props?.className ?? "")));
    assert.equal(micro.length, 0, micro.map((n) => collectText(n)).join(" | "));
  }
});

function getMatrixRow(agent: string, success: number, failure: number): Record<string, unknown> {
  const total = success + failure;
  return { agent, task_type: "feature", event_date: "2026-01-01", total_count: total, success_count: success, failure_count: failure, success_rate: success / total };
}

const TASK_TYPE_FOLD_ROWS = [
  { name: "a crit pair opens the fold", rows: [getMatrixRow("a", 19, 1), getMatrixRow("b", 40, 0)], tone: "crit", isOpen: true },
  { name: "every pair under the step keeps it closed", rows: [getMatrixRow("a", 39, 1), getMatrixRow("b", 40, 0)], tone: "ok", isOpen: false },
  { name: "a failing small sample stays under the low-N floor and keeps it closed", rows: [getMatrixRow("a", 2, 1)], tone: "ok", isOpen: false },
];

describe("the By task type fold takes its tone from its worst pair", () => {
  for (const row of TASK_TYPE_FOLD_ROWS) {
    test(row.name, async () => {
      const tree = await renderComponent("TaskTypeFold", { state: { status: "ready", data: { rows: row.rows }, error: null }, days: 30, onRetry: () => undefined });
      const [fold] = findAtoms(tree, "Disclosure");
      assert.ok(fold, "the fold is the shared Disclosure");
      assert.equal(fold.props.title, "By task type");
      assert.equal(fold.props.tone, row.tone);
      const getDisclosureOpen = REAL_UI.getDisclosureOpen as (kind: string, tone: unknown) => boolean;
      assert.equal(getDisclosureOpen(String(fold.props.kind ?? "detail"), fold.props.tone), row.isOpen);
    });
  }

  test("an unread matrix gives the fold no tone", async () => {
    const tree = await renderComponent("TaskTypeFold", { state: LOADING_STATE, days: 30, onRetry: () => undefined });
    const [fold] = findAtoms(tree, "Disclosure");
    assert.ok(fold, "the fold renders while the matrix loads");
    assert.equal(fold.props.tone, undefined);
  });
});

test("the matrix grows with the page instead of a nested vertical scroller that clips a row", async () => {
  const tree = await renderComponent("SuccessRateMatrixCard", { state: { status: "ready", data: { rows: [getMatrixRow("a", 9, 1)] }, error: null }, days: 30, onRetry: () => undefined });
  const classOf = (n: RenderedNode) => String(n.props.className ?? "");
  const [body] = findNodes(tree, (n) => /\bcard-body\b/.test(classOf(n)));
  assert.equal((body.props.style as Record<string, unknown>)?.maxHeight, "none", "no card-body height cap on the matrix");
  const verticalScrollers = findNodes(tree, (n) => /\boverflow-(auto|y-auto|hidden)\b/.test(classOf(n)) || /\bag-card-body\b/.test(classOf(n)));
  assert.deepEqual(verticalScrollers.map(classOf), [], "nothing inside the matrix scrolls or clips vertically");
  assert.ok(findNodes(tree, (n) => /\boverflow-x-auto\b/.test(classOf(n))).length === 1, "wide columns scroll sideways inside the card");
});

test("the ledger carries Runs and No record as columns instead of a per-row expander", async () => {
  const mod = await loadAgentsScreen({ formatInt: REAL_UI.formatInt });
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const rows = [
    { name: "launches past runs leave that many without a record", invocations: 50, noRecord: "10" },
    { name: "unmeasured launches read as a dash", invocations: null, noRecord: "—" },
    { name: "fewer launches than runs never go negative", invocations: 30, noRecord: "0" },
  ];
  const agents = rows.map((row, i) => ({ ...LEDGER_AGENTS[0], agent_id: `glass-atrium-dev-${i}`, runs: 40, invocations: row.invocations }));
  const tree = renderScreen(
    React.createElement(mod.AgentSummaryTable as Component, {
      agents, pseudoAgents: [], days: 30, selectedAgent: null, onSelect: () => {},
      trendByAgent: null, failureByAgent: null, overageByAgent: null, failureStatus: "ready", trendStatus: "ready",
    }),
  );
  const headers = findAtoms(tree, "TableHead").map((n) => collectText(n));
  assert.ok(headers.includes("Runs") && headers.includes("No record"), `ledger headers: ${headers.join(" | ")}`);
  assert.equal(findAtoms(tree, "DisclosureChevron").length, 0, "no per-row expander");
  const cells = findNodes(tree, (n) => n.type === "td" && /^no completion record/.test(String(n.props?.title ?? "")));
  rows.forEach((row, i) => assert.equal(collectText(cells[i]), row.noRecord, row.name));
});

test("a ledger row leads with its failed count and keeps blocked as an untoned secondary", async () => {
  const mod = await loadAgentsScreen({ formatInt: REAL_UI.formatInt });
  // 1 fail + 29 blocked of 100 outcomes: a 30% breakage rate, but a 1% failed share.
  const failure = { total_breakages: 30, fail_count: 1, blocked_count: 29, breakage_rate: 0.3 };
  const cell = findCellByTitle(renderToneRow(mod, {}, failure), /^breakages/);
  const text = collectText(cell);
  assert.match(text, /^1/, "the failed count leads");
  assert.match(text, /29\s+blocked/, "blocked rides as the secondary");
  const tonedClasses = findNodes(cell, (n) => TONED_CLASS.test(String(n.props?.className ?? "")));
  assert.equal(tonedClasses.length, 0, "compliant halts do not raise the failure tone");
});

test("the status band counts failed agents in red and carries blocked-only agents as a neutral note", async () => {
  const ready = { status: "ready", data: [], error: null };
  const rows = [
    { name: "a failing agent turns the tile red", fails: [1, 0], value: 1, tone: "crit" },
    { name: "blocked-only agents keep the tile calm", fails: [0, 0], value: 0, tone: "ok" },
  ];
  for (const row of rows) {
    const failureByAgent = new Map(row.fails.map((fail, i) => [`glass-atrium-dev-${i}`, { fail_count: fail, blocked_count: 5, total_breakages: fail + 5, breakage_rate: 0.1 }]));
    const tree = await renderStatusBand({
      days: 14, summaryState: getSummaryState(BREAKER_LOADED_ZERO), failureState: ready, overageState: ready,
      failureByAgent, overageByAgent: new Map(), onRetry: () => undefined,
    });
    const tile = findNodes(tree, (n) => n.type === "div" && collectText(n).startsWith("Failed") && !collectText(n).includes("Unsafe"))[0];
    const value = findAtoms(tile, "KpiValue")[0];
    assert.equal(value?.props.tone, row.tone, `${row.name}: tone`);
    assert.equal(collectText(value), String(row.value), `${row.name}: value`);
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
  for (const card of ["TopNFailingAgentsCard", "LifecycleStatsCard"]) {
    assert.equal(findNodes(split, (n) => n.type === card).length, 1, `${card} inside the split`);
  }
});

test("the instrumentation verdict names only what has loaded, and warns on unfinished runs", async () => {
  const mod = await loadAgentsScreen({ formatInt: REAL_UI.formatInt });
  const verdict = mod.getInstrumentationVerdict as (l: unknown, r: unknown) => { tone: string; sub: string };
  const lifecycle = (start: number, done: number) => ({ status: "ready", data: { rows: [{ agent_type: "a", start_count: start, completed_count: done }] } });
  const review = { status: "ready", data: { rows: [{ review_flagged_count: 14, total_count: 100 }] } };
  const loading = { status: "loading" };
  const rows = [
    { name: "unfinished runs warn", l: lifecycle(20, 8), r: review, tone: "warn", sub: "12 runs with no completion record · 14.0% flagged" },
    { name: "every run finished", l: lifecycle(8, 8), r: review, tone: "ok", sub: "0 runs with no completion record · 14.0% flagged" },
    { name: "only review flags read", l: loading, r: review, tone: "neutral", sub: "14.0% flagged" },
    { name: "nothing read yet", l: loading, r: loading, tone: "neutral", sub: "Is the measuring apparatus intact" },
  ];
  for (const row of rows) assert.deepEqual({ ...verdict(row.l, row.r) }, { tone: row.tone, sub: row.sub }, row.name);
});

test("every ledger and pairs column header comes from the shared header atom", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const pairs = renderScreen(React.createElement(mod.TopNFailingAgentsTable as Component, { pairs: [], failureByAgent: new Map(), days: 14 }));
  for (const [name, tree] of [["ledger", renderLedger(mod)], ["pairs", pairs]] as const) {
    assert.equal(findNodes(tree, (n) => n.type === "th").length, 0, `${name}: no hand-rolled th`);
    assert.ok(findAtoms(tree, "TableHead").length > 0, `${name}: TableHead columns`);
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
    const cardHead = findAtoms(tree, "CardHead")[0];
    assert.equal(cardHead?.props.title, "Review flags", row.name);
    assert.match(String(cardHead?.props.sub), /30 days/, row.name);
  }
});

function findCaption(tree: RenderedNode | string | null, text: string): RenderedNode | undefined {
  return findNodes(tree, (n) => typeof n.type === "string" && collectText(n) === text).at(-1);
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

test("review-flag chart dates take the shared day-axis tick, end-keeping interval and label gap, and its value axes stay at or above the 12px floor", async () => {
  const tree = await renderComponent("QualityHealthTimelineChart", { rows: REVIEW_FLAG_ROWS });
  const [dateAxis] = findAtoms(tree, "XAxis");
  const getDayAxisProps = REAL_UI.getChartXAxisProps as (labels: string[]) => Record<string, unknown>;
  const expected = getDayAxisProps(REVIEW_FLAG_ROWS.map((row) => row.date));
  for (const key of ["tick", "interval", "minTickGap"]) {
    assert.equal(dateAxis?.props[key], expected[key], `date axis ${key}`);
  }
  const valueAxes = findAtoms(tree, "YAxis");
  assert.equal(valueAxes.length, 2);
  for (const axis of valueAxes) {
    const tick = axis.props.tick as { fontSize: number };
    const label = axis.props.label as { fontSize: number } | undefined;
    assert.ok(tick.fontSize >= 12, `tick ${tick.fontSize}px`);
    if (label) assert.ok(label.fontSize >= 12, `label ${label.fontSize}px`);
  }
});

test("review-flag chart is a focusable image named by the flagged-rate range, latest, low and high", async () => {
  const tree = await renderComponent("QualityHealthTimelineChart", { rows: REVIEW_FLAG_ROWS });
  const [image] = findNodes(tree, (n) => n.props.role === "img");
  assert.equal(image?.props.tabIndex, 0);
  assert.equal(image?.props["aria-label"],
    "Daily flagged rate, 2 days from 2026-09-23 to 2026-09-24: latest 12.5%, low 5.0%, high 12.5%");
});

test("a drawer metric sits flat on its section rather than as a card inside a card", async () => {
  const tree = await renderComponent("DetailMetric", { label: "Runs", value: "12" });
  const root = tree as RenderedNode;
  assert.doesNotMatch(String(root.props.className), /ring-|bg-sunken|rounded/);
  assert.equal(collectText(root), "Runs 12");
});

function getBandTile(tree: RenderedNode | string | null, label: string): RenderedNode | null {
  const labels = ["Unsafe to route", "Failed", "Over tool-use cap", "Needs context"];
  return findNodes(tree, (n) => n.type === "div" && collectText(n).startsWith(label))
    .filter((n) => labels.every((other) => other === label || !collectText(n).includes(other)))[0] ?? null;
}

test("the over-cap and needs-context tiles state their rate over runs, and the tone follows the rate rather than presence", async () => {
  const ready = { status: "ready", data: [], error: null };
  const agents = [{ agent_id: "a", runs: 600, needs_context_count: 2 }, { agent_id: "b", runs: 400, needs_context_count: 1 }];
  const rows = [
    { name: "none crossed", overCap: 0, tone: "ok", ratePct: "0.0" },
    { name: "3 of 1,000 stays under the 5% step", overCap: 3, tone: null, ratePct: "0.3" },
    { name: "60 of 1,000 crosses the 5% step", overCap: 60, tone: "warn", ratePct: "6.0" },
  ];
  for (const row of rows) {
    const overageByAgent = new Map(Array.from({ length: row.overCap }, (_, i) => [`run-${i}`, { overage_count: 1 }]));
    const tree = await renderStatusBand({
      days: 14, summaryState: getSummaryState(null, agents), failureState: ready, overageState: ready,
      failureByAgent: new Map(), overageByAgent, onRetry: () => undefined,
    });
    const overCap = getBandTile(tree, "Over tool-use cap");
    assert.equal(findAtoms(overCap, "KpiValue")[0]?.props.tone ?? null, row.tone, `${row.name}: tone`);
    assert.equal(collectText(overCap).match(/([\d.]+)% of 1,?000 runs/)?.[1] ?? null, row.ratePct, `${row.name}: rate`);
    const needsContext = getBandTile(tree, "Needs context");
    assert.match(collectText(needsContext), /0\.3% of 1,?000 runs/, "needs context states its rate over the same runs");
    assert.equal(findAtoms(needsContext, "KpiValue")[0]?.props.tone ?? null, null, "3 of 1,000 needs-context outcomes stay untoned");
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

test("the success bar reads a 90-100% window with the 95% target at its midpoint", async () => {
  const mod = await loadAgentsScreen();
  const rows = [
    { name: "a perfect rate fills the bar", pct: 100, value: 1 },
    { name: "97% sits past the target", pct: 97, value: 0.7 },
    { name: "95% sits on the target", pct: 95, value: 0.5 },
    { name: "a rate under the window floor empties the bar", pct: 80, value: 0 },
  ];
  for (const row of rows) {
    const cell = findCellByTitle(renderToneRow(mod, { success_pct: row.pct, runs: 100, needs_context_count: 0 }, null), /^passed/);
    const bar = findAtoms(cell, "BulletBar")[0];
    assert.ok(Math.abs(Number(bar?.props.value) - row.value) < 1e-9, `${row.name}: ${bar?.props.value}`);
    assert.equal(bar?.props.target, 0.5, `${row.name}: target tick`);
    assert.match(String(bar?.props.ariaLabel), new RegExp(`success rate ${row.pct}\\.0%`), `${row.name}: label keeps the true rate`);
  }
});

test("the failing-pairs limit keeps a solid signal over a worse small sample while the total still counts both", async () => {
  const mod = await loadAgentsScreen();
  const buildTopNFailing = mod.buildTopNFailing as (rows: unknown[], t: number, l: number) => { failingPairs: Array<{ task_type: string }>; failingTotal: number; measuredPairs: number };
  const day = (task_type: string, success: number, failure: number) => ({ agent: "glass-atrium-dev-node", task_type, event_date: "2026-09-01", success_count: success, failure_count: failure, total_count: success + failure });
  const rows = [day("tiny", 0, 3), day("solid", 5, 5), day("healthy", 20, 0)];
  const out = buildTopNFailing(rows, 0.95, 1);
  assert.deepEqual(Array.from(out.failingPairs, (p) => p.task_type), ["solid"], "the limit keeps the solid signal over a worse small sample");
  assert.equal(out.failingTotal, 2);
});

test("the failing-pairs subtitle counts the rows shown and claims a cap only when some are hidden", async () => {
  const mod = await loadAgentsScreen();
  const getSub = mod.getFailingPairsSub as (...a: unknown[]) => string;
  const sub = getSub("ready", 7, 7, 40, 30);
  assert.match(sub, /^7 of 40 pairs below 95%/);
  assert.doesNotMatch(sub, /top \d/, "no cap is claimed when every failing pair is shown");
  assert.match(getSub("ready", 8, 11, 40, 30), /showing 8 of 11/);
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

// Stub LOW_N_MIN = 5. revision bucket '0' → health 1 (ok) · avg 0.3 → health 0.64 (warn) · bucket '4+' → health 0.4 (crit).
describe("the Agents page verdict rolls up the health rule and every status tile", () => {
  const ready = (data: unknown) => ({ status: "ready", data, error: null });
  const revision = (agent: string, buckets: Record<string, number>) =>
    Object.entries(buckets).map(([revision_bucket, occurrence_count]) => ({ agent, revision_bucket, occurrence_count }));
  const healthy = revision("a-healthy", { "0": 10 });
  const watched = revision("a-watch", { "0": 7, "1": 3 });
  const critical = revision("a-crit", { "4+": 10 });
  const thin = revision("a-thin", { "4+": 2 });
  const clearSources = {
    days: 30,
    summaryState: getSummaryState(BREAKER_LOADED_ZERO, [{ runs: 100, needs_context_count: 0 }]),
    failureState: ready([]),
    overageState: ready([]),
    failureByAgent: new Map(),
    overageByAgent: new Map(),
  };
  const renderVerdict = async (revisionRows: unknown[], sources: Record<string, unknown> = {}, reviewByAgentState: unknown = ready({ rows: [] })) => {
    const mod = await loadAgentsScreen();
    const buildTiles = mod.buildAgentStatusTiles as (s: Record<string, unknown>) => unknown[];
    const tree = await renderComponent("AgentPageVerdict", {
      revisionState: ready({ rows: revisionRows }), reviewByAgentState, statusTiles: buildTiles({ ...clearSources, ...sources }), days: 30,
    });
    return findNodes(tree, (n) => n.props?.atom === "PageVerdict")[0] ?? null;
  };
  const failedRun = new Map([["glass-atrium-dev-shell", { fail_count: 1, blocked_count: 0 }]]);
  const rows = [
    { name: "a crit agent makes the page crit and names it", revision: [...healthy, ...watched, ...critical], sources: {}, tone: "crit", text: /1 agent needs attention .*\(a-crit\).*1 agent to watch .*\(a-watch\)/ },
    { name: "a watch-band agent alone makes the page warn under the Watch label", revision: [...healthy, ...watched], sources: {}, tone: "warn", text: /^Last 30d: 1 agent to watch/ },
    { name: "a failed run makes the page crit though every agent's health is ok", revision: healthy, sources: { failureByAgent: failedRun }, tone: "crit", text: /1 agent with a failed run \(dev-shell\)/ },
    { name: "a suspended agent makes the page crit though every agent's health is ok", revision: healthy, sources: { summaryState: getSummaryState({ ...BREAKER_LOADED_ZERO, suspended_count: 1 }) }, tone: "crit", text: /1 unsafe to route now/ },
    {
      name: "a current breaker clause leads and never sits under the window prefix",
      revision: healthy,
      sources: { summaryState: getSummaryState({ ...BREAKER_LOADED_ZERO, suspended_count: 1 }), failureByAgent: failedRun },
      tone: "crit",
      text: /^1 unsafe to route now · last 30d: 1 agent with a failed run/,
    },
    { name: "a clear fleet with every judged agent healthy is ok, the thin one left out", revision: [...healthy, ...thin], sources: {}, tone: "ok", text: /the 1 agent with enough runs .* is healthy/ },
    { name: "no agent above the low-N floor claims no tone", revision: thin, sources: {}, tone: "neutral", text: /too few runs/ },
    { name: "an unread status tile holds back the all-clear", revision: healthy, sources: { failureState: ERROR_STATE }, tone: "neutral", text: /couldn't check failed runs\.$/ },
  ];
  for (const row of rows) {
    test(row.name, async () => {
      const verdict = await renderVerdict(row.revision, row.sources);
      assert.ok(verdict, "renders the shared PageVerdict atom");
      assert.equal(verdict.props.tone, row.tone);
      assert.match(collectText(verdict), row.text);
    });
  }

  test("the warn verdict reads Watch, and a verdict tone never says zero agents need attention", async () => {
    const verdict = await renderVerdict([...healthy, ...watched]);
    assert.equal(verdict?.props.label, "Watch");
    assert.doesNotMatch(collectText(verdict), /\b0 /);
  });

  test("an unread flag rate is unknown, never all-clear", async () => {
    const verdict = await renderVerdict(healthy, {}, ERROR_STATE);
    assert.equal(verdict?.props.tone, "neutral");
    assert.match(collectText(verdict), /unknown/);
  });

  test("a pending read with nothing flagged renders no premature verdict", async () => {
    const tree = await renderComponent("AgentPageVerdict", { revisionState: LOADING_STATE, reviewByAgentState: LOADING_STATE, statusTiles: [], days: 30 });
    assert.equal(findNodes(tree, (n) => n.props?.atom === "PageVerdict").length, 0);
  });
});

test("a warm error hands the verdict its failed region, so the page never reads Healthy over it", async () => {
  const warmError = { status: "ready", busy: false, key: null, data: { rows: [], agents: [], fetched_at: "2026-01-10T11:59:00.000Z" }, error: "HTTP 500 Internal Server Error" };
  const tree = await renderScreenAgents(warmError);
  const [verdict] = findAtoms(tree, "PageVerdict");
  const freshness = verdict?.props.freshness as Record<string, unknown> | undefined;
  assert.ok(freshness, "the verdict is freshness-driven");
  const getFreshnessVerdict = REAL_UI.getFreshnessVerdict as (input: Record<string, unknown>) => { tone: string; label: string };
  const settled = getFreshnessVerdict({ ...freshness, tone: "ok", now: Date.parse("2026-01-10T12:00:00.000Z") });
  assert.notEqual(settled.tone, "ok", "an all-clear over a failed read drops its tone");
  assert.doesNotMatch(settled.label, /Healthy/);
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
      { name: "success rates", component: "SuccessRateMatrixCard", props: { state: retrying, days: 30, onRetry } },
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
  assert.match(collectText(findAtoms(tree, "Badge")[0]), /^8\s+failed or blocked\s+·\s+20\.0\s*%/);
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
  assert.match(text, /All records,\s+3\s+reconstructed included ·\s+20\.0\s*%\s+of outcomes\s*Failed\s*3\s*Blocked\s*5/, "the rate and the Failed/Blocked figures sit under their basis caption");
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
      definition: /No record: Launches minus runs, from the agent summary/,
    },
    {
      name: "the lifecycle card defines Unfinished",
      component: "LifecycleStatsCard",
      props: {
        state: { status: "ready", data: { rows: [{ agent_type: "glass-atrium-dev-shell", start_count: 4, stop_count: 3, completed_count: 3 }] }, error: null },
        days: 30, onSelect: () => undefined, onRetry: () => undefined,
      },
      definition: /Unfinished: SubagentStart events minus completed outcomes/,
    },
  ];
  for (const row of rows) {
    const tree = await renderComponent(row.component, row.props);
    assert.match(collectText(tree).replace(/\s+/g, " "), row.definition, row.name);
  }
});

test("the drawer names its agent in words for a screen reader, the hyphenated id staying visual only", async () => {
  const tree = await renderComponent("AgentDrawerNameAg", { name: "glass-atrium-dev-shell" }) as RenderedNode;
  const [spoken] = findNodes(tree, (n) => n.props?.className === "sr-only");
  const [hidden] = findNodes(tree, (n) => n.props?.["aria-hidden"] === "true");
  assert.equal(collectText(spoken).trim(), "dev shell", "the spoken name splits the id at its hyphens");
  assert.deepEqual(findAtoms(hidden, "AgentName").map((n) => n.props.name), ["glass-atrium-dev-shell"], "the shared atom still draws the id");
});
