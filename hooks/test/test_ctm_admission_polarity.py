#!/usr/bin/env python3
"""T19 — CTM admission polarity (measured, not reasoned) for learning-aggregator.py.

Grounding (T0 baseline, autoagent/baseline/baseline-2026-07-22.md): the deterministic grader
emits `verified_pass` ONLY for bug-fix/feature; refactor and every other code arm are
structurally `verified_pass = 0`. A naive "verified_pass-or-discard" flip therefore starves
refactor to 0 CTM forever. R-a instead admits an unverified code lesson at a provisional
SUB-FLOOR score (not injectable, not discarded) and promotes it to the injectable floor on
corroborating re-observation, guarded against premature capacity eviction.

Each behavioural assertion below FAILS against the pre-T19 code (self-report confidence gated
CTM admission; grader_verdict was never consulted; there was no promotion path and no eviction
guard) and PASSES after. Pure functions, no PG — mirrors the aggregator-test convention.

    python3 -m unittest hooks.test.test_ctm_admission_polarity -v
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))


def _load_aggregator():
    spec = importlib.util.spec_from_file_location(
        "learning_aggregator", _HOOKS_DIR / "learning-aggregator.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


agg = _load_aggregator()

_CODE_TYPES = ("bug-fix", "feature", "refactor")
_NON_CODE_TYPES = ("doc", "review", "research", "plan", "cleanup", "diagnosis")


def _rec(task_type, verdict="", confidence="high", result="done", metric_pass=True, lesson="x"):
    return {
        "agent": "glass-atrium-dev-python",
        "task_type": task_type,
        "grader_verdict": verdict,
        "confidence": confidence,
        "result": result,
        "metric_pass": metric_pass,
        "lesson": lesson,
    }


class AdmissionScorePolarity(unittest.TestCase):
    """AC1 / AC2 — the grader verdict (not self-report confidence) sets a code entry's score."""

    def test_when_code_verified_pass_then_injectable_floor(self):
        # AC1: verified_pass admits at the injectable floor (>= CTM_MIN_SCORE).
        self.assertGreaterEqual(
            agg._admission_score(_rec("feature", "verified_pass", "medium")), agg.CTM_MIN_SCORE
        )
        self.assertEqual(agg._admission_score(_rec("feature", "verified_pass", "high")), 5)
        # a low-confidence but grader-certified row is floored UP to injectable, not left at 3.
        self.assertEqual(
            agg._admission_score(_rec("bug-fix", "verified_pass", "low")), agg.CTM_MIN_SCORE
        )

    def test_when_code_non_verified_pass_then_subfloor_even_if_high_confidence(self):
        # AC2 + G2 closure: high self-report confidence no longer buys injectable admission for
        # an ungraded code lesson — every non-verified_pass code row lands at the sub-floor.
        for tt in _CODE_TYPES:
            for verdict in ("unverified", "verified_fail", ""):
                self.assertEqual(
                    agg._admission_score(_rec(tt, verdict, "high")),
                    agg.CTM_SUBFLOOR_SCORE,
                    msg=f"{tt}/{verdict} should admit at sub-floor",
                )
        self.assertLess(agg.CTM_SUBFLOOR_SCORE, agg.CTM_MIN_SCORE)  # sub-floor is NOT injectable

    def test_when_refactor_unverified_then_subfloor_not_discarded(self):
        # Refactor is structurally verified_pass=0 (T0); it must still admit (provisionally).
        self.assertEqual(agg._admission_score(_rec("refactor", "unverified", "high")), 3)
        self.assertEqual(agg.classify_lesson_bucket(_rec("refactor", "unverified", "high")), "ctm")

    def test_when_noncode_score_ignores_grader_verdict(self):
        # AC5: non-code entries keep the self-report confidence score; the verdict is inert.
        self.assertEqual(agg._admission_score(_rec("doc", "verified_pass", "low")), 3)
        self.assertEqual(agg._admission_score(_rec("doc", "unverified", "high")), 5)


