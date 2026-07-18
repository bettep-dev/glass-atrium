// flow-extractor unit tests — split-label edge 문법(`A -- "l" --> B` 계열) + hyphen node-id + parse-drift observability.
// Runner: npx tsx --test test/architecture.flow-extractor.test.ts
// No DB dependency — pure parser unit test + SoT(DIAGRAMS) parity 검증.

import test from "node:test";
import assert from "node:assert/strict";

import { extractFlows, type ExtractedFlow } from "../src/server/architecture/flow-extractor.js";
import { DIAGRAMS } from "../src/server/architecture/diagrams-source.js";
import {
  getArchitecture,
  resetArchitectureCache,
} from "../src/server/architecture/parser.js";

const silentLogger = { warn() {}, info() {} };

function extract(mermaidSource: string): ExtractedFlow {
  return extractFlows(mermaidSource, {
    idPrefix: "t",
    edgeIdPrefix: "t",
    logger: silentLogger,
  });
}

// 시맨틱 edge 1개당 closing token 정확히 1개: solid(compact `-->` · split `-- l -->`) → `-->`,
// dotted(compact `-.->` · split `-. l .->`) → `.->`, thick → `==>`. skip op(~~~/--o/--x)는 비포함.
function countSourceArrows(mermaidSource: string): number {
  return (
    (mermaidSource.match(/-->/g) ?? []).length +
    (mermaidSource.match(/\.->/g) ?? []).length +
    (mermaidSource.match(/==>/g) ?? []).length
  );
}

test("split-label solid: A -- \"label\" --> B → 1 edge + label 보존", () => {
  const out = extract('flowchart LR\n    A -- "위임 (CID)" --> B');
  assert.equal(out.edges.length, 1);
  const edge = out.edges[0];
  assert.ok(edge !== undefined);
  assert.equal(edge.from, "t.A");
  assert.equal(edge.to, "t.B");
  assert.equal(edge.label, "위임 (CID)");
  assert.equal(edge.style, undefined);
  assert.equal(edge.condition, undefined);
});

test("split-label dotted: A -. \"label\" .-> B → dashed + condition", () => {
  const out = extract('flowchart LR\n    A -. "격리 신호" .-> B');
  assert.equal(out.edges.length, 1);
  const edge = out.edges[0];
  assert.ok(edge !== undefined);
  assert.equal(edge.style, "dashed");
  assert.equal(edge.label, "격리 신호");
  assert.equal(edge.condition, "격리 신호");
});

test("split-label thick: A == \"label\" ==> B → data_flow", () => {
  const out = extract('flowchart LR\n    A == "payload" ==> B');
  assert.equal(out.edges.length, 1);
  const edge = out.edges[0];
  assert.ok(edge !== undefined);
  assert.equal(edge.edge_type, "data_flow");
  assert.equal(edge.label, "payload");
});

test("split-label unquoted: A -- handoff --> B → label 보존", () => {
  const out = extract("flowchart LR\n    A -- handoff --> B");
  assert.equal(out.edges.length, 1);
  const edge = out.edges[0];
  assert.ok(edge !== undefined);
  assert.equal(edge.label, "handoff");
});

test("split-label label 내 hyphen: -- \"2-tier 갱신\" --> 파싱", () => {
  const out = extract('flowchart LR\n    from_improvement -- "2-tier (auto/safety) 지침 갱신" --> agents');
  assert.equal(out.edges.length, 1);
  const edge = out.edges[0];
  assert.ok(edge !== undefined);
  assert.equal(edge.label, "2-tier (auto/safety) 지침 갱신");
});

test("chained: A -- \"x\" --> B --> C → 2 edges", () => {
  const out = extract('flowchart LR\n    A -- "코드" --> B --> C');
  assert.equal(out.edges.length, 2);
  assert.equal(out.edges[0]?.to, "t.B");
  assert.equal(out.edges[1]?.from, "t.B");
  assert.equal(out.edges[1]?.to, "t.C");
});

test("hyphen node-id: node def + edge 양쪽에서 추출", () => {
  const out = extract(
    "flowchart LR\n" +
      "    design-designer[design-designer · HTML Co-Emission]\n" +
      '    design-designer -. "자문 verdict" .-> intel-reporter',
  );
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("design-designer")?.label, "design-designer · HTML Co-Emission");
  assert.ok(byId.has("intel-reporter"));
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0]?.from, "t.design-designer");
  assert.equal(out.edges[0]?.to, "t.intel-reporter");
});

