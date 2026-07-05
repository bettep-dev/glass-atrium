// Health detail API: read-only endpoints feeding the system-health panels.
// Mixed sources — Prisma 7 raw queries (daemons, wiki-reports) + filesystem reads
// (hook-chain).
//
// Why "health-detail" filename: /api/health (liveness probe) already exists with a
// different response shape; this module covers the detail panels.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { Prisma } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { respondDbFailure } from "../db-failure.js";
import { nextOccurrenceUtc, DAEMON_CRON_SCHEDULE, type CronRule } from "../schedule-next-fire.js";
import { DAY_BUCKET_TIMEZONE } from "../timezone.js";
import type {
  CostGuardStateValue,
  DaemonPayloadEntry,
  DaemonStatusCard,
  DaemonStatusValue,
  HealthDaemonPayloadResponse,
  HealthDaemonsResponse,
  HealthDetailErrorBody,
  HealthHookChainResponse,
  HealthHookFailuresResponse,
  HealthWikiReportsResponse,
  HookChainEvent,
  HookEntry,
  HookErrorKindValue,
  HookFailureEntry,
  HookMatcherGroup,
  WikiReport,
} from "../types/health-detail.js";

// Why fixed allowlist: prevents arbitrary INTERVAL injection through query param.
const ALLOWED_WIKI_DAYS: ReadonlySet<number> = new Set([7, 14, 30, 90]);
const DEFAULT_WIKI_DAYS = 14;

// daemon-payload / hook-failures bounds. LIMIT is integer-validated then embedded
// via Prisma.raw (parameterized LIMIT placeholder is unstable on some drivers).
// Legacy 'daily-restart' stays allowed — historical payload rows remain readable.
const ALLOWED_PAYLOAD_DAEMONS: ReadonlySet<string> = new Set([
  "autoagent",
  "wiki",
  "daily-restart",
  "daily-restart-autoagent",
  "daily-restart-wiki",
]);
const DEFAULT_PAYLOAD_LIMIT = 10;
const MAX_PAYLOAD_LIMIT = 30;
// hook-failures: dual bound — days (time window) allowlist + limit (row count) integer clamp.
const ALLOWED_HOOK_FAILURE_DAYS: ReadonlySet<number> = new Set([7, 14, 30, 90]);
const DEFAULT_HOOK_FAILURE_DAYS = 30;
const DEFAULT_HOOK_FAILURE_LIMIT = 50;
const MAX_HOOK_FAILURE_LIMIT = 200;

// Mirrors PG core.hook_failures.error_kind enum — narrow PG text → union, drift→null
// (forces explicit type extension). Local copy per nodejs-dev "Module independence".
const KNOWN_HOOK_ERROR_KINDS: ReadonlySet<HookErrorKindValue> = new Set([
  "connection_refused",
  "timeout",
  "constraint_violation",
  "unknown",
  "identifier_rejected",
]);

// Filesystem source paths — all read-only.
const HOME_DIR = process.env.HOME ?? homedir();
const SETTINGS_PATH = path.join(HOME_DIR, ".claude", "settings.json");

// GA-root headless-OAuth secrets file — existence STAT only (never opened/read).
// Honors the same GA_ROOT override the launcher uses (its GA_ROOT resolution):
// ${GA_ROOT:-$HOME/.glass-atrium}/secrets/claude-auth.env.
const GA_ROOT_DIR = process.env.GA_ROOT ?? path.join(HOME_DIR, ".glass-atrium");
const CLAUDE_AUTH_ENV_PATH = path.join(GA_ROOT_DIR, "secrets", "claude-auth.env");

// needs_auth recovery pointer — env-var NAME + instruction only, never the token
// value (core-security.md Secret Management). Exported for the no-secret-content test.
export const NEEDS_AUTH_REMEDIATION =
  "Run: launcher → Token Setup (headless OAuth) to provision CLAUDE_CODE_OAUTH_TOKEN";

// Why hard-coded daemon list: status cards render in fixed order.
// daily-restart runs are role-qualified (one row per restarted daemon) so each
// role gets its own card; legacy merged 'daily-restart' rows are history-only
// (readable via daemon-payload, no active card). weekly-clear stays retired —
// daily-restart covers all context resets (historical rows + enum preserved).
const DAEMON_BOARD: ReadonlyArray<DaemonStatusCard["daemon_name"]> = [
  "autoagent",
  "wiki",
  "daily-restart-autoagent",
  "daily-restart-wiki",
];

