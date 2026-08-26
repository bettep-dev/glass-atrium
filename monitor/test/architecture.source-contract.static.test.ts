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
