// Regression tests for GET /api/outcomes/attribution-daily (Outcome 분석 ·
// AttributionHealthCard backing endpoint).
//
// Runner: node:test (built-in) via tsx — npx tsx --test test/outcomes.attribution-daily.route.test.ts
//
// Why this suite exists: the route was committed (BE ae5c8d0) but the running
// monitor served a stale dist → the literal /attribution-daily fell through to
// the /:id parametric handler, 400ing with param='id'. This persistent test
// pins the route registration + the honest 4-category pivot so a future stale
// build or route-order regression is caught.
//
// Coverage:
//   (a) per-row sum invariant: healthy+attribution_loss+literal_omission+
//       synthesized === total for EVERY returned day point (universal property —
//       holds across all rows, not only seeded ones)
//   (b) NULL attribution_source rows excluded from totals (seed delta = 8, not 9)
//   (c) days allowlist gate {7,30,90} accept · out-of-set (45/abc/-7/7.5/91/0)
//       → 400 param='days' · empty → default-accept (200)
//   (d) categorize/pivot mapping: each canonical attribution_source value lands in
//       the correct category, verified via pre/post-seed window summary delta
//       (deterministic — concurrent rows cancel out in the delta)
//   (e) R2 honest attribution_loss: an UNBACKED subagent-stop-missing row
//       (no real core.agent_events SubagentStop near record_ts) is reclassified to
//       'synthesized' (phantom noise), while a BACKED one (real non-sentinel
//       SubagentStop agent_event within ±5min) counts as genuine 'attribution_loss'.
//
// 테스트 인프라:
//   - DB: real Postgres (DATABASE_URL from .env) — SUITE_MARKER 기반 cleanup
//   - App: stripped Fastify (outcomes route 만 등록) + app.inject() — port binding 없음
//   - 격리: seed 행을 cid 컬럼 SUITE_MARKER 로 표식 → delta 측정 + cleanup. backing
//     agent_events 행은 agent_id 에 SUITE_MARKER 를 박아 동일하게 scrub.
//   - 결정성: window summary 의 pre/post-seed DELTA 로 검증 → 동시 세션 행이 상수항으로 상쇄

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerOutcomesRoutes } from "../src/server/routes/outcomes.js";
import type {
  AttributionDailyResponse,
  OutcomesErrorBody,
} from "../src/server/types/outcomes.js";

// SUITE_MARKER — 각 seed 행 cid 컬럼에 박아 cleanup + delta 측정 기준으로 사용.
const SUITE_MARKER = `attr-daily-test-${randomUUID()}`;
let app: FastifyInstance;

// 8 CHECK-canonical attribution_source → expected category (route 의 진실 매핑 거울).
// schema.prisma L258-266 CHECK 8종 + route categorizeAttributionSource() 와 1:1 일치.
// NOTE (R2): subagent-stop-missing expected category 는 backing agent_events 유무 의존
// 이 표는 backing 없는 기본 seed 기준 → 'synthesized'(phantom 노이즈)
// genuine attribution_loss 경로는 별도 backing-event seed 로 검증 — 아래 (e) 테스트
type Category = "healthy" | "attribution_loss" | "literal_omission" | "synthesized";

const CANONICAL_SOURCE_CATEGORY: ReadonlyArray<readonly [string, Category]> = [
  ["hook-input", "healthy"],
  // unbacked → 'synthesized' (phantom). genuine-loss 경로는 (e) 에서 backing 으로 검증.
  ["subagent-stop-missing", "synthesized"],
  ["truncated_completion", "literal_omission"],
  ["completion-missing", "literal_omission"],
  ["completion-synthesized", "synthesized"],
  ["conversation-only", "synthesized"],
  ["cron-derived", "synthesized"],
  ["agent-id-missing", "synthesized"],
];

