// Regression tests for the outcomes API grader-metrics root-fix.
// Runner: npx tsx --test test/outcomes.grader-metrics.route.test.ts
//
// Two pinned invariants:
//   (a) 9-type allowlist — the 4 new non-code types (review/diagnosis/doc/cleanup) survive the /search defensive flatMap guard, not silently dropped.
//   (b) /cross-analysis excludes legacy NULL grader_verdict rows from ratio denominators (graded_total), reporting them as `not_measured` → legacy rows can't contaminate the pass/fail metric.
//
// DB: real Postgres — seed summary carries SUITE_MARKER → ?q 한정 조회, cleanup 은 cid LIKE.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerOutcomesRoutes } from "../src/server/routes/outcomes.js";
import type {
  OutcomeCrossAnalysisResponse,
  OutcomeSearchResponse,
} from "../src/server/types/outcomes.js";

// SUITE_MARKER — summary(필터 키) + cid(cleanup 키) 양쪽에 삽입
const SUITE_MARKER = `grader-metrics-test-${randomUUID()}`;
let app: FastifyInstance;

// 9-type canonical set (SoT: rules/core-outcome-record.md). 마지막 4종이 이번 확장의
// 핵심 — guard 가 탈락시키면 안 됨.
const NINE_TASK_TYPES = [
  "bug-fix",
  "feature",
  "refactor",
  "research",
  "plan",
  "review",
  "diagnosis",
  "doc",
  "cleanup",
] as const;

const NEW_TASK_TYPES = ["review", "diagnosis", "doc", "cleanup"] as const;

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
  // DB scrub — seed 행만 제거(cid 에 SUITE_MARKER). 동시 세션 행 보존.
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`
      DELETE FROM core.outcomes WHERE cid LIKE ${`%${SUITE_MARKER}%`}
    `;
  } catch (error) {
    console.error("[grader-metrics-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
});

// 9 행 적재 — 9 task_type 각 1행, summary 에 SUITE_MARKER 표식 → ?q 한정 조회.
// grader_verdict: 첫 3행 verified_pass/unverified/verified_fail · 나머지 6행 NULL (legacy un-graded 모사).
// record_ts/agent/cid distinct → dedup 무충돌.
// seed 집합 = graded 3 (각 1) + not_measured 6 (NULL, ratio 분모 제외).
const GRADED_SEED_TOTAL = 3;
const NOT_MEASURED_SEED_TOTAL = 6;

async function seedNineTaskTypes(): Promise<void> {
  const prisma = getPrisma();
  // 첫 3행에만 grader_verdict 부여 — 나머지는 NULL.
  const verdicts: ReadonlyArray<string | null> = [
    "verified_pass",
    "unverified",
    "verified_fail",
    null,
    null,
    null,
    null,
    null,
    null,
  ];
  for (let i = 0; i < NINE_TASK_TYPES.length; i++) {
    const taskType = NINE_TASK_TYPES[i];
    if (taskType === undefined) continue;
    const verdict = verdicts[i] ?? null;
    const cid = `${SUITE_MARKER}-${i}`;
    const minutesAgo = i + 1; // 1..9 분 전 — window 무관(days 미지정 → 'all').
    if (verdict === null) {
      await prisma.$executeRaw`
        INSERT INTO core.outcomes
          (record_ts, agent, task_type, result, summary, cid)
        VALUES
          (NOW() - (${minutesAgo}::int * INTERVAL '1 minute'),
           ${`grader-metrics-agent-${i}`},
           ${taskType}::core."TaskType",
           'done'::core."OutcomeResult",
           ${`grader-metrics seed ${taskType} ${SUITE_MARKER}`},
           ${cid})
      `;
    } else {
      await prisma.$executeRaw`
        INSERT INTO core.outcomes
          (record_ts, agent, task_type, result, summary, grader_verdict, cid)
        VALUES
          (NOW() - (${minutesAgo}::int * INTERVAL '1 minute'),
           ${`grader-metrics-agent-${i}`},
           ${taskType}::core."TaskType",
           'done'::core."OutcomeResult",
           ${`grader-metrics seed ${taskType} ${SUITE_MARKER}`},
           ${verdict}::core."GraderVerdict",
           ${cid})
      `;
    }
  }
}

