#!/usr/bin/env bash
# queue-turn-end-check.sh — Stop hook: while an item this session posted awaits the owner and no wait of this Claude
# process runs, keeps the turn from ending once with one line naming the wait command — never the item's text.
# Disposition reask: stdout {"decision":"block","reason":…} at exit 0 (docs-only Stop channel,
# shared-hook-capability-contract.md → Stop row). Fail-open: whatever it cannot decide ends the turn normally, exit 0;
# a monitor or payload failure leaves one stderr line.

set -Eeuo pipefail
IFS=$'\n\t'
# inside a $( ) the trap fails the substitution, so its caller still sees the failure
trap 'if ((BASH_SUBSHELL > 0)); then exit 1; fi; exit 0' ERR

readonly CHECK_MAX_ITEMS=3
readonly CHECK_FETCH_MAX_S=1
# the same items to the same Claude process → named again only after this long, so a wait that fails fast starts no loop
readonly NUDGE_INTERVAL_MIN=10

self="${BASH_SOURCE[0]}"
if [[ -L "${self}" ]]; then
  self="$(readlink -f -- "${self}")" || exit 0
fi
lib="${self%/*}/../scripts/lib/queue-session.sh"
[[ -f "${lib}" ]] || exit 0
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/queue-session.sh
source "${lib}" 2>/dev/null || exit 0

main() {
  local fields="" is_subagent is_continued payload_session session_id items pid wait_state item stamp
  # the whole payload, uncapped → a long last_assistant_message never cuts the JSON short
  # shellcheck disable=SC2310  # no fields → the malformed-payload branch below
  if [[ ! -t 0 ]]; then fields="$(get_payload_fields)" || fields=""; fi
  if [[ -z "${fields}" ]]; then
    warn "the Stop payload is not a JSON object"
    exit 0
  fi
  IFS=$'\x1f' read -r is_subagent is_continued payload_session <<<"${fields}"
  [[ "${is_subagent}" == false && "${is_continued}" == false ]] || exit 0
  session_id="$(queue_get_session_id "${payload_session}")"
  [[ -n "${session_id}" ]] || exit 0
  items="$(queue_get_awaiting_items "${session_id}")"
  pid="$(queue_get_pid)"
  [[ -n "${items}" && -n "${pid}" ]] || exit 0
  wait_state="$(queue_get_wait_state "${session_id}")"
  [[ "${wait_state}" != live ]] || exit 0
  stamp="$(queue_get_awaiting_dir "${session_id}")/.nudged"
  # shellcheck disable=SC2310  # not due and a failed check both end the turn normally
  is_nudge_due "${stamp}" "${pid}" "${items%%$'\n'*}" || exit 0
  # shellcheck disable=SC2310  # an unusable monitor reply already printed its warning
  item="$(get_wait_resolved_item "${session_id}" "${items}")" || exit 0
  [[ -n "${item}" ]] || exit 0
  # the stamp lands before the continuation → no write failure can turn into a repeated one
  if ! (printf '%s %s\n' "${pid}" "${items%%$'\n'*}" >"${stamp}") 2>/dev/null; then
    warn "no nudge stamp could be written at ${stamp}"
    exit 0
  fi
  print_continuation
}

# stdin payload → "<has agent_id>␟<stop_hook_active>␟<session_id>"; nothing for anything but a JSON object
get_payload_fields() {
  jq -r 'if type == "object" then
      [(has("agent_id") | tostring), (.stop_hook_active == true | tostring), (.session_id | strings // "")]
      | join("\u001f")
    else empty end' 2>/dev/null
}

warn() {
  (printf 'queue-turn-end-check: %s — the turn ends without the owner-queue check\n' "$1") >&2 || true
}

# <stamp> <pid> <newest item id> → 0 unless this Claude process was told about these items within NUDGE_INTERVAL_MIN
is_nudge_due() {
  local told_pid="" told_newest="" recent
  [[ -f "$1" ]] || return 0
  IFS=' ' read -r told_pid told_newest <"$1" || return 0
  if [[ "${told_pid}" != "$2" || ! "${told_newest}" =~ ${QUEUE_ITEM_ID_SHAPE} ]] || (($3 > told_newest)); then
    return 0
  fi
  recent="$(find "$1" -mmin "-${NUDGE_INTERVAL_MIN}" 2>/dev/null)" || recent=""
  [[ -z "${recent}" ]]
}

# <session id> <item ids, newest first> → the first of at most CHECK_MAX_ITEMS a running wait would carry, nothing when
# none; drops the marks of items the monitor reports terminal or unknown; non-zero on a monitor reply it cannot read
get_wait_resolved_item() {
  local id status checked=0
  for id in $2; do
    ((checked++ < CHECK_MAX_ITEMS)) || break
    # shellcheck disable=SC2310  # an unusable reply already printed its warning
    status="$(get_item_status "$1" "${id}")" || return 1
    if [[ "${QUEUE_WAIT_RESOLVED_STATUSES}" == *" ${status} "* ]]; then
      printf '%s\n' "${id}"
      return 0
    fi
    if [[ "${status}" == gone || "${QUEUE_TERMINAL_STATUSES}" == *" ${status} "* ]]; then
      # shellcheck disable=SC2310  # a mark left behind costs one more confirm at a later turn end, never a reminder
      queue_delete_awaiting_item "$1" "${id}" || true
    fi
  done
}

# <session id> <item id> → its status, "gone" when the monitor knows no such item of this session; non-zero, after the
# warning, on no reply or an unusable one
get_item_status() {
  local reply code body status
  # shellcheck disable=SC2310  # no reply → the warning below
  if ! reply="$(queue_send GET "/api/queue/items/$2?sessionId=$1" "" "${CHECK_FETCH_MAX_S}")"; then
    warn "the monitor gave no reply within ${CHECK_FETCH_MAX_S} s"
    return 1
  fi
  code="$(queue_get_reply_code "${reply}")"
  if [[ "${code}" == 404 ]]; then
    printf 'gone\n'
    return 0
  fi
  body="$(queue_get_reply_body "${reply}")"
  status="$(jq -r '.status | strings' <<<"${body}" 2>/dev/null)" || status=""
  if [[ "${code}" != 2?? || ! "${status}" =~ ^[a-z_]+$ ]]; then
    warn "the monitor's item reply was unusable (HTTP ${code})"
    return 1
  fi
  printf '%s\n' "${status}"
}

print_continuation() {
  local reason block
  reason="[ATRIUM-QUEUE] harness: an item of this session awaits the owner and no wait runs — start it now as a"
  reason+=" background command: $(queue_get_cli_path) wait"
  block="$(jq -nc --arg reason "${reason}" '{decision: "block", reason: $reason}')"
  # subshell write → no interrupt from an un-waited child reaches it; the exit stays 0 either way
  (printf '%s\n' "${block}") || true
}

main
exit 0
