// Unit tests for the closure-aware Task-results logic in
// public/src/screens/dashboard.jsx — computeOutcomeHint / computeWorstRollup.
// The norm warning keys on OPEN done-with-concerns (count - closed_count), so an
// all-closed DWC population must stop warning while the total count and the
// fail/blocked thresholds stay closure-blind. The open-count derivation itself
// now lives in ui.jsx and is pinned by ui.outcome-tone.client.unit.test.ts.
//
// Sandbox harness (esbuild + node:vm over the real shipped dashboard.jsx): client-sandbox.ts.
//
// Runner: npx tsx --test test/dashboard.dwc-closure.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox, LOW_N_MIN } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASH_SRC = resolve(__dirname, "../public/src/screens/dashboard.jsx");

interface ByResultRow {
  result: string;
  count: number;
  closed_count?: number;
}
interface Hint {
  tone: string;
  text: string;
}
interface DashHelpers {
  computeOutcomeHint: (byResultMap: Map<string, ByResultRow>, total: number) => Hint | null;
  computeWorstRollup: (args: { outcomesState: unknown }) => string | null;
}

// withUi — the hint and the rollup read the writer-population helpers through
// window.UI, so the stub's formatter-only surface is not enough.
const helpers = await buildScreenSandbox<DashHelpers>(DASH_SRC, { withUi: true });

function buildMap(rows: ByResultRow[]): Map<string, ByResultRow> {
  return new Map(rows.map((r) => [r.result, r]));
}
function buildRollupState(rows: ByResultRow[], total: number): { outcomesState: unknown } {
  return { outcomesState: { status: "ready", data: { total, by_result: rows } } };
}

// --- AC2: the norm warning keys on OPEN done-with-concerns ---

test("AC2: 10 open DWC of 100 warns above the 7-day norm", () => {
  const hint = helpers.computeOutcomeHint(
    buildMap([{ result: "done", count: 90 }, { result: "done_with_concerns", count: 10, closed_count: 0 }]),
    100,
  );
  assert.strictEqual(hint?.tone, "warn");
  assert.match(hint?.text ?? "", /above the 7-day norm/);
});

test("AC2: 10 DWC of 100 ALL CLOSED no longer warns", () => {
  const hint = helpers.computeOutcomeHint(
    buildMap([{ result: "done", count: 90 }, { result: "done_with_concerns", count: 10, closed_count: 10 }]),
    100,
  );
  assert.strictEqual(hint, null);
});

test("AC2: mixed closure crosses the threshold on the open share only", () => {
  const below = helpers.computeOutcomeHint(
    buildMap([{ result: "done", count: 90 }, { result: "done_with_concerns", count: 10, closed_count: 6 }]),
    100,
  );
  assert.strictEqual(below, null, "4 open of 100 is under the 10% threshold");

  const above = helpers.computeOutcomeHint(
    buildMap([{ result: "done", count: 80 }, { result: "done_with_concerns", count: 20, closed_count: 5 }]),
    100,
  );
  assert.strictEqual(above?.tone, "warn", "15 open of 100 is over the threshold");
});

test("AC2: an absent closed_count stays backward-compatible (all open)", () => {
  const hint = helpers.computeOutcomeHint(
    buildMap([{ result: "done", count: 90 }, { result: "done_with_concerns", count: 10 }]),
    100,
  );
  assert.strictEqual(hint?.tone, "warn");
});

test("AC2: fail/blocked logic is untouched by closure", () => {
  const crit = helpers.computeOutcomeHint(
    buildMap([
      { result: "done", count: 94 },
      { result: "fail", count: 4, closed_count: 4 },
      { result: "blocked", count: 2, closed_count: 2 },
    ]),
    100,
  );
  assert.strictEqual(crit?.tone, "crit", "closure never de-escalates the breakage threshold");

  // Breakage outranks an open-DWC warn, as before.
  const both = helpers.computeOutcomeHint(
    buildMap([{ result: "done_with_concerns", count: 20 }, { result: "fail", count: 10 }]),
    100,
  );
  assert.strictEqual(both?.tone, "warn", "DWC is evaluated first — precedence unchanged");
});

// --- AC2: computeWorstRollup uses the same open-based rate ---

test("AC2: rollup warns on open DWC and clears once they are all closed", () => {
  assert.strictEqual(
    helpers.computeWorstRollup(buildRollupState(
      [{ result: "done", count: 90 }, { result: "done_with_concerns", count: 10, closed_count: 0 }],
      100,
    )),
    "warn",
  );
  assert.strictEqual(
    helpers.computeWorstRollup(buildRollupState(
      [{ result: "done", count: 90 }, { result: "done_with_concerns", count: 10, closed_count: 10 }],
      100,
    )),
    "ok",
  );
});

test("AC2: rollup breakage stays closure-blind and outranks DWC", () => {
  assert.strictEqual(
    helpers.computeWorstRollup(buildRollupState(
      [
        { result: "done", count: 84 },
        { result: "done_with_concerns", count: 10, closed_count: 10 },
        { result: "fail", count: 6, closed_count: 6 },
      ],
      100,
    )),
    "crit",
  );
});

test("rollup still skips low-n samples regardless of closure", () => {
  assert.strictEqual(
    helpers.computeWorstRollup(buildRollupState(
      [{ result: "done_with_concerns", count: 5, closed_count: 0 }],
      LOW_N_MIN - 1,
    )),
    "ok",
  );
});
