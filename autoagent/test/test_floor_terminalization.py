"""Behavioral tests for auto-tier floor terminalization (I4a).

An auto candidate whose ``promotion_tier`` the apply gate permanently excludes
('mention', the Beta-Binomial floor rung) would otherwise be emitted as
``approval_tier='auto', status='pending'`` yet never reach a terminal state:
auto-apply (daemon-apply.sh extract_backlog_patches) excludes it by the floor
allowlist, and auto-tier is not a safety-queue candidate either. It fossilizes as
a standing "New suggestions" pile on the monitor LEARNING board.

``daemon_cycle.resolve_floor_terminalization`` closes that limbo at the GENERATION
source: an apply-ineligible auto+pending candidate is rewritten to a terminal
``status='rejected'`` so every auto-tier proposal reaches a terminal state within
its cycle, while safety-tier rows stay pending for human approval.

Recurrence prevention: GENERATION and APPLY share ONE acceptance predicate
(``is_apply_eligible_promotion_tier`` / ``APPLY_ELIGIBLE_PROMOTION_TIERS``). The
SQL-drift guard statically parses the apply-side allowlist out of daemon-apply.sh
and asserts it equals the Python SoT, so the two gates can never diverge silently.

Run with either runner:
    python3 -m unittest autoagent.test.test_floor_terminalization -v
    uv run --with pytest pytest autoagent/test/test_floor_terminalization.py -v
"""

from __future__ import annotations

import re
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

