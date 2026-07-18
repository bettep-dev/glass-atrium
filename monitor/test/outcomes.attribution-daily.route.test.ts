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
//   (b) NULL attribution_source rows excluded from totals (seed delta = 10, not 11)
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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { resetAgentRegistryCache } from "../src/server/agents/registry.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import {
  buildDevScopeSummary,
  categorizeAttributionSource,
  pivotAttributionDaily,
  registerOutcomesRoutes,
} from "../src/server/routes/outcomes.js";
import type {
  AttributionDailyResponse,
  OutcomesErrorBody,
} from "../src/server/types/outcomes.js";

// SUITE_MARKER — 각 seed 행 cid 컬럼에 박아 cleanup + delta 측정 기준으로 사용.
const SUITE_MARKER = `attr-daily-test-${randomUUID()}`;
let app: FastifyInstance;

// CHECK-canonical attribution_source → expected category (route 의 진실 매핑 거울,
// route categorizeAttributionSource() 와 1:1 일치). budget-truncation 만 제외 —
// pure-fn 레벨 검증 (아래 (f)/(g) 테스트, live CHECK 미admit 사유 그쪽 주석 참조).
// subagent-stop-missing expected category 는 backing agent_events 유무 의존:
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
  // schema-mode recovery artifact — writer-unverified StructuredOutput emit.
  ["structuredoutput-derived", "synthesized"],
  // schema-mode WRITER recovery — a valid [COMPLETION] recovered from the SO input's
  // completion_block field (writer-emitted, NOT synthesized) → healthy.
  ["structuredoutput-completion", "healthy"],
];

// Expected per-category contribution of the 11-row seed (10 non-null one-each +
// 1 NULL excluded), with NO agent_events backing: healthy 2 (hook-input +
// structuredoutput-completion) · attribution_loss 0 (subagent-stop-missing has no
// backing → reclassified phantom/synthesized) · literal_omission 2 · synthesized 6 ·
// total_attributed delta 10 (NULL never counted).
const EXPECTED_SEED_DELTA: Readonly<Record<Category, number>> & { total: number } = {
  healthy: 2,
  attribution_loss: 0,
  literal_omission: 2,
  synthesized: 6,
  total: 10,
};

// Registry-membership scope was added to the route's outer query — this suite's
// seeded agent literals are synthetic (not real registered agents), so a
// hermetic AGENT_REGISTRY_PATH fixture registers every literal this file seeds
// as a canonical member; otherwise the real registry would exclude them all and
// collapse every delta in this suite to 0. Closed, enumerable set: the two
// index-templated batches (0..CANONICAL_SOURCE_CATEGORY.length-1) plus the 5
// fixed literals used by the NULL-row and genuine/phantom/sentinel-backing tests.
const TEMPLATED_AGENT_NAMES = Array.from(
  { length: CANONICAL_SOURCE_CATEGORY.length },
  (_, i) => `attr-daily-agent-${i}`,
).concat(
  Array.from({ length: CANONICAL_SOURCE_CATEGORY.length }, (_, i) => `attr-daily-b2-agent-${i}`),
);
const FIXTURE_AGENT_NAMES = [
  ...TEMPLATED_AGENT_NAMES,
  "attr-daily-agent-null",
  "attr-daily-b2-agent-null",
  "attr-daily-genuine-agent",
  "attr-daily-phantom-agent",
  "attr-daily-sentinel-agent",
  // literal_omission_breakdown route test (h/i) seed agents.
  "attr-daily-brk-agent-a",
  "attr-daily-brk-agent-b",
  // dev_scope route test (j) — a DEV-prefixed agent (in the subset) + a non-DEV
  // agent (registered so it counts in the all-agent total, excluded from dev_scope).
  "glass-atrium-dev-attrtest",
  "attr-daily-devscope-nondev",
];
const REGISTRY_FIXTURE = {
  $schema: "agent-registry",
  version: "1.1",
  agents: Object.fromEntries(
    FIXTURE_AGENT_NAMES.map((name) => [
      name,
      { domains: ["test"], phase: "implementation", dual_phase: false },
    ]),
  ),
};

let tmpRoot: string;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "attr-daily-registry-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

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
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
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

