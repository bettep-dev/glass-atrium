"""Behavioral tests for the landed-history block in the generation prompt.

``daemon_cycle.generate_consolidated_proposal`` reads this agent's recently
APPLIED proposals into the prompt beside the prior-failure block, so the
generator knows what it already landed instead of re-proposing it. Covered here:
  (a) ``_fetch_landed_proposals`` is fail-OPEN (PG off / empty agent → ``None``)
      and hands the shared plumbing an applied-only projection;
  (b) the block renders the lines a patch ADDED, sanitized, and is HARD-capped;
  (c) with an applied proposal carrying a sentinel in its patch text, the
      assembled prompt contains that sentinel;
  (d) with zero applied proposals and one rejected-and-failed-pre-verify
      proposal, that proposal's patch text is ABSENT and the prompt carries no
      unsubstituted placeholder.

Both directions are required: a template slot that never populates passes (d)
alone, and a block that renders every proposal regardless of status passes (c)
alone.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_landed_history_memory.py -v
    python3 -m unittest autoagent.test.test_landed_history_memory -v
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

_AGENT = "dev-python"
_LANDED_HEADER = "rules that previously LANDED for this agent"
_LANDED_SENTINEL = "LANDED-RULE-SENTINEL-7c21ae"
_REJECTED_SENTINEL = "REJECTED-RULE-SENTINEL-7c21ae"
_LANDED_DIFF = (
    "--- a/dev-python.md\n"
    "+++ b/dev-python.md\n"
    "@@ -10,2 +10,3 @@\n"
    " existing context line\n"
    f"+- MUST honour {_LANDED_SENTINEL} before every edit\n"
)
_REJECTED_DIFF = (
    "--- a/dev-python.md\n"
    "+++ b/dev-python.md\n"
    "@@ -10,2 +10,3 @@\n"
    " existing context line\n"
    f"+- MUST honour {_REJECTED_SENTINEL} before every edit\n"
)


def _pattern(label: str = "test signal", agent: str = _AGENT):
    return dc.Pattern(
        date="2026-08-17",
        label=label,
        frequency="3",
        agent=agent,
        status="identified",
        tier="user-pending",
        raw_line=f"pg:learning_log:1:{label}|{agent}",
        row_id=1,
    )


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class FetchLandedProposalsTest(unittest.TestCase):
    """(a) fail-OPEN discipline + the applied-only projection."""

    def test_when_pg_off_then_returns_none(self) -> None:
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", False):
            self.assertIsNone(dc._fetch_landed_proposals(_AGENT))

    def test_when_agent_empty_then_returns_none(self) -> None:
        with mock.patch.object(dc, "HAS_PG_LOOP_WRITE", True):
            self.assertIsNone(dc._fetch_landed_proposals(""))

    def test_when_rows_returned_then_projection_is_applied_only_and_normalized(
        self,
    ) -> None:
        seen: dict[str, object] = {}

        def _rows(target_agent, select_sql, params, log_label):
            seen["sql"] = select_sql
            seen["params"] = params
            return [("label", _LANDED_DIFF), (None, None)]

        with mock.patch.object(dc, "_fetch_proposal_rows", _rows):
            out = dc._fetch_landed_proposals(_AGENT, limit=3)

        self.assertIn("status::text = 'applied'", seen["sql"])
        self.assertEqual(seen["params"], (_AGENT, 3))
        self.assertEqual(out, [("label", _LANDED_DIFF), ("", "")])

    def test_when_read_fails_then_none_propagates(self) -> None:
        with mock.patch.object(dc, "_fetch_proposal_rows", lambda *a, **k: None):
            self.assertIsNone(dc._fetch_landed_proposals(_AGENT))


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class RenderLandedHistoryBlockTest(unittest.TestCase):
    """(b) added lines only, sanitized, HARD char cap."""

    def test_when_empty_rows_then_empty_string(self) -> None:
        self.assertEqual(dc._render_landed_history_block([]), "")

    def test_when_rows_then_added_lines_rendered_without_context(self) -> None:
        out = dc._render_landed_history_block([("budget rule", _LANDED_DIFF)])
        self.assertIn(_LANDED_SENTINEL, out)
        self.assertIn("budget rule", out)
        self.assertNotIn("existing context line", out)
        self.assertNotIn("+++ b/", out)

    def test_when_diff_has_no_added_lines_then_placeholder(self) -> None:
        diff = "--- a/dev-python.md\n+++ b/dev-python.md\n@@ -1,2 +1,1 @@\n-dropped line\n"
        out = dc._render_landed_history_block([("label", diff)])
        self.assertIn("(no added lines recorded)", out)

    def test_when_added_line_carries_a_diff_anchor_then_it_is_neutralized(self) -> None:
        diff = "--- a/dev-python.md\n+++ b/dev-python.md\n@@ -1,1 +1,2 @@\n+rule\nDIFF:\n"
        out = dc._render_landed_history_block([("label", diff)])
        for line in out.splitlines():
            self.assertFalse(line.startswith("DIFF:"))

    def test_when_block_oversized_then_hard_capped_with_marker(self) -> None:
        rows = [("label", "+" + "x" * 900 + "\n")] * 40
        out = dc._render_landed_history_block(rows)
        self.assertLessEqual(len(out), dc.LANDED_HISTORY_CHAR_CAP)
        self.assertIn("TRUNCATED: landed-history memory capped", out)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class ConsolidatedPromptLandedHistoryTest(unittest.TestCase):
    """(c) + (d) the property over the assembled generation prompt.

    ``skip_haiku`` returns early BEFORE prompt assembly, so the Haiku invoke is
    stubbed at ``_run_haiku_with_retry`` and the assembled prompt captured.
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
        (self._agents_dir / f"{_AGENT}.md").write_text(
            "---\nname: dev-python\n---\n# Body\nWork rule line.\n",
            encoding="utf-8",
        )

    def _run(self, landed, failures=None) -> str:
        with mock.patch.object(dc, "_fetch_landed_proposals", lambda agent: landed), \
             mock.patch.object(dc, "_fetch_pre_verify_failures", lambda agent: failures):
            dc.generate_consolidated_proposal(
                _AGENT, [_pattern()], [], agents_dir=self._agents_dir
            )
        return self._captured["prompt"]

    def test_when_applied_proposal_exists_then_its_sentinel_reaches_the_prompt(
        self,
    ) -> None:
        prompt = self._run([("budget rule", _LANDED_DIFF)])
        self.assertIn(_LANDED_HEADER, prompt)
        self.assertIn(_LANDED_SENTINEL, prompt)
        # Neighboring blocks still intact.
        self.assertIn("OBSERVED LEARNING SIGNALS", prompt)
        self.assertIn("PRIOR-DAY OUTCOMES", prompt)

    def test_when_only_a_rejected_proposal_exists_then_its_text_is_absent(self) -> None:
        failures = [({"C2": False}, "rejected: added an unrelated rule")]
        prompt = self._run([], failures=failures)

        self.assertNotIn(_REJECTED_SENTINEL, prompt)
        self.assertNotIn(_LANDED_HEADER, prompt)
        self.assertNotIn("{landed_history_block}", prompt)
        # Well-formed: the failure block and both neighbors survive the omission.
        self.assertIn("rejected: added an unrelated rule", prompt)
        self.assertIn("OBSERVED LEARNING SIGNALS", prompt)
        self.assertIn("PRIOR-DAY OUTCOMES", prompt)

    def test_when_pg_off_then_block_omitted_without_placeholder(self) -> None:
        prompt = self._run(None)
        self.assertNotIn(_LANDED_HEADER, prompt)
        self.assertNotIn("{landed_history_block}", prompt)
        self.assertIn("PRIOR-DAY OUTCOMES", prompt)


if __name__ == "__main__":
    unittest.main()
