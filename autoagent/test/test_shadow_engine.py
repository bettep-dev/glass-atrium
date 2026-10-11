"""Live trial opening and the shadow stage: the bound payload, live looks and the pass counter.

The cycle attaches a pre-registration payload only to a verified non-safety candidate of a
power-passing pattern; the push stores it as the live pre-registration. The stage decides
nothing and pre-registers nothing: it counts the cycle's power verdicts once per cycle date
and records each look milestone a live trial's accrued tasks reach. Every row outside the
live class is database-free under ``seal_pg_reach``; the ledger is an in-memory append-only
fake behind the writer and connection seams. The live class runs the pre-registration read's
SQL on the cluster ``autoagent/test/live-pg-ephemeral.bats`` provisions and skips elsewhere.

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_shadow_engine.py -v
    python3 -m unittest autoagent.test.test_shadow_engine -v
"""

from __future__ import annotations

import ast
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
from _pg_seal import get_ephemeral_connection, seal_pg_reach, set_install_tree

_NOW = datetime(2026, 10, 5, 6, 0, tzinfo=timezone.utc)
_DAY = get_pair_windows(_NOW).end  # D
_NEXT_NOW = _NOW + timedelta(days=1)  # a cycle on D + 1
_AGENT = "glass-atrium-dev-python"
_PATTERN_ID = 41
_BUDGET_KEY = "budget_overage"
# the pattern key's A/A arm-difference design effect, as its ledger row stores it
_DESIGN_EFFECT = trial_design.ArmDesignEffect(1.5, 20, 200, 1.3, 1.8, 2000)
_DESIGN_EFFECT_PAYLOAD = {"metric_key": _BUDGET_KEY, **_DESIGN_EFFECT._asdict()}
# floor-half baseline 20 events / 200 spawns → rate 0.1; the bound read from the reference module
_BASELINE = SimpleNamespace(EVENTS=20, SPAWNS=200)
_MAXIMUM = trial_design.get_trial_sample_size(_BASELINE.EVENTS / _BASELINE.SPAWNS)
_REQUIRED = trial_design.get_required_units(
    _MAXIMUM, design_effect=_DESIGN_EFFECT.value
)
_MILESTONES = [fraction * _REQUIRED for fraction in trial_design.LOOK_FRACTIONS]
_LOOK_KEYS = {"look", "fraction", "milestone", "boundary", "accrued_tasks"}
# the payload's top-level keys the cycle builds; readers: metric_key (the read), looks (looks)
_PREREGISTRATION_KEYS = {
    "metric_key",
    "detection_start",
    "baseline",
    "maximum_per_arm",
    "design_effect",
    "required_units",
    "boundaries",
    "looks",
    "task_window_seconds",
}
# a live trial as the push stores it: trial and dedupe key from the proposal id
_PROPOSAL_ID = 9001
_LIVE_KEY = f"{_PROPOSAL_ID:064x}"


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


