"""Domains-overlap predicate — ONE owner, two call sites (M3 / R1GATE-04 / AC0b).

Responsibilities:
    Own the single set-intersection predicate `|A∩B| / min(|A|,|B|) >= THRESHOLD`
    that BOTH the R1-Q3 ADD gate (hypothetical proposed-agent input) and the §5
    orphan-scan domains-overlap lint (existing registry pairs) call. One function
    + one threshold constant means the gate and the lint cannot drift (AC4
    asserts this).

THRESHOLD is the codified 50% token-overlap bar. Live margin (BD-01): the 23
existing agents' max pairwise overlap is 0.091, ~5.5x below the bar — the fleet
passes cleanly today.
"""

from __future__ import annotations

from dataclasses import dataclass

# The single shared threshold constant. Both call sites import THIS — never a
# local copy (drift guard). >= comparison: exactly 50% overlap flags.
OVERLAP_THRESHOLD: float = 0.50


@dataclass(frozen=True)
class OverlapPair:
    """A flagged agent pair + its computed overlap ratio (ordered name pair)."""

    a: str
    b: str
    ratio: float


def overlap_ratio(domains_a: list[str], domains_b: list[str]) -> float:
    """Return |A∩B| / min(|A|,|B|) for two domains-token lists.

    A zero-length side yields 0.0 (an agent with no domains cannot over-overlap).
    Duplicate tokens within a list are collapsed (set semantics).
    """
    set_a = set(domains_a)
    set_b = set(domains_b)
    smaller = min(len(set_a), len(set_b))
    if smaller == 0:
        return 0.0
    return len(set_a & set_b) / smaller


def exceeds_threshold(domains_a: list[str], domains_b: list[str]) -> bool:
    """True when the pair's overlap ratio meets or exceeds OVERLAP_THRESHOLD.

    The single predicate both the Q3 gate and the orphan-scan call.
    """
    return overlap_ratio(domains_a, domains_b) >= OVERLAP_THRESHOLD


def scan_existing_pairs(domains_by_name: dict[str, list[str]]) -> list[OverlapPair]:
    """Call site (2): audit every existing registry pair for drift (orphan-scan).

    Returns the flagged pairs (ratio >= threshold), name-sorted within each pair
    and across the list for deterministic output.
    """
    names = sorted(domains_by_name)
    flagged: list[OverlapPair] = []
    for i, name_a in enumerate(names):
        for name_b in names[i + 1 :]:
            ratio = overlap_ratio(domains_by_name[name_a], domains_by_name[name_b])
            if ratio >= OVERLAP_THRESHOLD:
                flagged.append(OverlapPair(a=name_a, b=name_b, ratio=ratio))
    return flagged


def gate_proposed_domains(
    proposed_domains: list[str], existing_by_name: dict[str, list[str]]
) -> list[OverlapPair]:
    """Call site (1): R1-Q3 gate — proposed agent vs every existing entry (ADD).

    Returns the existing agents the proposed domains over-overlap (ratio >=
    threshold). A non-empty result HARD-BLOCKS the ADD. Uses the SAME
    overlap_ratio + OVERLAP_THRESHOLD as scan_existing_pairs — no divergence.
    """
    flagged: list[OverlapPair] = []
    for name in sorted(existing_by_name):
        ratio = overlap_ratio(proposed_domains, existing_by_name[name])
        if ratio >= OVERLAP_THRESHOLD:
            flagged.append(OverlapPair(a="<proposed>", b=name, ratio=ratio))
    return flagged
