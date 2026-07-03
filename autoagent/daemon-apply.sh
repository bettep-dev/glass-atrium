#!/usr/bin/env bash
# AutoAgent daemon — auto-apply stage.
#
# Patch source — backlog-draining selection:
#   PRIMARY: query the cross-cycle PG backlog
#       (core.autoagent_proposals WHERE approval_tier='auto'
#        AND classification='apply' AND pre_verify_passed=true
#        AND status='pending'), ORDER BY cycle_date ASC, id ASC
#       — oldest-first so stale rows drain before fresh ones.
#   FALLBACK: when psql is absent (dry-run / test isolation / no-DB host),
#       read today's JSON report and filter classification=="body-auto"
#       AND approval_tier=="auto" (the legacy today-only path).
# Each selected patch is applied to its agent file in `~/.claude/agents/`.
#
# Why backlog-drain over today-only: a today-only fixed-order slice broke after
# the apply cap — tail candidates were never reached, and the today-only dedup
# re-stranded the same tail rows every cycle → permanent tail starvation.
#
# Cap semantics: the per-run --limit safety throttle caps an OLDEST-FIRST PG
# selection. Each applied row transitions pending→applied and leaves the next
# cycle's pending set, so the cap rotates through the backlog across cycles —
# no row is permanently starved (idempotent status gate guarantees drainage).
#
# Approval tiers (auto + safety). Branch contract for this script:
#   - approval_tier == "auto"   → auto-applied here (single path below)
#   - approval_tier == "safety" → NOT auto-applied; marked status='pending' →
#                                 monitor surfaces under the #improvement safety
#                                 queue for explicit user approval (high-impact
#                                 actions: file deletion / chmod / TCC /
#                                 launchctl / git force-push / DROP TABLE /
#                                 frontmatter identity / GLOBAL_RULES weakening)
#   - approval_tier == ""       → reject (auto-rejected upstream, no row reaches
#                                 the apply stage)
#
# Each apply runs as a git-FREE file-copy transaction (lib/git-txn.sh): a
# before-image copy of the single target is captured into a per-proposal
# agents-bak backup dir BEFORE apply, and a verify failure atomically restores
# the target from that before-image. The persistent before-image is the
# post-hoc rollback anchor (one before-image = one patch); no VCS commit/revert.
#
# A JSONL log of applied patches is appended to:
#     ~/.claude/data/daemon-reports/autoagent-applied-YYYY-MM-DD.jsonl
#
# Idempotency: re-running on the same JSON skips patches whose
# (pattern_label, target_file) tuple already appears in today's applied log.
#
# Concurrency: a directory-based lock at
#     ~/.claude/data/daemon-reports/.apply-lock
# prevents two concurrent applies. The lock is auto-released on script exit
# via trap, even on SIGINT/SIGTERM.
#
# Usage:
#     daemon-apply.sh                 # drain the ENTIRE auto-tier pending
#                                     # backlog oldest-first (no processing cap)
#     daemon-apply.sh --dry-run       # simulate; log to /tmp/, no file writes
#     daemon-apply.sh --limit 5       # OPTIONAL manual cap for ad-hoc operator
#                                     # use; 0 (default) = unbounded process-all
#     daemon-apply.sh --report PATH   # explicit JSON path (fallback / testing)
#     daemon-apply.sh --agents-dir P  # explicit agents repo (testing)
#     daemon-apply.sh --proposal-id N # apply EXACTLY proposal N (single mode);
#                                     # see "Single-proposal mode" below
#     daemon-apply.sh --proposal-id N --auto-regen
#                                     # single mode + regen-on-accept: if the
#                                     # apply hits the stale/needs_regen path,
#                                     # regenerate the diff via daemon_cycle.py,
#                                     # re-validate, and re-apply if valid (see
#                                     # "Auto-regen mode" below). No-op without
#                                     # --proposal-id (batch path never auto-regens).
#
# Single-proposal mode (interactive approval UI):
#   --proposal-id N applies EXACTLY one proposal (id=N) instead of the batch
#   backlog. It is invoked ONLY by an explicit user button-click in the monitor
#   #improvement UI (POST /api/improvement/:id/approve shells out to this).
#   Because that click IS the human-in-the-loop decision, this path BYPASSES
#   the auto-tier gate AND the pre_verify_passed gate — a user MAY apply a
#   safety/user-tier proposal here (the auto-batch path still excludes safety;
#   only this explicit path bypasses). Selection: id=N AND status IN
#   ('pending','snoozed'). Reuses the SAME apply_diff + update_db_status path.
#
# Auto-regen mode (regen-on-accept path):
#   --auto-regen modifies --proposal-id N ONLY when the normal single-mode apply
#   would otherwise exit 9 (the stale/needs_regen path: apply_diff rc 3 left the
#   row pending because the stored diff no longer lands on the current file —
#   the user-reported "nothing happened" symptom). Instead of exit 9, the script:
#     1. runs `python3 daemon_cycle.py --regenerate-stale --proposal-id N`
#        (--dry-run is passed through), parsing the ONE stdout JSON object
#        {proposal_id, action, preverify_passed, preverify_axes:{C1..C4}, reason}.
#     2. branches on action:
#        - regenerated     → daemon_cycle UPDATEd proposed_diff with a fresh
#                            validity-gated landable diff; the row is still
#                            pending → RE-SELECT from PG + RE-ATTEMPT the apply
#                            (apply_patch_rows). lands → exit 10 · still won't
#                            land → exit 11.
#        - already_applied → the change is already in the file (no diff); mark
#                            the row applied via the existing PG status-flip path
#                            (no bytes to land) → exit 12.
#        - invalid         → re-derived but 4-axis pre-verify FAILED; leave
#                            pending, surface failing axes (loud-fail) → exit 13.
#        - unrecoverable   → no landable diff (or daemon_cycle error); leave
#                            pending → exit 14.
#   WITHOUT --auto-regen (default / every batch path) the stale path is UNCHANGED
#   (exit 9, row pending). --auto-regen is a no-op without --proposal-id (an
#   explicit FATAL: the batch backlog NEVER auto-regens, by design).
#
# Exit codes:
#     0 — success (batch: drained/empty-backlog · single: proposal applied)
#     2 — argument / config error
#     3 — required tool missing
#     4 — lock contention (another apply already running)
#     5 — apply-lock lib missing / source failed (FATAL: the shared
#         stale-reclaim helper is absent — writers cannot be serialized)
#     6 — DB status transition failed on a backlog/single-sourced patch
#         (loud-fail: prevents silent re-application next cycle)
#     7 — backlog anomaly: eligible-pending count exceeds ANOMALY_THRESHOLD
#         (loud-fail tripwire — a proposal-generation bug must NOT trigger a
#         runaway mass-apply; nothing is applied, operator must investigate)
#     8 — --proposal-id: NOT actionable (id not found, OR status not in
#         pending/snoozed = already applied/rejected/approved). No-op,
#         idempotent: nothing changed. Scriptable "nothing to do" signal.
#     9 — --proposal-id: apply FAILED (diff rejected by git apply --recount →
#         needs_regen; row left pending). Scriptable "could not apply".
#
# --auto-regen exit codes (regen-on-accept; --proposal-id + --auto-regen
# ONLY — orchestration of daemon_cycle.py --regenerate-stale on the stale path).
# Without --auto-regen the stale/needs_regen path keeps emitting exit 9 above;
# WITH it, the exit-9 case is replaced by one of these per the regen verdict.
# Codes 10-14 do NOT collide with the 0/2/3/4/5/6/7/8/9 map above:
#     10 — regenerated + RE-APPLIED: daemon_cycle regenerated a fresh validity-
#          gated diff (action=regenerated, preverify PASS) AND the re-attempt
#          landed it → row flipped applied (git-free before-image transaction).
#     11 — regenerated but STILL won't land: fresh diff produced + re-attempt
#          again hit needs_regen/error → row left pending (regen-still-failed).
#     12 — already_applied: the change is already present in the file (no diff
#          to land) → row marked applied via the PG status-flip path, no bytes
#          written (the change landed on an earlier cycle). Scriptable "already there".
#     13 — invalid: daemon_cycle re-derived a diff but the 4-axis pre-verify
#          FAILED (action=invalid) → row left pending, failing axes logged.
#     14 — unrecoverable: no landable diff after re-derive (action=unrecoverable)
#          OR daemon_cycle itself errored → row left pending.
#
# Stale-drain exit code (bounded-retry → terminal-drain of a stale/
# needs_regen fossil; see mark_stale_attempt + STALE_DRAIN_THRESHOLD):
#     15 — backlog/single stale-drain counter UPDATE failed (psql error on the
#          enforce=1 path). Loud-fail rather than swallow, since a swallowed
#          counter failure keeps the fossil re-selecting every cycle (the exact
#          condition the stale-drain fixes). Does NOT collide with 0/2-14.

set -Eeuo pipefail
IFS=$'\n\t'

# -- Required tooling ------------------------------------------------------
# Hoisted ABOVE the self-path resolution below: ga_realpath's first call is the
# SCRIPT_DIR assignment, so a missing python3 must die as the friendly exit-3
# FATAL here, not as a raw set -e command-substitution error mid-assignment.

for tool in git python3 jq; do
    # jq is preferred for robust JSON; fall back to python if missing.
    if ! command -v "${tool}" >/dev/null 2>&1; then
        if [[ "${tool}" == "jq" ]]; then
            continue # jq optional — python fallback below
        fi
        printf '[daemon-apply] FATAL: %s not found on PATH\n' "${tool}" >&2
        exit 3
    fi
done

# ga_realpath — resolve a (possibly facade-symlink) path to its real GA path.
# Two consumers: (a) PG stores facade paths (~/.claude/agents/X.md → symlink);
# the git-free transaction captures the before-image of, and atomically restores,
# the REAL file (~/.glass-atrium/agents/X.md), so the loop resolves the symlink
# first. (b) SELF-path resolution (SCRIPT_DIR below). In a standalone repo (no
# symlink) realpath is an identity, so this is a no-op there. python3
# os.path.realpath is the portable idiom — realpath(1)/readlink -f are not on
# the stock-macOS baseline.
ga_realpath() {
    python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

# -- Self-path resolution (facade-safe) -------------------------------------
# launchd invokes this script THROUGH the ~/.claude per-file symlink facade
# (~/.claude/autoagent/daemon-apply.sh → this file). bash never dereferences a
# file-level symlink in BASH_SOURCE, so dirname(BASH_SOURCE) is the FACADE dir —
# a REAL directory (pwd -P cannot help) whose siblings exist only where a mirror
# symlink was hand-created. Realpath the FILE first, then dirname, so every
# sibling resource (lib/git-txn.sh, daemon_cycle.py, ../scripts/lib/apply-lock.sh)
# resolves into the REAL tree regardless of how the script was invoked.
# (Incident 2026-07-02: the missing apply-lock.sh mirror FATALed every cycle.)
SCRIPT_DIR="$(dirname -- "$(ga_realpath "${BASH_SOURCE[0]}")")"

# -- Reusable git-free transaction (shared with the glass-atrium-update E4 path) --
# The before-image -> apply -> verify -> (leave | atomic restore) scaffold is
# factored into lib/git-txn.sh so the update skill's agent EDITABLE-region merge
# path (T18/T19) can reuse the SAME hardened machinery instead of a parallel
# merge engine. apply_patch_rows below is its first caller; it injects apply_diff
# + verify_patched as the apply/verify callbacks and maps the structured
# GIT_TXN_RC outcome back to its own counter buckets + emit_log.
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib/git-txn.sh
source "${SCRIPT_DIR}/lib/git-txn.sh"

# -- Constants -------------------------------------------------------------

REPORTS_DIR="${AUTOAGENT_REPORTS_DIR:-${HOME}/.claude/data/daemon-reports}"
# Glass Atrium (GA) single-monorepo target:
#   ~/.claude/{agents,rules,...} are facade dirs whose FILES are symlinks →
#   ~/.glass-atrium/<dir>/<file>. The transaction is git-FREE (before-image copy
#   + atomic restore), so the loop no longer needs a git worktree. The ONLY
#   surviving git call is `git apply --recount`, which lands the unified diff and
#   works OUTSIDE a git repo. It needs a working dir + a pathspec, both derived as
#   PLAIN PATHS from AGENTS_DIR (dirname/basename) after CLI parse — NO rev-parse.
#   - AGENTS_DIR   = patch-target + verify root (real GA agents/ dir).
#   - GIT_ROOT     = plain `git apply -C` working dir = dirname(AGENTS_DIR).
#   - GIT_PATHSPEC = `git apply --directory` subdir = basename(AGENTS_DIR)/, so a
#                    bare-basename diff header resolves to AGENTS_DIR/<file>.md.
#                    <GIT_ROOT>/<GIT_PATHSPEC> == AGENTS_DIR by construction.
AGENTS_DIR_DEFAULT="${AUTOAGENT_AGENTS_DIR:-${HOME}/.glass-atrium/agents}"
LOCK_DIR="${REPORTS_DIR}/.apply-lock"
# Processing cap: 0 = UNBOUNDED (drain the entire auto-tier pending backlog every
# cycle). --limit N (N>0) is an OPTIONAL manual override for ad-hoc operator use;
# the normal cron path uses the unbounded default.
DEFAULT_LIMIT=0
# Anomaly tripwire (NOT a processing cap — core-security.md LLM10 unbounded-
# consumption guard). Steady state is ~4-5 new proposals/day; even months of
# accumulated backlog stays well under 100. An eligible-pending count above
# this is not a real backlog — it signals a proposal-generation bug flooding
# core.autoagent_proposals. Above the threshold → loud-fail (exit 7), apply
# NOTHING, force operator investigation rather than a runaway mass-apply.
# Override via AUTOAGENT_ANOMALY_THRESHOLD for exceptional one-off drains.
ANOMALY_THRESHOLD="${AUTOAGENT_ANOMALY_THRESHOLD:-100}"
# Stale-drain threshold (fossilization guard). The batch path NEVER auto-
# regens by design (regen is human-gated via --proposal-id only), so a
# stale/needs_regen backlog row (apply_diff rc 3) stays pending and RE-SELECTS
# every cycle forever — a low-grade fossil. After this many CONSECUTIVE stale
# selections of the SAME row, mark_stale_attempt terminally drains it to 'snoozed'
# (an EXISTING ProposalStatus the batch SELECT excludes — NO new enum value, so no
# enum migration), which STOPS the re-selection WITHOUT forcing a batch auto-regen.
# The row stays recoverable via the explicit --proposal-id path (which still selects
# snoozed). Override via AUTOAGENT_STALE_DRAIN_THRESHOLD.
STALE_DRAIN_THRESHOLD="${AUTOAGENT_STALE_DRAIN_THRESHOLD:-3}"
# Applied-log description prefix (carried as the applied-JSONL "commit_message"
# field for backward-compat with existing report consumers — no commit exists).
APPLY_PREFIX="[AUTO]"

# -- CLI parse -------------------------------------------------------------

DRY_RUN=0
LIMIT="${DEFAULT_LIMIT}"
REPORT_PATH=""
AGENTS_DIR="${AGENTS_DIR_DEFAULT}"
# GIT_ROOT (git-apply working dir), GIT_PATHSPEC (git-apply --directory subdir),
# and BACKUP_DIR (before-image root) are all DERIVED from AGENTS_DIR as plain
# paths after CLI parse (so an explicit --agents-dir resolves its own dirname/
# basename). See the post-parse plain-path derivation below.
# Single-proposal mode: empty = batch backlog (default); a numeric id selects
# exactly that one proposal (explicit user-approval path — see header).
PROPOSAL_ID=""
# Auto-regen: 0 = off (default — stale path keeps exit 9); 1 = on (regen +
# re-apply on the stale/needs_regen path). Only meaningful with --proposal-id.
AUTO_REGEN=0
# daemon_cycle.py path for the regen call (env-overridable for test isolation).
# Default is facade-safe: SCRIPT_DIR is the realpathed self dir (real tree).
DAEMON_CYCLE_PY="${AUTOAGENT_DAEMON_CYCLE_PY:-${SCRIPT_DIR}/daemon_cycle.py}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --auto-regen)
            AUTO_REGEN=1
            shift
            ;;
        --proposal-id)
            PROPOSAL_ID="${2:?--proposal-id requires a value}"
            shift 2
            ;;
        --proposal-id=*)
            PROPOSAL_ID="${1#--proposal-id=}"
            shift
            ;;
        --limit)
            LIMIT="${2:?--limit requires a value}"
            shift 2
            ;;
        --limit=*)
            LIMIT="${1#--limit=}"
            shift
            ;;
        --report)
            REPORT_PATH="${2:?--report requires a value}"
            shift 2
            ;;
        --report=*)
            REPORT_PATH="${1#--report=}"
            shift
            ;;
        --agents-dir)
            AGENTS_DIR="${2:?--agents-dir requires a value}"
            shift 2
            ;;
        --agents-dir=*)
            AGENTS_DIR="${1#--agents-dir=}"
            shift
            ;;
        -h|--help)
            sed -n '2,38p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            printf '[daemon-apply] FATAL: unknown arg: %s\n' "$1" >&2
            exit 2
            ;;
    esac
