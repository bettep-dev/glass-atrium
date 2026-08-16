// GET /api/improvement/corpus-audits — the read surface over the T12 destination
// table core.autoagent_corpus_audits.
//
// Red-capable by construction: the assertions read the seeded row back OUT OF THE
// ROUTE PAYLOAD, so a T12 that lands the table and the writer but no route fails
// here (404 → statusCode assertion), and a route that drops or coerces a column
// fails on the field assertions. Retrievability from the table alone closes nothing.
//
// Null preservation is asserted on the same row: trend_delta / compliance_rate /
// override_rate are seeded NULL and must arrive as null, never 0.
//
// Seeded cycle_date values are far-future sentinels unique per run, so the suite
// never collides with, or scrubs, a production reading. Cleanup deletes by the
// exact seeded dates.
//
// DB: real Postgres. Skips gracefully when unreachable.
//
// Runner: npx tsx --test test/improvement.corpus-audits.route.test.ts

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerImprovementRoutes } from "../src/server/routes/improvement.js";

interface CorpusAuditPayloadRow {
  id: number;
  cycle_date: string;
  word_count: number;
  token_estimate: number;
  file_count: number;
  seeded_threshold: number;
  gate_pass_count: number;
  gate_trip_count: number;
  gate_total_count: number;
  trend_delta: number | null;
  trend_alert: boolean;
  absolute_alert: boolean;
  compliance_rate: number | null;
  override_rate: number | null;
  indexed_at: string;
}

interface CorpusAuditPayload {
  total_audits: number;
  returned: number;
  latest_cycle_date: string | null;
  audits: CorpusAuditPayloadRow[];
}

// Far-future sentinel days: a production emitter writes CURRENT_DATE, so these can
// never be a real reading. Distinct per run to survive a concurrent suite.
const SUITE_TAG = randomUUID().slice(0, 4);
const DAY_OFFSET = Number.parseInt(SUITE_TAG, 16) % 300;
const OLDER_DATE = isoDay(2999, 1, 1 + DAY_OFFSET);
const NEWER_DATE = isoDay(2999, 1, 2 + DAY_OFFSET);
const SEEDED_DATES = [OLDER_DATE, NEWER_DATE];

// The full-value row — every measurement column carries a distinct value so a
// column-swap in the SELECT list cannot pass.
const FULL_ROW = {
  word_count: 111_111,
  token_estimate: 222_222,
  file_count: 333,
  seeded_threshold: 444_444,
  gate_pass_count: 55,
  gate_trip_count: 6,
  gate_total_count: 61,
  trend_delta: 777,
  trend_alert: true,
  absolute_alert: false,
  compliance_rate: 0.25,
} as const;

let app: FastifyInstance;
let dbReady = false;

