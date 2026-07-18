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
  cascadeAfterRowUpdate,
  cascadeUpdateDocStatus,
  fsErrnoCode,
  prefixedFsReason,
  replyUpdateCasConflict,
  restoreHtmlBody,
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

// ---------------------------------------------------------------------------
// DF-13 — cascade fires only on an ACTUAL doc_status diff (body-changed PUT).
// A PUT echoing the row's current status must leave mixed-status siblings alone.
// cascadeAfterRowUpdate takes prisma via DI → a call-counting mock drives it DB-free.
// ---------------------------------------------------------------------------

// prisma mock counting $queryRaw invocations (cascade fires ⟺ count increments).
function makeCountingPrisma(rows: unknown[] = []): {
  prisma: PrismaParam;
  callCount: () => number;
} {
  let calls = 0;
  const prisma = {
    $queryRaw: async () => {
      calls += 1;
      return rows;
    },
  } as unknown as PrismaParam;
  return { prisma, callCount: () => calls };
}

// cascadeAfterRowUpdate is typed against Fastify's request/prisma; the DI stubs
// mirror the existing makeRequest/makePrisma shims.
function makeExisting(overrides: Record<string, unknown>): Parameters<typeof cascadeAfterRowUpdate>[5] {
  return {
    id: BigInt(1),
    folder_id: BigInt(5),
    doc_status: "progress",
    ...overrides,
  } as unknown as Parameters<typeof cascadeAfterRowUpdate>[5];
}

function makeParsed(overrides: Record<string, unknown>): Parameters<typeof cascadeAfterRowUpdate>[4] {
  return { expected_hash: "0".repeat(64), ...overrides } as unknown as Parameters<
    typeof cascadeAfterRowUpdate
  >[4];
}

test("DF-13 cascadeAfterRowUpdate: status echo (parsed === existing) → NO cascade (siblings untouched)", async () => {
  const { prisma, callCount } = makeCountingPrisma();
  const result = await cascadeAfterRowUpdate(
    makeRequest() as unknown as Parameters<typeof cascadeAfterRowUpdate>[0],
    makeReply().asReply as unknown as Parameters<typeof cascadeAfterRowUpdate>[1],
    prisma as unknown as Parameters<typeof cascadeAfterRowUpdate>[2],
    1,
    makeParsed({ doc_status: "progress" }),
    makeExisting({ doc_status: "progress", folder_id: BigInt(5) }),
  );
  assert.strictEqual(result, true);
  assert.strictEqual(callCount(), 0, "echoing the current status must NOT run the cascade UPDATE");
});

test("DF-13 cascadeAfterRowUpdate: actual diff on a grouped row → cascade fires once", async () => {
  const { prisma, callCount } = makeCountingPrisma([
    { id: BigInt(1), doc_status: "done", folder_id: BigInt(5) },
  ]);
  const result = await cascadeAfterRowUpdate(
    makeRequest() as unknown as Parameters<typeof cascadeAfterRowUpdate>[0],
    makeReply().asReply as unknown as Parameters<typeof cascadeAfterRowUpdate>[1],
    prisma as unknown as Parameters<typeof cascadeAfterRowUpdate>[2],
    1,
    makeParsed({ doc_status: "done" }),
    makeExisting({ doc_status: "progress", folder_id: BigInt(5) }),
  );
  assert.strictEqual(result, true);
  assert.strictEqual(callCount(), 1, "a real progress→done diff on a group member runs the cascade");
});

test("DF-13 cascadeAfterRowUpdate: standalone row (folder_id NULL) → NO cascade even on a diff", async () => {
  const { prisma, callCount } = makeCountingPrisma();
  const result = await cascadeAfterRowUpdate(
    makeRequest() as unknown as Parameters<typeof cascadeAfterRowUpdate>[0],
    makeReply().asReply as unknown as Parameters<typeof cascadeAfterRowUpdate>[1],
    prisma as unknown as Parameters<typeof cascadeAfterRowUpdate>[2],
    1,
    makeParsed({ doc_status: "done" }),
    makeExisting({ doc_status: "progress", folder_id: null }),
  );
  assert.strictEqual(result, true);
  assert.strictEqual(callCount(), 0, "standalone rows have no siblings — cascade skipped");
});

