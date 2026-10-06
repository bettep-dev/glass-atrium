"""A/A harness, part a: the --aa-start mode and the restart rows its fingerprint drives.

An A/A opens only through --aa-start (N55), its fingerprint the installed manifest's scoped
hashes (N66); while it is open each writing cycle compares the fingerprint and writes an
aa-restart row when it moved or cannot be read. Every row outside the live class is
database-free under ``seal_pg_reach``; the ledger is an in-memory append-only fake behind the
writer and connection seams. The live class runs the open-state read's SQL on the cluster
``autoagent/test/live-pg-ephemeral.bats`` provisions and skips elsewhere.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_aa_harness.py -v
    python3 -m unittest autoagent.test.test_aa_harness -v
"""

from __future__ import annotations

import contextlib
import functools
import io
import json
import os
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
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
    "hooks/track-outcome.sh": "5" * 64,
    _MIGRATION.OTHER: "6" * 64,
    "rules/glass-atrium/core-security.md": "7" * 64,
}
# D2: 14 days, 28 when any of the five busiest agents has < 200 spawns
_DURATION = {
    "days": 14,
    "extended_days": 28,
    "busiest_agents": 5,
    "minimum_spawns": 200,
}


@functools.cache
def _get_trial_ledger() -> SimpleNamespace:
    """The helper's declared ledger names, loaded on the stub backend so a psycopg-free leg has them."""
    with (
        tempfile.TemporaryDirectory() as scratch,
        stub.load_helper(Path(scratch) / "stub.sqlite") as helper,
    ):
        return helper.TRIAL_LEDGER


class _LedgerRow(NamedTuple):
    id: int
    trial_key: str | None
    event: str
    actor: str
    payload: dict
    dedupe_key: str | None


