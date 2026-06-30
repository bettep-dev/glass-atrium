"""<name> input validation + realpath-inside-agents assertion (SEC-4 / dev-note 2).

Responsibilities:
    Reject any agent name that is not a safe charset token, and prove a composed
    agents/<name>.md path resolves to a real location INSIDE the GA agents/ dir
    before any caller composes a path or hands the name to a subprocess. This
    closes path-traversal (`../`, `..%2f`) and symlink-boundary-escape reach.

These guards MUST run before path composition / subprocess in every action
handler — they are the single chokepoint, not a per-call afterthought.
"""

from __future__ import annotations

import re
from pathlib import Path

# Safe agent-name charset — lowercase alphanumerics + hyphen only. No dot, no
# slash, no percent, so `../x`, `..%2f`, and `a.md` are all rejected at the gate.
NAME_RE = re.compile(r"^[a-z0-9-]+$")


class ValidationError(ValueError):
    """A name or composed path failed a safety gate — the caller MUST HALT."""


def validate_name(name: str) -> str:
    """Return `name` unchanged when it matches the safe charset, else HALT.

    Empty, leading/trailing hyphen, and any traversal metacharacter are
    rejected. Returning the value lets callers write `name = validate_name(raw)`.
    """
    if not name:
        raise ValidationError("agent name is empty")
    if not NAME_RE.match(name):
        raise ValidationError(
            f"agent name {name!r} is not a safe token (allowed charset: ^[a-z0-9-]+$)"
        )
    # A bare hyphen run or hyphen-only token passes the charset but is not a
    # real agent name — reject leading/trailing hyphen for greppability.
    if name.startswith("-") or name.endswith("-"):
        raise ValidationError(
            f"agent name {name!r} must not start or end with a hyphen"
        )
    return name


def assert_inside_agents(agents_dir: Path, candidate: Path) -> Path:
    """Resolve `candidate` and assert its real path is inside `agents_dir`.

    Returns the resolved real path on success. Raises ValidationError when the
    resolved path escapes the agents/ dir (traversal or a symlink that points
    outside). The agents_dir itself is resolved first so the comparison holds
    even when the GA root is reached through a symlink (e.g. a temp fixture).
    """
    base = agents_dir.resolve()
    # resolve(strict=False) follows existing symlink components but does not
    # require the leaf to exist — ADD composes a not-yet-written path.
    real = candidate.resolve()
    if real != base and base not in real.parents:
        raise ValidationError(
            f"composed path {candidate} resolves to {real}, which is outside {base}"
        )
    return real


def validated_agent_md(agents_dir: Path, name: str) -> Path:
    """Validate `name` then compose + assert agents/<name>.md is inside agents/.

    The single safe entry point a handler calls before touching agents/<name>.md.
    """
    safe = validate_name(name)
    candidate = agents_dir / f"{safe}.md"
    assert_inside_agents(agents_dir, candidate)
    return candidate
