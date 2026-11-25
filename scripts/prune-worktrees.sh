#!/usr/bin/env bash
# prune-worktrees.sh — worktree close-out: removes a finished delegation's linked worktree once the
# four-part safe test and this script's own live-agent guard pass, and stops the orphaned processes
# still running inside it.
# Usage: prune-worktrees.sh [--apply] [--deployed <sha>] <worktree>...
#        prune-worktrees.sh --list-all     (every linked worktree of the cwd's repository; listing only)
#
# Authority — rules/glass-atrium/core-security.md, owner-approved standing (queue item 460), verbatim:
#   "Worktree close-out exception (owner-approved standing, queue item 460): at the close-out of this
#   session's own finished delegation, `git worktree remove` without `--force` of its worktree needs no
#   further approval when all four hold: its branch is contained in main or in the deployed commit ·
#   no uncommitted or untracked change apart from ignored build output · no live writer lock
#   (hooks/lib/worktree-lock.sh) · no process runs with its cwd inside. It licenses nothing else: no
#   `rm` of a worktree path, no `--force`, no worktree with unmerged or uncommitted work, no other
#   session's worktree, not the main checkout, no other deletion; git's refusal is final for that
#   close-out."
#
# Per worktree, each safe-test part reported pass / fail with its fact:
#   contained — HEAD is an ancestor of main or of --deployed <sha>; either is enough
#   clean      — git status lists no change and no untracked path; ignored files do not count
#   lock       — no live writer lock (hooks/lib/worktree-lock.sh → worktree_lock_is_live)
#   processes  — no process has its cwd inside
# and a fifth fact, this script's own guard on the process-stop step — stricter than the exception
# above, never looser:
#   agents     — no process inside may have a live owner. Owner = the nearest claude process in its
#                ancestry (itself included): an agent's Bash call runs as a child of its session's
#                claude process. Another session's process fails the fact whatever the marker count;
#                one under the caller's own session fails it while any live-agent marker is live
#                (hooks/hook-utils.sh → hook_get_live_child_count) — markers say which agents
#                are live, never where. A process with no claude ancestor is an orphan.
# Processes --apply can ever signal, TERM only: an orphan, or a process under the caller's own session
# while no marker is live. Never this run's own chain, never another session's process.
# Dry run by default. A live lock or a failed agents fact skips the worktree whole: nothing stopped,
# nothing removed. Otherwise, under --apply, each process inside gets TERM and a bounded wait, a
# survivor is reported and never KILLed; then, all five passing, `git worktree remove` without --force —
# ignored build output does not make git refuse, it goes with the directory. A git refusal is
# reported and final. No branch is deleted.
#
# Scope boundary: --list-all refuses --apply, since the exception covers only this session's own
# worktrees and only the caller can name those. Orphans are found by cwd (hooks/lib/worktree-lock.sh →
# worktree_get_processes, the same listing agent-tracker.sh's SubagentStop advisory reads), not by
# lib/ga-daemons.sh → clear_unmanaged_pg_orphan's socket / :5432 lookup, which finds the install's
# server: a scratch cluster's postmaster runs with its cwd in its data dir, so the cwd test finds one
# inside the worktree, and it gets TERM (postgres smart shutdown) like any other process here.
#
# Exit codes:
#   0 = run complete (a kept worktree is a reported outcome, not an error)
#   2 = usage error
#   3 = an argument was refused (path guard, not a linked worktree root, the main checkout)
#   4 = a shared library (scripts/lib/path-guard.sh, hooks/lib/worktree-lock.sh, hooks/hook-utils.sh) missing
set -Eeuo pipefail
IFS=$'\n\t'

# Absolute: the run moves to / before any check, and the lock lib loads apply-lock.sh relative to itself.
SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SELF_DIR
readonly PATH_GUARD="${SELF_DIR}/lib/path-guard.sh"
readonly LOCK_LIB="${SELF_DIR}/../hooks/lib/worktree-lock.sh"
readonly HOOK_UTILS="${SELF_DIR}/../hooks/hook-utils.sh"
for lib in "${PATH_GUARD}" "${LOCK_LIB}" "${HOOK_UTILS}"; do
  if [[ ! -r "${lib}" ]]; then
    printf 'prune-worktrees: FATAL: cannot source the shared library %s\n' "${lib}" >&2
    exit 4
  fi
done
# shellcheck source-path=SCRIPTDIR source=lib/path-guard.sh
source "${PATH_GUARD}" || exit 4
# shellcheck source-path=SCRIPTDIR source=../hooks/lib/worktree-lock.sh
source "${LOCK_LIB}" || exit 4
# shellcheck source-path=SCRIPTDIR source=../hooks/hook-utils.sh
source "${HOOK_UTILS}" || exit 4

