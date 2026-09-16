"""Behavioral tests for the injected turn-budget excerpt in pre-verify assembly.

The four compliance slots resolve the matrix, GLOBAL_RULES, one ``scope-*.md``
and the target body, so the turn-budget text the SubagentStart injector delivers
reaches none of them and a patch duplicating it reads to C4 as a clean add.
``daemon_cycle`` closes that with a fifth source, attached for budget-family
patches only. Covered here:
  (a) the marker literals this reader uses are the ones
      ``hooks/inject-scope-rules.sh`` declares, derived from that file rather
      than restated, and the extraction agrees with the hook's own shell
      extractor over the live source;
  (b) the extractor's boundary + fail-open semantics — between-lines only, absent
      file / absent start marker empty, start-without-end running to EOF;
  (c) the budget-family predicate fires on EITHER leg and on neither for a
      neighbouring non-budget proposal, and never on the forbidden
      operational-counter literal;
  (d) the extracted text actually ARRIVES in the assembled prompt for a
      budget-family patch and is absent for a non-budget one, and assembly stays
      byte-idempotent either way.

Both roots are temporary — the source is bound through ``GA_DATA_ROOT`` (the
ga_paths seam) — so no case depends on an installed ``~/.glass-atrium``.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_pre_verify_budget_injection.py -v
    python3 -m unittest autoagent.test.test_pre_verify_budget_injection -v
"""

from __future__ import annotations

import contextlib
import io
import os
import shutil
import subprocess
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
_INJECT_HOOK = _HOOKS_DIR / "inject-scope-rules.sh"
_LIVE_BUDGET_SRC = _REPO_ROOT / "scoped" / "shared-turn-budget.md"
# The operational-counter literal the predicate must never key on: it rides a
# different axis and its exclusion set drops the row before generation.
_FORBIDDEN_CORE = "budget-overage concentration"
_NEIGHBOUR_LABEL = "agent instruction-improvement candidate (failure rate 62%)"


def _base_root(path: Path):
    """Point the ga_paths seam at `path` — resolution is per-call, so this binds."""
    return mock.patch.dict(os.environ, {"GA_DATA_ROOT": str(path)})


def _budget_core() -> str:
    """The one signature core the label leg keys on, read from the implementation."""
    return sorted(dc.BUDGET_FAMILY_SIGNATURE_CORES)[0]


def _pattern(label: str, agent: str = _AGENT):
    return dc.Pattern(
        date="2026-09-16",
        label=label,
        frequency="3/5",
        agent=agent,
        status="identified",
        tier="user-pending",
        raw_line=f"pg:learning_log:1:{label}|{agent}",
    )


def _patch_proposal(target_file: str, diff: str = "+ a line"):
    return dc.PatchProposal(
        target_file=target_file,
        rationale="test rationale",
        proposed_diff=diff,
        touched_frontmatter=False,
        estimated_added_lines=1,
        raw_response="",
    )


def _write_source(root: Path, body: str) -> Path:
    """Write a scoped/shared-turn-budget.md under `root`, returning its path."""
    src = root / "scoped" / dc.TURN_BUDGET_SRC_NAME
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_text(body, encoding="utf-8")
    return src


def _write_agent(root: Path) -> Path:
    target = root / "agents" / f"{_AGENT}.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(f"# {_AGENT}\n\nbody line\n", encoding="utf-8")
    return target


def _fixture_source() -> str:
    """A source carrying both real marker pairs, each around a unique sentinel."""
    lines = ["# fixture turn-budget source", ""]
    for name, start, end in dc.BUDGET_BLOCK_MARKERS:
        lines += [f"## {name}", "prose that is NOT injected", start,
                  f"**{name} sentinel body 9c31ad**", f"- {name} bullet", end, ""]
    return "\n".join(lines) + "\n"


