// clauded-docs 다이어그램 타입 선언(diagram-types.json)의 계약 시험.
// 실행: npx tsx --test test/clauded-docs.diagram-types.test.ts
//
// 이 파일이 계획서 D5 의 채택/제외 목록을 오라클로 들고 있음 — 선언 파일과
// 계획서가 어긋나면 RED. AC-T20 이 금지하는 "두 곳에 적힌 목록"은 런타임
// 소비처를 말하며, 드리프트 시험의 오라클은 그 금지의 대상이 아님.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

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

// 계획서 clauded-docs/14450 §9 Epic 4 의 D5 목록 원문.
const D5_ADOPTED = [
  "flowchart",
  "sequenceDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "classDiagram",
  "gitGraph",
  "C4",
];
const D5_EXCLUDED = [
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

mermaid.initialize({ startOnLoad: false });

function typeNames(entries: DiagramTypeEntry[]): string[] {
  return entries.map((e) => e.type);
}

function allKeywords(entries: DiagramTypeEntry[]): string[] {
  return entries.flatMap((e) => e.keywords);
}

test("선언 파일이 D5 채택 타입 전부를 담음", () => {
  assert.deepStrictEqual(typeNames(declaration.adopted).slice().sort(), D5_ADOPTED.slice().sort());
});

test("선언 파일이 D5 제외 타입 전부를 담음", () => {
  assert.deepStrictEqual(typeNames(declaration.excluded).slice().sort(), D5_EXCLUDED.slice().sort());
});

test("모든 항목이 타입명과 비어 있지 않은 키워드 배열을 가짐", () => {
  for (const entry of [...declaration.adopted, ...declaration.excluded]) {
    assert.ok(typeof entry.type === "string" && entry.type.length > 0, `타입명 누락: ${JSON.stringify(entry)}`);
    assert.ok(Array.isArray(entry.keywords) && entry.keywords.length > 0, `키워드 누락: ${entry.type}`);
    for (const kw of entry.keywords) {
      assert.ok(typeof kw === "string" && kw.length > 0, `빈 키워드: ${entry.type}`);
    }
  }
});

test("채택 항목마다 한 줄 용도가 있음", () => {
  for (const entry of declaration.adopted) {
    assert.ok(typeof entry.purpose === "string" && entry.purpose.length > 0, `용도 누락: ${entry.type}`);
    assert.ok(!entry.purpose.includes("\n"), `용도는 한 줄이어야 함: ${entry.type}`);
  }
});

test("제외 사유가 단일 문장으로 한 번만 적혀 있음", () => {
  assert.ok(typeof declaration.exclusionReason === "string" && declaration.exclusionReason.length > 0);
  for (const entry of declaration.excluded) {
    assert.ok(!("reason" in entry), `제외 사유가 항목마다 복제됨: ${entry.type}`);
  }
});

test("채택과 제외가 타입명 기준으로 서로소임", () => {
  const excluded = new Set(typeNames(declaration.excluded));
  const overlap = typeNames(declaration.adopted).filter((t) => excluded.has(t));
  assert.deepStrictEqual(overlap, []);
});

test("채택과 제외가 키워드 기준으로도 서로소임", () => {
  const excluded = new Set(allKeywords(declaration.excluded));
  const overlap = allKeywords(declaration.adopted).filter((k) => excluded.has(k));
  assert.deepStrictEqual(overlap, []);
});

test("키워드가 선언 전체에서 한 타입에만 속함", () => {
  const seen = new Map<string, string>();
  for (const entry of [...declaration.adopted, ...declaration.excluded]) {
    for (const kw of entry.keywords) {
      const prior = seen.get(kw);
      assert.strictEqual(prior, undefined, `키워드 ${kw} 가 ${prior} 와 ${entry.type} 에 중복됨`);
      seen.set(kw, entry.type);
    }
  }
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

test("흐름 방향 정책이 정합적임", () => {
  const { recommended, allowed, forbidden } = declaration.flowDirection;
  assert.ok(allowed.includes(recommended), "권장 방향이 허용 목록 안에 없음");
  const forbiddenSet = new Set(forbidden);
  assert.deepStrictEqual(allowed.filter((d) => forbiddenSet.has(d)), [], "허용과 금지가 겹침");
  // AC-T24 의 판정 대상 — 좌→우 · 위→아래는 허용, 우→좌 · 아래→위는 금지.
  for (const d of ["LR", "TB"]) assert.ok(allowed.includes(d), `허용 방향 누락: ${d}`);
  for (const d of ["RL", "BT"]) assert.ok(forbiddenSet.has(d), `금지 방향 누락: ${d}`);
});

test("채택 정책 선언이 저장소에 단 한 곳뿐임", () => {
  // AC-T20 의 실패 조건 — 같은 채택/제외 목록이 코드에 다시 선언되면 RED.
  // mermaid-normalize.ts 의 MERMAID_TYPE_KEYWORDS 는 "타입 줄 인식용" 광의
  // 목록이지 채택 정책이 아니므로 이 검사에 걸리지 않음(실측).
  const policySymbol = /(ADOPTED|EXCLUDED)_DIAGRAM|DIAGRAM_(ADOPTED|EXCLUDED)/i;
  const offenders: string[] = [];
  for (const root of ["src", "public/src"]) {
    const base = join(MONITOR_ROOT, root);
    for (const rel of readdirSync(base, { recursive: true, encoding: "utf8" })) {
      if (!/\.(ts|jsx|js)$/.test(rel)) continue;
      const full = join(base, rel);
      if (policySymbol.test(readFileSync(full, "utf8"))) offenders.push(join(root, rel));
    }
  }
  assert.deepStrictEqual(offenders, [], "채택 정책 목록이 JSON 밖에 다시 선언됨");
});