before(async () => {
  app = Fastify({ logger: false });
  await registerImprovementRoutes(app);
  await app.ready();

  try {
    await seedAudits();
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[impr-corpus-audits] DB seed failed — tests will skip:", error);
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
      await deleteSeeded();
    } catch (error) {
      console.error("[impr-corpus-audits cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
});

function isoDay(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

// Two rows on the UNIQUE cycle_date key: the older one carries every measurement,
// the newer one is all-null where the schema allows it (the honest insufficient-data
// shape the emitter produces on a first cycle).
async function seedAudits(): Promise<void> {
  const prisma = getPrisma();
  await deleteSeeded();
  await prisma.$executeRaw`
    INSERT INTO core.autoagent_corpus_audits
      (cycle_date, word_count, token_estimate, file_count, seeded_threshold,
       gate_pass_count, gate_trip_count, gate_total_count,
       trend_delta, trend_alert, absolute_alert, compliance_rate, override_rate)
    VALUES
      (${OLDER_DATE}::date, ${FULL_ROW.word_count}::int, ${FULL_ROW.token_estimate}::int,
       ${FULL_ROW.file_count}::int, ${FULL_ROW.seeded_threshold}::int,
       ${FULL_ROW.gate_pass_count}::int, ${FULL_ROW.gate_trip_count}::int,
       ${FULL_ROW.gate_total_count}::int, ${FULL_ROW.trend_delta}::int,
       ${FULL_ROW.trend_alert}, ${FULL_ROW.absolute_alert},
       ${FULL_ROW.compliance_rate}::real, NULL)
  `;
  await prisma.$executeRaw`
    INSERT INTO core.autoagent_corpus_audits
      (cycle_date, word_count, token_estimate, file_count, seeded_threshold,
       gate_pass_count, gate_trip_count, gate_total_count,
       trend_delta, trend_alert, absolute_alert, compliance_rate, override_rate)
    VALUES
      (${NEWER_DATE}::date, 10::int, 20::int, 3::int, 40::int, 0::int, 0::int, 0::int,
       NULL, false, false, NULL, NULL)
  `;
}

async function deleteSeeded(): Promise<void> {
  const prisma = getPrisma();
  for (const day of SEEDED_DATES) {
    await prisma.$executeRaw`
      DELETE FROM core.autoagent_corpus_audits WHERE cycle_date = ${day}::date
    `;
  }
}

async function fetchAudits(query = "?limit=200"): Promise<CorpusAuditPayload> {
  const res = await app.inject({ method: "GET", url: `/api/improvement/corpus-audits${query}` });
  assert.strictEqual(res.statusCode, 200, "must be 200 — the route must exist and answer");
  return res.json() as CorpusAuditPayload;
}

test("T12 corpus-audits: seeded reading is retrievable from the route payload with all 12 columns intact", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const body = await fetchAudits();

  const row = body.audits.find((a) => a.cycle_date === OLDER_DATE);
  assert.ok(row !== undefined, "the seeded full-value reading must be present in the payload");
  assert.strictEqual(row.word_count, FULL_ROW.word_count);
  assert.strictEqual(row.token_estimate, FULL_ROW.token_estimate);
  assert.strictEqual(row.file_count, FULL_ROW.file_count);
  assert.strictEqual(row.seeded_threshold, FULL_ROW.seeded_threshold);
  assert.strictEqual(row.gate_pass_count, FULL_ROW.gate_pass_count);
  assert.strictEqual(row.gate_trip_count, FULL_ROW.gate_trip_count);
  assert.strictEqual(row.gate_total_count, FULL_ROW.gate_total_count);
  assert.strictEqual(row.trend_delta, FULL_ROW.trend_delta);
  assert.strictEqual(row.trend_alert, FULL_ROW.trend_alert);
  assert.strictEqual(row.absolute_alert, FULL_ROW.absolute_alert);
  assert.ok(
    Math.abs((row.compliance_rate ?? 0) - FULL_ROW.compliance_rate) < 1e-6,
    "compliance_rate must round-trip (REAL → number)",
  );
  assert.strictEqual(row.override_rate, null, "override_rate has no durable store yet");
  assert.strictEqual(typeof row.id, "number", "BigInt id must be narrowed to a JSON number");
  assert.ok(!Number.isNaN(Date.parse(row.indexed_at)), "indexed_at must be an ISO8601 instant");
});

test("T12 corpus-audits: NULL measurements arrive as null, never coerced to 0", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const body = await fetchAudits();

  const row = body.audits.find((a) => a.cycle_date === NEWER_DATE);
  assert.ok(row !== undefined, "the seeded null-shaped reading must be present");
  assert.strictEqual(row.trend_delta, null, "no prior baseline is null, not a measured 0");
  assert.strictEqual(row.compliance_rate, null, "insufficient data is null, not 0.0");
  assert.strictEqual(row.override_rate, null);
});

test("T12 corpus-audits: newest-first window, count and latest_cycle_date agree with the list", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const body = await fetchAudits();

  const dates = body.audits.map((a) => a.cycle_date);
  const sorted = [...dates].sort().reverse();
  assert.deepStrictEqual(dates, sorted, "rows must be ordered cycle_date DESC");
  assert.strictEqual(
    dates.indexOf(NEWER_DATE) < dates.indexOf(OLDER_DATE),
    true,
    "the newer seeded reading must precede the older one",
  );
  assert.strictEqual(body.returned, body.audits.length, "returned must count the rows returned");
  assert.ok(body.total_audits >= 2, "total_audits counts the whole table (≥ the 2 seeded rows)");
  assert.ok(body.total_audits >= body.returned, "total must not undercount the window");
  assert.strictEqual(
    body.latest_cycle_date,
    NEWER_DATE,
    "latest_cycle_date must be the newest seeded sentinel (far-future by construction)",
  );
});

test("T12 corpus-audits: limit is honoured and an out-of-range limit is a 400", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const body = await fetchAudits("?limit=1");
  assert.strictEqual(body.audits.length, 1, "limit=1 must return a single row");
  assert.strictEqual(body.returned, 1);

  const bad = await app.inject({ method: "GET", url: "/api/improvement/corpus-audits?limit=abc" });
  assert.strictEqual(bad.statusCode, 400, "a non-numeric limit must be rejected");
});
