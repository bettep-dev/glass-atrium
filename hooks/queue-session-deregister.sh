#!/usr/bin/env bash
# queue-session-deregister.sh — SessionEnd hook: deregisters this session from the Atrium owner queue
# (pid, else the messaging socket path, else the id alone) and removes its messaging token file.
# Disposition noop: fail-open, always exit 0 with nothing printed. No block channel.

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
session_id="$(jq -r '.session_id // empty | strings' <<<"${payload}" 2>/dev/null)" || session_id=""
# shellcheck disable=SC2310  # a failed deregister is the fail-open exit, never an errexit
queue_deregister_session "${session_id}" >/dev/null 2>&1 || true
exit 0