// Expected per-category contribution of the 9-row seed (8 non-null one-each +
// 1 NULL excluded), with NO agent_events backing: healthy 1 · attribution_loss 0
// (subagent-stop-missing has no backing → reclassified phantom/synthesized) ·
// literal_omission 2 · synthesized 5 · total_attributed delta 8 (NULL never counted).
const EXPECTED_SEED_DELTA: Readonly<Record<Category, number>> & { total: number } = {
  healthy: 1,
  attribution_loss: 0,
  literal_omission: 2,
  synthesized: 5,
  total: 8,
};

before(async () => {
  app = Fastify({ logger: false });
  await registerOutcomesRoutes(app);
  await app.ready();
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  // DB scrub — seed 행만 제거 · 동시 세션 행 보존. outcomes 는 cid 로, backing
  // agent_events 는 agent_id 로 SUITE_MARKER 표식 → 양쪽 모두 정리.
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`
      DELETE FROM core.outcomes WHERE cid LIKE ${`%${SUITE_MARKER}%`}
    `;
    await prisma.$executeRaw`
      DELETE FROM core.agent_events WHERE agent_id LIKE ${`%${SUITE_MARKER}%`}
    `;
  } catch (error) {
    // surface, never throw — disconnect 도 시도해야 함.
    console.error("[attr-daily-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
});

// Window summary fetch helper — endpoint 의 7일 window summary 를 읽어 delta 측정.
async function fetchWindowSummary(): Promise<AttributionDailyResponse> {
  const res = await app.inject({
    method: "GET",
    url: "/api/outcomes/attribution-daily?days=7",
  });
  assert.strictEqual(res.statusCode, 200, "attribution-daily?days=7 must be 200");
  return res.json() as AttributionDailyResponse;
}

// 9 seed 행 적재. record_ts 는 7일 window 안 + 미래 아님(NOW 직전) + 행별 distinct
// (outcomes_dedup UNIQUE(record_ts, agent, task_type) 충돌 회피 — agent 도 행별로 다름).
// 8 canonical(category 검증용) + 1 NULL(제외 검증용). cid = SUITE_MARKER 표식.
async function seedNineRows(): Promise<void> {
  const prisma = getPrisma();
  // canonical 8 행 — record_ts 를 1분 간격으로 어긋나게(NOW - (idx+2) hours) 두어
  // window(7일) 내부에 안정적으로 배치 + dedup 충돌 회피.
  for (let i = 0; i < CANONICAL_SOURCE_CATEGORY.length; i++) {
    const entry = CANONICAL_SOURCE_CATEGORY[i];
    if (entry === undefined) continue;
    const [source] = entry;
    const cid = `${SUITE_MARKER}-canon-${i}`;
    const hoursAgo = i + 2; // 2..9 시간 전 — 모두 7일 window 내부.
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, summary, attribution_source, cid)
      VALUES
        (NOW() - (${hoursAgo}::int * INTERVAL '1 hour'),
         ${`attr-daily-agent-${i}`},
         'feature'::core."TaskType",
         'done'::core."OutcomeResult",
         'attribution-daily regression seed',
         ${source},
         ${cid})
    `;
  }
  // NULL attribution_source 행 — total 에서 제외되어야 함(delta 에 미반영).
  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, attribution_source, cid)
    VALUES
      (NOW() - (1::int * INTERVAL '1 hour'),
       'attr-daily-agent-null',
       'feature'::core."TaskType",
       'done'::core."OutcomeResult",
       'attribution-daily regression seed (null source)',
       NULL,
       ${`${SUITE_MARKER}-null`})
  `;
}

// (c) days allowlist gate — accept {7,30,90} + default · reject out-of-set
test("days={7,30,90} accepted → 200 + days echoed", async () => {
  for (const days of [7, 30, 90] as const) {
    const res = await app.inject({
      method: "GET",
      url: `/api/outcomes/attribution-daily?days=${days}`,
    });
    assert.strictEqual(res.statusCode, 200, `days=${days} must be 200`);
    const body = res.json() as AttributionDailyResponse;
    assert.strictEqual(body.days, days, `response.days must echo ${days}`);
  }
});

test("days omitted (empty) → 200, defaults to 30", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/outcomes/attribution-daily",
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AttributionDailyResponse;
  assert.strictEqual(body.days, 30, "default window is 30 days");
});