// 첫 seed 배치 적재. record_ts 는 7일 window 안 + 미래 아님(NOW 직전) + 행별 distinct
// (outcomes_dedup UNIQUE(record_ts, agent, task_type) 충돌 회피 — agent 도 행별로 다름).
// 10 canonical(category 검증용) + 1 NULL(제외 검증용). cid = SUITE_MARKER 표식.
async function seedFirstBatch(): Promise<void> {
  const prisma = getPrisma();
  // canonical 10 행 — record_ts 를 1분 간격으로 어긋나게(NOW - (idx+2) hours) 두어
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
  await seedFirstBatch();
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
test("seed delta: each canonical source → correct category · NULL excluded · total delta = 10", async () => {
  // pre-seed snapshot. 동시 세션 행은 pre/post 양쪽에 동일하게 존재 → delta 에서 상쇄.
  // (seedFirstBatch 는 이전 테스트에서 이미 호출됨 — 멱등 측정 위해 cleanup 후 재측정 대신
  //  추가 11행 적재 후 증분 측정 · record_ts/agent/cid 가 distinct 라 dedup 무충돌)
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

  assert.strictEqual(
    delta.healthy,
    EXPECTED_SEED_DELTA.healthy,
    "healthy delta (hook-input + structuredoutput-completion)",
  );
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
    "synthesized delta (completion-synthesized + conversation-only + cron-derived + agent-id-missing + structuredoutput-derived)",
  );
  // NULL 행은 total_attributed 에 미반영 → 11행 적재했지만 delta 는 10.
  assert.strictEqual(totalDelta, EXPECTED_SEED_DELTA.total, "total_attributed delta = 10 (NULL excluded)");
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

// 두 번째 seed 배치 — 첫 배치와 동일 구성(10 canonical + 1 NULL)이되 record_ts/agent/cid
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

// (f) budget-truncation categorization (T4 consumer contract) — a subagent
// hard-killed at its tool_use budget ceiling emits attribution_source
// 'budget-truncation'; it MUST bucket into 'literal_omission' (a named cause of a
// truncated completion), NOT the generic 'synthesized' catch-all, so budget-kills
// stay distinguishable + countable rather than indistinguishable from ordinary
// completion-synthesized rows.
//
// Verified at the pure-fn level (not a route seed) by necessity: the
// outcomes_attribution_source_check CHECK (NOT VALID, 8 canonical values) does not
// yet admit 'budget-truncation', so an INSERT would violate the constraint. The
// constraint expansion is a sibling DB task; this pins the consumer-side
// categorization regardless of the constraint's current state.
test("budget-truncation → literal_omission (not the synthesized catch-all)", () => {
  assert.strictEqual(
    categorizeAttributionSource("budget-truncation"),
    "literal_omission",
    "budget-truncation must be a distinguishable literal_omission, not synthesized",
  );
});

// Regression guard — the budget-truncation addition must not perturb the existing
// named-source mappings, and an unlisted value must still fold to the catch-all
// (sum-completeness preserved). subagent-stop-missing is omitted here: its category
// is query-qualified against agent_events backing (covered by the (e) route test).
test("existing named sources keep categories; unknown still → synthesized", () => {
  assert.strictEqual(categorizeAttributionSource("hook-input"), "healthy");
  assert.strictEqual(categorizeAttributionSource("truncated_completion"), "literal_omission");
  assert.strictEqual(categorizeAttributionSource("completion-missing"), "literal_omission");
  assert.strictEqual(categorizeAttributionSource("completion-synthesized"), "synthesized");
  assert.strictEqual(categorizeAttributionSource("conversation-only"), "synthesized");
  assert.strictEqual(categorizeAttributionSource("cron-derived"), "synthesized");
  assert.strictEqual(categorizeAttributionSource("agent-id-missing"), "synthesized");
  // schema-mode recovery artifact — explicit member, NOT catch-all-reliant.
  assert.strictEqual(categorizeAttributionSource("structuredoutput-derived"), "synthesized");
  assert.strictEqual(categorizeAttributionSource("some-future-unknown-source"), "synthesized");
});

// (g) literal_omission_breakdown split — pure-fn (pivot) level. A budget-truncation
// row increments ONLY the budget_truncation sub-count (never truncated_completion /
// completion_missing), and the three sub-counts SUM to the literal_omission total.
// Pure-fn by necessity: outcomes_attribution_source_check rejects a
// 'budget-truncation' INSERT (constraint expansion is a sibling DB task), so a
// route seed of that value is impossible — this pins the consumer-side split
// regardless of the live constraint state (same rationale as test (f)).
test("pivot breakdown: budget-truncation increments budget_truncation only; sub-counts sum to literal_omission", () => {
  const { totals, breakdown } = pivotAttributionDaily([
    { day: "2026-07-01", attribution_source: "budget-truncation", cnt: 3n },
    { day: "2026-07-01", attribution_source: "truncated_completion", cnt: 2n },
    { day: "2026-07-01", attribution_source: "completion-missing", cnt: 1n },
    { day: "2026-07-01", attribution_source: "hook-input", cnt: 5n },
  ]);
  assert.strictEqual(breakdown.budget_truncation, 3, "budget-truncation rows land in budget_truncation");
  assert.strictEqual(
    breakdown.truncated_completion,
    2,
    "truncated_completion sub-count unperturbed by budget-truncation",
  );
  assert.strictEqual(
    breakdown.completion_missing,
    1,
    "completion_missing sub-count unperturbed by budget-truncation",
  );
  const sum = breakdown.truncated_completion + breakdown.completion_missing + breakdown.budget_truncation;
  assert.strictEqual(sum, totals.literal_omission, "breakdown sub-counts sum to the literal_omission total");
  assert.strictEqual(totals.literal_omission, 6, "literal_omission = 3 + 2 + 1 (hook-input not counted)");
});

// literal_omission_breakdown route seed — 2 truncated_completion + 1
// completion-missing, all admitted by outcomes_attribution_source_check. distinct
// record_ts/agent/cid → no dedup collision; 30..32min ago → inside the 7-day window.
async function seedBreakdownRows(): Promise<void> {
  const prisma = getPrisma();
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["attr-daily-brk-agent-a", "truncated_completion"],
    ["attr-daily-brk-agent-a", "truncated_completion"],
    ["attr-daily-brk-agent-b", "completion-missing"],
  ];
  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i];
    if (entry === undefined) continue;
    const [agent, source] = entry;
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, summary, attribution_source, cid)
      VALUES
        (NOW() - (${i + 30}::int * INTERVAL '1 minute'),
         ${agent},
         'feature'::core."TaskType",
         'done'::core."OutcomeResult",
         'attribution-daily breakdown seed',
         ${source},
         ${`${SUITE_MARKER}-brk-${i}`})
    `;
  }
}

// (h) route literal_omission_breakdown — window_summary carries the raw-literal
// split of the literal_omission category. Regression lock: the sub-count deltas
// SUM to the literal_omission category delta, so literal_omission_rate is
// unperturbed by the additive breakdown field. budget_truncation stays 0 (no
// admitted row exists). Delta-measured (concurrent rows cancel).
test("route literal_omission_breakdown sub-counts sum to the literal_omission delta (regression lock)", async () => {
  const before = await fetchWindowSummary();
  await seedBreakdownRows();
  const after = await fetchWindowSummary();

  const loDelta = sumCategories(after).literal_omission - sumCategories(before).literal_omission;

  const b = before.window_summary.literal_omission_breakdown;
  const a = after.window_summary.literal_omission_breakdown;
  const tcDelta = a.truncated_completion - b.truncated_completion;
  const cmDelta = a.completion_missing - b.completion_missing;
  const btDelta = a.budget_truncation - b.budget_truncation;

  assert.strictEqual(tcDelta, 2, "2 truncated_completion rows increment truncated_completion");
  assert.strictEqual(cmDelta, 1, "1 completion-missing row increments completion_missing");
  assert.strictEqual(btDelta, 0, "no budget-truncation row admitted → budget_truncation unchanged");
  // Regression lock: the breakdown is a pure decomposition — the sub-count deltas
  // sum to the literal_omission category delta, so the existing total/rate is intact.
  assert.strictEqual(tcDelta + cmDelta + btDelta, loDelta, "breakdown deltas sum to the literal_omission delta");
  assert.strictEqual(loDelta, 3, "literal_omission increased by exactly the 3 seeded rows");
});

// (i) budget_truncation_by_agent — array contract. Live grouping data is
// unreachable until outcomes_attribution_source_check admits 'budget-truncation'
// (sibling DB task); with no such row in the window the group is [] and MUST NOT
// surface any seeded literal_omission agent (they are not budget-truncation).
test("budget_truncation_by_agent is an array, empty of non-budget-truncation agents", async () => {
  const body = await fetchWindowSummary();
  const byAgent = body.window_summary.budget_truncation_by_agent;
  assert.ok(Array.isArray(byAgent), "budget_truncation_by_agent is an array");
  for (const seededAgent of ["attr-daily-brk-agent-a", "attr-daily-brk-agent-b"]) {
    assert.ok(
      !byAgent.some((r) => r.agent === seededAgent),
      `${seededAgent} (a literal_omission agent) must not appear in budget_truncation_by_agent`,
    );
  }
});

// (j-pure) buildDevScopeSummary — the budget_truncation_rate path the route seed
// cannot reach (outcomes_attribution_source_check rejects 'budget-truncation'),
// plus the empty-window null-rate contract. Fed off the exported pivot so the
// denominator matches the parent aggregation exactly.
test("buildDevScopeSummary: rates over the sum-complete total; budget-truncation feeds the truncation rate", () => {
  const { totals, breakdown } = pivotAttributionDaily([
    { day: "2026-07-01", attribution_source: "budget-truncation", cnt: 2n },
    { day: "2026-07-01", attribution_source: "completion-synthesized", cnt: 3n },
    { day: "2026-07-01", attribution_source: "hook-input", cnt: 5n },
  ]);
  const dev = buildDevScopeSummary(totals, breakdown);
  // total = 2 (literal_omission) + 3 (synthesized) + 5 (healthy) = 10.
  assert.strictEqual(dev.total_attributed, 10, "total is the sum-complete denominator");
  assert.strictEqual(dev.budget_truncation_count, 2, "budget-truncation feeds the count");
  assert.strictEqual(dev.budget_truncation_rate, 0.2, "budget_truncation_rate = 2/10");
  assert.strictEqual(dev.synthesized_rate, 0.3, "synthesized_rate = 3/10");
  assert.strictEqual(dev.literal_omission_rate, 0.2, "literal_omission_rate = 2/10");
});

test("buildDevScopeSummary: empty DEV window → zero count + null rates (never fabricated 0)", () => {
  const { totals, breakdown } = pivotAttributionDaily([]);
  const dev = buildDevScopeSummary(totals, breakdown);
  assert.strictEqual(dev.total_attributed, 0, "empty window total is 0");
  assert.strictEqual(dev.budget_truncation_count, 0, "no rows → 0 count");
  assert.strictEqual(dev.budget_truncation_rate, null, "0 denominator → null rate");
  assert.strictEqual(dev.synthesized_rate, null, "0 denominator → null rate");
  assert.strictEqual(dev.literal_omission_rate, null, "0 denominator → null rate");
});

// dev_scope route seed — 2 completion-synthesized rows for a DEV-prefixed agent +
// 1 for a non-DEV (but registered) agent. All admitted by the CHECK constraint;
// distinct record_ts/cid → no dedup collision; 44..46min ago → inside the window.
async function seedDevScopeRows(): Promise<void> {
  const prisma = getPrisma();
  const rows: ReadonlyArray<readonly [string, number]> = [
    ["glass-atrium-dev-attrtest", 44],
    ["glass-atrium-dev-attrtest", 45],
    ["attr-daily-devscope-nondev", 46],
  ];
  for (let i = 0; i < rows.length; i++) {
    const entry = rows[i];
    if (entry === undefined) continue;
    const [agent, minutesAgo] = entry;
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, summary, attribution_source, cid)
      VALUES
        (NOW() - (${minutesAgo}::int * INTERVAL '1 minute'),
         ${agent},
         'feature'::core."TaskType",
         'done'::core."OutcomeResult",
         'attribution-daily dev_scope seed',
         'completion-synthesized',
         ${`${SUITE_MARKER}-dev-${i}`})
    `;
  }
}

