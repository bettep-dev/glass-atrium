#!/usr/bin/env python3
"""R8 — CTM injection-starvation release (clauded-docs/760 Decision 5, option O1).

The success channel delivers nothing because admission forces every code-arm lesson that is not
a grader `verified_pass` to the sub-floor, and `verified_pass` is gated on a two-element
task-type bar (bug-fix/feature) that refactor can structurally never clear. O1 admits a code-arm
lesson AT the injectable floor when its row carries a test/specification path in the changed-file
list, whatever its arm — the same mechanical evidence `_cbg_files_test_evidence`
(hooks/lib/code-based-grader.sh) already promotes on, minus the arm gate. The verified-fail
exclusion and the injectable-floor value are untouched.

Every assertion in AdmissionFloorRelease FAILS at HEAD (no path lifts a non-verified_pass code
lesson off the sub-floor) and PASSES after. Pure functions, no PG, no filesystem dependence —
mirrors the aggregator-test convention.

    python3 -m unittest hooks.test.test_ctm_admission_promotion -v
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


def _rec(task_type, files=None, verdict="unverified", confidence="medium", **over):
    rec = {
        "agent": "glass-atrium-dev-python",
        "task_type": task_type,
        "grader_verdict": verdict,
        "confidence": confidence,
        "result": "done",
        "metric_pass": True,
        "lesson": "x",
        "files_modified": list(files or []),
    }
    rec.update(over)
    return rec


# Frozen snapshot of the LIVE corpus measured 2026-07-31 (the eleven non-digest CTM entries in
# ~/.glass-atrium/data/lessons.json, joined back to their core.outcomes rows on
# (agent, task_type, normalized lesson text) — 11/11 matched). Home-directory prefixes are
# rewritten to /Users/testuser (the repo corpus convention); the predicate reads basenames only,
# so the rewrite is measurement-neutral. Frozen here rather than re-queried so the blocking
# eligibility criterion runs database-free.
_LIVE_CORPUS_2026_07_31 = [
    ("glass-atrium-intel-researcher", "research", 3, []),
    ("glass-atrium-dev-nestjs", "refactor", 3, [
        "src/system/shared/app/translation.ts",
        "src/system/shared/app/target.ts",
        "src/system/shared/app/edit.ts",
        "src/system/shared/app/sns.ts",
        "src/system/shared/app/blog.ts",
        "src/system/shared/app/article.ts",
        "src/system/prompt/prompt.service.ts",
        "src/system/prompt/prompts/act/prompt-parity-golden.spec.ts",
        "src/web/app/v1/app-form-prompt-parity.spec.ts",
    ]),
    ("glass-atrium-dev-nestjs", "feature", 3, [
        "/Users/testuser/Desktop/git/yoaida/api.yoaida.com-409/src/web/app/v1/app.controller.ts",
    ]),
    ("glass-atrium-dev-nestjs", "feature", 3, [
        "/Users/testuser/Desktop/git/yoaida/api.yoaida.com-409/src/system/conversation/dto/conversation.ts",
    ]),
    ("glass-atrium-dev-react", "refactor", 3, [
        "/Users/testuser/Desktop/git/yoaida/yoaida.com-409/src/components/app/pro/image/enum/type.ts",
        "/Users/testuser/Desktop/git/yoaida/yoaida.com-409/src/type/openapispec/openapispec.ts",
        "/Users/testuser/Desktop/git/yoaida/yoaida.com-409/src/components/app/pro/image/template.ts",
        "/Users/testuser/Desktop/git/yoaida/yoaida.com-409/src/components/app/pro/image/template-fields.ts",
        "/Users/testuser/Desktop/git/yoaida/yoaida.com-409/src/components/app/pro/image/fields/canonical.ts",
    ]),
    ("glass-atrium-dev-react", "refactor", 3, [
        "src/components/app/pro/image/enum/type.ts",
        "src/components/app/pro/translation/enum/type.ts",
        "src/components/app/pro/image/template.ts",
        "src/components/app/pro/image/chips/fitness.ts",
        "src/components/app/pro/image/controls/attribute-picker.tsx",
        "src/components/app/pro/image/submit/message.ts",
        "src/components/app/pro/image/fields/civic.ts",
        "src/components/app/pro/image/fields/content.ts",
        "src/components/app/pro/image/fields/general.ts",
        "src/components/app/pro/image/fields/media.ts",
        "src/components/app/pro/image/fields/options.ts",
        "e2e/smoke/image-category-swap.spec.ts",
        "e2e/smoke/image-chip-fitness.spec.ts",
        "e2e/smoke/image-fields-channel.spec.ts",
        "e2e/smoke/image-resolution-channel.spec.ts",
        "e2e/smoke/image-submit-modes.spec.ts",
        "e2e/smoke/image-validation-contract.spec.ts",
    ]),
    ("glass-atrium-dev-react", "bug-fix", 3, [
        "src/components/app/pro/image/template.ts",
        "src/components/app/pro/image/task-grid.tsx",
        "src/components/app/pro/image/form.tsx",
        "src/components/app/pro/image/category-form.tsx",
        "src/components/app/pro/image/chips/category.tsx",
        "src/components/app/pro/image/chips/fitness.ts",
    ]),
    ("glass-atrium-dev-react", "feature", 3, [
        "src/components/conversation/message/components/component.tsx",
        "src/components/conversation/message/components/image.tsx",
        "src/components/conversation/message/components/image-urls.ts",
        "e2e/unit/message-image-urls.spec.ts",
    ]),
    ("glass-atrium-dev-react", "refactor", 3, [
        "src/components/app/pro/image/form/share/canonical.ts",
        "src/components/app/pro/image/form/share/values.ts",
        "src/components/app/pro/image/form/share/content.ts",
        "src/components/app/pro/image/form/share/anchor.ts",
        "src/components/app/pro/image/form/card/fields.ts",
        "src/components/app/pro/image/form/poster/fields.ts",
        "src/components/app/pro/image/form/poster/anchor.ts",
        "src/components/app/pro/image/submit/message.ts",
        "src/components/app/pro/image/template-fields.ts",
        "src/components/app/pro/image/category-form.tsx",
    ]),
    ("glass-atrium-dev-react", "refactor", 3, [
        "/Users/testuser/Desktop/git/yoaida/yoaida.com-409/src/components/app/pro/image/form/share/canonical.ts",
        "/Users/testuser/Desktop/git/yoaida/yoaida.com-409/src/components/app/pro/image/template-fields.ts",
        "/Users/testuser/Desktop/git/yoaida/yoaida.com-409/src/components/app/pro/sns/enum/type.ts",
        "/Users/testuser/Desktop/git/yoaida/yoaida.com-409/src/components/app/pro/email/enum/type.ts",
        "/Users/testuser/Desktop/git/yoaida/yoaida.com-409/src/components/app/pro/translation/enum/type.ts",
        "/Users/testuser/Desktop/git/yoaida/yoaida.com-409/src/type/openapispec/openapispec.ts",
    ]),
    ("glass-atrium-dev-python", "feature", 4, [
        "hooks/_pg_learning_dualwrite.py",
        "hooks/test/test_learning_pattern_discharge.py",
    ]),
]

# Measured 2026-07-31 against the snapshot above: four entries carry test-path evidence, three of
# which currently sit at the sub-floor and are newly released. Non-zero, so the signal is
# admissible and R8 ships rather than escalating.
_MEASURED_ELIGIBLE = 4
_MEASURED_NEWLY_RELEASED = 3


class TestPathEvidencePredicate(unittest.TestCase):
    """The evidence predicate mirrors the grader's basename shapes and its glob veto."""

    def test_when_test_shaped_basename_then_evidence(self):
        for path in (
            "e2e/unit/message.spec.ts",
            "src/foo.test.tsx",
            "hooks/test/test_learning_pattern_discharge.py",
            "hooks/test/enforce-delegation.bats",
            "pkg/service_test.go",
            "spec/thing_spec.rb",
        ):
            self.assertTrue(
                agg._files_test_evidence([path, "src/plain.ts"]), msg=f"{path} is test-shaped"
            )

    def test_when_no_test_shaped_basename_then_no_evidence(self):
        self.assertFalse(agg._files_test_evidence(["src/a.ts", "src/b/c.tsx", "README.md"]))
        # a directory named test does NOT make a production file test-shaped (basename rule).
        self.assertFalse(agg._files_test_evidence(["src/test/helper.ts"]))

    def test_when_glob_anywhere_then_field_non_gradeable(self):
        # Mirrors the grader's Step 1: an unresolved glob makes the WHOLE field non-gradeable.
        self.assertFalse(agg._files_test_evidence(["src/**/*.spec.ts"]))
        self.assertFalse(agg._files_test_evidence(["a.spec.ts", "src/*.ts"]))

    def test_when_field_absent_or_unparseable_then_no_evidence(self):
        # Fail-closed on ambiguity: an absent/blank/non-path field yields no promotion, and the
        # lesson stays admitted at the sub-floor rather than being discarded (never a lockout).
        for files in ([], [""], ["   "], ["notapath"], None):
            self.assertFalse(agg._files_test_evidence(files))


