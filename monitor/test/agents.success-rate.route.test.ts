// /api/agents/success-rate 매트릭스 9-type allowlist 회귀 테스트.
// Runner: MONITOR_TEST_DATABASE_URL=… npx tsx --import ./test/lib/select-test-db.ts --test test/agents.success-rate.route.test.ts
//
// Pinned invariant: 비코드 4종 (review/diagnosis/doc/cleanup)이 defensive guard 에
// 탈락하지 않고 매트릭스 행으로 노출 — 5종 allowlist 시절 124행 무공시 누락의 재현 probe.
//
// DB: real Postgres — seed agent 명이 suite 고유 → 응답을 agent 로 한정, cleanup 은 cid LIKE.

import test, { after, before, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { resetAgentRegistryCache } from "../src/server/agents/registry.js";
import {
  SUCCESS_RATE_LIMIT,
  registerAgentsRoutes,
} from "../src/server/routes/agents.js";
import { TASK_TYPES } from "../src/server/task-types.js";
import { computeBucketTzToday, DAY_BUCKET_TIMEZONE } from "../src/server/timezone.js";
import type { AgentSuccessRateResponse } from "../src/server/types/agents.js";

// SUITE_MARKER — agent(응답 필터 키) + cid(cleanup 키) 양쪽에 삽입.
const SUITE_MARKER = `sr-matrix-test-${randomUUID().slice(0, 8)}`;
// window-edge probe seeds a second agent — 얘도 registry gate 를 통과해야 함.
const BOUNDARY_AGENT = `${SUITE_MARKER}-win`;

// Registry fixture — 두 seed agent 를 멤버로 넣어, 정규 membership gate
// (loadAgentRegistry → buildAgentMembershipFilter)가 실제 ~/.claude 레지스트리
// 대신 이 fixture 를 기준으로 seed 행을 보존하게 만든다(hermeticity).
const REGISTRY_FIXTURE = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    [SUITE_MARKER]: { domains: ["test"], phase: "implementation", dual_phase: false },
    [BOUNDARY_AGENT]: { domains: ["test"], phase: "implementation", dual_phase: false },
  },
};

let app: FastifyInstance;
let tmpRoot: string;

