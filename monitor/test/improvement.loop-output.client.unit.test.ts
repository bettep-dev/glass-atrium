// Render guards for the Learning page's loop-output cards in public/src/screens/improvement.jsx.
// Protects two contracts: every count names the population it was taken over, and the
// trend reaches keyboard and screen-reader users through the shared TrendChart atom.
//
// Runner: npx tsx --test test/improvement.loop-output.client.unit.test.ts

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

interface LoopEvent {
  event_ts: string;
  eval_result: string;
  changes_added?: number;
  changes_removed?: number;
}

interface LoopAggregate {
  eventCount: number;
  trend: Array<{ date: string; verified: number; reject: number }>;
}

interface LoopSandbox {
  React: { createElement: unknown };
  window: { UI: Record<string, unknown> };
  deriveLoopAggregateI: (data: { events: LoopEvent[] }) => LoopAggregate;
  getLoopBasisI: (aggregate: LoopAggregate) => { text: string; title: string };
  ChangeSummaryCardI: (props: Record<string, unknown>) => RecordedElement;
  TrendCardI: (props: Record<string, unknown>) => RecordedElement;
  BucketRowI: (props: Record<string, unknown>) => RecordedElement;
  RejectRateHeadlineI: (props: Record<string, unknown>) => RecordedElement;
  getRejectRatePhraseI: (
    before: { count: number; total: number },
    after: { count: number; total: number },
  ) => string;
}

function isElement(value: unknown): value is RecordedElement {
  return typeof value === "object" && value !== null && "props" in value && "type" in value;
}

function collectElements(node: unknown, out: RecordedElement[]): RecordedElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (!isElement(node)) return out;
  out.push(node);
  const children = node.props.children;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) collectElements(child, out);
  return out;
}

function getEvents(days: string[], perDay: number): LoopEvent[] {
  return days.flatMap((day) =>
    Array.from({ length: perDay }, (_, i) => ({
      event_ts: `${day}T0${i % 10}:00:00Z`,
      eval_result: i % 3 === 0 ? "reject" : "verified",
    })),
  );
}

const sandbox = await buildScreenSandbox<LoopSandbox>(IMPROVEMENT_SRC);
sandbox.React.createElement = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => ({
  type,
  props: { ...(props ?? {}), children: rest.length > 1 ? rest : rest[0] },
});
function CardHead() {
  return null;
}
function TrendChart() {
  return null;
}
Object.assign(sandbox.window.UI, {
  CardHead,
  TrendChart,
  titleOf: (value: unknown) => value,
  formatPctWithDenominator: (count: number, total: number) => `${count}/${total}`,
  isLowSample: (n: number) => Number.isFinite(n) && n >= 0 && n < 30,
  LowSampleMark: function LowSampleMark() {
    return null;
  },
});

const READY = { status: "ready" };
// the loop-events URL fetches at most this many rows, newest first
const FETCH_CAP = 200;

const ROWS = {
  // the header line holds a qualified count; the hover title adds the shortest date span that stays unambiguous
  BASIS: [
    {
      name: "a count cut at the row limit reads as the latest cycles, dated in the hover title",
      days: ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"],
      perDay: FETCH_CAP / 4,
      expected: { text: `Last ${FETCH_CAP} cycles`, title: `Last ${FETCH_CAP} cycles · 09/20–09/23` },
    },
    {
      name: "a count under the row limit reads as every recorded cycle",
      days: ["2026-09-24", "2026-09-25"],
      perDay: 2,
      expected: { text: "All 4 cycles", title: "All 4 cycles · 09/24–09/25" },
    },
    {
      name: "a span across a year boundary names its years, so no month-day pair is ambiguous",
      days: ["2025-12-31", "2026-01-01"],
      perDay: 2,
      expected: { text: "All 4 cycles", title: "All 4 cycles · 2025–2026" },
    },
  ],
  PHRASE: [
    {
      name: "both halves scored → recent count leads over its days, earlier count names its own",
      before: { count: 4, total: 5, days: 2 },
      after: { count: 3, total: 5, days: 3 },
      expected: "3 of 5 rejected in the latest 3 cycle days (4 of 5 in the 2 before)",
    },
    {
      name: "no earlier scored cycle → recent count alone, still over its days",
      before: { count: 0, total: 0, days: 1 },
      after: { count: 2, total: 7, days: 2 },
      expected: "2 of 7 rejected in the latest 2 cycle days",
    },
    {
      name: "no recent scored cycle → no count to state",
      before: { count: 1, total: 4, days: 2 },
      after: { count: 0, total: 0, days: 2 },
      expected: "No scored cycles yet",
    },
  ],
};

