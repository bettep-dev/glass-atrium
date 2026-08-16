// Regression tests for the /cross-analysis synthesized-row exclusion from the
// quality signal (DWC-share numerator + denominator).
// Runner: npx tsx --test test/outcomes.synthesized-quality-exclusion.route.test.ts
//
// Pinned invariants:
//   (a) `reconstructed_total` — the response-level denominator subtrahend — is exactly
//       the population named by downgrade_origin='synthesized'; the writer-emitted
//       denominator is total - reconstructed_total.
//   (b) by_result rows carry `writer_open_count` — writer-emitted AND unclosed — so a
//       result bucket whose whole population is synthesized contributes nothing to the
//       quality numerator.
//   (c) The structuredoutput-derived exception (result='done', origin='synthesized')
//       needs no special case: one predicate covers both synthesis channels.
//
// Expectations are derived from SEED_ROWS on both sides — no maintained literal counts.
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

const SUITE_MARKER = `synthesized-quality-test-${randomUUID()}`;
const SYNTHESIZED_ORIGIN = "synthesized";
let app: FastifyInstance;

// Seed 설계 — 합성 3채널 + writer 대조군. 모든 합성행이 downgrade_origin 을 싣는 이유는
// buildReconstructedRowFilter() 가 기대는 전제를 그대로 재현하기 위해서다:
// downgrade_origin='synthesized' 와 합성 채널 집합(attribution-sources.ts 의
// RECONSTRUCTED_ATTRIBUTION_SOURCES)이 양방향으로 일치한다 — 즉 판별식이 attribution 이
// 아닌 provenance 로 잠긴다. 라이브에서 이 전제가 아직 유지되는지는 두 반대 방향 질의로
// 재도출한다(건수 census 아님 — 양쪽 모두 0행이라는 부재 확인):
//   (i)  attribution_source ∈ 채널집합 AND downgrade_origin IS DISTINCT FROM 'synthesized'
//   (ii) downgrade_origin = 'synthesized' AND attribution_source NOT IN 채널집합
// (i) 이 0 → provenance 가 필요조건, (ii) 가 0 → 충분조건. 어느 한쪽이라도 행이 나오면
// buildReconstructedRowFilter() 의 OR 두 팔이 갈라진 것이므로 이 seed 의 전제가 깨진다.
//   done_with_concerns: writer + 합성(completion-synthesized)
//   done              : writer + 합성(structuredoutput-derived — 문서화된 예외)
//   blocked           : 합성 단독(writer 대조군 없음) — track-outcome.sh 의
//                       rate-limit/timeout/quota 키워드 분기가 고르는 result
interface SeedRow {
  result: "done" | "done_with_concerns" | "blocked";
  attribution_source: string;
  downgrade_origin: string | null;
}

const SEED_ROWS: readonly SeedRow[] = [
  { result: "done_with_concerns", attribution_source: "hook-input", downgrade_origin: null },
  {
    result: "done_with_concerns",
    attribution_source: "completion-synthesized",
    downgrade_origin: SYNTHESIZED_ORIGIN,
  },
  { result: "done", attribution_source: "hook-input", downgrade_origin: null },
  {
    result: "done",
    attribution_source: "structuredoutput-derived",
    downgrade_origin: SYNTHESIZED_ORIGIN,
  },
  {
    result: "blocked",
    attribution_source: "completion-synthesized",
    downgrade_origin: SYNTHESIZED_ORIGIN,
  },
] as const;

function writerSeeds(): readonly SeedRow[] {
  return SEED_ROWS.filter((row) => row.downgrade_origin !== SYNTHESIZED_ORIGIN);
}

