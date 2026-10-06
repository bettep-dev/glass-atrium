"""Power check at intake: each floor-passing keyed pattern against the trial_design bound.

Projected units = the agent's spawns per day over the last 28 provenance-covered days
× the 84-day horizon; the bound = 2 × the trial_design per-arm maximum at the floor-half
baseline rate × the agent's latest A/A design effect; no A/A row → design-unmeasured, never
passing. The verdict is counted on the cycle report and sent as a loop event; no status is
written and no pattern is parked or dropped. Every row is database-free under
``seal_pg_reach``, except the ledger-read live class, which runs only under
``autoagent/test/live-pg-ephemeral.bats`` and skips elsewhere.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_power_check_intake.py -v
    python3 -m unittest autoagent.test.test_power_check_intake -v
"""

from __future__ import annotations

import contextlib
import io
import itertools
import json
import math
import os
import sys
import tempfile
import unittest
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_TEST_DIR = Path(__file__).resolve().parent

for _anchor in (
    _REPO_ROOT / "hooks",
    _REPO_ROOT / "autoagent",
    _REPO_ROOT / "autoagent" / "lib",
    _REPO_ROOT / "scripts" / "test",
    _TEST_DIR,
):
    if str(_anchor) not in sys.path:
        sys.path.insert(0, str(_anchor))

import _pg_stub_backend as stub
import daemon_cycle as dc
import trial_design
from _outcome_signal import (
    FloorResult,
    SpawnFacts,
    WindowCount,
    get_pair_windows,
    is_floor_half,
)
from _pg_seal import get_ephemeral_connection, seal_pg_reach

_NOW = datetime(2026, 10, 5, 6, 0, tzinfo=timezone.utc)
_WINDOWS = get_pair_windows(_NOW)
_DAY = _WINDOWS.end  # D, the most recent UTC midnight
_KEY = SimpleNamespace(BUDGET="budget_overage", EMIT="emit_failure")
_AGENT = SimpleNamespace(
    PASSING="glass-atrium-dev-python",
    UNDERPOWERED="glass-atrium-dev-shell",
    FLOOR_FAILING="glass-atrium-dev-node",
)

# floor-half baseline 20 events / 200 spawns → rate 0.1
_BASELINE = WindowCount(spawns=200, events=20, sessions=20)
_BASELINE_RATE = _BASELINE.events / _BASELINE.spawns
# the measured A/A arm-difference design effect the bound rows are judged at
_DESIGN_EFFECT = 1.5
# the bound read from the trial_design reference module, never from the code under test
_REQUIRED_UNITS = trial_design.get_required_units(
    trial_design.get_maximum_sample_size(_BASELINE_RATE), design_effect=_DESIGN_EFFECT
)
# baseline 21/50 at design effect 1 → bound 366 = exactly 122 × 84 / 28
# (122 / 28) × 84 rounds below 366 in floating point
_EXACT_BOUND_BASELINE = WindowCount(spawns=50, events=21, sessions=21)
# 28-day spawn counts: 84-day projection just at-or-above / just below the bound; 122 at 21/50
_UNITS = SimpleNamespace(
    AT_BOUND=math.ceil(_REQUIRED_UNITS * 28 / 84),
    AT_EXACT_BOUND=122,
)
_UNITS.BELOW_BOUND = _UNITS.AT_BOUND - 1


def _get_agent_ids(*, is_floor: bool):
    """Fresh spawn agent ids from one sha256 half."""
    return (
        agent_id
        for agent_id in (f"a{index:07x}" for index in itertools.count())
        if is_floor_half(agent_id) is is_floor
    )


_IDS = SimpleNamespace(
    FLOOR=_get_agent_ids(is_floor=True),
    REFERENCE=_get_agent_ids(is_floor=False),
)


def _spawn(
    started_at: datetime, *, is_event: bool = False, agent_id: str | None = ""
) -> SpawnFacts:
    if agent_id == "":
        agent_id = next(_IDS.REFERENCE)
    session_id = None if agent_id is None else f"session-{agent_id}"
    return SpawnFacts(agent_id, session_id, started_at, int(is_event), True, ())


