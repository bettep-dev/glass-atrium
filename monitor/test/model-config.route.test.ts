// Integration tests for GET/PUT /api/model-config (spec doc 36166 AC-1..AC-6, AC-9).
//
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/model-config.route.test.ts
//
// Test infra:
//   - DB: real Postgres, the test-only database MONITOR_TEST_DATABASE_URL names
//     → select-test-db.ts swaps it into DATABASE_URL; unset → the run refuses to start.
//     monitor.model_config rows: snapshotted in before(), restored byte-for-byte in after() (updated_at included).
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
  TierDomainStatus,
} from "../src/server/types/model-config.js";

// Suite baseline — every test starts from (or restores toward) this state. Mirrors the
// migration seed's shipped defaults exactly: model.research seeds the concrete id
// 'claude-sonnet-5' (the legacy 'sonnet' alias is rejected on current code, D2), so no
// per-key workaround is needed here; the legacy-alias display path keeps its own scoped
// fixture in the tolerance test below.
const BASELINE: ReadonlyArray<[string, string]> = [
  ["model.dev", "inherit"],
  ["model.research", "claude-sonnet-5"],
  ["model.meta", "claude-sonnet-5"],
  ["model.wiki", "claude-sonnet-5"],
  ["model.review", "inherit"],
  ["model.docs", "inherit"],
  ["model.daemon_cycle_worker", "claude-haiku-4-5"],
  ["budget.worker_max_usd", "10.00"],
  ["budget.pre_verify_max_usd", "10.00"],
];

