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

import json
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


_HEAD_SENTINEL = "HEAD_SENTINEL_9f3a21"
_TAIL_SENTINEL = "TAIL_SENTINEL_9f3a21"
_SUPERSEDE_ANCHOR = "REPLACES that one rule in place"
_APPEND_ONLY_ANCHOR = "DO NOT rewrite existing rules — only ADD"


def _largest_registry_body_chars() -> int:
    """Largest live registry agent body in characters — the corpus-derived size.

    Sized from the corpus rather than from any cap the implementation chose, so
    a retained cap can never be the yardstick that measures itself.
    """
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


def _sentinel_body(size: int) -> str:
    """Agent body of exactly `size` characters carrying the three T1 landmarks.

    HEAD sentinel inside the first editable region (opening in the first tenth),
    TAIL sentinel in the final 200 characters, last EDITABLE:END in the final tenth.
    """
    header = "---\nname: dev-python\n---\n"
    head_region = (
        "<!-- EDITABLE:BEGIN -->\n" f"{_HEAD_SENTINEL}\n" "<!-- EDITABLE:END -->\n"
    )
    tail = (
        "<!-- EDITABLE:BEGIN -->\n"
        "last region body\n"
        "<!-- EDITABLE:END -->\n"
        f"{_TAIL_SENTINEL}\n"
    )
    fill = size - len(header) - len(head_region) - len(tail)
    if fill < 0:
        raise ValueError("requested size smaller than the fixture landmarks")
    filler = ("filler line\n" * (fill // 12 + 1))[:fill]
    return header + head_region + filler + tail


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestGenerationPromptWholeFile(unittest.TestCase):
    """T1 — the whole target body reaches the prompt at BOTH generation sites."""

    def setUp(self) -> None:
        try:
            self._corpus_max = _largest_registry_body_chars()
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            self.skipTest(f"registry corpus unreadable: {exc}")

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

    def _assemble(self, site: str, body: str) -> str:
        (self._agents_dir / "dev-python.md").write_text(body, encoding="utf-8")
        if site == "patch":
            dc.generate_patch_proposal(_pattern(dc), [], agents_dir=self._agents_dir)
        else:
            with mock.patch.object(dc, "_fetch_pre_verify_failures", lambda agent: None):
                dc.generate_consolidated_proposal(
                    "dev-python", [_pattern(dc)], [], agents_dir=self._agents_dir
                )
        return self._captured["prompt"]

    def test_when_body_twice_the_corpus_max_then_earliest_region_visible(self) -> None:
        body = _sentinel_body(self._corpus_max * 2)
        for site in ("patch", "consolidated"):
            with self.subTest(site=site):
                prompt = self._assemble(site, body)
                self.assertIn(_HEAD_SENTINEL, prompt)
                self.assertIn(_TAIL_SENTINEL, prompt)
                self.assertIn("EDITABLE:END", prompt)

    def test_when_body_doubles_then_prompt_grows_by_the_same_amount(self) -> None:
        small = _sentinel_body(self._corpus_max * 2)
        large = _sentinel_body(self._corpus_max * 4)
        for site in ("patch", "consolidated"):
            with self.subTest(site=site):
                len_small = len(self._assemble(site, small))
                len_large = len(self._assemble(site, large))
                self.assertEqual(len_large - len_small, len(large) - len(small))


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestSupersedePermissionPrompt(unittest.TestCase):
    """T5b-1 — conditional supersede permission replaces the append-only rule."""

    def test_when_templates_read_then_permission_present_at_both_sites(self) -> None:
        for template in (dc._PROMPT_TEMPLATE, dc._CONSOLIDATED_PROMPT_TEMPLATE):
            self.assertIn(_SUPERSEDE_ANCHOR, template)
            self.assertNotIn(_APPEND_ONLY_ANCHOR, template)

    def test_when_templates_read_then_pure_add_still_required_without_a_rule(
        self,
    ) -> None:
        for template in (dc._PROMPT_TEMPLATE, dc._CONSOLIDATED_PROMPT_TEMPLATE):
            self.assertIn("pure ADD", template)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestLoopEventRemovedLines(unittest.TestCase):
    """T6 — changes_removed measured from the FULL pre-truncation diff."""

    def _proposal_from_raw(self, diff: str) -> "dc.PatchProposal":
        raw = f"RATIONALE: fixture\nTOUCHES_FRONTMATTER: false\nADDED_LINES: 1\nDIFF:\n{diff}"
        with mock.patch.object(dc, "_gate_validated_diff", lambda d, t: d):
            return dc._parse_haiku_response(raw, Path("dev-python.md"))

    def _events(self, proposal) -> list[dict]:
        report = dc.CycleReport(
            cycle_date="2026-08-16",
            generated_at="2026-08-16T00:00:00.000Z",
            patterns_processed=1,
            cost_guard={},
            patches=[
                dc.PatchResult(
                    pattern_label="fixture",
                    pattern_agent="dev-python",
                    pattern_frequency="1",
                    target_file="dev-python.md",
                    classification="body-auto",
                    rationale="fixture",
                    proposed_diff=proposal.proposed_diff,
                    outcomes_sampled=0,
                    haiku_status="ok",
                    estimated_added_lines=proposal.estimated_added_lines,
                    estimated_removed_lines=proposal.estimated_removed_lines,
                )
            ],
        )
        return dc._aggregate_loop_events(report)

    def test_when_diff_exceeds_stored_cap_then_removed_count_is_from_full_diff(
        self,
    ) -> None:
        # 4200 characters of context before the removed line → the removal sits
        # past the 4000-char stored-diff cut.
        padding = "".join(f" context line {i:04d}\n" for i in range(240))
        diff = (
            "--- a/dev-python.md\n"
            "+++ b/dev-python.md\n"
            "@@ -1,3 +1,3 @@\n"
            f"{padding}"
            "-superseded rule line\n"
            "+replacement rule line\n"
        )
        self.assertGreater(len(diff), 4000)
        proposal = self._proposal_from_raw(diff)
        self.assertEqual(len(proposal.proposed_diff), 4000)
        self.assertEqual(dc._count_removed_lines(proposal.proposed_diff), 0)
        events = self._events(proposal)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["args"]["changes_removed"], 1)

    def test_when_patch_is_pure_add_then_removed_count_is_zero(self) -> None:
        diff = (
            "--- a/dev-python.md\n"
            "+++ b/dev-python.md\n"
            "@@ -1,2 +1,3 @@\n"
            " context line\n"
            "+added rule line\n"
        )
        events = self._events(self._proposal_from_raw(diff))
        self.assertEqual(events[0]["args"]["changes_removed"], 0)


if __name__ == "__main__":
    unittest.main()
