"""Multi-step transaction with reverse-op rollback + failed-rollback STOP (AC1/B5).

Responsibilities:
    Run an ordered sequence of steps where each completed step registers a
    reverse-op. On a forward-step failure, replay the reverse-ops in REVERSE
    order. If a reverse-op ITSELF fails, STOP rolling back further, write a
    recovery marker file, emit a precise written-vs-cleaned manifest, and raise
    — never silently claim "orphan 0". This mirrors the Apply-Side Rollback
    Contract + daemon-lock discipline: a half-rolled-back state is preserved for
    user inspection, automatic resolution forbidden.

The transaction itself performs no I/O on the stores — each step's forward and
reverse work is supplied by the caller (the ADD/DELETE handlers in later waves),
keeping this framework store-agnostic and unit-testable with in-memory effects.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .atomic import _atomic_replace


class TransactionError(RuntimeError):
    """A forward step failed and rollback completed cleanly (no residue)."""


class RollbackFailedError(RuntimeError):
    """A reverse-op failed mid-rollback — state is HALF-CLEANED, marker written.

    Carries the recovery marker path + the written-vs-cleaned manifest so the
    caller can hand the exact reconciliation surface to the user / orphan-scan.
    """

    def __init__(
        self,
        message: str,
        *,
        marker_path: Path,
        written: list[str],
        cleaned: list[str],
        not_cleaned: list[str],
    ) -> None:
        super().__init__(message)
        self.marker_path = marker_path
        self.written = written
        self.cleaned = cleaned
        self.not_cleaned = not_cleaned


@dataclass
class _Step:
    """A completed forward step + the reverse-op that undoes it."""

    label: str
    undo: Callable[[], None]


@dataclass
class Transaction:
    """Record forward steps, then roll back in reverse on failure.

    Usage (later-wave handler):
        tx = Transaction(name="add:dev-foo", marker_dir=paths.ga_root)
        tx.run("write .md", do=write_md, undo=trash_md)
        tx.run("git add", do=git_add, undo=git_unstage)
        ...
    A forward `do` raising triggers rollback of all prior steps. A reverse `undo`
    raising during that rollback triggers the STOP + recovery-marker branch.
    """

    name: str
    marker_dir: Path
    _completed: list[_Step] = field(default_factory=list)

    def run(
        self, label: str, *, do: Callable[[], None], undo: Callable[[], None]
    ) -> None:
        """Execute one forward step; record its reverse-op; roll back on failure.

        On a forward error, replays every recorded reverse-op (including this
        step's prior siblings, NOT this failed step — it did not complete) and
        raises TransactionError on clean rollback, RollbackFailedError on a
        rollback that itself fails.
        """
        try:
            do()
        except Exception as exc:
            self._rollback(failed_label=label, cause=exc)
            raise TransactionError(
                f"transaction {self.name!r} failed at step {label!r}: {exc}; "
                f"rolled back {len(self._completed)} prior step(s) cleanly"
            ) from exc
        self._completed.append(_Step(label=label, undo=undo))

    def _rollback(self, *, failed_label: str, cause: Exception) -> None:
        """Replay reverse-ops in reverse; STOP + marker on a reverse-op failure."""
        cleaned: list[str] = []
        # snapshot the labels written so far for the manifest (do NOT mutate
        # _completed until each undo succeeds, so a failure reports accurately).
        written = [step.label for step in self._completed]
        for step in reversed(self._completed):
            try:
                step.undo()
            except Exception as undo_exc:
                not_cleaned = [
                    s.label for s in self._completed if s.label not in cleaned
                ]
                marker = self._write_recovery_marker(
                    failed_label=failed_label,
                    forward_cause=str(cause),
                    rollback_failed_step=step.label,
                    rollback_error=str(undo_exc),
                    written=written,
                    cleaned=cleaned,
                    not_cleaned=not_cleaned,
                )
                raise RollbackFailedError(
                    f"rollback of {self.name!r} failed while undoing {step.label!r}: "
                    f"{undo_exc}. STOP — {len(not_cleaned)} location(s) NOT cleaned; "
                    f"recovery marker at {marker}",
                    marker_path=marker,
                    written=written,
                    cleaned=cleaned,
                    not_cleaned=not_cleaned,
                ) from undo_exc
            cleaned.append(step.label)

    def _write_recovery_marker(
        self,
        *,
        failed_label: str,
        forward_cause: str,
        rollback_failed_step: str,
        rollback_error: str,
        written: list[str],
        cleaned: list[str],
        not_cleaned: list[str],
    ) -> Path:
        """Persist the written-vs-cleaned manifest as an atomic recovery marker.

        The marker is the honor-system reconciliation handoff (B5): it names
        exactly which locations were written and which the rollback could NOT
        clean, so the user / orphan-scan can finish reconciliation manually.
        """
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        marker = (
            self.marker_dir
            / f".agent-lifecycle-recovery-{self.name.replace(':', '_')}-{ts}.json"
        )
        payload = {
            "transaction": self.name,
            "timestamp_utc": ts,
            "failed_forward_step": failed_label,
            "forward_cause": forward_cause,
            "rollback_failed_at": rollback_failed_step,
            "rollback_error": rollback_error,
            "written": written,
            "cleaned": cleaned,
            "not_cleaned": not_cleaned,
            "note": (
                "Rollback STOPPED on a reverse-op failure. The 'not_cleaned' "
                "locations remain — reconcile via orphan-scan, do NOT assume "
                "orphan 0. Automatic resolution forbidden."
            ),
        }
        text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
        # best-effort atomic write via the shared temp+replace core — even marker
        # write can fail (e.g. marker dir unwritable), but we still raise
        # RollbackFailedError; the caller surfaces the intended marker path and
        # the RollbackFailedError still carries the in-memory manifest.
        with contextlib.suppress(OSError):
            _atomic_replace(marker, text)
        return marker

    def written_labels(self) -> list[str]:
        """Labels of steps completed so far (for caller-side reporting)."""
        return [step.label for step in self._completed]
