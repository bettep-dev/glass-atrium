// Unit tests for clauded-docs/html-validator.
// Runner: npx tsx --test test/clauded-docs.*.test.ts
//
// API contract: validateHtmlStructure({ raw, sanitized }) — `raw` = pre-DOMPurify (doctype + charset checks), `sanitized` = post-DOMPurify (element-level checks).
// For well-formed pages where we control both, passing the same string for both is a valid degenerate case (DOMPurify not in the loop).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type HtmlStructureMissingField,
  type D8Thresholds,
  type StyleFinding,
  MAX_COMPARISON_COLUMNS,
  STYLE_RULE_ALLOWLIST,
  D8_THRESHOLDS,
  assertComparisonTableColumns,
  validateHtmlStructure,
  loadD8Thresholds,
} from "../src/server/clauded-docs/html-validator.js";

// Minimal HTML that satisfies every rule. Used as the baseline for negative
// tests (each variant strips exactly one element).
const VALID_MINIMAL = [
  "<!doctype html>",
  '<html lang="ko">',
  "<head>",
  '<meta charset="utf-8">',
  "<title>Sample Title</title>",
  "</head>",
  "<body>",
  "<main>",
  "<h1>Heading</h1>",
  "<p>Body content</p>",
  "</main>",
  "</body>",
  "</html>",
].join("\n");

// In-test convenience — pass the same string for both raw and sanitized when
// the test does not need to model DOMPurify's stripping behavior.
function check(html: string) {
  return validateHtmlStructure({ raw: html, sanitized: html });
}

function expectMissing(html: string, expected: HtmlStructureMissingField[]): void {
  const result = check(html);
  assert.strictEqual(result.ok, false, "expected validation to fail");
  if (result.ok === false) {
    assert.deepStrictEqual(
      result.missing.slice().sort(),
      expected.slice().sort(),
      `missing field set mismatch — got: ${JSON.stringify(result.missing)}`,
    );
  }
}

// happy path.

test("validateHtmlStructure: valid minimal HTML → { ok: true }", () => {
  const result = check(VALID_MINIMAL);
  assert.deepStrictEqual(result, { ok: true });
});

test("validateHtmlStructure: <article> alone satisfies semantic_landmark", () => {
  const html = VALID_MINIMAL.replace("<main>", "<article>").replace("</main>", "</article>");
  assert.deepStrictEqual(check(html), { ok: true });
});

test("validateHtmlStructure: <section> alone satisfies semantic_landmark", () => {
  const html = VALID_MINIMAL.replace("<main>", "<section>").replace("</main>", "</section>");
  assert.deepStrictEqual(check(html), { ok: true });
});

test("validateHtmlStructure: <h2> alone satisfies heading requirement", () => {
  const html = VALID_MINIMAL.replace("<h1>Heading</h1>", "<h2>Heading</h2>");
  assert.deepStrictEqual(check(html), { ok: true });
});

test("validateHtmlStructure: legacy <meta http-equiv Content-Type charset> satisfies charset", () => {
  const html = VALID_MINIMAL.replace(
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">',
  );
  assert.deepStrictEqual(check(html), { ok: true });
});

test("validateHtmlStructure: raw has doctype/charset + sanitized stripped them → still valid", () => {
  // Models the real route pipeline: raw input has every required element, sanitized (DOMPurify) output has doctype + charset removed.
  // The validator must NOT report doctype or charset missing in this case.
  const raw = VALID_MINIMAL;
  const sanitized = raw
    .replace("<!doctype html>\n", "")
    .replace('<meta charset="utf-8">\n', "");
  const result = validateHtmlStructure({ raw, sanitized });
  assert.deepStrictEqual(result, { ok: true });
});

// single-missing-field cases.

test("validateHtmlStructure: missing doctype → missing includes 'doctype'", () => {
  const html = VALID_MINIMAL.replace("<!doctype html>\n", "");
  expectMissing(html, ["doctype"]);
});

test("validateHtmlStructure: missing/empty title → missing includes 'head_title'", () => {
  const empty = VALID_MINIMAL.replace("<title>Sample Title</title>", "<title>   </title>");
  expectMissing(empty, ["head_title"]);

  const absent = VALID_MINIMAL.replace("<title>Sample Title</title>", "");
  expectMissing(absent, ["head_title"]);
});

