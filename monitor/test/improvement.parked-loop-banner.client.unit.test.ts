// Render guard for ParkedLoopBannerI in public/src/screens/improvement.jsx.
//
// improvement.rearm-hint.unit.test.ts pins what the warning SAYS; nothing pinned
// whether an operator can read it. The hint is ~500 chars, so a host that clamps
// to one line (`.card-sub` without `.is-wrap`, `truncate`, `line-clamp-*`) cuts it
// mid-sentence — at a point that reads like the retracted advice to reset the
// status. A `title` tooltip is not an acceptable substitute: a warning whose
// content is "do not do this" cannot live behind a hover.
//
// This is a real render assertion, not a source-shape pin: the component is
// invoked over the shipped source (esbuild + node:vm harness) with a recording
// React.createElement, the shared AlertCard it returns is rendered one level, and
// the emitted element tree is walked for the node whose child IS the rearm_hint.
// Its limit is that it asserts the class contract, not computed CSS.
//
// Runner: npx tsx --test test/improvement.parked-loop-banner.client.unit.test.ts

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMPROVEMENT_SRC = resolve(__dirname, "../public/src/screens/improvement.jsx");
const INSTRUMENTATION_SRC = resolve(
  __dirname,
  "../public/src/screens/improvement-instrumentation.jsx",
);

interface RecordedElement {
  type: unknown;
  props: Record<string, unknown>;
}

interface BannerSandbox {
  React: { createElement: unknown };
  window: { UI: Record<string, unknown> };
  ParkedLoopBannerI: (props: { applyCap: unknown }) => RecordedElement | null;
  AlarmLaneI: (props: { applyCap: unknown }) => RecordedElement | null;
  LedgerFooterI: (props: {
    total: number;
    declined: number;
    suppression: unknown;
  }) => RecordedElement | null;
  BucketRowI: (props: { state: unknown; buckets: unknown }) => RecordedElement | null;
  CycleDecompositionRowI: (props: { stats: unknown }) => RecordedElement | null;
  TrendCardI: (props: { state: unknown; aggregate: unknown }) => RecordedElement | null;
  ChangeSummaryCardI: (props: { state: unknown; aggregate: unknown }) => RecordedElement | null;
  LedgerHeldSectionI: (props: { suppression: unknown; declined?: unknown }) => RecordedElement | null;
  SymI: unknown;
  ProposalCardI: unknown;
  [component: string]: unknown;
}

const HINT = "the reset does NOT re-arm the cap; it only overwrites the park timestamp";

function isElement(value: unknown): value is RecordedElement {
  return typeof value === "object" && value !== null && "props" in value && "type" in value;
}

// Depth-first walk over the recorded tree, yielding every element whose direct
// children include the exact hint string.
function findHintHosts(node: unknown, out: RecordedElement[]): RecordedElement[] {
  if (!isElement(node)) return out;
  const children = node.props.children;
  const list = Array.isArray(children) ? children : [children];
  if (list.some((c) => c === HINT)) out.push(node);
  for (const child of list) findHintHosts(child, out);
  return out;
}

const sandbox = await buildScreenSandbox<BannerSandbox>(IMPROVEMENT_SRC);
sandbox.React.createElement = (type: unknown, props: Record<string, unknown> | null, ...rest: unknown[]) => ({
  type,
  props: { ...(props ?? {}), children: rest.length > 1 ? rest : rest[0] },
});

const banner = sandbox.ParkedLoopBannerI({
  applyCap: { capped_patterns: 2, capped_agents: 1, rearm_hint: HINT },
});
// renders a function-component root one level, so the shared AlertCard's own markup is walked
function expandRoot(node: RecordedElement | null): unknown {
  return node && typeof node.type === "function"
    ? (node.type as (props: Record<string, unknown>) => unknown)(node.props)
    : node;
}
const rendered = expandRoot(banner);
// The bucket row asks the shared harness for one more window.UI member than the
// module top level reads.
Object.assign(sandbox.window.UI, { titleOf: (value: unknown) => value });

const hosts = findHintHosts(rendered, []);

test("the rendered banner puts the hint in exactly one element", () => {
  assert.equal(hosts.length, 1, "the walk must find the hint's host to assert anything about it");
});

// The discriminating assertion: red against a plain `card-sub`, green with the opt-out or any wrapping host.
test("the hint's host never clamps it to one line", () => {
  const host = hosts[0];
  assert.ok(host, "no host element found for the hint");
  const className = String(host.props.className ?? "");
  const isClamped =
    /\b(truncate|whitespace-nowrap|line-clamp-\d+)\b/.test(className) ||
    (/\bcard-sub\b/.test(className) && !/\bis-wrap\b/.test(className));
  assert.equal(isClamped, false, `the ~500-char warning clamps to one ellipsised line (${className})`);
});

