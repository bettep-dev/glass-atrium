// Source-contract assertions over public/src/screens/architecture.jsx — a text read of the
// shipped screen, not a render. Two clause kinds live here: ABSENCE of a construct the screen
// must no longer carry, and SURVIVAL of a rule that a nearby deletion can take with it.
// Runner: npx tsx --test test/architecture.source-contract.static.test.ts
//
// The screen is a browser JSX module: it sits outside the tsx --test import path and outside
// tsconfig's include, so neither an import nor a type check reaches it — reading the text is
// what is left. Precedent: test/daemon-status.enum-parity.test.ts reads route source and
// compares the declaration block it extracts by regex.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCREEN_SRC = readFileSync(
  fileURLToPath(new URL("../public/src/screens/architecture.jsx", import.meta.url)),
  "utf8",
);

// 범례가 남길 수 있는 흔적 전부 — 스타일 선택자 · 상태 클래스 · 컴포넌트 · 상태 훅.
// UI 만 지우고 배선을 남기면 화면은 조용한데 소스에는 죽은 상호작용이 남음.
const LEGEND_TOKENS = [
  ".arch-legend-details",
  ".arch-legend-grid",
  ".arch-legend-item",
  ".arch-legend-swatch-box",
  ".arch-legend-swatch-line",
  ".arch-mermaid-canvas.legend-focus",
  "legend-focus",
  "legend-hit",
  "legendFocus",
  "legendUsedSets",
  "LegendDetails",
  "LegendBlock",
];

// 서버가 이미 내는 판정을 화면이 다시 재면 같은 입력에 답이 둘이 됨.
// 비교식을 정규식으로 쫓는 대신 재료의 부재를 잼 — cadence 와 staleness 를 화면이 어디서도
// 읽지 않으면 둘을 견주는 식은 성립할 수 없고, 이 단언은 서식 변경에 흔들리지 않음.
const CLIENT_THRESHOLD_TOKENS = [
  "expected_cadence_minutes",
  "staleness_minutes",
  "daemonEffectiveTone",
];

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

test("AC-T19 no legend rule or wiring survives in the screen source", () => {
  const residue = LEGEND_TOKENS.map(
    (token) => [token, countOccurrences(SCREEN_SRC, token)] as const,
  ).filter(([, count]) => count > 0);

  assert.deepEqual(
    residue.map(([token]) => token),
    [],
    `legend residue in architecture.jsx: ${residue.map(([t, c]) => `${t}×${c}`).join(", ")}`,
  );
});

// 이 규칙은 범례 규칙과 **같은 인라인 <style> 블록**에 있어 범례 절제가 함께 가져가기 쉬움.
// JS 쪽 두 번째 방어선(svgEl.style.maxWidth)은 `if (!window.svgPanZoom) return;` 뒤에 있어
// CDN 실패 시 증발하므로, 이 CSS 가 mermaid 인라인 max-width 스탬프의 유일한 상시 방어선임.
// 초록에서 초록으로 남는 회귀 잠금이지 AC 가 아님.
test("the canvas svg width override survives legend excision", () => {
  const rule = SCREEN_SRC.match(/"\.arch-mermaid-canvas svg \{[^"]*"/);

  assert.ok(rule, "the .arch-mermaid-canvas svg rule must still be declared in the inline style block");
  assert.match(rule[0], /max-width:\s*none\s*!important/);
  assert.match(rule[0], /width:\s*100%\s*!important/);
});

test("AC-T2 no cadence-vs-staleness comparison survives in the screen source", () => {
  const residue = CLIENT_THRESHOLD_TOKENS.map(
    (token) => [token, countOccurrences(SCREEN_SRC, token)] as const,
  ).filter(([, count]) => count > 0);

  assert.deepEqual(
    residue.map(([token]) => token),
    [],
    `staleness re-computation residue in architecture.jsx: ${residue.map(([t, c]) => `${t}\u00d7${c}`).join(", ")}`,
  );
});

// 심각도 색이 meta/micro 글자에 얹히면 AA 대비(warn 3.05:1 · ok 3.61 · info 3.53)에 못 미침 —
// 39578 §D 는 tone 을 글리프 · 바 · 경보 컨테이너에만 싣게 함. 색 리터럴을 표 하나에 모아 두고
// 그 표를 글리프만 읽게 하면, 글자에 색을 다시 얹는 순간 둘 중 하나가 붉어짐.
const TONE_COLOR_CLASSES = ["text-ok", "text-warn", "text-crit", "text-info"];

// 표 선언 블록만 도려냄 — 값 리터럴이 사는 유일한 자리라 나머지는 전부 위반임.
const TONE_TABLE_BLOCK = /const TONE_GLYPH_CLASS = \{[^}]*\};/;

// 자기 닫힘 <Icon … /> 한 덩어리. className 식에 '>' 가 없어 [^>]* 로 끊김이 정확함.
const ICON_ELEMENT = /<Icon\b[^>]*\/>/g;

test("AC-T-tone severity colour literals live only in the glyph class table", () => {
  const table = SCREEN_SRC.match(TONE_TABLE_BLOCK);
  assert.ok(table, "TONE_GLYPH_CLASS must still be declared as a literal table");

  const outsideTable = SCREEN_SRC.replace(table[0], "");
  const residue = TONE_COLOR_CLASSES.map(
    (token) => [token, countOccurrences(outsideTable, token)] as const,
  ).filter(([, count]) => count > 0);

  assert.deepEqual(
    residue.map(([token]) => token),
    [],
    `tone colour on a non-glyph node in architecture.jsx: ${residue.map(([t, c]) => `${t}×${c}`).join(", ")}`,
  );
});

test("AC-T-tone the glyph class table is read by icon elements only", () => {
  const references = countOccurrences(SCREEN_SRC, "TONE_GLYPH_CLASS") - 1;
  const onIcons = (SCREEN_SRC.match(ICON_ELEMENT) || []).reduce(
    (sum, el) => sum + countOccurrences(el, "TONE_GLYPH_CLASS"),
    0,
  );

  assert.ok(references > 0, "the glyph class table must still have a consumer");
  assert.equal(
    onIcons,
    references,
    `${references - onIcons} of ${references} TONE_GLYPH_CLASS references sit outside an <Icon> element`,
  );
});

// ui.jsx Badge paints its label in text-{tone} when a status badge drops its glyph.
test("AC-T-tone no status badge drops its glyph, which would put tone on the label", () => {
  const offenders = (SCREEN_SRC.match(/<Badge\b[^>]*>/g) || []).filter(
    (tag) => tag.includes('role="status"') && tag.includes("glyph={false}"),
  );

  assert.deepEqual(offenders, []);
});

// 경보 자리를 이름으로 셈 — 개수로 재면 한 자리를 지우고 다른 자리를 들여도 통과함.
test("AC-T-tone alert role is declared by the alarm row and the canvas error banner only", () => {
  const declarers = SCREEN_SRC.split(/^function /m)
    .slice(1)
    .filter((block) => block.includes('role="alert"'))
    .map((block) => block.slice(0, block.indexOf("(")));

  assert.deepEqual(declarers.sort(), ["AlarmRowAR", "ErrorBannerAR"]);
});
