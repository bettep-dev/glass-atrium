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
# Unrecognized by classify_failure_rationale → FAILURE_CLASS_QUALITY, its
# default-to-advance branch. A blank rationale classifies as skipped, so every
# threshold case would otherwise pass on a set-aside row.
_QUALITY_RATIONALE = "quality reject — pre-verify failed"


def _backoff_rationale() -> str:
    """The rationale a production back-off row carries — the pinned path."""
    return dc.TIMEOUT_BACKOFF_RATIONALE_TEMPLATE.format(n=3, thr=3)


def _non_adjudicating_rationales() -> dict[str, str]:
    """One production rationale literal per non-adjudication class.

    Built lazily: the literals live on dc, which is None when the import failed.
    """
    return {
        "supersede": dc._SUPERSEDE_REASON + " (2026-06-11)",
        "parked-pattern": dc._PARKED_PATTERN_REASON + " — rows terminal",
        "quota-limit": "haiku quota limit detected",
        "auth-failure": "haiku auth failure — 401 from the CLI",
        "chronic-timeout": _backoff_rationale(),
        "below-floor → skipped": dc._BELOW_FLOOR_REJECT_PREFIX + " (0.21)",
        "empty → skipped": "",
    }


def _patch_result(
    status: str,
    haiku_status: str = "ok",
    rationale: str = _QUALITY_RATIONALE,
) -> "dc.PatchResult":
    return dc.PatchResult(
        pattern_label="probe pattern",
        pattern_agent="probe-agent",
        pattern_frequency="3",
        target_file="/tmp/probe-agent.md",
        classification="reject" if status == "rejected" else "body-auto",
        rationale=rationale,
        proposed_diff="",
        outcomes_sampled=0,
        haiku_status=haiku_status,
        status=status,
    )


def _cycle_report(patches: list["dc.PatchResult"]) -> "dc.CycleReport":
    return dc.CycleReport(
        cycle_date=_CYCLE_DATE,
        generated_at="2026-06-10T00:00:00.000Z",
        patterns_processed=len(patches),
        cost_guard={},
        patches=patches,
    )


def _report(
    statuses: list[str], markers: int = 0, rationale: str = _QUALITY_RATIONALE
) -> "dc.CycleReport":
    patches = [_patch_result(s, rationale=rationale) for s in statuses]
    # Markers are pinned through the RATIONALE prefix a production back-off row
    # carries, not through the back-off haiku_status: the classifier is the SoT,
    # and a blank-rationale marker would drop out too, via the skipped class.
    patches += [
        _patch_result("rejected", dc.TIMEOUT_BACKOFF_HAIKU_STATUS, _backoff_rationale())
        for _ in range(markers)
    ]
    return _cycle_report(patches)


def _mock_pg_connect(fetchall_result: list[tuple[str, str, str]]) -> mock.MagicMock:
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


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestAllRejectedThisCycleClassification(unittest.TestCase):
    """The in-memory discriminator judges a reject by its rationale class.

    Relationship: a 'rejected' patch counts as a rejection iff its own rationale
    classifies OUTSIDE _NON_ADJUDICATION_CLASSES; any other status is judged by
    status alone.
    """

    def test_when_every_reject_is_non_adjudicating_then_quiet_night(self) -> None:
        # One representative class: both callers delegate to the same
        # discriminator, so the full class table is enumerated once, on the walk.
        report = _report(
            ["rejected", "rejected"],
            rationale=_non_adjudicating_rationales()["quota-limit"],
        )
        self.assertFalse(dc._all_rejected_this_cycle(report))

    def test_when_one_quality_reject_remains_then_all_rejected(self) -> None:
        patches = [
            _patch_result("rejected", rationale=dc._SUPERSEDE_REASON + " (2026-06-11)"),
            _patch_result("rejected", rationale=_QUALITY_RATIONALE),
        ]
        self.assertTrue(dc._all_rejected_this_cycle(_cycle_report(patches)))

    def test_when_a_queued_row_carries_a_blank_rationale_then_not_all_rejected(
        self,
    ) -> None:
        # The set-aside is status-gated: a 'pending' row is pipeline output and
        # must break, never vanish into the set-aside bucket on its rationale.
        patches = [
            _patch_result("rejected", rationale=_QUALITY_RATIONALE),
            _patch_result("pending", rationale=""),
        ]
        self.assertFalse(dc._all_rejected_this_cycle(_cycle_report(patches)))

    def test_when_a_reverted_row_carries_a_blank_rationale_then_all_rejected(
        self,
    ) -> None:
        # Terminal by status — the rationale never reaches the classifier, so a
        # backed-out apply cannot drop out as an empty-rationale skip.
        self.assertTrue(
            dc._all_rejected_this_cycle(_cycle_report([_patch_result("reverted", rationale="")]))
        )