// Staleness multiplier: a daemon is "stale" once its silence exceeds 1.5x the
// expected interval (daily-at → 24h, weekly-at → 7d).
const STALE_MULTIPLIER = 1.5;

interface DaemonRow {
  daemon_name: string;
  last_run_at: Date | null;
  last_status: string | null;
  cost_guard_state: string | null;
}

interface WikiReportRow {
  run_date: Date;
  status: string;
  deadlinks_count: number | null;
  dedup_count: number | null;
  compiled_count: number | null;
  compiled_total: number | null;
  compile_ms: bigint | null;
  started_at: Date | null;
  ended_at: Date | null;
}

interface RawHookEntry {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
}

interface RawHookGroup {
  matcher?: unknown;
  hooks?: unknown;
}

export async function registerHealthDetailRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health/daemons", handleDaemons);
  app.get("/api/health/wiki-reports", handleWikiReports);
  app.get("/api/health/hook-chain", handleHookChain);
  // Read-only drilldowns into two orphan tables.
  app.get("/api/health/daemon-payload", handleDaemonPayload);
  app.get("/api/health/hook-failures", handleHookFailures);
}

// ----- 1. /api/health/daemons -------------------------------------------------

async function handleDaemons(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<HealthDaemonsResponse | HealthDetailErrorBody> {
  const start = Date.now();
  const prisma = getPrisma();
  try {
    // DISTINCT ON yields the latest row per daemon by started_at desc — index-friendly
    // (matches @@index([daemonName, runDate(sort: Desc)]) in schema). cost_guard_state
    // is null for non-autoagent daemons by design (PG schema confirms).
    // WHERE clause aligns with DAEMON_BOARD.
    const rows = await prisma.$queryRaw<DaemonRow[]>`
      SELECT DISTINCT ON (daemon_name)
        daemon_name::text AS daemon_name,
        started_at AS last_run_at,
        status::text AS last_status,
        cost_guard_state::text AS cost_guard_state
      FROM core.daemon_runs
      WHERE daemon_name IN ('autoagent', 'wiki', 'daily-restart-autoagent', 'daily-restart-wiki')
      ORDER BY daemon_name, started_at DESC
    `;
    const byName = new Map<string, DaemonRow>();
    for (const row of rows) {
      byName.set(row.daemon_name, row);
    }

    // Single existence STAT of the shared claude-auth.env, once per response (never
    // per DAEMON_BOARD row) — the absence corroborator for the needs_auth proxy.
    const secretsAbsent = await isSecretsFileAbsent(request);

    const now = new Date();
    const daemons: DaemonStatusCard[] = DAEMON_BOARD.map((name) => {
      const row = byName.get(name);
      const lastRunAt = row?.last_run_at ?? null;
      const rule = DAEMON_CRON_SCHEDULE[name];
      const stalenessMinutes =
        lastRunAt === null ? null : Math.floor((now.getTime() - lastRunAt.getTime()) / 60_000);
      const isStale =
        rule === undefined || stalenessMinutes === null
          ? false
          : stalenessMinutes > expectedIntervalMinutes(rule) * STALE_MULTIPLIER;
      // Narrow PG `status::text` → DaemonStatusValue union (6 values incl. quota_exceeded).
      const lastStatus = narrowDaemonStatus(row?.last_status ?? null);
      // Spec: cost_guard_state is for autoagent only; other daemons report null.
      // Narrow PG `cost_guard_state::text` → CostGuardStateValue union (unknown → null).
      const costGuardState =
        name === "autoagent" ? narrowCostGuardState(row?.cost_guard_state ?? null) : null;

      // needs_auth firing proxy (A-D2) — pure seam, unit-tested without a DB.
      const needsAuth = deriveNeedsAuth({
        lastRunAt,
        isStale,
        lastStatus,
        costGuardState,
        secretsAbsent,
      });

      return {
        daemon_name: name,
        last_run_at: lastRunAt === null ? null : lastRunAt.toISOString(),
        last_status: lastStatus,
        expected_next_at:
          rule === undefined ? null : nextOccurrenceUtc(rule, DAY_BUCKET_TIMEZONE, now),
        cost_guard_state: costGuardState,
        staleness_minutes: stalenessMinutes,
        is_stale: isStale,
        needs_auth: needsAuth,
        needs_auth_remediation: needsAuth ? NEEDS_AUTH_REMEDIATION : null,
      };
    });

    request.log.info(
      {
        route: "/api/health/daemons",
        durationMs: Date.now() - start,
        daemonCount: daemons.length,
      },
      "health query complete",
    );
    // ISO time fields are UTC (toISOString + nextOccurrenceUtc UTC emission).
    return { daemons, computed_at: now.toISOString(), timezone: "UTC" };
  } catch (error) {
    return failWithDb(request, reply, "/api/health/daemons", error);
  }
}

// ----- 2. /api/health/wiki-reports --------------------------------------------

async function handleWikiReports(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<HealthWikiReportsResponse | HealthDetailErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days, DEFAULT_WIKI_DAYS, ALLOWED_WIKI_DAYS);
  if (days === null) {
    return reply.code(400).send(invalidParam("days"));
  }
  const prisma = getPrisma();
  try {
    // `days - 1` so days=14 yields a 14-day window inclusive of today.
    // Interval embedded via Prisma.raw is safe: `days` was validated against allowlist.
    const intervalLiteral = Prisma.raw(`INTERVAL '${days - 1} days'`);
    const rows = await prisma.$queryRaw<WikiReportRow[]>`
      SELECT
        run_date,
        status::text AS status,
        deadlinks_count,
        dedup_count,
        compiled_count,
        compiled_total,
        compile_ms,
        started_at,
        ended_at
      FROM core.daemon_runs
      WHERE daemon_name = 'wiki'
        AND run_date >= CURRENT_DATE - ${intervalLiteral}
      ORDER BY run_date ASC
    `;

    const reports: WikiReport[] = rows.map((row) => ({
      run_date: formatDateOnly(row.run_date),
      status: row.status,
      deadlinks_count: row.deadlinks_count,
      dedup_count: row.dedup_count,
      compiled_count: row.compiled_count,
      compiled_total: row.compiled_total,
      compile_ms: row.compile_ms === null ? null : bigintToNumber(row.compile_ms),
      started_at: row.started_at === null ? null : row.started_at.toISOString(),
      ended_at: row.ended_at === null ? null : row.ended_at.toISOString(),
    }));

    request.log.info(
      {
        route: "/api/health/wiki-reports",
        days,
        rowCount: reports.length,
        durationMs: Date.now() - start,
      },
      "health query complete",
    );
    // started_at/ended_at are UTC ISO; run_date is UTC midnight date slice.
    return { days, reports, timezone: "UTC" };
  } catch (error) {
    return failWithDb(request, reply, "/api/health/wiki-reports", error);
  }
}

