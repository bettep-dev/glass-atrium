#!/usr/bin/env bash
# render-claude-auth.sh — render a headless CLAUDE_CODE_OAUTH_TOKEN into a 0600
# secrets file the launchd-spawned daemons source before calling `claude`.
# Usage: render-claude-auth.sh [VALUE]
#
# Value source (priority): $1 arg → CLAUDE_CODE_OAUTH_TOKEN env → stdin (read
# one line). The auth-gate captures the value from `claude setup-token` (or a
# user paste) and passes it here; the env/stdin paths keep it off the process
# argv (where `ps` would expose it).
#
# Why a secrets FILE, not the plist: a launchd-spawned `claude -p` (non-GUI
# session) authenticating ONLY via the macOS Keychain OAuth item returns 401,
# while the SAME value works interactively. Injecting the env var into the
# daemons' environment makes the CLI use it and bypass the keychain. The value
# must NEVER enter the plist (world-readable EnvironmentVariables) or git — it
# lives only in this 0600 file. Mirrors render-monitor-env.sh's "render into a
# file, never edit the plist" pattern.
#
# Behavior:
#   1. Resolve the value from arg/env/stdin; validate non-empty + plausible shape.
#   2. Upsert the KEY=value line into the 0600 secrets file (replace in place if
#      present, append otherwise — idempotent re-render).
#   3. The confirmation line reports the KEY name + a redaction only — never the
#      value (the value would leak to the install transcript / launchd log).
#
# Secret hygiene: value in the 0600 file only (and transiently here). Never in
# the plist, never in git (gitignored), never echoed/logged, never hardcoded.
#
# Idempotency: safe to invoke repeatedly — upsert replaces the same key in place;
# the secrets file stays 0600 across re-renders.
set -Eeuo pipefail
IFS=$'\n\t'

readonly GA_ROOT="${GA_ROOT:-${HOME}/.glass-atrium}"
readonly SECRETS_DIR="${GA_ROOT}/secrets"
readonly SECRETS_FILE="${SECRETS_DIR}/claude-auth.env"
readonly AUTH_KEY="CLAUDE_CODE_OAUTH_TOKEN"

trap 'echo "render-claude-auth: ERROR line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

# Exit-code semantics (loud-fail, no silent absorption):
#   5 — secrets dir could not be created
#   6 — value empty / not supplied
#   7 — value failed the plausible-shape guard
#   8 — secrets file write/chmod failed

# --- 1. resolve the value (arg → env → stdin) --------------------------------
# Read stdin only when neither arg nor env supplied a value, so an interactive
# invocation without a piped value still fails loud (exit 6) rather than blocking
# forever on a terminal read.
oauth_value=""
if [[ $# -ge 1 && -n "${1:-}" ]]; then
  oauth_value="$1"
elif [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  oauth_value="${CLAUDE_CODE_OAUTH_TOKEN}"
elif [[ ! -t 0 ]]; then
  # stdin is a pipe/file (not a tty) — read a single line.
  IFS= read -r oauth_value || true
fi

# Trim surrounding whitespace a paste may carry (leading/trailing spaces / CR).
oauth_value="${oauth_value#"${oauth_value%%[![:space:]]*}"}"
oauth_value="${oauth_value%"${oauth_value##*[![:space:]]}"}"

if [[ -z "${oauth_value}" ]]; then
  echo "render-claude-auth: no value supplied (arg / ${AUTH_KEY} env / stdin all empty)" >&2
  exit 6
fi

# --- 2. plausible-shape guard ------------------------------------------------
# Deliberately loose: the OAuth value format is vendor-internal and may change,
# so over-constraining (exact prefix/length) would reject a valid future value.
# Guard only against the obvious garbage classes — whitespace inside the value,
# control chars, or an implausibly short string — to catch a fat-fingered paste
# without coupling to an undocumented format.
if [[ "${oauth_value}" == *[[:space:]]* ]]; then
  echo "render-claude-auth: value contains whitespace — likely a malformed paste" >&2
  exit 7
fi
if (("${#oauth_value}" < 16)); then
  echo "render-claude-auth: value implausibly short (${#oauth_value} chars) — refusing to render" >&2
  exit 7
fi
if [[ "${oauth_value}" =~ [[:cntrl:]] ]]; then
  echo "render-claude-auth: value contains control characters — refusing to render" >&2
  exit 7
fi

# --- 3. ensure the 0600 secrets file -----------------------------------------
# umask 077 around dir+file creation so neither is ever group/other-readable for
# even a moment (a chmod-after-write leaves a brief world-readable window).
umask 077
if ! mkdir -p "${SECRETS_DIR}"; then
  echo "render-claude-auth: failed to create secrets dir ${SECRETS_DIR}" >&2
  exit 5
fi

# touch + chmod BEFORE writing content so the value never lands in a file that
# was world-readable at any instant.
if ! { touch "${SECRETS_FILE}" && chmod 600 "${SECRETS_FILE}"; }; then
  echo "render-claude-auth: failed to create/chmod ${SECRETS_FILE}" >&2
  exit 8
fi

# Upsert KEY=value (replace in place if present, else append). The value is
# passed through the process environment (ENVIRON[]) into awk, read byte-for-byte
# with NO metachar interpretation — sed's replacement would interpret `&`/`\` and
# corrupt a value containing them (mirrors render-monitor-env.sh's upsert).
if grep -qE "^${AUTH_KEY}=" "${SECRETS_FILE}"; then
  tmp="$(mktemp)"
  if ! UPSERT_VAL="${oauth_value}" awk -v key="${AUTH_KEY}" '
      index($0, key "=") == 1 { print key "=" ENVIRON["UPSERT_VAL"]; next }
      { print }
    ' "${SECRETS_FILE}" >"${tmp}"; then
    rm -f "${tmp}"
    echo "render-claude-auth: failed to rewrite ${SECRETS_FILE}" >&2
    exit 8
  fi
  cat "${tmp}" >"${SECRETS_FILE}"
  rm -f "${tmp}"
else
  # Guarantee a line boundary before append: a last line without a trailing
  # newline would else merge the new key onto it (both keys lost on source).
  if [[ -s "${SECRETS_FILE}" ]]; then
    last_byte="$(tail -c 1 "${SECRETS_FILE}")"
    if [[ -n "${last_byte}" ]]; then
      printf '\n' >>"${SECRETS_FILE}"
    fi
  fi
  printf '%s=%s\n' "${AUTH_KEY}" "${oauth_value}" >>"${SECRETS_FILE}"
fi

# Re-assert 0600 (defensive — a pre-existing file may have carried looser perms).
chmod 600 "${SECRETS_FILE}"

# Confirmation reports the KEY + redaction only — NEVER the value.
echo "render-claude-auth: ${AUTH_KEY}=*** → ${SECRETS_FILE} (0600)"
