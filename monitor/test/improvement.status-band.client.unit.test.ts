// Render guards for the status band in public/src/screens/improvement.jsx.
//
// The band replaced the KPI row to honour one standing decision: every payload
// renders loading, empty, error and unavailable distinctly, and nothing may read as
// a zero that was never loaded. That contract is the band's only reason to exist and
// nothing asserted it — `tileStatusI` is pure, and `TilePlaceholderI` / `StatusTileI`
// render in the same recording-`createElement` harness the sibling client guards use.
//
// The last test is a unit guard, not a state guard: a tile's value and its population
// must be counted over the same table, which is what "no count without its population"
// buys. Same harness limit as the sibling guards — the emitted element tree, not CSS.
//
// Runner: npx tsx --test test/improvement.status-band.client.unit.test.ts

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

interface BandSandbox {
  React: { createElement: unknown };
  window: { UI: Record<string, unknown> };
  tileStatusI: (state: { status: string }, value: unknown) => string;
  TilePlaceholderI: (props: {
    status: string;
    label: string;
    onRetry?: unknown;
  }) => RecordedElement;
  StatusTileI: (props: Record<string, unknown>) => RecordedElement;
  StatusBandI: (props: Record<string, unknown>) => RecordedElement;
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

// Depth-first concatenation of every string/number leaf, function children left
// uninvoked — every placeholder branch emits host elements only.
function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isElement(node)) return "";
  return Object.values(node.props)
    .filter(
      (v) => Array.isArray(v) || isElement(v) || typeof v === "string" || typeof v === "number",
    )
    .map(textOf)
    .join(" ");
}

const sandbox = await buildScreenSandbox<BandSandbox>(IMPROVEMENT_SRC);
sandbox.React.createElement = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => ({
  type,
  props: { ...(props ?? {}), children: rest.length > 1 ? rest : rest[0] },
});
Object.assign(sandbox.window.UI, { titleOf: (value: unknown) => value });

// The relationship, not four hand-picked pairs: the tile's state is the payload's
// state, except that a landed payload carrying no value is "unavailable", never ready.
test("a tile's state follows its own payload, and a missing value is never ready", () => {
  assert.equal(sandbox.tileStatusI({ status: "loading" }, { n: 1 }), "loading");
  assert.equal(sandbox.tileStatusI({ status: "error" }, { n: 1 }), "error");
  assert.equal(sandbox.tileStatusI({ status: "ready" }, null), "unavailable");
  assert.equal(sandbox.tileStatusI({ status: "ready" }, undefined), "unavailable");
  assert.equal(sandbox.tileStatusI({ status: "ready" }, { n: 1 }), "ready");
});

// The discriminating assertion: three non-ready states must be told apart, and none
// of them may put a number where the value goes.
test("the three non-ready states render distinctly", () => {
  const retries: string[] = [];
  const shapes = ["loading", "error", "unavailable"].map((status) => {
    const tree = sandbox.TilePlaceholderI({
      status,
      label: "Applied (7 days)",
      onRetry: () => retries.push(status),
    });
    const nodes = collectElements(tree, []);
    return {
      status,
      placeholder: nodes.find((el) => el.type === sandbox.window.UI.LoadingPlaceholder),
      retry: nodes.filter((el) => el.type === "button"),
      text: textOf(tree),
    };
  });
  const [loading, error, unavailable] = shapes;

  assert.ok(loading?.placeholder, "loading must announce itself through the status-role placeholder");
  assert.equal(loading?.placeholder?.props.label, "Applied (7 days)", "the visible loading text names the tile");
  assert.equal(loading?.retry.length, 0);

  assert.equal(error?.retry.length, 1, "a failed payload must offer a retry");
  (error?.retry[0]?.props.onClick as () => void)();
  assert.deepEqual(retries, ["error"], "the retry button is wired to onRetry");
  assert.ok(!error?.placeholder);

  assert.match(unavailable?.text ?? "", /Not measured/);
  assert.ok(!unavailable?.placeholder);
  assert.equal(unavailable?.retry.length, 0);
});

