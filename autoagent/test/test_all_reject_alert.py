"""Behavioral tests for the cycle-level all-reject alert (AP-1).

``run_cycle`` now ends with ``alert_all_reject_streak``: when the current
in-memory cycle produced >=1 proposal and ALL of them are 'rejected', and the
prior persisted cycles extend the streak to ALL_REJECT_ALERT_THRESHOLD, a
loud WARN is emitted (stderr + ``eval_result='all-reject-alert'`` loop event).
Each cycle stores its verdict in ``core.autoagent_cycle_verdicts``; the prior
streak walks those rows. Mock rows run sealed; ``TestCycleVerdictsLivePg`` writes
only to its own database on ``live-pg-ephemeral.bats``'s cluster.

Run with either runner:
    uv run --with pytest --with psycopg pytest autoagent/test/test_all_reject_alert.py -v
    python3 -m unittest autoagent.test.test_all_reject_alert -v

CID: 2026-06-10T0810_atrium-normalize_b3f1
"""

from __future__ import annotations

import contextlib
import dataclasses
import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import uuid
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
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
from _pg_seal import get_ephemeral_connection, seal_pg_reach  # noqa: E402 — test dir anchored above

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
        classification="reject" if status in ("rejected", "unadjudicated") else "body-auto",
        rationale=rationale,
        proposed_diff="",
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
    # Markers take the status the back-off arm stores: _is_non_adjudication_reject
    # sets an 'unadjudicated' row aside by status alone, whatever its rationale.
    patches += [
        _patch_result(
            "unadjudicated", dc.TIMEOUT_BACKOFF_HAIKU_STATUS, _backoff_rationale()
        )
        for _ in range(markers)
    ]
    return _cycle_report(patches)


def _dated_report(cycle_date: str, statuses: list[str]) -> "dc.CycleReport":
    return dataclasses.replace(_report(statuses), cycle_date=cycle_date)


