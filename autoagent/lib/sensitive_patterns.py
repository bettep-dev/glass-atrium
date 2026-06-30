"""Sensitive-file refusal helper for the Glass Atrium update skill (T15 / gate G7).

The update skill (a shell pipeline) MUST refuse to sync a sensitive harness file
— GLOBAL_RULES, the security scope rules, a credential file, a launchd plist, or
a diff body carrying an irreversible/external-effect command. The refusal set is
defined ONCE, as the compiled regex tuples in ``daemon_cycle.py``
(``_SAFETY_SENSITIVE_PATH_PATTERNS`` / ``_SAFETY_SENSITIVE_DIFF_PATTERNS``).

This module is the single bridge the shell shells out to: it IMPORTS those
compiled patterns (via ``daemon_cycle.match_sensitive_path`` /
``match_sensitive_diff``) and exposes both an importable API and a thin CLI. The
patterns are NEVER re-expressed as a shell-ERE data file — a shell-regex dialect
would silently diverge from Python's ``re`` (forbidden re-implementation), so the
daemon and the skill provably refuse the SAME set.

CLI (the shell-out contract):
    python3 sensitive_patterns.py path <PATH>      # test one path
    python3 sensitive_patterns.py diff [FILE]      # test a unified diff
                                                   # FILE omitted or '-' → stdin

Exit codes (loud-fail per shared-self-improve-hygiene Precondition Loud-Fail):
    0  CLEAN      — not sensitive, safe to proceed
    3  SENSITIVE  — refuse; the matched pattern + reason printed to stderr
    2  USAGE      — bad invocation (argparse)
    4  ENV        — daemon_cycle import failed (the compiled source is unreachable)

Importable API:
    is_sensitive_path(path)  -> str | None   # matched pattern source, or None
    is_sensitive_diff(diff)  -> str | None   # matched pattern source, or None
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# daemon_cycle.py lives in the autoagent root, one level up from this lib/ dir.
# Add it to the path so the compiled patterns import cleanly regardless of the
# caller's CWD (the shell shells out from arbitrary working directories).
_AUTOAGENT_ROOT = Path(__file__).resolve().parent.parent
if str(_AUTOAGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AUTOAGENT_ROOT))

# Named exit codes — the shell wiring branches on these.
EXIT_CLEAN = 0
EXIT_SENSITIVE = 3
EXIT_USAGE = 2
EXIT_ENV = 4


def _import_matchers() -> tuple[object, object]:
    """Import the compiled-pattern matchers from daemon_cycle (the single source).

    Isolated so a failed import becomes a loud EXIT_ENV at the CLI boundary
    rather than a bare ImportError traceback — the compiled patterns being
    unreachable is a precondition failure, not a usage error.
    """
    import daemon_cycle  # noqa: PLC0415 — deferred so import failure is loud-handled

    return daemon_cycle.match_sensitive_path, daemon_cycle.match_sensitive_diff


def is_sensitive_path(path: str) -> str | None:
    """Return the matched sensitive-path pattern source, or ``None`` if clean.

    Thin re-export of ``daemon_cycle.match_sensitive_path`` — the daemon owns the
    compiled tuple; this module is the stable API the shell consumes.
    """
    match_path, _ = _import_matchers()
    return match_path(path)  # type: ignore[operator]


def is_sensitive_diff(diff: str) -> str | None:
    """Return the matched sensitive-diff pattern source (added lines only), or
    ``None`` if clean. Thin re-export of ``daemon_cycle.match_sensitive_diff``.
    """
    _, match_diff = _import_matchers()
    return match_diff(diff)  # type: ignore[operator]


def _refuse(kind: str, subject: str, pattern: str) -> int:
    """Print a loud refusal line and return EXIT_SENSITIVE."""
    sys.stderr.write(
        f"sensitive_patterns: REFUSED — {kind} matched a sensitive-refusal "
        f"pattern /{pattern}/\n"
        f"  subject: {subject}\n"
        "  the update skill will NOT sync this (GLOBAL_RULES / security rule / "
        "credential / launchd / irreversible command).\n"
    )
    return EXIT_SENSITIVE


def _cmd_path(path: str) -> int:
    try:
        hit = is_sensitive_path(path)
    except Exception as exc:  # noqa: BLE001 — import/runtime failure → loud EXIT_ENV
        sys.stderr.write(f"sensitive_patterns: cannot reach compiled source: {exc}\n")
        return EXIT_ENV
    if hit is not None:
        return _refuse("path", path, hit)
    return EXIT_CLEAN


def _cmd_diff(source: str) -> int:
    try:
        if source in ("", "-"):
            diff = sys.stdin.read()
            label = "<stdin>"
        else:
            diff = Path(source).read_text(encoding="utf-8")
            label = source
    except OSError as exc:
        sys.stderr.write(f"sensitive_patterns: cannot read diff source: {exc}\n")
        return EXIT_USAGE
    try:
        hit = is_sensitive_diff(diff)
    except Exception as exc:  # noqa: BLE001 — import/runtime failure → loud EXIT_ENV
        sys.stderr.write(f"sensitive_patterns: cannot reach compiled source: {exc}\n")
        return EXIT_ENV
    if hit is not None:
        return _refuse("diff", label, hit)
    return EXIT_CLEAN


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="sensitive_patterns.py",
        description="Test a path or unified diff against the compiled "
        "sensitive-refusal patterns owned by daemon_cycle.py.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_path = sub.add_parser("path", help="test a single file path")
    p_path.add_argument("path", help="file path to test")

    p_diff = sub.add_parser("diff", help="test a unified diff (added lines)")
    p_diff.add_argument(
        "file",
        nargs="?",
        default="-",
        help="diff file to read; omit or '-' to read stdin",
    )

    args = parser.parse_args(argv)

    if args.command == "path":
        return _cmd_path(args.path)
    if args.command == "diff":
        return _cmd_diff(args.file)
    # argparse `required=True` makes this unreachable; defensive only.
    parser.print_usage(sys.stderr)
    return EXIT_USAGE


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
