"""T2b consumer seam test — the python consumers derive their data/log roots from
the ga_paths seam (T2a), so the ``.claude`` → ``.glass-atrium`` default flip
propagates to every consumer.

Each consumer binds its data/log path constant at IMPORT time from
``ga_paths.get_data_root()`` / ``get_log_root()``. This test loads each consumer
FRESH under a HOME sandbox (with no GA_DATA_ROOT) and asserts:

(1) the default anchors on ``$HOME/.glass-atrium`` — NOT the legacy ``.claude``;
(2) a preserved env override still derives off the seam-anchored default
    (learning-aggregator's CLAUDE_LESSONS_STORE_FILE default path);
(3) GA_DATA_ROOT redirects the root (env-override parity with the shell seam).

HEAD baseline (fails before T2b): every constant resolved under ``~/.claude``.

Run with either runner:
    python3 -m unittest autoagent.test.test_py_consumer_data_seam -v
    uv run --with pytest pytest autoagent/test/test_py_consumer_data_seam.py -v
"""

from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS = _REPO_ROOT / "hooks"
_LIB = _REPO_ROOT / "autoagent" / "lib"
_SCRIPTS = _REPO_ROOT / "scripts"

# The three consumer trees + the hooks dir that hosts ga_paths — the same inserts
# the consumers do at runtime, so the fresh loads below resolve the seam.
for _p in (_HOOKS, _LIB, _SCRIPTS):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

# Fixed sandbox anchor (mirrors test_ga_paths.py) — no filesystem access happens at
# consumer import, so a non-real HOME is safe and keeps the assertion deterministic.
_SANDBOX_HOME = "/tmp/ga-home"


def _load_fresh(path: Path, name: str):
    """Exec a module fresh (dashed script filenames included) under the current env.

    A fresh module object recomputes its import-time path constant under whatever
    HOME / GA_DATA_ROOT is active — the seam resolves per call, but each CONSUMER
    binds its constant once at import, so a fresh load is required per env.
    """
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    # Register before exec: a module-level @dataclass resolves its own __module__
    # via sys.modules during class creation (strict on 3.14+). Pop after — the built
    # module object is self-contained, so the throwaway name never lingers.
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    finally:
        sys.modules.pop(name, None)
    return module


class DefaultResolutionTest(unittest.TestCase):
    """No GA_DATA_ROOT — every consumer anchors on $HOME/.glass-atrium, not .claude."""

    def test_project_key_learning_root_under_glass_atrium(self) -> None:
        with mock.patch.dict("os.environ", {"HOME": _SANDBOX_HOME}, clear=False):
            os.environ.pop("GA_DATA_ROOT", None)
            m = _load_fresh(_LIB / "project_key.py", "project_key_probe")
            self.assertEqual(
                m._LEARNING_ROOT,
                Path(_SANDBOX_HOME) / ".glass-atrium" / "data" / "learning",
            )
            self.assertNotIn(".claude", str(m._LEARNING_ROOT))

    def test_loop_events_log_under_glass_atrium(self) -> None:
        with mock.patch.dict("os.environ", {"HOME": _SANDBOX_HOME}, clear=False):
            os.environ.pop("GA_DATA_ROOT", None)
            m = _load_fresh(
                _SCRIPTS / "_pg_push_autoagent_loop_events.py", "loop_events_probe"
            )
            self.assertEqual(
                m.LOOP_LOG,
                str(
                    Path(_SANDBOX_HOME)
                    / ".glass-atrium"
                    / "logs"
                    / "autoagent-loop.jsonl"
                ),
            )
            self.assertNotIn(".claude", m.LOOP_LOG)

    def test_learning_aggregator_data_dir_under_glass_atrium(self) -> None:
        with mock.patch.dict("os.environ", {"HOME": _SANDBOX_HOME}, clear=False):
            os.environ.pop("GA_DATA_ROOT", None)
            os.environ.pop("CLAUDE_LESSONS_STORE_FILE", None)
            m = _load_fresh(_HOOKS / "learning-aggregator.py", "learning_agg_probe")
            self.assertEqual(
                m.DATA_DIR, str(Path(_SANDBOX_HOME) / ".glass-atrium" / "data")
            )
            # The preserved env override defaults off the seam-anchored data root.
            self.assertEqual(
                m.LESSON_STORE_FILE,
                str(Path(_SANDBOX_HOME) / ".glass-atrium" / "data" / "lessons.json"),
            )

    def test_status_backfill_reports_under_glass_atrium(self) -> None:
        with mock.patch.dict("os.environ", {"HOME": _SANDBOX_HOME}, clear=False):
            os.environ.pop("GA_DATA_ROOT", None)
            try:
                m = _load_fresh(
                    _SCRIPTS / "autoagent-status-backfill.py", "status_backfill_probe"
                )
            except SystemExit as exc:
                # psycopg precondition (exit 3/4) fires after the seam import but
                # before REPORTS_DIR — skip, not fail, when the driver is absent.
                self.skipTest(f"psycopg precondition unmet at import (exit {exc.code})")
            self.assertEqual(
                m.REPORTS_DIR,
                str(
                    Path(_SANDBOX_HOME)
                    / ".glass-atrium"
                    / "data"
                    / "daemon-reports"
                ),
            )


class OverrideParityTest(unittest.TestCase):
    """GA_DATA_ROOT redirects the consumer root — shell-seam override parity."""

    def test_ga_data_root_redirects_project_key(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {"GA_DATA_ROOT": "/var/atrium-alt", "HOME": _SANDBOX_HOME},
            clear=False,
        ):
            m = _load_fresh(_LIB / "project_key.py", "project_key_override_probe")
            self.assertEqual(
                m._LEARNING_ROOT, Path("/var/atrium-alt") / "data" / "learning"
            )

    def test_ga_data_root_redirects_loop_events(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {"GA_DATA_ROOT": "/var/atrium-alt", "HOME": _SANDBOX_HOME},
            clear=False,
        ):
            m = _load_fresh(
                _SCRIPTS / "_pg_push_autoagent_loop_events.py", "loop_override_probe"
            )
            self.assertEqual(
                m.LOOP_LOG, str(Path("/var/atrium-alt") / "logs" / "autoagent-loop.jsonl")
            )


if __name__ == "__main__":
    unittest.main()
