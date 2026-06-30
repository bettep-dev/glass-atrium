"""Registry mutations: ADD a new entry · ADDITIVE extend · VALUE-MUTATION HALT.

Responsibilities:
    Build a new registry agent entry (with `origin`; the registry no longer
    stores a `scope` field — DEV-vs-not is sourced from the scope-dev.md roster)
    and write it via the atomic safe-write; append an ADDITIVE domains token or a
    body section to an EXISTING agent without changing any existing value
    (§2.2 approved EXTENSION); and HARD-HALT any attempt to change or delete an
    existing value (AC6 VALUE MUTATION). The reverse-op for ADD (remove the row)
    is provided so the transaction can roll the registry back.

Every registry write goes through atomic.atomic_write_json (temp + re-parse +
os.replace), and a structure validator asserts the result still has a top-level
`agents` dict before the swap (AC7). Existing entries' field VALUES are never
rewritten by the additive path — only a new token is appended, or a wholly new
row is added.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any  # Any: registry entries are heterogeneous JSON objects

from .atomic import atomic_write_json, has_agents_dict, load_json
from .paths import StorePaths
from .readers import load_registry_agents


class RegistryMutationError(RuntimeError):
    """A registry write was refused (VALUE MUTATION) or failed structurally."""


def build_entry(
    *,
    domains: list[str],
    origin: str,
    tools: list[str] | None = None,
    phase: str = "implementation",
) -> dict[str, Any]:  # Any: entry holds str/list/bool fields
    """Assemble a new registry entry dict including the `origin` field.

    Field order mirrors the house entries (domains first, then tools, phase,
    dual_phase, then origin). The `scope` field is NOT persisted — DEV membership
    is sourced from the scope-dev.md roster (its real SoT). tools defaults to the
    standard DEV tool grant when not supplied.
    """
    return {
        "domains": list(domains),
        "tools": list(tools)
        if tools is not None
        else ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
        "phase": phase,
        "dual_phase": True,
        "origin": origin,
    }


def add_entry(
    paths: StorePaths, name: str, entry: dict[str, Any]
) -> None:  # Any: entry value types vary
    """Insert a new agent row, atomically (temp + re-parse + os.replace).

    Raises RegistryMutationError when `name` already exists (clobber guard — the
    ADD pre-flight asserts absence, this is defense in depth) or the write fails.
    """
    registry = load_json(paths.registry)
    if not isinstance(registry, dict) or not isinstance(registry.get("agents"), dict):
        raise RegistryMutationError(f"{paths.registry} has no top-level agents dict")
    if name in registry["agents"]:
        raise RegistryMutationError(
            f"registry already has an entry for {name!r} — refusing to clobber"
        )
    registry["agents"][name] = entry
    atomic_write_json(paths.registry, registry, validate=has_agents_dict)


def remove_entry(paths: StorePaths, name: str) -> None:
    """Remove an agent row, atomically — the reverse-op for add_entry (rollback).

    Idempotent: removing an absent row is a no-op (rollback must not error when
    the forward step never reached the registry).
    """
    registry = load_json(paths.registry)
    if not isinstance(registry, dict) or not isinstance(registry.get("agents"), dict):
        raise RegistryMutationError(f"{paths.registry} has no top-level agents dict")
    if name not in registry["agents"]:
        return
    del registry["agents"][name]
    atomic_write_json(paths.registry, registry, validate=has_agents_dict)


def add_domain_token(paths: StorePaths, name: str, token: str) -> Callable[[], None]:
    """ADDITIVE extend: append `token` to an existing agent's domains array.

    §2.2-approved ADDITIVE EXTENSION — existing values are IMMUTABLE; only a new
    token is appended. Idempotent: a token already present is a no-op. Returns a
    reverse-op closure (removes the token IFF this call added it) so the caller
    can roll the change back. Raises RegistryMutationError when the agent or its
    domains list is absent.
    """
    agents = load_registry_agents(paths)
    if name not in agents:
        raise RegistryMutationError(f"no registry entry for {name!r} to extend")
    entry = agents[name]
    domains = entry.get("domains")
    if not isinstance(domains, list):
        raise RegistryMutationError(
            f"{name!r} has no domains list — cannot additively extend"
        )
    if token in domains:
        # already present — no value changes, no-op reverse-op
        return lambda: None

    registry = load_json(paths.registry)
    registry["agents"][name]["domains"] = [*domains, token]
    atomic_write_json(paths.registry, registry, validate=has_agents_dict)

    def _undo() -> None:
        reg = load_json(paths.registry)
        cur = reg["agents"][name]["domains"]
        reg["agents"][name]["domains"] = [t for t in cur if t != token]
        atomic_write_json(paths.registry, reg, validate=has_agents_dict)

    return _undo


def assert_no_value_mutation(
    existing_entry: dict[str, Any],  # Any: heterogeneous entry fields
    proposed_entry: dict[str, Any],  # Any: heterogeneous entry fields
) -> None:
    """HALT (AC6) when `proposed_entry` changes or removes any existing value.

    The only permitted delta is PURELY ADDITIVE: a key may gain a new list
    element, or a brand-new key may appear. Any of the following is a VALUE
    MUTATION and raises RegistryMutationError:
      - an existing scalar value changed,
      - an existing list element removed or reordered (existing prefix must be
        preserved; only appends allowed),
      - an existing key dropped.
    """
    for key, old_value in existing_entry.items():
        if key not in proposed_entry:
            raise RegistryMutationError(
                f"VALUE MUTATION: key {key!r} would be removed — HALT (additive only)"
            )
        new_value = proposed_entry[key]
        if isinstance(old_value, list):
            if not isinstance(new_value, list):
                raise RegistryMutationError(
                    f"VALUE MUTATION: {key!r} list replaced by {type(new_value).__name__} — HALT"
                )
            # existing elements must remain, in order, as a prefix (append-only)
            if new_value[: len(old_value)] != old_value:
                raise RegistryMutationError(
                    f"VALUE MUTATION: existing {key!r} elements changed/removed/reordered — HALT"
                )
        elif new_value != old_value:
            raise RegistryMutationError(
                f"VALUE MUTATION: {key!r} value changed {old_value!r} -> {new_value!r} — HALT"
            )
