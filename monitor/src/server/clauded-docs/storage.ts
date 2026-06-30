// I/O-only FS helpers for the HTML/plain document body on disk — pure functions,
// no Prisma/Fastify/logger (the route layer composes these + DB writes in one
// transaction). Root = `$CLAUDED_DOCS_HTML_ROOT` (monitor-internal default);
// path traversal is rejected against that root, and writes are atomic (temp +
// POSIX rename(2)) so a reader never sees a partial file.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

// Env variable keys — literal union prevents typo at refactor sites.
type DocsRootEnvKey = "CLAUDED_DOCS_HTML_ROOT";

// Default document root — monitor-internal.
const DEFAULT_HTML_ROOT_RELATIVE = join(".claude", "monitor", "data", "documents");

let cachedHtmlBodyRoot: string | null = null;

/**
 * Returns the configured document root (monitor-internal default).
 * Throws on invalid config (non-empty + non-absolute env value).
 */
export function getHtmlBodyRoot(): string {
  if (cachedHtmlBodyRoot !== null) {
    return cachedHtmlBodyRoot;
  }
  cachedHtmlBodyRoot = resolveRootFromEnv(
    "CLAUDED_DOCS_HTML_ROOT",
    DEFAULT_HTML_ROOT_RELATIVE,
  );
  return cachedHtmlBodyRoot;
}

/** Reset the cached document root — test harness only. */
export function resetDocsRootCache(): void {
  cachedHtmlBodyRoot = null;
}

// Resolve a root from env (or default).
function resolveRootFromEnv(
  key: DocsRootEnvKey,
  defaultRelativeFromHome: string,
): string {
  const raw = process.env[key];
  if (typeof raw === "string" && raw.length > 0) {
    return normalizeAbsoluteOrThrow(raw, key);
  }
  return resolve(join(homedir(), defaultRelativeFromHome));
}

function normalizeAbsoluteOrThrow(raw: string, envKey: DocsRootEnvKey): string {
  // Expand `~/` prefix → home — keeps user-supplied env values ergonomic.
  const expanded = expandHome(raw);
  const normalized = resolve(expanded);
  if (!isAbsolute(normalized)) {
    throw new Error(`${envKey} must be absolute, got: ${raw}`);
  }
  return normalized;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

// `getHtmlRoot()` is kept as a thin alias for `getHtmlBodyRoot()` to preserve
// the existing public surface across the route layer.
export function getHtmlRoot(): string {
  return getHtmlBodyRoot();
}

// Fixed ASCII token 'doc' for the filename prefix — no dependency on any prefix enum.
// The path is opaque (callers do not use the prefix / directory component for
// display or routing), so changing the token has no behavioral effect.
const FILENAME_PREFIX_TOKEN = "doc";

export interface DocPathInputs {
  // YYYY-MM-DD; the route passes Date.toISOString().slice(0,10) to keep the
  // representation stable.
  createdDate: string;
  // Pre-computed slug (see slugifyTitle below).
  slug: string;
}

/** Computes the absolute HTML path for a given doc identity (no FS access). */
export function computeHtmlPath(inputs: DocPathInputs): string {
  const basename = `${FILENAME_PREFIX_TOKEN}-${inputs.createdDate}-${inputs.slug}.html`;
  return join(getHtmlBodyRoot(), basename);
}

/**
 * Computes the plain primary (md) path.
 * Stored in the same root as the HTML primary (`$CLAUDED_DOCS_HTML_ROOT`, monitor-internal).
 */
export function computeMdPath(inputs: DocPathInputs): string {
  return computePlainPath(inputs, "md");
}

/**
 * Computes a generic plain-body path.
 * Supports all LLM token formats of choice for agent-only artifacts (md/yaml/json/txt).
 * Stored in the same root as computeMdPath (monitor-internal); only the extension branches.
 *
 * `extension` arg: file extension token (without leading dot) — "md" / "yaml" / "json" / "txt".
 * HTML has its own function (computeHtmlPath) — separate sanitize pipeline + separate meaning.
 */
export type PlainExtensionToken = "md" | "yaml" | "json" | "txt";

export function computePlainPath(
  inputs: DocPathInputs,
  extension: PlainExtensionToken,
): string {
  const basename = `${FILENAME_PREFIX_TOKEN}-${inputs.createdDate}-${inputs.slug}.${extension}`;
  return join(getHtmlBodyRoot(), basename);
}

const SLUG_MAX_LENGTH = 80;

/**
 * Title → URL/FS-safe slug. Keeps Korean syllables, ASCII alphanumerics, and
 * hyphens; strips everything else to single hyphens. Falls back to a stable
 * placeholder when the title has no usable characters (rare — empty or
 * symbol-only title).
 */
export function slugifyTitle(title: string): string {
  // Lowercase ASCII; Korean syllables + Hiragana + Katakana + CJK preserved.
  // Replace any sequence of disallowed chars with a single hyphen.
  const lowered = title.toLowerCase();
  // Allowed: a-z, 0-9, hyphen, Korean syllable block (가-힣), Hangul Jamo,
  // CJK Unified Ideographs. Everything else collapses to '-'.
  const cleaned = lowered.replace(/[^a-z0-9\-가-힣ㄱ-ㅎㅏ-ㅣ一-鿿]+/g, "-");
  // Trim leading/trailing hyphens + collapse runs.
  const collapsed = cleaned.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (collapsed.length === 0) {
    // Stable fallback — hashed empty-slug variant per call site (route adds id
    // suffix on collision so even repeated empty titles do not conflict).
    return "untitled";
  }
  return collapsed.length > SLUG_MAX_LENGTH ? collapsed.slice(0, SLUG_MAX_LENGTH) : collapsed;
}

/**
 * Asserts that `candidate` is inside `root`. Throws on escape attempts.
 * Required for any FS operation derived from user-supplied identifiers — DB
 * paths arrive trusted, but the route layer ALSO calls this defensively.
 */
export function assertPathInsideRoot(candidate: string, root: string): void {
  const resolvedCandidate = resolve(candidate);
  const resolvedRoot = resolve(root);
  // Use sep-suffix to prevent prefix-collision (`/a/b` matching `/a/bc`).
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(rootWithSep)) {
    throw new Error(
      `path escapes root: candidate=${resolvedCandidate} root=${resolvedRoot}`,
    );
  }
}

