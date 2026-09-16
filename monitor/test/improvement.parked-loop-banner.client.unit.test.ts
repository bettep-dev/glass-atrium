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

interface RecordedElement {
  type: unknown;
  props: Record<string, unknown>;
}

interface BannerSandbox {
  React: { createElement: unknown };
  ParkedLoopBannerI: (props: { applyCap: unknown }) => RecordedElement | null;
  AlarmLaneI: (props: { applyCap: unknown }) => RecordedElement | null;
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
  const src = await readFile(IMPROVEMENT_SRC, "utf8");
  const hex = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hex, [], "hex colour literals bypass the token layer");
  const rawFns = (src.match(/rgba?\([^)]*\)/g) ?? []).filter(
    (decl) => !decl.includes("var(") && !/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*[,)]/.test(decl),
  );
  assert.deepEqual(rawFns, [], "only the neutral drop shadow may name a colour without a token");
});
