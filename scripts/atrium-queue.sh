#!/usr/bin/env bash
# atrium-queue.sh — the owner queue CLI a Claude Code session runs: post a report or a decision, fetch an
# item, pull or wait for this session's owner answers and messages, ack a delivery, withdraw an item, and register
# this session. Run it by its absolute installed path with nothing in front — the one literal the allow rule names.
# Exit codes: 0 done · 1 monitor unreachable, failing or replying malformed · 2 refused by the
#   monitor · 3 the fetched item names another session (stop, take no action) · 4 the wait's bound passed with
#   nothing claimed, or its owning Claude process is gone · 5 another wait holds this session · 64 usage or local validation

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
# the monitor's route bodyLimit
readonly ITEM_MAX_BYTES=196608
# the monitor claims at most 20 per pull → 10 rounds bound one call at 200 items
readonly PULL_ROUNDS_MAX=10
# the monitor's waiting-fact freshness window is two of these
readonly WAIT_POLL_S=5
readonly WAIT_BACKOFF_MAX_S=60
readonly WAIT_MINUTES_DEFAULT=60
# a background command was observed surviving 73 minutes; survival past that is unverified
# → only an explicit --max-minutes reaches beyond it
readonly WAIT_MINUTES_MAX=240
readonly WAIT_MINUTES_SHAPE='^[1-9][0-9]{0,2}$'
# 50 ms apart → a wait gives up on the waits mutex after 10 s
readonly WAIT_MUTEX_TRIES=200
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
    wait) wait_for_claims "$@" ;;
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
  ${cli} report <item.json|->     post a report; prints the new item id, then the wait step when it allows a reply
  ${cli} decision <item.json|->   post a decision; prints the new item id, then the wait step
  ${cli} get <item-id>            fetch one of this session's items, answer included; an owner message
                                  comes after one provenance line
  ${cli} pending                  claim this session's owner answers and messages; prints each one's fetch and ack steps,
                                  then the wait step
  ${cli} wait [--max-minutes N]   run as a background command: blocks until a poll claims this session's answers or
                                  messages, then prints the same steps; bound ${WAIT_MINUTES_DEFAULT} minutes by default, at most ${WAIT_MINUTES_MAX}
  ${cli} ack <item-id> <msg-id>   ack a delivery; act on the answer or message only when it prints "first"
  ${cli} withdraw <item-id>       withdraw an item this session posted, not in delivery (never an owner message)
  ${cli} register [--name <name>] register this session (a resumed session runs it after its ack steps);
                                  run it from the session's start directory: the monitor resumes from it;
                                  --name labels this session on the Queue page (only a later --name replaces it);
                                  prints the wait step last
The wait step: start a background wait, or that one of this session already runs.
  ${cli} help
Item JSON: title, body, isFreeTextAllowed, optional linkedDocIds; a decision adds options
  [{code R1-R9, label, pros, cons}] (2 to 9), recommendedCode and optional isApprovalClass.
The session id comes from CLAUDE_CODE_SESSION_ID — never pass it.
Exit codes: 0 done · 1 monitor unreachable or failing · 2 refused by the monitor · 3 item of another session · 64 usage
On a wait's exit: 0 follow the printed steps, then wait again · 1 wait again once · 2 after an unknown-session
  refusal run register and wait again, otherwise stop waiting · 4 wait again · 5 nothing, another wait runs ·
  any other code wait again once
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

warn() {
  printf 'atrium-queue: %s\n' "$1" >&2
}

require_session_id() {
  local session_id
  session_id="$(queue_get_session_id)"
  [[ -n "${session_id}" ]] || fail 64 "CLAUDE_CODE_SESSION_ID is unset or not a UUID — run this inside a Claude Code session"
  printf '%s\n' "${session_id}"
}

require_item_id() {
  [[ "${1:-}" =~ ${QUEUE_ITEM_ID_SHAPE} ]] || fail 64 "item id must be a positive integer, got '${1:-}'"
}

