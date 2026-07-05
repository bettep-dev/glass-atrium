#!/usr/bin/env python3
"""Unit tests for pattern-7 budget-overage clustering in learning-aggregator.py.

Covers the D4 routing split (plan doc 2 §Design Decisions): best-effort
core.budget_overages rows cluster into PER-AGENT_TYPE "budget-overage
concentration" learning_log candidates whose improvement target is the AGENT
FILE's emit discipline. The ORCHESTRATOR sizing failure mode is NOT routed here
(handled statically by the P4 calibration line) — a null / cross-cutting
agent_type is dropped at intake.

The clustering core (_cluster_budget_overages) is pure, so these run without a
live DB. Mirrors the existing aggregator-test convention (importlib load of the
dashed module, unittest, sys.path insertion).

    uv run --with pytest pytest hooks/test/test_budget_overage_clustering.py -v
    python3 -m unittest hooks.test.test_budget_overage_clustering -v
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))


def _load_aggregator():
    """Import learning-aggregator.py despite the dashed filename. main() is guarded
    under __main__, and the PG helper import is try/except-wrapped, so loading runs
    no PG code (works without psycopg installed)."""
    spec = importlib.util.spec_from_file_location(
        "learning_aggregator", _HOOKS_DIR / "learning-aggregator.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


agg = _load_aggregator()


class ClusterBudgetOverages(unittest.TestCase):
    """_cluster_budget_overages canonicalization + intake-drop behavior."""

    @staticmethod
    def _rows(*agent_types):
        return [{"agent_type": t} for t in agent_types]

    def test_when_repeated_same_agent_type_then_canonical_key_counted(self):
        counts = agg._cluster_budget_overages(
            self._rows("dev-python", "dev-python", "dev-python")
        )
        self.assertEqual(counts, {"glass-atrium-dev-python": 3})

    def test_when_prefixed_and_bare_forms_then_aggregate_one_key(self):
        counts = agg._cluster_budget_overages(
            self._rows("dev-python", "glass-atrium-dev-python")
        )
        self.assertEqual(counts, {"glass-atrium-dev-python": 2})

    def test_when_colon_qualified_then_leading_segment_keyed(self):
        counts = agg._cluster_budget_overages(
            self._rows("dev-python:worker", "dev-python")
        )
        self.assertEqual(counts, {"glass-atrium-dev-python": 2})

    def test_when_null_agent_type_then_dropped(self):
        counts = agg._cluster_budget_overages(self._rows(None, None, "dev-shell"))
        self.assertEqual(counts, {"glass-atrium-dev-shell": 1})

    def test_when_cross_cutting_or_unknown_then_dropped(self):
        counts = agg._cluster_budget_overages(
            self._rows("전체", "ALL", "all", "unknown", "")
        )
        self.assertEqual(counts, {})

    def test_when_empty_input_then_empty(self):
        self.assertEqual(agg._cluster_budget_overages([]), {})


class EmitFloorAndIntake(unittest.TestCase):
    """The min-occurrence floor + _emit_xc intake gate, mirroring the pattern-7
    emit block in main()."""

    def _emit(self, counts):
        entries: list[str] = []
        today = "2026-07-05"
        for agent, overages in counts.items():
            if overages >= agg.BUDGET_OVERAGE_MIN_OCCURRENCE:
                agg._emit_xc(
                    entries,
                    agg._build_entry(
                        today, agg.BUDGET_OVERAGE_LABEL, str(overages), agent, overages
                    ),
                    agent,
                )
        return entries

    def test_when_below_floor_then_no_entry(self):
        self.assertEqual(self._emit({"glass-atrium-dev-python": 2}), [])

    def test_when_at_floor_then_one_entry_with_label_and_agent(self):
        entries = self._emit({"glass-atrium-dev-python": 3})
        self.assertEqual(len(entries), 1)
        self.assertIn(agg.BUDGET_OVERAGE_LABEL, entries[0])
        self.assertIn("glass-atrium-dev-python", entries[0])

    def test_when_signature_core_derived_then_matches_plan_label_shape(self):
        # signature = "<pat_core>|<agent>" — the label carries no numerics, so
        # pat_core stays verbatim, matching the plan's "budget-overage
        # concentration|<agent_type>" contract.
        entry = agg._build_entry(
            "2026-07-05", agg.BUDGET_OVERAGE_LABEL, "3", "glass-atrium-dev-python", 3
        )
        cols = [c.strip() for c in entry.split("|")]
        pat_core = agg._NUMERIC_RE.sub("", cols[2]).strip()
        self.assertEqual(pat_core, "budget-overage concentration")
        self.assertEqual(cols[4], "glass-atrium-dev-python")

    def test_when_cross_cutting_agent_then_intake_blocks(self):
        # _emit_xc drops NOT_PATCHABLE agents even above the floor.
        entries: list[str] = []
        agg._emit_xc(
            entries,
            agg._build_entry("2026-07-05", agg.BUDGET_OVERAGE_LABEL, "5", "전체", 5),
            "전체",
        )
        self.assertEqual(entries, [])


if __name__ == "__main__":
    unittest.main()
