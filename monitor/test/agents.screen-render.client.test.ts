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
  return loadScreenModule(AGENTS_SRC, { UI: uiStub(), React: createReactStub() });
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
