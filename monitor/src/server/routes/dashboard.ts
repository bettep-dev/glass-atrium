// Dashboard API: 4 read-only panels + the P3-T3 self-update control plane (POST
// /api/dashboard/update single atomic apply + GET /api/dashboard/update-job).
// All DB access via Prisma 7 driver-adapter; raw SQL only via $queryRaw/$executeRaw
// template-tag (parameter interpolation handled by Prisma; SQL injection impossible).
// The update path never runs the long apply in-process: apply enqueues a DECOUPLED
// one-shot launchd job (so the install-parity `kickstart -k` monitor restart cannot
// kill the runner) and returns immediately.

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildAgentMembershipFilter, loadCanonicalAgentKeys } from "../agents/registry.js";
import { getPrisma } from "../db.js";
import { respondDbFailure } from "../db-failure.js";
import { DAY_BUCKET_TIMEZONE } from "../timezone.js";
import { nextOccurrenceUtc, DAEMON_CRON_SCHEDULE } from "../schedule-next-fire.js";
import {
	queryDaemonAggRows,
	resolveDaemonStatuses,
	type DaemonAggRow,
} from "../architecture/live-overlay.js";
import { Prisma } from "../../generated/prisma/client.js";
import { getUpdateStatus } from "../update-status.js";
import type {
  CostTimeseriesPoint,
  CostTimeseriesResponse,
  DaemonStatusItem,
  DaemonStatusResponse,
  DaemonStatusValue,
  DashboardErrorBody,
  KpiResponse,
  UpdateApplyResponse,
  UpdateJobStatusResponse,
  UpdateJobStatusValue,
  UpdateMutationErrorBody,
  UpdateStatusResponse,
} from "../types/dashboard.js";

// Why fixed allowlist: prevents arbitrary INTERVAL injection through query param.
const ALLOWED_TIMESERIES_DAYS: ReadonlySet<number> = new Set([7, 30, 90]);
const DEFAULT_TIMESERIES_DAYS = 7;

// Why hard-coded daemon list: the daemon mini-board cards are a fixed set.
// daily-restart runs are role-qualified (one row per restarted daemon) so each
// role gets its own card — consistent with the system-health board. Legacy
// merged "daily-restart" rows stay readable but carry no card/schedule.
type ActiveDaemonName = Exclude<DaemonStatusItem["daemon_name"], "daily-restart">;
const DAEMON_BOARD: ReadonlyArray<ActiveDaemonName> = [
  "autoagent",
  "wiki",
  "daily-restart-autoagent",
  "daily-restart-wiki",
];

interface KpiCostRow {
  today_cost: Prisma.Decimal | null;
  yesterday_cost: Prisma.Decimal | null;
  yesterday_same_time_cost: Prisma.Decimal | null;
  today_session_count: bigint;
  yesterday_session_count: bigint;
  yesterday_same_time_session_count: bigint;
  last_etl_at: Date | null;
}
interface KpiFailRow {
  last_1h_fail_count: bigint;
  fail_count_24h: bigint;
  blocked_count_24h: bigint;
}

interface TimeseriesRow {
  date: Date;
  input_tokens: bigint;
  output_tokens: bigint;
  cache_read_tokens: bigint;
  cache_creation_tokens: bigint;
  cost_usd: Prisma.Decimal;
  session_count: bigint;
}

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/dashboard/kpi", handleKpi);
  app.get("/api/dashboard/cost-timeseries", handleCostTimeseries);
  app.get("/api/dashboard/daemon-status", handleDaemonStatus);
  app.get("/api/dashboard/update-status", handleUpdateStatus);
  // P3-T3 self-update control plane — kept INSIDE this registrar (routes/index.ts
  // barrel-registers only registerDashboardRoutes, never edited).
  app.post("/api/dashboard/update", handleUpdate);
  app.get("/api/dashboard/update-job", handleUpdateJob);
}