# daemon_cycle imports cleanly without psycopg (HAS_PG_LOOP_WRITE=False) but then
# leaves _pg_connect unbound — patch.object on it would ERROR, so skip instead.
@unittest.skipIf(
    dc is None or not dc.HAS_PG_LOOP_WRITE,
    f"import failed: {_IMPORT_ERROR}"
    if dc is None
    else "psycopg absent: _pg_connect unbound in daemon_cycle",
)
class TestPriorAllRejectCycleCount(unittest.TestCase):
    """Wiring + fail-open contract of the persisted read.

    What only this class answers: the (cycle_date, status, rationale) rows a
    cursor returns reach _all_reject_streak_from_rows with the projection
    intact. Walk semantics themselves are pinned mock-free in
    TestAllRejectStreakWalk.
    """

    def _count(self, rows: list[tuple[str, str, str]]) -> int:
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True), mock.patch.object(
            dc, "_pg_connect", _mock_pg_connect(rows)
        ):
            return dc._prior_all_reject_cycle_count(_CYCLE_DATE)

    def test_when_two_all_reject_cycles_then_two(self) -> None:
        rows = [
            ("2026-06-09", "rejected", _QUALITY_RATIONALE),
            ("2026-06-08", "rejected", _QUALITY_RATIONALE),
            ("2026-06-07", "applied", _QUALITY_RATIONALE),
        ]
        self.assertEqual(self._count(rows), 2)

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
class TestAllRejectStreakWalk(unittest.TestCase):
    """Per-date walk semantics over (cycle_date, status, rationale) rows.

    Relationship, newest date first: a date holding any non-terminal row breaks;
    a date whose rejects ALL classify non-adjudicating drops out; a date holding
    >=1 adjudicating reject extends.
    """

    def test_when_a_date_holds_only_non_adjudicating_rejects_then_it_drops_out(
        self,
    ) -> None:
        # Covers the retroactive-supersede shape too: a date once queued and
        # later rewritten to supersede carries only the supersede rationale.
        for label, rationale in _non_adjudicating_rationales().items():
            with self.subTest(label):
                rows = [
                    ("2026-06-09", "rejected", _QUALITY_RATIONALE),
                    ("2026-06-08", "rejected", rationale),
                    ("2026-06-07", "rejected", _QUALITY_RATIONALE),
                    ("2026-06-06", "applied", _QUALITY_RATIONALE),
                ]
                # Dropping out gives 2; extending would give 3, breaking 1.
                self.assertEqual(dc._all_reject_streak_from_rows(rows), 2)

    def test_when_a_date_mixes_classes_then_its_adjudicating_row_extends(self) -> None:
        rows = [
            ("2026-06-09", "rejected", dc._SUPERSEDE_REASON + " (2026-06-10)"),
            ("2026-06-09", "rejected", _QUALITY_RATIONALE),
            ("2026-06-08", "applied", _QUALITY_RATIONALE),
        ]
        self.assertEqual(dc._all_reject_streak_from_rows(rows), 1)

    def test_when_a_date_carries_a_queued_row_then_the_walk_breaks(self) -> None:
        # Status-gated set-aside: a blank rationale on a 'pending' row must never
        # let it vanish — a queued row is pipeline output and breaks the streak.
        rows = [
            ("2026-06-09", "rejected", _QUALITY_RATIONALE),
            ("2026-06-09", "pending", ""),
            ("2026-06-08", "rejected", _QUALITY_RATIONALE),
        ]
        self.assertEqual(dc._all_reject_streak_from_rows(rows), 0)

    def test_when_a_reverted_row_carries_a_blank_rationale_then_its_date_extends(
        self,
    ) -> None:
        # Terminal by status, so no rationale can drop it — a blank one would
        # otherwise classify as skipped.
        rows = [
            ("2026-06-09", "reverted", ""),
            ("2026-06-08", "applied", _QUALITY_RATIONALE),
        ]
        self.assertEqual(dc._all_reject_streak_from_rows(rows), 1)

    def test_when_no_rows_then_zero(self) -> None:
        self.assertEqual(dc._all_reject_streak_from_rows([]), 0)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestPriorAllRejectCycleCountOnEngine(unittest.TestCase):
    """The persisted walk's own SQL, run on the stdlib backend.

    Grouping and classification live in _all_reject_streak_from_rows, so what
    only a real engine can answer is pinned here: the projected columns, the
    newest-first ordering, and the LIMIT bounding DISTINCT DATES rather than
    rows.
    """

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db = Path(tmp.name) / "proposals.sqlite"
        stub.create_proposals_table(self.db)

    def _count(self, rows: list[tuple[str, str, str | None]]) -> int:
        with closing(sqlite3.connect(self.db)) as db:
            db.executemany(
                "INSERT INTO autoagent_proposals "
                "(cycle_date, pattern_label, target_file, status, rationale) "
                "VALUES (?, ?, '/tmp/probe-agent.md', ?, ?)",
                [(day, f"label {i}", s, r) for i, (day, s, r) in enumerate(rows)],
            )
            db.commit()
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True), mock.patch.object(
            dc, "_pg_connect", lambda: stub.create_connection(self.db), create=True
        ):
            return dc._prior_all_reject_cycle_count(_CYCLE_DATE)

    def test_when_a_prior_date_holds_only_a_backoff_marker_then_it_drops_out(
        self,
    ) -> None:
        # Extending would give 3, breaking 1.
        rows = [
            ("2026-06-09", "rejected", _QUALITY_RATIONALE),
            ("2026-06-08", "rejected", _backoff_rationale()),
            ("2026-06-07", "rejected", _QUALITY_RATIONALE),
            ("2026-06-06", "applied", _QUALITY_RATIONALE),
        ]
        self.assertEqual(self._count(rows), 2)

    def test_when_a_rejected_row_carries_a_null_rationale_then_it_drops_out(
        self,
    ) -> None:
        # The column is nullable; NULL reaches the classifier as empty → skipped.
        rows = [
            ("2026-06-09", "rejected", None),
            ("2026-06-08", "applied", _QUALITY_RATIONALE),
        ]
        self.assertEqual(self._count(rows), 0)

    def test_when_the_window_holds_more_rows_than_the_bound_then_dates_survive(
        self,
    ) -> None:
        # 5 dates x 100 rows: a row-count LIMIT 400 would see only the newest 4
        # dates and under-report the streak — the horizon bounds DATES.
        rows = [
            (f"2026-06-{day:02d}", "rejected", _QUALITY_RATIONALE)
            for day in range(5, 10)
            for _ in range(100)
        ]
        self.assertEqual(self._count(rows), 5)


if __name__ == "__main__":
    unittest.main()