// The "no unloaded zero" half, stated as the relationship that carries it: for every
// non-ready status the value handed to the tile must not reach the tree at all.
test("a tile that has not landed never renders the value it was handed", () => {
  for (const status of ["loading", "error", "unavailable"]) {
    const tree = sandbox.StatusTileI({
      status,
      tone: "text-ok",
      symbol: "\u2713",
      label: "Applied",
      value: "4242",
      population: "of 12 cycles in the last 7 days",
      onRetry: () => {},
    });
    assert.doesNotMatch(textOf(tree), /4242/, `a ${status} tile leaked its value`);
    assert.ok(
      !collectElements(tree, []).some((el) => el.props.value === "4242"),
      `a ${status} tile passed its value on instead of a placeholder`,
    );
  }
});

test("a ready tile renders its value and its population", () => {
  const tile = sandbox.StatusTileI({
    status: "ready",
    tone: "text-ok",
    symbol: "✓",
    label: "Applied (7 days)",
    value: "3",
    population: "of 12 cycles in the last 7 days",
  });
  assert.equal(tile.props.value, "3");
  assert.equal(tile.props.hint, "of 12 cycles in the last 7 days");
  assert.match(textOf(tile), /Applied \(7 days\)/);
});

// The unit guard: `applied_last_7d` counts proposals and `cycle_total_7d` counts
// cycles, so pairing them reads "3 of 12 cycles were applied" over two tables.
test("the applied tile is counted over the same population it names", () => {
  const stats = {
    applied_last_7d: 9,
    cycles_generated_applied_7d: 3,
    cycle_total_7d: 12,
    latest_cycle_started_at: "2026-09-16T10:00:00.000Z",
    review_flag_last_7d: 2,
  };
  const band = sandbox.StatusBandI({
    statsState: { status: "ready", data: stats },
    listState: { status: "ready", data: {} },
    learningLogState: { status: "ready" },
    suppression: { pending_total: 12, pending_unpromptable: 7 },
    awaiting: 4,
    reviewReasons: null,
    onRetry: () => {},
  });
  const applied = collectElements(band, []).find(
    (el) => el.props.label === "Applied (7 days)",
  );
  assert.ok(applied, "the band must render the applied tile");
  assert.equal(
    applied.props.value,
    "3",
    "the value must be the cycle count its population denominates, not the proposal count",
  );
  assert.match(String(applied.props.population), /cycles in the last 7 days/);
});

test("the decision tile carries the warning glyph only while something awaits a decision", () => {
  const renderAwaiting = (awaiting: number) =>
    collectElements(
      sandbox.StatusBandI({
        statsState: { status: "ready", data: { cycle_total_7d: 1 } },
        listState: { status: "ready", data: {} },
        learningLogState: { status: "ready" },
        suppression: { pending_total: 0, parked: [] },
        awaiting,
        onRetry: () => {},
      }),
      [],
    ).find((el) => el.props.label === "Awaiting your decision");

  const idle = renderAwaiting(0);
  const pending = renderAwaiting(2);

  assert.ok(idle && pending, "the band must render the decision tile");
  assert.equal(idle.props.symbol, null, "a zero count is not a warning");
  assert.equal(pending.props.symbol, "⚠");
  assert.equal(pending.props.tone, "text-warn");
});

test("backlog tiles are counts, not statuses, so they carry no status glyph", () => {
  const band = sandbox.StatusBandI({
    statsState: { status: "ready", data: { cycle_total_7d: 1 } },
    listState: { status: "ready", data: {} },
    learningLogState: { status: "ready" },
    suppression: { pending_total: 5, pending_unpromptable: 1, parked: [] },
    awaiting: 0,
    onRetry: () => {},
  });
  const backlog = collectElements(band, []).filter((el) =>
    ["Backlog that can propose", "Held, needs a human"].includes(String(el.props.label)),
  );

  assert.equal(backlog.length, 2);
  assert.ok(backlog.every((el) => el.props.symbol === null));
});
