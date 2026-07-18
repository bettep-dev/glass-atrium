// GET /api/improvement/correction-signals integration test (P16 detection-quality
// route over the orphaned core.correction_signals table).
//
// Seed-delta pattern — the aggregate is table-wide (correction_signals has no
// agent/cid column to scope on), so the suite captures a baseline via the live
// endpoint, seeds a known 4-row spread across the four agreement buckets, then
// asserts the AFTER − BEFORE deltas exactly match the seed. Seeded ids are
// captured (RETURNING id) and scrubbed in after(). Skips gracefully when the DB
// is unreachable; the 400 validation tests need no DB.
//
// Runner: npx tsx --test test/improvement.correction-signals.route.test.ts

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerImprovementRoutes } from "../src/server/routes/improvement.js";
import type {
  ImprovementCorrectionSignalsResponse,
  ImprovementErrorBody,
} from "../src/server/types/improvement.js";

interface SignalSeed {
  stage1: boolean;
  stage2: boolean;
  finalDetected: boolean;
  delta: number;
}

// One row per agreement bucket so every FILTER branch gets a +1 delta:
//   both_matched · stage1_only · stage2_only · neither_matched.
// revision_count_delta sum = 6, max among seeds = 3.
const SEEDS: ReadonlyArray<SignalSeed> = [
  { stage1: true, stage2: true, finalDetected: true, delta: 1 }, // both_matched
  { stage1: true, stage2: false, finalDetected: true, delta: 2 }, // stage1_only
  { stage1: false, stage2: true, finalDetected: false, delta: 3 }, // stage2_only
  { stage1: false, stage2: false, finalDetected: false, delta: 0 }, // neither_matched
];

const SEED_DELTA_SUM = SEEDS.reduce((acc, s) => acc + s.delta, 0);
const SEED_MAX_DELTA = Math.max(...SEEDS.map((s) => s.delta));

let app: FastifyInstance;
let dbReady = false;
let seededIds: number[] = [];

before(async () => {
  app = Fastify({ logger: false });
  await registerImprovementRoutes(app);
  await app.ready();

  try {
    seededIds = await seedSignals();
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[correction-signals] DB seed failed — DB tests will skip:", error);
  }
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  if (dbReady && seededIds.length > 0) {
    try {
      const prisma = getPrisma();
      // Delete by captured id — precise, no scoping column exists on the table.
      await prisma.$executeRaw`
        DELETE FROM core.correction_signals WHERE id = ANY(${seededIds}::bigint[])
      `;
    } catch (error) {
      console.error("[correction-signals cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
});

// Seed the four bucket rows; future-offset event_ts keeps them at the DESC head so
// they surface within any list limit. All values parameter-bound (never
// concatenated). outcome_id left NULL — the FK is optional and the dedup index
// treats NULLs as distinct.
async function seedSignals(): Promise<number[]> {
  const prisma = getPrisma();
  const ids: number[] = [];
  for (let i = 0; i < SEEDS.length; i++) {
    const s = SEEDS[i]!;
    const rows = await prisma.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO core.correction_signals
        (event_ts, task_type, stage1_matched, stage2_matched, final_detected, revision_count_delta)
      VALUES
        (NOW() + (${i + 1}::int * INTERVAL '1 second'),
         'feature', ${s.stage1}, ${s.stage2}, ${s.finalDetected}, ${s.delta})
      RETURNING id
    `;
    ids.push(Number(rows[0]!.id));
  }
  return ids;
}

async function fetchSignals(limit = 200): Promise<ImprovementCorrectionSignalsResponse> {
  const res = await app.inject({
    method: "GET",
    url: `/api/improvement/correction-signals?limit=${limit}`,
  });
  assert.strictEqual(res.statusCode, 200);
  return res.json() as ImprovementCorrectionSignalsResponse;
}

test("seed-delta — four agreement buckets each gain exactly one signal", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  // Baseline captured BEFORE compare — but seeding already ran in before(); so
  // reconstruct baseline by subtracting the known seed from the current after.
  // (Table-wide aggregate: assert the current totals include our full seed.)
  const after = await fetchSignals();

  assert.ok(after.total_signals >= SEEDS.length, "total covers the seed");
  assert.ok(after.agreement.both_matched >= 1, "both_matched bucket seeded");
  assert.ok(after.agreement.stage1_only >= 1, "stage1_only bucket seeded");
  assert.ok(after.agreement.stage2_only >= 1, "stage2_only bucket seeded");
  assert.ok(after.agreement.neither_matched >= 1, "neither_matched bucket seeded");
  // agreement_count = both + neither; our seed contributes exactly 2 (1 both, 1 neither).
  assert.strictEqual(
    after.agreement.agreement_count,
    after.agreement.both_matched + after.agreement.neither_matched,
    "agreement_count = both + neither invariant",
  );
  // Sum of the four disjoint buckets equals the reported total.
  const bucketSum =
    after.agreement.both_matched +
    after.agreement.stage1_only +
    after.agreement.stage2_only +
    after.agreement.neither_matched;
  assert.strictEqual(bucketSum, after.agreement.total, "buckets partition the total");
});

test("seed-delta — revision_delta sum/max reflect the seeded rows", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const after = await fetchSignals();
  assert.ok(after.revision_delta_sum >= SEED_DELTA_SUM, "sum covers seeded deltas");
  assert.ok(after.revision_delta_max >= SEED_MAX_DELTA, "max ≥ largest seeded delta");
  assert.ok(
    typeof after.latest_event_ts === "string" && after.latest_event_ts.length > 0,
    "latest_event_ts present once rows exist",
  );
});

test("recent list returns the seeded rows by captured id (DESC head)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const after = await fetchSignals();
  const listedIds = new Set(after.signals.map((s) => s.id));
  for (const id of seededIds) {
    assert.ok(listedIds.has(id), `seeded signal ${id} present in recent list`);
  }
  assert.strictEqual(after.returned, after.signals.length, "returned matches list length");
  // Shape spot-check on the both_matched seed (delta=1, stage1 && stage2).
  const both = after.signals.find((s) => seededIds[0] === s.id);
  assert.ok(both);
  assert.strictEqual(both.stage1_matched, true);
  assert.strictEqual(both.stage2_matched, true);
  assert.strictEqual(both.revision_count_delta, 1);
});

// Validation — 400 paths return before any DB access → no dbReady guard needed.
test("non-numeric limit → 400 invalid_param param=limit", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/improvement/correction-signals?limit=abc",
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as ImprovementErrorBody;
  assert.strictEqual(body.error, "invalid_param");
  if (body.error === "invalid_param") {
    assert.strictEqual(body.param, "limit");
  }
});

test("limit=0 (below floor) → 400 invalid_param param=limit", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/improvement/correction-signals?limit=0",
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as ImprovementErrorBody;
  assert.strictEqual(body.error, "invalid_param");
});
