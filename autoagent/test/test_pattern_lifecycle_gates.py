"""Behavioral tests for the generation-side anti-fossil gates (AP-4).

The per-agent generation loop (``daemon_cycle._run_generation_loop``, not run while
generation is closed) filters intake patterns through a set of lifecycle
gates before any Haiku spend. Covered here:
(1) reject-streak snooze — N consecutive genuinely-rejected proposals for the
    same pattern+agent transition the ``core.learning_log`` row to terminal
    'rejected' via ``_pg_learning_dualwrite.reject_learning_pattern`` (the
    intake predicate stops selecting it), loudly (stderr WARN +
    ``eval_result='reject-streak-snooze'`` loop event);
(1b) repeat-apply cap — N APPLIED proposals covering one pattern terminalize it
    the same way (``eval_result='repeat-apply-cap'``). Non-redundant with (1):
    an 'applied' row RESETS the reject streak, so the apply/reject alternation
    is invisible to that gate. 'rejected' here means STOP PROPOSING only — the
    underlying signal stays UNRESOLVED, pinned by TestApplyCapNamingBoundary;
(2) intake pair re-check — a keyed row whose S2f pair (detection + confirmation
    windows on the UTC day) does not pass, or cannot be read, is skipped this
    cycle with a named reason (``eval_result='stale-pattern-skip'``); no status
    write — the aggregator owns the move to 'dormant'.
Terminal protection: a 'rejected' learning_log row can never resurrect to
'identified' (state-machine pin), so a snoozed row generates no proposal on
any later cycle.

Live-PG classes run only on the ephemeral cluster ``live-pg-ephemeral.bats``
builds (elsewhere they skip, never touching an install's live database) and
insert fixtures in an open, never-committed transaction rolled back on teardown. Loop-event emission is captured by a recorder in place of
``_invoke_pg_helper``, so no test writes ``core.autoagent_loop_events``.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_pattern_lifecycle_gates.py -v
    python3 -m unittest autoagent.test.test_pattern_lifecycle_gates -v

CID: 2026-06-10T0810_atrium-normalize_b3f1
"""

from __future__ import annotations

import contextlib
import io
import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

# The helper MUST enter sys.modules before daemon_cycle imports it, so both the
# test and the daemon bind to ONE module object and a single psycopg patch
# covers the reject transition (write) and the intake (read).
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))
# unittest discover and ``-m unittest`` from another cwd leave this directory off sys.path.
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from _pg_seal import get_ephemeral_connection, seal_pg_reach

try:
    import _pg_learning_dualwrite as pgdw
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    pgdw = None  # type: ignore[assignment]  # sentinel consumed by skipIf only
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

# The live '62%' fossil shape: PG signature label is numeric-stripped, the
# pre-AP-2 proposal rows still carry the numeric label.
_LEGACY_LABEL = "에이전트 지침 개선 후보 (실패율 )"
_LEGACY_PROPOSAL_LABEL = "에이전트 지침 개선 후보 (실패율 62%)"
_PROBE_AGENT = "ap4-snooze-probe-agent"


def _pattern(
    label: str = _LEGACY_LABEL,
    agent: str = "wiki-curator",
    row_id: int = 15,
    discovered_date: str = "2026-06-01",
) -> "dc.Pattern":
    return dc.Pattern(
        date=discovered_date,
        label=label,
        frequency="64",
        agent=agent,
        status="identified",
        tier="user-pending",
        raw_line=f"pg:learning_log:{row_id}:{label}|{agent}",
        row_id=row_id,
    )


def _reject(
    label: str = _LEGACY_PROPOSAL_LABEL,
    rationale: str = "quality reject — pre-verify failed",
) -> tuple[str, str, str]:
    return ("rejected", label, rationale)


def _applied(label: str = _LEGACY_PROPOSAL_LABEL) -> tuple[str, str, str]:
    return ("applied", label, "landed")


_NOW = datetime(2026, 10, 5, 23, 55, tzinfo=timezone.utc)
_DETECTION = "2026-09-21"
_KEYED_AGENT = "glass-atrium-dev-python"
_BUDGET_KEY = "budget_overage"
_EMIT_KEY = "emit_failure"
_KEYED_LABELS = {_BUDGET_KEY: "budget-overage concentration", _EMIT_KEY: "emit-failure concentration"}


