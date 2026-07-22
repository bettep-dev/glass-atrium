# shellcheck shell=bash
# shellcheck disable=SC2034  # GA_TIER_A_SUBPATHS is consumed by the sourcing scripts (ga-doctor.sh data_sep_leftover_scan + scripts/migrate-claude-to-ga-data.sh), unused within this producer leaf
# ga-tier-a-subpaths.sh — the Tier-A relocation enumeration (relative subpaths),
# SoT = the plan's Relocation Target Map. Sourced by BOTH lib/ga-doctor.sh
# (data_sep_leftover_scan) and scripts/migrate-claude-to-ga-data.sh so the table
# has ONE definition (was formerly duplicated byte-identically, synced by comment).
# Enumeration-scoped: EXCLUDES the nested Tier-C `data/update` spine baseline and
# the deferred Tier-B `logs/monitor.*`. Idempotent: a re-source is a clean no-op so
# the readonly can never re-fire under set -e.
if [[ -z "${GA_TIER_A_SUBPATHS_INITED:-}" ]]; then
  GA_TIER_A_SUBPATHS=(
    data/agent-circuit-breaker
    data/agent-tool-budget
    data/audit
    data/daemon-config.json
    data/daemon-reports
    data/doc-routing-leak-fired.log
    data/egress-secret-advisory-fired.log
    data/learning
    data/lessons.json
    data/outcome-spool
    data/outcomes
    data/outcomes-audit-queue.txt
    data/outcomes-audit-queue-pg-offset
    data/raw-store-read-advisory-fired.log
    data/safety-overrides
    data/session-spawns
    data/wiki-dedup-verified-hashes.json
    data/workflow-gate-fired.log
    logs/autoagent-haiku-failures
    logs/context-budget-advisory-cache
    logs/cost-subagent-mtime
    logs/inject-scope-rules.diag.log
    logs/scope-drift-plancache
    logs/spawn-cost-advisory-cache
    logs/telemetry-activation.log
    logs/track-outcome.diag.log
    backups/postgres
  )
  readonly -a GA_TIER_A_SUBPATHS
  readonly GA_TIER_A_SUBPATHS_INITED=1
fi
