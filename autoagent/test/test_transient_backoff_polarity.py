"""Polarity tests for the class-aware transient retry ladder + call duration.

``_run_haiku_with_retry`` retries TWO transient classes with opposite cost shapes,
so one shared retry shape cannot serve both:

  (1) overload (529 / Overloaded / connection reset, non-zero exit) — a cheap,
      fast-clearing blip → 3 attempts on the exponential 2s ladder, all at the
      base timeout, otherwise the cheap class pays a 45s wait it never needed;
  (2) timeout (TimeoutExpired) — a hard empty-output stall that already burned the
      whole base ``timeout_sec`` → ONE flat long wait and then a single ESCALATED
      attempt at the longer bound, which doubles as the in-cycle discriminator
      between slow generation and a true stall.

Pinned invariants:
  - timeout class → exactly 2 calls (base bound, then the escalated bound) with
    ONE flat wait at the long band, never a third identical attempt;
  - a timeout that survives the escalated bound records ``parse_mode='timeout-stall'``
    (true stall) with the timeout rationale prefix intact;
  - a timeout that COMPLETES on the escalated bound records
    ``parse_mode='escalated'`` plus that call's ``generation_duration_ms``;
  - escalation is MONOTONIC — a mixed timeout → overload tail stays escalated;
  - a timeout landing at the retry-budget edge (never escalated) keeps the
    ``HAIKU_TIMEOUT_RATIONALE_PREFIX`` rationale so ``consecutive_timeout_count``
    still counts the row;
  - overload class → the fast [2.0, 4.0] ladder at the base bound, never escalated;
  - a non-transient class (auth/401) makes exactly one call and never escalates;
  - a SUCCESSFUL call records ``generation_duration_ms`` on both happy paths
    (attempt-1 strict/fuzzy and the attempt-2 'retried' reconstruction), while a
    failure proposal leaves it None;
  - the base/escalated bounds are env-overridable, and an escalated bound BELOW
    the base is clamped loudly instead of silently de-escalating the retry.

Hermetic: ``_invoke_haiku_cli`` is stubbed (no CLI, no network) and records its
kwargs so every ``timeout_sec`` hand-off is assertable, ``time.sleep`` is captured
instead of slept, ``random.uniform`` is pinned to 0.0, and the failure evidence
sink (reachability probe + per-call log dir) is redirected to a tmp dir.
``_parse_haiku_response`` is stubbed on the success paths so the pin isolates the
duration attachment rather than re-testing the parser + diff normalization.

Run with either runner:
    python3 -m unittest autoagent.test.test_transient_backoff_polarity -v
    uv run --with pytest pytest \\
        autoagent/test/test_transient_backoff_polarity.py -v
"""

from __future__ import annotations

import contextlib
import importlib
import io
import os
import subprocess
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

# Pinned so an env override of the timeout/backoff vars cannot make the
# assertions drift; 30.0 is the band floor the long class must clear.
_TIMEOUT_BACKOFF_SEC = 45.0
_BAND_FLOOR_SEC = 30.0
_BASE_TIMEOUT_SEC = 180
_ESCALATED_TIMEOUT_SEC = 300
_STALL_MS = _BASE_TIMEOUT_SEC * 1000
_OVERLOAD_MS = 1_200
_AUTH_STDERR = "API Error: 401 Invalid authentication credentials"

