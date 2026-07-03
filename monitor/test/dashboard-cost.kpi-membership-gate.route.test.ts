// Regression: GET /api/dashboard/kpi (fail_count_24h/blocked_count_24h) and
// GET /api/cost/kpi (done_count_7d) — the monitor landing-page KPI band and the
// cost_per_done_usd ratio's denominator — both closed a registry-membership gap
// (neither had an `agent` filter to scope explicitly, so exclusion is proven via
// a before/after seed-count delta, mirroring the heatmap/attribution-daily
// pattern in outcomes.aggregate-membership-gate.route.test.ts).
//
// Hermetic registry — AGENT_REGISTRY_PATH points at a fixture holding ONLY this
// suite's canonical agent (uuid-unique), so the gate collapses each KPI to that
// agent alone.
//
// DB: real Postgres. Every seed row carries SUITE_MARKER in cid. Skips
// gracefully when the DB is unreachable.
//
// Runner: npx tsx --test test/dashboard-cost.kpi-membership-gate.route.test.ts

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { resetAgentRegistryCache } from "../src/server/agents/registry.js";
import { registerCostRoutes } from "../src/server/routes/cost.js";
import { registerDashboardRoutes } from "../src/server/routes/dashboard.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import type { CostKpiResponse } from "../src/server/types/cost.js";
import type { KpiResponse } from "../src/server/types/dashboard.js";

const SUITE_MARKER = `dc-kpi-gate-${randomUUID().slice(0, 8)}`;
const CANONICAL_AGENT = `${SUITE_MARKER}-canon`;
const NOISE_AGENT = `${SUITE_MARKER}-noise`;

const REGISTRY_FIXTURE = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    [CANONICAL_AGENT]: { domains: ["test"], phase: "implementation", dual_phase: false },
  },
};

let app: FastifyInstance;
let tmpRoot: string;
let dbReady = false;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "dc-kpi-gate-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerDashboardRoutes(app);
  await registerCostRoutes(app);
  await app.ready();

  try {
    await getPrisma().$queryRaw`SELECT 1`;
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[dc-kpi-gate-test] DB unreachable — tests will skip:", error);
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
      console.error("[dc-kpi-gate-test cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

test("dashboard KPI: fail_count_24h delta counts only the canonical row", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const prisma = getPrisma();
  const tag = `${SUITE_MARKER}-dash`;

  async function fetchFailCount(): Promise<number> {
    const res = await app.inject({ method: "GET", url: "/api/dashboard/kpi" });
    assert.strictEqual(res.statusCode, 200);
    return (res.json() as KpiResponse).fail_count_24h;
  }

  const before1 = await fetchFailCount();

  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, poisoned_window, cid)
    VALUES
      (NOW(), ${CANONICAL_AGENT}, 'feature'::core."TaskType", 'fail'::core."OutcomeResult",
       ${`dash seed ${tag} canon`}, FALSE, ${`${tag}-canon`})
  `;
  const afterCanon = await fetchFailCount();
  assert.strictEqual(afterCanon - before1, 1, "canonical fail row increments fail_count_24h by 1");

  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, poisoned_window, cid)
    VALUES
      (NOW() - INTERVAL '1 second', ${NOISE_AGENT}, 'feature'::core."TaskType", 'fail'::core."OutcomeResult",
       ${`dash seed ${tag} noise`}, FALSE, ${`${tag}-noise`})
  `;
  const afterNoise = await fetchFailCount();
  assert.strictEqual(afterNoise - afterCanon, 0, "noise fail row does NOT move fail_count_24h");
});

test("cost KPI: done_count_7d delta counts only the canonical row", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const prisma = getPrisma();
  const tag = `${SUITE_MARKER}-cost`;

  async function fetchDoneCount(): Promise<number> {
    const res = await app.inject({ method: "GET", url: "/api/cost/kpi" });
    assert.strictEqual(res.statusCode, 200);
    return (res.json() as CostKpiResponse).done_count_7d;
  }

  const before1 = await fetchDoneCount();

  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, poisoned_window, cid)
    VALUES
      (NOW(), ${CANONICAL_AGENT}, 'feature'::core."TaskType", 'done'::core."OutcomeResult",
       ${`cost seed ${tag} canon`}, FALSE, ${`${tag}-canon`})
  `;
  const afterCanon = await fetchDoneCount();
  assert.strictEqual(afterCanon - before1, 1, "canonical done row increments done_count_7d by 1");

  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, poisoned_window, cid)
    VALUES
      (NOW() - INTERVAL '1 second', ${NOISE_AGENT}, 'feature'::core."TaskType", 'done'::core."OutcomeResult",
       ${`cost seed ${tag} noise`}, FALSE, ${`${tag}-noise`})
  `;
  const afterNoise = await fetchDoneCount();
  assert.strictEqual(afterNoise - afterCanon, 0, "noise done row does NOT move done_count_7d");
});
