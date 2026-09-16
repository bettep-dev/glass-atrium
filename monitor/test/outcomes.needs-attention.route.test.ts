// Route tests for the additive attention facts the Task-results attention view reads:
// the /search `needs_attention` filter and the per-agent open-caveat count on
// /cross-analysis by_agent_top_10.
// Runner: npx tsx --import ./test/lib/select-test-db.ts --test test/outcomes.needs-attention.route.test.ts
//
// Pinned invariants:
//   (a) needs_attention=true returns a row iff it is flagged for review, failed,
//       blocked, or an UNCLOSED caveat row — membership derived from SEED_ROWS on
//       both sides, never a maintained literal count.
//   (b) needs_attention=false and an absent param are the same query (additive).
//   (c) by_agent_top_10 carries writer_open_count = writer-emitted unclosed caveat
//       rows for that agent, bounded by the writer-emitted population.
//
// DB: real Postgres — seed summary carries SUITE_MARKER → ?q 한정 조회, cleanup 은 cid LIKE.

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
  OutcomeCrossAnalysisResponse,
  OutcomeResultLiteral,
  OutcomeSearchResponse,
} from "../src/server/types/outcomes.js";

const SUITE_MARKER = `needs-attention-test-${randomUUID()}`;
let app: FastifyInstance;

// Seed 설계 — 주목 모집단의 세 팔(플래그 · 파손 · 미종결 우려)과 각 팔의 반례를 모두 싣는다.
// 반례가 있어야 필터가 "전부 통과"로 퇴화했을 때 테스트가 붉어진다.
interface SeedRow {
  agent: string;
  result: OutcomeResultLiteral;
  review_flag: boolean;
  closed: boolean;
  attention: boolean;
}

const SEED_ROWS: readonly SeedRow[] = [
  { agent: "attention-agent-a", result: "done", review_flag: false, closed: false, attention: false },
  { agent: "attention-agent-a", result: "done", review_flag: true, closed: false, attention: true },
  { agent: "attention-agent-a", result: "fail", review_flag: false, closed: false, attention: true },
  { agent: "attention-agent-b", result: "blocked", review_flag: false, closed: false, attention: true },
  { agent: "attention-agent-b", result: "needs_context", review_flag: false, closed: false, attention: false },
  { agent: "attention-agent-b", result: "done_with_concerns", review_flag: false, closed: false, attention: true },
  { agent: "attention-agent-b", result: "done_with_concerns", review_flag: false, closed: true, attention: false },
] as const;

function seedCid(index: number): string {
  return `${SUITE_MARKER}-${index}`;
}

function attentionCids(): Set<string> {
  const cids = new Set<string>();
  SEED_ROWS.forEach((row, index) => {
    if (row.attention) cids.add(seedCid(index));
  });
  return cids;
}

function openCaveatCount(agent: string): number {
  return SEED_ROWS.filter(
    (row) => row.agent === agent && row.result === "done_with_concerns" && !row.closed,
  ).length;
}

// Hermetic registry — by_agent_top_10 stays registry-scoped even under include_all,
// so the seed agents reach that dimension only by being canonical members here.
function buildRegistryFixture(): unknown {
  const agents: Record<string, unknown> = {};
  for (const agent of new Set(SEED_ROWS.map((row) => row.agent))) {
    agents[agent] = { domains: ["test"], phase: "implementation", dual_phase: false };
  }
  return { $schema: "agent-registry", version: "1.1", agents };
}

let registryRoot: string;

