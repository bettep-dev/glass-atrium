// Unit tests for renderDaemonConfig's legacy-key handling in routes/model-config.ts.
//
// WHY a second unit file rather than cases in model-config.route.test.ts: that suite needs a live
// Postgres, and its BASELINE fixture seeds the POST-rename keys (model.daemon_cycle_worker /
// budget.worker_max_usd) directly — so it cannot express an UN-MIGRATED DB, which is the state
// every existing install is in after `scripts/update.sh` ships new server code without running
// `prisma migrate deploy`. renderDaemonConfig takes its desired state as a plain Map and its target
// path from an env seam, so the state is reachable with no DB at all.
//
// Runner: npx tsx --test test/model-config.render.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderDaemonConfig } from "../src/server/routes/model-config.js";
import { isRetiredWorkerModelId } from "../src/server/model-config-consts.js";

const MIGRATION_SQL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prisma",
  "migrations",
  "20260901000000_rename_haiku_model_config_keys_to_worker",
  "migration.sql",
);

/**
 * Render `desired` over a throwaway daemon-config.json seeded with `file`, and hand back the parsed
 * result plus everything the renderer wrote to stderr. Restores the env seam and stderr on the way
 * out so a failing assertion cannot leak either into a sibling test.
 */
async function render(
  file: Record<string, unknown>,
  desired: Record<string, string>,
): Promise<{ config: Record<string, unknown>; stderr: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-render-"));
  const target = path.join(dir, "daemon-config.json");
  const savedPath = process.env.MODEL_CONFIG_DAEMON_CONFIG_PATH;
  const savedWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  try {
    await fs.writeFile(target, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    process.env.MODEL_CONFIG_DAEMON_CONFIG_PATH = target;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;

    const result = await renderDaemonConfig(new Map(Object.entries(desired)));
    assert.strictEqual(result.status, "ok", `render failed: ${JSON.stringify(result)}`);
    return { config: JSON.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>, stderr };
  } finally {
    process.stderr.write = savedWrite;
    if (savedPath === undefined) {
      delete process.env.MODEL_CONFIG_DAEMON_CONFIG_PATH;
    } else {
      process.env.MODEL_CONFIG_DAEMON_CONFIG_PATH = savedPath;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("un-migrated DB + models-only PUT: the operator's tuned per-call cap survives", async () => {
  // The exact reported sequence. The DB still holds the pre-rename rows; the operator changed only
  // the daemon model in the UI, so the PUT carries model.daemon_cycle_worker and no budget at all.
  // Before the carry-forward, the deprecation delete removed haiku_max_budget_usd while nothing
  // wrote worker_max_budget_usd, and the next cycle silently ran at the in-code 10.00 literal.
  const { config } = await render(
    { haiku_model: "claude-sonnet-5", haiku_max_budget_usd: "0.75" },
    {
      "model.daemon_cycle_worker": "claude-opus-5",
      "model.daemon_cycle_haiku": "claude-sonnet-5",
      "budget.haiku_max_usd": "0.75",
    },
  );

  assert.strictEqual(config.worker_max_budget_usd, "0.75", "the tuned cap must survive the Save");
  assert.strictEqual(config.worker_model, "claude-opus-5");
  assert.ok(!("haiku_max_budget_usd" in config), "legacy budget key dropped once carried");
  assert.ok(!("haiku_model" in config), "legacy model key dropped");
});

test("un-migrated DB + budgets-only PUT: the operator's pinned worker model survives", async () => {
  // The mirror of the reported case: the cap is supplied by the PUT, the model is not, and the
  // model is what would otherwise be deleted and silently replaced by the _FALLBACK literal.
  const { config } = await render(
    { haiku_model: "claude-opus-5", haiku_max_budget_usd: "0.75" },
    {
      "budget.worker_max_usd": "2.50",
      "model.daemon_cycle_haiku": "claude-opus-5",
      "budget.haiku_max_usd": "0.75",
    },
  );

  assert.strictEqual(config.worker_model, "claude-opus-5", "the pinned model must survive the Save");
  assert.strictEqual(config.worker_max_budget_usd, "2.50", "the PUT's cap wins over the legacy row");
  assert.ok(!("haiku_model" in config));
  assert.ok(!("haiku_max_budget_usd" in config));
});

test("a retired-family id is rewritten on carry, never moved verbatim", async () => {
  // Same VALUE POLICY the SQL migration states: carrying a haiku id forward would rename the key
  // and leave the loop on the retired model. Covers the API-style shape a prefix test misses, and
  // the bare alias (rewritten before validation, so REJECTED_ALIAS_VALUES never sees it).
  for (const retired of ["claude-3-5-haiku-20241022", "claude-3-5-haiku-latest", "claude-haiku-4-5", "haiku"]) {
    const { config } = await render({ haiku_model: retired }, {});
    assert.strictEqual(config.worker_model, "claude-sonnet-5", `${retired} must be rewritten`);
  }
  const { config } = await render({ haiku_model: "claude-opus-5" }, {});
  assert.strictEqual(config.worker_model, "claude-opus-5", "a non-retired id moves verbatim");
});

test("migrated DB: nothing is carried and the legacy keys still go", async () => {
  const { config, stderr } = await render(
    { haiku_model: "claude-opus-5", haiku_max_budget_usd: "0.75" },
    { "model.daemon_cycle_worker": "claude-sonnet-5", "budget.worker_max_usd": "10.00" },
  );

  assert.strictEqual(config.worker_model, "claude-sonnet-5", "the post-rename row wins outright");
  assert.strictEqual(config.worker_max_budget_usd, "10.00");
  assert.ok(!("haiku_model" in config));
  assert.ok(!("haiku_max_budget_usd" in config));
  assert.ok(!stderr.includes("carried"), "a migrated DB must not report a carry");
});

test("hand-pruned DB: the value is carried from the file when no legacy row exists", async () => {
  const { config } = await render(
    { haiku_model: "claude-opus-5", haiku_max_budget_usd: "0.75" },
    {},
  );

  assert.strictEqual(config.worker_model, "claude-opus-5");
  assert.strictEqual(config.worker_max_budget_usd, "0.75");
});

test("a legacy row outranks a drifted file value", async () => {
  // monitor.model_config is the UI SoT, so a pre-rename row beats a file that drifted from it.
  const { config } = await render(
    { haiku_max_budget_usd: "0.75" },
    { "budget.haiku_max_usd": "3.25" },
  );

  assert.strictEqual(config.worker_max_budget_usd, "3.25");
});

test("a post-rename row set to 'inherit' is not undone by the carry", async () => {
  // 'inherit' on this domain means the operator asked for the key to be ABSENT, and the model loop
  // deletes it. Carrying the legacy value in afterwards would resurrect exactly what they removed,
  // so the carry keys on the ROW EXISTING, not on the rendered value being present.
  const { config } = await render(
    { haiku_model: "claude-opus-5" },
    { "model.daemon_cycle_worker": "inherit" },
  );

  assert.ok(!("worker_model" in config), "the removal stands");
  assert.ok(!("haiku_model" in config), "and the legacy key is still dropped");
});

test("an unusable legacy value is kept and reported, neither carried nor destroyed", async () => {
  const { config, stderr } = await render({ haiku_max_budget_usd: "not-a-number" }, {});

  assert.strictEqual(config.haiku_max_budget_usd, "not-a-number", "evidence is not destroyed");
  assert.ok(!("worker_max_budget_usd" in config), "an invalid value is not laundered forward");
  assert.match(stderr, /haiku_max_budget_usd' KEPT/, "the unmet precondition is named, not absorbed");
});

test("dropped keys go unconditionally; unknown keys survive the merge", async () => {
  const { config } = await render(
    { cost_daily_limit_usd: "5.00", cost_monthly_limit_usd: "50.00", _comment: "keep me" },
    { "budget.worker_max_usd": "1.00" },
  );

  assert.ok(!("cost_daily_limit_usd" in config), "a dropped key has no successor to wait for");
  assert.ok(!("cost_monthly_limit_usd" in config));
  assert.strictEqual(config._comment, "keep me");
});

test("the SQL migration and isRetiredWorkerModelId agree on the retired-id set", async () => {
  // The two rename doors — the SQL migration and the daemon-config.json carry-forward — must apply
  // one policy. A prefix-shaped SQL predicate silently renames an API-style haiku id and leaves the
  // loop on the retired model, which is the outcome the migration exists to prevent.
  const sql = await fs.readFile(MIGRATION_SQL, "utf8");
  const executable = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  assert.match(executable, /LIKE '%haiku%'/, "the SQL predicate must be a substring match");
  assert.doesNotMatch(executable, /LIKE 'claude-haiku%'/, "the prefix predicate must be gone");

  for (const retired of ["claude-3-5-haiku-20241022", "claude-3-5-haiku-latest", "claude-haiku-4-5", "haiku"]) {
    assert.ok(isRetiredWorkerModelId(retired), `${retired} is retired on both doors`);
  }
  for (const kept of ["claude-sonnet-5", "claude-opus-5", "claude-fable-5[1m]"]) {
    assert.ok(!isRetiredWorkerModelId(kept), `${kept} must not be rewritten`);
  }
});
