// Read-side integrity pass over stored document bodies: recompute each row's
// on-disk digest and compare it against the persisted monitor.documents.content_hash seal.
// Catches a partial write, a failed update rollback, or an out-of-band file edit — none of
// which the write-time optimistic lock can see, because it compares a client token at write
// time only.
//
// Advisory forever: divergence is reported, never blocked. A blocking read-path check would
// close the only repair channel (fetch the body, re-write it through the lock flow).
//
// Named invariant — the pass hashes the stored bytes AS-IS and never re-runs the HTML
// sanitizer. Every write path hashes the exact in-memory string it then writes, so the stored
// bytes ARE the hash pre-image; re-sanitizing would manufacture false positives (the
// sanitizer's tag stripping is not safe to repeat on stored content).

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import { isNoEntError } from "../clauded-docs/storage.js";
import { getPrisma } from "../db.js";

export type DocumentBodyCondition = "mismatch" | "missing" | "unreadable";

export interface DocumentBodyRow {
  id: number;
  path: string;
  contentHash: string;
}

export interface DocumentBodyIssue {
  id: number;
  path: string;
  condition: DocumentBodyCondition;
}

export interface DocumentBodyAuditResult {
  checked: number;
  intact: number;
  mismatch: number;
  missing: number;
  unreadable: number;
  // Newest-first (highest id) — recent writes are the most actionable divergences.
  issues: DocumentBodyIssue[];
  // Issue list hit ISSUE_SAMPLE_LIMIT; the counts above stay complete.
  truncated: boolean;
}

// Descriptor budget for a full-corpus sweep.
const READ_CONCURRENCY = 8;
const ISSUE_SAMPLE_LIMIT = 50;

/** Recomputes each row's body digest and reports the divergent rows. */
export async function auditBodyRows(
  rows: readonly DocumentBodyRow[],
): Promise<DocumentBodyAuditResult> {
  const issues: DocumentBodyIssue[] = [];
  let cursor = 0;
  const readNext = async (): Promise<void> => {
    while (cursor < rows.length) {
      const row = rows[cursor];
      cursor += 1;
      if (row === undefined) {
        return;
      }
      const issue = await getBodyIssue(row);
      if (issue !== null) {
        issues.push(issue);
      }
    }
  };
  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, rows.length) }, readNext);
  await Promise.all(workers);
  return buildAuditResult(rows.length, issues);
}

/**
 * Prisma-backed sweep. `limit` selects the newest-N cheap variant; null sweeps the corpus.
 */
export async function auditDocumentBodies(limit: number | null): Promise<DocumentBodyAuditResult> {
  return auditBodyRows(await getDocumentBodyRows(limit));
}

// html_path is the body path for every stored format — md_copy_path is dead (always NULL),
// so the pass never branches on it.
interface DocumentBodyDbRow {
  id: bigint;
  html_path: string;
  content_hash: string;
}

async function getDocumentBodyRows(limit: number | null): Promise<DocumentBodyRow[]> {
  const prisma = getPrisma();
  const rows =
    limit === null
      ? await prisma.$queryRaw<DocumentBodyDbRow[]>`
          SELECT id, html_path, content_hash FROM monitor.documents ORDER BY id DESC
        `
      : await prisma.$queryRaw<DocumentBodyDbRow[]>`
          SELECT id, html_path, content_hash FROM monitor.documents ORDER BY id DESC LIMIT ${limit}
        `;
  return rows.map((row) => ({
    id: Number(row.id),
    path: row.html_path,
    contentHash: row.content_hash,
  }));
}

async function getBodyIssue(row: DocumentBodyRow): Promise<DocumentBodyIssue | null> {
  let digest: string;
  try {
    digest = await getFileDigest(row.path);
  } catch (error) {
    // A row whose path fell outside a moved document root lands here as ENOENT → missing.
    const condition: DocumentBodyCondition = isNoEntError(error) ? "missing" : "unreadable";
    return { id: row.id, path: row.path, condition };
  }
  if (digest === row.contentHash) {
    return null;
  }
  return { id: row.id, path: row.path, condition: "mismatch" };
}

// Streams the file bytes so a large corpus never sits in memory. The byte digest equals the
// stored-string digest for well-formed rows; a file corrupted into invalid text mismatches
// under either method.
async function getFileDigest(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

function buildAuditResult(
  checked: number,
  issues: DocumentBodyIssue[],
): DocumentBodyAuditResult {
  // Sorted in place: the caller builds `issues` locally and never reads it after this call,
  // so the defensive copy bought nothing. One tally pass replaces three filter passes — free on
  // a healthy (0-issue) corpus, and the saving lands exactly when many rows diverge.
  issues.sort((a, b) => b.id - a.id);
  // Record keyed by the union: adding a condition breaks this initializer at compile time.
  const counts: Record<DocumentBodyCondition, number> = { mismatch: 0, missing: 0, unreadable: 0 };
  for (const issue of issues) {
    counts[issue.condition] += 1;
  }
  return {
    checked,
    intact: checked - issues.length,
    mismatch: counts.mismatch,
    missing: counts.missing,
    unreadable: counts.unreadable,
    issues: issues.slice(0, ISSUE_SAMPLE_LIMIT),
    truncated: issues.length > ISSUE_SAMPLE_LIMIT,
  };
}
