// Regression test for FIX-RB1 — the confidence=null filter on /cross-analysis.
// Runner: npx tsx --test test/outcomes.confidence-null-filter.route.test.ts
//
// Root fix: buildWhereClause previously carried the "confidence IS NULL" filter
// state in a side-channel WeakSet that DELETED its entry on first read. On
// /cross-analysis the same ParsedFilters object feeds buildWhereClause TWICE
// (base-count query + poisoned-excluded analytics query) — the second call lost
// the IS-NULL fragment, so the two queries scoped DIFFERENT populations and
// excluded_poisoned_count = baseCount − analyticsCount could go NEGATIVE.
//
// Invariant pinned: the confidence=null filter is applied IDEMPOTENTLY to both
// queries → only NULL-confidence rows count BOTH times, and
// excluded_poisoned_count stays >= 0 across repeated requests.
//
// DB: real Postgres — seed summary carries SUITE_MARKER → ?q 한정 조회, cleanup 은 cid LIKE.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerOutcomesRoutes } from "../src/server/routes/outcomes.js";
import type { OutcomeCrossAnalysisResponse } from "../src/server/types/outcomes.js";

// SUITE_MARKER — summary(필터 키) + cid(cleanup 키) 양쪽에 삽입.
const SUITE_MARKER = `confidence-null-filter-test-${randomUUID()}`;
let app: FastifyInstance;

// seed 구성 — confidence=null 필터 하에서 버그를 노출하도록 설계.
//   NULL-confidence, 비-poisoned 2행 → base + analytics 양쪽 집계.
//   NULL-confidence, poisoned    1행 → base 만 집계(analytics 제외) → excluded_poisoned_count 에 +1.
//   high-confidence, 비-poisoned 2행 → IS-NULL 필터가 양쪽에서 배제해야 하는 행.
// FIX: base=3(NULL 3행), analytics=2(NULL 비-poisoned), excluded=3−2=1 (>=0).
// BUG(WeakSet delete-on-read): 2번째 buildWhereClause 가 IS-NULL 절을 잃어
//   analytics 가 high 2행까지 포함 → 4, excluded=3−4=−1 (음수, 보고된 증상).
const NULL_CONF_NON_POISONED = 2;
const NULL_CONF_POISONED = 1;
const HIGH_CONF_NON_POISONED = 2;
const NULL_CONF_TOTAL = NULL_CONF_NON_POISONED + NULL_CONF_POISONED;
const ANALYTICS_NULL_CONF = NULL_CONF_NON_POISONED;
const EXPECTED_EXCLUDED = NULL_CONF_TOTAL - ANALYTICS_NULL_CONF;

before(async () => {
  app = Fastify({ logger: false });
  await registerOutcomesRoutes(app);
  await app.ready();
  await seedConfidenceRows();
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  // DB scrub — seed 행만 제거(cid 에 SUITE_MARKER). 동시 세션 행 보존.
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`
      DELETE FROM core.outcomes WHERE cid LIKE ${`%${SUITE_MARKER}%`}
    `;
  } catch (error) {
    console.error("[confidence-null-filter-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
});

// confidence(high/null) × poisoned(true/false) 조합 행 적재.
// record_ts/agent/cid distinct → dedup 무충돌. confidence NULL 은 컬럼 미지정으로.
async function seedConfidenceRows(): Promise<void> {
  const prisma = getPrisma();
  let seq = 0;

  const insertNullConfidence = async (poisoned: boolean): Promise<void> => {
    const i = seq++;
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, summary, poisoned_window, cid)
      VALUES
        (NOW() - (${i + 1}::int * INTERVAL '1 minute'),
         ${`conf-null-agent-${i}`},
         'doc'::core."TaskType",
         'done'::core."OutcomeResult",
         ${`confidence-null seed ${SUITE_MARKER}`},
         ${poisoned},
         ${`${SUITE_MARKER}-${i}`})
    `;
  };

  const insertHighConfidence = async (): Promise<void> => {
    const i = seq++;
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, confidence, summary, poisoned_window, cid)
      VALUES
        (NOW() - (${i + 1}::int * INTERVAL '1 minute'),
         ${`conf-high-agent-${i}`},
         'doc'::core."TaskType",
         'done'::core."OutcomeResult",
         'high'::core."Confidence",
         ${`confidence-null seed ${SUITE_MARKER}`},
         FALSE,
         ${`${SUITE_MARKER}-${i}`})
    `;
  };

  for (let n = 0; n < NULL_CONF_NON_POISONED; n++) await insertNullConfidence(false);
  for (let n = 0; n < NULL_CONF_POISONED; n++) await insertNullConfidence(true);
  for (let n = 0; n < HIGH_CONF_NON_POISONED; n++) await insertHighConfidence();
}

