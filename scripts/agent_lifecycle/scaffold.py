"""agents/<name>.md scaffold body + ADD pre-flight absence checks.

Responsibilities:
    Render the minimal agent .md scaffold (frontmatter + body) and assert every
    ADD target location is ABSENT before any write — clobber guard: a clean-tree
    re-run is a no-op, one pre-existing location HALTs. The body is a routable
    stub; prompt-content authoring is out of scope.

Per-agent rule membership lives on the registry row (`rules`), never in the
body: both authored-text gates REFUSE a `> Rules:` header, so a stale one reused
from an old --body-file cannot be baked into a new agent.

The row is also the delivery input: `hooks/lib/inject_chunk.py` reads it at
SubagentStart, so a created agent receives its `scope` and `shared` bodies, and
its `conditional` entries as path pointers, from the row alone.
"""

from __future__ import annotations

import re

from .paths import StorePaths
from .readers import load_registry_agents
from .validation import ValidationError

# Matches the RETIRED `> Rules: ... (ALL + <SCOPE>)` header line. Membership now
# lives on the registry row, so this pattern exists only to REFUSE the line: an
# operator reusing a pre-retirement --body-file would otherwise bake a stale
# membership claim into a new agent that no consumer reads.
_ANCHOR_RE = re.compile(
    r"^>\s*Rules:\s*GLASS_ATRIUM_GLOBAL_RULES\.md\s*\(ALL\s*\+\s*[^)]*?\s*\)",
    re.MULTILINE,
)

# Frontmatter-shaped key lines an authored body must NOT carry ANYWHERE. These
# shadow the canonical frontmatter (tools allowlist, name, scope, maxTurns) — a
# body that injects its own escalates privilege if the loader picks the LAST
# block. Matched at line start (allowing leading whitespace) so only a real
# YAML-key line trips it; the same word mid-sentence in prose is NOT matched.
#
# The key token is quote-tolerant (`tools:` / `"tools":` / `'tools':`): YAML folds
# a quoted key to the same scalar, so a quote-blind gate reads as a guard the
# attacker can spell around. The backreference forces a BALANCED pair.
# Ceiling (deliberate): an escaped spelling inside a double-quoted key
# (`"\x74ools":`) is still unrecognized here. Reaching it requires the body to
# also form a second `---` block, which _assert_single_frontmatter_block refuses
# on fence count — upgrade path is YAML-unescaping the key token if that fence
# check ever loosens.
_FRONTMATTER_KEY_RE = re.compile(
    r"^[ \t]*(?P<quote>[\"']?)(?P<key>name|tools|scope|maxTurns)(?P=quote)[ \t]*:",
    re.MULTILINE,
)

# A `---` fence line opens/closes a YAML frontmatter block. An authored body that
# begins with one would emit a SECOND `---...---` block alongside the canonical
# one — the privilege-escalation vector (a "last-frontmatter-wins" loader would
# read the smuggled tools/scope). Matched line-anchored under MULTILINE.
_FENCE_RE = re.compile(r"^---[ \t]*$", re.MULTILINE)

# The rendered .md carries exactly the canonical block's open + close (2 fence
# lines). Any additional `---...---` PAIR is a smuggled frontmatter block — so the
# total fence count must stay at the canonical 2 (a lone markdown thematic-break
# `---` would make it odd; a smuggled block makes it 4+, both caught by > 2).
_CANONICAL_FENCE_COUNT = 2


# Fleet name prefix every shipped agent carries post-rename. A newly ADDed
# agent must be BORN prefixed so every prefix-keyed consumer (paths.py
# NON_DEV_BLOCK_LIST, inject_sync/orphan_scan QA+naming frozensets, the
# DEV_SET gate hooks) recognizes it — a bare-name birth would silently fall
# outside all of them.
GA_AGENT_PREFIX = "glass-atrium-"


def normalize_agent_name(name: str) -> str:
    """Return `name` guaranteed to carry the glass-atrium- fleet prefix.

    Idempotent: an already-prefixed name passes through unchanged. An empty
    name also passes through unchanged so downstream validation (NAME_RE)
    still refuses it — normalization must never manufacture a valid name
    out of an invalid one.
    """
    if not name or name.startswith(GA_AGENT_PREFIX):
        return name
    return GA_AGENT_PREFIX + name


class PreflightError(RuntimeError):
    """An ADD target location already exists — HALT to avoid clobbering."""


class BodyAnchorError(ValueError):
    """Supplied text carries the retired `> Rules:` header line — HALT.

    The line is no longer emitted, no longer read, and carries a membership
    claim the registry row now owns, so a body or section bearing one is stale
    input rather than a renderable header — both authored-text gates refuse it
    on either path. Distinct from ValidationError so the CLI can map it to the
    same EXIT_HALT path with a body-specific message.
    """


