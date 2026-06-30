// Integration tests for POST /api/clauded-docs/html-export — server-side
// multi-document ZIP export. Each selected doc becomes a self-contained .html
// entry inside the ZIP, plus a top-level _manifest.json.
//
// Runner: node:test (built-in) via tsx — npx tsx --test test/clauded-docs.html-export-multi.test.ts
//
// Entry-name capture strategy (R2 append-spy — no unzip dep):
//   Monkey-patch ZipArchive.prototype.append BEFORE each test that needs name
//   capture. The route handler constructs its archive instance via
//   `(archiverNs as unknown as {ZipArchive:...}).ZipArchive`, so the same
//   prototype is patched. Each patch is restored in afterEach/finally.
//   Node ESM module caching guarantees both this file and the route share the
//   same ZipArchive class object from `import * as archiverNs from "archiver"`.
//
// Coverage:
//   - valid ids → 200 application/zip, entry names captured by prototype spy
//     (exactly one .html per EXISTING id + one _manifest.json).
//   - ids.length > 50 → 400 {error:"invalid_param",param:"ids"} — BEFORE browser.
//   - empty / malformed body ({} or {ids:[]}) → 400 {error:"invalid_body"}.
//   - mixed valid + nonexistent id → zip produced; _manifest.json shows
//     included:false + reason for the missing id; X-Included-Count = 1.
//   - mixed HTML + non-HTML (예정 .md row) → both present, non-HTML shell-wrapped.
//   - ZERO includable ids → JSON export_failed envelope, never a doc-less 200 zip
//     (silent-failure guard): all-not_found → 404 · read/render failure → 503.
//
// Test infrastructure (mirrors clauded-docs.html-export.test.ts EXACTLY):
//   - DB: real Postgres via DATABASE_URL from .env.
//   - FS: per-suite tempdir (CLAUDED_DOCS_HTML_ROOT), resetDocsRootCache after
//     env mutation, removed in after().
//   - App: stripped Fastify with only clauded-docs routes, app.inject().
//   - Browser: real chromium (Playwright). NO mocking — Playwright is the
//     boundary (testing.md). resetBrowserForTests in beforeEach + after().
//   - Run `npx playwright install chromium` first.

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "dotenv/config";

import * as archiverNs from "archiver";
import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerClaudedDocsRoutes } from "../src/server/routes/clauded-docs.js";
import { registerBrowserShutdownHook, resetBrowserForTests } from "../src/server/clauded-docs/browser-pool.js";
import { resetDocsRootCache } from "../src/server/clauded-docs/storage.js";

const SUITE_MARKER = `html-export-multi-test-${randomUUID()}`;

let htmlSuiteRoot: string;
let app: FastifyInstance;

function makeTitle(label: string): string {
  return `${SUITE_MARKER}-${label}-${randomUUID()}`;
}

// PRE-ONLY mermaid doc — the dominant real corpus shape (no working init script).
function makePreOnlyMermaidBody(salt: string): string {
  const src = "flowchart TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]\n  B -->|no| A";
  return (
    "<!doctype html>" +
    '<html lang="ko">' +
    `<head><meta charset="utf-8"><title>${salt}</title>` +
    '<script src="https://cdn.tailwindcss.com"></script>' +
    "</head>" +
    `<body><main><h1>${salt}</h1>` +
    `<pre class="mermaid">${src}</pre>` +
    "</main></body>" +
    "</html>"
  );
}

// Minimal dark HTML body (no mermaid — faster render for zip tests).
function makeSimpleHtmlBody(salt: string): string {
  return (
    "<!doctype html>" +
    '<html lang="ko">' +
    `<head><meta charset="utf-8"><title>${salt}</title>` +
    '<script src="https://cdn.tailwindcss.com"></script>' +
    "</head>" +
    `<body class="bg-zinc-950 text-zinc-100"><main><h1 class="text-2xl">${salt}</h1></main></body>` +
    "</html>"
  );
}

async function seedHtmlDoc(label: string, htmlBody?: string): Promise<{ id: number }> {
  const title = makeTitle(label);
  const body = htmlBody ?? makeSimpleHtmlBody(label);
  const res = await app.inject({
    method: "POST",
    url: "/api/clauded-docs",
    payload: { title, prefix: "계획", author: "tester", html_body: body },
  });
  assert.strictEqual(res.statusCode, 201, `POST html seed failed for ${label}: ${res.payload}`);
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
  assert.strictEqual(res.statusCode, 201, `POST plain seed failed for ${label}: ${res.payload}`);
  return { id: (res.json() as { id: number }).id };
}