def _keyed_pattern(metric_key: str, row_id: int = 21) -> "dc.Pattern":
    label = _KEYED_LABELS[metric_key]
    return dc.Pattern(
        date=_DETECTION,
        label=label,
        frequency="4",
        agent=_KEYED_AGENT,
        status="identified",
        tier="user-pending",
        raw_line=f"pg:learning_log:{row_id}:{label}|{_KEYED_AGENT}",
        row_id=row_id,
        metric_key=metric_key,
    )


def _floor_key(metric_key: str) -> tuple[str, str]:
    return (_KEYED_AGENT, metric_key)


def _floor(verdict: str) -> SimpleNamespace:
    count = SimpleNamespace(spawns=10, events=5, sessions=5)
    return SimpleNamespace(
        verdict=verdict, detection=count, confirmation=count,
        baseline=SimpleNamespace(spawns=10, events=1, sessions=1),
    )


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestConsecutiveRejectCount(unittest.TestCase):
    """Streak walk: genuine rejects count; mechanical rows are looked past."""

    def test_when_three_genuine_rejects_then_streak_is_three(self) -> None:
        rows = [_reject(), _reject(), _reject()]
        self.assertEqual(dc.consecutive_reject_count(_LEGACY_LABEL, rows), 3)

    def test_when_supersede_and_timeout_rows_then_looked_past(self) -> None:
        rows = [
            _reject(rationale=dc._SUPERSEDE_REASON_CROSS_DAY),
            _reject(),
            _reject(rationale="haiku timeout after 90s"),
            _reject(),
        ]
        self.assertEqual(dc.consecutive_reject_count(_LEGACY_LABEL, rows), 2)

    def test_when_snoozed_and_pending_rows_then_looked_past(self) -> None:
        rows = [
            ("pending", _LEGACY_PROPOSAL_LABEL, ""),
            _reject(),
            ("snoozed", _LEGACY_PROPOSAL_LABEL, "chronic haiku-timeout back-off"),
            _reject(),
            _reject(),
        ]
        self.assertEqual(dc.consecutive_reject_count(_LEGACY_LABEL, rows), 3)

    def test_when_rejected_backoff_marker_rows_then_looked_past(self) -> None:
        marker = dc.TIMEOUT_BACKOFF_RATIONALE_TEMPLATE.format(n=3, thr=3)
        rows = [
            _reject(rationale=marker),
            _reject(),
            _reject(rationale=marker),
            _reject(),
        ]
        self.assertEqual(dc.consecutive_reject_count(_LEGACY_LABEL, rows), 2)
        self.assertEqual(
            dc.classify_failure_rationale(marker), dc.FAILURE_CLASS_TIMEOUT
        )

    def test_when_applied_row_then_streak_breaks(self) -> None:
        rows = [
            _reject(),
            ("applied", _LEGACY_PROPOSAL_LABEL, "landed"),
            _reject(),
            _reject(),
        ]
        self.assertEqual(dc.consecutive_reject_count(_LEGACY_LABEL, rows), 1)

    def test_when_unadjudicated_rows_then_looked_past_whatever_the_rationale(
        self,
    ) -> None:
        rows = [
            ("unadjudicated", _LEGACY_PROPOSAL_LABEL, "quality reject — pre-verify failed"),
            _reject(),
            ("unadjudicated", _LEGACY_PROPOSAL_LABEL, ""),
            _reject(),
        ]
        # Looked past gives 2; counting would give 4, breaking 0.
        self.assertEqual(dc.consecutive_reject_count(_LEGACY_LABEL, rows), 2)

    def test_when_label_not_covering_then_row_ignored(self) -> None:
        rows = [
            _reject(label="some unrelated pattern label"),
            _reject(),
            _reject(),
        ]
        self.assertEqual(dc.consecutive_reject_count(_LEGACY_LABEL, rows), 2)

    def test_when_consolidated_label_then_pattern_is_covered(self) -> None:
        consolidated = (
            f"wiki-curator multi-signal consolidation ({_LEGACY_PROPOSAL_LABEL} / "
            "동일 에이전트 반복 실패)"
        )
        rows = [_reject(label=consolidated)] * 3
        self.assertEqual(dc.consecutive_reject_count(_LEGACY_LABEL, rows), 3)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class _GateFixture(unittest.TestCase):
    """Shared recorders: loop events + learning_log transitions, no PG writes."""

    def setUp(self) -> None:
        self.emitted: list[dict] = []
        self.transitions: list[tuple[int, str]] = []

        def _record_event(envelope: dict) -> bool:
            self.emitted.append(envelope)
            return True

        def _record_transition(pattern_id: int, reason: str) -> int:
            self.transitions.append((pattern_id, reason))
            return pattern_id

        for target, repl in (
            ("_invoke_pg_helper", _record_event),
            ("_pg_reject_learning_pattern", _record_transition),
        ):
            patcher = mock.patch.object(dc, target, repl)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _event_results(self) -> list[str]:
        return [
            env["args"]["eval_result"]
            for env in self.emitted
            if env.get("op") == "write_autoagent_loop_event"
        ]


