"""Budget pins for the daemon-side ``last_transition_reason`` templates.

``core.learning_log.last_transition_reason`` is ``varchar(500)``, and both write
paths in ``_pg_learning_dualwrite`` apply a SILENT ``reason[:LEARNING_LOG_REASON_MAX]``
slice: an over-long reason is stored truncated with no error and no warning, so
the loss surfaces only as a stored row ending mid-word. These tests make that
hazard loud at development time by round-tripping each reason through the real
slice and asserting it comes back unchanged.

Both sides are DERIVED, never typed: the head length is measured off the module
constant and the ceiling is imported from the write path, so neither a reworded
head nor a widened column leaves a stale number behind.

The apply-cap head is substitution-dependent ({n} applied proposals, cap {thr}),
so it is checked against a digit width well past any reachable value rather than
against an observed row.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_reason_tail_budget.py -v
    python3 -m unittest autoagent.test.test_reason_tail_budget -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

for _d in (_HOOKS_DIR, _AUTOAGENT_DIR):
    if str(_d) not in sys.path:
        sys.path.insert(0, str(_d))

import _pg_learning_dualwrite as pgdw  # noqa: E402 — hooks dir pinned above
import daemon_cycle as dc  # noqa: E402 — autoagent dir pinned above

CEILING = pgdw.LEARNING_LOG_REASON_MAX

# Widest substitution the {n}/{thr} templates are checked against. Every count
# they carry — the apply count, the reject streak — is bounded by
# _fetch_proposal_history's LIMIT 50 window, and the thresholds are small
# env-overridable integers, so three digits each is far past reachable.
#
# That reachability argument is the ONLY thing keeping this ceiling honest: if
# _fetch_proposal_history's LIMIT ever rises past 999, a four-digit count
# overflows a budget these tests still call green. Raising that LIMIT means
# raising this width in the same change.
_WIDEST_SUBSTITUTION = 10**3 - 1


def _slice(reason: str) -> str:
    """The exact guard both write paths apply before the UPDATE."""
    return reason[:CEILING]


class TestApplyCapReasonBudget(unittest.TestCase):
    """The apply-cap reason survives the write-path slice at any reachable count."""

    def test_load_bearing_head_is_unchanged(self):
        # The monitor's parked count (APPLY_CAP_REASON_PREFIX) and
        # test_pattern_lifecycle_gates both key on this literal. Only the tail
        # may be reworded.
        self.assertTrue(
            dc.APPLY_CAP_REASON_TEMPLATE.startswith("repeat-apply cap:"),
            "the parked-count prefix is load-bearing and must stay byte-identical",
        )

    def test_survives_slice_at_widest_substitution(self):
        for n, thr in ((3, 3), (50, 3), (_WIDEST_SUBSTITUTION, _WIDEST_SUBSTITUTION)):
            with self.subTest(n=n, thr=thr):
                reason = dc.APPLY_CAP_REASON_TEMPLATE.format(n=n, thr=thr)
                self.assertEqual(
                    _slice(reason),
                    reason,
                    "reason truncates silently at n=%d thr=%d (%d > %d)"
                    % (n, thr, len(reason), CEILING),
                )

    def test_ends_on_a_complete_clause(self):
        reason = dc.APPLY_CAP_REASON_TEMPLATE.format(
            n=_WIDEST_SUBSTITUTION, thr=_WIDEST_SUBSTITUTION
        )
        self.assertTrue(
            _slice(reason).endswith("."),
            "a truncated reason ends mid-word; a whole one ends on its clause",
        )

    def test_carries_the_corrected_remedy(self):
        # The pre-correction tail told the operator to re-arm by resetting
        # status to 'identified'. That is false — the cap recomputes from apply
        # history the flip never touches — and the tail now says so.
        reason = dc.APPLY_CAP_REASON_TEMPLATE.format(n=3, thr=3)
        self.assertNotIn("re-arm by setting status back to 'identified'", reason)
        self.assertIn("does not re-arm it", reason)
        self.assertIn("clear or scope that apply evidence", reason)


class TestRejectStreakReasonBudget(unittest.TestCase):
    """The reject-streak reason: same substitution-dependent shape as the cap."""

    def test_load_bearing_head_is_unchanged(self):
        # test_pattern_lifecycle_gates asserts "reject-streak snooze: 3
        # consecutive" — the head through the substitution is load-bearing.
        self.assertTrue(
            dc.REJECT_STREAK_REASON_TEMPLATE.format(n=3, thr=3).startswith(
                "reject-streak snooze: 3 consecutive"
            )
        )

    def test_survives_slice_at_widest_substitution(self):
        for n, thr in ((3, 3), (50, 3), (_WIDEST_SUBSTITUTION, _WIDEST_SUBSTITUTION)):
            with self.subTest(n=n, thr=thr):
                reason = dc.REJECT_STREAK_REASON_TEMPLATE.format(n=n, thr=thr)
                self.assertEqual(
                    _slice(reason),
                    reason,
                    "reason truncates silently at n=%d thr=%d (%d > %d)"
                    % (n, thr, len(reason), CEILING),
                )

    def test_ends_on_a_complete_clause(self):
        reason = dc.REJECT_STREAK_REASON_TEMPLATE.format(
            n=_WIDEST_SUBSTITUTION, thr=_WIDEST_SUBSTITUTION
        )
        self.assertTrue(_slice(reason).endswith("."))

    def test_carries_the_corrected_remedy(self):
        # consecutive_reject_count is recomputed each cycle from the same
        # proposal history and breaks only on a covering applied/approved row,
        # which a parked pattern can never produce — so the streak is frozen and
        # the status flip re-parks the row.
        reason = dc.REJECT_STREAK_REASON_TEMPLATE.format(n=3, thr=3)
        self.assertNotIn("re-arm by setting status back to 'identified'", reason)
        self.assertIn("does not re-arm it", reason)
        self.assertIn("clear or scope that reject evidence", reason)


class TestSoundControlIsUntouched(unittest.TestCase):
    """NON_AUTO_FIXABLE_REASON is the control case and keeps its own remedy."""

    def test_names_the_evidence_step_before_the_status_reset(self):
        reason = dc.NON_AUTO_FIXABLE_REASON
        self.assertIn("wrapping the target in an EDITABLE region", reason)
        self.assertLess(
            reason.index("EDITABLE region"),
            reason.index("status to 'identified'"),
            "the control case names the evidence-clearing step first",
        )
        self.assertEqual(_slice(reason), reason)


class TestRevertedSnoozeReasonBudget(unittest.TestCase):
    """The reverted-snooze reason survives the same slice; its head is fixed."""

    def test_load_bearing_head_is_unchanged(self):
        self.assertTrue(dc.REVERTED_SNOOZE_REASON.startswith("reverted snooze:"))

    def test_survives_slice(self):
        reason = dc.REVERTED_SNOOZE_REASON
        self.assertEqual(
            _slice(reason),
            reason,
            "reason truncates silently (%d > %d)" % (len(reason), CEILING),
        )

    def test_ends_on_a_complete_clause(self):
        self.assertTrue(_slice(dc.REVERTED_SNOOZE_REASON).endswith("."))

    def test_carries_the_corrected_remedy(self):
        # drop_reverted_patterns re-derives the verdict from the reverted rows
        # in the same history window, so the status flip re-parks the row.
        reason = dc.REVERTED_SNOOZE_REASON
        self.assertNotIn("re-arm by setting status back to 'identified'", reason)
        self.assertIn("does not re-arm it", reason)
        self.assertIn("clear or scope that reverted-apply evidence", reason)


if __name__ == "__main__":
    unittest.main()
