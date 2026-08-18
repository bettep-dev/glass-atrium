"""Behavioral tests for the same-agent supersede predicate and its rationale.

``supersede_prior_pending_for_agent`` terminalizes an agent's other pending
proposal rows. It matched on status + agent + file with no identity term, so a
second run sharing a cycle date superseded the row its own push was about to
update — a proposal that should have applied was terminalized instead.

Three properties are covered:
(1) the opposed triple — the run's own identity survives, a same-cycle row under
    a drifted label transitions, and a prior-cycle row transitions. The middle
    arm is what a strictly-prior-date guard fails, and the last is what a
    label-only exclusion fails; neither arm alone discriminates;
(2) the rationale head/tail split — both composed variants classify to the
    supersede failure class through the REAL classifier (a variant that missed
    would fall to the quality class and advance the reject-streak kill
    mechanism), and the monitor route's stored LIKE marker is still a prefix of
    the head;
(3) the two fixes COMPOSED over one store — the same-cycle stamp this predicate
    writes still explains the rejected status after a later run re-pushes that
    identity through _pg_dual_write_daemon's UPSERT, and the run's own row is
    still live for its own push. Either fix reverted and this pair goes red.

Backend: the stdlib sqlite stand-in from ``scripts/test/_pg_stub_backend.py``
runs the REAL statement text (cast-stripped, qmark-rewritten), so no Postgres
and no psycopg are needed and all three run on the merge-gating unittest
leg. What it cannot see, and what nothing here claims: the date-typed
``cycle_date`` column, its cast, and the driver's type adaptation — those stay
live-Postgres verification steps.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_supersede_predicate.py -v
    python3 -m unittest autoagent.test.test_supersede_predicate -v
"""

from __future__ import annotations

import contextlib
import io
import re
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
# unittest discover puts neither root on sys.path, and scripts/test/conftest.py
# is a pytest-only anchor this runner never loads.
_STUB_DIR = _REPO_ROOT / "scripts" / "test"
for _anchor in (_AUTOAGENT_DIR, _STUB_DIR):
    if str(_anchor) not in sys.path:
        sys.path.insert(0, str(_anchor))

import _pg_stub_backend as stub  # noqa: E402 — anchors pinned by the loop above
import daemon_cycle as dc  # noqa: E402 — anchors pinned by the loop above

_ROUTE = _REPO_ROOT / "monitor" / "src" / "server" / "routes" / "improvement.ts"
_ROUTE_MARKER = re.compile(r'SUPERSEDE_RATIONALE_LIKE\s*=\s*"([^"]*)"')

_AGENT = "supersede-probe-agent"
_TARGET = "/tmp/supersede-probe-agent.md"
_RUN_DATE = "2026-08-18"
_PRIOR_DATE = "2026-08-17"
_RUN_LABEL = "supersede probe pattern (consolidated)"
_DRIFTED_LABEL = "supersede probe pattern (drifted)"
_SEED_RATIONALE = "generation rationale — must survive untouched"
_COLUMNS = (
    "cycle_date", "pattern_label", "target_agent", "target_file", "status", "rationale",
)
def _generation_text(run: int) -> str:
    """A push's own rationale — distinct per run so a stale text is visible."""
    return f"pattern recurred across 5 outcomes [run {run}]"



class _RowSetCursor(stub._Cursor):
    """The supersede statement RETURNs a row set; the shared cursor reads one row."""

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._inner.fetchall()


class _RowSetConnection(stub._Connection):
    def cursor(self) -> _RowSetCursor:
        return _RowSetCursor(self._db.cursor())


def _run_supersede(db_path: Path) -> None:
    """Drive the real supersede statement against the stdlib backend."""
    # create=True: the connect alias is bound only when psycopg imported, and the
    # gating leg has no psycopg — the seam must exist either way.
    quiet = contextlib.redirect_stderr(io.StringIO())
    armed = mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True)
    seam = mock.patch.object(
        dc, "_pg_connect", lambda: _RowSetConnection(db_path), create=True
    )
    with quiet, armed, seam:
        dc.supersede_prior_pending_for_agent(_AGENT, _TARGET, _RUN_DATE, _RUN_LABEL)


