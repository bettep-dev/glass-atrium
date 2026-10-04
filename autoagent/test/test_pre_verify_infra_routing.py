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

import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))
_TEST_DIR = Path(__file__).resolve().parent
if str(_TEST_DIR) not in sys.path:
    sys.path.insert(0, str(_TEST_DIR))

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

from _pg_seal import seal_pg_reach  # noqa: E402 — test dir anchored above

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


_ARM_PROBE_AGENT = "reject-arm-probe-agent"


def _reject_arm_rows() -> list[tuple[str, str, str]]:
    """(row name, rationale, stored status) — one row per failure class the arm meets."""
    return [
        ("skipped (non-zero exit)", "haiku non-zero exit 1", "unadjudicated"),
        ("quota", "haiku quota limit detected (usage cap)", "unadjudicated"),
        ("budget", "local --max-budget-usd ceiling too low (0.01)", "unadjudicated"),
        ("transient", "haiku transient overload (529)", "unadjudicated"),
        (
            "timeout",
            f"{dc.HAIKU_TIMEOUT_RATIONALE_PREFIX} {dc.HAIKU_TIMEOUT_SEC}s",
            "unadjudicated",
        ),
        ("supersede", dc._SUPERSEDE_REASON, "unadjudicated"),
        ("auth", "haiku auth failure (401/credential) rc=1", "unadjudicated"),
        ("parked pattern", dc._PARKED_PATTERN_REASON, "unadjudicated"),
        ("quality", _GENERATOR_RATIONALE, "rejected"),
        (
            "removal refusal",
            f"{dc.REMOVAL_REFUSAL_REASON_PREFIX}: {_GENERATOR_RATIONALE}",
            "rejected",
        ),
        (
            "oversize refusal",
            f"{dc.OVERSIZE_DIFF_REFUSAL_REASON_PREFIX}: {_GENERATOR_RATIONALE}",
            "rejected",
        ),
    ]


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestRunCycleRejectArmStatus(unittest.TestCase):
    """The reject arm stores a gate verdict as 'rejected', anything else as 'unadjudicated'.

    One cycle per row over a single target whose stubbed generation returns an
    empty diff (classify_patch_area R3 → 'reject'). skip_loop_emit=True skips only
    the cycle's gated emits — the discharge head stage and the regression-gate
    reads run regardless — so setUp seals every PG path (``seal_pg_reach``).
    """

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp_dir = Path(tmp.name)
        self.agents_dir = self.tmp_dir / "agents"
        self.agents_dir.mkdir()
        self.target_md = self.agents_dir / f"{_ARM_PROBE_AGENT}.md"
        self.target_md.write_text("# probe agent\n", encoding="utf-8")

        pattern = dc.Pattern(
            date="2026-07-01",
            label="reject arm probe pattern",
            frequency="9",
            agent=_ARM_PROBE_AGENT,
            status="identified",
            tier="user-pending",
            raw_line=f"pg:learning_log:1:reject arm probe pattern|{_ARM_PROBE_AGENT}",
            row_id=1,
        )
        for target, repl in (
            ("read_user_pending_patterns", lambda *a, **k: [pattern]),
            ("fetch_generation_outcomes", lambda *a, **k: []),
            ("INTER_CALL_SPACING_SEC", 0.0),
            ("consecutive_timeout_count", lambda _t: 0),
        ):
            patcher = mock.patch.object(dc, target, repl)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.pg_reach = seal_pg_reach(self)

    def _stored_status(self, rationale: str) -> str:
        proposal = dc.PatchProposal(
            target_file=str(self.target_md),
            rationale=rationale,
            proposed_diff="",
            touched_frontmatter=False,
            estimated_added_lines=0,
            raw_response="",
            parse_mode="skipped",
        )
        with mock.patch.object(
            dc, "generate_consolidated_proposal", lambda *a, **k: proposal
        ):
            with contextlib.redirect_stderr(io.StringIO()):
                report = dc.run_cycle(
                    log_path=self.tmp_dir / "learning-log.md",
                    outcomes_dir=self.tmp_dir,
                    agents_dir=self.agents_dir,
                    skip_haiku=False,
                    skip_pre_verify=True,
                    skip_loop_emit=True,
                )
        self.assertEqual(len(report.patches), 1)
        self.assertEqual(report.patches[0].classification, "reject")
        return report.patches[0].status

    def test_reject_arm_stores_unadjudicated_only_for_non_adjudication_classes(
        self,
    ) -> None:
        for name, rationale, expected in _reject_arm_rows():
            with self.subTest(row=name):
                self.assertEqual(self._stored_status(rationale), expected, name)

    def test_cycle_reaches_no_postgres_seam(self) -> None:
        self._stored_status(_GENERATOR_RATIONALE)
        self.assertEqual(self.pg_reach, [])

    def test_unadjudicated_rows_cover_every_non_adjudication_class(self) -> None:
        # A class added to the set without a row here would go unpinned.
        covered = {
            dc.classify_failure_rationale(rationale)
            for _, rationale, expected in _reject_arm_rows()
            if expected == "unadjudicated"
        }
        self.assertEqual(covered, set(dc._NON_ADJUDICATION_CLASSES))


if __name__ == "__main__":
    unittest.main()
