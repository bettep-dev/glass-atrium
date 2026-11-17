#!/usr/bin/env bash
# atrium-queue.sh — the owner queue CLI a Claude Code session runs: post a report or a decision, fetch an
# item, pull or wait for this session's owner answers and messages, ack a delivery, withdraw an item, and register
# this session. Run it by its absolute installed path with nothing in front — the one literal every printed step names.
# Exit codes: 0 done · 1 monitor unreachable, failing or replying malformed · 2 refused by the
#   monitor · 3 the fetched item names another session (stop, take no action) · 4 the wait's bound passed with
#   nothing claimed, or its owning Claude process is gone · 5 another wait holds this session · 64 usage or local validation
# The harness-only listen step exits 2 only to wake its session (the count line on stderr) and 0 on every other end:
#   an asyncRewake hook's other non-zero exits read as hook errors

set -Eeuo pipefail
IFS=$'\n\t'

self="${BASH_SOURCE[0]}"
if [[ -L "${self}" ]]; then
  self="$(readlink -f -- "${self}")"
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${self}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source-path=SCRIPTDIR source=lib/queue-ops.sh
source "${SCRIPT_DIR}/lib/queue-ops.sh"

# the monitor's route bodyLimit
readonly ITEM_MAX_BYTES=196608
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
# test seam shapes (get_seam_s): a whole positive number of seconds, or one that may be 0
readonly SEAM_POSITIVE_SHAPE='^[1-9][0-9]*$'
readonly SEAM_WHOLE_SHAPE='^[0-9]+$'
# inside the longest measured asyncRewake run (scoped/shared-hook-capability-contract.md → 1c) and one hour under the
# binding timeout (lib/ga-env.sh → EXPECTED_HOOK_BINDING_OPTIONS) → the host's SIGTERM never ends a listener before its
# re-arm wake
readonly LISTEN_LIFETIME_S=82800
# the same answered set to the same Claude process: the wake, then one re-announce for a wake folded into a busy turn;
# QUEUE_NUDGE_INTERVAL_MIN since the last announce opens the next interval of LISTEN_ANNOUNCE_MAX, at most
# LISTEN_INTERVAL_RESETS_MAX times per set → an unclaimed set wakes a session a bounded number of times, never every
# interval; a changed set, a claim or a count read back at 0 starts the whole bound over (queue_delete_announce_record), and the
# lifetime end's re-arm names the count again regardless
readonly LISTEN_ANNOUNCE_MAX=2
readonly LISTEN_INTERVAL_RESETS_MAX=3
# a session's register runs beside the listener at its start → a refusal this early may be the register not yet landed
readonly LISTEN_REFUSAL_GRACE_S=30
readonly LISTEN_WAKE_LEAD='[ATRIUM-QUEUE] harness: this is the owner-queue wake, not an error —'
readonly LISTEN_REARM_LINE='the listener re-arms and nothing arrived for this session: end the turn with no other action'
# set by listen_for_answers: every end but the wake exits 0
is_listening=false
listen_child=""
listen_count=0
listen_set=""
LISTEN_OUT=""
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
    listen) listen_for_answers "$@" ;;
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
Usage — run by this absolute path, no interpreter or env prefix in front:
  ${cli} report <item.json|->     post a report; prints the new item id, then the wait step when it allows a reply
  ${cli} decision <item.json|->   post a decision; prints the new item id, then the wait step
  ${cli} get <item-id>            fetch one of this session's items, answer included; an owner answer or message
                                  comes after one provenance line, the first line, outside the JSON — built from the
                                  item's kind and approval flag, never from its text
  ${cli} pending                  claim this session's owner answers and messages; prints each one's fetch and ack steps,
                                  then the wait step
  ${cli} wait [--max-minutes N]   run as a background command: blocks until a poll claims this session's answers or
                                  messages, then prints the same steps; bound ${WAIT_MINUTES_DEFAULT} minutes by default, at most ${WAIT_MINUTES_MAX}
  ${cli} listen                   the harness listener's own step (hooks/queue-listener.sh) — never run it yourself
  ${cli} ack <item-id> <msg-id>   ack a delivery; act on the answer or message only when it prints "first"
  ${cli} withdraw <item-id>       withdraw an item this session posted, not in delivery (never an owner message)
  ${cli} register [--name <name>] register this session (a resumed session runs it after its ack steps);
                                  run it from the session's start directory: the monitor resumes from it;
                                  --name labels this session on the Queue page (only a later --name replaces it);
                                  prints the wait step last
