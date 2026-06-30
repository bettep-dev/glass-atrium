// GET /api/agents/failure-reasons `result` param 확장 (blocked-cause 가시화) 통합 테스트.
// DB = real Postgres READ-ONLY · App = stripped Fastify + app.inject() (port binding 없음).

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma } from "../src/server/db.js";
import { registerAgentsRoutes } from "../src/server/routes/agents.js";
import type {
  AgentFailureReasonsResponse,
  AgentsErrorBody,
} from "../src/server/types/agents.js";

// blocked-dominant agent in the live system (정규화된 dev-* 명명) — 측정 대상.
const BLOCKED_DOMINANT_AGENT = "dev-python";

let app: FastifyInstance;

before(async () => {
  app = Fastify({ logger: false });
  await registerAgentsRoutes(app);
  await app.ready();
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  await disconnectPrisma();
});

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
test("default (no result param) → result_type='fail' (backward-compat invariant)", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${BLOCKED_DOMINANT_AGENT}&days=90`,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AgentFailureReasonsResponse;

  // 기존 contract 보존 — result_type 이 'fail' 로 기본값.
  assert.strictEqual(body.meta.result_type, "fail");
  assert.strictEqual(body.meta.agent, BLOCKED_DOMINANT_AGENT);
  assert.strictEqual(body.meta.days, 90);
  assert.strictEqual(body.meta.classification_method, "keyword_approximate");
  assert.ok(Array.isArray(body.reasons));
  assertPctSum100(body);
});

test("explicit result=fail → result_type='fail' (param 동일성)", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${BLOCKED_DOMINANT_AGENT}&days=90&result=fail`,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AgentFailureReasonsResponse;
  assert.strictEqual(body.meta.result_type, "fail");
  assertPctSum100(body);
});

// blocked-cause visibility.
test("result=blocked → result_type='blocked' + meta shape 유지", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${BLOCKED_DOMINANT_AGENT}&days=90&result=blocked`,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AgentFailureReasonsResponse;

  assert.strictEqual(body.meta.result_type, "blocked");
  assert.strictEqual(body.meta.agent, BLOCKED_DOMINANT_AGENT);
  // honesty 라벨 — blocked 차원에서도 동일 분류 방식.
  assert.strictEqual(body.meta.classification_method, "keyword_approximate");
  assertPctSum100(body);
});

test("blocked breakages 가시화 — blocked count > fail count (python-dev)", async () => {
  const failRes = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${BLOCKED_DOMINANT_AGENT}&days=90&result=fail`,
  });
  const blockedRes = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${BLOCKED_DOMINANT_AGENT}&days=90&result=blocked`,
  });
  assert.strictEqual(failRes.statusCode, 200);
  assert.strictEqual(blockedRes.statusCode, 200);

  const failBody = failRes.json() as AgentFailureReasonsResponse;
  const blockedBody = blockedRes.json() as AgentFailureReasonsResponse;

  // 핵심 invariant — blocked 차원이 fail 차원보다 많은 breakage 노출 (python-dev blocked-dominant) → fail-only 가 가렸던 지배적 breakage 타입이 result=blocked 로 가시.
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

// Validation.
test("result=<invalid> → 400 invalid_param param=result", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/agents/failure-reasons?agent=${BLOCKED_DOMINANT_AGENT}&days=90&result=done`,
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
    url: `/api/agents/failure-reasons?agent=${BLOCKED_DOMINANT_AGENT}&days=999&result=blocked`,
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as AgentsErrorBody;
  assert.strictEqual(body.error, "invalid_param");
  if (body.error === "invalid_param") {
    assert.strictEqual(body.param, "days");
  }
});
