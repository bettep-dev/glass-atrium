"""Group-sequential sizing, the power check, design effects and guardrail harm for self-improvement trials.

Stdlib only, so the daemon imports it on an install's python3 3.9 floor with no
third-party dependency. Boundaries are Lan-DeMets O'Brien-Fleming-type, efficacy
only; crossing probabilities come from recursive numerical integration of the
score process (Armitage, McPherson & Rowe 1969), not from simulation.
"""

from __future__ import annotations

import contextlib
import math
import random
import statistics
from collections.abc import Sequence
from functools import cache
from statistics import NormalDist
from typing import NamedTuple

DEFAULT_ALPHA = 0.05  # one-sided
DEFAULT_POWER = 0.8
DEFAULT_RELATIVE_REDUCTION = 0.30
LOOK_FRACTIONS = (0.25, 0.5, 0.75, 1.0)
HORIZON_DAYS = 84
ARM_COUNT = 2
BOOTSTRAP_REPLICATES = 2000
# one-sided 95% bounds = a two-sided 90% interval, matching the trials' one-sided alpha
INTERVAL_CUTS = 20  # statistics.quantiles cut points at 5% steps → the first and last are the bounds

_STANDARD_NORMAL = NormalDist()
_GRID_POINTS = 201  # odd → Simpson's rule
_TAIL_SDS = 10.0
_SEARCH_TOLERANCE = 1e-10
_BOUNDARY_SEARCH_MAX = 40.0

# (score-scale point, Simpson weight x sub-density) pairs of the continuation region
_Mass = list[tuple[float, float]]


class DesignEffect(NamedTuple):
    """Both design-effect estimators over one set of clusters; they share the ANOVA intraclass correlation."""

    anova: float  # cluster size = the ANOVA-adjusted size n0
    size_weighted: float  # cluster size = the size-weighted mean, sum(m^2) / N

    @property
    def selected(self) -> float:
        """The higher estimator: a lower design effect overstates a trial's power."""
        return max(self.anova, self.size_weighted)


class ArmDesignEffect(NamedTuple):
    """One arm-difference design effect with the precision recorded beside it."""

    value: float
    sessions: int
    spawns: int
    lower: float | None  # None = fewer than 2 defined resamples
    upper: float | None
    replicates: int  # defined resamples; an undefined one (an arm empty, no variance) is dropped


class _ArmTotals(NamedTuple):
    """One session's per-arm sufficient statistics, indexed by arm (0 control, 1 treatment)."""

    counts: tuple[int, int]
    sums: tuple[float, float]
    squares: tuple[float, float]


def get_fixed_sample_size(
    baseline_rate: float,
    *,
    alpha: float = DEFAULT_ALPHA,
    power: float = DEFAULT_POWER,
    relative_reduction: float = DEFAULT_RELATIVE_REDUCTION,
) -> int:
    """Per-arm size of a one-look trial detecting ``relative_reduction`` of ``baseline_rate``."""
    return math.ceil(_get_fixed_size(baseline_rate, alpha, power, relative_reduction))


def get_maximum_sample_size(
    baseline_rate: float,
    *,
    alpha: float = DEFAULT_ALPHA,
    power: float = DEFAULT_POWER,
    relative_reduction: float = DEFAULT_RELATIVE_REDUCTION,
    look_fractions: Sequence[float] = LOOK_FRACTIONS,
) -> int:
    """Per-arm maximum of the group-sequential trial: the fixed size times the look inflation."""
    fixed = _get_fixed_size(baseline_rate, alpha, power, relative_reduction)
    inflation = get_inflation_factor(alpha=alpha, power=power, look_fractions=look_fractions)
    return math.ceil(fixed * inflation)


def get_boundaries(
    *, alpha: float = DEFAULT_ALPHA, look_fractions: Sequence[float] = LOOK_FRACTIONS
) -> tuple[float, ...]:
    """Upper z boundary per look, spending one-sided ``alpha`` at the given information fractions."""
    _check_alpha(alpha)
    return _get_boundaries(alpha, _get_checked_fractions(look_fractions))


