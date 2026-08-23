"""Contract tests for the non-promptable intake exclusion (R2).

``read_user_pending_patterns`` in ``autoagent/daemon_cycle.py`` drops intake
rows whose pattern_signature head is a ``NON_PROMPTABLE_LABELS`` family — a
budget-overage cluster or a pattern-1 repeated-failure cluster (English label
plus the legacy Korean literal still present in ``core.learning_log``). Those
signals are operational counters, so a generated patch can only re-park; the
drop happens before proposal generation and stays loud (stderr WARN +
``eval_result='non-promptable'`` loop event), never silent.

Protected invariants:
(1) each excluded family is skipped and produces exactly one named row;
(2) every other label — pattern-5 and the pattern-1 SOFT display label — is
    admitted unchanged;
(3) the skip path emits no write beyond the loop event, so terminal
    ``core.learning_log`` rows keep their status and last_transition_reason;
(4) the exclusion set is declared once and tested at one site.

Stub reader + recorded loop events — no PG is touched. Mirrors
``test_pg_pattern_intake.py`` conventions (unittest, ``sys.path`` insertion).
Run with either runner:
    uv run --with pytest pytest autoagent/test/test_nonpromptable_intake_exclusion.py -v
    python3 -m unittest autoagent.test.test_nonpromptable_intake_exclusion -v
"""

from __future__ import annotations

import contextlib
import io
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

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
_SOURCE = (_AUTOAGENT_DIR / "daemon_cycle.py").read_text(encoding="utf-8")


def _intake_row(label: str, row_id: int = 910001, agent: str = _AGENT) -> dict:
    """One reader-shaped intake row (read_pending_learning_patterns contract)."""
    return {
        "id": row_id,
        "agent": agent,
        "pattern_signature": f"{label}|{agent}",
        "frequency": 4,
        "status": "identified",
        "discovered_date": date(2026, 8, 1),
    }


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestNonPromptableIntakeExclusion(unittest.TestCase):
    def _intake(self, rows: list[dict]) -> tuple[list, list, str]:
        events: list[dict] = []
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
                    agents_dir / "unused-log.md", 10, agents_dir=agents_dir
                )
        return patterns, events, stderr.getvalue()

    def _assert_excluded(self, label: str) -> None:
        patterns, events, stderr_text = self._intake([_intake_row(label)])
        self.assertEqual(patterns, [], f"{label!r} reached proposal generation")
        self.assertIn("WARN: pattern non-promptable", stderr_text)
        self.assertIn(_AGENT, stderr_text)
        self.assertIn(label, stderr_text)
        self.assertIn(dc.NON_PROMPTABLE_REASON.split(":")[0], stderr_text)
        skips = [
            env["args"]
            for env in events
            if env.get("op") == "write_autoagent_loop_event"
            and env.get("args", {}).get("eval_result") == "non-promptable"
        ]
        self.assertEqual(len(skips), 1, f"expected one named row, got {events}")
        self.assertEqual(skips[0]["agent"], _AGENT)
        self.assertEqual(skips[0]["changes_added"], 0)
        self.assertEqual(skips[0]["changes_removed"], 0)

    # AC2.1 — each excluded family is skipped with one named row.
    def test_when_budget_overage_label_then_skipped_with_named_row(self) -> None:
        self._assert_excluded("budget-overage concentration")

    def test_when_repeated_failure_label_then_skipped_with_named_row(self) -> None:
        self._assert_excluded(dc.PATTERN1_FAIL_LABEL_EN)

    def test_when_legacy_korean_label_then_skipped_with_named_row(self) -> None:
        self._assert_excluded(dc.PATTERN1_FAIL_LABEL_KO)

    # AC2.2 — every other label is admitted unchanged.
    def test_when_other_label_then_admitted_unchanged(self) -> None:
        admitted = [
            "agent instruction-improvement candidate (failure rate 75%)",
            dc.PATTERN1_SOFT_LABEL_EN,
            "size-est under-estimate concentration (avg overrun +6 tool_uses)",
        ]
        rows = [
            _intake_row(label, row_id=920000 + i) for i, label in enumerate(admitted)
        ]
        patterns, events, stderr_text = self._intake(rows)
        self.assertEqual([p.label for p in patterns], admitted)
        self.assertTrue(all(p.agent == _AGENT for p in patterns))
        self.assertNotIn("non-promptable", stderr_text)
        self.assertEqual(events, [])

    # AC2.2 — a mixed batch excludes only the non-promptable rows.
    def test_when_mixed_batch_then_only_excluded_rows_dropped(self) -> None:
        rows = [
            _intake_row("budget-overage concentration", row_id=930001),
            _intake_row(dc.PATTERN1_SOFT_LABEL_EN, row_id=930002),
            _intake_row(dc.PATTERN1_FAIL_LABEL_KO, row_id=930003),
        ]
        patterns, events, _ = self._intake(rows)
        self.assertEqual([p.label for p in patterns], [dc.PATTERN1_SOFT_LABEL_EN])
        self.assertEqual(len(events), 2)

    # AC2.3 — the skip path writes nothing but the loop event, so terminal
    # core.learning_log rows keep their status and last_transition_reason.
    def test_when_row_excluded_then_only_loop_event_is_written(self) -> None:
        _, events, _ = self._intake([_intake_row("budget-overage concentration")])
        self.assertEqual(
            {env.get("op") for env in events}, {"write_autoagent_loop_event"}
        )

    # eval_result is varchar(32) — the label must fit its column.
    def test_when_row_excluded_then_eval_result_fits_column(self) -> None:
        _, events, _ = self._intake([_intake_row("budget-overage concentration")])
        self.assertLessEqual(
            len(events[0]["args"]["eval_result"]), dc.EVAL_RESULT_MAX_LEN
        )

    # AC2.5 — one declaration, one membership site.
    def test_when_exclusion_set_read_then_declared_once(self) -> None:
        self.assertEqual(
            dc.NON_PROMPTABLE_LABELS,
            frozenset(
                {
                    "budget-overage concentration",
                    dc.PATTERN1_FAIL_LABEL_EN,
                    dc.PATTERN1_FAIL_LABEL_KO,
                }
            ),
        )
        self.assertEqual(_SOURCE.count('"budget-overage concentration"'), 1)
        self.assertEqual(_SOURCE.count("in NON_PROMPTABLE_LABELS"), 1)

    # AC2.4 — the cap machinery this exclusion sits beside is untouched.
    def test_when_cap_constants_read_then_unchanged(self) -> None:
        self.assertEqual(dc.APPLY_CAP_THRESHOLD, 3)
        self.assertIn("repeat-apply cap:", dc.APPLY_CAP_REASON_TEMPLATE)


if __name__ == "__main__":
    unittest.main()
