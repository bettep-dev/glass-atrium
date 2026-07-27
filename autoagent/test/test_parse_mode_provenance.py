"""Behavioral tests for timeout-escalation provenance in the Haiku retry core.

Escalation ("this call ran at HAIKU_ESCALATED_TIMEOUT_SEC") and the parse path
("strict" / "fuzzy" / "retried") are ORTHOGONAL facts. Collapsing them into the
single ``parse_mode`` enum destroyed one of them in both directions:

  dir-1 — the clean-parse return overwrote parse_mode with the literal
          "escalated", so an escalated fuzzy parse was indistinguishable from an
          escalated strict parse (both surfaced as haiku_status='ok:escalated');
  dir-2 — the strict-suffix retry return hardcoded parse_mode="retried" without
          consulting the escalation state, so a retry executed at the escalated
          bound was indistinguishable from one at the normal bound.

Pinned invariants:
  (1) an escalated clean parse KEEPS its strict/fuzzy parse_mode and records the
      escalation on the orthogonal ``escalated_timeout`` flag;
  (2) a retry inherits the escalation state of the call ladder it ran on;
  (3) every composed ok-arm status keeps the 'ok' prefix the apply gate reads
      (is_apply_eligible_haiku_status), and stays inside the VARCHAR(32) column;
  (4) a NON-escalated proposal's haiku_status string is byte-identical to the
      pre-change vocabulary (forward-only, no churn for old shapes);
  (5) a non-ok base (skipped:*) never gains the escalation suffix.

No network, no PG, no Haiku: the CLI seam (_invoke_haiku_cli) is scripted and
the run_cycle row stubs the generator, mirroring the sibling back-off seam test.

Run with either runner:
    python3 -m unittest autoagent.test.test_parse_mode_provenance -v
    uv run --with pytest pytest \\
        autoagent/test/test_parse_mode_provenance.py -v
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

_PROBE_AGENT = "provenance-probe-agent"

# Canonical marker spelling → strict parse.
_STRICT_STDOUT = """RATIONALE: probe rationale
TOUCHES_FRONTMATTER: no
ADDED_LINES: 1
DIFF:
--- a/{name}
+++ b/{name}
@@ -1 +1,2 @@
 # probe agent
+probe line
"""

# Lower-cased markers → strict regex misses, fuzzy fallback recovers.
_FUZZY_STDOUT = """Rationale: probe rationale

diff:
--- a/{name}
+++ b/{name}
@@ -1 +1,2 @@
 # probe agent
