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

Covered: the original set (project_key.py / _pg_push_autoagent_loop_events.py /
learning-aggregator.py / autoagent-status-backfill.py) PLUS the seam-completion
consumers that previously still resolved the legacy ``.claude`` store:
daemon_config.py (CONFIG_PATH + the DAEMON_CONFIG override), compliance_telemetry.py
(SIGNAL_STORE_FILE + WORKFLOW_GATE_LOG_FILE), autoagent/daemon_cycle.py
(DEFAULT_OUTCOMES_DIR / DEFAULT_REPORTS_DIR / HAIKU_FAILURE_LOG_DIR /
FEATURE_FLAGS_FILE), wiki_dedup.py (DEFAULT_VERIFIED_HASHES_PATH), and
wiki_daemon_cycle.py (DEFAULT_REPORTS_DIR). DEFAULT_LEARNING_LOG stays legacy — not
part of the Tier-A migration and the daemon neither reads nor writes it.

HEAD baseline (fails before the seam completion): every migrated-store constant resolved
under ``~/.claude``.

Run with either runner:
    python3 -m unittest autoagent.test.test_py_consumer_data_seam -v
    uv run --with pytest pytest autoagent/test/test_py_consumer_data_seam.py -v
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS = _REPO_ROOT / "hooks"
_LIB = _REPO_ROOT / "autoagent" / "lib"
_SCRIPTS = _REPO_ROOT / "scripts"
_AUTOAGENT = _REPO_ROOT / "autoagent"

# The consumer trees + the hooks dir that hosts ga_paths — the same inserts the
# consumers do at runtime, so the fresh loads below resolve the seam.
for _p in (_HOOKS, _LIB, _SCRIPTS, _AUTOAGENT):
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