before(async () => {
  // Hermetic registry — gate 를 fixture 로 향하게 하고, loadAgentRegistry 가
  // ambient ~/.claude 레지스트리가 아닌 fixture 를 캐시하도록 route 등록 이전에 설정.
  tmpRoot = await mkdtemp(join(tmpdir(), "sr-matrix-registry-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

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
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
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

  // oracle — 동일 윈도우(days=90 → bucket-tz today-89d..today)의 (agent, task_type, bucket-tz 일자) 그룹 수.
  // truncated = LIMIT 포화(rows.length >= cap) ⇔ 그룹 수 >= cap.
  const prisma = getPrisma();
  const today = computeBucketTzToday(new Date());
  const groupRows = await prisma.$queryRaw<Array<{ total: bigint }>>`
    SELECT COUNT(*)::bigint AS total FROM (
      SELECT 1
      FROM core.outcomes
      WHERE (record_ts AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date BETWEEN ${today}::date - 89 AND ${today}::date
      GROUP BY agent, task_type, (record_ts AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date
    ) g
  `;
  const groupCount = Number(groupRows[0]?.total ?? 0n);
  assert.strictEqual(
    body.truncated,
    groupCount >= SUCCESS_RATE_LIMIT,
    `truncated = (그룹 수 ${groupCount} >= cap ${SUCCESS_RATE_LIMIT})`,
  );
});

// Outcomes on each side of both 7-day window edges, at 00:10 bucket-tz wall clock (still the previous UTC day).
// Two on the lower edge day → a UTC-instant cut, which trades the -6 seeds for the +1 seed, changes the count.
const EDGE_OFFSETS = [-7, -6, -6, 0, 1];
const EDGE_INSIDE_COUNT = 3;
// 00:30 in Seoul, still the previous day in UTC → the bucket-tz today and the UTC CURRENT_DATE differ
const EDGE_NOW = Date.parse("2026-07-17T15:30:00Z");
const EDGE_TODAY = computeBucketTzToday(new Date(EDGE_NOW));
const EDGE_DAYS_INSIDE = [addDays(EDGE_TODAY, -6), EDGE_TODAY];

function addDays(isoDay: string, offset: number): string {
  const day = new Date(`${isoDay}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.toISOString().slice(0, 10);
}

async function seedEdgeOutcomes(): Promise<void> {
  for (const [index, offset] of EDGE_OFFSETS.entries()) {
    await getPrisma().$executeRaw`
      INSERT INTO core.outcomes (record_ts, agent, task_type, result, summary, cid)
      VALUES ((${addDays(EDGE_TODAY, offset)}::date + TIME '00:10') AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text,
              ${BOUNDARY_AGENT}, ${TASK_TYPES[index]}::core."TaskType", 'fail'::core."OutcomeResult",
              'window edge seed', ${`${SUITE_MARKER}-edge${index}`})
    `;
  }
}

async function clearEdgeOutcomes(): Promise<void> {
  await getPrisma().$executeRaw`DELETE FROM core.outcomes WHERE cid LIKE ${`${SUITE_MARKER}-edge%`}`;
}

async function getAtEdgeNow(t: TestContext, url: string): Promise<unknown> {
  t.mock.timers.enable({ apis: ["Date"], now: EDGE_NOW });
  try {
    const res = await app.inject({ method: "GET", url });
    assert.strictEqual(res.statusCode, 200, res.body);
    return res.json();
  } finally {
    t.mock.timers.reset();
  }
}

// each body is that route's JSON payload → the cast names only the fields its row reads
for (const row of [
  {
    name: "success-rate",
    getSeededCount: (body: unknown): number =>
      (body as AgentSuccessRateResponse).rows
        .filter((cell) => cell.agent === BOUNDARY_AGENT && EDGE_DAYS_INSIDE.includes(cell.event_date))
        .reduce((sum, cell) => sum + cell.total_count, 0),
  },
  {
    name: "revision-distribution",
    getSeededCount: (body: unknown): number =>
      (body as { rows: Array<{ agent: string; occurrence_count: number }> }).rows
        .filter((bucket) => bucket.agent === BOUNDARY_AGENT)
        .reduce((sum, bucket) => sum + bucket.occurrence_count, 0),
  },
  {
    name: "review-flag-by-agent",
    getSeededCount: (body: unknown): number | undefined =>
      (body as { rows: Array<{ agent: string; total_count: number }> }).rows.find(
        (agentRow) => agentRow.agent === BOUNDARY_AGENT,
      )?.total_count,
  },
  {
    name: "failure-patterns",
    getSeededCount: (body: unknown): number | undefined =>
      (body as { rows: Array<{ agent: string; total_breakages: number }> }).rows.find(
        (agentRow) => agentRow.agent === BOUNDARY_AGENT,
      )?.total_breakages,
  },
]) {
  test(`GET /api/agents/${row.name} counts the outcomes on both bucket-tz edge days and none outside them`, async (t) => {
    await seedEdgeOutcomes();
    t.after(clearEdgeOutcomes);
    const body = await getAtEdgeNow(t, `/api/agents/${row.name}?days=7`);
    assert.strictEqual(row.getSeededCount(body), EDGE_INSIDE_COUNT);
  });
}

test("GET /api/agents/review-flag-timeseries spans the bucket-tz today and the 6 days before it, edge-day outcomes on their own day", async (t) => {
  await seedEdgeOutcomes();
  t.after(clearEdgeOutcomes);
  const body = (await getAtEdgeNow(t, "/api/agents/review-flag-timeseries?days=7")) as {
    rows: Array<{ event_date: string; total_count: number }>;
  };
  assert.deepStrictEqual(
    body.rows.map((day) => [day.event_date, day.total_count]),
    [-6, -5, -4, -3, -2, -1, 0].map((offset) => [
      addDays(EDGE_TODAY, offset),
      EDGE_OFFSETS.filter((seedOffset) => seedOffset === offset).length,
    ]),
  );
});
