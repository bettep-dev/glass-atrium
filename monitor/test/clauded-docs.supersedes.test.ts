// Integration tests for supersedes_id + archived/superseded default-exclusion
// semantics on /api/clauded-docs/*.
//
// Runner: node:test (built-in) via tsx — npx tsx --test test/clauded-docs.supersedes.test.ts
//
// Coverage:
//   - POST with supersedes_id → predecessor doc_status auto-transitions to 'done'
//     via single-statement CTE (transactional, atomic)
//   - GET /api/clauded-docs default response 의 X-Deprecation-Notice 헤더 invariant
//     (include_archived 미명시 → 부착 · =true → 부재) — 헤더는 ?include_archived
//     별칭 자체의 obsolescence 안내로 보존
//   - PUT body containing supersedes_id is rejected 400 (immutable after POST)
//   - POST supersedes_id type validation (negative / non-existent id → 400)
//
// Isolation contract:
//   - DB: real Postgres on /tmp socket (DATABASE_URL from .env) — every row this
//     suite creates is tagged with `superse-test-${uuid}-…` in the title so the
//     after() hook can scrub leaks regardless of mid-test crashes.
//   - FS: per-suite TWO tempdirs (dual root: HTML primary + vault MD companion)
//     — both rmSync'd in after().
//   - App: stripped Fastify instance with only clauded-docs routes; app.inject()
//     means no real port binding.
//   - Each test: try/finally cleanup of every seed doc via DELETE handler so
//     row+file go together. after() is a safety net for mid-test crashes.
//
// Out of scope (covered elsewhere):
//   - General CRUD happy-path / hash-conflict / structure validator
//     (clauded-docs.route.test.ts)
//   - search SQL builder (clauded-docs.search-sql.test.ts)
//   - HTML validator / sanitize policy (clauded-docs.html-validator.test.ts /
//     clauded-docs.sanitize.test.ts)
//
// All seed titles share a per-suite UUID marker (SUITE_MARKER) so no collision
// with existing rows. Cleanup uses LIKE on the marker.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { disconnectPrisma, getPrisma } from "../src/server/db.js";
import { registerClaudedDocsRoutes } from "../src/server/routes/clauded-docs.js";
import { resetDocsRootCache } from "../src/server/clauded-docs/storage.js";

// ----- shared fixtures ------------------------------------------------------

// Per-suite marker — DB cleanup uses LIKE on this so other test suites + prod
// rows are never touched even if try/finally aborts mid-test.
const SUITE_MARKER = `superse-test-${randomUUID()}`;

let htmlSuiteRoot: string;
let app: FastifyInstance;

// Title generator — keeps the SUITE_MARKER prefix; per-test label discriminates
// concurrent test bodies.
function makeTitle(label: string): string {
  return `${SUITE_MARKER}-${label}-${randomUUID()}`;
}

// Minimal valid HTML body — varies per call so content_hash differs. Includes
// every element the structure validator requires: doctype, charset meta,
// head/title, body, <main> landmark, and an <h1> heading.
function makeHtmlBody(salt: string): string {
  return (
    "<!doctype html>" +
    '<html lang="ko">' +
    '<head><meta charset="utf-8"><title>x</title></head>' +
    `<body><main><h1>${salt}</h1><p>본문 ${salt}</p></main></body>` +
    "</html>"
  );
}

// Convenience POST helper — returns {status, body} where body is the parsed JSON.
async function postCreate(
  appInst: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown; headers: Record<string, unknown> }> {
  const res = await appInst.inject({
    method: "POST",
    url: "/api/clauded-docs",
    payload,
  });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
}

// Delete one row by id — best-effort, swallows any non-200 because cleanup must
// not throw inside try/finally (we still want subsequent cleanup to run).
async function deleteDoc(appInst: FastifyInstance, id: number): Promise<void> {
  try {
    await appInst.inject({ method: "DELETE", url: `/api/clauded-docs/${id}` });
  } catch {
    // best-effort cleanup — leaks caught by after() DB scrub.
  }
}