_ENV_BASE = "AUTOAGENT_HAIKU_TIMEOUT_SEC"
_ENV_ESCALATED = "AUTOAGENT_HAIKU_ESCALATED_TIMEOUT_SEC"


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TransientBackoffPolarity(unittest.TestCase):
    """One retry ladder per transient class — no CLI, no real sleep."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp_dir = Path(tmp.name)
        self.target_md = self.tmp_dir / "backoff-polarity-probe-agent.md"
        self.target_md.write_text("# probe agent\n", encoding="utf-8")
        self.sleeps: list[float] = []
        self.invocations: list[dict[str, object]] = []

        for target, repl, create in (
            ("_TRANSIENT_TIMEOUT_BACKOFF_SEC", _TIMEOUT_BACKOFF_SEC, False),
            ("HAIKU_TIMEOUT_SEC", _BASE_TIMEOUT_SEC, False),
            # create=True so the pre-implementation HEAD run reports the behavior
            # gap, not an AttributeError in setUp; the env cases below assert the
            # constant genuinely exists.
            ("HAIKU_ESCALATED_TIMEOUT_SEC", _ESCALATED_TIMEOUT_SEC, True),
            # Failure-evidence side effects: no outbound probe, no shared log dir.
            ("_probe_anthropic_reachable", lambda: "skipped-test", False),
            ("HAIKU_FAILURE_LOG_DIR", self.tmp_dir / "haiku-failures", False),
        ):
            patcher = mock.patch.object(dc, target, repl, create=create)
            patcher.start()
            self.addCleanup(patcher.stop)

        for module, attr, repl in (
            (dc.time, "sleep", self.sleeps.append),
            (dc.random, "uniform", lambda _lo, _hi: 0.0),
        ):
            patcher = mock.patch.object(module, attr, repl)
            patcher.start()
            self.addCleanup(patcher.stop)

    @staticmethod
    def _timeout_call() -> tuple[None, "dc.PatchProposal", int]:
        return None, dc.PatchProposal(
            target_file="",
            rationale=f"{dc.HAIKU_TIMEOUT_RATIONALE_PREFIX} {_BASE_TIMEOUT_SEC}s",
            proposed_diff="",
            touched_frontmatter=False,
            estimated_added_lines=0,
            raw_response=f"Command timed out after {_BASE_TIMEOUT_SEC} seconds",
            parse_mode="skipped",
        ), _STALL_MS

    @staticmethod
    def _overload_call() -> tuple[subprocess.CompletedProcess[str], None, int]:
        return subprocess.CompletedProcess(
            args=["claude"],
            returncode=1,
            stdout="",
            stderr="API Error: 529 Overloaded",
        ), None, _OVERLOAD_MS

    @staticmethod
    def _auth_call() -> tuple[subprocess.CompletedProcess[str], None, int]:
        return subprocess.CompletedProcess(
            args=["claude"],
            returncode=1,
            stdout="",
            stderr=_AUTH_STDERR,
        ), None, _OVERLOAD_MS

    @staticmethod
    def _ok_call(duration_ms: int) -> tuple[subprocess.CompletedProcess[str], None, int]:
        return subprocess.CompletedProcess(
            args=["claude"],
            returncode=0,
            stdout="RATIONALE: probe\nDIFF:\n--- a/x\n+++ b/x\n",
            stderr="",
        ), None, duration_ms

    def _run(self, calls: list[object]) -> "dc.PatchProposal":
        """Drive the retry ladder over a scripted _invoke_haiku_cli sequence.

        The script is exact-length on purpose — an unexpected extra attempt pops
        an empty list and fails loudly instead of passing silently.
        """
        pending = list(calls)

        def _stub_invoke(**kwargs: object) -> object:
            self.invocations.append(kwargs)
            return pending.pop(0)

        with mock.patch.object(dc, "_invoke_haiku_cli", _stub_invoke):
            with contextlib.redirect_stderr(io.StringIO()):
                return dc._run_haiku_with_retry(
                    base_prompt="probe prompt",
                    target_file=self.target_md,
                    label_hint="probe pattern",
                    claude_bin="claude",
                    timeout_sec=_BASE_TIMEOUT_SEC,
                )

    def test_when_timeout_class_then_second_attempt_escalates_once(self) -> None:
        self._run([self._timeout_call() for _ in range(2)])

        # THE PIN: a stalled call is retried ONCE at the longer bound, not twice
        # more at the identical bound that just proved deterministically fatal.
        self.assertEqual(len(self.invocations), 2)
        self.assertEqual(self.invocations[0]["timeout_sec"], _BASE_TIMEOUT_SEC)
        self.assertEqual(self.invocations[1]["timeout_sec"], _ESCALATED_TIMEOUT_SEC)
        self.assertEqual(self.sleeps, [_TIMEOUT_BACKOFF_SEC])
        self.assertTrue(all(wait >= _BAND_FLOOR_SEC for wait in self.sleeps))

    def test_when_escalated_attempt_also_times_out_then_true_stall_recorded(self) -> None:
        proposal = self._run([self._timeout_call() for _ in range(2)])

        # THE PIN: the escalated bound is the discriminator — surviving it means a
        # TRUE stall, recorded distinctly from a slow generation that completed.
        self.assertEqual(proposal.parse_mode, "timeout-stall")
        self.assertIn("true stall", proposal.rationale)
        self.assertIn(str(_ESCALATED_TIMEOUT_SEC), proposal.rationale)
        # Chronic-snooze neutrality: consecutive_timeout_count keys on this prefix.
        self.assertTrue(
            proposal.rationale.startswith(dc.HAIKU_TIMEOUT_RATIONALE_PREFIX)
        )
        self.assertEqual(
            dc.classify_failure_rationale(proposal.rationale),
            dc.FAILURE_CLASS_TIMEOUT,
        )
        # A failure row never claims a successful-call duration.
        self.assertIsNone(proposal.generation_duration_ms)
        self.assertEqual(proposal.failure_duration_ms, _STALL_MS)

    def test_when_escalated_attempt_succeeds_then_escalated_mode_and_duration(self) -> None:
        parsed = dc.PatchProposal(
            target_file=str(self.target_md),
            rationale="probe",
            proposed_diff="--- a/x\n+++ b/x\n",
            touched_frontmatter=False,
            estimated_added_lines=1,
            raw_response="",
            parse_mode="strict",
        )
        with mock.patch.object(dc, "_parse_haiku_response", lambda *_a: parsed):
            proposal = self._run([self._timeout_call(), self._ok_call(150_000)])

        # THE PIN: slow generation is a SUCCESS, surfaced distinctly from a plain
        # attempt-1 success so tonight's payload separates it from a true stall.
        self.assertEqual(proposal.parse_mode, "escalated")
        self.assertEqual(proposal.generation_duration_ms, 150_000)
        self.assertEqual(self.sleeps, [_TIMEOUT_BACKOFF_SEC])
        self.assertEqual(self.invocations[1]["timeout_sec"], _ESCALATED_TIMEOUT_SEC)

    def test_when_timeout_then_overload_then_escalation_is_monotonic(self) -> None:
        proposal = self._run(
            [self._timeout_call(), self._overload_call(), self._overload_call()]
        )

        # THE PIN: escalation is per-CALL monotonic, the backoff is per-ATTEMPT
        # class-decided — a slow backend keeps the longer bound on the overload
        # tail while that tail still waits on the cheap ladder.
        self.assertEqual(
            self.sleeps, [_TIMEOUT_BACKOFF_SEC, dc._TRANSIENT_BACKOFF_BASE_SEC * 2]
        )
        self.assertEqual(self.invocations[1]["timeout_sec"], _ESCALATED_TIMEOUT_SEC)
        self.assertEqual(self.invocations[2]["timeout_sec"], _ESCALATED_TIMEOUT_SEC)
        self.assertEqual(proposal.parse_mode, "transient-overload")

    def test_when_timeout_at_budget_edge_then_timeout_prefix_preserved(self) -> None:
        proposal = self._run(
            [self._overload_call(), self._overload_call(), self._timeout_call()]
        )

        # THE PIN: a timeout arriving with no escalation left keeps the timeout
        # rationale prefix — stamping the overload rationale here would silently
        # stop consecutive_timeout_count from counting the row.
        self.assertEqual(proposal.parse_mode, "transient-overload")
        self.assertTrue(
            proposal.rationale.startswith(dc.HAIKU_TIMEOUT_RATIONALE_PREFIX)
        )
        self.assertEqual(
            dc.classify_failure_rationale(proposal.rationale),
            dc.FAILURE_CLASS_TIMEOUT,
        )
        self.assertTrue(
            all(call["timeout_sec"] == _BASE_TIMEOUT_SEC for call in self.invocations)
        )

    def test_when_overload_transient_then_fast_exponential_backoff(self) -> None:
        proposal = self._run([self._overload_call() for _ in range(3)])

        # THE PIN: the cheap class keeps the 2s ladder at the base bound — it is
        # never starved by the long band, nor escalated by the timeout class.
        self.assertEqual(
            self.sleeps,
            [dc._TRANSIENT_BACKOFF_BASE_SEC, dc._TRANSIENT_BACKOFF_BASE_SEC * 2],
        )
        self.assertLess(max(self.sleeps), _BAND_FLOOR_SEC)
        self.assertEqual(proposal.parse_mode, "transient-overload")
        self.assertIn("transient overload", proposal.rationale)
        self.assertTrue(
            all(call["timeout_sec"] == _BASE_TIMEOUT_SEC for call in self.invocations)
        )

    def test_when_auth_failure_then_single_attempt_no_escalation(self) -> None:
        proposal = self._run([self._auth_call()])

        # A non-transient class never enters the ladder, so it can never escalate.
        self.assertEqual(len(self.invocations), 1)
        self.assertEqual(proposal.parse_mode, "auth-failure")
        self.assertEqual(self.sleeps, [])

    def test_when_call_succeeds_then_generation_duration_recorded(self) -> None:
        parsed = dc.PatchProposal(
            target_file=str(self.target_md),
            rationale="probe",
            proposed_diff="--- a/x\n+++ b/x\n",
            touched_frontmatter=False,
            estimated_added_lines=1,
            raw_response="",
            parse_mode="strict",
        )
        with mock.patch.object(dc, "_parse_haiku_response", lambda *_a: parsed):
            proposal = self._run([self._ok_call(31_400)])

        # THE PIN: a healthy call's wall clock survives onto the proposal, so
        # budget tightness is measurable without waiting for a failure row, and
        # an un-escalated success keeps its plain parse_mode.
        self.assertEqual(proposal.generation_duration_ms, 31_400)
        self.assertEqual(proposal.parse_mode, "strict")
        self.assertEqual(self.sleeps, [])

    def test_when_strict_retry_succeeds_then_retry_duration_recorded(self) -> None:
        failed = dc.PatchProposal(
            target_file=str(self.target_md),
            rationale="",
            proposed_diff="",
            touched_frontmatter=False,
            estimated_added_lines=0,
            raw_response="no markers",
            parse_mode="failed",
        )
        retried = dc.PatchProposal(
            target_file=str(self.target_md),
            rationale="probe",
            proposed_diff="--- a/x\n+++ b/x\n",
            touched_frontmatter=False,
            estimated_added_lines=1,
            raw_response="",
            parse_mode="strict",
        )
        parses = [failed, retried]
        with mock.patch.object(
            dc, "_parse_haiku_response", lambda *_a: parses.pop(0)
        ):
            proposal = self._run([self._ok_call(11_000), self._ok_call(22_000)])

        # The 'retried' reconstruction must carry the RETRY call's duration, not
        # the discarded first-attempt one.
        self.assertEqual(proposal.parse_mode, "retried")
        self.assertEqual(proposal.generation_duration_ms, 22_000)

    def test_when_strict_retry_follows_escalated_call_then_retry_inherits_escalated_timeout(
        self,
    ) -> None:
        failed = dc.PatchProposal(
            target_file=str(self.target_md),
            rationale="",
            proposed_diff="",
            touched_frontmatter=False,
            estimated_added_lines=0,
            raw_response="no markers",
            parse_mode="failed",
        )
        retried = dc.PatchProposal(
            target_file=str(self.target_md),
            rationale="probe",
            proposed_diff="--- a/x\n+++ b/x\n",
            touched_frontmatter=False,
            estimated_added_lines=1,
            raw_response="",
            parse_mode="strict",
        )
        parses = [failed, retried]
        with mock.patch.object(
            dc, "_parse_haiku_response", lambda *_a: parses.pop(0)
        ):
            proposal = self._run(
                [self._timeout_call(), self._ok_call(150_000), self._ok_call(160_000)]
            )

        # A backend slow enough to escalate must not drop back to the base bound
        # for the parse-recovery retry. 'retried' stays the parse-recovery marker
        # — the escalation stays visible via generation_duration_ms.
        self.assertEqual(self.invocations[2]["timeout_sec"], _ESCALATED_TIMEOUT_SEC)
        self.assertEqual(proposal.parse_mode, "retried")
        self.assertEqual(proposal.generation_duration_ms, 160_000)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TimeoutConstantEnvOverride(unittest.TestCase):
    """Module-level env parse + the escalated-below-base loud clamp."""

    def setUp(self) -> None:
        # The constants are env-parsed at import, so each case reloads the module;
        # the cleanup reload restores defaults so sibling modules sharing this
        # process never observe a mutated `dc`.
        self.addCleanup(self._reload_defaults)

    @staticmethod
    def _reload_defaults() -> None:
        stripped = {
            key: value
            for key, value in os.environ.items()
            if key not in (_ENV_BASE, _ENV_ESCALATED)
        }
        with mock.patch.dict(os.environ, stripped, clear=True):
            importlib.reload(dc)

    def test_when_env_overrides_set_then_timeout_constants_follow(self) -> None:
        with mock.patch.dict(os.environ, {_ENV_BASE: "240", _ENV_ESCALATED: "420"}):
            importlib.reload(dc)

        # Same operator escape hatch the backoff/threshold vars already offer.
        self.assertEqual(dc.HAIKU_TIMEOUT_SEC, 240)
        self.assertEqual(dc.HAIKU_ESCALATED_TIMEOUT_SEC, 420)

    def test_when_escalated_below_base_then_clamped_with_warning(self) -> None:
        buf = io.StringIO()
        with mock.patch.dict(os.environ, {_ENV_BASE: "200", _ENV_ESCALATED: "100"}):
            with contextlib.redirect_stderr(buf):
                importlib.reload(dc)

        # A bound below the base would DE-escalate the retry — clamped loudly
        # (Precondition Loud-Fail: named + observable) rather than absorbed.
        self.assertEqual(dc.HAIKU_ESCALATED_TIMEOUT_SEC, 200)
        message = buf.getvalue()
        self.assertIn("WARN", message)
        self.assertIn("100", message)
        self.assertIn("200", message)


if __name__ == "__main__":
    unittest.main(verbosity=2)
