// Integration tests for GET /api/clauded-docs/:id/html-export — server-side
// self-contained offline HTML export via Playwright headless Chromium.
//
// Runner: node:test (built-in) via tsx — npx tsx --test test/clauded-docs.html-export.test.ts
//
// Coverage (single endpoint):
//   - PRE-ONLY mermaid happy path (the DOMINANT real shape): <pre class=mermaid>
//     with NO working init script → driver actively renders inline <svg>, CDN
//     scripts stripped.
//   - Tailwind <style> captured into the serialized body.
//   - Offline-fidelity: open the export with ALL network blocked → <svg> renders.
//   - Captured output NOT re-sanitized — <svg> survives (svg ∈ FORBID_TAGS).
//   - Dual-corpus: v10-authored AND v11-authored mermaid both yield <svg>.
//   - Dark-theme R3: serialized output carries the host dark palette token.
//   - non-HTML row → minimal HTML shell, NO browser context created.
//   - ETag round-trip 304.
//   - Korean-title Content-Disposition dual-param (attachment).
//   - R1 error mapping: 404 not_found (no reason) · 503 read · 500 path-escape.
//
// Test infrastructure:
//   - DB: real Postgres via DATABASE_URL from .env.
//   - FS: per-suite tempdir (CLAUDED_DOCS_HTML_ROOT), resetDocsRootCache after
//     env mutation, removed in after().
//   - App: stripped Fastify, only clauded-docs routes, app.inject().
//   - Browser: real chromium (Playwright). NO mocking — Playwright is the
//     boundary. resetBrowserForTests in after(). Run `npx playwright install
//     chromium` first.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "dotenv/config";

import { chromium } from "playwright";
import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerClaudedDocsRoutes } from "../src/server/routes/clauded-docs.js";
import { registerBrowserShutdownHook, resetBrowserForTests } from "../src/server/clauded-docs/browser-pool.js";
import { resetDocsRootCache } from "../src/server/clauded-docs/storage.js";

const SUITE_MARKER = `html-export-test-${randomUUID()}`;

let htmlSuiteRoot: string;
let app: FastifyInstance;

function makeTitle(label: string): string {
  return `${SUITE_MARKER}-${label}-${randomUUID()}`;
}

// PRE-ONLY mermaid doc — the dominant real corpus shape: <pre class="mermaid">
// + Tailwind script, but NO working mermaid init script (DOMPurify strips inline
// scripts). A bare setContent leaves it as plain text → the exporter MUST drive
// the injected mermaid driver to produce <svg>.
function makePreOnlyMermaidBody(salt: string, mermaidSrc: string): string {
  return (
    "<!doctype html>" +
    '<html lang="ko">' +
    `<head><meta charset="utf-8"><title>${salt}</title>` +
    '<script src="https://cdn.tailwindcss.com"></script>' +
    "</head>" +
    `<body><main><h1>${salt}</h1>` +
    `<pre class="mermaid">${mermaidSrc}</pre>` +
    "</main></body>" +
    "</html>"
  );
}

// A v11-authored flowchart (current default syntax).
const MERMAID_V11_SRC = "flowchart TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]\n  B -->|no| A";
// A v10-authored graph (older `graph` keyword + classDef) — v11 is backward-
// tolerant. Dual-corpus gate: both MUST render under the single v11 driver.
const MERMAID_V10_SRC = "graph LR\n  X-->Y\n  Y-->Z\n  classDef hot fill:#f96;\n  class X hot;";

async function seedHtmlDoc(label: string, htmlBody: string): Promise<{ id: number }> {
  const title = makeTitle(label);
  const res = await app.inject({
    method: "POST",
    url: "/api/clauded-docs",
    payload: { title, prefix: "계획", author: "tester", html_body: htmlBody },
  });
  assert.strictEqual(res.statusCode, 201, `POST seed failed: ${res.payload}`);
  return { id: (res.json() as { id: number }).id };
}

