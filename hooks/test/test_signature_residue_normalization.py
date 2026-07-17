#!/usr/bin/env python3
"""Unit tests for the D-F4 signature-residue guard in learning-aggregator.py.

_NUMERIC_RE strips a pattern label's dynamic numeric but leaves the punctuation
that wrapped it: pattern-5's "agent instruction-improvement candidate (failure
rate 75%)" collapses to the orphan "(failure rate )". Left in the dedup core that
trailing-space remnant forks the pattern_signature. _normalize_signature_residue
cleans it forward-only (legacy rows keep their stored core — NO DB writes), so a
re-triggered agent re-keys at most once (benign).

The derivation is pure (no PG), so these run without a live DB. Mirrors the
existing aggregator-test convention (importlib load of the dashed module,
unittest, sys.path insertion).

    uv run --with pytest pytest hooks/test/test_signature_residue_normalization.py -v
    python3 -m unittest hooks.test.test_signature_residue_normalization -v
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

# Pattern-5 emit-site label (learning-aggregator.py main() pattern-5 block) — the
# only reachable label carrying a numeric INSIDE parens (patterns 2/3/6 are
# 전체-blocked at _emit_xc; patterns 1/7 carry no parens).
_PATTERN5_LABEL_75 = "agent instruction-improvement candidate (failure rate 75%)"
_PATTERN5_LABEL_50 = "agent instruction-improvement candidate (failure rate 50%)"


def _derive_pat_core(label: str) -> str:
    """Mirror the L852 signature-core derivation exactly: strip numerics, then run
    the residue guard. This is the value that keys the learning_log dedup."""
    return agg._normalize_signature_residue(agg._NUMERIC_RE.sub("", label))


class NormalizeSignatureResidue(unittest.TestCase):
    """_normalize_signature_residue guard behavior on the post-strip residue."""

    def test_when_trailing_space_paren_then_orphan_removed(self):
        # '(failure rate )' → '(failure rate)' — the trailing-space orphan is the bug.
        self.assertEqual(
            agg._normalize_signature_residue("agent candidate (failure rate )"),
            "agent candidate (failure rate)",
        )

    def test_when_empty_paren_group_then_removed(self):
        # A whole-value strip leaves 'foo ()' → 'foo' (defensive; e.g. a 전체-blocked
        # '... improvement ()' shape should never fork a signature if it ever reaches here).
        self.assertEqual(
            agg._normalize_signature_residue("metric_pass improvement ()"),
            "metric_pass improvement",
        )

    def test_when_dangling_separator_then_dropped(self):
        # '(feature, )' → '(feature)' — the strip removed the trailing token, not its comma.
        self.assertEqual(
            agg._normalize_signature_residue("high rework-request frequency (feature, )"),
            "high rework-request frequency (feature)",
        )

    def test_when_doubled_internal_space_then_collapsed(self):
        self.assertEqual(
            agg._normalize_signature_residue("agent  candidate"),
            "agent candidate",
        )

    def test_when_no_parens_then_passthrough(self):
        # Patterns 1/7 carry no numerics/parens — the guard must be a no-op (only .strip()).
        for clean in (
            agg.PATTERN1_FAIL_LABEL,
            agg.PATTERN1_SOFT_LABEL,
            agg.BUDGET_OVERAGE_LABEL,
        ):
            self.assertEqual(agg._normalize_signature_residue(clean), clean)


class Pattern5SignatureDerivation(unittest.TestCase):
    """End-to-end L852 derivation on the pattern-5 emit label."""

    def test_when_pattern5_emitted_then_signature_core_has_no_failure_rate_orphan(self):
        # EARS: the persisted pattern_signature core must NOT contain '(failure rate )'.
        pat_core = _derive_pat_core(_PATTERN5_LABEL_75)
        self.assertNotIn("(failure rate )", pat_core)
        self.assertEqual(pat_core, "agent instruction-improvement candidate (failure rate)")

    def test_when_different_rates_then_same_signature_core(self):
        # The guard shall prevent an empty-failure-rate residue from recurring: any rate
        # collapses to one stable core, so repeated runs converge (dedup does not fork).
        self.assertEqual(
            _derive_pat_core(_PATTERN5_LABEL_75),
            _derive_pat_core(_PATTERN5_LABEL_50),
        )

    def test_when_derived_then_signature_core_is_nonempty(self):
        # Guards the L853 fallback: a non-empty core means the label is preserved, not
        # replaced by the raw pattern_label.
        self.assertTrue(_derive_pat_core(_PATTERN5_LABEL_75))


class LegacyRowReKeyBenign(unittest.TestCase):
    """Documents the NO-DB-writes benign re-key: legacy rows keep their old stored core;
    new emits derive the clean core — a re-triggered agent inserts at most one new row."""

    # The pre-fix stored signature core for the 4 legacy learning_log rows (id 5·6·41·42),
    # carrying the orphan trailing space. NO DB writes: these rows are retained verbatim.
    _LEGACY_STORED_CORE = "agent instruction-improvement candidate (failure rate )"

    def test_when_new_emit_then_core_differs_from_legacy_stored_core(self):
        # read_learning_log_signatures splits the STORED signature on '|' without
        # re-deriving (see _pg_learning_dualwrite.read_learning_log_signatures docstring),
        # so the legacy stored core is returned verbatim while a fresh emit derives the
        # clean core. The keys differ → exactly one benign re-key row on next trigger.
        new_core = _derive_pat_core(_PATTERN5_LABEL_75)
        self.assertNotEqual(new_core, self._LEGACY_STORED_CORE)
        self.assertEqual(new_core, self._LEGACY_STORED_CORE.replace(" )", ")"))

    def test_when_new_emit_repeated_then_converges_to_single_core(self):
        # After the one-time re-key, repeated same-agent emits share one core → no further
        # forking (the re-key is one-time, not per-run).
        cores = {_derive_pat_core(_PATTERN5_LABEL_75) for _ in range(3)}
        self.assertEqual(len(cores), 1)


if __name__ == "__main__":
    unittest.main()