class TestSupersedePredicate(unittest.TestCase):
    """The opposed triple: one row survives its own supersede, two transition."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db = Path(tmp.name) / "proposals.sqlite"
        stub.create_proposals_table(self.db)
        self._seed(_RUN_DATE, _RUN_LABEL)
        self._seed(_RUN_DATE, _DRIFTED_LABEL)
        self._seed(_PRIOR_DATE, _RUN_LABEL)
        self._supersede()

    def _seed(self, cycle_date: str, label: str) -> None:
        with closing(sqlite3.connect(self.db)) as db:
            db.execute(
                "INSERT INTO autoagent_proposals (%s) VALUES (%s)"
                % (", ".join(_COLUMNS), ", ".join("?" * len(_COLUMNS))),
                (cycle_date, label, _AGENT, _TARGET, "pending", _SEED_RATIONALE),
            )
            db.commit()

    def _supersede(self) -> None:
        _run_supersede(self.db)

    def _row(self, cycle_date: str, label: str) -> dict[str, str]:
        row = stub.read_proposal(self.db, (cycle_date, label, _TARGET))
        self.assertIsNotNone(row, f"seeded row vanished: {cycle_date} / {label}")
        return row

    def test_when_run_shares_cycle_then_its_own_identity_survives(self) -> None:
        row = self._row(_RUN_DATE, _RUN_LABEL)
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["rationale"], _SEED_RATIONALE)

    def test_when_label_drifted_in_same_cycle_then_row_transitions(self) -> None:
        row = self._row(_RUN_DATE, _DRIFTED_LABEL)
        self.assertEqual(row["status"], "rejected")
        self.assertEqual(row["rationale"], dc._SUPERSEDE_REASON_SAME_CYCLE)

    def test_when_row_is_from_a_prior_cycle_then_row_transitions(self) -> None:
        row = self._row(_PRIOR_DATE, _RUN_LABEL)
        self.assertEqual(row["status"], "rejected")
        self.assertEqual(row["rationale"], dc._SUPERSEDE_REASON_CROSS_DAY)


class TestSupersedeRationaleConsumers(unittest.TestCase):
    """The head/tail split, asserted through the real consumers of the text."""

    def test_when_variant_is_emitted_then_classifier_returns_supersede(self) -> None:
        for rationale in (dc._SUPERSEDE_REASON_CROSS_DAY, dc._SUPERSEDE_REASON_SAME_CYCLE):
            with self.subTest(rationale=rationale):
                self.assertEqual(
                    dc.classify_failure_rationale(rationale), dc.FAILURE_CLASS_SUPERSEDE
                )

    def test_when_route_marker_is_stripped_then_it_prefixes_the_head(self) -> None:
        found = _ROUTE_MARKER.search(_ROUTE.read_text(encoding="utf-8"))
        self.assertIsNotNone(found, f"supersede LIKE marker not found in {_ROUTE}")
        marker = found.group(1)
        self.assertTrue(marker.endswith("%"), f"marker lost its wildcard: {marker!r}")
        self.assertTrue(
            dc._SUPERSEDE_REASON.startswith(marker[:-1]),
            f"route marker {marker!r} no longer prefixes head {dc._SUPERSEDE_REASON!r}",
        )


class TestSupersedeStampSurvivesRepush(unittest.TestCase):
    """The two fixes composed over ONE store: the supersede stamps, the push keeps it.

    The identity exclusion is what makes a SAME-CYCLE rejected row exist at all —
    without it the run's own row is the one terminalized, and no drifted-label row
    survives the cycle carrying a stamp. The rationale co-movement in the UPSERT's
    conflict arm is what keeps that stamp when a later run re-sends the identity
    with the report's baked-in 'pending'. Revert either and the pair stops holding:
    without the exclusion the run's own row goes rejected and the drifted row's
    stamp is the cross-day text, and without the co-movement the stamp is replaced
    by the incoming generation text while the rejected status it explains stays —
    which is exactly the unrecognised text the failure classifier defaults to the
    quality class, advancing the reject streak.

    Both writers reach the SAME sqlite file in the SAME process: the supersede
    through the patched _pg_connect seam, the push through the helper that
    load_helper imports against the fabricated psycopg surface. A subprocess
    harness cannot express this property — it cannot see the other writer's
    in-process transaction.
    """

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db = Path(tmp.name) / "proposals.sqlite"
        stub.create_proposals_table(self.db)
        with stub.load_helper(self.db) as helper:
            self._push(helper, _RUN_LABEL, _generation_text(1))
            self._push(helper, _DRIFTED_LABEL, _generation_text(1))
            _run_supersede(self.db)
            self._push(helper, _RUN_LABEL, _generation_text(2))
            self._push(helper, _DRIFTED_LABEL, _generation_text(2))

    def _push(self, helper: object, label: str, rationale: str) -> None:
        """A cycle push of one identity — always the report's baked-in 'pending'."""
        helper.write_autoagent_proposal(
            cycle_date=_RUN_DATE,
            pattern_label=label,
            target_file=_TARGET,
            target_agent=_AGENT,
            classification="apply",
            rationale=rationale,
            haiku_status="ok",
            approval_tier="auto",
            status="pending",
            proposed_diff="",
            cost_guard_state="ok",
            source_file="autoagent/daemon_cycle.py",
            source_file_mtime=0,
        )

    def _row(self, label: str) -> dict[str, str]:
        row = stub.read_proposal(self.db, (_RUN_DATE, label, _TARGET))
        self.assertIsNotNone(row, f"row vanished from the shared store: {label}")
        return row

    def test_when_a_stamped_row_is_repushed_then_the_stamp_stays_with_its_status(
        self,
    ) -> None:
        self.assertEqual(
            self._row(_DRIFTED_LABEL),
            {"status": "rejected", "rationale": dc._SUPERSEDE_REASON_SAME_CYCLE},
        )

    def test_when_the_row_is_the_runs_own_then_its_next_push_still_refreshes_it(
        self,
    ) -> None:
        self.assertEqual(
            self._row(_RUN_LABEL),
            {"status": "pending", "rationale": _generation_text(2)},
        )


if __name__ == "__main__":
    unittest.main()
