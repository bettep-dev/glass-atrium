"""DELETE handler — origin:user-only policy, fail-closed, hardcoded block list.

Responsibilities:
    Authorize and execute an agent deletion through layered safety gates, in
    order: (1) <name> validation + realpath-inside-agents, (2) the HARDCODED
    NON-DEV block list (a corrupted/absent origin can only ADD restriction,
    never lift the block), (3) the fail-closed precondition (HALT when the
    target row lacks origin), (4) the permission rule `origin == "user"`,
    (5) the `--confirm <typed-name>` hard gate OR `--dry-run`. On a permitted
    delete: back up the registry/manifest rows, move the real .md to ~/.Trash
    (never rm — GLOBAL_RULES), prune the DEV name from the scope-dev.md roster
    (reverse of ADD step-3, DEV only — DEV membership sourced from the
    scope-dev.md roster, its real SoT), then reverse-clean the derived chain via
    the Wave-1 transaction framework so a mid-cleanup failure STOPs with a
    recovery marker rather than leaving an undefined half-deleted state.

The hardcoded block list (paths.NON_DEV_BLOCK_LIST) is a fail-safe-default
backstop the security review requires; with origin:user-only delete, the 11
shipped non-dev names are already non-deletable by origin (origin:shipped), so
the block list is now redundant defense-in-depth — kept for the fail-safe-default
posture, never the sole guard for a core agent's protection.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any  # Any: registry entry is a heterogeneous JSON object

from . import gate_roster_sync
from .atomic import load_json
from .lock import mutation_lock
from .paths import NON_DEV_BLOCK_LIST, StorePaths
from .readers import ReaderError, load_registry_agents, parse_scope_dev_roster
from .registry_ops import add_entry, remove_entry
from .stanza import atomic_write_text, insert_name_in_text, remove_name_in_text
from .subproc import (
    git_add,
    git_unstage,
    prune_farm_symlink,
    regenerate_manifest,
    restore_farm_symlink,
    swap_symlinks,
)
from .transaction import RollbackFailedError, Transaction, TransactionError
from .validation import validated_agent_md


class DeleteRefused(RuntimeError):
    """The DELETE was refused by a safety gate (block list / fail-closed / policy)."""


@dataclass(frozen=True)
class DeleteRequest:
    """Inputs for one DELETE operation (validated by the caller / CLI)."""

    name: str
    confirm: str | None = None
    dry_run: bool = False


@dataclass(frozen=True)
class DeleteAuthorization:
    """The resolved authorization for a candidate delete (why it is/ isn't allowed)."""

    name: str
    allowed: bool
    origin: str | None
    reason: str


def _is_dev_member(paths: StorePaths, name: str) -> bool:
    """True when `name` is in the scope-dev.md roster (its real DEV-membership SoT).

    The registry no longer stores a `scope` field, so the DEV scope-dev.md prune
    step sources membership from the roster directly.

    An EMPTY/absent stanza is a valid "not a member" answer — parse_scope_dev_roster
    returns `[]` for it (no exception), so `name in []` -> False with no catch needed.
    A genuine roster READ/PARSE failure SURFACES as DeleteRefused instead of being
    swallowed into False: a swallowed failure would silently skip the scope-dev.md
    prune and leave the deleted name dangling there (an inconsistent half-deleted
    state). This mirrors scaffold.py's pre-write fail-closed HALT on the same call
    (Precondition Loud-Fail Principle — an unmet precondition must surface, never
    be absorbed). The check runs BEFORE any transaction write, so the HALT is
    zero-writes (EXIT_HALT), consistent with delete's other gates.
    """
    try:
        return name in parse_scope_dev_roster(paths)
    except (ReaderError, OSError, UnicodeDecodeError) as exc:
        raise DeleteRefused(
            f"could not read the scope-dev.md DEV roster to determine membership "
            f"for {name!r}: {exc} — fail-closed HALT (a swallowed read failure would "
            f"skip the roster prune and leave a dangling half-deleted name)"
        ) from exc


def _trash_path(name: str) -> Path:
    """~/.Trash target for the deleted .md (GLOBAL_RULES: source files use mv, not rm)."""
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return Path.home() / ".Trash" / f"{name}.md.al-deleted-{ts}"


def authorize_delete(paths: StorePaths, name: str) -> DeleteAuthorization:
    """Resolve whether `name` may be deleted, applying every safety gate in order.

    Gate order (each independently sufficient to refuse):
      1. HARDCODED block list — NON-DEV names are refused regardless of any
         registry field (fail-safe-default; a corrupted origin cannot lift this).
      2. Membership — the target MUST be a live registry agent.
      3. Fail-closed precondition — origin absent => refuse.
      4. Permission — `origin == "user"` (shipped built-ins are protected).
    """
    # Gate 1 — hardcoded block list FIRST (overrides any corrupt field). With
    # origin:user-only delete the shipped non-dev names are already non-deletable
    # by origin; this stays as a redundant fail-safe-default backstop.
    if name in NON_DEV_BLOCK_LIST:
        return DeleteAuthorization(
            name=name,
            allowed=False,
            origin=None,
            reason=(
                f"{name!r} is on the hardcoded NON-DEV block list — hard-blocked "
                f"regardless of registry origin (fail-safe-default)"
            ),
        )

    agents = load_registry_agents(paths)
    if name not in agents:
        return DeleteAuthorization(
            name=name,
            allowed=False,
            origin=None,
            reason=f"{name!r} is not a live registry agent — nothing to delete",
        )

    entry: dict[str, Any] = agents[name] if isinstance(agents[name], dict) else {}
    origin = entry.get("origin")

    # Gate 3 — fail-closed: origin absent => HALT. Never authorize a delete on a
    # null/defaulted origin field.
    if origin is None:
        return DeleteAuthorization(
            name=name,
            allowed=False,
            origin=origin,
            reason=f"{name!r} lacks origin (origin={origin!r}) — fail-closed HALT",
        )

    # Gate 4 — permission rule: origin:user only. Shipped built-ins (incl. the
    # 12 dev-*) are protected — they are origin:shipped and never deletable.
    allowed = origin == "user"
    if allowed:
        reason = f"permitted (origin={origin})"
    else:
        reason = f"refused: origin={origin} — only origin:user may be deleted"
    return DeleteAuthorization(name=name, allowed=allowed, origin=origin, reason=reason)


def _backup_rows(paths: StorePaths, name: str, entry: dict[str, Any]) -> Path:
    """Snapshot the registry row + manifest agents/ path before edit (reversibility).

    Writes a JSON backup beside the GA root so a permitted 4-location delete is
    recoverable independent of git. Returns the backup path.
    """
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = paths.ga_root / f".agent-lifecycle-delete-backup-{name}-{ts}.json"
    manifest_rel = f"agents/{name}.md"
    manifest = load_json(paths.manifest)
    in_manifest = (
        manifest_rel in manifest.get("files", [])
        if isinstance(manifest, dict)
        else False
    )
    payload = {
        "name": name,
        "timestamp_utc": ts,
        "registry_entry": entry,
        "manifest_path": manifest_rel,
        "manifest_had_path": in_manifest,
        "note": "Restore source for the agent-lifecycle delete (registry row + manifest path).",
    }
    text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    backup.write_text(text, encoding="utf-8")
    return backup


def render_dry_run(paths: StorePaths, auth: DeleteAuthorization) -> str:
    """Render the dry-run report: the 4 targets + the authorization verdict.

    Mutates nothing — shows every location the delete WOULD touch and whether
    the policy permits it, so the operator sees the full surface first.
    """
    md = paths.agent_md(auth.name)
    verdict = "ALLOWED" if auth.allowed else "REFUSED"
    is_dev = _is_dev_member(paths, auth.name)
    lines = [
        f"delete dry-run: {auth.name} -> {verdict}",
        f"  reason: {auth.reason}",
        "  targets (nothing mutated):",
        f"    1. real .md      {md}  -> mv ~/.Trash",
        f"    2. registry row  agents.{auth.name}  (backed up, then removed)",
        "    3. manifest      regenerated from git ls-files (path drops out)",
        f"    4. symlink farm  glass-atrium agents-only swap, then unlink the {auth.name} farm symlink",
    ]
    if is_dev:
        lines.append(
            f"    5. scope-dev.md  roster stanza pruned of {auth.name} (DEV only)"
        )
    lines.append("  (dry-run: no file written)")
    return "\n".join(lines)


def run_delete(paths: StorePaths, req: DeleteRequest) -> str:
    """Execute the gated DELETE; return a one-line summary. Raises DeleteRefused.

    The flow: validate name -> authorize (block list / fail-closed / policy) ->
    dry-run short-circuit -> --confirm hard gate -> back up rows -> mv .md to
    ~/.Trash -> reverse-clean the derived chain (git add, manifest regen, symlink
    swap) inside the Wave-1 transaction so a mid-cleanup failure STOPs with a
    recovery marker. Raises DeleteRefused on any gate; TransactionError /
    RollbackFailedError surface a cleanup failure to the CLI; MutationLockHeld
    when a concurrent add/delete holds the single-owner lock.
    """
    # Gate — <name> validation + realpath-inside-agents BEFORE path composition.
    md_path = validated_agent_md(paths.agents_dir, req.name)

    # dry-run is a pure read+render path — it mutates nothing, so it must NOT
    # take the mutation lock (a preview should never block on an in-flight op).
    if req.dry_run:
        return render_dry_run(paths, authorize_delete(paths, req.name))

    # The mutation lock spans authorization -> confirm -> transaction as ONE
    # critical section vs. a concurrent add/delete (the derived chain — manifest
    # regen + symlink swap — is not concurrency-safe). The CLI is the SINGLE
    # lock owner; the engine is the serialization authority (T1b).
    with mutation_lock(paths):
        return _run_delete_locked(paths, req, md_path=md_path)


def _run_delete_locked(paths: StorePaths, req: DeleteRequest, *, md_path: Path) -> str:
    """The locked critical section of run_delete — authorize, confirm, transaction."""
    auth = authorize_delete(paths, req.name)

    if not auth.allowed:
        raise DeleteRefused(auth.reason)

    # --confirm hard gate — the typed name must match exactly (irreversible step).
    if req.confirm != req.name:
        raise DeleteRefused(
            f"irreversible delete requires --confirm {req.name} (got "
            f"{req.confirm!r}); or use --dry-run to preview"
        )

    agents = load_registry_agents(paths)
    entry = agents.get(req.name, {})
    if not md_path.exists():
        raise DeleteRefused(
            f"agents/{req.name}.md not found at {md_path} — cannot delete (preflight)"
        )

    backup = _backup_rows(paths, req.name, entry if isinstance(entry, dict) else {})
    rel_md = f"agents/{req.name}.md"
    trash_dest = _trash_path(req.name)

    tx = Transaction(name=f"delete:{req.name}", marker_dir=paths.ga_root)

    # Step 1 — move the real .md to ~/.Trash (NOT rm — GLOBAL_RULES File Deletion).
    def _trash_md() -> None:
        trash_dest.parent.mkdir(parents=True, exist_ok=True)
        os.replace(md_path, trash_dest)

    def _restore_md() -> None:
        if trash_dest.exists() and not md_path.exists():
            os.replace(trash_dest, md_path)

    tx.run("trash .md", do=_trash_md, undo=_restore_md)

    # Step 2 — git add the removal (stage the deletion so manifest regen sees it).
    def _git_stage_removal() -> None:
        git_add(paths.ga_root, rel_md)

    def _git_unstage_removal() -> None:
        # `git reset HEAD <rel>` drops the staged removal regardless of whether
        # step-1's _restore_md has run yet — the transaction replays undos in
        # REVERSE, so this fires BEFORE the .md is back from ~/.Trash. A
        # restore-dependent re-add (the prior `if md_path.exists(): git_add`)
        # silently no-op'd here and left the deletion staged (index incoherent
        # with the worktree). A plain unstage is order-independent + symmetric
        # with ADD's git_unstage undo.
        git_unstage(paths.ga_root, rel_md)

    tx.run("git stage removal", do=_git_stage_removal, undo=_git_unstage_removal)

    # Step 2b — DEV only: prune the scope-dev.md roster stanza (reverse of ADD
    # step-3, which inserts the DEV name). Without this the deleted name survives
    # in scope-dev.md, so parse_scope_dev_roster still lists it and the
    # bidirectional sync-inject plan_removes (keyed on that roster) never sees it
    # as stale — the 5 tracked inject arrays would keep the dangling name. Reverse-op
    # re-inserts on rollback. DEV membership sources from the roster itself (the
    # registry no longer stores a scope field).
    is_dev = _is_dev_member(paths, req.name)
    if is_dev:

        def _stanza_remove() -> None:
            text = paths.scope_dev.read_text(encoding="utf-8")
            atomic_write_text(paths.scope_dev, remove_name_in_text(text, req.name))

        def _stanza_reinsert() -> None:
            text = paths.scope_dev.read_text(encoding="utf-8")
            atomic_write_text(paths.scope_dev, insert_name_in_text(text, req.name))

        tx.run("scope-dev stanza prune", do=_stanza_remove, undo=_stanza_reinsert)

        # Step 2c — DEV only: re-sync the 3 hardcoded gate sites to the now-pruned
        # DEV roster (the stanza prune above already dropped the name, so apply()
        # re-reads a roster without it and rebuilds the gate literals minus the
        # deleted name). apply() is LOCK-FREE by contract — run_delete already
        # holds the single-owner mutation lock (fcntl.flock is per-FD/non-recursive,
        # so a second acquire self-conflicts). Undo restores the gate files from
        # their `.bak` (a restore OSError surfaces as RollbackFailedError -> exit 6).
        gate_roster_sync.register_gate_roster_tx_step(tx, paths)

    # Step 3 — remove the registry row (atomic; reverse re-adds from the backup).
    def _remove_row() -> None:
        remove_entry(paths, req.name)

    def _restore_row() -> None:
        if isinstance(entry, dict):
            current = load_registry_agents(paths)
            if req.name not in current:
                add_entry(paths, req.name, entry)

    tx.run("remove registry row", do=_remove_row, undo=_restore_row)

    # Step 4 — regenerate manifest from git ls-files (the path drops out).
    tx.run(
        "manifest regenerate",
        do=lambda: regenerate_manifest(paths.generate_manifest, paths.ga_root),
        undo=lambda: regenerate_manifest(paths.generate_manifest, paths.ga_root),
    )

    # Step 5 — rebuild the symlink farm from the (now manifest-pruned) files array.
    tx.run(
        "symlink swap",
        do=lambda: swap_symlinks(paths.install_script, paths.ga_root),
        undo=lambda: swap_symlinks(paths.install_script, paths.ga_root),
    )

    # Step 6 — prune the deleted agent's farm symlink. The glass-atrium `agents-only`
    # swap only ADDS/UPDATES symlinks from the manifest; it NEVER removes one whose
    # manifest row is gone, so step 5 leaves a DANGLING farm symlink for the deleted
    # agent. Unlink it (symlink only, never the target) so the final farm has NO
    # leftover link. Reverse-op re-links it; on rollback the reversed replay runs
    # restore_farm_symlink (after the .md is back from ~/.Trash) then step-5's undo
    # re-swaps from the restored manifest — together reconverging the farm.
    def _prune_symlink() -> None:
        prune_farm_symlink(paths.ga_root, req.name)

    def _restore_symlink() -> None:
        restore_farm_symlink(paths.ga_root, req.name)

    tx.run("farm symlink prune", do=_prune_symlink, undo=_restore_symlink)

    return (
        f"deleted {req.name} (origin={auth.origin}); "
        f".md -> {trash_dest}; rows backed up at {backup}; "
        f"{len(tx.written_labels())} cleanup steps committed."
    )


__all__ = [
    "DeleteAuthorization",
    "DeleteRefused",
    "DeleteRequest",
    "RollbackFailedError",
    "TransactionError",
    "authorize_delete",
    "render_dry_run",
    "run_delete",
]
