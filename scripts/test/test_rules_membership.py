"""rules-membership reconcile: the registry `rules` object against the matrix.

Covers the reader (`readers.load_registry_rules`), the two new orphan-scan modes
(`rules-membership-mismatch`, `dev-roster-declaration-mismatch`) and the
declaration-row parsers they read.

The load-bearing case is `test_table_cell_divergence_is_not_reported`: the
Compliance Matrix table carries a bare tick in the QA column for
`scoped/shared-naming.md`, while the Tier-3 declaration row names
glass-atrium-qa-code-reviewer alone. A reconciler reading the CELL reports a
permanent false divergence for glass-atrium-qa-debugger, which holds the file on
neither its registry row nor the declaration row. The fixture reproduces that
exact shape so the rule is pinned by a test rather than by a comment.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS_ROOT = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from agent_lifecycle.orphan_scan import run_scan  # noqa: E402
from agent_lifecycle.paths import StorePaths  # noqa: E402
from agent_lifecycle.readers import ReaderError, load_registry_rules  # noqa: E402
from agent_lifecycle.registry_ops import (  # noqa: E402
    SCOPE_RULE_FILES,
    get_rules_for_scope,
)
from agent_lifecycle.scope_infer import (  # noqa: E402
    build_scope_index_from_registry,
    build_tier2_index_from_text,
    build_tier3_index_from_text,
)

_DEV_FILE = SCOPE_RULE_FILES["DEV"]
_QA_FILE = SCOPE_RULE_FILES["QA"]
_NAMING = "scoped/shared-naming.md"
_COMMENT_LOGGING = "scoped/shared-comment-logging.md"
_HOOK_CONTRACT = "scoped/shared-hook-capability-contract.md"

# A matrix fixture carrying the three shapes the reconcile has to tell apart: a
# bare scope token (asserted forwards), a named agent (asserted forwards) and a
# subset token (never asserted forwards). The Compliance Matrix table below
# carries the COARSER bare tick for QA on the naming row — the divergence the
# declaration rows resolve and a cell reader does not.
_MATRIX = f"""# Rule-to-Agent Compliance Matrix

### Tier 2 — Scope (loaded when agent scope matches)

| File | Loads when `agent_scope =` |
|------|---------------------------|
| `{_DEV_FILE}` | DEV |
| `{_QA_FILE}` | QA |

### Tier 3 — Cross-cutting (conditional inheritance)

| Tier-3 file | Inherited by |
|---|---|
| `{_COMMENT_LOGGING}` | DEV · QA |
| `{_NAMING}` | DEV · glass-atrium-qa-code-reviewer |
| `{_HOOK_CONTRACT}` | hook-authoring DEV · hook-reviewing QA ¶ |

## Compliance Matrix

| Rule File | DEV | QA |
|-----------|-----|----|
| shared-naming.md | ✓ | ✓ |

## Scope Legend

