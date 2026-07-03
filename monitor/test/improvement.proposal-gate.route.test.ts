// T8 + T9 registry-membership gating for GET /api/improvement.
//   - T8: proposals[] + actionable_proposals[] scoped to registry target_agent.
//   - T9: tier_breakdown_30d converted from the retired 3-item infra denylist to
//         the positive registry allowlist (agent IN registry).
//
// Hermetic registry — AGENT_REGISTRY_PATH points at a fixture holding ONLY this
// suite's canonical agent (uuid-unique → no collision with concurrent sessions),
// so the gate collapses every surface to that agent alone; the seeded
// non-registry noise (INCLUDING the retired denylist trio orchestrator /
// subagent_stop_missing / unknown) then proves exclusion deterministically.
//
// DB: real Postgres (seeds scrubbed by suite-marker LIKE). Skips gracefully when
// the DB is unreachable.
//
// Runner: npx tsx --test test/improvement.proposal-gate.route.test.ts

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
import { registerImprovementRoutes } from "../src/server/routes/improvement.js";

const SUITE_MARKER = `impr-pgate-${randomUUID().slice(0, 8)}`;
const CANONICAL_AGENT = `${SUITE_MARKER}-canon`;
const NOISE_UNIQUE = `${SUITE_MARKER}-noise`;
// The retired TIER_BREAKDOWN_INFRA_AGENTS denylist trio + a real-world literal —
// all non-registry, so the positive allowlist must subsume the old denylist.
const NOISE_LITERALS = ["orchestrator", "subagent_stop_missing", "unknown", "general-purpose"];
const ALL_NOISE = [NOISE_UNIQUE, ...NOISE_LITERALS];

// Registry fixture — CANONICAL_AGENT is the ONLY member, so the gate reduces
// every surface to exactly this agent.
const REGISTRY_FIXTURE = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    [CANONICAL_AGENT]: { domains: ["test"], phase: "implementation", dual_phase: false },
  },
};

let app: FastifyInstance;
let tmpRoot: string;
let registryPath: string;
let dbReady = false;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "impr-pgate-registry-"));
  registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerImprovementRoutes(app);
  await app.ready();

  try {
    await seedProposals();
    await seedOutcomes();
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[impr-pgate] DB seed failed — tests will skip:", error);
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
        DELETE FROM core.autoagent_proposals WHERE pattern_label LIKE ${`%${SUITE_MARKER}%`}
      `;
      await prisma.$executeRaw`
        DELETE FROM core.outcomes WHERE cid LIKE ${`%${SUITE_MARKER}%`}
      `;
    } catch (error) {
      console.error("[impr-pgate cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

// T8 fixtures — one safety-tier PENDING proposal per target_agent (canonical +
// every noise token). Safety-tier + pending → each appears in BOTH proposals[]
// and actionable_proposals[] absent the gate. Unique target_file per row avoids
// the (cycle_date, pattern_label, target_file) dedup collision.
async function seedProposals(): Promise<void> {
  const prisma = getPrisma();
  const targets = [CANONICAL_AGENT, ...ALL_NOISE];
  for (let i = 0; i < targets.length; i++) {
    const targetAgent = targets[i]!;
    await prisma.$executeRaw`
      INSERT INTO core.autoagent_proposals
        (cycle_date, pattern_label, target_file, target_agent, classification,
         approval_tier, status, source_file, source_file_mtime)
      VALUES
        (CURRENT_DATE,
         ${`${SUITE_MARKER} proposal ${i}`},
         ${`/__test__/${SUITE_MARKER}-prop-${i}.md`},
         ${targetAgent},
         'apply'::core."ProposalClassification",
         'user'::core."ApprovalTier",
         'pending'::core."ProposalStatus",
         '/__test__/source.md', 0)
    `;
  }
}

// T9 fixtures — canonical: 2 code-based PASS (metric_pass=TRUE) + 1 FAIL
// (metric_pass=FALSE); every noise token: 1 FAIL. baseline_pre_3tier omitted
// (NULL) so all rows satisfy the `baseline_pre_3tier IS NULL` FILTER;
// poisoned_window=FALSE. The allowlist must keep ONLY the canonical counts.
async function seedOutcomes(): Promise<void> {
  const prisma = getPrisma();
  const rows: Array<{ agent: string; pass: boolean; tag: string }> = [
    { agent: CANONICAL_AGENT, pass: true, tag: "canon-pass-a" },
    { agent: CANONICAL_AGENT, pass: true, tag: "canon-pass-b" },
    { agent: CANONICAL_AGENT, pass: false, tag: "canon-fail" },
    ...ALL_NOISE.map((a, i) => ({ agent: a, pass: false, tag: `noise-${i}` })),
  ];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, metric_pass, poisoned_window, review_flag, summary, cid)
      VALUES
        (NOW() - (${i + 1}::int * INTERVAL '1 minute'),
         ${row.agent},
         'feature'::core."TaskType",
         ${row.pass ? "done" : "fail"}::core."OutcomeResult",
         ${row.pass}::boolean,
         FALSE,
         FALSE,
         ${`impr-pgate seed ${row.tag}`},
         ${`${SUITE_MARKER}-${row.tag}`})
    `;
  }
}

