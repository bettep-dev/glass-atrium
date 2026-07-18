// /api/agents/review-flag-timeseries gap-day 회귀 (DF-11) — 제로-활동 일자의
// LEFT JOIN gap-fill phantom(all-NULL o) 행에서 metric_pass IS NULL 이 TRUE 라
// empty_metric_count 가 1 로 부풀던 결함. o.id IS NOT NULL 가드로 gap 일자는 0.
// DB: real Postgres — seed 는 suite 고유 agent/cid, cleanup 은 cid LIKE.
// Runner: npx tsx --test test/agents.review-flag-gap-day.route.test.ts

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
import type { AgentReviewFlagTimeseriesResponse } from "../src/server/types/agents.js";

const SUITE_MARKER = `rf-gap-test-${randomUUID().slice(0, 8)}`;

// 단일 seed agent 만 registry 멤버로 두어 membership gate 가 이 agent 로 한정 →
// 다른 agent 활동이 gap 일자를 오염시키지 못하게 한다(hermeticity).
const REGISTRY_FIXTURE = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    [SUITE_MARKER]: { domains: ["test"], phase: "implementation", dual_phase: false },
  },
};

let app: FastifyInstance;
let tmpRoot: string;

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "rf-gap-registry-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerAgentsRoutes(app);
  await app.ready();

  // 오늘 하루에만 1행 적재(metric_pass NULL = 실제 empty-metric) → 나머지 6일은 gap.
  const prisma = getPrisma();
  await prisma.$executeRaw`
    INSERT INTO core.outcomes
      (record_ts, agent, task_type, result, summary, metric_pass, cid)
    VALUES
      (NOW(), ${SUITE_MARKER}, 'feature'::core."TaskType",
       'done'::core."OutcomeResult", 'rf gap-day seed', NULL,
       ${`${SUITE_MARKER}-today`})
  `;
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`DELETE FROM core.outcomes WHERE cid LIKE ${`%${SUITE_MARKER}%`}`;
  } catch (error) {
    console.error("[rf-gap-day cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

test("review-flag-timeseries: gap 일자 empty_metric_count/ratio == 0 (phantom 배제)", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/agents/review-flag-timeseries?days=7",
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AgentReviewFlagTimeseriesResponse;

  const gapDays = body.rows.filter((r) => r.total_count === 0);
  assert.ok(gapDays.length > 0, "days=7, 활동 1일 → gap 일자 최소 1개 존재");
  for (const day of gapDays) {
    assert.strictEqual(day.empty_metric_count, 0, `gap ${day.event_date} empty_metric_count 0`);
    assert.strictEqual(day.empty_metric_ratio, 0, `gap ${day.event_date} empty_metric_ratio 0`);
  }
});

test("review-flag-timeseries: 실제 empty-metric 일자는 여전히 카운트 (가드 과잉배제 아님)", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/agents/review-flag-timeseries?days=7",
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as AgentReviewFlagTimeseriesResponse;

  const activeDay = body.rows.find((r) => r.total_count === 1);
  assert.ok(activeDay !== undefined, "활동 1일 행 존재");
  assert.strictEqual(activeDay.empty_metric_count, 1, "metric_pass NULL 실행 1건 카운트 유지");
});
