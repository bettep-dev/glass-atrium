"""Identity pin for the core.autoagent_loop_events upsert key in _pg_dual_write_daemon.py.

The table carries two row classes under one key. A census row counts how often a
cause fired on one day for one agent, so a re-emitted cause must collapse and two
different causes must not. A verdict row adjudicates ONE subject, so a corrected
verdict must supersede the verdict it corrects — which the three-column key cannot
express, because the subject it would key on is not among those columns. Two rows
in the live table already record one adjudication twice for exactly that reason.

The cause token names the class, so the subject has to agree with it in both
directions; the refusal cases below pin that choke point, including the blank
string, which is neither absence nor an identity and silently keys the verdict arm
on "" where two subjects collapse onto one row.

Every case drives the helper's REAL statement text through a stdlib SQL engine (see
_pg_stub_backend), so it runs on the test-python-pytest gating leg and can fail the
merge. What it cannot see stays a live-Postgres step: index inference against a
predicate-bearing arm, timestamptz typing, and concurrent upserts.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

import _pg_stub_backend as backend

_HELPER = Path(backend.__file__).resolve().parent.parent / "_pg_dual_write_daemon.py"
_TIMEOUT_S = 30

_EVENT_TS = "2026-09-18T04:12:00+00:00"
_AGENT = "glass-atrium-dev-python"
_SUBJECT = "clauded-docs/39785"
_STALE_CAUSE = "discharge-unresolved"
_CORRECTED_CAUSE = "discharge-covered-terminal"
_CENSUS_CAUSES = ("verified", "unverified")
_BLANK_SUBJECTS = ("", "   ")


class _LoopEvents:
    """Emit through the real statement; read back what the key let persist."""

    def __init__(self, helper, db_path: Path) -> None:
        self.helper = helper
        self._db_path = db_path

    def emit(self, cause: str, changes_added: int = 1, **identity: str) -> None:
        self.helper.write_autoagent_loop_event(
            event_ts=_EVENT_TS,
            agent=_AGENT,
            eval_result=cause,
            changes_added=changes_added,
            changes_removed=0,
            **identity,
        )

    def get_causes(self) -> list[str]:
        return [row["eval_result"] for row in backend.read_loop_events(self._db_path)]

    def get_subjects(self) -> list[str]:
        rows = backend.read_loop_events(self._db_path, columns=("subject",))
        return [row["subject"] for row in rows]


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


def test_when_one_subject_is_re_adjudicated_then_its_verdict_holds_one_row(
    events: _LoopEvents,
):
    # A corrected verdict supersedes the one it corrects: same subject, later
    # cause. Under the three-column key the two causes differ, so both persist
    # and the adjudication is counted twice.
    events.emit(_STALE_CAUSE, subject=_SUBJECT)

    events.emit(_CORRECTED_CAUSE, subject=_SUBJECT)

    assert events.get_causes() == [_CORRECTED_CAUSE]


def test_when_a_subject_differs_only_by_surrounding_space_then_it_is_one_verdict(
    events: _LoopEvents,
):
    # The verdict arm keys on the stored text, so an untrimmed subject splits one
    # subject's history across two rows — the split the class exists to prevent.
    events.emit(_STALE_CAUSE, subject=_SUBJECT)

    events.emit(_CORRECTED_CAUSE, subject="  %s  " % _SUBJECT)

    assert events.get_causes() == [_CORRECTED_CAUSE]
    assert events.get_subjects() == [_SUBJECT]


def test_when_a_verdict_cause_carries_no_subject_then_it_is_refused(
    events: _LoopEvents,
):
    # The census arm would take it silently and file an adjudication under the
    # recurrence census — the one corruption the choke point exists to stop.
    with pytest.raises(events.helper.VerdictSubjectMissing):
        events.emit(_STALE_CAUSE)

    assert events.get_causes() == []


@pytest.mark.parametrize("blank", _BLANK_SUBJECTS)
def test_when_a_verdict_cause_carries_a_blank_subject_then_it_is_refused(
    events: _LoopEvents, blank: str
):
    # A blank string passes an `is None` guard and keys the verdict arm on "",
    # so two subjects supersede each other across the class boundary.
    with pytest.raises(events.helper.VerdictSubjectMissing):
        events.emit(_STALE_CAUSE, subject=blank)

    assert events.get_causes() == []


def test_when_a_census_cause_carries_a_subject_then_it_is_refused(
    events: _LoopEvents,
):
    # The other direction of the same disagreement: the token names the class and
    # the subject contradicts it, so the row would be keyed on a column its class
    # never adjudicates.
    with pytest.raises(events.helper.CensusSubjectPresent):
        events.emit(_CENSUS_CAUSES[0], subject=_SUBJECT)

    assert events.get_causes() == []


def test_when_the_cli_refuses_a_classless_verdict_then_it_exits_6(tmp_path: Path):
    # Exit 6 is the caller-contract code, not the exit-4 write-failure path: a
    # refusal must not book a hook_failures row against a database nothing reached.
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(tmp_path), env["PYTHONPATH"]] if env.get("PYTHONPATH") else [str(tmp_path)]
    )
    env[backend.SQLITE_PATH_ENV] = str(tmp_path / "unreached.sqlite")
    backend.create_psycopg_package(tmp_path)
    envelope = json.dumps(
        {
            "op": "write_autoagent_loop_event",
            "args": {
                "event_ts": _EVENT_TS,
                "agent": _AGENT,
                "eval_result": _STALE_CAUSE,
                "changes_added": 0,
                "changes_removed": 0,
            },
        }
    )

    result = subprocess.run(
        [sys.executable, str(_HELPER)],
        input=envelope,
        text=True,
        capture_output=True,
        timeout=_TIMEOUT_S,
        env=env,
        check=False,
    )

    assert result.returncode == 6
    assert "pg_write=refused" in result.stderr
    assert result.stdout.strip() == ""
