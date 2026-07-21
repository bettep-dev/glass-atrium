#!/usr/bin/env bash
# shellcheck disable=SC2310,SC2312  # the _do/is_regenerable/resume best-effort helpers are invoked in if/|| conditions BY DESIGN (set -e suppression there is intentional — lifecycle + move ops are guarded, never fatal); the find process-substitution masks a benign non-zero (empty loop handled)
# migrate-claude-to-ga-data.sh — one-time, idempotent Tier-A relocation of Atrium
# runtime state from the legacy ~/.claude tree to the HOME-anchored ~/.glass-atrium
# data root (the GA_DATA_ROOT seam). Enumeration-scoped: moves ONLY the explicitly
# listed Tier-A subpaths — never a blanket `mv ~/.claude/data`, so the nested Tier-C
# `data/update` spine baseline and the deferred Tier-B monitor logs stay in place.
#
# Ordering (PIN-B): quiesce ALL named writers FIRST (launchctl bootout + tmux
# kill-session — the detached daemons survive bootout), THEN migrate, THEN resume.
# Resume is registered on the EXIT trap so a mid-migration abort never leaves the
# system quiesced.
#
# Idempotent + re-runnable: a second run against an already-migrated tree is a clean
# no-op (each enumerated source is already gone). Dir moves are MERGE-per-entry
# (a blind dir-to-dir `mv` NESTS on BSD when the target exists). `.apply-lock` is
# REGENERABLE (Trashed, never moved). Nothing is `rm`'d — removals go to ~/.Trash.
#
# Test seams (fixture-root dry-run mode — bats never touches real dirs or launchd):
#   GA_MIGRATE_SRC_ROOT   legacy root   (default ${HOME}/.claude)
#   GA_MIGRATE_DEST_ROOT  new data root (default ${GA_DATA_ROOT:-${HOME}/.glass-atrium})
#   GA_MIGRATE_TRASH_DIR  trash dir     (default ${HOME}/.Trash)
# Setting GA_MIGRATE_SRC_ROOT marks a SANDBOX run: the host-global launchd/tmux
# quiesce+resume is skipped (gui-domain jobs + the tmux server are per-USER, shared
# with the real user regardless of a fixture HOME — a sandbox must never reap them).
# `--dry-run` previews every action against the real roots without mutating anything.
set -Eeuo pipefail
IFS=$'\n\t'

# Script dir (resolved, symlink-tolerant) — locates the shared ga-tier-a-subpaths.sh
# leaf under ../lib. That leaf is the ONLY lib this standalone op sources (the ga-core
# stack stays un-sourced by design).
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# --- resolved roots (seam-overridable for hermetic tests) ---------------------
readonly SRC_ROOT="${GA_MIGRATE_SRC_ROOT:-${HOME}/.claude}"
readonly DEST_ROOT="${GA_MIGRATE_DEST_ROOT:-${GA_DATA_ROOT:-${HOME}/.glass-atrium}}"
readonly TRASH_DIR="${GA_MIGRATE_TRASH_DIR:-${HOME}/.Trash}"

# SANDBOX — a fixture SRC_ROOT was injected: skip the host-global launchd/tmux lifecycle.
SANDBOX=0
[[ -n "${GA_MIGRATE_SRC_ROOT:-}" ]] && SANDBOX=1
readonly SANDBOX

# DRY_RUN — preview every action, mutate nothing (parsed in main).
DRY_RUN=0

# launchd/tmux lifecycle targets. SoT = lib/ga-env.sh (LAUNCHD_LABEL_PREFIX +
# GA_DAEMON_SESSIONS + the writer subset of LAUNCHD_JOBS); duplicated here because the
# migration op is a standalone one-time script that does not source the ga-core libs.
readonly LAUNCHD_LABEL_PREFIX="com.glass-atrium"
# Named writers to quiesce (plan Rollout Sequence): every job that WRITES a Tier-A store.
QUIESCE_LAUNCHD_JOBS=(
  monitor
  autoagent-daemon
  wiki-daemon
  monitor-log-rotate
  pg-backup
  autoagent-cycle
)
readonly QUIESCE_LAUNCHD_JOBS
# Detached daemon tmux sessions — SURVIVE `launchctl bootout` (reparented to PID 1),
# so they MUST be killed explicitly (mirror lib/ga-env.sh GA_DAEMON_SESSIONS).
GA_DAEMON_SESSIONS=(
  claude-wiki-daemon
  claude-autoagent-daemon
)
readonly GA_DAEMON_SESSIONS