test("days out-of-set (45/abc/-7/7.5/91/0) → 400 invalid_param param='days'", async () => {
  for (const bad of ["45", "abc", "-7", "7.5", "91", "0"]) {
    const res = await app.inject({
      method: "GET",
      url: `/api/outcomes/attribution-daily?days=${encodeURIComponent(bad)}`,
    });
    assert.strictEqual(res.statusCode, 400, `days=${bad} must be 400`);
    const body = res.json() as OutcomesErrorBody;
    assert.strictEqual(body.error, "invalid_param", `days=${bad} error envelope`);
    assert.ok("param" in body && body.param === "days", `days=${bad} param='days'`);
  }
});

// (a) per-row sum invariant — universal property across ALL returned day points
test("every day point satisfies healthy+attribution_loss+literal_omission+synthesized === total", async () => {
  // seed 후 측정해 활동일이 반드시 존재하도록 보장(빈 series vacuous-pass 방지).
  await seedNineRows();
  const body = await fetchWindowSummary();
  assert.ok(body.days_series.length > 0, "seed guarantees at least one active day");
  for (const point of body.days_series) {
    const parts = point.healthy + point.attribution_loss + point.literal_omission + point.synthesized;
    assert.strictEqual(
      parts,
      point.total,
      `sum invariant violated on day ${point.day}: ${parts} !== ${point.total}`,
    );
  }
});

// (d) categorize/pivot mapping + (b) NULL exclusion — via pre/post-seed delta
test("seed delta: each canonical source → correct category · NULL excluded · total delta = 8", async () => {
  // pre-seed snapshot. 동시 세션 행은 pre/post 양쪽에 동일하게 존재 → delta 에서 상쇄.
  // (seedNineRows 는 이전 테스트에서 이미 호출됨 — 멱등 측정 위해 cleanup 후 재측정 대신
  //  추가 9행 적재 후 증분 측정 · record_ts/agent/cid 가 distinct 라 dedup 무충돌)
  const before = sumCategories(await fetchWindowSummary());

  // 두 번째 seed 배치(다른 cid suffix 라운드) — 기존 SUITE_MARKER 유지하되 distinct 행.
  await seedSecondBatch();

  const after = sumCategories(await fetchWindowSummary());

  const delta: Record<Category, number> = {
    healthy: after.healthy - before.healthy,
    attribution_loss: after.attribution_loss - before.attribution_loss,
    literal_omission: after.literal_omission - before.literal_omission,
    synthesized: after.synthesized - before.synthesized,
  };
  const totalDelta = after.total_attributed - before.total_attributed;

  assert.strictEqual(delta.healthy, EXPECTED_SEED_DELTA.healthy, "healthy delta (hook-input)");
  assert.strictEqual(
    delta.attribution_loss,
    EXPECTED_SEED_DELTA.attribution_loss,
    "attribution_loss delta (subagent-stop-missing)",
  );
  assert.strictEqual(
    delta.literal_omission,
    EXPECTED_SEED_DELTA.literal_omission,
    "literal_omission delta (truncated_completion + completion-missing)",
  );
  assert.strictEqual(
    delta.synthesized,
    EXPECTED_SEED_DELTA.synthesized,
    "synthesized delta (completion-synthesized + conversation-only + cron-derived + agent-id-missing)",
  );
  // NULL 행은 total_attributed 에 미반영 → 9행 적재했지만 delta 는 8.
  assert.strictEqual(totalDelta, EXPECTED_SEED_DELTA.total, "total_attributed delta = 8 (NULL excluded)");
});

// window summary 4-category + total 추출 헬퍼.
function sumCategories(body: AttributionDailyResponse): {
  healthy: number;
  attribution_loss: number;
  literal_omission: number;
  synthesized: number;
  total_attributed: number;
} {
  // window_summary 는 rate(분수)만 노출 → category 카운트는 days_series 합으로 재구성.
  let healthy = 0;
  let attribution_loss = 0;
  let literal_omission = 0;
  let synthesized = 0;
  for (const p of body.days_series) {
    healthy += p.healthy;
    attribution_loss += p.attribution_loss;
    literal_omission += p.literal_omission;
    synthesized += p.synthesized;
  }
  return {
    healthy,
    attribution_loss,
    literal_omission,
    synthesized,
    total_attributed: body.window_summary.total_attributed,
  };
}

