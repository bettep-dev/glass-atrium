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
  LedgerLiveSectionI: unknown;
  LedgerInertSectionI: unknown;
  LedgerHeldSectionI: (props: { suppression: unknown }) => RecordedElement | null;
  HeldCauseTableI: (props: { buckets: unknown; rows: unknown }) => RecordedElement;
  HeldCauseRowsI: unknown;
  LedgerRecurrenceSectionI: unknown;
  LedgerFooterI: (props: Record<string, unknown>) => RecordedElement;
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
// Rendered children only — a title tooltip is not prose on the card face.
function faceTextOf(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(faceTextOf).join(" ");
  if (!isElement(node)) return "";
  if (typeof node.type === "function") {
    const render = node.type as (props: Record<string, unknown>) => unknown;
    return faceTextOf(render(node.props));
  }
  // an aria-hidden box is unseen layout, read by no one
  if (node.props["aria-hidden"] === "true") return "";
  return faceTextOf(node.props.children);
}

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

// Pass-through, so text walks still reach the columns; identity lets the split be found.
function SplitRowStub(props: Record<string, unknown>) {
  return props.children;
}
sandbox.window.UI.SplitRow = SplitRowStub;

// First element of the given type, without rendering any function component.
function findByType(node: unknown, type: unknown): RecordedElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByType(child, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isElement(node)) return null;
  if (node.type === type) return node;
  for (const value of Object.values(node.props)) {
    const hit = findByType(value, type);
    if (hit) return hit;
  }
  return null;
}

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

// The ledger's "How this is counted" drawer: the header's info content, rendered only on open.
const ledgerNotes = (suppression: unknown) => {
  const tree = sandbox.PatternLedgerCardI({ state: LEDGER_STATE, suppression, onRowClick: () => {} });
  return textOf(findByType(tree, sandbox.window.UI.CardHead)?.props.info);
};

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

