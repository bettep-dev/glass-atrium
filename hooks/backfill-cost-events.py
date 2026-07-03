#!/usr/bin/env python3
"""Backfill core.cost_events from session transcripts (token-collection fix).

CID 2026-06-05T1734_token-collect_b2c3 — Phase 4 (backfill).

WHY this exists
---------------
Legacy cost_events rows captured only ~2.64% of true session tokens (measured on
sample session 5dada8e1: 16,036,166 stored vs 607,501,771 true). Three root
causes (see migration 20260605173400 + cost-tracker.sh header):

  RC1 — the hook treated EVERY type=="user" record as a turn boundary, but Claude
        Code stores tool_result records as type=="user" too (message.content is a
        LIST carrying a {type:"tool_result"} block). A REAL user boundary has NO
        tool_result block. The old backward walk halted at the first tool_result,
        keeping only the last assistant block of a multi-tool turn.
  RC2 — the old time-based dedup key (session_id, event_date, event_time) never
        collided across Stop multi-fires → every fire INSERTed. Fixed by the
        stable (session_id, dedup_key) UPSERT arbiter (migration Phase 1).
  RC3 — subagent (Task/workflow) tokens live in SEPARATE files under
        <session_dir>/subagents/**/agent-*.jsonl (flat + nested workflows/). The
        hook never opened them. A RECURSIVE glob is mandatory.

This script re-derives EVERY past session from its transcript (main turns +
recursive subagent files) using the SAME aggregation logic as the fixed
cost-tracker.sh, and UPSERTs the corrected rows over the legacy truncated /
synthetic-placeholder rows. The (session_id, dedup_key) arbiter means a re-run is
idempotent (DO UPDATE refreshes in place) and the re-derived REAL uuids/agent-ids
never collide with the migration's 'legacy:' placeholder keys.

LOGIC FIDELITY — this module reproduces cost-tracker.sh's is_real_user /
accumulate_usage / subagent-scan semantics VERBATIM. The hook embeds that logic
inline in a bash heredoc (not importable), so it is mirrored here. Any change to
one MUST be mirrored in the other (cross-ref both file headers). Pricing is NOT
mirrored anymore: both consumers import the shared pricing_loader over the
pricing.json SoT (CID 2026-07-02T1055_pricing-sot_e7b2), so a rate change is a
single-file edit — the former PRICING lockstep contract is retired.

ORDERING DEPENDENCY (hard)
--------------------------
Migration 20260605173400_cost_events_stable_dedup_key MUST be applied FIRST — the
`kind` + `dedup_key` columns and the cost_events_session_dedup_key unique index
are the UPSERT arbiter. Running this against a pre-migration schema raises (no
such column / no unique-or-exclusion constraint matching ON CONFLICT) and the
batch aborts loudly (no silent partial write).

USAGE
-----
  # default DRY-RUN (no writes) over ALL sessions — prints per-session before/after
  python3 backfill-cost-events.py

  # dry-run a single session (validation): expect before=16.0M -> after=607.5M
  python3 backfill-cost-events.py --dry-run --session 5dada8e1-12a7-4c81-b068-ee5be5f6ffae

  # APPLY (writes) — only after the migration is applied + dry-run reviewed
  python3 backfill-cost-events.py --apply

  # REPRICE (writes) — recompute cost_usd from the STORED token columns for
  # rows whose model is_known in the pricing SoT (pricing.json);
  # transcript-independent, so it repairs mispriced rows whose source
  # transcripts were deleted (--apply cannot reach those). Take a cost_usd
  # backup table first.
  python3 backfill-cost-events.py --reprice

Security: psycopg over the Unix socket only (`psycopg.connect("dbname=glass_atrium")`),
parameterized VALUES, identifiers from the static schema map — never psql -h, never
host=/127.0.0.1/localhost (Const-16). Forward-only writes; no DELETE of legacy
placeholders here (optional separate cleanup — see migration note).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

# Shared pricing loader (single SoT: hooks/pricing.json) — sibling lib/ dir.
# The sys.path seam must precede the import, hence the E402 placement.
sys.path.insert(0, str(Path(__file__).parent / "lib"))
import pricing_loader  # noqa: E402

# Batch remote posture: deterministic network-free backfill by DEFAULT — unknown
# rows resolve family_latest/fallback quietly instead of hanging on a remote
# fetch. setdefault keeps the operator opt-in (PRICING_REMOTE_DISABLE=0
# re-enables the remote step, capped at ONE timeout by the loader's per-process
# failed-fetch memo).
os.environ.setdefault("PRICING_REMOTE_DISABLE", "1")

PROJECTS_ROOT = Path(os.path.expanduser("~/.claude/projects"))
COMMIT_BATCH = 500  # rows per DB transaction commit (apply mode)


# --------------------------------------------------------------------------- #
#  Aggregation primitives — is_real_user / accumulate_usage / safe_int are     #
#  VERBATIM mirrors of cost-tracker.sh; calc_cost delegates to the shared      #
#  pricing_loader (no mirror).                                                 #
# --------------------------------------------------------------------------- #
def calc_cost(it, ot, cr, cc, model_key, event_date=None):
    """USD cost from the per-MTok rate resolved by pricing_loader.rate_for,
    keyed on the row's OWN event_date — historically faithful repricing (the
    live hook keys on its effective "today" instead). Windowed tiers (e.g. the
    sonnet-5 intro rate through 2026-08-31) are selected inside the loader by
    that date. event_date accepts an ISO str or datetime.date; absent selects
    the base (standard) rate row via pricing_loader.BASE_RATE — never the live
    clock (a malformed date degrades to the same base row inside the loader).
    Zero-cost allowlist mirrors the hook's calc_cost: "<synthetic>" (harness
    marker) and empty/None (no-LLM turn / usage-less subagent file) are
    legitimate zero-cost events whose rows verifiably carry 0 tokens — they
    return a clean $0 without walking the resolution chain.
    Batch-quiet: the loader emits no per-model advisory and neither does the
    backfill (surfacing is the reprice is_known guard); an unknown model still
    ALWAYS prices via the loader's overlay/family_latest/fallback chain (remote
    disabled by default — see the PRICING_REMOTE_DISABLE setdefault above)."""
    if not model_key or model_key == "<synthetic>":
        return 0.0
    eff = event_date if event_date is not None else pricing_loader.BASE_RATE
    record = pricing_loader.rate_for(model_key, effective_date=eff)
    return pricing_loader.cost_usd(record["rate"], it, ot, cr, cc)


def safe_int(value):
    """int(value) iff int-like; 0 otherwise. bool excluded (it is an int subclass).
    Mirrors the hook's null/missing → 0 type-safety guard."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return 0


