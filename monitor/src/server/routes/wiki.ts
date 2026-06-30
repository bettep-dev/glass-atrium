// Wiki monitoring API — read-only endpoints for the dedicated "위키" page.
// PG-only by design (zero filesystem coupling = relocation-immune) → every source is a PG table (wiki.notes / wiki.dirty_flag / core.daemon_runs / core.daemon_run_payload).
// Duration is derived (ended_at - started_at), not compile_ms — compile_ms is 100% NULL for wiki rows.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { Prisma } from "../../generated/prisma/client.js";
import { getPrisma } from "../db.js";
import { respondDbFailure } from "../db-failure.js";
import type {
  WikiBacklog,
  WikiBacklogResponse,
  WikiCycle,
  WikiCyclesResponse,
  WikiDaemonStatusValue,
  WikiErrorBody,
  WikiIndexMetrics,
  WikiNoteTypeBucket,
  WikiSummary,
} from "../types/wiki.js";

// Fixed allowlist — blocks arbitrary INTERVAL injection through the ?days param (mirrors health-detail.ts ALLOWED_WIKI_DAYS).
const ALLOWED_WIKI_DAYS: ReadonlySet<number> = new Set([7, 14, 30, 90]);
const DEFAULT_WIKI_DAYS = 30;

// Local copy of the core.DaemonStatus enum (nodejs-dev "Module independence") · enum drift surfaces as null (forces explicit extension).
const KNOWN_DAEMON_STATUSES: ReadonlySet<WikiDaemonStatusValue> = new Set([
  "ok",
  "partial",
  "error",
  "missing",
  "stale",
  "quota_exceeded",
]);

export async function registerWikiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/wiki/summary", handleSummary);
  app.get("/api/wiki/cycles", handleCycles);
  app.get("/api/wiki/index-metrics", handleIndexMetrics);
  app.get("/api/wiki/backlog", handleBacklog);
}

// /api/wiki/summary

interface SummaryRow {
  latest_compiled_count: number | null;
  notes_total: bigint;
  cycle_p95_ms: number | null;
  last_status: string | null;
  last_run_date: Date | null;
  days_since_last_cycle: number | null;
  last_cycle_started_at: Date | null;
}

// p95 window — pinned to the /cycles default so both surfaces describe the same span.
const CYCLE_P95_WINDOW_DAYS = DEFAULT_WIKI_DAYS;

