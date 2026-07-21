#!/usr/bin/env bash
# wiki-deadlinks.sh — W6: Dead wikilink detection + safe auto-fix.
#
# Scans all wiki/notes/*.md for broken [[wikilinks]] and relative markdown
# links.  For each broken link:
#   * Single fuzzy match (similarity ≥ 0.85) → auto-fix link in-place.
#   * 0 or 2+ matches → dry-run (report only; no write).
# Also checks frontmatter 'category' against topic-map.md; mismatches → dry-run.
#
# Auto-fixes write ONLY to wiki/notes/*.md.  NEVER touches wiki/raw/.
# Pure heuristic — no LLM calls.
#
# Usage:
#     wiki-deadlinks.sh                     # scan + auto-fix + append to today's JSON
#     wiki-deadlinks.sh --dry-run-all       # report only; no auto-fix writes
#     wiki-deadlinks.sh --notes-dir /tmp/   # override notes directory (testing)
#     wiki-deadlinks.sh --out PATH          # override output JSON path
#     wiki-deadlinks.sh --self-test         # run Python inline unit tests
#
# Shared lock: wiki-compile (prevents concurrent W5/W6/W3+W4 writes).
# Exit 0 even when no broken links found.
# Non-zero exits indicate tooling failure.

set -Eeuo pipefail
IFS=$'\n\t'

# -- Resolve paths -----------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY_MODULE="${SCRIPT_DIR}/wiki_deadlinks.py"

# shellcheck source=lib/wiki-compile-lock.sh
source "${SCRIPT_DIR}/lib/wiki-compile-lock.sh"

# WIKI_ROOT: single source of truth for the wiki data root (default = glass-atrium store).
# The python module's DEFAULT_WIKI_ROOT reads the same env (authoritative seam); --wiki-root
# below is the explicit forward. A --notes-dir override still wins (python: wiki_root=notes_dir.parent).
WIKI_ROOT="${WIKI_ROOT:-${HOME}/.glass-atrium/wiki}"

if [[ ! -f "${PY_MODULE}" ]]; then
    printf '[wiki-deadlinks] FATAL: missing Python module %s\n' "${PY_MODULE}" >&2
    exit 2
fi

# Parse CLI args

DRY_RUN_ALL=0
NOTES_DIR_OVERRIDE=""
OUT_PATH=""
SELF_TEST=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run-all)
            DRY_RUN_ALL=1
            shift
            ;;
        --notes-dir)
            NOTES_DIR_OVERRIDE="${2:?--notes-dir requires a value}"
            shift 2
            ;;
        --notes-dir=*)
            NOTES_DIR_OVERRIDE="${1#--notes-dir=}"
            shift
            ;;
        --out)
            OUT_PATH="${2:?--out requires a value}"
            shift 2
            ;;
        --out=*)
            OUT_PATH="${1#--out=}"
            shift
            ;;
        --self-test)
            SELF_TEST=1
            shift
            ;;
        -h|--help)
            sed -n '2,30p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            printf '[wiki-deadlinks] FATAL: unknown argument: %s\n' "$1" >&2
            exit 2
            ;;
    esac
done

# Python binary

PYTHON_BIN="${WIKI_DAEMON_PYTHON_BIN:-python3}"
if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
    printf '[wiki-deadlinks] FATAL: %s not found on PATH\n' "${PYTHON_BIN}" >&2
    exit 3
fi

# Self-test short-circuit

if [[ "${SELF_TEST}" -eq 1 ]]; then
    exec "${PYTHON_BIN}" "${PY_MODULE}" --self-test
fi

# Resolve output JSON path

CYCLE_DATE="$(date -u +%Y-%m-%d)"
REPORTS_DIR="${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/daemon-reports"

if [[ "${DRY_RUN_ALL}" -eq 1 ]]; then
    OUT_PATH="${OUT_PATH:-/tmp/wiki-deadlinks-${CYCLE_DATE}.dryrun.json}"
else
    OUT_PATH="${OUT_PATH:-${REPORTS_DIR}/wiki-${CYCLE_DATE}.json}"
fi

# Ensure reports dir exists.
mkdir -p "${REPORTS_DIR}"

# Build Python argument list

PY_ARGS=("--wiki-root" "${WIKI_ROOT}" "--out-json" "${OUT_PATH}")

if [[ "${DRY_RUN_ALL}" -eq 1 ]]; then
    PY_ARGS+=("--dry-run-all")
fi

if [[ -n "${NOTES_DIR_OVERRIDE}" ]]; then
    PY_ARGS+=("--notes-dir" "${NOTES_DIR_OVERRIDE}")
fi

# Acquire shared lock + run

set +e
run_under_compile_lock wiki-deadlinks -- "${PYTHON_BIN}" "${PY_MODULE}" "${PY_ARGS[@]}"
RC=$?
set -e

if [[ "${RC}" -eq 0 ]]; then
    printf '[wiki-deadlinks] stage=w6 rc=0 report=%s\n' "${OUT_PATH}" >&2
else
    printf '[wiki-deadlinks] stage=w6 rc=%d FAILED\n' "${RC}" >&2
fi

exit "${RC}"
