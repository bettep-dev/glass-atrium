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
# Confinement belongs to the tool-grant layer, not here. See plan clauded-docs/290 UD-1 (the blanket shell grant makes the config path-allowlists decorative).
#
# Constraints:
#   - Non-reliance (UD-1): nothing in the harness may cite this hook as a capability control, mitigation, or compensating factor. It is a heuristic backstop, never a control.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

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

# One `name=pattern` row per heuristic, folded into a single ERE alternation below;
# the name is the only command-derived datum the block output carries.
# Pipe-to-shell rows carry a trailing word boundary so `curl … | shasum` no longer
# false-positives; text match is bar-raising only — variable indirection is out of
# scope (settings deny layer covers the residual).
DANGEROUS_PATTERNS=(
  # Order-robust rm flag-run: any flag order/split, ≥1 r/R flag, optional --
  # end-of-options marker before the target, RM_TARGETS target set. Subsumes the
  # fixed `rm -rf <target>` spellings (verified: the general row alone matches
  # every wipe target above, including the -- form).
  'rm-wipe=rm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(--\s+)?'"${RM_TARGETS}"
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

# First matching row name. Args: $1=command text
get_matched_row() {
  local row
  for row in "${DANGEROUS_PATTERNS[@]}"; do
    if printf '%s' "${1}" | grep -qE "${row#*=}"; then
      printf '%s' "${row%%=*}"
      return 0
    fi
  done
}

# One grep on the pass path; the per-row lookup runs only once a block is certain.
if printf '%s' "${CMD}" | grep -qE "${PATTERN}"; then
  MATCHED_ROW="$(get_matched_row "${CMD}")"
  # Row names are script literals → the hand-built context stays valid JSON on the jq-less fallback.
  emit_error "SEC-010" "block" \
    "Dangerous system command blocked" \
    "Request explicit user confirmation before executing" \
    "{\"row\":\"${MATCHED_ROW}\"}"
  exit 2
fi
exit 0
