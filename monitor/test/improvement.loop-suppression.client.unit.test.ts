// Render guards for the loop-suppression surface in public/src/screens/improvement.jsx.
//
// improvement.loop-suppression.route.test.ts pins what the PAYLOAD reports. This pins
// what an operator can actually read, which is where the original defect lived: the
// numbers for four of the five suppression mechanisms were reachable from the database
// the whole time, and the screen showed one of them under a headline reading
// "Loop parked".
//
// Two things are asserted, and they pull in opposite directions on purpose:
//   - the banner must NOT generalise from its one mechanism to the loop;
//   - the card must show every cause SEPARATELY, because a single suppression total
//     conflating five causes with five different remedies is a worse signal than the
//     single-mechanism count it replaced.
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
  ParkedLoopBannerI: (props: { applyCap: unknown }) => RecordedElement | null;
  LoopSuppressionCardI: (props: {
    state: unknown;
    suppression: unknown;
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

const sandbox = await buildScreenSandbox<Sandbox>(IMPROVEMENT_SRC);
sandbox.React.createElement = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => ({
  type,
  props: { ...(props ?? {}), children: rest.length > 1 ? rest : rest[0] },
});

const READY = { status: "ready" };

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
      cause: "reject-streak-snooze",
      label: "Reject-streak snooze",
      count: 7,
      agents: 6,
      hint: "streak remedy text",
    },
  ],
  per_cycle: [
    {
      cause: "non-promptable",
      label: "Non-promptable signal",
      count: 147,
      agents: 25,
      hint: "non-promptable remedy text",
    },
    {
      cause: "roster-mismatch",
      label: "Roster mismatch",
      count: 30,
      agents: 5,
      hint: "roster remedy text",
    },
  ],
  per_cycle_window_days: 7,
  pending_unpromptable: 28,
  pending_total: 47,
  off_registry_parked: 0,
};

test("the banner attributes its count to the cap, not to the loop", () => {
  const rendered = sandbox.ParkedLoopBannerI({
    applyCap: { capped_patterns: 1, capped_agents: 1, rearm_hint: "hint" },
  });
  const text = textOf(rendered);
  assert.doesNotMatch(
    text,
    /Loop parked/,
    "the cap is 1 of 5 suppression mechanisms and the rarest measured — a headline " +
      "generalising from it to the loop is what let the other four stay invisible",
  );
  assert.match(text, /Repeat-apply cap/, "the mechanism responsible must be named");
});

test("every suppression cause is rendered on its own row", () => {
  const rendered = sandbox.LoopSuppressionCardI({ state: READY, suppression: SUPPRESSION });
  const text = textOf(rendered);
  for (const label of [
    "Repeat-apply cap",
    "Reject-streak snooze",
    "Non-promptable signal",
    "Roster mismatch",
  ]) {
    assert.match(text, new RegExp(label), `${label} is missing from the card`);
  }
});

test("each cause carries its own remedy, not one shared line", () => {
  const rendered = sandbox.LoopSuppressionCardI({ state: READY, suppression: SUPPRESSION });
  const text = textOf(rendered);
  for (const hint of [
    "cap remedy text",
    "streak remedy text",
    "non-promptable remedy text",
    "roster remedy text",
  ]) {
    assert.match(text, new RegExp(hint), `${hint} was dropped — a count without its remedy is a dead end`);
  }
});

test("the two populations are never added together", () => {
  const rendered = sandbox.LoopSuppressionCardI({ state: READY, suppression: SUPPRESSION });
  const text = textOf(rendered);
  // 1+7+147+30 = 185. A card rendering a grand total is the explicitly rejected
  // design: it conflates terminal rows with per-cycle recurrences and five remedies
  // with none.
  assert.doesNotMatch(text, /\b185\b/, "a conflated suppression total must not appear");
  assert.match(text, /147/, "the per-cycle counts are shown as themselves");
  assert.match(text, /\b7\b/, "the parked counts are shown as themselves");
});

test("pending rows that cannot propose are shown against the backlog they hide in", () => {
  const rendered = sandbox.LoopSuppressionCardI({ state: READY, suppression: SUPPRESSION });
  const text = textOf(rendered);
  assert.match(text, /28/, "the unpromptable count is shown");
  assert.match(text, /47/, "and against the total it is a share of — 28 alone reads as small");
});

test("the per-cycle window is shown with its counts", () => {
  const rendered = sandbox.LoopSuppressionCardI({ state: READY, suppression: SUPPRESSION });
  assert.match(
    textOf(rendered),
    /7\s+days/,
    "a recurrence count without its window cannot be compared to anything",
  );
});

test("the card renders at zero rather than disappearing", () => {
  const rendered = sandbox.LoopSuppressionCardI({
    state: READY,
    suppression: {
      parked: [],
      per_cycle: [],
      per_cycle_window_days: 7,
      pending_unpromptable: 0,
      pending_total: 0,
      off_registry_parked: 0,
    },
  });
  assert.ok(rendered, "zero suppression is a reading; an absent card is 'not measured'");
});

test("registry-hidden parked patterns are called out only when they exist", () => {
  const withHidden = sandbox.LoopSuppressionCardI({
    state: READY,
    suppression: { ...SUPPRESSION, off_registry_parked: 3 },
  });
  assert.match(
    textOf(withHidden),
    /not in agent-registry\.json/,
    "F5 — a capped row the registry gate omits is still parking that agent's loop",
  );
  const without = sandbox.LoopSuppressionCardI({ state: READY, suppression: SUPPRESSION });
  assert.doesNotMatch(
    textOf(without),
    /not in agent-registry\.json/,
    "a standing note at zero trains an operator to ignore it",
  );
});

test("the card stays silent while the payload is unavailable", () => {
  assert.strictEqual(
    sandbox.LoopSuppressionCardI({ state: { status: "loading" }, suppression: null }),
    null,
    "rendering zeros during load would report a healthy loop that was never measured",
  );
  assert.strictEqual(
    sandbox.LoopSuppressionCardI({ state: { status: "error" }, suppression: null }),
    null,
  );
});