// include_all=1 lifts the O2 registry-membership gate (default-scoped since the
// FIX-RB1 sibling change) — this suite's seed agents (conf-null-agent-*/
// conf-high-agent-*) are synthetic non-registry names, and this test's concern
// (confidence=null filter idempotency) is orthogonal to registry membership.
async function fetchCrossAnalysisNullConfidence(): Promise<OutcomeCrossAnalysisResponse> {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/cross-analysis?days=all&confidence=null&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200, "/cross-analysis must be 200");
  return res.json() as OutcomeCrossAnalysisResponse;
}

// 핵심 회귀: 동일 요청을 2회 실행 → buildWhereClause 가 같은 ParsedFilters 로 N번
// 호출되어도 IS-NULL 절이 매번 유지되는지(idempotent) 검증. WeakSet delete-on-read
// 버그라면 첫 요청은 통과하더라도 동일-객체 2회 호출(count+analytics)에서 발산.
test("confidence=null filter applies IS NULL to BOTH cross-analysis queries (run twice)", async () => {
  for (const attempt of [1, 2] as const) {
    const body = await fetchCrossAnalysisNullConfidence();

    // analytics population — poisoned 제외 NULL-confidence 행만.
    assert.strictEqual(
      body.total,
      ANALYTICS_NULL_CONF,
      `attempt ${attempt}: analytics total = NULL-confidence non-poisoned rows (high-confidence rows excluded)`,
    );

    // base − analytics = poisoned NULL-confidence 행 → 절대 음수 불가.
    assert.ok(
      body.excluded_poisoned_count >= 0,
      `attempt ${attempt}: excluded_poisoned_count must be >= 0 (was ${body.excluded_poisoned_count})`,
    );
    assert.strictEqual(
      body.excluded_poisoned_count,
      EXPECTED_EXCLUDED,
      `attempt ${attempt}: excluded_poisoned_count = poisoned NULL-confidence rows`,
    );

    // IS NULL 절이 양쪽에 적용됐으면 high-confidence 셀은 전부 0 — 누설 행 없음.
    const highCells = body.cells.filter((c) => c.confidence !== null);
    for (const cell of highCells) {
      assert.strictEqual(
        cell.count,
        0,
        `attempt ${attempt}: non-null confidence cell must be 0 under confidence=null filter (got ${cell.count} for ${cell.confidence})`,
      );
    }

    // null-confidence 셀 합 === analytics total — 필터가 NULL 집합만 남긴 증거.
    const nullCellSum = body.cells
      .filter((c) => c.confidence === null)
      .reduce((acc, c) => acc + c.count, 0);
    assert.strictEqual(
      nullCellSum,
      ANALYTICS_NULL_CONF,
      `attempt ${attempt}: null-confidence cells account for the entire analytics population`,
    );
  }
});

// filter echo 가 confidence=null 요청을 좁은 와이어 타입(literal|null)으로 일관 반영.
test("confidence=null cross-analysis echoes confidence as null (narrow wire type preserved)", async () => {
  const body = await fetchCrossAnalysisNullConfidence();
  assert.strictEqual(
    body.filter.confidence,
    null,
    "echo collapses the IS-NULL filter to null (no 'unset'/sentinel leakage into the narrow echo type)",
  );
});
