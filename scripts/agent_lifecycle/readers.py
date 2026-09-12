"""READ helpers for the GA stores the CLI reasons over (registry / roster / inject).

Responsibilities:
    Load the registry agents dict and its per-agent `rules` membership object,
    parse the scope-dev.md Tier-2 brace-list DEV roster (anchored regex over
    prose, NOT a clean array — dev-note 1), and parse the tracked space-padded
    inject-scope-rules.sh bash arrays. All are READ-ONLY; no helper mutates a
    store.

The tracked-array set is declared ONCE, in `_TRACKED_INJECT_ARRAYS`: the regexes,
the parse result and every caller's key set are derived from it, so retiring or
adding a tracked array is a one-line edit here rather than an arity change that
every destructuring caller has to mirror.

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
#   readonly STYLEREF_AGENTS=" dev-front dev-react ... dev-swift "
# Capture the space-padded body between the quotes; tolerate single or double.
def _array_re(var_name: str) -> re.Pattern[str]:
    return re.compile(
        rf"""^\s*(?:readonly\s+)?{re.escape(var_name)}=(["'])(?P<body>.*?)\1\s*$""",
        re.MULTILINE,
    )


# The tracked arrays, declared ONCE. A tracked array is one whose membership is
# DERIVABLE from the DEV roster, so a reconcile can write it without a second
# copy of the list. BUDGET_ANALYSIS_AGENTS, WIKI_UNTRUSTED_AGENTS and
# PLAN_GATE_AGENTS are deliberately absent: their membership is a governance
# decision no predicate reproduces, so tracking them would mean declaring them
# twice.
#
# An array is tracked while the hook still READS it. INJECT_AGENTS,
# MINIMALISM_AGENTS and NAMING_AGENTS still gate COMMENT_BLOCK, MINIMALISM_BLOCK
# and NAMING_BLOCK, so an untracked one would mean a newly added DEV agent
# silently receiving none of the three with nothing to report it. They are
# retired from here in the same change that retires their blocks, never ahead of
# it. STYLEREF_AGENTS additionally gates the style_ref review_flag predicate
# (hooks/lib/style-ref-consts.sh reads it), so it stays tracked whatever happens
# to its block; BUDGET_DEV_AGENTS gates the BUDGET-DEV sizing block against the
# daemon-carrier exclusions.
_TRACKED_INJECT_ARRAYS: tuple[str, ...] = (
    "INJECT_AGENTS",
    "STYLEREF_AGENTS",
    "MINIMALISM_AGENTS",
    "NAMING_AGENTS",
    "BUDGET_DEV_AGENTS",
)

_INJECT_ARRAY_RES: dict[str, re.Pattern[str]] = {
    name: _array_re(name) for name in _TRACKED_INJECT_ARRAYS
}


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

    A malformed shape fails LOUD through ReaderError rather than coercing to an
    empty list: a clean-but-wrong empty list lets the 50% overlap gate pass on
    data it never actually compared. Both coercion paths (a non-dict entry, a
    non-list `domains`) raise, naming the agent and the type actually found.
    An ABSENT `domains` key stays a legitimate empty list — only a present
    field of the wrong type is malformed.

    The ADD create-gate consumer propagates to the CLI boundary, which maps
    ReaderError to HALT — a create must not proceed on uncompared data. The
    orphan-scan consumer instead catches it into a mode-6 Finding, so one
    malformed entry surfaces as a report line rather than aborting the whole
    scan and turning its advisory caller into a cycle-killer.
    """
    out: dict[str, list[str]] = {}
    for name, entry in load_registry_agents(paths).items():
        if not isinstance(entry, dict):
            raise ReaderError(
                f"{paths.registry}: agent `{name}` entry is "
                f"{type(entry).__name__}, expected dict"
            )
        domains = entry.get("domains", [])
        if not isinstance(domains, list):
            raise ReaderError(
                f"{paths.registry}: agent `{name}` has a non-list `domains` "
                f"field ({type(domains).__name__})"
            )
        out[name] = list(domains)
    return out


def load_registry_rules(paths: StorePaths) -> dict[str, dict]:
    """Return name -> the registry row's `rules` membership object.

    `rules` carries `{scope, shared, conditional}`: the Tier-2 file, the
    unconditional Tier-3 files and the task-conditional ones. A row without a
    `rules` object is omitted rather than defaulted, so a pre-backfill row is
    visible to the caller as an absence instead of as an empty membership it
    never declared.

    Raises ReaderError on a present-but-malformed object — a non-dict `rules`,
    or one missing `scope`. A membership reader that coerced either into an
    empty set would let a reconcile pass on data it never compared.
    """
    out: dict[str, dict] = {}
    for name, entry in load_registry_agents(paths).items():
        if not isinstance(entry, dict):
            raise ReaderError(
                f"{paths.registry}: agent `{name}` entry is "
                f"{type(entry).__name__}, expected dict"
            )
        rules = entry.get("rules")
        if rules is None:
            continue
        if not isinstance(rules, dict):
            raise ReaderError(
                f"{paths.registry}: agent `{name}` has a non-dict `rules` field "
                f"({type(rules).__name__})"
            )
        if not isinstance(rules.get("scope"), str):
            raise ReaderError(
                f"{paths.registry}: agent `{name}` `rules` has no `scope` string"
            )
        out[name] = rules
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


def parse_inject_arrays(paths: StorePaths) -> dict[str, list[str]]:
    """Parse the tracked inject arrays, keyed by bash variable name.

    Raises ReaderError when a tracked array is absent. The keys are exactly
    `_TRACKED_INJECT_ARRAYS`, so a caller iterates rather than destructures.

    BUDGET_DEV_AGENTS lives in the inject hook; STYLEREF_AGENTS lives in the
    declaration-only roster lib the hook and the style-ref flag predicate both
    source. Both texts are parsed as one surface — the array regexes are
    line-anchored, so concatenation is safe.
    """
    return parse_inject_text(
        "\n".join(
            (
                paths.inject_scope_rules.read_text(encoding="utf-8"),
                paths.styleref_roster.read_text(encoding="utf-8"),
            )
        ),
        source=f"{paths.inject_scope_rules} + {paths.styleref_roster}",
    )


def parse_inject_text(text: str, *, source: str = "<text>") -> dict[str, list[str]]:
    """Parse every tracked inject array out of raw bash text (testable core).

    Returns `{array_name: ordered_names}` over `_TRACKED_INJECT_ARRAYS`. An
    untracked array present in the same text is not parsed and not reported —
    the reconcile never touches one.
    """
    out: dict[str, list[str]] = {}
    for array_name, pattern in _INJECT_ARRAY_RES.items():
        match = pattern.search(text)
        if match is None:
            raise ReaderError(f"{array_name} array not found in {source}")
        out[array_name] = match.group("body").split()
    return out


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
