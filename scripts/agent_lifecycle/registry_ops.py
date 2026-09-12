"""Registry mutations: ADD a new entry · ADDITIVE extend · VALUE-MUTATION HALT.

Responsibilities:
    Build a new registry agent entry (with `origin` and the `rules` membership
    object) and write it via the atomic safe-write; append an ADDITIVE domains
    token, a nested `rules.shared` rule file, or a body section to an EXISTING
    agent without changing any existing value (§2.2 approved EXTENSION); and
    HARD-HALT any attempt to change or delete an existing value (AC6 VALUE
    MUTATION). Each additive op returns its own reverse-op, and the reverse-op
    for ADD (remove the row) is provided, so the transaction can roll back.

The registry row is where per-agent rule membership lives, now that the body
`> Rules:` header is retired. DEV-vs-not still comes from the scope-dev.md
roster (its real SoT) — `rules.scope` records which Tier-2 file governs the
agent, not whether it is a DEV.

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
    scope: str,
    tools: list[str] | None = None,
    phase: str = "implementation",
) -> dict[str, Any]:  # Any: entry holds str/list/bool fields
    """Assemble a new registry entry dict including `origin` and `rules`.

    Field order mirrors the house entries (domains first, then tools, phase,
    dual_phase, origin) with `rules` last. `scope` is not persisted as a field of
    its own — DEV membership is sourced from the scope-dev.md roster (its real
    SoT); it is consumed here only to derive the `rules` defaults. tools defaults
    to the standard DEV tool grant when not supplied.
    """
    return {
        "domains": list(domains),
        "tools": list(tools)
        if tools is not None
        else ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
        "phase": phase,
        "dual_phase": True,
        "origin": origin,
        "rules": get_rules_for_scope(scope),
    }


# --- rule membership vocabulary (core-compliance-matrix.md is the AUTHORING
# input for these values; nothing here is a runtime rule selector) -----------

# A rule token is the repo-relative path of the rule file, because the two rule
# roots do not share one: most live under scoped/, the orchestrator pair and
# shared-self-improve-hygiene.md under rules/glass-atrium/. A bare stem would
# leave every consumer guessing which root to try.
_SCOPED = "scoped/"
_GA_RULES = "rules/glass-atrium/"

# Tier-2: exactly one scope file governs an agent. ORCHESTRATOR is absent by
# carve-out — the main session is not a registry agent, so no row may carry
# scope-orchestrator.md and its membership stays stated in the matrix alone.
SCOPE_RULE_FILES: dict[str, str] = {
    "DEV": f"{_SCOPED}scope-dev.md",
    "META": f"{_SCOPED}scope-meta.md",
    "DESIGN": f"{_SCOPED}scope-design.md",
    "RESEARCH": f"{_SCOPED}scope-research.md",
    "PLANNING": f"{_SCOPED}scope-planning.md",
    "REPORT": f"{_SCOPED}scope-report.md",
    "QA": f"{_SCOPED}scope-qa.md",
    "SECURITY": f"{_SCOPED}scope-security.md",
    "WIKI": f"{_SCOPED}scope-wiki.md",
}

# Tier-3 files binding UNCONDITIONALLY at the scope level. Scopes absent here
# take none.
SCOPE_SHARED_RULE_FILES: dict[str, tuple[str, ...]] = {
    "DEV": (
        f"{_SCOPED}shared-comment-logging.md",
        f"{_SCOPED}shared-performance.md",
        f"{_SCOPED}shared-search-first.md",
        f"{_SCOPED}shared-testing.md",
        f"{_SCOPED}shared-type-safety.md",
        f"{_SCOPED}shared-code-structure.md",
        f"{_SCOPED}shared-investigation-discipline.md",
        f"{_SCOPED}shared-naming.md",
    ),
    "META": (f"{_SCOPED}shared-authoring-hygiene.md",),
    "PLANNING": (f"{_SCOPED}shared-authoring-hygiene.md",),
    "REPORT": (f"{_SCOPED}shared-authoring-hygiene.md",),
    "QA": (
        f"{_SCOPED}shared-comment-logging.md",
        f"{_SCOPED}shared-investigation-discipline.md",
    ),
}

# Tier-3 files binding only when the TASK meets the stated condition — NOT
# standing membership, which is why each entry carries its `when` rather than
# sitting in `shared`. A consumer reads the list as "applies when this holds",
# so an agent listing one is not thereby governed by it.
_HYGIENE_CONDITION = {
    "file": f"{_GA_RULES}shared-self-improve-hygiene.md",
    "when": (
        "the change scope includes ~/.glass-atrium/autoagent/ paths or the "
        "self-improvement launchd configuration"
    ),
}
_HOOK_AUTHORING_CONDITION = {
    "file": f"{_SCOPED}shared-hook-capability-contract.md",
    "when": "the task writes or modifies a hook under ~/.glass-atrium/hooks/",
}
_HOOK_REVIEW_CONDITION = {
    "file": f"{_SCOPED}shared-hook-capability-contract.md",
    "when": "the task reviews a hook change or analyses a hook failure",
}
SCOPE_CONDITIONAL_RULES: dict[str, tuple[dict[str, str], ...]] = {
    "DEV": (_HYGIENE_CONDITION, _HOOK_AUTHORING_CONDITION),
    "QA": (_HOOK_REVIEW_CONDITION,),
}

# The closed file set a registry row may cite. shared-design-token-consumption
# appears only here: it binds the UI-emitting DEV subset unconditionally, which
# is a per-AGENT fact no scope-level default can derive, so it is added by hand.
# shared-code-structure.md and shared-naming.md also bind glass-atrium-qa-code-
# reviewer alone within QA — likewise hand-added per agent, but already in this
# set through the DEV defaults, so they need no entry of their own.
RULE_FILES: frozenset[str] = frozenset(
    set(SCOPE_RULE_FILES.values())
    | {f for files in SCOPE_SHARED_RULE_FILES.values() for f in files}
    | {c["file"] for rules in SCOPE_CONDITIONAL_RULES.values() for c in rules}
    | {f"{_SCOPED}shared-design-token-consumption.md"}
)


def get_rules_for_scope(scope: str) -> dict[str, Any]:  # Any: str | list values
    """Return the scope-level `rules` defaults for a newly ADDed agent.

    Defaults, not a derivation of truth: three documented per-AGENT divergences
    cannot be read off a scope label — the UI-emitting DEV subset that also takes
    shared-design-token-consumption.md, glass-atrium-meta-prompt-engineer taking
    the 5 original cross-cutting DEV Tier-3 files its META sibling does not, and
    glass-atrium-qa-code-reviewer taking shared-code-structure.md and
    shared-naming.md that its QA sibling does not. Each is corrected by
    appending the missing file with add_shared_rule_file — additively, since both
    divergences ADD to the scope defaults rather than contradicting them. The
    write surface is ADD / remove / additive domains append / additive
    rules.shared append; no op rewrites an existing value.

    Raises RegistryMutationError on an unknown scope — a silent empty default
    would ship an agent claiming membership in nothing.
    """
    key = scope.strip().upper()
    scope_file = SCOPE_RULE_FILES.get(key)
    if scope_file is None:
        known = ", ".join(sorted(SCOPE_RULE_FILES))
        raise RegistryMutationError(
            f"unknown scope {scope!r} — no Tier-2 rule file to record; known: {known}"
        )
    return {
        "scope": scope_file,
        "shared": list(SCOPE_SHARED_RULE_FILES.get(key, ())),
        "conditional": [dict(c) for c in SCOPE_CONDITIONAL_RULES.get(key, ())],
    }


def assert_rule_files_known(entry: dict[str, Any]) -> None:  # Any: entry fields vary
    """HALT when `entry`'s `rules` object cites a file outside RULE_FILES.

    The write-side home of the vocabulary check: a cited rule file is only useful
    if every consumer can resolve it, so a typo that would resolve to nothing is
    refused at the registry boundary rather than found by whichever consumer
    reads it first. An entry with no `rules` object passes (pre-backfill rows).
    """
    rules = entry.get("rules")
    if rules is None:
        return
    if not isinstance(rules, dict):
        raise RegistryMutationError(
            f"`rules` must be an object, got {type(rules).__name__} — HALT"
        )
    cited: list[str] = []
    scope_file = rules.get("scope")
    if scope_file is not None:
        cited.append(scope_file)
    shared = rules.get("shared", [])
    if not isinstance(shared, list):
        raise RegistryMutationError(
            f"`rules.shared` must be a list, got {type(shared).__name__} — HALT"
        )
    cited.extend(shared)
    conditional = rules.get("conditional", [])
    if not isinstance(conditional, list):
        raise RegistryMutationError(
            f"`rules.conditional` must be a list, got {type(conditional).__name__} — HALT"
        )
    for item in conditional:
        # the `when` is what separates a conditional from standing membership —
        # an entry without one is indistinguishable from a `shared` row.
        if not isinstance(item, dict) or not item.get("file") or not item.get("when"):
            raise RegistryMutationError(
                f"`rules.conditional` entry {item!r} needs both `file` and `when` — HALT"
            )
        cited.append(item["file"])
    unknown = sorted({f for f in cited if f not in RULE_FILES})
    if unknown:
        raise RegistryMutationError(
            f"unknown rule file(s) {unknown} — not a known scope/shared rule file; HALT"
        )


def add_entry(
    paths: StorePaths, name: str, entry: dict[str, Any]
) -> None:  # Any: entry value types vary
    """Insert a new agent row, atomically (temp + re-parse + os.replace).

    Raises RegistryMutationError when `name` already exists (clobber guard — the
    ADD pre-flight asserts absence, this is defense in depth), when the entry
    cites an unknown rule file, or when the write fails.
    """
    registry = load_json(paths.registry)
    if not isinstance(registry, dict) or not isinstance(registry.get("agents"), dict):
        raise RegistryMutationError(f"{paths.registry} has no top-level agents dict")
    if name in registry["agents"]:
        raise RegistryMutationError(
            f"registry already has an entry for {name!r} — refusing to clobber"
        )
    assert_rule_files_known(entry)
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


def add_shared_rule_file(
    paths: StorePaths, name: str, rule_file: str
) -> Callable[[], None]:
    """ADDITIVE extend: append `rule_file` to an existing agent's rules.shared.

    The correction path for the per-AGENT divergences get_rules_for_scope cannot
    derive from a scope label (the UI-emitting DEV subset's design-token file,
    glass-atrium-meta-prompt-engineer's 5 DEV Tier-3 files). Additive by the same
    §2.2 rule as add_domain_token: existing files keep their order, only a new
    one is appended, and a file already present is a no-op. The RESULTING entry
    goes through assert_rule_files_known, so a path no consumer could resolve is
    refused before the write rather than stored. Returns a reverse-op closure
    (removes the file IFF this call appended it). Raises RegistryMutationError
    when the agent, its `rules` object, or its shared list is absent.
    """
    agents = load_registry_agents(paths)
    if name not in agents:
        raise RegistryMutationError(f"no registry entry for {name!r} to extend")
    entry = agents[name]
    rules = entry.get("rules")
    if not isinstance(rules, dict) or not isinstance(rules.get("shared"), list):
        raise RegistryMutationError(
            f"{name!r} has no rules.shared list — cannot additively extend"
        )
    shared = rules["shared"]
    if rule_file in shared:
        # already present — no value changes, no-op reverse-op
        return lambda: None

    appended = [*shared, rule_file]
    assert_rule_files_known({**entry, "rules": {**rules, "shared": appended}})

    registry = load_json(paths.registry)
    registry["agents"][name]["rules"]["shared"] = appended
    atomic_write_json(paths.registry, registry, validate=has_agents_dict)

    def _undo() -> None:
        reg = load_json(paths.registry)
        cur = reg["agents"][name]["rules"]["shared"]
        reg["agents"][name]["rules"]["shared"] = [f for f in cur if f != rule_file]
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
