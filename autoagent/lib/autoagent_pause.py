"""Cooperative AutoAgent-daemon pause flag (Glass Atrium update system, T10).

The python honor side of the cooperative update pause flag. While a Glass Atrium
update swaps files it HOLDS a flag; the launchd-live daemon (and the
daemon-daily-restart-spawned instance) cooperatively SUSPENDS its decision-to-run
for as long as the flag is held, so a daemon cycle write can never race the
update's file swap.

This module is the python twin of ``scripts/lib/update-pause-flag.sh``: it reads
the SAME env vars with the SAME defaults so the updater (shell) and the daemon
(python) coordinate on one canonical path and one TTL.

Canonical path (FIXED, GA_ROOT-anchored, NEVER a temp path)::

    ${GA_ROOT}/.update-state/autoagent-pause.flag

STALE / TTL guard (Precondition Loud-Fail): a trap clears the flag on a normal
updater exit, but a CRASHED updater (SIGKILL / OOM / power-loss) leaves it behind
with no trap able to fire. So ``is_pause_active`` treats a flag OLDER than
``pause_ttl_secs`` (``ATRIUM_PAUSE_TTL_SECS``, default 1800s) as crashed-updater
residue: it LOUD-FAIL clears the flag and reports NOT-active, so the daemon can
never freeze indefinitely behind an abandoned flag.

Age is measured via ``Path.stat().st_mtime`` (python3 mtime) — NEVER the
BSD/GNU-divergent ``stat -f`` / ``stat -c``.

stdlib only (os, sys, time, pathlib); Python 3.12+ idioms. No side effects at
import time.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import TextIO

PAUSE_FLAG_BASENAME = "autoagent-pause.flag"
# Generous upper bound on a real update apply; a flag older than this is treated
# as crashed-updater residue. Mirrors update-pause-flag.sh update_pause_ttl_secs.
DEFAULT_TTL_SECS = 1800


def _home() -> Path:
    return Path(os.environ.get("HOME") or str(Path.home()))


def pause_state_dir() -> Path:
    """Resolve the update-state dir holding the pause flag.

    Precedence: ``ATRIUM_PAUSE_STATE_DIR`` env → ``${GA_ROOT}/.update-state`` →
    ``${HOME}/.glass-atrium/.update-state`` — identical to the shell helper.
    """
    override = os.environ.get("ATRIUM_PAUSE_STATE_DIR")
    if override:
        return Path(override)
    ga_root = os.environ.get("GA_ROOT") or str(_home() / ".glass-atrium")
    return Path(ga_root) / ".update-state"


def pause_flag_path() -> Path:
    """Canonical pause-flag path (file need not exist)."""
    return pause_state_dir() / PAUSE_FLAG_BASENAME


def pause_ttl_secs() -> int:
    """TTL (seconds) beyond which a flag is stale crashed-updater residue.

    ``ATRIUM_PAUSE_TTL_SECS`` override; a non-positive / non-integer value falls
    back to ``DEFAULT_TTL_SECS``.
    """
    raw = os.environ.get("ATRIUM_PAUSE_TTL_SECS", "")
    try:
        val = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_TTL_SECS
    return val if val > 0 else DEFAULT_TTL_SECS


def pause_flag_age_secs(path: Path | None = None) -> float | None:
    """Age in seconds (now - mtime) via python3 mtime; ``None`` when absent.

    Uses ``Path.stat().st_mtime`` (native + portable) — NEVER ``stat -f`` /
    ``stat -c``. A clock skew producing a negative age is clamped to 0.
    """
    p = path if path is not None else pause_flag_path()
    try:
        mtime = p.stat().st_mtime
    except FileNotFoundError:
        return None
    return max(0.0, time.time() - mtime)


def create_pause_flag(path: Path | None = None) -> Path:
    """Create the pause flag atomically (temp + os.replace). Returns the path."""
    p = path if path is not None else pause_flag_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = f"pid={os.getpid()} created={int(time.time())}\n"
    tmp = p.with_name(f"{p.name}.tmp.{os.getpid()}")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, p)  # atomic same-dir rename
    return p


def remove_pause_flag(path: Path | None = None) -> bool:
    """Remove the pause flag. Idempotent; returns True if a file was removed."""
    p = path if path is not None else pause_flag_path()
    try:
        p.unlink()
        return True
    except FileNotFoundError:
        return False


def is_pause_active(
    path: Path | None = None,
    *,
    ttl_secs: int | None = None,
    log: TextIO = sys.stderr,
) -> bool:
    """The daemon honor predicate.

    Returns ``True``  → a FRESH flag is held → the daemon MUST SUSPEND this run.
    Returns ``False`` → no flag, OR a STALE flag (loud-fail cleared here) → run.
    """
    p = path if path is not None else pause_flag_path()
    ttl = ttl_secs if ttl_secs is not None else pause_ttl_secs()
    age = pause_flag_age_secs(p)
    if age is None:
        return False  # no flag → run
    if age > ttl:
        # STALE: crashed-updater residue (beyond trap reach) → loud-fail clear so
        # the daemon never freezes forever behind an abandoned flag.
        log.write(
            f"[autoagent-pause] STALE pause flag cleared (age={int(age)}s > "
            f"ttl={ttl}s): {p} — crashed-updater residue; daemon resumes\n"
        )
        try:
            p.unlink()
        except OSError as exc:
            log.write(
                f"[autoagent-pause] WARN: stale flag unlink failed: {p}: {exc}\n"
            )
        return False
    log.write(
        f"[autoagent-pause] active pause flag (age={int(age)}s ttl={ttl}s): {p} "
        f"— daemon suspends this run\n"
    )
    return True