// the server's remedy sentences run past the 12-word face bar → every remedy prints once, in the ledger drawer
describe("each cause prints its remedy once, in the ledger drawer, never on the card face", () => {
  const face = () => faceTextOf(sandbox.PatternLedgerCardI({ state: LEDGER_STATE, suppression: SUPPRESSION, onRowClick: () => {} }));
  const rows = [
    { name: "a held cause's remedy stays in the drawer", hint: "cap remedy text", onFace: 0, inNotes: true },
    { name: "a held-by-design cause's remedy stays in the drawer", hint: "design decision remedy text", onFace: 0, inNotes: true },
    { name: "a recurring cause's remedy stays in the drawer", hint: "non-promptable remedy text", onFace: 0, inNotes: true },
    { name: "every recurring cause keeps its remedy in the drawer", hint: "roster remedy text", onFace: 0, inNotes: true },
  ];
  for (const row of rows) {
    test(row.name, () => {
      assert.equal(face().split(row.hint).length - 1, row.onFace, `${row.hint} on the card face`);
      assert.equal(ledgerNotes(SUPPRESSION).includes(row.hint), row.inNotes, `${row.hint} in the drawer`);
    });
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
  const text = ledgerNotes(SUPPRESSION);
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

// every element of the given type, without rendering any function component
function allByType(node: unknown, type: unknown): RecordedElement[] {
  return allWhere(node, (el) => el.type === type);
}

// every element matching the predicate, without rendering any function component
function allWhere(node: unknown, isMatch: (el: RecordedElement) => boolean, out: RecordedElement[] = []): RecordedElement[] {
  if (Array.isArray(node)) {
    for (const child of node) allWhere(child, isMatch, out);
    return out;
  }
  if (!isElement(node)) return out;
  if (isMatch(node)) out.push(node);
  for (const value of Object.values(node.props)) allWhere(value, isMatch, out);
  return out;
}

const heldTable = () => sandbox.HeldCauseTableI({ buckets: SUPPRESSION.parked, rows: SUPPRESSION.parked_patterns }) as RecordedElement;

// the house Table builds each body's rows for its view → each held body's rows, built for a wide view
function getHeldBodies(): RecordedElement[][] {
  const table = heldTable();
  const view = { isStacked: false, columnCount: (table.props.columns as unknown[]).length };
  return Array.from(table.props.bodies as Array<{ rows: (view: unknown) => RecordedElement[] }>, (body) => body.rows(view));
}

// the held table one level rendered: each cause row component replaced by what it returns
const heldCauseRows = () =>
  allByType(getHeldBodies(), sandbox.HeldCauseRowsI).map(
    (el) => (sandbox.HeldCauseRowsI as (props: unknown) => RecordedElement)(el.props),
  );

test("each held cause's rows open from its name in the table and start folded", () => {
  const causes = heldCauseRows();
  assert.equal(causes.length, 2, "each held cause keeps its own row list");
  assert.equal(detailsOf(sandbox.LedgerHeldSectionI({ suppression: SUPPRESSION }), []).length, 0, "no fold repeats a table row");
  for (const cause of causes) {
    const [button] = allByType(cause, "button");
    assert.ok(button, "the cause name is the toggle");
    const [list] = allWhere(cause, (el) => el.props.id !== undefined && el.props.id === button.props["aria-controls"]);
    assert.notEqual(button.props["aria-expanded"], true, "row lists fold uniformly, so the largest group is never the one hidden");
    assert.ok(list, "the toggle names the row list it opens");
    assert.equal(list.props.hidden, true, "a folded list keeps its rows out of view");
  }
  const [name, held, agents] = allByType(causes[1], sandbox.window.UI.TableCell).map((cell) => faceTextOf(cell).replace(/\s+/g, " ").trim());
  assert.ok(name.startsWith("Non-promptable signal"), name);
  assert.ok(!name.includes("design decision remedy text"), "the remedy stays off the cause cell");
  assert.deepEqual([held, agents], ["7", "6"], "the count and agents sit in their own columns");
});

test("held causes split into a needs-a-human group and a set-aside group, each led by its sum", () => {
  const groups = getHeldBodies().map(([lead, ...rows]) => {
    return {
      lead: faceTextOf(lead).replace(/\s+/g, " ").trim(),
      // per row: the name's lead slot, then the opened list's unseen lead track → a slot in both, the warn glyph only for a human
      slots: rows.map((row) =>
        allByType((sandbox.HeldCauseRowsI as (props: unknown) => RecordedElement)(row.props), sandbox.window.UI.ToneGlyph)
          .map((slot) => slot.props.tone)),
    };
  });
  assert.deepEqual(Array.from(heldTable().props.columns as Array<{ label: string }>, (column) => column.label), ["Cause", "Held", "Agents"]);
  assert.deepEqual(groups, [
    { lead: "Needs a human (1)", slots: [["warn", null]] },
    { lead: "Set aside by design (7)", slots: [[null, null]] },
  ]);
});

test("the recurrence rates render open under the held section", () => {
  const tree = sandbox.PatternLedgerCardI({ state: LEDGER_STATE, suppression: SUPPRESSION });
  const folded = detailsOf(tree, []).map(textOf).join(" ");
  assert.doesNotMatch(folded, /Roster mismatch/, "a loop stalling on one cause is loop health, not a drill-down");
  assert.match(textOf(tree), /Roster mismatch/);
});

// every component type in a subtree, fragments and columns walked through
function typesIn(node: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const child of node) typesIn(child, out);
    return out;
  }
  if (typeof node !== "object" || node === null || !("type" in node)) return out;
  const el = node as RecordedElement;
  out.push(el.type);
  return typesIn(el.props.children, out);
}

test("the held table leads the ledger, its problems in the first column and the candidates in the second", () => {
  const split = findByType(
    sandbox.PatternLedgerCardI({ state: LEDGER_STATE, suppression: SUPPRESSION }),
    SplitRowStub,
  );
  assert.ok(split, "held rows and candidates read side by side");
  const [problems, candidates] = split.props.children as RecordedElement[];
  const problemTypes = typesIn(problems).filter((type) => type !== sandbox.window.UI.SplitColumn);
  const candidateTypes = typesIn(candidates).filter((type) => type !== sandbox.window.UI.SplitColumn);

  assert.deepEqual(problemTypes, [sandbox.LedgerHeldSectionI, sandbox.LedgerRecurrenceSectionI]);
  assert.deepEqual(candidateTypes, [sandbox.LedgerLiveSectionI, sandbox.LedgerInertSectionI]);
});

test("a ledger with nothing held or recurring stacks its candidates in one column", () => {
  const tree = sandbox.PatternLedgerCardI({ state: LEDGER_STATE, suppression: { ...SUPPRESSION, parked: [], per_cycle: [] } });
  assert.equal(findByType(tree, SplitRowStub), null, "an empty problem column would leave half the card blank");
  assert.match(textOf(tree), /Live signature/);
});

describe("the ledger head states once how many held patterns need a human", () => {
  const rows = [
    { name: "a human cause counts its held rows", suppression: SUPPRESSION, sub: /^Warning: 1 needs a human$/ },
    {
      name: "several human-cause rows read in the plural",
      suppression: { ...SUPPRESSION, parked: [{ ...SUPPRESSION.parked[0], count: 3 }, SUPPRESSION.parked[1]] },
      sub: /^Warning: 3 need a human$/,
    },
    { name: "rows held by design decision alone raise no status", suppression: { ...SUPPRESSION, parked: [SUPPRESSION.parked[1]] }, sub: null },
    { name: "an unread payload raises no status", suppression: null, sub: null },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const head = findByType(sandbox.PatternLedgerCardI({ state: LEDGER_STATE, suppression: row.suppression }), sandbox.window.UI.CardHead);
      // the card sub slot, where the board and the System map's Part health head place theirs (spec 44084 §3.1)
      assert.equal(head?.props.right, undefined, "the status sits beside the title, never at the head's right end");
      const status = faceTextOf(head?.props.sub).replace(/\s+/g, " ").trim();
      if (row.sub) assert.match(status, row.sub);
      else assert.equal(status, "", `status shown: ${status}`);
    });
  }
});

