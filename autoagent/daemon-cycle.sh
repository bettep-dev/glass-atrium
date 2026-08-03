#!/usr/bin/env bash
# AutoAgent daemon entry — pre-verify pipeline + aggregator.
#
# Invoked once per /loop wakeup. Runs stages in sequence; each is independent
# (one stage's failure logs but does not abort the next):
#
#   1. cycle        — pattern → outcomes → Haiku patch → classification →
#                     pre-verify (4-axis review per body-auto patch) → JSON.
#                     Pre-verify is embedded inside the cycle stage so each
#                     patch carries its `pre_verify_passed`/`approval_tier`
#                     fields by the time it lands in the JSON report.
#   2. pre-verify   — banner-only stub; the real gate runs inside the cycle
#                     stage. Exists so external callers have a named stage.
#   2b.regen-stale  — batch sweep: re-derive each stale pending proposal's diff
#                     against the current agent file (difflib, no Haiku cost) +
#                     pre-verify gate validate + UPDATE proposed_diff only. Runs BETWEEN
#                     pg-push and apply in `full` mode so the same cycle's apply
#                     drains the freshened rows — prevents stale proposals from
#                     fossilizing as pending forever.
#   3. apply        — read today's JSON, auto-apply only patches whose
#                     pre_verify_passed=true with git WIP+APPLY commits.
#                     Unverified patches stay in the PG pending queue.
#   4. aggregate    — scan outcomes/ since last state mtime, append patterns to
#                     core-learning-log.md + feedback clusters.
#
# Usage:
#     daemon-cycle.sh                     # full cycle (default): cycle+pre-verify+apply+aggregate
#     daemon-cycle.sh --cycle-only        # M3+M4+pre-verify only (legacy behavior)
#     daemon-cycle.sh --pre-verify-only   # banner only — pre-verify runs inside cycle
#     daemon-cycle.sh --apply-only        # M5 only (against today's existing JSON)
#     daemon-cycle.sh --regression-only   # DEPRECATED no-op — emits warning, exits 0
#     daemon-cycle.sh --aggregate-only    # learning-aggregator.py only
#     daemon-cycle.sh --full-cycle        # explicit alias for default
#     daemon-cycle.sh --dry-run           # propagate dry-run to all stages
#                                         # (also implies --skip-pre-verify on cycle stage)
#     daemon-cycle.sh --limit N           # pattern limit
#                                         # (default 0 = unbounded, process all; N>0 caps)
#     daemon-cycle.sh --apply-limit N     # per-cycle apply cap
#                                         # (default 0 = unbounded, drain all; N>0 caps)
#     daemon-cycle.sh --out PATH          # atomic JSON write to PATH
#                                         # (otherwise → daemon-reports/<date>.json)
#
# JSON is written via --out internally. All human-readable per-stage status
# lines go to STDERR (`>&2`), NOT stdout — STDOUT carries no status. The
# canonical run log is the launchd-redirected sink (the plist points
# StandardOutPath/StandardErrorPath at /tmp/autoagent-daemon-loop.log), NOT the
# launchd StandardOutPath as a separate phantom file. Inspect that single sink
# for a run trace.
#
# Exit codes:
#     0 — all dispatched stages succeeded (clean cycle)
#     1 — partial failure: the cycle completed but at least one dispatched stage
#         returned non-zero (degraded run — each stage is independent and logs
#         its own rc, but the aggregate surfaces here so launchd/monitoring can
#         distinguish a degraded cycle from a clean one)
#     2 — argument error / unknown stage mode
#     3 — python3 not found on PATH
#     4 — claude binary not found on PATH/known locations

set -euo pipefail
IFS=$'\n\t'

# -- Resolve absolute path to `claude` CLI ---------------------------------
# daemon_cycle.py reads AUTOAGENT_CLAUDE_BIN (default "claude") and subprocess-
# invokes it. Under launchd-spawned env, PATH may lack /opt/homebrew/bin or
# /usr/local/bin → bare `claude` → ENOENT → cycle falsely reports PARTIAL.
# Export an absolute path with a loud-fail fallback chain so daemon_cycle.py +
# inline subshells see it regardless of inherited PATH.
# Loud-fail: no swallowing on the detection path; missing binary = exit 4
# (precondition violation) + stderr + log surface for monitor alerting.
if [[ -z "${AUTOAGENT_CLAUDE_BIN:-}" ]]; then
    # Prefer PATH resolution if claude is on PATH; otherwise try known
    # install locations in priority order (Homebrew Apple Silicon →
    # Homebrew Intel → manual install).
    if command -v claude >/dev/null 2>&1; then
        AUTOAGENT_CLAUDE_BIN="$(command -v claude)"
    elif [[ -x /opt/homebrew/bin/claude ]]; then
        AUTOAGENT_CLAUDE_BIN="/opt/homebrew/bin/claude"
    elif [[ -x /usr/local/bin/claude ]]; then
        AUTOAGENT_CLAUDE_BIN="/usr/local/bin/claude"
    else
        printf '[daemon-cycle] FATAL: claude binary not found on PATH or known locations (PATH=%s)\n' \
            "${PATH}" >&2
        printf '[daemon-cycle] FATAL: tried command -v claude, /opt/homebrew/bin/claude, /usr/local/bin/claude\n' >&2
        exit 4
    fi
