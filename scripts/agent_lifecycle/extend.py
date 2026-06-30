"""EXTEND handler — ADDITIVE-only extend of an existing agent (AC6 / §2.2).

Responsibilities:
    Apply the §2.2-approved ADDITIVE EXTENSION to an existing agent: append a
    new entry to its registry `domains` array, OR append a section to its body
    .md — WITHOUT changing or removing any existing value. A VALUE MUTATION
    (changing/removing an existing value) HALTs (AC6). At least one additive op
    must be requested; an empty extend is refused.

The domains append reuses registry_ops.add_domain_token (atomic, idempotent,
value-immutable). The body append writes the new section after the existing
content (append-only), via the atomic text writer; the existing body bytes are
never rewritten, only extended. EXTEND is gated through the same <name>
validation + realpath-inside-agents chokepoint as ADD.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .paths import StorePaths
from .readers import load_registry_agents
from .registry_ops import RegistryMutationError, add_domain_token
from .stanza import atomic_write_text
from .transaction import RollbackFailedError, Transaction, TransactionError
from .validation import validated_agent_md


class ExtendRefused(RuntimeError):
    """The EXTEND was refused (no additive op, missing agent, or VALUE MUTATION)."""


@dataclass(frozen=True)
class ExtendRequest:
    """Inputs for one ADDITIVE extend (at least one additive op required)."""

    name: str
    add_domain: str | None = None
    append_section_file: Path | None = None


def run_extend(paths: StorePaths, req: ExtendRequest) -> str:
    """Execute the additive extend; return a one-line summary. Raises ExtendRefused.

    Performs the domains append and/or the body-section append INSIDE the Wave-1
    Transaction framework, so a mid-extend multi-op failure rolls back coherently
    (the domains-token reverse-op closure add_domain_token returns is registered
    as the step undo, not discarded). Each op is purely additive — an existing
    value is never changed or removed (a request that would mutate is refused).
    Idempotent ops (entry already present) are reported as no-ops. Raises
    TransactionError on a forward-step failure (rolled back cleanly) and
    RollbackFailedError on a reverse-op failure (recovery marker written).
    """
    # validate name + realpath-inside-agents BEFORE any path composition.
    md_path = validated_agent_md(paths.agents_dir, req.name)

    if req.add_domain is None and req.append_section_file is None:
        raise ExtendRefused(
            "extend requires at least one additive op (--add-domain or --append-section)"
        )

    agents = load_registry_agents(paths)
    if req.name not in agents:
        raise ExtendRefused(f"no registry entry for {req.name!r} to extend")

    # Pre-flight both ops BEFORE the transaction opens — a refusal must leave zero
    # writes (an empty/missing-input op should never trash a half-applied state).
    new_domain: str | None = None
    if req.add_domain is not None:
        new_domain = req.add_domain.strip()
        if not new_domain:
            raise ExtendRefused("--add-domain value is empty")
    section: Path | None = None
    new_section = ""
    if req.append_section_file is not None:
        section = Path(req.append_section_file)
        if not section.exists():
            raise ExtendRefused(f"--append-section file not found: {section}")
        if not md_path.exists():
            raise ExtendRefused(f"agents/{req.name}.md not found — cannot append")
        new_section = section.read_text(encoding="utf-8")

    before_domains = list(agents[req.name].get("domains") or [])
    applied: list[str] = []
    tx = Transaction(name=f"extend:{req.name}", marker_dir=paths.ga_root)

    # --- additive op 1: append a domains entry (value-immutable, idempotent) ---
    if new_domain is not None:
        # add_domain_token returns the reverse-op closure (removes the token IFF
        # this call added it; a no-op closure when already present). Capture it
        # from inside the forward `do` so the transaction can replay it on undo.
        undo_box: list[Callable[[], None]] = []

        def _domain_do() -> None:
            try:
                undo_box.append(add_domain_token(paths, req.name, new_domain))
            except RegistryMutationError as exc:
                raise ExtendRefused(str(exc)) from exc

        def _domain_undo() -> None:
            if undo_box:
                undo_box[0]()

        tx.run("domains append", do=_domain_do, undo=_domain_undo)
        if new_domain in before_domains:
            applied.append(f"domains entry {new_domain!r} already present (no-op)")
        else:
            applied.append(f"appended domains entry {new_domain!r}")

    # --- additive op 2: append a body section (append-only, existing bytes kept) ---
    if section is not None:
        existing = md_path.read_text(encoding="utf-8")
        # append-only: existing content is preserved verbatim, new section follows.
        separator = "" if existing.endswith("\n") else "\n"
        combined = f"{existing}{separator}\n{new_section.rstrip()}\n"

        def _section_do() -> None:
            atomic_write_text(md_path, combined)

        def _section_undo() -> None:
            # restore the pre-append bytes verbatim (atomic) — the body is the
            # only step that rewrites file content, so its undo is a full restore.
            atomic_write_text(md_path, existing)

        tx.run("body section append", do=_section_do, undo=_section_undo)
        applied.append(f"appended body section from {section.name}")

    return f"extended {req.name}: " + "; ".join(applied)


__all__ = [
    "ExtendRefused",
    "ExtendRequest",
    "RollbackFailedError",
    "TransactionError",
    "run_extend",
]
