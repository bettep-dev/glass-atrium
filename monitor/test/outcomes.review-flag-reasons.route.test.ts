// AC-4.10 — the review-flag reason carrier is projected by BOTH outcomes row shapes
// (search row + detail row) and declared once in the shared wire types.
//
// The carrier is recorded at the setter that raised the flag; the route projects it
// verbatim so the screen never re-derives a reason from confidence/metric_pass. A row
// predating the carrier reads as the EMPTY array (column is NOT NULL DEFAULT '{}'), which
// is what keeps an unclassified legacy row distinguishable from an unknown recorded token.
//
// DB: real Postgres — seed summary carries SUITE_MARKER → ?q 한정 조회, cleanup 은 cid LIKE.
// Skips gracefully when the DB is unreachable.
//
// Runner: npx tsx --test test/outcomes.review-flag-reasons.route.test.ts

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerOutcomesRoutes } from "../src/server/routes/outcomes.js";
import type {
  OutcomeDetailResponse,
  OutcomeSearchResponse,
  OutcomeSearchRow,
} from "../src/server/types/outcomes.js";

const SUITE_MARKER = `review-flag-reasons-test-${randomUUID()}`;
const STAMPED_AGENT = `reasons-stamped-agent-${randomUUID().slice(0, 8)}`;
const LEGACY_AGENT = `reasons-legacy-agent-${randomUUID().slice(0, 8)}`;

// Two recorder tokens on one row — the carrier is an array because independent setters
// can each fire on the same outcome (a polar mismatch AND a degraded attribution).
const STAMPED_TOKENS = ["overconfidence", "degraded-attribution-synthesized"];

// Compile-time half of AC-4.10: the field must be declared on the shared types, not
// re-declared per route. A missing declaration fails `tsc --noEmit`, not the assertions.
type SearchCarrier = OutcomeSearchRow["review_flag_reasons"];
type DetailCarrier = OutcomeDetailResponse["review_flag_reasons"];
const CARRIER_SHAPE: { search: SearchCarrier; detail: DetailCarrier } = {
  search: [],
  detail: [],
};

let app: FastifyInstance;
let dbReady = false;
let stampedId = 0;
let legacyId = 0;

before(async () => {
  app = Fastify({ logger: false });
  await registerOutcomesRoutes(app);
  await app.ready();

  try {
    await seedReasonRows();
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[review-flag-reasons-test] DB seed failed — tests will skip:", error);
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
      console.error("[review-flag-reasons-test cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
});

// Two flagged rows: one carrying recorded tokens, one legacy row whose carrier column is
// left unnamed so the DEFAULT '{}' applies — the legacy read path under test.
async function seedReasonRows(): Promise<void> {
  const prisma = getPrisma();

  const stamped = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, review_flag, review_flag_reasons, cid)
    VALUES
      (NOW() - INTERVAL '1 minute',
       ${STAMPED_AGENT},
       'feature'::core."TaskType",
       'done'::core."OutcomeResult",
       ${`reason carrier seed ${SUITE_MARKER}`},
       TRUE,
       ${STAMPED_TOKENS},
       ${`${SUITE_MARKER}-stamped`})
    RETURNING id
  `;
  const legacy = await prisma.$queryRaw<{ id: bigint }[]>`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, review_flag, cid)
    VALUES
      (NOW() - INTERVAL '2 minutes',
       ${LEGACY_AGENT},
       'feature'::core."TaskType",
       'done'::core."OutcomeResult",
       ${`reason carrier seed ${SUITE_MARKER}`},
       TRUE,
       ${`${SUITE_MARKER}-legacy`})
    RETURNING id
  `;

  stampedId = Number(stamped[0]?.id ?? 0);
  legacyId = Number(legacy[0]?.id ?? 0);
  assert.ok(stampedId > 0 && legacyId > 0, "seed must return both row ids");
}

// include_all=1 lifts the registry-membership gate — the seed agents are synthetic
// non-registry names and membership is orthogonal to the carrier projection.
async function findSearchRows(): Promise<OutcomeSearchRow[]> {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/search?days=all&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200, "/search must be 200");
  return (res.json() as OutcomeSearchResponse).rows;
}

async function findDetail(id: number): Promise<OutcomeDetailResponse> {
  const res = await app.inject({ method: "GET", url: `/api/outcomes/${id}` });
  assert.strictEqual(res.statusCode, 200, "/:id must be 200");
  return res.json() as OutcomeDetailResponse;
}

test("search rows project the recorded reason tokens verbatim", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const rows = await findSearchRows();
  const stamped = rows.find((row) => row.agent === STAMPED_AGENT);
  assert.ok(stamped, "seeded flagged row must be present in the search projection");
  assert.deepStrictEqual(
    stamped.review_flag_reasons,
    STAMPED_TOKENS,
    "search row carries every recorded token, in recorded order, unmodified",
  );
});

test("detail rows project the recorded reason tokens verbatim", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const detail = await findDetail(stampedId);
  assert.deepStrictEqual(
    detail.review_flag_reasons,
    STAMPED_TOKENS,
    "detail row carries the same tokens as the search row (one projection, two shapes)",
  );
});

// The legacy read is the load-bearing case: an empty array is the unclassified state the
// screen renders. A null or an absent key would collapse it into the unknown-token state.
test("legacy rows read as an empty carrier on both shapes, never null or absent", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const rows = await findSearchRows();
  const legacyRow = rows.find((row) => row.agent === LEGACY_AGENT);
  assert.ok(legacyRow, "seeded legacy row must be present in the search projection");
  assert.ok(
    Object.hasOwn(legacyRow, "review_flag_reasons"),
    "search shape declares the carrier key even with no recorded token",
  );
  assert.deepStrictEqual(legacyRow.review_flag_reasons, [], "legacy search carrier is empty");
  assert.strictEqual(legacyRow.review_flag, true, "flag stays true — only the reason is unknown");

  const detail = await findDetail(legacyId);
  assert.ok(
    Object.hasOwn(detail, "review_flag_reasons"),
    "detail shape declares the carrier key even with no recorded token",
  );
  assert.deepStrictEqual(detail.review_flag_reasons, [], "legacy detail carrier is empty");
});

test("the carrier is a string array on both shared wire shapes", () => {
  assert.ok(Array.isArray(CARRIER_SHAPE.search), "search carrier type resolves to an array");
  assert.ok(Array.isArray(CARRIER_SHAPE.detail), "detail carrier type resolves to an array");
});