test("T8: proposals[] target_agent registry-gated (noise + denylist trio excluded)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({ method: "GET", url: "/api/improvement?limit=200" });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as { proposals: Array<{ target_agent: string | null }> };

  for (const noise of ALL_NOISE) {
    assert.ok(
      !body.proposals.some((p) => p.target_agent === noise),
      `non-registry target_agent '${noise}' must be excluded from proposals[]`,
    );
  }
  assert.ok(
    body.proposals.some((p) => p.target_agent === CANONICAL_AGENT),
    "canonical target_agent must be present in proposals[]",
  );
});

test("T8: actionable_proposals[] target_agent registry-gated", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({ method: "GET", url: "/api/improvement?limit=200" });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as { actionable_proposals: Array<{ target_agent: string | null }> };

  for (const noise of ALL_NOISE) {
    assert.ok(
      !body.actionable_proposals.some((p) => p.target_agent === noise),
      `non-registry target_agent '${noise}' must be excluded from actionable_proposals[]`,
    );
  }
  assert.ok(
    body.actionable_proposals.some((p) => p.target_agent === CANONICAL_AGENT),
    "canonical target_agent must be present in actionable_proposals[]",
  );
});

test("T9: tier_breakdown_30d counts registry-only via positive allowlist", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({ method: "GET", url: "/api/improvement?limit=5" });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as {
    tier_breakdown_30d: { code_based_pass_30d: number; code_based_fail_30d: number };
  };

  // Fixture registry = {canonical} (uuid-unique) → only the 2 canonical PASS and
  // 1 canonical FAIL rows count. The 4 noise FAILs (incl. the orchestrator /
  // subagent_stop_missing / unknown denylist trio the allowlist replaced) are
  // excluded — an old denylist that missed 'general-purpose' would leak it.
  assert.strictEqual(
    body.tier_breakdown_30d.code_based_pass_30d,
    2,
    "code_based_pass_30d counts only canonical passes",
  );
  assert.strictEqual(
    body.tier_breakdown_30d.code_based_fail_30d,
    1,
    "code_based_fail_30d counts only the canonical fail (all noise excluded)",
  );
});

test("T8/T9 fail-open: empty registry skips the gate (no invalid IN () SQL)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  // Repoint to an empty registry + reset cache → buildAgentMembership* returns
  // Prisma.empty → the predicate is skipped. A 200 proves fail-open: an unguarded
  // Prisma.join([]) would emit `target_agent IN ()` (PG syntax error → 503).
  const emptyPath = join(tmpRoot, "empty-registry.json");
  await writeFile(
    emptyPath,
    JSON.stringify({ $schema: "agent-registry", version: "1.1", agents: {} }),
    "utf8",
  );
  process.env.AGENT_REGISTRY_PATH = emptyPath;
  resetAgentRegistryCache();
  try {
    const res = await app.inject({ method: "GET", url: "/api/improvement?limit=5" });
    assert.strictEqual(res.statusCode, 200, "empty registry must not emit invalid IN () SQL");
  } finally {
    process.env.AGENT_REGISTRY_PATH = registryPath;
    resetAgentRegistryCache();
  }
});
