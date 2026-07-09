// invocations mapper 단위 테스트 — SubagentStart 30d count 를 /api/agents/summary 에 노출.
// 두 helper 모두 순수 함수 → DB 의존 없음.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInvocationsMap,
  mapSuccessRateRows,
  rowToSummaryItem,
} from "../src/server/routes/agents.js";
import { TASK_TYPES } from "../src/server/task-types.js";

// SummaryOutcomeDbRow shape factory (interface 은 module-private → boundary 에서 cast).
function makeOutcomeRow(
  overrides: Record<string, unknown> = {},
): Parameters<typeof rowToSummaryItem>[0] {
  return {
    agent: "test-agent",
    runs: 10n,
    success_count: 9n,
    denom_count: 10n,
    needs_context_count: 0n,
    last_run_at: new Date("2026-05-24T00:00:00.000Z"),
    last_result: "done",
    ...overrides,
  } as Parameters<typeof rowToSummaryItem>[0];
}

// rowToSummaryItem 이 요구하는 최소 context bag factory.
function makeCtx(
  overrides: Partial<Parameters<typeof rowToSummaryItem>[1]> = {},
): Parameters<typeof rowToSummaryItem>[1] {
  return {
    now: new Date("2026-05-24T01:00:00.000Z").getTime(),
    p95ByAgent: new Map<string, number | null>(),
    invocationsByAgent: new Map<string, number>(),
    compatibility: null,
    description: null,
    dualPhase: false,
    ...overrides,
  };
}

test("buildInvocationsMap: bigint COUNT → number Map · 다중 agent 보존", () => {
  const rows = [
    { agent_type: "react-dev", invocations: 471n },
    { agent_type: "reporter", invocations: 307n },
    { agent_type: "planner", invocations: 281n },
  ];
  const map = buildInvocationsMap(rows);

  assert.strictEqual(map.size, 3);
  assert.strictEqual(map.get("react-dev"), 471);
  assert.strictEqual(map.get("reporter"), 307);
  assert.strictEqual(map.get("planner"), 281);
});

test("buildInvocationsMap: 빈 rows → 빈 Map (서버 부트 직후 또는 0-record window)", () => {
  const map = buildInvocationsMap([]);
  assert.strictEqual(map.size, 0);
});

test("buildInvocationsMap: 0 카운트 preserved (NULL 아님 — 명시적 0 spawn 시그널)", () => {
  // 실 SQL 은 GROUP BY 후 0-count row 가 자연스럽게 결과에 포함되지 않지만,
  // 향후 LEFT JOIN 변경 가능성을 고려해 0 → 0 매핑 invariant 명시.
  const rows = [{ agent_type: "dormant-agent", invocations: 0n }];
  const map = buildInvocationsMap(rows);
  assert.strictEqual(map.get("dormant-agent"), 0);
  // Map.has 가 true — 0 과 null 의 의미 분리 (저활용 vs outcomes-only).
  assert.strictEqual(map.has("dormant-agent"), true);
});

test("rowToSummaryItem: invocationsByAgent Map hit → invocations_30d 값 그대로", () => {
  const row = makeOutcomeRow({ agent: "react-dev" });
  const ctx = makeCtx({
    invocationsByAgent: new Map([["react-dev", 471]]),
  });
  const item = rowToSummaryItem(row, ctx);
  assert.strictEqual(item.invocations_30d, 471);
});

test("rowToSummaryItem: Map miss → invocations_30d null (outcomes-only agent 의미)", () => {
  // orchestrator 같은 outcome 만 발생하고 SubagentStart 대상 아닌 agent.
  const row = makeOutcomeRow({ agent: "orchestrator" });
  const ctx = makeCtx({
    invocationsByAgent: new Map([["react-dev", 471]]),
  });
  const item = rowToSummaryItem(row, ctx);
  assert.strictEqual(item.invocations_30d, null);
});

test("rowToSummaryItem: Map hit with 0 → invocations_30d 0 (NOT coerced to null)", () => {
  // 명시적 0 spawn = "최근 30일 호출 0회 · 저활용 후보" 의 정보 신호.
  // null (outcomes-only) 과 0 (호출 가능하지만 0회) 의 의미 분리 invariant.
  const row = makeOutcomeRow({ agent: "dormant-agent" });
  const ctx = makeCtx({
    invocationsByAgent: new Map([["dormant-agent", 0]]),
  });
  const item = rowToSummaryItem(row, ctx);
  assert.strictEqual(item.invocations_30d, 0);
  // 핵심 invariant — falsy 통합 coerce 금지.
  assert.notStrictEqual(item.invocations_30d, null);
});