test("inert rows wait behind a folded disclosure, each label named once with its row count", () => {
  const inert = (id: number, agent: string) => ({ ...LEDGER_STATE.data.patterns[1], id, agent, pattern_signature: `inert signature|${agent}` });
  const state = { ...LEDGER_STATE, data: { ...LEDGER_STATE.data, patterns: [LEDGER_STATE.data.patterns[0], inert(2, "glass-atrium-dev-node"), inert(3, "glass-atrium-dev-db")] } };
  const tree = sandbox.PatternLedgerCardI({ state, suppression: SUPPRESSION });
  const [fold] = detailsOf(tree, []).filter((g) => /Inert\s+·/.test(textOf(g)));

  assert.ok(fold, "the inert rows sit inside a disclosure");
  assert.notEqual(fold.props.open, true, "rows the intake skips never open by default");
  const face = faceTextOf(fold).replace(/\s+/g, " ");
  assert.equal(face.match(/Inert signature/g)?.length, 1, `the shared label repeats: ${face}`);
  assert.match(face, /Inert signature 2\b/, "the label carries how many rows it groups");
  for (const agent of ["glass-atrium-dev-node", "glass-atrium-dev-db"]) assert.match(textOf(fold), new RegExp(agent));
});

test("the ledger's footer counts its patterns once; the declined rows are counted in the drawer", () => {
  const tree = sandbox.PatternLedgerCardI({ state: LEDGER_STATE, suppression: SUPPRESSION, onRowClick: () => {} });
  const footer = findByType(tree, sandbox.LedgerFooterI);
  assert.ok(footer, "the ledger renders its footer");
  const foot = faceTextOf(footer).replace(/\s+/g, " ").trim();
  assert.equal(foot, "63 patterns, all time", "one figure, the window stated once");
  const notes = ledgerNotes(SUPPRESSION).replace(/\s+/g, " ");
  // 5 = every rejected row (status distribution), under the word the ledger shows for a rejected pattern
  assert.match(notes, /Declined — 5 patterns, all time/);
  assert.match(notes, /agent-registry\.json/, "the held figures are registry-gated and must say so");
});

