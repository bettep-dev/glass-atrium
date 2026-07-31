"""Behavioral tests for the post-apply regression gate (R5).

The regression detector already fires and already runs; its verdict terminated in
a log line with no consumer. R5 is that consumer: a pattern covered by a proposal
carrying a LIVE regression warning may not re-fire for that agent while the
warning is live.

Three properties carry the risk and each is pinned here rather than asserted in a
comment:

* **Liveness is bounded by its OWN constant.** 14 days, from its own environment
  override — never the 90-day outcome-history lookback, which is a data-read
  horizon and would retroactively block the top driving agents for eleven weeks.
* **The fail direction is split.** An indeterminate verdict (read failed or
  unparseable) blocks every candidate for that ONE cycle; a cleanly absent
  verdict admits. Conflating them halts the loop, since absence is the normal
  state for most rows.
* **Blocking is per pattern row, never per agent.** The anti-lockout criterion
  runs on a real two-constituent consolidation and asserts exactly one of its two
  covered patterns is blocked.

Every test here is DATABASE-FREE: the CI python leg provisions no database, and a
skip-only class reports as a pass. Fixtures are the REAL stored strings frozen in
the sibling discharge test, transcribed again here so this file stands alone.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_regression_gate.py -v
    python3 -m unittest autoagent.test.test_regression_gate -v

CID: 2026-07-31T1530_loopexec_a4f6
"""

from __future__ import annotations

import contextlib
import importlib
import io
import os
import sys
import unittest
from datetime import date, datetime, timedelta, timezone
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
# FROZEN FIXTURES — real stored strings, transcribed verbatim
# ---------------------------------------------------------------------------

_FAIL_CORE = "repeated failure by same agent"
_BUDGET_CORE = "budget-overage concentration"
_RATE_CORE_BARE = "agent instruction-improvement candidate (failure rate)"
_RATE_CORE_SPACED = "agent instruction-improvement candidate (failure rate )"

_SHELL = "glass-atrium-dev-shell"
_REACT = "glass-atrium-dev-react"


def _row(row_id: int, agent: str, label: str) -> dict:
    return {
        "id": row_id,
        "agent": agent,
        "pattern_signature": f"{label}|{agent}",
        "frequency": 1,
        "discovered_date": date(2026, 7, 1),
        "status": "identified",
        "approval_tier": "user-pending",
    }


STORED_ROWS: tuple[dict, ...] = (
    _row(10, _SHELL, _BUDGET_CORE),
    _row(2, _SHELL, _FAIL_CORE),
    _row(430, _SHELL, _RATE_CORE_BARE),
    _row(7, _REACT, _BUDGET_CORE),
    _row(1, _REACT, _FAIL_CORE),
    _row(5, _REACT, _RATE_CORE_SPACED),
)

# Real stored core.autoagent_proposals.pattern_label strings, verbatim.
LABEL_SHELL_2_REVERSED = (
    "glass-atrium-dev-shell multi-signal consolidation (recurring "
    "negative-signal concentration / budget-overage concentration)"
)
LABEL_REACT_3 = (
    "glass-atrium-dev-react multi-signal consolidation (budget-overage "
    "concentration / recurring negative-signal concentration / agent "
    "instruction-improvement candidate (failure rate ))"
)
# Solo proposal label — stored as the bare label, no join.
LABEL_SOLO_BUDGET = _BUDGET_CORE

_NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)


def _ts(days_ago: float) -> datetime:
    return _NOW - timedelta(days=days_ago)


def _index() -> dict:
    """Per-agent row index built from the frozen rows, PG untouched."""
    # Two-part PG-less pattern (mirrors test_pg_pattern_intake): flip the
    # HAS_PG_PATTERN_READ gate — get_pattern_rows_by_agent returns None without it
    # — AND patch the reader with create=True, since _pg_read_pending_patterns is a
    # CONDITIONAL import (daemon_cycle try-block alias, unbound when psycopg is
    # absent, the CI condition). The replacement opens no cursor, so this keeps the
    # tests RUNNING PG-less rather than skipping.
    with mock.patch.object(dc, "HAS_PG_PATTERN_READ", True), mock.patch.object(
        dc, "_pg_read_pending_patterns", return_value=list(STORED_ROWS), create=True
    ):
        return dc.get_pattern_rows_by_agent()


def _pattern(row_id: int, agent: str, label: str) -> "dc.Pattern":
    return dc.Pattern(
        date="2026-07-01",
        label=label,
        frequency="12",
        agent=agent,
        status="identified",
        tier="user-pending",
        raw_line="",
        row_id=row_id,
    )


def _applied(proposal_id: int, agent: str, label: str, applied_ts: datetime,
             status: str = "applied") -> tuple:
    """One core.autoagent_proposals row in the gate's projection order."""
    return (proposal_id, agent, applied_ts, label, status)


