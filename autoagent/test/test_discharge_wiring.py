"""Behavioral tests for pattern-first coverage resolution + the discharge stage (R4).

An applied proposal's patch lands, but the ``core.learning_log`` rows it was
generated from stay 'identified' forever, so their frequency keeps growing and
the same prose rule re-fires stricter every cycle. R4 resolves an applied
proposal to the pattern rows it covers and discharges them.

Resolution runs PATTERN-FIRST: iterate the agent's stored rows (row ids already
in hand) and ask the shipped ``_covers_pattern_label`` matcher whether the
proposal label covers each. Nothing is reconstructed from the label, so a
constituent's nested parentheses sit inside the haystack rather than being
parsed, and the zero-match mode of a label-first parse cannot arise.

Every test here is DATABASE-FREE: the CI python leg provisions no database, and
a skip-only class reports as a pass. Fixtures are the REAL stored strings frozen
below, never invented.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_discharge_wiring.py -v
    python3 -m unittest autoagent.test.test_discharge_wiring -v

CID: 2026-07-31T1530_loopexec_a4f6
"""

from __future__ import annotations

import contextlib
import io
import sys
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

# The helper MUST enter sys.modules before daemon_cycle imports it so both bind
# to ONE module object (the discharge helper is patched through it).
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
#
# core.learning_log rows (id, agent, pattern_signature) as stored on 2026-07-31.
# pattern_signature is "<label>|<agent>" per the aggregator UPSERT contract.
# The two variants of the legacy signature core differ by ONE INTERNAL space
# before the closing paren: 'failure rate )' (ids 5, 6, 41, 42) vs
# 'failure rate)' (ids 90, 91, 235, 430, 457). The fork spans agents and each
# agent sits wholly on one side.

_ROW = "{label}|{agent}"


def _row(row_id: int, agent: str, label: str) -> dict:
    return {
        "id": row_id,
        "agent": agent,
        "pattern_signature": _ROW.format(label=label, agent=agent),
        "frequency": 1,
        "discovered_date": date(2026, 7, 1),
        "status": "identified",
        "approval_tier": "user-pending",
    }


_FAIL_CORE = "repeated failure by same agent"
_BUDGET_CORE = "budget-overage concentration"
_RATE_CORE_SPACED = "agent instruction-improvement candidate (failure rate )"
_RATE_CORE_BARE = "agent instruction-improvement candidate (failure rate)"

# Real stored rows. dev-react + dev-nestjs sit on the spaced fork, dev-shell on
# the bare fork. bulldog-w2 is a real low-frequency row that roster validation
# drops and the agent cap excludes — the untruncated-read criterion keys on it.
STORED_ROWS: tuple[dict, ...] = (
    _row(7, "glass-atrium-dev-react", _BUDGET_CORE),
    _row(1, "glass-atrium-dev-react", _FAIL_CORE),
    _row(5, "glass-atrium-dev-react", _RATE_CORE_SPACED),
    _row(10, "glass-atrium-dev-shell", _BUDGET_CORE),
    _row(2, "glass-atrium-dev-shell", _FAIL_CORE),
    _row(430, "glass-atrium-dev-shell", _RATE_CORE_BARE),
    _row(8, "glass-atrium-dev-nestjs", _BUDGET_CORE),
    _row(3, "glass-atrium-dev-nestjs", _FAIL_CORE),
    _row(6, "glass-atrium-dev-nestjs", _RATE_CORE_SPACED),
    _row(9, "glass-atrium-qa-debugger", _BUDGET_CORE),
    _row(4, "glass-atrium-qa-debugger", _FAIL_CORE),
    _row(351, "glass-atrium-qa-code-reviewer", _BUDGET_CORE),
    _row(41, "glass-atrium-bulldog-w2", _RATE_CORE_SPACED),
)