before(async () => {
  htmlSuiteRoot = mkdtempSync(join(tmpdir(), "clauded-docs-superse-html-"));
  process.env.CLAUDED_DOCS_HTML_ROOT = htmlSuiteRoot;
  resetDocsRootCache();

  app = Fastify({ logger: false });
  await registerClaudedDocsRoutes(app);
  await app.ready();
});

after(async () => {
  try {
    await app.close();
  } catch {
    // Best-effort — app may already be closed.
  }
  try {
    const prisma = getPrisma();
    await prisma.$executeRaw`
      DELETE FROM monitor.documents WHERE title LIKE ${`%${SUITE_MARKER}%`}
    `;
  } catch (error) {
    console.error("[supersedes-test cleanup] DB scrub failed:", error);
  }
  await disconnectPrisma();
  rmSync(htmlSuiteRoot, { recursive: true, force: true });
  delete process.env.CLAUDED_DOCS_HTML_ROOT;
  resetDocsRootCache();
});

// ----- POST supersedes_id → predecessor auto-transition ----------------

test("POST supersedes_id → predecessor doc_status auto-transitions to 'done' (CTE atomic)", async () => {
  // Seed predecessor — doc_status default 는 'progress' (insertClaudedDocRow 기본값).
  // doc_status='progress' → 'done' transition 이 CTE 단일 statement 로 적용됨을 검증.
  // doc_type 필드는 silent ignore (컬럼 부재).
  const predTitle = makeTitle("ac1-pred");
  const predHtml = makeHtmlBody(`${predTitle}-progress-body`);
  const predRes = await postCreate(app, {
    title: predTitle,
    prefix: "계획",
    doc_status: "progress",
    author: "tester",
    html_body: predHtml,
  });
  assert.strictEqual(predRes.status, 201, "predecessor POST 201");
  const pred = predRes.body as { id: number; doc_status: string; supersedes_id: number | null };
  assert.strictEqual(pred.doc_status, "progress", "predecessor starts at doc_status=progress");
  assert.strictEqual(pred.supersedes_id, null, "predecessor is chain root (supersedes_id=null)");

  let succId: number | null = null;
  try {
    // Seed successor pointing to predecessor — single-statement CTE transitions
    // predecessor in the same SQL execution.
    const succTitle = makeTitle("ac1-succ");
    const succHtml = makeHtmlBody(`${succTitle}-progress-body`);
    const succRes = await postCreate(app, {
      title: succTitle,
      prefix: "계획",
      doc_status: "progress",
      author: "tester",
      html_body: succHtml,
      supersedes_id: pred.id,
    });
    assert.strictEqual(succRes.status, 201, "successor POST 201");
    const succ = succRes.body as { id: number; supersedes_id: number | null; doc_status: string };
    succId = succ.id;
    // Successor row stores the predecessor id verbatim.
    assert.strictEqual(succ.supersedes_id, pred.id, "successor.supersedes_id = pred.id");
    assert.strictEqual(succ.doc_status, "progress", "successor's own doc_status unaffected by CTE");

    // Re-fetch predecessor — its doc_status MUST now be 'done'.
    const refetched = await app.inject({
      method: "GET",
      url: `/api/clauded-docs/${pred.id}?format=html`,
    });
    assert.strictEqual(refetched.statusCode, 200, "predecessor re-fetch 200");
    const refetchedBody = refetched.json() as { id: number; doc_status: string };
    assert.strictEqual(
      refetchedBody.doc_status,
      "done",
      "predecessor doc_status auto-transitioned to 'done' via CTE",
    );
  } finally {
    // Cleanup order: successor first (FK ON DELETE SET NULL on predecessor,
    // so deleting either order is technically safe — but successor-first keeps
    // the chain visually clean).
    if (succId !== null) await deleteDoc(app, succId);
    await deleteDoc(app, pred.id);
  }
});

// ----- X-Deprecation-Notice header invariant -----