describe("the loop basis names its count on the header line and its dates in the hover title", () => {
  for (const row of ROWS.BASIS) {
    test(row.name, () => {
      const aggregate = sandbox.deriveLoopAggregateI({ events: getEvents(row.days, row.perDay) });

      assert.deepEqual({ ...sandbox.getLoopBasisI(aggregate) }, row.expected);
    });
  }
});

test("both loop cards head their numbers with the same stated basis", () => {
  const aggregate = sandbox.deriveLoopAggregateI({
    events: getEvents(["2026-09-24", "2026-09-25"], 3),
  });
  const basis = sandbox.getLoopBasisI(aggregate);

  for (const card of [sandbox.ChangeSummaryCardI, sandbox.TrendCardI]) {
    const heads = collectElements(card({ state: READY, aggregate }), []).filter(
      (el) => el.type === CardHead,
    );
    assert.deepEqual(
      heads.map((el) => {
        const meta = el.props.sub as RecordedElement;
        return { text: meta.props.children, title: meta.props.title };
      }),
      [{ ...basis }],
      `${card.name} states the basis once`,
    );
  }
});

test("the trend plots one chart of the daily reject share, ticked by MM/DD and thinned to five", () => {
  const events = [
    ...getEvents(["2026-09-23", "2026-09-24", "2026-09-25"], 3),
    { event_ts: "2026-09-26T00:00:00Z", eval_result: "skipped" },
  ];
  const aggregate = sandbox.deriveLoopAggregateI({ events });

  const charts = collectElements(sandbox.TrendCardI({ state: READY, aggregate }), []).filter(
    (el) => el.type === TrendChart,
  );

  assert.equal(charts.length, 1, "verified and rejected share one axis");
  const points = charts[0].props.points as Array<{ label: string; value: number | null }>;
  assert.deepEqual(
    Array.from(points, (p) => p.label),
    ["09/23", "09/24", "09/25", "09/26"],
  );
  assert.deepEqual(
    Array.from(points, (p) => (p.value === null ? null : Math.round(p.value * 1000) / 1000)),
    [0.333, 0.333, 0.333, null],
    "a day with no scored cycle is a gap, never a zero",
  );
  assert.equal(charts[0].props.maxTicks, 5);
  assert.ok(typeof charts[0].props.label === "string" && (charts[0].props.label as string).length > 0);
});

describe("the reject rate reads as counts, never a percentage", () => {
  for (const row of ROWS.PHRASE) {
    test(row.name, () => {
      assert.equal(sandbox.getRejectRatePhraseI(row.before, row.after), row.expected);
    });
  }
});

// the phrase itself is pinned by the table above; this guards that the card is fed both halves
test("the trend card carries the reject-rate headline over the aggregate's halves, clear of its title", () => {
  const events = getEvents(["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"], 3);
  const aggregate = sandbox.deriveLoopAggregateI({ events }) as LoopAggregate & {
    failBefore: { days: number };
    failAfter: { days: number };
  };
  const tree = collectElements(sandbox.TrendCardI({ state: READY, aggregate }), []);

  const head = tree.find((el) => el.type === CardHead);
  const headline = tree.find((el) => el.type === sandbox.RejectRateHeadlineI);
  assert.equal(head?.props.right, undefined, "the head row holds only the title and its basis, so neither is cut");
  assert.equal(headline?.props.before, aggregate.failBefore);
  assert.equal(headline?.props.after, aggregate.failAfter);
  assert.equal(aggregate.failBefore.days + aggregate.failAfter.days, 4, "the halves split the plotted days");
});

test("the all-days totals name their window, so they never read as the recent half's count", () => {
  const events = getEvents(["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"], 3);
  const aggregate = sandbox.deriveLoopAggregateI({ events });
  const totals = collectElements(sandbox.TrendCardI({ state: READY, aggregate }), []).find(
    (el) => typeof el.props.children === "string" && (el.props.children as string).includes("verified"),
  );

  assert.match(String(totals?.props.children), /all 4 cycle days: \d+ verified · \d+ rejected/);
});

