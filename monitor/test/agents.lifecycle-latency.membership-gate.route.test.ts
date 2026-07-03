// Regression: the two agent_type-dimensioned endpoints over core.agent_events
//   - GET /api/agents/latency          (T2 — p50/p95/p99 "Response time")
//   - GET /api/agents/lifecycle-stats  (T3 — Start/Stop counts + durations)
// MUST apply the canonical registry-membership gate on the agent_type column.
// Before the fix they folded in non-registry spawn noise (Claude Code built-ins
// general-purpose / Explore, plugin agents, sentinels like subagent_stop_missing).
//
// Hermetic registry — AGENT_REGISTRY_PATH points at a fixture holding ONLY this
// suite's canonical agent, so the gate reduces every endpoint to that agent
// alone; the seeded non-registry tokens then prove exclusion deterministically
// (uuid-unique agent name → no collision with concurrent sessions).
//
// DB: real Postgres. agent_events has no cid column, so seeds are tagged by a
// suite-unique agent_id prefix and scrubbed via agent_id LIKE (mirrors
// test/outcomes.attribution-daily.route.test.ts backing-event scrub). Skips
// gracefully when the DB is unreachable.
//
// Runner: npx tsx --test test/agents.lifecycle-latency.membership-gate.route.test.ts

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
  AgentLatencyResponse,
  AgentLifecycleStatsResponse,
} from "../src/server/types/agents.js";

const SUITE_MARKER = `lc-lat-gate-${randomUUID().slice(0, 8)}`;
const CANONICAL_AGENT = `${SUITE_MARKER}-canon`;
const NOISE_UNIQUE = `${SUITE_MARKER}-noise`;
// Literal noise tokens mirroring the real-world non-registry agent_type pollution
// the fix targets (Claude Code built-ins + the attribution sentinel).
const NOISE_LITERALS = ["general-purpose", "Explore", "subagent_stop_missing"];
const ALL_NOISE = [NOISE_UNIQUE, ...NOISE_LITERALS];

// Each seeded agent_type gets this many Start↔Stop invocations.
const INVOCATIONS_PER_AGENT = 2;

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
  tmpRoot = await mkdtemp(join(tmpdir(), "lc-lat-registry-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerAgentsRoutes(app);
  await app.ready();

  try {
    await seedAgentEvents();
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[lc-lat-gate] DB seed failed — tests will skip:", error);
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
        DELETE FROM core.agent_events WHERE agent_id LIKE ${`%${SUITE_MARKER}%`}
      `;
    } catch (error) {
      console.error("[lc-lat-gate cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

// Seed 2 paired invocations per agent_type (canonical + every noise token). Each
// invocation = a distinct agent_id carrying one SubagentStart + one SubagentStop
// (5-minute duration). All event_ts land within today → inside every window.
// A global minute counter keeps event_ts distinct (agent_events_dedup UNIQUE
// (event_ts, agent_id, event_name) — agent_id already distinct per invocation).
async function seedAgentEvents(): Promise<void> {
  const prisma = getPrisma();
  const agentTypes = [CANONICAL_AGENT, ...ALL_NOISE];
  let minute = 1;
  for (const agentType of agentTypes) {
    for (let inv = 0; inv < INVOCATIONS_PER_AGENT; inv++) {
      const agentId = `${SUITE_MARKER}-evt-${inv}-${minute}`;
      const stopMinutesAgo = minute;
      const startMinutesAgo = minute + 5; // earlier in wall-clock → larger offset
      minute += 10;
      await prisma.$executeRaw`
        INSERT INTO core.agent_events (event_ts, event_name, agent_id, agent_type)
        VALUES
          (NOW() - (${startMinutesAgo}::int * INTERVAL '1 minute'),
           'SubagentStart',
           ${agentId},
           ${agentType})
      `;
      await prisma.$executeRaw`
        INSERT INTO core.agent_events (event_ts, event_name, agent_id, agent_type)
        VALUES
          (NOW() - (${stopMinutesAgo}::int * INTERVAL '1 minute'),
           'SubagentStop',
           ${agentId},
           ${agentType})
      `;
    }
  }
}

test("latency: registry gate excludes non-registry agent_type noise, retains canonical", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({ method: "GET", url: "/api/agents/latency?days=7" });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as AgentLatencyResponse;

  for (const noise of ALL_NOISE) {
    assert.ok(
      !body.agents.some((a) => a.agent_name === noise || a.agent_id === noise),
      `non-registry agent_type '${noise}' must be excluded from latency percentiles`,
    );
  }
  const canon = body.agents.find((a) => a.agent_name === CANONICAL_AGENT);
  assert.ok(canon !== undefined, "canonical agent must be present");
  // Single-agent fixture registry → the gate collapses the response to exactly
  // the canonical agent (every real agent_type is also gated out).
  assert.ok(
    body.agents.every((a) => a.agent_name === CANONICAL_AGENT),
    "only the canonical agent survives the single-agent registry gate",
  );
  // Paired invocation duration ≈ 5 min (300000 ms). The Start/Stop rows are
  // inserted in separate statements, so NOW() drifts a few ms between them —
  // assert a tolerance band, not an exact value (the gate contract is membership).
  assert.ok(canon.p50_ms !== null, "canonical has a paired latency percentile");
  assert.ok(
    Math.abs(canon.p50_ms - 300000) < 5000,
    `canonical p50 ≈ 5min paired duration (got ${canon.p50_ms})`,
  );
});

test("lifecycle-stats: gate excludes noise; start_count and completed_count both registry-scoped", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({ method: "GET", url: "/api/agents/lifecycle-stats?days=7" });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as AgentLifecycleStatsResponse;

  for (const noise of ALL_NOISE) {
    assert.ok(
      !body.rows.some((r) => r.agent_type === noise),
      `non-registry agent_type '${noise}' must be excluded from lifecycle rows`,
    );
  }
  const canon = body.rows.find((r) => r.agent_type === CANONICAL_AGENT);
  assert.ok(canon !== undefined, "canonical agent must be present");
  // 2 invocations → 2 Start + 2 Stop events, both paired (duration >= 0). Gating
  // BOTH source CTEs (per_type_counts + per_agent_id) keeps start_count consistent
  // with completed_count — a one-sided gate would let one diverge on noise rows.
  assert.strictEqual(canon.start_count, 2, "canonical start_count (per_type_counts)");
  assert.strictEqual(canon.stop_count, 2, "canonical stop_count (per_type_counts)");
  assert.strictEqual(canon.completed_count, 2, "canonical completed_count (duration chain)");
});
