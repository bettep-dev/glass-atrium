"""DEV-roster sync into the 3 hardcoded gate sites (mirror of inject_sync.py).

Responsibilities:
    Keep the DEV roster (the scope-dev.md brace list, parsed by
    readers.parse_scope_dev_roster) reflected in three byte-sensitive gate sites:
      1. hooks/enforce-verification-gate.sh   — unpadded `DEV_SET="..."` bash str
      2. hooks/enforce-workflow-verify-stage.sh — byte-identical `DEV_SET="..."`
      3. scripts/gate-audit.sh                 — TWO byte-identical multi-line
                                                 `agent IN ( ... )` SQL DEV lists
    Unlike inject_sync (which inserts/removes individual names into space-padded
    arrays), each gate literal is REBUILT IN FULL from the roster via one
    canonical per-format renderer, so a clean tree is a TRUE byte-identical no-op
    and the two SQL occurrences stay byte-identical to each other by construction.

Transaction shape (mirrors inject_sync.apply): for each site whose rebuilt
literal differs from the live file — back the file up to `.bak`, write the
rebuilt text atomically via atomic._atomic_replace, round-trip re-parse the
written file to assert the literal now equals the roster, and on ANY failure
restore EVERY already-written site from its `.bak` (cross-file rollback) and
raise. A clean tree (all three already match) is a no-op: no `.bak`, mtime
unchanged. The SQL renderer reproduces the indent / 5-names-per-line / quoting
EXACTLY, and the bash renderer the single-space-separated form, so the no-op
short-circuit is exact.

CRITICAL — apply() is LOCK-FREE on purpose: run_add / run_delete already hold the
single-owner fcntl.flock mutation lock (per-FD, NON-recursive), so a second
acquire inside apply() would self-conflict. The lock lives ONLY at the standalone
CLI reconcile handler (cli._handle_sync_gate_roster), NEVER inside apply().

SHOULD-FIX #3 — every name is validated against validation.NAME_RE (via
validate_name) BEFORE it is interpolated into SQL/bash; a malformed roster name
LOUD-FAILS in the plan phase (before any backup), closing the injection /
malformed-output surface on the hand-editable scope-dev.md roster text.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from .atomic import _atomic_replace
from .paths import StorePaths
from .readers import (
    ReaderError,
    _DEV_SET_RE,
    _SQL_IN_LIST_RE,
    parse_dev_set_text,
    parse_scope_dev_roster,
    parse_sql_in_list_text,
)
from .validation import ValidationError, validate_name

if TYPE_CHECKING:
    from .transaction import Transaction

# The gate-audit.sh SQL DEV-set block layout — reproduced EXACTLY so a clean tree
# is a byte-identical no-op (verified against the live file: 11-space indent,
# 5 single-quoted names per line, comma-no-space, trailing comma except the last).
_SQL_INDENT = " " * 11
_SQL_NAMES_PER_LINE = 5

# The two gate formats. Each target file is rebuilt by the renderer for its format.
_FMT_BASH = "bash"
_FMT_SQL = "sql"


class GateRosterSyncError(RuntimeError):
    """A gate site could not be located, or a post-write round-trip check failed.

    A plain GateRosterSyncError means every already-written site was restored
    from its `.bak` (clean cross-file rollback). The GateRosterRollbackFailedError
    subclass means a restore ITSELF failed — the backups are preserved for manual
    recovery and the CLI maps it to the distinct exit-6 path.
    """


class GateRosterRollbackFailedError(GateRosterSyncError):
    """The sync failed AND a `.bak` restore failed — backups preserved for recovery."""


@dataclass(frozen=True)
class _Target:
    """One gate site: its path + which renderer/parser format it uses."""

    path: Path
    fmt: str


@dataclass
class GateSyncResult:
    """Outcome of a sync run: which sites changed, the roster written, backups."""

    changed: list[Path] = field(default_factory=list)
    names: list[str] = field(default_factory=list)
    backups: dict[Path, Path] = field(default_factory=dict)

    @property
    def did_change(self) -> bool:
        return bool(self.changed)

    def render(self) -> str:
        if not self.did_change:
            return "sync-gate-roster: already in sync (3 gate sites match the roster)."
        lines = [
            f"sync-gate-roster: reconciled {len(self.changed)} gate site(s) to "
            f"{len(self.names)} DEV roster name(s):"
        ]
        for path in self.changed:
            backup = self.backups.get(path)
            suffix = f" (backup: {backup})" if backup is not None else ""
            lines.append(f"  {path}{suffix}")
        return "\n".join(lines)


def _targets(paths: StorePaths) -> list[_Target]:
    """The 3 hardcoded gate sites + their renderer formats (the single SoT list)."""
    return [
        _Target(paths.enforce_verification_gate, _FMT_BASH),
        _Target(paths.enforce_workflow_verify_stage, _FMT_BASH),
        _Target(paths.gate_audit, _FMT_SQL),
    ]


def render_dev_set_body(names: list[str]) -> str:
    """Render the unpadded `DEV_SET="..."` body — single-space-separated names.

    SHOULD-FIX #3: each name is validated against validation.NAME_RE before it is
    interpolated; a malformed name raises ValidationError (LOUD-FAIL).
    """
    return " ".join(_validate_each(names))


def render_sql_in_list_body(names: list[str]) -> str:
    """Render the multi-line `agent IN (...)` SQL body BYTE-IDENTICALLY.

    11-space indent, 5 single-quoted names per line, comma-no-space separators,
    a trailing comma on every line except the last. One canonical body feeds BOTH
    gate-audit.sh occurrences so they stay byte-identical to each other.

    SHOULD-FIX #3: each name is validated against validation.NAME_RE before it is
    quoted into the SQL literal; a malformed name raises ValidationError.
    """
    safe = _validate_each(names)
    chunks = [
        safe[i : i + _SQL_NAMES_PER_LINE]
        for i in range(0, len(safe), _SQL_NAMES_PER_LINE)
    ]
    lines: list[str] = []
    for idx, chunk in enumerate(chunks):
        quoted = ",".join(f"'{n}'" for n in chunk)
        is_last = idx == len(chunks) - 1
        lines.append(_SQL_INDENT + quoted + ("" if is_last else ","))
    return "\n".join(lines)


def _validate_each(names: list[str]) -> list[str]:
    """Validate every name against validation.NAME_RE (reused, not re-inlined).

    Returns the names unchanged on success; raises ValidationError on the first
    malformed token. This is the single charset chokepoint both renderers call
    BEFORE any interpolation (SHOULD-FIX #3).
    """
    return [validate_name(name) for name in names]


def set_dev_set(text: str, names: list[str], *, source: str = "<text>") -> str:
    """Return bash text with the `DEV_SET="..."` body rebuilt from `names`.

    Anchored on the DEV_SET assignment regex; replaces ONLY the quoted body so the
    `readonly DEV_SET=` prefix + quotes are preserved. Idempotent: when `names`
    already match the literal, the result is byte-identical to `text`.
    """
    match = _DEV_SET_RE.search(text)
    if match is None:
        raise GateRosterSyncError(f'DEV_SET="..." assignment not found in {source}')
    new_body = render_dev_set_body(names)
    start, end = match.span("body")
    return text[:start] + new_body + text[end:]


def set_sql_in_lists(text: str, names: list[str], *, source: str = "<text>") -> str:
    """Return SQL text with EVERY `agent IN (...)` body rebuilt from `names`.

    Replaces all occurrences (AUDIT_SQL + SUMMARY_SQL) with ONE canonical rendered
    body, so the two stay byte-identical by construction. Replacement runs from the
    LAST match backwards so earlier match spans stay valid. Idempotent: when
    `names` already match, the result is byte-identical to `text`.
    """
    matches = list(_SQL_IN_LIST_RE.finditer(text))
    if not matches:
        raise GateRosterSyncError(
            f"`agent IN (...)` SQL DEV-set list not found in {source}"
        )
    new_body = render_sql_in_list_body(names)
    result = text
    for match in reversed(matches):
        start, end = match.span("body")
        result = result[:start] + new_body + result[end:]
    return result


def _rebuild(text: str, fmt: str, names: list[str], *, source: str) -> str:
    """Rebuild the gate literal(s) in `text` for `fmt` from the roster `names`."""
    if fmt == _FMT_BASH:
        return set_dev_set(text, names, source=source)
    if fmt == _FMT_SQL:
        return set_sql_in_lists(text, names, source=source)
    raise GateRosterSyncError(f"unknown gate format: {fmt!r}")


def _parsed_names(text: str, fmt: str, *, source: str) -> list[list[str]]:
    """Parse the gate literal(s) back out, normalized to a list-of-occurrences.

    bash → one occurrence; sql → one per `agent IN (...)`. The round-trip check
    asserts every occurrence equals the roster, so a single shape covers both.
    """
    if fmt == _FMT_BASH:
        return [parse_dev_set_text(text, source=source)]
    if fmt == _FMT_SQL:
        return parse_sql_in_list_text(text, source=source)
    raise GateRosterSyncError(f"unknown gate format: {fmt!r}")


def _assert_roundtrip(
    written_text: str, fmt: str, roster: list[str], *, source: str
) -> None:
    """Re-parse the written gate text and assert every literal equals the roster.

    For SQL this also proves the two occurrences are byte-identical in NAME terms
    (each must equal the roster). Raises GateRosterSyncError on any divergence.
    """
    occurrences = _parsed_names(written_text, fmt, source=source)
    for idx, names in enumerate(occurrences):
        if names != roster:
            raise GateRosterSyncError(
                f"post-write round-trip: {source} occurrence #{idx + 1} parsed "
                f"{names} != roster {roster}"
            )


def _plan_with_roster(
    roster: list[str], paths: StorePaths
) -> list[tuple[_Target, str, str]]:
    """Build per-target (target, original_text, rebuilt_text) for a pre-parsed roster.

    Inner core shared by plan() and apply() so scope-dev.md is read exactly once
    per public call. Validates every name's charset via the renderers.
    """
    out: list[tuple[_Target, str, str]] = []
    for target in _targets(paths):
        original = target.path.read_text(encoding="utf-8")
        rebuilt = _rebuild(original, target.fmt, roster, source=str(target.path))
        out.append((target, original, rebuilt))
    return out


def plan(paths: StorePaths) -> list[tuple[_Target, str, str]]:
    """Compute, per target, (target, original_text, rebuilt_text) — no writes.

    Reads the DEV roster (raises ReaderError on a malformed roster), validates the
    charset of every name via the renderers, and rebuilds each gate literal. The
    caller filters for `rebuilt != original` to find the sites that need a write.
    """
    roster = parse_scope_dev_roster(paths)
    return _plan_with_roster(roster, paths)


def apply(paths: StorePaths) -> GateSyncResult:
    """Reconcile the 3 gate sites with the DEV roster in one cross-file transaction.

    Steps:
      1. Read the roster + rebuild each gate literal (the plan; charset-validated).
      2. No site differs -> no-op (every file left byte-identical, mtime unchanged,
         no `.bak`).
      3. For each differing site: back it up to `<file>.bak`, write the rebuilt
         text atomically via _atomic_replace, and round-trip re-parse the written
         file to assert the literal now equals the roster.
      4. On ANY failure after a backup exists, restore EVERY already-written site
         from its `.bak` (cross-file rollback) and raise GateRosterSyncError
         (clean rollback) or GateRosterRollbackFailedError (a restore failed).

    LOCK-FREE — the caller (run_add / run_delete) already holds the mutation lock;
    only the standalone CLI handler wraps this in mutation_lock.

    Returns a GateSyncResult naming the changed sites + the roster + backup paths.
    Raises ReaderError (roster parse), ValidationError (malformed name), or
    GateRosterSyncError / GateRosterRollbackFailedError (transaction).
    """
    roster = parse_scope_dev_roster(paths)
    planned = _plan_with_roster(roster, paths)
    changed = [(t, orig, new) for (t, orig, new) in planned if new != orig]
    if not changed:
        return GateSyncResult(changed=[], names=list(roster), backups={})

    backups: dict[Path, Path] = {}
    written: list[tuple[Path, Path]] = []  # (target_path, backup_path) fully written

    try:
        for target, original, rebuilt in changed:
            backup = target.path.with_suffix(target.path.suffix + ".bak")
            backup.write_text(original, encoding="utf-8")
            backups[target.path] = backup

            def _revalidate(tmp_path: Path, _tgt: _Target = target) -> None:
                _assert_roundtrip(
                    tmp_path.read_text(encoding="utf-8"),
                    _tgt.fmt,
                    roster,
                    source=str(_tgt.path),
                )

            _atomic_replace(target.path, rebuilt, before_replace=_revalidate)
            written.append((target.path, backup))
    except (GateRosterSyncError, ReaderError, ValidationError, OSError) as exc:
        _rollback(written, backups, cause=exc)
        raise GateRosterSyncError(
            f"gate-roster sync rolled back from .bak: {exc}"
        ) from exc

    return GateSyncResult(
        changed=[t.path for (t, _orig, _new) in changed],
        names=list(roster),
        backups=backups,
    )


def _rollback(
    written: list[tuple[Path, Path]],
    backups: dict[Path, Path],
    *,
    cause: Exception,
) -> None:
    """Restore every already-written site from its `.bak` (cross-file rollback).

    `written` holds only the sites whose atomic replace COMPLETED (the failing
    site's live file is untouched by _atomic_replace, so it needs no restore). A
    restore that itself fails raises GateRosterRollbackFailedError with the
    backups preserved for manual recovery (the distinct exit-6 path).
    """
    not_restored: list[Path] = []
    for target_path, backup in written:
        try:
            target_path.write_text(backup.read_text(encoding="utf-8"), encoding="utf-8")
        except OSError:
            not_restored.append(target_path)
    if not_restored:
        raise GateRosterRollbackFailedError(
            f"gate-roster sync failed ({cause}) AND restore failed for "
            f"{not_restored}; backups preserved: "
            f"{[str(backups[p]) for p in not_restored if p in backups]}"
        ) from cause


def register_gate_roster_tx_step(tx: Transaction, paths: StorePaths) -> None:
    """Register the gate-roster-sync do/undo pair on `tx`.

    Encapsulates the state-dict, do-closure, and undo-closure common to both
    run_add and run_delete. The `if is_dev:` DEV-gating stays the caller's
    responsibility; only the inner block lives here. Preserves identical step
    label, do/undo semantics, and state bridging.
    """
    gate_sync_state: dict[str, GateSyncResult] = {}

    def _do() -> None:
        gate_sync_state["result"] = apply(paths)

    def _undo() -> None:
        result = gate_sync_state.get("result")
        if result is not None:
            restore_from_backups(result)

    tx.run("gate roster sync", do=_do, undo=_undo)


def restore_from_backups(result: GateSyncResult) -> None:
    """Undo a SUCCESSFUL apply() by restoring each changed site from its `.bak`.

    The reverse-op the run_add / run_delete Transaction registers for the
    gate-roster-sync step: on a later-step failure the Transaction replays this to
    put the pre-sync gate literals back. A restore OSError propagates so the
    Transaction surfaces it as a RollbackFailedError (the exit-6 path). Idempotent
    for a no-op result (empty backups -> nothing to do).
    """
    for target_path in result.changed:
        backup = result.backups.get(target_path)
        if backup is not None and backup.exists():
            target_path.write_text(backup.read_text(encoding="utf-8"), encoding="utf-8")


__all__ = [
    "GateRosterRollbackFailedError",
    "GateRosterSyncError",
    "GateSyncResult",
    "apply",
    "plan",
    "render_dev_set_body",
    "render_sql_in_list_body",
    "restore_from_backups",
    "set_dev_set",
    "set_sql_in_lists",
]