async function setRegistryFixture(): Promise<void> {
  registryRoot = await mkdtemp(join(tmpdir(), "needs-attention-registry-"));
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
    console.error("[needs-attention-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
  await clearRegistryFixture();
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
         attribution_source, review_flag, closed_at, cid)
      VALUES
        (NOW() - (${minutesAgo}::int * INTERVAL '1 minute'),
         ${row.agent},
         'feature'::core."TaskType",
         ${row.result}::core."OutcomeResult",
         ${`needs-attention seed ${row.result} ${SUITE_MARKER}`},
         'hook-input',
         ${row.review_flag},
         ${row.closed ? new Date() : null},
         ${seedCid(i)})
    `;
  }
}

// include_all=1 — 레지스트리 미등록 seed agent 를 forensic 뷰에서 조회(주목 필터와 직교).
async function fetchSearch(extraQuery: string): Promise<OutcomeSearchResponse> {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/search?days=all&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}${extraQuery}`,
  });
  assert.strictEqual(res.statusCode, 200, "/search must be 200");
  return res.json() as OutcomeSearchResponse;
}

function cidSet(body: OutcomeSearchResponse): Set<string> {
  return new Set(body.rows.map((row) => row.cid).filter((cid): cid is string => cid !== null));
}

// (a) 멤버십 — 세 팔의 합집합, 종결된 우려행은 제외.

test("/search needs_attention returns exactly the rows asking for an action", async () => {
  const body = await fetchSearch("&needs_attention=true");

  assert.deepStrictEqual(
    [...cidSet(body)].sort(),
    [...attentionCids()].sort(),
    "flagged, failed, blocked and unclosed-caveat rows — and nothing else",
  );
  assert.strictEqual(body.total, attentionCids().size, "total reflects the same filter as the rows");
  assert.strictEqual(body.filter.needs_attention, true, "the echo carries the applied filter");
});

test("/search needs_attention keeps a closed caveat row out of the attention population", async () => {
  const body = await fetchSearch("&needs_attention=true");
  const closedIndex = SEED_ROWS.findIndex((row) => row.result === "done_with_concerns" && row.closed);

  assert.ok(closedIndex >= 0, "the seed carries a closed caveat row");
  assert.ok(
    !cidSet(body).has(seedCid(closedIndex)),
    "a closed caveat no longer asks for an action",
  );
});

// (b) 가산성 — 필터 부재와 false 는 같은 질의.

test("/search needs_attention=false is the same query as an absent param", async () => {
  const [filtered, unfiltered] = await Promise.all([
    fetchSearch("&needs_attention=false"),
    fetchSearch(""),
  ]);

  assert.strictEqual(filtered.total, SEED_ROWS.length, "no filter applied");
  assert.deepStrictEqual(
    [...cidSet(filtered)].sort(),
    [...cidSet(unfiltered)].sort(),
    "the additive param changes nothing when it is false",
  );
  assert.strictEqual(unfiltered.filter.needs_attention, false, "the echo reports no filter");
});

test("/search rejects a non-boolean needs_attention", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/outcomes/search?days=all&needs_attention=maybe",
  });

  assert.strictEqual(res.statusCode, 400, "an unparseable value is a client error, not a silent pass");
  assert.strictEqual((res.json() as { param?: string }).param, "needs_attention");
});

// (c) 교차분석 — 에이전트별 미종결 우려 건수.

test("/cross-analysis by_agent_top_10 carries the per-agent open-caveat count", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/cross-analysis?days=all&include_all=1&q=${encodeURIComponent(SUITE_MARKER)}`,
  });
  assert.strictEqual(res.statusCode, 200, "/cross-analysis must be 200");
  const body = res.json() as OutcomeCrossAnalysisResponse;

  const seeded = body.by_agent_top_10.filter((row) => row.agent.startsWith("attention-agent-"));
  assert.ok(seeded.length > 0, "the seed agents reach the by-agent dimension");

  for (const row of seeded) {
    assert.strictEqual(
      row.writer_open_count,
      openCaveatCount(row.agent),
      `${row.agent}: only unclosed caveat rows count`,
    );
    assert.ok(
      row.writer_open_count <= row.count - row.reconstructed_count,
      `${row.agent}: the count never exceeds the writer-emitted population`,
    );
  }
});
