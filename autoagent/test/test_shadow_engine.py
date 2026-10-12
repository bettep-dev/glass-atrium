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
import dataclasses
import functools
import hashlib
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
from _outcome_signal import SpawnFacts, WindowStarts, get_pair_windows, is_floor_half
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
_KEYS = SimpleNamespace(
    LOOK={"look", "fraction", "milestone", "boundary", "accrued_tasks"},
    # the payload's top-level keys the cycle builds; readers: metric_key (the read), looks (looks)
    PREREGISTRATION={
        "metric_key",
        "detection_start",
        "baseline",
        "maximum_per_arm",
        "design_effect",
        "required_units",
        "boundaries",
        "looks",
        "task_window_seconds",
        # the proposal's generator-input stamp, so a ledger read tells input sets apart
        "generator_input_version",
        # stated, read by no stop yet: both samples, k and each harm check's margin, α and blind spot
        "samples",
        "guardrail_count",
        "harm_checks",
        # the trial stage's canary writer and the ingest binding read the text and its hash
        "canary",
        # an unstarted trial's void reads its horizon from the row
        "horizon_days",
        # stated, read by no stop yet: the re-delegation guardrail's window row
        "redelegation",
    },
    CANARY={"text", "text_sha256"},
    # the live start row's payload, written at the trial's first canary write
    START={"started_at", "text_sha256"},
    # the window row; stated, read by no stop: the count's rise reads margin and follow_ups
    REDELEGATION={
        "minutes",
        "tier",
        "gap_count",
        "margin",
        "follow_ups",
        "coverage",
        "baseline_window",
        "rise",
        "reference_rise",
        "stop_shift",
        "blind_spots",
    },
    REDELEGATION_INNER={
        "follow_ups": {"n", "mean", "sd"},
        "coverage": {"start", "days", "span_days"},
        "baseline_window": {"start", "end"},
        "rise": {"unit", "design_effect_1", "design_effect_2", "labels"},
        "reference_rise": {"unit", "margin_multiples", "mean_count_percent", "read_date", "labels"},
        "stop_shift": {
            "unit",
            "metric_key",
            "false_stop_percent",
            "above_alpha_cell_percent",
            "above_alpha_cell_interval_percent",
            "read_date",
            "labels",
        },
    },
)
# the reference install's five deciding agents; a reference row names none of them
_DECIDING_AGENTS = (
    "qa-code-reviewer",
    "dev-shell",
    "dev-react",
    "dev-nestjs",
    "meta-prompt-engineer",
)
# the fixture history stops no spawn → no overran gap → the rule's default window
_DEFAULT_WINDOW_ROW = {"minutes": 60, "tier": "default", "gap_count": 0}
_WINDOWS = get_pair_windows(_NOW)
# the fixture spawn read's provenance start, inside the baseline window
_PROVENANCE_START = _DAY - timedelta(days=60)
_POOL_AGENT = "glass-atrium-dev-node"  # a roster type no keyed pattern names
_ROSTER_WARN = "WARN: re-delegation window — roster spawns unreadable"
# the generator's patch in the fixture; its added line is the canary text a bound trial delivers
_PROBE_DIFF = "--- a\n+++ b\n@@ -1 +1,2 @@\n # probe agent\n+- probe rule\n"
# A/A design-effect rows beside the primary key's: the leg's own, and a pre-split union-event row
_GUARDRAIL_ROWS = SimpleNamespace(
    NO_STOP={"metric_key": "no_subagent_stop", **_DESIGN_EFFECT._replace(value=1.4)._asdict()},
    UNION={"metric_key": "emit_failure", **_DESIGN_EFFECT._replace(value=1.6)._asdict()},
)
_PROXY_LABEL = "proxy — union definition, not used for sizing or stopping"
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


def _get_inputs(power: dc.PowerResult) -> dc.PreregistrationInputs:
    """The fixture's per-candidate inputs: its detection start, probe canary and history row."""
    return dc.PreregistrationInputs(
        power.windows.start.detection,
        dc.get_canary_text(_PROBE_DIFF),
        _get_history_row(power.windows.start),
    )


def _get_history_row(start: WindowStarts) -> dict:
    """The fixture history's window row: default W, no counted spawn, covered from P."""
    return {
        **_DEFAULT_WINDOW_ROW,
        "margin": trial_design.DEFAULT_RELATIVE_REDUCTION * (_BASELINE.EVENTS / _BASELINE.SPAWNS),
        "follow_ups": {"n": 0, "mean": None, "sd": None},
        "coverage": {
            "start": _PROVENANCE_START.isoformat(),
            "days": (start.detection - _PROVENANCE_START) / timedelta(days=1),
            "span_days": 84,
        },
        "baseline_window": {
            "start": start.baseline.isoformat(),
            "end": start.detection.isoformat(),
        },
        **dc.get_reference_rows(),
        "blind_spots": list(dc.REDELEGATION_ROW.BLIND_SPOTS),
    }


def _get_named_agents(row: dict) -> list[str]:
    """The deciding agents a row's text names."""
    text = json.dumps(row)
    return [agent for agent in _DECIDING_AGENTS if agent in text]


_MINUTE = timedelta(minutes=1)


def _get_overran_pair(
    started_at: datetime, gap: timedelta, session: str, *, stopped_at: datetime | None = None
) -> list[SpawnFacts]:
    """An overran spawn and its session's next start `gap` after its stop (default: an hour on)."""
    stop = stopped_at or started_at + timedelta(hours=1)
    return [
        SpawnFacts(f"{session}-a", session, started_at, 1, True, (), stopped_at=stop),
        SpawnFacts(
            f"{session}-b", session, stop + gap, 0, True, (), stopped_at=stop + gap + _MINUTE
        ),
    ]


def _get_gap_spawns(session: str, minutes: range) -> list[SpawnFacts]:
    """One overran provenance-covered baseline spawn per gap length, each in its own session."""
    return [
        spawn
        for index, gap in enumerate(minutes)
        for spawn in _get_overran_pair(
            _PROVENANCE_START + timedelta(hours=index + 1),
            gap * _MINUTE,
            f"{session}-{index}",
        )
    ]


def _get_late_next_start(session: str) -> tuple[list[SpawnFacts], SpawnFacts]:
    """A baseline spawn stopped a minute before D, and a spawn at D one minute later in its session.

    The later spawn is the next start inside the earlier one's W, so only the cut keeps it out."""
    baseline_spawn, _ = _get_overran_pair(
        _WINDOWS.start.detection - timedelta(hours=1),
        _MINUTE,
        session,
        stopped_at=_WINDOWS.end - _MINUTE,
    )
    return [baseline_spawn], SpawnFacts(f"{session}-d", session, _WINDOWS.end, 0, True, ())


def _get_member(session: str, *, is_stopped: bool = True) -> SpawnFacts:
    """A floor-half baseline spawn five days before the detection start, stopped an hour on."""
    started_at = _WINDOWS.start.detection - timedelta(days=5)
    stopped_at = started_at + timedelta(hours=1) if is_stopped else None
    return SpawnFacts(next(_IDS.FLOOR), session, started_at, 0, True, (), stopped_at=stopped_at)