class TestDropRejectStreakPatterns(_GateFixture):
    """3-reject streak → learning_log transition + loud drop (AP-4 test a)."""

    def _drop(self, history, patterns):
        with mock.patch.object(dc, "_fetch_proposal_history", lambda agent: history):
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                kept = dc.drop_reject_streak_patterns("wiki-curator", patterns)
        return kept, stderr.getvalue()

    def test_when_streak_reaches_threshold_then_row_transitions_and_drops(
        self,
    ) -> None:
        kept, stderr_text = self._drop([_reject()] * 3, [_pattern(row_id=15)])

        self.assertEqual(kept, [])
        self.assertEqual(len(self.transitions), 1)
        row_id, reason = self.transitions[0]
        self.assertEqual(row_id, 15)
        self.assertIn("reject-streak snooze: 3 consecutive", reason)
        self.assertIn("reject-streak-snooze", self._event_results())
        self.assertIn("WARN: pattern reject-streak-snooze", stderr_text)

    def test_when_streak_below_threshold_then_pattern_survives(self) -> None:
        pattern = _pattern(row_id=15)
        kept, _ = self._drop([_reject()] * 2, [pattern])

        self.assertEqual(kept, [pattern])
        self.assertEqual(self.transitions, [])
        self.assertEqual(self.emitted, [])

    def test_when_history_unavailable_then_fail_open(self) -> None:
        pattern = _pattern(row_id=15)
        kept, _ = self._drop(None, [pattern])

        self.assertEqual(kept, [pattern])
        self.assertEqual(self.transitions, [])

    def test_when_row_id_synthetic_then_no_transition(self) -> None:
        pattern = _pattern(row_id=0)
        kept, _ = self._drop([_reject()] * 3, [pattern])

        self.assertEqual(kept, [pattern])
        self.assertEqual(self.transitions, [])


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestCoveringApplyCount(unittest.TestCase):
    """Apply walk: covering 'applied' rows are counted in TOTAL, not in a run."""

    def test_when_three_applied_rows_then_count_is_three(self) -> None:
        rows = [_applied(), _applied(), _applied()]
        self.assertEqual(dc.covering_apply_count(_LEGACY_LABEL, rows), 3)

    def test_when_rejects_interleaved_then_applies_still_counted(self) -> None:
        # The alternation the reject-streak gate cannot see: every 'applied' row
        # resets that streak, yet each one stacked a rule on the live body.
        rows = [_applied(), _reject(), _applied(), _reject(), _applied()]
        self.assertEqual(dc.covering_apply_count(_LEGACY_LABEL, rows), 3)
        self.assertLess(
            dc.consecutive_reject_count(_LEGACY_LABEL, rows),
            dc.REJECT_STREAK_THRESHOLD,
        )

    def test_when_label_not_covering_then_row_ignored(self) -> None:
        rows = [_applied(label="some unrelated pattern label"), _applied()]
        self.assertEqual(dc.covering_apply_count(_LEGACY_LABEL, rows), 1)

    def test_when_non_applied_statuses_then_not_counted(self) -> None:
        rows = [
            _reject(),
            ("pending", _LEGACY_PROPOSAL_LABEL, ""),
            ("snoozed", _LEGACY_PROPOSAL_LABEL, ""),
            ("reverted", _LEGACY_PROPOSAL_LABEL, ""),
        ]
        self.assertEqual(dc.covering_apply_count(_LEGACY_LABEL, rows), 0)


