// Regression: the two Outcomes surfaces gated in outcomes.ts against the canonical
// agent registry —
//   - T6  GET /api/outcomes/cross-analysis  → by_agent_top_10 (AgentStackedBar +
//         KPI sparkline) MUST exclude non-registry noise, while the SIBLING
//         distributions (by_result / cross-tab / grader) stay all-population.
//   - T7  GET /api/outcomes/search           → default view MUST exclude noise +
//         de-registered agents (O2 registry-scoped record-log); an include_all=1
//         forensic toggle MUST re-admit them (AC-2).
//
// Hermetic registry — AGENT_REGISTRY_PATH points at a fixture holding ONLY this
// suite's canonical agent (uuid-unique → no collision with concurrent sessions),
// so the gate collapses every gated surface to that agent alone; the seeded
// non-registry tokens then prove exclusion deterministically.
//
// DB: real Postgres. Every seed row carries SUITE_MARKER in summary (→ ?q scoping)
// AND cid (→ cleanup via cid LIKE). Skips gracefully when the DB is unreachable.
//
// Runner: npx tsx --test test/outcomes.registry-gate.route.test.ts

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { resetAgentRegistryCache } from "../src/server/agents/registry.js";
import { registerOutcomesRoutes } from "../src/server/routes/outcomes.js";
import type {
  OutcomeCrossAnalysisResponse,
  OutcomeSearchResponse,
} from "../src/server/types/outcomes.js";

const SUITE_MARKER = `outcomes-registry-gate-test-${randomUUID()}`;
const CANONICAL_AGENT = `outcomes-gate-canon-${randomUUID().slice(0, 8)}`;
// The de-registered agent named in AC-1 — a former registry member whose `.md`
// still leaks tokens into the outcome table but is absent from the registry.
const DE_REGISTERED = "design-audio-engineer";
// Sentinel / built-in / cron noise literals mirroring the real-world pollution
// the O2 gate targets.
const SENTINELS = ["subagent_stop_missing", "general-purpose", "cron:daemon-cycle"];
const ALL_NOISE = [DE_REGISTERED, ...SENTINELS];

// Row counts — canonical 3, noise 4 (de-registered + 3 sentinels) → 7 total.
const CANONICAL_ROWS = 3;
const NOISE_ROWS = ALL_NOISE.length;
const TOTAL_ROWS = CANONICAL_ROWS + NOISE_ROWS;

// Canonical rows carry an admitted attribution_source (CHECK allowlist members) so
// the /search raw-field passthrough + exact-match filter can be asserted. The
// intended production value 'budget-truncation' is CHECK-rejected on INSERT, so it
// is exercised as a zero-row filter separately. Noise rows keep NULL.
const CANONICAL_ATTR_SOURCES = ["truncated_completion", "truncated_completion", "hook-input"] as const;
const TRUNCATED_COMPLETION_ROWS = 2;

// Registry fixture — CANONICAL_AGENT is the ONLY member, so the gate reduces each
// gated surface to exactly this agent.
const REGISTRY_FIXTURE = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    [CANONICAL_AGENT]: {
      domains: ["test"],
      phase: "implementation",
      dual_phase: false,
    },
  },
};

