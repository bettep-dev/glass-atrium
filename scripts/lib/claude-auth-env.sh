#!/usr/bin/env bash
# claude-auth-env.sh — source the 0600 headless-auth secrets file so a
# launchd-spawned `claude` inherits CLAUDE_CODE_OAUTH_TOKEN and bypasses the
# GUI-session macOS Keychain OAuth item (unusable from a non-GUI launchd session
# → 401). Sourced, not executable; no side effects beyond the export. Rendered by
# render-claude-auth.sh. Call `claude_auth_load_env` BEFORE any `claude` call;
# absent file → loud WARN + return 0 (keychain fallback), never crash.

# Resolve the secrets file the same way render-claude-auth.sh writes it
# (GA_ROOT-anchored), so the read path and the write path agree on ONE location.
claude_auth_secrets_file() {
  printf '%s\n' "${GA_ROOT:-${HOME}/.glass-atrium}/secrets/claude-auth.env"
}

# Source the secrets file (exporting CLAUDE_CODE_OAUTH_TOKEN) when present; loud
# WARN to stderr and return 0 when absent so the caller continues to the
# keychain fallback. Idempotent — re-sourcing simply re-exports the same value.
claude_auth_load_env() {
  local secrets_file
  secrets_file="$(claude_auth_secrets_file)"
  if [[ -f "${secrets_file}" ]]; then
    # set -a exports every assignment the file makes (CLAUDE_CODE_OAUTH_TOKEN)
    # for the duration of the source, then restores the prior allexport state.
    local had_allexport=0
    case "$-" in
      *a*) had_allexport=1 ;;
      *) had_allexport=0 ;;
    esac
    set -a
    # shellcheck source=/dev/null
    . "${secrets_file}"
    if ((had_allexport == 0)); then
      set +a
    fi
    return 0
  fi
  echo "[claude-auth-env] WARN: secrets file absent (${secrets_file}) — falling back to keychain auth; run the install CLI auth step to enable headless token" >&2
  return 0
}
