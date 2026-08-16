#!/usr/bin/env python3
# _pg_dual_write_daemon.py — Shared PG dual-write helper for the daemons
# (wiki + autoagent). Sister of ~/.claude/hooks/_pg_dual_write.py.
#
# Envelope = daemon-table-aware operations (op-routed):
#       - write_wiki_note            -> wiki.notes UPSERT keyed by path
#       - bump_wiki_dirty            -> wiki.dirty_flag id=1 UPDATE
#       - write_daemon_run           -> core.daemon_runs UPSERT (run_date, daemon_name)
#       - write_daemon_run_payload   -> core.daemon_run_payload UPSERT (FK 1:1)
#       - write_autoagent_proposal   -> core.autoagent_proposals UPSERT
#                                       key (cycle_date, pattern_label, target_file)
#       - write_autoagent_loop_event -> core.autoagent_loop_events UPSERT
#                                       key (event_ts, agent, eval_result)
#       - write_autoagent_corpus_audit -> core.autoagent_corpus_audits UPSERT
#                                       key (cycle_date)
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
#   6 = unsupported apply_status token — a caller contract violation the database
#       cannot store. Refused BEFORE connecting, so nothing was written and no
#       retry runs; a silent fall-through here would report apply health the
#       cycle never recorded.
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


class UnsupportedApplyStatus(ValueError):
    """apply_status outside APPLY_STATUS_TOKENS — a contract violation, not a PG fault.

    Non-retryable by construction: the token is wrong on every attempt, and _retry's
    backoff would only delay the named exit."""


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

# The migration that adds apply_status_provenance, named in the degradation notice so one
# stderr line tells an operator exactly what to apply — the same shape the driver's enum
# probe uses when a core."DaemonStatus" label is missing.
PROVENANCE_MIGRATION = "20260803000001_add_daemon_run_apply_status_provenance"


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
            % (daemon_name, run_date, PROVENANCE_MIGRATION)
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


def _coerce_classification(raw):
    """Return (classification_enum, approval_tier_enum) from daemon-emitted label.

    Unknown label -> ('reject', 'auto') (defensive — never raise; daemon must
    not block on a previously unseen classification keyword).
    """
    if not raw:
        return ("reject", "auto")
    return _CLASSIFICATION_TO_ENUM.get(str(raw), ("reject", "auto"))


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
    """
    start_ns = time.monotonic_ns()
    if indexed_at is None:
        # PG default is CURRENT_TIMESTAMP; pass NULL by omission of the column
        # rather than computing wall-clock here. Sentinel sticks for explicit
        # backfill timestamps (caller-supplied).
        pass

    cls_enum, tier_enum = _coerce_classification(classification)
    # Caller-provided approval_tier overrides the coerced one (only when valid)
    if approval_tier in ("auto", "llm", "user"):
        tier_enum = approval_tier
    if status not in ("pending", "approved", "rejected", "applied", "snoozed"):
        # A reject-classification row with an empty/invalid status MUST settle as
        # 'rejected', not 'pending' — else auto-reject proposals fossilize in the
        # pending queue.
        status = "rejected" if cls_enum == "reject" else "pending"

    sql = """
        INSERT INTO core.autoagent_proposals
            (cycle_date, pattern_label, target_file, target_agent,
             classification, rationale, haiku_status, approval_tier, status,
             proposed_diff, cost_guard_state, source_file, source_file_mtime,
             indexed_at,
             pre_verify_passed, pre_verify_status, pre_verify_rationale,
             pre_verify_axes,
             confidence_observed, project_key, promotion_tier)
        VALUES (%s, %s, %s, %s,
                %s::core."ProposalClassification", %s, %s,
                %s::core."ApprovalTier",
                %s::core."ProposalStatus",
                %s, %s, %s, %s,
                COALESCE(%s, CURRENT_TIMESTAMP),
                %s, %s, %s, %s,
                %s, %s, %s)
        ON CONFLICT (cycle_date, pattern_label, target_file) DO UPDATE SET
            target_agent = EXCLUDED.target_agent,
            classification = EXCLUDED.classification,
            rationale = EXCLUDED.rationale,
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
                       WHEN core.autoagent_proposals.status
                            IN ('applied', 'approved', 'rejected')
                            AND EXCLUDED.status
                                NOT IN ('applied', 'approved', 'rejected')
                       THEN core.autoagent_proposals.status
                       ELSE EXCLUDED.status
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
            promotion_tier = EXCLUDED.promotion_tier
        RETURNING id
    """
    # pre_verify_axes is JSONB. None / empty dict both pass through Jsonb() —
    # psycopg serializes {} as "{}" (valid JSON object), None as NULL.
    axes_param = Jsonb(pre_verify_axes) if pre_verify_axes is not None else None
    # Empty-string project_key/promotion_tier → NULL (DDL default).
    # confidence_observed=None → NULL (feature flag off / cold-start not stored).
    project_key_param = project_key or None
    promotion_tier_param = promotion_tier or None
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                sql,
                (
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
                ),
            )
            cur.fetchone()
        conn.commit()
    return (time.monotonic_ns() - start_ns) // 1_000_000


def write_autoagent_loop_event(
    event_ts,
    agent,
    eval_result,
    changes_added,
    changes_removed,
    rice=None,
):
    """UPSERT core.autoagent_loop_events on (event_ts, agent, eval_result).

    Returns elapsed_ms. The autoagent-loop.jsonl file is append-only, so the
    natural idempotency key is the dedup unique index defined in the schema
    (event_ts, agent, eval_result). On conflict we update changes_added /
    changes_removed / rice — covering the rare backfill rerun where the same
    line appears twice (e.g. from log rotation overlap).
    """
    start_ns = time.monotonic_ns()
    sql = """
        INSERT INTO core.autoagent_loop_events
            (event_ts, agent, rice, eval_result, changes_added, changes_removed)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (event_ts, agent, eval_result) DO UPDATE SET
            rice = EXCLUDED.rice,
            changes_added = EXCLUDED.changes_added,
            changes_removed = EXCLUDED.changes_removed
        RETURNING id
    """
    with _connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                sql,
                (
                    event_ts,
                    agent,
                    rice,
                    eval_result,
                    changes_added,
                    changes_removed,
                ),
            )
            cur.fetchone()
        conn.commit()
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
    """
    start_ns = time.monotonic_ns()
    sql = """
        INSERT INTO core.autoagent_corpus_audits
            (cycle_date, word_count, token_estimate, file_count,
             trend_alert, trend_delta, absolute_alert, seeded_threshold,
             compliance_rate, override_rate,
             gate_pass_count, gate_trip_count, gate_total_count)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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
            gate_total_count = EXCLUDED.gate_total_count
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
        except UnsupportedApplyStatus as exc:
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
    if isinstance(last_exc, UnsupportedApplyStatus):
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
