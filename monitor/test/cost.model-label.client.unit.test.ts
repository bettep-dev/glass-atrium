// Unit test for shortenModelName in public/src/screens/cost.jsx — the by-model chart's
// X-axis label helper. The surface must render EVERY model id in ONE shortened form: a
// family whose regex falls through renders a raw id beside a shortened sibling, and a
// date/minor ambiguity would silently collapse two differently priced ids
// (claude-fable-5-1 vs claude-fable-5) onto one label.
//
// Runner: npx tsx --test test/cost.model-label.client.unit.test.ts
// Sandbox harness (esbuild + node:vm over the real shipped cost.jsx): client-sandbox.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COST_SRC = resolve(__dirname, "../public/src/screens/cost.jsx");

interface CostHelpers {
  shortenModelName: (name: unknown) => string;
}

const cost = await buildScreenSandbox<CostHelpers>(COST_SRC);
assert.strictEqual(typeof cost.shortenModelName, "function", "shortenModelName must be reachable");

// The approved mapping — every model id the by-model surface currently renders.
const APPROVED_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["claude-opus-5", "opus-5"],
  ["claude-fable-5", "fable-5"],
  ["claude-fable-5-1", "fable-5.1"],
  ["claude-sonnet-5", "sonnet-5"],
  ["claude-haiku-4-5-20251001", "haiku-4.5"],
  ["claude-opus-4-8", "opus-4.8"],
  ["<synthetic>", "<synthetic>"],
  ["unknown", "unknown"],
];

test("every by-model label renders in one shortened form", () => {
  for (const [raw, expected] of APPROVED_LABELS) {
    assert.strictEqual(cost.shortenModelName(raw), expected, raw);
  }
});

test("a base id and its minor-versioned sibling never collapse onto one label", () => {
  assert.notStrictEqual(
    cost.shortenModelName("claude-fable-5"),
    cost.shortenModelName("claude-fable-5-1"),
  );
});

test("a trailing snapshot date is dropped, never rendered as a minor version", () => {
  assert.strictEqual(cost.shortenModelName("claude-haiku-4-5-20251001"), "haiku-4.5");
  assert.strictEqual(cost.shortenModelName("claude-opus-5-20260101"), "opus-5");
});

test("unrecognized shapes pass through raw rather than mangling", () => {
  for (const raw of ["claude-3-5-sonnet-20241022", "claude-opus-4-8-1-2", "gpt-4o"]) {
    assert.strictEqual(cost.shortenModelName(raw), raw, raw);
  }
});

test("absent or non-string input renders the em-dash placeholder", () => {
  assert.strictEqual(cost.shortenModelName(""), "—");
  assert.strictEqual(cost.shortenModelName(null), "—");
  assert.strictEqual(cost.shortenModelName(undefined), "—");
  assert.strictEqual(cost.shortenModelName(42), "—");
});