test("validateHtmlStructure: missing body → missing includes 'body'", () => {
  // Strip the entire body region but keep <html> + <head>. node-html-parser
  // will not synthesize a body when absent, so this is a legitimate negative.
  const html = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>Sample Title</title>",
    "</head>",
    "</html>",
  ].join("\n");
  // Without <body>, the semantic landmark and heading also vanish (they lived
  // inside it). Assert that body is among the missing — alongside landmark
  // and heading, which is the realistic shape.
  const result = check(html);
  assert.strictEqual(result.ok, false);
  if (result.ok === false) {
    assert.ok(result.missing.includes("body"), "body must be reported missing");
    assert.ok(result.missing.includes("semantic_landmark"));
    assert.ok(result.missing.includes("heading"));
  }
});

test("validateHtmlStructure: only <div> containers (no main/article/section) → 'semantic_landmark'", () => {
  const html = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>Sample Title</title>",
    "</head>",
    "<body>",
    '<div class="wrapper">',
    "<h1>Heading</h1>",
    "<p>Body content</p>",
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
  expectMissing(html, ["semantic_landmark"]);
});

test("validateHtmlStructure: no heading at all → 'heading'", () => {
  const html = VALID_MINIMAL.replace("<h1>Heading</h1>", "<p>No heading here</p>");
  expectMissing(html, ["heading"]);
});

test("validateHtmlStructure: missing charset meta → 'charset'", () => {
  const html = VALID_MINIMAL.replace('<meta charset="utf-8">', "");
  expectMissing(html, ["charset"]);
});

test("validateHtmlStructure: empty charset attribute value → 'charset'", () => {
  const html = VALID_MINIMAL.replace('<meta charset="utf-8">', '<meta charset="">');
  expectMissing(html, ["charset"]);
});

test("validateHtmlStructure: Content-Type meta without charset substring → 'charset'", () => {
  const html = VALID_MINIMAL.replace(
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Type" content="text/html">',
  );
  expectMissing(html, ["charset"]);
});

// multi-missing.

test("validateHtmlStructure: bare div soup → many missing", () => {
  const html = "<p>no doctype no title</p>";
  const result = check(html);
  assert.strictEqual(result.ok, false);
  if (result.ok === false) {
    // node-html-parser synthesizes neither <html> nor <body> for a fragment,
    // so we expect a near-complete absence list. Assert the must-haves are
    // all reported; do not over-specify the exact set in case the parser's
    // synthesis behavior evolves.
    assert.ok(result.missing.includes("doctype"));
    assert.ok(result.missing.includes("head_title"));
    assert.ok(result.missing.includes("semantic_landmark"));
    assert.ok(result.missing.includes("heading"));
    assert.ok(result.missing.includes("charset"));
  }
});