def get_inflation_factor(
    *,
    alpha: float = DEFAULT_ALPHA,
    power: float = DEFAULT_POWER,
    look_fractions: Sequence[float] = LOOK_FRACTIONS,
) -> float:
    """Maximum information of the look schedule over a fixed design's, at equal alpha and power."""
    _check_levels(alpha, power)
    return _get_inflation_factor(alpha, power, _get_checked_fractions(look_fractions))


def get_required_units(maximum_sample_size: float, *, design_effect: float = 1.0) -> float:
    """Units both arms need within the horizon, inflated by the design effect."""
    _check_positive("maximum_sample_size", maximum_sample_size)
    _check_positive("design_effect", design_effect)
    return ARM_COUNT * maximum_sample_size * design_effect


def is_powered(projected_units: float, maximum_sample_size: float, *, design_effect: float = 1.0) -> bool:
    """Power-check verdict: the projected units reach the required units."""
    return projected_units >= get_required_units(maximum_sample_size, design_effect=design_effect)


def get_projected_units(daily_units: float, *, horizon_days: float = HORIZON_DAYS) -> float:
    """Units a daily rate yields within a horizon of at most ``HORIZON_DAYS``."""
    if daily_units < 0:
        raise ValueError(f"daily_units must be >= 0, got {daily_units}")
    if not 0 < horizon_days <= HORIZON_DAYS:
        raise ValueError(f"horizon_days must be in (0, {HORIZON_DAYS}], got {horizon_days}")
    return daily_units * horizon_days


def get_design_effect(clusters: Sequence[Sequence[float]]) -> DesignEffect:
    """Design effect of clustering from per-cluster observations (0/1 for a rate metric).

    One-way ANOVA intraclass correlation, held at 0 when negative so neither estimator falls below 1.
    Only singleton clusters give exactly 1 for both: each cluster size is 1, so the correlation never enters.
    Otherwise raises ValueError when the correlation is undefined: fewer than 2 clusters, an empty
    cluster, or no variance at all.
    """
    sizes = [len(cluster) for cluster in clusters]
    if len(sizes) < 2 or min(sizes) == 0:
        raise ValueError(f"need at least 2 non-empty clusters, got sizes {sizes}")
    total = sum(sizes)
    if total == len(sizes):
        return DesignEffect(anova=1.0, size_weighted=1.0)
    between, within = _get_mean_squares(clusters, sizes)
    weighted_size = math.fsum(size * size for size in sizes) / total
    anova_size = (total - weighted_size) / (len(sizes) - 1)
    denominator = between + (anova_size - 1) * within
    if denominator <= 0:
        raise ValueError("no variance in any cluster: intraclass correlation undefined")
    correlation = max(0.0, (between - within) / denominator)
    return DesignEffect(
        anova=1 + (anova_size - 1) * correlation,
        size_weighted=1 + (weighted_size - 1) * correlation,
    )


def get_arm_difference_design_effect(clusters: Sequence[Sequence[tuple[int, float]]]) -> float:
    """Design effect of the treatment-minus-control rate: session-clustered over independent-spawn variance.

    Clusters hold (arm, outcome) per spawn, arm 0 control / 1 treatment. The ratio is the
    cluster-robust sandwich variance of the arm difference over its independent form, so per-spawn
    arms give about 1 whatever the session effects; it may fall below 1 by noise. Raises ValueError
    when undefined: fewer than 2 clusters, an empty cluster, an empty arm, or no variance in either arm.
    """
    return _get_arm_ratio(_get_arm_totals(clusters))


def get_arm_design_effect_reading(
    clusters: Sequence[Sequence[tuple[int, float]]],
    *,
    seed: str,
    replicates: int = BOOTSTRAP_REPLICATES,
) -> ArmDesignEffect:
    """The arm-difference design effect with session count, spawn count and a session-bootstrap interval.

    Sessions are resampled with replacement under a ``seed``-fixed generator, so one input gives one
    reading. Raises ValueError where get_arm_difference_design_effect does.
    """
    totals = _get_arm_totals(clusters)
    value = _get_arm_ratio(totals)
    generator = random.Random(seed)
    draws: list[float] = []
    for _ in range(replicates):
        with contextlib.suppress(ValueError):  # a resample without one arm or variance has no value
            draws.append(_get_arm_ratio(generator.choices(totals, k=len(totals))))
    lower, upper = _get_interval(draws)
    spawns = sum(sum(total.counts) for total in totals)
    return ArmDesignEffect(value, len(totals), spawns, lower, upper, len(draws))


