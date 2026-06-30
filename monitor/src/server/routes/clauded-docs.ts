// Clauded-docs API: CRUD + tsvector search for monitor.documents.
//
// Storage model:
//   - meta in Postgres (monitor.documents)
//   - HTML body on FS (HTML primary only — no MD companion)
//   - SHA256(HTML) recorded in DB for integrity + optimistic-lock
//
// Sync write contract:
//   - POST/PUT does NOT respond until the HTML file is durable AND the DB row
//     is committed. No background queue, no eventual consistency.
//   - Order of operations: write HTML → DB insert/update. DB write is last so
//     a row never points at a path that does not exist.
//   - DB: single-statement Prisma $queryRaw — row-level atomicity is sufficient.
//   - FS: temp-file + POSIX rename(2) atomic write. On DB failure, rollback via
//     the pre-write snapshot (POST = unlink new file, PUT = rewrite prev content).
//   - md_copy_path stays nullable (deprecated) — rows always store NULL; the
//     column remains in the contract for backwards compatibility.
//
// Security pipeline:
//   - POST/PUT html_body → DOMPurify sanitize first, so SHA256/indexable derive
//     from sanitized HTML. Raw user HTML never touches disk/DB.
//   - GET that returns HTML body applies `Content-Security-Policy: sandbox;
//     frame-ancestors 'self'`. Sanitize policy detail → clauded-docs/sanitize.ts.
//
// Search:
//   - Uses websearch_to_tsquery for user-friendly query syntax (quoted phrases,
//     OR, -negation). Short single-term fallback (pg_trgm word_similarity) is
//     handled at the FE recommend surface, not here.
//
// Errors:
//   - structured envelope `{ error: <code>, ...details }`
//   - 4xx for client problems (validation, conflict, not found, unsupported HTML)
//   - 5xx for server problems (DB unreachable, FS unavailable)
//   - secrets / PII never logged; request id flows through Fastify's request.log

import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { Prisma } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { respondDbFailure } from "../db-failure.js";
import { parseIdParam, parseOffsetParam } from "../route-params.js";
import { extractIndexableText } from "../clauded-docs/indexable-text.js";
import {
  type ExportFormatToken,
  HtmlExportError,
  renderSelfContainedHtml,
} from "../clauded-docs/html-export.js";
import { sanitizeHtmlBody } from "../clauded-docs/sanitize.js";
import { stripIllegalControlChars } from "../clauded-docs/control-chars.js";
import { validateHtmlStructure } from "../clauded-docs/html-validator.js";
import { BIGM_PROBE_SQL, buildSearchSql } from "../clauded-docs/search-sql.js";
import {
  assertPathInsideRoot,
  computeHtmlPath,
  computePlainPath,
  getHtmlBodyRoot,
  getHtmlRoot,
  pathExists,
  type PlainExtensionToken,
  readFileUtf8,
  removeFileIfExists,
  sha256Hex,
  slugifyTitle,
  writeFileAtomic,
} from "../clauded-docs/storage.js";
// archiver 8.x = native ESM exporting NAMED classes (ZipArchive/TarArchive/...)
// — NO default + NO vending fn. @types/archiver 7.x is STALE (describes the v6
// `export = archiver` callable). Use the namespace import for runtime access to
// ZipArchive; cast to the stale `archiver.Archiver` interface (append/finalize/
// on/destroy shape still matches v8 instance). Node 24 ESM: namespace import is
// the only safe form — `import archiver from "archiver"` would throw at runtime.
import * as archiverNs from "archiver";
import type archiver from "archiver"; // type-only — ArchiverOptions/Archiver interface
import type {
  AudienceLiteral,
  ClaudedDocGroup,
  ClaudedDocSummary,
  ClaudedDocsErrorBody,
  CreateClaudedDocBody,
  DeleteClaudedDocResponse,
  DocFormatToken,
  DocStatusLiteral,
  GetClaudedDocResponse,
  GroupClaudedDocsBody,
  GroupClaudedDocsResponse,
  HtmlExportManifestEntry,
  ListClaudedDocsGroupsQuery,
  ListClaudedDocsGroupsResponse,
  ListClaudedDocsQuery,
  ListClaudedDocsResponse,
  MoveGroupBody,
  MoveGroupResponse,
  ReorderGroupBody,
  ReorderGroupResponse,
  SearchClaudedDocHit,
  SearchClaudedDocsQuery,
  SearchClaudedDocsResponse,
  UngroupClaudedDocsBody,
  UngroupClaudedDocsResponse,
  UpdateClaudedDocBody,
} from "../types/clauded-docs.js";

// format derives directly from which body field is provided; audience is a 2-value exposure bit.

const ALLOWED_FORMATS: ReadonlySet<DocFormatToken> = new Set<DocFormatToken>([
  "html", "md", "yaml", "json", "txt",
]);

// DocStatus 2-value workflow ('progress' = DB DEFAULT). PUT doc_status cascades
// to all rows sharing folder_id (handleUpdate CTE).
const ALLOWED_DOC_STATUSES: ReadonlySet<DocStatusLiteral> = new Set<DocStatusLiteral>([
  "progress",
  "done",
]);

/**
 * Body-kind-based default for the exposure bit.
 *   - html → 'exposed' (shown in monitor UI)
 *   - plain (md/yaml/json/txt) → 'hidden' (agent-only record)
 * An explicit caller-provided audience wins; this only supplies the default.
 */
function exposureForFormat(format: DocFormatToken): AudienceLiteral {
  return format === "html" ? "exposed" : "hidden";
}

/**
 * file extension → DocFormatToken, the single SoT (no `format` DB column).
 * `.yml` also reads as yaml; new writes use `.yaml`. Unknown extension →
 * 'html' fallback (legacy-row defensive).
 */
function formatFromPath(path: string): DocFormatToken {
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".md")) return "md";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".txt")) return "txt";
  return "html";
}

/**
 * DocFormatToken → file extension (no leading dot). html is excluded from the
 * input because computeHtmlPath handles it; callers branch before calling.
 */
function plainExtensionFor(format: Exclude<DocFormatToken, "html">): PlainExtensionToken {
  return format;
}

// Allowed exposure-bit values. Invalid value → 400 (no silent fallback). Legacy
// DB values (ops/public/agent-only) are absorbed read-side by normalizeAudience.
const ALLOWED_AUDIENCES: ReadonlySet<AudienceLiteral> = new Set<AudienceLiteral>([
  "exposed",
  "hidden",
]);

// Pagination caps.
const LIST_LIMIT_MAX = 200;
const LIST_LIMIT_DEFAULT = 50;
const SEARCH_LIMIT_MAX = 100;
const SEARCH_LIMIT_DEFAULT = 20;
const Q_MAX_LENGTH = 500;
const TITLE_MAX_LENGTH = 500;
const AUTHOR_MAX_LENGTH = 64;
const HTML_BODY_MAX_LENGTH = 5_000_000; // 5 MB raw HTML — beyond this is suspicious
const MD_BODY_MAX_LENGTH = 2_000_000; // 2 MB MD payload — conservative cap

// Header value MUST be visible ASCII only (RFC 7230 §3.2.6) — no em-dash / arrow /
// Korean. node:http storeHeader throws ERR_INVALID_CHAR on non-ASCII → 500 surface.
const DEPRECATION_NOTICE_INCLUDE_ARCHIVED =
  "default exclusion of archived/superseded - pass ?include_archived=true to restore prior behavior. Effective until 2026-06-05.";

// Slug-collision retry cap. With 1000 distinct documents sharing a 80-char
// slug stem the entropy is exhausted; we surface 500 to ops.
const SLUG_COLLISION_MAX_TRIES = 1000;

// DB row shape

interface ClaudedDocDbRow {
  id: bigint;
  title: string;
  author: string;
  created_at: Date;
  content_hash: string;
  html_path: string;
  md_copy_path: string | null;
  last_synced_at: Date | null;
  // raw exposure bit — exposed/hidden (new) or legacy ops/public/agent-only.
  // read-side computeResponseAudience normalizes by format (DB column keeps NULL/legacy).
  audience: string | null;
  inserted_at: Date;
  // self-ref FK to predecessor. NULL = chain root · BigInt = predecessor id (ON DELETE SET NULL).
  supersedes_id: bigint | null;
  // workflow status (NOT NULL DEFAULT 'progress'). group cascade target (all rows sharing folder_id).
  doc_status: string;
  // group folder linkage. NULL = ungrouped · BigInt = root doc id (FK ON DELETE SET NULL).
  // self-reference allowed (root row where folder_id == id).
  folder_id: bigint | null;
  // explicit 0-based position within group. NULL = unset (created_at fallback).
  display_order: number | null;
}

interface CountRow {
  total: bigint;
}

// Single SoT for the column list (SELECT + INSERT/UPDATE/DELETE RETURNING).
// Updating only this constant keeps every site in sync (drift guard); 1:1 with
// ClaudedDocDbRow. doc_status surfaces as string via ::text cast (the mapper narrows).
const CLAUDED_DOC_SELECT_COLUMNS: Prisma.Sql = Prisma.sql`
  id, title, author, created_at,
  content_hash, html_path, md_copy_path,
  last_synced_at, audience, inserted_at, supersedes_id,
  doc_status::text AS doc_status, folder_id, display_order
`;

interface SearchHitDbRow {
  id: bigint;
  title: string;
  author: string;
  created_at: Date;
  // list-row parity fields — same derivation as the handleList SELECT (drift guard):
  //   - doc_status : ::text cast then DocStatusLiteral narrow
  //   - audience   : raw nullable → computeResponseAudience(audience, formatFromPath(html_path))
  //   - html_path  : extension → formatFromPath → DocFormatToken
  doc_status: string;
  audience: string | null;
  html_path: string;
  // ts_rank_cd weighted (title=A, author=B, body=D), normalization mode 32 (length-divided).
  lexical_rank: number;
  // pg_bigm bigm_similarity(indexable_text, q) — 0::float8 fallback when extension absent.
  bigm_rank: number;
  snippet: string;
}

// pg_bigm availability — detected once at startup, then immutable; detect before
// route registration. null = not yet detected · true/false = detection result.
// module-private; the public API is detectBigmExtensionOnce + isBigmEnabled.
let bigmEnabledState: boolean | null = null;

export async function registerClaudedDocsRoutes(app: FastifyInstance): Promise<void> {
  // Detect pg_bigm once at startup. On failure routes still register and fall back
  // to tsvector alone; an explicit warn logs the absence (no silent fallback).
  await detectBigmExtensionOnce(app);

  // Literal-first registration order — every literal segment ("search", "groups",
  // "group", "ungroup", "html-export") MUST register before bare `/:id` so Fastify's
  // radix tree routes it to the dedicated handler instead of treating it as a numeric id.
  app.get("/api/clauded-docs/search", handleSearch);
  app.get("/api/clauded-docs/groups", handleListGroups);
  app.post("/api/clauded-docs/group", handleGroupCreate);
  app.post("/api/clauded-docs/ungroup", handleUngroup);
  // /group prefix + literal "reorder" suffix distinguishes from /:id radix.
  app.patch("/api/clauded-docs/group/:rootId/reorder", handleReorderGroup);
  app.patch("/api/clauded-docs/:id/move-group", handleMoveGroup);
  app.post("/api/clauded-docs/html-export", handleHtmlExportMulti);
  app.get("/api/clauded-docs", handleList);
  app.post("/api/clauded-docs", handleCreate);
  app.get("/api/clauded-docs/:id/html-export", handleHtmlExportSingle);
  app.get("/api/clauded-docs/:id", handleGet);
  app.put("/api/clauded-docs/:id", handleUpdate);
  app.delete("/api/clauded-docs/:id", handleDelete);
}

/**
 * Detect pg_bigm availability once at startup; cache immutably in a module-private var.
 * - present → bigmEnabledState=true · OR-branch active
 * - absent  → bigmEnabledState=false · warn log + tsvector-only fallback
 * - probe failure (DB down, etc.) → bigmEnabledState=false · error log + tsvector
 *   fallback; does not block route registration — search must still work (degraded mode).
 */
async function detectBigmExtensionOnce(app: FastifyInstance): Promise<void> {
  // Re-entrancy guard — never re-run once detected (immutability).
  if (bigmEnabledState !== null) return;

  const prisma = getPrisma();
  try {
    const rows = await prisma.$queryRaw<Array<{ present: number }>>(BIGM_PROBE_SQL);
    const present = rows.length > 0;
    bigmEnabledState = present;
    if (present) {
      app.log.info(
        { extension: "pg_bigm", route: "/api/clauded-docs/search" },
        "pg_bigm extension detected — Korean substring search OR-branch active",
      );
    } else {
      app.log.warn(
        { extension: "pg_bigm", route: "/api/clauded-docs/search" },
        "pg_bigm extension not installed — search falls back to tsvector only (Korean substring quality reduced). Install hint: see prisma/migrations/*_clauded_doc_bigm_search/migration.sql header",
      );
    }
  } catch (error) {
    // DB unreachable etc. — do not block routes, but log the fallback explicitly.
    bigmEnabledState = false;
    app.log.error(
      { err: error, route: "/api/clauded-docs/search" },
      "pg_bigm detection probe failed — defaulting to tsvector-only fallback",
    );
  }
}

/**
 * Detected pg_bigm availability. Handlers call this per request; the value never
 * changes. Returns false until detectBigmExtensionOnce runs (safe default — no
 * bigm-dependent SQL generated).
 */
function isBigmEnabled(): boolean {
  return bigmEnabledState === true;
}

// POST /api/clauded-docs

async function handleCreate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<GetClaudedDocResponse | ClaudedDocsErrorBody> {
  const parsed = parseCreateBody(request.body);
  if (typeof parsed === "string") {
    return reply.code(400).send({ error: "invalid_body", reason: parsed });
  }
  // body-kind decides format directly:
  //   format=html → HTML primary (sanitize + structure validate + CSP)
  //   format=md|yaml|json|txt → plain primary (no sanitize, no CSP, raw write)
  // parseCreateBody pre-validates (audience, format), so this dispatch sees only valid input.
  const audience: AudienceLiteral | null = parsed.parsed.audience ?? null;

  let supersedesId: bigint | null = null;
  if (parsed.parsed.supersedes_id !== undefined) {
    const predecessorCheck = await fetchAndValidatePredecessor(
      request, reply, parsed.parsed.supersedes_id,
    );
    if (predecessorCheck === null) return reply as never;
    supersedesId = predecessorCheck;
  }

  if (parsed.format === "html") {
    request.log.info(
      {
        route: "/api/clauded-docs", method: "POST", audience,
        supersedesId: supersedesId === null ? null : bigintToNumber(supersedesId),
        routing: "html_primary",
      },
      "format routing: HTML primary",
    );
    return handleCreateHtmlBody(request, reply, parsed.parsed, parsed.body, supersedesId);
  }
  request.log.info(
    {
      route: "/api/clauded-docs", method: "POST",
      audience, format: parsed.format,
      supersedesId: supersedesId === null ? null : bigintToNumber(supersedesId),
      routing: "plain_primary",
    },
    "format routing: plain primary",
  );
  return handleCreatePlainBody(request, reply, parsed.parsed, parsed.format, parsed.body, supersedesId);
}

/**
 * Fetch + existence-validate the predecessor row. Same-topic supersede is the
 * authoring agent's responsibility (not server-enforced); this only handles
 * existence and the CTE auto-transition input.
 *
 * Missing row → 400 (explicit message preferred over an FK violation). An
 * already-superseded predecessor is idempotently allowed.
 *
 * Returns:
 *   - bigint : validated predecessor id (CTE branch input)
 *   - null   : reply.code(400).send(...) already sent — caller does `return reply as never`
 */
async function fetchAndValidatePredecessor(
  request: FastifyRequest,
  reply: FastifyReply,
  supersedesIdRaw: number,
): Promise<bigint | null> {
  const prisma = getPrisma();
  const targetId = BigInt(supersedesIdRaw);
  let predecessor: { id: bigint } | undefined;
  try {
    const rows = await prisma.$queryRaw<Array<{ id: bigint }>>`
      SELECT id
      FROM monitor.documents
      WHERE id = ${targetId}
      LIMIT 1
    `;
    predecessor = rows[0];
  } catch (error) {
    failWithDb(request, reply, "/api/clauded-docs (POST supersedes_id probe)", error);
    return null;
  }
  if (predecessor === undefined) {
    reply.code(400).send({
      error: "invalid_body",
      reason: `supersedes_id ${supersedesIdRaw} does not reference an existing document`,
    });
    return null;
  }
  request.log.info(
    {
      route: "/api/clauded-docs", method: "POST",
      predecessorId: supersedesIdRaw,
    },
    "predecessor validation passed — CTE auto-transition will fire on insert",
  );
  return predecessor.id;
}

/**
 * HTML primary flow.
 * sanitize → structure validate → SHA256 + indexable plaintext → FS atomic write → DB insert.
 *
 * audience(exposure) is already decided by parseCreateBody and passed in as
 * `parsed.audience`; this function stores it verbatim (no re-extraction).
 * Unset → null (read-side default).
 */
