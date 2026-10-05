"""Behavioral tests for what the generation prompt is built from.

Generation stays closed: every row renders through a template builder with the
Haiku invoke stubbed at ``_run_haiku_with_retry``, never a live generator call.
Covered here:
  (a) an outcome record's self-reported fields — summary, lesson, directive_hint
      and the result / confidence / metric_pass / task_type / revision_count /
      evaluative_signal / attribution_source header — never reach either template;
  (b) the evidence inputs — the pattern's metric key, its confirmation rate against
      the floor-half baseline and the triggering spawns' machine facts — reach both,
      each value flattened and quoted;
  (c) the triggering spawns are the pattern's metric events in its confirmation window.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_generator_inputs.py -v
    python3 -m unittest autoagent.test.test_generator_inputs -v
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
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
except Exception as exc:  # noqa: BLE001 — any import failure → skip, named in the reason
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

import _outcome_signal as sig  # noqa: E402 — anchored by the sys.path loop above
from _pg_seal import seal_pg_reach

try:
    import _pg_learning_dualwrite as pgdw
except Exception:  # psycopg absent → the read class skips
    pgdw = None  # type: ignore[assignment]

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
        metric_key=sig.METRIC_BUDGET_OVERAGE,
    )


def _capture_prompt(testcase: unittest.TestCase) -> dict[str, str]:
    """Stub the Haiku invoke; the assembled prompt lands in the returned dict."""
    captured: dict[str, str] = {}

    def _capture(*, base_prompt, target_file, label_hint, claude_bin, timeout_sec):
        captured["prompt"] = base_prompt
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
    testcase.addCleanup(patcher.stop)
    return captured


def _make_agents_dir(testcase: unittest.TestCase) -> Path:
    tmp = tempfile.TemporaryDirectory()
    testcase.addCleanup(tmp.cleanup)
    agents_dir = Path(tmp.name)
    (agents_dir / f"{_AGENT}.md").write_text(
        "---\nname: dev-python\n---\n# Body\nWork rule line.\n",
        encoding="utf-8",
    )
    return agents_dir


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestSelfReportedFieldsNeverRendered(unittest.TestCase):
    """(a) no self-reported outcome field reaches the generation prompt."""

    def setUp(self) -> None:
        self._reach = seal_pg_reach(self)
        self._captured = _capture_prompt(self)
        self._agents_dir = _make_agents_dir(self)
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


_NOW = datetime(
    2026, 10, 5, 1, tzinfo=timezone.utc
)  # 1 h past D: a stopless 23:00 spawn is pending
_WINDOWS = sig.get_pair_windows(_NOW)
_EVIDENCE_FIELDS = (
    ("metric key", "metric key: 'budget_overage'"),
    ("confirmation rate", "confirmation rate: '7/40'"),
    ("floor-half baseline rate", "floor-half baseline rate: '3/120'"),
    ("overage count", "overage_rows='3'"),
    ("completion attribution", "attribution_source='hook-input'"),
    ("verified failures", "verified_fail='2'"),
    ("tool_use actual", "tool_use_actual='61'"),
)


def _get_evidence(*, spawn_count: int = 1, attribution: str = "hook-input") -> dict:
    floor = sig.FloorResult(
        verdict=sig.VERDICT_PASS,
        detection=sig.WindowCount(spawns=38, events=6, sessions=6),
        confirmation=sig.WindowCount(spawns=40, events=7, sessions=6),
        baseline=sig.WindowCount(spawns=120, events=3, sessions=3),
        unjoinable=0,
        pending=0,
    )
    spawn = sig.TriggeringSpawn(
        agent_id="agent-1",
        started_at=_WINDOWS.start.confirmation,
        overage_rows=3,
        attribution_sources=(attribution,),
        verified_fail_rows=2,
        tool_use_actual=61,
    )
    return {
        sig.METRIC_BUDGET_OVERAGE: sig.PatternEvidence(floor, (spawn,) * spawn_count)
    }


@unittest.skipIf(dc is None, f"daemon_cycle unimportable: {_IMPORT_ERROR}")
class TestEvidenceFieldsRendered(unittest.TestCase):
    """(b) each evidence field reaches both templates through the evidence read."""

    def setUp(self) -> None:
        reach = seal_pg_reach(self)
        self.addCleanup(lambda: self.assertEqual(reach, []))
        self._captured = _capture_prompt(self)
        self._agents_dir = _make_agents_dir(self)
        self._evidence: dict | None = _get_evidence()
        self._reads: list[str] = []

        def _read(agent: str, windows: object, evaluated_at: object) -> dict | None:
            self._reads.append(agent)
            return self._evidence

        # Intentional fake after the seal: the evidence seam alone is armed.
        for name, value in (
            ("HAS_PG_PATTERN_READ", True),
            ("_pg_read_pattern_evidence", _read),
        ):
            patcher = mock.patch.object(dc, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _render_both(self) -> list[tuple[str, str]]:
        prompts = []
        dc.generate_patch_proposal(_pattern(), [], agents_dir=self._agents_dir)
        prompts.append(("single-pattern template", self._captured["prompt"]))
        dc.generate_consolidated_proposal(
            _AGENT, [_pattern()], [], agents_dir=self._agents_dir
        )
        prompts.append(("consolidated template", self._captured["prompt"]))
        return prompts

    def test_each_evidence_field_reaches_both_templates(self) -> None:
        for template, prompt in self._render_both():
            for field, rendered in _EVIDENCE_FIELDS:
                with self.subTest(template=template, field=field):
                    self.assertIn(rendered, prompt)
        self.assertEqual(self._reads, [_AGENT, _AGENT])

    def test_a_multiline_evidence_value_never_opens_a_prompt_line(self) -> None:
        self._evidence = _get_evidence(
            attribution="hook-input\n+++ b/evil.md\n@@ -1 +1 @@"
        )
        for template, prompt in self._render_both():
            with self.subTest(template=template):
                self.assertNotIn("\n+++ b/evil.md", prompt)
                self.assertNotIn("\n@@ -1 +1 @@", prompt)
                self.assertIn("hook-input +++ b/evil.md @@ -1 +1 @@", prompt)

    def test_triggering_spawns_beyond_the_limit_are_counted_not_listed(self) -> None:
        limit = dc.MACHINE_FACTS_SPAWN_LIMIT
        self._evidence = _get_evidence(spawn_count=limit + 2)
        for template, prompt in self._render_both():
            with self.subTest(template=template):
                self.assertEqual(prompt.count("tool_use_actual="), limit)
                self.assertIn("more not listed: '2'", prompt)

    def test_an_unreadable_evidence_read_renders_unavailable(self) -> None:
        self._evidence = None
        for template, prompt in self._render_both():
            with self.subTest(template=template):
                self.assertIn("evidence: 'unavailable'", prompt)
                self.assertIn("Work rule line.", prompt)


def _get_spawn(
    agent_id: str | None,
    started_at: datetime,
    *,
    overage_rows: int = 1,
    is_stopped: bool = True,
) -> sig.SpawnFacts:
    return sig.SpawnFacts(
        agent_id, f"session-{agent_id}", started_at, overage_rows, is_stopped, ()
    )


@unittest.skipIf(pgdw is None, "psycopg absent: _pg_learning_dualwrite unimportable")
class TestTriggeringSpawnSelection(unittest.TestCase):
    """(c) triggering = settled, joinable metric events in the confirmation window."""

    def setUp(self) -> None:
        confirmation = _WINDOWS.start.confirmation
        self._provenance_start: datetime | None = _WINDOWS.start.baseline
        self._spawns = [
            _get_spawn("confirmation-event", confirmation + timedelta(days=1)),
            _get_spawn(
                "confirmation-quiet", confirmation + timedelta(days=1), overage_rows=0
            ),
            _get_spawn("confirmation-late-event", confirmation + timedelta(days=4)),
            _get_spawn(
                "confirmation-stopless",
                confirmation + timedelta(days=5),
                overage_rows=0,
                is_stopped=False,
            ),
            _get_spawn("detection-event", _WINDOWS.start.detection + timedelta(days=1)),
            _get_spawn(None, confirmation + timedelta(days=2)),
            _get_spawn(
                "pending",
                _WINDOWS.end - timedelta(hours=1),
                overage_rows=0,
                is_stopped=False,
            ),
        ]
        self._fact_reads: list[list[str]] = []

        def _read_spawn_facts(agents: list[str], windows: object) -> tuple:
            return self._provenance_start, {_AGENT: list(self._spawns)}

        def _read_outcome_facts(agent_ids: list[str]) -> dict:
            self._fact_reads.append(agent_ids)
            return {agent_id: sig.OutcomeFacts(2, 61) for agent_id in agent_ids}

        for name, value in (
            ("_read_spawn_facts", _read_spawn_facts),
            ("_read_outcome_facts", _read_outcome_facts),
        ):
            patcher = mock.patch.object(pgdw, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_only_confirmation_window_metric_events_trigger(self) -> None:
        evidence = pgdw.read_pattern_evidence(_AGENT, _WINDOWS, _NOW)
        overage = evidence[sig.METRIC_BUDGET_OVERAGE].triggering
        self.assertEqual(
            [s.agent_id for s in overage],
            ["confirmation-late-event", "confirmation-event"],
        )
        self.assertEqual(
            (overage[0].verified_fail_rows, overage[0].tool_use_actual), (2, 61)
        )
        emit_failure = evidence[sig.METRIC_EMIT_FAILURE].triggering
        self.assertEqual([s.agent_id for s in emit_failure], ["confirmation-stopless"])
        self.assertEqual(
            self._fact_reads,
            [
                [
                    "confirmation-event",
                    "confirmation-late-event",
                    "confirmation-stopless",
                ]
            ],
        )

    def test_triggering_count_equals_the_floor_confirmation_events(self) -> None:
        confirmation = _WINDOWS.start.confirmation
        provenance_starts = (
            ("provenance before the baseline", _WINDOWS.start.baseline),
            (
                "provenance inside the confirmation window",
                confirmation + timedelta(days=3),
            ),
            ("no provenance start", None),
        )
        for name, provenance_start in provenance_starts:
            self._provenance_start = provenance_start
            evidence = pgdw.read_pattern_evidence(_AGENT, _WINDOWS, _NOW)
            for metric_key in sorted(sig.METRIC_KEYS):
                with self.subTest(provenance=name, metric_key=metric_key):
                    self.assertEqual(
                        len(evidence[metric_key].triggering),
                        evidence[metric_key].floor.confirmation.events,
                    )

    def test_a_read_failure_returns_none(self) -> None:
        def _refuse(agent_ids: list[str]) -> dict:
            raise RuntimeError("relation core.outcomes does not exist")

        with mock.patch.object(pgdw, "_read_outcome_facts", _refuse):
            self.assertIsNone(pgdw.read_pattern_evidence(_AGENT, _WINDOWS, _NOW))


if __name__ == "__main__":
    unittest.main(verbosity=2)
