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
  getBandVerdictI: (input: Record<string, unknown>) => { tone: string; sentence: string };
  getInstrumentationChipsI: (
    verdicts: unknown,
    styleRef: unknown,
    corpusAuditState: unknown,
  ) => Array<Record<string, unknown>>;
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
// Installed once → every test sees the same UI, whatever order they run in.
const PageVerdictStub = () => null;
Object.assign(sandbox.window.UI, { titleOf: (value: unknown) => value, PageVerdict: PageVerdictStub });

// the shared first-read note ui.jsx shows while a page has nothing read yet
function getUnreadCheckingNote(): string {
  // sandbox types window.UI loosely; ui.jsx exports getFreshnessVerdict with this shape
  const getVerdict = sandbox.window.UI.getFreshnessVerdict as (input: Record<string, unknown>) => { note: string };
  return getVerdict({ at: null, loading: true }).note;
}

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
  assert.match(String(applied.props.population), /of 12 cycles/);
  assert.match(String(applied.props.basis), /last 7 days/);
});

test("the decision tile reads ok at zero and warns while something awaits a decision", () => {
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
  assert.equal(idle.props.symbol, "✓", "an empty decision queue is good news, not a blank");
  assert.equal(idle.props.tone, "text-ok");
  assert.equal(pending.props.symbol, "⚠");
  assert.equal(pending.props.tone, "text-warn");
});

const renderBand = (suppression: unknown, awaiting = 0) =>
  sandbox.StatusBandI({
    statsState: { status: "ready", data: { cycle_total_7d: 1, cycles_generated_applied_7d: 1 } },
    listState: { status: "ready", data: {} },
    learningLogState: { status: "ready" },
    suppression,
    awaiting,
    onRetry: () => {},
  });

test("the backlog tile is a count, not a status, so it carries no status glyph", () => {
  const backlog = collectElements(
    renderBand({ pending_total: 5, pending_unpromptable: 1, parked: [] }),
    [],
  ).filter((el) => el.props.label === "Backlog that can propose");

  assert.equal(backlog.length, 1);
  assert.equal(backlog[0].props.symbol, null);
});

test("the held tile warns only while a held pattern needs a human", () => {
  const heldTile = (parked: unknown[]) =>
    collectElements(renderBand({ pending_total: 0, parked }), []).find(
      (el) => el.props.label === "Held, needs a human",
    );
  const byDesign = heldTile([{ cause: "non-promptable", count: 4, agents: 2 }]);
  const needsHuman = heldTile([{ cause: "repeat-apply-cap", count: 2, agents: 1 }]);

  assert.equal(byDesign?.props.symbol, null, "rows closed by a design decision wait on no one");
  assert.equal(needsHuman?.props.symbol, "⚠");
  assert.equal(needsHuman?.props.tone, "text-warn");
});

const verdictRows = [
  {
    name: "nothing waiting on a human reads ok",
    input: { status: "ready", awaiting: 0, applied: 2, heldNeedingHuman: 0 },
    tone: "ok",
    mentions: ["2 applied"],
  },
  {
    name: "an awaiting decision warns and is counted",
    input: { status: "ready", awaiting: 3, applied: 0, heldNeedingHuman: 0 },
    tone: "warn",
    mentions: ["3 awaiting"],
  },
  {
    name: "a held pattern needing a human warns and is counted",
    input: { status: "ready", awaiting: 0, applied: 1, heldNeedingHuman: 10 },
    tone: "warn",
    mentions: ["10 held"],
  },
  {
    name: "a band that has not landed claims no status",
    input: { status: "loading", awaiting: 0, applied: 0, heldNeedingHuman: 0 },
    tone: "neutral",
    mentions: [getUnreadCheckingNote()],
  },
  {
    name: "a band whose payload failed says so and makes no loading claim",
    input: { status: "error", awaiting: 0, applied: 0, heldNeedingHuman: 0 },
    tone: "neutral",
    mentions: ["could not load"],
  },
];
for (const row of verdictRows) {
  test(`band verdict: ${row.name}`, () => {
    const verdict = sandbox.getBandVerdictI(row.input);
    assert.equal(verdict.tone, row.tone);
    for (const mention of row.mentions) assert.ok(verdict.sentence.includes(mention), verdict.sentence);
  });
}

test("a failed band payload reads as a failure, never as still loading", () => {
  const band = sandbox.StatusBandI({
    statsState: { status: "error", data: null, error: "HTTP 500" },
    listState: { status: "ready", data: {} },
    learningLogState: { status: "loading" },
    suppression: null,
    awaiting: 0,
    onRetry: () => {},
  });
  const verdict = collectElements(band, []).find((el) => el.type === PageVerdictStub);

  assert.match(String(verdict?.props.children), /could not load/);
  assert.ok(!String(verdict?.props.children).includes(getUnreadCheckingNote()));
});

test("the band states its verdict before the tiles", () => {
  const elements = collectElements(renderBand({ pending_total: 0, parked: [] }, 2), []);
  const verdictAt = elements.findIndex((el) => el.type === PageVerdictStub);
  const firstTileAt = elements.findIndex((el) => el.props.label === "Awaiting your decision");

  assert.ok(verdictAt >= 0, "the band must render a verdict line");
  assert.equal(elements[verdictAt].props.tone, "warn");
  assert.match(String(elements[verdictAt].props.children), /2 awaiting/);
  assert.ok(verdictAt < firstTileAt, "the verdict is read before the numbers it summarises");
});

test("instrumentation chips take each verdict from the instrumentation view's own rules", () => {
  const calls: unknown[][] = [];
  const latest = { id: 7 };
  const verdicts = {
    styleRefGradeBadgeI: (emission: unknown, uncorroborated: unknown) => {
      calls.push(["style", emission, uncorroborated]);
      return { symbol: "⚠", tone: "text-warn", label: "warn", hint: "h1" };
    },
    getCorpusGrowthVerdictI: (reading: unknown) => {
      calls.push(["corpus", reading]);
      return { symbol: "✓", tone: "text-ok", label: "within threshold", hint: "h2" };
    },
  };
  const chips = sandbox.getInstrumentationChipsI(
    verdicts,
    { overall_emission_rate: 0.6, overall_uncorroborated_rate: 0.374 },
    { status: "ready", data: { audits: [latest] } },
  );

  assert.deepEqual(calls, [["style", 0.6, 0.374], ["corpus", latest]]);
  // Array.from — the sandbox realm's arrays fail strict deepEqual on prototype alone.
  assert.deepEqual(Array.from(chips, (c) => c.label), ["warn", "within threshold"]);
});

test("a gauge whose payload has not landed reads not read, never a verdict", () => {
  const judge = () => {
    throw new Error("an unloaded gauge must not be judged");
  };
  const chips = sandbox.getInstrumentationChipsI(
    { styleRefGradeBadgeI: judge, getCorpusGrowthVerdictI: judge },
    null,
    { status: "loading" },
  );
  assert.deepEqual(Array.from(chips, (c) => c.label), ["not read", "not read"]);
});