test("rowToSummaryItem: invocations_30d 추가 무관 · 기존 필드 (runs / success_pct / p95_ms) 보존", () => {
  const row = makeOutcomeRow({
    agent: "react-dev",
    runs: 100n,
    success_count: 95n,
    denom_count: 100n,
  });
  const ctx = makeCtx({
    p95ByAgent: new Map([["react-dev", 1234]]),
    invocationsByAgent: new Map([["react-dev", 471]]),
    compatibility: "monitor running at 127.0.0.1:16145",
  });
  const item = rowToSummaryItem(row, ctx);

  // 기존 contract 보존.
  assert.strictEqual(item.agent_id, "react-dev");
  assert.strictEqual(item.agent_name, "react-dev");
  assert.strictEqual(item.runs, 100);
  assert.strictEqual(item.success_pct, 95);
  assert.strictEqual(item.cost, null);
  assert.strictEqual(item.p95_ms, 1234);
  assert.strictEqual(item.compatibility, "monitor running at 127.0.0.1:16145");
  // 신규 필드.
  assert.strictEqual(item.invocations_30d, 471);
});

test("rowToSummaryItem: success_pct 100 % 반올림 보존", () => {
  // 0 denominator edge case — 분모 0 시 0 % (NaN 회피 invariant).
  const row = makeOutcomeRow({ runs: 0n, success_count: 0n, denom_count: 0n });
  const ctx = makeCtx();
  const item = rowToSummaryItem(row, ctx);
  assert.strictEqual(item.success_pct, 0);
});

test("rowToSummaryItem: matrix 분모 — needs_context 제외 + 별도 카운트 노출 (F21)", () => {
  // 10 runs 중 needs_context 2 → 분모 8 (done+dwc+blocked+fail), success 6 → 75%.
  const row = makeOutcomeRow({
    runs: 10n,
    success_count: 6n,
    denom_count: 8n,
    needs_context_count: 2n,
  });
  const item = rowToSummaryItem(row, makeCtx());
  assert.strictEqual(item.success_pct, 75);
  assert.strictEqual(item.needs_context_count, 2);
});

test("rowToSummaryItem: invocations ↔ invocations_30d alias 동치 (F25 deprecated alias)", () => {
  const row = makeOutcomeRow({ agent: "react-dev" });
  const ctx = makeCtx({ invocationsByAgent: new Map([["react-dev", 42]]) });
  const item = rowToSummaryItem(row, ctx);
  assert.strictEqual(item.invocations, 42);
  assert.strictEqual(item.invocations_30d, item.invocations);
});

test("rowToSummaryItem: status 'fail' last_result → error 분류", () => {
  const row = makeOutcomeRow({ last_result: "fail" });
  const ctx = makeCtx();
  const item = rowToSummaryItem(row, ctx);
  assert.strictEqual(item.status, "error");
});

// SuccessRateDbRow shape factory (interface 은 module-private → boundary 에서 cast).
function makeSuccessRateRow(
  overrides: Record<string, unknown> = {},
): Parameters<typeof mapSuccessRateRows>[0][number] {
  return {
    agent: "test-agent",
    task_type: "bug-fix",
    event_date: new Date("2026-06-01T00:00:00.000Z"),
    success_count: 3n,
    failure_count: 1n,
    total_count: 4n,
    success_rate: null,
    ...overrides,
  } as Parameters<typeof mapSuccessRateRows>[0][number];
}

test("mapSuccessRateRows: canonical 9 task_type 전부 보존 (비코드 4종 silent drop 회귀 차단)", () => {
  // red-team 재현: 5종 allowlist 시절 review/diagnosis/doc/cleanup 124행이 무공시 누락.
  const rows = TASK_TYPES.map((tt) => makeSuccessRateRow({ task_type: tt }));
  const mapped = mapSuccessRateRows(rows);

  assert.strictEqual(mapped.length, TASK_TYPES.length, "9행 모두 생존");
  const survivedTypes = new Set(mapped.map((r) => r.task_type));
  for (const tt of TASK_TYPES) {
    assert.ok(survivedTypes.has(tt), `task_type '${tt}' 보존`);
  }
});

test("mapSuccessRateRows: enum 표면 밖 task_type 만 drop (방어 guard 본래 목적 유지)", () => {
  const rows = [
    makeSuccessRateRow({ task_type: "review" }),
    makeSuccessRateRow({ task_type: "experiment" }), // 미래 migration 가상값
  ];
  const mapped = mapSuccessRateRows(rows);
  assert.strictEqual(mapped.length, 1);
  assert.strictEqual(mapped[0]?.task_type, "review");
});

test("mapSuccessRateRows: bigint → number 강제 + event_date YYYY-MM-DD + null success_rate pass-through", () => {
  const mapped = mapSuccessRateRows([makeSuccessRateRow({ task_type: "doc" })]);
  const row = mapped[0];
  assert.ok(row);
  assert.strictEqual(row.success_count, 3);
  assert.strictEqual(row.failure_count, 1);
  assert.strictEqual(row.total_count, 4);
  assert.strictEqual(row.event_date, "2026-06-01");
  assert.strictEqual(row.success_rate, null);
});

test("rowToSummaryItem: invocations_30d 키 항상 존재 (null pass-through · FE 'in' 체크 안전)", () => {
  // FE 가 has() 가 아닌 has-key 패턴으로 분기 시 invariant.
  const row = makeOutcomeRow();
  const ctx = makeCtx();
  const item = rowToSummaryItem(row, ctx);
  assert.ok("invocations_30d" in item, "invocations_30d key present even when null");
});