const DAEMON_CONFIG_FIXTURE = {
  _comment: "fixture comment — must survive every render",
  worker_max_budget_usd: "10.00",
  pre_verify_max_budget_usd: "10.00",
  worker_model: "claude-haiku-4-5",
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
    "claude-sonnet-5": { input: 2.0, output: 10.0, cache_read: 0.2, cache_creation: 2.5 },
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

const REVIEW_AGENT_FILES = ["glass-atrium-qa-code-reviewer.md", "glass-atrium-qa-debugger.md"];
const DOCS_AGENT_FILES = ["glass-atrium-intel-planner.md", "glass-atrium-intel-reporter.md"];
const PAIR_DOMAINS = [
  { key: "model.review", surface: "frontmatter-review", files: REVIEW_AGENT_FILES },
  { key: "model.docs", surface: "frontmatter-docs", files: DOCS_AGENT_FILES },
] as const;

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
  // Single-agent frontmatter surfaces for the new meta/wiki domains — seeded with the
  // baseline model line so both read back drift-free (mirrors the research fixture).
  writeFileSync(
    path.join(agentsDir, "glass-atrium-meta-agent.md"),
    agentMarkdown("glass-atrium-meta-agent", ["model: claude-sonnet-5"]),
    "utf8",
  );
  writeFileSync(
    path.join(agentsDir, "glass-atrium-wiki-curator.md"),
    agentMarkdown("glass-atrium-wiki-curator", ["model: claude-sonnet-5"]),
    "utf8",
  );

  // Two-file review/docs surfaces — no `model:` key, matching the seeded `inherit` rows.
  for (const name of [...REVIEW_AGENT_FILES, ...DOCS_AGENT_FILES]) {
    writeFileSync(path.join(agentsDir, name), agentMarkdown(name.replace(/\.md$/, "")), "utf8");
  }

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

  assert.strictEqual(body.domains.length, 7);
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

  const meta = domainOf(body, "model.meta");
  assert.strictEqual(meta.apply_mode, "next-spawn");
  assert.strictEqual(meta.desired, "claude-sonnet-5");
  assert.strictEqual(meta.actual, "claude-sonnet-5");
  assert.strictEqual(meta.drift, false);

  const wiki = domainOf(body, "model.wiki");
  assert.strictEqual(wiki.apply_mode, "next-spawn");
  assert.strictEqual(wiki.desired, "claude-sonnet-5");
  assert.strictEqual(wiki.actual, "claude-sonnet-5");
  assert.strictEqual(wiki.drift, false);

  // Key-less pair files read back as the seeded `inherit`, per file, with no drift.
  for (const pair of PAIR_DOMAINS) {
    const status = domainOf(body, pair.key);
    assert.strictEqual(status.apply_mode, "next-spawn");
    assert.strictEqual(status.desired, "inherit");
    assert.strictEqual(status.actual, "inherit");
    assert.strictEqual(status.drift, false);
    assert.deepStrictEqual(status.files, pair.files.map((file) => ({ file, model: null })));
  }

  const haiku = domainOf(body, "model.daemon_cycle_worker");
  assert.strictEqual(haiku.apply_mode, "next-cycle");
  assert.strictEqual(haiku.actual, "claude-haiku-4-5");
  assert.strictEqual(haiku.drift, false);

  // Per-call hard-cap budgets mirror the daemon-config.json fixture (no drift on baseline).
  assert.strictEqual(body.budgets.length, 2);
  const haikuBudget = budgetOf(body, "budget.worker_max_usd");
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
    ["model.daemon_cycle_worker", "sonnet"],
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

test("PUT: a key only another group knows → 400 naming the group-qualified field with that group's reason", async () => {
  const rows: ReadonlyArray<{ name: string; payload: object; field: string; reason: string }> = [
    {
      name: "a budget key under models",
      payload: { models: { "budget.worker_max_usd": "2.00" } },
      field: "models.budget.worker_max_usd",
      reason: "unknown domain key",
    },
    {
      name: "a tier key under budgets",
      payload: { budgets: { "tier.worker_effort": "high" } },
      field: "budgets.tier.worker_effort",
      reason: "unknown budget key",
    },
    {
      name: "a model key under tiers",
      payload: { tiers: { "model.dev": "claude-haiku-4-5" } },
      field: "tiers.model.dev",
      reason: "unknown tier key",
    },
  ];
  for (const row of rows) {
    const res = await app.inject({ method: "PUT", url: "/api/model-config", payload: row.payload });
    assert.strictEqual(res.statusCode, 400, `${row.name} must 400: ${res.body}`);
    assert.deepStrictEqual(
      res.json(),
      { error: "invalid_body", field: row.field, reason: row.reason },
      row.name,
    );
  }
});

test("PUT: a group that is not an object, or a body with no group → 400 naming it, and nothing is written", async () => {
  // Each malformed group follows a valid one the handler validates first — a write has something to land.
  const rows: ReadonlyArray<{ name: string; payload: object; field: string; reason: string }> = [
    {
      name: "tiers null",
      payload: { budgets: { "budget.worker_max_usd": "2.00" }, tiers: null },
      field: "tiers",
      reason: "must be an object",
    },
    {
      name: "tiers an array",
      payload: { budgets: { "budget.worker_max_usd": "2.00" }, tiers: [] },
      field: "tiers",
      reason: "must be an object",
    },
    {
      name: "budgets a string",
      payload: { models: { "model.daemon_cycle_worker": "claude-sonnet-4-6" }, budgets: "x" },
      field: "budgets",
      reason: "must be an object",
    },
    {
      name: "an empty body",
      payload: {},
      field: "body",
      reason: "must contain 'models', 'budgets' and/or 'tiers'",
    },
  ];
  const getConfigRows = () => getPrisma().modelConfig.findMany({ orderBy: { configKey: "asc" } });
  const rowsBefore = await getConfigRows();
  const fileBefore = readFileSync(daemonConfigPath, "utf8");
  for (const row of rows) {
    const res = await app.inject({ method: "PUT", url: "/api/model-config", payload: row.payload });
    assert.strictEqual(res.statusCode, 400, `${row.name} must 400: ${res.body}`);
    assert.deepStrictEqual(
      res.json(),
      { error: "invalid_body", field: row.field, reason: row.reason },
      row.name,
    );
    assert.deepStrictEqual(await getConfigRows(), rowsBefore, `${row.name}: no model_config row written`);
    assert.strictEqual(readFileSync(daemonConfigPath, "utf8"), fileBefore, `${row.name}: daemon-config.json untouched`);
  }
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
      payload: { budgets: { "budget.worker_max_usd": value } },
    });
    assert.strictEqual(res.statusCode, 400, `budget.worker_max_usd=${value} (${label}) must 400`);
    assert.strictEqual((res.json() as { field: string }).field, "budgets.budget.worker_max_usd");
  }
  assert.strictEqual(await getDbValue("budget.worker_max_usd"), "10.00", "DB unchanged after rejects");
});

// ----- PUT render: daemon-config.json (AC-4) ----------------------------------------

