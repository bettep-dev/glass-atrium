#!/usr/bin/env python3
"""D3 — the negative-signal predicate has exactly ONE definition, importable without psycopg.

``hooks/learning-aggregator.py`` carried a second hand-written copy of the OR-terms
(``_record_is_negative``) that had drifted from the shared
``_pg_learning_dualwrite.negative_signal_hits`` in five terms, and both copies ran over the
SAME batch in one production pass. The mirror existed only because the shared module dies on
a missing psycopg at import; the predicate body itself never touched the driver. The rules
now live in the stdlib-only ``hooks/_outcome_signal.py``.

Two things are pinned here, both of which fail against the pre-extraction tree:
(1) the driver-absent import path — including the SystemExit hazard the extraction had to
    route around (``_pg_outcome_dualwrite`` calls ``sys.exit()`` at module scope, and
    SystemExit is a BaseException no ``except Exception`` guard catches);
(2) the deliberately re-added ``evaluative_signal == -1`` OR-term, which existed only in the
    mirror and would otherwise have been dropped by the collapse.

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
            self.assertEqual(agg._negative_signal_hits({"result": "fail"}), ("result=fail",))
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
        self.assertIs(agg._negative_signal_hits, _outcome_signal.negative_signal_hits)

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
