"""Identity pin for the core.autoagent_loop_events upsert key in _pg_dual_write_daemon.py.

The table carries two row classes under one key. A census row counts how often a
cause fired on one day for one agent, so a re-emitted cause must collapse and two
different causes must not. A verdict row adjudicates ONE subject, so a corrected
verdict must supersede the verdict it corrects — which the three-column key cannot
express, because the subject it would key on is not among those columns. Two rows
in the live table already record one adjudication twice for exactly that reason.

The proof case below is that supersession, and it is INEXPRESSIBLE today: the
writer takes six parameters and none of them is a subject. It is held off on the
writer's own signature rather than on a date, so the identity split switches it on
by landing, and its red is a ROW COUNT — the stand-in reads its columns from the
Prisma model and its indexes from the migration SQL, so the column exists before
the key moves and the failure cannot degrade into UndefinedColumn.

Every case drives the helper's REAL statement text through a stdlib SQL engine (see
_pg_stub_backend), so it runs on the test-python-pytest gating leg and can fail the
merge. What it cannot see stays a live-Postgres step: index inference against a
predicate-bearing arm, timestamptz typing, and concurrent upserts.
"""

from __future__ import annotations

import inspect
import tempfile
from pathlib import Path

import pytest

import _pg_stub_backend as backend

_EVENT_TS = "2026-09-18T04:12:00+00:00"
_AGENT = "glass-atrium-dev-python"
_SUBJECT_PARAM = "subject"
_SUBJECT = "clauded-docs/39785"
_STALE_CAUSE = "discharge-unresolved"
_CORRECTED_CAUSE = "discharge-covered-terminal"
_CENSUS_CAUSES = ("verified", "unverified")


def _get_writer_params() -> frozenset[str]:
    """Parameter names of the shipped loop-event writer, read off the function.

    Probed rather than assumed: the hold-off below is a capability question, and
    the writer's own signature is the only thing that answers it.
    """
    with tempfile.TemporaryDirectory() as probe_dir:
        with backend.load_helper(Path(probe_dir) / "unused.sqlite") as helper:
            signature = inspect.signature(helper.write_autoagent_loop_event)
    return frozenset(signature.parameters)


_WRITER_PARAMS = _get_writer_params()

_needs_subject = pytest.mark.skipif(
    _SUBJECT_PARAM not in _WRITER_PARAMS,
    reason="the writer takes no subject — the identity split switches this case on",
)


class _LoopEvents:
    """Emit through the real statement; read back what the key let persist."""

    def __init__(self, helper, db_path: Path) -> None:
        self._helper = helper
        self._db_path = db_path

    def emit(self, cause: str, changes_added: int = 1, **identity: str) -> None:
        self._helper.write_autoagent_loop_event(
            event_ts=_EVENT_TS,
            agent=_AGENT,
            eval_result=cause,
            changes_added=changes_added,
            changes_removed=0,
            **identity,
        )

    def get_causes(self) -> list[str]:
        return [row["eval_result"] for row in backend.read_loop_events(self._db_path)]


@pytest.fixture
def events(tmp_path):
    db_path = tmp_path / "autoagent_loop_events.sqlite"
    backend.create_loop_events_table(db_path)
    with backend.load_helper(db_path) as helper:
        yield _LoopEvents(helper, db_path)


def test_when_one_cause_is_re_emitted_then_the_census_holds_one_row(
    events: _LoopEvents,
):
    # Append-only source: log-rotation overlap replays a line, and a second row
    # would double the recurrence count the cycle reports.
    events.emit(_CENSUS_CAUSES[0], changes_added=1)

    events.emit(_CENSUS_CAUSES[0], changes_added=9)

    assert events.get_causes() == [_CENSUS_CAUSES[0]]


def test_when_two_causes_share_a_date_and_agent_then_each_keeps_its_row(
    events: _LoopEvents,
):
    # The census counts per cause, so collapsing distinct causes onto one row
    # would erase a whole outcome class from the day's distribution.
    for cause in _CENSUS_CAUSES:
        events.emit(cause)

    assert events.get_causes() == list(_CENSUS_CAUSES)


@_needs_subject
def test_when_one_subject_is_re_adjudicated_then_its_verdict_holds_one_row(
    events: _LoopEvents,
):
    # A corrected verdict supersedes the one it corrects: same subject, later
    # cause. Under the three-column key the two causes differ, so both persist
    # and the adjudication is counted twice.
    events.emit(_STALE_CAUSE, subject=_SUBJECT)

    events.emit(_CORRECTED_CAUSE, subject=_SUBJECT)

    assert events.get_causes() == [_CORRECTED_CAUSE]
