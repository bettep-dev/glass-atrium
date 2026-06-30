"""Contract tests for the PG proposal-generation intake (AP-2).

``read_user_pending_patterns`` in ``autoagent/daemon_cycle.py`` reads intake
rows from PG ``core.learning_log`` via
``hooks/_pg_learning_dualwrite.read_pending_learning_patterns`` — the same
module whose ``upsert_learning_pattern`` the aggregator writes through, so
write target and read target cannot diverge. Protected invariants:
(1) a pattern written through the aggregator upsert is visible to the intake
    (write-target == read-target);
(2) rename contract — every agent in returned patterns is an ``agents/*.md``
    stem, and a roster-mismatch row produces a WARN record (stderr line +
    ``eval_result='roster-mismatch'`` loop-event envelope), never a silent skip.

Live-PG classes insert fixtures in an open, never-committed transaction
(rolled back on teardown — the database is left byte-identical; no DELETE
needed). Loop-event emission is captured by a recorder in place of
``_invoke_pg_helper``, so no test writes ``core.autoagent_loop_events``.

Mirrors the deleted autoagent/test conventions (unittest, ``sys.path``
insertion). Run with either runner:
    uv run --with pytest pytest autoagent/test/test_pg_pattern_intake.py -v
    python3 -m unittest autoagent.test.test_pg_pattern_intake -v

CID: 2026-06-10T0810_atrium-normalize_b3f1
"""

from __future__ import annotations

import contextlib
import io
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"
_AGENTS_DIR = _REPO_ROOT / "agents"

# The helper MUST enter sys.modules before daemon_cycle imports it, so both the
# test and the daemon bind to ONE module object and a single psycopg patch
# covers the upsert (write) and the intake (read).
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))

try:
    import _pg_learning_dualwrite as pgdw
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    pgdw = None  # type: ignore[assignment]  # sentinel consumed by skipIf only
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc

_PROBE_AGENT = "ap2-probe-agent"
_PROBE_SIGNATURE = f"ap2 intake contract probe|{_PROBE_AGENT}"
_ROSTER_AGENT = "dev-python"
_ROSTER_SIGNATURE = f"ap2 roster probe|{_ROSTER_AGENT}"
_MISMATCH_AGENT = "ap2-no-such-agent"
_MISMATCH_SIGNATURE = f"ap2 mismatch probe|{_MISMATCH_AGENT}"


class _RecordingCursor:
    def __init__(self, log: list[tuple[str, tuple]]) -> None:
        self._log = log

    def __enter__(self) -> "_RecordingCursor":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def execute(self, sql: str, params: tuple = ()) -> None:
        self._log.append((sql, params))

    def fetchall(self) -> list:
        return []


class _RecordingConn:
    def __init__(self, log: list[tuple[str, tuple]]) -> None:
        self._log = log

    def __enter__(self) -> "_RecordingConn":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def cursor(self) -> _RecordingCursor:
        return _RecordingCursor(self._log)


class _NonCommittingConn:
    """Hand the helper an already-open transaction; swallow its context exit AND
    its commit so nothing persists — the owning test rolls back instead.
    """

    def __init__(self, conn: object) -> None:
        self._conn = conn

    def __enter__(self) -> "_NonCommittingConn":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def cursor(self):  # noqa: ANN201 — real psycopg cursor, type lives upstream
        return self._conn.cursor()

    def commit(self) -> None:
        # upsert_learning_pattern commits inside its _do(); the fixture
        # transaction must stay open until the class-level rollback.
        return None


@unittest.skipIf(pgdw is None, f"import failed: {_IMPORT_ERROR}")
class TestIntakeSqlShape(unittest.TestCase):
    """The intake predicate is baked into the helper's single SELECT."""

    def setUp(self) -> None:
        self._log: list[tuple[str, tuple]] = []
        stub = SimpleNamespace(connect=lambda *a, **k: _RecordingConn(self._log))
        patcher = mock.patch.object(pgdw, "psycopg", stub)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_when_intake_reads_then_select_carries_status_and_tier_predicate(
        self,
    ) -> None:
        pgdw.read_pending_learning_patterns()
        self.assertEqual(len(self._log), 1, "helper must execute exactly one SELECT")
        sql = self._log[0][0]
        self.assertIn("FROM core.learning_log", sql)
        self.assertIn("status = 'identified'", sql)
        self.assertIn("'user-pending'", sql)
        self.assertIn("'llm'", sql)
        self.assertIn("ORDER BY frequency DESC", sql)


