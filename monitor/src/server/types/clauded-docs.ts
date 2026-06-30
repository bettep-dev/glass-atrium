// Response/request shapes for /api/clauded-docs/* endpoints — backed by
// monitor.documents (single table) with the HTML body on FS only (hybrid).
// Format derives from the provided body field; audience is a 2-value exposure
// bit; lifecycle is the single doc_status axis with supersede chains on the
// supersedes_id FK. bigint ids coerce to JSON-safe number via bigintToNumber.

// Group cascade target. Same-folder_id rows bulk-update on PUT doc_status
// (single-statement CTE); supersede auto-transitions the predecessor to 'done'.
export type DocStatusLiteral = "progress" | "done";

// GET /:id body shape on disk. Default derives from the html_path extension
// (no `format` DB column — formatFromPath()); explicit `?format=` retained for
// HTML-primary back-compat. Content-Type: html → text/html (+sandbox CSP) ·
// json → application/json · yaml → application/yaml · md/txt → text/plain.
export type DocFormatToken = "html" | "md" | "yaml" | "json" | "txt";

// Exposure bit. 'exposed' = user + LLM read, shown in monitor UI · 'hidden' =
// LLM read only, hidden from UI (agent-only token-optimized record) · null =
// unspecified (read-side computeResponseAudience → 'exposed'). Legacy DB values
// (ops/public→exposed · agent-only→hidden) absorbed by read-side normalize.
export type AudienceLiteral = "exposed" | "hidden";

// Body-field 5-way discriminator — format derives from the provided field:
// html_body → HTML primary (user-requested visual/shared artifact) · md/yaml/
// json/txt_body → plain primary (agent-only token-optimized record). ≥2 body
// fields → 400 invalid_body (mutually exclusive, no silent fallback). audience
// unspecified → null (read-side 'exposed'). A doc_type field is silently ignored
// (no schema column). doc_status POST default 'progress'; supersede auto-transitions
// the predecessor to 'done'.
export interface CreateClaudedDocBody {
  title: string;
  author: string;
  // 'exposed' | 'hidden'. Unspecified (null) → read-side 'exposed'. Specifiable
  // for any format; no per-format default enforced.
  audience?: AudienceLiteral;
  // HTML primary body — full document or fragment both accepted.
  html_body?: string;
  // plain primary — one of md/yaml/json/txt (token-efficient record artifact).
  md_body?: string;
  // plain primary — YAML body.
  yaml_body?: string;
  // plain primary — JSON body (top-level object MUST).
  json_body?: string;
  // plain primary — raw UTF-8 text.
  txt_body?: string;
  // id of the prior version this document supersedes. null/undefined → chain root
  // (default) · positive int → predecessor id (FK + self-reference checked by
  // handleCreate; set → CTE auto-transitions predecessor to 'done') · negative /
  // 0 / NaN / nonexistent → 400 invalid_body.
  supersedes_id?: number;
  // group folder linkage. null/undefined → ungrouped (default, flattened to a
  // 1-member group in list responses) · positive int → root doc id (FK
  // monitor.documents.id ON DELETE SET NULL) · FK violation / NaN / negative →
  // 400 invalid_body. Self-reference unchecked at POST time (new row has no id yet).
  folder_id?: number;
  // workflow status (POST default 'progress', matching DB default; only
  // 'progress' | 'done' allowed). chain-root / folder_id NULL rows = cascade scope 1.
  doc_status?: DocStatusLiteral;
}
// Group display ordering excluded from create/update body — ordering SoT is the
// PATCH /group/:rootId/reorder endpoint. Accepting it here without a persistence
// path = silent-drop (no-silent-fallback) → not accepted.

export interface ListClaudedDocsQuery {
  author?: string;
  limit?: string;
  offset?: string;
  // Deprecation alias — no-op since the lifecycle axis unified. 'archived' /
  // 'superseded' → silent drop (empty response) · other values → silent ignore.
  doc_type?: string;
  // archived/superseded visibility toggle — backward-compat only (no response-shape
  // effect; all rows surfaced regardless). Adds an `X-Deprecation-Notice` header
  // on the unspecified-call path.
  include_archived?: string;
  // group member fetch. positive integer string → only folder_id-matching rows
  // (group-expand member detail) · unspecified → no filter · non-integer /
  // negative / 0 → 400 invalid_param. Complements /groups (representative +
  // member_count summary) with the per-member detail rows.
  folder_id?: string;
}

