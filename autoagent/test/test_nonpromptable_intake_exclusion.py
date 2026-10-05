"""Contract tests for intake eligibility by metric key.

``read_user_pending_patterns`` in ``autoagent/daemon_cycle.py`` admits only
intake rows that carry a primary metric key. A keyless row — a self-reported
discovery family, whatever its label — is skipped before the intake re-check
and generation, and the skip stays loud (stderr WARN + one
``eval_result='no-metric-key'`` loop event). A keyed row is admitted whatever
its label, the budget-overage family included.

Protected invariants:
(1) every keyless row is skipped and produces exactly one named row;
(2) every keyed row is admitted with its label and key unchanged;
(3) the skip path emits no write beyond the loop event, so terminal
    ``core.learning_log`` rows keep their status and last_transition_reason;
(4) a keyless row never reaches the generation loop, which holds the re-check.

Stub reader + recorded loop events — no PG is touched; the cycle row runs
under ``seal_pg_reach``. Run with either runner:
    uv run --with pytest pytest autoagent/test/test_nonpromptable_intake_exclusion.py -v
    python3 -m unittest autoagent.test.test_nonpromptable_intake_exclusion -v
"""

from __future__ import annotations

import contextlib
import io
import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_TEST_DIR = Path(__file__).resolve().parent

for _anchor in (_HOOKS_DIR, _AUTOAGENT_DIR, _TEST_DIR):
    if str(_anchor) not in sys.path:
        sys.path.insert(0, str(_anchor))

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

from _pg_seal import seal_pg_reach

_AGENT = "glass-atrium-dev-python"
_BUDGET_LABEL = "budget-overage concentration"
_SKIP_EVAL = "no-metric-key"


def _intake_row(
    label: str,
    row_id: int = 910001,
    agent: str = _AGENT,
    metric_key: str | None = None,
) -> dict:
    """One reader-shaped intake row (read_pending_learning_patterns contract)."""
    return {
        "id": row_id,
        "agent": agent,
        "pattern_signature": f"{label}|{agent}",
        "frequency": 4,
        "status": "identified",
        "discovered_date": date(2026, 8, 1),
        "metric_key": metric_key,
    }