async function handleCreateHtmlBody(
  request: FastifyRequest,
  reply: FastifyReply,
  parsed: CreateClaudedDocBody,
  htmlBody: string,
  // validated predecessor id (null = chain root). When set, insertClaudedDocRow
  // auto-transitions predecessor doc_status='done' in a single-statement CTE.
  supersedesId: bigint | null,
): Promise<GetClaudedDocResponse | ClaudedDocsErrorBody> {
  const start = Date.now();

  const audience: AudienceLiteral | null = parsed.audience ?? null;

  const sanitized = sanitizeCreateBody(request, reply, htmlBody);
  if (sanitized === null) return reply as never;

  // Order (C4): sanitize → STRUCTURE VALIDATE → convert → store. Validation
  // runs on sanitized HTML so DOMPurify's script/event-handler removal cannot
  // mask a missing element. Raw input is passed for the doctype + charset
  // checks because DOMPurify strips both (declaration / <meta> tag).
  const structureOk = validateStructureOrReply(reply, { raw: htmlBody, sanitized });
  if (!structureOk) return reply as never;

  const conversion = convertForStorageOrReply(request, reply, sanitized);
  if (conversion === null) return reply as never;

  const createdAt = new Date();
  const prisma = getPrisma();
  const dupCheck = await checkDuplicateContent(request, reply, prisma, conversion.contentHash);
  if (dupCheck !== "ok") return dupCheck;

  const slugResult = await pickAvailableSlug(request, reply, parsed.title, createdAt, "html");
  if (slugResult === null) return reply as never;
  const { bodyPath } = slugResult;

  try {
    await writeFileAtomic(bodyPath, sanitized, { overwrite: false });
  } catch (error) {
    return failWithFs(request, reply, "/api/clauded-docs (POST)", error);
  }

  let inserted: ClaudedDocDbRow;
  try {
    inserted = await insertClaudedDocRow(prisma, {
      parsed, createdAt, conversion, bodyPath, audience, supersedesId,
      // FK enforced by INSERT constraint (missing folder_id → 23503 → failWithDb → 400 invalid_input).
      docStatus: parsed.doc_status ?? "progress",
      folderId: parsed.folder_id === undefined ? null : BigInt(parsed.folder_id),
    });
  } catch (error) {
    // Best-effort unlink — HTML write succeeded (else we returned above) so we
    // must remove the orphan before reporting DB failure.
    await removeFileIfExists(bodyPath).catch(() => {});
    return failWithDb(request, reply, "/api/clauded-docs (POST)", error);
  }

  request.log.info(
    {
      route: "/api/clauded-docs", method: "POST",
      id: bigintToNumber(inserted.id), bodyPath,
      audience,
      supersedesId: supersedesId === null ? null : bigintToNumber(supersedesId),
      durationMs: Date.now() - start,
    },
    "clauded-doc created (html primary)",
  );

  reply.code(201);
  applyHtmlBodyCspHeader(reply);
  return rowToDetailResponse(inserted, "html", sanitized);
}

/**
 * Unified plain primary flow (md / yaml / json / txt body kind).
 * SHA256 + indexable plaintext → FS atomic write (extension = format) → DB insert.
 *
 * No sanitize / structure validate / CSP header — plain payload has no DOM context.
 *
 * indexable_text: md → extractMdIndexableText (frontmatter strip) · yaml/json/txt → raw body.
 *
 * audience(exposure) decided by parseCreateBody — unset → null (read-side plain default 'hidden').
 */
async function handleCreatePlainBody(
  request: FastifyRequest,
  reply: FastifyReply,
  parsed: CreateClaudedDocBody,
  format: Exclude<DocFormatToken, "html">,
  rawBody: string,
  supersedesId: bigint | null,
): Promise<GetClaudedDocResponse | ClaudedDocsErrorBody> {
  const start = Date.now();

  // Strip illegal control chars before hash/index/write so plain bodies are
  // JSON-safe on GET (plain has no sanitize step — clauded-docs/control-chars.ts).
  const body = stripIllegalControlChars(rawBody);

  const audience: AudienceLiteral | null = parsed.audience ?? null;

  const conversion: ConversionResult = {
    contentHash: sha256Hex(body),
    indexableText: format === "md" ? extractMdIndexableText(body) : body,
  };

  const createdAt = new Date();
  const prisma = getPrisma();
  const dupCheck = await checkDuplicateContent(request, reply, prisma, conversion.contentHash);
  if (dupCheck !== "ok") return dupCheck;

  const slugResult = await pickAvailableSlug(request, reply, parsed.title, createdAt, format);
  if (slugResult === null) return reply as never;
  const { bodyPath } = slugResult;

  try {
    await writeFileAtomic(bodyPath, body, { overwrite: false });
  } catch (error) {
    return failWithFs(request, reply, `/api/clauded-docs (POST ${format})`, error);
  }

  let inserted: ClaudedDocDbRow;
  try {
    inserted = await insertClaudedDocRow(prisma, {
      parsed, createdAt, conversion, bodyPath, audience, supersedesId,
      docStatus: parsed.doc_status ?? "progress",
      folderId: parsed.folder_id === undefined ? null : BigInt(parsed.folder_id),
    });
  } catch (error) {
    await removeFileIfExists(bodyPath).catch(() => {});
    return failWithDb(request, reply, `/api/clauded-docs (POST ${format})`, error);
  }

  request.log.info(
    {
      route: "/api/clauded-docs", method: "POST",
      id: bigintToNumber(inserted.id), bodyPath, audience, format,
      supersedesId: supersedesId === null ? null : bigintToNumber(supersedesId),
      durationMs: Date.now() - start,
    },
    "clauded-doc created (plain primary)",
  );

  reply.code(201);
  // No CSP header — plain response (md/yaml/json/txt) is a non-HTML body.
  return rowToDetailResponse(inserted, format, body);
}

// GET /api/clauded-docs

async function handleList(
  request: FastifyRequest<{ Querystring: ListClaudedDocsQuery }>,
  reply: FastifyReply,
): Promise<ListClaudedDocsResponse | ClaudedDocsErrorBody> {
  const start = Date.now();

  const author =
    typeof request.query.author === "string" && request.query.author.length > 0
      ? request.query.author.slice(0, AUTHOR_MAX_LENGTH)
      : null;

  const limit = parseLimitParam(request.query.limit, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT);
  if (limit === null) {
    return reply.code(400).send({ error: "invalid_param", param: "limit" });
  }
  const offset = parseOffsetParam(request.query.offset);
  if (offset === null) {
    return reply.code(400).send({ error: "invalid_param", param: "offset" });
  }

  // Lifecycle classification removed — this toggle is backward-compat plumbing only (keeps the header).
  const includeArchived = parseBooleanParam(request.query.include_archived);
  const excludingArchived = !includeArchived;

  // folder_id filter (group member detail fetch). non-integer / negative / 0 → 400 (no silent ignore).
  const folderIdRaw = request.query.folder_id;
  let folderIdParam: number | null = null;
  if (typeof folderIdRaw === "string" && folderIdRaw.length > 0) {
    const parsedFolderId = parseIdParam(folderIdRaw);
    if (parsedFolderId === null) {
      return reply.code(400).send({ error: "invalid_param", param: "folder_id" });
    }
    folderIdParam = parsedFolderId;
  }

  const fragments: Prisma.Sql[] = [];
  if (author !== null) {
    fragments.push(Prisma.sql`author = ${author}`);
  }
  if (folderIdParam !== null) {
    fragments.push(Prisma.sql`folder_id = ${BigInt(folderIdParam)}`);
  }
  const where = fragments.length === 0 ? Prisma.empty : Prisma.join(fragments, " AND ", "WHERE ");

  // ?folder_id=X (group member detail) → order by explicit display_order, NULL falls back to created_at.
  // plain list (no folder_id) → created_at DESC, id DESC.
  const orderBy = folderIdParam !== null
    ? Prisma.sql`ORDER BY display_order ASC NULLS LAST, created_at ASC, id ASC`
    : Prisma.sql`ORDER BY created_at DESC, id DESC`;

  const prisma = getPrisma();
  try {
    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw<ClaudedDocDbRow[]>`
        SELECT ${CLAUDED_DOC_SELECT_COLUMNS}
        FROM monitor.documents
        ${where}
        ${orderBy}
        LIMIT ${limit}
        OFFSET ${offset}
      `,
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::bigint AS total FROM monitor.documents ${where}
      `,
    ]);

    const totalRow = countRows[0];
    if (totalRow === undefined) {
      throw new Error("count query returned no row");
    }
    const total = bigintToNumber(totalRow.total);

    const summaries: ClaudedDocSummary[] = rows.flatMap((row) => {
      // doc_status drift defensive — exclude rows with an unknown value.
      if (!ALLOWED_DOC_STATUSES.has(row.doc_status as DocStatusLiteral)) return [];
      return [
        {
          id: bigintToNumber(row.id),
          title: row.title,
          author: row.author,
          created_at: row.created_at.toISOString(),
          content_hash: row.content_hash,
          html_path: row.html_path,
          md_copy_path: row.md_copy_path,
          last_synced_at: row.last_synced_at === null ? null : row.last_synced_at.toISOString(),
          audience: computeResponseAudience(row.audience, formatFromPath(row.html_path)),
          format: formatFromPath(row.html_path),
          supersedes_id: row.supersedes_id === null ? null : bigintToNumber(row.supersedes_id),
          doc_status: row.doc_status as DocStatusLiteral,
          folder_id: row.folder_id === null ? null : bigintToNumber(row.folder_id),
          display_order: row.display_order,
        },
      ];
    });

    request.log.info(
      {
        route: "/api/clauded-docs",
        method: "GET",
        rowCount: summaries.length,
        total,
        excludingArchived,
        durationMs: Date.now() - start,
      },
      "clauded-docs list complete",
    );

    // `?include_archived=true` is itself a deprecation alias — emit the cleanup header when omitted.
    if (excludingArchived) {
      reply.header("X-Deprecation-Notice", DEPRECATION_NOTICE_INCLUDE_ARCHIVED);
    }

    return {
      total,
      rows: summaries,
      filter: {
        author,
        limit,
        offset,
      },
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs (GET)", error);
  }
}

// GET /api/clauded-docs/groups — folder grouping list
//
// Query: doc_status · author · include_archived · limit (default 50 · max 200) · offset.
// Filter composes at doc-level — only matching docs are clustered then grouped.
//
// Response: split-path UNION ALL:
//   - grouped (folder_id NOT NULL) → DISTINCT ON (folder_id) + COUNT(*) WHERE folder_id = $1
//   - ungrouped (folder_id NULL)  → 1-member group per row (group_key = -id, count=1)
// Total count = COUNT(DISTINCT COALESCE(folder_id, -id)) — separate query.
async function handleListGroups(
  request: FastifyRequest<{ Querystring: ListClaudedDocsGroupsQuery }>,
  reply: FastifyReply,
): Promise<ListClaudedDocsGroupsResponse | ClaudedDocsErrorBody> {
  const start = Date.now();

  const docStatusParam = parseEnumParam<DocStatusLiteral>(
    request.query.doc_status, ALLOWED_DOC_STATUSES,
  );
  if (docStatusParam === "INVALID") {
    return reply.code(400).send({
      error: "invalid_param", param: "doc_status", allowed: Array.from(ALLOWED_DOC_STATUSES),
    });
  }

  const author =
    typeof request.query.author === "string" && request.query.author.length > 0
      ? request.query.author.slice(0, AUTHOR_MAX_LENGTH)
      : null;

  // 50 groups/page default.
  const limit = parseLimitParam(request.query.limit, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT);
  if (limit === null) {
    return reply.code(400).send({ error: "invalid_param", param: "limit" });
  }
  const offset = parseOffsetParam(request.query.offset);
  if (offset === null) {
    return reply.code(400).send({ error: "invalid_param", param: "offset" });
  }

  const includeArchived = parseBooleanParam(request.query.include_archived);
  const excludingArchived = !includeArchived;

  // doc-level filter fragments — the same fragments must feed both the grouped and
  // ungrouped CTE for cluster consistency (Prisma.sql is immutable, so reuse is safe).
  const fragments: Prisma.Sql[] = [];
  if (docStatusParam !== null) fragments.push(Prisma.sql`doc_status::text = ${docStatusParam}`);
  if (author !== null) fragments.push(Prisma.sql`author = ${author}`);
  const filterClause = fragments.length === 0
    ? Prisma.empty
    : Prisma.join(fragments, " AND ", "WHERE ");

  const prisma = getPrisma();
  try {
    // split-path UNION ALL. grouped_reps surfaces 1 row per group via DISTINCT ON;
    // member_count is a correlated subquery (uses the folder_id partial index).
    // ungrouped synthesizes folder_id-NULL rows as group_key=-id (sort key only).
    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw<GroupedRepRow[]>`
        WITH grouped_reps AS (
          SELECT DISTINCT ON (folder_id)
                 id AS rep_id, title, author,
                 doc_status::text AS doc_status,
                 audience, html_path, created_at, supersedes_id,
                 created_at AS group_latest_at, folder_id AS group_key,
                 (SELECT COUNT(*) FROM monitor.documents d2
                  WHERE d2.folder_id = d.folder_id)::bigint AS member_count
          FROM monitor.documents d
          ${filterClause === Prisma.empty
            ? Prisma.sql`WHERE folder_id IS NOT NULL`
            : Prisma.sql`${filterClause} AND folder_id IS NOT NULL`}
          -- rep pick: the drag-order-first member (lowest display_order) represents the group.
          --   all-NULL display_order group → NULLS LAST ties → created_at DESC fallback (latest = rep).
          ORDER BY folder_id, display_order ASC NULLS LAST, created_at DESC, id DESC
        ),
        ungrouped AS (
          SELECT id AS rep_id, title, author,
                 doc_status::text AS doc_status,
                 audience, html_path, created_at, supersedes_id,
                 created_at AS group_latest_at, -id AS group_key,
                 1::bigint AS member_count
          FROM monitor.documents
          ${filterClause === Prisma.empty
            ? Prisma.sql`WHERE folder_id IS NULL`
            : Prisma.sql`${filterClause} AND folder_id IS NULL`}
        )
        SELECT * FROM grouped_reps
        UNION ALL
        SELECT * FROM ungrouped
        ORDER BY group_latest_at DESC, rep_id DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      prisma.$queryRaw<GroupsCountRow[]>`
        SELECT
          COUNT(DISTINCT COALESCE(folder_id, -id))::bigint AS total,
          COUNT(*)::bigint AS doc_total,
          -- effective-audience hidden — SQL mirror of computeResponseAudience +
          -- formatFromPath (hidden/agent-only explicit · NULL/unknown → plain-format default).
          COUNT(*) FILTER (
            WHERE audience IN ('hidden', 'agent-only')
               OR (
                 (audience IS NULL OR audience NOT IN ('exposed', 'public', 'ops'))
                 AND (html_path LIKE '%.md' OR html_path LIKE '%.yaml' OR html_path LIKE '%.yml'
                      OR html_path LIKE '%.json' OR html_path LIKE '%.txt')
               )
          )::bigint AS hidden_doc_total
        FROM monitor.documents ${filterClause}
      `,
    ]);

    const totalRow = countRows[0];
    if (totalRow === undefined) {
      throw new Error("groups count query returned no row");
    }
    const total = bigintToNumber(totalRow.total);
    const docTotal = bigintToNumber(totalRow.doc_total);
    const hiddenDocTotal = bigintToNumber(totalRow.hidden_doc_total);

    const groups: ClaudedDocGroup[] = rows.flatMap((row) => {
      // doc_status drift defensive — exclude rows with an unknown value.
      if (!ALLOWED_DOC_STATUSES.has(row.doc_status as DocStatusLiteral)) return [];
      return [{
        // group_key is an internal sort key — not surfaced in the response.
        folder_id: row.group_key > 0n ? bigintToNumber(row.group_key) : null,
        representative_id: bigintToNumber(row.rep_id),
        representative_title: row.title,
        representative_author: row.author,
        representative_doc_status: row.doc_status as DocStatusLiteral,
        representative_audience: computeResponseAudience(row.audience, formatFromPath(row.html_path)),
        representative_format: formatFromPath(row.html_path),
        representative_created_at: row.created_at.toISOString(),
        representative_supersedes_id:
          row.supersedes_id === null ? null : bigintToNumber(row.supersedes_id),
        member_count: bigintToNumber(row.member_count),
        group_latest_at: row.group_latest_at.toISOString(),
      }];
    });

    request.log.info(
      {
        route: "/api/clauded-docs/groups", method: "GET",
        groupCount: groups.length, total, excludingArchived,
        durationMs: Date.now() - start,
      },
      "clauded-docs groups list complete",
    );

    if (excludingArchived) {
      reply.header("X-Deprecation-Notice", DEPRECATION_NOTICE_INCLUDE_ARCHIVED);
    }

    return {
      total,
      doc_total: docTotal,
      hidden_doc_total: hiddenDocTotal,
      groups,
      filter: {
        doc_status: docStatusParam,
        author, limit, offset,
      },
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/groups (GET)", error);
  }
}

// Row shape for the split-path UNION ALL query — internal to handleListGroups.
// group_key BIGINT (positive=folder_id · negative=-id synthetic).
interface GroupedRepRow {
  rep_id: bigint;
  title: string;
  author: string;
  doc_status: string;
  audience: string | null;
  html_path: string;
  created_at: Date;
  supersedes_id: bigint | null;
  group_latest_at: Date;
  group_key: bigint;
  member_count: bigint;
}

interface GroupsCountRow {
  total: bigint;
  doc_total: bigint;
  hidden_doc_total: bigint;
}

// GET /api/clauded-docs/:id

