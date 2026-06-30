// db-failure 분류기 + responder 테스트 (M2 taxonomy split 회귀 고정).
// Runner: npx tsx --test test/db-failure.unit.test.ts
//
// Pinned invariant: SQLSTATE class 22/23 → 400 invalid_input(WARN) ·
// 연결류/미상 → 503 database_unavailable(ERROR + sqlstate/kind 구조화 로그).
// 합성 shape 는 @prisma/adapter-pg 7.8 실측 형태(meta.driverAdapterError.cause)와 동일.

import test, { after } from "node:test";
import assert from "node:assert/strict";

import "dotenv/config";

import type { FastifyReply, FastifyRequest } from "fastify";

import { classifyDbFailure, respondDbFailure } from "../src/server/db-failure.js";
import { disconnectPrisma, getPrisma } from "../src/server/db.js";

after(async () => {
  await disconnectPrisma();
});

// Prisma 7 driver-adapter 에러 합성 빌더 — 실측 shape 미러.
function makeAdapterError(cause: Record<string, unknown>): Error {
  const error = new Error("Raw query failed.");
  Object.assign(error, {
    code: "P2010",
    meta: { driverAdapterError: { name: "DriverAdapterError", cause } },
  });
  return error;
}

test("classifyDbFailure: SQLSTATE class 22/23 → input", () => {
  const overflow = classifyDbFailure(
    makeAdapterError({
      originalCode: "22003",
      originalMessage: 'value "9223372036854775808" is out of range for type bigint',
    }),
  );
  assert.strictEqual(overflow.kind, "input");
  assert.strictEqual(overflow.sqlState, "22003");
  assert.ok(overflow.reason.includes("out of range"), "pg 메시지가 reason 으로 전달");

  const fk = classifyDbFailure(
    makeAdapterError({ originalCode: "23503", originalMessage: "violates foreign key constraint" }),
  );
  assert.strictEqual(fk.kind, "input");
  assert.strictEqual(fk.sqlState, "23503");
});

test("classifyDbFailure: 연결류 SQLSTATE / DatabaseNotReachable / syscall code → outage", () => {
  assert.strictEqual(
    classifyDbFailure(makeAdapterError({ originalCode: "08006", originalMessage: "x" })).kind,
    "outage",
  );
  assert.strictEqual(
    classifyDbFailure(makeAdapterError({ originalCode: "57P01", originalMessage: "x" })).kind,
    "outage",
  );
  assert.strictEqual(
    classifyDbFailure(makeAdapterError({ kind: "DatabaseNotReachable", host: "h", port: 1 })).kind,
    "outage",
  );
  const syscall = new Error("connect ECONNREFUSED");
  Object.assign(syscall, { code: "ECONNREFUSED" });
  assert.strictEqual(classifyDbFailure(syscall).kind, "outage");
});

test("classifyDbFailure: 비입력·비연결 SQLSTATE(42601)와 일반 Error → unknown (503 유지)", () => {
  const syntax = classifyDbFailure(
    makeAdapterError({ originalCode: "42601", originalMessage: "syntax error" }),
  );
  assert.strictEqual(syntax.kind, "unknown");
  assert.strictEqual(syntax.sqlState, "42601", "코드 버그도 sqlstate 가 로그로 드러남");

  assert.strictEqual(classifyDbFailure(new Error("plain")).kind, "unknown");
  assert.strictEqual(classifyDbFailure(null).kind, "unknown");
});

test("classifyDbFailure: P2010 자체는 SQLSTATE 로 오인하지 않음", () => {
  // adapter cause 없이 code=P2010 만 있는 에러 — P-prefix 제외 가드.
  const bare = new Error("Raw query failed.");
  Object.assign(bare, { code: "P2010" });
  assert.strictEqual(classifyDbFailure(bare).kind, "unknown");
});

// respondDbFailure 상태코드/로그레벨 매핑 — 최소 stub (호출 기록만).
function makeReplyStub(): { reply: FastifyReply; codes: number[] } {
  const codes: number[] = [];
  const reply = {
    code(status: number) {
      codes.push(status);
      return this;
    },
  } as unknown as FastifyReply;
  return { reply, codes };
}

test("respondDbFailure: input → 400 invalid_input + WARN · unknown → 503 + ERROR", () => {
  const counters = { warns: 0, errors: 0 };
  const request = {
    log: {
      warn: () => {
        counters.warns += 1;
      },
      error: () => {
        counters.errors += 1;
      },
    },
  } as unknown as FastifyRequest;

  const inputCase = makeReplyStub();
  const inputBody = respondDbFailure(
    request,
    inputCase.reply,
    "/test",
    makeAdapterError({ originalCode: "23503", originalMessage: "fk" }),
    "test query failed",
  );
  assert.deepStrictEqual(inputCase.codes, [400]);
  assert.deepStrictEqual(inputBody, { error: "invalid_input", reason: "fk" });
  assert.strictEqual(counters.warns, 1);
  assert.strictEqual(counters.errors, 0);

  const outageCase = makeReplyStub();
  const outageBody = respondDbFailure(
    request,
    outageCase.reply,
    "/test",
    new Error("plain"),
    "test query failed",
  );
  assert.deepStrictEqual(outageCase.codes, [503]);
  assert.deepStrictEqual(outageBody, { error: "database_unavailable" });
  assert.strictEqual(counters.errors, 1);
});

test("classifyDbFailure: live adapter 실측 — bigint overflow 가 input 으로 분류", async () => {
  // 합성 shape 가 어댑터 버전과 드리프트하면 여기서 잡힘 (read-only 쿼리).
  const prisma = getPrisma();
  try {
    await prisma.$queryRaw`SELECT ${"abc"}::bigint AS v`;
    assert.fail("invalid cast must throw");
  } catch (error) {
    const classification = classifyDbFailure(error);
    assert.strictEqual(classification.kind, "input");
    assert.strictEqual(classification.sqlState, "22P02");
  }
});