# Real stored core.autoagent_proposals.pattern_label strings, verbatim.
# The third constituent NESTS its own parentheses; the SOFT constituent
# 'recurring negative-signal concentration' is the display remap of the stored
# FAIL core 'repeated failure by same agent'.
LABEL_REACT_3 = (
    "glass-atrium-dev-react multi-signal consolidation (budget-overage "
    "concentration / recurring negative-signal concentration / agent "
    "instruction-improvement candidate (failure rate ))"
)
LABEL_NESTJS_3 = (
    "glass-atrium-dev-nestjs multi-signal consolidation (budget-overage "
    "concentration / recurring negative-signal concentration / agent "
    "instruction-improvement candidate (failure rate ))"
)
LABEL_NESTJS_3_REVERSED = (
    "glass-atrium-dev-nestjs multi-signal consolidation (recurring "
    "negative-signal concentration / budget-overage concentration / agent "
    "instruction-improvement candidate (failure rate ))"
)
LABEL_SHELL_2_REVERSED = (
    "glass-atrium-dev-shell multi-signal consolidation (recurring "
    "negative-signal concentration / budget-overage concentration)"
)
LABEL_QA_DEBUGGER_2 = (
    "glass-atrium-qa-debugger multi-signal consolidation (budget-overage "
    "concentration / recurring negative-signal concentration)"
)
LABEL_REVIEWER_2 = (
    "glass-atrium-qa-code-reviewer multi-signal consolidation (budget-overage "
    "concentration / recurring negative-signal concentration)"
)
# Solo (single-pattern) proposal label — stored as the bare label, no join.
LABEL_SOLO_REVIEWER = _BUDGET_CORE

# The five real consolidation labels the coverage criterion enumerates, each
# paired with the row ids of its own agent that it must resolve to.
REAL_CONSOLIDATIONS: tuple[tuple[str, str, frozenset[int]], ...] = (
    (LABEL_REACT_3, "glass-atrium-dev-react", frozenset({7, 1, 5})),
    (LABEL_NESTJS_3, "glass-atrium-dev-nestjs", frozenset({8, 3, 6})),
    (LABEL_NESTJS_3_REVERSED, "glass-atrium-dev-nestjs", frozenset({8, 3, 6})),
    (LABEL_SHELL_2_REVERSED, "glass-atrium-dev-shell", frozenset({10, 2})),
    (LABEL_QA_DEBUGGER_2, "glass-atrium-qa-debugger", frozenset({9, 4})),
)

_STORED_IDS = frozenset(r["id"] for r in STORED_ROWS)


def _index() -> dict:
    """Per-agent row index built from the frozen rows, PG untouched."""
    # Two-part PG-less pattern (mirrors test_pg_pattern_intake): flip the
    # HAS_PG_PATTERN_READ gate — get_pattern_rows_by_agent returns None without it
    # — AND patch the reader with create=True, since _pg_read_pending_patterns is a
    # CONDITIONAL import (daemon_cycle try-block alias, unbound when psycopg is
    # absent, the CI condition). Every patch of it here is pure-mock and opens no
    # cursor, so this keeps the tests RUNNING PG-less rather than skipping.
    with mock.patch.object(dc, "HAS_PG_PATTERN_READ", True), mock.patch.object(
        dc, "_pg_read_pending_patterns", return_value=list(STORED_ROWS), create=True
    ):
        return dc.get_pattern_rows_by_agent()