fi
# Re-export for daemon_cycle.py + any subshell (curl/jq/inline) downstream.
# `CLAUDE_BIN` alias preserved for any shell-side caller that expects the
# shorter name (no current caller, but cheap to provide).
export AUTOAGENT_CLAUDE_BIN
export CLAUDE_BIN="${AUTOAGENT_CLAUDE_BIN}"

# -- Headless claude auth (launchd keychain-bypass) ------------------------
# A launchd-spawned `claude -p` (non-GUI session) authenticating ONLY via the
# GUI macOS Keychain OAuth item returns 401; the env token bypasses it. Source
# the 0600 secrets file (render-claude-auth.sh output) so CLAUDE_CODE_OAUTH_TOKEN
# is exported into daemon_cycle.py's subprocess env (it spawns claude with full
# os.environ inheritance). Absent file → loud WARN + keychain fallback. The lib
# is resolved relative to ~/.glass-atrium/scripts/lib (the canonical store) since
# daemon-cycle.sh's own dir has no shared lib.
CLAUDE_AUTH_ENV_LIB="${HOME}/.glass-atrium/scripts/lib/claude-auth-env.sh"
if [[ -f "${CLAUDE_AUTH_ENV_LIB}" ]]; then
    # Runtime-resolved HOME-anchored path, not statically followable; the `-f`
    # guard above already gates the source. SC1090 (non-constant source) +
    # SC1091 (file-not-found at lint time) are both expected here.
    # shellcheck disable=SC1090,SC1091
    . "${CLAUDE_AUTH_ENV_LIB}"
    claude_auth_load_env
else
    printf '[daemon-cycle] WARN: claude-auth-env lib missing (%s) — keychain auth only\n' \
        "${CLAUDE_AUTH_ENV_LIB}" >&2
fi

# -- Glass Atrium (GA) single-monorepo git target --------------------------
# ~/.claude/{agents,rules,...} are facade dirs whose files symlink → ~/.glass-atrium.
# The self-improvement loop MUST commit into the GA monorepo (~/.glass-atrium/.git),
# NOT the orphaned per-subdir facade repos.
# Export the GA target env so daemon-apply.sh (invoked by run_apply_stage WITHOUT
# --agents-dir) resolves the GA repo by default. daemon-apply.sh re-derives
# GIT_ROOT + the stash pathspec (agents/) from AGENTS_DIR; both are env-overridable
# for tests. Explicit here (not just relying on the apply-side default) so the
# git target is discoverable at the pipeline entry point.
export AUTOAGENT_AGENTS_DIR="${AUTOAGENT_AGENTS_DIR:-${HOME}/.glass-atrium/agents}"
export AUTOAGENT_GIT_ROOT="${AUTOAGENT_GIT_ROOT:-${HOME}/.glass-atrium}"
export AUTOAGENT_GIT_PATHSPEC="${AUTOAGENT_GIT_PATHSPEC:-agents/}"

