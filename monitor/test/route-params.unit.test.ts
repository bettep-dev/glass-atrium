// route-params 공유 파서 + 라우트 레벨 oversized-id 가드 테스트 (M1/M3 회귀 고정).
// Runner: npx tsx --test test/route-params.unit.test.ts
//
// Pinned invariant: 2^53..2^63 digit string 은 parseInt float-round 로 다른 정수가
// 되므로(wrong-row) safe-int cap 으로 400 거부 · >2^63 은 pg bigint overflow(22003)
// 로 false 503 을 만들던 입력 — 둘 다 파서 단계에서 400.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma } from "../src/server/db.js";
import { parseIdParam, parseOffsetParam } from "../src/server/route-params.js";
import { registerOutcomesRoutes } from "../src/server/routes/outcomes.js";
import { registerImprovementRoutes } from "../src/server/routes/improvement.js";

const BIGINT_OVERFLOW = "9223372036854775808"; // 2^63 (bigint max + 1)
const FLOAT_ROUNDED = "9007199254740993"; // 2^53 + 1 — parseInt → ...992 (wrong row)
const MAX_SAFE = "9007199254740991"; // Number.MAX_SAFE_INTEGER — 경계값은 통과해야 함

let app: FastifyInstance;

before(async () => {
  app = Fastify({ logger: false });
  await registerOutcomesRoutes(app);
  await registerImprovementRoutes(app);
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

test("parseIdParam: 유효 양의 정수만 통과", () => {
  assert.strictEqual(parseIdParam("12"), 12);
  assert.strictEqual(parseIdParam(MAX_SAFE), Number.MAX_SAFE_INTEGER);
  assert.strictEqual(parseIdParam("0"), null);
  assert.strictEqual(parseIdParam("-3"), null);
  assert.strictEqual(parseIdParam("abc"), null);
  assert.strictEqual(parseIdParam("1e3"), null);
  assert.strictEqual(parseIdParam(""), null);
  assert.strictEqual(parseIdParam("1.5"), null);
});

test("parseIdParam: unsafe-integer 거부 (M1 overflow + M3 float-round)", () => {
  assert.strictEqual(parseIdParam(BIGINT_OVERFLOW), null);
  assert.strictEqual(parseIdParam(FLOAT_ROUNDED), null);
  assert.strictEqual(parseIdParam("99999999999999999999999999"), null);
});

test("parseOffsetParam: 기본값/유효값/unsafe 거부", () => {
  assert.strictEqual(parseOffsetParam(undefined), 0);
  assert.strictEqual(parseOffsetParam(""), 0);
  assert.strictEqual(parseOffsetParam("0"), 0);
  assert.strictEqual(parseOffsetParam("25"), 25);
  assert.strictEqual(parseOffsetParam("-1"), null);
  assert.strictEqual(parseOffsetParam(BIGINT_OVERFLOW), null);
  assert.strictEqual(parseOffsetParam(FLOAT_ROUNDED), null);
});

test("GET /api/outcomes/:id — oversized id 는 503 아닌 400", async () => {
  for (const raw of [BIGINT_OVERFLOW, FLOAT_ROUNDED]) {
    const res = await app.inject({ method: "GET", url: `/api/outcomes/${raw}` });
    assert.strictEqual(res.statusCode, 400, `id=${raw} → 400`);
    assert.deepStrictEqual(res.json(), { error: "invalid_param", param: "id" });
  }
});

test("GET /api/outcomes/:id — MAX_SAFE_INTEGER 경계값은 DB 까지 도달 (404 not_found)", async () => {
  const res = await app.inject({ method: "GET", url: `/api/outcomes/${MAX_SAFE}` });
  assert.strictEqual(res.statusCode, 404, "경계값 id 는 거부되지 않고 정상 조회 → 404");
});

test("GET /api/outcomes/search — oversized offset 은 503 아닌 400", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/outcomes/search?offset=${BIGINT_OVERFLOW}`,
  });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.json(), { error: "invalid_param", param: "offset" });
});

test("POST /api/improvement/:id/approve|reject — oversized id 는 400 invalid_param", async () => {
  // 파서 단계 거부 — 유효 id 였다면 실행됐을 daemon-apply 스크립트는 절대 미실행.
  for (const action of ["approve", "reject"]) {
    const res = await app.inject({
      method: "POST",
      url: `/api/improvement/${BIGINT_OVERFLOW}/${action}`,
    });
    assert.strictEqual(res.statusCode, 400, `${action} → 400`);
    assert.deepStrictEqual(res.json(), { status: "invalid_param", param: "id" });
  }
});
