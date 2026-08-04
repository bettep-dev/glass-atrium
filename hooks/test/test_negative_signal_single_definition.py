#!/usr/bin/env python3
"""D3 — the negative-signal predicate has exactly ONE definition, importable without psycopg.

``hooks/learning-aggregator.py`` carried a second hand-written copy of the OR-terms
(``_record_is_negative``) that had drifted from the shared
``_pg_learning_dualwrite.negative_signal_hits`` in five terms, and both copies ran over the
SAME batch in one production pass. The mirror existed only because the shared module dies on
a missing psycopg at import; the predicate body itself never touched the driver. The rules
now live in the stdlib-only ``hooks/_outcome_signal.py``.

Three things are pinned here, all of which fail against the pre-extraction tree:
(1) the driver-absent import path — including the SystemExit hazard the extraction had to
    route around (``_pg_outcome_dualwrite`` calls ``sys.exit()`` at module scope, and
    SystemExit is a BaseException no ``except Exception`` guard catches);
(2) the deliberately re-added ``evaluative_signal == -1`` OR-term, which existed only in the
    mirror and would otherwise have been dropped by the collapse;
(3) the measured routing change at the mirror's call site — the shared carve-outs move rows
    OUT of failure memory, and a genuine failure still lands in it.

    python3 -m unittest hooks.test.test_negative_signal_single_definition -v
"""

from __future__ import annotations

import contextlib
import importlib
import importlib.util
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))

import _outcome_signal  # noqa: E402 — sys.path insert immediately above

_BLOCKED_ROOTS = ("psycopg",)
# Every module whose import result depends on psycopg being present — cleared for the
# duration of the block so a cached instance from a sibling test file cannot answer the
# import, and restored after so this file does not decide their skip for them.
_DRIVER_DEPENDENT = (
    "psycopg",
    "psycopg.errors",
    "_pg_outcome_dualwrite",
    "_pg_learning_dualwrite",
)


class _RefuseDriver:
    """Meta-path finder that makes psycopg genuinely unimportable."""

    @staticmethod
    def find_spec(fullname, path=None, target=None):  # noqa: ANN205 — finder protocol
        root = fullname.split(".", 1)[0]
        if root in _BLOCKED_ROOTS:
            raise ImportError(f"No module named {fullname!r} (blocked by test)")
        return None


@contextlib.contextmanager
def _psycopg_absent():
    saved = {name: sys.modules.get(name) for name in _DRIVER_DEPENDENT}
    for name in _DRIVER_DEPENDENT:
        sys.modules.pop(name, None)
    finder = _RefuseDriver()
    sys.meta_path.insert(0, finder)
    try:
        yield
    finally:
        sys.meta_path.remove(finder)
        for name, prior in saved.items():
            if prior is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prior