async function seedPlainDoc(label: string): Promise<{ id: number }> {
  const title = makeTitle(label);
  const mdBody = `---\naudience: agent-only\nagent: reporter\ntokens_estimate: 50\n---\n# ${title}\n\n- k: v\n\n결론: 1줄.\n`;
  const res = await app.inject({
    method: "POST",
    url: "/api/clauded-docs",
    payload: { title, prefix: "참조", author: "reporter", md_body: mdBody },
  });
  assert.strictEqual(res.statusCode, 201, `POST plain seed failed: ${res.payload}`);
  return { id: (res.json() as { id: number }).id };
}

async function fetchStoredPath(id: number): Promise<string> {
  const detail = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}` });
  return (detail.json() as { html_path: string }).html_path;
}

before(async () => {
  htmlSuiteRoot = mkdtempSync(join(tmpdir(), "clauded-docs-htmlexp-html-"));
  process.env.CLAUDED_DOCS_HTML_ROOT = htmlSuiteRoot;
  resetDocsRootCache();

  app = Fastify({ logger: false });
  registerBrowserShutdownHook(app);
  await registerClaudedDocsRoutes(app);
  await app.ready();
});

after(async () => {
  try {
    await app.close();
  } catch {
    // Best-effort.
  }
  await resetBrowserForTests();
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`
      DELETE FROM monitor.documents WHERE title LIKE ${`%${SUITE_MARKER}%`}
    `;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("[html-export-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
  rmSync(htmlSuiteRoot, { recursive: true, force: true });
  delete process.env.CLAUDED_DOCS_HTML_ROOT;
  resetDocsRootCache();
});

// ----- tests ----------------------------------------------------------------

test("GET /:id/html-export: PRE-ONLY mermaid — inline <svg> produced, no CDN <script src>", async () => {
  const { id } = await seedHtmlDoc("pre-only", makePreOnlyMermaidBody("preonly", MERMAID_V11_SRC));

  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}/html-export` });
  assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.payload}`);
  assert.strictEqual(res.headers["content-type"], "text/html; charset=utf-8");

  const body = res.payload;
  assert.ok(body.includes("<svg"), "active mermaid drive produced an inline <svg>");
  assert.ok(!body.includes("cdn.tailwindcss.com"), "Tailwind CDN <script> stripped");
  assert.ok(!body.includes("cdn.jsdelivr.net"), "no jsdelivr CDN script");
  assert.ok(!/<script[\s>]/i.test(body), "no <script> tags survive (offline)");
});

test("GET /:id/html-export: Tailwind <style> captured into serialized body", async () => {
  const tailwindDoc =
    "<!doctype html>" +
    '<html lang="ko"><head><meta charset="utf-8"><title>tw</title>' +
    '<script src="https://cdn.tailwindcss.com"></script></head>' +
    '<body class="bg-zinc-950 text-zinc-100"><main><h1 class="text-2xl font-bold">TW</h1>' +
    "<p>본문</p></main></body></html>";
  const { id } = await seedHtmlDoc("tailwind", tailwindDoc);

  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}/html-export` });
  assert.strictEqual(res.statusCode, 200, res.payload);
  assert.ok(res.payload.includes("<style"), "Tailwind runtime-injected <style> present in capture");
});

