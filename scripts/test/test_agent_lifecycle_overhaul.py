"""Regression tests for the agent-management overhaul (origin baseline + migration removal).

Covers PART-A backend behavior changes:
  - ADD builds an entry with origin (the CLI passes --origin user), the `rules`
    membership object, and NO scope field.
  - DELETE is origin:user-only: a shipped row is refused, a user row permitted.
  - The hardcoded NON-DEV block list still refuses regardless of origin.
  - A row missing origin fail-closes (HALT).
  - The migrate machinery is gone (no migrate subcommand, no migrate module).

Tests target isolated temp StorePaths so no live store is touched.
"""

from __future__ import annotations

import importlib
import json
import os
from pathlib import Path

import pytest

from agent_lifecycle.atomic import _atomic_replace, load_json
from agent_lifecycle.delete import authorize_delete
from agent_lifecycle.paths import NON_DEV_BLOCK_LIST, StorePaths
from agent_lifecycle.readers import ReaderError, registry_domains
from agent_lifecycle.registry_ops import (
    SCOPE_SHARED_RULE_FILES,
    RegistryMutationError,
    add_entry,
    add_shared_rule_file,
    assert_rule_files_known,
    build_entry,
)


def _write_registry(root: Path, agents: dict[str, dict]) -> StorePaths:
    """Write a minimal registry into a temp GA root and return its StorePaths."""
    paths = StorePaths.for_root(root)
    paths.registry.parent.mkdir(parents=True, exist_ok=True)
    paths.registry.write_text(
        json.dumps({"version": "1.1", "agents": agents}, indent=2) + "\n",
        encoding="utf-8",
    )
    return paths


# --- ADD origin / no-scope ------------------------------------------------


def test_when_build_entry_then_origin_present_and_scope_absent() -> None:
    entry = build_entry(domains=["x"], origin="user", scope="DEV")
    assert entry["origin"] == "user"
    assert "scope" not in entry


def test_when_add_user_agent_then_registry_row_is_origin_user(tmp_path: Path) -> None:
    paths = _write_registry(tmp_path, {})
    add_entry(paths, "dev-new", build_entry(domains=["x"], origin="user", scope="DEV"))
    row = load_json(paths.registry)["agents"]["dev-new"]
    assert row["origin"] == "user"
    assert "scope" not in row


# --- registry `rules` membership object -----------------------------------


def test_when_build_entry_dev_then_rules_carry_scope_shared_conditional() -> None:
    rules = build_entry(domains=["x"], origin="user", scope="DEV")["rules"]
    assert rules["scope"] == "scoped/scope-dev.md"
    # the 8 Tier-3 files that bind every DEV unconditionally. The UI-emitting
    # subset also takes shared-design-token-consumption.md, which is a per-agent
    # fact the scope label cannot carry — added by hand, so absent from defaults.
    assert rules["shared"] == [
        "scoped/shared-comment-logging.md",
        "scoped/shared-performance.md",
        "scoped/shared-search-first.md",
        "scoped/shared-testing.md",
        "scoped/shared-type-safety.md",
        "scoped/shared-code-structure.md",
        "scoped/shared-investigation-discipline.md",
        "scoped/shared-naming.md",
    ]
    # conditional membership is a separate facet, never folded into `shared`:
    # each entry carries the `when` that makes it conditional rather than standing.
    assert [c["file"] for c in rules["conditional"]] == [
        "rules/glass-atrium/shared-self-improve-hygiene.md",
        "scoped/shared-hook-capability-contract.md",
    ]
    assert all(c["when"] for c in rules["conditional"])


def test_when_build_entry_scope_without_tier3_then_shared_is_empty() -> None:
    rules = build_entry(domains=["x"], origin="user", scope="RESEARCH")["rules"]
    assert rules["scope"] == "scoped/scope-research.md"
    assert rules["shared"] == []
    assert rules["conditional"] == []


def test_when_build_entry_scope_lowercase_then_mapped() -> None:
    rules = build_entry(domains=["x"], origin="user", scope="qa")["rules"]
    assert rules["scope"] == "scoped/scope-qa.md"
    # QA takes investigation-discipline as a scope default; shared-code-structure
    # and shared-naming bind glass-atrium-qa-code-reviewer ALONE, so they are a
    # per-agent hand-add and never a QA default.
    assert rules["shared"] == [
        "scoped/shared-comment-logging.md",
        "scoped/shared-investigation-discipline.md",
    ]
    # QA cites the hook contract under a REVIEW condition, not the DEV authoring one
    assert rules["conditional"] == [
        {
            "file": "scoped/shared-hook-capability-contract.md",
            "when": "the task reviews a hook change or analyses a hook failure",
        }
    ]


