// Regression: the two `agent`-dimensioned breakage endpoints over core.outcomes
//   - GET /api/agents/failure-patterns  (T4 — top-N breakage ranking)
//   - GET /api/agents/failure-reasons   (T5 — keyword cause breakdown per agent)
// MUST apply the canonical registry-membership gate on the `agent` column. Before
// the fix non-registry noise (sentinels, cron parents, one-off cids, de-registered
// agents) could occupy a ranking slot / pollute the cause breakdown.
//
// Hermetic registry — AGENT_REGISTRY_PATH points at a fixture holding ONLY this
// suite's canonical agent (mirrors test/agents.improvement-signals.route.test.ts).
// Seeds are tagged by suite-unique cid, scrubbed via cid LIKE. Skips gracefully
// when the DB is unreachable.
//
// Runner: npx tsx --test test/agents.failure-gate.route.test.ts

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
  AgentFailurePatternsResponse,
  AgentFailureReasonsResponse,
} from "../src/server/types/agents.js";

const SUITE_MARKER = `failure-gate-${randomUUID().slice(0, 8)}`;
const CANONICAL_AGENT = `${SUITE_MARKER}-canon`;
const NOISE_UNIQUE = `${SUITE_MARKER}-noise`;
// Literal noise tokens mirroring real-world non-registry pollution.
const NOISE_LITERALS = ["subagent_stop_missing", "general-purpose", "cron:daemon-cycle"];
const ALL_NOISE = [NOISE_UNIQUE, ...NOISE_LITERALS];

// Canonical breakage make-up: 3 fail + 1 blocked = 4 total breakages.
const CANONICAL_FAIL_COUNT = 3;
const CANONICAL_TOTAL_BREAKAGES = 4;

interface BreakageSeed {
  agent: string;
  result: "fail" | "blocked";
  concern: string;
  tag: string;
}

const SEED_ROWS: ReadonlyArray<BreakageSeed> = [
  // canonical breakages (survive the gate)
  { agent: CANONICAL_AGENT, result: "fail", concern: "context window exceeded", tag: "canon-f0" },
  { agent: CANONICAL_AGENT, result: "fail", concern: "context window exceeded", tag: "canon-f1" },
  { agent: CANONICAL_AGENT, result: "fail", concern: "rate limit 429", tag: "canon-f2" },
  { agent: CANONICAL_AGENT, result: "blocked", concern: "tool exec failed", tag: "canon-b0" },
  // noise breakages (must be gated out of the ranking + cause breakdown)
  { agent: NOISE_UNIQUE, result: "fail", concern: "context window exceeded", tag: "noise-uniq-f0" },
  { agent: NOISE_UNIQUE, result: "fail", concern: "context window exceeded", tag: "noise-uniq-f1" },
  { agent: NOISE_LITERALS[0]!, result: "fail", concern: "parse error", tag: "noise-lit0-f" },
  { agent: NOISE_LITERALS[1]!, result: "blocked", concern: "deadline exceeded", tag: "noise-lit1-b" },
  { agent: NOISE_LITERALS[2]!, result: "fail", concern: "parse error", tag: "noise-lit2-f" },
];

// Registry fixture — CANONICAL_AGENT is the ONLY member.
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
  tmpRoot = await mkdtemp(join(tmpdir(), "failure-gate-registry-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerAgentsRoutes(app);
  await app.ready();

  try {
    await seedOutcomes();
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[failure-gate] DB seed failed — tests will skip:", error);
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
      console.error("[failure-gate cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

// Seed breakage rows today (inside the 7-day window). Distinct record_ts per row
// (minute offset) keeps outcomes_dedup UNIQUE(record_ts, agent, task_type) clear.
// concerns is a single-element text[] bound via ARRAY[$n]::text[] (parameterized —
// never string-concatenated) so the ranked_concerns CTE has non-empty input.
async function seedOutcomes(): Promise<void> {
  const prisma = getPrisma();
  for (let i = 0; i < SEED_ROWS.length; i++) {
    const row = SEED_ROWS[i]!;
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, concerns, summary, cid)
      VALUES
        (NOW() - (${i + 1}::int * INTERVAL '1 minute'),
         ${row.agent},
         'feature'::core."TaskType",
         ${row.result}::core."OutcomeResult",
         ARRAY[${row.concern}]::text[],
         ${`failure-gate seed ${row.tag}`},
         ${`${SUITE_MARKER}-${row.tag}`})
    `;
  }
}

test("failure-patterns: registry gate keeps noise out of the breakage ranking", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({ method: "GET", url: "/api/agents/failure-patterns?days=7" });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as AgentFailurePatternsResponse;

  for (const noise of ALL_NOISE) {
    assert.ok(
      !body.rows.some((r) => r.agent === noise),
      `non-registry token '${noise}' must not occupy a ranking slot`,
    );
  }
  const canon = body.rows.find((r) => r.agent === CANONICAL_AGENT);
  assert.ok(canon !== undefined, "canonical agent must be present");
  // 3 fail + 1 blocked = 4 breakages, all registry-scoped.
  assert.strictEqual(
    canon.total_breakages,
    CANONICAL_TOTAL_BREAKAGES,
    "canonical total_breakages (3 fail + 1 blocked)",
  );
  assert.strictEqual(canon.fail_count, 3, "canonical fail_count");
  assert.strictEqual(canon.blocked_count, 1, "canonical blocked_count");
  // ranked_concerns CTE is also gated (o.agent) → top_concerns populated from
  // the canonical breakage rows only.
  assert.ok(canon.top_concerns.length > 0, "canonical top_concerns populated");
});

test("failure-reasons: canonical agent → registry-scoped cause breakdown", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${encodeURIComponent(CANONICAL_AGENT)}&days=7&result=fail`,
  });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as AgentFailureReasonsResponse;
  // 3 fail rows survive the gate for the canonical agent.
  assert.strictEqual(
    body.meta.total_failures,
    CANONICAL_FAIL_COUNT,
    "canonical fail breakdown counts all 3 fail rows",
  );
  assert.ok(body.reasons.length > 0, "reasons emitted for the canonical agent");
});

test("failure-reasons: non-registry agent param → empty breakdown (gate blocks it)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  // NOISE_UNIQUE has 2 fail rows in the DB, but it is not in the registry, so the
  // membership gate (AND agent IN (registry)) makes the requested agent yield 0 rows.
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${encodeURIComponent(NOISE_UNIQUE)}&days=7&result=fail`,
  });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as AgentFailureReasonsResponse;
  assert.strictEqual(body.meta.total_failures, 0, "non-registry agent → zero breakages");
  assert.strictEqual(body.reasons.length, 0, "non-registry agent → no cause rows");
});
