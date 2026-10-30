#!/usr/bin/env bash
# PreToolUse(Bash) — dangerous-command heuristic filter, NOT a security boundary.
# Bar-raising text match only: raises the cost of an obvious mistake, does not confine a determined caller.
#
# Known bypass classes (OUT of scope — each defeats a literal text match; extending the list is an unwinnable arms race):
#   - variable indirection          — X=rm; "$X" -rf /
#   - aliasing / indirect naming     — a renamed or shadowed binary
#   - encoding / obfuscation         — base64 -d <<<… | sh
#   - redirect / inline interpreter  — writes outside the matched forms
#
# Trash exception (rm-wipe row only): a command whose every rm deletes only single named entries directly in the
# home Trash passes; the judge (lib/trash_rm.py) reads the text alone, and any parse doubt keeps the block.
#
# Echo exception (rm-wipe row only): rm text in a quoted argument of a print-only echo/printf is blanked before
# the re-check. The judge (lib/echo_mask.py) blanks only what it proves prints: a call that is a whole pipeline
# of its own, redirected at most to a stdout/stderr copy or /dev/null, no printf -v, in a command whose every other
# simple command is one of a few inert names. Anything else it cannot classify keeps every text and the block: a
# heredoc, here-string, multi-line quote, group or compound body, substitution, comment, any $ but $name / ${name},
# or any other program, since one could run the text or read it back from the shell.
#
# Confinement belongs to the tool-grant layer, not here. See plan clauded-docs/290 UD-1 (the blanket shell grant makes the config path-allowlists decorative).
#
# Constraints:
#   - Non-reliance (UD-1): nothing in the harness may cite this hook as a capability control, mitigation, or compensating factor. It is a heuristic backstop, never a control.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"
if [[ -r "${BASH_SOURCE%/*}/lib/pipe-drain.sh" ]]; then
  # shellcheck source=lib/pipe-drain.sh
  source "${BASH_SOURCE%/*}/lib/pipe-drain.sh"
else
  # Library missing or unreadable → the same drain_after in place, so the hook keeps its verdict.
  # A test, not a failed source: bash 3.2 exits on a missing sourced file even inside a condition.
  drain_after() {
    local rc=0
    "$@" || rc=$?
    cat >/dev/null || true
    return "${rc}"
  }
fi

# Payload names: an inherited export would carry them into every child's environment, capped per string on Linux.
export -n INPUT CMD input
INPUT=$(hook_read_input)

# Fail-closed on a python3-less PATH, but ONLY when there is real input to guard.
# WHY: without python3, hook_get_tool_input degrades to EMPTY → zero pattern matches →
# a dangerous command silently ALLOWED; a security gate MUST refuse instead.
hook_require_python3_unless_empty "${INPUT}" "SEC-010" \
  "Dangerous-command gate unavailable: python3 is required to parse hook input"

CMD=$(hook_get_tool_input "${INPUT}" "command")

# Wipe-target set consumed by the order-robust rm flag-run row:
# root · /* · tilde · $HOME / ${HOME} (optionally double-quoted) · cwd dot · dot-dot.
# shellcheck disable=SC2016  # literal \$ in an ERE — matches the $HOME text, never expands
readonly RM_TARGETS='(/($|[^a-zA-Z])|/\*|~|"?\$\{?HOME\}?|\.\s*$|\.\.)'
# Order-robust rm flag-run: any flag order/split, ≥1 r/R flag, optional -- end-of-options marker before
# the target, RM_TARGETS target set. Subsumes the fixed `rm -rf <target>` spellings (verified: the general
# row alone matches every wipe target above, including the -- form).
readonly RM_WIPE_PATTERN='rm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(--\s+)?'"${RM_TARGETS}"

