"""inject-scope-rules.sh 4-array transactional sync (T2 / AC1-AC3 / AC4).

Responsibilities:
    Reconcile the four space-padded bash arrays in inject-scope-rules.sh
    (INJECT_AGENTS = DEV+QA, STYLEREF_AGENTS = DEV, MINIMALISM_AGENTS = DEV,
    NAMING_AGENTS = DEV − {dev-swift} + qa-code-reviewer, EXCLUDES qa-debugger)
    with the DEV roster + the QA names (per-array predicate), bidirectionally —
    INSERTING every missing roster member AND REMOVING every stale array name
    absent from the expected membership (a deleted agent). The write is
    transactional: back the live file
    up to `.bak`, rebuild each array body, write atomically via
    atomic._atomic_replace, round-trip re-parse to assert inserts landed AND
    removes are gone, and on any failure restore from `.bak` and raise.

Mirrors stanza.py: membership is `split()` + token equality (NOT substring —
so `dev-rag` never matches `dev-rag-x`), insert is idempotent (a name already
present is a no-op so a clean-tree re-run does not double-add), and the result
is round-trip-validated by re-parsing the edited text.

This module operates on TEXT for the pure insert/remove cores (testable without
a live tree) and owns the file-level transaction in `apply()`. Insert (missing
roster member) and remove (stale array name absent from the roster) share the
ONE backup / atomic write / round-trip / rollback so removes never get a weaker
safety path than inserts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .atomic import _atomic_replace
from .readers import (
    _INJECT_AGENTS_RE,
    _MINIMALISM_AGENTS_RE,
    _NAMING_AGENTS_RE,
    _STYLEREF_AGENTS_RE,
    ReaderError,
    parse_inject_text,
    parse_scope_dev_roster,
)
from .paths import StorePaths

# QA names INJECT_AGENTS carries over the DEV roster (the same split orphan_scan
# models). Kept local so inject_sync owns its own expected-membership rule.
_QA_NAMES: frozenset[str] = frozenset({"glass-atrium-qa-code-reviewer", "glass-atrium-qa-debugger"})

# NAMING_AGENTS carries qa-code-reviewer ONLY (the review-enforcement surface),
# NEVER qa-debugger. Dedicated single-name set so the naming predicate cannot
# reuse _QA_NAMES (which includes qa-debugger).
_NAMING_QA_NAMES: frozenset[str] = frozenset({"glass-atrium-qa-code-reviewer"})

# dev-swift is the one DEV roster member NAMING_AGENTS excludes (native SwiftUI,
# not the web naming-convention surface the delta-core targets).
_NAMING_EXCLUDED_DEV: frozenset[str] = frozenset({"glass-atrium-dev-swift"})

# The 4 arrays keyed by their bash variable name -> the compiled assignment regex.
_ARRAY_RES = {
    "INJECT_AGENTS": _INJECT_AGENTS_RE,
    "STYLEREF_AGENTS": _STYLEREF_AGENTS_RE,
    "MINIMALISM_AGENTS": _MINIMALISM_AGENTS_RE,
    "NAMING_AGENTS": _NAMING_AGENTS_RE,
}


class InjectSyncError(RuntimeError):
    """An array could not be located, or a post-edit round-trip check failed.

    A plain InjectSyncError means the live file was restored from `.bak` (clean
    rollback). The InjectRollbackFailedError subclass means the restore ITSELF
    failed and the backup is preserved for manual recovery (distinct exit code).
    """


class InjectRollbackFailedError(InjectSyncError):
    """The sync failed AND the .bak restore failed — backup preserved for recovery."""


@dataclass
class SyncResult:
    """Outcome of a sync run: names inserted/removed per array + the backup path."""

    inserted: dict[str, list[str]] = field(default_factory=dict)
    removed: dict[str, list[str]] = field(default_factory=dict)
    backup_path: Path | None = None

    @property
    def changed(self) -> bool:
        return any(self.inserted.values()) or any(self.removed.values())

    def render(self) -> str:
        if not self.changed:
            return "sync-inject: already in sync (no names inserted or removed)."
        lines = ["sync-inject: reconciled names:"]
        for array_name, names in self.inserted.items():
            if names:
                lines.append(f"  [{array_name}] inserted: {', '.join(names)}")
        for array_name, names in self.removed.items():
            if names:
                lines.append(f"  [{array_name}] removed: {', '.join(names)}")
        if self.backup_path is not None:
            lines.append(f"  backup: {self.backup_path}")
        return "\n".join(lines)


def _expected_naming_membership(dev_roster: set[str]) -> set[str]:
    """NAMING_AGENTS expected set: DEV − {dev-swift} ∪ {qa-code-reviewer}.

    DEDICATED predicate — it CANNOT reuse _QA_NAMES (which includes qa-debugger)
    nor the plain dev_roster (which includes dev-swift). The naming delta-core
    injects to every DEV agent except dev-swift, plus the qa-code-reviewer
    enforcement surface, and NEVER to qa-debugger.
    """
    return (dev_roster - _NAMING_EXCLUDED_DEV) | _NAMING_QA_NAMES


def _expected_membership(dev_roster: set[str]) -> dict[str, set[str]]:
    """The expected name set per array given the DEV roster (the single rule).

    INJECT carries DEV + QA; STYLEREF + MINIMALISM are DEV-only; NAMING carries
    the narrower DEV − {dev-swift} + qa-code-reviewer set. Mirrors
    orphan_scan._check_inject_list_mismatch so detection and the fix agree.
    """
    return {
        "INJECT_AGENTS": dev_roster | _QA_NAMES,
        "STYLEREF_AGENTS": set(dev_roster),
        "MINIMALISM_AGENTS": set(dev_roster),
        "NAMING_AGENTS": _expected_naming_membership(dev_roster),
    }


def insert_name_in_array(text: str, array_name: str, name: str) -> str:
    """Return hook text with `name` inserted into the `array_name` body.

    Anchored on the array assignment regex. Membership is `split()` + token
    equality (NOT substring), so `name` already present returns the text
    UNCHANGED (idempotent dedup — clean-tree re-run = no-op). A new name is
    appended before the trailing-space pad, preserving the ` a b c ` convention.
    Round-trip-validates by re-parsing the edited array and asserting `name`
    is now a member and no prior member was lost.
    """
    array_re = _ARRAY_RES.get(array_name)
    if array_re is None:
        raise InjectSyncError(f"unknown inject array: {array_name!r}")

    match = array_re.search(text)
    if match is None:
        raise InjectSyncError(f"{array_name} assignment not found in hook text")

    body = match.group("body")
    before = body.split()
    if name in before:
        return text  # idempotent — already a member, no-op

    # Append before the trailing pad, keeping the leading + trailing single space
    # the live arrays use (` a b ... z `). split() already dropped padding, so
    # rebuild from tokens with explicit single-space pad on both ends.
    new_body = " " + " ".join([*before, name]) + " "
    start, end = match.span("body")
    new_text = text[:start] + new_body + text[end:]

    after = array_re.search(new_text)
    if after is None:
        raise InjectSyncError(
            f"round-trip check failed: {array_name} unparseable after insert"
        )
    after_members = after.group("body").split()
    if name not in after_members:
        raise InjectSyncError(
            f"round-trip check failed: {name!r} absent from {array_name} after insert"
        )
    if set(before) - set(after_members):
        raise InjectSyncError(
            f"round-trip check failed: insert into {array_name} dropped member(s) "
            f"{sorted(set(before) - set(after_members))}"
        )
    return new_text


def remove_name_in_array(text: str, array_name: str, name: str) -> str:
    """Return hook text with `name` removed from `array_name` (reverse / prune op).

    Symmetric to insert: idempotent (removing an absent name is a no-op),
    rebuilds the space-padded body from the remaining tokens, round-trip-validates.
    """
    array_re = _ARRAY_RES.get(array_name)
    if array_re is None:
        raise InjectSyncError(f"unknown inject array: {array_name!r}")

    match = array_re.search(text)
    if match is None:
        raise InjectSyncError(f"{array_name} assignment not found in hook text")

    members = match.group("body").split()
    if name not in members:
        return text  # idempotent — not a member, no-op

    kept = [m for m in members if m != name]
    new_body = (" " + " ".join(kept) + " ") if kept else " "
    start, end = match.span("body")
    new_text = text[:start] + new_body + text[end:]

    after = array_re.search(new_text)
    if after is None:
        raise InjectSyncError(
            f"round-trip check failed: {array_name} unparseable after remove"
        )
    if name in after.group("body").split():
        raise InjectSyncError(
            f"round-trip check failed: {name!r} still in {array_name} after remove"
        )
    return new_text


def plan_inserts(text: str, dev_roster: set[str]) -> dict[str, list[str]]:
    """Compute, per array, the sorted names missing vs the expected membership.

    Half of the bidirectional plan apply() executes: for each array, the
    expected-minus-actual difference (the roster members an array lacks).
    """
    actual = _actual_membership(text)
    expected = _expected_membership(dev_roster)
    return {
        array_name: sorted(expected[array_name] - actual[array_name])
        for array_name in _ARRAY_RES
    }


def plan_removes(text: str, dev_roster: set[str]) -> dict[str, list[str]]:
    """Compute, per array, the sorted stale names present but not expected.

    The remove half of the bidirectional plan: for each array, the
    actual-minus-expected difference (names in the array but absent from the
    roster + QA — a deleted/stale agent). Keys on the SAME roster as
    plan_inserts, so the delete-side scope-dev.md prune (which drops the deleted
    name from the roster) makes the stale name surface here.
    """
    actual = _actual_membership(text)
    expected = _expected_membership(dev_roster)
    return {
        array_name: sorted(actual[array_name] - expected[array_name])
        for array_name in _ARRAY_RES
    }


def _actual_membership(text: str) -> dict[str, set[str]]:
    """The current name set per array, parsed from the hook text."""
    inject, styleref, minimalism, naming = parse_inject_text(text)
    return {
        "INJECT_AGENTS": set(inject),
        "STYLEREF_AGENTS": set(styleref),
        "MINIMALISM_AGENTS": set(minimalism),
        "NAMING_AGENTS": set(naming),
    }


def apply(paths: StorePaths) -> SyncResult:
    """Bidirectionally reconcile the 4 inject arrays with the DEV roster, in one tx.

    Steps:
      1. Read the live hook + the DEV roster, compute the per-array insert AND
         remove plans.
      2. No missing names AND no stale names -> no-op (the file is left
         byte-identical, mtime unchanged — AC8; no `.bak` written).
      3. Back the live file up to `<hook>.bak`, build the new text by inserting
         every missing name AND removing every stale name (idempotent per-array
         ops), write it atomically via _atomic_replace, then round-trip re-parse
         the written file to assert every inserted name is PRESENT and every
         removed name is ABSENT (AC7).
      4. On ANY failure after the backup exists, restore the live file from
         `.bak` and raise InjectSyncError (the CLI maps this to a non-zero exit;
         rollback restores byte-identical content).

    Returns a SyncResult naming the inserted + removed names per array + backup.
    Raises ReaderError (roster/parse) or InjectSyncError (transaction) on failure.
    """
    hook = paths.inject_scope_rules
    original = hook.read_text(encoding="utf-8")
    roster = set(parse_scope_dev_roster(paths))

    inserts = plan_inserts(original, roster)
    removes = plan_removes(original, roster)
    if not any(inserts.values()) and not any(removes.values()):
        return SyncResult(
            inserted={k: [] for k in inserts},
            removed={k: [] for k in removes},
            backup_path=None,
        )

    backup = hook.with_suffix(hook.suffix + ".bak")
    backup.write_text(original, encoding="utf-8")

    try:
        new_text = original
        for array_name, names in inserts.items():
            for name in names:
                new_text = insert_name_in_array(new_text, array_name, name)
        for array_name, names in removes.items():
            for name in names:
                new_text = remove_name_in_array(new_text, array_name, name)

        def _revalidate(tmp_path: Path) -> None:
            written = tmp_path.read_text(encoding="utf-8")
            # round-trip: inserted names PRESENT, removed names ABSENT (AC7).
            written_members = _actual_membership(written)
            for array_name, names in inserts.items():
                missing = set(names) - written_members[array_name]
                if missing:
                    raise InjectSyncError(
                        f"post-write round-trip: {array_name} still missing "
                        f"{sorted(missing)}"
                    )
            for array_name, names in removes.items():
                lingering = set(names) & written_members[array_name]
                if lingering:
                    raise InjectSyncError(
                        f"post-write round-trip: {array_name} still carries "
                        f"removed name(s) {sorted(lingering)}"
                    )

        _atomic_replace(hook, new_text, before_replace=_revalidate)
    except (InjectSyncError, ReaderError, OSError) as exc:
        # restore the live file from the backup we just took, then re-raise.
        try:
            hook.write_text(original, encoding="utf-8")
        except OSError as restore_exc:
            raise InjectRollbackFailedError(
                f"sync failed AND rollback failed: {restore_exc} "
                f"(backup preserved at {backup})"
            ) from exc
        raise InjectSyncError(f"sync rolled back from .bak: {exc}") from exc

    return SyncResult(inserted=inserts, removed=removes, backup_path=backup)


__all__ = [
    "InjectRollbackFailedError",
    "InjectSyncError",
    "SyncResult",
    "apply",
    "insert_name_in_array",
    "plan_inserts",
    "plan_removes",
    "remove_name_in_array",
]
