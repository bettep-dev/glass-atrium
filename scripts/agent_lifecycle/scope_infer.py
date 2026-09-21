"""compliance-matrix parsers — the Scope Legend and the tier DECLARATION rows.

Responsibilities:
    Parse the matrix into the three views the reconcile compares against the
    registry: the Scope Legend name->scope map, the Tier-2 scope->file map and
    the Tier-3 file->inheritors map. Read-only text parsers — no store mutation.

Why the DECLARATION rows and never the Compliance Matrix table cell: the tier
rows are the membership statement and the Compliance Matrix table is a coarser
summary of them. `scoped/shared-naming.md` is declared for DEV and for
glass-atrium-qa-code-reviewer alone, while its Compliance Matrix QA cell carries
a bare tick covering both QA agents — so a reconciler reading the cell reports a
permanent false divergence for glass-atrium-qa-debugger, which holds the file on
neither its registry row nor the declaration row. `shared-code-structure.md` is
the identical shape.

The Scope Legend is hand-maintained: no lifecycle step writes it, and the
updater's byte-swap overwrites a hand-added row because the matrix is not
merge-claimed. It is therefore a COMPARAND here, never a source — name->scope
for a live agent is derived from its registry row by
`build_scope_index_from_registry`.
"""

from __future__ import annotations

import re

# A Scope Legend row is `| SCOPE | agent-a, agent-b, ... |`. Capture the scope
# label (col 1) and the agent-list cell (col 2). The scope label may carry
# `~~...~~` strikethrough (archived DATA) — those rows hold no live agent names.
_LEGEND_ROW_RE = re.compile(r"^\|\s*(?P<scope>[^|]+?)\s*\|\s*(?P<agents>[^|]*?)\s*\|")
_NAME_TOK_RE = re.compile(r"^[a-z0-9-]+$")


def build_scope_index_from_text(text: str) -> dict[str, str]:
    """Map agent-name -> SCOPE label from the Scope Legend table (testable core).

    Scans only the `## Scope Legend` section. Each data row's first cell is the
    scope label and its second cell is a comma-separated agent list; every
    `[a-z0-9-]+` token in that list is indexed to the row's scope. Prose-only
    rows (ALL / ORCHESTRATOR / archived DATA) contribute no agent names.
    """
    index: dict[str, str] = {}
    in_legend = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            in_legend = stripped == "## Scope Legend"
            continue
        if not in_legend or not stripped.startswith("|"):
            continue
        match = _LEGEND_ROW_RE.match(stripped)
        if match is None:
            continue
        scope = match.group("scope").strip()
        # skip the header row + separator row + strikethrough (archived) scopes.
        if (
            scope in ("Scope", "-------")
            or scope.startswith("~~")
            or set(scope) <= {"-"}
        ):
            continue
        for tok in match.group("agents").split(","):
            tok = tok.strip()
            if _NAME_TOK_RE.match(tok):
                index[tok] = scope
    return index


# A Tier-2 row is `| `scoped/scope-dev.md` | DEV |`. The ORCHESTRATOR row's first
# cell holds a file PAIR joined by ` + `, so the file cell is parsed as a list.
_TIER2_ROW_RE = re.compile(r"^\|\s*(?P<files>[^|]+?)\s*\|\s*(?P<scope>[^|]+?)\s*\|")
# A Tier-3 row is `| `scoped/shared-naming.md` | DEV · glass-atrium-qa-code-reviewer |`.
_TIER3_ROW_RE = re.compile(
    r"^\|\s*(?P<files>[^|]+?)\s*\|\s*(?P<inheritors>[^|]+?)\s*\|"
)
_BACKTICKED_RE = re.compile(r"`([^`]+)`")
_SCOPE_TOK_RE = re.compile(r"^[A-Z]+$")

# An inheritor token carrying any of these is a SUBSET of the scope it names, not
# the scope itself: the matrix states the exact subset in a footnote or in prose,
# which is not machine-derivable per agent. A subset token constrains the REVERSE
# direction only (an agent outside every named scope is still a finding) and is
# never asserted forwards. The footnote markers are literal matrix syntax.
_SUBSET_MARKERS: tuple[str, ...] = ("†", "‡", "§", "¶", "subset", "-authoring", "-reviewing")


