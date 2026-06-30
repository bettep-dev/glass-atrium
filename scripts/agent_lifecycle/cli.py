"""argparse CLI for the agent-lifecycle tool (ADD + EXTEND wired in Wave 2).

Responsibilities:
    Wire the subcommands (add / extend / delete / orphan-scan / sync-inject)
    with their flags, the shared `--ga-root` override (so the disposable test
    suite targets an isolated temp copy), and the common pre-flight: <name>
    validation + StorePaths resolution. `sync-inject` reuses orphan-scan's
    inject-list-mismatch detection then transactionally writes the fix via
    inject_sync.apply (the only mutating inject path; orphan-scan stays
    read-only / exit-0).

ADD never runs without an explicit Q1/Q2 attestation verdict (the --gate-q1 /
--gate-q2 flags); EXTEND is additive-only and HALTs on any value mutation. A
stubbed handler returns NotYetImplemented (3) so an accidental live invocation
is a loud no-op, never a silent partial write.

Exit-code contract (the PRIMARY caller interface, now that the HTTP route that
surfaced it is removed — wrapper scripts branch on these):
    0  EXIT_OK              committed (or a clean dry-run / preview)
    2  EXIT_USAGE           argparse usage error
    4  EXIT_HALT            gate / pre-flight / lock-held / body refusal — ZERO
                            writes (safe to retry once the cause clears)
    5  EXIT_TX_FAILED       a forward step failed, rolled back CLEANLY (no residue)
    6  EXIT_ROLLBACK_FAILED rollback itself failed — recovery marker written;
                            run `orphan-scan --mode reconcile` (do NOT assume
                            orphan 0)
Code 3 is reserved (was the stubbed-handler exit).
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable, Sequence
from pathlib import Path

from .add import AddRefused, AddRequest, dry_run_add, run_add
from .delete import DeleteRefused, DeleteRequest, run_delete
from .extend import ExtendRefused, ExtendRequest, run_extend
from .gate_roster_sync import (
    GateRosterRollbackFailedError,
    GateRosterSyncError,
    apply as run_sync_gate_roster,
)
from .inject_sync import (
    InjectRollbackFailedError,
    InjectSyncError,
    apply as run_sync_inject,
)
from .lock import MutationLockHeld, mutation_lock
from .orphan_scan import (
    ALL_MODES,
    find_recovery_markers,
    render_reconciliation,
    run_scan,
)
from .paths import StorePaths
from .readers import ReaderError
from .registry_ops import RegistryMutationError
from .scaffold import (
    BodyAnchorError,
    BodyFrontmatterError,
    PreflightError,
    assert_body_no_smuggled_frontmatter,
    reconcile_body_anchor,
)
from .secret_scan import SecretDetected, scan_for_secrets
from .stanza import StanzaError
from .subproc import StepError
from .transaction import RollbackFailedError, TransactionError
from .validation import ValidationError, validate_name

# Exit codes (named, like generate-manifest.sh): 0 ok · 2 usage · 4 validation/
# safety/gate HALT · 5 transaction failed (rolled back cleanly) · 6 rollback
# FAILED (recovery marker — reconcile). Code 3 is reserved (was the stub exit).
EXIT_OK = 0
EXIT_USAGE = 2
EXIT_HALT = 4
EXIT_TX_FAILED = 5
EXIT_ROLLBACK_FAILED = 6


def _resolve_paths(args: argparse.Namespace) -> StorePaths:
    """Build StorePaths from the optional --ga-root override (tests pass a temp)."""
    root = Path(args.ga_root) if getattr(args, "ga_root", None) else None
    return StorePaths.for_root(root)


def _validate_target(args: argparse.Namespace) -> str | None:
    """Validate the <name> arg when the subcommand carries one; HALT on failure.

    Returns the validated name, or None for name-less subcommands (orphan-scan).
    Raises ValidationError (caught in `main`) on an unsafe name.
    """
    name = getattr(args, "name", None)
    if name is None:
        return None
    return validate_name(name)


def _parse_domains(raw: str | None) -> list[str]:
    """Split a comma-separated --domains string into an ordered, de-duped list."""
    if not raw:
        return []
    seen: dict[str, None] = {}
    for tok in raw.split(","):
        tok = tok.strip()
        if tok and tok not in seen:
            seen[tok] = None
    return list(seen)


def _run_transactional(thunk: Callable[[], str]) -> int:
    """Run a transactional run_* thunk and map its terminal outcomes to exit codes.

    Owns ONLY the shared post-transaction mapping: a successful summary print,
    the failed-rollback recovery stanza, and the rolled-back-cleanly notice. The
    per-handler Refused exception (RuntimeError family) is deliberately NOT caught
    here — it stays disjoint from `main`'s ValueError-based catch-all, so each
    caller must catch its own Refused before delegating here (a leaked Refused
    would crash `main` and regress the HALT exit).
    """
    try:
        summary = thunk()
    except MutationLockHeld as exc:
        # The single-owner mutation lock is held by a concurrent add/delete —
        # zero writes occurred (acquire is the first step inside run_*), so this
        # is a clean HALT, not a transaction failure.
        print(f"HALT: {exc}", file=sys.stderr)
        return EXIT_HALT
    except RollbackFailedError as exc:
        print(f"ROLLBACK FAILED: {exc}", file=sys.stderr)
        print(f"  written:     {exc.written}", file=sys.stderr)
        print(f"  cleaned:     {exc.cleaned}", file=sys.stderr)
        print(f"  not_cleaned: {exc.not_cleaned}", file=sys.stderr)
        print(f"  recovery marker: {exc.marker_path}", file=sys.stderr)
        return EXIT_ROLLBACK_FAILED
    except (TransactionError, StepError) as exc:
        print(f"FAILED (rolled back): {exc}", file=sys.stderr)
        return EXIT_TX_FAILED
    print(summary)
    return EXIT_OK


def _load_validated_body(body_file: str, scope: str) -> str:
    """Read + gate an authored body file at the CLI boundary (the single chokepoint).

    Mirrors extend's refuse-on-missing-file behavior, then applies the body gates
    IN THE SAME CALL (never a follow-up): (1) non-empty; (2) fail-closed
    secret-scan (HALT on any credential pattern); (3) no smuggled frontmatter —
    HALT a body that begins with a `---` fence or carries a frontmatter-shaped
    name/tools/scope/maxTurns key above the anchor (privilege-escalation guard);
    (4) `> Rules:` anchor reconciliation against `scope` — injected if absent,
    HALT on a wrong-scope anchor. Raises ValidationError / BodyFrontmatterError /
    BodyAnchorError / SecretDetected, all mapped to EXIT_HALT by the caller.
    """
    path = Path(body_file)
    if not path.exists():
        raise ValidationError(f"--body-file not found: {path}")
    raw = path.read_text(encoding="utf-8")
    if not raw.strip():
        raise ValidationError(f"--body-file is empty: {path}")
    # fail-closed secret-scan FIRST — a credential must never reach the store,
    # even transiently, regardless of the anchor outcome.
    scan_for_secrets(raw)
    # frontmatter-smuggle gate on the RAW body (before the anchor is stripped) —
    # a body must not carry its own frontmatter block shadowing the canonical one.
    assert_body_no_smuggled_frontmatter(raw)
    # anchor reconcile: inject if absent, HALT on scope mismatch (BodyAnchorError).
    return reconcile_body_anchor(raw, scope)


def _handle_add(args: argparse.Namespace) -> int:
    paths = _resolve_paths(args)
    # <name> validated here too (the AddRequest handler re-validates as the
    # chokepoint; this gives an early, friendly CLI-level HALT).
    name = _validate_target(args)
    assert name is not None  # noqa: S101 — add always carries a name (argparse-required)

    # Q1/Q2 attestation verdicts come from the --gate-q1/--gate-q2 flags (the
    # primary channel). An absent verdict reaches the gate as None, which the
    # gate refuses (no default-pass) — never silently pass.
    q1 = args.gate_q1
    q2 = args.gate_q2

    if not args.scope:
        print("HALT: add requires --scope (e.g. DEV, META, PLANNING)", file=sys.stderr)
        return EXIT_HALT
    if not args.origin:
        print("HALT: add requires --origin (user|shipped)", file=sys.stderr)
        return EXIT_HALT

    # --dry-run — write-free gate + pre-flight preview, then exit. Runs BEFORE
    # body loading + the transaction: a preview never authors a body, never
    # locks, never writes. Q3 overlap runs here so over-broad domains fail fast.
    if args.dry_run:
        dry_req = AddRequest(
            name=name,
            scope=args.scope,
            origin=args.origin,
            domains=_parse_domains(args.domains),
            q1_verdict=q1,
            q2_verdict=q2,
            description=args.description,
        )
        try:
            print(dry_run_add(paths, dry_req))
        except ValidationError as exc:
            print(f"HALT: {exc}", file=sys.stderr)
            return EXIT_HALT
        return EXIT_OK

    # T10 — --description and --body-file both set the agent's authored text via
    # disjoint paths (frontmatter blurb vs. body). Accepting both would silently
    # pick one; HALT on the ambiguous combination instead.
    if args.body_file is not None and args.description is not None:
        print(
            "HALT: --description and --body-file are mutually exclusive "
            "(--body-file authors the agent body; --description sets the "
            "frontmatter blurb) — pass at most one",
            file=sys.stderr,
        )
        return EXIT_HALT

    body_md: str | None = None
    if args.body_file is not None:
        try:
            body_md = _load_validated_body(args.body_file, args.scope)
        except (
            ValidationError,
            BodyAnchorError,
            BodyFrontmatterError,
            SecretDetected,
        ) as exc:
            print(f"HALT: {exc}", file=sys.stderr)
            return EXIT_HALT

    req = AddRequest(
        name=name,
        scope=args.scope,
        origin=args.origin,
        domains=_parse_domains(args.domains),
        q1_verdict=q1,
        q2_verdict=q2,
        description=args.description,
        body_md=body_md,
    )
    try:
        return _run_transactional(lambda: run_add(paths, req))
    except (AddRefused, BodyFrontmatterError) as exc:
        # BodyFrontmatterError can surface from render_agent_md's defense-in-depth
        # post-render assertion (reached even if the input gate is bypassed) —
        # it fires BEFORE the transaction's first write, so this is a clean HALT.
        print(f"HALT: {exc}", file=sys.stderr)
        return EXIT_HALT


def _handle_extend(args: argparse.Namespace) -> int:
    paths = _resolve_paths(args)
    name = _validate_target(args)
    assert name is not None  # noqa: S101 — extend always carries a name

    section = Path(args.append_section) if args.append_section else None
    req = ExtendRequest(
        name=name,
        add_domain=args.add_domain,
        append_section_file=section,
    )
    try:
        return _run_transactional(lambda: run_extend(paths, req))
    except (ExtendRefused, RegistryMutationError, StanzaError, PreflightError) as exc:
        print(f"HALT: {exc}", file=sys.stderr)
        return EXIT_HALT


def _handle_delete(args: argparse.Namespace) -> int:
    paths = _resolve_paths(args)
    name = _validate_target(args)
    assert name is not None  # noqa: S101 — delete always carries a name

    req = DeleteRequest(name=name, confirm=args.confirm, dry_run=args.dry_run)
    try:
        return _run_transactional(lambda: run_delete(paths, req))
    except DeleteRefused as exc:
        print(f"HALT: {exc}", file=sys.stderr)
        return EXIT_HALT


def _handle_orphan_scan(args: argparse.Namespace) -> int:
    paths = _resolve_paths(args)
    modes = list(args.mode) if args.mode else None

    # Reconciliation mode is a distinct, explicit request (failed-rollback recovery).
    if modes is not None and "reconcile" in modes:
        markers = find_recovery_markers(paths)
        print(render_reconciliation(markers))
        return EXIT_OK

    try:
        report = run_scan(paths, modes)
    except ReaderError as exc:
        print(f"HALT: orphan-scan could not read a store: {exc}", file=sys.stderr)
        return EXIT_HALT
    print(report.render())
    # A non-clean scan is informational (lint), not a process failure — exit 0
    # so a CI wrapper can decide policy on the printed findings.
    return EXIT_OK


def _handle_sync_inject(args: argparse.Namespace) -> int:
    """Reconcile the 4 inject-scope-rules.sh arrays with the DEV roster.

    Reuses orphan-scan's inject-list-mismatch detection to report the diff, then
    delegates the transactional write to inject_sync.apply (`.bak` backup +
    atomic replace + round-trip re-parse + rollback-on-failure). Maps a clean
    rollback to EXIT_TX_FAILED and a failed rollback to EXIT_ROLLBACK_FAILED;
    success (including a no-op clean tree) is EXIT_OK.
    """
    paths = _resolve_paths(args)

    # Detection reuse — the SAME read-only scan orphan-scan runs (R2 design).
    try:
        report = run_scan(paths, ["inject-list-mismatch"])
    except ReaderError as exc:
        print(f"HALT: sync-inject could not read a store: {exc}", file=sys.stderr)
        return EXIT_HALT
    findings = report.by_mode("inject-list-mismatch")
    if findings:
        print(f"sync-inject: {len(findings)} mismatch(es) detected; reconciling...")

    try:
        result = run_sync_inject(paths)
    except InjectRollbackFailedError as exc:
        print(f"ROLLBACK FAILED: {exc}", file=sys.stderr)
        return EXIT_ROLLBACK_FAILED
    except (InjectSyncError, ReaderError) as exc:
        print(f"FAILED (rolled back): {exc}", file=sys.stderr)
        return EXIT_TX_FAILED

    print(result.render())
    return EXIT_OK


def _handle_sync_gate_roster(args: argparse.Namespace) -> int:
    """Reconcile the 3 hardcoded gate sites with the DEV roster (standalone verb).

    Reuses orphan-scan's gate-roster-mismatch detection to report the diff, then
    delegates the transactional write to gate_roster_sync.apply (`.bak` backup +
    atomic replace + round-trip + cross-file rollback). SHOULD-FIX #1 — this
    standalone path acquires the single-owner mutation_lock (apply() itself is
    LOCK-FREE because run_add/run_delete already hold it; here there is no
    surrounding holder, and add/delete now write these same files under the lock,
    so the standalone verb MUST serialize against them). Maps a clean rollback to
    EXIT_TX_FAILED and a failed rollback to EXIT_ROLLBACK_FAILED; a held lock to
    EXIT_HALT; success (including a no-op clean tree) to EXIT_OK.
    """
    paths = _resolve_paths(args)

    # Detection reuse — the SAME read-only scan orphan-scan runs.
    try:
        report = run_scan(paths, ["gate-roster-mismatch"])
    except ReaderError as exc:
        print(f"HALT: sync-gate-roster could not read a store: {exc}", file=sys.stderr)
        return EXIT_HALT
    findings = report.by_mode("gate-roster-mismatch")
    if findings:
        print(
            f"sync-gate-roster: {len(findings)} mismatch(es) detected; reconciling..."
        )

    try:
        with mutation_lock(paths):
            result = run_sync_gate_roster(paths)
    except MutationLockHeld as exc:
        # A concurrent add/delete holds the single-owner lock — zero writes, clean HALT.
        print(f"HALT: {exc}", file=sys.stderr)
        return EXIT_HALT
    except GateRosterRollbackFailedError as exc:
        print(f"ROLLBACK FAILED: {exc}", file=sys.stderr)
        return EXIT_ROLLBACK_FAILED
    except (GateRosterSyncError, ReaderError, ValidationError) as exc:
        print(f"FAILED (rolled back): {exc}", file=sys.stderr)
        return EXIT_TX_FAILED

    print(result.render())
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    """Construct the full argparse tree (the subcommands + shared flags)."""
    parser = argparse.ArgumentParser(
        prog="agent-lifecycle",
        description="Safe agent add / delete / orphan-scan over GA.",
        epilog=(
            "exit codes (PRIMARY caller interface): "
            "0 ok · 2 usage · 4 gate/pre-flight/lock-held refusal (zero writes) · "
            "5 transaction failed, rolled back cleanly · "
            "6 rollback FAILED, recovery marker written (run orphan-scan --mode "
            "reconcile)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--ga-root",
        metavar="DIR",
        default=None,
        help="override the GA root (tests target an isolated temp copy)",
    )
    sub = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    p_add = sub.add_parser(
        "add", help="add a new agent (R1-gated derived-chain transaction)"
    )
    p_add.add_argument("name", help="new agent name (validated against ^[a-z0-9-]+$)")
    p_add.add_argument(
        "--scope", required=False, help="compliance scope (e.g. DEV, META)"
    )
    p_add.add_argument("--origin", choices=("user", "shipped"), help="agent origin")
    p_add.add_argument(
        "--domains",
        metavar="A,B,C",
        default=None,
        help="comma-separated routing domains tokens (Q3 overlap input)",
    )
    p_add.add_argument(
        "--description", default=None, help="agent description (scaffold frontmatter)"
    )
    p_add.add_argument(
        "--body-file",
        metavar="FILE",
        default=None,
        help=(
            "authored agent body markdown (mutually exclusive with --description; "
            "non-empty + `> Rules:` anchor reconciled + secret-scanned at this gate)"
        ),
    )
    p_add.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "evaluate the R1 gate + targets-absent pre-flight WRITE-FREE and "
            "print JSON {allowed, preflight_clear, reasons, q3_conflicts}; "
            "mutates nothing (the preview path — replaces the HTTP preview)"
        ),
    )
    p_add.add_argument(
        "--gate-q1",
        choices=("pass", "fail"),
        help="operator/LLM attestation verdict for R1 Q1 (concern-novelty)",
    )
    p_add.add_argument(
        "--gate-q2",
        choices=("pass", "fail"),
        help="operator/LLM attestation verdict for R1 Q2 (extend-test)",
    )
    p_add.set_defaults(func=_handle_add)

    p_extend = sub.add_parser(
        "extend",
        help="additive-extend an existing agent (add domains token / body section)",
    )
    p_extend.add_argument("name", help="existing agent name (validated)")
    p_extend.add_argument(
        "--add-domain", metavar="TOKEN", help="ADDITIVE domains token to append"
    )
    p_extend.add_argument(
        "--append-section", metavar="FILE", help="body section file to append"
    )
    p_extend.set_defaults(func=_handle_extend)

    p_delete = sub.add_parser(
        "delete", help="delete an agent (origin:user-only policy, fail-closed)"
    )
    p_delete.add_argument(
        "name", help="agent name to delete (validated + registry-member-checked)"
    )
    p_delete.add_argument(
        "--confirm",
        metavar="NAME",
        help="typed agent name confirming the irreversible delete (hard gate)",
    )
    p_delete.add_argument(
        "--dry-run", action="store_true", help="show the 4 targets, write nothing"
    )
    p_delete.set_defaults(func=_handle_delete)

    p_scan = sub.add_parser(
        "orphan-scan", help="6-mode mismatch + symlink-integrity lint"
    )
    p_scan.add_argument(
        "--mode",
        action="append",
        default=None,
        metavar="MODE",
        help=(
            "restrict to one or more modes (default: all). modes: "
            + ", ".join(ALL_MODES)
            + "; or `reconcile` to list failed-rollback recovery markers"
        ),
    )
    p_scan.set_defaults(func=_handle_orphan_scan)

    p_sync = sub.add_parser(
        "sync-inject",
        help=(
            "reconcile the 4 inject-scope-rules.sh arrays with the DEV roster "
            "(transactional: .bak backup + atomic write + rollback)"
        ),
    )
    p_sync.set_defaults(func=_handle_sync_inject)

    p_sync_gate = sub.add_parser(
        "sync-gate-roster",
        help=(
            "reconcile the 3 hardcoded gate sites (enforce-verification-gate.sh + "
            "enforce-workflow-verify-stage.sh DEV_SET + gate-audit.sh SQL IN-lists) "
            "with the DEV roster (transactional: .bak + atomic write + cross-file "
            "rollback; acquires the single-owner mutation lock)"
        ),
    )
    p_sync_gate.set_defaults(func=_handle_sync_gate_roster)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point — parse, run the dispatched handler, map errors to exits."""
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except ValidationError as exc:
        print(f"HALT: {exc}", file=sys.stderr)
        return EXIT_HALT


if __name__ == "__main__":
    raise SystemExit(main())
