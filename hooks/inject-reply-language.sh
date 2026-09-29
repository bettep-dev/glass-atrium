#!/usr/bin/env bash
# inject-reply-language.sh — quotes the user's latest own message so the model judges the reply language;
# every line is a fixed template plus that quote, never a language value.
# UserPromptSubmit: only a machine-written prompt (non-user `source`, else a wrapper prefix) gets the line,
# and an ordinary human prompt returns before python3 or any transcript read.
# UserPromptExpansion: a user-typed slash command quotes its own arguments, so the `/name args` prompt that
# follows on UserPromptSubmit needs no leading-slash sniffing — a `/Users/...` prompt has the same shape.
# Agent frames stay silent: the envelope carries no agent_id and points at the parent transcript, so the
# prompt's own frame is the only signal — structural, not a guarantee.
# Never blocks: exit 2 from either prompt event erases the prompt, so every path ends in exit 0.
set -Eeuo pipefail
IFS=$'\n\t'
# Fail open: an errexit abort, a set -u miss or a resolver fault all leave through this trap.
trap 'exit 0' EXIT

# Model-facing wording, audited as one unit; each quote %s is a JSON string of the user's own words.
readonly MACHINE_POINTER="The newest user-role message, %s, holds no prose of the user's own; the user's latest own message begins %s. Reply to the user in that message's language unless the user asked for a different reply language."
readonly COMMAND_POINTER="The newest user-role message is a slash command whose own text begins %s. Reply to the user in that text's language unless the user asked for a different reply language."
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
  local input fields event source transcript head args
  input="$(cat)"
  [[ "${CLAUDE_CODE_ENTRYPOINT:-}" == "${INTERACTIVE_ENTRYPOINT}" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  fields="$(jq -r --argjson head "${HEAD_CHARS}" "${CLEAN_DEF}"'
    [.hook_event_name, .source, .transcript_path, (.prompt // "" | clean | .[0:$head]),
      (.command_args // "" | clean)]
    | map(. // "" | tostring) | join("\u001f")' <<<"${input}" 2>/dev/null)" || return 0
  IFS=$'\x1f' read -r event source transcript head args <<<"${fields}" || return 0
  case "${event}" in
    UserPromptSubmit) point_at_machine_prompt "${source}" "${head}" "${transcript}" ;;
    UserPromptExpansion) point_at_command "${args}" "${transcript}" ;;
    *) ;;
  esac
}

# Args: $1=envelope source $2=cleaned prompt head $3=transcript path
point_at_machine_prompt() {
  local kind quote context
  kind="$(get_prompt_kind "${1}" "${2}")"
  [[ -n "${kind}" ]] || return 0
  quote="$(get_newest_quote "${3}")"
  [[ -n "${quote}" ]] || return 0
  # shellcheck disable=SC2059  # the format is the constant above, never input
  printf -v context "${MACHINE_POINTER}" "${kind}" "${quote}"
  emit_context UserPromptSubmit "${context}"
}

# Args: $1=cleaned command arguments $2=transcript path
point_at_command() {
  local quote context
  quote="$(get_quote "${1}")"
  if [[ -n "${quote}" ]]; then
    # shellcheck disable=SC2059  # the format is the constant above, never input
    printf -v context "${COMMAND_POINTER}" "${quote}"
  else
    quote="$(get_newest_quote "${2}")"
    [[ -n "${quote}" ]] || return 0
    # shellcheck disable=SC2059  # the format is the constant above, never input
    printf -v context "${MACHINE_POINTER}" 'a slash command' "${quote}"
  fi
  emit_context UserPromptExpansion "${context}"
}

# stdout: the kind of a machine-written prompt; empty for the user's own prompt or an agent frame.
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
  command -v python3 >/dev/null 2>&1 || return 0
  [[ -f "${RESOLVER}" ]] || return 0
  prose="$(python3 "${RESOLVER}" transcript "${1}" | jq -r 'select(.status == "found") | .prose')"
  get_quote "${prose}"
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