def _get_follow_up(prior: SpawnFacts, minutes: int, *, is_floor: bool = False) -> SpawnFacts:
    """A same-session spawn `minutes` after `prior`'s stop, never stopped itself."""
    agent_id = next(_IDS.FLOOR if is_floor else _IDS.REFERENCE)
    return SpawnFacts(agent_id, prior.session_id, prior.stopped_at + minutes * _MINUTE, 0, True, ())


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
        # further passed A/A rows per agent, beside the primary key's
        self.guardrail_rows: list[tuple[str, dict]] = []
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

    def read_open_trials(self) -> dict[str, list[int]]:
        """Agent → proposal ids of its live pre-registrations with no :decision row."""
        keys = {row.dedupe_key for row in self.rows}
        open_trials: dict[str, list[int]] = {}
        for row in self.get_rows(stub.get_trial_ledger().EVENT.LIVE_PREREGISTRATION):
            if f"{row.trial_key}:decision" not in keys:
                open_trials.setdefault(row.agent, []).append(row.payload["proposal_id"])
        return open_trials


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
            ] + [row for row in self.ledger.guardrail_rows if row[0] in agents]
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
        elif statement == dc.LIVE_TRIAL.CANARY_SQL:
            self.result = [
                (
                    row.id,
                    row.agent,
                    row.trial_key,
                    row.learning_pattern_id,
                    row.payload,
                    row.recorded_at,
                    is_started,
                )
                for row, is_started in self._get_open_trials(params)
            ]
        else:
            self.ledger.refused.append(statement)
            raise AssertionError(f"statement outside the ledger fake: {statement[:80]}")

    def _get_open_trials(self, params: tuple) -> list[tuple[_LedgerRow, bool]]:
        """Each open live pre-registration in id order; True = its :start row landed."""
        (event,) = params
        keys = {row.dedupe_key for row in self.ledger.rows}
        return [
            (row, f"{row.trial_key}:start" in keys)
            for row in self.ledger.rows
            if row.event == event and f"{row.trial_key}:decision" not in keys
        ]

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
        # the roster read at its DB seam: spawns by MANIFEST type; None → the history, every name
        # answered from the asked start; to the asked end unless is_end_honoured is off
        # names: the names the last read asked for
        self.roster = SimpleNamespace(spawns=None, is_faulted=False, is_end_honoured=True, names=[])
        self.stages: list[str] = []
        # after the seal: spawn read, ledger connection and writer = the DB boundary
        for name, value in (
            ("HAS_PG_PATTERN_READ", True),
            ("_pg_read_spawn_facts", self._read_spawn_facts),
            ("HAS_PG_LOOP_WRITE", True),
            ("_pg_connect", self.ledger.connect),
            ("_pg_write_trial_ledger_row", self.ledger.write),
            ("_pg_read_open_trials", self.ledger.read_open_trials),
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
        # the roster read asks from one instant: baseline, detection and confirmation starts equal
        if windows.start.baseline == windows.start.detection:
            self.stages.append("roster read")
            self.roster.names = list(agents)
            if self.roster.is_faulted:
                raise ConnectionRefusedError("spawn read: no database in this test")
            if self.roster.spawns is not None:
                return None, {
                    name: [
                        spawn
                        for spawn in spawns
                        if windows.start.baseline <= spawn.started_at
                        and (spawn.started_at < windows.end or not self.roster.is_end_honoured)
                    ]
                    for name, spawns in self.roster.spawns.items()
                }
        return _PROVENANCE_START, {agent: list(self.history) for agent in agents}

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
        payload = dc.get_preregistration_payload(power_pass, _get_inputs(power))
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
        self.diff = _PROBE_DIFF
        self.stderr = io.StringIO()
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
            target_file=str(self.agents_dir / f"{agent}.md"),
            rationale="probe rationale",
            proposed_diff=self.diff,
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
        verdict: dc.PreVerifyResult | None = None,
        *,
        safety: str = "non-safety",
        area: str = "body-auto",
        skip_loop_emit: bool = False,
    ) -> dc.PatchResult:
        """The generation unit over the pattern; generator and pre-verify faked at their call."""
        if verdict is None:
            verdict = dc.PreVerifyResult(True, "ok", {}, "ok", 0)
        self.stderr = io.StringIO()
        with contextlib.ExitStack() as stack:
            stack.enter_context(contextlib.redirect_stderr(self.stderr))
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
                preregistration=None if power is None else self._get_source(power),
            )
        self.assertEqual(self.pg_reach, [])
        return result

    def _get_source(self, power: dc.PowerResult) -> dc.PreregistrationSource:
        read = dc.RosterSpawnRead(self.agents_dir, power.windows, dc.get_tool_budget({}))
        return dc.PreregistrationSource(power, read)

    def test_the_bound_payload_freezes_the_trial_design_boundaries_maximum_and_look_milestones(
        self,
    ) -> None:
        power = self._check_power()
        [power_pass] = power.passes
        result = self._build(power)
        payload = result.preregistration_payload
        self.assertEqual(
            payload,
            dc.get_preregistration_payload(power_pass, _get_inputs(power)),
        )
        self.assertEqual(set(payload), _KEYS.PREREGISTRATION)
        self.assertEqual(set(payload["canary"]), _KEYS.CANARY)
        self.assertEqual(payload["boundaries"], list(trial_design.get_boundaries()))
        self.assertEqual(payload["maximum_per_arm"], _MAXIMUM)
        self.assertEqual(payload["design_effect"], _DESIGN_EFFECT.value)
        self.assertEqual([look["milestone"] for look in payload["looks"]], _MILESTONES)
        self.assertEqual((result.approval_tier, result.status), ("auto", "pending"))

    def test_the_bound_payload_states_the_trials_horizon_in_days(self) -> None:
        payload = self._build(self._check_power()).preregistration_payload
        self.assertEqual(payload["horizon_days"], trial_design.HORIZON_DAYS)
        self.assertEqual(payload["horizon_days"], 84)

    def test_the_canary_text_is_the_patchs_added_lines_beside_the_sha256_of_exactly_that_text(
        self,
    ) -> None:
        rows = [
            ("one added line", _PROBE_DIFF, "- probe rule\n"),
            (
                "two hunks: added lines in diff order, context lines left out",
                (
                    "--- a\n+++ b\n@@ -1,2 +1,3 @@\n # probe agent\n intro\n+- first rule\n"
                    "@@ -9 +10,2 @@\n tail\n+- second rule\n"
                ),
                "- first rule\n- second rule\n",
            ),
        ]
        for name, diff, text in rows:
            with self.subTest(name):
                self.ledger.rows.clear()
                self.diff = diff
                canary = self._build(self._check_power()).preregistration_payload["canary"]
                self.assertEqual(canary["text"], text)
                self.assertEqual(
                    canary["text_sha256"],
                    hashlib.sha256(canary["text"].encode("utf-8")).hexdigest(),
                )

    def test_a_candidate_whose_rendered_block_exceeds_1200_bytes_is_refused_never_truncated(
        self,
    ) -> None:
        # the rendered block is the added line plus its newline; the cap counts bytes
        rows = [
            ("exactly 1200 bytes → bound", "x" * 1199, True),
            ("1201 bytes → refused", "x" * 1200, False),
            ("1204 bytes in 402 characters → refused", "가" * 401, False),
        ]
        for name, added, is_bound in rows:
            with self.subTest(name):
                self.ledger.rows.clear()
                self.diff = f"--- a\n+++ b\n@@ -1 +1,2 @@\n # probe agent\n+{added}\n"
                result = self._build(self._check_power())
                if is_bound:
                    self.assertEqual(result.preregistration_payload["canary"]["text"], f"{added}\n")
                    self.assertEqual((result.approval_tier, result.status), ("auto", "pending"))
                    self.assertNotIn("1200 B cap", self.stderr.getvalue())
                    continue
                self.assertIsNone(result.preregistration_payload)
                self.assertNotEqual((result.approval_tier, result.status), ("auto", "pending"))
                self.assertIn("1200 B cap", self.stderr.getvalue())

    def test_a_candidate_whose_diff_removes_a_line_or_adds_none_is_refused_as_untrialable(
        self,
    ) -> None:
        # injection can only add; an empty block is the A/A's own text
        rows = [
            (
                "a removed line beside an added one",
                "--- a\n+++ b\n@@ -1,2 +1,2 @@\n # probe agent\n-- old rule\n+- new rule\n",
                "the diff removes a line",
            ),
            (
                "no added line",
                "--- a\n+++ b\n@@ -1 +1 @@\n # probe agent\n",
                "the diff adds no line",
            ),
        ]
        for name, diff, reason in rows:
            with self.subTest(name):
                self.ledger.rows.clear()
                self.diff = diff
                result = self._build(self._check_power())
                self.assertIsNone(result.preregistration_payload)
                self.assertNotEqual((result.approval_tier, result.status), ("auto", "pending"))
                self.assertIn(f"live trial refused — agent={_AGENT}", self.stderr.getvalue())
                self.assertIn(reason, self.stderr.getvalue())

    def test_the_bound_payload_carries_the_generator_input_version_its_proposal_is_stamped_with(
        self,
    ) -> None:
        result = self._build(self._check_power())
        self.assertEqual(
            result.preregistration_payload["generator_input_version"],
            result.generator_input_version,
        )

    def test_a_candidate_the_cycle_did_not_bind_carries_no_payload_and_never_stays_pending_auto(
        self,
    ) -> None:
        power = self._check_power()
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
            ("no power result", {"power": None}),
        )
        for name, arguments in rows:
            with self.subTest(name):
                result = self._build(**arguments)
                self.assertIsNone(result.preregistration_payload)
                self.assertNotEqual((result.approval_tier, result.status), ("auto", "pending"))

    def test_a_candidate_is_sized_only_on_its_own_lead_patterns_power_pass(self) -> None:
        power = self._check_power()
        [lead_pass] = power.passes
        lead, baseline = lead_pass.pattern, lead_pass.baseline
        lead_payload = dc.get_preregistration_payload(lead_pass, _get_inputs(power))
        other_key = next(key for key in sorted(dc.METRIC_KEYS) if key != _BUDGET_KEY)
        # each other pattern's pass on its own baseline, so binding it changes the payload
        other_passes = (
            ("another agent", dataclasses.replace(lead, agent="glass-atrium-dev-node")),
            ("the agent's other pattern", dataclasses.replace(lead, row_id=_PATTERN_ID + 1)),
            ("the pattern on another metric key", dataclasses.replace(lead, metric_key=other_key)),
        )
        for offset, (owner, pattern) in enumerate(other_passes, start=1):
            other_pass = lead_pass._replace(
                pattern=pattern, baseline=baseline._replace(events=baseline.events + offset)
            )
            self.assertNotEqual(
                dc.get_preregistration_payload(other_pass, _get_inputs(power)),
                lead_payload,
            )
            # the other pass listed first: a check binding the first pass binds the wrong one
            rows = (
                (f"{owner}'s pass beside the lead pass", [other_pass, lead_pass], lead_payload),
                (f"only {owner}'s pass", [other_pass], None),
            )
            for name, passes, expected in rows:
                with self.subTest(name):
                    result = self._build(dc.PowerResult(power.counts, passes, power.windows))
                    self.assertEqual(result.preregistration_payload, expected)
                    self.assertEqual(
                        (result.approval_tier, result.status) == ("auto", "pending"),
                        expected is not None,
                    )

    def _get_window_row(self, spawns: dict[str, list[SpawnFacts]]) -> dict:
        """The bound payload's window row when the roster read answers `spawns`."""
        for stem in (_AGENT, _POOL_AGENT):
            (self.agents_dir / f"{stem}.md").write_text("# probe agent\n", encoding="utf-8")
        self.roster.spawns = spawns
        return self._build(self._check_power()).preregistration_payload["redelegation"]

    def _get_window(self, spawns: dict[str, list[SpawnFacts]]) -> dict:
        """The window row's W, tier and gap count alone."""
        row = self._get_window_row(spawns)
        return {key: row[key] for key in _DEFAULT_WINDOW_ROW}

    def test_the_window_row_is_the_rules_window_tier_and_gap_count_over_the_baseline_window_alone(
        self,
    ) -> None:
        # an overran spawn in the detection window would add a 500-minute gap if counted
        detection_gap = _get_overran_pair(
            _WINDOWS.start.detection + timedelta(hours=1), 500 * _MINUTE, "detection"
        )
        rows = (
            ("100 own gaps → own tier", range(1, 101)),
            ("99 own gaps and no pool → the default window", range(1, 100)),
        )
        for name, minutes in rows:
            with self.subTest(name):
                gaps = [float(gap) for gap in minutes]
                window = self._get_window({_AGENT: _get_gap_spawns("own", minutes) + detection_gap})
                self.assertEqual(window, dc.get_redelegation_window(gaps, gaps)._asdict())

    def test_a_baseline_spawns_next_start_after_the_baseline_end_and_before_d_counts_its_gap(
        self,
    ) -> None:
        # stopped an hour before the baseline end, its next start an hour after it, before D
        late_gap = _get_overran_pair(
            _WINDOWS.start.detection - timedelta(hours=2), 120 * _MINUTE, "late-gap"
        )
        gaps = [*map(float, range(1, 100)), 120.0]
        window = self._get_window({_AGENT: _get_gap_spawns("own", range(1, 100)) + late_gap})
        self.assertEqual(window, dc.get_redelegation_window(gaps, gaps)._asdict())
        self.assertEqual((window["tier"], window["gap_count"]), ("own", 100))

    def test_a_spawn_at_or_after_d_never_moves_an_own_tier_window(self) -> None:
        baseline_spawn, late_spawn = _get_late_next_start("own-late")
        self.roster.is_end_honoured = False  # the at-D spawn reaches the cut
        # a floor-half member stopped a minute before D: its W is still open at D, so n leaves it out
        open_member = baseline_spawn[0]._replace(agent_id=next(_IDS.FLOOR))
        member = _get_member("own-member")
        self.history.extend([member, open_member])
        own_spawns = [
            *_get_gap_spawns("own", range(1, 101)),
            open_member,
            member,
            # own gaps 1..100 → W = 91: past the default 60 → counted; at W → not
            *(_get_follow_up(member, minutes) for minutes in (10, 90, 91)),
        ]
        row = self._get_window_row({_AGENT: own_spawns})
        late_row = self._get_window_row({_AGENT: [*own_spawns, late_spawn]})
        self.assertEqual((row["tier"], row["minutes"]), ("own", 91))
        self.assertEqual(row["follow_ups"], {"n": 1, "mean": 2.0, "sd": None})
        self.assertEqual(late_row, row)

    def test_a_spawn_at_or_after_d_never_moves_a_pooled_tier_window(self) -> None:
        baseline_spawn, late_spawn = _get_late_next_start("pool-late")
        self.roster.is_end_honoured = False  # the at-D spawn reaches the cut
        # stopped after the detection start, its W closed before D → counted at D alone
        member = _get_member("pool-member")._replace(
            started_at=_WINDOWS.start.detection - timedelta(hours=1),
            stopped_at=_WINDOWS.start.detection + timedelta(hours=1),
        )
        self.history.append(member)
        own_spawns = [*_get_gap_spawns("own", range(1, 11)), member, _get_follow_up(member, 10)]
        pool = _get_gap_spawns("pool", range(100, 190)) + baseline_spawn
        row = self._get_window_row({_AGENT: own_spawns, _POOL_AGENT: pool})
        late_row = self._get_window_row({_AGENT: own_spawns, _POOL_AGENT: [*pool, late_spawn]})
        self.assertEqual(row["tier"], "pooled")
        self.assertEqual(row["follow_ups"], {"n": 1, "mean": 1.0, "sd": None})
        self.assertEqual(late_row, row)

    def test_an_agent_under_100_own_gaps_takes_w_from_a_roster_type_no_keyed_pattern_names(
        self,
    ) -> None:
        own_minutes, pool_minutes = range(1, 11), range(100, 190)
        row = self._get_window_row(
            {
                _AGENT: _get_gap_spawns("own", own_minutes),
                _POOL_AGENT: _get_gap_spawns("pool", pool_minutes),
            }
        )
        pooled = [float(gap) for gap in (*own_minutes, *pool_minutes)]
        self.assertEqual(row["tier"], "pooled")
        self.assertEqual(row["gap_count"], 100)
        self.assertEqual(row["minutes"], dc.get_redelegation_window([], pooled).minutes)

    def test_one_stems_bare_and_prefixed_manifest_rows_form_one_type(self) -> None:
        # each overran spawn under the bare name, its next start under the prefixed one
        pairs = _get_gap_spawns("pool", range(100, 190))
        bare = _POOL_AGENT.removeprefix(dc.ROSTER.STEM_PREFIX)
        row = self._get_window_row(
            {
                _AGENT: _get_gap_spawns("own", range(1, 11)),
                bare: pairs[0::2],
                _POOL_AGENT: pairs[1::2],
            }
        )
        self.assertLessEqual({bare, _POOL_AGENT}, set(self.roster.names))
        self.assertEqual((row["tier"], row["gap_count"]), ("pooled", 100))

    def test_a_non_roster_types_gaps_never_enter_the_pool(self) -> None:
        window = self._get_window(
            {
                _AGENT: _get_gap_spawns("own", range(1, 11)),
                "glass-atrium-retired-agent": _get_gap_spawns("retired", range(100, 190)),
            }
        )
        self.assertEqual(window, _DEFAULT_WINDOW_ROW | {"gap_count": 10})

    def _get_row(self, roster_spawns: list[SpawnFacts], **changes: object) -> dict:
        """The window row over the agent's `roster_spawns`, power pass fields replaced."""
        [power_pass] = self._check_power().passes
        roster = dc.RosterSpawns({_AGENT: roster_spawns}, dc.get_tool_budget({}))
        return dc.get_redelegation_row(roster, power_pass._replace(**changes), _WINDOWS)

    def test_the_row_states_the_margin_as_30_percent_of_the_primary_rate_beside_its_blind_spots(
        self,
    ) -> None:
        [power_pass] = self._check_power().passes
        # the recorded 0.019, 0.050 and 0.056 follow-ups per spawn at three spawn baselines
        rows = (("a 6.2% primary rate", 62, 0.019), ("16.6%", 166, 0.050), ("18.5%", 185, 0.056))
        for name, events, margin in rows:
            with self.subTest(name):
                baseline = power_pass.baseline._replace(events=events, spawns=1000)
                self.assertEqual(round(self._get_row([], baseline=baseline)["margin"], 3), margin)
        blind_spots = self._get_row([])["blind_spots"]
        [watch] = [text for text in blind_spots if text.startswith("watch")]
        self.assertIn("separation is shorter than the design's", watch)
        self.assertIn("a lower bound, not a pass", watch)
        self.assertEqual([text for text in blind_spots if "glass-atrium-" in text], [])

    def test_the_follow_up_statistics_cover_the_floor_half_members_counted_at_w_alone(
        self,
    ) -> None:
        counted, idle = _get_member("stats-counted"), _get_member("stats-idle")
        unstopped = _get_member("stats-unstopped", is_stopped=False)
        # two follow-ups from the reference half; the first stopped, so the count admits it too
        first = _get_follow_up(counted, 10)
        follow_ups = [
            first._replace(stopped_at=first.started_at + _MINUTE),
            _get_follow_up(counted, 20),
        ]
        roster = [counted, *follow_ups, idle, unstopped]
        rows = (
            (
                "two counted members, the unstopped one out of n",
                [counted, idle, unstopped],
                {"n": 2, "mean": 1.0, "sd": math.sqrt(2)},
            ),
            ("one counted member → no sd", [counted, unstopped], {"n": 1, "mean": 2.0, "sd": None}),
            ("no counted member → no mean", [unstopped], {"n": 0, "mean": None, "sd": None}),
        )
        for name, members, statistics in rows:
            with self.subTest(name):
                row = self._get_row(roster, spawns=[*members, *follow_ups])
                self.assertEqual(row["follow_ups"], statistics)

    def test_a_non_zero_guardrail_w_counts_follow_ups_and_leaves_the_floor_per_spawn(self) -> None:
        # the first two non-event floor-half baseline spawns → a stopped spawn and its follow-up
        index = _BASELINE.EVENTS
        prior, later = self.history[index : index + 2]
        member = prior._replace(session_id="non-zero-w", stopped_at=prior.started_at + _MINUTE)
        follow_up = later._replace(
            session_id="non-zero-w", started_at=member.stopped_at + 10 * _MINUTE
        )
        self.history[index : index + 2] = [member, follow_up]
        self.roster.spawns = {_AGENT: [member, follow_up]}
        payload = self._build(self._check_power()).preregistration_payload
        row = payload["redelegation"]
        self.assertEqual(row["minutes"], 60)
        self.assertEqual(row["follow_ups"], {"n": 1, "mean": 1.0, "sd": None})
        # both as one task at W → 199; redelegation_window 0 → one unit per spawn
        self.assertEqual(payload["baseline"]["spawns"], _BASELINE.SPAWNS)

    def test_the_gap_window_opens_at_the_covered_start_stated_beside_the_baseline_window(
        self,
    ) -> None:
        # an overran spawn before the provenance start, its next start before it too
        early_gap = _get_overran_pair(
            _WINDOWS.start.baseline + timedelta(hours=1), 30 * _MINUTE, "pre-provenance"
        )
        gap_counts = [
            len(
                dc.get_overran_gaps(
                    {_AGENT: early_gap},
                    dc.Window(start, _WINDOWS.start.detection),
                    tool_budget=dc.get_tool_budget({}),
                )[_AGENT]
            )
            for start in (_WINDOWS.start.baseline, _PROVENANCE_START)
        ]
        self.assertEqual(gap_counts, [1, 0])
        own_spawns = _get_gap_spawns("own", range(1, 11))
        window = self._get_window({_AGENT: own_spawns})
        row = self._get_window_row({_AGENT: [*own_spawns, *early_gap]})
        self.assertEqual({key: row[key] for key in _DEFAULT_WINDOW_ROW}, window)
        self.assertEqual(
            row["coverage"],
            {"start": _PROVENANCE_START.isoformat(), "days": 46.0, "span_days": 84},
        )
        self.assertLess(row["coverage"]["days"], 84)
        self.assertEqual(
            row["baseline_window"],
            {
                "start": _WINDOWS.start.baseline.isoformat(),
                "end": _WINDOWS.start.detection.isoformat(),
            },
        )

    def test_the_window_row_states_exactly_its_keys_and_inner_keys(self) -> None:
        row = self._get_window_row({_AGENT: _get_gap_spawns("own", range(1, 11))})
        self.assertEqual(set(row), _KEYS.REDELEGATION)
        self.assertEqual(
            {name: set(row[name]) for name in _KEYS.REDELEGATION_INNER}, _KEYS.REDELEGATION_INNER
        )

    def _get_payload(self, row: dict, **changes: object) -> dict:
        """The bound payload built over the window row `row`, power pass fields replaced."""
        [power_pass] = self._check_power().passes
        inputs = dc.PreregistrationInputs(
            _WINDOWS.start.detection, dc.get_canary_text(_PROBE_DIFF), row
        )
        return dc.get_preregistration_payload(power_pass._replace(**changes), inputs)

    def test_the_counts_rise_is_the_upward_mean_shift_of_the_rows_sd_at_the_trials_maximum(
        self,
    ) -> None:
        follow_ups = {"n": 2, "mean": 1.0, "sd": math.sqrt(2)}
        payload = self._get_payload(_get_history_row(_WINDOWS.start) | {"follow_ups": follow_ups})
        self.assertEqual(payload["maximum_per_arm"], _MAXIMUM)
        rise = payload["redelegation"]["rise"]
        for design_effect in (1, 2):
            with self.subTest(f"design effect {design_effect}"):
                self.assertEqual(
                    rise[f"design_effect_{design_effect}"],
                    trial_design.get_follow_up_harm(
                        math.sqrt(2), _MAXIMUM, design_effect=design_effect
                    ),
                )
        self.assertEqual(rise["unit"], "follow-ups per spawn")
        [unmeasured] = [label for label in rise["labels"] if label.startswith("unmeasured")]
        self.assertIn("design effect 1 and 2", unmeasured)
        model_based = [label for label in rise["labels"] if label.startswith("model-based")]
        self.assertEqual(len(model_based), 1)

    def test_the_reference_rise_is_a_dated_four_look_snapshot_the_rise_is_not_bounded_by(
        self,
    ) -> None:
        reference = self._get_row([])["reference_rise"]
        self.assertEqual(reference["margin_multiples"], [11, 26, 36])
        self.assertEqual(reference["mean_count_percent"], [9, 19])
        self.assertEqual(reference["read_date"], "2026-10-10")
        labels = (
            "on four looks",
            "the reference install's, not the install's own",
            "measured on budget_overage trials",
            "on the calibration span's units",
            "two of five deciding agents read through look 2 only",
        )
        for label in labels:
            with self.subTest(label):
                self.assertIn(label, reference["labels"])
        self.assertEqual(_get_named_agents(reference), [])
        rise = self._get_payload(_get_history_row(_WINDOWS.start))["redelegation"]["rise"]
        bound = "does not bound the randomization test's rise"
        self.assertEqual(len([label for label in rise["labels"] if label.startswith(bound)]), 1)

    def test_the_stop_shift_is_the_reference_installs_dated_budget_overage_false_stop_share(
        self,
    ) -> None:
        stop_shift = self._get_row([])["stop_shift"]
        self.assertEqual(stop_shift["false_stop_percent"], [3.55, 7.50])
        self.assertEqual(stop_shift["above_alpha_cell_percent"], 7.50)
        self.assertEqual(stop_shift["above_alpha_cell_interval_percent"], [6.38, 8.74])
        self.assertEqual(stop_shift["metric_key"], _BUDGET_KEY)
        self.assertEqual(stop_shift["read_date"], "2026-10-10")
        [install] = [label for label in stop_shift["labels"] if "install" in label]
        self.assertIn("not the install's own", install)
        self.assertIn("no install measures its own", install)
        [metric_key] = [label for label in stop_shift["labels"] if _BUDGET_KEY in label]
        self.assertIn("another primary key carries these values labelled as that key's", metric_key)
        for label in (
            "the two shapes are assumptions",
            "two of five deciding agents read through look 2 only",
        ):
            with self.subTest(label):
                self.assertEqual(
                    len([text for text in stop_shift["labels"] if text.startswith(label)]), 1
                )
        # the range is a four-look share, and each end names the shape of a win it assumes
        for wording in (
            "the four-look false-stop share across the three agents read on four looks",
            "7.50 [6.38, 8.74] under a uniform shortening of a win",
            "3.55 under a concentrated one",
        ):
            with self.subTest(wording):
                self.assertEqual(
                    len([text for text in stop_shift["labels"] if wording in text]), 1
                )
        self.assertEqual(_get_named_agents(stop_shift), [])

    def test_the_counts_rise_is_none_at_both_design_effects_and_the_payload_builds_at_sd_none_or_0(
        self,
    ) -> None:
        lone, first, second = (_get_member(f"rise-{name}") for name in ("lone", "first", "second"))
        rows = (
            ("sd None — one counted spawn", [lone, _get_follow_up(lone, 10)], [lone], None),
            (
                "sd 0 — two counted spawns with the same follow-up count",
                [first, _get_follow_up(first, 10), second, _get_follow_up(second, 10)],
                [first, second],
                0.0,
            ),
        )
        for name, roster_spawns, members, sd in rows:
            with self.subTest(name):
                row = self._get_row(roster_spawns, spawns=members)
                self.assertEqual(row["follow_ups"]["sd"], sd)
                payload = self._get_payload(row, spawns=members)
                rise = payload["redelegation"]["rise"]
                self.assertEqual((rise["design_effect_1"], rise["design_effect_2"]), (None, None))
                self.assertEqual(
                    len([label for label in rise["labels"] if label.startswith("unmeasured")]), 1
                )
                self.assertTrue(json.dumps(payload, allow_nan=False))

    def test_the_roster_is_read_once_per_cycle_and_only_when_a_candidate_reaches_preregistration(
        self,
    ) -> None:
        power = self._check_power()
        [lead_pass] = power.passes
        other = dataclasses.replace(lead_pass.pattern, agent=_POOL_AGENT)
        (self.agents_dir / f"{_POOL_AGENT}.md").write_text("# probe agent\n", encoding="utf-8")
        passes = [lead_pass, lead_pass._replace(pattern=other)]
        groups = [(_AGENT, list(self.patterns)), (_POOL_AGENT, [other])]
        rows = (
            ("both candidates safety-routed: none reaches it → no read", "safety", 0, 0),
            ("two candidates reach it → one read", "non-safety", 1, 2),
        )
        for name, safety, reads, bound in rows:
            with self.subTest(name):
                self.stages.clear()
                report = SimpleNamespace(patches=[], cycle_date=f"{_NOW:%Y-%m-%d}")
                verified = dc.PreVerifyResult(True, "ok", {}, "ok", 0)
                with contextlib.ExitStack() as stack:
                    stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                    seams = self._seams(verified, safety=safety, area="body-auto")
                    for seam, value in seams.items():
                        stack.enter_context(mock.patch.object(dc, seam, value))
                    dc._run_generation_loop(
                        report,
                        groups,
                        dc.GenerationRun(
                            regression_gate=object(),
                            agents_dir=self.agents_dir,
                            skip_haiku=False,
                            skip_pre_verify=False,
                            skip_loop_emit=False,
                            power=dc.PowerResult(power.counts, passes, power.windows),
                        ),
                    )
                self.assertEqual(self.stages.count("roster read"), reads)
                self.assertEqual(
                    sum(p.preregistration_payload is not None for p in report.patches), bound
                )
                self.assertEqual(self.pg_reach, [])

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
            self.assertEqual(set(look.payload), _KEYS.LOOK)
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
                self.assertEqual(set(payload), _KEYS.LOOK | {"arms", "z"})

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
    """The live pre-registration reads' real SQL on the ephemeral cluster; skips anywhere else.

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

    def _insert_proposal(self, cycle_date: str, *, status: str = "applied", agent: str = _AGENT) -> int:
        """One proposal row whose added line names its own label → its id."""
        label = f"{agent} {status} {cycle_date} {uuid.uuid4().hex[:6]}"
        with self._connect() as conn:
            return conn.execute(
                "INSERT INTO core.autoagent_proposals (cycle_date, pattern_label, target_file,"
                " target_agent, classification, rationale, approval_tier, status, proposed_diff,"
                " source_file, source_file_mtime) VALUES (%s, %s, %s, %s, 'apply', 'r', 'auto',"
                " %s, %s, 'autoagent.json', 0) RETURNING id",
                (cycle_date, label, f"agents/{agent}.md", agent, status, f"+- {label}\n"),
            ).fetchone()[0]

    def _insert_trial_row(self, proposal_id: int, event: str, payload: dict, *, suffix: str = "") -> int:
        """A live trial row keyed by the proposal id as the push keys it → its id."""
        key = f"{proposal_id:064x}"
        with self._connect() as conn:
            return conn.execute(
                "INSERT INTO core.autoagent_trial_ledger (trial_key, agent, learning_pattern_id,"
                " event, actor, payload, dedupe_key) VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s)"
                " RETURNING id",
                (
                    key,
                    _AGENT,
                    _PATTERN_ID,
                    event,
                    stub.get_trial_ledger().ACTOR.LIVE,
                    json.dumps(payload),
                    key + suffix,
                ),
            ).fetchone()[0]

    def _preregister(self, proposal_id: int) -> int:
        event = stub.get_trial_ledger().EVENT.LIVE_PREREGISTRATION
        return self._insert_trial_row(
            proposal_id, event, {"metric_key": _BUDGET_KEY, "proposal_id": proposal_id}
        )

    def test_the_prior_attempts_read_joins_each_preregistration_to_its_proposal_latest_look_and_decision(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.FULL)
        event = stub.get_trial_ledger().EVENT
        landed = self._insert_proposal("2026-09-01")
        decided = self._insert_proposal("2026-09-02", status="rejected")
        foreign = self._insert_proposal("2026-09-03", agent="glass-atrium-dev-shell")
        self._preregister(landed)
        for number in (1, 2):
            self._insert_trial_row(
                landed, event.LIVE_LOOK, {"look": number}, suffix=f":look:{number}"
            )
        self._preregister(decided)
        self._insert_trial_row(decided, event.LIVE_LOOK, {"look": 1}, suffix=":look:1")
        self._insert_trial_row(decided, event.LIVE_DECISION, {"outcome": "stop"}, suffix=":decision")
        self._preregister(foreign)
        attempts = dc._fetch_prior_attempts(_AGENT)
        self.assertEqual(
            [(a.proposal_id, a.status, a.look, a.decision) for a in attempts],
            [
                (decided, "rejected", {"look": 1}, {"outcome": "stop"}),
                (landed, "applied", {"look": 2}, None),
            ],
        )
        self.assertTrue(all(a.label in a.diff for a in attempts))
        self.assertEqual(self.pg_reach, [])

    def test_the_landed_read_drops_trialled_proposals_before_its_limit(self) -> None:
        self._use_database(self._TEMPLATE.FULL)
        legacy = self._insert_proposal("2026-08-01")
        for day in range(1, 7):
            self._preregister(self._insert_proposal(f"2026-09-{day:02d}"))
        landed = dc._fetch_landed_proposals(_AGENT)
        self.assertEqual([proposal_id for proposal_id, _label, _diff in landed], [legacy])
        self.assertEqual(self.pg_reach, [])

    def test_the_canary_read_returns_each_undecided_live_trial_in_id_order_with_whether_it_started(
        self,
    ) -> None:
        self._use_database(self._TEMPLATE.FULL)
        event = stub.get_trial_ledger().EVENT
        unstarted, started, decided = 7001, 7002, 7003
        ids = {
            proposal_id: self._preregister(proposal_id)
            for proposal_id in (unstarted, started, decided)
        }
        self._insert_trial_row(
            started,
            event.LIVE_START,
            {"started_at": _NOW.isoformat(), "text_sha256": "0" * 64},
            suffix=":start",
        )
        self._insert_trial_row(decided, event.LIVE_DECISION, {"outcome": "stop"}, suffix=":decision")

        with self._connect() as conn:
            recorded_at = dict(
                conn.execute(
                    "SELECT id, recorded_at FROM core.autoagent_trial_ledger WHERE id = ANY(%s)",
                    (list(ids.values()),),
                ).fetchall()
            )

        canaries = dc._read_trial_canaries()

        self.assertEqual(
            canaries,
            [
                (
                    ids[proposal_id],
                    _AGENT,
                    f"{proposal_id:064x}",
                    _PATTERN_ID,
                    {"metric_key": _BUDGET_KEY, "proposal_id": proposal_id},
                    recorded_at[ids[proposal_id]],
                    is_started,
                )
                for proposal_id, is_started in ((unstarted, False), (started, True))
            ],
        )
        self.assertEqual(self.pg_reach, [])

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


_START_WARN = SimpleNamespace(
    HASH="canary text hashes to",
    FAULT="start record not written",
    UNRECORDED="canary file has no start record",
    NO_HORIZON="pre-registration states no horizon",
    VOID_FAULT="unstarted void not recorded",
)


class TrialCanaryTest(_ShadowFixture):
    """The trial stage writes each open live trial's canary from its committed pre-registration and
    records the trial's start at the first write; canary files land under a temporary data root."""

    def setUp(self) -> None:
        super().setUp()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.canary_path = Path(tmp.name) / "data" / "learning" / "canary" / f"{_AGENT}.json"
        env = mock.patch.dict(os.environ, {"GA_DATA_ROOT": tmp.name})
        env.start()
        self.addCleanup(env.stop)

    def _stage(self, now: datetime) -> str:
        self.clock.now = now
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            dc.run_trial_stage()
        self.assertEqual(self.pg_reach, [])
        self.assertEqual(self.ledger.refused, [])
        return stderr.getvalue()

    def _get_canary(self) -> dict | None:
        if not self.canary_path.exists():
            return None
        return json.loads(self.canary_path.read_text(encoding="utf-8"))

    def _get_starts(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(stub.get_trial_ledger().EVENT.LIVE_START)

    def _get_preregistration(self) -> _LedgerRow:
        (row,) = self._get_preregistrations()
        return row

    def test_the_stage_writes_exactly_the_preregistered_text_salted_with_its_row(self) -> None:
        self._open_live_trial()
        preregistration = self._get_preregistration()

        self._stage(_NOW)

        canary = preregistration.payload["canary"]
        self.assertEqual(
            self._get_canary(),
            {
                "salt": preregistration.id,
                "text": canary["text"],
                "text_sha256": canary["text_sha256"],
                "expires_at": int((_NOW + dc.CANARY.LEASE).timestamp()),
            },
        )

    def test_a_text_not_matching_its_preregistered_hash_writes_no_file_and_warns_by_name(
        self,
    ) -> None:
        key = self._open_live_trial()
        self._get_preregistration().payload["canary"]["text_sha256"] = "0" * 64

        stderr_text = self._stage(_NOW)

        self.assertIsNone(self._get_canary())
        self.assertEqual(self._get_starts(), [])
        self.assertIn(
            f"WARN: trial stage — trial {key}: {_AGENT}'s {_START_WARN.HASH}", stderr_text
        )

    def test_a_canary_appears_only_once_its_preregistration_is_committed(self) -> None:
        power = self._check_power()
        [power_pass] = power.passes
        payload = dc.get_preregistration_payload(power_pass, _get_inputs(power))

        self._stage(_NOW)
        before_commit = self._get_canary()
        self.ledger.write(
            stub.get_trial_ledger().EVENT.LIVE_PREREGISTRATION,
            stub.get_trial_ledger().ACTOR.LIVE,
            {**payload, "proposal_id": _PROPOSAL_ID},
            trial_key=_LIVE_KEY,
            agent=_AGENT,
            learning_pattern_id=_PATTERN_ID,
            dedupe_key=_LIVE_KEY,
        )
        self._stage(_NEXT_NOW)

        self.assertIsNone(before_commit)
        self.assertEqual(self._get_canary()["text"], payload["canary"]["text"])

    def test_the_first_write_records_one_start_with_its_instant_and_a_later_cycle_none(
        self,
    ) -> None:
        key = self._open_live_trial()
        digest = self._get_preregistration().payload["canary"]["text_sha256"]
        # each reading advances the clock and notes whether the canary file stood at that instant
        readings: list[tuple[str, bool]] = []

        def _read_advancing_clock() -> datetime:
            self.clock.now += timedelta(microseconds=250_000)
            readings.append((self.clock.now.isoformat(), self.canary_path.exists()))
            return self.clock.now

        self._patch("_get_utc_now", _read_advancing_clock)
        self._stage(_NOW)
        self._patch("_get_utc_now", lambda: self.clock.now)
        self._stage(_NEXT_NOW)

        self.assertEqual(
            [
                (row.trial_key, row.agent, row.learning_pattern_id, row.actor, row.dedupe_key)
                for row in self._get_starts()
            ],
            [(key, _AGENT, _PATTERN_ID, stub.get_trial_ledger().ACTOR.LIVE, f"{key}:start")],
        )
        started_at = self._get_starts()[0].payload["started_at"]
        # the instant is a reading taken while the file did not yet stand
        self.assertIn((started_at, False), readings)
        self.assertEqual(
            self._get_starts()[0].payload, {"started_at": started_at, "text_sha256": digest}
        )
        # the later cycle renews the lease from its own instant
        self.assertEqual(
            self._get_canary()["expires_at"], int((_NEXT_NOW + dc.CANARY.LEASE).timestamp())
        )

    def test_the_start_records_top_level_keys_are_the_instant_and_the_hash(self) -> None:
        self._open_live_trial()

        self._stage(_NOW)

        self.assertEqual(set(self._get_starts()[0].payload), _KEYS.START)

    def test_a_start_record_the_ledger_does_not_take_removes_the_file_until_a_cycle_records_it(
        self,
    ) -> None:
        key = self._open_live_trial()
        write = self.ledger.write
        start_event = stub.get_trial_ledger().EVENT.LIVE_START
        # name, the writer's answer to the start row
        rows = (
            ("a 0 return", lambda *args, **kwargs: 0),
            ("a raised fault", mock.Mock(side_effect=ConnectionError("PG unreachable"))),
        )
        for name, refuse in rows:
            with self.subTest(name):

                def _write(event, *args, refuse=refuse, **kwargs):
                    return (refuse if event == start_event else write)(event, *args, **kwargs)

                self._patch("_pg_write_trial_ledger_row", _write)

                stderr_text = self._stage(_NOW)

                self.assertIsNone(self._get_canary())
                self.assertEqual(self._get_starts(), [])
                self.assertIn(
                    f"WARN: trial stage — trial {key}: {_AGENT}'s {_START_WARN.FAULT}",
                    stderr_text,
                )
        self._patch("_pg_write_trial_ledger_row", write)

        self._stage(_NEXT_NOW)

        self.assertEqual(len(self._get_starts()), 1)
        self.assertEqual(self._get_canary()["salt"], self._get_preregistration().id)

    def test_an_open_trials_file_with_no_start_record_is_removed_as_unrecorded_then_retried(
        self,
    ) -> None:
        key = self._open_live_trial()
        # a kill between the file's rename and its start row: the file stands, no row
        self._stage(_NOW)
        self.ledger.rows[:] = [row for row in self.ledger.rows if row not in self._get_starts()]

        stderr_text = self._stage(_NEXT_NOW)
        after_removal = self._get_canary()
        self._stage(_NEXT_NOW + timedelta(days=1))

        self.assertIsNone(after_removal)
        self.assertIn(
            f"WARN: trial stage — trial {key}: {_AGENT}'s {_START_WARN.UNRECORDED}", stderr_text
        )
        self.assertEqual(
            [row.payload["started_at"] for row in self._get_starts()],
            [(_NEXT_NOW + timedelta(days=1)).isoformat()],
        )
        self.assertIsNotNone(self._get_canary())

    def _get_decisions(self) -> list[_LedgerRow]:
        return self.ledger.get_rows(stub.get_trial_ledger().EVENT.LIVE_DECISION)

    def _get_bound(self) -> datetime:
        """The pre-registration's recorded_at plus the horizon it states."""
        preregistration = self._get_preregistration()
        return preregistration.recorded_at + timedelta(
            days=preregistration.payload["horizon_days"]
        )

    def _strip_starts(self) -> None:
        """A kill between the file's rename and its start row: the file stands, no row."""
        self.ledger.rows[:] = [row for row in self.ledger.rows if row not in self._get_starts()]

    def test_an_unstarted_trial_at_its_stated_horizon_is_voided_its_file_removed_its_agent_released(
        self,
    ) -> None:
        key = self._open_live_trial()
        self._stage(_NOW)
        self._strip_starts()

        self._stage(self._get_bound())

        self.assertEqual(
            [
                (row.trial_key, row.agent, row.learning_pattern_id, row.actor, row.dedupe_key)
                for row in self._get_decisions()
            ],
            [(key, _AGENT, _PATTERN_ID, stub.get_trial_ledger().ACTOR.LIVE, f"{key}:decision")],
        )
        self.assertEqual(self._get_starts(), [])
        self.assertIsNone(self._get_canary())
        self.assertNotIn(_AGENT, self.ledger.read_open_trials())

    def test_one_second_before_its_stated_horizon_an_unstarted_trial_is_written_not_voided(
        self,
    ) -> None:
        self._open_live_trial()

        self._stage(self._get_bound() - timedelta(seconds=1))

        self.assertEqual(self._get_decisions(), [])
        self.assertEqual(len(self._get_starts()), 1)
        self.assertIsNotNone(self._get_canary())

    def test_a_trial_started_before_its_preregistrations_horizon_is_not_voided_at_it(self) -> None:
        self._open_live_trial()
        self._stage(_NOW)
        bound = self._get_bound()

        self._stage(bound)

        self.assertEqual(self._get_decisions(), [])
        self.assertEqual(
            self._get_canary()["expires_at"], int((bound + dc.CANARY.LEASE).timestamp())
        )

    def test_the_unstarted_void_rows_only_top_level_key_is_void_naming_its_reason_and_agent(
        self,
    ) -> None:
        self._open_live_trial()

        self._stage(self._get_bound())

        (decision,) = self._get_decisions()
        self.assertEqual(set(decision.payload), {"void"})
        # the doctor counts an unstarted void by this reason literal and names its agent
        self.assertEqual(decision.payload["void"], {"reason": "unstarted", "agent": _AGENT})

    def test_an_unstarted_void_not_landing_still_removes_the_file_and_writes_none(self) -> None:
        key = self._open_live_trial()
        write = self.ledger.write
        decision_event = stub.get_trial_ledger().EVENT.LIVE_DECISION
        # name, the writer's answer to the decision row, the stderr line it leaves
        rows = (
            (
                "a raised fault: a record fault, retried",
                mock.Mock(side_effect=ConnectionError("PG unreachable")),
                f"WARN: trial stage — trial {key}: {_AGENT}'s {_START_WARN.VOID_FAULT}",
            ),
            (
                "a 0 return: the trial already decided",
                lambda *args, **kwargs: 0,
                f"INFO: trial stage — trial {key} already decided",
            ),
        )
        for name, refuse, line in rows:
            with self.subTest(name):
                self._patch("_pg_write_trial_ledger_row", write)
                self._stage(_NOW)
                self._strip_starts()

                def _write(event, *args, refuse=refuse, **kwargs):
                    return (refuse if event == decision_event else write)(event, *args, **kwargs)

                self._patch("_pg_write_trial_ledger_row", _write)

                stderr_text = self._stage(self._get_bound())

                self.assertIsNone(self._get_canary())
                self.assertEqual(self._get_starts(), [])
                self.assertIn(line, stderr_text)
        self._patch("_pg_write_trial_ledger_row", write)

        self._stage(self._get_bound() + timedelta(days=1))

        self.assertEqual(len(self._get_decisions()), 1)

    def test_a_preregistration_with_no_readable_horizon_warns_and_its_trial_is_written_not_voided(
        self,
    ) -> None:
        key = self._open_live_trial()
        payload = self._get_preregistration().payload
        open_rows = list(self.ledger.rows)
        # name, the stored horizon_days (absent = no key)
        rows = (
            ("absent", None),
            ("not a number", "84"),
            ("a count no instant can hold", 1e300),
            ("a bool", True),
            ("zero", 0),
            ("a negative count", -3),
        )
        for name, horizon_days in rows:
            with self.subTest(name):
                payload.pop("horizon_days", None)
                if horizon_days is not None:
                    payload["horizon_days"] = horizon_days
                self.ledger.rows[:] = open_rows  # a row voided earlier never decides a later one
                self.canary_path.unlink(missing_ok=True)

                stderr_text = self._stage(_NOW + timedelta(days=400))

                self.assertEqual(self._get_decisions(), [])
                self.assertEqual(len(self._get_starts()), 1)
                self.assertIn(
                    f"WARN: trial stage — trial {key}: {_AGENT}'s {_START_WARN.NO_HORIZON}",
                    stderr_text,
                )

    def test_an_unstarted_trial_past_its_horizon_is_voided_though_an_earlier_write_is_refused(
        self,
    ) -> None:
        self._open_live_trial()
        self._stage(_NOW)  # the earlier trial started → its rewrite is the stage's first write
        first = self._get_preregistration()
        later_key = f"{_PROPOSAL_ID + 1:064x}"
        self.ledger.write(
            first.event,
            first.actor,
            {**first.payload, "proposal_id": _PROPOSAL_ID + 1},
            trial_key=later_key,
            agent=_POOL_AGENT,
            learning_pattern_id=_PATTERN_ID,
            dedupe_key=later_key,
        )
        learning = self.canary_path.parents[1]
        outside = learning.parent.parent / "outside-learning"
        learning.rename(outside)
        learning.symlink_to(outside, target_is_directory=True)
        bound = first.recorded_at + timedelta(days=first.payload["horizon_days"])

        stderr_text = self._stage(bound)

        self.assertEqual(
            [(row.trial_key, row.agent) for row in self._get_decisions()],
            [(later_key, _POOL_AGENT)],
        )
        self.assertIn("canary directory not a real directory", stderr_text)

    def test_a_decided_trial_gets_no_canary(self) -> None:
        key = self._open_live_trial()
        trial_ledger = stub.get_trial_ledger()
        self.ledger.write(
            trial_ledger.EVENT.LIVE_DECISION,
            trial_ledger.ACTOR.LIVE,
            {"outcome": "stop"},
            trial_key=key,
            agent=_AGENT,
            dedupe_key=f"{key}:decision",
        )

        self._stage(_NOW)

        self.assertIsNone(self._get_canary())
        self.assertEqual(self._get_starts(), [])


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
        self.intakes = [intake]
        self._patch("_pg_read_pending_patterns", lambda: [dict(row) for row in self.intakes])

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
        self.assertEqual(report.power_check["passing"], len(self.intakes))
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

    def test_a_writing_cycle_starts_an_open_trials_canary_and_a_dry_run_writes_neither(
        self,
    ) -> None:
        self._open_writing_stages()
        key = self._open_live_trial()
        canary_path = self.root / "data" / "learning" / "canary" / f"{_AGENT}.json"
        start_event = stub.get_trial_ledger().EVENT.LIVE_START
        # name, skip_loop_emit, whether the canary and its start row land
        rows = (("a dry run", True, False), ("a writing cycle", False, True))
        for name, skip_loop_emit, is_started in rows:
            with self.subTest(name):
                self._run_cycle(skip_loop_emit=skip_loop_emit)

                self.assertEqual(canary_path.exists(), is_started)
                self.assertEqual(
                    [row.dedupe_key for row in self.ledger.get_rows(start_event)],
                    [f"{key}:start"] if is_started else [],
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

    def test_a_failed_roster_read_warns_once_preregisters_nothing_and_the_cycle_runs_on(
        self,
    ) -> None:
        # a second agent group whose candidate also reaches pre-registration
        (self.root / "agents" / f"{_POOL_AGENT}.md").write_text("probe", encoding="utf-8")
        self.ledger.design_effects[_POOL_AGENT] = _DESIGN_EFFECT_PAYLOAD
        self.intakes.append(
            self.intakes[0]
            | {
                "id": _PATTERN_ID + 1,
                "agent": _POOL_AGENT,
                "pattern_signature": f"budget-overage concentration|{_POOL_AGENT}",
            }
        )
        shadow_stage = dc.run_shadow_stage
        self._patch(
            "run_shadow_stage",
            lambda *args: (shadow_stage(*args), self.stages.append("shadow")),
        )
        self._patch("run_aa_stage", lambda *args, **kwargs: self.stages.append("aa"))
        self._patch("create_cycle_verdicts", lambda report: self.stages.append("verdicts"))
        self._open_writing_stages()

        def _get_proposal(agent: str, *_args: object, **_kwargs: object) -> dc.PatchProposal:
            return dc.PatchProposal(
                target_file=str(self.root / "agents" / f"{agent}.md"),
                rationale="probe rationale",
                proposed_diff=_PROBE_DIFF,
                touched_frontmatter=False,
                estimated_added_lines=1,
                raw_response="probe raw response",
            )

        # each candidate driven to pre-registration: generated, body-auto, non-safety, verified
        for name, value in (
            ("generate_consolidated_proposal", _get_proposal),
            ("classify_patch_area", lambda *args, **kwargs: "body-auto"),
            ("classify_safety_tier", lambda *args, **kwargs: "non-safety"),
            ("run_pre_verify", lambda *args, **kwargs: dc.PreVerifyResult(True, "ok", {}, "ok", 0)),
            ("supersede_prior_pending_for_agent", lambda *args, **kwargs: 0),
        ):
            self._patch(name, value)
        rows = (("the roster read answers", False), ("the roster read raises", True))
        for name, is_fault in rows:
            with self.subTest(name):
                self.stages.clear()
                self.ledger.rows.clear()
                self.roster.is_faulted = is_fault
                report = self._run_cycle(skip_loop_emit=False)
                self.assertEqual(self.stderr.getvalue().count(_ROSTER_WARN), int(is_fault))
                self.assertEqual(
                    sorted(
                        (patch.pattern_agent, patch.preregistration_payload is None, patch.status)
                        for patch in report.patches
                    ),
                    [
                        (agent, is_fault, "unadjudicated" if is_fault else "pending")
                        for agent in sorted((_AGENT, _POOL_AGENT))
                    ],
                )
                self.assertEqual(self.stages, ["shadow", "aa", "roster read", "verdicts"])
                self.assertIsInstance(report, dc.CycleReport)


_CODE_AGENTS = (
    "glass-atrium-dev-shell",
    "glass-atrium-dev-react",
    "glass-atrium-dev-nestjs",
)
_OFF_MAP_AGENT = "glass-atrium-user-added"
_DESIGN_EFFECT_KEYS = ("design_effect_1", "design_effect_2")


class _RecordedMeasurement(NamedTuple):
    """One deciding agent's recorded inputs and its minimum detectable harms, both stages."""

    agent: str
    guardrail_count: int
    primary_rate: float
    per_arm: int
    readings: tuple  # GuardrailBaseline fields, tool_use as (mean, sd)
    # check → design effect → (trial at α 0.05, watch at 0.05/k)
    harms: dict


_RECORDED_MEASUREMENTS = (
    _RecordedMeasurement(
        "glass-atrium-qa-code-reviewer",
        3,
        0.062,
        2432,
        (246 / 3994, 0.01, (23.78, 15.37)),
        {
            "no_subagent_stop": ((1.30, 1.36), (1.43, 1.52)),
            "tool_use": ((1.10, 1.31), (1.55, 1.85)),
        },
    ),
    _RecordedMeasurement(
        "glass-atrium-dev-shell",
        4,
        0.166,
        790,
        (119 / 2121, 21 / 2050, (27.11, 21.02)),
        {
            "no_subagent_stop": ((1.58, 1.74), (1.85, 2.10)),
            "verified_fail": ((2.65, 3.19), (3.62, 4.55)),
            "tool_use": ((2.63, 3.26), (3.72, 4.61)),
        },
    ),
    _RecordedMeasurement(
        "glass-atrium-dev-nestjs",
        4,
        0.097,
        1485,
        (29 / 1285, 36 / 1293, (25.12, 14.50)),
        {
            "no_subagent_stop": ((1.69, 1.89), (2.04, 2.35)),
            "verified_fail": ((1.61, 1.78), (1.91, 2.18)),
            "tool_use": ((1.32, 1.64), (1.87, 2.32)),
        },
    ),
    _RecordedMeasurement(
        "glass-atrium-dev-react",
        4,
        0.185,
        690,
        (87 / 1192, 10 / 1113, (16.25, 10.42)),
        {
            "no_subagent_stop": ((1.53, 1.67), (1.78, 2.00)),
            "verified_fail": ((2.97, 3.64), (4.17, 5.34)),
            "tool_use": ((1.40, 1.73), (1.97, 2.45)),
        },
    ),
    _RecordedMeasurement(
        "glass-atrium-meta-prompt-engineer",
        3,
        0.150,
        899,
        (58 / 787, 0.01, (26.01, 17.81)),
        {
            "no_subagent_stop": ((1.46, 1.55), (1.67, 1.82)),
            "tool_use": ((2.09, 2.49), (2.95, 3.53)),
        },
    ),
)


def _get_harm_checks(
    row: _RecordedMeasurement, *, metric_key: str = _BUDGET_KEY
) -> dict:
    no_stop_rate, verified_fail_rate, tool_use = row.readings
    return dc.get_harm_checks(
        metric_key,
        dc.GuardrailBaseline(
            no_stop_rate, verified_fail_rate, dc.ToolUseBaseline(*tool_use)
        ),
        dc.HarmSizing(row.primary_rate, row.per_arm, row.guardrail_count),
    )


class HarmCheckTest(unittest.TestCase):
    """Each harm check's D6 margin, R74 α and minimum detectable harm, and R226's widening lines."""

    def test_each_check_states_its_margin_alpha_and_trial_design_harm_with_absolute_margins_as_folds(
        self,
    ) -> None:
        readings = dc.GuardrailBaseline(0.10, 0.02, dc.ToolUseBaseline(20.0, 12.0))
        checks = dc.get_harm_checks(_BUDGET_KEY, readings, dc.HarmSizing(0.05, 790, 4))
        guardrails = checks["guardrails"]
        # the leg's margin: the trial's absolute effect 0.3 × 0.05 read as a fold at the leg's 0.10
        self.assertAlmostEqual(guardrails["no_subagent_stop"]["margin"], 1.15)
        self.assertAlmostEqual(guardrails["verified_fail"]["margin"], 1.30)
        self.assertAlmostEqual(checks["primary"]["margin"], 1.30)
        self.assertAlmostEqual(guardrails["tool_use"]["margin"], 6.0)
        rates = {"no_subagent_stop": 0.10, "verified_fail": 0.02}
        for name, rate in rates.items():
            for stage, alpha in (("trial", 0.05), ("watch", 0.0125)):
                for key, design_effect in zip(_DESIGN_EFFECT_KEYS, (1, 2)):
                    expected = trial_design.get_rate_harm(
                        rate, 790, alpha=alpha, design_effect=design_effect
                    )
                    actual = guardrails[name][stage]["minimum_detectable"][key]
                    self.assertAlmostEqual(
                        actual, expected, msg=f"{name} {stage} {key}"
                    )
        expected = trial_design.get_tool_use_harm(
            12.0, 790, is_overage_primary=True, alpha=0.0125, design_effect=2
        )
        self.assertAlmostEqual(
            guardrails["tool_use"]["watch"]["minimum_detectable"]["design_effect_2"],
            expected,
        )

    def test_the_legs_absolute_margin_is_the_reduction_the_trial_is_sized_to_find(
        self,
    ) -> None:
        readings = dc.GuardrailBaseline(0.10, 0.02, dc.ToolUseBaseline(20.0, 12.0))
        with mock.patch.object(trial_design, "DEFAULT_RELATIVE_REDUCTION", 0.50):
            checks = dc.get_harm_checks(
                _BUDGET_KEY, readings, dc.HarmSizing(0.05, 790, 4)
            )
        # 0.5 × 0.05 read as a fold at the leg's 0.10 → 1.25, under the 30% rise
        self.assertAlmostEqual(checks["guardrails"]["no_subagent_stop"]["margin"], 1.25)

    def test_alpha_is_005_per_check_in_the_trial_and_the_watch_shares_sum_to_005_two_sided_halved(
        self,
    ) -> None:
        readings = dc.GuardrailBaseline(0.05, 0.02, dc.ToolUseBaseline(20.0, 12.0))
        for metric_key, sides in ((_BUDGET_KEY, 1), ("emit_failure", 2)):
            for count in (3, 4):
                checks = dc.get_harm_checks(
                    metric_key, readings, dc.HarmSizing(0.1, 900, count)
                )
                guardrails = checks["guardrails"]
                label = f"{metric_key} k {count}"
                self.assertEqual(len(guardrails), count, label)
                self.assertEqual(
                    {row["trial"]["alpha"] for row in guardrails.values()},
                    {0.05},
                    label,
                )
                self.assertAlmostEqual(
                    sum(row["watch"]["alpha"] for row in guardrails.values()),
                    0.05,
                    msg=label,
                )
                self.assertEqual(
                    (
                        checks["primary"]["trial"]["alpha"],
                        checks["primary"]["watch"]["alpha"],
                    ),
                    (0.05, 0.05),
                )
                band = guardrails["tool_use"]
                for stage in ("trial", "watch"):
                    self.assertEqual(band[stage]["sides"], sides, label)
                    self.assertAlmostEqual(
                        band[stage]["alpha_per_side"],
                        band[stage]["alpha"] / sides,
                        msg=label,
                    )

    def _assert_recorded_column(self, column: int) -> None:
        for row in _RECORDED_MEASUREMENTS:
            guardrails = _get_harm_checks(row)["guardrails"]
            for name, by_design_effect in row.harms.items():
                for key, pair in zip(_DESIGN_EFFECT_KEYS, by_design_effect):
                    stage = ("trial", "watch")[column]
                    actual = guardrails[name][stage]["minimum_detectable"][key]
                    # inputs as recorded, each rounded → ±0.01 on the recorded figure
                    self.assertAlmostEqual(
                        actual,
                        pair[column],
                        delta=0.01,
                        msg=f"{row.agent} {name} {stage} {key}",
                    )

    def test_trial_minimum_detectable_harms_reproduce_the_recorded_measurement_at_alpha_005(
        self,
    ) -> None:
        self._assert_recorded_column(0)

    def test_watch_minimum_detectable_harms_reproduce_the_recorded_measurement_at_the_family_share(
        self,
    ) -> None:
        self._assert_recorded_column(1)

    def test_the_watch_widens_on_the_shipped_fixed_sample_drift_scale_by_1194_and_1240(
        self,
    ) -> None:
        for row, ratio in (
            (_RECORDED_MEASUREMENTS[0], 1.194),
            (_RECORDED_MEASUREMENTS[1], 1.240),
        ):
            guardrails = _get_harm_checks(row)["guardrails"]
            # re-delegation is a mean shift like the band: its model-based columns widen the same
            for name in (*row.harms, "redelegation"):
                self.assertAlmostEqual(
                    guardrails[name]["widening"]["drift"]["fixed_sample"],
                    ratio,
                    places=3,
                    msg=name,
                )
            self.assertEqual(
                guardrails["redelegation"]["widening"]["basis"], "model-based"
            )
            # linear in the drift (band) or a mean shift like it (re-delegation) → own unit = drift
            for name in ("tool_use", "redelegation"):
                for key in _DESIGN_EFFECT_KEYS:
                    self.assertAlmostEqual(
                        guardrails[name]["widening"]["own_unit"][key],
                        ratio,
                        places=3,
                        msg=f"{name} {key}",
                    )
        # a rate guardrail widens more in its own unit at these low rates (leg ×1.271-1.299 at k 4)
        leg = _get_harm_checks(_RECORDED_MEASUREMENTS[1])["guardrails"][
            "no_subagent_stop"
        ]["widening"]["own_unit"]
        self.assertTrue(1.271 - 0.005 <= leg["design_effect_1"] <= 1.299 + 0.005, leg)

    def test_the_watch_widens_by_1187_and_1231_with_each_alphas_four_look_inflation(
        self,
    ) -> None:
        for row, ratio in (
            (_RECORDED_MEASUREMENTS[0], 1.187),
            (_RECORDED_MEASUREMENTS[1], 1.231),
        ):
            guardrails = _get_harm_checks(row)["guardrails"]
            for name in (*row.harms, "redelegation"):
                self.assertAlmostEqual(
                    guardrails[name]["widening"]["drift"]["four_look"],
                    ratio,
                    places=3,
                    msg=name,
                )

    def test_a_two_sided_band_widens_at_its_per_side_alpha_on_both_drift_forms(self) -> None:
        # a non-overage primary → the tool_use band is two-sided, each stage's α split per side
        rows = [
            ("k 3", _RECORDED_MEASUREMENTS[0], 1.155, 1.150),
            ("k 4", _RECORDED_MEASUREMENTS[1], 1.192, 1.186),
        ]
        for name, row, fixed_sample, four_look in rows:
            with self.subTest(name):
                band = _get_harm_checks(row, metric_key="emit_failure")["guardrails"][
                    "tool_use"
                ]
                self.assertEqual(band["watch"]["sides"], 2)
                drift = band["widening"]["drift"]
                self.assertAlmostEqual(drift["fixed_sample"], fixed_sample, places=3)
                self.assertAlmostEqual(drift["four_look"], four_look, places=3)
                for key in _DESIGN_EFFECT_KEYS:
                    self.assertAlmostEqual(
                        band["widening"]["own_unit"][key], fixed_sample, places=3, msg=key
                    )

    def test_verified_fail_is_a_guardrail_only_never_a_primary_key(self) -> None:
        readings = dc.GuardrailBaseline(0.05, 0.02, dc.ToolUseBaseline(20.0, 12.0))
        for metric_key in sorted(dc.METRIC_KEYS):
            checks = dc.get_harm_checks(
                metric_key, readings, dc.HarmSizing(0.1, 900, 4)
            )
            self.assertEqual(checks["primary"]["metric_key"], metric_key)
            self.assertIn("verified_fail", checks["guardrails"])
        with self.assertRaises(ValueError):
            dc.get_harm_checks("verified_fail", readings, dc.HarmSizing(0.1, 900, 4))


class GuardrailCountTest(unittest.TestCase):
    """k from the scope map alone (R4): 3 only where the map names a non-DEV scope file."""

    def test_the_three_code_agents_have_four_guardrails(self) -> None:
        for agent in _CODE_AGENTS:
            self.assertEqual(dc.get_guardrail_count(agent), 4, agent)

    def test_the_mapped_non_code_deciding_agents_have_three(self) -> None:
        for agent in (
            "glass-atrium-qa-code-reviewer",
            "glass-atrium-meta-prompt-engineer",
            "glass-atrium-intel-planner",
        ):
            self.assertEqual(dc.get_guardrail_count(agent), 3, agent)

    def test_intel_researcher_and_meta_agent_have_three(self) -> None:
        for agent in ("glass-atrium-intel-researcher", "glass-atrium-meta-agent"):
            self.assertEqual(dc.get_guardrail_count(agent), 3, agent)

    def test_three_exactly_where_the_map_names_a_scope_file_other_than_scope_dev(
        self,
    ) -> None:
        for agent, scope_file in dc._AGENT_SCOPE_MAP.items():
            expected = 4 if scope_file == "scope-dev.md" else 3
            self.assertEqual(
                dc.get_guardrail_count(agent), expected, f"{agent} → {scope_file}"
            )


class HarmCheckPayloadTest(_ShadowFixture):
    """The pre-registration payload's harm checks for the agent it is built for."""

    def _get_payload(self, agent: str, spawns: list[SpawnFacts] | None = None) -> dict:
        power = self._check_power()
        [power_pass] = power.passes
        pattern = dataclasses.replace(power_pass.pattern, agent=agent)
        power_pass = power_pass._replace(
            pattern=pattern, spawns=spawns or power_pass.spawns
        )
        return dc.get_preregistration_payload(power_pass, _get_inputs(power))

    def _get_leg_spawns(self) -> list[SpawnFacts]:
        """The fixture's history with every tenth spawn ending without a SubagentStop."""
        return [
            spawn._replace(has_subagent_stop=index % 10 != 0)
            for index, spawn in enumerate(self.history)
        ]

    def _get_harm_at(self, payload: dict, stage: str, design_effect: float) -> float:
        leg = payload["harm_checks"]["guardrails"]["no_subagent_stop"]
        return trial_design.get_rate_harm(
            leg["baseline_rate"],
            payload["maximum_per_arm"],
            alpha=leg[stage]["alpha"],
            design_effect=design_effect,
        )

    def test_a_guardrail_with_a_passed_aa_row_states_its_harm_at_that_design_effect_alone(
        self,
    ) -> None:
        # a union-event row beside it adds no proxy line to a measured leg
        self.ledger.guardrail_rows += [
            (_AGENT, _GUARDRAIL_ROWS.NO_STOP),
            (_AGENT, _GUARDRAIL_ROWS.UNION),
        ]
        payload = self._get_payload(_AGENT, self._get_leg_spawns())
        leg = payload["harm_checks"]["guardrails"]["no_subagent_stop"]
        self.assertEqual(leg["design_effect"], {"basis": "measured", "value": 1.4})
        self.assertNotIn("proxy", leg)
        for stage in ("trial", "watch"):
            self.assertEqual(
                leg[stage]["minimum_detectable"],
                {"design_effect_measured": self._get_harm_at(payload, stage, 1.4)},
                stage,
            )

    def test_a_guardrail_with_no_aa_row_states_design_effect_1_and_2_labelled_and_the_trial_opens(
        self,
    ) -> None:
        payload = self._get_payload(_AGENT, self._get_leg_spawns())
        self.assertEqual(len(self.power.passes), 1)
        for name in ("no_subagent_stop", "verified_fail", "tool_use"):
            row = payload["harm_checks"]["guardrails"][name]
            self.assertEqual(row["design_effect"]["basis"], "unmeasured", name)
            self.assertIn("design effect 1 and 2", row["design_effect"]["label"], name)
            for stage in ("trial", "watch"):
                self.assertEqual(
                    set(row[stage]["minimum_detectable"]), set(_DESIGN_EFFECT_KEYS), name
                )
        self.assertNotIn("proxy", payload["harm_checks"]["guardrails"]["no_subagent_stop"])

    def test_a_union_event_row_states_a_proxy_line_that_no_power_read_or_stop_boundary_reads(
        self,
    ) -> None:
        unreadable = {**_GUARDRAIL_ROWS.UNION, "value": "not a number"}
        rows = [
            ("a union-event row → the proxy line at its design effect", _GUARDRAIL_ROWS.UNION, 1.6),
            ("an unreadable union-event row → no proxy line", unreadable, None),
        ]
        spawns = self._get_leg_spawns()
        expected = self._get_payload(_AGENT, spawns)
        for name, union_row, design_effect in rows:
            with self.subTest(name):
                self.ledger.guardrail_rows[:] = [(_AGENT, union_row)]
                payload = self._get_payload(_AGENT, spawns)
                leg = payload["harm_checks"]["guardrails"]["no_subagent_stop"]
                proxy = leg.pop("proxy", None)
                # everything else — sizing, looks, boundaries, the leg's own bracket — unchanged
                self.assertEqual(payload, expected)
                if design_effect is None:
                    self.assertIsNone(proxy)
                    continue
                self.assertEqual(proxy["label"], _PROXY_LABEL)
                self.assertEqual(proxy["design_effect"], design_effect)
                self.assertEqual(
                    proxy["minimum_detectable"],
                    {
                        stage: self._get_harm_at(payload, stage, design_effect)
                        for stage in ("trial", "watch")
                    },
                )

    def test_an_agent_the_map_does_not_name_has_four_guardrails_on_the_helper_and_the_payload(
        self,
    ) -> None:
        self.assertEqual(dc.get_guardrail_count(_OFF_MAP_AGENT), 4)
        payload = self._get_payload(_OFF_MAP_AGENT)
        self.assertEqual(payload["guardrail_count"], 4)
        self.assertIn("verified_fail", payload["harm_checks"]["guardrails"])

    def test_a_k4_agent_with_no_verified_fail_in_its_baseline_renders_the_row_without_raising(
        self,
    ) -> None:
        graded = ({"grader_verdict": "verified_pass"},)
        spawns = [
            spawn._replace(outcomes=graded, tool_use_actual=10 + index % 7)
            for index, spawn in enumerate(self.history)
        ]
        for agent in (_OFF_MAP_AGENT, "glass-atrium-dev-react"):
            payload = self._get_payload(agent, spawns)
            row = payload["harm_checks"]["guardrails"]["verified_fail"]
            self.assertEqual(row["baseline_rate"], 0.0, agent)
            self.assertEqual(row["reading"], dc.HARM_CHECK.READING.READ, agent)
            self.assertEqual(
                set(row["trial"]["minimum_detectable"].values()), {None}, agent
            )
            json.dumps(payload, allow_nan=False)

    def test_verified_fail_counts_only_graded_outcome_rows(self) -> None:
        rows = [
            (
                "an unverified row sits in the denominator",
                ("verified_fail", "unverified"),
                1 / 2,
            ),
            (
                "graded rows alone",
                ("verified_fail", "verified_pass", "unverified"),
                1 / 3,
            ),
            (
                "a not-yet-graded row beside them leaves the rate unchanged",
                ("verified_fail", "verified_pass", "unverified", None),
                1 / 3,
            ),
        ]
        for name, verdicts, expected in rows:
            outcomes = tuple(
                {"attribution_source": "hook-input", "grader_verdict": verdict}
                for verdict in verdicts
            )
            spawns = [spawn._replace(outcomes=outcomes) for spawn in self.history]
            with self.subTest(name):
                row = self._get_payload(_OFF_MAP_AGENT, spawns)["harm_checks"][
                    "guardrails"
                ]["verified_fail"]
                self.assertAlmostEqual(row["baseline_rate"], expected)
                self.assertEqual(row["reading"], dc.HARM_CHECK.READING.READ)

    def test_outcomes_none_of_them_graded_leave_verified_fail_unread_not_a_measured_zero(
        self,
    ) -> None:
        # the spawn-facts read's shape for a row the grader has not reached: the key, value None
        ungraded = ({"attribution_source": "hook-input", "grader_verdict": None},)
        spawns = [spawn._replace(outcomes=ungraded) for spawn in self.history]
        row = self._get_payload(_OFF_MAP_AGENT, spawns)["harm_checks"]["guardrails"][
            "verified_fail"
        ]
        self.assertIsNone(row["baseline_rate"])
        self.assertEqual(row["reading"], dc.HARM_CHECK.READING.UNREAD)
        for stage in ("trial", "watch"):
            self.assertEqual(
                set(row[stage]["minimum_detectable"].values()), {None}, stage
            )

    def test_a_floor_half_spawn_before_the_provenance_start_leaves_every_reading_unchanged(
        self,
    ) -> None:
        graded = ({"grader_verdict": "verified_pass"},)
        spawns = [
            spawn._replace(outcomes=graded, tool_use_actual=10 + index % 7)
            for index, spawn in enumerate(self.history)
        ]
        # inside the 84-day baseline, before the fixture's provenance start (D - 60 d)
        early = _spawn(_DAY - timedelta(days=82), is_floor=True)._replace(
            has_subagent_stop=False,
            outcomes=({"grader_verdict": dc.GRADER_VERDICT_FAIL},),
            tool_use_actual=900,
        )
        expected = self._get_payload(_OFF_MAP_AGENT, spawns)["harm_checks"]
        actual = self._get_payload(_OFF_MAP_AGENT, [*spawns, early])["harm_checks"]
        self.assertEqual(actual, expected)

    def test_the_payload_maximum_is_the_larger_sample_grown_at_the_agents_own_k(
        self,
    ) -> None:
        # baseline 51/91: efficacy 112 > harm 103, grown to 142 at k 4 and 134 at k 3
        rows = [
            ("a k-4 agent", _AGENT, 142),
            ("a k-3 agent", "glass-atrium-qa-code-reviewer", 134),
        ]
        for name, agent, maximum in rows:
            with self.subTest(name):
                power = self._check_power()
                [power_pass] = power.passes
                power_pass = power_pass._replace(
                    pattern=dataclasses.replace(power_pass.pattern, agent=agent),
                    baseline=power_pass.baseline._replace(events=51, spawns=91),
                )
                payload = dc.get_preregistration_payload(power_pass, _get_inputs(power))
                self.assertEqual(payload["samples"], {"efficacy": 112, "harm": 103})
                self.assertEqual(payload["maximum_per_arm"], maximum)
                self.assertEqual(payload["harm_checks"]["primary"]["baseline_rate"], 51 / 91)


if __name__ == "__main__":
    unittest.main()