// seed 후 ?q=SUITE_MARKER 로 seed 집합만 조회하는 헬퍼. include_all=1 로 O2 레지스트리
// 게이트를 해제 — 이 스위트의 seed agent 는 합성 비-레지스트리 이름(grader-metrics-agent-*)
// 이라, 기본(레지스트리-스코프) /search 는 전부 숨긴다. 이 테스트의 관심사(flatMap guard /
// grader 컬럼 / poisoned_window 필드)는 레지스트리 게이트와 직교하므로 forensic 뷰가 정답.
async function fetchSearchSeed(): Promise<OutcomeSearchResponse> {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/search?days=all&limit=200&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200, "/search must be 200");
  return res.json() as OutcomeSearchResponse;
}

// include_all=1 lifts the O2 registry-membership gate (default-scoped since the
// FIX-RB1 sibling change) — this suite's seed agents (grader-metrics-agent-*)
// are synthetic non-registry names, and this suite's concern (grader_verdict
// breakdown / task_type crosstab) is orthogonal to registry membership.
async function fetchCrossAnalysisSeed(): Promise<OutcomeCrossAnalysisResponse> {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/cross-analysis?days=all&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200, "/cross-analysis must be 200");
  return res.json() as OutcomeCrossAnalysisResponse;
}

// (a) 9-type allowlist — the 4 NEW types pass the /search defensive guard.

test("all 9 task_types (esp. review/diagnosis/doc/cleanup) survive the /search allowlist guard", async () => {
  await seedNineTaskTypes();
  const body = await fetchSearchSeed();

  // seed 집합은 정확히 9행 — guard 가 한 종이라도 탈락시키면 9 미만.
  assert.strictEqual(
    body.total,
    NINE_TASK_TYPES.length,
    `seed set total must be ${NINE_TASK_TYPES.length} (no task_type dropped by the guard)`,
  );

  const returnedTypes = new Set(body.rows.map((r) => r.task_type));
  for (const tt of NINE_TASK_TYPES) {
    assert.ok(returnedTypes.has(tt), `task_type '${tt}' must appear in /search rows (not dropped)`);
  }
  // 회귀 핵심: 새 4종이 정확히 통과했는지 명시 확인.
  for (const tt of NEW_TASK_TYPES) {
    assert.ok(
      returnedTypes.has(tt),
      `NEW task_type '${tt}' must NOT be dropped by the defensive flatMap guard`,
    );
  }
});

// (a') task_type=<new type> filter param accepted (parseFilters allowlist).

test("task_type filter param accepts each of the 4 new types → 200", async () => {
  for (const tt of NEW_TASK_TYPES) {
    const res = await app.inject({
      method: "GET",
      url: `/api/outcomes/search?days=all&limit=1&task_type=${encodeURIComponent(tt)}`,
    });
    assert.strictEqual(res.statusCode, 200, `task_type=${tt} must be 200 (not 400 invalid_param)`);
  }
});

// (a'') new columns are SELECTed + returned + typed on /search rows.

test("/search rows carry grader_verdict + downgrade_origin (graded row has the verdict, legacy row NULL)", async () => {
  const body = await fetchSearchSeed();
  // 모든 행이 두 키 보유 — 타입 + SELECT 검증
  for (const row of body.rows) {
    assert.ok("grader_verdict" in row, "row must carry grader_verdict key");
    assert.ok("downgrade_origin" in row, "row must carry downgrade_origin key");
  }
  // verified_pass 를 부여한 seed 행이 정확히 그 값으로 돌아오는지.
  const graded = body.rows.filter((r) => r.grader_verdict !== null);
  assert.strictEqual(graded.length, GRADED_SEED_TOTAL, "exactly 3 seed rows are graded");
  const verdicts = new Set(graded.map((r) => r.grader_verdict));
  assert.ok(verdicts.has("verified_pass"), "verified_pass seed row returned");
  assert.ok(verdicts.has("unverified"), "unverified seed row returned");
  assert.ok(verdicts.has("verified_fail"), "verified_fail seed row returned");
});

// (b) artifact-vs-quality breakdown — NULL grader_verdict EXCLUDED from ratios.

