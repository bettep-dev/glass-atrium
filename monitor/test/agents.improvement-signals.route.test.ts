// Regression: the three Improvement-signals endpoints
//   - GET /api/agents/revision-distribution   (MASTER "improve first" ranking)
//   - GET /api/agents/review-flag-by-agent     (Health Index per-agent join)
//   - GET /api/agents/review-flag-timeseries   (daily review-flag series)
// MUST apply the canonical registry-membership gate. Before the fix they folded
// in non-registry noise (orchestrator/main-session token, cron:* parents,
// sentinels like subagent_stop_missing, one-off cids, general-purpose) that the
// sibling per-agent endpoints already excluded.
//
// Hermetic registry — AGENT_REGISTRY_PATH points at a fixture holding ONLY this
// suite's canonical agent, so the gate reduces every endpoint to that agent
// alone; the seeded non-registry tokens then prove exclusion deterministically
// (uuid-unique agent name → no collision with concurrent sessions).
//
// DB: real Postgres (seeds tagged by suite-unique cid, scrubbed via cid LIKE).
// Skips gracefully when the DB is unreachable.
//
// Runner: npx tsx --test test/agents.improvement-signals.route.test.ts

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
import { registerAgentsRoutes } from "../src/server/routes/agents.js";
import type {
  AgentReviewFlagByAgentResponse,
  AgentReviewFlagTimeseriesResponse,
  AgentRevisionDistributionResponse,
} from "../src/server/types/agents.js";

const SUITE_MARKER = `impr-sig-test-${randomUUID().slice(0, 8)}`;
const CANONICAL_AGENT = `${SUITE_MARKER}-canon`;
const NOISE_UNIQUE = `${SUITE_MARKER}-noise`;
// Literal noise tokens mirroring the real-world non-registry pollution the fix
// targets — seeded to prove even freshly-inserted noise is excluded.
const NOISE_LITERALS = ["subagent_stop_missing", "general-purpose", "cron:daemon-cycle"];
const ALL_NOISE = [NOISE_UNIQUE, ...NOISE_LITERALS];

// Registry fixture — CANONICAL_AGENT is the ONLY member, so the gate collapses
// each endpoint to exactly this agent.
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
  tmpRoot = await mkdtemp(join(tmpdir(), "impr-sig-registry-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerAgentsRoutes(app);
  await app.ready();

  // Seed both canonical + noise rows; a DB failure flips dbReady off → skip.
  try {
    await seedOutcomes();
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[impr-sig-test] DB seed failed — tests will skip:", error);
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
      console.error("[impr-sig-test cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

// Canonical: 3 rows today (2× rev0 — one review-flagged — + 1× rev2).
// Noise: 5 rows today across the unique token + literals. All within the 7-day
// window so the gate is the sole discriminator.
async function seedOutcomes(): Promise<void> {
  const prisma = getPrisma();
  const rows: Array<{
    agent: string;
    revision: number;
    reviewFlag: boolean;
    tag: string;
  }> = [
    { agent: CANONICAL_AGENT, revision: 0, reviewFlag: false, tag: "canon-a" },
    { agent: CANONICAL_AGENT, revision: 0, reviewFlag: true, tag: "canon-b" },
    { agent: CANONICAL_AGENT, revision: 2, reviewFlag: false, tag: "canon-c" },
    { agent: NOISE_UNIQUE, revision: 1, reviewFlag: true, tag: "noise-uniq-a" },
    { agent: NOISE_UNIQUE, revision: 1, reviewFlag: true, tag: "noise-uniq-b" },
    { agent: NOISE_LITERALS[0]!, revision: 0, reviewFlag: false, tag: "noise-lit-0" },
    { agent: NOISE_LITERALS[1]!, revision: 1, reviewFlag: true, tag: "noise-lit-1" },
    { agent: NOISE_LITERALS[2]!, revision: 0, reviewFlag: false, tag: "noise-lit-2" },
  ];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, revision_count, review_flag, summary, cid)
      VALUES
        (NOW() - (${i + 1}::int * INTERVAL '1 minute'),
         ${row.agent},
         'feature'::core."TaskType",
         'done'::core."OutcomeResult",
         ${row.revision}::int,
         ${row.reviewFlag}::boolean,
         ${`impr-sig seed ${row.tag}`},
         ${`${SUITE_MARKER}-${row.tag}`})
    `;
  }
}

test("revision-distribution: registry gate excludes non-registry noise (MASTER ranking)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({
    method: "GET",
    url: "/api/agents/revision-distribution?days=7",
  });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as AgentRevisionDistributionResponse;

  // Only the canonical agent survives the gate — no noise token appears.
  for (const noise of ALL_NOISE) {
    assert.ok(
      !body.rows.some((r) => r.agent === noise),
      `non-registry token '${noise}' must be excluded from the ranking`,
    );
  }
  const canonRows = body.rows.filter((r) => r.agent === CANONICAL_AGENT);
  assert.ok(canonRows.length > 0, "canonical agent must be present");

  // Buckets: rev0 ×2 (rows a,b) → '0' count 2; rev2 ×1 (row c) → '2' count 1.
  const byBucket = new Map(canonRows.map((r) => [r.revision_bucket, r.occurrence_count]));
  assert.strictEqual(byBucket.get("0"), 2, "bucket '0' occurrence_count");
  assert.strictEqual(byBucket.get("2"), 1, "bucket '2' occurrence_count");
});

test("review-flag-by-agent: registry gate excludes non-registry noise (Health Index join)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({
    method: "GET",
    url: "/api/agents/review-flag-by-agent?days=7",
  });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as AgentReviewFlagByAgentResponse;

  for (const noise of ALL_NOISE) {
    assert.ok(
      !body.rows.some((r) => r.agent === noise),
      `non-registry token '${noise}' must be excluded from per-agent rows`,
    );
  }
  const canon = body.rows.find((r) => r.agent === CANONICAL_AGENT);
  assert.ok(canon !== undefined, "canonical agent must be present");
  // 3 'done' rows → denominator 3; 1 review-flagged.
  assert.strictEqual(canon.total_count, 3, "canonical total_count");
  assert.strictEqual(canon.review_flagged_count, 1, "canonical review_flagged_count");
});

test("review-flag-timeseries: gate excludes noise AND preserves gap-fill days (LEFT JOIN nuance)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const days = 7;
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/review-flag-timeseries?days=${days}`,
  });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as AgentReviewFlagTimeseriesResponse;

  // Gap-fill invariant — the membership predicate lives inside LEFT JOIN ... ON,
  // so every generate_series day is still emitted even when it matches zero
  // canonical rows. A top-level WHERE regression would drop empty days here.
  assert.strictEqual(body.rows.length, days, "all gap-fill days preserved");

  // Exclusion — the fixture registry is {canonical}, so the series counts ONLY
  // the 3 canonical rows; the 5 noise rows must not inflate the totals.
  const totalSum = body.rows.reduce((acc, r) => acc + r.total_count, 0);
  const reviewSum = body.rows.reduce((acc, r) => acc + r.review_flagged_count, 0);
  assert.strictEqual(totalSum, 3, "series counts only canonical rows (noise excluded)");
  assert.strictEqual(reviewSum, 1, "review-flagged count reflects canonical only");
});