test("the warning is not hidden behind a hover-only tooltip", () => {
  const host = hosts[0];
  assert.ok(host, "no host element found for the hint");
  assert.equal(
    host.props.title,
    undefined,
    "a title tooltip is not a substitute for showing the warning",
  );
});

// ----- The alarm lane: shared alert cards, no tint of its own, and the spine order ---
//
// Tone rides on a glyph or a severity bar and NEVER on text — severity hue as text
// fails AA on the light theme. Every banner on the screen is the shared AlertCard,
// whose glyph well alone carries the tone; the lane is a plain stack of them.

const SEVERITY_TEXT_CLASS = /\btext-(warn|crit|ok)\b/;

function collectElements(node: unknown, out: RecordedElement[]): RecordedElement[] {
  if (!isElement(node)) return out;
  out.push(node);
  const children = node.props.children;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) collectElements(child, out);
  return out;
}

test("the parked-loop banner is the shared alert card, its warn tone on the glyph well alone", () => {
  assert.ok(isElement(banner), "a populated cap must render the banner");
  assert.equal(banner.type, sandbox.window.UI.AlertCard, "a screen-local banner shell duplicates the alert card");
  assert.equal(banner.props.tone, "warn");
  const tintedText = collectElements(rendered, [])
    .filter((el) => SEVERITY_TEXT_CLASS.test(String(el.props.className ?? "")))
    .filter((el) => el.props.s === undefined);
  assert.deepEqual(tintedText, [], "severity hue on a text node of the banner");
});

test("the alarm lane stacks alert cards and paints nothing of its own", () => {
  const lane = sandbox.AlarmLaneI({
    applyCap: { capped_patterns: 2, capped_agents: 1, rearm_hint: HINT },
  });
  assert.ok(isElement(lane), "a populated cap must render the lane");
  const laneClasses = String(lane.props.className ?? "").split(/\s+/).filter(Boolean);
  const paintClasses = laneClasses.filter((name) => !/^(flex|flex-col|gap-\d+)$/.test(name));
  assert.deepEqual(paintClasses, [], "the lane carries layout only — a tint or border on it frames the alarms twice");
  const alarms = ([] as unknown[]).concat(lane.props.children).filter(isElement);
  assert.ok(alarms.length > 0, "the lane renders its alarms");
  for (const alarm of alarms) {
    assert.equal(expandRoot(alarm) && (expandRoot(alarm) as RecordedElement).type, sandbox.window.UI.AlertCard);
  }
});

// Source-order pin, deliberately NOT a render assertion: the operator view is the
// whole screen, and rendering it would mock more than it proves. Its limit is that
// it pins the order the five surfaces are WRITTEN in, which is the order they
// render in only because they are siblings in one block.
test("the operator view keeps the five-surface spine order", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(IMPROVEMENT_SRC, "utf8");
  const spine = [
    "<AlarmLaneI",
    "<StatusBandI",
    "<KanbanCardI",
    "<PatternLedgerCardI",
    "<LoopOutputGroupI",
  ];
  const positions = spine.map((tag) => {
    const at = src.indexOf(tag);
    assert.notEqual(at, -1, `${tag} is missing from the operator view`);
    return at;
  });
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(
      positions[i - 1] < positions[i],
      `${spine[i - 1]} must precede ${spine[i]} — alarms above the band, the board above the ledger`,
    );
  }
});

// Colour reaches this screen through tokens only — `var(--name)` directly, or an
// interpolated token name. Shadows included: depth comes from the --shadow-* tokens.
test("colour is consumed through design tokens, never a raw literal", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const path of [IMPROVEMENT_SRC, INSTRUMENTATION_SRC]) {
    const src = await readFile(path, "utf8");
    const hex = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(hex, [], `hex colour literals bypass the token layer in ${path}`);
    const rawFns = (src.match(/rgba?\([^)]*\)/g) ?? []).filter((decl) => !decl.includes("var("));
    assert.deepEqual(rawFns, [], `a colour function names a raw value instead of a token in ${path}`);
  }
});

// ----- The same contract on the REPORT surfaces --------------------------------
//
// The ledger footer and the CTM/EPM bucket row are report surfaces, allowed no
// tint at all, so a severity class there can only be sitting on text. Both are
// invoked directly: the recorder stores a function child as `type` without calling
// it, so walking the ledger card would stop at its footer.

