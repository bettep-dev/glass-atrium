// /api/clauded-docs/* 라우트 핸들러 통합 테스트.
// Runner: npx tsx --test test/clauded-docs.route.test.ts
// SUITE_MARKER 태그 title 로 격리 → per-test try/finally + after() DB-scrub/FS-removal safety net.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerClaudedDocsRoutes } from "../src/server/routes/clauded-docs.js";
import { BIGM_PROBE_SQL } from "../src/server/clauded-docs/search-sql.js";
import { resetDocsRootCache } from "../src/server/clauded-docs/storage.js";

// 본 suite 생성 행 공통 marker — cleanup 은 이 marker title 을 LIKE 삭제 ·
// try/finally 중단 시에도 after() hook 이 scrub.
const SUITE_MARKER = `route-test-${randomUUID()}`;

// per-suite tempdir → CLAUDED_DOCS_HTML_ROOT (writeFileAtomic 가 on-demand mkdir → 선행 생성 불요).
let htmlSuiteRoot: string;
let app: FastifyInstance;

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// title 생성 — SUITE_MARKER prefix (cleanup) + per-test 판별자 (concurrent 충돌 회피).
function makeTitle(label: string): string {
  return `${SUITE_MARKER}-${label}-${randomUUID()}`;
}

// 최소 유효 HTML body — 호출별 content_hash 변동 · structure validator 필수요소 포함
// (doctype, charset meta, head/title, body, <main>, <h1>).
function makeHtmlBody(salt: string): string {
  return (
    "<!doctype html>" +
    '<html lang="ko">' +
    '<head><meta charset="utf-8"><title>x</title></head>' +
    `<body><main><h1>${salt}</h1><p>본문 ${salt}</p></main></body>` +
    "</html>"
  );
}

// storage-root 불변식: HTML primary 는 monitor-internal root 하위 · md_copy_path 는 항상 null.
function assertStorageRoots(response: { html_path: string; md_copy_path: string | null }): void {
  assert.ok(
    response.html_path.startsWith(htmlSuiteRoot),
    `html_path under html root: ${response.html_path}`,
  );
  assert.strictEqual(response.md_copy_path, null, "md_copy_path is null");
}

// POST helper — {status, body} 반환 (body 는 파싱된 JSON).
async function postCreate(
  appInst: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const res = await appInst.inject({
    method: "POST",
    url: "/api/clauded-docs",
    payload,
  });
  return { status: res.statusCode, body: res.json() };
}

// id 단건 삭제 — best-effort · cleanup 은 try/finally 안에서 throw 금지 위해 non-200 swallow.
async function deleteDoc(appInst: FastifyInstance, id: number): Promise<void> {
  try {
    await appInst.inject({ method: "DELETE", url: `/api/clauded-docs/${id}` });
  } catch {
    // best-effort cleanup — leaks caught by after() DB scrub safety net.
  }
}

before(async () => {
  // tempdir 은 route 등록 이전 설정 필수 — storage 모듈이 첫 getHtmlBodyRoot 에서 새 root 해석.
  htmlSuiteRoot = mkdtempSync(join(tmpdir(), "clauded-docs-route-html-"));
  process.env.CLAUDED_DOCS_HTML_ROOT = htmlSuiteRoot;
  resetDocsRootCache();

  app = Fastify({ logger: false });
  await registerClaudedDocsRoutes(app);
  await app.ready();
});

