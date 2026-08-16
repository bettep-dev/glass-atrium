// Unit tests for the synthesized-row exclusion in the Task-results quality signal
// (public/src/screens/dashboard.jsx — getWriterTotal / getWriterOpenCount /
// computeOutcomeHint / computeWorstRollup). A recorder-synthesized row's `result` is
// chosen by the recorder, not the writer, so it carries no quality information: it
// leaves BOTH the DWC-share numerator and its denominator.
//
// Sandbox harness (esbuild + node:vm over the real shipped dashboard.jsx): client-sandbox.ts.
//
// Runner: npx tsx --test test/dashboard.synthesized-exclusion.client.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildScreenSandbox } from "./client-sandbox.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASH_SRC = resolve(__dirname, "../public/src/screens/dashboard.jsx");

interface ByResultRow {
  result: string;
  count: number;
  closed_count?: number;
  reconstructed_count?: number;
  writer_open_count?: number;
}
interface CrossAnalysisData {
  total: number;
  reconstructed_total?: number;
  by_result: ByResultRow[];
}
interface Hint {
  tone: string;
  text: string;
}
interface DashHelpers {
  getWriterTotal: (data: CrossAnalysisData | undefined) => number;
  getWriterOpenCount: (row: ByResultRow | undefined) => number;
  computeOutcomeHint: (byResultMap: Map<string, ByResultRow>, writerTotal: number) => Hint | null;
  computeWorstRollup: (args: { outcomesState: unknown }) => string | null;
}

const helpers = await buildScreenSandbox<DashHelpers>(DASH_SRC);

function buildMap(rows: ByResultRow[]): Map<string, ByResultRow> {
  return new Map(rows.map((r) => [r.result, r]));
}
function buildRollupState(data: CrossAnalysisData): { outcomesState: unknown } {
  return { outcomesState: { status: "ready", data } };
}

// --- the two derivations ---

test("getWriterTotal subtracts the synthesized population from the denominator", () => {
  assert.strictEqual(helpers.getWriterTotal({ total: 100, reconstructed_total: 40, by_result: [] }), 60);
});

test("getWriterTotal keeps the legacy denominator when the field is absent", () => {
  assert.strictEqual(helpers.getWriterTotal({ total: 100, by_result: [] }), 100);
  assert.strictEqual(helpers.getWriterTotal(undefined), 0);
});

test("getWriterOpenCount falls back to the closure-only open count on a legacy row", () => {
  const legacy = { result: "done_with_concerns", count: 10, closed_count: 4 };
  assert.strictEqual(helpers.getWriterOpenCount(legacy), 6);
  assert.strictEqual(helpers.getWriterOpenCount(undefined), 0);
});

// --- numerator + denominator exclusion ---

test("a DWC population that is entirely synthesized raises no norm warning", () => {
  const hint = helpers.computeOutcomeHint(
    buildMap([
      { result: "done", count: 60, reconstructed_count: 0, writer_open_count: 60 },
      { result: "done_with_concerns", count: 40, reconstructed_count: 40, writer_open_count: 0 },
    ]),
    helpers.getWriterTotal({ total: 100, reconstructed_total: 40, by_result: [] }),
  );
  assert.strictEqual(hint, null, "the recording artifact no longer reads as a quality downgrade");
});

test("writer-emitted DWC still warns, and its share is taken against the writer-only denominator", () => {
  const hint = helpers.computeOutcomeHint(
    buildMap([
      { result: "done", count: 50, reconstructed_count: 0, writer_open_count: 50 },
      { result: "done_with_concerns", count: 50, reconstructed_count: 40, writer_open_count: 10 },
    ]),
    helpers.getWriterTotal({ total: 100, reconstructed_total: 40, by_result: [] }),
  );
  assert.strictEqual(hint?.tone, "warn");
  assert.match(hint?.text ?? "", /\(10\/60\)/, "denominator excludes the synthesized rows too");
});

test("synthesized done rows (the structuredoutput-derived shape) leave the denominator by the same field", () => {
  // 합성행이 전부 result=done — 분자는 건드리지 않고 분모만 줄어들어 임계를 넘긴다.
  const hint = helpers.computeOutcomeHint(
    buildMap([
      { result: "done", count: 94, reconstructed_count: 40, writer_open_count: 54 },
      { result: "done_with_concerns", count: 6, reconstructed_count: 0, writer_open_count: 6 },
    ]),
    helpers.getWriterTotal({ total: 100, reconstructed_total: 40, by_result: [] }),
  );
  assert.strictEqual(hint?.tone, "warn", "6 open of a 60-row writer population is at the threshold");
  assert.match(hint?.text ?? "", /\(6\/60\)/);
});

// --- the rollup reads the same population ---

test("the severity rollup clears once the synthesized rows leave the quality signal", () => {
  assert.strictEqual(
    helpers.computeWorstRollup(buildRollupState({
      total: 100,
      reconstructed_total: 40,
      by_result: [
        { result: "done", count: 60, reconstructed_count: 0, writer_open_count: 60 },
        { result: "done_with_concerns", count: 40, reconstructed_count: 40, writer_open_count: 0 },
      ],
    })),
    "ok",
  );
  assert.strictEqual(
    helpers.computeWorstRollup(buildRollupState({
      total: 100,
      reconstructed_total: 40,
      by_result: [
        { result: "done", count: 50, reconstructed_count: 0, writer_open_count: 50 },
        { result: "done_with_concerns", count: 50, reconstructed_count: 40, writer_open_count: 10 },
      ],
    })),
    "warn",
  );
});
