#!/usr/bin/env bash
# queue-turn-end-check.sh — Stop hook, at most one block per turn end, carrying either line or both, never an item's
# text: (1) an interactive or background main-session turn that called a tool and whose final message's last
# non-blank line is no [QUEUE-VERDICT] form, or names an id that is not an item of this session, is asked for its
# verdict once per turn; (2) while an item this session posted awaits the owner and no wait of this Claude process
# runs, the wait command.
# The verdict check confirms only that a verdict is stated and its ids are this session's items, never the judgment.
# With no CLAUDE_PID in the hook env, the wait lock's own record decides whether a wait runs (queue_get_wait_state).
# Disposition reask: stdout {"decision":"block","reason":…} at exit 0 (Stop channel b,
# shared-hook-capability-contract.md → Stop row). Fail-open: whatever it cannot decide ends the turn normally, exit 0;
# a transcript, monitor or payload failure leaves one stderr line.

set -Eeuo pipefail
IFS=$'\n\t'
# inside a $( ) the trap fails the substitution, so its caller still sees the failure
trap 'if ((BASH_SUBSHELL > 0)); then exit 1; fi; exit 0' ERR

# no new item fetch starts after this long → the pass stays bounded however many ids and marks it asks about
readonly CHECK_BUDGET_S=3
readonly CHECK_FETCH_MAX_S=1
# the same items to the same Claude process → named again only after this long, so a wait that fails fast starts no loop
readonly NUDGE_INTERVAL_MIN=10
# the nudge stamp's process key when the hook env holds no pid
readonly NUDGE_NO_PID_KEY=no-pid
# the verdict line's keyword and forms; the rule text that teaches them: glass-atrium-ops-orchestrator-role.md →
# Queue verdict line (queue-turn-end-check.bats feeds each form it teaches through this check)
readonly VERDICT_KEYWORD='[QUEUE-VERDICT]'
# shellcheck disable=SC2016  # the backticks are the reason's literal markdown
readonly VERDICT_FORMS='`[QUEUE-VERDICT] posted #<item-id>` (every item the turn posted, on the one line) or `[QUEUE-VERDICT] nothing to post`'
# %s → the queue CLI path
readonly VERDICT_ASK_TEMPLATE="Judge the turn against the must-not-miss kinds, post what is owed, then end the message with \
one last line: ${VERDICT_FORMS}. A decision posted now needs \`%s wait\` started as a background command."
readonly WAIT_REASON_LEAD="[ATRIUM-QUEUE] harness: an item of this session awaits the owner and no wait runs — start it \
now as a background command:"

self="${BASH_SOURCE[0]}"
if [[ -L "${self}" ]]; then
  self="$(readlink -f -- "${self}")" || exit 0
fi
lib="${self%/*}/../scripts/lib/queue-session.sh"
[[ -f "${lib}" ]] || exit 0
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/queue-session.sh
source "${lib}" 2>/dev/null || exit 0
# shellcheck source=lib/session-entrypoint.sh
source "${self%/*}/lib/session-entrypoint.sh" 2>/dev/null || exit 0
readonly TURN_READER="${self%/*}/lib/reply_language.py"

# set by the checks main runs, read by print_block
verdict_reason=""
wait_reason=""
tool_turn=""
foreign_ids=""
# a fetch failed or the budget ran out → no later fetch this pass, so the turn end leaves one stderr line at most
is_check_spent=false
check_deadline=0

main() {
  local fields="" is_subagent is_continued payload_session transcript has_message last_line session_id
  # shellcheck disable=SC2310  # no fields → the malformed-payload branch below
  if [[ ! -t 0 ]]; then fields="$(get_payload_fields)" || fields=""; fi
  if [[ -z "${fields}" ]]; then
    warn "the Stop payload is not a JSON object"
    exit 0
  fi
  IFS=$'\x1f' read -r is_subagent is_continued payload_session transcript has_message last_line <<<"${fields}"
  [[ "${is_subagent}" == false && "${is_continued}" == false ]] || exit 0
  session_id="$(queue_get_session_id "${payload_session}")"
  [[ -n "${session_id}" ]] || exit 0
  check_deadline=$((SECONDS + CHECK_BUDGET_S))
  # a `claude -p` run is never asked for a verdict
  # shellcheck disable=SC2310  # a single [[ ]] test, so the errexit suspension changes nothing
  if is_owner_facing_session; then
    set_verdict_reason "${session_id}" "${transcript}" "${has_message}" "${last_line}"
  fi
  if [[ "${is_check_spent}" == false ]]; then set_wait_reason "${session_id}"; fi
  [[ -n "${verdict_reason}${wait_reason}" ]] || exit 0
  print_block
}

