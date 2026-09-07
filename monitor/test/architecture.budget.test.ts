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
  type DetailGrade,
  getBudgetReport,
  getDiagramHeaderIndex,
  getMermaidCensus,
  isSupportedDiagramForm,
} from "../src/server/architecture/content-budget.js";
import {
  buildSingleDiagram,
  getArchitecture,
  resetArchitectureCache,
} from "../src/server/architecture/parser.js";
import { extractFlows } from "../src/server/architecture/flow-extractor.js";

// T3 grade assignment for the canonical map — every cap below is read from this row.
// ADR-15 재배정: `balanced`(9/6) 아래에서 확정 흐름은 엣지 7/6 으로 fail 이므로 이미 선언된 `faithful` 행으로 옮겼음.
// 등급 이동이 값을 넓히는 것으로 번지지 않게 하는 보증은 AC-3 의 상한 두 행 리터럴 대조임.
const ASSIGNED_GRADE = "faithful";

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

test("AC-2 drawn subgraph nesting depth <= cap", () => {
  assert.ok(getMermaidCensus(drawn).maxSubgraphDepth <= caps.subgraphDepth);
  // adversarial: depth-2 fixture must be reported as a fail, not absorbed
  assert.equal(getBudgetReport(NESTED_FIXTURE, ASSIGNED_GRADE).state, "fail");
});

