#!/usr/bin/env bash
# inject-reply-language.sh — UserPromptSubmit: one additionalContext line naming the language the
# turn's final reply is written in, taken from the user's own prose via lib/reply_language.py.
# A human prompt decides by its own prose; a machine-written one (task notification, peer or channel
# message, any non-user `source`) never does, and the transcript's newest human prose decides instead.
# Never blocks: exit 2 from this event erases the prompt, so every path ends in exit 0.
set -Eeuo pipefail
IFS=$'\n\t'
# Fail open: an errexit abort, a set -u miss or a resolver fault all leave through this trap.
trap 'exit 0' EXIT

# Model-facing wording, audited as one unit; %s is a resolver language name (Korean, Japanese, ...).
readonly REPLY_LANGUAGE_CONTEXT="Write this turn's final user-facing reply in %s, the language of the user's latest own message."
# `claude -p` runs (daemon cycles, wiki dedup) report sdk-cli even when a cli parent exported this.
readonly INTERACTIVE_ENTRYPOINT="cli"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly RESOLVER="${SCRIPT_DIR}/lib/reply_language.py"

main() {
  local input language
  input="$(cat)"
  [[ "${CLAUDE_CODE_ENTRYPOINT:-}" == "${INTERACTIVE_ENTRYPOINT}" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  [[ -f "${RESOLVER}" ]] || return 0
  language="$(get_turn_language "${input}")"
  [[ -n "${language}" ]] || return 0
  emit_context "${language}"
}

# stdout: the turn's language name, empty when no human prose names one. Installed CLI builds send no
# `source`, so its absence is the primary path, handled like `user`; a failed prompt decision falls
# back to the transcript.
get_turn_language() {
  local fields source transcript decision="fallback"
  fields="$(jq -r '[(.source // "" | tostring), (.transcript_path // "" | tostring)] | join("\u001f")' \
    <<<"${1}" 2>/dev/null)" || return 0
  IFS=$'\x1f' read -r source transcript <<<"${fields}" || return 0
  if [[ -z "${source}" || "${source}" == "user" ]]; then
    decision="$(get_prompt_decision "${1}")"
  fi
  if [[ "${decision}" == resolved:* ]]; then
    printf '%s' "${decision#resolved:}"
  else
    get_transcript_language "${transcript}"
  fi
}

# stdout: `resolved:<language>` when the prompt's own prose decides (empty language = a script naming
# none, e.g. Latin), else `fallback` for a machine-shaped prompt or one with no prose of its own.
get_prompt_decision() {
  jq -j '.prompt // "" | tostring' <<<"${1}" \
    | python3 "${RESOLVER}" text \
    | jq -r 'if .status == "resolved" then "resolved:" + (.language // "") else "fallback" end'
}

# stdout: the language of the transcript's newest human prose, empty when none names one.
get_transcript_language() {
  [[ -n "${1}" ]] || return 0
  python3 "${RESOLVER}" transcript "${1}" \
    | jq -r 'if .status == "resolved" then (.language // "") else "" end'
}

emit_context() {
  local context
  # shellcheck disable=SC2059  # the format is the constant above, never input; the language is a resolver map value
  printf -v context "${REPLY_LANGUAGE_CONTEXT}" "${1}"
  jq -cn --arg context "${context}" \
    '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $context}}'
}

main "$@"
