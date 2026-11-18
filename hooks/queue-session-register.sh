#!/usr/bin/env bash
# queue-session-register.sh — SessionStart hook (startup · resume · fork · clear): registers this session
# with the Atrium owner queue, writes back the awaiting marks the reply lists (queue_register_session) and, when owner
# answers or messages or peer relays wait for it, prints one context line naming each count and the CLI pending
# command — never their text; a project or local MCP server shadowing the queue server's name adds one line.
# Disposition noop: fail-open, always exit 0 with nothing printed on any failure (monitor down, slow or
# refusing). No block channel (SessionStart cannot block).

set -Eeuo pipefail
IFS=$'\n\t'
# inside a $( ) the trap fails the substitution, so its caller still sees the failure
trap 'if ((BASH_SUBSHELL > 0)); then exit 1; fi; exit 0' ERR

self="${BASH_SOURCE[0]}"
if [[ -L "${self}" ]]; then
  self="$(readlink -f -- "${self}")" || exit 0
fi
lib="${self%/*}/../scripts/lib/queue-session.sh"
[[ -f "${lib}" ]] || exit 0
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/queue-session.sh
source "${lib}" 2>/dev/null || exit 0

payload=""
if [[ ! -t 0 ]]; then
  payload="$(head -c 65536 2>/dev/null)" || payload=""
fi
# <payload key> → its string value, empty when absent or not a string
get_payload_field() {
  jq -r --arg key "$1" '.[$key] // empty | strings' <<<"${payload}" 2>/dev/null || true
}
hint="$(get_payload_field permission_mode)"
start_dir="$(get_payload_field cwd)"
session_id="$(get_payload_field session_id)"
transcript="$(get_payload_field transcript_path)"

shown_dir="$(queue_get_cwd "${start_dir}")"
# shellcheck disable=SC2310  # a pure read; an unreadable config counts as no shadowing
if queue_is_server_shadowed "${shown_dir}"; then
  # subshell write → no interrupt from an un-waited child reaches it; the exit stays 0 either way
  (printf "[ATRIUM-QUEUE] harness: a project or local MCP server named %s shadows the Atrium queue server in this \
session — use only the queue CLI, %s, never that server's tools\n" "${QUEUE_MCP_SERVER_NAME}" "$(queue_get_cli_path)") || true
fi
# shellcheck disable=SC2310  # a failed register is the fail-open exit, never an errexit
counts="$(queue_register_session "${hint}" "" "${start_dir}" "${session_id}" "" "${transcript}" 2>/dev/null)" || exit 0
IFS=' ' read -r owner_count relay_count <<<"${counts}"
line="$(queue_get_count_line "${owner_count}" "${relay_count}")"
if [[ -n "${line}" ]]; then
  # subshell write → no interrupt from an un-waited child reaches it; the exit stays 0 either way
  (printf '[ATRIUM-QUEUE] %s\n' "${line}") || true
fi
exit 0