/**
 * Spy helper — patches ZipArchive.prototype.append to record entry names.
 * Returns { capturedNames, restore }.
 * MUST call restore() after each test to prevent bleed into subsequent tests.
 *
 * The route accesses ZipArchive via the same archiverNs module reference, so
 * prototype patching affects the handler's archive instances transitively.
 */
function patchAppendSpy(): { capturedNames: string[]; restore: () => void } {
  const capturedNames: string[] = [];
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const ZipClass = (archiverNs as unknown as { ZipArchive: new (...args: unknown[]) => { append: (...args: unknown[]) => unknown } }).ZipArchive;
  const originalAppend = ZipClass.prototype.append as (...args: unknown[]) => unknown;

  ZipClass.prototype.append = function patchedAppend(
    source: unknown,
    data?: { name?: string },
    ...rest: unknown[]
  ): unknown {
    if (typeof data?.name === "string") {
      capturedNames.push(data.name);
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    return originalAppend.call(this, source, data, ...rest);
  };

  const restore = (): void => {
    ZipClass.prototype.append = originalAppend;
  };
  return { capturedNames, restore };
}

before(async () => {
  htmlSuiteRoot = mkdtempSync(join(tmpdir(), "clauded-docs-htmlexp-multi-html-"));
  process.env.CLAUDED_DOCS_HTML_ROOT = htmlSuiteRoot;
  resetDocsRootCache();

  app = Fastify({ logger: false });
  registerBrowserShutdownHook(app);
  await registerClaudedDocsRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  // 테스트 간 브라우저 상태 격리 — single endpoint 테스트와 동일 패턴.
  await resetBrowserForTests();
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
    console.error("[html-export-multi-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
  rmSync(htmlSuiteRoot, { recursive: true, force: true });
  delete process.env.CLAUDED_DOCS_HTML_ROOT;
  resetDocsRootCache();
});

// ----- tests ----------------------------------------------------------------

test("POST /html-export: valid ids → 200 application/zip + one .html entry per id + _manifest.json", async () => {
  const doc1 = await seedHtmlDoc("zip-valid-1");
  const doc2 = await seedHtmlDoc("zip-valid-2");
  const ids = [doc1.id, doc2.id];

  const { capturedNames, restore } = patchAppendSpy();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/clauded-docs/html-export",
      payload: { ids },
    });
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.payload.slice(0, 200)}`);
    assert.ok(
      res.headers["content-type"]?.toString().startsWith("application/zip"),
      `content-type should be application/zip, got: ${res.headers["content-type"]}`,
    );
    const disposition = res.headers["content-disposition"] as string;
    assert.ok(typeof disposition === "string" && disposition.startsWith("attachment;"), `attachment disposition: ${String(disposition)}`);
    // 전건 포함 → X-Included-Count == 요청 수 (클라이언트 부분실패 감지 계약).
    assert.strictEqual(res.headers["x-included-count"], String(ids.length), `X-Included-Count should be ${ids.length}`);

    // Entry-name assertions via prototype spy (R2 — no unzip dep).
    const htmlEntries = capturedNames.filter((n) => n.endsWith(".html"));
    const manifestEntries = capturedNames.filter((n) => n === "_manifest.json");

    assert.strictEqual(htmlEntries.length, ids.length, `expected ${ids.length} .html entries, got ${htmlEntries.length}: ${JSON.stringify(capturedNames)}`);
    assert.strictEqual(manifestEntries.length, 1, `expected 1 _manifest.json entry, got ${manifestEntries.length}`);

    // 모든 entry 이름 고유 확인 (buildZipEntryName 충돌 방지 로직 검증).
    const unique = new Set(capturedNames);
    assert.strictEqual(unique.size, capturedNames.length, `entry names must be unique: ${JSON.stringify(capturedNames)}`);
  } finally {
    restore();
  }
});

test("POST /html-export: ids.length > 50 → 400 invalid_param param=ids (before browser launch)", async () => {
  // 51개 id 배열 — 실제 row 불필요 (validation 이 browser 가동 전 실행).
  const ids = Array.from({ length: 51 }, (_, i) => i + 1);

  const res = await app.inject({
    method: "POST",
    url: "/api/clauded-docs/html-export",
    payload: { ids },
  });
  assert.strictEqual(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
  const body = res.json() as { error: string; param: string };
  assert.strictEqual(body.error, "invalid_param");
  assert.strictEqual(body.param, "ids", `param should be 'ids', got: ${body.param}`);
});

test("POST /html-export: empty body {} → 400 invalid_body", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/clauded-docs/html-export",
    payload: {},
  });
  assert.strictEqual(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
  const body = res.json() as { error: string };
  assert.strictEqual(body.error, "invalid_body");
});

test("POST /html-export: {ids:[]} → 400 invalid_body", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/clauded-docs/html-export",
    payload: { ids: [] },
  });
  assert.strictEqual(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
  const body = res.json() as { error: string };
  assert.strictEqual(body.error, "invalid_body");
});

test("POST /html-export: mixed valid + nonexistent id → zip produced + manifest shows missing id", async () => {
  const doc = await seedHtmlDoc("zip-mixed-exist");
  const ghostId = 999_999_000 + Math.floor(Math.random() * 999);
  const ids = [doc.id, ghostId];

  const { capturedNames, restore } = patchAppendSpy();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/clauded-docs/html-export",
      payload: { ids },
    });
    // 유효 id 포함 → zip 생성 (전체 abort 금지).
    assert.strictEqual(res.statusCode, 200, `expected 200 even with missing id, got ${res.statusCode}`);
    assert.ok(
      res.headers["content-type"]?.toString().startsWith("application/zip"),
      `content-type application/zip: ${res.headers["content-type"]}`,
    );

    // 유효 id 1개 → .html 1개 + _manifest.json (ghost id 는 .html 없음).
    const htmlEntries = capturedNames.filter((n) => n.endsWith(".html"));
    assert.strictEqual(htmlEntries.length, 1, `only 1 valid id → 1 .html entry, got: ${JSON.stringify(capturedNames)}`);
    assert.ok(capturedNames.includes("_manifest.json"), "_manifest.json must be present");

    // _manifest.json body 검증 — app.inject buffers the stream so we can parse.
    // _manifest.json 은 zip 스트림 안에 있어서 직접 파싱 불가 (unzip dep 없음).
    // 대신 _manifest.json append 에 전달된 string source 를 spy 로 캡처해서 검증.
  } finally {
    restore();
  }
});

test("POST /html-export: manifest spy captures _manifest.json content with included:false + reason for missing id", async () => {
  const doc = await seedHtmlDoc("zip-manifest-check");
  const ghostId = 999_998_000 + Math.floor(Math.random() * 999);
  const ids = [doc.id, ghostId];

  // _manifest.json append source 도 캡처하는 확장 spy.
  const appendedSources: Array<{ name: string; source: unknown }> = [];
  const ZipClass = (archiverNs as unknown as { ZipArchive: new (...args: unknown[]) => { append: (...args: unknown[]) => unknown } }).ZipArchive;
  const originalAppend = ZipClass.prototype.append as (...args: unknown[]) => unknown;
  ZipClass.prototype.append = function extSpy(source: unknown, data?: { name?: string }, ...rest: unknown[]): unknown {
    if (typeof data?.name === "string") {
      appendedSources.push({ name: data.name, source });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    return originalAppend.call(this, source, data, ...rest);
  };

  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/clauded-docs/html-export",
      payload: { ids },
    });
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}`);

    const manifestAppend = appendedSources.find((e) => e.name === "_manifest.json");
    assert.ok(manifestAppend !== undefined, "_manifest.json was appended");

    const manifestText = typeof manifestAppend.source === "string"
      ? manifestAppend.source
      : Buffer.isBuffer(manifestAppend.source)
        ? (manifestAppend.source as Buffer).toString("utf8")
        : JSON.stringify(manifestAppend.source);

    const manifest = JSON.parse(manifestText) as Array<{ id: number; included: boolean; reason?: string }>;
    const validEntry = manifest.find((e) => e.id === doc.id);
    const missingEntry = manifest.find((e) => e.id === ghostId);

    assert.ok(validEntry !== undefined, `manifest must include valid doc id ${doc.id}`);
    assert.strictEqual(validEntry?.included, true, "valid id: included=true");

    assert.ok(missingEntry !== undefined, `manifest must include ghost id ${ghostId}`);
    assert.strictEqual(missingEntry?.included, false, "missing id: included=false");
    assert.ok(
      typeof missingEntry?.reason === "string" && missingEntry.reason.length > 0,
      `missing id must have a non-empty reason, got: ${String(missingEntry?.reason)}`,
    );
  } finally {
    ZipClass.prototype.append = originalAppend;
  }
});

