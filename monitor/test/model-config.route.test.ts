// Integration tests for GET/PUT /api/model-config (spec doc 36166 AC-1..AC-6, AC-9).
//
// Runner: node:test via tsx — npx tsx --test test/model-config.route.test.ts
//
// Test infra:
//   - DB: real Postgres (DATABASE_URL from .env). monitor.model_config rows are
//     snapshotted in before() and restored byte-for-byte in after() (updated_at included).
//   - External surfaces (settings.json / daemon-config.json / agents dir / apply-lock)
//     are tmpdir fixtures injected via the MODEL_CONFIG_* env seams — the live harness
//     files are never touched.
//   - Audit single-writer (AC-9): the real audit-log middleware is registered on the
//     test app; rows are scrubbed by target_table in after().

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerAuditLogHook } from "../src/server/middleware/audit-log.js";
import { registerModelConfigRoutes } from "../src/server/routes/model-config.js";
import type {
  BudgetDomainStatus,
  DomainStatus,
  ModelConfigGetResponse,
  ModelConfigPutResponse,
  SurfaceResult,
} from "../src/server/types/model-config.js";

const ENV_SENTINEL = "sentinel-env-value-must-not-leak";

// Baseline = migration seed values; every test starts from (or restores toward) this state.
const BASELINE: ReadonlyArray<[string, string]> = [
  ["model.orchestrator", "claude-fable-5[1m]"],
  ["model.dev", "inherit"],
  ["model.research", "sonnet"],
  ["model.daemon_cycle_haiku", "claude-haiku-4-5"],
  ["budget.haiku_max_usd", "0.50"],
  ["budget.pre_verify_max_usd", "0.50"],
];

const DAEMON_CONFIG_FIXTURE = {
  _comment: "fixture comment — must survive every render",
  haiku_max_budget_usd: "0.50",
  pre_verify_max_budget_usd: "0.50",
  haiku_model: "claude-haiku-4-5",
  // Deprecated aggregate-limit keys the monitor no longer manages — renderDaemonConfig
  // must strip these so a live file still carrying them self-heals on the next PUT.
  cost_daily_limit_usd: "10.00",
  cost_monthly_limit_usd: "300.00",
};

let app: FastifyInstance;
let fixtureDir: string;
let settingsPath: string;
let daemonConfigPath: string;
let agentsDir: string;
let realAgentsDir: string;
let applyLockPath: string;

interface SavedConfigRow {
  config_key: string;
  config_value: string;
  updated_at: Date;
  updated_by: string;
}
let savedRows: SavedConfigRow[] = [];

function agentMarkdown(name: string, extraFrontmatterLines: string[] = []): string {
  return ["---", `name: ${name}`, ...extraFrontmatterLines, "tools: [Read]", "---", "", `${name} body.`, ""].join("\n");
}

function writeDaemonConfigFixture(): void {
  writeFileSync(daemonConfigPath, `${JSON.stringify(DAEMON_CONFIG_FIXTURE, null, 2)}\n`, "utf8");
}

async function resetDbBaseline(): Promise<void> {
  const prisma = getPrisma();
  for (const [key, value] of BASELINE) {
    await prisma.modelConfig.upsert({
      where: { configKey: key },
      update: { configValue: value, updatedBy: "test-baseline" },
      create: { configKey: key, configValue: value, updatedBy: "test-baseline" },
    });
  }
}

async function getDbValue(key: string): Promise<string | null> {
  const prisma = getPrisma();
  const row = await prisma.modelConfig.findUnique({ where: { configKey: key } });
  return row?.configValue ?? null;
}

function domainOf(body: ModelConfigGetResponse, key: string): DomainStatus {
  const found = body.domains.find((d) => d.domain === key);
  assert.ok(found, `domain ${key} present`);
  return found;
}

function budgetOf(body: ModelConfigGetResponse, key: string): BudgetDomainStatus {
  const found = body.budgets.find((b) => b.domain === key);
  assert.ok(found, `budget ${key} present`);
  return found;
}

