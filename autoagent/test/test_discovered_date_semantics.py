"""One column, one meaning — core.learning_log.discovered_date.

Two gates used to read this column with OPPOSITE meanings, which is the defect
class that produced the parked-pattern incident:

  - ``_reobservation_reason`` reads it as LAST-observed (old ⇒ evidence went
    quiet ⇒ snooze), which is what the live writer actually stores;
  - ``_is_sustained`` read it as FIRST-observed (old ⇒ long-running ⇒ promote),
    which INVERTS against that writer. A pattern re-observed every cycle is
    restamped to today and could never sustain; one whose evidence stopped
    arriving sustained purely by ageing.

The agreed meaning is LAST-OBSERVED. Pinned here on both sides:

(1) WRITER agreement — every writer that dates a row refreshes it on re-emit,
    and no terminal transition touches it. Checked against the SQL literals,
    no database required (the same cross-check style as
    hooks/test/test_outcome_dualwrite_learning_enum.py). The second UPSERT
    (_pg_outcome_dualwrite) is DORMANT — its only producer emits
    ``learning_hint: null`` — so no live test can reach it and a shape check is
    the only guard it can have before its feeder is wired.

(2) READER agreement — ``_is_sustained`` no longer reads the column at all. It
    takes the oldest qualifying ``core.outcomes.record_ts``
    (``_first_observation_ts``), the one signal that genuinely carries
    first-observation, so the two gates now read two columns with one meaning
    each rather than one column with two.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_discovered_date_semantics.py -v
    python3 -m unittest autoagent.test.test_discovered_date_semantics -v
"""

from __future__ import annotations

import re
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

_AUTOAGENT_ROOT = Path(__file__).resolve().parent.parent
_REPO_ROOT = _AUTOAGENT_ROOT.parent
_HOOKS = _REPO_ROOT / "hooks"

if str(_AUTOAGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_ROOT))

import daemon_cycle as dc  # noqa: E402 — sys.path insert immediately above


def _upsert_conflict_clause(source: str, sql_const: str) -> str:
    """The ON CONFLICT DO UPDATE body of one named SQL constant."""
    match = re.search(
        rf'^{re.escape(sql_const)}\s*=\s*"""(.*?)"""',
        source,
        re.DOTALL | re.MULTILINE,
    )
    assert match is not None, f"{sql_const} not found — the test's anchor rotted"
    statement = match.group(1)
    _, _, conflict = statement.partition("ON CONFLICT")
    assert conflict, f"{sql_const} has no ON CONFLICT clause"
    return conflict