test("/cross-analysis grader_breakdown excludes NULL rows from graded_total + ratio denominators", async () => {
  const body = await fetchCrossAnalysisSeed();
  const b = body.grader_breakdown;

  // seed 집합: graded 3 (각 1) + not_measured 6 (NULL).
  assert.strictEqual(b.verified_pass, 1, "verified_pass count");
  assert.strictEqual(b.unverified, 1, "unverified count");
  assert.strictEqual(b.verified_fail, 1, "verified_fail count");
  assert.strictEqual(
    b.not_measured,
    NOT_MEASURED_SEED_TOTAL,
    "legacy NULL rows reported as not_measured (not folded into fail)",
  );

  // 핵심 불변식 — graded_total 은 NULL 제외 → 3, NOT 9
  assert.strictEqual(
    b.graded_total,
    GRADED_SEED_TOTAL,
    "graded_total excludes NULL grader_verdict rows (3, not 9)",
  );

  // ratio 분모 = graded_total(3) — not_measured(6) 가 분모에 섞였다면 1/3 ≠ 값.
  assert.ok(b.verified_pass_rate !== null, "verified_pass_rate defined (graded_total > 0)");
  assert.strictEqual(
    b.verified_pass_rate,
    Math.round((1 / GRADED_SEED_TOTAL) * 1_000_000) / 1_000_000,
    "verified_pass_rate = 1/3 (denominator is graded_total, NOT graded_total + not_measured)",
  );
  assert.strictEqual(
    b.verified_fail_rate,
    Math.round((1 / GRADED_SEED_TOTAL) * 1_000_000) / 1_000_000,
    "verified_fail_rate = 1/3 (NULL rows NOT in the fail-rate denominator)",
  );

  // 3개 rate 합 ≈ 1.0 (분모 graded_total 일관) · 1/3 의 6-dp 반올림(0.333333)
  // 3회 누적 → 0.999999 · 라운딩 노이즈 허용폭 = 3 × 0.5e-6 = 1.5e-6 보다 약간 크게
  const rateSum =
    (b.verified_pass_rate ?? 0) + (b.unverified_rate ?? 0) + (b.verified_fail_rate ?? 0);
  assert.ok(Math.abs(rateSum - 1) < 5e-6, "the 3 graded rates sum to ~1.0 over graded_total");
});

// (b') ratio is null when graded_total is 0 — un-graded-only filtered set.

test("/cross-analysis grader_breakdown rates are null when no graded rows match", async () => {
  // task_type=doc 로 좁히되 q 로 seed 한정 → doc seed 1행은 NULL grader_verdict.
  // include_all=1 — synthetic non-registry seed agent, orthogonal to the O2 gate.
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/cross-analysis?days=all&task_type=doc&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as OutcomeCrossAnalysisResponse;
  const b = body.grader_breakdown;
  assert.strictEqual(b.graded_total, 0, "doc seed row is un-graded → graded_total 0");
  assert.strictEqual(b.not_measured, 1, "the un-graded doc seed row is counted as not_measured");
  assert.strictEqual(b.verified_pass_rate, null, "rate is null (undefined) when graded_total is 0");
  assert.strictEqual(b.verified_fail_rate, null, "fail rate null when graded_total is 0");
});

// (c) poisoned_window — /search 행 노출 + /cross-analysis 집계 제외 (F11).