class BodyFrontmatterError(ValueError):
    """The authored body smuggles a frontmatter-shaped block — fail-closed HALT.

    The canonical frontmatter (with the FIXED `tools:` allowlist) is emitted
    first; a body that begins with its own `---` fence, or that carries a
    `name:` / `tools:` / `scope:` / `maxTurns:` key line at the start of any
    line, would produce a second frontmatter block. Whether it escalates
    depends on the loader's first-vs-last-wins rule, so the boundary is made
    EXPLICIT here rather than left positional/loader-dependent (OWASP LLM06 /
    A01). Distinct from ValidationError/BodyAnchorError so the CLI maps it to
    the same EXIT_HALT path with a vector-specific message.
    """


def render_agent_md(
    *,
    name: str,
    domains: list[str],
    description: str | None = None,
    body: str | None = None,
    model: str | None = None,
) -> str:
    """Render an agent .md scaffold (canonical frontmatter + body).

    The frontmatter carries name + description + the standard tool grant. No
    rule header is emitted: membership lives on the registry row, and `scope`
    reaches this renderer nowhere (it decides the DEV stanza step in add.py and
    the registry `rules` defaults, neither of which is body text).

    `body` ABSENT renders the minimal scaffold stub — byte-identical to the
    historical output apart from the retired `> Rules:` header, deliberately
    re-baselined here rather than discovered later. `body` PRESENT places the
    authored markdown as the agent body, directly below the frontmatter (the
    body is the prompt content, the `description` the routing blurb; the two
    stay distinct, no duplication).

    `model` carries the scope-resolved SAVED TARGET model id (from the monitor
    DB via db_utils.resolve_model_for_scope). When set, a `model: <id>` line is
    emitted immediately after `maxTurns:`. When None — the default, and the value
    used whenever no saved target exists / the DB is unreachable — NO model line
    is emitted and the output is byte-identical to the historical scaffold (the
    agent then inherits its model from settings.json).
    """
    desc = (
        description
        or f"{name} agent (scaffolded by agent-lifecycle; body pending authoring)."
    )
    # Emitted only when a model is resolved; empty string keeps the None path
    # byte-identical to the historical frontmatter (backward-compat invariant).
    model_line = f"model: {model}\n" if model is not None else ""
    frontmatter = (
        "---\n"
        f"name: {name}\n"
        f"description: {desc}\n"
        "tools: [Read, Glob, Grep, Edit, Write, Bash]\n"
        "maxTurns: 40\n"
        f"{model_line}"
        "---\n"
        "\n"
    )
    if body is None:
        # backward-compat: byte-identical to the historical minimal stub.
        domains_line = ", ".join(domains) if domains else "(none)"
        return (
            frontmatter + f"# {name}\n"
            "\n"
            f"Scaffolded agent. Routing domains: {domains_line}.\n"
            "Body authoring is out of scope for the lifecycle scaffold.\n"
        )
    # authored body: single trailing newline, frontmatter already emitted above.
    rendered = frontmatter + f"{body.rstrip()}\n"
    _assert_single_frontmatter_block(rendered, name=name)
    return rendered


def _assert_single_frontmatter_block(rendered: str, *, name: str) -> None:
    """Defense-in-depth: assert the rendered .md carries ONLY the canonical block.

    The input gate (assert_body_no_smuggled_structure) rejects a smuggled body
    at the CLI boundary, but render_agent_md is also reachable directly (e.g. a
    direct run_add). This post-render check catches a second frontmatter however
    the body arrived: the canonical block contributes exactly 2 `---` fence lines,
    so any extra fence (a smuggled `---...---` pair, or even a lone thematic
    break that a last-wins loader could mistake for a block boundary) pushes the
    count past the canonical 2 and HALTs. Fail-closed (BodyFrontmatterError).
    """
    fence_count = len(_FENCE_RE.findall(rendered))
    if fence_count != _CANONICAL_FENCE_COUNT:
        raise BodyFrontmatterError(
            f"rendered agent .md for {name!r} carries {fence_count} `---` fence "
            f"lines (expected exactly {_CANONICAL_FENCE_COUNT} — the single "
            "canonical frontmatter block) — a smuggled second frontmatter block "
            "could shadow the canonical tools allowlist; remove any `---` fence "
            "from the authored body; HALT"
        )


def _assert_no_frontmatter_key(text: str, *, label: str) -> None:
    """HALT when `text` carries a frontmatter-shaped guarded key on any line.

    Shared by both authored-text gates so ADD and EXTEND refuse the identical
    shape: a `--body-file` the ADD gate rejects must not become admissible by
    being handed to `extend --append-section` instead.
    """
    key_match = _FRONTMATTER_KEY_RE.search(text)
    if key_match is None:
        return
    key = key_match.group("key")
    raise BodyFrontmatterError(
        f"{label} carries a frontmatter-shaped {key!r}: line — such a key shadows "
        f"the canonical frontmatter; remove it (the canonical {key} is fixed); HALT"
    )