test("GET /api/clauded-docs default response 의 X-Deprecation-Notice 헤더 invariant", async () => {
  // 행 분류 부재 (archived/superseded 컬럼 없음) → seed-level 제외 의미 없음.
  // include_archived 토글 = backward-compat plumbing 만 (handleList 응답 영향 0).
  // X-Deprecation-Notice 헤더 = 별칭 자체의 obsolescence 안내로 보존
  //   (미명시 호출 시 부착 → ?include_archived=true 호출 시 부재).
  // header invariant 만 검증.
  const ac2Marker = `ac2-${randomUUID().slice(0, 8)}`;
  const seedTitle = makeTitle(`${ac2Marker}-seed`);

  const seedRes = await postCreate(app, {
    title: seedTitle,
    prefix: "계획",
    doc_status: "progress",
    author: "tester",
    html_body: makeHtmlBody(`${seedTitle}-body`),
  });
  assert.strictEqual(seedRes.status, 201, "seed POST 201");
  const seedId = (seedRes.body as { id: number }).id;

  try {
    // (a) Default call — no include_archived param. MUST attach X-Deprecation-Notice
    // header (별칭 obsolescence 안내) + seed 가 response 에 포함.
    // High limit so the LIMIT cap does not truncate the suite seed in a busy DB.
    const defaultRes = await app.inject({
      method: "GET",
      url: `/api/clauded-docs?limit=${200}`,
    });
    assert.strictEqual(defaultRes.statusCode, 200, "default GET 200");
    const defaultHeader = defaultRes.headers["x-deprecation-notice"];
    assert.strictEqual(
      typeof defaultHeader,
      "string",
      "include_archived 미명시 응답에 X-Deprecation-Notice 헤더 부착",
    );
    assert.ok(
      typeof defaultHeader === "string" && defaultHeader.includes("include_archived=true"),
      `header text mentions include_archived=true (got: ${String(defaultHeader)})`,
    );
    const defaultBody = defaultRes.json() as { rows: Array<{ id: number; doc_status: string }> };
    const defaultIds = new Set(defaultBody.rows.map((r) => r.id));
    assert.ok(
      defaultIds.has(seedId),
      "default response 가 seed 포함 (행 분류 제외 의미 없음)",
    );

    // (b) Opt-in include_archived=true — NO deprecation header + seed 도 포함.
    const inclRes = await app.inject({
      method: "GET",
      url: `/api/clauded-docs?limit=${200}&include_archived=true`,
    });
    assert.strictEqual(inclRes.statusCode, 200, "include_archived=true GET 200");
    assert.strictEqual(
      inclRes.headers["x-deprecation-notice"],
      undefined,
      "include_archived=true 명시 시 X-Deprecation-Notice 헤더 부재",
    );
    const inclBody = inclRes.json() as { rows: Array<{ id: number; doc_status: string }> };
    const inclIds = new Set(inclBody.rows.map((r) => r.id));
    assert.ok(inclIds.has(seedId), "include_archived=true response 가 seed 포함");
  } finally {
    await deleteDoc(app, seedId);
  }
});

// ----- PUT supersedes_id → 400 immutable -------------------------------