class ClassifyPolarity(unittest.TestCase):
    """AC1 / AC2 / AC5 — routing: code always admits, non-code predicate byte-identical."""

    def test_when_code_done_metricpass_then_always_ctm_regardless_of_verdict_or_confidence(self):
        for tt in _CODE_TYPES:
            for verdict in ("verified_pass", "unverified", ""):
                for conf in ("high", "medium", "low"):
                    self.assertEqual(
                        agg.classify_lesson_bucket(_rec(tt, verdict, conf)),
                        "ctm",
                        msg=f"{tt}/{verdict}/{conf} should route to ctm, never be discarded",
                    )

    def test_when_code_verified_fail_then_failure_memory_not_discarded(self):
        # The shared negative-signal predicate counts the grader's failure verdict as a term
        # of its own, so a graded-failed code row is stored in failure memory rather than as a
        # success exemplar. Still not a discard, which is what T19 protects. Production pairs
        # verified_fail with review_flag (track-outcome.sh), so this route is unchanged there.
        for tt in _CODE_TYPES:
            for conf in ("high", "medium", "low"):
                self.assertEqual(
                    agg.classify_lesson_bucket(_rec(tt, "verified_fail", conf)),
                    "epm",
                    msg=f"{tt}/verified_fail/{conf} should route to epm",
                )

    def test_when_low_confidence_code_then_ctm_not_none(self):
        # The behaviour flip vs HEAD: a low-confidence code lesson was dropped (None); now it is
        # admitted provisionally (ctm) rather than discarded.
        self.assertEqual(agg.classify_lesson_bucket(_rec("refactor", "", "low")), "ctm")

    def test_when_code_negative_then_still_epm(self):
        # Polarity does not override the negative-signal route.
        self.assertEqual(agg.classify_lesson_bucket(_rec("feature", "", "high", result="fail")), "epm")
        self.assertEqual(
            agg.classify_lesson_bucket(
                {"task_type": "bug-fix", "result": "done", "metric_pass": True, "revision_count": 2}
            ),
            "epm",
        )

    def test_when_noncode_predicate_byte_identical(self):
        # AC5: for non-code types, admission is gated by confidence ONLY and is unaffected by the
        # grader verdict — a verified_pass cannot rescue a low-confidence non-code row, and a
        # high-confidence one admits regardless of an absent verdict.
        for tt in _NON_CODE_TYPES:
            self.assertIsNone(
                agg.classify_lesson_bucket(_rec(tt, "verified_pass", "low")),
                msg=f"{tt} low-confidence must skip even with verified_pass (predicate unchanged)",
            )
            self.assertEqual(
                agg.classify_lesson_bucket(_rec(tt, "", "high")),
                "ctm",
                msg=f"{tt} high-confidence admits (predicate unchanged)",
            )


class CorroborationPromotion(unittest.TestCase):
    """AC2 (promotion half) — a provisional lesson promotes to the injectable floor at frequency."""

    def _prov_entry(self, text="unverified refactor advice"):
        return agg._outcome_to_lesson_entry(_rec("refactor", "unverified", "high", lesson=text), "2026-07-22")

    def test_when_provisional_single_observation_then_stays_subfloor(self):
        bucket: list[dict] = []
        agg.ingest_lesson(bucket, self._prov_entry())
        self.assertEqual(bucket[0]["score"], agg.CTM_SUBFLOOR_SCORE)
        self.assertLess(bucket[0]["score"], agg.CTM_MIN_SCORE)  # not injectable on one sighting

    def test_when_provisional_reobserved_then_promotes_to_injectable_floor(self):
        bucket: list[dict] = []
        agg.ingest_lesson(bucket, self._prov_entry())
        op = agg.ingest_lesson(bucket, self._prov_entry())  # corroboration
        self.assertEqual(op, "UPDATE")
        self.assertEqual(bucket[0]["frequency"], agg.CTM_PROMOTE_FREQUENCY)
        self.assertGreaterEqual(bucket[0]["score"], agg.CTM_MIN_SCORE)  # now injectable

    def test_when_already_injectable_then_no_spurious_change(self):
        # A verified/high entry never downgrades and the promotion branch is a no-op for it.
        bucket: list[dict] = []
        e = agg._outcome_to_lesson_entry(_rec("feature", "verified_pass", "high"), "2026-07-22")
        agg.ingest_lesson(bucket, e)
        agg.ingest_lesson(bucket, e)
        self.assertEqual(bucket[0]["score"], 5)