let app: FastifyInstance;
let tmpRoot: string;
let dbReady = false;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "outcomes-gate-registry-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerOutcomesRoutes(app);
  await app.ready();

  try {
    await seedOutcomes();
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[outcomes-gate-test] DB seed failed — tests will skip:", error);
  }
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  if (dbReady) {
    try {
      const prisma = getPrisma();
      await prisma.$executeRaw`
        DELETE FROM core.outcomes WHERE cid LIKE ${`%${SUITE_MARKER}%`}
      `;
    } catch (error) {
      console.error("[outcomes-gate-test cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

// 7 non-poisoned rows within the window: 3 canonical + 1 de-registered + 3
// sentinels. All 'feature'/'done' so the defensive enum guard keeps them; distinct
// record_ts + cid → no dedup collision.
async function seedOutcomes(): Promise<void> {
  const prisma = getPrisma();
  const agents: string[] = [
    ...Array(CANONICAL_ROWS).fill(CANONICAL_AGENT),
    ...ALL_NOISE,
  ];
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i]!;
    // Canonical rows get an admitted attribution_source; noise rows stay NULL.
    const source: string | null = i < CANONICAL_ROWS ? CANONICAL_ATTR_SOURCES[i] ?? null : null;
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, summary, poisoned_window, attribution_source, cid)
      VALUES
        (NOW() - (${i + 1}::int * INTERVAL '1 minute'),
         ${agent},
         'feature'::core."TaskType",
         'done'::core."OutcomeResult",
         ${`registry-gate seed ${SUITE_MARKER} row-${i}`},
         FALSE,
         ${source},
         ${`${SUITE_MARKER}-${i}`})
    `;
  }
}

// ── T6 — cross-analysis by_agent_top_10 gated, siblings all-population ─────────

test("T6 cross-analysis: by_agent_top_10 excludes noise, keeps canonical", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/cross-analysis?days=all&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as OutcomeCrossAnalysisResponse;

  // Gated dimension — only the canonical agent survives; no noise token appears.
  for (const noise of ALL_NOISE) {
    assert.ok(
      !body.by_agent_top_10.some((r) => r.agent === noise),
      `non-registry token '${noise}' must be excluded from by_agent_top_10`,
    );
  }
  const canon = body.by_agent_top_10.find((r) => r.agent === CANONICAL_AGENT);
  assert.ok(canon !== undefined, "canonical agent must be present in by_agent_top_10");
  assert.strictEqual(canon.count, CANONICAL_ROWS, "canonical by-agent count = seeded canonical rows");
});

test("T6 cross-analysis: sibling by_result is registry-scoped by default, include_all=1 restores noise", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");

  // Default view — the shared buildWhereClause now carries the registry-membership
  // AND-tail too, so by_result (and the analytics total) collapse to the
  // canonical-only count, matching the by-agent gate's own population.
  const defaultRes = await app.inject({
    method: "GET",
    url: `/api/outcomes/cross-analysis?days=all&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(defaultRes.statusCode, 200, "must be 200");
  const defaultBody = defaultRes.json() as OutcomeCrossAnalysisResponse;

  const defaultByResultSum = defaultBody.by_result.reduce((acc, r) => acc + r.count, 0);
  assert.strictEqual(
    defaultByResultSum,
    CANONICAL_ROWS,
    "default by_result excludes noise (registry-scoped by default)",
  );
  assert.strictEqual(
    defaultBody.total,
    CANONICAL_ROWS,
    "default analytics total excludes noise (registry-scoped by default)",
  );
  const defaultByAgentSum = defaultBody.by_agent_top_10.reduce((acc, r) => acc + r.count, 0);
  assert.strictEqual(defaultByAgentSum, CANONICAL_ROWS, "by_agent sum = canonical only");

  // include_all=1 — forensic opt-out restores the noise rows to by_result/total,
  // but by_agent_top_10 stays gated regardless (T6 unconditional).
  const allRes = await app.inject({
    method: "GET",
    url: `/api/outcomes/cross-analysis?days=all&q=${encodeURIComponent(SUITE_MARKER)}&include_all=1`,
  });
  assert.strictEqual(allRes.statusCode, 200, "include_all view must be 200");
  const allBody = allRes.json() as OutcomeCrossAnalysisResponse;

  const allByResultSum = allBody.by_result.reduce((acc, r) => acc + r.count, 0);
  assert.strictEqual(allByResultSum, TOTAL_ROWS, "include_all=1 restores noise rows to by_result");
  assert.strictEqual(allBody.total, TOTAL_ROWS, "include_all=1 restores noise rows to total");
  assert.strictEqual(
    allBody.by_agent_top_10.some((r) => ALL_NOISE.includes(r.agent)),
    false,
    "by_agent_top_10 STILL excludes noise even under include_all=1 (T6 independent of the toggle)",
  );
});

