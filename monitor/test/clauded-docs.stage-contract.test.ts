// Pins the read/write split the stage vocabulary rests on: what a write accepts, what a read
// filter accepts, what a stored token reads as, and when the group cascade fires. A read set
// narrower than the stored set drops rows and empties the operator's open list.
// Runner: npx tsx --import ./test/lib/select-test-db.ts --test test/clauded-docs.stage-contract.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import type { DocStatusLiteral } from "../src/server/types/clauded-docs.js";
import {
  DOC_STAGES,
  getGroupStage,
  DOC_STATUS_READ_FILTERS,
  WRITE_DOC_STATUSES,
  isCascadeTransition,
  normalizeStoredStage,
} from "../src/server/routes/clauded-docs.js";

const RETIRED_ALIAS: DocStatusLiteral = "progress";
const TERMINAL_STAGE = "done" as const;

test("every stored token reads as a stage, so no stored row is dropped", () => {
  for (const stored of [...DOC_STAGES, RETIRED_ALIAS]) {
    assert.notEqual(
      normalizeStoredStage(stored), null,
      `stored '${stored}' must read as a stage`,
    );
  }
  assert.equal(normalizeStoredStage(RETIRED_ALIAS), DOC_STAGES[0]);
  assert.equal(normalizeStoredStage("not-a-token"), null);
});

test("normalizing is idempotent on the stages themselves", () => {
  for (const stage of DOC_STAGES) {
    assert.equal(normalizeStoredStage(stage), stage);
  }
});

test("the write set accepts the retired alias, and the read filter set adds the open pseudo-value", () => {
  for (const stored of [...DOC_STAGES, RETIRED_ALIAS]) {
    assert.ok(WRITE_DOC_STATUSES.has(stored), `write must accept '${stored}'`);
    assert.ok(DOC_STATUS_READ_FILTERS.has(stored), `read filter must accept '${stored}'`);
  }
  assert.ok(DOC_STATUS_READ_FILTERS.has("open"));
  assert.equal(WRITE_DOC_STATUSES.has("open" as never), false);
  assert.equal(DOC_STATUS_READ_FILTERS.size, WRITE_DOC_STATUSES.size + 1);
});

test("cascade fires only on the terminal transition of a grouped row", () => {
  const terminal = DOC_STAGES[DOC_STAGES.length - 1];
  const grouped = { folder_id: 7n, doc_status: "doc_review" };

  assert.equal(isCascadeTransition(terminal, grouped), true);
  for (const stage of DOC_STAGES.filter((s) => s !== terminal)) {
    assert.equal(
      isCascadeTransition(stage, grouped), false,
      `'${stage}' is not terminal — it must touch the one document`,
    );
  }
  assert.equal(isCascadeTransition(terminal, { folder_id: null, doc_status: "doc_review" }), false);
  assert.equal(isCascadeTransition(terminal, { folder_id: 7n, doc_status: terminal }), false);
  assert.equal(isCascadeTransition(undefined, grouped), false);
});

test("a group row takes its least-advanced member stage, and reports a spread as non-uniform", () => {
  for (const [index, stage] of DOC_STAGES.entries()) {
    const rank = index + 1;
    assert.deepEqual(getGroupStage(rank, rank, TERMINAL_STAGE), { stage, uniform: true });

    const spread = getGroupStage(rank, DOC_STAGES.length, TERMINAL_STAGE);
    assert.equal(spread.stage, stage, "the least-advanced member decides the rendered stage");
    assert.equal(spread.uniform, rank === DOC_STAGES.length);
  }
  // a rank no stage covers keeps the representative stage — an empty cell would read as unknown.
  assert.deepEqual(getGroupStage(0, 0, "implementing"), { stage: "implementing", uniform: true });
});