The wait step: start a background wait, or start none — a wait of this session already runs, or its listener announces for it.
  ${cli} help
Item JSON: title, body, isFreeTextAllowed, optional linkedDocIds; a decision adds options
  [{code R1-R9, label, pros, cons}] (2 to 9), recommendedCode and optional isApprovalClass.
The session id comes from CLAUDE_CODE_SESSION_ID — never pass it.
Exit codes: 0 done · 1 monitor unreachable or failing · 2 refused by the monitor · 3 item of another session · 64 usage
On a wait's exit: 0 follow the printed steps, then wait again · 1 wait again once · 2 after an unknown-session
  refusal run register and wait again, otherwise stop waiting · 4 wait again · 5 nothing, another wait runs ·
  any other code wait again once
USAGE
}

fail_usage() {
  if [[ -n "${1:-}" ]]; then printf 'atrium-queue: %s\n' "$1" >&2; fi
  print_usage >&2
  exit 64
}

fail() {
  printf 'atrium-queue: %s\n' "$2" >&2
  end_run "$1"
}

# <exit code> → exits with it; the listener exits 0 instead, or 1 inside a $( ) so its caller still sees the failure
end_run() {
  if [[ "${is_listening}" == true ]]; then
    if ((BASH_SUBSHELL > 0)); then exit 1; fi
    exit 0
  fi
  exit "$1"
}

warn() {
  printf 'atrium-queue: %s\n' "$1" >&2
}

# <operation> <args…> → its result document; a failed operation ends the run with its message and exit code
get_result() {
  local result status=0
  result="$("$@")" || status=$?
  if ((status != 0)); then fail_with "${status}" "${result}"; fi
  printf '%s\n' "${result}"
}

# <exit code> <error document> → fail with the document's message
fail_with() {
  local message
  message="$(jq -r '.message | strings' <<<"$2" 2>/dev/null)" || message=""
  fail "$1" "${message:-the queue operation failed}"
}