/**
 * Writes `body` to `targetPath` atomically. Strategy:
 *   1. ensure parent dir exists (recursive mkdir; idempotent)
 *   2. write to {targetPath}.tmp.{pid}.{uuid8}
 *   3. POSIX rename(2) — atomic on same filesystem
 * On any failure, the temp file is cleaned up.
 *
 * `overwrite: false` + existing target → throws (idempotency: route layer
 * uses this for create-only flows; update flows pass true).
 */
export interface AtomicWriteOptions {
  overwrite: boolean;
}

export async function writeFileAtomic(
  targetPath: string,
  body: string,
  options: AtomicWriteOptions,
): Promise<void> {
  if (!options.overwrite) {
    const exists = await pathExists(targetPath);
    if (exists) {
      throw new Error(`target exists, overwrite=false: ${targetPath}`);
    }
  }
  await mkdir(dirname(targetPath), { recursive: true });
  // Per-process unique temp path. UUID v4 (8-hex slice) eliminates module-level
  // mutable counter — survives hot reload / module re-evaluation. pid retained
  // for cross-process disambiguation + log readability.
  const tempPath = `${targetPath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(tempPath, body, { encoding: "utf8" });
    // POSIX rename — overwrites destination atomically (no partial-write window).
    await rename(tempPath, targetPath);
  } catch (error) {
    // Best-effort cleanup; ignore secondary failure (no file to remove if write
    // failed before creation).
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** Reads a UTF-8 file. Throws on missing/permission/encoding failure. */
export async function readFileUtf8(filePath: string): Promise<string> {
  return readFile(filePath, { encoding: "utf8" });
}

/**
 * Removes a file. Idempotent — silent when the file does not exist (caller may
 * be reconciling FS to DB state where one side is already cleaned).
 */
export async function removeFileIfExists(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

/** Returns true when the path is a regular file or directory. */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNoEntError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * ENOENT type guard — `node:fs/promises` errors carry `code: 'ENOENT'` on
 * missing-file. Type guard avoids the `any` route — error is
 * NodeJS.ErrnoException at runtime. Exported so the route layer shares the
 * same predicate.
 */
export function isNoEntError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code === "ENOENT";
}

/** SHA256 hex digest of the input string (UTF-8 byte representation). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
