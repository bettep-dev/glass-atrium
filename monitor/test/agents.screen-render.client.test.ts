// Element-tree behaviour tests for the Agents screen, closing the plan's standing
// decision that screen behaviour is proved against a render harness. Exercises the
// shipped JSX through test/lib/render-screen.ts — no DOM, no react-dom, no DB.
//
// Runner: npx tsx --test test/agents.screen-render.client.test.ts

import test from "node:test";
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
const REGION_MEMBERS = ["INITIAL_REGION_STATE", "getRegionSummary", "getSharedFailure", "putRegionRequest", "putRegionData", "putRegionFailure", "getRowFocusProps", "ROW_CONTROL_PROPS"];
for (const name of REGION_MEMBERS) UI_SCALARS[name] = REAL_UI[name];

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
      React.createElement(AgentLatencyRow, { latency, state: { status: "ready" }, onRetry: () => undefined }),
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

test("the ledger is one Tab stop, with each row's Expand control off the Tab order", async () => {
  const tree = renderLedger(await loadAgentsScreen());
  const rows = getRovingRows(tree);

  assert.deepEqual(rows.map((r) => r.props.tabIndex), [0, -1, -1]);
  assert.ok(rows.every((r) => r.props.role === undefined), "rows keep table-row semantics");
  const expands = findNodes(tree, (n) => n.type === "button" && String(n.props["aria-label"] ?? "").includes("counts for"));
  assert.equal(expands.length, LEDGER_AGENTS.length);
  assert.ok(expands.every((b) => b.props.tabIndex === -1 && "data-row-control" in b.props), "Expand is an in-row control");
});

