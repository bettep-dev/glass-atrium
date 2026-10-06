#!/usr/bin/env python3
# _pg_dual_write_daemon.py — Shared PG dual-write helper for the wiki and
# autoagent cycles. Sister of ~/.claude/hooks/_pg_dual_write.py.
#
# Envelope = daemon-table-aware operations (op-routed):
#       - write_wiki_note            -> wiki.notes UPSERT keyed by path
#       - bump_wiki_dirty            -> wiki.dirty_flag id=1 UPDATE
#       - write_daemon_run           -> core.daemon_runs UPSERT (run_date, daemon_name)
#       - write_daemon_run_payload   -> core.daemon_run_payload UPSERT (FK 1:1)
#       - write_autoagent_proposal   -> core.autoagent_proposals UPSERT
#                                       key (cycle_date, pattern_label, target_file)
#       - write_autoagent_loop_event -> core.autoagent_loop_events UPSERT
#                                       key (event_ts, agent, eval_result) for a census
#                                       row, (event_ts, agent, subject) for a verdict row
#       - write_autoagent_corpus_audit -> core.autoagent_corpus_audits UPSERT
#                                       key (cycle_date)
#       - write_spawn_manifest_rows  -> core.spawn_manifest INSERT ... DO NOTHING
#                                       key (spool, line_offset); import-only, no op
#       - write_trial_ledger_row     -> core.autoagent_trial_ledger INSERT ... DO NOTHING
#                                       key (dedupe_key); import-only, no op
#
# Retry/error/elapsed_ms convention:
#   * 1 retry with 100ms backoff before giving up (fail-loud-and-skip).
#   * On final failure: stderr-log structured JSON + best-effort
#     core.hook_failures INSERT (errors swallowed — never recurse).
#   * Unix-socket only via psycopg.connect("dbname=glass_atrium").
#     NEVER -h, -p, host=, 127.0.0.1, localhost.
#
# CLI exit-code semantics (named codes — a caller MUST be able to tell a
# committed write from a swallowed failure; callers that must not block on PG
# absorb these with `|| <fallback>`):
#   0 = committed (stdout elapsed_ms token + stderr pg_write=ok)
#   2 = envelope parse failure (stdin was not a valid single-line JSON envelope)
#   3 = unknown op (not in OP_TABLE)
#   4 = PG write failure after the retry (structured JSON + pg_write=fail stderr)
#   5 = psycopg absent, CLI mode only (import mode re-raises ImportError instead)
#   6 = caller contract violation — an unsupported apply_status token, a
#       loop-event cause whose class disagrees with its subject (verdict cause
#       without one, census cause with one), or a loop-event subject wider than
#       the column that keys the verdict arm. Refused BEFORE connecting, so
#       nothing was written and no retry runs; a silent fall-through would report
#       apply health the cycle never recorded, or file an adjudication under the
#       recurrence census.
#
# CLI contract (single-line JSON envelope on stdin):
#   {"op": "write_wiki_note",            "args": {"path": "...", "title": "...", ...}}
#   {"op": "bump_wiki_dirty",            "args": {}}
#   {"op": "write_daemon_run",           "args": {"daemon_name": "wiki", "run_date": "...", ...}}
#   {"op": "compose_daemon_run_apply_status",
#                                        "args": {"daemon_name": "autoagent", "run_date": "...", "apply_status": "ok|apply_failed|apply_unavailable"}}
#   {"op": "write_daemon_run_payload",   "args": {"daemon_name": "wiki", "run_date": "...", "payload": {...}}}
#   {"op": "write_autoagent_proposal",   "args": {"cycle_date": "...", "pattern_label": "...", "target_file": "...", ...}}
#   {"op": "write_autoagent_loop_event", "args": {"event_ts": "...", "agent": "...", "eval_result": "...", ...}}
#   {"op": "write_autoagent_corpus_audit", "args": {"cycle_date": "...", "word_count": 0, "token_estimate": 0, ...}}
#
# Stdout on success: elapsed_ms (single integer line). compose_daemon_run_apply_status
#   appends ONE trailer line — "provenance=composed:<token>" or "provenance=declined:<prior
#   status>" — because the driver reads stdout while the scheduled path drops stderr. Line 1
#   stays a bare integer: every caller parses it positionally. On a DB predating the
#   provenance migration the op DEGRADES: the status still composes, no trailer is written,
#   and the missing migration is named on stderr (exit stays 0 — see the docstring).
# Stderr (always): structured op + elapsed_ms log line (parseable by daemon-reports).

import json
import sys
import time
from dataclasses import dataclass
from types import SimpleNamespace

# psycopg-absent must surface to an IMPORTER as a CATCHABLE ImportError so its
# `except Exception` degrades gracefully — a module-scope sys.exit() raises
# SystemExit (a BaseException that escapes that guard, silently exiting the
# importer mid-import and reporting a degraded run as false-clean). When run
# directly as the CLI (__name__ == "__main__"), psycopg-absence is self-handled
# with the named exit 5 (no traceback): a subprocess CLI invocation reports the
# precondition loudly, the import path owns re-raising for the importer.
try:
    import psycopg
    from psycopg import errors as pg_errors
    from psycopg.types.json import Jsonb
except ImportError as exc:
    sys.stderr.write(
        '{"hook":"_pg_dual_write_daemon","error_kind":"import_error","message":"%s"}\n'
        % str(exc).replace('"', "'")
    )
    if __name__ != "__main__":
        raise
    sys.exit(5)


# Map psycopg exception class -> core."HookErrorKind" enum value
def _classify_error(exc):
    if isinstance(exc, pg_errors.IntegrityError):
        return "constraint_violation"
    if isinstance(exc, psycopg.OperationalError):
        msg = str(exc).lower()
        if "timeout" in msg or "timed out" in msg:
            return "timeout"
        # Any non-timeout OperationalError is a connection/server-availability
        # fault → a literal substring list misses psycopg 3 phrasings
        # ("connection failed" / "connection to server on socket ... failed")
        # and degrades real connection errors to "unknown".
        return "connection_refused"
    return "unknown"


def _connect():
    # Unix socket only — dbname=glass_atrium has no host/port.
    return psycopg.connect("dbname=glass_atrium", connect_timeout=1)


# --- Operations ------------------------------------------------------------

def write_wiki_note(path, title, tags, type_, source_url, content, mtime, indexed_at=None):
    """UPSERT wiki.notes keyed by path. Returns elapsed_ms.

    The `ts` tsvector column is GENERATED ALWAYS — do not write it. The trigram
    GIN indexes (notes_title_trgm/tags_trgm/content_trgm) auto-update on the
    INSERT/UPDATE. Column `note_type` (PG) maps from caller's `type_` (avoids
    Python keyword collision).
    """
    start_ns = time.monotonic_ns()
    if indexed_at is None:
        indexed_at = int(time.time())
    sql = """
        INSERT INTO wiki.notes
            (path, title, tags, note_type, source_url, content, mtime, indexed_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (path) DO UPDATE SET
            title = EXCLUDED.title,
            tags = EXCLUDED.tags,
            note_type = EXCLUDED.note_type,
            source_url = EXCLUDED.source_url,
            content = EXCLUDED.content,
            mtime = EXCLUDED.mtime,
            indexed_at = EXCLUDED.indexed_at
        RETURNING id
    """
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                sql,
                (path, title, tags, type_, source_url, content, mtime, indexed_at),
            )
            cur.fetchone()
        conn.commit()
    return (time.monotonic_ns() - start_ns) // 1_000_000


