// clauded-docs 다이어그램 타입 선언(diagram-types.json)의 계약 시험.
// 실행: npx tsx --test test/clauded-docs.diagram-types.test.ts
//
// 오라클은 선언 파일 자신의 불변식 · 타입 집합 멤버십 · 검증기 거동임.
// 거동 판정(erDiagram · pie · RL)은 행 제거만 잡음 → 행 추가는 멤버십 목록이 유일한 관문임.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  type DiagramTypes,
  D8_THRESHOLDS,
  loadDiagramTypes,
  validateHtmlStructure,
} from "../src/server/clauded-docs/html-validator.js";

// mermaid 기본 진입점(mermaid.core.mjs)은 내장 다이어그램을 등록하지 않아
// detectType 이 전부 THROW 함(실측). 전체 번들을 직접 들여와 초기화함.
import mermaid from "mermaid/dist/mermaid.esm.mjs";

/** 선언 파일 한 항목 — 타입명, 실제 mermaid 펜스 키워드, 용도 한 줄. */
interface DiagramTypeEntry {
  type: string;
  keywords: string[];
  purpose?: string;
}

/** diagram-types.json 전체 모양. */
interface DiagramTypesDeclaration {
  adopted: DiagramTypeEntry[];
  excluded: DiagramTypeEntry[];
  exclusionReason: string;
  flowDirection: {
    recommended: string;
    allowed: string[];
    forbidden: string[];
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR_ROOT = resolve(HERE, "..");
const DECLARATION_PATH = resolve(MONITOR_ROOT, "src/server/clauded-docs/diagram-types.json");

const declaration = JSON.parse(readFileSync(DECLARATION_PATH, "utf8")) as DiagramTypesDeclaration;

mermaid.initialize({ startOnLoad: false });

function typeNames(entries: DiagramTypeEntry[]): string[] {
  return entries.map((e) => e.type);
}

function allKeywords(entries: DiagramTypeEntry[]): string[] {
  return entries.flatMap((e) => e.keywords);
}

/** 저장 본문의 다이어그램 노드 모양 — 렌더 계약(`pre.mermaid, .mermaid`)과 같음. */
function wrapMermaid(src: string): string {
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>diagram fixture</title>",
    "</head>",
    "<body><main><h1>d</h1>",
    `<pre class="mermaid">${src}</pre>`,
    "</main></body>",
    "</html>",
  ].join("\n");
}

/** 통과 판정의 타입 소견을 타입명 배열로 눌러 비교함. 실패 판정이면 그 자체가 오류임. */
function assertNoticeTypes(result: ReturnType<typeof validateHtmlStructure>, expected: string[]): void {
  assert.strictEqual(result.ok, true, `보고 전용이어야 함 — 판정: ${JSON.stringify(result)}`);
  if (result.ok) {
    const types = result.notices.filter((n) => n.code === "diagram_type_excluded").map((n) => n.type);
    assert.deepStrictEqual(types, expected);
  }
}

/** 같은 소견 배열에서 방향 소견만 방향 문자열로 눌러 비교함. */
function assertNoticeDirections(result: ReturnType<typeof validateHtmlStructure>, expected: string[]): void {
  assert.strictEqual(result.ok, true, `보고 전용이어야 함 — 판정: ${JSON.stringify(result)}`);
  if (result.ok) {
    const directions = result.notices.filter((n) => n.code === "diagram_flow_direction").map((n) => n.direction);
    assert.deepStrictEqual(directions, expected);
  }
}

/** 임시 선언 JSON 을 써서 경로를 넘기고, 끝나면 지움. */
function withTempJson(body: unknown, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "diagram-types-"));
  try {
    const path = join(dir, "diagram-types.json");
    writeFileSync(path, JSON.stringify(body));
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 임시 선언을 모듈과 같은 로더로 읽어 주입 인자로 넘김. */
function withFixture(body: DiagramTypes, run: (loaded: DiagramTypes) => void): void {
  withTempJson(body, (path) => run(loadDiagramTypes(path)));
}

/** 주입용 최소 선언 — 각 시험은 자기가 재는 축만 덮어써서 그 축이 한눈에 드러남. */
function buildFixtureTypes(overrides: Partial<DiagramTypes> = {}): DiagramTypes {
  return {
    adopted: [{ type: "flowchart", keywords: ["flowchart"], purpose: "x" }],
    excluded: [],
    exclusionReason: "fixture",
    flowDirection: { recommended: "LR", allowed: ["LR", "TB"], forbidden: ["RL", "BT"] },
    ...overrides,
  };
}

test("선언 파일 불변식 — 로더가 검사하지 않는 형태·서로소·유일성·방향 정책", () => {
  const entries = [...declaration.adopted, ...declaration.excluded];
  // 비공허성 — 빈 선언이면 아래 순회가 전부 조용히 통과함.
  assert.ok(declaration.adopted.length > 0, "채택 목록이 비어 있음");
  assert.ok(declaration.excluded.length > 0, "제외 목록이 비어 있음");

  for (const entry of entries) {
    assert.ok(typeof entry.type === "string" && entry.type.length > 0, `타입명 누락: ${JSON.stringify(entry)}`);
    assert.ok(Array.isArray(entry.keywords) && entry.keywords.length > 0, `키워드 누락: ${entry.type}`);
    for (const kw of entry.keywords) {
      assert.ok(typeof kw === "string" && kw.length > 0, `빈 키워드: ${entry.type}`);
    }
  }

  for (const entry of declaration.adopted) {
    assert.ok(typeof entry.purpose === "string" && entry.purpose.length > 0, `용도 누락: ${entry.type}`);
    assert.ok(!entry.purpose.includes("\n"), `용도는 한 줄이어야 함: ${entry.type}`);
  }
  assert.ok(typeof declaration.exclusionReason === "string" && declaration.exclusionReason.length > 0);
  for (const entry of declaration.excluded) {
    assert.ok(!("reason" in entry), `제외 사유가 항목마다 복제됨: ${entry.type}`);
  }

  const excludedTypes = new Set(typeNames(declaration.excluded));
  assert.deepStrictEqual(typeNames(declaration.adopted).filter((t) => excludedTypes.has(t)), [], "타입명이 채택·제외에 겹침");
  const excludedKeywords = new Set(allKeywords(declaration.excluded));
  assert.deepStrictEqual(allKeywords(declaration.adopted).filter((k) => excludedKeywords.has(k)), [], "키워드가 채택·제외에 겹침");

  const seen = new Map<string, string>();
  for (const entry of entries) {
    for (const kw of entry.keywords) {
      const prior = seen.get(kw);
      assert.strictEqual(prior, undefined, `키워드 ${kw} 가 ${prior} 와 ${entry.type} 에 중복됨`);
      seen.set(kw, entry.type);
    }
  }

  const { recommended, allowed, forbidden } = declaration.flowDirection;
  assert.ok(allowed.includes(recommended), "권장 방향이 허용 목록 안에 없음");
  // 렌더 pane 은 폭만 제약되고 높이는 자유로움 — 가로 누적은 우측이 잘린다(Pre-drawing Doctrine 기본값).
  assert.equal(recommended, "TD", "권장 방향은 TD — LR 은 폭 초과를 재측정한 뒤에만 고른다");
  const forbiddenSet = new Set(forbidden);
  assert.deepStrictEqual(allowed.filter((d) => forbiddenSet.has(d)), [], "허용과 금지가 겹침");
  // AC-T24 의 판정 대상 — 좌→우 · 위→아래는 허용, 우→좌 · 아래→위는 금지.
  for (const d of ["LR", "TB"]) assert.ok(allowed.includes(d), `허용 방향 누락: ${d}`);
  for (const d of ["RL", "BT"]) assert.ok(forbiddenSet.has(d), `금지 방향 누락: ${d}`);
});

/** 선언에 있어야 하는 타입명 전부 — 형태·서로소 검사는 잘 만들어진 새 행을 통과시킴. */
const DECLARED_ADOPTED_TYPES = [
  "flowchart",
  "sequenceDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "classDiagram",
  "gitGraph",
  "C4",
];
const DECLARED_EXCLUDED_TYPES = [
  "quadrantChart",
  "radar",
  "pie",
  "timeline",
  "journey",
  "mindmap",
  "sankey",
  "xychart",
  "gantt",
  "block",
];

test("선언된 타입 집합이 정확히 이 목록임 — 행 추가 · 삭제 · 개명이 모두 걸림", () => {
  assert.deepStrictEqual(
    typeNames(declaration.adopted).sort(),
    [...DECLARED_ADOPTED_TYPES].sort(),
    "채택 타입 집합이 바뀜 — 채택은 렌더·검증 계약이므로 선언과 이 목록을 같이 고쳐야 함",
  );
  assert.deepStrictEqual(
    typeNames(declaration.excluded).sort(),
    [...DECLARED_EXCLUDED_TYPES].sort(),
    "제외 타입 집합이 바뀜 — 제외 행 추가는 다른 어떤 시험도 잡지 못하므로 이 목록이 유일한 관문임",
  );
});

test("모든 키워드가 실제 mermaid 11 다이어그램 키워드임", () => {
  for (const entry of [...declaration.adopted, ...declaration.excluded]) {
    for (const kw of entry.keywords) {
      assert.doesNotThrow(
        () => mermaid.detectType(`${kw}\n  A --> B`),
        `mermaid 가 인식하지 못하는 키워드: ${kw} (${entry.type})`,
      );
    }
  }
});

test("가짜 키워드는 mermaid 가 거부함 — 위 검사가 공허하지 않음", () => {
  assert.throws(() => mermaid.detectType("notARealDiagramType\n  A --> B"));
});

test("검증기가 이 선언 파일을 실제로 읽음 — 제외 목록에 넣으면 소견이 생김", () => {
  // AC-T20 의 "한 곳만 읽음" 을 심볼 이름이 아니라 거동으로 잼. erDiagram 은
  // 배포본에서 채택이므로 소견이 없어야 하고, 같은 타입을 제외로 옮긴 선언을
  // 주입하면 같은 본문이 소견을 냄 — 판정이 파일에서 흘러나온다는 증거임.
  const html = wrapMermaid("erDiagram\n  A ||--o{ B : has");
  assertNoticeTypes(validateHtmlStructure({ raw: html, sanitized: html }), []);

  withFixture(
    buildFixtureTypes({ excluded: [{ type: "erDiagram", keywords: ["erDiagram"] }] }),
    (injected) => {
      assertNoticeTypes(
        validateHtmlStructure({ raw: html, sanitized: html }, D8_THRESHOLDS, injected),
        ["erDiagram"],
      );
    },
  );
});

test("검증기가 이 선언 파일을 실제로 읽음 — 제외 목록에서 빼면 소견이 사라짐", () => {
  // 반대 방향. pie 는 배포본에서 제외이므로 소견이 1건이고, 제외를 비운 선언을
  // 주입하면 같은 본문이 소견 0건이 됨.
  const html = wrapMermaid('pie title Share\n  "a" : 40');
  assertNoticeTypes(validateHtmlStructure({ raw: html, sanitized: html }), ["pie"]);

  withFixture(
    buildFixtureTypes({ excluded: [] }),
    (injected) => {
      assertNoticeTypes(
        validateHtmlStructure({ raw: html, sanitized: html }, D8_THRESHOLDS, injected),
        [],
      );
    },
  );
});

test("loadDiagramTypes 가 망가진 선언을 조용히 삼키지 않음", () => {
  withTempJson({ adopted: [] }, (path) => {
    assert.throws(() => loadDiagramTypes(path), /excluded/);
  });
});

test("검증기가 금지 방향 목록을 실제로 읽음 — 목록을 옮기면 판정이 뒤집힘", () => {
  // AC-T24 를 심볼 이름이 아니라 거동으로 잼. 배포본에서 RL 은 금지이므로 소견이
  // 1건이고, 금지를 비운 선언을 주입하면 같은 본문이 소견 0건이 됨. 반대로 LR 을
  // 금지로 옮기면 조용하던 본문이 소견을 냄 — 판정이 파일에서 흘러나온다는 증거임.
  const rl = wrapMermaid("flowchart RL\n  A --> B");
  const lr = wrapMermaid("flowchart LR\n  A --> B");
  assertNoticeDirections(validateHtmlStructure({ raw: rl, sanitized: rl }), ["RL"]);
  assertNoticeDirections(validateHtmlStructure({ raw: lr, sanitized: lr }), []);

  withFixture(
    buildFixtureTypes({ flowDirection: { recommended: "LR", allowed: ["LR", "TB", "RL"], forbidden: [] } }),
    (injected) => {
      assertNoticeDirections(validateHtmlStructure({ raw: rl, sanitized: rl }, D8_THRESHOLDS, injected), []);
    },
  );

  withFixture(
    buildFixtureTypes({ flowDirection: { recommended: "TB", allowed: ["TB"], forbidden: ["LR", "RL", "BT"] } }),
    (injected) => {
      assertNoticeDirections(validateHtmlStructure({ raw: lr, sanitized: lr }, D8_THRESHOLDS, injected), ["LR"]);
    },
  );
});
