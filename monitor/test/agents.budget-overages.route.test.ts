// GET /api/agents/budget-overages integration test (P17 near-cap badge route).
//
// Hermetic — the near-cap rollup is driven by rows seeded under a suite-unique
// agent_type marker (scoped away from live telemetry), so a fresh CI DB yields a
// deterministic per-agent aggregate rather than depending on ambient budget
// crossings. The source table (core.budget_overages) is raw-SQL (outside
// schema.prisma, created post-deploy by oss-db-setup.sh) — when it is absent the
// seed fails and the DB-gated tests skip gracefully (the route's own 503 → "no
// badge" degradation contract). The 400 validation tests need no DB.
//
// Runner: npx tsx --test test/agents.budget-overages.route.test.ts

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerAgentsRoutes } from "../src/server/routes/agents.js";
import type {
  AgentBudgetOveragesResponse,
  AgentsErrorBody,
} from "../src/server/types/agents.js";

// Suite-unique agent_type — scopes the seeded crossings so the per-agent_type
// GROUP BY rollup isolates this suite from any live budget_overages rows.
const MARKER_AGENT = `bo-test-${randomUUID().slice(0, 8)}`;

interface OverageSeed {
  crossedPct: number;
  dayOffset: number; // ts = now - dayOffset days
}

// In-window make-up: 3 crossings inside the 7d window (peak 110) + 1 stale row
// (40d back) that MUST be excluded by days=7. overage_count=3, max=110.
const IN_WINDOW_SEEDS: ReadonlyArray<OverageSeed> = [
  { crossedPct: 100, dayOffset: 0 },
  { crossedPct: 110, dayOffset: 1 },
  { crossedPct: 105, dayOffset: 2 },
];
const STALE_SEED: OverageSeed = { crossedPct: 200, dayOffset: 40 };

const EXPECTED_COUNT = IN_WINDOW_SEEDS.length;
const EXPECTED_MAX_PCT = Math.max(...IN_WINDOW_SEEDS.map((s) => s.crossedPct));

let app: FastifyInstance;
let dbReady = false;

before(async () => {
  app = Fastify({ logger: false });
  await registerAgentsRoutes(app);
  await app.ready();

  try {
    await seedOverages();
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[budget-overages] DB seed failed — DB tests will skip:", error);
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
        DELETE FROM core.budget_overages WHERE agent_type = ${MARKER_AGENT}
      `;
    } catch (error) {
      console.error("[budget-overages cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
});

// Seed crossings for MARKER_AGENT. crossed_pct/budget/tool_use_count bound as
// parameters (never string-concatenated). agent_id == agent_type mirrors the
// current cycle convention the FE badge join relies on.
async function seedOverages(): Promise<void> {
  const prisma = getPrisma();
  for (const seed of [...IN_WINDOW_SEEDS, STALE_SEED]) {
    await prisma.$executeRaw`
      INSERT INTO core.budget_overages
        (agent_id, agent_type, tool_use_count, budget, crossed_pct, ts)
      VALUES
        (${MARKER_AGENT}, ${MARKER_AGENT}, 44, 40, ${seed.crossedPct},
         NOW() - (${seed.dayOffset}::int * INTERVAL '1 day'))
    `;
  }
}

function findMarkerRow(body: AgentBudgetOveragesResponse) {
  return body.rows.find((r) => r.agent_type === MARKER_AGENT) ?? null;
}

test("days=7 → marker agent rolls up seeded crossings (count + peak pct)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({ method: "GET", url: "/api/agents/budget-overages?days=7" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AgentBudgetOveragesResponse;

  assert.strictEqual(body.days, 7);
  assert.ok(typeof body.fetched_at === "string" && body.fetched_at.length > 0);

  const row = findMarkerRow(body);
  assert.ok(row, `marker agent ${MARKER_AGENT} present in rollup`);
  // Stale (40d) row excluded → in-window count only.
  assert.strictEqual(row.overage_count, EXPECTED_COUNT, "in-window crossings only");
  assert.strictEqual(row.max_crossed_pct, EXPECTED_MAX_PCT, "peak crossed_pct");
  assert.ok(
    typeof row.latest_ts === "string" && row.latest_ts.length > 0,
    "latest_ts ISO string present",
  );
});

test("stale crossing (40d) stays excluded from the 7d window", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({ method: "GET", url: "/api/agents/budget-overages?days=7" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AgentBudgetOveragesResponse;
  const row = findMarkerRow(body);
  assert.ok(row);
  // The 200% stale row would raise max to 200 if it leaked into the window.
  assert.notStrictEqual(row.max_crossed_pct, STALE_SEED.crossedPct, "stale peak not surfaced");
});

test("days=90 widens the window to include the stale crossing", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({ method: "GET", url: "/api/agents/budget-overages?days=90" });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AgentBudgetOveragesResponse;
  const row = findMarkerRow(body);
  assert.ok(row);
  assert.strictEqual(row.overage_count, EXPECTED_COUNT + 1, "stale row now in window");
  assert.strictEqual(row.max_crossed_pct, STALE_SEED.crossedPct, "stale peak now surfaced");
});

// Validation — 400 path returns before any DB access → no dbReady guard needed.
test("days out-of-range → 400 invalid_days", async () => {
  const res = await app.inject({ method: "GET", url: "/api/agents/budget-overages?days=999" });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as AgentsErrorBody;
  assert.strictEqual(body.error, "invalid_days");
  if (body.error === "invalid_days") {
    assert.ok(Array.isArray(body.allowed) && body.allowed.includes(7));
  }
});

test("missing days param → 400 invalid_days (days is required)", async () => {
  const res = await app.inject({ method: "GET", url: "/api/agents/budget-overages" });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as AgentsErrorBody;
  assert.strictEqual(body.error, "invalid_days");
});
