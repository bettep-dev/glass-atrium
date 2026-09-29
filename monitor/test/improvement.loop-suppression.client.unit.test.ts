// Render guards for the suppression-derived surfaces in public/src/screens/improvement.jsx.
//
// improvement.loop-suppression.route.test.ts pins what the PAYLOAD reports. This pins
// what an operator can actually read, which is where the original defect lived: the
// numbers for four of the five suppression mechanisms were reachable from the database
// the whole time, and the screen showed one of them under a headline reading
// "Loop parked".
//
// The suppression facts no longer live in a panel of their own: they are joined into
// the pattern ledger, which is the only surface that holds the rows they describe. So
// the assertions below moved with them, and they still pull in opposite directions:
//   - the alarm never generalises from its one mechanism to the loop;
//   - every cause stays SEPARATE, because a single suppression total conflating five
//     causes with five different remedies is a worse signal than the single-mechanism
//     count it replaced.
//
// Same harness limit as improvement.parked-loop-banner.client.unit.test.ts: the
// component is invoked over the shipped source with a recording React.createElement,
// so this asserts the emitted element tree, not computed CSS.
//
// Runner: npx tsx --test test/improvement.loop-suppression.client.unit.test.ts

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

interface Sandbox {
  React: { createElement: unknown };
  window: { UI: Record<string, unknown> };
  AlarmLaneI: (props: { applyCap: unknown }) => RecordedElement | null;
  ParkedLoopBannerI: (props: { applyCap: unknown }) => RecordedElement | null;
  PatternLedgerCardI: (props: {
    state: unknown;
    suppression: unknown;
    onRowClick?: unknown;
    onRetry?: unknown;
  }) => RecordedElement | null;
}

function isElement(value: unknown): value is RecordedElement {
  return typeof value === "object" && value !== null && "props" in value && "type" in value;
}

// Depth-first concatenation of every string/number leaf.
//
// The recorder does NOT invoke function components — createElement stores the
// function as `type` — so a card that delegates its rows to a child component would
// otherwise read as empty text and every content assertion below would pass on an
// empty card. Function types are therefore called with their own props and their
// result walked, i.e. a shallow render one level deep, repeatedly. Depth is bounded
// by the tree, and the components under test hold no state and no hooks.
function textOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isElement(node)) return "";
  if (typeof node.type === "function") {
    const render = node.type as (props: Record<string, unknown>) => unknown;
    return textOf(render(node.props));
  }
  return Object.values(node.props)
    .filter(
      (v) => Array.isArray(v) || isElement(v) || typeof v === "string" || typeof v === "number",
    )
    .map(textOf)
    .join(" ");
}

// Every <details> element in the tree, paired with the text it encloses — the held
// groups and the recurrence disclosure are the only collapsible surfaces here.
function detailsOf(node: unknown, out: RecordedElement[]): RecordedElement[] {
  if (Array.isArray(node)) {
    for (const child of node) detailsOf(child, out);
    return out;
  }
  if (!isElement(node)) return out;
  if (node.type === "details") out.push(node);
  if (typeof node.type === "function") {
    const render = node.type as (props: Record<string, unknown>) => unknown;
    return detailsOf(render(node.props), out);
  }
  for (const value of Object.values(node.props)) detailsOf(value, out);
  return out;
}

const sandbox = await buildScreenSandbox<Sandbox>(IMPROVEMENT_SRC);
sandbox.React.createElement = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => ({
  type,
  props: { ...(props ?? {}), children: rest.length > 1 ? rest : rest[0] },
});

// The shared harness stubs only the window.UI members the module top level reads at
// evaluation time. Walking into the ledger's row and banner components reaches two
// more, so they are stubbed here rather than widened for every screen that uses it.
Object.assign(sandbox.window.UI, {
  TONE_GLYPH: { ok: "\u2713", warn: "\u26a0", crit: "\u2715", info: "\u2139" },
  titleOf: (value: unknown) => value,
});

