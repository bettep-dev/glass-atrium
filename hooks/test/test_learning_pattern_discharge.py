"""Contract tests for the core.learning_log status transitions: the state machine, the
identified ↔ dormant status writer, and the pattern-discharge helper (R2 of clauded-docs/760).
DB-level behaviour of the status writer (label-absent schema included) lives in
``learning-pattern-label-fallback.bats``.

``discharge_learning_pattern`` in ``hooks/_pg_learning_dualwrite.py`` transitions one
``core.learning_log`` row to terminal ``'applied'`` with an audit reason, and returns a
TRI-STATE so an outage can never read as "nothing to discharge" — the inherited wart of
the ``reject_learning_pattern`` sibling, whose ``None`` conflates no-match with failure.

Every assertion runs database-free AND driver-free — the CI python leg installs no
psycopg, so a stub-driver layer is what makes the assertions execute rather than skip.
Two layers, in order: the module under test re-raises the psycopg ImportError at module
scope, so a stub driver is installed under the ``psycopg`` import name BEFORE that import
(scoped — see ``_driver_on_sys_modules``); per-test behaviour then comes from the usual
``mock.patch.object`` over the imported module's ``psycopg`` binding. The import is
deliberately UNGUARDED: an import that fails must error loudly, because a skip here
reports green while asserting nothing. Assertions run against the SQL the helper actually
executes and against the enum literal frozen in the squashed baseline migration.

Run with either runner:
    uv run --with pytest pytest hooks/test/test_learning_pattern_discharge.py -v
    python3 -m unittest hooks.test.test_learning_pattern_discharge -v

CID: 2026-07-31T1530_loopexec_a4f6
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

_HOOKS_DIR = Path(__file__).resolve().parent.parent
_REPO_ROOT = _HOOKS_DIR.parent
_MIGRATION = (
    _REPO_ROOT
    / "monitor"
    / "prisma"
    / "migrations"
    / "20260611000000_init_squashed"
    / "migration.sql"
)

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))


def _load_driver():
    """The real psycopg when installed, else a stub carrying exactly the surface the
    import chain touches: ``connect``, ``OperationalError``, and ``errors.IntegrityError``
    (the classifier reads the last one off the submodule binding, not off the module).
    Nothing else is added — an attribute the code never reaches is an invented contract.
    """
    try:
        import psycopg

        return psycopg
    except ImportError:
        pass

    class _Error(Exception):
        """Root of the stub hierarchy, mirroring psycopg.Error."""

    class _OperationalError(_Error):
        pass

    class _IntegrityError(_Error):
        pass

    def _refuse_connect(*_args: object, **_kwargs: object):
        # Every test patches the binding before reaching a connect; an unpatched
        # path must not fall through to a real socket.
        raise _OperationalError("stub driver: no connection is ever opened")

    errors = ModuleType("psycopg.errors")
    errors.Error = _Error
    errors.OperationalError = _OperationalError
    errors.IntegrityError = _IntegrityError

    driver = ModuleType("psycopg")
    driver.Error = _Error
    driver.OperationalError = _OperationalError
    driver.IntegrityError = _IntegrityError
    driver.errors = errors
    driver.connect = _refuse_connect
    return driver


_PSYCOPG = _load_driver()


@contextlib.contextmanager
def _driver_on_sys_modules():
    """Publish the driver under its import names for the duration of one import.

    Scoped, not permanent, and that scoping is load-bearing: sibling modules in the
    same discovery run key their own skip on psycopg being genuinely absent, so a stub
    left behind would silently un-skip them. ``_pg_outcome_dualwrite`` and
    ``_pg_learning_dualwrite`` are restored for the same reason — neighbouring test files
    import them directly, and a cached copy carries the stub as its ``psycopg`` binding.
    """
    names = (
        "psycopg",
        "psycopg.errors",
        "_pg_outcome_dualwrite",
        "_pg_learning_dualwrite",
    )
    saved = {name: sys.modules.get(name) for name in names}
    sys.modules["psycopg"] = _PSYCOPG
    sys.modules["psycopg.errors"] = _PSYCOPG.errors
    try:
        yield
    finally:
        for name, prior in saved.items():
            if prior is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prior


# Unguarded on purpose — see the module docstring. A try/except here would turn a
# broken import back into a green skip, which is the defect this file exists to close.
with _driver_on_sys_modules():
    import _pg_learning_dualwrite as pgdw

_PROBE_ID = 4242
_PROBE_REASON = "r2 probe discharge"


class _Recorder:
    """Shared observation surface for one stubbed connection lifetime."""

    def __init__(self, results: list[list[tuple]] | None = None) -> None:
        self.statements: list[tuple[str, dict]] = []
        self.results = list(results or [])
        self.connects = 0
        self.commits = 0

    def next_rows(self) -> list[tuple]:
        return self.results.pop(0) if self.results else []


class _ScriptedCursor:
    def __init__(self, recorder: _Recorder) -> None:
        self._recorder = recorder
        self._rows: list[tuple] = []

    def __enter__(self) -> "_ScriptedCursor":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def execute(self, sql: str, params: dict | tuple = ()) -> None:
        self._recorder.statements.append((sql, params))
        self._rows = self._recorder.next_rows()

    def fetchall(self) -> list[tuple]:
        return self._rows


class _ScriptedConn:
    def __init__(self, recorder: _Recorder) -> None:
        self._recorder = recorder

    def __enter__(self) -> "_ScriptedConn":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def cursor(self) -> _ScriptedCursor:
        return _ScriptedCursor(self._recorder)

    def commit(self) -> None:
        self._recorder.commits += 1


def _stub_psycopg(recorder: _Recorder):
    """Driver stub that answers from the recorder. ``OperationalError`` is carried
    through because the helper's error classifier reads it off this same binding."""

    def _connect(*_args: object, **_kwargs: object) -> _ScriptedConn:
        recorder.connects += 1
        return _ScriptedConn(recorder)

    return SimpleNamespace(connect=_connect, OperationalError=_PSYCOPG.OperationalError)


