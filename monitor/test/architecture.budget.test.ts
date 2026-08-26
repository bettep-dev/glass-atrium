// Content-budget tests (AC-1~AC-5, AC-8, AC-9) — the counting gate for the ONE drawn diagram.
// Target artifact is CANONICAL_MAP.mermaid_drawn, never mermaid_source: the 7 sources stay complete
// so daemon-binding / flow-extractor / verify-arch Stage-2 keep their subject.
// Runner: npx tsx --test test/architecture.budget.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { CANONICAL_MAP, DIAGRAMS } from "../src/server/architecture/diagrams-source.js";
import { registerHealthDetailRoutes } from "../src/server/routes/health-detail.js";
import {
  BUDGET_CAPS,
  LABEL_CAP_EXEMPT_NODE_IDS,
  getBudgetReport,
  getMermaidCensus,
} from "../src/server/architecture/content-budget.js";

// T3 grade assignment for the canonical map — the budget test compares the declared value against it,
// so raising `detail` to dodge a cap reddens here instead of silently widening the budget.
const ASSIGNED_GRADE = "balanced";

const canonicalSource = DIAGRAMS.find((d) => d.slug === CANONICAL_MAP.slug);
const drawn = CANONICAL_MAP.mermaid_drawn;
const caps = BUDGET_CAPS[ASSIGNED_GRADE];

const FIXTURE = `flowchart LR
    subgraph zone["Zone"]
        a["Alpha"]
        b["Beta"]
    end
    a -- "does" --> b`;

const NESTED_FIXTURE = `flowchart LR
    subgraph outer["Outer"]
        subgraph inner["Inner"]
            a["Alpha"]
        end
    end`;

test("AC-1 one counting path — census and report read the same fixture through one counter", () => {
  const census = getMermaidCensus(FIXTURE);
  // 같은 픽스처가 두 소비자(census 직접 · report 의 measures)를 거쳐도 같은 수치여야 함 —
  // 두 번째 계수 경로가 생기면 여기서 붉어짐.
  const measured = Object.fromEntries(
    getBudgetReport(FIXTURE, ASSIGNED_GRADE).measures.map((m) => [m.metric, m.measured]),
  );
  assert.equal(measured.nodes, census.nodeCount);
  assert.equal(measured.edges, census.edgeCount);
  assert.equal(measured.subgraph_depth, census.maxSubgraphDepth);
  assert.equal(census.nodeCount, 2, "subgraph zone ids are not nodes");
  assert.equal(census.edgeCount, 1);
  assert.equal(census.maxSubgraphDepth, 1);
});

test("AC-7 declared detail matches the T3 assignment", () => {
  assert.equal(CANONICAL_MAP.detail, ASSIGNED_GRADE);
  assert.ok(canonicalSource !== undefined, "canonical slug must exist in DIAGRAMS");
});

test("AC-2 drawn subgraph nesting depth <= cap", () => {
  assert.ok(getMermaidCensus(drawn).maxSubgraphDepth <= caps.subgraphDepth);
  // adversarial: depth-2 fixture must be reported as a fail, not absorbed
  assert.equal(getBudgetReport(NESTED_FIXTURE, ASSIGNED_GRADE).state, "fail");
});

test("AC-3 drawn node count <= its grade cap", () => {
  const report = getBudgetReport(drawn, ASSIGNED_GRADE);
  const nodes = report.measures.find((m) => m.metric === "nodes");
  assert.ok(nodes !== undefined && nodes.measured <= nodes.cap, `nodes ${nodes?.measured} > cap ${nodes?.cap}`);
});

test("AC-4 drawn edge count <= its grade cap", () => {
  const edges = getBudgetReport(drawn, ASSIGNED_GRADE).measures.find((m) => m.metric === "edges");
  assert.ok(edges !== undefined && edges.measured <= edges.cap, `edges ${edges?.measured} > cap ${edges?.cap}`);
});

