"""Parity pin between the learning-log rule's approval-tier text and the daemon code it describes.

The Tier 1 span must state what the cycle code ships — trial, graduation and a dry
regression gate — and carry no claim that code contradicts; its numbers and literals
must equal the code constants; every function it cites must have a production caller;
the Tier-2 trigger lines stay byte-identical. Sources are read and AST-parsed, never
imported, so the pin cannot skip.
"""

from __future__ import annotations

import ast
import functools
import re
import unittest
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import TypeAlias

_REPO_ROOT = Path(__file__).resolve().parents[2]
_RULE_FILE = _REPO_ROOT / "rules" / "glass-atrium" / "core-learning-log.md"
_DAEMON_CYCLE = _REPO_ROOT / "autoagent" / "daemon_cycle.py"
_DUAL_WRITE = _REPO_ROOT / "scripts" / "_pg_dual_write_daemon.py"


class _Section:
    START = "**Tier 1 — Auto (default)**:"
    END = "**Tier 2 — Safety**:"
    # whole approval-tier section → the stale-claim scan also reaches the Tier 2 prose
    TIER_START = "## Instruction Improvement Approval Tier"
    TIER_END = "## Correction Signal Capture"


# a reflowed trigger line is an added line on the daemon's sensitive-diff axis → byte-identical
_TIER2_TRIGGER_LINES = (
    '- **trigger** — irreversible + external-effect only (reuses the `core-security.md` "High-impact actions" definition). Any one of the following is a Tier-2 trigger:',
    "  - forced/recursive file deletion / DB drop (`rm -r`/`-f` · `DROP TABLE`)",
    "  - external network call (external host API)",
    "  - git push --force / rebase published branch",
    "  - security-permission change (chmod / TCC / launchctl daemon lifecycle (bootstrap/bootout/kickstart/load/unload))",
    "  - launchd plist change — any path whose FINAL component matches `com.claude.*.plist` or `com.glass-atrium.*.plist`",
    "  - frontmatter identity field (name / tools / scope) change",
    "  - weakening of GLASS_ATRIUM_GLOBAL_RULES / core-security.md absolute rules, or any change to `core-learning-log.md` — the Tier-2 trigger list's own home",
)

_NodeKinds: TypeAlias = tuple[type[ast.stmt], ...]

_DEFINITION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Assign, ast.AnnAssign)
_ASSIGNMENT_NODES = (ast.Assign, ast.AnnAssign)
_FUNCTION_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)


class _Anchor:
    # cited path → (source file, node kinds an anchor in it may resolve to)
    SOURCES: Mapping[str, tuple[Path, _NodeKinds]] = {
        "daemon_cycle.py": (_DAEMON_CYCLE, _DEFINITION_NODES),
        "scripts/_pg_dual_write_daemon.py": (_DUAL_WRITE, _ASSIGNMENT_NODES),
    }
    PATTERN = re.compile(r"`([\w./-]+\.py)` → `(\w+)`")
    # production trees a cited function's caller may live in (test trees excluded)
    CALLER_GLOBS = ("autoagent/*.py", "autoagent/lib/*.py", "scripts/*.py", "hooks/*.py")


def _get_text() -> str:
    return _RULE_FILE.read_text(encoding="utf-8")


def _get_span(text: str, start: str, end: str) -> str:
    begin = text.index(start)
    return text[begin : text.index(end, begin)]


def _get_tier1_span() -> str:
    return _get_span(_get_text(), _Section.START, _Section.END)


def _get_approval_section() -> str:
    return _get_span(_get_text(), _Section.TIER_START, _Section.TIER_END)


@functools.cache
def _get_tree(source: Path) -> ast.Module:
    return ast.parse(source.read_text(encoding="utf-8"))


