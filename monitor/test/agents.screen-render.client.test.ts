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

function uiStub(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name in UI_SCALARS
          ? UI_SCALARS[name]
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

async function loadAgentsScreen(): Promise<Record<string, unknown>> {
  // Recharts rides the same transparent-atom stub — the matrix sparkline only needs its components to exist.
  return loadScreenModule(AGENTS_SRC, { UI: uiStub(), Recharts: uiStub(), React: createReactStub() });
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

test("a keydown from a control inside the row leaves that control's own activation intact", async () => {
  const mod = await loadAgentsScreen();
  const AgentSummaryRow = mod.AgentSummaryRow as Component;
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };

  const selected: string[] = [];
  const tree = renderScreen(
    React.createElement(AgentSummaryRow, {
      agent: { agent_id: "glass-atrium-dev-react", agent_name: "dev-react", status: "active", success_pct: 92, runs: 40, needs_context_count: 2 },
      days: 30,
      isSelected: false,
      onSelect: (id: string) => selected.push(id),
      trend: null,
      failure: null,
      overage: null,
    }),
  );

  const row = findNodes(tree, (n) => n.type === "tr")[0];
  assert.ok(row, "the summary row renders a tr");
  const onKeyDown = row.props.onKeyDown as (e: unknown) => void;

  for (const key of ["Enter", " "]) {
    // A control nested in the row is the keydown target; the row is only the bubble path.
    let prevented = false;
    onKeyDown({ key, target: { nested: true }, currentTarget: row, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false, `${key} on a nested control is not cancelled by the row`);
    assert.deepEqual(selected, [], `${key} on a nested control does not open the drawer`);
  }

  // The row itself still answers the same keys.
  let rowPrevented = false;
  onKeyDown({ key: "Enter", target: row, currentTarget: row, preventDefault: () => { rowPrevented = true; } });
  assert.equal(rowPrevented, true);
  assert.deepEqual(selected, ["glass-atrium-dev-react"]);
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

function getBadgeTexts(tree: RenderedNode | string | null): string[] {
  return findNodes(tree, (n) => n.props.atom === "Badge").map((n) => collectText(n));
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
  assert.match(collectText(failed), /Couldn't load circuit-breaker state/);
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
  assert.deepEqual(getBadgeTexts(loadedZero), ["0"]);
  assert.match(collectText(loadedZero), /of 3 registered agents/);

  const unavailable = await getUnsafeTile(getSummaryState(BREAKER_UNAVAILABLE));
  assert.deepEqual(getBadgeTexts(unavailable), ["unavailable"]);

  const loading = await getUnsafeTile(LOADING_STATE);
  assert.ok(isBusy(loading));
  assert.deepEqual(getBadgeTexts(loading), []);

  const failed = await getUnsafeTile(ERROR_STATE);
  assert.match(collectText(failed), /Couldn't load unsafe to route/);
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
  const headers = findNodes(table, (n) => n.type === "th").map((n) => collectText(n));
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
