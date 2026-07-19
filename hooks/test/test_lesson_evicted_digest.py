#!/usr/bin/env python3
"""Unit tests for the AD-1 evicted-digest footer in learning-aggregator.py.

R2 (AD-1 fidelity): enforce_bucket_cap hard-drops evicted lessons, but now folds them into
a single NO-LLM evicted-digest footer (cumulative count + per-task_type tags) so the dropped
signal leaves a trace (Letta summarize-and-evict INTENT, sans LLM). The footer MUST be excluded
from the active-size cap so it can never breach the cap invariant, and MUST never be an eviction
victim.

    python3 -m unittest hooks.test.test_lesson_evicted_digest -v
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
    """Import learning-aggregator.py despite the dashed filename (main() is __main__-guarded
    and the PG import is try/except-wrapped, so loading runs no PG code)."""
    spec = importlib.util.spec_from_file_location(
        "learning_aggregator", _HOOKS_DIR / "learning-aggregator.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


agg = _load_aggregator()


def _lesson(agent: str, task_type: str, text: str, score: int = 3, freq: int = 1) -> dict:
    return {
        "agent": agent,
        "task_type": task_type,
        "text": text,
        "score": score,
        "frequency": freq,
        "tombstoned": False,
        "updated": "2026-07-19",
    }


class EvictedDigestTest(unittest.TestCase):
    def test_cap_invariant_holds_after_eviction(self):
        """Active (non-tombstoned, non-digest) sum <= cap on return — the AD-1 invariant."""
        bucket = [_lesson("dev-python", "feature", "x" * 100, score=3) for _ in range(6)]
        evicted = agg.enforce_bucket_cap(bucket, 250)
        self.assertLessEqual(agg._bucket_active_size(bucket), 250)
        self.assertTrue(evicted, "expected at least one eviction over a 250-char cap")

    def test_digest_footer_created_with_count_and_tags(self):
        """A single digest footer records the evicted count + per-task_type tags."""
        bucket = [
            _lesson("dev-python", "feature", "a" * 100, score=1),
            _lesson("dev-python", "feature", "b" * 100, score=1),
            _lesson("dev-python", "bug-fix", "c" * 100, score=1),
            _lesson("dev-python", "refactor", "d" * 100, score=9),  # high score → survives
        ]
        agg.enforce_bucket_cap(bucket, 150)
        digests = [e for e in bucket if e.get("digest")]
        self.assertEqual(len(digests), 1, "exactly one digest footer expected")
        digest = digests[0]
        # 3 low-score lessons evicted (feature×2, bug-fix×1); the refactor survives.
        self.assertEqual(digest["evicted_count"], 3)
        self.assertEqual(digest["tags"], {"feature": 2, "bug-fix": 1})
        self.assertIn("[evicted-digest]", digest["text"])
        self.assertIn("feature×2", digest["text"])
        self.assertIn("bug-fix×1", digest["text"])

    def test_digest_excluded_from_active_size(self):
        """The footer carries zero active weight — it never counts toward the cap."""
        bucket = [_lesson("dev-python", "feature", "x" * 100) for _ in range(5)]
        agg.enforce_bucket_cap(bucket, 200)
        active = agg._bucket_active_size(bucket)
        digest = agg._find_evicted_digest(bucket)
        self.assertIsNotNone(digest)
        # The digest row has non-zero text but contributes 0 to the active-size sum.
        self.assertGreater(agg._lesson_size(digest), 0)
        expected_active = sum(
            agg._lesson_size(e)
            for e in bucket
            if not e.get("tombstoned") and not e.get("digest")
        )
        self.assertEqual(active, expected_active)
        self.assertLessEqual(active, 200)
        # Re-running the cap is a no-op now that the active sum is under cap.
        self.assertEqual(agg.enforce_bucket_cap(bucket, 200), [])

    def test_digest_is_never_evicted(self):
        """The digest footer survives a second, tighter eviction pass (never a victim)."""
        bucket = [_lesson("dev-python", "feature", "x" * 100, score=5) for _ in range(6)]
        agg.enforce_bucket_cap(bucket, 300)
        first = agg._find_evicted_digest(bucket)
        self.assertIsNotNone(first)
        agg.enforce_bucket_cap(bucket, 100)  # tighter cap → more evictions
        digests = [e for e in bucket if e.get("digest")]
        self.assertEqual(len(digests), 1, "still exactly one digest, never evicted")
        self.assertLessEqual(agg._bucket_active_size(bucket), 100)

    def test_digest_accumulates_across_passes(self):
        """Cumulative count/tags across successive cap enforcements — one merged footer."""
        bucket = [_lesson("dev-python", "feature", "x" * 100, score=3) for _ in range(4)]
        agg.enforce_bucket_cap(bucket, 250)  # evicts some feature lessons
        first_count = agg._find_evicted_digest(bucket)["evicted_count"]
        # Add bug-fix lessons and tighten the cap → new evictions fold into the same footer.
        bucket.extend(_lesson("dev-python", "bug-fix", "y" * 100, score=1) for _ in range(3))
        agg.enforce_bucket_cap(bucket, 100)
        digest = agg._find_evicted_digest(bucket)
        self.assertGreater(digest["evicted_count"], first_count)
        self.assertIn("bug-fix", digest["tags"])

    def test_no_digest_when_under_cap(self):
        """Under-cap bucket → no eviction, no digest footer, empty return."""
        bucket = [_lesson("dev-python", "feature", "x" * 10) for _ in range(3)]
        evicted = agg.enforce_bucket_cap(bucket, 4000)
        self.assertEqual(evicted, [])
        self.assertIsNone(agg._find_evicted_digest(bucket))

    def test_digest_text_render_ordering(self):
        """Tags render descending by count then name (stable, deterministic)."""
        text = agg._render_evicted_digest_text(6, {"bug-fix": 1, "feature": 3, "refactor": 2})
        self.assertEqual(text, "[evicted-digest] 6 evicted: feature×3, refactor×2, bug-fix×1")


if __name__ == "__main__":
    unittest.main()
