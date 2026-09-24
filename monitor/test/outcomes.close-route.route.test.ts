// Regression tests for PATCH /api/outcomes/:id/close and the closed_at read exposure.
// Runner: npx tsx --test test/outcomes.close-route.route.test.ts
//
// Pinned invariants:
//   (AC1) /search rows carry closed_at; a never-closed row (legacy 포함) reads NULL,
//         so every pre-existing row folds into the open bucket.
//   (AC4) First close stamps the timestamp; a repeat returns success with the SAME
//         stored timestamp (idempotent, never re-stamped).
//   (AC5) Non-done_with_concerns target → 400 invalid_result, unknown id → 404, and
//         neither writes anything.
//   (AC6) Closing a row moves ONLY the closure-aware counts that cover it — by_result
//         closed_count +1 and writer_open_count -1 for the closed row's result, and
//         by_agent_top_10 writer_open_count -1 for its agent. Every count, every
//         reconstructed_count and every other aggregate stay closure-blind.
//
// DB: real Postgres — seed summary carries SUITE_MARKER → ?q 한정 조회, cleanup 은 cid LIKE.
// 라이브 1000+ done_with_concerns 행은 절대 건드리지 않는다 (seed 행만 종결/삭제).

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { resetAgentRegistryCache } from "../src/server/agents/registry.js";
import { registerOutcomesRoutes } from "../src/server/routes/outcomes.js";
import type {
  OutcomeCloseResponse,
  OutcomeCrossAnalysisResponse,
  OutcomeSearchResponse,
} from "../src/server/types/outcomes.js";

const SUITE_MARKER = `close-route-test-${randomUUID()}`;
let app: FastifyInstance;

// seed 설계 — 종결 대상 DWC 3행(최초/멱등 반복/미종결 대조) + 비-DWC 거부 대조 1행.
const SEED_RESULTS = [
  "done_with_concerns",
  "done_with_concerns",
  "done_with_concerns",
  "done",
] as const;

const SEED_CLOSE_TARGET = 0;
const SEED_IDEMPOTENT_TARGET = 1;
const SEED_OPEN_CONTROL = 2;
const SEED_NON_DWC = 3;

let seedIds: number[] = [];

function seedAgent(index: number): string {
  return `close-route-agent-${index}`;
}

// Hermetic registry — by_agent_top_10 ignores include_all, so seed agents reach it only as members here.
function buildRegistryFixture(): unknown {
  const agents: Record<string, unknown> = {};
  SEED_RESULTS.forEach((_, index) => {
    agents[seedAgent(index)] = { domains: ["test"], phase: "implementation", dual_phase: false };
  });
  return { $schema: "agent-registry", version: "1.1", agents };
}

let registryRoot: string;