def _load_fresh(probe_name: str, path: Path):
    """Execute a module file into a throwaway module object, leaving sys.modules alone.

    Deliberately not importlib.reload: sibling suites in the same discovery run hold
    references into the already-imported module objects, and rebinding those would break
    the identity assertions below for reasons unrelated to the code under test. Also the
    only way to import learning-aggregator.py at all (dashed filename); its main() is
    guarded, so execution runs no aggregation."""
    spec = importlib.util.spec_from_file_location(probe_name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _load_aggregator():
    return _load_fresh("learning_aggregator_d3_probe", _HOOKS_DIR / "learning-aggregator.py")


def _row(**over):
    base = {
        "agent": "glass-atrium-dev-python",
        "task_type": "feature",
        "result": "done",
        "revision_count": 0,
        "review_flag": False,
        "grader_verdict": "",
        "attribution_source": "hook-input",
    }
    base.update(over)
    return base


def _lesson_row(**over):
    row = _row(metric_pass=True, confidence="high", lesson="x")
    row.update(over)
    return row


class DriverAbsentImport(unittest.TestCase):
    """The extraction's whole point: the rules load on the path the shared module dies on."""

    def test_when_psycopg_absent_then_rules_module_imports(self):
        with _psycopg_absent():
            module = _load_fresh("_outcome_signal_d3_probe", _HOOKS_DIR / "_outcome_signal.py")
            self.assertTrue(module.is_negative_signal_outcome({"result": "fail"}))

    def test_when_psycopg_absent_then_aggregator_imports_without_systemexit(self):
        # SystemExit, not an exception: a naive extraction that let _role_task_type_allowed
        # keep pulling _pg_outcome_dualwrite would terminate this process instead of
        # failing an assertion, so the guard is on the IMPORT itself.
        with _psycopg_absent():
            try:
                agg = _load_aggregator()
            except SystemExit as exc:  # noqa: PERF203 — the hazard under test
                self.fail(f"aggregator import raised SystemExit({exc.code})")
            self.assertFalse(agg.HAS_PG_DUALWRITE)
            self.assertEqual(agg.classify_lesson_bucket({"result": "fail"}), "epm")
            self.assertIn("evaluative_signal=-1", agg._NEGATIVE_SIGNAL_NAMES)

    def test_when_psycopg_absent_then_dualwrite_import_still_kills_the_process(self):
        # Pins the hazard the extraction routes around — if this ever stops raising,
        # the SystemExit shield question is settled at the source instead.
        with _psycopg_absent():
            with self.assertRaises(SystemExit):
                importlib.import_module("_pg_outcome_dualwrite")


class SingleDefinition(unittest.TestCase):
    """One function object, reached by every consumer."""

    def test_when_aggregator_read_then_no_second_predicate(self):
        agg = _load_aggregator()
        self.assertFalse(hasattr(agg, "_record_is_negative"))
        self.assertIs(
            agg._is_negative_signal_outcome, _outcome_signal.is_negative_signal_outcome
        )

    @unittest.skipIf(
        importlib.util.find_spec("psycopg") is None, "psycopg absent: re-export unreachable"
    )
    def test_when_pg_helper_read_then_reexports_the_same_object(self):
        pgdw = importlib.import_module("_pg_learning_dualwrite")
        self.assertIs(pgdw.negative_signal_hits, _outcome_signal.negative_signal_hits)
        self.assertIs(
            pgdw.is_negative_signal_outcome, _outcome_signal.is_negative_signal_outcome
        )
        self.assertIs(pgdw.NEGATIVE_SIGNAL_NAMES, _outcome_signal.NEGATIVE_SIGNAL_NAMES)


class EvaluativeSignalTerm(unittest.TestCase):
    """The mirror-only term survives the collapse, for BOTH call sites' value types."""

    def test_when_correction_signal_then_counts_as_int_or_string(self):
        for raw in (-1, "-1", " -1 "):
            with self.subTest(raw=raw):
                self.assertEqual(
                    _outcome_signal.negative_signal_hits(_row(evaluative_signal=raw)),
                    ("evaluative_signal=-1",),
                )

    def test_when_neutral_or_positive_then_no_hit(self):
        for raw in (0, "0", 1, "1", "", None, "-10"):
            with self.subTest(raw=raw):
                self.assertEqual(
                    _outcome_signal.negative_signal_hits(_row(evaluative_signal=raw)), ()
                )

    def test_when_term_named_then_dead_signal_detector_sees_it(self):
        # The tuple is the per-name breakdown contract the dead-signal detector iterates;
        # a term missing from it never gets reported as dead.
        self.assertIn("evaluative_signal=-1", _outcome_signal.NEGATIVE_SIGNAL_NAMES)


class ReviewFlagTerm(unittest.TestCase):
    """Parsed by value like its siblings, so a string-carrying row cannot trip on "false"."""

    def test_when_flag_set_then_counts_as_bool_or_string(self):
        for raw in (True, "true", " True "):
            with self.subTest(raw=raw):
                self.assertEqual(
                    _outcome_signal.negative_signal_hits(_row(review_flag=raw)),
                    ("review_flag=true",),
                )

    def test_when_flag_unset_then_no_hit(self):
        for raw in (False, "false", " FALSE ", "", None):
            with self.subTest(raw=raw):
                self.assertEqual(
                    _outcome_signal.negative_signal_hits(_row(review_flag=raw)), ()
                )


class LessonRoutingBehaviourChange(unittest.TestCase):
    """Measured effect of adopting the shared carve-outs at the mirror's call site."""

    def setUp(self):
        self.agg = _load_aggregator()

    def test_when_structural_high_plus_false_then_leaves_failure_memory(self):
        # The ONE shape the carve-out covers: track-outcome.sh D1 stopped emitting this
        # flag on fresh rows, so a legacy row carrying it is not a failure signal. It
        # reaches no bucket because the CTM gate independently rejects metric_pass!=true —
        # accepted only here, where the fresh-row equivalent already routes to None.
        row = _lesson_row(
            task_type="cleanup", confidence="high", metric_pass=False, review_flag=True
        )
        self.assertEqual(_outcome_signal.negative_signal_hits(row), ())
        self.assertIsNone(self.agg.classify_lesson_bucket(row))

    def test_when_structural_underconfidence_then_still_failure_memory(self):
        # D1 leaves the low+true branch flagging, so this arm is live on FRESH rows —
        # carving it out would be an ongoing lesson loss. The two code arms are the worse
        # half: _is_code_task_type short-circuits before the confidence gate, so a flagged
        # row became an injectable CTM success exemplar.
        for agent, task_type in (
            ("glass-atrium-dev-python", "cleanup"),  # no-test-bar, non-code
            ("glass-atrium-dev-python", "doc"),
            ("glass-atrium-dev-python", "refactor"),  # no-test-bar, code arm
            ("glass-atrium-intel-planner", "bug-fix"),  # off-role, code arm
        ):
            with self.subTest(agent=agent, task_type=task_type):
                row = _lesson_row(
                    agent=agent,
                    task_type=task_type,
                    confidence="low",
                    metric_pass=True,
                    review_flag=True,
                )
                self.assertEqual(self.agg.classify_lesson_bucket(row), "epm")

    def test_when_structural_metric_pass_absent_then_still_failure_memory(self):
        # D1's third branch: an ABSENT metric_pass is the writer-cannot-self-judge signal,
        # distinct from the literal false the carve-out gates.
        for absent in ("", None):
            with self.subTest(absent=absent):
                row = _lesson_row(task_type="cleanup", metric_pass=absent, review_flag=True)
                self.assertEqual(self.agg.classify_lesson_bucket(row), "epm")

    def test_when_measurement_gap_then_leaves_failure_memory(self):
        row = _lesson_row(
            result="done_with_concerns", attribution_source="completion-synthesized"
        )
        self.assertIsNone(self.agg.classify_lesson_bucket(row))

    def test_when_code_row_carries_writer_review_flag_then_still_failure_memory(self):
        # The carve-out is structural-only: a genuine on-role code row keeps the flag as a
        # real overconfidence signal.
        self.assertEqual(
            self.agg.classify_lesson_bucket(_lesson_row(review_flag=True)), "epm"
        )

    def test_when_structural_row_carries_real_failure_then_still_failure_memory(self):
        for over in (
            {"result": "fail"},
            {"revision_count": 2},
            {"grader_verdict": "verified_fail"},
            {"evaluative_signal": -1},
        ):
            with self.subTest(over=over):
                row = _lesson_row(task_type="cleanup", **over)
                self.assertEqual(self.agg.classify_lesson_bucket(row), "epm")


if __name__ == "__main__":
    unittest.main(verbosity=2)
