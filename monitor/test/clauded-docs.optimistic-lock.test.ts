// Unit tests for the PUT optimistic-lock hardening (red-team #20) and the
// fs-error path-leak sanitizer (red-team #21) in routes/clauded-docs.ts.
// Runner: node:test (built-in) via tsx — npx tsx --test test/clauded-docs.optimistic-lock.test.ts
//
// Scope (DB-무접속 단위 테스트, mirrors clauded-docs.search-sql.test.ts): the CAS
// producer (updateClaudedDocRow) and the conflict resolver (replyUpdateCasConflict)
// both take prisma via DI, so a mock $queryRaw drives them with NO real DB. FS
// restore is exercised against a real tempdir. Route-level integration (prefix
// preservation on the live handler) stays covered by the pinned html-export tests.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildFsFailReason,
  fsErrnoCode,
  prefixedFsReason,
  replyUpdateCasConflict,
  updateClaudedDocRow,
  type HtmlRestoreArgs,
  type UpdateClaudedDocArgs,
} from "../src/server/routes/clauded-docs.js";

// A path that must NEVER appear in any client-facing error body (info leak).
const LEAK_PATH = "/Users/secret/glass-atrium/monitor/data/clauded-docs/doc-42.html";

type PrismaParam = Parameters<typeof updateClaudedDocRow>[0];

// Mock prisma whose $queryRaw returns/throws whatever the handler supplies and
// (optionally) captures the tagged-template SQL text + bound values.
function makePrisma(
  handler: (strings: TemplateStringsArray, values: unknown[]) => Promise<unknown[]>,
): PrismaParam {
  return {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      handler(strings, values),
  } as unknown as PrismaParam;
}

function makeRequest(): Parameters<typeof replyUpdateCasConflict>[0] {
  const log = { error() {}, warn() {}, info() {}, debug() {} };
  return { log } as unknown as Parameters<typeof replyUpdateCasConflict>[0];
}

// Reply stub capturing the last status code (handlers set code then return a body).
function makeReply(): { statusCode: number; asReply: Parameters<typeof replyUpdateCasConflict>[1] } {
  const reply = { statusCode: 0 } as { statusCode: number; code: (n: number) => unknown };
  reply.code = (n: number) => {
    reply.statusCode = n;
    return reply;
  };
  return { statusCode: 0, asReply: reply as unknown as Parameters<typeof replyUpdateCasConflict>[1] };
}

function makeArgs(overrides: Partial<Record<string, unknown>>): UpdateClaudedDocArgs {
  return {
    id: 123,
    parsed: { expected_hash: "CLIENT_EXPECTED_HASH", title: "t", doc_status: "progress" },
    existing: { title: "t", html_path: "/root/x.html", audience: null, doc_status: "progress" },
    conversion: { contentHash: "SERVER_NEW_HASH", indexableText: "idx" },
    newBodyPath: null,
    newAudience: null,
    ...overrides,
  } as unknown as UpdateClaudedDocArgs;
}

function assertNoPathLeak(reason: string): void {
  assert.ok(!reason.includes("/Users/"), `no absolute path: ${reason}`);
  assert.ok(!reason.includes(LEAK_PATH), `no leaked path: ${reason}`);
  assert.ok(!reason.includes(".html"), `no filename: ${reason}`);
  assert.ok(
    !/no such file|permission denied|open '/.test(reason),
    `no raw fs message: ${reason}`,
  );
}

// ---------------------------------------------------------------------------
// Finding #20 — atomic compare-and-set optimistic lock (TOCTOU lost update)
// ---------------------------------------------------------------------------

test("#20 updateClaudedDocRow: CAS guards the WHERE on the client expected_hash (parameterized bind)", async () => {
  let capturedSql = "";
  let capturedValues: unknown[] = [];
  const prisma = makePrisma(async (strings, values) => {
    capturedSql = strings.join("?");
    capturedValues = values;
    return [{ content_hash: "SERVER_NEW_HASH" }];
  });

  const result = await updateClaudedDocRow(prisma, makeArgs({ id: 123 }));

  assert.strictEqual(result.kind, "updated");
  // WHERE carries BOTH the id lookup and the content_hash CAS guard.
  assert.ok(capturedSql.includes("WHERE id ="), `WHERE id present: ${capturedSql}`);
  assert.ok(capturedSql.includes("AND content_hash ="), `CAS guard present: ${capturedSql}`);
  // The client token is a BOUND parameter (in values), NEVER inlined (LLM05 SQL-injection defense).
  assert.ok(capturedValues.includes("CLIENT_EXPECTED_HASH"), "expected_hash bound as parameter");
  assert.ok(
    !capturedSql.includes("CLIENT_EXPECTED_HASH"),
    "expected_hash MUST NOT be string-concatenated into the SQL text",
  );
  assert.ok(
    capturedValues.some((v) => typeof v === "bigint" && v === BigInt(123)),
    "id bound as a bigint parameter",
  );
});

test("#20 updateClaudedDocRow: guarded-WHERE miss (0 rows) → typed cas_conflict, never throws", async () => {
  const prisma = makePrisma(async () => []);
  const result = await updateClaudedDocRow(prisma, makeArgs({}));
  assert.deepStrictEqual(result, { kind: "cas_conflict" });
});

