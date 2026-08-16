"""Behavioral tests for C4 target-file resolution in pre-verify prompt assembly.

``daemon_cycle._get_target_path`` anchors a relative target — the repo-relative
``agents/<name>.md`` the updater hands down — on the ga_paths base root instead
of the process cwd. Covered here:
  (a) the same relative target resolves to the live path from two distinct
      working directories, asserted by derived equality against the live path
      (both sides derived, never a literal);
  (b) invoked from a repo root, the assembled C4 excerpt carries no release-only
      marker — the dangerous pre-fix outcome, a plausible excerpt of the wrong
      file that reads as a successful verification;
  (c) an absolute target is left alone;
  (d) an unresolvable target surfaces the named failure signal on stderr AND
      inside the prompt rather than the neutral not-available placeholder, and
      directs the C4 verdict to FAIL;
  (e) a resolvable target leaves the target channel on stderr silent.

Both roots are temporary: the "live" root is bound through ``GA_DATA_ROOT`` (the
ga_paths seam) and the "repo" root is a cwd carrying its own agents/ copy, so no
case depends on an installed ``~/.glass-atrium`` or on the repo's own tree.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_c4_target_resolution.py -v
    python3 -m unittest autoagent.test.test_c4_target_resolution -v
"""

from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_HOOKS_DIR = _REPO_ROOT / "hooks"

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

_AGENT = "glass-atrium-dev-python"
_RELATIVE_TARGET = f"agents/{_AGENT}.md"
# The neutral degradation this task removes from the C4 slot.
_PLACEHOLDER = "(file not available)"
_LIVE_MARKER = "LIVE-TARGET-BODY-MARKER"
_RELEASE_MARKER = "RELEASE-ONLY-BODY-MARKER"


def _base_root(path: Path):
    """Point the ga_paths seam at `path` — resolution is per-call, so this binds."""
    return mock.patch.dict(os.environ, {"GA_DATA_ROOT": str(path)})


@contextlib.contextmanager
def _in_dir(path: Path):
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def _write_agent(root: Path, marker: str) -> Path:
    target = root / "agents" / f"{_AGENT}.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(f"# {_AGENT}\n\n{marker}\n", encoding="utf-8")
    return target


def _pattern(agent: str = _AGENT):
    return dc.Pattern(
        date="2026-08-17",
        label="test signal",
        frequency="3",
        agent=agent,
        status="identified",
        tier="user-pending",
        raw_line="pg:learning_log:1:test signal|" + agent,
    )


def _patch_proposal(target_file: str):
    return dc.PatchProposal(
        target_file=target_file,
        rationale="test rationale",
        proposed_diff="+ a line",
        touched_frontmatter=False,
        estimated_added_lines=1,
        raw_response="",
    )


def _get_prompt(target_file: str) -> tuple[str, str]:
    """Assemble the pre-verify prompt for `target_file`; return (prompt, stderr)."""
    captured = io.StringIO()
    with contextlib.redirect_stderr(captured):
        prompt = dc._build_pre_verify_prompt(_patch_proposal(target_file), _pattern())
    return prompt, captured.getvalue()


def _c4_block(prompt: str) -> str:
    return prompt.split("[C4 ", 1)[1]


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class TargetFileResolutionTest(unittest.TestCase):
    def test_when_target_relative_then_resolution_is_cwd_independent(self):
        with tempfile.TemporaryDirectory() as live, tempfile.TemporaryDirectory() as repo:
            live_root, repo_root = Path(live), Path(repo)
            live_target = _write_agent(live_root, _LIVE_MARKER)
            _write_agent(repo_root, _RELEASE_MARKER)

            with _base_root(live_root):
                with _in_dir(repo_root):
                    from_repo = dc._get_target_path(_RELATIVE_TARGET)
                with _in_dir(Path(tempfile.gettempdir())):
                    from_elsewhere = dc._get_target_path(_RELATIVE_TARGET)

            # Derived equality on both sides: the live path is the one the seam
            # composes, never a literal restated here.
            self.assertEqual(from_repo, live_target)
            self.assertEqual(from_elsewhere, live_target)

    def test_when_invoked_from_repo_root_then_excerpt_is_not_the_release_copy(self):
        with tempfile.TemporaryDirectory() as live, tempfile.TemporaryDirectory() as repo:
            live_root, repo_root = Path(live), Path(repo)
            _write_agent(live_root, _LIVE_MARKER)
            _write_agent(repo_root, _RELEASE_MARKER)

            with _base_root(live_root), _in_dir(repo_root):
                prompt, stderr = _get_prompt(_RELATIVE_TARGET)

        c4_block = _c4_block(prompt)
        self.assertNotIn(_RELEASE_MARKER, c4_block)
        self.assertIn(_LIVE_MARKER, c4_block)
        self.assertNotIn(_PLACEHOLDER, c4_block)
        self.assertNotIn(dc.TARGET_UNRESOLVED_SIGNAL, stderr)

    def test_when_target_absolute_then_path_is_unchanged(self):
        with tempfile.TemporaryDirectory() as live, tempfile.TemporaryDirectory() as repo:
            live_root, repo_root = Path(live), Path(repo)
            release_target = _write_agent(repo_root, _RELEASE_MARKER)

            with _base_root(live_root), _in_dir(Path(tempfile.gettempdir())):
                resolved = dc._get_target_path(str(release_target))

            self.assertEqual(resolved, release_target)

    def test_when_target_unresolvable_then_named_signal_replaces_placeholder(self):
        with tempfile.TemporaryDirectory() as live, tempfile.TemporaryDirectory() as repo:
            live_root, repo_root = Path(live), Path(repo)
            # The live root holds no agents/ copy; the cwd does — exactly the
            # repo-root case, minus the file the resolution is allowed to use.
            _write_agent(repo_root, _RELEASE_MARKER)

            with _base_root(live_root), _in_dir(repo_root):
                prompt, stderr = _get_prompt(_RELATIVE_TARGET)

        self.assertIn(dc.TARGET_UNRESOLVED_SIGNAL, stderr)
        self.assertIn(_RELATIVE_TARGET, stderr)
        self.assertIn(dc.TARGET_UNRESOLVED_SIGNAL, prompt)
        c4_block = _c4_block(prompt)
        self.assertNotIn(_PLACEHOLDER, c4_block)
        self.assertNotIn(_RELEASE_MARKER, c4_block)
        self.assertIn("C4: FAIL", c4_block)

    def test_when_target_resolves_then_target_channel_is_silent(self):
        with tempfile.TemporaryDirectory() as live:
            live_root = Path(live)
            _write_agent(live_root, _LIVE_MARKER)
            captured = io.StringIO()
            with _base_root(live_root), contextlib.redirect_stderr(captured):
                dc._get_target_path(_RELATIVE_TARGET)
        self.assertNotIn(dc.TARGET_UNRESOLVED_SIGNAL, captured.getvalue())


if __name__ == "__main__":
    unittest.main()
