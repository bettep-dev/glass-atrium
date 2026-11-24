// Legibility guards for the Learning screen's suggestion board and pattern ledger
// (public/src/screens/improvement.jsx): every board count states its window, applied
// history reads as one line, and no fact is printed twice in a row or a group.
//
// Same harness as improvement.loop-suppression.client.unit.test.ts: components run
// over the shipped source with a recording React.createElement, so these assert the
// emitted element tree, not computed CSS.
//
// Runner: npx tsx --test test/improvement.board-ledger-legibility.client.unit.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMPROVEMENT_SRC = resolve(__dirname, "../public/src/screens/improvement.jsx");

interface RecordedElement {
  type: unknown;
  props: Record<string, unknown>;
}

type Component = (props: Record<string, unknown>) => RecordedElement | null;

interface Sandbox {
  React: { createElement: unknown };
  window: { UI: Record<string, unknown> };
  patternLabelI: (signature: unknown, agent: unknown) => string;
  patternNameI: (signature: unknown, agent: unknown) => string;
  groupByLabelI: (rows: unknown[]) => Array<{ label: string; rows: unknown[] }>;
  AppliedHistoryRowI: Component;
  RejectedGroupI: Component;
  LedgerPlainRowsI: Component;
  CandidateRowI: Component;
  RecurrenceRowsI: Component;
  KanbanCardI: Component;
  KanbanColumnI: Component;
  CompactProposalCardI: Component;
  ViewTabsI: Component;
  LoopOutputGroupI: Component;
  AppliedHeroHeaderI: Component;
  LedgerSectionHeadI: Component;
  HeldCauseRowsI: Component;
  LedgerRecurrenceSectionI: Component;
  LedgerLiveSectionI: Component;
  ParkedLoopBannerI: Component;
  DetailBodyI: Component;
  PatternLedgerCardI: Component;
  StatusBandI: Component;
  RejectedHeaderI: Component;
  BoardRowI: Component;
  buildDetailPropsI: (row: Record<string, unknown>) => Record<string, unknown>;
  confidenceBadgeMetaI: (value: unknown) => { label: string };
  ConfidenceBadgeI: Component;
}

function isElement(value: unknown): value is RecordedElement {
  return typeof value === "object" && value !== null && "props" in value && "type" in value;
}

// Visible text only — walks `children`, never attributes, so a title tooltip or an
// aria-label never counts as printed copy. Function components are rendered one level
// at a time, as in the sibling suite.
function visibleText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join(" ");
  if (!isElement(node)) return "";
  if (typeof node.type === "function") {
    const render = node.type as (props: Record<string, unknown>) => unknown;
    return visibleText(render(node.props));
  }
  return visibleText(node.props.children);
}

function findAll(node: unknown, match: (el: RecordedElement) => boolean, out: RecordedElement[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out);
    return out;
  }
  if (!isElement(node)) return out;
  if (match(node)) out.push(node);
  for (const value of Object.values(node.props)) findAll(value, match, out);
  return out;
}

// Renders a row whose top element is a page-local atom, so its button is in the tree.
function expand(node: unknown): unknown {
  if (!isElement(node) || typeof node.type !== "function") return node;
  return (node.type as (props: Record<string, unknown>) => unknown)(node.props);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const sandbox = await buildScreenSandbox<Sandbox>(IMPROVEMENT_SRC);
sandbox.React.createElement = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => ({
  type,
  props: { ...(props ?? {}), children: rest.length > 1 ? rest : rest[0] },
});
Object.assign(sandbox.window.UI, {
  TONE_GLYPH: { ok: "✓", warn: "⚠", crit: "✕", info: "ℹ" },
  titleOf: (value: unknown) => value,
});

const AGENT = "glass-atrium-dev-node";
const SIGNATURE = `size est overrun concentration|${AGENT}`;

test("a ledger row names its agent once, never as a label suffix", () => {
  const rows = [{ id: 1, pattern_signature: SIGNATURE, agent: AGENT, discovered_date: "2026-09-10" }];
  const text = visibleText(sandbox.LedgerPlainRowsI({ rows }));
  assert.equal(occurrences(text, AGENT), 1, text);
  assert.ok(text.includes("Size est overrun concentration"), text);
  assert.ok(!text.includes("|"), text);
});

test("a live candidate row names its agent once, never as a label suffix", () => {
  const pattern = { id: 1, pattern_signature: SIGNATURE, agent: AGENT, frequency: 3, status: "identified" };
  const text = visibleText(sandbox.CandidateRowI({ rank: 1, pattern, maxFreq: 3, onClick: () => {} }));
  assert.equal(occurrences(text, AGENT), 1, text);
  assert.ok(!text.includes("|"), text);
});

// the status glyph stands with no word beside it → it takes the alarm glyph size, the size that clears 3:1
describe("a live candidate row draws its lone status glyph as the shared tone mark", () => {
  const rows = [
    { name: "a spotted pattern", status: "identified", tone: "info" },
    { name: "a proposed pattern", status: "proposed", tone: "warn" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const pattern = { id: 1, pattern_signature: SIGNATURE, agent: AGENT, frequency: 3, status: row.status };
      const tree = sandbox.CandidateRowI({ rank: 1, pattern, maxFreq: 3, onClick: () => {} });
      const marks = findAll(tree, (el) => el.type === sandbox.window.UI.ToneGlyph);

      assert.equal(marks.length, 1);
      assert.equal(marks[0].props.tone, row.tone);
    });
  }
});

