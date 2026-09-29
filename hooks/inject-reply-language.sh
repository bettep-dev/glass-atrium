#!/usr/bin/env bash
# inject-reply-language.sh — quotes the user's latest own message so the model judges the reply language.
# Every emitted line is a fixed template plus that quote, never a language value.
# Never blocks: exit 2 from either prompt event erases the prompt, so every path ends in exit 0.
set -Eeuo pipefail
IFS=$'\n\t'
# Fail open: an errexit abort, a set -u miss or a resolver fault all leave through this trap.
trap 'exit 0' EXIT

# Model-facing wording, audited as one unit; each quote %s is a JSON string of the user's own words.
readonly MACHINE_POINTER="The newest user-role message, %s, holds no prose of the user's own; the user's latest own message begins %s. Reply to the user in that message's language unless the user asked for a different reply language."
readonly COMMAND_POINTER="The newest user-role message is a slash command whose own text begins %s. Reply to the user in that text's language unless the user asked for a different reply language."
readonly SESSION_POINTER="[REPLY LANGUAGE] The user's latest own message begins %s. Reply to the user in that message's language unless the user asked for a different reply language."
readonly EXCERPT_CHARS=200
readonly HEAD_CHARS=80
# `claude -p` runs (daemon cycles, wiki dedup) report sdk-cli even when a cli parent exported this.
readonly INTERACTIVE_ENTRYPOINT="cli"
# C0 and C1 controls become spaces; bidi and zero-width controls are dropped.
readonly CLEAN_DEF='def clean: tostring | explode
  | map(select((. == 1564 or (. >= 8203 and . <= 8207) or (. >= 8234 and . <= 8238)
      or (. >= 8288 and . <= 8292) or (. >= 8294 and . <= 8297) or . == 65279) | not)
    | if . < 32 or (. >= 127 and . < 160) then 32 else . end)
  | implode | gsub("\\s+"; " ") | sub("^ "; "") | sub(" $"; "");'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly RESOLVER="${SCRIPT_DIR}/lib/reply_language.py"

main() {
  local input fields event source transcript head
  input="$(cat)"
  [[ "${CLAUDE_CODE_ENTRYPOINT:-}" == "${INTERACTIVE_ENTRYPOINT}" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  fields="$(jq -r --argjson head "${HEAD_CHARS}" "${CLEAN_DEF}"'
    [.hook_event_name, .source, .transcript_path, (.prompt // "" | clean | .[0:$head])]
    | map(. // "" | tostring) | join("\u001f")' <<<"${input}" 2>/dev/null)" || return 0
  IFS=$'\x1f' read -r event source transcript head <<<"${fields}" || return 0
  case "${event}" in
    UserPromptSubmit) point_at_machine_prompt "${source}" "${head}" "${transcript}" ;;
    UserPromptExpansion) point_at_command "${input}" "${transcript}" ;;
    SessionStart) point_at_resumed_session "${source}" "${transcript}" ;;
    *) ;;
  esac
}

# Args: $1=envelope source $2=cleaned prompt head $3=transcript path
point_at_machine_prompt() {
  local kind quote context
  kind="$(get_prompt_kind "${1}" "${2}")"
  [[ -n "${kind}" ]] || return 0 # an ordinary human prompt ends here, before python3 or any transcript read
  quote="$(get_newest_quote "${3}")"
  [[ -n "${quote}" ]] || return 0
  # shellcheck disable=SC2059  # the format is the constant above, never input
  printf -v context "${MACHINE_POINTER}" "${kind}" "${quote}"
  emit_context UserPromptSubmit "${context}"
}

# The typed command is quoted here, so UserPromptSubmit never sniffs a leading slash: `/Users/...` shares it.
# Args: $1=envelope $2=transcript path
point_at_command() {
  local found entry prose quote context
  found="$(jq -j '.command_args // "" | tostring' <<<"${1}" | find_newest_prose --pending "${2}")"
  entry="$(jq -r 'select(.status == "found") | .entry' <<<"${found}")"
  prose="$(jq -r 'select(.status == "found") | .prose' <<<"${found}")"
  quote="$(get_quote "${prose}")"
  [[ -n "${quote}" ]] || return 0
  if [[ "${entry}" == pending ]]; then
    # shellcheck disable=SC2059  # the format is the constant above, never input
    printf -v context "${COMMAND_POINTER}" "${quote}"
  else
    # shellcheck disable=SC2059  # the format is the constant above, never input
    printf -v context "${MACHINE_POINTER}" 'a slash command' "${quote}"
  fi
  emit_context UserPromptExpansion "${context}"
}

# Run by inject-session-context.sh, whose stdout is the session context, so the line is printed bare.
# Args: $1=SessionStart source $2=transcript path
point_at_resumed_session() {
  local quote context
  case "${1}" in
    resume | compact | fork) ;;
    *) return 0 ;;
  esac
  quote="$(get_newest_quote "${2}")"
  [[ -n "${quote}" ]] || return 0
  # shellcheck disable=SC2059  # the format is the constant above, never input
  printf -v context "${SESSION_POINTER}" "${quote}"
  printf '%s\n' "${context}"
}

# stdout: the kind of a machine-written prompt; empty for the user's own prompt or an agent frame.
# Agent frames: the envelope has no agent_id and names the parent transcript, so the frame is the only signal.
# Scheduled-task fires and /loop wakeups replay stored text with no frame, so only `source` can name them.
get_prompt_kind() {
  case "${2}" in
    '<teammate-message'* | '[Workflow harness'* | 'The coordinator sent a message'*) return 0 ;;
    *) ;;
  esac
  if [[ -n "${1}" && "${1}" != user ]]; then
    printf 'a machine-written message'
    return 0
  fi
  case "${2}" in
    '<task-notification>'* | 'Background agent "'* | [0-9]*' background agents were stopped'*)
      printf 'a task notification'
      ;;
    '<cross-session-message'* | 'Another Claude session sent a message'*)
      printf 'a message from another Claude session'
      ;;
    '[Cross-session idle notice]'*) printf 'a cross-session idle notice' ;;
    '<channel '*) printf 'a channel message' ;;
    'This session is being continued from a previous conversation'*) printf 'a compaction summary' ;;
    'Stop hook feedback:'*) printf 'hook feedback' ;;
    *) ;;
  esac
}

# stdout: the quoted start of the transcript's newest human message with prose, empty when none is found.
get_newest_quote() {
  local prose
  [[ -n "${1}" ]] || return 0
  prose="$(find_newest_prose "${1}" | jq -r 'select(.status == "found") | .prose')"
  get_quote "${prose}"
}

# stdout: the resolver's JSON for the newest human message with prose; empty without python3 or the resolver.
# Args: resolver `transcript` options and path
find_newest_prose() {
  command -v python3 >/dev/null 2>&1 || return 0
  [[ -f "${RESOLVER}" ]] || return 0
  python3 "${RESOLVER}" transcript "$@"
}

# stdout: $1 cleaned, capped and JSON-quoted; empty when nothing is left.
get_quote() {
  jq -rn --arg text "${1}" --argjson cap "${EXCERPT_CHARS}" \
    "${CLEAN_DEF}"' $text | clean | .[0:$cap] | select(. != "") | tojson'
}

# Args: $1=hook event $2=context line
emit_context() {
  jq -cn --arg event "${1}" --arg context "${2}" \
    '{hookSpecificOutput: {hookEventName: $event, additionalContext: $context}}'
}

main "$@"