before(async () => {
  app = Fastify({ logger: false });
  await registerOutcomesRoutes(app);
  await app.ready();
  await seedRows();
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`
      DELETE FROM core.outcomes WHERE cid LIKE ${`%${SUITE_MARKER}%`}
    `;
  } catch (error) {
    console.error("[synthesized-quality-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
});

async function seedRows(): Promise<void> {
  const prisma = getPrisma();
  for (let i = 0; i < SEED_ROWS.length; i++) {
    const row = SEED_ROWS[i];
    if (row === undefined) continue;
    const minutesAgo = i + 1; // window 무관(days=all 조회).
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, summary,
         attribution_source, downgrade_origin, cid)
      VALUES
        (NOW() - (${minutesAgo}::int * INTERVAL '1 minute'),
         ${`synthesized-quality-agent-${i}`},
         'feature'::core."TaskType",
         ${row.result}::core."OutcomeResult",
         ${`synthesized-quality seed ${row.result} ${SUITE_MARKER}`},
         ${row.attribution_source},
         ${row.downgrade_origin}::core."DowngradeOrigin",
         ${`${SUITE_MARKER}-${i}`})
    `;
  }
}

// include_all=1 — 합성 비-레지스트리 seed agent 를 forensic 뷰에서 조회(레지스트리 게이트와 직교).
async function fetchCrossAnalysisSeed(): Promise<OutcomeCrossAnalysisResponse> {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/cross-analysis?days=all&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200, "/cross-analysis must be 200");
  return res.json() as OutcomeCrossAnalysisResponse;
}

// (a) 분모 — 제외 모집단은 'synthesized' provenance 그 자체.

test("/cross-analysis reconstructed_total names the synthesized provenance as the excluded population", async () => {
  const body = await fetchCrossAnalysisSeed();

  assert.strictEqual(
    body.reconstructed_total,
    body.downgrade_breakdown.synthesized,
    "the excluded population is exactly the rows whose downgrade_origin is 'synthesized'",
  );
  assert.strictEqual(
    body.total - body.reconstructed_total,
    writerSeeds().length,
    "writer-emitted denominator = total minus every synthesized row",
  );
});

// (b) 분자 — 결과 버킷별 writer 발신 미종결 건수.

test("/cross-analysis by_result writer_open_count excludes synthesized rows from every bucket", async () => {
  const body = await fetchCrossAnalysisSeed();
  assert.ok(body.by_result.length > 0, "seed produces at least one result bucket");

  for (const row of body.by_result) {
    const writerRowsForResult = writerSeeds().filter((seed) => seed.result === row.result);
    assert.strictEqual(
      row.writer_open_count,
      writerRowsForResult.length,
      `${row.result}: numerator counts writer-emitted open rows only`,
    );
    assert.ok(
      row.writer_open_count <= row.count - row.reconstructed_count,
      `${row.result}: writer_open_count never exceeds the writer-emitted population`,
    );
  }
});

test("/cross-analysis a wholly synthesized result bucket contributes nothing to the numerator", async () => {
  const body = await fetchCrossAnalysisSeed();
  const byResult = new Map(body.by_result.map((row) => [row.result, row]));

  // blocked seed 는 합성 단독 — rate-limit 절단 분기가 DWC 가 아닌 result 를 고르는 실재 경로.
  const blocked = byResult.get("blocked");
  assert.ok(blocked, "blocked bucket present");
  assert.strictEqual(blocked.writer_open_count, 0, "no writer-emitted blocked row exists in the seed");
});

// (c) 문서화된 예외 — structuredoutput-derived(result=done)도 같은 판별식으로 제외.

test("/cross-analysis excludes the structuredoutput-derived done row by the same predicate", async () => {
  const body = await fetchCrossAnalysisSeed();
  const done = body.by_result.find((row) => row.result === "done");
  assert.ok(done, "done bucket present");

  const syntheticDoneSeeds = SEED_ROWS.filter(
    (seed) => seed.result === "done" && seed.downgrade_origin === SYNTHESIZED_ORIGIN,
  );
  assert.ok(
    syntheticDoneSeeds.some((seed) => seed.attribution_source === "structuredoutput-derived"),
    "the seed carries the documented done-result synthesis exception",
  );
  assert.strictEqual(
    done.count - done.writer_open_count,
    syntheticDoneSeeds.length,
    "the schema-mode recovery row is excluded without a result-specific special case",
  );
});