test("the trend plots from a zero baseline with room to read, and short y labels", () => {
  const events = getEvents(["2026-09-22", "2026-09-23", "2026-09-24"], 3);
  const aggregate = sandbox.deriveLoopAggregateI({ events });
  const chart = collectElements(sandbox.TrendCardI({ state: READY, aggregate }), []).find(
    (el) => el.type === TrendChart,
  );
  const formatValue = chart?.props.formatValue as (v: number) => string;

  assert.equal(chart?.props.kind, "bars", "a share per day starts at zero, never at the lowest day");
  assert.ok(Number(chart?.props.h) >= 96, "a 64px plot flattens a daily share");
  assert.equal(formatValue(0.8), "80%", "the axis names the share once; labels stay short enough to fit");
});

function getPrintedText(node: RecordedElement): string {
  return collectElements(node, [])
    .flatMap((el) => (Array.isArray(el.props.children) ? el.props.children : [el.props.children]))
    .filter((child) => typeof child === "string" || typeof child === "number")
    .join(" ");
}

test("the applied card counts the cycles that changed rule lines out of every cycle in its basis", () => {
  const edits = [
    { added: 4, removed: 0 },
    { added: 0, removed: 2 },
    { added: 0, removed: 0 },
    { added: 0, removed: 0 },
    { added: 1, removed: 1 },
  ];
  const events = edits.map((edit, i) => ({
    event_ts: `2026-09-2${i}T01:00:00Z`,
    eval_result: "verified",
    changes_added: edit.added,
    changes_removed: edit.removed,
  }));
  const aggregate = sandbox.deriveLoopAggregateI({ events });
  const text = getPrintedText(sandbox.ChangeSummaryCardI({ state: READY, aggregate }));

  assert.ok(text.includes("3 of 5 cycles changed rule lines"), text);
});

const LOOP_SLOTS = ["i-loop-metric", "i-loop-visual", "card-foot"];

function getLoopCards() {
  const aggregate = sandbox.deriveLoopAggregateI({ events: getEvents(["2026-09-24", "2026-09-25"], 3) });
  const buckets = { ctm: 12, epm: 4, outcome: null, joinMeta: null };
  return [
    { name: "applied", card: sandbox.ChangeSummaryCardI({ state: READY, aggregate }) },
    { name: "trend", card: sandbox.TrendCardI({ state: READY, aggregate }) },
    { name: "learning memory", card: sandbox.BucketRowI({ state: READY, buckets }) },
  ];
}

function getSlotOf(card: RecordedElement, slot: string): RecordedElement[] {
  return collectElements(card, []).filter((el) => new RegExp(`\\b${slot}\\b`).test(String(el.props.className ?? "")));
}

describe("every loop card stacks one metric, one visual and one pinned foot, in that order", () => {
  for (const { name, card } of getLoopCards()) {
    test(name, () => {
      const order = collectElements(card, [])
        .map((el) => LOOP_SLOTS.find((slot) => new RegExp(`\\b${slot}\\b`).test(String(el.props.className ?? ""))))
        .filter(Boolean);
      assert.deepEqual(order, LOOP_SLOTS, `${name}: slots ${order.join(" > ")}`);
    });
  }
});

test("the applied card leads with its reject rate, in the metric slot", () => {
  const [applied] = getLoopCards();
  const [metric] = getSlotOf(applied.card, "i-loop-metric");
  assert.ok(metric && collectElements(metric, []).some((el) => el.type === sandbox.RejectRateHeadlineI), "the reject rate heads the card");
});

test("the learning-memory card heads its card with both counts, its tiles keeping only what each count means", () => {
  const [, , { card }] = getLoopCards();
  const [metric] = getSlotOf(card, "i-loop-metric");
  const [visual] = getSlotOf(card, "i-loop-visual");
  const metricText = getPrintedText(metric);

  assert.match(metricText, /\b12\b/, metricText);
  assert.match(metricText, /\b4\b/, metricText);
  assert.doesNotMatch(getPrintedText(visual), /\b12\b|\b4\b/, "a count printed twice reads as two figures");
});