test("#20 replyUpdateCasConflict: concurrent hash race → 409 + loser's body restored on disk (no DB/FS divergence)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cas-conflict-"));
  try {
    const htmlPath = join(dir, "doc.html");
    // The loser's PUT already overwrote the body before its guarded UPDATE missed.
    writeFileSync(htmlPath, "LOSER_NEW_CONTENT", "utf8");
    const restoreArgs: HtmlRestoreArgs = {
      htmlPath,
      previousHtmlContent: "PREVIOUS_ORIGINAL_CONTENT",
    };
    // Re-SELECT finds the row present with the WINNER's hash.
    const prisma = makePrisma(async () => [{ content_hash: "WINNER_HASH" }]);
    const reply = makeReply();

    const body = await replyUpdateCasConflict(
      makeRequest(),
      reply.asReply,
      prisma,
      123,
      "CLIENT_EXPECTED",
      restoreArgs,
    );

    assert.strictEqual((reply.asReply as unknown as { statusCode: number }).statusCode, 409);
    // `actual` is the freshly-selected winner hash, not the self-contradictory expected.
    assert.deepStrictEqual(body, {
      error: "hash_conflict",
      expected: "CLIENT_EXPECTED",
      actual: "WINNER_HASH",
    });
    // Loser's content is gone — file restored to the pre-write snapshot.
    assert.strictEqual(readFileSync(htmlPath, "utf8"), "PREVIOUS_ORIGINAL_CONTENT");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#20 replyUpdateCasConflict: concurrent delete (row gone) → 404 not_found + body restored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cas-delete-"));
  try {
    const htmlPath = join(dir, "doc.html");
    writeFileSync(htmlPath, "LOSER_NEW_CONTENT", "utf8");
    const restoreArgs: HtmlRestoreArgs = { htmlPath, previousHtmlContent: "ORIGINAL" };
    const prisma = makePrisma(async () => []); // re-SELECT returns nothing → deleted
    const reply = makeReply();

    const body = await replyUpdateCasConflict(
      makeRequest(),
      reply.asReply,
      prisma,
      77,
      "EXP",
      restoreArgs,
    );

    assert.strictEqual((reply.asReply as unknown as { statusCode: number }).statusCode, 404);
    assert.deepStrictEqual(body, { error: "not_found", id: 77 });
    assert.strictEqual(readFileSync(htmlPath, "utf8"), "ORIGINAL");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#20 replyUpdateCasConflict: re-SELECT DB failure → 503 database_unavailable (restore still ran first)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cas-dberr-"));
  try {
    const htmlPath = join(dir, "doc.html");
    writeFileSync(htmlPath, "LOSER_NEW_CONTENT", "utf8");
    const restoreArgs: HtmlRestoreArgs = { htmlPath, previousHtmlContent: "ORIGINAL" };
    const prisma = makePrisma(async () => {
      throw new Error("connection lost");
    });
    const reply = makeReply();

    const body = (await replyUpdateCasConflict(
      makeRequest(),
      reply.asReply,
      prisma,
      5,
      "EXP",
      restoreArgs,
    )) as { error: string };

    assert.strictEqual((reply.asReply as unknown as { statusCode: number }).statusCode, 503);
    assert.strictEqual(body.error, "database_unavailable");
    // restoreHtmlBody runs BEFORE the re-SELECT, so the disk is reverted regardless.
    assert.strictEqual(readFileSync(htmlPath, "utf8"), "ORIGINAL");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Finding #21 — fs error responses leak absolute filesystem paths
// ---------------------------------------------------------------------------

test("#21 fsErrnoCode: extracts errno code · undefined for non-errno / non-object", () => {
  assert.strictEqual(fsErrnoCode(Object.assign(new Error("x"), { code: "ENOENT" })), "ENOENT");
  assert.strictEqual(fsErrnoCode(new Error("no code")), undefined);
  assert.strictEqual(fsErrnoCode("string error"), undefined);
  assert.strictEqual(fsErrnoCode(null), undefined);
  assert.strictEqual(fsErrnoCode(undefined), undefined);
  assert.strictEqual(fsErrnoCode({ code: 123 }), undefined); // non-string code
});

test("#21 buildFsFailReason: errno error → path-free errno form, no absolute path", () => {
  const err = Object.assign(new Error(`EACCES: permission denied, open '${LEAK_PATH}'`), {
    code: "EACCES",
    path: LEAK_PATH,
  });
  const reason = buildFsFailReason(err);
  assert.strictEqual(reason, "fs error (EACCES)");
  assertNoPathLeak(reason);
});

test("#21 buildFsFailReason: non-errno error → generic fallback, no path", () => {
  const reason = buildFsFailReason(new Error(`boom while touching ${LEAK_PATH}`));
  assert.strictEqual(reason, "filesystem operation failed");
  assertNoPathLeak(reason);
});

test("#21 prefixedFsReason: keeps the stage discriminator (pinned by html-export tests) while dropping the path", () => {
  const errnoErr = Object.assign(new Error(`ENOENT: no such file or directory, open '${LEAK_PATH}'`), {
    code: "ENOENT",
    path: LEAK_PATH,
  });
  const noCodeErr = new Error(`render pipeline blew up reading ${LEAK_PATH}`);

  // handleHtmlExportSingle read site — html-export.test.ts:319 asserts startsWith("html_export_read:").
  const single = prefixedFsReason("html_export_read", errnoErr, "stored file read failed");
  assert.ok(single.startsWith("html_export_read:"), single);
  assert.strictEqual(single, "html_export_read: ENOENT");
  assertNoPathLeak(single);

  // multi-export manifest read site — html-export-multi.test.ts:424 asserts startsWith("read:").
  const multi = prefixedFsReason("read", noCodeErr, "stored file read failed");
  assert.ok(multi.startsWith("read:"), multi);
  assert.strictEqual(multi, "read: stored file read failed");
  assertNoPathLeak(multi);

  // failWithHtmlExport render/Playwright site — stage discriminator survives, message dropped.
  const render = prefixedFsReason("html_export_render", noCodeErr, "export failed");
  assert.ok(render.startsWith("html_export_render:"), render);
  assert.strictEqual(render, "html_export_render: export failed");
  assertNoPathLeak(render);
});