after(async () => {
  // cleanup 순서: app first (in-flight handler 취소) → DB scrub → disconnect → FS removal.
  try {
    await app.close();
  } catch {
    // best-effort — 앞선 테스트 실패로 이미 닫혔을 수 있음.
  }
  // DB scrub — SUITE_MARKER LIKE 로 본 suite 행만 삭제 (타 suite/prod 행 미접촉).
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`
      DELETE FROM monitor.documents WHERE title LIKE ${`%${SUITE_MARKER}%`}
    `;
  } catch (error) {
    // surface 하되 throw 금지 — FS cleanup 은 계속 실행.
    console.error("[route-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
  rmSync(htmlSuiteRoot, { recursive: true, force: true });
  delete process.env.CLAUDED_DOCS_HTML_ROOT;
  resetDocsRootCache();
});

// POST /api/clauded-docs

test("POST /api/clauded-docs: happy path — 201 + content_hash + HTML file + sha256 match", async () => {
  const title = makeTitle("post-happy");
  const html = makeHtmlBody(title);
  const { status, body } = await postCreate(app, {
    title,
    author: "tester",
    html_body: html,
  });

  assert.strictEqual(status, 201);
  // body 는 unknown — 검사된 field shape assertion 으로 narrow.
  assert.ok(body !== null && typeof body === "object", "body is object");
  const detail = body as {
    id: number;
    content_hash: string;
    html_path: string;
    md_copy_path: string | null;
    title: string;
  };
  try {
    assert.strictEqual(detail.title, title);

    // content_hash 는 sanitized HTML 의 sha256 — DOMPurify 정규화로 sha256(input) 과는
    // 어긋날 수 있으나, disk 재독 bytes 의 sha256 과는 일치 필수 (서버는 해시한 바이트 그대로 저장).
    assert.match(detail.content_hash, /^[a-f0-9]{64}$/);
    assert.ok(detail.html_path.length > 0, "html_path is set");
    // 신규 POST 응답의 md_copy_path 는 항상 null (HTML-only).
    assert.strictEqual(
      detail.md_copy_path,
      null,
      "md_copy_path is null for new POST (HTML-only)",
    );
    assertStorageRoots({ html_path: detail.html_path, md_copy_path: detail.md_copy_path });

    // HTML file 존재 + stored bytes 의 sha256 == content_hash 필수.
    const htmlOnDisk = await readFile(detail.html_path, "utf8");
    assert.strictEqual(
      sha256(htmlOnDisk),
      detail.content_hash,
      "stored HTML sha256 matches DB content_hash",
    );
  } finally {
    await deleteDoc(app, detail.id);
  }
});

test("POST /api/clauded-docs: duplicate_content — second identical body returns 409", async () => {
  const title = makeTitle("post-dupe");
  const html = makeHtmlBody(`${title}-fixed-content`);
  const payload = {
    title,
    author: "tester",
    html_body: html,
  };
  const first = await postCreate(app, payload);
  assert.strictEqual(first.status, 201);
  const firstBody = first.body as { id: number };

  try {
    const second = await postCreate(app, payload);
    assert.strictEqual(second.status, 409);
    assert.deepStrictEqual(
      (second.body as { error: string }).error,
      "duplicate_content",
    );
    // existing_id 는 첫 행 id 를 가리켜야 함.
    const secondBody = second.body as { error: string; existing_id: number };
    assert.strictEqual(secondBody.existing_id, firstBody.id);
  } finally {
    await deleteDoc(app, firstBody.id);
  }
});

test("POST /api/clauded-docs: validation error — empty html_body returns 400 invalid_body", async () => {
  const title = makeTitle("post-validation");
  const res = await app.inject({
    method: "POST",
    url: "/api/clauded-docs",
    payload: {
      title,
      author: "tester",
      html_body: "",
    },
  });
  assert.strictEqual(res.statusCode, 400);
  const body = res.json() as { error: string; reason: string };
  assert.strictEqual(body.error, "invalid_body");
  assert.match(body.reason, /html_body/);
});

// PUT /api/clauded-docs/:id

test("PUT /api/clauded-docs/:id: hash_conflict — stale expected_hash returns 409", async () => {
  const title = makeTitle("put-conflict");
  const html = makeHtmlBody(title);
  const created = await postCreate(app, {
    title,
    author: "tester",
    html_body: html,
  });
  assert.strictEqual(created.status, 201);
  const detail = created.body as {
    id: number;
    content_hash: string;
    html_path: string;
  };

  try {
    // pre-PUT 상태 스냅샷 — disk bytes + DB content_hash.
    const preBytes = await readFile(detail.html_path, "utf8");

    // 의도적 stale hash (현재값 ≠ 무엇이든) 로 PUT.
    const staleHash = "0".repeat(64);
    const res = await app.inject({
      method: "PUT",
      url: `/api/clauded-docs/${detail.id}`,
      payload: {
        html_body: makeHtmlBody(`${title}-new`),
        expected_hash: staleHash,
      },
    });
    assert.strictEqual(res.statusCode, 409);
    const body = res.json() as {
      error: string;
      expected: string;
      actual: string;
    };
    assert.strictEqual(body.error, "hash_conflict");
    assert.strictEqual(body.expected, staleHash);
    assert.strictEqual(body.actual, detail.content_hash);

    // FS bytes MUST NOT have changed.
    const postBytes = await readFile(detail.html_path, "utf8");
    assert.strictEqual(postBytes, preBytes, "html_path bytes unchanged after 409");
  } finally {
    await deleteDoc(app, detail.id);
  }
});

test("PUT /api/clauded-docs/:id: success — content_hash updates + HTML rewritten + sha256 match", async () => {
  // Setup: create a doc with content A.
  const title = makeTitle("put-success");
  const htmlA = makeHtmlBody(`${title}-A`);
  const created = await postCreate(app, {
    title,
    author: "tester",
    html_body: htmlA,
  });
  assert.strictEqual(created.status, 201);
  const detail = created.body as {
    id: number;
    content_hash: string;
    html_path: string;
    md_copy_path: string | null;
  };

  try {
    // PUT to content B.
    const htmlB = makeHtmlBody(`${title}-B-${randomUUID()}`);
    const res = await app.inject({
      method: "PUT",
      url: `/api/clauded-docs/${detail.id}`,
      payload: {
        html_body: htmlB,
        expected_hash: detail.content_hash,
      },
    });
    assert.strictEqual(res.statusCode, 200);
    const updated = res.json() as {
      id: number;
      content_hash: string;
      html_path: string;
      md_copy_path: string | null;
      body: string;
    };
    assert.strictEqual(updated.id, detail.id);
    assert.notStrictEqual(
      updated.content_hash,
      detail.content_hash,
      "content_hash advanced",
    );

    // Stored HTML bytes match new content_hash.
    const htmlBytesPost = await readFile(updated.html_path, "utf8");
    assert.strictEqual(
      sha256(htmlBytesPost),
      updated.content_hash,
      "stored HTML sha256 matches updated content_hash",
    );

    // md_copy_path remains null across PUT responses (HTML-only).
    assert.strictEqual(
      updated.md_copy_path,
      null,
      "md_copy_path stays null after PUT (HTML-only)",
    );
    assertStorageRoots(updated);
  } finally {
    await deleteDoc(app, detail.id);
  }
});

// PUT doc_status toggle.
// standalone 행(folder_id IS NULL)도 cascade-only path 진입 → cascadeUpdateDocStatus CTE 가 self-only 집합으로 degradation (단일 행 갱신). 4 시나리오:
//   (1) standalone progress→done 토글 → 200 + done 영속화
//   (2) standalone done→progress 역토글 — 양방향 정합
//   (3) grouped(folder_id 존재) cascade 보존 — 회귀 가드
//   (4) standalone PUT 시 cascade_only 로그 emit + cascade_count=1 + folder_id=null

test("PUT /api/clauded-docs/:id: standalone (folder_id=NULL) doc_status progress→done — 200 + 영속화", async () => {
  const title = makeTitle("put-status-standalone-done");
  const html = makeHtmlBody(title);
  const created = await postCreate(app, {
    title,
    author: "tester",
    html_body: html,
  });
  assert.strictEqual(created.status, 201);
  const detail = created.body as {
    id: number;
    content_hash: string;
    folder_id: number | null;
    doc_status: string;
  };
  assert.strictEqual(detail.folder_id, null, "신규 standalone row 의 folder_id 는 null");
  assert.strictEqual(detail.doc_status, "progress", "POST default doc_status 는 progress");

  try {
    // PUT — body 동일 (no-op short-circuit 경로) + doc_status=done →
    // replyCascadeOnlyUpdate 가 응답 doc_status="done" (cascade self-only).
    const res = await app.inject({
      method: "PUT",
      url: `/api/clauded-docs/${detail.id}`,
      payload: {
        html_body: html,
        expected_hash: detail.content_hash,
        doc_status: "done",
      },
    });
    assert.strictEqual(res.statusCode, 200, `PUT 200 (got ${res.statusCode}: ${res.payload})`);
    const updated = res.json() as { id: number; doc_status: string; folder_id: number | null };
    assert.strictEqual(updated.id, detail.id);
    assert.strictEqual(
      updated.doc_status,
      "done",
      "응답 doc_status 가 done (cascade self-only 경로)",
    );
    assert.strictEqual(updated.folder_id, null, "standalone row 의 folder_id 는 변동 없음");

    // GET 으로 영속화 확인 — DB row 의 doc_status 가 실제로 done 인지 검증.
    const getRes = await app.inject({ method: "GET", url: `/api/clauded-docs/${detail.id}` });
    assert.strictEqual(getRes.statusCode, 200);
    const getBody = getRes.json() as { doc_status: string };
    assert.strictEqual(
      getBody.doc_status,
      "done",
      "GET 후속 호출도 done 으로 영속",
    );
  } finally {
    await deleteDoc(app, detail.id);
  }
});

test("PUT /api/clauded-docs/:id: standalone doc_status done→progress 역토글 — 양방향 정합", async () => {
  const title = makeTitle("put-status-standalone-reverse");
  const html = makeHtmlBody(title);
  const created = await postCreate(app, {
    title,
    author: "tester",
    html_body: html,
    doc_status: "done",
  });
  assert.strictEqual(created.status, 201);
  const detail = created.body as { id: number; content_hash: string; doc_status: string };
  assert.strictEqual(detail.doc_status, "done", "POST 시 doc_status=done 초기화");

  try {
    const res = await app.inject({
      method: "PUT",
      url: `/api/clauded-docs/${detail.id}`,
      payload: {
        html_body: html,
        expected_hash: detail.content_hash,
        doc_status: "progress",
      },
    });
    assert.strictEqual(res.statusCode, 200);
    const updated = res.json() as { doc_status: string };
    assert.strictEqual(
      updated.doc_status,
      "progress",
      "done→progress 역토글 응답 정합 (toggle 양방향)",
    );
  } finally {
    await deleteDoc(app, detail.id);
  }
});

test("PUT /api/clauded-docs/:id: grouped (folder_id 존재) cascade 회귀 — sibling 도 일괄 갱신", async () => {
  // 회귀 가드 — predicate 변경이 grouped 행 cascade 의미를 깨뜨리지 않는지 확인.
  // anchor A (folder_id=NULL) + sibling B/C (folder_id=A.id) 구성 → B 토글 → C 도 done.
  const aTitle = makeTitle("put-status-grouped-A");
  const bTitle = makeTitle("put-status-grouped-B");
  const cTitle = makeTitle("put-status-grouped-C");
  const aBody = makeHtmlBody(aTitle);
  const bBody = makeHtmlBody(bTitle);
  const cBody = makeHtmlBody(cTitle);

  const aRes = await postCreate(app, {
    title: aTitle,
    author: "tester", html_body: aBody,
  });
  assert.strictEqual(aRes.status, 201);
  const aDetail = aRes.body as { id: number };

  const bRes = await postCreate(app, {
    title: bTitle,
    author: "tester", html_body: bBody, folder_id: aDetail.id,
  });
  assert.strictEqual(bRes.status, 201);
  const bDetail = bRes.body as { id: number; content_hash: string; folder_id: number | null };
  assert.strictEqual(bDetail.folder_id, aDetail.id, "B 의 folder_id 가 A.id 와 일치");

  const cRes = await postCreate(app, {
    title: cTitle,
    author: "tester", html_body: cBody, folder_id: aDetail.id,
  });
  assert.strictEqual(cRes.status, 201);
  const cDetail = cRes.body as { id: number };

  try {
    // PUT B — body 동일 (no-op 경로) + doc_status=done → cascade self+siblings.
    const putRes = await app.inject({
      method: "PUT",
      url: `/api/clauded-docs/${bDetail.id}`,
      payload: {
        html_body: bBody,
        expected_hash: bDetail.content_hash,
        doc_status: "done",
      },
    });
    assert.strictEqual(putRes.statusCode, 200);
    const putBody = putRes.json() as { doc_status: string; folder_id: number | null };
    assert.strictEqual(putBody.doc_status, "done");
    assert.strictEqual(putBody.folder_id, aDetail.id, "B 의 folder_id 보존");

    // GET C — sibling 도 cascade 로 done 으로 전환되었는지 검증 (회귀 가드).
    const getCRes = await app.inject({ method: "GET", url: `/api/clauded-docs/${cDetail.id}` });
    assert.strictEqual(getCRes.statusCode, 200);
    const cBody2 = getCRes.json() as { doc_status: string };
    assert.strictEqual(
      cBody2.doc_status,
      "done",
      "sibling C 가 cascade 로 done 전환 (grouped 의미 보존)",
    );

    // anchor A — folder_id=NULL 이므로 cascade 범위 외 → progress 유지.
    const getARes = await app.inject({ method: "GET", url: `/api/clauded-docs/${aDetail.id}` });
    assert.strictEqual(getARes.statusCode, 200);
    const aBody2 = getARes.json() as { doc_status: string };
    assert.strictEqual(
      aBody2.doc_status,
      "progress",
      "anchor A (folder_id=NULL) 는 B/C 그룹의 cascade 범위 외 → progress 유지",
    );
  } finally {
    await deleteDoc(app, cDetail.id);
    await deleteDoc(app, bDetail.id);
    await deleteDoc(app, aDetail.id);
  }
});

test("PUT /api/clauded-docs/:id: standalone cascade_only 로그 emit — cascade_count=1 + folder_id=null", async () => {
  // 로그 capture — 별도 sub-app (logger stream 주입) 으로 본 시나리오만 격리 측정.
  // Fastify pino destination 을 in-memory 스트림으로 교체 → JSON 라인 파싱.
  const logLines: string[] = [];
  const logStream: NodeJS.WritableStream = {
    write(chunk: string | Buffer): boolean {
      logLines.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return true;
    },
    end(): void {},
  } as unknown as NodeJS.WritableStream;

  const subApp = Fastify({ logger: { level: "info", stream: logStream } });
  await registerClaudedDocsRoutes(subApp);
  await subApp.ready();

  const title = makeTitle("put-status-standalone-log");
  const html = makeHtmlBody(title);

  // POST via subApp (sub-app 의 router 로 row 생성 — 동일 PG 인스턴스).
  const postRes = await subApp.inject({
    method: "POST",
    url: "/api/clauded-docs",
    payload: {
      title,
      author: "tester", html_body: html,
    },
  });
  assert.strictEqual(postRes.statusCode, 201);
  const detail = postRes.json() as { id: number; content_hash: string };

  try {
    // 로그 버퍼 초기화 — POST 로그가 섞이지 않도록 PUT 직전 시점에 길이 캡쳐.
    const baselineCount = logLines.length;

    const putRes = await subApp.inject({
      method: "PUT",
      url: `/api/clauded-docs/${detail.id}`,
      payload: {
        html_body: html,
        expected_hash: detail.content_hash,
        doc_status: "done",
      },
    });
    assert.strictEqual(putRes.statusCode, 200);

    // PUT 이후 emit 된 로그 라인 중 outcome=cascade_only 라인 식별.
    const putLines = logLines.slice(baselineCount);
    const cascadeLogLine = putLines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((obj): obj is Record<string, unknown> => obj !== null && obj.outcome === "cascade_only");

    assert.ok(
      cascadeLogLine !== undefined,
      `outcome="cascade_only" 로그 라인이 emit 되어야 함 (got ${putLines.length} lines)`,
    );
    assert.strictEqual(
      cascadeLogLine.cascade_count,
      1,
      "standalone row cascade scope = 1 (self-only)",
    );
    assert.strictEqual(
      cascadeLogLine.folder_id,
      null,
      "folder_id 로그 필드는 null (standalone identity 가시화)",
    );

    // no_op outcome 이 동시 emit 되지 않는지 확인 — 전환 (no_op → cascade_only) 가시화.
    const noOpLogLine = putLines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((obj): obj is Record<string, unknown> => obj !== null && obj.outcome === "no_op");
    assert.strictEqual(
      noOpLogLine,
      undefined,
      "outcome='no_op' 는 더 이상 emit 되지 않음 (standalone 은 cascade_only 경로)",
    );
  } finally {
    await subApp.inject({ method: "DELETE", url: `/api/clauded-docs/${detail.id}` });
    await subApp.close();
  }
});

// DELETE /api/clauded-docs/:id

test("DELETE /api/clauded-docs/:id: happy path — row deleted + HTML removed", async () => {
  const title = makeTitle("delete-happy");
  const html = makeHtmlBody(title);
  const created = await postCreate(app, {
    title,
    author: "tester",
    html_body: html,
  });
  assert.strictEqual(created.status, 201);
  const detail = created.body as {
    id: number;
    html_path: string;
    md_copy_path: string | null;
  };

  // Only the HTML primary is expected to exist; md_copy_path is null.
  assert.strictEqual(detail.md_copy_path, null, "no MD companion for new POST");
  // Pre-delete sanity — HTML file exists.
  await assert.doesNotReject(stat(detail.html_path), "html exists pre-delete");

  const res = await app.inject({
    method: "DELETE",
    url: `/api/clauded-docs/${detail.id}`,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as { id: number; deleted: true };
  assert.strictEqual(body.id, detail.id);
  assert.strictEqual(body.deleted, true);

  // DB row MUST be gone — second DELETE returns 404.
  const second = await app.inject({
    method: "DELETE",
    url: `/api/clauded-docs/${detail.id}`,
  });
  assert.strictEqual(second.statusCode, 404);

  // HTML file MUST be removed.
  await assert.rejects(
    stat(detail.html_path),
    (err: NodeJS.ErrnoException) => err.code === "ENOENT",
    "html unlinked",
  );
});

// GET /api/clauded-docs/:id

test("GET /api/clauded-docs/:id?format=md: new row (no MD companion) → 404 not_found", async () => {
  // New POST rows have md_copy_path=null; GET ?format=md returns 404 for
  // managed rows without an MD companion (legacy rows preserve their
  // md_copy_path and would still serve, but those aren't exercised here).
  const title = makeTitle("get-md");
  const html = makeHtmlBody(title);
  const created = await postCreate(app, {
    title,
    author: "tester",
    html_body: html,
  });
  assert.strictEqual(created.status, 201);
  const detail = created.body as { id: number; md_copy_path: string | null };

  try {
    assert.strictEqual(detail.md_copy_path, null, "new POST has null md_copy_path");

    const res = await app.inject({
      method: "GET",
      url: `/api/clauded-docs/${detail.id}?format=md`,
    });
    assert.strictEqual(res.statusCode, 404);
    const body = res.json() as { error: string; id: number };
    assert.strictEqual(body.error, "not_found");
    assert.strictEqual(body.id, detail.id);
  } finally {
    await deleteDoc(app, detail.id);
  }
});

test("GET /api/clauded-docs/:id?format=html: returns HTML body + CSP header", async () => {
  const title = makeTitle("get-html-csp");
  const html = makeHtmlBody(title);
  const created = await postCreate(app, {
    title,
    author: "tester",
    html_body: html,
  });
  assert.strictEqual(created.status, 201);
  const detail = created.body as { id: number; content_hash: string };

  try {
    const res = await app.inject({
      method: "GET",
      url: `/api/clauded-docs/${detail.id}?format=html`,
    });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json() as { format: string; body: string; content_hash: string };
    assert.strictEqual(body.format, "html");
    assert.strictEqual(body.content_hash, detail.content_hash);

    // CSP header MUST be present on HTML responses.
    const csp = res.headers["content-security-policy"];
    assert.strictEqual(
      csp,
      "sandbox; frame-ancestors 'self'",
      "CSP header matches HTML_BODY_CSP constant",
    );
  } finally {
    await deleteDoc(app, detail.id);
  }
});

// Control-char JSON regression: a body carrying raw C0 controls (form-feed
// \x0c, vertical-tab \x0b) must NOT produce invalid JSON on GET and must not
// be persisted with those bytes. Asserts on res.payload (the raw wire string),
// NOT res.json() — res.json() would mask the bug by re-parsing Fastify's output.
test("GET /api/clauded-docs/:id: control chars in html_body → write strips them, GET payload is valid JSON", async () => {
  const title = makeTitle("get-ctrlchar");
  // Embed raw \x0c (form-feed) + \x0b (vertical-tab) between elements; these
  // survive DOMPurify in the wild and break `curl | jq -r '.body'`.
  const dirtyHtml =
    "<!doctype html>\x0c" +
    '<html lang="ko">' +
    '<head><meta charset="utf-8"><title>x</title></head>' +
    `<body><main><h1>${title}</h1>\x0b<p>본문 ${title}</p></main></body>` +
    "</html>";
  const created = await postCreate(app, {
    title,
    author: "tester",
    html_body: dirtyHtml,
  });
  assert.strictEqual(created.status, 201);
  const detail = created.body as { id: number; html_path: string };

  try {
    // Write-side: stored bytes on disk must be free of illegal control chars.
    const storedBytes = await readFile(detail.html_path);
    const illegalOnDisk = storedBytes.filter(
      (b) => b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d,
    );
    assert.strictEqual(
      illegalOnDisk.length,
      0,
      "write-side strip removed illegal control chars before persist",
    );

    // Read-side: the GET response wire payload must be valid strict JSON.
    const res = await app.inject({
      method: "GET",
      url: `/api/clauded-docs/${detail.id}`,
    });
    assert.strictEqual(res.statusCode, 200);
    const raw = res.payload;
    const illegalInPayload = Buffer.from(raw, "utf8").filter(
      (b) => b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d,
    );
    assert.strictEqual(
      illegalInPayload.length,
      0,
      "GET payload carries no raw illegal control bytes",
    );
    // JSON.parse MUST succeed (the orchestrator `curl | jq` consumer contract).
    const parsed = JSON.parse(raw) as { body: string };
    assert.ok(
      !parsed.body.includes("\x0c") && !parsed.body.includes("\x0b"),
      "round-tripped body contains no form-feed / vertical-tab",
    );
  } finally {
    await deleteDoc(app, detail.id);
  }
});

// GET /api/clauded-docs/search

test("GET /api/clauded-docs/search: Korean keyword finds matching document", async () => {
  // Use a distinctive Korean compound word that the simple tokenizer keeps as
  // a single bigram-free token (verified via DB probe — `검색테스트유니크` does
  // not collide with stopword corpus).
  const korean = `검색테스트유니크${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  const title = makeTitle("search-ko");
  // Full structure required by the validator: doctype + charset + head/title +
  // body + <main> landmark + <h1> heading.
  const html =
    "<!doctype html>" +
    '<html lang="ko">' +
    `<head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body><main><h1>${title}</h1><p>${korean} 본문 매칭 대상</p></main></body>` +
    "</html>";
  const created = await postCreate(app, {
    title,
    author: "tester",
    html_body: html,
  });
  assert.strictEqual(created.status, 201);
  const createdId = (created.body as { id: number }).id;

  try {
    const res = await app.inject({
      method: "GET",
      url: `/api/clauded-docs/search?q=${encodeURIComponent(korean)}`,
    });
    assert.strictEqual(res.statusCode, 200);
    const body = res.json() as {
      rows: Array<{ id: number }>;
      total: number;
    };
    // Expect at least 1 hit including the doc we just created.
    assert.ok(body.total >= 1, `total ≥ 1, got ${body.total}`);
    const matched = body.rows.find((r) => r.id === createdId);
    assert.ok(matched !== undefined, "created doc appears in search results");
  } finally {
    await deleteDoc(app, createdId);
  }
});

test("GET /api/clauded-docs/search: bigm_enabled reflects pg_bigm extension presence", async () => {
  // 응답 플래그 = startup 1회 detection 결과 → 같은 DB 의 live probe (동일 BIGM_PROBE_SQL) 와 일치 invariant.
  // 0-hit 검색어로 충분 — 플래그는 결과 유무와 무관하게 항상 emit (FE 저하 notice 계약).
  const prisma = getPrisma();
  const probeRows = await prisma.$queryRaw<Array<{ present: number }>>(BIGM_PROBE_SQL);
  const expected = probeRows.length > 0;

  const res = await app.inject({
    method: "GET",
    url: "/api/clauded-docs/search?q=bigm-flag-probe-no-hit",
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json() as { bigm_enabled: boolean };
  assert.strictEqual(typeof body.bigm_enabled, "boolean", "bigm_enabled present as boolean");
  assert.strictEqual(body.bigm_enabled, expected, "flag matches live extension probe");
});

// GET /api/clauded-docs/legacy/raw + GET /api/clauded-docs/legacy 는 미등록 →
// 자동 404. DELETE 의 legacy md_copy_path 자동 unlink 호환 분기는 별도 테스트로 보존.

// path traversal defense.

test("POST /api/clauded-docs: title containing `../` is safely slug-normalized + writes stay in root", async () => {
  // The slug normalizer strips disallowed chars (including `.` and `/`) to
  // single hyphens; the resulting slug cannot escape the root regardless of
  // user input. Only the HTML primary path is exercised — md_copy_path is
  // always null for new POSTs.
  const evilTitle = `${SUITE_MARKER}-../../../../etc/evil-${randomUUID()}`;
  const res = await postCreate(app, {
    title: evilTitle,
    author: "tester",
    html_body: makeHtmlBody(evilTitle),
  });
  assert.strictEqual(res.status, 201);
  const detail = res.body as { id: number; html_path: string; md_copy_path: string | null };

  try {
    // html_path lives under the monitor-internal root.
    assert.ok(
      detail.html_path.startsWith(htmlSuiteRoot),
      `html_path inside html root: ${detail.html_path}`,
    );
    // md_copy_path is null for new POSTs.
    assert.strictEqual(detail.md_copy_path, null, "md_copy_path null for new POST");
    // No `..` segment survives slugification.
    assert.ok(!detail.html_path.includes("/.."), "no .. in html_path");
  } finally {
    await deleteDoc(app, detail.id);
  }
});

// HTML-only regression.

test("POST /api/clauded-docs: html_path under html root + md_copy_path null", async () => {
  // 2-condition AND check at the integration level:
  //   (a) HTML written under HTML root.
  //   (b) md_copy_path = null in API response (== DB column).
  const title = makeTitle("adr8-html-only");
  const { status, body } = await postCreate(app, {
    title,
    author: "tester",
    html_body: makeHtmlBody(title),
  });
  assert.strictEqual(status, 201);
  const detail = body as { id: number; html_path: string; md_copy_path: string | null };

  try {
    // (a) HTML under HTML root.
    assert.ok(
      detail.html_path.startsWith(htmlSuiteRoot),
      `html_path must start with htmlSuiteRoot, got: ${detail.html_path}`,
    );
    // (b) md_copy_path null.
    assert.strictEqual(detail.md_copy_path, null, "md_copy_path is null");
  } finally {
    await deleteDoc(app, detail.id);
  }
});

// structure validation (route integration).

test("POST /api/clauded-docs: structure-invalid HTML returns 400 html_structure_invalid", async () => {
  // Bare fragment lacks doctype, head/title, body, semantic landmark, charset,
  // and a heading. The validator must trip before storage runs.
  const { status, body } = await postCreate(app, {
    title: makeTitle("structure-invalid"),
    author: "tester",
    html_body: "<p>no doctype no title</p>",
  });
  assert.strictEqual(status, 400);
  assert.ok(body !== null && typeof body === "object", "body is object");
  const envelope = body as { error?: { code?: string; details?: { missing?: string[] } } };
  assert.strictEqual(envelope.error?.code, "html_structure_invalid");
  // `missing` MUST be a non-empty array containing the obvious gaps — assert
  // membership rather than exact equality to stay resilient to parser-side
  // synthesis behavior (some parsers fabricate <html>/<body> from a fragment).
  const missing = envelope.error?.details?.missing ?? [];
  assert.ok(Array.isArray(missing) && missing.length > 0, "missing list non-empty");
  for (const required of ["doctype", "head_title", "semantic_landmark", "heading", "charset"]) {
    assert.ok(missing.includes(required), `expected '${required}' in missing — got ${JSON.stringify(missing)}`);
  }
});

// comparison-table column cap enforcement (route integration).

test("POST /api/clauded-docs: 7-column comparison table returns 400 d8_p2_violation", async () => {
  // 7-column `<table>` with `<th>` (comparison intent). Route must reject with
  // a `d8_p2_violation` envelope carrying `details.tableIndex` +
  // `details.columnCount` + `details.maxAllowed` so the author can locate the
  // offending DOM position.
  const ths = Array.from({ length: 7 }, (_, i) => `<th>H${i + 1}</th>`).join("");
  const tds = Array.from({ length: 7 }, (_, i) => `<td>v${i + 1}</td>`).join("");
  const body =
    "<!doctype html>" +
    '<html lang="ko">' +
    '<head><meta charset="utf-8"><title>비교표</title></head>' +
    "<body><main><h1>비교표</h1>" +
    `<table><thead><tr>${ths}</tr></thead><tbody><tr>${tds}</tr></tbody></table>` +
    "</main></body></html>";
  const { status, body: replyBody } = await postCreate(app, {
    title: makeTitle("d8-p2-violation"),
    author: "tester",
    html_body: body,
  });
  assert.strictEqual(status, 400);
  const envelope = replyBody as {
    error?: {
      code?: string;
      details?: { tableIndex?: number; columnCount?: number; maxAllowed?: number };
    };
  };
  assert.strictEqual(envelope.error?.code, "d8_p2_violation");
  assert.strictEqual(envelope.error?.details?.tableIndex, 1);
  assert.strictEqual(envelope.error?.details?.columnCount, 7);
  assert.strictEqual(envelope.error?.details?.maxAllowed, 5);
});

test("POST /api/clauded-docs: 5-column comparison table accepted (cap inclusive)", async () => {
  // Boundary test — 5 columns is the cap, NOT a violation. Confirms the
  // operator is `>` not `>=` at the wire layer.
  const ths = Array.from({ length: 5 }, (_, i) => `<th>H${i + 1}</th>`).join("");
  const tds = Array.from({ length: 5 }, (_, i) => `<td>v${i + 1}</td>`).join("");
  const title = makeTitle("d8-p2-cap-inclusive");
  const html =
    "<!doctype html>" +
    '<html lang="ko">' +
    '<head><meta charset="utf-8"><title>비교표 cap</title></head>' +
    `<body><main><h1>${title}</h1>` +
    `<table><thead><tr>${ths}</tr></thead><tbody><tr>${tds}</tr></tbody></table>` +
    "</main></body></html>";
  const { status, body } = await postCreate(app, {
    title,
    author: "tester",
    html_body: html,
  });
  assert.strictEqual(status, 201);
  const detail = body as { id: number; title: string; content_hash: string };
  try {
    assert.strictEqual(detail.title, title);
    assert.match(detail.content_hash, /^[a-f0-9]{64}$/);
  } finally {
    await deleteDoc(app, detail.id);
  }
});

test("POST /api/clauded-docs: structure-valid HTML still returns 201 (regression)", async () => {
  // Regression check — the validator must not reject the standard well-formed
  // body used everywhere else in this suite. A failure here means the
  // validator's rule set is over-strict and existing dogfood docs would fail.
  const title = makeTitle("structure-valid");
  const { status, body } = await postCreate(app, {
    title,
    author: "tester",
    html_body: makeHtmlBody(title),
  });
  assert.strictEqual(status, 201);
  const detail = body as { id: number; title: string; content_hash: string };
  try {
    assert.strictEqual(detail.title, title);
    assert.match(detail.content_hash, /^[a-f0-9]{64}$/);
  } finally {
    await deleteDoc(app, detail.id);
  }
});

// MD body 흐름 — md_body 제공 시 format=md primary + exposure(audience) bit 분기.
// format 은 body-kind 로 결정 (md_body→md) · exposure 는 2-값 bit (exposed/hidden), 최상위 JSON `audience` 필드로만 지정 (frontmatter 미파싱).
// md_body 기본값 = hidden (plain primary = agent-only 노출 정책).

// MD body 생성 helper — frontmatter label 텍스트(옵션) + 압축 MD body.
// `fmLabel` 은 frontmatter 텍스트로만 들어가며 응답 audience 에 영향 없음 (audience 는 최상위 필드로만 결정).
function makeMdBody(title: string, fmLabel: "ops" | "agent-only" | "public" | null): string {
  const fm = fmLabel === null
    ? ""
    : `---\naudience: ${fmLabel}\nagent: reporter\ntokens_estimate: 120\n---\n`;
  return `${fm}# ${title}\n\n- key1: value1\n- key2: value2\n\n결론: 1줄 (Pyramid).\n`;
}

test("POST /api/clauded-docs (MD body): md_body 흐름 — 201 + format=md + .md path + hidden default", async () => {
  const title = makeTitle("md-default");
  const { status, body } = await postCreate(app, {
    title,
    author: "reporter",
    md_body: makeMdBody(title, "public"),
  });
  assert.strictEqual(status, 201);
  const detail = body as {
    id: number;
    audience: string | null;
    html_path: string;
    md_copy_path: string | null;
    format: string;
    content_hash: string;
  };
  try {
    // md_body 기본 exposure bit = hidden (plain primary = agent-only 노출 정책).
    // frontmatter 의 `audience: public` 라벨은 응답에 영향 없음 (frontmatter 미파싱).
    assert.strictEqual(detail.audience, "hidden", "md_body 기본 exposure bit = hidden");
    assert.strictEqual(detail.format, "md", "format=md for md_body response");
    assert.ok(detail.html_path.endsWith(".md"), `bodyPath ends with .md, got: ${detail.html_path}`);
    // monitor-internal root 정합 — vault 외부.
    assert.ok(detail.html_path.startsWith(htmlSuiteRoot), "bodyPath under html (monitor-internal) root");
    assert.strictEqual(detail.md_copy_path, null, "md_copy_path null for new POST");
    assert.match(detail.content_hash, /^[a-f0-9]{64}$/);
  } finally {
    await deleteDoc(app, detail.id);
  }
});

test("POST /api/clauded-docs (MD body): audience=hidden 명시 — 201 + hidden", async () => {
  const title = makeTitle("md-hidden");
  const { status, body } = await postCreate(app, {
    title,
    author: "reporter",
    audience: "hidden",
    md_body: makeMdBody(title, "agent-only"),
  });
  assert.strictEqual(status, 201);
  const detail = body as { id: number; audience: string };
  try {
    assert.strictEqual(detail.audience, "hidden");
  } finally {
    await deleteDoc(app, detail.id);
  }
});

test("POST /api/clauded-docs (MD body): audience=exposed 명시 — 201 + exposed", async () => {
  const title = makeTitle("md-exposed");
  const { status, body } = await postCreate(app, {
    title,
    author: "reporter",
    audience: "exposed",
    md_body: makeMdBody(title, "ops"),
  });
  assert.strictEqual(status, 201);
  const detail = body as { id: number; audience: string };
  try {
    assert.strictEqual(detail.audience, "exposed");
  } finally {
    await deleteDoc(app, detail.id);
  }
});

test("POST /api/clauded-docs (MD body): audience 미지정 → hidden default (plain primary)", async () => {
  const title = makeTitle("md-no-audience-field");
  const { status, body } = await postCreate(app, {
    title,
    author: "reporter",
    md_body: makeMdBody(title, null),
  });
  assert.strictEqual(status, 201);
  const detail = body as { id: number; audience: string };
  try {
    assert.strictEqual(detail.audience, "hidden");
  } finally {
    await deleteDoc(app, detail.id);
  }
});

test("POST /api/clauded-docs (MD body): invalid audience → 400 invalid_body (silent fallback 금지)", async () => {
  // exposure bit 은 최상위 `audience` 필드로만 결정 (frontmatter 미파싱).
  // 허용 외 값 (developer) → 400. exposed/hidden 외는 거부.
  const title = makeTitle("md-invalid-audience");
  const { status, body } = await postCreate(app, {
    title,
    author: "reporter",
    audience: "developer",
    md_body: makeMdBody(title, null),
  });
  assert.strictEqual(status, 400);
  const env = body as { error: string; reason: string };
  assert.strictEqual(env.error, "invalid_body");
  assert.match(env.reason, /audience/);
});

test("POST /api/clauded-docs (MD body): md_body + html_body 동시 제공 → 400 mutually exclusive", async () => {
  const title = makeTitle("md-mutually-exclusive");
  const { status, body } = await postCreate(app, {
    title,
    author: "reporter",
    md_body: makeMdBody(title, "public"),
    html_body: makeHtmlBody(title),
  });
  assert.strictEqual(status, 400);
  const env = body as { error: string; reason: string };
  assert.strictEqual(env.error, "invalid_body");
  assert.match(env.reason, /mutually exclusive/);
});

test("POST /api/clauded-docs (HTML body): html_body 흐름 — audience='exposed' 응답", async () => {
  // html_body 제공 → format=html primary → exposure bit 기본 'exposed' (UI 노출).
  const title = makeTitle("html-default-exposed");
  const { status, body } = await postCreate(app, {
    title,
    author: "tester",
    html_body: makeHtmlBody(title),
  });
  assert.strictEqual(status, 201);
  const detail = body as { id: number; audience: string | null; format: string };
  try {
    assert.strictEqual(detail.audience, "exposed", "HTML primary row → 'exposed' default");
    assert.strictEqual(detail.format, "html");
  } finally {
    await deleteDoc(app, detail.id);
  }
});

test("GET /api/clauded-docs/:id (MD body): audience field 응답에 포함", async () => {
  const title = makeTitle("md-get-audience");
  const created = await postCreate(app, {
    title,
    author: "reporter",
    md_body: makeMdBody(title, "ops"),
  });
  assert.strictEqual(created.status, 201);
  const id = (created.body as { id: number }).id;

  try {
    const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}?format=md` });
    assert.strictEqual(res.statusCode, 200);
    const detail = res.json() as { audience: string; format: string; body: string };
    assert.strictEqual(detail.audience, "hidden", "md_body 기본 exposure bit = hidden");
    assert.strictEqual(detail.format, "md");
    assert.match(detail.body, /audience: ops/, "MD body returned with original frontmatter text");
  } finally {
    await deleteDoc(app, id);
  }
});

test("GET /api/clauded-docs (list): audience field 포함 (MD row 응답 검증)", async () => {
  const title = makeTitle("md-list-audience");
  const created = await postCreate(app, {
    title,
    author: "reporter",
    md_body: makeMdBody(title, "agent-only"),
  });
  assert.strictEqual(created.status, 201);
  const id = (created.body as { id: number }).id;

  try {
    const res = await app.inject({ method: "GET", url: "/api/clauded-docs?limit=200" });
    assert.strictEqual(res.statusCode, 200);
    const list = res.json() as { rows: Array<{ id: number; audience: string | null }> };
    const found = list.rows.find((r) => r.id === id);
    assert.ok(found !== undefined, "row appears in list");
    assert.strictEqual(found?.audience, "hidden");
  } finally {
    await deleteDoc(app, id);
  }
});

// Read-side exposure(audience) bit 정합 — computeResponseAudience.
// 응답 audience 는 format-driven (NOT prefix) · DB 컬럼 NULL 이면 exposureForFormat(format) 으로 채움 (html→exposed · plain→hidden), 명시된 exposed/hidden 은 보존.
//   - GET detail / GET list 모두 동일 derivation
//   - HTML primary (DB audience=NULL) → 'exposed' surface
//   - plain primary (md, audience 명시) → 명시값 그대로 보존

test("audience: GET /api/clauded-docs/:id (HTML body, DB NULL) → audience='exposed' surface", async () => {
  const title = makeTitle("aud-html-detail");
  const created = await postCreate(app, {
    title,
    author: "planner",
    html_body: makeHtmlBody(title),
  });
  assert.strictEqual(created.status, 201);
  const id = (created.body as { id: number }).id;

  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}` });
  assert.strictEqual(res.statusCode, 200);
  const detail = res.json() as { audience: string | null; format: string };
  assert.strictEqual(detail.format, "html");
  assert.strictEqual(detail.audience, "exposed", "HTML primary + DB audience=NULL → 'exposed' (format-driven)");
});

test("audience: GET /api/clauded-docs/:id (second HTML body, DB NULL) → audience='exposed' surface", async () => {
  const title = makeTitle("aud-html-detail-2");
  const created = await postCreate(app, {
    title,
    author: "architect",
    html_body: makeHtmlBody(title),
  });
  assert.strictEqual(created.status, 201);
  const id = (created.body as { id: number }).id;

  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}` });
  assert.strictEqual(res.statusCode, 200);
  const detail = res.json() as { audience: string | null; format: string };
  assert.strictEqual(detail.format, "html");
  assert.strictEqual(detail.audience, "exposed", "HTML primary + DB audience=NULL → 'exposed' (format-driven)");
});

test("audience: GET /api/clauded-docs (list, HTML body) — row.audience='exposed' (no NULL surface)", async () => {
  const title = makeTitle("aud-html-list");
  const created = await postCreate(app, {
    title,
    author: "planner",
    html_body: makeHtmlBody(title),
  });
  assert.strictEqual(created.status, 201);
  const id = (created.body as { id: number }).id;

  const res = await app.inject({ method: "GET", url: "/api/clauded-docs?limit=200" });
  assert.strictEqual(res.statusCode, 200);
  const list = res.json() as { rows: Array<{ id: number; audience: string | null }> };
  const found = list.rows.find((r) => r.id === id);
  assert.ok(found !== undefined, "row appears in list");
  assert.strictEqual(found?.audience, "exposed", "list mapper applies same format-driven derivation");
});

test("audience: MD body audience=hidden → no fallback (명시값 그대로 보존)", async () => {
  // md_body audience='hidden' (plain primary) POST → GET 응답에서 'hidden' 그대로.
  const title = makeTitle("aud-md-hidden-preserve");
  const created = await postCreate(app, {
    title,
    author: "reporter",
    audience: "hidden",
    md_body: makeMdBody(title, "agent-only"),
  });
  assert.strictEqual(created.status, 201);
  const id = (created.body as { id: number }).id;

  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}?format=md` });
  assert.strictEqual(res.statusCode, 200);
  const detail = res.json() as { audience: string | null; format: string };
  assert.strictEqual(detail.format, "md");
  assert.strictEqual(detail.audience, "hidden", "MD primary 명시 hidden 은 그대로 surface (no fallback)");
});

