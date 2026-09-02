// Unit tests for the GET-side legacy read: resolveDesiredWithLegacy (model-config-consts.ts) and
// the daemon_config_sync state it feeds (routes/model-config.ts).
//
// WHY a DB-free file rather than cases in model-config.route.test.ts: that suite needs a live
// Postgres, and the state under test is an UN-MIGRATED monitor.model_config — rows still under
// their pre-rename names, which every install carries after `scripts/update.sh` ships new server
// code without running `prisma migrate deploy`. Both units take plain maps, so the state is
// reachable with no database at all. The route suite keeps the end-to-end version of the same case.
//
// Sibling: model-config.render.unit.test.ts covers the WRITE side of the same window (the
// daemon-config.json carry-forward). This file covers the READ side.
//
// Runner: npx tsx --test test/model-config.legacy-read.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RENAMED_DAEMON_CONFIG_KEYS,
  RETIRED_WORKER_MODEL_REPLACEMENT,
  resolveDesiredWithLegacy,
} from "../src/server/model-config-consts.js";
import { computeDaemonConfigSync } from "../src/server/routes/model-config.js";

const MIGRATION_SQL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prisma",
  "migrations",
  "20260901000000_rename_haiku_model_config_keys_to_worker",
  "migration.sql",
);

/** monitor.model_config rows as the route reads them, before any resolution. */
const rowsOf = (rows: Record<string, string>): ReadonlyMap<string, string> =>
  new Map(Object.entries(rows));

// The exact state an updated-but-un-migrated install is in: the init_squashed seed's two
// pre-rename rows, and nothing under the post-rename names the server now queries.
const UN_MIGRATED = {
  "model.dev": "inherit",
  "model.daemon_cycle_haiku": "claude-haiku-4-5",
  "budget.haiku_max_usd": "0.75",
  "budget.pre_verify_max_usd": "10.00",
};

// The same install after `prisma migrate deploy`: post-rename rows, legacy rows deleted.
const MIGRATED = {
  "model.dev": "inherit",
  "model.daemon_cycle_worker": "claude-sonnet-5",
  "budget.worker_max_usd": "0.75",
  "budget.pre_verify_max_usd": "10.00",
};

// --- resolveDesiredWithLegacy ---------------------------------------------------------

test("un-migrated DB: both renamed domains resolve from their pre-rename rows", () => {
  const { desired, legacySourced } = resolveDesiredWithLegacy(rowsOf(UN_MIGRATED));

  // Without the read these two are undefined, which is what rendered the model input as an empty
  // 'custom…' and the cap as '—' over a DB that holds both values.
  assert.strictEqual(desired.get("model.daemon_cycle_worker"), RETIRED_WORKER_MODEL_REPLACEMENT);
  assert.strictEqual(desired.get("budget.worker_max_usd"), "0.75", "a cap moves verbatim");
  assert.deepStrictEqual(
    [...legacySourced].sort(),
    ["budget.worker_max_usd", "model.daemon_cycle_worker"],
    "both domains are marked legacy-sourced",
  );
  // Untouched rows pass through unchanged.
  assert.strictEqual(desired.get("model.dev"), "inherit");
  assert.strictEqual(desired.get("budget.pre_verify_max_usd"), "10.00");
});

test("the MODEL value follows the migration's rewrite policy, the BUDGET never does", () => {
  // Surfacing a retired id would invite a Save that pins the loop back onto the retired model —
  // the one outcome the rename exists to prevent. Covers the API-style shapes a prefix test misses.
  for (const retired of [
    "claude-3-5-haiku-20241022",
    "claude-3-5-haiku-latest",
    "claude-haiku-4-5",
    "haiku",
  ]) {
    const { desired } = resolveDesiredWithLegacy(rowsOf({ "model.daemon_cycle_haiku": retired }));
    assert.strictEqual(
      desired.get("model.daemon_cycle_worker"),
      RETIRED_WORKER_MODEL_REPLACEMENT,
      `${retired} must be rewritten on the read door too`,
    );
  }

  const { desired } = resolveDesiredWithLegacy(
    rowsOf({ "model.daemon_cycle_haiku": "claude-opus-5", "budget.haiku_max_usd": "50.00" }),
  );
  assert.strictEqual(desired.get("model.daemon_cycle_worker"), "claude-opus-5", "verbatim");
  assert.strictEqual(desired.get("budget.worker_max_usd"), "50.00", "a cap is never rewritten");
});

test("a row under the current name wins outright — the legacy row is never consulted", () => {
  // This is what makes a Save self-healing: the PUT writes the POST-rename key, so the next GET
  // resolves from that row and the legacy read goes quiet for that domain, migration or not.
  const { desired, legacySourced } = resolveDesiredWithLegacy(
    rowsOf({
      "model.daemon_cycle_worker": "claude-opus-5",
      "model.daemon_cycle_haiku": "claude-haiku-4-5",
      "budget.worker_max_usd": "2.50",
      "budget.haiku_max_usd": "0.75",
    }),
  );

  assert.strictEqual(desired.get("model.daemon_cycle_worker"), "claude-opus-5");
  assert.strictEqual(desired.get("budget.worker_max_usd"), "2.50");
  assert.strictEqual(legacySourced.size, 0, "nothing was read from a legacy row");
});

