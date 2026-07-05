// Regression tests for the /cross-analysis reconstructed-row KPI split.
// Runner: npx tsx --test test/outcomes.reconstructed-split.route.test.ts
//
// Pinned invariants:
//   (a) by_result rows carry reconstructed_count — a row counts as reconstructed
//       when downgrade_origin='synthesized' OR attribution_source IN
//       (completion-synthesized, budget-truncation, structuredoutput-derived);
//       each OR arm qualifies alone.
//   (b) `count` keeps its original ALL-rows semantics (additive shape change) —
//       0 <= reconstructed_count <= count; writer-emitted = count - reconstructed_count.
//   (c) /search response shape is UNCHANGED — no reconstructed_count leaks onto
//       search rows (the split is /cross-analysis-only per contract).
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
const SUITE_MARKER = `reconstructed-split-test-${randomUUID()}`;
let app: FastifyInstance;

// Seed 설계 — 판별식의 각 arm 을 독립 검증:
//   done_with_concerns × 4: writer 2 (hook-input, downgrade_origin NULL)
//     + reconstructed 2 (완전 합성행: downgrade_origin+attribution 동시 / budget-truncation arm 단독)
//   done × 4: writer 1 (hook-input) + reconstructed 3
//     (downgrade_origin arm 단독, attribution NULL
//      / schema-mode 실전형: structuredoutput-derived + synthesized 양쪽 필드
//      / structuredoutput-derived attribution arm 단독 — origin NULL 에도 fold 유지)
interface SeedRow {
  result: "done" | "done_with_concerns";
  attribution_source: string | null;
  downgrade_origin: string | null;
}

const SEED_ROWS: readonly SeedRow[] = [
  { result: "done_with_concerns", attribution_source: "hook-input", downgrade_origin: null },
  { result: "done_with_concerns", attribution_source: "hook-input", downgrade_origin: null },
  {
    result: "done_with_concerns",
    attribution_source: "completion-synthesized",
    downgrade_origin: "synthesized",
  },
  { result: "done_with_concerns", attribution_source: "budget-truncation", downgrade_origin: null },
  { result: "done", attribution_source: "hook-input", downgrade_origin: null },
  { result: "done", attribution_source: null, downgrade_origin: "synthesized" },
  {
    result: "done",
    attribution_source: "structuredoutput-derived",
    downgrade_origin: "synthesized",
  },
  { result: "done", attribution_source: "structuredoutput-derived", downgrade_origin: null },
] as const;

const DWC_TOTAL = 4;
const DWC_RECONSTRUCTED = 2;
const DONE_TOTAL = 4;
const DONE_RECONSTRUCTED = 3;

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
  // DB scrub — seed 행만 제거(cid 에 SUITE_MARKER). 동시 세션 행 보존.
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`
      DELETE FROM core.outcomes WHERE cid LIKE ${`%${SUITE_MARKER}%`}
    `;
  } catch (error) {
    console.error("[reconstructed-split-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
});

async function seedRows(): Promise<void> {
  const prisma = getPrisma();
  for (let i = 0; i < SEED_ROWS.length; i++) {
    const row = SEED_ROWS[i];
    if (row === undefined) continue;
    const cid = `${SUITE_MARKER}-${i}`;
    const minutesAgo = i + 1; // 1..6 분 전 — window 무관(days=all 조회).
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, summary,
         attribution_source, downgrade_origin, cid)
      VALUES
        (NOW() - (${minutesAgo}::int * INTERVAL '1 minute'),
         ${`reconstructed-split-agent-${i}`},
         'feature'::core."TaskType",
         ${row.result}::core."OutcomeResult",
         ${`reconstructed-split seed ${row.result} ${SUITE_MARKER}`},
         ${row.attribution_source},
         ${row.downgrade_origin}::core."DowngradeOrigin",
         ${cid})
    `;
  }
}

// include_all=1 — 합성 비-레지스트리 seed agent(reconstructed-split-agent-*)를 O2
// 레지스트리 게이트 밖(forensic 뷰)에서 조회. 이 스위트의 관심사(by_result 분해)와 직교.
async function fetchCrossAnalysisSeed(): Promise<OutcomeCrossAnalysisResponse> {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/cross-analysis?days=all&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200, "/cross-analysis must be 200");
  return res.json() as OutcomeCrossAnalysisResponse;
}

// (a) 판별식 — 두 OR arm 각각 단독으로 reconstructed 판정.

test("/cross-analysis by_result splits reconstructed rows per discriminator (both OR arms)", async () => {
  const body = await fetchCrossAnalysisSeed();
  const byResult = new Map(body.by_result.map((r) => [r.result, r]));

  const dwc = byResult.get("done_with_concerns");
  assert.ok(dwc, "done_with_concerns bucket present");
  assert.strictEqual(dwc.count, DWC_TOTAL, "count keeps ALL-rows semantics (writer + reconstructed)");
  // 완전 합성행(양쪽 필드) 1 + budget-truncation arm 단독 1 = 2 (행 단위 카운트, 이중집계 없음).
  assert.strictEqual(
    dwc.reconstructed_count,
    DWC_RECONSTRUCTED,
    "reconstructed = synthesized row + budget-truncation-only row (attribution arm alone qualifies)",
  );

  const done = byResult.get("done");
  assert.ok(done, "done bucket present");
  assert.strictEqual(done.count, DONE_TOTAL);
  // downgrade arm 단독 1 + schema-mode 실전형(양쪽 필드) 1
  // + structuredoutput-derived attribution arm 단독 1 = 3 (행 단위, 이중집계 없음).
  assert.strictEqual(
    done.reconstructed_count,
    DONE_RECONSTRUCTED,
    "downgrade-origin-only + full schema-mode row + structuredoutput-derived-only rows each fold to reconstructed",
  );
});

// (b) 불변식 — 모든 행에서 0 <= reconstructed_count <= count (writer 도출 안전).

test("/cross-analysis by_result rows all carry 0 <= reconstructed_count <= count", async () => {
  const body = await fetchCrossAnalysisSeed();
  assert.ok(body.by_result.length >= 2, "seed produces at least the 2 result buckets");
  for (const row of body.by_result) {
    assert.strictEqual(
      typeof row.reconstructed_count,
      "number",
      `${row.result}: reconstructed_count is a number on every row`,
    );
    assert.ok(row.reconstructed_count >= 0, `${row.result}: reconstructed_count >= 0`);
    assert.ok(
      row.reconstructed_count <= row.count,
      `${row.result}: reconstructed_count <= count (writer = count - reconstructed stays >= 0)`,
    );
  }
});

// (c) /search 응답 shape 불변 — 분리는 /cross-analysis 전용 계약.

test("/search response shape unchanged — rows carry no reconstructed_count", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/search?days=all&limit=200&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200, "/search must be 200");
  const body = res.json() as OutcomeSearchResponse;

  assert.deepStrictEqual(
    Object.keys(body).sort(),
    ["fetched_at", "filter", "rows", "total"],
    "top-level /search envelope keys unchanged",
  );
  assert.strictEqual(body.total, SEED_ROWS.length, "all seed rows visible in /search");
  for (const row of body.rows) {
    assert.ok(
      !("reconstructed_count" in row),
      "search rows must NOT grow a reconstructed_count field",
    );
    // 기존 필드는 유지 — raw attribution_source verbatim 노출 계약.
    assert.ok("attribution_source" in row, "search rows keep attribution_source");
    assert.ok("downgrade_origin" in row, "search rows keep downgrade_origin");
  }
});
