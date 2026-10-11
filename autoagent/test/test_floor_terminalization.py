"""Behavioral tests for auto-tier floor terminalization.

An auto candidate left ``approval_tier='auto', status='pending'`` never reaches a
terminal state while auto-apply is closed: it fossilizes as a standing "New
suggestions" pile on the monitor LEARNING board.

``daemon_cycle.resolve_floor_terminalization`` closes that limbo at the GENERATION
source: every auto+pending candidate the cycle bound to no live pre-registration is
rewritten to a terminal ``status='unadjudicated'``; a bound candidate stays pending,
in trial, and safety-tier rows stay pending for human approval.

The posterior and its promotion tier are a label only: whatever tier the ladder
assigns, the status, approval tier and terminalization verdict stay the same, and
the tier itself is carried through unchanged.

With generation closed, ``daemon_cycle.update_generation_closed_proposals`` closes
the same limbo for STORED rows: one idempotent statement moves every pending auto
row to ``unadjudicated`` under the generation-closed reason and actor, and leaves
every other row as it was.

The one-running-trial gate keeps an agent holding an open live trial out of
generation: its open trials are read once per cycle, a read fault makes no
generator call that cycle, and the trial's pending row survives the cycle.

Run with either runner:
    python3 -m unittest autoagent.test.test_floor_terminalization -v
    uv run --with pytest pytest autoagent/test/test_floor_terminalization.py -v
"""

from __future__ import annotations

import contextlib
import io
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_HOOKS_DIR = _REPO_ROOT / "hooks"
_STUB_DIR = _REPO_ROOT / "scripts" / "test"

for _anchor in (_HOOKS_DIR, _AUTOAGENT_DIR, _STUB_DIR, Path(__file__).resolve().parent):
    if str(_anchor) not in sys.path:
        sys.path.insert(0, str(_anchor))

import _pg_stub_backend as stub  # noqa: E402 — anchors pinned by the loop above
from _pg_seal import create_live_trial, create_trial_ledger_table, seal_pg_reach

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

# One row per tier class: (row name, posterior mean, observation count, sustained,
# touches frontmatter) → the tier the real ladder assigns to that posterior.
_LADDER_ROWS: tuple[tuple[str, float, int, bool, bool], ...] = (
    ("mention", 0.5, 0, False, False),
    ("candidate", 0.75, 12, False, False),
    ("instruction-edit", 0.95, 50, True, False),
    ("skill-candidate", 0.95, 50, True, True),
)
# Labels the ladder never assigns today but stored rows carry: the
# retired-bypass empty label and the proposal rung.
_STORED_ONLY_TIERS: tuple[str, ...] = ("", "proposal")


