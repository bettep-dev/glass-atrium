"""Behavioral tests for the chronic-timeout back-off error seam in run_cycle.

``run_cycle`` fills ``PatchResult.error`` from ``proposal.rationale`` whenever the
generation produced no diff — that error is what
``_pg_push_autoagent_cycle._aggregate`` reads to flip the cycle to 'partial'. The
chronic back-off branch is the ONE empty-diff path that must NOT set it: a target
whose consecutive-timeout streak reached ``TIMEOUT_BACKOFF_THRESHOLD`` is skipped
on purpose (no Haiku call at all), so surfacing it as a cycle error would flip
every subsequent cycle to 'partial' for a candidate nobody is generating.

Pinned invariants:
  (1) streak >= threshold → no Haiku call, error EMPTY,
      haiku_status='skipped:chronic-timeout-backoff', status='snoozed' — the
      rationale still rides the proposal row for observability;
  (2) streak < threshold → the fresh timeout keeps its error, so the first N
      timeouts stay visible as 'partial' (the suppression is bounded, not blanket);
  (3) parse_mode='timeout-stall' → haiku_status='skipped:timeout-stall' — the
      escalated-retry true stall stays queryable instead of collapsing into the
      generic 'skipped:empty-or-error' bucket;
  (4) parse_mode='escalated' → haiku_status='ok:escalated', apply-eligible by the
      documented `ok` prefix — slow generation is a normal apply candidate.

The cycle runs with ``skip_haiku=False`` on purpose: ``skip_haiku`` forces the
streak to 0 and would bypass the branch under test. No network is reached — the
back-off branch makes no Haiku call, and the fresh-timeout case stubs the
generator. ``skip_loop_emit=True`` blocks every PG write.

Run with either runner:
    python3 -m unittest autoagent.test.test_chronic_backoff_error_seam -v
    uv run --with pytest pytest \\
        autoagent/test/test_chronic_backoff_error_seam.py -v
"""

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

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

_PROBE_AGENT = "backoff-seam-probe-agent"


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class BackoffErrorSeam(unittest.TestCase):
    """One cycle over a single backed-off target — no PG, no Haiku, no network."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp_dir = Path(tmp.name)
        self.agents_dir = self.tmp_dir / "agents"
        self.agents_dir.mkdir()
        self.target_md = self.agents_dir / f"{_PROBE_AGENT}.md"
        self.target_md.write_text("# probe agent\n", encoding="utf-8")

        pattern = dc.Pattern(
            date="2026-07-01",
            label="probe pattern",
            frequency="9",
            agent=_PROBE_AGENT,
            status="identified",
            tier="user-pending",
            raw_line=f"pg:learning_log:1:probe pattern|{_PROBE_AGENT}",
            row_id=1,
        )
        for target, repl in (
            ("read_user_pending_patterns", lambda *a, **k: [pattern]),
            ("fetch_generation_outcomes", lambda *a, **k: []),
            # Absent flags file → confidence filter resolves 'floor', so the
            # promotion ladder never reaches for PG stats.
            ("FEATURE_FLAGS_FILE", self.tmp_dir / "no-such-flags.json"),
            # Intra-cycle spacing is a real sleep on the non-backoff branch.
            ("INTER_CALL_SPACING_SEC", 0.0),
        ):
            patcher = mock.patch.object(dc, target, repl)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _run(self, *, streak: int, proposal: "dc.PatchProposal | None") -> "dc.PatchResult":
        def _no_haiku(*args: object, **kwargs: object) -> "dc.PatchProposal":
            if proposal is None:
                raise AssertionError(
                    "generate_consolidated_proposal called on the back-off branch"
                )
            return proposal

        with mock.patch.object(dc, "consecutive_timeout_count", lambda _t: streak):
            with mock.patch.object(dc, "generate_consolidated_proposal", _no_haiku):
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
        return report.patches[0]

    def test_when_streak_at_threshold_then_error_empty(self) -> None:
        patch = self._run(streak=dc.TIMEOUT_BACKOFF_THRESHOLD, proposal=None)

        # THE PIN: an intentional bounded skip never reads as a cycle error.
        self.assertEqual(patch.error, "")
        self.assertEqual(patch.haiku_status, "skipped:chronic-timeout-backoff")
        self.assertEqual(patch.status, "snoozed")
        self.assertEqual(patch.proposed_diff, "")
        # The reason is not lost — it rides the persisted proposal row instead.
        self.assertIn("chronic haiku-timeout back-off", patch.rationale)

    def test_when_streak_above_threshold_then_error_empty(self) -> None:
        patch = self._run(streak=dc.TIMEOUT_BACKOFF_THRESHOLD + 5, proposal=None)

        self.assertEqual(patch.error, "")
        self.assertEqual(patch.haiku_status, "skipped:chronic-timeout-backoff")

    def test_when_streak_below_threshold_then_fresh_timeout_keeps_error(self) -> None:
        # Bound of the suppression: the first N timeouts still flip the cycle to
        # 'partial', so a newly-flaky target stays visible.
        rationale = f"{dc.HAIKU_TIMEOUT_RATIONALE_PREFIX} {dc.HAIKU_TIMEOUT_SEC}s"
        timeout_proposal = dc.PatchProposal(
            target_file=str(self.target_md),
            rationale=rationale,
            proposed_diff="",
            touched_frontmatter=False,
            estimated_added_lines=0,
            raw_response="",
            parse_mode="skipped",
        )
        patch = self._run(
            streak=dc.TIMEOUT_BACKOFF_THRESHOLD - 1, proposal=timeout_proposal
        )

        self.assertEqual(patch.error, rationale)
        self.assertEqual(patch.haiku_status, "skipped:empty-or-error")
        self.assertNotEqual(patch.status, "snoozed")

    def test_when_timeout_stall_proposal_then_status_timeout_stall(self) -> None:
        stall_proposal = dc.PatchProposal(
            target_file=str(self.target_md),
            rationale=(
                f"{dc.HAIKU_TIMEOUT_RATIONALE_PREFIX} {dc.HAIKU_TIMEOUT_SEC}s + "
                f"escalated {dc.HAIKU_ESCALATED_TIMEOUT_SEC}s — true stall "
                "(escalated retry also timed out)"
            ),
            proposed_diff="",
            touched_frontmatter=False,
            estimated_added_lines=0,
            raw_response="",
            parse_mode="timeout-stall",
        )
        patch = self._run(streak=0, proposal=stall_proposal)

        # THE PIN: an escalated-retry stall branches BEFORE the empty-diff
        # fallback, so it stays distinguishable from a parse-failed output.
        self.assertEqual(patch.haiku_status, "skipped:timeout-stall")

    def test_when_escalated_proposal_then_status_ok_escalated(self) -> None:
        escalated_proposal = dc.PatchProposal(
            target_file=str(self.target_md),
            rationale="probe",
            proposed_diff=(
                f"--- a/{self.target_md.name}\n"
                f"+++ b/{self.target_md.name}\n"
                "@@ -1 +1,2 @@\n"
                " # probe agent\n"
                "+probe line\n"
            ),
            touched_frontmatter=False,
            estimated_added_lines=1,
            raw_response="",
            parse_mode="escalated",
        )
        patch = self._run(streak=0, proposal=escalated_proposal)

        # A slow generation that completed is an ordinary apply candidate — the
        # distinct status is observability, not a gate.
        self.assertEqual(patch.haiku_status, "ok:escalated")
        self.assertTrue(dc.is_apply_eligible_haiku_status(patch.haiku_status))


if __name__ == "__main__":
    unittest.main(verbosity=2)
