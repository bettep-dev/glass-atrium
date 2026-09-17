"""Behavioral tests for the cycle-level all-reject alert (AP-1).

``run_cycle`` now ends with ``alert_all_reject_streak``: when the current
in-memory cycle produced >=1 proposal and ALL of them are 'rejected', and the
prior persisted cycles extend the streak to ALL_REJECT_ALERT_THRESHOLD, a
loud WARN is emitted (stderr + ``eval_result='all-reject-alert'`` loop event).
No test writes PG — ``_pg_connect`` and ``_invoke_pg_helper`` are mocked.

Run with either runner:
    uv run --with pytest --with psycopg pytest autoagent/test/test_all_reject_alert.py -v
    python3 -m unittest autoagent.test.test_all_reject_alert -v

CID: 2026-06-10T0810_atrium-normalize_b3f1
"""

from __future__ import annotations

import contextlib
import io
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))
_STUB_DIR = _REPO_ROOT / "scripts" / "test"
if str(_STUB_DIR) not in sys.path:
    sys.path.insert(0, str(_STUB_DIR))

import _pg_stub_backend as stub  # noqa: E402 — stdlib-only, anchored above

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dc = None  # type: ignore[assignment]  # sentinel consumed by skipIf only
    _IMPORT_ERROR = exc

_CYCLE_DATE = "2026-06-10"


def _patch_result(status: str, haiku_status: str = "ok") -> "dc.PatchResult":
    return dc.PatchResult(
        pattern_label="probe pattern",
        pattern_agent="probe-agent",
        pattern_frequency="3",
        target_file="/tmp/probe-agent.md",
        classification="reject" if status == "rejected" else "body-auto",
        rationale="",
        proposed_diff="",
        outcomes_sampled=0,
        haiku_status=haiku_status,
        status=status,
    )


def _report(statuses: list[str], markers: int = 0) -> "dc.CycleReport":
    patches = [_patch_result(s) for s in statuses]
    patches += [
        _patch_result("rejected", dc.TIMEOUT_BACKOFF_HAIKU_STATUS)
        for _ in range(markers)
    ]
    return dc.CycleReport(
        cycle_date=_CYCLE_DATE,
        generated_at="2026-06-10T00:00:00.000Z",
        patterns_processed=len(patches),
        cost_guard={},
        patches=patches,
    )


