"""Parity pin between the learning-log rule's Tier 1 section and the daemon code it cites.

The section must state the closed interim in its pinned literals, must not claim the
live auto-apply path, and every code anchor it cites must resolve to a top-level
definition. Sources are read and AST-parsed, never imported, so the pin cannot skip.
"""

from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_RULE_FILE = _REPO_ROOT / "rules" / "glass-atrium" / "core-learning-log.md"

_SECTION_START = "**Tier 1 — Auto (default)**:"
_SECTION_END = "**Tier 2 — Safety**:"

_DEFINITION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Assign, ast.AnnAssign)
_ASSIGNMENT_NODES = (ast.Assign, ast.AnnAssign)

# cited path → (source file, node kinds an anchor in it may resolve to)
_ANCHOR_SOURCES: dict[str, tuple[Path, tuple[type[ast.stmt], ...]]] = {
    "daemon_cycle.py": (_REPO_ROOT / "autoagent" / "daemon_cycle.py", _DEFINITION_NODES),
    "scripts/_pg_dual_write_daemon.py": (
        _REPO_ROOT / "scripts" / "_pg_dual_write_daemon.py",
        _ASSIGNMENT_NODES,
    ),
}

_ANCHOR_PATTERN = re.compile(r"`([\w./-]+\.py)` → `(\w+)`")


def _get_section() -> str:
    text = _RULE_FILE.read_text(encoding="utf-8")
    start = text.index(_SECTION_START)
    return text[start : text.index(_SECTION_END, start)]


def _get_top_level_names(source: Path, kinds: tuple[type[ast.stmt], ...]) -> set[str]:
    names: set[str] = set()
    for node in ast.parse(source.read_text(encoding="utf-8")).body:
        if not isinstance(node, kinds):
            continue
        if isinstance(node, ast.Assign):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name):
                names.add(node.target.id)
        else:
            names.add(node.name)
    return names


class Tier1SectionMatchesTheDaemonCode(unittest.TestCase):
    def test_each_section_bound_appears_exactly_once(self) -> None:
        text = _RULE_FILE.read_text(encoding="utf-8")
        for bound in (_SECTION_START, _SECTION_END):
            with self.subTest(bound=bound):
                self.assertEqual(text.count(bound), 1)

    def test_section_states_the_closed_interim_and_not_the_live_apply_path(self) -> None:
        section = _get_section()
        rows = (
            ("generation closed", "no generator call", True),
            ("apply closed until live trials", "no auto-apply until live trials", True),
            ("live auto-apply claim retired", "auto-applies", False),
        )
        for name, literal, is_expected in rows:
            with self.subTest(name, literal=literal):
                self.assertEqual(literal in section, is_expected)

    def test_every_cited_code_anchor_resolves_to_a_top_level_definition(self) -> None:
        anchors = _ANCHOR_PATTERN.findall(_get_section())
        self.assertTrue(anchors, "the section cites no `<file>.py` → `<symbol>` anchor")
        for cited_path, symbol in anchors:
            with self.subTest(anchor=f"{cited_path} → {symbol}"):
                self.assertIn(cited_path, _ANCHOR_SOURCES, "anchor cites an unmapped source")
                source, kinds = _ANCHOR_SOURCES[cited_path]
                self.assertTrue(
                    symbol in _get_top_level_names(source, kinds),
                    f"{symbol} has no top-level definition of the cited kind in {source.name}",
                )


if __name__ == "__main__":
    unittest.main()
