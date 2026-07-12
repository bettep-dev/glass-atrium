// Unit tests for clauded-docs/sanitize (DOMPurify wrapper).
// Runner: node:test (built-in, zero-dep) — invoked via tsx so TS sources load
// without a compile step. Run with: npx tsx --test test/clauded-docs.*.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { sanitizeHtmlBody } from "../src/server/clauded-docs/sanitize.js";

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

test("sanitizeHtmlBody: empty input → empty output, no throw", () => {
  assert.equal(sanitizeHtmlBody(""), "");
});

test("sanitizeHtmlBody: inline <script> 제거", () => {
  const out = sanitizeHtmlBody("<div>hi<script>alert(1)</script>!</div>");
  assert.ok(!out.includes("alert(1)"), "alert(1) payload must be stripped");
  assert.ok(!/<script\b/i.test(out), "script tag must not appear in output");
});

test("sanitizeHtmlBody: CDN allowlist <script src> 통과 (tailwindcss)", () => {
  const out = sanitizeHtmlBody(
    '<head><script src="https://cdn.tailwindcss.com"></script></head>',
  );
  assert.ok(
    /<script[^>]+src=["']https:\/\/cdn\.tailwindcss\.com["']/i.test(out),
    `tailwindcss cdn script preserved — actual: ${out.slice(0, 200)}`,
  );
});

test("sanitizeHtmlBody: jsdelivr 핀 경로 (mermaid 번들) <script src> 통과", () => {
  // OWN-BUNDLE 문서가 싣는 유일한 정당한 jsdelivr 스크립트 — public/index.html:58 과 동일.
  const out = sanitizeHtmlBody(
    '<head><script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script></head>',
  );
  assert.ok(
    /https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@11\/dist\/mermaid\.min\.js/i.test(out),
    "pinned jsdelivr mermaid bundle preserved",
  );
});

test("sanitizeHtmlBody: jsdelivr 비-mermaid 경로 (lodash) → 제거 (SSRF 핀)", () => {
  // whole-origin jsdelivr 허용이 SSRF 벡터였음 — mermaid 외 /npm/<pkg> 는 이제 거부.
  const out = sanitizeHtmlBody(
    '<head><script src="https://cdn.jsdelivr.net/npm/lodash@4.17.21"></script></head>',
  );
  assert.ok(
    !/cdn\.jsdelivr\.net/i.test(out),
    `non-mermaid jsdelivr script must be removed — actual: ${out.slice(0, 200)}`,
  );
});

test("sanitizeHtmlBody: jsdelivr 경로 우회 시도 (dist/../../evil) → 제거", () => {
  // URL 정규화가 `..` 를 먼저 해소 → /npm/evil@1/dist/x.js 로 접힘 → 핀 미매치 → 거부.
  const out = sanitizeHtmlBody(
    '<head><script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/../../evil@1/dist/x.js"></script></head>',
  );
  assert.ok(!/evil@1/i.test(out), "path-traversal escape past the mermaid pin must be rejected");
});

test("sanitizeHtmlBody: non-allowlist <script src> 제거", () => {
  const out = sanitizeHtmlBody(
    '<head><script src="https://evil.example.com/x.js"></script></head>',
  );
  assert.ok(
    !/evil\.example\.com/i.test(out),
    "non-allowlist script src must be removed entirely",
  );
});

test("sanitizeHtmlBody: <iframe> 제거", () => {
  const out = sanitizeHtmlBody('<div><iframe src="http://attacker"></iframe></div>');
  assert.ok(!/<iframe/i.test(out), "iframe tag must be stripped");
});

test("sanitizeHtmlBody: <form> + 컨트롤 제거", () => {
  const out = sanitizeHtmlBody(
    '<form action="/x"><input name="csrf" value="1"><button>go</button></form>',
  );
  assert.ok(!/<form/i.test(out));
  assert.ok(!/<input/i.test(out));
  assert.ok(!/<button/i.test(out));
});

test("sanitizeHtmlBody: <object> / <embed> / <applet> 제거", () => {
  const out = sanitizeHtmlBody(
    '<div><object data="x"></object><embed src="y"><applet code="z"></applet></div>',
  );
  assert.ok(!/<object/i.test(out));
  assert.ok(!/<embed/i.test(out));
  assert.ok(!/<applet/i.test(out));
});

test("sanitizeHtmlBody: onclick / onerror / onload 등 핸들러 제거", () => {
  const html = `
    <img src="/a.png" onerror="alert(1)" alt="x">
    <div onclick="alert(2)" onmouseover="alert(3)">click</div>
    <body onload="alert(4)">b</body>
  `;
  const out = sanitizeHtmlBody(html);
  assert.ok(!/onerror=/i.test(out), `onerror must be stripped — got: ${out}`);
  assert.ok(!/onclick=/i.test(out), "onclick must be stripped");
  assert.ok(!/onmouseover=/i.test(out), "onmouseover must be stripped");
  assert.ok(!/onload=/i.test(out), "onload must be stripped");
  // img / div 본체 유지 — 속성만 제거
  assert.ok(/<img\b[^>]*src=/i.test(out), "img tag itself preserved");
});

test("sanitizeHtmlBody: <a href=\"javascript:…\"> 무력화", () => {
  const out = sanitizeHtmlBody('<a href="javascript:alert(1)">x</a>');
  // DOMPurify 기본 — javascript: 스킴은 href 에서 제거 또는 about:blank 치환
  // 어떤 경우든 javascript: 문자열 결과 잔존 0
  assert.ok(!/javascript:/i.test(out), `javascript: scheme must be neutralized — got: ${out}`);
});

test("sanitizeHtmlBody: <img onerror> 핸들러만 제거하고 태그는 유지", () => {
  const out = sanitizeHtmlBody('<img src="/safe.png" onerror="alert(1)" alt="x">');
  assert.ok(/<img\b/i.test(out), "img tag preserved");
  assert.ok(!/onerror/i.test(out), "onerror attribute removed");
  assert.ok(/src=["']\/safe\.png["']/.test(out), "src preserved");
});

test("sanitizeHtmlBody: 결정성 — 동일 입력 → 동일 출력 (100 runs byte-equal)", () => {
  const html = `<!doctype html><html><head><script src="https://cdn.tailwindcss.com"></script></head>
<body><div onclick="x()" class="a">hi<script>bad()</script></div><iframe></iframe></body></html>`;
  const first = sanitizeHtmlBody(html);
  for (let i = 0; i < 100; i += 1) {
    const next = sanitizeHtmlBody(html);
    assert.equal(next, first, `run #${i} diverged from baseline`);
  }
});

test("sanitizeHtmlBody: SHA256 결정성 — sanitize → hash 100 runs 동일", () => {
  const html = '<div onclick="x()" class="a">hi<script>bad()</script></div>';
  const baseline = sha256(sanitizeHtmlBody(html));
  for (let i = 0; i < 100; i += 1) {
    const h = sha256(sanitizeHtmlBody(html));
    assert.equal(h, baseline, `hash run #${i} diverged`);
  }
});

test("sanitizeHtmlBody: roundtrip — sanitize 결과를 한 번 더 sanitize 해도 동일", () => {
  const html = `<!doctype html><html><body>
    <script>evil()</script>
    <script src="https://cdn.tailwindcss.com"></script>
    <div onclick="x()" class="a"><img onerror="y()" src="/a.png" alt="b"></div>
    <iframe src="http://attacker"></iframe>
    <form><input name="csrf"></form>
  </body></html>`;
  const once = sanitizeHtmlBody(html);
  const twice = sanitizeHtmlBody(once);
  assert.equal(twice, once, "second pass must be no-op (idempotent fixpoint)");
  assert.equal(sha256(twice), sha256(once), "sha256 of double-sanitize matches single");
});

test("sanitizeHtmlBody: WHOLE_DOCUMENT — <!doctype> / <html> / <head> / <body> 보존", () => {
  const html = "<!doctype html><html lang=\"ko\"><head><title>t</title></head><body>x</body></html>";
  const out = sanitizeHtmlBody(html);
  // DOMPurify WHOLE_DOCUMENT 모드 — html/head/body emit
  assert.ok(/<html\b/i.test(out), `<html> preserved — got: ${out}`);
  assert.ok(/<head\b/i.test(out), "<head> preserved");
  assert.ok(/<body\b/i.test(out), "<body> preserved");
});

test("sanitizeHtmlBody: data-* 속성 보존", () => {
  const out = sanitizeHtmlBody('<div data-doc-id="42" data-section="intro">x</div>');
  assert.ok(/data-doc-id=["']42["']/.test(out), "data-doc-id preserved");
  assert.ok(/data-section=["']intro["']/.test(out), "data-section preserved");
});

test("sanitizeHtmlBody: style 속성 보존 (인라인 스타일 화이트리스트 외)", () => {
  // DOMPurify — style 속성 유지 + url(javascript:…) 위험 패턴은 내부 CSS 파서가 차단
  // 평범한 background:red 는 유지 → viewer 시각 표현 보존
  const out = sanitizeHtmlBody('<div style="background: red; padding: 4px">x</div>');
  assert.ok(/style=/.test(out), "style attribute preserved for benign CSS");
});

// ----- sandbox-safe CDN gate -----------------------------------------------
//
// 비-allowlist `<script>` CDN (Chart.js / D3 / Plotly) 은 sanitize 가 제거 —
// CSP sandbox directive 와 이중 방어. viewer 응답의 sandbox CSP 는
// routes/clauded-docs.ts 책임으로 본 모듈 scope 밖.

test("sanitizeHtmlBody: Chart.js CDN injection 시도 제거", () => {
  // jsdelivr 는 mermaid 핀 경로만 허용 → chart.js /npm 스크립트는 제거된다.
  const out = sanitizeHtmlBody(
    '<head><script src="https://cdn.jsdelivr.net/npm/chart.js"></script></head>',
  );
  assert.ok(!/chart\.js/i.test(out), "non-mermaid jsdelivr chart.js script must be removed");
  assert.ok(!/cdn\.jsdelivr\.net/i.test(out), "jsdelivr host must not survive for a non-mermaid path");
});

test("sanitizeHtmlBody: D3 CDN (d3js.org) 비-allowlist → 제거", () => {
  const out = sanitizeHtmlBody(
    '<head><script src="https://d3js.org/d3.v7.min.js"></script></head>',
  );
  assert.ok(!/d3js\.org/.test(out), "d3js.org script removed");
  assert.ok(!/<script\b[^>]*src=["']https:\/\/d3js/i.test(out));
});

test("sanitizeHtmlBody: Plotly CDN (cdn.plot.ly) 비-allowlist → 제거", () => {
  const out = sanitizeHtmlBody(
    '<head><script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script></head>',
  );
  assert.ok(!/plot\.ly/.test(out), "cdn.plot.ly script removed");
});

test("sanitizeHtmlBody: Tailwind CDN <script src> 보존", () => {
  // Tailwind CDN 공식 패턴 — allowlist 통과, 그 외 비-allowlist CDN 은 제거.
  const out = sanitizeHtmlBody(
    '<html><head><script src="https://cdn.tailwindcss.com"></script></head><body>x</body></html>',
  );
  assert.ok(
    /<script[^>]+src=["']https:\/\/cdn\.tailwindcss\.com["']/i.test(out),
    "tailwind CDN script preserved",
  );
});

test("sanitizeHtmlBody: inline <script> + Chart.js usage 결합 시 모두 제거", () => {
  // 인라인 + 비-allowlist CDN 조합 — 양쪽 모두 제거.
  const out = sanitizeHtmlBody(`
    <script>new Chart(ctx, config);</script>
    <script src="https://d3js.org/d3.v7.min.js"></script>
  `);
  assert.ok(!/new Chart/.test(out), "inline chart.js usage stripped");
  assert.ok(!/d3js\.org/.test(out), "d3 CDN stripped");
});

// ----- <details>/<summary> disclosure UI 보존 ------------------------------
//
// CSS-only 토글 인터랙션을 위해 두 태그를 보존하되, handler/script/nested
// form-control 은 여전히 차단 (img onerror 선례 idiom).

test("sanitizeHtmlBody: <details>/<summary> 보존", () => {
  const out = sanitizeHtmlBody("<details><summary>x</summary>y</details>");
  assert.ok(/<details/i.test(out), `<details> preserved — got: ${out}`);
  assert.ok(/<summary/i.test(out), `<summary> preserved — got: ${out}`);
});

test("sanitizeHtmlBody: <details ontoggle> + nested <script> — 태그 보존하되 핸들러/스크립트 제거", () => {
  const out = sanitizeHtmlBody(
    '<details ontoggle="x()"><summary>s</summary><script>alert(1)</script></details>',
  );
  // details/summary 태그 자체는 통과 (img onerror 선례와 동일 — 태그 유지·핸들러 제거).
  assert.ok(/<details/i.test(out), `<details> tag preserved — got: ${out}`);
  assert.ok(/<summary/i.test(out), "<summary> tag preserved");
  // 보안 — ontoggle 핸들러 + 인라인 script + payload 모두 제거.
  assert.ok(!/ontoggle/i.test(out), `ontoggle handler must be stripped — got: ${out}`);
  assert.ok(!/<script\b/i.test(out), "inline script tag must be stripped");
  assert.ok(!/alert\(1\)/.test(out), "alert(1) payload must be stripped");
});