def _get_arm_totals(clusters: Sequence[Sequence[tuple[int, float]]]) -> list[_ArmTotals]:
    sizes = [len(cluster) for cluster in clusters]
    if len(sizes) < 2 or min(sizes) == 0:
        raise ValueError(f"need at least 2 non-empty clusters, got sizes {sizes}")
    totals: list[_ArmTotals] = []
    for cluster in clusters:
        counts, sums, squares = [0, 0], [0.0, 0.0], [0.0, 0.0]
        for arm, outcome in cluster:
            if arm not in (0, 1):
                raise ValueError(f"arm must be 0 or 1, got {arm!r}")
            counts[arm] += 1
            sums[arm] += outcome
            squares[arm] += outcome * outcome
        totals.append(_ArmTotals((counts[0], counts[1]), (sums[0], sums[1]), (squares[0], squares[1])))
    return totals


def _get_arm_ratio(totals: Sequence[_ArmTotals]) -> float:
    """Σ over sessions of (Σ z)² over Σ z², z = (outcome − arm mean) / arm size, signed + on treatment."""
    sizes = [sum(total.counts[arm] for total in totals) for arm in (0, 1)]
    if min(sizes) == 0:
        raise ValueError(f"an arm has no spawns, sizes {sizes}: arm difference undefined")
    means = [math.fsum(total.sums[arm] for total in totals) / sizes[arm] for arm in (0, 1)]
    clustered = math.fsum(
        (
            (total.sums[1] - total.counts[1] * means[1]) / sizes[1]
            - (total.sums[0] - total.counts[0] * means[0]) / sizes[0]
        )
        ** 2
        for total in totals
    )
    independent = math.fsum(
        (total.squares[arm] - 2 * means[arm] * total.sums[arm] + total.counts[arm] * means[arm] ** 2)
        / sizes[arm] ** 2
        for total in totals
        for arm in (0, 1)
    )
    if independent <= 0:
        raise ValueError("no variance in either arm: arm-difference design effect undefined")
    return clustered / independent


def _get_interval(draws: list[float]) -> tuple[float | None, float | None]:
    if len(draws) < 2:
        return None, None
    cuts = statistics.quantiles(draws, n=INTERVAL_CUTS, method="inclusive")
    return cuts[0], cuts[-1]


def get_rate_harm(
    base_rate: float,
    per_arm: float,
    *,
    alpha: float = DEFAULT_ALPHA,
    power: float = DEFAULT_POWER,
    design_effect: float = 1.0,
) -> float:
    """Minimum detectable fold rise of a rate guardrail (emit failure, verified_fail, re-delegation).

    One-sided two-proportion test at the per-arm sample over the design effect; ``math.inf`` when
    no rate below 1 is detectable at that sample.
    """
    _check_rate("base_rate", base_rate)
    effective = _get_effective_sample(per_arm, design_effect)
    _check_levels(alpha, power)
    if _get_two_proportion_size(base_rate, 1.0, alpha, power) > effective:
        return math.inf
    lower, upper = base_rate, 1.0
    # tolerance relative to the bracket, not base_rate → stays above one ULP of the answer at any base scale
    while upper - lower > _SEARCH_TOLERANCE * lower:
        middle = (lower + upper) / 2
        size = _get_two_proportion_size(base_rate, middle, alpha, power)
        lower, upper = (middle, upper) if size > effective else (lower, middle)
    return (lower + upper) / 2 / base_rate


def get_tool_use_harm(
    sd: float,
    per_arm: float,
    *,
    is_overage_primary: bool,
    alpha: float = DEFAULT_ALPHA,
    power: float = DEFAULT_POWER,
    design_effect: float = 1.0,
) -> float:
    """Minimum detectable tool_use mean shift, in tool uses, of a two-sample normal comparison.

    Upward only (one-sided ``alpha``) on an overage-primary trial, where fewer tool uses is a real
    win's route; two-sided otherwise.
    """
    _check_positive("sd", sd)
    effective = _get_effective_sample(per_arm, design_effect)
    _check_levels(alpha, power)
    tail = alpha if is_overage_primary else alpha / 2
    critical_sum = _STANDARD_NORMAL.inv_cdf(1 - tail) + _STANDARD_NORMAL.inv_cdf(power)
    return critical_sum * sd * math.sqrt(2 / effective)


