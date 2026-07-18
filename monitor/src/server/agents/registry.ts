// agent-registry.json loader → agent name → AgentRegistryEntry Map (singleton cache).
// SoT: `~/.glass-atrium/agent-registry.json` (env `AGENT_REGISTRY_PATH` override).
// singleton 이유: static 파일이라 per-request fs read + JSON.parse 회피 → /api/agents/summary p95 budget 보호.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import yaml from "js-yaml";

import { Prisma } from "../../generated/prisma/client.js";

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
  const frontmatter = extractFrontmatter(raw);
  if (frontmatter === null) {
    return null;
  }
  let parsed: unknown;
  try {
    // FAILSAFE_SCHEMA — constructs only plain strings/maps/lists, never typed
    // objects via tags (defense-in-depth; treats the `.md` as untrusted input).
    parsed = yaml.load(frontmatter, { schema: yaml.FAILSAFE_SCHEMA });
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }
  const description = (parsed as Record<string, unknown>).description;
  if (typeof description !== "string") {
    return null;
  }
  return toRoleLine(description);
}

// Pull the YAML block between the leading `---` fence and the next `---`; null when no opening fence.
function extractFrontmatter(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return null;
  }
  const body: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      return body.join("\n");
    }
    body.push(lines[i] ?? "");
  }
  // No closing fence — treat as malformed, no frontmatter.
  return null;
}

// Collapse a (possibly folded) description to one line, then take the first sentence as the role line.
// Identity wants a concise role, not the full "Use when / Do NOT use for" frontmatter prose.
function toRoleLine(description: string): string | null {
  const collapsed = description.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return null;
  }
  const sentenceEnd = collapsed.indexOf(". ");
  return sentenceEnd === -1 ? collapsed : collapsed.slice(0, sentenceEnd + 1);
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
