"""Behavioral tests for the group-sequential trial-design module.

Covered behaviors:
  * Lan-DeMets O'Brien-Fleming-type boundaries match a published table;
  * the four-look maximum-sample inflation matches the plan's measured figure;
  * the fixed-sample two-proportion size matches a hand-derived reference;
  * the power check passes at and above twice the per-arm maximum times the
    design effect, and fails below it;
  * a smaller effect needs a larger sample; required units scale with the
    design effect;
  * the projection horizon stops at 84 days; invalid inputs raise;
  * both design-effect estimators match hand-computed balanced and unbalanced
    fixtures, and the power check takes the higher, never below 1;
  * minimum detectable harm per guardrail matches two-sample reference
    arithmetic: a fold rise on rates, a mean shift on the tool_use band.

Every expected value is derived outside this module (published table, plan
line, or hand arithmetic shown inline).

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_trial_design.py -v
    python3 -m unittest autoagent.test.test_trial_design -v
"""

from __future__ import annotations

import math
import random
import sys
import unittest
from pathlib import Path

_LIB_DIR = Path(__file__).resolve().parent.parent / "lib"
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

import trial_design as td  # noqa: E402 — sys.path insert immediately above


class SpendingBoundaries(unittest.TestCase):
    def test_four_equally_spaced_looks_match_the_published_one_sided_0025_table(self) -> None:
        # Source: Lan & DeMets (1983), Biometrika 70(3):659-663, O'Brien-Fleming-type
        # spending; tabulated values for K=4 equally spaced looks, one-sided alpha 0.025,
        # as printed by R ldbounds `ldBounds(t=c(.25,.5,.75,1), iuse=1, alpha=0.025,
        # sides=1)` and gsDesign `gsDesign(k=4, test.type=1, alpha=0.025, sfu=sfLDOF)`.
        published = (4.3326, 2.9631, 2.3590, 2.0141)
        boundaries = td.get_boundaries(alpha=0.025, look_fractions=(0.25, 0.5, 0.75, 1.0))
        self.assertEqual(len(boundaries), len(published))
        for look, (actual, expected) in enumerate(zip(boundaries, published), start=1):
            # 4-decimal table → half-unit rounding + quadrature error
            self.assertAlmostEqual(actual, expected, delta=1e-4, msg=f"look {look}")

    def test_boundaries_decrease_across_looks_and_end_above_the_fixed_critical_value(self) -> None:
        fixed_critical = 1.6448536  # z_{0.95}, one-sided alpha 0.05
        schedules = (
            ("four equally spaced looks", (0.25, 0.5, 0.75, 1.0)),
            ("daily looks over 28 days", tuple(day / 28 for day in range(1, 29))),
        )
        for name, fractions in schedules:
            with self.subTest(name):
                boundaries = td.get_boundaries(alpha=0.05, look_fractions=fractions)
                self.assertTrue(all(math.isfinite(boundary) for boundary in boundaries))
                self.assertTrue(all(later < earlier for earlier, later in zip(boundaries, boundaries[1:])))
                self.assertGreater(boundaries[-1], fixed_critical)


class MaximumSampleInflation(unittest.TestCase):
    def test_four_looks_at_the_plan_configuration_cost_the_plan_measured_inflation(self) -> None:
        # Source: plan clauded-docs/43378 → D3 table: "maximum sample 1.029 times the
        # fixed sample", measured there by numerical integration of the four-look
        # Lan-DeMets O'Brien-Fleming-type efficacy boundaries (one-sided alpha 0.05,
        # power 0.8, 201/601/1201-point grids → 1.02887) with a 2M-path Monte Carlo
        # cross-check ("power 0.79975 at 1.0289"); Measured basis restates it as
        # "2.9% more sample than a fixed design".
        inflation = td.get_inflation_factor(alpha=0.05, power=0.8, look_fractions=(0.25, 0.5, 0.75, 1.0))
        self.assertAlmostEqual(inflation, 1.029, places=3)  # the plan's 3-decimal figure


