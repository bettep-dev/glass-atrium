"""Shadow engine stage: pre-registration, looks and the power-pass counter on the trial ledger.

The stage decides nothing: it pre-registers one trial per power-passing pattern, records each
look milestone the accrued tasks reach, and counts the cycle's power verdicts once per cycle
date. Every row outside the live class is database-free under ``seal_pg_reach``; the ledger is
an in-memory append-only fake behind the writer and connection seams. The live class runs the
pre-registration read's SQL on the cluster ``autoagent/test/live-pg-ephemeral.bats`` provisions
and skips elsewhere.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_shadow_engine.py -v
    python3 -m unittest autoagent.test.test_shadow_engine -v
"""

from __future__ import annotations

import contextlib
import functools
import hashlib
import io
import itertools
import json
import math
import os
import re
import sys
import tempfile
import unittest
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import NamedTuple
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
from _outcome_signal import SpawnFacts, get_pair_windows, is_floor_half
from _pg_seal import get_ephemeral_connection, seal_pg_reach

_NOW = datetime(2026, 10, 5, 6, 0, tzinfo=timezone.utc)
_DAY = get_pair_windows(_NOW).end  # D
_NEXT_NOW = _NOW + timedelta(days=1)  # a cycle on D + 1
_AGENT = "glass-atrium-dev-python"
_PATTERN_ID = 41
_BUDGET_KEY = "budget_overage"
_DESIGN_EFFECT = trial_design.DesignEffect(anova=1.2, size_weighted=1.5)
# floor-half baseline 20 events / 200 spawns → rate 0.1; the bound read from the reference module
_BASELINE = SimpleNamespace(EVENTS=20, SPAWNS=200)
_MAXIMUM = trial_design.get_maximum_sample_size(_BASELINE.EVENTS / _BASELINE.SPAWNS)
_REQUIRED = trial_design.get_required_units(
    _MAXIMUM, design_effect=_DESIGN_EFFECT.selected
)
_MILESTONES = [fraction * _REQUIRED for fraction in trial_design.LOOK_FRACTIONS]
_LOOK_KEYS = {"look", "fraction", "milestone", "boundary", "accrued_tasks"}


def _get_agent_ids(*, is_floor: bool):
    return (
        agent_id
        for agent_id in (f"s{index:07x}" for index in itertools.count())
        if is_floor_half(agent_id) is is_floor
    )


_IDS = SimpleNamespace(
    FLOOR=_get_agent_ids(is_floor=True),
    REFERENCE=_get_agent_ids(is_floor=False),
)


def _spawn(
    started_at: datetime, *, is_event: bool = False, is_floor: bool = False
) -> SpawnFacts:
    agent_id = next(_IDS.FLOOR if is_floor else _IDS.REFERENCE)
    return SpawnFacts(
        agent_id, f"session-{agent_id}", started_at, int(is_event), True, ()
    )


@functools.cache
def _get_passing_history() -> tuple[SpawnFacts, ...]:
    """A budget_overage pair that passes the floor and the power bound on D and on D + 1.

    Event spawns sit in D + 1's detection and confirmation windows, which lie inside D's;
    reference-half filler over [D - 27 d, D) clears the bound on both days."""
    windows = get_pair_windows(_NEXT_NOW)
    baseline = [
        _spawn(
            _DAY - timedelta(days=40, hours=-index),
            is_event=index < _BASELINE.EVENTS,
            is_floor=True,
        )
        for index in range(_BASELINE.SPAWNS)
    ]
    events = [
        _spawn(window_start + timedelta(hours=index), is_event=True)
        for window_start in (windows.start.detection, windows.start.confirmation)
        for index in range(6)
    ]
    filler = [
        _spawn(_DAY - timedelta(days=27) + timedelta(minutes=index))
        for index in range(math.ceil(_REQUIRED * 28 / 84) + 1)
    ]
    return tuple(baseline + events + filler)


