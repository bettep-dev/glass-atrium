#!/usr/bin/env bash
# atrium-queue.sh — the owner queue CLI a Claude Code session runs: post a report or a decision, fetch an
# item, pull this session's answered items, ack a delivery, withdraw an item, and register this session.
# Run it by its absolute installed path with nothing in front — the one literal the settings allow rule names.
# Exit codes: 0 done · 1 monitor unreachable, unprovisioned, failing or replying malformed · 2 refused by the
#   monitor · 3 the fetched item names another session (stop, take no action) · 64 usage or local validation

set -Eeuo pipefail
IFS=$'\n\t'

self="${BASH_SOURCE[0]}"
if [[ -L "${self}" ]]; then
  self="$(readlink -f -- "${self}")"
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${self}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source-path=SCRIPTDIR source=lib/queue-session.sh
source "${SCRIPT_DIR}/lib/queue-session.sh"

readonly CLI_MAX_TIME_S=10
readonly ITEM_ID_SHAPE='^[1-9][0-9]{0,15}$'
# the monitor's route bodyLimit
readonly ITEM_MAX_BYTES=196608
# the monitor claims at most 20 per pull → 10 rounds bound one call at 200 items
readonly PULL_ROUNDS_MAX=10
readonly ITEM_FIELDS='{"report":["body","isFreeTextAllowed","linkedDocIds","title"],
  "decision":["body","isApprovalClass","isFreeTextAllowed","linkedDocIds","options","recommendedCode","title"]}'

# The monitor's postItemBodySchema rules → one line per problem; nothing when the item passes.
ITEM_PROBLEMS_JQ="$(
  cat <<'JQ'
def is_text($max): type == "string" and length <= $max and test("\\S");
def is_code: type == "string" and test("^R[1-9]$");
def is_doc_id: type == "number" and . == floor and . >= 1 and . <= 9007199254740991;
def is_option:
  type == "object" and (keys == ["code", "cons", "label", "pros"]) and (.code | is_code)
  and (.label | is_text(200)) and (.pros | type == "string" and length <= 800)
  and (.cons | type == "string" and length <= 800);
def doc_problem:
  if has("linkedDocIds") | not then empty
  elif (.linkedDocIds | type == "array" and length <= 20 and all(.[]; is_doc_id)) | not
  then "linkedDocIds: at most 20 integer doc ids, each 1 or more"
  elif (.linkedDocIds | unique | length) != (.linkedDocIds | length) then "linkedDocIds: each doc id once"
  else empty end;
def option_problem:
  if (.options | type == "array" and length >= 2 and length <= 9) | not then "options: 2 to 9 options"
  elif any(.options[]; is_option | not)
  then "options: each exactly {code R1-R9, label (non-blank, at most 200), pros, cons (each at most 800)}"
  elif (.options | map(.code) | unique | length) != (.options | length) then "options: each code once"
  elif . as $item | any(.options[]; .code == $item.recommendedCode) | not
  then "recommendedCode: one of the option codes"
  elif has("isApprovalClass") and (.isApprovalClass | type) != "boolean" then "isApprovalClass: true or false"
  else empty end;
if type != "object" then "the item must be a JSON object"
else
  ((keys - $fields[$kind]) | select(length > 0) | "unknown field(s): \(join(", "))"),
  (if .title | is_text(200) then empty else "title: non-blank, at most 200 characters" end),
  (if .body | is_text(20000) then empty else "body: non-blank, at most 20000 characters" end),
  (if (.isFreeTextAllowed | type) == "boolean" then empty else "isFreeTextAllowed: true or false" end),
  doc_problem,
  (if $kind == "decision" then option_problem else empty end)
end
JQ
)"
readonly ITEM_PROBLEMS_JQ

main() {
  local cmd="${1:-}"
  (($# == 0)) || shift
  case "${cmd}" in
    report | decision) post_item "${cmd}" "$@" ;;
    get) get_item "$@" ;;
    pending) pull_pending "$@" ;;
    ack) ack_delivery "$@" ;;
    withdraw) withdraw_item "$@" ;;
    register) register_session "$@" ;;
    help | -h | --help) print_usage ;;
    *) fail_usage "${cmd:+unknown command ${cmd}}" ;;
  esac
}

