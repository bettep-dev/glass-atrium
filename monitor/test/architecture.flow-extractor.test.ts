// flow-extractor unit tests — split-label edge 문법(`A -- "l" --> B` 계열) + hyphen node-id + parse-drift observability.
// Runner: npx tsx --test test/architecture.flow-extractor.test.ts
// No DB dependency — pure parser unit test + SoT(DIAGRAMS) parity 검증.

import test from "node:test";
import assert from "node:assert/strict";

import {
  extractFlows,
  inferFlowNodeType,
  type ExtractedFlow,
} from "../src/server/architecture/flow-extractor.js";
import { CANONICAL_MAP, DIAGRAMS } from "../src/server/architecture/diagrams-source.js";
import { getDiagramHeaderIndex } from "../src/server/architecture/content-budget.js";
import {
  getArchitecture,
  resetArchitectureCache,
  roleForSyntheticSubgraph,
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
  // canonical 맵은 payload 가 drawn 을 실어 나름 — 이 오라클 한 줄만 drawn 계측이고 나머지 여섯은 source 계측임.
  // drawn 이 명령의 흐름이 된 뒤의 값(ADR-6): `repo` 가 빠져 store 가 하나 줄고, 데이터 존 + `pg_db` 가 들어와
  // store 가 둘 늘며(존 id 가 엣지 endpoint 로 참조돼 노드로도 등록됨), `saves results` 가 data_flow 로 분류됨.
  // B2-1 이 내보내기 마디를 더한 뒤(ADR-14): `doc_export` 가 external 하나를 세우고(ADR-17 의 분류 규칙),
  // export 존 id 가 엣지 endpoint 로 참조돼 agent 노드가 하나 늘며 execution 레이어도 하나 늘어남.
  // `renders stored content` 의 `content` 가 기존 data_flow 키워드라 두 번째 data_flow 가 됨.
  "v2-overview-entry": {
    edges: { control_flow: 5, data_flow: 2 },
    nodes: { agent: 7, daemon: 3, hook: 2, store: 2, external: 1 },
    roles: { data: 1, execution: 5, orchestration: 2 },
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

// canonical 슬러그의 source 계측 — 위 payload 오라클 행은 drawn 을 재므로, verify-arch Stage-4 가 쓰는
// mermaid_source 쪽 라벨/키워드 재분류 감시망이 비어 있음. 이 행이 그 구간을 메움.
// 세 축 모두 실음 — edge 만 재면 canonical 의 mermaid_source node type/layer role 재분류가 무계측으로 남음.
const CANONICAL_SOURCE_ORACLE: {
  edges: Record<string, number>;
  nodes: Record<string, number>;
  roles: Record<string, number>;
} = {
  // ADR-7 흡수 후: `to_data` 경계 노드가 데이터 존 + `pg_db` 로 교체되어 agent 가 하나 줄고 store 가 둘 늘며
  // 존 라벨의 `DB` 키워드가 store 를, 존 제목의 `Data` 가 data 역할을 각각 부름. 엣지는 목적지만 바뀌어 불변.
  // B2-1 의 내보내기 마디(ADR-14) 뒤: `doc_export` 가 external 을 세우고 export 존 id 가 endpoint 로
  // 참조돼 agent 가 하나 늘며 execution 역할도 하나 늚. `renders stored content` 가 둘째 data_flow 임.
  edges: { control_flow: 6, data_flow: 2, writes_to: 1 },
  nodes: { agent: 8, daemon: 3, external: 1, gateway: 1, hook: 2, store: 3 },
  roles: { data: 1, execution: 4, orchestration: 2 },
};

test("canonical mermaid_source 의 edge_type/node type/layer role 히스토그램 == source oracle", () => {
  const src = DIAGRAMS.find((d) => d.slug === "v2-overview-entry");
  assert.ok(src !== undefined);
  const out = extract(src.mermaid_source);
  assert.deepEqual(histogram(out.edges.map((e) => e.edge_type)), CANONICAL_SOURCE_ORACLE.edges);
  assert.deepEqual(histogram(out.nodes.map((n) => inferFlowNodeType(n))), CANONICAL_SOURCE_ORACLE.nodes);
  assert.deepEqual(
    histogram(out.subgraphs.map((s) => roleForSyntheticSubgraph(s.label))),
    CANONICAL_SOURCE_ORACLE.roles,
  );
});

test("AC-B2-1f `doc_export` 는 external 로 분류되고 그 규칙이 다른 노드를 재분류하지 않음", () => {
  // 노드 type 은 노드 상세 드로어에 사람이 읽는 Pill 로 렌더됨 — 분류가 틀리면 화면에 보이는 거짓말이 됨.
  // 규칙이 없으면 `doc_export` 는 어느 키워드에도 안 걸려 shape 폴백으로 `agent` 가 됨 (ADR-17).
  const drawnNodes = extract(CANONICAL_MAP.mermaid_drawn).nodes;
  const exported = drawnNodes.find((n) => n.id.endsWith("doc_export"));
  assert.ok(exported !== undefined, "the drawn flow declares no `doc_export` node");
  assert.equal(inferFlowNodeType(exported), "external");

  // 무영향성을 값으로 남김 — 규칙은 키워드 적중에서만 발화하므로, 적중 집합이 `doc_export` 뿐이면
  // 나머지 전원에 대해 규칙은 구조적으로 no-op 임. 출하 소스에 `browser` 류 라벨이 새로 들어오면 붉어짐.
  const KEYWORDS = ["chromium", "headless", "browser"];
  const hits: string[] = [];
  let total = 0;
  for (const [name, mermaid] of [
    ...DIAGRAMS.map((d) => [d.slug, d.mermaid_source] as const),
    ["drawn", CANONICAL_MAP.mermaid_drawn] as const,
  ]) {
    for (const node of extract(mermaid).nodes) {
      total += 1;
      const haystack = `${node.id} ${node.label}`.toLowerCase();
      if (KEYWORDS.some((k) => haystack.includes(k))) hits.push(`${name}:${node.id}`);
    }
  }
  assert.ok(total > 100, `the sweep must actually cover the corpus; it saw ${total} nodes`);
  assert.deepEqual(hits, ["v2-overview-entry:doc_export", "drawn:doc_export"]);
});

test("AC-B2-1c 교체된 `to_data` 경계 노드는 일곱 source 어디에도 남아 있지 않음", () => {
  // 존재하는 채로 원장에서만 빠지면 AC-8 의 부재 검사가 아니라 실재 검사가 붉어짐 — 죽음을 여기서 못박음.
  const survivors = DIAGRAMS.filter((d) => /(^|[\s;])to_data([[({\s]|$)/m.test(d.mermaid_source));
  assert.deepEqual(survivors.map((d) => d.slug), []);
});

// 방향 토큰 재작성기 — 헤더 줄의 방향만 바꾸고 본문은 손대지 않음.
// 헤더 탐색은 production 의 getDiagramHeaderIndex 하나를 씀 — 같은 정규식이 테스트에만 살아 있던 상태를 끝냄.
function getHeaderIndex(mermaid: string): number {
  const at = getDiagramHeaderIndex(mermaid);
  assert.notEqual(at, -1, "canonical must carry a flowchart header");
  return at;
}

function withDirection(mermaid: string, direction: string): string {
  const lines = mermaid.split("\n");
  const at = getHeaderIndex(mermaid);
  lines[at] = (lines[at] as string).replace(/^(\s*(?:flowchart|graph))\s+\S+/i, `$1 ${direction}`);
  return lines.join("\n");
}

/** 헤더를 뺀 나머지 줄 — "헤더 한 줄만 건드렸다" 를 헤더 위치와 무관하게 재는 비교 대상. */
function withoutHeader(mermaid: string): string[] {
  const lines = mermaid.split("\n");
  lines.splice(getHeaderIndex(mermaid), 1);
  return lines;
}

test("방향 비의존: canonical drawn 은 LR/TD 에서 동일한 nodes/edges/subgraphs/unmapped 를 냄", () => {
  const drawn = CANONICAL_MAP.mermaid_drawn;
  const lr = withDirection(drawn, "LR");
  const td = withDirection(drawn, "TD");
  assert.notEqual(lr, td, "direction rewrite must produce two distinct strings");
  assert.deepEqual(withoutHeader(td), withoutHeader(lr), "rewrite must touch only the header line");

  const fromLr = extract(lr);
  const fromTd = extract(td);
  // 공허한 통과 방지 — 빈 추출끼리 같다는 결론은 방향 비의존의 증거가 아님.
  assert.ok(fromLr.nodes.length > 0 && fromLr.edges.length > 0, "canonical must extract nodes and edges");
  assert.deepEqual(fromTd.nodes, fromLr.nodes);
  assert.deepEqual(fromTd.edges, fromLr.edges);
  assert.deepEqual(fromTd.subgraphs, fromLr.subgraphs);
  assert.deepEqual(fromTd.unmappedLabels, fromLr.unmappedLabels);
  // 체크인된 방향의 실물도 같은 추출 — 헤더 방향이 무엇이든 그래프 구조가 고정임.
  assert.deepEqual(extract(drawn).edges, fromLr.edges);
});