def _get_spawns_after(start: datetime, count: int) -> list[SpawnFacts]:
    """`count` single-spawn tasks from `start`, one second apart; event spawns, so the
    confirmation half they land in keeps passing the floor."""
    return [
        _spawn(start + timedelta(seconds=index), is_event=True)
        for index in range(count)
    ]


class _LedgerRow(NamedTuple):
    id: int
    recorded_at: datetime
    trial_key: str | None
    agent: str | None
    learning_pattern_id: int | None
    event: str
    actor: str
    payload: dict
    dedupe_key: str | None


@functools.cache
def _get_trial_ledger() -> SimpleNamespace:
    """The helper's declared ledger names, loaded on the stub backend so a psycopg-free leg has them."""
    with (
        tempfile.TemporaryDirectory() as scratch,
        stub.load_helper(Path(scratch) / "stub.sqlite") as helper,
    ):
        return helper.TRIAL_LEDGER


class _Ledger:
    """core.autoagent_trial_ledger as the writer and the stage's reads see it: append-only,
    a taken dedupe_key adds no row (ON CONFLICT DO NOTHING), payload stored as JSON."""

    def __init__(self, clock: SimpleNamespace) -> None:
        self.clock = clock
        self.rows: list[_LedgerRow] = []
        self.design_effects: dict[str, dict] = {}
        self.refused: list[str] = []
        self.faulted: set[str] = set()
        # read only by a cycle whose loop-write flag also opens these gate reads
        self.answered_empty = frozenset(
            {
                dc._REGRESSION_WARNINGS_SELECT_SQL,
                dc._REGRESSION_PROPOSALS_SELECT_SQL,
                dc._APPLIED_FOR_DISCHARGE_SELECT_SQL,
            }
        )

    def write(
        self,
        event,
        actor,
        payload,
        *,
        trial_key=None,
        agent=None,
        learning_pattern_id=None,
        dedupe_key=None,
    ):
        if dedupe_key is not None and any(
            row.dedupe_key == dedupe_key for row in self.rows
        ):
            return 0
        stored = json.loads(json.dumps(payload))
        self.rows.append(
            _LedgerRow(
                len(self.rows) + 1,
                self.clock.now,
                trial_key,
                agent,
                learning_pattern_id,
                event,
                actor,
                stored,
                dedupe_key,
            )
        )
        return 1

    def connect(self) -> contextlib.nullcontext:
        return contextlib.nullcontext(_LedgerCursor(self))

    def get_rows(self, event: str) -> list[_LedgerRow]:
        return [row for row in self.rows if row.event == event]


class _LedgerCursor:
    def __init__(self, ledger: _Ledger) -> None:
        self.ledger = ledger
        self.result: list[tuple] = []

    def cursor(self) -> contextlib.nullcontext:
        return contextlib.nullcontext(self)

    def execute(self, statement: str, params: tuple = ()) -> None:
        if statement in self.ledger.faulted:
            raise ConnectionError("PG unreachable")
        if statement in self.ledger.answered_empty:
            self.result = []
        elif statement == dc.POWER.DESIGN_EFFECT_SQL:
            _, agents = params
            self.result = [
                (agent, self.ledger.design_effects[agent])
                for agent in agents
                if agent in self.ledger.design_effects
            ]
        elif statement == dc.SHADOW.PREREGISTRATION_SQL:
            event, agents = params
            latest: dict[tuple, _LedgerRow] = {}
            for row in self.ledger.rows:
                if row.event == event and row.agent in agents:
                    latest[
                        (row.agent, row.learning_pattern_id, row.payload["metric_key"])
                    ] = row
            self.result = [
                (*group, row.trial_key, row.payload, row.recorded_at)
                for group, row in latest.items()
            ]
        else:
            self.ledger.refused.append(statement)
            raise AssertionError(f"statement outside the ledger fake: {statement[:80]}")

    def fetchall(self) -> list[tuple]:
        return self.result


def _pattern(*, last_transition_at: datetime | None = None) -> dc.Pattern:
    label = "budget-overage concentration"
    return dc.Pattern(
        date="2026-08-01",
        label=label,
        frequency="4",
        agent=_AGENT,
        status="identified",
        tier="user-pending",
        raw_line=f"{label}|{_AGENT}",
        row_id=_PATTERN_ID,
        metric_key=_BUDGET_KEY,
        last_transition_at=last_transition_at,
    )