test("live rows sharing a title print it once, each row led by its agent", () => {
  const other = "glass-atrium-dev-react";
  const rows = [
    { id: 1, pattern_signature: `failure rate|${AGENT}`, agent: AGENT, frequency: 150, status: "identified" },
    { id: 2, pattern_signature: `failure rate|${other}`, agent: other, frequency: 3, status: "identified" },
  ];
  const tree = sandbox.LedgerLiveSectionI({ rows, maxFreq: 150, onRowClick: () => {} });
  assert.equal(occurrences(visibleText(tree), "Failure rate"), 1, visibleText(tree));

  const rowEls = findAll(tree, (el) => el.type === sandbox.CandidateRowI);
  assert.equal(rowEls.length, 2);
  for (const rowEl of rowEls) {
    const row = expand(rowEl);
    const ordered = findAll(row, (el) => typeof el.props.name === "string" || el.props.max !== undefined);
    assert.ok(typeof ordered[0]?.props.name === "string", "the agent is the first thing a row names");
    assert.ok(!visibleText(row).includes("Failure rate"), "the shared title is not repeated per row");
  }
});

test("×N is drawn as a bar scaled to the ledger's largest count", () => {
  for (const freq of [150, 3]) {
    const pattern = { id: 1, pattern_signature: SIGNATURE, agent: AGENT, frequency: freq, status: "identified" };
    const row = sandbox.CandidateRowI({ rank: 1, pattern, maxFreq: 150, onClick: () => {} });
    const bars = findAll(row, (el) => el.props.max !== undefined);
    assert.equal(bars.length, 1, `×${freq}: one bar per row`);
    assert.equal(bars[0].props.value, freq);
    assert.equal(bars[0].props.max, 150);
    assert.match(visibleText(row), new RegExp(`×\\s*${freq}\\b`), "the count stays printed beside its bar");
  }
});

test("the label helper strips only the row's own agent suffix", () => {
  assert.equal(sandbox.patternLabelI(SIGNATURE, AGENT), "size est overrun concentration");
  assert.equal(sandbox.patternLabelI("a|b|other-agent", AGENT), "a|b|other-agent");
  assert.equal(sandbox.patternLabelI(SIGNATURE, null), SIGNATURE);
});

test("an applied row is one line of agent, date and pattern with the rationale kept off it", () => {
  const row = {
    id: 7,
    target_agent: AGENT,
    cycle_date: "2026-09-20",
    pattern_label: SIGNATURE,
    rationale: "Long rationale that belongs behind the drawer",
  };
  const tree = expand(sandbox.AppliedHistoryRowI({ row, onClick: () => {} }));
  const text = visibleText(tree);
  assert.ok(text.includes(AGENT) && text.includes("Size est overrun concentration"), text);
  assert.ok(text.includes("#7"), text);
  assert.ok(!text.includes("Long rationale"), text);
  const buttons = findAll(tree, (el) => el.type === "button");
  assert.equal(buttons.length, 1);
});

test("rejected rows sharing a pattern are grouped, every row kept, first-seen order", () => {
  const rows = [
    { id: 1, pattern_label: "A" },
    { id: 2, pattern_label: "B" },
    { id: 3, pattern_label: "A" },
  ];
  const groups = sandbox.groupByLabelI(rows);
  assert.deepEqual([...groups].map((g) => g.label), ["A", "B"]);
  assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), rows.length);
});