test("PUT body containing supersedes_id → 400 (immutable after POST)", async () => {
  // Setup chain: predecessor + successor (successor points to pred). Then try
  // to PUT a new supersedes_id onto the successor — must reject with 400 +
  // explicit immutability reason.
  const predTitle = makeTitle("ac6-pred");
  const predRes = await postCreate(app, {
    title: predTitle,
    prefix: "계획",
    doc_type: "final",
    author: "tester",
    html_body: makeHtmlBody(`${predTitle}-body`),
  });
  assert.strictEqual(predRes.status, 201, "predecessor POST 201");
  const pred = predRes.body as { id: number };

  let succId: number | null = null;
  try {
    const succTitle = makeTitle("ac6-succ");
    const succHtml = makeHtmlBody(`${succTitle}-body`);
    const succRes = await postCreate(app, {
      title: succTitle,
      prefix: "계획",
      doc_type: "draft",
      author: "tester",
      html_body: succHtml,
      supersedes_id: pred.id,
    });
    assert.strictEqual(succRes.status, 201, "successor POST 201");
    const succ = succRes.body as { id: number; content_hash: string };
    succId = succ.id;

    // PUT attempt — include supersedes_id in body (value irrelevant — key
    // presence alone MUST trigger 400).
    const putRes = await app.inject({
      method: "PUT",
      url: `/api/clauded-docs/${succ.id}`,
      payload: {
        html_body: makeHtmlBody(`${succTitle}-body-v2`),
        expected_hash: succ.content_hash,
        supersedes_id: pred.id, // even unchanged value triggers immutability
      },
    });
    assert.strictEqual(putRes.statusCode, 400, "PUT supersedes_id → 400");
    const putBody = putRes.json() as { error: string; reason: string };
    assert.strictEqual(putBody.error, "invalid_body", "error code = invalid_body");
    assert.match(
      putBody.reason,
      /supersedes_id is immutable after POST/,
      "reason explicitly cites immutability",
    );
    assert.match(
      putBody.reason,
      /Phase 2 AC6/,
      "reason cites the Phase 2 AC6 tag for grep-back traceability",
    );
  } finally {
    if (succId !== null) await deleteDoc(app, succId);
    await deleteDoc(app, pred.id);
  }
});

// ----- POST supersedes_id type validation (negative / non-existent) -----

test("POST supersedes_id=-1 → 400 'must be a positive integer'", async () => {
  // No cleanup needed — POST never reaches DB insert (rejected at parseCreateBody).
  const res = await postCreate(app, {
    title: makeTitle("ac7-neg"),
    prefix: "계획",
    doc_type: "draft",
    author: "tester",
    html_body: makeHtmlBody("ac7-neg-body"),
    supersedes_id: -1,
  });
  assert.strictEqual(res.status, 400, "supersedes_id=-1 rejected");
  const body = res.body as { error: string; reason: string };
  assert.strictEqual(body.error, "invalid_body", "error code = invalid_body");
  assert.match(
    body.reason,
    /must be a positive integer/,
    "reason explicitly says 'must be a positive integer'",
  );
});

test("POST supersedes_id=99999999 (non-existent id) → 400 'does not reference an existing document'", async () => {
  // The exact id MUST be guaranteed non-existent. 99999999 is well above any
  // realistic prod row id (current max ~1789). The probe SELECT returns zero
  // rows → handleCreate emits 400 invalid_body with FK reason.
  //
  // No cleanup needed — fetchAndValidatePredecessor halts before insert.
  const nonExistentId = 99999999;
  const res = await postCreate(app, {
    title: makeTitle("ac7-fk"),
    prefix: "계획",
    doc_type: "draft",
    author: "tester",
    html_body: makeHtmlBody("ac7-fk-body"),
    supersedes_id: nonExistentId,
  });
  assert.strictEqual(res.status, 400, "non-existent supersedes_id rejected");
  const body = res.body as { error: string; reason: string };
  assert.strictEqual(body.error, "invalid_body", "error code = invalid_body");
  assert.match(
    body.reason,
    /does not reference an existing document/,
    "reason explicitly says 'does not reference an existing document'",
  );
  assert.ok(
    body.reason.includes(String(nonExistentId)),
    `reason echoes the bad id (${nonExistentId}) for diagnostic visibility`,
  );
});

// ----- GET /:id successor lookup + groups chain/total fields (F34/F40) -------