def is_real_user(record):
    """A REAL user turn boundary: type=="user" AND message.content has NO
    tool_result block. tool_result records are ALSO type=="user" (LIST content
    with {type:"tool_result"}) and are NOT boundaries. Discriminator = PRESENCE of
    a tool_result block, NOT content being a string (the string-only rule misses
    interrupt/slash/Continue boundaries). VERBATIM mirror of the hook."""
    if record.get("type") != "user":
        return False
    msg = record.get("message")
    if not isinstance(msg, dict):
        return False
    content = msg.get("content")
    if isinstance(content, str):
        return True
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                return False
        return True
    return False


def accumulate_usage(record, seen_ids, acc):
    """Fold one assistant record with usage into
    acc=[in,out,cr,cc,count,first_model,first_stop_reason,distinct_models(set)]
    using msg.id dedup against seen_ids. Returns True if the record was an
    assistant-with-usage record (counted or already-seen). The transcript replays
    the same assistant message across tool_use round-trips with IDENTICAL usage —
    msg.id dedup prevents 2-5x over-counting. VERBATIM mirror of the hook."""
    if record.get("type") != "assistant":
        return False
    msg = record.get("message")
    if not isinstance(msg, dict):
        return False
    if msg.get("role") != "assistant":
        return False
    usage = msg.get("usage")
    if not isinstance(usage, dict):
        return False
    msg_id = msg.get("id")
    if msg_id and msg_id in seen_ids:
        return True
    if msg_id:
        seen_ids.add(msg_id)
    acc[0] += safe_int(usage.get("input_tokens"))
    acc[1] += safe_int(usage.get("output_tokens"))
    acc[2] += safe_int(usage.get("cache_read_input_tokens"))
    acc[3] += safe_int(usage.get("cache_creation_input_tokens"))
    acc[4] += 1
    model = msg.get("model")
    if model:
        if acc[5] is None:
            acc[5] = model
        acc[7].add(model)
    sr = msg.get("stop_reason")
    if sr and acc[6] is None:
        acc[6] = sr
    return True


