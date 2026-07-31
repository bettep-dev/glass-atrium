"""Behavioral tests for the chronic-timeout back-off self-lock guard (R9).

The back-off's documented recovery is "a single non-timeout row breaks the
streak" — but the only actor that can produce a non-timeout row is the Haiku
call the back-off suppresses. The recovery condition names no actor that still
runs while the gate is closed, so the state is unreachable from inside itself.

Two seams carry the risk and each is pinned here rather than asserted in a
comment:

* **The recorded ceiling is recoverable.** Every timeout rationale carries the
  ceiling it was measured against, verbatim. A row recorded under a superseded
  ceiling is evidence about a regime that no longer exists and must not count
  toward a streak evaluated against the current one — the three rows holding the
  highest-overage agent were all measured at 90s while HEAD configures 180s.
* **A bounded hold admits one probe.** Back-off rows are looked past by the
  streak reader, so counting them separately is what yields "held for N cycles"
  and lets the gate open for exactly one cycle. That probe is the actor the
  recovery condition was missing.

The fail direction preserves protection: an unparseable recorded ceiling counts
as NOT superseded, so an unreadable value keeps the back-off rather than
releasing it. The anti-lockout direction is pinned separately — the probe recurs
after a failed probe, so the hold can never become permanent.

Every test here is DATABASE-FREE: the CI python leg provisions no database, and
a skip-only class reports as a pass. Fixtures are the REAL emitted rationale
strings, transcribed from the three emitters that write them.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_timeout_backoff_release.py -v
    python3 -m unittest autoagent.test.test_timeout_backoff_release -v

CID: 2026-07-31T1530_loopexec_a4f6
"""

from __future__ import annotations

import contextlib
import importlib
import io
import os
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
except Exception as exc:  # noqa: BLE001 — import failure → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


# ---------------------------------------------------------------------------
# FROZEN FIXTURES — the three real emitted rationale shapes, transcribed
# ---------------------------------------------------------------------------

_SUPERSEDED_CEILING_SEC = 90  # what the three holding rows were measured at
_CURRENT_CEILING_SEC = 180  # what HEAD and live configure


def _timeout(ceiling_sec: int) -> str:
    """The plain TimeoutExpired rationale (_invoke_haiku_cli)."""
    return f"haiku timeout after {ceiling_sec}s"


def _stall(ceiling_sec: int, escalated_sec: int = 300) -> str:
    """The escalated-retry true-stall rationale (_run_haiku_with_retry)."""
    return (
        f"haiku timeout after {ceiling_sec}s + escalated {escalated_sec}s "
        "— true stall (escalated retry also timed out)"
    )


def _exhausted(ceiling_sec: int) -> str:
    """The transient-exhaustion rationale, which preserves the timeout prefix."""
    return f"haiku timeout after {ceiling_sec}s (transient — 3 attempts exhausted)"


def _backoff(streak: int) -> str:
    """A prior back-off skip row, as TIMEOUT_BACKOFF_RATIONALE_TEMPLATE writes it."""
    return (
        f"chronic haiku-timeout back-off: {streak} consecutive timeouts on this "
        "target (threshold 3) — generation snoozed to stop burning budget; "
        "recovers on the next non-timeout generation. Resolve the candidate or "
        "raise the timeout."
    )


_OK_ROW = "consolidated 2 signal(s) for glass-atrium-dev-shell"
_QUALITY_REJECT = "pre-verify rejected: rule-scope misapplication"