def _get_prompt(label: str, target_file: str = _RELATIVE_TARGET, diff: str = "+ a line"):
    """Assemble the pre-verify prompt; return (prompt, stderr)."""
    captured = io.StringIO()
    with contextlib.redirect_stderr(captured):
        prompt = dc._build_pre_verify_prompt(
            _patch_proposal(target_file, diff), _pattern(label)
        )
    return prompt, captured.getvalue()


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class MarkerContractTest(unittest.TestCase):
    """(a) the second reader of the marker contract agrees with the first."""

    def test_when_hook_declares_markers_then_this_reader_uses_the_same_literals(self):
        if not _INJECT_HOOK.is_file():
            self.skipTest(f"injector hook not readable: {_INJECT_HOOK}")
        hook_text = _INJECT_HOOK.read_text(encoding="utf-8")
        for _name, start, end in dc.BUDGET_BLOCK_MARKERS:
            # Derived on the hook side: the literal must appear there verbatim,
            # so a rename in either file reds this rather than silently halving
            # the contract's readership.
            self.assertIn(f"'{start}'", hook_text)
            self.assertIn(f"'{end}'", hook_text)

    def test_when_live_source_read_then_every_declared_block_is_non_empty(self):
        if not _LIVE_BUDGET_SRC.is_file():
            self.skipTest(f"live turn-budget source absent: {_LIVE_BUDGET_SRC}")
        for name, start, end in dc.BUDGET_BLOCK_MARKERS:
            block = dc._read_marker_block(_LIVE_BUDGET_SRC, start, end)
            self.assertTrue(block.strip(), f"{name} block extracted empty")
            self.assertNotIn(start, block)
            self.assertNotIn(end, block)

    def test_when_live_source_read_then_extraction_matches_the_shell_extractor(self):
        if not _LIVE_BUDGET_SRC.is_file():
            self.skipTest(f"live turn-budget source absent: {_LIVE_BUDGET_SRC}")
        if not all(shutil.which(tool) for tool in ("bash", "sed", "grep")):
            self.skipTest("shell extractor tools unavailable")

        for name, start, end in dc.BUDGET_BLOCK_MARKERS:
            # The hook's own pipeline, run verbatim against the same file: the
            # relationship asserted is agreement between the two readers, not a
            # copied expected value.
            shell = subprocess.run(
                ["bash", "-c",
                 'sed -n "/$2/,/$3/p" "$1" | grep -vxF "$2" | grep -vxF "$3"',
                 "_", str(_LIVE_BUDGET_SRC), start, end],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(
                dc._read_marker_block(_LIVE_BUDGET_SRC, start, end).splitlines(),
                shell.stdout.splitlines(),
                f"{name}: python and shell extractors disagree",
            )


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class MarkerExtractionTest(unittest.TestCase):
    """(b) boundary and fail-open semantics of the extractor."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.name, self.start, self.end = dc.BUDGET_BLOCK_MARKERS[0]

    def test_when_markers_present_then_only_the_lines_between_survive(self):
        src = _write_source(self.root, _fixture_source())
        block = dc._read_marker_block(src, self.start, self.end)
        self.assertIn(f"**{self.name} sentinel body 9c31ad**", block)
        self.assertNotIn("prose that is NOT injected", block)
        self.assertNotIn(self.start, block)
        self.assertNotIn(self.end, block)

    def test_when_file_absent_then_extraction_is_empty(self):
        self.assertEqual(
            dc._read_marker_block(self.root / "absent.md", self.start, self.end), ""
        )

    def test_when_start_marker_absent_then_extraction_is_empty(self):
        src = _write_source(self.root, "# no markers here\nbody\n")
        self.assertEqual(dc._read_marker_block(src, self.start, self.end), "")

    def test_when_end_marker_absent_then_extraction_runs_to_eof(self):
        src = _write_source(self.root, f"head\n{self.start}\nkept a\nkept b\n")
        self.assertEqual(
            dc._read_marker_block(src, self.start, self.end), "kept a\nkept b"
        )


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class BudgetFamilyPredicateTest(unittest.TestCase):
    """(c) each leg fires on its own, and neither over-fires."""

    def test_when_label_carries_the_signature_core_then_the_label_leg_fires(self):
        core = _budget_core()
        # The live emit shape: stable core + free-text tail. Matching the tail
        # would miss this; matching the core does not.
        for label in (core, f"{core} (avg overrun +7 tool_uses)",
                      f"multi-signal ({_NEIGHBOUR_LABEL} / {core})"):
            with self.subTest(label=label):
                leg = dc.match_budget_family(label, _RELATIVE_TARGET, "+ a line")
                self.assertEqual(leg, f"label:{core}")

    def test_when_diff_touches_a_budget_site_then_the_site_leg_fires(self):
        diff = (
            "--- a/scoped/shared-turn-budget.md\n"
            "+++ b/scoped/shared-turn-budget.md\n"
            "@@ -1 +1,2 @@\n+ a budget bullet\n"
        )
        leg = dc.match_budget_family(_NEIGHBOUR_LABEL, _RELATIVE_TARGET, diff)
        self.assertIsNotNone(leg)
        self.assertTrue(leg.startswith("site:"), leg)

    def test_when_target_file_is_a_budget_site_then_the_site_leg_fires(self):
        leg = dc.match_budget_family(
            _NEIGHBOUR_LABEL, "hooks/inject-scope-rules.sh", "+ a line"
        )
        self.assertIsNotNone(leg)
        self.assertTrue(leg.startswith("site:"), leg)

    def test_when_neighbouring_proposal_then_no_leg_fires(self):
        self.assertIsNone(
            dc.match_budget_family(
                _NEIGHBOUR_LABEL,
                _RELATIVE_TARGET,
                f"--- a/{_RELATIVE_TARGET}\n+++ b/{_RELATIVE_TARGET}\n+ a line\n",
            )
        )

    def test_when_label_is_the_operational_counter_then_no_leg_fires(self):
        # Reusing that literal would suppress the very patterns this source
        # serves — it lives in the intake EXCLUSION set, a different axis.
        self.assertNotIn(_FORBIDDEN_CORE, dc.BUDGET_FAMILY_SIGNATURE_CORES)
        self.assertIsNone(
            dc.match_budget_family(_FORBIDDEN_CORE, _RELATIVE_TARGET, "+ a line")
        )


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class PromptAttachmentTest(unittest.TestCase):
    """(d) the blocks arrive, only where they should, and assembly is idempotent."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        _write_agent(self.root)
        self.src = _write_source(self.root, _fixture_source())
        self.budget_label = f"{_budget_core()} (avg overrun +7 tool_uses)"

    def _blocks(self) -> list[str]:
        return [
            dc._read_marker_block(self.src, start, end)
            for _name, start, end in dc.BUDGET_BLOCK_MARKERS
        ]

    def test_when_patch_is_budget_family_then_every_block_reaches_the_prompt(self):
        with _base_root(self.root):
            prompt, stderr = _get_prompt(self.budget_label)
        for block in self._blocks():
            self.assertIn(block, prompt)
        self.assertNotIn(dc.TURN_BUDGET_NOT_APPLICABLE, prompt)
        self.assertNotIn(dc.TURN_BUDGET_UNREADABLE_SIGNAL, stderr)

    def test_when_patch_is_not_budget_family_then_no_block_reaches_the_prompt(self):
        with _base_root(self.root):
            prompt, _ = _get_prompt(_NEIGHBOUR_LABEL)
        for block in self._blocks():
            self.assertNotIn(block, prompt)
        self.assertIn(dc.TURN_BUDGET_NOT_APPLICABLE, prompt)

    def test_when_source_unreadable_then_the_named_signal_is_loud_on_both_channels(self):
        with tempfile.TemporaryDirectory() as bare:
            bare_root = Path(bare)
            _write_agent(bare_root)
            with _base_root(bare_root):
                prompt, stderr = _get_prompt(self.budget_label)
        self.assertIn(dc.TURN_BUDGET_UNREADABLE_SIGNAL, stderr)
        self.assertIn(dc.TURN_BUDGET_UNREADABLE_SIGNAL, prompt)

    def test_when_assembled_twice_then_the_prompt_is_byte_identical(self):
        # The docstring's idempotency claim, asserted for BOTH dispositions of
        # the new slot — attached and not.
        for label in (self.budget_label, _NEIGHBOUR_LABEL):
            with self.subTest(label=label), _base_root(self.root):
                first, _ = _get_prompt(label)
                second, _ = _get_prompt(label)
                self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