def test_when_build_entry_then_conditional_defaults_are_not_shared_state() -> None:
    # The module-level condition dicts must not leak into a built entry: mutating
    # one row's conditional would otherwise rewrite every later ADD.
    first = build_entry(domains=["x"], origin="user", scope="DEV")["rules"]
    first["conditional"][0]["when"] = "mutated"
    second = build_entry(domains=["y"], origin="user", scope="DEV")["rules"]
    assert second["conditional"][0]["when"] != "mutated"


def test_when_build_entry_scope_unknown_then_halts() -> None:
    # A silent empty default would ship an agent claiming membership in nothing.
    with pytest.raises(RegistryMutationError, match="unknown scope"):
        build_entry(domains=["x"], origin="user", scope="ORCHESTRATOR")


def test_when_entry_cites_unknown_rule_file_then_add_entry_halts(
    tmp_path: Path,
) -> None:
    # The vocabulary check is homed on the write surface, so a path no consumer
    # could resolve is refused at the registry boundary, not by its first reader.
    paths = _write_registry(tmp_path, {})
    entry = build_entry(domains=["x"], origin="user", scope="DEV")
    entry["rules"]["shared"].append("scoped/shared-typo-safety.md")
    with pytest.raises(RegistryMutationError, match="unknown rule file"):
        add_entry(paths, "dev-new", entry)


def test_when_conditional_entry_omits_when_then_add_entry_halts(
    tmp_path: Path,
) -> None:
    # A conditional without its `when` is indistinguishable from standing
    # membership, which is the one thing this facet exists to keep apart.
    paths = _write_registry(tmp_path, {})
    entry = build_entry(domains=["x"], origin="user", scope="DEV")
    entry["rules"]["conditional"].append({"file": "scoped/shared-testing.md"})
    with pytest.raises(RegistryMutationError, match="needs both"):
        add_entry(paths, "dev-new", entry)


def test_when_dry_run_scope_unknown_then_preview_reports_not_allowed(
    tmp_path: Path,
) -> None:
    # The preview has to see the same refusal the real ADD would hit: reporting
    # allowed:true for a run that HALTs is worse than no preview at all.
    from agent_lifecycle.add import AddRequest, dry_run_add

    paths = _write_registry(tmp_path, {})
    paths.agents_dir.mkdir(parents=True, exist_ok=True)
    out = json.loads(
        dry_run_add(
            paths,
            AddRequest(
                name="glass-atrium-dev-probe",
                scope="ORCHESTRATOR",
                origin="user",
                domains=["probes"],
                q1_verdict="pass",
                q2_verdict="pass",
            ),
        )
    )
    assert out["allowed"] is False
    assert any("unknown scope" in reason for reason in out["reasons"])


def test_when_live_registry_read_then_every_row_passes_the_vocabulary_check() -> None:
    # The shipped rows are the check's real corpus: a writer whose vocabulary
    # disagrees with the backfill would emit rows shaped unlike all 23 of them.
    registry = load_json(Path(__file__).resolve().parents[2] / "agent-registry.json")
    for name, row in registry["agents"].items():
        assert "rules" in row, f"{name} carries no rules object"
        assert_rule_files_known(row)


def test_when_entry_has_no_rules_object_then_add_entry_passes(tmp_path: Path) -> None:
    # Pre-backfill rows carry no `rules` — the check must not refuse them.
    paths = _write_registry(tmp_path, {})
    add_entry(paths, "dev-legacy", {"domains": ["x"], "origin": "user"})
    assert "rules" not in load_json(paths.registry)["agents"]["dev-legacy"]


# --- additive rules.shared append ----------------------------------------


def _dev_row(tmp_path: Path) -> StorePaths:
    """A registry holding one freshly ADDed DEV row, ready to extend."""
    paths = _write_registry(tmp_path, {})
    add_entry(paths, "dev-new", build_entry(domains=["x"], origin="user", scope="DEV"))
    return paths


def _shared_of(paths: StorePaths, name: str) -> list[str]:
    return load_json(paths.registry)["agents"][name]["rules"]["shared"]


def test_when_shared_rule_file_appended_then_row_gains_it_after_the_defaults(
    tmp_path: Path,
) -> None:
    # The motivating divergence: a UI-emitting DEV also takes the design-token
    # file, a per-agent fact no scope label carries, so ADD lands without it.
    paths = _dev_row(tmp_path)
    add_shared_rule_file(paths, "dev-new", "scoped/shared-design-token-consumption.md")
    shared = _shared_of(paths, "dev-new")
    assert shared[-1] == "scoped/shared-design-token-consumption.md"
    assert shared[:-1] == list(SCOPE_SHARED_RULE_FILES["DEV"])