# -- Resolve script + module paths -----------------------------------------
# Self-resolution: launchd now invokes this script at its store path
# (~/.glass-atrium/autoagent/daemon-cycle.sh) — autoagent/ is consumed in place,
# the ~/.claude/autoagent farm is gone. The walk stays defensive: if BASH_SOURCE
# ever arrives through a symlink, bash never dereferences a file-level symlink,
# so a bare dirname(BASH_SOURCE) would be the link dir, not the real siblings
# (daemon_cycle.py, daemon-apply.sh). Walk the symlink chain in pure bash
# (readlink -f is GNU-only; python3 is not verified until later — exit-3 check).
# Precedent: glass-atrium resolve_self.
resolve_self() {
    local src="${BASH_SOURCE[0]}" dir
    while [[ -L "${src}" ]]; do
        dir="$(cd -- "$(dirname -- "${src}")" >/dev/null 2>&1 && pwd -P)"
        src="$(readlink -- "${src}")"
        [[ "${src}" != /* ]] && src="${dir}/${src}"
    done
    cd -- "$(dirname -- "${src}")" >/dev/null 2>&1 && pwd -P
}
SCRIPT_DIR="$(resolve_self)"
PY_MODULE="${SCRIPT_DIR}/daemon_cycle.py"
APPLY_SH="${SCRIPT_DIR}/daemon-apply.sh"
# DEPRECATED: daemon-regression.sh archived. Variable kept for backward-compat
# with --regression-only callers (now a no-op stub) so external references don't error.
REGRESSION_SH="${SCRIPT_DIR}/archive/daemon-regression-deprecated-2026-05-02.sh"
# Store-root form (same convention as CLAUDE_AUTH_ENV_LIB / PAUSE_FLAG_LIB): hooks
# are consumed in place from the store — ~/.claude/hooks is no longer farmed.
AGGREGATOR_PY="${HOME}/.glass-atrium/hooks/learning-aggregator.py"

if [[ ! -f "${PY_MODULE}" ]]; then
    printf '[daemon-cycle] FATAL: missing %s\n' "${PY_MODULE}" >&2
    exit 2
fi

# -- Parse CLI args --------------------------------------------------------

LIMIT="${AUTOAGENT_DAEMON_LIMIT:-0}"
# Default 0 = unbounded → drain the ENTIRE eligible pending backlog each run.
# 0 maps to daemon-apply.sh's own LIMIT=0 unbounded semantics.
# AUTOAGENT_APPLY_LIMIT env override + --apply-limit N CLI still cap when N>0.
APPLY_LIMIT="${AUTOAGENT_APPLY_LIMIT:-0}"
DRY_RUN=0
OUT_PATH=""
EXTRA_ARGS=()
STAGE_MODE="full"  # full | cycle | apply | regression | aggregate
# Tracks whether the `full` dispatch already ran run_pg_push_stage (between
# cycle and apply) so the tail does NOT push a second time.
FULL_MODE_PG_PUSHED=0

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
        --apply-limit)
            APPLY_LIMIT="${2:?--apply-limit requires a value}"
            shift 2
            ;;
        --apply-limit=*)
            APPLY_LIMIT="${1#--apply-limit=}"
            shift
            ;;
        --dry-run)
            DRY_RUN=1
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
        --skip-haiku)
            EXTRA_ARGS+=("--skip-haiku")
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
        --apply-only)
            STAGE_MODE="apply"
            shift
            ;;
        --regression-only)
            STAGE_MODE="regression"
            shift
            ;;
        --aggregate-only)
            STAGE_MODE="aggregate"
            shift
            ;;
        -h|--help)
            sed -n '2,30p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            printf '[daemon-cycle] FATAL: unknown arg: %s\n' "$1" >&2
            exit 2
            ;;
    esac
done

# Validate limits.
if ! [[ "${LIMIT}" =~ ^[0-9]+$ ]]; then
    printf '[daemon-cycle] FATAL: --limit must be a non-negative integer, 0=unbounded (got %s)\n' \
        "${LIMIT}" >&2
    exit 2
fi
if ! [[ "${APPLY_LIMIT}" =~ ^[0-9]+$ ]]; then
    printf '[daemon-cycle] FATAL: --apply-limit must be a non-negative integer (got %s)\n' \
        "${APPLY_LIMIT}" >&2
    exit 2
fi

# -- Resolve output destination --------------------------------------------

CYCLE_DATE="$(date -u +%Y-%m-%d)"
CYCLE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REPORTS_DIR="${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/daemon-reports"
DEFAULT_REPORT_PATH="${REPORTS_DIR}/autoagent-${CYCLE_DATE}.json"

if [[ "${DRY_RUN}" -eq 1 ]]; then
    OUT_PATH="${OUT_PATH:-/tmp/autoagent-daemon-cycle-${CYCLE_DATE}.dryrun.json}"
    EXTRA_ARGS+=("--skip-haiku")
else
    OUT_PATH="${OUT_PATH:-${DEFAULT_REPORT_PATH}}"
fi

# -- Locate python3 --------------------------------------------------------

PYTHON_BIN="${AUTOAGENT_PYTHON_BIN:-python3}"
if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
    printf '[daemon-cycle] FATAL: %s not found on PATH\n' "${PYTHON_BIN}" >&2
    exit 3
fi

# -- Cooperative update pause-flag gate (T10) ------------------------------
# An in-flight Glass Atrium update HOLDS a pause flag while it swaps files; the
# daemon cooperatively SUSPENDS this /loop wakeup so a cycle write never races
# the update's file swap. A STALE flag (crashed updater — SIGKILL/OOM/power-loss,
# beyond trap coverage) is loud-fail cleared by the lib's TTL guard, so the
# daemon + daily-restart instance can NEVER freeze indefinitely. A clean skip is
# exit 0 (NOT a failure). The lib is resolved from ~/.glass-atrium/scripts/lib
# (the canonical store) — daemon-cycle.sh's own dir has no shared lib.
# DAEMON SAFETY: a missing lib degrades to a loud WARN + proceed (never break the
# launchd-live daemon over an absent helper) — same posture as the auth-env lib.
PAUSE_FLAG_LIB="${HOME}/.glass-atrium/scripts/lib/update-pause-flag.sh"
if [[ -f "${PAUSE_FLAG_LIB}" ]]; then
    # Runtime-resolved HOME-anchored path; the `-f` guard gates the source.
    # shellcheck disable=SC1090,SC1091
    . "${PAUSE_FLAG_LIB}"
    if update_pause_is_active; then
        printf '[daemon-cycle] update in progress (pause flag held) — skipping cycle (exit 0)\n' >&2
        exit 0
    fi
else
    printf '[daemon-cycle] WARN: pause-flag lib missing (%s) — proceeding without update-pause gate\n' \
        "${PAUSE_FLAG_LIB}" >&2
fi

# -- Stage runners ---------------------------------------------------------

# Each stage runs with `set +e` locally so a non-zero exit doesn't abort the
# pipeline — we capture and report it instead.

run_cycle_stage() {
    local rc=0
    local args=("--limit" "${LIMIT}" "--out" "${OUT_PATH}")
    if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
        args+=("${EXTRA_ARGS[@]}")
    fi
    "${PYTHON_BIN}" "${PY_MODULE}" ${args[@]+"${args[@]}"} || rc=$?
    if [[ "${rc}" -eq 0 ]]; then
        printf '[daemon-cycle] stage=cycle rc=0 report=%s\n' "${OUT_PATH}" >&2
    else
        printf '[daemon-cycle] stage=cycle rc=%d FAILED\n' "${rc}" >&2
    fi
    return "${rc}"
}

run_apply_stage() {
    if [[ ! -x "${APPLY_SH}" ]]; then
        # A stage that could not run is NOT a stage that ran cleanly: the rc alone cannot tell the
        # two apart, so the composed run status read `ok` for the mode-644 incident this branch
        # covers. The condition travels in its own flag and reaches the operator as a distinct
        # composed token; the rc stays 0 so an install that legitimately ships without the script
        # is a standing warn rather than a permanently degraded exit.
        local why="not executable"
        if [[ ! -e "${APPLY_SH}" ]]; then
            why="absent"
        fi
        APPLY_UNAVAILABLE=1
        printf '[daemon-cycle] stage=apply UNAVAILABLE: %s %s — composing status=%s\n' \
            "${APPLY_SH}" "${why}" "${APPLY_STATUS_UNAVAILABLE_LABEL}" >&2
        return 0
    fi
    local rc=0
    local args=("--limit" "${APPLY_LIMIT}" "--report" "${OUT_PATH}")
    if [[ "${DRY_RUN}" -eq 1 ]]; then
        args+=("--dry-run")
    fi
    "${APPLY_SH}" ${args[@]+"${args[@]}"} || rc=$?
    if [[ "${rc}" -eq 0 ]]; then
        printf '[daemon-cycle] stage=apply rc=0\n' >&2
    else
        printf '[daemon-cycle] stage=apply rc=%d (continuing)\n' "${rc}" >&2
    fi
    return "${rc}"
}

# regenerate-stale batch sweep: re-derive EVERY stale pending proposal's
# diff against the current agent file (difflib — no Haiku cost), validate through
# the pre-verify gate, UPDATE only proposed_diff (does NOT apply — the SAME cycle's apply
# stage drains the freshened rows next). Without this stage, apply-classification
# proposals that went stale (needs_regen) fossilize as pending forever — apply
# would re-skip them every cycle on a stale-diff mismatch.
# In `full` mode runs between run_pg_push_stage and run_apply_stage
# (cycle → pg-push → regenerate-stale → apply) so prior-cycle stale rows get
# fresh diffs that THIS cycle's apply then drains. Mirrors run_apply_stage's
# rc-capture-and-CONTINUE posture — a sweep failure logs + continues to apply
# (the python side loud-fails/re-raises its own PG errors, surfacing via the
# captured rc here).
run_regenerate_stale_stage() {
    local rc=0
    local args=("--regenerate-stale")
    if [[ "${DRY_RUN}" -eq 1 ]]; then
        args+=("--dry-run")
    fi
    "${PYTHON_BIN}" "${PY_MODULE}" ${args[@]+"${args[@]}"} || rc=$?
    if [[ "${rc}" -eq 0 ]]; then
        printf '[daemon-cycle] stage=regenerate-stale rc=0\n' >&2
    else
        printf '[daemon-cycle] stage=regenerate-stale rc=%d (continuing)\n' "${rc}" >&2
    fi
    return "${rc}"
}

run_regression_stage() {
    if [[ ! -x "${REGRESSION_SH}" ]]; then
        printf '[daemon-cycle] stage=regression SKIP: %s not executable\n' "${REGRESSION_SH}" >&2
        return 0
    fi
    local rc=0
    local args=()
    if [[ "${DRY_RUN}" -eq 1 ]]; then
        args+=("--dry-run")
    fi
    "${REGRESSION_SH}" ${args[@]+"${args[@]}"} || rc=$?
    if [[ "${rc}" -eq 0 ]]; then
        printf '[daemon-cycle] stage=regression rc=0\n' >&2
    else
        printf '[daemon-cycle] stage=regression rc=%d (continuing)\n' "${rc}" >&2
    fi
    return "${rc}"
}

# PG_PUSH: OUT_PATH(daily JSON) → core.daemon_runs + core.daemon_run_payload +
# per-patch UPSERT into core.autoagent_proposals.
# Produce-before-consume ordering: the proposals UPSERT MUST run BEFORE
# run_apply_stage so daemon-apply.sh's PG backlog drain (auto-tier + pending)
# sees the same-cycle rows; otherwise same-cycle proposals are absent at apply
# time → 0 applied within their own cycle. In `full` mode sequenced
# cycle → pg-push → apply → aggregate; other modes call it at the tail.
# runs/payload writes read OUT_PATH's already-final stats (apply never mutates
# OUT_PATH), so moving the helper earlier is behavior-preserving for them.
# Skip on dry-run + when the report file is absent or 0-byte (cycle failed).
# The helper attempts every write (never blocks the daemon) but now EXITS
# NON-ZERO when a write fails (DB down); that rc is returned here so the caller
# folds it into PIPELINE_RC and a DB-down cycle surfaces as degraded (DF-16). A
# skip (dry-run / absent report) returns 0 — nothing was pushed, nothing failed.
run_pg_push_stage() {
    local pg_push_py="${HOME}/.glass-atrium/scripts/_pg_push_autoagent_cycle.py"
    local pg_rc=0
    if [[ "${DRY_RUN}" -eq 0 && -s "${OUT_PATH}" && -f "${pg_push_py}" ]]; then
        printf '[daemon-cycle] PG_PUSH start out=%s date=%s started=%s\n' \
            "${OUT_PATH}" "${CYCLE_DATE}" "${CYCLE_STARTED_AT}" >&2
        OUT_PATH="${OUT_PATH}" \
            CYCLE_DATE="${CYCLE_DATE}" \
            CYCLE_STARTED_AT="${CYCLE_STARTED_AT}" \
            "${PYTHON_BIN}" "${pg_push_py}" || pg_rc=$?
        printf '[daemon-cycle] PG_PUSH end rc=%d\n' "${pg_rc}" >&2
    else
        # skip reason — 5 fields: DRY_RUN flag / OUT_PATH presence / file size / helper presence / OUT_PATH
        local out_size_label="missing"
        if [[ -e "${OUT_PATH}" ]]; then
            if [[ -s "${OUT_PATH}" ]]; then
                out_size_label="nonzero"
            else
                out_size_label="empty"
            fi
        fi
        local helper_label="missing"
        if [[ -f "${pg_push_py}" ]]; then
            helper_label="present"
        fi
        printf '[daemon-cycle] PG_PUSH SKIP dry=%d out_size=%s helper=%s out=%s\n' \
            "${DRY_RUN}" "${out_size_label}" "${helper_label}" "${OUT_PATH}" >&2
    fi
    return "${pg_rc}"
}

# Every enum label the compose op's SQL can cast to (`'<label>'::core."DaemonStatus"`), paired with
# the migration that adds it. PostgreSQL resolves that cast when it PLANS the statement, so on a DB
# predating the migration the compose errors on EVERY cycle — a clean apply included — and folds a
# non-zero rc into PIPELINE_RC. A daily false-degraded cycle is no better than the false-green one
# this composition exists to remove, so the stage is coupled to the labels' presence rather than
# shipped uncoupled from its own schema dependency.
# The probe pins the SET, never one member: a DB migrated for an earlier label alone would otherwise
# report the dependency satisfied, and the cycle that composes the NEWER label then fails its cast
# at plan time — which is the same false-green shape, moved one label along. Adding a composable
# token means adding its pair here, so the coupling widens with the vocabulary rather than lagging it.
APPLY_STATUS_ENUM_REQUIRED=(
    "apply_failed:20260802000000_add_daemon_status_apply_failed"
    "apply_unavailable:20260803000000_add_daemon_status_apply_unavailable"
)
# The label composed when the apply stage could not run at all (script absent or non-executable).
APPLY_STATUS_UNAVAILABLE_LABEL="apply_unavailable"
# The required labels as one comma-joined string — the probe's query argument and the notices' text.
APPLY_STATUS_ENUM_LABELS=""
for _pair in "${APPLY_STATUS_ENUM_REQUIRED[@]}"; do
    APPLY_STATUS_ENUM_LABELS="${APPLY_STATUS_ENUM_LABELS:+${APPLY_STATUS_ENUM_LABELS},}${_pair%%:*}"
done
unset _pair
# Emit the dependency verdict as ONE pipe-separated line — `<state>|<labels>|<migrations>` for an
# `IFS='|' read -r` — because the MISSING half has to travel with the verdict: the caller runs this in
# a command substitution, so a global set inside would be discarded with the subshell and the notice
# would name the whole required set instead of the one migration an operator must apply. The
# separator is a NON-whitespace character on purpose: this file's IFS carries no space, and an empty
# trailing field survives only a non-whitespace split.
# State: `present` (EVERY required label in the enum) · `absent` (at least one missing — its
# migration is unapplied) · `unknown` (no psql, or the catalog query itself failed / answered with
# something outside the queried set). The two trailing fields are empty unless the state is `absent`.
# A pg_catalog SELECT is the cheapest probe available and mutates nothing. psql's own stderr is
# deliberately NOT redirected: an unreachable DB stays diagnosable in the daemon log rather than
# collapsing into a bare token. `unknown` is distinct from `absent` because only `absent` is
# evidence — an un-probeable DB must not silently disable the composition.
get_apply_status_enum_state() {
    if ! command -v psql >/dev/null 2>&1; then
        printf 'unknown||\n'
        return 0
    fi
    local pair labels="${APPLY_STATUS_ENUM_LABELS}"
    local probe_out rc=0
    probe_out="$(
        psql -d glass_atrium -v ON_ERROR_STOP=1 -tAq \
            -v "lbls=${labels}" <<'PSQL'
SELECT e.enumlabel
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'core' AND t.typname = 'DaemonStatus'
  AND e.enumlabel::text = ANY(string_to_array(:'lbls', ','));
PSQL
    )" || rc=$?
    if [[ "${rc}" -ne 0 ]]; then
        printf 'unknown||\n'
        return 0
    fi
    # Intersect the answer with what was asked. A row naming something OUTSIDE the queried set means
    # the probe did not answer the question that was put to it, which is `unknown` (not evidence of
    # absence) — the same distinction the branch below rests on.
    local found="" line
    while IFS= read -r line; do
        line="${line//[[:space:]]/}"
        if [[ -z "${line}" ]]; then
            continue
        fi
        case ",${labels}," in
            *",${line},"*) found="${found:+${found},}${line}" ;;
            *)
                printf 'unknown||\n'
                return 0
                ;;
        esac
    done <<<"${probe_out}"
    local label missing_labels="" missing_migrations=""
    for pair in "${APPLY_STATUS_ENUM_REQUIRED[@]}"; do
        label="${pair%%:*}"
        case ",${found}," in
            *",${label},"*) ;;
            *)
                missing_labels="${missing_labels:+${missing_labels},}${label}"
                missing_migrations="${missing_migrations:+${missing_migrations},}${pair#*:}"
                ;;
        esac
    done
    if [[ -n "${missing_labels}" ]]; then
        printf 'absent|%s|%s\n' "${missing_labels}" "${missing_migrations}"
        return 0
    fi
    printf 'present||\n'
}

# Record the provenance of the apply-health compose. Called on EVERY exit of the stage below.
# The exits that never REACH the compose statement are exactly the ones that recorded nothing: no CASE
# arm runs, so the row's own apply_status_provenance stays absent and this line is the only thing that
# names the reason. Durability differs by exit and is stated rather than implied — on the two exits
# that reach the statement the same value is also on the run row (the helper's CASE writes it), so the
# line is a second surface for a durable fact; on the skipped exits it is the only surface, because
# recording the reason on the row needs a provenance-only write op the helper does not expose (its two
# daemon_runs ops either compose the status or upsert it wholesale, and the wholesale one would erase
# the patch-generation verdict this composition exists to preserve).
record_apply_status_provenance() {
    printf '[daemon-cycle] APPLY_STATUS provenance=%s date=%s\n' "$1" "${CYCLE_DATE}" >&2
}

# Derive the compose provenance from what the helper REPORTED, never from the token this driver SENT.
# The statement's ELSE arm keeps a pre-existing generation verdict and the sent token lands nowhere, so
# a value read off the request would record a compose that never happened — the same silence at one
# remove. The matched-row count cannot discriminate either (1 on BOTH arms, which is why the helper
# reports the arm on a stdout trailer at all). $1 = helper rc · $2 = its captured stdout.
get_compose_provenance() {
    local rc="$1" helper_out="$2" line reported=""
    while IFS= read -r line; do
        case "${line}" in
            provenance=*)
                reported="${line#provenance=}"
                break
                ;;
        esac
    done <<<"${helper_out}"
    if [[ "${rc}" -ne 0 ]]; then
        printf 'unreported:helper_rc_%d\n' "${rc}"
        return 0
    fi
    if [[ -z "${reported}" ]]; then
        # A trailer-less success is a compose that ran and said nothing: a DB predating the provenance
        # column composes the status alone, and a compose matching no row writes nothing at all. Both
        # are unknown outcomes, and naming either after the sent token would assert a value no channel
        # observed.
        printf 'unreported:no_trailer\n'
        return 0
    fi
    printf '%s\n' "${reported}"
}

# APPLY_STATUS: fold the apply stage's outcome INTO the run record's status.
# The run row is written by run_pg_push_stage BEFORE apply runs and its status
# derives solely from per-patch generation errors, so an aborted apply stage
# reached no operator surface at all — a cycle that applied nothing rendered
# green. The driver owns this write, not the apply dispatcher: the dispatcher is
# a pure stage and the driver already holds CYCLE_DATE plus every stage rc.
# The COMPOSITION lives in the helper's SQL (a CASE), because only the database
# knows the patch-generation verdict this driver never sees — a read-then-write
# here would race the very row it is composing. Runs AFTER the tail push so a
# non-full dispatch cannot overwrite the composed value with a pre-apply one.
# A helper/DB failure returns non-zero and is folded into PIPELINE_RC: the cycle
# degrades, it never crashes.
run_apply_status_stage() {
    local helper="${HOME}/.glass-atrium/scripts/_pg_dual_write_daemon.py"
    local rc=0 apply_status="ok" helper_label="present"
    if [[ ! -f "${helper}" ]]; then
        helper_label="missing"
    fi
    if [[ "${DRY_RUN}" -eq 1 || "${helper_label}" == "missing" ]]; then
        printf '[daemon-cycle] APPLY_STATUS SKIP dry=%d helper=%s date=%s\n' \
            "${DRY_RUN}" "${helper_label}" "${CYCLE_DATE}" >&2
        # One exit, two reasons that must not collapse: a dry run DECLINES to write, an absent helper
        # CANNOT. dry-run is tested first because a dry run without the helper installed is still a
        # dry run — the write was never going to happen.
        if [[ "${DRY_RUN}" -eq 1 ]]; then
            record_apply_status_provenance "skipped:dry_run"
        else
            record_apply_status_provenance "skipped:helper_missing"
        fi
        return 0
    fi
    local enum_state="" missing_labels="" missing_migrations="" enum_probe
    enum_probe="$(get_apply_status_enum_state)"
    IFS='|' read -r enum_state missing_labels missing_migrations <<<"${enum_probe}"
    if [[ "${enum_state}" == "absent" ]]; then
        printf '[daemon-cycle] APPLY_STATUS SKIP enum=absent labels=%s migrations=%s date=%s apply_rc=%d — core."DaemonStatus" cannot express the composed value; apply those migrations and the next cycle records apply health\n' \
            "${missing_labels}" "${missing_migrations}" \
            "${CYCLE_DATE}" "${APPLY_RC}" >&2
        # The missing labels travel WITH the value: the reason is not "enum" but which migration is
        # unapplied, and an operator reading the row's absent provenance has no other way to learn it.
        record_apply_status_provenance "skipped:enum_absent:${missing_labels}"
        return 0
    fi
    if [[ "${enum_state}" != "present" ]]; then
        printf '[daemon-cycle] APPLY_STATUS WARN enum=unknown labels=%s — presence unprobeable (psql absent or catalog query failed); composing anyway, a DB predating those migrations degrades this cycle\n' \
            "${APPLY_STATUS_ENUM_LABELS}" >&2
    fi
    # Unavailability outranks the rc: the guard returns 0 for a stage that never ran, so testing the
    # rc first would compose `ok` for exactly the condition this token exists to name.
    if [[ "${APPLY_UNAVAILABLE}" -eq 1 ]]; then
        apply_status="${APPLY_STATUS_UNAVAILABLE_LABEL}"
    elif [[ "${APPLY_RC}" -ne 0 ]]; then
        apply_status="apply_failed"
    fi
    printf '[daemon-cycle] APPLY_STATUS start date=%s apply_rc=%d status=%s\n' \
        "${CYCLE_DATE}" "${APPLY_RC}" "${apply_status}" >&2
    # Stdout is CAPTURED, not discarded: line 1 is the elapsed-milliseconds figure every op returns and
    # the trailer below it names the CASE arm the database actually took. Discarding it is what left a
    # declined compose indistinguishable from a composed one.
    local helper_out=""
    helper_out="$(
        printf '{"op":"compose_daemon_run_apply_status","args":{"daemon_name":"autoagent","run_date":"%s","apply_status":"%s"}}\n' \
            "${CYCLE_DATE}" "${apply_status}" \
            | "${PYTHON_BIN}" "${helper}"
    )" || rc=$?
    record_apply_status_provenance "$(get_compose_provenance "${rc}" "${helper_out}")"
    printf '[daemon-cycle] APPLY_STATUS end rc=%d\n' "${rc}" >&2
    return "${rc}"
}

# aggregate: scan outcomes/ → update core-learning-log.md + feedback-clusters.json.
# STATE_FILE mtime since-filter makes it idempotent (no double-counting a file).
# dry-run skipped — aggregator has no --dry-run flag.
run_aggregate_stage() {
    if [[ ! -f "${AGGREGATOR_PY}" ]]; then
        printf '[daemon-cycle] stage=aggregate SKIP: %s missing\n' "${AGGREGATOR_PY}" >&2
        return 0
    fi
    if [[ "${DRY_RUN}" -eq 1 ]]; then
        printf '[daemon-cycle] stage=aggregate SKIP: dry-run (aggregator has no --dry-run)\n' >&2
        return 0
    fi
    local rc=0
    "${PYTHON_BIN}" "${AGGREGATOR_PY}" || rc=$?
    if [[ "${rc}" -eq 0 ]]; then
        printf '[daemon-cycle] stage=aggregate rc=0\n' >&2
    else
        printf '[daemon-cycle] stage=aggregate rc=%d (continuing)\n' "${rc}" >&2
    fi
    return "${rc}"
}

# -- Dispatch --------------------------------------------------------------

# Aggregate exit tracking: each stage is independent (a failure logs its own rc
# and does NOT abort the next stage), but a non-zero rc from ANY dispatched
# stage is OR-accumulated into PIPELINE_RC so the final exit can report a
# degraded cycle (exit 1) instead of an unconditional clean exit 0. The PG_PUSH
# stage now contributes: a write failure (DB down) returns non-zero and is
# folded in so a DB-down cycle surfaces as degraded (DF-16). LOOP_PUSH stays a
# best-effort sink. Helper: run a stage, fold its rc into PIPELINE_RC.
PIPELINE_RC=0
record_stage_rc() {
    local rc="$1"
    if [[ "${rc}" -ne 0 ]]; then
        PIPELINE_RC=1
    fi
}

# Apply-stage outcome, kept SEPARATE from PIPELINE_RC: that aggregate collapses
# every stage to one bit, so it cannot say WHICH stage degraded — and the apply
# stage's own rc is the only input to the composed run-record status below.
# APPLY_RAN distinguishes "apply succeeded" from "apply never dispatched" (the
# cycle/regression/aggregate modes), which must not be written as clean apply
# health.
APPLY_RAN=0
APPLY_RC=0
# Set by run_apply_stage when the apply script is absent or non-executable. SEPARATE from APPLY_RC
# because that guard returns 0 — an rc alone cannot distinguish a stage that ran cleanly from one
# that never ran, and composing `ok` for the latter is the defect this flag removes.
APPLY_UNAVAILABLE=0
record_apply_rc() {
    APPLY_RAN=1
    APPLY_RC="$1"
}

set +e
case "${STAGE_MODE}" in
    full)
        run_cycle_stage
        record_stage_rc "$?"
        # Push proposals to PG BEFORE apply so the apply backlog drain finds
        # same-cycle auto-tier rows (produce-before-consume). A write failure
        # (DB down) is folded into PIPELINE_RC (DF-16).
        run_pg_push_stage
        record_stage_rc "$?"
        FULL_MODE_PG_PUSHED=1
        # Re-derive prior-cycle stale pending diffs BEFORE apply so the same
        # cycle's apply drains the freshened rows instead of re-skipping them on
        # a stale-diff mismatch (otherwise → pending fossilization).
        run_regenerate_stale_stage
        record_stage_rc "$?"
        run_apply_stage
        apply_rc=$?
        record_apply_rc "${apply_rc}"
        record_stage_rc "${apply_rc}"
        run_aggregate_stage
        record_stage_rc "$?"
        ;;
    cycle)
        run_cycle_stage
        record_stage_rc "$?"
        ;;
    apply)
        # apply-only is the manual operator drain path. Run the no-Haiku-cost
        # regenerate-stale sweep first so an operator draining a backlog of
        # stale pending rows gets them freshened-then-applied in one pass,
        # consistent with full-mode (freshen → drain). Low-risk: difflib-only,
        # UPDATEs proposed_diff only, never applies.
        run_regenerate_stale_stage
        record_stage_rc "$?"
        run_apply_stage
        apply_rc=$?
        record_apply_rc "${apply_rc}"
        record_stage_rc "${apply_rc}"
        ;;
    regression)
        run_regression_stage
        record_stage_rc "$?"
        ;;
    aggregate)
        run_aggregate_stage
        record_stage_rc "$?"
        ;;
    *)
        printf '[daemon-cycle] FATAL: unknown stage mode: %s\n' "${STAGE_MODE}" >&2
        exit 2
        ;;
esac
set -e

# PHASE2-AUTOAGENT-DUALWRITE-BEGIN
# Per-patch UPSERT into core.autoagent_proposals + core.daemon_runs +
# core.daemon_run_payload via run_pg_push_stage (defined above).
# In `full` mode the push already ran BEFORE apply (produce-before-consume), so
# this tail call is GUARDED against a second push. Non-`full` dispatch modes
# (--cycle-only / --apply-only / --aggregate-only / --regression-only) keep the
# tail-push behavior.
if [[ "${FULL_MODE_PG_PUSHED}" -eq 0 ]]; then
    # `|| pg_tail_rc=$?` keeps set -e from aborting on a non-zero push (DB down);
    # the rc is folded into PIPELINE_RC so non-full modes also surface degraded.
    pg_tail_rc=0
    run_pg_push_stage || pg_tail_rc=$?
    record_stage_rc "${pg_tail_rc}"
fi
# PHASE2-AUTOAGENT-DUALWRITE-END

# APPLY-HEALTH-COMPOSE-BEGIN
# Sequenced AFTER the tail push on purpose: in `apply` mode FULL_MODE_PG_PUSHED
# stays 0, so the tail push above runs post-apply and would blind-overwrite an
# earlier composed status with the pre-apply one. Only a dispatch that actually
# ran the apply stage writes here — the cycle/regression/aggregate modes leave
# apply health untouched rather than asserting a clean apply that never ran.
if [[ "${APPLY_RAN}" -eq 1 ]]; then
    apply_status_rc=0
    run_apply_status_stage || apply_status_rc=$?
    record_stage_rc "${apply_status_rc}"
fi
# APPLY-HEALTH-COMPOSE-END

# LOOP-EVENTS-DUALWRITE-BEGIN
# After the weekly-heartbeat.sh publisher was archived, core.autoagent_loop_events
# had no publisher and froze. Publish autoagent-loop.jsonl (append-only ndjson)
# to PG right after each cycle.
# Idempotent: helper's ON CONFLICT (event_ts, agent, eval_result) DO UPDATE.
# dry-run skipped — consistent with cycle/apply/aggregate stage policy.
# LOOP_PUSH uses the same logging pattern as PG_PUSH (start/end/skip); the
# helper's `|| true` swallow is preserved but surfaced via loop_rc capture.
LOOP_PUSH_PY="${HOME}/.glass-atrium/scripts/_pg_push_autoagent_loop_events.py"
if [[ "${DRY_RUN}" -eq 0 && -f "${LOOP_PUSH_PY}" ]]; then
    printf '[daemon-cycle] LOOP_PUSH start helper=%s\n' "${LOOP_PUSH_PY}" >&2
    loop_rc=0
    "${PYTHON_BIN}" "${LOOP_PUSH_PY}" || loop_rc=$?
    printf '[daemon-cycle] LOOP_PUSH end rc=%d\n' "${loop_rc}" >&2
else
    loop_helper_label="missing"
    if [[ -f "${LOOP_PUSH_PY}" ]]; then
        loop_helper_label="present"
    fi
    printf '[daemon-cycle] LOOP_PUSH SKIP dry=%d helper=%s\n' \
        "${DRY_RUN}" "${loop_helper_label}" >&2
fi
# LOOP-EVENTS-DUALWRITE-END

# Final exit reflects the aggregate dispatch result: 0 = all dispatched stages
# clean · 1 = degraded (≥1 stage non-zero) · 2 = arg/stage-mode error · 3 =
# python3 missing · 4 = claude missing. PG_PUSH now folds its write-failure rc
# into this aggregate (DF-16 — a DB-down cycle is degraded); the LOOP_PUSH tail
# sink stays best-effort. This lets launchd/monitoring distinguish a degraded
# run from a clean one instead of always seeing success.
if [[ "${PIPELINE_RC}" -ne 0 ]]; then
    printf '[daemon-cycle] cycle finished DEGRADED — at least one stage returned non-zero (exit 1)\n' >&2
    exit 1
fi
printf '[daemon-cycle] cycle finished clean (exit 0)\n' >&2
exit 0
