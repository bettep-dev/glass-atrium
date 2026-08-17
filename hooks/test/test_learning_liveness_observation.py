#!/usr/bin/env python3
"""Unit tests for the terminal-skip liveness observation in learning-aggregator.py.

Plan 7443 W-A: when a run clusters a pattern whose learning_log row is already
terminal, the aggregator discards the built entry at a bare `continue`. The
observation records that discard append-only; the skip itself is unchanged.

The emit path is driven with a fake writer, so these run without a live DB. The
two source-parity checks are both-sides-derived (SQL conflict target against the
migration's unique index; call-site placement against the terminal branch) rather
than pinned literals.

    uv run --with pytest pytest hooks/test/test_learning_liveness_observation.py -v
    python3 -m unittest hooks.test.test_learning_liveness_observation -v
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import re
import sys
import unittest
from datetime import date
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AGGREGATOR = _HOOKS_DIR / "learning-aggregator.py"
_DUALWRITE = _HOOKS_DIR / "_pg_learning_dualwrite.py"
_MIGRATION = (
    _REPO_ROOT
    / "monitor/prisma/migrations/20260817000000_add_learning_pattern_liveness/migration.sql"
)
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))


def _load_aggregator():
    """Import learning-aggregator.py despite the dashed filename. main() is guarded
    under __main__ and the PG helper import is try/except-wrapped, so loading runs no
    PG code (works without psycopg installed)."""
    spec = importlib.util.spec_from_file_location("learning_aggregator", _AGGREGATOR)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    with contextlib.redirect_stderr(io.StringIO()):
        spec.loader.exec_module(module)
    return module


class _SinkMissing(RuntimeError):
    """Stands in for the writer's LivenessSinkMissing without importing psycopg."""


class FakeWriter:
    """Captures appended observations; mimics ON CONFLICT DO NOTHING per (sig, run)."""

    def __init__(self, raises: BaseException | None = None) -> None:
        self.rows: list[dict] = []
        self.calls = 0
        self._raises = raises

    def __call__(self, *, pattern_signature, agent, run_date, frequency) -> bool:
        self.calls += 1
        if self._raises is not None:
            raise self._raises
        key = (pattern_signature, run_date)
        if any((r["pattern_signature"], r["run_date"]) == key for r in self.rows):
            return False
        self.rows.append({
            "pattern_signature": pattern_signature,
            "agent": agent,
            "run_date": run_date,
            "frequency": frequency,
        })
        return True


class LivenessEmitTest(unittest.TestCase):
    def setUp(self) -> None:
        self.mod = _load_aggregator()
        self.mod.HAS_PG_DUALWRITE = True
        self.mod.LivenessSinkMissing = _SinkMissing
        self.mod.clear_liveness_degradations()

    def _emit(self, writer, signature="pattern core|dev-db", freq=3):
        self.mod._pg_insert_liveness_observation = writer
        with contextlib.redirect_stderr(io.StringIO()) as err:
            written = self.mod.emit_liveness_observation(
                signature, signature.split("|")[-1], date(2026, 8, 17), freq
            )
        return written, err.getvalue()

    def test_when_terminal_row_clusters_then_one_observation_appended(self):
        writer = FakeWriter()
        written, _ = self._emit(writer)
        self.assertTrue(written)
        self.assertEqual(
            writer.rows,
            [{
                "pattern_signature": "pattern core|dev-db",
                "agent": "dev-db",
                "run_date": date(2026, 8, 17),
                "frequency": 3,
            }],
        )

    def test_when_signature_repeats_in_one_run_then_no_second_row(self):
        writer = FakeWriter()
        self._emit(writer)
        written, _ = self._emit(writer)
        self.assertFalse(written)
        self.assertEqual(len(writer.rows), 1)

    def test_when_table_absent_then_named_probe_fires_once_and_latches(self):
        writer = FakeWriter(raises=_SinkMissing("core.learning_pattern_liveness is missing"))
        written, err = self._emit(writer)
        self.assertFalse(written)
        self.assertIn("migration_absent", err)
        self.assertIn("accruing nowhere", err)
        self._emit(writer)
        self.assertEqual(writer.calls, 1, "latched — one cause, one line, one attempt")
        self.assertEqual(
            [d["reason"] for d in self.mod.get_liveness_degradations()], ["migration_absent"]
        )

    def test_when_sink_outage_then_cause_is_distinct_from_absent_table(self):
        writer = FakeWriter(raises=OSError("connection refused"))
        written, err = self._emit(writer)
        self.assertFalse(written)
        self.assertIn("sink_unavailable", err)
        self.assertEqual(
            [d["reason"] for d in self.mod.get_liveness_degradations()], ["sink_unavailable"]
        )

    def test_when_dualwrite_absent_then_emit_is_a_silent_no_op(self):
        self.mod.HAS_PG_DUALWRITE = False
        writer = FakeWriter()
        written, err = self._emit(writer)
        self.assertFalse(written)
        self.assertEqual(writer.calls, 0)
        self.assertEqual(err, "")
        self.assertEqual(self.mod.get_liveness_degradations(), [])


class LivenessSourceParityTest(unittest.TestCase):
    """Properties no fake writer can observe: where the call sits, and what it writes."""

    def test_when_observation_written_then_conflict_target_matches_migration_index(self):
        insert_sql = _DUALWRITE.read_text(encoding="utf-8").split("_LIVENESS_INSERT_SQL", 1)[1]
        conflict = re.search(r"ON CONFLICT \(([^)]*)\) DO NOTHING", insert_sql)
        index = re.search(
            r'CREATE UNIQUE INDEX[^(]*ON "core"\."learning_pattern_liveness" \(([^)]*)\)',
            _MIGRATION.read_text(encoding="utf-8"),
        )
        self.assertIsNotNone(conflict)
        self.assertIsNotNone(index)
        columns = [c.strip().strip('"') for c in index.group(1).split(",")]
        self.assertEqual([c.strip() for c in conflict.group(1).split(",")], columns)

    def test_when_below_family_floor_then_no_call_site_can_reach_the_observation(self):
        source = _AGGREGATOR.read_text(encoding="utf-8")
        calls = [
            line for line in source.splitlines() if "emit_liveness_observation(" in line
        ]
        invocations = [c for c in calls if not c.lstrip().startswith("def ")]
        self.assertEqual(len(invocations), 1, "one call site — inside the terminal branch")
        branch, _, after = source.partition(invocations[0])
        self.assertTrue(
            branch.rstrip().endswith("discarded it."),
            "the call sits under the terminal-status guard, downstream of the emit gate",
        )
        self.assertTrue(after.lstrip().startswith("continue"), "the skip is unchanged")
        self.assertNotIn(
            "MIN_OCCURRENCE", invocations[0], "no floor literal on the observation path"
        )


if __name__ == "__main__":
    unittest.main()