class _ShadowFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.pg_reach = seal_pg_reach(self)
        self.clock = SimpleNamespace(now=_NOW)
        self.ledger = _Ledger(self.clock)
        self.ledger.design_effects[_AGENT] = _DESIGN_EFFECT._asdict()
        self.history = list(_get_passing_history())
        self.patterns = [_pattern()]
        # after the seal: spawn read, ledger connection and writer = the DB boundary
        for name, value in (
            ("HAS_PG_PATTERN_READ", True),
            ("_pg_read_spawn_facts", self._read_spawn_facts),
            ("HAS_PG_LOOP_WRITE", True),
            ("_pg_connect", self.ledger.connect),
            ("_pg_write_trial_ledger_row", self.ledger.write),
            ("_get_utc_now", lambda: self.clock.now),
        ):
            self._patch(name, value)
        self._patch(
            "TRIAL_LEDGER", _get_trial_ledger(), create=not hasattr(dc, "TRIAL_LEDGER")
        )

    def _patch(self, name: str, value: object, *, create: bool = False) -> None:
        patcher = mock.patch.object(dc, name, value, create=create)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _read_spawn_facts(self, agents, windows):
        return _DAY - timedelta(days=60), {
            agent: list(self.history) for agent in agents
        }

    def _cycle(self, now: datetime) -> str:
        """One intake power check + shadow stage at `now`; returns its stderr."""
        self.clock.now = now
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            power = dc.check_pattern_power(self.patterns, skip_loop_emit=True)
            dc.run_shadow_stage(power, now.strftime("%Y-%m-%d"))
        self.assertEqual(self.pg_reach, [])
        self.assertEqual(self.ledger.refused, [])
        return stderr.getvalue()

    def _get_preregistrations(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(_get_trial_ledger().EVENT.SHADOW_PREREGISTRATION)

    def _get_looks(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(_get_trial_ledger().EVENT.SHADOW_LOOK)


class PreRegistrationTest(_ShadowFixture):
    """One pre-registration per trial, its sizing frozen from the trial-design module."""

    def test_the_preregistration_freezes_the_trial_design_boundaries_maximum_and_look_milestones(
        self,
    ) -> None:
        self._cycle(_NOW)
        [row] = self._get_preregistrations()
        payload = row.payload
        self.assertEqual(payload["boundaries"], list(trial_design.get_boundaries()))
        self.assertEqual(len(payload["boundaries"]), 4)
        self.assertEqual(payload["maximum_per_arm"], _MAXIMUM)
        self.assertEqual(payload["design_effect"], _DESIGN_EFFECT.selected)
        self.assertEqual([look["milestone"] for look in payload["looks"]], _MILESTONES)
        self.assertEqual(
            (row.agent, row.learning_pattern_id, row.actor, row.dedupe_key),
            (_AGENT, _PATTERN_ID, _get_trial_ledger().ACTOR.SHADOW, row.trial_key),
        )
        self.assertRegex(row.trial_key, re.compile(r"^[0-9a-f]{64}$"))

    def test_cycles_on_consecutive_days_over_a_still_passing_pattern_write_one_preregistration(
        self,
    ) -> None:
        self._cycle(_NOW)
        self._cycle(_NEXT_NOW)
        self.assertEqual(len(self._get_preregistrations()), 1)
        counters = self.ledger.get_rows(_get_trial_ledger().EVENT.POWER_PASS_COUNT)
        self.assertEqual([row.payload["passing"] for row in counters], [1, 1])

    def test_a_lifecycle_move_after_the_preregistration_starts_a_new_trial_on_the_current_pair(
        self,
    ) -> None:
        rows = [
            ("never transitioned → the trial is kept", None, 1),
            (
                "transitioned before the pre-registration → the trial is kept",
                _NOW - timedelta(days=3),
                1,
            ),
            (
                "transitioned after the pre-registration → a new trial",
                _NOW + timedelta(hours=2),
                2,
            ),
        ]
        for name, last_transition_at, preregistrations in rows:
            with self.subTest(name):
                self.ledger.rows.clear()
                self.patterns = [_pattern(last_transition_at=last_transition_at)]
                self._cycle(_NOW)
                self._cycle(_NEXT_NOW)
                registered = self._get_preregistrations()
                self.assertEqual(len(registered), preregistrations)
                self.assertEqual(
                    registered[-1].payload["detection_start"],
                    get_pair_windows(
                        self.clock.now if preregistrations == 2 else _NOW
                    ).start.detection.isoformat(),
                )

    def test_a_lifecycle_move_on_the_preregistrations_utc_day_lands_no_new_trial_and_warns_by_name(
        self,
    ) -> None:
        first_stderr = self._cycle(_NOW)
        self.patterns = [_pattern(last_transition_at=_NOW + timedelta(hours=1))]
        second_stderr = self._cycle(_NOW + timedelta(hours=2))
        [trial] = self._get_preregistrations()
        warning = f"WARN: shadow stage — trial {trial.trial_key}: pre-registration landed 0 rows"
        self.assertNotIn(warning, first_stderr)
        self.assertIn(warning, second_stderr)


class LookTest(_ShadowFixture):
    """Looks accrue on tasks from the pre-registration; each reached milestone is one row, never a decision."""

    def test_each_reached_look_is_recorded_with_its_accrual_and_boundary_and_no_decision(
        self,
    ) -> None:
        self._cycle(_NOW)
        accrued = math.ceil(_MILESTONES[1])  # looks 1 and 2 reached, 3 not
        self.history += _get_spawns_after(_NOW, accrued)
        self._cycle(_NEXT_NOW)
        looks = self._get_looks()
        [trial] = self._get_preregistrations()
        boundaries = trial_design.get_boundaries()
        self.assertEqual([look.payload["look"] for look in looks], [1, 2])
        for look in looks:
            number = look.payload["look"]
            self.assertEqual(set(look.payload), _LOOK_KEYS)
            self.assertEqual(look.payload["accrued_tasks"], accrued)
            self.assertEqual(look.payload["boundary"], boundaries[number - 1])
            self.assertEqual(look.dedupe_key, f"{trial.trial_key}:look:{number}")

    def test_a_task_started_before_the_preregistration_accrues_nothing(self) -> None:
        self.history += _get_spawns_after(
            _NOW - timedelta(hours=1), math.ceil(_MILESTONES[0])
        )
        self._cycle(_NOW)
        self._cycle(_NEXT_NOW)
        self.assertEqual(self._get_looks(), [])

    def test_synthetic_two_arm_data_at_each_look_records_the_pooled_z_beside_the_boundary(
        self,
    ) -> None:
        # control 30/100, treatment 10/100: pooled 0.2 → se √(0.2·0.8·(1/100 + 1/100)) = √0.0032
        #   z = (0.3 - 0.1) / 0.0565685 = 3.5355339 (a reduction counts positive)
        arms = dc.TrialArms(
            control=dc.ArmCount(events=30, units=100),
            treatment=dc.ArmCount(events=10, units=100),
        )
        boundaries = trial_design.get_boundaries()
        for number, (fraction, boundary) in enumerate(
            zip(trial_design.LOOK_FRACTIONS, boundaries), start=1
        ):
            with self.subTest(look=number):
                look = {
                    "fraction": fraction,
                    "milestone": fraction * _REQUIRED,
                    "boundary": boundary,
                }
                payload = dc.get_look_payload(number, look, 200, arms)
                self.assertAlmostEqual(payload["z"], 3.5355339, places=6)
                self.assertEqual(payload["boundary"], boundary)
                self.assertEqual(set(payload), _LOOK_KEYS | {"arms", "z"})

    def test_two_arms_with_no_variance_record_no_z(self) -> None:
        arms = dc.TrialArms(
            control=dc.ArmCount(events=0, units=50),
            treatment=dc.ArmCount(events=0, units=50),
        )
        look = {"fraction": 0.25, "milestone": 25.0, "boundary": 4.0}
        self.assertIsNone(dc.get_look_payload(1, look, 100, arms)["z"])


class DuplicateTest(_ShadowFixture):
    def test_a_second_cycle_over_the_same_evidence_writes_no_duplicate_row(
        self,
    ) -> None:
        self._cycle(_NOW)
        self.history += _get_spawns_after(_NOW, math.ceil(_MILESTONES[1]))
        self._cycle(_NEXT_NOW)
        written = list(self.ledger.rows)
        self._cycle(_NEXT_NOW)
        self.assertEqual(self.ledger.rows, written)
        events = {row.event for row in written}
        trial_ledger = _get_trial_ledger()
        self.assertEqual(
            events,
            {
                trial_ledger.EVENT.SHADOW_PREREGISTRATION,
                trial_ledger.EVENT.SHADOW_LOOK,
                trial_ledger.EVENT.POWER_PASS_COUNT,
            },
        )


class PowerPassCounterTest(_ShadowFixture):
    """The counter reuses the intake verdicts: one row per cycle date."""

    def _get_counters(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(_get_trial_ledger().EVENT.POWER_PASS_COUNT)

    def test_the_counter_records_the_cycles_verdict_counts_once_per_cycle_date(
        self,
    ) -> None:
        self._cycle(_NOW)
        self._cycle(_NOW + timedelta(hours=3))
        self._cycle(_NEXT_NOW)
        counters = self._get_counters()
        self.assertEqual(
            [row.dedupe_key for row in counters],
            [
                f"power-pass-count:{_NOW:%Y-%m-%d}",
                f"power-pass-count:{_NEXT_NOW:%Y-%m-%d}",
            ],
        )
        self.assertEqual(counters[0].payload["passing"], 1)
        self.assertEqual(set(counters[0].payload), set(vars(dc.POWER.VERDICT).values()))

    def test_the_design_effect_comes_from_the_agents_latest_aa_row_or_counts_design_unmeasured(
        self,
    ) -> None:
        rows = [
            ("no A/A design-effect row → design-unmeasured, never passing", None, 0, 1),
            ("an A/A row → its higher estimator sizes the trial", _DESIGN_EFFECT, 1, 0),
        ]
        for name, design_effect, passing, unmeasured in rows:
            with self.subTest(name):
                self.ledger.rows.clear()
                self.ledger.design_effects.clear()
                if design_effect is not None:
                    self.ledger.design_effects[_AGENT] = design_effect._asdict()
                self._cycle(_NOW)
                [counter] = self._get_counters()
                self.assertEqual(
                    (counter.payload["passing"], counter.payload["design-unmeasured"]),
                    (passing, unmeasured),
                )
                registered = self._get_preregistrations()
                self.assertEqual(
                    [row.payload["design_effect"] for row in registered],
                    [] if design_effect is None else [design_effect.selected],
                )


class LedgerFaultTest(_ShadowFixture):
    def test_a_ledger_fault_is_warned_by_name_and_never_fails_the_cycle(self) -> None:
        def _fail(*args: object, **kwargs: object) -> None:
            raise ConnectionError("PG unreachable")

        with (
            self.subTest("the writer faults"),
            mock.patch.object(dc, "_pg_write_trial_ledger_row", _fail),
        ):
            stderr_text = self._cycle(_NOW)
            self.assertIn("WARN: shadow stage — power-pass-count", stderr_text)
            self.assertIn("ConnectionError", stderr_text)
        with self.subTest("the pre-registration read faults"):
            self.ledger.faulted.add(dc.SHADOW.PREREGISTRATION_SQL)
            stderr_text = self._cycle(_NOW)
            self.assertIn(
                "WARN: shadow stage — pre-registrations unreadable: ConnectionError",
                stderr_text,
            )
            self.assertEqual(self._get_preregistrations(), [])


class PreRegistrationReadLivePgTest(_ShadowFixture):
    """The pre-registration read's real SQL on the ephemeral cluster; skips anywhere else.

    Each test owns a database cloned from a template ``live-pg-ephemeral.bats`` builds — the
    ledger is append-only, so rows cannot be cleaned up. The power check runs on the fake
    ledger; only the stage's ledger connection then points at the clone.
    """

    _TEMPLATE = SimpleNamespace(
        FULL="trial_ledger_tpl", ABSENT="trial_ledger_absent_tpl"
    )

    def setUp(self) -> None:
        get_ephemeral_connection().close()
        import psycopg

        self.psycopg = psycopg
        super().setUp()

    def _use_database(self, template: str) -> None:
        self.dbname = f"sh_{os.getpid()}_{uuid.uuid4().hex[:8]}"
        self._run_admin(f'CREATE DATABASE "{self.dbname}" TEMPLATE "{template}"')
        self.addCleanup(self._run_admin, f'DROP DATABASE "{self.dbname}" WITH (FORCE)')
        self._patch("_pg_connect", self._connect)

    def _run_admin(self, statement: str) -> None:
        with self.psycopg.connect(
            dbname="eph_bootstrap", connect_timeout=2, autocommit=True
        ) as admin:
            admin.execute(statement)

    def _connect(self):
        return self.psycopg.connect(dbname=self.dbname, connect_timeout=2)

    def _insert(
        self,
        recorded_at: datetime,
        event: str,
        *,
        agent: str = _AGENT,
        pattern_id: int = _PATTERN_ID,
    ) -> str:
        """One ledger row for (agent, pattern_id, budget_overage) → its trial key."""
        key = hashlib.sha256(
            f"{agent}|{pattern_id}|{event}|{recorded_at.isoformat()}".encode()
        ).hexdigest()
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO core.autoagent_trial_ledger (recorded_at, trial_key, agent,"
                " learning_pattern_id, event, actor, payload, dedupe_key)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s)",
                (
                    recorded_at,
                    key,
                    agent,
                    pattern_id,
                    event,
                    _get_trial_ledger().ACTOR.SHADOW,
                    json.dumps({"metric_key": _BUDGET_KEY}),
                    key,
                ),
            )
        return key

    def _check_power(self) -> dc.PowerResult:
        with contextlib.redirect_stderr(io.StringIO()):
            power = dc.check_pattern_power(self.patterns, skip_loop_emit=True)
        self.assertEqual(len(power.passes), 1)
        return power

    def test_the_read_keeps_the_latest_preregistration_per_agent_pattern_and_metric_key(
        self,
    ) -> None:
        power = self._check_power()
        self._use_database(self._TEMPLATE.FULL)
        event = _get_trial_ledger().EVENT
        latest_at = _NOW - timedelta(days=1)
        latest = self._insert(latest_at, event.SHADOW_PREREGISTRATION)
        # older yet inserted later · another pattern · an agent outside the passes · a later look
        self._insert(_NOW - timedelta(days=3), event.SHADOW_PREREGISTRATION)
        other = self._insert(
            _NOW - timedelta(days=2),
            event.SHADOW_PREREGISTRATION,
            pattern_id=_PATTERN_ID + 1,
        )
        self._insert(
            latest_at, event.SHADOW_PREREGISTRATION, agent="glass-atrium-dev-shell"
        )
        self._insert(_NOW, event.SHADOW_LOOK)
        trials = dc._read_shadow_trials(power.passes)
        self.assertEqual(
            {group: trial.key for group, trial in trials.items()},
            {
                (_AGENT, _PATTERN_ID, _BUDGET_KEY): latest,
                (_AGENT, _PATTERN_ID + 1, _BUDGET_KEY): other,
            },
        )
        trial = trials[(_AGENT, _PATTERN_ID, _BUDGET_KEY)]
        self.assertIsNotNone(trial.recorded_at.tzinfo)
        self.assertEqual(trial.recorded_at, latest_at)
        self.assertEqual(trial.payload, {"metric_key": _BUDGET_KEY})

    def test_a_schema_without_the_ledger_warns_on_the_read_and_preregisters_nothing(
        self,
    ) -> None:
        power = self._check_power()
        self._use_database(self._TEMPLATE.ABSENT)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            dc.run_shadow_stage(power, f"{_NOW:%Y-%m-%d}")
        self.assertRegex(
            stderr.getvalue(),
            r"WARN: shadow stage — pre-registrations unreadable: UndefinedTable: "
            r".*core\.autoagent_trial_ledger",
        )
        self.assertEqual(self._get_preregistrations(), [])
        self.assertEqual(self.pg_reach, [])


class SealTest(_ShadowFixture):
    def test_the_seal_alone_lets_the_stage_reach_no_ledger_and_names_the_writer_seam(
        self,
    ) -> None:
        reach = seal_pg_reach(self)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            power = dc.check_pattern_power(self.patterns, skip_loop_emit=True)
            dc.run_shadow_stage(power, "2026-10-05")
        self.assertEqual(reach, [])
        self.assertIn("WARN: shadow stage", stderr.getvalue())
        self._patch("HAS_PG_LOOP_WRITE", True)
        with contextlib.redirect_stderr(io.StringIO()):
            dc.run_shadow_stage(power, "2026-10-05")
        self.assertEqual(reach, ["_pg_write_trial_ledger_row"])


class CycleWiringTest(_ShadowFixture):
    """run_cycle runs the stage on a writing cycle; no-write mode (--dry-run → skip_loop_emit) writes no ledger row."""

    def setUp(self) -> None:
        super().setUp()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "agents").mkdir()
        (self.root / "agents" / f"{_AGENT}.md").write_text("probe", encoding="utf-8")
        env = mock.patch.dict(
            os.environ,
            {
                "GA_DATA_ROOT": str(self.root),
                "AUTOAGENT_REPORTS_DIR": str(self.root / "reports"),
            },
        )
        env.start()
        self.addCleanup(env.stop)
        intake = {
            "id": _PATTERN_ID,
            "agent": _AGENT,
            "pattern_signature": f"budget-overage concentration|{_AGENT}",
            "frequency": 4,
            "status": "identified",
            "discovered_date": date(2026, 8, 1),
            "metric_key": _BUDGET_KEY,
            "last_transition_at": None,
        }
        self._patch("_pg_read_pending_patterns", lambda: [dict(intake)])

    def _run_cycle(self, *, skip_loop_emit: bool) -> dc.CycleReport:
        with contextlib.redirect_stderr(io.StringIO()):
            report = dc.run_cycle(
                log_path=self.root / "learning-log.md",
                agents_dir=self.root / "agents",
                skip_haiku=True,
                skip_pre_verify=True,
                skip_loop_emit=skip_loop_emit,
            )
        self.assertEqual(self.pg_reach, [])
        self.assertEqual(report.power_check["passing"], 1)
        return report

    def test_a_dry_run_cycle_writes_no_ledger_row(self) -> None:
        self._run_cycle(skip_loop_emit=True)
        self.assertEqual(self.ledger.refused, [])
        self.assertEqual(self.ledger.rows, [])

    def test_a_writing_cycle_counts_and_preregisters_on_the_ledger(self) -> None:
        def _refuse(*args: object, **kwargs: object) -> None:
            raise ConnectionRefusedError("corpus audit: no database in this test")

        self._patch("_pg_write_corpus_audit", _refuse)
        self._patch(
            "_pg_write_loop_event", lambda *args, **kwargs: True
        )  # census events: not under test
        self._run_cycle(skip_loop_emit=False)
        # other writing stages' statements (pending-auto terminalization) are refused, not under test
        self.assertEqual(
            [
                statement
                for statement in self.ledger.refused
                if "autoagent_trial_ledger" in statement
            ],
            [],
        )
        trial_ledger = _get_trial_ledger()
        self.assertEqual(
            sorted(row.event for row in self.ledger.rows),
            sorted(
                [
                    trial_ledger.EVENT.POWER_PASS_COUNT,
                    trial_ledger.EVENT.SHADOW_PREREGISTRATION,
                ]
            ),
        )


if __name__ == "__main__":
    unittest.main()
