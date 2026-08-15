// 저장 본문 무결성 감사 테스트 (DSH-C11 회귀 고정).
// Runner: npx tsx --test test/document-body-integrity.test.ts
//
// DB 불요 — 순수 seam(auditBodyRows)에 행을 주입하고 실제 임시 파일을 읽는다.
// 고정 불변식: 저장 바이트를 그대로 해싱 · sanitizer 재적용 없음 · 변조/부재/읽기불가를
// 서로 다른 condition 으로 분류하며 어떤 경우에도 throw 하지 않는다.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "fastify";

import { sanitizeHtmlBody } from "../src/server/clauded-docs/sanitize.js";
import {
  MAX_DOC_INTEGRITY_LIMIT,
  registerHealthDetailRoutes,
  resolveDocIntegrityLimit,
} from "../src/server/routes/health-detail.js";
import { sha256Hex } from "../src/server/clauded-docs/storage.js";
import {
  auditBodyRows,
  type DocumentBodyRow,
} from "../src/server/maintenance/document-body-integrity.js";

let suiteRoot: string;

before(() => {
  suiteRoot = mkdtempSync(join(tmpdir(), "doc-body-integrity-"));
});

after(() => {
  rmSync(suiteRoot, { recursive: true, force: true });
});

function seedRow(id: number, body: string): DocumentBodyRow {
  const path = join(suiteRoot, `doc-${id}.html`);
  writeFileSync(path, body, "utf8");
  return { id, path, contentHash: sha256Hex(body) };
}

function seedIntactRows(startId: number, count: number): DocumentBodyRow[] {
  return Array.from({ length: count }, (_, offset) =>
    seedRow(startId + offset, `<main><p>본문 ${startId + offset}</p></main>`),
  );
}

test("무결한 store 는 0건 보고", async () => {
  const rows = seedIntactRows(100, 5);

  const result = await auditBodyRows(rows);

  assert.strictEqual(result.checked, 5);
  assert.strictEqual(result.intact, 5);
  assert.deepStrictEqual(result.issues, []);
  assert.strictEqual(result.truncated, false);
});

test("외부 변조 1건만 정확히 보고 (false positive 0)", async () => {
  const rows = seedIntactRows(200, 5);
  const tampered = rows[2];
  assert.ok(tampered !== undefined);
  writeFileSync(tampered.path, "<main><p>out-of-band edit</p></main>", "utf8");

  const result = await auditBodyRows(rows);

  assert.strictEqual(result.mismatch, 1);
  assert.strictEqual(result.missing, 0);
  assert.strictEqual(result.unreadable, 0);
  assert.deepStrictEqual(result.issues, [
    { id: tampered.id, path: tampered.path, condition: "mismatch" },
  ]);
  assert.strictEqual(result.intact, 4);
});

test("본문 파일 부재는 missing 으로 분류", async () => {
  const rows = seedIntactRows(300, 2);
  // 루트 이동 후 남은 행과 같은 형태 — 경로는 살아 있으나 파일이 없다.
  const absent: DocumentBodyRow = {
    id: 399,
    path: join(suiteRoot, "gone", "doc-399.html"),
    contentHash: sha256Hex("사라진 본문"),
  };

  const result = await auditBodyRows([...rows, absent]);

  assert.strictEqual(result.missing, 1);
  assert.strictEqual(result.mismatch, 0);
  assert.strictEqual(result.unreadable, 0);
  assert.deepStrictEqual(result.issues, [
    { id: absent.id, path: absent.path, condition: "missing" },
  ]);
});

test("읽을 수 없는 경로는 unreadable 로 분류", async () => {
  const dirPath = join(suiteRoot, "doc-400.html");
  mkdirSync(dirPath, { recursive: true });
  const row: DocumentBodyRow = { id: 400, path: dirPath, contentHash: sha256Hex("x") };

  const result = await auditBodyRows([row]);

  assert.strictEqual(result.unreadable, 1);
  assert.strictEqual(result.missing, 0);
  assert.strictEqual(result.mismatch, 0);
  assert.strictEqual(result.issues[0]?.condition, "unreadable");
});

test("재-sanitize 시 달라지는 본문도 저장 바이트 기준으로 intact", async () => {
  const body = '<main><p onclick="steal()">재적용하면 달라지는 본문</p></main>';
  // 픽스처가 실제 판별력을 갖는지 먼저 고정 — 재-sanitize 는 이 본문을 바꾼다.
  assert.notStrictEqual(sanitizeHtmlBody(body), body);
  const row = seedRow(500, body);

  const result = await auditBodyRows([row]);

  assert.strictEqual(result.checked, 1);
  assert.strictEqual(result.intact, 1);
  assert.deepStrictEqual(result.issues, []);
});

test("동시 읽기 상한을 넘는 코퍼스도 전량 정확히 집계", async () => {
  const rows = seedIntactRows(600, 40);
  const tampered = rows[37];
  assert.ok(tampered !== undefined);
  writeFileSync(tampered.path, "tampered", "utf8");

  const result = await auditBodyRows(rows);

  assert.strictEqual(result.checked, 40);
  assert.strictEqual(result.intact, 39);
  assert.deepStrictEqual(result.issues.map((issue) => issue.id), [tampered.id]);
});

test("issue 표본은 상한에서 잘리고 카운트는 전량 유지 · 최신 id 우선", async () => {
  const rows: DocumentBodyRow[] = Array.from({ length: 60 }, (_, offset) => ({
    id: 1000 + offset,
    path: join(suiteRoot, "gone", `doc-${1000 + offset}.html`),
    contentHash: sha256Hex("사라진 본문"),
  }));

  const result = await auditBodyRows(rows);

  assert.strictEqual(result.missing, 60);
  assert.strictEqual(result.issues.length, 50);
  assert.strictEqual(result.truncated, true);
  assert.strictEqual(result.issues[0]?.id, 1059);
});

test("route: 범위 밖 limit 은 DB 접근 전에 400 invalid_param", async () => {
  const app = Fastify({ logger: false });
  await registerHealthDetailRoutes(app);
  await app.ready();

  const res = await app.inject({ method: "GET", url: "/api/health/document-integrity?limit=0" });

  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(res.json(), { error: "invalid_param", param: "limit" });
  await app.close();
});

// limit 기본값 반전 고정 — 무제한 전량 스윕이 다시 기본이 되는 회귀를 막는다.
test("route: limit 미지정/빈 값은 newest-N 로 제한 (전량 스윕 아님)", () => {
  assert.strictEqual(resolveDocIntegrityLimit(undefined), MAX_DOC_INTEGRITY_LIMIT);
  assert.strictEqual(resolveDocIntegrityLimit(""), MAX_DOC_INTEGRITY_LIMIT);
});

test("route: 전량 스윕(null)은 limit=all 로만 옵트인", () => {
  assert.strictEqual(resolveDocIntegrityLimit("all"), null);
});

test("route: 명시 숫자 limit 은 기존 클램프 동작 그대로", () => {
  assert.strictEqual(resolveDocIntegrityLimit("25"), 25);
  assert.strictEqual(resolveDocIntegrityLimit(String(MAX_DOC_INTEGRITY_LIMIT)), MAX_DOC_INTEGRITY_LIMIT);
  assert.strictEqual(resolveDocIntegrityLimit(String(MAX_DOC_INTEGRITY_LIMIT + 1)), "invalid");
  assert.strictEqual(resolveDocIntegrityLimit("0"), "invalid");
  assert.strictEqual(resolveDocIntegrityLimit("abc"), "invalid");
});
