"""Behavioral tests for auto-tier floor terminalization.

An auto candidate left ``approval_tier='auto', status='pending'`` never reaches a
terminal state while auto-apply is closed: it fossilizes as a standing "New
suggestions" pile on the monitor LEARNING board.

``daemon_cycle.resolve_floor_terminalization`` closes that limbo at the GENERATION
source: every auto+pending candidate is rewritten to a terminal
``status='unadjudicated'``, while safety-tier rows stay pending for human approval.

The posterior and its promotion tier are a label only: whatever tier the ladder
assigns, the status, approval tier and terminalization verdict stay the same, and
the tier itself is carried through unchanged.

Run with either runner:
    python3 -m unittest autoagent.test.test_floor_terminalization -v
    uv run --with pytest pytest autoagent/test/test_floor_terminalization.py -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_HOOKS_DIR = _REPO_ROOT / "hooks"

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))

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

    def test_when_auto_pending_then_terminalized_whatever_its_tier(self) -> None:
        for name, tier in _get_tier_rows():
            with self.subTest(row=name):
                result = dc.resolve_floor_terminalization(
                    classification="body-auto",
                    approval_tier="auto",
                    status_value="pending",
                    promotion_tier=tier,
                    rationale="haiku rationale",
                )
                self.assertTrue(result.terminalized)
                self.assertEqual(result.status_value, "unadjudicated")
                self.assertEqual(result.approval_tier, "")
                self.assertEqual(result.classification, "reject")
                self.assertEqual(result.rationale, dc._BELOW_FLOOR_REJECT_REASON)
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
