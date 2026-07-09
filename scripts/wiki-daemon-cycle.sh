#!/usr/bin/env bash
# Wiki daemon entry.
#
# Invoked once per /loop wakeup by the entry prompt. Runs three stages
# in sequence (each independent — failure of one logs but does not abort
# the next):
#
#   1. cycle      — raw → Haiku proposal → classify → master-index sync
#                   (implemented in wiki_daemon_cycle.py).
#                   Produces compilations[] in today's JSON.
#   2. dedup      — heuristic + Haiku duplicate cluster detection across
#                   wiki/notes/. ALL proposals dry-run; no auto-merges.
#                   (wiki-dedup.sh) — appends dedup_proposals[].
#   3. deadlinks  — broken [[wikilink]] + relative md link scan; single
#                   fuzzy match (≥0.85) auto-fixed in-place; ambiguous
#                   cases reported only. (wiki-deadlinks.sh) — appends
#                   deadlink_results[].
#
# All three stages share the same daily JSON
# (daemon-reports/wiki-<date>.json) so downstream consumers see one
# unified report.
#
# Usage:
#     wiki-daemon-cycle.sh                    # full cycle (default): cycle → dedup → deadlinks
#     wiki-daemon-cycle.sh --full-cycle       # explicit alias for default
#     wiki-daemon-cycle.sh --cycle-only       # cycle only (legacy behavior)
#     wiki-daemon-cycle.sh --dedup-only       # dedup only (against today's existing JSON)
#     wiki-daemon-cycle.sh --deadlinks-only   # deadlinks only
#     wiki-daemon-cycle.sh --dry-run          # propagate dry-run to all stages
#     wiki-daemon-cycle.sh --limit N          # cap raw files per cycle (default 0=unbounded)
#     wiki-daemon-cycle.sh --skip-haiku       # use stubbed proposals (no LLM call)
#     wiki-daemon-cycle.sh --skip-sync        # cycle generates report but no wiki-sync
#     wiki-daemon-cycle.sh --self-test        # run inline classify unit tests
#     wiki-daemon-cycle.sh --out PATH         # atomic write to PATH
#                                             # (default: daemon-reports/wiki-<date>.json)
#     wiki-daemon-cycle.sh --force-master-index
#                                             # Accepted but redundant: the cycle
#                                             # always invokes `wiki-sync.sh
#                                             # --force-index` via wiki_daemon_cycle.py.
#                                             # Kept for backward-compat with older
#                                             # entry prompts.
#
# Exits 0 even when no raws are processed (empty arrays are valid).
# Non-zero exits indicate a tooling failure (python3 missing, bad args, etc.).
# Individual stage failures do NOT propagate — each is logged and the
# pipeline continues. Final exit is always 0 unless argparse/setup fails.

set -Eeuo pipefail
IFS=$'\n\t'

# This wrapper only orchestrates sub-stages (wiki_daemon_cycle.py, wiki-dedup.sh,
# wiki-deadlinks.sh) and writes no JSON itself — OUT_PATH is the shared aggregation
# path they consume. The dual-write block below reads the completed JSON and pushes
# the aggregate to PG core.daemon_runs(wiki); the wiki-*.json write lives in the
# sub-stages (wiki_daemon_cycle.py emit_report + wiki-dedup.sh / wiki-deadlinks.sh).
# Resolve script + module paths

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY_MODULE="${SCRIPT_DIR}/wiki_daemon_cycle.py"
DEDUP_SH="${SCRIPT_DIR}/wiki-dedup.sh"
DEADLINKS_SH="${SCRIPT_DIR}/wiki-deadlinks.sh"
LOCK_SCRIPT="${SCRIPT_DIR}/wiki-lock.sh"

# WIKI_ROOT: single source of truth for the wiki data root. Default = the
# glass-atrium store. The python module's DEFAULT_WIKI_ROOT also reads this env
# (the authoritative seam); threading --wiki-root explicitly below is the
# belt-and-suspenders forward. Exported so sub-stage wrappers inherit it.
WIKI_ROOT="${WIKI_ROOT:-${HOME}/.glass-atrium/wiki}"
export WIKI_ROOT

if [[ ! -f "${PY_MODULE}" ]]; then
    printf '[wiki-daemon-cycle] FATAL: missing %s\n' "${PY_MODULE}" >&2
    exit 2
fi

# Parse CLI args

LIMIT="${WIKI_DAEMON_LIMIT:-0}"
DRY_RUN=0
OUT_PATH=""
SELF_TEST=0
EXTRA_ARGS=()
STAGE_MODE="full"  # full | cycle | dedup | deadlinks