test("validateHtmlStructure: missing array stays in canonical declaration order", () => {
  // Construct an input that fails doctype + head_title + charset only — verify
  // the missing array preserves that left-to-right declaration order, not
  // insertion order from the check sequence.
  const html = [
    "<html>",
    "<head>",
    "</head>",
    "<body>",
    "<main>",
    "<h1>h</h1>",
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
  const result = check(html);
  assert.strictEqual(result.ok, false);
  if (result.ok === false) {
    assert.deepStrictEqual(result.missing, ["doctype", "head_title", "charset"]);
  }
});

// determinism + DoS guard.

test("validateHtmlStructure: determinism — same input → same output across 100 runs", () => {
  const input = VALID_MINIMAL.replace("<h1>Heading</h1>", "");
  const first = check(input);
  for (let i = 0; i < 99; i += 1) {
    const next = check(input);
    assert.deepStrictEqual(next, first, `run ${i + 1} diverged from baseline`);
  }
});

test("validateHtmlStructure: 6 MB input rejected gracefully without parser crash", () => {
  // 6 MB > 5 MB MAX_INPUT_BYTES → validator returns synthetic all-missing
  // without invoking node-html-parser. Build the buffer once.
  const oversized = "<p>x</p>".repeat(800_000); // ≈ 6.4 MB
  assert.ok(oversized.length > 5 * 1024 * 1024, "test setup ensures >5 MB");
  const start = Date.now();
  const result = check(oversized);
  const elapsedMs = Date.now() - start;
  assert.strictEqual(result.ok, false);
  if (result.ok === false) {
    // Should report all 7 fields as missing — short-circuit path.
    assert.strictEqual(result.missing.length, 7);
  }
  // Sanity perf bound — the short-circuit should be near-instant. 200 ms is a
  // generous CI margin; if this ever exceeds it, the DoS guard regressed.
  assert.ok(elapsedMs < 200, `short-circuit elapsed ${elapsedMs}ms exceeds 200 ms`);
});

test("validateHtmlStructure: empty string input → all 7 fields missing", () => {
  const result = check("");
  assert.strictEqual(result.ok, false);
  if (result.ok === false) {
    assert.strictEqual(result.missing.length, 7);
  }
});

// comparison-table column cap.
// 비교 표 ≤5 columns 만 허용 — `<th>` 존재 (= 비교 의도) 시에만 게이트 발동.
// `<th>` 0건 표는 layout/grid 추정해 skip (over-enforcement 회피) · violation 시 1번째 위반 표의 1-based nth-of-type index 반환.

test("validateHtmlStructure: 5-column comparison table passes (cap inclusive)", () => {
  const html = wrapHtml(buildComparisonTable(MAX_COMPARISON_COLUMNS));
  assert.deepStrictEqual(check(html), { ok: true });
});

test("validateHtmlStructure: 4-column comparison table passes", () => {
  const html = wrapHtml(buildComparisonTable(4));
  assert.deepStrictEqual(check(html), { ok: true });
});

test("validateHtmlStructure: 6-column comparison table → d8_p2_violation", () => {
  const html = wrapHtml(buildComparisonTable(6));
  const result = check(html);
  assert.strictEqual(result.ok, false);
  if (result.ok === false && "code" in result && result.code === "d8_p2_violation") {
    assert.strictEqual(result.details.tableIndex, 1, "first table reported");
    assert.strictEqual(result.details.columnCount, 6);
    assert.strictEqual(result.details.maxAllowed, MAX_COMPARISON_COLUMNS);
  } else {
    assert.fail(`expected d8_p2_violation, got ${JSON.stringify(result)}`);
  }
});

test("validateHtmlStructure: 7-column comparison table → d8_p2_violation", () => {
  const html = wrapHtml(buildComparisonTable(7));
  const result = check(html);
  assert.strictEqual(result.ok, false);
  if (result.ok === false && "code" in result && result.code === "d8_p2_violation") {
    assert.strictEqual(result.details.columnCount, 7);
  } else {
    assert.fail(`expected d8_p2_violation, got ${JSON.stringify(result)}`);
  }
});

test("validateHtmlStructure: table without <th> (layout table) skipped", () => {
  // 6 columns of <td> 이지만 <th> 없음 → 비교 의도 아닌 layout 추정 → skip.
  // (over-enforcement 회피 — 비교 표 식별 신호는 `<th>` 존재).
  const layoutTable = "<table><tr>" + "<td>x</td>".repeat(6) + "</tr></table>";
  const html = wrapHtml(layoutTable);
  assert.deepStrictEqual(check(html), { ok: true });
});

test("validateHtmlStructure: multiple tables, all ≤5 columns → ok", () => {
  const inner = buildComparisonTable(3) + buildComparisonTable(5) + buildComparisonTable(4);
  const html = wrapHtml(inner);
  assert.deepStrictEqual(check(html), { ok: true });
});

test("validateHtmlStructure: multiple tables, 2nd violates → tableIndex=2", () => {
  // 1st table = 3 cols (pass), 2nd table = 7 cols (violate). nth-of-type
  // index 가 2 로 보고되어 viewer 가 DOM 상 위치를 식별 가능해야 함.
  const inner = buildComparisonTable(3) + buildComparisonTable(7);
  const html = wrapHtml(inner);
  const result = check(html);
  assert.strictEqual(result.ok, false);
  if (result.ok === false && "code" in result && result.code === "d8_p2_violation") {
    assert.strictEqual(result.details.tableIndex, 2);
    assert.strictEqual(result.details.columnCount, 7);
  } else {
    assert.fail(`expected d8_p2_violation, got ${JSON.stringify(result)}`);
  }
});

test("validateHtmlStructure: structure failure precedes column cap — code='html_structure_invalid'", () => {
  // 7-column table BUT structure broken (no doctype, no title). Structure
  // check runs first; column cap deferred until structure passes. Caller must
  // see the structure error code, NOT d8_p2_violation.
  const html =
    "<html><head></head><body><main>" +
    buildComparisonTable(7) +
    "</main></body></html>";
  const result = check(html);
  assert.strictEqual(result.ok, false);
  if (result.ok === false && "code" in result) {
    assert.strictEqual(result.code, "html_structure_invalid");
  } else {
    assert.fail(`expected html_structure_invalid first, got ${JSON.stringify(result)}`);
  }
});

test("assertComparisonTableColumns: standalone helper — 6 columns throws with code", () => {
  const html = wrapHtml(buildComparisonTable(6));
  assert.throws(
    () => assertComparisonTableColumns(html),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const violation = err as Error & { code?: string; tableIndex?: number; columnCount?: number };
      assert.strictEqual(violation.code, "d8_p2_violation");
      assert.strictEqual(violation.tableIndex, 1);
      assert.strictEqual(violation.columnCount, 6);
      return true;
    },
  );
});