print_usage() {
  local cli
  cli="$(queue_get_cli_path)"
  cat <<USAGE
Usage — run by this absolute path, no interpreter or env prefix in front, so the allow rule matches:
  ${cli} report <item.json|->     post a report; prints the new item id
  ${cli} decision <item.json|->   post a decision; prints the new item id
  ${cli} get <item-id>            fetch one of this session's items, answer included
  ${cli} pending                  claim this session's answered items; prints each one's fetch and ack steps
  ${cli} ack <item-id> <msg-id>   ack a delivery; act on the answer only when it prints "first"
  ${cli} withdraw <item-id>       withdraw an item not in delivery
  ${cli} register                 register this session (a resumed session runs it after its ack steps)
  ${cli} help
Item JSON: title, body, isFreeTextAllowed, optional linkedDocIds; a decision adds options
  [{code R1-R9, label, pros, cons}] (2 to 9), recommendedCode and optional isApprovalClass.
The session id comes from CLAUDE_CODE_SESSION_ID and the queue key from its 0600 file — pass neither.
Exit codes: 0 done · 1 monitor unreachable or failing · 2 refused by the monitor · 3 item of another session · 64 usage
Prompt-free in default permission mode, through this allow rule in the shared user settings:
  Bash(${cli}:*)
USAGE
}

fail_usage() {
  if [[ -n "${1:-}" ]]; then printf 'atrium-queue: %s\n' "$1" >&2; fi
  print_usage >&2
  exit 64
}

fail() {
  printf 'atrium-queue: %s\n' "$2" >&2
  exit "$1"
}

require_session_id() {
  local session_id
  session_id="$(queue_get_session_id)"
  [[ -n "${session_id}" ]] || fail 64 "CLAUDE_CODE_SESSION_ID is unset or not a UUID — run this inside a Claude Code session"
  printf '%s\n' "${session_id}"
}

require_item_id() {
  [[ "${1:-}" =~ ${ITEM_ID_SHAPE} ]] || fail 64 "item id must be a positive integer, got '${1:-}'"
}

# <method> <route> [json body] → the 2xx reply body; a refusal exits 2, anything else exits 1.
call_monitor() {
  local route="$2" reply status body reason
  # shellcheck disable=SC2310  # no reply → the named exit below
  reply="$(queue_send "$1" "${route}" "${3:-}" "${CLI_MAX_TIME_S}")" \
    || fail 1 "no reply from the monitor on ${route} (down, slow, or the queue key is not provisioned)"
  status="${reply##*$'\n'}"
  body="${reply%$'\n'*}"
  case "${status}" in
    2??) printf '%s\n' "${body}" ;;
    4??)
      reason="$(describe_error "${body}")"
      fail 2 "refused (${status}) on ${route}: ${reason}"
      ;;
    *) fail 1 "monitor failed (${status}) on ${route}" ;;
  esac
}

# The monitor's {error, reason} as one control-free line, capped → safe to print to a terminal or transcript.
describe_error() {
  jq -r '[.error, .reason] | map(strings) | join(": ") | gsub("[[:cntrl:]]"; " ") | .[:300]' <<<"$1" 2>/dev/null \
    || printf 'unreadable reply\n'
}

