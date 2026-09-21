"""Co-movement pin for the proposal UPSERT's conflict arm in _pg_dual_write_daemon.py.

The arm preserves a stored TERMINAL status against a re-push carrying the report's
baked-in 'pending'. The rationale is what explains that status — a supersede stamp
on a rejected row says why it was rejected — so assigning it unconditionally from
EXCLUDED kept the verdict and erased its explanation. That text is live input, not
history: the failure classifier defaults unrecognised text to the quality class and
the reject streak is recomputed from those rows, so an erased stamp advances a kill
counter and inflates a monitor bucket.

The invariant pinned here: whenever the arm preserves the stored status it preserves
the stored rationale and the stored actor, and whenever it takes the incoming status
it takes both incoming values. `reviewed_by` is the third column under that one
predicate — the actor answers who moved the row, so it moves with what it moved.
Its refreshing arm coalesces: an envelope naming no actor leaves the stored one,
because the column was unreachable from any push before it joined the SET list.
The three arms are opposed on purpose. The preserving arm alone closes
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
  column of it: a rewritten report must not replace the diff that landed. A
  route-rejected marker is such a row.
- Marker exemption: an unreviewed back-off marker is a skip record, not a verdict,
  so a non-marker push takes its status and rationale even when non-terminal. The
  exemption widens the non-terminal arm only: a non-terminal marker push (the legacy
  `snoozed` shape) keeps both, and a terminal push takes both as for any row. The
  daemon writes markers `rejected`, so its same-key re-push keeps status `rejected`
  and lands the newer marker rationale, whose back-off prefix the classifier and the
  held-cycle count read unchanged. Outside the freeze every other column always
  takes the push; the exemption decides status and rationale alone.
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
_REPO_ROOT = Path(__file__).resolve().parents[2]
_DAEMON_CYCLE = _REPO_ROOT / "autoagent" / "daemon_cycle.py"
_SCHEMA = _REPO_ROOT / "monitor" / "prisma" / "schema.prisma"

# Actor tokens from the closed set declared at the schema column. One source per
# token: a shared default would file an updater row as a daemon push.
_ENVELOPE_ACTORS = {
    "updater-resolved-gap": _REPO_ROOT / "scripts" / "update.sh",
    "daemon-cycle-push": _REPO_ROOT / "scripts" / "_pg_push_autoagent_cycle.py",
}
_STORED_ACTOR = "daemon-cycle-parked-guard"
_INCOMING_ACTOR = "daemon-cycle-push"
_PROVENANCE = ("status", "rationale", "reviewed_by")

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

    def push(self, status: str, rationale: str, actor: str = "") -> None:
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
            reviewed_by=actor,
        )

    def get_stored(self) -> dict[str, str]:
        stored = backend.read_proposal(self._db_path, _KEY)
        assert stored is not None, "the seeding push stored no row"
        return stored

    def get_provenance(self) -> dict[str, str]:
        stored = backend.read_proposal(self._db_path, _KEY, _PROVENANCE)
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


@pytest.mark.parametrize("stored_status", _TERMINAL)
@pytest.mark.parametrize("incoming_status", _NON_TERMINAL)
def test_when_a_terminal_status_is_preserved_then_its_actor_is_preserved(
    proposals: _Proposals, stored_status: str, incoming_status: str
):
    # The stored row carries NO reviewed_at — a machine transition stamps the actor
    # alone — so the freeze never fires and this arm is the whole protection.
    proposals.push(stored_status, _stamp(stored_status), _STORED_ACTOR)

    proposals.push(incoming_status, _generation_text(incoming_status), _INCOMING_ACTOR)

    assert proposals.get_provenance() == {
        "status": stored_status,
        "rationale": _stamp(stored_status),
        "reviewed_by": _STORED_ACTOR,
    }


@pytest.mark.parametrize("stored_status", _STORABLE)
@pytest.mark.parametrize("incoming_status", _TERMINAL)
def test_when_the_incoming_status_is_terminal_then_its_actor_comes_with_it(
    proposals: _Proposals, stored_status: str, incoming_status: str
):
    # The opposed arm: a preservation predicate wider for the actor than for the
    # status would credit the incoming verdict to whoever produced the old one.
    proposals.push(stored_status, _stamp(stored_status), _STORED_ACTOR)

    proposals.push(incoming_status, _generation_text(incoming_status), _INCOMING_ACTOR)

    assert proposals.get_provenance() == {
        "status": incoming_status,
        "rationale": _generation_text(incoming_status),
        "reviewed_by": _INCOMING_ACTOR,
    }


def test_when_a_re_push_names_no_actor_then_the_stored_actor_survives(
    proposals: _Proposals,
):
    # No push could reach reviewed_by before it joined the SET list; an envelope
    # carrying no token must not acquire that power on the way in.
    proposals.push("pending", _stamp("pending"), _STORED_ACTOR)

    proposals.push("pending", _generation_text("pending"))

    assert proposals.get_provenance()["reviewed_by"] == _STORED_ACTOR


def test_a_born_terminal_row_names_its_creator(proposals: _Proposals):
    # A row terminal from its first push has no later transition to stamp it, so
    # the actor reaches the table through the insert arm or not at all.
    proposals.push("rejected", _stamp("rejected"), _STORED_ACTOR)

    assert proposals.get_provenance() == {
        "status": "rejected",
        "rationale": _stamp("rejected"),
        "reviewed_by": _STORED_ACTOR,
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


def test_when_an_unreviewed_rejected_marker_is_re_pushed_then_the_newer_rationale_lands(
    proposals: _Proposals,
):
    # The shape the daemon writes today: a terminal push, so the exemption never
    # decides it — a marker carve-out in the terminal arm would keep the stale text.
    proposals.push_outcome("rejected", _stamp("rejected"), _MARKER)

    proposals.push_outcome("rejected", _generation_text("rejected"), _MARKER)

    assert proposals.get_stored() == {
        "status": "rejected",
        "rationale": _generation_text("rejected"),
    }


def test_when_a_reviewed_rejected_marker_is_re_pushed_then_no_column_changes(
    proposals: _Proposals,
):
    # A route-rejected marker is a verdict: the freeze outranks the marker exemption.
    proposals.push_row("pending", dict(_SEEDED, haiku_status=_MARKER))
    proposals.set_review("rejected")
    reviewed = proposals.get_row()

    proposals.push_row("rejected", dict(_REPUSHED, haiku_status=_MARKER))

    assert proposals.get_row() == reviewed


@pytest.mark.parametrize(("token", "source"), sorted(_ENVELOPE_ACTORS.items()))
def test_each_envelope_source_carries_its_own_declared_actor_token(
    token: str, source: Path
):
    # The helper cannot import either caller, so the one-token-per-source rule and
    # the closed set it is drawn from are tied to their spellings here.
    assert '"reviewed_by": "%s"' % token in source.read_text(encoding="utf-8")
    assert "`%s`" % token in _SCHEMA.read_text(encoding="utf-8")


def test_the_exempted_marker_is_the_outcome_the_daemon_writes():
    # The helper cannot import the daemon, so the literal the upsert exempts is
    # tied to the daemon's own spelling here.
    assert f'"{_MARKER}"' in _DAEMON_CYCLE.read_text(encoding="utf-8")
