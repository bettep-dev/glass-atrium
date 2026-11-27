// agent-registry.json loader → agent name → AgentRegistryEntry Map (singleton cache).
// SoT: `~/.glass-atrium/agent-registry.json` (env `AGENT_REGISTRY_PATH` override).
// singleton 이유: static 파일이라 per-request fs read + JSON.parse 회피 → /api/agents/summary p95 budget 보호.

import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import yaml from "js-yaml";

import { Prisma } from "../../generated/prisma/client.js";
import { errnoCode } from "../errno.js";

/**
 * Single agent's registry entry — only metadata surfaceable in monitor responses.
 * - `domains`: capability hint (orchestrator routing)
 * - `phase`: lifecycle phase (`implementation` / `review` / `report` etc.)
 * - `dual_phase`: agent participates in two lifecycle phases; non-boolean / undeclared → false.
 * - `compatibility`: runtime precondition (e.g. "monitor running at 127.0.0.1:16145"); undeclared/non-string → null. Orthogonal to frontmatter `tools:`.
 * - `description`: 1-line role from the agent `.md` frontmatter (the `.md` is the SoT); null when missing / no usable description.
 */
export interface AgentRegistryEntry {
  domains: string[];
  phase: string;
  dual_phase: boolean;
  compatibility: string | null;
  description: string | null;
  // Provenance — "user" (created via ADD) or "shipped" (baseline); the delete affordance gates on origin === "user". null when undeclared.
  origin: string | null;
}

/** One agent file whose frontmatter `name` equals its base name; `file` is the base name, never a path. */
export interface AgentFile {
  name: string;
  file: string;
  role: string | null;
  frontmatter: Record<string, unknown>;
}

/** A matching agents-folder entry that is not readable as an agent, with the reason shown for it. */
export interface UnreadableAgentFile {
  file: string;
  reason: string;
}

/** Both lists sorted by file name. */
export interface AgentFileList {
  agents: AgentFile[];
  unreadable: UnreadableAgentFile[];
}

// Role line cap in characters, ellipsis included → one line in the Role column at a 1280 viewport.
export const ROLE_LINE_MAX_LENGTH = 52;