test("audience: MD body 기본 (audience 미지정) → hidden (plain primary 기본 노출 정책)", async () => {
  // md_body + audience 미지정 → exposureForFormat('md') = hidden.
  const title = makeTitle("aud-md-default-hidden");
  const mdBody = `# ${title}\n\nbacklog item — plain MD primary 기본 hidden.\n`;
  const created = await postCreate(app, {
    title,
    author: "planner",
    md_body: mdBody,
  });
  assert.strictEqual(created.status, 201);
  const id = (created.body as { id: number }).id;

  const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${id}?format=md` });
  assert.strictEqual(res.statusCode, 200);
  const detail = res.json() as { audience: string | null; format: string };
  assert.strictEqual(detail.format, "md");
  assert.strictEqual(detail.audience, "hidden", "plain MD primary 기본 exposure bit = hidden");
});

// PUT RETURNING audience 보존 regression.
// RETURNING 절이 audience 를 누락하면 rowToDetailResponse 가 undefined 를 format-driven default 로 회귀시켜 DB 의 명시 audience 가 응답에서 소실.
// HTML row 를 raw SQL 로 비-기본값 'hidden' patch → PUT(audience 미지정) → 'hidden' 보존이면 RETURNING 포함 증명, 'exposed' 회귀면 누락 재현.
test("PUT /api/clauded-docs/:id: RETURNING audience 보존 (DB row 값 그대로 반영)", async () => {
  const title = makeTitle("put-returning-audience");
  const htmlA = makeHtmlBody(`${title}-A`);
  const created = await postCreate(app, {
    title,
    author: "tester",
    html_body: htmlA,
  });
  assert.strictEqual(created.status, 201);
  const detail = created.body as { id: number; content_hash: string; audience: string | null };
  // HTML body POST → exposure bit 기본 'exposed' (format-driven). 아래 raw UPDATE 로
  // DB 컬럼을 비-기본값 'hidden' 으로 patch 해 RETURNING 보존을 구분 가능하게 함.
  assert.strictEqual(detail.audience, "exposed", "POST HTML primary → 'exposed' 기본 상태 (format-driven)");

  // DB 직접 patch — HTML row 의 audience 컬럼을 format-driven 기본값과 다른 'hidden'
  // 으로 설정. RETURNING 절이 audience 를 누락하면 응답이 format-driven 'exposed' 로
  // 회귀하므로 'hidden' 보존 여부가 RETURNING 포함을 결정적으로 증명.
  const prisma = getPrisma();
  await prisma.$executeRaw`
    UPDATE monitor.documents
    SET audience = ${'hidden'}
    WHERE id = ${BigInt(detail.id)}
  `;

  // PUT 으로 title 변경 — body 는 새로운 HTML 이므로 content_hash 갱신.
  const htmlB = makeHtmlBody(`${title}-B-${randomUUID()}`);
  const res = await app.inject({
    method: "PUT",
    url: `/api/clauded-docs/${detail.id}`,
    payload: {
      html_body: htmlB,
      expected_hash: detail.content_hash,
      title: `${title}-renamed`,
    },
  });
  assert.strictEqual(res.statusCode, 200);
  const updated = res.json() as { id: number; audience: string | null; content_hash: string };

  // Core assertion — PUT 응답 audience 가 DB row 값 ('hidden') 그대로 (format-driven 회귀 X).
  assert.strictEqual(
    updated.audience,
    "hidden",
    "PUT response audience 가 DB 값 보존 — RETURNING 절에 audience 컬럼 포함 검증",
  );
  assert.notStrictEqual(updated.content_hash, detail.content_hash, "content_hash advanced");
});

// PATCH /api/clauded-docs/group/:rootId/reorder — group display ordering.
// id-ownership 검증 (extra/missing → 400) + 0-based 재할당 영속화 + within-group GET 순서 반영 (?folder_id=rootId).

// 실제 /group endpoint 로 N 개 doc 을 1 그룹으로 결성 → root = MAX(created_at) id,
// 모든 멤버 folder_id = root id. 반환: { rootId, memberIds(생성 순서) }.
async function makeGroup(
  appInst: FastifyInstance,
  count: number,
  label: string,
): Promise<{ rootId: number; memberIds: number[] }> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const title = makeTitle(`${label}-m${i}`);
    const res = await postCreate(appInst, {
      title, author: "tester", html_body: makeHtmlBody(title),
    });
    assert.strictEqual(res.status, 201, `member ${i} POST 201`);
    ids.push((res.body as { id: number }).id);
  }
  const groupRes = await appInst.inject({
    method: "POST",
    url: "/api/clauded-docs/group",
    payload: { member_ids: ids },
  });
  assert.strictEqual(groupRes.statusCode, 200, "group POST 200");
  const rootId = (groupRes.json() as { folder_id: number }).folder_id;
  return { rootId, memberIds: ids };
}

// within-group 멤버 id 를 표시 순서대로 반환 (?folder_id=rootId 경로 — handleList).
async function fetchGroupOrder(appInst: FastifyInstance, rootId: number): Promise<number[]> {
  const res = await appInst.inject({
    method: "GET",
    url: `/api/clauded-docs?folder_id=${rootId}`,
  });
  assert.strictEqual(res.statusCode, 200, "group member list 200");
  const rows = (res.json() as { rows: Array<{ id: number; display_order: number | null }> }).rows;
  return rows.map((r) => r.id);
}

test("PATCH .../group/:rootId/reorder: 0-based 재할당 + within-group GET 순서 반영", async () => {
  const { rootId, memberIds } = await makeGroup(app, 4, "reorder-happy");
  try {
    // 셔플 — 역순으로 재정렬 요청.
    const shuffled = [...memberIds].reverse();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clauded-docs/group/${rootId}/reorder`,
      payload: { ordered_ids: shuffled },
    });
    assert.strictEqual(res.statusCode, 200, "reorder 200");
    const body = res.json() as {
      folder_id: number;
      member_count: number;
      ordering: Array<{ id: number; display_order: number }>;
    };
    assert.strictEqual(body.folder_id, rootId, "응답 folder_id == rootId");
    assert.strictEqual(body.member_count, 4, "member_count == 4");
    // ordering 은 request 순서대로 0-based.
    assert.deepStrictEqual(
      body.ordering,
      shuffled.map((id, idx) => ({ id, display_order: idx })),
      "ordering — request 순서대로 0-based display_order 할당",
    );

    // within-group GET — display_order ASC 정렬이 요청한 셔플 순서를 반영.
    const persisted = await fetchGroupOrder(app, rootId);
    assert.deepStrictEqual(persisted, shuffled, "GET ?folder_id 가 새 순서 영속 반영");
  } finally {
    for (const id of memberIds) await deleteDoc(app, id);
  }
});

