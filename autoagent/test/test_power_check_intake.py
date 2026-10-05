"""Power check at intake: each floor-passing keyed pattern against the S2e bound (N69).

Projected units = the agent's spawns per day over the last 28 provenance-covered days
× the 84-day horizon; the bound = 2 × the S2e per-arm maximum at the floor-half baseline
rate, design effect 1. The verdict is counted on the cycle report and sent as a loop
event; no status is written (N50). Every row is database-free under ``seal_pg_reach``.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_power_check_intake.py -v
    python3 -m unittest autoagent.test.test_power_check_intake -v
"""

from __future__ import annotations

import contextlib
import io
import itertools
import math
import os
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_TEST_DIR = Path(__file__).resolve().parent

for _anchor in (
    _REPO_ROOT / "hooks",
    _REPO_ROOT / "autoagent",
    _REPO_ROOT / "autoagent" / "lib",
    _TEST_DIR,
):
    if str(_anchor) not in sys.path:
        sys.path.insert(0, str(_anchor))

import daemon_cycle as dc
import trial_design
from _outcome_signal import (
    FloorResult,
    SpawnFacts,
    WindowCount,
    get_pair_windows,
    is_floor_half,
)
from _pg_seal import seal_pg_reach

_NOW = datetime(2026, 10, 5, 6, 0, tzinfo=timezone.utc)
_WINDOWS = get_pair_windows(_NOW)
_DAY = _WINDOWS.end  # D, the most recent UTC midnight
_BUDGET_KEY = "budget_overage"
_PASSING_AGENT = "glass-atrium-dev-python"
_UNDERPOWERED_AGENT = "glass-atrium-dev-shell"
_FLOOR_FAILING_AGENT = "glass-atrium-dev-node"

# floor-half baseline 20 events / 200 spawns → rate 0.1
_BASELINE = WindowCount(spawns=200, events=20, sessions=20)
_BASELINE_RATE = _BASELINE.events / _BASELINE.spawns
# the bound read from the S2e reference module, never from the code under test
_REQUIRED_UNITS = trial_design.get_required_units(
    trial_design.get_maximum_sample_size(_BASELINE_RATE)
)
# 28-day spawn counts whose 84-day projection sits just at-or-above / just below the bound
_UNITS_AT_BOUND = math.ceil(_REQUIRED_UNITS * 28 / 84)
_UNITS_BELOW_BOUND = _UNITS_AT_BOUND - 1
# baseline 21/50 → bound 366 = exactly 122 × 84 / 28, where (122 / 28) × 84 rounds below 366
_EXACT_BOUND_BASELINE = WindowCount(spawns=50, events=21, sessions=21)
_UNITS_AT_EXACT_BOUND = 122


def _get_agent_ids(*, is_floor: bool):
    """Fresh spawn agent ids from one sha256 half."""
    return (
        agent_id
        for agent_id in (f"a{index:07x}" for index in itertools.count())
        if is_floor_half(agent_id) is is_floor
    )


_FLOOR_IDS = _get_agent_ids(is_floor=True)
_REFERENCE_IDS = _get_agent_ids(is_floor=False)


def _spawn(
    started_at: datetime, *, is_event: bool = False, agent_id: str | None = ""
) -> SpawnFacts:
    if agent_id == "":
        agent_id = next(_REFERENCE_IDS)
    session_id = None if agent_id is None else f"session-{agent_id}"
    return SpawnFacts(agent_id, session_id, started_at, int(is_event), True, ())


def _get_units(count: int) -> list[SpawnFacts]:
    """`count` non-event spawns spread over [D - 28 d, D)."""
    return [
        _spawn(_DAY - timedelta(days=28) + timedelta(minutes=index))
        for index in range(count)
    ]


def _floor(verdict: str = "pass", baseline: WindowCount = _BASELINE) -> FloorResult:
    window = WindowCount(spawns=6, events=6, sessions=6)
    return FloorResult(verdict, window, window, baseline, 0, 0)