test("AC-3 drawn node count <= its grade cap, and the faithful/balanced cap rows stay pinned to their four literals", () => {
  // 상한 행을 배정 등급으로 동적으로 읽으므로, 값 자체를 손으로 옮겨 적은 리터럴에 걸어 두지 않으면
  // 상한을 넓히는 변경이 이 비교와 전 스위트를 초록으로 지나감. 배정이 떠나온 `balanced` 행도 함께 잠금.
  assert.deepEqual(BUDGET_CAPS.faithful, { nodes: 14, edges: 18, labelChars: 50, subgraphDepth: 1 });
  assert.deepEqual(BUDGET_CAPS.balanced, { nodes: 9, edges: 6, labelChars: 45, subgraphDepth: 1 });

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

// P0-2 — 설정을 소스에 싣는 두 방법 중 frontmatter 는 ARROW 정규식이 `---` 를 엣지로 센다.
// 아래 픽스처가 그 사실의 반증 가능한 형태(ADR-2). 계기는 상한 위반이 아니라 엣지 증분임 —
// `faithful` 아래에서는 펜스를 실어도 9/18 로 여전히 pass 라, 상한을 계기로 쓰면 영구 초록이 된다.
const FRONTMATTER_FIXTURE = `---
config:
  layout: elk
---
${drawn}`;

/** `class a,b role` 배정에서 role 을 받은 노드 id — classDef 선언이 아니라 실제 배정만 셈. */
function getClassMembers(mermaid: string, className: string): string[] {
  return mermaid.split("\n").flatMap((raw) => {
    const match = raw.trim().match(/^class\s+([A-Za-z0-9_,-]+)\s+(\S+)$/);
    return match !== null && match[2] === className ? (match[1] as string).split(",") : [];
  });
}

test("P1-1 the drawn source carries no %%{init}%% directive — layout and theme come from the shared config", () => {
  const directives = drawn
    .split("\n")
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => line.trimStart().startsWith("%%{init"));
  assert.deepEqual(
    directives.map(([i]) => i),
    [],
    `%%{init}%% directive at line(s) ${directives.map(([i]) => i).join(", ")} — a per-source copy of the shared config`,
  );
  // opt-out 지시자를 앞세운 형태도 계수는 같아야 함 — 한 줄·인용 키 규칙이 깨지면 오프너/화살표 오검출이 되살아난다.
  assert.deepEqual(getMermaidCensus(`%%{init: {"layout": "dagre"}}%%\n${drawn}`), getMermaidCensus(drawn));

  // 설정을 소스 밖으로 옮겨도 콘텐츠 계수는 그대로여야 함 — 상한 대비 여유가 아니라 실측값을 고정한다.
  // 노드가 줄어드는 변경(9 → 8)은 `pass` 를 유지하므로 상한 대비 관계식만 재는 AC-3/4/5 로는 잡히지 않음.
  const census = getMermaidCensus(drawn);
  assert.equal(census.nodeCount, 9, "the drawn map counts 9 nodes");
  assert.equal(census.edgeCount, 7, "the drawn map counts 7 edges");
});

test("P0-2 focal 강조는 희소하고 실재하는 노드에만 붙음 — 배정은 drawn 이 선언한 id 로만 가고 개수는 1~2", () => {
  // 배정은 콘텐츠지 설정이 아님(위 mermaid_drawn 주석) — 계수 스위트가 노드/엣지만 재므로
  // 강조가 없는 id 로 미끄러져도, 여럿으로 번져도 예산 판정은 그대로 pass 다.
  const focal = getClassMembers(drawn, "focal");
  const drawnIds = new Set(getMermaidCensus(drawn).nodes.map((n) => n.id));
  assert.ok(focal.length >= 1, "no node carries the focal class — the accent budget is measured on nothing");
  assert.ok(
    focal.length <= 2,
    `focal nodes ${focal.join(", ")} exceed the accent budget of 2 — an accent on many nodes accents nothing`,
  );
  for (const id of focal) {
    assert.ok(
      drawnIds.has(id),
      `focal class assigned to '${id}', which the drawn source does not declare — the accent renders on nothing`,
    );
  }
  const lines = drawn.split("\n").map((line) => line.trim());
  const declaredAt = lines.findIndex((line) => /^classDef\s+focal\s/.test(line));
  const assignedAt = lines.findIndex((line) => /^class\s+\S+\s+focal$/.test(line));
  assert.notEqual(declaredAt, -1, "the focal class is assigned but never declared — the assignment styles nothing");
  assert.ok(declaredAt < assignedAt, "the focal class must be declared before it is assigned");
});

test("P0-2 no YAML frontmatter fence survives in the drawn source", () => {
  const fences = drawn
    .split("\n")
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => line.startsWith("---"));
  assert.deepEqual(
    fences.map(([i]) => i),
    [],
    `frontmatter fence at line(s) ${fences.map(([i]) => i).join(", ")} — ARROW counts each as an edge`,
  );
  // AC-B2-1h adversarial: 같은 콘텐츠를 frontmatter 로 실으면 펜스 두 줄이 엣지로 세어짐 — 위 규칙이 지키는 대상.
  // 계기는 상한 위반이 아니라 증분임: 상한을 쓰면 `faithful` 아래에서 9/18 로 pass 가 되어 영구 초록이 된다.
  // 증분은 콘텐츠 비의존임 — 펜스 헤더는 drawn 이 무엇을 그리든 `---` 토큰 둘을 더하고 노드는 하나도 안 더함.
  // 계수기를 직접 통과해 잼 — 예산 판정을 경유하면 B2-0 의 형태 술어가 픽스처를 먼저 분류한다.
  const plain = getMermaidCensus(drawn);
  const fenced = getMermaidCensus(FRONTMATTER_FIXTURE);
  assert.equal(fenced.edgeCount - plain.edgeCount, 2, "the two fence lines must each count as an edge");
  assert.equal(fenced.nodeCount - plain.nodeCount, 0, "the fence header declares no node");
});

// 계수기는 라벨을 재기 전에 shape 구분자를 벗겨야 함 — 원통 `[( … )]` 처럼 바깥 괄호를 떼고도
// 구분자가 남는 형태에서, 벗기지 않으면 그 구분자 넉 자가 라벨 글자로 세어지고 따옴표마저
// 첫 글자가 아니게 되어 함께 세어짐. 최댓값(`hook_pipeline` 40)이 그 위에 있어 오늘은
// label_chars 가 가려 주지만, 상한 근처의 원통 라벨은 그 넷 때문에 없는 초과로 붉어짐.
test("B2-1 라벨 계수는 shape 구분자를 글자로 세지 않음 — 원통 노드가 제 글자 수로 읽힘", () => {
  const byId = new Map(getMermaidCensus(drawn).nodes.map((n) => [n.id, n.label]));

  assert.equal(byId.get("pg_db"), "PostgreSQL database");
  assert.equal(byId.get("pg_db")?.length, 19, "the cylinder label counts its own 19 chars, not its delimiters");

  // 픽스처로 형태별 확인 — drawn 이 오늘 원통 하나만 그리므로 그 하나가 사라지면 위 절이 빈 사실이 됨.
  const shapes = `flowchart LR
    cyl[("Cylinder label")]
    circ(("Circle label"))
    hex{{"Hex label"}}
    para[/"Para label"/]
    paren["(a) and (b)"]`;
  assert.deepEqual(
    getMermaidCensus(shapes).nodes.map((n) => n.label),
    ["Cylinder label", "Circle label", "Hex label", "Para label", "(a) and (b)"],
    "each shape must yield its own label, and a parenthesised label must survive intact",
  );
});