function tintedTextNodes(tree: unknown): string[] {
  return collectElements(tree, [])
    .filter((el) => SEVERITY_TEXT_CLASS.test(String(el.props.className ?? "")))
    .filter((el) => el.props.s === undefined)
    .map((el) => String(el.props.className));
}

test("the ledger footer reports its worst figures with no hue on text", () => {
  const footer = sandbox.LedgerFooterI({
    total: 40,
    declined: 9,
    suppression: { pending_total: 12, pending_unpromptable: 7, off_registry_parked: 3 },
  });
  assert.deepEqual(
    tintedTextNodes(footer),
    [],
    "severity hue on a footer text node — the count already carries the fact",
  );
});

test("the CTM/EPM row leaves its tone on the glyph", () => {
  const row = sandbox.BucketRowI({
    state: { status: "ready" },
    buckets: { ctm: 4, epm: 2, outcome: {}, joinMeta: { linked_agent_count: 3 } },
  });
  assert.deepEqual(
    tintedTextNodes(row),
    [],
    "the label repeats a tone the SymI beside it already declares",
  );
});

test("the cycle decomposition chips leave their tone on the glyph", () => {
  const row = sandbox.CycleDecompositionRowI({
    stats: {
      cycles_generated_applied_7d: 3,
      cycles_generated_not_applied_7d: 4,
      cycles_no_generation_7d: 5,
      cycle_total_7d: 12,
    },
  });
  assert.deepEqual(
    tintedTextNodes(row),
    [],
    "the chip label repeats a tone the SymI beside it already declares",
  );
});

// The Loop output cards name a status in a label, so `info` counts as a tone here
// too — the neutral ℹ glyph beside the label already says it.
const TONE_TEXT_CLASS = /\btext-(warn|crit|ok|info)\b/;

function toneTextNodes(tree: unknown): string[] {
  return collectElements(tree, [])
    .filter((el) => TONE_TEXT_CLASS.test(String(el.props.className ?? "")))
    .filter((el) => el.props.s === undefined)
    .map((el) => String(el.props.className));
}

test("the trend legend leaves its tone on the line swatch", () => {
  const card = sandbox.TrendCardI({
    state: { status: "ready" },
    aggregate: { trend: [{ verified: 2, reject: 1 }, { verified: 3, reject: 0 }], verifiedTotal: 5, rejectTotal: 1 },
  });
  assert.deepEqual(toneTextNodes(card), [], "the legend label repeats the hue its swatch already draws");
});

test("the change summary's reject-rate labels leave their tone on the glyph", () => {
  Object.assign(sandbox.window.UI, { formatPctWithDenominator: (count: number, total: number) => `${count}/${total}` });
  for (const failAfter of [{ count: 1, total: 10 }, { count: 9, total: 10 }, { count: 0, total: 0 }]) {
    const card = sandbox.ChangeSummaryCardI({
      state: { status: "ready" },
      aggregate: { added: 4, removed: 2, eventCount: 6, failBefore: { count: 5, total: 10 }, failAfter },
    });
    assert.deepEqual(toneTextNodes(card), [], "a reject-rate label repeats the tone its SymI already declares");
  }
});

test("every held row renders under exactly one cause group", () => {
  const reasoned = { id: 7, agent: "a", cause: "other" };
  const section = sandbox.LedgerHeldSectionI({
    suppression: {
      parked: [{ cause: "other", label: "Other", count: 1, agents: 1, hint: "h" }],
      parked_patterns: [reasoned],
    },
    declined: [{ ...reasoned, status: "rejected" }],
  });
  // Flattening walk — collectElements drops a nested array child, which is the shape `buckets.map` yields.
  const walk = (node: unknown): RecordedElement[] =>
    Array.isArray(node)
      ? node.flatMap(walk)
      : isElement(node)
        ? [node, ...walk(node.props.children)]
        : [];
  const groups = walk(section).filter((el) => el.props.bucket !== undefined);
  const ids = groups.flatMap((g) => (g.props.rows as { id: number }[]).map((r) => r.id));
  assert.deepEqual(ids, [7], "a rejected row is counted under its cause and again under a second group");
});

type AnyFn = (props: Record<string, unknown>) => unknown;
const screenFns = sandbox as unknown as Record<string, AnyFn>;

