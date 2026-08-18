"""Behavioral tests for the same-agent supersede predicate and its rationale.

``supersede_prior_pending_for_agent`` terminalizes an agent's other pending
proposal rows. It matched on status + agent + file with no identity term, so a
second run sharing a cycle date superseded the row its own push was about to
update — a proposal that should have applied was terminalized instead.

Two properties are covered:
(1) the opposed triple — the run's own identity survives, a same-cycle row under
    a drifted label transitions, and a prior-cycle row transitions. The middle
    arm is what a strictly-prior-date guard fails, and the last is what a
    label-only exclusion fails; neither arm alone discriminates;
(2) the rationale head/tail split — both composed variants classify to the
    supersede failure class through the REAL classifier (a variant that missed
    would fall to the quality class and advance the reject-streak kill
    mechanism), and the monitor route's stored LIKE marker is still a prefix of
    the head.

Backend: the stdlib sqlite stand-in from ``scripts/test/_pg_stub_backend.py``
runs the REAL statement text (cast-stripped, qmark-rewritten), so no Postgres
and no psycopg are needed and both properties run on the merge-gating unittest
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


class _RowSetCursor(stub._Cursor):
    """The supersede statement RETURNs a row set; the shared cursor reads one row."""

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._inner.fetchall()


class _RowSetConnection(stub._Connection):
    def cursor(self) -> _RowSetCursor:
        return _RowSetCursor(self._db.cursor())


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
        # create=True: the connect alias is bound only when psycopg imported, and
        # the gating leg has no psycopg — the seam must exist either way.
        quiet = contextlib.redirect_stderr(io.StringIO())
        armed = mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True)
        seam = mock.patch.object(
            dc, "_pg_connect", lambda: _RowSetConnection(self.db), create=True
        )
        with quiet, armed, seam:
            dc.supersede_prior_pending_for_agent(_AGENT, _TARGET, _RUN_DATE, _RUN_LABEL)

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


if __name__ == "__main__":
    unittest.main()