test("a rejected group prints its shared pattern label once, not per row", () => {
  const rows = [
    { id: 1, pattern_label: "shared label", rationale: "first reason" },
    { id: 2, pattern_label: "shared label", rationale: "second reason" },
  ];
  const text = visibleText(sandbox.RejectedGroupI({ label: "shared label", rows, onRowClick: () => {} }));
  assert.equal(occurrences(text, "shared label"), 1, text);
  assert.ok(text.includes("first reason") && text.includes("second reason"), text);
});

// the sub slot carries the head Status → the window rides the header's ⓘ
test("the board header's info states the window its applied and rejected counts cover", () => {
  const tree = sandbox.KanbanCardI({
    state: { status: "ready", data: {} },
    columnRows: { safety: [], applied: [], rejected: [] },
    onRowClick: () => {},
    onRetry: () => {},
  });
  const [head] = findAll(tree, (el) => el.props.title === "Suggestion board");
  assert.ok(head, "board header missing");
  assert.match(String(head.props.info), /latest 50 suggestions/);
});

describe("the board draws its lanes only when some lane holds a suggestion", () => {
  const APPLIED_ROW = { id: 9, status: "applied", target_agent: AGENT, pattern_label: SIGNATURE };
  const rows = [
    { name: "every lane empty → the head and one line", columnRows: { safety: [], applied: [], rejected: [] }, lanes: 0, lines: 1 },
    { name: "an applied suggestion → both terminal lanes, no empty line", columnRows: { applied: [APPLIED_ROW] }, lanes: 2, lines: 0 },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = sandbox.KanbanCardI({
        state: { status: "ready", data: {} },
        columnRows: row.columnRows,
        onRowClick: () => {},
        onRetry: () => {},
      });
      const lines = findAll(tree, (el) => el.type === sandbox.window.UI.EmptyState);
      assert.equal(findAll(tree, (el) => el.type === sandbox.KanbanColumnI).length, row.lanes);
      assert.equal(lines.length, row.lines);
      for (const line of lines) assert.equal(line.props.hint, undefined, "the empty board states one line, no hint");
    });
  }
});

test("the applied and rejected lane heads share one line shape: glyph, label and count at the meta size", () => {
  const heads = [
    sandbox.AppliedHeroHeaderI({ count: 9, label: "Applied", symbol: "✓" }),
    sandbox.RejectedHeaderI({ rowCount: 4, summary: null, label: "Rejected", symbol: "✕" }),
  ];
  for (const head of heads) {
    assert.ok(head, "lane head missing");
    assert.match(classOf(head), /\bi-col-header\b/);
    assert.match(classOf(head), /\bfs-meta\b/, classOf(head));
    assert.deepEqual(findAll(head, (el) => /\bfs-stat\b/.test(classOf(el))), [], "no figure outgrows the shared line");
  }
});

test("recurrence figure columns keep a gap so adjacent headers never run together", () => {
  const tree = sandbox.RecurrenceRowsI({ buckets: [], windowCycles: 7 });
  const headers = findAll(tree, (el) => el.type === "th");
  for (const th of headers.slice(1)) {
    assert.match(String(th.props.className), /\bpl-\d/, visibleText(th));
  }
});

function classOf(el: RecordedElement): string {
  return String(el.props.className ?? "");
}

// mono is drawn only through the shared machine-string atom → the text of every one in a tree
function machineTexts(tree: unknown): string[] {
  return findAll(tree, (el) => el.type === sandbox.window.UI.MachineString).map(visibleText);
}

test("the view switch is the shared tab row with the open view alone selected, never the range control", () => {
  for (const view of ["operator", "instrumentation"]) {
    const tree = sandbox.ViewTabsI({ view, onChange: () => {} });
    assert.equal(tree?.type, sandbox.window.UI.Tabs, "a view switch drawn as the segmented range control reads as a range");
    assert.equal(tree?.props.value, view);
    assert.deepEqual(Array.from(tree?.props.tabs as Array<{ key: string }>, (t) => t.key), ["operator", "instrumentation"]);
  }
});

