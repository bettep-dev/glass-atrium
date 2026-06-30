"""agents/<name>.md scaffold body + ADD pre-flight absence checks (§3.4).

Responsibilities:
    Render the minimal agent .md scaffold (frontmatter + the `> Rules:` header
    that is the Tier-2 scope-load anchor) and assert every ADD target location
    is ABSENT before any write (clobber guard — a clean-tree re-run is a no-op,
    one pre-existing location HALTs). The body is intentionally minimal: the CLI
    creates a routable, rule-loading stub; prompt-content authoring is out of
    scope (F1 territory).

The `> Rules:` header is load-bearing: inject-scope-rules.sh and the Tier-2
loader key on `(ALL + <SCOPE>)` to attach the scope rules, so a scaffold without
it is a spawnable-but-rule-less orphan.
"""

from __future__ import annotations

import re

from .paths import StorePaths
from .readers import load_registry_agents
from .validation import ValidationError

# Matches a `> Rules: ... (ALL + <SCOPE>)` anchor line and captures <SCOPE>. The
# Tier-2 loader keys on this, so an authored body must carry the RIGHT scope (a
# wrong-scope anchor mis-loads rules — worse than absent, so it HALTs not injects).
_ANCHOR_RE = re.compile(
    r"^>\s*Rules:\s*GLOBAL_RULES\.md\s*\(ALL\s*\+\s*(?P<scope>[^)]*?)\s*\)",
    re.MULTILINE,
)