while [[ $# -gt 0 ]]; do
    case "$1" in
        --limit)
            LIMIT="${2:?--limit requires a value}"
            shift 2
            ;;
        --limit=*)
            LIMIT="${1#--limit=}"
            shift
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --skip-haiku)
            EXTRA_ARGS+=("--skip-haiku")
            shift
            ;;
        --skip-sync)
            EXTRA_ARGS+=("--skip-sync")
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
        --full-cycle)
            STAGE_MODE="full"
            shift
            ;;
        --cycle-only)
            STAGE_MODE="cycle"
            shift
            ;;
        --dedup-only)
            STAGE_MODE="dedup"
            shift
            ;;
        --deadlinks-only)
            STAGE_MODE="deadlinks"
            shift
            ;;
        --force-master-index)
            # No-op alias. wiki_daemon_cycle.py ALWAYS calls
            # `wiki-sync.sh --force-index` per cycle, so this flag is
            # semantically already the default. Accepted to keep legacy entry
            # prompts (wiki-daemon-entry-prompt.md) from fataling.
            shift
            ;;
        -h|--help)
            sed -n '2,40p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            printf '[wiki-daemon-cycle] FATAL: unknown arg: %s\n' "$1" >&2
            exit 2
            ;;
    esac
done

# Validate --limit (non-negative integer; 0=unbounded — mirrors autoagent daemon-cycle.sh).
if ! [[ "${LIMIT}" =~ ^[0-9]+$ ]]; then
    printf '[wiki-daemon-cycle] FATAL: --limit must be a non-negative integer, 0=unbounded (got %s)\n' \
        "${LIMIT}" >&2
    exit 2
fi

# Locate python3

PYTHON_BIN="${WIKI_DAEMON_PYTHON_BIN:-python3}"
if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
    printf '[wiki-daemon-cycle] FATAL: %s not found on PATH\n' "${PYTHON_BIN}" >&2
    exit 3
fi

# Self-test short-circuit

if [[ "${SELF_TEST}" -eq 1 ]]; then
    exec "${PYTHON_BIN}" "${PY_MODULE}" --self-test
fi

# Resolve output destination

CYCLE_DATE="$(date -u +%Y-%m-%d)"
CYCLE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REPORTS_DIR="${HOME}/.claude/data/daemon-reports"
DEFAULT_REPORT_PATH="${REPORTS_DIR}/wiki-${CYCLE_DATE}.json"

if [[ "${DRY_RUN}" -eq 1 ]]; then
    OUT_PATH="${OUT_PATH:-/tmp/wiki-daemon-cycle-${CYCLE_DATE}.dryrun.json}"
    # Dry-run forces both Haiku and sync to be skipped (cost + side-effect free).
    EXTRA_ARGS+=("--skip-haiku" "--skip-sync")
else
    OUT_PATH="${OUT_PATH:-${DEFAULT_REPORT_PATH}}"
fi

# Ensure reports directory exists for non-dry-run paths.
mkdir -p "$(dirname "${OUT_PATH}")"

# Stage runners
#
# Each stage runs with `set +e` locally so a non-zero exit doesn't abort the
# pipeline — we capture and report it instead. Stages share OUT_PATH so the
# JSON accumulates compilations + dedup_proposals + deadlink_results in a
# single file per cycle.

run_cycle_stage() {
    local rc=0
    local args=("--wiki-root" "${WIKI_ROOT}" "--limit" "${LIMIT}" "--out" "${OUT_PATH}")
    if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
        args+=("${EXTRA_ARGS[@]}")
    fi
    "${PYTHON_BIN}" "${PY_MODULE}" "${args[@]}" || rc=$?
    if [[ "${rc}" -eq 0 ]]; then
        printf '[wiki-daemon-cycle] stage=cycle rc=0 report=%s\n' "${OUT_PATH}" >&2
    else
        printf '[wiki-daemon-cycle] stage=cycle rc=%d FAILED (continuing)\n' "${rc}" >&2
    fi
    return "${rc}"
}

run_dedup_stage() {
    if [[ ! -x "${DEDUP_SH}" ]]; then
        printf '[wiki-daemon-cycle] stage=dedup SKIP: %s not executable\n' "${DEDUP_SH}" >&2
        return 0
    fi
    local rc=0
    # dedup writes to the same OUT_PATH (its --out maps to --out-json inside the
    # Python module, which appends dedup_proposals[]).
    local args=("--out" "${OUT_PATH}")
    if [[ "${DRY_RUN}" -eq 1 ]]; then
        args+=("--dry-run")
    fi
    "${DEDUP_SH}" "${args[@]}" || rc=$?
    if [[ "${rc}" -eq 0 ]]; then
        printf '[wiki-daemon-cycle] stage=dedup rc=0\n' >&2
    else
        printf '[wiki-daemon-cycle] stage=dedup rc=%d (continuing)\n' "${rc}" >&2
    fi
    return "${rc}"
}

