"""READ helpers for the GA stores the CLI reasons over (registry / roster / inject).

Responsibilities:
    Load the registry agents dict, parse the scope-dev.md Tier-2 brace-list DEV
    roster (anchored regex over prose, NOT a clean array — dev-note 1), and
    parse the four inject-scope-rules.sh bash arrays (INJECT_AGENTS = DEV+QA,
    STYLEREF_AGENTS = DEV, MINIMALISM_AGENTS = DEV, NAMING_AGENTS = DEV −
    {dev-swift} + qa-code-reviewer — B4). All are READ-ONLY; no helper mutates
    a store.

The brace-list and bash-array parsers are anchored + round-trip-checkable so a
later-wave editor can re-parse after an insert to confirm the edit is coherent.
"""

from __future__ import annotations

import re

from .atomic import load_json
from .paths import StorePaths

# scope-dev.md Tier-2 loading stanza — the DEV roster SoT lives inside a prose
# blockquote, e.g.  `> **Loading**: Tier 2 (Scope) ... agent_scope ∈ {dev-front,
# dev-react, ...}`. Anchor on the `agent_scope ∈ {...}` brace list so the parser
# does not match any other brace-bearing line.
_ROSTER_STANZA_RE = re.compile(
    r"agent_scope\s*∈\s*\{(?P<roster>[^}]*)\}",
)


# A single inject-scope-rules.sh array assignment:
#   readonly INJECT_AGENTS=" dev-front dev-react ... qa-debugger "
# Capture the space-padded body between the quotes; tolerate single or double.
def _array_re(var_name: str) -> re.Pattern[str]:
    return re.compile(
        rf"""^\s*(?:readonly\s+)?{re.escape(var_name)}=(["'])(?P<body>.*?)\1\s*$""",
        re.MULTILINE,
    )


_INJECT_AGENTS_RE = _array_re("INJECT_AGENTS")
_STYLEREF_AGENTS_RE = _array_re("STYLEREF_AGENTS")
_MINIMALISM_AGENTS_RE = _array_re("MINIMALISM_AGENTS")
# NAMING_AGENTS = DEV roster − {dev-swift} ∪ {qa-code-reviewer}, EXCLUDING
# qa-debugger — a deliberately NARROWER roster than the other three arrays
# (the naming delta-core injects to the review-enforcement surface, not the
# read-only debugger). Auto-reconciled as the 4th array under the HYBRID fix.
_NAMING_AGENTS_RE = _array_re("NAMING_AGENTS")

# enforce-{verification-gate,workflow-verify-stage}.sh carry an UNPADDED
# `readonly DEV_SET="dev-front dev-react ... dev-swift"` bash string (single-space
# separated, NOT the ` a b c ` space-padded inject-array convention). The same
# `_array_re` factory matches it — the regex is padding-agnostic, and split()
# yields the names either way; this alias names the gate-side anchor explicitly.
_DEV_SET_RE = _array_re("DEV_SET")

# scripts/gate-audit.sh carries TWO byte-identical multi-line SQL DEV-set lists:
#   bool_or(agent IN (
#     'dev-front','dev-react',...,'dev-android',
#     ...
#   )) AS has_dev
# Anchor on the `agent IN (` open + the `))` close so re.finditer locates BOTH
# occurrences (AUDIT_SQL + SUMMARY_SQL). `body` is the indented, single-quoted,
# comma-separated name block between them; DOTALL spans the line breaks.
_SQL_IN_LIST_RE = re.compile(
    r"agent IN \(\n(?P<body>.*?)\n[ \t]*\)\)",
    re.DOTALL,
)
# A single-quoted DEV name inside an SQL IN-list body (safe charset only).
_SQL_NAME_RE = re.compile(r"'(?P<name>[a-z0-9-]+)'")


class ReaderError(RuntimeError):
    """A store could not be parsed into the expected shape — caller HALTs."""


def load_registry_agents(paths: StorePaths) -> dict[str, dict]:
    """Return the registry `agents` dict (name -> entry), preserving order.

    Raises ReaderError when the registry lacks a top-level `agents` dict.
    """
    registry = load_json(paths.registry)
    agents = registry.get("agents") if isinstance(registry, dict) else None
    if not isinstance(agents, dict):
        raise ReaderError(f"{paths.registry} has no top-level `agents` dict")
    return agents


def registry_domains(paths: StorePaths) -> dict[str, list[str]]:
    """Return name -> domains-token-list for every registry agent.

    Entries with a non-list `domains` field are normalized to an empty list so
    the overlap predicate never sees a malformed shape.
    """
    out: dict[str, list[str]] = {}
    for name, entry in load_registry_agents(paths).items():
        domains = entry.get("domains") if isinstance(entry, dict) else None
        out[name] = list(domains) if isinstance(domains, list) else []
    return out


def parse_scope_dev_roster(paths: StorePaths) -> list[str]:
    """Parse the DEV roster from the scope-dev.md Tier-2 brace list (dev-note 1).

    Returns the ordered list of agent names inside `agent_scope ∈ { ... }`.
    Raises ReaderError when the anchored stanza is absent (so a malformed roster
    file fails loud, not silently empty).
    """
    return parse_roster_text(
        paths.scope_dev.read_text(encoding="utf-8"), source=str(paths.scope_dev)
    )


