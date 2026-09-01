"""Behavioral tests for the contested-gap arbiter module (D1 / A2-A5).

Covered behaviors:
  * prompt assembly -> the three anchors arrive numbered, with the region
    ordinal, the three choice tokens, the no-drop and no-stale statements, the
    compliance carve-out and the no-authoring clause;
  * invocation -> the argv carries the model id and the per-call cap the daemon
    config loader resolved, and a config override applied in a FRESH SUBPROCESS
    changes the invoked model with no edit to this module;
  * the strict answer contract -> every member of the malformed corpus yields
    the unparseable classification and never a default choice, each of the three
    tokens parses, and a reference naming a base-present line parses here and is
    rejected by the assertion instead;
  * the provenance clauses -> a fixture breaking exactly one clause names that
    clause, the driven adjacency interleave passes, both old concatenation
    orders fail the stale clause on that same driven fixture, both pass on the
    both-insert control whose base gap is empty, and a line both sides added is
    kept once rather than dropped or duplicated;
  * the failure ladder -> each of the six classes lands the local run with a
    distinct named row, a timeout spends one escalated retry, an unparseable
    answer spends one strict retry, the other four spend none, and an
    over-ceiling run emits exactly one summary row;
  * the residual counters -> a whole-side answer carries the discarded novel
    count and a resolved interleave carries the base-present rejected count.

Every model seam is a stub binary: no drive invokes the headless CLI.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_gap_arbiter.py -v
    python3 -m unittest autoagent.test.test_gap_arbiter -v
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_LIB_DIR = _AUTOAGENT_DIR / "lib"

for _p in (_AUTOAGENT_DIR, _LIB_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

try:
    import editable_merge as em
    import gap_arbiter as ga

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — import failure -> skip, not error
    em = None  # type: ignore[assignment]
    ga = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


_STUB = """#!/bin/sh
if [ -n "$ARB_STUB_ARGV" ]; then printf '%s\\n' "$@" >> "$ARB_STUB_ARGV"; fi
if [ -n "$ARB_STUB_COUNT" ]; then printf 'x' >> "$ARB_STUB_COUNT"; fi
if [ -n "$ARB_STUB_SLEEP" ]; then sleep "$ARB_STUB_SLEEP"; fi
if [ -n "$ARB_STUB_ANSWER" ]; then printf '%s\\n' "$ARB_STUB_ANSWER"; fi
exit "${ARB_STUB_EXIT:-0}"
"""


def _write_stub(dirpath: Path) -> str:
    stub = dirpath / "claude-stub"
    stub.write_text(_STUB, encoding="utf-8")
    stub.chmod(0o755)
    return str(stub)


def _adjacency_request() -> "ga.GapRequest":
    """Build the pass-1 adjacency gap through the real merge, not a paraphrase."""
    _merged, hunks = em.three_way_merge_hunks(
        ["- rule A", "- rule B"],
        ["- rule A improved", "- rule B"],
        ["- rule A", "- rule B generalised"],
        arbitrate=True,
    )
    hunk = hunks[0]
    return ga.GapRequest(
        agent="glass-atrium-dev-python",
        region_index=2,
        region_count=3,
        region_context="surrounding prose",
        base_lines=hunk.base,
        local_lines=hunk.local,
        release_lines=hunk.release,
    )


def _both_insert_request() -> "ga.GapRequest":
    """Build the both-insert control gap, whose base tuple the merge leaves empty."""
    _merged, hunks = em.three_way_merge_hunks(
        ["- rule A"],
        ["- rule A", "- local insert"],
        ["- rule A", "- release insert"],
        arbitrate=True,
    )
    hunk = hunks[0]
    return ga.GapRequest(
        agent="glass-atrium-dev-python",
        region_index=1,
        region_count=1,
        region_context="surrounding prose",
        base_lines=hunk.base,
        local_lines=hunk.local,
        release_lines=hunk.release,
    )


def _both_sides_request() -> "ga.GapRequest":
    """Build a gap whose two runs share one line — the shape the keep clauses read
    by value rather than by position, and the only one that can duplicate."""
    return ga.GapRequest(
        agent="glass-atrium-dev-python",
        region_index=1,
        region_count=1,
        region_context="surrounding prose",
        base_lines=(),
        local_lines=("- shared", "- local only"),
        release_lines=("- shared", "- release only"),
    )


def _answer(choice: str, refs: tuple[tuple[str, int], ...] = ()) -> "ga.Answer":
    return ga.Answer(
        choice=choice,
        refs=tuple(ga.LineRef(source=s, ordinal=o) for s, o in refs),
        rationale="fixture",
    )


@unittest.skipIf(_IMPORT_ERROR is not None, f"module import failed: {_IMPORT_ERROR}")
class PromptAssemblyTest(unittest.TestCase):
    def test_numbering_makes_every_anchor_line_referenceable(self):
        prompt = ga.build_prompt(_adjacency_request())
        for token in ("B1: - rule A", "L1: - rule A improved", "R2: - rule B generalised"):
            self.assertIn(token, prompt)

    def test_carries_region_ordinal_and_the_three_choice_tokens(self):
        prompt = ga.build_prompt(_adjacency_request())
        self.assertIn("editable region 2 of 3", prompt)
        for choice in ga.CHOICES:
            self.assertIn(choice, prompt)

    def test_states_the_no_drop_and_no_stale_clauses_in_the_models_own_terms(self):
        prompt = ga.build_prompt(_adjacency_request())
        self.assertIn("must be in your list", prompt)
        self.assertIn("must NOT be listed", prompt)

    def test_carves_compliance_out_and_forbids_authoring(self):
        prompt = ga.build_prompt(_adjacency_request())
        self.assertIn("separate compliance verifier", prompt)
        self.assertIn("Do NOT write new text", prompt)

    def test_an_empty_anchor_is_rendered_rather_than_collapsing_the_section(self):
        request = _both_insert_request()
        self.assertEqual(request.base_lines, ())
        self.assertIn("(empty)", ga.build_prompt(request))


@unittest.skipIf(_IMPORT_ERROR is not None, f"module import failed: {_IMPORT_ERROR}")
class ConfigSourceTest(unittest.TestCase):
    def test_argv_carries_the_model_and_cap_the_loader_resolved(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            argv = tmpdir / "argv"
            env = {
                "ARB_STUB_ARGV": str(argv),
                "ARB_STUB_ANSWER": "CHOICE: LOCAL\nRATIONALE: fixture",
            }
            with mock.patch.dict(os.environ, env):
                ga.get_decision(
                    _adjacency_request(),
                    run_state=ga.RunState(ceiling=4),
                    claude_bin=_write_stub(tmpdir),
                )
            recorded = argv.read_text(encoding="utf-8").splitlines()
        self.assertEqual(recorded[recorded.index("--model") + 1], ga.WORKER_MODEL)
        self.assertEqual(
            recorded[recorded.index("--max-budget-usd") + 1], ga.WORKER_MAX_BUDGET_USD
        )

    def test_a_config_override_in_a_fresh_subprocess_changes_the_invoked_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            argv = tmpdir / "argv"
            config = tmpdir / "daemon-config.json"
            config.write_text(
                json.dumps(
                    {"worker_model": "fixture-model-id", "worker_max_budget_usd": "1.25"}
                ),
                encoding="utf-8",
            )
            driver = tmpdir / "driver.py"
            driver.write_text(
                textwrap.dedent(
                    f"""
                    import sys
                    sys.path.insert(0, {str(_LIB_DIR)!r})
                    import gap_arbiter as ga
                    request = ga.GapRequest(
                        agent="a", region_index=1, region_count=1,
                        region_context="c", base_lines=(), local_lines=("l",),
                        release_lines=("r",),
                    )
                    ga.get_decision(
                        request,
                        run_state=ga.RunState(ceiling=4),
                        claude_bin={_write_stub(tmpdir)!r},
                    )
                    """
                ),
                encoding="utf-8",
            )
            completed = subprocess.run(
                [sys.executable, str(driver)],
                capture_output=True,
                text=True,
                check=False,
                timeout=120,
                env={
                    **os.environ,
                    "DAEMON_CONFIG": str(config),
                    "ARB_STUB_ARGV": str(argv),
                    "ARB_STUB_ANSWER": "CHOICE: LOCAL\nRATIONALE: fixture",
                },
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            recorded = argv.read_text(encoding="utf-8").splitlines()
        self.assertEqual(recorded[recorded.index("--model") + 1], "fixture-model-id")
        self.assertEqual(recorded[recorded.index("--max-budget-usd") + 1], "1.25")

    def test_the_module_declares_no_model_id_and_no_second_budget_constant(self):
        source = (_LIB_DIR / "gap_arbiter.py").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r'=\s*"(haiku|sonnet|opus|claude-)[^"]*"', source))
        self.assertIsNone(re.search(r'=\s*"\d+\.\d\d"', source))
        self.assertIn("from daemon_config import", source)

    def test_the_run_ceiling_comes_from_the_loaders_own_config_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "daemon-config.json"
            config.write_text(json.dumps({ga.RUN_CEILING_KEY: 7}), encoding="utf-8")
            self.assertEqual(ga.get_run_ceiling(config), 7)
            config.write_text(json.dumps({"worker_model": "x"}), encoding="utf-8")
            absent_key = ga.get_run_ceiling(config)
            config.write_text("{not json", encoding="utf-8")
            self.assertEqual(ga.get_run_ceiling(config), absent_key)
            self.assertGreater(absent_key, 0)
            # bool is an int subclass: `true` must take the fallback, not read as 1.
            config.write_text(json.dumps({ga.RUN_CEILING_KEY: True}), encoding="utf-8")
            self.assertEqual(ga.get_run_ceiling(config), absent_key)

    def test_the_named_counter_file_spans_the_run_and_its_absence_spans_the_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            counter = Path(tmp) / "arbiter-calls"
            with mock.patch.dict(os.environ, {ga.COUNTER_ENV: str(counter)}):
                first_process = ga.RunState()
                first_process.spend_call()
                first_process.spend_call()
                # A SECOND plan process of the same run reads what the first spent.
                self.assertEqual(ga.RunState().get_spent(), 2)
            with mock.patch.dict(os.environ, {ga.COUNTER_ENV: ""}):
                unnamed = ga.RunState()
                unnamed.spend_call()
                self.assertEqual(unnamed.get_spent(), 1)
                self.assertEqual(ga.RunState().get_spent(), 0)


@unittest.skipIf(_IMPORT_ERROR is not None, f"module import failed: {_IMPORT_ERROR}")
class AnswerParseTest(unittest.TestCase):
    def test_every_malformed_shape_yields_the_unparseable_classification(self):
        corpus = {
            "fenced": "```\nCHOICE: LOCAL\nRATIONALE: r\n```",
            "prose prefix": "Sure!\nCHOICE: LOCAL\nRATIONALE: r",
            "wrong token": "CHOICE: BOTH\nRATIONALE: r",
            "missing rationale": "CHOICE: LOCAL",
            "two choice lines": "CHOICE: LOCAL\nCHOICE: RELEASE\nRATIONALE: r",
            "list with a whole-side token": "CHOICE: LOCAL\nLINES: L1\nRATIONALE: r",
            "no list with interleave": "CHOICE: INTERLEAVE\nRATIONALE: r",
            "unknown source letter": "CHOICE: INTERLEAVE\nLINES: B1, R2\nRATIONALE: r",
            "non-numeric ordinal": "CHOICE: INTERLEAVE\nLINES: L1, Rx\nRATIONALE: r",
            "empty list member": "CHOICE: INTERLEAVE\nLINES: L1, , R2\nRATIONALE: r",
        }
        for label, text in corpus.items():
            with self.subTest(label):
                self.assertIsNone(ga.parse_answer(text))

    def test_each_of_the_three_tokens_parses(self):
        for choice in (ga.CHOICE_LOCAL, ga.CHOICE_RELEASE):
            with self.subTest(choice):
                answer = ga.parse_answer(f"CHOICE: {choice}\nRATIONALE: because")
                self.assertEqual((answer.choice, answer.refs), (choice, ()))
        answer = ga.parse_answer("CHOICE: INTERLEAVE\nLINES: R2, L1\nRATIONALE: because")
        self.assertEqual(answer.choice, ga.CHOICE_INTERLEAVE)
        self.assertEqual(answer.rationale, "because")

    def test_the_reference_list_keeps_the_order_the_model_emitted(self):
        answer = ga.parse_answer("CHOICE: INTERLEAVE\nLINES: R2, L1\nRATIONALE: r")
        self.assertEqual(
            [(ref.source, ref.ordinal) for ref in answer.refs], [("R", 2), ("L", 1)]
        )

    def test_a_base_present_reference_parses_here_and_is_rejected_by_the_assertion(self):
        answer = ga.parse_answer("CHOICE: INTERLEAVE\nLINES: L1, L2, R2\nRATIONALE: r")
        self.assertIsNotNone(answer)
        self.assertEqual(
            ga.find_clause_failure(_adjacency_request(), answer), ga.CLAUSE_NO_STALE
        )


@unittest.skipIf(_IMPORT_ERROR is not None, f"module import failed: {_IMPORT_ERROR}")
class ProvenanceAssertionTest(unittest.TestCase):
    def test_a_whole_side_choice_breaks_no_clause_and_resolves_to_that_anchor(self):
        request = _adjacency_request()
        for choice, expected in (
            (ga.CHOICE_LOCAL, request.local_lines),
            (ga.CHOICE_RELEASE, request.release_lines),
        ):
            with self.subTest(choice):
                answer = _answer(choice)
                self.assertIsNone(ga.find_clause_failure(request, answer))
                self.assertEqual(ga.build_gap_lines(request, answer), expected)

    def test_each_clause_is_named_by_a_fixture_breaking_exactly_it(self):
        adjacency = _adjacency_request()
        monotone_request = ga.GapRequest(
            agent="a",
            region_index=1,
            region_count=1,
            region_context="c",
            base_lines=("b1",),
            local_lines=("l1", "l2"),
            release_lines=("r1",),
        )
        cases = (
            (ga.CLAUSE_RESOLVABLE, adjacency, (("L", 9),)),
            (ga.CLAUSE_NO_REPETITION, adjacency, (("L", 1), ("L", 1), ("R", 2))),
            (
                ga.CLAUSE_MONOTONE,
                monotone_request,
                (("L", 2), ("L", 1), ("R", 1)),
            ),
            (ga.CLAUSE_NO_DROP_OF_NOVEL, adjacency, (("L", 1),)),
            (ga.CLAUSE_NO_STALE, adjacency, (("L", 1), ("L", 2), ("R", 2))),
            (
                ga.CLAUSE_NO_DUPLICATE,
                _both_sides_request(),
                (("L", 1), ("R", 1), ("L", 2), ("R", 2)),
            ),
        )
        for clause, request, refs in cases:
            with self.subTest(clause):
                answer = _answer(ga.CHOICE_INTERLEAVE, refs)
                self.assertEqual(ga.find_clause_failure(request, answer), clause)

    def test_the_driven_adjacency_interleave_passes_and_emits_both_edits(self):
        request = _adjacency_request()
        answer = _answer(ga.CHOICE_INTERLEAVE, (("L", 1), ("R", 2)))
        self.assertIsNone(ga.find_clause_failure(request, answer))
        self.assertEqual(
            ga.build_gap_lines(request, answer),
            ("- rule A improved", "- rule B generalised"),
        )

    def test_both_old_concatenations_fail_the_stale_clause_on_the_driven_adjacency_gap(self):
        request = _adjacency_request()
        orders = {
            "local then release": (("L", 1), ("L", 2), ("R", 1), ("R", 2)),
            "release then local": (("R", 1), ("R", 2), ("L", 1), ("L", 2)),
        }
        for label, refs in orders.items():
            with self.subTest(label):
                answer = _answer(ga.CHOICE_INTERLEAVE, refs)
                self.assertEqual(
                    ga.find_clause_failure(request, answer), ga.CLAUSE_NO_STALE
                )

    def test_both_concatenations_pass_on_the_empty_base_gap_control(self):
        request = _both_insert_request()
        for label, refs in (
            ("local then release", (("L", 1), ("R", 1))),
            ("release then local", (("R", 1), ("L", 1))),
        ):
            with self.subTest(label):
                answer = _answer(ga.CHOICE_INTERLEAVE, refs)
                self.assertIsNone(ga.find_clause_failure(request, answer))
                self.assertEqual(len(ga.build_gap_lines(request, answer)), 2)

    def test_a_line_both_sides_added_is_listed_once_and_lands_once(self):
        request = _both_sides_request()
        answer = _answer(ga.CHOICE_INTERLEAVE, (("L", 1), ("L", 2), ("R", 2)))
        self.assertIsNone(ga.find_clause_failure(request, answer))
        self.assertEqual(
            ga.build_gap_lines(request, answer),
            ("- shared", "- local only", "- release only"),
        )

    def test_a_line_repeated_within_one_run_must_be_kept_as_often_as_it_occurs(self):
        request = ga.GapRequest(
            agent="a",
            region_index=1,
            region_count=1,
            region_context="c",
            base_lines=(),
            local_lines=("- twice", "- twice"),
            release_lines=("- release only",),
        )
        short = _answer(ga.CHOICE_INTERLEAVE, (("L", 1), ("R", 1)))
        self.assertEqual(
            ga.find_clause_failure(request, short), ga.CLAUSE_NO_DROP_OF_NOVEL
        )
        full = _answer(ga.CHOICE_INTERLEAVE, (("L", 1), ("L", 2), ("R", 1)))
        self.assertIsNone(ga.find_clause_failure(request, full))

    def test_a_dropped_novel_line_is_rejected_before_the_stale_clause_is_reached(self):
        request = _adjacency_request()
        answer = _answer(ga.CHOICE_INTERLEAVE, (("L", 1), ("L", 2)))
        self.assertEqual(
            ga.find_clause_failure(request, answer), ga.CLAUSE_NO_DROP_OF_NOVEL
        )


@unittest.skipIf(_IMPORT_ERROR is not None, f"module import failed: {_IMPORT_ERROR}")
class ResidualCountTest(unittest.TestCase):
    def test_a_whole_side_answer_counts_the_novel_lines_it_discards(self):
        request = _adjacency_request()
        self.assertEqual(ga.count_discarded_novel(request, ga.CHOICE_LOCAL), 1)
        self.assertEqual(ga.count_discarded_novel(request, ga.CHOICE_RELEASE), 1)
        self.assertEqual(ga.count_discarded_novel(request, ga.CHOICE_INTERLEAVE), 0)

    def test_a_resolved_interleave_counts_the_base_present_lines_the_stale_clause_rejects(self):
        self.assertEqual(ga.count_rejected_stale(_adjacency_request()), 2)
        self.assertEqual(ga.count_rejected_stale(_both_insert_request()), 0)


@unittest.skipIf(_IMPORT_ERROR is not None, f"module import failed: {_IMPORT_ERROR}")
class FailureLadderTest(unittest.TestCase):
    def _drive(self, env, *, ceiling=4, claude_bin=None, tmpdir=None, **kwargs):
        request = _adjacency_request()
        # A fresh counter per drive — the stub appends, so a shared path would
        # carry the previous case's calls into this one's assertion.
        count = Path(tempfile.mkdtemp(dir=tmpdir)) / "count"
        run_state = ga.RunState(ceiling=ceiling)
        with mock.patch.dict(os.environ, {**env, "ARB_STUB_COUNT": str(count)}):
            decision = ga.get_decision(
                request,
                run_state=run_state,
                claude_bin=claude_bin or _write_stub(Path(tmpdir)),
                **kwargs,
            )
        calls = len(count.read_text(encoding="utf-8")) if count.exists() else 0
        return request, decision, run_state, calls

    def test_each_failure_class_lands_local_with_its_own_named_row(self):
        rows = set()
        with tempfile.TemporaryDirectory() as tmp:
            cases = {
                ga.FAILURE_TIMEOUT: (
                    {"ARB_STUB_SLEEP": "3"},
                    {"timeout_sec": 1, "escalated_timeout_sec": 1},
                    2,
                ),
                ga.FAILURE_BUDGET: ({"ARB_STUB_EXIT": "1"}, {}, 1),
                ga.FAILURE_UNPARSEABLE: ({"ARB_STUB_ANSWER": "sure thing"}, {}, 2),
                ga.FAILURE_ASSERTION: (
                    {
                        "ARB_STUB_ANSWER": "CHOICE: INTERLEAVE\n"
                        "LINES: L1, L2, R1, R2\nRATIONALE: r"
                    },
                    {},
                    1,
                ),
            }
            for failure_class, (env, kwargs, expected_calls) in cases.items():
                with self.subTest(failure_class):
                    request, decision, _state, calls = self._drive(
                        env, tmpdir=tmp, **kwargs
                    )
                    self.assertEqual(decision.failure_class, failure_class)
                    self.assertEqual(decision.lines, request.local_lines)
                    self.assertEqual(calls, expected_calls)
                    self.assertIn(request.agent, decision.row)
                    self.assertIn("region=2/3", decision.row)
                    rows.add(decision.row)

            request, decision, _state, calls = self._drive(
                {}, tmpdir=tmp, claude_bin=str(Path(tmp) / "absent-binary")
            )
            self.assertEqual(decision.failure_class, ga.FAILURE_UNAVAILABLE)
            self.assertEqual(decision.lines, request.local_lines)
            self.assertEqual(calls, 0)
            rows.add(decision.row)

            request, decision, _state, calls = self._drive({}, ceiling=0, tmpdir=tmp)
            self.assertEqual(decision.failure_class, ga.FAILURE_RUN_CEILING)
            self.assertEqual(decision.lines, request.local_lines)
            self.assertEqual(calls, 0)
            rows.add(decision.row)

        self.assertEqual(len(rows), 6)

    def test_the_assertion_row_names_the_clause_that_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            _request, decision, _state, _calls = self._drive(
                {
                    "ARB_STUB_ANSWER": "CHOICE: INTERLEAVE\n"
                    "LINES: L1, L2, R1, R2\nRATIONALE: r"
                },
                tmpdir=tmp,
            )
        self.assertEqual(decision.clause, ga.CLAUSE_NO_STALE)
        self.assertIn(f"clause={ga.CLAUSE_NO_STALE}", decision.row)

    def test_a_gap_admitted_on_the_last_slot_spends_one_call_past_the_ceiling(self):
        with tempfile.TemporaryDirectory() as tmp:
            _request, decision, run_state, calls = self._drive(
                {"ARB_STUB_SLEEP": "3"},
                ceiling=1,
                tmpdir=tmp,
                timeout_sec=1,
                escalated_timeout_sec=1,
            )
        self.assertEqual(decision.failure_class, ga.FAILURE_TIMEOUT)
        self.assertEqual(calls, 2)
        self.assertEqual(run_state.calls, 2)

    def test_an_over_ceiling_run_emits_one_summary_row_not_one_per_gap(self):
        request = _adjacency_request()
        run_state = ga.RunState(ceiling=0)
        rows = [
            ga.get_decision(request, run_state=run_state, claude_bin="unused").row
            for _ in range(3)
        ]
        self.assertTrue(rows[0])
        self.assertEqual(rows[1:], ["", ""])

    def test_a_judged_answer_carries_its_choice_rationale_and_resolved_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            request, decision, _state, calls = self._drive(
                {
                    "ARB_STUB_ANSWER": "CHOICE: INTERLEAVE\n"
                    "LINES: L1, R2\nRATIONALE: independent edits"
                },
                tmpdir=tmp,
            )
        self.assertIsNone(decision.failure_class)
        self.assertEqual(decision.choice, ga.CHOICE_INTERLEAVE)
        self.assertEqual(decision.rationale, "independent edits")
        self.assertEqual(
            decision.lines, ("- rule A improved", "- rule B generalised")
        )
        self.assertEqual(decision.rejected_stale, 2)
        self.assertEqual(calls, 1)

    def test_a_whole_side_judgment_reports_the_novel_lines_it_discarded(self):
        with tempfile.TemporaryDirectory() as tmp:
            request, decision, _state, _calls = self._drive(
                {"ARB_STUB_ANSWER": "CHOICE: LOCAL\nRATIONALE: weaker restatement"},
                tmpdir=tmp,
            )
        self.assertEqual(decision.lines, request.local_lines)
        self.assertEqual(decision.discarded_novel, 1)
        self.assertEqual(decision.rejected_stale, 0)


if __name__ == "__main__":
    unittest.main()