test("/search rows carry poisoned_window; /cross-analysis excludes poisoned rows from aggregates", async () => {
  // poisoned seed 1행 추가 — summary 에 SUITE_MARKER → 동일 ?q 집합에 합류.
  const prisma = getPrisma();
  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, poisoned_window, cid)
    VALUES
      (NOW() - INTERVAL '30 seconds', 'grader-metrics-agent-poisoned',
       'bug-fix'::core."TaskType", 'done'::core."OutcomeResult",
       ${`grader-metrics seed poisoned ${SUITE_MARKER}`}, TRUE,
       ${`${SUITE_MARKER}-poisoned`})
  `;

  // /search — poisoned 행도 가시 (row badge 소스); boolean 필드 전 행 존재. include_all=1
  // 로 O2 게이트 해제 — 합성 비-레지스트리 seed agent 를 forensic 뷰에서 유지(위 헬퍼와 동일).
  const searchRes = await app.inject({
    method: "GET",
    url: `/api/outcomes/search?days=all&limit=200&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(searchRes.statusCode, 200);
  const searchBody = searchRes.json() as OutcomeSearchResponse;
  for (const row of searchBody.rows) {
    assert.ok(typeof row.poisoned_window === "boolean", "poisoned_window is boolean on every row");
  }
  const poisonedRows = searchBody.rows.filter((r) => r.poisoned_window);
  assert.strictEqual(poisonedRows.length, 1, "poisoned seed row visible in /search");

  // /cross-analysis — total 은 poisoned 제외 9, excluded_poisoned_count 는 1.
  // include_all=1 — synthetic non-registry seed agents, orthogonal to the O2 gate.
  const crossRes = await app.inject({
    method: "GET",
    url: `/api/outcomes/cross-analysis?days=all&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(crossRes.statusCode, 200);
  const crossBody = crossRes.json() as OutcomeCrossAnalysisResponse;
  assert.strictEqual(crossBody.total, 9, "aggregate population excludes the poisoned row");
  assert.strictEqual(crossBody.excluded_poisoned_count, 1, "exclusion disclosed for the chip");
  // by_result 합계도 poisoned 제외 population 과 일치 — 집계 전 쿼리 동일 predicate 검증.
  const byResultSum = crossBody.by_result.reduce((acc, r) => acc + r.count, 0);
  assert.strictEqual(byResultSum, 9, "by_result aggregates run on the excluded population");
});

// (d) task_type × grader_verdict 크로스탭 — '측정 분포' 9-type 렌더 지원 (F16).
// 테스트 (c) 이후 실행 — poisoned bug-fix 행이 존재하는 상태에서 크로스탭 제외를 같이 검증.

test("/cross-analysis task_type_grader_breakdown: 9행 고정 + verdict 매핑 + poisoned 제외", async () => {
  const body = await fetchCrossAnalysisSeed();
  const rows = body.task_type_grader_breakdown;

  // 항상 정확히 9행, TASK_TYPES 순서 고정 — 빈 타입도 zero-fill 로 존재.
  assert.strictEqual(rows.length, NINE_TASK_TYPES.length, "always exactly 9 rows");
  assert.deepStrictEqual(
    rows.map((r) => r.task_type),
    [...NINE_TASK_TYPES],
    "rows follow the canonical TASK_TYPES order",
  );

  // seed 매핑: bug-fix→verified_pass · feature→unverified · refactor→verified_fail · 나머지 6종 NULL→not_measured.
  const byType = new Map(rows.map((r) => [r.task_type, r]));
  assert.strictEqual(byType.get("bug-fix")?.verified_pass, 1, "bug-fix verified_pass seed");
  assert.strictEqual(byType.get("feature")?.unverified, 1, "feature unverified seed");
  assert.strictEqual(byType.get("refactor")?.verified_fail, 1, "refactor verified_fail seed");
  for (const tt of ["research", "plan", "review", "diagnosis", "doc", "cleanup"] as const) {
    assert.strictEqual(byType.get(tt)?.not_measured, 1, `${tt}: NULL verdict → not_measured`);
  }

  // poisoned bug-fix 행 (테스트 (c) seed) 은 크로스탭에서도 제외 — total 1, NOT 2.
  assert.strictEqual(byType.get("bug-fix")?.total, 1, "poisoned row excluded from the crosstab");

  // 합산 불변식: Σ row.total === 응답 total (poisoned 제외 population).
  const rowTotalSum = rows.reduce((acc, r) => acc + r.total, 0);
  assert.strictEqual(rowTotalSum, body.total, "crosstab row totals sum to the aggregate population");

  // by_design_unverified — 비코드 4종만 true (서버 선언, FE 하드코딩 금지 계약).
  const byDesignSet = new Set<string>(NEW_TASK_TYPES);
  for (const r of rows) {
    assert.strictEqual(
      r.by_design_unverified,
      byDesignSet.has(r.task_type),
      `${r.task_type}: by_design_unverified flags exactly the 4 non-code types`,
    );
  }
});
