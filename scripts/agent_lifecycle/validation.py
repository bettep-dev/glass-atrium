"""<name> input validation + realpath-inside-agents assertion (SEC-4 / dev-note 2).

Responsibilities:
    Reject any agent name that is not a safe charset token, prove a composed
    agents/<name>.md path resolves to a real location INSIDE the GA agents/ dir
    before any caller composes a path or hands the name to a subprocess, and
    read every operator-supplied text file through one gated reader. The first
    two close path-traversal (`../`, `..%2f`) and symlink-boundary-escape reach;
    the third keeps ADD's --body-file and EXTEND's --append-section on the same
    exists / non-empty / secret-scan floor.

These guards MUST run before path composition / subprocess in every action
handler — they are the single chokepoint, not a per-call afterthought.
"""

from __future__ import annotations

import re
from pathlib import Path

from .secret_scan import scan_for_secrets

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


def read_gated_text(path: Path, *, label: str) -> str:
    """Read an operator-supplied text file through the gates every entry shares.

    exists -> non-empty -> fail-closed secret scan, in that order. Both text
    inputs that reach the store (ADD's --body-file, EXTEND's --append-section)
    call this, so neither can drift onto a weaker floor than the other. `label`
    names the originating flag so the refusal points at the operator's own
    argument. Raises ValidationError (missing / unreadable / empty) or SecretDetected.
    """
    if not path.exists():
        raise ValidationError(f"{label} not found: {path}")
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        # A directory argument (IsADirectoryError) or a non-UTF-8 file passes exists()
        # and escapes read_text as a BUILTIN no caller's except tuple names — an exit-1
        # traceback where the contract promises the named HALT. Re-raised as the shared
        # refusal type so both entry points keep their mapping without widening it.
        raise ValidationError(f"{label} is not readable UTF-8 text: {path}") from exc
    if not raw.strip():
        raise ValidationError(f"{label} is empty: {path}")
    # scanned before any structural gate — a credential must never reach the
    # store even transiently, whatever the structural verdict turns out to be.
    scan_for_secrets(raw)
    return raw
