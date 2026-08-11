// Regression tests for PATCH /api/outcomes/close-by-cid — the set-operation sibling of
// PATCH /api/outcomes/:id/close.
// Runner: npx tsx --test test/outcomes.close-by-cid.route.test.ts
//
// Pinned invariants:
//   (S1) Every OPEN done_with_concerns row sharing the cid closes in ONE call; the
//        response lists exactly the ids this call stamped.
//   (S2) Idempotent — a repeat returns 200 with an empty closed_ids and never re-stamps
//        the stored timestamp.
//   (S3) Scope — a non-DWC row carrying the SAME cid is untouched, and a DWC row on a
//        DIFFERENT cid stays open.
//   (S4) Empty / missing cid → 400 invalid_param; an unknown cid → 200 with an empty
//        list (no target is a normal set-operation outcome, not a 404).
//   (S5) Registry-independent — seed agents are outside the canonical registry and close
//        anyway (the mutation carries no membership gate).
//
// DB: real Postgres — seed cids carry SUITE_MARKER → cleanup 은 cid LIKE.
// 라이브 done_with_concerns 행은 절대 건드리지 않는다 (seed 행만 종결/삭제).

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerOutcomesRoutes } from "../src/server/routes/outcomes.js";
import type {
  OutcomeCloseByCidResponse,
  OutcomeSearchResponse,
} from "../src/server/types/outcomes.js";

const SUITE_MARKER = `close-by-cid-test-${randomUUID()}`;
// 대상 cid 2 DWC + 같은 cid 비-DWC 대조 1 · 형제 cid DWC 1 (범위 이탈 대조).
const TARGET_CID = `${SUITE_MARKER}-target`;
const SIBLING_CID = `${SUITE_MARKER}-sibling`;

const SEED_ROWS = [
  { cid: TARGET_CID, result: "done_with_concerns" },
  { cid: TARGET_CID, result: "done_with_concerns" },
  { cid: TARGET_CID, result: "done" },
  { cid: SIBLING_CID, result: "done_with_concerns" },
] as const;

const SEED_DWC_A = 0;
const SEED_DWC_B = 1;
const SEED_SAME_CID_NON_DWC = 2;
const SEED_SIBLING_CID_DWC = 3;

let app: FastifyInstance;
const seedIds: number[] = [];

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
    console.error("[close-by-cid-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
});

async function seedRows(): Promise<void> {
  const prisma = getPrisma();
  for (let i = 0; i < SEED_ROWS.length; i++) {
    const seed = SEED_ROWS[i];
    if (seed === undefined) continue;
    const minutesAgo = i + 1;
    const rows = await prisma.$queryRaw<{ id: bigint }[]>`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, summary, cid)
      VALUES
        (NOW() - (${minutesAgo}::int * INTERVAL '1 minute'),
         ${`close-by-cid-agent-${i}`},
         'feature'::core."TaskType",
         ${seed.result}::core."OutcomeResult",
         ${`close-by-cid seed ${seed.result} ${SUITE_MARKER}`},
         ${seed.cid})
      RETURNING id
    `;
    const inserted = rows[0];
    assert.ok(inserted, `seed row ${i} inserted`);
    seedIds.push(Number(inserted.id));
  }
}

function seedId(index: number): number {
  const id = seedIds[index];
  assert.ok(id !== undefined, `seed id ${index} present`);
  return id;
}

async function closeByCid(cid: string): ReturnType<FastifyInstance["inject"]> {
  return app.inject({
    method: "PATCH",
    url: `/api/outcomes/close-by-cid?cid=${encodeURIComponent(cid)}`,
  });
}

// include_all=1 — 비-레지스트리 seed agent 를 forensic 뷰에서 조회 (S5 의 read 측 대응).
async function fetchSeedRows(): Promise<OutcomeSearchResponse> {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/search?days=all&limit=200&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200, "/search must be 200");
  return res.json() as OutcomeSearchResponse;
}

async function fetchClosedAt(id: number): Promise<string | null> {
  const body = await fetchSeedRows();
  const row = body.rows.find((r) => r.id === id);
  assert.ok(row, `seed row ${id} visible on /search`);
  return row.closed_at;
}

// (S4) 파라미터 가드 — 쓰기 이전에 거부.

test("close-by-cid rejects a missing or empty cid with 400 invalid_param", async () => {
  const missing = await app.inject({ method: "PATCH", url: "/api/outcomes/close-by-cid" });
  assert.strictEqual(missing.statusCode, 400, "missing cid must be 400");
  assert.deepStrictEqual(missing.json(), { error: "invalid_param", param: "cid" });

  const blank = await closeByCid("   ");
  assert.strictEqual(blank.statusCode, 400, "whitespace-only cid must be 400");
  assert.deepStrictEqual(blank.json(), { error: "invalid_param", param: "cid" });
});

test("close-by-cid returns an empty list for a cid with no open DWC row", async () => {
  const res = await closeByCid(`${SUITE_MARKER}-unknown`);
  assert.strictEqual(res.statusCode, 200, "unknown cid is a normal empty result, not 404");
  const body = res.json() as OutcomeCloseByCidResponse;
  assert.strictEqual(body.cid, `${SUITE_MARKER}-unknown`);
  assert.deepStrictEqual(body.closed_ids, []);
});

// (S1)(S3)(S5) 집합 종결 + 범위.

test("close-by-cid closes every open DWC row on the cid in one call and lists their ids", async () => {
  const res = await closeByCid(TARGET_CID);
  assert.strictEqual(res.statusCode, 200, "set close must be 200");
  const body = res.json() as OutcomeCloseByCidResponse;
  assert.strictEqual(body.cid, TARGET_CID);
  assert.deepStrictEqual(
    [...body.closed_ids].sort((a, b) => a - b),
    [seedId(SEED_DWC_A), seedId(SEED_DWC_B)].sort((a, b) => a - b),
    "exactly the two open DWC rows on the cid were stamped",
  );

  assert.ok(await fetchClosedAt(seedId(SEED_DWC_A)), "first DWC row carries closed_at");
  assert.ok(await fetchClosedAt(seedId(SEED_DWC_B)), "second DWC row carries closed_at");
});

test("close-by-cid leaves a same-cid non-DWC row and a sibling-cid DWC row untouched", async () => {
  assert.strictEqual(
    await fetchClosedAt(seedId(SEED_SAME_CID_NON_DWC)),
    null,
    "a done row sharing the cid is never closed",
  );
  assert.strictEqual(
    await fetchClosedAt(seedId(SEED_SIBLING_CID_DWC)),
    null,
    "a DWC row on another cid stays open",
  );
});

// (S2) 멱등.

test("close-by-cid repeats idempotently — empty list, stored timestamp unchanged", async () => {
  const before = await fetchClosedAt(seedId(SEED_DWC_A));
  assert.ok(before, "row is closed before the repeat");

  const res = await closeByCid(TARGET_CID);
  assert.strictEqual(res.statusCode, 200, "repeat must also be 200");
  const body = res.json() as OutcomeCloseByCidResponse;
  assert.deepStrictEqual(body.closed_ids, [], "a repeat stamps nothing");

  assert.strictEqual(
    await fetchClosedAt(seedId(SEED_DWC_A)),
    before,
    "repeat returns the STORED timestamp — no re-stamp",
  );
});