class _Ledger:
    """core.autoagent_trial_ledger as the writer and the open-state read see it: append-only,
    a taken dedupe_key adds no row (ON CONFLICT DO NOTHING), payload stored as JSON."""

    def __init__(self) -> None:
        self.rows: list[_LedgerRow] = []
        self.refused: list[str] = []
        self.faulted: set[str] = set()
        self.write_fault: Exception | None = None
        self.is_key_taken = False
        # read only by a writing cycle's regression gate and discharge
        self.answered_empty = frozenset(
            {
                dc._REGRESSION_WARNINGS_SELECT_SQL,
                dc._REGRESSION_PROPOSALS_SELECT_SQL,
                dc._APPLIED_FOR_DISCHARGE_SELECT_SQL,
            }
        )

    def write(
        self, event, actor, payload, *, trial_key=None, dedupe_key=None, **_columns
    ):
        if self.write_fault is not None:
            raise self.write_fault
        if self.is_key_taken or (
            dedupe_key is not None
            and any(row.dedupe_key == dedupe_key for row in self.rows)
        ):
            return 0
        stored = json.loads(json.dumps(payload))
        self.rows.append(
            _LedgerRow(len(self.rows) + 1, trial_key, event, actor, stored, dedupe_key)
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
        if statement == dc.AA.LATEST_START_SQL:
            assert isinstance(params, dict), (
                "the open-state read binds named parameters"
            )
            self.result = self._get_latest_start(params)
        elif statement in self.ledger.answered_empty:
            self.result = []
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
        fingerprints = [
            row.payload["fingerprint"]
            for row in rows
            if row.event in params["fingerprinted"] and row.id >= start.id
        ]
        return [(start.id, is_closed, fingerprints[-1])]

    def fetchone(self) -> tuple | None:
        return self.result[0] if self.result else None


class _AaFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.pg_reach = seal_pg_reach(self)
        self.ledger = _Ledger()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.scratch = Path(tmp.name)
        self.root = self.scratch / "install"
        self._install()
        # after the seal: ledger connection and writer = the DB boundary
        for name, value in (
            ("HAS_PG_LOOP_WRITE", True),
            ("_pg_connect", lambda: self.ledger.connect()),
            ("_pg_write_trial_ledger_row", lambda *a, **k: self.ledger.write(*a, **k)),
            ("_get_utc_now", lambda: _NOW),
            ("_INSTALL_ROOT", self.root),
        ):
            self._patch(name, value)
        self._patch(
            "TRIAL_LEDGER", _get_trial_ledger(), create=not hasattr(dc, "TRIAL_LEDGER")
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
        self._write_manifest({**_SCOPED, **_UNSCOPED})

    def _write_manifest(
        self, hashes: dict[str, str], *, version: str = "1.4.0"
    ) -> None:
        manifest = {"version": version, "files": sorted(hashes), "hashes": hashes}
        (self.root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    def _set_hash(self, path: str, digest: str) -> None:
        self._write_manifest({**_SCOPED, **_UNSCOPED, path: digest})

    def _open(self) -> None:
        """An open A/A started on the current scoped fingerprint."""
        self.ledger.write(
            _get_trial_ledger().EVENT.AA_START,
            _get_trial_ledger().ACTOR.AA,
            {
                "fingerprint": dict(_SCOPED),
                "started_at": _NOW.isoformat(),
                "duration": _DURATION,
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

    def _cycle(self, cycle_date: str = _CYCLE_DATE) -> str:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            dc.run_aa_stage(cycle_date)
        self.assertEqual(self.pg_reach, [])
        self.assertEqual(self.ledger.refused, [])
        return stderr.getvalue()

    def _get_restarts(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(_get_trial_ledger().EVENT.AA_RESTART)

    def _get_starts(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(_get_trial_ledger().EVENT.AA_START)


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
            _get_trial_ledger().EVENT.AA_RESULT,
            _get_trial_ledger().ACTOR.AA,
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
                lambda: self.ledger.faulted.add(dc.AA.LATEST_START_SQL),
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
            ("an unscoped hook hash changes", "hooks/track-outcome.sh", False),
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
                _get_trial_ledger().EVENT.AA_RESULT,
                _get_trial_ledger().ACTOR.AA,
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
            self.ledger.faulted.add(dc.AA.LATEST_START_SQL)
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


class CycleWiringTest(_AaFixture):
    """run_cycle runs the stage on a writing cycle; no-write mode (--dry-run → skip_loop_emit) writes no ledger row."""

    def setUp(self) -> None:
        super().setUp()
        (self.scratch / "agents").mkdir()
        env = mock.patch.dict(
            os.environ,
            {
                "GA_DATA_ROOT": str(self.scratch),
                "AUTOAGENT_REPORTS_DIR": str(self.scratch / "reports"),
            },
        )
        env.start()
        self.addCleanup(env.stop)
        self._patch("_pg_read_pending_patterns", list)
        self._open()
        self._set_hash("autoagent/daemon_cycle.py", "f" * 64)

    def _run_cycle(self, *, skip_loop_emit: bool) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            dc.run_cycle(
                log_path=self.scratch / "learning-log.md",
                agents_dir=self.scratch / "agents",
                skip_haiku=True,
                skip_pre_verify=True,
                skip_loop_emit=skip_loop_emit,
            )
        self.assertEqual(self.pg_reach, [])

    def test_a_dry_run_cycle_writes_no_aa_row(self) -> None:
        self._run_cycle(skip_loop_emit=True)
        self.assertEqual(self._get_restarts(), [])

    def test_a_writing_cycle_restarts_the_open_aa_on_a_moved_fingerprint(self) -> None:
        def _refuse(*args: object, **kwargs: object) -> None:
            raise ConnectionRefusedError("corpus audit: no database in this test")

        self._patch("_pg_write_corpus_audit", _refuse)
        self._patch("_pg_write_loop_event", lambda *args, **kwargs: True)

        self._run_cycle(skip_loop_emit=False)

        self.assertEqual(
            [row.payload["reason"] for row in self._get_restarts()],
            ["fingerprint-changed"],
        )


class AaOpenReadLivePgTest(_AaFixture):
    """The open-state read's real SQL on the ephemeral cluster; skips anywhere else.

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

    def _insert(self, event: str, payload: dict, dedupe_key: str | None) -> int:
        with self._connect() as conn:
            return conn.execute(
                "INSERT INTO core.autoagent_trial_ledger (event, actor, payload, dedupe_key)"
                " VALUES (%s, %s, %s::jsonb, %s) RETURNING id",
                (event, _get_trial_ledger().ACTOR.AA, json.dumps(payload), dedupe_key),
            ).fetchone()[0]

    def _insert_start(self, fingerprint: dict, previous: int) -> int:
        payload = {
            "fingerprint": fingerprint,
            "started_at": _NOW.isoformat(),
            "duration": _DURATION,
        }
        return self._insert("aa-start", payload, f"aa-start:after:{previous}")

    def _insert_restart(self, start: int, fingerprint: dict | None, day: str) -> None:
        reason = "fingerprint-changed" if fingerprint else "fingerprint-unreadable"
        payload = {"start_id": start, "reason": reason, "fingerprint": fingerprint}
        self._insert("aa-restart", payload, f"aa-restart:{start}:{day}")

    def test_the_read_takes_the_latest_start_its_closure_and_its_newest_fingerprint(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.FULL)
        first = self._insert_start({"a": "1"}, 0)
        self._insert_restart(first, {"a": "2"}, "2026-10-01")
        self._insert("aa-result", {"overall": "fail"}, f"aa-result:{first}")
        latest = self._insert_start({"a": "3"}, first)
        self.assertEqual(
            dc._read_latest_aa_start(), dc.AaStart(latest, False, {"a": "3"})
        )

        self._insert_restart(latest, None, "2026-10-08")
        self.assertEqual(dc._read_latest_aa_start(), dc.AaStart(latest, False, None))
        self._insert_restart(latest, {"a": "4"}, "2026-10-09")
        self.assertEqual(
            dc._read_latest_aa_start(), dc.AaStart(latest, False, {"a": "4"})
        )
        self._insert("aa-result", {"overall": "pass"}, f"aa-result:{latest}")
        self.assertEqual(
            dc._read_latest_aa_start(), dc.AaStart(latest, True, {"a": "4"})
        )

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


if __name__ == "__main__":
    unittest.main()