const ROLE_LINE_DROPPED_MARKS = /["`“”]/g;

// The role line names what the agent does, never the word "agent": a leading "Agent (for|that)", a trailing "(development) agent", one inside the phrase.
const ROLE_LINE_AGENT = {
  lead: /^agent(?: for| that)? /i,
  tail: /(?: development)? agent$/i,
  inner: / agent(?= )/gi,
};

// Words a cut can leave hanging before the ellipsis → dropped with it.
const ROLE_LINE_DANGLING_TAIL = /(?:[\s,;:/–—-]+|\s+(?:and|or|of|for|to|into|from|by|at|as|the|with|in|on|a|an))+$/i;

// Lowercase kebab name + `.md` → GLASS_ATRIUM_GLOBAL_RULES.md, references/ and templates/ never match.
const AGENT_FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*\.md$/;

// Refusal shown for a file whose realpath leaves the agents folder → the listing and the pin writer show the same words.
export const AGENT_OUTSIDE_FOLDER_REASON = "File is outside the agents folder";

// Raw JSON shape — unknown before validation.
interface RawRegistryRoot {
  agents?: Record<string, unknown>;
  version?: string;
}

let cachedEntries: Map<string, AgentRegistryEntry> | null = null;

// mtime of the registry file at cache-fill time — the revalidation key. The
// agent_lifecycle CLI (add/delete) rewrites the file out-of-process, so a stat
// mismatch means the cached Map is stale and must be re-read (no restart needed).
let cachedMtimeMs: number | null = null;

// warn once — corrupt registry 가 매 요청마다 stderr 범람하는 것 방지
let warnedOnce = false;

/**
 * Reads agent-registry.json into an entry Map (cached result preferred).
 *
 * On failure → empty Map (must not block startup) + one-time stderr warn.
 * Callers may read size === 0 as "no registry".
 */
export async function loadAgentRegistry(): Promise<Map<string, AgentRegistryEntry>> {
  const path = resolveRegistryPath();

  // mtime revalidation — reuse the cache only while the file is byte-for-byte
  // unchanged since it was read. A stat failure (missing file) leaves currentMtimeMs
  // null → cache is bypassed and the readFile catch below yields the empty-Map fallback.
  const currentMtimeMs = await readRegistryMtimeMs(path);
  if (cachedEntries !== null && currentMtimeMs !== null && currentMtimeMs === cachedMtimeMs) {
    return cachedEntries;
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    emitWarnOnce(`agent-registry read failed (${path}): ${describeError(error)}`);
    cachedEntries = new Map();
    cachedMtimeMs = null;
    return cachedEntries;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    emitWarnOnce(`agent-registry JSON parse failed (${path}): ${describeError(error)}`);
    cachedEntries = new Map();
    cachedMtimeMs = null;
    return cachedEntries;
  }
  const entries = normalizeRegistry(parsed);
  // Enrich with the `.md` role description (the `.md` is the SoT).
  // One-time per-agent fs read folded into the singleton cache — preserves the /api/agents/summary p95 budget.
  await enrichDescriptions(entries);
  cachedEntries = entries;
  cachedMtimeMs = currentMtimeMs;
  return cachedEntries;
}

// Registry file mtime in ms, or null when the file is absent/unstattable.
// null forces a (re)load attempt rather than serving a possibly-stale cache.
async function readRegistryMtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** Test hook — resets cache + warn flag. Do not call from production code. */
export function resetAgentRegistryCache(): void {
  cachedEntries = null;
  cachedMtimeMs = null;
  warnedOnce = false;
}

/**
 * Invalidate the singleton cache after an out-of-process registry mutation
 * (agent DELETE/ADD via the agent_lifecycle CLI) so the next loadAgentRegistry
 * re-reads the file. Complements mtime revalidation with immediate eviction —
 * a same-millisecond rewrite would otherwise slip past the stat comparison.
 * Distinct from resetAgentRegistryCache (a test-only full reset incl. warn flag).
 */
export function invalidateAgentRegistryCache(): void {
  cachedEntries = null;
  cachedMtimeMs = null;
}

// H6 rename-transition dual-match prefix — registry keys are `glass-atrium-*` post-rename;
// pre-rename DB rows still carry the bare agent form (see loadCanonicalAgentKeys doc below).
const CANONICAL_KEY_PREFIX = "glass-atrium-";

/**
 * Convenience — the canonical agent-key array (registry SoT) the membership gates bind against.
 * Folds the repeated `[...entries.keys()]` spread every gated call site duplicates. Empty array on an
 * empty/corrupt registry → the gate builders fail-open (predicate skipped).
 *
 * H6 rename-transition dual-match: every `glass-atrium-*` key is returned ALONGSIDE its de-prefixed legacy
 * alias (`glass-atrium-dev-shell` → `dev-shell`), deduped — pre-rename outcome/cost/dashboard rows carry the
 * bare form, so a prefixed-only IN-list would hide that history. Mirrors the DEV_AGENT_PREFIX dual-match in
 * routes/improvement.ts (style_ref telemetry); remove both together when the transition window closes.
 */
export async function loadCanonicalAgentKeys(): Promise<string[]> {
  const entries = await loadAgentRegistry();
  const dualMatched = [...entries.keys()].flatMap((key) =>
    key.startsWith(CANONICAL_KEY_PREFIX)
      ? [key, key.slice(CANONICAL_KEY_PREFIX.length)]
      : [key],
  );
  return [...new Set(dualMatched)];
}

// Bare membership fragment core — `<columnRef> IN (?..)`, or Prisma.empty on an empty registry.
// Single SoT for the LLM05 parameter-binding contract: agent names are BOUND via Prisma.join (never string-concatenated into the SQL text).
// Fail-open authored once here — Prisma.join([]) would emit a syntactically broken `IN ()`, so the length===0 guard skips the predicate.
// `columnRef` is inlined as raw SQL (a Prisma.Sql fragment, not a bound value), so callers pass a trusted column literal (`agent`, `o.agent`, `agent_type`, `agent_name`, `target_agent`), never user input.
function buildMembershipInList(
  canonicalAgents: ReadonlyArray<string>,
  columnRef: Prisma.Sql,
): Prisma.Sql {
  if (canonicalAgents.length === 0) {
    return Prisma.empty;
  }
  return Prisma.sql`${columnRef} IN (${Prisma.join([...canonicalAgents])})`;
}

/**
 * Canonical-membership gate — shared SoT for the "show only Atrium-system agents (registry SoT)" predicate
 * across every agent-dimensioned surface. Co-located with `loadAgentRegistry` so gated/ungated drift cannot recur.
 *
 * AND-PREFIXED shape: emits `AND <columnRef> IN (?..)` for append-after-a-complete-WHERE call sites.
 * Fail-open: an empty registry (read/parse failure) returns `Prisma.empty` so the predicate is skipped, not invalid SQL.
 *
 * `columnRef` defaults to the bare `agent` column; pass a qualified fragment (e.g. `Prisma.sql`o.agent``) when the
 * query aliases the source table, so the predicate can live inside a LEFT JOIN ... ON clause — a top-level WHERE on
 * the aliased column would collapse the LEFT JOIN into an inner join and drop generate_series gap-fill days.
 */
export function buildAgentMembershipFilter(
  canonicalAgents: ReadonlyArray<string>,
  columnRef: Prisma.Sql = Prisma.sql`agent`,
): Prisma.Sql {
  const fragment = buildMembershipInList(canonicalAgents, columnRef);
  // Preserve the Prisma.empty singleton on fail-open (callers strict-compare it).
  if (fragment === Prisma.empty) {
    return Prisma.empty;
  }
  return Prisma.sql`AND ${fragment}`;
}

/**
 * Canonical-membership gate — BARE-FRAGMENT companion to `buildAgentMembershipFilter`, over the SAME
 * fail-open + parameter-binding core.
 *
 * BARE shape: emits `<columnRef> IN (?..)` WITHOUT a leading `AND`, for the two families the AND-prefixed
 * form cannot serve — fragments-array builders ending in `Prisma.join(fragments, " AND ", "WHERE ")` (a stray
 * `AND` would break the join) and no-WHERE call sites that prefix their own `WHERE `. Omitted-on-empty:
 * `Prisma.empty` on an empty registry so the caller emits no `WHERE` (fail-open). `columnRef` as in `buildAgentMembershipFilter`.
 */
export function buildAgentMembershipFragment(
  canonicalAgents: ReadonlyArray<string>,
  columnRef: Prisma.Sql = Prisma.sql`agent`,
): Prisma.Sql {
  return buildMembershipInList(canonicalAgents, columnRef);
}

// env override → defaults to `~/.glass-atrium/agent-registry.json` (install root).
function resolveRegistryPath(): string {
  const override = process.env.AGENT_REGISTRY_PATH;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(homedir(), ".glass-atrium", "agent-registry.json");
}

// raw JSON → AgentRegistryEntry Map (defensive normalize).
function normalizeRegistry(parsed: unknown): Map<string, AgentRegistryEntry> {
  const out = new Map<string, AgentRegistryEntry>();
  if (!isPlainObject(parsed)) {
    return out;
  }
  const root = parsed as RawRegistryRoot;
  const agents = root.agents;
  if (!isPlainObject(agents)) {
    return out;
  }
  for (const [name, rawEntry] of Object.entries(agents)) {
    if (!isPlainObject(rawEntry)) {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    const domains = normalizeDomains(entry.domains);
    const phase = typeof entry.phase === "string" ? entry.phase : "";
    const dualPhase = entry.dual_phase === true;
    const compatibility = normalizeCompatibility(entry.compatibility);
    const origin = typeof entry.origin === "string" ? entry.origin : null;
    // description filled later by enrichDescriptions (reads the agent `.md`).
    out.set(name, {
      domains,
      phase,
      dual_phase: dualPhase,
      compatibility,
      description: null,
      origin,
    });
  }
  return out;
}

// Per-agent `.md` description enrichment — reads each `<name>.md` once (parallel, defensive).
// A missing/odd `.md` leaves description = null; one read never blocks the others (Promise.allSettled), all off the cached-singleton path.
async function enrichDescriptions(entries: Map<string, AgentRegistryEntry>): Promise<void> {
  const dir = resolveAgentMdDir();
  await Promise.allSettled(
    [...entries.entries()].map(async ([name, entry]) => {
      entry.description = await readAgentDescription(join(dir, `${name}.md`));
    }),
  );
}

// `~/.glass-atrium/agents/` — derived from the registry path's dir so an AGENT_REGISTRY_PATH override (tests) co-locates `.md` fixtures with the JSON.
function resolveAgentMdDir(): string {
  const override = process.env.AGENT_REGISTRY_PATH;
  if (typeof override === "string" && override.length > 0) {
    return join(dirname(override), "agents");
  }
  return join(homedir(), ".glass-atrium", "agents");
}

// Defensive `.md` description read — graceful on missing file / odd frontmatter; returns a single-line role description or null.
async function readAgentDescription(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const read = parseFrontmatterFields(raw);
  return "fields" in read ? toRoleLine(read.fields.description) : null;
}

/**
 * Agent files of one agents folder — the list the Models screen reads.
 * - Top-level entries matching `AGENT_FILE_NAME_PATTERN` only; a link is read only when it resolves to a file directly in the folder.
 * - A matching entry that fails a frontmatter check lands in `unreadable` with its reason, never dropped.
 * - Missing folder → empty lists; any other folder read failure rejects.
 */
export async function listAgentFiles(dir: string): Promise<AgentFileList> {
  const files = await getAgentFileNames(dir);
  const list: AgentFileList = { agents: [], unreadable: [] };
  if (files.length === 0) {
    return list;
  }
  const realDir = await realpath(dir);
  const reads = await Promise.all(files.map((file) => readAgentFile(dir, realDir, file)));
  for (const read of reads) {
    if ("reason" in read) {
      list.unreadable.push(read);
    } else {
      list.agents.push(read);
    }
  }
  return list;
}

// Sorted matching entry names; regular files and links only, so subfolders never count.
async function getAgentFileNames(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      return [];
    }
    throw new Error(`agents folder read failed (${dir})`, { cause: error });
  }
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && AGENT_FILE_NAME_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readAgentFile(dir: string, realDir: string, file: string): Promise<AgentFile | UnreadableAgentFile> {
  let raw: string;
  try {
    const resolved = await realpath(join(dir, file));
    if (dirname(resolved) !== realDir) {
      return { file, reason: AGENT_OUTSIDE_FOLDER_REASON };
    }
    raw = await readFile(resolved, "utf8");
  } catch {
    return { file, reason: "File could not be read" };
  }
  const read = parseFrontmatterFields(raw);
  if ("reason" in read) {
    return { file, reason: read.reason };
  }
  const name = file.slice(0, -".md".length);
  if (read.fields.name !== name) {
    return { file, reason: "Frontmatter name differs from the file name" };
  }
  return { name, file, role: toRoleLine(read.fields.description), frontmatter: read.fields };
}

/** One agent file as listAgentFiles reads it: the frontmatter fields and the text after the closing fence. */
export interface AgentFileParts {
  fields: Record<string, unknown>;
  body: string;
}

/** null when the frontmatter block is absent or unparseable. */
export function getAgentFileParts(raw: string): AgentFileParts | null {
  const read = parseFrontmatterFields(raw);
  return "reason" in read ? null : read;
}

function parseFrontmatterFields(raw: string): AgentFileParts | { reason: string } {
  const frontmatter = extractFrontmatter(raw);
  if (frontmatter === null) {
    return { reason: "No frontmatter block" };
  }
  let parsed: unknown;
  try {
    // FAILSAFE_SCHEMA — constructs only plain strings/maps/lists, never typed
    // objects via tags (defense-in-depth; treats the `.md` as untrusted input).
    parsed = yaml.load(frontmatter.block, { schema: yaml.FAILSAFE_SCHEMA });
  } catch {
    return { reason: "Frontmatter could not be parsed" };
  }
  return isPlainObject(parsed) ? { fields: parsed, body: frontmatter.body } : { reason: "Frontmatter could not be parsed" };
}

// The YAML block between the leading `---` fence and the next `---` line, plus the text after that closing fence; null when either fence is missing.
function extractFrontmatter(raw: string): { block: string; body: string } | null {
  const lines = raw.split(/(?<=\n)/);
  if (lines[0]?.trim() !== "---") {
    return null;
  }
  let offset = lines[0].length;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    offset += line.length;
    if (line.trim() === "---") {
      return { block: lines.slice(1, i).map((blockLine) => blockLine.replace(/\r?\n$/, "")).join("\n"), body: raw.slice(offset) };
    }
  }
  return null;
}

