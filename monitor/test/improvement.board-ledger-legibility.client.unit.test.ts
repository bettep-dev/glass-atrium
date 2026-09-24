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
  const tree = sandbox.AppliedHistoryRowI({ row, onClick: () => {} });
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