def _get_mean_squares(clusters: Sequence[Sequence[float]], sizes: list[int]) -> tuple[float, float]:
    """One-way ANOVA (between-cluster, within-cluster) mean squares."""
    total = sum(sizes)
    means = [math.fsum(cluster) / size for cluster, size in zip(clusters, sizes)]
    grand_mean = math.fsum(math.fsum(cluster) for cluster in clusters) / total
    between = math.fsum(size * (mean - grand_mean) ** 2 for size, mean in zip(sizes, means))
    within = math.fsum((value - mean) ** 2 for cluster, mean in zip(clusters, means) for value in cluster)
    return between / (len(sizes) - 1), within / (total - len(sizes))


def _get_fixed_size(baseline_rate: float, alpha: float, power: float, relative_reduction: float) -> float:
    _check_rate("baseline_rate", baseline_rate)
    if not 0 < relative_reduction < 1:
        raise ValueError(f"relative_reduction must be in (0, 1), got {relative_reduction}")
    _check_levels(alpha, power)
    return _get_two_proportion_size(baseline_rate, baseline_rate * (1 - relative_reduction), alpha, power)


def _get_two_proportion_size(rate: float, other_rate: float, alpha: float, power: float) -> float:
    """Fleiss pooled-null two-proportion per-arm size, one-sided, no continuity correction."""
    pooled_rate = (rate + other_rate) / 2
    null_term = _STANDARD_NORMAL.inv_cdf(1 - alpha) * math.sqrt(2 * pooled_rate * (1 - pooled_rate))
    alternative_term = _STANDARD_NORMAL.inv_cdf(power) * math.sqrt(rate * (1 - rate) + other_rate * (1 - other_rate))
    return (null_term + alternative_term) ** 2 / (rate - other_rate) ** 2


def _get_effective_sample(per_arm: float, design_effect: float) -> float:
    if not per_arm >= 1:
        raise ValueError(f"per_arm must be >= 1, got {per_arm}")
    _check_positive("design_effect", design_effect)
    return per_arm / design_effect


def _check_rate(name: str, rate: float) -> None:
    if not 0 < rate < 1:
        raise ValueError(f"{name} must be in (0, 1), got {rate}")


def _check_alpha(alpha: float) -> None:
    if not 0 < alpha < 0.5:
        raise ValueError(f"alpha must be a one-sided level in (0, 0.5), got {alpha}")


def _check_levels(alpha: float, power: float) -> None:
    _check_alpha(alpha)
    if not alpha < power < 1:
        raise ValueError(f"power must be in (alpha, 1), got {power} at alpha {alpha}")


def _check_positive(name: str, value: float) -> None:
    if not value > 0:
        raise ValueError(f"{name} must be > 0, got {value}")


def _get_checked_fractions(look_fractions: Sequence[float]) -> tuple[float, ...]:
    fractions = tuple(float(fraction) for fraction in look_fractions)
    if not fractions or fractions[-1] != 1.0:
        raise ValueError(f"look_fractions must end at full information 1.0, got {fractions}")
    if fractions[0] <= 0 or any(later <= earlier for earlier, later in zip(fractions, fractions[1:])):
        raise ValueError(f"look_fractions must be strictly increasing above 0, got {fractions}")
    return fractions


def _get_spent_alpha(alpha: float, fraction: float) -> float:
    """O'Brien-Fleming-type spending: 2(1 - Φ(z_{1-alpha/2} / √t))."""
    return math.erfc(_STANDARD_NORMAL.inv_cdf(1 - alpha / 2) / math.sqrt(2 * fraction))