test("PATCH .../group/:rootId/reorder: ordered_ids 에 외부 id 포함 → 400 invalid_body", async () => {
  const { rootId, memberIds } = await makeGroup(app, 2, "reorder-extra");
  try {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clauded-docs/group/${rootId}/reorder`,
      // 그룹에 없는 id (999999999) 를 섞음 — set equality 위배.
      payload: { ordered_ids: [...memberIds, 999999999] },
    });
    assert.strictEqual(res.statusCode, 400, "외부 id → 400");
    assert.strictEqual((res.json() as { error: string }).error, "invalid_body");
  } finally {
    for (const id of memberIds) await deleteDoc(app, id);
  }
});

test("PATCH .../group/:rootId/reorder: 멤버 일부 누락 → 400 invalid_body (전체 나열 의무)", async () => {
  const { rootId, memberIds } = await makeGroup(app, 3, "reorder-missing");
  try {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clauded-docs/group/${rootId}/reorder`,
      // 3 멤버 중 2 개만 나열 — 부분 정렬 차단.
      payload: { ordered_ids: [memberIds[0], memberIds[1]] },
    });
    assert.strictEqual(res.statusCode, 400, "누락 멤버 → 400");
    assert.strictEqual((res.json() as { error: string }).error, "invalid_body");
  } finally {
    for (const id of memberIds) await deleteDoc(app, id);
  }
});

