#!/usr/bin/env python3
"""Shared compliance-rate + signal-store SoT (plan doc 57031 T3/T4).

Single home for the two pieces that the daemon cycle (autoagent/daemon_cycle.py)
and the learning aggregator (hooks/learning-aggregator.py) previously duplicated:

  1. ``compute_compliance_rate`` — a TRUE compliance rate derived from an ACTUAL
     event source (the workflow-gate trace log), never the degenerate
     ``1 - (override+trip)/(override+trip)`` that algebraically collapses to a
     0/1 flag. The rate is ``pass / total`` over real gate encounters. When no
     durable event source exists for a dimension, the rate is ``None``
     (insufficient-data) — NEVER a fabricated 0.0/1.0 (plan Principle 7 Goodhart
     guard + honest-telemetry requirement).

  2. ``append_signal`` — the append-only JSONL signal-store writer + the
     ``SIGNAL_STORE_FILE`` resolution, so the rate formula and the sink each
     exist exactly once.

DETECTION-ONLY: nothing here blocks or raises into a cycle. Every public helper
is fail-soft — an unreadable log or an un-writable store degrades to
insufficient-data / a logged False, never an exception that reaches the caller.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

_HOME = Path(os.environ.get("HOME", str(Path.home())))

# --- signal store sink (single SoT for both writers) -----------------------

# JSONL under the learning data dir (sibling of feature-flags.json). One JSON
# object per line; append-only. Env-overridable so tests redirect it to a tmp
# file (no real store mutation under test). Both daemon_cycle.py and
# learning-aggregator.py import THIS constant — it is declared once here.
_DEFAULT_SIGNAL_STORE = str(
    _HOME / ".claude" / "data" / "learning" / "self-improve-signals.jsonl"
)
SIGNAL_STORE_FILE = Path(
    os.environ.get("AUTOAGENT_SIGNAL_STORE_FILE", _DEFAULT_SIGNAL_STORE)
)


def _resolve(env_key: str, default: Path) -> Path:
    """Resolve a path at CALL time, env first (so a test env override applied
    AFTER import still redirects), falling back to the import-time default."""
    return Path(os.environ.get(env_key, str(default)))


def _resolve_store_file() -> Path:
    return _resolve("AUTOAGENT_SIGNAL_STORE_FILE", SIGNAL_STORE_FILE)


def insufficient_data_rate(*, source: object = None) -> dict[str, object]:
    """The canonical insufficient-data compliance dict (rate=None, zero counts).

    Single home for the shape both ``compute_compliance_rate``'s ``total<=0``
    branch and a caller's module-absent fallback return, so the contract is
    defined once. ``source`` is the compliance_source value (a log path string
    when known, ``None`` when the telemetry module itself is unavailable).
    """
    return {
        "compliance_rate": None,  # None when insufficient data
        "gate_pass_count": 0,
        "gate_trip_count": 0,
        "gate_total_count": 0,
        # No durable override event store exists → honestly insufficient-data.
        "override_rate": None,
        "compliance_source": source,
    }

# --- compliance-rate event source ------------------------------------------

# Durable, append-only gate trace written per gate encounter by
# hooks/enforce-workflow-verify-stage.sh::emit_trace. TAB-delimited columns:
#   ts \t tool_name=Workflow \t verdict=<tag> \t script_len=N
# where <tag> ∈ pass | pass-noscript | block-norev | block-noverifydev |
# block-order | block-docroute | block-entry (historical rows may carry the
# legacy bare 'block'; the python3-absent + helper-error fallbacks still emit
# bare 'pass'). This is the ONLY durable compliance event store today, so it
# supplies the denominator (all rows) and the trip numerator (verdict=block*).
# Env-overridable for tests. NOTE: a block* verdict is a TRIP (the gate fired),
# not an override.
_DEFAULT_GATE_LOG = str(_HOME / ".claude" / "data" / "workflow-gate-fired.log")
WORKFLOW_GATE_LOG_FILE = Path(
    os.environ.get("WORKFLOW_GATE_LOG_FILE", _DEFAULT_GATE_LOG)
)


def _resolve_gate_log_file() -> Path:
    return _resolve("WORKFLOW_GATE_LOG_FILE", WORKFLOW_GATE_LOG_FILE)

# A verdict whose value starts with this token is a TRIP (gate blocked / fired):
# block-norev / block-noverifydev / block-order / block-docroute / block-entry
# (+ legacy bare 'block'). A pass-prefixed verdict (pass / pass-noscript) is
# compliant.
_TRIP_VERDICT_PREFIX = "block"
_PASS_VERDICT = "pass"


def parse_gate_log(log_file: Path | None = None) -> dict[str, int | None]:
    """Parse the workflow-gate trace into ``{pass, trip, total}`` counts.

    TAB-aware column split (NOT a regex over TAB boundaries): each row is split
    on the literal TAB, and the ``verdict=`` field is read by key, so column
    REORDERING or an extra field cannot misattribute a count. A malformed row
    (no ``verdict=`` field) is skipped, not counted.

    Fail-soft: an absent / unreadable / empty log yields ``total=0`` (which the
    caller maps to compliance_rate=None — insufficient data). NEVER raises.
    """
    target = log_file if log_file is not None else _resolve_gate_log_file()
    pass_count = 0
    trip_count = 0
    total = 0
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        # Absent / unreadable → insufficient data, not an error.
        return {"pass": 0, "trip": 0, "total": 0}

    for line in text.splitlines():
        if not line.strip():
            continue
        verdict: str | None = None
        for field in line.split("\t"):
            if field.startswith("verdict="):
                verdict = field[len("verdict="):].strip()
                break
        if verdict is None:
            # Malformed row (no verdict column) — skip, do not count.
            continue
        total += 1
        if verdict.startswith(_TRIP_VERDICT_PREFIX):
            trip_count += 1
        elif verdict.startswith(_PASS_VERDICT):
            # startswith counts pass-noscript (and future pass-* refinements) as
            # pass; safe because the block-prefix trip check above runs FIRST,
            # so no block* row can reach this branch.
            pass_count += 1
        # An unknown non-block, non-pass verdict still counts toward total but is
        # neither pass nor trip (defensive — future verdict values are visible in
        # the total/ratio discrepancy rather than silently miscategorized).
    return {"pass": pass_count, "trip": trip_count, "total": total}


def compute_compliance_rate(
    *,
    log_file: Path | None = None,
    round_ndigits: int = 4,
) -> dict[str, object]:
    """TRUE compliance rate from the gate-trace event source (detection-only).

    ``compliance_rate = pass / total`` over REAL gate encounters — a genuine
    rate in ``[0.0, 1.0]``, NOT the degenerate ``1 - (trip)/(trip)`` flag.

    Insufficient-data contract (honest, never fabricated):
      * ``total == 0`` (log absent / empty / unreadable) → ``compliance_rate``
        is ``None``, NOT 1.0. There is genuinely nothing to measure yet.
      * the OVERRIDE dimension (the ~17% verification-gate race) has NO durable
        event store — enforce-verification-gate.sh writes only ephemeral
        per-session markers — so ``override_rate`` is ALWAYS ``None``
        (insufficient data), never 0.

    Returns a dict carrying the rate, the raw counts, and the override-None note.
    NEVER raises into the cycle.
    """
    counts = parse_gate_log(log_file)
    total = int(counts["total"])
    pass_count = int(counts["pass"])
    trip_count = int(counts["trip"])
    source = str(log_file if log_file is not None else WORKFLOW_GATE_LOG_FILE)

    if total <= 0:
        return insufficient_data_rate(source=source)

    return {
        "compliance_rate": round(pass_count / total, round_ndigits),
        "gate_pass_count": pass_count,
        "gate_trip_count": trip_count,
        "gate_total_count": total,
        # No durable override event store exists → honestly insufficient-data.
        "override_rate": None,
        "compliance_source": source,
    }


# --- signal-store writer (single SoT for both modules) ---------------------


def append_signal(signal: dict[str, object], store_file: Path | str | None = None) -> bool:
    """Append one detection signal as a JSONL line to the signal store.

    Fail-soft: a store-write failure logs to stderr and returns False — a sink
    problem MUST NOT block the cycle/aggregation. Returns True on a confirmed
    append. A ``recorded_at`` UTC timestamp is added when absent.
    """
    target = (
        Path(store_file)
        if store_file is not None
        else _resolve_store_file()
    )
    payload = dict(signal)
    payload.setdefault(
        "recorded_at",
        datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return True
    except OSError as exc:
        print(
            f"[compliance-telemetry] signal append failed "
            f"({type(exc).__name__}): {exc}",
            file=sys.stderr,
        )
        return False
