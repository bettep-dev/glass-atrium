#!/usr/bin/env bash
# wiki-dedup.sh — W5: Duplicate wiki note detection + merge proposals.
#
# Scans wiki/notes/*.md, applies heuristic pre-filter (Jaccard slug tokens +
# sentence overlap), then invokes Haiku (≤5 calls/cycle) to verify candidate
# duplicate clusters.  ALL proposals are dry-run — user decision required;
# no auto-merges.
#
# Usage:
#     wiki-dedup.sh                         # detect + LLM verify + append to today's JSON
#     wiki-dedup.sh --skip-llm              # heuristic only (no Haiku call)
#     wiki-dedup.sh --dry-run               # implies --skip-llm; no JSON mutation
#     wiki-dedup.sh --notes-dir /tmp/...    # override notes directory (testing)
#     wiki-dedup.sh --out PATH              # override output JSON path
#     wiki-dedup.sh --max-llm-calls N       # override cost guard (default 5)
#     wiki-dedup.sh --self-test             # run Python inline unit tests
#
# Shared lock: wiki-compile (prevents concurrent W5/W6/W3+W4 writes).
# Exit 0 even when no duplicates found (empty proposals array is valid).
# Non-zero exits indicate tooling failure.

set -Eeuo pipefail
IFS=$'\n\t'

# -- Resolve paths -----------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY_MODULE="${SCRIPT_DIR}/wiki_dedup.py"

# shellcheck source=lib/wiki-compile-lock.sh
source "${SCRIPT_DIR}/lib/wiki-compile-lock.sh"

# WIKI_ROOT: single source of truth for the wiki data root (default = glass-atrium store).
# The python module's DEFAULT_WIKI_ROOT reads the same env (authoritative seam); --wiki-root below is the explicit forward.
WIKI_ROOT="${WIKI_ROOT:-${HOME}/.glass-atrium/wiki}"

if [[ ! -f "${PY_MODULE}" ]]; then
    printf '[wiki-dedup] FATAL: missing Python module %s\n' "${PY_MODULE}" >&2
    exit 2
fi

# Parse CLI args

SKIP_LLM=0
DRY_RUN=0
NOTES_DIR_OVERRIDE=""
OUT_PATH=""
MAX_LLM_CALLS=5
SELF_TEST=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-llm)
            SKIP_LLM=1
            shift
            ;;
        --dry-run)
            DRY_RUN=1
            SKIP_LLM=1
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
        --max-llm-calls)
            MAX_LLM_CALLS="${2:?--max-llm-calls requires a value}"
            shift 2
            ;;
        --max-llm-calls=*)
            MAX_LLM_CALLS="${1#--max-llm-calls=}"
            shift
            ;;
        --self-test)
            SELF_TEST=1
            shift
            ;;
        -h|--help)
            sed -n '2,28p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            printf '[wiki-dedup] FATAL: unknown argument: %s\n' "$1" >&2
            exit 2
            ;;
    esac
done

# Validate --max-llm-calls.
if ! [[ "${MAX_LLM_CALLS}" =~ ^[0-9]+$ ]]; then
    printf '[wiki-dedup] FATAL: --max-llm-calls must be a non-negative integer (got %s)\n' \
        "${MAX_LLM_CALLS}" >&2
    exit 2
fi

# Python binary

PYTHON_BIN="${WIKI_DAEMON_PYTHON_BIN:-python3}"
if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
    printf '[wiki-dedup] FATAL: %s not found on PATH\n' "${PYTHON_BIN}" >&2
    exit 3
fi

# Self-test short-circuit

if [[ "${SELF_TEST}" -eq 1 ]]; then
    exec "${PYTHON_BIN}" "${PY_MODULE}" --self-test
fi

# Resolve output JSON path

CYCLE_DATE="$(date -u +%Y-%m-%d)"
REPORTS_DIR="${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/daemon-reports"

if [[ "${DRY_RUN}" -eq 1 ]]; then
    OUT_PATH="${OUT_PATH:-/tmp/wiki-dedup-${CYCLE_DATE}.dryrun.json}"
else
    OUT_PATH="${OUT_PATH:-${REPORTS_DIR}/wiki-${CYCLE_DATE}.json}"
fi

# Ensure reports dir exists (no-op if present).
mkdir -p "${REPORTS_DIR}"

# Build Python argument list

PY_ARGS=("--wiki-root" "${WIKI_ROOT}" "--out-json" "${OUT_PATH}" "--max-llm-calls" "${MAX_LLM_CALLS}")

if [[ "${SKIP_LLM}" -eq 1 ]]; then
    PY_ARGS+=("--skip-llm")
fi

if [[ -n "${NOTES_DIR_OVERRIDE}" ]]; then
    PY_ARGS+=("--notes-dir" "${NOTES_DIR_OVERRIDE}")
fi

# Acquire shared lock + run

set +e
run_under_compile_lock wiki-dedup -- "${PYTHON_BIN}" "${PY_MODULE}" "${PY_ARGS[@]}"
RC=$?
set -e

if [[ "${RC}" -eq 0 ]]; then
    printf '[wiki-dedup] stage=w5 rc=0 report=%s\n' "${OUT_PATH}" >&2
else
    printf '[wiki-dedup] stage=w5 rc=%d FAILED\n' "${RC}" >&2
fi

exit "${RC}"
