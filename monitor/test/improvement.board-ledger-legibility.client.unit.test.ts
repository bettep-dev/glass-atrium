// Legibility guards for the Learning screen's suggestion board and pattern ledger
// (public/src/screens/improvement.jsx): every board count states its window, applied
// history reads as one line, and no fact is printed twice in a row or a group.
//
// Same harness as improvement.loop-suppression.client.unit.test.ts: components run
// over the shipped source with a recording React.createElement, so these assert the
// emitted element tree, not computed CSS.
//
// Runner: npx tsx --test test/improvement.board-ledger-legibility.client.unit.test.ts

import test from "node:test";
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
  groupByLabelI: (rows: unknown[]) => Array<{ label: string; rows: unknown[] }>;
  AppliedHistoryRowI: Component;
  RejectedGroupI: Component;
  LedgerPlainRowsI: Component;
  CandidateRowI: Component;
  RecurrenceRowsI: Component;
  KanbanCardI: Component;
  KanbanColumnI: Component;
  CompactProposalCardI: Component;
  ViewToggleI: Component;
  LoopOutputGroupI: Component;
  AppliedHeroHeaderI: Component;
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
  assert.ok(text.includes("size est overrun concentration"), text);
  assert.ok(!text.includes("|"), text);
});

test("a live candidate row names its agent once, never as a label suffix", () => {
  const pattern = { id: 1, pattern_signature: SIGNATURE, agent: AGENT, frequency: 3, status: "identified" };
  const text = visibleText(sandbox.CandidateRowI({ rank: 1, pattern, maxFreq: 3, onClick: () => {} }));
  assert.equal(occurrences(text, AGENT), 1, text);
  assert.ok(!text.includes("|"), text);
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
  assert.ok(text.includes(AGENT) && text.includes("size est overrun concentration"), text);
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

test("the board header states the window its applied and rejected counts cover", () => {
  const tree = sandbox.KanbanCardI({
    state: { status: "ready", data: {} },
    columnRows: { safety: [], applied: [], rejected: [] },
    onRowClick: () => {},
    onRetry: () => {},
  });
  const [head] = findAll(tree, (el) => el.props.title === "Suggestion board");
  assert.ok(head, "board header missing");
  assert.match(String(head.props.sub), /latest 50 suggestions/);
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

test("the view toggle is a segmented control whose pressed option alone carries aria-pressed", () => {
  for (const view of ["operator", "instrumentation"]) {
    const tree = sandbox.ViewToggleI({ view, onChange: () => {} });
    assert.ok(tree && /\bseg\b/.test(classOf(tree)), "toggle must use the shared .seg selected-state control");
    const buttons = findAll(tree, (el) => el.type === "button");
    assert.equal(buttons.length, 2);
    const pressed = buttons.filter((b) => b.props["aria-pressed"] === true).map((b) => visibleText(b));
    assert.equal(pressed.length, 1, view);
    assert.match(pressed[0], view === "operator" ? /Operator/ : /Instrumentation/);
    for (const b of buttons) assert.doesNotMatch(classOf(b), /\btext-(ink|faint)\b/, "a colour class would mask the selected fill");
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
    assert.doesNotMatch(classOf(prose[0]), /font-mono/);
    assert.match(classOf(prose[0]), /\bmin-w-0\b/);
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
});

test("loop output captions wrap and its cards reflow instead of squeezing three abreast", () => {
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
  assert.ok(tree && /\bi-loop-output\b/.test(classOf(tree)), "caption wrap scope missing");
  const grids = findAll(tree, (el) => /\bi-loop-grid\b/.test(classOf(el)));
  assert.equal(grids.length, 1);
  assert.doesNotMatch(classOf(grids[0]), /\bgrid-cols-3\b/);
});

test("a ledger row sets its pattern label in sans and keeps mono for the date", () => {
  const rows = [{ id: 1, pattern_signature: SIGNATURE, agent: AGENT, discovered_date: "2026-09-10" }];
  const tree = sandbox.LedgerPlainRowsI({ rows });
  const [item] = findAll(tree, (el) => el.type === "li");
  assert.doesNotMatch(classOf(item), /font-mono/);
  const [label] = findAll(item, (el) => el.props.title !== undefined);
  assert.doesNotMatch(classOf(label), /font-mono/);
});