done

if ! [[ "${LIMIT}" =~ ^[0-9]+$ ]]; then
    printf '[daemon-apply] FATAL: --limit must be a non-negative integer, 0=unbounded (got %s)\n' \
        "${LIMIT}" >&2
    exit 2
fi

# --proposal-id, when set, MUST be a positive integer (PG bigint id).
if [[ -n "${PROPOSAL_ID}" ]] && ! [[ "${PROPOSAL_ID}" =~ ^[1-9][0-9]*$ ]]; then
    printf '[daemon-apply] FATAL: --proposal-id must be a positive integer (got %s)\n' \
        "${PROPOSAL_ID}" >&2
    exit 2
fi

# --auto-regen is single-mode ONLY (the batch backlog NEVER auto-regens, by
# design — a runaway regen sweep across the whole backlog is out of scope here).
if [[ "${AUTO_REGEN}" -eq 1 ]] && [[ -z "${PROPOSAL_ID}" ]]; then
    printf '[daemon-apply] FATAL: --auto-regen requires --proposal-id (batch path never auto-regens)\n' >&2
    exit 2
fi

# ANOMALY_THRESHOLD is env-overridable → validate it is a positive integer.
if ! [[ "${ANOMALY_THRESHOLD}" =~ ^[1-9][0-9]*$ ]]; then
    printf '[daemon-apply] FATAL: AUTOAGENT_ANOMALY_THRESHOLD must be a positive integer (got %s)\n' \
        "${ANOMALY_THRESHOLD}" >&2
    exit 2
fi

# -- Git-apply target resolution (plain-path, git-FREE) --------------------
# The transaction is git-free (lib/git-txn.sh: before-image copy + atomic
# restore); the ONLY surviving git call is `git apply --recount`, which lands
# the unified diff and works OUTSIDE a git repo. NO rev-parse, NO worktree
# precondition. Both apply args are PLAIN PATHS derived from AGENTS_DIR:
#   GIT_ROOT     = `git apply -C` working dir = dirname(AGENTS_DIR).
#   GIT_PATHSPEC = `git apply --directory` subdir = basename(AGENTS_DIR)/, so a
#                  bare-basename diff header ('--- a/<file>.md') resolves to
#                  <GIT_ROOT>/<GIT_PATHSPEC>/<file>.md.
# <GIT_ROOT>/<GIT_PATHSPEC> == AGENTS_DIR by construction, so the apply targets
# the agents dir whether or not it lives inside a git repo. dirname/basename
# handle a trailing slash correctly (parameter expansion would not).
GIT_ROOT="$(dirname -- "${AGENTS_DIR}")"
GIT_PATHSPEC="$(basename -- "${AGENTS_DIR}")/"

# _APPLY_DIR_ARGS — `--directory=<subdir>` for `git apply`. GIT_PATHSPEC is
# always non-empty (basename of a real dir), but keep the bash 3.2 array-guard
# idiom (`${arr[@]+"${arr[@]}"}`) at the call site so an empty array never
# raises "unbound variable" under set -u.
_APPLY_DIR_ARGS=("--directory=${GIT_PATHSPEC%/}")

# -- Before-image backup dir (git-free rollback anchor) --------------------
# Per-proposal before-images live under a ROOT-SIBLING agents-bak dir (NOT
# inside agents/, NOT under ~/.claude). install-safe: gitignored (*.bak +
# /agents-bak/) so `git ls-files` never lists it, and tar merge-extract never
# clobbers it. Retention/prune (below) is the daemon's responsibility; git-txn.sh
# only writes into the per-proposal subdir the loop hands it.
BACKUP_DIR="${AUTOAGENT_BACKUP_DIR:-${GIT_ROOT}/agents-bak}"
# TTL for the retention prune, in days (env-overridable). Doubles as the post-hoc
# rollback window (a before-image older than this is pruned). Invalid → 14 + WARN.
BACKUP_TTL_DAYS="${AUTOAGENT_BACKUP_TTL_DAYS:-14}"
if ! [[ "${BACKUP_TTL_DAYS}" =~ ^[1-9][0-9]*$ ]]; then
    printf '[daemon-apply] WARN: AUTOAGENT_BACKUP_TTL_DAYS must be a positive integer (got %s) — using 14\n' \
        "${BACKUP_TTL_DAYS}" >&2
    BACKUP_TTL_DAYS=14
fi

# prune_backup_retention — housekeeping: drop whole <cycle-id> before-image
# subdirs older than BACKUP_TTL_DAYS, but NEVER the newest one (protects the
# most-recent rollback anchor even if the daemon has been idle past the TTL and
# every dir is technically stale). Best-effort + loud on error — a prune failure
# is a WARN, never a daemon abort (housekeeping, not a precondition). rm is
# permitted here: a before-image is a regenerable, path-validated snapshot.
prune_backup_retention() {
    # SECURITY: hard path guard BEFORE any rm — refuse unless BACKUP_DIR is
    # non-empty AND ends in /agents-bak (blocks an env-override mishap from
    # rm-rf'ing an unrelated tree).
    if [[ -z "${BACKUP_DIR}" || "${BACKUP_DIR}" != */agents-bak ]]; then
        printf '[daemon-apply] WARN: backup retention prune SKIPPED — BACKUP_DIR failed path guard (%s)\n' \
            "${BACKUP_DIR}" >&2
        return 0
    fi
    [[ -d "${BACKUP_DIR}" ]] || return 0
    # Find the newest cycle subdir by mtime (bash `-nt`, no external stat/ls) so
    # it can be excluded from the prune.
    local newest="" d
    while IFS= read -r -d '' d; do
        if [[ -z "${newest}" || "${d}" -nt "${newest}" ]]; then
            newest="${d}"
        fi
    done < <(find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -print0)
    [[ -n "${newest}" ]] || return 0
    if ! find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d \
        -mtime +"${BACKUP_TTL_DAYS}" ! -path "${newest}" -exec rm -rf {} +; then
        printf '[daemon-apply] WARN: backup retention prune hit errors (BACKUP_DIR=%s)\n' \
            "${BACKUP_DIR}" >&2
    fi
}

# NOTE: ga_realpath + the required-tooling check formerly lived here; both are
# HOISTED to the top of the script (above the lib/git-txn.sh source) because the
# facade-safe SCRIPT_DIR resolution needs them before the first sibling source.

# -- Regen-JSON parsers (python3 fallback when jq absent) ------------------
# Captured as literal source constants (NOT inline `<<'PY'` inside $(...) — that
# form fights stdin and is SC2259-fragile). run_regen_for_single feeds the
# daemon_cycle JSON on stdin via a pipe; these read it and print one field.
# Both fail-safe to a benign value (action→"unrecoverable", axes→"") on any
# parse error so a malformed daemon_cycle payload never crashes the apply path.
REGEN_PARSE_ACTION_PY='
import json, sys
try:
    print(json.load(sys.stdin).get("action") or "unrecoverable")
except Exception:
    print("unrecoverable")
'
REGEN_PARSE_AXES_PY='
import json, sys
try:
    ax = json.load(sys.stdin).get("preverify_axes") or {}
    print(",".join(f"{k}={v}" for k, v in ax.items()))
except Exception:
    print("")
'

# -- Landing-zone guard Python source (hoisted module constant) ------------
# Evaluated once at script load (not per-patch); referenced by
# assert_diff_in_editable_region below. The quoted-delimiter `<<'PY'` heredoc —
# not the function scope — is what makes capturing apostrophe-bearing source
# safe (SC2259-safe). Rationale + verdict contract: that function's header.
# Separated assignment then readonly (NOT `readonly X=$(...)`) so `cat`'s exit
# code is not masked (SC2155).
_PY_GUARD="$(cat <<'PY'
import sys


def _editable_regions(text):
    """Body substrings between each EDITABLE BEGIN/END marker pair (doc order)."""
    begin = "<!-- EDITABLE:BEGIN -->"
    end = "<!-- EDITABLE:END -->"
    regions = []
    pos = 0
    while True:
        b = text.find(begin, pos)
        if b == -1:
            break
        e = text.find(end, b + len(begin))
        if e == -1:
            break  # unbalanced trailing BEGIN with no END → ignore (no region)
        regions.append(text[b + len(begin):e])
        pos = e + len(end)
    return regions


def _row_is_pipe(body):
    """A GFM table row/separator (incl. the '|---|' header rule): the stripped
    line begins with '|'."""
    return body.strip().startswith("|")


def _breaks_table(hunks):
    """True when a hunk inserts a contiguous run of ADDED non-pipe lines directly
    between two GFM table rows (a pipe-row immediately before AND after the run).
    Reasons on the POST-APPLY (new-side) view of each hunk — context + added
    lines in document order, removed lines dropped — so it catches a diff that
    lands inside an editable region yet splits a table block. Mirrors RC1: two
    non-pipe lines relocated into an Error Recovery table interior. A pure
    table-row addition (the added line is itself '|...|') and any insert NOT
    bounded by pipe rows on both sides are admitted (no false positive on append-
    after-table, prepend-before-table, or text between two separate tables)."""
    for hunk in hunks:
        new_side = []  # (is_added, body) in post-apply document order
        for raw in hunk:
            if not raw:
                new_side.append((False, ""))  # blank context line
                continue
            marker, body = raw[0], raw[1:]
            if marker == "-":
                continue  # removed → absent post-apply
            if marker == "+":
                new_side.append((True, body))
            elif marker == " ":
                new_side.append((False, body))
            # other markers ('\' no-newline-at-EOF) carry no table signal
        n = len(new_side)
        i = 0
        while i < n:
            is_added, body = new_side[i]
            if is_added and not _row_is_pipe(body):
                # extend over a run of consecutive added non-pipe lines (RC1
                # inserted TWO) so the bounding pipe-rows are tested once.
                run_end = i
                while run_end < n and new_side[run_end][0] and not _row_is_pipe(new_side[run_end][1]):
                    run_end += 1
                before_pipe = i - 1 >= 0 and _row_is_pipe(new_side[i - 1][1])
                after_pipe = run_end < n and _row_is_pipe(new_side[run_end][1])
                if before_pipe and after_pipe:
                    return True
                i = run_end
            else:
                i += 1
    return False