// phantom 기대 seed 용 빈 band 탐색 — subagent-stop-missing 의 record_ts ±5분 안에
// 실 SubagentStop 이 있으면 route 가 genuine loss 로 승격시켜 phantom 기대가 깨진다
// (고정 offset 은 과거 실 활동과 충돌 가능 — 환경 결합 flake). agent_events 는
// NOW 시점에만 append → seed 시점에 빈 과거 band 는 이후에도 빈다. ±6분 probe
// (qualification ±5분 + inter-query 시계 드리프트 여유) · 전체 Stop 카운트(센티넬
// 포함)는 비-센티넬 한정 qualification 의 보수적 상위집합.
async function findUnbackedMinutesOffset(fromMinutes: number): Promise<number> {
  const prisma = getPrisma();
  // step 17 — 인접 probe band(±6분) 비중첩 + 7일 fetch window 내부 유지.
  for (let offset = fromMinutes; offset + 6 < 7 * 24 * 60; offset += 17) {
    const lowerMinutes = offset + 6;
    const upperMinutes = offset - 6;
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n
      FROM core.agent_events
      WHERE event_name = 'SubagentStop'
        AND event_ts BETWEEN NOW() - (${lowerMinutes}::int * INTERVAL '1 minute')
                         AND NOW() - (${upperMinutes}::int * INTERVAL '1 minute')
    `;
    if ((rows[0]?.n ?? 0n) === 0n) {
      return offset;
    }
  }
  throw new Error("no SubagentStop-free band inside the 7-day window");
}

// 두 번째 seed 배치 — 첫 배치와 동일 구성(8 canonical + 1 NULL)이되 record_ts/agent/cid
// 모두 distinct 하여 dedup 무충돌. delta 측정 대상.
async function seedSecondBatch(): Promise<void> {
  const prisma = getPrisma();
  for (let i = 0; i < CANONICAL_SOURCE_CATEGORY.length; i++) {
    const entry = CANONICAL_SOURCE_CATEGORY[i];
    if (entry === undefined) continue;
    const [source] = entry;
    const cid = `${SUITE_MARKER}-b2-canon-${i}`;
    // subagent-stop-missing 은 phantom(=synthesized) 기대 → 빈 band 필수. 나머지
    // source 는 backing 무관 분류 → 고정 offset(첫 배치 시간 단위와 비중첩) 유지.
    const minutesAgo =
      source === "subagent-stop-missing" ? await findUnbackedMinutesOffset(620) : i + 600;
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, summary, attribution_source, cid)
      VALUES
        (NOW() - (${minutesAgo}::int * INTERVAL '1 minute'),
         ${`attr-daily-b2-agent-${i}`},
         'feature'::core."TaskType",
         'done'::core."OutcomeResult",
         'attribution-daily regression seed b2',
         ${source},
         ${cid})
    `;
  }
  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, attribution_source, cid)
    VALUES
      (NOW() - (599::int * INTERVAL '1 minute'),
       'attr-daily-b2-agent-null',
       'feature'::core."TaskType",
       'done'::core."OutcomeResult",
       'attribution-daily regression seed b2 (null source)',
       NULL,
       ${`${SUITE_MARKER}-b2-null`})
  `;
}

// (e) R2 honest attribution_loss — genuine (backed) vs phantom (unbacked) split
test("subagent-stop-missing: unbacked → synthesized, backed by real SubagentStop → attribution_loss", async () => {
  const before = sumCategories(await fetchWindowSummary());

  await seedGenuineAndPhantomLoss();

  const after = sumCategories(await fetchWindowSummary());

  // 한 행만 backing agent_event(genuine) → attribution_loss +1.
  assert.strictEqual(
    after.attribution_loss - before.attribution_loss,
    1,
    "only the BACKED subagent-stop-missing row counts as genuine attribution_loss",
  );
  // unbacked subagent-stop-missing + sentinel-backed 행은 phantom → synthesized +2.
  assert.strictEqual(
    after.synthesized - before.synthesized,
    2,
    "unbacked + sentinel-agent-backed subagent-stop-missing rows fold to synthesized",
  );
  // 3 outcomes 모두 비-NULL → total_attributed +3.
  assert.strictEqual(
    after.total_attributed - before.total_attributed,
    3,
    "3 non-null subagent-stop-missing outcomes counted in total",
  );
});

// genuine/phantom 검증용 3 outcome + 1 backing agent_event seed:
//   (1) backed: subagent-stop-missing + 같은 시각(±5min) 실 SubagentStop(non-sentinel
//       agent_type) → genuine attribution_loss.
//   (2) unbacked: subagent-stop-missing, 매칭 agent_event 없음 → phantom → synthesized.
//   (3) sentinel-backed: subagent-stop-missing + SubagentStop(agent_type=
//       'subagent_stop_missing' 센티넬) → 실 서브에이전트 아님 → phantom → synthesized.
async function seedGenuineAndPhantomLoss(): Promise<void> {
  const prisma = getPrisma();

  // (1) genuine — outcome + 1분 전 backing SubagentStop(non-sentinel agent_type).
  const genuineCid = `${SUITE_MARKER}-genuine`;
  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, attribution_source, cid)
    VALUES
      (NOW() - (120::int * INTERVAL '1 minute'),
       'attr-daily-genuine-agent',
       'feature'::core."TaskType",
       'done'::core."OutcomeResult",
       'attribution-daily genuine loss seed',
       'subagent-stop-missing',
       ${genuineCid})
  `;
  // ±5min window 내부(outcome record_ts 119분 전) · non-sentinel agent_type · agent_id
  // 에 SUITE_MARKER → cleanup 표식. event_name='SubagentStop'.
  await prisma.$executeRaw`
    INSERT INTO core.agent_events (event_ts, event_name, agent_id, agent_type)
    VALUES
      (NOW() - (119::int * INTERVAL '1 minute'),
       'SubagentStop',
       ${`${SUITE_MARKER}-genuine-evt`},
       'dev-nestjs')
  `;

  // (2) unbacked — outcome 만(매칭 agent_event 없음). phantom 기대 → 빈 band 필수.
  const phantomMinutes = await findUnbackedMinutesOffset(200);
  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, attribution_source, cid)
    VALUES
      (NOW() - (${phantomMinutes}::int * INTERVAL '1 minute'),
       'attr-daily-phantom-agent',
       'feature'::core."TaskType",
       'done'::core."OutcomeResult",
       'attribution-daily phantom loss seed',
       'subagent-stop-missing',
       ${`${SUITE_MARKER}-phantom`})
  `;

  // (3) sentinel-backed — outcome + SubagentStop 이지만 agent_type 이 센티넬 → genuine
  // 아님. phantom 기대 → 빈 band 필수 ((2) band 와 +17 비중첩 — 자체 센티넬 event 가
  // (2) 의 qualification band 에 진입하지 않음).
  const sentinelMinutes = await findUnbackedMinutesOffset(phantomMinutes + 17);
  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, attribution_source, cid)
    VALUES
      (NOW() - (${sentinelMinutes}::int * INTERVAL '1 minute'),
       'attr-daily-sentinel-agent',
       'feature'::core."TaskType",
       'done'::core."OutcomeResult",
       'attribution-daily sentinel-backed loss seed',
       'subagent-stop-missing',
       ${`${SUITE_MARKER}-sentinel`})
  `;
  const sentinelEventMinutes = sentinelMinutes - 1;
  await prisma.$executeRaw`
    INSERT INTO core.agent_events (event_ts, event_name, agent_id, agent_type)
    VALUES
      (NOW() - (${sentinelEventMinutes}::int * INTERVAL '1 minute'),
       'SubagentStop',
       ${`${SUITE_MARKER}-sentinel-evt`},
       'subagent_stop_missing')
  `;
}
