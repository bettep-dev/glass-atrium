"""Behavioral tests for the autoagent cycle status classifier (T4).

``_pg_push_autoagent_cycle._aggregate`` derives the ``core.daemon_runs.status``
enum from the cycle report. The protected invariant is 3-branch fidelity plus a
loud-fail fallback:
  (1) every error-bearing patch carries failure_class 'quota-limit' → the cycle
      is an external usage ceiling, NOT a code fault → 'quota_exceeded';
  (2) mixed / other failure classes → 'partial';
  (3) no error-bearing patch → 'ok';
  (4) malformed / absent failure_class on a failing patch → 'partial', never a
      silent 'ok' (pipeline loud-fail hygiene).
Successful patches (empty error) are excluded from the failing-class set, so a
cycle with successes alongside all-quota failures still reads 'quota_exceeded'.

Run with either runner:
    python3 -m unittest autoagent.test.test_cycle_status_classification -v
    uv run --python 3.13 --with pytest pytest \\
        autoagent/test/test_cycle_status_classification.py -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_SCRIPTS_DIR = _REPO_ROOT / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import _pg_push_autoagent_cycle as writer  # noqa: E402


def _patch(**overrides: object) -> dict:
    base = {
        "pattern_label": "p",
        "target_file": "f",
        "classification": "reject",
        "error": "",
        "failure_class": "",
    }
    base.update(overrides)
    return base


def _fail(failure_class: str, error: str = "boom") -> dict:
    return _patch(error=error, failure_class=failure_class)


class CycleStatusClassification(unittest.TestCase):
    def test_when_all_failures_quota_limit_then_quota_exceeded(self) -> None:
        payload = {"patches": [_fail("quota-limit"), _fail("quota-limit")]}
        self.assertEqual(writer._aggregate(payload)["status"], "quota_exceeded")

    def test_when_quota_alongside_successful_patch_then_quota_exceeded(self) -> None:
        # A clean apply (empty error) is excluded from the failing-class set.
        payload = {
            "patches": [
                _patch(classification="body-tweak", error=""),
                _fail("quota-limit"),
            ]
        }
        self.assertEqual(writer._aggregate(payload)["status"], "quota_exceeded")

    def test_when_mixed_failure_classes_then_partial(self) -> None:
        payload = {"patches": [_fail("quota-limit"), _fail("quality")]}
        self.assertEqual(writer._aggregate(payload)["status"], "partial")

    def test_when_non_quota_failure_then_partial(self) -> None:
        payload = {"patches": [_fail("chronic-timeout")]}
        self.assertEqual(writer._aggregate(payload)["status"], "partial")

    def test_when_no_error_bearing_patch_then_ok(self) -> None:
        payload = {"patches": [_patch(classification="body-tweak", error="")]}
        self.assertEqual(writer._aggregate(payload)["status"], "ok")

    def test_when_empty_patches_then_ok(self) -> None:
        self.assertEqual(writer._aggregate({"patches": []})["status"], "ok")

    def test_when_failing_patch_failure_class_absent_then_partial(self) -> None:
        # Malformed/absent failure_class on an error-bearing patch must not
        # collapse to quota_exceeded nor to a silent ok.
        payload = {"patches": [_fail("quota-limit"), _patch(error="boom")]}
        self.assertEqual(writer._aggregate(payload)["status"], "partial")

    def test_when_failing_patch_failure_class_absent_alone_then_partial(self) -> None:
        payload = {"patches": [_patch(error="boom", failure_class="")]}
        self.assertEqual(writer._aggregate(payload)["status"], "partial")


if __name__ == "__main__":
    unittest.main()
