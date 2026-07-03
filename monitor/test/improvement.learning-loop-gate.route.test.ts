// T10 registry-membership gating for the two orphan-table read surfaces:
//   - GET /api/improvement/learning-log  (core.learning_log)
//   - GET /api/improvement/loop-events   (core.autoagent_loop_events)
//
// The gate is applied CONSISTENTLY across every query per feed (total + status/
// result distribution + list), so the rendered KPI totals AGREE with the
// registry-scoped list (no total≠list mismatch).
//
// Hermetic registry — AGENT_REGISTRY_PATH points at a fixture holding ONLY this
// suite's canonical agent (uuid-unique), so the gate collapses each feed to that
// agent; seeded noise + a NULL-agent learning_log row prove exclusion.
//
// T10 has NO existing seed precedent for these two tables, so this suite ships
// FRESH seeders. learning_log is scrubbed by suite-marker pattern_signature LIKE;
// autoagent_loop_events carries no marker column (noise agents are shared
// literals), so its rows are tracked by RETURNING id and deleted by id — never a
// timestamp-window scrub that could delete production rows.
//
// DB: real Postgres. Skips gracefully when unreachable.
//
// Runner: npx tsx --test test/improvement.learning-loop-gate.route.test.ts

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

const SUITE_MARKER = `impr-llgate-${randomUUID().slice(0, 8)}`;
const CANONICAL_AGENT = `${SUITE_MARKER}-canon`;
const NOISE_UNIQUE = `${SUITE_MARKER}-noise`;
const NOISE_LITERALS = ["orchestrator", "subagent_stop_missing", "cron:daemon-cycle"];
const ALL_NOISE = [NOISE_UNIQUE, ...NOISE_LITERALS];

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
// autoagent_loop_events has no scrub-marker column → track inserted ids.
const loopEventIds: bigint[] = [];

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "impr-llgate-registry-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerImprovementRoutes(app);
  await app.ready();

  try {
    await seedLearningLog();
    await seedLoopEvents();
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[impr-llgate] DB seed failed — tests will skip:", error);
  }
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  if (dbReady) {
    const prisma = getPrisma();
    try {
      await prisma.$executeRaw`
        DELETE FROM core.learning_log WHERE pattern_signature LIKE ${`%${SUITE_MARKER}%`}
      `;
      for (const id of loopEventIds) {
        await prisma.$executeRaw`DELETE FROM core.autoagent_loop_events WHERE id = ${id}`;
      }
    } catch (error) {
      console.error("[impr-llgate cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

// learning_log: 2 canonical + one row per noise token + a NULL-agent row. All
// discovered_date = CURRENT_DATE (inside the 7-day list window). pattern_signature
// carries the suite marker (UNIQUE @@unique([pattern_signature])). status ∈
// LearningStatus, approval_tier ∈ ApprovalTier (enum casts).
async function seedLearningLog(): Promise<void> {
  const prisma = getPrisma();
  const rows: Array<{ agent: string | null; tag: string }> = [
    { agent: CANONICAL_AGENT, tag: "canon-a" },
    { agent: CANONICAL_AGENT, tag: "canon-b" },
    ...ALL_NOISE.map((a, i) => ({ agent: a, tag: `noise-${i}` })),
    { agent: null, tag: "null-agent" },
  ];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    await prisma.$executeRaw`
      INSERT INTO core.learning_log
        (discovered_date, pattern_signature, frequency, agent, status, approval_tier, last_updated)
      VALUES
        (CURRENT_DATE,
         ${`${SUITE_MARKER}-sig-${i}`},
         ${i + 1}::int,
         ${row.agent},
         'identified'::core."LearningStatus",
         'auto'::core."ApprovalTier",
         NOW())
    `;
  }
}

// autoagent_loop_events: 2 canonical + one row per noise token. agent is NOT NULL.
// eval_result is free-text VarChar(32) (mirror daemon-emitted values). Dedup
// UNIQUE is (event_ts, agent, eval_result) → vary event_ts per row. RETURNING id
// so cleanup deletes precisely (no window scrub that could hit production).
async function seedLoopEvents(): Promise<void> {
  const prisma = getPrisma();
  const rows: Array<{ agent: string; result: string }> = [
    { agent: CANONICAL_AGENT, result: "applied" },
    { agent: CANONICAL_AGENT, result: "rejected" },
    ...ALL_NOISE.map((a) => ({ agent: a, result: "skipped" })),
  ];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const inserted = await prisma.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO core.autoagent_loop_events
        (event_ts, agent, rice, eval_result, changes_added, changes_removed)
      VALUES
        (NOW() - (${i}::int * INTERVAL '1 minute'),
         ${row.agent}, NULL, ${row.result}, ${i}::int, 0)
      RETURNING id
    `;
    const created = inserted[0];
    if (created !== undefined) {
      loopEventIds.push(created.id);
    }
  }
}

test("T10 learning-log: list + total + status-dist registry-gated (NULL-agent + noise excluded)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({ method: "GET", url: "/api/improvement/learning-log?limit=200" });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as {
    total_patterns: number;
    patterns: Array<{ agent: string | null }>;
    status_distribution: Array<{ count: number }>;
  };

  for (const noise of ALL_NOISE) {
    assert.ok(
      !body.patterns.some((p) => p.agent === noise),
      `non-registry agent '${noise}' must be excluded from learning-log patterns`,
    );
  }
  assert.ok(
    !body.patterns.some((p) => p.agent === null),
    "NULL-agent pattern must be excluded (not a registry agent)",
  );
  const canon = body.patterns.filter((p) => p.agent === CANONICAL_AGENT);
  assert.strictEqual(canon.length, 2, "exactly the 2 canonical patterns present");

  // Consistent gating (not list-only): total + status-dist agree with the list.
  assert.strictEqual(body.total_patterns, 2, "total_patterns registry-scoped (agrees with list)");
  const distSum = body.status_distribution.reduce((acc, r) => acc + r.count, 0);
  assert.strictEqual(distSum, 2, "status_distribution registry-scoped (agrees with total)");
});

test("T10 loop-events: event-list + total + result-dist registry-gated (noise excluded)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({ method: "GET", url: "/api/improvement/loop-events?limit=200" });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  const body = res.json() as {
    total_events: number;
    events: Array<{ agent: string }>;
    result_distribution: Array<{ eval_result: string; count: number }>;
  };

  for (const noise of ALL_NOISE) {
    assert.ok(
      !body.events.some((e) => e.agent === noise),
      `non-registry agent '${noise}' must be excluded from loop-events`,
    );
  }
  const canon = body.events.filter((e) => e.agent === CANONICAL_AGENT);
  assert.strictEqual(canon.length, 2, "exactly the 2 canonical events present");

  // Consistent gating (not list-only): total + result-dist agree with the list.
  assert.strictEqual(body.total_events, 2, "total_events registry-scoped (agrees with list)");
  const distSum = body.result_distribution.reduce((acc, r) => acc + r.count, 0);
  assert.strictEqual(distSum, 2, "result_distribution registry-scoped (agrees with total)");
});
