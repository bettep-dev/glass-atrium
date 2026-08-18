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
merge. `reverted` is absent from the matrix deliberately: it is outside the arm's
terminal set today, a pre-existing gap named and left out of scope.
"""

from __future__ import annotations

import pytest

import _pg_stub_backend as backend

_CYCLE_DATE = "2026-08-18"
_PATTERN_LABEL = "rationale-co-movement"
_TARGET_FILE = "agents/glass-atrium-dev-python.md"
_KEY = (_CYCLE_DATE, _PATTERN_LABEL, _TARGET_FILE)

# The arm's own terminal set. `reverted` is deliberately not here — see the docstring.
_TERMINAL = ("applied", "approved", "rejected")
_NON_TERMINAL = ("pending", "snoozed")
_STORABLE = _TERMINAL + _NON_TERMINAL


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