def bump_wiki_dirty():
    """UPDATE wiki.dirty_flag SET dirty=true, last_dirty=now() WHERE id=1.

    Mirrors SQLite's notes_ai/ad/au triggers (UPDATE dirty_flag SET dirty=1).
    Stores epoch-seconds in last_dirty (bigint) for parity with SQLite schema.
    """
    start_ns = time.monotonic_ns()
    sql = """
        INSERT INTO wiki.dirty_flag (id, dirty, last_dirty)
        VALUES (1, true, %s)
        ON CONFLICT (id) DO UPDATE SET
            dirty = true,
            last_dirty = EXCLUDED.last_dirty
    """
    now_epoch = int(time.time())
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (now_epoch,))
        conn.commit()
    return (time.monotonic_ns() - start_ns) // 1_000_000


def clear_wiki_dirty():
    """UPDATE wiki.dirty_flag SET dirty=false (mirrors SQLite end-of-cycle clear)."""
    start_ns = time.monotonic_ns()
    sql = """
        INSERT INTO wiki.dirty_flag (id, dirty, last_dirty)
        VALUES (1, false, %s)
        ON CONFLICT (id) DO UPDATE SET
            dirty = false,
            last_dirty = EXCLUDED.last_dirty
    """
    now_epoch = int(time.time())
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (now_epoch,))
        conn.commit()
    return (time.monotonic_ns() - start_ns) // 1_000_000


def write_daemon_run(daemon_name, run_date, started_at, ended_at, status, **stats):
    """UPSERT core.daemon_runs PK (run_date, daemon_name). Returns elapsed_ms.

    Optional stats kwargs map directly to per-daemon columns:
      wiki: deadlinks_count, dedup_count, compiled_count, compiled_total,
            compile_ms, notes
      autoagent: cost_guard_state, patches_count, patches_apply_count,
                 patches_reject_count, apply_status_provenance, notes
    Unknown kwargs are silently dropped (forward-compatible). NULLable columns
    omitted from kwargs default to NULL.
    """
    start_ns = time.monotonic_ns()
    cols = ["run_date", "daemon_name", "started_at", "ended_at", "status"]
    vals = [run_date, daemon_name, started_at, ended_at, status]
    allowed = {
        # Compose provenance for the exits that never reach the compose op (a skipped stage
        # writes no CASE arm); the compose statement writes this column itself.
        "apply_status_provenance",
        "cost_guard_state",
        "patches_count",
        "patches_apply_count",
        "patches_reject_count",
        "deadlinks_count",
        "dedup_count",
        "compiled_count",   # wiki daily compile success count — wiki-compile-cron 04:00
        "compiled_total",   # wiki daily compile attempt total count — wiki-compile-cron 04:00
        "compile_ms",
        "notes",
    }
    for k in sorted(allowed):
        if k in stats and stats[k] is not None:
            cols.append(k)
            vals.append(stats[k])
    placeholders = ", ".join(["%s"] * len(cols))
    col_list = ", ".join(cols)
    update_set = ", ".join(
        "%s = EXCLUDED.%s" % (c, c)
        for c in cols
        if c not in ("run_date", "daemon_name")
    )
    sql = (
        "INSERT INTO core.daemon_runs (%s) VALUES (%s) "
        "ON CONFLICT (run_date, daemon_name) DO UPDATE SET %s"
    ) % (col_list, placeholders, update_set)
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, vals)
        conn.commit()
    return (time.monotonic_ns() - start_ns) // 1_000_000


class CallerContractViolation(ValueError):
    """An argument the writer refuses — a caller bug, not a PG fault.

    Two grounds: the database cannot store it (an out-of-set enum token, a value
    past the column width), or the writer's own identity policy rejects it (a
    subject disagreeing with its cause's class, which would store but key the
    wrong arm).

    Non-retryable by construction: the argument is wrong on every attempt, and _retry's
    backoff would only delay the named exit."""


class UnsupportedApplyStatus(CallerContractViolation):
    """apply_status outside APPLY_STATUS_TOKENS."""


# Statuses the apply stage OWNS — the composable set of compose_daemon_run_apply_status
# and, verbatim, its SQL CASE membership list. Every other core."DaemonStatus" value is
# patch generation's own verdict and is never composed over. The declaration is pinned
# against the SQL, the docstring and the CLI-contract header by the composition suite,
# so a fourth token cannot land in one place only.
APPLY_STATUS_TOKENS = ("ok", "apply_failed", "apply_unavailable")

# Provenance vocabulary — pinned verbatim against the SQL literals by the composition suite,
# so a reader of one never learns a token the other does not write.
COMPOSED_PREFIX = "composed:"
DECLINED_PREFIX = "declined:"

# Provenance the compose statement reported this process, handed to main() for the stdout
# trailer. Every op returns elapsed_ms and nothing else, so the CASE arm the database
# actually took has no other way back to the driver.
_COMPOSE_PROVENANCE = None

# Migrations a DEGRADED notice names, so one stderr line tells an operator exactly what to
# apply — the same shape the driver's enum probe uses when a core."DaemonStatus" label is missing.
# PROVENANCE → apply_status_provenance · PATTERN_EVIDENCE → the two proposal link columns ·
# TRIAL_LEDGER → core.autoagent_trial_ledger.
MIGRATION = SimpleNamespace(
    PROVENANCE="20260803000001_add_daemon_run_apply_status_provenance",
    PATTERN_EVIDENCE="20261005000000_add_pattern_evidence_provenance",
    TRIAL_LEDGER="20261008000000_add_trial_ledger_and_cycle_verdicts",
    SPAWN_MANIFEST_EXPOSURE="20261009000000_add_spawn_manifest_arm_fields",
    SPOOL_CLOSE_COUNTS="20261010000000_add_loop_event_spool_close_counts",
)


