#!/usr/bin/env bash
# prune-session-spawns.sh — SessionStart hook (advisory, fail-open, always exit 0).
#
# enforce-verification-gate.sh writes a per-session spawn marker to
# ~/.claude/data/session-spawns/<session-key> on every PostToolUse(Agent) spawn-success,
# but nothing reaps them. This SessionStart reaper mtime-TTL-sweeps stale markers.
#
# Design: runs at SessionStart (NOT an in-hook sweep) to keep the spawn hot path
# latency-free; mtime-TTL (not session-id match) — the active session's marker is
# freshly written, so the TTL window preserves it without a session_id lookup.
#
# File deletion policy: per Tier-1 rule markers are session-internal state (not
# regenerable) — `mv ~/.Trash/` mandatory, `rm` FORBIDDEN.
# Env overrides (testing): SESSION_SPAWNS_DIR, PRUNE_TRASH_DIR, SESSION_SPAWNS_TTL
# (seconds, default 86400). --dry-run lists only.

set -Eeuo pipefail
IFS=$'\n\t'

# OS-portable mtime accessor — BSD/macOS `stat -f %m` vs GNU/Linux `stat -c %Y` (both emit the epoch
# seconds). GNU `-f` means --file-system, so a bare BSD `stat -f %m` misparses on Linux and yields no
# epoch — every marker would then read as mtime 0, be treated as stale, and get pruned (silent data
# loss). Detect the flavor ONCE (uname -s) into an args array, mirroring pre-compact.sh's `_GA_STAT_MP`.
_GA_OS="$(uname -s 2>/dev/null || printf 'unknown')"
if [[ "${_GA_OS}" == "Darwin" ]]; then
  _GA_STAT_MTIME=(-f %m)
else
  _GA_STAT_MTIME=(-c %Y)
fi

readonly DEFAULT_SPAWNS_DIR="${HOME}/.claude/data/session-spawns"
readonly DEFAULT_TRASH_DIR="${HOME}/.Trash"
readonly DEFAULT_TTL_SECONDS=86400

# 1. Parse args
dry_run=false
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
fi

# 2. Resolve config (env override > default)
spawns_dir="${SESSION_SPAWNS_DIR:-${DEFAULT_SPAWNS_DIR}}"
trash_dir="${PRUNE_TRASH_DIR:-${DEFAULT_TRASH_DIR}}"
ttl_seconds="${SESSION_SPAWNS_TTL:-${DEFAULT_TTL_SECONDS}}"

# TTL integer guard — non-integer → default (fail-open; must not block session).
if [[ ! "${ttl_seconds}" =~ ^[0-9]+$ ]]; then
  ttl_seconds="${DEFAULT_TTL_SECONDS}"
fi

# 3. Drain stdin (SessionStart feeds JSON; payload unused — TTL-based decision).
if [[ ! -t 0 ]]; then
  cat >/dev/null 2>&1 || true
fi

# DF-28: budget-counter dir. advisory-subagent-budget.sh writes DURABLE per-agent_id TOOL_USE
# counters to ~/.claude/data/agent-tool-budget/<key> (durable so a maxTurns hard-kill's sequence
# survives), and nothing reaps them → they accumulate across sessions. Same mtime-TTL sweep as the
# spawn markers: the active session re-creates its counter on the next tool call, so the TTL window
# preserves live state without a session_id lookup. Env override for the Bats sandbox.
readonly DEFAULT_BUDGET_DIR="${HOME}/.claude/data/agent-tool-budget"
budget_dir="${AGENT_TOOL_BUDGET_DIR:-${DEFAULT_BUDGET_DIR}}"

# 4. Compute mtime cutoff (macOS BSD `date` works the same as GNU for `+%s`).
now_epoch="$(date +%s)"
cutoff_epoch=$((now_epoch - ttl_seconds))

# 5. Ensure Trash dir exists (once, before either sweep).
if [[ "${dry_run}" == false ]]; then
  mkdir -p "${trash_dir}" 2>/dev/null || true
fi

# Aggregate counters across both swept dirs (globals mutated by sweep_dir).
moved_count=0
preserved_count=0
candidate_count=0

# sweep_dir <dir> — mtime-TTL sweep one state dir: preserve fresh files (mtime >= cutoff), move stale
# ones to Trash. Fail-open per file (a stat/mv glitch never aborts). Absent/empty dir = no-op.
# Mutates the module-level moved_count / preserved_count / candidate_count aggregates.
sweep_dir() {
  local dir="${1}" file file_mtime basename_only dest_path
  [[ -d "${dir}" ]] || return 0

  shopt -s nullglob
  local candidates=("${dir}"/*)
  shopt -u nullglob
  candidate_count=$((candidate_count + ${#candidates[@]}))

  for file in "${candidates[@]}"; do
    # Skip directories/special entries — markers/counters are regular files only.
    [[ -f "${file}" ]] || continue

    # Portable mtime epoch via the detected accessor. On failure 0 → treated as stale (pruned).
    file_mtime="$(stat "${_GA_STAT_MTIME[@]}" "${file}" 2>/dev/null || printf '0')"
    if [[ "${file_mtime}" =~ ^[0-9]+$ ]] && [[ "${file_mtime}" -ge "${cutoff_epoch}" ]]; then
      preserved_count=$((preserved_count + 1))
      continue
    fi

    # Epoch suffix dodges Trash name collisions.
    basename_only="${file##*/}"
    dest_path="${trash_dir}/${basename_only}_${now_epoch}"

    if [[ "${dry_run}" == true ]]; then
      printf 'DRY-RUN would move: %s -> %s\n' "${file}" "${dest_path}"
    else
      if mv "${file}" "${dest_path}" 2>/dev/null; then
        moved_count=$((moved_count + 1))
      fi
    fi
  done
}

# 6. Sweep both state dirs (spawn markers + budget counters).
sweep_dir "${spawns_dir}"
sweep_dir "${budget_dir}"

# 7. Single advisory line if anything moved (silent on no-op).
if [[ "${dry_run}" == true ]]; then
  printf '[prune-session-spawns] dry-run: %d candidate(s), preserved=%d\n' \
    "${candidate_count}" "${preserved_count}"
elif [[ "${moved_count}" -gt 0 ]]; then
  printf '[prune-session-spawns] moved %d stale marker(s) to Trash (preserved=%d)\n' \
    "${moved_count}" "${preserved_count}"
fi

exit 0
