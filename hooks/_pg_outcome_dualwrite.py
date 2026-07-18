#!/usr/bin/env python3
# Outcome-record dual-write helper.
#
# Invoked from track-outcome.sh as the sole outcome-record sink. Per-outcome .md
# files are retired; PG core.outcomes (body_md column carries the full markdown
# body) is now the primary and ONLY write, so its failure MUST NOT lose data and
# MUST NOT crash the stop hook. The shell caller runs `... | python3 helper || true`, so it absorbs
# ANY exit code — the helper therefore reports its outcome via a NAMED exit code
# (0 ok · non-zero = a specific failure class, see EXIT_* below) WITHOUT disrupting
# the hook, and never silently swallows a DB-unreachable/write-failed case behind a
# fixed exit 0 (loud-fail per shared-self-improve-hygiene "Precondition Loud-Fail
# Principle"). One BEGIN/COMMIT covers outcomes + N
# correction_signals + an optional learning_log UPSERT, with outcomes RETURNING
# id bound into correction_signals.outcome_id for FK consistency. Uses
# autocommit=False for explicit transaction control.
#
# Param-name 3-layer mapping — frontmatter dict key == PG column == python INSERT
# named param, all identical ASCII strings; any drift means silent data loss.
# Every key maps identity except the sole rename 'timestamp' (frontmatter) →
# 'record_ts' (PG/python). Two telemetry columns carry richer semantics:
#   style_ref          — path | STYLE_REF_GREENFIELD literal | NULL
#                        (see ~/.claude/hooks/lib/style-ref-consts.sh).
#   style_ref_verified — boolean | NULL verdict from track-outcome.sh's
#                        SubagentStop Read-history cross-check (true = claimed
#                        path actually read · false = claimed but not read ·
#                        NULL = verification N/A). _norm_bool_or_null preserves
#                        NULL — it MUST NOT collapse to false (distinct from a
#                        failed verification).
#
# correction_signals dict keys: event_ts, task_type, stage1_matched,
# stage2_matched, final_detected, revision_count_delta. outcome_id is bound by
# THIS module — the caller MUST NOT pre-set it.
#
# Stdin contract (single-line JSON envelope):
#   {
#     "outcome": { ... see frontmatter mapping above ... },
#     "signals": [ { ... see correction_signals mapping ... }, ... ],
#     "learning_hint": null | {
#         "discovered_date": "YYYY-MM-DD",
#         "pattern_signature": "<text>",
#         "agent": "<varchar64>",
#         "frequency_delta": 1,
#     }
#   }
#
# Emits an elapsed_ms stderr line per write for latency aggregation. Exit code:
# 0 on success; a named non-zero code on failure (import / envelope / DB-unreachable
# / write-failed) paired with an explicit stderr diagnostic — the caller's `|| true`
# keeps the stop hook uncrashed while the failure stays observable (never a silent
# fixed exit 0).

import json
import sys
import time

# Named exit codes — loud-fail observability. A non-zero code is a VISIBLE
# process-level failure signal, NOT a hard error: track-outcome.sh runs the helper
# under `| python3 helper || true`, so the stop hook never crashes regardless of the
# code. Success stays 0 so the common path is unchanged.
EXIT_OK = 0
EXIT_IMPORT_ERR = 3       # psycopg driver unavailable — cannot reach the DB at all
EXIT_BAD_ENVELOPE = 4     # malformed stdin JSON envelope
EXIT_DB_UNREACHABLE = 5   # connect failed / timed out (connection_refused | timeout)
EXIT_WRITE_FAILED = 6     # connected but the write failed (constraint_violation | unknown)

# error_kind (from _classify_error) → named exit code. An unmapped kind defaults to
# EXIT_WRITE_FAILED (reached-the-DB-but-failed classification).
_ERROR_KIND_EXIT = {
    "connection_refused": EXIT_DB_UNREACHABLE,
    "timeout": EXIT_DB_UNREACHABLE,
    "constraint_violation": EXIT_WRITE_FAILED,
    "unknown": EXIT_WRITE_FAILED,
}