test("POST /html-export: mixed HTML + non-HTML (참조 md) → both present in zip", async () => {
  const htmlDoc = await seedHtmlDoc("zip-mixed-html");
  const mdDoc = await seedPlainDoc("zip-mixed-plain");
  const ids = [htmlDoc.id, mdDoc.id];

  const { capturedNames, restore } = patchAppendSpy();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/clauded-docs/html-export",
      payload: { ids },
    });
    assert.strictEqual(res.statusCode, 200, `expected 200, got ${res.statusCode}`);

    // 두 id 모두 .html entry 로 포함 (non-HTML 은 shell-wrap — browser 불필요).
    const htmlEntries = capturedNames.filter((n) => n.endsWith(".html"));
    assert.strictEqual(
      htmlEntries.length,
      2,
      `both HTML and non-HTML docs must produce .html entries (non-HTML shell-wrapped), got: ${JSON.stringify(capturedNames)}`,
    );
    assert.ok(capturedNames.includes("_manifest.json"), "_manifest.json present");
  } finally {
    restore();
  }
});

test("POST /html-export: 전건 not_found → 404 export_failed JSON envelope (doc 없는 200 zip 금지)", async () => {
  const ghostA = 999_997_000 + Math.floor(Math.random() * 999);
  const ghostB = ghostA + 10_000;

  const res = await app.inject({
    method: "POST",
    url: "/api/clauded-docs/html-export",
    payload: { ids: [ghostA, ghostB] },
  });
  assert.strictEqual(res.statusCode, 404, `expected 404, got ${res.statusCode}: ${res.payload.slice(0, 200)}`);
  const ct = res.headers["content-type"]?.toString() ?? "";
  assert.ok(ct.startsWith("application/json"), `zip 이 아닌 JSON envelope 이어야 함: ${ct}`);
  const body = res.json() as {
    error: string;
    reason: string;
    requested: number;
    manifest: Array<{ id: number; included: boolean; reason?: string }>;
  };
  assert.strictEqual(body.error, "export_failed");
  assert.strictEqual(body.requested, 2);
  assert.strictEqual(body.manifest.length, 2);
  assert.ok(
    body.manifest.every((e) => e.included === false && e.reason === "not_found"),
    `전 entry included:false + reason not_found: ${JSON.stringify(body.manifest)}`,
  );
});

