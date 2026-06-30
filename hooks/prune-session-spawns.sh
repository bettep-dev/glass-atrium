#!/usr/bin/env bash
# prune-session-spawns.sh — SessionStart hook
#
# Purpose:
#   enforce-verification-gate.sh writes per-session spawn markers to
#     ~/.claude/data/session-spawns/<session-key>
#   on every PreToolUse(Agent) spawn, but nothing reaps them — the directory
#   accumulates one file per session unboundedly. Per-session markers have no
#   operational value once the session ends (the gate read is synchronous,
#   in-session). This SessionStart reaper mtime-TTL-sweeps stale markers,
#   matching the codebase reap convention (prune-security-warnings-state.sh
#   SessionStart sweep · post-edit-typecheck.sh Stop-time rm).
#
# Design rationale:
#   - SessionStart, NOT an in-hook sweep — keeps the spawn hot path
#     (enforce-verification-gate.sh PreToolUse) latency-free.
#   - NOT cron — deterministic, runs once per session start, no daemon.
#   - mtime-TTL (not session-id match) — the active session's marker is
#     freshly written (mtime ~now), so the TTL window naturally preserves it;
#     a session_id match is unnecessary and would not improve correctness.
#
# Trigger:
#   SessionStart (registered in ~/.claude/settings.json).
#
# File deletion policy:
#   Per Tier-1 rule, marker files are session-internal state artifacts (not
#   regenerable build outputs) — `mv ~/.Trash/` is mandatory; `rm` FORBIDDEN.
#   Trash collision avoided by appending `_<unix-epoch>` to the basename.
#
# Exit codes:
#   0 — always (advisory hook, must never block session start · fail-open).
#
# Flags:
#   --dry-run — list would-be-moved markers on stdout, exit 0 without moving.
#
# Env overrides (testing):
#   SESSION_SPAWNS_DIR — directory to sweep (default: ~/.claude/data/session-spawns).
#   PRUNE_TRASH_DIR    — destination directory (default: ~/.Trash).
#   SESSION_SPAWNS_TTL — stale threshold in seconds (default: 86400 = 24h).
#
# Performance budget:
#   Steady state (zero markers / missing dir) <50ms — single glob + early return.
#   With N stale markers, ~N * mv-syscall (each <5ms on local APFS).

set -Eeuo pipefail
IFS=$'\n\t'

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

# TTL integer guard — non-integer input → default (silent). The hook is fail-open;
# input validation failure must not block the session.
if [[ ! "${ttl_seconds}" =~ ^[0-9]+$ ]]; then
  ttl_seconds="${DEFAULT_TTL_SECONDS}"
fi

# 3. Drain stdin (SessionStart feeds JSON; payload unused — TTL-based decision).
if [[ ! -t 0 ]]; then
  cat >/dev/null 2>&1 || true
fi

# 4. Missing dir → nothing to sweep (fail-open fast path).
if [[ ! -d "${spawns_dir}" ]]; then
  exit 0
fi

# 5. Collect candidate marker files (nullglob → empty match = empty array).
shopt -s nullglob
candidates=("${spawns_dir}"/*)
shopt -u nullglob

# 6. Idempotent fast path — nothing to do.
if [[ ${#candidates[@]} -eq 0 ]]; then
  exit 0
fi

# 7. Compute mtime cutoff (macOS BSD `date` works the same as GNU for `+%s`).
now_epoch="$(date +%s)"
cutoff_epoch=$((now_epoch - ttl_seconds))

# 8. Ensure destination exists (no-op if already present).
if [[ "${dry_run}" == false ]]; then
  mkdir -p "${trash_dir}" 2>/dev/null || true
fi

# 9. Iterate — preserve fresh markers (mtime >= cutoff), move stale ones.
moved_count=0
preserved_count=0
for file in "${candidates[@]}"; do
  # Skip directories/special entries — markers are regular files only.
  [[ -f "${file}" ]] || continue

  # macOS BSD `stat -f %m` returns mtime epoch. On failure 0 → treated as stale (pruned).
  file_mtime="$(stat -f %m "${file}" 2>/dev/null || printf '0')"
  if [[ "${file_mtime}" =~ ^[0-9]+$ ]] && [[ "${file_mtime}" -ge "${cutoff_epoch}" ]]; then
    preserved_count=$((preserved_count + 1))
    continue
  fi

  # Build trash destination with epoch suffix to dodge collisions.
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

# 10. Single advisory line if anything moved (silent on no-op).
if [[ "${dry_run}" == true ]]; then
  printf '[prune-session-spawns] dry-run: %d candidate(s), preserved=%d\n' \
    "${#candidates[@]}" "${preserved_count}"
elif [[ "${moved_count}" -gt 0 ]]; then
  printf '[prune-session-spawns] moved %d stale marker(s) to Trash (preserved=%d)\n' \
    "${moved_count}" "${preserved_count}"
fi

exit 0