# --------------------------------------------------------------------------- #
#  Per-session re-derivation                                                  #
# --------------------------------------------------------------------------- #
def _record_ts(record):
    """Best-effort (event_date, event_time) for a row from a record's `timestamp`
    (ISO 8601, e.g. "2026-06-04T20:32:11.123Z"). cost_events requires NOT-NULL
    event_date/event_time; the live hook uses the Stop wall-clock, which the
    backfill cannot reconstruct, so we use the record's own timestamp (the closest
    faithful proxy). Returns (date_str, time_str) or (None, None) on a miss."""
    ts = record.get("timestamp")
    if not isinstance(ts, str) or "T" not in ts:
        return None, None
    date_part, _, time_part = ts.partition("T")
    # Strip a trailing Z / timezone / fractional seconds → HH:MM:SS.
    time_part = time_part.replace("Z", "")
    for sep in ("+", "-", "."):
        if sep in time_part:
            time_part = time_part.split(sep, 1)[0]
    if len(time_part) >= 8:
        time_part = time_part[:8]
    if len(date_part) != 10 or len(time_part) != 8:
        return None, None
    return date_part, time_part


def derive_session_rows(main_jsonl: Path):
    """Re-derive ALL cost_events rows for one session from its transcript.

    Returns a list of row dicts (the same shape _pg_dual_write.py consumes for
    core.cost_events), one per turn + one per subagent file. Forward-segments the
    transcript at every is_real_user boundary so the full session is covered
    (the live hook only does the CURRENT turn per Stop; the union of all its fires
    equals this full segmentation).

    Turn row: kind='turn', dedup_key = the boundary record's top-level `uuid`,
              num_turns = assistant-with-usage count, stop_reason = first seen.
    Subagent row: kind='subagent', dedup_key = agent file id, stop_reason NULL,
              num_turns 0 (no turn-stats pollution).
    """
    session_id = main_jsonl.stem  # filename minus ".jsonl"
    rows: list[dict] = []

    # ---- MAIN: forward-segment into turns ---------------------------------- #
    try:
        with open(main_jsonl, "r", encoding="utf-8", errors="replace") as fh:
            records = []
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except (ValueError, json.JSONDecodeError):
                    continue
    except OSError as exc:
        sys.stderr.write(f"[backfill] main read failed {session_id}: {exc}\n")
        return rows

    # Walk forward; open a new turn at each boundary, accumulating assistant usage
    # until the next boundary (or EOF). A turn keyed by its boundary uuid mirrors
    # the hook's per-Stop dedup_key exactly. Records before the first boundary
    # (session preamble) are folded into a synthetic leading turn so no usage is
    # dropped.
    cur_uuid = None
    cur_date = None
    cur_time = None
    acc = [0, 0, 0, 0, 0, None, None, set()]
    seen = set()
    have_turn = False

    def _flush_turn():
        if not have_turn:
            return
        key = cur_uuid or "turnsynthetic:%s@%sT%s" % (
            session_id,
            cur_date or "0000-00-00",
            cur_time or "00:00:00",
        )
        cost = calc_cost(acc[0], acc[1], acc[2], acc[3], acc[5], cur_date) if acc[4] else 0.0
        rows.append(
            {
                "event_date": cur_date or "1970-01-01",
                "event_time": cur_time or "00:00:00",
                "session_id": session_id,
                "kind": "turn",
                "dedup_key": key,
                "input_tokens": acc[0],
                "output_tokens": acc[1],
                "cache_read_tokens": acc[2],
                "cache_creation_tokens": acc[3],
                "cost_usd": cost,
                "duration_ms": 0,
                "num_turns": acc[4],
                "stop_reason": acc[6] or "no_assistant_in_turn",
                "model": acc[5],
                "parse_error": False,
                "raw_input": None,
            }
        )

    for record in records:
        if is_real_user(record):
            # Close the previous turn, open a new one keyed by this boundary uuid.
            _flush_turn()
            cur_uuid = record.get("uuid")
            cur_date, cur_time = _record_ts(record)
            acc = [0, 0, 0, 0, 0, None, None, set()]
            seen = set()
            have_turn = True
        else:
            if not have_turn:
                # Pre-boundary preamble → open a synthetic leading turn so its
                # usage is not dropped.
                cur_uuid = None
                cur_date, cur_time = _record_ts(record)
                have_turn = True
            counted = accumulate_usage(record, seen, acc)
            if counted and (cur_date is None):
                # Backfill the timestamp from the first assistant record if the
                # boundary record lacked one.
                cur_date, cur_time = _record_ts(record)
    _flush_turn()

    # ---- SUBAGENTS: recursive scan ---------------------------------------- #
    # Session dir is the transcript path minus ".jsonl" (a sibling). Recursive
    # glob over subagents/**/agent-*.jsonl covers flat (classic Task) AND nested
    # (workflows/wf_*) agents; the name filter excludes journal.jsonl. One row per
    # file keyed by the agent file id. Backfill has no mtime cache (a full re-scan
    # is correct + the run is one-shot).
    session_dir = main_jsonl.with_suffix("")  # drop ".jsonl"
    sub_root = session_dir / "subagents"
    if sub_root.is_dir():
        agent_files = glob.glob(
            os.path.join(str(sub_root), "**", "agent-*.jsonl"), recursive=True
        )
        for fpath in sorted(agent_files):
            bn = os.path.basename(fpath)
            agent_id = bn[len("agent-") : -len(".jsonl")]
            if not agent_id:
                continue
            a = [0, 0, 0, 0, 0, None, None, set()]
            aseen = set()
            a_date = a_time = None
            try:
                with open(fpath, "r", encoding="utf-8", errors="replace") as afh:
                    for aline in afh:
                        aline = aline.strip()
                        if not aline:
                            continue
                        try:
                            arecord = json.loads(aline)
                        except (ValueError, json.JSONDecodeError):
                            continue
                        if a_date is None:
                            d, t = _record_ts(arecord)
                            if d:
                                a_date, a_time = d, t
                        accumulate_usage(arecord, aseen, a)
            except OSError as exc:
                sys.stderr.write(
                    f"[backfill] subagent read failed (skipped) {agent_id}: {exc}\n"
                )
                continue
            rows.append(
                {
                    "event_date": a_date or "1970-01-01",
                    "event_time": a_time or "00:00:00",
                    "session_id": session_id,
                    "kind": "subagent",
                    "dedup_key": agent_id,
                    "input_tokens": a[0],
                    "output_tokens": a[1],
                    "cache_read_tokens": a[2],
                    "cache_creation_tokens": a[3],
                    "cost_usd": calc_cost(a[0], a[1], a[2], a[3], a[5], a_date),
                    "duration_ms": 0,
                    "num_turns": 0,
                    "stop_reason": None,
                    "model": a[5],
                    "parse_error": False,
                    "raw_input": None,
                }
            )

    return rows


