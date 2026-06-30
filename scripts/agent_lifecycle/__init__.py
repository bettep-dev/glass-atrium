"""Agent lifecycle CLI — safe add / delete / orphan-scan / sync-inject over the GA harness.

This package is the F2 agent-lifecycle tool: it adds and deletes agents across
the derived-chain stores (agents/<name>.md -> git -> registry -> manifest ->
symlink farm, plus the DEV scope-dev.md loading stanza) atomically, or rolls the
whole change back. Wave 1 ships the core primitives (atomic JSON write, the
transaction/rollback framework, <name> validation, the read helpers, and the
domains-overlap predicate) plus the argparse skeleton; the action handlers are
filled in by later waves.

No third-party dependencies — stdlib only. Python 3.12+ idioms (PEP 695 type
aliases, structural pattern matching where it clarifies).
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "1.0.0"
