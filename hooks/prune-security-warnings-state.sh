#!/usr/bin/env bash
# prune-security-warnings-state.sh — SessionStart hook (advisory, always exit 0).
#
# The `security-guidance` plugin only lazily cleans its per-session state files
# (~/.claude/security_warnings_state_<uuid>.json) — 10% probability per PreToolUse,
# 30-day threshold — so stale files accumulate. This deterministically Trashes
# every stale file at SessionStart, preserving the active session's file (matched
# by session_id from stdin JSON, or — when absent — by a 5-minute mtime window
# that defends against the plugin pre-creating the file before SessionStart fires).
#
# File deletion policy: per Tier-1 rule these JSON state files are config artifacts
# (not regenerable) — `mv ~/.Trash/` mandatory, `rm` FORBIDDEN.
# Env overrides (testing): PRUNE_BASE_DIR, PRUNE_TRASH_DIR. --dry-run lists only.

set -Eeuo pipefail
IFS=$'\n\t'

readonly DEFAULT_BASE_DIR="${HOME}/.claude"
readonly DEFAULT_TRASH_DIR="${HOME}/.Trash"
readonly MTIME_WINDOW_SECONDS=300

# 1. Parse args
dry_run=false
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
fi

# 2. Resolve directories (env override > default)
base_dir="${PRUNE_BASE_DIR:-${DEFAULT_BASE_DIR}}"
trash_dir="${PRUNE_TRASH_DIR:-${DEFAULT_TRASH_DIR}}"

# 3. Drain stdin if piped (Claude Code feeds JSON; empty in some test contexts).
input_json=""
if [[ ! -t 0 ]]; then
  input_json="$(cat || true)"
fi

# 4. Extract session_id with pure-bash regex — no jq (UUID = 8-4-4-4-12 hex).
active_session_id=""
if [[ -n "${input_json}" ]]; then
  uuid_re='"session_id"[[:space:]]*:[[:space:]]*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"'
  if [[ "${input_json}" =~ ${uuid_re} ]]; then
    active_session_id="${BASH_REMATCH[1]}"
  fi
fi

# 5. Collect candidates (nullglob → empty match = empty array).
shopt -s nullglob
candidates=("${base_dir}"/security_warnings_state_*.json)
shopt -u nullglob

# 6. Idempotent fast path — nothing to do.
if [[ ${#candidates[@]} -eq 0 ]]; then
  exit 0
fi

# 7. Compute mtime cutoff (macOS BSD `date` works the same as GNU).
now_epoch="$(date +%s)"
cutoff_epoch=$((now_epoch - MTIME_WINDOW_SECONDS))

if [[ "${dry_run}" == false ]]; then
  mkdir -p "${trash_dir}"
fi

# 8. Iterate — preserve the active-session file, move the rest.
moved_count=0
preserved_count=0
for file in "${candidates[@]}"; do
  basename_only="${file##*/}"
  uuid_part="${basename_only#security_warnings_state_}"
  uuid_part="${uuid_part%.json}"

  if [[ -n "${active_session_id}" && "${uuid_part}" == "${active_session_id}" ]]; then
    preserved_count=$((preserved_count + 1))
    continue
  fi

  # Fallback: no session_id → preserve files fresh within the mtime window.
  if [[ -z "${active_session_id}" ]]; then
    # macOS BSD `stat -f %m` returns mtime epoch.
    file_mtime="$(stat -f %m "${file}" 2>/dev/null || printf '0')"
    if [[ -n "${file_mtime}" && "${file_mtime}" -ge "${cutoff_epoch}" ]]; then
      preserved_count=$((preserved_count + 1))
      continue
    fi
  fi

  # Epoch suffix dodges Trash name collisions.
  dest_name="${basename_only%.json}_${now_epoch}.json"
  dest_path="${trash_dir}/${dest_name}"

  if [[ "${dry_run}" == true ]]; then
    printf 'DRY-RUN would move: %s -> %s\n' "${file}" "${dest_path}"
  else
    if mv "${file}" "${dest_path}" 2>/dev/null; then
      moved_count=$((moved_count + 1))
    fi
  fi
done

# 9. Single advisory line if anything moved (silent on no-op).
if [[ "${dry_run}" == true ]]; then
  printf '[prune-security-warnings] dry-run: %d candidate(s), preserved=%d, active_session=%s\n' \
    "${#candidates[@]}" "${preserved_count}" "${active_session_id:-none}"
elif [[ "${moved_count}" -gt 0 ]]; then
  printf '[prune-security-warnings] moved %d stale state file(s) to Trash (preserved=%d)\n' \
    "${moved_count}" "${preserved_count}"
fi

exit 0
