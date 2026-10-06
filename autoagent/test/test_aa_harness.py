"""A/A harness: the --aa-start mode, the restart rows its fingerprint drives, and the result.

An A/A opens only through --aa-start, its fingerprint the installed manifest's scoped
hashes; while it is open each writing cycle compares the fingerprint and writes an
aa-restart row when it moved or cannot be read. Once its window's duration ends, a cycle
writes one design-effect row per agent and the aa-result row. Every row outside the live class is
database-free under ``seal_pg_reach``; the ledger is an in-memory append-only fake behind the
writer and connection seams. The live classes run the open-state and join-coverage reads' SQL
on the cluster ``autoagent/test/live-pg-ephemeral.bats`` provisions and skip elsewhere.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_aa_harness.py -v
    python3 -m unittest autoagent.test.test_aa_harness -v
"""

from __future__ import annotations

import contextlib
import functools
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
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
from _outcome_signal import SpawnFacts
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
    agent: str | None
    recorded_at: datetime


class _Outcome(NamedTuple):
    agent: str
    record_ts: datetime
    agent_id: str | None
    session_id: str | None


class _Ledger:
    """core.autoagent_trial_ledger as the writer and the open-state read see it: append-only,
    a taken dedupe_key adds no row (ON CONFLICT DO NOTHING), payload stored as JSON."""

    def __init__(self) -> None:
        self.rows: list[_LedgerRow] = []
        self.refused: list[str] = []
        self.faulted: set[str] = set()
        self.write_fault: Exception | None = None
        self.is_key_taken = False
        self.clock = _NOW  # recorded_at of the next row
        self.outcomes: list[_Outcome] = []
        self.manifest_agent_ids: set[str] = set()
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

    def _open(self, duration: dict = _DURATION) -> None:
        """An open A/A started on the current scoped fingerprint."""
        self.ledger.write(
            _get_trial_ledger().EVENT.AA_START,
            _get_trial_ledger().ACTOR.AA,
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
# before the window: a task member the spawn read returns, never counted
_EARLIER_SPAWN = _spawn("p0", "a", -1, overage=1, stop=False)


def _get_window_clusters(spawns: tuple[SpawnFacts, ...], is_event) -> list[list[float]]:
    clusters: dict[str, list[float]] = {}
    for spawn in spawns:
        clusters.setdefault(spawn.session_id, []).append(float(is_event(spawn)))
    return list(clusters.values())


def _get_expected_python_effects() -> tuple[object, object]:
    """(overage, emit failure) session design effects of the in-window Python spawns."""
    overage = trial_design.get_design_effect(
        _get_window_clusters(_SPAWNS.python, lambda spawn: spawn.overage_rows > 0)
    )
    emit = trial_design.get_design_effect(
        _get_window_clusters(_SPAWNS.python, lambda spawn: not spawn.has_subagent_stop)
    )
    return overage, emit


def _get_report_stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _get_report(generated_at: datetime, *, lines_read: int, rows_present: int) -> dict:
    """A cycle report as the cycle writes it: its start stamp and one closed MANIFEST spool."""
    closed = [
        {
            "spool": "manifest.log.spool",
            "lines_read": lines_read,
            "rows_present": rows_present,
        }
    ]
    return {
        "generated_at": _get_report_stamp(generated_at),
        "manifest_ingest": {"status": "ok", "closed": closed, "rotated_to": None},
    }


def _arms(control: tuple[int, int], treatment: tuple[int, int]) -> object:
    return dc.TrialArms(dc.ArmCount(*control), dc.ArmCount(*treatment))


class _AaResultFixture(_AaFixture):
    """An A/A opened 15 days before now under the small duration rule, with evidence that passes."""

    def setUp(self) -> None:
        super().setUp()
        self.dir = dc.AaDir(self.agents_dir, self.scratch / "reports")
        self.dir.reports.mkdir()
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
        self._write_report(_START + timedelta(days=2), lines_read=10, rows_present=10)

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

    def _write_report(
        self, generated_at: datetime, *, lines_read: int, rows_present: int
    ) -> None:
        report = _get_report(
            generated_at, lines_read=lines_read, rows_present=rows_present
        )
        self._put_report(generated_at.date().isoformat(), report)

    def _put_report(self, day: str, report: dict) -> None:
        path = self.dir.reports / f"autoagent-{day}.json"
        path.write_text(json.dumps(report), encoding="utf-8")

    def _move_window_start(self, start: datetime) -> None:
        event = _get_trial_ledger().EVENT.AA_START
        self.ledger.rows = [
            row._replace(recorded_at=start) if row.event == event else row
            for row in self.ledger.rows
        ]

    def _evaluate(self, cycle_date: str = _CYCLE_DATE, ingest: object = None) -> str:
        return self._cycle(
            cycle_date,
            manifest_ingest=ingest,
            agents_dir=self.dir.agents,
            reports_dir=self.dir.reports,
        )

    def _get_results(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(_get_trial_ledger().EVENT.AA_RESULT)

    def _get_verdicts(self) -> dict[str, str]:
        (result,) = self._get_results()
        return {
            name: criterion["verdict"]
            for name, criterion in result.payload["criteria"].items()
        }

    def _get_design_effect_rows(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(_get_trial_ledger().EVENT.AA_SESSION_DESIGN_EFFECT)


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
        self.assertEqual(len(self.spawn_reads), 1)

    def test_the_result_writes_the_higher_metric_design_effect_once_per_agent_for_the_power_readers(
        self,
    ) -> None:
        overage, emit = _get_expected_python_effects()
        self.assertNotEqual(overage.selected, emit.selected)
        expected = max(overage, emit, key=lambda effect: effect.selected)

        self._evaluate()

        rows = self._get_design_effect_rows()
        self.assertEqual(
            [(row.agent, row.actor, row.payload, row.dedupe_key) for row in rows],
            [
                (
                    "glass-atrium-dev-python",
                    "daemon-cycle-aa",
                    expected._asdict(),
                    "aa-session-design-effect:1:glass-atrium-dev-python",
                )
            ],
        )
        self.assertEqual(
            dc._get_design_effects([(row.agent, row.payload) for row in rows]),
            ({"glass-atrium-dev-python": expected.selected}, frozenset()),
        )
        (result,) = self._get_results()
        self.assertEqual(
            result.payload["criteria"]["design_effect"]["undefined"],
            ["glass-atrium-dev-shell"],
        )

    def test_the_evidence_reads_cover_the_roster_with_its_aliases_from_the_window_start(
        self,
    ) -> None:
        self._evaluate()

        ((agents, windows),) = self.spawn_reads
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
            _get_trial_ledger().EVENT.AA_RESTART,
            _get_trial_ledger().ACTOR.AA,
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


class AaResultFailTest(_AaResultFixture):
    def test_each_failing_criterion_fails_the_result(self) -> None:
        def _lose_a_line_in_the_window() -> None:
            self._write_report(
                _START + timedelta(days=5), lines_read=10, rows_present=9
            )

        def _corrupt_a_window_report() -> None:
            (
                self.dir.reports
                / f"autoagent-{(_START + timedelta(days=6)).date()}.json"
            ).write_text("{", encoding="utf-8")

        def _remove_every_event() -> None:
            self.spawns["glass-atrium-dev-python"] = tuple(
                _exposed(_spawn(f"q{index}", f"r{index % 3}", index + 1))
                for index in range(6)
            )

        def _put_every_python_spawn_in_treatment() -> None:
            treated = (
                f"t{index}" for index in range(100) if _get_arm(1, f"t{index}") == 1
            )
            self.spawns["glass-atrium-dev-python"] = tuple(
                _exposed(spawn._replace(agent_id=agent_id))
                for spawn, agent_id in zip(_SPAWNS.python, treated)
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
                _put_every_python_spawn_in_treatment,
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
            ("a window report lost a line", _lose_a_line_in_the_window, None, "sink"),
            ("a window report unreadable", _corrupt_a_window_report, None, "sink"),
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
            _get_trial_ledger().EVENT.AA_RESTART,
            _get_trial_ledger().ACTOR.AA,
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


class AaReportWindowTest(_AaResultFixture):
    def test_the_sink_reads_a_report_exactly_when_its_cycle_ran_from_the_window_start(
        self,
    ) -> None:
        late_start = datetime(2026, 9, 22, 18, 0, tzinfo=timezone.utc)
        midnight_start = datetime(2026, 9, 22, 0, 0, 30, tzinfo=timezone.utc)
        rows = (
            (
                "a report from the day before the window is not read",
                _START,
                "2026-09-21",
                _get_report(_START - timedelta(days=1), lines_read=10, rows_present=0),
                ("pass", 0),
            ),
            (
                "an old-format report the start day's cycle wrote before the start is not read",
                _START,
                "2026-09-22",
                {"generated_at": _get_report_stamp(_START - timedelta(hours=3))},
                ("pass", 0),
            ),
            (
                "a report written after a start late in the UTC day is read whatever offset the start carries",
                late_start.astimezone(timezone(timedelta(hours=9))),
                "2026-09-22",
                _get_report(
                    late_start + timedelta(hours=2), lines_read=10, rows_present=9
                ),
                ("fail", 1),
            ),
            (
                "a report named the day before whose cycle stamped past midnight into the window is read",
                midnight_start,
                "2026-09-21",
                _get_report(
                    midnight_start + timedelta(seconds=30),
                    lines_read=10,
                    rows_present=9,
                ),
                ("fail", 1),
            ),
        )
        for name, start, day, report, (verdict, lost) in rows:
            with self.subTest(name):
                self.setUp()
                self._move_window_start(start)
                self._put_report(day, report)

                self._evaluate()

                (result,) = self._get_results()
                sink = result.payload["criteria"]["sink"]
                self.assertEqual(
                    (sink["verdict"], sink["lines_lost"], sink["unreadable_reports"]),
                    (verdict, lost, []),
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
        self.ledger.write_fault = ConnectionError("PG unreachable")

        stderr_text = self._evaluate("2026-10-07")
        self.ledger.write_fault = None
        self._evaluate("2026-10-08")

        self.assertIn(
            "WARN: A/A harness — aa-session-design-effect:1:glass-atrium-dev-python not written",
            stderr_text,
        )
        self.assertIn("aa-result deferred to a later cycle", stderr_text)
        self.assertEqual(len(self._get_results()), 1)
        self.assertEqual(len(self._get_design_effect_rows()), 1)


class CycleWiringTest(_AaResultFixture):
    """run_cycle runs the stage on a writing cycle, fed this cycle's MANIFEST ingest and its
    agents_dir; no-write mode (--dry-run → skip_loop_emit) writes no ledger row."""

    def setUp(self) -> None:
        super().setUp()
        env = mock.patch.dict(
            os.environ,
            {
                "GA_DATA_ROOT": str(self.scratch),
                "AUTOAGENT_REPORTS_DIR": str(self.dir.reports),
            },
        )
        env.start()
        self.addCleanup(env.stop)

        def _refuse(*args: object, **kwargs: object) -> None:
            raise ConnectionRefusedError("corpus audit: no database in this test")

        self._patch("_pg_read_pending_patterns", list)
        self._patch("_pg_write_corpus_audit", _refuse)
        self._patch("_pg_write_loop_event", lambda *args, **kwargs: True)
        # reports dir: run_cycle leaves it to the install default → pinned to the fixture's
        self._patch(
            "run_aa_stage",
            functools.partial(dc.run_aa_stage, reports_dir=self.dir.reports),
        )

    def _run_cycle(self, *, skip_loop_emit: bool) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            dc.run_cycle(
                log_path=self.scratch / "learning-log.md",
                agents_dir=self.dir.agents,
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
        ((names, _),) = self.spawn_reads
        self.assertEqual(names, dc._get_roster_names(frozenset(_ROSTER)))


# sha256 of the empty text: the A/A's pre-registered canary
_EMPTY_TEXT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
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

        def _replace_and_read(source: str, target: str) -> None:
            seen[Path(target).stem] = json.loads(
                Path(target).read_text(encoding="utf-8")
            )
            replace(source, target)

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

    def test_the_hook_delivers_a_daemon_written_canary_only_inside_its_lease(
        self,
    ) -> None:
        home = self.scratch / "home"
        home.mkdir()
        manifest_log = self.scratch / "manifest.log"
        rows = (
            ("in lease", timedelta(0), "1"),
            ("lease ended", _LEASE + timedelta(minutes=1), "0"),
        )
        for name, age, delivered in rows:
            with self.subTest(name):
                written_at = datetime.now(timezone.utc) - age
                # salt 7 puts agent_id a1 in the treatment arm
                dc.put_canary_file("glass-atrium-dev-python", 7, "", written_at)
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
                        "INJECT_SCOPE_RULES_SPAWN_COUNTER": str(
                            self.scratch / "spawns"
                        ),
                    },
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                last = manifest_log.read_text(encoding="utf-8").splitlines()[-1]
                self.assertIn(" arm=1 ", last)
                self.assertIn(f" delivered={delivered} ", last)

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
                _get_trial_ledger().EVENT.AA_RESULT,
                _get_trial_ledger().ACTOR.AA,
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
                (event, _get_trial_ledger().ACTOR.AA, json.dumps(payload), dedupe_key),
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


if __name__ == "__main__":
    unittest.main()
