#!/usr/bin/env bash
# PreToolUse(Bash) — block --no-verify, --no-gpg-sign
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
CMD=$(hook_get_tool_input "${INPUT}" "command")

# shellcheck disable=SC2310  # the reader's status is the verdict; errexit has nothing else to catch
if printf '%s' "${CMD}" | drain_after grep -qE '(git\s+commit\s+.*--no-verify|--no-gpg-sign|git\s+commit\s+.*\s-n\b)'; then
  context="{\"command\":\"${CMD}\"}"
  # emit_error hands the context to jq as one argument; Linux refuses one of 131072 bytes or more.
  if (($(LC_ALL=C && printf '%s' "${#context}") >= 131072)); then context='{}'; fi
  emit_error "SEC-011" "block" \
    "Hook bypass flag blocked" \
    "Remove --no-verify / -n / --no-gpg-sign so the pre-commit hooks run; if signing is not configured, set it up or set commit.gpgsign false explicitly (core-git-workflow.md -> Commits)" \
    "${context}"
  exit 2
fi
exit 0
