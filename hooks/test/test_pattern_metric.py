#!/usr/bin/env python3
"""The shared per-pattern metric: pair windows, the sha256 spawn half and the occurrence floor.

The pure classes need no database; the aggregator leg drives ``learning-aggregator.py`` → ``main``
over fake PG seams. The ``*LivePg`` classes run their SQL on the ephemeral cluster of
``autoagent/test/live-pg-ephemeral.bats`` and skip anywhere else.

    python3 -m unittest -v test_pattern_metric   (cwd: hooks/test)
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_AUTOAGENT_TEST_DIR = _AUTOAGENT_DIR / "test"
for _path in (_HOOKS_DIR, _AUTOAGENT_DIR, _AUTOAGENT_TEST_DIR):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

import _outcome_signal as sig  # noqa: E402

try:
    import _pg_learning_dualwrite as pgdw  # noqa: E402
except ImportError as exc:  # psycopg absent → only the live class skips
    pgdw = None
    _IMPORT_ERROR = str(exc)
else:
    _IMPORT_ERROR = ""

_UTC = timezone.utc
_NOW = datetime(2026, 10, 5, 6, 30, tzinfo=_UTC)
_DAY = timedelta(days=1)
_MINUTE = timedelta(minutes=1)


def _is_even_sha256(agent_id: str) -> bool:
    """Independent oracle for the floor half: even parity of sha256(agent_id)."""
    return int(hashlib.sha256(agent_id.encode("utf-8")).hexdigest(), 16) % 2 == 0


def _get_agent_ids(prefix: str, count: int, *, is_floor: bool) -> list[str]:
    ids: list[str] = []
    ordinal = 0
    while len(ids) < count:
        candidate = f"{prefix}-{ordinal}"
        ordinal += 1
        if _is_even_sha256(candidate) == is_floor:
            ids.append(candidate)
    return ids


def _get_spawn(
    agent_id: str | None,
    started_at: datetime,
    *,
    session_id: str | None = "session",
    overage_rows: int = 0,
    has_subagent_stop: bool = True,
    outcomes: tuple[dict[str, object], ...] = (),
) -> sig.SpawnFacts:
    return sig.SpawnFacts(
        agent_id=agent_id,
        session_id=session_id,
        started_at=started_at,
        overage_rows=overage_rows,
        has_subagent_stop=has_subagent_stop,
        outcomes=outcomes,
    )


def _get_window_spawns(
    prefix: str, start: datetime, *, events: int, quiet: int, session_prefix: str,
    is_floor: bool = True,
) -> list[sig.SpawnFacts]:
    """`events` overage spawns in distinct sessions, then `quiet` overage-free spawns."""
    spawns = [
        _get_spawn(
            agent_id, start + timedelta(hours=index), session_id=f"{session_prefix}-{index}",
            overage_rows=1,
        )
        for index, agent_id in enumerate(_get_agent_ids(f"{prefix}-event", events, is_floor=is_floor))
    ]
    spawns += [
        _get_spawn(agent_id, start + timedelta(hours=index), session_id=f"{session_prefix}-q{index}")
        for index, agent_id in enumerate(_get_agent_ids(f"{prefix}-quiet", quiet, is_floor=is_floor))
    ]
    return spawns


def _get_baseline_spawns(start: datetime, *, events: int, quiet: int) -> list[sig.SpawnFacts]:
    return _get_window_spawns("base", start, events=events, quiet=quiet, session_prefix="base")


def _get_passing_spawns(windows: sig.PairWindows) -> list[sig.SpawnFacts]:
    """Baseline rate 1/10, confirmation rate 5/10, five distinct event sessions per window."""
    return (
        _get_baseline_spawns(windows.start.detection - 20 * _DAY, events=1, quiet=9)
        + _get_window_spawns("det", windows.start.detection, events=5, quiet=0, session_prefix="d")
        + _get_window_spawns("conf", windows.start.confirmation, events=5, quiet=5, session_prefix="c")
    )


def _get_floor(
    spawns: Iterable[sig.SpawnFacts],
    windows: sig.PairWindows,
    *,
    metric_key: str = "budget_overage",
    provenance_start: datetime | None = None,
    evaluated_at: datetime = _NOW,
) -> sig.FloorResult:
    start = windows.start.baseline if provenance_start is None else provenance_start
    return sig.get_floor_verdict(list(spawns), metric_key, windows, start, evaluated_at)


class TestPairWindows(unittest.TestCase):
    """Windows are day-aligned on the most recent UTC midnight, whatever the caller's zone."""

    def test_windows_anchor_on_the_most_recent_utc_midnight(self) -> None:
        kst = timezone(timedelta(hours=9))
        rows = [
            ("mid-day UTC", datetime(2026, 10, 5, 6, 30, tzinfo=_UTC), datetime(2026, 10, 5, tzinfo=_UTC)),
            ("exactly midnight", datetime(2026, 10, 5, tzinfo=_UTC), datetime(2026, 10, 5, tzinfo=_UTC)),
            ("KST morning is the previous UTC day", datetime(2026, 10, 5, 8, 0, tzinfo=kst),
             datetime(2026, 10, 4, tzinfo=_UTC)),
        ]
        for name, now, midnight in rows:
            with self.subTest(name):
                windows = sig.get_pair_windows(now)
                self.assertEqual(windows.end, midnight)
                self.assertEqual(windows.start.confirmation, midnight - 7 * _DAY)
                self.assertEqual(windows.start.detection, midnight - 14 * _DAY)
                self.assertEqual(windows.start.baseline, midnight - 98 * _DAY)

    def test_a_naive_now_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            sig.get_pair_windows(datetime(2026, 10, 5, 6, 30))


class TestNewPairAnchor(unittest.TestCase):
    """A dormant row re-enters only on a pair whose detection starts at or after its transition."""

    def test_a_pair_is_new_only_when_detection_starts_at_or_after_the_transition(self) -> None:
        windows = sig.get_pair_windows(_NOW)
        rows = [
            ("transition one second after detection start", windows.start.detection + timedelta(seconds=1), False),
            ("transition at detection start", windows.start.detection, True),
            ("transition a day before detection start", windows.start.detection - _DAY, True),
        ]
        for name, transition_at, expected in rows:
            with self.subTest(name):
                self.assertIs(sig.is_new_pair(windows, transition_at), expected)