// Short role phrase from the description → one plain-text line on the Agents and Models screens.
// Identity wants a concise role, not the full "Use when / Do NOT use for" frontmatter prose.
function toRoleLine(description: unknown): string | null {
  if (typeof description !== "string") {
    return null;
  }
  const phrase = getRolePhrase(description);
  return phrase.length === 0 ? null : cutAtWord(phrase);
}

// One line, quote marks + backticks dropped → first sentence → its clause before an em dash, no period, no "agent".
function getRolePhrase(description: string): string {
  const collapsed = description.replace(ROLE_LINE_DROPPED_MARKS, "").replace(/\s+/g, " ").trim();
  const sentence = collapsed.split(". ")[0] ?? "";
  const clause = (sentence.split(" — ")[0] ?? "").replace(/\.$/, "").trim();
  const phrase = clause.replace(ROLE_LINE_AGENT.lead, "").replace(ROLE_LINE_AGENT.tail, "").replace(ROLE_LINE_AGENT.inner, "");
  return ROLE_LINE_AGENT.lead.test(clause) ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase;
}

// Over the cap → cut after the last whole word that fits beside the ellipsis; one unbroken word → a hard cut.
function cutAtWord(phrase: string): string {
  const chars = Array.from(phrase);
  if (chars.length <= ROLE_LINE_MAX_LENGTH) {
    return phrase;
  }
  const fitted = chars.slice(0, ROLE_LINE_MAX_LENGTH).join("");
  const lastSpace = fitted.lastIndexOf(" ");
  const kept = lastSpace > 0 ? fitted.slice(0, lastSpace) : chars.slice(0, ROLE_LINE_MAX_LENGTH - 1).join("");
  return `${kept.replace(ROLE_LINE_DANGLING_TAIL, "")}…`;
}

// compatibility normalize — non-empty string 만 허용, 그 외 → null (미선언 + 손상값 모두 null 로 일관)
function normalizeCompatibility(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  if (value.length === 0) {
    return null;
  }
  return value;
}

function normalizeDomains(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Direct stderr — diagnosable without a fastify logger injection. Once only.
function emitWarnOnce(msg: string): void {
  if (warnedOnce) {
    return;
  }
  warnedOnce = true;
  process.stderr.write(`[agent-registry] ${msg}\n`);
}