# stdin payload → "<has agent_id>␟<stop_hook_active>␟<session_id>␟<transcript_path>␟<has a final message>␟<its last
# non-blank line, trailing whitespace trimmed>"; nothing for anything but a JSON object
get_payload_fields() {
  jq -r 'if type == "object" then
      [(has("agent_id") | tostring), (.stop_hook_active == true | tostring), (.session_id | strings // ""),
        (.transcript_path | strings // ""), (.last_assistant_message | type == "string" | tostring),
        ([.last_assistant_message | strings | splits("\n") | sub("\\s+$"; "") | select(length > 0)] | last // "")]
      | join("\u001f")
    else empty end' 2>/dev/null
}

warn() {
  (printf 'queue-turn-end-check: %s — the turn ends without the owner-queue check\n' "$1") >&2 || true
}

# <session id> <transcript path> <has a final message> <its last line> → verdict_reason: the ask, or empty when the
# turn called no tool, was asked already, carries a verdict this check accepts, or cannot be decided
set_verdict_reason() {
  local stamp
  set_tool_turn "$2"
  [[ -n "${tool_turn}" ]] || return 0
  if [[ "$3" != true ]]; then
    warn "the Stop payload carries no final message"
    return 0
  fi
  stamp="$(queue_get_awaiting_dir "$1")/.verdict-asked"
  if [[ -f "${stamp}" && "$(<"${stamp}")" == "${tool_turn}" ]]; then return 0; fi
  set_verdict_problem "$1" "$4"
  [[ -n "${verdict_reason}" ]] || return 0
  # the stamp lands before the ask → a later fire of this turn, its continuation included, is never asked again
  if ! (mkdir -p -- "${stamp%/*}" && printf '%s\n' "${tool_turn}" >"${stamp}") 2>/dev/null; then
    warn "no verdict stamp could be written at ${stamp}"
    verdict_reason=""
  fi
}

# <transcript path> → tool_turn: the current turn's start-entry id when the turn called a tool, else empty — after one
# warning when the turn cannot be read
set_tool_turn() {
  local found="" status="" turn="" tools=""
  if [[ -z "$1" ]]; then
    warn "the Stop payload names no transcript"
    return 0
  fi
  found="$(python3 -I "${TURN_READER}" turn "$1" 2>/dev/null \
    | jq -r '[.status, (.turn | strings // ""), (.tools == true | tostring)] | join("\u001f")' 2>/dev/null)" || found=""
  IFS=$'\x1f' read -r status turn tools <<<"${found}" || true
  if [[ "${status}" != found || -z "${turn}" ]]; then
    warn "the transcript's current turn could not be read"
  elif [[ "${tools}" == true ]]; then
    tool_turn="${turn}"
  fi
}

# <session id> <last line> → verdict_reason: empty for an accepted verdict, else the ask naming the forms and, for ids
# the monitor does not know for this session, those ids alone
set_verdict_problem() {
  local lead cli steps ids=()
  [[ "$2" != "${VERDICT_KEYWORD} nothing to post" ]] || return 0
  if [[ "$2" == "${VERDICT_KEYWORD} posted "* ]]; then
    IFS=' ' read -r -a ids <<<"${2#"${VERDICT_KEYWORD} posted "}" || true
  fi
  # shellcheck disable=SC2310  # a pure test, so the errexit suspension changes nothing
  if ((${#ids[@]} > 0)) && is_item_id_list "${ids[@]}"; then
    set_foreign_ids "$1" "${ids[@]}"
    [[ -n "${foreign_ids}" ]] || return 0
    lead="${foreign_ids} is not an item of this session: post it from this session or correct the verdict line"
  elif [[ "$2" == "${VERDICT_KEYWORD}"* ]]; then
    lead="this turn called a tool, and its final message's last line is not a queue verdict form"
  else
    lead="this turn called a tool, and its final message ends without a queue verdict line"
  fi
  cli="$(queue_get_cli_path)"
  # shellcheck disable=SC2059  # the format is this file's own constant; the CLI path goes in as an argument
  printf -v steps "${VERDICT_ASK_TEMPLATE}" "${cli}"
  verdict_reason="Queue verdict (harness): ${lead}. ${steps}"
}

# <word>... → 0 when every word is #<item id>
is_item_id_list() {
  local id
  for id in "$@"; do
    [[ "${id}" == "#"* && "${id#\#}" =~ ${QUEUE_ITEM_ID_SHAPE} ]] || return 1
  done
}

# <session id> <#id>... → foreign_ids: "#N #M" for each id the monitor does not know for this session; a failed fetch
# or a spent budget stops the pass with one warning, and the ids left unasked pass
set_foreign_ids() {
  local session_id="$1" id status
  shift
  for id in "$@"; do
    # shellcheck disable=SC2310  # a spent budget or an unusable reply already printed its warning
    if ! status="$(get_budgeted_item_status "${session_id}" "${id#\#}")"; then
      is_check_spent=true
      return 0
    fi
    if [[ "${status}" == gone ]]; then foreign_ids+="${foreign_ids:+ }${id}"; fi
  done
}

# <session id> → wait_reason: the wait command while an item of this session awaits the owner, no wait of this Claude
# process runs, and this process was not told about these items within NUDGE_INTERVAL_MIN
set_wait_reason() {
  local items nudge_key wait_state stamp newest item
  items="$(queue_get_awaiting_items "$1")"
  [[ -n "${items}" ]] || return 0
  nudge_key="$(queue_get_pid)"
  nudge_key="${nudge_key:-${NUDGE_NO_PID_KEY}}"
  wait_state="$(queue_get_wait_state "$1")"
  [[ "${wait_state}" != live ]] || return 0
  stamp="$(queue_get_awaiting_dir "$1")/.nudged"
  newest="${items%%$'\n'*}"
  # shellcheck disable=SC2310  # not due and a failed check both end the turn normally
  is_nudge_due "${stamp}" "${nudge_key}" "${newest}" || return 0
  # shellcheck disable=SC2310  # an unusable monitor reply already printed its warning
  item="$(get_wait_resolved_item "$1" "${items}")" || return 0
  [[ -n "${item}" ]] || return 0
  # the stamp lands before the continuation → no write failure can turn into a repeated one
  if ! (printf '%s %s\n' "${nudge_key}" "${newest}" >"${stamp}") 2>/dev/null; then
    warn "no nudge stamp could be written at ${stamp}"
    return 0
  fi
  wait_reason="${WAIT_REASON_LEAD} $(queue_get_cli_path) wait"
}

# <stamp> <nudge key> <newest item id> → 0 unless this Claude process was told about these items within
# NUDGE_INTERVAL_MIN
is_nudge_due() {
  local told_key="" told_newest="" recent
  [[ -f "$1" ]] || return 0
  IFS=' ' read -r told_key told_newest <"$1" || return 0
  if [[ "${told_key}" != "$2" || ! "${told_newest}" =~ ${QUEUE_ITEM_ID_SHAPE} ]] || (($3 > told_newest)); then
    return 0
  fi
  recent="$(find "$1" -mmin "-${NUDGE_INTERVAL_MIN}" 2>/dev/null)" || recent=""
  [[ -z "${recent}" ]]
}

# <session id> <item ids, newest first> → the first a running wait would carry, nothing when none; drops the marks of
# items the monitor reports terminal or unknown; non-zero on a monitor reply it cannot read or when CHECK_BUDGET_S runs
# out with marks left unasked
get_wait_resolved_item() {
  local id status
  for id in $2; do
    # shellcheck disable=SC2310  # a spent budget or an unusable reply already printed its warning
    status="$(get_budgeted_item_status "$1" "${id}")" || return 1
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

# <session id> <item id> → get_item_status while CHECK_BUDGET_S lasts; non-zero, after one warning, once it has run out
get_budgeted_item_status() {
  if ((SECONDS >= check_deadline)); then
    warn "the ${CHECK_BUDGET_S} s check budget ran out before item $2"
    return 1
  fi
  get_item_status "$1" "$2"
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

# one block for both checks: the verdict ask, then the wait command, one per line
print_block() {
  local reason="${verdict_reason}" block nl=$'\n'
  if [[ -n "${wait_reason}" ]]; then reason="${reason:+${reason}${nl}}${wait_reason}"; fi
  block="$(jq -nc --arg reason "${reason}" '{decision: "block", reason: $reason}')"
  # subshell write → no interrupt from an un-waited child reaches it; the exit stays 0 either way
  (printf '%s\n' "${block}") || true
}

main
exit 0