test("applied and declined rows render through one row atom with the prose set in sans", () => {
  const applied = { id: 7, target_agent: AGENT, cycle_date: "2026-09-20", pattern_label: SIGNATURE };
  const declined = { id: 8, cycle_date: "2026-09-21", rationale: "Rationale that reads as prose" };
  const rows = [
    sandbox.AppliedHistoryRowI({ row: applied, onClick: () => {} }),
    sandbox.CompactProposalCardI({ row: declined, onClick: () => {} }),
  ].map((tree) => {
    const [button] = findAll(expand(tree), (el) => el.type === "button");
    return button;
  });
  assert.equal(classOf(rows[0]), classOf(rows[1]), "both lanes must share the row chrome");
  for (const button of rows) {
    const prose = findAll(button, (el) => /\bflex-1\b/.test(classOf(el)));
    assert.equal(prose.length, 1, "one flexible prose cell per row");
    assert.deepEqual(machineTexts(prose[0]), [], "the prose cell holds no machine string");
    assert.match(classOf(prose[0]), /\bmin-w-0\b/);
  }
});

test("board rows print a cycle date in the day form and sans figures, and a missing date as None", () => {
  const dated = [
    sandbox.AppliedHistoryRowI({ row: { id: 7, target_agent: AGENT, cycle_date: "2026-09-20" }, onClick: () => {} }),
    sandbox.CompactProposalCardI({ row: { id: 8, cycle_date: "2026-09-21" }, onClick: () => {} }),
  ];
  for (const [i, tree] of dated.entries()) {
    const day = `09-${20 + i}`;
    const [stamp] = findAll(expand(tree), (el) => el.type === "span" && visibleText(el) === day);
    assert.ok(stamp, `row ${i}: the date reads ${day}`);
    assert.ok(!machineTexts(expand(tree)).includes(day), `row ${i}: a date is set in sans`);
  }

  const undated = expand(sandbox.AppliedHistoryRowI({ row: { id: 9, target_agent: AGENT }, onClick: () => {} }));
  const absent = findAll(undated, (el) => el.type === sandbox.window.UI.AbsentValue);
  assert.equal(absent.length, 1, "a row with no cycle date shows the nothing atom");
  assert.equal(absent[0].props.kind, "none", "a loaded row without a date is known-empty");
  assert.ok(!visibleText(undated).includes("—"), visibleText(undated));
});

describe("a suggestion's confidence reads in the shared percentage form", () => {
  const rows = [
    { name: "a fractional share keeps one decimal", value: 0.734, label: "Confidence 73.4%" },
    { name: "a whole share drops the .0", value: 0.7, label: "Confidence 70%" },
    { name: "a non-zero share never rounds to 0%", value: 0.0004, label: "Confidence <0.1%" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.equal(sandbox.confidenceBadgeMetaI(row.value).label, row.label);
    });
  }
});

describe("a suggestion card draws a confidence chip only for a measured confidence", () => {
  const rows = [
    { name: "never measured (null) → no chip", value: null, hasChip: false },
    { name: "field absent → no chip", value: undefined, hasChip: false },
    { name: "not a number → no chip", value: "pending", hasChip: false },
    { name: "a measured zero → its chip", value: 0, hasChip: true },
    { name: "a measured share → its chip", value: 0.734, hasChip: true },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const chip = sandbox.ConfidenceBadgeI({ value: row.value });
      assert.equal(chip != null, row.hasChip);
    });
  }
});

test("a board column may shrink below its content so long rows ellipsise instead of overflowing", () => {
  const column = { key: "rejected", label: "Rejected", symbol: "✕", variant: "compact" };
  const tree = sandbox.KanbanColumnI({ column, rows: [], onRowClick: () => {} });
  assert.ok(tree && /\bmin-w-0\b/.test(classOf(tree)), classOf(tree as RecordedElement));
});

test("the applied count sits below the status band's figure size", () => {
  const tree = sandbox.AppliedHeroHeaderI({ count: 9, label: "Applied", symbol: "✓" });
  const [count] = findAll(tree, (el) => el.props.children === "9");
  assert.ok(count, "count cell missing");
  assert.doesNotMatch(classOf(count), /\bfs-display\b/);
  assert.ok(!machineTexts(tree).includes("9"), "a count is set in sans figures");
});

test("loop output cards reflow instead of squeezing three abreast", () => {
  const idle = { status: "loading", data: null };
  const tree = sandbox.LoopOutputGroupI({
    statsState: idle,
    loopEventsState: idle,
    loopAggregate: null,
    listState: idle,
    buckets: null,
    onNav: () => {},
    onRetry: () => {},
  });
  const grids = findAll(tree, (el) => /\bi-loop-grid\b/.test(classOf(el)));
  assert.equal(grids.length, 1);
  assert.doesNotMatch(classOf(grids[0]), /\bgrid-cols-3\b/);
});

