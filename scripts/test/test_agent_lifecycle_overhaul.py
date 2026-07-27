"""Regression tests for the agent-management overhaul (origin baseline + migration removal).

Covers PART-A backend behavior changes:
  - ADD builds an entry with origin (the CLI passes --origin user) and NO scope field.
  - DELETE is origin:user-only: a shipped row is refused, a user row permitted.
  - The hardcoded NON-DEV block list still refuses regardless of origin.
  - A row missing origin fail-closes (HALT).
  - The migrate machinery is gone (no migrate subcommand, no migrate module).

Tests target isolated temp StorePaths so no live store is touched.
"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

from agent_lifecycle.atomic import load_json
from agent_lifecycle.delete import authorize_delete
from agent_lifecycle.paths import NON_DEV_BLOCK_LIST, StorePaths
from agent_lifecycle.registry_ops import add_entry, build_entry


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
    entry = build_entry(domains=["x"], origin="user")
    assert entry["origin"] == "user"
    assert "scope" not in entry


def test_when_add_user_agent_then_registry_row_is_origin_user(tmp_path: Path) -> None:
    paths = _write_registry(tmp_path, {})
    add_entry(paths, "dev-new", build_entry(domains=["x"], origin="user"))
    row = load_json(paths.registry)["agents"]["dev-new"]
    assert row["origin"] == "user"
    assert "scope" not in row


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
        "> Rules: GLASS_ATRIUM_GLOBAL_RULES.md (ALL + DEV)\n",
        encoding="utf-8",
    )

    add_entry(
        paths,
        "glass-atrium-dev-fixture",
        build_entry(domains=["fixtures"], origin="user"),
    )
    assert "glass-atrium-dev-fixture" in load_json(paths.registry)["agents"]

    run_extend(
        paths, ExtendRequest(name="glass-atrium-dev-fixture", add_domain="probes")
    )
    row = load_json(paths.registry)["agents"]["glass-atrium-dev-fixture"]
    assert row["domains"] == ["fixtures", "probes"]
