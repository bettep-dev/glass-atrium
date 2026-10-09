"""A/A harness: the --aa-start mode, the restart rows its fingerprint drives, and the result.

An A/A opens only through --aa-start, its fingerprint the installed manifest's scoped
hashes; while it is open each writing cycle compares the fingerprint and writes an
aa-restart row when it moved or cannot be read. Once its window's duration ends, a cycle
writes one arm-difference design-effect row per agent and metric key, the instrument verdict
row and the aa-result row. Every row outside the live class is
database-free under ``seal_pg_reach``; the ledger is an in-memory append-only fake behind the
writer and connection seams. The live classes run the open-state, join-coverage and spool-close
reads' SQL, and the close-count writer, on the cluster ``autoagent/test/live-pg-ephemeral.bats``
provisions and skip elsewhere.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_aa_harness.py -v
    python3 -m unittest autoagent.test.test_aa_harness -v
"""

from __future__ import annotations

import contextlib
import functools
import hashlib
import importlib.util
import io
import itertools
import json
import math
import os
import shutil
import signal
import site
import subprocess
import sys
import tempfile
import unittest
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import NamedTuple
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_TEST_DIR = Path(__file__).resolve().parent

for _anchor in (
    _REPO_ROOT / "hooks",
    _REPO_ROOT / "autoagent",
    _REPO_ROOT / "autoagent" / "lib",
    _REPO_ROOT / "scripts" / "test",
    _TEST_DIR,
):
    if str(_anchor) not in sys.path:
        sys.path.insert(0, str(_anchor))

import _pg_stub_backend as stub
import daemon_cycle as dc
import trial_design
from _outcome_signal import SpawnFacts, is_floor_half
from _pg_seal import get_ephemeral_connection, seal_pg_reach

_NOW = datetime(2026, 10, 7, 4, 30, tzinfo=timezone.utc)
_CYCLE_DATE = "2026-10-07"
_MIGRATION = SimpleNamespace(
    LEDGER="monitor/prisma/migrations/20261008000000_add_trial_ledger_and_cycle_verdicts/migration.sql",
    OTHER="monitor/prisma/migrations/20260611000000_init_squashed/migration.sql",
)
_SCOPED = {
    "hooks/inject-scope-rules.sh": "1" * 64,
    "autoagent/daemon_cycle.py": "2" * 64,
    "agents/glass-atrium-dev-python.md": "3" * 64,
    _MIGRATION.LEDGER: "4" * 64,
}
_UNSCOPED = {
    "hooks/enforce-commit-guard.sh": "5" * 64,
    _MIGRATION.OTHER: "6" * 64,
    "rules/glass-atrium/core-security.md": "7" * 64,
}
# 14 days, 28 when any of the five busiest agents has < 200 spawns
_DURATION = {
    "days": 14,
    "extended_days": 28,
    "busiest_agents": 5,
    "minimum_spawns": 200,
}


def _put_config(root: Path, declared: Path) -> None:
    """The install's rendered config.toml, declaring `declared` as its [paths].root."""
    (root / "config.toml").write_text(f'[paths]\nroot = "{declared}"\n', encoding="utf-8")


class _LedgerRow(NamedTuple):
    id: int
    trial_key: str | None
    event: str
    actor: str
    payload: dict
    dedupe_key: str | None
    agent: str | None
    recorded_at: datetime


class _Outcome(NamedTuple):
    agent: str
    record_ts: datetime
    agent_id: str | None
    session_id: str | None


class _SpoolClose(NamedTuple):
    """A manifest-spool-closed loop-event row; NULL counts = written before the count columns."""

    spool: str
    event_ts: datetime
    lines_read: int | None
    lines_without_row: int | None


class _UndefinedColumn(Exception):
    """psycopg's UndefinedColumn as the sink read meets it: SQLSTATE 42703."""

    sqlstate = "42703"


class _Ledger:
    """core.autoagent_trial_ledger as the writer and the open-state read see it: append-only,
    a taken dedupe_key adds no row (ON CONFLICT DO NOTHING), payload stored as JSON."""

    def __init__(self) -> None:
        self.rows: list[_LedgerRow] = []
        self.refused: list[str] = []
        self.faulted: set[str] = set()
        self.write_fault: Exception | None = None
        self.faulted_events: set[str] = set()  # events whose writes fault, the rest land
        self.is_key_taken = False
        self.clock = _NOW  # recorded_at of the next row
        self.outcomes: list[_Outcome] = []
        self.manifest_agent_ids: set[str] = set()
        self.closes: list[_SpoolClose] = []
        self.is_count_absent = False  # a schema without lines_read / lines_without_row
        # read only by a writing cycle's regression gate and discharge
        self.answered_empty = frozenset(
            {
                dc._REGRESSION_WARNINGS_SELECT_SQL,
                dc._REGRESSION_PROPOSALS_SELECT_SQL,
                dc._APPLIED_FOR_DISCHARGE_SELECT_SQL,
            }
        )

    def write(
        self,
        event,
        actor,
        payload,
        *,
        trial_key=None,
        dedupe_key=None,
        agent=None,
        **_columns,
    ):
        if self.write_fault is not None:
            raise self.write_fault
        if event in self.faulted_events:
            raise ConnectionError("PG unreachable")
        if self.is_key_taken or (
            dedupe_key is not None
            and any(row.dedupe_key == dedupe_key for row in self.rows)
        ):
            return 0
        stored = json.loads(json.dumps(payload))
        self.rows.append(
            _LedgerRow(
                len(self.rows) + 1,
                trial_key,
                event,
                actor,
                stored,
                dedupe_key,
                agent,
                self.clock,
            )
        )
        return 1

    def connect(self) -> contextlib.nullcontext:
        return contextlib.nullcontext(_LedgerCursor(self))

    def get_rows(self, event: str) -> list[_LedgerRow]:
        return [row for row in self.rows if row.event == event]


class _LedgerCursor:
    def __init__(self, ledger: _Ledger) -> None:
        self.ledger = ledger
        self.result: list[tuple] = []

    def cursor(self) -> contextlib.nullcontext:
        return contextlib.nullcontext(self)

    def execute(self, statement: str, params: dict | tuple = ()) -> None:
        if statement in self.ledger.faulted:
            raise ConnectionError("PG unreachable")
        if statement == dc.AA.SQL.LATEST_START:
            assert isinstance(params, dict), (
                "the open-state read binds named parameters"
            )
            self.result = self._get_latest_start(params)
        elif statement == dc.AA.SQL.JOIN_COVERAGE:
            self.result = [self._get_join_counts(params)]
        elif statement == dc.AA.SQL.SPOOL_CLOSES:
            self.result = self._get_spool_closes(params)
        elif statement in self.ledger.answered_empty:
            self.result = []
        elif statement == dc.AA.SQL.EXTENSION:
            self.result = [
                (
                    any(
                        row.event == params["event"]
                        and row.dedupe_key == params["dedupe_key"]
                        for row in self.ledger.rows
                    ),
                )
            ]
        elif statement == dc.AA.SQL.VERDICT_DAYS:
            self.result = [
                (row.payload["window_days"],)
                for row in self.ledger.rows
                if row.event == params["event"] and row.dedupe_key == params["dedupe_key"]
            ]
        else:
            self.ledger.refused.append(statement)
            raise AssertionError(f"statement outside the ledger fake: {statement[:80]}")

    def _get_latest_start(self, params: dict) -> list[tuple]:
        rows = self.ledger.rows
        starts = [row for row in rows if row.event == params["start"]]
        if not starts:
            return []
        start = starts[-1]
        is_closed = any(
            row.event == params["result"]
            and row.dedupe_key == f"{params['result_prefix']}{start.id}"
            for row in rows
        )
        newest = [
            row
            for row in rows
            if row.event in params["fingerprinted"] and row.id >= start.id
        ][-1]
        return [
            (
                start.id,
                is_closed,
                newest.payload["fingerprint"],
                newest.recorded_at,
                start.payload["duration"],
                newest.id,
            )
        ]

    def _get_join_counts(self, params: dict) -> tuple[int, int]:
        outcomes = [
            outcome
            for outcome in self.ledger.outcomes
            if outcome.agent in params["agents"]
            and params["start"] <= outcome.record_ts < params["end"]
        ]
        joined = [
            outcome
            for outcome in outcomes
            if outcome.session_id is not None
            and outcome.agent_id in self.ledger.manifest_agent_ids
        ]
        return len(outcomes), len(joined)

    def _get_spool_closes(self, params: dict) -> list[tuple]:
        if self.ledger.is_count_absent:
            raise _UndefinedColumn('column "lines_read" does not exist')
        assert params["event"] == dc.MANIFEST_SPOOL_CLOSED_EVAL_RESULT
        return [
            (close.spool, close.lines_read, close.lines_without_row)
            for close in self.ledger.closes
            if close.event_ts >= params["start"]
        ]

    def fetchone(self) -> tuple | None:
        return self.result[0] if self.result else None

    def fetchall(self) -> list[tuple]:
        return list(self.result)