const SUPPRESSION = {
  parked: [
    {
      cause: "repeat-apply-cap",
      label: "Repeat-apply cap",
      count: 1,
      agents: 1,
      hint: "cap remedy text",
    },
    {
      cause: "non-promptable",
      label: "Non-promptable signal",
      count: 7,
      agents: 6,
      hint: "design decision remedy text",
    },
  ],
  parked_patterns: [
    {
      id: 901,
      pattern_signature: "capped signature",
      frequency: 9,
      agent: "glass-atrium-dev-react",
      status: "rejected",
      discovered_date: "2026-08-01",
      intake_skipped: false,
      cause: "repeat-apply-cap",
    },
    {
      id: 902,
      pattern_signature: "design-decision signature",
      frequency: 4,
      agent: "glass-atrium-dev-node",
      status: "rejected",
      discovered_date: "2026-08-02",
      intake_skipped: true,
      cause: "non-promptable",
    },
  ],
  per_cycle: [
    {
      cause: "non-promptable",
      label: "Non-promptable signal",
      count: 147,
      agents: 25,
      cycles: 7,
      hint: "non-promptable remedy text",
    },
    {
      cause: "roster-mismatch",
      label: "Roster mismatch",
      count: 30,
      agents: 5,
      cycles: 3,
      hint: "roster remedy text",
    },
  ],
  per_cycle_window_days: 7,
  per_cycle_window_cycles: 7,
  pending_unpromptable: 28,
  pending_total: 47,
  off_registry_parked: 0,
};

const LEDGER_STATE = {
  status: "ready",
  data: {
    total_patterns: 63,
    patterns: [
      {
        id: 1,
        pattern_signature: "live signature",
        frequency: 12,
        agent: "glass-atrium-dev-react",
        status: "identified",
        discovered_date: "2026-09-10",
        intake_skipped: false,
      },
      {
        id: 2,
        pattern_signature: "inert signature",
        frequency: 11,
        agent: "glass-atrium-dev-node",
        status: "identified",
        discovered_date: "2026-09-11",
        intake_skipped: true,
      },
    ],
    status_distribution: [{ status: "rejected", count: 5 }],
  },
};

const ledger = (suppression: unknown) =>
  textOf(sandbox.PatternLedgerCardI({ state: LEDGER_STATE, suppression, onRowClick: () => {} }));

test("the alarm lane renders nothing when no cap is parked", () => {
  assert.strictEqual(
    sandbox.AlarmLaneI({ applyCap: { capped_patterns: 0, capped_agents: 0, rearm_hint: null } }),
    null,
    "an empty lane teaches the operator that the lane is decoration",
  );
  assert.strictEqual(sandbox.AlarmLaneI({ applyCap: null }), null);
  assert.ok(
    sandbox.AlarmLaneI({ applyCap: { capped_patterns: 2, capped_agents: 1, rearm_hint: "hint" } }),
    "a parked cap is the one alarm this screen can raise today",
  );
});

test("the alarm attributes its count to the cap, not to the loop", () => {
  const text = textOf(
    sandbox.ParkedLoopBannerI({
      applyCap: { capped_patterns: 1, capped_agents: 1, rearm_hint: "hint" },
    }),
  );
  assert.doesNotMatch(
    text,
    /Loop parked/,
    "the cap is 1 of 5 suppression mechanisms and the rarest measured — a headline " +
      "generalising from it to the loop is what let the other four stay invisible",
  );
  assert.match(text, /Repeat-apply cap/, "the mechanism responsible must be named");
});

test("every suppression cause is rendered on its own row", () => {
  const text = ledger(SUPPRESSION);
  for (const label of [
    "Repeat-apply cap",
    "Non-promptable signal",
    "Roster mismatch",
  ]) {
    assert.match(text, new RegExp(label), `${label} is missing from the ledger`);
  }
});

test("each cause carries its own remedy, not one shared line", () => {
  const text = ledger(SUPPRESSION);
  for (const hint of [
    "cap remedy text",
    "design decision remedy text",
    "non-promptable remedy text",
    "roster remedy text",
  ]) {
    assert.match(text, new RegExp(hint), `${hint} was dropped — a count without its remedy is a dead end`);
  }
});

test("the two populations are never added together", () => {
  const text = ledger(SUPPRESSION);
  // 1+7+147+30 = 185. A ledger rendering a grand total is the explicitly rejected
  // design: it conflates terminal rows with per-cycle recurrences and five remedies
  // with none.
  assert.doesNotMatch(text, /\b185\b/, "a conflated suppression total must not appear");
  assert.match(text, /147/, "the per-cycle counts are shown as themselves");
  assert.match(text, /\b7\b/, "the parked counts are shown as themselves");
});

test("pending rows that cannot propose are shown against the backlog they hide in", () => {
  const text = ledger(SUPPRESSION);
  assert.match(text, /28/, "the unpromptable count is shown");
  assert.match(text, /47/, "and against the total it is a share of — 28 alone reads as small");
});

test("the per-cycle window is shown with its counts", () => {
  assert.match(
    ledger(SUPPRESSION),
    /7\s+days/,
    "a recurrence count without its window cannot be compared to anything",
  );
});