post_item() {
  local kind="$1" source="${2:-}" raw result id next
  [[ -n "${source}" && $# -eq 2 ]] || fail_usage "${kind} takes one item file, or - for stdin"
  get_result queue_require_session_id >/dev/null
  raw="$(read_item "${source}")"
  check_item "${kind}" "${raw}"
  result="$(get_result queue_create_item "${kind}" "${raw}")"
  # callers read the id from this first line → its form stays fixed
  id="$(jq -r '.id' <<<"${result}")"
  printf 'posted %s item %s\n' "${kind}" "${id}"
  next="$(jq -r '.next | strings' <<<"${result}")"
  if [[ -n "${next}" ]]; then printf 'next: %s\n' "${next}"; fi
}

# <session id> → one line naming this session's next queue step (queue_get_wait_step)
print_wait_step() {
  local step
  step="$(queue_get_wait_step "$1")"
  printf 'next: %s\n' "${step}"
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
check_item() {
  local kind="$1" problems
  problems="$(jq -r --arg kind "${kind}" --argjson fields "${QUEUE_ITEM_FIELDS}" "${ITEM_PROBLEMS_JQ}" <<<"$2" 2>/dev/null)" \
    || fail 64 "the ${kind} item is not valid JSON"
  if [[ -n "${problems}" ]]; then
    printf 'atrium-queue: invalid %s item — %s\n' "${kind}" "${problems//$'\n'/; }" >&2
    exit 64
  fi
}

get_item() {
  local result
  result="$(get_result queue_get_item "${1:-}")"
  jq -r '.provenance | strings' <<<"${result}"
  jq '.item' <<<"${result}" | queue_escape_json
  print_images "${result}"
}

# <fetch result> → the image files the library listed, then a count of the paths it would not name
print_images() {
  local count hidden
  count="$(jq -r '.images | length' <<<"$1")"
  hidden="$(jq -r '.hiddenImageCount' <<<"$1")"
  if ((count > 0)); then
    printf 'Attached images (%s) — local files; read each one before acting.\n' "${count}"
    jq -r '.images[]' <<<"$1"
  fi
  if ((hidden > 0)); then
    printf "Images not shown (%s) — the monitor named no file of this install's queue image folder.\n" "${hidden}"
  fi
}

ack_delivery() {
  local result
  result="$(get_result queue_create_ack "${1:-}" "${2:-}")"
  result="$(jq -r '.result' <<<"${result}")"
  if [[ "${result}" == first ]]; then printf 'first\n'; else printf 'already handled\n'; fi
}

withdraw_item() {
  local id="${1:-}" session_id body
  get_result queue_check_item_id "${id}" >/dev/null
  session_id="$(get_result queue_require_session_id)"
  body="$(jq -nc --arg sessionId "${session_id}" '{$sessionId}')"
  get_result queue_call_monitor POST "/api/queue/items/${id}/withdraw" "${body}" >/dev/null
  printf 'withdrew item %s\n' "${id}"
  queue_delete_awaiting_mark "${session_id}" "${id}"
}

pull_pending() {
  local result claims next
  result="$(get_result queue_pull_pending)"
  claims="$(jq -c '.claims' <<<"${result}")"
  if [[ "${claims}" == '[]' ]]; then
    printf 'no owner answer or message waits for this session\n'
  else
    print_claims "${claims}"
  fi
  next="$(jq -r '.next' <<<"${result}")"
  printf 'next: %s\n' "${next}"
}

# <claims JSON array, ids shape-checked by the library> → the fetch and ack steps per claim
print_claims() {
  local cli id msg_id rows
  cli="$(queue_get_cli_path)"
  rows="$(jq -r '.[] | "\(.item)\t\(.msg)"' <<<"$1")"
  while IFS=$'\t' read -r id msg_id; do
    printf 'item %s · msg %s — follow in order:\n' "${id}" "${msg_id}"
    printf '1. Fetch it: %s get %s — if the fetched session id is not yours, stop here.\n' "${cli}" "${id}"
    printf '2. Ack it: %s ack %s %s — act only when the reply is "first".\n' "${cli}" "${id}" "${msg_id}"
    printf '3. Act on the answer or message as the next step of your task.\n'
  done <<<"${rows}"
}

# One wait: the lock, then polls until a claim, a refusal, the bound or the owning Claude process ending.
wait_for_claims() {
  local bound_s session_id body
  bound_s="$(get_wait_bound_s "$@")"
  session_id="$(get_result queue_require_session_id)"
  set_wait_holder "${session_id}" ""
  take_wait_lock
  trap drop_wait_lock EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  body="$(jq -nc --arg sessionId "${session_id}" --argjson pid "${WAIT_OWNER%%|*}" '{$sessionId, $pid, wait: true}')"
  run_wait_loop "${body}" "${bound_s}" "${WAIT_OWNER%%|*}" "${WAIT_OWNER#*|}"
}

# <session id> <holder kind, empty for a session-run wait> → WAIT_LOCK, WAIT_OWNER and WAIT_RECORD for this process
set_wait_holder() {
  local owner_pid owner_start
  owner_pid="$(queue_get_pid)"
  [[ -n "${owner_pid}" ]] || fail 64 "CLAUDE_PID is unset or not a pid — run this inside a Claude Code session"
  owner_start="$(queue_get_start_time "${owner_pid}")"
  [[ -n "${owner_start}" ]] || fail 64 "CLAUDE_PID ${owner_pid} names no running process"
  WAIT_LOCK="$(queue_get_wait_lock_path "$1")"
  WAIT_OWNER="${owner_pid}|${owner_start}"
  WAIT_RECORD="$$|$(queue_get_start_time "$$")|${WAIT_OWNER}${2:+|$2}"
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
  get_seam_s "${ATRIUM_QUEUE_WAIT_BOUND_S:-}" "$((minutes * 60))" "${SEAM_POSITIVE_SHAPE}"
}

# The lock is a symlink whose target is the holder record "waiter pid|its start|owner pid|its start", plus "|listen" for
# the harness listener; a wait or a newer listener takes over a listener of its own process like a dead record. Every lock
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
      stale | listener)
        ln -sfn -- "${WAIT_RECORD}" "${take}" || fail 1 "cannot build the replacement wait lock record"
        if ! mv -f -- "${take}" "${WAIT_LOCK}"; then
          # shellcheck disable=SC2310  # a refused path skips the delete
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
    # shellcheck disable=SC2310  # a refused path skips the delete
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

# <body> <bound s> <owner pid> <owner start> → never returns; failures back off up to WAIT_BACKOFF_MAX_S;
# ATRIUM_QUEUE_WAIT_POLL_S, a test seam, overrides the poll
run_wait_loop() {
  local body="$1" deadline=$((SECONDS + $2)) poll_s delay outcome
  poll_s="$(get_seam_s "${ATRIUM_QUEUE_WAIT_POLL_S:-}" "${WAIT_POLL_S}" "${SEAM_POSITIVE_SHAPE}")"
  delay="${poll_s}"
  while true; do
    check_wait_owner "$3" "$4"
    outcome=0
    # shellcheck disable=SC2310  # each outcome is branched on below
    poll_wait "${body}" || outcome=$?
    ((outcome != 0)) || exit 0
    if ((outcome == 1)); then delay="$(get_backoff_s "${delay}")"; else delay="${poll_s}"; fi
    if ((SECONDS >= deadline)); then end_wait_at_bound "${outcome}"; fi
    sleep "$((delay < deadline - SECONDS ? delay : deadline - SECONDS))"
  done
}

# <owner pid> <owner start> → exits 4 silently once the owner is gone (nobody is left to read it), 5 once another record
# holds the lock; an empty lock name is no loss → this wait puts its record back
check_wait_owner() {
  local started state
  started="$(queue_get_start_time "$1")"
  [[ "${started}" == "$2" ]] || end_run 4
  state="$(queue_get_wait_lock_state "${WAIT_LOCK}" "${WAIT_OWNER}" "${WAIT_RECORD}")"
  if [[ "${state}" == none ]] && ! ln -sn -- "${WAIT_RECORD}" "${WAIT_LOCK}" 2>/dev/null; then
    state="$(queue_get_wait_lock_state "${WAIT_LOCK}" "${WAIT_OWNER}" "${WAIT_RECORD}")"
  fi
  if [[ "${state}" == mine || "${state}" == none ]]; then return 0; fi
  # a listener taken over ends silently: the newer holder listens on
  [[ "${is_listening}" == false ]] || end_run 5
  fail 5 "another wait took over this session — this one ends"
}

# <body> → 0 claimed and printed · 1 no reply or a 5xx · 3 nothing claimed; a refusal exits 2
poll_wait() {
  local body status=0 claims session_id
  # shellcheck disable=SC2310  # each outcome is branched on below
  body="$(queue_call_monitor POST /api/queue/pending "$1")" || status=$?
  if ((status == 2)); then fail_with 2 "${body}"; fi
  ((status == 0)) || return 1
  # shellcheck disable=SC2310  # a malformed reply → the named exit
  claims="$(queue_get_claims "${body}")" || fail 1 "the monitor's pending reply is malformed"
  [[ "${claims}" != '[]' ]] || return 3
  print_claims "${claims}"
  session_id="$(queue_get_session_id)"
  queue_delete_announce_record "${session_id}"
}

# <last poll outcome> → exits 1 on no reply, else 4 with the step by what polls once this wait ends (queue_get_poller):
# its own lock goes first, since the reader counts this wait's record as a running wait
end_wait_at_bound() {
  local session_id poller
  if (($1 == 1)); then fail 1 "no reply from the monitor by the wait's bound — start the wait again once"; fi
  drop_wait_lock
  session_id="$(queue_get_session_id)"
  poller="$(queue_get_poller "${session_id}")"
  if [[ "${poller}" == listener ]]; then
    printf "nothing arrived for this session within the bound — start no wait: this session's listener takes over at"
    printf " the turn's end\n"
  else
    printf 'nothing arrived for this session within the bound — start the wait again\n'
  fi
  exit 4
}

# The harness listener (hooks/queue-listener.sh execs this step): holds the session's wait lock as a listener and polls
# the session's answered count, claiming nothing, until a wake, a takeover or its owner's end; at its lifetime end it
# wakes the session once to re-arm, and that turn's Stop starts a fresh listener. No reply or a 5xx backs off as the
# wait does and polls on → a monitor restart never ends it. A signal, a takeover, a refusal and an unreadable reply each
# exit 0 before the lifetime end is reached → none of them is ever followed by a re-arm.
listen_for_answers() {
  local session_id body
  is_listening=true
  trap 'end_run 1' ERR
  (($# == 0)) || fail 64 "listen takes no argument"
  session_id="$(get_result queue_require_session_id)"
  set_wait_holder "${session_id}" "${QUEUE_LISTENER_KIND}"
  take_wait_lock
  # shellcheck disable=SC2310  # an unwritten mark only leaves the turn-end check nudging a wait, its fallback
  queue_put_listening_mark "${session_id}" "${WAIT_OWNER}" 2>/dev/null || warn "no listening mark could be written"
  trap stop_listening EXIT
  trap 'exit 0' HUP INT TERM
  LISTEN_OUT="$(mktemp)" || fail 1 "no scratch file for the listener's polls"
  body="$(jq -nc --arg sessionId "${session_id}" --argjson pid "${WAIT_OWNER%%|*}" '{$sessionId, $pid}')"
  run_listen_loop "${session_id}" "${body}"
}

# <session id> <count body> → polls at the wait's interval until LISTEN_LIFETIME_S; ATRIUM_QUEUE_WAIT_POLL_S,
# ATRIUM_QUEUE_LISTEN_LIFETIME_S and ATRIUM_QUEUE_LISTEN_GRACE_S, test seams, override the three
run_listen_loop() {
  local started="${SECONDS}" poll_s lifetime_s grace_s delay
  poll_s="$(get_seam_s "${ATRIUM_QUEUE_WAIT_POLL_S:-}" "${WAIT_POLL_S}" "${SEAM_POSITIVE_SHAPE}")"
  lifetime_s="$(get_seam_s "${ATRIUM_QUEUE_LISTEN_LIFETIME_S:-}" "${LISTEN_LIFETIME_S}" "${SEAM_POSITIVE_SHAPE}")"
  grace_s="$(get_seam_s "${ATRIUM_QUEUE_LISTEN_GRACE_S:-}" "${LISTEN_REFUSAL_GRACE_S}" "${SEAM_WHOLE_SHAPE}")"
  delay="${poll_s}"
  while ((SECONDS - started < lifetime_s)); do
    check_wait_owner "${WAIT_OWNER%%|*}" "${WAIT_OWNER#*|}"
    # shellcheck disable=SC2310  # no reply or a 5xx → the backoff, the announce state left as it was
    if set_listen_count "$2" "$((SECONDS - started < grace_s))"; then
      delay="${poll_s}"
      if ((listen_count > 0)); then announce_if_due "$1" "${listen_count}" "${listen_set}"; else queue_delete_announce_record "$1"; fi
    else
      delay="$(get_backoff_s "${delay}")"
    fi
    run_child sleep "${delay}"
  done
  check_wait_owner "${WAIT_OWNER%%|*}" "${WAIT_OWNER#*|}"
  announce_if_due "$1" "${listen_count}" "${listen_set}" rearm
}

# <delay s> → the next delay after a failed poll: doubled, capped at WAIT_BACKOFF_MAX_S
get_backoff_s() {
  printf '%s\n' "$(($1 * 2 > WAIT_BACKOFF_MAX_S ? WAIT_BACKOFF_MAX_S : $1 * 2))"
}

# <value> <default> <shape> → the value when it matches the shape, else the default
get_seam_s() {
  if [[ "$1" =~ $3 ]]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi
}

# <command…> → runs it as this shell's waited child, its stdout into LISTEN_OUT → a signal ends it with the listener
run_child() {
  local status=0
  "$@" >"${LISTEN_OUT}" &
  listen_child=$!
  wait "${listen_child}" || status=$?
  listen_child=""
  return "${status}"
}

# <count body> <1 while a refusal may be the register not yet landed> → listen_count and listen_set (0 for such a
# refusal); 1 on no reply or a 5xx, both left as the last count read → the lifetime end's re-arm still names it; any
# other refusal or an unreadable reply ends the listener with one stderr line
set_listen_count() {
  local route=/api/queue/pending/count reply code body status
  # shellcheck disable=SC2310  # no reply → the backoff outcome
  run_child queue_send POST "${route}" "$1" "${QUEUE_OPS_MAX_TIME_S}" || return 1
  reply="$(<"${LISTEN_OUT}")"
  code="$(queue_get_reply_code "${reply}")"
  if [[ "${code}" == 404 || "${code}" == 409 ]] && (($2 == 1)); then
    listen_count=0
    listen_set=""
    return 0
  fi
  status=0
  # shellcheck disable=SC2310  # inside the || the listener's inherited ERR trap stays off → the refusal's own status reaches the branch below
  body="$(queue_get_reply_result "${route}" "${reply}" || exit "$?")" || status=$?
  if ((status == 2)); then fail_with 2 "${body}"; fi
  ((status == 0)) || return 1
  set_listen_answered "${body}"
}

# <count reply body> → listen_count and listen_set "<count>:<ids, comma-separated>", the set the announce bound keys
# on; a monitor that sends no ids leaves the set keyed on the count alone
set_listen_answered() {
  local answered
  answered="$(jq -r '"\(.answeredWaiting | numbers):\(.answeredItemIds // [] | map(numbers | tostring) | join(","))"' \
    <<<"$1" 2>/dev/null)" || answered=""
  [[ "${answered}" =~ ^[0-9]+:([0-9]+(,[0-9]+)*)?$ ]] || fail 1 "the monitor's count reply is malformed"
  listen_count="${answered%%:*}"
  listen_set="${answered}"
}

# <session id> <count> <answered set> [rearm] → wakes the session (exit 2) unless this Claude process was told this set
# LISTEN_ANNOUNCE_MAX times within QUEUE_NUDGE_INTERVAL_MIN, or its intervals are spent; a re-arm wakes regardless, with
# the re-arm line at count 0. The owner check, the announce record and the lock's release share one hold of the waits
# mutex → a listener another took over never wakes
announce_if_due() {
  local record announced told resets state
  # shellcheck disable=SC2310  # a mutex held past its bound → no wake this round
  take_waits_mutex || return 0
  state="$(queue_get_wait_lock_state "${WAIT_LOCK}" "${WAIT_OWNER}" "${WAIT_RECORD}")"
  [[ "${state}" == mine ]] || end_run 5
  record="$(queue_get_announce_record_path "$1")"
  announced="$(get_announce_count "${record}" "$3")"
  IFS=' ' read -r told resets <<<"${announced}"
  if ((told >= LISTEN_ANNOUNCE_MAX || resets > LISTEN_INTERVAL_RESETS_MAX)) && [[ "${4:-}" != rearm ]]; then
    drop_waits_mutex
    return 0
  fi
  if (($2 > 0 && told < LISTEN_ANNOUNCE_MAX && resets <= LISTEN_INTERVAL_RESETS_MAX)); then
    put_announce_record "${record}" "$3" "$((told + 1))" "${resets}"
  fi
  # shellcheck disable=SC2310  # a refused path skips the delete
  if ga_guard_path "${WAIT_LOCK}"; then rm -f -- "${WAIT_LOCK:?}"; fi
  drop_waits_mutex
  print_wake "$2"
  exit 2
}

# <announce record> <answered set> <times told> <interval resets> → the record lands before the wake → a failed write
# never turns into an unbounded one
put_announce_record() {
  if ! (mkdir -p -- "${1%/*}" && printf '%s %s %s %s\n' "$2" "$3" "$4" "${WAIT_OWNER}" >"$1") 2>/dev/null; then
    fail 1 "no announce record could be written at $1"
  fi
}

# <announce record> <answered set> → "<times told> <interval resets>": how often this Claude process was told this set
# in the current interval and how many intervals reset it; "0 0" for another set or process or an unreadable record,
# and once QUEUE_NUDGE_INTERVAL_MIN has passed since the last announce the next interval, "0 <resets + 1>"
get_announce_count() {
  local set="" times="" resets="" owner=""
  if [[ -f "$1" ]]; then IFS=' ' read -r set times resets owner <"$1" || true; fi
  # shellcheck disable=SC2310  # a record whose age it cannot read counts as old → the next interval
  if ! [[ "${set}" == "$2" && "${owner}" == "${WAIT_OWNER}" && "${times}" =~ ^[0-9]+$ && "${resets}" =~ ^[0-9]+$ ]]; then
    printf '0 0\n'
  elif queue_is_touched_within_nudge "$1"; then
    printf '%s %s\n' "${times}" "${resets}"
  else
    printf '0 %s\n' "$((resets + 1))"
  fi
}

# <count> → the wake line: the count and the pending command, or the re-arm line at 0; subshell write → no interrupt
# from an un-waited child reaches it, and the exit comes from the caller's code path
print_wake() {
  local cli line
  if (($1 == 0)); then
    line="${LISTEN_WAKE_LEAD} ${LISTEN_REARM_LINE}"
  else
    cli="$(queue_get_cli_path)"
    printf -v line '%s %s owner queue answer(s) or message(s) wait for this session — fetch them with: %s pending' \
      "${LISTEN_WAKE_LEAD}" "$1" "${cli}"
  fi
  (printf '%s\n' "${line}") >&2 || true
}

# EXIT trap of the listener: its poll child, its lock record and its scratch file go
stop_listening() {
  if [[ -n "${listen_child}" ]]; then
    pkill -P "${listen_child}" 2>/dev/null || true
    kill "${listen_child}" 2>/dev/null || true
  fi
  drop_wait_lock
  # shellcheck disable=SC2310  # a refused path skips the delete
  if ga_guard_path "${LISTEN_OUT}"; then rm -f -- "${LISTEN_OUT:?}"; fi
}

register_session() {
  local name="" count cli pid session_id
  if (($# > 0)); then
    [[ "$1" == --name && $# -eq 2 ]] || fail_usage "register takes no argument but --name <name>"
    name="$(queue_get_shown_name "$2")"
    [[ -n "${name}" ]] || fail 64 "--name must hold a visible character"
  fi
  session_id="$(get_result queue_require_session_id)"
  pid="$(queue_get_pid)"
  [[ -n "${pid}" ]] || fail 64 "CLAUDE_PID is unset or not a pid — run this inside a Claude Code session"
  # shellcheck disable=SC2310  # a failed register → the named exit below
  count="$(queue_register_session "" "${QUEUE_OPS_MAX_TIME_S}" "" "" "${name}")" \
    || fail 1 "register failed (monitor down, slow or refusing)"
  printf 'registered this session with the Atrium queue\n'
  if ((count > 0)); then
    cli="$(queue_get_cli_path)"
    printf '%s owner queue answer(s) or message(s) wait for this session — fetch them with: %s pending\n' "${count}" "${cli}"
  fi
  print_wait_step "${session_id}"
}

main "$@"
