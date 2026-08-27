"""Behavioral tests for the diff excerpt in pre-verify prompt assembly.

``daemon_cycle._build_pre_verify_prompt`` hands the compliance verifier a bounded
excerpt of the proposed diff. A fixed character slice cuts mid-word inside a long
``+``/``-`` line and reaches the verifier as a mangled fragment with nothing
saying so: in the measured incident (live updater run, EDITABLE-merge path on
agents/glass-atrium-intel-planner.md — a 5331-char single-file diff carrying one
1761-char removed line and one 2034-char added line) the cut landed mid-word and
the verifier rejected the patch on axis C3 as "truncated mid-sentence ...
incomplete and unreadable" — a verdict on the excerpt, not on the patch. Covered
here:
  (a) a diff sized from that incident reaches the prompt BYTE-IDENTICAL;
  (b) past the bound the excerpt is cut at a LINE boundary, never mid-line;
  (c) past the bound an explicit marker rides in the excerpt AND on stderr, so
      the cut is never silent (Precondition Loud-Fail);
  (d) a single diff line wider than the whole bound is kept whole under its own
      marker, so the never-mid-line invariant holds in the degenerate case too;
  (e) the prompt teaches the verifier the marker prefix the excerpt emits, so the
      instruction and the emitted signals cannot drift apart.

The incident sizes are fixed historical measurements, never read from the
implementation's current bound — a fixture sized from the bound under test can
only measure that bound against itself. (b)-(d) are bound-RELATIVE properties, so
they legitimately read ``DIFF_EXCERPT_CHAR_CAP``: what is under test there is the
SHAPE of the cut, not the magnitude of the bound.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_pre_verify_diff_excerpt.py -v
    python3 -m unittest autoagent.test.test_pre_verify_diff_excerpt -v
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

# Fixed measurements from the incident — historical constants, never derived from
# the implementation's current bound.
_INCIDENT_DIFF_CHARS = 5331
_INCIDENT_REMOVED_LINE_CHARS = 1761
_INCIDENT_ADDED_LINE_CHARS = 2034

_REMOVED_TOKEN = "REMOVED-SENTINEL-9c4a"
_ADDED_TOKEN = "ADDED-SENTINEL-9c4a"


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


def _patch_proposal(diff: str):
    return dc.PatchProposal(
        target_file=_RELATIVE_TARGET,
        rationale="test rationale",
        proposed_diff=diff,
        touched_frontmatter=False,
        estimated_added_lines=1,
        raw_response="",
    )


def _write_agent(root: Path) -> Path:
    target = root / "agents" / f"{_AGENT}.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(f"# {_AGENT}\n\nbody line\n", encoding="utf-8")
    return target


def _get_prompt(diff: str) -> tuple[str, str]:
    """Assemble the pre-verify prompt around `diff`; return (prompt, stderr)."""
    captured = io.StringIO()
    with tempfile.TemporaryDirectory() as live:
        live_root = Path(live)
        _write_agent(live_root)
        with contextlib.redirect_stderr(captured), _base_root(live_root):
            prompt = dc._build_pre_verify_prompt(_patch_proposal(diff), _pattern())
    return prompt, captured.getvalue()


def _diff_block(prompt: str) -> str:
    """Slice the diff slot out of a rendered prompt, using the template's own fences.

    Both delimiters are derived from ``_PRE_VERIFY_PROMPT_TEMPLATE`` rather than
    copied, so re-wording the prompt around the slot cannot silently un-anchor
    this extraction.
    """
    head, tail = dc._PRE_VERIFY_PROMPT_TEMPLATE.split("{diff}")
    before = head[head.rindex("}") + 1 :]  # literal text between the last field and {diff}
    after = tail[: tail.index("{")]  # literal text between {diff} and the next field
    return prompt.split(before, 1)[1].split(after, 1)[0]


def _long_line(prefix: str, size: int, token: str) -> str:
    """One diff line of exactly `size` characters, newline excluded."""
    filler = "word " * (size // 5 + 2)
    line = (f"{prefix}{token} " + filler)[:size]
    assert "\n" not in line
    return line


def _incident_diff() -> str:
    """A unified diff of exactly the incident's size, carrying its two long lines."""
    head = (
        "--- a/agents/glass-atrium-intel-planner.md\n"
        "+++ b/agents/glass-atrium-intel-planner.md\n"
        "@@ -1,4 +1,4 @@\n"
        " context line\n"
    )
    removed = _long_line("-", _INCIDENT_REMOVED_LINE_CHARS, _REMOVED_TOKEN) + "\n"
    added = _long_line("+", _INCIDENT_ADDED_LINE_CHARS, _ADDED_TOKEN) + "\n"
    remaining = _INCIDENT_DIFF_CHARS - len(head) - len(removed) - len(added)
    if remaining < 0:
        raise ValueError("incident landmarks exceed the incident size")
    filler_line = " context filler\n"
    tail = filler_line * (remaining // len(filler_line))
    short = remaining - len(tail)
    if short == 1:
        tail += "\n"
    elif short > 1:
        tail += " " + "c" * (short - 2) + "\n"
    return head + removed + added + tail


def _oversized_diff(cap: int) -> str:
    """A whole-line diff comfortably past `cap`, so the bound decides the cut."""
    unit = _incident_diff()
    return unit * (cap // len(unit) + 2)


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class IncidentDiffTest(unittest.TestCase):
    """(a) the measured incident diff reaches the verifier byte-identical."""

    def test_when_diff_sized_from_the_incident_then_it_reaches_the_prompt_whole(self):
        diff = _incident_diff()
        self.assertEqual(len(diff), _INCIDENT_DIFF_CHARS)

        prompt, _ = _get_prompt(diff)

        # Byte-identity is the assertion: the long added line must arrive with its
        # last character, not cut mid-word as the incident's excerpt was.
        self.assertEqual(_diff_block(prompt), diff)
        self.assertIn(_ADDED_TOKEN, prompt)
        self.assertIn(_REMOVED_TOKEN, prompt)

    def test_when_diff_under_the_bound_then_no_marker_is_emitted(self):
        prompt, stderr = _get_prompt(_incident_diff())
        self.assertNotIn(dc.DIFF_EXCERPT_MARKER_PREFIX, _diff_block(prompt))
        self.assertNotIn(dc.DIFF_EXCERPT_MARKER_PREFIX, stderr)


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class TruncatedDiffTest(unittest.TestCase):
    """(b) + (c) past the bound: line-aligned cut, explicit marker, loud stderr."""

    def setUp(self):
        self.diff = _oversized_diff(dc.DIFF_EXCERPT_CHAR_CAP)
        self.assertGreater(len(self.diff), dc.DIFF_EXCERPT_CHAR_CAP)
        self.prompt, self.stderr = _get_prompt(self.diff)
        self.block = _diff_block(self.prompt)

    def _shown_lines(self) -> list[str]:
        return [
            line
            for line in self.block.splitlines()
            if line.strip() and not line.startswith(dc.DIFF_EXCERPT_MARKER_PREFIX)
        ]

    def test_when_bound_crossed_then_every_shown_line_is_a_whole_source_line(self):
        source_lines = set(self.diff.splitlines())
        shown = self._shown_lines()
        self.assertTrue(shown, "excerpt kept no diff lines at all")
        offenders = [line for line in shown if line not in source_lines]
        self.assertEqual(
            offenders[:1],
            [],
            "excerpt carries a line absent from the source diff — the cut landed mid-line",
        )

    def test_when_bound_crossed_then_the_excerpt_never_ends_mid_line(self):
        # The last shown line is the one the incident mangled ("not Tai"): it must
        # be a complete line of the source, terminal marker or not.
        self.assertIn(self._shown_lines()[-1], set(self.diff.splitlines()))

    def test_when_bound_crossed_then_marker_rides_in_the_excerpt(self):
        self.assertIn(dc.DIFF_TRUNCATED_SIGNAL, self.block)

    def test_when_bound_crossed_then_truncation_is_loud_on_stderr(self):
        self.assertIn(dc.DIFF_TRUNCATED_SIGNAL, self.stderr)

    def test_when_bound_crossed_then_excerpt_stays_within_a_line_of_the_bound(self):
        shown = "".join(f"{line}\n" for line in self._shown_lines())
        self.assertLessEqual(len(shown), dc.DIFF_EXCERPT_CHAR_CAP)


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class OversizedLineTest(unittest.TestCase):
    """(d) a diff line wider than the whole bound, in both of its positions."""

    def setUp(self):
        self.cap = dc.DIFF_EXCERPT_CHAR_CAP
        self.wide = _long_line("+", self.cap + 500, _ADDED_TOKEN)

    def test_when_the_first_line_exceeds_the_bound_then_it_is_kept_whole_and_loud(self):
        # Nothing else was kept, so an excerpt of nothing would be the alternative
        # — the same trade `_read_sections` makes for an oversized first block.
        prompt, stderr = _get_prompt(f"{self.wide}\n context tail\n")
        block = _diff_block(prompt)

        self.assertIn(self.wide, block)
        self.assertIn(dc.DIFF_OVERSIZED_LINE_SIGNAL, block)
        self.assertIn(dc.DIFF_OVERSIZED_LINE_SIGNAL, stderr)

    def test_when_a_later_line_exceeds_the_bound_then_the_cut_stays_line_aligned(self):
        # The wide line cannot fit beside what is already kept, so it is withheld
        # WHOLE: the excerpt still ends on a complete line, never mid-word.
        diff = f"@@ -1 +1 @@\n context line\n{self.wide}\n"
        prompt, _ = _get_prompt(diff)
        block = _diff_block(prompt)

        source_lines = set(diff.splitlines())
        shown = [
            line
            for line in block.splitlines()
            if line.strip() and not line.startswith(dc.DIFF_EXCERPT_MARKER_PREFIX)
        ]
        self.assertTrue(all(line in source_lines for line in shown), shown[-1][:80])
        self.assertNotIn(self.wide[: self.cap], block)
        self.assertIn(dc.DIFF_TRUNCATED_SIGNAL, block)


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class MarkerContractTest(unittest.TestCase):
    """(e) the prompt's instruction and the emitted signals share one prefix."""

    def test_when_prompt_rendered_then_it_teaches_the_marker_prefix(self):
        self.assertIn(dc.DIFF_EXCERPT_MARKER_PREFIX, dc._PRE_VERIFY_PROMPT_TEMPLATE)

    def test_when_signals_emitted_then_they_carry_the_taught_prefix(self):
        for signal in (dc.DIFF_TRUNCATED_SIGNAL, dc.DIFF_OVERSIZED_LINE_SIGNAL):
            self.assertTrue(signal.startswith(dc.DIFF_EXCERPT_MARKER_PREFIX), signal)


@unittest.skipIf(dc is None, f"daemon_cycle import failed: {_IMPORT_ERROR}")
class DiffExcerptUnitTest(unittest.TestCase):
    """The builder in isolation, independent of prompt assembly."""

    def test_when_under_bound_then_returned_verbatim(self):
        diff = "@@ -1 +1 @@\n-old\n+new\n"
        self.assertEqual(dc._diff_excerpt(diff, 900), diff)

    def test_when_empty_then_returned_verbatim(self):
        self.assertEqual(dc._diff_excerpt("", 900), "")

    def test_when_bound_crossed_then_only_whole_lines_survive(self):
        diff = "@@ -1 +1 @@\n" + "".join(f"+line {i:04d}\n" for i in range(200))
        with contextlib.redirect_stderr(io.StringIO()):
            excerpt = dc._diff_excerpt(diff, 300)

        source_lines = set(diff.splitlines())
        kept = [
            line
            for line in excerpt.splitlines()
            if line.strip() and not line.startswith(dc.DIFF_EXCERPT_MARKER_PREFIX)
        ]
        self.assertTrue(all(line in source_lines for line in kept))
        self.assertIn(dc.DIFF_TRUNCATED_SIGNAL, excerpt)


if __name__ == "__main__":
    unittest.main()
