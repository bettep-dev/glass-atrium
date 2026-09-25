// Unit test for getModelLabelC in public/src/screens/cost.jsx — the one model label the ledger,
// the session table and the session drawer share. A model must read the same wherever it
// appears, and two differently priced ids (claude-fable-5-1 vs claude-fable-5) must never
// collapse onto one label.
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
  getModelLabelC: (name: unknown) => string;
}

const cost = await buildScreenSandbox<CostHelpers>(COST_SRC);

test("every spelling of one model reads as one label", () => {
  const spellings: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["opus 5", ["claude-opus-5", "opus-5", "claude-opus-5-20260101"]],
    ["haiku 4.5", ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]],
  ];
  for (const [name, ids] of spellings) {
    const labels = new Set(ids.map((id) => cost.getModelLabelC(id)));
    assert.equal(labels.size, 1, name);
  }
});

test("a base id and its minor-versioned sibling never collapse onto one label", () => {
  assert.notStrictEqual(cost.getModelLabelC("claude-fable-5"), cost.getModelLabelC("claude-fable-5-1"));
  assert.notStrictEqual(cost.getModelLabelC("claude-opus-5"), cost.getModelLabelC("claude-opus-5-5"));
});

test("an unattributed placeholder never reads as a model name", () => {
  for (const raw of ["<synthetic>", "unknown", "", null]) {
    assert.strictEqual(cost.getModelLabelC(raw), "Unattributed", String(raw));
  }
});

test("an unrecognized id passes through as given rather than mangled", () => {
  for (const raw of ["gpt-4o", "claude-3-5-sonnet-20241022"]) {
    assert.strictEqual(cost.getModelLabelC(raw), raw, raw);
  }
});
