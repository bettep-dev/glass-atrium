#!/usr/bin/env python3
"""Unit tests for pattern-8 size-est under-estimate clustering in learning-aggregator.py.

The [SIZE-EST] token is presence-checked at spawn and never verified, so the correction is
retrospective: track-outcome.sh records the MEASURED tool_use count of a spawn beside the
DECLARED estimate, and this pattern reads the pair back to surface an agent whose spawns
systematically overrun. Covered here:

  - overrun counting, and the rate floor that separates a systematic under-estimator from
    ordinary estimate noise
  - a measured-but-undeclared row is DROPPED, never counted as a non-overrun (counting it
    would dilute the rate toward silence on exactly the installs that declare least)
  - a null / cross-cutting agent has no patchable agent file and is dropped at intake
  - the recorder's body-line literal and this reader's regex are pinned against each other
    (the two live in different files and different languages; nothing else would catch a
    silent divergence, which would leave the reader matching nothing forever)

The clustering core is pure, so these run without a live DB. Mirrors the aggregator-test
convention (importlib load of the dashed module, unittest, sys.path insertion).

    uv run --with pytest pytest hooks/test/test_size_est_underestimate.py -v
    python3 -m unittest hooks.test.test_size_est_underestimate -v
"""

from __future__ import annotations

import importlib.util
import re
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))


def _load_aggregator():
    """Import learning-aggregator.py despite the dashed filename. main() is guarded under
    __main__ and the PG helper import is try/except-wrapped, so loading runs no PG code."""
    spec = importlib.util.spec_from_file_location(
        "learning_aggregator", _HOOKS_DIR / "learning-aggregator.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


_AGG = _load_aggregator()
_AGENT = "glass-atrium-dev-shell"


def _row(actual: int, declared: int | None = None, agent: str | None = _AGENT) -> dict:
    line = f"- **Tool use**: actual={actual}"
    if declared is not None:
        line += f" declared={declared}"
    return {"agent": agent, "body_md": f"# Outcome Record\n\n- **Agent**: x\n{line}\n"}


class ClusterSizeEstTest(unittest.TestCase):
    def test_overruns_and_excess_accumulate(self):
        rows = [_row(48, 22), _row(30, 10), _row(5, 20)]
        stats = _AGG._cluster_size_est_underestimates(rows)
        self.assertEqual(stats[_AGENT]["paired"], 3)
        self.assertEqual(stats[_AGENT]["under"], 2)
        # excess sums the overrunning rows only: (48-22) + (30-10)
        self.assertEqual(stats[_AGENT]["excess"], 46)

    def test_undeclared_row_is_dropped_not_counted_as_non_overrun(self):
        stats = _AGG._cluster_size_est_underestimates([_row(48, 22), _row(99)])
        self.assertEqual(stats[_AGENT]["paired"], 1)

    def test_unmatched_body_is_ignored(self):
        rows = [{"agent": _AGENT, "body_md": "# Outcome Record\n\n- **Agent**: x\n"}]
        self.assertEqual(_AGG._cluster_size_est_underestimates(rows), {})

    def test_unpatchable_agent_dropped_at_intake(self):
        self.assertEqual(_AGG._cluster_size_est_underestimates([_row(48, 22, None)]), {})

    def test_rate_floor_separates_systematic_from_noise(self):
        # 3 overruns clears the occurrence floor but not the rate floor at 12 paired spawns.
        rows = [_row(48, 22)] * 3 + [_row(5, 22)] * 9
        stats = _AGG._cluster_size_est_underestimates(rows)[_AGENT]
        self.assertGreaterEqual(stats["under"], _AGG.SIZE_EST_UNDER_MIN_OCCURRENCE)
        self.assertLess(
            stats["under"] / stats["paired"], _AGG.SIZE_EST_UNDER_RATE_FLOOR
        )


class BodyLineContractTest(unittest.TestCase):
    """Cross-file pin: the recorder writes this grammar, the aggregator reads it."""

    def test_recorder_literal_matches_reader_regex(self):
        recorder = (_HOOKS_DIR / "track-outcome.sh").read_text(encoding="utf-8")
        emitted = re.findall(r'TOOL_USE_LINE="([^"]+)"', recorder)
        self.assertTrue(emitted, "track-outcome.sh emits no TOOL_USE_LINE assignment")
        # Instantiate the shell interpolations with concrete digits, then require the
        # aggregator's own regex to accept every form the recorder can write.
        for template in emitted:
            line = (
                template.replace("${TOOL_USE_ACTUAL}", "48")
                .replace("${SIZE_EST_DECLARED}", "22")
            )
            self.assertRegex(line, _AGG._TOOL_USE_BODY_RE)
            self.assertIn(_AGG.TOOL_USE_BODY_PREFIX, line)


if __name__ == "__main__":
    unittest.main()
