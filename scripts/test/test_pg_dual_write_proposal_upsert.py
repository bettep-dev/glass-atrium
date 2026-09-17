"""Co-movement pin for the proposal UPSERT's conflict arm in _pg_dual_write_daemon.py.

The arm preserves a stored TERMINAL status against a re-push carrying the report's
baked-in 'pending'. The rationale is what explains that status — a supersede stamp
on a rejected row says why it was rejected — so assigning it unconditionally from
EXCLUDED kept the verdict and erased its explanation. That text is live input, not
history: the failure classifier defaults unrecognised text to the quality class and
the reject streak is recomputed from those rows, so an erased stamp advances a kill
counter and inflates a monitor bucket.

The invariant pinned here: whenever the arm preserves the stored status it preserves
the stored rationale, and whenever it takes the incoming status it takes the incoming
rationale. The three arms are opposed on purpose. The preserving arm alone closes
nothing — it is satisfied equally by the correct conditional and by never overwriting
the rationale at all, which would silently freeze every pending row's text; the
refreshing arm is what goes red for that. The terminal-incoming arm goes red for a
preservation predicate wider than the status predicate, and it is the arm protecting
the updater's accountability record, which always sends a terminal status.

Every case drives the helper's REAL statement text through a stdlib SQL engine (see
_pg_stub_backend), so it runs on the test-python-pytest gating leg and can fail the
merge. `reverted` is absent from the co-movement matrix: the helper coerces it away,
so no push carries it. A REVIEWED reverted row is covered by the freeze pins below.

Two rules sit above the co-movement arms:
- Reviewed-row freeze: a stored terminal row carrying `reviewed_at` (the apply flip,
  the monitor reject route) is a human-or-apply verdict, so no re-push changes any
  column of it: a rewritten report must not replace the diff that landed.
- Marker exemption: an unreviewed back-off marker is a skip record, not a verdict,
  so a real proposal on the same key replaces it; a marker re-push does not.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

import _pg_stub_backend as backend

_CYCLE_DATE = "2026-08-18"
_PATTERN_LABEL = "rationale-co-movement"
_TARGET_FILE = "agents/glass-atrium-dev-python.md"
_KEY = (_CYCLE_DATE, _PATTERN_LABEL, _TARGET_FILE)

# The arm's own terminal set; `reverted` is not writable through the helper.
_TERMINAL = ("applied", "approved", "rejected")
_NON_TERMINAL = ("pending", "snoozed")
_STORABLE = _TERMINAL + _NON_TERMINAL
_REVIEWED_TERMINAL = (*_TERMINAL, "reverted")
_REVIEWED_AT = "2026-07-26 03:51:48"
_MARKER = "skipped:chronic-timeout-backoff"
_DAEMON_CYCLE = Path(__file__).resolve().parents[2] / "autoagent" / "daemon_cycle.py"

# Every column the conflict arm assigns, distinct per variant → a leaked column shows.
# pre_verify_axes stays None: the stdlib engine cannot bind the Jsonb adapter.
_SEEDED = {
    "target_agent": "glass-atrium-dev-python",
    "classification": "apply",
    "rationale": "timeout backoff held 3 cycles",
    "haiku_status": "ok",
    "approval_tier": "auto",
    "proposed_diff": "+landed line",
    "cost_guard_state": "ok",
    "source_file": "autoagent-2026-07-25.json",
    "source_file_mtime": 1,
    "indexed_at": "2026-07-26 03:00:00",
    "pre_verify_passed": True,
    "pre_verify_status": "pass",
    "pre_verify_rationale": "axes clear",
    "confidence_observed": 0.9,
    "project_key": "aaaaaaaaaaaa",
    "promotion_tier": "proposal",
}
_REPUSHED = {
    "target_agent": "glass-atrium-dev-shell",
    "classification": "reject",
    "rationale": "report rewritten after apply",
    "haiku_status": "skipped:transient",
    "approval_tier": "user",
    "proposed_diff": "",
    "cost_guard_state": "tripped",
    "source_file": "autoagent-2026-07-25.rewritten.json",
    "source_file_mtime": 2,
    "indexed_at": "2026-07-26 05:00:42",
    "pre_verify_passed": False,
    "pre_verify_status": "fail",
    "pre_verify_rationale": "axes failed",
    "confidence_observed": 0.1,
    "project_key": "bbbbbbbbbbbb",
    "promotion_tier": "mention",
}


def _stamp(status: str) -> str:
    return "superseded by a later run in the same cycle [seeded %s]" % status


def _generation_text(status: str) -> str:
    return "pattern recurred across 5 outcomes [pushed %s]" % status


class _Proposals:
    """Push an identity triple through the real statement; read back what persisted."""

    def __init__(self, helper, db_path) -> None:
        self._helper = helper
        self._db_path = db_path

    def push(self, status: str, rationale: str) -> None:
        self._helper.write_autoagent_proposal(
            cycle_date=_CYCLE_DATE,
            pattern_label=_PATTERN_LABEL,
            target_file=_TARGET_FILE,
            target_agent="glass-atrium-dev-python",
            classification="apply",
            rationale=rationale,
            haiku_status="ok",
            approval_tier="auto",
            status=status,
            proposed_diff="",
            cost_guard_state="ok",
            source_file="autoagent/daemon_cycle.py",
            source_file_mtime=0,
        )

    def get_stored(self) -> dict[str, str]:
        stored = backend.read_proposal(self._db_path, _KEY)
        assert stored is not None, "the seeding push stored no row"
        return stored

    def push_row(self, status: str, content: dict[str, object]) -> None:
        self._helper.write_autoagent_proposal(
            cycle_date=_CYCLE_DATE,
            pattern_label=_PATTERN_LABEL,
            target_file=_TARGET_FILE,
            status=status,
            **content,
        )

    def push_outcome(self, status: str, rationale: str, haiku_status) -> None:
        self.push_row(
            status, dict(_SEEDED, rationale=rationale, haiku_status=haiku_status)
        )

    def set_review(self, status: str) -> None:
        # The helper writes no reviewed_at and coerces `reverted`, so the review
        # stamp the apply flip or the reject route leaves is set straight in the store.
        with closing(sqlite3.connect(self._db_path)) as db:
            db.execute(
                "UPDATE autoagent_proposals SET status = ?, reviewed_at = ?"
                " WHERE cycle_date = ? AND pattern_label = ? AND target_file = ?",
                (status, _REVIEWED_AT, *_KEY),
            )
            db.commit()

    def get_row(self) -> dict[str, object]:
        with closing(sqlite3.connect(self._db_path)) as db:
            db.row_factory = sqlite3.Row
            row = db.execute(
                "SELECT * FROM autoagent_proposals"
                " WHERE cycle_date = ? AND pattern_label = ? AND target_file = ?",
                _KEY,
            ).fetchone()
        assert row is not None, "the seeding push stored no row"
        return dict(row)


@pytest.fixture
def proposals(tmp_path):
    db_path = tmp_path / "autoagent_proposals.sqlite"
    backend.create_proposals_table(db_path)
    with backend.load_helper(db_path) as helper:
        yield _Proposals(helper, db_path)


@pytest.mark.parametrize("stored_status", _TERMINAL)
@pytest.mark.parametrize("incoming_status", _NON_TERMINAL)
def test_when_a_terminal_status_is_preserved_then_its_rationale_is_preserved(
    proposals: _Proposals, stored_status: str, incoming_status: str
):
    # The defect: the status survived the re-push and the text explaining it did not.
    proposals.push(stored_status, _stamp(stored_status))

    proposals.push(incoming_status, _generation_text(incoming_status))

    assert proposals.get_stored() == {
        "status": stored_status,
        "rationale": _stamp(stored_status),
    }


@pytest.mark.parametrize("stored_status", _NON_TERMINAL)
@pytest.mark.parametrize("incoming_status", _NON_TERMINAL)
def test_when_no_status_is_preserved_then_the_incoming_rationale_replaces_it(
    proposals: _Proposals, stored_status: str, incoming_status: str
):
    # The common refresh. A blanket "never overwrite the rationale" fix passes the
    # preserving arm and freezes every pending row's text — this is what reddens for it.
    proposals.push(stored_status, _stamp(stored_status))

    proposals.push(incoming_status, _generation_text(incoming_status))

    assert proposals.get_stored() == {
        "status": incoming_status,
        "rationale": _generation_text(incoming_status),
    }


@pytest.mark.parametrize("stored_status", _STORABLE)
@pytest.mark.parametrize("incoming_status", _TERMINAL)
def test_when_the_incoming_status_is_terminal_then_its_rationale_comes_with_it(
    proposals: _Proposals, stored_status: str, incoming_status: str
):
    # The updater's accountability path always sends a terminal status: an incoming
    # verdict is authoritative, so a preservation predicate wider than the status
    # predicate would suppress the record of why the row was declined or accepted.
    proposals.push(stored_status, _stamp(stored_status))

    proposals.push(incoming_status, _generation_text(incoming_status))

    assert proposals.get_stored() == {
        "status": incoming_status,
        "rationale": _generation_text(incoming_status),
    }


@pytest.mark.parametrize("stored_status", _REVIEWED_TERMINAL)
@pytest.mark.parametrize("incoming_status", _STORABLE)
def test_when_a_reviewed_row_is_terminal_then_no_re_push_changes_any_column(
    proposals: _Proposals, stored_status: str, incoming_status: str
):
    proposals.push_row("pending", _SEEDED)
    proposals.set_review(stored_status)
    reviewed = proposals.get_row()

    proposals.push_row(incoming_status, _REPUSHED)

    assert proposals.get_row() == reviewed


@pytest.mark.parametrize("stored_status", _NON_TERMINAL)
def test_when_a_reviewed_row_is_not_terminal_then_the_re_push_replaces_it(
    proposals: _Proposals, stored_status: str
):
    # The stale-drain stamps reviewed_at on a snooze; a freeze keyed on the stamp
    # alone would pin that row against the proposal that should resume it.
    proposals.push_row("pending", _SEEDED)
    proposals.set_review(stored_status)

    proposals.push_row("pending", _REPUSHED)

    stored = proposals.get_row()
    assert {k: stored[k] for k in ("status", "rationale", "proposed_diff")} == {
        "status": "pending",
        "rationale": _REPUSHED["rationale"],
        "proposed_diff": _REPUSHED["proposed_diff"],
    }


@pytest.mark.parametrize(
    ("stored_outcome", "incoming_status", "incoming_outcome", "is_replaced"),
    [
        (_MARKER, "pending", "ok", True),
        (_MARKER, "pending", None, True),
        (_MARKER, "snoozed", _MARKER, False),
        (None, "pending", "ok", False),
    ],
)
def test_when_an_unreviewed_row_is_re_pushed_then_only_a_marker_yields_to_a_non_marker(
    proposals: _Proposals,
    stored_outcome,
    incoming_status: str,
    incoming_outcome,
    is_replaced: bool,
):
    proposals.push_outcome("rejected", _stamp("rejected"), stored_outcome)

    proposals.push_outcome(
        incoming_status, _generation_text(incoming_status), incoming_outcome
    )

    expected = (
        {"status": incoming_status, "rationale": _generation_text(incoming_status)}
        if is_replaced
        else {"status": "rejected", "rationale": _stamp("rejected")}
    )
    assert proposals.get_stored() == expected


def test_the_exempted_marker_is_the_outcome_the_daemon_writes():
    # The helper cannot import the daemon, so the literal the upsert exempts is
    # tied to the daemon's own spelling here.
    assert f'"{_MARKER}"' in _DAEMON_CYCLE.read_text(encoding="utf-8")