def _stub_failing_psycopg(recorder: _Recorder):
    """Driver stub whose every connect raises — the simulated outage."""

    def _connect(*_args: object, **_kwargs: object):
        recorder.connects += 1
        raise _PSYCOPG.OperationalError("simulated connection failure")

    return SimpleNamespace(connect=_connect, OperationalError=_PSYCOPG.OperationalError)


@unittest.skipIf(
    hasattr(_PSYCOPG, "__file__"), "real driver installed — only the stub can leak"
)
class TestStubDriverImportHermeticity(unittest.TestCase):
    """Importing this file leaves no sys.modules entry bound to the stub driver."""

    def test_when_file_imported_then_no_cached_module_binds_the_stub(self) -> None:
        leaked = sorted(
            name
            for name, module in list(sys.modules.items())
            if module is _PSYCOPG
            or (
                isinstance(module, ModuleType)
                and vars(module).get("psycopg") is _PSYCOPG
            )
        )
        self.assertEqual(
            leaked, [], "a later suite would import these with the stub bound"
        )


class TestDischargeHelperSurface(unittest.TestCase):
    """The helper and its tri-state vocabulary exist and are pairwise distinct."""

    def test_when_module_imported_then_discharge_helper_is_exported(self) -> None:
        self.assertTrue(
            callable(getattr(pgdw, "discharge_learning_pattern", None)),
            "discharge_learning_pattern must be an importable callable",
        )

    def test_when_tristate_read_then_three_outcomes_are_pairwise_distinct(self) -> None:
        outcomes = (
            pgdw.DISCHARGE_APPLIED,
            pgdw.DISCHARGE_NOT_MATCHED,
            pgdw.DISCHARGE_FAILED,
        )
        self.assertEqual(len(set(outcomes)), 3, "the tri-state must not collapse")


class TestDischargeInputValidation(unittest.TestCase):
    """Validation raises before any connection is attempted."""

    def setUp(self) -> None:
        self.recorder = _Recorder()
        patcher = mock.patch.object(pgdw, "psycopg", _stub_psycopg(self.recorder))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_when_pattern_id_non_positive_then_raises_before_any_db_call(self) -> None:
        for bad_id in (0, -1, "7", None):
            with self.subTest(pattern_id=bad_id):
                with self.assertRaises(ValueError):
                    pgdw.discharge_learning_pattern(bad_id, _PROBE_REASON)
        self.assertEqual(self.recorder.connects, 0)

    def test_when_reason_empty_then_raises_before_any_db_call(self) -> None:
        for bad_reason in ("", None, 17):
            with self.subTest(reason=bad_reason):
                with self.assertRaises(ValueError):
                    pgdw.discharge_learning_pattern(_PROBE_ID, bad_reason)
        self.assertEqual(self.recorder.connects, 0)


