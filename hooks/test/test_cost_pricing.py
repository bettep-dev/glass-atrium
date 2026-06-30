"""Permanent regression test for the cost-pricing lockstep contract.

``cost-tracker.sh`` embeds its pricing logic in a bash heredoc (not importable)
and ``backfill-cost-events.py`` mirrors it VERBATIM (cross-ref both file
headers). A drift between the two silently mis-prices either the live rows or
the backfilled history, so the protected invariants are: (1) the PRICING dicts
are value-identical (fable row present at its 10/50/1/12.5 rates), (2) the
``normalize_model_key`` sources are byte-identical and resolve both the
``[1m]`` context-variant and the ``-YYYYMMDD`` snapshot-date suffixes, and
(3) FALLBACK_RATE stays the most expensive row in both files (conservative
cost reporting — an unknown model must never be under-billed).

The hook's embedded python is sliced out of the heredoc as TEXT and inspected
via ``ast`` only (literal_eval + source segments) — nothing from the slice is
executed; behavior assertions run on the imported backfill module, which the
byte-identity check ties back to the hook.

Run with either runner:
    uv run --with pytest pytest hooks/test/test_cost_pricing.py -v
    python3 -m unittest hooks.test.test_cost_pricing -v

CID: 2026-06-10T0810_atrium-normalize_b3f1
"""

from __future__ import annotations

import ast
import datetime
import importlib.util
import sys
import unittest
from pathlib import Path

_HOOKS_ROOT = Path(__file__).resolve().parent.parent
_COST_TRACKER = _HOOKS_ROOT / "cost-tracker.sh"
_BACKFILL = _HOOKS_ROOT / "backfill-cost-events.py"


def _load_backfill():
    """Import backfill-cost-events.py despite the dashed filename. The module
    guards its entry point under ``if __name__ == "__main__"``, so import runs
    no backfill."""
    spec = importlib.util.spec_from_file_location("backfill_cost_events", _BACKFILL)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _extract_parser_source() -> str:
    """Slice the embedded parser python out of cost-tracker.sh.

    The parser is the first ``python3 -c '...'`` heredoc after ``PARSED=$(``
    and the only block closed by a line starting with ``' 2>`` (the other two
    inline blocks close differently), so the marker pair is unambiguous.
    """
    src = _COST_TRACKER.read_text(encoding="utf-8")
    start = src.index("PARSED=$(")
    body_start = src.index("python3 -c '", start) + len("python3 -c '")
    body_end = src.index("\n' 2>", body_start)
    return src[body_start:body_end]


def _module_nodes(source: str) -> dict[str, ast.stmt]:
    """Map top-level assignment targets / function names to their AST nodes."""
    nodes: dict[str, ast.stmt] = {}
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name):
                nodes[target.id] = node
        elif isinstance(node, ast.FunctionDef):
            nodes[node.name] = node
    return nodes


_PARSER_SRC = _extract_parser_source()
_PARSER_NODES = _module_nodes(_PARSER_SRC)
_BACKFILL_SRC = _BACKFILL.read_text(encoding="utf-8")
_BACKFILL_NODES = _module_nodes(_BACKFILL_SRC)

backfill = _load_backfill()

_FABLE_RATES = {
    "input": 10.0,
    "output": 50.0,
    "cache_read": 1.0,
    "cache_creation": 12.5,
}