post_item() {
  local kind="$1" source="${2:-}" session_id raw body reply id
  [[ -n "${source}" && $# -eq 2 ]] || fail_usage "${kind} takes one item file, or - for stdin"
  session_id="$(require_session_id)"
  raw="$(read_item "${source}")"
  body="$(build_item_body "${kind}" "${session_id}" "${raw}")"
  reply="$(call_monitor POST /api/queue/items "${body}")"
  id="$(jq -r '.id' <<<"${reply}" 2>/dev/null)" || id=""
  [[ "${id}" =~ ${ITEM_ID_SHAPE} ]] || fail 1 "the monitor's reply named no item id"
  printf 'posted %s item %s\n' "${kind}" "${id}"
}

read_item() {
  local source="$1" raw size
  if [[ "${source}" == - ]]; then
    raw="$(head -c "$((ITEM_MAX_BYTES + 1))")"
  else
    [[ -f "${source}" && -r "${source}" ]] || fail 64 "no readable item file at ${source}"
    raw="$(head -c "$((ITEM_MAX_BYTES + 1))" -- "${source}")"
  fi
  size="$(printf '%s' "${raw}" | LC_ALL=C wc -c | tr -d ' ')"
  ((size <= ITEM_MAX_BYTES)) || fail 64 "the item is over ${ITEM_MAX_BYTES} bytes"
  printf '%s\n' "${raw}"
}

# Local validation first → a rejected item never reaches the monitor; the monitor validates again.
build_item_body() {
  local kind="$1" session_id="$2" raw="$3" problems
  problems="$(jq -r --arg kind "${kind}" --argjson fields "${ITEM_FIELDS}" "${ITEM_PROBLEMS_JQ}" <<<"${raw}" 2>/dev/null)" \
    || fail 64 "the ${kind} item is not valid JSON"
  if [[ -n "${problems}" ]]; then
    printf 'atrium-queue: invalid %s item — %s\n' "${kind}" "${problems//$'\n'/; }" >&2
    exit 64
  fi
  jq -c --arg kind "${kind}" --arg sessionId "${session_id}" '{kind: $kind, sessionId: $sessionId} + .' <<<"${raw}"
}

get_item() {
  local id="${1:-}" session_id reply owner
  require_item_id "${id}"
  session_id="$(require_session_id)"
  reply="$(call_monitor GET "/api/queue/items/${id}?sessionId=${session_id}")"
  owner="$(jq -r '.sessionId | strings' <<<"${reply}" 2>/dev/null)" || owner=""
  if [[ "${owner}" != "${session_id}" ]]; then
    fail 3 "item ${id} does not belong to this session — stop here and take no action on it"
  fi
  jq . <<<"${reply}"
}

ack_delivery() {
  local id="${1:-}" msg_id="${2:-}" session_id body reply result
  require_item_id "${id}"
  [[ "${msg_id}" =~ ${QUEUE_UUID_SHAPE} ]] || fail 64 "msg id must be a UUID, got '${msg_id}'"
  session_id="$(require_session_id)"
  body="$(jq -nc --arg sessionId "${session_id}" --arg msgId "${msg_id}" '{$sessionId, $msgId}')"
  reply="$(call_monitor POST "/api/queue/items/${id}/ack" "${body}")"
  result="$(jq -r '.result | strings' <<<"${reply}" 2>/dev/null)" || result=""
  case "${result}" in
    first) printf 'first\n' ;;
    already_handled) printf 'already handled\n' ;;
    *) fail 1 "the monitor's ack reply named no result — treat it as not first and do nothing" ;;
  esac
}

withdraw_item() {
  local id="${1:-}" session_id body
  require_item_id "${id}"
  session_id="$(require_session_id)"
  body="$(jq -nc --arg sessionId "${session_id}" '{$sessionId}')"
  call_monitor POST "/api/queue/items/${id}/withdraw" "${body}" >/dev/null
  printf 'withdrew item %s\n' "${id}"
}

# Pulls until a pull claims nothing (bounded); each claim's ids are checked before they go into a printed command.
pull_pending() {
  local session_id body reply claims total=0 round
  session_id="$(require_session_id)"
  body="$(jq -nc --arg sessionId "${session_id}" '{$sessionId}')"
  for ((round = 1; round <= PULL_ROUNDS_MAX; round++)); do
    reply="$(call_monitor POST /api/queue/pending "${body}")"
    claims="$(jq -r '.items[] | "\(.id.item)\t\(.id.msg)"' <<<"${reply}" 2>/dev/null)" \
      || fail 1 "the monitor's pending reply is malformed"
    [[ -n "${claims}" ]] || break
    print_claims "${claims}"
    total=$((total + $(wc -l <<<"${claims}")))
  done
  if ((total == 0)); then printf 'no answered items wait for this session\n'; fi
}

print_claims() {
  local cli id msg_id
  cli="$(queue_get_cli_path)"
  while IFS=$'\t' read -r id msg_id; do
    [[ "${id}" =~ ${ITEM_ID_SHAPE} && "${msg_id}" =~ ${QUEUE_UUID_SHAPE} ]] \
      || fail 1 "the monitor's pending reply carries a malformed item or msg id"
    printf 'item %s · msg %s — follow in order:\n' "${id}" "${msg_id}"
    printf '1. Fetch it: %s get %s — if the fetched session id is not yours, stop here.\n' "${cli}" "${id}"
    printf '2. Ack it: %s ack %s %s — act only when the reply is "first".\n' "${cli}" "${id}" "${msg_id}"
    printf '3. Act on the answer as the next step of your task.\n'
  done <<<"$1"
}

register_session() {
  local count cli pid
  require_session_id >/dev/null
  pid="$(queue_get_pid)"
  [[ -n "${pid}" ]] || fail 64 "CLAUDE_PID is unset or not a pid — run this inside a Claude Code session"
  # shellcheck disable=SC2310  # a failed register → the named exit below
  count="$(queue_register_session "" "${CLI_MAX_TIME_S}")" \
    || fail 1 "register failed (monitor down, slow, refusing, or the queue key is not provisioned)"
  printf 'registered this session with the Atrium queue\n'
  if ((count > 0)); then
    cli="$(queue_get_cli_path)"
    printf '%s answered owner queue item(s) wait for this session — fetch them with: %s pending\n' "${count}" "${cli}"
  fi
}

main "$@"