test("POST /html-export: 전건 read 실패 → 503 export_failed (launch 실패와 동일한 zero-includable 분기)", async () => {
  const doc = await seedHtmlDoc("zip-zero-read-fail");
  // 저장 파일 제거 → read 단계 전건 실패 재현. browser launch 실패(바이너리 드리프트)와
  // 같은 zero-includable 503 분기를 browser 모킹 없이 커버.
  const prisma = getPrisma();
  const rows = await prisma.$queryRaw<Array<{ html_path: string }>>`
    SELECT html_path FROM monitor.documents WHERE id = ${BigInt(doc.id)}
  `;
  assert.strictEqual(rows.length, 1, `seeded doc ${doc.id} row must exist`);
  rmSync(rows[0].html_path);

  const res = await app.inject({
    method: "POST",
    url: "/api/clauded-docs/html-export",
    payload: { ids: [doc.id] },
  });
  assert.strictEqual(res.statusCode, 503, `expected 503, got ${res.statusCode}: ${res.payload.slice(0, 200)}`);
  const body = res.json() as {
    error: string;
    requested: number;
    manifest: Array<{ id: number; included: boolean; reason?: string }>;
  };
  assert.strictEqual(body.error, "export_failed");
  assert.strictEqual(body.requested, 1);
  assert.strictEqual(body.manifest[0]?.included, false);
  assert.ok(
    typeof body.manifest[0]?.reason === "string" && body.manifest[0].reason.startsWith("read:"),
    `read-stage reason 이어야 함: ${String(body.manifest[0]?.reason)}`,
  );
});

test("POST /html-export: R2 streaming idiom — Content-Type application/zip set before stream, status 200", async () => {
  const doc = await seedHtmlDoc("zip-streaming");

  const { capturedNames, restore } = patchAppendSpy();
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/clauded-docs/html-export",
      payload: { ids: [doc.id] },
    });
    // PREFERRED Fastify 5 idiom: reply.header() + reply.send(readable) →
    // content-type header set before finalize → app.inject returns 200 with headers.
    assert.strictEqual(res.statusCode, 200);
    const ct = res.headers["content-type"]?.toString() ?? "";
    assert.ok(ct.startsWith("application/zip"), `Content-Type: ${ct}`);
    const cd = res.headers["content-disposition"]?.toString() ?? "";
    assert.ok(cd.startsWith("attachment; filename="), `Content-Disposition: ${cd}`);
    // _manifest.json は always present regardless of per-doc outcomes.
    assert.ok(capturedNames.includes("_manifest.json"), "manifest always included");
  } finally {
    restore();
  }
});