def _session_totals(rows):
    """Sum (input+output+cache_read+cache_creation) over rows for a one-line diff."""
    return sum(
        r["input_tokens"]
        + r["output_tokens"]
        + r["cache_read_tokens"]
        + r["cache_creation_tokens"]
        for r in rows
    )


# --------------------------------------------------------------------------- #
#  DB access (apply mode only)                                                #
# --------------------------------------------------------------------------- #
_COST_COLUMNS = (
    "event_date",
    "event_time",
    "session_id",
    "kind",
    "dedup_key",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "cost_usd",
    "duration_ms",
    "num_turns",
    "stop_reason",
    "model",
    "parse_error",
    "raw_input",
)

# UPSERT mirrors _pg_dual_write.py's cost_events policy: arbiter
# (session_id, dedup_key), overwrite the re-derived payload (NOT the identity
# columns). Kept in lockstep with _UPSERT_POLICY["core.cost_events"].
_UPSERT_SET_COLUMNS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "cost_usd",
    "duration_ms",
    "num_turns",
    "stop_reason",
    "model",
    "parse_error",
    "raw_input",
)


def _build_upsert_sql():
    col_list = ", ".join(_COST_COLUMNS)
    placeholders = ", ".join(["%s"] * len(_COST_COLUMNS))
    set_list = ", ".join(f"{c} = EXCLUDED.{c}" for c in _UPSERT_SET_COLUMNS)
    return (
        f"INSERT INTO core.cost_events ({col_list}) VALUES ({placeholders}) "
        f"ON CONFLICT (session_id, dedup_key) DO UPDATE SET {set_list}"
    )