def _load_daemon_cycle():
    """Fresh-load the heavy autoagent daemon module, muting its import-time
    optional-dependency warnings (pause-lib / psycopg absent) — noise here, not
    failures. Its DEFAULT_* roots bind from ga_paths at import, so a fresh load
    recomputes them under the active HOME / GA_DATA_ROOT."""
    with contextlib.redirect_stderr(io.StringIO()):
        return _load_fresh(_AUTOAGENT / "daemon_cycle.py", "daemon_cycle_probe")


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

    def test_daemon_config_path_under_glass_atrium(self) -> None:
        with mock.patch.dict("os.environ", {"HOME": _SANDBOX_HOME}, clear=False):
            os.environ.pop("GA_DATA_ROOT", None)
            os.environ.pop("DAEMON_CONFIG", None)
            m = _load_fresh(_HOOKS / "daemon_config.py", "daemon_config_probe")
            self.assertEqual(
                m.CONFIG_PATH,
                Path(_SANDBOX_HOME) / ".glass-atrium" / "data" / "daemon-config.json",
            )
            self.assertNotIn(".claude", str(m.CONFIG_PATH))

    def test_compliance_telemetry_stores_under_glass_atrium(self) -> None:
        with mock.patch.dict("os.environ", {"HOME": _SANDBOX_HOME}, clear=False):
            for _k in (
                "GA_DATA_ROOT",
                "AUTOAGENT_SIGNAL_STORE_FILE",
                "WORKFLOW_GATE_LOG_FILE",
            ):
                os.environ.pop(_k, None)
            m = _load_fresh(_HOOKS / "compliance_telemetry.py", "compliance_probe")
            base = Path(_SANDBOX_HOME) / ".glass-atrium" / "data"
            self.assertEqual(
                m.SIGNAL_STORE_FILE, base / "learning" / "self-improve-signals.jsonl"
            )
            self.assertEqual(m.WORKFLOW_GATE_LOG_FILE, base / "workflow-gate-fired.log")
            self.assertNotIn(".claude", str(m.SIGNAL_STORE_FILE))
            self.assertNotIn(".claude", str(m.WORKFLOW_GATE_LOG_FILE))

    def test_daemon_cycle_roots_under_glass_atrium(self) -> None:
        with mock.patch.dict("os.environ", {"HOME": _SANDBOX_HOME}, clear=False):
            os.environ.pop("GA_DATA_ROOT", None)
            m = _load_daemon_cycle()
            ga = Path(_SANDBOX_HOME) / ".glass-atrium"
            self.assertEqual(m.DEFAULT_OUTCOMES_DIR, ga / "data" / "outcomes")
            self.assertEqual(m.DEFAULT_REPORTS_DIR, ga / "data" / "daemon-reports")
            self.assertEqual(
                m.HAIKU_FAILURE_LOG_DIR, ga / "logs" / "autoagent-haiku-failures"
            )
            self.assertEqual(
                m.FEATURE_FLAGS_FILE, ga / "data" / "learning" / "feature-flags.json"
            )
            for _c in (
                m.DEFAULT_OUTCOMES_DIR,
                m.DEFAULT_REPORTS_DIR,
                m.HAIKU_FAILURE_LOG_DIR,
                m.FEATURE_FLAGS_FILE,
            ):
                self.assertNotIn(".claude", str(_c))

    def test_daemon_cycle_learning_log_stays_legacy_claude(self) -> None:
        # learning-log.md was NOT part of the Tier-A migration AND the daemon
        # neither reads nor writes it — the constant is deliberately left legacy.
        with mock.patch.dict("os.environ", {"HOME": _SANDBOX_HOME}, clear=False):
            os.environ.pop("GA_DATA_ROOT", None)
            m = _load_daemon_cycle()
            self.assertEqual(
                m.DEFAULT_LEARNING_LOG,
                Path(_SANDBOX_HOME) / ".claude" / "data" / "learning-log.md",
            )

    def test_wiki_dedup_verified_hashes_under_glass_atrium(self) -> None:
        with mock.patch.dict("os.environ", {"HOME": _SANDBOX_HOME}, clear=False):
            os.environ.pop("GA_DATA_ROOT", None)
            m = _load_fresh(_SCRIPTS / "wiki_dedup.py", "wiki_dedup_probe")
            self.assertEqual(
                m.DEFAULT_VERIFIED_HASHES_PATH,
                Path(_SANDBOX_HOME)
                / ".glass-atrium"
                / "data"
                / "wiki-dedup-verified-hashes.json",
            )
            self.assertNotIn(".claude", str(m.DEFAULT_VERIFIED_HASHES_PATH))

    def test_wiki_daemon_cycle_reports_under_glass_atrium(self) -> None:
        with mock.patch.dict("os.environ", {"HOME": _SANDBOX_HOME}, clear=False):
            os.environ.pop("GA_DATA_ROOT", None)
            m = _load_fresh(_SCRIPTS / "wiki_daemon_cycle.py", "wiki_daemon_probe")
            self.assertEqual(
                m.DEFAULT_REPORTS_DIR,
                Path(_SANDBOX_HOME) / ".glass-atrium" / "data" / "daemon-reports",
            )
            self.assertNotIn(".claude", str(m.DEFAULT_REPORTS_DIR))


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

    def test_ga_data_root_redirects_daemon_config(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {"GA_DATA_ROOT": "/var/atrium-alt", "HOME": _SANDBOX_HOME},
            clear=False,
        ):
            os.environ.pop("DAEMON_CONFIG", None)
            m = _load_fresh(_HOOKS / "daemon_config.py", "daemon_config_gdr_probe")
            self.assertEqual(
                m.CONFIG_PATH, Path("/var/atrium-alt") / "data" / "daemon-config.json"
            )

    def test_daemon_config_env_override_wins_over_seam(self) -> None:
        # The DAEMON_CONFIG override (shell-seam parity) must win even over the
        # GA_DATA_ROOT-anchored default — the explicit path is authoritative.
        override = "/custom/place/my-daemon-config.json"
        with mock.patch.dict(
            "os.environ",
            {
                "DAEMON_CONFIG": override,
                "GA_DATA_ROOT": "/var/atrium-alt",
                "HOME": _SANDBOX_HOME,
            },
            clear=False,
        ):
            m = _load_fresh(_HOOKS / "daemon_config.py", "daemon_config_ovr_probe")
            self.assertEqual(m.CONFIG_PATH, Path(override))

    def test_compliance_env_overrides_preserved(self) -> None:
        sig = "/custom/sig.jsonl"
        gate = "/custom/gate.log"
        with mock.patch.dict(
            "os.environ",
            {
                "AUTOAGENT_SIGNAL_STORE_FILE": sig,
                "WORKFLOW_GATE_LOG_FILE": gate,
                "HOME": _SANDBOX_HOME,
            },
            clear=False,
        ):
            os.environ.pop("GA_DATA_ROOT", None)
            m = _load_fresh(_HOOKS / "compliance_telemetry.py", "compliance_ovr_probe")
            self.assertEqual(m.SIGNAL_STORE_FILE, Path(sig))
            self.assertEqual(m.WORKFLOW_GATE_LOG_FILE, Path(gate))

    def test_ga_data_root_redirects_daemon_cycle(self) -> None:
        with mock.patch.dict(
            "os.environ",
            {"GA_DATA_ROOT": "/var/atrium-alt", "HOME": _SANDBOX_HOME},
            clear=False,
        ):
            m = _load_daemon_cycle()
            self.assertEqual(
                m.DEFAULT_OUTCOMES_DIR, Path("/var/atrium-alt") / "data" / "outcomes"
            )
            self.assertEqual(
                m.HAIKU_FAILURE_LOG_DIR,
                Path("/var/atrium-alt") / "logs" / "autoagent-haiku-failures",
            )


if __name__ == "__main__":
    unittest.main()