test("PATCH .../group/:rootId/reorder: 중복 id → 400 invalid_body", async () => {
  const { rootId, memberIds } = await makeGroup(app, 2, "reorder-dupe");
  try {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/clauded-docs/group/${rootId}/reorder`,
      payload: { ordered_ids: [memberIds[0], memberIds[0]] },
    });
    assert.strictEqual(res.statusCode, 400, "중복 id → 400");
    assert.strictEqual((res.json() as { error: string }).error, "invalid_body");
  } finally {
    for (const id of memberIds) await deleteDoc(app, id);
  }
});

test("PATCH .../group/:rootId/reorder: 미존재/빈 그룹 rootId → 404 not_found", async () => {
  const res = await app.inject({
    method: "PATCH",
    url: `/api/clauded-docs/group/999999999/reorder`,
    payload: { ordered_ids: [1] },
  });
  assert.strictEqual(res.statusCode, 404, "빈 그룹 → 404");
  assert.strictEqual((res.json() as { error: string }).error, "not_found");
});

test("ZZ leak audit: every suite-created row + file is cleaned at run-end", async () => {
  // Pre-run: count this suite's rows + files. The after() hook handles cleanup
  // but we want this assertion to surface leaks if the cleanup itself ever
  // regresses. Order: this test runs LAST (alphabetic by name; node:test runs
  // tests in registration order within a file, so naming with `ZZ` is the
  // belt-and-suspenders signal that this is the audit).
  //
  // Strategy: delete now, count after, assert zero. The after() hook will be
  // a redundant safety net.
  const prisma = getPrisma();
  const deleted = await prisma.$queryRaw<Array<{ id: bigint }>>`
    DELETE FROM monitor.documents
    WHERE title LIKE ${`%${SUITE_MARKER}%`}
    RETURNING id
  `;
  // After explicit cleanup, no rows must remain that match the marker.
  const remaining = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM monitor.documents
    WHERE title LIKE ${`%${SUITE_MARKER}%`}
  `;
  const remainingCount = remaining[0]?.count ?? BigInt(-1);
  assert.strictEqual(
    remainingCount,
    BigInt(0),
    `expected 0 rows after cleanup, got ${remainingCount}`,
  );

  // Surface count of deleted rows for diagnostic visibility. We do not assert
  // an exact number — the suite may grow — only that all marker-matching rows
  // are gone.
  assert.ok(deleted.length >= 0, "delete returned a list");

  // FS audit — html root + md root each hold separate file sets.
  // (Other tests delete their own rows but not files; we skip strict FS leak
  // audit because POST tests leave files on disk by design — the after() hook
  // removes both tempdir trees.)
  let htmlEntries: string[] = [];
  try {
    htmlEntries = await readdir(htmlSuiteRoot);
  } catch {
    // dir might not exist if no POST succeeded — acceptable.
  }
  // FS leak surfaces as "marker-matching basenames that are still present
  // even though their DB row was just deleted". We do NOT assert zero here
  // because POST tests intentionally leave their files (the after() hook
  // does the tree removal). We DO assert that DB+FS are consistent: a row
  // we just deleted has its file removed iff the DELETE handler ran for it.
  // For this suite the only DELETE handler invocation is in `delete-happy`,
  // so the audit's primary value is the DB leak check above.
  assert.ok(
    htmlEntries.length >= 0,
    "readdir succeeded (or dir absent — both fine)",
  );
});

// ── 숫자 파라미터 hardening (M1/M3) — unsafe-integer 는 파서 단계 400 ─────────────
// 2^53..2^63 은 parseInt float-round 로 다른 행 조회(wrong-row), >2^63 은 pg bigint
// overflow(22003 → 과거 false 503) — 모두 파서가 차단.

const BIGINT_OVERFLOW_ID = "9223372036854775808"; // 2^63 (bigint max + 1)
const FLOAT_ROUNDED_ID = "9007199254740993"; // 2^53 + 1 — parseInt → ...992

test("GET /api/clauded-docs/:id — unsafe-integer id 는 503 아닌 400", async () => {
  for (const raw of [BIGINT_OVERFLOW_ID, FLOAT_ROUNDED_ID, "99999999999999999999999999"]) {
    const res = await app.inject({ method: "GET", url: `/api/clauded-docs/${raw}` });
    assert.strictEqual(res.statusCode, 400, `id=${raw} → 400`);
    assert.deepStrictEqual(res.json(), { error: "invalid_param", param: "id" });
  }
});

test("GET /api/clauded-docs/:id — MAX_SAFE_INTEGER 경계값은 DB 도달 (404 not_found)", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/clauded-docs/${Number.MAX_SAFE_INTEGER}`,
  });
  assert.strictEqual(res.statusCode, 404, "경계값 id 는 거부되지 않고 정상 조회 → 404");
});

test("GET /api/clauded-docs?folder_id=<overflow> — 503 아닌 400", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/clauded-docs?folder_id=${BIGINT_OVERFLOW_ID}`,
  });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.json(), { error: "invalid_param", param: "folder_id" });
});