// Renders function components on the way down, stopping at a match so a row atom counts once.
function findRendered(node: unknown, match: (el: RecordedElement) => boolean, out: RecordedElement[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) findRendered(child, match, out);
    return out;
  }
  if (!isElement(node)) return out;
  if (match(node)) {
    out.push(node);
    return out;
  }
  if (typeof node.type === "function") return findRendered(expand(node), match, out);
  for (const value of Object.values(node.props)) findRendered(value, match, out);
  return out;
}

const BOARD_LANE_ROWS = [
  { name: "applied", column: { key: "applied", label: "Applied", symbol: "✓", variant: "full" }, total: 9, more: 1, noun: "applied" },
  // the Rejected lane also holds rows the loop closed without a gate verdict → its foot must not call them declined
  { name: "rejected", column: { key: "rejected", label: "Rejected", symbol: "✕", variant: "compact" }, total: 29, more: 21, noun: "closed" },
];

describe("each board lane shows eight rows and a Show N more button for the rest", () => {
  for (const row of BOARD_LANE_ROWS) {
    test(row.name, () => {
      const rows = Array.from({ length: row.total }, (_, i) => ({
        id: i + 1,
        pattern_label: `pattern ${i % 3}`,
        target_agent: AGENT,
        rationale: `reason ${i}`,
      }));
      const tree = sandbox.KanbanColumnI({ column: row.column, rows, onRowClick: () => {} });
      const shown = findRendered(tree, (el) => el.type === sandbox.AppliedHistoryRowI || el.type === sandbox.CompactProposalCardI);
      const [foot] = findRendered(tree, (el) => el.type === sandbox.window.UI.QuietButton);

      assert.equal(shown.length, 8, `${row.name}: ${shown.length} rows shown`);
      assert.ok(foot, `${row.name}: no show-more button`);
      assert.equal(visibleText(foot).trim(), `Show ${row.more} more`);
      assert.equal(String(foot.props["aria-label"]), `Show ${row.more} more ${row.noun} suggestions`);
    });
  }
});

test("a ledger row sets its pattern label in sans", () => {
  const rows = [{ id: 1, pattern_signature: SIGNATURE, agent: AGENT, discovered_date: "2026-09-10" }];
  const tree = sandbox.LedgerPlainRowsI({ rows });
  const [item] = findAll(tree, (el) => el.type === "li");
  const [label] = findAll(item, (el) => el.props.title !== undefined);
  assert.ok(label, "the pattern label carries its full text as a title");
  assert.deepEqual(machineTexts(item), [], "no part of the row is a machine string");
});

const RAW_PATTERN = "editable-region-arbiter-resolved";
const PATTERN_NAME = "Release update: a model settled clashes with daemon-written lines";

// update.sh writes these rows over lines the DAEMON wrote, and a row may record a decision that never landed
describe("an updater pattern name claims only what its verdict guarantees", () => {
  const rows = [
    { name: "arbiter-resolved names a model decision", label: "editable-region-arbiter-resolved", claim: /\bmodel settled\b/ },
    { name: "historical resolved-release names the release side", label: "editable-region-resolved-release", claim: /\brelease text chosen\b/ },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const text = sandbox.patternNameI(`${row.label}|${AGENT}`, AGENT);
      assert.match(text, row.claim);
      assert.match(text, /daemon-written lines/);
      assert.doesNotMatch(text, /\bmerged\b|your local edits/i);
    });
  }
});

describe("every pattern label on the board and ledger reads as words, never as its machine key", () => {
  const signature = `${RAW_PATTERN}|${AGENT}`;
  const rows = [
    {
      name: "ledger row",
      render: () =>
        visibleText(sandbox.LedgerPlainRowsI({ rows: [{ id: 1, pattern_signature: signature, agent: AGENT, discovered_date: "2026-09-10" }] })),
    },
    {
      name: "live candidate group",
      render: () =>
        visibleText(sandbox.LedgerLiveSectionI({ rows: [{ id: 1, pattern_signature: signature, agent: AGENT, frequency: 2 }], maxFreq: 2, onRowClick: () => {} })),
    },
    {
      name: "applied history row",
      render: () =>
        visibleText(expand(sandbox.AppliedHistoryRowI({ row: { id: 7, target_agent: AGENT, cycle_date: "2026-09-20", pattern_label: signature }, onClick: () => {} }))),
    },
    {
      name: "rejected group label",
      render: () => sandbox.groupByLabelI([{ id: 3, target_agent: AGENT, pattern_label: signature }])[0].label,
    },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const text = row.render();
      assert.ok(text.includes(PATTERN_NAME), text);
      assert.ok(!text.includes(RAW_PATTERN), text);
    });
  }
});

