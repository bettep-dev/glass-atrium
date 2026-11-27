#!/usr/bin/env bash
# PostToolUse — output content validation (OWASP LLM07 system-prompt leak), advisory only: never blocks.
#
# Channel (shared-hook-capability-contract.md):
#   LLM07 leak → STDERR advisory (emit_error) + exit 0, no stdout JSON.
#   The PostToolUse decision schema rejects "advisory" ("Hook JSON output
#   validation failed — (root): Invalid input") → a non-blocking advisory does not
#   produce a stdout validation surface.
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
export -n INPUT TOOL_RESPONSE RESPONSE_LOWER input
INPUT=$(hook_read_input)
[[ "${INPUT}" == "{}" ]] && exit 0

# One python3 parse of tool_response[:2000], NUL-terminated so an embedded newline survives the read.
# replace('\x00','') is load-bearing: a JSON string CAN hold a NUL via \u0000 (json.load decodes it
# to a real \x00), which would truncate the `read -r -d ''` consumer mid-value and split a leak
# phrase into harmless fragments; stripping it lets the phrase reassemble across the NUL.
# No fail-open handler by design: malformed / non-object JSON, or python3 absent → the parse
# command fails → set -e exits non-zero, the fail-hard (loud-fail) behavior on bad input.
PARSED_FIELDS="$(mktemp)"
# shellcheck disable=SC2329  # invoked from the EXIT trap string
delete_parsed_fields() {
  # shellcheck disable=SC2310  # pure predicate — nothing inside it for errexit to catch
  if ga_guard_path "${PARSED_FIELDS}"; then rm -f -- "${PARSED_FIELDS:?}"; fi
}
trap 'delete_parsed_fields || true' EXIT
python3 -c '
import sys, json
d = json.load(sys.stdin)
o = sys.stdout
o.write(str(d.get("tool_response", ""))[:2000].rstrip("\n").replace("\x00", ""))
o.write("\0")
' <<<"${INPUT}" >"${PARSED_FIELDS}" 2>/dev/null
IFS= read -r -d '' TOOL_RESPONSE <"${PARSED_FIELDS}"

# LLM07: system-prompt reverse-leak patterns. Joined into one ERE alternation so a single
# grep -E pass replaces the former per-pattern loop (1 grep instead of up to 8). Every pattern
# is a literal (no ERE metacharacter), so the alternation matches the exact same input set; the
# advisory is pattern-independent (emit_error records no per-pattern detail).
LEAK_PATTERNS=(
  'your system prompt is'
  'my instructions are'
  'i was told to'
  'as instructed in my system'
  'my rules say'
  'according to my guidelines'
  'my configuration states'
  'i am programmed to'
)
LEAK_ALTERNATION="$(hook_join_alt "${LEAK_PATTERNS[@]}")"
RESPONSE_LOWER=$(printf '%s\n' "${TOOL_RESPONSE}" | tr '[:upper:]' '[:lower:]')
# shellcheck disable=SC2310  # the reader's status is the verdict; errexit has nothing else to catch
if printf '%s\n' "${RESPONSE_LOWER}" | drain_after grep -Eq "${LEAK_ALTERNATION}"; then
  emit_error "SEC-072" "advisory" \
    "System prompt leak pattern detected" \
    "시스템 프롬프트 역유출 패턴 감지" \
    "Review output; ensure system instructions are not disclosed" \
    "출력을 검토하세요; 시스템 지침이 노출되지 않는지 확인" \
    "{\"pattern\":\"leak\"}"
fi

exit 0
