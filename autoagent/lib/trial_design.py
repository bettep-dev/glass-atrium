"""Group-sequential sizing and the power check for self-improvement trials.

Stdlib only, so the daemon imports it on an install's python3 3.9 floor with no
third-party dependency. Boundaries are Lan-DeMets O'Brien-Fleming-type, efficacy
only; crossing probabilities come from recursive numerical integration of the
score process (Armitage, McPherson & Rowe 1969), not from simulation.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from functools import cache
from statistics import NormalDist

DEFAULT_ALPHA = 0.05  # one-sided
DEFAULT_POWER = 0.8
DEFAULT_RELATIVE_REDUCTION = 0.30
LOOK_FRACTIONS = (0.25, 0.5, 0.75, 1.0)
HORIZON_DAYS = 84
ARM_COUNT = 2

_STANDARD_NORMAL = NormalDist()
_GRID_POINTS = 201  # odd → Simpson's rule
_TAIL_SDS = 10.0
_SEARCH_TOLERANCE = 1e-10
_BOUNDARY_SEARCH_MAX = 40.0

# (score-scale point, Simpson weight x sub-density) pairs of the continuation region
_Mass = list[tuple[float, float]]


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
    _check_alpha(alpha)
    _check_power(power, alpha)
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


def _get_fixed_size(baseline_rate: float, alpha: float, power: float, relative_reduction: float) -> float:
    """Fleiss pooled-null two-proportion size, no continuity correction."""
    if not 0 < baseline_rate < 1:
        raise ValueError(f"baseline_rate must be in (0, 1), got {baseline_rate}")
    if not 0 < relative_reduction < 1:
        raise ValueError(f"relative_reduction must be in (0, 1), got {relative_reduction}")
    _check_alpha(alpha)
    _check_power(power, alpha)
    treated_rate = baseline_rate * (1 - relative_reduction)
    pooled_rate = (baseline_rate + treated_rate) / 2
    null_term = _STANDARD_NORMAL.inv_cdf(1 - alpha) * math.sqrt(2 * pooled_rate * (1 - pooled_rate))
    alternative_term = _STANDARD_NORMAL.inv_cdf(power) * math.sqrt(
        baseline_rate * (1 - baseline_rate) + treated_rate * (1 - treated_rate)
    )
    return (null_term + alternative_term) ** 2 / (baseline_rate - treated_rate) ** 2


def _check_alpha(alpha: float) -> None:
    if not 0 < alpha < 0.5:
        raise ValueError(f"alpha must be a one-sided level in (0, 0.5), got {alpha}")


def _check_power(power: float, alpha: float) -> None:
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
