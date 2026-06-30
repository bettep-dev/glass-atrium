#!/usr/bin/env bash
# prune-security-warnings-state.sh — SessionStart hook
#
# Purpose:
#   The 3rd-party `security-guidance` plugin writes per-session state to
#     ~/.claude/security_warnings_state_<session-uuid>.json
#   and only cleans entries older than 30 days, with a 10% probability per
#   PreToolUse trigger (security_reminder_hook.py:227). Per-session state
#   has no operational value once the session ends, so the lazy cleanup
#   accumulates dozens of stale files between manual sweeps.
#
#   This hook runs at SessionStart, deterministically moves every stale
#   `security_warnings_state_*.json` file to the macOS Trash, and preserves
#   only the file whose UUID matches the currently-starting session.
#
# Trigger:
#   SessionStart (registered in ~/.claude/settings.json).
#
# Active-session detection:
#   Claude Code passes hook input on stdin as JSON (`{"session_id": "<uuid>", ...}`).
#   We extract the UUID with a pure-bash regex match — no jq dependency, sub-50ms.
#   If the session_id field is absent, we fall back to a 5-minute mtime window:
#   any file modified within the last 300 seconds is preserved (defends against
#   the plugin pre-creating the file before SessionStart fires).
#
# File deletion policy:
#   Per Tier-1 rule, JSON state files are config artifacts (not regenerable
#   build outputs) — `mv ~/.Trash/` is mandatory; `rm` is FORBIDDEN.
#   Trash collision is avoided by appending `_<unix-epoch>` before `.json`.
#
# Exit codes:
#   0 — always (advisory hook, must never block session start).
#
# Flags:
#   --dry-run — list would-be-moved files on stdout, exit 0 without moving.
#
# Env overrides (testing):
#   PRUNE_BASE_DIR — directory to scan (default: ~/.claude).
#   PRUNE_TRASH_DIR — destination directory (default: ~/.Trash).
#
# Performance budget:
#   Steady state (zero stale files) <50ms — single glob + early return.
#   With N stale files, ~N * mv-syscall (each <5ms on local APFS).

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

# 3. Read hook input from stdin (non-blocking; some test contexts have empty stdin)
#    Use a 1-second read timeout via tail to avoid stalling if stdin is open
#    but unfed. Claude Code always feeds JSON, but defensive coding wins.
input_json=""
if [[ ! -t 0 ]]; then
  # stdin is piped — drain it (small payload, single read)
  input_json="$(cat || true)"
fi

# 4. Extract session_id with pure-bash regex (no jq).
#    Pattern: matches "session_id": "<uuid>" with optional whitespace.
#    UUID format = 8-4-4-4-12 hex characters separated by hyphens.
active_session_id=""
if [[ -n "${input_json}" ]]; then
  uuid_re='"session_id"[[:space:]]*:[[:space:]]*"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"'
  if [[ "${input_json}" =~ ${uuid_re} ]]; then
    active_session_id="${BASH_REMATCH[1]}"
  fi
fi

# 5. Collect candidate files via glob (nullglob so empty match = empty array)
shopt -s nullglob
candidates=("${base_dir}"/security_warnings_state_*.json)
shopt -u nullglob

# 6. Idempotent fast path — nothing to do
if [[ ${#candidates[@]} -eq 0 ]]; then
  exit 0
fi

# 7. Compute mtime cutoff (POSIX-portable; macOS BSD `date` works the same)
now_epoch="$(date +%s)"
cutoff_epoch=$((now_epoch - MTIME_WINDOW_SECONDS))

# 8. Ensure destination exists (no-op if already present)
if [[ "${dry_run}" == false ]]; then
  mkdir -p "${trash_dir}"
fi

# 9. Iterate, deciding preserve vs. move
moved_count=0
preserved_count=0
for file in "${candidates[@]}"; do
  basename_only="${file##*/}"
  # Strip prefix + suffix to extract UUID portion
  uuid_part="${basename_only#security_warnings_state_}"
  uuid_part="${uuid_part%.json}"

  # Decision: preserve if UUID matches active session
  if [[ -n "${active_session_id}" && "${uuid_part}" == "${active_session_id}" ]]; then
    preserved_count=$((preserved_count + 1))
    continue
  fi

  # Decision: preserve if no session_id known but file is fresh (last 5 min)
  if [[ -z "${active_session_id}" ]]; then
    # macOS BSD `stat -f %m` returns mtime epoch
    file_mtime="$(stat -f %m "${file}" 2>/dev/null || printf '0')"
    if [[ -n "${file_mtime}" && "${file_mtime}" -ge "${cutoff_epoch}" ]]; then
      preserved_count=$((preserved_count + 1))
      continue
    fi
  fi

  # Build trash destination with epoch suffix to dodge collisions
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

# 10. Single advisory line on stdout if anything moved (silent on no-op)
if [[ "${dry_run}" == true ]]; then
  printf '[prune-security-warnings] dry-run: %d candidate(s), preserved=%d, active_session=%s\n' \
    "${#candidates[@]}" "${preserved_count}" "${active_session_id:-none}"
elif [[ "${moved_count}" -gt 0 ]]; then
  printf '[prune-security-warnings] moved %d stale state file(s) to Trash (preserved=%d)\n' \
    "${moved_count}" "${preserved_count}"
fi

exit 0
