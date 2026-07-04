// Integration tests for GET/PUT /api/model-config (spec doc 36166 AC-1..AC-6, AC-9).
//
// Runner: node:test via tsx — npx tsx --test test/model-config.route.test.ts
//
// Test infra:
//   - DB: real Postgres (DATABASE_URL from .env). monitor.model_config rows are
//     snapshotted in before() and restored byte-for-byte in after() (updated_at included).
//   - External surfaces (daemon-config.json / agents dir / apply-lock)
//     are tmpdir fixtures injected via the MODEL_CONFIG_* env seams — the live harness
//     files are never touched. The pricing SoT roster is a tmpdir fixture too
//     (PRICING_SOT_PATH seam; the roster is read per request, no server-side cache).
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
import { resetAgentRegistryCache } from "../src/server/agents/registry.js";
import { registerAuditLogHook } from "../src/server/middleware/audit-log.js";
import { registerModelConfigRoutes } from "../src/server/routes/model-config.js";
import type {
  BudgetDomainStatus,
  DomainStatus,
  ModelConfigGetResponse,
  ModelConfigPutResponse,
  SurfaceResult,
} from "../src/server/types/model-config.js";

// Suite baseline — every test starts from (or restores toward) this state. Mirrors the
// migration seed's shipped defaults exactly: model.research seeds the concrete id
// 'claude-sonnet-5' (the legacy 'sonnet' alias is rejected on current code, D2), so no
// per-key workaround is needed here; the legacy-alias display path keeps its own scoped
// fixture in the tolerance test below.
const BASELINE: ReadonlyArray<[string, string]> = [
  ["model.dev", "inherit"],
  ["model.research", "claude-sonnet-5"],
  ["model.daemon_cycle_haiku", "claude-haiku-4-5"],
  ["budget.haiku_max_usd", "10.00"],
  ["budget.pre_verify_max_usd", "10.00"],
];

const DAEMON_CONFIG_FIXTURE = {
  _comment: "fixture comment — must survive every render",
  haiku_max_budget_usd: "10.00",
  pre_verify_max_budget_usd: "10.00",
  haiku_model: "claude-haiku-4-5",
  // Deprecated aggregate-limit keys the monitor no longer manages — renderDaemonConfig
  // must strip these so a live file still carrying them self-heals on the next PUT.
  cost_daily_limit_usd: "10.00",
  cost_monthly_limit_usd: "300.00",
};

// pricing SoT fixture (PRICING_SOT_PATH seam) — known_models must derive from THIS
// file's `models` key set, never a hardcoded server mirror (deleted in the SoT rework).
const PRICING_SOT_FIXTURE = {
  schema_version: 1,
  models: {
    "claude-fable-5": { input: 10.0, output: 50.0, cache_read: 1.0, cache_creation: 12.5 },
    "claude-opus-4-8": { input: 5.0, output: 25.0, cache_read: 0.5, cache_creation: 6.25 },
    "claude-sonnet-5": { input: 3.0, output: 15.0, cache_read: 0.3, cache_creation: 3.75 },
    "claude-sonnet-4-6": { input: 3.0, output: 15.0, cache_read: 0.3, cache_creation: 3.75 },
    "claude-haiku-4-5": { input: 1.0, output: 5.0, cache_read: 0.1, cache_creation: 1.25 },
  },
};

let app: FastifyInstance;
let fixtureDir: string;
let daemonConfigPath: string;
let agentsDir: string;
let realAgentsDir: string;
let applyLockPath: string;
let registryPath: string;
let pricingSotPath: string;

