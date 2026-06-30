// Clauded-docs search SQL builder — pure functions, no DB dependency.
//
// Responsibilities:
//   - Asymmetric tsvector weights (title=A, author=B, body=D) via inline setweight
//     · the existing GENERATED ts column is kept for WHERE filtering (index unchanged)
//     · only rank uses the inline expression → prevents body multi-matches from
//       overwhelming title matches
//   - When pg_bigm is available, an OR-branch (=% similarity operator) plus weighted
//     bigm_similarity summation
//     · Korean partial-match handled by the pg_bigm bigram index (pg_trgm is ASCII-only)
//     · without pg_bigm, a tsvector-only path — the route layer detects at startup and injects the flag
//
// Safety:
//   - All user input is bound via Prisma.sql tagged templates — no string concatenation (LLM05 defense)
//   - This module only assembles Prisma.Sql instances — execution is the route layer's job

import { Prisma } from "../../generated/prisma/client.js";

/**
 * Search SQL build inputs — injected by the route layer after normalize/validate.
 *
 * - `q`: user search term (normalized + trimmed) — bound to both websearch_to_tsquery and bigm_similarity
 * - `limit` / `offset`: validated integers — bound via Prisma.sql
 * - `bigmEnabled`: pg_bigm availability (startup detection) — false omits the OR-branch + bigm_rank
 */
export interface SearchBuildContext {
  q: string;
  limit: number;
  offset: number;
  bigmEnabled: boolean;
  // Backward-compat field — no-op since the lifecycle classification was removed
  // (same SQL regardless of value). Kept for route-layer plumbing compatibility.
  excludeArchived: boolean;
}

/**
 * Search query bundle — rows + count SQL bundled with the same context.
 * Uses the sum of `lexical_rank` (tsvector-weighted ts_rank_cd) + `bigm_rank`
 * (pg_bigm similarity, 0 when absent) as the primary ORDER BY key.
 */
export interface SearchSqlBundle {
  rowsSql: Prisma.Sql;
  countSql: Prisma.Sql;
}

/**
 * tsvector weight expression — re-evaluated per query by the route layer. The
 * GENERATED ts column is kept for WHERE-filter indexing; rank uses this expression.
 *
 * Weight assignment (ts_rank_cd default weight vector `{D=0.1, C=0.2, B=0.4, A=1.0}`):
 *   - title          → A (1.0)  — highest rank on exact match
 *   - author         → B (0.4)  — facet-level match
 *   - indexable_text → D (0.1)  — prevents body multi-matches from overwhelming title matches
 *
 * The resulting tsvector is not indexed (rank computation only) — the WHERE clause
 * separately uses the GENERATED `ts` column to leverage the `monitor_documents_ts_gin` index.
 */
const WEIGHTED_TS_EXPR = Prisma.sql`(
        setweight(to_tsvector('simple', coalesce(title,         '')), 'A')
     || setweight(to_tsvector('simple', coalesce(author,        '')), 'B')
     || setweight(to_tsvector('simple', coalesce(indexable_text,'')), 'D')
      )`;

/**
 * Builds one search SQL bundle. Assembles rows / count with a synchronized WHERE clause from the same ctx.
 *
 * Behavior:
 *   - bigmEnabled=true  → rank = lexical + bigm_similarity · WHERE = (ts @@ q) OR (indexable_text =% q)
 *   - bigmEnabled=false → rank = lexical only             · WHERE = ts @@ q
 *
 * The `=%` (full similarity match) operator is provided by pg_bigm — restores Korean
 * partial-match accuracy. bigm_similarity(indexable_text, q) is a 0..1 float, so summing
 * it with lexical_rank combines naturally (small scale gap: lexical avg ~0.1, bigm avg ~0.3).
 */
export function buildSearchSql(ctx: SearchBuildContext): SearchSqlBundle {
  const { q, limit, offset, bigmEnabled, excludeArchived } = ctx;

  // Permanent no-op (fixed Prisma.empty) — excludeArchived is backward-compat plumbing,
  // not reflected in the SQL output. The reference avoids a lint warning (caller destructures it).
  void excludeArchived;
  const archivedClause = Prisma.empty;

  // bigm branch — rank, WHERE clause, and the SELECT bigm_rank column all follow the same branch.
  const bigmRankSelect = bigmEnabled
    ? Prisma.sql`monitor.bigm_similarity(indexable_text, ${q})::float8`
    : Prisma.sql`0::float8`;

  // WHERE clause — bigmEnabled activates the OR-branch so Korean substrings also hit.
  // `=%` is pg_bigm full-similar (≥ bigm_similarity_threshold) — a distinct operator
  // from pg_trgm's `%`, leveraging the `monitor.gin_bigm_ops` operator-class index.
  const matchPredicate = bigmEnabled
    ? Prisma.sql`(ts @@ websearch_to_tsquery('simple', ${q}) OR indexable_text =% ${q})`
    : Prisma.sql`ts @@ websearch_to_tsquery('simple', ${q})`;

  const rowsSql = Prisma.sql`
    SELECT
      id,
      title,
      author,
      created_at,
      -- list-row parity fields. doc_status/audience are raw columns (route layer applies
      -- computeResponseAudience + DocStatusLiteral narrow); html_path → format via
      -- formatFromPath. monitor.documents is already scanned → projection cost ≈ 0.
      doc_status::text AS doc_status,
      audience,
      html_path,
      ts_rank_cd(
        ${WEIGHTED_TS_EXPR},
        websearch_to_tsquery('simple', ${q}),
        32
      )::float8 AS lexical_rank,
      ${bigmRankSelect} AS bigm_rank,
      ts_headline(
        'simple',
        indexable_text,
        websearch_to_tsquery('simple', ${q}),
        'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MaxWords=25, MinWords=8'
      ) AS snippet
    FROM monitor.documents
    WHERE ${matchPredicate}
      ${archivedClause}
    ORDER BY (
      ts_rank_cd(
        ${WEIGHTED_TS_EXPR},
        websearch_to_tsquery('simple', ${q}),
        32
      ) + ${bigmRankSelect}
    ) DESC, created_at DESC, id DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  const countSql = Prisma.sql`
    SELECT COUNT(*)::bigint AS total
    FROM monitor.documents
    WHERE ${matchPredicate}
      ${archivedClause}
  `;

  return { rowsSql, countSql };
}

/**
 * pg_bigm extension probe — called once at startup, result cached. The route layer
 * injects the result via SearchBuildContext.bigmEnabled per request.
 *
 * Queries pg_extension only — execution is the caller's job (a single check at
 * route registration time).
 */
export const BIGM_PROBE_SQL = Prisma.sql`
  SELECT 1 AS present
  FROM pg_extension
  WHERE extname = 'pg_bigm'
  LIMIT 1
`;