try:
    import psycopg
    from psycopg import errors as pg_errors
except ImportError as exc:
    sys.stderr.write(
        '{"hook":"_pg_outcome_dualwrite","error_kind":"import_error",'
        '"message":"%s"}\n' % str(exc).replace('"', "'")
    )
    sys.exit(EXIT_IMPORT_ERR)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _classify_error(exc):
    """Map a psycopg exception to a hook_failures.error_kind string."""
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


def _fmt_exc(exc):
    """Truncate + escape an exception message for a one-line structured stderr field."""
    return str(exc)[:200].replace('"', "'").replace("\n", " ")


def _record_hook_failure(error_kind, payload_ref, retry_attempted):
    """Best-effort secondary INSERT into core.hook_failures. Returns True when the
    failure row landed, False otherwise.

    The secondary write is best-effort (it must never raise into the caller) but it
    is NOT silent: when even this write cannot land — the fully-DB-unreachable case,
    where the primary write already failed for the same reason — the reason is
    emitted to stderr so the failure stays observable (loud-fail), instead of the
    former `except: pass` that swallowed it."""
    try:
        with psycopg.connect("dbname=glass_atrium", connect_timeout=1) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO core.hook_failures "
                    "(failure_ts, hook_name, target_table, error_kind, "
                    "payload_ref, retry_attempted) "
                    "VALUES (now(), %s, %s, %s, %s, %s)",
                    (
                        "outcome-record",
                        "core.outcomes",
                        error_kind,
                        payload_ref,
                        retry_attempted,
                    ),
                )
            conn.commit()
        return True
    except Exception as exc:  # noqa: BLE001 — best-effort secondary write, but NOT silent
        sys.stderr.write(
            '{"hook":"outcome-record","target_table":"core.hook_failures",'
            '"error_kind":"secondary_write_failed","payload_ref":"%s",'
            '"message":"%s"}\n'
            % (
                payload_ref,
                _fmt_exc(exc),
            )
        )
        return False


# ---------------------------------------------------------------------------
# Value normalization (frontmatter strings → PG types)
# ---------------------------------------------------------------------------

# Canonical 9-type TaskType set per core-outcome-record.md (code: bug-fix/feature/
# refactor · evidence: research/plan · non-code: review/diagnosis/doc/cleanup).
# _TASK_TYPE_MAP carries only legacy aliases with no canonical spelling of their
# own (e.g. "report" is not an enum member → doc).
_TASK_TYPE_MAP = {
    # "report" is a legacy doc-deliverable alias → canonical "doc" (NOT research).
    "report": "doc",
}
_TASK_TYPE_VALID = {
    "bug-fix",
    "feature",
    "refactor",
    "research",
    "plan",
    "review",
    "diagnosis",
    "doc",
    "cleanup",
}

# Agent-role → safe non-code default task_type, used only when an incoming
# task_type is unrecognized AND the agent name identifies a non-code role (per the
# Role → Allowed task_types table in core-outcome-record.md). A blind "feature"
# fallback would mislabel a verdict/document deliverable as a code change. Keys
# match a prefix of the lowercased agent name so versioned/suffixed ids resolve;
# code agents and unmatched agents fall through to the generic default below.
_AGENT_ROLE_DEFAULT_TASK_TYPE = {
    "glass-atrium-qa-code-reviewer": "review",
    "glass-atrium-qa-debugger": "diagnosis",
    "glass-atrium-sec-guard": "review",
    "glass-atrium-intel-reporter": "doc",
    "glass-atrium-intel-planner": "doc",
    "glass-atrium-wiki-curator": "doc",
    "glass-atrium-design-designer": "doc",
    "glass-atrium-meta-prompt-engineer": "doc",
}

