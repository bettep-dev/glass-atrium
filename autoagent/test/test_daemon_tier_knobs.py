# Tier knobs (daemon-config.json *_effort / *_max_output_tokens) at the two daemon
# `claude -p` call sites, plus the _main gate that refuses to spend a call on a
# rejected knob. The worker call site is covered through the gap arbiter in
# test_gap_arbiter.ConfigSourceTest.
#
# Run: python3 -m unittest autoagent.test.test_daemon_tier_knobs

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
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
    from daemon_config import TierKnobs

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — import failure -> skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


_STUB = """#!/bin/sh
printf '%s\\n' "$@" >> "$KNOB_STUB_ARGV"
printf '%s|%s|%s\\n' "${CLAUDE_CODE_MAX_OUTPUT_TOKENS-<unset>}" \
  "${CLAUDE_CODE_EFFORT_LEVEL-<unset>}" "${OTEL_METRICS_EXPORTER-<unset>}" >> "$KNOB_STUB_ENV"
printf 'C1: PASS\\nC2: PASS\\nC3: PASS\\nC4: PASS\\nVERDICT: verified\\n'
exit 0
"""

_REJECTED_TIER = '"ultra" is not a valid tier (allowed: low, medium, high, xhigh, max)'


def _write_stub(dirpath: Path) -> str:
    stub = dirpath / "claude-stub"
    stub.write_text(_STUB, encoding="utf-8")
    stub.chmod(0o755)
    return str(stub)


def _patch_proposal() -> dc.PatchProposal:
    return dc.PatchProposal(
        target_file="/nonexistent/glass-atrium-dev-python.md",
        rationale="fixture",
        proposed_diff="--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n",
        touched_frontmatter=False,
        estimated_added_lines=1,
        raw_response="",
    )


def _pattern() -> dc.Pattern:
    return dc.Pattern(
        date="2026-10-01",
        label="fixture pattern",
        frequency="5",
        agent="glass-atrium-dev-python",
        status="identified",
        tier="auto",
        raw_line="",
    )


@unittest.skipIf(_IMPORT_ERROR is not None, f"module import failed: {_IMPORT_ERROR}")
class PreVerifyCallTierTest(unittest.TestCase):
    """The pre-verify call carries its own role's knobs, and only when they are set."""

    # (row name, pre_verify knobs, worker knobs, expected --effort value, expected env line)
    _ROWS = (
        ("unset knobs leave argv and env as today", ("", ""), ("", ""), None, "4321|low|none"),
        ("set knobs add the flag and the cap", ("high", "16000"), ("", ""), "high", "16000|<unset>|none"),
        ("worker knobs never reach the pre-verify call", ("", ""), ("max", "999"), None, "4321|low|none"),
    )

    def test_the_call_carries_exactly_its_roles_set_knobs(self) -> None:
        for name, pre_verify, worker, effort, env_line in self._ROWS:
            with self.subTest(name), tempfile.TemporaryDirectory() as tmp:
                tmpdir = Path(tmp)
                argv_log, env_log = tmpdir / "argv", tmpdir / "env"
                outer_env = {
                    "KNOB_STUB_ARGV": str(argv_log),
                    "KNOB_STUB_ENV": str(env_log),
                    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "4321",
                    "CLAUDE_CODE_EFFORT_LEVEL": "low",
                    "OTEL_METRICS_EXPORTER": "otlp",
                }
                knobs ={"pre_verify": TierKnobs(*pre_verify), "worker": TierKnobs(*worker)}
                with (
                    mock.patch.dict(os.environ, outer_env),
                    mock.patch.dict(dc.TIER_KNOBS, knobs),
                    mock.patch.object(dc, "_build_pre_verify_prompt", return_value="verify"),
                    redirect_stderr(io.StringIO()),
                ):
                    dc.run_pre_verify(
                        _patch_proposal(), _pattern(), claude_bin=_write_stub(tmpdir)
                    )
                argv = argv_log.read_text(encoding="utf-8").splitlines()
                env = env_log.read_text(encoding="utf-8").splitlines()
                if effort is None:
                    self.assertNotIn("--effort", argv)
                else:
                    self.assertEqual(argv[argv.index("--effort") + 1], effort)
                self.assertEqual(env, [env_line])

    def test_a_set_tier_drops_an_inherited_effort_env_var_loudly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            outer_env = {
                "KNOB_STUB_ARGV": str(tmpdir / "argv"),
                "KNOB_STUB_ENV": str(tmpdir / "env"),
                "CLAUDE_CODE_EFFORT_LEVEL": "low",
            }
            stderr = io.StringIO()
            with (
                mock.patch.dict(os.environ, outer_env),
                mock.patch.dict(dc.TIER_KNOBS, {"pre_verify": TierKnobs("high", "")}),
                mock.patch.object(dc, "_build_pre_verify_prompt", return_value="verify"),
                redirect_stderr(stderr),
            ):
                dc.run_pre_verify(_patch_proposal(), _pattern(), claude_bin=_write_stub(tmpdir))
            env = (tmpdir / "env").read_text(encoding="utf-8").splitlines()
        self.assertEqual(env[0].split("|")[1], "<unset>")
        self.assertIn("WARN", stderr.getvalue())
        self.assertIn("CLAUDE_CODE_EFFORT_LEVEL", stderr.getvalue())


