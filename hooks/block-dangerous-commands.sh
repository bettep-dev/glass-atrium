#!/usr/bin/env bash
# PreToolUse(Bash) — block dangerous commands
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

INPUT=$(hook_read_input)

# Fail-closed on a python3-less PATH, but ONLY when there is real input to guard.
# WHY: without python3, hook_get_tool_input degrades to EMPTY → zero pattern matches →
# a dangerous command silently ALLOWED; a security gate MUST refuse instead.
# Empty input stays exit 0 (nothing to guard) — the empty-stdin fail-open contract is kept.
case "${INPUT}" in
  "" | "{}" | "{ }") : ;;
  *) hook_require_python3 "SEC-010" \
    "Dangerous-command gate unavailable: python3 is required to parse hook input" ;;
esac

CMD=$(hook_get_tool_input "${INPUT}" "command")

# Wipe-target set shared by the fixed "-rf" rows and the order-robust flag-run row:
# root · /* · tilde · $HOME / ${HOME} (optionally double-quoted) · cwd dot · dot-dot.
# shellcheck disable=SC2016  # literal \$ in an ERE — matches the $HOME text, never expands
readonly RM_TARGETS='(/($|[^a-zA-Z])|/\*|~|"?\$\{?HOME\}?|\.\s*$|\.\.)'

# One pattern per row, folded into a single ERE alternation via hook_join_alt.
# Pipe-to-shell rows carry a trailing word boundary so `curl … | shasum` no longer
# false-positives; text match is bar-raising only — variable indirection is out of
# scope (settings deny layer covers the residual).
# shellcheck disable=SC2016  # literal \$ in an ERE — matches the $HOME text, never expands
DANGEROUS_PATTERNS=(
  'rm\s+-rf\s+(--\s+)?/($|[^a-zA-Z])'
  'rm\s+-rf\s+(--\s+)?/\*'
  'rm\s+-rf\s+(--\s+)?~'
  'rm\s+-rf\s+(--\s+)?\$HOME'
  'rm\s+-rf\s+(--\s+)?\.\s*$'
  'rm\s+-rf\s+(--\s+)?\.\.'
  # Order-robust rm flag-run: any flag order/split, ≥1 r/R flag, optional --
  # end-of-options marker before the target, same target set.
  'rm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(--\s+)?'"${RM_TARGETS}"
  'chmod\s+777'
  # chmod flag-run (e.g. -R) reaching 777.
  'chmod\s+(-[a-zA-Z]+\s+)+777'
  # Pipe of a fetch to (sudo-)shell — sh/bash/zsh/dash, word-bounded.
  '(curl|wget)\s.*\|\s*(sudo\s+)?(ba|z|da)?sh([^[:alnum:]_]|$)'
  # Shell process-substitution of a fetch: `bash <(curl …)`.
  '(^|[^[:alnum:]_])(ba|z|da)?sh\s+<\(\s*(curl|wget)'
  'dd\s+if='
  'mkfs\.'
  ':\(\)\{'
  'fork\s*bomb'
)

PATTERN="$(hook_join_alt "${DANGEROUS_PATTERNS[@]}")"

if printf '%s' "${CMD}" | grep -qE "${PATTERN}"; then
  emit_error "SEC-010" "block" \
    "Dangerous system command blocked" \
    "Request explicit user confirmation before executing" \
    "{\"command\":\"${CMD}\"}"
  exit 2
fi
exit 0