test("AC-8 omitted_node_ids ledger is honest while drawn is smaller than source, and only canonical carries its own title/description in place of the source's", async () => {
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

  // 원장이 세는 누락 때문에 canonical 은 제목·서술도 source 와 갈라짐 (ADR-9 · ADR-16) — 같은 갈림의 세 자리라
  // 원장만 재고 두 문자열을 놓으면 갈림의 3분의 1만 잠김. 갈림은 payload 필드로만 관측되므로 파서를 거쳐 잼 —
  // e2e 형제들은 payload 를 자기 자신의 서술과 비교하므로 source 문자열이 실려 나가도 초록이고,
  // `?? src.title` 낙하(선언 삭제)도 그 비교를 그대로 지나감.
  resetArchitectureCache();
  const { doc } = await getArchitecture({ warn() {}, info() {} });
  const built = doc.diagrams.diagrams.find((d) => d.id === CANONICAL_MAP.slug);
  assert.ok(built !== undefined, "canonical diagram missing from the payload");
  assert.equal(built.title, CANONICAL_MAP.title, "the payload does not carry canonical's own title");
  assert.equal(built.description, CANONICAL_MAP.description, "the payload does not carry canonical's own description");
  // 비어 있지 않은 비교라는 근거 — 두 문자열이 source 와 같으면 위 두 줄은 자기 자신과의 대조가 됨.
  assert.notEqual(built.title, canonicalSource.title, "CANONICAL_MAP.title equals the source title — the equality above is vacuous");
  assert.notEqual(built.description, canonicalSource.description, "CANONICAL_MAP.description equals the source description — the equality above is vacuous");

  // 3항 연산이 전편에 새지 않음 — 비-canonical 은 자기 source 제목·서술을 그대로 유지함.
  const other = doc.diagrams.diagrams.find((d) => d.id === "v2-overview-data");
  const otherSource = DIAGRAMS.find((d) => d.slug === "v2-overview-data");
  assert.ok(other !== undefined && otherSource !== undefined);
  assert.equal(other.title, otherSource.title);
  assert.equal(other.description, otherSource.description);
});