def test_when_shared_rule_file_already_present_then_append_is_a_noop(
    tmp_path: Path,
) -> None:
    paths = _dev_row(tmp_path)
    before = _shared_of(paths, "dev-new")
    undo = add_shared_rule_file(paths, "dev-new", "scoped/shared-testing.md")
    assert _shared_of(paths, "dev-new") == before
    # the reverse-op of a no-op must not strip a file this call never added
    undo()
    assert _shared_of(paths, "dev-new") == before


def test_when_append_reversed_then_shared_returns_to_its_prior_value(
    tmp_path: Path,
) -> None:
    paths = _dev_row(tmp_path)
    before = _shared_of(paths, "dev-new")
    undo = add_shared_rule_file(
        paths, "dev-new", "scoped/shared-design-token-consumption.md"
    )
    undo()
    assert _shared_of(paths, "dev-new") == before


def test_when_appended_file_outside_vocabulary_then_halts_before_write(
    tmp_path: Path,
) -> None:
    # assert_rule_files_known runs on the RESULT, so an unresolvable path is
    # refused at the boundary and the stored row never sees it.
    paths = _dev_row(tmp_path)
    before = _shared_of(paths, "dev-new")
    with pytest.raises(RegistryMutationError, match="unknown rule file"):
        add_shared_rule_file(paths, "dev-new", "scoped/shared-typo-safety.md")
    assert _shared_of(paths, "dev-new") == before


def test_when_row_has_no_rules_object_then_append_halts(tmp_path: Path) -> None:
    # A pre-backfill row has no membership to extend; inventing one would claim
    # a scope default this op cannot know.
    paths = _write_registry(tmp_path, {"dev-legacy": {"domains": ["x"]}})
    with pytest.raises(RegistryMutationError, match="no rules"):
        add_shared_rule_file(paths, "dev-legacy", "scoped/shared-testing.md")


# --- DELETE origin:user-only ---------------------------------------------


def test_when_origin_user_then_delete_permitted(tmp_path: Path) -> None:
    paths = _write_registry(tmp_path, {"dev-new": {"domains": [], "origin": "user"}})
    auth = authorize_delete(paths, "dev-new")
    assert auth.allowed is True
    assert auth.origin == "user"


def test_when_origin_shipped_then_delete_refused(tmp_path: Path) -> None:
    paths = _write_registry(tmp_path, {"dev-front": {"domains": [], "origin": "shipped"}})
    auth = authorize_delete(paths, "dev-front")
    assert auth.allowed is False
    assert "origin=shipped" in auth.reason


def test_when_origin_absent_then_delete_fail_closed(tmp_path: Path) -> None:
    paths = _write_registry(tmp_path, {"dev-front": {"domains": []}})
    auth = authorize_delete(paths, "dev-front")
    assert auth.allowed is False
    assert "fail-closed" in auth.reason


def test_when_on_block_list_then_delete_refused_regardless_of_origin(
    tmp_path: Path,
) -> None:
    blocked = next(iter(NON_DEV_BLOCK_LIST))
    paths = _write_registry(tmp_path, {blocked: {"domains": [], "origin": "user"}})
    auth = authorize_delete(paths, blocked)
    assert auth.allowed is False
    assert "block list" in auth.reason


# --- migration machinery removed -----------------------------------------


def test_when_migrate_module_imported_then_module_not_found() -> None:
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("agent_lifecycle.migrate")


def test_when_cli_built_then_no_migrate_subcommand() -> None:
    from agent_lifecycle.cli import build_parser

    sub_actions = [
        a for a in build_parser()._actions if hasattr(a, "choices") and a.choices
    ]
    commands = set()
    for action in sub_actions:
        if isinstance(action.choices, dict):
            commands.update(action.choices)
    assert "migrate" not in commands
    assert {"add", "delete", "orphan-scan"} <= commands


# --- AC-S2 (clauded-docs/743): the sanctioned lifecycle write path still works ---