// Update-availability verdict for the main-screen badge. DB-free (reads the local
// manifest + a cached HTTPS check), and NEVER throws — getUpdateStatus degrades
// every failure path to a typed "unknown"/"source-dev" body.
async function handleUpdateStatus(
  request: FastifyRequest,
): Promise<UpdateStatusResponse> {
  const start = Date.now();
  const body = await getUpdateStatus({ logger: request.log });
  request.log.info(
    { route: "/api/dashboard/update-status", status: body.status, durationMs: Date.now() - start },
    "dashboard query complete",
  );
  return body;
}

async function handleKpi(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<KpiResponse | DashboardErrorBody> {
  const start = Date.now();
  const prisma = getPrisma();
  try {
    // Registry-membership scope for the fail/blocked KPI band — closes the gap
    // in the monitor's agent-dimension registry-gating remediation (this
    // landing-page KPI band was the highest-visibility surface left unscoped).
    // AND-prefixed helper appended after the query's existing complete WHERE.
    const agentMembership = buildAgentMembershipFilter(await loadCanonicalAgentKeys());
    // 2 parallel queries: cost aggregates + recent fail/blocked counts.
    // Day buckets pinned in SQL to the configured day-bucket timezone (bind param,
    // config-sourced) — ETL writes event_date as that timezone's calendar day, so
    // CURRENT_DATE (session-tz-dependent) would silently mis-bucket.
    // last_etl_at: event_date + event_time is a bucket-tz wall-clock timestamp (no
    // tz); AT TIME ZONE converts it to a true UTC instant for toISOString.
    const [costRows, failRows] = await Promise.all([
      prisma.$queryRaw<KpiCostRow[]>`
        SELECT
          (SELECT COALESCE(SUM(cost_usd), 0) FROM core.cost_events
            WHERE event_date = (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date) AS today_cost,
          (SELECT COALESCE(SUM(cost_usd), 0) FROM core.cost_events
            WHERE event_date = (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date - 1) AS yesterday_cost,
          -- Same-time-of-day cut: event_time is a bucket-tz wall-clock TIME, so the
          -- ::time of NOW() in that tz is directly comparable (no conversion on the column).
          (SELECT COALESCE(SUM(cost_usd), 0) FROM core.cost_events
            WHERE event_date = (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date - 1
              AND event_time <= (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::time) AS yesterday_same_time_cost,
          (SELECT COUNT(DISTINCT session_id) FROM core.cost_events
            WHERE event_date = (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date) AS today_session_count,
          (SELECT COUNT(DISTINCT session_id) FROM core.cost_events
            WHERE event_date = (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date - 1) AS yesterday_session_count,
          (SELECT COUNT(DISTINCT session_id) FROM core.cost_events
            WHERE event_date = (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::date - 1
              AND event_time <= (NOW() AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text)::time) AS yesterday_same_time_session_count,
          (SELECT MAX(event_date + event_time) AT TIME ZONE ${DAY_BUCKET_TIMEZONE}::text
            FROM core.cost_events) AS last_etl_at
      `,
      prisma.$queryRaw<KpiFailRow[]>`
        SELECT
          COUNT(*) FILTER (WHERE result = 'fail' AND record_ts > NOW() - INTERVAL '1 hour') AS last_1h_fail_count,
          COUNT(*) FILTER (WHERE result = 'fail') AS fail_count_24h,
          COUNT(*) FILTER (WHERE result = 'blocked') AS blocked_count_24h
        FROM core.outcomes
        WHERE result IN ('blocked', 'fail')
          AND record_ts > NOW() - INTERVAL '24 hours'
          ${agentMembership}
      `,
    ]);

    const cost = costRows[0];
    const fail = failRows[0];
    if (cost === undefined || fail === undefined) {
      throw new Error("KPI aggregate returned no rows");
    }

    const body: KpiResponse = {
      today_cost_usd: decimalToNumber(cost.today_cost),
      yesterday_cost_usd: decimalToNumber(cost.yesterday_cost),
      yesterday_same_time_cost_usd: decimalToNumber(cost.yesterday_same_time_cost),
      last_1h_fail_count: bigintToNumber(fail.last_1h_fail_count),
      fail_count_24h: bigintToNumber(fail.fail_count_24h),
      blocked_count_24h: bigintToNumber(fail.blocked_count_24h),
      // True UTC instant (KST wall-clock converted in SQL) — client renders via formatKst*.
      last_etl_at: cost.last_etl_at === null ? null : cost.last_etl_at.toISOString(),
      today_session_count: bigintToNumber(cost.today_session_count),
      yesterday_session_count: bigintToNumber(cost.yesterday_session_count),
      yesterday_same_time_session_count: bigintToNumber(cost.yesterday_same_time_session_count),
      timezone: "UTC",
      day_bucket_timezone: DAY_BUCKET_TIMEZONE,
    };
    request.log.info(
      { route: "/api/dashboard/kpi", durationMs: Date.now() - start },
      "dashboard query complete",
    );
    return body;
  } catch (error) {
    return failWithDb(request, reply, "/api/dashboard/kpi", error);
  }
}

async function handleCostTimeseries(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<CostTimeseriesResponse | DashboardErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days, DEFAULT_TIMESERIES_DAYS, ALLOWED_TIMESERIES_DAYS);
  if (days === null) {
    return reply.code(400).send(invalidParam("days"));
  }
  const prisma = getPrisma();
  try {
    // Pin the series window to the day-bucket timezone's "today", the SAME calendar
    // day the KPI path buckets on — session-tz CURRENT_DATE would drift a day behind
    // (00:00–08:59 KST renders yesterday-as-today). Bound as a bind param (::date).
    const todayIso = computeBucketTzToday(new Date());
    // generate_series fills gap days with zero rows (LEFT JOIN). Interval embedded
    // via Prisma.raw is safe here because `days` was validated against allowlist.
    const windowLowerBound = buildWindowLowerBound(todayIso, days);
    const rows = await prisma.$queryRaw<TimeseriesRow[]>`
      SELECT
        d::date AS date,
        COALESCE(SUM(c.input_tokens), 0)::bigint AS input_tokens,
        COALESCE(SUM(c.output_tokens), 0)::bigint AS output_tokens,
        COALESCE(SUM(c.cache_read_tokens), 0)::bigint AS cache_read_tokens,
        COALESCE(SUM(c.cache_creation_tokens), 0)::bigint AS cache_creation_tokens,
        COALESCE(SUM(c.cost_usd), 0)::numeric(12,6) AS cost_usd,
        COUNT(DISTINCT c.session_id)::bigint AS session_count
      FROM generate_series(${windowLowerBound}, ${todayIso}::date, '1 day') d
      LEFT JOIN core.cost_events c ON c.event_date = d::date
      GROUP BY d
      ORDER BY d ASC
    `;

    const points: CostTimeseriesPoint[] = rows.map((row) => ({
      date: formatDateOnly(row.date),
      input_tokens: bigintToNumber(row.input_tokens),
      output_tokens: bigintToNumber(row.output_tokens),
      cache_read_tokens: bigintToNumber(row.cache_read_tokens),
      cache_creation_tokens: bigintToNumber(row.cache_creation_tokens),
      cost_usd: decimalToNumber(row.cost_usd),
      session_count: bigintToNumber(row.session_count),
    }));

    request.log.info(
      { route: "/api/dashboard/cost-timeseries", days, durationMs: Date.now() - start },
      "dashboard query complete",
    );
    // `points[].date` is UTC-midnight-derived (formatDateOnly slices toISOString).
    return { days, points, timezone: "UTC" };
  } catch (error) {
    return failWithDb(request, reply, "/api/dashboard/cost-timeseries", error);
  }
}