// ----- 3. /api/health/hook-chain ----------------------------------------------

async function handleHookChain(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<HealthHookChainResponse | HealthDetailErrorBody> {
  const start = Date.now();
  try {
    const st = await stat(SETTINGS_PATH).catch((err: unknown) => {
      // Spec: always-200 on missing settings.json — return empty events.
      if (isFsAbsentError(err)) {
        return null;
      }
      throw err;
    });
    if (st === null) {
      request.log.warn(
        { route: "/api/health/hook-chain", path: SETTINGS_PATH },
        "settings.json not found; returning empty hook chain",
      );
      return {
        events: [],
        source_path: SETTINGS_PATH,
        source_mtime: new Date(0).toISOString(),
        // Sentinel epoch is still UTC; client renders "—" for `1970-01-01`.
        timezone: "UTC",
      };
    }

    const sourceMtime = new Date(st.mtimeMs).toISOString();
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const events = parseHookChain(raw, request);

    request.log.info(
      {
        route: "/api/health/hook-chain",
        eventCount: events.length,
        durationMs: Date.now() - start,
      },
      "health query complete",
    );
    // `source_mtime` is UTC ISO (settings.json mtimeMs → Date → toISOString).
    return { events, source_path: SETTINGS_PATH, source_mtime: sourceMtime, timezone: "UTC" };
  } catch (error) {
    // Truly unexpected (permission, IO failure mid-read) — log and 500.
    request.log.error({ err: error, route: "/api/health/hook-chain" }, "hook-chain query failed");
    reply.code(500);
    return { error: "internal" };
  }
}

function parseHookChain(raw: string, request: FastifyRequest): HookChainEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (parseError) {
    // Spec: always-200 on parse error — log + return empty events.
    request.log.warn(
      { err: parseError, route: "/api/health/hook-chain" },
      "settings.json JSON.parse failed",
    );
    return [];
  }
  if (parsed === null || typeof parsed !== "object") {
    return [];
  }
  const hooksField = (parsed as { hooks?: unknown }).hooks;
  if (hooksField === null || typeof hooksField !== "object") {
    return [];
  }

  const events: HookChainEvent[] = [];
  for (const [eventName, groupsRaw] of Object.entries(hooksField as Record<string, unknown>)) {
    if (!Array.isArray(groupsRaw)) {
      continue;
    }
    const groups: HookMatcherGroup[] = groupsRaw
      .filter((g): g is RawHookGroup => g !== null && typeof g === "object")
      .map(rawGroupToMatcherGroup);
    events.push({ event: eventName, groups });
  }
  return events;
}