def main():
    target_path = sys.argv[1]
    diff_text = sys.stdin.read()
    lines = diff_text.splitlines()

    # Header-less Strategy-B fragment → EOF append, outside any region. Reject.
    has_minus_header = any(ln.startswith("--- ") for ln in lines)
    has_plus_header = any(ln.startswith("+++ ") for ln in lines)
    if not (has_minus_header and has_plus_header):
        sys.stdout.write("header_less")
        return

    try:
        with open(target_path, "r", encoding="utf-8") as fh:
            current = fh.read()
    except OSError:
        sys.stdout.write("read_error")  # loud-fail: NEVER pass-through
        return

    regions = _editable_regions(current)
    if not regions:
        sys.stdout.write("no_marker")
        return

    def in_some_region(needle):
        s = needle.strip()
        if not s:
            return True  # blank line carries no landing-zone signal
        return any(s in region for region in regions)

    # Hunk-aware scan. A unified diff lands each hunk by matching its ANCHOR
    # lines (context + removed) against the current file at one position; the
    # added lines are placed among those anchors. The landing zone of a hunk is
    # decided by where its anchors sit:
    #   1. Every removed/context line the file CONTAINS must sit inside an
    #      editable region — an anchor in a protected zone = reject.
    #   2. Each hunk MUST carry at least one anchor resolving inside a region.
    #      A pure-add hunk with no in-region anchor cannot be confirmed to land
    #      editable → reject (fail-closed).
    hunks = []
    current_hunk = None
    for raw in lines:
        if raw.startswith("@@"):
            current_hunk = []
            hunks.append(current_hunk)
            continue
        if current_hunk is None:
            continue  # pre-hunk header lines
        current_hunk.append(raw)

    if not hunks:
        sys.stdout.write("out_of_region")  # headers but no hunk body = malformed
        return

    for hunk in hunks:
        anchor_in_region = False
        for raw in hunk:
            if not raw:
                continue
            marker, body = raw[0], raw[1:]
            # Compute the landing-zone hit ONCE per line; both branches reuse it.
            region_hit = in_some_region(body)
            if marker == "-":
                # Removed text must currently exist inside an editable region.
                if body.strip() and not region_hit:
                    sys.stdout.write("out_of_region")
                    return
                if body.strip() and region_hit:
                    anchor_in_region = True
            elif marker == " ":
                # Context anchor. If the file holds it OUTSIDE every region the
                # hunk sits in a protected zone → reject; inside → positive anchor.
                if body.strip():
                    if body in current and not region_hit:
                        sys.stdout.write("out_of_region")
                        return
                    if region_hit:
                        anchor_in_region = True
            # Added lines carry no landing anchor of their own.
        if not anchor_in_region:
            sys.stdout.write("out_of_region")  # no in-region anchor → fail-closed
            return

    # Post-region structural integrity (RC1). Every hunk anchors in-region, but
    # an in-region insert can STILL split a GFM table by dropping a non-pipe line
    # between two table rows — invisible to the containment scan above. Reject on
    # the post-apply table-break view (fail-closed, same as out_of_region).
    if _breaks_table(hunks):
        sys.stdout.write("table_break")
        return

    sys.stdout.write("ok")


main()
PY
)"
readonly _PY_GUARD

# -- Resolve report path ---------------------------------------------------
# NOTE: report-existence is NOT checked here. The PG backlog is the PRIMARY
# patch source (main-loop source selection below) and does not require a
# today-dated report file; an absent report only matters on the JSON-report
# FALLBACK branch (psql absent / dry-run), where the "nothing to apply"
# early-exit lives. Checking existence here would short-circuit before the
# backlog path and strand pending rows on the real cron host (no today report).

CYCLE_DATE="$(date -u +%Y-%m-%d)"
REPORT_PATH="${REPORT_PATH:-${REPORTS_DIR}/autoagent-${CYCLE_DATE}.json}"

# -- Output destinations ---------------------------------------------------

if [[ "${DRY_RUN}" -eq 1 ]]; then
    APPLIED_LOG="/tmp/autoagent-applied-${CYCLE_DATE}.dryrun.jsonl"
else
    mkdir -p "${REPORTS_DIR}"
    APPLIED_LOG="${REPORTS_DIR}/autoagent-applied-${CYCLE_DATE}.jsonl"
fi

# -- Cooperative update pause-flag gate (T10) ------------------------------
# The apply stage is the daemon's WRITER (it swaps agent-file content in place),
# so honor the update pause flag here too (defense in depth beyond
# daemon-cycle.sh): a cron OR explicit apply must never write while a Glass
# Atrium update is swapping files. A STALE flag (crashed updater) is TTL-cleared
# by the lib so the daemon can never freeze forever. A clean skip is exit 0.
# DAEMON SAFETY: a missing lib degrades to a loud WARN + proceed.
PAUSE_FLAG_LIB="${HOME}/.glass-atrium/scripts/lib/update-pause-flag.sh"
if [[ -f "${PAUSE_FLAG_LIB}" ]]; then
    # shellcheck disable=SC1090,SC1091
    . "${PAUSE_FLAG_LIB}"
    if update_pause_is_active; then
        printf '[daemon-apply] update in progress (pause flag held) — skipping apply (exit 0)\n' >&2
        exit 0
    fi
else
    printf '[daemon-apply] WARN: pause-flag lib missing (%s) — proceeding without update-pause gate\n' \
        "${PAUSE_FLAG_LIB}" >&2
fi

# -- Shared apply-lock helper (stale-reclaim guard) ------------------------
# The .apply-lock stale-reclaim logic is SHARED with the updater (update.sh) via
# ONE lib so the two writers cannot drift a divergent reclaim (a race hazard).
# Load-bearing: unlike the pause-flag gate (defense-in-depth), a missing lock lib
# is FATAL — writers cannot be serialized without it (Precondition Loud-Fail).
# Facade-safe default: SCRIPT_DIR is the realpathed self dir, so the lib resolves
# to <real-tree>/scripts/lib/apply-lock.sh even when invoked via the ~/.claude
# facade (which has NO apply-lock.sh mirror — the 2026-07-02 exit-5 incident).
APPLY_LOCK_LIB="${ATRIUM_APPLY_LOCK_LIB:-${SCRIPT_DIR}/../scripts/lib/apply-lock.sh}"
if [[ ! -f "${APPLY_LOCK_LIB}" ]]; then
    printf '[daemon-apply] FATAL: apply-lock lib missing (%s)\n' "${APPLY_LOCK_LIB}" >&2
    exit 5
fi
# A static source directive (resolved relative to this script's own dir) lets
# ShellCheck follow the lib under --external-sources and SEE apply_lock_acquired
# assigned (silences SC2154 the way the git-txn source below does).
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../scripts/lib/apply-lock.sh
. "${APPLY_LOCK_LIB}"

# -- Lock acquisition (mkdir is atomic on POSIX; stale-reclaim via the lib) -
# Skip lock entirely in dry-run so parallel test runs don't collide.

if [[ "${DRY_RUN}" -eq 0 ]]; then
    mkdir -p "${REPORTS_DIR}"
    # A crashed/SIGKILLed prior holder (no EXIT trap) left a stranded lock; the
    # lib reclaims it only when the holder is BOTH not-live AND aged past the TTL.
    # A genuinely LIVE holder still blocks here (mutual exclusion preserved).
    apply_lock_acquire "${LOCK_DIR}"
    if [[ "${apply_lock_acquired}" != true ]]; then
        printf '[daemon-apply] FATAL: another apply in progress (%s)\n' \
            "${LOCK_DIR}" >&2
        exit 4
    fi
    # Exit trap: release the lock dir (only if we STILL own it — a reclaimer may
    # have taken over). The transaction is git-free (before-image copy + atomic
    # restore), so there is no stash to pop on exit — only the lock dir to
    # reclaim. rm -rf (via the lib), not rmdir, because the dir now holds the
    # holder pid file.
    # shellcheck disable=SC2064
    trap "apply_lock_release '${LOCK_DIR}'" EXIT
    # INT/TERM MUST TERMINATE (release → exit 128+signal). A shared
    # EXIT/INT/TERM handler released the lock but bash then RESUMED execution
    # after the handler returned — the daemon kept mutating agent files with NO
    # mutual exclusion until natural completion. Release exactly once: clear the
    # EXIT trap BEFORE exiting so the handler chain cannot double-release
    # (release is ownership-gated/idempotent, but single-release is cleaner).
    # shellcheck disable=SC2064
    trap "apply_lock_release '${LOCK_DIR}'; trap - EXIT; exit 130" INT
    # shellcheck disable=SC2064
    trap "apply_lock_release '${LOCK_DIR}'; trap - EXIT; exit 143" TERM
fi

# -- Helpers ---------------------------------------------------------------

# emit_log — append one JSON object (already serialised) as a JSONL row.
emit_log() {
    local payload="$1"
    printf '%s\n' "${payload}" >>"${APPLIED_LOG}"
}

# json_escape — minimal escaping for embedding strings in our JSONL payload.
# We rely on python3 for correctness rather than hand-rolling sed.
json_escape() {
    python3 -c '
import json, sys
sys.stdout.write(json.dumps(sys.stdin.read()))
'
}

# ts_now — current UTC timestamp in our JSONL millisecond-zero format. Single
# source of the format string so a clock/format change touches one place.
ts_now() {
    date -u +%Y-%m-%dT%H:%M:%S.000Z
}

# ts_now_json — ts_now() pre-escaped for direct embedding in a JSONL payload.
ts_now_json() {
    printf '%s' "$(ts_now)" | json_escape
}

# already_applied — return 0 (true) if a matching applied row already exists in
# today's applied log.
#
# The dedup key is the 4-tuple (pattern_label, target_file, cycle_date,
# proposal_id), NOT just (pattern_label, target_file): backlog proposals can
# share one pattern_label across targets, so keying on label+target alone
# collapses genuinely-distinct improvements after the first per-agent apply.
# Adding cycle_date+id lets distinct-cycle proposals drain while still skipping a
# true re-attempt of the SAME (cycle_date,id) proposal (real idempotency).
#
# Backward-compat: report-path patches carry empty cycle/id; an applied row
# written without those fields (legacy) compares equal only when the caller also
# passes empty cycle/id — preserving the original label+target behavior there.
already_applied() {
    local label="$1"
    local target="$2"
    local cycle="$3"
    local proposal_id="$4"
    [[ -f "${APPLIED_LOG}" ]] || return 1
    python3 - "${APPLIED_LOG}" "${label}" "${target}" "${cycle}" "${proposal_id}" <<'PY'
import json, sys
log_path = sys.argv[1]
want_label, want_target, want_cycle, want_id = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
try:
    with open(log_path, "r", encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            if row.get("status") != "applied":
                continue
            if row.get("pattern_label") != want_label:
                continue
            if row.get("target_file") != want_target:
                continue
            # cycle_date + proposal_id complete the key. Missing fields on the
            # logged row coerce to "" so a legacy (label,target)-only applied row
            # still matches a current (label,target,"","") lookup.
            if str(row.get("cycle_date", "")) != want_cycle:
                continue
            if str(row.get("proposal_id", "")) != want_id:
                continue
            sys.exit(0)
except OSError:
    pass
sys.exit(1)
PY
}

# extract_body_auto_patches — emit one JSON object per body-auto patch on stdout.
# Delegates to python3 to avoid jq-dependence (jq is optional).
#
# Requires classification == "body-auto" AND approval_tier == "auto" AND a
# haiku_status of 'ok*' (the JSON-side mirror of the single-proposal SELECT's
# `haiku_status LIKE 'ok%'` gate), so only patches that BOTH passed pre-verify
# (4-axis verification in daemon_cycle.py) AND were Haiku quality-screened reach
# auto-apply. "auto" tier routes other values upstream:
#   - "safety"  → monitor #improvement safety queue (explicit user approval)
#   - ""        → upstream auto-reject (recoverable quality issues already
#                 absorbed by the retry; non-safety pre-verify failures do NOT
#                 generate a user-approval row)
#
# haiku_status gate (P3b fail-open CLOSE): historically this JSON-fallback path
# omitted the Haiku gate the single-proposal SELECT enforces, so in psql-absent
# (degraded) mode a non-ok haiku_status body-auto patch could still auto-apply.
# It now mirrors extract_single_proposal: a 'ok*' haiku_status (ok / ok:retried /
# ok:fuzzy-parsed) is required, fail-CLOSED on skipped:*/error:/empty/missing
# (NULL → ineligible, never an implicit pass). Operator carve-out: an operator
# who sets AUTOAGENT_ALLOW_HAIKU_SKIP=1 may force-admit haiku-skipped patches
# (LOUD non-silent WARN), identical to the single path's escape hatch. Logic is
# equivalent to daemon_cycle.is_apply_eligible_patch_dict (the SoT predicate this
# heredoc is the runtime enforcer for).
extract_body_auto_patches() {
    local report="$1"

    # Operator carve-out parse — mirrors extract_single_proposal so the two patch
    # sources behave identically. Default 0 (fail-closed); 1 when the env var is
    # truthy, with a LOUD WARN so the bypass is never silent.
    local allow_haiku_skip=0
    case "${AUTOAGENT_ALLOW_HAIKU_SKIP:-0}" in
        1 | true | TRUE | yes | YES) allow_haiku_skip=1 ;;
        *) allow_haiku_skip=0 ;;
    esac
    if [[ "${allow_haiku_skip}" -eq 1 ]]; then
        printf '[daemon-apply] WARN haiku-skip guard BYPASSED by operator (AUTOAGENT_ALLOW_HAIKU_SKIP set) — body-auto patches in %s may apply with a non-ok haiku_status (pre-verify skipped/failed)\n' \
            "${report}" >&2
    fi

    python3 - "${report}" "${allow_haiku_skip}" <<'PY'
import json, sys
report_path = sys.argv[1]
allow_haiku_skip = sys.argv[2] == "1"
with open(report_path, "r", encoding="utf-8") as fh:
    data = json.load(fh)
for patch in data.get("patches", []):
    if patch.get("classification") != "body-auto":
        continue
    if patch.get("approval_tier") != "auto":
        continue
    # Haiku-skip gate (P3b, fail-CLOSED): the diff's Haiku pre-verify MUST have
    # produced an 'ok*' verdict. A missing/empty/None/skipped:*/error: status is
    # excluded UNLESS the operator carve-out is engaged. `or ""` coerces an
    # explicit JSON null so str(None) -> "None" can never slip past startswith.
    # Mirrors daemon_cycle.is_apply_eligible_haiku_status + the SELECT `LIKE 'ok%'`.
    haiku_status = str(patch.get("haiku_status", "") or "")
    if not allow_haiku_skip and not haiku_status.startswith("ok"):
        continue
    sys.stdout.write(json.dumps(patch, ensure_ascii=False) + "\n")