class AdmissionFloorRelease(unittest.TestCase):
    """FAILS AT HEAD — no path lifts a non-verified_pass code lesson off the sub-floor."""

    def test_when_code_arm_outside_hard_bar_carries_test_path_then_injectable_floor(self):
        # refactor is structurally verified_pass=0, so this is the arm the starvation traps.
        score = agg._admission_score(_rec("refactor", ["src/a.ts", "e2e/a.spec.ts"]))
        self.assertGreaterEqual(score, agg.CTM_MIN_SCORE)
        for tt in _CODE_TYPES:
            self.assertGreaterEqual(
                agg._admission_score(_rec(tt, ["src/a.ts", "src/a.test.ts"])),
                agg.CTM_MIN_SCORE,
                msg=f"{tt} with test-path evidence must reach the injectable floor",
            )

    def test_when_code_arm_carries_no_test_path_then_still_subfloor(self):
        # Not a blanket admission: the row must actually carry the evidence.
        for tt in _CODE_TYPES:
            self.assertEqual(
                agg._admission_score(_rec(tt, ["src/a.ts", "src/b.ts"])),
                agg.CTM_SUBFLOOR_SCORE,
                msg=f"{tt} without test-path evidence must stay provisional",
            )

    def test_when_verified_fail_then_never_lifted_by_test_path(self):
        # The verified-fail exclusion is preserved unchanged: evidence cannot rescue it.
        self.assertEqual(
            agg._admission_score(_rec("refactor", ["e2e/a.spec.ts"], verdict="verified_fail")),
            agg.CTM_SUBFLOOR_SCORE,
        )
        # a production verified_fail carries review_flag → failure memory, evidence notwithstanding.
        self.assertEqual(
            agg.classify_lesson_bucket(
                _rec("refactor", ["e2e/a.spec.ts"], verdict="verified_fail", review_flag=True)
            ),
            "epm",
        )
        # non-code verified_fail is still not admitted to the success channel — the shared
        # predicate counts the grader verdict itself, so it lands in failure memory whether or
        # not the review_flag the production path always pairs with it is present.
        self.assertEqual(
            agg.classify_lesson_bucket(
                _rec("doc", ["e2e/a.spec.ts"], verdict="verified_fail", confidence="high")
            ),
            "epm",
        )

    def test_when_non_code_then_admission_unchanged(self):
        # Test-path evidence is inert outside the code arms; the confidence gate is untouched.
        for tt in _NON_CODE_TYPES:
            self.assertEqual(
                agg._admission_score(_rec(tt, ["e2e/a.spec.ts"], confidence="medium")),
                3,
                msg=f"{tt} keeps its self-report confidence score",
            )
            self.assertEqual(
                agg._admission_score(_rec(tt, ["e2e/a.spec.ts"], confidence="high")), 5
            )
            self.assertIsNone(
                agg.classify_lesson_bucket(_rec(tt, ["e2e/a.spec.ts"], confidence="low"))
            )

    def test_when_verified_pass_then_floor_behaviour_unchanged(self):
        self.assertEqual(agg._admission_score(_rec("feature", [], verdict="verified_pass")), 4)
        self.assertEqual(
            agg._admission_score(_rec("feature", [], verdict="verified_pass", confidence="high")), 5
        )

    def test_when_floor_value_read_then_untouched(self):
        # One edit site: the floor itself is not moved to manufacture eligibility.
        self.assertEqual(agg.CTM_MIN_SCORE, 4)
        self.assertEqual(agg.CTM_SUBFLOOR_SCORE, 3)