async function setRegistryFixture(): Promise<void> {
  registryRoot = await mkdtemp(join(tmpdir(), "close-route-registry-"));
  const registryPath = join(registryRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(buildRegistryFixture()), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();
}

async function clearRegistryFixture(): Promise<void> {
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(registryRoot, { recursive: true, force: true });
}

before(async () => {
  await setRegistryFixture();
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
    console.error("[close-route-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
  await clearRegistryFixture();
});

async function seedRows(): Promise<void> {
  const prisma = getPrisma();
  for (let i = 0; i < SEED_RESULTS.length; i++) {
    const result = SEED_RESULTS[i];
    if (result === undefined) continue;
    const minutesAgo = i + 1;
    const rows = await prisma.$queryRaw<{ id: bigint }[]>`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, summary, cid)
      VALUES
        (NOW() - (${minutesAgo}::int * INTERVAL '1 minute'),
         ${seedAgent(i)},
         'feature'::core."TaskType",
         ${result}::core."OutcomeResult",
         ${`close-route seed ${result} ${SUITE_MARKER}`},
         ${`${SUITE_MARKER}-${i}`})
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

// include_all=1 — 비-레지스트리 seed agent 를 forensic 뷰에서 조회 (이 스위트 관심사와 직교).
async function fetchSeedRows(): Promise<OutcomeSearchResponse> {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/search?days=all&limit=200&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200, "/search must be 200");
  return res.json() as OutcomeSearchResponse;
}

async function fetchSeedCrossAnalysis(): Promise<OutcomeCrossAnalysisResponse> {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/cross-analysis?days=all&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200, "/cross-analysis must be 200");
  return res.json() as OutcomeCrossAnalysisResponse;
}

async function close(id: number | string): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> {
  return app.inject({ method: "PATCH", url: `/api/outcomes/${id}/close` });
}

// (AC1) read 노출 — 모든 행에 closed_at 이 있고, 종결 전에는 NULL.

test("/search rows expose closed_at, NULL on every never-closed row", async () => {
  const body = await fetchSeedRows();
  assert.strictEqual(body.rows.length, SEED_RESULTS.length, "all seed rows visible");
  for (const row of body.rows) {
    assert.ok("closed_at" in row, `row ${row.id} carries closed_at`);
    assert.strictEqual(row.closed_at, null, `row ${row.id} reads open (NULL) before any close`);
  }
});

// (AC4) 최초 종결 + 멱등 반복.

test("close stamps closed_at once and repeats idempotently with the stored timestamp", async () => {
  const id = seedId(SEED_IDEMPOTENT_TARGET);

  const first = await close(id);
  assert.strictEqual(first.statusCode, 200, "first close must be 200");
  const firstBody = first.json() as OutcomeCloseResponse;
  assert.strictEqual(firstBody.closed, true);
  assert.strictEqual(firstBody.id, id);
  assert.ok(
    !Number.isNaN(Date.parse(firstBody.closed_at)),
    "closed_at is an ISO timestamp on first close",
  );

  const repeat = await close(id);
  assert.strictEqual(repeat.statusCode, 200, "repeat close must also be 200 (idempotent)");
  const repeatBody = repeat.json() as OutcomeCloseResponse;
  assert.strictEqual(repeatBody.closed, true);
  assert.strictEqual(
    repeatBody.closed_at,
    firstBody.closed_at,
    "repeat returns the STORED timestamp — no re-stamp",
  );
});

test("closed row surfaces its closed_at on /search while sibling rows stay open", async () => {
  const closedId = seedId(SEED_CLOSE_TARGET);
  const res = await close(closedId);
  assert.strictEqual(res.statusCode, 200);

  const body = await fetchSeedRows();
  const closedRow = body.rows.find((row) => row.id === closedId);
  assert.ok(closedRow, "closed seed row present in /search");
  assert.ok(closedRow.closed_at !== null, "closed row carries a non-null closed_at");

  const openRow = body.rows.find((row) => row.id === seedId(SEED_OPEN_CONTROL));
  assert.ok(openRow, "open control row present");
  assert.strictEqual(openRow.closed_at, null, "an untouched DWC row stays open");
});

// (AC5) 거부 경로 — 비-DWC / 미존재 id, 그리고 무기록.

test("close rejects a non-done_with_concerns row with 400 invalid_result and writes nothing", async () => {
  const id = seedId(SEED_NON_DWC);
  const res = await close(id);
  assert.strictEqual(res.statusCode, 400, "non-DWC target must be rejected");
  assert.deepStrictEqual(res.json(), {
    error: "invalid_result",
    id,
    result: "done",
  });

  const body = await fetchSeedRows();
  const row = body.rows.find((r) => r.id === id);
  assert.ok(row, "rejected row still present");
  assert.strictEqual(row.closed_at, null, "rejected row was not written");
});

test("close rejects an unknown id with 404 and a malformed id with 400", async () => {
  const prisma = getPrisma();
  const maxRows = await prisma.$queryRaw<{ next_id: bigint }[]>`
    SELECT COALESCE(MAX(id), 0) + 1000 AS next_id FROM core.outcomes
  `;
  const maxRow = maxRows[0];
  assert.ok(maxRow, "max id probe returned a row");
  const unknownId = Number(maxRow.next_id);

  const missing = await close(unknownId);
  assert.strictEqual(missing.statusCode, 404, "unknown id must be 404");
  assert.deepStrictEqual(missing.json(), { error: "not_found", id: unknownId });

  const malformed = await close("not-a-number");
  assert.strictEqual(malformed.statusCode, 400, "malformed id must be 400");
  assert.deepStrictEqual(malformed.json(), { error: "invalid_param", param: "id" });
});

// (AC6) 집계 불변 — 종결이 움직이는 필드는 종결 행을 덮는 closure-aware 카운트뿐.

test("a close moves only the closure-aware counts covering the closed row; every other aggregate value is identical", async () => {
  const before = await fetchSeedCrossAnalysis();
  const res = await close(seedId(SEED_OPEN_CONTROL));
  assert.strictEqual(res.statusCode, 200, "control row close must succeed");
  const after = await fetchSeedCrossAnalysis();

  assert.deepStrictEqual(
    after.by_result.map((row) => row.result),
    before.by_result.map((row) => row.result),
    "by_result grouping/order unchanged",
  );
  for (const [index, afterRow] of after.by_result.entries()) {
    const beforeRow = before.by_result[index];
    assert.ok(beforeRow, `by_result row ${index} present before the close`);
    assert.strictEqual(afterRow.count, beforeRow.count, `${afterRow.result} count unchanged`);
    assert.strictEqual(
      afterRow.reconstructed_count,
      beforeRow.reconstructed_count,
      `${afterRow.result} reconstructed_count unchanged`,
    );
    const closedDelta = afterRow.result === "done_with_concerns" ? 1 : 0;
    assert.strictEqual(
      afterRow.closed_count,
      beforeRow.closed_count + closedDelta,
      `${afterRow.result} closed_count reflects the close`,
    );
    assert.strictEqual(
      afterRow.writer_open_count,
      beforeRow.writer_open_count - closedDelta,
      `${afterRow.result} writer_open_count reflects the close`,
    );
    assert.ok(
      afterRow.closed_count >= 0 && afterRow.closed_count <= afterRow.count,
      `${afterRow.result} keeps 0 <= closed_count <= count`,
    );
  }

  assert.deepStrictEqual(after.cells, before.cells, "confidence × metric_pass cells unchanged");
  const closedAgent = seedAgent(SEED_OPEN_CONTROL);
  assert.ok(
    before.by_agent_top_10.some((row) => row.agent === closedAgent),
    "closed row's agent is in by_agent_top_10, so the check below cannot pass vacuously",
  );
  const expectedByAgent = before.by_agent_top_10.map((row) =>
    row.agent === closedAgent ? { ...row, writer_open_count: row.writer_open_count - 1 } : row,
  );
  assert.deepStrictEqual(
    after.by_agent_top_10,
    expectedByAgent,
    "by_agent_top_10 moves only the closed agent's writer_open_count",
  );
  assert.deepStrictEqual(
    after.by_agent_result,
    before.by_agent_result,
    "by_agent_result stays closure-blind",
  );
});