def _get_floor_passing_history(units: int) -> list[SpawnFacts]:
    """A history whose budget_overage pair passes at baseline rate 0.1, with `units` spawns
    in the last 28 days: floor-half baseline before that window, six event sessions in
    detection and in confirmation, reference-half filler for the rest."""
    baseline_start = _DAY - timedelta(days=40)
    baseline = [
        _spawn(
            baseline_start + timedelta(hours=index),
            is_event=index < _BASELINE.events,
            agent_id=next(_FLOOR_IDS),
        )
        for index in range(_BASELINE.spawns)
    ]
    events = [
        _spawn(window_start + timedelta(hours=index), is_event=True)
        for window_start in (_WINDOWS.start.detection, _WINDOWS.start.confirmation)
        for index in range(6)
    ]
    return baseline + events + _get_units(units - len(events))


def _get_floor_failing_history() -> list[SpawnFacts]:
    """The passing history minus two confirmation event sessions → the pair fails."""
    history = _get_floor_passing_history(_UNITS_AT_BOUND)
    confirmation = [s for s in history if s.started_at >= _WINDOWS.start.confirmation]
    return [s for s in history if s not in confirmation[:2]]


class GetPowerCheckTest(unittest.TestCase):
    """The verdict is the N69 bound over the last 28 provenance-covered days."""

    def test_the_verdict_follows_the_bound_and_the_covered_history(self) -> None:
        provenance_covering = _DAY - timedelta(days=60)
        rows = [
            (
                "at or above the bound → passing",
                _floor(),
                _get_units(_UNITS_AT_BOUND),
                provenance_covering,
                dc.POWER.VERDICT.PASSING,
            ),
            (
                "just below the bound → underpowered",
                _floor(),
                _get_units(_UNITS_BELOW_BOUND),
                provenance_covering,
                dc.POWER.VERDICT.UNDERPOWERED,
            ),
            (
                "a projection exactly equal to the bound → passing",
                _floor(baseline=_EXACT_BOUND_BASELINE),
                _get_units(_UNITS_AT_EXACT_BOUND),
                provenance_covering,
                dc.POWER.VERDICT.PASSING,
            ),
            (
                "a spawn before the window or with no agent id adds no unit",
                _floor(),
                [
                    *_get_units(_UNITS_BELOW_BOUND),
                    _spawn(_DAY - timedelta(days=29)),
                    _spawn(_DAY - timedelta(days=1), agent_id=None),
                ],
                provenance_covering,
                dc.POWER.VERDICT.UNDERPOWERED,
            ),
            (
                "exactly 28 covered days → judged on the bound",
                _floor(),
                _get_units(_UNITS_AT_BOUND),
                _DAY - timedelta(days=28),
                dc.POWER.VERDICT.PASSING,
            ),
            (
                "27 covered days → insufficient-history at any volume",
                _floor(),
                _get_units(2 * _UNITS_AT_BOUND),
                _DAY - timedelta(days=27),
                dc.POWER.VERDICT.INSUFFICIENT_HISTORY,
            ),
            (
                "no provenance start → insufficient-history",
                _floor(),
                _get_units(2 * _UNITS_AT_BOUND),
                None,
                dc.POWER.VERDICT.INSUFFICIENT_HISTORY,
            ),
            (
                "a zero baseline rate has no finite size → underpowered at any volume",
                _floor(baseline=WindowCount(spawns=200, events=0, sessions=0)),
                _get_units(10 * _UNITS_AT_BOUND),
                provenance_covering,
                dc.POWER.VERDICT.UNDERPOWERED,
            ),
        ]
        for name, floor, spawns, provenance_start, verdict in rows:
            with self.subTest(name):
                check = dc.get_power_check(floor, spawns, provenance_start, _WINDOWS)
                self.assertEqual(check.verdict, verdict)

    def test_the_projection_is_the_daily_28_day_rate_over_the_84_day_horizon(
        self,
    ) -> None:
        check = dc.get_power_check(
            _floor(), _get_units(_UNITS_AT_BOUND), _DAY - timedelta(days=60), _WINDOWS
        )
        self.assertAlmostEqual(check.projected_units, _UNITS_AT_BOUND / 28 * 84)
        self.assertEqual(check.required_units, _REQUIRED_UNITS)