@unittest.skipIf(_IMPORT_ERROR is not None, f"module import failed: {_IMPORT_ERROR}")
class MainKnobGateTest(unittest.TestCase):
    """A rejected knob stops every cycle run (dry run and skip-haiku too) and, on a pre-verify knob, the single regen; no other mode."""

    def setUp(self) -> None:
        # The LLM-spending entry points raise if reached, so a missing gate fails
        # here instead of touching the live PG database (no DSN seam).
        reached = AssertionError("an LLM-spending mode ran past the knob gate")
        for patcher in (
            mock.patch.object(dc, "HAS_PAUSE_LIB", False),
            mock.patch.object(dc, "run_cycle", side_effect=reached),
            mock.patch.object(dc, "regenerate_single_proposal", side_effect=reached),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def _run_main(self, argv: list[str], knob_errors: dict[str, str]) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            mock.patch.object(dc, "KNOB_ERRORS", knob_errors),
            mock.patch.object(sys, "stdin", io.StringIO("")),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            rc = dc._main(argv)
        return rc, stdout.getvalue(), stderr.getvalue()

    def test_cycle_mode_exits_named_with_a_fatal_line_per_rejected_knob(self) -> None:
        rows = (
            ("worker knob, plain cycle", [], "worker_effort"),
            ("worker knob, dry run", ["--dry-run"], "worker_effort"),
            ("worker knob, skip haiku", ["--skip-haiku"], "worker_effort"),
            ("pre-verify knob, plain cycle", [], "pre_verify_effort"),
        )
        for name, argv, key in rows:
            with self.subTest(name):
                rc, _stdout, stderr = self._run_main(argv, {key: _REJECTED_TIER})
                self.assertEqual(rc, dc.ExitCode.DAEMON_CONFIG_INVALID)
                fatal = [line for line in stderr.splitlines() if "FATAL" in line]
                self.assertEqual(len(fatal), 1, stderr)
                self.assertIn(key, fatal[0])
                self.assertIn('"ultra"', fatal[0])

    def test_single_regen_keeps_its_one_object_stdout_contract_when_gated(self) -> None:
        rc, stdout, stderr = self._run_main(
            ["--regenerate-stale", "--proposal-id", "4242"],
            {"pre_verify_effort": _REJECTED_TIER},
        )
        self.assertEqual(rc, dc.ExitCode.DAEMON_CONFIG_INVALID)
        payload = json.loads(stdout)
        self.assertEqual(
            {k: payload[k] for k in ("proposal_id", "action", "preverify_passed", "preverify_axes")},
            {
                "proposal_id": 4242,
                "action": "unrecoverable",
                "preverify_passed": None,
                "preverify_axes": None,
            },
        )
        self.assertIn("pre_verify_effort", payload["reason"])
        self.assertIn('"ultra"', payload["reason"])
        self.assertIn("FATAL", stderr)
        self.assertIn("pre_verify_effort", stderr)

    def test_single_regen_is_not_gated_on_a_worker_knob_it_never_spends(self) -> None:
        clean = dc.SingleRegenResult(
            proposal_id=4242,
            action="already_applied",
            preverify_passed=None,
            preverify_axes=None,
            reason="fixture",
        )
        with mock.patch.object(dc, "regenerate_single_proposal", return_value=clean):
            rc, stdout, _stderr = self._run_main(
                ["--regenerate-stale", "--proposal-id", "4242"],
                {"worker_effort": _REJECTED_TIER},
            )
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(stdout)["action"], "already_applied")

    def test_modes_without_an_llm_call_keep_their_exit_on_a_rejected_knob(self) -> None:
        knob_errors = {"worker_effort": _REJECTED_TIER, "pre_verify_effort": _REJECTED_TIER}
        rows = (
            ("parked-pattern guard", ["--parked-pattern-guard"], "_emit_parked_pattern_guard", 0),
            (
                "removal evidence",
                ["--removal-evidence", "--target", "/nonexistent/agent.md"],
                "_emit_removal_evidence",
                0,
            ),
            ("auth-mislabel backfill", ["--backfill-auth-mislabel"], "backfill_auth_mislabeled_proposals", []),
            ("stale sweep", ["--regenerate-stale"], "regenerate_stale_proposals", []),
        )
        for name, argv, handler, handler_return in rows:
            with self.subTest(name), mock.patch.object(dc, handler, return_value=handler_return):
                rc, _stdout, stderr = self._run_main(argv, knob_errors)
                self.assertEqual(rc, 0, stderr)
                self.assertNotIn("FATAL", stderr)


if __name__ == "__main__":
    unittest.main()