def reprice_stored_rows():
    """Recompute cost_usd from the STORED token columns for every row whose
    model is_known in the pricing SoT (pricing_loader.is_known — SoT membership
    after normalize_model_key). Transcript-independent — repairs mispriced rows
    whose source transcripts were deleted (--apply re-derivation cannot reach
    those). Rows whose model is NOT known (NULL / '<synthetic>' / a genuinely
    unknown id) are left untouched: without a SoT rate a recompute would only
    re-bake a fallback/family guess into history.
    Idempotent. Returns (scanned, repriced, sum_old, sum_new) over the repriced
    rows."""
    try:
        import psycopg
    except ImportError as exc:
        sys.stderr.write(f"[backfill] psycopg not installed: {exc}\n")
        raise

    scanned = repriced = 0
    sum_old = sum_new = 0.0
    with psycopg.connect(
        "dbname=glass_atrium", connect_timeout=2, options="-c statement_timeout=60000"
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, input_tokens, output_tokens, cache_read_tokens, "
                "cache_creation_tokens, model, event_date, cost_usd "
                "FROM core.cost_events "
                "WHERE parse_error = false AND model IS NOT NULL"
            )
            rows = cur.fetchall()
            pending = 0
            for row_id, it, ot, cr, cc, model, event_date, old_cost in rows:
                scanned += 1
                if not pricing_loader.is_known(model):
                    continue
                # cost_usd is numeric(12,6) — compare at storage resolution or
                # every sub-micro-dollar rounding re-flags as a change forever.
                new_cost = round(calc_cost(it, ot, cr, cc, model, event_date), 6)
                old_cost = float(old_cost)
                if abs(old_cost - new_cost) < 1e-9:
                    continue
                cur.execute(
                    "UPDATE core.cost_events SET cost_usd = %s WHERE id = %s",
                    (new_cost, row_id),
                )
                repriced += 1
                sum_old += old_cost
                sum_new += new_cost
                pending += 1
                if pending >= COMMIT_BATCH:
                    conn.commit()
                    pending = 0
            conn.commit()
    return scanned, repriced, sum_old, sum_new


def _current_stored_totals(cur, session_ids):
    """Return {session_id: stored_token_total} for the given sessions (before
    snapshot). Bounded SELECT — parameterized IN list."""
    if not session_ids:
        return {}
    placeholders = ", ".join(["%s"] * len(session_ids))
    cur.execute(
        "SELECT session_id, "
        "COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) "
        "FROM core.cost_events WHERE session_id IN (%s) GROUP BY session_id"
        % placeholders,
        list(session_ids),
    )
    return {sid: int(total or 0) for sid, total in cur.fetchall()}


def apply_rows(per_session_rows):
    """UPSERT all re-derived rows. per_session_rows: {session_id: [row, ...]}.
    Returns {session_id: (before_total, after_total)}. Batches commits every
    COMMIT_BATCH rows; one connection for the whole run."""
    try:
        import psycopg
    except ImportError as exc:
        sys.stderr.write(f"[backfill] psycopg not installed: {exc}\n")
        raise

    sql = _build_upsert_sql()
    session_ids = list(per_session_rows.keys())
    diffs: dict[str, tuple[int, int]] = {}

    # Unix-socket only (Const-16). A generous statement_timeout for the batch write.
    with psycopg.connect(
        "dbname=glass_atrium", connect_timeout=2, options="-c statement_timeout=60000"
    ) as conn:
        with conn.cursor() as cur:
            before = _current_stored_totals(cur, session_ids)
            pending = 0
            for sid, rows in per_session_rows.items():
                for row in rows:
                    cur.execute(sql, [row[c] for c in _COST_COLUMNS])
                    pending += 1
                    if pending >= COMMIT_BATCH:
                        conn.commit()
                        pending = 0
            conn.commit()
            after = _current_stored_totals(cur, session_ids)
    for sid in session_ids:
        diffs[sid] = (before.get(sid, 0), after.get(sid, 0))
    return diffs


# --------------------------------------------------------------------------- #
#  Session enumeration                                                         #
# --------------------------------------------------------------------------- #
def enumerate_sessions(session_filter=None):
    """Yield main-transcript Path objects under ~/.claude/projects/*/<session>.jsonl.

    A session id can appear under multiple project dirs (same id, different cwd);
    each main .jsonl is its own transcript and is processed independently — the
    (session_id, dedup_key) UPSERT makes a same-id second transcript merge cleanly
    (distinct uuids → distinct rows; a shared uuid → idempotent refresh)."""
    if not PROJECTS_ROOT.is_dir():
        sys.stderr.write(f"[backfill] projects root missing: {PROJECTS_ROOT}\n")
        return
    pattern = f"{session_filter}.jsonl" if session_filter else "*.jsonl"
    for project_dir in sorted(PROJECTS_ROOT.iterdir()):
        if not project_dir.is_dir():
            continue
        for main_jsonl in sorted(project_dir.glob(pattern)):
            if main_jsonl.is_file():
                yield main_jsonl


