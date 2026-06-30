"""Shared daemon-config SoT loader (I6+I7).

Single read path for the Haiku per-call budget ceiling, the pre-verify per-call
budget ceiling, and the Haiku model id. Backs the values that were previously
duplicated as in-code literals in:

  - autoagent/daemon_cycle.py   (HAIKU_MAX_BUDGET_USD / PRE_VERIFY_MAX_BUDGET_USD / HAIKU_MODEL)
  - scripts/wiki_daemon_cycle.py (HAIKU_MAX_BUDGET_USD / HAIKU_MODEL)

WHY a loader (not a bare json.load at each site):
  - one parse + one fallback policy → identical behavior across both packages,
    zero desync risk between the autoagent loop and the wiki loop.
  - daemon_cycle.py is imported by ~7 test modules at collection time, so the
    read MUST NEVER raise — a missing/corrupt config file falls back to the
    validated literals instead of breaking import.

WHY string values (not float):
  - the values are passed verbatim to `claude -p --max-budget-usd <value>`; the
    CLI expects the decimal string as-is. '0.50' is the empirically validated
    ceiling (a float 0.5 would re-serialize without the trailing zero and drift).

This module is placed under ~/.claude/hooks/ — already on sys.path for
daemon_cycle.py (it inserts the hooks dir) and the native home of
learning-aggregator.py / _pg_learning_dualwrite.py. A scripts/-side consumer
adds the same one-line sys.path insert that daemon_cycle.py already uses for the
hooks dir (see read_pattern in the stage-handoff notes).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Config path SoT — kept independent of HOME-mangling test harnesses by reading
# $HOME first (matching daemon_cycle.py line 44 convention), then Path.home().
_HOME = Path(os.environ.get("HOME", str(Path.home())))
CONFIG_PATH = _HOME / ".claude" / "data" / "daemon-config.json"

# Defensive fallback literals — MUST mirror the current in-code constants so a
# missing/unreadable config file preserves the validated behavior exactly.
# 0.10 is too low (triggers immediate CLI exit 1); 0.50 is the validated ceiling.
# Single declaration site per value — inlined into the dict (single-SoT intent).
_FALLBACK: dict[str, str] = {
    "haiku_max_budget_usd": "0.50",
    "pre_verify_max_budget_usd": "0.50",
    "haiku_model": "claude-haiku-4-5",
}


def load_daemon_config(path: Path | None = None) -> dict[str, str]:
    """Load the daemon-config SoT, falling back to in-code literals on any error.

    Never raises — a missing file, JSON parse error, non-dict payload, missing
    key, or non-string value each degrades to the corresponding fallback literal
    (per-key, so a partially-valid file still contributes its good keys). The
    leading "_comment" documentation key is ignored.

    Args:
        path: override config path (test injection); None → CONFIG_PATH.

    Returns:
        dict with exactly the 3 keys haiku_max_budget_usd /
        pre_verify_max_budget_usd / haiku_model — all str values.
    """
    config_path = path if path is not None else CONFIG_PATH
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return dict(_FALLBACK)
    except (OSError, ValueError) as exc:  # ValueError covers JSONDecodeError
        # Corrupt/unreadable config is a misconfiguration signal — surface it on
        # stderr (loud, per self-improve-hygiene Precondition Loud-Fail) but do
        # NOT raise: import-time safety for the ~7 test modules wins.
        sys.stderr.write(
            f"[daemon-config] WARN: falling back to literals — "
            f"{type(exc).__name__}: {exc} (path={config_path})\n"
        )
        return dict(_FALLBACK)

    if not isinstance(raw, dict):
        sys.stderr.write(
            f"[daemon-config] WARN: config not a JSON object → fallback "
            f"(path={config_path})\n"
        )
        return dict(_FALLBACK)

    out: dict[str, str] = {}
    for key, fallback_value in _FALLBACK.items():
        value = raw.get(key)
        out[key] = value if isinstance(value, str) and value else fallback_value
    return out


# Module-level cache — resolved once at import. Stage-2 owners read these three
# names (NOT the function) to replace their literals, e.g.:
#   from daemon_config import HAIKU_MAX_BUDGET_USD, PRE_VERIFY_MAX_BUDGET_USD, HAIKU_MODEL
_CONFIG = load_daemon_config()
HAIKU_MAX_BUDGET_USD: str = _CONFIG["haiku_max_budget_usd"]
PRE_VERIFY_MAX_BUDGET_USD: str = _CONFIG["pre_verify_max_budget_usd"]
HAIKU_MODEL: str = _CONFIG["haiku_model"]