def _get_skips(events: list[dict]) -> list[dict]:
    return [
        env["args"]
        for env in events
        if env.get("op") == "write_autoagent_loop_event"
        and env.get("args", {}).get("eval_result") == _SKIP_EVAL
    ]


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestMetricKeyIntakeEligibility(unittest.TestCase):
    def _intake(self, rows: list[dict]) -> tuple[list, list, str]:
        events: list[dict] = []
        pg_reach = seal_pg_reach(self)
        with tempfile.TemporaryDirectory() as d:
            agents_dir = Path(d)
            (agents_dir / f"{_AGENT}.md").write_text("probe", encoding="utf-8")
            patchers = (
                mock.patch.object(dc, "HAS_PG_PATTERN_READ", True),
                mock.patch.object(
                    dc, "_pg_read_pending_patterns", lambda: rows, create=True
                ),
                mock.patch.object(
                    dc,
                    "_invoke_pg_helper",
                    lambda envelope: events.append(envelope) or True,
                ),
            )
            for patcher in patchers:
                patcher.start()
                self.addCleanup(patcher.stop)
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                patterns = dc.read_user_pending_patterns(
                    agents_dir / "unused-log.md", 10, agents_dir=agents_dir, live=False
                )
        self.assertEqual(pg_reach, [])
        return patterns, events, stderr.getvalue()

    def test_a_keyless_row_is_skipped_with_one_named_row_whatever_its_label(
        self,
    ) -> None:
        labels = (
            ("budget-overage family", _BUDGET_LABEL),
            ("pattern-1 fail label", dc.PATTERN1_FAIL_LABEL_EN),
            ("pattern-1 legacy Korean label", dc.PATTERN1_FAIL_LABEL_KO),
            ("pattern-1 soft label", dc.PATTERN1_SOFT_LABEL_EN),
            (
                "pattern-5 rate label",
                "agent instruction-improvement candidate (failure rate 75%)",
            ),
            (
                "size-est label",
                "size-est under-estimate concentration (avg overrun +6 tool_uses)",
            ),
        )
        for name, label in labels:
            with self.subTest(name):
                patterns, events, stderr_text = self._intake([_intake_row(label)])
                self.assertEqual(patterns, [], f"{name} passed intake")
                self.assertIn(f"WARN: pattern {_SKIP_EVAL}", stderr_text)
                self.assertIn(_AGENT, stderr_text)
                self.assertIn(dc.NO_METRIC_KEY_REASON, stderr_text)
                skips = _get_skips(events)
                self.assertEqual(len(skips), 1, f"expected one named row, got {events}")
                self.assertEqual(skips[0]["agent"], _AGENT)
                self.assertEqual(skips[0]["changes_added"], 0)
                self.assertEqual(skips[0]["changes_removed"], 0)

    def test_a_keyed_budget_overage_row_passes_intake_with_its_key(self) -> None:
        patterns, events, stderr_text = self._intake(
            [_intake_row(_BUDGET_LABEL, metric_key="budget_overage")]
        )
        self.assertEqual(
            [(p.label, p.agent, p.metric_key) for p in patterns],
            [(_BUDGET_LABEL, _AGENT, "budget_overage")],
        )
        self.assertNotIn(_SKIP_EVAL, stderr_text)
        self.assertEqual(events, [])

    def test_a_mixed_batch_drops_only_the_keyless_rows(self) -> None:
        rows = [
            _intake_row(_BUDGET_LABEL, row_id=930001, metric_key="budget_overage"),
            _intake_row(dc.PATTERN1_SOFT_LABEL_EN, row_id=930002),
            _intake_row(
                "emit-failure concentration", row_id=930003, metric_key="emit_failure"
            ),
            _intake_row(dc.PATTERN1_FAIL_LABEL_KO, row_id=930004),
        ]
        patterns, events, _ = self._intake(rows)
        self.assertEqual(sorted(p.row_id for p in patterns), [930001, 930003])
        self.assertEqual(len(_get_skips(events)), 2)

    def test_a_keyless_row_off_the_roster_reports_roster_mismatch_not_the_key_skip(
        self,
    ) -> None:
        patterns, events, stderr_text = self._intake(
            [_intake_row("agent instruction-improvement candidate", agent="bug-fix")]
        )
        self.assertEqual(patterns, [])
        self.assertIn("WARN: intake roster mismatch", stderr_text)
        self.assertEqual(
            [env["args"]["eval_result"] for env in events], ["roster-mismatch"]
        )

    # The skip path writes nothing but the loop event, so terminal
    # core.learning_log rows keep their status and last_transition_reason.
    def test_a_skipped_row_writes_only_its_loop_event(self) -> None:
        _, events, _ = self._intake([_intake_row(_BUDGET_LABEL)])
        self.assertEqual(
            {env.get("op") for env in events}, {"write_autoagent_loop_event"}
        )

    # eval_result is varchar(32) — the skip token must fit its column.
    def test_the_skip_token_fits_the_eval_result_column(self) -> None:
        _, events, _ = self._intake([_intake_row(_BUDGET_LABEL)])
        self.assertLessEqual(
            len(events[0]["args"]["eval_result"]), dc.EVAL_RESULT_MAX_LEN
        )

    # The cap machinery this skip sits beside is untouched.
    def test_the_repeat_apply_cap_constants_are_unchanged(self) -> None:
        self.assertEqual(dc.APPLY_CAP_THRESHOLD, 3)
        self.assertIn("repeat-apply cap:", dc.APPLY_CAP_REASON_TEMPLATE)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestKeylessRowNeverReachesGeneration(unittest.TestCase):
    """run_cycle hands the generation loop — home of the re-check — keyed rows only."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "logs").mkdir()
        agents_dir = self.root / "agents"
        agents_dir.mkdir()
        (agents_dir / f"{_AGENT}.md").write_text("probe", encoding="utf-8")
        env = mock.patch.dict(os.environ, {"GA_DATA_ROOT": str(self.root)})
        env.start()
        self.addCleanup(env.stop)
        self.pg_reach = seal_pg_reach(self)

    def test_only_the_keyed_row_reaches_the_generation_loop(self) -> None:
        rows = [
            _intake_row(_BUDGET_LABEL, row_id=940001, metric_key="budget_overage"),
            _intake_row(dc.PATTERN1_SOFT_LABEL_EN, row_id=940002),
        ]
        handed: list[int] = []

        def run_generation(_report, agent_groups, *_args, **_kwargs) -> None:
            handed.extend(p.row_id for _, group in agent_groups for p in group)

        # After the seal: each replaces one seam the seal already covers.
        for name, value in (
            ("HAS_PG_PATTERN_READ", True),
            ("_pg_read_pending_patterns", lambda: list(rows)),
            ("_pg_read_spawn_facts", lambda _agents, _windows: (None, {})),
            ("_invoke_pg_helper", lambda _envelope: True),
            ("IS_GENERATION_CLOSED", False),
            ("_run_generation_loop", run_generation),
        ):
            patcher = mock.patch.object(dc, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

        with contextlib.redirect_stderr(io.StringIO()):
            dc.run_cycle(
                log_path=self.root / "learning-log.md",
                outcomes_dir=self.root,
                agents_dir=self.root / "agents",
                skip_haiku=True,
                skip_pre_verify=True,
                skip_loop_emit=True,
            )

        self.assertEqual(self.pg_reach, [])
        self.assertEqual(handed, [940001])


if __name__ == "__main__":
    unittest.main()
