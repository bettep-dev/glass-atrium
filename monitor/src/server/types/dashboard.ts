// Response shapes for /api/dashboard/* endpoints. All ISO string fields are UTC
// (`Z` via Date#toISOString); each response carries a `timezone: "UTC"` literal
// so the React client knows the base for display-timezone rendering.

export interface KpiResponse {
  today_cost_usd: number;
  yesterday_cost_usd: number;
  // Yesterday cumulative cut at the current KST wall-clock time — like-for-like
  // delta basis ('어제 동시각 대비') so a morning reading never compares today's
  // partial day against yesterday's full day. Always ⊆ the full-day aggregates.
  yesterday_same_time_cost_usd: number;
  yesterday_same_time_session_count: number;
  // Legacy fail+blocked 1h merge — superseded by the 24h split below; kept one release.
  last_1h_fail_count: number;
  // 24h split: blocked is NOT a failure (info tone) — the FE labels them separately.
  fail_count_24h: number;
  blocked_count_24h: number;
  last_etl_at: string | null;
  today_session_count: number;
  yesterday_session_count: number;
  timezone: "UTC";
  // Day buckets (today/yesterday) are pinned in SQL to the configured day-bucket
  // timezone (config.toml [meta].timezone → ATRIUM_TIMEZONE, default Asia/Seoul)
  // — independent of the PG session timezone. Echoes timezone.ts DAY_BUCKET_TIMEZONE.
  day_bucket_timezone: string;
}

export interface CostTimeseriesPoint {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  session_count: number;
}

export interface CostTimeseriesResponse {
  days: number;
  points: CostTimeseriesPoint[];
  // `points[].date` is date-only → the label documents the UTC-midnight boundary.
  timezone: "UTC";
}

// Mirrors `core.DaemonStatus` Prisma enum — exhaustive union (not `string`) so
// React can compile-time pattern-match for badge color (`quota_exceeded` distinct from `error`).
export type DaemonStatusValue =
  | "ok"
  | "partial"
  | "error"
  | "missing"
  | "stale"
  | "quota_exceeded";

export interface DaemonStatusItem {
  // Active daemons + legacy "daily-restart" (historical rows only — restart runs
  // are role-qualified per restarted daemon; no new rows under the merged name).
  daemon_name:
    | "autoagent"
    | "wiki"
    | "daily-restart"
    | "daily-restart-autoagent"
    | "daily-restart-wiki";
  last_run_at: string | null;
  last_status: DaemonStatusValue | null;
  expected_next_at: string | null;
}

export interface DaemonStatusResponse {
  items: DaemonStatusItem[];
  // last_run_at / expected_next_at are UTC ISO — client renders in its display timezone.
  timezone: "UTC";
}

// Update-availability verdict (plan E2 / T05). The dashboard badge keys on this:
//  - "update-available": local installed version < latest GitHub Release version.
//  - "current": local equals-or-exceeds the latest release.
//  - "unknown": release repo unconfigured, HTTPS fetch/parse failed, or a
//    malformed version — the badge stays absent (no false signal).
//  - "source-dev": the symlinked maintainer source tree — the check is suppressed
//    by design (the badge is consumer-install-only; plan B11/Q5).
export type UpdateStatusVerdict = "update-available" | "current" | "unknown" | "source-dev";

export interface UpdateStatusResponse {
  status: UpdateStatusVerdict;
  // The locally installed Atrium system version (manifest.json `version`), or
  // "unknown" when the local manifest is unreadable.
  local_version: string;
  // The latest GitHub Release version, or null when not resolved (unconfigured /
  // unreachable / source-dev). May carry a `v` prefix when sourced from the tag.
  latest_version: string | null;
  // Human/tooltip hint for why a non-actionable verdict was returned; null on a
  // clean "update-available"/"current".
  reason: string | null;
  // ISO-8601 UTC instant the verdict was resolved (the cache timestamp).
  checked_at: string;
}

export type DashboardErrorBody =
  | { error: "internal" }
  | { error: "database_unavailable" }
  // DB-rejected client input (SQLSTATE class 22/23) — db-failure.ts taxonomy split.
  | { error: "invalid_input"; reason: string }
  | { error: "invalid_param"; param: string };

// ---------------------------------------------------------------------------
// POST /api/dashboard/update (2-step preview/commit) + GET /api/dashboard/update-job
// (P3-T3). The DB literal status values ('in-progress' carries a hyphen — see the
// core.UpdateJobStatus enum @map). String-union (not `string`) so the React client
// can compile-time pattern-match the three states for dual-encoded badges.
// ---------------------------------------------------------------------------

export type UpdateJobStatusValue = "in-progress" | "failed" | "completed";

// One changed file in the dry-run preview. `diff` is the raw unified-diff body
// update.sh --preview renders per file; `is_new` flags a first-time add (no
// current version) so the client can label it distinctly.
export interface UpdateFileDiff {
  path: string;
  diff: string;
  is_new: boolean;
}

// POST mode=preview result. `ready` reserves the single-active in-progress row +
// stores the {version + per-file hash}-bound nonce; `up_to_date` reserves nothing
// (no changed files → nothing to commit).
export type UpdatePreviewResponse =
  | {
      mode: "preview";
      status: "ready";
      // BIGSERIAL id of the reserved core.update_job row (safe-int range).
      job_id: number;
      target_version: string;
      // 64-char sha256 hex bound to {version + per-file diff hashes}. The client
      // echoes it back verbatim as the commit `confirm` token.
      nonce: string;
      files: UpdateFileDiff[];
    }
  | { mode: "preview"; status: "up_to_date"; files: [] };

// POST mode=commit result — the handler enqueues the decoupled one-shot launchd
// job and returns IMMEDIATELY (the long apply runs detached; UI polls update-job).
export interface UpdateCommitResponse {
  mode: "commit";
  status: "in-progress";
  job_id: number;
}

// GET /api/dashboard/update-job — polling shape. `none` when no job row exists.
export type UpdateJobStatusResponse =
  | { status: "none" }
  | {
      status: UpdateJobStatusValue;
      id: number;
      target_version: string;
      // UTC ISO instants (Timestamptz → Date#toISOString).
      started_at: string;
      heartbeat_at: string;
      failure_reason: string | null;
    };

// Mutation-path error taxonomy. 400 (manual-validation) mirrors the agents.ts
// invalid_body idiom; 409 covers the single-active + nonce/drift guards; 500/503
// cover the exec + precondition loud-fails. DB failures reuse db-failure.ts's
// invalid_input / database_unavailable shapes (unioned here).
export type UpdateMutationErrorBody =
  | { error: "invalid_body"; field: string; reason: string }
  | { error: "single_active"; reason: string }
  | { error: "nonce_mismatch"; reason: string }
  | { error: "drift_detected"; reason: string }
  | { error: "preview_failed"; reason: string }
  | { error: "enqueue_failed"; reason: string }
  | { error: "claude_unresolved"; reason: string }
  | { error: "invalid_input"; reason: string }
  | { error: "database_unavailable" };
