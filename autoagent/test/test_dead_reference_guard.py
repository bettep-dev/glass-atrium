"""Behavioral tests for the deterministic dead-reference pre-apply guard.

``run_pre_verify`` delegates entirely to an LLM over 4 semantic axes (C1-C4)
with NO mechanical on-disk existence check on the path/rule pointers a diff
INTRODUCES, so a plausible-but-DEAD pointer (a since-moved rule path — the
pre-move ``~/.claude/rules/core-*.md`` form that dropped its ``glass-atrium/``
segment) passes verification. ``classify_dead_reference`` closes that hole with
a filesystem-existence pass over every in-scope pointer token on an ADDED line.

The guard is DETECTION-ONLY (per shared-self-improve-hygiene.md Prose-Only-Add):
it WARNS, never rejects. These tests pin the three-way contract:
  (1) a DEAD pointer added line is flagged (warning True, token collected);
  (2) a CORRECT ``~/.claude/rules/glass-atrium/...`` pointer resolves → clean;
  (3) an example / globbed / <var>-placeholder pointer is NOT flagged.

Run with either runner:
    uv run --python 3.13 --with pytest pytest autoagent/test/test_dead_reference_guard.py -v
    python3 -m unittest autoagent.test.test_dead_reference_guard -v
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

# A real harness rule file (symlinked into ~/.claude/rules/glass-atrium/). Chosen
# because it is a Tier-1 core rule present on every install, so the "resolves"
# assertion is stable.
_LIVE_REFERENCE = "~/.claude/rules/glass-atrium/core-outcome-record.md"

# The pre-move DEAD form of the same rule: it lost the `glass-atrium/` path
# segment, so it does not resolve on disk (the /-lookbehind blind spot the prior
# perl remediation missed).
_DEAD_REFERENCE = "~/.claude/rules/core-outcome-record.md"


def _added_diff(*body_lines: str) -> str:
    """Build a minimal added-only diff fragment ('+' prefix per line)."""
    return "\n".join(f"+{line}" for line in body_lines)


class DeadReferenceFlagged(unittest.TestCase):
    """(1) an added line citing an unresolved pointer is flagged."""

    def test_when_added_line_cites_dead_pointer_then_flagged(self) -> None:
        diff = _added_diff(f"> Detailed rules: See `{_DEAD_REFERENCE}` for the spec.")
        signal = dc.classify_dead_reference(diff, target_file="agents/x.md", record=False)
        self.assertTrue(signal["warning"])
        self.assertEqual(signal["classification"], "dead-reference")
        self.assertIn(_DEAD_REFERENCE, signal["dead_references"])

    def test_bare_dotclaude_dead_form_also_flagged(self) -> None:
        # The tilde-less `.claude/...` form (the shape the /-lookbehind excluded).
        diff = _added_diff("See .claude/rules/core-security.md before editing.")
        signal = dc.classify_dead_reference(diff, target_file="agents/x.md", record=False)
        self.assertTrue(signal["warning"])
        self.assertIn(".claude/rules/core-security.md", signal["dead_references"])


class LiveReferencePasses(unittest.TestCase):
    """(2) a correct ~/.claude/rules/glass-atrium/... pointer resolves → clean."""

    def test_when_added_line_cites_live_pointer_then_clean(self) -> None:
        if not Path(_LIVE_REFERENCE).expanduser().exists():
            self.skipTest(f"live harness reference absent: {_LIVE_REFERENCE}")
        diff = _added_diff(f"> Detailed rules: See `{_LIVE_REFERENCE}` (SoT).")
        signal = dc.classify_dead_reference(diff, target_file="agents/x.md", record=False)
        self.assertFalse(signal["warning"])
        self.assertEqual(signal["classification"], "ok")
        self.assertEqual(signal["dead_references"], [])
        self.assertEqual(signal["checked_count"], 1)

    def test_relative_rules_reference_resolves(self) -> None:
        rel = "rules/glass-atrium/core-outcome-record.md"
        if not (dc._HARNESS_ROOT / rel).exists():
            self.skipTest(f"live relative harness reference absent: {rel}")
        diff = _added_diff(f"See `{rel}` for the outcome-record contract.")
        signal = dc.classify_dead_reference(diff, target_file="agents/x.md", record=False)
        self.assertFalse(signal["warning"])


class ExampleAndGlobExcluded(unittest.TestCase):
    """(3) example / globbed / <var> pointers are NOT flagged."""

    def test_globbed_pointer_not_flagged(self) -> None:
        diff = _added_diff("Read the agent body at ~/.claude/agents/*.md at spawn.")
        signal = dc.classify_dead_reference(diff, target_file="agents/x.md", record=False)
        self.assertFalse(signal["warning"])
        self.assertEqual(signal["checked_count"], 0)

    def test_var_placeholder_pointer_not_flagged(self) -> None:
        diff = _added_diff("Body lives at ~/.claude/agents/<name>.md per registry.")
        signal = dc.classify_dead_reference(diff, target_file="agents/x.md", record=False)
        self.assertFalse(signal["warning"])
        self.assertEqual(signal["checked_count"], 0)

    def test_example_context_line_not_flagged(self) -> None:
        # An "e.g." line cites a FORM, not a live reference — even a nonexistent path.
        diff = _added_diff("e.g. ~/.claude/rules/core-nonexistent.md is a stale form.")
        signal = dc.classify_dead_reference(diff, target_file="agents/x.md", record=False)
        self.assertFalse(signal["warning"])

    def test_fenced_code_block_pointer_not_flagged(self) -> None:
        diff = _added_diff(
            "Usage below:",
            "```",
            "cat ~/.claude/rules/core-nonexistent.md",
            "```",
            "End.",
        )
        signal = dc.classify_dead_reference(diff, target_file="agents/x.md", record=False)
        self.assertFalse(signal["warning"])

    def test_removed_line_pointer_not_checked(self) -> None:
        # Only ADDED lines are inspected — a removed dead pointer is being deleted.
        diff = "-See ~/.claude/rules/core-nonexistent.md"
        signal = dc.classify_dead_reference(diff, target_file="agents/x.md", record=False)
        self.assertFalse(signal["warning"])
        self.assertEqual(signal["checked_count"], 0)

    def test_bare_filename_out_of_scope(self) -> None:
        # A non-harness bare filename is out of scope (no false positive on README.md).
        diff = _added_diff("See README.md and core-security.md for context.")
        signal = dc.classify_dead_reference(diff, target_file="agents/x.md", record=False)
        self.assertFalse(signal["warning"])
        self.assertEqual(signal["checked_count"], 0)


if __name__ == "__main__":
    unittest.main()