PY
}

# backlog_source_available — 0 (true) when PG backlog selection is usable.
# Requires psql on PATH AND not dry-run (dry-run must stay DB-side-effect-free
# AND deterministic against a report fixture). When false, the caller falls
# back to the today-only JSON report path (extract_body_auto_patches).
backlog_source_available() {
    [[ "${DRY_RUN}" -eq 0 ]] || return 1
    command -v psql >/dev/null 2>&1
}

# reassemble_proposal_rows — shared transform for BOTH the batch backlog SELECT
# and the single-proposal SELECT: reads pipe-separated psql rows on stdin
# (6 fields: id|cycle_date|pattern_label|target_agent|target_file|diff_b64) and
# emits one canonical patch JSON object per row on stdout. The two selectors
# differ only in their WHERE clause; the row shape + reassembly is identical, so
# this lives once (DRY) and both call it.
# base64 arrives un-wrapped (SELECT-side translate strips PG's 76-char wrap).
# SC2259: python source captured in a var, psql rows passed via here-string.
reassemble_proposal_rows() {
    local rows_in="$1"
    local _py_reassemble
    _py_reassemble="$(cat <<'PY'
import base64, json, sys
for raw in sys.stdin:
    raw = raw.rstrip("\n")
    if not raw:
        continue
    # split on '|' — all 6 fields are psql-controlled and the 6th (base64)
    # contains no '|', so a plain split is unambiguous.
    parts = raw.split("|")
    if len(parts) != 6:
        continue
    row_id, cycle_date, pattern_label, target_agent, target_file, diff_b64 = parts
    try:
        proposed_diff = base64.b64decode(diff_b64).decode("utf-8") if diff_b64 else ""
    except (ValueError, UnicodeDecodeError):
        proposed_diff = ""
    sys.stdout.write(
        json.dumps(
            {
                "pattern_label": pattern_label,
                "pattern_agent": target_agent,
                "target_file": target_file,
                "proposed_diff": proposed_diff,
                # Per-row cycle_date drives the status UPDATE; backlog rows span
                # several cycles so we must keep each row own date (not today).
                "cycle_date": cycle_date,
                # id is part of the dedup key (pattern_label,target_file,
                # cycle_date,id) so distinct-cycle proposals for one agent are
                # NOT collapsed by already_applied.
                "proposal_id": row_id,
            },
            ensure_ascii=False,
        )
        + "\n"
    )
PY
)"
    python3 -c "${_py_reassemble}" <<<"${rows_in}"
}

# extract_backlog_patches — emit one JSON object per eligible auto-apply patch
# from the cross-cycle PG backlog, OLDEST-FIRST, on stdout (same shape as
# extract_body_auto_patches so the main loop is source-agnostic).
#
# Selection contract (auto-apply gate — safety-tier rows excluded by design):
#   approval_tier   = 'auto'    (safety tier stays pending for user approval —
#                                hard boundary, core-security.md High-impact actions)
#   classification  = 'apply'   (PG enum; 'body-auto' is the JSON-side label)
#   pre_verify_passed = true    (4-axis pre-verify gate)
#   status          = 'pending' (idempotency gate — applied rows self-exclude)
#   ORDER BY cycle_date ASC, id ASC  → stale backlog drains before fresh rows
#   NO SQL LIMIT                → return the ENTIRE eligible pending backlog so
#                                 the caller can (a) anomaly-check the TRUE total
#                                 against ANOMALY_THRESHOLD and (b) drain all of
#                                 it. The optional --limit manual override is an
#                                 in-loop processing throttle, NOT a SQL cap, so
#                                 the anomaly detector always sees the full count.
#
# psql emits one pipe-separated row per patch; proposed_diff is base64-encoded
# to survive embedded newlines/pipes across the psql→shell→python boundary.
# python re-assembles each row into the canonical patch JSON object.
# Unix socket auth via -d glass_atrium (no -h, no host=).
extract_backlog_patches() {
    local psql_out psql_err psql_rc
    psql_err="$(mktemp -t autoagent-backlog.XXXXXX)"
    # shellcheck disable=SC2064
    trap "rm -f '${psql_err}'" RETURN

    if psql_out="$(
        psql -d glass_atrium -v ON_ERROR_STOP=1 -tAq -F'|' \
            2>"${psql_err}" <<'PSQL'
SELECT id,
       cycle_date,
       pattern_label,
       coalesce(target_agent, ''),
       target_file,
       translate(encode(convert_to(coalesce(proposed_diff, ''), 'UTF8'), 'base64'), E'\n', '')
FROM core.autoagent_proposals
WHERE approval_tier      = 'auto'::core."ApprovalTier"
  AND classification     = 'apply'::core."ProposalClassification"
  AND pre_verify_passed  = true
  AND status             = 'pending'::core."ProposalStatus"
  -- Confidence floor: EXPLICIT positive allowlist of apply-eligible
  -- promotion tiers — the QUALITY GATE on unattended auto-apply. Unattended
  -- candidate-tier apply is live by explicit user approval; this floor (not a
  -- blanket brake) is what keeps it safe. Widening the allowlist (adding
  -- 'mention') requires explicit user approval.
  -- The floor token 'mention' (classify_promotion_tier's lowest
  -- Beta-Binomial rung + the loop's fail-CLOSED floor state) is deliberately ABSENT, so
  -- it is excluded. NULL (legacy/pre-feature rows) + '' (explicit BYPASS,
  -- floorless) + the four above-floor tiers (the PromotionTier
  -- enum minus 'mention') all PASS. Behaviorally identical to a plain
  -- `IS DISTINCT FROM 'mention'` on current data, but stating the intent
  -- POSITIVELY makes a future column-default flip ('' -> 'mention') unable to
  -- silently INVERT flag-OFF behavior: an eligible row must MATCH the allowlist,
  -- never merely differ from one excluded token. promotion_tier is text
  -- (String?), so no enum cast needed.
  AND (
        promotion_tier IS NULL
     OR promotion_tier IN (
            '',                  -- BYPASS (operator OFF, floorless)
            'candidate',         -- above floor (posterior >= candidate threshold)
            'proposal',          -- above floor (intermediate ladder rung)
            'instruction-edit',  -- terminal: Tier-1 Auto (non-frontmatter)
            'skill-candidate'    -- terminal: Tier-2 user_pending (frontmatter)
        )
      )
ORDER BY cycle_date ASC, id ASC;
PSQL
    )"; then
        psql_rc=0
    else
        psql_rc=$?
    fi

    if [[ "${psql_rc}" -ne 0 ]]; then
        local err_msg
        err_msg="$(tr '\n' ' ' <"${psql_err}" | cut -c1-200)"
        printf '[daemon-apply] ERROR backlog_query failed rc=%d err=%s\n' \
            "${psql_rc}" "${err_msg}" >&2
        return 1
    fi

    # Reassemble pipe-separated rows into canonical patch JSON (shared transform).
    reassemble_proposal_rows "${psql_out}"
}

# extract_single_proposal — single-proposal mode. Emit the ONE proposal with
# id=PROPOSAL_ID on stdout (same row shape as extract_backlog_patches via the
# shared reassembler), or nothing if the id is absent / not actionable.
#
# Selection contract (DELIBERATELY different from the batch backlog):
#   id     = :'pid'                       (exactly one proposal)
#   status IN ('pending','snoozed')       (only non-terminal rows are actionable;
#                                          already applied/rejected/approved → 0 rows
#                                          → caller exits 8 no-op)
#   NO approval_tier filter   → BYPASS the auto gate. This path is reached ONLY
#                               via an explicit user button-click (the human-in-
#                               the-loop substitute for the safety gate), so a
#                               user MAY apply a safety/user-tier proposal here.
#   NO pre_verify_passed filter → user judgment takes priority over the 4-axis
#                               pre-verify gate.
#   haiku_status LIKE 'ok%'   → P3b fail-open CLOSE. UNLIKE approval_tier /
#                               pre_verify_passed (bypassed by-design above), the
#                               diff's Haiku pre-verify MUST have produced an 'ok*'
#                               verdict: the human click is NOT a substitute for that
#                               quality screen. A 401/credential outage leaves
#                               haiku_status skipped/empty/NULL — those rows were the
#                               2 live fossils that silently applied here, so they are
#                               now EXCLUDED (NULL is fail-closed, not admitted). LIKE
#                               'ok%' (never ='ok') keeps ok / ok:retried /
#                               ok:fuzzy-parsed. Operator carve-out: an operator who
#                               sets AUTOAGENT_ALLOW_HAIKU_SKIP=1 may still force-apply
#                               a haiku-skipped row (loud WARN), for the rare
#                               deliberate override — the human-override escape hatch.
# The auto-batch path (extract_backlog_patches) STILL excludes safety — only this
# explicit single path bypasses. Unix socket auth via -d glass_atrium.
extract_single_proposal() {
    local psql_out psql_err psql_rc
    psql_err="$(mktemp -t autoagent-single.XXXXXX)"
    # shellcheck disable=SC2064
    trap "rm -f '${psql_err}'" RETURN

    # -- haiku-skip fail-open guard (single human-override path) --------------
    # POLICY DECISION (explicit — P3b option (a): guard-WITH-carve-out). The
    # documented Tier-1 apply condition requires haiku_status to be 'ok*' (the
    # Haiku pre-verify actually RAN and passed). This single path bypasses the
    # auto-tier + pre_verify_passed gates BY DESIGN (the click is the human gate),
    # but that bypass is SCOPED to those two axes — it does NOT cover haiku_status.
    # A non-ok haiku_status (skipped/empty/error/NULL) means the diff was never
    # quality-screened (e.g. a 401 credential outage) — the documented-but-
    # unenforced fail-open that let 2 fossils apply. The SELECT below now requires
    # haiku_status LIKE 'ok%' (NULL excluded → fail-closed) UNLESS an operator
    # explicitly engages the carve-out. The carve-out is LOUD so it is never silent.
    local allow_haiku_skip=0
    case "${AUTOAGENT_ALLOW_HAIKU_SKIP:-0}" in
        1 | true | TRUE | yes | YES) allow_haiku_skip=1 ;;
        *) allow_haiku_skip=0 ;;
    esac
    if [[ "${allow_haiku_skip}" -eq 1 ]]; then
        printf '[daemon-apply] WARN haiku-skip guard BYPASSED by operator (AUTOAGENT_ALLOW_HAIKU_SKIP set) — id=%s may apply with a non-ok haiku_status (pre-verify skipped/failed)\n' \
            "${PROPOSAL_ID}" >&2
    fi

    if psql_out="$(
        psql -d glass_atrium -v ON_ERROR_STOP=1 -tAq -F'|' \
            -v "pid=${PROPOSAL_ID}" \
            -v "allow_haiku_skip=${allow_haiku_skip}" \
            2>"${psql_err}" <<'PSQL'
SELECT id,
       cycle_date,
       pattern_label,
       coalesce(target_agent, ''),
       target_file,
       translate(encode(convert_to(coalesce(proposed_diff, ''), 'UTF8'), 'base64'), E'\n', '')
FROM core.autoagent_proposals
WHERE id::text = :'pid'
  AND status IN ('pending'::core."ProposalStatus", 'snoozed'::core."ProposalStatus")
  -- haiku-skip fail-open guard (P3b): admit ONLY a row whose Haiku pre-verify
  -- produced an 'ok*' verdict, UNLESS the operator carve-out is engaged
  -- (:'allow_haiku_skip' = '1', warned loudly in the shell above). LIKE 'ok%'
  -- keeps ok / ok:retried / ok:fuzzy-parsed; a NULL haiku_status yields NULL
  -- (not TRUE) so it stays EXCLUDED — fail-closed. Pure SELECT-predicate add: no
  -- 2>/dev/null / || true, ON_ERROR_STOP=1 loud-fail intact.
  AND (:'allow_haiku_skip' = '1' OR haiku_status LIKE 'ok%');
PSQL
    )"; then
        psql_rc=0
    else
        psql_rc=$?
    fi

    if [[ "${psql_rc}" -ne 0 ]]; then
        local err_msg
        err_msg="$(tr '\n' ' ' <"${psql_err}" | cut -c1-200)"
        printf '[daemon-apply] ERROR single_proposal_query failed rc=%d id=%s err=%s\n' \
            "${psql_rc}" "${PROPOSAL_ID}" "${err_msg}" >&2
        return 1
    fi

    reassemble_proposal_rows "${psql_out}"
}