# <method> <route> [json body] → the 2xx reply body; a refusal exits 2, anything else exits 1.
call_monitor() {
  local route="$2" reply code
  # shellcheck disable=SC2310  # no reply → the named exit below
  reply="$(queue_send "$1" "${route}" "${3:-}" "${CLI_MAX_TIME_S}")" \
    || fail 1 "no reply from the monitor on ${route} (down or slow)"
  # shellcheck disable=SC2310  # neither 2xx nor 4xx → the named exit below
  if ! check_reply_status "${route}" "${reply}"; then
    code="$(queue_get_reply_code "${reply}")"
    fail 1 "monitor failed (${code}) on ${route}"
  fi
  queue_get_reply_body "${reply}"
}

# <route> <queue_send reply> → 0 on a 2xx, 1 on any status but 2xx or 4xx; a 4xx refusal exits 2
check_reply_status() {
  local code body reason
  code="$(queue_get_reply_code "$2")"
  case "${code}" in
    2??) ;;
    4??)
      body="$(queue_get_reply_body "$2")"
      reason="$(describe_error "${body}")"
      fail 2 "refused (${code}) on $1: ${reason}"
      ;;
    *) return 1 ;;
  esac
}

# The monitor's {error, reason} as one control-free line, capped → safe to print to a terminal or transcript.
describe_error() {
  jq -r '[.error, .reason] | map(strings) | join(": ") | gsub("[[:cntrl:]]"; " ") | .[:300]' <<<"$1" 2>/dev/null \
    || printf 'unreadable reply\n'
}