TERM_WAIT_SECS="${GA_PRUNE_WORKTREES_TERM_WAIT_SECS:-10}"
[[ "${TERM_WAIT_SECS}" =~ ^[0-9]+$ ]] || TERM_WAIT_SECS=10
readonly TERM_WAIT_SECS
readonly SEP=$'\x1f'

trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

APPLY=0
IS_LIST_ALL=0
DEPLOYED=""
IS_REFUSED=0
ANCESTOR_PIDS=" "
OWN_SESSION_PID=""
TARGETS=()
REPORT_STOPPED=()
REPORT_SURVIVORS=()
REPORT_REMOVED=()
REPORT_WOULD=()
REPORT_KEPT=()

usage() {
  printf 'usage: prune-worktrees.sh [--apply] [--deployed <sha>] <worktree>...\n' >&2
  printf '       prune-worktrees.sh --list-all\n' >&2
}

usage_exit() {
  [[ -z "${1:-}" ]] || printf 'prune-worktrees: %s\n' "${1}" >&2
  usage
  exit 2
}

main() {
  parse_args "$@"
  ((IS_LIST_ALL == 0)) || get_linked_worktrees
  get_ancestor_pids
  # shellcheck disable=SC2310  # no claude ancestor → empty: every session process inside is another's
  OWN_SESSION_PID="$(get_session_ancestor "$$")" || OWN_SESSION_PID=""
  # From / on: no child of this run (lsof, git, ps) holds a cwd inside a worktree it inspects.
  cd /
  local target
  for target in "${TARGETS[@]+"${TARGETS[@]}"}"; do
    close_out_worktree "${target}"
  done
  print_report
  ((IS_REFUSED == 0)) || exit 3
}

