"""Regression test for the ``poisoned_window`` learning-signal exclusion (OM-1c).

``read_outcomes_since`` in ``hooks/_pg_learning_dualwrite.py`` is the single SQL
chokepoint reading ``core.outcomes`` for BOTH learning consumers — every
``daemon_cycle.py`` lookback (outcome signals / related outcomes / generation
outcomes, all bounded by ``PG_OUTCOME_LOOKBACK_DAYS``) and the
``learning-aggregator.py`` pattern aggregation funnel through it. The protected
invariant: a row flagged ``poisoned_window = true`` (grader-gap mis-measurement
window) never reaches pattern/posterior computation, on ANY call shape — the
filter must live in the always-on WHERE clauses, not in a per-caller kwarg.

The live-PG class exercises the real predicate against fixture rows inserted in
an open, never-committed transaction (rolled back on teardown — the database is
left byte-identical; no DELETE needed). The SQL-shape class needs no database.

Mirrors the deleted autoagent/test conventions (unittest, ``sys.path``
insertion). Run with either runner:
    uv run --with pytest pytest autoagent/test/test_poisoned_window_exclusion.py -v
    python3 -m unittest autoagent.test.test_poisoned_window_exclusion -v

CID: 2026-06-10T0810_atrium-normalize_b3f1
"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

# autoagent/test/<this> → repo root holds hooks/_pg_learning_dualwrite.py. The
# helper re-raises on missing psycopg (its documented fallback contract), so the
# import failure downgrades to a skip instead of an error.
_HOOKS_DIR = Path(__file__).resolve().parent.parent.parent / "hooks"
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))

try:
    import _pg_learning_dualwrite as pgdw

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    pgdw = None  # type: ignore[assignment]  # sentinel consumed by skipIf only
    _IMPORT_ERROR = exc

_POISONED_CLAUSE = "COALESCE(poisoned_window, false) = false"
_PROBE_AGENT = "om1c-poison-probe"
_POISONED_CID = "om1c-test-poisoned"
_CLEAN_CID = "om1c-test-clean"


class _RecordingCursor:
    def __init__(self, log: list[tuple[str, tuple]]) -> None:
        self._log = log

    def __enter__(self) -> "_RecordingCursor":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def execute(self, sql: str, params: tuple = ()) -> None:
        self._log.append((sql, params))

    def fetchall(self) -> list:
        return []


class _RecordingConn:
    def __init__(self, log: list[tuple[str, tuple]]) -> None:
        self._log = log

    def __enter__(self) -> "_RecordingConn":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def cursor(self) -> _RecordingCursor:
        return _RecordingCursor(self._log)


class _NonCommittingConn:
    """Hand the helper an already-open transaction; swallow its context exit so
    neither commit nor close fires — the owning test rolls back instead.
    """

    def __init__(self, conn: object) -> None:
        self._conn = conn

    def __enter__(self) -> "_NonCommittingConn":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def cursor(self):  # noqa: ANN201 — real psycopg cursor, type lives upstream
        return self._conn.cursor()


@unittest.skipIf(pgdw is None, f"_pg_learning_dualwrite import failed: {_IMPORT_ERROR}")
class TestLookbackSqlCarriesPoisonedFilter(unittest.TestCase):
    """The exclusion is part of the always-on WHERE — present on every call shape."""

    def setUp(self) -> None:
        self._log: list[tuple[str, tuple]] = []
        stub = SimpleNamespace(connect=lambda *a, **k: _RecordingConn(self._log))
        patcher = mock.patch.object(pgdw, "psycopg", stub)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _executed_sql(self) -> str:
        self.assertEqual(len(self._log), 1, "helper must execute exactly one SELECT")
        return self._log[0][0]

    def test_when_called_without_kwargs_then_where_carries_poisoned_filter(
        self,
    ) -> None:
        # The aggregator path: since-only, ASC, no LIMIT.
        pgdw.read_outcomes_since(0.0)
        sql = self._executed_sql()
        self.assertIn(_POISONED_CLAUSE, sql)
        self.assertLess(sql.index(_POISONED_CLAUSE), sql.index("ORDER BY"))

    def test_when_called_agent_scoped_then_where_carries_poisoned_filter(self) -> None:
        # The daemon_cycle posterior/related/generation path: agent + LIMIT + DESC.
        pgdw.read_outcomes_since(0.0, agent="dev-python", limit=5, order="DESC")
        self.assertIn(_POISONED_CLAUSE, self._executed_sql())


@unittest.skipIf(pgdw is None, f"_pg_learning_dualwrite import failed: {_IMPORT_ERROR}")
class TestPoisonedRowExcludedFromLookback(unittest.TestCase):
    """A flagged fixture row never comes back; its clean sibling always does."""

    conn = None

    @classmethod
    def setUpClass(cls) -> None:
        import psycopg

        try:
            cls.conn = psycopg.connect("dbname=glass_atrium", connect_timeout=2)
        except Exception as exc:  # noqa: BLE001 — no PG → skip the live class
            raise unittest.SkipTest(f"PG unreachable: {type(exc).__name__}: {exc}")
        cls.addClassCleanup(cls._rollback_and_close)

        now = time.time()
        with cls.conn.cursor() as cur:
            for offset, cid, poisoned in (
                (120.0, _POISONED_CID, True),
                (60.0, _CLEAN_CID, False),
            ):
                cur.execute(
                    "INSERT INTO core.outcomes "
                    "(record_ts, agent, task_type, result, attribution_source, "
                    " summary, cid, poisoned_window) "
                    'VALUES (to_timestamp(%s), %s, %s::core."TaskType", '
                    '        %s::core."OutcomeResult", %s, %s, %s, %s)',
                    (
                        now - offset,
                        _PROBE_AGENT,
                        "feature",
                        "done",
                        "hook-input",
                        "om1c poisoned-window exclusion fixture",
                        cid,
                        poisoned,
                    ),
                )

        stub = SimpleNamespace(connect=lambda *a, **k: _NonCommittingConn(cls.conn))
        cls._patcher = mock.patch.object(pgdw, "psycopg", stub)
        cls._patcher.start()
        cls.addClassCleanup(cls._patcher.stop)

    @classmethod
    def _rollback_and_close(cls) -> None:
        if cls.conn is not None:
            cls.conn.rollback()
            cls.conn.close()

    def test_when_row_flagged_then_agent_scoped_lookback_excludes_it(self) -> None:
        rows = pgdw.read_outcomes_since(
            time.time() - 300, agent=_PROBE_AGENT, limit=10, order="DESC"
        )
        cids = [row.get("cid") for row in rows]
        self.assertEqual(cids, [_CLEAN_CID])

    def test_when_row_flagged_then_aggregator_lookback_excludes_it(self) -> None:
        rows = pgdw.read_outcomes_since(time.time() - 300)
        cids = {row.get("cid") for row in rows}
        self.assertIn(_CLEAN_CID, cids)
        self.assertNotIn(_POISONED_CID, cids)


if __name__ == "__main__":
    unittest.main(verbosity=2)
