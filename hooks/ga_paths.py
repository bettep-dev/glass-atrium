"""Home-anchored runtime-path seam for Atrium python consumers.

Single definition of the Atrium runtime-state roots (data / logs), the python
twin of the shell seam ``${GA_DATA_ROOT:-$HOME/.glass-atrium}`` (hooks/hook-utils.sh),
so python and shell consumers resolve identical locations.

DECOUPLED from the install-tree root: GA_ROOT is unset in the CLI-fired-hook and
launchd-daemon contexts where these consumers run, so the roots anchor on HOME —
which is always set — instead of the install tree.

Importable from all three python trees (hooks/ · autoagent/lib/ · scripts/) via
the same hooks-dir sys.path insert that daemon_config.py / compliance_telemetry.py
already establish. Consumer conversion is out of scope here (plan T2b).

Resolution is per-call (never import-time cached) so a test env override applied
after import still redirects — the compliance_telemetry._resolve policy.
"""

from __future__ import annotations

import os
from pathlib import Path

# The base-root override shared with the shell seam; unset → $HOME/.glass-atrium.
_BASE_ROOT_ENV = "GA_DATA_ROOT"


def get_base_root() -> Path:
    """Resolve the Atrium runtime-state base root (``$HOME/.glass-atrium`` default)."""
    override = os.environ.get(_BASE_ROOT_ENV)
    if override:
        return Path(override)
    # HOME via os.environ first (not Path.home()) so a HOME-mangling test harness
    # redirects the root — the daemon_config._HOME idiom.
    home = os.environ.get("HOME") or str(Path.home())
    return Path(home) / ".glass-atrium"


def get_data_root() -> Path:
    """Resolve the runtime data root (``<base>/data``)."""
    return get_base_root() / "data"


def get_log_root() -> Path:
    """Resolve the runtime log root (``<base>/logs``)."""
    return get_base_root() / "logs"