function rawGroupToMatcherGroup(group: RawHookGroup): HookMatcherGroup {
  // settings.json convention: matcher may be empty string (means "all tools");
  // hooks is an array of { type, command, timeout } objects.
  const matcher = typeof group.matcher === "string" ? group.matcher : "";
  const hooksField = group.hooks;
  if (!Array.isArray(hooksField)) {
    return { matcher, hooks: [] };
  }
  const hooks: HookEntry[] = hooksField
    .filter((h): h is RawHookEntry => h !== null && typeof h === "object")
    .map(rawHookToEntry);
  return { matcher, hooks };
}

function rawHookToEntry(hook: RawHookEntry): HookEntry {
  return {
    command: typeof hook.command === "string" ? hook.command : "",
    type: typeof hook.type === "string" ? hook.type : null,
    timeout: typeof hook.timeout === "number" && Number.isFinite(hook.timeout) ? hook.timeout : null,
  };
}

// ----- 4. /api/health/daemon-payload ------------------------------------------

interface DaemonPayloadRow {
  run_date: Date;
  daemon_name: string;
  payload: unknown;
  payload_size_bytes: number;
}

async function handleDaemonPayload(
  request: FastifyRequest<{ Querystring: { daemon?: string; limit?: string } }>,
  reply: FastifyReply,
): Promise<HealthDaemonPayloadResponse | HealthDetailErrorBody> {
  const start = Date.now();
  // daemon filter: allowlist-enforced (blocks enum-cast injection). Defaults to autoagent.
  const daemon = request.query.daemon ?? "autoagent";
  if (!ALLOWED_PAYLOAD_DAEMONS.has(daemon)) {
    return reply.code(400).send(invalidParam("daemon"));
  }
  const limit = parseLimitParam(request.query.limit, DEFAULT_PAYLOAD_LIMIT, MAX_PAYLOAD_LIMIT);
  if (limit === null) {
    return reply.code(400).send(invalidParam("limit"));
  }
  const prisma = getPrisma();
  try {
    // daemon is allowlist-validated → parameter binding; limit is integer-clamped → Prisma.raw.
    const limitLiteral = Prisma.raw(String(limit));
    const rows = await prisma.$queryRaw<DaemonPayloadRow[]>`
      SELECT
        run_date,
        daemon_name::text AS daemon_name,
        payload,
        payload_size_bytes
      FROM core.daemon_run_payload
      WHERE daemon_name = ${daemon}::core."DaemonType"
      ORDER BY run_date DESC
      LIMIT ${limitLiteral}
    `;

    const entries: DaemonPayloadEntry[] = rows.map((row) => ({
      run_date: formatDateOnly(row.run_date),
      daemon_name: row.daemon_name,
      payload: row.payload,
      payload_size_bytes: row.payload_size_bytes,
    }));

    request.log.info(
      {
        route: "/api/health/daemon-payload",
        daemon,
        limit,
        rowCount: entries.length,
        durationMs: Date.now() - start,
      },
      "health query complete",
    );
    return { daemon, entries, timezone: "UTC" };
  } catch (error) {
    return failWithDb(request, reply, "/api/health/daemon-payload", error);
  }
}