run_deadlinks_stage() {
    if [[ ! -x "${DEADLINKS_SH}" ]]; then
        printf '[wiki-daemon-cycle] stage=deadlinks SKIP: %s not executable\n' \
            "${DEADLINKS_SH}" >&2
        return 0
    fi
    local rc=0
    # deadlink results also merge into OUT_PATH (deadlink_results[] key).
    local args=("--out" "${OUT_PATH}")
    if [[ "${DRY_RUN}" -eq 1 ]]; then
        # the deadlinks dry-run flag is named --dry-run-all (no auto-fix writes).
        args+=("--dry-run-all")
    fi
    "${DEADLINKS_SH}" "${args[@]}" || rc=$?
    if [[ "${rc}" -eq 0 ]]; then
        printf '[wiki-daemon-cycle] stage=deadlinks rc=0\n' >&2
    else
        printf '[wiki-daemon-cycle] stage=deadlinks rc=%d (continuing)\n' "${rc}" >&2
    fi
    return "${rc}"
}

# Concurrency guard (wiki-compile lock)
#
# Share the SAME lock name as the 04:50 cron (wiki-daily-compile.sh) so a /loop
# tick and the cron mutually exclude: both contend for the date-keyed OUT_PATH
# JSON and the core.daemon_runs(wiki) UPSERT. (The wiki-sync stage's own
# wiki-sync lock only serializes index regeneration, a strict subset.) Held by
# the cron → skip this cycle (exit 0); the cron's run is authoritative for the
# day. Short 5s timeout mirrors the cron — a held lock means real concurrent
# work, not a slow acquire worth queueing behind.

if [[ -x "${LOCK_SCRIPT}" ]]; then
    if ! "${LOCK_SCRIPT}" acquire wiki-compile 5; then
        printf '[wiki-daemon-cycle] another run holds wiki-compile lock — skipping cycle pid=%s\n' \
            "$$" >&2
        exit 0
    fi
    trap '"${LOCK_SCRIPT}" release wiki-compile 2>/dev/null || true' EXIT INT TERM
    # wiki-compile is non-reentrant: the dedup + deadlinks sub-stages each `with
    # wiki-compile` self-lock, so re-acquiring this ancestor-held lock would block
    # to timeout and skip the stage silently. This flag tells children the ancestor
    # already serializes them → run the inner command directly. Exported ONLY on a
    # real successful acquire so a standalone child invocation still self-locks.
    export WIKI_COMPILE_LOCK_HELD=1
fi

# Dispatch

set +e
case "${STAGE_MODE}" in
    full)
        run_cycle_stage
        run_dedup_stage
        run_deadlinks_stage
        ;;
    cycle)
        run_cycle_stage
        ;;
    dedup)
        run_dedup_stage
        ;;
    deadlinks)
        run_deadlinks_stage
        ;;
    *)
        printf '[wiki-daemon-cycle] FATAL: unknown stage mode: %s\n' "${STAGE_MODE}" >&2
        exit 2
        ;;
esac
set -e

# After all stages write OUT_PATH (the daily JSON), mirror an aggregate row into
# core.daemon_runs(daemon_name='wiki') + the full JSON into core.daemon_run_payload.
# Skip on dry-run or when the report file is absent (cycle failed before writing).
# Helper swallows failures (fail-loud-and-skip); pg_rc captured separately so the
# start/end/rc trace surfaces in the loop log while || true is preserved.
PG_PUSH_PY="${SCRIPT_DIR}/_pg_push_wiki_cycle.py"
if [[ "${DRY_RUN}" -eq 0 && -f "${OUT_PATH}" && -f "${PG_PUSH_PY}" ]]; then
    printf '[wiki-daemon-cycle] PG_PUSH start out=%s date=%s started=%s\n' \
        "${OUT_PATH}" "${CYCLE_DATE}" "${CYCLE_STARTED_AT}" >&2
    pg_rc=0
    OUT_PATH="${OUT_PATH}" \
        CYCLE_DATE="${CYCLE_DATE}" \
        CYCLE_STARTED_AT="${CYCLE_STARTED_AT}" \
        "${PYTHON_BIN}" "${PG_PUSH_PY}" || pg_rc=$?
    printf '[wiki-daemon-cycle] PG_PUSH end rc=%d\n' "${pg_rc}" >&2
else
    # 5-field skip reason (parity with autoagent daemon-cycle.sh).
    out_size_label="missing"
    if [[ -e "${OUT_PATH}" ]]; then
        if [[ -s "${OUT_PATH}" ]]; then
            out_size_label="nonzero"
        else
            out_size_label="empty"
        fi
    fi
    helper_label="missing"
    if [[ -f "${PG_PUSH_PY}" ]]; then
        helper_label="present"
    fi
    printf '[wiki-daemon-cycle] PG_PUSH SKIP dry=%d out_size=%s helper=%s out=%s\n' \
        "${DRY_RUN}" "${out_size_label}" "${helper_label}" "${OUT_PATH}" >&2
fi

exit 0