# Role → Allowed task_types allowlist (LAYER-3 mis-classification guard). SINGLE SoT alignment
# with the core-outcome-record.md Role → Allowed task_types table and the track-outcome.sh
# role_task_type_allowed mirror. A 9-set-valid task_type is still OFF-ROLE when outside its
# agent's allowlist (e.g. intel-planner emitting "bug-fix") — _norm_task_type reclassifies such
# a value to the role default so the grader never runs a code check on a non-code deliverable.
# A role absent from this map (dev-* / unknown) has no constraining allowlist → any 9-set value
# is accepted (the DEV allowlist is broad). Keys prefix-match the lowercased agent name.
_AGENT_ROLE_ALLOWED_TASK_TYPES = {
    "glass-atrium-qa-code-reviewer": {"review"},
    "glass-atrium-qa-debugger": {"diagnosis"},
    "glass-atrium-sec-guard": {"review", "diagnosis"},
    "glass-atrium-intel-reporter": {"doc"},
    "glass-atrium-intel-planner": {"plan", "doc"},
    "glass-atrium-wiki-curator": {"doc"},
    "glass-atrium-design-designer": {"doc", "review"},
    "glass-atrium-meta-prompt-engineer": {"doc", "cleanup", "refactor"},
}

_RESULT_VALID = {"done", "done_with_concerns", "blocked", "needs_context", "fail"}
_CONFIDENCE_VALID = {"high", "medium", "low"}


def _norm_task_type(v, agent=None):
    """Normalize an incoming task_type to a valid 9-set member.

    Resolution order: exact 9-set match (then a Role → Allowed allowlist check —
    an off-role 9-set value is reclassified to the role default) → legacy alias map
    → role-aware default (when `agent` identifies a non-code role) → conservative
    generic "feature". The core."TaskType" CHECK rejects any out-of-set value, so
    every branch MUST return a 9-set member or the INSERT fails — never pass `v`
    through raw.
    """
    s = (v or "").strip()
    if s in _TASK_TYPE_VALID:
        # LAYER-3 guard: a 9-set-valid value is still off-role when outside the agent's
        # allowlist (e.g. intel-planner emitting "bug-fix"). Reclassify to the role default
        # so the grader never runs a code check on a non-code deliverable. A role with no
        # allowlist (dev-* / unknown) accepts any 9-set value unchanged.
        if not _role_task_type_allowed(agent, s):
            role_default = _role_default_task_type(agent)
            if role_default is not None:
                return role_default
        return s
    if s in _TASK_TYPE_MAP:
        return _TASK_TYPE_MAP[s]
    # Unrecognized: prefer the agent's role default so a non-code agent's
    # deliverable is not mislabeled as a code change ("feature").
    role_default = _role_default_task_type(agent)
    if role_default is not None:
        return role_default
    # Conservative generic — a code agent or an unidentifiable agent gets
    # "feature" (aligns with track-outcome.sh guess_task_type fallback).
    return "feature"


def _role_default_task_type(agent):
    """Return a non-code default task_type for a known non-code agent role, else
    None. Matches the agent name by prefix so a versioned/suffixed id resolves."""
    name = (agent or "").strip().lower()
    if not name:
        return None
    for role_prefix, default_type in _AGENT_ROLE_DEFAULT_TASK_TYPE.items():
        if name == role_prefix or name.startswith(role_prefix):
            return default_type
    return None


def _role_task_type_allowed(agent, task_type):
    """Is `task_type` within `agent`'s Role → Allowed allowlist? An agent role absent
    from _AGENT_ROLE_ALLOWED_TASK_TYPES (dev-* / unknown / unidentifiable) has no
    constraining allowlist → returns True (any 9-set value accepted). Matches the
    agent name by prefix so a versioned/suffixed id resolves."""
    name = (agent or "").strip().lower()
    if not name:
        return True
    for role_prefix, allowed in _AGENT_ROLE_ALLOWED_TASK_TYPES.items():
        if name == role_prefix or name.startswith(role_prefix):
            return task_type in allowed
    return True