# Tier-A ENUMERATED relocation set (relative subpaths) — the shared leaf (SoT),
# sourced from ../lib so this standalone op + lib/ga-doctor.sh data_sep_leftover_scan
# share ONE definition (was formerly duplicated byte-identically, synced by comment).
# EXCLUDES the nested Tier-C `data/update` + the deferred Tier-B `logs/monitor.*`.
# Provides the readonly GA_TIER_A_SUBPATHS array.
# shellcheck source-path=SCRIPTDIR
# shellcheck source=../lib/ga-tier-a-subpaths.sh
source "${SCRIPT_DIR}/../lib/ga-tier-a-subpaths.sh" || {
  printf '[migrate-ga-data] FATAL: cannot source lib/ga-tier-a-subpaths.sh (Tier-A enumeration SoT)\n' >&2
  exit 1
}

# lifecycle state — resume runs at most once, guaranteed even on a mid-migration abort.
QUIESCED=0
RESUMED=0

log() {
  printf '[migrate-ga-data] %s\n' "$*" >&2
}

usage() {
  cat >&2 <<'EOF'
Usage: migrate-claude-to-ga-data.sh [--dry-run] [--help]

One-time idempotent Tier-A relocation of ~/.claude runtime state to ~/.glass-atrium.
  --dry-run   Preview every planned action without mutating anything or touching launchd.
  --help      Show this help.
EOF
}

# _do — execute a command, or (in --dry-run) log it and skip. The single mutation
# choke point: every mv/mkdir/rmdir/launchctl/tmux call routes through here so
# --dry-run is a total no-op by construction.
_do() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    log "dry-run would: $*"
    return 0
  fi
  "$@"
}

# is_regenerable — the shared mkdir-lock + its reclaim residue. REGENERABLE (the daemon
# recreates it), so it is Trashed, never migrated. Mirrors scripts/lib/apply-lock.sh guards.
is_regenerable() {
  case "$1" in
    .apply-lock | .apply-lock.reclaimed.*) return 0 ;;
    *) return 1 ;;
  esac
}

# trash — move a path to ~/.Trash with a collision-free suffix (NEVER rm — global
# file-deletion policy + feedback_delete_to_trash.md). Best-effort: a failure warns, never aborts.
trash() {
  local path="$1" base target
  base="$(basename -- "${path}")"
  target="${TRASH_DIR}/${base}.$(date +%s)-$$-${RANDOM}"
  _do mkdir -p -- "${TRASH_DIR}"
  if _do mv -- "${path}" "${target}"; then
    log "trashed: ${path} -> ${target}"
  else
    log "WARN: failed to trash ${path} (continuing)"
  fi
}

