"""Contract tests for the status-agnostic coverage read (plan clauded-docs/39762, Q4).

``read_coverage_learning_patterns`` in ``hooks/_pg_learning_dualwrite.py`` returns every
``core.learning_log`` row whatever its status, and ``None`` on ANY failure — never the
empty list the intake read falls back to, which would let an outage read as "the label
covers no stored row". ``daemon_cycle.get_coverage_rows_by_agent`` carries that ``None``
through to its caller.

Database-free AND driver-free: the CI python leg installs no psycopg, so the helper is
imported under a stub driver scoped to that one import, then each test patches the
module's ``psycopg`` binding. The helper import is unguarded — a skip would report green
while asserting nothing.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_coverage_read_contract.py -v
    python3 -m unittest autoagent.test.test_coverage_read_contract -v

CID: 2026-09-17T2000_apply-guard-impl_3f9a
"""

from __future__ import annotations

import contextlib
import io
import re
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))


class _StubOperationalError(Exception):
    pass


def _stub_driver() -> ModuleType:
    """Only the surface the helper's import touches; connect refuses loudly."""

    def _refuse_connect(*_args: object, **_kwargs: object):
        raise _StubOperationalError("stub driver: no connection is ever opened")

    errors = ModuleType("psycopg.errors")
    driver = ModuleType("psycopg")
    driver.OperationalError = _StubOperationalError
    driver.errors = errors
    driver.connect = _refuse_connect
    return driver


@contextlib.contextmanager
def _importable_helper():
    """Stub the driver only when the real one is absent, and never leave a stub-bound
    helper cached — a later ``import daemon_cycle`` in the same discovery run would
    otherwise bind to it and flip its psycopg-absent gates."""
    names = ("psycopg", "psycopg.errors", "_pg_learning_dualwrite")
    saved = {name: sys.modules.get(name) for name in names}
    try:
        import psycopg  # noqa: F401

        stubbed = False
    except ImportError:
        driver = _stub_driver()
        sys.modules["psycopg"] = driver
        sys.modules["psycopg.errors"] = driver.errors
        stubbed = True
    try:
        yield
    finally:
        if stubbed:
            for name, prior in saved.items():
                if prior is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = prior


with _importable_helper():
    import _pg_learning_dualwrite as pgdw

try:
    import daemon_cycle as dc

    _DC_IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — import failure → skip, not error
    dc = None  # type: ignore[assignment]
    _DC_IMPORT_ERROR = exc


class _ScriptedCursor:
    def __init__(self, conn: "_ScriptedConn") -> None:
        self._conn = conn

    def __enter__(self) -> "_ScriptedCursor":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def execute(self, sql: str, params: object = ()) -> None:
        self._conn.statements.append(sql)
        if self._conn.fail_at == "execute":
            raise _StubOperationalError("simulated execute failure")

    def fetchall(self) -> list[tuple]:
        if self._conn.fail_at == "fetchall":
            raise RuntimeError("simulated non-driver failure mid-read")
        return list(self._conn.rows)


class _ScriptedConn:
    def __init__(self, rows: list[tuple], fail_at: str | None) -> None:
        self.rows = rows
        self.fail_at = fail_at
        self.statements: list[str] = []

    def __enter__(self) -> "_ScriptedConn":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def cursor(self) -> _ScriptedCursor:
        return _ScriptedCursor(self)


def _read(rows: list[tuple] | None = None, fail_at: str | None = None):
    """Run the helper against a scripted driver; returns (result, conn, stderr)."""
    conn = _ScriptedConn(rows or [], fail_at)

    def _connect(*_args: object, **_kwargs: object) -> _ScriptedConn:
        if fail_at == "connect":
            raise _StubOperationalError("simulated connection failure")
        return conn

    driver = SimpleNamespace(connect=_connect, OperationalError=_StubOperationalError)
    buf = io.StringIO()
    with mock.patch.object(pgdw, "psycopg", driver), contextlib.redirect_stderr(buf):
        result = pgdw.read_coverage_learning_patterns()
    return result, conn, buf.getvalue()


class CoverageReadContractTest(unittest.TestCase):
    """None on any failure; [] only for a completed empty read; every status kept."""

    def test_when_the_read_fails_at_any_point_then_result_is_none_and_loud(self) -> None:
        for fail_at in ("connect", "execute", "fetchall"):
            with self.subTest(fail_at=fail_at):
                result, _, err = _read([(1, "x|a", "a", "identified")], fail_at)
                self.assertIsNone(result)
                self.assertIn("read_coverage_learning_patterns", err)

    def test_when_the_read_completes_on_an_empty_table_then_result_is_empty_not_none(self) -> None:
        result, _, _ = _read([])
        self.assertEqual(result, [])

    def test_when_rows_span_every_status_then_every_row_is_returned(self) -> None:
        statuses = ("identified", "proposed", "approved", "applied", "rejected")
        rows = [
            (i, f"label {i}|glass-atrium-dev-nestjs", "glass-atrium-dev-nestjs", status)
            for i, status in enumerate(statuses, start=1)
        ]
        result, conn, _ = _read(rows)
        self.assertEqual(
            [(r["id"], r["status"]) for r in result],
            [(i, status) for i, _, _, status in rows],
        )
        # The driver answers whatever it is scripted with, so status agnosticism
        # is pinned where production decides it: the executed statement.
        self.assertEqual(len(conn.statements), 1)
        self.assertNotRegex(conn.statements[0], re.compile(r"\bstatus\s*(=|IN\b)", re.I))
        self.assertNotEqual(conn.statements[0], pgdw._PENDING_PATTERNS_SELECT_SQL)


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_DC_IMPORT_ERROR,))
class CoverageIndexContractTest(unittest.TestCase):
    """get_coverage_rows_by_agent carries an unavailable read through as None."""

    def test_when_the_read_is_unavailable_then_the_index_is_none(self) -> None:
        # (helper imported, reader answer)
        for has_read, answer in ((True, None), (False, [])):
            with self.subTest(has_read=has_read):
                reader = mock.Mock(return_value=answer)
                with mock.patch.object(dc, "HAS_PG_PATTERN_READ", has_read), mock.patch.object(
                    dc, "_pg_read_coverage_patterns", reader, create=True
                ):
                    self.assertIsNone(dc.get_coverage_rows_by_agent())

    def test_when_rows_carry_bare_and_prefixed_agents_then_both_index_under_the_intake_key(self) -> None:
        rows = [
            {"id": 1, "pattern_signature": "p|dev-react", "agent": "dev-react", "status": "rejected"},
            {"id": 2, "pattern_signature": "p|glass-atrium-dev-react",
             "agent": "glass-atrium-dev-react", "status": "applied"},
        ]
        with mock.patch.object(dc, "HAS_PG_PATTERN_READ", True), mock.patch.object(
            dc, "_pg_read_coverage_patterns", return_value=rows, create=True
        ), mock.patch.object(
            dc, "_pg_read_pending_patterns", return_value=rows, create=True
        ):
            coverage = dc.get_coverage_rows_by_agent()
            intake = dc.get_pattern_rows_by_agent()
        self.assertEqual(set(coverage), set(intake))
        self.assertEqual([r["id"] for r in coverage[dc._canon_agent_key("glass-atrium-dev-react")]], [1, 2])


if __name__ == "__main__":
    unittest.main()