export interface ClaudedDocSummary {
  id: number;
  title: string;
  author: string;
  created_at: string;
  // SHA256(HTML body) — 64 hex chars; clients optimistic-lock (If-Match-style) on PUT.
  content_hash: string;
  /**
   * Opaque absolute path to the HTML primary on disk, under monitor-internal
   * storage (`$CLAUDED_DOCS_HTML_ROOT`). Clients MUST NOT parse the prefix or any
   * directory component for display / routing / behavior.
   */
  html_path: string;
  /** Deprecated — always `null`; no body is written here. Treat as opaque. */
  md_copy_path: string | null;
  last_synced_at: string | null;
  /** Exposure bit — see `AudienceLiteral`. null = legacy unspecified (→ 'exposed'). */
  audience: AudienceLiteral | null;
  /** Body type — derived from the html_path extension. Same as GET /:id `format`. */
  format: DocFormatToken;
  /** Prior version this row supersedes — null = chain root. Wire: bigint → number. */
  supersedes_id: number | null;
  /** Group cascade target — surfaced for the UI's cascade-toggle decision. */
  doc_status: DocStatusLiteral;
  /**
   * group folder linkage — null = ungrouped (split as group_key=-id in list
   * responses) · set = root doc id (same folder_id = same group). FK ON DELETE
   * SET NULL. Wire: bigint → number.
   */
  folder_id: number | null;
  /**
   * Explicit 0-based display order within a group — null = unset (created_at
   * fallback). Persisted via PATCH /api/clauded-docs/group/:rootId/reorder.
   * folder_id NULL rows are always null.
   */
  display_order: number | null;
}

export interface ListClaudedDocsResponse {
  total: number;
  rows: ClaudedDocSummary[];
  filter: {
    author: string | null;
    limit: number;
    offset: number;
  };
  fetched_at: string;
}

// folder grouping list. Same query params as /api/clauded-docs (filter composes
// at doc-level). Split-path UNION ALL: grouped (folder_id NOT NULL) → 1 group per
// folder_id, representative = DISTINCT ON (folder_id, created_at DESC, id DESC) ·
// ungrouped (folder_id NULL) → 1 group per row (group_key = -id, member_count=1).
// limit = 50 group/page default, max 200.
export interface ListClaudedDocsGroupsQuery {
  // deprecation alias (silent ignore — backward-compat).
  doc_type?: string;
  doc_status?: string;
  author?: string;
  limit?: string;
  offset?: string;
  include_archived?: string;
}

// Group representative row + member_count. The internal group_key
// (COALESCE(folder_id, -id), for split-path UNION ordering) is not surfaced;
// representative_* fields = metadata of the latest row in the group.
export interface ClaudedDocGroup {
  /** folder_id (group root) · null = ungrouped (1-member group). */
  folder_id: number | null;
  /** id of the group representative row (DISTINCT ON result) — used for detail GET. */
  representative_id: number;
  /** title of the group representative — the MAX(created_at) row's title. */
  representative_title: string;
  /** representative row's author · doc_status · audience · format · created_at. */
  representative_author: string;
  representative_doc_status: DocStatusLiteral;
  representative_audience: AudienceLiteral | null;
  representative_format: DocFormatToken;
  representative_created_at: string;
  /** representative row's predecessor FK — null = chain root. List-side revision-chain glyph source. */
  representative_supersedes_id: number | null;
  /** member count (NULL group = 1). */
  member_count: number;
  /** latest created_at in the group — pagination sort key (response ordering consistency). */
  group_latest_at: string;
}

export interface ListClaudedDocsGroupsResponse {
  total: number;
  /** filter-matched document count (doc-level; `total` is group-level) — '그룹 N · 문서 M' pill source. */
  doc_total: number;
  /** filter-matched docs with effective audience 'hidden' — server total, page-independent. */
  hidden_doc_total: number;
  groups: ClaudedDocGroup[];
  filter: {
    doc_status: DocStatusLiteral | null;
    author: string | null;
    limit: number;
    offset: number;
  };
  fetched_at: string;
}

// Detail payload — meta + body. `body` matches the route's `format` query param:
// HTML when format=html (default), Markdown when format=md.
export interface GetClaudedDocResponse {
  id: number;
  title: string;
  author: string;
  created_at: string;
  content_hash: string;
  /** Opaque HTML-primary path — see `ClaudedDocSummary.html_path`. */
  html_path: string;
  /** Deprecated, always `null` — see `ClaudedDocSummary.md_copy_path`. */
  md_copy_path: string | null;
  last_synced_at: string | null;
  /** Exposure bit — same as `ClaudedDocSummary.audience`. */
  audience: AudienceLiteral | null;
  format: DocFormatToken;
  /** Same as `ClaudedDocSummary.supersedes_id` — list/detail parity. */
  supersedes_id: number | null;
  /**
   * Latest successor id (row whose supersedes_id points here) — null = no successor.
   * POST/PUT responses are structurally null (fresh row · superseded rows are done → not editable).
   */
  superseded_by_id: number | null;
  /** Same as `ClaudedDocSummary.doc_status` — list/detail parity. */
  doc_status: DocStatusLiteral;
  /** Same as `ClaudedDocSummary.folder_id` — list/detail parity. */
  folder_id: number | null;
  /** Same as `ClaudedDocSummary.display_order` — list/detail parity. */
  display_order: number | null;
  body: string;
}

