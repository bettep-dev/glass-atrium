#!/usr/bin/env bash
# prune-session-spawns.sh — SessionStart hook (advisory, fail-open, always exit 0).
#
# enforce-verification-gate.sh writes a per-session spawn marker to
# ~/.claude/data/session-spawns/<session-key> on every PreToolUse(Agent) spawn,
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

# 8. Ensure Trash dir exists.
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

# 10. Single advisory line if anything moved (silent on no-op).
if [[ "${dry_run}" == true ]]; then
  printf '[prune-session-spawns] dry-run: %d candidate(s), preserved=%d\n' \
    "${#candidates[@]}" "${preserved_count}"
elif [[ "${moved_count}" -gt 0 ]]; then
  printf '[prune-session-spawns] moved %d stale marker(s) to Trash (preserved=%d)\n' \
    "${moved_count}" "${preserved_count}"
fi

exit 0
