"""Write half of T3a — the prose-only-add verdict persisted on the proposal row.

The classifier already ran per candidate patch and emitted a warning nobody
read. These tests pin the persistence seam that carries the verdict onto
``PatchResult.pre_verify_axes`` (shape i: a boolean key inside the existing
JSONB payload) plus the guard that ships with it:

  (1) a prose-only-add fixture writes the key True; a hook-touching fixture
      writes it False (a count that ignores the verdict fails the second);
  (2) the verdict survives a proposal for which pre-verify did NOT run;
  (3) a diff-less proposal writes NO key — absent is unclassified, not false;
  (4) the failed-axis renderer stays constrained to the four compliance axes,
      so a false verdict is never fed back to the generator as a failed axis.

Run with either runner:
    uv run --python 3.13 --with pytest pytest autoagent/test/test_prose_only_add_persisted.py -v
    python3 -m unittest autoagent.test.test_prose_only_add_persisted -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
for _dir in (_REPO_ROOT / "hooks", _REPO_ROOT / "autoagent"):
    if str(_dir) not in sys.path:
        sys.path.insert(0, str(_dir))

import daemon_cycle as dc  # noqa: E402

_ADDED_ONLY_DIFF = "+- New rule line one\n+- New rule line two"
_PASSED_AXES = {"C1": True, "C2": True, "C3": True, "C4": True}


def _verdict(diff: str, target_file: str) -> bool | None:
    """The cycle-path verdict: None when there is no diff to classify."""
    if not diff:
        return None
    return bool(
        dc.classify_prose_only_add(diff, target_file=target_file, record=False)["warning"]
    )


class VerdictPersisted(unittest.TestCase):
    """(1) both fixtures — true and false — land the correct verdict."""

    def test_when_patch_is_prose_only_add_then_key_true(self) -> None:
        axes = dc._compose_pre_verify_axes(
            _PASSED_AXES, _verdict(_ADDED_ONLY_DIFF, "agents/glass-atrium-dev-python.md")
        )
        self.assertIs(axes[dc.PROSE_ONLY_ADD_AXIS_KEY], True)

    def test_when_patch_touches_hook_then_key_false(self) -> None:
        axes = dc._compose_pre_verify_axes(
            _PASSED_AXES, _verdict(_ADDED_ONLY_DIFF, "hooks/track-outcome.sh")
        )
        self.assertIs(axes[dc.PROSE_ONLY_ADD_AXIS_KEY], False)

    def test_compliance_axes_are_untouched_by_the_passenger(self) -> None:
        axes = dc._compose_pre_verify_axes(
            _PASSED_AXES, _verdict(_ADDED_ONLY_DIFF, "agents/x.md")
        )
        for key in dc.COMPLIANCE_AXIS_KEYS:
            self.assertIs(axes[key], True)
        self.assertNotIn(dc.PROSE_ONLY_ADD_AXIS_KEY, dc.COMPLIANCE_AXIS_KEYS)


class NoPreVerifyPath(unittest.TestCase):
    """(2) a row that skipped pre-verify still carries the verdict."""

    def test_when_pre_verify_did_not_run_then_verdict_still_written(self) -> None:
        axes = dc._compose_pre_verify_axes(
            None, _verdict(_ADDED_ONLY_DIFF, "agents/x.md")
        )
        self.assertEqual(axes, {dc.PROSE_ONLY_ADD_AXIS_KEY: True})


class AbsentIsNotFalse(unittest.TestCase):
    """(3) no diff → no key, so a reader cannot book a non-event as clean."""

    def test_when_proposal_has_no_diff_then_no_key(self) -> None:
        axes = dc._compose_pre_verify_axes(_PASSED_AXES, _verdict("", "agents/x.md"))
        self.assertNotIn(dc.PROSE_ONLY_ADD_AXIS_KEY, axes)
        self.assertEqual(axes, _PASSED_AXES)


class RendererConstrainedToComplianceAxes(unittest.TestCase):
    """(4) the passenger never renders back into the generation prompt."""

    def test_false_verdict_is_not_rendered_as_a_failed_axis(self) -> None:
        rows = [({"C1": True, "C2": False, dc.PROSE_ONLY_ADD_AXIS_KEY: False}, "why")]
        block = dc._render_pre_verify_failures_block(rows)
        self.assertIn("C2", block)
        self.assertNotIn(dc.PROSE_ONLY_ADD_AXIS_KEY, block)

    def test_passenger_alone_renders_no_failed_axis(self) -> None:
        rows = [({dc.PROSE_ONLY_ADD_AXIS_KEY: False}, "why")]
        block = dc._render_pre_verify_failures_block(rows)
        self.assertIn("unspecified-axis", block)
        self.assertNotIn(dc.PROSE_ONLY_ADD_AXIS_KEY, block)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
