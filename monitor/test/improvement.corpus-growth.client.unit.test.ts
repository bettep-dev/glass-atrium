// Unit test for formatRateI in public/src/screens/improvement.jsx — the screen's
// rate renderer, which the corpus-growth card reuses for compliance_rate /
// override_rate. Those two are nullable end to end
// because a null is insufficient data and a 0 is a measured total failure; a
// renderer that folds them together destroys the distinction the column carries.
//
// Sandbox harness (esbuild + node:vm over the real shipped improvement.jsx): client-sandbox.ts.
//
// Runner: npx tsx --test test/improvement.corpus-growth.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMPROVEMENT_SRC = resolve(__dirname, "../public/src/screens/improvement.jsx");

interface ImprovementHelpers {
  formatRateI: (rate: number | null | undefined) => string;
}

const helpers = await buildScreenSandbox<ImprovementHelpers>(IMPROVEMENT_SRC);

test("null rate renders as the insufficient-data dash, never a percentage", () => {
  assert.equal(helpers.formatRateI(null), "—");
  assert.equal(helpers.formatRateI(undefined), "—");
});

// The discriminating case: a falsy-check renderer passes the null case above and
// fails here, collapsing a measured zero into "no data".
test("a measured zero rate stays a zero percentage", () => {
  assert.equal(helpers.formatRateI(0), "0.0%");
});

test("a fractional rate renders as a one-decimal percentage", () => {
  assert.equal(helpers.formatRateI(0.9532), "95.3%");
  assert.equal(helpers.formatRateI(1), "100.0%");
});