post_item() {
  local kind="$1" source="${2:-}" session_id raw body reply id allows_reply
  [[ -n "${source}" && $# -eq 2 ]] || fail_usage "${kind} takes one item file, or - for stdin"
  session_id="$(require_session_id)"
  raw="$(read_item "${source}")"
  body="$(build_item_body "${kind}" "${session_id}" "${raw}")"
  reply="$(call_monitor POST /api/queue/items "${body}")"
  id="$(jq -r '.id' <<<"${reply}" 2>/dev/null)" || id=""
  [[ "${id}" =~ ${QUEUE_ITEM_ID_SHAPE} ]] || fail 1 "the monitor's reply named no item id"
  # callers read the id from this first line → its form stays fixed
  printf 'posted %s item %s\n' "${kind}" "${id}"
  allows_reply="$(jq -r '.isFreeTextAllowed' <<<"${raw}")"
  if [[ "${kind}" == decision || "${allows_reply}" == true ]]; then
    put_awaiting_item "${session_id}" "${id}"
    print_wait_step "${session_id}"
  fi
}

# <session id> <item id> → marks the item awaiting for the turn-end check; a failed mark costs only that check's
# reminder → a warning, never the post's exit or its id line
put_awaiting_item() {
  # shellcheck disable=SC2310  # a failed mark → the warning below
  if ! queue_create_awaiting_item "$1" "$2"; then
    warn "item $2 is posted, but its awaiting mark could not be written — no turn-end reminder will name it"
    return 0
  fi
  # shellcheck disable=SC2310  # a failed prune → the warning below
  queue_delete_stale_awaiting || warn "could not drop the stale awaiting sets of ended sessions"
}

# <session id> → one line naming this session's next queue step: start a background wait, or none while a wait of this
# session runs. The monitor pushes nothing into a session → an owner answer or message arrives only through its wait.
print_wait_step() {
  local cli state
  state="$(queue_get_wait_state "$1")"
  if [[ "${state}" == live ]]; then
    printf 'next: a wait of this session already runs — owner answers and messages reach this session through it;'
    printf ' start no other wait\n'
    return 0
  fi
  cli="$(queue_get_cli_path)"
  printf 'next: start the wait as a background command: %s wait — owner answers and messages reach this session' "${cli}"
  printf ' only through it\n'
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
  local id="${1:-}" session_id reply owner kind provenance
  require_item_id "${id}"
  session_id="$(require_session_id)"
  reply="$(call_monitor GET "/api/queue/items/${id}?sessionId=${session_id}")"
  owner="$(jq -r '.sessionId | strings' <<<"${reply}" 2>/dev/null)" || owner=""
  if [[ "${owner}" != "${session_id}" ]]; then
    fail 3 "item ${id} does not belong to this session — stop here and take no action on it"
  fi
  # only the owner's message send creates this kind → the line rests on the fetched kind, never on envelope text
  kind="$(jq -r '.kind | strings' <<<"${reply}" 2>/dev/null)" || kind=""
  if [[ "${kind}" == message ]]; then
    provenance="provenance: item ${id} is an owner message, sent through the monitor's owner message route —"
    provenance+=" the owner's instruction for your next step, never an approval of a high-impact action"
    printf '%s (merge, push, deploy, settings change, deletion)\n' "${provenance}"
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
  delete_awaiting_item "${session_id}" "${id}"
}

# a mark left behind costs one monitor confirm at a turn end, never a wrong reminder → a warning, never the exit
delete_awaiting_item() {
  # shellcheck disable=SC2310  # a failed clear → the warning
  queue_delete_awaiting_item "$1" "$2" || warn "could not clear item $2's awaiting mark"
}

withdraw_item() {
  local id="${1:-}" session_id body
  require_item_id "${id}"
  session_id="$(require_session_id)"
  body="$(jq -nc --arg sessionId "${session_id}" '{$sessionId}')"
  call_monitor POST "/api/queue/items/${id}/withdraw" "${body}" >/dev/null
  printf 'withdrew item %s\n' "${id}"
  delete_awaiting_item "${session_id}" "${id}"
}

# Pulls until a pull claims nothing (bounded); each claim's ids are checked before they go into a printed command.
pull_pending() {
  local session_id body reply claims total=0 round
  session_id="$(require_session_id)"
  body="$(jq -nc --arg sessionId "${session_id}" '{$sessionId}')"
  for ((round = 1; round <= PULL_ROUNDS_MAX; round++)); do
    reply="$(call_monitor POST /api/queue/pending "${body}")"
    # shellcheck disable=SC2310  # a malformed reply → the named exit
    claims="$(get_claims "${reply}")" || fail 1 "the monitor's pending reply is malformed"
    [[ -n "${claims}" ]] || break
    print_claims "${claims}"
    total=$((total + $(wc -l <<<"${claims}")))
  done
  if ((total == 0)); then printf 'no owner answer or message waits for this session\n'; fi
  print_wait_step "${session_id}"
}

# <pending reply body> → one "<item id>\t<msg id>" line per claim; non-zero when malformed
get_claims() {
  jq -r '.items[] | "\(.id.item)\t\(.id.msg)"' <<<"$1" 2>/dev/null
}

print_claims() {
  local cli id msg_id
  cli="$(queue_get_cli_path)"
  while IFS=$'\t' read -r id msg_id; do
    [[ "${id}" =~ ${QUEUE_ITEM_ID_SHAPE} && "${msg_id}" =~ ${QUEUE_UUID_SHAPE} ]] \
      || fail 1 "the monitor's pending reply carries a malformed item or msg id"
    printf 'item %s · msg %s — follow in order:\n' "${id}" "${msg_id}"
    printf '1. Fetch it: %s get %s — if the fetched session id is not yours, stop here.\n' "${cli}" "${id}"
    printf '2. Ack it: %s ack %s %s — act only when the reply is "first".\n' "${cli}" "${id}" "${msg_id}"
    printf '3. Act on the answer or message as the next step of your task.\n'
  done <<<"$1"
}

# One wait: the lock, then polls until a claim, a refusal, the bound or the owning Claude process ending.
wait_for_claims() {
  local bound_s session_id owner_pid owner_start body
  bound_s="$(get_wait_bound_s "$@")"
  session_id="$(require_session_id)"
  owner_pid="$(queue_get_pid)"
  [[ -n "${owner_pid}" ]] || fail 64 "CLAUDE_PID is unset or not a pid — run this inside a Claude Code session"
  owner_start="$(queue_get_start_time "${owner_pid}")"
  [[ -n "${owner_start}" ]] || fail 64 "CLAUDE_PID ${owner_pid} names no running process"
  WAIT_LOCK="$(queue_get_wait_lock_path "${session_id}")"
  WAIT_OWNER="${owner_pid}|${owner_start}"
  WAIT_RECORD="$$|$(queue_get_start_time "$$")|${WAIT_OWNER}"
  take_wait_lock
  trap drop_wait_lock EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  body="$(jq -nc --arg sessionId "${session_id}" --argjson pid "${owner_pid}" '{$sessionId, $pid, wait: true}')"
  run_wait_loop "${body}" "${bound_s}" "${owner_pid}" "${owner_start}"
}

# [--max-minutes N] → the bound in seconds; ATRIUM_QUEUE_WAIT_BOUND_S, a test seam, overrides it
get_wait_bound_s() {
  local minutes="${WAIT_MINUTES_DEFAULT}"
  if (($# > 0)); then
    if [[ "$1" != --max-minutes || $# -ne 2 || ! "$2" =~ ${WAIT_MINUTES_SHAPE} ]] || (($2 > WAIT_MINUTES_MAX)); then
      fail_usage "wait takes no argument but --max-minutes <1-${WAIT_MINUTES_MAX}>"
    fi
    minutes="$2"
  fi
  if [[ "${ATRIUM_QUEUE_WAIT_BOUND_S:-}" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' "${ATRIUM_QUEUE_WAIT_BOUND_S}"
  else
    printf '%s\n' "$((minutes * 60))"
  fi
}

# The lock is a symlink whose target is the holder record "waiter pid|its start|owner pid|its start". Every lock
# change but a holder's own create-if-absent runs under the waits mutex; a takeover renames a pre-built record onto the
# name in one step → the name is never empty mid-takeover, and only a holder ever removes its own record. A failed
# rename removes the private "<session>.take" name before it exits; a crash between building it and renaming it leaves
# it behind, unread, until the next takeover's ln -f replaces it.
take_wait_lock() {
  local state take="${WAIT_LOCK}.take"
  mkdir -p -- "${WAIT_LOCK%/*}" || fail 1 "cannot create the wait lock directory ${WAIT_LOCK%/*}"
  # shellcheck disable=SC2310  # a mutex held past its bound → the named exit
  take_waits_mutex || fail 1 "could not take this session's wait lock — the waits mutex stayed held"
  for _ in 1 2 3; do
    state="$(queue_get_wait_lock_state "${WAIT_LOCK}" "${WAIT_OWNER}" "${WAIT_RECORD}")"
    case "${state}" in
      mine) break ;;
      live) fail 5 "another wait already runs for this session — nothing to do" ;;
      stale)
        ln -sfn -- "${WAIT_RECORD}" "${take}" || fail 1 "cannot build the replacement wait lock record"
        if ! mv -f -- "${take}" "${WAIT_LOCK}"; then
          if ga_guard_path "${take}"; then rm -f -- "${take:?}"; fi
          fail 1 "cannot replace the stale wait lock ${WAIT_LOCK}"
        fi
        ;;
      *) ln -sn -- "${WAIT_RECORD}" "${WAIT_LOCK}" 2>/dev/null || continue ;;
    esac
  done
  drop_waits_mutex
  [[ "${state}" == mine ]] || fail 1 "could not take this session's wait lock"
}

# Removes the lock only while it holds this wait's record; any other record stays untouched, and a mutex held past its
# bound leaves this record behind as a dead one the next wait reclaims
drop_wait_lock() {
  local state
  # shellcheck disable=SC2310  # no mutex → the lock stays, reclaimable once this wait is gone
  take_waits_mutex || return 0
  state="$(queue_get_wait_lock_state "${WAIT_LOCK}" "${WAIT_OWNER}" "${WAIT_RECORD}")"
  if [[ "${state}" == mine ]]; then
    if ga_guard_path "${WAIT_LOCK}"; then rm -f -- "${WAIT_LOCK:?}"; fi
  fi
  drop_waits_mutex
}

# fd 9 → the waits mutex file, flocked through perl (stock macOS ships no flock(1)); the kernel releases it once fd 9
# closes or the process dies → a crash never leaves the mutex held
take_waits_mutex() {
  exec 9>>"${WAIT_LOCK%/*}.mutex" || return 1
  # shellcheck disable=SC2016  # a perl program, not a shell expansion
  if perl -MFcntl=:flock -e 'for (1 .. $ARGV[0]) { exit 0 if flock STDIN, LOCK_EX | LOCK_NB; select undef, undef, undef, 0.05 }
    exit 1' "${WAIT_MUTEX_TRIES}" <&9; then
    return 0
  fi
  exec 9>&-
  return 1
}

drop_waits_mutex() {
  exec 9>&-
}

# <body> <bound s> <owner pid> <owner start> → never returns; failures back off up to WAIT_BACKOFF_MAX_S
run_wait_loop() {
  local body="$1" deadline=$((SECONDS + $2)) poll_s="${WAIT_POLL_S}" delay outcome
  if [[ "${ATRIUM_QUEUE_WAIT_POLL_S:-}" =~ ^[1-9][0-9]*$ ]]; then poll_s="${ATRIUM_QUEUE_WAIT_POLL_S}"; fi
  delay="${poll_s}"
  while true; do
    check_wait_owner "$3" "$4"
    outcome=0
    # shellcheck disable=SC2310  # each outcome is branched on below
    poll_wait "${body}" || outcome=$?
    ((outcome != 0)) || exit 0
    delay=$((outcome != 1 ? poll_s : delay * 2 > WAIT_BACKOFF_MAX_S ? WAIT_BACKOFF_MAX_S : delay * 2))
    if ((SECONDS >= deadline)); then end_wait_at_bound "${outcome}"; fi
    sleep "$((delay < deadline - SECONDS ? delay : deadline - SECONDS))"
  done
}

# <owner pid> <owner start> → exits 4 silently once the owner is gone (nobody is left to read it), 5 once another record
# holds the lock; an empty lock name is no loss → this wait puts its record back
check_wait_owner() {
  local started state
  started="$(queue_get_start_time "$1")"
  [[ "${started}" == "$2" ]] || exit 4
  state="$(queue_get_wait_lock_state "${WAIT_LOCK}" "${WAIT_OWNER}" "${WAIT_RECORD}")"
  if [[ "${state}" == none ]] && ! ln -sn -- "${WAIT_RECORD}" "${WAIT_LOCK}" 2>/dev/null; then
    state="$(queue_get_wait_lock_state "${WAIT_LOCK}" "${WAIT_OWNER}" "${WAIT_RECORD}")"
  fi
  [[ "${state}" == mine || "${state}" == none ]] || fail 5 "another wait took over this session — this one ends"
}

# <body> → 0 claimed and printed · 1 no reply or a 5xx · 3 nothing claimed; a refusal exits 2
poll_wait() {
  local reply body claims
  # shellcheck disable=SC2310  # no reply → the backoff outcome
  reply="$(queue_send POST /api/queue/pending "$1" "${CLI_MAX_TIME_S}")" || return 1
  # shellcheck disable=SC2310  # a 5xx → the backoff outcome
  check_reply_status /api/queue/pending "${reply}" || return 1
  body="$(queue_get_reply_body "${reply}")"
  # shellcheck disable=SC2310  # a malformed reply → the named exit
  claims="$(get_claims "${body}")" || fail 1 "the monitor's pending reply is malformed"
  [[ -n "${claims}" ]] || return 3
  print_claims "${claims}"
}

end_wait_at_bound() {
  if (($1 == 1)); then fail 1 "no reply from the monitor by the wait's bound — start the wait again once"; fi
  printf 'nothing arrived for this session within the bound — start the wait again\n'
  exit 4
}

register_session() {
  local name="" count cli pid session_id
  if (($# > 0)); then
    [[ "$1" == --name && $# -eq 2 ]] || fail_usage "register takes no argument but --name <name>"
    name="$(queue_get_shown_name "$2")"
    [[ -n "${name}" ]] || fail 64 "--name must hold a visible character"
  fi
  session_id="$(require_session_id)"
  pid="$(queue_get_pid)"
  [[ -n "${pid}" ]] || fail 64 "CLAUDE_PID is unset or not a pid — run this inside a Claude Code session"
  # shellcheck disable=SC2310  # a failed register → the named exit below
  count="$(queue_register_session "" "${CLI_MAX_TIME_S}" "" "" "${name}")" \
    || fail 1 "register failed (monitor down, slow or refusing)"
  printf 'registered this session with the Atrium queue\n'
  if ((count > 0)); then
    cli="$(queue_get_cli_path)"
    printf '%s owner queue answer(s) or message(s) wait for this session — fetch them with: %s pending\n' "${count}" "${cli}"
  fi
  print_wait_step "${session_id}"
}

main "$@"