// ---------------------------------------------------------------------------
// DF-26 — swap-orphan unlink: a failed html↔plain-swap PUT must remove the
// freshly-written swap file (no predecessor to restore), not leave it dangling.
// ---------------------------------------------------------------------------

test("DF-26 restoreHtmlBody: isNewSwapFile → unlinks the swap orphan (leaves no dangling file)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swap-orphan-"));
  try {
    const htmlPath = join(dir, "new-swap.html");
    writeFileSync(htmlPath, "FRESHLY_WRITTEN_SWAP_BODY", "utf8");
    const restoreArgs: HtmlRestoreArgs = {
      htmlPath,
      previousHtmlContent: null, // swap path had no predecessor
      isNewSwapFile: true,
    };

    await restoreHtmlBody(makeRequest().log as unknown as Parameters<typeof restoreHtmlBody>[0], restoreArgs);

    assert.throws(
      () => readFileSync(htmlPath, "utf8"),
      /ENOENT/,
      "swap orphan removed on rollback",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DF-26 restoreHtmlBody: in-place (not swap) still restores previous bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swap-inplace-"));
  try {
    const htmlPath = join(dir, "inplace.html");
    writeFileSync(htmlPath, "LOSER_NEW_CONTENT", "utf8");
    const restoreArgs: HtmlRestoreArgs = {
      htmlPath,
      previousHtmlContent: "ORIGINAL_BYTES",
      // isNewSwapFile omitted → in-place restore branch (regression guard).
    };

    await restoreHtmlBody(makeRequest().log as unknown as Parameters<typeof restoreHtmlBody>[0], restoreArgs);

    assert.strictEqual(readFileSync(htmlPath, "utf8"), "ORIGINAL_BYTES");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// DF-26 — cascade-only PUT content_hash guard: the cascade target must carry an
// atomic CAS guard so a hash that moved between fetch and cascade is caught.
// ---------------------------------------------------------------------------

// Flatten Prisma.Sql fragment embeds (the mock does not, unlike real $queryRaw).
function flattenValues(values: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const v of values) {
    const nested = (v as { values?: unknown }).values;
    if (v !== null && typeof v === "object" && Array.isArray(nested)) {
      out.push(...flattenValues(nested));
    } else {
      out.push(v);
    }
  }
  return out;
}

// Recover the SQL text of any embedded Prisma.Sql fragment (guard branch).
function fragmentTexts(values: unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const strings = (v as { strings?: unknown }).strings;
    if (v !== null && typeof v === "object" && Array.isArray(strings)) {
      out.push(strings.join(""));
    }
  }
  return out;
}

test("DF-26 cascadeUpdateDocStatus: expectedHash → target carries a bound content_hash CAS guard", async () => {
  let capturedValues: unknown[] = [];
  const prisma = makePrisma(async (_strings, values) => {
    capturedValues = values;
    return [{ id: BigInt(1), doc_status: "done", folder_id: BigInt(5) }];
  });

  await cascadeUpdateDocStatus(prisma, 1, "done", "EXPECTED_HASH_TOKEN");

  // The guard fragment SQL text mentions content_hash …
  const guardText = fragmentTexts(capturedValues).join(" ");
  assert.match(guardText, /content_hash/, "guard branch embeds the content_hash comparison");
  // … and the client hash is a BOUND value, never string-inlined (LLM05).
  const flat = flattenValues(capturedValues);
  assert.ok(flat.includes("EXPECTED_HASH_TOKEN"), "expected_hash bound as a parameter");
});

test("DF-26 cascadeUpdateDocStatus: no expectedHash (body-changed path) → NO extra guard", async () => {
  let capturedValues: unknown[] = [];
  const prisma = makePrisma(async (_strings, values) => {
    capturedValues = values;
    return [{ id: BigInt(1), doc_status: "done", folder_id: BigInt(5) }];
  });

  await cascadeUpdateDocStatus(prisma, 1, "done");

  const guardText = fragmentTexts(capturedValues).join(" ");
  assert.ok(!/content_hash/.test(guardText), "omitting expectedHash embeds Prisma.empty (no CAS guard)");
});