@contextlib.contextmanager
def _capture_stderr():
    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        yield buf


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class CoverageResolutionTest(unittest.TestCase):
    """find_covered_pattern_rows — pattern-first, per-agent, untruncated source."""

    def test_when_solo_label_then_resolves_exactly_one_stored_row(self):
        covered = dc.find_covered_pattern_rows(
            LABEL_SOLO_REVIEWER, "glass-atrium-qa-code-reviewer", _index()
        )
        self.assertEqual(covered, [351])

    def test_when_real_consolidation_labels_then_each_resolves_two_or_more_real_rows(self):
        for label, agent, expected in REAL_CONSOLIDATIONS:
            with self.subTest(agent=agent, label=label[:60]):
                covered = dc.find_covered_pattern_rows(label, agent, _index())
                self.assertGreaterEqual(len(covered), 2)
                self.assertEqual(frozenset(covered), expected)
                # Every resolved id is a REAL stored row — the silent no-op the
                # retired label-first approach produced is exactly a resolution
                # to something that is not in the corpus.
                self.assertTrue(frozenset(covered) <= _STORED_IDS)

    def test_when_third_constituent_nests_parentheses_then_resolves_three_rows(self):
        covered = dc.find_covered_pattern_rows(
            LABEL_REACT_3, "glass-atrium-dev-react", _index()
        )
        self.assertEqual(frozenset(covered), frozenset({7, 1, 5}))

    def test_when_constituents_reversed_then_order_does_not_matter(self):
        idx = _index()
        forward = dc.find_covered_pattern_rows(
            LABEL_NESTJS_3, "glass-atrium-dev-nestjs", idx
        )
        reversed_ = dc.find_covered_pattern_rows(
            LABEL_NESTJS_3_REVERSED, "glass-atrium-dev-nestjs", idx
        )
        self.assertEqual(frozenset(forward), frozenset(reversed_))

    def test_when_display_remapped_constituent_then_resolves_stored_signature_core(self):
        # 'recurring negative-signal concentration' is the SOFT display remap of
        # the stored FAIL core; the matcher's own canonicalization is relied on
        # rather than duplicated here.
        self.assertNotIn(_FAIL_CORE, LABEL_QA_DEBUGGER_2)
        covered = dc.find_covered_pattern_rows(
            LABEL_QA_DEBUGGER_2, "glass-atrium-qa-debugger", _index()
        )
        self.assertIn(4, covered)

    def test_when_each_fork_agent_resolves_its_own_row_then_both_forks_discharge(self):
        # PER-AGENT criterion, never cross-fork: each agent's own label was
        # generated from that agent's own stored rows, so needle and haystack
        # are always on the same side of the fork. A single exact reconstruction
        # cannot serve both agents; the pattern-first direction serves both.
        idx = _index()
        spaced = dc.find_covered_pattern_rows(
            LABEL_REACT_3, "glass-atrium-dev-react", idx
        )
        self.assertIn(5, spaced)

        shell_rows = [r for r in STORED_ROWS if r["agent"] == "glass-atrium-dev-shell"]
        shell_patterns = [
            dc.Pattern(
                date="2026-07-01",
                label=r["pattern_signature"].rsplit("|", 1)[0],
                frequency="1",
                agent=r["agent"],
                status="identified",
                tier="user-pending",
                raw_line="",
                row_id=r["id"],
            )
            for r in shell_rows
        ]
        # The shipped generator, fed dev-shell's own real rows — the mechanism
        # the verification note names, not an invented string.
        bare_label = dc._consolidated_pattern_label(
            "glass-atrium-dev-shell", shell_patterns
        )
        self.assertIn(_RATE_CORE_BARE, bare_label)
        bare = dc.find_covered_pattern_rows(bare_label, "glass-atrium-dev-shell", idx)
        self.assertIn(430, bare)

    def test_when_cross_fork_then_containment_stays_false_matcher_not_loosened(self):
        # NOT a coverage criterion — a regression pin that the SHARED matcher was
        # not loosened to bridge the fork. Loosening it would make the
        # reverted-proposal gate, the non-auto-fixable gate, and the reject-streak
        # counter terminalize MORE patterns, silently removing them from intake.
        self.assertFalse(dc._covers_pattern_label(_RATE_CORE_BARE, LABEL_REACT_3))
        self.assertFalse(
            dc._covers_pattern_label(
                _RATE_CORE_SPACED,
                "glass-atrium-dev-shell multi-signal consolidation (%s)" % _RATE_CORE_BARE,
            )
        )

    def test_when_row_outside_agent_cap_and_roster_then_it_still_resolves(self):
        # bulldog-w2 is not an agents/*.md stem (roster validation drops it) and
        # sits far below the agent cap. The untruncated read must still carry it,
        # or its frequency keeps growing and it re-fires.
        idx = _index()
        patterns = [
            dc.Pattern(
                date="",
                label=r["pattern_signature"].rsplit("|", 1)[0],
                frequency="1",
                agent=r["agent"],
                status="identified",
                tier="user-pending",
                raw_line="",
                row_id=r["id"],
            )
            for r in STORED_ROWS
        ]
        capped = {a for a, _ in dc._group_patterns_by_agent(patterns, agent_cap=1)}
        self.assertNotIn("glass-atrium-bulldog-w2", capped)
        covered = dc.find_covered_pattern_rows(
            _RATE_CORE_SPACED, "glass-atrium-bulldog-w2", idx
        )
        self.assertEqual(covered, [41])

    def test_when_agent_alias_is_bare_then_prefixed_proposal_still_resolves(self):
        # Accumulated rows carry the bare stem while a proposal carries the
        # prefixed one; narrowing on the raw string would silently drop them.
        bare_rows = [_row(999, "dev-react", _BUDGET_CORE)]
        with mock.patch.object(
            dc, "HAS_PG_PATTERN_READ", True
        ), mock.patch.object(
            dc, "_pg_read_pending_patterns", return_value=bare_rows, create=True
        ):
            idx = dc.get_pattern_rows_by_agent()
        covered = dc.find_covered_pattern_rows(
            _BUDGET_CORE, "glass-atrium-dev-react", idx
        )
        self.assertEqual(covered, [999])

    def test_when_unrecognized_shape_then_resolves_to_empty_set(self):
        covered = dc.find_covered_pattern_rows(
            "some future proposal label form v2", "glass-atrium-dev-react", _index()
        )
        self.assertEqual(covered, [])


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class DischargeStageTest(unittest.TestCase):
    """discharge_applied_patterns — dry-run default, tri-state, no lockout."""

    def setUp(self):
        self.calls: list[tuple[int, str]] = []
        self.outcomes: dict[int, str] = {}

        def _fake_discharge(row_id: int, reason: str):
            self.calls.append((row_id, reason))
            outcome = self.outcomes.get(row_id, dc.DISCHARGE_APPLIED)
            return dc.DischargeResult(
                outcome, row_id if outcome == dc.DISCHARGE_APPLIED else None
            )

        patcher = mock.patch.object(dc, "_pg_discharge_learning_pattern", _fake_discharge)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run(self, applied_rows, *, live=False, index=None):
        idx = _index() if index is None else index
        with _capture_stderr() as buf:
            report = dc.discharge_applied_patterns(applied_rows, idx, live=live)
        return report, buf.getvalue()

    def test_when_dry_run_then_no_transition_and_membership_on_the_log_line(self):
        report, err = self._run([(1, "glass-atrium-dev-react", LABEL_REACT_3)])
        self.assertEqual(self.calls, [])
        self.assertEqual(frozenset(report.would_discharge), frozenset({7, 1, 5}))
        self.assertEqual(report.discharged, [])
        self.assertIn("dry-run", err)
        for row_id in (7, 1, 5):
            self.assertIn(str(row_id), err)

    def test_when_live_then_every_covered_row_of_the_proposal_transitions(self):
        report, _ = self._run(
            [(1, "glass-atrium-dev-react", LABEL_REACT_3)], live=True
        )
        self.assertEqual(frozenset(report.discharged), frozenset({7, 1, 5}))
        self.assertEqual(frozenset(r for r, _ in self.calls), frozenset({7, 1, 5}))

    def test_when_window_holds_several_proposals_for_one_agent_then_one_row_fetch(self):
        reader = mock.Mock(return_value=list(STORED_ROWS))
        with mock.patch.object(dc, "HAS_PG_PATTERN_READ", True), mock.patch.object(
            dc, "_pg_read_pending_patterns", reader, create=True
        ):
            idx = dc.get_pattern_rows_by_agent()
            self._run(
                [
                    (1, "glass-atrium-dev-react", LABEL_REACT_3),
                    (5, "glass-atrium-dev-react", LABEL_REACT_3),
                    (9, "glass-atrium-dev-react", LABEL_REACT_3),
                ],
                live=True,
                index=idx,
            )
        self.assertEqual(reader.call_count, 1)

    def test_when_resolution_is_empty_then_nothing_discharges_and_it_is_loud(self):
        report, err = self._run(
            [(77, "glass-atrium-dev-react", "unrecognized form")], live=True
        )
        self.assertEqual(self.calls, [])
        self.assertEqual(report.discharged, [])
        self.assertEqual(report.unresolved, [77])
        self.assertIn("discharge-unresolved", err)

    def test_when_read_failed_then_outage_is_distinct_from_an_empty_resolution(self):
        outage, err = self._run(None, live=True)
        self.assertTrue(outage.outage)
        self.assertEqual(self.calls, [])
        self.assertIn("outage", err.lower())

        empty, _ = self._run([], live=True)
        self.assertFalse(empty.outage)
        self.assertEqual(empty.would_discharge, [])

    def test_when_transition_call_fails_then_it_is_reported_apart_from_unresolved(self):
        self.outcomes = {1: dc.DISCHARGE_FAILED}
        report, err = self._run(
            [(1, "glass-atrium-dev-react", LABEL_REACT_3)], live=True
        )
        self.assertEqual(report.failed, [1])
        self.assertEqual(report.unresolved, [])
        self.assertIn(7, report.discharged)
        self.assertIn("discharge transition failed", err)

    def test_when_row_already_terminal_then_it_reports_not_matched_not_failed(self):
        self.outcomes = {7: dc.DISCHARGE_NOT_MATCHED}
        report, _ = self._run(
            [(1, "glass-atrium-dev-react", LABEL_REACT_3)], live=True
        )
        self.assertEqual(report.failed, [])
        self.assertNotIn(7, report.discharged)

    def test_when_ambiguous_then_it_can_never_become_a_whole_agent_lockout(self):
        # Fail-closed: neither an outage nor an unresolvable label may fall back
        # to discharging the agent's whole row set. Ambiguity discharges NOTHING.
        for rows in (None, [(77, "glass-atrium-dev-react", "unrecognized form")]):
            with self.subTest(rows=rows):
                self.calls.clear()
                report, _ = self._run(rows, live=True)
                self.assertEqual(self.calls, [])
                self.assertEqual(report.discharged, [])

    def test_when_selecting_the_window_then_only_applied_proposals_are_eligible(self):
        # The fetch is the sole row source, so a rejected or still-pending
        # proposal can never enter the stage — pinned on the select predicate.
        sql = dc._APPLIED_FOR_DISCHARGE_SELECT_SQL
        self.assertIn("status::text = 'applied'", sql)
        self.assertIn("reviewed_at IS NOT NULL", sql)
        self.assertNotIn("LIMIT", sql.upper())


@unittest.skipIf(dc is None, "daemon_cycle import failed: %s" % (_IMPORT_ERROR,))
class DischargeDefaultTest(unittest.TestCase):
    """Live transitioning is opt-in and never the default."""

    def test_when_env_unset_then_dry_run_is_the_default(self):
        with mock.patch.dict("os.environ", {}, clear=False):
            import os

            os.environ.pop(dc.DISCHARGE_LIVE_ENV, None)
            self.assertFalse(dc.discharge_live_enabled())

    def test_when_env_set_true_then_live_transitioning_is_enabled(self):
        with mock.patch.dict("os.environ", {dc.DISCHARGE_LIVE_ENV: "true"}):
            self.assertTrue(dc.discharge_live_enabled())


if __name__ == "__main__":
    unittest.main()
