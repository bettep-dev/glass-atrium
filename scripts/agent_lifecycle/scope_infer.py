"""Scope Legend parser — agent-name -> SCOPE label from the compliance matrix.

Responsibilities:
    Parse the compliance-matrix Scope Legend table into a name->scope map. The
    map's key view is the legend name set the orphan matrix-name-absent mode
    reads (via readers.parse_scope_legend_text). A read-only text parser — no
    store mutation.
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
