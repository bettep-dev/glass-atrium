#!/usr/bin/env python3
# DF-1 generation-side: a proposed diff whose '+++' header basename diverges from
# the proposal target would, at apply time, land on ANOTHER agent body (git apply
# runs under GIT_ROOT with --directory path resolution); the apply-side before-
# image/verify — bound to the intended target — would neither catch nor restore
# the wrong-file mutation. _gate_validated_diff rejects such a diff (stores empty)
# BEFORE it is ever persisted. A header-less fragment asserts no target → passes.
# A diff whose header pair names /dev/null as the new path deletes a file, which no
# agent-body proposal legitimately does — rejected the same way.
#
# Run: python3 -m unittest autoagent.test.test_diff_target_basename
#   (or, from autoagent/test/) python3 -m unittest test_diff_target_basename

from __future__ import annotations

import functools
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
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

    def test_when_header_path_is_c_quoted_then_unquoted_basename(self) -> None:
        diff = '--- "a/agents/dev x.md"\n+++ "b/agents/dev x.md"\n@@ -1 +1,2 @@\n x\n+y\n'
        self.assertEqual(dc._diff_header_target_basename(diff), "dev x.md")

    def test_when_a_later_body_line_starts_with_plus_then_the_header_still_names_the_target(self) -> None:
        diff = "--- a/foo.md\n+++ b/foo.md\n@@ -1 +1,2 @@\n x\n+++ b/other.md\n"
        self.assertEqual(dc._diff_header_target_basename(diff), "foo.md")

    def test_when_headerless_fragment_carries_a_triple_plus_line_then_it_stays_a_declared_target(self) -> None:
        # Strict: no header pair, so the raw '+++' line keeps HEAD's reading and the gate rejects on mismatch.
        self.assertEqual(dc._diff_header_target_basename("+++ b/other.md\n+y\n"), "other.md")

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

    def test_when_new_path_is_dev_null_then_stored_empty_as_a_file_delete(self) -> None:
        target = Path("/tmp/does-not-matter/intended-agent.md")
        delete = "--- a/intended-agent.md\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n"
        err = StringIO()
        with redirect_stderr(err):
            self.assertEqual(dc._gate_validated_diff(delete, target), "")
        self.assertIn("deletes a file", err.getvalue())

    def test_when_empty_diff_then_passthrough(self) -> None:
        target = Path("/tmp/does-not-matter/intended-agent.md")
        self.assertEqual(dc._gate_validated_diff("", target), "")


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestStoragePathRejectsFileDelete(unittest.TestCase):
    """End to end: a file-delete diff leaves ``_parse_haiku_response`` stored empty."""

    _BODY = "# Agent\n\n- keep\n- tail\n"

    def setUp(self) -> None:
        self.work_tree = Path(tempfile.mkdtemp(prefix="f2-delete-"))
        self.addCleanup(shutil.rmtree, self.work_tree, ignore_errors=True)
        self.target = self.work_tree / "glass-atrium-dev-x.md"
        self.target.write_text(self._BODY, encoding="utf-8")
        for args in (
            ["init", "-q"],
            ["add", "-A"],
            ["-c", "user.email=f2@test", "-c", "user.name=f2", "commit", "-qm", "fixture"],
        ):
            subprocess.run(["git", "-C", str(self.work_tree), *args], check=True)
        unpinned = dc._gate_validated_diff
        dc._gate_validated_diff = functools.partial(unpinned, agents_dir=self.work_tree)
        self.addCleanup(setattr, dc, "_gate_validated_diff", unpinned)

    def _store(self, diff: str) -> tuple[str, str]:
        err = StringIO()
        with redirect_stderr(err):
            proposal = dc._parse_haiku_response("RATIONALE: r\nDIFF:\n" + diff, self.target)
        return proposal.proposed_diff, err.getvalue()

    def test_when_whole_file_delete_then_stored_empty(self) -> None:
        delete = "--- a/glass-atrium-dev-x.md\n+++ /dev/null\n@@ -1,4 +0,0 @@\n" + "".join(
            f"-{line}\n" for line in self._BODY.splitlines()
        )
        stored, _err = self._store(delete)
        self.assertEqual(stored, "")

    def test_when_a_later_header_section_deletes_the_file_then_stored_empty(self) -> None:
        diff = (
            "--- a/glass-atrium-dev-x.md\n+++ b/glass-atrium-dev-x.md\n"
            "@@ -3,2 +3,3 @@\n - keep\n+- added\n - tail\n"
            "--- a/glass-atrium-dev-x.md\n+++ /dev/null\n@@ -1,4 +0,0 @@\n"
            + "".join(f"-{line}\n" for line in self._BODY.splitlines())
        )
        stored, err = self._store(diff)
        self.assertEqual(stored, "")
        self.assertIn("deletes a file", err)


if __name__ == "__main__":
    unittest.main()
