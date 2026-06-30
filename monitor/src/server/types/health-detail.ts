// Response shapes for /api/health/* detail endpoints (daemon cards / hook chain
// tree / wiki daily reports). Named "health-detail" because /api/health is a
// separate liveness probe with a different shape — the module mirrors the route filename.

// Mirrors dashboard.ts DaemonStatusValue — duplicated locally per "Module
// independence" (small util duplication > fragile cross-route imports).
export type DaemonStatusValue =
  | "ok"
  | "partial"
  | "error"
  | "missing"
  | "stale"
  | "quota_exceeded";

// Mirrors prisma CostGuardState enum — duplicated locally per "Module independence".
// infra_fault = 401/credential auth failure (NOT a spend/usage signal).
export type CostGuardStateValue = "ok" | "warn" | "block" | "infra_fault";

export interface DaemonStatusCard {
  daemon_name: string;
  last_run_at: string | null;
  last_status: DaemonStatusValue | null;
  expected_next_at: string | null;
  cost_guard_state: CostGuardStateValue | null;
  staleness_minutes: number | null;
  is_stale: boolean;
}

export interface HealthDaemonsResponse {
  daemons: DaemonStatusCard[];
  computed_at: string;
  // All ISO time fields are UTC — client renders in its display timezone.
  timezone: "UTC";
}

export interface WikiReport {
  run_date: string;
  status: string;
  deadlinks_count: number | null;
  dedup_count: number | null;
  compiled_count: number | null;
  compiled_total: number | null;
  compile_ms: number | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface HealthWikiReportsResponse {
  days: number;
  reports: WikiReport[];
  // started_at / ended_at are UTC ISO; run_date is a date-only UTC-midnight slice of PG DATE.
  timezone: "UTC";
}

export interface HookEntry {
  command: string;
  type: string | null;
  timeout: number | null;
}

export interface HookMatcherGroup {
  matcher: string;
  hooks: HookEntry[];
}

export interface HookChainEvent {
  event: string;
  groups: HookMatcherGroup[];
}

export interface HealthHookChainResponse {
  events: HookChainEvent[];
  source_path: string;
  source_mtime: string;
  // source_mtime is UTC ISO (settings.json mtimeMs → Date → toISOString).
  timezone: "UTC";
}

// Per-run JSONB payload drill-down (daemon-status exposes only the flat status).
export interface DaemonPayloadEntry {
  run_date: string;
  daemon_name: string;
  // payload JSONB — schema varies by daemon (autoagent: patches/cost_guard/...,
  // wiki: compilations/deadlink_*/...). Passed through verbatim for FE drill-down.
  payload: unknown;
  payload_size_bytes: number;
}

export interface HealthDaemonPayloadResponse {
  daemon: string;
  entries: DaemonPayloadEntry[];
  // entries[].run_date is a UTC-midnight date-only slice of the PG DATE.
  timezone: "UTC";
}

// Raw core.hook_failures rows (architecture/live exposes only a 24h COUNT aggregate).

// Mirrors PG core.hook_failures.error_kind enum — duplicated locally per "Module
// independence" (avoids cross-route import of the generated enum).
export type HookErrorKindValue =
  | "connection_refused"
  | "timeout"
  | "constraint_violation"
  | "unknown"
  | "identifier_rejected";

export interface HookFailureEntry {
  id: number;
  failure_ts: string;
  hook_name: string;
  target_table: string;
  error_kind: HookErrorKindValue;
  payload_ref: string | null;
  retry_attempted: boolean;
}

export interface HealthHookFailuresResponse {
  days: number;
  failures: HookFailureEntry[];
  // Fixed-24h recency aggregates (days-param independent — `failures` is windowed
  // + LIMIT-truncated, so the FE cannot derive these from the row list).
  // Hook Chain tone source: warn = count_24h > 0 · crit = unretried_count_24h > 0.
  count_24h: number;
  unretried_count_24h: number;
  // failures[].failure_ts is UTC ISO (PG Timestamptz → Date → toISOString).
  timezone: "UTC";
}

export type HealthDetailErrorBody =
  | { error: "internal" }
  | { error: "database_unavailable" }
  // DB-rejected client input (SQLSTATE class 22/23) — db-failure.ts taxonomy split.
  | { error: "invalid_input"; reason: string }
  | { error: "invalid_param"; param: string };