test("compact 회귀: pipe label + 무공백 edge 유지", () => {
  const piped = extract("flowchart LR\n    request_branch -->|HTML 명시| exposed_html");
  assert.equal(piped.edges.length, 1);
  assert.equal(piped.edges[0]?.label, "HTML 명시");

  // 무공백 `A-->B` — hyphen id 확장이 bare-id 의 op 침식을 일으키지 않는지.
  const compactNoSpace = extract("flowchart LR\n    A-->B");
  assert.equal(compactNoSpace.edges.length, 1);
  assert.equal(compactNoSpace.edges[0]?.from, "t.A");
  assert.equal(compactNoSpace.edges[0]?.to, "t.B");
});

test("skip op (--o/--x/~~~): 시맨틱 edge 미생성 + unmappedLabels 기록 유지", () => {
  const out = extract("flowchart LR\n    A --o B\n    C --x D\n    E ~~~ F");
  assert.equal(out.edges.length, 0);
  const skipped = out.unmappedLabels.filter((l) => l.startsWith("edge-op-skipped:"));
  assert.equal(skipped.length, 3);
});

test("observability: 미인식 line → unmappedLabels 에 line-not-recognized 기록", () => {
  const out = extract("flowchart LR\n    ???");
  assert.ok(
    out.unmappedLabels.some((l) => l === "line-not-recognized: ???"),
    `unmappedLabels=${JSON.stringify(out.unmappedLabels)}`,
  );
});

test("containment guard: child --> 자기 subgraph edge 제외 + cross-boundary edge 보존", () => {
  const out = extract(
    "flowchart LR\n" +
      '    subgraph daemon["Scheduled background jobs (daemons)"]\n' +
      "        autoagent_d[Self-improvement daemon]\n" +
      "    end\n" +
      "    daemon --> orch\n" +
      "    autoagent_d --> daemon",
  );
  // containment edge(autoagent_d --> 자기 컨테이너 daemon) 제외, cross-boundary daemon --> orch 보존.
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0]?.from, "t.daemon");
  assert.equal(out.edges[0]?.to, "t.orch");
  assert.ok(
    !out.edges.some((e) => e.from === "t.autoagent_d" && e.to === "t.daemon"),
    "containment edge 가 남아 bare-id 로 누출됨",
  );
});

test("containment guard: subgraph 사람 라벨 + membership 파싱", () => {
  const out = extract(
    "flowchart LR\n" +
      '    subgraph daemon["Scheduled background jobs (daemons)"]\n' +
      "        autoagent_d[Self-improvement daemon]\n" +
      "    end\n" +
      "    autoagent_d --> daemon",
  );
  const daemonSg = out.subgraphs.find((sg) => sg.id === "daemon");
  assert.ok(daemonSg !== undefined);
  assert.equal(daemonSg.label, "Scheduled background jobs (daemons)");
  assert.ok(daemonSg.members.includes("autoagent_d"));
});

test("container-endpoint label backfill: 실 DIAGRAMS 의 bare container id endpoint → 사람 라벨", () => {
  // cross-subgraph edge(예: `daemon --> orch`)의 subgraph-id endpoint 는 bare-fallback node 로
  // 등록되므로, backfill 후 connection row 가 bare id 대신 subgraph 사람 라벨을 표시해야 한다.
  const entry = DIAGRAMS.find((d) => d.slug === "v2-overview-entry");
  assert.ok(entry !== undefined);
  const out = extract(entry.mermaid_source);
  const byId = new Map(out.nodes.map((n) => [n.id, n]));

  // orch 는 `repo --> orch` 등에서 endpoint 로 참조되는 subgraph 컨테이너 — bare "orch" 가 아니어야 함.
  assert.equal(byId.get("orch")?.label, "Orchestrator (main session)");
  assert.equal(byId.get("daemon")?.label, "Scheduled background jobs (daemons)");
  assert.equal(byId.get("agents")?.label, "Specialist agents");
  assert.equal(byId.get("hooks")?.label, "Safety checks & tracking");

  // 어떤 노드도 subgraph id 로 폴백된 bare 라벨을 갖지 않는다.
  const subgraphIds = new Set(out.subgraphs.map((sg) => sg.id));
  const bareContainerNodes = out.nodes.filter(
    (n) => subgraphIds.has(n.id) && n.label === n.id,
  );
  assert.deepEqual(
    bareContainerNodes.map((n) => n.id),
    [],
    "backfill 후 bare container-id 라벨이 남음",
  );
});

test("containment guard: 컨테이너-as-source containment 도 제외 (from-side)", () => {
  const out = extract(
    "flowchart LR\n" +
      '    subgraph grp["Group"]\n' +
      "        child[Child]\n" +
      "    end\n" +
      "    grp --> child",
  );
  assert.equal(out.edges.length, 0);
});

test("SoT parity: 다이어그램별 parsed edge 수 == source arrow 수", () => {
  for (const diagram of DIAGRAMS) {
    const out = extract(diagram.mermaid_source);
    const arrows = countSourceArrows(diagram.mermaid_source);
    assert.equal(
      out.edges.length,
      arrows,
      `${diagram.slug}: parsed=${out.edges.length} arrows=${arrows}`,
    );
  }
});