class FixedSampleSize(unittest.TestCase):
    def test_per_arm_size_matches_the_pooled_two_proportion_reference(self) -> None:
        # Fleiss pooled-null form, no continuity correction, worked by hand for
        # p1 = 0.5, p2 = 0.3 (relative reduction 0.4), one-sided alpha 0.05, power 0.8:
        #   p̄ = 0.4; z_alpha √(2·0.4·0.6) = 1.64485 x 0.69282 = 1.13959
        #   z_β √(0.25 + 0.21) = 0.84162 x 0.67823 = 0.57082
        #   (1.13959 + 0.57082)² / 0.2² = 73.13 → 74 per arm
        # Plan clauded-docs/43378 → Generator inputs states the same comparison
        # "needs about 74 trials per group" [SELF-CHECKED: two-proportion arithmetic].
        size = td.get_fixed_sample_size(0.5, alpha=0.05, power=0.8, relative_reduction=0.4)
        self.assertEqual(size, 74)

    def test_a_smaller_effect_needs_a_larger_maximum_sample(self) -> None:
        for baseline in (0.02, 0.1, 0.3):
            sizes = [
                td.get_maximum_sample_size(baseline, relative_reduction=reduction) for reduction in (0.5, 0.3, 0.2)
            ]
            self.assertLess(sizes[0], sizes[1], msg=f"baseline {baseline}: 50% vs 30%")
            self.assertLess(sizes[1], sizes[2], msg=f"baseline {baseline}: 30% vs 20%")

    def test_the_maximum_sample_is_the_fixed_sample_inflated_by_the_look_schedule(self) -> None:
        inflation = td.get_inflation_factor()
        for baseline in (0.02, 0.1, 0.3):
            fixed = td.get_fixed_sample_size(baseline)
            maximum = td.get_maximum_sample_size(baseline)
            # each side is a ceiling of its own continuous size → ±1 unit slack
            self.assertLessEqual(abs(maximum - fixed * inflation), inflation + 1, msg=f"baseline {baseline}")
            self.assertGreater(maximum, fixed, msg=f"baseline {baseline}")


class PowerCheck(unittest.TestCase):
    def test_verdict_passes_at_and_above_twice_the_maximum_times_the_design_effect(self) -> None:
        maximum = 150
        rows = (
            # (name, projected units, design effect, expected verdict)
            ("one unit below the bound at design effect 1", 299, 1.0, False),
            ("exactly at the bound at design effect 1", 300, 1.0, True),
            ("one unit above the bound at design effect 1", 301, 1.0, True),
            ("one unit below the bound at design effect 2", 599, 2.0, False),
            ("exactly at the bound at design effect 2", 600, 2.0, True),
            ("one unit above the bound at design effect 2", 601, 2.0, True),
        )
        for name, projected, design_effect, expected in rows:
            with self.subTest(name):
                self.assertIs(td.is_powered(projected, maximum, design_effect=design_effect), expected)

    def test_required_units_scale_with_the_design_effect(self) -> None:
        maximum = 166
        base = td.get_required_units(maximum, design_effect=1.0)
        for design_effect in (1.5, 3.1, 7.2):
            self.assertAlmostEqual(
                td.get_required_units(maximum, design_effect=design_effect),
                base * design_effect,
                msg=f"design effect {design_effect}",
            )

    def test_projection_horizon_stops_at_84_days(self) -> None:
        self.assertEqual(td.get_projected_units(5.0), td.get_projected_units(5.0, horizon_days=84))
        with self.assertRaises(ValueError):
            td.get_projected_units(5.0, horizon_days=85)