def _get_tier_rows() -> list[tuple[str, str]]:
    """(row name, promotion tier) — the ladder rows classified, then stored-only labels."""
    rows = []
    for name, posterior, count, sustained, touches_frontmatter in _LADDER_ROWS:
        tier = dc.classify_promotion_tier(
            confidence_observed=posterior,
            observation_count=count,
            sustained=sustained,
            touches_frontmatter=touches_frontmatter,
        )
        rows.append((name, tier))
    rows.extend((f"stored {tier!r}", tier) for tier in _STORED_ONLY_TIERS)
    return rows


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestPromotionTierIsALabel(unittest.TestCase):
    """A candidate's posterior and tier never change its status, tier or verdict."""

    def test_when_ladder_row_classified_then_it_lands_in_its_named_tier(self) -> None:
        # Guards the table below: each ladder row really exercises its tier class.
        for name, tier in _get_tier_rows()[: len(_LADDER_ROWS)]:
            with self.subTest(row=name):
                self.assertEqual(tier, name)

    def test_when_auto_pending_then_only_a_bound_candidate_stays_pending_whatever_its_tier(
        self,
    ) -> None:
        bound = ("auto", "pending", "body-auto", "haiku rationale", False)
        floored = ("", "unadjudicated", "reject", dc._BELOW_FLOOR_REJECT_REASON, True)
        rows = (
            ("bound — the cycle attached a pre-registration payload", True, bound),
            ("unbound — no payload attached", False, floored),
        )
        for row_name, is_bound, expected in rows:
            for name, tier in _get_tier_rows():
                with self.subTest(candidate=row_name, row=name):
                    result = dc.resolve_floor_terminalization(
                        classification="body-auto",
                        approval_tier="auto",
                        status_value="pending",
                        promotion_tier=tier,
                        rationale="haiku rationale",
                        is_bound=is_bound,
                    )
                    self.assertEqual(
                        (
                            result.approval_tier,
                            result.status_value,
                            result.classification,
                            result.rationale,
                            result.terminalized,
                        ),
                        expected,
                    )
                    self.assertEqual(result.promotion_tier, tier)

    def test_when_not_auto_pending_then_untouched_whatever_its_tier(self) -> None:
        # Safety tier is the human queue; rejected / snoozed rows are already
        # terminal — none of them is re-decided at any tier.
        shapes = (
            ("safety pending", "body-auto", "safety", "pending"),
            ("quality reject", "reject", "", "rejected"),
            ("back-off snooze", "body-auto", "", "snoozed"),
        )
        for shape, classification, approval_tier, status_value in shapes:
            for name, tier in _get_tier_rows():
                with self.subTest(shape=shape, row=name):
                    result = dc.resolve_floor_terminalization(
                        classification=classification,
                        approval_tier=approval_tier,
                        status_value=status_value,
                        promotion_tier=tier,
                        rationale="upstream rationale",
                    )
                    self.assertFalse(result.terminalized)
                    self.assertEqual(result.classification, classification)
                    self.assertEqual(result.approval_tier, approval_tier)
                    self.assertEqual(result.status_value, status_value)
                    self.assertEqual(result.rationale, "upstream rationale")
                    self.assertEqual(result.promotion_tier, tier)

    def test_when_terminalized_then_rationale_classifies_as_non_adjudication(
        self,
    ) -> None:
        # A terminalization is no gate verdict, so it never advances a reject streak.
        self.assertEqual(
            dc.classify_failure_rationale(dc._BELOW_FLOOR_REJECT_REASON),
            dc.FAILURE_CLASS_SKIPPED,
        )