def compose_daemon_run_apply_status(daemon_name, run_date, apply_status):
    """Compose apply-stage health INTO an existing core.daemon_runs row's status.

    The run row is written before the apply stage runs and its status derives
    solely from per-patch generation errors, so an aborted apply left no trace on
    any surface. This op folds the apply outcome in AFTER the stage returns.

    Composition is a SQL CASE rather than a read-modify-write: the driver never
    learns the patch-generation verdict, so only the database can decide without
    a race. The composable set is APPLY_STATUS_TOKENS — the statuses the apply
    stage OWNS: clean ('ok'), aborted ('apply_failed') and script-unusable
    ('apply_unavailable', absent or non-executable apply script — unavailability,
    not failure). Any of them replaces any other in EITHER direction, so a
    same-date re-run always carries the latest apply verdict and no stale one
    sticks. Every other value (partial / error / missing / stale /
    quota_exceeded) is patch generation's OWN verdict and is preserved untouched,
    so a failed generation can never be erased by a clean apply. An absent row
    (push skipped) updates nothing — this op never INSERTs, because the driver
    holds no patch stats and would fabricate a run record.

    A token outside the set is REFUSED (UnsupportedApplyStatus, CLI exit 6)
    before connecting: the enum cannot store it, and the matched-row count cannot
    detect it — a CASE fall-through matches the row, reports a hit and leaves the
    operator surface reading whatever it read before.

    That same blindness applies to the ELSE arm itself, which is why the statement
    also writes apply_status_provenance and RETURNS it: the preserved verdict is
    the contract, but a decline that reports nothing drops apply health with no
    signal on any channel. Provenance names the arm the database took —
    'composed:<token>' or 'declined:<pre-existing status>' — durably on the same
    row as the status it explains, and on stdout for the driver. It is decided
    INSIDE this statement because a read-then-write in the driver would race the
    row being composed.

    The provenance column ships as a migration and this helper ships in a release
    bundle, so an install can hold the new helper against an older DB — and the
    update path runs no migration. Writing the column unconditionally would turn a
    WORKING compose into a hard failure every cycle there, which is the inverse of
    the silence provenance exists to remove. So the write DEGRADES: an absent
    column composes the status alone and names the migration on stderr (exit 0,
    no trailer), and a migrated DB records full provenance.

    apply_status: one of APPLY_STATUS_TOKENS. Returns elapsed_ms.
    """
    start_ns = time.monotonic_ns()
    if apply_status not in APPLY_STATUS_TOKENS:
        raise UnsupportedApplyStatus(
            "op=compose_daemon_run_apply_status refused apply_status=%r "
            "(accepted: %s) — run row left unchanged, apply health NOT recorded"
            % (apply_status, " ".join(APPLY_STATUS_TOKENS))
        )
    # Both CASE arms read the PRE-existing status: PostgreSQL and sqlite alike evaluate every
    # SET expression against the old row, so the ELSE arm's `status` is the verdict being kept.
    sql = """
        UPDATE core.daemon_runs SET
            status = CASE
                WHEN status IN ('ok', 'apply_failed', 'apply_unavailable')
                    THEN %(apply_status)s::core."DaemonStatus"
                ELSE status
            END,
            apply_status_provenance = CASE
                WHEN status IN ('ok', 'apply_failed', 'apply_unavailable')
                    THEN 'composed:' || %(apply_status)s
                ELSE 'declined:' || status::text
            END
        WHERE run_date = %(run_date)s
          AND daemon_name = %(daemon_name)s::core."DaemonType"
        RETURNING apply_status_provenance
    """
    # The same composition minus the column an unmigrated DB does not have. RETURNING is kept
    # — on `status`, which every DB has — because the matched-nothing guard below reads returned
    # ROWS, not a row count; dropping the clause would trade the provenance silence for that one.
    degraded_sql = """
        UPDATE core.daemon_runs SET
            status = CASE
                WHEN status IN ('ok', 'apply_failed', 'apply_unavailable')
                    THEN %(apply_status)s::core."DaemonStatus"
                ELSE status
            END
        WHERE run_date = %(run_date)s
          AND daemon_name = %(daemon_name)s::core."DaemonType"
        RETURNING status
    """
    params = {
        "apply_status": apply_status,
        "run_date": run_date,
        "daemon_name": daemon_name,
    }
    global _COMPOSE_PROVENANCE
    degraded = False
    with _connect() as conn:
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                returned = cur.fetchall()
        except pg_errors.UndefinedColumn:
            # Keyed on SQLSTATE 42703 by class, NOT on a catalog probe: a probe has to answer
            # "what if the probe itself failed", and every answer either reports a connection or
            # permission fault as an absent column or restores the hard fail. This arm masks
            # nothing — every other error propagates into _retry and the named exit 4 exactly as
            # before, and a 42703 from degraded_sql (i.e. `status` itself missing, a different
            # disaster) is outside the try and is NOT caught.
            degraded = True
            conn.rollback()
            with conn.cursor() as cur:
                cur.execute(degraded_sql, params)
                returned = cur.fetchall()
        conn.commit()
    if degraded:
        # Before the row-outcome guards: this reports the INSTALL's state, which is true whether
        # or not a row matched.
        sys.stderr.write(
            "[%s-daemon] op=compose_daemon_run_apply_status DEGRADED "
            "column=apply_status_provenance absent (run_date=%s) — status composed, provenance "
            "NOT recorded; apply migration %s and the next cycle records it\n"
            % (daemon_name, run_date, MIGRATION.PROVENANCE)
        )
    # RETURNING rows, never the matched-row count: the count is 1 on BOTH arms because the row
    # is selected by key and not by the CASE condition, so it reports a hit for a compose that
    # changed nothing. Only the returned token names the arm.
    if not returned:
        # Not a write failure, so it must not raise — but a compose that matched nothing recorded
        # no apply health at all, which is the exact silence this op exists to remove. stderr is
        # the channel the log aggregator reads, same as the pg_write=ok/fail line.
        sys.stderr.write(
            "[%s-daemon] op=compose_daemon_run_apply_status matched no run row "
            "(run_date=%s) — apply health NOT recorded for this cycle\n"
            % (daemon_name, run_date)
        )
        return (time.monotonic_ns() - start_ns) // 1_000_000
    if degraded:
        # degraded_sql returns the composed STATUS, never provenance — reporting it as
        # provenance would name a value no channel can distinguish from a stored one.
        return (time.monotonic_ns() - start_ns) // 1_000_000
    _COMPOSE_PROVENANCE = returned[0][0]
    if _COMPOSE_PROVENANCE.startswith(DECLINED_PREFIX):
        # The decline is the contract, its silence was the defect: the row matched, so the
        # matched-nothing guard above stays quiet and the driver logs a clean end.
        sys.stderr.write(
            "[%s-daemon] op=compose_daemon_run_apply_status declined apply_status=%s "
            "(run_date=%s) — pre-existing %s is patch generation's own verdict and is kept, "
            "apply health NOT recorded for this cycle\n"
            % (
                daemon_name,
                apply_status,
                run_date,
                _COMPOSE_PROVENANCE[len(DECLINED_PREFIX):],
            )
        )
    return (time.monotonic_ns() - start_ns) // 1_000_000


def write_daemon_run_payload(run_date, daemon_name, payload):
    """UPSERT core.daemon_run_payload PK (run_date, daemon_name). FK 1:1 with daemon_runs.

    payload: dict (json-serializable). Parameter name matches the schema column
    name and the CLI envelope key. payload_size_bytes auto-computed.
    """
    start_ns = time.monotonic_ns()
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    size_bytes = len(blob.encode("utf-8"))
    sql = """
        INSERT INTO core.daemon_run_payload
            (run_date, daemon_name, payload, payload_size_bytes)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (run_date, daemon_name) DO UPDATE SET
            payload = EXCLUDED.payload,
            payload_size_bytes = EXCLUDED.payload_size_bytes
    """
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (run_date, daemon_name, Jsonb(payload), size_bytes))
        conn.commit()
    return (time.monotonic_ns() - start_ns) // 1_000_000


# --- Autoagent operations --------------------------------------------------

# Approval-tier classification mirror (see daemon_cycle.py classify_patch_area).
# autoagent emits a free-form classification string; PG enums constrain both
# `classification` (apply / reject) and `approval_tier` (auto / llm / user).
# Map below collapses the daemon's free-form labels into the schema enum pair.
_CLASSIFICATION_TO_ENUM = {
    "body-auto": ("apply", "auto"),
    "body-llm": ("apply", "llm"),
    "body-user": ("apply", "user"),
    "frontmatter-dryrun": ("apply", "user"),
    "frontmatter-auto": ("apply", "auto"),
    "frontmatter-llm": ("apply", "llm"),
    "frontmatter-user": ("apply", "user"),
    "reject": ("reject", "auto"),
}

# 'safety' (human-approval route; no enum label) → 'user', never the 'auto' backlog
_APPROVAL_TIER_TO_ENUM = {
    "auto": "auto",
    "llm": "llm",
    "user": "user",
    "safety": "user",
}


def _coerce_classification(raw):
    """Return (classification_enum, approval_tier_enum) from daemon-emitted label.

    Unknown label -> ('reject', 'auto') (defensive — never raise; daemon must
    not block on a previously unseen classification keyword).
    """
    if not raw:
        return ("reject", "auto")
    return _CLASSIFICATION_TO_ENUM.get(str(raw), ("reject", "auto"))


# Terminal statuses for both conflict arms: never downgraded by a re-push, frozen once reviewed.
# Compared as status::text → the 'unadjudicated' literal still plans on a schema lacking the label.
_TERMINAL_STATUS_SQL = "('applied', 'approved', 'rejected', 'reverted', 'unadjudicated')"
_BACKOFF_MARKER = "skipped:chronic-timeout-backoff"