test("assertComparisonTableColumns: standalone helper — 5 columns no-throw", () => {
  const html = wrapHtml(buildComparisonTable(MAX_COMPARISON_COLUMNS));
  assert.doesNotThrow(() => assertComparisonTableColumns(html));
});

// 테스트 픽스처 헬퍼 — N 칸 `<th>` 헤더 + 데이터 1행 비교 표 빌더 (column count 의도 가시화).
function buildComparisonTable(columns: number): string {
  const ths = Array.from({ length: columns }, (_, i) => `<th>H${i + 1}</th>`).join("");
  const tds = Array.from({ length: columns }, (_, i) => `<td>v${i + 1}</td>`).join("");
  return `<table><thead><tr>${ths}</tr></thead><tbody><tr>${tds}</tr></tbody></table>`;
}

// 본문 fixture — semantic landmark + 필수 구조를 만족시켜 컬럼 캡 단독 검증.
function wrapHtml(inner: string): string {
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>D8 P2 fixture</title>",
    "</head>",
    "<body><main><h1>D8</h1>",
    inner,
    "</main></body>",
    "</html>",
  ].join("\n");
}

// dogfood backwards-compat.

test("validateHtmlStructure: dogfood-report-shape passes (backwards-compat)", () => {
  // Mirror a real report's structural shape (head with title + meta charset,
  // body with header / main / article / section / h1 / h2). Self-contained —
  // the route-level dogfood smoke probe is the real-bytes sanity check.
  const html = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    "<title>[보고] monitor 웹 기반 클로드/ HTML 문서 관리 시스템 추가 — 완료 보고서</title>",
    "</head>",
    '<body class="px-4">',
    '<header class="report-head">',
    "<h1>monitor 웹 기반 클로드/ HTML 문서 관리 시스템 추가 — 완료 보고서</h1>",
    "</header>",
    "<main>",
    "<article>",
    "<section>",
    "<h2>1. 요약</h2>",
    "<p>본문</p>",
    "</section>",
    "</article>",
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
  assert.deepStrictEqual(check(html), { ok: true });
});

// D8 threshold JSON SoT (de-triplication of the hardcoded column cap).
// Cap is JSON.parse-loaded at module init; MAX_COMPARISON_COLUMNS resolves FROM that JSON (no literal 5 in code).
// Changing the JSON cap reflects in the gate with no code change — via the pure loadD8Thresholds(path) seam + injectable threshold.

test("D8_THRESHOLDS loaded from JSON SoT exposes the canonical cap=5", () => {
  // The on-disk SoT ships cap=5; the module-init load surfaces it on the
  // frozen D8_THRESHOLDS object and the back-compat MAX_COMPARISON_COLUMNS alias.
  assert.strictEqual(D8_THRESHOLDS.comparisonTable.maxColumns, 5);
  assert.strictEqual(MAX_COMPARISON_COLUMNS, 5);
  // Contrast + typography policy values also externalized (forward use sites).
  assert.strictEqual(D8_THRESHOLDS.contrast.textMinRatio, 4.5);
  assert.strictEqual(D8_THRESHOLDS.contrast.uiMinRatio, 3);
  assert.strictEqual(D8_THRESHOLDS.typography.maxLevels, 3);
});

test("D8_THRESHOLDS is deeply frozen (no runtime mutation of policy)", () => {
  assert.ok(Object.isFrozen(D8_THRESHOLDS));
  assert.ok(Object.isFrozen(D8_THRESHOLDS.comparisonTable));
  assert.throws(() => {
    // @ts-expect-error — frozen at runtime; compile-time readonly too.
    D8_THRESHOLDS.comparisonTable.maxColumns = 99;
  });
});

