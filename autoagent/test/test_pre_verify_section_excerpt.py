"""Behavioral tests for the section-aware excerpts in pre-verify prompt assembly.

``daemon_cycle._build_pre_verify_prompt`` composes its rule and target excerpts
from WHOLE markdown heading blocks, so a section beyond the former 6000-char head
slice reaches the verifier intact. Covered here:
  (a) a fixture GLOBAL_RULES file carrying two sentinel ``##`` sections past the
      former cap position reaches the prompt with each heading line AND its
      terminal line — whole-block, not a mid-block cut — and the real canonical
      ``Turn Budget & Graceful Exit`` section does the same from the live file;
  (b) a target agent body sized from the live registry corpus (never from the
      implementation's own bound) carrying a sentinel heading block past the
      former cap position reaches the prompt whole, ending on a block boundary;
  (c) the extractor drops WHOLE blocks when its bound is crossed, so no excerpt
      ends on an arbitrary character;
  (d) an empty file still yields an empty excerpt, preserving the caller's
      directed-FAIL emptiness path.

The former cap position (6000) is a fixed historical offset, never read from the
implementation's current bound — a fixture sized from the bound under test can
only measure that bound against itself.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_pre_verify_section_excerpt.py -v
    python3 -m unittest autoagent.test.test_pre_verify_section_excerpt -v
"""

from __future__ import annotations

import contextlib
import io
import json
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
_FORMER_CAP = 6000
_TURN_BUDGET_HEADING = "### Turn Budget & Graceful Exit"

_RULES_HEADING_A = "## Sentinel Rule Section A 4b7c1e"
_RULES_TERMINAL_A = "sentinel rule terminal A 4b7c1e"
_RULES_HEADING_B = "## Sentinel Rule Section B 4b7c1e"
_RULES_TERMINAL_B = "sentinel rule terminal B 4b7c1e"
_BODY_HEADING = "## Sentinel Body Section 4b7c1e"
_BODY_TERMINAL = "sentinel body terminal 4b7c1e"


def _base_root(path: Path):
    """Point the ga_paths seam at `path` — resolution is per-call, so this binds."""
    return mock.patch.dict(os.environ, {"GA_DATA_ROOT": str(path)})


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


def _write_agent(root: Path, body: str) -> Path:
    target = root / "agents" / f"{_AGENT}.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8")
    return target


def _largest_registry_body_chars() -> int:
    """Largest live registry agent body in characters — the corpus-derived size."""
    registry = Path.home() / ".glass-atrium" / "agent-registry.json"
    agents_dir = Path.home() / ".claude" / "agents"
    names = json.loads(registry.read_text(encoding="utf-8")).get("agents", {})
    sizes = [
        len((agents_dir / f"{name}.md").read_text(encoding="utf-8"))
        for name in names
        if (agents_dir / f"{name}.md").is_file()
    ]
    if not sizes:
        raise FileNotFoundError("no registry agent bodies readable")
    return max(sizes)


def _rules_body() -> str:
    """GLOBAL_RULES fixture: two sentinel sections opening at distinct offsets past 6000."""
    return (
        "## Early Section\n"
        + "rule line\n" * 700
        + f"{_RULES_HEADING_A}\nrule body a\n{_RULES_TERMINAL_A}\n"
        + "## Middle Section\n"
        + "rule line\n" * 300
        + f"{_RULES_HEADING_B}\nrule body b\n{_RULES_TERMINAL_B}\n"
    )