async function handleGet(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { format?: string } }>,
  reply: FastifyReply,
): Promise<GetClaudedDocResponse | ClaudedDocsErrorBody> {
  const start = Date.now();
  const id = parseIdParam(request.params.id);
  if (id === null) {
    return reply.code(400).send({ error: "invalid_param", param: "id" });
  }

  // explicit ?format= → validate now; missing/empty → defer default until after
  // row fetch so it can be derived from html_path extension. Hardcoding "html" for
  // a non-html row would mismatch the metadata + misapply CSP to a plain-text response.
  const formatRaw = request.query.format;
  let format: DocFormatToken | null;
  if (formatRaw === undefined || formatRaw === "") {
    format = null;
  } else if (ALLOWED_FORMATS.has(formatRaw as DocFormatToken)) {
    format = formatRaw as DocFormatToken;
  } else {
    return reply.code(400).send({
      error: "invalid_param",
      param: "format",
      allowed: Array.from(ALLOWED_FORMATS),
    });
  }

  const prisma = getPrisma();
  let row: ClaudedDocDbRow | undefined;
  let supersededById: number | null = null;
  try {
    // Successor probe runs alongside the row fetch — latest row pointing here wins
    // (multi-successor is contractually a same-topic revision chain; newest = current).
    const [rows, successorRows] = await Promise.all([
      prisma.$queryRaw<ClaudedDocDbRow[]>`
        SELECT ${CLAUDED_DOC_SELECT_COLUMNS}
        FROM monitor.documents
        WHERE id = ${BigInt(id)}
        LIMIT 1
      `,
      prisma.$queryRaw<Array<{ id: bigint }>>`
        SELECT id
        FROM monitor.documents
        WHERE supersedes_id = ${BigInt(id)}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
    ]);
    row = rows[0];
    const successor = successorRows[0];
    supersededById = successor === undefined ? null : bigintToNumber(successor.id);
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/:id (GET)", error);
  }
  if (row === undefined) {
    reply.code(404);
    return { error: "not_found", id };
  }

  // Path traversal defense — DB-stored paths are trusted in principle (only
  // the route layer writes them), but verify anyway so a corrupted row cannot
  // exfiltrate arbitrary files.
  //
  // format branching is decided by the row's actual body type (file extension,
  // `formatFromPath` SoT).
  const rowFormat = formatFromPath(row.html_path);
  // Default derives from the row type. An explicit ?format= query is honored.
  if (format === null) {
    format = rowFormat;
  }
  let targetPath: string | null;
  const rootForCheck = getHtmlRoot();
  // Cross-format requests that previously resolved to a (now-removed) companion
  // body have no body to serve → 404. These are: ?format=html on a non-html row,
  // and ?format=md on an html row. Every other request serves the row's own body.
  const wantsMissingCompanion =
    (format === "html" && rowFormat !== "html") ||
    (format === "md" && rowFormat === "html");
  if (wantsMissingCompanion) {
    targetPath = null;
  } else {
    // normal path — the body the row holds, as-is (plain or html).
    targetPath = row.html_path;
  }
  if (targetPath === null) {
    // Requested format but no matching body present.
    reply.code(404);
    return { error: "not_found", id };
  }
  try {
    assertPathInsideRoot(targetPath, rootForCheck);
  } catch (error) {
    request.log.error({ err: error, id, targetPath }, "stored path escapes root");
    return reply.code(500).send({ error: "internal" });
  }

  let body: string;
  try {
    body = await readFileUtf8(targetPath);
  } catch (error) {
    return failWithFs(request, reply, "/api/clauded-docs/:id (GET)", error);
  }
  // Read-side defense-in-depth net for rows stored before the write-side strip
  // guard, whose on-disk bytes may still carry raw C0/C1 control chars — without
  // this a strict JSON serializer emits an invalid `body` string and every
  // `curl | jq` consumer breaks. Gated behind a cheap stateless presence pre-test
  // (clauded-docs/control-chars.ts) so a clean body on this GET-polled route pays
  // no scan-and-allocate cost.
  body = stripIllegalControlChars(body);

  request.log.info(
    {
      route: "/api/clauded-docs/:id",
      method: "GET",
      id,
      format,
      bodyLength: body.length,
      durationMs: Date.now() - start,
    },
    "clauded-doc fetched",
  );

  // The response envelope is always JSON (`GetClaudedDocResponse` — body is a string
  // field inside it). Fastify auto-sets application/json on object return — no
  // Content-Type override. CSP still protects the viewer path that renders the
  // envelope's HTML body directly in a sandbox iframe (`<iframe srcdoc>` etc.);
  // plain format has no DOM context so it is unnecessary.
  if (format === "html") {
    applyHtmlBodyCspHeader(reply);
  }

  return rowToDetailResponse(row, format, body, supersededById);
}

/** Returns the doc row, OR null when reply already populated (404/503). */
async function getDocRowById(
  request: FastifyRequest,
  reply: FastifyReply,
  id: number,
): Promise<ClaudedDocDbRow | null> {
  const prisma = getPrisma();
  let row: ClaudedDocDbRow | undefined;
  try {
    const rows = await prisma.$queryRaw<ClaudedDocDbRow[]>`
      SELECT ${CLAUDED_DOC_SELECT_COLUMNS}
      FROM monitor.documents
      WHERE id = ${BigInt(id)}
      LIMIT 1
    `;
    row = rows[0];
  } catch (error) {
    failWithDb(request, reply, "/api/clauded-docs/:id/html-export", error);
    return null;
  }
  if (row === undefined) {
    reply.code(404).send({ error: "not_found", id });
    return null;
  }
  return row;
}

// RFC 5987 attr-char set — chars that DO NOT require percent-encoding inside an
// ext-value. encodeURIComponent already escapes everything outside its own
// unreserved set, but it leaves `!*'()` raw (RFC 3986 sub-delims that RFC 5987
// excludes from attr-char) — escape those too so the ext-value stays strictly
// token-safe per the grammar.
const RFC5987_EXTRA_ESCAPE: ReadonlyMap<string, string> = new Map([
  ["!", "%21"],
  ["*", "%2A"],
  ["'", "%27"],
  ["(", "%28"],
  [")", "%29"],
]);

/**
 * Percent-encodes `value` for an RFC 5987 ext-value (filename*). Output is
 * guaranteed ASCII — every byte > 0x7F is UTF-8 percent-encoded by
 * encodeURIComponent; the residual sub-delims are escaped via the map above.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (ch) => RFC5987_EXTRA_ESCAPE.get(ch) ?? ch,
  );
}

// GET /api/clauded-docs/:id/html-export — single-doc offline self-contained HTML
//
// Render the stored sanitized body via Playwright into an OFFLINE self-contained
// single .html. A non-HTML row gets a minimal dark shell wrap (no browser).
// Render contract → clauded-docs/html-export.ts.
//
// CRITICAL INVARIANT — rendered result holds live <svg> → never re-apply
// sanitizeHtmlBody (sanitize.ts FORBID_TAGS strips svg → diagrams destroyed);
// this handler calls no sanitizer beyond the stored body read.
//
// error mapping:
//   - missing row             → 404 {error:not_found,id}
//   - stored-file read failure → 503 {error:filesystem_unavailable,reason:html_export_read: <msg>}
//   - path-escape / unknown   → 500 {error:internal}
//   - HtmlExportError(stage)  → 503 {error:filesystem_unavailable,reason:html_export_<stage>: <msg>}
//
// ETag: sha256(storedBody + "|html-export-v1") quoted · If-None-Match → 304.

// ETag salt — render-pipeline version id. Bump on render-logic/driver changes to invalidate cache.
const HTML_EXPORT_ETAG_SALT = "|html-export-v1";

// Per-request id cap for multi-export — over 50 is rejected 400 before launching the browser (resource guard).
const MULTI_EXPORT_MAX_IDS = 50;

async function handleHtmlExportSingle(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<string | ClaudedDocsErrorBody> {
  const start = Date.now();
  const id = parseIdParam(request.params.id);
  if (id === null) {
    return reply.code(400).send({ error: "invalid_param", param: "id" });
  }

  const row = await getDocRowById(request, reply, id);
  if (row === null) return reply as never;

  // Path-escape (corrupted row) → 500 internal · stored-file read failure → 503
  // html_export_read. Separate try blocks because the two failures must be distinguished.
  try {
    assertPathInsideRoot(row.html_path, getHtmlRoot());
  } catch (error) {
    request.log.error({ err: error, id, htmlPath: row.html_path }, "html export — stored path escapes root");
    return reply.code(500).send({ error: "internal" });
  }

  let storedBody: string;
  try {
    storedBody = await readFileUtf8(row.html_path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown filesystem error";
    request.log.error({ err: error, route: "/api/clauded-docs/:id/html-export", id }, "html export — stored body read failed");
    reply.code(503);
    return { error: "filesystem_unavailable", reason: `html_export_read: ${reason}` };
  }

  // ETag is keyed on stored body + pipeline-version salt — unchanged body → 304.
  const etag = `"${sha256Hex(`${storedBody}${HTML_EXPORT_ETAG_SALT}`)}"`;
  const ifNoneMatch = request.headers["if-none-match"];
  if (typeof ifNoneMatch === "string" && ifNoneMatch === etag) {
    reply.header("ETag", etag);
    return reply.code(304).send();
  }

  const format = exportFormatFromPath(row.html_path);
  let rendered: string;
  try {
    rendered = await renderSelfContainedHtml(storedBody, format);
  } catch (error) {
    return failWithHtmlExport(request, reply, id, error);
  }

  reply.header("Content-Type", "text/html; charset=utf-8");
  reply.header("Content-Disposition", buildHtmlExportContentDisposition(row));
  reply.header("ETag", etag);
  reply.header("Cache-Control", "private, max-age=0, must-revalidate");

  request.log.info(
    {
      route: "/api/clauded-docs/:id/html-export",
      id,
      format,
      sizeBytes: Buffer.byteLength(rendered, "utf8"),
      durationMs: Date.now() - start,
    },
    "clauded-doc html exported",
  );

  // NEVER sanitizeHtmlBody — rendered holds live <svg> (svg-strip invariant).
  return reply.code(200).send(rendered);
}

// POST /api/clauded-docs/html-export — multi-export selected docs → single .zip
//
// Render each selected doc to an offline self-contained .html FIRST, then start
// the zip stream. body {ids:number[]} length 1..50. Render SEQUENTIALLY per id
// (one BrowserContext at a time on the shared browser — no Promise.all: resource
// blowup + weakened isolation). Each id → one file <slug-or-doc-id>.html.
// Missing / render-failed ids skip the file but record the reason in _manifest.json.
//
// Render-before-stream keeps the status code free until every doc is decided:
//   - zero includable ids → JSON `export_failed` envelope (404 all-not_found /
//     503 otherwise), NEVER a 200 with a doc-less zip (silent-failure guard —
//     e.g. chromium binary drift after a playwright upgrade).
//   - ≥1 included → 200 zip; X-Included-Count header lets the client warn on a
//     partial export without parsing _manifest.json out of the blob.
//
// Response: application/zip + Content-Disposition attachment filename clauded-docs-<YYYY-MM-DD>.zip.
// Streaming idiom: set headers via reply.header() → reply.send(archive readable) → archive.finalize().
// All headers MUST be set before finalize.

interface HtmlExportMultiBody {
  ids: number[];
}

async function handleHtmlExportMulti(
  request: FastifyRequest<{ Body: unknown }>,
  reply: FastifyReply,
): Promise<unknown> {
  const start = Date.now();
  const parsed = parseHtmlExportMultiBody(request.body);
  if (typeof parsed === "string") {
    return reply.code(400).send({ error: "invalid_body", reason: parsed });
  }
  if (parsed.ids.length > MULTI_EXPORT_MAX_IDS) {
    // Reject before launching the browser — resource guard (>50 → 400 invalid_param param=ids).
    return reply.code(400).send({
      error: "invalid_param",
      param: "ids",
      allowed: [`1..${MULTI_EXPORT_MAX_IDS}`],
    });
  }
  const ids = parsed.ids;

  // Batch-fetch rows for the requested ids (same SELECT columns as handleGet/handleList).
  // DB unavailable → 503 (before zip stream starts, so a normal error envelope is possible).
  const prisma = getPrisma();
  let rows: ClaudedDocDbRow[];
  try {
    const idBigints = ids.map((value) => BigInt(value));
    rows = await prisma.$queryRaw<ClaudedDocDbRow[]>`
      SELECT ${CLAUDED_DOC_SELECT_COLUMNS}
      FROM monitor.documents
      WHERE id = ANY(${idBigints}::bigint[])
    `;
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/html-export (POST)", error);
  }
  const rowById = new Map<number, ClaudedDocDbRow>();
  for (const row of rows) {
    rowById.set(bigintToNumber(row.id), row);
  }

  // SEQUENTIAL render FIRST — no archive/headers yet, so the status code stays
  // free until we know whether ANY doc is includable. One BrowserContext at a
  // time, in input id order (no Promise.all).
  const manifest: HtmlExportManifestEntry[] = [];
  const entries: Array<{ name: string; html: string }> = [];
  const usedNames = new Set<string>();
  for (const id of ids) {
    const row = rowById.get(id);
    if (row === undefined) {
      manifest.push({ id, included: false, reason: "not_found" });
      continue;
    }
    let storedBody: string;
    try {
      assertPathInsideRoot(row.html_path, getHtmlRoot());
      storedBody = await readFileUtf8(row.html_path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "read failed";
      manifest.push({ id, included: false, reason: `read: ${reason}` });
      continue;
    }
    const format = exportFormatFromPath(row.html_path);
    let rendered: string;
    try {
      // One BrowserContext per id (renderSelfContainedHtml creates/closes it internally).
      rendered = await renderSelfContainedHtml(storedBody, format);
    } catch (error) {
      const stage = error instanceof HtmlExportError ? error.stage : "render";
      const reason = error instanceof Error ? error.message : "render failed";
      // Any render failure (incl. mermaid zero-<svg>) → skip + record in manifest (never abort the zip).
      request.log.warn(
        { err: error, route: "/api/clauded-docs/html-export", id, stage },
        "multi html export — per-doc render skipped",
      );
      manifest.push({ id, included: false, reason: `${stage}: ${reason}` });
      continue;
    }
    entries.push({ name: buildZipEntryName(row, usedNames), html: rendered });
    manifest.push({ id, included: true });
  }

  if (entries.length === 0) {
    // ZERO includable docs → JSON error envelope, never a doc-less 200 zip
    // (a 200 + empty zip read as success end-to-end while 0 docs shipped).
    const allMissing = manifest.every((entry) => entry.reason === "not_found");
    const firstFailure = manifest.find((entry) => entry.reason !== undefined);
    request.log.error(
      {
        route: "/api/clauded-docs/html-export",
        method: "POST",
        requested: ids.length,
        manifest,
      },
      "multi html export failed — zero includable docs",
    );
    reply.code(allMissing ? 404 : 503);
    return {
      error: "export_failed",
      reason: firstFailure?.reason ?? "no docs includable",
      requested: ids.length,
      manifest,
    } satisfies ClaudedDocsErrorBody;
  }

  // zip streaming — single Fastify 5 idiom: reply.send(readable).
  // archiver v8: ZipArchive is a named-export class, not a callable factory.
  // Cast via `unknown` so the stale @types/archiver v7 Archiver interface covers
  // append/finalize/on/destroy — runtime shape matches (both extend Transform).
  const archive = new (archiverNs as unknown as {
    ZipArchive: new (options?: archiver.ArchiverOptions) => archiver.Archiver;
  }).ZipArchive({ zlib: { level: 9 } });
  // archive error → log + destroy (200 already sent, so status cannot change).
  archive.on("error", (error) => {
    request.log.error(
      { err: error, route: "/api/clauded-docs/html-export", method: "POST" },
      "zip archive stream error",
    );
    archive.destroy(error);
  });
  // archiver also emits warnings (e.g. stat failure) — unlikely here since this
  // path only string-appends, but log explicitly to avoid silent-swallow.
  archive.on("warning", (warning) => {
    request.log.warn(
      { err: warning, route: "/api/clauded-docs/html-export", method: "POST" },
      "zip archive warning",
    );
  });

  // Set headers before finalize (headers cannot change after the stream's first byte).
  const zipName = `clauded-docs-${todayDateStamp()}.zip`;
  reply.header("Content-Type", "application/zip");
  reply.header("Content-Disposition", `attachment; filename="${zipName}"`);
  reply.header("Cache-Control", "private, max-age=0, must-revalidate");
  // Partial-export signal — client toasts warn when included < requested.
  reply.header("X-Included-Count", String(entries.length));

  for (const entry of entries) {
    archive.append(entry.html, { name: entry.name });
  }
  // top-level _manifest.json — audit of which ids were included/excluded.
  archive.append(JSON.stringify(manifest, null, 2), { name: "_manifest.json" });

  request.log.info(
    {
      route: "/api/clauded-docs/html-export",
      method: "POST",
      requested: ids.length,
      included: entries.length,
      durationMs: Date.now() - start,
    },
    "clauded-docs multi html export streamed",
  );

  // Headers set, return stream + finalize. Fastify pipes the readable as the response.
  // finalize once after all appends (no await — the returned stream is consumed).
  void archive.finalize();
  return reply.send(archive);
}

/** Maps HtmlExportError (launch/render/mermaid/serialize) to a 503 envelope. */
function failWithHtmlExport(
  request: FastifyRequest,
  reply: FastifyReply,
  id: number,
  error: unknown,
): ClaudedDocsErrorBody {
  const stage = error instanceof HtmlExportError ? error.stage : "render";
  const reason = error instanceof Error ? error.message : "html export failed";
  request.log.error(
    { err: error, route: "/api/clauded-docs/:id/html-export", id, stage },
    "html export failed",
  );
  reply.code(503);
  return { error: "filesystem_unavailable", reason: `html_export_${stage}: ${reason}` };
}

/** formatFromPath (DocFormatToken) → ExportFormatToken — safe since both unions share members. */
function exportFormatFromPath(path: string): ExportFormatToken {
  return formatFromPath(path) as ExportFormatToken;
}

/** Local-date stamp YYYY-MM-DD for the zip filename. */
function todayDateStamp(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * zip entry name — slug-based <slug>.html, or doc-<id>.html when no slug.
 * On slug collision, usedNames adds a -<id> suffix (protects multiple docs with the same title).
 * slug preserves Korean syllables — zip entry names are not headers, so UTF-8 is allowed as-is.
 */
function buildZipEntryName(row: ClaudedDocDbRow, usedNames: Set<string>): string {
  const docId = bigintToNumber(row.id);
  const slug = slugifyTitle(row.title);
  const base = slug === "untitled" ? `doc-${docId}` : slug;
  let candidate = `${base}.html`;
  if (usedNames.has(candidate)) {
    candidate = `${base}-${docId}.html`;
  }
  usedNames.add(candidate);
  return candidate;
}

/**
 * Builds an RFC 6266 Content-Disposition for the single HTML export — emits
 * `attachment` + `.html`. Korean titles survive in `filename*` (RFC 5987
 * ext-value); the ASCII `filename` fallback floors to `doc-{id}` when nothing
 * ASCII survives.
 */
function buildHtmlExportContentDisposition(row: ClaudedDocDbRow): string {
  const slug = slugifyTitle(row.title);
  const docId = bigintToNumber(row.id);
  const base = slug === "untitled" ? `doc-${docId}` : slug;
  const utf8Name = `${base}.html`;
  // ASCII fallback — strip non-ASCII bytes; floor to doc-{id} if the slug ends up empty.
  // eslint-disable-next-line no-control-regex -- intentional: keep only 0x20-0x7E
  const asciiSlug = base
    .replace(/[^\x20-\x7E]+/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  const asciiBase = asciiSlug.length === 0 ? `doc-${docId}` : asciiSlug;
  const asciiName = `${asciiBase}.html`;
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeRfc5987(utf8Name)}`;
}

/**
 * POST /api/clauded-docs/html-export body validation.
 * success → { ids: number[] } (each a positive integer · length ≥ 1 after dedupe).
 * failure → reason string (caller surfaces as 400 invalid_body).
 * length > MULTI_EXPORT_MAX_IDS is checked by the caller (invalid_param before browser launch).
 */
function parseHtmlExportMultiBody(raw: unknown): HtmlExportMultiBody | string {
  if (raw === null || typeof raw !== "object") {
    return "body must be a JSON object";
  }
  const body = raw as Record<string, unknown>;
  const idsRaw = body.ids;
  if (!Array.isArray(idsRaw)) {
    return "ids must be an array";
  }
  const normalized = normalizeMemberIds(idsRaw);
  if (typeof normalized === "string") return normalized;
  if (normalized.length < 1) {
    return "ids must contain at least 1 positive integer";
  }
  return { ids: normalized };
}

// PUT /api/clauded-docs/:id

async function handleUpdate(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<GetClaudedDocResponse | ClaudedDocsErrorBody> {
  const id = parseIdParam(request.params.id);
  if (id === null) {
    return reply.code(400).send({ error: "invalid_param", param: "id" });
  }

  const parsedResult = parseUpdateBody(request.body);
  if (typeof parsedResult === "string") {
    return reply.code(400).send({ error: "invalid_body", reason: parsedResult });
  }
  const parsed: UpdateClaudedDocBody = parsedResult.parsed;
  const requestFormat: DocFormatToken = parsedResult.format;
  const requestBody: string = parsedResult.body;

  // Why fetch the existing row first:
  //   1) decide the exposure(audience) bit (keep existing row value when parsed.audience is unset)
  //   2) detect format mismatch between existing row and PUT body (format change requires a new doc)
  // optimistic-lock / no-op checks also depend on the row, so fetch once.
  const prisma = getPrisma();
  const existing = await fetchExistingRow(request, reply, prisma, id);
  if (existing === null) return reply as never;

  const existingFormat: DocFormatToken = formatFromPath(existing.html_path);
  const existingAudience: AudienceLiteral | null = normalizeAudience(existing.audience);
  // exposure bit — PUT body audience field wins; unset keeps existing row value (no re-classification).
  const targetAudience: AudienceLiteral | null = parsed.audience ?? existingAudience;

  // body-kind(format) routes directly — html → HTML primary · else → plain primary.
  const needPlain = requestFormat !== "html";

  // Format-mismatch check between existing row and PUT body (blocks row identity drift):
  //   - same format → in-place update
  //   - html ↔ plain transition → handleUpdate*Body performs the path swap
  //   - plain ↔ plain different ext (e.g. yaml_body PUT on a .md row) → 400 + new-doc guidance
  const causesPathSwap =
    (existingFormat === "html" && requestFormat !== "html") ||
    (existingFormat !== "html" && requestFormat === "html");
  if (!causesPathSwap && existingFormat !== requestFormat) {
    reply.code(400);
    return {
      error: "invalid_body",
      reason: `format mismatch — existing row is ${existingFormat}, cannot update with ${requestFormat}_body (create new doc instead)`,
    };
  }

  request.log.info(
    {
      route: "/api/clauded-docs/:id", method: "PUT", id,
      audience: targetAudience,
      routing: needPlain ? "plain_primary" : "html_primary",
      format: requestFormat,
    },
    "PUT routing",
  );

  // cascade does NOT fire at the dispatcher stage — blocks silent mutation on body-validation failure.
  // Actual cascade fires via cascadeAfterRowUpdate right after updateClaudedDocRow succeeds in handleUpdate*Body.

  if (needPlain) {
    // needPlain ⟹ requestFormat !== "html" — TS narrows via the const guard (Exclude<,"html">).
    return handleUpdatePlainBody(
      request, reply, id, parsed, existing, targetAudience, requestFormat, requestBody,
    );
  }
  return handleUpdateHtmlBody(request, reply, id, parsed, existing, targetAudience);
}

/**
 * PUT HTML primary path: sanitize → structure validate → SHA256 → atomic write → DB update.
 *
 * If the existing row was plain (`.md` etc.), issue a new `.html` path + delete the old file.
 * Same format → in-place write.
 */
async function handleUpdateHtmlBody(
  request: FastifyRequest,
  reply: FastifyReply,
  id: number,
  parsed: UpdateClaudedDocBody,
  existing: ClaudedDocDbRow,
  targetAudience: AudienceLiteral | null,
): Promise<GetClaudedDocResponse | ClaudedDocsErrorBody> {
  const start = Date.now();
  const htmlBody = parsed.html_body;
  if (typeof htmlBody !== "string") {
    // Unreachable (guaranteed by the handleUpdate dispatcher).
    return reply.code(500).send({ error: "internal" });
  }

  const sanitized = sanitizeUpdateBody(request, reply, htmlBody);
  if (sanitized === null) return reply as never;

  // Same order gate as POST (see handleCreate comment).
  const structureOk = validateStructureOrReply(reply, { raw: htmlBody, sanitized });
  if (!structureOk) return reply as never;

  const conversion = convertForStorageOrReply(request, reply, sanitized);
  if (conversion === null) return reply as never;

  // Optimistic-lock check (HTTP If-Match-style).
  if (existing.content_hash !== parsed.expected_hash) {
    reply.code(409);
    return { error: "hash_conflict", expected: parsed.expected_hash, actual: existing.content_hash };
  }

  // No-op short-circuit — same content + same audience. Even with unchanged body, a doc_status
  // diff must take the cascade path, so block the no-op skip (else sibling cascade is missed).
  // Standalone (folder_id=NULL) rows enter too — cascadeUpdateDocStatus CTE degrades to self-only.
  const sameAudience = normalizeAudience(existing.audience) === targetAudience;
  if (existing.content_hash === conversion.contentHash && sameAudience) {
    const cascadeNeeded =
      parsed.doc_status !== undefined &&
      parsed.doc_status !== (existing.doc_status as DocStatusLiteral);
    if (!cascadeNeeded) {
      return replyNoOpUpdate(request, reply, id, existing);
    }
    return replyCascadeOnlyUpdate(request, reply, id, existing, parsed.doc_status as DocStatusLiteral, "html");
  }

  // Audience re-classification check — issue a new path when the body extension must change.
  const existingIsHtmlFile = existing.html_path.endsWith(".html");
  const needsPathSwap = !existingIsHtmlFile;
  let bodyPath = existing.html_path;
  let oldPathToRemove: string | null = null;
  if (needsPathSwap) {
    // Existing `.md` row → issue a new `.html` path.
    const createdAt = existing.created_at;
    const slugResult = await pickAvailableSlug(
      request, reply, existing.title, createdAt, "html",
    );
    if (slugResult === null) return reply as never;
    bodyPath = slugResult.bodyPath;
    oldPathToRemove = existing.html_path;
  } else {
    try {
      assertPathInsideRoot(existing.html_path, getHtmlRoot());
    } catch (error) {
      request.log.error({ err: error, id }, "stored path escapes root");
      return reply.code(500).send({ error: "internal" });
    }
  }

  // Snapshot previous content for rollback BEFORE the new write.
  const prevContent = await readFileUtf8(bodyPath).catch(() => null);

  try {
    await writeFileAtomic(bodyPath, sanitized, { overwrite: !needsPathSwap });
  } catch (error) {
    return failWithFs(request, reply, "/api/clauded-docs/:id (PUT)", error);
  }

  const restoreArgs: HtmlRestoreArgs = {
    htmlPath: bodyPath,
    previousHtmlContent: prevContent,
  };

  const dupCheck = await checkUpdateHashUniqueness(
    request, reply, getPrisma(), id, conversion.contentHash, restoreArgs,
  );
  if (dupCheck !== "ok") return dupCheck;

  let updated: ClaudedDocDbRow;
  try {
    updated = await updateClaudedDocRow(getPrisma(), {
      id, parsed, existing, conversion,
      newBodyPath: needsPathSwap ? bodyPath : null,
      newAudience: sameAudience ? null : targetAudience,
    });
  } catch (error) {
    await restoreHtmlBody(request.log, restoreArgs);
    return failWithDb(request, reply, "/api/clauded-docs/:id (PUT)", error);
  }

  // group cascade — fires only after body validation + atomic write + row update all succeed (prevents silent mutation).
  const cascadeResult = await cascadeAfterRowUpdate(request, reply, getPrisma(), id, parsed, existing);
  if (cascadeResult !== true) return cascadeResult;

  // Unlink the old path — after DB+FS state has moved to the new path.
  if (oldPathToRemove !== null) {
    await removeFileIfExists(oldPathToRemove).catch((error: unknown) => {
      request.log.warn({ err: error, id, path: oldPathToRemove }, "old body unlink after audience swap failed");
    });
  }

  request.log.info(
    { route: "/api/clauded-docs/:id", method: "PUT", id, durationMs: Date.now() - start },
    "clauded-doc updated (html primary)",
  );

  applyHtmlBodyCspHeader(reply);
  return rowToDetailResponse(updated, "html", sanitized);
}

/**
 * Unified PUT plain primary flow (md / yaml / json / txt). No sanitize / structure validate.
 *
 * exposure(audience) bit is stored as the dispatcher-decided targetAudience (body not parsed).
 * indexable_text: md → extractMdIndexableText (frontmatter strip) · yaml/json/txt → raw body.
 *
 * Path swap: a new path is issued only when an HTML primary row transitions to plain
 * (the dispatcher already 400-rejected other format mismatches).
 */
async function handleUpdatePlainBody(
  request: FastifyRequest,
  reply: FastifyReply,
  id: number,
  parsed: UpdateClaudedDocBody,
  existing: ClaudedDocDbRow,
  targetAudience: AudienceLiteral | null,
  format: Exclude<DocFormatToken, "html">,
  rawBody: string,
): Promise<GetClaudedDocResponse | ClaudedDocsErrorBody> {
  const start = Date.now();

  // plain bodies have no sanitize step — strip control chars for JSON-safety.
  const body = stripIllegalControlChars(rawBody);

  // exposure bit is stored as the dispatcher-decided targetAudience (audience not parsed from body).
  const finalAudience: AudienceLiteral | null = targetAudience;

  const conversion: ConversionResult = {
    contentHash: sha256Hex(body),
    indexableText: format === "md" ? extractMdIndexableText(body) : body,
  };

  if (existing.content_hash !== parsed.expected_hash) {
    reply.code(409);
    return { error: "hash_conflict", expected: parsed.expected_hash, actual: existing.content_hash };
  }

  // Even with unchanged body+audience, a doc_status diff takes the cascade path (block no-op skip).
  // Standalone (folder_id=NULL) rows enter too → CTE degrades to self-only.
  const sameAudience = normalizeAudience(existing.audience) === finalAudience;
  if (existing.content_hash === conversion.contentHash && sameAudience) {
    const cascadeNeeded =
      parsed.doc_status !== undefined &&
      parsed.doc_status !== (existing.doc_status as DocStatusLiteral);
    if (!cascadeNeeded) {
      return replyNoOpUpdatePlain(request, reply, id, existing, format);
    }
    return replyCascadeOnlyUpdate(request, reply, id, existing, parsed.doc_status as DocStatusLiteral, format);
  }

  // Was HTML primary → path swap needed · same plain format → in-place.
  const existingFormat = formatFromPath(existing.html_path);
  const needsPathSwap = existingFormat !== format;
  let bodyPath = existing.html_path;
  let oldPathToRemove: string | null = null;
  if (needsPathSwap) {
    const slugResult = await pickAvailableSlug(
      request, reply, existing.title, existing.created_at, format,
    );
    if (slugResult === null) return reply as never;
    bodyPath = slugResult.bodyPath;
    oldPathToRemove = existing.html_path;
  } else {
    try {
      assertPathInsideRoot(existing.html_path, getHtmlRoot());
    } catch (error) {
      request.log.error({ err: error, id }, "stored path escapes root");
      return reply.code(500).send({ error: "internal" });
    }
  }

  const prevContent = await readFileUtf8(bodyPath).catch(() => null);

  try {
    await writeFileAtomic(bodyPath, body, { overwrite: !needsPathSwap });
  } catch (error) {
    return failWithFs(request, reply, `/api/clauded-docs/:id (PUT ${format})`, error);
  }

  const restoreArgs: HtmlRestoreArgs = {
    htmlPath: bodyPath,
    previousHtmlContent: prevContent,
  };

  const dupCheck = await checkUpdateHashUniqueness(
    request, reply, getPrisma(), id, conversion.contentHash, restoreArgs,
  );
  if (dupCheck !== "ok") return dupCheck;

  let updated: ClaudedDocDbRow;
  try {
    updated = await updateClaudedDocRow(getPrisma(), {
      id, parsed, existing, conversion,
      newBodyPath: needsPathSwap ? bodyPath : null,
      newAudience: sameAudience ? null : finalAudience,
    });
  } catch (error) {
    await restoreHtmlBody(request.log, restoreArgs);
    return failWithDb(request, reply, `/api/clauded-docs/:id (PUT ${format})`, error);
  }

  const cascadeResult = await cascadeAfterRowUpdate(request, reply, getPrisma(), id, parsed, existing);
  if (cascadeResult !== true) return cascadeResult;

  if (oldPathToRemove !== null) {
    await removeFileIfExists(oldPathToRemove).catch((error: unknown) => {
      request.log.warn({ err: error, id, path: oldPathToRemove }, "old body unlink after audience swap failed");
    });
  }

  request.log.info(
    {
      route: "/api/clauded-docs/:id", method: "PUT", id,
      audience: finalAudience, format,
      durationMs: Date.now() - start,
    },
    "clauded-doc updated (plain primary)",
  );

  return rowToDetailResponse(updated, format, body);
}

/**
 * No-op PUT short-circuit for plain primary — same content + same audience.
 * Re-reads disk body to honor the response shape.
 */
async function replyNoOpUpdatePlain(
  request: FastifyRequest,
  reply: FastifyReply,
  id: number,
  existing: ClaudedDocDbRow,
  format: Exclude<DocFormatToken, "html">,
): Promise<GetClaudedDocResponse | ClaudedDocsErrorBody> {
  request.log.info(
    { route: "/api/clauded-docs/:id", method: "PUT", id, format, outcome: "no_op_plain" },
    "PUT skipped — content + audience unchanged (plain primary)",
  );
  let body: string;
  try {
    body = await readFileUtf8(existing.html_path);
  } catch (error) {
    return failWithFs(request, reply, `/api/clauded-docs/:id (PUT ${format})`, error);
  }
  return rowToDetailResponse(existing, format, body);
}

// DELETE /api/clauded-docs/:id

async function handleDelete(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<DeleteClaudedDocResponse | ClaudedDocsErrorBody> {
  const start = Date.now();
  const id = parseIdParam(request.params.id);
  if (id === null) {
    return reply.code(400).send({ error: "invalid_param", param: "id" });
  }

  const prisma = getPrisma();
  // DB row delete first (so the meta-truth disappears even if FS removal
  // partially fails); FS cleanup follows. On DB delete failure → 503; on FS
  // cleanup failure → log warning but report success (DB is the SoT for
  // existence; orphan files are recoverable via a sweep).
  let row: ClaudedDocDbRow | undefined;
  try {
    const rows = await prisma.$queryRaw<ClaudedDocDbRow[]>`
      DELETE FROM monitor.documents
      WHERE id = ${BigInt(id)}
      RETURNING ${CLAUDED_DOC_SELECT_COLUMNS}
    `;
    row = rows[0];
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/:id (DELETE)", error);
  }
  if (row === undefined) {
    reply.code(404);
    return { error: "not_found", id };
  }

  // Defensive — verify before unlinking so a corrupted row cannot trigger an
  // out-of-root unlink.
  try {
    assertPathInsideRoot(row.html_path, getHtmlRoot());
  } catch (error) {
    request.log.error(
      { err: error, id, htmlPath: row.html_path },
      "stored path escapes root — skipping FS unlink",
    );
    return { id, deleted: true };
  }

  await removeFileIfExists(row.html_path).catch((error: unknown) => {
    request.log.warn({ err: error, id, path: row?.html_path }, "html file unlink failed");
  });

  request.log.info(
    {
      route: "/api/clauded-docs/:id",
      method: "DELETE",
      id,
      durationMs: Date.now() - start,
    },
    "clauded-doc deleted",
  );

  return { id, deleted: true };
}

// GET /api/clauded-docs/search

async function handleSearch(
  request: FastifyRequest<{ Querystring: SearchClaudedDocsQuery }>,
  reply: FastifyReply,
): Promise<SearchClaudedDocsResponse | ClaudedDocsErrorBody> {
  const start = Date.now();

  const qRaw = request.query.q;
  if (typeof qRaw !== "string" || qRaw.trim().length === 0) {
    return reply.code(400).send({ error: "invalid_param", param: "q" });
  }
  const q = qRaw.slice(0, Q_MAX_LENGTH).trim();

  // DocPrefix removed — prefix filter axis dropped. Legacy `?prefix=` param is
  // silently dropped (no effect on search results).

  const limit = parseLimitParam(request.query.limit, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
  if (limit === null) {
    return reply.code(400).send({ error: "invalid_param", param: "limit" });
  }
  const offset = parseOffsetParam(request.query.offset);
  if (offset === null) {
    return reply.code(400).send({ error: "invalid_param", param: "offset" });
  }

  // Same default exclusion as handleList.
  // Unset → exclude archived/superseded · `?include_archived=true` → include all.
  const includeArchived = parseBooleanParam(request.query.include_archived);
  const excludeArchived = !includeArchived;

  // Assemble the SQL bundle — buildSearchSql encapsulates the weight expression + pg_bigm branch.
  // bigmEnabled is the startup one-time detection result — same value every request.
  const bigmEnabled = isBigmEnabled();
  const { rowsSql, countSql } = buildSearchSql({
    q,
    limit,
    offset,
    bigmEnabled,
    excludeArchived,
  });

  const prisma = getPrisma();
  try {
    const [hits, countRows] = await Promise.all([
      prisma.$queryRaw<SearchHitDbRow[]>(rowsSql),
      prisma.$queryRaw<CountRow[]>(countSql),
    ]);

    const totalRow = countRows[0];
    if (totalRow === undefined) {
      throw new Error("count query returned no row");
    }
    const total = bigintToNumber(totalRow.total);

    const rows: SearchClaudedDocHit[] = hits.flatMap((hit) => {
      // Response `rank` = lexical + bigm sum — FE uses it as the sort key. Both
      // components being 0 (no match) is unreachable (already filtered by WHERE).
      const combinedRank = hit.lexical_rank + hit.bigm_rank;
      return [
        {
          id: bigintToNumber(hit.id),
          title: hit.title,
          author: hit.author,
          created_at: hit.created_at.toISOString(),
          rank: combinedRank,
          snippet: hit.snippet,
          // list-row parity fields — same derivation as the handleList SELECT, so
          // status toggle · agent badge · audience filter all work in search mode too.
          doc_status: hit.doc_status as DocStatusLiteral,
          audience: computeResponseAudience(hit.audience, formatFromPath(hit.html_path)),
          format: formatFromPath(hit.html_path),
        },
      ];
    });

    request.log.info(
      {
        route: "/api/clauded-docs/search",
        rowCount: rows.length,
        total,
        bigmEnabled,
        excludeArchived,
        durationMs: Date.now() - start,
      },
      "clauded-docs search complete",
    );

    // Same deprecation notice as handleList.
    if (excludeArchived) {
      reply.header("X-Deprecation-Notice", DEPRECATION_NOTICE_INCLUDE_ARCHIVED);
    }

    return {
      query: q,
      total,
      rows,
      // Surfaces the startup detection to the FE — the warn log alone leaves the
      // Korean-substring degradation invisible to users.
      bigm_enabled: bigmEnabled,
      filter: {
        limit,
        offset,
      },
      fetched_at: new Date().toISOString(),
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/search", error);
  }
}

interface ConversionResult {
  contentHash: string;
  indexableText: string;
}

// No MD companion: only SHA256 + indexable plaintext derived for DB integrity
// and search index. Both derivations deterministic + independent.
function convertForStorage(html: string): ConversionResult {
  return {
    contentHash: sha256Hex(html),
    indexableText: extractIndexableText(html),
  };
}

// handleCreate / handleUpdate flow helpers
//
// Extracted from the inline handler bodies so each handler stays within the
// scope-dev.md "Function ≤20 lines" assertion budget. Each helper returns
// either the wanted value OR null when it has already written a 4xx/5xx
// envelope to `reply`; the caller treats null as "abort + bubble reply".

/**
 * Re-inject HTML5 baseline (doctype + charset + viewport) for GET responses.
 *
 * DOMPurify strips these on storage → a caller PUT-ing the GET body back would
 * fail validateHtmlStructure (Gate 2) on missing doctype/charset. Wrap only at
 * response time; stored (sanitized) body stays unchanged.
 *
 * Idempotent: skips injection when doctype/charset already present (substring
 * check suffices — sanitized body is known-stripped). Non-HTML formats (md /
 * yaml / json / txt) bypass this (caller branches).
 */
function wrapHtmlBodyForRoundTrip(body: string): string {
  if (body.length === 0) return body;
  const firstChunk = body.slice(0, 200).toLowerCase();
  const hasDoctype = firstChunk.includes("<!doctype");
  const hasCharsetMeta =
    /<meta\s+[^>]*charset\s*=/i.test(body.slice(0, 2000)) ||
    /<meta\s+[^>]*http-equiv\s*=\s*["']?content-type/i.test(body.slice(0, 2000));

  // Already has baseline → return as-is (idempotent).
  if (hasDoctype && hasCharsetMeta) return body;

  // Inject charset/viewport right after <head> open, preserving existing children.
  let wrapped = body;
  if (!hasCharsetMeta) {
    const headOpenMatch = wrapped.match(/<head[^>]*>/i);
    if (headOpenMatch !== null) {
      const insertAt = (headOpenMatch.index ?? 0) + headOpenMatch[0].length;
      wrapped =
        wrapped.slice(0, insertAt) +
        '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        wrapped.slice(insertAt);
    }
  }
  // doctype is a preamble (not an element) → prepend at the very top.
  if (!hasDoctype) {
    wrapped = "<!doctype html>" + wrapped;
  }
  return wrapped;
}

/** Sanitize POST html_body → null when reply was already populated with 5xx. */
function sanitizeCreateBody(
  request: FastifyRequest,
  reply: FastifyReply,
  htmlBody: string,
): string | null {
  try {
    // Strip illegal control chars first so the sanitized SoT (hash + structure
    // validation + stored bytes) is built from a JSON-safe body — guards the
    // control-char regression (see clauded-docs/control-chars.ts).
    return sanitizeHtmlBody(stripIllegalControlChars(htmlBody));
  } catch (error) {
    request.log.error(
      { err: error, route: "/api/clauded-docs" },
      "html sanitization threw unexpectedly",
    );
    reply.code(500).send({ error: "internal" });
    return null;
  }
}

/** Sanitize PUT html_body → null when reply was already populated with 5xx. */
function sanitizeUpdateBody(
  request: FastifyRequest,
  reply: FastifyReply,
  htmlBody: string,
): string | null {
  try {
    // Strip illegal control chars first (same JSON-safety contract as POST —
    // see clauded-docs/control-chars.ts).
    return sanitizeHtmlBody(stripIllegalControlChars(htmlBody));
  } catch (error) {
    request.log.error(
      { err: error, route: "/api/clauded-docs/:id (PUT)" },
      "html sanitization threw unexpectedly",
    );
    reply.code(500).send({ error: "internal" });
    return null;
  }
}

/**
 * Run validateHtmlStructure on the (raw + sanitized) body pair. On `ok: false`,
 * populate `reply` with the appropriate 400 envelope and return false. On
 * `ok: true`, return true (caller proceeds).
 *
 * Four failure paths (at most one code per response — the validator pipeline
 * short-circuits on the first failing stage: structure → placeholder → D8 P2
 * columns → D8 style):
 *   - `code: 'html_structure_invalid'` — 7-field structure miss; FE surfaces
 *     the `missing` array to the author.
 *   - `code: 'placeholder_residue'` — residual `{{…}}` template tokens; FE
 *     surfaces the offending 1-based `lines` to the author (P1).
 *   - `code: 'd8_p2_violation'` — comparison table over the column cap; FE
 *     surfaces the violating table's nth-of-type index + column count.
 *   - `code: 'd8_style_violation'` — D8 visual style rules violated; FE
 *     surfaces the full `findings` array (line-anchored + document-level) (P2).
 *
 * No logger is invoked here because every failure is an author error (4xx),
 * not a warning.
 */
function validateStructureOrReply(
  reply: FastifyReply,
  input: { raw: string; sanitized: string },
): boolean {
  const check = validateHtmlStructure(input);
  if (check.ok) return true;
  if (check.code === "html_structure_invalid") {
    reply.code(400).send({
      error: {
        code: "html_structure_invalid",
        message: "Missing required structural elements",
        details: { missing: check.missing },
      },
    });
    return false;
  }
  // P1 — residual placeholder tokens remain in the body.
  if (check.code === "placeholder_residue") {
    reply.code(400).send({
      error: {
        code: "placeholder_residue",
        message: "Residual placeholder tokens ({{…}}) must be resolved before publish",
        details: { lines: check.lines },
      },
    });
    return false;
  }
  // P2 — D8 visual style rules violated (full findings array).
  if (check.code === "d8_style_violation") {
    reply.code(400).send({
      error: {
        code: "d8_style_violation",
        message: "D8 style violations — resolve inline color literals / explicit light-default body",
        details: { findings: check.findings },
      },
    });
    return false;
  }
  // D8 P2 — comparison table column-cap exceeded.
  reply.code(400).send({
    error: {
      code: "d8_p2_violation",
      message: "Comparison table exceeds D8 P2 column cap",
      details: check.details,
    },
  });
  return false;
}

/**
 * Run convertForStorage with the route's standard 500 envelope behavior.
 * Returns the ConversionResult on success; null on failure (reply populated).
 *
 * Remaining derivations (SHA256, indexable plaintext) are deterministic with
 * near-zero failure odds (extractIndexableText handles malformed HTML
 * best-effort); only an unexpected throw surfaces as 5xx.
 */
function convertForStorageOrReply(
  request: FastifyRequest,
  reply: FastifyReply,
  sanitizedHtml: string,
): ConversionResult | null {
  try {
    return convertForStorage(sanitizedHtml);
  } catch (error) {
    request.log.error({ err: error }, "conversion threw unexpectedly");
    reply.code(500).send({ error: "internal" });
    return null;
  }
}

/**
 * POST idempotency check (C10). Returns "ok" to continue, OR a fully-formed
 * 4xx/5xx error body (caller returns directly).
 */
async function checkDuplicateContent(
  request: FastifyRequest,
  reply: FastifyReply,
  prisma: ReturnType<typeof getPrisma>,
  contentHash: string,
): Promise<"ok" | ClaudedDocsErrorBody> {
  try {
    const existing = await prisma.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM monitor.documents WHERE content_hash = ${contentHash} LIMIT 1
    `;
    const existingRow = existing[0];
    if (existingRow !== undefined) {
      reply.code(409);
      return { error: "duplicate_content", existing_id: bigintToNumber(existingRow.id) };
    }
    return "ok";
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs (POST)", error);
  }
}

interface PickedSlugPaths {
  slug: string;
  bodyPath: string;
}

/**
 * Resolve a non-colliding slug + compute the body path. Probes FS rather than
 * DB because path collisions are the real constraint (DB-side uniqueness is
 * already checked on content_hash). Returns null on validation/IO error
 * with the reply envelope populated.
 *
 * `kind` (DocFormatToken, 5 values) selects the path computer:
 *   - html               → computeHtmlPath (.html)
 *   - md|yaml|json|txt   → computePlainPath (.md / .yaml / .json / .txt)
 * All paths share the monitor-internal root (`getHtmlRoot()`).
 */
async function pickAvailableSlug(
  request: FastifyRequest,
  reply: FastifyReply,
  title: string,
  createdAt: Date,
  kind: DocFormatToken,
): Promise<PickedSlugPaths | null> {
  const createdDate = createdAt.toISOString().slice(0, 10);
  const slugBase = slugifyTitle(title);
  for (let attempt = 0; attempt < SLUG_COLLISION_MAX_TRIES; attempt += 1) {
    const slug = attempt === 0 ? slugBase : `${slugBase}-${attempt + 1}`;
    const bodyPath = kind === "html"
      ? computeHtmlPath({ createdDate, slug })
      : computePlainPath({ createdDate, slug }, plainExtensionFor(kind));
    try {
      assertPathInsideRoot(bodyPath, getHtmlRoot());
    } catch (error) {
      request.log.error({ err: error }, "computed path escaped root — refusing to write");
      reply.code(500).send({ error: "internal" });
      return null;
    }
    let conflict: boolean;
    try {
      conflict = await pathExists(bodyPath);
    } catch (error) {
      failWithFs(request, reply, "/api/clauded-docs (POST)", error);
      return null;
    }
    if (!conflict) return { slug, bodyPath };
  }
  request.log.error(
    { route: "/api/clauded-docs", slugBase, attempts: SLUG_COLLISION_MAX_TRIES },
    "slug collision retries exhausted",
  );
  reply.code(500).send({ error: "internal" });
  return null;
}

interface InsertClaudedDocArgs {
  parsed: CreateClaudedDocBody;
  createdAt: Date;
  conversion: ConversionResult;
  // Absolute body-file path (extension = body kind). DB column `html_path` is
  // reused as the SoT for any kind (html / md / yaml / json / txt) — avoids a
  // separate column.
  bodyPath: string;
  // Exposure bit decided by parseCreateBody; null = unspecified (read-side
  // computeResponseAudience normalizes to the format default).
  audience: AudienceLiteral | null;
  // null = chain root · bigint = predecessor id (existence already verified).
  // When set, the same INSERT statement (CTE) auto-transitions the predecessor
  // doc_status → 'done'.
  supersedesId: bigint | null;
  // Workflow status (POST default 'progress'); always passed explicitly to
  // avoid relying on the silent DB default.
  docStatus: DocStatusLiteral;
  // Group folder linkage. null = ungrouped (new row is its own root) · bigint =
  // FK-validated root id.
  folderId: bigint | null;
}

/**
 * Single-statement INSERT … RETURNING. Throws on DB error so the caller can
 * trigger the FS rollback path (this stays a thin wrapper so the rollback
 * orchestration lives next to the handler).
 *
 * md_copy_path / last_synced_at are always NULL for new rows (no MD companion).
 *
 * CTE branch:
 *   - supersedesId === null → plain INSERT … RETURNING
 *   - supersedesId !== null → single-statement CTE that also UPDATEs the
 *     predecessor's doc_status → 'done'. No transaction needed (a PostgreSQL
 *     single statement is one snapshot). Idempotent if predecessor already
 *     done; a missing predecessor is blocked by the FK at INSERT (caller
 *     fetch-validates first, so unreachable).
 */
async function insertClaudedDocRow(
  prisma: ReturnType<typeof getPrisma>,
  args: InsertClaudedDocArgs,
): Promise<ClaudedDocDbRow> {
  const { parsed, createdAt, conversion, bodyPath, audience, supersedesId, docStatus, folderId } = args;
  // supersedesId null → plain INSERT path. Otherwise a single-statement CTE:
  // `WITH ins AS (... RETURNING *)` surfaces the INSERT result for the follow-up
  // UPDATE to join; `, _upd AS (UPDATE ... RETURNING 1)` is side-effect only —
  // the final SELECT returns ins columns. RETURNING column set matches the
  // SELECT/UPDATE/DELETE sites (drift guard); both branches share the same enum.
  const rows = supersedesId === null
    ? await prisma.$queryRaw<ClaudedDocDbRow[]>`
        INSERT INTO monitor.documents
          (title, author, created_at, content_hash, html_path,
           md_copy_path, indexable_text, last_synced_at, audience, supersedes_id,
           doc_status, folder_id)
        VALUES (
          ${parsed.title},
          ${parsed.author},
          ${createdAt},
          ${conversion.contentHash},
          ${bodyPath},
          ${null},
          ${conversion.indexableText},
          ${null},
          ${audience},
          ${null},
          ${docStatus}::monitor."DocStatus",
          ${folderId}
        )
        RETURNING ${CLAUDED_DOC_SELECT_COLUMNS}
      `
    : await prisma.$queryRaw<ClaudedDocDbRow[]>`
        WITH ins AS (
          INSERT INTO monitor.documents
            (title, author, created_at, content_hash, html_path,
             md_copy_path, indexable_text, last_synced_at, audience, supersedes_id,
             doc_status, folder_id)
          VALUES (
            ${parsed.title},
            ${parsed.author},
            ${createdAt},
            ${conversion.contentHash},
            ${bodyPath},
            ${null},
            ${conversion.indexableText},
            ${null},
            ${audience},
            ${supersedesId},
            ${docStatus}::monitor."DocStatus",
            ${folderId}
          )
          RETURNING ${CLAUDED_DOC_SELECT_COLUMNS}
        ),
        _upd AS (
          UPDATE monitor.documents
          SET doc_status = 'done'::monitor."DocStatus"
          WHERE id = ${supersedesId}
          RETURNING 1
        )
        SELECT * FROM ins
      `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("INSERT did not return a row");
  }
  return row;
}

/** PUT existing-row fetch. null = reply already populated (404 / 503). */
async function fetchExistingRow(
  request: FastifyRequest,
  reply: FastifyReply,
  prisma: ReturnType<typeof getPrisma>,
  id: number,
): Promise<ClaudedDocDbRow | null> {
  let existing: ClaudedDocDbRow | undefined;
  try {
    const rows = await prisma.$queryRaw<ClaudedDocDbRow[]>`
      SELECT ${CLAUDED_DOC_SELECT_COLUMNS}
      FROM monitor.documents
      WHERE id = ${BigInt(id)}
      LIMIT 1
    `;
    existing = rows[0];
  } catch (error) {
    failWithDb(request, reply, "/api/clauded-docs/:id (PUT)", error);
    return null;
  }
  if (existing === undefined) {
    reply.code(404).send({ error: "not_found", id });
    return null;
  }
  return existing;
}

/**
 * No-op PUT short-circuit — same content body. Re-reads disk body to honor
 * the response shape (always include current body).
 */
async function replyNoOpUpdate(
  request: FastifyRequest,
  reply: FastifyReply,
  id: number,
  existing: ClaudedDocDbRow,
): Promise<GetClaudedDocResponse | ClaudedDocsErrorBody> {
  request.log.info(
    { route: "/api/clauded-docs/:id", method: "PUT", id, outcome: "no_op" },
    "PUT skipped — content unchanged",
  );
  let body: string;
  try {
    body = await readFileUtf8(existing.html_path);
  } catch (error) {
    return failWithFs(request, reply, "/api/clauded-docs/:id (PUT)", error);
  }
  applyHtmlBodyCspHeader(reply);
  return rowToDetailResponse(existing, "html", body);
}

/**
 * Cascade-only short-circuit for a body-unchanged PUT.
 *
 * Called from the no-op path (body+audience identical) when a cascade is still
 * needed (doc_status change intent + group-member row). cascadeUpdateDocStatus
 * also updates the target row's doc_status (covered by WHERE id=$1 OR
 * folder_id=$2) — no separate single-row update. Response re-SELECTs the fresh
 * row so the caller sees the new doc_status without another GET.
 */
async function replyCascadeOnlyUpdate(
  request: FastifyRequest,
  reply: FastifyReply,
  id: number,
  existing: ClaudedDocDbRow,
  newStatus: DocStatusLiteral,
  format: DocFormatToken,
): Promise<GetClaudedDocResponse | ClaudedDocsErrorBody> {
  const prisma = getPrisma();
  let cascadeRows: CascadeRow[];
  try {
    cascadeRows = await cascadeUpdateDocStatus(prisma, id, newStatus);
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/:id (PUT cascade-only)", error);
  }
  request.log.info(
    {
      route: "/api/clauded-docs/:id", method: "PUT", id,
      outcome: "cascade_only",
      cascade_count: cascadeRows.length, new_doc_status: newStatus,
      folder_id: existing.folder_id === null ? null : bigintToNumber(existing.folder_id),
    },
    "PUT body unchanged — cascade-only path (doc_status diff)",
  );

  // Re-SELECT the target row so the response carries the new doc_status (the
  // cascade RETURNs ids only, so a full-column fetch is needed).
  let refreshed: ClaudedDocDbRow;
  try {
    const rows = await prisma.$queryRaw<ClaudedDocDbRow[]>`
      SELECT ${CLAUDED_DOC_SELECT_COLUMNS}
      FROM monitor.documents
      WHERE id = ${BigInt(id)}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      reply.code(404);
      return { error: "not_found", id };
    }
    refreshed = row;
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/:id (PUT cascade-only refresh)", error);
  }

  let body: string;
  try {
    body = await readFileUtf8(existing.html_path);
  } catch (error) {
    return failWithFs(request, reply, "/api/clauded-docs/:id (PUT cascade-only)", error);
  }
  if (format === "html") {
    applyHtmlBodyCspHeader(reply);
  }
  return rowToDetailResponse(refreshed, format, body);
}

/**
 * PUT hash-uniqueness probe. On duplicate hit OR DB failure, restores the
 * previous content and returns a fully-formed error body. "ok" = continue.
 */
async function checkUpdateHashUniqueness(
  request: FastifyRequest,
  reply: FastifyReply,
  prisma: ReturnType<typeof getPrisma>,
  id: number,
  newContentHash: string,
  restoreArgs: HtmlRestoreArgs,
): Promise<"ok" | ClaudedDocsErrorBody> {
  try {
    const dupes = await prisma.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM monitor.documents
      WHERE content_hash = ${newContentHash} AND id <> ${BigInt(id)}
      LIMIT 1
    `;
    const dupeRow = dupes[0];
    if (dupeRow !== undefined) {
      await restoreHtmlBody(request.log, restoreArgs);
      reply.code(409);
      return { error: "duplicate_content", existing_id: bigintToNumber(dupeRow.id) };
    }
    return "ok";
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/:id (PUT)", error);
  }
}

/**
 * Snapshot args for HTML body rollback. Single HTML storage means only
 * previousHtmlContent is tracked. A null value means the pre-write snapshot read
 * failed (file deleted / permission change) → restore is skipped.
 * Exposed for tests.
 */
export interface HtmlRestoreArgs {
  htmlPath: string;
  previousHtmlContent: string | null;
}

/**
 * Best-effort restore of the HTML snapshot via writeFileAtomic(overwrite: true).
 * Used by PUT rollback when dup-probe or UPDATE fails AFTER the new content was
 * written. The original DB error still drives the response, but a restore failure
 * is ERROR-logged — it leaves DB/FS diverged (file keeps the new content while
 * the DB row keeps the old content_hash), which must be operator-visible.
 * Exposed for tests.
 */
export async function restoreHtmlBody(log: FastifyBaseLogger, args: HtmlRestoreArgs): Promise<void> {
  if (args.previousHtmlContent === null) return;
  try {
    await writeFileAtomic(args.htmlPath, args.previousHtmlContent, { overwrite: true });
  } catch (error) {
    log.error(
      { err: error, htmlPath: args.htmlPath },
      "PUT rollback restore failed — DB/FS diverged: file keeps new content while DB row keeps old content_hash; re-PUT or restore the file manually",
    );
  }
}

interface UpdateClaudedDocArgs {
  id: number;
  parsed: UpdateClaudedDocBody;
  existing: ClaudedDocDbRow;
  conversion: ConversionResult;
  // New absolute path when an audience change requires a body-extension swap.
  // null = keep path (in-place update, same audience).
  newBodyPath: string | null;
  // New value on audience reclassification · null = keep (not mutated in UPDATE).
  newAudience: AudienceLiteral | null;
}

/**
 * Single-statement UPDATE … RETURNING. Throws on DB error so the caller
 * triggers the restoreHtmlBody rollback.
 *
 * last_synced_at is fixed NULL (it tracked MD companion sync, now meaningless);
 * md_copy_path is left untouched for legacy-row compatibility.
 *
 * newBodyPath / newAudience branches:
 *   - newBodyPath !== null → also update html_path (audience change → `.html`↔`.md` swap)
 *   - newAudience !== null → update audience column (reclassify)
 *   - both null → plain PUT (title / content_hash / indexable_text / doc_status)
 *
 * RETURNING must include audience — omitting it forces audience=null in the
 * response (MD-primary-row regression); column set matches SELECT/INSERT.
 */
async function updateClaudedDocRow(
  prisma: ReturnType<typeof getPrisma>,
  args: UpdateClaudedDocArgs,
): Promise<ClaudedDocDbRow> {
  const { id, parsed, existing, conversion, newBodyPath, newAudience } = args;
  const titleNew = parsed.title ?? existing.title;
  // Resolve values in the route layer (no SQL-side branching) to keep Prisma
  // binding safe — every branch SETs the same column set.
  const htmlPathNew = newBodyPath ?? existing.html_path;
  const audienceNew = newAudience ?? existing.audience;
  // doc_status unspecified → keep existing. This function handles body+meta only;
  // group cascade fires separately via cascadeUpdateDocStatus.
  const docStatusNew = parsed.doc_status ?? (existing.doc_status as DocStatusLiteral);
  const rows = await prisma.$queryRaw<ClaudedDocDbRow[]>`
    UPDATE monitor.documents
    SET
      title = ${titleNew},
      doc_status = ${docStatusNew}::monitor."DocStatus",
      content_hash = ${conversion.contentHash},
      indexable_text = ${conversion.indexableText},
      html_path = ${htmlPathNew},
      audience = ${audienceNew},
      last_synced_at = ${null}
    WHERE id = ${BigInt(id)}
    RETURNING ${CLAUDED_DOC_SELECT_COLUMNS}
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("UPDATE did not return a row");
  }
  return row;
}

/**
 * Group cascade UPDATE CTE. Fires (per the handleUpdate dispatcher) only when
 * doc_status is specified AND the row is a group member (folder_id !== null);
 * otherwise body/meta UPDATE alone runs.
 *
 * Single-statement CTE:
 *   - target: id → folder_id (subquery-cached, race-safe)
 *   - cascade_targets: ids where id=$1 OR folder_id=(target.folder_id)
 *   - UPDATE … WHERE id IN (cascade_targets) RETURNING id, doc_status, folder_id
 *
 * Caller derives cascade_count from the RETURNING row count. Cascade toggles
 * doc_status only — other mutations go through updateClaudedDocRow (SRP).
 */
interface CascadeRow {
  id: bigint;
  doc_status: string;
  folder_id: bigint | null;
}

async function cascadeUpdateDocStatus(
  prisma: ReturnType<typeof getPrisma>,
  id: number,
  newStatus: DocStatusLiteral,
): Promise<CascadeRow[]> {
  return prisma.$queryRaw<CascadeRow[]>`
    WITH target AS (
      SELECT id, folder_id FROM monitor.documents WHERE id = ${BigInt(id)}
    ),
    cascade_targets AS (
      SELECT id FROM monitor.documents
      WHERE id = (SELECT id FROM target)
         OR folder_id = (SELECT folder_id FROM target WHERE folder_id IS NOT NULL)
    )
    UPDATE monitor.documents
    SET doc_status = ${newStatus}::monitor."DocStatus"
    WHERE id IN (SELECT id FROM cascade_targets)
    RETURNING id, doc_status::text AS doc_status, folder_id
  `;
}

/**
 * Cascade fire-after-row-update helper. Called after updateClaudedDocRow
 * succeeds, gated on doc_status specified AND folder_id !== null (group member).
 * cascade_count goes to audit log only, not the response envelope (the UI
 * reloads the group to show the change).
 *
 * On failure this throws → caller surfaces 503. Since updateClaudedDocRow
 * already updated the target row, a cascade-only failure leaves the target and
 * its siblings with mismatched doc_status (idempotent retry recommended — the
 * log identifies it).
 */
async function cascadeAfterRowUpdate(
  request: FastifyRequest,
  reply: FastifyReply,
  prisma: ReturnType<typeof getPrisma>,
  id: number,
  parsed: UpdateClaudedDocBody,
  existing: ClaudedDocDbRow,
): Promise<true | ClaudedDocsErrorBody> {
  if (parsed.doc_status === undefined || existing.folder_id === null) {
    return true; // no-op — cascade trigger conditions unmet
  }
  try {
    const cascadeRows = await cascadeUpdateDocStatus(prisma, id, parsed.doc_status);
    request.log.info(
      {
        route: "/api/clauded-docs/:id", method: "PUT", id,
        cascade_count: cascadeRows.length, new_doc_status: parsed.doc_status,
        folder_id: bigintToNumber(existing.folder_id),
      },
      "doc_status group cascade applied",
    );
    return true;
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/:id (PUT cascade)", error);
  }
}

// supersededById defaults null — POST/PUT callers are structurally successor-free
// (fresh row · superseded rows auto-transition to done, which blocks PUT).
function rowToDetailResponse(
  row: ClaudedDocDbRow,
  format: DocFormatToken,
  body: string,
  supersededById: number | null = null,
): GetClaudedDocResponse {
  // HTML body round-trip safety: re-inject the doctype/charset baseline only at
  // response time (storage body unchanged). content_hash is post-sanitize, so a
  // PUT of the wrapped body gets re-stripped server-side → same hash → 200 OK.
  // Plain formats (md/yaml/json/txt) skip wrapping (no DOM context).
  const responseBody = format === "html" ? wrapHtmlBodyForRoundTrip(body) : body;
  return {
    id: bigintToNumber(row.id),
    title: row.title,
    author: row.author,
    created_at: row.created_at.toISOString(),
    content_hash: row.content_hash,
    html_path: row.html_path,
    md_copy_path: row.md_copy_path,
    last_synced_at: row.last_synced_at === null ? null : row.last_synced_at.toISOString(),
    audience: computeResponseAudience(row.audience, formatFromPath(row.html_path)),
    format,
    // null = chain root · else predecessor id.
    supersedes_id: row.supersedes_id === null ? null : bigintToNumber(row.supersedes_id),
    superseded_by_id: supersededById,
    doc_status: row.doc_status as DocStatusLiteral,
    folder_id: row.folder_id === null ? null : bigintToNumber(row.folder_id),
    // list/detail shape parity (Int? as-is).
    display_order: row.display_order,
    body: responseBody,
  };
}

// body parsers — manual type guards (matches alerts.ts/autoagent.ts pattern).

/**
 * parseCreateBody discriminator return.
 * `format`  : 5-way body kind ('html' | 'md' | 'yaml' | 'json' | 'txt')
 * `body`    : raw body string (caller sanitizes/parses by format)
 * `parsed`  : meta + audience normalized CreateClaudedDocBody
 */
interface ParsedCreateBody {
  format: DocFormatToken;
  body: string;
  parsed: CreateClaudedDocBody;
}

function parseCreateBody(raw: unknown): ParsedCreateBody | string {
  if (raw === null || typeof raw !== "object") {
    return "body must be a JSON object";
  }
  const body = raw as Record<string, unknown>;

  const title = body.title;
  if (typeof title !== "string" || title.length === 0) {
    return "title is required and must be a non-empty string";
  }
  if (title.length > TITLE_MAX_LENGTH) {
    return `title exceeds ${TITLE_MAX_LENGTH} characters`;
  }

  // prefix / doc_type fields are silently ignored (backward-compat — avoids
  // unintended 400 for older clients).

  const author = body.author;
  if (typeof author !== "string" || author.length === 0) {
    return "author is required and must be a non-empty string";
  }
  if (author.length > AUTHOR_MAX_LENGTH) {
    return `author exceeds ${AUTHOR_MAX_LENGTH} characters`;
  }

  // 5-way body discriminator (mutually exclusive, no silent fallback). The
  // body-kind directly determines format (html_body→html · md_body→md · …).
  const bodyExtract = extractCreateBodyField(body);
  if (typeof bodyExtract === "string") return bodyExtract;
  const { format, raw: rawBody } = bodyExtract;

  // Exposure bit: caller-specified audience (exposed/hidden) wins; otherwise
  // exposureForFormat(format) default (html→exposed · plain→hidden). No
  // body-embedded audience parsing.
  const exposureResolution = resolveExposureBit(body.audience, format);
  if (exposureResolution.kind === "err") {
    return exposureResolution.reason;
  }
  const audience: AudienceLiteral = exposureResolution.value;

  // supersedes_id type validation only (FK + self-ref blocked later by
  // handleCreate after row fetch). Unspecified → undefined · else positive
  // integer (negatives / 0 / NaN / non-numeric rejected).
  const supersedesValidation = validateSupersedesIdField(body.supersedes_id);
  if (typeof supersedesValidation === "string") {
    return supersedesValidation;
  }
  const supersedesId: number | undefined = supersedesValidation;

  // folder_id type validation only (FK enforced by INSERT). Unspecified →
  // undefined · else positive integer (negatives/0/NaN rejected).
  const folderValidation = validateFolderIdField(body.folder_id);
  if (typeof folderValidation === "string") {
    return folderValidation;
  }
  const folderId: number | undefined = folderValidation;

  // doc_status enum validation. Unspecified → 'progress' (injected explicitly to
  // avoid relying on the silent DB default); other values → 400. Discriminated
  // union avoids the `typeof === "string"` trap (success values are strings too).
  const docStatusValidation = validateDocStatusField(body.doc_status);
  if (docStatusValidation.kind === "err") {
    return docStatusValidation.reason;
  }
  const docStatus: DocStatusLiteral = docStatusValidation.value;

  // audience is the exposure bit (always non-null).
  const parsed: CreateClaudedDocBody = {
    title,
    author,
  };
  parsed.audience = audience;
  if (supersedesId !== undefined) {
    parsed.supersedes_id = supersedesId;
  }
  if (folderId !== undefined) {
    parsed.folder_id = folderId;
  }
  parsed.doc_status = docStatus;
  // Exactly one body field by invariant; surface it for round-trip compat
  // (caller dispatches on `body`/`format`).
  if (format === "html") parsed.html_body = rawBody;
  else if (format === "md") parsed.md_body = rawBody;
  else if (format === "yaml") parsed.yaml_body = rawBody;
  else if (format === "json") parsed.json_body = rawBody;
  else parsed.txt_body = rawBody;

  return { format, body: rawBody, parsed };
}

/**
 * Extract the single 5-way body field (mutually exclusive, no silent fallback).
 * Returns `{ format, raw }` when exactly one is present, or a 400 reason string
 * for 0 / 2+ fields or size-cap violation.
 *
 * Size cap: html → HTML_BODY_MAX_LENGTH · md/yaml/json/txt → MD_BODY_MAX_LENGTH.
 */
function extractCreateBodyField(
  body: Record<string, unknown>,
): { format: DocFormatToken; raw: string } | string {
  const candidates: Array<{ field: string; format: DocFormatToken; cap: number; raw: unknown }> = [
    { field: "html_body", format: "html", cap: HTML_BODY_MAX_LENGTH, raw: body.html_body },
    { field: "md_body",   format: "md",   cap: MD_BODY_MAX_LENGTH,   raw: body.md_body   },
    { field: "yaml_body", format: "yaml", cap: MD_BODY_MAX_LENGTH,   raw: body.yaml_body },
    { field: "json_body", format: "json", cap: MD_BODY_MAX_LENGTH,   raw: body.json_body },
    { field: "txt_body",  format: "txt",  cap: MD_BODY_MAX_LENGTH,   raw: body.txt_body  },
  ];
  const present = candidates.filter((c) => typeof c.raw === "string" && (c.raw as string).length > 0);
  if (present.length === 0) {
    return "exactly one of html_body / md_body / yaml_body / json_body / txt_body is required";
  }
  if (present.length > 1) {
    const fields = present.map((p) => p.field).join(", ");
    return `body fields are mutually exclusive — got: ${fields}`;
  }
  const chosen = present[0]!;
  const rawStr = chosen.raw as string;
  if (rawStr.length > chosen.cap) {
    return `${chosen.field} exceeds ${chosen.cap} characters`;
  }
  return { format: chosen.format, raw: rawStr };
}

/**
 * Resolve the POST exposure (audience) bit. Discriminated union (same
 * convention as validateDocStatusField): { kind: "ok", value } = the resolved
 * bit (exposed/hidden, always non-null) · { kind: "err", reason } = 400 reason.
 *
 * Caller-specified audience (∈ ALLOWED_AUDIENCES) wins; otherwise
 * exposureForFormat(format) default (html→exposed · plain→hidden). No
 * body-embedded audience parsing.
 *
 * The union avoids the `typeof === "string"` trap — 'exposed'/'hidden' are
 * strings too, so a string return would let the caller misread success as error.
 */
type ExposureResolution =
  | { kind: "ok"; value: AudienceLiteral }
  | { kind: "err"; reason: string };

function resolveExposureBit(
  bodyAudienceRaw: unknown,
  format: DocFormatToken,
): ExposureResolution {
  if (bodyAudienceRaw === undefined || bodyAudienceRaw === null) {
    return { kind: "ok", value: exposureForFormat(format) };
  }
  if (typeof bodyAudienceRaw !== "string") {
    return { kind: "err", reason: "audience field, when provided, must be a string" };
  }
  if (!ALLOWED_AUDIENCES.has(bodyAudienceRaw as AudienceLiteral)) {
    return {
      kind: "err",
      reason: `invalid audience '${bodyAudienceRaw}' — allowed: ${Array.from(ALLOWED_AUDIENCES).join(", ")}`,
    };
  }
  return { kind: "ok", value: bodyAudienceRaw as AudienceLiteral };
}

/**
 * Search-index plaintext for an MD body (frontmatter excluded). No DOM parse
 * needed (already plaintext + MD markup); a simple strip of header `#`, bullet
 * `-`, and fence backticks improves tsvector input quality.
 */
function extractMdIndexableText(mdBody: string): string {
  // Strip frontmatter delimited by `---` ··· `---` (YAML frontmatter convention).
  let body = mdBody;
  if (mdBody.startsWith("---\n") || mdBody.startsWith("---\r\n")) {
    const closeIdx = mdBody.indexOf("\n---", 4);
    if (closeIdx >= 0) {
      const afterClose = mdBody.indexOf("\n", closeIdx + 4);
      body = afterClose >= 0 ? mdBody.slice(afterClose + 1) : "";
    }
  }
  // Light normalize — drop heading markers / bullets / fence backticks.
  return body
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/`{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize a DB string | null to AudienceLiteral | null.
 * - null → null (HTML primary or legacy row)
 * - not in ALLOWED_AUDIENCES → null (defensive — absorbs future schema drift)
 * - valid value → AudienceLiteral
 */
function normalizeAudience(raw: string | null): AudienceLiteral | null {
  if (raw === null) return null;
  if (!ALLOWED_AUDIENCES.has(raw as AudienceLiteral)) return null;
  return raw as AudienceLiteral;
}

/**
 * Read-side exposure (audience) bit normalize. The DB column mixes new
 * (exposed/hidden), legacy (ops/public/agent-only), and NULL; the response
 * collapses everything to a 2-value bit:
 *   - 'exposed' | 'hidden'   → pass through
 *   - 'agent-only'           → 'hidden' (UI hidden)
 *   - 'public' | 'ops'       → 'exposed' (UI shown)
 *   - NULL / unknown         → exposureForFormat(format) (html→exposed · plain→hidden)
 *
 * Always non-null — every branch converges on exposed/hidden.
 */
function computeResponseAudience(
  rawAudience: string | null,
  format: DocFormatToken,
): AudienceLiteral {
  if (rawAudience === "exposed" || rawAudience === "hidden") return rawAudience;
  if (rawAudience === "agent-only") return "hidden";
  if (rawAudience === "public" || rawAudience === "ops") return "exposed";
  return exposureForFormat(format);
}

/**
 * parseUpdateBody discriminator return (parallels ParsedCreateBody).
 * `format`  : 5-way body kind ('html' | 'md' | 'yaml' | 'json' | 'txt')
 * `body`    : raw body string (caller dispatches by format)
 * `parsed`  : UpdateClaudedDocBody (one body field set — round-trip compat)
 */
interface ParsedUpdateBody {
  format: DocFormatToken;
  body: string;
  parsed: UpdateClaudedDocBody;
}

function parseUpdateBody(raw: unknown): ParsedUpdateBody | string {
  if (raw === null || typeof raw !== "object") {
    return "body must be a JSON object";
  }
  const body = raw as Record<string, unknown>;

  // supersedes_id is immutable after POST: any presence of the key → 400 (not
  // silently ignored). Cheap cycle-detection — chain edits go through a new doc.
  if (body.supersedes_id !== undefined) {
    return "supersedes_id is immutable after POST — create a new document with the new supersedes_id instead (immutability protects against revision-chain cycle violations · Phase 2 AC6)";
  }

  // PUT shares the 5-way body discriminator; handleUpdate later cross-checks the
  // body against the audience + existing row format.
  const bodyExtract = extractCreateBodyField(body);
  if (typeof bodyExtract === "string") {
    return bodyExtract; // reuses the create-side error wording
  }
  const { format, raw: rawBody } = bodyExtract;

  const expectedHash = body.expected_hash;
  if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    return "expected_hash must be a 64-char hex SHA256";
  }

  let title: string | undefined;
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || body.title.length === 0) {
      return "title, when provided, must be a non-empty string";
    }
    if (body.title.length > TITLE_MAX_LENGTH) {
      return `title exceeds ${TITLE_MAX_LENGTH} characters`;
    }
    title = body.title;
  }

  let audience: AudienceLiteral | undefined;
  if (body.audience !== undefined && body.audience !== null) {
    if (typeof body.audience !== "string") {
      return "audience field, when provided, must be a string";
    }
    if (!ALLOWED_AUDIENCES.has(body.audience as AudienceLiteral)) {
      return `invalid audience '${body.audience}' — allowed: ${Array.from(ALLOWED_AUDIENCES).join(", ")}`;
    }
    audience = body.audience as AudienceLiteral;
  }

  // doc_status (cascade trigger). Unspecified → undefined (keep row value, no
  // cascade); only 'progress'|'done' allowed.
  let docStatus: DocStatusLiteral | undefined;
  if (body.doc_status !== undefined && body.doc_status !== null) {
    if (typeof body.doc_status !== "string" || !ALLOWED_DOC_STATUSES.has(body.doc_status as DocStatusLiteral)) {
      return `doc_status must be one of: ${Array.from(ALLOWED_DOC_STATUSES).join(", ")}`;
    }
    docStatus = body.doc_status as DocStatusLiteral;
  }

  const parsed: UpdateClaudedDocBody = {
    expected_hash: expectedHash,
  };
  // Surface one body field for round-trip compat (handleUpdate uses `format`/`body`).
  if (format === "html") parsed.html_body = rawBody;
  else if (format === "md") parsed.md_body = rawBody;
  else if (format === "yaml") parsed.yaml_body = rawBody;
  else if (format === "json") parsed.json_body = rawBody;
  else parsed.txt_body = rawBody;
  if (title !== undefined) parsed.title = title;
  if (audience !== undefined) parsed.audience = audience;
  if (docStatus !== undefined) parsed.doc_status = docStatus;

  return { format, body: rawBody, parsed };
}

// query-param parsers

// Returns the parsed enum literal, null when absent, or "INVALID" sentinel.
// Sentinel is checked by callers before casting.
type EnumParseResult<T extends string> = T | null | "INVALID";

function parseEnumParam<T extends string>(
  raw: string | undefined,
  allowed: ReadonlySet<T>,
): EnumParseResult<T> {
  if (raw === undefined || raw === "") return null;
  if (!allowed.has(raw as T)) return "INVALID";
  return raw as T;
}

function parseLimitParam(raw: string | undefined, max: number, fallback: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return null;
  return parsed;
}

// Boolean query-string parser. Truthy only on "true" / "1" (case-insensitive);
// anything else (absent, empty, "yes"/"on"/"0", …) → false (safe default).
function parseBooleanParam(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false;
  const normalized = raw.toLowerCase();
  return normalized === "true" || normalized === "1";
}

/**
 * Type-only validation of POST body supersedes_id (no FK check here).
 *   - unspecified → undefined (chain root)
 *   - positive integer ≤ Number.MAX_SAFE_INTEGER → number
 *   - negative / 0 / NaN / non-numeric / non-integer → string (400 reason)
 *
 * FK + self-ref blocking is handleCreate's later responsibility (after the DB
 * row fetch); folding it in here would make parseCreateBody DB-dependent (SRP).
 */
function validateSupersedesIdField(raw: unknown): number | undefined | string {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" && typeof raw !== "bigint") {
    return "supersedes_id, when provided, must be a positive integer";
  }
  const numeric = typeof raw === "bigint" ? Number(raw) : raw;
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return "supersedes_id must be a positive integer (got " + String(raw) + ")";
  }
  if (numeric > Number.MAX_SAFE_INTEGER) {
    return "supersedes_id exceeds Number.MAX_SAFE_INTEGER";
  }
  return numeric;
}

/**
 * Type-only validation of POST body folder_id (FK enforced by INSERT).
 *   - unspecified → undefined (ungrouped default)
 *   - positive integer → number
 *   - negative / 0 / NaN / non-numeric → string (400 reason)
 *
 * Self-ref blocking is N/A at POST (new row has no id yet); a future PUT/endpoint
 * doing root self-assignment would need its own guard.
 */
function validateFolderIdField(raw: unknown): number | undefined | string {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" && typeof raw !== "bigint") {
    return "folder_id, when provided, must be a positive integer";
  }
  const numeric = typeof raw === "bigint" ? Number(raw) : raw;
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return "folder_id must be a positive integer (got " + String(raw) + ")";
  }
  if (numeric > Number.MAX_SAFE_INTEGER) {
    return "folder_id exceeds Number.MAX_SAFE_INTEGER";
  }
  return numeric;
}

/**
 * Validate POST body doc_status.
 *   - unspecified → 'progress' (matches the DB DEFAULT, injected explicitly)
 *   - 'progress' | 'done' → returned as-is
 *   - else → { kind: "err" } with a 400 reason
 *
 * The union avoids the `typeof === "string"` trap (success values are strings too).
 */
type DocStatusValidation =
  | { kind: "ok"; value: DocStatusLiteral }
  | { kind: "err"; reason: string };

function validateDocStatusField(raw: unknown): DocStatusValidation {
  if (raw === undefined || raw === null) return { kind: "ok", value: "progress" };
  if (typeof raw !== "string" || !ALLOWED_DOC_STATUSES.has(raw as DocStatusLiteral)) {
    return { kind: "err", reason: `doc_status must be one of: ${Array.from(ALLOWED_DOC_STATUSES).join(", ")}` };
  }
  return { kind: "ok", value: raw as DocStatusLiteral };
}

function bigintToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`bigint ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

function failWithDb(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  error: unknown,
): ClaudedDocsErrorBody {
  return respondDbFailure(request, reply, route, error, "clauded-docs DB query failed");
}

function failWithFs(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  error: unknown,
): ClaudedDocsErrorBody {
  // Pull a short reason for the response body without leaking full stack/path.
  const reason = error instanceof Error ? error.message : "unknown filesystem error";
  request.log.error({ err: error, route }, "clauded-docs FS operation failed");
  reply.code(503);
  return { error: "filesystem_unavailable", reason };
}

// CSP for HTML-body responses only: sandbox blocks script/form/popups and
// frame-ancestors 'self' restricts framing to same-origin. JSON responses omit
// it (not an HTML payload). See wiki/raw/iframe-sandbox-srcdoc-security-risks-2025.md.
const HTML_BODY_CSP = "sandbox; frame-ancestors 'self'";

function applyHtmlBodyCspHeader(reply: FastifyReply): void {
  reply.header("Content-Security-Policy", HTML_BODY_CSP);
}

// Group mutation: 3 endpoints + 1-member auto-ungroup trigger.
//
// Every endpoint uses a single-statement CTE (no multi-row $transaction — a
// PostgreSQL single statement is one snapshot; row-level atomicity suffices).
//
// 1-member auto-ungroup trigger: after ungroup / move-group, if the source
// group's member_count == 1, an application-layer follow-up UPDATE NULLs that
// member's folder_id (keeps the CTE simple + surfaces an explicit audit log).

// POST /api/clauded-docs/group
//
// Binds member_ids into one group — root = newest (created_at DESC, id DESC)
// member id; every member's folder_id is set to the root id (root self-refs).
// member_ids: length ≥ 2 · all positive integers · all in DB · no duplicates.
async function handleGroupCreate(
  request: FastifyRequest<{ Body: unknown }>,
  reply: FastifyReply,
): Promise<GroupClaudedDocsResponse | ClaudedDocsErrorBody> {
  const start = Date.now();
  const parsed = parseGroupCreateBody(request.body);
  if (typeof parsed === "string") {
    return reply.code(400).send({ error: "invalid_body", reason: parsed });
  }
  const memberIds = parsed.member_ids;

  const prisma = getPrisma();
  // Root selection key: created_at DESC, id DESC (newest wins, id tie-break).
  // The probe doubles as a DB-existence check — fewer RETURNING rows than
  // member_ids means some ids are missing.
  interface UpdatedRow {
    id: bigint;
  }
  let updatedRows: UpdatedRow[];
  let rootId: bigint | null = null;
  try {
    // ANY($1::bigint[]) — pass the id array as a single param (Prisma.sql safe).
    const memberIdBigints = memberIds.map((id) => BigInt(id));
    interface RootProbeRow {
      id: bigint;
    }
    const rootProbe = await prisma.$queryRaw<RootProbeRow[]>`
      SELECT id FROM monitor.documents
      WHERE id = ANY(${memberIdBigints}::bigint[])
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `;
    if (rootProbe[0] === undefined) {
      return reply.code(404).send({
        error: "members_not_found",
        missing_ids: memberIds,
      });
    }
    rootId = rootProbe[0].id;

    updatedRows = await prisma.$queryRaw<UpdatedRow[]>`
      UPDATE monitor.documents
      SET folder_id = ${rootId}
      WHERE id = ANY(${memberIdBigints}::bigint[])
      RETURNING id
    `;
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/group (POST)", error);
  }

  // Fewer matched rows than input → some ids do not exist (members_not_found).
  if (updatedRows.length !== memberIds.length) {
    const foundIds = new Set(updatedRows.map((r) => bigintToNumber(r.id)));
    const missing = memberIds.filter((id) => !foundIds.has(id));
    return reply.code(404).send({
      error: "members_not_found",
      missing_ids: missing,
    });
  }

  request.log.info(
    {
      route: "/api/clauded-docs/group", method: "POST",
      folder_id: bigintToNumber(rootId),
      member_count: updatedRows.length,
      durationMs: Date.now() - start,
    },
    "group created",
  );

  return {
    folder_id: bigintToNumber(rootId),
    member_count: updatedRows.length,
    affected_member_ids: memberIds,
  };
}

// POST /api/clauded-docs/ungroup
//
// NULLs folder_id for member_ids (partial ungroup of a group allowed). 1-member
// auto-ungroup trigger: if the source group has only 1 member left afterward,
// that member's folder_id is NULLed too.
async function handleUngroup(
  request: FastifyRequest<{ Body: unknown }>,
  reply: FastifyReply,
): Promise<UngroupClaudedDocsResponse | ClaudedDocsErrorBody> {
  const start = Date.now();
  const parsed = parseUngroupBody(request.body);
  if (typeof parsed === "string") {
    return reply.code(400).send({ error: "invalid_body", reason: parsed });
  }
  const memberIds = parsed.member_ids;

  const prisma = getPrisma();
  // Collect source folder_ids (the auto-ungroup trigger's check targets) and
  // verify existence in the same query (404 on any missing id).
  interface SourceFolderRow {
    id: bigint;
    folder_id: bigint | null;
  }
  let sourceRows: SourceFolderRow[];
  try {
    const memberIdBigints = memberIds.map((id) => BigInt(id));
    sourceRows = await prisma.$queryRaw<SourceFolderRow[]>`
      SELECT id, folder_id FROM monitor.documents
      WHERE id = ANY(${memberIdBigints}::bigint[])
    `;
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/ungroup (POST source-fetch)", error);
  }

  if (sourceRows.length !== memberIds.length) {
    const foundIds = new Set(sourceRows.map((r) => bigintToNumber(r.id)));
    const missing = memberIds.filter((id) => !foundIds.has(id));
    return reply.code(404).send({
      error: "members_not_found",
      missing_ids: missing,
    });
  }

  // Source folder_ids of the ungroup targets (NULLs excluded — already-ungrouped
  // rows are not trigger targets).
  const sourceFolderIds = Array.from(
    new Set(
      sourceRows
        .map((r) => r.folder_id)
        .filter((fid): fid is bigint => fid !== null)
        .map((fid) => bigintToNumber(fid)),
    ),
  );

  // Main UPDATE — NULL the folder_id.
  interface UpdatedRow {
    id: bigint;
  }
  let updatedRows: UpdatedRow[];
  try {
    const memberIdBigints = memberIds.map((id) => BigInt(id));
    updatedRows = await prisma.$queryRaw<UpdatedRow[]>`
      UPDATE monitor.documents
      SET folder_id = NULL
      WHERE id = ANY(${memberIdBigints}::bigint[])
      RETURNING id
    `;
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/ungroup (POST main-update)", error);
  }

  // 1-member auto-ungroup trigger — check remaining member_count per source
  // group (empty sourceFolderIds → nothing to check).
  let autoUngroupedIds: number[] = [];
  if (sourceFolderIds.length > 0) {
    autoUngroupedIds = await applyAutoUngroupForFolders(
      request, prisma, sourceFolderIds,
    );
  }

  request.log.info(
    {
      route: "/api/clauded-docs/ungroup", method: "POST",
      ungrouped_count: updatedRows.length,
      source_folder_ids: sourceFolderIds,
      auto_ungrouped_ids: autoUngroupedIds,
      durationMs: Date.now() - start,
    },
    "ungroup applied",
  );

  return {
    ungrouped_count: updatedRows.length,
    affected_member_ids: memberIds,
    auto_ungrouped_ids: autoUngroupedIds,
  };
}

// PATCH /api/clauded-docs/:id/move-group
//
// Moves one doc's folder_id to target_group_root_id. 400 if it equals :id
// (self-move) · 404 if the target is missing. If the source group then has
// member_count == 1, that lone member is auto-ungrouped.
async function handleMoveGroup(
  request: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
  reply: FastifyReply,
): Promise<MoveGroupResponse | ClaudedDocsErrorBody> {
  const start = Date.now();
  const id = parseIdParam(request.params.id);
  if (id === null) {
    return reply.code(400).send({ error: "invalid_param", param: "id" });
  }
  const parsed = parseMoveGroupBody(request.body);
  if (typeof parsed === "string") {
    return reply.code(400).send({ error: "invalid_body", reason: parsed });
  }
  const targetRootId = parsed.target_group_root_id;

  if (targetRootId === id) {
    return reply.code(400).send({
      error: "invalid_body",
      reason: "target_group_root_id must differ from :id (self-move forbidden)",
    });
  }

  const prisma = getPrisma();

  // Verify both rows (:id source + target destination) exist in one query.
  interface ProbeRow {
    id: bigint;
    folder_id: bigint | null;
  }
  let probeRows: ProbeRow[];
  try {
    probeRows = await prisma.$queryRaw<ProbeRow[]>`
      SELECT id, folder_id FROM monitor.documents
      WHERE id IN (${BigInt(id)}, ${BigInt(targetRootId)})
    `;
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/:id/move-group (PATCH probe)", error);
  }

  const probeIds = new Set(probeRows.map((r) => bigintToNumber(r.id)));
  const missing: number[] = [];
  if (!probeIds.has(id)) missing.push(id);
  if (!probeIds.has(targetRootId)) missing.push(targetRootId);
  if (missing.length > 0) {
    return reply.code(404).send({
      error: "members_not_found",
      missing_ids: missing,
    });
  }

  const sourceRow = probeRows.find((r) => bigintToNumber(r.id) === id);
  // Unreachable (probeIds.has(id) already passed) — defensive guard only.
  if (sourceRow === undefined) {
    return reply.code(500).send({ error: "internal" });
  }
  const fromFolderId = sourceRow.folder_id === null
    ? null
    : bigintToNumber(sourceRow.folder_id);

  // Main UPDATE — move the single row's folder_id.
  try {
    await prisma.$executeRaw`
      UPDATE monitor.documents
      SET folder_id = ${BigInt(targetRootId)}
      WHERE id = ${BigInt(id)}
    `;
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/:id/move-group (PATCH update)", error);
  }

  // 1-member auto-ungroup trigger — check only fromFolderId (the prior source
  // group); a null fromFolderId (was already ungrouped) is not a target.
  let autoUngroupedId: number | null = null;
  if (fromFolderId !== null) {
    const autoIds = await applyAutoUngroupForFolders(request, prisma, [fromFolderId]);
    // Single-folder call → length ≤ 1.
    autoUngroupedId = autoIds[0] ?? null;
  }

  request.log.info(
    {
      route: "/api/clauded-docs/:id/move-group", method: "PATCH",
      moved_id: id,
      from_folder_id: fromFolderId,
      to_folder_id: targetRootId,
      auto_ungrouped_id: autoUngroupedId,
      durationMs: Date.now() - start,
    },
    "doc moved between groups",
  );

  return {
    moved_id: id,
    from_folder_id: fromFolderId,
    to_folder_id: targetRootId,
    auto_ungrouped_id: autoUngroupedId,
  };
}

// PATCH /api/clauded-docs/group/:rootId/reorder
//
// Persists drag-and-drop member order. body.ordered_ids = all member ids of the
// rootId group in the desired 0-based display order.
//
// Validation (all must pass before UPDATE):
//   - rootId / ordered_ids format → 400 invalid_*
//   - ordered_ids must set-equal the DB members (folder_id == rootId):
//       * id not in the group → 400 (extra_ids) · missing member → 400 (missing_ids)
//   - on match, a single-statement CTE assigns display_order = array index.
//
// Single-statement CTE (no $transaction): unnest VALUES (id, ordinal), join
// documents, bulk UPDATE.
async function handleReorderGroup(
  request: FastifyRequest<{ Params: { rootId: string }; Body: unknown }>,
  reply: FastifyReply,
): Promise<ReorderGroupResponse | ClaudedDocsErrorBody> {
  const start = Date.now();
  const rootId = parseIdParam(request.params.rootId);
  if (rootId === null) {
    return reply.code(400).send({ error: "invalid_param", param: "rootId" });
  }
  const parsed = parseReorderBody(request.body);
  if (typeof parsed === "string") {
    return reply.code(400).send({ error: "invalid_body", reason: parsed });
  }
  const orderedIds = parsed.ordered_ids;

  const prisma = getPrisma();

  // 1) Fetch the group's actual members (folder_id == rootId).
  interface MemberRow {
    id: bigint;
  }
  let memberRows: MemberRow[];
  try {
    memberRows = await prisma.$queryRaw<MemberRow[]>`
      SELECT id FROM monitor.documents
      WHERE folder_id = ${BigInt(rootId)}
    `;
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/group/:rootId/reorder (PATCH member-fetch)", error);
  }

  // Empty group → nothing to reorder; treated like a non-existent root.
  if (memberRows.length === 0) {
    return reply.code(404).send({ error: "not_found", id: rootId });
  }

  // 2) Set-equality check — ordered_ids must exactly match the DB members.
  const dbMemberIds = new Set(memberRows.map((r) => bigintToNumber(r.id)));
  const orderedSet = new Set(orderedIds);
  // ids in ordered_ids but not in the group (external/non-existent member).
  const extraIds = orderedIds.filter((id) => !dbMemberIds.has(id));
  if (extraIds.length > 0) {
    return reply.code(400).send({
      error: "invalid_body",
      reason: `ordered_ids contains ids not in group ${rootId}: ${extraIds.join(", ")}`,
    });
  }
  // group members absent from ordered_ids (partial ordering forbidden).
  const missingIds = Array.from(dbMemberIds).filter((id) => !orderedSet.has(id));
  if (missingIds.length > 0) {
    return reply.code(400).send({
      error: "invalid_body",
      reason: `ordered_ids is missing group ${rootId} members: ${missingIds.join(", ")}`,
    });
  }

  // 3) Single-statement CTE — unnest (id, ordinal), bulk-assign display_order.
  //    WITH ORDINALITY is 1-based → adjust to 0-based (ord - 1). The
  //    folder_id = rootId re-check guards against a post-validation race.
  const orderedBigints = orderedIds.map((id) => BigInt(id));
  interface UpdatedOrderRow {
    id: bigint;
    display_order: number;
  }
  let updatedRows: UpdatedOrderRow[];
  try {
    updatedRows = await prisma.$queryRaw<UpdatedOrderRow[]>`
      WITH desired AS (
        SELECT t.id AS member_id, (t.ord - 1)::int AS new_order
        FROM unnest(${orderedBigints}::bigint[]) WITH ORDINALITY AS t(id, ord)
      )
      UPDATE monitor.documents d
      SET display_order = desired.new_order
      FROM desired
      WHERE d.id = desired.member_id
        AND d.folder_id = ${BigInt(rootId)}
      RETURNING d.id, d.display_order
    `;
  } catch (error) {
    return failWithDb(request, reply, "/api/clauded-docs/group/:rootId/reorder (PATCH update)", error);
  }

  // Reconstruct in request order (RETURNING order is not guaranteed); set
  // equality already ensured no member is missing.
  const ordering = orderedIds.map((id, index) => ({ id, display_order: index }));

  request.log.info(
    {
      route: "/api/clauded-docs/group/:rootId/reorder", method: "PATCH",
      folder_id: rootId,
      member_count: updatedRows.length,
      durationMs: Date.now() - start,
    },
    "group members reordered",
  );

  return {
    folder_id: rootId,
    member_count: updatedRows.length,
    ordering,
  };
}

/**
 * 1-member auto-ungroup follow-up helper. Fired by handleUngroup /
 * handleMoveGroup after the main UPDATE succeeds, given the folder_ids to check.
 *   - count == 1 group → NULL that lone member's folder_id + collect its id
 *   - count == 0 / ≥ 2 → no-op
 * Returns the auto-ungrouped member ids (for the response).
 *
 * Kept as an explicit 2-step (not folded into the CTE) for RETURNING extraction
 * + audit clarity. On failure it does NOT throw — logs + returns [] (the main
 * mutation already committed; only the trigger failed, recoverable via sweep).
 */
async function applyAutoUngroupForFolders(
  request: FastifyRequest,
  prisma: ReturnType<typeof getPrisma>,
  folderIds: number[],
): Promise<number[]> {
  if (folderIds.length === 0) return [];
  const folderIdBigints = folderIds.map((fid) => BigInt(fid));
  // Identify 1-member groups (GROUP BY folder_id HAVING COUNT(*) = 1) and pull
  // each group's sole member id.
  interface SingleMemberRow {
    folder_id: bigint;
    sole_member_id: bigint;
  }
  let singleMemberRows: SingleMemberRow[];
  try {
    singleMemberRows = await prisma.$queryRaw<SingleMemberRow[]>`
      SELECT folder_id, MIN(id) AS sole_member_id
      FROM monitor.documents
      WHERE folder_id = ANY(${folderIdBigints}::bigint[])
      GROUP BY folder_id
      HAVING COUNT(*) = 1
    `;
  } catch (error) {
    request.log.warn(
      { err: error, folder_ids: folderIds },
      "auto-ungroup probe failed — main mutation committed, trigger skipped",
    );
    return [];
  }

  if (singleMemberRows.length === 0) return [];

  // NULL those sole members' folder_id in one UPDATE.
  const soleMemberIds = singleMemberRows.map((r) => bigintToNumber(r.sole_member_id));
  const soleMemberBigints = singleMemberRows.map((r) => r.sole_member_id);
  try {
    await prisma.$executeRaw`
      UPDATE monitor.documents
      SET folder_id = NULL
      WHERE id = ANY(${soleMemberBigints}::bigint[])
    `;
  } catch (error) {
    request.log.warn(
      { err: error, candidate_ids: soleMemberIds },
      "auto-ungroup follow-up UPDATE failed — main mutation committed, manual sweep needed",
    );
    return [];
  }

  return soleMemberIds;
}

/**
 * Validate POST /api/clauded-docs/group body.
 * Success → normalized number[] (deduped, length ≥ 2) · failure → reason string.
 */
function parseGroupCreateBody(raw: unknown): GroupClaudedDocsBody | string {
  if (raw === null || typeof raw !== "object") {
    return "body must be a JSON object";
  }
  const body = raw as Record<string, unknown>;
  const memberIdsRaw = body.member_ids;
  if (!Array.isArray(memberIdsRaw)) {
    return "member_ids must be an array";
  }
  const normalized = normalizeMemberIds(memberIdsRaw);
  if (typeof normalized === "string") return normalized;
  if (normalized.length < 2) {
    return "member_ids must contain at least 2 distinct positive integers (group requires 2+ members)";
  }
  return { member_ids: normalized };
}

/**
 * Validate POST /api/clauded-docs/ungroup body.
 * Success → normalized number[] (deduped, length ≥ 1).
 */
function parseUngroupBody(raw: unknown): UngroupClaudedDocsBody | string {
  if (raw === null || typeof raw !== "object") {
    return "body must be a JSON object";
  }
  const body = raw as Record<string, unknown>;
  const memberIdsRaw = body.member_ids;
  if (!Array.isArray(memberIdsRaw)) {
    return "member_ids must be an array";
  }
  const normalized = normalizeMemberIds(memberIdsRaw);
  if (typeof normalized === "string") return normalized;
  if (normalized.length < 1) {
    return "member_ids must contain at least 1 positive integer";
  }
  return { member_ids: normalized };
}

/**
 * Validate PATCH /api/clauded-docs/:id/move-group body.
 * Success → { target_group_root_id: number }.
 */
function parseMoveGroupBody(raw: unknown): MoveGroupBody | string {
  if (raw === null || typeof raw !== "object") {
    return "body must be a JSON object";
  }
  const body = raw as Record<string, unknown>;
  const targetRaw = body.target_group_root_id;
  if (typeof targetRaw !== "number" && typeof targetRaw !== "bigint") {
    return "target_group_root_id is required and must be a positive integer";
  }
  const numeric = typeof targetRaw === "bigint" ? Number(targetRaw) : targetRaw;
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return "target_group_root_id must be a positive integer (got " + String(targetRaw) + ")";
  }
  if (numeric > Number.MAX_SAFE_INTEGER) {
    return "target_group_root_id exceeds Number.MAX_SAFE_INTEGER";
  }
  return { target_group_root_id: numeric };
}

/**
 * Validate PATCH /api/clauded-docs/group/:rootId/reorder body.
 * Success → { ordered_ids: number[] } (order preserved, duplicates rejected,
 * length ≥ 1) · failure → reason string.
 *
 * normalizeMemberIds is NOT used — it sorts/dedupes, but reorder is
 * order-significant. Duplicates are explicitly rejected (a dup id from the
 * drag-and-drop UI is a client bug, not something to silently normalize).
 */
function parseReorderBody(raw: unknown): ReorderGroupBody | string {
  if (raw === null || typeof raw !== "object") {
    return "body must be a JSON object";
  }
  const body = raw as Record<string, unknown>;
  const orderedRaw = body.ordered_ids;
  if (!Array.isArray(orderedRaw)) {
    return "ordered_ids must be an array";
  }
  if (orderedRaw.length < 1) {
    return "ordered_ids must contain at least 1 positive integer";
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = 0; i < orderedRaw.length; i++) {
    const elem = orderedRaw[i];
    if (typeof elem !== "number" && typeof elem !== "bigint") {
      return `ordered_ids[${i}] must be a positive integer (got ${typeof elem})`;
    }
    const numeric = typeof elem === "bigint" ? Number(elem) : elem;
    if (!Number.isInteger(numeric) || numeric <= 0) {
      return `ordered_ids[${i}] must be a positive integer (got ${String(elem)})`;
    }
    if (numeric > Number.MAX_SAFE_INTEGER) {
      return `ordered_ids[${i}] exceeds Number.MAX_SAFE_INTEGER`;
    }
    if (seen.has(numeric)) {
      return `ordered_ids[${i}] duplicate id ${numeric} (each member must appear exactly once)`;
    }
    seen.add(numeric);
    out.push(numeric); // preserve order — no sort
  }
  return { ordered_ids: out };
}

/**
 * Normalize a member_ids array — validate all positive integers, dedupe, sort.
 * Success → sorted distinct number[] · failure → reason string. Sorting keeps
 * the response affected_member_ids stable + audit logs readable.
 */
function normalizeMemberIds(raw: unknown[]): number[] | string {
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const elem = raw[i];
    if (typeof elem !== "number" && typeof elem !== "bigint") {
      return `member_ids[${i}] must be a positive integer (got ${typeof elem})`;
    }
    const numeric = typeof elem === "bigint" ? Number(elem) : elem;
    if (!Number.isInteger(numeric) || numeric <= 0) {
      return `member_ids[${i}] must be a positive integer (got ${String(elem)})`;
    }
    if (numeric > Number.MAX_SAFE_INTEGER) {
      return `member_ids[${i}] exceeds Number.MAX_SAFE_INTEGER`;
    }
    if (seen.has(numeric)) continue;
    seen.add(numeric);
    out.push(numeric);
  }
  out.sort((a, b) => a - b);
  return out;
}

// Consume the root resolver at module init to surface misconfiguration on
// import instead of first request — it throws on a non-empty non-absolute env
// value, failing fast at route registration in main.ts.
void getHtmlBodyRoot();