class _StageFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.pg_reach = seal_pg_reach(self)
        self.history_reads: list[list[str]] = []
        self.histories: dict[str, list[SpawnFacts]] = {}
        self.provenance_start: datetime | None = _DAY - timedelta(days=60)
        self.events: list[dict] = []

        def _read_spawn_facts(agents, windows):
            self.assertEqual(windows, _WINDOWS)
            self.history_reads.append(list(agents))
            return self.provenance_start, {
                agent: self.histories.get(agent, []) for agent in agents
            }

        # After the seal: the spawn read and the loop-event helper are the database boundary.
        for name, value in (
            ("HAS_PG_PATTERN_READ", True),
            ("_pg_read_spawn_facts", _read_spawn_facts),
            ("_invoke_pg_helper", self._record_event),
            ("_get_utc_now", lambda: _NOW),
        ):
            patcher = mock.patch.object(dc, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _record_event(self, envelope: dict) -> bool:
        self.events.append(envelope["args"])
        return True

    def _get_event_results(self) -> list[tuple[str, str]]:
        return sorted((event["agent"], event["eval_result"]) for event in self.events)


def _pattern(
    agent: str, row_id: int, metric_key: str | None = _BUDGET_KEY
) -> dc.Pattern:
    label = "budget-overage concentration"
    return dc.Pattern(
        date="2026-08-01",
        label=label,
        frequency="4",
        agent=agent,
        status="identified",
        tier="user-pending",
        raw_line=f"{label}|{agent}",
        row_id=row_id,
        metric_key=metric_key,
    )


class CheckPatternPowerTest(_StageFixture):
    """Floor-passing keyed patterns are checked and counted; nothing else is."""

    def setUp(self) -> None:
        super().setUp()
        self.histories = {
            _PASSING_AGENT: _get_floor_passing_history(_UNITS_AT_BOUND),
            _UNDERPOWERED_AGENT: _get_floor_passing_history(_UNITS_BELOW_BOUND),
            _FLOOR_FAILING_AGENT: _get_floor_failing_history(),
        }
        self.patterns = [
            _pattern(_PASSING_AGENT, 1),
            _pattern(_UNDERPOWERED_AGENT, 2),
            _pattern(_FLOOR_FAILING_AGENT, 3),
        ]

    def _check(self, patterns: list[dc.Pattern], *, skip_loop_emit: bool = False):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            counts = dc.check_pattern_power(patterns, skip_loop_emit=skip_loop_emit)
        self.assertEqual(self.pg_reach, [])
        return counts, stderr.getvalue()

    def test_each_floor_passing_pattern_is_counted_under_its_verdict(self) -> None:
        counts, stderr_text = self._check(self.patterns)
        self.assertEqual(
            counts,
            {
                "passing": 1,
                "underpowered": 1,
                "insufficient-history": 0,
                "unchecked": 0,
            },
        )
        self.assertIn(f"agent={_PASSING_AGENT} key={_BUDGET_KEY}: passing", stderr_text)
        self.assertNotIn(_FLOOR_FAILING_AGENT, stderr_text)

    def test_each_verdict_is_sent_as_a_census_loop_event(self) -> None:
        self._check(self.patterns)
        self.assertEqual(
            self._get_event_results(),
            sorted(
                [
                    (_PASSING_AGENT, "power-check-passing"),
                    (_UNDERPOWERED_AGENT, "power-check-underpowered"),
                ]
            ),
        )
        self.assertTrue(all(event["subject"] is None for event in self.events))

    def test_every_verdict_token_fits_the_eval_result_column(self) -> None:
        for verdict in vars(dc.POWER.VERDICT).values():
            self.assertLessEqual(len(dc.POWER.CHECK_EVAL_PREFIX + verdict), 32, verdict)

    def test_one_spawn_read_serves_every_agent(self) -> None:
        self._check(self.patterns)
        self.assertEqual(
            self.history_reads,
            [sorted([_PASSING_AGENT, _UNDERPOWERED_AGENT, _FLOOR_FAILING_AGENT])],
        )

    def test_a_keyless_or_empty_intake_reads_nothing(self) -> None:
        for name, patterns in (
            ("empty", []),
            ("keyless", [_pattern(_PASSING_AGENT, 1, None)]),
        ):
            with self.subTest(name):
                counts, _ = self._check(patterns)
                self.assertEqual(sum(counts.values()), 0)
                self.assertEqual(self.history_reads, [])

    def test_an_unreadable_history_counts_every_keyed_pattern_unchecked_and_never_passing(
        self,
    ) -> None:
        def _fail(agents, windows):
            raise ConnectionError("PG unreachable")

        for name, patches in (
            ("read raises", {"_pg_read_spawn_facts": _fail}),
            ("reads unavailable", {"HAS_PG_PATTERN_READ": False}),
        ):
            with self.subTest(name), mock.patch.multiple(dc, **patches):
                counts, stderr_text = self._check(self.patterns)
                self.assertEqual(counts["unchecked"], 3)
                self.assertEqual(counts["passing"], 0)
                self.assertIn("WARN: power check", stderr_text)

    def test_a_no_write_cycle_counts_but_sends_no_loop_event(self) -> None:
        counts, _ = self._check(self.patterns, skip_loop_emit=True)
        self.assertEqual(counts["passing"], 1)
        self.assertEqual(self.events, [])


class PowerCheckCycleReportTest(_StageFixture):
    """run_cycle stores the counter on the report and in its JSON on the closed branch."""

    def setUp(self) -> None:
        super().setUp()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        agents_dir = self.root / "agents"
        agents_dir.mkdir()
        for agent in (_PASSING_AGENT, _UNDERPOWERED_AGENT):
            (agents_dir / f"{agent}.md").write_text("probe", encoding="utf-8")
        env = mock.patch.dict(
            os.environ,
            {
                "GA_DATA_ROOT": str(self.root),
                "AUTOAGENT_REPORTS_DIR": str(self.root / "reports"),
            },
        )
        env.start()
        self.addCleanup(env.stop)
        self.histories = {
            _PASSING_AGENT: _get_floor_passing_history(_UNITS_AT_BOUND),
            _UNDERPOWERED_AGENT: _get_floor_passing_history(_UNITS_BELOW_BOUND),
        }
        rows = [
            {
                "id": row_id,
                "agent": agent,
                "pattern_signature": f"budget-overage concentration|{agent}",
                "frequency": 4,
                "status": "identified",
                "discovered_date": date(2026, 8, 1),
                "metric_key": _BUDGET_KEY,
            }
            for row_id, agent in ((1, _PASSING_AGENT), (2, _UNDERPOWERED_AGENT))
        ]
        patcher = mock.patch.object(dc, "_pg_read_pending_patterns", lambda: list(rows))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_report_counter_equals_the_passing_count(self) -> None:
        self.assertTrue(dc.IS_GENERATION_CLOSED)
        with contextlib.redirect_stderr(io.StringIO()):
            report = dc.run_cycle(
                log_path=self.root / "learning-log.md",
                outcomes_dir=self.root,
                agents_dir=self.root / "agents",
                skip_haiku=True,
                skip_pre_verify=True,
                skip_loop_emit=True,
            )
        self.assertEqual(self.pg_reach, [])
        self.assertEqual(report.power_check["passing"], 1)
        self.assertEqual(dc._report_to_dict(report)["power_check"], report.power_check)


if __name__ == "__main__":
    unittest.main()