def _agent_body(size: int) -> str:
    """Agent body of exactly `size` characters, sentinel heading block at its end."""
    head = f"# {_AGENT}\n\nintro line\n"
    tail = f"{_BODY_HEADING}\nsentinel body line\n{_BODY_TERMINAL}\n"
    fill = size - len(head) - len(tail)
    if fill < 0:
        raise ValueError("requested size smaller than the fixture landmarks")
    filler = ("filler line\n" * (fill // 12 + 1))[:fill]
    if filler and not filler.endswith("\n"):
        filler = filler[:-1] + "\n"
    return head + filler + tail


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class RuleCorpusExcerptTest(unittest.TestCase):
    """(a) whole heading blocks from beyond the former cap reach the C2 slot."""

    def test_when_rules_sections_past_former_cap_then_both_reach_the_prompt_whole(self):
        body = _rules_body()
        self.assertGreater(body.index(_RULES_HEADING_A), _FORMER_CAP)
        self.assertGreater(body.index(_RULES_HEADING_B), body.index(_RULES_HEADING_A))

        with tempfile.TemporaryDirectory() as live:
            live_root = Path(live)
            _write_agent(live_root, f"# {_AGENT}\n\nbody line\n")
            rules = live_root / "GLASS_ATRIUM_GLOBAL_RULES.md"
            rules.write_text(body, encoding="utf-8")

            with _base_root(live_root), mock.patch.object(dc, "GLOBAL_RULES_FILE", rules):
                prompt, _ = _get_prompt(_RELATIVE_TARGET)

        for heading, terminal in (
            (_RULES_HEADING_A, _RULES_TERMINAL_A),
            (_RULES_HEADING_B, _RULES_TERMINAL_B),
        ):
            self.assertIn(heading, prompt)
            self.assertIn(terminal, prompt)

    def test_when_real_global_rules_read_then_turn_budget_section_is_whole(self):
        rules = dc.GLOBAL_RULES_FILE
        if rules is None or not rules.exists():
            self.skipTest(f"live GLOBAL_RULES file unreadable: {rules}")
        text = rules.read_text(encoding="utf-8", errors="replace")
        offset = text.find(_TURN_BUDGET_HEADING)
        if offset < 0:
            self.skipTest("canonical Turn Budget section absent from the live file")
        self.assertGreater(offset, _FORMER_CAP)

        block = next(
            b for b in dc._split_heading_blocks(text) if b.startswith(_TURN_BUDGET_HEADING)
        )
        lines = [line for line in block.splitlines() if line.strip()]

        with tempfile.TemporaryDirectory() as live:
            live_root = Path(live)
            _write_agent(live_root, f"# {_AGENT}\n\nbody line\n")
            with _base_root(live_root):
                prompt, _ = _get_prompt(_RELATIVE_TARGET)

        # Derived on both sides: the section's own first and last lines, never literals.
        self.assertIn(lines[0], prompt)
        self.assertIn(lines[-1], prompt)


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class TargetBodyExcerptTest(unittest.TestCase):
    """(b) the target agent body reaches the C4 slot whole, ending on a block boundary."""

    def setUp(self):
        try:
            self._corpus_max = _largest_registry_body_chars()
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            self.skipTest(f"registry corpus unreadable: {exc}")

    def test_when_body_sized_from_corpus_then_sentinel_block_reaches_the_prompt(self):
        body = _agent_body(self._corpus_max)
        self.assertGreater(body.index(_BODY_HEADING), _FORMER_CAP)

        with tempfile.TemporaryDirectory() as live:
            live_root = Path(live)
            _write_agent(live_root, body)
            with _base_root(live_root):
                prompt, _ = _get_prompt(_RELATIVE_TARGET)

        self.assertIn(_BODY_HEADING, prompt)
        self.assertIn(_BODY_TERMINAL, prompt)
        # Whole body verbatim → the excerpt ends on the body's own last line, so
        # no arbitrary character cut survives anywhere inside it.
        self.assertIn(body, prompt)


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class SectionExtractorTest(unittest.TestCase):
    """(c) + (d) block alignment under the bound, and the empty-file path."""

    @contextlib.contextmanager
    def _file(self, text: str):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "corpus.md"
            path.write_text(text, encoding="utf-8")
            yield path

    def test_when_bound_crossed_then_only_whole_blocks_survive(self):
        text = "## A\n" + "a line\n" * 100 + "## B\n" + "b line\n" * 100
        with self._file(text) as path:
            with contextlib.redirect_stderr(io.StringIO()):
                excerpt = dc._read_sections(path, 900)

        self.assertIn("## A\n", excerpt)
        self.assertNotIn("## B\n", excerpt)
        self.assertIn("TRUNCATED", excerpt)
        # Every surviving line is a complete line of the source.
        source_lines = set(text.splitlines())
        kept = [line for line in excerpt.splitlines() if "TRUNCATED" not in line]
        self.assertTrue(all(line in source_lines for line in kept if line))

    def test_when_first_block_oversized_then_kept_whole_and_loud(self):
        text = "## Only\n" + "x line\n" * 100
        with self._file(text) as path:
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                excerpt = dc._read_sections(path, 50)

        self.assertIn("x line", excerpt)
        self.assertIn("OVERSIZED", excerpt)
        self.assertIn("OVERSIZED", stderr.getvalue())

    def test_when_file_within_bound_then_returned_verbatim(self):
        text = "## A\nbody\n"
        with self._file(text) as path:
            self.assertEqual(dc._read_sections(path, 900), text)

    def test_when_file_empty_then_excerpt_is_empty(self):
        with self._file("") as path:
            self.assertEqual(dc._read_sections(path, 900), "")

    def test_when_path_missing_then_placeholder(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(
                dc._read_sections(Path(tmp) / "absent.md", 900), "(file not available)"
            )


if __name__ == "__main__":
    unittest.main()
