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
}

interface LoopAggregate {
  eventCount: number;
  trend: Array<{ date: string; verified: number; reject: number }>;
}

interface LoopSandbox {
  React: { createElement: unknown };
  window: { UI: Record<string, unknown> };
  deriveLoopAggregateI: (data: { events: LoopEvent[] }) => LoopAggregate;
  getLoopBasisI: (aggregate: LoopAggregate) => string;
  ChangeSummaryCardI: (props: Record<string, unknown>) => RecordedElement;
  TrendCardI: (props: Record<string, unknown>) => RecordedElement;
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

test("a cycle count cut at the row limit names its count and dates, never a day window or fetch wording", () => {
  const days = ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"];
  const aggregate = sandbox.deriveLoopAggregateI({
    events: getEvents(days, FETCH_CAP / days.length),
  });

  const basis = sandbox.getLoopBasisI(aggregate);

  assert.match(basis, new RegExp(`Latest ${FETCH_CAP} cycles`));
  assert.doesNotMatch(basis, /fetch cap/);
  assert.match(basis, /2026-09-20 to 2026-09-23/);
  assert.doesNotMatch(basis, /days/);
});

test("a cycle count under the fetch cap reads as every recorded cycle", () => {
  const aggregate = sandbox.deriveLoopAggregateI({
    events: getEvents(["2026-09-24", "2026-09-25"], 2),
  });

  assert.equal(sandbox.getLoopBasisI(aggregate), "All 4 recorded cycles, 2026-09-24 to 2026-09-25");
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
      heads.map((el) => el.props.sub),
      [basis],
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

const PHRASE_ROWS = [
  {
    name: "both halves scored → recent count leads, earlier count follows",
    before: { count: 4, total: 5 },
    after: { count: 3, total: 5 },
    expected: "3 of 5 rejected (was 4 of 5)",
  },
  {
    name: "no earlier scored cycle → recent count alone",
    before: { count: 0, total: 0 },
    after: { count: 2, total: 7 },
    expected: "2 of 7 rejected",
  },
  {
    name: "no recent scored cycle → no count to state",
    before: { count: 1, total: 4 },
    after: { count: 0, total: 0 },
    expected: "No scored cycles yet",
  },
];

describe("the reject rate reads as counts, never a percentage", () => {
  for (const row of PHRASE_ROWS) {
    test(row.name, () => {
      assert.equal(sandbox.getRejectRatePhraseI(row.before, row.after), row.expected);
    });
  }
});

// the phrase itself is pinned by the table above; this guards that the head is fed both halves
test("the trend card head carries the reject-rate headline over the aggregate's halves", () => {
  const events = getEvents(["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"], 3);
  const aggregate = sandbox.deriveLoopAggregateI({ events }) as LoopAggregate & {
    failBefore: unknown;
    failAfter: unknown;
  };

  const head = collectElements(sandbox.TrendCardI({ state: READY, aggregate }), []).find(
    (el) => el.type === CardHead,
  );

  const headline = head?.props.right as RecordedElement | undefined;
  assert.equal(headline?.type, sandbox.RejectRateHeadlineI);
  assert.equal(headline?.props.before, aggregate.failBefore);
  assert.equal(headline?.props.after, aggregate.failAfter);
});
