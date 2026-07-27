"""Pytest path anchor for the scripts/test suites.

The suites here import the `agent_lifecycle` package, which lives at
`scripts/agent_lifecycle/`. There is no `__init__.py` anywhere under `scripts/`,
so pytest's default prepend import mode only puts `scripts/test` on sys.path —
never `scripts/` itself. Anchoring the parent directory here makes every
invocation cwd-independent (repo-root `pytest scripts/test/` works without a
PYTHONPATH the caller has to remember).
"""

from __future__ import annotations

import sys
from pathlib import Path

_SCRIPTS_DIR = str(Path(__file__).resolve().parent.parent)

if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)