# Preserve-the-stored-verdict predicate: stored terminal AND incoming non-terminal,
# minus the marker exemption, which widens the non-terminal-push arm only.
# COALESCE → a NULL outcome compares as not-the-marker, never as unknown.
# Status, its rationale and its actor move together, so all three CASE arms read it
# from here — identical by construction, not by a comment asking for it.
_PRESERVE_STORED_VERDICT_SQL = f"""
                            core.autoagent_proposals.status::text IN {_TERMINAL_STATUS_SQL}
                            AND EXCLUDED.status::text NOT IN {_TERMINAL_STATUS_SQL}
                            AND NOT (
                                COALESCE(core.autoagent_proposals.haiku_status, '')
                                    = '{_BACKOFF_MARKER}'
                                AND COALESCE(EXCLUDED.haiku_status, '')
                                    <> '{_BACKOFF_MARKER}')"""


# Label test shared by the status fragment and the probe → one text, one answer.
_UNADJUDICATED_LABEL_SQL = """
    SELECT 1
      FROM pg_catalog.pg_enum AS e
      JOIN pg_catalog.pg_type AS t ON t.oid = e.enumtypid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
     WHERE n.nspname = 'core'
       AND t.typname = 'ProposalStatus'
       AND e.enumlabel = 'unadjudicated'"""

# Status value for every proposals.status writer; its one %s is the requested status.
# Label absent (code ahead of its migration) → 'unadjudicated' stores 'rejected'; backfill relabels.
# Text in the subquery, cast once outside at run time → probe + write in one statement.
PROPOSAL_STATUS_SQL = f"""(
    SELECT CASE
             WHEN r.requested = 'unadjudicated'
                  AND NOT EXISTS ({_UNADJUDICATED_LABEL_SQL})
             THEN 'rejected'
             ELSE r.requested
           END
      FROM (SELECT %s::text AS requested) AS r
)::core."ProposalStatus"
"""


@dataclass(frozen=True)
class _LinkSql:
    """Per-clause UPSERT fragments for the pattern-evidence columns; empty → columns absent."""

    columns: str = ""
    values: str = ""
    set: str = ""


# Pattern-evidence proposal columns; absent where MIGRATION.PATTERN_EVIDENCE did not land.
_PROPOSAL_LINK = _LinkSql(
    columns=",\n             learning_pattern_id, generator_input_version",
    values=",\n                %s, %s",
    # COALESCE → an envelope naming no link (an older report, another writer) never unlinks a row.
    set=""",
            learning_pattern_id = COALESCE(EXCLUDED.learning_pattern_id,
                                           core.autoagent_proposals.learning_pattern_id),
            generator_input_version = COALESCE(EXCLUDED.generator_input_version,
                                               core.autoagent_proposals.generator_input_version)""",
)


def _get_proposal_upsert_sql(has_link_columns):
    """The proposal UPSERT, with or without the two pattern-evidence columns."""
    link = _PROPOSAL_LINK if has_link_columns else _LinkSql()
    return f"""
        INSERT INTO core.autoagent_proposals
            (cycle_date, pattern_label, target_file, target_agent,
             classification, rationale, haiku_status, approval_tier, status,
             proposed_diff, cost_guard_state, reviewed_by,
             source_file, source_file_mtime,
             indexed_at,
             pre_verify_passed, pre_verify_status, pre_verify_rationale,
             pre_verify_axes,
             confidence_observed, project_key, promotion_tier{link.columns})
        VALUES (%s, %s, %s, %s,
                %s::core."ProposalClassification", %s, %s,
                %s::core."ApprovalTier",
                {PROPOSAL_STATUS_SQL},
                %s, %s, %s,
                %s, %s,
                COALESCE(%s, CURRENT_TIMESTAMP),
                %s, %s, %s, %s,
                %s, %s, %s{link.values})
        ON CONFLICT (cycle_date, pattern_label, target_file) DO UPDATE SET
            target_agent = EXCLUDED.target_agent,
            classification = EXCLUDED.classification,
            -- The rationale is part of the status verdict, so it MOVES WITH the
            -- status: the arm that preserves a stored terminal status preserves the
            -- stored text that records why, and the arm that takes the incoming
            -- status takes the incoming text. Assigning it unconditionally erased a
            -- supersede stamp on every re-push while the terminal status survived,
            -- leaving a verdict no text explains — and the erased text is live input
            -- to the reject-streak classifier, not inert history. The co-movement is
            -- pinned by scripts/test/test_pg_dual_write_proposal_upsert.py.
            rationale = CASE
                          WHEN {_PRESERVE_STORED_VERDICT_SQL}
                          THEN core.autoagent_proposals.rationale
                          ELSE EXCLUDED.rationale
                        END,
            haiku_status = EXCLUDED.haiku_status,
            approval_tier = EXCLUDED.approval_tier,
            -- RC1 fix: never downgrade a terminal status on cycle-end re-push.
            -- The report's baked-in status is always 'pending'; a re-push of the
            -- same (cycle_date, pattern_label, target_file) after the apply stage
            -- set 'applied'/'approved'/'rejected' must preserve that state,
            -- else verified+committed proposals revert to pending.
            --
            -- The preservation is scoped to a NON-terminal incoming status, which
            -- is exactly the re-push RC1 addresses. An incoming TERMINAL status is
            -- an authoritative outcome, not a stale bake: the updater keys one
            -- accountability row per body per day, so a same-day decline-then-accept
            -- would otherwise leave 'rejected' on content that landed.
            status = CASE
                       WHEN {_PRESERVE_STORED_VERDICT_SQL}
                       THEN core.autoagent_proposals.status
                       ELSE EXCLUDED.status
                     END,
            -- Third column under that same predicate: the actor answers who moved
            -- the row, so it moves with what it moved. COALESCE on the refreshing
            -- arm — this column was unreachable from any push until it joined the
            -- SET list, and an envelope naming no actor must not acquire the power
            -- to clear a stored one.
            reviewed_by = CASE
                            WHEN {_PRESERVE_STORED_VERDICT_SQL}
                            THEN core.autoagent_proposals.reviewed_by
                            ELSE COALESCE(EXCLUDED.reviewed_by,
                                          core.autoagent_proposals.reviewed_by)
                          END,
            proposed_diff = EXCLUDED.proposed_diff,
            cost_guard_state = EXCLUDED.cost_guard_state,
            source_file = EXCLUDED.source_file,
            source_file_mtime = EXCLUDED.source_file_mtime,
            indexed_at = EXCLUDED.indexed_at,
            pre_verify_passed = EXCLUDED.pre_verify_passed,
            pre_verify_status = EXCLUDED.pre_verify_status,
            pre_verify_rationale = EXCLUDED.pre_verify_rationale,
            pre_verify_axes = EXCLUDED.pre_verify_axes,
            confidence_observed = EXCLUDED.confidence_observed,
            project_key = EXCLUDED.project_key,
            promotion_tier = EXCLUDED.promotion_tier{link.set}
        -- Reviewed terminal row (apply flip or reject route) → frozen, all columns.
        WHERE NOT (core.autoagent_proposals.status::text IN {_TERMINAL_STATUS_SQL}
                   AND core.autoagent_proposals.reviewed_at IS NOT NULL)
        RETURNING id
    """