def _get_units(count: int) -> list[SpawnFacts]:
    """`count` non-event spawns spread over [D - 28 d, D)."""
    return [
        _spawn(_DAY - timedelta(days=28) + timedelta(minutes=index))
        for index in range(count)
    ]


def _build_design_effect_payload(
    value: float = _DESIGN_EFFECT, metric_key: str = _KEY.BUDGET
) -> dict:
    """An A/A arm-difference design-effect row payload, in the writer's declared shape."""
    reading = trial_design.ArmDesignEffect(value, 20, 200, value - 0.2, value + 0.3, 2000)
    return {"metric_key": metric_key, **reading._asdict()}


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
            agent_id=next(_IDS.FLOOR),
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
    history = _get_floor_passing_history(_UNITS.AT_BOUND)
    confirmation = [s for s in history if s.started_at >= _WINDOWS.start.confirmation]
    return [s for s in history if s not in confirmation[:2]]


class GetPowerCheckTest(unittest.TestCase):
    """The verdict is the power bound over the last 28 provenance-covered days."""

    def test_the_verdict_follows_the_bound_and_the_covered_history(self) -> None:
        provenance_covering = _DAY - timedelta(days=60)
        rows = [
            (
                "at or above the bound → passing",
                _floor(),
                _get_units(_UNITS.AT_BOUND),
                provenance_covering,
                _DESIGN_EFFECT,
                dc.POWER.VERDICT.PASSING,
            ),
            (
                "just below the bound → underpowered",
                _floor(),
                _get_units(_UNITS.BELOW_BOUND),
                provenance_covering,
                _DESIGN_EFFECT,
                dc.POWER.VERDICT.UNDERPOWERED,
            ),
            (
                "a higher design effect raises the bound → underpowered at the same volume",
                _floor(),
                _get_units(_UNITS.AT_BOUND),
                provenance_covering,
                _DESIGN_EFFECT * 1.2,
                dc.POWER.VERDICT.UNDERPOWERED,
            ),
            (
                "a projection exactly equal to the bound → passing",
                _floor(baseline=_EXACT_BOUND_BASELINE),
                _get_units(_UNITS.AT_EXACT_BOUND),
                provenance_covering,
                1.0,
                dc.POWER.VERDICT.PASSING,
            ),
            (
                "a spawn before the window or with no agent id adds no unit",
                _floor(),
                [
                    *_get_units(_UNITS.BELOW_BOUND),
                    _spawn(_DAY - timedelta(days=29)),
                    _spawn(_DAY - timedelta(days=1), agent_id=None),
                ],
                provenance_covering,
                _DESIGN_EFFECT,
                dc.POWER.VERDICT.UNDERPOWERED,
            ),
            (
                "exactly 28 covered days → judged on the bound",
                _floor(),
                _get_units(_UNITS.AT_BOUND),
                _DAY - timedelta(days=28),
                _DESIGN_EFFECT,
                dc.POWER.VERDICT.PASSING,
            ),
            (
                "27 covered days → insufficient-history at any volume",
                _floor(),
                _get_units(2 * _UNITS.AT_BOUND),
                _DAY - timedelta(days=27),
                _DESIGN_EFFECT,
                dc.POWER.VERDICT.INSUFFICIENT_HISTORY,
            ),
            (
                "no provenance start → insufficient-history",
                _floor(),
                _get_units(2 * _UNITS.AT_BOUND),
                None,
                _DESIGN_EFFECT,
                dc.POWER.VERDICT.INSUFFICIENT_HISTORY,
            ),
            (
                "no measured design effect → design-unmeasured at any volume",
                _floor(),
                _get_units(10 * _UNITS.AT_BOUND),
                provenance_covering,
                None,
                dc.POWER.VERDICT.DESIGN_UNMEASURED,
            ),
            (
                "too short a history is judged before an unmeasured design effect",
                _floor(),
                _get_units(10 * _UNITS.AT_BOUND),
                _DAY - timedelta(days=27),
                None,
                dc.POWER.VERDICT.INSUFFICIENT_HISTORY,
            ),
            (
                "a zero baseline rate has no finite size → underpowered at any volume",
                _floor(baseline=WindowCount(spawns=200, events=0, sessions=0)),
                _get_units(10 * _UNITS.AT_BOUND),
                provenance_covering,
                _DESIGN_EFFECT,
                dc.POWER.VERDICT.UNDERPOWERED,
            ),
        ]
        for name, floor, spawns, provenance_start, design_effect, verdict in rows:
            with self.subTest(name):
                check = dc.get_power_check(
                    floor,
                    spawns,
                    provenance_start,
                    _WINDOWS,
                    design_effect=design_effect,
                )
                self.assertEqual(check.verdict, verdict)

    def test_the_projection_is_the_daily_28_day_rate_over_the_84_day_horizon(
        self,
    ) -> None:
        check = dc.get_power_check(
            _floor(),
            _get_units(_UNITS.AT_BOUND),
            _DAY - timedelta(days=60),
            _WINDOWS,
            design_effect=_DESIGN_EFFECT,
        )
        self.assertAlmostEqual(check.units.projected, _UNITS.AT_BOUND / 28 * 84)
        self.assertEqual(check.units.required, _REQUIRED_UNITS)