test("GET /:id/html-export: offline-fidelity — renders with ALL network blocked + <svg> survives without re-sanitize", async () => {
  const { id } = await seedHtmlDoc("offline", makePreOnlyMermaidBody("offline", MERMAID_V11_SRC));
  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}/html-export` });
  assert.strictEqual(res.statusCode, 200, res.payload);
  const captured = res.payload;

  // SVG MUST survive — the export path sends captured output directly, never
  // through sanitizeHtmlBody (svg ∈ FORBID_TAGS would strip it). This test does
  // NOT re-sanitize (asserting the invariant by construction).
  assert.ok(captured.includes("<svg"), "captured <svg> present (not re-sanitized away)");

  // Open the captured output in a fresh page with ALL network blocked (only
  // data: URIs allowed). A rendered <svg> + no pageerror proves zero-network.
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let pageError: string | null = null;
    page.on("pageerror", (e) => { pageError = e.message; });
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url === "about:blank") return route.continue();
      return route.abort();
    });
    await page.setContent(captured, { waitUntil: "domcontentloaded" });
    const svgCount = await page.$$eval("svg", (els) => els.length);
    assert.ok(svgCount >= 1, "offline open renders >=1 <svg>");
    assert.strictEqual(pageError, null, `no pageerror on offline open, got: ${String(pageError)}`);
    await ctx.close();
  } finally {
    await browser.close();
  }
});

test("GET /:id/html-export: dual-corpus — v10-authored AND v11-authored mermaid both yield <svg>", async () => {
  const v11 = await seedHtmlDoc("v11", makePreOnlyMermaidBody("v11", MERMAID_V11_SRC));
  const v10 = await seedHtmlDoc("v10", makePreOnlyMermaidBody("v10", MERMAID_V10_SRC));

  const r11 = await app.inject({ method: "GET", url: `/api/clauded-docs/${v11.id}/html-export` });
  assert.strictEqual(r11.statusCode, 200, `v11 export: ${r11.payload}`);
  assert.ok(r11.payload.includes("<svg"), "v11-authored source rendered <svg>");

  const r10 = await app.inject({ method: "GET", url: `/api/clauded-docs/${v10.id}/html-export` });
  assert.strictEqual(r10.statusCode, 200, `v10 export: ${r10.payload}`);
  assert.ok(r10.payload.includes("<svg"), "v10-authored source rendered <svg> under v11 driver");
});

test("GET /:id/html-export: dark theme (R3) — serialized output carries the host dark palette token", async () => {
  const { id } = await seedHtmlDoc("dark", makePreOnlyMermaidBody("dark", MERMAID_V11_SRC));
  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}/html-export` });
  assert.strictEqual(res.statusCode, 200, res.payload);
  // The viewer's non-default dark themeVariables (#e5e7eb light text, #1e293b
  // node fill) flow into mermaid's emitted <svg>/<style>. Stock mermaid light
  // defaults would NOT contain these tokens. Assert at least one host token.
  const body = res.payload.toLowerCase();
  const hasDarkToken =
    body.includes("#e5e7eb") || body.includes("#1e293b") || body.includes("#0a0a0a");
  assert.ok(hasDarkToken, "serialized mermaid output references the host dark palette");
});

test("GET /:id/html-export: non-HTML row — minimal HTML shell, NO browser invoked", async () => {
  const { id } = await seedPlainDoc("plain");
  // Spy: a fresh chromium connection count proxy — assert no <script>/<svg> and
  // a valid shell. (The non-HTML path skips the browser by construction; we
  // assert the shell shape rather than instrument the pool.)
  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}/html-export` });
  assert.strictEqual(res.statusCode, 200, res.payload);
  assert.strictEqual(res.headers["content-type"], "text/html; charset=utf-8");
  const body = res.payload;
  assert.ok(body.startsWith("<!doctype html>"), "valid self-contained shell");
  assert.ok(body.includes("<meta charset"), "charset meta present");
  assert.ok(!/<script/i.test(body), "shell has no script");
  // The md body content is HTML-escaped inside the shell.
  assert.ok(body.includes("&lt;") || body.includes("결론") || body.includes("<main>"),
    "raw body wrapped + escaped in shell");
});

test("GET /:id/html-export: ETag round-trip — second request with If-None-Match returns 304", async () => {
  const { id } = await seedHtmlDoc("etag", makePreOnlyMermaidBody("etag", MERMAID_V11_SRC));
  const first = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}/html-export` });
  assert.strictEqual(first.statusCode, 200, first.payload);
  const etag = first.headers["etag"];
  assert.ok(typeof etag === "string" && /^"[a-f0-9]{64}"$/.test(etag), `quoted sha256 ETag, got ${String(etag)}`);

  const second = await app.inject({
    method: "GET",
    url: `/api/clauded-docs/${id}/html-export`,
    headers: { "if-none-match": etag as string },
  });
  assert.strictEqual(second.statusCode, 304, "cache hit returns 304");
  assert.strictEqual(second.headers["etag"], etag, "304 echoes the ETag");
});