test("AC-4: daemon-key change rewrites daemon-config.json — unknown keys + budget string survive", async () => {
  const res = await app.inject({
    method: "PUT",
    url: "/api/model-config",
    payload: {
      models: { "model.daemon_cycle_worker": "claude-sonnet-4-6" },
      budgets: { "budget.worker_max_usd": "1.50" },
    },
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as ModelConfigPutResponse;
  assert.strictEqual(surfaceOf(body, "daemon-config.json").status, "ok");
  assert.strictEqual(body.daemon_config_sync, "ok");
  assert.strictEqual(domainOf(body, "model.daemon_cycle_worker").actual, "claude-sonnet-4-6");
  assert.strictEqual(budgetOf(body, "budget.worker_max_usd").actual, "1.50");

  const raw = readFileSync(daemonConfigPath, "utf8");
  const rendered = JSON.parse(raw) as Record<string, unknown>;
  assert.strictEqual(rendered.worker_model, "claude-sonnet-4-6");
  // The per-call cap renders verbatim under the real key daemon_config.py reads.
  assert.strictEqual(rendered.worker_max_budget_usd, "1.50");
  assert.strictEqual(rendered.pre_verify_max_budget_usd, "10.00", "untouched budget key preserved");
  assert.strictEqual(rendered._comment, DAEMON_CONFIG_FIXTURE._comment, "_comment preserved");
  // Deprecated aggregate-limit keys the monitor dropped are stripped on render → live file self-heals.
  assert.ok(!("cost_daily_limit_usd" in rendered), "deprecated cost_daily_limit_usd stripped");
  assert.ok(!("cost_monthly_limit_usd" in rendered), "deprecated cost_monthly_limit_usd stripped");
  // Trailing-zero STRING survives — a JSON number 1.5 would break the --max-budget-usd cap.
  assert.ok(raw.includes('"worker_max_budget_usd": "1.50"'), "'1.50' trailing zero byte-exact");
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
      payload: { budgets: { "budget.worker_max_usd": "0.75" } },
    });
    assert.strictEqual(res2.statusCode, 200);
  } finally {
    rmSync(applyLockPath, { recursive: true, force: true });
  }
});

for (const pair of PAIR_DOMAINS) {
  test(`${pair.key}: a concrete id renders into both files, inherit removes it from both`, async () => {
    const pin = await app.inject({ method: "PUT", url: "/api/model-config", payload: { models: { [pair.key]: "claude-opus-4-8" } } });
    assert.strictEqual(pin.statusCode, 200);
    const pinned = pin.json() as ModelConfigPutResponse;
    assert.deepStrictEqual(surfaceOf(pinned, pair.surface).files?.map((f) => [f.file, f.status]), pair.files.map((f) => [f, "ok"]));
    for (const file of pair.files) {
      assert.match(readFileSync(path.join(agentsDir, file), "utf8"), /^model: claude-opus-4-8$/m, `${file} pinned`);
    }
    assert.strictEqual(domainOf(pinned, pair.key).actual, "claude-opus-4-8");
    assert.strictEqual(domainOf(pinned, pair.key).drift, false);

    const unpin = await app.inject({ method: "PUT", url: "/api/model-config", payload: { models: { [pair.key]: "inherit" } } });
    assert.strictEqual(unpin.statusCode, 200);
    for (const file of pair.files) {
      assert.doesNotMatch(readFileSync(path.join(agentsDir, file), "utf8"), /^model:/m, `${file} unpinned`);
    }
    assert.strictEqual(domainOf(unpin.json() as ModelConfigGetResponse, pair.key).actual, "inherit");
    assert.strictEqual(await getDbValue(pair.key), "inherit");
  });

  test(`${pair.key}: a two-file disagreement reports mixed with per-file detail`, async () => {
    const [first, second] = pair.files;
    const firstPath = path.join(agentsDir, first);
    const original = readFileSync(firstPath, "utf8");
    writeFileSync(firstPath, agentMarkdown(first.replace(/\.md$/, ""), ["model: claude-sonnet-5"]), "utf8");
    try {
      const res = await app.inject({ method: "GET", url: "/api/model-config" });
      const status = domainOf(res.json() as ModelConfigGetResponse, pair.key);
      assert.strictEqual(status.actual, "mixed");
      assert.strictEqual(status.drift, true);
      assert.deepStrictEqual(status.files, [
        { file: first, model: "claude-sonnet-5" },
        { file: second, model: null },
      ]);
    } finally {
      writeFileSync(firstPath, original, "utf8");
    }
  });

  test(`${pair.key}: a missing listed file reads as unknown, never inherit-with-no-drift`, async () => {
    const missingPath = path.join(agentsDir, pair.files[0]);
    const original = readFileSync(missingPath, "utf8");
    rmSync(missingPath);
    try {
      const res = await app.inject({ method: "GET", url: "/api/model-config" });
      const status = domainOf(res.json() as ModelConfigGetResponse, pair.key);
      // Seeded desired is inherit → a never-loaded file shown as inherit would read as a match.
      assert.notStrictEqual(status.actual, "inherit");
      assert.strictEqual(status.actual, null);
    } finally {
      writeFileSync(missingPath, original, "utf8");
    }
  });

  test(`${pair.key}: 409 while .apply-lock exists, no file written`, async () => {
    mkdirSync(applyLockPath, { recursive: true });
    try {
      const before = pair.files.map((f) => readFileSync(path.join(agentsDir, f), "utf8"));
      const res = await app.inject({ method: "PUT", url: "/api/model-config", payload: { models: { [pair.key]: "claude-opus-4-8" } } });
      assert.strictEqual(res.statusCode, 409);
      assert.deepStrictEqual(pair.files.map((f) => readFileSync(path.join(agentsDir, f), "utf8")), before);
    } finally {
      rmSync(applyLockPath, { recursive: true, force: true });
    }
  });
}

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
    `${JSON.stringify({ ...DAEMON_CONFIG_FIXTURE, worker_model: "claude-haiku-4-5" }, null, 2)}\n`,
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
    payload: { models: { "model.daemon_cycle_worker": "claude-haiku-4-5" } },
  });
  assert.strictEqual(res3.statusCode, 200);
  assert.strictEqual((res3.json() as ModelConfigPutResponse).daemon_config_sync, "ok");
});