class EvictionGuard(unittest.TestCase):
    """AC4 — a young provisional keeps BOUNDED eviction headroom, enough to reach promotion.

    The guard's original shape gave provisionals unconditional precedence over every other live
    entry. Its intent is preserved here and only its shape changes: sub-floor entries still outrank
    corroborated ones for survival, but only CTM_PROVISIONAL_HEADROOM of them at a time. The
    unbounded form inverted the channel — under a permanently saturated store the only rows the
    injector can ever read (score >= CTM_MIN_SCORE) were structurally the first discarded, while
    rows that are by definition not injectable were held. Measured on the live store at reversal
    time: 1632 injectable admissions over 30 days, 0 injectable rows resident.

    Of the four cases below only test_when_provisionals_exceed_headroom_then_injectable_survives is
    red against the pre-change ranking; the other three assert the intent the reversal PRESERVES and
    are green on both sides by construction. Flipping them would mean discarding the corroboration
    path, which is the trade this reversal explicitly refuses.
    """

    def _corroborated(self, tag, n=100):
        return {"agent": "a", "task_type": "feature", "text": tag * n, "score": 5,
                "frequency": 5, "tombstoned": False, "added": "2026-07-22"}

    def _provisional(self, tag, added, n=100):
        return {"agent": "a", "task_type": "refactor", "text": tag * n, "score": 3,
                "frequency": 1, "tombstoned": False, "added": added}

    def test_when_young_provisional_within_headroom_then_it_survives_over_corroborated(self):
        # Intent PRESERVED: inside the bound a score-3 provisional still outranks corroborated
        # entries for survival, so it lives long enough to be re-observed.
        bucket = [self._corroborated(c) for c in "ABCD"] + [self._provisional("P", "2026-07-22")]
        agg.enforce_bucket_cap(bucket, 250, today="2026-07-22")  # 500 active → must drop 3
        self.assertLessEqual(agg._bucket_active_size(bucket), 250)  # cap invariant
        self.assertTrue(any(e.get("text", "").startswith("P") for e in bucket))  # survived
        self.assertTrue(
            any(e.get("score") == 3 for e in bucket if not e.get("digest"))
        )

    def test_when_provisionals_exceed_headroom_then_injectable_survives(self):
        # The reversal itself, and the ONLY case here that is red pre-change. Five young
        # provisionals against three corroborated, with room for five survivors: the unbounded
        # guard protects all five provisionals and evicts every injectable row (the live outage's
        # exact shape). Bounded, the over-bound provisionals rank normally — below every
        # at-or-above-floor entry by score — so the injectable rows survive instead.
        provisionals = [
            self._provisional(c, "2026-07-%02d" % (18 + i)) for i, c in enumerate("PQRST")
        ]
        bucket = [self._corroborated(c) for c in "ABC"] + provisionals
        agg.enforce_bucket_cap(bucket, 500, today="2026-07-22")  # 800 active → drop 3
        self.assertLessEqual(agg._bucket_active_size(bucket), 500)  # cap invariant
        live = [e for e in bucket if not e.get("digest")]
        injectable = [e for e in live if e.get("score", 0) >= agg.CTM_MIN_SCORE]
        self.assertEqual(
            len(injectable), 3,
            "every at-or-above-floor entry must survive when provisionals exceed the headroom",
        )
        # Headroom is a bound, not a reservation of the whole bucket.
        surviving_provisionals = [e for e in live if e.get("score", 0) < agg.CTM_MIN_SCORE]
        self.assertEqual(len(surviving_provisionals), agg.CTM_PROVISIONAL_HEADROOM)
        # The slots go to the YOUNGEST eligible entries — most window left to be re-observed.
        self.assertEqual(
            sorted(e["added"] for e in surviving_provisionals), ["2026-07-21", "2026-07-22"]
        )

    def test_when_provisional_beyond_grace_then_evicted_normally(self):
        # Intent PRESERVED and untouched by the bound: past the grace window an entry is not
        # eligible for headroom at all, so age still culls it before any corroborated entry.
        bucket = [self._corroborated(c) for c in "ABCD"] + [self._provisional("P", "2020-01-01")]
        agg.enforce_bucket_cap(bucket, 350, today="2026-07-22")  # 500 active → drop ~2
        self.assertLessEqual(agg._bucket_active_size(bucket), 350)
        self.assertFalse(
            any(e.get("text", "").startswith("P") for e in bucket)
        )  # aged provisional culled first

    def test_when_only_provisionals_over_cap_then_invariant_still_holds(self):
        # Best-effort guard, not a hard reservation: if protected entries are the only candidates
        # they are still evicted so the active sum returns under cap.
        bucket = [self._provisional(str(i), "2026-07-22") for i in range(6)]  # 600 active
        agg.enforce_bucket_cap(bucket, 250, today="2026-07-22")
        self.assertLessEqual(agg._bucket_active_size(bucket), 250)

    def test_end_to_end_provisional_survives_then_promotes(self):
        # The full R-a loop, one provisional so it sits inside the headroom: admit → survive
        # eviction → corroborate → promote. Intent PRESERVED; the bound is not exercised at N=1.
        bucket = [self._corroborated(c) for c in "ABCD"]
        entry = agg._outcome_to_lesson_entry(
            _rec("refactor", "unverified", "high", lesson="prefer pathlib over os.path"), "2026-07-22"
        )
        agg.ingest_lesson(bucket, entry)  # provisional score-3 added, young
        self.assertEqual(len(bucket), 5)
        agg.enforce_bucket_cap(bucket, 250, today="2026-07-22")  # over cap → headroom protects it
        surviving = [e for e in bucket if e.get("task_type") == "refactor" and not e.get("digest")]
        self.assertEqual(len(surviving), 1, "provisional inside the headroom must survive eviction")
        agg.ingest_lesson(bucket, entry)  # re-observed → promotes
        promoted = next(e for e in bucket if e.get("task_type") == "refactor" and not e.get("digest"))
        self.assertGreaterEqual(promoted["score"], agg.CTM_MIN_SCORE)


