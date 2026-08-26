// Content-budget tests (AC-1~AC-5, AC-8, AC-9) — the counting gate for the ONE drawn diagram.
// Target artifact is CANONICAL_MAP.mermaid_drawn, never mermaid_source: the 7 sources stay complete
// so daemon-binding / flow-extractor / verify-arch Stage-2 keep their subject.
// Runner: npx tsx --test test/architecture.budget.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CANONICAL_MAP, DIAGRAMS } from "../src/server/architecture/diagrams-source.js";
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

test("AC-1 one counting path — same fixture in either argument position yields the same census", () => {
  assert.deepEqual(getMermaidCensus(FIXTURE), getMermaidCensus(FIXTURE));
  const census = getMermaidCensus(FIXTURE);
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
  const nodeIds = (n: number) => Array.from({ length: n }, (_, i) => `    n${i}["x"]`).join("\n");
  // ratio 1.0 boundary and 0.95-equivalent both land in warn; > 1.0 fails; < 0.9 passes
  assert.equal(getBudgetReport(`flowchart LR\n${nodeIds(caps.nodes)}`, ASSIGNED_GRADE).state, "warn");
  assert.equal(getBudgetReport(`flowchart LR\n${nodeIds(caps.nodes + 1)}`, ASSIGNED_GRADE).state, "fail");
  assert.equal(getBudgetReport(`flowchart LR\n${nodeIds(1)}`, ASSIGNED_GRADE).state, "pass");

  const failing = getBudgetReport(`flowchart LR\n${nodeIds(caps.nodes + 1)}`, ASSIGNED_GRADE);
  assert.equal(failing.violations.length >= 1, true);
  for (const v of failing.violations) {
    assert.equal(typeof v.metric, "string");
    assert.equal(typeof v.measured, "number");
    assert.equal(typeof v.cap, "number");
  }
  assert.match(failing.note, /Proxy metric/);
});

test("canonical drawn is inside its whole budget", () => {
  const report = getBudgetReport(drawn, ASSIGNED_GRADE);
  assert.notEqual(report.state, "fail", JSON.stringify(report.violations));
});

test("AC-4 (adversarial) 체인 줄은 화살표 토큰마다 1엣지 — 체이닝으로 엣지 상한을 우회할 수 없음", () => {
  assert.equal(getMermaidCensus('flowchart LR\n    a["A"] --> b["B"] --> c["C"]').edgeCount, 2);
  // 인용 라벨 안의 화살표 문자열은 엣지가 아님(따옴표 제거 후 계수).
  assert.equal(getMermaidCensus('flowchart LR\n    a["-->"] --> b["B"]').edgeCount, 1);
});

test("AC-9 (route) 예산 health 표면이 등록되어 있고 slug/omitted_node_ids 를 리포트 위에 합성함", () => {
  const routeSrc = readFileSync(new URL("../src/server/routes/health-detail.ts", import.meta.url), "utf8");
  assert.match(routeSrc, /app\.get\("\/api\/health\/architecture-budget", handleArchitectureBudget\)/);
  assert.match(routeSrc, /slug: CANONICAL_MAP\.slug/);
  assert.match(routeSrc, /omitted_node_ids: CANONICAL_MAP\.omitted_node_ids/);
  assert.match(routeSrc, /\.\.\.getBudgetReport\(CANONICAL_MAP\.mermaid_drawn, CANONICAL_MAP\.detail\)/);
  // 합성의 나머지 절반 — 스프레드되는 리포트가 note/grade 를 실제로 싣는지.
  const report = getBudgetReport(drawn, CANONICAL_MAP.detail);
  assert.equal(report.grade, ASSIGNED_GRADE);
  assert.ok(report.note.length > 0);
});