def _mock_pg_connect(
    fetchall_result: list[tuple[str, ...]], *, has_verdicts_table: bool = False
) -> mock.MagicMock:
    cursor = mock.MagicMock()
    cursor.fetchall.return_value = fetchall_result
    # to_regclass answers NULL for an absent relation
    cursor.fetchone.return_value = (
        ("core.autoagent_cycle_verdicts" if has_verdicts_table else None),
    )
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

    def test_when_an_unadjudicated_row_sits_beside_a_quality_reject_then_set_aside(
        self,
    ) -> None:
        # Set aside by status: a quality rationale on it must neither count it
        # as a rejection nor let it break the all-rejected claim as output.
        for rationale in (_QUALITY_RATIONALE, ""):
            with self.subTest(rationale=rationale):
                unadjudicated = _patch_result("unadjudicated", rationale=rationale)
                quality_reject = _patch_result("rejected", rationale=_QUALITY_RATIONALE)
                self.assertTrue(
                    dc._all_rejected_this_cycle(_cycle_report([unadjudicated, quality_reject]))
                )
                self.assertFalse(dc._all_rejected_this_cycle(_cycle_report([unadjudicated])))


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

    What only this class answers: which stored rows reach the walk — verdict
    rows where the table exists, else the (cycle_date, status, rationale)
    proposal rows. Walk semantics are pinned mock-free in
    TestAllRejectStreakWalk; the verdict SQL in TestCycleVerdictsLivePg.
    """

    def setUp(self) -> None:
        self.pg_reach = seal_pg_reach(self)
        self.addCleanup(lambda: self.assertEqual(self.pg_reach, []))

    def _count(
        self, rows: list[tuple[str, ...]], *, has_verdicts_table: bool = False
    ) -> int:
        connect = _mock_pg_connect(rows, has_verdicts_table=has_verdicts_table)
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True), mock.patch.object(
            dc, "_pg_connect", connect
        ):
            return dc._prior_all_reject_cycle_count(_CYCLE_DATE)

    def test_when_the_verdict_table_exists_then_stored_verdicts_decide_the_streak(
        self,
    ) -> None:
        rows = [("extends",), ("neutral",), ("extends",), ("breaks",), ("extends",)]
        # neutral drops out like an absent date; breaks stops the walk
        self.assertEqual(self._count(rows, has_verdicts_table=True), 2)

    def test_when_the_verdict_table_is_absent_then_proposals_answer_and_the_migration_is_named(
        self,
    ) -> None:
        rows = [
            ("2026-06-09", "rejected", _QUALITY_RATIONALE),
            ("2026-06-08", "rejected", _QUALITY_RATIONALE),
            ("2026-06-07", "applied", _QUALITY_RATIONALE),
        ]
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(self._count(rows), 2)
        self.assertIn(dc._CYCLE_VERDICTS_MIGRATION, stderr.getvalue())

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
class TestCycleVerdictOfReport(unittest.TestCase):
    """The stored verdict is the walk's own per-date state for the in-memory report."""

    def test_verdict_matches_the_state_the_walk_gives_the_same_rows(self) -> None:
        rows = [
            ("no proposals", _report([]), "neutral"),
            ("back-off markers only", _report([], markers=2), "neutral"),
            ("an adjudicating reject", _report(["rejected"], markers=1), "extends"),
            ("a queued row beside a reject", _report(["rejected", "pending"]), "breaks"),
            ("an applied row", _report(["applied"]), "breaks"),
        ]
        for name, report, verdict in rows:
            with self.subTest(name):
                self.assertEqual(dc._get_report_verdict(report), verdict)
                self.assertEqual(
                    dc._all_rejected_this_cycle(report), verdict == "extends"
                )


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

    def test_when_a_date_holds_only_unadjudicated_rows_then_it_drops_out(self) -> None:
        # Status alone decides: even a quality rationale cannot make it extend.
        for rationale in (_QUALITY_RATIONALE, "", _backoff_rationale()):
            with self.subTest(rationale=rationale):
                rows = [
                    ("2026-06-09", "rejected", _QUALITY_RATIONALE),
                    ("2026-06-08", "unadjudicated", rationale),
                    ("2026-06-07", "rejected", _QUALITY_RATIONALE),
                    ("2026-06-06", "applied", _QUALITY_RATIONALE),
                ]
                # Dropping out gives 2; extending would give 3, breaking 1.
                self.assertEqual(dc._all_reject_streak_from_rows(rows), 2)

    def test_when_no_rows_then_zero(self) -> None:
        self.assertEqual(dc._all_reject_streak_from_rows([]), 0)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestPriorAllRejectCycleCountOnEngine(unittest.TestCase):
    """The fallback proposals walk's own SQL, run on the stdlib backend.

    The schema-without-verdict-table leg: the stub has no to_regclass, so the
    table probe answers absent. Grouping and classification live in
    _all_reject_streak_from_rows, so what only an engine can answer is pinned
    here: the projected columns, the newest-first ordering, and the LIMIT
    bounding DISTINCT DATES rather than rows.
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
        ), mock.patch.object(
            dc, "_has_cycle_verdicts_table", return_value=False
        ), contextlib.redirect_stderr(io.StringIO()):
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


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestCycleVerdictWiring(unittest.TestCase):
    """run_cycle stores one verdict per cycle, and none in no-write mode."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "agents").mkdir()
        env = mock.patch.dict(os.environ, {"GA_DATA_ROOT": str(self.root)})
        env.start()
        self.addCleanup(env.stop)
        self.pg_reach = seal_pg_reach(self)
        self.stored: list[object] = []
        patcher = mock.patch.object(
            dc, "create_cycle_verdicts", side_effect=lambda report: self.stored.append(report)
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run(self, *, skip_loop_emit: bool) -> "dc.CycleReport":
        with contextlib.redirect_stderr(io.StringIO()):
            report = dc.run_cycle(
                log_path=self.root / "learning-log.md",
                agents_dir=self.root / "agents",
                skip_haiku=True,
                skip_pre_verify=True,
                skip_loop_emit=skip_loop_emit,
            )
        self.assertEqual(self.pg_reach, [])
        return report

    def test_a_writing_cycle_stores_its_own_report_once(self) -> None:
        report = self._run(skip_loop_emit=False)
        self.assertEqual(self.stored, [report])

    def test_a_no_write_cycle_stores_nothing(self) -> None:
        self._run(skip_loop_emit=True)
        self.assertEqual(self.stored, [])


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestCycleVerdictsLivePg(unittest.TestCase):
    """Verdict writer, backfill and walk on real PostgreSQL.

    Each test owns a database cloned from a template ``live-pg-ephemeral.bats``
    builds — the verdict table is append-only, so rows cannot be cleaned up.
    """

    _TEMPLATE = SimpleNamespace(FULL="cycle_verdicts_tpl", ABSENT="cycle_verdicts_absent_tpl")

    def setUp(self) -> None:
        get_ephemeral_connection().close()
        import psycopg

        self.psycopg = psycopg
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.reports_dir = Path(scratch.name) / "daemon-reports"
        self.reports_dir.mkdir()
        self.pg_reach = seal_pg_reach(self)
        self.addCleanup(lambda: self.assertEqual(self.pg_reach, []))

    def _use_database(self, template: str) -> None:
        self.dbname = f"cv_{os.getpid()}_{uuid.uuid4().hex[:8]}"
        self._run_admin(f'CREATE DATABASE "{self.dbname}" TEMPLATE "{template}"')
        self.addCleanup(self._run_admin, f'DROP DATABASE "{self.dbname}" WITH (FORCE)')
        for name, value in (("HAS_PG_LOOP_WRITE", True), ("_pg_connect", self._connect)):
            patcher = mock.patch.object(dc, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _run_admin(self, statement: str) -> None:
        with self.psycopg.connect(
            dbname="eph_bootstrap", connect_timeout=2, autocommit=True
        ) as admin:
            admin.execute(statement)

    def _connect(self):  # noqa: ANN202 — psycopg is imported lazily
        return self.psycopg.connect(dbname=self.dbname, connect_timeout=2)

    def _execute(self, statement: str, params: tuple[object, ...] = ()) -> list[tuple]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(statement, params)
            return cur.fetchall() if cur.description else []

    def _get_verdicts(self) -> list[tuple[str, str]]:
        return self._execute(
            "SELECT cycle_date::text, verdict::text "
            "FROM core.autoagent_cycle_verdicts ORDER BY cycle_date"
        )

    def _create_verdicts(self, report: "dc.CycleReport") -> tuple[int, str]:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            inserted = dc.create_cycle_verdicts(report, reports_dir=self.reports_dir)
        return inserted, stderr.getvalue()

    def _write_report(self, report: "dc.CycleReport") -> None:
        dc.emit_report(report, self.reports_dir / f"autoagent-{report.cycle_date}.json")

    def _insert_proposal(self, cycle_date: str, status: str) -> None:
        self._execute(
            "INSERT INTO core.autoagent_proposals (cycle_date, pattern_label, target_file, "
            "classification, rationale, approval_tier, status, source_file, source_file_mtime) "
            "VALUES (%s, 'probe pattern', 'agents/probe-agent.md', 'reject', %s, 'auto', "
            "%s, 'autoagent.json', 0) RETURNING id",
            (cycle_date, _QUALITY_RATIONALE, status),
        )

    def test_a_later_status_change_on_a_past_proposal_leaves_verdict_and_streak(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.FULL)
        for day in ("2026-06-07", "2026-06-08", "2026-06-09"):
            self._create_verdicts(_dated_report(day, ["rejected"]))
            self._insert_proposal(day, "rejected")
        verdicts = self._get_verdicts()
        self.assertEqual(dc._prior_all_reject_cycle_count(_CYCLE_DATE), 3)

        # the unadjudicated backfill's relabel of a past row
        self._execute(
            "UPDATE core.autoagent_proposals SET status = 'unadjudicated' "
            "WHERE cycle_date = '2026-06-08' RETURNING id"
        )

        self.assertEqual(self._get_verdicts(), verdicts)
        self.assertEqual(dc._prior_all_reject_cycle_count(_CYCLE_DATE), 3)

    def test_a_verdict_already_stored_for_the_current_date_is_not_a_prior_cycle(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.FULL)
        # run_cycle stores today's row before the walk → counting it fires the alert a cycle early
        for day in ("2026-06-08", "2026-06-09", _CYCLE_DATE):
            self._create_verdicts(_dated_report(day, ["rejected"]))
        self.assertEqual(
            self._get_verdicts(),
            [("2026-06-08", "extends"), ("2026-06-09", "extends"), (_CYCLE_DATE, "extends")],
        )

        self.assertEqual(dc._prior_all_reject_cycle_count(_CYCLE_DATE), 2)

    def test_backfill_inserts_missing_dates_only_and_a_second_run_inserts_nothing(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.FULL)
        self._create_verdicts(_dated_report("2026-06-08", ["pending"]))
        self._write_report(_dated_report("2026-06-07", ["rejected"]))
        self._write_report(_dated_report("2026-06-08", ["rejected"]))
        self._write_report(_dated_report("2026-06-09", []))
        # a report from before patches carried a status is no verdict source
        (self.reports_dir / "autoagent-2026-06-06.json").write_text(
            json.dumps({"cycle_date": "2026-06-06", "patches": [{"rationale": "x"}]}),
            encoding="utf-8",
        )
        (self.reports_dir / "autoagent-2026-06-05.json").write_text("{", encoding="utf-8")
        current = _dated_report(_CYCLE_DATE, ["rejected"])

        first, _ = self._create_verdicts(current)
        stored = self._get_verdicts()
        second, _ = self._create_verdicts(current)

        self.assertEqual(
            stored,
            [
                ("2026-06-07", "extends"),
                ("2026-06-08", "breaks"),
                ("2026-06-09", "neutral"),
                (_CYCLE_DATE, "extends"),
            ],
        )
        self.assertEqual(first, 3)
        self.assertEqual((second, self._get_verdicts()), (0, stored))

    def test_a_same_day_re_run_keeps_the_first_verdict(self) -> None:
        self._use_database(self._TEMPLATE.FULL)
        self._create_verdicts(_dated_report(_CYCLE_DATE, ["rejected"]))

        inserted, _ = self._create_verdicts(_dated_report(_CYCLE_DATE, ["pending"]))

        self.assertEqual((inserted, self._get_verdicts()), (0, [(_CYCLE_DATE, "extends")]))

    def test_a_date_with_neither_a_row_nor_a_report_is_skipped_like_an_absent_date(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.FULL)
        for day, statuses in (
            ("2026-06-06", ["pending"]),
            ("2026-06-07", ["rejected"]),
            ("2026-06-09", ["rejected"]),
        ):
            self._create_verdicts(_dated_report(day, statuses))

        # 2026-06-08 has no row: skipping gives 2; breaking would give 1
        self.assertEqual(dc._prior_all_reject_cycle_count(_CYCLE_DATE), 2)

    def test_without_the_verdict_table_the_walk_falls_back_and_the_write_skips_named(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.ABSENT)
        self._insert_proposal("2026-06-09", "rejected")
        self._insert_proposal("2026-06-08", "rejected")
        self._write_report(_dated_report("2026-06-07", ["rejected"]))

        inserted, err = self._create_verdicts(_dated_report(_CYCLE_DATE, ["rejected"]))

        self.assertEqual(inserted, 0)
        self.assertIn(dc._CYCLE_VERDICTS_MIGRATION, err)
        self.assertEqual(dc._prior_all_reject_cycle_count(_CYCLE_DATE), 2)


if __name__ == "__main__":
    unittest.main()