test("SoT parity: parse drift 없음 (line-not-recognized / edge-line-* 0건)", () => {
  for (const diagram of DIAGRAMS) {
    const out = extract(diagram.mermaid_source);
    const drift = out.unmappedLabels.filter(
      (l) => l.startsWith("line-not-recognized:") || l.startsWith("edge-line-"),
    );
    assert.deepEqual(drift, [], diagram.slug);
  }
});

test("SoT parity: v2-team-docs 의 hyphen node-id 전부 추출", () => {
  const docsDiagram = DIAGRAMS.find((d) => d.slug === "v2-team-docs");
  assert.ok(docsDiagram !== undefined);
  const out = extract(docsDiagram.mermaid_source);
  const ids = new Set(out.nodes.map((n) => n.id));
  for (const id of ["glass-atrium-intel-researcher", "glass-atrium-design-designer", "glass-atrium-intel-reporter"]) {
    assert.ok(ids.has(id), `missing node: ${id}`);
  }
});

// 분류 parity oracle — 라벨은 LABEL_RULES/NODE_TYPE_RULES/roleForSyntheticSubgraph 키워드와 결합:
// 라벨 문구 수정이 keyword substring 을 건드리면 edge_type/node type/layer role 이 소리 없이 재분류된다
// (deriveEdgeType keyword-miss 는 unmappedLabels 로만 흘러 drift 테스트에 안 걸림 → 히스토그램 고정이 회귀망).
// 라벨/키워드를 의도적으로 바꿀 때는 아래 기대값을 같은 변경에서 갱신할 것.
const CLASSIFICATION_ORACLE: Record<
  string,
  { edges: Record<string, number>; nodes: Record<string, number>; roles: Record<string, number> }
> = {
  "v2-overview-entry": {
    edges: { control_flow: 6, data_flow: 1, writes_to: 1 },
    nodes: { agent: 8, daemon: 3, gateway: 1, hook: 2, store: 1 },
    roles: { execution: 4, orchestration: 2 },
  },
  "v2-overview-data": {
    edges: { control_flow: 17, data_flow: 1 },
    // data 컨테이너 endpoint 라벨이 "…glass_atrium DB" 로 backfill → "DB" 키워드로 store 분류(agent 아님).
    nodes: { agent: 11, gateway: 2, hook: 1, store: 3 },
    roles: { data: 1, execution: 3, feedback: 2, monitoring: 1 },
  },
  "v2-hooks": {
    edges: { control_flow: 13, reads_from: 1 },
    nodes: { agent: 8, gateway: 3, store: 1 },
    roles: { execution: 3 },
  },
  "v2-loops-learn": {
    edges: { control_flow: 13 },
    nodes: { agent: 10, gateway: 1 },
    roles: { execution: 2, feedback: 2, gateway: 1 },
  },
  "v2-loops-autoagent": {
    edges: { control_flow: 16, escalates_to: 2 },
    nodes: { agent: 12, daemon: 3, gateway: 1, store: 1 },
    roles: { execution: 4, orchestration: 1 },
  },
  "v2-team-orchestration": {
    edges: { control_flow: 20, data_flow: 1, escalates_to: 1, reads_from: 1 },
    nodes: { agent: 13, gateway: 2, hook: 1, store: 1 },
    roles: { execution: 1, orchestration: 3 },
  },
  "v2-team-docs": {
    edges: { control_flow: 13, data_flow: 3, reads_from: 3 },
    nodes: { agent: 12, store: 2 },
    roles: { data: 1, execution: 3, orchestration: 1 },
  },
};

function histogram(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of [...values].sort()) {
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

test("SoT parity: 다이어그램별 edge_type/node type/layer role 히스토그램 == oracle", async () => {
  resetArchitectureCache();
  const { doc } = await getArchitecture(silentLogger);
  assert.equal(doc.diagrams.diagrams.length, Object.keys(CLASSIFICATION_ORACLE).length);
  for (const diagram of doc.diagrams.diagrams) {
    const expected = CLASSIFICATION_ORACLE[diagram.id];
    assert.ok(expected !== undefined, `oracle missing diagram: ${diagram.id}`);
    assert.deepEqual(
      histogram(diagram.flows.map((f) => f.edge_type)),
      expected.edges,
      `${diagram.id}: edge_type histogram drift`,
    );
    assert.deepEqual(
      histogram(diagram.layers.flatMap((l) => (l.nodes ?? []).map((n) => n.type))),
      expected.nodes,
      `${diagram.id}: node type histogram drift`,
    );
    assert.deepEqual(
      histogram(diagram.layers.map((l) => l.role)),
      expected.roles,
      `${diagram.id}: layer role histogram drift`,
    );
  }
});
