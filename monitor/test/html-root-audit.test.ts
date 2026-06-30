// html-root-audit 부팅 감사 테스트 (M7 회귀 고정).
// Runner: npx tsx --test test/html-root-audit.test.ts
//
// Pinned invariant: root 밖을 가리키는 html_path 행은 mismatched 로 집계 +
// 최신순 sample 에 노출 · trailing-separator 가드로 sibling-prefix(/a/b vs /a/bc)
// 는 매치로 오인하지 않음. 실 DB 의 타 행 오염을 피해 본 suite 행의 포함/제외만 단언.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { auditHtmlRootPrefixes } from "../src/server/maintenance/html-root-audit.js";
import { registerClaudedDocsRoutes } from "../src/server/routes/clauded-docs.js";
import { resetDocsRootCache } from "../src/server/clauded-docs/storage.js";

const SUITE_MARKER = `root-audit-test-${randomUUID().slice(0, 8)}`;

let htmlSuiteRoot: string;
let app: FastifyInstance;
let docId: number;

function makeHtmlBody(salt: string): string {
  return (
    "<!doctype html>" +
    '<html lang="ko">' +
    '<head><meta charset="utf-8"><title>x</title></head>' +
    `<body><main><h1>${salt}</h1><p>본문 ${salt}</p></main></body>` +
    "</html>"
  );
}

before(async () => {
  htmlSuiteRoot = mkdtempSync(join(tmpdir(), "html-root-audit-"));
  process.env.CLAUDED_DOCS_HTML_ROOT = htmlSuiteRoot;
  resetDocsRootCache();

  app = Fastify({ logger: false });
  await registerClaudedDocsRoutes(app);
  await app.ready();

  const res = await app.inject({
    method: "POST",
    url: "/api/clauded-docs",
    payload: {
      title: `${SUITE_MARKER}-doc`,
      author: "tester",
      html_body: makeHtmlBody(SUITE_MARKER),
    },
  });
  assert.strictEqual(res.statusCode, 201, "seed doc created");
  docId = (res.json() as { id: number }).id;
});

after(async () => {
  try {
    await app.close();
  } catch {
    // best-effort
  }
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`
      DELETE FROM monitor.documents WHERE title LIKE ${`%${SUITE_MARKER}%`}
    `;
  } catch (error) {
    console.error("[html-root-audit cleanup] DB scrub failed:", error);
  }
  rmSync(htmlSuiteRoot, { recursive: true, force: true });
  await disconnectPrisma();
});

test("root 안의 행은 mismatch sample 에 미포함", async () => {
  const result = await auditHtmlRootPrefixes(htmlSuiteRoot);
  assert.ok(result.total >= 1, "total counts rows");
  assert.ok(!result.sampleIds.includes(docId), "정상 행은 sample 미포함");
});

test("sibling-prefix 경로(root + '-x/...')는 mismatched 로 검출 (separator 가드)", async () => {
  // 문자열 prefix 는 공유하지만 디렉터리 경계 밖 — starts_with(root) 단순 비교라면
  // 매치로 오인하는 케이스. UPDATE 는 본 suite 행만 변조.
  const prisma = getPrisma();
  const siblingPath = `${htmlSuiteRoot}-sibling/${SUITE_MARKER}.html`;
  await prisma.$executeRaw`
    UPDATE monitor.documents SET html_path = ${siblingPath} WHERE id = ${BigInt(docId)}
  `;

  const result = await auditHtmlRootPrefixes(htmlSuiteRoot);
  assert.ok(result.mismatched >= 1, "mismatched counts the tampered row");
  assert.ok(
    result.sampleIds.includes(docId),
    `tampered id ${docId} surfaces in newest-first samples ${JSON.stringify(result.sampleIds)}`,
  );
});