@contextlib.contextmanager
def _capture_stderr():
    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        yield buf


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class RecordedCeilingTest(unittest.TestCase):
    """The ceiling a row was measured against is recoverable from its text."""

    def test_when_plain_timeout_then_ceiling_parsed(self):
        self.assertEqual(dc.get_recorded_timeout_ceiling(_timeout(90)), 90)

    def test_when_true_stall_then_base_ceiling_parsed_not_escalated(self):
        # The stall row names two numbers; the streak is evaluated against the
        # BASE ceiling, which is the one the gate configures.
        self.assertEqual(dc.get_recorded_timeout_ceiling(_stall(90, 150)), 90)

    def test_when_transient_exhaustion_then_ceiling_parsed(self):
        self.assertEqual(dc.get_recorded_timeout_ceiling(_exhausted(180)), 180)

    def test_when_no_number_then_none(self):
        self.assertIsNone(dc.get_recorded_timeout_ceiling("haiku timeout after ?s"))
        self.assertIsNone(dc.get_recorded_timeout_ceiling(""))


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class SupersededCeilingTest(unittest.TestCase):
    """A row measured against a ceiling that no longer exists is not evidence."""

    def test_when_every_row_recorded_under_superseded_ceiling_then_no_hold(self):
        # The live dev-shell shape: three 90s timeouts, ceiling now 180s.
        state = dc.build_backoff_state(
            [_timeout(_SUPERSEDED_CEILING_SEC)] * 3,
            ceiling_sec=_CURRENT_CEILING_SEC,
        )
        self.assertEqual(state.streak, 0)
        self.assertEqual(state.superseded_skipped, 3)
        self.assertLess(state.streak, dc.TIMEOUT_BACKOFF_THRESHOLD)

    def test_when_ceiling_matches_then_row_counts(self):
        state = dc.build_backoff_state(
            [_timeout(_CURRENT_CEILING_SEC)] * 3,
            ceiling_sec=_CURRENT_CEILING_SEC,
        )
        self.assertEqual(state.streak, 3)
        self.assertEqual(state.superseded_skipped, 0)

    def test_when_unparseable_ceiling_then_counts_as_not_superseded(self):
        # THE SAFE FAIL DIRECTION: an unreadable ceiling keeps the back-off.
        state = dc.build_backoff_state(
            ["haiku timeout after ?s"] * 3, ceiling_sec=_CURRENT_CEILING_SEC
        )
        self.assertEqual(state.streak, 3)
        self.assertEqual(state.superseded_skipped, 0)
        self.assertGreaterEqual(state.streak, dc.TIMEOUT_BACKOFF_THRESHOLD)

    def test_when_mixed_then_only_current_ceiling_rows_count(self):
        state = dc.build_backoff_state(
            [
                _timeout(_CURRENT_CEILING_SEC),
                _timeout(_SUPERSEDED_CEILING_SEC),
                _stall(_CURRENT_CEILING_SEC),
            ],
            ceiling_sec=_CURRENT_CEILING_SEC,
        )
        self.assertEqual(state.streak, 2)
        self.assertEqual(state.superseded_skipped, 1)


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class BoundedHoldTest(unittest.TestCase):
    """Back-off rows are counted separately, so a held-for-N figure exists."""

    def test_when_held_beyond_bound_then_one_probe_admitted(self):
        # The live dev-shell shape after the ceiling change: four consecutive
        # back-off cycles over the underlying timeout history.
        state = dc.build_backoff_state(
            [_backoff(3)] * 4 + [_timeout(_CURRENT_CEILING_SEC)] * 3,
            ceiling_sec=_CURRENT_CEILING_SEC,
        )
        self.assertEqual(state.held_cycles, 4)
        self.assertGreaterEqual(state.streak, dc.TIMEOUT_BACKOFF_THRESHOLD)
        self.assertTrue(state.probe_due)

    def test_when_held_below_bound_then_no_probe(self):
        state = dc.build_backoff_state(
            [_backoff(3)] + [_timeout(_CURRENT_CEILING_SEC)] * 3,
            ceiling_sec=_CURRENT_CEILING_SEC,
        )
        self.assertEqual(state.held_cycles, 1)
        self.assertFalse(state.probe_due)

    def test_when_fresh_streak_then_backoff_still_engages(self):
        # The guard must not disable the protection it bounds.
        state = dc.build_backoff_state(
            [_timeout(_CURRENT_CEILING_SEC)] * 3, ceiling_sec=_CURRENT_CEILING_SEC
        )
        self.assertEqual(state.held_cycles, 0)
        self.assertFalse(state.probe_due)
        self.assertGreaterEqual(state.streak, dc.TIMEOUT_BACKOFF_THRESHOLD)

    def test_when_probe_succeeded_then_streak_cleared_and_target_rearmed(self):
        state = dc.build_backoff_state(
            [_OK_ROW] + [_backoff(3)] * 4 + [_timeout(_CURRENT_CEILING_SEC)] * 3,
            ceiling_sec=_CURRENT_CEILING_SEC,
        )
        self.assertEqual(state.streak, 0)
        self.assertEqual(state.held_cycles, 0)
        self.assertFalse(state.probe_due)

    def test_when_quality_reject_then_streak_breaks(self):
        # Any genuine non-timeout adjudication still breaks the run, unchanged.
        state = dc.build_backoff_state(
            [_QUALITY_REJECT] + [_timeout(_CURRENT_CEILING_SEC)] * 3,
            ceiling_sec=_CURRENT_CEILING_SEC,
        )
        self.assertEqual(state.streak, 0)


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class NeverLockoutTest(unittest.TestCase):
    """The hold can never become permanent, however the probe turns out."""

    def test_when_probe_timed_out_then_probe_recurs_after_the_bound(self):
        bound = dc.TIMEOUT_BACKOFF_PROBE_CYCLES
        history = [_timeout(_CURRENT_CEILING_SEC)] * 3

        # Hold until the bound, probe, and have the probe time out again — then
        # keep going. The state must re-open on its own every time.
        for _ in range(3):
            for _ in range(bound):
                held = dc.build_backoff_state(
                    history, ceiling_sec=_CURRENT_CEILING_SEC
                )
                self.assertGreaterEqual(held.streak, dc.TIMEOUT_BACKOFF_THRESHOLD)
                if held.probe_due:
                    break
                history = [_backoff(held.streak)] + history
            state = dc.build_backoff_state(history, ceiling_sec=_CURRENT_CEILING_SEC)
            self.assertTrue(state.probe_due, "back-off never re-opened → lockout")
            history = [_timeout(_CURRENT_CEILING_SEC)] + history

    def test_when_probe_bound_env_is_zero_then_clamped_to_one(self):
        # A bound below 1 would probe every cycle and silently disable the
        # protection — fail-closed on an ambiguous override.
        try:
            with mock.patch.dict(
                os.environ, {dc.TIMEOUT_BACKOFF_PROBE_ENV: "0"}
            ):
                importlib.reload(dc)
                self.assertGreaterEqual(dc.TIMEOUT_BACKOFF_PROBE_CYCLES, 1)
        finally:
            importlib.reload(dc)
        self.assertEqual(dc.TIMEOUT_BACKOFF_PROBE_CYCLES, 3)

    def test_when_constant_read_by_name_then_env_override_honoured(self):
        self.assertEqual(
            dc.TIMEOUT_BACKOFF_PROBE_ENV, "AUTOAGENT_TIMEOUT_BACKOFF_PROBE_CYCLES"
        )
        try:
            with mock.patch.dict(
                os.environ, {dc.TIMEOUT_BACKOFF_PROBE_ENV: "7"}
            ):
                importlib.reload(dc)
                self.assertEqual(dc.TIMEOUT_BACKOFF_PROBE_CYCLES, 7)
        finally:
            importlib.reload(dc)
        self.assertEqual(dc.TIMEOUT_BACKOFF_PROBE_CYCLES, 3)


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class ReadSeamTest(unittest.TestCase):
    """The PG reader keeps its fail-OPEN posture — a read error never snoozes."""

    def _read(self, rows: list[tuple[str]]) -> "dc.BackoffState":
        cursor = mock.MagicMock()
        cursor.fetchall.return_value = rows
        conn = mock.MagicMock()
        conn.cursor.return_value.__enter__.return_value = cursor
        connect = mock.MagicMock()
        connect.return_value.__enter__.return_value = conn
        # create=True: _pg_connect is a CONDITIONAL import (daemon_cycle try-block
        # alias, unbound when psycopg is absent — the CI condition). The connect
        # replacement is a MagicMock that opens nothing, so patching the name into
        # existence keeps the fail-open assertions RUNNING PG-less.
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True):
            with mock.patch.object(dc, "_pg_connect", connect, create=True):
                return dc.read_backoff_state("/tmp/probe-agent.md")

    def test_when_rows_read_then_state_built_from_them(self):
        state = self._read(
            [(_backoff(3),)] * 4 + [(_timeout(dc.HAIKU_TIMEOUT_SEC),)] * 3
        )
        self.assertEqual(state.held_cycles, 4)
        self.assertEqual(state.streak, 3)
        self.assertTrue(state.probe_due)

    def test_when_read_fails_then_fail_open_zero(self):
        connect = mock.MagicMock(side_effect=RuntimeError("pg down"))
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True):
            with mock.patch.object(dc, "_pg_connect", connect, create=True):
                with _capture_stderr() as err:
                    state = dc.read_backoff_state("/tmp/probe-agent.md")
        self.assertEqual(state.streak, 0)
        self.assertEqual(state.held_cycles, 0)
        self.assertFalse(state.probe_due)
        self.assertIn("fail-open", err.getvalue())

    def test_when_pg_absent_then_zero(self):
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", False):
            state = dc.read_backoff_state("/tmp/probe-agent.md")
        self.assertEqual(state.streak, 0)

    def test_when_count_wrapper_called_then_it_reports_the_state_streak(self):
        # consecutive_timeout_count stays the run_cycle seam; the superseded-row
        # correction lands inside it rather than beside it.
        with mock.patch.object(
            dc,
            "read_backoff_state",
            return_value=dc.BackoffState(
                streak=4, held_cycles=2, superseded_skipped=1, probe_due=False
            ),
        ):
            self.assertEqual(dc.consecutive_timeout_count("/tmp/probe-agent.md"), 4)