def _norm_result(v):
    s = (v or "").strip()
    return s if s in _RESULT_VALID else "done"


def _norm_confidence(v):
    s = (v or "").strip()
    return s if s in _CONFIDENCE_VALID else None


def _norm_bool_or_null(v):
    """Frontmatter strings 'true'/'false'/'' → bool/None for nullable bool col."""
    if v is True or v is False:
        return v
    s = (v or "").strip().lower()
    if s == "true":
        return True
    if s == "false":
        return False
    return None


def _norm_int(v, default=0):
    """Empty/None/non-numeric → default."""
    try:
        if v is None or v == "":
            return default
        return int(v)
    except (ValueError, TypeError):
        return default


def _norm_int_or_null(v):
    try:
        if v is None or v == "":
            return None
        return int(v)
    except (ValueError, TypeError):
        return None


def _norm_text_or_null(v):
    s = (v or "").strip() if isinstance(v, str) else v
    if s == "" or s is None:
        return None
    return s


def _norm_text_array(v):
    """text[] column: accept list, comma-string, or empty → empty array."""
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return []
        return [t.strip() for t in s.split(",") if t.strip()]
    return []


def _norm_varchar(v, maxlen):
    s = (v or "").strip() if isinstance(v, str) else (str(v) if v is not None else "")
    return s[:maxlen]


# ---------------------------------------------------------------------------
# Core write — single transaction, multi-row INSERT + optional UPSERT
# ---------------------------------------------------------------------------

def _build_outcome_row(outcome):
    """Apply normalization. Returns dict ready for named-param INSERT."""
    agent = _norm_varchar(outcome.get("agent", ""), 64) or "unknown"
    return {
        "record_ts": outcome.get("timestamp") or outcome.get("record_ts"),
        "agent": agent,
        # Pass agent so an unrecognized task_type from a non-code agent resolves to
        # that role's default (e.g. doc/review/diagnosis) rather than "feature".
        "task_type": _norm_task_type(outcome.get("task_type"), agent),
        "result": _norm_result(outcome.get("result")),
        "confidence": _norm_confidence(outcome.get("confidence")),
        "metric_pass": _norm_bool_or_null(outcome.get("metric_pass")),
        "metric_type": _norm_varchar(outcome.get("metric_type", ""), 32) or None,
        "revision_count": _norm_int(outcome.get("revision_count"), 0),
        "evaluative_signal": _norm_int_or_null(outcome.get("evaluative_signal")),
        "directive_hint": _norm_text_or_null(outcome.get("directive_hint")),
        "lesson": _norm_text_or_null(outcome.get("lesson")),
        "concerns": _norm_text_array(outcome.get("concerns")),
        # qa_score — scalar text (shape cov=N,ins=N,instr=N,clar=N), QA-review only.
        # Bounded (LLM10) + "" → None. Not text[] like concerns: a single scalar field.
        "qa_score": _norm_varchar(outcome.get("qa_score", ""), 64) or None,
        "files_modified": _norm_text_array(outcome.get("files_modified")),
        "correlation_id": _norm_varchar(outcome.get("correlation_id", ""), 96) or None,
        "cid": _norm_varchar(outcome.get("cid", ""), 96) or None,
        "summary": (outcome.get("summary") or "").strip() or "(no summary)",
        "review_flag": _norm_bool_or_null(outcome.get("review_flag")) or False,
        "body_md": _norm_text_or_null(outcome.get("body_md")),
        # absent → None → SQL NULL (forward-compatible with older envelopes).
        "attribution_source": _norm_text_or_null(outcome.get("attribution_source")),
        # style_ref — path | STYLE_REF_GREENFIELD literal | None. _norm_text_or_null
        # preserves the literal verbatim. No mutation (no lowercase / no path
        # normalization): the cross-verify relies on an exact-string match against
        # tool_use Read log paths. Cross-layer SoT (bash/python/TS) is manually
        # synced via ~/.claude/hooks/lib/style-ref-consts.sh.
        "style_ref": _norm_text_or_null(outcome.get("style_ref")),
        # style_ref_verified — boolean verdict from the SubagentStop Read-history
        # cross-check. No `or False`: NULL/absent MUST stay NULL (verification N/A)
        # — distinct from false (claimed path not actually read).
        "style_ref_verified": _norm_bool_or_null(outcome.get("style_ref_verified")),
        # grader_verdict / downgrade_origin — deterministic-grader telemetry in
        # SEPARATE enum columns from metric_pass (advisory, never overwrites it).
        # _norm_text_or_null collapses "" → None so a blank never reaches the
        # ::enum cast; absent keys pass cleanly as NULL.
        "grader_verdict": _norm_text_or_null(outcome.get("grader_verdict")),
        "downgrade_origin": _norm_text_or_null(outcome.get("downgrade_origin")),
    }