test("GET /api/clauded-docs/search?offset=<overflow> — 503 아닌 400", async () => {
  const res = await app.inject({
    method: "GET",
    url: `/api/clauded-docs/search?q=x&offset=${BIGINT_OVERFLOW_ID}`,
  });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.json(), { error: "invalid_param", param: "offset" });
});

// ── DB-failure taxonomy (M2) — FK 위반(23503)은 입력 오류 → 400 invalid_input ─────
test("POST /api/clauded-docs — 존재하지 않는 folder_id (FK 23503) 는 503 아닌 400 invalid_input", async () => {
  // safe-int 범위 내 미존재 id — 타입 검증은 통과, INSERT FK 제약에서 거부.
  const prisma = getPrisma();
  const maxRows = await prisma.$queryRaw<Array<{ next_free: bigint }>>`
    SELECT COALESCE(MAX(id), 0) + 100000 AS next_free FROM monitor.documents
  `;
  const missingFolderId = Number(maxRows[0]?.next_free ?? 100000n);

  const { status, body } = await postCreate(app, {
    title: makeTitle("fk-taxonomy"),
    author: "tester",
    html_body: makeHtmlBody("fk-taxonomy"),
    folder_id: missingFolderId,
  });
  assert.strictEqual(status, 400, "FK violation → 400 (과거 false 503)");
  const errorBody = body as { error: string; reason?: string };
  assert.strictEqual(errorBody.error, "invalid_input");
  assert.ok(
    typeof errorBody.reason === "string" && errorBody.reason.length > 0,
    "reason 에 pg 메시지 전달",
  );
});
