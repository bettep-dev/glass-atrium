#!/usr/bin/env bash
# prune-job-scratch.sh — age-based prune of abandoned background-job scratch directories
# Usage: prune-job-scratch.sh [--dry-run]
#
# Behavior:
#   1. Validate the scratch root by construction (see Scope below) — refuse anything else
#   2. Remove each top-level job entry DIRECTORY whose mtime is older than the retention window
#   3. Report each removal on stdout; a run with nothing to prune is silent apart from the summary
#
# Scope (by construction, not by convention): the root is validated before any removal — it must be
# an absolute path, an existing real directory (a symlinked root is refused, never followed), and
# its basename must be `jobs`. The walk is `-mindepth 1 -maxdepth 1 -type d`, so nothing above the
# root and nothing below a job entry is ever enumerated, and top-level FILES (pins.json, the job
# index) are left alone. `rm -rf` on a matched entry removes symlinks as links: a link inside job
# scratch that resolves to a real file elsewhere loses the link, never the target.
#
# Rationale: the harness creates a scratch directory per background job and never reaps one whose
# job died past its cleanup, so the tree accumulates state and stray links indefinitely. Shape is
# modelled on the two prunes this repository already owns — the archive prune in
# scripts/monitor-log-rotate.sh (glob-bounded `find -delete` in a known dir) and the orphan run-dir
# sweep in scripts/wiki-daily-compile.sh (`-maxdepth 1 -type d -mtime` plus a non-fatal warning).
#
# Idempotency: safe to re-invoke. Nothing older than the window = no-op.
#
# Invoked by: manual invocation today. Wiring it to the daily launchd cycle is a separate decision.
#
# Exit codes:
#   0 = prune completed (zero or more entries removed)
#   2 = usage error
#   3 = the scratch root failed validation (nothing was removed)
set -Eeuo pipefail
IFS=$'\n\t'

# Override exists for sandbox testing only; it passes the SAME validation as the default, so an
# override cannot widen the scope — it can only point the prune at another directory named `jobs`.
readonly SCRATCH_ROOT="${GA_JOB_SCRATCH_ROOT:-${HOME}/.claude/jobs}"
# 14 days — longer than any background job survives, so an entry this old belongs to no live job.
readonly RETENTION_DAYS=14

trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

usage() {
  printf 'usage: prune-job-scratch.sh [--dry-run]\n' >&2
}

# Refuses rather than normalizes: a root that is not the job-scratch shape is a caller error, and
# guessing at the intended directory is how a prune reaches a tree it was never meant to touch.
validate_root() {
  local root="${1}"
  if [[ "${root}" != /* ]]; then
    printf 'ERROR: scratch root is not absolute: %s\n' "${root}" >&2
    return 1
  fi
  if [[ "${root##*/}" != 'jobs' ]]; then
    printf 'ERROR: scratch root basename is not "jobs": %s\n' "${root}" >&2
    return 1
  fi
  if [[ -L "${root}" ]]; then
    printf 'ERROR: scratch root is a symlink; refusing to follow it: %s\n' "${root}" >&2
    return 1
  fi
  if [[ ! -d "${root}" || ! -w "${root}" ]]; then
    printf 'ERROR: scratch root missing or not writable: %s\n' "${root}" >&2
    return 1
  fi
}

main() {
  local dry_run=0 entry="" removed=0
  local -a stale=()

  case "${1:-}" in
    --dry-run)
      dry_run=1
      ;;
    '') ;;
    *)
      usage
      exit 2
      ;;
  esac

  # shellcheck disable=SC2310  # a failed validation is the reportable outcome, not an error trap
  if ! validate_root "${SCRATCH_ROOT}"; then
    exit 3
  fi

  # shellcheck disable=SC2312  # the root proved a writable dir above; find over one level cannot fail
  while IFS= read -r entry; do
    stale+=("${entry}")
  done < <(find "${SCRATCH_ROOT}" -mindepth 1 -maxdepth 1 -type d -mtime +"${RETENTION_DAYS}" | LC_ALL=C sort)

  for entry in "${stale[@]:-}"; do
    [[ -n "${entry}" ]] || continue
    if ((dry_run == 1)); then
      printf 'would prune: %s\n' "${entry}"
    else
      rm -rf -- "${entry}"
      printf 'pruned: %s\n' "${entry}"
    fi
    removed=$((removed + 1))
  done

  printf 'root=%s retention_days=%d pruned=%d dry_run=%d\n' \
    "${SCRATCH_ROOT}" "${RETENTION_DAYS}" "${removed}" "${dry_run}"
}

main "$@"
