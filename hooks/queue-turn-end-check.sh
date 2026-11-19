#!/usr/bin/env bash
# queue-turn-end-check.sh — Stop hook, at most one block per turn end, carrying either line or both, never an item's
# text: (1) an interactive or background main-session turn that called a tool is asked once per turn for its queue
# record unless its last tool call is a record call (the CLI's record subcommand, or the server's record tool unless
# the session's start found that server shadowed: queue_set_shadow_mark) and the session's record was written at or
# after the turn's start entry; a shadowed session's ask names the CLI alone; (2) while an item this session posted awaits the
# owner and nothing polls the monitor for this Claude process (queue_get_poller), the wait command — a fallback for
# processes no listener serves. Each turn end also sends the transcript's title as the session's name once it changed
# (queue_put_session_name).
# The record check confirms only that a record was made, never the judgment; the record operation checks its ids.
# With no CLAUDE_PID in the hook env, the wait lock's own record decides whether a wait runs (queue_get_poller).
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
# the nudge stamp's process key when the hook env holds no pid
readonly NUDGE_NO_PID_KEY=no-pid
# shellcheck disable=SC2016  # the backticks are the reason's literal markdown; %s → the server name, the CLI, the CLI
readonly RECORD_ASK_TEMPLATE="Queue record (harness): this turn called a tool, and its last tool call is no queue \
record made in this turn. Judge the turn against the must-not-miss kinds, post what is owed, then call the \
%s server's \`record\` tool alone, last — form nothing, or posted with every item id the turn \
posted; a session without the server runs \`%s record nothing\` or \`%s record posted <id>...\` instead."
# shellcheck disable=SC2016  # the backticks are the reason's literal markdown; %s → the server name, the CLI, the CLI
readonly SHADOWED_RECORD_ASK_TEMPLATE="Queue record (harness): this turn called a tool, and its last tool call is no \
queue record made in this turn. Judge the turn against the must-not-miss kinds, post what is owed, then run the queue \
CLI alone, last — a project or local MCP server named %s shadows the Atrium queue server in this session, so never \
call its tools: \`%s record nothing\`, or \`%s record posted <id>...\` with every item id the turn posted."
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
poller=""
record_reason=""
wait_reason=""
# set by set_record_reason: the session's start found the queue server shadowed (queue_is_shadow_marked)
is_shadowed=false
# set by set_tool_turn: a tool-using turn's start-entry id and time, and whether its last tool call is a record call
tool_turn=""
turn_started=""
is_record_last=false
check_deadline=0

main() {
  local fields="" is_subagent is_continued payload_session transcript session_id
  # shellcheck disable=SC2310  # no fields → the malformed-payload branch below
  if [[ ! -t 0 ]]; then fields="$(get_payload_fields)" || fields=""; fi
  if [[ -z "${fields}" ]]; then
    warn "the Stop payload is not a JSON object"
    exit 0
  fi
  IFS=$'\x1f' read -r is_subagent is_continued payload_session transcript <<<"${fields}"
  [[ "${is_subagent}" == false && "${is_continued}" == false ]] || exit 0
  session_id="$(queue_get_session_id "${payload_session}")"
  [[ -n "${session_id}" ]] || exit 0
  check_deadline=$((SECONDS + CHECK_BUDGET_S))
  poller="$(queue_get_poller "${session_id}")"
  # a `claude -p` run is never asked for a record
  # shellcheck disable=SC2310  # a single [[ ]] test, so the errexit suspension changes nothing
  if is_owner_facing_session; then set_record_reason "${session_id}" "${transcript}"; fi
  set_wait_reason "${session_id}"
  # shellcheck disable=SC2310  # a refused update is sent again at the next turn end
  queue_put_session_name "${transcript}" "${session_id}" || true
  [[ -n "${record_reason}${wait_reason}" ]] || exit 0
  print_block
}

