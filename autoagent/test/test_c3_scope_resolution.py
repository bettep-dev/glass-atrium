"""Behavioral tests for C3 scope-file resolution in pre-verify prompt assembly.

``daemon_cycle._scope_file_for_agent`` resolves the target agent's scope-*.md
against the live scoped store, and every miss is loud. Covered here:
  (a) every entry in the agent→scope map resolves to an existing file, asserted
      by ABSENCE of unresolved entries across the full map (never a count), with
      each resolved basename derived-equal to its mapped value;
  (b) a mapped-but-absent scope file surfaces the named failure signal on stderr
      AND inside the prompt, instead of the neutral not-available placeholder;
  (c) an agent with no map entry is loud on the same named signal;
  (d) for a mapped agent the assembled prompt header names the resolved file,
      asserted by absence of the unknown-scope literal;
  (e) the map's agent roster and the shipped ``agents/`` roster agree in BOTH
      directions, so an agent added to the farm without a map entry — the gap
      that left glass-atrium-dev-swift judging C3 against nothing — is red here
      rather than silent at daemon runtime.

The scoped store is pointed at the repo's own ``scoped/`` via ``GA_DATA_ROOT``
(the ga_paths seam both python and shell consumers share), so the suite asserts
against the real scope-file set without depending on an installed
``~/.glass-atrium``.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_c3_scope_resolution.py -v
    python3 -m unittest autoagent.test.test_c3_scope_resolution -v
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

# The neutral degradation this task removes from the C3 slot: it reads to the
# verifier as an inspected-and-clear axis.
_PLACEHOLDER = "(file not available)"
_UNKNOWN_SCOPE_LITERAL = "scope-(unknown).md"


def _base_root(path: Path):
    """Point the ga_paths seam at `path` — resolution is per-call, so this binds."""
    return mock.patch.dict(os.environ, {"GA_DATA_ROOT": str(path)})


def _pattern(agent: str):
    return dc.Pattern(
        date="2026-08-16",
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


def _get_prompt(agent: str) -> tuple[str, str]:
    """Assemble the pre-verify prompt for `agent`; return (prompt, stderr)."""
    captured = io.StringIO()
    with contextlib.redirect_stderr(captured):
        prompt = dc._build_pre_verify_prompt(
            _patch_proposal(str(_REPO_ROOT / "agents" / f"{agent}.md")),
            _pattern(agent),
        )
    return prompt, captured.getvalue()


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class ScopeFileResolutionTest(unittest.TestCase):
    def test_when_store_present_then_no_map_entry_is_unresolved(self):
        with _base_root(_REPO_ROOT):
            resolved = {a: dc._scope_file_for_agent(a) for a in dc._AGENT_SCOPE_MAP}

        unresolved = sorted(a for a, p in resolved.items() if p is None)
        self.assertEqual(unresolved, [], "agents whose scope file did not resolve")
        # Derived equality: each resolved file is the one the map names, on disk.
        for agent, path in resolved.items():
            self.assertEqual(path.name, dc._AGENT_SCOPE_MAP[agent])
            self.assertTrue(path.is_file(), f"{path} is not a readable file")

    def test_when_agent_shipped_then_it_has_a_map_entry(self):
        # Roster derived from the shipped agent files, never restated here: a
        # hand-copied list drifts the moment the farm grows, which is the very
        # drift this asserts against.
        shipped = {
            p.stem for p in (_REPO_ROOT / "agents").glob("glass-atrium-*.md")
        }
        self.assertTrue(shipped, "no shipped agent files found to derive from")
        self.assertEqual(
            sorted(shipped - set(dc._AGENT_SCOPE_MAP)),
            [],
            "shipped agents with no agent→scope map entry (C3 judges nothing)",
        )
        self.assertEqual(
            sorted(set(dc._AGENT_SCOPE_MAP) - shipped),
            [],
            "map entries naming an agent that is not shipped",
        )

    def test_when_store_present_then_resolution_leaves_stderr_silent(self):
        captured = io.StringIO()
        with _base_root(_REPO_ROOT), contextlib.redirect_stderr(captured):
            for agent in dc._AGENT_SCOPE_MAP:
                dc._scope_file_for_agent(agent)
        self.assertNotIn(dc.SCOPE_UNRESOLVED_SIGNAL, captured.getvalue())

    def test_when_scope_file_absent_then_named_signal_replaces_placeholder(self):
        with tempfile.TemporaryDirectory() as empty:
            with _base_root(Path(empty)):
                prompt, stderr = _get_prompt("glass-atrium-dev-python")

        self.assertIn(dc.SCOPE_UNRESOLVED_SIGNAL, stderr)
        self.assertIn("scope-dev.md", stderr)
        self.assertIn(dc.SCOPE_UNRESOLVED_SIGNAL, prompt)
        # The C3 slot must not degrade into the neutral placeholder.
        c3_block = prompt.split("[C3 ", 1)[1].split("[C4 ", 1)[0]
        self.assertNotIn(_PLACEHOLDER, c3_block)
        self.assertIn("C3: FAIL", c3_block)

    def test_when_scope_path_is_a_directory_then_named_signal_is_loud(self):
        # A directory satisfies exists() but not a read: the resolver returned it, the
        # excerpt became "(read error: Is a directory)" and C3 carried no verdict — the
        # neutral blind axis the signal exists to eliminate, reached by a second route.
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "scoped" / "scope-dev.md").mkdir(parents=True)
            with _base_root(Path(root)):
                prompt, stderr = _get_prompt("glass-atrium-dev-python")

        self.assertIn(dc.SCOPE_UNRESOLVED_SIGNAL, stderr)
        self.assertIn(dc.SCOPE_UNRESOLVED_SIGNAL, prompt)
        c3_block = prompt.split("[C3 ", 1)[1].split("[C4 ", 1)[0]
        self.assertIn("C3: FAIL", c3_block)

    def test_when_agent_unmapped_then_named_signal_is_loud(self):
        with _base_root(_REPO_ROOT):
            prompt, stderr = _get_prompt("glass-atrium-not-an-agent")

        self.assertIn(dc.SCOPE_UNRESOLVED_SIGNAL, stderr)
        self.assertIn(dc.SCOPE_UNRESOLVED_SIGNAL, prompt)

    def test_when_agent_mapped_then_header_names_resolved_file(self):
        with _base_root(_REPO_ROOT):
            prompt, _ = _get_prompt("glass-atrium-dev-python")

        self.assertIn("[C3 scope-dev.md ", prompt)
        self.assertNotIn(_UNKNOWN_SCOPE_LITERAL, prompt)
        self.assertNotIn(dc.SCOPE_UNRESOLVED_SIGNAL, prompt)
        # The excerpt is the scope file's real text, not a stand-in.
        c3_block = prompt.split("[C3 ", 1)[1].split("[C4 ", 1)[0]
        self.assertNotIn(_PLACEHOLDER, c3_block)
        self.assertIn("DEV Scope Rules", c3_block)


if __name__ == "__main__":
    unittest.main()