test("AC-5 drawn node label chars <= its grade cap outside the literal exemption list", () => {
  for (const node of getMermaidCensus(drawn).nodes) {
    if (LABEL_CAP_EXEMPT_NODE_IDS.includes(node.id)) continue;
    assert.ok(
      node.label.length <= caps.labelChars,
      `label of '${node.id}' is ${node.label.length} chars > cap ${caps.labelChars}`,
    );
  }
  // adversarial: cap+1 label reddens
  const over = `flowchart LR\n    x["${"L".repeat(caps.labelChars + 1)}"]`;
  assert.equal(getBudgetReport(over, ASSIGNED_GRADE).state, "fail");
});

test("AC-8 omitted_node_ids ledger is honest while drawn is smaller than source", () => {
  assert.ok(canonicalSource !== undefined);
  const sourceCensus = getMermaidCensus(canonicalSource.mermaid_source);
  const drawnCensus = getMermaidCensus(drawn);
  if (drawnCensus.nodeCount < sourceCensus.nodeCount) {
    assert.ok(CANONICAL_MAP.omitted_node_ids.length > 0, "reduction happened but the ledger is empty");
  }
  const sourceIds = new Set(sourceCensus.nodes.map((n) => n.id));
  const drawnIds = new Set(drawnCensus.nodes.map((n) => n.id));
  for (const id of CANONICAL_MAP.omitted_node_ids) {
    assert.ok(sourceIds.has(id), `omitted id '${id}' does not exist in the source`);
    assert.ok(!drawnIds.has(id), `omitted id '${id}' is still drawn`);
  }
});

test("AC-9 three states come from the ratio band and violations name (metric, measured, cap)", () => {
  const getNodeLines = (n: number) =>
    Array.from({ length: n }, (_, i) => `    n${i}["x"]`).join("\n");
  const failing = getBudgetReport(`flowchart LR\n${getNodeLines(caps.nodes + 1)}`, ASSIGNED_GRADE);
  // ratio 1.0 boundary and 0.95-equivalent both land in warn; > 1.0 fails; < 0.9 passes
  assert.equal(getBudgetReport(`flowchart LR\n${getNodeLines(caps.nodes)}`, ASSIGNED_GRADE).state, "warn");
  assert.equal(failing.state, "fail");
  assert.equal(getBudgetReport(`flowchart LR\n${getNodeLines(1)}`, ASSIGNED_GRADE).state, "pass");

  assert.equal(failing.violations.length >= 1, true);
  for (const v of failing.violations) {
    assert.equal(typeof v.metric, "string");
    assert.equal(typeof v.measured, "number");
    assert.equal(typeof v.cap, "number");
  }
  assert.match(failing.note, /Proxy metric/);
});

test("AC-4 (adversarial) 체인 줄은 화살표 토큰마다 1엣지 — 체이닝으로 엣지 상한을 우회할 수 없음", () => {
  assert.equal(getMermaidCensus('flowchart LR\n    a["A"] --> b["B"] --> c["C"]').edgeCount, 2);
  // 인용 라벨 안의 화살표 문자열은 엣지가 아님(따옴표 제거 후 계수).
  assert.equal(getMermaidCensus('flowchart LR\n    a["-->"] --> b["B"]').edgeCount, 1);
});

test("AC-9 (route) 예산 health 표면이 등록되어 있고 slug/omitted_node_ids 를 리포트 위에 합성함", async () => {
  // 라우트 소스 정규식이 아니라 실제 등록된 핸들러의 응답 본문을 봄 —
  // 런타임에 던지는 라우트는 붉어지고, 포맷/핸들러 이름 변경으로는 붉어지지 않음.
  const app = Fastify({ logger: false });
  await registerHealthDetailRoutes(app);
  const res = await app.inject({ method: "GET", url: "/api/health/architecture-budget" });
  await app.close();

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.slug, CANONICAL_MAP.slug);
  assert.deepEqual(body.omitted_node_ids, CANONICAL_MAP.omitted_node_ids);
  // 합성의 나머지 절반 — 스프레드되는 리포트가 state/grade/note 를 실제로 싣는지.
  assert.equal(body.state, getBudgetReport(drawn, CANONICAL_MAP.detail).state);
  assert.equal(body.grade, ASSIGNED_GRADE);
  assert.ok(body.note.length > 0);
});