_CLOSED_TARGET = "agents/glass-atrium-dev-python.md"
_CLOSED_COLUMNS = ("status", "approval_tier", "rationale", "reviewed_by", "reviewed_at")
# (pattern label, stored ApprovalTier, stored ProposalStatus) — the one pending auto
# row it closes, then every other stored tier on a pending row and every other
# stored status on an auto row, each of which it must spare.
_CLOSED_SEED_ROWS: tuple[tuple[str, str, str], ...] = (
    ("pending auto", "auto", "pending"),
    ("pending user-pending", "user-pending", "pending"),
    ("pending user", "user", "pending"),
    ("pending llm", "llm", "pending"),
    ("rejected auto", "auto", "rejected"),
    ("unadjudicated auto", "auto", "unadjudicated"),
    ("applied auto", "auto", "applied"),
    ("approved auto", "auto", "approved"),
    ("snoozed auto", "auto", "snoozed"),
    ("reverted auto", "auto", "reverted"),
)
_CLOSED_SEED_RATIONALE = "pattern recurred across 5 outcomes"


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestGenerationClosedStatement(unittest.TestCase):
    """Only a stored pending auto row closes, once, under the closed reason and actor."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db = Path(tmp.name) / "proposals.sqlite"
        stub.create_proposals_table(self.db)
        with closing(sqlite3.connect(self.db)) as db:
            db.executemany(
                "INSERT INTO autoagent_proposals (cycle_date, pattern_label, target_file,"
                " approval_tier, status, rationale) VALUES ('2026-10-03', ?, ?, ?, ?, ?)",
                [
                    (label, _CLOSED_TARGET, tier, status, _CLOSED_SEED_RATIONALE)
                    for label, tier, status in _CLOSED_SEED_ROWS
                ],
            )
            db.commit()
        self.connects: list[Path] = []
        self.pg_reach = seal_pg_reach(self)

    def _connect(self) -> object:
        self.connects.append(self.db)
        return stub.create_connection(self.db)

    def _close(self, *, has_pg: bool = True) -> tuple[int, str]:
        """Run the real statement against the stdlib backend → (count, stderr)."""
        with stub.load_helper(self.db) as helper:
            fragment = helper.PROPOSAL_STATUS_SQL
        err = io.StringIO()
        # The seal bound _pg_connect on both legs; the fragment is unbound only
        # when the helper import failed.
        with (
            mock.patch.object(dc, "HAS_PG_LOOP_WRITE", has_pg),
            mock.patch.object(dc, "_pg_connect", self._connect),
            mock.patch.object(
                dc,
                "_PG_PROPOSAL_STATUS_SQL",
                fragment,
                create=dc._PG_LOOP_IMPORT_EXC is not None,
            ),
            contextlib.redirect_stderr(err),
        ):
            count = dc.update_generation_closed_proposals()
        self.assertEqual(self.pg_reach, [])
        return count, err.getvalue()

    def _rows(self) -> dict[str, dict[str, object]]:
        return {
            label: stub.read_proposal(
                self.db, ("2026-10-03", label, _CLOSED_TARGET), columns=_CLOSED_COLUMNS
            )
            for label, _, _ in _CLOSED_SEED_ROWS
        }

    def test_when_closed_then_only_the_pending_auto_row_terminalizes(self) -> None:
        before = self._rows()
        count, _ = self._close()
        after = self._rows()
        self.assertEqual(count, 1)
        self.assertEqual(
            after["pending auto"],
            {
                "status": "unadjudicated",
                "approval_tier": "auto",
                "rationale": f"{dc._GENERATION_CLOSED_REASON}: {_CLOSED_SEED_RATIONALE}",
                "reviewed_by": dc._GENERATION_CLOSED_ACTOR,
                "reviewed_at": None,
            },
        )
        for label, _, _ in _CLOSED_SEED_ROWS[1:]:
            with self.subTest(row=label):
                self.assertEqual(after[label], before[label])

    def test_when_closed_twice_then_the_second_run_changes_nothing(self) -> None:
        self._close()
        once = self._rows()
        count, _ = self._close()
        self.assertEqual(count, 0)
        self.assertEqual(self._rows(), once)

    def test_when_pg_unavailable_then_no_connection_and_a_named_skip(self) -> None:
        count, err = self._close(has_pg=False)
        self.assertEqual(count, 0)
        self.assertEqual(self.connects, [])
        self.assertIn("generation-closed terminalization: PG unavailable", err)

    def test_when_closed_then_the_stored_rationale_is_no_gate_verdict(self) -> None:
        self._close()
        stored = self._rows()["pending auto"]["rationale"]
        self.assertIn(
            dc.classify_failure_rationale(stored), dc._NON_ADJUDICATION_CLASSES
        )


_HOLDER = "glass-atrium-dev-python"  # holds an open live trial on its pending row
_FREE = "glass-atrium-dev-shell"  # holds none
_TRIAL_PROPOSAL_ID = 7
# the gate's read, kept before any test's seal replaces it with a refusal
_READ_OPEN_TRIALS = getattr(dc, "_pg_read_open_trials", None) if dc is not None else None


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestOneRunningTrialGate(unittest.TestCase):
    """No generator call for an agent holding an open trial; a read fault holds the whole cycle.

    The generation loop's input is the cycle's power passes, so a pattern in an agent's
    group is a pattern of that agent that passed power this cycle.
    """

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.agents_dir = root / "agents"
        self.agents_dir.mkdir()
        for agent in (_HOLDER, _FREE):
            (self.agents_dir / f"{agent}.md").write_text("# probe agent\n", encoding="utf-8")
        self.db = root / "proposals.sqlite"
        stub.create_proposals_table(self.db)
        create_trial_ledger_table(self.db)
        with closing(sqlite3.connect(self.db)) as db:
            db.execute(
                "INSERT INTO autoagent_proposals (id, cycle_date, pattern_label, target_agent,"
                " target_file, approval_tier, status, rationale)"
                " VALUES (?, '2026-10-10', 'in-trial pattern', ?, ?, 'auto', 'pending', 'trialled')",
                (_TRIAL_PROPOSAL_ID, _HOLDER, self._target(_HOLDER)),
            )
            db.commit()
        create_live_trial(self.db, _TRIAL_PROPOSAL_ID, _HOLDER)
        self.generated: list[str] = []
        self.reads: list[None] = []
        self.pg_reach = seal_pg_reach(self)
        with stub.load_helper(self.db) as helper:
            fragment = helper.PROPOSAL_STATUS_SQL
        # after the seal: the stand-in store is the DB boundary, the generator a recorder
        for name, value, is_created in (
            ("HAS_PG_LOOP_WRITE", True, False),
            ("_pg_connect", lambda: stub.create_connection(self.db), False),
            ("_pg_read_open_trials", self._read_open_trials, _READ_OPEN_TRIALS is None),
            ("TRIAL_LEDGER", stub.get_trial_ledger(), not hasattr(dc, "TRIAL_LEDGER")),
            ("_PG_PROPOSAL_STATUS_SQL", fragment, dc._PG_LOOP_IMPORT_EXC is not None),
            ("_drop_gated_patterns", lambda _agent, patterns, _gate: patterns, False),
            ("consecutive_timeout_count", lambda *_args: 0, False),
            ("INTER_CALL_SPACING_SEC", 0, False),
            ("generate_consolidated_proposal", self._generate, False),
            ("classify_patch_area", lambda *a, **k: "body-auto", False),
            # safety-routed → pending → the supersede runs over the agent's file
            ("classify_safety_tier", lambda *a, **k: "safety", False),
        ):
            patcher = mock.patch.object(dc, name, value, create=is_created)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _target(self, agent: str) -> str:
        return str(self.agents_dir / f"{agent}.md")

    def _read_open_trials(self) -> object:
        self.reads.append(None)
        return _READ_OPEN_TRIALS()

    def _generate(self, agent: str, *_args: object, **_kwargs: object) -> "dc.PatchProposal":
        self.generated.append(agent)
        return dc.PatchProposal(
            target_file=self._target(agent),
            rationale="probe rationale",
            proposed_diff="--- a\n+++ b\n@@ -1 +1,2 @@\n # probe agent\n+- probe rule\n",
            touched_frontmatter=False,
            estimated_added_lines=1,
            raw_response="probe raw response",
        )

    def _loop(self, *agents: str) -> str:
        """One full-real generation loop over the agents' passing patterns → its stderr."""
        report = SimpleNamespace(patches=[], cycle_date="2026-10-11")
        groups = [(agent, [self._pattern(agent)]) for agent in agents]
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            dc._run_generation_loop(
                report,
                groups,
                dc.GenerationRun(
                    regression_gate=object(),
                    agents_dir=self.agents_dir,
                    skip_haiku=False,
                    skip_pre_verify=True,
                    skip_loop_emit=False,
                ),
            )
        self.assertEqual(self.pg_reach, [])
        return err.getvalue()

    @staticmethod
    def _pattern(agent: str) -> "dc.Pattern":
        return dc.Pattern(
            date="2026-10-10",
            label="another passing pattern",
            frequency="5",
            agent=agent,
            status="identified",
            tier="user-pending",
            raw_line=f"pg:learning_log:11:another passing pattern|{agent}",
            row_id=11,
        )

    def _get_ledger(self) -> list[tuple]:
        with closing(sqlite3.connect(self.db)) as db:
            return db.execute("SELECT * FROM autoagent_trial_ledger ORDER BY id").fetchall()

    def test_an_agent_holding_an_open_trial_gets_no_generator_call(self) -> None:
        self._loop(_HOLDER, _FREE)
        self.assertEqual(self.generated, [_FREE])

    def test_the_open_trials_are_read_once_per_cycle(self) -> None:
        self._loop(_HOLDER, _FREE)
        self.assertEqual(len(self.reads), 1)

    def test_a_read_fault_warns_by_name_and_makes_no_generator_call_that_cycle(self) -> None:
        def _fault() -> None:
            raise sqlite3.OperationalError("no such table: core.autoagent_trial_ledger")

        with mock.patch.object(dc, "_pg_read_open_trials", _fault):
            err = self._loop(_HOLDER, _FREE)
        self.assertEqual(self.generated, [])
        self.assertIn(
            "WARN: one-running-trial gate — open live trials unreadable: OperationalError",
            err,
        )

    def test_the_in_trial_row_stays_pending_through_a_cycle_its_agent_passes_power(
        self,
    ) -> None:
        ledger = self._get_ledger()
        self._loop(_HOLDER)
        stored = stub.read_proposal(
            self.db, ("2026-10-10", "in-trial pattern", self._target(_HOLDER))
        )
        self.assertEqual(stored["status"], "pending")
        self.assertEqual(self._get_ledger(), ledger)


if __name__ == "__main__":
    unittest.main(verbosity=2)