def parse_roster_text(text: str, *, source: str = "<text>") -> list[str]:
    """Parse a roster brace list out of raw scope-dev.md text (testable core)."""
    match = _ROSTER_STANZA_RE.search(text)
    if match is None:
        raise ReaderError(
            f"DEV roster stanza (agent_scope ∈ {{...}}) not found in {source}"
        )
    raw = match.group("roster")
    names = [tok.strip() for tok in raw.split(",")]
    return [tok for tok in names if tok]


def parse_inject_arrays(
    paths: StorePaths,
) -> tuple[list[str], list[str], list[str], list[str]]:
    """Parse the 4 inject-scope-rules.sh arrays from the hook file (B4).

    INJECT_AGENTS = DEV + QA, STYLEREF_AGENTS = DEV-only,
    MINIMALISM_AGENTS = DEV-only, NAMING_AGENTS = DEV − {dev-swift} + qa-code-reviewer
    (narrower roster, EXCLUDES qa-debugger). Returns all four as ordered name
    lists, in that order. Raises ReaderError when any array is absent.
    """
    return parse_inject_text(
        paths.inject_scope_rules.read_text(encoding="utf-8"),
        source=str(paths.inject_scope_rules),
    )


def parse_inject_text(
    text: str, *, source: str = "<text>"
) -> tuple[list[str], list[str], list[str], list[str]]:
    """Parse all 4 inject-scope-rules.sh arrays out of raw bash text (testable core).

    Returns (inject, styleref, minimalism, naming) — the 4-tuple order every
    destructuring caller mirrors. NAMING_AGENTS is the 4th array (narrower
    roster: DEV − {dev-swift} + qa-code-reviewer, EXCLUDES qa-debugger).
    """
    inject = _INJECT_AGENTS_RE.search(text)
    styleref = _STYLEREF_AGENTS_RE.search(text)
    minimalism = _MINIMALISM_AGENTS_RE.search(text)
    naming = _NAMING_AGENTS_RE.search(text)
    if inject is None:
        raise ReaderError(f"INJECT_AGENTS array not found in {source}")
    if styleref is None:
        raise ReaderError(f"STYLEREF_AGENTS array not found in {source}")
    if minimalism is None:
        raise ReaderError(f"MINIMALISM_AGENTS array not found in {source}")
    if naming is None:
        raise ReaderError(f"NAMING_AGENTS array not found in {source}")
    inject_names = inject.group("body").split()
    styleref_names = styleref.group("body").split()
    minimalism_names = minimalism.group("body").split()
    naming_names = naming.group("body").split()
    return inject_names, styleref_names, minimalism_names, naming_names


def parse_scope_legend_names(paths: StorePaths) -> set[str]:
    """Collect agent names from the compliance-matrix Scope Legend table.

    The matrix-name-absent orphan mode keys on NAME presence anywhere in the
    Scope Legend rows (the stale `rules/scope-*.md` path strings are ignored —
    F2-RT-09). Returns the union of comma-separated names across legend rows.
    """
    return parse_scope_legend_text(paths.compliance_matrix.read_text(encoding="utf-8"))


def parse_scope_legend_text(text: str) -> set[str]:
    """Extract the Scope Legend agent-name set (the name->scope map's key view).

    `scope_infer.build_scope_index_from_text` is the single Scope Legend parser;
    its name->scope map keys ARE the legend name set the orphan matrix-name-absent
    mode reads.
    """
    from .scope_infer import build_scope_index_from_text

    return set(build_scope_index_from_text(text))


def parse_dev_set_text(text: str, *, source: str = "<text>") -> list[str]:
    """Parse the unpadded `DEV_SET="..."` bash string into an ordered name list.

    The gate hooks (enforce-verification-gate.sh / enforce-workflow-verify-stage.sh)
    declare a single-space-separated `readonly DEV_SET="dev-front ... dev-swift"`.
    Returns the names in file order. Raises ReaderError when the anchored
    assignment is absent (so a malformed gate file fails loud, not silently empty).
    """
    match = _DEV_SET_RE.search(text)
    if match is None:
        raise ReaderError(f'DEV_SET="..." bash assignment not found in {source}')
    return match.group("body").split()


def parse_sql_in_list_text(text: str, *, source: str = "<text>") -> list[list[str]]:
    """Parse EVERY `agent IN (...)` SQL DEV-set list, one name-list per occurrence.

    gate-audit.sh carries two occurrences (AUDIT_SQL + SUMMARY_SQL) that MUST stay
    byte-identical; this returns a list-of-lists (occurrence order preserved) so a
    caller can assert they agree. Raises ReaderError when no occurrence is found
    (so an absent / renamed anchor fails loud).
    """
    matches = list(_SQL_IN_LIST_RE.finditer(text))
    if not matches:
        raise ReaderError(f"`agent IN (...)` SQL DEV-set list not found in {source}")
    return [
        [nm.group("name") for nm in _SQL_NAME_RE.finditer(m.group("body"))]
        for m in matches
    ]
