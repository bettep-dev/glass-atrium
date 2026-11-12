#!/usr/bin/env bash
# queue-session-register.sh — SessionStart hook (startup · resume · fork · clear): registers this session
# with the Atrium owner queue and, when answered items wait for it, prints one context line naming the
# count and the CLI pending command — never answer text.
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

# shellcheck disable=SC2310  # a failed register is the fail-open exit, never an errexit
count="$(queue_register_session "${hint}" "" "${start_dir}" "${session_id}" "" "${transcript}" 2>/dev/null)" || exit 0
if ((count > 0)); then
  cli_path="$(queue_get_cli_path)"
  # subshell write → no interrupt from an un-waited child reaches it; the exit stays 0 either way
  (printf '[ATRIUM-QUEUE] %s answered owner queue item(s) wait for this session — fetch them with: %s pending\n' "${count}" "${cli_path}") || true
fi
exit 0