class RefactorNotStarved(unittest.TestCase):
    """AC3 — refactor CTM contribution is greater than zero after the change (end-to-end)."""

    def test_when_refactor_unverified_batch_then_ctm_nonzero(self):
        import json

        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "lessons.json")
            # Roster pinned to a fixture: without it this reads the LIVE install registry and is
            # green for two unrelated reasons (a roster that happens to list the fixture agent, or
            # an absent registry taking the fail-open branch) while going red on any install whose
            # roster differs. The gate is not what this case is asserting.
            registry_path = os.path.join(d, "agent-registry.json")
            Path(registry_path).write_text(
                json.dumps({"agents": {_rec("refactor")["agent"]: {}}}), encoding="utf-8"
            )
            # A realistic refactor stream: done + metric_pass, but the grader is (as T0 measured)
            # structurally unable to certify refactor → verdict never verified_pass.
            records = [
                _rec("refactor", "unverified", "high", lesson=f"refactor lesson {i}")
                for i in range(4)
            ]
            agg.ingest_outcome_lessons(records, path, registry_path=registry_path)

            store = json.loads(Path(path).read_text())
            refactor_ctm = [e for e in store["ctm"] if e.get("task_type") == "refactor"]
            self.assertGreater(len(refactor_ctm), 0, "refactor CTM must be > 0 (AC3 anti-starvation)")

    def test_when_naive_flip_would_zero_refactor_then_r_a_keeps_it(self):
        # Documents the polarity choice: an unverified refactor lesson is ADMITTED (sub-floor),
        # not dropped as a naive verified_pass-or-discard flip would have done.
        self.assertIsNotNone(agg.classify_lesson_bucket(_rec("refactor", "unverified", "high")))
        self.assertIsNotNone(agg.classify_lesson_bucket(_rec("refactor", "verified_fail", "low")))


if __name__ == "__main__":
    unittest.main()