async function handleDaemonStatus(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<DaemonStatusResponse | DashboardErrorBody> {
  const start = Date.now();
  const prisma = getPrisma();
  try {
    // Shared latest-row-per-daemon + install-anchor fetch (live-overlay.ts) so this board
    // resolves off the SAME DISTINCT ON query as the architecture overlay. DAEMON_BOARD-aligned.
    const [rows, installAnchor] = await queryDaemonAggRows(prisma);
    const items = buildDaemonStatusItems(rows, new Date(), installAnchor);

    request.log.info(
      { route: "/api/dashboard/daemon-status", durationMs: Date.now() - start },
      "dashboard query complete",
    );
    // ISO time fields in items[] are UTC (toISOString + nextOccurrenceUtc UTC emission).
    return { items, timezone: "UTC" };
  } catch (error) {
    return failWithDb(request, reply, "/api/dashboard/daemon-status", error);
  }
}

// Pure daemon rows → DaemonStatusItem[] seam (DB-free, unit-tested). Routes the rows
// through the shared resolveDaemonStatuses (live-overlay F#38) so this board carries the
// SAME synthesized 'missing'/'stale' semantics as the architecture overlay + health board
// (a never-run daemon → 'missing', an overdue one → 'stale') instead of the raw last_status
// this route used to leak — then attaches the dashboard-only next-fire field.
export function buildDaemonStatusItems(
  rows: DaemonAggRow[],
  now: Date,
  installAnchor: Date | null,
): DaemonStatusItem[] {
  const statusByName = new Map(
    resolveDaemonStatuses(rows, now.getTime(), installAnchor).map(
      (d) => [d.daemon_name, d] as const,
    ),
  );
  return DAEMON_BOARD.map((name) => {
    const resolved = statusByName.get(name);
    return {
      daemon_name: name,
      last_run_at: resolved?.last_run_at ?? null,
      // resolveDaemonStatuses already synthesized missing/stale; narrow the string union
      // (unknown enum values defensively coerce to null rather than leaking raw text).
      last_status: narrowDaemonStatus(resolved?.status ?? null),
      expected_next_at: nextOccurrenceUtc(DAEMON_CRON_SCHEDULE[name], DAY_BUCKET_TIMEZONE, now),
    };
  });
}

// helpers

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

// Day-bucket timezone's "today" as an ISO calendar-day string (YYYY-MM-DD). The KPI
// path pins its buckets to this timezone via SQL NOW() AT TIME ZONE; the timeseries
// resolves the same bucket-tz wall-clock day here (en-CA → ISO format) so its series
// bounds agree with the KPI buckets instead of drifting to session-tz CURRENT_DATE.
// Deterministic given `now` — the frozen-clock route test asserts the KST-today bound.
export function computeBucketTzToday(now: Date, timeZone: string = DAY_BUCKET_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// Canonical "last N days" window lower bound, computed from the bucket-tz `today` bind
// param (todayIso), NOT session-tz CURRENT_DATE.
// Window = [today - (days-1) .. today] inclusive = exactly `days` calendar days (today
// counted), where `today` is the bucket-tz day (bind param), so every "last N days"
// card covers the same bucket-tz day-set as the KPI band.
// Safe: `days` allowlist-validated ({7, 30, 90}); `days - 1` is a derived integer.
function buildWindowLowerBound(todayIso: string, days: number): Prisma.Sql {
  return Prisma.sql`${todayIso}::date - ${Prisma.raw(`INTERVAL '${days - 1} days'`)}`;
}

function bigintToNumber(value: bigint): number {
  // PG COUNT(*) returns bigint; values realistic for this app fit in safe-int range.
  // Guard against future scale: surface a clear error rather than silent truncation.
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`bigint ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

function decimalToNumber(value: Prisma.Decimal | null): number {
  if (value === null) {
    return 0;
  }
  // Cost values are bounded (Decimal(12,6)); JSON-safe conversion needed.
  return Number(value.toString());
}

// Narrows raw PG `core.DaemonStatus` enum string into the typed union.
// Future enum additions on the DB side that aren't reflected here surface as
// `null` (forces explicit type extension rather than silent type leakage).
const KNOWN_DAEMON_STATUSES: ReadonlySet<DaemonStatusValue> = new Set([
  "ok",
  "partial",
  "error",
  "missing",
  "stale",
  "quota_exceeded",
  "apply_failed",
  "apply_unavailable",
]);

function narrowDaemonStatus(raw: string | null): DaemonStatusValue | null {
  if (raw === null) {
    return null;
  }
  return KNOWN_DAEMON_STATUSES.has(raw as DaemonStatusValue) ? (raw as DaemonStatusValue) : null;
}

function formatDateOnly(date: Date): string {
  // Why manual UTC slice: PG DATE arrives as midnight UTC; toISOString preserves Y-M-D.
  return date.toISOString().slice(0, 10);
}

function failWithDb(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  error: unknown,
): DashboardErrorBody {
  return respondDbFailure(request, reply, route, error, "dashboard query failed");
}

function invalidParam(name: string): DashboardErrorBody {
  return { error: "invalid_param", param: name };
}

// POST /api/dashboard/update (single atomic apply) + GET /api/dashboard/update-job. The route
// NEVER runs the long apply in-process: apply enqueues a DECOUPLED one-shot launchd job
// (scripts/update.sh renders the plist; launchctl bootstrap loads it) and returns immediately,
// so the install-parity `kickstart -k` monitor restart cannot kill the update runner.

const execFileAsync = promisify(execFile);

// Enqueue only renders a plist + boots a launchd job (both sub-second) → a tight
// ceiling; the buffer holds the one line of stdout the renderer prints.
const ENQUEUE_TIMEOUT_MS = 20_000;
const ENQUEUE_MAX_BUFFER = 1024 * 1024;

// Default stale-sweep cutoff (30 min). update.sh heartbeats its update_job row at
// long-stage boundaries rather than on a timer, so the cutoff must exceed the widest
// gap between two ticks: a crashed decoupled updater (heartbeat frozen) is reclaimed
// while a live one is never clobbered. Override: ATRIUM_UPDATE_STALE_MS (test seam).
const DEFAULT_STALE_MS = 30 * 60 * 1000;

// Row-reservation placeholder: the route resolves no release version before enqueue.
// The decoupled job overwrites target_version via update.sh update_job_set_version.
const PENDING_TARGET_VERSION = "pending";

type UpdateBodyResult =
  | { kind: "apply" }
  | { kind: "error"; body: UpdateMutationErrorBody };

// Manual body validation (NO Zod — these Fastify routes carry none; mirrors the
// agents.ts NAME_RE + typeof idiom). The only accepted mode is 'apply'; any
// deviation → 400 invalid_body.
function validateUpdateBody(rawBody: unknown): UpdateBodyResult {
  if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return { kind: "error", body: invalidBody("body", "must be a JSON object") };
  }
  const body = rawBody as Record<string, unknown>;
  if (body.mode === "apply") {
    return { kind: "apply" };
  }
  return { kind: "error", body: invalidBody("mode", "must be 'apply'") };
}

function invalidBody(field: string, reason: string): UpdateMutationErrorBody {
  return { error: "invalid_body", field, reason };
}

// POST /api/dashboard/update — single atomic apply. Every request first sweeps
// stale in-progress rows (WHERE-guarded, cannot clobber a fresh heartbeat) so a
// crashed updater never permanently blocks the single-active slot.
async function handleUpdate(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<UpdateApplyResponse | UpdateMutationErrorBody | DashboardErrorBody> {
  const validation = validateUpdateBody(request.body);
  if (validation.kind === "error") {
    reply.code(400);
    return validation.body;
  }
  const prisma = getPrisma();
  try {
    await sweepStaleJobs(prisma);
  } catch (error) {
    return failWithDb(request, reply, "/api/dashboard/update", error);
  }
  return runUpdateApply(request, reply, prisma);
}

// Stale sweep — a single WHERE-guarded UPDATE (status='in-progress' AND
// heartbeat_at < cutoff). It can only ever flip a genuinely stale row: a live
// updater advances heartbeat_at, and a freshly reserved row is younger than the
// cutoff, so neither is clobbered.
async function sweepStaleJobs(prisma: ReturnType<typeof getPrisma>): Promise<void> {
  const cutoff = new Date(Date.now() - resolveStaleMs());
  await prisma.updateJob.updateMany({
    where: { status: "in_progress", heartbeatAt: { lt: cutoff } },
    data: {
      status: "failed",
      failureReason: "stale — heartbeat timed out (updater crashed or never started)",
    },
  });
}

/**
 * mode=apply — the single atomic apply. Verify the `claude` precondition, reserve the
 * single-active in-progress row (the partial UNIQUE INDEX makes the INSERT the atomic
 * single-active guard), then IMMEDIATELY enqueue the decoupled one-shot launchd job and
 * return. The handler never runs (nor awaits) the long apply — the one-shot launchd job
 * runs it detached, and the UI polls GET /api/dashboard/update-job for progress.
 *
 * The route inspects nothing before enqueueing, so a click on an already-current install
 * reserves a row and starts a job that applies nothing. The per-file SHA-256 verify,
 * atomic swap and rollback all run inside update.sh on whatever the release turns out to
 * hold.
 */
async function runUpdateApply(
  request: FastifyRequest,
  reply: FastifyReply,
  prisma: ReturnType<typeof getPrisma>,
): Promise<UpdateApplyResponse | UpdateMutationErrorBody | DashboardErrorBody> {
  // claude -p precondition — the decoupled job's merge stage needs `claude`. Verify
  // it resolves BEFORE reserving/enqueuing so a doomed job is never launched and no
  // phantom in-progress row is left behind (loud-fail 500 claude_unresolved).
  const claudeBin = await resolveClaudeBin();
  if (claudeBin === null) {
    reply.code(500);
    return {
      error: "claude_unresolved",
      reason: "claude binary not resolvable for the decoupled update job",
    };
  }

  // Reserve the single-active in-progress row. The partial UNIQUE INDEX
  // (WHERE status='in-progress') makes this INSERT the atomic single-active guard:
  // a 2nd concurrent apply trips PG 23505 → Prisma P2002 → 409 single_active.
  const now = new Date();
  let rowId: bigint;
  try {
    const row = await prisma.updateJob.create({
      data: {
        status: "in_progress",
        startedAt: now,
        heartbeatAt: now,
        targetVersion: PENDING_TARGET_VERSION,
      },
    });
    rowId = row.id;
  } catch (error) {
    // Partial UNIQUE INDEX (WHERE status='in-progress') → PG 23505 → Prisma P2002.
    // This IS the single-active guard: a 2nd concurrent apply is atomically rejected.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      reply.code(409);
      return { error: "single_active", reason: "another update is already in progress" };
    }
    return failWithDb(request, reply, "/api/dashboard/update", error);
  }

  // Enqueue the decoupled one-shot launchd job. On any failure, mark the reserved
  // row failed (frees the single-active slot) + return 500 enqueue_failed.
  try {
    await enqueueDecoupledJob(bigintToNumber(rowId));
  } catch (error) {
    const parsed = parseExecErr(error);
    request.log.error(
      { route: "/api/dashboard/update", jobId: rowId.toString(), stderr: parsed.stderr },
      "decoupled update job enqueue failed",
    );
    await markJobFailed(prisma, rowId, "enqueue failed", request.log);
    reply.code(500);
    return { error: "enqueue_failed", reason: truncate(parsed.stderr) };
  }
  request.log.info(
    { route: "/api/dashboard/update", jobId: rowId.toString() },
    "decoupled update job enqueued (handler returning immediately)",
  );
  return {
    mode: "apply",
    status: "enqueued",
    job_id: bigintToNumber(rowId),
    target_version: PENDING_TARGET_VERSION,
  };
}

// Best-effort terminal-fail write (WHERE-guarded still-in-progress) — the
// enqueue-failure path uses it so a failed enqueue never leaves a phantom-active row.
async function markJobFailed(
  prisma: ReturnType<typeof getPrisma>,
  id: bigint,
  reason: string,
  log: FastifyRequest["log"],
): Promise<void> {
  try {
    await prisma.updateJob.updateMany({
      where: { id, status: "in_progress" },
      data: { status: "failed", failureReason: reason },
    });
  } catch (error) {
    log.warn({ err: error, jobId: id.toString() }, "update_job fail-mark best-effort failed");
  }
}

// GET /api/dashboard/update-job — poll the latest job row for the UI progress
// indicator. `none` when no job has ever run.
async function handleUpdateJob(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<UpdateJobStatusResponse | DashboardErrorBody> {
  const prisma = getPrisma();
  try {
    const row = await prisma.updateJob.findFirst({ orderBy: { id: "desc" } });
    if (row === null) {
      return { status: "none" };
    }
    return {
      status: mapJobStatus(row.status),
      id: bigintToNumber(row.id),
      target_version: row.targetVersion,
      started_at: row.startedAt.toISOString(),
      heartbeat_at: row.heartbeatAt.toISOString(),
      failure_reason: row.failureReason,
    };
  } catch (error) {
    return failWithDb(request, reply, "/api/dashboard/update-job", error);
  }
}

// Prisma client-level enum member ('in_progress') → the DB/API hyphenated literal
// the response union carries ('in-progress').
function mapJobStatus(status: "in_progress" | "failed" | "completed"): UpdateJobStatusValue {
  return status === "in_progress" ? "in-progress" : status;
}

// update.sh + launchctl invocation (fixed home-dir paths, env-seamed)

// Live install root — ATRIUM_ROOT env override (mirrors update-status.ts /
// compute-arch-drift.ts) → ~/.glass-atrium. Never request-derived.
function resolveAtriumRoot(): string {
  const override = process.env.ATRIUM_ROOT;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return path.join(homedir(), ".glass-atrium");
}

// scripts/update.sh — the P3-T2 headless entry point. ATRIUM_UPDATE_SCRIPT is a
// server-startup test seam (process-env, never request-derived), mirroring
// improvement.ts resolveRestoreScript.
function resolveUpdateScript(): string {
  const override = process.env.ATRIUM_UPDATE_SCRIPT;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return path.join(resolveAtriumRoot(), "scripts", "update.sh");
}

function resolveLaunchctlBin(): string {
  const override = process.env.ATRIUM_UPDATE_LAUNCHCTL;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return "launchctl";
}

// Fixed decoupled one-shot plist path — mirrors update.sh update_oneshot_plist_path
// (same ATRIUM_UPDATE_ONESHOT_PLIST seam so route + updater agree on one location).
function resolveOneshotPlistPath(): string {
  const override = process.env.ATRIUM_UPDATE_ONESHOT_PLIST;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return path.join(resolveAtriumRoot(), "rendered", "launchd", "com.glass-atrium.update-oneshot.plist");
}

/**
 * Enqueue the decoupled one-shot launchd job. (1) render the base plist via update.sh
 * --render-oneshot (guarantees the plist file + config-derived HOME/PATH exist —
 * chicken-and-egg on first enqueue). (2) write the server-derived job id into the plist
 * env so the job ADOPTS the reserved row (never INSERTs a 2nd single-active row → exit
 * 8). (3) bootout-then-bootstrap so a one-shot that already ran re-enqueues cleanly. Any
 * failure throws → the caller marks the row failed + returns 500 enqueue_failed.
 *
 * execFile (argv array, no shell) with a fixed script path — not a shell-injection
 * surface.
 */
async function enqueueDecoupledJob(jobId: number): Promise<void> {
  const render = await execFileAsync(resolveUpdateScript(), ["--render-oneshot"], {
    timeout: ENQUEUE_TIMEOUT_MS,
    maxBuffer: ENQUEUE_MAX_BUFFER,
  });
  const rendered = asString(render.stdout).trim();
  const plistPath = rendered.length > 0 ? rendered : resolveOneshotPlistPath();
  await setPlistJobId(plistPath, jobId);

  const launchctl = resolveLaunchctlBin();
  const domain = `gui/${process.getuid?.() ?? 0}`;
  // A one-shot (RunAtLoad, no KeepAlive) may linger loaded after it exits; bootout
  // first so the re-bootstrap is not rejected as already-loaded. Best-effort.
  try {
    await execFileAsync(launchctl, ["bootout", domain, plistPath], { timeout: ENQUEUE_TIMEOUT_MS });
  } catch {
    // Not loaded / never bootstrapped — the bootstrap below is the authoritative step.
  }
  await execFileAsync(launchctl, ["bootstrap", domain, plistPath], { timeout: ENQUEUE_TIMEOUT_MS });
}

// Inject/replace one <key>/<string> entry in the plist's EnvironmentVariables
// dict. key/value are server-derived constants (env-var names, digits, "yes") —
// regex- and XML-safe by construction, never request-derived. Throws unless the
// patched content carries the EXACT new value: a mere key-exists check would let
// a failed replace ship a stale prior value into the decoupled job.
function setPlistEnvValue(raw: string, key: string, value: string): string {
  const entryRe = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
  const patched = entryRe.test(raw)
    ? raw.replace(entryRe, `$1${value}$2`)
    : raw.replace(
        /(<key>EnvironmentVariables<\/key>\s*<dict>)/,
        `$1\n\t\t<key>${key}</key>\n\t\t<string>${value}</string>`,
      );
  const verifyRe = new RegExp(`<key>${key}</key>\\s*<string>${value}</string>`);
  if (!verifyRe.test(patched)) {
    throw new Error(
      `plist env injection failed for ${key} (EnvironmentVariables dict missing or replace did not apply)`,
    );
  }
  return patched;
}

// Write ATRIUM_UPDATE_JOB_ID into the plist env so the decoupled update.sh
// --headless adopts the route-created row. Atomic temp+rename.
async function setPlistJobId(plistPath: string, jobId: number): Promise<void> {
  const raw = await readFile(plistPath, "utf8");
  let patched: string;
  try {
    patched = setPlistEnvValue(raw, "ATRIUM_UPDATE_JOB_ID", String(jobId));
  } catch (error) {
    throw new Error(`could not write the job id into plist: ${plistPath}`, { cause: error });
  }
  await mkdir(path.dirname(plistPath), { recursive: true });
  const tmp = `${plistPath}.ga-job-id.${process.pid}`;
  await writeFile(tmp, patched, "utf8");
  await rename(tmp, plistPath);
}

// Resolve the `claude` binary for the decoupled job env. ATRIUM_UPDATE_CLAUDE_BIN
// (server-env / test seam) is AUTHORITATIVE when set: it resolves iff executable
// (no silent fallback — the test injects an unresolvable path to exercise the loud
// fail). Unset → the production chain (PATH → common install dirs), mirroring
// update.sh update_resolve_claude. Returns the path or null (→ claude_unresolved).
async function resolveClaudeBin(): Promise<string | null> {
  const override = process.env.ATRIUM_UPDATE_CLAUDE_BIN;
  if (typeof override === "string" && override.length > 0) {
    return (await isExecutable(override)) ? override : null;
  }
  const candidates: string[] = [];
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (dir.length > 0) {
      candidates.push(path.join(dir, "claude"));
    }
  }
  candidates.push("/opt/homebrew/bin/claude", "/usr/local/bin/claude");
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// execFile output normalization (stdout/stderr — like improvement.ts / agents.ts,
// minus the exit-code field this update path never branches on)

function parseExecErr(error: unknown): { stdout: string; stderr: string } {
  if (typeof error !== "object" || error === null) {
    return { stdout: "", stderr: String(error) };
  }
  const record = error as Record<string, unknown>;
  const stdout = asString(record.stdout);
  let stderr = asString(record.stderr);
  if (stderr.length === 0 && typeof record.message === "string") {
    stderr = record.message;
  }
  if (typeof record.code === "string" && stderr.length === 0) {
    stderr = record.code; // spawn error string code (ENOENT)
  }
  return { stdout, stderr };
}

function asString(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Buffer) {
    return raw.toString("utf8");
  }
  return "";
}

// Single-line, length-clamped text for user-facing error bodies + logs.
function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine;
}

function resolveStaleMs(): number {
  const raw = process.env.ATRIUM_UPDATE_STALE_MS;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_STALE_MS;
}
