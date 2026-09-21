// GET /api/improvement/loop-events — the deterministic ordering of the event list.
//
// The relationship pinned: within one event_ts the route returns rows id DESC, and
// across event_ts it returns them event_ts DESC — so the whole list is a total order
// no scan plan can permute. Without the tie-break the route orders on event_ts alone
// and the within-instant order is whatever the plan yields.
//
// Scope: ordering only. The two production rows that share an event_ts stay double-
// counted in total_events and result_distribution; a tie-break fixes their ORDER and
// nothing else.
//
// Hermetic registry — AGENT_REGISTRY_PATH holds ONLY this suite's uuid-unique agent,
// so the T10 membership gate collapses the feed to the seeded rows and a concurrent
// production write cannot interleave with them.
//
// autoagent_loop_events carries no scrub-marker column, so rows are tracked by
// RETURNING id and deleted by id — never a timestamp-window scrub.
//
// DB: real Postgres. Skips gracefully when unreachable.
//
// Runner: npx tsx --test test/improvement.loop-events.route.test.ts

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

// Only the two ordering keys are read back — the payload's other columns are pinned
// by improvement.learning-loop-gate.route.test.ts.
interface LoopEventPayloadRow {
  id: number;
  event_ts: string;
}

interface LoopEventPayload {
  events: LoopEventPayloadRow[];
}

const SUITE_MARKER = `impr-loopev-${randomUUID().slice(0, 8)}`;
const CANONICAL_AGENT = `${SUITE_MARKER}-canon`;

const REGISTRY_FIXTURE = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    [CANONICAL_AGENT]: { domains: ["test"], phase: "implementation", dual_phase: false },
  },
};

// Far-future sentinel instants: a production emitter writes a real cycle time, so
// these can never collide with one. OLDER/NEWER differ so the event_ts leg is also
// exercised; the within-instant leg needs 3 rows on ONE instant.
const SUITE_HOURS = Number.parseInt(SUITE_MARKER.slice(-4), 16) % 20;
const NEWER_TS = `2999-01-02T${String(SUITE_HOURS).padStart(2, "0")}:00:00.000Z`;
const OLDER_TS = `2999-01-01T${String(SUITE_HOURS).padStart(2, "0")}:00:00.000Z`;

// Distinct eval_result per row on the shared instant: the census partial unique is
// (event_ts, agent, eval_result) WHERE subject IS NULL, so equal tokens would
// collapse three seeds into one row and the ordering claim would be vacuous.
const SHARED_INSTANT_RESULTS = ["verified", "reject", "unverified"] as const;

let app: FastifyInstance;
let tmpRoot: string;
let dbReady = false;
const seededIds: bigint[] = [];
// Insertion order of the three shared-instant rows — ids ascend with it.
const sharedInstantIds: bigint[] = [];

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "impr-loopev-registry-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerImprovementRoutes(app);
  await app.ready();

  try {
    await seedLoopEvents();
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[impr-loopev] DB seed failed — tests will skip:", error);
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
      for (const id of seededIds) {
        await prisma.$executeRaw`DELETE FROM core.autoagent_loop_events WHERE id = ${id}`;
      }
    } catch (error) {
      console.error("[impr-loopev cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

// One row on the older instant + three on the newer one. subject is left NULL, so
// every seeded row is census class and the census arm is the unique in play.
async function seedLoopEvents(): Promise<void> {
  await insertEvent(OLDER_TS, "verified");
  for (const result of SHARED_INSTANT_RESULTS) {
    sharedInstantIds.push(await insertEvent(NEWER_TS, result));
  }
}

async function insertEvent(eventTs: string, evalResult: string): Promise<bigint> {
  const prisma = getPrisma();
  const inserted = await prisma.$queryRaw<Array<{ id: bigint }>>`
    INSERT INTO core.autoagent_loop_events
      (event_ts, agent, rice, eval_result, changes_added, changes_removed)
    VALUES (${eventTs}::timestamptz, ${CANONICAL_AGENT}, NULL, ${evalResult}, 0, 0)
    RETURNING id
  `;
  const created = inserted[0];
  if (created === undefined) throw new Error(`seed insert returned no id for ${evalResult}`);
  seededIds.push(created.id);
  return created.id;
}

async function fetchEvents(query = "?limit=200"): Promise<LoopEventPayload> {
  const res = await app.inject({ method: "GET", url: `/api/improvement/loop-events${query}` });
  assert.strictEqual(res.statusCode, 200, "must be 200 — the route must exist and answer");
  return res.json() as LoopEventPayload;
}

test("loop-events: rows sharing an event_ts come back id DESC", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const body = await fetchEvents();

  const ids = body.events.filter((e) => e.event_ts === NEWER_TS).map((e) => e.id);
  assert.strictEqual(ids.length, sharedInstantIds.length, "all three shared-instant rows must be present");
  const expected = [...sharedInstantIds].map(Number).sort((a, b) => b - a);
  assert.deepStrictEqual(ids, expected, "within one event_ts the order must be id DESC");
});

test("loop-events: the whole window is a total order — event_ts DESC then id DESC", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const body = await fetchEvents();

  // Every adjacent pair must be non-increasing on (event_ts, id) — the property the
  // two ORDER BY keys jointly assert, checked over the window rather than the seeds.
  for (let i = 1; i < body.events.length; i++) {
    const prev = body.events[i - 1]!;
    const curr = body.events[i]!;
    const prevTs = Date.parse(prev.event_ts);
    const currTs = Date.parse(curr.event_ts);
    assert.ok(prevTs >= currTs, `event_ts must not ascend at index ${i}`);
    if (prevTs === currTs) {
      assert.ok(prev.id > curr.id, `id must descend within one event_ts at index ${i}`);
    }
  }
});
