"""Live-DB seal for tests that drive ``daemon_cycle`` without a database.

Not a test module (no ``test_`` prefix): consumers anchor this directory on
``sys.path`` and import it after ``daemon_cycle``.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# Seam names keyed by the ``daemon_cycle`` import-exception attribute that binds them;
# ``None`` = defined by ``daemon_cycle`` itself on every leg.
_SEAMS: dict[str | None, tuple[str, ...]] = {
    "_PG_OUTCOME_IMPORT_EXC": (  # ``_pg_learning_dualwrite`` import
        "_pg_read_pending_patterns",
        "_pg_read_coverage_patterns",
        "_pg_read_outcomes_since",
        "_pg_count_outcomes_since",
        "_pg_reject_learning_pattern",
        "_pg_discharge_learning_pattern",
    ),
    "_PG_LOOP_IMPORT_EXC": (  # ``_pg_dual_write_daemon`` import
        "_pg_connect",
        "_pg_write_loop_event",
        "_pg_write_corpus_audit",
    ),
    None: ("_invoke_pg_helper_subprocess",),
}

_AVAILABILITY_FLAGS = ("HAS_PG_LOOP_WRITE", "HAS_PG_PATTERN_READ", "HAS_PG_OUTCOME_READ")


def seal_pg_reach(testcase: unittest.TestCase) -> list[str]:
    """Turn every ``daemon_cycle`` PG path off for one test and record any reach.

    Flags off skip the gated stages; the helper-subprocess fallback is pointed
    at an absent file so a flags-off loop emit skips on every install; each
    connect, read, write and fork seam is replaced by a refusal that records its
    name and raises. Callers assert the returned list empty after the run.

    A seam of an import that succeeded must exist — a renamed seam fails here
    instead of being patched as a dead attribute while the real one stays live.
    """
    dc = sys.modules["daemon_cycle"]
    reach: list[str] = []
    absent_dir = tempfile.TemporaryDirectory()
    testcase.addCleanup(absent_dir.cleanup)
    _patch(testcase, dc, "PG_DUAL_WRITE_HELPER", Path(absent_dir.name) / "absent-helper.py")
    for flag in _AVAILABILITY_FLAGS:
        _patch(testcase, dc, flag, False)
    for import_exc_name, names in _SEAMS.items():
        is_unbound = import_exc_name is not None and getattr(dc, import_exc_name) is not None
        for name in names:
            if not is_unbound and not hasattr(dc, name):
                raise AssertionError(
                    f"PG seal seam missing on daemon_cycle: {name} — "
                    "renamed or removed; update _pg_seal's seam list"
                )
            _patch(testcase, dc, name, _get_refusal(reach, name), create=is_unbound)
    return reach


def _patch(
    testcase: unittest.TestCase,
    module: object,
    name: str,
    value: object,
    *,
    create: bool = False,
) -> None:
    patcher = mock.patch.object(module, name, value, create=create)
    patcher.start()
    testcase.addCleanup(patcher.stop)


def _get_refusal(reach: list[str], name: str):  # noqa: ANN202 — seam signatures differ
    def _refuse(*_args: object, **_kwargs: object) -> None:
        reach.append(name)
        raise AssertionError(f"PG reach from a sealed test: {name}")

    return _refuse
