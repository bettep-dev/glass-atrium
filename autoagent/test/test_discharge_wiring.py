"""Behavioral tests for pattern-first coverage resolution and the link-keyed discharge stage.

Coverage resolution runs PATTERN-FIRST: iterate the agent's stored rows (row ids
already in hand) and ask the shipped ``_covers_pattern_label`` matcher whether a
proposal label covers each; the regression gate reads it. Nothing is
reconstructed from the label, so a constituent's nested parentheses sit inside
the haystack rather than being parsed.

The discharge stage reads no label: an applied proposal names its pattern row
through ``learning_pattern_id``, and only that row, still in intake, moves to
terminal 'applied' — live by default, nothing in a no-write (``--dry-run``) cycle.

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
import os
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
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import daemon_cycle as dc  # noqa: E402 — autoagent dir pinned above
from _pg_seal import seal_pg_reach, set_install_tree
from daemon_config import TierKnobs

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
    """Seal the loop-event writer for every test in this file — the census
    emitters reach it, and an unsealed run writes live PG rows."""
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

# PARKED: an agent whose rows are all parked — the intake predicate
# (status='identified', intake tiers) drops every dev-nestjs row.
_IDS = SimpleNamespace(
    STORED=frozenset(r["id"] for r in STORED_ROWS),
    PARKED=frozenset({8, 3, 6}),
)
PARKED_INTAKE_ROWS: tuple[dict, ...] = tuple(
    r for r in STORED_ROWS if r["id"] not in _IDS.PARKED
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
                self.assertTrue(frozenset(covered) <= _IDS.STORED)

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
    """discharge_applied_patterns — the linked intake row only, tri-state, no lockout."""

    def setUp(self):
        self.calls: list[tuple[int, str]] = []
        self.outcomes: dict[int, str] = {}

        def _fake_discharge(row_id: int, reason: str):
            self.calls.append((row_id, reason))
            outcome = self.outcomes.get(row_id, dc.DISCHARGE_APPLIED)
            return dc.DischargeResult(
                outcome, row_id if outcome == dc.DISCHARGE_APPLIED else None
            )

        _EMITTED.clear()
        # Status-agnostic read the stage classifies an outside-intake link by; None = outage.
        self.coverage_rows: tuple[dict, ...] | None = STORED_ROWS
        for name, value in (
            ("_pg_discharge_learning_pattern", _fake_discharge),
            (
                "get_coverage_rows_by_agent",
                lambda: (
                    None
                    if self.coverage_rows is None
                    else dc._index_rows_by_agent(list(self.coverage_rows))
                ),
            ),
        ):
            patcher = mock.patch.object(dc, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _run(self, applied_rows, *, live=True, index=None):
        with _capture_stderr() as buf:
            report = dc.discharge_applied_patterns(
                applied_rows, _index() if index is None else index, live=live
            )
        return report, buf.getvalue()

    def test_when_live_then_only_the_linked_row_transitions(self):
        # LABEL_REACT_3 covers rows 7, 1 and 5; the link names 5 alone, and only 5 moves.
        report, _ = self._run([(11, 5)])
        self.assertEqual([row_id for row_id, _ in self.calls], [5])
        self.assertIn("proposal id=11", self.calls[0][1])
        self.assertEqual(report.discharged, [5])

    def test_when_a_proposal_carries_no_link_then_nothing_transitions(self):
        report, err = self._run([(12, None)])
        self.assertEqual(self.calls, [])
        self.assertEqual(report.unlinked, [12])
        self.assertEqual(report.discharged, [])
        self.assertIn("1 unlinked", err)

    def test_when_the_linked_row_left_intake_then_nothing_transitions_and_only_terminal_is_quiet(
        self,
    ):
        # Row 6 is parked, so the intake read drops it; a non-terminal row there is
        # stranded once the window passes, so only a terminal one may stay quiet.
        row_6 = next(row for row in STORED_ROWS if row["id"] == 6)
        intake_miss_event = (
            dc.DISCHARGE_EVENT_INTAKE_MISS,
            "proposal:13",
            "glass-atrium-dev-nestjs",
        )
        for name, coverage_rows, live, warning, events in (
            ("terminal row", (dict(row_6, status="applied"),), True, "", []),
            (
                "non-terminal row, writing cycle",
                (row_6,),
                True,
                "discharge-intake-miss",
                [intake_miss_event],
            ),
            (
                "non-terminal row, no-write cycle",
                (row_6,),
                False,
                "discharge-intake-miss",
                [],
            ),
            ("row absent from the status-agnostic read", (), True, "absent", []),
            ("status-agnostic read outage", None, True, "outage", []),
        ):
            with self.subTest(name):
                _EMITTED.clear()
                self.coverage_rows = coverage_rows
                report, err = self._run(
                    [(13, 6)], live=live, index=_index(PARKED_INTAKE_ROWS)
                )
                warnings = "\n".join(line for line in err.splitlines() if "WARN" in line)
                self.assertEqual(self.calls, [])
                self.assertEqual(report.outside_intake, [13])
                self.assertEqual(bool(warnings), bool(warning), err)
                self.assertIn(warning, warnings)
                self.assertEqual(
                    [
                        (e["args"]["eval_result"], e["args"]["subject"], e["args"]["agent"])
                        for e in _EMITTED
                    ],
                    events,
                )

    def test_when_dry_run_then_no_transition_and_the_linked_row_on_the_log_line(self):
        report, err = self._run([(11, 5), (12, None)], live=False)
        self.assertEqual(self.calls, [])
        self.assertEqual(report.would_discharge, [5])
        self.assertEqual(report.discharged, [])
        self.assertIn("dry-run", err)
        self.assertIn("[5]", err)

    def test_when_a_read_is_unavailable_then_outage_is_distinct_from_an_empty_window(self):
        for name, rows, index in (
            ("applied-proposal read", None, _index()),
            ("pattern read", [(11, 5)], None),
        ):
            with self.subTest(outage=name):
                self.calls.clear()
                with _capture_stderr() as buf:
                    report = dc.discharge_applied_patterns(rows, index, live=True)
                self.assertTrue(report.outage)
                self.assertEqual(self.calls, [])
                self.assertIn("outage", buf.getvalue().lower())

        empty, _ = self._run([])
        self.assertFalse(empty.outage)
        self.assertEqual(empty.would_discharge, [])

    def test_when_transition_call_fails_then_it_is_reported_as_failed(self):
        self.outcomes = {5: dc.DISCHARGE_FAILED}
        report, err = self._run([(11, 5), (14, 7)])
        self.assertEqual(report.failed, [5])
        self.assertEqual(report.discharged, [7])
        self.assertIn("discharge transition failed", err)

    def test_when_row_turns_terminal_between_read_and_update_then_not_matched_not_failed(self):
        # The SQL terminal guard's race answer — distinct from a row the intake
        # read already dropped, which never reaches the update.
        self.outcomes = {5: dc.DISCHARGE_NOT_MATCHED}
        report, _ = self._run([(11, 5)])
        self.assertEqual(report.failed, [])
        self.assertEqual(report.discharged, [])

    def test_when_selecting_the_window_then_applied_proposals_carry_their_link(self):
        # The fetch is the sole row source, so a rejected or still-pending
        # proposal can never enter the stage — pinned on the select predicate.
        sql = dc._APPLIED_FOR_DISCHARGE_SELECT_SQL
        self.assertIn("SELECT id, learning_pattern_id", sql)
        self.assertIn("status::text = 'applied'", sql)
        self.assertNotIn("LIMIT", sql.upper())


class DischargeCycleWiringTest(unittest.TestCase):
    """The cycle discharges live with no opt-in; a --dry-run cycle discharges nothing."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "agents").mkdir()
        env = mock.patch.dict(os.environ, {"GA_DATA_ROOT": str(self.root)})
        env.start()
        self.addCleanup(env.stop)
        # No opt-in in the environment: a writing cycle discharges on its own.
        os.environ.pop("AUTOAGENT_DISCHARGE_LIVE", None)
        index = _index()
        self.pg_reach = seal_pg_reach(self)
        set_install_tree(self)
        self.discharged: list[int] = []
        # After the seal: the fetch and the pattern read stand in for the database
        # boundary, and the transition seam records instead of refusing.
        for name, value in (
            ("get_pattern_rows_by_agent", lambda: index),
            ("_fetch_applied_for_discharge", lambda: [(11, 5), (12, None)]),
            ("_pg_discharge_learning_pattern", self._record_discharge),
        ):
            patcher = mock.patch.object(dc, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # Knobs load at import from this install's daemon-config.json → pin all unset.
        # The pause gate reads (and expires) the install's own update-state flag → off.
        unset = TierKnobs("", "")
        for patcher in (
            mock.patch.object(dc, "KNOB_ERRORS", {}),
            mock.patch.dict(dc.TIER_KNOBS, {"worker": unset, "pre_verify": unset}),
            mock.patch.object(dc, "HAS_PAUSE_LIB", False),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def _record_discharge(self, row_id: int, reason: str):
        self.discharged.append(row_id)
        return dc.DischargeResult(dc.DISCHARGE_APPLIED, row_id)

    def test_when_a_writing_cycle_runs_then_the_linked_row_discharges(self):
        with _capture_stderr():
            dc.run_cycle(
                log_path=self.root / "learning-log.md",
                agents_dir=self.root / "agents",
                skip_haiku=True,
                skip_pre_verify=True,
                skip_loop_emit=False,
            )
        self.assertEqual(self.discharged, [5])
        self.assertEqual(self.pg_reach, [])

    def test_when_a_dry_run_cycle_runs_then_nothing_discharges(self):
        argv = [
            "--dry-run",
            "--log-path", str(self.root / "learning-log.md"),
            "--agents-dir", str(self.root / "agents"),
        ]
        with _capture_stderr() as err, contextlib.redirect_stdout(io.StringIO()):
            rc = dc._main(argv)
        self.assertEqual(rc, 0, err.getvalue())
        self.assertEqual(self.discharged, [])
        self.assertIn("would-discharge 1 row(s) [5]", err.getvalue())
        self.assertEqual(self.pg_reach, [])


class CensusEmitClassTest(unittest.TestCase):
    """Census emitters carry no subject, so they keep the (event_ts, agent, cause) key."""

    def setUp(self):
        _EMITTED.clear()

    def test_when_the_gate_skips_then_the_row_carries_no_subject(self):
        with _capture_stderr():
            dc._warn_pattern_skip(
                "glass-atrium-dev-react",
                "some label|glass-atrium-dev-react",
                "2026-09-21",
                eval_result=dc.PAIR_FAIL_EVAL,
                reason="budget_overage pair from 2026-09-07: fail",
            )
        self.assertEqual([e["args"]["subject"] for e in _EMITTED], [None])

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
                    dc.MANIFEST_SPOOL_CLOSED_EVAL_RESULT,
                )
            ),
        )


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