class FailureChannelUnchanged(unittest.TestCase):
    """Regression pin — the widened success channel must not touch the failure channel."""

    def test_when_negative_signal_then_epm_regardless_of_test_path(self):
        for over in ({"result": "fail"}, {"revision_count": 2}, {"evaluative_signal": "-1"}):
            self.assertEqual(
                agg.classify_lesson_bucket(_rec("feature", ["a.spec.ts"], **over)),
                "epm",
                msg=f"{over} must still route to failure memory",
            )

    def test_when_code_lesson_lacks_evidence_then_still_admitted_not_discarded(self):
        # The release must never become a new discard rule — a lockout of the very arm it frees.
        for tt in _CODE_TYPES:
            self.assertEqual(agg.classify_lesson_bucket(_rec(tt, [])), "ctm")


class LiveCorpusEligibility(unittest.TestCase):
    """Blocking criterion — measured effect on the live corpus, not a fixture demonstration."""

    def _scored(self):
        return [
            (agent, tt, stored, agg._admission_score(_rec(tt, files, agent=agent)))
            for agent, tt, stored, files in _LIVE_CORPUS_2026_07_31
        ]

    def test_when_live_corpus_replayed_then_eligibility_is_nonzero(self):
        eligible = [r for r in self._scored() if r[3] >= agg.CTM_MIN_SCORE]
        self.assertEqual(len(eligible), _MEASURED_ELIGIBLE)
        self.assertGreater(len(eligible), 0, "a zero count makes the signal inadmissible")

    def test_when_live_corpus_replayed_then_newly_released_count_holds(self):
        newly = [
            r for r in self._scored() if r[2] < agg.CTM_MIN_SCORE and r[3] >= agg.CTM_MIN_SCORE
        ]
        self.assertEqual(len(newly), _MEASURED_NEWLY_RELEASED)

    def test_when_live_corpus_replayed_then_non_evidence_rows_stay_provisional(self):
        # Six of the ten live code-arm rows carry no test path and must be unaffected.
        unchanged = [r for r in self._scored() if r[3] < agg.CTM_MIN_SCORE]
        self.assertEqual(len(unchanged), len(_LIVE_CORPUS_2026_07_31) - _MEASURED_ELIGIBLE)


if __name__ == "__main__":
    unittest.main()