def _get_top_level_names(source: Path, kinds: _NodeKinds) -> set[str]:
    names: set[str] = set()
    for node in _get_tree(source).body:
        if not isinstance(node, kinds):
            continue
        if isinstance(node, ast.Assign):
            names.update(t.id for t in node.targets if isinstance(t, ast.Name))
        elif isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name):
                names.add(node.target.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
    return names


def _get_constant(source: Path, name: str) -> object:
    for node in _get_tree(source).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise LookupError(f"{name} has no top-level literal assignment in {source.name}")


def _get_called_names(node: ast.AST) -> set[str]:
    names: set[str] = set()
    for call in ast.walk(node):
        if isinstance(call, ast.Call):
            func = call.func
            if isinstance(func, ast.Name):
                names.add(func.id)
            elif isinstance(func, ast.Attribute):
                names.add(func.attr)
    return names


def _get_functions_reading(source: Path, name: str) -> set[str]:
    return {
        node.name
        for node in _get_tree(source).body
        if isinstance(node, _FUNCTION_NODES)
        and any(isinstance(n, ast.Name) and n.id == name for n in ast.walk(node))
    }


def _get_run_cycle_calls() -> set[str]:
    for node in _get_tree(_DAEMON_CYCLE).body:
        if isinstance(node, ast.FunctionDef) and node.name == "run_cycle":
            return _get_called_names(node)
    raise LookupError("daemon_cycle.py defines no top-level run_cycle")


def _get_production_sources() -> Iterator[Path]:
    for pattern in _Anchor.CALLER_GLOBS:
        yield from sorted(_REPO_ROOT.glob(pattern))


@functools.cache
def _get_production_called_names() -> frozenset[str]:
    names: set[str] = set()
    for source in _get_production_sources():
        names.update(_get_called_names(_get_tree(source)))
    return frozenset(names)


def _get_single_capture(pattern: str, text: str) -> str:
    captures: list[str] = re.findall(pattern, text)  # every caller's pattern has one group → str items
    if len(captures) != 1:
        raise AssertionError(f"expected one match of {pattern!r} in the Tier 1 span, found {captures}")
    return captures[0]


class Tier1SectionMatchesTheDaemonCode(unittest.TestCase):
    def test_each_section_bound_appears_exactly_once(self) -> None:
        text = _get_text()
        for bound in (_Section.START, _Section.END, _Section.TIER_START, _Section.TIER_END):
            with self.subTest(bound=bound):
                self.assertEqual(text.count(bound), 1)

    def test_tier2_trigger_lines_stay_byte_identical(self) -> None:
        block = "".join(f"{line}\n" for line in _TIER2_TRIGGER_LINES)
        self.assertEqual(_get_text().count(block), 1)

    def test_section_carries_no_claim_the_cycle_code_contradicts(self) -> None:
        calls = _get_run_cycle_calls()
        closed_reason = _get_constant(_DAEMON_CYCLE, "_GENERATION_CLOSED_REASON")
        closed_reason_readers = _get_functions_reading(_DAEMON_CYCLE, "_GENERATION_CLOSED_REASON")
        rows = (
            (
                "run_cycle reaches generation",
                "_run_generation_loop" in calls,
                ("no generator call", "closed on every install", "Tier 1 is closed", "nothing is generated"),
            ),
            (
                "run_cycle reaches the graduation apply",
                "run_graduation_stage" in calls,
                ("no auto-apply until live trials", "kept for that reopening"),
            ),
            (
                "the generation-closed rationale is read only to classify historical rows",
                closed_reason_readers == {"classify_failure_rationale"},
                (f"`{closed_reason}`",),
            ),
        )
        section = _get_approval_section()
        for name, code_fact, stale_claims in rows:
            with self.subTest(name):
                self.assertTrue(code_fact, f"code fact no longer holds: {name} — rewrite the rule and this row")
                self.assertEqual([c for c in stale_claims if c in section], [], "stale claim in the rule text")

    def test_section_states_what_the_cycle_ships(self) -> None:
        calls = _get_run_cycle_calls()
        gate_env = _get_constant(_DAEMON_CYCLE, "REGRESSION_GATE_LIVE_ENV")
        rows = (
            ("trial stage", "run_trial_stage" in calls, "`daemon_cycle.py` → `run_trial_stage`"),
            ("graduation", "run_graduation_stage" in calls, "`daemon_cycle.py` → `run_graduation_stage`"),
            ("regression gate dry unless opted in", True, "`daemon_cycle.py` → `regression_gate_live_enabled`"),
            ("regression gate opt-in env var", True, f"`{gate_env}`"),
        )
        section = _get_tier1_span()
        for name, code_fact, statement in rows:
            with self.subTest(name):
                self.assertTrue(code_fact, f"run_cycle no longer calls the stage behind: {name}")
                self.assertTrue(statement in section, f"the rule text does not state {statement}")

    def test_section_numbers_and_literals_equal_the_code_constants(self) -> None:
        section = _get_tier1_span()
        tier_map = _get_constant(_DUAL_WRITE, "_APPROVAL_TIER_TO_ENUM")
        assert isinstance(tier_map, dict)  # literal_eval of a dict display → dict
        rows = (
            (
                "added-line cap",
                int(_get_single_capture(r"≤(\d+) added lines", section)),
                _get_constant(_DAEMON_CYCLE, "BODY_AUTO_LINE_LIMIT"),
            ),
            (
                "haiku_status apply prefix",
                _get_single_capture(r"`haiku_status` starting with `([^`]+)`", section),
                _get_constant(_DAEMON_CYCLE, "HAIKU_APPLY_ELIGIBLE_PREFIX"),
            ),
            (
                "safety-routed storage tier",
                _get_single_capture(r"stored under the `(\w+)` approval tier", section),
                tier_map["safety"],
            ),
        )
        for name, stated, code_value in rows:
            with self.subTest(name):
                self.assertEqual(stated, code_value)

    def test_every_cited_code_anchor_resolves_to_a_top_level_definition(self) -> None:
        anchors = _Anchor.PATTERN.findall(_get_tier1_span())
        self.assertTrue(anchors, "the section cites no `<file>.py` → `<symbol>` anchor")
        for cited_path, symbol in anchors:
            with self.subTest(anchor=f"{cited_path} → {symbol}"):
                self.assertIn(cited_path, _Anchor.SOURCES, "anchor cites an unmapped source")
                source, kinds = _Anchor.SOURCES[cited_path]
                self.assertTrue(
                    symbol in _get_top_level_names(source, kinds),
                    f"{symbol} has no top-level definition of the cited kind in {source.name}",
                )

    def test_every_cited_function_has_a_production_caller(self) -> None:
        functions = _get_top_level_names(_DAEMON_CYCLE, _FUNCTION_NODES)
        cited = sorted({s for p, s in _Anchor.PATTERN.findall(_get_tier1_span()) if p == "daemon_cycle.py"})
        cited_functions = [symbol for symbol in cited if symbol in functions]
        self.assertTrue(cited_functions, "the section cites no daemon_cycle.py function")
        called = _get_production_called_names()
        for symbol in cited_functions:
            with self.subTest(function=symbol):
                self.assertTrue(symbol in called, f"{symbol} has no production caller — the rule cites dead code")


if __name__ == "__main__":
    unittest.main()