// ----- 5. /api/health/hook-failures -------------------------------------------

interface HookFailureRow {
  id: bigint;
  failure_ts: Date;
  hook_name: string;
  target_table: string;
  error_kind: string;
  payload_ref: string | null;
  retry_attempted: boolean;
}

async function handleHookFailures(
  request: FastifyRequest<{ Querystring: { days?: string; limit?: string } }>,
  reply: FastifyReply,
): Promise<HealthHookFailuresResponse | HealthDetailErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(
    request.query.days,
    DEFAULT_HOOK_FAILURE_DAYS,
    ALLOWED_HOOK_FAILURE_DAYS,
  );
  if (days === null) {
    return reply.code(400).send(invalidParam("days"));
  }
  const limit = parseLimitParam(
    request.query.limit,
    DEFAULT_HOOK_FAILURE_LIMIT,
    MAX_HOOK_FAILURE_LIMIT,
  );
  if (limit === null) {
    return reply.code(400).send(invalidParam("limit"));
  }
  const prisma = getPrisma();
  try {
    // Both validated before embedding (days=allowlist, limit=integer clamp).
    const intervalLiteral = Prisma.raw(`INTERVAL '${days} days'`);
    const limitLiteral = Prisma.raw(String(limit));
    const [rows, recencyRows] = await Promise.all([
      prisma.$queryRaw<HookFailureRow[]>`
        SELECT
          id,
          failure_ts,
          hook_name,
          target_table,
          error_kind::text AS error_kind,
          payload_ref,
          retry_attempted
        FROM core.hook_failures
        WHERE failure_ts >= NOW() - ${intervalLiteral}
        ORDER BY failure_ts DESC
        LIMIT ${limitLiteral}
      `,
      // Fixed-24h tone aggregates — independent of the days/limit row window.
      prisma.$queryRaw<Array<{ count_24h: bigint; unretried_count_24h: bigint }>>`
        SELECT
          COUNT(*)::bigint AS count_24h,
          COUNT(*) FILTER (WHERE retry_attempted = FALSE)::bigint AS unretried_count_24h
        FROM core.hook_failures
        WHERE failure_ts >= NOW() - INTERVAL '24 hours'
      `,
    ]);
    const recency = recencyRows[0];
    const count24h = recency === undefined ? 0 : bigintToNumber(recency.count_24h);
    const unretriedCount24h =
      recency === undefined ? 0 : bigintToNumber(recency.unretried_count_24h);

    const failures: HookFailureEntry[] = rows.map((row) => ({
      id: bigintToNumber(row.id),
      failure_ts: row.failure_ts.toISOString(),
      hook_name: row.hook_name,
      target_table: row.target_table,
      error_kind: narrowHookErrorKind(row.error_kind),
      payload_ref: row.payload_ref,
      retry_attempted: row.retry_attempted,
    }));

    request.log.info(
      {
        route: "/api/health/hook-failures",
        days,
        limit,
        rowCount: failures.length,
        durationMs: Date.now() - start,
      },
      "health query complete",
    );
    return {
      days,
      failures,
      count_24h: count24h,
      unretried_count_24h: unretriedCount24h,
      timezone: "UTC",
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/health/hook-failures", error);
  }
}

// ----- shared helpers (mirror dashboard.ts/autoagent.ts patterns) -------------

function parseDaysParam(
  raw: string | undefined,
  fallback: number,
  allowed: ReadonlySet<number>,
): number | null {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || !allowed.has(parsed)) {
    return null;
  }
  return parsed;
}

// LIMIT-only parser: [1, max] integer clamp instead of an allowlist (row count is
// continuous, so a fixed set is unsuitable). Non-integer / <1 / >max → null (400 invalid_param).
function parseLimitParam(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    return null;
  }
  return parsed;
}

