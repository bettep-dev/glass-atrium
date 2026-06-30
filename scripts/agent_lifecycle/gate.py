"""R1 new-agent creation gate — split into a deterministic arm + an attestation arm.

Responsibilities:
    Enforce the R1 fleet-growth gate the way the plan frames it (§3.3 / AC0a /
    AC0b): a SPLIT, not a single mechanical gate. Q3 (fleet-size cost) is the
    ONLY arm the CLI computes itself — domains set-intersection against every
    existing entry, hard-blocking on >= 50% overlap. Q1 (concern-novelty) and
    Q2 (extend-test) are semantic judgments the CLI CANNOT compute: it gates on
    an externally supplied verdict only (pass/fail via the --gate-q1/--gate-q2
    flags) and NEVER decides them. An absent verdict refuses (no default-pass); any 'fail'
    halts with zero writes.

The gate returns a verdict object; the ADD handler runs no store write until
`GateVerdict.allowed` is True. This module performs no I/O on the agent stores —
the Q3 input (existing domains) is read by the caller and passed in, keeping the
gate a pure function over its inputs (testable without a live tree).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .overlap import OverlapPair, gate_proposed_domains


@dataclass(frozen=True)
class GateVerdict:
    """Outcome of the R1 gate for one proposed agent.

    `allowed` is True only when Q3 passed AND both attestation verdicts are
    'pass'. `q3_conflicts` carries the existing agents the proposal over-
    overlapped (non-empty => Q3 hard-block). `reasons` lists every failed arm
    in human-readable form for the HALT message.
    """

    allowed: bool
    q3_conflicts: list[OverlapPair] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)


# Accepted attestation verdict tokens. The CLI gates on these; it does not
# compute their truth value (honor-system handshake, like the orchestrator's
# in-script verify-stage).
_PASS = "pass"
_FAIL = "fail"
_VALID_VERDICTS = frozenset({_PASS, _FAIL})


def evaluate_gate(
    *,
    proposed_domains: list[str],
    existing_by_name: dict[str, list[str]],
    q1_verdict: str | None,
    q2_verdict: str | None,
) -> GateVerdict:
    """Evaluate the R1 split gate for a proposed agent.

    Args:
        proposed_domains: the new agent's domains tokens (Q3 input).
        existing_by_name: every existing agent's domains (Q3 comparison set).
        q1_verdict: externally supplied 'pass'/'fail' for concern-novelty, or
            None when no verdict was provided (-> refuse, never default-pass).
        q2_verdict: externally supplied 'pass'/'fail' for the extend-test, or
            None (-> refuse).

    Returns:
        A GateVerdict. `allowed` is True only when Q3 passes (no >= 50% overlap
        pair) AND both attestation verdicts are exactly 'pass'.
    """
    reasons: list[str] = []

    # Arm 1 — Q1/Q2 attestation handshake. Absent => refuse (no default-pass).
    # An invalid token is treated as a refusal, not a silent pass.
    for label, verdict in (
        ("Q1 (concern-novelty)", q1_verdict),
        ("Q2 (extend-test)", q2_verdict),
    ):
        if verdict is None:
            reasons.append(
                f"{label}: no attestation verdict supplied — the CLI does not "
                f"judge this arm and refuses to default-pass"
            )
        elif verdict not in _VALID_VERDICTS:
            reasons.append(
                f"{label}: invalid verdict {verdict!r} (expected 'pass'/'fail')"
            )
        elif verdict == _FAIL:
            reasons.append(
                f"{label}: attestation verdict is 'fail' — HALT new creation; "
                f"consider an ADDITIVE extend of a near agent instead"
            )

    # Arm 2 — Q3 fleet-size cost. The ONLY arm the CLI computes (deterministic,
    # same predicate + threshold as the orphan-scan, via overlap.py).
    q3_conflicts = gate_proposed_domains(proposed_domains, existing_by_name)
    if q3_conflicts:
        joined = ", ".join(
            f"{pair.b} (overlap {pair.ratio:.2f})" for pair in q3_conflicts
        )
        reasons.append(
            f"Q3 (fleet-size cost): proposed domains over-overlap existing "
            f"agent(s) at >= 50% — {joined}; routing-degradation hard-block"
        )

    return GateVerdict(
        allowed=not reasons,
        q3_conflicts=q3_conflicts,
        reasons=reasons,
    )
