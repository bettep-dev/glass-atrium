// Integration tests for /api/telemetry/* route handlers.
// Runner: npx tsx --test test/telemetry.route.test.ts
// DB: real Postgres — cid 컬럼 SUITE_MARKER 표식 → after() 가 LIKE 매칭 cleanup.

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
import { registerTelemetryRoutes } from "../src/server/routes/telemetry.js";

// SUITE_MARKER — 각 행 cid 컬럼에 박아 cleanup 기준으로 사용.
const SUITE_MARKER = `telemetry-test-${randomUUID()}`;
// Agent-name base — suite-unique (fits VarChar(64)) so canonical/noise names never
// collide with concurrent sessions and the registry gate is the sole discriminator.
const AGENT_TAG = `tel-${randomUUID().slice(0, 8)}`;
const CANON_A = `${AGENT_TAG}-a`;
const CANON_B = `${AGENT_TAG}-b`;
const NOISE_AGENT = `${AGENT_TAG}-noise`;
// Literal noise tokens mirroring real-world non-registry pollution — gated out of the
// rendered list regardless of how many exist in the shared table.
const NOISE_LITERALS = ["subagent_stop_missing", "general-purpose"];

// Registry fixture — CANON_A/CANON_B are the ONLY registered agents; every noise name
// (unique + literal) is absent, so the rendered-list gate excludes it deterministically.
const REGISTRY_FIXTURE = {
  $schema: "agent-registry",
  version: "1.1",
  agents: {
    [CANON_A]: { domains: ["test"], phase: "implementation", dual_phase: false },
    [CANON_B]: { domains: ["test"], phase: "implementation", dual_phase: false },
  },
};

let app: FastifyInstance;
let tmpRoot: string;

// 라벨에 SUITE_MARKER 포함 (cleanup 안전성).
function makeCid(label: string): string {
  return `${SUITE_MARKER}-${label}-${randomUUID().slice(0, 8)}`;
}

before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "telemetry-registry-"));
  const registryPath = join(tmpRoot, "agent-registry.json");
  await writeFile(registryPath, JSON.stringify(REGISTRY_FIXTURE), "utf8");
  process.env.AGENT_REGISTRY_PATH = registryPath;
  resetAgentRegistryCache();

  app = Fastify({ logger: false });
  await registerTelemetryRoutes(app);
  await app.ready();
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  // DB scrub — cid LIKE %SUITE_MARKER%.
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`
      DELETE FROM core.skill_activations WHERE cid LIKE ${`%${SUITE_MARKER}%`}
    `;
  } catch (error) {
    // surface, never throw — disconnect 도 시도해야 함.
    console.error("[telemetry-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
  delete process.env.AGENT_REGISTRY_PATH;
  resetAgentRegistryCache();
  await rm(tmpRoot, { recursive: true, force: true });
});

test("POST /api/telemetry/activation: happy path — 201 + id + occurred_at", async () => {
  const cid = makeCid("post-happy");
  const res = await app.inject({
    method: "POST",
    url: "/api/telemetry/activation",
    payload: {
      source: "orchestrator",
      agent_name: "debugger",
      trigger_phrase: "test trigger",
      selected: true,
      match_score: 0.85,
      cid,
      metadata: { test: true },
    },
  });
  assert.strictEqual(res.statusCode, 201);
  const body = res.json() as { id: number; occurred_at: string };
  assert.ok(Number.isInteger(body.id), "id is integer");
  assert.ok(body.id > 0, "id is positive");
  assert.ok(/\d{4}-\d{2}-\d{2}T/.test(body.occurred_at), "occurred_at is ISO");
});

test("POST /api/telemetry/activation: selected=false 도 정상 적재 (false-positive baseline)", async () => {
  const cid = makeCid("post-falsepos");
  const res = await app.inject({
    method: "POST",
    url: "/api/telemetry/activation",
    payload: {
      source: "subagent",
      agent_name: "react-dev",
      selected: false,
      cid,
    },
  });
  assert.strictEqual(res.statusCode, 201);
});

test("POST /api/telemetry/activation: invalid source → 400 invalid_body field=source", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/telemetry/activation",
    payload: {
      source: "bogus",
      agent_name: "x",
      selected: true,
    },
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { error: string; field: string };
  assert.strictEqual(body.error, "invalid_body");
  assert.strictEqual(body.field, "source");
});