function bigintToNumber(value: bigint): number {
  // PG bigint values realistic for this app fit in safe-int range.
  // Guard against future scale: surface a clear error rather than silent truncation.
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`bigint ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

// Mirrors dashboard.ts narrowDaemonStatus — local copy per nodejs-dev "Module
// independence". Future enum drift surfaces as null (forces explicit type extension).
const KNOWN_DAEMON_STATUSES: ReadonlySet<DaemonStatusValue> = new Set([
  "ok",
  "partial",
  "error",
  "missing",
  "stale",
  "quota_exceeded",
]);

function narrowDaemonStatus(raw: string | null): DaemonStatusValue | null {
  if (raw === null) {
    return null;
  }
  return KNOWN_DAEMON_STATUSES.has(raw as DaemonStatusValue) ? (raw as DaemonStatusValue) : null;
}

// Mirrors narrowDaemonStatus — future CostGuardState drift surfaces as null
// (forces explicit type extension). infra_fault = 401/credential auth fault.
const KNOWN_COST_GUARD_STATES: ReadonlySet<CostGuardStateValue> = new Set([
  "ok",
  "warn",
  "block",
  "infra_fault",
]);

// Exported for unit test (narrowing seam) — runtime callers stay in-module.
export function narrowCostGuardState(raw: string | null): CostGuardStateValue | null {
  if (raw === null) {
    return null;
  }
  return KNOWN_COST_GUARD_STATES.has(raw as CostGuardStateValue)
    ? (raw as CostGuardStateValue)
    : null;
}

// PG error_kind enum is NOT NULL → always one of 4 values. Unknown values (future
// enum additions) fall back safely to "unknown" (blocks union violation + broken response).
function narrowHookErrorKind(raw: string): HookErrorKindValue {
  return KNOWN_HOOK_ERROR_KINDS.has(raw as HookErrorKindValue)
    ? (raw as HookErrorKindValue)
    : "unknown";
}

function formatDateOnly(date: Date): string {
  // Why manual UTC slice: PG DATE arrives as midnight UTC; toISOString preserves Y-M-D.
  return date.toISOString().slice(0, 10);
}

// expectedIntervalMinutes stays local (staleness heuristic, not next-fire math);
// it consumes the shared CronRule via a type-only import so the daily-at /
// weekly-at interval logic keeps compiling against the extracted type.
function expectedIntervalMinutes(rule: CronRule): number {
  switch (rule.type) {
    case "daily-at":
      return 24 * 60;
    case "weekly-at":
      return 7 * 24 * 60;
  }
}

function isFsAbsentError(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// Existence STAT only — never opens/reads the target (its contents may be secret).
// Exported for unit test (fs seam): true = absent (ENOENT/ENOTDIR), false = present,
// null = indeterminate (permission / IO error, caller decides the conservative default).
export async function isPathAbsent(targetPath: string): Promise<boolean | null> {
  try {
    await stat(targetPath);
    return false;
  } catch (err) {
    if (isFsAbsentError(err)) {
      return true;
    }
    return null;
  }
}

// Single STAT of the GA-root claude-auth.env. Indeterminate (permission/IO) → treated
// as present so no false remediation pointer is surfaced.
async function isSecretsFileAbsent(request: FastifyRequest): Promise<boolean> {
  const absent = await isPathAbsent(CLAUDE_AUTH_ENV_PATH);
  if (absent === null) {
    request.log.warn(
      { route: "/api/health/daemons" },
      "claude-auth.env stat indeterminate; treating as present (no remediation)",
    );
    return false;
  }
  return absent;
}

// needs_auth firing proxy (A-D2), pure. firing = ran AND not stale · failing = non-ok
// status OR infra_fault cost-guard · unable = secrets file absent. A never-run/disabled
// daemon (lastRunAt null OR stale) is NOT firing → stays false even when secrets absent.
// Exported for unit test (no DB required).
export function deriveNeedsAuth(params: {
  lastRunAt: Date | null;
  isStale: boolean;
  lastStatus: DaemonStatusValue | null;
  costGuardState: CostGuardStateValue | null;
  secretsAbsent: boolean;
}): boolean {
  const isFiring = params.lastRunAt !== null && !params.isStale;
  const isFailing = params.lastStatus !== "ok" || params.costGuardState === "infra_fault";
  return isFiring && isFailing && params.secretsAbsent;
}

function failWithDb(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  error: unknown,
): HealthDetailErrorBody {
  return respondDbFailure(request, reply, route, error, "health query failed");
}

function invalidParam(name: string): HealthDetailErrorBody {
  return { error: "invalid_param", param: name };
}
