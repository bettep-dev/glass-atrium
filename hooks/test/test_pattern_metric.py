#!/usr/bin/env python3
"""The shared per-pattern metric: pair windows, the sha256 spawn half and the occurrence floor.

The pure classes need no database. ``TestPatternFloorReadLivePg`` runs the window read's SQL on
the ephemeral cluster of ``autoagent/test/live-pg-ephemeral.bats`` and skips anywhere else.

    python3 -m unittest -v test_pattern_metric   (cwd: hooks/test)
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import unittest
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_TEST_DIR = _REPO_ROOT / "autoagent" / "test"
for _path in (_HOOKS_DIR, _AUTOAGENT_TEST_DIR):
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
) -> sig.FloorResult:
    start = windows.start.baseline if provenance_start is None else provenance_start
    return sig.get_floor_verdict(list(spawns), metric_key, windows, start)


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

    def test_the_passing_fixture_passes(self) -> None:
        self.assertEqual(_get_floor(self.passing, self.windows).verdict, sig.VERDICT_PASS)

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

    def test_same_session_events_count_once_toward_the_five(self) -> None:
        detection = [
            _get_spawn(agent_id, self.windows.start.detection + timedelta(hours=index),
                       session_id=session, overage_rows=1)
            for index, (agent_id, session) in enumerate(
                zip(_get_agent_ids("dup", 5, is_floor=True), ["s1", "s1", "s2", "s3", "s4"], strict=True)
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

    def test_no_provenance_start_never_passes(self) -> None:
        floor = sig.get_floor_verdict(self.passing, "budget_overage", self.windows, None)
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

    def _put_outcome(self, agent_id: str, record_ts: datetime, attribution: str, result: str) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO core.outcomes (record_ts, agent, task_type, result, summary, "
                ' attribution_source, agent_id) VALUES (%s, %s, \'feature\'::core."TaskType", '
                ' %s::core."OutcomeResult", \'s2f fixture\', %s, %s)',
                (record_ts, self._AGENT, result, attribution, agent_id),
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
                floor = pgdw.read_pattern_floor(self._AGENT, metric_key, self.windows)
                self.assertIsNotNone(floor)
                self.assertEqual(floor.baseline, baseline)
                self.assertEqual(floor.detection, detection)
                self.assertEqual(floor.confirmation, sig.WindowCount(0, 0, 0))
                self.assertEqual(floor.unjoinable, 1)
                self.assertEqual(floor.verdict, sig.VERDICT_FAIL)


if __name__ == "__main__":
    unittest.main()
