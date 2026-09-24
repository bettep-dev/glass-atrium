// GET /api/agents/summary publishes the circuit-breaker fleet state (meta) and the
// per-agent state (item), and an unloaded registry never reads as a loaded zero.
// Hermetic registry + state dir; seeds tagged by suite-unique cid, skips without a DB.
//
// Runner: npx tsx --import ./test/lib/select-test-db.ts --test test/agents.circuit-breaker.route.test.ts

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { resetAgentRegistryCache } from "../src/server/agents/registry.js";
import { toCircuitBreakerKey } from "../src/server/agents/circuit-breaker.js";
import { registerAgentsRoutes } from "../src/server/routes/agents.js";
import type { AgentSummaryResponse } from "../src/server/types/agents.js";

const SUITE_MARKER = `cb-route-${randomUUID().slice(0, 8)}`;
const CB_AGENT = `${SUITE_MARKER}-agent`;
const STREAK_FAILS = 2;

let app: FastifyInstance;
let tmpRoot: string;
let registryPath: string;
let dbReady = false;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "cb-route-"));
  registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(
    registryPath,
    JSON.stringify({ $schema: "agent-registry", version: "1.1", agents: { [CB_AGENT]: { domains: ["test"] } } }),
    "utf8",
  );
  const stateDir = join(tmpRoot, "agent-circuit-breaker");
  await mkdir(stateDir);
  await writeFile(join(stateDir, `${toCircuitBreakerKey(CB_AGENT)}.fails`), `${STREAK_FAILS}\n`, "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  process.env.AGENT_CIRCUIT_BREAKER_DIR = stateDir;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerAgentsRoutes(app);
  await app.ready();

  try {
    await getPrisma().$executeRaw`
      INSERT INTO core.outcomes (record_ts, agent, task_type, result, summary, cid)
      VALUES (NOW() - INTERVAL '1 minute', ${CB_AGENT}, 'feature'::core."TaskType",
              'fail'::core."OutcomeResult", 'cb-route seed', ${`${SUITE_MARKER}-f0`})
    `;
    dbReady = true;
  } catch (error) {
    console.error("[cb-route] DB seed failed — tests will skip:", error);
  }
});

after(async () => {
  await app.close();
  if (dbReady) {
    await getPrisma().$executeRaw`DELETE FROM core.outcomes WHERE cid LIKE ${`${SUITE_MARKER}%`}`;
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  delete process.env.AGENT_CIRCUIT_BREAKER_DIR;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

test("summary publishes the fleet breaker state in meta and each agent's own state on its item", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({ method: "GET", url: "/api/agents/summary" });
  assert.equal(res.statusCode, 200);
  const body = res.json<AgentSummaryResponse>();

  const breaker = body.meta.circuit_breaker;
  assert.equal(breaker.source, "loaded");
  assert.equal(breaker.registry_agents, 1);
  assert.equal(breaker.streak_count, 1);
  assert.deepEqual(breaker.alarms.map((row) => row.agent), [CB_AGENT]);

  const item = body.agents.find((row) => row.agent_id === CB_AGENT);
  assert.ok(item, "the seeded agent has a summary item");
  assert.equal(item.circuit_breaker?.consecutive_fails, STREAK_FAILS);
  assert.equal(item.circuit_breaker?.suspended, false);
});

test("an unreadable registry publishes an unavailable breaker state, never a loaded zero", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  process.env.AGENT_REGISTRY_PATH = join(tmpRoot, "missing-registry.json");
  resetAgentRegistryCache();
  t.after(() => {
    process.env.AGENT_REGISTRY_PATH = registryPath;
    resetAgentRegistryCache();
  });

  const res = await app.inject({ method: "GET", url: "/api/agents/summary" });
  assert.equal(res.statusCode, 200);
  const breaker = res.json<AgentSummaryResponse>().meta.circuit_breaker;
  assert.equal(breaker.source, "unavailable");
  assert.deepEqual(breaker.alarms, []);
});