// ----- tier knobs: daemon `claude -p` --effort level + output-token cap ----------------

// Independent oracle: tier domain → the daemon-config.json key hooks/daemon_config.py reads.
const TIER_FILE_KEY: Readonly<Record<string, string>> = {
  "tier.worker_effort": "worker_effort",
  "tier.pre_verify_effort": "pre_verify_effort",
  "tier.worker_max_output_tokens": "worker_max_output_tokens",
  "tier.pre_verify_max_output_tokens": "pre_verify_max_output_tokens",
};

function tierOf(body: ModelConfigGetResponse, key: string): TierDomainStatus {
  const found = body.tiers.find((t) => t.domain === key);
  assert.ok(found, `tier ${key} present`);
  return found;
}

// Tier rows are not in BASELINE, so each tier test starts from (and leaves) none of them.
async function resetTierState(): Promise<void> {
  await getPrisma().modelConfig.deleteMany({ where: { configKey: { startsWith: "tier." } } });
  writeDaemonConfigFixture();
  await resetDbBaseline();
}

async function putTiers(tiers: Record<string, unknown>): Promise<ModelConfigPutResponse> {
  const res = await app.inject({ method: "PUT", url: "/api/model-config", payload: { tiers } });
  assert.strictEqual(res.statusCode, 200, res.body);
  return res.json() as ModelConfigPutResponse;
}