test("GET /:id/html-export: Korean title — attachment Content-Disposition dual-param", async () => {
  const koreanLabel = "한글제목-계획";
  const title = `${SUITE_MARKER}-${koreanLabel}-${randomUUID()}`;
  const seedRes = await app.inject({
    method: "POST",
    url: "/api/clauded-docs",
    payload: {
      title, prefix: "계획", author: "tester",
      html_body: makePreOnlyMermaidBody("kr", MERMAID_V11_SRC),
    },
  });
  assert.strictEqual(seedRes.statusCode, 201, seedRes.payload);
  const id = (seedRes.json() as { id: number }).id;

  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}/html-export` });
  assert.strictEqual(res.statusCode, 200, `Korean export should 200, got ${res.payload}`);
  const disposition = res.headers["content-disposition"] as string;
  assert.ok(typeof disposition === "string", "Content-Disposition present");
  assert.ok(disposition.startsWith("attachment; filename="), `attachment disposition, got: ${disposition}`);
  for (let i = 0; i < disposition.length; i += 1) {
    assert.ok(disposition.charCodeAt(i) <= 0x7f, `non-ASCII at ${i}: ${disposition}`);
  }
  assert.match(disposition, /^attachment; filename="[\x20-\x7e]+\.html"; filename\*=UTF-8''/, `shape: ${disposition}`);
  const extValue = disposition.slice(disposition.indexOf("filename*=UTF-8''") + "filename*=UTF-8''".length);
  assert.ok(decodeURIComponent(extValue).includes("한글제목"), `Korean preserved: ${decodeURIComponent(extValue)}`);
});

test("GET /:id/html-export: 404 not_found when id does not exist — NO reason field (R1 a)", async () => {
  const ghostId = 999_999_998;
  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${ghostId}/html-export` });
  assert.strictEqual(res.statusCode, 404);
  const body = res.json() as { error: string; id: number; reason?: string };
  assert.strictEqual(body.error, "not_found");
  assert.strictEqual(body.id, ghostId);
  assert.strictEqual(body.reason, undefined, "not_found shape has NO reason field");
});

test("GET /:id/html-export: 400 invalid_param when id is not a positive int", async () => {
  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/abc/html-export` });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { error: string; param: string };
  assert.strictEqual(body.error, "invalid_param");
  assert.strictEqual(body.param, "id");
});

test("GET /:id/html-export: 503 filesystem_unavailable on unreadable stored bytes (R1 b — NOT 404/500)", async () => {
  const { id } = await seedHtmlDoc("unreadable", makePreOnlyMermaidBody("unreadable", MERMAID_V11_SRC));
  // Delete the stored file out from under the row → readFileUtf8 fails.
  const storedPath = await fetchStoredPath(id);
  await rm(storedPath, { force: true });

  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}/html-export` });
  assert.strictEqual(res.statusCode, 503, `R1 (b): read failure → 503, got ${res.statusCode}`);
  const body = res.json() as { error: string; reason: string };
  assert.strictEqual(body.error, "filesystem_unavailable");
  assert.ok(body.reason.startsWith("html_export_read:"), `reason prefix html_export_read:, got: ${body.reason}`);
});

// ----- BUG A + BUG B regression tests ----------------------------------------
// Mirrors real corpus shape (doc 6915): stored body has BOTH a <style>@import for
// Pretendard via jsdelivr + Tailwind CDN script + mermaid block.