def get_proposal_status_label_state(conn):
    """Whether core."ProposalStatus" carries the 'unadjudicated' label on `conn`.

    Returns "present" or "absent" when the catalog answers, "unknown" when the query
    cannot run (closed connection, server fault) — the caller decides what an unknown
    schema means; the fault itself is named on stderr.
    """
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT EXISTS ({_UNADJUDICATED_LABEL_SQL})")
            row = cur.fetchone()
    except psycopg.Error as exc:
        sys.stderr.write(
            json.dumps(
                {
                    "hook": "_pg_dual_write_daemon",
                    "op": "get_proposal_status_label_state",
                    "error_kind": _classify_error(exc),
                    "message": str(exc),
                }
            )
            + "\n"
        )
        return "unknown"
    return "present" if row and row[0] else "absent"


def write_autoagent_proposal(
    cycle_date,
    pattern_label,
    target_file,
    target_agent,
    classification,
    rationale,
    haiku_status,
    approval_tier,
    status,
    proposed_diff,
    cost_guard_state,
    source_file,
    source_file_mtime,
    indexed_at=None,
    pre_verify_passed=None,
    pre_verify_status="",
    pre_verify_rationale="",
    pre_verify_axes=None,
    confidence_observed=None,
    project_key="",
    promotion_tier="",
    reviewed_by="",
    learning_pattern_id=None,
    generator_input_version=None,
):
    """UPSERT core.autoagent_proposals on (cycle_date, pattern_label, target_file).

    Returns elapsed_ms. Parameter names mirror the SQL column names 1:1 and
    the CLI envelope keys 1:1. `classification` and `approval_tier` accept
    free-form daemon labels; the helper coerces via _coerce_classification when
    one of them is unknown to the schema enum — caller MAY pass already-coerced
    values, in which case the coercion is a no-op identity.

    Pre-verify dual-write: 4 fields (pre_verify_passed/status/rationale/axes)
    carry the daemon's pre-verification verdict; pre_verify_axes is JSONB (dict
    serialized via Jsonb adapter), the other three are scalars.

    Confidence-weighted promotion ladder: 3 fields —
    confidence_observed (REAL, Beta-Binomial posterior; None → NULL when the
    feature flag is off), project_key (TEXT, 12-hex isolation key; ""→NULL),
    promotion_tier (TEXT, mention/candidate/proposal/instruction-edit/
    skill-candidate; ""→NULL). All NULLable — older rows omit them.

    Provenance: `reviewed_by` names the actor that produced the row's status, from
    the closed token set declared at monitor/prisma/schema.prisma → AutoagentProposal.
    Each envelope source passes its own token; ""→NULL, and a NULL incoming value
    never clears a stored actor. No arm here writes `reviewed_at`: a push is not a
    verdict.

    Pattern evidence: `learning_pattern_id` (core.learning_log id) and
    `generator_input_version`; None/""→NULL for both, and a 0 id (the daemon's
    no-pattern sentinel) →NULL too. A NULL incoming value never clears a stored one.
    A schema without the two columns still gets the row, without them, and the
    missing migration is named on stderr.
    """
    start_ns = time.monotonic_ns()
    if indexed_at is None:
        # PG default is CURRENT_TIMESTAMP; pass NULL by omission of the column
        # rather than computing wall-clock here. Sentinel sticks for explicit
        # backfill timestamps (caller-supplied).
        pass

    cls_enum, tier_enum = _coerce_classification(classification)
    # Caller-provided approval_tier overrides the coerced one (only when known)
    tier_enum = _APPROVAL_TIER_TO_ENUM.get(approval_tier, tier_enum)
    if status not in (
        "pending", "approved", "rejected", "applied", "snoozed", "unadjudicated"
    ):
        # A reject-classification row with an empty/invalid status MUST settle as
        # 'rejected', not 'pending' — else auto-reject proposals fossilize in the
        # pending queue.
        status = "rejected" if cls_enum == "reject" else "pending"

    # pre_verify_axes is JSONB. None / empty dict both pass through Jsonb() —
    # psycopg serializes {} as "{}" (valid JSON object), None as NULL.
    axes_param = Jsonb(pre_verify_axes) if pre_verify_axes is not None else None
    # Empty-string project_key/promotion_tier → NULL (DDL default).
    # confidence_observed=None → NULL (feature flag off / cold-start not stored).
    project_key_param = project_key or None
    promotion_tier_param = promotion_tier or None
    # ""→NULL: an unnamed actor is ABSENT, and the conflict arm coalesces it away.
    reviewed_by_param = reviewed_by or None
    params = (
        cycle_date,
        pattern_label,
        target_file,
        target_agent,
        cls_enum,
        rationale,
        haiku_status,
        tier_enum,
        status,
        proposed_diff,
        cost_guard_state,
        reviewed_by_param,
        source_file,
        source_file_mtime,
        indexed_at,
        pre_verify_passed,
        pre_verify_status,
        pre_verify_rationale,
        axes_param,
        confidence_observed,
        project_key_param,
        promotion_tier_param,
    )
    link_params = (learning_pattern_id or None, generator_input_version or None)
    is_degraded = False
    with _connect() as conn:
        try:
            with conn.cursor() as cur:
                cur.execute(_get_proposal_upsert_sql(True), params + link_params)
                cur.fetchone()  # None when the reviewed-row freeze skips the update
        except pg_errors.UndefinedColumn:
            # SQLSTATE 42703 by class, as in compose_daemon_run_apply_status; a 42703 from
            # the column-free statement is outside the try and propagates.
            is_degraded = True
            conn.rollback()
            with conn.cursor() as cur:
                cur.execute(_get_proposal_upsert_sql(False), params)
                cur.fetchone()
        conn.commit()
    if is_degraded:
        sys.stderr.write(
            "[autoagent-daemon] op=write_autoagent_proposal DEGRADED "
            "columns=learning_pattern_id,generator_input_version absent "
            "(cycle_date=%s, pattern_label=%s) — row written without its pattern link and "
            "input version; apply migration %s and the next push records them\n"
            % (cycle_date, pattern_label, MIGRATION.PATTERN_EVIDENCE)
        )
    return (time.monotonic_ns() - start_ns) // 1_000_000


class VerdictSubjectMissing(CallerContractViolation):
    """A verdict-class cause arrived with no subject to adjudicate."""


class CensusSubjectPresent(CallerContractViolation):
    """A census-class cause arrived carrying a subject no arm can key it on."""


class SubjectTooLong(CallerContractViolation):
    """A subject arrived wider than the column that keys the verdict arm."""


# Cause tokens whose row adjudicates ONE subject, so a correction of that subject
# supersedes its predecessor. Declared here, not in daemon_cycle.py: that module
# imports this one, so the reverse edge would be circular — and it does NOT read
# this tuple, restating each token as its own constant.
# Sole reader outside this module: autoagent/test/test_discharge_wiring.py.
LOOP_EVENT_VERDICT_CAUSES = (
    "discharge-read-failed",
    "discharge-unresolved",
    "discharge-covered-terminal",
    "discharge-intake-miss",
    # Subject = the spool name.
    "manifest-spool-closed",
)

# The column whose presence selects the row class. Both arms' predicates, the verdict
# key and the INSERT column list compose from this one name, so a rename cannot leave
# one of them pointing at a column the others abandoned — and a drift from the
# migration's own predicates reds the identity pin.
_LOOP_EVENT_SUBJECT_COLUMN = "subject"
_LOOP_EVENT_CENSUS_PREDICATE = "%s IS NULL" % _LOOP_EVENT_SUBJECT_COLUMN
_LOOP_EVENT_VERDICT_PREDICATE = "%s IS NOT NULL" % _LOOP_EVENT_SUBJECT_COLUMN
# Declared width of that column in the split migration — the refusal boundary below.
_LOOP_EVENT_SUBJECT_MAX_CHARS = 128
_LOOP_EVENT = SimpleNamespace(
    # A MANIFEST spool close's counts; NULL on every other row.
    COUNT_COLUMNS=("lines_read", "lines_without_row"),
)


