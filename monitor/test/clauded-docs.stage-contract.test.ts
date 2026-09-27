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
  getDocStatusFilterSql,
  getLastStatusModel,
  isCascadeTransition,
  isStatusAction,
  normalizeStoredStage,
  parseEnumListParam,
} from "../src/server/routes/clauded-docs.js";

const RETIRED_ALIAS: DocStatusLiteral = "progress";
const TERMINAL_STAGE = "done" as const;
const STORED_TOKENS = [...DOC_STAGES, RETIRED_ALIAS];

test("every stored token reads as a stage, so no stored row is dropped", () => {
  for (const stored of STORED_TOKENS) {
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
  for (const stored of STORED_TOKENS) {
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

test("a write moves the stage only when its token differs from what the stored one reads as", () => {
  for (const stored of STORED_TOKENS) {
    const existing = { doc_status: stored };
    const storedStage = normalizeStoredStage(stored);

    assert.equal(
      isStatusAction(storedStage as DocStatusLiteral, existing), false,
      `echoing '${stored}' is a body re-emit, not a status action`,
    );
    assert.equal(isStatusAction(undefined, existing), false);
    for (const stage of DOC_STAGES.filter((s) => s !== storedStage)) {
      assert.equal(
        isStatusAction(stage, existing), true,
        `'${stored}' → '${stage}' moves the row`,
      );
    }
  }
  // the retired alias echo is the case a presence check misses: stored 'progress', written first stage.
  assert.equal(isStatusAction(DOC_STAGES[0], { doc_status: RETIRED_ALIAS }), false);
});

test("the stored actor survives every non-moving write and is replaced only by the move", () => {
  const STORED_ACTOR = "claude-opus-5";
  for (const stored of STORED_TOKENS) {
    const existing = { doc_status: stored, last_status_model: STORED_ACTOR };
    const storedStage = normalizeStoredStage(stored) as DocStatusLiteral;

    assert.equal(getLastStatusModel({}, existing), STORED_ACTOR, "status-less write keeps the actor");
    assert.equal(
      getLastStatusModel({ doc_status: storedStage }, existing), STORED_ACTOR,
      `echoing '${stored}' must not wipe the actor`,
    );
    assert.equal(
      getLastStatusModel({ doc_status: storedStage, last_status_model: "other" }, existing),
      STORED_ACTOR,
      "an echo is not a status action, so it cannot re-attribute either",
    );

    for (const stage of DOC_STAGES.filter((s) => s !== storedStage)) {
      assert.equal(getLastStatusModel({ doc_status: stage, last_status_model: "operator" }, existing), "operator");
      assert.equal(
        getLastStatusModel({ doc_status: stage }, existing), null,
        "a move carrying no model has an unknown actor, never the previous one",
      );
    }
  }
});

test("the open filter is every stage but the terminal one, and the first stage also matches the alias", () => {
  const open = getDocStatusFilterSql("open");
  assert.deepEqual(open.values, [TERMINAL_STAGE], "open is defined against the terminal stage alone");
  assert.match(open.strings.join("?"), /<>/);

  const first = getDocStatusFilterSql(DOC_STAGES[0]);
  assert.deepEqual(
    first.values, [DOC_STAGES[0]],
    "the first-stage chip must also match rows still stored as the alias",
  );
  assert.match(first.strings.join("?"), /IN \(\?, 'progress'\)/);
  assert.deepEqual(getDocStatusFilterSql(RETIRED_ALIAS).strings, first.strings);

  for (const stage of DOC_STAGES.slice(1)) {
    const sql = getDocStatusFilterSql(stage);
    assert.deepEqual(sql.values, [stage], `'${stage}' filters on itself`);
    assert.match(sql.strings.join("?"), /=/);
  }
});

test("a multi-value filter parses repeat and comma forms alike, and one unknown token rejects the whole list", () => {
  const cases: Array<{ raw: string | string[] | undefined; parsed: string[] | null }> = [
    { raw: undefined, parsed: null },
    { raw: "", parsed: null },
    { raw: [" , ", ""], parsed: null },
    { raw: "implementing", parsed: ["implementing"] },
    { raw: ["impl_done", "implementing"], parsed: ["impl_done", "implementing"] },
    { raw: ["open, done", " open ,impl_review"], parsed: ["open", "done", "impl_review"] },
  ];
  for (const { raw, parsed } of cases) {
    assert.deepEqual(parseEnumListParam(raw, DOC_STATUS_READ_FILTERS), parsed, JSON.stringify(raw));
  }

  for (const raw of ["bogus", "implementing,bogus", ["implementing", "bogus"], "Open"]) {
    assert.equal(parseEnumListParam(raw, DOC_STATUS_READ_FILTERS), "INVALID", JSON.stringify(raw));
  }
});
