// /api/agents/success-rate 매트릭스 9-type allowlist 회귀 테스트.
// Runner: npx tsx --test test/agents.success-rate.route.test.ts
//
// Pinned invariant: 비코드 4종 (review/diagnosis/doc/cleanup)이 defensive guard 에
// 탈락하지 않고 매트릭스 행으로 노출 — 5종 allowlist 시절 124행 무공시 누락의 재현 probe.
//
// DB: real Postgres — seed agent 명이 suite 고유 → 응답을 agent 로 한정, cleanup 은 cid LIKE.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import {
  SUCCESS_RATE_LIMIT,
  registerAgentsRoutes,
} from "../src/server/routes/agents.js";
import { TASK_TYPES } from "../src/server/task-types.js";
import type { AgentSuccessRateResponse } from "../src/server/types/agents.js";

// SUITE_MARKER — agent(응답 필터 키) + cid(cleanup 키) 양쪽에 삽입.
const SUITE_MARKER = `sr-matrix-test-${randomUUID().slice(0, 8)}`;
let app: FastifyInstance;

before(async () => {
  app = Fastify({ logger: false });
  await registerAgentsRoutes(app);
  await app.ready();
  await seedNineTaskTypes();
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
    console.error("[success-rate-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
});

// 9 행 적재 — 단일 seed agent × 9 task_type 각 1행(done) → 매트릭스 한 행에 9 셀.
// record_ts 분 단위 offset — dedup(record_ts, agent, task_type) 무충돌 + 90d window 내.
async function seedNineTaskTypes(): Promise<void> {
  const prisma = getPrisma();
  for (let i = 0; i < TASK_TYPES.length; i++) {
    const taskType = TASK_TYPES[i];
    if (taskType === undefined) continue;
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, summary, cid)
      VALUES
        (NOW() - (${i + 1}::int * INTERVAL '1 minute'),
         ${SUITE_MARKER},
         ${taskType}::core."TaskType",
         'done'::core."OutcomeResult",
         ${`success-rate matrix seed ${taskType}`},
         ${`${SUITE_MARKER}-${i}`})
    `;
  }
}

test("success-rate: canonical 9 task_type 전부 응답에 노출 (비코드 4종 silent drop 회귀 차단)", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/agents/success-rate?days=90",
  });
  assert.strictEqual(res.statusCode, 200, "/success-rate must be 200");
  const body = res.json() as AgentSuccessRateResponse;

  const seedRows = body.rows.filter((r) => r.agent === SUITE_MARKER);
  assert.strictEqual(
    seedRows.length,
    TASK_TYPES.length,
    `seed agent 행 수 ${TASK_TYPES.length} (silent drop 없음)`,
  );

  const returnedTypes = new Set(seedRows.map((r) => r.task_type));
  for (const tt of TASK_TYPES) {
    assert.ok(returnedTypes.has(tt), `task_type '${tt}' 매트릭스 노출`);
  }
});

test("success-rate: seed 행 집계값 (success/total=1 · success_rate=1)", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/agents/success-rate?days=90",
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AgentSuccessRateResponse;

  for (const row of body.rows.filter((r) => r.agent === SUITE_MARKER)) {
    assert.strictEqual(row.success_count, 1, `${row.task_type} success_count`);
    assert.strictEqual(row.failure_count, 0, `${row.task_type} failure_count`);
    assert.strictEqual(row.total_count, 1, `${row.task_type} total_count`);
    assert.strictEqual(row.success_rate, 1, `${row.task_type} success_rate`);
  }
});

test("success-rate: truncated 플래그 — boolean 상시 emit + live 그룹 수 oracle 일치", async () => {
  // FE 매트릭스 disclosure 계약 — 플래그는 행 수와 무관하게 항상 boolean emit.
  const res = await app.inject({
    method: "GET",
    url: "/api/agents/success-rate?days=90",
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AgentSuccessRateResponse;
  assert.strictEqual(
    typeof body.truncated,
    "boolean",
    "truncated 필드 boolean 상시 존재",
  );

  // oracle — 동일 윈도우(days=90 → CURRENT_DATE-89d)의 (agent, task_type, 일자) 그룹 수.
  // truncated = LIMIT 포화(rows.length >= cap) ⇔ 그룹 수 >= cap (F26 oracle 과 동일 윈도우 의미론).
  const prisma = getPrisma();
  const groupRows = await prisma.$queryRaw<Array<{ total: bigint }>>`
    SELECT COUNT(*)::bigint AS total FROM (
      SELECT 1
      FROM core.outcomes
      WHERE record_ts >= CURRENT_DATE - INTERVAL '89 days'
      GROUP BY agent, task_type, record_ts::date
    ) g
  `;
  const groupCount = Number(groupRows[0]?.total ?? 0n);
  assert.strictEqual(
    body.truncated,
    groupCount >= SUCCESS_RATE_LIMIT,
    `truncated = (그룹 수 ${groupCount} >= cap ${SUCCESS_RATE_LIMIT})`,
  );
});

test("success-rate: days=7 윈도우 day-set 경계 — 오늘 포함 정확히 7일 (F26)", async () => {
  // buildWindowLowerBound 경계 probe — 경계일(today-6) 자정 행 포함 ·
  // 윈도우 밖(today-7 일자) 행 제외. cost.ts SoT 의미론(오늘 포함 N 일력일) 검증.
  const prisma = getPrisma();
  const boundaryAgent = `${SUITE_MARKER}-win`;
  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, cid)
    VALUES
      (CURRENT_DATE - INTERVAL '6 days', ${boundaryAgent},
       'bug-fix'::core."TaskType", 'done'::core."OutcomeResult",
       'window boundary inside seed', ${`${SUITE_MARKER}-win-in`}),
      (CURRENT_DATE - INTERVAL '7 days' + INTERVAL '1 hour', ${boundaryAgent},
       'feature'::core."TaskType", 'done'::core."OutcomeResult",
       'window boundary outside seed', ${`${SUITE_MARKER}-win-out`})
  `;

  const res = await app.inject({
    method: "GET",
    url: "/api/agents/success-rate?days=7",
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AgentSuccessRateResponse;
  const boundaryTypes = new Set(
    body.rows.filter((r) => r.agent === boundaryAgent).map((r) => r.task_type),
  );
  assert.ok(boundaryTypes.has("bug-fix"), "경계일(today-6) 자정 행 포함");
  assert.ok(!boundaryTypes.has("feature"), "윈도우 밖(today-7 일자) 행 제외");

  // 응답 전체 day-set 하한 invariant — 어떤 행도 today-6 이전 날짜를 갖지 않음.
  const lowerRows = await prisma.$queryRaw<Array<{ lower: string }>>`
    SELECT (CURRENT_DATE - INTERVAL '6 days')::date::text AS lower
  `;
  const lower = lowerRows[0]?.lower;
  assert.ok(lower !== undefined, "lower-bound oracle row");
  for (const row of body.rows) {
    assert.ok(
      row.event_date >= lower,
      `event_date ${row.event_date} >= window lower bound ${lower}`,
    );
  }
});
