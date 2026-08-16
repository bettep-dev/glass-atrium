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
