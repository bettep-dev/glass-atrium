// Card guards for public/src/screens/improvement-instrumentation.jsx: the Add-only patches roster
// ranks by count before its S slot cuts it (the server orders by agent name), the tables use the
// house Table, and a card with nothing to show is its head and one line.
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
  window: { UI: { CARD_SLOTS: Record<string, { rowCount: number }>; Table: unknown; TableRow: unknown; TableCell: unknown } };
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
// the screen-shared atoms improvement.jsx publishes; the badge only names a mark, which these pins do not read
(sandbox.window as unknown as Record<string, unknown>).ImprovementShared = {
  SymI: () => null, confidenceBadgeMetaI: () => ({ symbol: "✓", tone: "text-ok" }),
};
const slotRowCount = sandbox.window.UI.CARD_SLOTS.S.rowCount;

// a wide two-column view → the rows the card hands its Table
const WIDE_VIEW = { isStacked: false, columnCount: 2 };

function renderCard(agents: RosterEntry[], isShowingAll: boolean) {
  sandbox.React.useState = () => [isShowingAll, () => {}];
  const total = agents.reduce((sum, entry) => sum + entry.count, 0);
  const card = sandbox.ProseOnlyAddCardI({
    state: { status: "ready", data: {}, error: null },
    summary: { window_days: 30, agents, total },
  }) as RecordedElement;
  const [table] = findElements(card, (el) => el.type === sandbox.window.UI.Table);
  const agentRows = (table.props.children as (view: typeof WIDE_VIEW) => unknown)(WIDE_VIEW);
  const rows = findElements(agentRows, (el) => el.type === sandbox.window.UI.TableRow);
  return {
    shownAgents: rows.map((row) => getText(findElements(row, (el) => el.type === sandbox.window.UI.TableCell)[0])),
    foot: card.props.foot ? getText(card.props.foot) : null,
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

// the instrumentation tables read like every other table: the house Table and its cell atom, never a raw table or cell
test("the three instrumentation tables render through the shared Table and its cell atom, no raw table markup", () => {
  const tables = sandbox as unknown as Record<string, (props: Record<string, unknown>) => unknown>;
  const ui = sandbox.window.UI as unknown as Record<string, unknown>;
  sandbox.React.useState = () => [false, () => {}];
  const rendered = [
    { name: "confidence lanes", tree: tables.ConfidenceLaneTableI({ buckets: [{ promotion_tier: "auto", proposal_count: 3, confidence_observed_avg: 0.7 }] }) },
    { name: "add-only patches", tree: sandbox.ProseOnlyAddCardI({
      state: { status: "ready", data: {}, error: null },
      summary: { window_days: 30, agents: [{ agent: "glass-atrium-dev-db", count: 2 }], total: 2 },
    }) },
    { name: "style-ref agents", tree: tables.StyleRefAgentTableI({ rows: [{ agent: "glass-atrium-dev-db", emission_count: 1, emission_total: 2 }] }) },
  ];
  for (const { name, tree } of rendered) {
    const houseTables = findElements(tree, (el) => el.type === ui.Table);
    assert.equal(houseTables.length, 1, `${name}: one house Table`);
    const rows = (houseTables[0].props.children as (view: typeof WIDE_VIEW) => unknown)(WIDE_VIEW);
    const cells = findElements(rows, (el) => el.type === ui.TableCell);
    assert.ok(cells.length > 0, `${name}: the rows carry cell atoms`);
    const raw = findElements([tree, rows], (el) => ["table", "thead", "tbody", "tr", "td", "th"].includes(String(el.type)));
    assert.deepEqual(raw.map((el) => el.type), [], `${name}: no raw table markup beside the house Table`);
  }
});

const READY = { status: "ready", data: {}, error: null };

// spec 44084 §2.2 Empty: the body is the one line, flush so the line starts at the title's inset; no stat, gate or None beside it
const EMPTY_CARDS = [
  {
    name: "corpus growth with no audit row",
    card: "CorpusGrowthCardI",
    props: { state: { status: "ready", data: { total_audits: 0, audits: [] }, error: null } },
    message: "No corpus readings yet — each daemon cycle writes one",
  },
  {
    name: "detection agreement with no correction signal",
    card: "CorrectionSignalsCardI",
    props: { state: { status: "ready", data: { total_signals: 0 }, error: null } },
    message: "No correction signals yet — each detection logs one",
  },
  {
    name: "style-check rate with no reported rate",
    card: "StyleRefCardI",
    props: { state: READY, styleRef: { overall_emission_rate: null, overall_uncorroborated_rate: null, agents: [] } },
    message: "No task results in this window",
  },
  {
    name: "add-only patches with no agent row",
    card: "ProseOnlyAddCardI",
    props: { state: READY, summary: { window_days: 30, agents: [], total: 0 } },
    message: "No add-only patches in this window",
  },
  {
    name: "results by check status with no task",
    card: "TierBreakdownCardI",
    props: { state: READY, tierBreakdown: { window_days: 30, code_based_pass_30d: 0, code_based_fail_30d: 0, pre_3tier_baseline_count: 0 } },
    message: "No task results in this window",
  },
  {
    name: "suggestion confidence with no proposal",
    card: "ConfidenceDistCardI",
    props: { state: READY, confidenceDist: { buckets: [], overall_confidence_observed_avg: null } },
    message: "No suggestions in this window",
  },
];

describe("an instrumentation card with nothing to show is its head and one flush line", () => {
  const ui = sandbox.window.UI as unknown as Record<string, unknown>;
  for (const row of EMPTY_CARDS) {
    test(row.name, () => {
      sandbox.React.useState = () => [false, () => {}];
      const cards = sandbox as unknown as Record<string, (props: unknown) => RecordedElement>;
      const form = cards[row.card](row.props);
      // the card hands its empty case to the screen's one empty-card form → read the Card that form renders
      const card = (form.type as (props: unknown) => RecordedElement)(form.props);
      const body = card.props.children;

      assert.equal(card.type, ui.Card, "the card renders the shared Card");
      assert.equal(card.props.isFlush, true, "the body is flush, so the line's own inset is the one inset");
      assert.ok(isElement(body) && body.type === ui.EmptyState, "the body is the one empty line, nothing beside it");
      assert.deepEqual({ message: body.props.message, hint: body.props.hint }, { message: row.message, hint: undefined });
    });
  }
});

// spec 44084 §2.2 Zero: outcomes exist and none reported a style check → a measured 0, not an empty card
test("a known zero style-check rate keeps the stat row and the per-agent table", () => {
  const ui = sandbox.window.UI as unknown as Record<string, unknown>;
  const card = (sandbox as unknown as Record<string, (props: unknown) => RecordedElement>).StyleRefCardI({
    state: READY,
    styleRef: {
      overall_emission_rate: 0,
      overall_uncorroborated_rate: null,
      agents: [{ agent: "glass-atrium-dev-db", emission_count: 0, emission_total: 13, emission_rate: 0, eligible_count: 0 }],
    },
  });
  // a table body carries its stat row as its lead prop
  const leads = findElements(card, () => true).map((el) => el.props.lead);
  const types = findElements([card, leads], () => true).map((el) => el.type);

  assert.ok(types.includes(ui.StatRow), "the stat row stays");
  assert.ok(types.includes((sandbox as unknown as Record<string, unknown>).StyleRefAgentTableI), "the per-agent table stays");
  assert.ok(!types.includes(ui.EmptyState), "no empty line");
});

// the title already says flagged results over 7 days → zero rows draw the 0 stat alone, no bars and no restating line
test("zero flagged rows draw no reason bars and no line under the stat", () => {
  const bars = (sandbox as unknown as Record<string, (props: unknown) => unknown>).FlaggedReasonBarsI;

  assert.equal(bars({ segments: { items: [], classifiedTotal: 0 } }), null);
});
