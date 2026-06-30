// Dashboard API: 4 read-only endpoints feeding the dashboard panels.
// All queries via Prisma 7 driver-adapter; raw SQL only via $queryRaw template-tag
// (parameter interpolation handled by Prisma; SQL injection impossible).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPrisma } from "../db.js";
import { respondDbFailure } from "../db-failure.js";
import { DAY_BUCKET_TIMEZONE } from "../timezone.js";
import { nextOccurrenceUtc, DAEMON_CRON_SCHEDULE } from "../schedule-next-fire.js";
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

interface DaemonRow {
  daemon_name: string;
  last_run_at: Date | null;
  last_status: string | null;
}

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/dashboard/kpi", handleKpi);
  app.get("/api/dashboard/cost-timeseries", handleCostTimeseries);
  app.get("/api/dashboard/daemon-status", handleDaemonStatus);
  app.get("/api/dashboard/update-status", handleUpdateStatus);
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
    // generate_series fills gap days with zero rows (LEFT JOIN). Interval embedded
    // via Prisma.raw is safe here because `days` was validated against allowlist.
    const windowLowerBound = buildWindowLowerBound(days);
    const rows = await prisma.$queryRaw<TimeseriesRow[]>`
      SELECT
        d::date AS date,
        COALESCE(SUM(c.input_tokens), 0)::bigint AS input_tokens,
        COALESCE(SUM(c.output_tokens), 0)::bigint AS output_tokens,
        COALESCE(SUM(c.cache_read_tokens), 0)::bigint AS cache_read_tokens,
        COALESCE(SUM(c.cache_creation_tokens), 0)::bigint AS cache_creation_tokens,
        COALESCE(SUM(c.cost_usd), 0)::numeric(12,6) AS cost_usd,
        COUNT(DISTINCT c.session_id)::bigint AS session_count
      FROM generate_series(${windowLowerBound}, CURRENT_DATE, '1 day') d
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
    // DISTINCT ON yields the latest row per daemon by started_at desc — index-friendly
    // (matches @@index([daemonName, runDate(sort: Desc)]) in schema).
    // WHERE clause aligns with DAEMON_BOARD.
    const rows = await prisma.$queryRaw<DaemonRow[]>`
      SELECT DISTINCT ON (daemon_name)
        daemon_name::text AS daemon_name,
        started_at AS last_run_at,
        status::text AS last_status
      FROM core.daemon_runs
      WHERE daemon_name IN ('autoagent', 'wiki', 'daily-restart-autoagent', 'daily-restart-wiki')
      ORDER BY daemon_name, started_at DESC
    `;
    const byName = new Map<string, DaemonRow>();
    for (const row of rows) {
      byName.set(row.daemon_name, row);
    }

    const now = new Date();
    const items: DaemonStatusItem[] = DAEMON_BOARD.map((name) => {
      const row = byName.get(name);
      const lastRunAt = row?.last_run_at ?? null;
      return {
        daemon_name: name,
        last_run_at: lastRunAt === null ? null : lastRunAt.toISOString(),
        // Narrow PG `status::text` (string | null) → DaemonStatusValue union.
        // Unknown enum values defensively coerce to null rather than leaking raw text.
        last_status: narrowDaemonStatus(row?.last_status ?? null),
        expected_next_at: nextOccurrenceUtc(DAEMON_CRON_SCHEDULE[name], DAY_BUCKET_TIMEZONE, now),
      };
    });

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

// ----- helpers ---------------------------------------------------------------

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

// Canonical "last N days" window lower bound — mirrors cost.ts buildWindowLowerBound.
// Window = [CURRENT_DATE - (days-1) .. CURRENT_DATE] inclusive = exactly `days`
// calendar days (today counted), so every "last N days" card covers the same day-set.
// Safe: `days` allowlist-validated ({7, 30, 90}); `days - 1` is a derived integer.
function buildWindowLowerBound(days: number): Prisma.Sql {
  return Prisma.raw(`CURRENT_DATE - INTERVAL '${days - 1} days'`);
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