// Registry fixture — the on-disk dev agents that ARE registered. glass-atrium-dev-ghost.md is
// deliberately omitted so the T12 intersection excludes it (de-registered/archived).
const REGISTRY_FIXTURE = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    "glass-atrium-dev-alpha": { domains: ["test"], phase: "implementation", dual_phase: false },
    "glass-atrium-dev-beta": { domains: ["test"], phase: "implementation", dual_phase: false },
    "glass-atrium-dev-broken": { domains: ["test"], phase: "implementation", dual_phase: false },
  },
};

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
  daemonConfigPath = path.join(fixtureDir, "daemon-config.json");
  agentsDir = path.join(fixtureDir, "agents");
  realAgentsDir = path.join(fixtureDir, "agents-real");
  applyLockPath = path.join(fixtureDir, ".apply-lock");
  registryPath = path.join(fixtureDir, "agent-registry.json");
  pricingSotPath = path.join(fixtureDir, "pricing.json");
  mkdirSync(agentsDir);
  mkdirSync(realAgentsDir);

  // SoT roster seam: the fixture pricing.json feeds known_models + pricing_known.
  writeFileSync(pricingSotPath, `${JSON.stringify(PRICING_SOT_FIXTURE, null, 2)}\n`, "utf8");
  process.env.PRICING_SOT_PATH = pricingSotPath;

  writeDaemonConfigFixture();

  // glass-atrium-dev-alpha is reached through a symlink — mirrors the live ~/.claude/agents layout.
  writeFileSync(path.join(realAgentsDir, "glass-atrium-dev-alpha.md"), agentMarkdown("glass-atrium-dev-alpha"), "utf8");
  symlinkSync(path.join(realAgentsDir, "glass-atrium-dev-alpha.md"), path.join(agentsDir, "glass-atrium-dev-alpha.md"));
  writeFileSync(path.join(agentsDir, "glass-atrium-dev-beta.md"), agentMarkdown("glass-atrium-dev-beta"), "utf8");
  writeFileSync(path.join(agentsDir, "glass-atrium-dev-broken.md"), "no frontmatter here\njust text\n", "utf8");
  // glass-atrium-dev-ghost.md is present on disk but absent from the registry fixture — T12 must exclude it.
  writeFileSync(path.join(agentsDir, "glass-atrium-dev-ghost.md"), agentMarkdown("glass-atrium-dev-ghost"), "utf8");
  writeFileSync(
    path.join(agentsDir, "glass-atrium-intel-researcher.md"),
    agentMarkdown("glass-atrium-intel-researcher", ["model: claude-sonnet-5"]),
    "utf8",
  );

  // T12: registry fixture co-located with the agents dir (loadAgentRegistry derives the
  // .md dir from dirname(AGENT_REGISTRY_PATH)/agents). Only glass-atrium-dev-alpha/beta/broken are
  // registered → the on-disk glass-atrium-dev-ghost.md is filtered out of every dev-file surface.
  writeFileSync(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

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
  delete process.env.MODEL_CONFIG_DAEMON_CONFIG_PATH;
  delete process.env.MODEL_CONFIG_AGENTS_DIR;
  delete process.env.MODEL_CONFIG_APPLY_LOCK_PATH;
  delete process.env.AGENT_REGISTRY_PATH;
  delete process.env.PRICING_SOT_PATH;
  resetAgentRegistryCache();
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

  assert.strictEqual(body.domains.length, 3);
  assert.strictEqual(typeof body.fetched_at, "string");

  // known_models = the SoT fixture's `models` key set (order-agnostic set equality).
  assert.ok(Array.isArray(body.known_models), "known_models present");
  assert.deepStrictEqual(
    [...body.known_models].sort(),
    Object.keys(PRICING_SOT_FIXTURE.models).sort(),
    "known_models derives from the pricing SoT",
  );

  const dev = domainOf(body, "model.dev");
  assert.strictEqual(dev.apply_mode, "next-spawn");
  assert.strictEqual(dev.actual, "inherit");
  assert.strictEqual(dev.drift, false);
  assert.deepStrictEqual(
    dev.files?.map((f) => f.file),
    ["glass-atrium-dev-alpha.md", "glass-atrium-dev-beta.md", "glass-atrium-dev-broken.md"],
  );

  const research = domainOf(body, "model.research");
  assert.strictEqual(research.actual, "claude-sonnet-5");
  assert.strictEqual(research.drift, false);

  const haiku = domainOf(body, "model.daemon_cycle_haiku");
  assert.strictEqual(haiku.apply_mode, "next-cycle");
  assert.strictEqual(haiku.actual, "claude-haiku-4-5");
  assert.strictEqual(haiku.drift, false);

  // Per-call hard-cap budgets mirror the daemon-config.json fixture (no drift on baseline).
  assert.strictEqual(body.budgets.length, 2);
  const haikuBudget = budgetOf(body, "budget.haiku_max_usd");
  assert.strictEqual(haikuBudget.desired, "10.00");
  assert.strictEqual(haikuBudget.actual, "10.00");
  assert.strictEqual(haikuBudget.drift, false);
  assert.strictEqual(haikuBudget.apply_mode, "next-cycle");
  const preVerifyBudget = budgetOf(body, "budget.pre_verify_max_usd");
  assert.strictEqual(preVerifyBudget.desired, "10.00");
  assert.strictEqual(preVerifyBudget.actual, "10.00");
  assert.strictEqual(preVerifyBudget.drift, false);

  assert.strictEqual(body.daemon_config_sync, "ok");
});

