"""Behavioral tests for the optimizer-side avoid-memory block (SkillOpt R2).

``daemon_cycle.generate_consolidated_proposal`` now prepends this agent's recent
pre_verify-FAILED diff shapes into the generation prompt so the generator learns
to avoid known-bad patterns. Covered here:
  (a) ``_fetch_pre_verify_failures`` returns ``None`` (fail-OPEN) when PG is off;
  (b) with stubbed failure rows, the assembled consolidated prompt CONTAINS the
      avoid-pattern block (and the Korean header);
  (c) the HARD char cap truncates an oversized block (length bounded + loud
      truncation marker present);
  (d) empty / None history → block omitted, prompt still well-formed (no
      empty-header noise, both neighboring blocks intact).

The new helper is fetched through ``_pg_connect`` under the ``HAS_PG_LOOP_WRITE``
gate. psycopg-absent means that helper is UNBOUND (not a module attr), so these
tests stub at the ``_fetch_pre_verify_failures`` boundary (always a module attr)
for the prompt-assembly cases, and patch ``HAS_PG_LOOP_WRITE`` for the gate case.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_pre_verify_avoid_memory.py -v
    python3 -m unittest autoagent.test.test_pre_verify_avoid_memory -v
"""

from __future__ import annotations

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

_AVOID_HEADER = "diff types that previously failed pre_verify for this agent"


def _pattern(dc_mod, label: str = "test signal", agent: str = "dev-python"):
    return dc_mod.Pattern(
        date="2026-06-14",
        label=label,
        frequency="3",
        agent=agent,
        status="identified",
        tier="user-pending",
        raw_line=f"pg:learning_log:1:{label}|{agent}",
        row_id=1,
    )


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestFetchPreVerifyFailures(unittest.TestCase):
    """Helper fail-OPEN discipline (test a)."""

    def test_when_pg_off_then_returns_none(self) -> None:
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", False):
            self.assertIsNone(dc._fetch_pre_verify_failures("dev-python"))

    def test_when_agent_empty_then_returns_none(self) -> None:
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True):
            self.assertIsNone(dc._fetch_pre_verify_failures(""))


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestRenderPreVerifyFailuresBlock(unittest.TestCase):
    """Block rendering + HARD char cap (test c)."""

    def test_when_empty_rows_then_empty_string(self) -> None:
        self.assertEqual(dc._render_pre_verify_failures_block([]), "")

    def test_when_rows_then_failed_axes_and_rationale_rendered(self) -> None:
        rows = [({"C1": True, "C2": False, "C3": False, "C4": True}, "edited frontmatter")]
        out = dc._render_pre_verify_failures_block(rows)
        self.assertIn("C2", out)
        self.assertIn("C3", out)
        self.assertNotIn("C1", out)  # passing axis not listed
        self.assertIn("edited frontmatter", out)

    def test_when_no_failed_axes_then_unspecified_placeholder(self) -> None:
        out = dc._render_pre_verify_failures_block([({"C1": True}, "some reason")])
        self.assertIn("unspecified-axis", out)

    def test_when_rationale_blank_then_placeholder(self) -> None:
        out = dc._render_pre_verify_failures_block([({"C2": False}, "")])
        self.assertIn("(no rationale recorded)", out)

    def test_when_block_oversized_then_hard_capped_with_marker(self) -> None:
        rows = [({"C2": False}, "x" * 9000)]
        out = dc._render_pre_verify_failures_block(rows)
        self.assertLessEqual(len(out), dc.PRE_VERIFY_FAILURES_CHAR_CAP)
        self.assertIn("TRUNCATED: avoid-pattern memory capped", out)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestConsolidatedPromptInjection(unittest.TestCase):
    """Prompt assembly contains / omits the block (tests b + d).

    ``skip_haiku`` returns early BEFORE prompt assembly, so to exercise the
    assembly path the Haiku invoke is stubbed at ``_run_haiku_with_retry`` and
    the assembled ``base_prompt`` captured.
    """

    def setUp(self) -> None:
        self._captured: dict[str, str] = {}

        def _capture(*, base_prompt, target_file, label_hint, claude_bin, timeout_sec):
            self._captured["prompt"] = base_prompt
            return dc.PatchProposal(
                target_file=str(target_file),
                rationale="stub",
                proposed_diff="",
                touched_frontmatter=False,
                estimated_added_lines=0,
                raw_response="",
                parse_mode="skipped",
            )

        patcher = mock.patch.object(dc, "_run_haiku_with_retry", _capture)
        patcher.start()
        self.addCleanup(patcher.stop)

        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._agents_dir = Path(self._tmp.name)
        # Minimal agent .md with a YAML frontmatter + body (assembly reads it).
        (self._agents_dir / "dev-python.md").write_text(
            "---\nname: dev-python\n---\n# Body\nWork rule line.\n",
            encoding="utf-8",
        )

    def _run(self, fetch_return):
        with mock.patch.object(
            dc, "_fetch_pre_verify_failures", lambda agent: fetch_return
        ):
            dc.generate_consolidated_proposal(
                "dev-python",
                [_pattern(dc)],
                [],
                agents_dir=self._agents_dir,
            )
        return self._captured["prompt"]

    def test_when_failures_present_then_block_in_prompt(self) -> None:
        rows = [({"C2": False, "C3": False}, "edited the tools frontmatter line")]
        prompt = self._run(rows)
        self.assertIn(_AVOID_HEADER, prompt)
        self.assertIn("edited the tools frontmatter line", prompt)
        self.assertIn("C2", prompt)
        # Neighboring blocks still intact.
        self.assertIn("OBSERVED LEARNING SIGNALS", prompt)
        self.assertIn("PRIOR-DAY OUTCOMES", prompt)

    def test_when_history_empty_then_block_omitted(self) -> None:
        prompt = self._run([])
        self.assertNotIn(_AVOID_HEADER, prompt)
        # Prompt is still well-formed — both neighboring blocks present.
        self.assertIn("OBSERVED LEARNING SIGNALS", prompt)
        self.assertIn("PRIOR-DAY OUTCOMES", prompt)

    def test_when_history_none_then_block_omitted(self) -> None:
        prompt = self._run(None)
        self.assertNotIn(_AVOID_HEADER, prompt)
        self.assertIn("PRIOR-DAY OUTCOMES", prompt)

    def test_when_oversized_failures_then_prompt_block_capped(self) -> None:
        rows = [({"C2": False}, "y" * 9000)]
        prompt = self._run(rows)
        self.assertIn(_AVOID_HEADER, prompt)
        self.assertIn("TRUNCATED: avoid-pattern memory capped", prompt)


if __name__ == "__main__":
    unittest.main()