describe("prose on the ledger, banner and drawer is set in sans; mono stays for figures and ids", () => {
  const rows = [
    {
      name: "ledger section head",
      prose: "Inert rows",
      tree: () => sandbox.LedgerSectionHeadI({ label: "Inert rows", basis: "last 7 days", count: 2 }),
    },
    {
      name: "held-cause row",
      prose: "Missing approval",
      tree: () => sandbox.HeldCauseRowsI({ bucket: { cause: "x", label: "Missing approval", count: 1, agents: 1, hint: "h" }, rows: [], isHumanCause: true }),
    },
    {
      name: "recurrence section head",
      prose: "Recurrence rates",
      tree: () =>
        sandbox.LedgerRecurrenceSectionI({
          suppression: { per_cycle: [{ cause: "c", label: "Cause label", hint: "h", agents: 1, cycles: 1, count: 1 }], per_cycle_window_days: 7, per_cycle_window_cycles: 3 },
        }),
    },
    {
      name: "recurrence cause cell",
      prose: "Cause label",
      tree: () => sandbox.RecurrenceRowsI({ buckets: [{ cause: "c", label: "Cause label", hint: "h", agents: 1, cycles: 1, count: 1 }], windowCycles: 3 }),
    },
    {
      name: "parked-loop banner title",
      prose: "Repeat-apply cap",
      tree: () => sandbox.ParkedLoopBannerI({ applyCap: { capped_patterns: 2, capped_agents: 1, rearm_hint: "warn" } }),
    },
    {
      name: "pre-verify verdict and axis label",
      prose: "Scope fidelity",
      tree: () =>
        sandbox.DetailBodyI({
          fields: [],
          sections: [],
          preVerify: { badge: { symbol: "✓", tone: "text-ok", label: "Passed" }, rationale: "", axes: [{ key: "scope", label: "Scope fidelity", value: "narrow" }] },
        }),
    },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = row.tree();
      assert.ok(visibleText(tree).includes(row.prose), visibleText(tree));
      const monoProse = machineTexts(tree).filter((text) => text.includes(row.prose));
      assert.equal(monoProse.length, 0, `${row.name}: mono element carries prose`);
    });
  }
});

describe("each Learning surface is a landmark named for what it holds", () => {
  const idle = { status: "loading", data: null, error: null };
  const rows = [
    { name: "Loop status", tree: () => sandbox.StatusBandI({ asOf: null, statsState: idle, listState: idle, learningLogState: idle, suppression: null, awaiting: 0 }) },
    { name: "Suggestion board", tree: () => sandbox.KanbanCardI({ state: idle, columnRows: { safety: [], applied: [], rejected: [] } }) },
    { name: "Pattern ledger", tree: () => sandbox.PatternLedgerCardI({ state: idle, suppression: null }) },
    { name: "Loop output", tree: () => sandbox.LoopOutputGroupI({ statsState: idle, loopEventsState: idle, listState: idle }) },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = row.tree();
      assert.equal(tree?.type, "section");
      assert.equal(tree?.props["aria-label"], row.name);
    });
  }
});

test("ledger rows set their label at the body size, leaving the meta size to the date stamp", () => {
  const rows = [{ id: 1, pattern_signature: SIGNATURE, agent: AGENT, discovered_date: "2026-09-10" }];
  const [item] = findAll(sandbox.LedgerPlainRowsI({ rows }), (el) => el.type === "li");

  assert.match(classOf(item), /\bfs-body\b/);
  assert.doesNotMatch(classOf(item), /\bfs-meta\b/);
  const [stamp] = findAll(item, (el) => visibleText(el) === "2026-09-10" && el.type === "span");
  assert.ok(stamp, "the first-seen date reads YYYY-MM-DD");
  assert.match(classOf(stamp), /\bfs-meta\b/);
  assert.ok(!machineTexts(item).includes("2026-09-10"), "a date is set in sans");
});