// ── T7 — /search O2 default gate + include_all forensic override ──────────────

test("T7 search: default view excludes noise + de-registered (registry-scoped)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/search?days=all&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as OutcomeSearchResponse;

  for (const noise of ALL_NOISE) {
    assert.ok(
      !body.rows.some((r) => r.agent === noise),
      `non-registry token '${noise}' must be excluded from the default /search view`,
    );
  }
  assert.ok(
    body.rows.every((r) => r.agent === CANONICAL_AGENT),
    "every default-view row is the canonical agent",
  );
  assert.strictEqual(body.rows.length, CANONICAL_ROWS, "default view returns only canonical rows");
  assert.strictEqual(body.total, CANONICAL_ROWS, "gated total counts only canonical rows");
});

test("T7 search: include_all=1 re-admits de-registered + sentinels (forensic, AC-2)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/search?days=all&q=${encodeURIComponent(SUITE_MARKER)}&include_all=1`,
  });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as OutcomeSearchResponse;

  // De-registered agent (named in AC-1) reappears in the forensic view.
  assert.ok(
    body.rows.some((r) => r.agent === DE_REGISTERED),
    `de-registered '${DE_REGISTERED}' must reappear under include_all`,
  );
  // Every sentinel reappears too.
  for (const sentinel of SENTINELS) {
    assert.ok(
      body.rows.some((r) => r.agent === sentinel),
      `sentinel '${sentinel}' must reappear under include_all`,
    );
  }
  // Canonical is ALWAYS present (both views).
  assert.ok(
    body.rows.some((r) => r.agent === CANONICAL_AGENT),
    "canonical agent must be present under include_all",
  );
  assert.strictEqual(body.rows.length, TOTAL_ROWS, "forensic view returns the full population");
  assert.strictEqual(body.total, TOTAL_ROWS, "forensic total counts all rows (gate lifted)");
});

// ── attribution_source — raw /search row field + exact-match filter ───────────

test("search rows expose raw attribution_source verbatim", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/search?days=all&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as OutcomeSearchResponse;
  // Only the 3 canonical rows survive the registry gate; each carries its seeded
  // attribution_source verbatim (raw column, NOT re-categorized).
  const sources = body.rows.map((r) => r.attribution_source).sort();
  assert.deepStrictEqual(
    sources,
    ["hook-input", "truncated_completion", "truncated_completion"],
    "search rows carry the raw attribution_source values that were seeded",
  );
});

test("attribution_source=truncated_completion narrows /search to matching rows", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/search?days=all&q=${encodeURIComponent(SUITE_MARKER)}&attribution_source=truncated_completion`,
  });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as OutcomeSearchResponse;
  assert.strictEqual(body.rows.length, TRUNCATED_COMPLETION_ROWS, "filter narrows to the 2 truncated_completion rows");
  assert.strictEqual(body.total, TRUNCATED_COMPLETION_ROWS, "gated total matches the filtered count");
  assert.ok(
    body.rows.every((r) => r.attribution_source === "truncated_completion"),
    "every filtered row has attribution_source=truncated_completion",
  );
  assert.strictEqual(
    body.filter.attribution_source,
    "truncated_completion",
    "filter echo carries the applied attribution_source",
  );
});

test("attribution_source=budget-truncation binds as a parameter and returns 0 rows (intended production value)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  // The literal production value is CHECK-rejected on INSERT, so no such row can
  // exist yet; the exact-match filter must still bind cleanly (parameterized, no
  // SQL error) and return an empty set — proving it works for the real value.
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/search?days=all&q=${encodeURIComponent(SUITE_MARKER)}&attribution_source=budget-truncation`,
  });
  assert.strictEqual(res.statusCode, 200, "must be 200 (filter binds, no SQL error)");
  const body = res.json() as OutcomeSearchResponse;
  assert.strictEqual(body.rows.length, 0, "no budget-truncation rows exist → empty result");
  assert.strictEqual(
    body.filter.attribution_source,
    "budget-truncation",
    "filter echo carries the requested value",
  );
});