test("injecting a JSON SoT with cap=4 makes a 5-column table violate (no code change)", () => {
  // Write a temp threshold JSON with maxColumns=4, load it through the SAME
  // pure loader the module init uses, and feed it via the injectable seam.
  // A 5-column comparison table (valid under the shipped cap=5) MUST now
  // surface d8_p2_violation — proving the cap flows from data, not a literal.
  const dir = mkdtempSync(join(tmpdir(), "d8-thresh-"));
  const fixturePath = join(dir, "d8-thresholds.json");
  writeFileSync(
    fixturePath,
    JSON.stringify({
      comparisonTable: { maxColumns: 4 },
      contrast: { textMinRatio: 4.5, uiMinRatio: 3 },
      typography: { maxLevels: 3 },
    }),
  );
  try {
    const injected: D8Thresholds = loadD8Thresholds(fixturePath);
    assert.strictEqual(injected.comparisonTable.maxColumns, 4);

    const html = wrapHtml(buildComparisonTable(5));
    // Without injection (shipped cap=5) this passes — sanity anchor.
    assert.deepStrictEqual(check(html), { ok: true });
    // With cap=4 injected, the same 5-column table violates.
    const result = validateHtmlStructure({ raw: html, sanitized: html }, injected);
    assert.strictEqual(result.ok, false);
    if (result.ok === false && "code" in result && result.code === "d8_p2_violation") {
      assert.strictEqual(result.details.columnCount, 5);
      assert.strictEqual(result.details.maxAllowed, 4, "cap surfaced from injected JSON");
    } else {
      assert.fail(`expected d8_p2_violation under cap=4, got ${JSON.stringify(result)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadD8Thresholds rejects a malformed JSON SoT (missing maxColumns)", () => {
  const dir = mkdtempSync(join(tmpdir(), "d8-bad-"));
  const bad = join(dir, "d8-thresholds.json");
  writeFileSync(bad, JSON.stringify({ comparisonTable: {} }));
  try {
    assert.throws(() => loadD8Thresholds(bad), /maxColumns/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// placeholder_residue variant ({{…}} completeness gate).
// Residual {{…}} → placeholder_residue with 1-based offending lines.
// {{…}} inside <code>/<pre> does NOT raise — raw AST walk skipping those subtrees, NOT a flat regex · line = raw.slice(0,range[0]) NL+1.

// Body fixture builder — every line below the head is body content; placeholders sit on known lines (no structural contamination).
function wrapForPlaceholder(bodyLines: string[]): string {
  return [
    "<!doctype html>", // 1
    '<html lang="ko">', // 2
    "<head>", // 3
    '<meta charset="utf-8">', // 4
    "<title>Placeholder fixture</title>", // 5
    "</head>", // 6
    "<body><main><h1>H</h1>", // 7
    ...bodyLines, // 8…
    "</main></body>", // n
    "</html>", // n+1
  ].join("\n");
}

test("single residual {{…}} → placeholder_residue with its 1-based line", () => {
  // Placeholder on line 8 (first body content line after the line-7 header).
  const html = wrapForPlaceholder(["<p>Hello {{name}}, welcome.</p>"]);
  const result = check(html);
  assert.strictEqual(result.ok, false);
  if (result.ok === false && "code" in result && result.code === "placeholder_residue") {
    assert.deepStrictEqual(result.lines, [8]);
  } else {
    assert.fail(`expected placeholder_residue, got ${JSON.stringify(result)}`);
  }
});

test("multiple placeholders on different lines → all lines, ascending order", () => {
  // Lines 8, 9, 10 each carry a placeholder; one line (11) is clean.
  const html = wrapForPlaceholder([
    "<p>{{first}}</p>", // 8
    "<p>middle {{second}} text</p>", // 9
    "<p>{{third}}</p>", // 10
    "<p>clean line</p>", // 11
  ]);
  const result = check(html);
  assert.strictEqual(result.ok, false);
  if (result.ok === false && "code" in result && result.code === "placeholder_residue") {
    assert.deepStrictEqual(result.lines, [8, 9, 10], "lines in ascending order");
  } else {
    assert.fail(`expected placeholder_residue, got ${JSON.stringify(result)}`);
  }
});

test("two placeholders on the SAME line → that line reported once", () => {
  const html = wrapForPlaceholder(["<p>{{a}} and {{b}} together</p>"]); // line 8
  const result = check(html);
  assert.strictEqual(result.ok, false);
  if (result.ok === false && "code" in result && result.code === "placeholder_residue") {
    assert.deepStrictEqual(result.lines, [8], "same line deduped");
  } else {
    assert.fail(`expected placeholder_residue, got ${JSON.stringify(result)}`);
  }
});

test("{{…}} inside <code> does NOT raise (code-skip)", () => {
  const html = wrapForPlaceholder(["<p><code>const t = {{token}};</code></p>"]);
  assert.deepStrictEqual(check(html), { ok: true });
});

test("{{…}} inside <pre> does NOT raise (pre-skip)", () => {
  const html = wrapForPlaceholder(["<pre>config: {{value}}</pre>"]);
  assert.deepStrictEqual(check(html), { ok: true });
});

test("mixed — {{…}} in <code> + {{…}} in body → only the body line reported", () => {
  // Line 8 = code (exempt), line 9 = body placeholder (must raise on line 9).
  const html = wrapForPlaceholder([
    "<p><code>{{ignored_in_code}}</code></p>", // 8
    "<p>real residue {{leak}} here</p>", // 9
  ]);
  const result = check(html);
  assert.strictEqual(result.ok, false);
  if (result.ok === false && "code" in result && result.code === "placeholder_residue") {
    assert.deepStrictEqual(result.lines, [9], "only the non-code line reported");
  } else {
    assert.fail(`expected placeholder_residue, got ${JSON.stringify(result)}`);
  }
});

test("nested {{…}} inside <pre><code> (both exempt ancestors) does NOT raise", () => {
  const html = wrapForPlaceholder(["<pre><code>{{deeply_nested}}</code></pre>"]);
  assert.deepStrictEqual(check(html), { ok: true });
});

test("a clean document (no placeholders) passes through to ok", () => {
  const html = wrapForPlaceholder(["<p>fully resolved content</p>"]);
  assert.deepStrictEqual(check(html), { ok: true });
});

test("placeholder check precedes structure? No — structure failure wins", () => {
  // A fragment with a placeholder but broken structure must surface the
  // structure error first (pipeline order: structure → placeholder → column cap).
  const html = "<p>broken {{x}} fragment</p>";
  const result = check(html);
  assert.strictEqual(result.ok, false);
  if (result.ok === false && "code" in result) {
    assert.strictEqual(result.code, "html_structure_invalid");
  } else {
    assert.fail(`expected html_structure_invalid first, got ${JSON.stringify(result)}`);
  }
});

// d8_style_violation variant (findings array, 2-kind discriminated union).
// findings: StyleFinding[] — line-anchored carries {kind,line,rule}; document-level carries {kind,rule} (NO line). Surfaces:
//   - inline style= color literal (hex/rgb/rgba) → line-anchored {rule:"inline-color-literal"}.
//   - explicit light-default bg on <html>/<body> → document-level {rule:"light-default-body"} (no line field).
//   - background:white / color:black inside @media print → exempt; same outside print → raises (CSS-context-aware).
//   - STYLE_RULE_ALLOWLIST frozen; every emitted rule ∈ allowlist.

// Dark-base-satisfying wrapper so style tests isolate the rule under test
// (otherwise dark-base-absent co-fires and pollutes the findings set).
function wrapDark(headExtra: string, bodyInner: string): string {
  return [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>Style fixture</title>",
    headExtra,
    "</head>",
    '<body class="bg-zinc-950 text-zinc-100"><main><h1>H</h1>',
    bodyInner,
    "</main></body>",
    "</html>",
  ].join("\n");
}

function expectStyleFindings(html: string): StyleFinding[] {
  const result = check(html);
  assert.strictEqual(result.ok, false, "expected validation to fail");
  if (result.ok === false && "code" in result && result.code === "d8_style_violation") {
    return result.findings;
  }
  assert.fail(`expected d8_style_violation, got ${JSON.stringify(result)}`);
}

test("findings reports ALL — 2 line-anchored + 1 document-level (both kinds)", () => {
  // 2 inline color literals + an EXPLICIT light-default body (bg-white →
  // document-level light-default-body). Assert findings.length===3 and both
  // kinds present. Reports ALL findings, not first-only.
  const html = [
    "<!doctype html>", // 1
    '<html lang="ko">', // 2
    "<head>", // 3
    '<meta charset="utf-8">', // 4
    "<title>Style fixture</title>", // 5
    "</head>", // 6
    '<body class="bg-white"><main><h1>H</h1>', // 7  explicit light → document-level
    '<p style="color:#ff0000">red</p>', // 8  inline-color-literal
    '<p style="background: rgb(0,0,0)">bg</p>', // 9  inline-color-literal
    "</main></body>", // 10
    "</html>", // 11
  ].join("\n");
  const findings = expectStyleFindings(html);
  assert.strictEqual(findings.length, 3, `got ${JSON.stringify(findings)}`);
  const kinds = findings.map((f) => f.kind).sort();
  assert.deepStrictEqual(kinds, ["document-level", "line-anchored", "line-anchored"]);
  // Document-level finding carries NO line field; line-anchored ones carry a line.
  const docLevel = findings.find((f) => f.kind === "document-level");
  assert.ok(docLevel && docLevel.rule === "light-default-body");
  assert.strictEqual(docLevel && "line" in docLevel, false);
});

test("inline style= with hex color → line-anchored {line, rule:'inline-color-literal'}", () => {
  // wrapDark uses a dark token (not an explicit light token) so no
  // light-default-body finding co-fires — isolates the inline-color rule.
  // wrapDark layout: an empty headExtra still consumes line 6, so <body> is
  // line 8 and the bodyInner placeholder lands on line 9.
  const html = wrapDark("", '<p style="color:#1a2b3c">x</p>');
  const findings = expectStyleFindings(html);
  assert.strictEqual(findings.length, 1, `got ${JSON.stringify(findings)}`);
  const f = findings[0];
  assert.strictEqual(f.kind, "line-anchored");
  if (f.kind === "line-anchored") {
    assert.strictEqual(f.rule, "inline-color-literal");
    assert.strictEqual(f.line, 9, "inline-color line via node.range");
  }
});

test("inline rgba() color literal also flagged as inline-color-literal", () => {
  const html = wrapDark("", '<p style="background: rgba(255,0,0,0.5)">x</p>');
  const findings = expectStyleFindings(html);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].rule, "inline-color-literal");
});

test("inline style WITHOUT a color literal (e.g. margin only) does NOT flag", () => {
  // A non-color inline style must not trip the color-literal rule.
  const html = wrapDark("", '<p style="margin: 8px; padding: 4px">x</p>');
  assert.deepStrictEqual(check(html), { ok: true });
});

test("EXPLICIT light bg token (bg-white) on <body> → document-level {rule:'light-default-body'}, NO line field", () => {
  // Only an EXPLICIT light-default scheme is a deterministic violation (the
  // anti-pattern). Dark-token ABSENCE does NOT fire (semantic).
  const html = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>t</title>",
    "</head>",
    '<body class="bg-white"><main><h1>H</h1><p>plain</p></main></body>',
    "</html>",
  ].join("\n");
  const findings = expectStyleFindings(html);
  const docLevel = findings.find((f) => f.kind === "document-level");
  assert.ok(docLevel, "document-level finding present");
  if (docLevel) {
    assert.strictEqual(docLevel.rule, "light-default-body");
    assert.strictEqual("line" in docLevel, false, "document-level finding carries NO line field");
  }
});

test("explicit inline light background (background:white) on <body> → light-default-body", () => {
  const html = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>t</title>",
    "</head>",
    '<body style="background:white"><main><h1>H</h1><p>plain</p></main></body>',
    "</html>",
  ].join("\n");
  const findings = expectStyleFindings(html);
  assert.ok(findings.some((f) => f.kind === "document-level" && f.rule === "light-default-body"));
});

test("REGRESSION GUARD — a plain body with NO explicit light token does NOT fire (dark-absence is semantic)", () => {
  // A minimal unstyled body: the mere absence of a dark token MUST NOT raise
  // light-default-body.
  const html = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>t</title>",
    "</head>",
    "<body><main><h1>H</h1><p>plain</p></main></body>",
    "</html>",
  ].join("\n");
  assert.deepStrictEqual(check(html), { ok: true });
});

test("a dark-base body (bg-zinc-950) does NOT fire light-default-body", () => {
  const html = [
    "<!doctype html>",
    '<html lang="ko">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>t</title>",
    "</head>",
    '<body class="bg-zinc-950 text-zinc-100"><main><h1>H</h1><p>plain</p></main></body>',
    "</html>",
  ].join("\n");
  assert.deepStrictEqual(check(html), { ok: true });
});

test("background:white / color:black INSIDE @media print → does NOT raise (print exempt)", () => {
  // CSS-context-aware: literals live inside an @media print block in a <style>
  // head element. Must NOT flag.
  const printStyle = [
    "<style>",
    "@media print {",
    "  body { background: white; color: black; }",
    "}",
    "</style>",
  ].join("\n");
  const html = wrapDark(printStyle, "<p>content</p>");
  assert.deepStrictEqual(check(html), { ok: true });
});

test("background:white / color:black OUTSIDE @media print → RAISES (non-print context)", () => {
  // Same literals, but in a screen-context rule (no @media print wrapper).
  // Must flag — single-direction (exempt-only) test would be insufficient.
  const screenStyle = [
    "<style>",
    "body { background: white; color: black; }",
    "</style>",
  ].join("\n");
  const html = wrapDark(screenStyle, "<p>content</p>");
  const findings = expectStyleFindings(html);
  assert.ok(
    findings.some((f) => f.kind === "line-anchored" && f.rule === "inline-color-literal"),
    `expected a style-block color literal finding, got ${JSON.stringify(findings)}`,
  );
});

test("mixed — print block exempt + a screen-context literal still RAISES only the screen one", () => {
  const mixedStyle = [
    "<style>", // head line
    "@media print { body { background: white; } }",
    "body { color: black; }", // screen context → must raise
    "</style>",
  ].join("\n");
  const html = wrapDark(mixedStyle, "<p>content</p>");
  const findings = expectStyleFindings(html);
  // Exactly one style-block literal finding (the screen-context color:black).
  const styleBlockFindings = findings.filter(
    (f) => f.kind === "line-anchored" && f.rule === "inline-color-literal",
  );
  assert.strictEqual(styleBlockFindings.length, 1, `got ${JSON.stringify(findings)}`);
});

test("STYLE_RULE_ALLOWLIST is frozen and contains the emitted deterministic rule-ids", () => {
  assert.ok(Object.isFrozen(STYLE_RULE_ALLOWLIST));
  assert.ok(STYLE_RULE_ALLOWLIST.includes("inline-color-literal"));
  assert.ok(STYLE_RULE_ALLOWLIST.includes("light-default-body"));
});

test("P2-5: GUARD — every emitted style-finding rule ∈ STYLE_RULE_ALLOWLIST (no rule escapes the frozen set)", () => {
  // Exercise every style-violation surface in one corpus and assert the union
  // of emitted rules is a subset of the frozen allowlist. A new rule added
  // without registering it in the allowlist fails this guard.
  const corpora = [
    // inline color literal
    wrapDark("", '<p style="color:#abcdef">x</p>'),
    // explicit light-default body (document-level light-default-body)
    [
      "<!doctype html>",
      '<html lang="ko">',
      "<head>",
      '<meta charset="utf-8">',
      "<title>t</title>",
      "</head>",
      '<body class="bg-white"><main><h1>H</h1><p>x</p></main></body>',
      "</html>",
    ].join("\n"),
    // style-block screen-context literal
    wrapDark(
      "<style>body { background: white; }</style>",
      "<p>x</p>",
    ),
  ];
  const emitted = new Set<string>();
  for (const html of corpora) {
    const result = check(html);
    if (result.ok === false && "code" in result && result.code === "d8_style_violation") {
      for (const f of result.findings) emitted.add(f.rule);
    }
  }
  assert.ok(emitted.size > 0, "test corpus must emit at least one rule");
  for (const rule of emitted) {
    assert.ok(
      STYLE_RULE_ALLOWLIST.includes(rule as (typeof STYLE_RULE_ALLOWLIST)[number]),
      `emitted rule '${rule}' is outside the frozen allowlist`,
    );
  }
});

test("P2: style violations are evaluated only AFTER structure + placeholder pass", () => {
  // Pipeline order: structure → placeholder → D8 P2 columns → style. A body
  // that fails structure must surface html_structure_invalid, not d8_style_violation.
  const html = '<body><p style="color:#000">x</p></body>';
  const result = check(html);
  assert.strictEqual(result.ok, false);
  if (result.ok === false && "code" in result) {
    assert.strictEqual(result.code, "html_structure_invalid");
  } else {
    assert.fail(`expected html_structure_invalid first, got ${JSON.stringify(result)}`);
  }
});