test("a live candidate group heads its rows at the body size", () => {
  const tree = sandbox.LedgerLiveSectionI({ rows: [{ id: 1, pattern_signature: SIGNATURE, agent: AGENT, frequency: 2 }], maxFreq: 2, onRowClick: () => {} });
  const [head] = findAll(tree, (el) => typeof el.props.title === "string" && el.props.title.length > 0 && el.type === "div");

  assert.match(classOf(head), /\bfs-body\b/);
});

test("a suggestion board row sets its title at the body size, leaving ids and dates at the meta size", () => {
  const tree = sandbox.BoardRowI({ onClick: () => {}, lead: null, text: "Keep retries bounded", trail: null });
  const [title] = findAll(tree, (el) => visibleText(el) === "Keep retries bounded" && el.type === "span");

  assert.ok(title, "the board row prints its title");
  assert.match(classOf(title), /\bfs-body\b/);
  assert.doesNotMatch(classOf(title), /\bfs-meta\b/);
});

test("the rejected column header never wraps its label, count or basis", () => {
  const tree = sandbox.RejectedHeaderI({ rowCount: 4, summary: null, label: "Rejected", symbol: "✕" });

  assert.ok(tree, "the rejected header renders nothing");
  assert.match(classOf(tree), /\bwhitespace-nowrap\b/);
});

test("the rejected column header's basis ellipsizes with its full text in the title", () => {
  const tree = sandbox.RejectedHeaderI({ rowCount: 4, summary: { window_days: 30, total: 12 }, label: "Rejected", symbol: "✕" });
  const [basis] = findAll(tree, (el) => /\btruncate\b/.test(classOf(el)));

  assert.ok(basis, "the basis is the header's truncating slot");
  assert.equal(visibleText(basis), "of the latest 50");
  assert.equal(basis.props.title, "of the latest 50", "a clipped basis keeps its whole text in the title");
});

test("the drawer keeps the full review stamp in the title only", () => {
  const tree = sandbox.DetailBodyI(sandbox.buildDetailPropsI({ id: 1, approval_tier: "auto", reviewed_at: "2026-09-10T05:20:07Z" }));
  const stamped = findAll(tree, (el) => typeof el.props.title === "string" && el.props.title.includes("2026-09-10 14:20:07"));
  assert.equal(stamped.length, 1);
  assert.equal(visibleText(stamped[0]), "09-10 14:20");
});

test("a learning status the board does not know keeps its word, and a missing one reads None", () => {
  const getBadge = (sandbox as unknown as { learningStatusBadgeI: (s: unknown) => { label: string } }).learningStatusBadgeI;
  assert.equal(getBadge(null).label, "None");
  assert.equal(getBadge("archived").label, "archived");
});

test("the drawer names the approval tier in words, never echoing the raw tier key", () => {
  const text = visibleText(sandbox.DetailBodyI(sandbox.buildDetailPropsI({ id: 1, approval_tier: "auto" })));

  assert.ok(!text.includes("auto (auto)"), text);
});

// the drawer's fields, each drawn through the shared DetailField → its dt / dd pair
function getDrawerFacts(tree: unknown): unknown[] {
  const fields = findAll(tree, (el) => el.type === sandbox.window.UI.DetailField);
  return fields.map((field) => (field.type as (props: unknown) => unknown)(field.props));
}

describe("the drawer prints each field in words, never the stored machine key", () => {
  const row = {
    id: 42,
    status: "rejected",
    approval_tier: "auto",
    classification: "apply",
    target_file: "/Users/x/.claude/agents/glass-atrium-dev-shell.md",
    cycle_date: "2026-09-10",
    haiku_status: "skipped:quota-limit",
    cost_guard_state: "warn",
    reviewed_at: "2026-09-10T05:20:07Z",
  };
  const facts = getDrawerFacts(sandbox.DetailBodyI(sandbox.buildDetailPropsI(row)));
  const terms = findAll(facts, (el) => el.type === "dt");
  const values = findAll(facts, (el) => el.type === "dd");
  const valueOf = (label: string) => values[terms.findIndex((el) => visibleText(el) === label)];
  const rows = [
    { name: "status", label: "Status", printed: "Rejected", mono: false },
    { name: "classification", label: "Classification", printed: "Recommended to apply", mono: false },
    { name: "model check", label: "Model check", printed: "Skipped — quota limit", mono: false },
    { name: "cost guard", label: "Cost guard", printed: "Quota or budget cap hit", mono: false },
    { name: "cycle date", label: "Cycle date", printed: "2026-09-10", mono: false },
    { name: "review time in the Day + time form", label: "Reviewed at", printed: "09-10 14:20", mono: false },
    { name: "target file path", label: "Target file", printed: row.target_file, mono: true },
  ];
  for (const item of rows) {
    test(item.name, () => {
      const value = valueOf(item.label);

      assert.ok(value, `${item.label} is printed`);
      assert.equal(visibleText(value), item.printed);
      assert.equal(machineTexts(value).includes(item.printed), item.mono, `${item.label} mono`);
    });
  }
});