test("registry-hidden parked patterns are called out only when they exist", () => {
  assert.match(
    ledgerNotes({ ...SUPPRESSION, off_registry_parked: 3 }),
    /excluded/,
    "F5 — a capped row the registry gate omits is still parking that agent's loop",
  );
  assert.doesNotMatch(
    ledgerNotes(SUPPRESSION),
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

test("every ledger section head reads <Name> · <window> (<count>)", () => {
  const text = faceTextOf(sandbox.PatternLedgerCardI({ state: LEDGER_STATE, suppression: SUPPRESSION, onRowClick: () => {} })).replace(/\s+/g, " ");
  assert.match(text, /Live · last 7 days \(1\)/);
  assert.match(text, /Inert · last 7 days \(1\)/);
  // 1 + 7 held rows across the two parked buckets — the untruncated bucket total.
  assert.match(text, /Held · all time \(8\)/);
  assert.match(text, /Recurrence rates · last 7 days/);
});

describe("the Live list's key line shows only while the list holds a row", () => {
  const rows = [
    { name: "a live row brings the ×N key", patterns: LEDGER_STATE.data.patterns, hasKey: true },
    { name: "an empty live list drops the ×N key", patterns: [LEDGER_STATE.data.patterns[1]], hasKey: false },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const state = { ...LEDGER_STATE, data: { ...LEDGER_STATE.data, patterns: row.patterns } };
      const text = textOf(sandbox.PatternLedgerCardI({ state, suppression: SUPPRESSION, onRowClick: () => {} }));
      assert.equal(text.includes("×N = times seen, all time"), row.hasKey);
      assert.match(text, /Patterns the loop can still propose a fix for\./, "the Live head's plain line stays");
    });
  }
});

test("recurrence rows lead with agents affected and cycle coverage, not event volume", () => {
  const text = ledger(SUPPRESSION).replace(/\s+/g, " ");
  const agentsAt = text.indexOf("Agents affected");
  const cyclesAt = text.indexOf("Cycle days");
  const eventsAt = text.indexOf("Events");
  assert.ok(agentsAt >= 0 && cyclesAt > agentsAt && eventsAt > cyclesAt, "events trail the population columns");
  for (const [coverage, events] of [["7 of 7", " 147 "], ["3 of 7", " 30 "]]) {
    const at = text.indexOf(coverage);
    assert.ok(at >= 0 && text.indexOf(events, at) > at, `${coverage} precedes its event count`);
  }
});

describe("the recurrence head says on how many days cycles ran only when fewer than the window", () => {
  const rows = [
    { name: "cycles on fewer days than the window", cycles: 5, line: "Cycles ran on 5 of the 7 days." },
    { name: "cycles on every day of the window", cycles: 7, line: null },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const text = ledger({ ...SUPPRESSION, per_cycle_window_cycles: row.cycles }).replace(/\bwhitespace-nowrap\s+/g, "").replace(/\s+/g, " ");
      assert.equal(/Cycles ran on/.test(text), row.line !== null, text);
      if (row.line) assert.ok(text.includes(row.line), text);
      assert.doesNotMatch(text, /cycle days ·|· \d+ cycle days/, "the cycle-day count leaves the head");
    });
  }
});

test("the inert fold says what inert means under its head", () => {
  const [fold] = detailsOf(sandbox.PatternLedgerCardI({ state: LEDGER_STATE, suppression: SUPPRESSION }), []).filter((g) => /Inert\s+·/.test(textOf(g)));
  assert.match(textOf(fold), /The loop skips these at intake every cycle\./);
});