test("GET: every tier knob reads as unset on a fresh DB — no saved value, no file key, no drift", async () => {
  await resetTierState();
  const res = await app.inject({ method: "GET", url: "/api/model-config" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as ModelConfigGetResponse;

  assert.deepStrictEqual(body.tiers.map((t) => t.domain).sort(), Object.keys(TIER_FILE_KEY).sort());
  for (const tier of body.tiers) {
    assert.deepStrictEqual(
      { desired: tier.desired, actual: tier.actual, file_error: tier.file_error, drift: tier.drift, apply_mode: tier.apply_mode },
      { desired: null, actual: null, file_error: null, drift: false, apply_mode: "next-cycle" },
      tier.domain,
    );
  }
  assert.strictEqual(body.daemon_config_sync, "ok", "an absent row over an absent key is in sync");
});

test("PUT tiers: a saved level and cap render verbatim under the daemon's keys, other keys untouched", async () => {
  await resetTierState();
  const body = await putTiers({ "tier.worker_effort": "high", "tier.pre_verify_max_output_tokens": "32000" });

  assert.strictEqual(surfaceOf(body, "daemon-config.json").status, "ok");
  const rendered = JSON.parse(readFileSync(daemonConfigPath, "utf8")) as Record<string, unknown>;
  assert.strictEqual(rendered[TIER_FILE_KEY["tier.worker_effort"]], "high");
  assert.strictEqual(rendered[TIER_FILE_KEY["tier.pre_verify_max_output_tokens"]], "32000", "a cap stays a JSON string");
  assert.ok(!(TIER_FILE_KEY["tier.pre_verify_effort"] in rendered), "an unsaved knob writes no key");
  assert.strictEqual(rendered.worker_max_budget_usd, "10.00", "untouched daemon keys survive");
  assert.strictEqual(rendered._comment, DAEMON_CONFIG_FIXTURE._comment);
  assert.deepStrictEqual(
    { actual: tierOf(body, "tier.worker_effort").actual, drift: tierOf(body, "tier.worker_effort").drift },
    { actual: "high", drift: false },
  );
  assert.strictEqual(body.daemon_config_sync, "ok");
  assert.strictEqual(await getDbValue("tier.worker_effort"), "high");
  await resetTierState();
});

test("PUT tiers: 'inherit' deletes the knob's key, so the CLI default governs again", async () => {
  await resetTierState();
  await putTiers({ "tier.worker_effort": "high", "tier.worker_max_output_tokens": "16000" });

  const body = await putTiers({ "tier.worker_effort": "inherit" });

  const rendered = JSON.parse(readFileSync(daemonConfigPath, "utf8")) as Record<string, unknown>;
  assert.ok(!(TIER_FILE_KEY["tier.worker_effort"] in rendered), "inherit removes the key");
  assert.strictEqual(rendered[TIER_FILE_KEY["tier.worker_max_output_tokens"]], "16000", "a sibling knob is kept");
  assert.deepStrictEqual(
    { desired: tierOf(body, "tier.worker_effort").desired, actual: tierOf(body, "tier.worker_effort").actual, drift: tierOf(body, "tier.worker_effort").drift },
    { desired: "inherit", actual: null, drift: false },
  );
  assert.strictEqual(body.daemon_config_sync, "ok");
  await resetTierState();
});

test("PUT tiers: a value outside the accepted set → 400 naming the field, and nothing is written", async () => {
  await resetTierState();
  const fileBefore = readFileSync(daemonConfigPath, "utf8");
  const rows: ReadonlyArray<{ name: string; key: string; value: unknown }> = [
    { name: "an uppercase level", key: "tier.worker_effort", value: "HIGH" },
    { name: "a level the CLI does not list", key: "tier.pre_verify_effort", value: "ultra" },
    { name: "an empty level", key: "tier.worker_effort", value: "" },
    { name: "a padded level", key: "tier.worker_effort", value: " high" },
    { name: "a level on a cap key", key: "tier.worker_max_output_tokens", value: "high" },
    { name: "a zero cap", key: "tier.worker_max_output_tokens", value: "0" },
    { name: "a zero-led cap", key: "tier.worker_max_output_tokens", value: "0123" },
    { name: "a seven-digit cap", key: "tier.pre_verify_max_output_tokens", value: "1234567" },
    { name: "a fractional cap", key: "tier.worker_max_output_tokens", value: "1.5" },
    { name: "a negative cap", key: "tier.worker_max_output_tokens", value: "-1" },
    { name: "a JSON-number cap", key: "tier.worker_max_output_tokens", value: 16000 },
  ];
  for (const row of rows) {
    // A valid budget rides along — validate-all-first means the bad tier blocks it too.
    const res = await app.inject({
      method: "PUT",
      url: "/api/model-config",
      payload: { budgets: { "budget.worker_max_usd": "2.00" }, tiers: { [row.key]: row.value } },
    });
    assert.strictEqual(res.statusCode, 400, `${row.name} must 400: ${res.body}`);
    assert.strictEqual((res.json() as { field: string }).field, `tiers.${row.key}`, row.name);
  }
  const tierRows = await getPrisma().modelConfig.count({ where: { configKey: { startsWith: "tier." } } });
  assert.strictEqual(tierRows, 0, "no tier row written");
  assert.strictEqual(await getDbValue("budget.worker_max_usd"), "10.00", "the valid budget was not written either");
  assert.strictEqual(readFileSync(daemonConfigPath, "utf8"), fileBefore, "daemon-config.json untouched");
});

test("tier drift: a file that disagrees with the saved knob drifts that row and the file state", async () => {
  await resetTierState();
  await putTiers({ "tier.worker_effort": "high", "tier.pre_verify_effort": "inherit" });
  const rows: ReadonlyArray<{ name: string; file: Record<string, unknown>; domain: string }> = [
    { name: "a hand-edited level", file: { ...DAEMON_CONFIG_FIXTURE, worker_effort: "low" }, domain: "tier.worker_effort" },
    { name: "a hand-removed key", file: { ...DAEMON_CONFIG_FIXTURE }, domain: "tier.worker_effort" },
    {
      name: "an 'inherit' knob whose key is back",
      file: { ...DAEMON_CONFIG_FIXTURE, worker_effort: "high", pre_verify_effort: "max" },
      domain: "tier.pre_verify_effort",
    },
  ];
  for (const row of rows) {
    writeFileSync(daemonConfigPath, `${JSON.stringify(row.file, null, 2)}\n`, "utf8");
    const res = await app.inject({ method: "GET", url: "/api/model-config" });
    const body = res.json() as ModelConfigGetResponse;
    assert.strictEqual(tierOf(body, row.domain).drift, true, row.name);
    assert.strictEqual(body.daemon_config_sync, "drift", row.name);
  }
  await resetTierState();
});

// hooks/daemon_config.py exits every cycle on these values, so the row must say so — with or without a saved row.
test("tier read-back: a file value the daemon loader rejects shows on its row and takes the file state off 'ok'", async () => {
  const rows: ReadonlyArray<{ name: string; saved: Record<string, string>; domain: string; value: unknown; isDrift: boolean }> = [
    { name: "a level the CLI does not list, no saved row", saved: {}, domain: "tier.worker_effort", value: "ultra", isDrift: false },
    { name: "a JSON-number cap, no saved row", saved: {}, domain: "tier.worker_max_output_tokens", value: 16000, isDrift: false },
    { name: "the PUT-only word 'inherit' in the file", saved: {}, domain: "tier.pre_verify_effort", value: "inherit", isDrift: false },
    {
      name: "a rejected level over a saved one",
      saved: { "tier.worker_effort": "high" },
      domain: "tier.worker_effort",
      value: "ultra",
      isDrift: true,
    },
  ];
  for (const row of rows) {
    await resetTierState();
    if (Object.keys(row.saved).length > 0) {
      await putTiers(row.saved);
    }
    const file = { ...DAEMON_CONFIG_FIXTURE, [TIER_FILE_KEY[row.domain]]: row.value };
    writeFileSync(daemonConfigPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    const body = (await app.inject({ method: "GET", url: "/api/model-config" })).json() as ModelConfigGetResponse;
    const tier = tierOf(body, row.domain);

    assert.ok(tier.file_error?.includes(JSON.stringify(row.value)), `${row.name}: the row names the rejected value — ${tier.file_error}`);
    assert.strictEqual(tier.actual, null, `${row.name}: a rejected value is never reported in effect`);
    assert.strictEqual(tier.drift, row.isDrift, `${row.name}: drift`);
    assert.strictEqual(body.daemon_config_sync, "file-invalid", row.name);
  }
  await resetTierState();
});

test("tier read-back: a key the daemon loader reads as unset is in sync with a saved 'inherit'", async () => {
  for (const [name, value] of [["an empty string", ""], ["a JSON null", null]] as const) {
    await resetTierState();
    await putTiers({ "tier.worker_effort": "inherit" });
    writeFileSync(daemonConfigPath, `${JSON.stringify({ ...DAEMON_CONFIG_FIXTURE, worker_effort: value }, null, 2)}\n`, "utf8");
    const body = (await app.inject({ method: "GET", url: "/api/model-config" })).json() as ModelConfigGetResponse;
    const tier = tierOf(body, "tier.worker_effort");

    assert.deepStrictEqual({ actual: tier.actual, file_error: tier.file_error, drift: tier.drift }, { actual: null, file_error: null, drift: false }, name);
    assert.strictEqual(body.daemon_config_sync, "ok", name);
  }
  await resetTierState();
});

// ----- un-migrated DB (the post-update window) ---------------------------------------
//
// End-to-end version of model-config.legacy-read.unit.test.ts: `scripts/update.sh` ships server
// code keyed on the post-rename names without running `prisma migrate deploy`, so the GET queries
// rows that do not exist yet while the pre-rename rows sit right beside them.

/** Put the DB into the pre-rename shape: legacy rows present, post-rename rows absent. */
async function seedUnMigratedRows(legacyModel: string, legacyBudget: string): Promise<void> {
  const prisma = getPrisma();
  await prisma.modelConfig.deleteMany({
    where: { configKey: { in: ["model.daemon_cycle_worker", "budget.worker_max_usd"] } },
  });
  for (const [key, value] of [
    ["model.daemon_cycle_haiku", legacyModel],
    ["budget.haiku_max_usd", legacyBudget],
  ] as const) {
    await prisma.modelConfig.upsert({
      where: { configKey: key },
      update: { configValue: value, updatedBy: "test-unmigrated" },
      create: { configKey: key, configValue: value, updatedBy: "test-unmigrated" },
    });
  }
}

async function clearLegacyRows(): Promise<void> {
  await getPrisma().modelConfig.deleteMany({
    where: { configKey: { in: ["model.daemon_cycle_haiku", "budget.haiku_max_usd"] } },
  });
}

test("un-migrated DB: GET resolves both renamed domains and reports 'pending-migration'", async () => {
  await seedUnMigratedRows("claude-haiku-4-5", "0.75");
  // The file an un-migrated install actually carries — written by pre-rename server code.
  writeFileSync(
    daemonConfigPath,
    `${JSON.stringify(
      { _comment: "keep me", haiku_model: "claude-haiku-4-5", haiku_max_budget_usd: "0.75", pre_verify_max_budget_usd: "10.00" },
      null,
      2,
    )}\n`,
    "utf8",
  );

  try {
    const body = (await app.inject({ method: "GET", url: "/api/model-config" })).json() as ModelConfigGetResponse;

    // Before the read these were null — an empty 'custom…' model input and a '—' cap.
    const model = domainOf(body, "model.daemon_cycle_worker");
    assert.strictEqual(model.desired, "claude-sonnet-5", "a retired id is rewritten, not surfaced");
    const budget = budgetOf(body, "budget.worker_max_usd");
    assert.strictEqual(budget.desired, "0.75", "the operator's tuned cap moves verbatim");
    // The badge that used to go green over two missing rows.
    assert.strictEqual(body.daemon_config_sync, "pending-migration");
  } finally {
    await clearLegacyRows();
    await resetDbBaseline();
    writeDaemonConfigFixture();
  }
});

test("un-migrated DB: a models-only Save preserves the cap and ends that domain's legacy read", async () => {
  await seedUnMigratedRows("claude-haiku-4-5", "0.75");
  writeFileSync(
    daemonConfigPath,
    `${JSON.stringify({ haiku_model: "claude-haiku-4-5", haiku_max_budget_usd: "0.75" }, null, 2)}\n`,
    "utf8",
  );

  try {
    // The reported sequence: the operator changes only the model, so the PUT carries no budget.
    const res = await app.inject({
      method: "PUT",
      url: "/api/model-config",
      payload: { models: { "model.daemon_cycle_worker": "claude-opus-5" } },
    });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json() as ModelConfigPutResponse;

    // DB: the cap's only row is still the legacy one, and it is untouched.
    assert.strictEqual(await getDbValue("budget.haiku_max_usd"), "0.75", "the cap row survives");
    assert.strictEqual(await getDbValue("model.daemon_cycle_worker"), "claude-opus-5", "new row written");
    // File: the write-side carry landed the cap under its new name rather than dropping it.
    const rendered = JSON.parse(readFileSync(daemonConfigPath, "utf8")) as Record<string, unknown>;
    assert.strictEqual(rendered.worker_max_budget_usd, "0.75", "the tuned cap survives the Save");
    assert.strictEqual(rendered.worker_model, "claude-opus-5");
    // The un-Saved domain is still legacy-sourced, so the state stays honest after a partial Save.
    assert.strictEqual(body.daemon_config_sync, "pending-migration");
    assert.strictEqual(budgetOf(body, "budget.worker_max_usd").desired, "0.75");

    // The Saved domain no longer needs the legacy read at all: delete the legacy MODEL row and the
    // value must be unchanged — which it can only be if it came from the post-rename row.
    await getPrisma().modelConfig.deleteMany({ where: { configKey: "model.daemon_cycle_haiku" } });
    const after = (await app.inject({ method: "GET", url: "/api/model-config" })).json() as ModelConfigGetResponse;
    assert.strictEqual(domainOf(after, "model.daemon_cycle_worker").desired, "claude-opus-5");
  } finally {
    await clearLegacyRows();
    await resetDbBaseline();
    writeDaemonConfigFixture();
  }
});