// Optimistic-lock contract — caller passes the last-fetched hash; a differing
// stored hash → 409 (concurrent edit). Body discriminator is audience-conditional:
// exposed → html_body required · hidden → one of md/yaml/json/txt_body. Omitting
// audience preserves the existing value; changing it requires the new audience +
// a matching body field together. ≥2 of the 5 body fields → 400 invalid_body.
export interface UpdateClaudedDocBody {
  expected_hash: string;
  // Required on HTML primary update.
  html_body?: string;
  // Required on MD primary update, or an option for hidden agent-only.
  md_body?: string;
  // plain body alternatives for hidden agent-only audience.
  yaml_body?: string;
  json_body?: string;
  txt_body?: string;
  // Absent → existing row value preserved.
  title?: string;
  // audience re-classification. Unspecified → existing value preserved.
  audience?: AudienceLiteral;
  // workflow status mutation (group cascade trigger). Unspecified → preserved (no
  // cascade) · 'progress' | 'done' → single-statement cascade CTE: folder_id NULL →
  // self only · folder_id set → all same-folder_id rows (cascade_count surfaced).
  doc_status?: DocStatusLiteral;
  // Group display ordering excluded — persistence SoT is the reorder endpoint
  // (see CreateClaudedDocBody).
}

export interface DeleteClaudedDocResponse {
  id: number;
  deleted: true;
}

// User-driven grouping UX endpoints — all 3 use a single-statement CTE (no
// multi-row $transaction). 1-member auto-ungroup: when a source group's
// member_count drops to 1 after ungroup / move-group, that lone member's
// folder_id is also set to NULL — done via an application-layer follow-up UPDATE
// (avoids CTE branch bloat + surfaces an audit log via `auto_ungrouped_id`).

// POST /api/clauded-docs/group — bind member_ids into one group. root =
// MAX(updated_at) member, its id becoming the shared folder_id. member_ids:
// length ≥ 2 · positive integers · all exist in DB · no duplicates.
export interface GroupClaudedDocsBody {
  member_ids: number[];
}

export interface GroupClaudedDocsResponse {
  /** formed group root id (= folder_id, set on all members). */
  folder_id: number;
  /** group member count after forming (== member_ids.length). */
  member_count: number;
  /** all member ids included (== request.member_ids — surfaced after DB check). */
  affected_member_ids: number[];
}

// POST /api/clauded-docs/ungroup — set folder_id to NULL for member_ids.
// member_ids: length ≥ 1 · positive integers · all exist in DB. Partial ungroup
// allowed — a group left with 1 member is auto-ungrouped here (auto_ungrouped_id).
export interface UngroupClaudedDocsBody {
  member_ids: number[];
}

export interface UngroupClaudedDocsResponse {
  /** count of members with folder_id set to NULL (== member_ids.length). */
  ungrouped_count: number;
  /** all ungrouped member ids (== request.member_ids — surfaced after DB check). */
  affected_member_ids: number[];
  /**
   * 1-member auto-ungroup trigger result — ids of source groups left with 1
   * member (their folder_id also nulled). Empty array when none occurred.
   */
  auto_ungrouped_ids: number[];
}

// PATCH /api/clauded-docs/:id/move-group — move a doc's folder_id to
// target_group_root_id (positive int · exists in DB · differs from :id). If the
// source group drops to 1 member after the move, that member is auto-ungrouped.
export interface MoveGroupBody {
  target_group_root_id: number;
}

export interface MoveGroupResponse {
  moved_id: number;
  /** folder_id before the move (null = previously ungrouped). */
  from_folder_id: number | null;
  /** folder_id after the move (= request.target_group_root_id). */
  to_folder_id: number;
  /**
   * 1-member auto-ungroup trigger result — id of the source group left with 1
   * member (folder_id nulled). null when none occurred.
   */
  auto_ungrouped_id: number | null;
}

// PATCH /api/clauded-docs/group/:rootId/reorder — persist drag-and-drop order.
// rootId = group folder_id; ordered_ids = all members in desired display order.
// Single-statement CTE: ordered_ids MUST exactly match all folder_id == rootId
// members (missing / extra / foreign-group id → 400 invalid_body or 404
// members_not_found), assigning display_order = 0-based array index. Unlike
// Group* / MoveGroup*, order is meaningful → normalizeMemberIds NOT applied; a
// dedicated parser preserves order + rejects duplicates only.
export interface ReorderGroupBody {
  /** all member ids in 0-based display order. No duplicates · positive integers. */
  ordered_ids: number[];
}