# merge_move SRC DST — relocate SRC into DST idempotently.
#   dir  → mkdir DST, then move each ENTRY per-item (a blind `mv` NESTS on BSD when
#          DST already exists); regenerable entries are Trashed; the emptied SRC dir
#          is rmdir'd (only when empty — a retained Tier-C nested child keeps it).
#   file → move when DST is absent; a DST that already exists means SRC is a stale
#          duplicate from a prior partial run → Trash it.
#   absent SRC → clean no-op (idempotent re-run).
merge_move() {
  local src="$1" dst="$2"
  # nothing to move (idempotent re-run) — -e misses a dangling symlink, so test -L too.
  [[ -e "${src}" || -L "${src}" ]] || return 0
  # identical path (defensive; real src/dst roots always differ) — never self-move.
  [[ "${src}" -ef "${dst}" ]] && return 0

  if [[ -d "${src}" && ! -L "${src}" ]]; then
    _do mkdir -p -- "${dst}"
    local entry base
    # find -print0 iterates immediate children incl. dotfiles without a shopt-state
    # clobber across the recursion; process substitution keeps the loop in this shell.
    while IFS= read -r -d '' entry; do
      base="$(basename -- "${entry}")"
      if is_regenerable "${base}"; then
        log "regenerable (not migrated): ${entry}"
        trash "${entry}"
        continue
      fi
      merge_move "${entry}" "${dst}/${base}"
    done < <(find "${src}" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
    # remove the now-empty source dir; a retained nested child (Tier-C) keeps it, so
    # rmdir fails harmlessly — masked so the enumeration pin never aborts the run.
    _do rmdir -- "${src}" 2>/dev/null || true
    return 0
  fi

  # file / symlink
  if [[ -e "${dst}" || -L "${dst}" ]]; then
    log "target exists — source is a stale duplicate: ${src}"
    trash "${src}"
  else
    _do mkdir -p -- "$(dirname -- "${dst}")"
    _do mv -- "${src}" "${dst}"
    log "moved: ${src} -> ${dst}"
  fi
}

# quiesce — STOP every named writer before touching a Tier-A path. launchctl bootout
# each writer job, then tmux kill-session each detached daemon (they survive bootout).
# Best-effort: an absent job/session is a no-op. Sets QUIESCED so the EXIT trap resumes.
quiesce() {
  log "quiesce: stopping named writers (launchctl bootout + tmux kill-session)"
  if command -v launchctl >/dev/null 2>&1; then
    local job label
    for job in "${QUIESCE_LAUNCHD_JOBS[@]}"; do
      label="${LAUNCHD_LABEL_PREFIX}.${job}"
      _do launchctl bootout "gui/${UID}/${label}" >/dev/null 2>&1 || true
      log "quiesce: booted out ${label}"
    done
  else
    log "quiesce: launchctl not found — skipping launchd bootout"
  fi
  if command -v tmux >/dev/null 2>&1; then
    local sess
    for sess in "${GA_DAEMON_SESSIONS[@]}"; do
      if tmux has-session -t "${sess}" 2>/dev/null; then
        _do tmux kill-session -t "${sess}" >/dev/null 2>&1 || true
        log "quiesce: killed detached tmux session ${sess}"
      else
        log "quiesce: no detached tmux session ${sess}"
      fi
    done
  else
    log "quiesce: tmux not found — skipping detached daemon teardown"
  fi
  [[ "${DRY_RUN}" -eq 0 ]] && QUIESCED=1
  return 0
}

# resume — restart the quiesced launchd writers (bootstrap the deployed plist, else
# kickstart a still-loaded job). The autoagent-daemon + wiki-daemon launchd jobs
# re-create their detached tmux sessions on bootstrap, so the tmux daemons resume with
# them. Idempotent (runs once) + best-effort — a mid-migration abort still recovers.
resume() {
  [[ "${RESUMED}" -eq 1 ]] && return 0
  RESUMED=1
  log "resume: restarting named writers"
  command -v launchctl >/dev/null 2>&1 || {
    log "resume: launchctl not found — cannot restart writers"
    return 0
  }
  local job label plist
  local launch_agents="${HOME}/Library/LaunchAgents"
  for job in "${QUIESCE_LAUNCHD_JOBS[@]}"; do
    label="${LAUNCHD_LABEL_PREFIX}.${job}"
    plist="${launch_agents}/${label}.plist"
    if [[ -f "${plist}" ]]; then
      if _do launchctl bootstrap "gui/${UID}" "${plist}" >/dev/null 2>&1; then
        log "resume: bootstrapped ${label}"
      elif _do launchctl kickstart "gui/${UID}/${label}" >/dev/null 2>&1; then
        log "resume: kickstarted ${label}"
      else
        log "resume: could not restart ${label} (continuing)"
      fi
    else
      log "resume: no deployed plist for ${label} (skip)"
    fi
  done
  return 0
}

# migrate — the enumerated Tier-A relocation loop.
migrate() {
  log "migrate: ${#GA_TIER_A_SUBPATHS[@]} Tier-A subpath(s) from ${SRC_ROOT} -> ${DEST_ROOT}"
  local rel moved=0
  for rel in "${GA_TIER_A_SUBPATHS[@]}"; do
    local src="${SRC_ROOT}/${rel}" dst="${DEST_ROOT}/${rel}"
    if [[ -e "${src}" || -L "${src}" ]]; then
      merge_move "${src}" "${dst}"
      moved=$((moved + 1))
    fi
  done
  log "migrate: processed ${moved} present Tier-A subpath(s) (idempotent — absent entries skipped)"
}

# cleanup — resume daemons even if migration aborted mid-window (never leave the
# system quiesced). Runs on every exit path.
cleanup() {
  local rc=$?
  if [[ "${QUIESCED}" -eq 1 && "${RESUMED}" -eq 0 ]]; then
    log "cleanup: exited while quiesced — resuming daemons"
    resume || true
  fi
  exit "${rc}"
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      --help | -h)
        usage
        exit 0
        ;;
      *)
        log "unknown argument: $1"
        usage
        exit 2
        ;;
    esac
    shift
  done
  readonly DRY_RUN

  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'log "ERROR: line ${LINENO}: ${BASH_COMMAND}"' ERR

  log "start (src=${SRC_ROOT} dest=${DEST_ROOT} trash=${TRASH_DIR} dry-run=${DRY_RUN} sandbox=${SANDBOX})"

  if [[ "${SANDBOX}" -eq 1 ]]; then
    log "sandbox mode — host launchd/tmux lifecycle skipped (fixture roots)"
  else
    quiesce
  fi

  migrate

  if [[ "${SANDBOX}" -eq 0 ]]; then
    resume
  fi

  log "done"
}

main "$@"
