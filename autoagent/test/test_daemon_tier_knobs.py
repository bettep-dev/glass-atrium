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
_TEST_DIR = Path(__file__).resolve().parent
if str(_TEST_DIR) not in sys.path:
    sys.path.insert(0, str(_TEST_DIR))

try:
    import daemon_cycle as dc
    from daemon_config import TierKnobs

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — import failure -> skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

from _pg_seal import seal_pg_reach  # noqa: E402 — test dir anchored above


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
        self.pg_reach = seal_pg_reach(self)

    def tearDown(self) -> None:
        self.assertEqual(self.pg_reach, [])

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
            (
                "unadjudicated backfill",
                ["--backfill-unadjudicated", "--reports-dir", "/nonexistent/daemon-reports"],
                "backfill_unadjudicated_proposals",
                0,
            ),
        )
        for name, argv, handler, handler_return in rows:
            with self.subTest(name), mock.patch.object(dc, handler, return_value=handler_return):
                rc, _stdout, stderr = self._run_main(argv, knob_errors)
                self.assertEqual(rc, 0, stderr)
                self.assertNotIn("FATAL", stderr)



def _cycle_report(failure_classes: tuple[str, ...], cycle_status: str) -> dc.CycleReport:
    report = dc.CycleReport(
        cycle_date="2026-10-04",
        generated_at="2026-10-04T03:00:00.000Z",
        patterns_processed=len(failure_classes),
        cost_guard={},
        cycle_status=cycle_status,
    )
    for failure_class in failure_classes:
        report.patches.append(
            dc.PatchResult(
                pattern_label=f"{failure_class} pattern",
                pattern_agent="glass-atrium-dev-python",
                pattern_frequency="5",
                target_file="/nonexistent/glass-atrium-dev-python.md",
                classification="reject",
                rationale=f"{failure_class} fixture",
                proposed_diff="",
                haiku_status="skipped:fixture",
                status="rejected",
                failure_class=failure_class,
            )
        )
    return report


@unittest.skipIf(_IMPORT_ERROR is not None, f"module import failed: {_IMPORT_ERROR}")
class MainAuthOutageExitTest(unittest.TestCase):
    """A credential outage exits its own code, over a co-occurring regression, with a CRIT line and one loop event."""

    def setUp(self) -> None:
        patcher = mock.patch.object(dc, "HAS_PAUSE_LIB", False)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.pg_reach = seal_pg_reach(self)
        # The loop-event sink is faked on purpose, after the seal.
        self.envelopes: list[dict[str, object]] = []
        patcher = mock.patch.object(dc, "_invoke_pg_helper", self._record)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        self.assertEqual(self.pg_reach, [])

    def _record(self, envelope: dict[str, object]) -> bool:
        self.envelopes.append(envelope)
        return True

    def _run_main(self, argv: list[str], report: dc.CycleReport) -> tuple[int, str]:
        self.envelopes.clear()
        stderr = io.StringIO()
        with (
            mock.patch.object(dc, "KNOB_ERRORS", {}),
            mock.patch.object(dc, "run_cycle", return_value=report),
            redirect_stdout(io.StringIO()),
            redirect_stderr(stderr),
        ):
            rc = dc._main(argv)
        return rc, stderr.getvalue()

    def _get_outage_events(self) -> list[dict[str, object]]:
        return [
            envelope["args"]
            for envelope in self.envelopes
            if envelope["args"]["eval_result"] == dc.AUTH_OUTAGE_EVAL_RESULT
        ]

    def test_an_auth_failure_alone_decides_the_outage_code_whatever_else_holds(self) -> None:
        auth, quality, quota = dc.FAILURE_CLASS_AUTH, dc.FAILURE_CLASS_QUALITY, dc.FAILURE_CLASS_QUOTA
        rows = (
            ("auth failure alone", (auth,), "ok", dc.ExitCode.AUTH_OUTAGE),
            ("auth failure beside a regression", (quality, auth), "regression", dc.ExitCode.AUTH_OUTAGE),
            ("auth failure beside a quota cap", (quota, auth), "ok", dc.ExitCode.AUTH_OUTAGE),
            ("regression without an auth failure", (quality,), "regression", dc.ExitCode.CYCLE_REGRESSION),
            ("quota cap without an auth failure", (quota,), "ok", 0),
        )
        for name, failure_classes, cycle_status, expected_rc in rows:
            with self.subTest(name):
                report = _cycle_report(failure_classes, cycle_status)
                rc, stderr = self._run_main([], report)
                is_outage = expected_rc == dc.ExitCode.AUTH_OUTAGE
                self.assertEqual(rc, expected_rc, stderr)
                self.assertEqual("CRIT: auth outage" in stderr, is_outage, stderr)
                self.assertEqual(
                    self._get_outage_events(),
                    [
                        {
                            "event_ts": report.generated_at,
                            "agent": "daemon-cycle",
                            "eval_result": dc.AUTH_OUTAGE_EVAL_RESULT,
                            "changes_added": 0,
                            "changes_removed": 0,
                            "rice": None,
                            "subject": None,
                        }
                    ]
                    if is_outage
                    else [],
                )

    def test_a_no_write_run_keeps_the_outage_code_and_line_but_emits_no_event(self) -> None:
        for argv in (["--skip-loop-emit"], ["--dry-run"]):
            with self.subTest(argv=argv):
                rc, stderr = self._run_main(argv, _cycle_report((dc.FAILURE_CLASS_AUTH,), "ok"))
                self.assertEqual(rc, dc.ExitCode.AUTH_OUTAGE, stderr)
                self.assertIn("CRIT: auth outage", stderr)
                self.assertEqual(self.envelopes, [])


@unittest.skipIf(_IMPORT_ERROR is not None, f"module import failed: {_IMPORT_ERROR}")
class ExitCodeContractTest(unittest.TestCase):
    """Each name owns one value; the reserved codes keep the numbers assigned to them."""

    def test_every_exit_code_name_owns_a_distinct_value(self) -> None:
        values = [int(member) for member in dc.ExitCode.__members__.values()]
        self.assertEqual(len(values), len(set(values)))

    def test_the_reserved_codes_keep_their_assigned_values(self) -> None:
        self.assertEqual(
            {
                "BACKFILL_PG": int(dc.ExitCode.BACKFILL_PG),
                "BACKFILL_DEFERRED": int(dc.ExitCode.BACKFILL_DEFERRED),
                "BACKFILL_LOCK_NOT_HELD": int(dc.ExitCode.BACKFILL_LOCK_NOT_HELD),
                "AUTH_OUTAGE": int(dc.ExitCode.AUTH_OUTAGE),
                "BACKFILL_RECORD_FAILED": int(dc.ExitCode.BACKFILL_RECORD_FAILED),
                "AA_START_REFUSED": int(dc.ExitCode.AA_START_REFUSED),
                "CYCLE_INSTALL_REFUSED": int(dc.ExitCode.CYCLE_INSTALL_REFUSED),
            },
            {
                "BACKFILL_PG": 7,
                "BACKFILL_DEFERRED": 10,
                "BACKFILL_LOCK_NOT_HELD": 11,
                "AUTH_OUTAGE": 12,
                "BACKFILL_RECORD_FAILED": 13,
                "AA_START_REFUSED": 14,
                "CYCLE_INSTALL_REFUSED": 15,
            },
        )


if __name__ == "__main__":
    unittest.main()