def _build_signal_row(signal, outcome_id):
    return {
        "event_ts": signal.get("event_ts"),
        "task_type": _norm_varchar(signal.get("task_type", ""), 32) or "feature",
        "stage1_matched": bool(signal.get("stage1_matched", False)),
        "stage2_matched": bool(signal.get("stage2_matched", False)),
        "final_detected": bool(signal.get("final_detected", False)),
        "revision_count_delta": _norm_int(signal.get("revision_count_delta"), 0),
        "outcome_id": outcome_id,
    }


# All columns bind as named parameters (%(...)s) — no string concat, per the
# SQL-injection rule (core-security.md). grader_verdict / downgrade_origin are
# cast to their PG enums; a NULL param passes the ::enum cast cleanly
# (NULL::enum = NULL), so absent keys are safe.
_OUTCOMES_INSERT_SQL = """
INSERT INTO core.outcomes (
    record_ts, agent, task_type, result, confidence, metric_pass, metric_type,
    revision_count, evaluative_signal, directive_hint, lesson, concerns, qa_score,
    files_modified, correlation_id, cid, summary, review_flag, body_md,
    attribution_source, style_ref, style_ref_verified,
    grader_verdict, downgrade_origin
) VALUES (
    %(record_ts)s, %(agent)s, %(task_type)s::core."TaskType",
    %(result)s::core."OutcomeResult",
    %(confidence)s::core."Confidence",
    %(metric_pass)s, %(metric_type)s, %(revision_count)s,
    %(evaluative_signal)s, %(directive_hint)s, %(lesson)s, %(concerns)s, %(qa_score)s,
    %(files_modified)s, %(correlation_id)s, %(cid)s, %(summary)s,
    %(review_flag)s, %(body_md)s,
    %(attribution_source)s, %(style_ref)s, %(style_ref_verified)s,
    %(grader_verdict)s::core."GraderVerdict",
    %(downgrade_origin)s::core."DowngradeOrigin"
)
ON CONFLICT (record_ts, agent, task_type) DO UPDATE SET
    result = EXCLUDED.result,
    confidence = EXCLUDED.confidence,
    metric_pass = EXCLUDED.metric_pass,
    metric_type = EXCLUDED.metric_type,
    revision_count = EXCLUDED.revision_count,
    evaluative_signal = EXCLUDED.evaluative_signal,
    directive_hint = EXCLUDED.directive_hint,
    lesson = EXCLUDED.lesson,
    concerns = EXCLUDED.concerns,
    qa_score = EXCLUDED.qa_score,
    files_modified = EXCLUDED.files_modified,
    correlation_id = EXCLUDED.correlation_id,
    cid = EXCLUDED.cid,
    summary = EXCLUDED.summary,
    review_flag = EXCLUDED.review_flag,
    body_md = EXCLUDED.body_md,
    attribution_source = EXCLUDED.attribution_source,
    style_ref = EXCLUDED.style_ref,
    style_ref_verified = EXCLUDED.style_ref_verified,
    grader_verdict = EXCLUDED.grader_verdict,
    downgrade_origin = EXCLUDED.downgrade_origin
RETURNING id
"""