def _assert_no_retired_anchor(text: str, *, label: str) -> None:
    """HALT when `text` carries the retired `> Rules:` header line.

    Refusal rather than a silent strip: the line states a rule membership the
    registry row now owns, so a body still carrying one was authored against the
    old contract and its claim needs an operator's eyes, not a rewrite.
    """
    if _ANCHOR_RE.search(text):
        raise BodyAnchorError(
            f"{label} carries a retired `> Rules:` header line — per-agent rule "
            "membership lives on the registry `rules` object and no consumer "
            "reads the header; remove the line; HALT"
        )


def assert_body_no_smuggled_structure(body: str) -> None:
    """Input gate: HALT an ADD body carrying structure the frontmatter owns.

    Refuses (fail-closed) an authored body that either
      - begins with a `---` frontmatter fence (a second frontmatter block
        shadowing the canonical one, with its FIXED tools allowlist), OR
      - carries a `name:` / `tools:` / `scope:` / `maxTurns:` key line ANYWHERE,
        in either the bare or a quoted (`"tools":`) spelling, OR
      - carries the retired `> Rules:` header line.

    The key scan covers the WHOLE body deliberately. It used to stop at the
    `> Rules:` anchor and tolerate the same token below it; with the anchor
    retired an anchorless body would have made that slice the whole body anyway
    — i.e. the position-dependent tolerance could no longer be expressed, so the
    strictest of the two former behaviours is the one kept. Measured cost: 0 of
    the 23 live agent bodies carries a line-start guarded key, so nothing
    legitimate is refused today; a future body documenting frontmatter in a
    fenced yaml block WOULD be — a loud HALT naming the key, never silent.
    """
    if _FENCE_RE.match(body.lstrip()):
        raise BodyFrontmatterError(
            "authored body begins with a `---` frontmatter fence — a body must "
            "not carry its own frontmatter (it would shadow the canonical block "
            "with its FIXED tools allowlist); remove the leading `---` block; HALT"
        )
    _assert_no_frontmatter_key(body, label="authored body")
    _assert_no_retired_anchor(body, label="authored body")


def assert_section_no_smuggled_structure(section: str) -> None:
    """Input gate: HALT an EXTEND section that breaks a rendered-.md invariant.

    Holds the EXTEND path at the SAME strength as the ADD gate above — the
    guarded-key scan is shared, so a section cannot smuggle in what a body
    cannot. Two invariants an append can additionally break AFTER render, where
    no render-time assertion runs again:
      - the exactly-2 `---` fence count _assert_single_frontmatter_block pins,
        including a lone thematic break a last-wins loader could read as a
        block boundary;
      - the absence of the retired `> Rules:` header line.
    Fail-closed (BodyFrontmatterError / BodyAnchorError).
    """
    if _FENCE_RE.search(section):
        raise BodyFrontmatterError(
            "appended section carries a `---` fence line — the agent .md must "
            f"keep exactly {_CANONICAL_FENCE_COUNT} fence lines (the single "
            "canonical frontmatter block), and an appended fence could be read "
            "as a second block boundary shadowing the canonical tools "
            "allowlist; remove the `---` line; HALT"
        )
    _assert_no_frontmatter_key(section, label="appended section")
    _assert_no_retired_anchor(section, label="appended section")


def assert_add_targets_absent(paths: StorePaths, name: str, *, is_dev: bool) -> None:
    """Assert the 3-4 ADD target locations are all absent before writing.

    Checks: agents/<name>.md absent · registry entry absent · (DEV only) the
    scope-dev roster does not already list NAME. Any present location raises
    PreflightError. A wholly clean tree passes -> the write proceeds; a re-run on
    an already-added agent HALTs loudly rather than clobbering.
    """
    md_path = paths.agent_md(name)
    if md_path.exists():
        raise PreflightError(f"agents/{name}.md already exists — HALT (clobber guard)")

    try:
        agents = load_registry_agents(paths)
    except Exception as exc:  # noqa: BLE001 — surface any registry read failure as a halt
        raise PreflightError(f"could not read registry for pre-flight: {exc}") from exc
    if name in agents:
        raise PreflightError(f"registry already has {name!r} — HALT (clobber guard)")

    if is_dev:
        from .readers import (
            parse_scope_dev_roster,
        )  # local import: avoids cost for non-DEV

        try:
            roster = parse_scope_dev_roster(paths)
        except Exception as exc:  # noqa: BLE001 — a malformed roster must halt, not pass
            raise PreflightError(f"could not parse scope-dev roster: {exc}") from exc
        if name in roster:
            raise PreflightError(
                f"{name!r} already in scope-dev roster — HALT (clobber guard)"
            )


def require_dev_scope_for_stanza(scope: str) -> bool:
    """Return True when `scope` is DEV (gets the scope-dev stanza step), else False.

    NON-DEV agents skip the stanza step (B4). Scope comparison is case-insensitive
    but the canonical token is upper-case 'DEV'.
    """
    if not scope:
        raise ValidationError("--scope is required for ADD (DEV/META/PLANNING/...)")
    return scope.strip().upper() == "DEV"
