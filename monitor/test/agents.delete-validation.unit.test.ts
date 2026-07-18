// DELETE /api/agents/:name 이름 검증 회귀 — 선행 하이픈 CLI-플래그 주입 차단 (DF-14).
// validateDeleteRequest 는 자식 프로세스 spawn 이전에 동작하는 순수 함수이므로 DB 무의존.
// route-level probe 도 검증이 CLI spawn 을 선행하므로 Postgres 없이 400 을 확인한다.
// Runner: npx tsx --test test/agents.delete-validation.unit.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import Fastify, { type FastifyInstance } from "fastify";

import {
  buildDeleteCommitArgv,
  registerAgentsRoutes,
  validateDeleteRequest,
} from "../src/server/routes/agents.js";

test("validateDeleteRequest: 선행 하이픈 이름은 error (CLI-플래그 주입 차단)", () => {
  const v = validateDeleteRequest("--dry-run", { mode: "commit", confirm: "--dry-run" });
  assert.strictEqual(v.kind, "error");
  if (v.kind === "error") {
    assert.strictEqual(v.body.field, "name");
  }
});

test("validateDeleteRequest: 단독 하이픈/선행 하이픈 변형 모두 거부", () => {
  for (const bad of ["-x", "--confirm", "-", "-abc"]) {
    const v = validateDeleteRequest(bad, { mode: "preview" });
    assert.strictEqual(v.kind, "error", `${bad} → error`);
  }
});

test("validateDeleteRequest: 정상 슬러그 preview 통과", () => {
  const v = validateDeleteRequest("glass-atrium-dev-react", { mode: "preview" });
  assert.strictEqual(v.kind, "preview");
});

test("validateDeleteRequest: 정상 슬러그 commit 통과 + confirm 반영", () => {
  const v = validateDeleteRequest("glass-atrium-dev-react", {
    mode: "commit",
    confirm: "glass-atrium-dev-react",
  });
  assert.strictEqual(v.kind, "commit");
  if (v.kind === "commit") {
    assert.strictEqual(v.confirm, "glass-atrium-dev-react");
  }
});

test("validateDeleteRequest: 선행 하이픈 confirm 은 error", () => {
  const v = validateDeleteRequest("glass-atrium-dev-react", {
    mode: "commit",
    confirm: "--confirm",
  });
  assert.strictEqual(v.kind, "error");
  if (v.kind === "error") {
    assert.strictEqual(v.body.field, "confirm");
  }
});

test("buildDeleteCommitArgv: name 은 positional 3번째, --confirm 은 별개 argv 원소", () => {
  const argv = buildDeleteCommitArgv("glass-atrium-dev-react", "glass-atrium-dev-react");
  assert.deepStrictEqual(argv, [
    "-m",
    "agent_lifecycle",
    "delete",
    "glass-atrium-dev-react",
    "--confirm",
    "glass-atrium-dev-react",
  ]);
});

test("route DELETE /api/agents/:name: 선행 하이픈 이름 → 400 (DB/CLI 미접촉)", async () => {
  const app: FastifyInstance = Fastify({ logger: false });
  await registerAgentsRoutes(app);
  await app.ready();
  try {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/agents/--dry-run",
      payload: { mode: "commit", confirm: "--dry-run" },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.json().field, "name");
  } finally {
    await app.close();
  }
});