// (j-route) dev_scope filter — the DEV-scoped subset counts ONLY registry DEV
// agents (glass-atrium-dev-* prefix). A non-DEV agent's row lands in the all-agent
// total but is EXCLUDED from dev_scope, so the two total deltas differ by exactly
// the non-DEV row. Delta-measured (concurrent rows cancel). Also asserts the
// dev_scope object shape is present + well-typed.
test("dev_scope excludes non-DEV agents: all-total delta - dev-total delta === non-DEV rows", async () => {
  const before = await fetchWindowSummary();
  const beforeAll = Number(before.window_summary.total_attributed);
  const beforeDev = Number(before.window_summary.dev_scope.total_attributed);

  await seedDevScopeRows();

  const after = await fetchWindowSummary();
  const afterAll = Number(after.window_summary.total_attributed);
  const afterDev = Number(after.window_summary.dev_scope.total_attributed);

  assert.strictEqual(afterAll - beforeAll, 3, "all-agent total counts all 3 seeded rows");
  assert.strictEqual(afterDev - beforeDev, 2, "dev_scope total counts only the 2 DEV-agent rows");
  assert.strictEqual(
    afterAll - beforeAll - (afterDev - beforeDev),
    1,
    "the 1 non-DEV row is excluded from dev_scope",
  );

  // Shape lock — the 5 dev_scope fields are present + correctly typed.
  const dev = after.window_summary.dev_scope;
  assert.strictEqual(typeof dev.total_attributed, "number", "total_attributed is a number");
  assert.strictEqual(typeof dev.budget_truncation_count, "number", "budget_truncation_count is a number");
  for (const rateField of ["synthesized_rate", "literal_omission_rate", "budget_truncation_rate"] as const) {
    const value = dev[rateField];
    assert.ok(value === null || typeof value === "number", `${rateField} is number | null`);
  }
});