// Walks the tree, invoking function components; `stopAt` types are collected, not entered.
function collect(node: unknown, pick: (el: RecordedElement) => boolean, stopAt: unknown[] = []): RecordedElement[] {
  const out: RecordedElement[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== "object" || n === null || !("props" in n) || !("type" in n)) return;
    const el = n as RecordedElement;
    if (pick(el)) out.push(el);
    if (stopAt.includes(el.type)) return;
    if (typeof el.type === "function") return walk((el.type as AnyFn)(el.props));
    Object.values(el.props).forEach(walk);
  };
  walk(node);
  return out;
}

test("report surfaces keep neutral chrome — no tinted border, no hued diff chip", async () => {
  const row = sandbox.BucketRowI({
    state: { status: "ready" },
    buckets: { ctm: 4, epm: 2, outcome: {}, joinMeta: { linked_agent_count: 3 } },
  });
  const tinted = collect(row, (el) => {
    const style = el.props.style as Record<string, unknown> | undefined;
    return Boolean(style && ("borderLeft" in style || "borderColor" in style));
  });
  assert.deepEqual(tinted, [], "the learning-memory tiles carry no tone border");
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(IMPROVEMENT_SRC, "utf8");
  assert.doesNotMatch(src, /diff-line--(add|del)/, "the added/removed chips must not hue their text");
});

test("a failed stats payload raises one banner at the loop output group", () => {
  const ErrorBannerI = screenFns.ErrorBannerI;
  const group = screenFns.LoopOutputGroupI({
    statsState: { status: "error", data: null, error: "boom" },
    loopEventsState: { status: "loading", data: null, error: null },
    loopAggregate: null,
    listState: { status: "loading", data: null, error: null },
    buckets: null,
    onNav: () => {},
    onRetry: () => {},
  });
  const banners = collect(group, (el) => el.type === ErrorBannerI, [ErrorBannerI]);
  assert.equal(banners.length, 1);
});

test("the status band never announces a failure the owning group already announces", () => {
  const failed = { status: "error", data: null, error: "boom" };
  const band = screenFns.StatusBandI({
    statsState: failed,
    listState: failed,
    learningLogState: failed,
    suppression: null,
    awaiting: 0,
    onRetry: () => {},
  });
  const buttons = collect(band, (el) => el.type === "button");
  assert.equal(buttons.length, 0, "a retry per tile repeats the group's banner");
  const pointers = collect(band, (el) => {
    const kids = ([] as unknown[]).concat(el.props.children);
    return kids.some((k) => typeof k === "string" && k.includes("Not read — see the"));
  });
  assert.equal(pointers.length, 4, "each tile points at its owning group");
});

// ----- Board headers, proposal actions and tiles: tone on the glyph, tiles on the sub-card ---

type ScreenComponent = (props: Record<string, unknown>) => unknown;

// Flattening walk over every prop value; renders screen-local components, never the
// shared UI atoms, SymI or `stopAt` — those are judged by their own suites.
function screenTree(node: unknown, stopAt: unknown[] = [], out: RecordedElement[] = []): RecordedElement[] {
  if (Array.isArray(node)) {
    for (const child of node) screenTree(child, stopAt, out);
    return out;
  }
  if (!isElement(node)) return out;
  out.push(node);
  const uiAtoms = Object.values(sandbox.window.UI);
  const isScreenLocal =
    typeof node.type === "function" && !uiAtoms.includes(node.type) && node.type !== sandbox.SymI;
  if (isScreenLocal && !stopAt.includes(node.type)) {
    return screenTree((node.type as ScreenComponent)(node.props), stopAt, out);
  }
  for (const value of Object.values(node.props)) screenTree(value, stopAt, out);
  return out;
}

const TONE_TEXT_ON_TEXT = /\btext-(warn|crit|ok|info)\b/;

function getToneTextNodes(tree: RecordedElement[]): string[] {
  return tree
    .filter((el) => TONE_TEXT_ON_TEXT.test(String(el.props.className ?? "")))
    .filter((el) => el.props.s === undefined)
    .map((el) => String(el.props.className));
}

const component = (name: string) => sandbox[name] as ScreenComponent;
const PROPOSAL = { id: 7, status: "pending", target_agent: "glass-atrium-dev-node", pattern_label: "Size overrun" };