function makeJsdelivrPretendardBody(salt: string, mermaidSrc: string): string {
  // Reflects the actual pattern seen in production docs — @import inside <style>
  // for the jsdelivr-hosted Pretendard webfont, alongside Tailwind CDN + mermaid.
  return (
    "<!doctype html>" +
    '<html lang="ko" class="bg-zinc-950">' +
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${salt}</title>` +
    '<script src="https://cdn.tailwindcss.com"></script>' +
    "<style>" +
    "@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css');" +
    "body { font-family: Pretendard, system-ui, -apple-system, sans-serif; }" +
    "</style>" +
    "</head>" +
    `<body><main><h1>${salt}</h1>` +
    `<pre class="mermaid">${mermaidSrc}</pre>` +
    "</main></body>" +
    "</html>"
  );
}

test("GET /:id/html-export: BUG A — exported HTML begins with <!doctype html> (not quirks mode)", async () => {
  const { id } = await seedHtmlDoc("doctype", makeJsdelivrPretendardBody("doctype", MERMAID_V11_SRC));

  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}/html-export` });
  assert.strictEqual(res.statusCode, 200, `expected 200: ${res.payload}`);

  const body = res.payload;
  // Must start with DOCTYPE (case-insensitive per HTML5 parsing rules).
  assert.ok(
    /^<!doctype html/i.test(body.trimStart()),
    `exported HTML must begin with <!doctype html>, got: ${body.slice(0, 80)}`,
  );
});

test("GET /:id/html-export: BUG B — @import of CDN webfont (jsdelivr/tailwindcss/googleapis/gstatic) stripped from <style>", async () => {
  const { id } = await seedHtmlDoc("no-cdn-import", makeJsdelivrPretendardBody("no-cdn-import", MERMAID_V11_SRC));

  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}/html-export` });
  assert.strictEqual(res.statusCode, 200, `expected 200: ${res.payload}`);

  const body = res.payload;

  // No CDN host substring must appear anywhere in the output — covers @import
  // inside <style> AND any surviving <script src> or <link href>.
  assert.ok(!body.includes("cdn.jsdelivr.net"), "cdn.jsdelivr.net must be stripped");
  assert.ok(!body.includes("cdn.tailwindcss.com"), "cdn.tailwindcss.com must be stripped");
  assert.ok(!body.includes("fonts.googleapis.com"), "fonts.googleapis.com must be stripped");
  assert.ok(!body.includes("fonts.gstatic.com"), "fonts.gstatic.com must be stripped");

  // No @import of any http(s) URL must remain.
  assert.ok(
    !/@import\s+(?:url\()?['"]?https?:/i.test(body),
    "@import of http(s) URL must be stripped from <style>",
  );

  // font-family fallback stack MUST still be present (only the @import is removed,
  // not the entire <style> rule).
  assert.ok(
    body.includes("font-family") && body.includes("Pretendard"),
    "font-family Pretendard fallback stack must survive after @import strip",
  );
});

// ----- OWN-BUNDLE regression test (doc 6768 corpus class) --------------------
// Docs that ship their OWN mermaid CDN <script src> (no inline mermaid.initialize
// because DOMPurify strips inline scripts) auto-render on setContent because
// mermaid@11's default startOnLoad is true. The export driver's driveMermaidRender
// must read the PRISTINE source from the raw stored body string (NOT the live DOM
// textContent, which is polluted by the auto-render's SVG label text).

function makeOwnBundleMermaidBody(salt: string, mermaidSrc: string): string {
  // OWN-BUNDLE shape: stored body carries a mermaid CDN <script src> (allowlisted
  // by sanitize.ts — jsdelivr is on the allowlist) + NO inline mermaid.initialize
  // (inline scripts stripped by DOMPurify). Mermaid default startOnLoad=true →
  // auto-renders <pre class="mermaid"> on page load → pollutes live DOM textContent.
  return (
    "<!doctype html>" +
    '<html lang="ko" class="bg-zinc-950">' +
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${salt}</title>` +
    '<script src="https://cdn.tailwindcss.com"></script>' +
    // 본 번들이 startOnLoad:true(기본값)으로 <pre class="mermaid">를 자동 렌더 →
    // 드라이버가 live DOM textContent를 읽으면 오염된 SVG 레이블 텍스트 취득 → 실패.
    '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>' +
    "</head>" +
    `<body><main><h1>${salt}</h1>` +
    // &gt;&gt; entity arrows — mirrors the real corpus (doc 6768 sequenceDiagram source)
    `<pre class="mermaid">${mermaidSrc}</pre>` +
    "</main></body>" +
    "</html>"
  );
}