test("POST /api/telemetry/activation: agent_name 누락 → 400 field=agent_name", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/telemetry/activation",
    payload: {
      source: "manual",
      selected: true,
    },
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { error: string; field: string };
  assert.strictEqual(body.field, "agent_name");
});

test("POST /api/telemetry/activation: match_score 범위 외 (1.5) → 400 field=match_score", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/telemetry/activation",
    payload: {
      source: "hook",
      agent_name: "x",
      selected: true,
      match_score: 1.5,
    },
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { field: string };
  assert.strictEqual(body.field, "match_score");
});

test("POST /api/telemetry/activation: selected boolean 누락 → 400 field=selected", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/telemetry/activation",
    payload: {
      source: "manual",
      agent_name: "x",
    },
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { field: string };
  assert.strictEqual(body.field, "selected");
});

test("GET /api/telemetry/activations: 빈 결과 (필터 외) → total=0 + 빈 rows", async () => {
  // 절대 존재하지 않는 agent 이름으로 필터.
  const res = await app.inject({
    method: "GET",
    url: `/api/telemetry/activations?days=1&agent=does-not-exist-${randomUUID()}`,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    total: number;
    rows: unknown[];
    summary: { total_activations: number };
  };
  assert.strictEqual(body.total, 0);
  assert.deepStrictEqual(body.rows, []);
  assert.strictEqual(body.summary.total_activations, 0);
});

test("GET /api/telemetry/activations: POST 후 조회 + summary 통계 검증", async () => {
  // 동일 cid prefix 로 3건 INSERT — selected true 2건 / false 1건.
  // Registered canonical agent — survives the rendered-list + FP-distribution gate.
  const cidBase = makeCid("get-summary");
  const agentName = CANON_A;
  for (let i = 0; i < 2; i += 1) {
    const res = await app.inject({
      method: "POST",
      url: "/api/telemetry/activation",
      payload: {
        source: "orchestrator",
        agent_name: agentName,
        selected: true,
        cid: `${cidBase}-sel-${i}`,
      },
    });
    assert.strictEqual(res.statusCode, 201);
  }
  const resFalse = await app.inject({
    method: "POST",
    url: "/api/telemetry/activation",
    payload: {
      source: "orchestrator",
      agent_name: agentName,
      selected: false,
      cid: `${cidBase}-unsel`,
    },
  });
  assert.strictEqual(resFalse.statusCode, 201);

  // agent 필터로 조회 — 3건 전체 + summary 통계.
  const list = await app.inject({
    method: "GET",
    url: `/api/telemetry/activations?days=1&agent=${encodeURIComponent(agentName)}`,
  });
  assert.strictEqual(list.statusCode, 200);
  const body = list.json() as {
    total: number;
    rows: { agent_name: string | null; selected: boolean }[];
    summary: {
      total_activations: number;
      selected_count: number;
      unselected_count: number;
      overall_false_positive_rate: number;
      false_positive_by_dimension: {
        dimension: string;
        name: string;
        total: number;
        unselected: number;
        false_positive_rate: number;
      }[];
    };
  };
  assert.strictEqual(body.total, 3, "3건 모두 매칭");
  // Registered canonical agent passes the rendered-list gate → all 3 rows present.
  assert.strictEqual(body.rows.length, 3, "canonical rows survive the list gate");
  assert.ok(
    body.rows.every((r) => r.agent_name === agentName),
    "all rendered rows are the canonical agent",
  );
  assert.strictEqual(body.summary.total_activations, 3);
  assert.strictEqual(body.summary.selected_count, 2);
  assert.strictEqual(body.summary.unselected_count, 1);
  // 1 / 3 = 0.3333...
  assert.ok(
    Math.abs(body.summary.overall_false_positive_rate - 1 / 3) < 0.001,
    `overall_false_positive_rate ≈ 1/3 (got ${body.summary.overall_false_positive_rate})`,
  );
  // 분포에 해당 agent 1행 존재.
  const matched = body.summary.false_positive_by_dimension.find(
    (r) => r.dimension === "agent" && r.name === agentName,
  );
  assert.ok(matched !== undefined, `agent dimension row found: ${agentName}`);
  assert.strictEqual(matched.total, 3);
  assert.strictEqual(matched.unselected, 1);
});

test("GET /api/telemetry/activations: selected=false 필터 → 미선택 행만", async () => {
  const cid = makeCid("filter-selected-false");
  // Registered canonical agent (distinct from the summary test) — survives the list gate.
  const agentName = CANON_B;
  // selected=true 1건 + selected=false 1건 적재.
  await app.inject({
    method: "POST",
    url: "/api/telemetry/activation",
    payload: { source: "manual", agent_name: agentName, selected: true, cid: `${cid}-T` },
  });
  await app.inject({
    method: "POST",
    url: "/api/telemetry/activation",
    payload: { source: "manual", agent_name: agentName, selected: false, cid: `${cid}-F` },
  });

  // selected=false 만 가져오기.
  const res = await app.inject({
    method: "GET",
    url: `/api/telemetry/activations?days=1&agent=${encodeURIComponent(agentName)}&selected=false`,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as {
    total: number;
    rows: { selected: boolean }[];
    filter: { selected: boolean | null };
  };
  assert.strictEqual(body.total, 1);
  assert.strictEqual(body.rows.length, 1);
  assert.strictEqual(body.rows[0].selected, false);
  assert.strictEqual(body.filter.selected, false);
});

// T11 — the RENDERED raw-activations list is registry-gated (agent_name), while the
// summary TOTALS stay all-agent (documented invariant). Both proven deterministically
// via a suite-unique noise agent (isolated by the agent= filter).
test("T11: rendered list excludes non-registry agent_name; summary total still counts it", async () => {
  const cidBase = makeCid("t11-noise");
  // Seed 2 activations under a NON-registry (noise) agent — 1 selected / 1 not.
  for (let i = 0; i < 2; i += 1) {
    const res = await app.inject({
      method: "POST",
      url: "/api/telemetry/activation",
      payload: {
        source: "orchestrator",
        agent_name: NOISE_AGENT,
        selected: i === 0,
        cid: `${cidBase}-${i}`,
      },
    });
    assert.strictEqual(res.statusCode, 201);
  }

  const list = await app.inject({
    method: "GET",
    url: `/api/telemetry/activations?days=1&agent=${encodeURIComponent(NOISE_AGENT)}`,
  });
  assert.strictEqual(list.statusCode, 200);
  const body = list.json() as {
    total: number;
    rows: { agent_name: string | null }[];
    summary: { total_activations: number };
  };

  // (1) Rendered LIST is registry-gated → the non-registry agent's rows are excluded.
  assert.strictEqual(body.rows.length, 0, "noise agent excluded from rendered list");
  // (2) Summary total stays all-agent → the 2 noise rows are STILL counted.
  assert.strictEqual(
    body.summary.total_activations,
    2,
    "summary total counts noise (all-agent invariant preserved)",
  );

  // Literal non-registry tokens are likewise gated out of the rendered list.
  for (const literal of NOISE_LITERALS) {
    const litCid = makeCid(`t11-lit-${literal}`);
    const post = await app.inject({
      method: "POST",
      url: "/api/telemetry/activation",
      payload: { source: "hook", agent_name: literal, selected: false, cid: litCid },
    });
    assert.strictEqual(post.statusCode, 201);
    const litList = await app.inject({
      method: "GET",
      url: `/api/telemetry/activations?days=1&agent=${encodeURIComponent(literal)}`,
    });
    assert.strictEqual(litList.statusCode, 200);
    const litBody = litList.json() as { rows: { agent_name: string | null }[] };
    assert.ok(
      !litBody.rows.some((r) => r.agent_name === literal),
      `non-registry literal '${literal}' must be excluded from the rendered list`,
    );
  }
});

test("GET /api/telemetry/activations: days 범위 외 (0) → 400 invalid_param field=days", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/telemetry/activations?days=0",
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { error: string; field: string };
  assert.strictEqual(body.error, "invalid_param");
  assert.strictEqual(body.field, "days");
});

test("GET /api/telemetry/activations: selected 잘못된 값 ('maybe') → 400 field=selected", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/telemetry/activations?days=7&selected=maybe",
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { field: string };
  assert.strictEqual(body.field, "selected");
});

// parseIntInRange 헬퍼 회귀 가드 (limit/offset 범위 외 단일 케이스).
test("GET /api/telemetry/activations: limit=0 → 400 invalid_param field=limit", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/telemetry/activations?days=7&limit=0",
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { error: string; field: string };
  assert.strictEqual(body.error, "invalid_param");
  assert.strictEqual(body.field, "limit");
});

test("GET /api/telemetry/activations: offset=-1 → 400 invalid_param field=offset", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/telemetry/activations?days=7&offset=-1",
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { error: string; field: string };
  assert.strictEqual(body.error, "invalid_param");
  assert.strictEqual(body.field, "offset");
});