def _check_loop_event_class(eval_result, subject):
    """Refuse a row whose cause token and its subject disagree about the class.

    The token set NAMES the class, so the subject agrees with it in BOTH
    directions or nothing is written. A blank string is neither absence nor an
    identity: `'' IS NOT NULL` holds, so it survives the `is None` test, keys the
    verdict arm on `""` where two adjudications collapse onto one row, and under a
    census cause lands inside the VERDICT partial unique — which that row's own
    conflict target (`WHERE subject IS NULL`) cannot match, so a duplicate raises
    unique_violation instead of updating. Refused either way.
    """
    if eval_result in LOOP_EVENT_VERDICT_CAUSES:
        if subject is None or not str(subject).strip():
            raise VerdictSubjectMissing(
                "op=write_autoagent_loop_event refused eval_result=%r with subject=%r "
                "(verdict causes: %s) — nothing written, the adjudication is NOT recorded"
                % (eval_result, subject, " ".join(LOOP_EVENT_VERDICT_CAUSES))
            )
    elif subject is not None:
        raise CensusSubjectPresent(
            "op=write_autoagent_loop_event refused eval_result=%r with subject=%r — a "
            "census cause is keyed on the cause itself, so its row carries no subject "
            "(verdict causes: %s)" % (eval_result, subject, " ".join(LOOP_EVENT_VERDICT_CAUSES))
        )


def _get_loop_event_upsert_sql(eval_result, has_counts):
    """The INSERT … ON CONFLICT for one row class, with the count columns when the row has counts."""
    columns = (
        "event_ts",
        "agent",
        "rice",
        "eval_result",
        "changes_added",
        "changes_removed",
        _LOOP_EVENT_SUBJECT_COLUMN,
    ) + (_LOOP_EVENT.COUNT_COLUMNS if has_counts else ())
    return "INSERT INTO core.autoagent_loop_events (%s) VALUES (%s) %s RETURNING id" % (
        ", ".join(columns),
        ", ".join(["%s"] * len(columns)),
        _get_loop_event_conflict_arm(eval_result, has_counts),
    )


def _get_loop_event_conflict_arm(eval_result, has_counts=False):
    """The ON CONFLICT arm for one row class, named by the cause token.

    Each arm carries the predicate of the partial unique index it targets: both
    uniques are predicate-bearing, so a bare column-list target infers neither.
    """
    if eval_result in LOOP_EVENT_VERDICT_CAUSES:
        key = ("event_ts", "agent", _LOOP_EVENT_SUBJECT_COLUMN)
        predicate = _LOOP_EVENT_VERDICT_PREDICATE
        # A correction is exactly a new cause for a settled subject → the arm updates it.
        updated = ("rice", "eval_result", "changes_added", "changes_removed")
    else:
        key = ("event_ts", "agent", "eval_result")
        predicate = _LOOP_EVENT_CENSUS_PREDICATE
        updated = ("rice", "changes_added", "changes_removed")
    updated += _LOOP_EVENT.COUNT_COLUMNS if has_counts else ()
    return "ON CONFLICT (%s) WHERE %s DO UPDATE SET %s" % (
        ", ".join(key),
        predicate,
        ", ".join("%s = EXCLUDED.%s" % (c, c) for c in updated),
    )


def write_autoagent_loop_event(
    event_ts,
    agent,
    eval_result,
    changes_added,
    changes_removed,
    rice=None,
    subject=None,
    lines_read=None,
    lines_without_row=None,
):
    """UPSERT core.autoagent_loop_events under the identity class `subject` selects.

    Returns elapsed_ms. Two row classes share the table, so there is no one
    idempotency key. A census row (subject absent) records one cause for one agent
    at one event_ts, keyed on (event_ts, agent, eval_result) at whatever instant the
    caller stamps — never a day unless the caller truncates to one. A re-emission
    overwrites that row rather than incrementing it, so emitting the same cycle
    report twice lands one row.
    A verdict row adjudicates ONE subject, keyed on (event_ts, agent, subject),
    so a correction carrying a new cause supersedes the verdict it corrects
    instead of landing beside it.

    The cause token names the class and the subject must agree with it, either way
    round: a mismatch is REFUSED before connecting (CLI exit 6) rather than filed
    under the other class — see _check_loop_event_class.

    A MANIFEST spool close carries lines_read / lines_without_row; a schema without those
    columns still gets the row, without its counts, under a named DEGRADED line.
    """
    start_ns = time.monotonic_ns()
    # Trim before classing → a subject differing only by surrounding space is ONE
    # adjudication, which the verdict arm would otherwise key as two.
    if subject is not None:
        subject = str(subject).strip()
        if len(subject) > _LOOP_EVENT_SUBJECT_MAX_CHARS:
            # Refused, never truncated — the subject KEYS the verdict arm, so a
            # silent trim collapses two adjudications onto one row. Raising here
            # keeps a caller bug on exit 6 instead of a PG string-overflow on 4.
            raise SubjectTooLong(
                "op=write_autoagent_loop_event refused subject of %d chars "
                "(column width %d): %r — nothing written"
                % (len(subject), _LOOP_EVENT_SUBJECT_MAX_CHARS, subject[:80])
            )
    _check_loop_event_class(eval_result, subject)
    params = (event_ts, agent, rice, eval_result, changes_added, changes_removed, subject)
    counts = (lines_read, lines_without_row)
    has_counts = counts != (None, None)
    is_degraded = False
    with _connect() as conn:
        try:
            with conn.cursor() as cur:
                cur.execute(
                    _get_loop_event_upsert_sql(eval_result, has_counts),
                    params + (counts if has_counts else ()),
                )
                cur.fetchone()
        except pg_errors.UndefinedColumn:
            # SQLSTATE 42703 by class, as in compose_daemon_run_apply_status; a row without
            # counts names no count column, so its 42703 is another fault and propagates.
            if not has_counts:
                raise
            is_degraded = True
            conn.rollback()
            with conn.cursor() as cur:
                cur.execute(_get_loop_event_upsert_sql(eval_result, False), params)
                cur.fetchone()
        conn.commit()
    if is_degraded:
        sys.stderr.write(
            "[autoagent-daemon] op=write_autoagent_loop_event DEGRADED "
            "columns=lines_read,lines_without_row absent (subject=%s) — close row written "
            "without its counts; apply migration %s and later closes record them\n"
            % (subject, MIGRATION.SPOOL_CLOSE_COUNTS)
        )
    return (time.monotonic_ns() - start_ns) // 1_000_000