# stdin payload → "<has agent_id>␟<stop_hook_active>␟<session_id>␟<transcript_path>"; nothing for anything but a JSON
# object
get_payload_fields() {
  jq -r 'if type == "object" then
      [(has("agent_id") | tostring), (.stop_hook_active == true | tostring), (.session_id | strings // ""),
        (.transcript_path | strings // "")]
      | join("\u001f")
    else empty end' 2>/dev/null
}

warn() {
  (printf 'queue-turn-end-check: %s — the turn ends without the owner-queue check\n' "$1") >&2 || true
}

# <session id> <transcript path> → record_reason: the ask, or empty when the turn called no tool, was asked already,
# ends on a record call made at or after its start, or cannot be decided
set_record_reason() {
  local stamp recorded cli template="${RECORD_ASK_TEMPLATE}"
  # shellcheck disable=SC2310  # a pure read; no readable mark counts as unshadowed
  if queue_is_shadow_marked "$1"; then
    is_shadowed=true
    template="${SHADOWED_RECORD_ASK_TEMPLATE}"
  fi
  set_tool_turn "$2"
  [[ -n "${tool_turn}" ]] || return 0
  recorded="$(queue_get_record_time "$1")"
  if [[ "${is_record_last}" == true && -n "${recorded}" && ! "${recorded}" < "${turn_started}" ]]; then return 0; fi
  stamp="$(queue_get_awaiting_dir "$1")/.record-asked"
  if [[ -f "${stamp}" && "$(<"${stamp}")" == "${tool_turn}" ]]; then return 0; fi
  # the stamp lands before the ask → a later fire of this turn, its continuation included, is never asked again
  if ! (mkdir -p -- "${stamp%/*}" && printf '%s\n' "${tool_turn}" >"${stamp}") 2>/dev/null; then
    warn "no record-ask stamp could be written at ${stamp}"
    return 0
  fi
  cli="$(queue_get_cli_path)"
  # shellcheck disable=SC2059  # the format is one of this file's own constants; the names go in as arguments
  printf -v record_reason "${template}" "${QUEUE_MCP_SERVER_NAME}" "${cli}" "${cli}"
}

# <transcript path> → tool_turn, turn_started and is_record_last for a turn that called a tool; all left unset when it
# called none, and after one warning when the turn or its start time cannot be read. In a shadowed session the
# server's record tool is the shadowing server's, so only the CLI's record counts.
set_tool_turn() {
  local found="" status="" turn="" started="" tools="" is_record="" cli pattern tool=""
  if [[ -z "$1" ]]; then
    warn "the Stop payload names no transcript"
    return 0
  fi
  cli="$(queue_get_cli_path)"
  cli="${cli##*/}"
  # a Bash command running the CLI's record subcommand, the CLI named by its file name
  pattern="(^|[[:space:]/\"'])${cli//./\\.}[\"']?[[:space:]]+record([[:space:]]|$)"
  if [[ "${is_shadowed}" == false ]]; then tool="mcp__${QUEUE_MCP_SERVER_NAME}__record"; fi
  found="$(python3 -I "${TURN_READER}" turn "$1" 2>/dev/null \
    | jq -r --arg tool "${tool}" --arg pattern "${pattern}" \
      '[.status, (.turn | strings // ""), (.started | strings // ""), (.tools == true | tostring),
        (($tool != "" and .last_tool.name == $tool)
          or (.last_tool.name == "Bash" and (.last_tool.command // "" | test($pattern))) | tostring)] | join("\u001f")' 2>/dev/null)" || found=""
  IFS=$'\x1f' read -r status turn started tools is_record <<<"${found}" || true
  if [[ "${status}" != found || -z "${turn}" || ! "${started}" =~ ${QUEUE_RECORD_TIME_SHAPE} ]]; then
    warn "the transcript's current turn could not be read"
  elif [[ "${tools}" == true ]]; then
    tool_turn="${turn}"
    turn_started="${started}"
    is_record_last="${is_record}"
  fi
}

# <session id> → wait_reason: the wait command while an item of this session awaits the owner, nothing polls the
# monitor for this Claude process (queue_get_poller), and this process was not told about these items within
# QUEUE_NUDGE_INTERVAL_MIN
set_wait_reason() {
  local items nudge_key stamp newest item
  items="$(queue_get_awaiting_items "$1")"
  [[ -n "${items}" ]] || return 0
  nudge_key="$(queue_get_pid)"
  nudge_key="${nudge_key:-${NUDGE_NO_PID_KEY}}"
  # a listener announces the same answered items a wait would claim → a nudged wait beside it only costs turns
  [[ "${poller}" == none ]] || return 0
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
# QUEUE_NUDGE_INTERVAL_MIN
is_nudge_due() {
  local told_key="" told_newest=""
  [[ -f "$1" ]] || return 0
  IFS=' ' read -r told_key told_newest <"$1" || return 0
  if [[ "${told_key}" != "$2" || ! "${told_newest}" =~ ${QUEUE_ITEM_ID_SHAPE} ]] || (($3 > told_newest)); then
    return 0
  fi
  # shellcheck disable=SC2310  # a stamp it cannot read counts as old → the nudge, the fallback
  if queue_is_touched_within_nudge "$1"; then return 1; fi
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

# <session id> <item id> → queue_get_item_status while CHECK_BUDGET_S lasts; non-zero, after one warning, once it has run
# out, on no reply or on an unusable one
get_budgeted_item_status() {
  local code=0
  if ((SECONDS >= check_deadline)); then
    warn "the ${CHECK_BUDGET_S} s check budget ran out before item $2"
    return 1
  fi
  # shellcheck disable=SC2310  # its status picks the warning below
  queue_get_item_status "$1" "$2" "${CHECK_FETCH_MAX_S}" || code=$?
  case "${code}" in
    0) return 0 ;;
    1) warn "the monitor gave no reply within ${CHECK_FETCH_MAX_S} s" ;;
    *) warn "the monitor's item reply was unusable" ;;
  esac
  return 1
}

# one block for both checks: the record ask, then the wait command, one per line
print_block() {
  local reason="${record_reason}" block nl=$'\n'
  if [[ -n "${wait_reason}" ]]; then reason="${reason:+${reason}${nl}}${wait_reason}"; fi
  block="$(jq -nc --arg reason "${reason}" '{decision: "block", reason: $reason}')"
  # subshell write → no interrupt from an un-waited child reaches it; the exit stays 0 either way
  (printf '%s\n' "${block}") || true
}

main
exit 0