class TestDischargeTransition(unittest.TestCase):
    """The single guarded UPDATE, its audit payload, and its idempotence."""

    def _discharge(self, recorder: _Recorder, reason: str = _PROBE_REASON):
        patcher = mock.patch.object(pgdw, "psycopg", _stub_psycopg(recorder))
        patcher.start()
        self.addCleanup(patcher.stop)
        with contextlib.redirect_stderr(io.StringIO()):
            return pgdw.discharge_learning_pattern(_PROBE_ID, reason)

    def test_when_row_matches_then_result_carries_applied_and_row_id(self) -> None:
        recorder = _Recorder(results=[[(_PROBE_ID,)]])
        result = self._discharge(recorder)
        self.assertEqual(result.outcome, pgdw.DISCHARGE_APPLIED)
        self.assertEqual(result.row_id, _PROBE_ID)
        self.assertEqual(recorder.commits, 1)

    def test_when_no_row_matches_then_result_is_not_matched(self) -> None:
        recorder = _Recorder(results=[[]])
        result = self._discharge(recorder)
        self.assertEqual(result.outcome, pgdw.DISCHARGE_NOT_MATCHED)
        self.assertIsNone(result.row_id)

    def test_when_second_transition_of_same_row_then_result_is_not_matched(self) -> None:
        recorder = _Recorder(results=[[(_PROBE_ID,)], []])
        patcher = mock.patch.object(pgdw, "psycopg", _stub_psycopg(recorder))
        patcher.start()
        self.addCleanup(patcher.stop)
        with contextlib.redirect_stderr(io.StringIO()):
            first = pgdw.discharge_learning_pattern(_PROBE_ID, _PROBE_REASON)
            second = pgdw.discharge_learning_pattern(_PROBE_ID, _PROBE_REASON)
        self.assertEqual(first.outcome, pgdw.DISCHARGE_APPLIED)
        self.assertEqual(second.outcome, pgdw.DISCHARGE_NOT_MATCHED)
        self.assertIsNone(second.row_id)

    def test_when_row_already_terminal_then_sql_guard_matches_nothing(self) -> None:
        # A terminal row is excluded by the WHERE guard, not by python control flow —
        # so exactly one guarded statement runs and the tri-state reports no match.
        recorder = _Recorder(results=[[]])
        result = self._discharge(recorder)
        self.assertEqual(result.outcome, pgdw.DISCHARGE_NOT_MATCHED)
        self.assertEqual(len(recorder.statements), 1)
        sql = recorder.statements[0][0]
        self.assertIn("UPDATE core.learning_log", sql)
        self.assertIn("status NOT IN", sql)
        self.assertIn("'applied'::core.\"LearningStatus\"", sql)
        self.assertIn("'rejected'::core.\"LearningStatus\"", sql)

    def test_when_discharged_then_audit_reason_and_timestamp_are_written(self) -> None:
        recorder = _Recorder(results=[[(_PROBE_ID,)]])
        self._discharge(recorder)
        sql, params = recorder.statements[0]
        self.assertIn("last_transition_at = now()", sql)
        self.assertIn("last_transition_reason = %(reason)s", sql)
        self.assertEqual(params["pattern_id"], _PROBE_ID)
        self.assertEqual(params["reason"], _PROBE_REASON)

    def test_when_reason_overlong_then_truncated_to_column_width(self) -> None:
        recorder = _Recorder(results=[[(_PROBE_ID,)]])
        self._discharge(recorder, reason="x" * 900)
        self.assertEqual(len(recorder.statements[0][1]["reason"]), 500)