def write_autoagent_corpus_audit(
    cycle_date,
    word_count,
    token_estimate,
    file_count,
    trend_alert,
    trend_delta,
    absolute_alert,
    seeded_threshold,
    compliance_rate,
    override_rate,
    gate_pass_count,
    gate_trip_count,
    gate_total_count,
):
    """UPSERT core.autoagent_corpus_audits on cycle_date.

    Returns elapsed_ms. One corpus-size audit per cycle, so cycle_date is the
    natural idempotency key: a same-day re-run UPDATEs the reading in place
    rather than growing the table. trend_delta / compliance_rate / override_rate
    are passed through unchanged — a None means insufficient data and MUST stay
    NULL, never a fabricated 0.

    indexed_at is refreshed on conflict, matching write_autoagent_proposal: a
    row carrying the second write's values must not carry the first write's
    timestamp, or /api/improvement/corpus-audits reads the reading as stale.
    """
    start_ns = time.monotonic_ns()
    sql = """
        INSERT INTO core.autoagent_corpus_audits
            (cycle_date, word_count, token_estimate, file_count,
             trend_alert, trend_delta, absolute_alert, seeded_threshold,
             compliance_rate, override_rate,
             gate_pass_count, gate_trip_count, gate_total_count,
             indexed_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                CURRENT_TIMESTAMP)
        ON CONFLICT (cycle_date) DO UPDATE SET
            word_count = EXCLUDED.word_count,
            token_estimate = EXCLUDED.token_estimate,
            file_count = EXCLUDED.file_count,
            trend_alert = EXCLUDED.trend_alert,
            trend_delta = EXCLUDED.trend_delta,
            absolute_alert = EXCLUDED.absolute_alert,
            seeded_threshold = EXCLUDED.seeded_threshold,
            compliance_rate = EXCLUDED.compliance_rate,
            override_rate = EXCLUDED.override_rate,
            gate_pass_count = EXCLUDED.gate_pass_count,
            gate_trip_count = EXCLUDED.gate_trip_count,
            gate_total_count = EXCLUDED.gate_total_count,
            indexed_at = EXCLUDED.indexed_at
        RETURNING id
    """
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                sql,
                (
                    cycle_date,
                    word_count,
                    token_estimate,
                    file_count,
                    trend_alert,
                    trend_delta,
                    absolute_alert,
                    seeded_threshold,
                    compliance_rate,
                    override_rate,
                    gate_pass_count,
                    gate_trip_count,
                    gate_total_count,
                ),
            )
            cur.fetchone()
        conn.commit()
    return (time.monotonic_ns() - start_ns) // 1_000_000


_SPAWN_MANIFEST_SQL = SimpleNamespace(
    COUNT="SELECT count(*) FROM core.spawn_manifest WHERE spool = %s",
    INSERT=SimpleNamespace(
        FULL="""
            INSERT INTO core.spawn_manifest
                (spool, line_offset, agent_id, agent_type, session_id, started_at,
                 ctx_bytes, blocks, arm, salt_id, delivered, delivered_hash)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (spool, line_offset) DO NOTHING
        """,
        # A schema before MIGRATION.SPAWN_MANIFEST_EXPOSURE.
        PRE_EXPOSURE="""
            INSERT INTO core.spawn_manifest
                (spool, line_offset, agent_id, agent_type, session_id, started_at,
                 ctx_bytes, blocks)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (spool, line_offset) DO NOTHING
        """,
    ),
)


def write_spawn_manifest_rows(spool, rows):
    """INSERT one spool's MANIFEST lines in one transaction → the rows the spool now has.

    rows: (line_offset, agent_id, agent_type, session_id, started_at, ctx_bytes,
    blocks, arm, salt_id, delivered, delivered_hash) tuples. (spool, line_offset) is
    the ingest position, so a re-read of the same spool adds only lines appended since
    and a crash re-read adds nothing. The count is read inside the same transaction:
    the caller unlinks the spool on it. A schema without the exposure columns stores
    the row without them and names the migration on stderr. Raises on any other PG
    fault, a schema without the table included.
    """
    is_degraded = False
    with _connect() as conn:
        try:
            _insert_spawn_manifest_rows(conn, spool, rows, has_exposure=True)
        except pg_errors.UndefinedColumn:
            # SQLSTATE 42703 by class, as in compose_daemon_run_apply_status; a 42703 from
            # the column-free statement is outside the try and propagates.
            is_degraded = True
            conn.rollback()
            _insert_spawn_manifest_rows(conn, spool, rows, has_exposure=False)
        with conn.cursor() as cur:
            cur.execute(_SPAWN_MANIFEST_SQL.COUNT, (spool,))
            rows_present = cur.fetchone()[0]
        conn.commit()
    if is_degraded:
        sys.stderr.write(
            "[autoagent-daemon] op=write_spawn_manifest_rows DEGRADED "
            f"columns=arm,salt_id,delivered,delivered_hash absent (spool={spool}) — rows "
            "written without their canary exposure fields; apply migration "
            f"{MIGRATION.SPAWN_MANIFEST_EXPOSURE} and later lines record them\n"
        )
    return rows_present


def _insert_spawn_manifest_rows(conn, spool, rows, *, has_exposure):
    if not rows:
        return
    if has_exposure:
        sql, params = _SPAWN_MANIFEST_SQL.INSERT.FULL, [(spool, *row) for row in rows]
    else:
        sql = _SPAWN_MANIFEST_SQL.INSERT.PRE_EXPOSURE
        params = [(spool, *row[:7]) for row in rows]
    with conn.cursor() as cur:
        cur.executemany(sql, params)


def get_spawn_manifest_row_count(spool):
    """Rows stored for one spool; raises on any PG fault, a schema without the table included."""
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(_SPAWN_MANIFEST_SQL.COUNT, (spool,))
            return cur.fetchone()[0]


class TrialLedgerValueUndeclared(CallerContractViolation):
    """An event, actor or declared payload shape outside TRIAL_LEDGER."""


_TRIAL_LEDGER_EVENT = SimpleNamespace(
    SHADOW_PREREGISTRATION="shadow-preregistration",  # dedupe_key = <trial key>
    SHADOW_LOOK="shadow-look",  # dedupe_key = <trial key>:look:<n>
    POWER_PASS_COUNT="power-pass-count",  # dedupe_key = power-pass-count:<cycle date>
    AA_START="aa-start",  # opens the A/A; dedupe_key = aa-start:after:<latest start id | 0>
    AA_RESTART="aa-restart",  # dedupe_key = aa-restart:<start id>:<cycle date>
    AA_RESULT="aa-result",  # closes the A/A; dedupe_key = aa-result:<start id>
    # Session clustering; a period (block-level) design effect is its own event, never this one.
    AA_SESSION_DESIGN_EFFECT="aa-session-design-effect",
    # a canary bound to no trial; dedupe_key = canary-unbound-delivery:<spool>:<line offset>
    CANARY_UNBOUND_DELIVERY="canary-unbound-delivery",
)

# The ledger's closed sets, declared once: event and actor are VARCHAR columns, so nothing
# below this writer refuses a misspelling, and an append-only row can never be corrected.
# Writers and readers import these names; a second spelling elsewhere is a drift.
TRIAL_LEDGER = SimpleNamespace(
    EVENT=_TRIAL_LEDGER_EVENT,
    ACTOR=SimpleNamespace(SHADOW="daemon-cycle-shadow", AA="daemon-cycle-aa"),
    # Payload keys readers rely on; an event absent here carries a free-form object.
    # anova / size_weighted = trial_design.DesignEffect fields; readers take the higher.
    # aa-start / aa-restart: fingerprint = the installed manifest's scoped path → sha256 map.
    PAYLOAD_KEYS={
        _TRIAL_LEDGER_EVENT.AA_SESSION_DESIGN_EFFECT: ("anova", "size_weighted"),
        _TRIAL_LEDGER_EVENT.AA_START: ("fingerprint", "started_at", "duration"),
        _TRIAL_LEDGER_EVENT.AA_RESTART: ("start_id", "reason", "fingerprint"),
        _TRIAL_LEDGER_EVENT.CANARY_UNBOUND_DELIVERY: (
            "agent",
            "spool",
            "line_offset",
            "salt_id",
            "delivered_hash",
        ),
    },
)


def _check_trial_ledger_values(event, actor, payload):
    """Refuse a row outside the declared sets, before any connection."""
    if event not in vars(TRIAL_LEDGER.EVENT).values():
        raise TrialLedgerValueUndeclared(
            f"op=write_trial_ledger_row refused event={event!r} — undeclared "
            "(TRIAL_LEDGER.EVENT), nothing written"
        )
    if actor not in vars(TRIAL_LEDGER.ACTOR).values():
        raise TrialLedgerValueUndeclared(
            f"op=write_trial_ledger_row refused actor={actor!r} — undeclared "
            "(TRIAL_LEDGER.ACTOR), nothing written"
        )
    keys = TRIAL_LEDGER.PAYLOAD_KEYS.get(event)
    if keys is not None and not (
        isinstance(payload, dict) and set(payload) == set(keys)
    ):
        raise TrialLedgerValueUndeclared(
            f"op=write_trial_ledger_row refused event={event!r} payload={payload!r} — keys "
            f"must be exactly {', '.join(keys)}, nothing written"
        )