// a date is never mono: the face prints the short form, the full stamp rides the hover title
describe("the pattern drawer prints its dates in sans, the full stamp on hover only", () => {
  const row = { kind: "pattern", id: 7, agent: AGENT, discovered_date: "2026-11-22", last_updated: "2026-11-22T09:30:00.123Z" };
  const facts = getDrawerFacts(sandbox.DetailBodyI(sandbox.buildDetailPropsI(row)));
  const terms = findAll(facts, (el) => el.type === "dt");
  const values = findAll(facts, (el) => el.type === "dd");
  const valueOf = (label: string) => values[terms.findIndex((el) => visibleText(el) === label)];
  const rows = [
    { name: "first-seen day", label: "First seen", printed: "2026-11-22", title: undefined },
    { name: "last update in the Day + time form", label: "Last updated", printed: "11-22 18:30", title: "2026-11-22 18:30:00 KST" },
  ];
  for (const item of rows) {
    test(item.name, () => {
      const value = valueOf(item.label);

      assert.ok(value, `${item.label} is printed`);
      assert.equal(visibleText(value), item.printed);
      assert.deepEqual(machineTexts(value), [], `${item.label} drawn in mono`);
      const titled = findAll(value, (el) => typeof el.props.title === "string").map((el) => el.props.title);
      assert.deepEqual(titled, item.title ? [item.title] : []);
      assert.ok(findAll(value, (el) => /\btnum\b/.test(classOf(el))).length > 0, `${item.label} digits tabular`);
    });
  }
});

test("the cycle breakdown names its window in the short form the band's Applied, 7d uses", () => {
  const screen = sandbox as unknown as Record<string, Component>;
  assert.match(visibleText(screen.CycleDecompositionRowI({ stats: {} })), /^Cycles, 7d /);
});

describe("Learning labels read in sentence case, never letter-spaced capitals", () => {
  const screen = sandbox as unknown as Record<string, Component>;
  const rows = [
    {
      name: "pattern drawer",
      tree: () => sandbox.DetailBodyI(sandbox.buildDetailPropsI({ kind: "pattern", id: 7, pattern_signature: SIGNATURE, agent: AGENT, example: "e", last_transition_reason: "r" })),
      label: /Last transition|LAST TRANSITION/,
    },
    {
      name: "suggestion drawer with a pre-verify result",
      tree: () => sandbox.DetailBodyI(sandbox.buildDetailPropsI({ id: 9, approval_tier: "auto", pattern_label: "Scope note", rationale: "Repeated overrun", pre_verify_status: "failed", pre_verify_passed: false, pre_verify_rationale: "One axis failed", pre_verify_axes: { C1: true, C4: false } })),
      label: /Pattern label[\s\S]*Rationale[\s\S]*Pre-verify/,
    },
    { name: "cycle breakdown", tree: () => screen.CycleDecompositionRowI({ stats: {} }), label: /Cycles, 7d/ },
    { name: "not-judged rejected row", tree: () => screen.RejectedCompactListI({ rows: [{ id: 3, summary: "s", status: "unadjudicated", cycle_date: "2026-09-10" }], onRowClick: () => {} }), label: /Not judged/ },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree: RecordedElement[] = [];
      findRendered(row.tree(), (el) => {
        tree.push(el);
        return false;
      });
      assert.match(visibleText(row.tree()), row.label);
      const capped = tree.filter((el) => /\b(uppercase|tracking-wider)\b/.test(classOf(el)));
      assert.deepEqual(capped.map((el) => visibleText(el)), []);
      const shouted = tree.map((el) => visibleText(el).trim()).filter((text) => /^[A-Z][A-Z -]{3,}$/.test(text));
      assert.deepEqual(shouted, [], "a label typed in capitals");
    });
  }
});
