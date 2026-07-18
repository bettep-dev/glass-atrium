#!/usr/bin/env python3
# DF-6 regression: a pre-verify INFRA failure (verifier timeout / CLI-missing /
# non-zero exit) must NOT be recorded as a terminal quality reject. Recording it
# as 'rejected' carries the GENERATOR rationale, which classify_failure_rationale
# reads as a quality verdict → the consecutive_reject kill streak advances on an
# infra OUTAGE, fossilizing healthy agents. The fix routes infra failures to
# 'pending' (re-verified next cycle); only a genuine verifier verdict rejects.
#
# AC (plan DF-6): a simulated timeout leaves the row pending; reject streak
# unchanged. Interacts with the quota classifier (_pg_push_autoagent_cycle
# ._aggregate) — that path is independent and kept intact.
#
# Run: python3 -m unittest autoagent.test.test_pre_verify_infra_routing
#   (or, from autoagent/test/) python3 -m unittest test_pre_verify_infra_routing

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

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

_LABEL = "quality-reject-candidate"
# A GENERATOR rationale — the candidate generated cleanly; only the verifier
# failed. classify_failure_rationale reads this as a genuine QUALITY reject
# (default-to-advance), which is exactly why an infra failure recorded as
# 'rejected' would wrongly advance the streak.
_GENERATOR_RATIONALE = "tightened the delegation-size discipline wording"


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestIsInfraPreVerifyStatus(unittest.TestCase):
    def test_when_timeout_then_infra(self) -> None:
        self.assertTrue(dc.is_infra_pre_verify_status("error:timeout-90s"))

    def test_when_cli_not_found_then_infra(self) -> None:
        self.assertTrue(dc.is_infra_pre_verify_status("error:cli-not-found"))

    def test_when_non_zero_exit_then_infra(self) -> None:
        self.assertTrue(dc.is_infra_pre_verify_status("error:exit-137"))

    def test_when_ok_then_not_infra(self) -> None:
        self.assertFalse(dc.is_infra_pre_verify_status("ok"))

    def test_when_skipped_then_not_infra(self) -> None:
        # skipped:* is a normal skip (flag / empty-diff), NOT an infra outage.
        self.assertFalse(dc.is_infra_pre_verify_status("skipped:flag"))


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestRouteFailedPreVerify(unittest.TestCase):
    def test_when_infra_timeout_then_pending_not_reject(self) -> None:
        classification, approval_tier, status = dc.route_failed_pre_verify(
            "body-auto", "error:timeout-90s"
        )
        self.assertEqual(status, "pending")
        self.assertNotEqual(classification, "reject")
        self.assertEqual(classification, "body-auto")
        # approval_tier '' + pre_verify_passed=False keep it off the auto-apply SELECT.
        self.assertEqual(approval_tier, "")

    def test_when_infra_exit_then_pending(self) -> None:
        _, _, status = dc.route_failed_pre_verify("body-auto", "error:exit-1")
        self.assertEqual(status, "pending")

    def test_when_genuine_quality_verdict_then_reject(self) -> None:
        # Verifier ran (status='ok') but refused → genuine quality reject.
        classification, approval_tier, status = dc.route_failed_pre_verify(
            "body-auto", "ok"
        )
        self.assertEqual(classification, "reject")
        self.assertEqual(status, "rejected")
        self.assertEqual(approval_tier, "")


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestInfraFailureLeavesStreakUnchanged(unittest.TestCase):
    """End-to-end AC: a simulated timeout leaves the row pending; streak unchanged."""

    def test_when_simulated_timeout_then_pending_row_looked_past(self) -> None:
        # The routing outcome of an infra timeout.
        _, _, status = dc.route_failed_pre_verify("body-auto", "error:timeout-90s")
        self.assertEqual(status, "pending")

        # The persisted row for that outcome (status, label, generator rationale).
        # A pending row is looked past → the streak stays at the count of the two
        # prior GENUINE rejects only; the infra outage does NOT advance it.
        rows = [
            (status, _LABEL, _GENERATOR_RATIONALE),  # the infra-outage row
            ("rejected", _LABEL, _GENERATOR_RATIONALE),
            ("rejected", _LABEL, _GENERATOR_RATIONALE),
        ]
        self.assertEqual(dc.consecutive_reject_count(_LABEL, rows), 2)

    def test_regression_would_advance_if_recorded_as_reject(self) -> None:
        # Contrast (the DF-6 bug shape): had the infra outage been recorded as
        # 'rejected' with the generator rationale, the streak would count all 3 —
        # this pins WHY routing to pending matters.
        rows = [
            ("rejected", _LABEL, _GENERATOR_RATIONALE),
            ("rejected", _LABEL, _GENERATOR_RATIONALE),
            ("rejected", _LABEL, _GENERATOR_RATIONALE),
        ]
        self.assertEqual(dc.consecutive_reject_count(_LABEL, rows), 3)


if __name__ == "__main__":
    unittest.main()