export interface ReorderGroupResponse {
  /** reordered group root id (= path param rootId · folder_id of all members). */
  folder_id: number;
  /** group member count after reorder (== ordered_ids.length). */
  member_count: number;
  /** Updated { id, display_order } pairs — FE reflects the new order without a round-trip. */
  ordering: { id: number; display_order: number }[];
}

export interface SearchClaudedDocsQuery {
  q?: string;
  limit?: string;
  offset?: string;
  // Same semantics as handleList.
  include_archived?: string;
}

export interface SearchClaudedDocHit {
  id: number;
  title: string;
  author: string;
  created_at: string;
  // ts_rank_cd score — higher = stronger match; FE can override the rank-desc default sort.
  rank: number;
  // ts_headline snippet around the matched terms; empty when no match span (very short docs).
  snippet: string;
  /** list-row parity — same as `ClaudedDocSummary.doc_status` (single-SELECT, avoids N+1). */
  doc_status: DocStatusLiteral;
  /** Same as `ClaudedDocSummary.audience`. */
  audience: AudienceLiteral | null;
  /** Same as `ClaudedDocSummary.format`. */
  format: DocFormatToken;
}

export interface SearchClaudedDocsResponse {
  query: string;
  total: number;
  rows: SearchClaudedDocHit[];
  // pg_bigm startup-detection result — false = tsvector-only fallback (Korean
  // substring quality reduced) → FE degraded-search notice.
  bigm_enabled: boolean;
  filter: {
    limit: number;
    offset: number;
  };
  fetched_at: string;
}

// Emitted by POST/PUT when the sanitized body fails `validateHtmlStructure`.
// `details.missing` lists the stable literal id of each absent structural element
// so the FE can surface a targeted error (which header/landmark to add).
export interface HtmlStructureInvalidError {
  error: {
    code: "html_structure_invalid";
    message: string;
    details: {
      // Subset of HtmlStructureMissingField literals — plain string[] to avoid
      // leaking the validator's internal alias into the shared types surface.
      missing: string[];
    };
  };
}

// P1 placeholder-residue gate failure. `details.lines` lists the 1-based source
// line numbers carrying residual `{{…}}` template tokens (ascending).
export interface PlaceholderResidueError {
  error: {
    code: "placeholder_residue";
    message: string;
    details: {
      lines: number[];
    };
  };
}

// D8 P2 style-lint failure. `details.findings` reports ALL violations (not
// first-only); each is either line-anchored (carries `line`) or document-level.
// `rule` mirrors the validator's frozen StyleRule allowlist as a plain string to
// avoid leaking the internal alias into the shared types surface.
export interface D8StyleViolationError {
  error: {
    code: "d8_style_violation";
    message: string;
    details: {
      findings: (
        | { kind: "line-anchored"; line: number; rule: string }
        | { kind: "document-level"; rule: string }
      )[];
    };
  };
}

// D8 P2 comparison-table column-cap failure. `details` locates the first
// violating table (1-based nth-of-type index) with its column count + the cap.
export interface D8P2ViolationErrorBody {
  error: {
    code: "d8_p2_violation";
    message: string;
    details: {
      tableIndex: number;
      columnCount: number;
      maxAllowed: number;
    };
  };
}

// Per-id audit entry for POST /html-export — written into the zip's
// _manifest.json AND carried in the zero-included `export_failed` envelope.
export interface HtmlExportManifestEntry {
  id: number;
  included: boolean;
  reason?: string;
}

export type ClaudedDocsErrorBody =
  | { error: "internal" }
  | { error: "database_unavailable" }
  // DB-rejected client input (SQLSTATE class 22/23) — db-failure.ts taxonomy split.
  | { error: "invalid_input"; reason: string }
  | { error: "filesystem_unavailable"; reason: string }
  // POST /html-export with ZERO includable ids — JSON envelope instead of a
  // doc-less 200 zip (silent-failure guard); 404 all-not_found / 503 otherwise.
  | {
      error: "export_failed";
      reason: string;
      requested: number;
      manifest: HtmlExportManifestEntry[];
    }
  | { error: "invalid_param"; param: string; allowed?: ReadonlyArray<string | number> }
  | { error: "invalid_body"; reason: string }
  | { error: "not_found"; id: number }
  // Nonexistent members for the group mutation endpoints.
  | { error: "members_not_found"; missing_ids: number[] }
  | { error: "hash_conflict"; expected: string; actual: string }
  | { error: "duplicate_content"; existing_id: number }
  // Nested-envelope HTML-validation failures from validateStructureOrReply
  // (single response = at most one code; pipeline short-circuits on first miss).
  | HtmlStructureInvalidError
  | PlaceholderResidueError
  | D8StyleViolationError
  | D8P2ViolationErrorBody;
