#!/usr/bin/env bash
# PreToolUse(Bash) — block dangerous commands
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

# One pattern per row, folded into a single ERE alternation below.
# Pipe-to-shell rows carry a trailing word boundary so `curl … | shasum` no longer
# false-positives; text match is bar-raising only — variable indirection is out of
# scope (settings deny layer covers the residual).
DANGEROUS_PATTERNS=(
  # Order-robust rm flag-run: any flag order/split, ≥1 r/R flag, optional --
  # end-of-options marker before the target, RM_TARGETS target set. Subsumes the
  # fixed `rm -rf <target>` spellings (verified: the general row alone matches
  # every wipe target above, including the -- form).
  'rm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(--\s+)?'"${RM_TARGETS}"
  # chmod 777, bare or through a flag-run (e.g. -R).
  'chmod\s+(-[a-zA-Z]+\s+)*777'
  # Pipe of a fetch to (sudo-)shell — sh/bash/zsh/dash, word-bounded.
  '(curl|wget)\s.*\|\s*(sudo\s+)?(ba|z|da)?sh([^[:alnum:]_]|$)'
  # Shell process-substitution of a fetch: `bash <(curl …)`.
  '(^|[^[:alnum:]_])(ba|z|da)?sh\s+<\(\s*(curl|wget)'
  'dd\s+if='
  'mkfs\.'
  ':\(\)\{'
  'fork\s*bomb'
)

# In-process IFS join (no per-invocation subshell): top-level `|` is the lowest ERE
# precedence, so each row's internal groups stay intact.
SAVED_IFS="${IFS}"
IFS='|'
PATTERN="${DANGEROUS_PATTERNS[*]}"
IFS="${SAVED_IFS}"

if printf '%s' "${CMD}" | grep -qE "${PATTERN}"; then
  emit_error "SEC-010" "block" \
    "Dangerous system command blocked" \
    "Request explicit user confirmation before executing" \
    "{\"command\":\"${CMD}\"}"
  exit 2
fi
exit 0