class TestDropApplyCappedPatterns(_GateFixture):
    """N applied patches that did not abate the signal → terminalize + drop."""

    def _drop(self, history, patterns):
        with mock.patch.object(dc, "_fetch_proposal_history", lambda agent: history):
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                kept = dc.drop_apply_capped_patterns("wiki-curator", patterns)
        return kept, stderr.getvalue()

    def test_when_applies_reach_cap_then_row_transitions_and_drops(self) -> None:
        kept, stderr_text = self._drop(
            [_applied()] * dc.APPLY_CAP_THRESHOLD, [_pattern(row_id=15)]
        )

        self.assertEqual(kept, [])
        self.assertEqual(len(self.transitions), 1)
        row_id, reason = self.transitions[0]
        self.assertEqual(row_id, 15)
        self.assertIn("repeat-apply cap:", reason)
        self.assertIn("repeat-apply-cap", self._event_results())
        self.assertIn("WARN: pattern repeat-apply-cap", stderr_text)

    def test_when_applies_below_cap_then_pattern_survives(self) -> None:
        pattern = _pattern(row_id=15)
        kept, _ = self._drop([_applied()] * (dc.APPLY_CAP_THRESHOLD - 1), [pattern])

        self.assertEqual(kept, [pattern])
        self.assertEqual(self.transitions, [])
        self.assertEqual(self.emitted, [])

    def test_when_history_unavailable_then_fail_open(self) -> None:
        pattern = _pattern(row_id=15)
        kept, _ = self._drop(None, [pattern])

        self.assertEqual(kept, [pattern])
        self.assertEqual(self.transitions, [])

    def test_when_row_id_synthetic_then_no_transition(self) -> None:
        pattern = _pattern(row_id=0)
        kept, _ = self._drop([_applied()] * dc.APPLY_CAP_THRESHOLD, [pattern])

        self.assertEqual(kept, [pattern])
        self.assertEqual(self.transitions, [])

    def test_when_alternating_history_then_cap_fires_where_streak_cannot(
        self,
    ) -> None:
        # The live fossil shape: an apply between rejects keeps the reject streak
        # permanently below threshold while the rules keep stacking.
        history = []
        for _ in range(dc.APPLY_CAP_THRESHOLD):
            history.extend([_applied(), _reject()])
        pattern = _pattern(row_id=15)

        with mock.patch.object(dc, "_fetch_proposal_history", lambda agent: history):
            with contextlib.redirect_stderr(io.StringIO()):
                streak_kept = dc.drop_reject_streak_patterns("wiki-curator", [pattern])
                cap_kept = dc.drop_apply_capped_patterns("wiki-curator", [pattern])

        self.assertEqual(streak_kept, [pattern])
        self.assertEqual(cap_kept, [])


