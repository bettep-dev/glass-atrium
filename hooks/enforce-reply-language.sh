#!/usr/bin/env bash
# enforce-reply-language.sh — Stop: blocks the turn's end ONCE when the final reply holds none of the script
# of the user's language (the transcript's newest human prose, via lib/reply_language.py), so the model adds
# a short reply in that language. Channel b: stdout {"decision":"block"} + exit 0; every other path is silent.
# Accepted costs:
# - a block cannot retract the reply already shown: the user sees it, then the corrected one;
# - the forced continuation re-runs every Stop hook, and its feedback entry opens a new cost-tracker.sh turn row;
# - a language request is read from the newest human prose only; an earlier standing request is unseen, so the
#   reason itself yields to it at the price of one extra continuation.
set -Eeuo pipefail
IFS=$'\n\t'
# Fail open: an errexit abort, a set -u miss or a resolver fault all leave through this trap.
trap 'exit 0' EXIT

# Model-facing wording, audited as one unit; each %s is the same resolver language name (Korean, Japanese, ...).
readonly BLOCK_REASON="Reply-language check: the user writes in %s, but your final reply has no %s prose. Add a short %s reply now that frames or summarizes it for the user, without re-emitting an English body you relayed verbatim. If the user explicitly asked for another language, keep it and end the turn."
# `claude -p` runs (daemon cycles, wiki dedup) report sdk-cli even when a cli parent exported this.
readonly INTERACTIVE_ENTRYPOINT="cli"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly RESOLVER="${SCRIPT_DIR}/lib/reply_language.py"

main() {
  local input
  input="$(cat)"
  [[ -z "${REPLY_LANGUAGE_BACKSTOP_OFF:-}" ]] || return 0
  [[ "${CLAUDE_CODE_ENTRYPOINT:-}" == "${INTERACTIVE_ENTRYPOINT}" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  [[ -f "${RESOLVER}" ]] || return 0
  check_final_reply "${input}"
}

# stdout: the block decision when the final reply lacks the user's script, else nothing. An active stop hook
# means this Stop ends the continuation a block forced, so it never blocks twice.
check_final_reply() {
  local fields active transcript has_reply target script language counts total in_script
  fields="$(jq -r '[(.stop_hook_active | tostring), (.transcript_path // "" | tostring),
    (has("last_assistant_message") | tostring)] | join("\u001f")' <<<"${1}" 2>/dev/null)" || return 0
  IFS=$'\x1f' read -r active transcript has_reply <<<"${fields}" || return 0
  [[ "${active}" != "true" && -n "${transcript}" ]] || return 0
  target="$(get_turn_target "${transcript}")"
  [[ -n "${target}" ]] || return 0
  IFS=$'\x1f' read -r script language <<<"${target}" || return 0
  counts="$(get_reply_counts "${1}" "${has_reply}" "${transcript}" "${script}")"
  IFS=$'\t' read -r total in_script <<<"${counts}" || return 0
  ((total > 0 && in_script == 0)) || return 0
  emit_block "${language}"
}

# stdout: `<script>\x1f<language>` the reply must carry; empty when the newest human prose names no single
# language (Latin script) or explicitly requests a different one.
get_turn_target() {
  python3 "${RESOLVER}" transcript "${1}" | jq -r 'select(.status == "resolved" and .language != null)
    | select(.requested_language == null or .requested_language == .language)
    | [.script, .language] | join("\u001f")'
}

# stdout: `<prose units>\t<units in script $4>` of the final reply; code, paths and identifiers are no prose.
# Args: $1=envelope $2=has last_assistant_message $3=transcript $4=script
get_reply_counts() {
  get_reply_decision "${1}" "${2}" "${3}" | jq -r --arg script "${4}" \
    '(.units // {}) | [(add // 0), (.[$script] // 0)] | map(tostring) | join("\t")'
}

# stdout: the resolver's script units for the envelope's final reply; builds without the field fall back to
# the transcript's newest assistant message.
get_reply_decision() {
  if [[ "${2}" == "true" ]]; then
    jq -j '.last_assistant_message // "" | tostring' <<<"${1}" | python3 "${RESOLVER}" reply
  else
    python3 "${RESOLVER}" reply --transcript "${3}"
  fi
}

emit_block() {
  local reason
  # shellcheck disable=SC2059  # the format is the constant above, never input; the language is a resolver map value
  printf -v reason "${BLOCK_REASON}" "${1}" "${1}" "${1}"
  jq -cn --arg reason "${reason}" '{decision: "block", reason: $reason}'
}

main "$@"