def _section_lines(text: str, heading_prefix: str) -> list[str]:
    """Yield the stripped lines of the first `## `/`### ` section so prefixed."""
    out: list[str] = []
    inside = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            if inside:
                break
            inside = stripped.startswith(heading_prefix)
            continue
        if inside:
            out.append(stripped)
    return out


def _is_table_row(stripped: str) -> bool:
    """True for a data row of a pipe table (header + separator excluded)."""
    if not stripped.startswith("|"):
        return False
    return set(stripped) - set("|-: ") != set()


def build_tier2_index_from_text(text: str) -> dict[str, list[str]]:
    """Map SCOPE label -> the Tier-2 rule files that scope loads.

    The ORCHESTRATOR row declares a pair, so every value is a list. The header
    row (`| File | Loads when ... |`) yields no backticked file and is skipped.
    """
    index: dict[str, list[str]] = {}
    for line in _section_lines(text, "### Tier 2"):
        if not _is_table_row(line):
            continue
        match = _TIER2_ROW_RE.match(line)
        if match is None:
            continue
        files = _BACKTICKED_RE.findall(match.group("files"))
        scope = match.group("scope").strip().strip("`")
        if files and _SCOPE_TOK_RE.match(scope):
            index[scope] = files
    return index


def build_tier3_index_from_text(text: str) -> dict[str, dict[str, set[str]]]:
    """Map Tier-3 rule file -> its declared inheritors, split by assertability.

    Each value is `{"scopes": …, "agents": …, "subsets": …}`:

    - `scopes` — scope labels declared WITHOUT a subset qualifier. Every registry
      agent of such a scope MUST carry the file; this is the forward assertion.
    - `agents` — individually named agents, likewise asserted forwards.
    - `subsets` — scope labels declared with a footnote marker or a subset
      phrase. Which agents of that scope are members is stated in prose the
      matrix owns and no parser reproduces, so a subset is used only to keep the
      reverse direction from firing on a legitimate member.
    """
    index: dict[str, dict[str, set[str]]] = {}
    for line in _section_lines(text, "### Tier 3"):
        if not _is_table_row(line):
            continue
        match = _TIER3_ROW_RE.match(line)
        if match is None:
            continue
        files = _BACKTICKED_RE.findall(match.group("files"))
        if len(files) != 1:
            continue
        scopes: set[str] = set()
        agents: set[str] = set()
        subsets: set[str] = set()
        for token in match.group("inheritors").split("·"):
            token = token.strip()
            if not token:
                continue
            subset = any(marker in token for marker in _SUBSET_MARKERS)
            words = re.findall(r"[A-Za-z][A-Za-z0-9-]*", token)
            named = [w for w in words if w.startswith("glass-atrium-")]
            labels = [w for w in words if _SCOPE_TOK_RE.match(w)]
            if named:
                (subsets if subset else agents).update(named)
                continue
            for label in labels:
                (subsets if subset else scopes).add(label)
        index[files[0]] = {"scopes": scopes, "agents": agents, "subsets": subsets}
    return index


def build_scope_index_from_registry(rules_by_agent: dict[str, dict]) -> dict[str, str]:
    """Map agent name -> SCOPE label, inverted from each row's `rules.scope`.

    `registry_ops.SCOPE_RULE_FILES` is injective, so the Tier-2 file recovers the
    label without a second per-row field. An agent whose `rules.scope` names a
    file outside that map is omitted — the caller reports it as a vocabulary
    finding rather than inventing a label for it.
    """
    from .registry_ops import SCOPE_RULE_FILES

    by_file = {path: scope for scope, path in SCOPE_RULE_FILES.items()}
    return {
        name: by_file[rules["scope"]]
        for name, rules in rules_by_agent.items()
        if rules.get("scope") in by_file
    }
