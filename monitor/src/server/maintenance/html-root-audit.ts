// Boot-time reconciliation of stored monitor.documents.html_path values against
// the configured document root. A root change (env edit / migration) leaves rows
// pointing outside the root — every GET/PUT body read on them 500s until fixed.
// Loud non-fatal: mismatches are surfaced as an ERROR log at startup; the server
// stays up (unaffected rows + non-docs surfaces keep working).

import { sep } from "node:path";

import type { FastifyInstance } from "fastify";

import { getPrisma } from "../db.js";
import { getHtmlRoot } from "../clauded-docs/storage.js";

export interface HtmlRootAuditResult {
  root: string;
  total: number;
  mismatched: number;
  // Newest-first (highest id) — recent writes are the most actionable mismatches.
  sampleIds: number[];
}

const SAMPLE_LIMIT = 10;

/** Counts html_path rows not under `root` + samples the newest offending ids. */
export async function auditHtmlRootPrefixes(root: string): Promise<HtmlRootAuditResult> {
  // Trailing separator blocks sibling-prefix false negatives ("/a/b" vs "/a/bc/x").
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const prisma = getPrisma();
  const [countRows, sampleRows] = await Promise.all([
    prisma.$queryRaw<Array<{ total: bigint; mismatched: bigint }>>`
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE NOT starts_with(html_path, ${prefix}))::bigint AS mismatched
      FROM monitor.documents
    `,
    prisma.$queryRaw<Array<{ id: bigint }>>`
      SELECT id
      FROM monitor.documents
      WHERE NOT starts_with(html_path, ${prefix})
      ORDER BY id DESC
      LIMIT ${SAMPLE_LIMIT}
    `,
  ]);
  const counts = countRows[0];
  if (counts === undefined) {
    throw new Error("html-root audit count query returned no row");
  }
  return {
    root,
    total: Number(counts.total),
    mismatched: Number(counts.mismatched),
    sampleIds: sampleRows.map((row) => Number(row.id)),
  };
}

/**
 * Boot-stage wrapper — main.ts calls it after listen. Probe failure (DB down at
 * boot) downgrades to WARN: availability is the health route's responsibility.
 */
export async function auditHtmlRootAtBoot(app: FastifyInstance): Promise<void> {
  try {
    const result = await auditHtmlRootPrefixes(getHtmlRoot());
    if (result.mismatched > 0) {
      app.log.error(
        result,
        "html-root audit FAILED — stored html_path outside the document root; body reads on these ids will 500 (root moved without migrating rows?)",
      );
      return;
    }
    app.log.info({ root: result.root, total: result.total }, "html-root audit passed");
  } catch (error) {
    app.log.warn({ err: error }, "html-root audit could not run (non-fatal)");
  }
}