class TestDischargeTriStateFailClosed(unittest.TestCase):
    """The inherited wart: an outage MUST NOT read as 'nothing to discharge'."""

    def _discharge_under_outage(self):
        self.recorder = _Recorder()
        patcher = mock.patch.object(
            pgdw, "psycopg", _stub_failing_psycopg(self.recorder)
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        with contextlib.redirect_stderr(io.StringIO()):
            return pgdw.discharge_learning_pattern(_PROBE_ID, _PROBE_REASON)

    def test_when_db_fails_then_result_is_failed_not_no_match(self) -> None:
        result = self._discharge_under_outage()
        self.assertEqual(result.outcome, pgdw.DISCHARGE_FAILED)
        self.assertNotEqual(result.outcome, pgdw.DISCHARGE_NOT_MATCHED)
        self.assertIsNone(result.row_id)

    def test_when_db_fails_then_helper_returns_instead_of_raising(self) -> None:
        # No whole-agent lockout: a driver outage degrades to the FAILED state and the
        # caller keeps control — it never propagates out of the helper.
        result = self._discharge_under_outage()
        self.assertIsNotNone(result)
        self.assertGreaterEqual(self.recorder.connects, 1)

    def test_when_sibling_returns_none_then_discharge_still_distinguishes(self) -> None:
        # The wart this task closes, stated as a comparison against the sibling: the
        # sibling answers None for BOTH shapes, the discharge answers two distinct ones.
        outage = self._discharge_under_outage()
        empty_recorder = _Recorder(results=[[]])
        patcher = mock.patch.object(pgdw, "psycopg", _stub_psycopg(empty_recorder))
        patcher.start()
        self.addCleanup(patcher.stop)
        with contextlib.redirect_stderr(io.StringIO()):
            no_match = pgdw.discharge_learning_pattern(_PROBE_ID, _PROBE_REASON)
        self.assertNotEqual(outage.outcome, no_match.outcome)


class TestStatusTransitionRules(unittest.TestCase):
    """dormant pairs with identified only; rejected and applied stay terminal."""

    def test_transition_is_allowed_exactly_when_it_stays_inside_the_dormancy_rules(self) -> None:
        rows = (
            ("identified", "dormant", True),
            ("dormant", "identified", True),
            ("dormant", "dormant", True),
            ("dormant", "rejected", True),
            (None, "dormant", True),
            ("rejected", "dormant", False),
            ("applied", "dormant", False),
            ("proposed", "dormant", False),
            ("approved", "dormant", False),
            ("dormant", "proposed", False),
            ("dormant", "applied", False),
        )
        for old, new, allowed in rows:
            with self.subTest(transition=f"{old} -> {new}"):
                if allowed:
                    pgdw._validate_status_transition(old, new)
                else:
                    with self.assertRaises(ValueError):
                        pgdw._validate_status_transition(old, new)


class TestStatusWriterInput(unittest.TestCase):
    """The identified ↔ dormant writer validates before any connection is attempted."""

    def setUp(self) -> None:
        self.recorder = _Recorder()
        patcher = mock.patch.object(pgdw, "psycopg", _stub_psycopg(self.recorder))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_status_outside_the_pair_is_refused_before_any_db_call(self) -> None:
        for bad_status in ("proposed", "rejected", "applied", "", None):
            with self.subTest(status=bad_status):
                with self.assertRaises(ValueError):
                    pgdw.put_learning_pattern_status(_PROBE_ID, bad_status, _PROBE_REASON)
        self.assertEqual(self.recorder.connects, 0)

    def test_missing_reason_or_bad_id_is_refused_before_any_db_call(self) -> None:
        for pattern_id, reason in ((_PROBE_ID, ""), (_PROBE_ID, None), (0, _PROBE_REASON)):
            with self.subTest(pattern_id=pattern_id, reason=reason):
                with self.assertRaises(ValueError):
                    pgdw.put_learning_pattern_status(pattern_id, "dormant", reason)
        self.assertEqual(self.recorder.connects, 0)

    def test_outage_reads_as_failed_never_as_not_matched(self) -> None:
        recorder = _Recorder()
        with mock.patch.object(pgdw, "psycopg", _stub_failing_psycopg(recorder)):
            with contextlib.redirect_stderr(io.StringIO()):
                result = pgdw.put_learning_pattern_status(_PROBE_ID, "dormant", _PROBE_REASON)
        self.assertEqual(result.outcome, pgdw.TRANSITION_FAILED)
        self.assertIsNone(result.row_id)


class TestUpsertStatusAndKeyInput(unittest.TestCase):
    """The upsert leaves dormancy to the status writer and takes only a closed-set key."""

    def setUp(self) -> None:
        self.recorder = _Recorder()
        patcher = mock.patch.object(pgdw, "psycopg", _stub_psycopg(self.recorder))
        patcher.start()
        self.addCleanup(patcher.stop)

    def _upsert(self, **overrides: object) -> None:
        kwargs = {
            "pattern_signature": "budget-overage concentration|glass-atrium-dev-python",
            "discovered_date": "2026-10-04",
            "frequency": 5,
            "agent": "glass-atrium-dev-python",
            "status": "identified",
            "approval_tier": "user-pending",
            **overrides,
        }
        pgdw.upsert_learning_pattern(**kwargs)

    def test_dormant_request_is_routed_to_the_status_writer_before_any_db_call(self) -> None:
        with self.assertRaises(ValueError) as caught:
            self._upsert(status="dormant")
        self.assertIn("put_learning_pattern_status", str(caught.exception))
        self.assertEqual(self.recorder.connects, 0)

    def test_metric_key_outside_the_closed_set_is_refused_before_any_db_call(self) -> None:
        for bad_key in ("verified_fail", "", 7):
            with self.subTest(metric_key=bad_key):
                with self.assertRaises(ValueError):
                    self._upsert(metric_key=bad_key)
        self.assertEqual(self.recorder.connects, 0)


class TestDischargeMigrationDrift(unittest.TestCase):
    """No migration is needed — pin the two facts that claim rests on."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.migration = _MIGRATION.read_text(encoding="utf-8")

    def test_when_enum_read_then_applied_is_an_existing_learning_status(self) -> None:
        declaration = re.search(
            r'CREATE TYPE "core"\."LearningStatus" AS ENUM \(([^)]*)\)', self.migration
        )
        self.assertIsNotNone(declaration, "LearningStatus enum must exist")
        members = set(re.findall(r"'([^']+)'", declaration.group(1)))
        self.assertIn("applied", members)

    def test_when_columns_read_then_both_audit_columns_already_exist(self) -> None:
        self.assertIn('"last_transition_at"', self.migration)
        self.assertIn('"last_transition_reason"', self.migration)


if __name__ == "__main__":
    unittest.main()
