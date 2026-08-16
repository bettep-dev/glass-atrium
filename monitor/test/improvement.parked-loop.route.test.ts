// T9 — parked-loop state on GET /api/improvement/learning-log.
//
// The repeat-apply cap terminalizes a learning_log pattern and never self re-arms, so
// a capped pattern parks the loop until a human resets its status. The route must
// report how many patterns are parked — NOT how many patterns exist.
//
// Discrimination: every fixture carries a NON-capped control population, so an
// implementation counting all pattern rows returns the wrong number and fails. The
// K=0 case additionally fails any implementation that renders a constant hint.
//
// Hermetic registry — AGENT_REGISTRY_PATH points at a fixture holding only this
// suite's agents, so the registry gate collapses the count to the seeded rows.
//
// DB: real Postgres. Skips gracefully when unreachable.
//
// Runner: npx tsx --test test/improvement.parked-loop.route.test.ts

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

const SUITE_MARKER = `impr-parked-${randomUUID().slice(0, 8)}`;
const AGENT_A = `${SUITE_MARKER}-a`;
const AGENT_B = `${SUITE_MARKER}-b`;

// Verbatim opening literal of daemon_cycle.py APPLY_CAP_REASON_TEMPLATE. Hardcoded
// here on purpose: if the daemon's stamp changes, this suite must go red rather than
// silently track the route's own copy of the prefix.
const CAP_REASON =
  "repeat-apply cap: 3 applied proposals (cap 3) did NOT abate the signal";
// A terminal 'rejected' transition that is NOT a cap — the control that stops a
// status-only implementation from passing.
const NON_CAP_REASON = "superseded by a later pattern";

const REGISTRY_FIXTURE = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    [AGENT_A]: { domains: ["test"], phase: "implementation", dual_phase: false },
    [AGENT_B]: { domains: ["test"], phase: "implementation", dual_phase: false },
  },
};

interface ApplyCapState {
  capped_patterns: number;
  capped_agents: number;
  rearm_hint: string | null;
}

interface LearningLogBody {
  total_patterns: number;
  apply_cap_state: ApplyCapState;
}

let app: FastifyInstance;
let tmpRoot: string;
let dbReady = false;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "impr-parked-registry-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerImprovementRoutes(app);
  await app.ready();

  try {
    await seedLearningLog();
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[impr-parked] DB seed failed — tests will skip:", error);
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
      await getPrisma().$executeRaw`
        DELETE FROM core.learning_log WHERE pattern_signature LIKE ${`%${SUITE_MARKER}%`}
      `;
    } catch (error) {
      console.error("[impr-parked cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

// 6 patterns, none capped at seed time: 4 'identified' plus 2 terminal 'rejected'
// rows carrying a non-cap transition reason. The two rejected rows are the control
// that separates "capped" from "terminal for some other reason".
async function seedLearningLog(): Promise<void> {
  const prisma = getPrisma();
  const rows: Array<{ agent: string; status: string; reason: string | null }> = [
    { agent: AGENT_A, status: "identified", reason: null },
    { agent: AGENT_A, status: "identified", reason: null },
    { agent: AGENT_B, status: "identified", reason: null },
    { agent: AGENT_B, status: "identified", reason: null },
    { agent: AGENT_A, status: "rejected", reason: NON_CAP_REASON },
    { agent: AGENT_B, status: "rejected", reason: NON_CAP_REASON },
  ];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    await prisma.$executeRaw`
      INSERT INTO core.learning_log
        (discovered_date, pattern_signature, frequency, agent, status, approval_tier,
         last_updated, last_transition_reason)
      VALUES
        (CURRENT_DATE,
         ${`${SUITE_MARKER}-sig-${i}`},
         ${i + 1}::int,
         ${row.agent},
         ${row.status}::core."LearningStatus",
         'auto'::core."ApprovalTier",
         NOW(),
         ${row.reason})
    `;
  }
}

// Terminalize one seeded pattern with the daemon's own cap stamp.
async function capPattern(index: number): Promise<void> {
  await getPrisma().$executeRaw`
    UPDATE core.learning_log
    SET status = 'rejected'::core."LearningStatus",
        last_transition_reason = ${CAP_REASON},
        last_transition_at = NOW()
    WHERE pattern_signature = ${`${SUITE_MARKER}-sig-${index}`}
  `;
}

async function fetchState(): Promise<LearningLogBody> {
  const res = await app.inject({
    method: "GET",
    url: "/api/improvement/learning-log?limit=200",
  });
  assert.strictEqual(res.statusCode, 200, "must be 200");
  return res.json() as LearningLogBody;
}

test("K=0: nothing capped → zero count and no re-arm hint (non-capped population present)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const body = await fetchState();
  assert.strictEqual(body.total_patterns, 6, "the non-capped control population exists");
  assert.strictEqual(body.apply_cap_state.capped_patterns, 0, "no pattern is capped");
  assert.strictEqual(body.apply_cap_state.capped_agents, 0, "no agent is parked");
  assert.strictEqual(
    body.apply_cap_state.rearm_hint,
    null,
    "the hint must be absent at K=0 — a constant string would fail here",
  );
});

test("K=2: capped count is the capped subset, not the pattern total", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  await capPattern(0); // AGENT_A
  await capPattern(2); // AGENT_B
  const body = await fetchState();
  assert.strictEqual(body.apply_cap_state.capped_patterns, 2, "exactly K=2 capped");
  assert.notStrictEqual(
    body.apply_cap_state.capped_patterns,
    body.total_patterns,
    "a count over every pattern row must not satisfy this",
  );
  assert.strictEqual(body.apply_cap_state.capped_agents, 2, "two distinct agents parked");
  assert.ok(
    typeof body.apply_cap_state.rearm_hint === "string" &&
      body.apply_cap_state.rearm_hint.includes("identified"),
    "re-arm instruction present when K>0",
  );
});

test("K=3: a second cap on one agent moves the pattern count, not the agent count", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  await capPattern(1); // AGENT_A again
  const body = await fetchState();
  assert.strictEqual(body.apply_cap_state.capped_patterns, 3, "K=3 capped patterns");
  assert.strictEqual(
    body.apply_cap_state.capped_agents,
    2,
    "still two parked agents — patterns and agents are counted separately",
  );
});

test("a terminal 'rejected' row without the cap stamp is never counted as parked", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const body = await fetchState();
  // Rows 4 and 5 are 'rejected' with a non-cap reason and stay outside the count:
  // 3 capped of 5 rejected.
  assert.strictEqual(
    body.apply_cap_state.capped_patterns,
    3,
    "status alone must not qualify a row as capped",
  );
});
