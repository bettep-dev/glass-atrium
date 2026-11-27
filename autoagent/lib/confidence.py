"""Beta(1,1)-smoothed window rate and tunables for the post-apply regression watch.

Stdlib only, so daemon_cycle's watch keeps its smoothing when psycopg is absent.
"""

from __future__ import annotations

# Beta(1,1) prior — uniform prior to avoid cold-start NaN.
_PRIOR_ALPHA = 1
_PRIOR_BETA = 1

# Post-apply regression watch tunables (daemon detection-only next-cycle step).
# The watch compares pre/post-apply soft-negative window rates smoothed by this
# module's Beta(1,1) prior, so its tunables live beside the prior constants.
# Degradation predicate: post-window smoothed rate must exceed the pre-window
# rate by at least this delta.
POST_APPLY_REGRESSION_RATE_DELTA = 0.15
# Post-window observation floor — below 5 outcomes the Beta(1,1) posterior
# interval is too wide for a stable rate claim.
POST_APPLY_REGRESSION_MIN_POST_OBSERVATIONS = 5


def beta_smoothed_rate(negative_count: int, n: int) -> float:
    """Beta(1,1)-smoothed posterior mean of a window's negative rate.

    ``(α + negative_count) / (α + β + n)`` on this module's Beta(1,1) prior
    (single SoT: consumers reuse this helper instead of re-declaring the prior
    constants). An empty window (``n == 0``) degrades to the Beta(1,1) mean 0.5
    instead of 0-division.

    Args:
        negative_count: window rows counted as negative (soft-negative hits).
        n: window size (total rows).

    Returns:
        float — smoothed rate ∈ (0.0, 1.0). Always valid (denominator ≥ 2).
    """
    return (_PRIOR_ALPHA + negative_count) / (_PRIOR_ALPHA + _PRIOR_BETA + n)