class _LedgerConnection:
    """The trial-ledger read boundary: each requested agent's latest A/A row per metric key, as stored.

    Every statement recorded as seen · one the test answers empty on purpose → no rows ·
    any other but the design-effect read → recorded as refused + raised, never absorbed.
    """

    def __init__(
        self,
        latest_payloads: dict[tuple[str, str], dict],
        reads: list[list[str]],
        statements: SimpleNamespace,
    ) -> None:
        self.latest_payloads = latest_payloads
        self.reads = reads
        self.statements = statements
        self.rows: list[tuple[str, dict]] = []

    def cursor(self) -> contextlib.nullcontext[_LedgerConnection]:
        return contextlib.nullcontext(self)

    def execute(self, statement: str, params: tuple[object, ...]) -> None:
        self.statements.seen.append(statement)
        if statement in self.statements.answered_empty:
            self.rows = []
            return
        if statement != dc.POWER.DESIGN_EFFECT_SQL:
            self.statements.refused.append(statement)
            raise AssertionError(f"statement outside the ledger fake: {statement[:80]}")
        event, agents = params
        self.reads.append(list(agents))
        is_design_effect = event == stub.get_trial_ledger().EVENT.AA_ARM_DESIGN_EFFECT
        self.rows = [
            (agent, payload)
            for (agent, _), payload in sorted(self.latest_payloads.items())
            if is_design_effect and agent in agents
        ]

    def fetchall(self) -> list[tuple[str, dict]]:
        return self.rows