_PROBE_AGENT = "backoff-release-probe-agent"


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class CycleSeamTest(unittest.TestCase):
    """run_cycle opens the gate for exactly the cycle the probe is due."""

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

    def _run(self, *, state: "dc.BackoffState") -> tuple["dc.PatchResult", str]:
        self.generated = False

        def _probe_generation(*args: object, **kwargs: object) -> "dc.PatchProposal":
            self.generated = True
            return dc.PatchProposal(
                target_file=str(self.target_md),
                rationale=f"haiku timeout after {dc.HAIKU_TIMEOUT_SEC}s",
                proposed_diff="",
                touched_frontmatter=False,
                estimated_added_lines=0,
                raw_response="",
                parse_mode="skipped",
            )

        with mock.patch.object(dc, "read_backoff_state", lambda _t: state):
            with mock.patch.object(
                dc, "consecutive_timeout_count", lambda _t: state.streak
            ):
                with mock.patch.object(
                    dc, "generate_consolidated_proposal", _probe_generation
                ):
                    with _capture_stderr() as err:
                        report = dc.run_cycle(
                            log_path=self.tmp_dir / "learning-log.md",
                            outcomes_dir=self.tmp_dir,
                            agents_dir=self.agents_dir,
                            skip_haiku=False,
                            skip_pre_verify=True,
                            skip_loop_emit=True,
                        )
        self.assertEqual(len(report.patches), 1)
        return report.patches[0], err.getvalue()

    def test_when_probe_due_then_generation_attempted(self):
        patch, err = self._run(
            state=dc.BackoffState(
                streak=dc.TIMEOUT_BACKOFF_THRESHOLD,
                held_cycles=dc.TIMEOUT_BACKOFF_PROBE_CYCLES,
                superseded_skipped=0,
                probe_due=True,
            )
        )
        self.assertTrue(self.generated, "probe cycle made no generation attempt")
        self.assertNotEqual(patch.haiku_status, "skipped:chronic-timeout-backoff")
        self.assertIn("probe", err)

    def test_when_probe_not_due_then_generation_still_skipped(self):
        patch, _ = self._run(
            state=dc.BackoffState(
                streak=dc.TIMEOUT_BACKOFF_THRESHOLD,
                held_cycles=1,
                superseded_skipped=0,
                probe_due=False,
            )
        )
        self.assertFalse(self.generated, "back-off cycle made a generation attempt")
        self.assertEqual(patch.haiku_status, "skipped:chronic-timeout-backoff")


if __name__ == "__main__":
    unittest.main(verbosity=2)