def test_when_add_then_extend_on_fixture_root_then_round_trip_holds(
    tmp_path: Path,
) -> None:
    """ADD + EXTEND round-trip confined to a fixture root.

    StorePaths.for_root keeps every write inside tmp_path; default_ga_root()
    resolves from the module location and would reach the real registry.
    """
    from agent_lifecycle.extend import ExtendRequest, run_extend

    paths = _write_registry(tmp_path, {})
    paths.agents_dir.mkdir(parents=True, exist_ok=True)
    (paths.agents_dir / "glass-atrium-dev-fixture.md").write_text(
        "---\n"
        "name: glass-atrium-dev-fixture\n"
        "description: fixture agent (AC-S2 round-trip).\n"
        "tools: [Read, Glob, Grep, Edit, Write, Bash]\n"
        "maxTurns: 40\n"
        "---\n"
        "\n"
        "# glass-atrium-dev-fixture\n",
        encoding="utf-8",
    )

    add_entry(
        paths,
        "glass-atrium-dev-fixture",
        build_entry(domains=["fixtures"], origin="user", scope="DEV"),
    )
    assert "glass-atrium-dev-fixture" in load_json(paths.registry)["agents"]

    run_extend(
        paths, ExtendRequest(name="glass-atrium-dev-fixture", add_domain="probes")
    )
    row = load_json(paths.registry)["agents"]["glass-atrium-dev-fixture"]
    assert row["domains"] == ["fixtures", "probes"]


# --- T111 (clauded-docs/1466): malformed registry domains fail loud at the gate ---


def _gate(paths: StorePaths, domains: list[str]):
    """Run the create gate — the entry point a malformed registry now HALTs at."""
    from agent_lifecycle.add import AddRequest, evaluate_add_gate

    return evaluate_add_gate(
        paths,
        AddRequest(
            name="glass-atrium-dev-probe",
            scope="DEV",
            origin="user",
            domains=domains,
            q1_verdict="pass",
            q2_verdict="pass",
        ),
    )


def test_when_domains_field_not_a_list_then_gate_raises_reader_error(
    tmp_path: Path,
) -> None:
    paths = _write_registry(tmp_path, {"glass-atrium-dev-front": {"domains": "react"}})
    with pytest.raises(ReaderError, match=r"glass-atrium-dev-front.*non-list.*str"):
        _gate(paths, ["react"])


def test_when_registry_entry_not_a_dict_then_gate_raises_reader_error(
    tmp_path: Path,
) -> None:
    paths = _write_registry(tmp_path, {"glass-atrium-dev-front": ["react"]})
    with pytest.raises(ReaderError, match=r"glass-atrium-dev-front.*expected dict"):
        _gate(paths, ["react"])


def test_when_registry_well_formed_then_gate_verdict_unchanged(tmp_path: Path) -> None:
    """Well-formed rows still pass, including an entry with no `domains` key."""
    paths = _write_registry(
        tmp_path,
        {
            "glass-atrium-dev-front": {"domains": ["react", "css"], "origin": "shipped"},
            "glass-atrium-dev-db": {"origin": "shipped"},
        },
    )
    assert registry_domains(paths) == {
        "glass-atrium-dev-front": ["react", "css"],
        "glass-atrium-dev-db": [],
    }

    verdict = _gate(paths, ["prisma", "sqlite"])
    assert verdict.allowed is True
    assert verdict.q3_conflicts == []


def test_when_registry_malformed_then_orphan_mode6_reports_instead_of_raising(
    tmp_path: Path,
) -> None:
    """The scan stays per-stage loud: one bad entry is a finding, not an abort."""
    from agent_lifecycle.orphan_scan import _check_domains_overlap

    paths = _write_registry(tmp_path, {"glass-atrium-dev-front": {"domains": "react"}})
    findings = _check_domains_overlap(paths)
    assert [f.mode for f in findings] == ["domains-overlap"]
    assert "non-list" in findings[0].detail


def test_when_target_exists_then_atomic_replace_keeps_its_mode(
    tmp_path: Path,
) -> None:
    """mkstemp creates 0600 and os.replace carries that mode onto the target.

    Git tracks only the exec bit, so an unpreserved mode is invisible in a diff
    while generate-manifest.sh records it and both install paths apply it.
    """
    target = tmp_path / "agent.md"
    target.write_text("old\n", encoding="utf-8")
    target.chmod(0o644)

    _atomic_replace(target, "new\n")

    assert target.stat().st_mode & 0o777 == 0o644
    assert target.read_text(encoding="utf-8") == "new\n"

    script = tmp_path / "hook.sh"
    script.write_text("#!/bin/sh\n", encoding="utf-8")
    script.chmod(0o755)

    _atomic_replace(script, "#!/bin/sh\ntrue\n")

    assert script.stat().st_mode & 0o777 == 0o755


def test_when_target_is_new_then_atomic_replace_takes_the_umask_default(
    tmp_path: Path,
) -> None:
    """A first write lands where a plain open() would have, not at mkstemp's 0600."""
    umask = os.umask(0o022)
    os.umask(umask)
    target = tmp_path / "fresh.md"

    _atomic_replace(target, "x\n")

    assert target.stat().st_mode & 0o777 == 0o666 & ~umask
