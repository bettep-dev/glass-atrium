#!/usr/bin/env python3
# AD-9 evaluator independence + AD-10 Pareto variant retention regressions.
#
# AD-9 (CALM self-preference precedent): the pre-verify verifier model class
# should differ from the proposal-author class where feasible; when infeasible
# (same class) the run proceeds under a loud advisory, never blocking.
# AC: verifier != author class when feasible.
#
# AD-10 (GEPA precedent): Solution History retains per-(agent, task_type)
# Pareto WINNERS (not one scalar-best); a cell is retained only at the
# min-occurrence floor (5+). AC: multiple winners retained per cell;
# min-occurrence enforced.
#
# Run: python3 -m unittest autoagent.test.test_evaluator_independence_pareto
#   (or, from autoagent/test/) python3 -m unittest test_evaluator_independence_pareto

from __future__ import annotations

import io
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
_HOOKS_DIR = _REPO_ROOT / "hooks"
_AUTOAGENT_DIR = _REPO_ROOT / "autoagent"

if str(_HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(_HOOKS_DIR))
if str(_AUTOAGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_DIR))

try:
    import daemon_cycle as dc

    _IMPORT_ERROR: Exception | None = None
except Exception as exc:  # noqa: BLE001 — psycopg absent → skip, not error
    dc = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestModelClass(unittest.TestCase):
    def test_when_haiku_id_then_haiku_class(self) -> None:
        self.assertEqual(dc._model_class("claude-haiku-4-5"), "haiku")

    def test_when_sonnet_id_then_sonnet_class(self) -> None:
        self.assertEqual(dc._model_class("claude-sonnet-4-5"), "sonnet")

    def test_when_opus_id_then_opus_class(self) -> None:
        self.assertEqual(dc._model_class("claude-opus-4-8"), "opus")

    def test_when_unknown_id_then_lowercased_id(self) -> None:
        # Unknown shapes must NOT collapse to a known family (false independence).
        self.assertEqual(dc._model_class("Mystery-Model"), "mystery-model")


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestResolveVerifierModel(unittest.TestCase):
    def test_when_distinct_class_then_no_warning(self) -> None:
        # AC: verifier != author class when feasible → the distinct model is used
        # with no advisory noise.
        buf = io.StringIO()
        with redirect_stderr(buf):
            resolved = dc.resolve_verifier_model(
                author_model="claude-haiku-4-5",
                verifier_model="claude-sonnet-4-5",
            )
        self.assertEqual(resolved, "claude-sonnet-4-5")
        self.assertNotEqual(
            dc._model_class("claude-sonnet-4-5"), dc._model_class("claude-haiku-4-5")
        )
        self.assertEqual(buf.getvalue(), "")

    def test_when_same_class_then_advisory_but_not_blocked(self) -> None:
        # Infeasible independence (same class) → loud advisory, but the model is
        # still returned (advisory-first: never blocks the loop).
        buf = io.StringIO()
        with redirect_stderr(buf):
            resolved = dc.resolve_verifier_model(
                author_model="claude-haiku-4-5",
                verifier_model="claude-haiku-4-5",
            )
        self.assertEqual(resolved, "claude-haiku-4-5")
        self.assertIn("evaluator independence not satisfied", buf.getvalue())

    def test_default_verifier_model_resolves(self) -> None:
        # The module-level PRE_VERIFY_MODEL default is a non-empty model id.
        self.assertTrue(dc.PRE_VERIFY_MODEL)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestRetainParetoWinners(unittest.TestCase):
    @staticmethod
    def _cell(n: int, agent: str = "dev-python", tt: str = "feature") -> list:
        # n identical-cell attempts with strictly increasing score and date so
        # exactly ONE is the frontier (baseline for the multi-winner contrast).
        return [
            dc.SolutionAttempt(
                agent=agent,
                task_type=tt,
                score=float(i + 1),
                applied_date=f"2026-07-{i + 1:02d}",
                lesson=f"lesson-{i}",
                directive_hint=f"hint-{i}",
            )
            for i in range(n)
        ]

    def test_when_cell_below_min_occurrence_then_dropped(self) -> None:
        # AC: min-occurrence enforced — 4 attempts (< 5) → cell dropped entirely.
        winners = dc.retain_pareto_winners(self._cell(4))
        self.assertEqual(winners, {})

    def test_when_cell_at_min_occurrence_then_retained(self) -> None:
        # Exactly 5 attempts (>= floor) → cell retained.
        winners = dc.retain_pareto_winners(self._cell(5))
        self.assertIn(("dev-python", "feature"), winners)

    def test_when_score_recency_tradeoff_then_multiple_winners(self) -> None:
        # AC: multiple winners retained per cell (not one scalar-best). Build a
        # cell where the highest-score attempt is OLD and the newest attempt has
        # a lower score → both are Pareto-nondominated (tradeoff frontier).
        agent, tt = "dev-node", "refactor"
        attempts = [
            dc.SolutionAttempt(agent, tt, 5.0, "2026-01-01", "high-old", "h0"),
            dc.SolutionAttempt(agent, tt, 3.0, "2026-06-01", "mid-new", "h1"),
            dc.SolutionAttempt(agent, tt, 2.0, "2026-03-01", "dominated", "h2"),
            dc.SolutionAttempt(agent, tt, 1.0, "2026-02-01", "dominated2", "h3"),
            dc.SolutionAttempt(agent, tt, 4.0, "2026-04-01", "dominated3", "h4"),
        ]
        winners = dc.retain_pareto_winners(attempts)
        cell = winners[(agent, tt)]
        lessons = {w.lesson for w in cell}
        # high-old (best score) and mid-new (best recency) both survive.
        self.assertIn("high-old", lessons)
        self.assertIn("mid-new", lessons)
        self.assertGreaterEqual(len(cell), 2)
        # The 4.0@2026-04 attempt is dominated by 5.0@2026-01? No — newer date but
        # lower score, so it is NOT dominated by high-old; it IS dominated by
        # mid-new only if mid-new is both >= score AND >= date, which it is not
        # (3.0 < 4.0). So verify domination removed the strictly-worse points.
        self.assertNotIn("dominated2", lessons)

    def test_winners_sorted_score_desc(self) -> None:
        agent, tt = "dev-node", "bug-fix"
        attempts = [
            dc.SolutionAttempt(agent, tt, 5.0, "2026-01-01", "a", ""),
            dc.SolutionAttempt(agent, tt, 3.0, "2026-06-01", "b", ""),
            dc.SolutionAttempt(agent, tt, 4.0, "2026-05-01", "c", ""),
            dc.SolutionAttempt(agent, tt, 2.0, "2026-04-01", "d", ""),
            dc.SolutionAttempt(agent, tt, 1.0, "2026-03-01", "e", ""),
        ]
        cell = dc.retain_pareto_winners(attempts)[(agent, tt)]
        scores = [w.score for w in cell]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_reflective_signal_preserved_on_winners(self) -> None:
        # AC intent: lesson + directive_hint travel with the retained winners
        # (the reflective mutation signal for the next cycle).
        cell = dc.retain_pareto_winners(self._cell(5))[("dev-python", "feature")]
        top = cell[0]
        self.assertTrue(top.lesson)
        self.assertTrue(top.directive_hint)

    def test_separate_cells_retained_independently(self) -> None:
        # Two distinct (agent, task_type) cells, each at the floor → both kept.
        attempts = self._cell(5, agent="dev-python", tt="feature") + self._cell(
            5, agent="dev-node", tt="review"
        )
        winners = dc.retain_pareto_winners(attempts)
        self.assertIn(("dev-python", "feature"), winners)
        self.assertIn(("dev-node", "review"), winners)

    def test_when_min_occurrence_below_one_then_raises(self) -> None:
        with self.assertRaises(ValueError):
            dc.retain_pareto_winners(self._cell(5), min_occurrence=0)