class _Ledger:
    """core.autoagent_trial_ledger as the writer and the stage's reads see it: append-only,
    a taken dedupe_key adds no row (ON CONFLICT DO NOTHING), payload stored as JSON."""

    def __init__(self, clock: SimpleNamespace) -> None:
        self.clock = clock
        self.rows: list[_LedgerRow] = []
        self.design_effects: dict[str, dict] = {}
        self.refused: list[str] = []
        self.faulted: set[str] = set()
        # read only by a cycle whose loop-write flag also opens these gate reads and the A/A stage
        self.answered_empty = frozenset(
            {
                dc._REGRESSION_WARNINGS_SELECT_SQL,
                dc._REGRESSION_PROPOSALS_SELECT_SQL,
                dc._APPLIED_FOR_DISCHARGE_SELECT_SQL,
                dc.AA.SQL.LATEST_START,
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
            agents = params[-1]
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

    def fetchone(self) -> tuple | None:
        return self.result[0] if self.result else None


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
        self.ledger.design_effects[_AGENT] = _DESIGN_EFFECT_PAYLOAD
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
            "TRIAL_LEDGER", stub.get_trial_ledger(), create=not hasattr(dc, "TRIAL_LEDGER")
        )

    def _patch(self, name: str, value: object, *, create: bool = False) -> None:
        patcher = mock.patch.object(dc, name, value, create=create)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _read_spawn_facts(self, agents, windows):
        return _DAY - timedelta(days=60), {
            agent: list(self.history) for agent in agents
        }

    def _check_power(self) -> dc.PowerResult:
        """The intake power check at the clock's now (stderr dropped); kept as the cycle's power."""
        with contextlib.redirect_stderr(io.StringIO()):
            self.power = dc.check_pattern_power(self.patterns, skip_loop_emit=True)
        return self.power

    def _cycle(self, now: datetime) -> str:
        """One intake power check + shadow stage at `now`; returns its stderr."""
        self.clock.now = now
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            power = dc.check_pattern_power(self.patterns, skip_loop_emit=True)
            dc.run_shadow_stage(power, now.strftime("%Y-%m-%d"))
        self.power = power
        self.assertEqual(self.pg_reach, [])
        self.assertEqual(self.ledger.refused, [])
        return stderr.getvalue()

    def _open_live_trial(self, *, event: str = "", missing: tuple[str, ...] = ()) -> str:
        """The current pass's pre-registration, stored at the clock's now as the push does → its key.

        `event` defaults to the live pre-registration; `missing` drops payload keys."""
        trial_ledger = stub.get_trial_ledger()
        power = self._check_power()
        [power_pass] = power.passes
        payload = dc.get_preregistration_payload(power_pass, power.windows.start.detection)
        for key in missing:
            del payload[key]
        is_shadow = event == trial_ledger.EVENT.SHADOW_PREREGISTRATION
        detection_start = power.windows.start.detection
        key = dc.get_trial_key(power_pass.pattern, detection_start) if is_shadow else _LIVE_KEY
        self.ledger.write(
            event or trial_ledger.EVENT.LIVE_PREREGISTRATION,
            trial_ledger.ACTOR.SHADOW if is_shadow else trial_ledger.ACTOR.LIVE,
            payload if is_shadow else {**payload, "proposal_id": _PROPOSAL_ID},
            trial_key=key,
            agent=_AGENT,
            learning_pattern_id=_PATTERN_ID,
            dedupe_key=key,
        )
        return key

    def _get_preregistrations(self) -> list[_LedgerRow]:
        event = stub.get_trial_ledger().EVENT
        return [
            row
            for row in self.ledger.rows
            if row.event in (event.SHADOW_PREREGISTRATION, event.LIVE_PREREGISTRATION)
        ]

    def _get_looks(self) -> list[_LedgerRow]:
        event = stub.get_trial_ledger().EVENT
        looks = (event.SHADOW_LOOK, event.LIVE_LOOK)
        return [row for row in self.ledger.rows if row.event in looks]


class BoundPayloadTest(_ShadowFixture):
    """Only a verified non-safety candidate of a passing pattern is bound; only it stays pending auto."""

    def setUp(self) -> None:
        super().setUp()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.agents_dir = Path(tmp.name)
        self.target = self.agents_dir / f"{_AGENT}.md"
        self.target.write_text("# probe agent\n", encoding="utf-8")
        self.generated: list[str] = []
        # supersede, gate history and back-off: PG paths outside this unit's question
        for name, value in (
            ("supersede_prior_pending_for_agent", lambda *args, **kwargs: 0),
            ("_drop_gated_patterns", lambda _agent, patterns, _gate: patterns),
            ("consecutive_timeout_count", lambda *args: 0),
            ("INTER_CALL_SPACING_SEC", 0),
            ("_pg_read_open_trials", self._read_open_trials),
        ):
            self._patch(name, value)
        self.clock.now = _NOW

    def _read_open_trials(self) -> dict[str, list[int]]:
        event = stub.get_trial_ledger().EVENT
        decided = {row.dedupe_key for row in self.ledger.get_rows(event.LIVE_DECISION)}
        open_trials: dict[str, list[int]] = {}
        for row in self.ledger.get_rows(event.LIVE_PREREGISTRATION):
            if f"{row.trial_key}:decision" not in decided:
                open_trials.setdefault(row.agent, []).append(row.payload["proposal_id"])
        return open_trials

    def _proposal(self, agent: str, *_args: object, **_kwargs: object) -> dc.PatchProposal:
        self.generated.append(agent)
        return dc.PatchProposal(
            target_file=str(self.target),
            rationale="probe rationale",
            proposed_diff="--- a\n+++ b\n@@ -1 +1,2 @@\n # probe agent\n+- probe rule\n",
            touched_frontmatter=False,
            estimated_added_lines=1,
            raw_response="probe raw response",
        )

    def _seams(self, verdict: dc.PreVerifyResult, *, safety: str, area: str) -> dict:
        return {
            "generate_consolidated_proposal": self._proposal,
            "classify_patch_area": lambda *args, **kwargs: area,
            "classify_safety_tier": lambda *args, **kwargs: safety,
            "run_pre_verify": lambda *args, **kwargs: verdict,
        }

    def _build(
        self,
        power: dc.PowerResult | None,
        verdict: dc.PreVerifyResult = dc.PreVerifyResult(True, "ok", {}, "ok", 0),
        *,
        safety: str = "non-safety",
        area: str = "body-auto",
        skip_loop_emit: bool = False,
    ) -> dc.PatchResult:
        """The generation unit over the pattern; generator and pre-verify faked at their call."""
        with contextlib.ExitStack() as stack:
            stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
            for name, value in self._seams(verdict, safety=safety, area=area).items():
                stack.enter_context(mock.patch.object(dc, name, value))
            result = dc.build_patch_result(
                _AGENT,
                list(self.patterns),
                cycle_date=f"{_NOW:%Y-%m-%d}",
                agents_dir=self.agents_dir,
                seen_targets=set(),
                skip_haiku=True,
                skip_pre_verify=False,
                skip_loop_emit=skip_loop_emit,
                power=power,
            )
        self.assertEqual(self.pg_reach, [])
        return result

    def test_the_bound_payload_freezes_the_trial_design_boundaries_maximum_and_look_milestones(
        self,
    ) -> None:
        power = self._check_power()
        [power_pass] = power.passes
        result = self._build(power)
        payload = result.preregistration_payload
        self.assertEqual(
            payload, dc.get_preregistration_payload(power_pass, power.windows.start.detection)
        )
        self.assertEqual(set(payload), _PREREGISTRATION_KEYS)
        self.assertEqual(payload["boundaries"], list(trial_design.get_boundaries()))
        self.assertEqual(payload["maximum_per_arm"], _MAXIMUM)
        self.assertEqual(payload["design_effect"], _DESIGN_EFFECT.value)
        self.assertEqual([look["milestone"] for look in payload["looks"]], _MILESTONES)
        self.assertEqual((result.approval_tier, result.status), ("auto", "pending"))

    def test_a_candidate_the_cycle_did_not_bind_carries_no_payload_and_never_stays_pending_auto(
        self,
    ) -> None:
        power = self._check_power()
        no_pass = dc.PowerResult(power.counts, [], power.windows)
        quality_fail = dc.PreVerifyResult(False, "C1 failed", {"C1": False}, "ok", 0)
        c3_miss = dc.PreVerifyResult(
            False,
            "C3: FAIL — scope file unresolved",
            {"C1": True, "C2": True, "C3": False, "C4": True},
            "ok",
            0,
        )
        rows = (
            ("a power pass with no candidate", {"power": power, "area": "reject"}),
            ("a pre-verify fail", {"power": power, "verdict": quality_fail}),
            ("a C3 miss", {"power": power, "verdict": c3_miss}),
            ("a safety-routed candidate", {"power": power, "safety": "safety"}),
            ("no-write mode", {"power": power, "skip_loop_emit": True}),
            ("no power pass for the lead pattern", {"power": no_pass}),
            ("no power result", {"power": None}),
        )
        for name, arguments in rows:
            with self.subTest(name):
                result = self._build(**arguments)
                self.assertIsNone(result.preregistration_payload)
                self.assertNotEqual((result.approval_tier, result.status), ("auto", "pending"))

    def test_an_agent_in_trial_gets_no_second_preregistration_until_its_trial_is_decided(
        self,
    ) -> None:
        trial_ledger = stub.get_trial_ledger()
        rows = (("open trial", False, []), ("decided trial", True, [_AGENT]))
        for name, is_decided, bound_agents in rows:
            with self.subTest(name):
                self.ledger.rows.clear()
                key = self._open_live_trial()
                if is_decided:
                    self.ledger.write(
                        trial_ledger.EVENT.LIVE_DECISION,
                        trial_ledger.ACTOR.LIVE,
                        {},
                        trial_key=key,
                        agent=_AGENT,
                        dedupe_key=f"{key}:decision",
                    )
                report = SimpleNamespace(patches=[], cycle_date=f"{_NOW:%Y-%m-%d}")
                verified = dc.PreVerifyResult(True, "ok", {}, "ok", 0)
                with contextlib.ExitStack() as stack:
                    stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                    seams = self._seams(verified, safety="non-safety", area="body-auto")
                    for seam, value in seams.items():
                        stack.enter_context(mock.patch.object(dc, seam, value))
                    dc._run_generation_loop(
                        report,
                        [(_AGENT, list(self.patterns))],
                        dc.GenerationRun(
                            regression_gate=object(),
                            agents_dir=self.agents_dir,
                            skip_haiku=False,
                            skip_pre_verify=False,
                            skip_loop_emit=False,
                            power=self.power,
                        ),
                    )
                self.assertEqual(
                    [
                        patch.pattern_agent
                        for patch in report.patches
                        if patch.preregistration_payload is not None
                    ],
                    bound_agents,
                )
                self.assertEqual(self.pg_reach, [])


class ShadowStageTest(_ShadowFixture):
    """The stage pre-registers nothing: the live pre-registration is the push's."""

    def test_cycles_over_a_still_passing_pattern_write_only_the_counter(self) -> None:
        self._cycle(_NOW)
        self._cycle(_NEXT_NOW)
        trial_ledger = stub.get_trial_ledger()
        self.assertEqual(
            [row.event for row in self.ledger.rows],
            [trial_ledger.EVENT.POWER_PASS_COUNT] * 2,
        )


class LookTest(_ShadowFixture):
    """Looks of live trials only: accrual from the pre-registration, one row per reached milestone."""

    def test_each_reached_look_is_recorded_as_a_live_look_with_its_accrual_and_boundary(
        self,
    ) -> None:
        key = self._open_live_trial()
        self._cycle(_NOW)
        accrued = math.ceil(_MILESTONES[1])  # looks 1 and 2 reached, 3 not
        self.history += _get_spawns_after(_NOW, accrued)
        self._cycle(_NEXT_NOW)
        looks = self._get_looks()
        trial_ledger = stub.get_trial_ledger()
        boundaries = trial_design.get_boundaries()
        self.assertEqual([look.payload["look"] for look in looks], [1, 2])
        for look in looks:
            number = look.payload["look"]
            self.assertEqual(set(look.payload), _LOOK_KEYS)
            self.assertEqual(look.payload["accrued_tasks"], accrued)
            self.assertEqual(look.payload["boundary"], boundaries[number - 1])
            self.assertEqual(
                (look.event, look.actor, look.trial_key, look.dedupe_key),
                (
                    trial_ledger.EVENT.LIVE_LOOK,
                    trial_ledger.ACTOR.LIVE,
                    key,
                    f"{key}:look:{number}",
                ),
            )

    def test_a_task_started_before_the_preregistration_accrues_nothing(self) -> None:
        self.history += _get_spawns_after(
            _NOW - timedelta(hours=1), math.ceil(_MILESTONES[0])
        )
        self._open_live_trial()
        self._cycle(_NOW)
        self._cycle(_NEXT_NOW)
        self.assertEqual(self._get_looks(), [])

    def test_a_stored_pre_generation_row_never_counts_as_the_patterns_current_trial(
        self,
    ) -> None:
        # same pair, same UTC day: the shadow row holds the pair's own key and reached milestones
        self._open_live_trial(event=stub.get_trial_ledger().EVENT.SHADOW_PREREGISTRATION)
        self.history += _get_spawns_after(_NOW, math.ceil(_MILESTONES[1]))
        stored = list(self.ledger.rows)
        self._cycle(_NEXT_NOW)
        self.assertEqual(self._get_looks(), [])
        self.assertEqual(self._get_preregistrations(), stored[:1])

    def test_a_stored_live_preregistration_missing_looks_writes_no_look_and_warns_by_name(
        self,
    ) -> None:
        key = self._open_live_trial(missing=("looks",))
        self.history += _get_spawns_after(_NOW, math.ceil(_MILESTONES[1]))
        stderr = self._cycle(_NEXT_NOW)
        self.assertIn(
            f"WARN: shadow stage — trial {key}: stored pre-registration unusable: KeyError",
            stderr,
        )
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
                payload = dc.get_look_payload(
                    dc.Look(number, look), dc.LookAccrual(200, arms)
                )
                self.assertAlmostEqual(payload["z"], 3.5355339, places=6)
                self.assertEqual(payload["boundary"], boundary)
                self.assertEqual(set(payload), _LOOK_KEYS | {"arms", "z"})

    def test_two_arms_with_no_variance_record_no_z(self) -> None:
        arms = dc.TrialArms(
            control=dc.ArmCount(events=0, units=50),
            treatment=dc.ArmCount(events=0, units=50),
        )
        look = {"fraction": 0.25, "milestone": 25.0, "boundary": 4.0}
        payload = dc.get_look_payload(dc.Look(1, look), dc.LookAccrual(100, arms))
        self.assertIsNone(payload["z"])


class DuplicateTest(_ShadowFixture):
    def test_a_second_cycle_over_the_same_evidence_writes_no_duplicate_row(
        self,
    ) -> None:
        self._open_live_trial()
        self._cycle(_NOW)
        self.history += _get_spawns_after(_NOW, math.ceil(_MILESTONES[1]))
        self._cycle(_NEXT_NOW)
        written = list(self.ledger.rows)
        self._cycle(_NEXT_NOW)
        self.assertEqual(self.ledger.rows, written)
        events = {row.event for row in written}
        trial_ledger = stub.get_trial_ledger()
        self.assertEqual(
            events,
            {
                trial_ledger.EVENT.LIVE_PREREGISTRATION,
                trial_ledger.EVENT.LIVE_LOOK,
                trial_ledger.EVENT.POWER_PASS_COUNT,
            },
        )


class PowerPassCounterTest(_ShadowFixture):
    """The counter reuses the intake verdicts: one row per cycle date."""

    def _get_counters(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(stub.get_trial_ledger().EVENT.POWER_PASS_COUNT)

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
            ("an A/A row on the pattern's key → its value sizes the trial", _DESIGN_EFFECT, 1, 0),
        ]
        for name, design_effect, passing, unmeasured in rows:
            with self.subTest(name):
                self.ledger.rows.clear()
                self.ledger.design_effects.clear()
                if design_effect is not None:
                    self.ledger.design_effects[_AGENT] = _DESIGN_EFFECT_PAYLOAD
                self._cycle(_NOW)
                [counter] = self._get_counters()
                self.assertEqual(
                    (counter.payload["passing"], counter.payload["design-unmeasured"]),
                    (passing, unmeasured),
                )
                self.assertEqual(
                    [power_pass.design_effect for power_pass in self.power.passes],
                    [] if design_effect is None else [design_effect.value],
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
            self._open_live_trial()
            self.history += _get_spawns_after(_NOW, math.ceil(_MILESTONES[1]))
            self.ledger.faulted.add(dc.SHADOW.PREREGISTRATION_SQL)
            stderr_text = self._cycle(_NEXT_NOW)
            self.assertIn(
                "WARN: shadow stage — pre-registrations unreadable: ConnectionError",
                stderr_text,
            )
            self.assertEqual(self._get_looks(), [])


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
        """One ledger row for (agent, pattern_id, budget_overage), actor by event → its trial key."""
        key = hashlib.sha256(
            f"{agent}|{pattern_id}|{event}|{recorded_at.isoformat()}".encode()
        ).hexdigest()
        trial_ledger = stub.get_trial_ledger()
        actor = (trial_ledger.ACTOR.SHADOW, trial_ledger.ACTOR.LIVE)
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
                    actor[event.startswith("live-")],
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
        event = stub.get_trial_ledger().EVENT
        latest_at = _NOW - timedelta(days=1)
        latest = self._insert(latest_at, event.LIVE_PREREGISTRATION)
        # older yet inserted later · another pattern · an agent outside the passes · a later
        # live look · a later stored pre-generation row for the same pair
        self._insert(_NOW - timedelta(days=3), event.LIVE_PREREGISTRATION)
        other = self._insert(
            _NOW - timedelta(days=2),
            event.LIVE_PREREGISTRATION,
            pattern_id=_PATTERN_ID + 1,
        )
        self._insert(
            latest_at, event.LIVE_PREREGISTRATION, agent="glass-atrium-dev-shell"
        )
        self._insert(_NOW, event.LIVE_LOOK)
        self._insert(_NOW, event.SHADOW_PREREGISTRATION)
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

    def test_a_schema_without_the_ledger_warns_on_the_read_and_writes_no_look(
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
        self.assertEqual(self._get_looks(), [])
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


def get_guarded_pg_names() -> dict[str, frozenset[str]]:
    """Import-exception attribute → the names its guarded ``_pg_*`` import binds and its except branch does not."""
    tree = ast.parse(Path(dc.__file__).read_text(encoding="utf-8"))
    guarded: dict[str, frozenset[str]] = {}
    for node in tree.body:
        if not isinstance(node, ast.Try):
            continue
        bound = {
            alias.asname or alias.name
            for sub in itertools.chain.from_iterable(map(ast.walk, node.body))
            if isinstance(sub, ast.ImportFrom) and (sub.module or "").startswith("_pg_")
            for alias in sub.names
        }
        handled = [
            sub
            for handler in node.handlers
            for sub in itertools.chain.from_iterable(map(ast.walk, handler.body))
        ]
        stored = {
            sub.id
            for sub in handled
            if isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Store)
        }
        defined = {
            sub.name
            for sub in handled
            if isinstance(sub, (ast.FunctionDef, ast.ClassDef))
        }
        exc_names = [name for name in stored if name.endswith("_IMPORT_EXC")]
        if bound and len(exc_names) == 1:
            guarded[exc_names[0]] = frozenset(bound - stored - defined)
    return guarded


def degrade_pg_imports(testcase: unittest.TestCase) -> list[str]:
    """The psycopg-free install on any interpreter: each guarded import failed, its names unbound, then sealed."""
    for exc_name, names in get_guarded_pg_names().items():
        patcher = mock.patch.object(
            dc, exc_name, ImportError("No module named 'psycopg'")
        )
        patcher.start()
        testcase.addCleanup(patcher.stop)
        for name in names:
            if hasattr(dc, name):
                testcase.addCleanup(setattr, dc, name, getattr(dc, name))
                delattr(dc, name)
    return seal_pg_reach(testcase)


class DegradedImportTest(unittest.TestCase):
    """With the PG helper imports failed, every guarded name is unbound and each stage takes its precondition WARN."""

    _STAGE_WARN = (
        "WARN: shadow stage — trial ledger unwritable: PG helper import failed"
    )

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "agents").mkdir()
        env = mock.patch.dict(
            os.environ,
            {
                "GA_DATA_ROOT": str(self.root),
                "AUTOAGENT_REPORTS_DIR": str(self.root / "reports"),
            },
        )
        env.start()
        self.addCleanup(env.stop)
        self.pg_reach = degrade_pg_imports(self)
        set_install_tree(self)

    def test_both_guarded_imports_are_found_and_the_trial_ledger_is_unbound(
        self,
    ) -> None:
        guarded = get_guarded_pg_names()

        self.assertEqual(
            set(guarded), {"_PG_OUTCOME_IMPORT_EXC", "_PG_LOOP_IMPORT_EXC"}
        )
        self.assertIn("TRIAL_LEDGER", guarded["_PG_LOOP_IMPORT_EXC"])
        self.assertFalse(hasattr(dc, "TRIAL_LEDGER"))

    def test_the_stage_warns_by_name_and_reaches_no_ledger(self) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            power = dc.check_pattern_power([_pattern()], skip_loop_emit=True)
            dc.run_shadow_stage(power, "2026-10-05")

        self.assertIn(self._STAGE_WARN, stderr.getvalue())
        self.assertEqual(self.pg_reach, [])

    def test_a_writing_cycle_completes_through_every_stage_on_its_precondition_warn(
        self,
    ) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            dc.run_cycle(
                log_path=self.root / "learning-log.md",
                agents_dir=self.root / "agents",
                skip_haiku=True,
                skip_pre_verify=True,
                skip_loop_emit=False,
            )

        self.assertIn(self._STAGE_WARN, stderr.getvalue())
        self.assertEqual(self.pg_reach, [])


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
        set_install_tree(self)
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
        self.stderr = io.StringIO()
        with contextlib.redirect_stderr(self.stderr):
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

    def _open_writing_stages(self) -> None:
        def _refuse(*args: object, **kwargs: object) -> None:
            raise ConnectionRefusedError("corpus audit: no database in this test")

        self._patch("_pg_write_corpus_audit", _refuse)
        self._patch(
            "_pg_write_loop_event", lambda *args, **kwargs: True
        )  # census events: not under test

    def test_a_writing_cycle_counts_on_the_ledger_and_preregisters_nothing(self) -> None:
        self._open_writing_stages()
        self._run_cycle(skip_loop_emit=False)
        # other writing stages' statements are refused, not under test
        self.assertEqual(
            [
                statement
                for statement in self.ledger.refused
                if "autoagent_trial_ledger" in statement
            ],
            [],
        )
        trial_ledger = stub.get_trial_ledger()
        self.assertEqual(
            [row.event for row in self.ledger.rows],
            [trial_ledger.EVENT.POWER_PASS_COUNT],
        )

    def test_an_unusable_stored_live_preregistration_leaves_the_cycle_running_through_the_aa_stage(
        self,
    ) -> None:
        stages: list[str] = []
        shadow_stage = dc.run_shadow_stage
        self._patch(
            "run_shadow_stage",
            lambda *args: (shadow_stage(*args), stages.append("shadow")),
        )
        self._patch("run_aa_stage", lambda *args, **kwargs: stages.append("aa"))
        self._open_writing_stages()
        key = self._open_live_trial(missing=("looks",))
        self.history += _get_spawns_after(_NOW, math.ceil(_MILESTONES[1]))
        self.clock.now = _NEXT_NOW
        self._run_cycle(skip_loop_emit=False)
        self.assertIn(
            f"WARN: shadow stage — trial {key}: stored pre-registration unusable",
            self.stderr.getvalue(),
        )
        self.assertEqual(self._get_looks(), [])
        self.assertEqual(stages, ["shadow", "aa"])

if __name__ == "__main__":
    unittest.main()
