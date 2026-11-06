// Roster guard for the Add-only patches card in public/src/screens/improvement-instrumentation.jsx.
// The server sends the roster ordered by agent name, so the card must rank it by count before its
// S slot cuts it — otherwise the collapsed card hides the agents with the most add-only patches.
//
// Runner: npx tsx --test test/improvement.prose-only-add.client.unit.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTRUMENTATION_SRC = resolve(__dirname, "../public/src/screens/improvement-instrumentation.jsx");

interface RecordedElement {
  type: unknown;
  props: Record<string, unknown>;
}

interface RosterEntry {
  agent: string;
  count: number;
}

interface CardSandbox {
  React: { createElement: unknown; useState: unknown };
  window: { UI: { CARD_SLOTS: Record<string, { rowCount: number }> } };
  ProseOnlyAddCardI: (props: Record<string, unknown>) => unknown;
}

function isElement(value: unknown): value is RecordedElement {
  return typeof value === "object" && value !== null && "props" in value && "type" in value;
}

function findElements(node: unknown, match: (el: RecordedElement) => boolean, out: RecordedElement[] = []): RecordedElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, match, out);
    return out;
  }
  if (!isElement(node)) return out;
  if (match(node)) out.push(node);
  findElements(node.props.children, match, out);
  return out;
}

function getText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(getText).join("");
  return isElement(node) ? getText(node.props.children) : "";
}

const sandbox = await buildScreenSandbox<CardSandbox>(INSTRUMENTATION_SRC);
sandbox.React.createElement = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => ({
  type,
  props: { ...(props ?? {}), children: rest.length > 1 ? rest : rest[0] },
});
const slotRowCount = sandbox.window.UI.CARD_SLOTS.S.rowCount;

function renderCard(agents: RosterEntry[], isShowingAll: boolean) {
  sandbox.React.useState = () => [isShowingAll, () => {}];
  const total = agents.reduce((sum, entry) => sum + entry.count, 0);
  const card = sandbox.ProseOnlyAddCardI({
    state: { status: "ready", data: {}, error: null },
    summary: { window_days: 30, agents, total },
  });
  const agentRows = findElements(card, (el) => el.type === "tr" && el.props.key !== undefined);
  const foot = findElements(card, (el) => el.props.className === "card-foot")[0];
  return {
    shownAgents: agentRows.map((row) => getText(findElements(row, (el) => el.type === "td")[0])),
    foot: foot ? getText(foot) : null,
  };
}

// the server's shape: ordered by agent name, counts unsorted
const rosters = [
  {
    name: "a roster that fits the slot",
    agents: [
      { agent: "glass-atrium-dev-angular", count: 2 },
      { agent: "glass-atrium-dev-db", count: 9 },
      { agent: "glass-atrium-dev-nestjs", count: 4 },
      { agent: "glass-atrium-dev-shell", count: 9 },
      { agent: "glass-atrium-intel-reporter", count: 1 },
    ],
    ranked: [
      "glass-atrium-dev-db",
      "glass-atrium-dev-shell",
      "glass-atrium-dev-nestjs",
      "glass-atrium-dev-angular",
      "glass-atrium-intel-reporter",
    ],
  },
  {
    name: "a roster past the slot with a tie across the cut",
    agents: [
      { agent: "glass-atrium-dev-angular", count: 1 },
      { agent: "glass-atrium-dev-db", count: 3 },
      { agent: "glass-atrium-dev-nestjs", count: 9 },
      { agent: "glass-atrium-dev-react", count: 3 },
      { agent: "glass-atrium-dev-shell", count: 7 },
      { agent: "glass-atrium-intel-reporter", count: 3 },
      { agent: "glass-atrium-meta-prompt-engineer", count: 3 },
      { agent: "glass-atrium-qa-debugger", count: 2 },
    ],
    ranked: [
      "glass-atrium-dev-nestjs",
      "glass-atrium-dev-shell",
      "glass-atrium-dev-db",
      "glass-atrium-dev-react",
      "glass-atrium-intel-reporter",
      "glass-atrium-meta-prompt-engineer",
      "glass-atrium-qa-debugger",
      "glass-atrium-dev-angular",
    ],
  },
];

describe("the add-only roster ranks by count, ties by name, before the slot cuts it", () => {
  for (const roster of rosters) {
    test(`collapsed — ${roster.name}`, () => {
      const { shownAgents, foot } = renderCard(roster.agents, false);
      const isCut = roster.agents.length > slotRowCount;

      assert.deepEqual(shownAgents, roster.ranked.slice(0, slotRowCount), "the collapsed rows are the highest counts");
      assert.equal(foot, isCut ? `Show all ${roster.agents.length}` : null, "the foot reads Show all N exactly when rows are hidden");
    });

    test(`expanded — ${roster.name}`, () => {
      const { shownAgents } = renderCard(roster.agents, true);

      assert.deepEqual(shownAgents, roster.ranked, "every row keeps the count ranking");
    });
  }
});

// R-d: the instrumentation tables sit off .tbl, so their body rows reach the 32 compact step through the shared
// tbody.tbl-compact atom; a cell carrying its own block padding would move the row off that step
test("the three instrumentation tables put their body rows on the shared compact atom, no cell padding its own block", () => {
  const tables = sandbox as unknown as Record<string, (props: Record<string, unknown>) => unknown>;
  sandbox.React.useState = () => [false, () => {}];
  // the screen-shared atoms improvement.jsx publishes; the badge only names a mark, which this pin does not read
  (sandbox.window as unknown as Record<string, unknown>).ImprovementShared = {
    SymI: () => null, confidenceBadgeMetaI: () => ({ symbol: "✓", tone: "text-ok" }),
  };
  const rendered = [
    { name: "confidence lanes", tree: tables.ConfidenceLaneTableI({ buckets: [{ promotion_tier: "auto", proposal_count: 3, confidence_observed_avg: 0.7 }] }) },
    { name: "add-only patches", tree: sandbox.ProseOnlyAddCardI({
      state: { status: "ready", data: {}, error: null },
      summary: { window_days: 30, agents: [{ agent: "glass-atrium-dev-db", count: 2 }], total: 2 },
    }) },
    { name: "style-ref agents", tree: tables.StyleRefAgentTableI({ rows: [{ agent: "glass-atrium-dev-db", emission_count: 1, emission_total: 2 }] }) },
  ];
  for (const { name, tree } of rendered) {
    const bodies = findElements(tree, (el) => el.type === "tbody");
    assert.equal(bodies.length, 1, `${name}: one body`);
    assert.equal(bodies[0].props.className, "tbl-compact", `${name}: the body takes the compact atom`);
    const cells = findElements(bodies[0], (el) => el.type === "td");
    assert.ok(cells.length > 0, `${name}: the body carries cells`);
    for (const cell of cells) {
      assert.doesNotMatch(String(cell.props.className ?? ""), /\b(py|pt|pb)-|\bflex\b/, `${name}: a cell stays a plain table cell`);
    }
  }
});
