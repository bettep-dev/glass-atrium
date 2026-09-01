"""Shared daemon-config SoT loader (I6+I7).

Single read path for the background-worker per-call budget ceiling, the
pre-verify per-call budget ceiling, and the background-worker model id. The
"worker" is the model the unattended loops run their own LLM calls on — the
autoagent patch generator and the wiki compile/dedup calls. It is named for that
ROLE, never for a model tier: the previous `haiku_*` vocabulary named a model
the loop no longer uses. Backs the values that were previously duplicated as
in-code literals in:

  - autoagent/daemon_cycle.py   (WORKER_MAX_BUDGET_USD / PRE_VERIFY_MAX_BUDGET_USD / WORKER_MODEL)
  - scripts/wiki_daemon_cycle.py (WORKER_MAX_BUDGET_USD / WORKER_MODEL)

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

# Pin this hook's own dir on sys.path so the sibling ga_paths seam resolves under
# any invocation (script or importlib) — mirrors learning-aggregator.py's insert.
_HOOKS_DIR = str(Path(__file__).resolve().parent)
if _HOOKS_DIR not in sys.path:
    sys.path.insert(0, _HOOKS_DIR)
import ga_paths  # noqa: E402 — sys.path insert immediately above

# Config path SoT — the DAEMON_CONFIG env override (shell-seam parity: the
# lib/atrium-config.sh atrium_resolve_worker_model helper reads the same var)
# wins; else the ga_paths runtime-data root (.glass-atrium default,
# GA_DATA_ROOT-overridable) so the daemon reads the SAME daemon-config.json the
# monitor Save writes after the .claude→.glass-atrium data migration.
CONFIG_PATH = Path(
    os.environ.get("DAEMON_CONFIG")
    or str(ga_paths.get_data_root() / "daemon-config.json")
)

# Defensive fallback literals. The budget floors mirror the validated ceiling so a
# missing/unreadable config file preserves budget behavior exactly.
# 0.10 is too low (triggers immediate CLI exit 1); 0.50 is the validated ceiling.
# NOTE: '0.50' here is the absent-file safety floor (used only when daemon-config.json
#   is missing/unreadable), NOT the shipped DB default — the monitor.model_config seed
#   defaults budget.worker_max_usd / budget.pre_verify_max_usd to '10.00'. A fresh
#   install runs on this floor only until the first monitor Save writes the config file.
# Single declaration site per value — inlined into the dict (single-SoT intent).
_FALLBACK: dict[str, str] = {
    "worker_max_budget_usd": "0.50",
    "pre_verify_max_budget_usd": "0.50",
    # CONCRETE ID, deliberately — this REPLACES the former T13 unpinned-alias
    # policy ('haiku'), which is retired here rather than carried over. Three
    # reasons the alias form cannot be kept for this key:
    #   (1) the monitor REJECTS bare aliases on this very domain
    #       (model-config-consts.ts REJECTED_ALIAS_VALUES = {sonnet,haiku,opus}),
    #       so no alias the user could type would ever reach the config file —
    #       an alias fallback was only ever reachable in the absent-file case,
    #       i.e. it disagreed with every value the supported path can produce;
    #   (2) the shell seam (atrium_resolve_worker_model) has ALWAYS defaulted to
    #       a concrete id, so "unpinned everywhere" was never true across seams;
    #   (3) `claude-sonnet-5` must resolve in hooks/pricing.json for the loop's
    #       spend to be costed — a bare alias has no pricing row.
    # Consequence, stated plainly: a fresh install now PINS to this id instead of
    # inheriting the session default. Bumping the daemon to a newer Sonnet is a
    # deliberate edit here (and to the sibling shell/monitor seams), not automatic.
    "worker_model": "claude-sonnet-5",
}

# Legacy daemon-config.json keys, mapped to their current names. An install that
# predates the haiku retirement has a daemon-config.json on disk carrying the OLD
# key names; without this map the loader would find no current key and silently
# fall back to the literals above, discarding an operator's saved model/budget.
# Read-side compatibility only: the monitor's next Save rewrites the file with the
# current names and drops the legacy ones (DEPRECATED_DAEMON_CONFIG_KEYS).
_LEGACY_KEY_ALIASES: dict[str, str] = {
    "worker_max_budget_usd": "haiku_max_budget_usd",
    "worker_model": "haiku_model",
}


def load_daemon_config(
    path: Path | None = None, *, warn: bool = True
) -> dict[str, str]:
    """Load the daemon-config SoT, falling back to in-code literals on any error.

    Never raises — a missing file, JSON parse error, non-dict payload, missing
    key, or non-string value each degrades to the corresponding fallback literal
    (per-key, so a partially-valid file still contributes its good keys). The
    leading "_comment" documentation key is ignored.

    Per-key resolution order: current key → pre-retirement legacy key
    (_LEGACY_KEY_ALIASES) → in-code literal.

    Args (beyond ``path``):
        warn: emit the deprecated-key stderr WARN. Default True for an explicit
            call; the module-level resolution below passes False deliberately —
            this module is imported transitively by tools with a byte-silent
            clean-path stderr contract (the sensitive-patterns guard CLI), and a
            security guard that chatters on its clean path teaches operators to
            ignore its stderr. The loud channel for this condition is the shell
            seam (atrium_resolve_worker_model), which runs on the daemon
            bootstrap path — an actual unattended execution, which is the scope
            Precondition Loud-Fail governs — rather than on arbitrary import.
            ``LEGACY_KEYS_IN_USE`` below exposes the same fact to any caller that
            wants to surface it.

    Args:
        path: override config path (test injection); None → CONFIG_PATH.

    Returns:
        dict with exactly the 3 keys worker_max_budget_usd /
        pre_verify_max_budget_usd / worker_model — all str values.
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
    legacy_used: list[str] = []
    for key, fallback_value in _FALLBACK.items():
        value = raw.get(key)
        if not (isinstance(value, str) and value):
            # Current key absent/blank → try the pre-retirement name before the
            # literal, so an un-resaved config file keeps its operator values.
            legacy_key = _LEGACY_KEY_ALIASES.get(key)
            legacy_value = raw.get(legacy_key) if legacy_key else None
            if isinstance(legacy_value, str) and legacy_value:
                legacy_used.append(legacy_key)  # type: ignore[arg-type]
                if warn:
                    sys.stderr.write(
                        f"[daemon-config] WARN: reading deprecated key "
                        f"'{legacy_key}' for '{key}' — re-save from the monitor "
                        f"Model Config screen to migrate (path={config_path})\n"
                    )
                value = legacy_value
        out[key] = value if isinstance(value, str) and value else fallback_value
    global LEGACY_KEYS_IN_USE
    LEGACY_KEYS_IN_USE = tuple(legacy_used)
    return out


# Module-level cache — resolved once at import. Stage-2 owners read these three
# names (NOT the function) to replace their literals, e.g.:
#   from daemon_config import WORKER_MAX_BUDGET_USD, PRE_VERIFY_MAX_BUDGET_USD, WORKER_MODEL
# Pre-retirement config keys this process actually read, populated by the most
# recent load_daemon_config() call. Non-empty => the on-disk daemon-config.json
# still carries the old names and one monitor Save will migrate it.
LEGACY_KEYS_IN_USE: tuple[str, ...] = ()

# warn=False: see the load_daemon_config `warn` arg note — import must stay silent.
_CONFIG = load_daemon_config(warn=False)
WORKER_MAX_BUDGET_USD: str = _CONFIG["worker_max_budget_usd"]
PRE_VERIFY_MAX_BUDGET_USD: str = _CONFIG["pre_verify_max_budget_usd"]
WORKER_MODEL: str = _CONFIG["worker_model"]