# One `name=pattern` row per heuristic, folded into a single ERE alternation below;
# the name is the only command-derived datum the block output carries.
# Pipe-to-shell rows carry a trailing word boundary so `curl … | shasum` no longer
# false-positives; text match is bar-raising only — variable indirection is out of
# scope (settings deny layer covers the residual).
DANGEROUS_PATTERNS=(
  "rm-wipe=${RM_WIPE_PATTERN}"
  # chmod 777, bare or through a flag-run (e.g. -R).
  'chmod-777=chmod\s+(-[a-zA-Z]+\s+)*777'
  # Pipe of a fetch to (sudo-)shell — sh/bash/zsh/dash, word-bounded.
  'fetch-pipe-shell=(curl|wget)\s.*\|\s*(sudo\s+)?(ba|z|da)?sh([^[:alnum:]_]|$)'
  # Shell process-substitution of a fetch: `bash <(curl …)`.
  'fetch-process-substitution=(^|[^[:alnum:]_])(ba|z|da)?sh\s+<\(\s*(curl|wget)'
  'dd-if=dd\s+if='
  'mkfs=mkfs\.'
  'fork-bomb=:\(\)\{'
  'fork-bomb-phrase=fork\s*bomb'
)

# Top-level `|` is the lowest ERE precedence, so each row's internal groups stay intact.
PATTERN=""
for row in "${DANGEROUS_PATTERNS[@]}"; do
  PATTERN="${PATTERN:+${PATTERN}|}${row#*=}"
done

# Status 0 → every rm deletes only home-Trash entries and the rest of the command carries no rm-wipe text.
# A judge failure of any kind, an unreadable judge file included, is status 1. Args: $1=command text
is_trash_only_rm() {
  local residual
  residual="$(python3 -I "${BASH_SOURCE%/*}/lib/trash_rm.py" <<<"${1}")" || return 1
  # shellcheck disable=SC2310  # the reader's status is the verdict; errexit has nothing else to catch
  if printf '%s' "${residual}" | drain_after grep -qE "${RM_WIPE_PATTERN}"; then
    return 1
  fi
}

# The command with every quoted argument of a print-only echo/printf blanked, per the judge (lib/echo_mask.py);
# a judge doubt or failure of any kind is the command itself. Args: $1=command text
get_echo_masked() {
  local masked
  masked="$(python3 -I "${BASH_SOURCE%/*}/lib/echo_mask.py" <<<"${1}")" || masked=""
  printf '%s' "${masked:-${1}}"
}

# First matching row name, empty when only a Trash-entry rm or print-only echo text matched. Args: $1=command text
get_matched_row() {
  local row masked
  for row in "${DANGEROUS_PATTERNS[@]}"; do
    # shellcheck disable=SC2310  # the reader's status is the verdict; errexit has nothing else to catch
    if printf '%s' "${1}" | drain_after grep -qE "${row#*=}"; then
      if [[ "${row%%=*}" == "rm-wipe" ]]; then
        masked="$(get_echo_masked "${1}")"
        # shellcheck disable=SC2310  # the reader's and the judge's status are the verdict
        if ! printf '%s' "${masked}" | drain_after grep -qE "${RM_WIPE_PATTERN}" || is_trash_only_rm "${masked}"; then
          continue
        fi
      fi
      printf '%s' "${row%%=*}"
      return 0
    fi
  done
}

# One grep on the pass path; the per-row lookup runs only once a match is certain.
# shellcheck disable=SC2310  # the reader's status is the verdict; errexit has nothing else to catch
if printf '%s' "${CMD}" | drain_after grep -qE "${PATTERN}"; then
  MATCHED_ROW="$(get_matched_row "${CMD}")"
  if [[ -n "${MATCHED_ROW}" ]]; then
    # Row names are script literals → the hand-built context stays valid JSON on the jq-less fallback.
    emit_error "SEC-010" "block" \
      "Dangerous system command blocked" \
      "This hook blocks the command whatever the approval; if the user wants it run, ask them to run it themselves" \
      "{\"row\":\"${MATCHED_ROW}\"}"
    exit 2
  fi
fi
exit 0