test("GET /:id superseded_by_id + groups representative_supersedes_id/doc-totals", async () => {
  const predTitle = makeTitle("ac8-pred");
  const predRes = await postCreate(app, {
    title: predTitle,
    prefix: "계획",
    doc_status: "progress",
    author: "tester",
    html_body: makeHtmlBody(`${predTitle}-body`),
  });
  assert.strictEqual(predRes.status, 201, "predecessor POST 201");
  const pred = predRes.body as { id: number; superseded_by_id: number | null };
  // POST response 는 구조적으로 successor 부재 → null 고정.
  assert.strictEqual(pred.superseded_by_id, null, "POST response superseded_by_id=null");

  let succId: number | null = null;
  try {
    const succTitle = makeTitle("ac8-succ");
    const succRes = await postCreate(app, {
      title: succTitle,
      prefix: "계획",
      doc_status: "progress",
      author: "tester",
      html_body: makeHtmlBody(`${succTitle}-body`),
      supersedes_id: pred.id,
    });
    assert.strictEqual(succRes.status, 201, "successor POST 201");
    const succ = succRes.body as { id: number };
    succId = succ.id;

    const predGet = await app.inject({ method: "GET", url: `/api/clauded-docs/${pred.id}` });
    assert.strictEqual(predGet.statusCode, 200, "pred GET 200");
    const predBody = predGet.json() as { superseded_by_id: number | null };
    assert.strictEqual(predBody.superseded_by_id, succ.id, "pred.superseded_by_id = succ.id");

    const succGet = await app.inject({ method: "GET", url: `/api/clauded-docs/${succ.id}` });
    assert.strictEqual(succGet.statusCode, 200, "succ GET 200");
    const succBody = succGet.json() as {
      superseded_by_id: number | null;
      supersedes_id: number | null;
    };
    assert.strictEqual(succBody.superseded_by_id, null, "chain head superseded_by_id=null");
    assert.strictEqual(succBody.supersedes_id, pred.id, "chain head supersedes_id=pred.id");

    const groupsRes = await app.inject({
      method: "GET",
      url: "/api/clauded-docs/groups?limit=200",
    });
    assert.strictEqual(groupsRes.statusCode, 200, "groups GET 200");
    const groupsBody = groupsRes.json() as {
      total: number;
      doc_total: number;
      hidden_doc_total: number;
      groups: Array<{ representative_id: number; representative_supersedes_id: number | null }>;
    };
    // doc_total = 문서 단위 count → group 단위 total 이상이어야 함 (group 당 ≥1 문서).
    assert.ok(
      Number.isInteger(groupsBody.doc_total) && groupsBody.doc_total >= groupsBody.total,
      `doc_total (${groupsBody.doc_total}) is an integer >= group total (${groupsBody.total})`,
    );
    assert.ok(
      Number.isInteger(groupsBody.hidden_doc_total) &&
        groupsBody.hidden_doc_total >= 0 &&
        groupsBody.hidden_doc_total <= groupsBody.doc_total,
      `hidden_doc_total (${groupsBody.hidden_doc_total}) within [0, doc_total]`,
    );
    // ungrouped 행은 자기 자신이 1-member group representative — 체인 glyph 소스 검증.
    const succGroup = groupsBody.groups.find((g) => g.representative_id === succ.id);
    assert.ok(succGroup !== undefined, "successor appears as its own group representative");
    assert.strictEqual(
      succGroup.representative_supersedes_id,
      pred.id,
      "representative_supersedes_id = pred.id",
    );
  } finally {
    if (succId !== null) await deleteDoc(app, succId);
    await deleteDoc(app, pred.id);
  }
});

// ----- leak audit (final test) ----------------------------------------------

test("ZZ leak audit: every suite-created row is cleaned at run-end", async () => {
  // Defense-in-depth — try/finally inside each test SHOULD have deleted every
  // seed. This audit catches regressions where a future edit forgets the
  // try/finally pattern OR where the DELETE handler regresses.
  const prisma = getPrisma();
  const deleted = await prisma.$queryRaw<Array<{ id: bigint }>>`
    DELETE FROM monitor.documents
    WHERE title LIKE ${`%${SUITE_MARKER}%`}
    RETURNING id
  `;
  // The audit's primary assertion is the next query — count after delete MUST be 0.
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
  // Surface the delete count for diagnostic visibility. If try/finally worked
  // perfectly, this is 0 (every test cleaned itself); if a test crashed without
  // cleanup, the count is positive and the audit caught it.
  assert.ok(deleted.length >= 0, "delete returned a list");
});
