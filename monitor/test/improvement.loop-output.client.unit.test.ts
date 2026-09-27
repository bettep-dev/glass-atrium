// Render guards for the Learning page's loop-output cards in public/src/screens/improvement.jsx.
// Protects two contracts: every count names the population it was taken over, and the
// trend reaches keyboard and screen-reader users through the shared TrendChart atom.
//
// Runner: npx tsx --test test/improvement.loop-output.client.unit.test.ts

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
      eval_result: i % 3 === 0 ? "rejected" : "verified",
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
});

const READY = { status: "ready" };
// the loop-events URL fetches at most this many rows, newest first
const FETCH_CAP = 200;

test("a cycle count cut at the fetch cap names the cap and its dates, never a day window", () => {
  const days = ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"];
  const aggregate = sandbox.deriveLoopAggregateI({
    events: getEvents(days, FETCH_CAP / days.length),
  });

  const basis = sandbox.getLoopBasisI(aggregate);

  assert.match(basis, new RegExp(`Latest ${FETCH_CAP} cycles`));
  assert.match(basis, /fetch cap/);
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

test("the trend renders one focusable chart per series, each point labelled by its day", () => {
  const aggregate = sandbox.deriveLoopAggregateI({
    events: getEvents(["2026-09-23", "2026-09-24", "2026-09-25"], 3),
  });

  const charts = collectElements(sandbox.TrendCardI({ state: READY, aggregate }), []).filter(
    (el) => el.type === TrendChart,
  );

  assert.deepEqual(
    charts.map((el) => JSON.stringify(el.props.points)),
    [
      JSON.stringify(aggregate.trend.map((d) => ({ label: d.date, value: d.verified }))),
      JSON.stringify(aggregate.trend.map((d) => ({ label: d.date, value: d.reject }))),
    ],
  );
  assert.ok(charts.every((el) => typeof el.props.label === "string" && el.props.label.length > 0));
});
