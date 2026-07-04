"""ADD handler — R1 gate -> derived-chain atomic transaction (AC0a/AC0b/AC1/AC8).

Responsibilities:
    Drive the full ADD flow: validate <name> + assert realpath-inside-agents,
    run the R1 split gate (Q3 self-computed + Q1/Q2 attestation), pre-flight
    every target absent, then run the derived-chain transaction via the Wave-1
    Transaction framework:
        1. write agents/<name>.md       (undo: mv ~/.Trash — source file, no rm)
        2. git add                       (undo: git reset HEAD)
        3. DEV only: scope-dev stanza    (undo: remove the name)
        4. registry entry add            (undo: remove the row, atomic)
        5. generate-manifest.sh          (undo: regenerate from prior git state)
        6. glass-atrium agents-only swap (undo: re-run swap)
    A forward-step failure rolls back in reverse; a rollback-step failure STOPS,
    writes a recovery marker, and hands off (no 'orphan 0' claim) — the B5
    failed-rollback branch, all owned by the Transaction.

This handler performs the live store I/O, but the disposable test suite points
StorePaths at a temp fixture so no live tree is ever written. The CLI never runs
a live ADD without an explicit gate verdict.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, replace
from pathlib import Path

from . import gate_roster_sync
from .db_utils import resolve_model_for_scope
from .gate import GateVerdict, evaluate_gate
from .lock import mutation_lock
from .paths import StorePaths, trash_path
from .readers import registry_domains
from .registry_ops import add_entry, build_entry, remove_entry
from .scaffold import (
    PreflightError,
    assert_add_targets_absent,
    normalize_agent_name,
    render_agent_md,
    require_dev_scope_for_stanza,
)
from .stanza import atomic_write_text, insert_name_in_text, remove_name_in_text
from .subproc import git_add, git_unstage, regenerate_manifest, swap_symlinks
from .transaction import RollbackFailedError, Transaction, TransactionError
from .validation import validated_agent_md


class AddRefused(RuntimeError):
    """The ADD was refused before any write (gate fail or pre-flight clobber)."""


@dataclass(frozen=True)
class AddRequest:
    """Inputs for one ADD operation (validated by the caller / CLI)."""

    name: str
    scope: str
    origin: str
    domains: list[str]
    q1_verdict: str | None
    q2_verdict: str | None
    description: str | None = None
    # Authored agent body (from --body-file). None => the minimal scaffold stub
    # is rendered (backward-compat, byte-identical). When set, the CLI has
    # already non-empty-validated it, reconciled the `> Rules:` anchor, and
    # fail-closed secret-scanned it (the CLI boundary owns those gates).
    body_md: str | None = None


def evaluate_add_gate(paths: StorePaths, req: AddRequest) -> GateVerdict:
    """Run the R1 split gate for `req` against the live (or fixture) registry."""
    existing = registry_domains(paths)
    return evaluate_gate(
        proposed_domains=req.domains,
        existing_by_name=existing,
        q1_verdict=req.q1_verdict,
        q2_verdict=req.q2_verdict,
    )


def run_add(paths: StorePaths, req: AddRequest) -> str:
    """Execute the gated derived-chain ADD; return a one-line result summary.

    Raises AddRefused (gate/pre-flight, zero writes), TransactionError (a forward
    step failed but rollback was clean), RollbackFailedError (rollback itself
    failed — recovery marker written, reconciliation handed off), or
    MutationLockHeld (a concurrent add/delete holds the single-owner lock).
    """
    # 0. born-prefixed mandate: normalize the fleet prefix BEFORE validation /
    #    path composition so registry, stanza, gate sites, and the .md all carry
    #    the canonical glass-atrium- name (consistent with the paths.py lists).
    req = replace(req, name=normalize_agent_name(req.name))

    # 1. validate name + realpath-inside-agents BEFORE any path composition.
    #    Pure path validation (no store read) — safe outside the lock.
    md_path = validated_agent_md(paths.agents_dir, req.name)
    is_dev = require_dev_scope_for_stanza(req.scope)

    # The mutation lock spans gate -> pre-flight -> transaction as ONE critical
    # section: the pre-flight (targets-absent) and the write must be atomic vs.
    # a concurrent add, else two adds could both pass pre-flight then both write
    # (a TOCTOU clobber). The CLI is the SINGLE lock owner (T1b).
    with mutation_lock(paths):
        return _run_add_locked(paths, req, md_path=md_path, is_dev=is_dev)


def _run_add_locked(
    paths: StorePaths, req: AddRequest, *, md_path: Path, is_dev: bool
) -> str:
    """The locked critical section of run_add — gate, pre-flight, transaction."""
    # 2. R1 gate — zero writes unless allowed.
    verdict = evaluate_add_gate(paths, req)
    if not verdict.allowed:
        raise AddRefused(
            f"R1 gate refused ADD of {req.name!r}: " + "; ".join(verdict.reasons)
        )

    # 3. pre-flight — every target absent (clobber guard).
    try:
        assert_add_targets_absent(paths, req.name, is_dev=is_dev)
    except PreflightError as exc:
        raise AddRefused(str(exc)) from exc

    rel_md = f"agents/{req.name}.md"
    # Auto-resolve the frontmatter `model:` from the monitor DB SAVED TARGET for
    # this scope (DEV -> model.dev, RESEARCH -> model.research; others -> None).
    # Fail-soft: None (DB unreachable / no row / 'inherit') omits the model line.
    model_value = resolve_model_for_scope(req.scope)
    md_text = render_agent_md(
        name=req.name,
        scope=req.scope,
        domains=req.domains,
        description=req.description,
        body=req.body_md,
        model=model_value,
    )
    # `scope` is a roster-routing hint only (decides the DEV stanza + scaffold
    # `> Rules:` header); it is NOT persisted on the registry row.
    entry = build_entry(domains=req.domains, origin=req.origin)

    tx = Transaction(name=f"add:{req.name}", marker_dir=paths.ga_root)

    # Step 1 — write the .md (undo = mv ~/.Trash, never rm).
    def _write_md() -> None:
        md_path.write_text(md_text, encoding="utf-8")

    def _trash_md() -> None:
        if md_path.exists():
            dest = trash_path(req.name, ".al-rollback")
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.replace(md_path, dest)

    tx.run("write .md", do=_write_md, undo=_trash_md)

    # Step 2 — git add (undo = unstage).
    tx.run(
        "git add",
        do=lambda: git_add(paths.ga_root, rel_md),
        undo=lambda: git_unstage(paths.ga_root, rel_md),
    )

    # Step 3 — DEV only: scope-dev roster stanza insert (undo = remove).
    if is_dev:

        def _stanza_insert() -> None:
            text = paths.scope_dev.read_text(encoding="utf-8")
            atomic_write_text(paths.scope_dev, insert_name_in_text(text, req.name))

        def _stanza_remove() -> None:
            text = paths.scope_dev.read_text(encoding="utf-8")
            atomic_write_text(paths.scope_dev, remove_name_in_text(text, req.name))

        tx.run("scope-dev stanza", do=_stanza_insert, undo=_stanza_remove)

    # Step 3b — DEV only: sync the 3 hardcoded gate sites to the now-updated DEV
    # roster. Placed AFTER the scope-dev stanza step so apply() re-reads the
    # just-inserted name. apply() is LOCK-FREE by contract — run_add already holds
    # the single-owner mutation lock and fcntl.flock is per-FD/non-recursive, so a
    # second acquire would self-conflict; the lock lives ONLY at the standalone
    # CLI verb. Undo restores the 3 gate files from their `.bak` (a restore OSError
    # surfaces as the Transaction's RollbackFailedError -> exit 6).
    if is_dev:
        gate_roster_sync.register_gate_roster_tx_step(tx, paths)

    # Step 4 — registry entry add (undo = remove row).
    tx.run(
        "registry entry",
        do=lambda: add_entry(paths, req.name, entry),
        undo=lambda: remove_entry(paths, req.name),
    )

    # Step 5 — manifest regenerate (undo = regenerate again from prior git state).
    tx.run(
        "manifest regenerate",
        do=lambda: regenerate_manifest(paths.generate_manifest, paths.ga_root),
        undo=lambda: regenerate_manifest(paths.generate_manifest, paths.ga_root),
    )

    # Step 6 — symlink swap (undo = re-run swap; the farm rebuilds from the
    # rolled-back manifest, so re-running after step-5 undo reconverges).
    tx.run(
        "symlink swap",
        do=lambda: swap_symlinks(paths.install_script, paths.ga_root),
        undo=lambda: swap_symlinks(paths.install_script, paths.ga_root),
    )

    # dev-note 5: a freshly-ADDed DEV agent stays inject-list-mismatch until the
    # four inject-scope-rules.sh arrays are reconciled — surface it, do not hide
    # it. The reconcile is executable now (skill glass-atrium-ops-reconcile-inject
    # → sync-inject CLI verb), no longer a manual hand-edit. NAMING_AGENTS is the
    # 4th array (narrower roster: DEV − {dev-swift} + qa-code-reviewer); under the
    # HYBRID fix it is auto-reconciled alongside the other three, so the same
    # sync-inject verb covers it.
    note = ""
    if is_dev:
        note = (
            " NOTE: inject-scope-rules.sh INJECT_AGENTS/STYLEREF_AGENTS/"
            "MINIMALISM_AGENTS/NAMING_AGENTS arrays still need this NAME — run skill "
            "glass-atrium-ops-reconcile-inject (orphan-scan will report this)."
        )
    return f"added {req.name} ({req.scope}/{req.origin}); {len(tx.written_labels())} steps committed.{note}"


def dry_run_add(paths: StorePaths, req: AddRequest) -> str:
    """Evaluate the R1 gate + pre-flight WRITE-FREE; return a JSON result string.

    Runs the Q1/Q2 attestation + Q3 overlap gate (so over-broad domains fail fast
    BEFORE any authoring spend) and the targets-absent pre-flight, mutating
    nothing. Request data flows as data (the AddRequest), never as an interpolated
    code string — no code-interpolation surface. Output JSON: {allowed,
    preflight_clear, reasons, q3_conflicts}. No mutation lock is taken — a preview
    must never block on an in-flight mutation.
    """
    # Mirror run_add's pre-write validation WITHOUT entering the transaction —
    # including the born-prefixed normalization, so the dry-run previews the
    # gate + pre-flight against the name the real ADD would actually write.
    req = replace(req, name=normalize_agent_name(req.name))
    validated_agent_md(paths.agents_dir, req.name)
    is_dev = require_dev_scope_for_stanza(req.scope)

    verdict = evaluate_add_gate(paths, req)
    reasons = list(verdict.reasons)

    preflight_clear = True
    try:
        assert_add_targets_absent(paths, req.name, is_dev=is_dev)
    except PreflightError as exc:
        preflight_clear = False
        reasons.append(str(exc))

    out = {
        "allowed": bool(verdict.allowed and preflight_clear),
        "preflight_clear": preflight_clear,
        "reasons": reasons,
        "q3_conflicts": [
            {"a": pair.a, "b": pair.b, "ratio": pair.ratio}
            for pair in verdict.q3_conflicts
        ],
    }
    return json.dumps(out)


__all__ = [
    "AddRefused",
    "AddRequest",
    "dry_run_add",
    "evaluate_add_gate",
    "run_add",
    "RollbackFailedError",
    "TransactionError",
]