def _fmt(n):
    return f"{n:,}"


def main():
    parser = argparse.ArgumentParser(
        description="Backfill core.cost_events from session transcripts."
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="(default) re-derive + print per-session before/after totals; NO writes",
    )
    mode.add_argument(
        "--apply",
        action="store_true",
        help="UPSERT the re-derived rows into core.cost_events (requires the migration)",
    )
    mode.add_argument(
        "--reprice",
        action="store_true",
        help="recompute cost_usd from STORED token columns for rows whose model "
        "is_known in the pricing SoT (transcript-independent; take a cost backup first)",
    )
    parser.add_argument(
        "--session",
        default=None,
        help="limit to a single session id (transcript basename without .jsonl)",
    )
    args = parser.parse_args()
    apply_mode = bool(args.apply)  # default = dry-run when neither flag is set

    if args.reprice:
        if args.session:
            sys.stderr.write("[backfill] --reprice is global; --session not supported\n")
            return 1
        try:
            scanned, repriced, sum_old, sum_new = reprice_stored_rows()
        except Exception as exc:  # noqa: BLE001 — surface the failure loudly, do not swallow
            sys.stderr.write(f"[backfill] REPRICE FAILED: {exc}\n")
            return 2
        print("=== cost_events reprice [STORED TOKENS] ===")
        print(
            f"rows scanned: {scanned}  repriced: {repriced}  "
            f"cost ${sum_old:,.2f} -> ${sum_new:,.2f}"
        )
        return 0

    # Aggregate rows per (session_id) across ALL its transcripts so the
    # before/after diff and the UPSERT batch see the full session.
    per_session_rows: dict[str, list[dict]] = defaultdict(list)
    transcript_count = 0
    for main_jsonl in enumerate_sessions(args.session):
        transcript_count += 1
        rows = derive_session_rows(main_jsonl)
        per_session_rows[main_jsonl.stem].extend(rows)

    if transcript_count == 0:
        sys.stderr.write("[backfill] no transcripts matched — nothing to do\n")
        return 1

    mode_label = "APPLY" if apply_mode else "DRY-RUN"
    print(f"=== cost_events backfill [{mode_label}] ===")
    print(f"transcripts scanned: {transcript_count}  sessions: {len(per_session_rows)}")

    derived_total = 0
    row_total = 0
    for sid, rows in per_session_rows.items():
        derived_total += _session_totals(rows)
        row_total += len(rows)

    if not apply_mode:
        # Dry-run: print per-session re-derived totals. (Before-from-DB is shown
        # only in apply mode, where a live connection exists; a dry-run avoids any
        # DB touch entirely so it is safe on an un-migrated / offline DB.)
        for sid in sorted(per_session_rows):
            rows = per_session_rows[sid]
            turns = sum(1 for r in rows if r["kind"] == "turn")
            subs = sum(1 for r in rows if r["kind"] == "subagent")
            total = _session_totals(rows)
            print(
                f"  {sid}: rows={len(rows)} (turn={turns} sub={subs}) "
                f"re-derived_tokens={_fmt(total)}"
            )
        print(
            f"--- re-derived {row_total} rows, {_fmt(derived_total)} tokens total ---"
        )
        print(
            "(dry-run — no DB writes; re-run with --apply after the migration is applied)"
        )
        return 0

    # Apply mode: UPSERT + report before/after from the live DB.
    try:
        diffs = apply_rows(per_session_rows)
    except Exception as exc:  # noqa: BLE001 — surface the failure loudly, do not swallow
        sys.stderr.write(
            f"[backfill] APPLY FAILED (no partial silent write — check migration applied): {exc}\n"
        )
        return 2

    for sid in sorted(diffs):
        before, after = diffs[sid]
        delta = after - before
        print(
            f"  {sid}: before={_fmt(before)} -> after={_fmt(after)}  (+{_fmt(delta)})"
        )
    print(f"--- upserted {row_total} rows across {len(diffs)} sessions ---")
    return 0


if __name__ == "__main__":
    sys.exit(main())