test("Enter on a ledger row opens its drawer, while Enter on its Expand control stays with the control", async () => {
  const selected: string[] = [];
  const [row] = getRovingRows(renderLedger(await loadAgentsScreen(), (id) => selected.push(id)));

  assert.equal(pressRowKey(row, "Enter", "control"), false, "the control's native Enter is not cancelled");
  assert.deepEqual(selected, [], "Enter on the control does not open the drawer");
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

test("the alarm lane renders loading, error, unavailable and a loaded zero distinctly", async () => {
  const onRetry = () => undefined;
  const loading = await renderComponent("AgentAlarmLane", { state: LOADING_STATE, onRetry });
  const failed = await renderComponent("AgentAlarmLane", { state: ERROR_STATE, onRetry });
  const unavailable = await renderComponent("AgentAlarmLane", { state: getSummaryState(BREAKER_UNAVAILABLE), onRetry });
  const loadedZero = await renderComponent("AgentAlarmLane", { state: getSummaryState(BREAKER_LOADED_ZERO), onRetry });

  assert.ok(isBusy(loading));
  assert.deepEqual(getBadgeTexts(loading), []);
  assert.deepEqual(getUnavailableSources(failed), ["circuit-breaker state"], "the failure names its own source");
  assert.deepEqual(getBadgeTexts(failed), []);
  assert.deepEqual(getBadgeTexts(unavailable), ["unavailable"]);
  assert.equal(collectText(loadedZero), "", "a clear fleet renders no alarm lane");
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
    const tree = await renderComponent("AgentStatusBand", { ...bandProps, summaryState });
    // Pre-order → the first div holding only this tile's text is the tile's own card.
    return findNodes(tree, (n) => n.type === "div" && collectText(n).startsWith("Unsafe to route")
      && !collectText(n).includes("Failed or blocked"))[0] ?? null;
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
  assert.deepEqual(getUnavailableSources(failed), ["unsafe to route"]);
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
  const tree = await renderComponent("AgentStatusBand", {
    days: 14,
    summaryState: getSummaryState(BREAKER_LOADED_ZERO),
    failureState: ready,
    overageState: ready,
    failureByAgent: new Map(),
    overageByAgent: new Map(),
    onRetry: () => undefined,
  });
  const labels = ["Unsafe to route", "Failed or blocked", "Over tool-use cap", "Needs context"];
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
  const failureByAgent = new Map([["glass-atrium-dev-risky", { total_breakages: 7, breakage_rate: 0.7 }]]);
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

test("an outage every region shares shows one page banner with the only Retry", async () => {
  const initial = REAL_UI.INITIAL_REGION_STATE as Record<string, unknown>;
  const failed = { ...initial, status: "error", busy: false, error: "HTTP 503 Service Unavailable — down" };
  const tree = await renderScreenAgents(failed);
  const banners = findAtoms(tree, "PageErrorBanner");
  assert.equal(banners.length, 1);
  assert.equal(typeof banners[0].props.onRetry, "function");
  const regions = findAtoms(tree, "RegionUnavailable");
  assert.ok(regions.length > 1, "each region still keeps its quiet placeholder");
  assert.deepEqual(regions.filter((n) => n.props.onRetry !== undefined), [], "no region repeats the Retry");
});

test("a region that fails alone keeps its own Retry and no page banner appears", async () => {
  const tree = await renderComponent("AgentAlarmLane", { state: ERROR_STATE, onRetry: () => undefined });
  const [region] = findAtoms(tree, "RegionUnavailable");
  assert.equal(typeof region?.props.onRetry, "function");
  assert.deepEqual(findAtoms(tree, "PageErrorBanner"), []);
});

test("a loading region shows a labelled status placeholder with its height reserved, never an empty box", async () => {
  const tree = await renderComponent("TopNFailingAgentsCard", { state: LOADING_STATE, days: 30, onRetry: () => undefined, failureByAgent: new Map() });
  const [placeholder] = findAtoms(tree, "LoadingPlaceholder");
  assert.ok(placeholder, "the pairs region renders the shared loading placeholder");
  assert.match(String(placeholder.props.label), /\w/, "the placeholder names what is loading");
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
    const badge = findNodes(tree, (n) => n.props?.atom === "Badge" && /breakages/.test(collectText(n)))[0];
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

test("a failing pair keeps its failure tint at any sample, and a small sample says so in words instead of grey italics", async () => {
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
    assert.equal(/low sample/.test(collectText(rateCell)), row.isLowSample, `${row.name}: low-sample tag`);
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

test("a disclosure is a page h2 whose control is the shared chevron button, never a text glyph", async () => {
  const tree = await renderComponent("AgentDisclosure", { title: "Instrumentation", sub: "Is the measuring apparatus intact" });
  const heading = findNodes(tree, (n) => n.type === "h2")[0];
  assert.ok(heading, "the disclosure title is an h2");
  const button = findAtoms(heading, "DisclosureButton")[0];
  assert.equal(button?.props.isOpen, false, "closed by default");
  assert.doesNotMatch(collectText(tree), /[▸▾]/);
});

test("the ledger's row expand uses the shared chevron, never a text glyph", async () => {
  const mod = await loadAgentsScreen();
  const tree = renderLedger(mod);
  assert.equal(findAtoms(tree, "DisclosureChevron").length, LEDGER_AGENTS.length);
  assert.doesNotMatch(collectText(tree), /[▸▾]/);
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

test("a ledger trend chart carries a name a screen reader can announce", async () => {
  const mod = await loadAgentsScreen();
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  const tree = renderScreen(
    React.createElement(mod.AgentSummaryRow as Component, {
      agent: { agent_id: "glass-atrium-dev-react", agent_name: "dev-react", status: "active", success_pct: 92, runs: 40, needs_context_count: 2, p95_ms: 120_000 },
      days: 30, isSelected: false, onSelect: () => {}, trend: [0.9, 0.8, 1], failure: null, overage: null,
      failureStatus: "ready", trendStatus: "ready",
    }),
  );
  assert.match(String(findAtoms(tree, "MiniBars")[0]?.props.label), /dev-react/);
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

test("the drawer is named by the agent alone, never by the glyphs and pills beside its title", async () => {
  const idle = { status: "idle", data: null, error: null };
  const agent = { agent_id: "glass-atrium-dev-shell", agent_name: "dev-shell", status: "active", origin: "system" };
  const tree = await renderComponent("AgentDetailDrawer", {
    drawerAgent: agent.agent_id, sortedAgents: [agent], summaryState: { status: "ready", data: { agents: [agent] }, error: null },
    revisionState: idle, reviewByAgentState: idle, latencyState: idle, successState: idle, failureState: idle, lifecycleState: idle,
    detailState: idle, blockedState: idle, recentState: idle, trendByAgent: null, failureByAgent: null, days: 30,
    onClose: () => undefined, onNav: () => undefined, onRetry: () => undefined, onDeleted: () => undefined,
  });
  const surface = findAtoms(tree, "DetailSurface")[0];
  const labelledBy = surface?.props.labelledBy;
  assert.ok(labelledBy, "the surface points at a name node");
  // The surface atom is a stub, so its title element is rendered on its own.
  const nameNode = findNodes(renderScreen(surface.props.title), (n) => n.props?.id === labelledBy)[0];
  assert.equal(collectText(nameNode), "dev-shell");
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
