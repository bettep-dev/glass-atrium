"""Beta-Binomial empirical confidence posterior for the self-improvement loop.

Promotion-ladder confidence weight = Beta-Binomial conjugate posterior mean.
Writer self-report ``confidence`` enum is deliberately excluded from the input
(empirically ~96% "high" — severely inflated); only the empirical signal tuple
is used, to block false certainty.

Confidence model:
  - posterior mean = ``α / (α + β)``
  - α = 1 + success_count (Beta(1,1) prior + empirical successes)
  - β = 1 + failure_count (Beta(1,1) prior + empirical failures)
  - cold-start (0 outcomes) → Beta(1,1) mean = 0.5 (avoids NaN/0-division)

Empirical signal derivation (writer self-report rejected):
  - success = ``revision_count == 0 ∧ result == 'done'`` → increments α
  - failure = ``revision_count >= 2 ∨ result == 'fail'`` → increments β
  - neutral = otherwise (``done_with_concerns`` / ``blocked`` / ``needs_context`` /
    ``revision_count == 1``) → no count change
  - ``evaluative_signal`` (-1/0/+1) is an auxiliary weight, currently inactive —
    accepted as part of the input tuple but not yet folded into the posterior.

Temporal decay (exponential count-forgetting — older outcomes contribute less):
  - ``α_t = 1 + Σ λ^Δd · success_i`` / ``β_t = 1 + Σ λ^Δd · failure_i``
    (Δd = now − record_ts in days · per-day decay rate ``λ∈(0,1)``).
  - ``λ=1`` → all weights 1.0 → identical to the undecayed integer-count posterior
    (legacy-degrade contract). default ``λ=1.0`` → existing callers unchanged.
  - outcome without ``record_ts`` → weight 1.0 (legacy, backward-compatible).
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

# Import project_key as a sibling module when lib/ is not on sys.path.
_LIB_ROOT = Path(__file__).resolve().parent
if str(_LIB_ROOT) not in sys.path:
    sys.path.insert(0, str(_LIB_ROOT))

from project_key import learning_dir  # noqa: E402

# Beta(1,1) prior — uniform prior to avoid cold-start NaN.
_PRIOR_ALPHA = 1
_PRIOR_BETA = 1

# Empirical failure threshold — revision_count >= this counts as failure.
_FAILURE_REVISION_THRESHOLD = 2

# Post-apply regression watch tunables (daemon detection-only next-cycle step).
# The watch compares pre/post-apply soft-negative window rates smoothed by this
# module's Beta(1,1) prior, so its tunables live beside the prior constants.
# Degradation predicate: post-window smoothed rate must exceed the pre-window
# rate by at least this delta.
POST_APPLY_REGRESSION_RATE_DELTA = 0.15
# Post-window observation floor — below 5 outcomes the Beta(1,1) posterior
# interval is too wide for a stable rate claim.
POST_APPLY_REGRESSION_MIN_POST_OBSERVATIONS = 5

# Default per-day decay rate. 1.0 = no decay → callers get the legacy posterior
# unchanged. Active decay only via an explicit λ<1 at call time.
# λ semantics: per-day outcome weight = λ^Δd. Recommended operational value ~0.97
# (~23-day half-life — a month-old signal carries ~0.5 weight).
_DEFAULT_DECAY_LAMBDA = 1.0

# Floor guarding against negative age (future record_ts) — clamps to 0 days.
_MIN_AGE_DAYS = 0.0

# Seconds per day — Δd(days) = (now − record_ts).total_seconds() / this.
_SECONDS_PER_DAY = 86400.0

# Classification label — Beta α/β increment or no change.
OutcomeClass = Literal["success", "failure", "neutral"]


@dataclass(frozen=True)
class OutcomeSignal:
    """Empirical signal tuple — writer self-report excluded.

    - Absence of a ``confidence`` enum field is itself the self-report-distrust guard.
    - All three core fields are observed facts from the outcome record, not self-assessment.
    - ``record_ts`` is optional decay input — None → legacy weight 1.0. Trailing
      default field so existing 3-arg construction stays unchanged.
    """

    revision_count: int                  # user rework-request count (0 = done first try)
    result: str                          # done / done_with_concerns / blocked / needs_context / fail
    evaluative_signal: int               # -1 / 0 / +1 — auxiliary weight (currently inactive)
    record_ts: datetime | None = None    # outcome record time (decay input · None → legacy)


def classify_outcome(signal: OutcomeSignal) -> OutcomeClass:
    """Classify the empirical signal tuple as success/failure/neutral.

    - success: ``revision_count == 0 ∧ result == 'done'``
    - failure: ``revision_count >= 2 ∨ result == 'fail'`` (rework accumulation OR failure)
    - neutral: otherwise — done_with_concerns / blocked / needs_context / revision_count == 1
    - failure takes precedence — revision_count >= 2 with result == done is still failure
      (reflects rework cost; the OR condition).

    Args:
        signal: observed empirical signal tuple.

    Returns:
        OutcomeClass — Beta α increment (success) / β increment (failure) / no change (neutral).
    """
    # Evaluate failure first — the OR condition guards before success.
    if signal.revision_count >= _FAILURE_REVISION_THRESHOLD or signal.result == "fail":
        return "failure"

    if signal.revision_count == 0 and signal.result == "done":
        return "success"

    # done_with_concerns / blocked / needs_context / revision_count == 1, etc.
    return "neutral"


def _decay_weight(
    signal: OutcomeSignal,
    *,
    lambda_per_day: float,
    now: datetime,
) -> float:
    """Compute a single outcome's temporal-decay weight ``λ^Δd``.

    - ``record_ts`` absent → 1.0 (legacy, no decay, backward-compatible).
    - ``λ == 1.0`` → 1.0 (no decay → exactly matches legacy integer count).
    - Δd = (now − record_ts) in days; negative (future timestamp) clamped to 0.
    - naive ``record_ts`` borrows now's tzinfo for comparison (PG returns tz-aware).

    Args:
        signal: outcome to weight.
        lambda_per_day: per-day decay rate ∈ (0,1]. 1.0 = no decay.
        now: reference current time (decay-age basis).

    Returns:
        float — decay weight (0.0, 1.0].
    """
    record_ts = signal.record_ts
    if record_ts is None or lambda_per_day == 1.0:
        # No timestamp OR decay disabled → legacy weight (integer-count equivalent).
        return 1.0

    # naive record_ts borrows now's tz (avoids mixed aware/naive subtraction TypeError).
    if record_ts.tzinfo is None and now.tzinfo is not None:
        record_ts = record_ts.replace(tzinfo=now.tzinfo)

    age_days = (now - record_ts).total_seconds() / _SECONDS_PER_DAY
    if age_days < _MIN_AGE_DAYS:
        # Future timestamp → clamp age to 0 days (prevents decay amplification).
        age_days = _MIN_AGE_DAYS
    return lambda_per_day ** age_days


def compute_confidence_observed(
    outcomes: list[OutcomeSignal],
    *,
    lambda_per_day: float = _DEFAULT_DECAY_LAMBDA,
    now: datetime | None = None,
) -> float:
    """Pattern outcome history → Beta-Binomial posterior mean (with temporal decay).

    - posterior mean = ``α / (α + β)`` where α=1+Σweight·success, β=1+Σweight·failure.
    - cold-start (empty list) → Beta(1,1) mean = 0.5 (avoids NaN).
    - neutral outcomes increment neither α nor β → posterior stays neutral.
    - writer self-report ``confidence`` is not in the input (empirical only).
    - temporal decay: ``α_t = 1 + Σ λ^Δd·success_i``, ``β_t = 1 + Σ λ^Δd·failure_i``.
        * ``λ=1.0`` (default) → all weights 1.0 → exactly the integer-count posterior
          (legacy-degrade contract — deterministic, no float error).
        * outcome without ``record_ts`` → weight 1.0 (legacy, backward-compatible).
        * ``λ<1`` → older outcomes' α/β contributions decay exponentially (recent-first).

    Args:
        outcomes: OutcomeSignal history for one pattern (agent × task_type).
        lambda_per_day: per-day decay rate ∈ (0,1]. default 1.0 = no decay (legacy).
        now: decay-age reference time (None → ``datetime.now(timezone.utc)``);
            injectable for test determinism.

    Returns:
        float — posterior mean ∈ (0.0, 1.0). Always valid (denominator ≥ 2 guaranteed).
    """
    if now is None:
        now = datetime.now(timezone.utc)

    success_weight = 0.0
    failure_weight = 0.0
    for signal in outcomes:
        outcome_class = classify_outcome(signal)
        if outcome_class == "success":
            success_weight += _decay_weight(signal, lambda_per_day=lambda_per_day, now=now)
        elif outcome_class == "failure":
            failure_weight += _decay_weight(signal, lambda_per_day=lambda_per_day, now=now)
        # neutral → no count change

    alpha = _PRIOR_ALPHA + success_weight
    beta = _PRIOR_BETA + failure_weight
    # Denominator is always ≥ 2 thanks to the prior → no 0-division.
    return alpha / (alpha + beta)


def beta_smoothed_rate(negative_count: int, n: int) -> float:
    """Beta(1,1)-smoothed posterior mean of a window's negative rate.

    ``(α + negative_count) / (α + β + n)`` on this module's shared Beta(1,1)
    prior — the same prior compute_confidence_observed builds its posterior on
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


def confidence_dir(project_key: str) -> Path:
    """Per-project confidence-signal storage directory (delegates to learning_dir).

    - Used as the per-project posterior cache location at daemon wire-in.
    - Path policy (``~/.glass-atrium/data/learning/<key>/`` inside the vault) is owned by learning_dir.

    Args:
        project_key: resolve_project_key().key (12 hex).

    Returns:
        Created directory Path (learning_dir does an idempotent mkdir).
    """
    return learning_dir(project_key)


if __name__ == "__main__":  # pragma: no cover
    # Diagnostic direct run — posterior for synthetic [3 success, 1 failure] input.
    sample = [
        OutcomeSignal(revision_count=0, result="done", evaluative_signal=1),
        OutcomeSignal(revision_count=0, result="done", evaluative_signal=0),
        OutcomeSignal(revision_count=0, result="done", evaluative_signal=1),
        OutcomeSignal(revision_count=3, result="fail", evaluative_signal=-1),
    ]
    posterior = compute_confidence_observed(sample)
    print(f"posterior(3 success, 1 failure) = {posterior:.4f}  (expect ~0.6667)")