function surfaceOf(body: ModelConfigPutResponse, name: SurfaceResult["surface"]): SurfaceResult {
  const found = body.surfaces.find((s) => s.surface === name);
  assert.ok(found, `surface ${name} present`);
  return found;
}

before(async () => {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "model-config-test-"));
  settingsPath = path.join(fixtureDir, "settings.json");
  daemonConfigPath = path.join(fixtureDir, "daemon-config.json");
  agentsDir = path.join(fixtureDir, "agents");
  realAgentsDir = path.join(fixtureDir, "agents-real");
  applyLockPath = path.join(fixtureDir, ".apply-lock");
  mkdirSync(agentsDir);
  mkdirSync(realAgentsDir);

  // settings fixture carries a dummy env key — AC-1 asserts it never reaches a response.
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ model: "claude-fable-5[1m]", effortLevel: "high", env: { SENTINEL_KEY: ENV_SENTINEL } }, null, 2)}\n`,
    "utf8",
  );
  writeDaemonConfigFixture();

  // dev-alpha is reached through a symlink — mirrors the live ~/.claude/agents layout.
  writeFileSync(path.join(realAgentsDir, "dev-alpha.md"), agentMarkdown("dev-alpha"), "utf8");
  symlinkSync(path.join(realAgentsDir, "dev-alpha.md"), path.join(agentsDir, "dev-alpha.md"));
  writeFileSync(path.join(agentsDir, "dev-beta.md"), agentMarkdown("dev-beta"), "utf8");
  writeFileSync(path.join(agentsDir, "dev-broken.md"), "no frontmatter here\njust text\n", "utf8");
  writeFileSync(
    path.join(agentsDir, "intel-researcher.md"),
    agentMarkdown("intel-researcher", ["model: sonnet"]),
    "utf8",
  );

  process.env.MODEL_CONFIG_SETTINGS_PATH = settingsPath;
  process.env.MODEL_CONFIG_DAEMON_CONFIG_PATH = daemonConfigPath;
  process.env.MODEL_CONFIG_AGENTS_DIR = agentsDir;
  process.env.MODEL_CONFIG_APPLY_LOCK_PATH = applyLockPath;

  const prisma = getPrisma();
  savedRows = await prisma.$queryRaw<SavedConfigRow[]>`
    SELECT config_key, config_value, updated_at, updated_by FROM monitor.model_config
  `;
  await resetDbBaseline();

  app = Fastify({ logger: false });
  registerAuditLogHook(app);
  await registerModelConfigRoutes(app);
  await app.ready();
});

after(async () => {
  delete process.env.MODEL_CONFIG_SETTINGS_PATH;
  delete process.env.MODEL_CONFIG_DAEMON_CONFIG_PATH;
  delete process.env.MODEL_CONFIG_AGENTS_DIR;
  delete process.env.MODEL_CONFIG_APPLY_LOCK_PATH;
  try {
    await app.close();
  } catch {
    // best-effort
  }
  try {
    const prisma = getPrisma();
    // Restore the pre-suite rows byte-for-byte (updated_at included — raw SQL bypasses @updatedAt).
    await prisma.$executeRaw`DELETE FROM monitor.model_config`;
    for (const row of savedRows) {
      await prisma.$executeRaw`
        INSERT INTO monitor.model_config (config_key, config_value, updated_at, updated_by)
        VALUES (${row.config_key}, ${row.config_value}, ${row.updated_at}, ${row.updated_by})
      `;
    }
    await prisma.$executeRaw`
      DELETE FROM monitor.audit_log
      WHERE target_table = 'model-config'
        AND event_ts >= NOW() - INTERVAL '30 minutes'
    `;
  } catch (error) {
    console.error("[model-config-test cleanup] DB restore failed:", error);
  }
  rmSync(fixtureDir, { recursive: true, force: true });
  await disconnectPrisma();
});

// ----- GET -----------------------------------------------------------------------

test("GET: 200 + full matrix shape, drift-free on baseline", async () => {
  const res = await app.inject({ method: "GET", url: "/api/model-config" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as ModelConfigGetResponse;

  assert.strictEqual(body.domains.length, 4);
  assert.strictEqual(typeof body.fetched_at, "string");

  const orchestrator = domainOf(body, "model.orchestrator");
  assert.strictEqual(orchestrator.editable, false);
  assert.strictEqual(orchestrator.apply_mode, "session-restart-manual");
  assert.strictEqual(orchestrator.actual, "claude-fable-5[1m]");
  assert.strictEqual(orchestrator.drift, false);
  assert.strictEqual(orchestrator.effort_level, "high");
  assert.strictEqual(orchestrator.pricing_known, true);

  const dev = domainOf(body, "model.dev");
  assert.strictEqual(dev.apply_mode, "next-spawn");
  assert.strictEqual(dev.actual, "inherit");
  assert.strictEqual(dev.drift, false);
  assert.deepStrictEqual(
    dev.files?.map((f) => f.file),
    ["dev-alpha.md", "dev-beta.md", "dev-broken.md"],
  );

  const research = domainOf(body, "model.research");
  assert.strictEqual(research.actual, "sonnet");
  assert.strictEqual(research.drift, false);

  const haiku = domainOf(body, "model.daemon_cycle_haiku");
  assert.strictEqual(haiku.apply_mode, "next-cycle");
  assert.strictEqual(haiku.actual, "claude-haiku-4-5");
  assert.strictEqual(haiku.drift, false);

  // Per-call hard-cap budgets mirror the daemon-config.json fixture (no drift on baseline).
  assert.strictEqual(body.budgets.length, 2);
  const haikuBudget = budgetOf(body, "budget.haiku_max_usd");
  assert.strictEqual(haikuBudget.desired, "0.50");
  assert.strictEqual(haikuBudget.actual, "0.50");
  assert.strictEqual(haikuBudget.drift, false);
  assert.strictEqual(haikuBudget.apply_mode, "next-cycle");
  const preVerifyBudget = budgetOf(body, "budget.pre_verify_max_usd");
  assert.strictEqual(preVerifyBudget.desired, "0.50");
  assert.strictEqual(preVerifyBudget.actual, "0.50");
  assert.strictEqual(preVerifyBudget.drift, false);

  assert.strictEqual(body.daemon_config_sync, "ok");
});

test("AC-1: settings.json env block never serialized into the response", async () => {
  const res = await app.inject({ method: "GET", url: "/api/model-config" });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(!res.payload.includes(ENV_SENTINEL), "env value must not leak");
  assert.ok(!res.payload.includes("SENTINEL_KEY"), "env key must not leak");
  assert.ok(!res.payload.includes('"env"'), "env block must not leak");
});

test("D5: drift compare is variant-suffix-normalized ('claude-fable-5' == 'claude-fable-5[1m]')", async () => {
  const prisma = getPrisma();
  await prisma.modelConfig.update({
    where: { configKey: "model.orchestrator" },
    data: { configValue: "claude-fable-5" },
  });
  const res = await app.inject({ method: "GET", url: "/api/model-config" });
  const body = res.json() as ModelConfigGetResponse;
  assert.strictEqual(domainOf(body, "model.orchestrator").drift, false);
  await prisma.modelConfig.update({
    where: { configKey: "model.orchestrator" },
    data: { configValue: "claude-fable-5[1m]" },
  });
});

// ----- PUT validation (AC-2 / AC-3) -------------------------------------------------

test("AC-2: invalid model value → 400 field-level error + zero writes", async () => {
  const daemonConfigBefore = readFileSync(daemonConfigPath, "utf8");
  const betaBefore = readFileSync(path.join(agentsDir, "dev-beta.md"), "utf8");

  const res = await app.inject({
    method: "PUT",
    url: "/api/model-config",
    payload: { models: { "model.dev": "Claude-Opus" } },
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { error: string; field: string };
  assert.strictEqual(body.error, "invalid_body");
  assert.strictEqual(body.field, "models.model.dev");

  assert.strictEqual(await getDbValue("model.dev"), "inherit", "DB row unchanged");
  assert.strictEqual(readFileSync(daemonConfigPath, "utf8"), daemonConfigBefore, "daemon-config untouched");
  assert.strictEqual(readFileSync(path.join(agentsDir, "dev-beta.md"), "utf8"), betaBefore, "frontmatter untouched");
});

test("aliases are frontmatter-only: alias on a daemon domain → 400", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/api/model-config",
    payload: { models: { "model.daemon_cycle_haiku": "sonnet" } },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual((res.json() as { field: string }).field, "models.model.daemon_cycle_haiku");
});

test("unknown domain key → 400", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/api/model-config",
    payload: { models: { "model.bogus": "claude-haiku-4-5" } },
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual((res.json() as { field: string }).field, "models.model.bogus");
});

test("AC-3: per-call budget format → 400 atomic (no cross-field invariant)", async () => {
  // Each cap validates INDEPENDENTLY — no daily≤monthly pair semantics for single-call caps.
  for (const [value, label] of [
    ["0.5", "1 decimal place"],
    ["0.500", "3 decimal places"],
    ["0.04", "below min floor (0.05)"],
    ["50.01", "above max ceiling (50.00)"],
    ["99999999999999999999.00", "over integer-digit cap (1e20)"],
    ["1000000.00", "7 integer digits"],
  ] as const) {
    const res = await app.inject({
      method: "PUT",
      url: "/api/model-config",
      payload: { budgets: { "budget.haiku_max_usd": value } },
    });
    assert.strictEqual(res.statusCode, 400, `budget.haiku_max_usd=${value} (${label}) must 400`);
    assert.strictEqual((res.json() as { field: string }).field, "budgets.budget.haiku_max_usd");
  }
  assert.strictEqual(await getDbValue("budget.haiku_max_usd"), "0.50", "DB unchanged after rejects");
});

// ----- PUT render: daemon-config.json (AC-4) ----------------------------------------

test("AC-4: daemon-key change rewrites daemon-config.json — unknown keys + budget string survive", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/api/model-config",
    payload: {
      models: { "model.daemon_cycle_haiku": "claude-sonnet-4-6" },
      budgets: { "budget.haiku_max_usd": "1.50" },
    },
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as ModelConfigPutResponse;
  assert.strictEqual(surfaceOf(body, "daemon-config.json").status, "ok");
  assert.strictEqual(body.daemon_config_sync, "ok");
  assert.strictEqual(domainOf(body, "model.daemon_cycle_haiku").actual, "claude-sonnet-4-6");
  assert.strictEqual(budgetOf(body, "budget.haiku_max_usd").actual, "1.50");

  const raw = readFileSync(daemonConfigPath, "utf8");
  const rendered = JSON.parse(raw) as Record<string, unknown>;
  assert.strictEqual(rendered.haiku_model, "claude-sonnet-4-6");
  // The per-call cap renders verbatim under the real key daemon_config.py reads.
  assert.strictEqual(rendered.haiku_max_budget_usd, "1.50");
  assert.strictEqual(rendered.pre_verify_max_budget_usd, "0.50", "untouched budget key preserved");
  assert.strictEqual(rendered._comment, DAEMON_CONFIG_FIXTURE._comment, "_comment preserved");
  // Deprecated aggregate-limit keys the monitor dropped are stripped on render → live file self-heals.
  assert.ok(!("cost_daily_limit_usd" in rendered), "deprecated cost_daily_limit_usd stripped");
  assert.ok(!("cost_monthly_limit_usd" in rendered), "deprecated cost_monthly_limit_usd stripped");
  // Trailing-zero STRING survives — a JSON number 1.5 would break the --max-budget-usd cap.
  assert.ok(raw.includes('"haiku_max_budget_usd": "1.50"'), "'1.50' trailing zero byte-exact");
  // Removed domains no longer write into daemon-config.json.
  assert.ok(!("autoagent_repl_model" in rendered), "removed domain key absent from render");
  assert.ok(!("wiki_repl_model" in rendered), "removed domain key absent from render");
});

// ----- PUT render: agent frontmatter (AC-5) -----------------------------------------

test("AC-5: dev pin upserts only the model line, resolves symlinks, surfaces unparseable", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/api/model-config",
    payload: { models: { "model.dev": "claude-opus-4-8" } },
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as ModelConfigPutResponse;

  const surface = surfaceOf(body, "frontmatter-dev");
  assert.strictEqual(surface.status, "skipped", "aggregate surfaces the unparseable skip");
  const byFile = new Map(surface.files?.map((f) => [f.file, f]) ?? []);
  assert.strictEqual(byFile.get("dev-alpha.md")?.status, "ok");
  assert.strictEqual(byFile.get("dev-beta.md")?.status, "ok");
  assert.strictEqual(byFile.get("dev-broken.md")?.status, "skipped");

  // Symlink hazard (D4): the agents-dir entry stays a symlink; the RESOLVED file got the line.
  assert.ok(lstatSync(path.join(agentsDir, "dev-alpha.md")).isSymbolicLink(), "symlink preserved");
  const alphaReal = readFileSync(path.join(realAgentsDir, "dev-alpha.md"), "utf8");
  assert.ok(alphaReal.includes("\nmodel: claude-opus-4-8\n"), "resolved target updated");
  assert.ok(readFileSync(path.join(agentsDir, "dev-beta.md"), "utf8").includes("\nmodel: claude-opus-4-8\n"));
  assert.strictEqual(
    readFileSync(path.join(agentsDir, "dev-broken.md"), "utf8"),
    "no frontmatter here\njust text\n",
    "unparseable file untouched",
  );
  assert.ok(
    readFileSync(path.join(agentsDir, "intel-researcher.md"), "utf8").includes("\nmodel: sonnet\n"),
    "research file untouched by a dev pin",
  );

  // Pinned + unparseable mix is honestly 'mixed' (broken file cannot carry the pin).
  const dev = domainOf(body, "model.dev");
  assert.strictEqual(dev.actual, "mixed");
  assert.strictEqual(dev.drift, true);

  // 'inherit' removes the model line everywhere.
  const res2 = await app.inject({
    method: "PUT",
    url: "/api/model-config",
    payload: { models: { "model.dev": "inherit" } },
  });
  assert.strictEqual(res2.statusCode, 200);
  const body2 = res2.json() as ModelConfigPutResponse;
  assert.strictEqual(domainOf(body2, "model.dev").actual, "inherit");
  assert.ok(!readFileSync(path.join(realAgentsDir, "dev-alpha.md"), "utf8").includes("model:"));
  assert.ok(!readFileSync(path.join(agentsDir, "dev-beta.md"), "utf8").includes("model:"));
});

// ----- orchestrator read-only (AC-6) -------------------------------------------------

test("AC-6: orchestrator PUT is DB-only — settings.json untouched", async () => {
  const settingsBefore = readFileSync(settingsPath, "utf8");
  const res = await app.inject({
    method: "PUT",
    url: "/api/model-config",
    payload: { models: { "model.orchestrator": "claude-opus-4-8" } },
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as ModelConfigPutResponse;

  assert.strictEqual(await getDbValue("model.orchestrator"), "claude-opus-4-8");
  assert.strictEqual(readFileSync(settingsPath, "utf8"), settingsBefore, "settings.json byte-identical");
  const surface = surfaceOf(body, "settings.json");
  assert.strictEqual(surface.status, "skipped");
  const orchestrator = domainOf(body, "model.orchestrator");
  assert.strictEqual(orchestrator.apply_mode, "session-restart-manual");
  assert.strictEqual(orchestrator.drift, true, "desired opus vs actual fable → drift");

  await getPrisma().modelConfig.update({
    where: { configKey: "model.orchestrator" },
    data: { configValue: "claude-fable-5[1m]" },
  });
});

// ----- daemon-apply concurrency guard ------------------------------------------------

test("409 while .apply-lock exists — frontmatter writes only; budget-only PUT passes", async () => {
  mkdirSync(applyLockPath, { recursive: true });
  try {
    const betaBefore = readFileSync(path.join(agentsDir, "dev-beta.md"), "utf8");
    const res = await app.inject({
      method: "PUT",
      url: "/api/model-config",
      payload: { models: { "model.dev": "haiku" } },
    });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual((res.json() as { error: string }).error, "daemon_apply_in_progress");
    assert.strictEqual(await getDbValue("model.dev"), "inherit", "DB unchanged on 409");
    assert.strictEqual(readFileSync(path.join(agentsDir, "dev-beta.md"), "utf8"), betaBefore);

    // The guard protects only the agents/ stash window — daemon-config (budget) updates pass.
    const res2 = await app.inject({
      method: "PUT",
      url: "/api/model-config",
      payload: { budgets: { "budget.haiku_max_usd": "0.75" } },
    });
    assert.strictEqual(res2.statusCode, 200);
  } finally {
    rmSync(applyLockPath, { recursive: true, force: true });
  }
});

// ----- audit single-writer (AC-9) ----------------------------------------------------

test("AC-9: successful PUT → exactly 1 audit row (middleware-written) with old→new payload", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/api/model-config",
    payload: { models: { "model.research": "haiku" } },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(
    readFileSync(path.join(agentsDir, "intel-researcher.md"), "utf8").includes("\nmodel: haiku\n"),
    "research frontmatter line replaced",
  );

  // Fire-and-forget INSERT — poll for the row carrying THIS PUT's diff key (immune to
  // late-landing rows from earlier tests). Exactly 1 matching row = single-writer proof:
  // a second writer (the abandoned in-handler INSERT path) would produce 2 rows.
  const prisma = getPrisma();
  type AuditRow = {
    action_kind: string;
    payload: { change?: { changes?: Record<string, { old: string | null; new: string }> } };
  };
  let rows: AuditRow[] = [];
  for (let attempt = 0; attempt < 20 && rows.length === 0; attempt += 1) {
    rows = await prisma.$queryRaw<AuditRow[]>`
      SELECT action_kind, payload
      FROM monitor.audit_log
      WHERE target_table = 'model-config'
        AND payload->'change'->'changes' ? 'model.research'
        AND event_ts >= NOW() - INTERVAL '2 minutes'
    `;
    if (rows.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.strictEqual(rows.length, 1, "exactly 1 audit row for this PUT");
  assert.strictEqual(rows[0].action_kind, "model-config.update");
  assert.deepStrictEqual(rows[0].payload.change?.changes?.["model.research"], {
    old: "sonnet",
    new: "haiku",
  });

  const res2 = await app.inject({
    method: "PUT",
    url: "/api/model-config",
    payload: { models: { "model.research": "sonnet" } },
  });
  assert.strictEqual(res2.statusCode, 200);
});

// ----- daemon_config_sync states ------------------------------------------------------

test("daemon_config_sync: rendered-view mismatch → 'drift', missing file → 'file-missing'", async () => {
  writeFileSync(
    daemonConfigPath,
    `${JSON.stringify({ ...DAEMON_CONFIG_FIXTURE, haiku_model: "claude-haiku-4-5" }, null, 2)}\n`,
    "utf8",
  );
  // DB still says claude-sonnet-4-6 (set in the AC-4 test) → rendered view out of sync.
  const res = await app.inject({ method: "GET", url: "/api/model-config" });
  assert.strictEqual((res.json() as ModelConfigGetResponse).daemon_config_sync, "drift");

  rmSync(daemonConfigPath);
  const res2 = await app.inject({ method: "GET", url: "/api/model-config" });
  assert.strictEqual((res2.json() as ModelConfigGetResponse).daemon_config_sync, "file-missing");

  // Re-save heals: a PUT touching a daemon key re-renders the full desired state.
  const res3 = await app.inject({
    method: "PUT",
    url: "/api/model-config",
    payload: { models: { "model.daemon_cycle_haiku": "claude-haiku-4-5" } },
  });
  assert.strictEqual(res3.statusCode, 200);
  assert.strictEqual((res3.json() as ModelConfigPutResponse).daemon_config_sync, "ok");
});