class TestWritersAgreeOnLastObserved(unittest.TestCase):
    """(1) Every writer dates the row the same way."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.learning_src = (_HOOKS / "_pg_learning_dualwrite.py").read_text()
        cls.outcome_src = (_HOOKS / "_pg_outcome_dualwrite.py").read_text()

    def test_when_aggregator_reemits_then_discovered_date_is_refreshed(self) -> None:
        conflict = _upsert_conflict_clause(
            self.learning_src, "_LEARNING_LOG_UPSERT_SQL"
        )
        self.assertIn("discovered_date = EXCLUDED.discovered_date", conflict)

    def test_when_outcome_dualwrite_reemits_then_discovered_date_is_refreshed(
        self,
    ) -> None:
        # The dormant writer. It omitted this clause, so once its feeder is wired
        # a re-observation through it would leave the row dated at its first
        # sighting — and _reobservation_reason would snooze a live pattern.
        conflict = _upsert_conflict_clause(
            self.outcome_src, "_LEARNING_LOG_UPSERT_SQL"
        )
        self.assertIn("discovered_date = EXCLUDED.discovered_date", conflict)

    def test_when_row_reaches_a_terminal_state_then_its_date_is_left_alone(
        self,
    ) -> None:
        # The reject/discharge transitions remove the row from intake; restamping
        # its date there would fabricate an observation that never happened.
        for const in ("_LEARNING_LOG_REJECT_SQL", "_LEARNING_LOG_DISCHARGE_SQL"):
            with self.subTest(sql=const):
                match = re.search(
                    rf'^{re.escape(const)}\s*=\s*"""(.*?)"""',
                    self.learning_src,
                    re.DOTALL | re.MULTILINE,
                )
                self.assertIsNotNone(match, f"{const} not found")
                self.assertNotIn("discovered_date", match.group(1))  # type: ignore[union-attr]

    def test_when_writers_are_enumerated_then_the_list_is_complete(self) -> None:
        # The enumeration on _reobservation_reason is load-bearing: the gate's
        # correctness argument is "no other writer dates this column". An
        # enumeration that misses one is worth nothing, which is how the dormant
        # UPSERT went unnoticed. Count the writers, not the prose.
        writers = []
        for path in sorted(_HOOKS.glob("*.py")):
            src = path.read_text()
            for match in re.finditer(
                r"(INSERT INTO core\.learning_log|UPDATE core\.learning_log)", src
            ):
                writers.append((path.name, match.group(1)))
        self.assertEqual(
            sorted(writers),
            [
                ("_pg_learning_dualwrite.py", "INSERT INTO core.learning_log"),
                ("_pg_learning_dualwrite.py", "UPDATE core.learning_log"),
                ("_pg_learning_dualwrite.py", "UPDATE core.learning_log"),
                ("_pg_outcome_dualwrite.py", "INSERT INTO core.learning_log"),
            ],
            "a writer appeared or vanished — reconcile the enumeration on "
            "daemon_cycle._reobservation_reason before changing this list",
        )


class TestSustainReadsFirstObservation(unittest.TestCase):
    """(2) The sustain gate no longer reads a last-observed column."""

    @staticmethod
    def _row(days_ago: float) -> dict:
        return {
            "record_ts": datetime.now(timezone.utc) - timedelta(days=days_ago),
            "revision_count": 0,
            "result": "done",
            "evaluative_signal": 0,
        }

    def test_when_evidence_spans_the_window_then_sustained(self) -> None:
        first = datetime.now(timezone.utc) - timedelta(days=30)
        self.assertTrue(dc._is_sustained(first))

    def test_when_evidence_is_younger_than_the_window_then_not_sustained(self) -> None:
        first = datetime.now(timezone.utc) - timedelta(days=2)
        self.assertFalse(dc._is_sustained(first))

    def test_when_a_pattern_is_reobserved_today_then_it_can_still_sustain(self) -> None:
        # The inversion, stated as behaviour. discovered_date is restamped to
        # today on every re-emit, so the OLD gate — which read that column —
        # returned False for exactly the patterns with the most live evidence.
        # The evidence here spans 30 days; the row's date is today.
        with mock.patch.object(
            dc, "_pg_read_outcomes_since", lambda *a, **k: [self._row(30)]
        ), mock.patch.object(dc, "HAS_PG_OUTCOME_READ", True):
            self.assertTrue(dc._is_sustained(dc._first_observation_ts("agent-x")))
        # And the reader that DOES own the column agrees it means last-observed:
        # a row dated today is fresh, not stale.
        today = datetime.now(timezone.utc).date()
        self.assertEqual(dc._reobservation_reason(today.isoformat(), today), "")

    def test_when_a_pattern_went_quiet_then_it_does_not_sustain_by_ageing(self) -> None:
        # The other half of the inversion. An old discovered_date used to READ as
        # sustained; the evidence behind it is 2 days old, so it is not.
        with mock.patch.object(
            dc, "_pg_read_outcomes_since", lambda *a, **k: [self._row(2)]
        ), mock.patch.object(dc, "HAS_PG_OUTCOME_READ", True):
            self.assertFalse(dc._is_sustained(dc._first_observation_ts("agent-x")))
        # Same row, the other gate: dated well outside the window ⇒ snoozed.
        today = datetime.now(timezone.utc).date()
        stale_date = (today - timedelta(days=dc.STALE_WINDOW_DAYS + 10)).isoformat()
        self.assertIn("no aggregator re-observation", dc._reobservation_reason(stale_date, today))

    def test_when_the_pattern_date_is_passed_then_it_is_rejected_as_input(self) -> None:
        # A YYYY-MM-DD string is what the gate used to take. Passing one now
        # fails closed rather than silently re-introducing the inverted read.
        self.assertFalse(dc._is_sustained("2020-01-01"))  # type: ignore[arg-type]

    def test_when_pg_is_unavailable_then_the_gate_fails_closed(self) -> None:
        with mock.patch.object(dc, "HAS_PG_OUTCOME_READ", False):
            self.assertIsNone(dc._first_observation_ts("agent-x"))
        self.assertFalse(dc._is_sustained(None))

    def test_when_the_window_is_empty_then_the_gate_fails_closed(self) -> None:
        with mock.patch.object(
            dc, "_pg_read_outcomes_since", lambda *a, **k: []
        ), mock.patch.object(dc, "HAS_PG_OUTCOME_READ", True):
            self.assertIsNone(dc._first_observation_ts("agent-x"))

    def test_when_the_read_raises_then_the_gate_fails_closed(self) -> None:
        def _boom(*_a, **_k):
            raise RuntimeError("pg down")

        with mock.patch.object(
            dc, "_pg_read_outcomes_since", _boom
        ), mock.patch.object(dc, "HAS_PG_OUTCOME_READ", True):
            self.assertIsNone(dc._first_observation_ts("agent-x"))

    def test_when_the_oldest_row_is_read_then_the_sample_cap_is_not_applied(self) -> None:
        # OUTCOME_SAMPLE_LIMIT holds the 5 most RECENT rows, whose span collapses
        # toward zero for a busy agent — the read must be ASC and limit 1.
        seen: dict = {}

        def _capture(*_a, **kwargs):
            seen.update(kwargs)
            return [self._row(30)]

        with mock.patch.object(
            dc, "_pg_read_outcomes_since", _capture
        ), mock.patch.object(dc, "HAS_PG_OUTCOME_READ", True):
            dc._first_observation_ts("agent-x")
        self.assertEqual(seen.get("order"), "ASC")
        self.assertEqual(seen.get("limit"), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
