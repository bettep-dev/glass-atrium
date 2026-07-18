#!/usr/bin/env python3
"""Unit tests for the AD-1/AD-2 CTM/EPM lesson store in learning-aggregator.py.

AD-1 (Letta/MemGPT): per-bucket char cap + summarize-and-evict — a bucket's active
(non-tombstoned) lesson-text sum never exceeds its cap.
AD-2 (Mem0): consolidation-op ingest — ADD / UPDATE / MERGE / TOMBSTONE, NEVER a
hard-delete; a duplicate lesson bumps frequency (not a new entry), a stale one is
tombstoned (row retained).

The functions are pure (no PG), so these run without a live DB — mirrors the existing
aggregator-test convention (importlib load of the dashed module, unittest).

    python3 -m unittest hooks.test.test_lesson_store_consolidation -v
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


def _entry(agent, task_type, text, score=5, updated="2026-07-19"):
    return {"agent": agent, "task_type": task_type, "text": text, "score": score, "updated": updated}


class IngestConsolidation(unittest.TestCase):
    """AD-2: ADD / UPDATE / MERGE — a duplicate bumps frequency, never a new row."""

    def test_when_new_then_add(self):
        bucket: list[dict] = []
        op = agg.ingest_lesson(bucket, _entry("glass-atrium-dev-shell", "feature", "Use printf"))
        self.assertEqual(op, "ADD")
        self.assertEqual(len(bucket), 1)
        self.assertEqual(bucket[0]["frequency"], 1)

    def test_when_exact_duplicate_then_update_freq_not_new_entry(self):
        bucket: list[dict] = []
        agg.ingest_lesson(bucket, _entry("glass-atrium-dev-shell", "feature", "Use printf"))
        op = agg.ingest_lesson(bucket, _entry("glass-atrium-dev-shell", "feature", "Use printf"))
        self.assertEqual(op, "UPDATE")
        self.assertEqual(len(bucket), 1)  # AC: duplicate → frequency bump, NOT a new entry
        self.assertEqual(bucket[0]["frequency"], 2)

    def test_when_cosmetic_numeric_case_diff_then_still_dedup(self):
        # A count/case/spacing difference must NOT fork a duplicate (normalized dedup key).
        bucket: list[dict] = []
        agg.ingest_lesson(bucket, _entry("glass-atrium-dev-shell", "feature", "Retry 3 times max"))
        op = agg.ingest_lesson(bucket, _entry("glass-atrium-dev-shell", "feature", "retry  5 times MAX"))
        self.assertEqual(op, "UPDATE")
        self.assertEqual(len(bucket), 1)

    def test_when_score_higher_on_update_then_max_kept(self):
        bucket: list[dict] = []
        agg.ingest_lesson(bucket, _entry("glass-atrium-dev-shell", "feature", "x", score=4))
        agg.ingest_lesson(bucket, _entry("glass-atrium-dev-shell", "feature", "x", score=5))
        self.assertEqual(bucket[0]["score"], 5)

    def test_when_different_agent_then_separate_entry(self):
        bucket: list[dict] = []
        agg.ingest_lesson(bucket, _entry("glass-atrium-dev-shell", "feature", "x"))
        agg.ingest_lesson(bucket, _entry("glass-atrium-dev-node", "feature", "x"))
        self.assertEqual(len(bucket), 2)


class TombstoneNeverHardDeletes(unittest.TestCase):
    """AD-2: TOMBSTONE soft-deletes (row retained); a re-observed stale lesson MERGE-resurrects."""

    def test_when_tombstoned_then_row_retained_and_flagged(self):
        bucket: list[dict] = []
        agg.ingest_lesson(bucket, _entry("glass-atrium-dev-shell", "bug-fix", "stale advice"))
        marked = agg.tombstone_lesson(bucket, "glass-atrium-dev-shell", "bug-fix", "stale advice")
        self.assertTrue(marked)
        self.assertEqual(len(bucket), 1)  # AC: never hard-deleted — the row stays
        self.assertTrue(bucket[0]["tombstoned"])

    def test_when_tombstoned_lesson_reingested_then_merge_resurrects(self):
        bucket: list[dict] = []
        agg.ingest_lesson(bucket, _entry("glass-atrium-dev-shell", "bug-fix", "stale advice"))
        agg.tombstone_lesson(bucket, "glass-atrium-dev-shell", "bug-fix", "stale advice")
        op = agg.ingest_lesson(bucket, _entry("glass-atrium-dev-shell", "bug-fix", "stale advice"))
        self.assertEqual(op, "MERGE")
        self.assertFalse(bucket[0]["tombstoned"])  # resurrected
        self.assertEqual(len(bucket), 1)

    def test_when_no_match_then_not_marked(self):
        bucket: list[dict] = []
        self.assertFalse(agg.tombstone_lesson(bucket, "glass-atrium-dev-shell", "bug-fix", "absent"))


class BucketCapEviction(unittest.TestCase):
    """AD-1: enforce_bucket_cap keeps the active text sum <= cap, evicting lowest value first."""

    def test_when_over_cap_then_active_sum_within_cap(self):
        bucket = [
            {"agent": "a", "task_type": "t", "text": "y" * 100, "score": 5, "frequency": 1, "tombstoned": False}
            for _ in range(60)
        ]
        agg.enforce_bucket_cap(bucket, 1000)  # 60*100=6000 active > 1000
        self.assertLessEqual(agg._bucket_active_size(bucket), 1000)  # AC: never exceeds cap

    def test_when_under_cap_then_no_eviction(self):
        bucket = [{"agent": "a", "task_type": "t", "text": "z" * 50, "score": 5, "frequency": 1, "tombstoned": False}]
        evicted = agg.enforce_bucket_cap(bucket, 1000)
        self.assertEqual(evicted, [])
        self.assertEqual(len(bucket), 1)

    def test_when_over_cap_then_tombstoned_evicted_first(self):
        # A tombstoned row carries no active weight but IS evicted first under capacity pressure.
        bucket = [
            {"agent": "a", "task_type": "t", "text": "T" * 10, "score": 9, "frequency": 9, "tombstoned": True},
            {"agent": "a", "task_type": "t", "text": "L" * 800, "score": 1, "frequency": 1, "tombstoned": False},
            {"agent": "a", "task_type": "t", "text": "H" * 800, "score": 5, "frequency": 5, "tombstoned": False},
        ]
        evicted = agg.enforce_bucket_cap(bucket, 900)
        self.assertTrue(evicted[0]["tombstoned"])  # dead weight goes first
        self.assertLessEqual(agg._bucket_active_size(bucket), 900)
        # the high-value live entry survives over the low-value one
        self.assertTrue(any(e["text"].startswith("H") for e in bucket))
        self.assertFalse(any(e["text"].startswith("L") for e in bucket))


class ClassifyLessonBucket(unittest.TestCase):
    """CTM (success) vs EPM (failure) vs None routing — DB-independent."""

    def test_when_done_high_metricpass_then_ctm(self):
        self.assertEqual(
            agg.classify_lesson_bucket({"result": "done", "metric_pass": True, "confidence": "high"}),
            "ctm",
        )

    def test_when_negative_result_then_epm(self):
        for res in ("fail", "blocked", "done_with_concerns"):
            self.assertEqual(agg.classify_lesson_bucket({"result": res}), "epm")

    def test_when_high_revision_then_epm(self):
        self.assertEqual(agg.classify_lesson_bucket({"result": "done", "revision_count": 2}), "epm")

    def test_when_low_confidence_done_then_none(self):
        # done but score below CTM floor (low=3 < 4) and not negative → skipped.
        self.assertIsNone(
            agg.classify_lesson_bucket({"result": "done", "metric_pass": True, "confidence": "low"})
        )


class StoreRoundTrip(unittest.TestCase):
    """load/save + ingest_outcome_lessons end-to-end (temp file, no PG)."""

    def test_when_outcomes_ingested_then_store_capped_and_deduped(self):
        import tempfile, os, json

        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "lessons.json")
            records = [
                {"agent": "glass-atrium-dev-shell", "task_type": "feature", "result": "done",
                 "metric_pass": True, "confidence": "high", "lesson": "Quote every expansion"},
                {"agent": "glass-atrium-dev-shell", "task_type": "feature", "result": "done",
                 "metric_pass": True, "confidence": "high", "lesson": "Quote every expansion"},  # dup
                {"agent": "glass-atrium-dev-shell", "task_type": "bug-fix", "result": "fail",
                 "confidence": "low", "lesson": "eval broke the parser"},
                {"agent": "glass-atrium-dev-shell", "task_type": "feature", "result": "done",
                 "metric_pass": True, "confidence": "high", "lesson": ""},  # empty → skipped
            ]
            ops = agg.ingest_outcome_lessons(records, path)
            self.assertEqual(ops.get("ADD"), 2)     # 1 CTM + 1 EPM
            self.assertEqual(ops.get("UPDATE"), 1)  # the dup bumped frequency
            store = json.loads(Path(path).read_text())
            self.assertEqual(len(store["ctm"]), 1)  # dup did not create a 2nd CTM row
            self.assertEqual(store["ctm"][0]["frequency"], 2)
            self.assertEqual(len(store["epm"]), 1)


if __name__ == "__main__":
    unittest.main()
