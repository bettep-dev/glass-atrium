// Response shapes for /api/wiki/* — the dedicated wiki-monitoring page (PG-only,
// zero filesystem coupling).
//
// Source split:
//   - wiki.notes        → notes_total + by_type (raw / source-summary)
//   - wiki.dirty_flag   → master-index freshness signal
//   - core.daemon_runs  → wiki cycle throughput + status mix + p95 duration
//   - core.daemon_run_payload → latest dedup/deadlink proposal explorer data
//
// Duration is derived (ended_at - started_at), NOT compile_ms: the
// daemon_runs.compile_ms column is 100% NULL for wiki rows (partial-upsert never
// writes it).

// Mirrors core.DaemonStatus enum — duplicated locally per "Module independence"
// (small util duplication > fragile cross-route import of the generated enum).
// Drift → null (forces explicit type extension).
export type WikiDaemonStatusValue =
  | "ok"
  | "partial"
  | "error"
  | "missing"
  | "stale"
  | "quota_exceeded";

// ----- GET /api/wiki/summary --------------------------------------------------

export interface WikiSummary {
  // Latest per-cycle compiled note count (daemon_runs.compiled_count of the most
  // recent wiki row). Independent from notes_total — per-cycle. null when the
  // cycle row is absent or carries no count (FE renders '—', never a fake 0).
  latest_compiled_count: number | null;
  // wiki.notes COUNT — the cumulative indexed-note total.
  notes_total: number;
  // p95 of (ended_at - started_at)*1000 over completed wiki cycles within the
  // last cycle_p95_window_days. null when no completed cycle exists in window.
  cycle_p95_ms: number | null;
  // Window backing cycle_p95_ms — matches the /cycles ?days default.
  cycle_p95_window_days: number;
  // Status of the most recent wiki cycle (narrowed enum; null when no rows).
  last_status: WikiDaemonStatusValue | null;
  // Whole days between MAX(run_date) and CURRENT_DATE. null when no rows.
  // Day-granularity legacy — hours_since_last_cycle is the hour-precision source.
  days_since_last_cycle: number | null;
  // ISO of the most recent cycle's run_date (UTC midnight slice). null when none.
  last_run_date: string | null;
  // MAX(started_at) of wiki cycles as a true UTC instant. null when no rows.
  last_cycle_started_at: string | null;
  // Whole hours elapsed since last_cycle_started_at (floor). null when no rows.
  hours_since_last_cycle: number | null;
  timezone: "UTC";
}

// ----- GET /api/wiki/cycles ---------------------------------------------------

export interface WikiCycle {
  run_date: string;
  status: WikiDaemonStatusValue | null;
  compiled_count: number | null;
  deadlinks_count: number | null;
  dedup_count: number | null;
  started_at: string | null;
  ended_at: string | null;
  // Derived (ended_at - started_at)*1000; null when ended_at is null.
  duration_ms: number | null;
}

export interface WikiCyclesResponse {
  days: number;
  cycles: WikiCycle[];
  // `cycles[].started_at` / `ended_at` are UTC ISO; `run_date` is a UTC-midnight
  // date-only slice of the PG DATE column.
  timezone: "UTC";
}

// ----- GET /api/wiki/index-metrics --------------------------------------------

export interface WikiNoteTypeBucket {
  note_type: string;
  count: number;
}

export interface WikiIndexMetrics {
  // wiki.notes GROUP BY note_type.
  by_type: WikiNoteTypeBucket[];
  // wiki.notes COUNT. An INDEPENDENT count from latest_compiled_total — NOT a
  // ratio/drift (the gap is expected).
  notes_total: number;
  // Latest per-cycle compiled_total (daemon_runs). Independent count. null when
  // the cycle row is absent or carries no count (FE renders '—', never a fake 0).
  latest_compiled_total: number | null;
  // wiki.dirty_flag.dirty — master-index regeneration pending signal.
  dirty: boolean;
  // wiki.dirty_flag.last_dirty normalized to epoch MILLISECONDS at the route
  // boundary (daemon writes seconds). null only when the row is absent.
  last_dirty_ms: number | null;
  timezone: "UTC";
}

// ----- GET /api/wiki/backlog --------------------------------------------------

// The latest wiki payload's management-backlog slice. The named fields surface
// the explicit shapes the FE renders directly.
//
// JSONB shapes:
//   dedup_proposals  = object { errors:[], proposals:[], ... }
//   deadlink_dryrun  = array
//   deadlink_fixes   = array
//   raw_processed    = number
export interface WikiBacklog {
  // run_date of the latest payload row (date-only slice). null when no payload.
  run_date: string | null;
  // Verbatim pass-through of the dedup_proposals object (errors + proposals + ...).
  // `unknown` — schema varies by cycle; the FE explorer renders it generically.
  dedup_proposals: unknown;
  // Verbatim pass-through of the deadlink_dryrun array.
  deadlink_dryrun: unknown;
  // Verbatim pass-through of the deadlink_fixes array.
  deadlink_fixes: unknown;
  // raw_processed scalar (number when present, null otherwise).
  raw_processed: number | null;
  // Daemon-published TRUE hybrid unprocessed-raw count (detect_unprocessed_raw).
  // Authoritative SoT — the FE must read this, not recompute rawCount − summaryCount.
  // null when the payload lacks the key (e.g. before the daemon pushes it). 0 is valid.
  true_backlog: number | null;
  timezone: "UTC";
}

export interface WikiBacklogResponse {
  backlog: WikiBacklog | null;
  timezone: "UTC";
}

// ----- shared error body (mirrors HealthDetailErrorBody) ----------------------

export type WikiErrorBody =
  | { error: "internal" }
  | { error: "database_unavailable" }
  // DB-rejected client input (SQLSTATE class 22/23) — db-failure.ts taxonomy split.
  | { error: "invalid_input"; reason: string }
  | { error: "invalid_param"; param: string };