| Scope | Agents |
|-------|--------|
| DEV | glass-atrium-dev-shell |
| QA | glass-atrium-qa-code-reviewer, glass-atrium-qa-debugger |
"""


def _dev_rules() -> dict:
    return {
        "scope": _DEV_FILE,
        "shared": [_COMMENT_LOGGING, _NAMING],
        "conditional": [{"file": _HOOK_CONTRACT, "when": "the task writes a hook"}],
    }


def _qa_reviewer_rules() -> dict:
    return {
        "scope": _QA_FILE,
        "shared": [_COMMENT_LOGGING, _NAMING],
        "conditional": [{"file": _HOOK_CONTRACT, "when": "the task reviews a hook"}],
    }


def _qa_debugger_rules() -> dict:
    # No naming file: the Tier-3 row does not name this agent, so its ABSENCE is
    # the correct state and reporting it would be the false divergence.
    return {"scope": _QA_FILE, "shared": [_COMMENT_LOGGING], "conditional": []}


def _write_fixture(root: Path, agents: dict[str, dict]) -> StorePaths:
    """Build the minimal store the two new modes read."""
    (root / "rules" / "glass-atrium").mkdir(parents=True, exist_ok=True)
    (root / "scoped").mkdir(parents=True, exist_ok=True)
    (root / "rules" / "glass-atrium" / "core-compliance-matrix.md").write_text(
        _MATRIX, encoding="utf-8"
    )
    dev_names = [
        name
        for name, entry in agents.items()
        if isinstance(entry.get("rules"), dict)
        and entry["rules"].get("scope") == _DEV_FILE
    ]
    (root / "scoped" / "scope-dev.md").write_text(
        "# DEV Scope\n"
        f"> **Loading**: Tier 2 (Scope) — auto-loads when agent_scope ∈ {{{', '.join(dev_names)}}}\n",
        encoding="utf-8",
    )
    (root / "agent-registry.json").write_text(
        json.dumps({"agents": agents}), encoding="utf-8"
    )
    (root / "manifest.json").write_text(json.dumps({"files": []}), encoding="utf-8")
    return StorePaths.for_root(root)


def _clean_agents() -> dict[str, dict]:
    return {
        "glass-atrium-dev-shell": {"rules": _dev_rules()},
        "glass-atrium-qa-code-reviewer": {"rules": _qa_reviewer_rules()},
        "glass-atrium-qa-debugger": {"rules": _qa_debugger_rules()},
    }


def _findings(paths: StorePaths, mode: str) -> list[str]:
    return [f"{f.name}: {f.detail}" for f in run_scan(paths, [mode]).by_mode(mode)]


# --- the reader -------------------------------------------------------------


def test_load_registry_rules_returns_the_membership_object(tmp_path: Path) -> None:
    paths = _write_fixture(tmp_path, _clean_agents())

    rules = load_registry_rules(paths)

    assert set(rules) == set(_clean_agents())
    assert rules["glass-atrium-dev-shell"]["scope"] == _DEV_FILE
    assert _NAMING in rules["glass-atrium-dev-shell"]["shared"]


def test_load_registry_rules_omits_a_row_without_rules(tmp_path: Path) -> None:
    """A pre-backfill row is an ABSENCE, never an empty membership it never declared."""
    agents = _clean_agents()
    agents["glass-atrium-dev-legacy"] = {"description": "no rules object yet"}
    paths = _write_fixture(tmp_path, agents)

    assert "glass-atrium-dev-legacy" not in load_registry_rules(paths)


@pytest.mark.parametrize(
    "bad_rules", [["not", "a", "dict"], {"shared": []}], ids=["non-dict", "no-scope"]
)
def test_load_registry_rules_fails_loud_on_a_malformed_object(
    tmp_path: Path, bad_rules: object
) -> None:
    agents = _clean_agents()
    agents["glass-atrium-dev-shell"]["rules"] = bad_rules
    paths = _write_fixture(tmp_path, agents)

    with pytest.raises(ReaderError, match="glass-atrium-dev-shell"):
        load_registry_rules(paths)


# --- the declaration-row parsers -------------------------------------------


def test_tier_parsers_split_bare_tokens_from_subset_tokens() -> None:
    tier2 = build_tier2_index_from_text(_MATRIX)
    tier3 = build_tier3_index_from_text(_MATRIX)

    assert tier2["DEV"] == [_DEV_FILE]
    assert tier3[_NAMING]["scopes"] == {"DEV"}
    assert tier3[_NAMING]["agents"] == {"glass-atrium-qa-code-reviewer"}
    # a footnote-marked / qualified token is a SUBSET, never a forward assertion.
    assert tier3[_HOOK_CONTRACT]["scopes"] == set()
    assert tier3[_HOOK_CONTRACT]["subsets"] == {"DEV", "QA"}


def test_scope_index_is_inverted_from_the_registry_row(tmp_path: Path) -> None:
    """The scope LABEL is recovered from `rules.scope`, so no second field is needed."""
    paths = _write_fixture(tmp_path, _clean_agents())

    index = build_scope_index_from_registry(load_registry_rules(paths))

    assert index["glass-atrium-dev-shell"] == "DEV"
    assert index["glass-atrium-qa-debugger"] == "QA"


# --- rules-membership-mismatch ---------------------------------------------


def test_clean_store_reports_nothing(tmp_path: Path) -> None:
    paths = _write_fixture(tmp_path, _clean_agents())

    assert _findings(paths, "rules-membership-mismatch") == []


def test_table_cell_divergence_is_not_reported(tmp_path: Path) -> None:
    """The QA column's bare tick for the naming file is NOT a divergence.

    The Compliance Matrix cell covers both QA agents; the Tier-3 declaration row
    names glass-atrium-qa-code-reviewer alone, and glass-atrium-qa-debugger's
    registry row agrees by carrying nothing. Reading the cell would report this
    agent forever; reading the declaration row reports nothing.
    """
    paths = _write_fixture(tmp_path, _clean_agents())

    findings = _findings(paths, "rules-membership-mismatch")

    assert not any("glass-atrium-qa-debugger" in f for f in findings), findings
    # the cell the wrong reader would key on is genuinely present in the fixture.
    assert "| shared-naming.md | ✓ | ✓ |" in _MATRIX


def test_missing_unconditional_member_is_reported(tmp_path: Path) -> None:
    """Forward direction: a bare scope token the row does not carry."""
    agents = _clean_agents()
    agents["glass-atrium-dev-shell"]["rules"]["shared"] = [_NAMING]
    paths = _write_fixture(tmp_path, agents)

    findings = _findings(paths, "rules-membership-mismatch")

    assert any(
        "glass-atrium-dev-shell" in f and _COMMENT_LOGGING in f for f in findings
    ), findings


def test_undeclared_member_on_a_row_is_reported(tmp_path: Path) -> None:
    """Reverse direction: a file the agent's Tier-3 row does not declare for it."""
    agents = _clean_agents()
    agents["glass-atrium-qa-debugger"]["rules"]["shared"].append(_NAMING)
    paths = _write_fixture(tmp_path, agents)

    findings = _findings(paths, "rules-membership-mismatch")

    assert any(
        "glass-atrium-qa-debugger" in f and _NAMING in f for f in findings
    ), findings


