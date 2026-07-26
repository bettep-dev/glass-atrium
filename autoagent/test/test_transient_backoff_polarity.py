"""Polarity tests for the class-aware transient-retry backoff.

``_run_haiku_with_retry`` retries TWO transient classes with opposite cost shapes,
so one shared backoff cannot serve both:

  (1) overload (529 / Overloaded / connection reset, non-zero exit) — a cheap,
      fast-clearing blip → the exponential 2s ladder must stay, otherwise the
      cheap class pays a 45s wait it never needed;
  (2) timeout (TimeoutExpired) — a hard empty-output stall that already burned the
      whole ``timeout_sec`` → the wait must be the FLAT long band, otherwise the
      retry re-enters the same stall ~2s later (the measured 0%-absorption case).

Pinned invariants:
  - timeout class → two EQUAL waits at the long band (flat, never doubling);
  - overload class → the fast [2.0, 4.0] ladder, never the long band;
  - the class is re-decided PER ATTEMPT, so a mixed timeout→overload ladder keeps
    the overload attempt fast;
  - the exhausted-timeout rationale still starts with
    ``HAIKU_TIMEOUT_RATIONALE_PREFIX`` (``consecutive_timeout_count`` keys on it —
    a sleep-only change must stay chronic-snooze neutral).

Hermetic: ``_invoke_haiku_cli`` is stubbed (no CLI, no network), ``time.sleep`` is
captured instead of slept, ``random.uniform`` is pinned to 0.0, and the failure
evidence sink (reachability probe + per-call log dir) is redirected to a tmp dir.

Run with either runner:
    python3 -m unittest autoagent.test.test_transient_backoff_polarity -v
    uv run --with pytest pytest \\
        autoagent/test/test_transient_backoff_polarity.py -v
"""

from __future__ import annotations

import contextlib
import io
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

# Pinned so an env override of AUTOAGENT_TRANSIENT_TIMEOUT_BACKOFF_SEC cannot make
# the assertions drift; 30.0 is the band floor the long class must clear.
_TIMEOUT_BACKOFF_SEC = 45.0
_BAND_FLOOR_SEC = 30.0
_STALL_MS = 90_000
_OVERLOAD_MS = 1_200


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TransientBackoffPolarity(unittest.TestCase):
    """One exhausted retry ladder per transient class — no CLI, no real sleep."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp_dir = Path(tmp.name)
        self.target_md = self.tmp_dir / "backoff-polarity-probe-agent.md"
        self.target_md.write_text("# probe agent\n", encoding="utf-8")
        self.sleeps: list[float] = []

        for target, repl in (
            ("_TRANSIENT_TIMEOUT_BACKOFF_SEC", _TIMEOUT_BACKOFF_SEC),
            # Failure-evidence side effects: no outbound probe, no shared log dir.
            ("_probe_anthropic_reachable", lambda: "skipped-test"),
            ("HAIKU_FAILURE_LOG_DIR", self.tmp_dir / "haiku-failures"),
        ):
            patcher = mock.patch.object(dc, target, repl)
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
            rationale=f"{dc.HAIKU_TIMEOUT_RATIONALE_PREFIX} 90s",
            proposed_diff="",
            touched_frontmatter=False,
            estimated_added_lines=0,
            raw_response="Command timed out after 90 seconds",
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

    def _run(self, calls: list[object]) -> "dc.PatchProposal":
        """Drive the retry ladder over a scripted _invoke_haiku_cli sequence."""
        pending = list(calls)

        def _stub_invoke(**_kwargs: object) -> object:
            return pending.pop(0)

        with mock.patch.object(dc, "_invoke_haiku_cli", _stub_invoke):
            with contextlib.redirect_stderr(io.StringIO()):
                return dc._run_haiku_with_retry(
                    base_prompt="probe prompt",
                    target_file=self.target_md,
                    label_hint="probe pattern",
                    claude_bin="claude",
                    timeout_sec=90,
                )

    def test_when_timeout_transient_then_flat_long_backoff(self) -> None:
        proposal = self._run([self._timeout_call() for _ in range(3)])

        # THE PIN: a stalled call waits out the long band instead of re-entering
        # the stall, and the two waits are EQUAL (flat, never the 45→90 doubling).
        self.assertEqual(self.sleeps, [_TIMEOUT_BACKOFF_SEC, _TIMEOUT_BACKOFF_SEC])
        self.assertTrue(all(wait >= _BAND_FLOOR_SEC for wait in self.sleeps))
        self.assertEqual(proposal.parse_mode, "transient-overload")
        # Chronic-snooze neutrality: consecutive_timeout_count keys on this prefix.
        self.assertTrue(
            proposal.rationale.startswith(dc.HAIKU_TIMEOUT_RATIONALE_PREFIX)
        )
        self.assertEqual(proposal.failure_duration_ms, _STALL_MS)

    def test_when_overload_transient_then_fast_exponential_backoff(self) -> None:
        proposal = self._run([self._overload_call() for _ in range(3)])

        # THE PIN: the cheap class keeps the 2s ladder — it is never starved by
        # the long band the timeout class needs.
        self.assertEqual(
            self.sleeps,
            [dc._TRANSIENT_BACKOFF_BASE_SEC, dc._TRANSIENT_BACKOFF_BASE_SEC * 2],
        )
        self.assertLess(max(self.sleeps), _BAND_FLOOR_SEC)
        self.assertEqual(proposal.parse_mode, "transient-overload")
        self.assertIn("transient overload", proposal.rationale)

    def test_when_ladder_mixes_classes_then_backoff_follows_each_attempt(self) -> None:
        # Not sticky: the overload attempt must not inherit the timeout wait.
        self._run([self._timeout_call(), self._overload_call(), self._overload_call()])

        self.assertEqual(
            self.sleeps, [_TIMEOUT_BACKOFF_SEC, dc._TRANSIENT_BACKOFF_BASE_SEC * 2]
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
