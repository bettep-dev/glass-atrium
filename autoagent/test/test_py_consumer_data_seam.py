"""T2b consumer seam test — the python consumers derive their data/log roots from
the ga_paths seam (T2a), so the ``.claude`` → ``.glass-atrium`` default flip
propagates to every consumer.

Each consumer binds its data/log path constant at IMPORT time from
``ga_paths.get_data_root()`` / ``get_log_root()``. This test loads each consumer
FRESH under a HOME sandbox (with no GA_DATA_ROOT) and asserts:

(1) the default anchors on ``$HOME/.glass-atrium`` — NOT the legacy ``.claude``;
(2) a preserved env override still derives off the seam-anchored default
    (daemon_config's DAEMON_CONFIG default path);
(3) GA_DATA_ROOT redirects the root (env-override parity with the shell seam).

Covered: the original set (project_key.py / learning-aggregator.py /
autoagent-status-backfill.py) PLUS the seam-completion
consumers that previously still resolved the legacy ``.claude`` store:
daemon_config.py (CONFIG_PATH + the DAEMON_CONFIG override), compliance_telemetry.py
(WORKFLOW_GATE_LOG_FILE), autoagent/daemon_cycle.py
(DEFAULT_OUTCOMES_DIR / DEFAULT_REPORTS_DIR / HAIKU_FAILURE_LOG_DIR),
wiki_dedup.py (DEFAULT_VERIFIED_HASHES_PATH), and
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
import json
import os
import sys
import tempfile
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
for _p in (_HOOKS, _LIB, _SCRIPTS, _AUTOAGENT, Path(__file__).resolve().parent):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from _pg_seal import seal_pg_reach  # noqa: E402 — test dir anchored above

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

    def test_learning_aggregator_data_dir_under_glass_atrium(self) -> None:
        with mock.patch.dict("os.environ", {"HOME": _SANDBOX_HOME}, clear=False):
            os.environ.pop("GA_DATA_ROOT", None)
            m = _load_fresh(_HOOKS / "learning-aggregator.py", "learning_agg_probe")
            self.assertEqual(
                m.DATA_DIR, str(Path(_SANDBOX_HOME) / ".glass-atrium" / "data")
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
            for _k in ("GA_DATA_ROOT", "WORKFLOW_GATE_LOG_FILE"):
                os.environ.pop(_k, None)
            m = _load_fresh(_HOOKS / "compliance_telemetry.py", "compliance_probe")
            base = Path(_SANDBOX_HOME) / ".glass-atrium" / "data"
            self.assertEqual(m.WORKFLOW_GATE_LOG_FILE, base / "workflow-gate-fired.log")
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
            for _c in (
                m.DEFAULT_OUTCOMES_DIR,
                m.DEFAULT_REPORTS_DIR,
                m.HAIKU_FAILURE_LOG_DIR,
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
        gate = "/custom/gate.log"
        with mock.patch.dict(
            "os.environ",
            {
                "WORKFLOW_GATE_LOG_FILE": gate,
                "HOME": _SANDBOX_HOME,
            },
            clear=False,
        ):
            os.environ.pop("GA_DATA_ROOT", None)
            m = _load_fresh(_HOOKS / "compliance_telemetry.py", "compliance_ovr_probe")
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


_FLAG_PROBE_AGENT = "flag-file-probe-agent"


class FlagFileIgnoredByCycleTest(unittest.TestCase):
    """With generation closed, a cycle on any data root calls no generator and applies nothing."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        env = mock.patch.dict(
            "os.environ", {"GA_DATA_ROOT": str(self.root), "HOME": str(self.root)}
        )
        env.start()
        self.addCleanup(env.stop)
        self.dc = _load_daemon_cycle()
        modules = mock.patch.dict(sys.modules, {"daemon_cycle": self.dc})
        modules.start()
        self.addCleanup(modules.stop)
        self.flags_file = self.root / "data" / "learning" / "feature-flags.json"
        self.agents_dir = self.root / "agents"
        self.agents_dir.mkdir()
        (self.agents_dir / f"{_FLAG_PROBE_AGENT}.md").write_text(
            "# probe agent\n", encoding="utf-8"
        )
        pattern = self.dc.Pattern(
            date="2026-07-01",
            label="probe pattern",
            frequency="9",
            agent=_FLAG_PROBE_AGENT,
            status="identified",
            tier="user-pending",
            raw_line=f"pg:learning_log:1:probe pattern|{_FLAG_PROBE_AGENT}",
            row_id=1,
        )
        for target, repl in (
            ("read_user_pending_patterns", lambda *a, **k: [pattern]),
            ("fetch_generation_outcomes", lambda *a, **k: []),
            ("INTER_CALL_SPACING_SEC", 0.0),
        ):
            patcher = mock.patch.object(self.dc, target, repl)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.pg_reach = seal_pg_reach(self)
        # Spies go on after the seal: each replaces one seam the seal already covers.
        self.calls: list[str] = []
        for name in (
            "generate_consolidated_proposal",
            "generate_patch_proposal",
            "run_pre_verify",
            "update_generation_closed_proposals",
            "alert_post_apply_regression",
        ):
            patcher = mock.patch.object(self.dc, name, self._get_spy(name))
            patcher.start()
            self.addCleanup(patcher.stop)

    def _get_spy(self, name: str):
        def _spy(*_args: object, **_kwargs: object) -> int:
            self.calls.append(name)
            return 0

        return _spy

    def _run(self, *, skip_loop_emit: bool = True) -> object:
        """One cycle over a stored user-pending pattern → the report; reach list stays empty."""
        self.calls.clear()
        self.stderr = io.StringIO()
        with contextlib.redirect_stderr(self.stderr):
            report = self.dc.run_cycle(
                log_path=self.root / "learning-log.md",
                outcomes_dir=self.root,
                agents_dir=self.agents_dir,
                skip_haiku=False,
                skip_pre_verify=False,
                skip_loop_emit=skip_loop_emit,
            )
        self.assertEqual(self.pg_reach, [])
        return report

    def test_each_flag_file_content_gives_the_cycle_run_without_one(self) -> None:
        report = self._run()
        without_file = (report.patterns_processed, report.patches, list(self.calls))
        self.flags_file.parent.mkdir(parents=True)
        for name, content in (
            ("flag true", '{"confidence_filter_enabled": true}'),
            ("flag false", '{"confidence_filter_enabled": false}'),
            ("flag unset", "{}"),
            ("flag non-bool", '{"confidence_filter_enabled": "true"}'),
            ("malformed json", "{"),
        ):
            with self.subTest(name):
                self.flags_file.write_text(content, encoding="utf-8")
                report = self._run()
                self.assertEqual(
                    (report.patterns_processed, report.patches, self.calls),
                    without_file,
                )

    def test_closed_cycle_calls_no_generator_and_routes_no_candidate(self) -> None:
        for skip_loop_emit in (True, False):
            with self.subTest(skip_loop_emit=skip_loop_emit):
                report = self._run(skip_loop_emit=skip_loop_emit)
                self.assertEqual(report.patches, [])
                self.assertNotIn("generate_consolidated_proposal", self.calls)
                self.assertNotIn("generate_patch_proposal", self.calls)
                self.assertNotIn("run_pre_verify", self.calls)

    def test_closed_cycle_still_writes_a_report_naming_its_input(self) -> None:
        out = self.root / "report.json"
        self.dc.emit_report(self._run(), out)
        self.assertEqual(
            json.loads(out.read_text(encoding="utf-8"))["patterns_processed"], 1
        )

    def test_terminalization_runs_once_only_when_the_cycle_may_write(self) -> None:
        for skip_loop_emit, expected in ((False, 1), (True, 0)):
            with self.subTest(skip_loop_emit=skip_loop_emit):
                self._run(skip_loop_emit=skip_loop_emit)
                self.assertEqual(
                    self.calls.count("update_generation_closed_proposals"), expected
                )

    def test_closed_cycle_still_runs_the_post_apply_regression_watch(self) -> None:
        self._run(skip_loop_emit=False)
        self.assertEqual(self.calls.count("alert_post_apply_regression"), 1)

    def test_terminalization_fault_warns_and_the_cycle_continues(self) -> None:
        # Psycopg importable but the server down → the helper raises at run time.
        def _raise(*_args: object, **_kwargs: object) -> int:
            self.calls.append("update_generation_closed_proposals")
            raise RuntimeError("connection refused")

        with mock.patch.object(self.dc, "update_generation_closed_proposals", _raise):
            report = self._run(skip_loop_emit=False)
        self.assertEqual(report.patterns_processed, 1, "report survives the fault")
        self.assertIn(
            "update_generation_closed_proposals raised", self.stderr.getvalue()
        )
        self.assertEqual(
            self.calls.count("alert_post_apply_regression"),
            1,
            "post-loop steps still run",
        )


if __name__ == "__main__":
    unittest.main()