class NormalizeModelKeyTest(unittest.TestCase):
    """Behavior of the (byte-identical, see lockstep suite) normalize function."""

    def test_strips_1m_bracket_suffix(self):
        self.assertEqual(
            backfill.normalize_model_key("claude-opus-4-8[1m]"), "claude-opus-4-8"
        )

    def test_strips_dated_suffix(self):
        self.assertEqual(
            backfill.normalize_model_key("claude-haiku-4-5-20251001"),
            "claude-haiku-4-5",
        )

    def test_strips_bracket_then_date(self):
        self.assertEqual(
            backfill.normalize_model_key("claude-haiku-4-5-20251001[1m]"),
            "claude-haiku-4-5",
        )

    def test_plain_key_unchanged(self):
        self.assertEqual(
            backfill.normalize_model_key("claude-opus-4-8"), "claude-opus-4-8"
        )

    def test_non_8_digit_numeric_suffix_unchanged(self):
        self.assertEqual(backfill.normalize_model_key("claude-x-1234567"), "claude-x-1234567")
        self.assertEqual(
            backfill.normalize_model_key("claude-x-123456789"), "claude-x-123456789"
        )

    def test_falsy_passthrough(self):
        self.assertEqual(backfill.normalize_model_key(""), "")
        self.assertIsNone(backfill.normalize_model_key(None))

    def test_dated_haiku_resolves_in_pricing(self):
        key = backfill.normalize_model_key("claude-haiku-4-5-20251001")
        self.assertIn(key, backfill.PRICING)

    def test_dated_haiku_costed_at_haiku_rates(self):
        # 1000 in / 500 out at haiku 1.0/5.0 → 0.0035, NOT the opus fallback 0.0525.
        cost = backfill.calc_cost(1000, 500, 0, 0, "claude-haiku-4-5-20251001")
        self.assertAlmostEqual(cost, 0.0035, places=10)


class FablePricingTest(unittest.TestCase):
    def test_fable_key_present_with_exact_rates(self):
        self.assertEqual(backfill.PRICING.get("claude-fable-5"), _FABLE_RATES)

    def test_fable_cost_math(self):
        cost = backfill.calc_cost(1000, 500, 0, 0, "claude-fable-5")
        self.assertAlmostEqual(cost, 0.035, places=10)

    def test_fable_1m_window_resolves_without_tier_entry(self):
        # Fable's rate is flat across the 1M window — a "[1m]" id must resolve
        # to the single base row, never the opus fallback.
        cost = backfill.calc_cost(1000, 500, 0, 0, "claude-fable-5[1m]")
        self.assertAlmostEqual(cost, 0.035, places=10)


class PricingLockstepTest(unittest.TestCase):
    """cost-tracker.sh (embedded) and backfill-cost-events.py MUST agree."""

    def test_pricing_dicts_value_identical(self):
        hook_pricing = ast.literal_eval(_PARSER_NODES["PRICING"].value)
        backfill_pricing = ast.literal_eval(_BACKFILL_NODES["PRICING"].value)
        self.assertEqual(hook_pricing, backfill_pricing)
        self.assertEqual(hook_pricing.get("claude-fable-5"), _FABLE_RATES)

    def test_normalize_source_byte_identical(self):
        hook_fn = ast.get_source_segment(_PARSER_SRC, _PARSER_NODES["normalize_model_key"])
        backfill_fn = ast.get_source_segment(
            _BACKFILL_SRC, _BACKFILL_NODES["normalize_model_key"]
        )
        self.assertIsNotNone(hook_fn)
        self.assertEqual(hook_fn, backfill_fn)

    def test_fallback_rate_is_opus_4_8_in_both(self):
        for nodes in (_PARSER_NODES, _BACKFILL_NODES):
            value = nodes["FALLBACK_RATE"].value
            self.assertIsInstance(value, ast.Subscript)
            self.assertEqual(value.value.id, "PRICING")
            self.assertEqual(ast.literal_eval(value.slice), "claude-opus-4-8")

    def test_fallback_rate_is_most_expensive_row(self):
        for model, rate in backfill.PRICING.items():
            for component, value in rate.items():
                self.assertGreaterEqual(
                    backfill.FALLBACK_RATE[component],
                    value,
                    f"FALLBACK_RATE.{component} undercuts {model}",
                )

    def test_pricing_last_verified_is_iso_date(self):
        verified = ast.literal_eval(_PARSER_NODES["PRICING_LAST_VERIFIED"].value)
        datetime.date.fromisoformat(verified)


if __name__ == "__main__":
    sys.exit(unittest.main())