class DesignEffectEstimators(unittest.TestCase):
    def test_balanced_clusters_give_both_estimators_the_hand_computed_value(self) -> None:
        # Three clusters of 4 binary outcomes: 4/4, 0/4, 2/4 → N = 12, p̄ = 0.5
        #   MSB = 4·(0.25 + 0.25 + 0) / 2 = 1 · MSW = (0 + 0 + 4·0.5·0.5) / (12 - 3) = 1/9
        #   rho = (1 - 1/9) / (1 + 3·1/9) = 2/3 · balanced → n0 = Σm²/N = 4 → DE = 1 + 3·2/3 = 3
        clusters = ([1, 1, 1, 1], [0, 0, 0, 0], [1, 1, 0, 0])
        effect = td.get_design_effect(clusters)
        self.assertAlmostEqual(effect.anova, 3.0)
        self.assertAlmostEqual(effect.size_weighted, 3.0)
        self.assertAlmostEqual(effect.selected, 3.0)

    def test_unbalanced_clusters_give_each_estimator_its_hand_computed_value(self) -> None:
        # Clusters 2/2, 0/4, 3/6 → N = 12, p̄ = 5/12, k = 3
        #   SSB = 2(7/12)² + 4(5/12)² + 6(1/12)² = 17/12 → MSB = 17/24
        #   SSW = 6·0.5·0.5 = 3/2 → MSW = (3/2) / 9 = 1/6
        #   n0 = (12 - 56/12) / 2 = 11/3 · size-weighted size Σm²/N = 56/12 = 14/3
        #   rho = (17/24 - 4/24) / (17/24 + (8/3)(1/6)) = (13/24) / (83/72) = 39/83
        #   ANOVA DE = 1 + (8/3)(39/83) = 187/83 · size-weighted DE = 1 + (11/3)(39/83) = 226/83
        clusters = ([1, 1], [0, 0, 0, 0], [1, 1, 1, 0, 0, 0])
        effect = td.get_design_effect(clusters)
        self.assertAlmostEqual(effect.anova, 187 / 83)
        self.assertAlmostEqual(effect.size_weighted, 226 / 83)
        self.assertAlmostEqual(effect.selected, 226 / 83)

    def test_the_power_check_value_is_the_higher_estimator_and_never_below_one(self) -> None:
        generator = random.Random(20261006)
        for draw in range(200):
            clusters = [
                [generator.random() < rate for _ in range(generator.randint(1, 30))]
                for rate in (generator.random() for _ in range(generator.randint(2, 12)))
            ]
            with self.subTest(draw=draw):
                effect = td.get_design_effect(clusters)
                self.assertEqual(effect.selected, max(effect.anova, effect.size_weighted))
                self.assertGreaterEqual(effect.size_weighted, effect.anova)
                self.assertGreaterEqual(effect.anova, 1.0)

    def test_less_between_cluster_variation_than_chance_gives_design_effect_one(self) -> None:
        # MSB = 0, MSW = 1/2 → rho = -1, held at 0: a design effect below 1 would overstate power
        effect = td.get_design_effect(([1, 0], [1, 0]))
        self.assertEqual((effect.anova, effect.size_weighted), (1.0, 1.0))


class RateHarm(unittest.TestCase):
    def test_fold_matches_the_two_proportion_reference_arithmetic(self) -> None:
        # Fleiss pooled-null, one-sided alpha 0.05, power 0.8, base 0.02 → 0.06 (3-fold):
        #   p̄ = 0.04; 1.644854 √(2·0.04·0.96) = 1.644854 x 0.277128 = 0.455835
        #   0.841621 √(0.0196 + 0.0564) = 0.841621 x 0.275681 = 0.232020
        #   (0.455835 + 0.232020)² / 0.04² = 295.715 per arm
        self.assertAlmostEqual(td.get_rate_harm(0.02, 295.715), 3.0, delta=1e-4)

    def test_fold_is_the_smallest_rise_the_fixed_sample_size_detects_at_that_sample(self) -> None:
        # pooled-null size is symmetric in the two rates → a rise from p0 to p0·f is the
        # reduction from p0·f by 1 - 1/f
        def get_size(base_rate: float, fold: float) -> int:
            return td.get_fixed_sample_size(base_rate * fold, relative_reduction=1 - 1 / fold)

        # 1e-9 row: answer rate ~0.44 → one ULP there exceeds 1e-10 x base, the scale a base-relative stop needs
        for base_rate, per_arm in ((1e-9, 10), (0.006, 400), (0.02, 166), (0.1, 395), (0.29, 222)):
            with self.subTest(base_rate=base_rate, per_arm=per_arm):
                fold = td.get_rate_harm(base_rate, per_arm)
                self.assertTrue(math.isfinite(fold))
                self.assertLessEqual(get_size(base_rate, fold * 1.001), per_arm)
                self.assertGreater(get_size(base_rate, fold * 0.999), per_arm)

    def test_a_larger_sample_detects_a_smaller_rise(self) -> None:
        folds = [td.get_rate_harm(0.03, per_arm) for per_arm in (100, 300, 1000)]
        self.assertGreater(folds[0], folds[1])
        self.assertGreater(folds[1], folds[2])

    def test_design_effect_shrinks_the_sample_the_rise_is_detected_at(self) -> None:
        self.assertAlmostEqual(td.get_rate_harm(0.05, 400, design_effect=2.0), td.get_rate_harm(0.05, 200), places=9)

    def test_no_rate_below_one_detectable_gives_an_infinite_fold(self) -> None:
        # base 0.5 → rate 1: (1.644854 √0.375 + 0.841621 √0.25)² / 0.25 = 8.16 per arm needed
        self.assertEqual(td.get_rate_harm(0.5, 8), math.inf)
        self.assertLess(td.get_rate_harm(0.5, 9), 2.0)