+probe line
"""

# Neither strict nor fuzzy markers → parse_mode='failed' → strict-suffix retry.
_UNPARSEABLE_STDOUT = "garbled model output with no markers\n"

# haiku_status column is VARCHAR(32) — every composed form must fit.
_HAIKU_STATUS_COLUMN_WIDTH = 32


def _ok_completed(stdout: str) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=["claude"], returncode=0, stdout=stdout, stderr="")


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class EscalationProvenance(unittest.TestCase):
    """_run_haiku_with_retry provenance across the two historical loss sites."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp_dir = Path(tmp.name)
        self.target_md = self.tmp_dir / f"{_PROBE_AGENT}.md"
        self.target_md.write_text("# probe agent\n", encoding="utf-8")

        # Backoff sleeps are real seconds on the timeout ladder; parse-failure
        # logging writes JSONL. Neither belongs in a provenance unit.
        for target, repl in (
            ("_log_haiku_parse_failure", lambda **_kw: None),
        ):
            patcher = mock.patch.object(dc, target, repl)
            patcher.start()
            self.addCleanup(patcher.stop)
        sleep_patcher = mock.patch.object(dc.time, "sleep", lambda _s: None)
        sleep_patcher.start()
        self.addCleanup(sleep_patcher.stop)

    def _timeout_early_exit(self, timeout_sec: int) -> "dc.PatchProposal":
        return dc.PatchProposal(
            target_file="",
            rationale=f"{dc.HAIKU_TIMEOUT_RATIONALE_PREFIX} {timeout_sec}s",
            proposed_diff="",
            touched_frontmatter=False,
            estimated_added_lines=0,
            raw_response="TimeoutExpired",
            parse_mode="skipped",
        )

    def _run(self, script: list[str | None]) -> "dc.PatchProposal":
        """Drive the retry core over a scripted CLI ladder.

        Each element is one _invoke_haiku_cli outcome: a stdout string for a
        clean rc=0 return, or None for a timeout early-exit.
        """
        calls: list[int] = []

        def _fake_cli(
            *, prompt: str, claude_bin: str, timeout_sec: int
        ) -> tuple[subprocess.CompletedProcess[str] | None, "dc.PatchProposal | None", int]:
            outcome = script[len(calls)]
            calls.append(timeout_sec)
            if outcome is None:
                return None, self._timeout_early_exit(timeout_sec), 10
            return _ok_completed(outcome.format(name=self.target_md.name)), None, 10

        with mock.patch.object(dc, "_invoke_haiku_cli", _fake_cli):
            with contextlib.redirect_stderr(io.StringIO()):
                proposal = dc._run_haiku_with_retry(
                    base_prompt="probe prompt",
                    target_file=self.target_md,
                    label_hint="probe pattern",
                    claude_bin="claude",
                    timeout_sec=dc.HAIKU_TIMEOUT_SEC,
                )
        self.timeout_ladder = calls
        return proposal

    # -- dir-1: clean parse after escalation --------------------------------

    def test_when_escalated_call_parses_strict_then_strict_survives(self) -> None:
        proposal = self._run([None, _STRICT_STDOUT])

        # THE PIN: the parse path is NOT overwritten by the escalation fact.
        self.assertEqual(proposal.parse_mode, "strict")
        self.assertTrue(proposal.escalated_timeout)
        self.assertEqual(self.timeout_ladder[1], dc.HAIKU_ESCALATED_TIMEOUT_SEC)

    def test_when_escalated_call_parses_fuzzy_then_fuzzy_survives(self) -> None:
        proposal = self._run([None, _FUZZY_STDOUT])

        self.assertEqual(proposal.parse_mode, "fuzzy")
        self.assertTrue(proposal.escalated_timeout)
        # Escalated-fuzzy and escalated-strict were the same string before.
        self.assertNotEqual(
            dc.build_escalated_haiku_status("ok:fuzzy-parsed", escalated_timeout=True),
            dc.build_escalated_haiku_status("ok", escalated_timeout=True),
        )

    def test_when_call_parses_clean_without_escalation_then_flag_off(self) -> None:
        proposal = self._run([_STRICT_STDOUT])

        self.assertEqual(proposal.parse_mode, "strict")
        self.assertFalse(proposal.escalated_timeout)

    # -- dir-2: strict-suffix retry -----------------------------------------

    def test_when_retry_runs_at_escalated_bound_then_escalation_recorded(self) -> None:
        proposal = self._run([None, _UNPARSEABLE_STDOUT, _STRICT_STDOUT])

        self.assertEqual(proposal.parse_mode, "retried")
        # THE PIN: the retry inherits the ladder's escalation state.
        self.assertTrue(proposal.escalated_timeout)
        self.assertEqual(self.timeout_ladder[2], dc.HAIKU_ESCALATED_TIMEOUT_SEC)

    def test_when_retry_runs_at_normal_bound_then_no_escalation(self) -> None:
        proposal = self._run([_UNPARSEABLE_STDOUT, _STRICT_STDOUT])

        self.assertEqual(proposal.parse_mode, "retried")
        self.assertFalse(proposal.escalated_timeout)
        self.assertEqual(self.timeout_ladder[1], dc.HAIKU_TIMEOUT_SEC)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class EscalatedStatusComposition(unittest.TestCase):
    """The ok-arm status vocabulary: composition, prefix invariant, no churn."""

    _OK_BASES = ("ok", "ok:fuzzy-parsed", "ok:retried", "ok:escalated")

    def test_when_escalated_then_every_ok_form_stays_apply_eligible(self) -> None:
        for base in self._OK_BASES:
            with self.subTest(base=base):
                composed = dc.build_escalated_haiku_status(base, escalated_timeout=True)
                self.assertTrue(dc.is_apply_eligible_haiku_status(composed))
                self.assertLessEqual(len(composed), _HAIKU_STATUS_COLUMN_WIDTH)

    def test_when_not_escalated_then_status_strings_unchanged(self) -> None:
        for base in self._OK_BASES:
            with self.subTest(base=base):
                self.assertEqual(
                    dc.build_escalated_haiku_status(base, escalated_timeout=False), base
                )

    def test_when_base_not_ok_then_suffix_withheld(self) -> None:
        # A skipped:* row is not an ok-arm status — escalation must not decorate
        # it into something the 'ok' prefix gate would then accept.
        for base in ("skipped:timeout-stall", "skipped:empty-or-error", "error:x"):
            with self.subTest(base=base):
                composed = dc.build_escalated_haiku_status(base, escalated_timeout=True)
                self.assertEqual(composed, base)
                self.assertFalse(dc.is_apply_eligible_haiku_status(composed))

    def test_when_base_already_escalated_then_suffix_not_doubled(self) -> None:
        self.assertEqual(
            dc.build_escalated_haiku_status("ok:escalated", escalated_timeout=True),
            "ok:escalated",
        )


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class CycleStatusDerivation(unittest.TestCase):
    """One cycle over a single target — the derivation switch end to end."""

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
            ("FEATURE_FLAGS_FILE", self.tmp_dir / "no-such-flags.json"),
            ("INTER_CALL_SPACING_SEC", 0.0),
        ):
            patcher = mock.patch.object(dc, target, repl)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _run(self, proposal: "dc.PatchProposal") -> "dc.PatchResult":
        with mock.patch.object(dc, "consecutive_timeout_count", lambda _t: 0):
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
        return report.patches[0]

    def _proposal(self, *, parse_mode: str, **extra: object) -> "dc.PatchProposal":
        return dc.PatchProposal(
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
            parse_mode=parse_mode,
            **extra,  # type: ignore[arg-type]
        )

    def test_when_escalated_fuzzy_then_status_carries_both_axes(self) -> None:
        patch = self._run(self._proposal(parse_mode="fuzzy", escalated_timeout=True))

        self.assertEqual(patch.haiku_status, "ok:fuzzy-parsed:escalated")
        self.assertTrue(dc.is_apply_eligible_haiku_status(patch.haiku_status))

    def test_when_escalated_retried_then_status_carries_both_axes(self) -> None:
        patch = self._run(self._proposal(parse_mode="retried", escalated_timeout=True))

        self.assertEqual(patch.haiku_status, "ok:retried:escalated")

    def test_when_plain_fuzzy_then_status_unchanged(self) -> None:
        patch = self._run(self._proposal(parse_mode="fuzzy"))

        self.assertEqual(patch.haiku_status, "ok:fuzzy-parsed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
