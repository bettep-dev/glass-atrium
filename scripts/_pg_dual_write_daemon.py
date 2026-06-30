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
#
# Retry/error/elapsed_ms convention:
#   * 1 retry with 100ms backoff before giving up (fail-loud-and-skip).
#   * On final failure: stderr-log structured JSON + best-effort
#     core.hook_failures INSERT (errors swallowed — never recurse).
#   * Unix-socket only via psycopg.connect("dbname=glass_atrium").
#     NEVER -h, -p, host=, 127.0.0.1, localhost.
#   * Exit 0 always when invoked as CLI — daemon must not block on PG failure.
#
# CLI contract (single-line JSON envelope on stdin):
#   {"op": "write_wiki_note",            "args": {"path": "...", "title": "...", ...}}
#   {"op": "bump_wiki_dirty",            "args": {}}
#   {"op": "write_daemon_run",           "args": {"daemon_name": "wiki", "run_date": "...", ...}}
#   {"op": "write_daemon_run_payload",   "args": {"daemon_name": "wiki", "run_date": "...", "payload": {...}}}
#   {"op": "write_autoagent_proposal",   "args": {"cycle_date": "...", "pattern_label": "...", "target_file": "...", ...}}
#   {"op": "write_autoagent_loop_event", "args": {"event_ts": "...", "agent": "...", "eval_result": "...", ...}}
#
# Stdout on success: elapsed_ms (single integer line).
# Stderr (always): structured op + elapsed_ms log line (parseable by daemon-reports).

import json
import sys
import time

# psycopg-absent must surface to an IMPORTER as a CATCHABLE ImportError so its
# `except Exception` degrades gracefully — a module-scope sys.exit() raises
# SystemExit (a BaseException that escapes that guard, silently exiting the
# importer mid-import and reporting a degraded run as false-clean). When run
# directly as the CLI (__name__ == "__main__"), psycopg-absence is self-handled
# with a clean exit 0 (no traceback): a subprocess CLI invocation owns its own
# graceful degradation, the import path owns re-raising for the importer.
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
    sys.exit(0)


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
                 patches_reject_count, notes
    Unknown kwargs are silently dropped (forward-compatible). NULLable columns
    omitted from kwargs default to NULL.
    """
    start_ns = time.monotonic_ns()
    cols = ["run_date", "daemon_name", "started_at", "ended_at", "status"]
    vals = [run_date, daemon_name, started_at, ended_at, status]
    allowed = {
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
            status = CASE
                       WHEN core.autoagent_proposals.status
                            IN ('applied', 'approved', 'rejected')
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
    "write_daemon_run_payload": (write_daemon_run_payload, "core.daemon_run_payload"),
    "write_autoagent_proposal": (write_autoagent_proposal, "core.autoagent_proposals"),
    "write_autoagent_loop_event": (write_autoagent_loop_event, "core.autoagent_loop_events"),
}


def _retry(func, args_dict, hook_name, target_table, payload_ref):
    last_exc = None
    retry_attempted = False
    for attempt in (1, 2):
        try:
            elapsed_ms = func(**args_dict)
            return elapsed_ms, attempt, None
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
        sys.exit(0)

    if op not in OP_TABLE:
        sys.stderr.write(
            '[_pg_dual_write_daemon] unknown op: %s\n' % op.replace('"', "'")
        )
        sys.exit(0)

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
        sys.stderr.write(
            "[%s] op=%s elapsed_ms=%d pg_write=ok attempt=%d\n"
            % (hook_name, op, elapsed_ms, attempt)
        )
        sys.exit(0)

    last_exc, retry_attempted = fail
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
    sys.exit(0)


if __name__ == "__main__":
    main()
