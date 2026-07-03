// GET /api/agents/failure-reasons `result` param 확장 (blocked-cause 가시화) 통합 테스트.
//
// Hermetic — AGENT_REGISTRY_PATH points at a fixture holding ONLY this suite's
// marker agent (mirrors test/agents.failure-gate.route.test.ts), and the breakage
// rows are seeded under a suite-unique cid, scrubbed via cid LIKE. The blocked>fail
// invariant is driven by the seed (3 blocked + 1 fail), not by ambient live-DB
// telemetry for a hardcoded agent id (which is ABSENT in a fresh CI DB → both 0).
// Skips gracefully when the DB is unreachable.
//
// Runner: npx tsx --test test/agents.failure-reasons.route.test.ts

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
import { registerAgentsRoutes } from "../src/server/routes/agents.js";
import type {
  AgentFailureReasonsResponse,
  AgentsErrorBody,
} from "../src/server/types/agents.js";

// Suite-unique marker — scopes the seeded rows (cid) + the registry membership so a
// fresh CI DB yields a deterministic breakdown rather than empty live telemetry.
const SUITE_MARKER = `fr-test-${randomUUID().slice(0, 8)}`;
// Blocked-dominant agent under test — the sole registry member. Replaces the old
// hardcoded 'dev-python' live-telemetry dependency.
const BLOCKED_DOMINANT_AGENT = `${SUITE_MARKER}-agent`;

interface BreakageSeed {
  result: "fail" | "blocked";
  concern: string;
  tag: string;
}

// Blocked-dominant make-up: 3 blocked + 1 fail. The core invariant (test #4) is
// blocked(3) > fail(1) — seeded, not ambient. concern text is non-empty so the
// cause breakdown yields reasons.length > 0.
const SEED_ROWS: ReadonlyArray<BreakageSeed> = [
  { result: "fail", concern: "context window exceeded", tag: "f0" },
  { result: "blocked", concern: "tool exec failed", tag: "b0" },
  { result: "blocked", concern: "rate limit 429", tag: "b1" },
  { result: "blocked", concern: "deadline exceeded", tag: "b2" },
];

const SEED_FAIL_COUNT = SEED_ROWS.filter((r) => r.result === "fail").length;
const SEED_BLOCKED_COUNT = SEED_ROWS.filter((r) => r.result === "blocked").length;

// Registry fixture — BLOCKED_DOMINANT_AGENT is the ONLY member so the canonical-
// membership gate (AND agent IN (registry)) scopes the breakdown to this suite.
const REGISTRY_FIXTURE = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    [BLOCKED_DOMINANT_AGENT]: {
      domains: ["test"],
      phase: "implementation",
      dual_phase: false,
    },
  },
};

let app: FastifyInstance;
let tmpRoot: string;
let dbReady = false;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "failure-reasons-registry-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerAgentsRoutes(app);
  await app.ready();

  try {
    await seedOutcomes();
    dbReady = true;
  } catch (error) {
    dbReady = false;
    console.error("[failure-reasons] DB seed failed — tests will skip:", error);
  }
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  if (dbReady) {
    try {
      const prisma = getPrisma();
      await prisma.$executeRaw`
        DELETE FROM core.outcomes WHERE cid LIKE ${`%${SUITE_MARKER}%`}
      `;
    } catch (error) {
      console.error("[failure-reasons cleanup] DB scrub failed:", error);
    }
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

// Seed breakage rows today (inside the 90-day window). Distinct record_ts per row
// (minute offset) keeps outcomes_dedup UNIQUE(record_ts, agent, task_type) clear.
// concerns is a single-element text[] bound via ARRAY[$n]::text[] (parameterized —
// never string-concatenated) so the cause breakdown has non-empty haystack input.
async function seedOutcomes(): Promise<void> {
  const prisma = getPrisma();
  for (let i = 0; i < SEED_ROWS.length; i++) {
    const row = SEED_ROWS[i]!;
    await prisma.$executeRaw`
      INSERT INTO core.outcomes
        (record_ts, agent, task_type, result, concerns, summary, cid)
      VALUES
        (NOW() - (${i + 1}::int * INTERVAL '1 minute'),
         ${BLOCKED_DOMINANT_AGENT},
         'feature'::core."TaskType",
         ${row.result}::core."OutcomeResult",
         ARRAY[${row.concern}]::text[],
         ${`failure-reasons seed ${row.tag}`},
         ${`${SUITE_MARKER}-${row.tag}`})
    `;
  }
}

// pct sum = 100 invariant — totalBreakages > 0 일 때만 의미.
function assertPctSum100(body: AgentFailureReasonsResponse): void {
  if (body.meta.total_failures === 0) {
    assert.strictEqual(body.reasons.length, 0, "0 breakages → no reason rows");
    return;
  }
  const sum = body.reasons.reduce((acc, r) => acc + r.pct, 0);
  // ±0.05 허용 — rebalancePctSum 이 마지막 행에서 drift 흡수 후 정확히 100.
  assert.ok(Math.abs(sum - 100) < 0.05, `pct sum ${sum} expected ~100`);
}

// Backward-compat: default param = fail.
test("default (no result param) → result_type='fail' (backward-compat invariant)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${encodeURIComponent(BLOCKED_DOMINANT_AGENT)}&days=90`,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AgentFailureReasonsResponse;

  // 기존 contract 보존 — result_type 이 'fail' 로 기본값.
  assert.strictEqual(body.meta.result_type, "fail");
  assert.strictEqual(body.meta.agent, BLOCKED_DOMINANT_AGENT);
  assert.strictEqual(body.meta.days, 90);
  assert.strictEqual(body.meta.classification_method, "keyword_approximate");
  assert.ok(Array.isArray(body.reasons));
  // Registry-scoped fail count — the single seeded fail row survives the gate.
  assert.strictEqual(body.meta.total_failures, SEED_FAIL_COUNT, "seeded fail count");
  assertPctSum100(body);
});

