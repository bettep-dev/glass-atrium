# shellcheck shell=bash
# shellcheck disable=SC2034  # RECOVERY_REPOS is consumed by the sourcing scripts (scripts/snapshot-live-repos.sh + lib/ga-doctor.sh snapshot_staleness_scan), unused within this producer leaf
# recovery-repos.sh — the recovery-snapshot repo whitelist (relative subpaths under
# the GA root), SoT for the seven live per-directory git repositories. Sourced by BOTH
# scripts/snapshot-live-repos.sh (write side) and lib/ga-doctor.sh
# (snapshot_staleness_scan, read side) so the whitelist has ONE definition — a drift
# between the former two literals made one side blind to a repo the other reconciled.
# Idempotent: a re-source is a clean no-op so the readonly can never re-fire under set -e.
if [[ -z "${RECOVERY_REPOS_INITED:-}" ]]; then
  RECOVERY_REPOS=(
    autoagent
    agents
    monitor
    scripts/test
    rules
    test
    hooks/test
  )
  readonly -a RECOVERY_REPOS
  readonly RECOVERY_REPOS_INITED=1
fi