# verify_target_in_agents — sanity check: target_file MUST live under agents_dir.
verify_target_in_agents() {
    local target="$1"
    local agents_root
    agents_root="$(cd "${AGENTS_DIR}" && pwd)"
    # Resolve via the shared ga_realpath helper (readlink -f is GNU-only; the
    # helper's python realpath is the same symlink resolution the git-free
    # transaction target uses at GIT_TARGET).
    local target_real
    target_real="$(ga_realpath "${target}")"
    case "${target_real}" in
        "${agents_root}"/*) return 0 ;;
        *) return 1 ;;
    esac
}

# assert_diff_in_editable_region — apply-time LANDING-ZONE guard. Confirm the
# proposal diff lands INSIDE an editable region of the CURRENT target file before
# git apply touches it. Pre-verify validates the diff in isolation; it does NOT
# check the landing zone, so a diff that passes pre-verify can still land in a
# protected (non-editable) rule section. This is the missing apply-time check.
#
# Mirrors SkillOpt's _is_in_protected_region TEXT-ANCHOR approach against the
# agent files' `<!-- EDITABLE:BEGIN -->`/`<!-- EDITABLE:END -->` convention,
# INVERTED to an allowlist: a change is admissible ONLY when its anchor text sits
# inside SOME editable region. A file may hold N disjoint regions (dev-python has
# 5) → scan every BEGIN/END pair.
#
# Why TEXT-SUBSTRING, NOT `@@ -L,N +L,N @@` line numbers: `git apply --recount`
# recomputes the hunk line counts from the body, so the header line numbers are
# unreliable for the landing decision. We anchor on the diff body content found
# (or not) inside the file's editable regions.
#
# Verdict (single token on the python stdout, branched below):
#   ok            — every hunk positively anchors inside some editable region.
#   no_marker     — the target file has NO editable region at all → fail-closed.
#   out_of_region — a hunk anchor lands outside every region, OR a hunk has no
#                   in-region anchor at all (pure-add into a protected zone).
#   table_break   — every hunk anchors in-region, but an added non-pipe line lands
#                   between two GFM table rows (splits a table) → fail-closed (RC1
#                   apply-side catch: an in-region insert that corrupts a table).
#   header_less   — the diff has no '--- '/'+++ ' headers → a Strategy-B EOF-append
#                   fragment, which by construction lands at EOF OUTSIDE any region.
#   read_error    — the target file could not be read → fail-closed (loud).
#
# Returns 0 ONLY on the 'ok' verdict; every other verdict → return 1 (fail-closed)
# AFTER a loud named emit_log. The guard's OWN read must loud-fail — NO 2>/dev/null
# absorption on the python call (a swallowed guard failure would silently pass-
# through, the exact Precondition Loud-Fail anti-pattern). The python source is the
# _PY_GUARD module constant (captured once at load via a quoted heredoc — SC2259-
# safe; the source contains apostrophes a single-quoted bash assignment would
# break) and the diff is fed on stdin.
#
# Args: target (the real, git-facing agent file) · diff (proposed_diff) ·
#       label · diff_target (for the reject log attribution).
assert_diff_in_editable_region() {
    local target="$1"
    local diff="$2"
    local label="${3:-}"
    local diff_target="${4:-}"

    # Loud read: no 2>/dev/null absorption on the guard call, so a non-zero exit
    # or empty/non-ok verdict from python3 is treated as a fail-closed reject by
    # the verdict check below. Source = _PY_GUARD module constant (captured once
    # at load via a quoted heredoc); the diff is fed on stdin.
    local verdict
    verdict="$(printf '%s' "${diff}" | python3 -c "${_PY_GUARD}" "${target}")"

    if [[ "${verdict}" == "ok" ]]; then
        return 0
    fi

    # Fail-closed: any non-ok verdict rejects. Loud named emit_log + WARN.
    printf '[daemon-apply] WARN landing_zone_reject verdict=%s target=%s pattern=%s (diff does not land inside an editable region; rejected, row kept pending)\n' \
        "${verdict}" "${target}" "${label}" >&2
    emit_log "$(printf '{"ts":%s,"status":"reject","reason":"landing_zone_reject","verdict":%s,"pattern_label":%s,"target_file":%s}' \
        "$(ts_now_json)" \
        "$(printf '%s' "${verdict}" | json_escape)" \
        "$(printf '%s' "${label}" | json_escape)" \
        "$(printf '%s' "${diff_target:-${target}}" | json_escape)")"
    return 1
}

# apply_diff — write proposal patch to a tempfile and apply.
# Return codes (caller branches on the specific value):
#   0 — applied. Either Strategy A (unified diff landed at its intended mid-file
#       location via `git apply --recount`) OR Strategy B (a header-LESS
#       append-only fragment, whose only valid location IS end-of-file — this is
#       intended behavior for fragment-style proposals, NOT a mis-application).
#   3 — skip: the diff HAS unified-diff headers (it declares a target
#       location) but `git apply --recount` rejected it (stale/drifted/
#       un-recountable). We do NOT silently EOF-append a located diff — a
#       wrong-location patch recorded as success is a silent mis-application.
#       No bytes written; caller leaves the row pending
#       (no applied count, no PG flip) so regen can reprocess it.
#   1 — header-less fragment with NO extractable '+' content → malformed input
#       (caller's patch_apply_failed path).
#
# label/diff_target args (3rd/4th, optional) attribute the skip log to the patch.
#
# Boundary (why headers decide rc 3 vs Strategy B): a diff WITH '--- '/'+++ '
# headers asserts an exact target location; if --recount cannot land it there,
# appending at EOF would put it in the WRONG place — hence rc 3 skip. A diff
# WITHOUT headers asserts no location, so EOF is correct by construction.
# Conflating the two would EOF-append located diffs that failed to apply.
#
# Rationale for "skip + keep pending" over "append + mark applied" on the
# located-but-unappliable case: leaving the row pending AND appending at EOF
# would accumulate debris (the pending row is re-selected every cycle and
# re-appended unboundedly). Not appending keeps the target clean for a correct
# re-apply once regen produces a landable diff.
#
# shellcheck disable=SC2329
#   Invoked INDIRECTLY as the apply callback injected into git_txn_apply
#   (lib/git-txn.sh) — never called by `()` syntax in this file, so ShellCheck's
#   reachability pass cannot see the call site.
apply_diff() {
    local target="$1"
    local diff="$2"
    local label="${3:-}"
    local diff_target="${4:-}"
    local tmp
    tmp="$(mktemp -t autoagent-patch.XXXXXX)"
    local apply_err
    apply_err="$(mktemp -t autoagent-applyerr.XXXXXX)"
    # Single RETURN trap cleans BOTH tmps — a second `trap ... RETURN` would
    # REPLACE this one and leak the patch tmp.
    # shellcheck disable=SC2064
    trap "rm -f '${tmp}' '${apply_err}'" RETURN

    # Single-trailing-newline normalization (byte-level). PG's
    # proposed_diff already ends in '\n'; a blind `printf '%s\n'` would append a
    # SECOND newline → a phantom trailing empty line → `git apply --recount`
    # rescans the hunk body, counts that empty line as an extra trailing context
    # line, inflates the @@ old-count, and rejects ("patch does not apply") →
    # apply_diff rc 3 → needs_regen even for diffs that apply rc=0 manually.
    # Strip ALL trailing newlines then add EXACTLY one — idempotent whether the
    # diff arrives with a terminal newline (PG rows) or without one (still needs
    # one for git apply). bash 3.2: ${var%$'\n'} strips one, so loop.
    local diff_body="${diff}"
    while [[ "${diff_body}" == *$'\n' ]]; do
        diff_body="${diff_body%$'\n'}"
    done
    printf '%s\n' "${diff_body}" >"${tmp}"

    # Strategy A — located unified diff (has '--- '/'+++ ' headers).
    if grep -q '^--- ' "${tmp}" && grep -q '^+++ ' "${tmp}"; then
        # --recount recomputes hunk @@ counts from the actual hunk body, so
        # LLM diffs with wrong counts still land at their intended mid-file spot.
        # GA: run against GIT_ROOT so the patch lands in the monorepo worktree.
        #
        # _APPLY_DIR_ARGS (module-level) prepends --directory=<pathspec> so a
        # bare-basename diff header ('--- a/<file>.md') resolves to its real
        # location (<GIT_ROOT>/agents/<file>.md). Path resolution ONLY — hunk
        # placement (mid-file insert vs EOF) is unaffected, so the rc-3
        # no-EOF-append safety invariant for located diffs is preserved.
        if git -C "${GIT_ROOT}" apply --recount --whitespace=nowarn \
            ${_APPLY_DIR_ARGS[@]+"${_APPLY_DIR_ARGS[@]}"} "${tmp}" 2>"${apply_err}"; then
            return 0
        fi
        # A LOCATED diff that won't land. Do NOT EOF-append (wrong place +
        # debris), do NOT mark applied. Surface the ACTUAL git stderr (no longer
        # swallowed by 2>/dev/null) and distinguish a path/file-not-found failure
        # from a genuine recount/context reject — the 21-day backlog stall was a
        # path bug MISLABELED as a recount reject by the old hardcoded WARN.
        local apply_stderr reason
        apply_stderr="$(cat "${apply_err}" 2>/dev/null || true)"
        if grep -qi 'No such file or directory' "${apply_err}"; then
            reason="apply_path_not_found"
        else
            reason="located_diff_rejected"
        fi
        printf '[daemon-apply] WARN %s target=%s pattern=%s (located diff NOT applied; NOT appending at EOF, NOT marking applied — row kept pending for regen) git_stderr=%s\n' \
            "${reason}" "${target}" "${label}" "${apply_stderr}" >&2
        emit_log "$(printf '{"ts":%s,"status":"needs_regen","reason":%s,"pattern_label":%s,"target_file":%s,"git_stderr":%s}' \
            "$(ts_now_json)" \
            "$(printf '%s' "${reason}" | json_escape)" \
            "$(printf '%s' "${label}" | json_escape)" \
            "$(printf '%s' "${diff_target:-${target}}" | json_escape)" \
            "$(printf '%s' "${apply_stderr}" | json_escape)")"
        return 3
    fi

    # Strategy B — header-LESS append-only fragment. No declared location, so
    # end-of-file is the correct (intended) placement. Strip leading '+' from
    # each line and append. This is NOT the mis-application case.
    # bash 3.2 compat: avoid heredoc inside `$(...)` — use python -c instead.
    local addition
    local _py_extract='
import sys
out = []
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    for line in fh:
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            out.append(line[1:].rstrip("\n"))
sys.stdout.write("\n".join(out))
'
    addition="$(python3 -c "${_py_extract}" "${tmp}")"
    if [[ -n "${addition}" ]]; then
        # Ensure target ends with a newline before appending.
        if [[ -s "${target}" ]] && [[ "$(tail -c1 "${target}" | wc -l)" -eq 0 ]]; then
            printf '\n' >>"${target}"
        fi
        printf '%s\n' "${addition}" >>"${target}"
        return 0
    fi

    return 1
}

# verify_patched — confirm the file has new bytes and still parses (basic).
#
# shellcheck disable=SC2329
#   Invoked INDIRECTLY as the verify callback injected into git_txn_apply
#   (lib/git-txn.sh) — never called by `()` syntax in this file, so ShellCheck's
#   reachability pass cannot see the call site.
verify_patched() {
    local target="$1"
    [[ -s "${target}" ]] || return 1
    # Markdown sanity: at least one heading line. Cheap, no external deps.
    grep -q '^#' "${target}" || return 1
    return 0
}

# short_label — first 40 chars of pattern label, sanitised for commit message.
short_label() {
    local label="$1"
    printf '%s' "${label}" | tr '\n' ' ' | cut -c1-40
}

# update_db_status — transition core.autoagent_proposals.status
# pending/snoozed → 'applied' (+ reviewed_at = now()) for the
# (pattern_label, target_file, cycle_date) tuple of the just-committed patch.
# (snoozed is included so a user-approved snoozed proposal also lands; the
# backlog/report paths only ever select pending rows, so this is a no-op widen
# for them.)
#
# This UPDATE is the cross-cycle idempotency gate: once a row flips to
# 'applied' it leaves the next cycle's pending-backlog selection, so a patch
# can never be applied twice. The transition therefore MUST be reliable when
# the patch was sourced from the PG backlog.
#
# Two contracts, selected by the 4th arg `enforce`:
#   enforce=0 (default — JSON-report fallback path): best-effort.
#       - File commit + JSONL log are canonical truth for "applied".
#       - DB UPDATE failure / psql-absent / 0 rows → log + return 0
#         (NEVER roll back the commit, NEVER exit). Preserves legacy behavior
#         for no-DB hosts and the today-only fallback.
#   enforce=1 (backlog path): loud-fail (Precondition Loud-Fail,
#       shared-self-improve-hygiene.md). A backlog-sourced patch whose status UPDATE
#       fails (psql error OR 0 rows affected) would be silently re-applied next
#       cycle → exit 6 with a named stderr message instead of swallowing. The
#       file commit already landed; surfacing the gap loudly lets the operator
#       reconcile rather than letting the daemon re-apply the same patch nightly.
#
# Safety:
#   - Korean label binding via psql `\set` heredoc preprocessor (-v "k=value" +
#     :'k' substitution) — no shell-level SQL string concat → no injection vector.
#   - ON_ERROR_STOP=1 surfaces per-statement failures (no silent swallow).
#   - psql stderr → captured to ${psql_err}; both rowcount and error path log.
#   - Skipped entirely in dry-run (no DB side effect from simulation).
update_db_status() {
    local label="$1"
    local target="$2"
    local cycle="$3"
    local enforce="${4:-0}"
    local proposal_id="${5:-}"

    # Dry-run = simulate-only; do NOT touch DB.
    if [[ "${DRY_RUN}" -eq 1 ]]; then
        return 0
    fi

    # psql absent → DB sync disabled but apply still succeeds.
    # (enforce=1 is unreachable here: backlog selection requires psql, so the
    #  backlog path never reaches update_db_status without psql on PATH.)
    if ! command -v psql >/dev/null 2>&1; then
        printf '[daemon-apply] WARN db_status_update psql_not_found target=%s pattern=%s\n' \
            "${target}" "${label}" >&2
        return 0
    fi

    local psql_out psql_err psql_rc
    # Capture stderr separately so warnings can surface in the daemon log.
    psql_err="$(mktemp -t autoagent-dbsync.XXXXXX)"
    # shellcheck disable=SC2064
    trap "rm -f '${psql_err}'" RETURN

    # psql `-c` does NOT expand `:'var'` substitutions (per psql docs) — those
    # only work via `-f` / interactive / stdin heredoc. We pass SQL via stdin so
    # `\set`-style `:'k'` substitution happens in psql's preprocessor (NOT the
    # shell), making the binding immune to Korean strings, embedded apostrophes,
    # or shell metachars.
    # Flags:
    #   -t  = tuples-only (suppress header + row-count footer)
    #   -A  = unaligned (no padding; one field per line)
    #   -q  = quiet — suppresses the `UPDATE N` command-completion tag that
    #         heredoc-mode emits on stdout (which would otherwise be misread
    #         as a returning-id row by the awk counter below). Verified
    #         empirically: -tA alone leaves the tag visible; -tAq strips it.
    # Unix socket auth via -d glass_atrium (no -h, no host=).
    # Bind proposal_id and add a cast-safe id predicate so the UPDATE
    # flips EXACTLY the one proposal being applied — not every pending row that
    # shares (label,target,cycle_date). Two distinct proposals can collide on
    # that 3-tuple; without the id filter the first apply would flip both, and
    # the second apply would hit the enforce=1 "0 rows" loud-fail (exit 6).
    # `id::text = :'pid'` (string compare) avoids a ::bigint cast on the empty
    # report-path id; an empty :'pid' short-circuits to "no id filter" (the
    # report path keeps its (label,target,cycle) behavior).
    if psql_out="$(
        psql -d glass_atrium -v ON_ERROR_STOP=1 -tAq \
            -v "lbl=${label}" -v "tgt=${target}" -v "cd=${cycle}" -v "pid=${proposal_id}" \
            2>"${psql_err}" <<'PSQL'
UPDATE core.autoagent_proposals
SET status      = 'applied'::core."ProposalStatus",
    reviewed_at = now()
WHERE pattern_label = :'lbl'
  AND target_file   = :'tgt'
  AND status        IN ('pending'::core."ProposalStatus", 'snoozed'::core."ProposalStatus")
  AND cycle_date    = :'cd'::date
  AND (:'pid' = '' OR id::text = :'pid')
RETURNING id;
PSQL
    )"; then
        psql_rc=0
    else
        psql_rc=$?
    fi

    if [[ "${psql_rc}" -ne 0 ]]; then
        local err_msg
        err_msg="$(tr '\n' ' ' <"${psql_err}" | cut -c1-200)"
        printf '[daemon-apply] ERROR db_status_update failed rc=%d target=%s pattern=%s err=%s\n' \
            "${psql_rc}" "${target}" "${label}" "${err_msg}" >&2
        if [[ "${enforce}" == "1" ]]; then
            # Backlog-sourced patch already committed to the agent file; a failed
            # status flip would let it re-apply next cycle → loud-fail exit 6.
            printf '[daemon-apply] FATAL backlog patch committed but status UPDATE failed (would re-apply next cycle) target=%s pattern=%s\n' \
                "${target}" "${label}" >&2
            exit 6
        fi
        return 0 # best-effort: SQL failure ≠ apply failure (fallback path)
    fi

    # psql -tAc returns one id per row on stdout; count non-empty lines.
    local rows
    rows="$(printf '%s' "${psql_out}" | awk 'NF>0{n++} END{print n+0}')"

    if [[ "${rows}" -eq 0 ]]; then
        if [[ "${enforce}" == "1" ]]; then
            # Backlog row MUST exist as pending (we just selected it). 0 rows =
            # a concurrent mutation or schema drift broke the idempotency gate
            # → loud-fail rather than silently risk re-application next cycle.
            printf '[daemon-apply] FATAL backlog status UPDATE affected 0 rows (idempotency gate broken) target=%s pattern=%s cycle=%s\n' \
                "${target}" "${label}" "${cycle}" >&2
            exit 6
        fi
        # Fallback path benign: idempotent re-run, or row already
        # approved/applied/snoozed, or cycle_date mismatch — no destructive
        # effect, just visibility.
        printf '[daemon-apply] WARN db_status_update no_matching_row target=%s pattern=%s cycle=%s\n' \
            "${target}" "${label}" "${cycle}" >&2
    else
        printf '[daemon-apply] db_status_update target=%s pattern=%s rows=%d\n' \
            "${target}" "${label}" "${rows}" >&2
    fi

    return 0
}

# mark_stale_attempt — bounded-retry → terminal-drain for the batch
# stale/needs_regen path (apply_diff rc 3). The batch backlog NEVER auto-regens by
# design, so a row whose stored diff no longer lands just re-selects every
# cycle forever. This counts CONSECUTIVE stale selections of the EXACT row and,
# at STALE_DRAIN_THRESHOLD, terminally drains it to 'snoozed' so it STOPS
# re-selecting — WITHOUT forcing a batch auto-regen (the deliberate design holds)
# and WITHOUT a new enum value ('snoozed' already exists; the batch SELECT keys
# status='pending' and so excludes it; the explicit --proposal-id path still
# recovers it).
#
# Schema dependency (FLAGGED, NOT faked): the per-row cross-cycle counter needs a
# durable column `core.autoagent_proposals.stale_attempt_count int NOT NULL
# DEFAULT 0`. The daily JSONL log cannot count cross-day, so a DB column is the
# only durable home. This function is COLUMN-PRESENCE-TOLERANT: a single SQL guards
# the increment behind an information_schema check, so when the migration has NOT
# yet been applied the statement NEVER errors — it returns sentinel 'no_column' and
# the caller degrades to the column-absent behavior (row left pending) with a loud WARN
# naming the missing column. Once the column exists the drain activates with no
# further code change.
#
# Verdict (single token on stdout, for the caller to branch on):
#   no_column   — counter column absent (migration pending) → left pending + WARN.
#   incremented — counter < threshold → still pending (bounded-retry window).
#   drained     — counter reached threshold → status flipped to 'snoozed' (terminal
#                 for the batch path).
#
# enforce arg mirrors update_db_status: 1 = backlog/single (loud-fail on psql
# error — a swallowed counter bug would silently re-fossilize); 0 = report path.
# Skipped entirely in dry-run (no DB side effect from simulation).
mark_stale_attempt() {
    local label="$1"
    local target="$2"
    local cycle="$3"
    local enforce="${4:-0}"
    local proposal_id="${5:-}"

    if [[ "${DRY_RUN}" -eq 1 ]]; then
        printf 'incremented'
        return 0
    fi

    # psql absent → batch path is unreachable here (backlog needs psql), but guard
    # anyway so a report-path stale never crashes.
    if ! command -v psql >/dev/null 2>&1; then
        printf '[daemon-apply] WARN stale_drain psql_not_found target=%s pattern=%s\n' \
            "${target}" "${label}" >&2
        printf 'no_column'
        return 0
    fi

    local psql_out psql_err psql_rc
    psql_err="$(mktemp -t autoagent-staledrain.XXXXXX)"
    # shellcheck disable=SC2064
    trap "rm -f '${psql_err}'" RETURN

    # Single round-trip. A guarded CTE:
    #   col   — does stale_attempt_count exist? (information_schema, never errors)
    #   bumped— increment + conditional terminal flip, ONLY when the column exists.
    #           The increment lands first; the same statement flips status to
    #           'snoozed' once the NEW count >= threshold (so attempt N is the one
    #           that drains). reviewed_at stamps the terminal transition.
    # The final SELECT emits exactly one verdict token. When the column is absent
    # `bumped` is empty (the UPDATE is gated on `col`), so the SELECT returns
    # 'no_column' and NOTHING is mutated — the row stays pending (column-absent path).
    # Bindings mirror update_db_status (psql `:'k'` preprocessor — no shell concat,
    # injection-safe for Korean labels / apostrophes / metachars).
    if psql_out="$(
        psql -d glass_atrium -v ON_ERROR_STOP=1 -tAq \
            -v "lbl=${label}" -v "tgt=${target}" -v "cd=${cycle}" \
            -v "pid=${proposal_id}" -v "thr=${STALE_DRAIN_THRESHOLD}" \
            2>"${psql_err}" <<'PSQL'
WITH col AS (
    SELECT count(*) > 0 AS present
    FROM information_schema.columns
    WHERE table_schema = 'core'
      AND table_name   = 'autoagent_proposals'
      AND column_name  = 'stale_attempt_count'
),
bumped AS (
    UPDATE core.autoagent_proposals p
    SET stale_attempt_count = coalesce(p.stale_attempt_count, 0) + 1,
        status = CASE
            WHEN coalesce(p.stale_attempt_count, 0) + 1 >= :'thr'::int
            THEN 'snoozed'::core."ProposalStatus"
            ELSE p.status
        END,
        reviewed_at = CASE
            WHEN coalesce(p.stale_attempt_count, 0) + 1 >= :'thr'::int
            THEN now()
            ELSE p.reviewed_at
        END
    FROM col
    WHERE col.present
      AND p.pattern_label = :'lbl'
      AND p.target_file   = :'tgt'
      AND p.status        IN ('pending'::core."ProposalStatus", 'snoozed'::core."ProposalStatus")
      AND p.cycle_date    = :'cd'::date
      AND (:'pid' = '' OR p.id::text = :'pid')
    RETURNING p.stale_attempt_count AS new_count, p.status AS new_status
)
SELECT CASE
    WHEN NOT (SELECT present FROM col) THEN 'no_column'
    WHEN NOT EXISTS (SELECT 1 FROM bumped) THEN 'no_row'
    WHEN (SELECT new_status FROM bumped) = 'snoozed' THEN 'drained'
    ELSE 'incremented'
END;
PSQL
    )"; then
        psql_rc=0
    else
        psql_rc=$?
    fi

    if [[ "${psql_rc}" -ne 0 ]]; then
        local err_msg
        err_msg="$(tr '\n' ' ' <"${psql_err}" | cut -c1-200)"
        printf '[daemon-apply] ERROR stale_drain failed rc=%d target=%s pattern=%s err=%s\n' \
            "${psql_rc}" "${target}" "${label}" "${err_msg}" >&2
        if [[ "${enforce}" == "1" ]]; then
            # Counter UPDATE failed on a backlog/single row → loud-fail. A swallowed
            # failure would keep the fossil re-selecting (the very thing the drain fixes).
            printf '[daemon-apply] FATAL stale-drain counter UPDATE failed (fossil would persist) target=%s pattern=%s\n' \
                "${target}" "${label}" >&2
            exit 15
        fi
        printf 'no_column'
        return 0
    fi

    # psql -tAq emits exactly one verdict line; strip whitespace.
    local verdict
    verdict="$(printf '%s' "${psql_out}" | tr -d '[:space:]')"
    [[ -n "${verdict}" ]] || verdict="no_column"
    printf '%s' "${verdict}"
    return 0
}

# emit_stale_drain LABEL TARGET CYCLE ID TIMESTAMP — shared bounded-retry stale-drain
# emit for the two needs_regen sites (landing-zone reject + apply_rc==3). Self-gated on
# the no-auto-regen re-selectable contract (AUTO_REGEN -ne 1 AND backlog|single — a
# report-path stale has no backlog re-selection to fossilize, so it is skipped). Runs
# the bounded counter (mark_stale_attempt, enforce=1 → loud-fail on the UPDATE), emits
# the needs_regen JSON with the reason pre-composed as stale_drain_<verdict> and escaped
# ONCE (never a nested already-encoded token), and reports the terminal drained /
# column-absent no_column verdicts on stderr. Always returns 0 so a set -e call site
# stays on its own control flow — each caller owns its surrounding reset/pop/continue.
emit_stale_drain() {
    local label="$1"
    local target="$2"
    local cycle="$3"
    local id="$4"
    local ts="$5"

    if [[ "${AUTO_REGEN}" -ne 1 ]] \
        && { [[ "${PATCH_SOURCE}" == "backlog" ]] || [[ "${PATCH_SOURCE}" == "single" ]]; }; then
        local stale_verdict
        stale_verdict="$(mark_stale_attempt "${label}" "${target}" "${cycle}" 1 "${id}")"
        emit_log "$(printf '{"ts":%s,"status":"needs_regen","reason":%s,"pattern_label":%s,"target_file":%s,"cycle_date":%s,"proposal_id":%s}' \
            "$(printf '%s' "${ts}" | json_escape)" \
            "$(printf '%s' "stale_drain_${stale_verdict}" | json_escape)" \
            "$(printf '%s' "${label}" | json_escape)" \
            "$(printf '%s' "${target}" | json_escape)" \
            "$(printf '%s' "${cycle}" | json_escape)" \
            "$(printf '%s' "${id}" | json_escape)")"
        if [[ "${stale_verdict}" == "drained" ]]; then
            printf '[daemon-apply] stale-drain: id=%s pattern=%s reached %d stale attempts — drained to snoozed (no batch auto-regen by design)\n' \
                "${id}" "${label}" "${STALE_DRAIN_THRESHOLD}" >&2
        elif [[ "${stale_verdict}" == "no_column" ]]; then
            printf '[daemon-apply] WARN stale-drain: stale_attempt_count column absent (migration pending) — id=%s left pending, fossil NOT drained\n' \
                "${id}" >&2
        fi
    fi
    return 0
}

# -- Main loop -------------------------------------------------------------

PROCESSED=0
APPLIED=0
SKIPPED=0
ERRORS=0
# Count of patches Strategy A could not land (kept pending for regen) —
# distinct from ERRORS so the summary distinguishes "deferred" from "failed".
NEEDS_REGEN=0

# Select the patch source. Three modes:
#   SINGLE   = --proposal-id N: exactly one proposal, tier/pre_verify gate
#              bypassed (explicit user approval). Highest priority.
#   BACKLOG  = cross-cycle PG backlog (oldest-first) — the default cron path.
#   REPORT   = today's JSON report (when psql absent or dry-run).
# PATCH_SOURCE drives the loud-fail contract: backlog AND single sources enforce
# the status UPDATE (exit 6 on failure); report-sourced patches stay best-effort.
# bash 3.2 compat: mapfile is bash 4+, so we use IFS=$'\n' + read loop.
PATCH_ROWS=()
PATCH_SOURCE="report"

if [[ -n "${PROPOSAL_ID}" ]]; then
    # Single-proposal mode. Requires psql (the row lives in PG). enforce=1
    # via PATCH_SOURCE=single so the status flip is loud-fail like the backlog.
    if ! command -v psql >/dev/null 2>&1; then
        printf '[daemon-apply] FATAL: --proposal-id requires psql (proposal lives in PG)\n' >&2
        exit 3
    fi
    PATCH_SOURCE="single"
    while IFS= read -r _row; do
        [[ -n "${_row}" ]] && PATCH_ROWS+=("${_row}")
    done < <(extract_single_proposal)
elif backlog_source_available; then
    PATCH_SOURCE="backlog"
    while IFS= read -r _row; do
        [[ -n "${_row}" ]] && PATCH_ROWS+=("${_row}")
    done < <(extract_backlog_patches)
else
    # Fallback path only: an absent report = nothing to apply. (Relocated from
    # the old line-219 guard so it no longer short-circuits the backlog path,
    # which is the PRIMARY source and needs no today-dated report.)
    if [[ ! -f "${REPORT_PATH}" ]]; then
        printf '[daemon-apply] no report at %s — nothing to apply\n' "${REPORT_PATH}" >&2
        exit 0
    fi
    while IFS= read -r _row; do
        [[ -n "${_row}" ]] && PATCH_ROWS+=("${_row}")
    done < <(extract_body_auto_patches "${REPORT_PATH}")
fi

if [[ ${#PATCH_ROWS[@]} -eq 0 ]]; then
    if [[ "${PATCH_SOURCE}" == "single" ]]; then
        # Idempotent no-op: id absent OR status not in pending/snoozed
        # (already applied/rejected/approved). Distinct exit 8 so the API can
        # report "nothing to do" vs an apply failure.
        printf '[daemon-apply] proposal id=%s not actionable (not found, or status not in pending/snoozed) — no-op\n' \
            "${PROPOSAL_ID}" >&2
        exit 8
    elif [[ "${PATCH_SOURCE}" == "backlog" ]]; then
        printf '[daemon-apply] 0 pending backlog patches (source=PG)\n' >&2
    else
        printf '[daemon-apply] 0 body-auto patches in %s\n' "${REPORT_PATH}" >&2
    fi
    exit 0
fi

# -- Anomaly tripwire (core-security.md LLM10 unbounded-consumption guard) -------
# Backlog path only: the count is the TRUE eligible-pending total (no SQL LIMIT
# was applied). An abnormally large backlog is not a real backlog — it signals
# a proposal-generation bug flooding core.autoagent_proposals. Loud-fail
# (exit 7) and apply NOTHING rather than risk a runaway mass-apply. The single
# path (1 row) and the JSON-report fallback are naturally bounded, so exempt.
if [[ "${PATCH_SOURCE}" == "backlog" ]] && [[ ${#PATCH_ROWS[@]} -gt ${ANOMALY_THRESHOLD} ]]; then
    printf '[daemon-apply] FATAL: backlog anomaly — %d eligible-pending rows exceed ANOMALY_THRESHOLD=%d; applying nothing (likely proposal-generation runaway, investigate core.autoagent_proposals)\n' \
        "${#PATCH_ROWS[@]}" "${ANOMALY_THRESHOLD}" >&2
    exit 7
fi

# apply_patch_rows — drain the global PATCH_ROWS array, applying each patch and
# mutating the shared counters (PROCESSED/APPLIED/SKIPPED/ERRORS/NEEDS_REGEN).
# A function (not inline) so the auto-regen re-attempt can re-run the EXACT same
# apply path on a freshly-regenerated single row (zero duplication).
# The loop body is intentionally NOT re-indented: a function body needs no
# indentation in bash, and re-indenting would push the `_py_extract` heredoc's
# column-0 `PY` delimiter inward — breaking heredoc termination.
apply_patch_rows() {
local row
for row in "${PATCH_ROWS[@]}"; do
    # LIMIT=0 = unbounded (drain all). LIMIT>0 = optional manual processing
    # throttle for ad-hoc operator use (NOT the anomaly guard, which already
    # fired above on the true total).
    if [[ "${LIMIT}" -gt 0 ]] && [[ "${PROCESSED}" -ge "${LIMIT}" ]]; then
        printf '[daemon-apply] reached --limit=%d, stopping (manual override)\n' "${LIMIT}" >&2
        break
    fi
    PROCESSED=$((PROCESSED + 1))

    # Extract fields with python (avoids jq dependency).
    # ROBUSTNESS: capture the Python source via a quoted heredoc (no shell
    # interpolation, no `\"` escapes) and feed the JSON row via a here-string
    # on stdin. Python uses single-quoted string literals, so bash quoting
    # and Python source remain unambiguous — a future shell-quoting refactor
    # cannot silently corrupt the field extraction.
    _py_extract="$(cat <<'PY'
import json, shlex, sys
patch = json.loads(sys.stdin.read())
print(f"PATCH_LABEL={shlex.quote(patch.get('pattern_label', ''))}")
print(f"PATCH_AGENT={shlex.quote(patch.get('pattern_agent', ''))}")
print(f"PATCH_TARGET={shlex.quote(patch.get('target_file', ''))}")
print(f"PATCH_DIFF={shlex.quote(patch.get('proposed_diff', ''))}")
# Backlog rows carry a per-row cycle_date (the status UPDATE keys on it).
# Report rows omit it (empty); the caller then defaults to today CYCLE_DATE.
print(f"PATCH_CYCLE={shlex.quote(patch.get('cycle_date', ''))}")
# proposal_id completes the dedup key. Report rows have no id (empty).
print(f"PATCH_ID={shlex.quote(str(patch.get('proposal_id', '')))}")
PY
)"
    _vars="$(python3 -c "${_py_extract}" <<<"${row}")"
    eval "${_vars}"

    # Backlog rows transition on their OWN cycle_date; report rows on today's.
    patch_cycle="${PATCH_CYCLE:-}"
    [[ -n "${patch_cycle}" ]] || patch_cycle="${CYCLE_DATE}"
    # report rows have no proposal id — empty string is a valid key
    # component (report-path dedup keeps its label+target behavior).
    patch_id="${PATCH_ID:-}"

    timestamp="$(ts_now)"

    # -- Sanity 1: target inside agents/ ----------------------------------
    if ! verify_target_in_agents "${PATCH_TARGET}"; then
        ERRORS=$((ERRORS + 1))
        emit_log "$(printf '{"ts":%s,"status":"reject","reason":"target_outside_agents","pattern_label":%s,"target_file":%s}' \
            "$(printf '%s' "${timestamp}" | json_escape)" \
            "$(printf '%s' "${PATCH_LABEL}" | json_escape)" \
            "$(printf '%s' "${PATCH_TARGET}" | json_escape)")"
        continue
    fi

    # -- Sanity 2: idempotency check (4-tuple key incl. cycle+id) ---
    if already_applied "${PATCH_LABEL}" "${PATCH_TARGET}" "${patch_cycle}" "${patch_id}"; then
        SKIPPED=$((SKIPPED + 1))
        emit_log "$(printf '{"ts":%s,"status":"skip","reason":"already_applied","pattern_label":%s,"target_file":%s}' \
            "$(printf '%s' "${timestamp}" | json_escape)" \
            "$(printf '%s' "${PATCH_LABEL}" | json_escape)" \
            "$(printf '%s' "${PATCH_TARGET}" | json_escape)")"
        continue
    fi

    # -- Resolve the real (GA) target path --------------------------------
    # PG stores facade paths (~/.claude/agents/X.md = symlink → GA). The git-free
    # transaction captures the before-image of, and atomically restores, the REAL
    # file, and `git apply --recount` lands the diff on it — so resolve the symlink
    # to the GA real file (~/.glass-atrium/agents/X.md) first. In a standalone
    # layout (no symlink) realpath is an identity, so this is a no-op there.
    GIT_TARGET="$(ga_realpath "${PATCH_TARGET}")"

    # -- Dry-run short-circuit --------------------------------------------
    if [[ "${DRY_RUN}" -eq 1 ]]; then
        emit_log "$(printf '{"ts":%s,"status":"dryrun","pattern_label":%s,"pattern_agent":%s,"target_file":%s,"would_commit":true}' \
            "$(printf '%s' "${timestamp}" | json_escape)" \
            "$(printf '%s' "${PATCH_LABEL}" | json_escape)" \
            "$(printf '%s' "${PATCH_AGENT}" | json_escape)" \
            "$(printf '%s' "${PATCH_TARGET}" | json_escape)")"
        APPLIED=$((APPLIED + 1))
        continue
    fi

    # -- Sanity 4: landing-zone guard (pre-apply) -------------------------
    # BEFORE the apply: confirm the diff lands inside an editable region of the
    # CURRENT target file. Pre-verify checks the diff in isolation, not its landing
    # zone, so a pre-verified diff can still land in a protected rule section. Read
    # the GA real path (GIT_TARGET) — the file `git apply` touches. A READ-ONLY
    # validation (nothing on disk mutated), so it joins the pre-apply Sanity checks
    # above. Fail-closed: a non-ok verdict (no marker / out of region / header-less
    # Strategy-B fragment / read error) counts ERRORS, drives the bounded-retry
    # stale-drain (so a permanently out_of_region row cannot re-select forever), and
    # leaves the row pending. No bytes were written → nothing to restore. assert_*
    # already emitted the loud named landing_zone_reject log.
    if ! assert_diff_in_editable_region "${GIT_TARGET}" "${PATCH_DIFF}" "${PATCH_LABEL}" "${PATCH_TARGET}"; then
        # COUNTER CLASSIFICATION (EXPLICIT, DOCUMENTED decision — NOT a silent change):
        # this landing-zone reject keeps incrementing ERRORS, whereas the functionally
        # similar apply_rc==3 stale path below increments NEEDS_REGEN. The divergence is
        # DELIBERATE and retained: a landing-zone reject is a HARD editable-region
        # violation (the diff anchors outside every region — a diff that should never
        # have been generatable), reported as an error; apply_rc==3 is the SOFTER
        # "stored diff no longer applies cleanly" needs-regen condition. Only the
        # bounded-retry stale-drain WIRING is mirrored here, NOT the counter bucket.
        ERRORS=$((ERRORS + 1))

        # Bounded-retry → terminal-drain via the shared emit_stale_drain helper (also
        # called from the apply_rc==3 path below). WITHOUT this call an out_of_region row
        # (e.g. proposal 1022) re-selects every cycle FOREVER — stale_attempt_count stays
        # 0 because ONLY the apply_rc==3 path drained. The helper owns the gate, the
        # enforce=1 loud-fail, and the verdict handling. This site runs BEFORE any apply
        # (no bytes written, nothing to restore) so — unlike apply_rc==3 — the single
        # trailing `continue` is the sole exit. AUTO_REGEN -ne 1 edge (gated inside the
        # helper): a single + --auto-regen + out_of_region row is neither drained nor
        # regenerated (regen owns its fate), matching the apply_rc==3 behavior.
        emit_stale_drain "${PATCH_LABEL}" "${PATCH_TARGET}" "${patch_cycle}" "${patch_id}" "${timestamp}"

        continue
    fi

    # -- Transaction: capture before-image -> apply -> verify -> (keep | restore) ---
    # git_txn_apply (lib/git-txn.sh) owns the before-image capture, the apply +
    # verify steps, and the atomic restore-from-before-image on verify failure; it
    # reports the structured outcome in GIT_TXN_RC. apply_diff + verify_patched are
    # injected as the apply/verify callbacks — SAME calls, SAME rc contract
    # (0 / 3 / other) as the former inline version. The counter buckets
    # (ERRORS/NEEDS_REGEN/APPLIED), emit_log reasons, emit_stale_drain, and
    # update_db_status STAY HERE: the lib is the shared mechanism, this block is the
    # daemon policy that maps each outcome to its bucket. apply_msg is built BEFORE
    # the call so it is recorded in the applied JSONL commit_message field.
    #
    # backup_subdir: a PER-PROPOSAL dir under BACKUP_DIR (agents-bak/<cycle>_p<id>)
    # so each patch's before-image is isolated and the daemon's retention prune can
    # drop whole per-cycle subdirs by age. git_txn_apply mkdir -p's it on capture.
    short="$(short_label "${PATCH_LABEL}")"
    apply_msg="${APPLY_PREFIX} T7 patch: ${PATCH_AGENT} ${short}"
    backup_subdir="${BACKUP_DIR}/${patch_cycle}_p${patch_id}"
    # Invoked BARE (never `|| rc=$?`) — see git-txn.sh "set -e contract": bare
    # invocation keeps set -e active inside the function, so a contract violation
    # (wrong arity / bad callback) loud-fails the daemon instead of being masked.
    git_txn_apply \
        "${GIT_ROOT}" "${PATCH_TARGET}" "${GIT_TARGET}" "${PATCH_DIFF}" \
        "${backup_subdir}" \
        apply_diff verify_patched "${PATCH_LABEL}" "${PATCH_TARGET}"

    if [[ "${GIT_TXN_RC}" -eq "${GIT_TXN_BACKUP_CAPTURE_FAIL}" ]]; then
        # Before-image capture failed — nothing was applied, nothing to restore.
        ERRORS=$((ERRORS + 1))
        emit_log "$(printf '{"ts":%s,"status":"error","reason":"backup_capture_failed","pattern_label":%s,"target_file":%s}' \
            "$(printf '%s' "${timestamp}" | json_escape)" \
            "$(printf '%s' "${PATCH_LABEL}" | json_escape)" \
            "$(printf '%s' "${PATCH_TARGET}" | json_escape)")"
        continue
    fi
    if [[ "${GIT_TXN_RC}" -eq "${GIT_TXN_APPLY_REGEN}" ]]; then
        # apply_diff rc 3 — a located diff that would not land. apply_diff already
        # logged the distinct needs_regen reason + wrote NO bytes, so the live file
        # is untouched (nothing to restore). Leave the PG row pending (NO
        # update_db_status), do NOT count as applied — a deferred-regen skip
        # tracked separately from errors.
        NEEDS_REGEN=$((NEEDS_REGEN + 1))

        # Bounded-retry → terminal-drain via the shared emit_stale_drain helper. The row
        # re-selects next cycle (the no-auto-regen design keeps it pending), so without a
        # bound it fossilizes; the helper counts consecutive stale selections and, at
        # STALE_DRAIN_THRESHOLD, flips it to 'snoozed' so it STOPS re-selecting — no batch
        # auto-regen, no new enum. The helper's gate SKIPs when --auto-regen is set (regen
        # owns that row's fate) and for report-path stale (no backlog re-selection to
        # fossilize).
        emit_stale_drain "${PATCH_LABEL}" "${PATCH_TARGET}" "${patch_cycle}" "${patch_id}" "${timestamp}"

        continue
    fi
    if [[ "${GIT_TXN_RC}" -eq "${GIT_TXN_APPLY_FAIL}" ]]; then
        # apply_diff malformed (rc != 0,3) — it wrote NO bytes, so the live file is
        # untouched (nothing to restore).
        ERRORS=$((ERRORS + 1))
        emit_log "$(printf '{"ts":%s,"status":"error","reason":"patch_apply_failed","pattern_label":%s,"target_file":%s}' \
            "$(printf '%s' "${timestamp}" | json_escape)" \
            "$(printf '%s' "${PATCH_LABEL}" | json_escape)" \
            "$(printf '%s' "${PATCH_TARGET}" | json_escape)")"
        continue
    fi
    if [[ "${GIT_TXN_RC}" -eq "${GIT_TXN_VERIFY_FAIL}" ]]; then
        # verify_patched failed. git_txn_apply already ATOMICALLY restored the
        # target (GIT_TARGET, the GA real path) from its before-image.
        ERRORS=$((ERRORS + 1))
        emit_log "$(printf '{"ts":%s,"status":"error","reason":"verify_failed","pattern_label":%s,"target_file":%s}' \
            "$(printf '%s' "${timestamp}" | json_escape)" \
            "$(printf '%s' "${PATCH_LABEL}" | json_escape)" \
            "$(printf '%s' "${PATCH_TARGET}" | json_escape)")"
        continue
    fi

    # GIT_TXN_RC == GIT_TXN_OK: the applied bytes are in place; the before-image
    # stays in the backup dir as the post-hoc rollback anchor until retention prunes.

    APPLIED=$((APPLIED + 1))

    # applied row carries cycle_date + proposal_id so a future drain's
    # already_applied can match the full 4-tuple (and skip ONLY a true re-attempt
    # of this exact proposal, not other distinct-cycle proposals for the agent).
    emit_log "$(printf '{"ts":%s,"status":"applied","pattern_label":%s,"pattern_agent":%s,"target_file":%s,"cycle_date":%s,"proposal_id":%s,"commit_message":%s}' \
        "$(printf '%s' "${timestamp}" | json_escape)" \
        "$(printf '%s' "${PATCH_LABEL}" | json_escape)" \
        "$(printf '%s' "${PATCH_AGENT}" | json_escape)" \
        "$(printf '%s' "${PATCH_TARGET}" | json_escape)" \
        "$(printf '%s' "${patch_cycle}" | json_escape)" \
        "$(printf '%s' "${patch_id}" | json_escape)" \
        "$(printf '%s' "${apply_msg}" | json_escape)")"

    # -- DB status sync (idempotency gate) --------------------------------
    # Transition core.autoagent_proposals.status: pending/snoozed → 'applied'.
    # Runs AFTER the file apply + JSONL write (both canonical) so SQL failure
    # cannot orphan the file-side success. This flip is what removes the row
    # from the next cycle's pending-backlog selection (cross-cycle idempotency).
    # Backlog AND single sources → enforce=1 (loud-fail exit 6 if the flip
    # fails, so the committed patch can never be silently re-applied). Report
    # source → enforce=0 (legacy best-effort for no-DB / today-only fallback).
    if [[ "${PATCH_SOURCE}" == "backlog" ]] || [[ "${PATCH_SOURCE}" == "single" ]]; then
        update_db_status "${PATCH_LABEL}" "${PATCH_TARGET}" "${patch_cycle}" 1 "${patch_id}"
    else
        update_db_status "${PATCH_LABEL}" "${PATCH_TARGET}" "${patch_cycle}" 0 "${patch_id}"
    fi
done
}

# run_regen_for_single — accept-path. Invoke daemon_cycle.py to regenerate
# the stale diff for PROPOSAL_ID, parse its single stdout JSON object, and emit
# `action<TAB>axes` on stdout for the caller to branch on (the caller runs this
# in a $(...) subshell, so the action + axes MUST travel on stdout, not a global).
# daemon_cycle's human/diagnostic text stays on its own stderr (passed through).
# On a daemon_cycle crash / unparseable output → "unrecoverable" (loud-fail: the
# row stays pending, nothing is silently applied). Honors --dry-run.
run_regen_for_single() {
    local dc_out dc_rc=0
    local dc_args=(--regenerate-stale --proposal-id "${PROPOSAL_ID}")
    if [[ "${DRY_RUN}" -eq 1 ]]; then
        dc_args+=(--dry-run)
    fi
    if [[ ! -f "${DAEMON_CYCLE_PY}" ]]; then
        printf '[daemon-apply] FATAL: daemon_cycle.py not found at %s (cannot auto-regen)\n' \
            "${DAEMON_CYCLE_PY}" >&2
        printf '%s\t%s\n' "unrecoverable" ""
        return 0
    fi
    # daemon_cycle exit: 0 regenerated/already_applied · 1 invalid/unrecoverable ·
    # 2 bad args. We branch on the JSON `action` (authoritative verdict), NOT the
    # exit code; the code is captured only for the log.
    if dc_out="$(python3 "${DAEMON_CYCLE_PY}" "${dc_args[@]}")"; then
        dc_rc=0
    else
        dc_rc=$?
    fi

    # Parse the single JSON object's `action` + `preverify_axes`. Prefer jq
    # (script already prefers jq with python fallback); else python3.
    local action axes
    if command -v jq >/dev/null 2>&1; then
        action="$(printf '%s' "${dc_out}" | jq -r '.action // "unrecoverable"' 2>/dev/null || true)"
        axes="$(printf '%s' "${dc_out}" | jq -r '(.preverify_axes // {}) | to_entries | map("\(.key)=\(.value)") | join(",")' 2>/dev/null || true)"
    else
        action="$(printf '%s' "${dc_out}" | python3 -c "${REGEN_PARSE_ACTION_PY}" 2>/dev/null || true)"
        axes="$(printf '%s' "${dc_out}" | python3 -c "${REGEN_PARSE_AXES_PY}" 2>/dev/null || true)"
    fi
    [[ -n "${action}" ]] || action="unrecoverable"

    printf '[daemon-apply] auto-regen: daemon_cycle id=%s action=%s rc=%d axes=[%s]\n' \
        "${PROPOSAL_ID}" "${action}" "${dc_rc}" "${axes}" >&2
    # stdout = `action<TAB>axes` (single line). The caller runs this in a $(...)
    # subshell, so a plain global REGEN_AXES assignment would NOT survive — emit
    # both fields on stdout and let the caller split on the TAB.
    printf '%s\t%s\n' "${action}" "${axes}"
    return 0
}

# -- Retention prune (once per real cycle) ---------------------------------
# Housekeeping: drop age-expired before-image subdirs under BACKUP_DIR (the newest
# anchor is always protected). Skip in dry-run — it deletes real backup dirs.
# Best-effort + loud inside the helper: a prune failure never aborts the cycle.
if [[ "${DRY_RUN}" -eq 0 ]]; then
    prune_backup_retention
fi

# -- Drain (extracted apply loop) ------------------------------------------
apply_patch_rows

# -- Auto-regen on the stale path (--proposal-id + --auto-regen) ------
# Trigger: single mode, the apply did NOT land (APPLIED=0), the failure was the
# STALE/needs_regen path (NEEDS_REGEN>=1 — apply_diff rc 3, NOT a hard error),
# AND --auto-regen is set. Anything else (hard-error path, --auto-regen off)
# falls through to the unchanged exit-9 block below.
if [[ "${PATCH_SOURCE}" == "single" ]] && [[ "${APPLIED}" -eq 0 ]] \
    && [[ "${AUTO_REGEN}" -eq 1 ]] && [[ "${NEEDS_REGEN}" -ge 1 ]]; then
    printf '[daemon-apply] auto-regen: id=%s stale (needs_regen=%d) — invoking daemon_cycle regen\n' \
        "${PROPOSAL_ID}" "${NEEDS_REGEN}" >&2
    # run_regen_for_single emits `action<TAB>axes` on stdout (subshell-safe — a
    # global var would not survive $()). Split on the TAB.
    regen_out="$(run_regen_for_single)"
    regen_action="${regen_out%%$'\t'*}"
    regen_axes="${regen_out#*$'\t'}"
    [[ "${regen_axes}" != "${regen_out}" ]] || regen_axes=""  # no TAB → empty axes

    case "${regen_action}" in
        regenerated)
            # daemon_cycle UPDATEd proposed_diff with a fresh validity-gated diff
            # (skipped in dry-run — daemon_cycle does NOT touch PG then). Re-SELECT
            # the row (now carrying the fresh diff) and RE-ATTEMPT the apply via the
            # EXACT same apply path. Reset the per-attempt counters first so the
            # second drain's verdict reads cleanly.
            printf '[daemon-apply] auto-regen: id=%s regenerated — re-attempting apply\n' \
                "${PROPOSAL_ID}" >&2
            PATCH_ROWS=()
            while IFS= read -r _row; do
                [[ -n "${_row}" ]] && PATCH_ROWS+=("${_row}")
            done < <(extract_single_proposal)
            PROCESSED=0
            APPLIED=0
            SKIPPED=0
            ERRORS=0
            NEEDS_REGEN=0
            if [[ ${#PATCH_ROWS[@]} -gt 0 ]]; then
                apply_patch_rows
            fi
            if [[ "${APPLIED}" -ge 1 ]]; then
                printf '[daemon-apply] auto-regen: id=%s RE-APPLIED after regen\n' \
                    "${PROPOSAL_ID}" >&2
                exit 10
            fi
            printf '[daemon-apply] auto-regen: id=%s regenerated but re-attempt STILL did not land (needs_regen=%d errors=%d) — left pending\n' \
                "${PROPOSAL_ID}" "${NEEDS_REGEN}" "${ERRORS}" >&2
            exit 11
            ;;
        already_applied)
            # The change is already present in the file (committed earlier) — no
            # diff to land, no new commit. Mark the row applied via the SAME PG
            # status-flip path a normal successful single apply uses (enforce=1
            # loud-fail). PATCH_* are still populated from the first drain's row.
            printf '[daemon-apply] auto-regen: id=%s already_applied — marking row applied (no diff, no commit)\n' \
                "${PROPOSAL_ID}" >&2
            if [[ "${DRY_RUN}" -eq 0 ]]; then
                update_db_status "${PATCH_LABEL}" "${PATCH_TARGET}" "${patch_cycle}" 1 "${patch_id}"
            else
                printf '[daemon-apply] auto-regen: id=%s dry-run — skipping PG status flip\n' \
                    "${PROPOSAL_ID}" >&2
            fi
            exit 12
            ;;
        invalid)
            # Re-derived a diff but the 4-axis pre-verify FAILED. Leave pending,
            # surface the failing axes loudly (self-improve-hygiene loud-fail).
            printf '[daemon-apply] auto-regen: id=%s INVALID — pre-verify failed, row left pending (axes: %s)\n' \
                "${PROPOSAL_ID}" "${regen_axes:-unknown}" >&2
            exit 13
            ;;
        unrecoverable | *)
            # No landable diff after re-derive, OR daemon_cycle errored/unparseable.
            printf '[daemon-apply] auto-regen: id=%s UNRECOVERABLE — no landable diff, row left pending\n' \
                "${PROPOSAL_ID}" >&2
            exit 14
            ;;
    esac
fi

printf '[daemon-apply] processed=%d applied=%d skipped=%d needs_regen=%d errors=%d log=%s\n' \
    "${PROCESSED}" "${APPLIED}" "${SKIPPED}" "${NEEDS_REGEN}" "${ERRORS}" "${APPLIED_LOG}" >&2

# Single-proposal apply-failure exit code. In single mode the one selected
# row either applied (APPLIED=1 → success, fall through to exit 0) or failed to
# land (needs_regen, or an error path) leaving it pending. The API must see
# a NON-zero exit to report "could not apply" to the user → exit 9 (distinct
# from exit 8 "not actionable / no-op"). Batch/report modes are unaffected.
# (--auto-regen replaces this exit-9 stale path above; this block stays the
# default for --auto-regen-off OR a non-stale single failure (hard error).)
if [[ "${PATCH_SOURCE}" == "single" ]] && [[ "${APPLIED}" -eq 0 ]]; then
    printf '[daemon-apply] proposal id=%s could not be applied (needs_regen=%d errors=%d) — left pending\n' \
        "${PROPOSAL_ID}" "${NEEDS_REGEN}" "${ERRORS}" >&2
    # backfill below is skipped (we exit before it); single-mode apply-fail wrote
    # no canonical applied row, so there is no JSONL→DB drift to reconcile.
    exit 9
fi

# -- Post-step: status backfill reconciliation -----------------------------
# Closes the JSONL→DB gap automatically on every apply cycle. Idempotent
# (WHERE status='pending' → no-op when no drift). Non-fatal: backfill failure
# does NOT propagate to daemon-apply exit code, because file commit + DB are
# already updated in-loop via update_db_status — this is reconciliation only.
# Skipped in dry-run (the script itself is read+write to DB).
BACKFILL_SCRIPT="${HOME}/.claude/scripts/autoagent-status-backfill.py"
BACKFILL_LOG="/tmp/autoagent-status-backfill.log"
if [[ "${DRY_RUN}" -eq 0 ]] && [[ -x "${BACKFILL_SCRIPT}" ]]; then
    backfill_ts="$(ts_now)"
    printf '[%s] [autoagent-status-backfill] invoking from daemon-apply (--from-date=%s)\n' \
        "${backfill_ts}" "${CYCLE_DATE}" >>"${BACKFILL_LOG}"
    if python3 "${BACKFILL_SCRIPT}" --from-date "${CYCLE_DATE}" \
        >>"${BACKFILL_LOG}" 2>>"${BACKFILL_LOG}"; then
        printf '[daemon-apply] status backfill completed (log=%s)\n' \
            "${BACKFILL_LOG}" >&2
    else
        printf '[daemon-apply] WARN status backfill failed (non-fatal, log=%s)\n' \
            "${BACKFILL_LOG}" >&2
    fi
fi

exit 0