parse_args() {
  while (($# > 0)); do
    case "${1}" in
      --apply) APPLY=1 ;;
      --list-all) IS_LIST_ALL=1 ;;
      --deployed)
        (($# >= 2)) || usage_exit '--deployed needs a commit sha'
        [[ "${2}" =~ ^[0-9a-f]{7,40}$ ]] || usage_exit "--deployed is not a commit sha: ${2}"
        DEPLOYED="${2}"
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      -*) usage_exit "unknown option: ${1}" ;;
      *) TARGETS+=("${1}") ;;
    esac
    shift
  done
  ((IS_LIST_ALL == 0 || APPLY == 0)) || usage_exit '--list-all only lists; name your own worktrees to --apply'
  ((IS_LIST_ALL == 0 || ${#TARGETS[@]} == 0)) || usage_exit '--list-all takes no worktree argument'
  ((IS_LIST_ALL == 1 || ${#TARGETS[@]} > 0)) || usage_exit 'no worktree given'
}

# Every linked worktree of the cwd's repository; git lists the main checkout first, so it is skipped.
get_linked_worktrees() {
  local listing line is_first=1
  listing="$(git worktree list --porcelain)" || usage_exit 'the current directory is not in a git repository'
  while IFS= read -r line; do
    [[ "${line}" == 'worktree '* ]] || continue
    if ((is_first == 1)); then
      is_first=0
      continue
    fi
    TARGETS+=("${line#worktree }")
  done <<<"${listing}"
}

# The run's own process chain: a process here is listed but never signalled.
get_ancestor_pids() {
  local pid="$$" ppid
  while [[ "${pid}" =~ ^[0-9]+$ ]] && ((pid > 1)); do
    ANCESTOR_PIDS+="${pid} "
    ppid="$(ps -o ppid= -p "${pid}" 2>/dev/null)" || break
    pid="${ppid//[[:space:]]/}"
  done
}

close_out_worktree() {
  # shellcheck disable=SC2310  # a refusal is the reported outcome, not an error trap
  if ! resolve_worktree "${1}"; then
    printf 'refused: %s\n' "${REFUSAL}"
    IS_REFUSED=1
    return 0
  fi
  local wt="${RESOLVED_WT}" holder
  printf 'worktree: %s\n' "${wt}"
  # shellcheck disable=SC2310  # the lock verdict is branched on
  if holder="$(get_live_lock_holder)"; then
    printf '  skipped: live writer lock held by %s\n' "${holder}"
    REPORT_KEPT+=("${wt} — lock: fail (live writer lock held by ${holder})")
    return 0
  fi
  # shellcheck disable=SC2310  # the live-agent verdict is branched on
  if ! check_live_agents "${wt}"; then
    printf '  skipped: %s\n' "${PART_FACT}"
    REPORT_KEPT+=("${wt} — agents: fail (${PART_FACT})")
    return 0
  fi
  ((APPLY == 0)) || stop_processes_inside "${wt}"
  judge_worktree "${wt}"
}

# Sets RESOLVED_GIVEN (the argument's own spelling), RESOLVED_WT (canonical) and MAIN_CHECKOUT;
# on rc 1, REFUSAL names why the argument is no candidate.
resolve_worktree() {
  local arg="${1}" toplevel
  # shellcheck disable=SC2310  # the argument verdict is branched on
  check_argument "${arg}" || return 1
  RESOLVED_GIVEN="${arg%/}"
  RESOLVED_WT="$(cd -P -- "${arg}" && pwd -P)" || {
    REFUSAL="${arg}: cannot resolve the directory"
    return 1
  }
  toplevel="$(git -C "${RESOLVED_WT}" rev-parse --show-toplevel 2>/dev/null)" || toplevel=""
  if [[ "${toplevel}" != "${RESOLVED_WT}" ]]; then
    REFUSAL="${arg}: not the root of a git worktree"
    return 1
  fi
  # shellcheck disable=SC2310  # a listing failure is the refusal reason
  get_main_checkout "${RESOLVED_WT}" || {
    REFUSAL="${arg}: git cannot list this repository's worktrees"
    return 1
  }
  if [[ "${MAIN_CHECKOUT}" == "${RESOLVED_WT}" ]]; then
    REFUSAL="${RESOLVED_WT}: the main checkout is never a candidate"
    return 1
  fi
}

check_argument() {
  if [[ -z "${1}" ]]; then
    REFUSAL='(empty path): refused by the path guard'
    return 1
  fi
  # shellcheck disable=SC2310  # the guard verdict is branched on
  if ! ga_guard_path "${1}"; then
    REFUSAL="${1}: refused by the path guard"
    return 1
  fi
  if [[ ! -d "${1}" ]]; then
    REFUSAL="${1}: not a directory"
    return 1
  fi
}

get_main_checkout() {
  local listing first
  listing="$(git -C "${1}" worktree list --porcelain)" || return 1
  first="${listing%%$'\n'*}"
  MAIN_CHECKOUT="${first#worktree }"
  if [[ -d "${MAIN_CHECKOUT}" ]]; then
    MAIN_CHECKOUT="$(cd -P -- "${MAIN_CHECKOUT}" && pwd -P)" || return 1
  fi
}

# The lock key derives from the path a writer's tool call named, so both spellings are looked up.
get_live_lock_holder() {
  local root
  for root in "${RESOLVED_GIVEN}" "${RESOLVED_WT}"; do
    # shellcheck disable=SC2310  # an unusable key is skipped, the other spelling still checked
    worktree_lock_dir_for "${root}" || continue
    # shellcheck disable=SC2310  # the liveness verdict is branched on
    worktree_lock_is_live "${worktree_lock_dir_out}" || continue
    # shellcheck disable=SC2310  # an unreadable holder is still a live lock
    worktree_lock_read_holder "${worktree_lock_dir_out}" || worktree_lock_holder_out='(unreadable holder)'
    printf '%s\n' "${worktree_lock_holder_out}"
    return 0
  done
  return 1
}

# A zombie still answers kill -0 until its parent reaps it, yet it runs nothing.
is_running() {
  local stat
  kill -0 "${1}" 2>/dev/null || return 1
  stat="$(ps -o stat= -p "${1}" 2>/dev/null)" || return 1
  stat="${stat//[[:space:]]/}"
  [[ -n "${stat}" && "${stat}" != Z* ]]
}

stop_processes_inside() {
  local wt="${1}" entry pid
  SIGNALLED=()
  # shellcheck disable=SC2310  # no listing → nothing to stop; the processes part then fails
  worktree_get_processes "${wt}" || return 0
  for entry in "${worktree_processes_out[@]+"${worktree_processes_out[@]}"}"; do
    pid="${entry%%"${SEP}"*}"
    if [[ "${ANCESTOR_PIDS}" == *" ${pid} "* ]]; then
      printf '  not stopped: pid=%s (this run is its descendant)\n' "${pid}"
      continue
    fi
    if kill -TERM "${pid}" 2>/dev/null; then
      SIGNALLED+=("${entry}")
    fi
  done
  ((${#SIGNALLED[@]} > 0)) || return 0
  wait_for_exit
  record_stop_outcomes
}

wait_for_exit() {
  local deadline=$((SECONDS + TERM_WAIT_SECS)) entry is_alive
  while ((SECONDS <= deadline)); do
    is_alive=0
    for entry in "${SIGNALLED[@]}"; do
      # shellcheck disable=SC2310  # the liveness verdict is branched on
      if is_running "${entry%%"${SEP}"*}"; then
        is_alive=1
      fi
    done
    ((is_alive == 1)) || return 0
    sleep 0.2
  done
}

record_stop_outcomes() {
  local entry pid cwd cmd
  for entry in "${SIGNALLED[@]}"; do
    IFS="${SEP}" read -r pid cwd cmd <<<"${entry}"
    # shellcheck disable=SC2310  # the liveness verdict is branched on
    if is_running "${pid}"; then
      REPORT_SURVIVORS+=("pid=${pid} cmd=${cmd} cwd=${cwd} (still running after TERM; no KILL sent)")
    else
      REPORT_STOPPED+=("pid=${pid} cmd=${cmd} cwd=${cwd}")
    fi
  done
}

judge_worktree() {
  local wt="${1}"
  FAILED_PARTS=""
  run_part contained check_contained "${wt}"
  run_part clean check_clean "${wt}"
  run_part lock check_lock
  run_part agents check_live_agents "${wt}"
  run_part processes check_processes "${wt}"
  if [[ -n "${FAILED_PARTS}" ]]; then
    REPORT_KEPT+=("${wt} — ${FAILED_PARTS}")
  elif ((APPLY == 0)); then
    REPORT_WOULD+=("${wt}")
  else
    remove_worktree "${wt}"
  fi
}

# $1 = part name, then the check command; the check sets PART_FACT and returns its verdict.
run_part() {
  local name="${1}"
  shift
  PART_FACT=""
  # shellcheck disable=SC2310  # the check verdict is branched on
  if "$@"; then
    printf '  %s: pass (%s)\n' "${name}" "${PART_FACT}"
    return 0
  fi
  printf '  %s: fail (%s)\n' "${name}" "${PART_FACT}"
  FAILED_PARTS+="${FAILED_PARTS:+; }${name}: fail (${PART_FACT})"
}

check_contained() {
  local wt="${1}" head
  head="$(git -C "${wt}" rev-parse --verify -q HEAD)" || {
    PART_FACT='no HEAD commit'
    return 1
  }
  if git -C "${wt}" rev-parse --verify -q refs/heads/main >/dev/null \
    && git -C "${wt}" merge-base --is-ancestor "${head}" refs/heads/main; then
    PART_FACT="${head:0:12} is in main"
    return 0
  fi
  if [[ -n "${DEPLOYED}" ]] && git -C "${wt}" merge-base --is-ancestor "${head}" "${DEPLOYED}" 2>/dev/null; then
    PART_FACT="${head:0:12} is in the deployed commit ${DEPLOYED}"
    return 0
  fi
  PART_FACT="${head:0:12} is in neither main nor ${DEPLOYED:-a deployed commit (none given)}"
  return 1
}

check_clean() {
  local status count=0 line
  status="$(git -C "${1}" status --porcelain --untracked-files=all)" || {
    PART_FACT='git status failed'
    return 1
  }
  while IFS= read -r line; do
    [[ -z "${line}" ]] || count=$((count + 1))
  done <<<"${status}"
  if ((count > 0)); then
    PART_FACT="${count} uncommitted or untracked path(s)"
    return 1
  fi
  PART_FACT='no uncommitted or untracked change'
}

check_lock() {
  local holder
  # shellcheck disable=SC2310  # the lock verdict is branched on
  if holder="$(get_live_lock_holder)"; then
    PART_FACT="live writer lock held by ${holder}"
    return 1
  fi
  PART_FACT='no live writer lock'
}

check_live_agents() {
  local live owner
  # shellcheck disable=SC2310  # an unreadable record store is the failing fact
  if ! live="$(hook_get_live_child_count)"; then
    PART_FACT="cannot read the live-agent records in ${LIVE_CHILD_DIR}"
    return 1
  fi
  # shellcheck disable=SC2310  # the listing verdict is branched on
  if ! worktree_get_processes "${1}"; then
    PART_FACT='process cwds cannot be listed, so none inside is cleared of another Claude session'
    return 1
  fi
  # shellcheck disable=SC2310  # the ownership verdict is branched on
  if owner="$(get_owned_process_inside "${live}")"; then
    PART_FACT="${owner}"
    return 1
  fi
  if ((live == 0)); then
    PART_FACT='no live agent recorded; no process inside runs under another Claude session'
  else
    PART_FACT="${live} live agent(s) recorded; no process inside runs under a Claude session"
  fi
}

# Prints why the first process inside (worktree_processes_out) may have a live owner; rc 1 = none.
# Owner = nearest claude ancestor: another session's always counts, the caller's own only while $1 > 0
# agents are live (markers record no main session). No claude ancestor = orphan. This run's chain is skipped.
get_owned_process_inside() {
  local live="${1}" entry pid session
  for entry in "${worktree_processes_out[@]+"${worktree_processes_out[@]}"}"; do
    pid="${entry%%"${SEP}"*}"
    [[ "${ANCESTOR_PIDS}" != *" ${pid} "* ]] || continue
    # shellcheck disable=SC2310  # the ancestry verdict is branched on
    session="$(get_session_ancestor "${pid}")" || continue
    if [[ "${session}" != "${OWN_SESSION_PID}" ]]; then
      printf 'pid=%s runs under another Claude session pid=%s\n' "${pid}" "${session}"
      return 0
    fi
    if ((live > 0)); then
      printf 'pid=%s runs under this Claude session pid=%s while %s agent(s) are live, and no record says whose it is\n' \
        "${pid}" "${session}" "${live}"
      return 0
    fi
  done
  return 1
}

# The nearest claude process from $1 up its parent chain, $1 itself included; rc 1 = none.
get_session_ancestor() {
  local pid="${1}" line ppid args
  while [[ "${pid}" =~ ^[0-9]+$ ]] && ((pid > 1)); do
    line="$(ps -o ppid=,args= -p "${pid}" 2>/dev/null)" || return 1
    line="${line#"${line%%[![:space:]]*}"}"
    ppid="${line%%[[:space:]]*}"
    args="${line#"${ppid}"}"
    args="${args#"${args%%[![:space:]]*}"}"
    # shellcheck disable=SC2310  # the name verdict is branched on
    if is_session_command "${args}"; then
      printf '%s\n' "${pid}"
      return 0
    fi
    pid="${ppid}"
  done
  return 1
}

# A Claude Code session: the native binary (argv0 `claude`) or the npm package run by node.
is_session_command() {
  local argv0="${1%%[[:space:]]*}"
  [[ "${argv0##*/}" == claude || "${1}" == *'@anthropic-ai/claude-code/'* ]]
}

check_processes() {
  local entry pid cwd cmd
  # shellcheck disable=SC2310  # the listing verdict is branched on
  if ! worktree_get_processes "${1}"; then
    PART_FACT='cannot list process cwds (lsof missing or failed)'
    return 1
  fi
  if ((${#worktree_processes_out[@]} == 0)); then
    PART_FACT='none inside'
    return 0
  fi
  PART_FACT="${#worktree_processes_out[@]} inside:"
  for entry in "${worktree_processes_out[@]}"; do
    IFS="${SEP}" read -r pid cwd cmd <<<"${entry}"
    PART_FACT+=" pid=${pid} cmd=${cmd} cwd=${cwd}"
  done
  return 1
}

remove_worktree() {
  local wt="${1}" out
  # shellcheck disable=SC2310  # the guard verdict is branched on
  if ! ga_guard_path "${wt}"; then
    REPORT_KEPT+=("${wt} — refused by the path guard")
    return 0
  fi
  if out="$(git -C "${MAIN_CHECKOUT}" worktree remove -- "${wt}" 2>&1)"; then
    REPORT_REMOVED+=("${wt}")
  else
    REPORT_KEPT+=("${wt} — refused by git: ${out//$'\n'/ }")
  fi
}

print_report() {
  local line
  for line in "${REPORT_STOPPED[@]+"${REPORT_STOPPED[@]}"}"; do printf 'stopped: %s\n' "${line}"; done
  for line in "${REPORT_SURVIVORS[@]+"${REPORT_SURVIVORS[@]}"}"; do printf 'survivor: %s\n' "${line}"; done
  for line in "${REPORT_REMOVED[@]+"${REPORT_REMOVED[@]}"}"; do printf 'removed: %s\n' "${line}"; done
  for line in "${REPORT_WOULD[@]+"${REPORT_WOULD[@]}"}"; do printf 'would remove: %s\n' "${line}"; done
  for line in "${REPORT_KEPT[@]+"${REPORT_KEPT[@]}"}"; do printf 'kept: %s\n' "${line}"; done
  printf 'removed=%d kept=%d stopped=%d survivors=%d apply=%d\n' "${#REPORT_REMOVED[@]}" \
    "${#REPORT_KEPT[@]}" "${#REPORT_STOPPED[@]}" "${#REPORT_SURVIVORS[@]}" "${APPLY}"
}

main "$@"
