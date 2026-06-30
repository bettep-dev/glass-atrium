"""Behavioral tests for the generation-side anti-fossil gates (AP-4).

``daemon_cycle.run_cycle`` now filters intake patterns through two lifecycle
gates before any Haiku spend:
(1) reject-streak snooze — N consecutive genuinely-rejected proposals for the
    same pattern+agent transition the ``core.learning_log`` row to terminal
    'rejected' via ``_pg_learning_dualwrite.reject_learning_pattern`` (the
    intake predicate stops selecting it), loudly (stderr WARN +
    ``eval_result='reject-streak-snooze'`` loop event);
(2) staleness skip — the pattern's live rate recomputed from a rolling
    outcomes window (poisoned rows excluded inside ``read_outcomes_since``)
    below the aggregator's emit threshold → skipped this cycle with a logged
    reason (``eval_result='stale-pattern-skip'``), no lifecycle transition.
Terminal protection: a 'rejected' learning_log row can never resurrect to
'identified' (state-machine pin), so a snoozed row generates no proposal on
any later cycle.

Live-PG classes insert fixtures in an open, never-committed transaction
(rolled back on teardown — the database is left byte-identical; no DELETE
needed). Loop-event emission is captured by a recorder in place of
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
from datetime import date
from pathlib import Path
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
) -> "dc.Pattern":
    return dc.Pattern(
        date="2026-06-01",
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


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestConsecutiveRejectCount(unittest.TestCase):
    """Streak walk: genuine rejects count; mechanical rows are looked past."""

    def test_when_three_genuine_rejects_then_streak_is_three(self) -> None:
        rows = [_reject(), _reject(), _reject()]
        self.assertEqual(dc.consecutive_reject_count(_LEGACY_LABEL, rows), 3)

    def test_when_supersede_and_timeout_rows_then_looked_past(self) -> None:
        rows = [
            _reject(rationale=dc._SUPERSEDE_REASON),
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

    def test_when_applied_row_then_streak_breaks(self) -> None:
        rows = [
            _reject(),
            ("applied", _LEGACY_PROPOSAL_LABEL, "landed"),
            _reject(),
            _reject(),
        ]
        self.assertEqual(dc.consecutive_reject_count(_LEGACY_LABEL, rows), 1)

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


class TestDropStalePatterns(_GateFixture):
    """Below-live-threshold patterns are skipped with a reason (AP-4 test b)."""

    def _drop(self, outcome_results, patterns):
        rows = [{"result": r} for r in outcome_results]
        patchers = (
            mock.patch.object(dc, "HAS_PG_OUTCOME_READ", True),
            mock.patch.object(dc, "_pg_read_outcomes_since", lambda *a, **k: rows),
        )
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            kept = dc.drop_stale_patterns("wiki-curator", patterns)
        return kept, stderr.getvalue()

    def test_when_live_rate_below_floor_then_rate_pattern_skips(self) -> None:
        kept, stderr_text = self._drop(
            ["done"] * 10 + ["fail"], [_pattern(label=_LEGACY_LABEL)]
        )

        self.assertEqual(kept, [])
        self.assertIn("stale-pattern-skip", self._event_results())
        self.assertIn("live negative-signal rate", stderr_text)

    def test_when_live_rate_meets_floor_then_rate_pattern_survives(self) -> None:
        pattern = _pattern(label="agent instruction-improvement candidate (failure rate %)")
        kept, _ = self._drop(["fail", "blocked", "done"], [pattern])

        self.assertEqual(kept, [pattern])
        self.assertEqual(self.emitted, [])

    def test_when_live_fail_count_below_three_then_count_pattern_skips(self) -> None:
        kept, stderr_text = self._drop(
            ["fail", "fail"] + ["done"] * 8,
            [_pattern(label="동일 에이전트 반복 실패", row_id=9)],
        )

        self.assertEqual(kept, [])
        self.assertIn("live negative-signal count 2 < 3", stderr_text)

    def test_when_blocked_only_rows_then_count_pattern_survives(self) -> None:
        # AP-3 regression: a pattern sustained by non-'fail' signals (3 blocked,
        # 0 fails) must NOT be mis-skipped as stale.
        pattern = _pattern(label="동일 에이전트 반복 실패", row_id=9)
        kept, _ = self._drop(["blocked"] * 3 + ["done"] * 2, [pattern])

        self.assertEqual(kept, [pattern])
        self.assertEqual(self.emitted, [])

    def test_when_sample_insufficient_then_rate_pattern_skips(self) -> None:
        kept, stderr_text = self._drop(["done"], [_pattern(label=_LEGACY_LABEL)])

        self.assertEqual(kept, [])
        self.assertIn("live sample 1 < 3", stderr_text)

    def test_when_label_family_unknown_then_fail_open(self) -> None:
        pattern = _pattern(label="some future pattern family")
        kept, _ = self._drop([], [pattern])

        self.assertEqual(kept, [pattern])

    def test_when_pg_unavailable_then_fail_open(self) -> None:
        pattern = _pattern(label=_LEGACY_LABEL)
        with mock.patch.object(dc, "HAS_PG_OUTCOME_READ", False):
            kept = dc.drop_stale_patterns("wiki-curator", [pattern])

        self.assertEqual(kept, [pattern])


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
        import psycopg
        from types import SimpleNamespace

        try:
            cls.conn = psycopg.connect("dbname=glass_atrium", connect_timeout=2)
        except Exception as exc:  # noqa: BLE001 — no PG → skip the live class
            raise unittest.SkipTest(f"PG unreachable: {type(exc).__name__}: {exc}")
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