class TestSpawnHalf(unittest.TestCase):
    """The floor half is the sha256 parity of agent_id, stable across interpreter runs."""

    _IDS = [f"a{index:04x}e5c1" for index in range(64)]

    def test_the_half_matches_the_sha256_parity(self) -> None:
        for agent_id in self._IDS:
            self.assertIs(sig.is_floor_half(agent_id), _is_even_sha256(agent_id), agent_id)

    def test_the_half_is_identical_across_interpreter_runs_with_different_hash_seeds(self) -> None:
        script = (
            "import _outcome_signal as s, sys; "
            "print(''.join('1' if s.is_floor_half(i) else '0' for i in sys.argv[1:]))"
        )
        halves = []
        for seed in ("1", "4242"):
            env = {**os.environ, "PYTHONHASHSEED": seed}
            completed = subprocess.run(
                [sys.executable, "-c", script, *self._IDS],
                cwd=_HOOKS_DIR, env=env, capture_output=True, text=True, check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            halves.append(completed.stdout.strip())
        self.assertEqual(halves[0], halves[1])
        self.assertIn("0", halves[0])
        self.assertIn("1", halves[0])


class TestMetricEvents(unittest.TestCase):
    """Which spawn is a metric event, read from daemon-recorded facts only."""

    def test_emit_failure_is_a_missing_stop_or_a_non_writer_outcome(self) -> None:
        rows = [
            ("stop and a writer-emitted outcome", True, ("hook-input",), False),
            ("stop and no outcome row", True, (), False),
            ("no SubagentStop", False, ("hook-input",), True),
            ("synthesized outcome", True, ("completion-synthesized",), True),
            ("structuredoutput-derived outcome", True, ("structuredoutput-derived",), True),
            ("budget-truncation outcome", True, ("budget-truncation",), True),
            ("truncated_completion outcome", True, ("truncated_completion",), True),
            ("one writer and one synthesized outcome", True, ("hook-input", "completion-synthesized"), True),
        ]
        for name, has_stop, attributions, expected in rows:
            with self.subTest(name):
                spawn = _get_spawn(
                    "agent-x", _NOW, has_subagent_stop=has_stop,
                    outcomes=tuple({"attribution_source": source} for source in attributions),
                )
                self.assertIs(sig.is_metric_event(spawn, "emit_failure"), expected)

    def test_a_spawn_with_three_overage_rows_counts_once(self) -> None:
        windows = sig.get_pair_windows(_NOW)
        single = _get_window_spawns("det", windows.start.detection, events=2, quiet=1, session_prefix="d")
        tripled = [
            _get_spawn(s.agent_id, s.started_at, session_id=s.session_id, overage_rows=s.overage_rows * 3)
            for s in single
        ]
        self.assertEqual(_get_floor(tripled, windows).detection, _get_floor(single, windows).detection)
        self.assertEqual(_get_floor(tripled, windows).detection.events, 2)

    def test_an_unknown_metric_key_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            sig.is_metric_event(_get_spawn("agent-x", _NOW), "verified_fail")


class TestOccurrenceFloor(unittest.TestCase):
    """The floor reads windows, counts distinct sessions and the floor half of the covered baseline."""

    def setUp(self) -> None:
        self.windows = sig.get_pair_windows(_NOW)
        self.passing = _get_passing_spawns(self.windows)

    def test_events_split_over_two_batches_pass_when_their_union_passes(self) -> None:
        baseline = [s for s in self.passing if s.started_at < self.windows.start.detection]
        detection = _get_window_spawns("det", self.windows.start.detection, events=5, quiet=0, session_prefix="d")
        confirmation = _get_window_spawns(
            "conf", self.windows.start.confirmation, events=5, quiet=5, session_prefix="c"
        )
        first_batch = baseline + detection[:3] + confirmation[:3]
        second_batch = baseline + detection[3:] + confirmation[3:]
        self.assertEqual(_get_floor(first_batch, self.windows).verdict, sig.VERDICT_FAIL)
        self.assertEqual(_get_floor(second_batch, self.windows).verdict, sig.VERDICT_FAIL)
        union = baseline + detection + confirmation
        self.assertEqual(_get_floor(union, self.windows).verdict, sig.VERDICT_PASS)

    def test_reference_half_baseline_rows_move_no_verdict(self) -> None:
        reference = [
            _get_spawn(agent_id, self.windows.start.detection - 10 * _DAY, overage_rows=1)
            for agent_id in _get_agent_ids("ref", 20, is_floor=False)
        ]
        self.assertEqual(
            _get_floor(self.passing + reference, self.windows), _get_floor(self.passing, self.windows)
        )

    def test_agent_emitted_fields_give_an_identical_metric(self) -> None:
        def get_variant(fields: dict[str, object]) -> list[sig.SpawnFacts]:
            return [
                _get_spawn(
                    s.agent_id, s.started_at, session_id=s.session_id, overage_rows=s.overage_rows,
                    has_subagent_stop=index % 3 != 0,
                    outcomes=({"attribution_source": "completion-synthesized" if index % 2 else "hook-input",
                               **fields},),
                )
                for index, s in enumerate(self.passing)
            ]

        emitted = {"result": "fail", "revision_count": 4, "evaluative_signal": -1, "directive_hint": "redo it"}
        neutral = {"result": "done", "revision_count": 0, "evaluative_signal": 1, "directive_hint": ""}
        for metric_key in sorted(sig.METRIC_KEYS):
            with self.subTest(metric_key):
                emitted_floor = _get_floor(get_variant(emitted), self.windows, metric_key=metric_key)
                self.assertEqual(
                    emitted_floor, _get_floor(get_variant(neutral), self.windows, metric_key=metric_key)
                )
                self.assertGreater(emitted_floor.detection.events, 0)

    def test_only_distinct_named_sessions_count_toward_the_five(self) -> None:
        rows = [
            ("two events in one session", ["s1", "s1", "s2", "s3", "s4"]),
            ("four named sessions and one NULL session", ["s1", "s2", "s3", "s4", None]),
        ]
        for name, sessions in rows:
            with self.subTest(name):
                detection = [
                    _get_spawn(agent_id, self.windows.start.detection + timedelta(hours=index),
                               session_id=session, overage_rows=1)
                    for index, (agent_id, session) in enumerate(
                        zip(_get_agent_ids("dup", 5, is_floor=True), sessions, strict=True)
                    )
                ]
                spawns = [s for s in self.passing if not s.agent_id.startswith("det-")] + detection
                floor = _get_floor(spawns, self.windows)
                self.assertEqual((floor.detection.events, floor.detection.sessions), (5, 4))
                self.assertEqual(floor.verdict, sig.VERDICT_FAIL)

    def test_the_five_session_floor_binds_detection_and_confirmation_alike(self) -> None:
        baseline = [s for s in self.passing if s.started_at < self.windows.start.detection]
        rows = [
            ("five sessions in each window", 5, 5, sig.VERDICT_PASS),
            ("confirmation one session short", 5, 4, sig.VERDICT_FAIL),
            ("detection one session short", 4, 5, sig.VERDICT_FAIL),
        ]
        for name, detection_sessions, confirmation_sessions, expected in rows:
            with self.subTest(name):
                detection = _get_window_spawns(
                    "det", self.windows.start.detection, events=detection_sessions, quiet=0,
                    session_prefix="d",
                )
                confirmation = _get_window_spawns(
                    "conf", self.windows.start.confirmation, events=confirmation_sessions,
                    quiet=confirmation_sessions, session_prefix="c",
                )
                floor = _get_floor(baseline + detection + confirmation, self.windows)
                self.assertEqual(floor.verdict, expected)

    def test_only_a_confirmation_rate_above_the_baseline_rate_passes(self) -> None:
        before_confirmation = [s for s in self.passing if s.started_at < self.windows.start.confirmation]
        rows = [
            ("5/49 is above the baseline 1/10", 44, sig.VERDICT_PASS),
            ("5/50 equals the baseline 1/10", 45, sig.VERDICT_FAIL),
        ]
        for name, quiet, expected in rows:
            with self.subTest(name):
                confirmation = _get_window_spawns(
                    "conf", self.windows.start.confirmation, events=5, quiet=quiet, session_prefix="c"
                )
                floor = _get_floor(before_confirmation + confirmation, self.windows)
                self.assertEqual(floor.verdict, expected)

    def test_detection_and_confirmation_count_spawns_of_both_halves(self) -> None:
        before = _get_floor(self.passing, self.windows)
        rows = [
            ("reference-half spawns in detection", self.windows.start.detection, "detection"),
            ("reference-half spawns in confirmation", self.windows.start.confirmation, "confirmation"),
        ]
        for name, start, window in rows:
            with self.subTest(name):
                reference = _get_window_spawns(
                    "ref", start, events=2, quiet=1, session_prefix="r", is_floor=False
                )
                count = getattr(before, window)
                self.assertEqual(
                    getattr(_get_floor(self.passing + reference, self.windows), window),
                    sig.WindowCount(count.spawns + 3, count.events + 2, count.sessions + 2),
                )

    def test_covered_baseline_span_and_floor_half_gate_the_verdict(self) -> None:
        recent_floor = _get_baseline_spawns(self.windows.start.detection - 5 * _DAY, events=1, quiet=9)
        recent_reference = [
            _get_spawn(agent_id, self.windows.start.detection - 5 * _DAY)
            for agent_id in _get_agent_ids("ref", 10, is_floor=False)
        ]
        in_window = [s for s in self.passing if s.started_at >= self.windows.start.detection]
        rows = [
            ("27 covered days", 27, recent_floor, sig.VERDICT_INSUFFICIENT_BASELINE),
            ("28 covered days with a floor-half spawn", 28, recent_floor, sig.VERDICT_PASS),
            ("28 covered days, reference half only", 28, recent_reference, sig.VERDICT_INSUFFICIENT_BASELINE),
            ("28 covered days, empty baseline", 28, [], sig.VERDICT_INSUFFICIENT_BASELINE),
        ]
        for name, covered_days, baseline, expected in rows:
            with self.subTest(name):
                start = self.windows.start.detection - covered_days * _DAY
                floor = _get_floor(baseline + in_window, self.windows, provenance_start=start)
                self.assertEqual(floor.verdict, expected)

    def test_spawns_outside_the_windows_count_in_no_window(self) -> None:
        provenance_start = self.windows.start.baseline - 30 * _DAY
        rows = [
            ("floor-half spawns one second before the baseline start",
             self.windows.start.baseline - timedelta(seconds=1)),
            ("spawns at the confirmation end", self.windows.end),
            ("spawns an hour after the confirmation end", self.windows.end + timedelta(hours=1)),
        ]
        expected = _get_floor(self.passing, self.windows, provenance_start=provenance_start)
        for name, started_at in rows:
            with self.subTest(name):
                outside = [
                    _get_spawn(agent_id, started_at, session_id=f"o{index}", overage_rows=1)
                    for index, agent_id in enumerate(_get_agent_ids("out", 5, is_floor=True))
                ]
                floor = _get_floor(self.passing + outside, self.windows, provenance_start=provenance_start)
                self.assertEqual(floor, expected)

    def test_no_provenance_start_never_passes(self) -> None:
        floor = sig.get_floor_verdict(self.passing, "budget_overage", self.windows, None, _NOW)
        self.assertEqual(floor.verdict, sig.VERDICT_INSUFFICIENT_BASELINE)

    def test_a_spawn_before_the_provenance_start_counts_on_neither_side(self) -> None:
        provenance_start = self.windows.start.detection - 40 * _DAY
        early = [
            _get_spawn(agent_id, provenance_start - timedelta(seconds=1), overage_rows=1)
            for agent_id in _get_agent_ids("early", 20, is_floor=True)
        ]
        self.assertEqual(
            _get_floor(self.passing + early, self.windows, provenance_start=provenance_start),
            _get_floor(self.passing, self.windows, provenance_start=provenance_start),
        )

    def test_null_agent_id_spawns_count_on_no_side_and_are_reported_unjoinable(self) -> None:
        unjoinable = [
            _get_spawn(None, self.windows.start.confirmation + timedelta(hours=index),
                       session_id=f"u{index}", overage_rows=1)
            for index in range(3)
        ]
        floor = _get_floor(self.passing + unjoinable, self.windows)
        self.assertEqual(floor.unjoinable, 3)
        self.assertEqual(floor._replace(unjoinable=0), _get_floor(self.passing, self.windows))


class TestPendingGrace(unittest.TestCase):
    """A spawn with no SubagentStop yet, started inside the grace before the evaluation instant,
    may still be running → pending under either metric key: counted on no side, reported apart."""

    def test_a_stopless_spawn_inside_the_grace_is_pending_and_an_older_one_is_an_event(self) -> None:
        windows = sig.get_pair_windows(_NOW)
        evaluated_at = windows.end + timedelta(hours=2)
        passing = _get_passing_spawns(windows)
        rows = [
            ("emit_failure, no SubagentStop, 5 h old → pending",
             "emit_failure", timedelta(hours=5), False, 0, (0, 0, 1)),
            ("emit_failure, no SubagentStop, exactly 6 h old → an event",
             "emit_failure", timedelta(hours=6), False, 0, (1, 1, 0)),
            ("emit_failure, no SubagentStop, 7 h old → an event",
             "emit_failure", timedelta(hours=7), False, 0, (1, 1, 0)),
            ("emit_failure, SubagentStop, 5 h old → counted, no event",
             "emit_failure", timedelta(hours=5), True, 0, (1, 0, 0)),
            ("budget_overage, no SubagentStop, overage row, 5 h old → pending",
             "budget_overage", timedelta(hours=5), False, 1, (0, 0, 1)),
            ("budget_overage, no SubagentStop, overage row, 7 h old → an event",
             "budget_overage", timedelta(hours=7), False, 1, (1, 1, 0)),
        ]
        agent_id = _get_agent_ids("grace", 1, is_floor=True)[0]
        for name, metric_key, age, has_stop, overage_rows, (spawns, events, pending) in rows:
            with self.subTest(name):
                spawn = _get_spawn(
                    agent_id, evaluated_at - age, session_id="g", has_subagent_stop=has_stop,
                    overage_rows=overage_rows,
                )
                before = _get_floor(passing, windows, metric_key=metric_key, evaluated_at=evaluated_at)
                floor = _get_floor(
                    [*passing, spawn], windows, metric_key=metric_key, evaluated_at=evaluated_at
                )
                count = before.confirmation
                self.assertEqual(
                    (floor.confirmation, floor.pending),
                    (sig.WindowCount(count.spawns + spawns, count.events + events,
                                     count.sessions + events), pending),
                )


@unittest.skipIf(pgdw is None, f"import failed: {_IMPORT_ERROR}")
class TestPatternFloorReadFailure(unittest.TestCase):
    """The window read fails closed: a read failure → None plus one stderr JSON line."""

    def setUp(self) -> None:
        self.windows = sig.get_pair_windows(_NOW)

    def test_a_read_failure_returns_none_and_reports_the_op(self) -> None:
        table_absent = mock.MagicMock()
        table_absent.__enter__.return_value = table_absent
        table_absent.cursor.return_value.__enter__.return_value.execute.side_effect = (
            pgdw.pg_errors.UndefinedTable('relation "core.spawn_manifest" does not exist')
        )
        rows = [
            ("connection error", mock.Mock(side_effect=pgdw.psycopg.OperationalError("refused")),
             "OperationalError"),
            ("undefined table", mock.Mock(return_value=table_absent), "UndefinedTable"),
        ]
        for name, connect, error_kind in rows:
            with self.subTest(name), mock.patch.object(pgdw.psycopg, "connect", connect):
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr):
                    floor = pgdw.read_pattern_floor("agent-x", "emit_failure", self.windows, _NOW)
                self.assertIsNone(floor)
                report = json.loads(stderr.getvalue())
                self.assertEqual(
                    (report["op"], report["error_kind"], report["metric_key"]),
                    ("read_pattern_floor", error_kind, "emit_failure"),
                )

    def test_a_set_read_failure_returns_none_and_reports_the_op(self) -> None:
        connect = mock.Mock(side_effect=pgdw.psycopg.OperationalError("refused"))
        stderr = io.StringIO()
        with mock.patch.object(pgdw.psycopg, "connect", connect):
            with contextlib.redirect_stderr(stderr):
                floors = pgdw.read_pattern_floors(["agent-x", "agent-y"], self.windows, _NOW)
        self.assertIsNone(floors)
        report = json.loads(stderr.getvalue())
        self.assertEqual(
            (report["op"], report["error_kind"], report["agents"]),
            ("read_pattern_floors", "OperationalError", 2),
        )

    def test_an_unknown_metric_key_is_refused_before_any_connect(self) -> None:
        with mock.patch.object(pgdw.psycopg, "connect") as connect:
            with self.assertRaises(ValueError):
                pgdw.read_pattern_floor("agent-x", "verified_fail", self.windows, _NOW)
        connect.assert_not_called()


