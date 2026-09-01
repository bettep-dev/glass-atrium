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

(2) READER agreement is the other half and lands with the ``_is_sustained``
    change; this commit fixes the writers.

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