def _mock_pg_connect(fetchall_result: list[tuple[int]]) -> mock.MagicMock:
    cursor = mock.MagicMock()
    cursor.fetchall.return_value = fetchall_result
    conn = mock.MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    connect = mock.MagicMock()
    connect.return_value.__enter__.return_value = conn
    return connect


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class _AlertFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.emitted: list[dict[str, object]] = []
        patcher = mock.patch.object(
            dc,
            "_invoke_pg_helper",
            side_effect=lambda env: self.emitted.append(env) or True,
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        threshold = mock.patch.object(dc, "ALL_REJECT_ALERT_THRESHOLD", 3)
        threshold.start()
        self.addCleanup(threshold.stop)

    def _run(self, report: "dc.CycleReport", prior: int) -> str:
        stderr = io.StringIO()
        with mock.patch.object(
            dc, "_prior_all_reject_cycle_count", return_value=prior
        ), contextlib.redirect_stderr(stderr):
            dc.alert_all_reject_streak(report)
        return stderr.getvalue()


class TestAlertAllRejectStreak(_AlertFixture):
    """Threshold semantics: current all-reject cycle + prior persisted streak."""

    def test_when_streak_reaches_threshold_then_warn_and_loop_event(self) -> None:
        err = self._run(_report(["rejected", "rejected"]), prior=2)
        self.assertIn("all-reject streak", err)
        self.assertEqual(len(self.emitted), 1)
        args = self.emitted[0]["args"]
        self.assertEqual(args["eval_result"], "all-reject-alert")
        self.assertEqual(args["agent"], "daemon-cycle")

    def test_when_prior_streak_too_short_then_silent(self) -> None:
        err = self._run(_report(["rejected", "rejected"]), prior=1)
        self.assertEqual(err, "")
        self.assertEqual(self.emitted, [])

    def test_when_any_non_rejected_proposal_then_no_alert(self) -> None:
        err = self._run(_report(["rejected", "pending"]), prior=5)
        self.assertEqual(err, "")
        self.assertEqual(self.emitted, [])

    def test_when_snoozed_proposal_then_streak_broken(self) -> None:
        err = self._run(_report(["rejected", "snoozed"]), prior=5)
        self.assertEqual(err, "")
        self.assertEqual(self.emitted, [])

    def test_when_only_backoff_markers_then_no_alert(self) -> None:
        err = self._run(_report([], markers=2), prior=5)
        self.assertEqual(err, "")
        self.assertEqual(self.emitted, [])

    def test_when_markers_beside_rejects_then_judged_on_the_rejects(self) -> None:
        err = self._run(_report(["rejected"], markers=1), prior=2)
        self.assertIn("all-reject streak", err)

    def test_when_no_proposals_then_no_alert(self) -> None:
        err = self._run(_report([]), prior=5)
        self.assertEqual(err, "")
        self.assertEqual(self.emitted, [])


# daemon_cycle imports cleanly without psycopg (HAS_PG_LOOP_WRITE=False) but then
# leaves _pg_connect unbound — patch.object on it would ERROR, so skip instead.
@unittest.skipIf(
    dc is None or not dc.HAS_PG_LOOP_WRITE,
    f"import failed: {_IMPORT_ERROR}"
    if dc is None
    else "psycopg absent: _pg_connect unbound in daemon_cycle",
)
class TestPriorAllRejectCycleCount(unittest.TestCase):
    """Leading-run walk over persisted per-cycle non-rejected counts."""

    def _count(self, rows: list[tuple[int]]) -> int:
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True), mock.patch.object(
            dc, "_pg_connect", _mock_pg_connect(rows)
        ):
            return dc._prior_all_reject_cycle_count(_CYCLE_DATE)

    def test_when_two_all_reject_cycles_then_two(self) -> None:
        self.assertEqual(self._count([(0,), (0,), (3,)]), 2)

    def test_when_latest_cycle_has_non_rejected_then_zero(self) -> None:
        self.assertEqual(self._count([(2,), (0,), (0,)]), 0)

    def test_when_no_prior_cycles_then_zero(self) -> None:
        self.assertEqual(self._count([]), 0)

    def test_when_pg_unavailable_then_fail_open_zero(self) -> None:
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", False):
            self.assertEqual(dc._prior_all_reject_cycle_count(_CYCLE_DATE), 0)

    def test_when_read_raises_then_fail_open_zero(self) -> None:
        connect = mock.MagicMock(side_effect=RuntimeError("boom"))
        stderr = io.StringIO()
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True), mock.patch.object(
            dc, "_pg_connect", connect
        ), contextlib.redirect_stderr(stderr):
            self.assertEqual(dc._prior_all_reject_cycle_count(_CYCLE_DATE), 0)
        self.assertIn("fail-open", stderr.getvalue())


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
@unittest.skipIf(
    sqlite3.sqlite_version_info < (3, 39, 0), "sqlite lacks IS DISTINCT FROM"
)
class TestPriorAllRejectCycleCountOnEngine(unittest.TestCase):
    """The persisted walk's own SQL, run on the stdlib backend."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db = Path(tmp.name) / "proposals.sqlite"
        stub.create_proposals_table(self.db)

    def _count(self, rows: list[tuple[str, str, str | None]]) -> int:
        with closing(sqlite3.connect(self.db)) as db:
            db.executemany(
                "INSERT INTO autoagent_proposals "
                "(cycle_date, pattern_label, target_file, status, haiku_status) "
                "VALUES (?, ?, '/tmp/probe-agent.md', ?, ?)",
                [(day, f"label {i}", s, h) for i, (day, s, h) in enumerate(rows)],
            )
            db.commit()
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True), mock.patch.object(
            dc, "_pg_connect", lambda: stub.create_connection(self.db), create=True
        ):
            return dc._prior_all_reject_cycle_count(_CYCLE_DATE)

    def test_when_a_prior_date_holds_only_markers_then_streak_skips_over_it(
        self,
    ) -> None:
        # Extending would give 3, breaking 1; the NULL outcome row must still count.
        rows = [
            ("2026-06-09", "rejected", None),
            ("2026-06-08", "rejected", dc.TIMEOUT_BACKOFF_HAIKU_STATUS),
            ("2026-06-07", "rejected", "ok"),
            ("2026-06-06", "applied", "ok"),
        ]
        self.assertEqual(self._count(rows), 2)


if __name__ == "__main__":
    unittest.main()