_APPLY_SH = _AUTOAGENT_DIR / "daemon-apply.sh"


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestApplyEligiblePredicate(unittest.TestCase):
    """The single SoT predicate mirrors the apply-side allowlist exactly."""

    def test_when_mention_then_ineligible(self) -> None:
        # 'mention' is the ONLY value the apply gate excludes — the limbo source.
        self.assertFalse(dc.is_apply_eligible_promotion_tier("mention"))

    def test_when_above_floor_tiers_then_eligible(self) -> None:
        for tier in ("candidate", "proposal", "instruction-edit", "skill-candidate"):
            with self.subTest(tier=tier):
                self.assertTrue(dc.is_apply_eligible_promotion_tier(tier))

    def test_when_bypass_empty_string_then_eligible(self) -> None:
        # Operator OFF (floorless) — apply gate passes the row.
        self.assertTrue(dc.is_apply_eligible_promotion_tier(""))

    def test_when_none_legacy_row_then_eligible(self) -> None:
        # NULL promotion_tier = pre-feature row — apply gate passes it.
        self.assertTrue(dc.is_apply_eligible_promotion_tier(None))


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestResolveFloorTerminalization(unittest.TestCase):
    """Decision contract: limbo rows terminalize; everything else passes through."""

    def test_when_auto_pending_mention_then_terminalized_to_rejected(self) -> None:
        result = dc.resolve_floor_terminalization(
            classification="body-auto",
            approval_tier="auto",
            status_value="pending",
            promotion_tier="mention",
            rationale="haiku rationale",
        )
        self.assertTrue(result.terminalized)
        self.assertEqual(result.status_value, "rejected")
        self.assertEqual(result.approval_tier, "")
        self.assertEqual(result.classification, "reject")
        self.assertEqual(result.rationale, dc._BELOW_FLOOR_REJECT_REASON)

    def test_when_auto_pending_candidate_then_passes_through(self) -> None:
        # Above-floor auto candidate stays an auto-apply target (status='pending').
        result = dc.resolve_floor_terminalization(
            classification="body-auto",
            approval_tier="auto",
            status_value="pending",
            promotion_tier="candidate",
            rationale="haiku rationale",
        )
        self.assertFalse(result.terminalized)
        self.assertEqual(result.status_value, "pending")
        self.assertEqual(result.approval_tier, "auto")
        self.assertEqual(result.rationale, "haiku rationale")

    def test_when_safety_pending_then_stays_pending(self) -> None:
        # Safety tier is the human-approval queue — the auto-only gate never fires
        # on it, even at the 'mention' floor.
        result = dc.resolve_floor_terminalization(
            classification="body-auto",
            approval_tier="safety",
            status_value="pending",
            promotion_tier="mention",
            rationale="safety rationale",
        )
        self.assertFalse(result.terminalized)
        self.assertEqual(result.status_value, "pending")
        self.assertEqual(result.approval_tier, "safety")

    def test_when_already_rejected_then_untouched(self) -> None:
        # An upstream quality reject is already terminal — not re-decided.
        result = dc.resolve_floor_terminalization(
            classification="reject",
            approval_tier="",
            status_value="rejected",
            promotion_tier="mention",
            rationale="quality reject — pre-verify failed",
        )
        self.assertFalse(result.terminalized)
        self.assertEqual(result.status_value, "rejected")
        self.assertEqual(result.rationale, "quality reject — pre-verify failed")

    def test_when_snoozed_backoff_then_untouched(self) -> None:
        # Chronic-timeout back-off is terminal-but-recoverable (snoozed), not pending.
        result = dc.resolve_floor_terminalization(
            classification="body-auto",
            approval_tier="",
            status_value="snoozed",
            promotion_tier="mention",
            rationale="chronic haiku-timeout back-off",
        )
        self.assertFalse(result.terminalized)
        self.assertEqual(result.status_value, "snoozed")

    def test_when_bypass_empty_tier_then_passes_through(self) -> None:
        # Operator BYPASS (floorless) — apply gate would pass it, so no terminalize.
        result = dc.resolve_floor_terminalization(
            classification="body-auto",
            approval_tier="auto",
            status_value="pending",
            promotion_tier="",
            rationale="haiku rationale",
        )
        self.assertFalse(result.terminalized)
        self.assertEqual(result.status_value, "pending")
        self.assertEqual(result.approval_tier, "auto")


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestGenerationApplyPredicateParity(unittest.TestCase):
    """Drift guard: the Python SoT == the apply-side SQL allowlist (one predicate)."""

    def _apply_side_allowlist(self) -> set[str]:
        # Parse the quoted tokens out of the promotion_tier IN (...) block so a
        # future SQL edit that drops/adds a tier is caught by this test, not by a
        # silent re-limbo in production. The block spans from `promotion_tier IN (`
        # to its own-line closing paren; SQL comments after `--` are stripped per
        # line so commented parens/tokens never leak into the token scan.
        text = _APPLY_SH.read_text(encoding="utf-8")
        match = re.search(
            r"promotion_tier IN \(\s*\n(?P<body>.*?)\n\s*\)", text, re.DOTALL
        )
        self.assertIsNotNone(match, "apply-side promotion_tier IN(...) block not found")
        assert match is not None  # narrow for the type checker
        code = "\n".join(
            line.split("--", 1)[0] for line in match.group("body").splitlines()
        )
        return set(re.findall(r"'([^']*)'", code))

    def test_when_compared_then_python_sot_equals_apply_sql(self) -> None:
        self.assertEqual(
            dc.APPLY_ELIGIBLE_PROMOTION_TIERS,
            frozenset(self._apply_side_allowlist()),
        )

    def test_when_mention_then_absent_from_both_gates(self) -> None:
        # The floor rung must be excluded by BOTH sides for terminalization to hold.
        self.assertNotIn("mention", dc.APPLY_ELIGIBLE_PROMOTION_TIERS)
        self.assertNotIn("mention", self._apply_side_allowlist())


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestSimulatedCycleTerminalState(unittest.TestCase):
    """One simulated generation cycle: real classifier → terminalizer wiring.

    Drives the genuine ``classify_promotion_tier`` (no PG, no Haiku) with the
    cold-start signal a new agent/pattern always carries (E1 in the diagnosis:
    observation_count=0 < 10 → floored to 'mention'), then runs that tier through
    ``resolve_floor_terminalization`` in the SAME order ``run_cycle`` wires them
    (daemon_cycle.py L4869/L4887). Asserts the acceptance contract directly: an
    auto-tier cold-start candidate reaches a terminal state within the cycle; a
    safety-tier candidate at the identical signal stays pending for human approval.
    """

    def _classify_cold_start(self, *, touches_frontmatter: bool) -> str:
        # Cold-start posterior (0.5 < 0.7) AND observation_count 0 < 10 → 'mention',
        # the exact floor a brand-new agent emits on first cycle (diagnosis E1).
        return dc.classify_promotion_tier(
            confidence_observed=0.5,
            observation_count=0,
            sustained=False,
            touches_frontmatter=touches_frontmatter,
        )

    def test_when_auto_cold_start_then_terminal_in_one_cycle(self) -> None:
        promotion_tier = self._classify_cold_start(touches_frontmatter=False)
        self.assertEqual(promotion_tier, "mention")  # precondition: floored
        terminalize = dc.resolve_floor_terminalization(
            classification="body-auto",
            approval_tier="auto",
            status_value="pending",
            promotion_tier=promotion_tier,
            rationale="haiku rationale",
        )
        # Auto-tier limbo is closed AT generation — no 'pending' row survives.
        self.assertTrue(terminalize.terminalized)
        self.assertEqual(terminalize.status_value, "rejected")
        self.assertNotEqual(terminalize.status_value, "pending")
        self.assertEqual(terminalize.approval_tier, "")
        # The persisted rationale flips to the below-floor reason (board reads true).
        self.assertEqual(terminalize.rationale, dc._BELOW_FLOOR_REJECT_REASON)

    def test_when_safety_cold_start_then_stays_pending(self) -> None:
        # Frontmatter-identity proposals graduate via the safety queue regardless of
        # tier; here the upstream branch has already set approval_tier='safety'. The
        # auto-only terminalize gate must not fire on it — the human queue is preserved.
        promotion_tier = self._classify_cold_start(touches_frontmatter=True)
        terminalize = dc.resolve_floor_terminalization(
            classification="body-auto",
            approval_tier="safety",
            status_value="pending",
            promotion_tier=promotion_tier,
            rationale="safety rationale",
        )
        self.assertFalse(terminalize.terminalized)
        self.assertEqual(terminalize.status_value, "pending")
        self.assertEqual(terminalize.approval_tier, "safety")

    def test_when_above_floor_auto_then_stays_apply_target(self) -> None:
        # A pattern that cleared the floor (high posterior + enough observations +
        # sustain) classifies above 'mention' and must remain an auto-apply target —
        # terminalization must NOT swallow a genuinely apply-eligible candidate.
        promotion_tier = dc.classify_promotion_tier(
            confidence_observed=0.95,
            observation_count=50,
            sustained=True,
            touches_frontmatter=False,
        )
        self.assertTrue(dc.is_apply_eligible_promotion_tier(promotion_tier))
        terminalize = dc.resolve_floor_terminalization(
            classification="body-auto",
            approval_tier="auto",
            status_value="pending",
            promotion_tier=promotion_tier,
            rationale="haiku rationale",
        )
        self.assertFalse(terminalize.terminalized)
        self.assertEqual(terminalize.status_value, "pending")
        self.assertEqual(terminalize.approval_tier, "auto")


if __name__ == "__main__":
    unittest.main(verbosity=2)