def test_a_subset_declaration_satisfies_the_reverse_direction(tmp_path: Path) -> None:
    """A conditional entry whose row declares a SUBSET of the agent's scope passes."""
    paths = _write_fixture(tmp_path, _clean_agents())

    findings = _findings(paths, "rules-membership-mismatch")

    assert not any(_HOOK_CONTRACT in f for f in findings), findings


def test_a_scope_file_no_tier2_row_declares_is_reported(tmp_path: Path) -> None:
    agents = _clean_agents()
    agents["glass-atrium-dev-shell"]["rules"]["scope"] = "scoped/scope-invented.md"
    paths = _write_fixture(tmp_path, agents)

    findings = _findings(paths, "rules-membership-mismatch")

    assert any("scope-invented.md" in f for f in findings), findings


# --- dev-roster-declaration-mismatch ---------------------------------------


def test_dev_roster_declarations_agree_on_a_clean_store(tmp_path: Path) -> None:
    paths = _write_fixture(tmp_path, _clean_agents())

    assert _findings(paths, "dev-roster-declaration-mismatch") == []


def test_registry_dev_absent_from_the_brace_roster_is_reported(tmp_path: Path) -> None:
    paths = _write_fixture(tmp_path, _clean_agents())
    paths.scope_dev.write_text(
        "# DEV Scope\n> **Loading**: Tier 2 (Scope) — agent_scope ∈ {}\n",
        encoding="utf-8",
    )

    findings = _findings(paths, "dev-roster-declaration-mismatch")

    assert any("glass-atrium-dev-shell" in f for f in findings), findings


def test_brace_roster_name_without_a_dev_registry_row_is_reported(
    tmp_path: Path,
) -> None:
    agents = _clean_agents()
    agents["glass-atrium-dev-shell"]["rules"]["scope"] = _QA_FILE
    paths = _write_fixture(tmp_path, agents)
    paths.scope_dev.write_text(
        "# DEV Scope\n"
        "> **Loading**: Tier 2 (Scope) — agent_scope ∈ {glass-atrium-dev-shell}\n",
        encoding="utf-8",
    )

    findings = _findings(paths, "dev-roster-declaration-mismatch")

    assert any("glass-atrium-dev-shell" in f for f in findings), findings


# --- what an ADD records ----------------------------------------------------


def test_qa_add_records_a_qa_rules_object() -> None:
    """A QA ADD records QA membership, so the row is reconcilable from the start.

    Complements the INJECT_AGENTS QA-insert test, which covers the other half:
    that array still carries the QA names and gates the comment-logging block,
    while rule MEMBERSHIP is what the registry row has to get right.
    """
    rules = get_rules_for_scope("QA")

    assert rules["scope"] == _QA_FILE
    assert _COMMENT_LOGGING in rules["shared"]
    # the naming file is a per-AGENT divergence within QA (qa-code-reviewer
    # alone), so the scope-level default must NOT claim it for every QA agent.
    assert _NAMING not in rules["shared"]