class _StageFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.pg_reach = seal_pg_reach(self)
        self.reads = SimpleNamespace(history=[], design_effect=[])
        self.statements = SimpleNamespace(
            seen=[], refused=[], answered_empty=frozenset()
        )
        self.histories: dict[str, list[SpawnFacts]] = {}
        self.provenance_start: datetime | None = _DAY - timedelta(days=60)
        self.events: list[dict] = []
        self.design_effects = {
            (agent, key): _build_design_effect_payload(metric_key=key)
            for agent in vars(_AGENT).values()
            for key in (_KEY.BUDGET, _KEY.EMIT)
        }

        def _read_spawn_facts(agents, windows):
            self.assertEqual(windows, _WINDOWS)
            self.reads.history.append(list(agents))
            return self.provenance_start, {
                agent: self.histories.get(agent, []) for agent in agents
            }

        # after the seal: spawn read, ledger connection, loop-event helper = the DB boundary
        for name, value in (
            ("HAS_PG_PATTERN_READ", True),
            ("_pg_read_spawn_facts", _read_spawn_facts),
            ("HAS_PG_LOOP_WRITE", True),
            ("_pg_connect", self._connect_ledger),
            ("_invoke_pg_helper", self._record_event),
            ("_get_utc_now", lambda: _NOW),
        ):
            patcher = mock.patch.object(dc, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        # a psycopg-free leg binds no helper names; the reader needs the declared event
        patcher = mock.patch.object(
            dc,
            "TRIAL_LEDGER",
            stub.get_trial_ledger(),
            create=not hasattr(dc, "TRIAL_LEDGER"),
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _connect_ledger(self) -> contextlib.nullcontext[_LedgerConnection]:
        return contextlib.nullcontext(
            _LedgerConnection(
                self.design_effects, self.reads.design_effect, self.statements
            )
        )

    def _record_event(self, envelope: dict) -> bool:
        self.events.append(envelope["args"])
        return True

    def _get_event_results(self) -> list[tuple[str, str]]:
        return sorted((event["agent"], event["eval_result"]) for event in self.events)


def _fail_pg_read(*args: object) -> None:
    raise ConnectionError("PG unreachable")


def _pattern(
    agent: str, row_id: int, metric_key: str | None = _KEY.BUDGET
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
            _AGENT.PASSING: _get_floor_passing_history(_UNITS.AT_BOUND),
            _AGENT.UNDERPOWERED: _get_floor_passing_history(_UNITS.BELOW_BOUND),
            _AGENT.FLOOR_FAILING: _get_floor_failing_history(),
        }
        self.patterns = [
            _pattern(_AGENT.PASSING, 1),
            _pattern(_AGENT.UNDERPOWERED, 2),
            _pattern(_AGENT.FLOOR_FAILING, 3),
        ]

    def _check(self, patterns: list[dc.Pattern], *, skip_loop_emit: bool = False):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            counts = dc.check_pattern_power(
                patterns, skip_loop_emit=skip_loop_emit
            ).counts
        self.assertEqual(self.pg_reach, [])
        self.assertEqual(self.statements.refused, [])
        return counts, stderr.getvalue()

    def test_each_floor_passing_pattern_is_counted_under_its_verdict(self) -> None:
        counts, stderr_text = self._check(self.patterns)
        self.assertEqual(
            counts,
            {
                "passing": 1,
                "underpowered": 1,
                "insufficient-history": 0,
                "design-unmeasured": 0,
                "unchecked": 0,
            },
        )
        self.assertIn(f"agent={_AGENT.PASSING} key={_KEY.BUDGET}: passing", stderr_text)
        self.assertNotIn(_AGENT.FLOOR_FAILING, stderr_text)

    def test_an_agent_with_no_aa_design_effect_row_is_counted_design_unmeasured_never_passing(
        self,
    ) -> None:
        # a row on the agent's other key does not measure this pattern's key
        del self.design_effects[(_AGENT.PASSING, _KEY.BUDGET)]
        counts, stderr_text = self._check(self.patterns)
        self.assertEqual(
            (counts["passing"], counts["design-unmeasured"], counts["underpowered"]),
            (0, 1, 1),
        )
        self.assertIn(
            f"agent={_AGENT.PASSING} key={_KEY.BUDGET}: design-unmeasured", stderr_text
        )
        self.assertIn(
            (_AGENT.PASSING, "power-check-design-unmeasured"), self._get_event_results()
        )

    def test_the_row_of_the_patterns_own_metric_key_sets_the_bound(self) -> None:
        raised = _DESIGN_EFFECT * 1.2
        rows = [
            ("both keys at the measured value", _DESIGN_EFFECT, _DESIGN_EFFECT, "passing"),
            ("the pattern's own key raised", raised, _DESIGN_EFFECT, "underpowered"),
            ("only the other key raised", _DESIGN_EFFECT, raised, "passing"),
        ]
        for name, own, other, verdict in rows:
            with self.subTest(name):
                self.design_effects[(_AGENT.PASSING, _KEY.BUDGET)] = (
                    _build_design_effect_payload(own, _KEY.BUDGET)
                )
                self.design_effects[(_AGENT.PASSING, _KEY.EMIT)] = (
                    _build_design_effect_payload(other, _KEY.EMIT)
                )
                counts, _ = self._check([_pattern(_AGENT.PASSING, 1)])
                self.assertEqual(counts[verdict], 1)

    def test_a_stored_value_below_one_reads_as_one_never_lower(self) -> None:
        # the at-bound history is sized for 1.5 → passing at 1, and identically at any value below 1
        rows = [("exactly one", 1.0), ("below one by noise", 0.82), ("far below one", 0.1)]
        for name, value in rows:
            with self.subTest(name):
                self.design_effects[(_AGENT.PASSING, _KEY.BUDGET)] = (
                    _build_design_effect_payload(value)
                )
                counts, stderr_text = self._check([_pattern(_AGENT.PASSING, 1)])
                self.assertEqual(counts["passing"], 1)
                self.assertIn("(design effect 1)", stderr_text)

    def test_an_invalid_stored_design_effect_counts_only_that_agents_patterns_unchecked(
        self,
    ) -> None:
        payload = _build_design_effect_payload()
        value_free = {key: item for key, item in payload.items() if key != "value"}
        rows = [
            ("a non-finite value", {**payload, "value": "NaN"}),
            ("a value too large for a float", {**payload, "value": 10**400}),
            ("the value missing", value_free),
            ("an undeclared key", {**payload, "period": 1.3}),
        ]
        for name, payload in rows:
            with self.subTest(name):
                self.design_effects[(_AGENT.PASSING, _KEY.BUDGET)] = payload
                counts, stderr_text = self._check(self.patterns)
                self.assertEqual(
                    (counts["unchecked"], counts["passing"], counts["underpowered"]),
                    (1, 0, 1),
                )
                self.assertIn(
                    f"WARN: power check — agent={_AGENT.PASSING}", stderr_text
                )

    def test_the_floor_is_judged_at_the_day_anchor_at_any_instant_of_the_day(
        self,
    ) -> None:
        # stopless overage spawn 1 h before D: pending at D, the fifth event session once settled
        late = _spawn(_DAY - timedelta(hours=1), is_event=True)._replace(
            has_subagent_stop=False
        )
        self.histories = {_AGENT.PASSING: [*_get_floor_failing_history(), late]}
        rows = [
            ("just after the anchor", _DAY + timedelta(minutes=5)),
            ("just before the next anchor", _DAY + timedelta(hours=23, minutes=55)),
        ]
        for name, instant in rows:
            with (
                self.subTest(name),
                mock.patch.object(dc, "_get_utc_now", lambda at=instant: at),
            ):
                counts, _ = self._check([_pattern(_AGENT.PASSING, 1)])
                self.assertEqual(sum(counts.values()), 0)

    def test_each_verdict_is_sent_as_a_census_loop_event(self) -> None:
        self._check(self.patterns)
        self.assertEqual(
            self._get_event_results(),
            sorted(
                [
                    (_AGENT.PASSING, "power-check-passing"),
                    (_AGENT.UNDERPOWERED, "power-check-underpowered"),
                ]
            ),
        )
        self.assertTrue(all(event["subject"] is None for event in self.events))

    def test_every_verdict_token_fits_the_eval_result_column(self) -> None:
        for verdict in vars(dc.POWER.VERDICT).values():
            self.assertLessEqual(len(dc.POWER.CHECK_EVAL_PREFIX + verdict), 32, verdict)

    def test_one_spawn_read_and_one_ledger_read_serve_every_agent(self) -> None:
        self._check(self.patterns)
        agents = sorted([_AGENT.PASSING, _AGENT.UNDERPOWERED, _AGENT.FLOOR_FAILING])
        self.assertEqual(
            (self.reads.history, self.reads.design_effect), ([agents], [agents])
        )

    def test_a_keyless_or_empty_intake_reads_nothing(self) -> None:
        for name, patterns in (
            ("empty", []),
            ("keyless", [_pattern(_AGENT.PASSING, 1, None)]),
        ):
            with self.subTest(name):
                counts, _ = self._check(patterns)
                self.assertEqual(sum(counts.values()), 0)
                self.assertEqual(self.reads.history, [])

    def test_an_unreadable_history_counts_every_keyed_pattern_unchecked_and_never_passing(
        self,
    ) -> None:
        for name, patches in (
            ("history read raises", {"_pg_read_spawn_facts": _fail_pg_read}),
            ("history reads unavailable", {"HAS_PG_PATTERN_READ": False}),
        ):
            with self.subTest(name), mock.patch.multiple(dc, **patches):
                counts, stderr_text = self._check(self.patterns)
                self.assertEqual(counts["unchecked"], 3)
                self.assertEqual(counts["passing"], 0)
                self.assertIn("WARN: power check", stderr_text)

    def test_an_unreadable_ledger_counts_only_the_floor_passing_patterns_unchecked(
        self,
    ) -> None:
        for name, patches in (
            ("ledger read raises", {"_pg_connect": _fail_pg_read}),
            ("ledger helper unavailable", {"HAS_PG_LOOP_WRITE": False}),
        ):
            with self.subTest(name), mock.patch.multiple(dc, **patches):
                counts, stderr_text = self._check(self.patterns)
                self.assertEqual((counts["unchecked"], sum(counts.values())), (2, 2))
                self.assertNotIn(_AGENT.FLOOR_FAILING, stderr_text)
                self.assertIn("WARN: power check", stderr_text)

    def test_a_no_write_cycle_counts_but_sends_no_loop_event(self) -> None:
        counts, _ = self._check(self.patterns, skip_loop_emit=True)
        self.assertEqual(counts["passing"], 1)
        self.assertEqual(self.events, [])


class DesignEffectReadLivePgTest(_StageFixture):
    """The ledger read's real SQL on the ephemeral cluster; skips anywhere else.

    Each test owns a database cloned from a template ``live-pg-ephemeral.bats`` builds — the
    ledger is append-only, so rows cannot be cleaned up.
    """

    _TEMPLATE = SimpleNamespace(
        FULL="trial_ledger_tpl", ABSENT="trial_ledger_absent_tpl"
    )

    def setUp(self) -> None:
        get_ephemeral_connection().close()
        import psycopg

        self.psycopg = psycopg
        super().setUp()
        self.histories = {_AGENT.PASSING: _get_floor_passing_history(_UNITS.AT_BOUND)}

    def _use_database(self, template: str) -> None:
        self.dbname = f"de_{os.getpid()}_{uuid.uuid4().hex[:8]}"
        self._run_admin(f'CREATE DATABASE "{self.dbname}" TEMPLATE "{template}"')
        self.addCleanup(self._run_admin, f'DROP DATABASE "{self.dbname}" WITH (FORCE)')
        patcher = mock.patch.object(dc, "_pg_connect", self._connect)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run_admin(self, statement: str) -> None:
        with self.psycopg.connect(
            dbname="eph_bootstrap", connect_timeout=2, autocommit=True
        ) as admin:
            admin.execute(statement)

    def _connect(self):
        return self.psycopg.connect(dbname=self.dbname, connect_timeout=2)

    def _insert(self, recorded_at: datetime, event: str, payload: dict) -> None:
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO core.autoagent_trial_ledger (recorded_at, agent, event, actor, payload)"
                " VALUES (%s, %s, %s, %s, %s::jsonb)",
                (
                    recorded_at,
                    _AGENT.PASSING,
                    event,
                    dc.TRIAL_LEDGER.ACTOR.AA,
                    json.dumps(payload),
                ),
            )

    def _check(
        self, patterns: list[dc.Pattern] | None = None
    ) -> tuple[dict[str, int], str]:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            counts = dc.check_pattern_power(
                patterns or [_pattern(_AGENT.PASSING, 1)], skip_loop_emit=True
            ).counts
        self.assertEqual(self.pg_reach, [])
        return counts, stderr.getvalue()

    def test_the_latest_aa_row_of_the_agent_and_key_sets_the_bound(self) -> None:
        self._use_database(self._TEMPLATE.FULL)
        event = dc.TRIAL_LEDGER.EVENT
        raised = _build_design_effect_payload(_DESIGN_EFFECT * 1.2)
        latest = _DAY - timedelta(days=1)
        # older and higher · a tie at the latest instant broken by insertion order ·
        # a higher row on the other key after it · another event last
        self._insert(_DAY - timedelta(days=3), event.AA_ARM_DESIGN_EFFECT, raised)
        self._insert(latest, event.AA_ARM_DESIGN_EFFECT, raised)
        self._insert(latest, event.AA_ARM_DESIGN_EFFECT, _build_design_effect_payload())
        self._insert(
            latest,
            event.AA_ARM_DESIGN_EFFECT,
            _build_design_effect_payload(_DESIGN_EFFECT * 1.2, _KEY.EMIT),
        )
        self._insert(
            latest,
            event.AA_RESTART,
            {
                "start_id": 1,
                "reason": dc.AA.RESTART_REASON.CHANGED,
                "fingerprint": {"hooks/inject-scope-rules.sh": "1" * 64},
            },
        )
        counts, _ = self._check()
        self.assertEqual(counts["passing"], 1)

    def test_a_ledger_without_a_row_for_the_agent_counts_design_unmeasured(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.FULL)
        counts, _ = self._check()
        self.assertEqual((counts["design-unmeasured"], counts["passing"]), (1, 0))

    def test_a_schema_without_the_ledger_counts_only_floor_passing_patterns_unchecked(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.ABSENT)
        self.histories[_AGENT.FLOOR_FAILING] = _get_floor_failing_history()
        counts, stderr_text = self._check(
            [_pattern(_AGENT.PASSING, 1), _pattern(_AGENT.FLOOR_FAILING, 2)]
        )
        self.assertEqual((counts["unchecked"], sum(counts.values())), (1, 1))
        self.assertIn("core.autoagent_trial_ledger", stderr_text)


class PowerCheckCycleReportTest(_StageFixture):
    """run_cycle stores the counter on the report and in its JSON on the closed branch."""

    def setUp(self) -> None:
        super().setUp()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        agents_dir = self.root / "agents"
        agents_dir.mkdir()
        for agent in (_AGENT.PASSING, _AGENT.UNDERPOWERED):
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
            _AGENT.PASSING: _get_floor_passing_history(_UNITS.AT_BOUND),
            _AGENT.UNDERPOWERED: _get_floor_passing_history(_UNITS.BELOW_BOUND),
        }
        rows = [
            {
                "id": row_id,
                "agent": agent,
                "pattern_signature": f"budget-overage concentration|{agent}",
                "frequency": 4,
                "status": "identified",
                "discovered_date": date(2026, 8, 1),
                "metric_key": _KEY.BUDGET,
            }
            for row_id, agent in ((1, _AGENT.PASSING), (2, _AGENT.UNDERPOWERED))
        ]
        patcher = mock.patch.object(dc, "_pg_read_pending_patterns", lambda: list(rows))
        patcher.start()
        self.addCleanup(patcher.stop)
        # the armed loop-write flag also opens the regression-gate and discharge reads
        self.statements.answered_empty = frozenset(
            {
                dc._REGRESSION_WARNINGS_SELECT_SQL,
                dc._REGRESSION_PROPOSALS_SELECT_SQL,
                dc._APPLIED_FOR_DISCHARGE_SELECT_SQL,
            }
        )

    def test_the_report_counter_equals_the_passing_count(self) -> None:
        self.assertTrue(dc.IS_GENERATION_CLOSED)
        with contextlib.redirect_stderr(io.StringIO()):
            report = dc.run_cycle(
                log_path=self.root / "learning-log.md",
                agents_dir=self.root / "agents",
                skip_haiku=True,
                skip_pre_verify=True,
                skip_loop_emit=True,
            )
        self.assertEqual(self.pg_reach, [])
        self.assertEqual(self.statements.refused, [])
        self.assertCountEqual(
            self.statements.seen,
            [dc.POWER.DESIGN_EFFECT_SQL, *self.statements.answered_empty],
        )
        self.assertEqual(report.power_check["passing"], 1)
        self.assertEqual(dc._report_to_dict(report)["power_check"], report.power_check)


if __name__ == "__main__":
    unittest.main()
