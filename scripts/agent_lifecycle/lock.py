"""Single-owner mutation lock for the derived-chain transactions (T1b).

Responsibilities:
    Serialize the two mutating lifecycle ops (run_add / run_delete) so their
    derived chains — manifest regenerate + symlink swap, which are NOT
    concurrency-safe — never interleave. The CLI process is the SINGLE lock
    owner: the lock is acquired INSIDE run_add/run_delete (not at any caller),
    so a direct CLI invocation and any future programmatic caller serialize on
    the SAME canonical path.

Primitive choice — fcntl.flock, NOT a mkdir lock dir (why_proper):
    flock is a kernel-held advisory lock on an open file descriptor. The OS
    releases it AUTOMATICALLY when the holding process exits — including a
    crash, SIGKILL, or a killed-mid-transaction process. A mkdir-based lock
    leaves a stale `.agent-add-lock` directory on crash that a later run must
    detect + clean (a stale-on-crash residue, the exact shortcut the no-shortcut
    mandate forbids). flock also has NO TOCTOU window: LOCK_EX | LOCK_NB is a
    single atomic syscall (acquire-or-fail), not a check-then-create pair. The
    lock FILE itself is left on disk by design — only the kernel lock STATE
    matters, and an empty regular file carries no stale state.
"""

from __future__ import annotations

import fcntl
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .paths import StorePaths


class MutationLockHeld(RuntimeError):
    """The mutation lock is already held by another process — refuse (HALT).

    A concurrent lifecycle mutation is in flight; the derived chain is not
    concurrency-safe, so the second caller must not proceed. Distinct exception
    so the CLI maps it to the HALT exit code without conflating it with a gate
    refusal or a transaction failure.
    """


def mutation_lock_path(paths: StorePaths) -> Path:
    """Canonical mutation-lock path for the CLI's single-owner lock.

    Env override `AGENT_LIFECYCLE_ADD_LOCK_PATH` redirects the lock (the test
    suite points it at an isolated temp path).
    Default: <ga_root>/scripts/.agent-add-lock.
    """
    override = os.environ.get("AGENT_LIFECYCLE_ADD_LOCK_PATH")
    if override:
        return Path(override)
    return paths.ga_root / "scripts" / ".agent-add-lock"


@contextmanager
def mutation_lock(paths: StorePaths) -> Iterator[None]:
    """Hold the single-owner mutation lock for the wrapped transaction.

    Non-blocking acquire (LOCK_NB): a held lock raises MutationLockHeld at once
    rather than queueing, so a concurrent caller HALTs loudly (a silent wait
    would mask the contention). The lock is
    released on context exit AND auto-released by the kernel if the process dies
    mid-transaction (crash-safe — no stale-lock cleanup path needed).
    """
    path = mutation_lock_path(paths)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Open (create if absent) the lock file; the fd carries the kernel lock.
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise MutationLockHeld(
                f"agent-lifecycle mutation lock is held ({path}) — another "
                f"add/delete is in flight; the derived chain is not "
                f"concurrency-safe, so this run HALTs. Retry when it completes."
            ) from exc
        try:
            yield
        finally:
            # Explicit release on the normal path; the kernel also releases on
            # process exit (the crash-safety guarantee), so a missed unlock on
            # an abrupt exit never strands the lock.
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


__all__ = ["MutationLockHeld", "mutation_lock", "mutation_lock_path"]