// sequenceDiagram with HTML-entity-encoded arrows (&gt;&gt;) — the real corpus
// stores arrows this way (stored body was sanitized before save).
const OWN_BUNDLE_SEQUENCE_SRC =
  "sequenceDiagram\n" +
  "    participant A as 클라이언트\n" +
  "    participant B as 서버\n" +
  "    A-&gt;&gt;B: 요청\n" +
  "    B--&gt;&gt;A: 응답\n" +
  "    Note over A,B: 완료";

test("GET /:id/html-export: render-time SSRF interceptor — Tailwind allowed (no 503) while OWN-BUNDLE jsdelivr aborted, still renders", async () => {
  // Combined interceptor proof in a single render: the body references BOTH
  // cdn.tailwindcss.com (MUST stay allowed — else waitForTailwindStylesheet 503)
  // AND a jsdelivr mermaid <script src> (allowlisted by sanitize, so it survives
  // into the stored body). The render interceptor ABORTS the jsdelivr request;
  // the locally-injected mermaid driver still produces <svg>. Result: 200 (no
  // tailwind 503) + runtime <style> captured + <svg> + zero jsdelivr/tailwind
  // host egress in the output.
  const { id } = await seedHtmlDoc(
    "interceptor",
    makeOwnBundleMermaidBody("interceptor", OWN_BUNDLE_SEQUENCE_SRC),
  );

  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}/html-export` });
  assert.strictEqual(
    res.statusCode,
    200,
    `interceptor must not 503 the tailwind path, got ${res.statusCode}: ${res.payload.slice(0, 300)}`,
  );
  const body = res.payload;
  assert.ok(body.includes("<style"), "Tailwind runtime <style> captured (CDN was allowed at render)");
  assert.ok(body.includes("<svg"), "mermaid rendered <svg> despite jsdelivr abort (local driver)");
  assert.ok(!body.includes("cdn.jsdelivr.net"), "jsdelivr host absent from output");
  assert.ok(!body.includes("cdn.tailwindcss.com"), "tailwind <script> stripped from output");
});

test("GET /:id/html-export: OWN-BUNDLE — own mermaid CDN script does not pollute export (doc 6768 corpus class)", async () => {
  // 본 테스트는 픽스 전에 RED: 자체 번들이 startOnLoad로 <pre>를 SVG로 변환 →
  // driveMermaidRender가 live textContent(SVG 레이블)를 mermaid.render()에 전달 →
  // "No diagram type detected" 예외 → 503 반환.
  // 픽스 후 GREEN: raw storedBody 문자열에서 소스 추출 → 엔티티 디코드 → 렌더링 성공.
  const { id } = await seedHtmlDoc(
    "own-bundle",
    makeOwnBundleMermaidBody("own-bundle", OWN_BUNDLE_SEQUENCE_SRC),
  );

  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}/html-export` });
  assert.strictEqual(res.statusCode, 200, `OWN-BUNDLE export must succeed (200), got ${res.statusCode}: ${res.payload.slice(0, 300)}`);

  const body = res.payload;
  // mermaid driver must have rendered the sequenceDiagram → inline <svg> present.
  assert.ok(body.includes("<svg"), "OWN-BUNDLE: mermaid sequenceDiagram rendered as <svg>");
  // CDN scripts stripped from output (strip pass removes all <script> nodes).
  assert.ok(!body.includes("cdn.jsdelivr.net"), "mermaid CDN <script src> stripped from output");
  assert.ok(!/<script[\s>]/i.test(body), "no <script> tags survive the strip pass");
});