class _AaFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.pg_reach = seal_pg_reach(self)
        self.ledger = _Ledger()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.scratch = Path(tmp.name)
        self.root = self.scratch / "install"
        self._install()
        # the canary files land under the sandboxed data root, for the fixture's roster
        self.data_root = self.scratch / "data-root"
        self.canary_dir = self.data_root / "data" / "learning" / "canary"
        env = mock.patch.dict(os.environ, {"GA_DATA_ROOT": str(self.data_root)})
        env.start()
        self.addCleanup(env.stop)
        self.agents_dir = self.scratch / "agents"
        self.agents_dir.mkdir()
        for stem in _ROSTER:
            (self.agents_dir / f"{stem}.md").write_text("# body\n", encoding="utf-8")
        # the installed agents dir also holds the charter, a rules file no spawn ever types
        (self.agents_dir / "GLASS_ATRIUM_GLOBAL_RULES.md").write_text("# rules\n", encoding="utf-8")
        # after the seal: ledger connection and writer = the DB boundary
        for name, value in (
            ("HAS_PG_LOOP_WRITE", True),
            ("_pg_connect", lambda: self.ledger.connect()),
            ("_pg_write_trial_ledger_row", lambda *a, **k: self.ledger.write(*a, **k)),
            ("_get_utc_now", lambda: _NOW),
            ("_INSTALL_ROOT", self.root),
            ("DEFAULT_AGENTS_DIR", self.agents_dir),
        ):
            self._patch(name, value)
        self._patch(
            "TRIAL_LEDGER", stub.get_trial_ledger(), create=not hasattr(dc, "TRIAL_LEDGER")
        )

    def _patch(self, name: str, value: object, *, create: bool = False) -> None:
        patcher = mock.patch.object(dc, name, value, create=create)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _install(self) -> None:
        """A fresh install root: manifest at the root, the two migrations, live scoped files."""
        if self.root.exists():
            self.root.rename(self.scratch / f"retired-{uuid.uuid4().hex[:8]}")
        self.ledger = _Ledger()
        for path, text in (
            (
                _MIGRATION.LEDGER,
                'CREATE TABLE IF NOT EXISTS "core"."autoagent_trial_ledger" (',
            ),
            (_MIGRATION.OTHER, 'CREATE TABLE "core"."outcomes" ('),
            ("agents/glass-atrium-dev-python.md", "# body\n"),
            ("autoagent/daemon_cycle.py", "# module\n"),
        ):
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            (self.root / path).write_text(text, encoding="utf-8")
        _put_config(self.root, self.root)
        self._write_manifest({**_SCOPED, **_UNSCOPED})

    def _write_manifest(
        self, hashes: dict[str, str], *, version: str = "1.4.0"
    ) -> None:
        manifest = {"version": version, "files": sorted(hashes), "hashes": hashes}
        (self.root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    def _set_hash(self, path: str, digest: str) -> None:
        self._write_manifest({**_SCOPED, **_UNSCOPED, path: digest})

    def _open(self, duration: dict = _DURATION) -> None:
        """An open A/A started on the current scoped fingerprint."""
        self.ledger.write(
            stub.get_trial_ledger().EVENT.AA_START,
            stub.get_trial_ledger().ACTOR.AA,
            {
                "fingerprint": dict(_SCOPED),
                "started_at": self.ledger.clock.isoformat(),
                "duration": duration,
            },
            dedupe_key="aa-start:after:0",
        )

    def _start(self) -> tuple[int, str]:
        stderr = io.StringIO()
        with (
            contextlib.redirect_stderr(stderr),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            code = dc._main(["--aa-start"])
        self.assertEqual(self.pg_reach, [])
        self.assertEqual(self.ledger.refused, [])
        return code, stderr.getvalue()

    def _cycle(self, cycle_date: str = _CYCLE_DATE, **sources: object) -> str:
        sources.setdefault("agents_dir", self.agents_dir)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            dc.run_aa_stage(cycle_date, **sources)
        self.assertEqual(self.pg_reach, [])
        self.assertEqual(self.ledger.refused, [])
        return stderr.getvalue()

    def _get_restarts(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(stub.get_trial_ledger().EVENT.AA_RESTART)

    def _get_starts(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(stub.get_trial_ledger().EVENT.AA_START)


class AaStartTest(_AaFixture):
    def test_aa_start_writes_one_start_row_carrying_only_the_scoped_manifest_hashes(
        self,
    ) -> None:
        code, _ = self._start()

        self.assertEqual(code, 0)
        self.assertEqual(
            [
                (row.event, row.actor, row.trial_key, row.dedupe_key)
                for row in self.ledger.rows
            ],
            [("aa-start", "daemon-cycle-aa", None, "aa-start:after:0")],
        )
        self.assertEqual(
            self.ledger.rows[0].payload,
            {
                "fingerprint": _SCOPED,
                "started_at": _NOW.isoformat(),
                "duration": _DURATION,
            },
        )

    def test_a_start_after_a_closed_aa_is_keyed_on_that_start_so_a_racing_start_lands_nothing(
        self,
    ) -> None:
        self._open()
        self.ledger.write(
            stub.get_trial_ledger().EVENT.AA_RESULT,
            stub.get_trial_ledger().ACTOR.AA,
            {"overall": "pass"},
            dedupe_key="aa-result:1",
        )

        code, _ = self._start()

        self.assertEqual(code, 0)
        self.assertEqual(
            [row.dedupe_key for row in self._get_starts()],
            ["aa-start:after:0", "aa-start:after:1"],
        )


class AaStartRefusalTest(_AaFixture):
    def test_each_refusal_exits_with_the_refusal_code_and_its_named_reason_writing_nothing(
        self,
    ) -> None:
        def manifest() -> Path:  # per row: _install rebinds the root's contents
            return self.root / "manifest.json"

        rows = (
            ("manifest missing", lambda: manifest().unlink(), "manifest-unreadable"),
            (
                "manifest not JSON",
                lambda: manifest().write_text("{", encoding="utf-8"),
                "manifest-unreadable",
            ),
            (
                "manifest without hashes",
                lambda: manifest().write_text('{"version": "1.4.0"}', encoding="utf-8"),
                "manifest-unreadable",
            ),
            (
                "manifest with no scoped entry",
                lambda: self._write_manifest(dict(_UNSCOPED)),
                "manifest-unreadable",
            ),
            (
                "a manifest-listed migration unreadable",
                lambda: (self.root / _MIGRATION.LEDGER).unlink(),
                "manifest-unreadable",
            ),
            ("an A/A already open", self._open, "already-open"),
            (
                "a concurrent start took the start key",
                lambda: setattr(self.ledger, "is_key_taken", True),
                "already-open",
            ),
            (
                "the open-state read faults",
                lambda: self.ledger.faulted.add(dc.AA.SQL.LATEST_START),
                "ledger-unreadable",
            ),
            (
                "the ledger write faults",
                lambda: setattr(
                    self.ledger, "write_fault", ConnectionError("PG unreachable")
                ),
                "ledger-unwritable",
            ),
            (
                "the PG helper did not import",
                lambda: self._patch("HAS_PG_LOOP_WRITE", False),
                "ledger-unwritable",
            ),
        )
        for name, arrange, reason in rows:
            with self.subTest(name):
                self._install()
                arrange()
                starts_before = len(self._get_starts())

                code, stderr_text = self._start()

                self.assertEqual(code, dc.ExitCode.AA_START_REFUSED)
                self.assertIn(f"--aa-start refused: {reason} — ", stderr_text)
                self.assertEqual(len(self._get_starts()), starts_before)
                self._patch("HAS_PG_LOOP_WRITE", True)

    def test_aa_start_takes_no_dry_run(self) -> None:
        with (
            contextlib.redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit),
        ):
            dc._main(["--aa-start", "--dry-run"])
        self.assertEqual(self.ledger.rows, [])


class AaRestartTest(_AaFixture):
    def test_an_open_aa_restarts_only_when_a_scoped_manifest_hash_moved(self) -> None:
        rows = (
            ("the scope-rules hook hash changes", "hooks/inject-scope-rules.sh", True),
            ("an autoagent module hash changes", "autoagent/daemon_cycle.py", True),
            ("an agent body hash changes", "agents/glass-atrium-dev-python.md", True),
            ("the ledger migration hash changes", _MIGRATION.LEDGER, True),
            (
                "a new autoagent file enters the manifest",
                "autoagent/lib/trial_design.py",
                True,
            ),
            *(
                (f"spawn- or evidence-path file {path} changes", path, True)
                for path in (
                    "hooks/hook-utils.sh",
                    "hooks/enforce-harness-critical.sh",
                    "hooks/track-outcome.sh",
                    "hooks/_outcome_signal.py",
                    "hooks/_pg_learning_dualwrite.py",
                    "scripts/_pg_dual_write_daemon.py",
                )
            ),
            ("an unscoped hook hash changes", "hooks/enforce-commit-guard.sh", False),
            ("a migration not naming the ledger changes", _MIGRATION.OTHER, False),
            ("a rule file hash changes", "rules/glass-atrium/core-security.md", False),
        )
        for name, path, is_restart in rows:
            with self.subTest(name):
                self._install()
                self._open()
                self._set_hash(path, "f" * 64)

                self._cycle()

                expected = (
                    [
                        (
                            {
                                "start_id": 1,
                                "reason": "fingerprint-changed",
                                "fingerprint": {**_SCOPED, path: "f" * 64},
                            },
                            f"aa-restart:1:{_CYCLE_DATE}",
                        )
                    ]
                    if is_restart
                    else []
                )
                self.assertEqual(
                    [(row.payload, row.dedupe_key) for row in self._get_restarts()],
                    expected,
                )

    def test_live_writes_with_the_manifest_unchanged_never_restart(self) -> None:
        rows = (
            (
                "bytecode written under autoagent/",
                "autoagent/__pycache__/daemon_cycle.cpython-314.pyc",
                b"\x00\x0d\x0d\x0a bytecode",
            ),
            (
                "a live agent body edit (a block toggle)",
                "agents/glass-atrium-dev-python.md",
                b"# body\n<!-- trial block off -->\n",
            ),
            ("the manifest version moves alone", None, b""),
        )
        for name, path, data in rows:
            with self.subTest(name):
                self._install()
                self._open()
                if path is None:
                    self._write_manifest({**_SCOPED, **_UNSCOPED}, version="1.4.1")
                else:
                    (self.root / path).parent.mkdir(parents=True, exist_ok=True)
                    (self.root / path).write_bytes(data)

                self._cycle()

                self.assertEqual(self._get_restarts(), [])

    def test_a_restart_carries_the_new_fingerprint_that_later_cycles_compare_against(
        self,
    ) -> None:
        self._open()
        self._set_hash("autoagent/daemon_cycle.py", "f" * 64)

        self._cycle("2026-10-07")
        self._cycle("2026-10-08")
        self._set_hash("autoagent/daemon_cycle.py", "e" * 64)
        self._cycle("2026-10-09")

        self.assertEqual(
            [
                (
                    row.payload["fingerprint"]["autoagent/daemon_cycle.py"],
                    row.dedupe_key,
                )
                for row in self._get_restarts()
            ],
            [
                ("f" * 64, "aa-restart:1:2026-10-07"),
                ("e" * 64, "aa-restart:1:2026-10-09"),
            ],
        )

    def test_an_unreadable_manifest_restarts_once_per_cycle_date_until_it_reads_again(
        self,
    ) -> None:
        self._open()
        (self.root / "manifest.json").unlink()

        stderr_text = self._cycle("2026-10-07")
        self._cycle("2026-10-07")
        self._cycle("2026-10-08")
        self._write_manifest({**_SCOPED, **_UNSCOPED})
        self._cycle("2026-10-09")
        self._cycle("2026-10-10")

        self.assertIn("WARN: A/A harness — fingerprint unreadable", stderr_text)
        self.assertEqual(
            [
                (row.payload["reason"], row.payload["fingerprint"], row.dedupe_key)
                for row in self._get_restarts()
            ],
            [
                ("fingerprint-unreadable", None, "aa-restart:1:2026-10-07"),
                ("fingerprint-unreadable", None, "aa-restart:1:2026-10-08"),
                ("fingerprint-changed", _SCOPED, "aa-restart:1:2026-10-09"),
            ],
        )


class NoOpenAaTest(_AaFixture):
    def test_no_aa_row_is_written_unless_an_aa_start_is_open(self) -> None:
        def _close() -> None:
            self._open()
            self.ledger.write(
                stub.get_trial_ledger().EVENT.AA_RESULT,
                stub.get_trial_ledger().ACTOR.AA,
                {"overall": "pass"},
                dedupe_key="aa-result:1",
            )

        for name, arrange in (
            ("no aa-start ever", lambda: None),
            ("the A/A has its aa-result", _close),
        ):
            with self.subTest(name):
                self._install()
                arrange()
                rows_before = list(self.ledger.rows)
                self._write_manifest(
                    {**_UNSCOPED}
                )  # no scoped entry → unreadable if read

                stderr_text = self._cycle()

                self.assertEqual(self.ledger.rows, rows_before)
                self.assertEqual(stderr_text, "")


class AaLedgerFaultTest(_AaFixture):
    def test_a_ledger_fault_is_warned_by_name_and_never_fails_the_cycle(self) -> None:
        self._open()
        self._set_hash("autoagent/daemon_cycle.py", "f" * 64)
        with self.subTest("the open-state read faults"):
            self.ledger.faulted.add(dc.AA.SQL.LATEST_START)
            stderr_text = self._cycle()
            self.assertIn(
                "WARN: A/A harness — open state unreadable: ConnectionError",
                stderr_text,
            )
            self.assertIn("no A/A evaluation this cycle", stderr_text)
            self.assertEqual(self._get_restarts(), [])
            self.ledger.faulted.clear()
        with self.subTest("the restart write faults"):
            self.ledger.write_fault = ConnectionError("PG unreachable")
            stderr_text = self._cycle()
            self.assertIn(
                f"WARN: A/A harness — aa-restart:1:{_CYCLE_DATE} not written: ConnectionError",
                stderr_text,
            )


class SealTest(_AaFixture):
    def test_the_seal_alone_lets_the_stage_reach_no_ledger_and_names_the_read_seam(
        self,
    ) -> None:
        reach = seal_pg_reach(self)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            dc.run_aa_stage(_CYCLE_DATE)
        self.assertEqual(reach, [])
        self.assertIn("WARN: A/A harness — open state unreadable", stderr.getvalue())
        self._patch("HAS_PG_LOOP_WRITE", True)
        with contextlib.redirect_stderr(io.StringIO()):
            dc.run_aa_stage(_CYCLE_DATE)
        self.assertEqual(reach, ["_pg_connect"])


class AaSandboxDefaultTest(_AaFixture):
    """The stage acts only from a code tree its own rendered config.toml declares as its
    [paths].root; any other tree reads, deletes and writes nothing."""

    def test_only_the_declared_install_reads_deletes_and_writes(self) -> None:
        link = self.scratch / "install-link"
        link.symlink_to(self.root)
        rows = (
            ("the declared install", self.root, self.root, True),
            ("the declared install through a symlinked path", link, self.root, True),
            ("a tree with no rendered config", self.root, None, False),
            ("a tree whose config declares another root", self.root, self.scratch, False),
        )
        for name, install_root, declared, is_acting in rows:
            with self.subTest(name):
                connect = self._run_moved_open_aa(install_root, declared)
                listing = sorted(path.name for path in self.canary_dir.iterdir())
                self.assertEqual(
                    (connect.called, bool(self._get_restarts()), "stray.json" in listing),
                    (is_acting, is_acting, not is_acting),
                )

    def _run_moved_open_aa(self, install_root: Path, declared: Path | None) -> mock.Mock:
        """An open A/A whose fingerprint moved, a stray canary file beside it."""
        self._install()
        if declared is None:
            (self.root / "config.toml").unlink()
        else:
            _put_config(self.root, declared)
        self._open()
        self._set_hash("autoagent/daemon_cycle.py", "9" * 64)
        self.canary_dir.mkdir(parents=True, exist_ok=True)
        (self.canary_dir / "stray.json").write_text("{}", encoding="utf-8")
        connect = mock.Mock(wraps=self.ledger.connect)
        with (
            mock.patch.object(dc, "_INSTALL_ROOT", install_root),
            mock.patch.object(dc, "_pg_connect", connect),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            dc.run_aa_stage(_CYCLE_DATE, agents_dir=self.agents_dir)
        return connect


_PROBE = _TEST_DIR / "_aa_unsealed_probe.py"
# the refusal every install-guarded entry names, from a tree no config.toml declares as its own root
_REFUSAL = "declares that tree as its [paths].root"


def _put_code_tree(root: Path) -> Path:
    """A copy of the code the probe loads, rooted at `root` and holding no rendered config.toml;
    the copied probe's path."""
    for pattern in ("autoagent/*.py", "hooks/*.py", "scripts/*.py"):
        for source in _REPO_ROOT.glob(pattern):
            target = root / source.relative_to(_REPO_ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    shutil.copytree(
        _REPO_ROOT / "autoagent" / "lib",
        root / "autoagent" / "lib",
        ignore=shutil.ignore_patterns("test", "__pycache__"),
    )
    probe = root / _PROBE.relative_to(_REPO_ROOT)
    probe.parent.mkdir()
    shutil.copy2(_PROBE, probe)
    return probe


class AaUnsealedRunTest(unittest.TestCase):
    """The three install-guarded entries — a writing run_cycle through the CLI, run_aa_stage and
    ingest_manifest_log, each refusing first, with or without the PG layer — unsealed, in a child
    running a code tree this test copies, so the tree's install identity is the test's, never that
    of the tree the suite runs from. The child's "live" is a decoy: a temp HOME holding the default data root with its canary files and
    a live MANIFEST log, PGHOST and PGPORT on an empty temp socket dir, and neither GA_DATA_ROOT
    nor EPH_SOCKDIR."""

    _INHERITED = (
        "GA_DATA_ROOT", "EPH_SOCKDIR", "EPH_PORT", "PGHOSTADDR", "PGSERVICE", "PGDATABASE"
    )

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name) / "home"
        self.data_root = self.home / ".glass-atrium"
        canary_dir = self.data_root / "data" / "learning" / "canary"
        canary_dir.mkdir(parents=True)
        for name in ("glass-atrium-dev-python.json", "stray.json"):
            (canary_dir / name).write_text('{"text": ""}', encoding="utf-8")
        live_log = self.data_root / "logs" / dc.MANIFEST.LOG_NAME
        live_log.parent.mkdir()
        live_log.write_text('{"agent_type": "glass-atrium-dev-python"}\n', encoding="utf-8")
        self.sockdir = Path(tmp.name) / "sock"
        self.sockdir.mkdir()
        self.code_root = Path(tmp.name).resolve() / "code"
        self.probe = _put_code_tree(self.code_root)
        self.env = {k: v for k, v in os.environ.items() if k not in self._INHERITED}
        self.env.update(
            HOME=str(self.home),
            PGHOST=str(self.sockdir),
            PGPORT="5432",
            PYTHONDONTWRITEBYTECODE="1",
            # the decoy HOME hides the user site-packages: keep this interpreter's own
            PYTHONUSERBASE=site.getuserbase(),
            AA_PROBE_CODE_ROOT=str(self.code_root),
        )

    def test_an_unsealed_run_from_a_non_install_tree_reaches_no_socket_under_any_runner(
        self,
    ) -> None:
        before = self._get_data_listing()
        for name, args in self._get_runners():
            with self.subTest(name):
                if args[:2] == ("-m", "pytest") and importlib.util.find_spec("pytest") is None:
                    self.skipTest("pytest not installed for this interpreter")
                run = self._run_probe(args)
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertEqual(run.stderr.count(_REFUSAL), 3, run.stderr)  # one per entry
                self.assertNotIn(str(self.sockdir), run.stderr)
                self.assertEqual(self._get_data_listing(), before)

    def test_the_decoy_names_a_reach_from_each_entry_once_the_code_tree_is_the_install(
        self,
    ) -> None:
        # instrument check for the test above: an entry that does reach the decoy names its socket
        if importlib.util.find_spec("psycopg") is None:
            self.skipTest("psycopg not installed: the entries make no connect to observe")
        _put_config(self.code_root, self.code_root)
        for method in (
            "test_run_aa_stage_unsealed",
            "test_ingest_manifest_log_unsealed",
            "test_writing_run_cycle_unsealed",
        ):
            with self.subTest(method):
                run = self._run_probe((str(self.probe), f"AaUnsealedProbe.{method}"))
                self.assertIn(str(self.sockdir), run.stderr)
                self.assertNotIn(_REFUSAL, run.stderr)

    def _get_runners(self) -> tuple[tuple[str, tuple[str, ...]], ...]:
        return (
            (
                "unittest discover",
                ("-m", "unittest", "discover", "-s", str(self.probe.parent), "-p", _PROBE.name),
            ),
            ("unittest, one file", (str(self.probe),)),
            (
                "pytest, one file",
                ("-m", "pytest", "-q", "-s", "-p", "no:cacheprovider", str(self.probe)),
            ),
        )

    def _run_probe(self, args: tuple[str, ...]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, *args],
            env=self.env,
            cwd=self.home,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )

    def _get_data_listing(self) -> list[str]:
        return sorted(str(path.relative_to(self.data_root)) for path in self.data_root.rglob("*"))


_ROSTER = ("glass-atrium-dev-python", "glass-atrium-dev-shell")
_START = _NOW - timedelta(days=15)
# frozen rule small enough for a fixture: both roster agents need 4 spawns in the first 14 days
_SMALL_DURATION = {
    "days": 14,
    "extended_days": 28,
    "busiest_agents": 2,
    "minimum_spawns": 4,
}


def _spawn(
    agent_id: str | None, session_id: str | None, day: float, **facts: object
) -> SpawnFacts:
    """A settled spawn `day` days into the window; `overage` rows and a SubagentStop by default."""
    return SpawnFacts(
        agent_id,
        session_id,
        _START + timedelta(days=day),
        int(facts.get("overage", 0)),
        bool(facts.get("stop", True)),
        (),
        tool_use_actual=facts.get("tool_use"),
    )


def _get_arm(salt_id: int, agent_id: str) -> int:
    """sha256 of the decimal salt then the MANIFEST agent_id, mod 2 — the hook's byte form."""
    return int(hashlib.sha256(f"{salt_id}{agent_id}".encode()).hexdigest(), 16) % 2


def _exposed(spawn: SpawnFacts, salt_id: int = 1) -> SpawnFacts:
    """The spawn as the hook records it under `salt_id`: its arm, and delivery on treatment only."""
    arm = _get_arm(salt_id, spawn.agent_id)
    return spawn._replace(
        arm=arm,
        salt_id=salt_id,
        is_delivered=arm == 1,
        delivered_hash=hashlib.sha256(b"").hexdigest() if arm == 1 else None,
    )


_SPAWNS = SimpleNamespace(
    # overage clustered by session (sessions a, b all events), emit failure spread within sessions
    python=(
        _spawn("p1", "a", 1, overage=1),
        _spawn("p2", "a", 2, overage=1, stop=False),
        _spawn("p3", "b", 3, overage=1),
        _spawn("p4", "b", 4, overage=1, stop=False),
        _spawn("p5", "c", 5),
        _spawn("p6", "c", 6, stop=False),
        _spawn("p7", "d", 7),
        _spawn("p8", "d", 8, stop=False),
    ),
    # no event on either metric → no variance → undefined design effect
    shell=tuple(_spawn(f"s{index}", f"t{index % 2}", index + 1) for index in range(4)),
)
# SUBAGENT_TOOL_BUDGET for rows whose spawns carry tool_use counts
_TOOL_BUDGET = 30
# before the window: a task member the spawn read returns, never counted
_EARLIER_SPAWN = _spawn("p0", "a", -1, overage=1, stop=False)


def _get_expected_python_reading(
    metric_key: str, spawns: tuple[SpawnFacts, ...] = _SPAWNS.python
) -> object:
    """Arm-difference reading of in-window Python spawns under salt 1, clustered by session."""
    is_event = {
        "budget_overage": lambda spawn: (
            spawn.overage_rows > 0 or (spawn.tool_use_actual or 0) >= _TOOL_BUDGET
        ),
        "emit_failure": lambda spawn: not spawn.has_subagent_stop,
    }[metric_key]
    clusters: dict[str, list[tuple[int, float]]] = {}
    for spawn in spawns:
        clusters.setdefault(spawn.session_id, []).append(
            (_get_arm(1, spawn.agent_id), float(is_event(spawn)))
        )
    return trial_design.get_arm_design_effect_reading(
        list(clusters.values()), seed=f"1:glass-atrium-dev-python:{metric_key}"
    )


def _arms(control: tuple[int, int], treatment: tuple[int, int]) -> object:
    return dc.TrialArms(dc.ArmCount(*control), dc.ArmCount(*treatment))


class _AaResultFixture(_AaFixture):
    """An A/A opened 15 days before now under the small duration rule, with evidence that passes."""

    def setUp(self) -> None:
        super().setUp()
        # the shell agent's MANIFEST rows carry its bare alias
        self.spawns = {
            "glass-atrium-dev-python": (
                _EARLIER_SPAWN,
                *map(_exposed, _SPAWNS.python),
            ),
            "dev-shell": tuple(map(_exposed, _SPAWNS.shell)),
        }
        # balance tests an agent from 4 spawns here: both fixture agents are tested
        self._patch_balance(minimum_spawns=4)
        self.spawn_reads: list[tuple[list[str], object]] = []
        self._patch("HAS_PG_PATTERN_READ", True)
        self._patch("_pg_read_spawn_facts", self._read_spawns)
        self.ledger.clock = _START
        self._open(_SMALL_DURATION)
        self.ledger.clock = _NOW
        self._add_outcomes(joined=19, unjoined=1)
        self._add_close(_START + timedelta(days=2), lines_read=10, lines_without_row=0)

    def _patch_balance(self, *, minimum_spawns: int) -> None:
        balance = SimpleNamespace(
            **{**vars(dc.AA.BALANCE), "MINIMUM_SPAWNS": minimum_spawns}
        )
        patcher = mock.patch.object(dc.AA, "BALANCE", balance)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _read_spawns(self, agents: list[str], windows: object) -> tuple[None, dict]:
        self.spawn_reads.append((sorted(agents), windows))
        return None, {agent: list(spawns) for agent, spawns in self.spawns.items()}

    def _add_outcomes(self, *, joined: int, unjoined: int) -> None:
        recorded = _START + timedelta(days=3)
        for index in range(joined):
            self.ledger.outcomes.append(
                _Outcome("glass-atrium-dev-python", recorded, f"j{index}", "a")
            )
            self.ledger.manifest_agent_ids.add(f"j{index}")
        for index in range(unjoined):
            self.ledger.outcomes.append(
                _Outcome("dev-shell", recorded, f"u{index}", None)
            )
        # main-session row: outside the roster, never counted
        self.ledger.outcomes.append(_Outcome("orchestrator", recorded, None, None))

    def _add_close(
        self,
        event_ts: datetime,
        *,
        lines_read: int | None,
        lines_without_row: int | None,
        spool: str | None = None,
    ) -> None:
        name = spool or f"manifest.log.{len(self.ledger.closes)}.spool"
        self.ledger.closes.append(_SpoolClose(name, event_ts, lines_read, lines_without_row))

    def _move_window_start(self, start: datetime) -> None:
        event = stub.get_trial_ledger().EVENT.AA_START
        self.ledger.rows = [
            row._replace(recorded_at=start) if row.event == event else row
            for row in self.ledger.rows
        ]

    def _evaluate(self, cycle_date: str = _CYCLE_DATE, ingest: object = None) -> str:
        return self._cycle(
            cycle_date,
            manifest_ingest=ingest,
            agents_dir=self.agents_dir,
        )

    def _get_results(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(stub.get_trial_ledger().EVENT.AA_RESULT)

    def _get_verdicts(self) -> dict[str, str]:
        (result,) = self._get_results()
        return {
            name: criterion["verdict"]
            for name, criterion in result.payload["criteria"].items()
        }

    def _get_design_effect_rows(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(stub.get_trial_ledger().EVENT.AA_ARM_DESIGN_EFFECT)

    def _get_instrument_verdicts(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(stub.get_trial_ledger().EVENT.AA_INSTRUMENT_VERDICT)

    def _land_verdict_then_evaluate(
        self, faulted: str, days: int, change: Callable[[], None]
    ) -> None:
        """A cycle `days` into the window with `faulted` writes faulting, `change`, then a cycle a
        day later."""
        self._patch("_get_utc_now", lambda: _START + timedelta(days=days))
        self.ledger.faulted_events = {faulted}
        self._evaluate("2026-10-07")
        self.ledger.faulted_events = set()
        change()
        self._patch("_get_utc_now", lambda: _START + timedelta(days=days + 1))
        self._evaluate("2026-10-08")

    def _get_verdict_windows(self) -> list[tuple[str, str, int]]:
        return [
            (row.dedupe_key, row.payload["verdict"], row.payload["window_days"])
            for row in self._get_instrument_verdicts()
        ]


class AaResultTest(_AaResultFixture):
    def test_the_duration_end_writes_one_result_keyed_on_its_start_and_closes_the_aa(
        self,
    ) -> None:
        self._evaluate("2026-10-07")
        self._evaluate("2026-10-08")

        (result,) = self._get_results()
        self.assertEqual(
            (result.actor, result.dedupe_key), ("daemon-cycle-aa", "aa-result:1")
        )
        self.assertEqual(
            result.payload["window"],
            {
                "start": _START.isoformat(),
                "end": (_START + timedelta(days=14)).isoformat(),
                "days": 14,
            },
        )
        self.assertEqual(
            self._get_verdicts(),
            {
                "join_coverage": "pass",
                "sink": "pass",
                "balance": "pass",
                "delivery": "pass",
                "engine": "pass",
                "design_effect": "pass",
            },
        )
        self.assertEqual(result.payload["overall"], "pass")
        self.assertEqual(result.payload["criteria"]["engine"]["looks"], 4)
        # the A/A evidence, then the power check's history for the recomputed break-evens
        self.assertEqual(len(self.spawn_reads), 2)

    def test_the_result_writes_one_arm_difference_row_per_agent_and_metric_key_for_the_power_readers(
        self,
    ) -> None:
        agent = "glass-atrium-dev-python"
        # p5 (session c) records no overage row but reaches the budget on tool_use alone
        python = tuple(
            spawn._replace(tool_use_actual=_TOOL_BUDGET) if spawn.agent_id == "p5" else spawn
            for spawn in _SPAWNS.python
        )
        self.spawns[agent] = (_EARLIER_SPAWN, *map(_exposed, python))
        expected = {
            key: _get_expected_python_reading(key, python)
            for key in ("budget_overage", "emit_failure")
        }

        with mock.patch.dict(os.environ, {"SUBAGENT_TOOL_BUDGET": str(_TOOL_BUDGET)}):
            self._evaluate()

        rows = self._get_design_effect_rows()
        self.assertEqual(
            [(row.agent, row.actor, row.payload, row.dedupe_key) for row in rows],
            [
                (
                    agent,
                    "daemon-cycle-aa",
                    {"metric_key": key, **reading._asdict()},
                    f"aa-arm-design-effect:1:{agent}:{key}",
                )
                for key, reading in expected.items()
            ],
        )
        self.assertEqual(
            dc._get_design_effects([(row.agent, row.payload) for row in rows]),
            (
                {
                    (agent, key): max(reading.value, 1.0)
                    for key, reading in expected.items()
                },
                frozenset(),
            ),
        )
        (result,) = self._get_results()
        self.assertEqual(
            result.payload["criteria"]["design_effect"]["undefined"],
            ["glass-atrium-dev-shell"],
        )

    def test_the_result_records_the_instrument_verdict_once_with_both_break_evens(
        self,
    ) -> None:
        agent = "glass-atrium-dev-python"
        reading = _get_expected_python_reading("budget_overage")

        self._evaluate("2026-10-07")
        self._evaluate("2026-10-08")

        (row,) = self._get_instrument_verdicts()
        self.assertEqual(
            (row.agent, row.actor, row.dedupe_key),
            (None, "daemon-cycle-aa", "aa-instrument-verdict:1"),
        )
        reference = dc.INSTRUMENT.BREAK_EVEN.REFERENCE[agent]
        # the fixture history carries no provenance start → no recomputed break-even
        self.assertEqual(
            row.payload,
            {
                "start_id": 1,
                "metric_key": "budget_overage",
                "window_days": 14,
                "readings": {"recomputed": "undecided", "reference": "undecided"},
                # the reference break-even is at or below 1 → named, never read
                "excluded": {"recomputed": [], "reference": [agent]},
                "verdict": "relay",
                "agents": {
                    agent: {
                        **reading._asdict(),
                        "break_even": {"recomputed": None, "reference": reference},
                    }
                },
            },
        )
        self.assertLess(row.id, self._get_results()[0].id)

    def test_the_evidence_reads_cover_the_roster_with_its_aliases_from_the_window_start(
        self,
    ) -> None:
        self._evaluate()

        (agents, windows), _ = self.spawn_reads
        self.assertTrue(set(_ROSTER) | {"dev-python", "dev-shell"} <= set(agents))
        self.assertEqual(windows.start.baseline, _START)
        (result,) = self._get_results()
        self.assertEqual(
            {
                key: result.payload["criteria"]["join_coverage"][key]
                for key in ("outcomes", "joined")
            },
            {"outcomes": 20, "joined": 19},
        )

    def test_no_result_before_the_duration_ends(self) -> None:
        self._install()
        self.ledger.clock = _NOW - timedelta(days=13)
        self._open(_SMALL_DURATION)

        self._evaluate()

        self.assertEqual(self._get_results(), [])
        self.assertEqual(self.spawn_reads, [])

    def test_a_restart_restarts_the_window_the_duration_runs_from(self) -> None:
        self.ledger.clock = _START + timedelta(days=10)
        self.ledger.write(
            stub.get_trial_ledger().EVENT.AA_RESTART,
            stub.get_trial_ledger().ACTOR.AA,
            {"start_id": 1, "reason": "fingerprint-changed", "fingerprint": _SCOPED},
            dedupe_key="aa-restart:1:2026-10-02",
        )

        self._evaluate()

        self.assertEqual(self._get_results(), [])

    def test_a_short_busiest_agent_at_day_14_extends_the_window_to_its_longer_duration(
        self,
    ) -> None:
        self.spawns["dev-shell"] = _SPAWNS.shell[:3]

        self._evaluate("2026-10-07")
        self.assertEqual(self._get_results(), [])
        self._patch("_get_utc_now", lambda: _START + timedelta(days=29))
        self._evaluate("2026-10-21")

        (result,) = self._get_results()
        self.assertEqual(result.payload["window"]["days"], 28)

    def test_a_straddle_at_the_duration_end_extends_the_window_once_and_keeps_the_aa_open(
        self,
    ) -> None:
        agent = "glass-atrium-dev-python"
        reading = _get_expected_python_reading("budget_overage")
        self.assertLess(max(reading.lower, 1.0), reading.upper)
        # above 1 and inside the interval → both readings straddle
        straddled = {agent: (max(reading.lower, 1.0) + reading.upper) / 2}
        self._patch("_read_recomputed_break_evens", lambda agents, now: straddled)
        with mock.patch.object(dc.INSTRUMENT.BREAK_EVEN, "REFERENCE", straddled):
            self._evaluate("2026-10-07")
            self._evaluate("2026-10-08")
            self.assertEqual((self._get_results(), self._get_design_effect_rows()), ([], []))
            (extension,) = self._get_instrument_verdicts()
            self.assertEqual(
                (
                    extension.dedupe_key,
                    extension.payload["verdict"],
                    extension.payload["window_days"],
                ),
                ("aa-instrument-verdict:1:extend:1", "extend", 14),
            )
            self._patch("_get_utc_now", lambda: _START + timedelta(days=29))
            self._evaluate("2026-10-21")

        (result,) = self._get_results()
        self.assertEqual(result.payload["window"]["days"], 28)
        final = self._get_instrument_verdicts()[-1]
        self.assertEqual(
            (final.dedupe_key, final.payload["window_days"], final.payload["verdict"]),
            ("aa-instrument-verdict:1", 28, "relay"),
        )


    def test_a_landed_verdict_is_read_back_instead_of_deciding_an_extension_at_a_later_cycle(
        self,
    ) -> None:
        agent = "glass-atrium-dev-python"
        reading = _get_expected_python_reading("budget_overage")
        # inside the interval and above 1 → both readings straddle
        straddled = {agent: (max(reading.lower, 1.0) + reading.upper) / 2}
        event = stub.get_trial_ledger().EVENT
        rows = (
            ("the aa-result write faults", event.AA_RESULT),
            ("a design-effect write faults", event.AA_ARM_DESIGN_EFFECT),
        )
        for name, faulted in rows:
            with self.subTest(name):
                self.setUp()
                # above the interval → both readings hold R1 at the duration end
                break_evens = {agent: reading.upper + 1}
                self._patch(
                    "_read_recomputed_break_evens",
                    lambda agents, now, values=break_evens: values,
                )
                patcher = mock.patch.object(dc.INSTRUMENT.BREAK_EVEN, "REFERENCE", break_evens)
                patcher.start()
                self.addCleanup(patcher.stop)

                self._land_verdict_then_evaluate(
                    faulted, 15, functools.partial(break_evens.update, straddled)
                )

                self.assertEqual(
                    self._get_verdict_windows(), [("aa-instrument-verdict:1", "r1-holds", 14)]
                )
                (result,) = self._get_results()
                self.assertEqual(result.payload["window"]["days"], 14)

    def test_a_landed_verdict_holds_the_window_at_its_days_when_late_spawns_would_shorten_it(
        self,
    ) -> None:
        self.spawns["dev-shell"] = tuple(map(_exposed, _SPAWNS.shell[:3]))
        # a spawn started before day 14, ingested after the 28-day verdict landed
        late = {"dev-shell": tuple(map(_exposed, _SPAWNS.shell))}

        self._land_verdict_then_evaluate(
            stub.get_trial_ledger().EVENT.AA_RESULT,
            29,
            functools.partial(self.spawns.update, late),
        )

        self.assertEqual(self._get_verdict_windows(), [("aa-instrument-verdict:1", "relay", 28)])
        (result,) = self._get_results()
        self.assertEqual(result.payload["window"]["days"], 28)

# the power check's history at the A/A's now: provenance 60 days before D, floor-half baseline
# 20 events / 200 spawns, then only reference-half non-events in the 28 days before D
_HISTORY = SimpleNamespace(
    WINDOWS=dc.get_pair_windows(_NOW),
    BASELINE=SimpleNamespace(SPAWNS=200, EVENTS=20),
)
_HISTORY.PROVENANCE_START = _HISTORY.WINDOWS.end - timedelta(days=60)
# bound at design effect 1, from the trial_design reference module, not the code under test
_HISTORY.REQUIRED_UNITS = trial_design.get_required_units(
    trial_design.get_maximum_sample_size(_HISTORY.BASELINE.EVENTS / _HISTORY.BASELINE.SPAWNS),
    design_effect=1.0,
)


def _get_history_spawns(
    count: int, first: datetime, step: timedelta, *, is_floor: bool, events: int = 0
) -> list[SpawnFacts]:
    """`count` settled spawns of one sha256 half, one session each; the first `events` overrun."""
    agent_ids = (
        agent_id
        for agent_id in (f"h{index:07x}" for index in itertools.count())
        if is_floor_half(agent_id) is is_floor
    )
    return [
        SpawnFacts(
            agent_id, f"session-{agent_id}", first + step * index, int(index < events), True, ()
        )
        for index, agent_id in zip(range(count), agent_ids)
    ]


def _get_break_even_history(units: int) -> list[SpawnFacts]:
    """Baseline hourly from D - 40 d, ending before D - 28 d → no unit; `units` by the minute
    from D - 28 d."""
    end = _HISTORY.WINDOWS.end
    baseline = _get_history_spawns(
        _HISTORY.BASELINE.SPAWNS,
        end - timedelta(days=40),
        timedelta(hours=1),
        is_floor=True,
        events=_HISTORY.BASELINE.EVENTS,
    )
    return [
        *baseline,
        *_get_history_spawns(units, end - timedelta(days=28), timedelta(minutes=1), is_floor=False),
    ]


class AaRecomputedBreakEvenTest(_AaResultFixture):
    """The verdict's recomputed break-even is the power check's projection over its bound at
    design effect 1, on the history the power check reads at the A/A's now."""

    def setUp(self) -> None:
        super().setUp()
        agent = "glass-atrium-dev-python"
        self.reading = _get_expected_python_reading("budget_overage")
        # 28-day units whose break-even lies above the interval → the recomputed reading holds R1
        units = math.ceil(
            (self.reading.upper + 1) * _HISTORY.REQUIRED_UNITS * 28 / trial_design.HORIZON_DAYS
        )
        self.break_even = trial_design.get_projected_units(units / 28) / _HISTORY.REQUIRED_UNITS
        history = (_HISTORY.PROVENANCE_START, {agent: _get_break_even_history(units)})
        evidence_read = self._read_spawns
        self._patch(
            "_pg_read_spawn_facts",
            lambda agents, windows: (
                history if windows == _HISTORY.WINDOWS else evidence_read(agents, windows)
            ),
        )

    def _get_verdict_payload(self, reference: float) -> dict:
        agent = "glass-atrium-dev-python"
        with mock.patch.object(dc.INSTRUMENT.BREAK_EVEN, "REFERENCE", {agent: reference}):
            self._evaluate()
        (row,) = self._get_instrument_verdicts()
        return row.payload

    def test_a_reference_equal_to_the_recomputed_break_even_gives_both_readings_and_the_verdict(
        self,
    ) -> None:
        payload = self._get_verdict_payload(self.break_even)

        break_even = payload["agents"]["glass-atrium-dev-python"]["break_even"]
        self.assertAlmostEqual(break_even["recomputed"], self.break_even, places=9)
        self.assertEqual(
            (payload["readings"], payload["verdict"]),
            ({"recomputed": "r1-holds", "reference": "r1-holds"}, "r1-holds"),
        )

    def test_a_reference_disagreeing_with_the_recomputed_break_even_relays_to_the_owner(
        self,
    ) -> None:
        # the reference at the interval's upper bound, above 1 → the reference reading straddles
        self.assertLess(1.0, self.reading.upper)
        payload = self._get_verdict_payload(self.reading.upper)

        self.assertEqual(
            (payload["readings"], payload["verdict"]),
            ({"recomputed": "r1-holds", "reference": "straddle"}, "relay"),
        )


class AaResultFailTest(_AaResultFixture):
    def test_each_failing_criterion_fails_the_result(self) -> None:
        def _lose_a_line_in_the_window() -> None:
            self._add_close(_START + timedelta(days=5), lines_read=10, lines_without_row=1)

        def _close_before_the_count_columns() -> None:
            self._add_close(_START + timedelta(days=6), lines_read=None, lines_without_row=None)

        def _remove_every_event() -> None:
            self.spawns["glass-atrium-dev-python"] = tuple(
                _exposed(_spawn(f"q{index}", f"r{index % 3}", index + 1))
                for index in range(6)
            )

        def _put_every_shell_spawn_in_treatment() -> None:
            # the Python agent keeps both arms, so its arm-difference design effect stays defined;
            # every shell spawn an overage → the pooled treatment rate stays at control's 3/4
            treated = [
                f"t{index}" for index in range(100) if _get_arm(1, f"t{index}") == 1
            ][:8]
            self.spawns["dev-shell"] = tuple(
                _exposed(_spawn(agent_id, f"t{index % 2}", index + 1, overage=1))
                for index, agent_id in enumerate(treated)
            )

        def _set_python_delivery(arm: int, is_delivered: bool) -> None:
            spawns = list(self.spawns["glass-atrium-dev-python"])
            index = next(
                index for index, spawn in enumerate(spawns) if spawn.arm == arm
            )
            spawns[index] = spawns[index]._replace(is_delivered=is_delivered)
            self.spawns["glass-atrium-dev-python"] = tuple(spawns)

        lost_now = dc.ManifestIngest(
            "ok", [dc.ManifestSpoolClose("manifest.log.spool", 4, 3)]
        )
        rows = (
            (
                "an agent's arm split fails the sample-ratio test",
                _put_every_shell_spawn_in_treatment,
                None,
                "balance",
            ),
            (
                "a treatment spawn missed its delivery",
                lambda: _set_python_delivery(1, False),
                None,
                "delivery",
            ),
            (
                "a control spawn received the canary",
                lambda: _set_python_delivery(0, True),
                None,
                "delivery",
            ),
            (
                "join coverage below 95%",
                lambda: self._add_outcomes(joined=0, unjoined=2),
                None,
                "join_coverage",
            ),
            (
                "no roster outcome in the window",
                lambda: self.ledger.outcomes.clear(),
                None,
                "join_coverage",
            ),
            ("a window close lost a line", _lose_a_line_in_the_window, None, "sink"),
            (
                "a window close recorded before the count columns",
                _close_before_the_count_columns,
                None,
                "sink",
            ),
            ("this cycle's close lost a line", lambda: None, lost_now, "sink"),
            (
                "no agent's design effect is defined",
                _remove_every_event,
                None,
                "design_effect",
            ),
        )
        for name, arrange, ingest, criterion in rows:
            with self.subTest(name):
                self.setUp()
                arrange()

                self._evaluate(ingest=ingest)

                verdicts = self._get_verdicts()
                self.assertEqual(verdicts[criterion], "fail")
                self.assertEqual(
                    [key for key, verdict in verdicts.items() if verdict == "fail"],
                    [criterion],
                )
                self.assertEqual(self._get_results()[0].payload["overall"], "fail")


class AaArmsResultTest(_AaResultFixture):
    def test_a_hook_arm_differing_from_the_recomputed_arm_is_recorded_in_the_result(
        self,
    ) -> None:
        spawns = list(self.spawns["dev-shell"])
        spawns[0] = spawns[0]._replace(arm=1 - spawns[0].arm)
        self.spawns["dev-shell"] = tuple(spawns)

        self._evaluate()

        (result,) = self._get_results()
        delivery = result.payload["criteria"]["delivery"]
        self.assertEqual(delivery["arm_mismatches"], {"glass-atrium-dev-shell": 1})
        self.assertEqual(delivery["verdict"], "pass")

    def test_the_arms_are_recomputed_from_the_newest_window_row_id_as_the_salt(
        self,
    ) -> None:
        self._install()
        self.ledger.clock = _START - timedelta(days=1)
        self._open(_SMALL_DURATION)
        self.ledger.clock = _START
        self.ledger.write(
            stub.get_trial_ledger().EVENT.AA_RESTART,
            stub.get_trial_ledger().ACTOR.AA,
            {"start_id": 1, "reason": "fingerprint-changed", "fingerprint": _SCOPED},
            dedupe_key="aa-restart:1:2026-09-22",
        )
        self.ledger.clock = _NOW
        self._add_outcomes(joined=19, unjoined=1)
        self.spawns = {
            "glass-atrium-dev-python": tuple(
                _exposed(spawn, salt_id=2) for spawn in _SPAWNS.python
            ),
            "dev-shell": tuple(_exposed(spawn, salt_id=2) for spawn in _SPAWNS.shell),
        }

        self._evaluate()

        (result,) = self._get_results()
        delivery = result.payload["criteria"]["delivery"]
        self.assertEqual(
            (delivery["verdict"], delivery["arm_mismatches"]), ("pass", {})
        )


class AaSinkTest(_AaResultFixture):
    def _get_sink(self) -> dict:
        (result,) = self._get_results()
        return result.payload["criteria"]["sink"]

    def test_the_sink_counts_each_close_recorded_from_the_window_start_once(self) -> None:
        now_close = dc.ManifestSpoolClose("manifest.log.now.spool", 4, 3)
        rows = (
            (
                "a close recorded before the window start is not read",
                lambda: self._add_close(
                    _START - timedelta(seconds=1), lines_read=10, lines_without_row=10
                ),
                None,
                ("pass", 1, 0),
            ),
            (
                "a close recorded at the window start is read",
                lambda: self._add_close(_START, lines_read=10, lines_without_row=1),
                None,
                ("fail", 2, 1),
            ),
            (
                "two writing cycles on one UTC date keep both closes",
                lambda: [
                    self._add_close(
                        _START + timedelta(days=3, hours=hour),
                        lines_read=10,
                        lines_without_row=1,
                    )
                    for hour in (1, 2)
                ],
                None,
                ("fail", 3, 2),
            ),
            (
                "this cycle's close counts once beside its own row",
                lambda: self._add_close(
                    _NOW, lines_read=4, lines_without_row=1, spool=now_close.spool
                ),
                dc.ManifestIngest("ok", [now_close]),
                ("fail", 2, 1),
            ),
        )
        for name, arrange, ingest, expected in rows:
            with self.subTest(name):
                self.setUp()
                arrange()

                self._evaluate(ingest=ingest)

                sink = self._get_sink()
                self.assertEqual(
                    (sink["verdict"], sink["spools"], sink["lines_lost"]), expected
                )

    def test_a_close_without_its_counts_fails_the_sink_by_name_not_as_zero_lost(
        self,
    ) -> None:
        self._add_close(
            _START + timedelta(days=4),
            lines_read=None,
            lines_without_row=None,
            spool="manifest.log.pre-column.spool",
        )

        self._evaluate()

        sink = self._get_sink()
        self.assertEqual(
            (sink["verdict"], sink["lines_lost"], sink["uncounted_closes"]),
            ("fail", 0, ["manifest.log.pre-column.spool"]),
        )

    def test_a_schema_without_the_count_columns_fails_the_sink_with_a_named_warn(
        self,
    ) -> None:
        self.ledger.is_count_absent = True

        stderr_text = self._evaluate()

        sink = self._get_sink()
        self.assertEqual(sink["verdict"], "fail")
        self.assertIs(sink["count_columns_absent"], True)
        self.assertIn(
            "WARN: A/A harness — sink: core.autoagent_loop_events has no lines_read / "
            "lines_without_row (apply migration 20261010000000_add_loop_event_spool_close_counts)",
            stderr_text,
        )


class AaOutageTest(_AaResultFixture):
    def test_an_unreadable_evidence_source_warns_by_name_and_writes_nothing(
        self,
    ) -> None:
        def _refuse_spawn_read(*args: object) -> None:
            raise ConnectionError("PG unreachable")

        rows = (
            (
                "the join read faults",
                lambda: self.ledger.faulted.add(dc.AA.SQL.JOIN_COVERAGE),
                "evidence unreadable: ConnectionError",
            ),
            (
                "the spool-close read faults",
                lambda: self.ledger.faulted.add(dc.AA.SQL.SPOOL_CLOSES),
                "evidence unreadable: ConnectionError",
            ),
            (
                "the spawn read faults",
                lambda: self._patch("_pg_read_spawn_facts", _refuse_spawn_read),
                "evidence unreadable: ConnectionError",
            ),
            (
                "the pattern reads did not import",
                lambda: self._patch("HAS_PG_PATTERN_READ", False),
                "evidence unreadable: AaEvidenceUnreadable: PG pattern reads",
            ),
        )
        for name, arrange, cause in rows:
            with self.subTest(name):
                self.setUp()
                arrange()
                rows_before = list(self.ledger.rows)

                stderr_text = self._evaluate()

                self.assertIn(f"WARN: A/A harness — A/A 1 {cause}", stderr_text)
                self.assertIn("no A/A evaluation this cycle", stderr_text)
                self.assertEqual(self.ledger.rows, rows_before)

    def test_a_design_effect_write_fault_defers_the_result_to_a_later_cycle(
        self,
    ) -> None:
        self.ledger.faulted_events = {stub.get_trial_ledger().EVENT.AA_ARM_DESIGN_EFFECT}

        stderr_text = self._evaluate("2026-10-07")
        self.ledger.faulted_events = set()
        self._evaluate("2026-10-08")

        self.assertIn(
            "WARN: A/A harness — aa-arm-design-effect:1:glass-atrium-dev-python:budget_overage"
            " not written",
            stderr_text,
        )
        self.assertIn("aa-result deferred to a later cycle", stderr_text)
        self.assertEqual(len(self._get_results()), 1)
        self.assertEqual(len(self._get_design_effect_rows()), 2)
        self.assertEqual(len(self._get_instrument_verdicts()), 1)

    def test_an_unreadable_break_even_history_defers_the_verdict_and_the_result(
        self,
    ) -> None:
        reads = iter((self._read_spawns, _fail_spawn_read))
        self._patch("_pg_read_spawn_facts", lambda *args: next(reads)(*args))

        stderr_text = self._evaluate()

        self.assertIn("break-even history unreadable: ConnectionError", stderr_text)
        self.assertIn("aa-result deferred to a later cycle", stderr_text)
        self.assertEqual((self._get_instrument_verdicts(), self._get_results()), ([], []))


class CycleWiringTest(_AaResultFixture):
    """run_cycle runs the stage on a writing cycle, fed this cycle's MANIFEST ingest and its
    agents_dir; no-write mode (--dry-run → skip_loop_emit) writes no ledger row."""

    def setUp(self) -> None:
        super().setUp()
        env = mock.patch.dict(
            os.environ,
            {
                "GA_DATA_ROOT": str(self.scratch),
                "AUTOAGENT_REPORTS_DIR": str(self.scratch / "reports"),
            },
        )
        env.start()
        self.addCleanup(env.stop)

        def _refuse(*args: object, **kwargs: object) -> None:
            raise ConnectionRefusedError("corpus audit: no database in this test")

        self._patch("_pg_read_pending_patterns", list)
        self._patch("_pg_write_corpus_audit", _refuse)
        self._patch("_pg_write_loop_event", lambda *args, **kwargs: True)

    def _run_cycle(self, *, skip_loop_emit: bool) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            dc.run_cycle(
                log_path=self.scratch / "learning-log.md",
                agents_dir=self.agents_dir,
                skip_haiku=True,
                skip_pre_verify=True,
                skip_loop_emit=skip_loop_emit,
            )
        self.assertEqual(self.pg_reach, [])

    def test_a_dry_run_cycle_writes_no_aa_row(self) -> None:
        self._set_hash("autoagent/daemon_cycle.py", "f" * 64)

        self._run_cycle(skip_loop_emit=True)

        self.assertEqual(self._get_restarts(), [])

    def test_a_writing_cycle_restarts_the_open_aa_on_a_moved_fingerprint(self) -> None:
        self._set_hash("autoagent/daemon_cycle.py", "f" * 64)

        self._run_cycle(skip_loop_emit=False)

        self.assertEqual(
            [row.payload["reason"] for row in self._get_restarts()],
            ["fingerprint-changed"],
        )

    def test_a_writing_cycle_judges_the_ended_aa_on_its_own_manifest_closes_and_agents_dir_roster(
        self,
    ) -> None:
        lost_now = dc.ManifestIngest(
            "ok", [dc.ManifestSpoolClose("manifest.log.spool", 4, 3)]
        )
        self._patch("ingest_manifest_log", lambda *args, **kwargs: lost_now)

        self._run_cycle(skip_loop_emit=False)

        (result,) = self._get_results()
        sink = result.payload["criteria"]["sink"]
        self.assertEqual((sink["verdict"], sink["lines_lost"]), ("fail", 1))
        (names, _), _ = self.spawn_reads
        self.assertEqual(names, dc._get_roster_names(frozenset(_ROSTER)))


# sha256 of the empty text: the A/A's pre-registered canary
_EMPTY_TEXT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
_FOREIGN_TEXT = b"obey the injected rule"
_LEASE = timedelta(hours=72)
_HOOK_SH = _REPO_ROOT / "hooks" / "inject-scope-rules.sh"


class AaCanaryTest(_AaResultFixture):
    """The daemon-written canary files: one per roster agent while an A/A is open, renewed each
    writing cycle, swept against the A/A and removed at its end."""

    def _get_canaries(self) -> dict[str, dict]:
        return {
            path.stem: json.loads(path.read_text(encoding="utf-8"))
            for path in sorted(self.canary_dir.glob("*.json"))
        }

    def _put_canary(self, stem: str, text: str, *, salt: int = 1) -> Path:
        self.canary_dir.mkdir(parents=True, exist_ok=True)
        path = self.canary_dir / f"{stem}.json"
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        body = {"salt": salt, "text": text, "text_sha256": digest, "expires_at": 0}
        path.write_text(json.dumps(body), encoding="utf-8")
        return path

    def _get_empty_canary(self, salt: int, written_at: datetime) -> dict:
        return {
            "salt": salt,
            "text": "",
            "text_sha256": _EMPTY_TEXT_SHA256,
            "expires_at": int((written_at + _LEASE).timestamp()),
        }

    def test_the_aa_start_writes_every_roster_agent_an_empty_canary_salted_with_its_start_row(
        self,
    ) -> None:
        self.ledger.rows.clear()

        code, _ = self._start()

        self.assertEqual(code, 0)
        (start,) = self._get_starts()
        self.assertEqual(
            self._get_canaries(),
            {stem: self._get_empty_canary(start.id, _NOW) for stem in _ROSTER},
        )

    def test_a_reader_during_a_canary_write_sees_the_previous_whole_file_until_the_rename(
        self,
    ) -> None:
        self._move_window_start(_NOW - timedelta(days=3))
        self._evaluate("2026-10-06")
        previous = self._get_canaries()
        seen: dict[str, dict] = {}
        replace = os.replace

        def _replace_and_read(source: str, target: str, **dir_fds: int) -> None:
            seen[Path(target).stem] = json.loads(
                (self.canary_dir / target).read_text(encoding="utf-8")
            )
            replace(source, target, **dir_fds)

        with mock.patch.object(dc.os, "replace", _replace_and_read):
            self._evaluate()

        self.assertEqual(set(seen), set(_ROSTER), "every rewrite lands by a rename")
        self.assertEqual(seen, previous)

    def test_a_cycle_after_a_skipped_day_renews_each_lease_before_it_expires(
        self,
    ) -> None:
        self._move_window_start(_NOW - timedelta(days=3))
        start_id = self._get_starts()[0].id
        self._patch("_get_utc_now", lambda: _NOW - timedelta(days=2))
        self._evaluate("2026-10-05")
        before = self._get_canaries()
        self._patch("_get_utc_now", lambda: _NOW)

        self._evaluate()

        for stem in _ROSTER:
            self.assertGreater(before[stem]["expires_at"], _NOW.timestamp(), stem)
        self.assertEqual(
            self._get_canaries(),
            {stem: self._get_empty_canary(start_id, _NOW) for stem in _ROSTER},
        )

    def _spawn_hook(self) -> str:
        """One real SubagentStart of the python agent as agent_id a1 → its MANIFEST line."""
        home = self.scratch / "home"
        home.mkdir(exist_ok=True)
        manifest_log = self.scratch / "manifest.log"
        envelope = json.dumps(
            {"agent_type": "glass-atrium-dev-python", "agent_id": "a1"}
        )
        result = subprocess.run(
            ["bash", str(_HOOK_SH)],
            input=envelope,
            env={
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "HOME": str(home),
                "GA_DATA_ROOT": str(self.data_root),
                "SUBAGENT_BUDGET_METER_OFF": "1",
                "INJECT_SCOPE_RULES_AGENTS_DIR": "/nonexistent",
                "INJECT_SCOPE_RULES_BUDGET_SRC": "/nonexistent",
                "INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC": "/nonexistent",
                "INJECT_SCOPE_RULES_MANIFEST_LOG": str(manifest_log),
                "INJECT_SCOPE_RULES_DROP_LOG": str(self.scratch / "drop.log"),
                "INJECT_SCOPE_RULES_SPAWN_COUNTER": str(self.scratch / "spawns"),
            },
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return manifest_log.read_text(encoding="utf-8").splitlines()[-1]

    def test_the_hook_delivers_a_daemon_written_canary_only_inside_its_lease(
        self,
    ) -> None:
        rows = (
            ("in lease", timedelta(0), "1"),
            ("lease ended", _LEASE + timedelta(minutes=1), "0"),
        )
        for name, age, delivered in rows:
            with self.subTest(name):
                written_at = datetime.now(timezone.utc) - age
                # salt 7 puts agent_id a1 in the treatment arm
                dc.put_canary_file("glass-atrium-dev-python", 7, "", written_at)

                manifest_line = self._spawn_hook()

                self.assertIn(" arm=1 ", manifest_line)
                self.assertIn(f" delivered={delivered} ", manifest_line)

    def test_the_daemon_reads_a_canary_file_exactly_up_to_the_size_the_hook_reads(
        self,
    ) -> None:
        self._move_window_start(_NOW - timedelta(days=1))
        path = self.canary_dir / "glass-atrium-dev-python.json"
        bound = dc.CANARY.FILE_MAX_BYTES
        rows = (("at the bound", bound, True), ("one byte over", bound + 1, False))
        for name, size, is_readable in rows:
            with self.subTest(name):
                # salt 7 puts agent_id a1 in the treatment arm
                dc.put_canary_file(
                    "glass-atrium-dev-python", 7, "", datetime.now(timezone.utc)
                )
                body = path.read_bytes()
                path.write_bytes(body + b" " * (size - len(body)))

                # the hook first: the daemon's stage rewrites the file
                manifest_line = self._spawn_hook()
                stderr_text = self._evaluate()

                self.assertIn(f" delivered={int(is_readable)} ", manifest_line)
                self.assertEqual(
                    f"canary {path} removed — unreadable" in stderr_text,
                    not is_readable,
                )

    def test_the_result_removes_every_canary_file(self) -> None:
        for stem in _ROSTER:
            self._put_canary(stem, "")

        self._evaluate()

        self.assertEqual(len(self._get_results()), 1)
        self.assertEqual(self._get_canaries(), {})

    def test_a_restart_rewrites_every_canary_with_the_restart_row_as_its_salt(
        self,
    ) -> None:
        self._move_window_start(_NOW - timedelta(days=1))
        self._evaluate("2026-10-06")
        self._set_hash("autoagent/daemon_cycle.py", "f" * 64)

        self._evaluate()

        (restart,) = self._get_restarts()
        self.assertEqual(
            {stem: body["salt"] for stem, body in self._get_canaries().items()},
            dict.fromkeys(_ROSTER, restart.id),
        )

    def test_a_canary_file_for_an_agent_with_no_open_aa_is_removed_and_logged(
        self,
    ) -> None:
        def _close() -> None:
            self.ledger.write(
                stub.get_trial_ledger().EVENT.AA_RESULT,
                stub.get_trial_ledger().ACTOR.AA,
                {"overall": "pass"},
                dedupe_key=f"aa-result:{self._get_starts()[0].id}",
            )

        rows = (
            (
                "an agent outside the roster, A/A open",
                "glass-atrium-retired",
                lambda: None,
            ),
            ("a roster agent, A/A closed", "glass-atrium-dev-python", _close),
        )
        for name, stem, arrange in rows:
            with self.subTest(name):
                self._move_window_start(_NOW - timedelta(days=1))
                arrange()
                path = self._put_canary(stem, "")

                stderr_text = self._evaluate()

                self.assertFalse(path.exists(), name)
                self.assertIn(f"canary {path} removed", stderr_text)

    def test_an_entry_not_named_exactly_as_a_roster_canary_is_removed_unvoided_open_aa_or_not(
        self,
    ) -> None:
        exact_names = {f"{stem}.json" for stem in _ROSTER}
        variants = (
            ("a name-case variant", "GLASS-ATRIUM-DEV-PYTHON.json"),
            ("an extension-case variant", "glass-atrium-dev-python.JSON"),
            ("a Unicode-folding variant", "glaſſ-atrium-dev-python.json"),
        )
        for name, entry in variants:
            for is_open, kept_names in ((True, exact_names), (False, set())):
                with self.subTest(name, is_open=is_open):
                    self.ledger.rows = self._get_starts()  # the A/A open again
                    self._move_window_start(_NOW - timedelta(days=1))
                    if not is_open:
                        self.ledger.write(
                            stub.get_trial_ledger().EVENT.AA_RESULT,
                            stub.get_trial_ledger().ACTOR.AA,
                            {"overall": "pass"},
                            dedupe_key=f"aa-result:{self._get_starts()[0].id}",
                        )
                    results_before = self._get_results()
                    self.canary_dir.mkdir(parents=True, exist_ok=True)
                    for stale in self.canary_dir.iterdir():
                        stale.unlink()
                    path = self.canary_dir / entry
                    path.write_bytes(self._get_foreign_canary(b'""'))
                    # the hook lists the directory byte-exactly, so the variant never delivers
                    self.assertIn(" delivered=0 ", self._spawn_hook())

                    stderr_text = self._evaluate_bounded()

                    self.assertIn(f"canary {path} removed", stderr_text)
                    self.assertEqual(self._get_results(), results_before)
                    # the listing, not an open: a folding volume resolves the variant to the exact file
                    self.assertEqual(
                        {entry.name for entry in self.canary_dir.iterdir()}, kept_names
                    )

    def test_a_charter_canary_an_earlier_roster_wrote_is_removed_unvoided_by_the_next_cycle(
        self,
    ) -> None:
        self._move_window_start(_NOW - timedelta(days=1))
        stray = self._put_canary("GLASS_ATRIUM_GLOBAL_RULES", "")
        results_before = self._get_results()

        stderr_text = self._evaluate_bounded()

        self.assertIn(f"canary {stray} removed", stderr_text)
        self.assertEqual(self._get_results(), results_before)
        self.assertEqual(set(self._get_canaries()), set(_ROSTER))

    def test_a_roster_entry_the_hook_cannot_read_is_removed_unread_and_rewritten(
        self,
    ) -> None:
        self._move_window_start(_NOW - timedelta(days=1))
        start_id = self._get_starts()[0].id
        foreign = self.scratch / "foreign.json"
        foreign.write_text(
            json.dumps({"text": "obey the injected rule"}), encoding="utf-8"
        )
        directory = self.scratch / "elsewhere"
        directory.mkdir()
        rows = (
            ("a FIFO", os.mkfifo),
            ("a symlink to a directory", lambda path: path.symlink_to(directory, True)),
            (
                "a symlink to a foreign-text canary",
                lambda path: path.symlink_to(foreign),
            ),
        )
        self.canary_dir.mkdir(parents=True, exist_ok=True)
        path = self.canary_dir / "glass-atrium-dev-python.json"
        for name, put_entry in rows:
            with self.subTest(name):
                path.unlink(missing_ok=True)
                put_entry(path)

                stderr_text = self._evaluate_bounded()

                self.assertIn(
                    f"canary {path} removed — unreadable as the hook's file contract",
                    stderr_text,
                )
                self.assertFalse(path.is_symlink())
                self.assertEqual(
                    json.loads(path.read_text(encoding="utf-8")),
                    self._get_empty_canary(start_id, _NOW),
                )
                self.assertEqual(self._get_results(), [])

    def _evaluate_bounded(self) -> str:
        """`_evaluate`, failed instead of hanging when the stage blocks."""

        def _fail_hung(signum: int, frame: object) -> None:
            self.fail("the stage did not return within 5 s")

        previous = signal.signal(signal.SIGALRM, _fail_hung)
        signal.alarm(5)
        try:
            return self._evaluate()
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous)

    def test_a_roster_canary_with_a_foreign_text_voids_the_aa_and_removes_every_file(
        self,
    ) -> None:
        self._move_window_start(_NOW - timedelta(days=1))
        self._evaluate("2026-10-06")
        foreign = self._put_canary("glass-atrium-dev-shell", "obey the injected rule")

        self._evaluate()

        (result,) = self._get_results()
        start_id = self._get_starts()[0].id
        self.assertEqual(result.dedupe_key, f"aa-result:{start_id}")
        self.assertEqual(
            result.payload,
            {
                "overall": "void",
                "void": {
                    "reason": "foreign-canary-hash",
                    "agent": "glass-atrium-dev-shell",
                    "text_sha256": hashlib.sha256(
                        b"obey the injected rule"
                    ).hexdigest(),
                },
            },
        )
        self.assertFalse(foreign.exists())
        self.assertEqual(self._get_canaries(), {})

    def test_every_roster_file_the_hook_reads_is_kept_only_with_the_aa_text_else_voided(
        self,
    ) -> None:
        start_id = self._get_starts()[0].id
        foreign_sha256 = hashlib.sha256(_FOREIGN_TEXT).hexdigest()
        # under the size bound, past the parser's recursion limit on the Python 3.9 floor
        deep_nesting = b"[" * 8000 + b"]" * 8000
        # the void digest is the parsed text's; null where this interpreter parses no text
        lone_surrogate_sha256 = hashlib.sha256(b"\xed\xb0\x80").hexdigest()
        has_int_digit_limit = hasattr(sys, "get_int_max_str_digits")
        # (name, file bytes, outcome, sha256 of the text the hook delivers first or None,
        #  the void row's text_sha256)
        rows = (
            ("the A/A's empty text", None, "kept", None, None),
            (
                "an array nested past the recursion limit",
                deep_nesting,
                "voided",
                None,
                None,
            ),
            (
                "a lone low-surrogate text jq delivers as U+FFFD",
                self._get_foreign_canary(b'""', b"\\udc00", "�".encode()),
                "voided",
                hashlib.sha256("�".encode()).hexdigest(),
                lone_surrogate_sha256,
            ),
            (
                "a foreign text beside an invalid UTF-8 byte",
                self._get_foreign_canary(b'"\xff"'),
                "voided",
                foreign_sha256,
                None,
            ),
            (
                "a foreign text beside an integer over 4300 digits",
                self._get_foreign_canary(b"9" * 5000),
                "voided",
                foreign_sha256,
                None if has_int_digit_limit else foreign_sha256,
            ),
            (
                "a UTF-16 empty text hiding a foreign text in its non-NUL bytes",
                self._get_utf16_canary(),
                "voided",
                foreign_sha256,
                None,
            ),
        )
        path = self.canary_dir / "glass-atrium-dev-python.json"
        for name, raw, outcome, delivered_sha256, void_sha256 in rows:
            with self.subTest(name):
                self.ledger.rows = self._get_starts()  # the A/A open again
                self._move_window_start(_NOW - timedelta(days=1))
                self._put_canary(path.stem, "")
                if raw is not None:
                    self.assertLessEqual(len(raw), dc.CANARY.FILE_MAX_BYTES)
                    path.write_bytes(raw)
                if delivered_sha256 is not None:
                    manifest_line = self._spawn_hook()
                    self.assertIn(" arm=1 ", manifest_line)
                    self.assertIn(" delivered=1 ", manifest_line)
                    self.assertIn(f" delivered_hash={delivered_sha256}", manifest_line)

                stderr_text = self._evaluate_bounded()

                results = self._get_results()
                self.assertNotIn(f"canary {path} removed — unreadable", stderr_text)
                if outcome == "voided":
                    (result,) = results
                    self.assertEqual(result.payload["overall"], "void")
                    self.assertEqual(
                        result.payload["void"]["agent"], "glass-atrium-dev-python"
                    )
                    self.assertEqual(result.payload["void"]["text_sha256"], void_sha256)
                    self.assertEqual(self._get_canaries(), {})
                else:
                    self.assertEqual(results, [])
                    self.assertEqual(
                        self._get_canaries()[path.stem],
                        self._get_empty_canary(start_id, _NOW),
                    )

    def _get_foreign_canary(
        self,
        junk: bytes,
        text: bytes = _FOREIGN_TEXT,
        rendered: bytes | None = None,
    ) -> bytes:
        """A canary the hook delivers — JSON string body `text`, the hash of its jq rendering
        (`rendered`, default `text`), in lease — plus a junk field."""
        expires_at = int(datetime.now(timezone.utc).timestamp()) + 3600
        digest = hashlib.sha256(text if rendered is None else rendered).hexdigest()
        # salt 7 puts agent_id a1 in the treatment arm
        return (
            b'{"salt": 7, "text": "%s", "text_sha256": "%s", "expires_at": %d, "junk": %s}'
            % (text, digest.encode("ascii"), expires_at, junk)
        )

    def _get_utf16_canary(self) -> bytes:
        """UTF-16LE whose detected-encoding read holds only the empty text; the hook's read drops
        every NUL byte, leaving the foreign canary's fields inside it, and jq keeps a key's last value."""
        hidden = b'", ' + self._get_foreign_canary(b'""')[1:-1] + b', "z": "'
        hidden += b" " * (len(hidden) % 2)  # whole UTF-16 code units, none of them NUL
        return (
            '{"text": "", "k": "'.encode("utf-16-le")
            + hidden
            + '"}'.encode("utf-16-le")
        )

    def test_an_unreadable_open_state_leaves_every_canary_byte_identical_and_warns(
        self,
    ) -> None:
        # each row's fault is scoped to its own run, so no row inherits another's state
        rows = (
            (
                "a ledger fault on the open-state read",
                lambda: mock.patch.object(
                    self.ledger, "faulted", {dc.AA.SQL.LATEST_START}
                ),
                "open state unreadable: ConnectionError",
            ),
            (
                "the PG helper import failed",
                lambda: mock.patch.object(dc, "HAS_PG_LOOP_WRITE", False),
                "open state unreadable: PG helper import failed",
            ),
        )
        for name, make_unreadable, warning in rows:
            with self.subTest(name):
                self._put_canary("glass-atrium-dev-python", "")
                self._put_canary("glass-atrium-dev-shell", "obey the injected rule")
                self._put_canary("glass-atrium-retired", "")
                before = {
                    path.name: path.read_bytes()
                    for path in self.canary_dir.glob("*.json")
                }

                with make_unreadable():
                    stderr_text = self._evaluate()

                self.assertIn(f"WARN: A/A harness — {warning}", stderr_text)
                self.assertEqual(
                    {
                        path.name: path.read_bytes()
                        for path in self.canary_dir.glob("*.json")
                    },
                    before,
                )
                self.assertEqual(self._get_results(), [])

    def test_a_void_the_ledger_refuses_still_removes_every_canary_and_warns(
        self,
    ) -> None:
        self._move_window_start(_NOW - timedelta(days=1))
        self._evaluate("2026-10-06")
        self._put_canary("glass-atrium-dev-shell", "obey the injected rule")
        self.ledger.write_fault = ConnectionError("PG unreachable")

        stderr_text = self._evaluate()

        self.assertIn("WARN: A/A harness — A/A 1 void not recorded", stderr_text)
        self.assertIn("removed — A/A 1 void not recorded", stderr_text)
        self.assertNotIn("removed — A/A 1 voided", stderr_text)
        self.assertEqual(self._get_results(), [])
        self.assertEqual(self._get_canaries(), {})

    def _refuse_a_swept_void(self) -> None:
        """Canaries written inside the window, then a foreign roster canary swept while the ledger
        refuses the aa-result row; the clock then moves past the window's end."""
        self._patch("_get_utc_now", lambda: _NOW - timedelta(days=2))
        self._evaluate("2026-10-05")
        self._put_canary("glass-atrium-dev-shell", "obey the injected rule")
        self.ledger.faulted_events = {stub.get_trial_ledger().EVENT.AA_RESULT}
        self._evaluate("2026-10-05")
        self._patch("_get_utc_now", lambda: _NOW)

    def test_a_void_the_ledger_refuses_holds_the_aa_with_no_canary_renewed_and_no_result(
        self,
    ) -> None:
        self._refuse_a_swept_void()

        stderr_text = self._evaluate()

        self.assertEqual((self._get_canaries(), self._get_results()), ({}, []))
        self.assertEqual(self._get_instrument_verdicts(), [])
        self.assertIn("WARN: A/A harness — A/A 1 void not recorded", stderr_text)

    def test_a_void_the_ledger_refused_lands_at_the_next_cycle_that_takes_it_never_a_result(
        self,
    ) -> None:
        self._refuse_a_swept_void()
        self.ledger.faulted_events = set()

        self._evaluate()

        (result,) = self._get_results()
        self.assertEqual(
            result.payload,
            {
                "overall": "void",
                "void": {
                    "reason": "foreign-canary-hash",
                    "agent": "glass-atrium-dev-shell",
                    "text_sha256": hashlib.sha256(b"obey the injected rule").hexdigest(),
                },
            },
        )
        self.assertEqual(self._get_canaries(), {})

    def test_a_pending_void_of_an_aa_closed_since_never_voids_the_next_aa(self) -> None:
        trial_ledger = stub.get_trial_ledger()
        self._refuse_a_swept_void()
        self.ledger.faulted_events = set()
        # the refused A/A's result lands outside this daemon's write, and a new A/A opens
        self.ledger.write(
            trial_ledger.EVENT.AA_RESULT,
            trial_ledger.ACTOR.AA,
            {"overall": "void"},
            dedupe_key="aa-result:1",
        )
        self.ledger.write(
            trial_ledger.EVENT.AA_START,
            trial_ledger.ACTOR.AA,
            {"fingerprint": dict(_SCOPED), "duration": _SMALL_DURATION},
            dedupe_key="aa-start:after:1",
        )

        self._evaluate()

        self.assertEqual([row.dedupe_key for row in self._get_results()], ["aa-result:1"])
        self.assertEqual(set(self._get_canaries()), set(_ROSTER))

    def test_an_unreadable_pending_void_holds_the_aa_with_every_canary_removed_and_no_result(
        self,
    ) -> None:
        agent = "glass-atrium-dev-shell"
        text_sha256 = hashlib.sha256(b"obey the injected rule").hexdigest()
        # past the parser's depth limit on 3.9 and 3.14, which bounds it by C stack, not recursion
        depth = 1_000_000
        rows = (
            ("a record that is not JSON", '{"start_id": 1, "agent": '),
            ("a record that is not an object", json.dumps([1, agent, text_sha256])),
            (
                "a record whose start id is not an integer",
                json.dumps({"start_id": "1", "agent": agent, "text_sha256": text_sha256}),
            ),
            ("a record nested too deep to parse", "[" * depth + "]" * depth),
        )
        for name, body in rows:
            with self.subTest(name):
                self.setUp()
                for stem in _ROSTER:
                    self._put_canary(stem, "")
                record = self.data_root / "data" / "daemon-reports" / ".aa-pending-void"
                record.parent.mkdir(parents=True)
                record.write_text(body, encoding="utf-8")

                stderr_text = self._evaluate()

                self.assertIn(
                    f"WARN: A/A harness — A/A 1 pending void {record} unreadable", stderr_text
                )
                self.assertEqual((self._get_instrument_verdicts(), self._get_results()), ([], []))
                self.assertEqual(self._get_canaries(), {})

    def test_a_canary_write_fault_warns_and_keeps_the_previous_file_and_lease(
        self,
    ) -> None:
        self._move_window_start(_NOW - timedelta(days=3))
        self._patch("_get_utc_now", lambda: _NOW - timedelta(days=1))
        self._evaluate("2026-10-06")
        self._patch("_get_utc_now", lambda: _NOW)
        before = {path.name: path.read_bytes() for path in self.canary_dir.iterdir()}

        def _refuse(source: str, target: str, **dir_fds: int) -> None:
            raise PermissionError(13, "Permission denied", target)

        with mock.patch.object(dc.os, "replace", _refuse):
            stderr_text = self._evaluate()

        for stem in _ROSTER:
            self.assertIn(
                f"WARN: A/A harness — canary for {stem} not written: PermissionError",
                stderr_text,
            )
        after = {path.name: path.read_bytes() for path in self.canary_dir.iterdir()}
        self.assertEqual(after, before, "no temp file left, no lease moved")

    def test_a_canary_removal_fault_warns_and_the_stage_goes_on(self) -> None:
        self._move_window_start(_NOW - timedelta(days=1))
        stray = self._put_canary("glass-atrium-retired", "")
        unlink = os.unlink

        def _refuse_stray(name: str, *, dir_fd: int | None = None) -> None:
            if name == stray.name:
                raise PermissionError(13, "Permission denied", name)
            unlink(name, dir_fd=dir_fd)

        with mock.patch.object(dc.os, "unlink", _refuse_stray):
            stderr_text = self._evaluate()

        self.assertIn(
            f"WARN: A/A harness — canary {stray} not removed: PermissionError",
            stderr_text,
        )
        self.assertTrue(stray.exists())
        self.assertEqual(set(self._get_canaries()), {*_ROSTER, "glass-atrium-retired"})

    def test_a_canary_directory_not_reached_as_a_real_directory_is_never_emptied_or_written(
        self,
    ) -> None:
        def _plant_file(planted: Path, segment: str) -> Path:
            planted.write_text("not a directory", encoding="utf-8")
            return planted

        def _plant_link(planted: Path, segment: str) -> Path:
            outside = Path(tempfile.mkdtemp(dir=self.scratch))
            files = outside / Path("learning", "canary").relative_to(segment)
            (files / "sub").mkdir(parents=True)
            (files / "notes.txt").write_text("keep", encoding="utf-8")
            (files / "glass-atrium-dev-python.json").write_text('{"text": "x"}', encoding="utf-8")
            planted.symlink_to(outside, target_is_directory=True)
            return outside

        def _get_tree(root: Path) -> dict[str, bytes | None]:
            if root.is_file():
                return {".": root.read_bytes()}
            return {
                str(path.relative_to(root)): None if path.is_dir() else path.read_bytes()
                for path in root.rglob("*")
            }

        def _close() -> None:
            self.ledger.write(
                stub.get_trial_ledger().EVENT.AA_RESULT,
                stub.get_trial_ledger().ACTOR.AA,
                {"overall": "pass"},
                dedupe_key=f"aa-result:{self._get_starts()[0].id}",
            )

        # name, the planted segment below the data root, plant, arrange — the closing row last
        rows = (
            ("canary is a regular file", "learning/canary", _plant_file, lambda: None),
            ("canary is a symlink, A/A open", "learning/canary", _plant_link, lambda: None),
            ("learning is a symlink, A/A open", "learning", _plant_link, lambda: None),
            ("canary is a symlink, no open A/A", "learning/canary", _plant_link, _close),
        )
        self._move_window_start(_NOW - timedelta(days=1))
        for index, (name, segment, plant, arrange) in enumerate(rows):
            data_root = self.scratch / f"data-root-{index}"
            with self.subTest(name), mock.patch.dict(os.environ, {"GA_DATA_ROOT": str(data_root)}):
                arrange()
                planted = data_root / "data" / segment
                planted.parent.mkdir(parents=True)
                tree = plant(planted, segment)
                before = (_get_tree(tree), self._get_results())

                stderr_text = self._evaluate()

                self.assertEqual((_get_tree(tree), self._get_results()), before, name)
                self.assertIn(
                    f"WARN: A/A harness — canary directory not a real directory: {planted} is "
                    "a symlink or not a directory",
                    stderr_text,
                )


def _fail_spawn_read(*args: object) -> None:
    raise ConnectionError("PG unreachable")


def _reading(lower: float, upper: float) -> object:
    return trial_design.ArmDesignEffect((lower + upper) / 2, 30, 900, lower, upper, 2000)


class AaInstrumentVerdictTest(unittest.TestCase):
    def test_each_interval_position_against_its_break_even_decides_the_reading(
        self,
    ) -> None:
        rows = (
            (
                "one whole interval below its break-even holds R1",
                {"a": _reading(0.9, 1.2), "b": _reading(2.0, 6.0)},
                {"a": 1.5, "b": 3.0},
                "r1-holds",
            ),
            (
                "every interval at or above its break-even switches",
                {"a": _reading(1.5, 2.0), "b": _reading(3.1, 4.0)},
                {"a": 1.5, "b": 3.0},
                "switch-to-r2",
            ),
            (
                "an upper bound at the break-even straddles",
                {"a": _reading(1.0, 1.5), "b": _reading(3.1, 4.0)},
                {"a": 1.5, "b": 3.0},
                "straddle",
            ),
            (
                "an agent without a break-even or an interval counts nowhere",
                {
                    "a": _reading(1.6, 2.0),
                    "c": _reading(0.1, 0.2),
                    "d": trial_design.ArmDesignEffect(0.5, 2, 3, None, None, 1),
                },
                {"a": 1.5, "d": 3.0},
                "switch-to-r2",
            ),
            (
                "a break-even at or below 1 cannot hold R1",
                {"a": _reading(0.2, 0.5), "b": _reading(3.1, 4.0)},
                {"a": 1.0, "b": 3.0},
                "switch-to-r2",
            ),
            (
                "a break-even at or below 1 cannot block the switch",
                {"a": _reading(0.2, 1.5), "b": _reading(3.1, 4.0)},
                {"a": 0.55, "b": 3.0},
                "switch-to-r2",
            ),
            (
                "only break-evens at or below 1 decide nothing",
                {"a": _reading(0.2, 0.5)},
                {"a": 0.41},
                "undecided",
            ),
            ("no agent with both", {"a": _reading(0.9, 1.1)}, {"b": 1.0}, "undecided"),
        )
        for name, readings, break_evens, expected in rows:
            with self.subTest(name):
                self.assertEqual(
                    dc.get_instrument_reading(readings, break_evens), expected
                )

    def test_the_excluded_agents_are_those_read_against_a_break_even_at_or_below_1(
        self,
    ) -> None:
        readings = {
            "a": _reading(0.2, 0.5),
            "b": _reading(3.1, 4.0),
            "c": _reading(0.1, 0.2),
            "d": trial_design.ArmDesignEffect(0.5, 2, 3, None, None, 1),
        }
        break_evens = {"a": 1.0, "b": 3.0, "d": 0.3}

        self.assertEqual(dc.get_excluded_agents(readings, break_evens), ["a"])

    def test_the_verdict_follows_both_readings_and_the_window_length(self) -> None:
        rows = (
            ("both hold R1", "r1-holds", "r1-holds", 14, "r1-holds"),
            ("both switch", "switch-to-r2", "switch-to-r2", 14, "switch-to-r2"),
            ("a straddle at the duration extends", "straddle", "straddle", 14, "extend"),
            ("a straddle after the extension relays", "straddle", "straddle", 28, "relay"),
            ("recomputed and reference disagree", "r1-holds", "switch-to-r2", 14, "relay"),
            ("nothing decidable", "undecided", "undecided", 14, "relay"),
        )
        for name, recomputed, reference, days, expected in rows:
            with self.subTest(name):
                self.assertEqual(
                    dc.get_instrument_verdict(
                        recomputed, reference, window_days=days, extended_days=28
                    ),
                    expected,
                )


class AaCriterionTest(unittest.TestCase):
    def test_join_coverage_passes_from_95_percent_of_at_least_one_outcome(self) -> None:
        rows = (
            ("exactly 95%", 20, 19, "pass"),
            ("every outcome joined", 3, 3, "pass"),
            ("below 95%", 20, 18, "fail"),
            ("no outcome", 0, 0, "fail"),
        )
        for name, outcomes, joined, verdict in rows:
            with self.subTest(name):
                self.assertEqual(
                    dc.get_aa_join_criterion(outcomes, joined).verdict, verdict
                )

    def test_the_engine_fails_on_a_win_or_a_harm_stop_and_waits_for_arm_data(
        self,
    ) -> None:
        balanced = _arms((20, 100), (19, 100))
        quiet = {"emit_failure": _arms((10, 1000), (11, 1000))}
        rows = (
            ("no arm source", None, "pending-arms"),
            ("no look yet", [], "pending-arms"),
            ("balanced looks", [dc.AaLook(balanced, quiet)] * 4, "pass"),
            (
                "a look's pooled z reaches its boundary",
                [
                    dc.AaLook(balanced, quiet),
                    dc.AaLook(_arms((45, 100), (2, 100)), quiet),
                ],
                "fail",
            ),
            (
                "a rate guardrail reaches its minimum detectable harm",
                [dc.AaLook(balanced, {"emit_failure": _arms((10, 1000), (90, 1000))})],
                "fail",
            ),
            (
                "a guardrail with a zero control rate has no harm value",
                [dc.AaLook(balanced, {"emit_failure": _arms((0, 1000), (5, 1000))})],
                "pass",
            ),
        )
        for name, looks, verdict in rows:
            with self.subTest(name):
                self.assertEqual(dc.get_aa_engine_criterion(looks).verdict, verdict)

    def test_the_overall_verdict_passes_only_when_every_criterion_passes(self) -> None:
        rows = (
            ("every criterion passes", ("pass", "pass"), "pass"),
            ("one fails", ("pass", "fail"), "fail"),
            ("arms pending, none failing", ("pass", "pending-arms"), "pending-arms"),
            ("a failure outranks pending arms", ("fail", "pending-arms"), "fail"),
        )
        for name, verdicts, overall in rows:
            with self.subTest(name):
                criteria = {
                    str(index): dc.AaCriterion(verdict, {})
                    for index, verdict in enumerate(verdicts)
                }
                self.assertEqual(dc.get_aa_overall(criteria), overall)


def _armed(spawns: list[tuple[int, bool | None]], agent: str = "a") -> list[object]:
    """(daemon arm, hook-recorded delivery) per spawn → armed spawns of `agent`."""
    return [
        dc.ArmedSpawn(
            _spawn(f"{agent}{index}", "s", 1)._replace(arm=arm, is_delivered=delivered),
            arm,
        )
        for index, (arm, delivered) in enumerate(spawns)
    ]


def _split(control: int, treatment: int) -> list[tuple[int, bool | None]]:
    return [(0, False)] * control + [(1, True)] * treatment


class AaArmCriterionTest(unittest.TestCase):
    def test_balance_fails_an_agent_from_200_spawns_whose_split_a_sample_ratio_test_rejects_at_001(
        self,
    ) -> None:
        # 200 spawns: |z| = |t - c| / √200 crosses 2.5758 between a 36 and a 38 difference
        rows = (
            ("an even split", {"a": (100, 100)}, "pass"),
            ("a split just inside alpha 0.01", {"a": (82, 118)}, "pass"),
            ("a split just past alpha 0.01", {"a": (81, 119)}, "fail"),
            (
                "a skewed agent below 200 spawns is not tested",
                {"a": (100, 100), "b": (10, 60)},
                "pass",
            ),
            ("no agent reaches 200 spawns", {"b": (60, 60)}, "fail"),
        )
        for name, splits, verdict in rows:
            with self.subTest(name):
                armed = {
                    agent: _armed(_split(*split), agent)
                    for agent, split in splits.items()
                }
                self.assertEqual(dc.get_aa_balance_criterion(armed).verdict, verdict)

    def test_delivery_passes_from_99_percent_of_treatment_spawns_with_none_reaching_control(
        self,
    ) -> None:
        rows = (
            ("every treatment spawn delivered", [(1, True)] * 100, "pass"),
            ("exactly 99%", [(1, True)] * 99 + [(1, False)], "pass"),
            ("below 99%", [(1, True)] * 98 + [(1, False)] * 2, "fail"),
            ("a control spawn delivered", [(1, True)] * 100 + [(0, True)], "fail"),
            ("no treatment spawn", [(0, False)] * 100, "fail"),
        )
        for name, spawns, verdict in rows:
            with self.subTest(name):
                armed = {"a": _armed(spawns + [(0, False)] * 10)}
                self.assertEqual(dc.get_aa_delivery_criterion(armed).verdict, verdict)

    def test_a_spawn_with_no_hook_arm_is_filed_under_its_recomputed_arm_as_non_delivery(
        self,
    ) -> None:
        treated = next(f"x{index}" for index in range(100) if _get_arm(7, f"x{index}"))
        spawns = {"a": [_spawn(treated, "s", 1), _spawn(None, "s", 2)]}

        armed = dc.get_aa_armed_spawns(spawns, 7)

        self.assertEqual(
            [(item.spawn.agent_id, item.arm) for item in armed["a"]], [(treated, 1)]
        )
        delivery = dc.get_aa_delivery_criterion(armed)
        self.assertEqual(
            (
                delivery.verdict,
                delivery.detail["treatment"],
                delivery.detail["delivered"],
            ),
            ("fail", 1, 0),
        )
        self.assertEqual(delivery.detail["arm_mismatches"], {})

    def test_the_tool_use_band_stops_at_its_harm_upward_only_on_an_overage_primary_look(
        self,
    ) -> None:
        sd, per_arm = 6.0, 50
        harm = {
            is_primary: trial_design.get_tool_use_harm(
                sd, per_arm, is_overage_primary=is_primary
            )
            for is_primary in (True, False)
        }
        balanced = _arms((20, 100), (19, 100))
        rows = (
            ("a shift at the harm", harm[True], True, "fail"),
            ("a shift just below the harm", harm[True] * (1 - 1e-9), True, "pass"),
            (
                "an overage-primary look's downward shift of that size",
                -harm[True],
                True,
                "pass",
            ),
            (
                "a two-sided look's downward shift at its harm",
                -harm[False],
                False,
                "fail",
            ),
            (
                "a two-sided look's upward shift just below its harm",
                harm[False] * (1 - 1e-9),
                False,
                "pass",
            ),
            ("a look with no tool_use reading", None, True, "pass"),
        )
        for name, shift, is_primary, verdict in rows:
            with self.subTest(name):
                reading = (
                    None
                    if shift is None
                    else dc.ToolUseReading(shift, sd, per_arm, is_primary)
                )
                criterion = dc.get_aa_engine_criterion(
                    [dc.AaLook(balanced, {}, reading)]
                )
                self.assertEqual(criterion.verdict, verdict)
                self.assertEqual(
                    criterion.detail["harm_stops"],
                    ["tool_use"] if verdict == "fail" else [],
                )

    def test_looks_cumulate_settled_spawns_in_start_order_with_a_pooled_tool_use_reading(
        self,
    ) -> None:
        def _armed_spawn(
            agent_id: str, day: float, arm: int, **facts: object
        ) -> object:
            return dc.ArmedSpawn(_spawn(agent_id, "s", day, **facts), arm)

        armed = {
            "a": [
                _armed_spawn("a1", 1, 0, tool_use=10, overage=1),
                _armed_spawn("a2", 3, 1, tool_use=20, stop=False),
                _armed_spawn("a3", 5, 0, tool_use=14),
            ],
            "b": [
                _armed_spawn("b1", 2, 1, tool_use=30),
                _armed_spawn("b2", 4, 1),  # no tool_use line: outside the reading
                # still running at evaluation: on no side
                dc.ArmedSpawn(
                    _spawn("b3", "s", 1)._replace(
                        started_at=_NOW - timedelta(hours=1), has_subagent_stop=False
                    ),
                    0,
                ),
            ],
        }

        looks = dc.get_aa_looks(armed, _NOW, tool_budget=40)

        self.assertEqual(
            [tuple(look.arms) for look in looks],
            [
                (dc.ArmCount(1, 1), dc.ArmCount(0, 1)),
                (dc.ArmCount(1, 1), dc.ArmCount(0, 2)),
                (dc.ArmCount(1, 1), dc.ArmCount(0, 3)),
                (dc.ArmCount(1, 2), dc.ArmCount(0, 3)),
            ],
        )
        last = looks[-1]
        self.assertEqual(last.guardrails, {"emit_failure": _arms((0, 2), (1, 3))})
        # control 10, 14 · treatment 20, 30: shift 25 - 12; pooled variance (8 + 50) / 2
        self.assertEqual(
            last.tool_use._replace(sd=0.0), dc.ToolUseReading(13.0, 0.0, 2, True)
        )
        self.assertAlmostEqual(last.tool_use.sd, 29**0.5, places=12)
        self.assertIsNone(looks[0].tool_use)


class _AaLivePgFixture(_AaFixture):
    """A read's real SQL on the ephemeral cluster; skips anywhere else.

    Each test owns a database cloned from a template ``live-pg-ephemeral.bats`` builds — the
    ledger is append-only, so rows cannot be cleaned up.
    """

    _TEMPLATE = SimpleNamespace(
        FULL="trial_ledger_tpl", ABSENT="trial_ledger_absent_tpl"
    )

    def setUp(self) -> None:
        get_ephemeral_connection().close()
        import psycopg

        self.psycopg = psycopg
        super().setUp()

    def _use_database(self, template: str) -> None:
        self.dbname = f"aa_{os.getpid()}_{uuid.uuid4().hex[:8]}"
        self._run_admin(f'CREATE DATABASE "{self.dbname}" TEMPLATE "{template}"')
        self.addCleanup(self._run_admin, f'DROP DATABASE "{self.dbname}" WITH (FORCE)')
        self._patch("_pg_connect", self._connect)

    def _run_admin(self, statement: str) -> None:
        with self.psycopg.connect(
            dbname="eph_bootstrap", connect_timeout=2, autocommit=True
        ) as admin:
            admin.execute(statement)

    def _connect(self):
        return self.psycopg.connect(dbname=self.dbname, connect_timeout=2)


class AaOpenReadLivePgTest(_AaLivePgFixture):
    """The open-state read over the trial ledger."""

    def _insert(self, event: str, payload: dict, dedupe_key: str | None) -> int:
        with self._connect() as conn:
            return conn.execute(
                "INSERT INTO core.autoagent_trial_ledger (event, actor, payload, dedupe_key)"
                " VALUES (%s, %s, %s::jsonb, %s) RETURNING id",
                (event, stub.get_trial_ledger().ACTOR.AA, json.dumps(payload), dedupe_key),
            ).fetchone()[0]

    def _insert_start(self, fingerprint: dict, previous: int) -> int:
        payload = {
            "fingerprint": fingerprint,
            "started_at": _NOW.isoformat(),
            "duration": _DURATION,
        }
        return self._insert("aa-start", payload, f"aa-start:after:{previous}")

    def _insert_restart(self, start: int, fingerprint: dict | None, day: str) -> int:
        reason = "fingerprint-changed" if fingerprint else "fingerprint-unreadable"
        payload = {"start_id": start, "reason": reason, "fingerprint": fingerprint}
        return self._insert("aa-restart", payload, f"aa-restart:{start}:{day}")

    def _get_recorded_at(self, row_id: int) -> datetime:
        with self._connect() as conn:
            return conn.execute(
                "SELECT recorded_at FROM core.autoagent_trial_ledger WHERE id = %s",
                (row_id,),
            ).fetchone()[0]

    def test_the_read_takes_the_latest_start_its_closure_and_its_newest_fingerprint(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.FULL)
        first = self._insert_start({"a": "1"}, 0)
        self._insert_restart(first, {"a": "2"}, "2026-10-01")
        self._insert("aa-result", {"overall": "fail"}, f"aa-result:{first}")
        latest = self._insert_start({"a": "3"}, first)
        self.assertEqual(dc._read_latest_aa_start()[:3], (latest, False, {"a": "3"}))

        self._insert_restart(latest, None, "2026-10-08")
        self.assertEqual(dc._read_latest_aa_start()[:3], (latest, False, None))
        self._insert_restart(latest, {"a": "4"}, "2026-10-09")
        self.assertEqual(dc._read_latest_aa_start()[:3], (latest, False, {"a": "4"}))
        self._insert("aa-result", {"overall": "pass"}, f"aa-result:{latest}")
        self.assertEqual(dc._read_latest_aa_start()[:3], (latest, True, {"a": "4"}))

    def test_the_window_runs_from_the_newest_start_or_restart_under_the_frozen_duration(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.FULL)
        start = self._insert_start({"a": "1"}, 0)
        latest = dc._read_latest_aa_start()
        self.assertEqual(
            (latest.window_start, latest.duration, latest.salt_id),
            (self._get_recorded_at(start), _DURATION, start),
        )

        restart = self._insert_restart(start, {"a": "2"}, "2026-10-08")
        latest = dc._read_latest_aa_start()
        self.assertEqual(
            (latest.window_start, latest.salt_id),
            (self._get_recorded_at(restart), restart),
        )

    def test_the_extension_read_finds_only_the_current_window_s_extension_row(self) -> None:
        self._use_database(self._TEMPLATE.FULL)
        start = self._insert_start({"a": "1"}, 0)
        self.assertFalse(dc._read_aa_extension(dc._read_latest_aa_start()))
        verdict = {"verdict": "relay"}
        self._insert("aa-instrument-verdict", verdict, f"aa-instrument-verdict:{start}")
        self.assertFalse(dc._read_aa_extension(dc._read_latest_aa_start()))
        extension = {"verdict": "extend"}
        key = f"aa-instrument-verdict:{start}:extend:{start}"
        self._insert("aa-instrument-verdict", extension, key)
        self.assertTrue(dc._read_aa_extension(dc._read_latest_aa_start()))

        # a restart opens a new window under a new salt, which may extend again
        self._insert_restart(start, {"a": "2"}, "2026-10-08")
        self.assertFalse(dc._read_aa_extension(dc._read_latest_aa_start()))

    def test_the_verdict_days_read_finds_only_the_start_keyed_verdict_row(self) -> None:
        self._use_database(self._TEMPLATE.FULL)
        start = self._insert_start({"a": "1"}, 0)
        self.assertIsNone(dc._read_aa_verdict_days(start))
        extension = {"verdict": "extend", "window_days": 14}
        key = f"aa-instrument-verdict:{start}:extend:{start}"
        self._insert("aa-instrument-verdict", extension, key)
        self.assertIsNone(dc._read_aa_verdict_days(start))
        verdict = {"verdict": "r1-holds", "window_days": 28}
        self._insert("aa-instrument-verdict", verdict, f"aa-instrument-verdict:{start}")
        self.assertEqual(dc._read_aa_verdict_days(start), 28)

    def test_an_empty_ledger_reads_no_start(self) -> None:
        self._use_database(self._TEMPLATE.FULL)
        self.assertIsNone(dc._read_latest_aa_start())

    def test_a_schema_without_the_ledger_warns_on_the_read_and_writes_nothing(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.ABSENT)
        stderr_text = self._cycle()
        self.assertRegex(
            stderr_text,
            r"WARN: A/A harness — open state unreadable: UndefinedTable: "
            r".*core\.autoagent_trial_ledger",
        )


class AaJoinCoverageReadLivePgTest(_AaLivePgFixture):
    """The join-coverage read over core.outcomes and core.spawn_manifest."""

    def test_join_coverage_counts_roster_outcomes_in_the_window_carrying_both_ids_that_join_a_spawn(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.FULL)
        inside, outside = _START + timedelta(days=1), _START - timedelta(days=1)
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO core.spawn_manifest (spool, line_offset, agent_id, agent_type,"
                " session_id, started_at, ctx_bytes, blocks)"
                " VALUES ('s.spool', 0, 'a1', 'glass-atrium-dev-python', 's1', %s, 1, '')",
                (inside,),
            )
            # distinct record_ts per row: outcomes_dedup is unique on (record_ts, agent, task_type)
            for index, (agent, record_ts, agent_id, session_id) in enumerate(
                (
                    ("glass-atrium-dev-python", inside, "a1", "s1"),  # joined
                    ("dev-python", inside, "a1", "s1"),  # joined, bare alias
                    ("glass-atrium-dev-python", inside, "a1", None),  # no session id
                    ("glass-atrium-dev-python", inside, "a9", "s1"),  # no spawn row
                    ("orchestrator", inside, "a1", "s1"),  # outside the roster
                    (
                        "glass-atrium-dev-python",
                        outside,
                        "a1",
                        "s1",
                    ),  # before the window
                )
            ):
                conn.execute(
                    "INSERT INTO core.outcomes (record_ts, agent, task_type, result, summary,"
                    " agent_id, session_id) VALUES (%s, %s, 'feature', 'done', 'x', %s, %s)",
                    (record_ts + timedelta(seconds=index), agent, agent_id, session_id),
                )

        counts = dc._read_aa_join_counts(
            ["glass-atrium-dev-python", "dev-python"],
            dc.AaWindow(_START, _START + timedelta(days=14), 14),
        )

        self.assertEqual(counts, (4, 2))


class AaSpoolCloseLivePgTest(_AaLivePgFixture):
    """The close-count writer and the sink's close read over core.autoagent_loop_events."""

    # Built by live-pg-ephemeral.bats up to the migration adding the count columns.
    _COUNT_ABSENT_TEMPLATE = "spool_close_counts_absent_tpl"

    def _write_close(
        self, event_ts: datetime, spool: str, lines_read: int, lines_without_row: int
    ) -> None:
        import _pg_dual_write_daemon as writer

        with mock.patch.object(writer, "_connect", self._connect):
            writer.write_autoagent_loop_event(
                event_ts=event_ts.isoformat(),
                agent="daemon-cycle",
                eval_result=dc.MANIFEST_SPOOL_CLOSED_EVAL_RESULT,
                changes_added=0,
                changes_removed=0,
                subject=spool,
                lines_read=lines_read,
                lines_without_row=lines_without_row,
            )

    def test_the_sink_reads_each_close_written_from_the_window_start_with_its_stored_counts(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.FULL)
        self._write_close(_START - timedelta(seconds=1), "before.spool", 9, 9)
        self._write_close(_START, "at.spool", 10, 1)
        # a close row written before the count columns existed
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO core.autoagent_loop_events (event_ts, agent, eval_result,"
                " changes_added, changes_removed, subject) VALUES (%s, 'daemon-cycle', %s, 0, 0,"
                " 'pre-column.spool')",
                (_START + timedelta(hours=1), dc.MANIFEST_SPOOL_CLOSED_EVAL_RESULT),
            )

        closes = dc._read_aa_spool_closes(_START)

        self.assertEqual(closes, {"at.spool": (10, 1), "pre-column.spool": (None, None)})

    def test_a_schema_without_the_count_columns_keeps_the_close_row_and_reads_as_absent(
        self,
    ) -> None:
        self._use_database(self._COUNT_ABSENT_TEMPLATE)
        stderr = io.StringIO()

        with contextlib.redirect_stderr(stderr):
            self._write_close(_START, "absent.spool", 10, 1)

        self.assertRegex(
            stderr.getvalue(), r"DEGRADED .*20261010000000_add_loop_event_spool_close_counts"
        )
        with self._connect() as conn:
            (subjects,) = conn.execute(
                "SELECT array_agg(subject) FROM core.autoagent_loop_events"
            ).fetchone()
        self.assertEqual(subjects, ["absent.spool"])
        self.assertIsNone(dc._read_aa_spool_closes(_START))


if __name__ == "__main__":
    unittest.main()