class _LivePgFixture(unittest.TestCase):
    """Shared never-committed-transaction harness for the live-PG classes."""

    conn = None

    @classmethod
    def setUpClass(cls) -> None:
        if pgdw is None:
            raise unittest.SkipTest(f"import failed: {_IMPORT_ERROR}")
        import psycopg

        try:
            cls.conn = psycopg.connect("dbname=glass_atrium", connect_timeout=2)
        except Exception as exc:  # noqa: BLE001 — no PG → skip the live class
            raise unittest.SkipTest(f"PG unreachable: {type(exc).__name__}: {exc}")
        cls.addClassCleanup(cls._rollback_and_close)

        stub = SimpleNamespace(connect=lambda *a, **k: _NonCommittingConn(cls.conn))
        cls._patcher = mock.patch.object(pgdw, "psycopg", stub)
        cls._patcher.start()
        cls.addClassCleanup(cls._patcher.stop)

    @classmethod
    def _rollback_and_close(cls) -> None:
        if cls.conn is not None:
            cls.conn.rollback()
            cls.conn.close()

    def setUp(self) -> None:
        # Loop-event recorder — keeps mismatch envelopes observable while
        # guaranteeing the test writes nothing to core.autoagent_loop_events.
        self.emitted: list[dict] = []

        def _record(envelope: dict) -> bool:
            self.emitted.append(envelope)
            return True

        patcher = mock.patch.object(dc, "_invoke_pg_helper", _record)
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def _upsert_probe(signature: str, agent: str, frequency: int) -> None:
        # The exact function learning-aggregator.py writes through
        # (_pg_upsert_learning_pattern) — the write side of the contract.
        pgdw.upsert_learning_pattern(
            pattern_signature=signature,
            discovered_date=date.today(),
            frequency=frequency,
            agent=agent,
            status="identified",
            approval_tier="user-pending",
        )


class TestAggregatorUpsertVisibleToIntake(_LivePgFixture):
    """Write-target == read-target: an aggregator upsert reaches the intake."""

    def test_when_pattern_upserted_then_intake_returns_it(self) -> None:
        self._upsert_probe(_PROBE_SIGNATURE, _PROBE_AGENT, frequency=9999)
        with tempfile.TemporaryDirectory() as tmp:
            agents_dir = Path(tmp)
            (agents_dir / f"{_PROBE_AGENT}.md").write_text("# probe", encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()):
                patterns = dc.read_user_pending_patterns(
                    Path(tmp) / "no-such-learning-log.md",
                    dc.UNLIMITED_AGENTS,
                    agents_dir=agents_dir,
                )

        # Probe roster contains ONLY the probe agent → live rows either mismatch
        # (recorded, skipped) or are cross-cutting (skipped) — the probe row is
        # the entire intake.
        self.assertEqual([p.agent for p in patterns], [_PROBE_AGENT])
        probe = patterns[0]
        self.assertEqual(probe.label, "ap2 intake contract probe")
        self.assertEqual(probe.frequency, "9999")
        self.assertEqual(probe.date, date.today().isoformat())
        self.assertEqual(probe.status, "identified")
        self.assertEqual(probe.tier, "user-pending")
        self.assertTrue(probe.raw_line.startswith("pg:learning_log:"))


class TestIntakeRosterRenameContract(_LivePgFixture):
    """Every intake agent is an agents/*.md stem; mismatches WARN, never silent."""

    def _read_with_real_roster(self) -> tuple[list, str]:
        self._upsert_probe(_ROSTER_SIGNATURE, _ROSTER_AGENT, frequency=9999)
        self._upsert_probe(_MISMATCH_SIGNATURE, _MISMATCH_AGENT, frequency=9998)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            patterns = dc.read_user_pending_patterns(
                Path("/no-such-learning-log.md"),
                dc.UNLIMITED_AGENTS,
                agents_dir=_AGENTS_DIR,
            )
        return patterns, stderr.getvalue()

    def test_when_intake_reads_then_every_agent_is_a_roster_stem(self) -> None:
        patterns, _ = self._read_with_real_roster()
        roster = {p.stem for p in _AGENTS_DIR.glob("*.md")}
        self.assertTrue(patterns, "intake must return the roster probe at minimum")
        self.assertTrue(
            all(p.agent in roster for p in patterns),
            f"non-roster agents leaked into intake: "
            f"{[p.agent for p in patterns if p.agent not in roster]}",
        )
        self.assertIn(_ROSTER_AGENT, {p.agent for p in patterns})
        self.assertNotIn(_MISMATCH_AGENT, {p.agent for p in patterns})

    def test_when_agent_mismatches_roster_then_warn_record_is_emitted(self) -> None:
        _, stderr_text = self._read_with_real_roster()
        self.assertIn("WARN: intake roster mismatch", stderr_text)
        self.assertIn(_MISMATCH_AGENT, stderr_text)

        mismatch_events = [
            env["args"]
            for env in self.emitted
            if env.get("op") == "write_autoagent_loop_event"
            and env.get("args", {}).get("eval_result") == "roster-mismatch"
        ]
        self.assertIn(_MISMATCH_AGENT, [args["agent"] for args in mismatch_events])
        probe_args = next(
            args for args in mismatch_events if args["agent"] == _MISMATCH_AGENT
        )
        self.assertEqual(probe_args["changes_added"], 0)
        self.assertEqual(probe_args["changes_removed"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