class ToolUseHarm(unittest.TestCase):
    def test_shift_matches_the_two_sample_mean_reference_arithmetic(self) -> None:
        # sd 20, 100 per arm → sd √(2/n) = 2.828427
        #   two-sided: (1.959964 + 0.841621) x 2.828427 = 7.924080
        #   upward:    (1.644854 + 0.841621) x 2.828427 = 7.032813
        rows = (
            ("overage-primary trial → upward only", True, 7.032813),
            ("any other trial → two-sided", False, 7.924080),
        )
        for name, is_overage_primary, expected in rows:
            with self.subTest(name):
                shift = td.get_tool_use_harm(20.0, 100, is_overage_primary=is_overage_primary)
                self.assertAlmostEqual(shift, expected, places=5)

    def test_upward_shift_is_the_two_sided_one_scaled_by_the_critical_sums(self) -> None:
        # plan 43378 → Guardrails: upward = two-sided x (1.645 + 0.842) / (1.960 + 0.842)
        for sd, per_arm in ((14.0, 166), (21.0, 395)):
            upward = td.get_tool_use_harm(sd, per_arm, is_overage_primary=True)
            two_sided = td.get_tool_use_harm(sd, per_arm, is_overage_primary=False)
            self.assertAlmostEqual(upward / two_sided, 0.887524, places=5, msg=f"sd {sd}, n {per_arm}")

    def test_design_effect_inflates_the_shift_by_its_square_root(self) -> None:
        base = td.get_tool_use_harm(18.0, 250, is_overage_primary=True)
        inflated = td.get_tool_use_harm(18.0, 250, is_overage_primary=True, design_effect=4.0)
        self.assertAlmostEqual(inflated, 2 * base)


class InvalidInputs(unittest.TestCase):
    def test_out_of_range_parameters_raise_instead_of_sizing(self) -> None:
        rows = (
            ("baseline rate of zero", lambda: td.get_fixed_sample_size(0.0)),
            ("baseline rate of one", lambda: td.get_fixed_sample_size(1.0)),
            ("relative reduction of one", lambda: td.get_fixed_sample_size(0.1, relative_reduction=1.0)),
            ("alpha of one half", lambda: td.get_boundaries(alpha=0.5)),
            ("power not above alpha", lambda: td.get_inflation_factor(alpha=0.05, power=0.05)),
            ("schedule not ending at full information", lambda: td.get_boundaries(look_fractions=(0.5, 0.9))),
            ("schedule not increasing", lambda: td.get_boundaries(look_fractions=(0.5, 0.5, 1.0))),
            ("design effect of zero", lambda: td.get_required_units(100, design_effect=0.0)),
            ("maximum sample of zero", lambda: td.is_powered(500, 0)),
            ("negative daily units", lambda: td.get_projected_units(-1.0)),
            ("a single cluster", lambda: td.get_design_effect(([1, 0, 1],))),
            ("an empty cluster", lambda: td.get_design_effect(([1, 0], []))),
            ("only singleton clusters", lambda: td.get_design_effect(([1], [0], [1]))),
            ("no variance in any cluster", lambda: td.get_design_effect(([0, 0], [0, 0, 0]))),
            ("harm at base rate zero", lambda: td.get_rate_harm(0.0, 300)),
            ("harm at a sample below one", lambda: td.get_rate_harm(0.1, 0.5)),
            ("harm at design effect zero", lambda: td.get_rate_harm(0.1, 300, design_effect=0.0)),
            ("tool_use harm at sd zero", lambda: td.get_tool_use_harm(0.0, 100, is_overage_primary=True)),
            ("tool_use harm at sample zero", lambda: td.get_tool_use_harm(20.0, 0, is_overage_primary=False)),
        )
        for name, call in rows:
            with self.subTest(name), self.assertRaises(ValueError):
                call()


if __name__ == "__main__":
    unittest.main()
