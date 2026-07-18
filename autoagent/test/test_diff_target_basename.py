#!/usr/bin/env python3
# DF-1 generation-side: a proposed diff whose '+++' header basename diverges from
# the proposal target would, at apply time, land on ANOTHER agent body (git apply
# runs under GIT_ROOT with --directory path resolution); the apply-side before-
# image/verify — bound to the intended target — would neither catch nor restore
# the wrong-file mutation. _gate_validated_diff rejects such a diff (stores empty)
# BEFORE it is ever persisted. A header-less fragment asserts no target → passes.
#
# Run: python3 -m unittest autoagent.test.test_diff_target_basename
#   (or, from autoagent/test/) python3 -m unittest test_diff_target_basename

from __future__ import annotations

import sys
import unittest
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
except Exception as exc:  # noqa: BLE001
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestDiffHeaderTargetBasename(unittest.TestCase):
    def test_when_b_prefixed_header_then_basename(self) -> None:
        diff = "--- a/agents/foo.md\n+++ b/agents/foo.md\n@@ -1 +1,2 @@\n x\n+y\n"
        self.assertEqual(dc._diff_header_target_basename(diff), "foo.md")

    def test_when_bare_basename_header_then_basename(self) -> None:
        diff = "--- a/foo.md\n+++ b/foo.md\n@@ -1 +1,2 @@\n x\n+y\n"
        self.assertEqual(dc._diff_header_target_basename(diff), "foo.md")

    def test_when_trailing_timestamp_then_stripped(self) -> None:
        diff = "+++ b/foo.md\t2026-07-18 00:00:00\n@@ -1 +1,2 @@\n x\n+y\n"
        self.assertEqual(dc._diff_header_target_basename(diff), "foo.md")

    def test_when_no_plus_header_then_none(self) -> None:
        # Header-less append-only fragment (Strategy B) — no target asserted.
        self.assertIsNone(dc._diff_header_target_basename("+added line\n+another\n"))


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestGateRejectsWrongFileDiff(unittest.TestCase):
    def test_when_header_basename_mismatch_then_stored_empty(self) -> None:
        # The guard fires BEFORE any git apply --check, so no on-disk file needed.
        target = Path("/tmp/does-not-matter/intended-agent.md")
        wrong = "--- a/other.md\n+++ b/other.md\n@@ -1 +1,2 @@\n x\n+y\n"
        self.assertEqual(dc._gate_validated_diff(wrong, target), "")

    def test_when_empty_diff_then_passthrough(self) -> None:
        target = Path("/tmp/does-not-matter/intended-agent.md")
        self.assertEqual(dc._gate_validated_diff("", target), "")


if __name__ == "__main__":
    unittest.main()