test("held rows appear under their own cause, window-free", () => {
  const text = ledger(SUPPRESSION);
  assert.match(text, /Capped signature/, "the parked rows are the held section's whole content");
  assert.match(
    text,
    /Design decision signature/,
    "a park older than the discovery window is exactly the one waiting on a human",
  );
});

test("the actionable held group opens and the design-decision group stays closed", () => {
  const groups = detailsOf(sandbox.PatternLedgerCardI({ state: LEDGER_STATE, suppression: SUPPRESSION }), []);
  const capGroup = groups.find((g) => textOf(g).includes("cap remedy text"));
  const designGroup = groups.find((g) => textOf(g).includes("design decision remedy text"));
  assert.ok(capGroup, "the repeat-apply cap group must be rendered");
  assert.ok(designGroup, "the design-decision group must be rendered");
  assert.equal(capGroup?.props.open, true, "a group a human can clear today is not worth a click");
  assert.notEqual(
    designGroup?.props.open,
    true,
    "opening the group nobody can act on buries the group they can",
  );
});

test("the recurrence rates sit behind a closed disclosure", () => {
  const groups = detailsOf(sandbox.PatternLedgerCardI({ state: LEDGER_STATE, suppression: SUPPRESSION }), []);
  const disclosure = groups.find((g) => textOf(g).includes("roster remedy text"));
  assert.ok(disclosure, "the per-cycle buckets must be rendered somewhere");
  assert.notEqual(
    disclosure?.props.open,
    true,
    "a recurrence rate is a rate, not a state change — it does not earn open space",
  );
});

test("the ledger's footer states each figure with its gate", () => {
  const text = ledger(SUPPRESSION);
  assert.match(text, /63/, "the ledger total survives the removed Learned-patterns card");
  assert.match(text, /agent-registry\.json/, "the held figures are registry-gated and must say so");
});

test("registry-hidden parked patterns are called out only when they exist", () => {
  assert.match(
    ledger({ ...SUPPRESSION, off_registry_parked: 3 }),
    /excluded/,
    "F5 — a capped row the registry gate omits is still parking that agent's loop",
  );
  assert.doesNotMatch(
    ledger(SUPPRESSION),
    /excluded/,
    "a standing note at zero trains an operator to ignore it",
  );
});

test("the suppression sections stay silent while the payload is unavailable", () => {
  const text = ledger(null);
  assert.doesNotMatch(
    text,
    /Held/,
    "rendering an empty held section during load would report a healthy loop that was never measured",
  );
  assert.doesNotMatch(text, /agent-registry\.json/, "no gate note without the figures it gates");
  assert.match(text, /Live signature/, "the ledger itself still renders — only the join is missing");
});

test("the ledger reports its own payload's loading and error states distinctly", () => {
  assert.match(
    textOf(sandbox.PatternLedgerCardI({ state: { status: "error", error: "boom" }, suppression: null })),
    /Couldn't load/,
    "an error must not read as an empty ledger",
  );
  const loading = sandbox.PatternLedgerCardI({ state: { status: "loading", data: null }, suppression: null });
  assert.doesNotMatch(textOf(loading), /No candidate patterns/, "loading is not emptiness");
});

test("every ledger section header states its window and its count", () => {
  const text = ledger(SUPPRESSION).replace(/\s+/g, " ");
  assert.match(text, /Live — can propose · discovered in the last 7 days[^(]*\( 1 \)/);
  assert.match(text, /Inert — [^(]*· discovered in the last 7 days[^(]*\( 1 \)/);
  // 1 + 7 held rows across the two parked buckets — the untruncated bucket total.
  assert.match(text, /Held — terminal rows · all time[^(]*\( 8 \)/);
  assert.match(text, /×N = times seen, all time/, "a ×N figure needs its population");
});

test("recurrence rows lead with agents affected and cycle coverage, not event volume", () => {
  const text = ledger(SUPPRESSION).replace(/\s+/g, " ");
  assert.match(text, /7 cycle days/, "the disclosure names its cycle denominator");
  const agentsAt = text.indexOf("Agents affected");
  const cyclesAt = text.indexOf("Cycle days");
  const eventsAt = text.indexOf("Events");
  assert.ok(agentsAt >= 0 && cyclesAt > agentsAt && eventsAt > cyclesAt, "events trail the population columns");
  for (const [coverage, events] of [["7 of 7", " 147 "], ["3 of 7", " 30 "]]) {
    const at = text.indexOf(coverage);
    assert.ok(at >= 0 && text.indexOf(events, at) > at, `${coverage} precedes its event count`);
  }
});