_TRIAL_LEDGER_INSERT_SQL = """
    INSERT INTO core.autoagent_trial_ledger
        (trial_key, agent, learning_pattern_id, event, actor, payload, dedupe_key)
    VALUES (%s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (dedupe_key) DO NOTHING
"""


def write_trial_ledger_row(
    event,
    actor,
    payload,
    *,
    trial_key=None,
    agent=None,
    learning_pattern_id=None,
    dedupe_key=None,
):
    """INSERT one append-only ledger row → 1 when it landed, 0 when it did not.

    dedupe_key: a once-only event's identity — a taken key adds no row and raises
    nothing, the stored row stays; None = a repeatable event. A schema without the table
    (migrate-failed install) → named WARN on stderr, 0. Refuses (TrialLedgerValueUndeclared)
    before connecting on a value outside TRIAL_LEDGER; raises on any other PG fault.
    """
    _check_trial_ledger_values(event, actor, payload)
    row = (
        trial_key,
        agent,
        learning_pattern_id,
        event,
        actor,
        Jsonb(payload),
        dedupe_key,
    )
    try:
        with _connect() as conn:
            with conn.cursor() as cur:
                cur.execute(_TRIAL_LEDGER_INSERT_SQL, row)
                inserted = cur.rowcount
            conn.commit()
    except pg_errors.UndefinedTable:
        _warn_trial_ledger_absent(event, dedupe_key)
        return 0
    return inserted


def _warn_trial_ledger_absent(event, dedupe_key):
    sys.stderr.write(
        "[autoagent-daemon] op=write_trial_ledger_row WARN table=core.autoagent_trial_ledger "
        f"absent (event={event}, dedupe_key={dedupe_key}) — nothing recorded; "
        f"apply migration {MIGRATION.TRIAL_LEDGER}\n"
    )


# --- Failure observability -------------------------------------------------

def _record_hook_failure(hook_name, target_table, error_kind, payload_ref, retry_attempted):
    # Best-effort INSERT into core.hook_failures. ANY exception swallowed.
    try:
        with _connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO core.hook_failures "
                    "(failure_ts, hook_name, target_table, error_kind, payload_ref, retry_attempted) "
                    "VALUES (now(), %s, %s, %s, %s, %s)",
                    (hook_name, target_table, error_kind, payload_ref, retry_attempted),
                )
            conn.commit()
    except Exception:
        pass


# --- CLI dispatcher --------------------------------------------------------

OP_TABLE = {
    "write_wiki_note": (write_wiki_note, "wiki.notes"),
    "bump_wiki_dirty": (bump_wiki_dirty, "wiki.dirty_flag"),
    "clear_wiki_dirty": (clear_wiki_dirty, "wiki.dirty_flag"),
    "write_daemon_run": (write_daemon_run, "core.daemon_runs"),
    "compose_daemon_run_apply_status": (
        compose_daemon_run_apply_status,
        "core.daemon_runs",
    ),
    "write_daemon_run_payload": (write_daemon_run_payload, "core.daemon_run_payload"),
    "write_autoagent_proposal": (write_autoagent_proposal, "core.autoagent_proposals"),
    "write_autoagent_loop_event": (write_autoagent_loop_event, "core.autoagent_loop_events"),
    "write_autoagent_corpus_audit": (
        write_autoagent_corpus_audit,
        "core.autoagent_corpus_audits",
    ),
}


def _retry(func, args_dict, hook_name, target_table, payload_ref):
    last_exc = None
    retry_attempted = False
    for attempt in (1, 2):
        try:
            elapsed_ms = func(**args_dict)
            return elapsed_ms, attempt, None
        except CallerContractViolation as exc:
            return None, attempt, (exc, False)
        except Exception as exc:  # noqa: BLE001 — intentional broad catch
            last_exc = exc
            if attempt == 1:
                retry_attempted = True
                time.sleep(0.1)
    return None, 2, (last_exc, retry_attempted)


def main():
    start_ns = time.monotonic_ns()
    raw = sys.stdin.read()
    try:
        envelope = json.loads(raw)
        op = envelope["op"]
        args = envelope.get("args", {})
        payload_ref = envelope.get("payload_ref", "")
    except Exception as exc:
        sys.stderr.write(
            '[_pg_dual_write_daemon] envelope parse failed: %s\n'
            % str(exc).replace('"', "'")
        )
        sys.exit(2)

    if op not in OP_TABLE:
        sys.stderr.write(
            '[_pg_dual_write_daemon] unknown op: %s\n' % op.replace('"', "'")
        )
        sys.exit(3)

    func, target_table = OP_TABLE[op]
    # hook_name: prefer args.daemon_name when present (write_daemon_run/payload
    # carry it explicitly); fall back to op-string heuristic for wiki-only ops
    # (write_wiki_note / bump_wiki_dirty / clear_wiki_dirty).
    # "<name>-daemon": stored hook_failures label, kept as-is — names the cycle, not a launchd job
    daemon_arg = args.get("daemon_name") if isinstance(args, dict) else None
    if daemon_arg:
        hook_name = "%s-daemon" % daemon_arg
    elif "wiki" in op:
        hook_name = "wiki-daemon"
    else:
        hook_name = "autoagent-daemon"

    elapsed_ms, attempt, fail = _retry(func, args, hook_name, target_table, payload_ref)

    if fail is None:
        sys.stdout.write("%d\n" % elapsed_ms)
        if _COMPOSE_PROVENANCE is not None:
            # Trailer, never line 1 — callers parse the elapsed_ms token positionally.
            sys.stdout.write("provenance=%s\n" % _COMPOSE_PROVENANCE)
        sys.stderr.write(
            "[%s] op=%s elapsed_ms=%d pg_write=ok attempt=%d\n"
            % (hook_name, op, elapsed_ms, attempt)
        )
        sys.exit(0)

    last_exc, retry_attempted = fail
    if isinstance(last_exc, CallerContractViolation):
        # Named exit 6, not the pg_write=fail path: nothing was written and nothing failed
        # in PG, so a hook_failures row would misattribute a caller bug to the database.
        sys.stderr.write(
            "[%s] op=%s pg_write=refused %s\n" % (hook_name, op, last_exc)
        )
        sys.exit(6)

    error_kind = _classify_error(last_exc)
    error_class = type(last_exc).__name__
    error_msg = str(last_exc)[:200].replace('"', "'").replace("\n", " ")
    elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000

    sys.stderr.write(
        '{"hook":"%s","op":"%s","target_table":"%s","error_kind":"%s","error_class":"%s",'
        '"payload_ref":"%s","retry_attempted":%s,"elapsed_ms":%d,"message":"%s"}\n'
        % (
            hook_name,
            op,
            target_table,
            error_kind,
            error_class,
            payload_ref,
            "true" if retry_attempted else "false",
            elapsed_ms,
            error_msg,
        )
    )
    sys.stderr.write(
        "[%s] op=%s elapsed_ms=%d pg_write=fail error_kind=%s\n"
        % (hook_name, op, elapsed_ms, error_kind)
    )

    _record_hook_failure(hook_name, target_table, error_kind, payload_ref, retry_attempted)
    sys.exit(4)


if __name__ == "__main__":
    main()