@unittest.skipIf(dc is None, f"import failed: {_IMPORT_ERROR}")
class TestSolutionAttemptFromOutcome(unittest.TestCase):
    @staticmethod
    def _mk(**kw) -> object:
        base = dict(
            path="p",
            agent="dev-python",
            task_type="feature",
            result="done",
            confidence="high",
            metric_pass="true",
            summary="s",
            lesson="l",
        )
        base.update(kw)
        return dc.Outcome(**base)

    def test_metric_pass_true_scores_higher_than_false(self) -> None:
        passing = dc.solution_attempt_from_outcome(
            self._mk(metric_pass="true"), "2026-07-01"
        )
        failing = dc.solution_attempt_from_outcome(
            self._mk(metric_pass="false"), "2026-07-01"
        )
        self.assertGreater(passing.score, failing.score)

    def test_correction_pulls_score_down(self) -> None:
        clean = dc.solution_attempt_from_outcome(
            self._mk(evaluative_signal=0), "2026-07-01"
        )
        corrected = dc.solution_attempt_from_outcome(
            self._mk(evaluative_signal=-1), "2026-07-01"
        )
        self.assertLess(corrected.score, clean.score)

    def test_score_clamped_to_1_5(self) -> None:
        att = dc.solution_attempt_from_outcome(
            self._mk(metric_pass="true", evaluative_signal=1), "2026-07-01"
        )
        self.assertLessEqual(att.score, 5.0)
        self.assertGreaterEqual(att.score, 1.0)

    def test_directive_hint_passed_through(self) -> None:
        att = dc.solution_attempt_from_outcome(
            self._mk(), "2026-07-01", directive_hint="move the gate, not the regex"
        )
        self.assertEqual(att.directive_hint, "move the gate, not the regex")


if __name__ == "__main__":
    unittest.main()