@unittest.skipIf(pgdw is None, f"import failed: {_IMPORT_ERROR}")
class TestPatternFloorsSetRead(unittest.TestCase):
    """Every agent's floors come from one provenance read and one spawn read, per agent."""

    def test_one_spawn_read_serves_both_keys_of_every_agent(self) -> None:
        windows = sig.get_pair_windows(_NOW)
        passing = _get_passing_spawns(windows)
        rows = [("glass-atrium-dev-python", *spawn) for spawn in passing]
        cursor = mock.MagicMock()
        cursor.fetchone.return_value = (windows.start.baseline,)
        cursor.fetchall.return_value = rows
        conn = mock.MagicMock()
        conn.__enter__.return_value = conn
        conn.cursor.return_value.__enter__.return_value = cursor
        agents = ["glass-atrium-dev-python", "glass-atrium-dev-shell", "glass-atrium-dev-python"]
        with mock.patch.object(pgdw.psycopg, "connect", return_value=conn):
            floors = pgdw.read_pattern_floors(agents, windows, _NOW)
        spawn_reads = [c for c in cursor.execute.call_args_list if len(c.args) > 1]
        self.assertEqual(
            (cursor.execute.call_count, sorted(spawn_reads[0].args[1][0])),
            (2, ["glass-atrium-dev-python", "glass-atrium-dev-shell"]),
        )
        spawns_by_agent = {"glass-atrium-dev-python": passing, "glass-atrium-dev-shell": []}
        expected = {
            (agent, key): _get_floor(spawns, windows, metric_key=key, evaluated_at=_NOW)
            for agent, spawns in spawns_by_agent.items()
            for key in sig.METRIC_KEYS
        }
        self.assertEqual(floors, expected)