test("T12: de-registered on-disk dev-*.md (glass-atrium-dev-ghost) excluded from the model table", async () => {
  const res = await app.inject({ method: "GET", url: "/api/model-config" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as ModelConfigGetResponse;

  const dev = domainOf(body, "model.dev");
  const files = dev.files?.map((f) => f.file) ?? [];
  // glass-atrium-dev-ghost.md exists on disk but is absent from the registry → intersection drops it.
  assert.ok(!files.includes("glass-atrium-dev-ghost.md"), "unregistered glass-atrium-dev-ghost.md must be excluded");
  // The registered dev agents survive the intersection (registry-scoped, not blanked).
  assert.deepStrictEqual(files, ["glass-atrium-dev-alpha.md", "glass-atrium-dev-beta.md", "glass-atrium-dev-broken.md"]);
});

test("D5: drift compare is variant-suffix-normalized ('claude-sonnet-5[1m]' == 'claude-sonnet-5')", async () => {
  // Anchored on the research frontmatter surface: the fixture pins 'claude-sonnet-5',
  // so a bracket-variant desired must compare equal after normalization.
  const prisma = getPrisma();
  await prisma.modelConfig.update({
    where: { configKey: "model.research" },
    data: { configValue: "claude-sonnet-5[1m]" },
  });
  try {
    const res = await app.inject({ method: "GET", url: "/api/model-config" });
    const body = res.json() as ModelConfigGetResponse;
    assert.strictEqual(domainOf(body, "model.research").drift, false);
  } finally {
    await prisma.modelConfig.update({
      where: { configKey: "model.research" },
      data: { configValue: "claude-sonnet-5" },
    });
  }
});

test("GET tolerates a legacy alias on DB/frontmatter surfaces — display only, never validated", async () => {
  // Scoped fixture: an alias PUT 400s (D2), so the legacy state a live install may still
  // carry is installed out-of-band (direct prisma + frontmatter rewrite) and restored in
  // finally — GET must render it verbatim, not 500/blank it.
  const prisma = getPrisma();
  const researchFile = path.join(agentsDir, "glass-atrium-intel-researcher.md");
  await prisma.modelConfig.update({
    where: { configKey: "model.research" },
    data: { configValue: "sonnet" },
  });
  writeFileSync(researchFile, agentMarkdown("glass-atrium-intel-researcher", ["model: sonnet"]), "utf8");
  try {
    const res = await app.inject({ method: "GET", url: "/api/model-config" });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json() as ModelConfigGetResponse;
    const research = domainOf(body, "model.research");
    assert.strictEqual(research.desired, "sonnet");
    assert.strictEqual(research.actual, "sonnet");
    assert.strictEqual(research.drift, false);
    // Alias resolution branch removed — a bare alias is no longer pricing-known.
    assert.strictEqual(research.pricing_known, false);
  } finally {
    await prisma.modelConfig.update({
      where: { configKey: "model.research" },
      data: { configValue: "claude-sonnet-5" },
    });
    writeFileSync(researchFile, agentMarkdown("glass-atrium-intel-researcher", ["model: claude-sonnet-5"]), "utf8");
  }
});

test("D3 fail-open: missing pricing SoT → GET 200 with known_models [] — next GET recovers", async () => {
  // The roster is read per request — pointing the seam at a nonexistent file breaks
  // the very next GET, and restoring it heals the one after (no cache to reset).
  process.env.PRICING_SOT_PATH = path.join(fixtureDir, "missing-pricing.json");
  try {
    const res = await app.inject({ method: "GET", url: "/api/model-config" });
    assert.strictEqual(res.statusCode, 200, "unreadable SoT must degrade, never 500");
    const body = res.json() as ModelConfigGetResponse;
    assert.deepStrictEqual(body.known_models, [], "roster degrades to []");
    // A concrete SoT id is unknown against the empty roster…
    assert.strictEqual(domainOf(body, "model.research").pricing_known, false);
    // …while 'inherit' stays pricing-known (roster-independent branch).
    assert.strictEqual(domainOf(body, "model.dev").pricing_known, true);
  } finally {
    process.env.PRICING_SOT_PATH = pricingSotPath;
  }

  // Transient-error recovery: the next GET retries the read and serves the fixture
  // roster — this assertion also guards against a reintroduced roster cache.
  const res2 = await app.inject({ method: "GET", url: "/api/model-config" });
  assert.strictEqual(res2.statusCode, 200);
  assert.deepStrictEqual(
    [...(res2.json() as ModelConfigGetResponse).known_models].sort(),
    Object.keys(PRICING_SOT_FIXTURE.models).sort(),
    "roster recovers on the next GET once the SoT is readable again",
  );
});

// ----- PUT validation (AC-2 / AC-3) -------------------------------------------------

test("AC-2: invalid model value → 400 field-level error + zero writes", async () => {
  const daemonConfigBefore = readFileSync(daemonConfigPath, "utf8");
  const betaBefore = readFileSync(path.join(agentsDir, "glass-atrium-dev-beta.md"), "utf8");

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
  assert.strictEqual(readFileSync(path.join(agentsDir, "glass-atrium-dev-beta.md"), "utf8"), betaBefore, "frontmatter untouched");
});

test("D2: bare alias PUT → 400 with remediation message on EVERY domain (dev/research too)", async () => {
  // The words still match FREE_TEXT_MODEL_PATTERN — only the explicit reject-list
  // stands between a bare alias and a silent free-text 200.
  for (const [domain, value] of [
    ["model.dev", "sonnet"],
    ["model.dev", "opus"],
    ["model.research", "haiku"],
    ["model.research", "sonnet"],
    ["model.daemon_cycle_haiku", "sonnet"],
  ] as const) {
    const res = await app.inject({
      method: "PUT",
      url: "/api/model-config",
      payload: { models: { [domain]: value } },
    });
    assert.strictEqual(res.statusCode, 400, `${domain}=${value} must 400`);
    const body = res.json() as { error: string; field: string; reason: string };
    assert.strictEqual(body.error, "invalid_body");
    assert.strictEqual(body.field, `models.${domain}`);
    assert.ok(body.reason.includes("use a concrete id"), "remediation message present");
  }
  assert.strictEqual(await getDbValue("model.dev"), "inherit", "DB unchanged after rejects");
  assert.strictEqual(await getDbValue("model.research"), "claude-sonnet-5", "DB unchanged after rejects");
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
  assert.strictEqual(await getDbValue("budget.haiku_max_usd"), "10.00", "DB unchanged after rejects");
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
  assert.strictEqual(rendered.pre_verify_max_budget_usd, "10.00", "untouched budget key preserved");
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
  assert.strictEqual(byFile.get("glass-atrium-dev-alpha.md")?.status, "ok");
  assert.strictEqual(byFile.get("glass-atrium-dev-beta.md")?.status, "ok");
  assert.strictEqual(byFile.get("glass-atrium-dev-broken.md")?.status, "skipped");

  // Symlink hazard (D4): the agents-dir entry stays a symlink; the RESOLVED file got the line.
  assert.ok(lstatSync(path.join(agentsDir, "glass-atrium-dev-alpha.md")).isSymbolicLink(), "symlink preserved");
  const alphaReal = readFileSync(path.join(realAgentsDir, "glass-atrium-dev-alpha.md"), "utf8");
  assert.ok(alphaReal.includes("\nmodel: claude-opus-4-8\n"), "resolved target updated");
  assert.ok(readFileSync(path.join(agentsDir, "glass-atrium-dev-beta.md"), "utf8").includes("\nmodel: claude-opus-4-8\n"));
  assert.strictEqual(
    readFileSync(path.join(agentsDir, "glass-atrium-dev-broken.md"), "utf8"),
    "no frontmatter here\njust text\n",
    "unparseable file untouched",
  );
  assert.ok(
    readFileSync(path.join(agentsDir, "glass-atrium-intel-researcher.md"), "utf8").includes("\nmodel: claude-sonnet-5\n"),
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
  assert.ok(!readFileSync(path.join(realAgentsDir, "glass-atrium-dev-alpha.md"), "utf8").includes("model:"));
  assert.ok(!readFileSync(path.join(agentsDir, "glass-atrium-dev-beta.md"), "utf8").includes("model:"));
});

// ----- daemon-apply concurrency guard ------------------------------------------------

test("409 while .apply-lock exists — frontmatter writes only; budget-only PUT passes", async () => {
  mkdirSync(applyLockPath, { recursive: true });
  try {
    const betaBefore = readFileSync(path.join(agentsDir, "glass-atrium-dev-beta.md"), "utf8");
    // Concrete id — an alias value would 400 at validation before reaching the lock path.
    const res = await app.inject({
      method: "PUT",
      url: "/api/model-config",
      payload: { models: { "model.dev": "claude-opus-4-8" } },
    });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual((res.json() as { error: string }).error, "daemon_apply_in_progress");
    assert.strictEqual(await getDbValue("model.dev"), "inherit", "DB unchanged on 409");
    assert.strictEqual(readFileSync(path.join(agentsDir, "glass-atrium-dev-beta.md"), "utf8"), betaBefore);

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
  // Baseline model.research is now the concrete id 'claude-sonnet-5', so the mutation MUST target
  // a different concrete id (an equal-value PUT is a no-op → no audit row → poll timeout).
  const res = await app.inject({
    method: "PUT",
    url: "/api/model-config",
    payload: { models: { "model.research": "claude-sonnet-4-6" } },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(
    readFileSync(path.join(agentsDir, "glass-atrium-intel-researcher.md"), "utf8").includes("\nmodel: claude-sonnet-4-6\n"),
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
  // `old` anchors to the suite BASELINE (concrete id — see the BASELINE note).
  assert.deepStrictEqual(rows[0].payload.change?.changes?.["model.research"], {
    old: "claude-sonnet-5",
    new: "claude-sonnet-4-6",
  });

  // Restore round-trips through the route — DB row + research frontmatter both return
  // to the suite baseline under the invariants the route enforces.
  const restore = await app.inject({
    method: "PUT",
    url: "/api/model-config",
    payload: { models: { "model.research": "claude-sonnet-5" } },
  });
  assert.strictEqual(restore.statusCode, 200);
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
