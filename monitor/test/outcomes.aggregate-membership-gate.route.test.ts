// Regression: two GET /api/outcomes/* aggregate surfaces closing the
// registry-membership gap left after T6/T7 (outcomes.registry-gate.route.test.ts)
// applied ONLY to cross-analysis by_agent_top_10 + /search — the cross-analysis
// by_result sibling scenario now lives solely in
// outcomes.registry-gate.route.test.ts (T6, "sibling by_result is
// registry-scoped by default") —
//   (1) /heatmap — no agent/q filter exists on this endpoint, so exclusion is
//       proven via a before/after seed-count delta.
//   (2) /attribution-daily — same delta approach; a non-registry agent's row
//       must not move the days_series total.
//
// Hermetic registry — AGENT_REGISTRY_PATH points at a fixture holding ONLY
// this suite's canonical agent (uuid-unique), so the gate collapses every
// gated surface to that agent alone.
//
// DB: real Postgres. Every seed row carries SUITE_MARKER in summary/cid.
// Skips gracefully when the DB is unreachable.
//
// Runner: npx tsx --test test/outcomes.aggregate-membership-gate.route.test.ts

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { resetAgentRegistryCache } from "../src/server/agents/registry.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerOutcomesRoutes } from "../src/server/routes/outcomes.js";
import type {
  AttributionDailyResponse,
  OutcomeHeatmapResponse,
} from "../src/server/types/outcomes.js";

const SUITE_MARKER = `outcomes-agg-gate-${randomUUID().slice(0, 8)}`;
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
  tmpRoot = await mkdtemp(join(tmpdir(), "outcomes-agg-gate-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerOutcomesRoutes(app);
  await app.ready();

  try {
    await getPrisma().$queryRaw`SELECT 1`;
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[outcomes-agg-gate-test] DB unreachable — tests will skip:", error);
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
      console.error("[outcomes-agg-gate-test cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── (1) heatmap — no filter param, proven via before/after seed delta ──────

test("heatmap: total_count delta counts only the canonical row, not the noise row", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const prisma = getPrisma();
  const tag = `${SUITE_MARKER}-hm`;

  const before1 = await app.inject({ method: "GET", url: "/api/outcomes/heatmap?days=1" });
  assert.strictEqual(before1.statusCode, 200);
  const beforeTotal = (before1.json() as OutcomeHeatmapResponse).meta.total_count;

  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, poisoned_window, cid)
    VALUES
      (NOW(), ${CANONICAL_AGENT}, 'feature'::core."TaskType", 'done'::core."OutcomeResult",
       ${`hm seed ${tag} canon`}, FALSE, ${`${tag}-canon`})
  `;
  const afterCanon = await app.inject({ method: "GET", url: "/api/outcomes/heatmap?days=1" });
  const afterCanonTotal = (afterCanon.json() as OutcomeHeatmapResponse).meta.total_count;
  assert.strictEqual(afterCanonTotal - beforeTotal, 1, "canonical row increments total_count by 1");

  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, poisoned_window, cid)
    VALUES
      (NOW() - INTERVAL '1 second', ${NOISE_AGENT}, 'feature'::core."TaskType", 'done'::core."OutcomeResult",
       ${`hm seed ${tag} noise`}, FALSE, ${`${tag}-noise`})
  `;
  const afterNoise = await app.inject({ method: "GET", url: "/api/outcomes/heatmap?days=1" });
  const afterNoiseTotal = (afterNoise.json() as OutcomeHeatmapResponse).meta.total_count;
  assert.strictEqual(afterNoiseTotal - afterCanonTotal, 0, "noise row does NOT move total_count");
});

// ── (2) attribution-daily — outer WHERE gate, delta over days_series totals ─

test("attribution-daily: days_series total delta counts only the canonical row", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const prisma = getPrisma();
  const tag = `${SUITE_MARKER}-attr`;

  async function sumTotal(): Promise<number> {
    const res = await app.inject({ method: "GET", url: "/api/outcomes/attribution-daily?days=7" });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json() as AttributionDailyResponse;
    return body.days_series.reduce((acc, p) => acc + p.total, 0);
  }

  const before1 = await sumTotal();

  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, attribution_source, poisoned_window, cid)
    VALUES
      (NOW(), ${CANONICAL_AGENT}, 'feature'::core."TaskType", 'done'::core."OutcomeResult",
       ${`attr seed ${tag} canon`}, 'hook-input', FALSE, ${`${tag}-canon`})
  `;
  const afterCanon = await sumTotal();
  assert.strictEqual(afterCanon - before1, 1, "canonical row increments days_series total by 1");

  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, attribution_source, poisoned_window, cid)
    VALUES
      (NOW() - INTERVAL '1 second', ${NOISE_AGENT}, 'feature'::core."TaskType", 'done'::core."OutcomeResult",
       ${`attr seed ${tag} noise`}, 'hook-input', FALSE, ${`${tag}-noise`})
  `;
  const afterNoise = await sumTotal();
  assert.strictEqual(afterNoise - afterCanon, 0, "noise row does NOT move days_series total");
});
