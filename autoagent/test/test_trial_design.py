"""Behavioral tests for the group-sequential trial-design module.

Covered behaviors:
  * Lan-DeMets O'Brien-Fleming-type boundaries match a published table;
  * the four-look maximum-sample inflation matches the plan's measured figure;
  * the fixed-sample two-proportion size matches a hand-derived reference;
  * the power check passes at and above twice the per-arm maximum times the
    design effect, and fails below it;
  * a smaller effect needs a larger sample; required units scale with the
    design effect;
  * the projection horizon stops at 84 days; invalid inputs raise.

Every expected value is derived outside this module (published table, plan
line, or hand arithmetic shown inline).

Run with either runner:
    uv run --with pytest pytest autoagent/test/test_trial_design.py -v
    python3 -m unittest autoagent.test.test_trial_design -v
"""

from __future__ import annotations

import math
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
        )
        for name, call in rows:
            with self.subTest(name), self.assertRaises(ValueError):
                call()


if __name__ == "__main__":
    unittest.main()
