// Render guard for ParkedLoopBannerI in public/src/screens/improvement.jsx.
//
// improvement.rearm-hint.unit.test.ts pins what the warning SAYS; nothing pinned
// whether an operator can read it. `.card-sub` in public/styles/base.css is a
// one-line clamp (white-space:nowrap + overflow:hidden + text-overflow:ellipsis),
// and the hint is ~500 chars, so a `.card-sub` without the `.is-wrap` opt-out
// truncates mid-sentence — at a point that reads like the retracted advice to
// reset the status. A `title` tooltip is not an acceptable substitute: a warning
// whose content is "do not do this" cannot live behind a hover.
//
// This is a real render assertion, not a source-shape pin: the component is
// invoked over the shipped source (esbuild + node:vm harness) with a recording
// React.createElement, and the emitted element tree is walked for the node whose
// child IS the rearm_hint. Its limit is that it asserts the class contract, not
// computed CSS — the clamp/opt-out semantics of `.card-sub` / `.is-wrap` live in
// base.css and are pinned there by the stylesheet, not here.
//
// Runner: npx tsx --test test/improvement.parked-loop-banner.client.unit.test.ts

import test from "node:test";
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

const rendered = sandbox.ParkedLoopBannerI({
  applyCap: { capped_patterns: 2, capped_agents: 1, rearm_hint: HINT },
});
// The bucket row asks the shared harness for one more window.UI member than the
// module top level reads.
Object.assign(sandbox.window.UI, { titleOf: (value: unknown) => value });

const hosts = findHintHosts(rendered, []);

test("the rendered banner puts the hint in exactly one element", () => {
  assert.equal(hosts.length, 1, "the walk must find the hint's host to assert anything about it");
});

// The discriminating assertion: red against a plain `card-sub`, green with the opt-out.
test("the hint's host opts out of the one-line card-sub clamp", () => {
  const host = hosts[0];
  assert.ok(host, "no host element found for the hint");
  const className = String(host.props.className ?? "");
  assert.match(className, /\bcard-sub\b/, "the hint is styled as a card-sub");
  assert.match(
    className,
    /\bis-wrap\b/,
    "without is-wrap the ~500-char warning clamps to one ellipsised line",
  );
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

// ----- Stream-5 reconciliation guards: the lane's tint contract and the spine order ---
//
// The plan's standing decision is that tone rides on a glyph, a severity bar or a
// container tint and NEVER on text — severity hue as text fails AA on the light
// theme. Nothing pinned it, and the banner headline carried `text-warn` while the
// glyph beside it already carried the same tone. These two assertions pin the
// contract at the one surface that is allowed a tint at all.

const SEVERITY_TEXT_CLASS = /\btext-(warn|crit|ok)\b/;

function collectElements(node: unknown, out: RecordedElement[]): RecordedElement[] {
  if (!isElement(node)) return out;
  out.push(node);
  const children = node.props.children;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) collectElements(child, out);
  return out;
}

test("severity hue rides on the glyph, never on a text node", () => {
  const tinted = collectElements(rendered, []).filter((el) =>
    SEVERITY_TEXT_CLASS.test(String(el.props.className ?? "")),
  );
  assert.ok(tinted.length > 0, "the banner must carry its tone somewhere");
  for (const el of tinted) {
    assert.notEqual(
      el.props.s,
      undefined,
      `severity hue on a non-glyph node (${String(el.props.className)}) — tone must ride on the glyph or the container tint`,
    );
  }
});

test("the alarm lane carries the tint on its container", () => {
  const lane = sandbox.AlarmLaneI({
    applyCap: { capped_patterns: 2, capped_agents: 1, rearm_hint: HINT },
  });
  assert.ok(isElement(lane), "a populated cap must render the lane");
  assert.match(
    String(lane.props.className ?? ""),
    /\bi-alarm-lane\b/,
    "the lane class is what carries the tint; a tinted child would put it on the wrong surface",
  );
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
// interpolated token name. The single exemption is a neutral drop shadow, which
// encodes no severity and has no token.
test("colour is consumed through design tokens, never a raw literal", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const path of [IMPROVEMENT_SRC, INSTRUMENTATION_SRC]) {
    const src = await readFile(path, "utf8");
    const hex = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(hex, [], `hex colour literals bypass the token layer in ${path}`);
    const rawFns = (src.match(/rgba?\([^)]*\)/g) ?? []).filter(
      (decl) => !decl.includes("var(") && !/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*[,)]/.test(decl),
    );
    assert.deepEqual(
      rawFns,
      [],
      `only the neutral drop shadow may name a colour without a token in ${path}`,
    );
  }
});

// ----- The same contract on the REPORT surfaces --------------------------------
//
// The banner walk above covers the one surface the plan allows a container tint.
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