test("B2-1 drawn id 집합 ⊆ source id 집합 — 그 차집합이 정확히 omitted_node_ids 원장", () => {
  // 편집 규칙(source 를 먼저 고치고 drawn 을 그로부터 감축)의 기계적 대응물.
  // 위 AC-8 은 원장이 이미 이름한 id 만 훑고 AC-9(route) 는 원장을 자기 자신과 대조하므로,
  // source 를 건너뛴 drawn 전용 노드도 · 원장에서 빠진 누락도 둘 다 그 둘을 그대로 지나감.
  assert.ok(canonicalSource !== undefined);
  const sourceIds = new Set(getMermaidCensus(canonicalSource.mermaid_source).nodes.map((n) => n.id));
  const drawnIds = getMermaidCensus(drawn).nodes.map((n) => n.id);
  assert.deepEqual(
    drawnIds.filter((id) => !sourceIds.has(id)),
    [],
    "a node is drawn that no source declares — drawn was edited without its source",
  );
  const drawnSet = new Set(drawnIds);
  assert.deepEqual(
    [...sourceIds].filter((id) => !drawnSet.has(id)),
    [...CANONICAL_MAP.omitted_node_ids],
    "the ledger is not source-minus-drawn — an omission goes unrecorded, or a recorded id is not the omitted one",
  );
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

test("AC-10 계수는 레이아웃 방향에 비의존 — 같은 canonical 콘텐츠가 LR/TD 에서 같은 census·report 를 냄", () => {
  const lr = withDirection(drawn, "LR");
  const td = withDirection(drawn, "TD");
  // 두 문자열이 실제로 달라야 비교가 성립함 — 같으면 자기 자신과 비교하는 공허한 통과가 됨.
  assert.notEqual(lr, td, "direction rewrite must produce two distinct strings");
  // 재작성이 헤더 한 줄만 건드렸다는 확인 — 본문이 달라지면 아래 동일성은 방향 비의존의 증거가 못 됨.
  assert.deepEqual(withoutHeader(td), withoutHeader(lr), "rewrite must touch only the header line");

  const censusLr = getMermaidCensus(lr);
  assert.ok(censusLr.nodeCount > 0 && censusLr.edgeCount > 0, "fixture must carry countable content");
  // 노드/엣지/라벨/깊이 전부 — 계수기가 방향 토큰을 읽기 시작하면 여기서 붉어짐.
  assert.deepEqual(getMermaidCensus(td), censusLr);
  assert.deepEqual(getBudgetReport(td, ASSIGNED_GRADE), getBudgetReport(lr, ASSIGNED_GRADE));
  // 체크인된 방향의 실물도 같은 수치 — 방향을 바꿔도 예산 리포트 숫자는 고정임.
  assert.deepEqual(getMermaidCensus(drawn), censusLr);
  assert.deepEqual(getBudgetReport(drawn, ASSIGNED_GRADE), getBudgetReport(lr, ASSIGNED_GRADE));
});

// ----- B2-0 형태 게이트 -------------------------------------------------------
// 두 결함을 함께 닫음: ① 계수기가 못 읽는 형태에서 리포트가 `pass` 를 냄(측정을 멈추고 초록을 반환).
// ② 파서의 빈-추출 가드를 헤더 줄에서 나온 유령 노드가 통과시켜 열화된 그림이 그대로 나감.
// 이 계획이 노드 예산을 지침으로 강등하기 때문에 더 중요함 — 강등된 예산은 무력화된 예산과 구별되어야 함.

const SEQUENCE_FIXTURE = `sequenceDiagram
    participant U as User
    participant S as Server
    U->>S: request
    S-->>U: response`;

/** 형태 지표만 뽑음 — 없으면 undefined 로 어서션이 붉어짐. */
function getFormat(mermaid: string, grade: DetailGrade = ASSIGNED_GRADE) {
  return getBudgetReport(mermaid, grade).measures.find((m) => m.metric === "diagram_format");
}

test("AC-B2-0a 계수기가 못 읽는 형태는 fail — 측정을 멈춘 채 초록으로 지나가지 않음", () => {
  const report = getBudgetReport(SEQUENCE_FIXTURE, ASSIGNED_GRADE);
  assert.equal(report.state, "fail");
  assert.equal(getFormat(SEQUENCE_FIXTURE)?.state, "fail");
  assert.ok(
    report.violations.some((m) => m.metric === "diagram_format"),
    "the violation must be nameable, not just a state",
  );

  // 이 게이트가 공허하지 않다는 근거를 값으로 남김 — 나머지 네 지표는 전부 pass 다.
  // 즉 형태 지표가 없으면 이 리포트는 `pass` 였다(변경 전 실측 그대로).
  assert.deepEqual(
    report.measures.filter((m) => m.metric !== "diagram_format").map((m) => m.state),
    ["pass", "pass", "pass", "pass"],
  );
});

test("AC-B2-0b 파서는 미지원 형태를 경고와 함께 건너뜀 — 유령 노드로 가드를 통과하지 못함", () => {
  // 결함의 실체: 헤더 줄이 노드 하나로 잡혀 빈-추출 가드(nodes 0 && edges 0)가 거짓이 됨.
  // 형태를 먼저 거르지 않으면 이 소스는 SystemDiagram 으로 그려져 나감.
  const probe = extractFlows(SEQUENCE_FIXTURE, {
    idPrefix: "probe",
    edgeIdPrefix: "probe",
    logger: { warn: () => {}, info: () => {} },
  });
  assert.equal(
    probe.nodes.length === 0 && probe.edges.length === 0,
    false,
    "the empty-extraction guard does not fire here — that is why the form check must precede it",
  );

  const warnings: string[] = [];
  const logger = {
    warn: (_obj: object, msg?: string) => {
      warnings.push(msg ?? "");
    },
    info: () => {},
  };
  const built = buildSingleDiagram("seq", "Sequence", "desc", SEQUENCE_FIXTURE, logger);
  assert.equal(built, null, "an unsupported form must not produce a SystemDiagram");
  assert.ok(
    warnings.some((w) => /unsupported diagram form/i.test(w)),
    `the skip must be loud; warnings were: ${warnings.join(" | ")}`,
  );
});

test("AC-B2-0c 게이트는 모든 것을 거부해서 만족되지 않음 — 출하되는 여덟 문자열 전부 통과", () => {
  assert.equal(DIAGRAMS.length, 7, "the shipped corpus is seven sources");
  for (const d of DIAGRAMS) {
    assert.ok(isSupportedDiagramForm(d.mermaid_source), `shipped source '${d.slug}' is rejected by the form gate`);
    assert.equal(getFormat(d.mermaid_source)?.state, "pass", `shipped source '${d.slug}' reports a format violation`);
  }
  // 여덟 번째 — 실제로 그려지는 문자열. 헤더 방향이 source 와 다름(TD vs LR)이라 따로 셈.
  assert.ok(isSupportedDiagramForm(drawn), "the canonical drawn string is rejected by the form gate");
  assert.equal(getBudgetReport(drawn, ASSIGNED_GRADE).state, "pass", "the canonical report must stay pass");
});

test("AC-B2-0d 형태 지표는 비율 밴드 밖 — 자기 생성자를 가짐", () => {
  const getNodeLines = (n: number) => Array.from({ length: n }, (_, i) => `    n${i}["x"]`).join("\n");

  // 대조군: 밴드를 타는 지표는 measured/cap = 1.0 에서 warn 이다.
  const atCap = getBudgetReport(`flowchart LR\n${getNodeLines(caps.nodes)}`, ASSIGNED_GRADE);
  assert.equal(atCap.measures.find((m) => m.metric === "nodes")?.state, "warn");

  // 실험군 ①: 형태 지표도 지원 형태에서 비율이 정확히 1.0 인데 pass 다 → 밴드를 타지 않음.
  // getMeasure 로 접으면 정상 다이어그램이 전부 영구 warn 이 되어 여기가 붉어짐.
  const ok = atCap.measures.find((m) => m.metric === "diagram_format");
  assert.ok(ok !== undefined, "the report must carry a diagram_format measure");
  assert.equal(ok.measured / ok.cap, 1);
  assert.equal(ok.state, "pass");

  // 실험군 ②: 미지원 형태의 비율은 0.0 — 밴드가 판정했다면 `pass` 로 떨어졌을 값인데 fail 이다.
  // 이 두 줄이 이 지표가 존재하는 이유이자, 접었을 때 붉어지는 다른 한쪽.
  const bad = getFormat(SEQUENCE_FIXTURE);
  assert.ok(bad !== undefined, "the report must carry a diagram_format measure");
  assert.ok(bad.measured / bad.cap < 0.9, "the unsupported ratio sits inside the band's pass region");
  assert.equal(bad.state, "fail");

  // 밴드 밖이라는 사실이 출력 표면에도 실려야 함 — note 가 두 예외를 다 이름.
  assert.match(getBudgetReport(drawn, ASSIGNED_GRADE).note, /subgraph_depth/);
  assert.match(getBudgetReport(drawn, ASSIGNED_GRADE).note, /diagram_format/);
});

test("AC-B2-0 형태 게이트는 census 를 막지 않음 — 계수기는 그대로 열려 있음", () => {
  // 명시적 제외: census 를 게이트하면 헤더 앞에 무엇이 오는 픽스처든 계수 불가가 되어
  // frontmatter 펜스를 재는 P0-2 계열 AC 가 만족 불가능해짐.
  const census = getMermaidCensus(SEQUENCE_FIXTURE);
  assert.equal(census.nodeCount, 0);
  assert.equal(census.edgeCount, 1, "the ARROW rule still counts the `-->>` token — the counter is unchanged");

  // 펜스가 앞서도 형태 판정은 본문 헤더를 찾아 통과시키고, 계수도 정상 동작함.
  assert.equal(isSupportedDiagramForm(FRONTMATTER_FIXTURE), true);
  assert.ok(getMermaidCensus(FRONTMATTER_FIXTURE).nodeCount > 0);
  assert.ok(getDiagramHeaderIndex(FRONTMATTER_FIXTURE) > 0, "the header is not the first line here");
});