class TestApplyCapNamingBoundary(_GateFixture):
    """The cap says STOP PROPOSING — never that the problem was resolved.

    Pins the one rename that would turn this gate into the forbidden shortcut:
    routing an apply-triggered transition through the applied-discharge path (or
    wording it as a resolution) would claim the signal is discharged while the
    live counters keep recording it.
    """

    def setUp(self) -> None:
        super().setUp()
        self.discharges: list[tuple[int, str]] = []
        patcher = mock.patch.object(
            dc,
            "_pg_discharge_learning_pattern",
            lambda pattern_id, reason: self.discharges.append((pattern_id, reason)),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _fire(self):
        history = [_applied()] * dc.APPLY_CAP_THRESHOLD
        with mock.patch.object(dc, "_fetch_proposal_history", lambda agent: history):
            with contextlib.redirect_stderr(io.StringIO()):
                dc.drop_apply_capped_patterns("wiki-curator", [_pattern(row_id=15)])
        return self.transitions[0][1]

    def test_when_cap_fires_then_discharge_path_never_invoked(self) -> None:
        self._fire()

        self.assertEqual(self.discharges, [])
        self.assertEqual(len(self.transitions), 1)

    def test_when_cap_fires_then_reason_states_unresolved(self) -> None:
        reason = self._fire()

        self.assertIn("UNRESOLVED", reason)
        self.assertIn("STOP PROPOSING", reason)
        for resolved_word in ("resolved:", "fixed", "closed", "discharged"):
            self.assertNotIn(resolved_word, reason.lower())

    def test_when_cap_fires_then_eval_result_is_its_own_token(self) -> None:
        self._fire()

        # A distinct token keeps the capped-but-live set separately queryable in
        # the loop-event eval_result distribution — folding it into the
        # reject-streak token would erase that.
        self.assertEqual(self._event_results(), ["repeat-apply-cap"])


class TestDropPairFailingPatterns(_GateFixture):
    """Intake re-check: a keyed row passes only while its S2f pair passes; no status write."""

    def _drop(self, floors, patterns):
        reach = seal_pg_reach(self)
        self.floor_reads: list[tuple] = []

        def _read_floors(agents, windows, evaluated_at):
            self.floor_reads.append((list(agents), windows, evaluated_at))
            return floors

        for name, value in (
            ("HAS_PG_PATTERN_READ", True),
            ("_pg_read_pattern_floors", _read_floors),
            ("_get_utc_now", lambda: _NOW),
        ):
            patcher = mock.patch.object(dc, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            kept = dc.drop_pair_failing_patterns(_KEYED_AGENT, patterns)
        self.assertEqual(reach, [])
        return kept, stderr.getvalue()

    def test_a_row_failing_its_pair_is_skipped_with_a_named_reason_and_no_status_write(
        self,
    ) -> None:
        rows = [
            ("pair fails", {_floor_key(_BUDGET_KEY): _floor("fail")}, "fail"),
            ("baseline too short", {_floor_key(_BUDGET_KEY): _floor("insufficient-baseline")},
             "insufficient-baseline"),
            ("floor unreadable", None, "floor unreadable"),
            ("no floor for the key", {}, "floor unreadable"),
        ]
        for name, floors, reason in rows:
            with self.subTest(name):
                self.emitted.clear()
                kept, stderr_text = self._drop(floors, [_keyed_pattern(_BUDGET_KEY)])
                self.assertEqual(kept, [])
                self.assertEqual(self._event_results(), [dc.PAIR_FAIL_EVAL])
                self.assertIn(f"budget_overage pair from {_DETECTION}: {reason}", stderr_text)
                self.assertEqual(self.transitions, [])

    def test_a_row_passing_its_pair_goes_on_to_the_next_gate(self) -> None:
        pattern = _keyed_pattern(_BUDGET_KEY)
        kept, _ = self._drop({_floor_key(_BUDGET_KEY): _floor("pass")}, [pattern])
        self.assertEqual(kept, [pattern])
        self.assertEqual(self.emitted, [])

    def test_each_row_is_judged_by_its_own_key_from_one_floor_read(self) -> None:
        budget, emit = _keyed_pattern(_BUDGET_KEY, 21), _keyed_pattern(_EMIT_KEY, 22)
        floors = {_floor_key(_BUDGET_KEY): _floor("pass"), _floor_key(_EMIT_KEY): _floor("fail")}
        kept, stderr_text = self._drop(floors, [budget, emit])
        self.assertEqual(kept, [budget])
        self.assertIn(f"emit_failure pair from {_DETECTION}: fail", stderr_text)
        self.assertEqual(len(self.floor_reads), 1)

    def test_the_pair_read_is_the_utc_day_pair_evaluated_at_its_day_anchor(self) -> None:
        self._drop({}, [_keyed_pattern(_BUDGET_KEY)])
        agents, windows, evaluated_at = self.floor_reads[0]
        day = datetime(2026, 10, 5, tzinfo=timezone.utc)
        self.assertEqual(
            (agents, windows.start.detection, windows.end, evaluated_at),
            ([_KEYED_AGENT], datetime(2026, 9, 21, tzinfo=timezone.utc), day, day),
        )

    def test_reads_unavailable_skip_every_row_without_a_floor_read(self) -> None:
        reach = seal_pg_reach(self)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            kept = dc.drop_pair_failing_patterns(_KEYED_AGENT, [_keyed_pattern(_BUDGET_KEY)])
        self.assertEqual((kept, reach), ([], []))
        self.assertIn("floor unreadable", stderr.getvalue())


@unittest.skipIf(pgdw is None, f"import failed: {_IMPORT_ERROR}")
class TestTerminalStatusProtection(unittest.TestCase):
    """Resurrection pin: a snoozed (rejected) row can never re-enter 'identified'.

    The aggregator's terminal skip-set short-circuits before the upsert; this
    validator is the chokepoint guarantee beneath it.
    """

    def test_when_rejected_to_identified_then_validator_raises(self) -> None:
        with self.assertRaises(ValueError):
            pgdw._validate_status_transition("rejected", "identified")


class _NonCommittingConn:
    """Hand the helper an already-open transaction; swallow its context exit AND
    its commit so nothing persists — the owning test rolls back instead.
    """

    def __init__(self, conn: object) -> None:
        self._conn = conn

    def __enter__(self) -> "_NonCommittingConn":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def cursor(self):  # noqa: ANN201 — real psycopg cursor, type lives upstream
        return self._conn.cursor()

    def commit(self) -> None:
        # reject_learning_pattern commits inside its _do(); the fixture
        # transaction must stay open until the class-level rollback.
        return None


class TestRejectLearningPatternLivePg(unittest.TestCase):
    """Live-PG contract: transition is terminal, audited, and intake-invisible."""

    conn = None

    @classmethod
    def setUpClass(cls) -> None:
        if pgdw is None:
            raise unittest.SkipTest(f"import failed: {_IMPORT_ERROR}")
        from types import SimpleNamespace

        cls.conn = get_ephemeral_connection()
        cls.addClassCleanup(cls._rollback_and_close)

        stub = SimpleNamespace(connect=lambda *a, **k: _NonCommittingConn(cls.conn))
        cls._patcher = mock.patch.object(pgdw, "psycopg", stub)
        cls._patcher.start()
        cls.addClassCleanup(cls._patcher.stop)

    @classmethod
    def _rollback_and_close(cls) -> None:
        if cls.conn is not None:
            cls.conn.rollback()
            cls.conn.close()

    def _upsert_probe(self, signature: str) -> int:
        # Distinct signature per test — the class shares ONE open transaction,
        # so a signature made terminal in one test stays terminal for the next.
        with contextlib.redirect_stderr(io.StringIO()):
            pgdw.upsert_learning_pattern(
                pattern_signature=signature,
                discovered_date=date.today(),
                frequency=9999,
                agent=_PROBE_AGENT,
                status="identified",
                approval_tier="user-pending",
            )
        cur = self.conn.cursor()
        cur.execute(
            "SELECT id FROM core.learning_log WHERE pattern_signature = %s",
            (signature,),
        )
        return cur.fetchone()[0]

    def _intake_signatures(self) -> set[str]:
        with contextlib.redirect_stderr(io.StringIO()):
            rows = pgdw.read_pending_learning_patterns()
        return {row["pattern_signature"] for row in rows}

    def test_when_identified_row_rejected_then_terminal_and_audited(self) -> None:
        row_id = self._upsert_probe(f"ap4 terminal-audit probe|{_PROBE_AGENT}")

        with contextlib.redirect_stderr(io.StringIO()):
            transitioned = pgdw.reject_learning_pattern(row_id, "ap4 probe snooze")
        self.assertEqual(transitioned, row_id)

        cur = self.conn.cursor()
        cur.execute(
            "SELECT status::text, last_transition_reason, last_transition_at "
            "FROM core.learning_log WHERE id = %s",
            (row_id,),
        )
        status, reason, transitioned_at = cur.fetchone()
        self.assertEqual(status, "rejected")
        self.assertEqual(reason, "ap4 probe snooze")
        self.assertIsNotNone(transitioned_at)

        # Idempotent: the terminal row matches nothing on a second call.
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNone(pgdw.reject_learning_pattern(row_id, "again"))

    def test_when_row_rejected_then_intake_no_longer_returns_it(self) -> None:
        signature = f"ap4 intake-exclusion probe|{_PROBE_AGENT}"
        row_id = self._upsert_probe(signature)
        self.assertIn(signature, self._intake_signatures())

        with contextlib.redirect_stderr(io.StringIO()):
            pgdw.reject_learning_pattern(row_id, "ap4 probe snooze")

        # Function-level next-cycle dry run: the intake predicate (the only
        # generation source) no longer selects the snoozed row.
        self.assertNotIn(signature, self._intake_signatures())


if __name__ == "__main__":
    unittest.main(verbosity=2)
