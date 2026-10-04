"""The unadjudicated backfill mode: which rows it relabels, its gates and its exit codes.

``daemon_cycle --backfill-unadjudicated --reports-dir <dir>`` relabels stored
non-verdict ``rejected`` rows to ``unadjudicated``. Every row here runs ``_main``
sealed (``seal_pg_reach``), then fakes the connection factory and the label probe
over an in-memory proposals table; ``ps`` is a stub through ``AUTOAGENT_PS_BIN``.

Run with either runner:
    python3 -m unittest autoagent.test.test_unadjudicated_backfill -v
    uv run --with pytest pytest autoagent/test/test_unadjudicated_backfill.py -v
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import sys
import tempfile
import unittest
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Self
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))
_TEST_DIR = Path(__file__).resolve().parent
if str(_TEST_DIR) not in sys.path:
    sys.path.insert(0, str(_TEST_DIR))

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — import failure → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

from _pg_seal import seal_pg_reach  # noqa: E402 — test dir anchored above

_PS_STUB = """#!/bin/sh
printf 'called\\n' >> "$PS_STUB_CALLS"
cat "$PS_STUB_LISTING"
exit "${PS_STUB_RC:-0}"
"""

_ROOT = "/opt/ga"
_STRANGER_PID = 99999901


_TABLE_SQL = "core.autoagent_proposals"
_COLUMNS = ("id", "status", "rationale", "reviewed_by", "reviewed_at")
_STATUS_PARAM_SQL = '(%s)::core."ProposalStatus"'
_NOW = object()
_SELECT_SQL_RE = re.compile(
    rf"SELECT (?P<columns>\w+(?:, \w+)*) FROM {re.escape(_TABLE_SQL)} "
    r"WHERE (?P<where>.+) ORDER BY id LIMIT %s"
)
_UPDATE_SQL_RE = re.compile(
    rf"UPDATE {re.escape(_TABLE_SQL)} SET (?P<assignments>.+?) WHERE (?P<where>.+)"
)
_STATUS_EQ_RE = re.compile(r"status = '(?P<value>\w+)'")
_STATUS_IN_RE = re.compile(r"status IN \((?P<values>'\w+'(?:, ?'\w+')*)\)")


class UnsupportedStatementError(AssertionError):
    """A statement shape the fake cannot evaluate faithfully — refused, never approximated."""


class _FakeProposals:
    """In-memory ``core.autoagent_proposals`` evaluating the SELECT and UPDATE text it receives.

    Selected columns, assigned columns and every WHERE term come from the statement, so a
    widened predicate or an extra SET column changes the table the assertions read.
    """

    def __init__(self, rows: list[dict[str, object]]) -> None:
        self.rows = {int(row["id"]): dict(row) for row in rows}
        self.statements: list[str] = []
        self.selected_ids: list[int] = []
        self.page: list[tuple] = []
        self.after_select = lambda: None
        self.on_commit = lambda: None

    def execute(self, sql: str, params: tuple) -> int:
        statement = " ".join(sql.split())
        self.statements.append(statement)
        bound = iter(params)
        if select := _SELECT_SQL_RE.fullmatch(statement):
            return self._select(select, bound)
        if update := _UPDATE_SQL_RE.fullmatch(statement):
            return self._update(update, bound)
        raise UnsupportedStatementError(statement)

    def _select(self, match: re.Match[str], bound: Iterator[object]) -> int:
        columns = _get_columns(match["columns"].split(", "))
        is_kept = _get_row_filter(match["where"], bound)
        limit = next(bound)
        _require_consumed(bound)
        kept = [row for _, row in sorted(self.rows.items()) if is_kept(row)][:limit]
        self.selected_ids.extend(int(row["id"]) for row in kept)
        self.page = [tuple(row[column] for column in columns) for row in kept]
        self.after_select()
        return len(self.page)

    def _update(self, match: re.Match[str], bound: Iterator[object]) -> int:
        assignments = _get_assignments(match["assignments"], bound)
        is_kept = _get_row_filter(match["where"], bound)
        _require_consumed(bound)
        hits = [row for row in self.rows.values() if is_kept(row)]
        for row in hits:
            row.update(assignments)
        return len(hits)


def _get_columns(names: list[str]) -> list[str]:
    unknown = [name for name in names if name not in _COLUMNS]
    if unknown:
        raise UnsupportedStatementError(f"unknown column(s): {unknown}")
    return names


def _get_row_filter(
    where: str, bound: Iterator[object]
) -> Callable[[dict[str, object]], bool]:
    """Conjunction of the WHERE terms; params bind in text order."""
    checks = [_get_term_check(term, bound) for term in where.split(" AND ")]
    return lambda row: all(check(row) for check in checks)


def _get_term_check(
    term: str, bound: Iterator[object]
) -> Callable[[dict[str, object]], bool]:
    if term == "id > %s":
        after_id = next(bound)
        return lambda row: row["id"] > after_id
    if term == "id = ANY(%s)":
        ids = set(next(bound))
        return lambda row: row["id"] in ids
    if match := _STATUS_EQ_RE.fullmatch(term):
        return lambda row: row["status"] == match["value"]
    if match := _STATUS_IN_RE.fullmatch(term):
        values = set(re.findall(r"'(\w+)'", match["values"]))
        return lambda row: row["status"] in values
    raise UnsupportedStatementError(f"WHERE term: {term}")


def _get_assignments(text: str, bound: Iterator[object]) -> dict[str, object]:
    assignments: dict[str, object] = {}
    for item in text.split(", "):
        column, _, expression = item.partition(" = ")
        assignments[_get_columns([column])[0]] = _get_assigned_value(expression, bound)
    return assignments


def _get_assigned_value(expression: str, bound: Iterator[object]) -> object:
    if expression in (_STATUS_PARAM_SQL, "%s"):
        return next(bound)
    if expression == "now()":
        return _NOW
    if expression == "NULL":
        return None
    if match := re.fullmatch(r"'([^']*)'", expression):
        return match[1]
    raise UnsupportedStatementError(f"SET expression: {expression}")


def _require_consumed(bound: Iterator[object]) -> None:
    if next(bound, _NOW) is not _NOW:
        raise UnsupportedStatementError("more params than placeholders")


class _FakeCursor:
    def __init__(self, table: _FakeProposals) -> None:
        self.table = table
        self.rowcount = -1

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def execute(self, sql: str, params: tuple) -> None:
        self.rowcount = self.table.execute(sql, params)

    def fetchall(self) -> list[tuple]:
        return list(self.table.page)


class _FakeConnection:
    def __init__(self, table: _FakeProposals) -> None:
        self.table = table

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc: object) -> None:
        return None

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self.table)

    def commit(self) -> None:
        self.table.on_commit()


def _row(
    pid: int, rationale: str, reviewed_by: str | None, status: str = "rejected"
) -> dict:
    return {
        "id": pid,
        "status": status,
        "rationale": rationale,
        "reviewed_by": reviewed_by,
        "reviewed_at": None
        if reviewed_by != "monitor-user"
        else "2026-09-01T00:00:00+00:00",
    }


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class UnadjudicatedBackfillTest(unittest.TestCase):
    """``_main`` in backfill mode over a fake table, a stub ``ps`` and a scratch reports dir."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.reports_dir = self.tmp / "daemon-reports"
        self._hold_lock(self.reports_dir, os.getppid())
        self.marker = self.reports_dir / ".unadjudicated-backfill-pending"
        self.record = self.reports_dir / ".unadjudicated-backfill-done"
        self.marker.write_text("", encoding="utf-8")

        stub = self.tmp / "ps-stub"
        stub.write_text(_PS_STUB, encoding="utf-8")
        stub.chmod(0o755)
        self.ps_calls = self.tmp / "ps-calls"
        self.ps_listing = self.tmp / "ps-listing"
        self._set_listing([])
        env = mock.patch.dict(
            os.environ,
            {
                "AUTOAGENT_PS_BIN": str(stub),
                "PS_STUB_CALLS": str(self.ps_calls),
                "PS_STUB_LISTING": str(self.ps_listing),
            },
        )
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("GA_DB_NAME", None)
        os.environ.pop("PS_STUB_RC", None)

        self.table = _FakeProposals([])
        self.connects: list[int] = []
        self.label_state = "present"
        self.reach = seal_pg_reach(self)
        for name, value in (
            ("HAS_PAUSE_LIB", False),
            ("HAS_PG_LOOP_WRITE", True),
            ("_pg_connect", self._connect),
            ("get_proposal_status_label_state", lambda _conn: self.label_state),
            ("_PG_PROPOSAL_STATUS_SQL", _STATUS_PARAM_SQL),
        ):
            patcher = mock.patch.object(dc, name, value, create=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        self.assertEqual(self.reach, [])

    def _connect(self) -> _FakeConnection:
        self.connects.append(1)
        return _FakeConnection(self.table)

    @staticmethod
    def _hold_lock(reports_dir: Path, pid: int) -> None:
        (reports_dir / ".apply-lock").mkdir(parents=True)
        (reports_dir / ".apply-lock" / "pid").write_text(f"{pid}\n", encoding="utf-8")

    def _set_listing(self, others: list[str], parent_args: str = "/bin/zsh") -> None:
        lines = [
            (
                f"{os.getpid()} {os.getppid()} python3 {_ROOT}/autoagent/daemon_cycle.py "
                f"--backfill-unadjudicated --reports-dir {self.reports_dir}"
            ),
            f"{os.getppid()} 1 {parent_args}",
            *others,
        ]
        self.ps_listing.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _run(self, reports_dir: Path | None = None) -> tuple[int, str]:
        stderr = io.StringIO()
        argv = [
            "--backfill-unadjudicated",
            "--reports-dir",
            str(reports_dir or self.reports_dir),
        ]
        with (
            contextlib.redirect_stdout(io.StringIO()),
            contextlib.redirect_stderr(stderr),
        ):
            rc = dc._main(argv)
        return rc, stderr.getvalue()

    def _statuses(self) -> dict[int, object]:
        return {pid: row["status"] for pid, row in self.table.rows.items()}

    def test_relabels_exactly_the_non_adjudication_rejects_and_the_unlanded_updater_rows(
        self,
    ) -> None:
        rows = [
            _row(
                1,
                f"{dc._SUPERSEDE_REASON} by a newer proposal",
                "daemon-cycle-supersede",
            ),
            _row(2, "haiku auth failure (401/credential)", "daemon-cycle-push"),
            _row(3, f"{dc._BELOW_FLOOR_REJECT_PREFIX} 0.2", "daemon-cycle-push"),
            _row(4, f"{dc._PARKED_PATTERN_REASON} — pattern parked", None),
            _row(5, "update did not land: hunk 2 failed", "updater-resolved-gap"),
            _row(
                6, "C2 failed: the diff restates an existing rule", "daemon-cycle-push"
            ),
            _row(
                7,
                f"{dc.REMOVAL_REFUSAL_REASON_PREFIX}: 3 removed lines",
                "daemon-cycle-push",
            ),
            _row(8, f"{dc._SUPERSEDE_REASON} by a newer proposal", "monitor-user"),
            _row(9, "haiku quota limit detected", None, status="pending"),
        ]
        relabeled = {1, 2, 3, 4, 5}
        for page_size in (1, 2, 500):
            with (
                self.subTest(page_size=page_size),
                mock.patch.object(dc, "_UNADJUDICATED_BACKFILL_PAGE_SIZE", page_size),
            ):
                self.table.rows = {row["id"]: dict(row) for row in rows}
                self.table.selected_ids.clear()
                rc, stderr = self._run()
                self.assertEqual(rc, 0, stderr)
                read_statuses = {
                    row["status"]
                    for row in rows
                    if row["id"] in self.table.selected_ids
                }
                self.assertEqual(read_statuses, {"rejected"})
                expected = {row["id"]: row["status"] for row in rows}
                expected.update({pid: "unadjudicated" for pid in relabeled})
                self.assertEqual(self._statuses(), expected)
                for row in rows:
                    stored = self.table.rows[row["id"]]
                    for column in ("rationale", "reviewed_by", "reviewed_at"):
                        self.assertEqual(
                            stored[column], row[column], (row["id"], column)
                        )

    def test_a_row_that_leaves_rejected_after_the_page_read_keeps_its_new_status(
        self,
    ) -> None:
        self.table.rows = {
            1: _row(1, "haiku transient overload", None),
            2: _row(2, "haiku transient overload", None),
        }

        def flip_once() -> None:
            self.table.rows[2]["status"] = "pending"
            self.table.after_select = lambda: None

        self.table.after_select = flip_once
        rc, stderr = self._run()
        self.assertEqual(rc, 0, stderr)
        self.assertEqual(self._statuses(), {1: "unadjudicated", 2: "pending"})

    def test_a_second_run_selects_nothing_and_changes_nothing(self) -> None:
        self.table.rows = {1: _row(1, "haiku transient overload", None)}
        first_rc, _ = self._run()
        after_first = {pid: dict(row) for pid, row in self.table.rows.items()}
        statements_before = len(self.table.statements)
        second_rc, stderr = self._run()
        self.assertEqual((first_rc, second_rc), (0, 0), stderr)
        self.assertEqual(self.table.rows, after_first)
        updates = [
            s
            for s in self.table.statements[statements_before:]
            if s.lstrip().startswith("UPDATE")
        ]
        self.assertEqual(updates, [])

    def test_each_gate_answers_in_precondition_order_before_any_proposal_read(
        self,
    ) -> None:
        cycle_sh = f"4242 1 bash {_ROOT}/autoagent/daemon-cycle.sh"
        regen = f"4343 1 python3 {_ROOT}/autoagent/daemon_cycle.py --regenerate-stale"

        def sandbox_db() -> None:
            os.environ["GA_DB_NAME"] = "sbx_db"

        def install_db() -> None:
            os.environ["GA_DB_NAME"] = "glass_atrium"

        def ps_fails_with_a_foreign_lock() -> None:
            os.environ["PS_STUB_RC"] = "1"
            (self.reports_dir / ".apply-lock" / "pid").write_text(
                f"{_STRANGER_PID}\n", encoding="utf-8"
            )

        def ps_unparseable() -> None:
            self.ps_listing.write_text("PID PPID ARGS\n", encoding="utf-8")

        def foreign_lock() -> None:
            (self.reports_dir / ".apply-lock" / "pid").write_text(
                f"{_STRANGER_PID}\n", encoding="utf-8"
            )

        def no_lock() -> None:
            (self.reports_dir / ".apply-lock" / "pid").unlink()

        def helper_import_failed() -> None:
            dc.HAS_PG_LOOP_WRITE = False

        def label(state: str) -> object:
            return lambda: setattr(self, "label_state", state)

        # (name, setup, rc, ps called, connects)
        rows = (
            ("GA_DB_NAME names a sandbox DB", sandbox_db, 10, False, 0),
            ("GA_DB_NAME names the install DB", install_db, 0, True, 1),
            ("ps fails, lock foreign too", ps_fails_with_a_foreign_lock, 10, True, 0),
            ("ps output unparseable", ps_unparseable, 10, True, 0),
            (
                "ps listing lacks this process",
                lambda: self.ps_listing.write_text(
                    f"{os.getppid()} 1 /bin/zsh\n", encoding="utf-8"
                ),
                10,
                True,
                0,
            ),
            ("lock pid outside the ancestor chain", foreign_lock, 11, True, 0),
            ("lock pid file absent", no_lock, 11, True, 0),
            ("no cycle process", lambda: None, 0, True, 1),
            (
                "daemon-cycle.sh alive",
                lambda: self._set_listing([cycle_sh]),
                10,
                True,
                0,
            ),
            (
                "daemon_cycle.py --regenerate-stale alive",
                lambda: self._set_listing([regen]),
                10,
                True,
                0,
            ),
            (
                "the only match is the mode's own ancestor",
                lambda: self._set_listing(
                    [],
                    parent_args=f"bash {_ROOT}/autoagent/daemon-cycle.sh --backfill-only",
                ),
                0,
                True,
                1,
            ),
            ("helper import failed", helper_import_failed, 7, True, 0),
            ("label absent", label("absent"), 10, True, 1),
            ("label probe unknown", label("unknown"), 10, True, 1),
        )
        for name, setup, want_rc, want_ps, want_connects in rows:
            with self.subTest(name):
                self._reset_row()
                with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True):
                    setup()
                    rc, stderr = self._run()
                self.assertEqual(rc, want_rc, stderr)
                self.assertIn("unadjudicated backfill", stderr)
                self.assertEqual(self.ps_calls.exists(), want_ps, stderr)
                self.assertEqual(len(self.connects), want_connects, stderr)
                if rc != 0:
                    self.assertEqual(self.table.statements, [])
                    self.assertTrue(self.marker.exists())
                    self.assertFalse(self.record.exists())

    def _reset_row(self) -> None:
        """Reset the per-row state the gate table mutates."""
        for name in ("GA_DB_NAME", "PS_STUB_RC"):
            os.environ.pop(name, None)
        self.ps_calls.unlink(missing_ok=True)
        self._set_listing([])
        (self.reports_dir / ".apply-lock" / "pid").write_text(
            f"{os.getppid()}\n", encoding="utf-8"
        )
        self.marker.write_text("", encoding="utf-8")
        self.record.unlink(missing_ok=True)
        self.connects.clear()
        self.table.statements.clear()
        self.label_state = "present"

    def test_the_pause_flag_never_answers_for_the_mode(self) -> None:
        self.table.rows = {1: _row(1, "haiku transient overload", None)}
        with (
            mock.patch.object(dc, "HAS_PAUSE_LIB", True),
            mock.patch.object(dc, "_update_is_pause_active", lambda: True, create=True),
        ):
            os.environ["GA_DB_NAME"] = "sbx_db"
            deferred_rc, deferred_err = self._run()
            os.environ.pop("GA_DB_NAME")
            run_rc, run_err = self._run()
        self.assertEqual(deferred_rc, dc.ExitCode.BACKFILL_DEFERRED, deferred_err)
        self.assertEqual(run_rc, 0, run_err)
        self.assertEqual(self.table.rows[1]["status"], "unadjudicated")

    def test_a_committed_run_writes_the_record_then_removes_the_marker(self) -> None:
        self.table.rows = {1: _row(1, "haiku transient overload", None)}
        rc, stderr = self._run()
        self.assertEqual(rc, 0, stderr)
        self.assertTrue(self.record.is_file())
        self.assertEqual(
            json.loads(self.record.read_text(encoding="utf-8"))["relabeled"], 1
        )
        self.assertFalse(self.marker.exists())

    def test_a_pg_fault_exits_7_with_marker_and_record_as_found(self) -> None:
        def _refused() -> _FakeConnection:
            raise RuntimeError("connection to server on socket failed")

        with mock.patch.object(dc, "_pg_connect", _refused):
            rc, stderr = self._run()
        self.assertEqual(rc, dc.ExitCode.BACKFILL_PG, stderr)
        self.assertIn("unadjudicated backfill", stderr)
        self.assertTrue(self.marker.exists())
        self.assertFalse(self.record.exists())

    def test_a_refused_record_write_after_the_commit_exits_13_and_keeps_the_marker(
        self,
    ) -> None:
        self.table.rows = {1: _row(1, "haiku transient overload", None)}
        self.table.on_commit = lambda: self.reports_dir.chmod(0o555)
        self.addCleanup(self.reports_dir.chmod, 0o755)
        rc, stderr = self._run()
        self.assertEqual(rc, dc.ExitCode.BACKFILL_RECORD_FAILED, stderr)
        self.assertIn("unadjudicated backfill", stderr)
        self.assertEqual(self.table.rows[1]["status"], "unadjudicated")
        self.assertTrue(self.marker.exists())
        self.assertFalse(self.record.exists())

    def test_lock_marker_and_record_derive_from_the_reports_dir_argument(self) -> None:
        other = self.tmp / "other-reports"
        other.mkdir()
        rc, stderr = self._run(other)
        self.assertEqual(rc, dc.ExitCode.BACKFILL_LOCK_NOT_HELD, stderr)
        self._hold_lock(other / "nested", os.getppid())
        rc, stderr = self._run(other / "nested")
        self.assertEqual(rc, 0, stderr)
        self.assertTrue((other / "nested" / ".unadjudicated-backfill-done").is_file())
        self.assertFalse(self.record.exists())
        self.assertTrue(self.marker.exists())

    def test_the_mode_requires_a_reports_dir(self) -> None:
        with (
            contextlib.redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit) as ctx,
        ):
            dc._main(["--backfill-unadjudicated"])
        self.assertEqual(ctx.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