# Frontmatter-shaped key lines an authored body must NOT carry ABOVE the anchor.
# These shadow the canonical frontmatter (tools allowlist, name, scope, maxTurns)
# — a body that injects its own escalates privilege if the loader picks the LAST
# block. Matched at line start (allowing leading whitespace) so only a real
# YAML-key line trips it; the same word appearing inside prose below the anchor
# is intentionally NOT matched (the gate slices on the anchor position).
_FRONTMATTER_KEY_RE = re.compile(
    r"^[ \t]*(name|tools|scope|maxTurns)[ \t]*:",
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


class PreflightError(RuntimeError):
    """An ADD target location already exists — HALT to avoid clobbering."""


class BodyAnchorError(ValueError):
    """The authored body carries a `> Rules:` anchor for the WRONG scope — HALT.

    A wrong-scope anchor mis-attaches Tier-2 rules (worse than an absent one,
    which can be injected). Distinct from ValidationError so the CLI can map it
    to the same EXIT_HALT path with a body-specific message.
    """


class BodyFrontmatterError(ValueError):
    """The authored body smuggles a frontmatter-shaped block — fail-closed HALT.

    The canonical frontmatter (with the FIXED `tools:` allowlist) is emitted
    first; a body that begins with its own `---` fence, or that carries a
    `name:` / `tools:` / `scope:` / `maxTurns:` key line ABOVE the `> Rules:`
    anchor, would produce a second frontmatter block. Whether it escalates
    depends on the loader's first-vs-last-wins rule, so the boundary is made
    EXPLICIT here rather than left positional/loader-dependent (OWASP LLM06 /
    A01). Distinct from ValidationError/BodyAnchorError so the CLI maps it to
    the same EXIT_HALT path with a vector-specific message.
    """


def rules_anchor_line(scope: str) -> str:
    """The load-bearing `> Rules:` header line for `scope` (the Tier-2 anchor)."""
    return f"> Rules: GLOBAL_RULES.md (ALL + {scope})"


def render_agent_md(
    *,
    name: str,
    scope: str,
    domains: list[str],
    description: str | None = None,
    body: str | None = None,
    model: str | None = None,
) -> str:
    """Render a rule-loading agent .md scaffold (frontmatter + Rules header + body).

    The frontmatter carries name + description + the standard tool grant; the
    `> Rules:` header is the scope-load anchor (`ALL + <SCOPE>`). domains are
    recorded in a comment so the file is self-documenting without duplicating
    the registry (the registry remains the routing SoT).

    `body` ABSENT renders the minimal scaffold stub (byte-identical to the
    historical output — a backward-compat invariant). `body` PRESENT places the
    authored markdown as the agent body, BELOW the `> Rules:` anchor and AFTER
    the frontmatter `description` (the two stay distinct — the body is the prompt
    content, the description is the routing blurb; no duplication).

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
        f"{rules_anchor_line(scope)}\n"
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
    # authored body: single trailing newline, anchor already emitted above.
    rendered = frontmatter + f"{body.rstrip()}\n"
    _assert_single_frontmatter_block(rendered, name=name)
    return rendered


def _assert_single_frontmatter_block(rendered: str, *, name: str) -> None:
    """Defense-in-depth: assert the rendered .md carries ONLY the canonical block.

    The input gate (assert_body_no_smuggled_frontmatter) rejects a smuggled body
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


def assert_body_no_smuggled_frontmatter(body: str) -> None:
    """Input gate: HALT a body that smuggles a frontmatter-shaped block.

    Rejects (fail-closed, BodyFrontmatterError) an authored body that either
      - begins with a `---` frontmatter fence (after lstrip), OR
      - carries a `name:` / `tools:` / `scope:` / `maxTurns:` key line BEFORE the
        `> Rules:` anchor (a frontmatter-shaped declaration shadowing the
        canonical block).
    These tokens are TOLERATED below the anchor as ordinary body prose — the risk
    is a frontmatter block above/instead of the canonical one, not the word
    "tools" in a sentence in the body. When the body carries no anchor, the whole
    body is treated as the pre-anchor head (render_agent_md injects the canonical
    anchor ABOVE the body, so any frontmatter key in the body would still land
    above the agent's real content and shadow the canonical block).
    """
    if _FENCE_RE.match(body.lstrip()):
        raise BodyFrontmatterError(
            "authored body begins with a `---` frontmatter fence — a body must "
            "not carry its own frontmatter (it would shadow the canonical block "
            "with its FIXED tools allowlist); remove the leading `---` block; HALT"
        )
    anchor = _ANCHOR_RE.search(body)
    head = body[: anchor.start()] if anchor is not None else body
    key_match = _FRONTMATTER_KEY_RE.search(head)
    if key_match is not None:
        key = key_match.group(1)
        raise BodyFrontmatterError(
            f"authored body carries a frontmatter-shaped {key!r}: line before the "
            "`> Rules:` anchor — such a key shadows the canonical frontmatter; "
            f"move it below the anchor or remove it (the canonical {key} is fixed); HALT"
        )


def reconcile_body_anchor(body: str, scope: str) -> str:
    """Return `body` guaranteed to yield the canonical `> Rules:` anchor for `scope`.

    The anchor is load-bearing — without it the spawned agent loads no Tier-2
    rules (a rule-less orphan). Three cases:
      - body has NO anchor   -> return body unchanged; render_agent_md injects the
        canonical anchor above it (INJECT path).
      - body has a MATCHING-scope anchor -> strip that line so render_agent_md emits
        exactly one canonical anchor (no duplicate).
      - body has a WRONG-scope anchor -> HALT (BodyAnchorError); silently rewriting
        an operator-authored scope would mask a real mismatch.
    Scope comparison is case-insensitive, trimmed (the canonical token is upper).
    """
    match = _ANCHOR_RE.search(body)
    if match is None:
        return body
    found = match.group("scope").strip()
    if found.upper() != scope.strip().upper():
        raise BodyAnchorError(
            f"body `> Rules:` anchor scope {found!r} does not match --scope "
            f"{scope!r} — HALT (a wrong-scope anchor mis-loads Tier-2 rules)"
        )
    # matching scope: drop the authored anchor line; render_agent_md re-emits the
    # single canonical one. Splicing on the matched span keeps the rest verbatim.
    start, end = match.span()
    line_end = body.find("\n", end)
    cut_to = len(body) if line_end == -1 else line_end + 1
    return body[:start] + body[cut_to:]


def assert_add_targets_absent(paths: StorePaths, name: str, *, is_dev: bool) -> None:
    """Assert the 3-4 ADD target locations are all absent before writing (§3.4).

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