@contextlib.contextmanager
def _capture_stderr():
    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        yield buf


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class LivenessWindowTest(unittest.TestCase):
    """The window is a dedicated constant, not the outcome-history lookback."""

    def test_when_constant_read_by_name_then_defaults_to_14_days(self):
        self.assertEqual(dc.REGRESSION_LIVENESS_ENV, "AUTOAGENT_REGRESSION_LIVENESS_DAYS")
        self.assertEqual(dc.REGRESSION_LIVENESS_DAYS, 14)
        # The 90-day outcome lookback is a DATA-READ horizon and is explicitly
        # not what bounds this gate — reusing it would retroactively block every
        # standing warning (all 2-13 days old) for roughly eleven more weeks.
        self.assertNotEqual(dc.REGRESSION_LIVENESS_DAYS, dc.PG_OUTCOME_LOOKBACK_DAYS)

    def test_when_env_override_set_then_liveness_constant_honours_it(self):
        try:
            with mock.patch.dict(
                os.environ, {"AUTOAGENT_REGRESSION_LIVENESS_DAYS": "3"}
            ):
                importlib.reload(dc)
                self.assertEqual(dc.REGRESSION_LIVENESS_DAYS, 3)
        finally:
            importlib.reload(dc)
        self.assertEqual(dc.REGRESSION_LIVENESS_DAYS, 14)

    def test_when_warning_aged_past_window_then_pattern_admitted(self):
        aged = _ts(dc.REGRESSION_LIVENESS_DAYS + 1)
        report = dc.find_regression_blocked_rows(
            [(aged, _SHELL)],
            [_applied(900, _SHELL, LABEL_SOLO_BUDGET, aged)],
            _index(),
            now=_NOW,
        )
        self.assertFalse(report.indeterminate)
        self.assertEqual(report.blocked_rows, frozenset())

    def test_when_warning_inside_window_then_pattern_blocked(self):
        fresh = _ts(9)
        report = dc.find_regression_blocked_rows(
            [(fresh, _SHELL)],
            [_applied(900, _SHELL, LABEL_SOLO_BUDGET, fresh)],
            _index(),
            now=_NOW,
        )
        self.assertEqual(report.blocked_rows, frozenset({10}))


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class GateGranularityTest(unittest.TestCase):
    """Blocking is per pattern row — never a whole-agent lockout."""

    def test_when_real_two_constituent_consolidation_then_exactly_one_blocked(self):
        idx = _index()
        # The real two-constituent consolidation's own covered pair, resolved by
        # the shipped helper rather than hand-listed.
        pair = frozenset(
            dc.find_covered_pattern_rows(LABEL_SHELL_2_REVERSED, _SHELL, idx)
        )
        self.assertEqual(pair, frozenset({10, 2}))

        fresh = _ts(9)
        report = dc.find_regression_blocked_rows(
            [(fresh, _SHELL)],
            [_applied(900, _SHELL, LABEL_SOLO_BUDGET, fresh)],
            idx,
            now=_NOW,
        )
        blocked_in_pair = pair & report.blocked_rows
        self.assertEqual(len(blocked_in_pair), 1, "exactly one of the pair blocks")
        self.assertEqual(blocked_in_pair, frozenset({10}))
        # The agent's remaining stored row is untouched: a warning binds the rows
        # its own proposal covered, not the agent.
        self.assertNotIn(430, report.blocked_rows)

    def test_when_one_agent_warned_then_other_agents_rows_untouched(self):
        fresh = _ts(4)
        report = dc.find_regression_blocked_rows(
            [(fresh, _SHELL)],
            [_applied(900, _SHELL, LABEL_SHELL_2_REVERSED, fresh)],
            _index(),
            now=_NOW,
        )
        self.assertEqual(report.blocked_rows, frozenset({10, 2}))
        self.assertFalse(report.blocked_rows & frozenset({7, 1, 5}))

    def test_when_reverted_status_then_pattern_released_early(self):
        fresh = _ts(2)
        report = dc.find_regression_blocked_rows(
            [(fresh, _SHELL)],
            [_applied(900, _SHELL, LABEL_SOLO_BUDGET, fresh, status="reverted")],
            _index(),
            now=_NOW,
        )
        self.assertEqual(report.blocked_rows, frozenset())

    def test_when_warning_matches_no_proposal_then_nothing_blocked(self):
        fresh = _ts(2)
        report = dc.find_regression_blocked_rows(
            [(fresh, _SHELL)],
            [_applied(900, _SHELL, LABEL_SOLO_BUDGET, _ts(5))],
            _index(),
            now=_NOW,
        )
        self.assertEqual(report.blocked_rows, frozenset())


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class FailDirectionSplitTest(unittest.TestCase):
    """Indeterminate blocks; cleanly absent admits. Conflating them halts the loop."""

    def test_when_verdict_cleanly_absent_then_candidates_admitted(self):
        report = dc.find_regression_blocked_rows([], [], _index(), now=_NOW)
        self.assertFalse(report.indeterminate)
        self.assertEqual(report.blocked_rows, frozenset())
        patterns = [_pattern(10, _SHELL, _BUDGET_CORE)]
        self.assertEqual(
            dc.drop_regression_blocked_patterns(_SHELL, patterns, report, live=True),
            patterns,
        )

    def test_when_read_failed_then_every_candidate_blocked_that_cycle(self):
        report = dc.find_regression_blocked_rows(None, [], _index(), now=_NOW)
        self.assertTrue(report.indeterminate)
        patterns = [
            _pattern(10, _SHELL, _BUDGET_CORE),
            _pattern(2, _SHELL, _FAIL_CORE),
        ]
        self.assertEqual(
            dc.drop_regression_blocked_patterns(_SHELL, patterns, report, live=True),
            [],
        )

    def test_when_warning_row_unparseable_then_indeterminate(self):
        report = dc.find_regression_blocked_rows(
            [("not-a-timestamp", _SHELL)],
            [_applied(900, _SHELL, LABEL_SOLO_BUDGET, _ts(2))],
            _index(),
            now=_NOW,
        )
        self.assertTrue(report.indeterminate)

    def test_when_next_cycle_read_succeeds_then_block_releases(self):
        patterns = [_pattern(10, _SHELL, _BUDGET_CORE)]
        outage = dc.find_regression_blocked_rows(None, None, None, now=_NOW)
        self.assertEqual(
            dc.drop_regression_blocked_patterns(_SHELL, patterns, outage, live=True),
            [],
        )
        # Next cycle: the read succeeds and returns no warning for this agent.
        clean = dc.find_regression_blocked_rows([], [], _index(), now=_NOW)
        self.assertEqual(
            dc.drop_regression_blocked_patterns(_SHELL, patterns, clean, live=True),
            patterns,
        )

    def test_when_indeterminate_then_loud_line_names_the_inversion(self):
        with _capture_stderr() as buf:
            with mock.patch.object(dc, "_fetch_regression_warnings", return_value=None):
                with mock.patch.object(
                    dc, "_fetch_proposals_for_regression_gate", return_value=[]
                ):
                    report = dc.build_regression_gate_report(_index())
        self.assertTrue(report.indeterminate)
        line = buf.getvalue()
        self.assertIn("INDETERMINATE", line)
        self.assertIn("fail-closed", line.lower())
        self.assertIn("this cycle", line.lower())


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class DryRunReportTest(unittest.TestCase):
    """Dry-run excludes nothing but must publish the set the deploy gate reads."""

    def _report(self):
        # build_* resolves liveness against the real clock, so the fixture age
        # is a delta from it rather than from the frozen instant.
        fresh = datetime.now(timezone.utc) - timedelta(days=9)
        with mock.patch.object(
            dc, "_fetch_regression_warnings", return_value=[(fresh, _SHELL)]
        ):
            with mock.patch.object(
                dc,
                "_fetch_proposals_for_regression_gate",
                return_value=[_applied(900, _SHELL, LABEL_SHELL_2_REVERSED, fresh)],
            ):
                return dc.build_regression_gate_report(_index())

    def test_when_dry_run_then_nothing_excluded(self):
        report = self._report()
        patterns = [_pattern(10, _SHELL, _BUDGET_CORE)]
        self.assertEqual(report.blocked_rows, frozenset({10, 2}))
        self.assertEqual(
            dc.drop_regression_blocked_patterns(_SHELL, patterns, report, live=False),
            patterns,
        )

    def test_when_dry_run_then_would_block_membership_on_the_log_line(self):
        with _capture_stderr() as buf:
            self._report()
        line = buf.getvalue()
        self.assertIn("would-block", line)
        self.assertIn("row=10", line)
        self.assertIn("row=2", line)

    def test_when_would_block_entry_then_it_carries_agent_and_warning_age(self):
        with _capture_stderr() as buf:
            report = self._report()
        line = buf.getvalue()
        self.assertIn(f"agent={_SHELL}", line)
        self.assertIn("warning_age=9d", line)
        for entry_agent, _row_id, age_days in report.entries:
            self.assertEqual(entry_agent, _SHELL)
            self.assertEqual(age_days, 9)

    def test_when_live_flag_unset_then_gate_is_dry_run(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(dc.REGRESSION_GATE_LIVE_ENV, None)
            self.assertFalse(dc.regression_gate_live_enabled())
        with mock.patch.dict(os.environ, {dc.REGRESSION_GATE_LIVE_ENV: "1"}):
            self.assertTrue(dc.regression_gate_live_enabled())


if __name__ == "__main__":
    unittest.main()
