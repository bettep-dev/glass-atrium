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
a skip-only class reports as a pass — so the ``daemon_cycle`` import below is
deliberately UNGUARDED and an import regression reds the leg instead of hiding
the class-authority pin behind a skip. Its import surface is stdlib plus
repo-local modules (psycopg absence is absorbed inside daemon_cycle itself), so
no environment makes that import legitimately fail. Fixtures are the REAL stored
strings frozen below, never invented.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_discharge_wiring.py -v
    python3 -m unittest autoagent.test.test_discharge_wiring -v

CID: 2026-07-31T1530_loopexec_a4f6
"""

from __future__ import annotations

import contextlib
import io
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
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

import daemon_cycle as dc  # noqa: E402 — autoagent dir pinned above

# The writer owns the cause-token→class map; the gate-invariance case compares the
# daemon's own tokens against it rather than restating the set a second time.
# Read through the stdlib stand-in, NEVER by a direct import: the writer re-raises
# ImportError wherever psycopg is absent, which is every merge-gating leg — a direct
# import resolves to nothing there and the class-authority pin would skip on exactly
# the leg it exists to fail.
_SCRIPTS_TEST_DIR = _REPO_ROOT / "scripts" / "test"
if str(_SCRIPTS_TEST_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_TEST_DIR))

import _pg_stub_backend as stub_backend  # noqa: E402 — scripts/test pinned above


def _get_writer_verdict_causes() -> tuple[str, ...]:
    """The writer's verdict cause tokens, read under the fabricated driver.

    The stand-in connects lazily, so the database name below is carried and never
    opened — no table is needed to read a module constant.
    """
    with tempfile.TemporaryDirectory() as tmp_dir:
        with stub_backend.load_helper(Path(tmp_dir) / "loop_events.sqlite") as writer:
            return writer.LOOP_EVENT_VERDICT_CAUSES


# Loop-event envelopes the module-level seal captured instead of writing them.
_EMITTED: list[dict] = []
_EMIT_PATCHER = None


def _seal_loop_event(envelope: dict) -> bool:
    """Capture one loop-event envelope instead of writing it, refusing any whose
    class is not STATED.

    The ``subject`` key selects the row class, and the writer defaults an absent
    key into the census arm — so a capture-only seal would let an emitter added
    without a class be censused silently. PRESENCE is the check, never the value:
    ``None`` states census, a subject token states verdict.
    """
    args = envelope.get("args")
    if not isinstance(args, dict) or "subject" not in args:
        raise AssertionError(
            "loop-event envelope states no class — 'subject' missing from "
            "envelope['args']; state it at the emit site (None = census, a "
            "subject token = verdict) instead of defaulting into the census "
            "arm. envelope=%r" % (envelope,)
        )
    _EMITTED.append(envelope)
    return True


def setUpModule() -> None:
    """Seal the loop-event writer for every test in this file — an unresolved
    proposal reaches the emit, and an unsealed run writes live PG rows."""
    global _EMIT_PATCHER
    _EMIT_PATCHER = mock.patch.object(dc, "_invoke_pg_helper", _seal_loop_event)
    _EMIT_PATCHER.start()


def tearDownModule() -> None:
    if _EMIT_PATCHER is not None:
        _EMIT_PATCHER.stop()


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


def _row(row_id: int, agent: str, label: str, status: str = "identified") -> dict:
    return {
        "id": row_id,
        "agent": agent,
        "pattern_signature": _ROW.format(label=label, agent=agent),
        "frequency": 1,
        "discovered_date": date(2026, 7, 1),
        "status": status,
        "approval_tier": "user-pending",
    }


_FAIL_CORE = "repeated failure by same agent"
_BUDGET_CORE = "budget-overage concentration"
_RATE_CORE_SPACED = "agent instruction-improvement candidate (failure rate )"
_RATE_CORE_BARE = "agent instruction-improvement candidate (failure rate)"
# Row 3384's stored core, which is also proposal 7497's pattern_label, verbatim.
_SIZE_EST_CORE = "size-est under-estimate concentration (avg overrun + tool_uses)"

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

# Production read shape for an agent whose rows are all parked: the intake read
# (status='identified') drops every terminal row, while the status-agnostic
# coverage read keeps it. One row per detector family, all dev-nestjs.
_PARKED_AGENT = "glass-atrium-dev-nestjs"
PARKED_FAMILIES: tuple[tuple[str, str, int, str], ...] = (
    ("fail", _FAIL_CORE, 3, "rejected"),
    ("rate", _RATE_CORE_SPACED, 6, "applied"),
    ("budget", _BUDGET_CORE, 8, "rejected"),
    ("size-est", _SIZE_EST_CORE, 3384, "rejected"),
)
_PARKED_STATUS = {row_id: status for _, _, row_id, status in PARKED_FAMILIES}
PARKED_INTAKE_ROWS: tuple[dict, ...] = tuple(
    r for r in STORED_ROWS if r["id"] not in _PARKED_STATUS
)
COVERAGE_ROWS: tuple[dict, ...] = tuple(
    {
        "id": r["id"],
        "pattern_signature": r["pattern_signature"],
        "agent": r["agent"],
        "status": _PARKED_STATUS.get(r["id"], r["status"]),
    }
    for r in STORED_ROWS + (_row(3384, _PARKED_AGENT, _SIZE_EST_CORE),)
)


def _index(rows: tuple[dict, ...] = STORED_ROWS) -> dict:
    """Per-agent intake row index built from the frozen rows, PG untouched."""
    # Two-part PG-less pattern (mirrors test_pg_pattern_intake): flip the
    # HAS_PG_PATTERN_READ gate — get_pattern_rows_by_agent returns None without it
    # — AND patch the reader with create=True, since _pg_read_pending_patterns is a
    # CONDITIONAL import (daemon_cycle try-block alias, unbound when psycopg is
    # absent, the CI condition). Every patch of it here is pure-mock and opens no
    # cursor, so this keeps the tests RUNNING PG-less rather than skipping.
    with mock.patch.object(dc, "HAS_PG_PATTERN_READ", True), mock.patch.object(
        dc, "_pg_read_pending_patterns", return_value=list(rows), create=True
    ):
        return dc.get_pattern_rows_by_agent()


def _coverage_index(rows: tuple[dict, ...] = COVERAGE_ROWS) -> dict:
    """Status-agnostic row index through the shipped indexer, PG untouched."""
    with mock.patch.object(dc, "HAS_PG_PATTERN_READ", True), mock.patch.object(
        dc, "_pg_read_coverage_patterns", return_value=list(rows), create=True
    ):
        return dc.get_coverage_rows_by_agent()


@contextlib.contextmanager
def _capture_stderr():
    buf = io.StringIO()
    with contextlib.redirect_stderr(buf):
        yield buf


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


class DischargeStageTest(unittest.TestCase):
    """discharge_applied_patterns — dry-run default, tri-state, no lockout."""

    _UNSET = object()

    def setUp(self):
        self.calls: list[tuple[int, str]] = []
        self.outcomes: dict[int, str] = {}
        self.coverage_reads = 0
        _EMITTED.clear()

        def _fake_discharge(row_id: int, reason: str):
            self.calls.append((row_id, reason))
            outcome = self.outcomes.get(row_id, dc.DISCHARGE_APPLIED)
            return dc.DischargeResult(
                outcome, row_id if outcome == dc.DISCHARGE_APPLIED else None
            )

        patcher = mock.patch.object(dc, "_pg_discharge_learning_pattern", _fake_discharge)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run(self, applied_rows, *, live=False, index=None, coverage=_UNSET):
        idx = _index() if index is None else index
        coverage_index = _coverage_index() if coverage is self._UNSET else coverage

        def _read_coverage():
            self.coverage_reads += 1
            return coverage_index

        with _capture_stderr() as buf:
            report = dc.discharge_applied_patterns(
                applied_rows, idx, coverage_reader=_read_coverage, live=live
            )
        return report, buf.getvalue()

    @staticmethod
    def _emitted_tokens() -> list[str]:
        return [e["args"]["eval_result"] for e in _EMITTED]

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

    def test_when_intake_match_is_empty_then_exactly_one_named_cause_is_reported(self):
        # (cause token, report field, intake index, coverage index, label, loud)
        react = "glass-atrium-dev-react"
        cases = (
            ("discharge-read-failed", "read_failed", {}, None, LABEL_REACT_3, True),
            ("discharge-unresolved", "unresolved", None, self._UNSET,
             "some future proposal label form v2", True),
            ("discharge-intake-miss", "intake_miss", {}, self._UNSET, LABEL_REACT_3, True),
            ("discharge-covered-terminal", "covered_terminal",
             _index(PARKED_INTAKE_ROWS), self._UNSET, _SIZE_EST_CORE, False),
        )
        cause_fields = ("read_failed", "unresolved", "intake_miss", "covered_terminal")
        for token, field_name, intake, coverage, label, loud in cases:
            with self.subTest(cause=token):
                _EMITTED.clear()
                agent = _PARKED_AGENT if field_name == "covered_terminal" else react
                report, err = self._run(
                    [(77, agent, label)], live=True, index=intake, coverage=coverage
                )
                for other in cause_fields:
                    expected = [77] if other == field_name else []
                    self.assertEqual(getattr(report, other), expected, other)
                self.assertEqual(self._emitted_tokens(), [token])
                line = next(ln for ln in err.splitlines() if token in ln)
                self.assertEqual("WARN" in line, loud, line)
                self.assertNotIn("label shape unrecognized", err)

    def test_when_covering_row_already_terminal_then_each_family_reports_covered_terminal(self):
        # Production shape: the intake index lacks the parked row, the coverage
        # index holds it — the retired fixture injected it INTO the intake index.
        intake = _index(PARKED_INTAKE_ROWS)
        for family, label, row_id, status in PARKED_FAMILIES:
            with self.subTest(family=family):
                _EMITTED.clear()
                self.calls.clear()
                report, err = self._run(
                    [(7497, _PARKED_AGENT, label)], live=True, index=intake
                )
                self.assertEqual(report.covered_terminal, [7497])
                self.assertEqual(report.unresolved, [])
                self.assertEqual(self.calls, [])
                self.assertEqual(self._emitted_tokens(), ["discharge-covered-terminal"])
                self.assertIn(f"{row_id}:{status}", err)

    def test_when_every_proposal_resolves_through_intake_then_coverage_is_read_at_most_once(self):
        self._run([(1, "glass-atrium-dev-react", LABEL_REACT_3)], live=True)
        self.assertEqual(self.coverage_reads, 0)

        self._run(
            [
                (77, "glass-atrium-dev-react", "unrecognized form"),
                (78, "glass-atrium-dev-shell", "another unrecognized form"),
            ],
            live=True,
        )
        self.assertEqual(self.coverage_reads, 1)

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

    def test_when_row_turns_terminal_between_read_and_update_then_not_matched_not_failed(self):
        # The SQL terminal guard's race answer — distinct from a row the intake
        # read already dropped, which never reaches the update.
        self.outcomes = {7: dc.DISCHARGE_NOT_MATCHED}
        report, _ = self._run(
            [(1, "glass-atrium-dev-react", LABEL_REACT_3)], live=True
        )
        self.assertEqual(report.failed, [])
        self.assertNotIn(7, report.discharged)

    def test_when_ambiguous_then_it_can_never_become_a_whole_agent_lockout(self):
        # Fail-closed: neither an outage nor an unresolvable label may fall back
        # to discharging the agent's whole row set. Ambiguity discharges NOTHING.
        # The intake-miss and covered-terminal shapes hold real covering rows —
        # the ones a fallback would transition.
        shapes = (
            (None, None),
            ([(77, "glass-atrium-dev-react", "unrecognized form")], None),
            ([(77, "glass-atrium-dev-react", LABEL_REACT_3)], {}),
            ([(7497, _PARKED_AGENT, _SIZE_EST_CORE)], _index(PARKED_INTAKE_ROWS)),
        )
        for rows, intake in shapes:
            with self.subTest(rows=rows):
                self.calls.clear()
                report, _ = self._run(rows, live=True, index=intake)
                self.assertEqual(self.calls, [])
                self.assertEqual(report.discharged, [])

    def test_when_selecting_the_window_then_only_applied_proposals_are_eligible(self):
        # The fetch is the sole row source, so a rejected or still-pending
        # proposal can never enter the stage — pinned on the select predicate.
        sql = dc._APPLIED_FOR_DISCHARGE_SELECT_SQL
        self.assertIn("status::text = 'applied'", sql)
        self.assertIn("reviewed_at IS NOT NULL", sql)
        self.assertNotIn("LIMIT", sql.upper())


    def test_when_a_proposal_is_adjudicated_then_its_row_carries_it_as_subject(self):
        # Verdict class: every discharge cause keys on the proposal, so a later
        # cause for that proposal supersedes this verdict rather than joining it.
        react = "glass-atrium-dev-react"
        cases = (
            ("discharge-read-failed", {}, None, LABEL_REACT_3, react),
            ("discharge-unresolved", None, self._UNSET,
             "some future proposal label form v2", react),
            ("discharge-intake-miss", {}, self._UNSET, LABEL_REACT_3, react),
            ("discharge-covered-terminal", _index(PARKED_INTAKE_ROWS), self._UNSET,
             _SIZE_EST_CORE, _PARKED_AGENT),
        )
        for token, intake, coverage, label, agent in cases:
            with self.subTest(cause=token):
                _EMITTED.clear()
                self._run(
                    [(77, agent, label)], live=True, index=intake, coverage=coverage
                )
                self.assertEqual(self._emitted_tokens(), [token])
                self.assertEqual(
                    [e["args"]["subject"] for e in _EMITTED], ["proposal:77"]
                )

    def test_when_one_cause_adjudicates_two_proposals_then_each_keeps_its_subject(self):
        # The census key would collapse these onto one row; the verdict key keeps
        # N subjects reaching one cause on one day representable as N rows.
        react = "glass-atrium-dev-react"
        self._run(
            [(77, react, "unrecognized form"), (78, react, "another unrecognized form")],
            live=True,
        )
        self.assertEqual(self._emitted_tokens(), ["discharge-unresolved"] * 2)
        self.assertEqual(
            [e["args"]["subject"] for e in _EMITTED], ["proposal:77", "proposal:78"]
        )


class CensusEmitClassTest(unittest.TestCase):
    """Census emitters carry no subject, so they keep the (event_ts, agent, cause) key."""

    def setUp(self):
        _EMITTED.clear()

    def test_when_the_gate_skips_or_fails_open_then_the_row_carries_no_subject(self):
        with _capture_stderr():
            dc._warn_pattern_skip(
                "glass-atrium-dev-react",
                "some label|glass-atrium-dev-react",
                "2026-09-21",
                eval_result="stale-pattern-skip",
                reason="reobservation window elapsed",
            )
            dc._warn_gate_fail_open(
                "glass-atrium-dev-react",
                "some label|glass-atrium-dev-react",
                "2026-09-21",
                eval_result=dc.STALE_UNKNOWN_FAMILY_EVAL,
                reason="family unknown to the staleness table",
            )
        self.assertEqual([e["args"]["subject"] for e in _EMITTED], [None, None])

    def test_when_an_intake_row_is_off_roster_then_the_row_carries_no_subject(self):
        with _capture_stderr():
            dc._warn_roster_mismatch("not-an-agent", "sig|not-an-agent", "2026-09-21")
        self.assertEqual([e["args"]["subject"] for e in _EMITTED], [None])
        self.assertEqual([e["args"]["eval_result"] for e in _EMITTED], ["roster-mismatch"])

    def test_when_the_cycle_aggregate_emits_then_it_states_the_census_class(self):
        # The aggregate pre-aggregates ONTO the census key (C8), so its envelope
        # names the column the class turns on rather than leaving it to a default.
        patch = SimpleNamespace(
            pattern_agent="glass-atrium-dev-react",
            estimated_added_lines=3,
            estimated_removed_lines=1,
        )
        report = SimpleNamespace(patches=[patch, patch], generated_at="2026-09-21")
        with mock.patch.object(dc, "_coerce_eval_result", return_value="verified"):
            envelopes = dc._aggregate_loop_events(report)
        self.assertEqual([e["args"]["subject"] for e in envelopes], [None])
        self.assertEqual(envelopes[0]["args"]["changes_added"], 6)


class RegressionGateInvarianceTest(unittest.TestCase):
    """The class split must not move the regression gate — it is a CONTROL path.

    The gate reads its own warning rows back out of core.autoagent_loop_events and
    those rows BLOCK proposal rows, so its key and its join stay where they were.
    """

    _AGENT = "glass-atrium-dev-react"
    _APPLIED_TS = datetime(2026, 9, 20, 3, 0, tzinfo=timezone.utc)

    def _blocked(self, warned_at: datetime) -> frozenset:
        report = dc.find_regression_blocked_rows(
            [(warned_at, self._AGENT)],
            [(11, self._AGENT, self._APPLIED_TS, LABEL_REACT_3, "applied")],
            _index(),
            now=self._APPLIED_TS + timedelta(days=1),
        )
        self.assertFalse(report.indeterminate)
        return report.blocked_rows

    def test_when_the_warning_shares_the_apply_instant_then_its_rows_stay_blocked(self):
        self.assertEqual(self._blocked(self._APPLIED_TS), frozenset({7, 1, 5}))

    def test_when_the_warning_instant_differs_then_the_join_matches_nothing(self):
        self.assertEqual(
            self._blocked(self._APPLIED_TS + timedelta(seconds=1)), frozenset()
        )

    def test_when_the_gate_selects_its_warnings_then_it_reads_no_subject(self):
        sql = " ".join(dc._REGRESSION_WARNINGS_SELECT_SQL.split())
        self.assertIn("SELECT event_ts, agent FROM core.autoagent_loop_events", sql)
        self.assertIn("WHERE eval_result = %s", sql)
        self.assertNotIn("subject", sql)

    def test_when_the_writer_classifies_the_gate_token_then_it_is_census(self):
        # A verdict-classified gate token would re-key the very rows the gate
        # reads back, so the class authority must keep it census.
        verdict_causes = _get_writer_verdict_causes()
        self.assertNotIn(dc.POST_APPLY_REGRESSION_EVAL_RESULT, verdict_causes)
        self.assertNotIn(dc.CONFOUND_SIGNATURE_EVAL_RESULT, verdict_causes)
        self.assertNotIn(dc.DWC_SHARE_ALARM_EVAL_RESULT, verdict_causes)
        self.assertEqual(
            sorted(verdict_causes),
            sorted(
                (
                    dc.DISCHARGE_EVENT_READ_FAILED,
                    dc.DISCHARGE_EVENT_UNRESOLVED,
                    dc.DISCHARGE_EVENT_COVERED_TERMINAL,
                    dc.DISCHARGE_EVENT_INTAKE_MISS,
                )
            ),
        )


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


class SubjectWidthGuardTest(unittest.TestCase):
    """A subject wider than its column is a caller bug, refused before connecting.

    Truncating would key two adjudications onto ONE verdict row; letting it through
    defers the failure into PG, where a caller bug is filed as a database one.
    """

    def _migration_declared_width(self) -> int:
        """The subject column's width as the migration SQL declares it."""
        widths = set()
        migrations = _REPO_ROOT / "monitor" / "prisma" / "migrations"
        for sql_path in migrations.glob("*/migration.sql"):
            for line in sql_path.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if stripped.startswith("--") or '"subject"' not in stripped:
                    continue
                if "VARCHAR(" not in stripped:
                    continue
                widths.add(int(stripped.split("VARCHAR(")[1].split(")")[0]))
        self.assertEqual(len(widths), 1, "expected ONE subject column declaration")
        return widths.pop()

    def test_when_the_refusal_boundary_leaves_the_column_width_then_it_reds(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            with stub_backend.load_helper(
                Path(tmp_dir) / "loop_events.sqlite"
            ) as writer:
                self.assertEqual(
                    writer._LOOP_EVENT_SUBJECT_MAX_CHARS,
                    self._migration_declared_width(),
                )

    def test_when_a_subject_exceeds_the_column_then_nothing_is_written(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            with stub_backend.load_helper(
                Path(tmp_dir) / "loop_events.sqlite"
            ) as writer:
                over = "p:" + "9" * writer._LOOP_EVENT_SUBJECT_MAX_CHARS
                with self.assertRaises(writer.CallerContractViolation):
                    writer.write_autoagent_loop_event(
                        "2026-09-21",
                        "glass-atrium-dev-react",
                        writer.LOOP_EVENT_VERDICT_CAUSES[0],
                        0,
                        0,
                        subject=over,
                    )


if __name__ == "__main__":
    unittest.main()
