#!/usr/bin/env python3
"""Doc-lockstep grep over the tiered CTM admission rule in core-learning-log.md.

    python3 -m unittest hooks.test.test_lesson_store_integrity -v
"""

from __future__ import annotations

import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent


class DocLockstep(unittest.TestCase):
    """AC8 — the repo doc states the tiered admission rule at all four contract positions
    and carries zero stale 'score >= 4 → CTM' phrasings."""

    _DOC = _REPO_ROOT / "rules" / "glass-atrium" / "core-learning-log.md"
    _ANCHORS = (
        "Successful patches",
        "**CTM** (Correct-Template Memory)",
        "machine-readable lesson store",
        "AD-3 — spawn-time lesson injection",
    )
    _STALE = ("(score ≥ 4) → CTM", "achieved score ≥ 4", "score ≥ 4 success)")

    def test_when_t1_merged_then_tiered_rule_replaces_score4_contract(self):
        text = self._DOC.read_text(encoding="utf-8")
        for stale in self._STALE:
            self.assertNotIn(stale, text, f"stale phrasing remains: {stale}")
        lines = text.splitlines()
        for anchor in self._ANCHORS:
            matches = [ln for ln in lines if anchor in ln]
            self.assertTrue(matches, f"anchor line missing: {anchor}")
            self.assertTrue(
                any("provisional" in ln and "frequency ≥ 2" in ln for ln in matches),
                f"tiered rule absent at anchor: {anchor}",
            )


if __name__ == "__main__":
    unittest.main()