test("explicit result=fail → result_type='fail' (param 동일성)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${encodeURIComponent(BLOCKED_DOMINANT_AGENT)}&days=90&result=fail`,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AgentFailureReasonsResponse;
  assert.strictEqual(body.meta.result_type, "fail");
  assert.strictEqual(body.meta.total_failures, SEED_FAIL_COUNT, "seeded fail count");
  assertPctSum100(body);
});

// blocked-cause visibility.
test("result=blocked → result_type='blocked' + meta shape 유지", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${encodeURIComponent(BLOCKED_DOMINANT_AGENT)}&days=90&result=blocked`,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AgentFailureReasonsResponse;

  assert.strictEqual(body.meta.result_type, "blocked");
  assert.strictEqual(body.meta.agent, BLOCKED_DOMINANT_AGENT);
  // honesty 라벨 — blocked 차원에서도 동일 분류 방식.
  assert.strictEqual(body.meta.classification_method, "keyword_approximate");
  assert.strictEqual(body.meta.total_failures, SEED_BLOCKED_COUNT, "seeded blocked count");
  assertPctSum100(body);
});

test("blocked breakages 가시화 — blocked count > fail count (marker agent)", async (t) => {
  if (!dbReady) return t.skip("DB unavailable");
  const failRes = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${encodeURIComponent(BLOCKED_DOMINANT_AGENT)}&days=90&result=fail`,
  });
  const blockedRes = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${encodeURIComponent(BLOCKED_DOMINANT_AGENT)}&days=90&result=blocked`,
  });
  assert.strictEqual(failRes.statusCode, 200);
  assert.strictEqual(blockedRes.statusCode, 200);

  const failBody = failRes.json() as AgentFailureReasonsResponse;
  const blockedBody = blockedRes.json() as AgentFailureReasonsResponse;

  // 핵심 invariant — blocked 차원이 fail 차원보다 많은 breakage 노출 (blocked-dominant seed) → fail-only 가 가렸던 지배적 breakage 타입이 result=blocked 로 가시.
  assert.ok(
    blockedBody.meta.total_failures > failBody.meta.total_failures,
    `blocked total (${blockedBody.meta.total_failures}) expected > fail total (${failBody.meta.total_failures}) for ${BLOCKED_DOMINANT_AGENT}`,
  );
  // blocked 분류 결과가 비어있지 않음 — cause 분석이 실효 정보 회복.
  assert.ok(
    blockedBody.reasons.length > 0,
    "blocked cause analysis returns at least one category (non-empty)",
  );
});

// Validation. 400 paths return before any DB access → no dbReady guard needed.
test("result=<invalid> → 400 invalid_param param=result", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${encodeURIComponent(BLOCKED_DOMINANT_AGENT)}&days=90&result=done`,
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as AgentsErrorBody;
  assert.strictEqual(body.error, "invalid_param");
  if (body.error === "invalid_param") {
    assert.strictEqual(body.param, "result");
  }
});

test("missing agent param → 400 invalid_param param=agent (기존 검증 유지)", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?days=90&result=blocked`,
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as AgentsErrorBody;
  assert.strictEqual(body.error, "invalid_param");
  if (body.error === "invalid_param") {
    assert.strictEqual(body.param, "agent");
  }
});

test("days out-of-range → 400 invalid_param param=days (result 와 직교)", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${encodeURIComponent(BLOCKED_DOMINANT_AGENT)}&days=999&result=blocked`,
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as AgentsErrorBody;
  assert.strictEqual(body.error, "invalid_param");
  if (body.error === "invalid_param") {
    assert.strictEqual(body.param, "days");
  }
});