# Transitional backward-compat (expand-phase). qa_score is added to core.outcomes by
# migration 20260713000000_add_qa_score_to_outcomes, which runs at DEPLOY. Until that
# ALTER lands in a given DB the column is absent, and naming it in the INSERT raises
# UndefinedColumn — which would break EVERY outcome write during the pre-migration
# window (and forces a strict migration-before-code deploy order). The legacy variant
# below is DERIVED from the primary by stripping exactly the three qa_score fragments,
# so the primary stays the single hand-maintained SoT (no drift). Both are STATIC
# strings — the replaces carry no user data, so there is no injection surface. The
# runtime picks the variant via a cached column probe (_outcomes_insert_sql). Remove
# this shim once the migration is universally applied (contract phase).
_OUTCOMES_INSERT_SQL_NO_QA = (
    _OUTCOMES_INSERT_SQL
    .replace("lesson, concerns, qa_score,", "lesson, concerns,")
    .replace("%(lesson)s, %(concerns)s, %(qa_score)s,", "%(lesson)s, %(concerns)s,")
    .replace("    qa_score = EXCLUDED.qa_score,\n", "")
)
assert "qa_score" not in _OUTCOMES_INSERT_SQL_NO_QA, \
    "legacy INSERT derivation failed to strip qa_score"

# Per-process cache: None = unprobed, bool = column present/absent. The hook spawns one
# helper process per outcome, so this is probed at most once per outcome write.
_qa_score_col_present = None


def _outcomes_insert_sql(cur):
    """Outcomes INSERT SQL matching the LIVE schema: the qa_score variant when the
    column exists, else the pre-migration legacy form. The column probe is cached
    per process and runs inside the caller's open transaction (read-only catalog
    lookup, no lock)."""
    global _qa_score_col_present
    if _qa_score_col_present is None:
        cur.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema = 'core' AND table_name = 'outcomes' "
            "AND column_name = 'qa_score'"
        )
        _qa_score_col_present = cur.fetchone() is not None
    return _OUTCOMES_INSERT_SQL if _qa_score_col_present else _OUTCOMES_INSERT_SQL_NO_QA


_SIGNALS_INSERT_SQL = """
INSERT INTO core.correction_signals (
    event_ts, task_type, stage1_matched, stage2_matched, final_detected,
    revision_count_delta, outcome_id
) VALUES (
    %(event_ts)s, %(task_type)s, %(stage1_matched)s, %(stage2_matched)s,
    %(final_detected)s, %(revision_count_delta)s, %(outcome_id)s
)
ON CONFLICT (event_ts, task_type, outcome_id) DO NOTHING
"""

_LEARNING_LOG_UPSERT_SQL = """
INSERT INTO core.learning_log (
    discovered_date, pattern_signature, frequency, agent, status,
    approval_tier, last_updated
) VALUES (
    %(discovered_date)s, %(pattern_signature)s, %(frequency)s, %(agent)s,
    'identified'::core."LearningStatus",
    'auto'::core."ApprovalTier",
    now()
)
ON CONFLICT (pattern_signature) DO UPDATE SET
    frequency = core.learning_log.frequency + EXCLUDED.frequency,
    last_updated = now()
"""