describe("board and action surfaces leave their tone on the glyph", () => {
  const rows = [
    { name: "the applied lane header", render: () => component("AppliedHeroHeaderI")({ count: 9, label: "Applied", symbol: "✓" }) },
    {
      name: "the rejected lane header",
      render: () => component("RejectedHeaderI")({ rowCount: 4, summary: null, label: "Rejected", symbol: "✕", trend: [] }),
    },
    {
      name: "a high-risk suggestion's actions",
      render: () => component("ProposalActionsI")({ row: PROPOSAL, isSafety: true, onAction: () => {}, isPending: false }),
    },
    {
      name: "the awaiting-approval banner",
      render: () => component("AwaitingBannerI")({ rows: [PROPOSAL], onRowClick: () => {}, onAction: () => {}, pendingActionId: null }),
    },
    {
      name: "the operations-view instrumentation strip",
      render: () => {
        (sandbox.window as Record<string, unknown>).ImprovementInstrumentationVerdicts = {
          styleRefGradeBadgeI: () => ({ symbol: "⚠", tone: "text-warn", label: "warn", hint: "emission below the gate" }),
          getCorpusGrowthVerdictI: () => ({ symbol: "✕", tone: "text-crit", label: "Growth alert", hint: "corpus grew past the cap" }),
        };
        return component("InstrumentationStripI")({
          styleRef: { overall_emission_rate: 0.3, overall_uncorroborated_rate: 0.2 },
          corpusAuditState: { status: "ready", data: { audits: [{}] } },
          onOpen: () => {},
        });
      },
    },
    {
      name: "the pre-verify drawer header",
      render: () =>
        component("PreVerifyDetailI")({
          badge: (sandbox.preVerifyBadgeI as (status: string, passed: null) => unknown)("error: budget wall", null),
          rationale: null,
          axes: [],
          labelCls: "fs-meta",
        }),
    },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const tree = screenTree(row.render(), [sandbox.ProposalCardI]);
      assert.ok(tree.length > 0, "the surface renders");
      assert.deepEqual(getToneTextNodes(tree), [], "a word or figure repeats the tone its glyph already declares");
    });
  }
});

test("the awaiting banner announces through its live zone as the shared warn alert card", () => {
  const tree = screenTree(
    component("AwaitingBannerI")({ rows: [PROPOSAL], onRowClick: () => {}, onAction: () => {}, pendingActionId: null }),
    [sandbox.ProposalCardI],
  );
  const cards = tree.filter((el) => el.type === sandbox.window.UI.AlertCard);
  assert.equal(cards.length, 1, "one alert card heads the awaiting list");
  assert.equal(cards[0].props.tone, "warn");
  assert.equal(cards[0].props.hasLiveHost, true, "the zone around it is already the live region");
});

test("approve and reject are shared buttons: approve keeps a neutral label, reject is the destructive outline", () => {
  const tree = screenTree(component("ProposalActionsI")({ row: PROPOSAL, isSafety: false, onAction: () => {}, isPending: false }));
  const [approve, reject] = tree.filter((el) => el.type === "button");
  assert.ok(approve && reject, "both actions render");
  for (const button of [approve, reject]) {
    assert.match(String(button.props.className), /\bbtn\b.*\bsm\b|\bsm\b.*\bbtn\b/, "an action outside the shared .btn family");
  }
  const approveGlyph = screenTree(approve.props.children).find((el) => el.props.s === "✓");
  assert.match(String(approveGlyph?.props.className ?? ""), /\btext-ok\b/, "the approve glyph carries the ok tone");
  const style = (reject.props.style ?? {}) as Record<string, unknown>;
  assert.equal(style.color, "rgb(var(--crit))", "the destructive label is crit");
  assert.equal(style.borderColor, "rgb(var(--crit))", "the destructive outline is crit");
  assert.equal(style.background, undefined, "the destructive outline carries no fill");
});

describe("tiles rest on the shared sub-card, and only an interactive tile answers hover", () => {
  const rows = [
    {
      name: "a loading metric tile",
      isInteractive: false,
      render: () => component("TilePlaceholderI")({ status: "loading", label: "Applied", owner: "x", onRetry: () => {} }),
    },
    {
      name: "a live candidate row",
      isInteractive: true,
      render: () =>
        component("CandidateRowI")({
          rank: 1,
          pattern: { frequency: 3, status: "pending", pattern_signature: "size overrun", agent: "glass-atrium-dev-node" },
          maxFreq: 5,
          onClick: () => {},
        }),
    },
  ];
  for (const row of rows) {
    test(row.name, () => {
      const root = row.render() as RecordedElement;
      const className = String(root.props.className ?? "");
      assert.match(className, /\bsub-card\b/, "a tile drawing its own ring or shadow");
      assert.equal(/\bi-tile-hover\b/.test(className), row.isInteractive, "hover affordance on a tile that does nothing");
    });
  }
});
