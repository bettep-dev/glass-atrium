"""Behavioral tests for what the generation prompt is built from.

Generation stays closed: every row renders through a template builder with the
Haiku invoke stubbed at ``_run_haiku_with_retry``, never a live generator call.
Covered here:
  (a) an outcome record's self-reported fields — summary, lesson, directive_hint
      and the result / confidence / metric_pass / task_type / revision_count /
      evaluative_signal / attribution_source header — never reach either template.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_generator_inputs.py -v
    python3 -m unittest autoagent.test.test_generator_inputs -v
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
_TEST_DIR = Path(__file__).resolve().parent

for _path in (_HOOKS_DIR, _AUTOAGENT_DIR, _TEST_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

from _pg_seal import seal_pg_reach

_AGENT = "dev-python"
_REVISION_COUNT_SENTINEL = 48151
_SELF_REPORT_SENTINELS = {
    "summary": "SUMMARY-SENTINEL-5e0b9d",
    "lesson": "LESSON-SENTINEL-5e0b9d",
    "directive_hint": "DIRECTIVE-HINT-SENTINEL-5e0b9d",
    "result": "RESULT-SENTINEL-5e0b9d",
    "confidence": "CONFIDENCE-SENTINEL-5e0b9d",
    "metric_pass": "METRIC-PASS-SENTINEL-5e0b9d",
    "task_type": "TASK-TYPE-SENTINEL-5e0b9d",
    "attribution_source": "ATTRIBUTION-SENTINEL-5e0b9d",
}


def _write_outcome_record(directory: Path) -> Path:
    """A legacy outcome record carrying a sentinel in every self-reported field."""
    s = _SELF_REPORT_SENTINELS
    record = directory / "2026-10-04-0900_dev-python_feature.md"
    record.write_text(
        "---\n"
        f"agent: {_AGENT}\n"
        f"task_type: {s['task_type']}\n"
        f"result: {s['result']}\n"
        f"confidence: {s['confidence']}\n"
        f"metric_pass: {s['metric_pass']}\n"
        f"revision_count: {_REVISION_COUNT_SENTINEL}\n"
        "evaluative_signal: -1\n"
        f"directive_hint: {s['directive_hint']}\n"
        f"attribution_source: {s['attribution_source']}\n"
        "---\n\n"
        f"## summary\n{s['summary']}\n\n"
        f"## Lesson\n{s['lesson']}\n",
        encoding="utf-8",
    )
    return record


def _pattern():
    label = "repeated budget overrun"
    return dc.Pattern(
        date="2026-10-04",
        label=label,
        frequency="3",
        agent=_AGENT,
        status="identified",
        tier="user-pending",
        raw_line=f"pg:learning_log:1:{label}|{_AGENT}",
        row_id=1,
    )


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestSelfReportedFieldsNeverRendered(unittest.TestCase):
    """(a) no self-reported outcome field reaches the generation prompt."""

    def setUp(self) -> None:
        self._reach = seal_pg_reach(self)
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

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self._agents_dir = Path(tmp.name)
        (self._agents_dir / f"{_AGENT}.md").write_text(
            "---\nname: dev-python\n---\n# Body\nWork rule line.\n",
            encoding="utf-8",
        )
        self._record = dc._parse_outcome_file(_write_outcome_record(self._agents_dir))

    def _render_single_pattern(self) -> None:
        dc.generate_patch_proposal(
            _pattern(), [self._record], agents_dir=self._agents_dir
        )

    def _render_consolidated(self) -> None:
        dc.generate_consolidated_proposal(
            _AGENT, [_pattern()], [self._record], agents_dir=self._agents_dir
        )

    def test_when_record_carries_self_report_then_no_field_reaches_either_template(
        self,
    ) -> None:
        templates = (
            ("single-pattern template", self._render_single_pattern),
            ("consolidated template", self._render_consolidated),
        )
        for name, render in templates:
            with self.subTest(template=name):
                self._captured.clear()
                render()
                prompt = self._captured["prompt"]
                # The builder ran end to end: the agent file reached the prompt.
                self.assertIn("Work rule line.", prompt)
                for field, sentinel in _SELF_REPORT_SENTINELS.items():
                    self.assertNotIn(sentinel, prompt, f"{field} rendered")
                self.assertNotIn(str(_REVISION_COUNT_SENTINEL), prompt)
                self.assertNotIn("evaluative_signal=", prompt)
        self.assertEqual(self._reach, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