@cache
def _get_boundaries(alpha: float, fractions: tuple[float, ...]) -> tuple[float, ...]:
    boundaries: list[float] = []
    mass: _Mass = []
    spent_before = 0.0
    for index, fraction in enumerate(fractions):
        previous_fraction = fractions[index - 1] if index else 0.0
        spent = _get_spent_alpha(alpha, fraction)
        increment = spent - spent_before
        spent_before = spent
        if index == 0:
            boundary = -_STANDARD_NORMAL.inv_cdf(increment)  # 1 - tiny spend rounds to 1.0
        else:
            boundary = _find_boundary(mass, fraction - previous_fraction, fraction, increment)
        boundaries.append(boundary)
        mass = _get_continuation_mass(mass, 0.0, previous_fraction, fraction, boundary)
    return tuple(boundaries)


def _find_boundary(mass: _Mass, step: float, fraction: float, increment: float) -> float:
    """Bisection on the z boundary whose null crossing probability equals ``increment``."""
    lower, upper = 0.0, _BOUNDARY_SEARCH_MAX
    while upper - lower > _SEARCH_TOLERANCE:
        middle = (lower + upper) / 2
        crossing = _get_crossing(mass, 0.0, step, middle * math.sqrt(fraction))
        lower, upper = (middle, upper) if crossing > increment else (lower, middle)
    return (lower + upper) / 2


@cache
def _get_inflation_factor(alpha: float, power: float, fractions: tuple[float, ...]) -> float:
    boundaries = _get_boundaries(alpha, fractions)
    fixed_drift = _STANDARD_NORMAL.inv_cdf(1 - alpha) + _STANDARD_NORMAL.inv_cdf(power)
    lower, upper = fixed_drift, 2 * fixed_drift
    while upper - lower > _SEARCH_TOLERANCE * fixed_drift:
        middle = (lower + upper) / 2
        reached = _get_power(middle, boundaries, fractions)
        lower, upper = (middle, upper) if reached < power else (lower, middle)
    return ((lower + upper) / 2 / fixed_drift) ** 2


def _get_power(drift: float, boundaries: tuple[float, ...], fractions: tuple[float, ...]) -> float:
    """Probability of crossing any look's boundary when the z drift at full information is ``drift``."""
    total = 0.0
    mass: _Mass = []
    previous_fraction = 0.0
    for boundary, fraction in zip(boundaries, fractions):
        boundary_score = boundary * math.sqrt(fraction)
        if previous_fraction == 0.0:
            total += _get_upper_tail((boundary_score - drift * fraction) / math.sqrt(fraction))
        else:
            total += _get_crossing(mass, drift, fraction - previous_fraction, boundary_score)
        mass = _get_continuation_mass(mass, drift, previous_fraction, fraction, boundary)
        previous_fraction = fraction
    return total


def _get_crossing(mass: _Mass, drift: float, step: float, boundary_score: float) -> float:
    """Probability of continuing to the previous look, then crossing ``boundary_score`` at this one."""
    deviation = math.sqrt(step)
    shift = drift * step
    return sum(weight * _get_upper_tail((boundary_score - point - shift) / deviation) for point, weight in mass)


def _get_continuation_mass(
    mass: _Mass, drift: float, previous_fraction: float, fraction: float, boundary: float
) -> _Mass:
    """Weighted sub-density of the score at ``fraction`` on paths not yet stopped."""
    mean = drift * fraction
    lower = mean - _TAIL_SDS * math.sqrt(fraction)
    upper = boundary * math.sqrt(fraction)
    if upper <= lower:
        return []
    step = fraction - previous_fraction
    deviation = math.sqrt(step)
    shift = drift * step
    scale = -0.5 / step
    norm = 1 / (deviation * math.sqrt(2 * math.pi))
    result: _Mass = []
    for point, weight in _get_simpson_grid(lower, upper):
        if previous_fraction == 0.0:
            density = norm * math.exp(scale * (point - mean) ** 2)
        else:
            density = norm * sum(w * math.exp(scale * (point - x - shift) ** 2) for x, w in mass)
        result.append((point, weight * density))
    return result


def _get_simpson_grid(lower: float, upper: float) -> list[tuple[float, float]]:
    spacing = (upper - lower) / (_GRID_POINTS - 1)
    last = _GRID_POINTS - 1
    return [
        (lower + index * spacing, spacing / 3 * (1 if index in (0, last) else 4 if index % 2 else 2))
        for index in range(_GRID_POINTS)
    ]


def _get_upper_tail(z: float) -> float:
    return 0.5 * math.erfc(z / math.sqrt(2))