test("a partial Save leaves only the un-Saved domain legacy-sourced", () => {
  // A models-only PUT on an un-migrated DB writes model.daemon_cycle_worker and nothing else, so
  // the cap is still only reachable under its old name until db-setup runs or a cap is Saved.
  const { desired, legacySourced } = resolveDesiredWithLegacy(
    rowsOf({ ...UN_MIGRATED, "model.daemon_cycle_worker": "claude-opus-5" }),
  );

  assert.strictEqual(desired.get("model.daemon_cycle_worker"), "claude-opus-5");
  assert.strictEqual(desired.get("budget.worker_max_usd"), "0.75");
  assert.deepStrictEqual([...legacySourced], ["budget.worker_max_usd"]);
});

test("hand-pruned DB: neither row present → nothing is invented", () => {
  const { desired, legacySourced } = resolveDesiredWithLegacy(rowsOf({ "model.dev": "inherit" }));

  assert.ok(!desired.has("model.daemon_cycle_worker"), "no value is fabricated");
  assert.ok(!desired.has("budget.worker_max_usd"));
  assert.strictEqual(legacySourced.size, 0);
});

test("migrated DB: the resolution is the row map unchanged", () => {
  const { desired, legacySourced } = resolveDesiredWithLegacy(rowsOf(MIGRATED));

  assert.deepStrictEqual(Object.fromEntries(desired), MIGRATED);
  assert.strictEqual(legacySourced.size, 0);
});

// --- daemon_config_sync ---------------------------------------------------------------

// The daemon-config.json an un-migrated install actually carries: written by pre-rename server
// code, so it holds the old file keys and none of the new ones.
const UN_MIGRATED_FILE = { haiku_model: "claude-haiku-4-5", haiku_max_budget_usd: "0.75" };

test("legacy-sourced values never report 'in sync', even when the file already agrees", () => {
  // The vacuous green this state used to produce: `want === undefined → continue` skipped both
  // renamed domains, every remaining domain matched, and the badge went green over missing rows.
  const resolution = resolveDesiredWithLegacy(rowsOf(UN_MIGRATED));
  const agreeing = {
    worker_model: RETIRED_WORKER_MODEL_REPLACEMENT,
    worker_max_budget_usd: "0.75",
    pre_verify_max_budget_usd: "10.00",
  };

  assert.strictEqual(computeDaemonConfigSync(resolution, agreeing), "pending-migration");
});

test("a pending migration outranks the drift it causes", () => {
  // The real shape: the file carries the pre-rename keys, so both renamed domains would read as
  // drift and send the operator to Save when the un-run rename is the root cause.
  const resolution = resolveDesiredWithLegacy(rowsOf(UN_MIGRATED));

  assert.strictEqual(computeDaemonConfigSync(resolution, UN_MIGRATED_FILE), "pending-migration");
});

test("a missing file still outranks a pending migration", () => {
  // Nothing to compare against, so the more fundamental state is reported first.
  const resolution = resolveDesiredWithLegacy(rowsOf(UN_MIGRATED));

  assert.strictEqual(computeDaemonConfigSync(resolution, null), "file-missing");
});

test("migrated DB: 'ok' and 'drift' are decided exactly as before", () => {
  const resolution = resolveDesiredWithLegacy(rowsOf(MIGRATED));

  assert.strictEqual(
    computeDaemonConfigSync(resolution, {
      worker_model: "claude-sonnet-5",
      worker_max_budget_usd: "0.75",
      pre_verify_max_budget_usd: "10.00",
    }),
    "ok",
  );
  assert.strictEqual(
    computeDaemonConfigSync(resolution, {
      worker_model: "claude-opus-5",
      worker_max_budget_usd: "0.75",
      pre_verify_max_budget_usd: "10.00",
    }),
    "drift",
  );
});

// --- single-siting guard --------------------------------------------------------------

test("the read door reuses the SQL migration's key map — no third copy", () => {
  // Two doors know the old→new pairs: this migration and RENAMED_DAEMON_CONFIG_KEYS. The read path
  // consumes the const rather than restating the pairs, so a future rename edited in one place
  // cannot leave the read behind — assert the two doors still name the same pairs.
  return fs.readFile(MIGRATION_SQL, "utf8").then((sql) => {
    assert.ok(RENAMED_DAEMON_CONFIG_KEYS.length > 0, "the const is the map, and it is populated");
    for (const def of RENAMED_DAEMON_CONFIG_KEYS) {
      assert.ok(sql.includes(`'${def.legacyDomainKey}'`), `${def.legacyDomainKey} in the migration`);
      assert.ok(
        sql.includes(`'${def.currentDomainKey}'`),
        `${def.currentDomainKey} in the migration`,
      );
    }
  });
});
