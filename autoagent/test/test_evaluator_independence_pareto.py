#!/usr/bin/env python3
# AD-9 evaluator independence regressions.
#
# AD-9 (CALM self-preference precedent): the pre-verify verifier model class
# should differ from the proposal-author class where feasible; when infeasible
# (same class) the run proceeds under a loud advisory, never blocking.
# AC: verifier != author class when feasible.
#
# Run: python3 -m unittest autoagent.test.test_evaluator_independence_pareto
#   (or, from autoagent/test/) python3 -m unittest test_evaluator_independence_pareto

from __future__ import annotations

import io
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path

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
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestModelClass(unittest.TestCase):
    def test_when_haiku_id_then_haiku_class(self) -> None:
        self.assertEqual(dc._model_class("claude-haiku-4-5"), "haiku")

    def test_when_sonnet_id_then_sonnet_class(self) -> None:
        self.assertEqual(dc._model_class("claude-sonnet-4-5"), "sonnet")

    def test_when_opus_id_then_opus_class(self) -> None:
        self.assertEqual(dc._model_class("claude-opus-4-8"), "opus")

    def test_when_unknown_id_then_lowercased_id(self) -> None:
        # Unknown shapes must NOT collapse to a known family (false independence).
        self.assertEqual(dc._model_class("Mystery-Model"), "mystery-model")


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestResolveVerifierModel(unittest.TestCase):
    def test_when_distinct_class_then_no_warning(self) -> None:
        # AC: verifier != author class when feasible → the distinct model is used
        # with no advisory noise.
        buf = io.StringIO()
        with redirect_stderr(buf):
            resolved = dc.resolve_verifier_model(
                author_model="claude-haiku-4-5",
                verifier_model="claude-sonnet-4-5",
            )
        self.assertEqual(resolved, "claude-sonnet-4-5")
        self.assertNotEqual(
            dc._model_class("claude-sonnet-4-5"), dc._model_class("claude-haiku-4-5")
        )
        self.assertEqual(buf.getvalue(), "")

    def test_when_same_class_then_advisory_but_not_blocked(self) -> None:
        # Infeasible independence (same class) → loud advisory, but the model is
        # still returned (advisory-first: never blocks the loop).
        buf = io.StringIO()
        with redirect_stderr(buf):
            resolved = dc.resolve_verifier_model(
                author_model="claude-haiku-4-5",
                verifier_model="claude-haiku-4-5",
            )
        self.assertEqual(resolved, "claude-haiku-4-5")
        self.assertIn("evaluator independence not satisfied", buf.getvalue())

    def test_default_verifier_model_resolves(self) -> None:
        # The module-level PRE_VERIFY_MODEL default is a non-empty model id.
        self.assertTrue(dc.PRE_VERIFY_MODEL)


if __name__ == "__main__":
    unittest.main()
