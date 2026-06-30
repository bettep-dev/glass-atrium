"""Behavioral tests for the negative-signal trigger re-key (AP-3).

Per-agent candidate selection in ``hooks/learning-aggregator.py`` now keys on
the live-signal OR-terms (result fail/blocked/done_with_concerns ·
grader_verdict='verified_fail' · review_flag · revision_count>=2) instead of
result='fail' alone. The OR-term predicate is the SINGLE shared definition in
``_pg_learning_dualwrite`` (``negative_signal_hits``), imported by BOTH the
aggregator emit and the ``daemon_cycle.py`` staleness recompute — covered here:
(1) per-agent pattern row emitted from >=3 blocked/done_with_concerns rows;
(2) dead-signal detector WARNs when a trigger metric has 0 occurrences over a
    non-trivial batch (and stays quiet on tiny batches / live metrics);
(3) poisoned_window rows produce NO pattern end-to-end (real reader against
    live PG fixtures, inserted in an open never-committed transaction —
    rolled back on teardown, database left byte-identical).

Run with either runner:
    uv run --with pytest --with psycopg pytest autoagent/test/test_negative_signal_triggers.py -v
    python3 -m unittest autoagent.test.test_negative_signal_triggers -v

CID: 2026-06-10T0810_atrium-normalize_b3f1
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))

try:
    import _pg_learning_dualwrite as pgdw

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    pgdw = None  # type: ignore[assignment]  # sentinel consumed by skipIf only
    _IMPORT_ERROR = exc


def _load_aggregator():
    """Import learning-aggregator.py despite the dashed filename. The module
    guards ``main()`` under ``if __name__ == "__main__"``, so import runs no
    aggregation."""
    spec = importlib.util.spec_from_file_location(
        "learning_aggregator", _HOOKS_DIR / "learning-aggregator.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


try:
    agg = _load_aggregator() if pgdw is not None else None
except Exception as exc:  # noqa: BLE001 — same skip contract as the pgdw import
    agg = None
    _IMPORT_ERROR = exc

_TRIGGER_AGENT = "ap3-trigger-probe-agent"
_POISONED_AGENT = "ap3-poison-probe-agent"
_CLEAN_AGENT = "ap3-clean-probe-agent"
_COUNT_SIGNATURE_FMT = "repeated failure by same agent|%s"


def _row(agent: str = _TRIGGER_AGENT, result: str = "done", **extra) -> dict:
    """One synthetic reader-shaped outcome row (read_outcomes_since dict contract)."""
    base = {
        "record_ts": None,
        "pg_audit_ref": "pg:test:%s" % agent,
        "agent": agent,
        "task_type": "feature",
        "result": result,
        "revision_count": 0,
        "review_flag": False,
        "grader_verdict": "",
        "metric_pass": None,
        "lesson": "synthetic lesson",
        "attribution_source": "",
    }
    base.update(extra)
    return base


@unittest.skipIf(pgdw is None, f"import failed: {_IMPORT_ERROR}")
class TestNegativeSignalPredicate(unittest.TestCase):
    """Each OR-term trips the trigger exactly once per row; clean rows never do."""

    def test_when_each_or_term_present_then_row_counts(self) -> None:
        for row in (
            _row(result="fail"),
            _row(result="blocked"),
            _row(result="done_with_concerns"),
            _row(grader_verdict="verified_fail"),
            _row(review_flag=True),
            _row(revision_count=2),
        ):
            self.assertTrue(pgdw.is_negative_signal_outcome(row), row)

    def test_when_row_clean_then_no_trigger(self) -> None:
        for row in (
            _row(result="done"),
            _row(result="needs_context"),
            _row(grader_verdict="verified_pass"),
            _row(grader_verdict="unverified"),
            _row(revision_count=1),
        ):
            self.assertFalse(pgdw.is_negative_signal_outcome(row), row)

    def test_when_multiple_terms_trip_then_each_named_once(self) -> None:
        hits = pgdw.negative_signal_hits(
            _row(result="fail", review_flag=True, revision_count=3)
        )
        self.assertEqual(
            hits, ("result=fail", "review_flag=true", "revision_count>=2")
        )


@unittest.skipIf(agg is None, f"import failed: {_IMPORT_ERROR}")
class _AggregatorRunFixture(unittest.TestCase):
    """Run aggregator main() against synthetic rows; record upserts, no PG."""

    def setUp(self) -> None:
        self.upserts: list[dict] = []
        self._tmpdir = tempfile.mkdtemp(prefix="ap3-agg-test-")
        self.addCleanup(self._cleanup_tmpdir)

    def _cleanup_tmpdir(self) -> None:
        for name in os.listdir(self._tmpdir):
            os.unlink(os.path.join(self._tmpdir, name))
        os.rmdir(self._tmpdir)

    def _run(self, rows: list[dict]) -> str:
        def _record_upsert(**kwargs) -> None:
            self.upserts.append(kwargs)

        patchers = (
            mock.patch.object(agg, "HAS_PG_DUALWRITE", True),
            mock.patch.object(agg, "OUTCOMES_DIR", self._tmpdir),
            mock.patch.object(
                agg, "AUDIT_QUEUE_FILE", os.path.join(self._tmpdir, "audit-queue.txt")
            ),
            mock.patch.object(
                agg,
                "AUDIT_QUEUE_PG_OFFSET_FILE",
                os.path.join(self._tmpdir, "audit-queue-pg-offset"),
            ),
            mock.patch.object(agg, "_pg_read_aggregator_watermark", lambda name: 0.0),
            mock.patch.object(agg, "_pg_read_outcomes_since", lambda since: rows),
            mock.patch.object(agg, "_pg_read_learning_log_signatures", lambda: {}),
            mock.patch.object(agg, "_pg_upsert_learning_pattern", _record_upsert),
            mock.patch.object(agg, "_pg_update_aggregator_state", lambda **kw: None),
            mock.patch.object(agg, "_pg_batch_complete", lambda summary: None),
        )
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            agg.main()
        return stderr.getvalue()

    def _upsert_signatures(self) -> set[str]:
        return {u["pattern_signature"] for u in self.upserts}


class TestPerAgentTriggerEmission(_AggregatorRunFixture):
    """>=3 blocked/done_with_concerns rows → per-agent pattern row (AP-3 test 1)."""

    def test_when_three_blocked_or_dwc_rows_then_count_pattern_emitted(self) -> None:
        self._run(
            [
                _row(result="blocked"),
                _row(result="blocked"),
                _row(result="done_with_concerns"),
            ]
        )
        self.assertIn(
            _COUNT_SIGNATURE_FMT % _TRIGGER_AGENT, self._upsert_signatures()
        )

    def test_when_mixed_nonresult_signals_then_count_pattern_emitted(self) -> None:
        self._run(
            [
                _row(grader_verdict="verified_fail"),
                _row(review_flag=True),
                _row(revision_count=2),
            ]
        )
        self.assertIn(
            _COUNT_SIGNATURE_FMT % _TRIGGER_AGENT, self._upsert_signatures()
        )

    def test_when_signals_below_threshold_then_no_count_pattern(self) -> None:
        self._run([_row(result="blocked"), _row(result="blocked"), _row()])
        self.assertNotIn(
            _COUNT_SIGNATURE_FMT % _TRIGGER_AGENT, self._upsert_signatures()
        )


class TestDeadSignalWarn(_AggregatorRunFixture):
    """0-occurrence trigger metric over a non-trivial batch → WARN (AP-3 test 2)."""

    def test_when_metric_has_zero_occurrences_then_warn_fires(self) -> None:
        stderr_text = self._run(
            [_row(result="done")] * agg.DEAD_SIGNAL_MIN_SAMPLE
        )
        self.assertIn("WARN: dead trigger signals", stderr_text)
        self.assertIn("grader_verdict=verified_fail", stderr_text)
        self.assertIn("result=blocked", stderr_text)

    def test_when_metric_live_then_not_listed_as_dead(self) -> None:
        rows = [_row(result="done")] * (agg.DEAD_SIGNAL_MIN_SAMPLE - 1)
        rows.append(_row(result="blocked"))
        stderr_text = self._run(rows)
        self.assertIn("WARN: dead trigger signals", stderr_text)
        self.assertNotIn("result=blocked", stderr_text)
        self.assertIn("result=fail", stderr_text)

    def test_when_batch_below_min_sample_then_no_warn(self) -> None:
        stderr_text = self._run([_row(result="done")] * 3)
        self.assertNotIn("dead trigger signals", stderr_text)


@unittest.skipIf(agg is None, f"import failed: {_IMPORT_ERROR}")
class TestPoisonedRowsEmitNoPattern(_AggregatorRunFixture):
    """poisoned_window fixtures never become a pattern; clean siblings do (AP-3 test 3)."""

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
            for idx, (agent, poisoned) in enumerate(
                [(_POISONED_AGENT, True)] * 3 + [(_CLEAN_AGENT, False)] * 3
            ):
                cur.execute(
                    "INSERT INTO core.outcomes "
                    "(record_ts, agent, task_type, result, attribution_source, "
                    " summary, poisoned_window) "
                    'VALUES (to_timestamp(%s), %s, %s::core."TaskType", '
                    '        %s::core."OutcomeResult", %s, %s, %s)',
                    (
                        now - 120 + idx,
                        agent,
                        "feature",
                        "blocked",
                        "hook-input",
                        "ap3 negative-signal trigger fixture",
                        poisoned,
                    ),
                )

        class _NonCommittingConn:
            """Hand the reader the open fixture transaction; swallow context
            exit so nothing commits — the class rollback restores the DB."""

            def __init__(self, conn: object) -> None:
                self._conn = conn

            def __enter__(self):  # noqa: ANN204 — unittest fixture shim
                return self

            def __exit__(self, *exc: object) -> bool:
                return False

            def cursor(self):  # noqa: ANN201 — real psycopg cursor, type upstream
                return self._conn.cursor()

        stub = SimpleNamespace(connect=lambda *a, **k: _NonCommittingConn(cls.conn))
        cls._patcher = mock.patch.object(pgdw, "psycopg", stub)
        cls._patcher.start()
        cls.addClassCleanup(cls._patcher.stop)

    @classmethod
    def _rollback_and_close(cls) -> None:
        if cls.conn is not None:
            cls.conn.rollback()
            cls.conn.close()

    def _run_with_real_reader(self) -> str:
        """Same fixture patches as _AggregatorRunFixture EXCEPT the reader stays
        the real pgdw.read_outcomes_since (its psycopg is stubbed onto the open
        fixture transaction) — the REAL poisoned filter is what is under test."""

        def _record_upsert(**kwargs) -> None:
            self.upserts.append(kwargs)

        patchers = (
            mock.patch.object(agg, "HAS_PG_DUALWRITE", True),
            mock.patch.object(agg, "OUTCOMES_DIR", self._tmpdir),
            mock.patch.object(
                agg, "AUDIT_QUEUE_FILE", os.path.join(self._tmpdir, "audit-queue.txt")
            ),
            mock.patch.object(
                agg,
                "AUDIT_QUEUE_PG_OFFSET_FILE",
                os.path.join(self._tmpdir, "audit-queue-pg-offset"),
            ),
            mock.patch.object(
                agg, "_pg_read_aggregator_watermark", lambda name: time.time() - 300
            ),
            mock.patch.object(agg, "_pg_read_learning_log_signatures", lambda: {}),
            mock.patch.object(agg, "_pg_upsert_learning_pattern", _record_upsert),
            mock.patch.object(agg, "_pg_update_aggregator_state", lambda **kw: None),
            mock.patch.object(agg, "_pg_batch_complete", lambda summary: None),
        )
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            agg.main()
        return stderr.getvalue()

    def test_when_rows_poisoned_then_no_pattern_for_agent(self) -> None:
        self._run_with_real_reader()
        self.assertNotIn(
            _COUNT_SIGNATURE_FMT % _POISONED_AGENT, self._upsert_signatures()
        )

    def test_when_rows_clean_then_pattern_for_agent(self) -> None:
        # Positive control — proves the poisoned test's absence is the filter,
        # not a broken pipeline.
        self._run_with_real_reader()
        self.assertIn(
            _COUNT_SIGNATURE_FMT % _CLEAN_AGENT, self._upsert_signatures()
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