def _load_aggregator():  # noqa: ANN202 — module object
    """Import learning-aggregator.py despite its dashed name; loading runs no PG code."""
    spec = importlib.util.spec_from_file_location(
        "learning_aggregator", _HOOKS_DIR / "learning-aggregator.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    with contextlib.redirect_stderr(io.StringIO()):
        spec.loader.exec_module(module)
    return module


agg = _load_aggregator()
_WINDOWS = sig.get_pair_windows(_NOW)
_PYTHON = "glass-atrium-dev-python"
_SHELL = "glass-atrium-dev-shell"
_PATTERN1_CORE = "repeated failure by same agent"
_PATTERN5_CORE = "agent instruction-improvement candidate (failure rate)"
_BUDGET_CORE = "budget-overage concentration"
_EMIT_FAILURE_CORE = "emit-failure concentration"


def _get_outcome(agent: str, record_ts: datetime | None, result: str = "blocked") -> dict:
    return {
        "record_ts": record_ts, "pg_audit_ref": f"pg:{agent}", "agent": agent,
        "task_type": "feature", "result": result, "revision_count": 0, "review_flag": False,
        "grader_verdict": "", "metric_pass": None, "lesson": "pinned lesson",
        "attribution_source": "hook-input",
    }


def _get_spike(agent: str, at: datetime) -> list[dict]:
    """Three negative rows: patterns 1 and 5 both hold for `agent` over them."""
    return [_get_outcome(agent, at + timedelta(minutes=m)) for m in range(3)]


def _get_held_window(agent: str) -> list[dict]:
    return _get_spike(agent, _WINDOWS.start.detection + _DAY) + _get_spike(
        agent, _WINDOWS.start.confirmation + _DAY
    )


def _get_overrun_spike(agent: str, at: datetime) -> list[dict]:
    """Three measured rows overrunning their declared [SIZE-EST]: pattern 8 holds over them."""
    body = "# Outcome Record\n\n- **Tool use**: actual=40 declared=20\n"
    return [
        {"agent": agent, "body_md": body, "record_ts": at + timedelta(minutes=m)}
        for m in range(3)
    ]


class _FakeLearningLog:
    """core.learning_log stand-in with the writers' contracts: the upsert keeps a stored
    'dormant'; the status writer moves only a row holding the other pair member."""

    def __init__(self) -> None:
        self.rows: dict[str, dict] = {}
        self.upserts: list[dict] = []

    def put_row(self, signature: str, status: str, transition_at: datetime | None = None) -> None:
        self.rows[signature] = {
            "id": len(self.rows) + 1, "frequency": 3, "status": status,
            "last_transition_at": transition_at, "reason": None,
        }

    def read(self) -> dict:
        out = {}
        for signature, row in self.rows.items():
            core, agent = signature.split("|", 1)
            out[(core, agent)] = {**row, "approval_tier": "user-pending"}
        return out

    def upsert(self, **kwargs: object) -> None:
        self.upserts.append(kwargs)
        row = self.rows.get(kwargs["pattern_signature"])
        if row is None:
            self.put_row(kwargs["pattern_signature"], kwargs["status"])
        elif row["status"] != "dormant":
            row["status"] = kwargs["status"]

    def put_status(self, pattern_id: int, status: str, reason: str) -> SimpleNamespace:
        row = next(r for r in self.rows.values() if r["id"] == pattern_id)
        if row["status"] == status or row["status"] not in ("identified", "dormant"):
            return SimpleNamespace(outcome="not_matched", row_id=None)
        row.update(status=status, reason=reason, last_transition_at=_NOW)
        return SimpleNamespace(outcome="moved", row_id=pattern_id)

    def get_status(self, signature: str) -> str:
        return self.rows[signature]["status"]


class _AggregatorRun(unittest.TestCase):
    """main() over fake seams: batch and window outcome reads, floors, the learning log."""

    def setUp(self) -> None:
        self.log = _FakeLearningLog()
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.scratch = Path(scratch.name)
        self.registry = self.scratch / "agent-registry.json"
        roster = {"agents": {_PYTHON: {}, _SHELL: {}}}
        self.registry.write_text(json.dumps(roster), encoding="utf-8")

    def _run(self, *, batch: Iterable[dict] = (), window: list[dict] | None = None,
             floors: dict[tuple[str, str], str | None] | None = None,
             overages: Iterable[str] = (), size_est: Iterable[dict] = (),
             is_floor_unreadable: bool = False, aggregator: ModuleType | None = None) -> str:
        floors = floors or {}
        batch, overages, size_est = list(batch), list(overages), list(size_est)
        module = aggregator or agg
        self.floor_reads: list[list[str]] = []

        def _read_floors(agents: Iterable[str], windows: object, evaluated_at: object):  # noqa: ANN202
            agents = list(agents)
            self.floor_reads.append(agents)
            if is_floor_unreadable:
                return None
            return {
                (agent, key): SimpleNamespace(verdict=floors.get((agent, key), sig.VERDICT_FAIL))
                for agent in agents for key in sig.METRIC_KEYS
            }

        patches = {
            "HAS_PG_DUALWRITE": True,
            "AUDIT_QUEUE_FILE": str(self.scratch / "audit-queue.txt"),
            "AUDIT_QUEUE_PG_OFFSET_FILE": str(self.scratch / "audit-queue-pg-offset"),
            "_get_utc_now": lambda: _NOW,
            "_pg_read_aggregator_watermark": lambda name: 0.0,
            "_pg_read_outcomes_since": lambda since: batch,
            "_pg_read_outcome_window": lambda since: window,
            "_pg_read_learning_log_signatures": self.log.read,
            "_pg_upsert_learning_pattern": self.log.upsert,
            "_pg_put_learning_pattern_status": self.log.put_status,
            "_pg_read_pattern_floors": _read_floors,
            "_pg_update_aggregator_state": lambda **kw: None,
            "_pg_batch_complete": lambda summary: None,
            "_pg_insert_audit_queue_rows": lambda rows: 0,
            "_pg_insert_liveness_observation": lambda **kw: True,
            "_read_budget_overages": lambda since: [{"agent_type": a} for a in overages],
            "_read_size_est_pairs": lambda since: [],
            "_read_size_est_window": lambda since: size_est if window is not None else None,
        }
        # only a failed dual-write import leaves _pg_* seams absent; any other miss must raise
        is_import_failed = not module.HAS_PG_DUALWRITE
        for name, value in patches.items():
            is_created = is_import_failed and name.startswith("_pg_")
            patcher = mock.patch.object(module, name, value, create=is_created)
            patcher.start()
            self.addCleanup(patcher.stop)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            module.main(registry_path=str(self.registry))
        return stderr.getvalue()

    def _get_keys(self) -> dict[str, object]:
        return {u["pattern_signature"]: u.get("metric_key") for u in self.log.upserts}


class TestAggregatorKeyedEmit(_AggregatorRun):
    """A keyed pattern is written only when its S2f floor passes; discovery rows stay keyless."""

    def test_a_keyed_row_is_emitted_only_when_its_floor_passes(self) -> None:
        self._run(
            batch=[_get_outcome(_PYTHON, _NOW, "done")],
            window=[],
            overages=[_PYTHON] * 3 + [_SHELL] * 3,
            floors={(_PYTHON, sig.METRIC_BUDGET_OVERAGE): sig.VERDICT_PASS,
                    (_SHELL, sig.METRIC_BUDGET_OVERAGE): sig.VERDICT_FAIL,
                    (_SHELL, sig.METRIC_EMIT_FAILURE): sig.VERDICT_INSUFFICIENT_BASELINE},
        )
        self.assertEqual(self._get_keys(), {f"{_BUDGET_CORE}|{_PYTHON}": sig.METRIC_BUDGET_OVERAGE})

    def test_one_floor_read_per_run_covers_each_candidate_agent_once(self) -> None:
        stored_only = "glass-atrium-dev-db"
        self.log.put_row(f"{_EMIT_FAILURE_CORE}|{stored_only}", "dormant")
        self._run(window=[])
        self.assertEqual(
            [sorted(agents) for agents in self.floor_reads], [[stored_only, _PYTHON, _SHELL]]
        )

    def test_each_family_row_carries_its_key_and_discovery_rows_none(self) -> None:
        self._run(
            batch=_get_spike(_PYTHON, _NOW - timedelta(hours=2)),
            window=_get_held_window(_PYTHON),
            floors={(_PYTHON, sig.METRIC_BUDGET_OVERAGE): sig.VERDICT_PASS,
                    (_PYTHON, sig.METRIC_EMIT_FAILURE): sig.VERDICT_PASS},
        )
        self.assertEqual(self._get_keys(), {
            f"{_PATTERN1_CORE}|{_PYTHON}": None,
            f"{_PATTERN5_CORE}|{_PYTHON}": None,
            f"{_BUDGET_CORE}|{_PYTHON}": sig.METRIC_BUDGET_OVERAGE,
            f"{_EMIT_FAILURE_CORE}|{_PYTHON}": sig.METRIC_EMIT_FAILURE,
        })


class TestAggregatorPairStatus(_AggregatorRun):
    """Every family row in the identified/dormant pair takes its status from the pair verdict."""

    def test_a_keyless_row_emitted_in_one_batch_but_failing_its_pair_is_written_dormant(
        self,
    ) -> None:
        self._run(batch=_get_spike(_PYTHON, _NOW - timedelta(hours=2)), window=[])
        for core in (_PATTERN1_CORE, _PATTERN5_CORE):
            row = self.log.rows[f"{core}|{_PYTHON}"]
            self.assertEqual(row["status"], "dormant", core)
            self.assertTrue(row["reason"].startswith(agg.PAIR_REASON_PREFIX), row["reason"])

    def test_a_keyless_row_holding_its_rule_in_both_windows_stays_identified(self) -> None:
        self._run(
            batch=_get_spike(_PYTHON, _NOW - timedelta(hours=2)), window=_get_held_window(_PYTHON)
        )
        for core in (_PATTERN1_CORE, _PATTERN5_CORE):
            self.assertEqual(self.log.get_status(f"{core}|{_PYTHON}"), "identified", core)

    def test_a_dormant_row_returns_only_on_a_new_passing_pair(self) -> None:
        detection = _WINDOWS.start.detection
        rows = [
            ("pair started before the transition", _PYTHON, detection + _DAY, "dormant"),
            ("pair started after the transition", _SHELL, detection - _DAY, "identified"),
        ]
        for _, agent, transition_at, _ in rows:
            self.log.put_row(f"{_PATTERN1_CORE}|{agent}", "dormant", transition_at)
        self._run(window=_get_held_window(_PYTHON) + _get_held_window(_SHELL))
        for name, agent, _, expected in rows:
            self.assertEqual(self.log.get_status(f"{_PATTERN1_CORE}|{agent}"), expected, name)

    def test_an_empty_batch_run_sweeps_rows_it_does_not_emit(self) -> None:
        rows = [
            ("legacy keyless row failing its pair", f"{_PATTERN5_CORE[:-1]} )|{_SHELL}", "dormant"),
            ("keyless row holding its pair", f"{_PATTERN1_CORE}|{_PYTHON}", "identified"),
            ("keyed row failing its floor", f"{_BUDGET_CORE}|{_SHELL}", "dormant"),
            ("keyed row passing its floor", f"{_BUDGET_CORE}|{_PYTHON}", "identified"),
            ("row of no aggregator family", f"hand-written pattern|{_SHELL}", "identified"),
        ]
        for _, signature, _ in rows:
            self.log.put_row(signature, "identified")
        self._run(window=_get_held_window(_PYTHON),
                  floors={(_PYTHON, sig.METRIC_BUDGET_OVERAGE): sig.VERDICT_PASS})
        for name, signature, expected in rows:
            self.assertEqual(self.log.get_status(signature), expected, name)

    def test_a_size_est_row_takes_its_status_from_both_windows(self) -> None:
        core = agg._get_signature_core(f"{agg.SIZE_EST_UNDER_LABEL} (avg overrun +20 tool_uses)")
        detection, confirmation = _WINDOWS.start.detection, _WINDOWS.start.confirmation
        rows = [
            ("rule holds in detection and confirmation", _PYTHON, "identified"),
            ("rule holds in detection only", _SHELL, "dormant"),
        ]
        for _, agent, _ in rows:
            self.log.put_row(f"{core}|{agent}", "identified")
        self._run(
            window=[],
            size_est=_get_overrun_spike(_PYTHON, detection + _DAY)
            + _get_overrun_spike(_PYTHON, confirmation + _DAY)
            + _get_overrun_spike(_SHELL, detection + _DAY),
        )
        for name, agent, expected in rows:
            self.assertEqual(self.log.get_status(f"{core}|{agent}"), expected, name)

    def test_a_window_row_the_input_filter_excludes_contributes_to_no_pair(self) -> None:
        signature = f"{_PATTERN1_CORE}|{_PYTHON}"
        self.log.put_row(signature, "identified")
        excluded = [
            {**row, "attribution_source": "agent-id-missing"} for row in _get_held_window(_PYTHON)
        ]
        self._run(window=excluded)
        self.assertEqual(self.log.get_status(signature), "dormant")

    def test_a_data_root_without_an_outcomes_dir_still_sweeps(self) -> None:
        base_root = self.scratch / "ga-root"
        (base_root / "data").mkdir(parents=True)
        with mock.patch.dict(os.environ, {"GA_DATA_ROOT": str(base_root)}):
            scratch_agg = _load_aggregator()
        signature = f"{_PATTERN1_CORE}|{_SHELL}"
        self.log.put_row(signature, "identified")
        self._run(window=[], aggregator=scratch_agg)
        self.assertEqual(self.log.get_status(signature), "dormant")

    def test_an_unreadable_window_or_floor_moves_no_row(self) -> None:
        signatures = (f"{_PATTERN5_CORE}|{_SHELL}", f"{_BUDGET_CORE}|{_SHELL}")
        for signature in signatures:
            self.log.put_row(signature, "identified")
        stderr = self._run(window=None, is_floor_unreadable=True)
        for signature in signatures:
            self.assertEqual(self.log.get_status(signature), "identified", signature)
        self.assertIn("no keyless pair verdict", stderr)
        self.assertIn("no keyed pair verdict", stderr)


@unittest.skipIf(pgdw is None, f"import failed: {_IMPORT_ERROR}")
class TestAggregatorAndIntakeAgree(unittest.TestCase):
    """The aggregator's status sweep and the daemon's intake re-check read one pair: on one
    UTC day, over a fixture with no spawn pending at either instant, both reach the same
    verdict from the same rates."""

    def test_both_actors_read_one_pair_on_one_utc_day(self) -> None:
        import daemon_cycle as dc
        from _pg_seal import seal_pg_reach

        day = _WINDOWS.end
        aggregated_at, rechecked_at = day + timedelta(minutes=5), day + timedelta(hours=23, minutes=55)
        provenance_start = _WINDOWS.start.baseline
        fixture = (provenance_start, {_PYTHON: _get_passing_spawns(_WINDOWS)})
        log = _FakeLearningLog()
        # re-entered from 'dormant' on a new pair today: the anchor gates no 'identified' row
        log.put_row(f"{_BUDGET_CORE}|{_PYTHON}", "identified", day + timedelta(minutes=1))
        log.put_row(f"{_EMIT_FAILURE_CORE}|{_PYTHON}", "identified")
        daemon_floors: list[dict] = []

        def _read_daemon_floors(agents, windows, evaluated_at):
            daemon_floors.append(pgdw.read_pattern_floors(agents, windows, evaluated_at))
            return daemon_floors[-1]

        reach = seal_pg_reach(self)
        with mock.patch.object(pgdw, "_read_spawn_facts", lambda agents, windows: fixture), \
                mock.patch.object(agg, "_pg_put_learning_pattern_status", log.put_status), \
                mock.patch.object(dc, "HAS_PG_PATTERN_READ", True), \
                mock.patch.object(dc, "_pg_read_pattern_floors", _read_daemon_floors), \
                mock.patch.object(dc, "_get_utc_now", lambda: rechecked_at), \
                mock.patch.object(dc, "_invoke_pg_helper", lambda envelope: True), \
                contextlib.redirect_stderr(io.StringIO()):
            windows = sig.get_pair_windows(aggregated_at)
            aggregator_floors = agg._get_keyed_floors({_PYTHON}, windows, aggregated_at)
            agg._put_pair_statuses(log.read(), set(), aggregator_floors, windows)
            patterns = [
                _get_intake_pattern(dc, core, key, row["id"])
                for core, key, row in (
                    (_BUDGET_CORE, sig.METRIC_BUDGET_OVERAGE, log.rows[f"{_BUDGET_CORE}|{_PYTHON}"]),
                    (_EMIT_FAILURE_CORE, sig.METRIC_EMIT_FAILURE,
                     log.rows[f"{_EMIT_FAILURE_CORE}|{_PYTHON}"]),
                )
            ]
            kept = dc.drop_pair_failing_patterns(_PYTHON, patterns)

        self.assertEqual(reach, [])
        self.assertEqual(
            {(core, agent): floor for (core, agent), floor in aggregator_floors.items()},
            {(core, _PYTHON): daemon_floors[0][(_PYTHON, key)]
             for core, key in ((_BUDGET_CORE, sig.METRIC_BUDGET_OVERAGE),
                               (_EMIT_FAILURE_CORE, sig.METRIC_EMIT_FAILURE))},
        )
        statuses = {core: log.get_status(f"{core}|{_PYTHON}") for core in (_BUDGET_CORE, _EMIT_FAILURE_CORE)}
        self.assertEqual(statuses, {_BUDGET_CORE: "identified", _EMIT_FAILURE_CORE: "dormant"})
        self.assertEqual([pattern.metric_key for pattern in kept], [sig.METRIC_BUDGET_OVERAGE])


def _get_intake_pattern(dc: ModuleType, core: str, metric_key: str, row_id: int):
    return dc.Pattern(
        date=f"{_WINDOWS.end:%Y-%m-%d}", label=core, frequency="1", agent=_PYTHON,
        status="identified", tier="user-pending",
        raw_line=f"pg:learning_log:{row_id}:{core}|{_PYTHON}", row_id=row_id, metric_key=metric_key,
    )


@unittest.skipIf(pgdw is None, f"import failed: {_IMPORT_ERROR}")
class TestOutcomeWindowReadFailure(unittest.TestCase):
    """The window read reports an outage as None; the batch read keeps its empty fallback."""

    def test_a_read_failure_is_none_for_the_window_and_empty_for_the_batch(self) -> None:
        def _refuse(*_args: object, **_kwargs: object) -> None:
            raise OSError("connection refused")

        with mock.patch.object(pgdw, "psycopg", SimpleNamespace(connect=_refuse)), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertIsNone(pgdw.read_outcome_window(0.0))
            self.assertEqual(pgdw.read_outcomes_since(0.0), [])
        self.assertIn('"op":"read_outcome_window"', err.getvalue())


class _NonCommittingConn:
    """Hand the read an open transaction; its context exit neither commits nor closes."""

    def __init__(self, conn: object) -> None:
        self._conn = conn

    def __enter__(self) -> _NonCommittingConn:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def cursor(self):  # noqa: ANN201 — real psycopg cursor, type lives upstream
        return self._conn.cursor()

    def execute(self, *args: object):
        return self._conn.execute(*args)


@unittest.skipIf(pgdw is None, f"import failed: {_IMPORT_ERROR}")
class TestPatternFloorReadLivePg(unittest.TestCase):
    """The window read's SQL over seeded rows of the four source tables; skips off the runner."""

    _AGENT = "glass-atrium-dev-python"
    _SPOOL = "inject-scope-rules.manifest.log.20261005T060000Z.4343.spool"

    def setUp(self) -> None:
        from _pg_seal import get_ephemeral_connection

        self.conn = get_ephemeral_connection()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        self.windows = sig.get_pair_windows(_NOW)
        with self.conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM core.spawn_manifest")
            self.assertEqual(cur.fetchone()[0], 0, "core.spawn_manifest must start empty")
        patcher = mock.patch.object(
            pgdw, "psycopg", SimpleNamespace(connect=lambda *a, **k: _NonCommittingConn(self.conn))
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _put_spawn(self, offset: int, agent_id: str | None, started_at: datetime,
                   *, agent_type: str = _AGENT, session_id: str | None = "s") -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO core.spawn_manifest (spool, line_offset, agent_id, agent_type, session_id, "
                " started_at, ctx_bytes, blocks) VALUES (%s, %s, %s, %s, %s, %s, 0, '')",
                (self._SPOOL, offset, agent_id, agent_type, session_id, started_at),
            )

    def _put_overages(self, agent_id: str, count: int) -> None:
        with self.conn.cursor() as cur:
            for index in range(count):
                cur.execute(
                    "INSERT INTO core.budget_overages (agent_id, agent_type, tool_use_count, budget, "
                    " crossed_pct) VALUES (%s, %s, %s, 40, 70)",
                    (agent_id, self._AGENT, 28 + index),
                )

    def _put_stop(self, agent_id: str, event_ts: datetime) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO core.agent_events (event_ts, event_name, agent_id, agent_type) "
                "VALUES (%s, 'SubagentStop', %s, %s)",
                (event_ts, agent_id, self._AGENT),
            )

    def _put_outcome(self, agent_id: str, record_ts: datetime, attribution: str, result: str,
                     *, grader_verdict: str | None = None, body_md: str | None = None) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO core.outcomes (record_ts, agent, task_type, result, summary, "
                ' attribution_source, agent_id, grader_verdict, body_md) VALUES (%s, %s, '
                ' \'feature\'::core."TaskType", %s::core."OutcomeResult", \'s2f fixture\', %s, %s, '
                ' %s::core."GraderVerdict", %s)',
                (record_ts, self._AGENT, result, attribution, agent_id, grader_verdict, body_md),
            )

    def _seed(self) -> None:
        w = self.windows
        # a session-less MANIFEST line before the provenance start → counted on no side
        early = _get_agent_ids("live-early", 1, is_floor=True)
        self._put_spawn(9, early[0], w.start.baseline + timedelta(hours=12), session_id=None)
        self._put_spawn(0, "prov", w.start.baseline + _DAY, agent_type="glass-atrium-dev-shell")
        base_floor = _get_agent_ids("live-base", 2, is_floor=True)
        base_reference = _get_agent_ids("live-ref", 1, is_floor=False)
        detection = _get_agent_ids("live-det", 3, is_floor=True)
        self._put_spawn(1, base_floor[0], w.start.baseline + 10 * _DAY)
        self._put_overages(base_floor[0], 3)
        self._put_spawn(2, base_floor[1], w.start.baseline + 11 * _DAY)
        self._put_stop(base_floor[1], w.start.baseline + 11 * _DAY)
        self._put_spawn(3, base_reference[0], w.start.baseline + 12 * _DAY)
        self._put_overages(base_reference[0], 1)
        for offset, (agent_id, session) in enumerate(zip(detection, ["d0", "d0", "d1"], strict=True), 4):
            started = w.start.detection + offset * timedelta(hours=1)
            self._put_spawn(offset, agent_id, started, session_id=session)
            self._put_stop(agent_id, started + timedelta(minutes=5))
        self._put_overages(detection[0], 2)
        self._put_outcome(detection[1], w.start.detection + _DAY, "completion-synthesized", "done_with_concerns")
        self._put_outcome(detection[2], w.start.detection + 2 * _DAY, "hook-input", "fail")
        self._put_spawn(7, None, w.start.confirmation + _DAY, session_id="c0")
        self._put_spawn(8, "other-agent", w.start.confirmation + _DAY, agent_type="glass-atrium-dev-shell")
        self._put_overages("other-agent", 1)

    def test_the_window_read_returns_the_expected_per_agent_counts(self) -> None:
        self._seed()
        rows = [
            ("budget_overage", sig.WindowCount(2, 1, 1), sig.WindowCount(3, 1, 1)),
            ("emit_failure", sig.WindowCount(2, 1, 1), sig.WindowCount(3, 1, 1)),
        ]
        for metric_key, baseline, detection in rows:
            with self.subTest(metric_key):
                floor = pgdw.read_pattern_floor(self._AGENT, metric_key, self.windows, _NOW)
                self.assertIsNotNone(floor)
                self.assertEqual(floor.baseline, baseline)
                self.assertEqual(floor.detection, detection)
                self.assertEqual(floor.confirmation, sig.WindowCount(0, 0, 0))
                self.assertEqual(floor.unjoinable, 1)
                self.assertEqual(floor.verdict, sig.VERDICT_FAIL)

    def test_the_set_read_gives_each_agent_the_floors_of_its_own_read(self) -> None:
        self._seed()
        agents = [self._AGENT, "glass-atrium-dev-shell"]
        floors = pgdw.read_pattern_floors(agents, self.windows, _NOW)
        expected = {
            (agent, key): pgdw.read_pattern_floor(agent, key, self.windows, _NOW)
            for agent in agents for key in sig.METRIC_KEYS
        }
        self.assertEqual(floors, expected)
        self.assertNotEqual(expected[(agents[0], "budget_overage")],
                            expected[(agents[1], "budget_overage")])

    def test_the_evidence_read_gives_each_triggering_spawn_its_own_outcome_facts(self) -> None:
        w = self.windows
        self._put_spawn(0, "prov", w.start.baseline + _DAY, agent_type="glass-atrium-dev-shell")
        graded, ungraded = "live-evidence-graded", "live-evidence-ungraded"
        for offset, agent_id in enumerate((graded, ungraded), 1):
            started = w.start.confirmation + offset * _DAY
            self._put_spawn(offset, agent_id, started, session_id=f"c{offset}")
            self._put_stop(agent_id, started + timedelta(minutes=5))
            self._put_overages(agent_id, 1)
        recorded = w.start.confirmation + 3 * _DAY
        self._put_outcome(graded, recorded, "hook-input", "fail", grader_verdict="verified_fail",
                          body_md="## Summary\n\nfixture\n- **Tool use**: actual=37 declared=30\n")
        self._put_outcome(graded, recorded + _MINUTE, "hook-input", "done", grader_verdict="verified_pass",
                          body_md="## Summary\n\nfixture\n- **Tool use**: actual=12\n")
        self._put_outcome(ungraded, recorded + 2 * _MINUTE, "hook-input", "done", body_md="## Summary\n\nfixture\n")

        evidence = pgdw.read_pattern_evidence(self._AGENT, self.windows, _NOW)

        self.assertIsNotNone(evidence, "the evidence read failed — see the stderr op line")
        facts = {
            spawn.agent_id: (spawn.verified_fail_rows, spawn.tool_use_actual)
            for spawn in evidence["budget_overage"].triggering
        }
        self.assertEqual(facts, {graded: (1, 37), ungraded: (0, None)})


@unittest.skipIf(pgdw is None, f"import failed: {_IMPORT_ERROR}")
class TestLearningLogSignatureReadLivePg(unittest.TestCase):
    """The aggregator's stored-row read carries each row's id and last transition time."""

    def setUp(self) -> None:
        from _pg_seal import get_ephemeral_connection

        self.conn = get_ephemeral_connection()
        self.addCleanup(self.conn.close)
        self.addCleanup(self.conn.rollback)
        patcher = mock.patch.object(
            pgdw, "psycopg", SimpleNamespace(connect=lambda *a, **k: _NonCommittingConn(self.conn))
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_each_stored_row_reads_with_its_id_and_transition_time(self) -> None:
        transition_at = datetime(2026, 9, 20, 4, 0, tzinfo=_UTC)
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO core.learning_log (discovered_date, pattern_signature, frequency, "
                " agent, status, approval_tier, last_updated, last_transition_at) "
                " VALUES ('2026-09-20', 'pair read probe|glass-atrium-dev-db', 4, "
                " 'glass-atrium-dev-db', 'identified', 'user-pending', now(), %s) RETURNING id",
                (transition_at,),
            )
            row_id = cur.fetchone()[0]
        stored = pgdw.read_learning_log_signatures()[("pair read probe", "glass-atrium-dev-db")]
        self.assertEqual((stored["id"], stored["last_transition_at"]), (row_id, transition_at))


if __name__ == "__main__":
    unittest.main()