async function handleSummary(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<WikiSummary | WikiErrorBody> {
  const start = Date.now();
  const prisma = getPrisma();
  try {
    // Single round-trip — core.daemon_runs aggregates (p95 / last-row status / freshness) + a wiki.notes COUNT scalar subquery.
    // PERCENTILE_CONT runs only over completed cycles (ended_at IS NOT NULL) · 0-row → NULL p95 + NULL last → graceful zeros below.
    const rows = await prisma.$queryRaw<SummaryRow[]>`
      SELECT
        (
          SELECT compiled_count
          FROM core.daemon_runs
          WHERE daemon_name = 'wiki'
          ORDER BY run_date DESC
          LIMIT 1
        ) AS latest_compiled_count,
        (SELECT COUNT(*)::bigint FROM wiki.notes) AS notes_total,
        (
          SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000
          )
          FROM core.daemon_runs
          WHERE daemon_name = 'wiki' AND ended_at IS NOT NULL
            AND run_date >= CURRENT_DATE - ${Prisma.raw(`INTERVAL '${CYCLE_P95_WINDOW_DAYS - 1} days'`)}
        ) AS cycle_p95_ms,
        (
          SELECT status::text
          FROM core.daemon_runs
          WHERE daemon_name = 'wiki'
          ORDER BY run_date DESC
          LIMIT 1
        ) AS last_status,
        (
          SELECT MAX(run_date)
          FROM core.daemon_runs
          WHERE daemon_name = 'wiki'
        ) AS last_run_date,
        (
          SELECT (CURRENT_DATE - MAX(run_date))::int
          FROM core.daemon_runs
          WHERE daemon_name = 'wiki'
        ) AS days_since_last_cycle,
        (
          SELECT MAX(started_at)
          FROM core.daemon_runs
          WHERE daemon_name = 'wiki'
        ) AS last_cycle_started_at
    `;

    const row = rows[0];
    const lastStartedAt = row?.last_cycle_started_at ?? null;
    const summary: WikiSummary = {
      latest_compiled_count: row?.latest_compiled_count ?? null,
      notes_total: row === undefined ? 0 : bigintToNumber(row.notes_total),
      // p95 arrives as a JS number from PG double precision; round to ms integer.
      cycle_p95_ms:
        row?.cycle_p95_ms === null || row?.cycle_p95_ms === undefined
          ? null
          : Math.round(row.cycle_p95_ms),
      cycle_p95_window_days: CYCLE_P95_WINDOW_DAYS,
      last_status: narrowDaemonStatus(row?.last_status ?? null),
      days_since_last_cycle: row?.days_since_last_cycle ?? null,
      last_run_date:
        row?.last_run_date === null || row?.last_run_date === undefined
          ? null
          : formatDateOnly(row.last_run_date),
      last_cycle_started_at: lastStartedAt === null ? null : lastStartedAt.toISOString(),
      hours_since_last_cycle:
        lastStartedAt === null
          ? null
          : Math.max(0, Math.floor((Date.now() - lastStartedAt.getTime()) / 3_600_000)),
      timezone: "UTC",
    };

    request.log.info(
      {
        route: "/api/wiki/summary",
        notesTotal: summary.notes_total,
        durationMs: Date.now() - start,
      },
      "wiki query complete",
    );
    return summary;
  } catch (error) {
    return failWithDb(request, reply, "/api/wiki/summary", error);
  }
}

// /api/wiki/cycles

interface CycleRow {
  run_date: Date;
  status: string;
  compiled_count: number | null;
  deadlinks_count: number | null;
  dedup_count: number | null;
  started_at: Date | null;
  ended_at: Date | null;
  duration_ms: number | null;
}

async function handleCycles(
  request: FastifyRequest<{ Querystring: { days?: string } }>,
  reply: FastifyReply,
): Promise<WikiCyclesResponse | WikiErrorBody> {
  const start = Date.now();
  const days = parseDaysParam(request.query.days, DEFAULT_WIKI_DAYS, ALLOWED_WIKI_DAYS);
  if (days === null) {
    return reply.code(400).send(invalidParam("days"));
  }
  const prisma = getPrisma();
  try {
    // `days - 1` so days=30 yields a 30-day window inclusive of today.
    // Prisma.raw INTERVAL is safe (days validated against the allowlist) · duration_ms derived in SQL (compile_ms is 100% NULL for wiki).
    const intervalLiteral = Prisma.raw(`INTERVAL '${days - 1} days'`);
    const rows = await prisma.$queryRaw<CycleRow[]>`
      SELECT
        run_date,
        status::text AS status,
        compiled_count,
        deadlinks_count,
        dedup_count,
        started_at,
        ended_at,
        CASE
          WHEN ended_at IS NULL THEN NULL
          ELSE ROUND(EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000)::int
        END AS duration_ms
      FROM core.daemon_runs
      WHERE daemon_name = 'wiki'
        AND run_date >= CURRENT_DATE - ${intervalLiteral}
      ORDER BY run_date DESC
    `;

    const cycles: WikiCycle[] = rows.map((r) => ({
      run_date: formatDateOnly(r.run_date),
      status: narrowDaemonStatus(r.status),
      compiled_count: r.compiled_count,
      deadlinks_count: r.deadlinks_count,
      dedup_count: r.dedup_count,
      started_at: r.started_at === null ? null : r.started_at.toISOString(),
      ended_at: r.ended_at === null ? null : r.ended_at.toISOString(),
      duration_ms: r.duration_ms,
    }));

    request.log.info(
      {
        route: "/api/wiki/cycles",
        days,
        rowCount: cycles.length,
        durationMs: Date.now() - start,
      },
      "wiki query complete",
    );
    return { days, cycles, timezone: "UTC" };
  } catch (error) {
    return failWithDb(request, reply, "/api/wiki/cycles", error);
  }
}

// /api/wiki/index-metrics

interface NoteTypeRow {
  note_type: string;
  count: bigint;
}

interface DirtyFlagRow {
  dirty: boolean;
  last_dirty: bigint;
}

interface CompiledTotalRow {
  compiled_total: number | null;
}

async function handleIndexMetrics(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<WikiIndexMetrics | WikiErrorBody> {
  const start = Date.now();
  const prisma = getPrisma();
  try {
    // 3 independent reads — note_type breakdown · dirty-flag freshness · latest per-cycle compiled_total.
    // notes_total derived from the by_type sum (single source) → the two can never disagree.
    const [byTypeRows, dirtyRows, compiledRows] = await Promise.all([
      prisma.$queryRaw<NoteTypeRow[]>`
        SELECT note_type, COUNT(*)::bigint AS count
        FROM wiki.notes
        GROUP BY note_type
        ORDER BY note_type
      `,
      prisma.$queryRaw<DirtyFlagRow[]>`
        SELECT dirty, last_dirty
        FROM wiki.dirty_flag
        LIMIT 1
      `,
      // Latest per-cycle compiled_total — independent count from notes_total.
      prisma.$queryRaw<CompiledTotalRow[]>`
        SELECT compiled_total
        FROM core.daemon_runs
        WHERE daemon_name = 'wiki'
        ORDER BY run_date DESC
        LIMIT 1
      `,
    ]);

    const byType: WikiNoteTypeBucket[] = byTypeRows.map((r) => ({
      note_type: r.note_type,
      count: bigintToNumber(r.count),
    }));
    const notesTotal = byType.reduce((sum, b) => sum + b.count, 0);

    const dirtyRow = dirtyRows[0];
    const compiledRow = compiledRows[0];

    const metrics: WikiIndexMetrics = {
      by_type: byType,
      notes_total: notesTotal,
      latest_compiled_total: compiledRow?.compiled_total ?? null,
      dirty: dirtyRow?.dirty ?? false,
      // bigintToNumber guards a future epoch overflow before Number()/Date use.
      last_dirty_ms:
        dirtyRow === undefined ? null : normalizeEpochToMs(bigintToNumber(dirtyRow.last_dirty)),
      timezone: "UTC",
    };

    request.log.info(
      {
        route: "/api/wiki/index-metrics",
        notesTotal,
        durationMs: Date.now() - start,
      },
      "wiki query complete",
    );
    return metrics;
  } catch (error) {
    return failWithDb(request, reply, "/api/wiki/index-metrics", error);
  }
}

// /api/wiki/backlog

interface BacklogRow {
  run_date: Date;
  payload: unknown;
}

async function handleBacklog(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<WikiBacklogResponse | WikiErrorBody> {
  const start = Date.now();
  const prisma = getPrisma();
  try {
    // DIRECT read of the latest wiki payload row — do NOT join to the latest daemon_run.
    // Payload lags the run row by ~1 cycle → a join would miss the most-recent payload.
    const rows = await prisma.$queryRaw<BacklogRow[]>`
      SELECT run_date, payload
      FROM core.daemon_run_payload
      WHERE daemon_name = 'wiki'
      ORDER BY run_date DESC
      LIMIT 1
    `;

    const row = rows[0];
    const backlog: WikiBacklog | null =
      row === undefined ? null : extractBacklog(row.run_date, row.payload);

    request.log.info(
      {
        route: "/api/wiki/backlog",
        hasPayload: backlog !== null,
        durationMs: Date.now() - start,
      },
      "wiki query complete",
    );
    return { backlog, timezone: "UTC" };
  } catch (error) {
    return failWithDb(request, reply, "/api/wiki/backlog", error);
  }
}

// Pull the FE-relevant slices out of the JSONB payload · the payload shape varies by cycle.
// Absent keys degrade to null/undefined rather than throwing · raw_processed is defensively coerced to number | null.
// Exported as a pure helper for direct import in unit tests (mirrors the route module's export convention).
export function extractBacklog(runDate: Date, payload: unknown): WikiBacklog {
  const obj = payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const rawProcessed = obj.raw_processed;
  const trueBacklog = obj.true_backlog;
  return {
    run_date: formatDateOnly(runDate),
    dedup_proposals: obj.dedup_proposals ?? null,
    deadlink_dryrun: obj.deadlink_dryrun ?? null,
    deadlink_fixes: obj.deadlink_fixes ?? null,
    raw_processed:
      typeof rawProcessed === "number" && Number.isFinite(rawProcessed) ? rawProcessed : null,
    // Daemon-published authoritative backlog count (detect_unprocessed_raw) · do NOT recompute rawCount − summaryCount.
    // A negative value is contractually meaningless · mirrors the FE selectBacklogW (>= 0) guard → degrade to null.
    true_backlog:
      typeof trueBacklog === "number" && Number.isFinite(trueBacklog) && trueBacklog >= 0
        ? trueBacklog
        : null,
    timezone: "UTC",
  };
}

// The wiki daemon writes dirty_flag.last_dirty in epoch SECONDS while the API
// field is *_ms — normalize at the route boundary. Epoch seconds stay < 1e12
// until year 33658; epoch ms crossed 1e12 in 2001, so the threshold is unambiguous.
// Exported for direct unit testing (mirrors extractBacklog).
export function normalizeEpochToMs(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}

// shared helpers (mirror health-detail.ts)

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

function bigintToNumber(value: bigint): number {
  // Current-scale PG bigint values fit in safe-int range · guard future scale with a clear error instead of silent truncation.
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`bigint ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

// PG status::text → WikiDaemonStatusValue union · unknown values (future enum additions) fall back to null (forces explicit type extension, blocks union violation).
function narrowDaemonStatus(raw: string | null): WikiDaemonStatusValue | null {
  if (raw === null) {
    return null;
  }
  return KNOWN_DAEMON_STATUSES.has(raw as WikiDaemonStatusValue)
    ? (raw as WikiDaemonStatusValue)
    : null;
}

function formatDateOnly(date: Date): string {
  // PG DATE arrives as midnight UTC; toISOString preserves Y-M-D.
  return date.toISOString().slice(0, 10);
}

function failWithDb(
  request: FastifyRequest,
  reply: FastifyReply,
  route: string,
  error: unknown,
): WikiErrorBody {
  return respondDbFailure(request, reply, route, error, "wiki query failed");
}

function invalidParam(param: string): WikiErrorBody {
  return { error: "invalid_param", param };
}
