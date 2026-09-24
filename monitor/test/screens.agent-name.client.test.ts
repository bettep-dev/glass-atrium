// Agents and Task results print agent names through the shared AgentName atom (plan 39859 S4b).
//
// Runner: npx tsx --test test/screens.agent-name.client.test.ts

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
const OUTCOMES_SRC = resolve(__dirname, "../public/src/screens/outcomes.jsx");

type Component = (props: Record<string, unknown>) => unknown;

const FULL = "glass-atrium-dev-react";

const UI_SCALARS: Record<string, unknown> = {
  LOW_N_MIN: 5,
  TONE_ICON: new Proxy({}, { get: () => "dot" }),
  resolveBadge: () => ({ label: "badge", tone: "warn" }),
  resolveResultMeta: () => ({ label: "done", tone: "ok", icon: "check" }),
  formatPctWithDenominator: (pct: number) => `${pct}%`,
  formatKstFull: (iso: string) => iso,
  formatKstDateTime: (iso: string) => iso,
  outcomeShareTone: () => null,
  OUTCOME_BREAKAGE_CRIT_SHARE: 0.05,
};

// every other UI member → a transparent host element tagged with its atom name
function uiStub(): unknown {
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        name in UI_SCALARS
          ? UI_SCALARS[name]
          : Object.defineProperty(
              (props: Record<string, unknown>) => ({ __element: true, type: "ui-atom", props: { ...props, atom: name } }),
              "name",
              { value: name },
            ),
      has: () => true,
    },
  );
}

async function loadScreen(src: string): Promise<Record<string, unknown>> {
  return loadScreenModule(src, { UI: uiStub(), Recharts: uiStub(), React: createReactStub() });
}

const agentsMod = await loadScreen(AGENTS_SRC);
const outcomesMod = await loadScreen(OUTCOMES_SRC);

function render(mod: Record<string, unknown>, name: string, props: Record<string, unknown>): RenderedNode | string | null {
  const React = mod.React as { createElement: (t: unknown, p: unknown) => unknown };
  return renderScreen(React.createElement(mod[name] as Component, props));
}

const NAME_SITES: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
  ["Agents alarm lane", agentsMod, "AgentAlarmRow", { alarm: { agent: FULL, consecutive_fails: 3 } }],
  ["Agents ledger row", agentsMod, "AgentSummaryRow", {
    agent: { agent_id: FULL, agent_name: FULL, status: "active", success_pct: 90, runs: 10 },
    days: 30, isSelected: false, onSelect: () => {}, trend: null, failure: null, overage: null,
  }],
  ["Agents latency bars", agentsMod, "LatencyBars", { agents: [{ agent_id: FULL, agent_name: FULL, p50_ms: 1, p95_ms: 2, p99_ms: 3 }] }],
  ["Agents success matrix", agentsMod, "SuccessRateMatrixRow", { agent: FULL, cells: {} }],
  ["Agents failing pairs", agentsMod, "TopNFailingAgentsTable", {
    pairs: [{ agent: FULL, task_type: "feature", failed: 3, rateDenominator: 10 }], failureByAgent: new Map(), days: 30,
  }],
  ["Task results budget-kill list", outcomesMod, "AttributionBudgetKillListO", { rows: [{ agent: FULL, count: 2 }] }],
  ["Task results failure table", outcomesMod, "AgentFailureBodyO", {
    state: { status: "ready", data: { agentStack: [{ agent: FULL, byResult: { fail: 2 }, total: 4 }] } }, onRetry: () => {}, stickyStyle: {},
  }],
  ["Task results run events", outcomesMod, "LoopEventsBody", {
    state: { status: "ready", data: { total_events: 1, events: [{ agent: FULL, event_ts: "2026-01-01T00:00:00Z" }] } }, onRetry: () => {},
  }],
  ["Task results record row", outcomesMod, "ResultTableRow", {
    row: { agent: FULL, task_type: "feature", result: "done", record_ts: "2026-01-01T00:00:00Z" }, onRowClick: () => {}, closure: null,
  }],
];

test("every agent-name site renders the shared atom with the full name, never the bare prefixed string", () => {
  for (const [label, mod, component, props] of NAME_SITES) {
    const tree = render(mod, component, props);
    const atoms = findNodes(tree, (n) => n.props.atom === "AgentName");
    assert.ok(atoms.some((n) => n.props.name === FULL), `${label}: no AgentName atom for the full name`);
    assert.ok(!collectText(tree).includes(FULL), `${label}: the prefixed name still prints as bare text`);
  }
});