def _do_transaction(envelope, attempt):
    """Run single BEGIN/COMMIT covering outcomes + signals + learning_hint.
    Returns (success: bool, outcome_id: int|None, exc: Exception|None)."""
    outcome_row = _build_outcome_row(envelope.get("outcome", {}))
    signals_in = envelope.get("signals", []) or []
    learning_hint = envelope.get("learning_hint")

    try:
        with psycopg.connect(
            "dbname=glass_atrium", connect_timeout=1, autocommit=False
        ) as conn:
            with conn.cursor() as cur:
                # --- outcomes UPSERT with RETURNING id ---
                # Schema-adaptive: the qa_score variant once the migration has landed,
                # else the pre-migration legacy form (backward-compat, see above).
                cur.execute(_outcomes_insert_sql(cur), outcome_row)
                row = cur.fetchone()
                if row is None:
                    raise RuntimeError("outcomes UPSERT returned no id")
                outcome_id = int(row[0])

                # --- correction_signals (N rows, FK to outcome_id) ---
                for signal in signals_in:
                    sig_row = _build_signal_row(signal, outcome_id)
                    cur.execute(_SIGNALS_INSERT_SQL, sig_row)

                # --- learning_log UPSERT (frequency increment) ---
                if learning_hint:
                    ll_row = {
                        "discovered_date": learning_hint.get("discovered_date"),
                        "pattern_signature": learning_hint.get("pattern_signature"),
                        "frequency": _norm_int(
                            learning_hint.get("frequency_delta"), 1
                        ),
                        "agent": _norm_varchar(
                            learning_hint.get("agent", ""), 64
                        ) or None,
                    }
                    if ll_row["pattern_signature"] and ll_row["discovered_date"]:
                        cur.execute(_LEARNING_LOG_UPSERT_SQL, ll_row)

            conn.commit()
            return (True, outcome_id, None)
    except Exception as exc:  # noqa: BLE001 — caller decides retry vs fail
        return (False, None, exc)


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------

def main():
    start_ns = time.monotonic_ns()
    raw = sys.stdin.read()

    try:
        envelope = json.loads(raw)
    except Exception as exc:
        sys.stderr.write(
            "[outcome-record] envelope parse failed: %s\n"
            % str(exc).replace('"', "'")
        )
        sys.exit(EXIT_BAD_ENVELOPE)

    payload_ref = (
        envelope.get("outcome", {}).get("correlation_id")
        or envelope.get("outcome", {}).get("cid")
        or envelope.get("outcome", {}).get("agent", "unknown")
    )[:96]

    last_exc = None
    retry_attempted = False
    for attempt in (1, 2):
        ok, outcome_id, exc = _do_transaction(envelope, attempt)
        if ok:
            elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000
            sys.stderr.write(
                "[outcome-record] elapsed_ms=%d pg_insert=ok attempt=%d "
                "outcome_id=%d signals=%d\n"
                % (
                    elapsed_ms,
                    attempt,
                    outcome_id,
                    len(envelope.get("signals", []) or []),
                )
            )
            sys.exit(EXIT_OK)
        last_exc = exc
        if attempt == 1:
            retry_attempted = True
            time.sleep(0.1)

    # Both attempts failed — LOUD-FAIL: emit a structured stderr marker, record a
    # secondary hook_failures row if the table is reachable, and exit a NAMED code
    # (never a silent fixed exit 0). The caller's `|| true` absorbs the code, so the
    # stop hook is not disrupted while the failure stays observable.
    error_kind = _classify_error(last_exc)
    error_class = type(last_exc).__name__
    error_msg = _fmt_exc(last_exc)
    elapsed_ms = (time.monotonic_ns() - start_ns) // 1_000_000

    sys.stderr.write(
        '{"hook":"outcome-record","target_table":"core.outcomes",'
        '"error_kind":"%s","error_class":"%s","payload_ref":"%s",'
        '"retry_attempted":%s,"elapsed_ms":%d,"message":"%s"}\n'
        % (
            error_kind,
            error_class,
            payload_ref,
            "true" if retry_attempted else "false",
            elapsed_ms,
            error_msg,
        )
    )

    recorded = _record_hook_failure(error_kind, payload_ref, retry_attempted)
    exit_code = _ERROR_KIND_EXIT.get(error_kind, EXIT_WRITE_FAILED)

    sys.stderr.write(
        "[outcome-record] elapsed_ms=%d pg_insert=fail error_kind=%s "
        "hook_failure_recorded=%s exit=%d\n"
        % (elapsed_ms, error_kind, "true" if recorded else "false", exit_code)
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
