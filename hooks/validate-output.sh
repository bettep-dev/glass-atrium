#!/usr/bin/env bash
# PostToolUse — output content security validation (OWASP LLM05/LLM07)
# Advisory mode: warning only (Bash code injection is blocked)
#
# Channel (shared-hook-capability-contract.md):
#   LLM07 leak (non-blocking) → STDERR advisory (emit_error) + exit 0, no stdout JSON.
#   The PostToolUse decision schema also rejects "advisory" ("Hook JSON output
#   validation failed — (root): Invalid input") → a non-blocking advisory does not
#   produce a stdout validation surface.
#   LLM05 code injection (blocking) → stdout {"decision":"block"} + exit 2 (block is valid).
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

INPUT=$(hook_read_input)
[[ "${INPUT}" == "{}" ]] && exit 0

# Single-pass parse: tool_name + tool_response[:2000] in ONE python3 (was two — a
# hook_get_field spawn plus an inline python3). NUL-delimited so an embedded newline in
# tool_response survives the read; str()/[:2000]/rstrip('\n')/replace('\x00','') reproduce the
# prior hook_get_field + inline-python captures byte-for-byte (print()'s str-coerce, the 2000-char
# truncation, and $()'s trailing-newline AND NUL strip). replace('\x00','') is load-bearing: a JSON
# string CAN hold a NUL via \u0000 (json.load decodes it to a real \x00), which would truncate the
# `read -r -d ''` consumer mid-value and silently disarm the detector (block bypass); stripping it
# AFTER [:2000] mirrors the old $()-capture (bash drops NUL bytes), so os.system( reassembles across
# the NUL instead of splitting into a harmless "os." fragment.
# No fail-open handler by design: malformed /
# non-object JSON, or python3 absent → python3 exits non-zero → the reads hit EOF → set -e
# exits non-zero, preserving the prior fail-hard (loud-fail) behavior on bad input exactly.
# SC2312: the reads deliberately propagate that python3 failure through set -e — the <( )
# boundary hides the exit code from ShellCheck, so the check is silenced (not a masked bug).
# shellcheck disable=SC2312
{
  IFS= read -r -d '' TOOL_NAME
  IFS= read -r -d '' TOOL_RESPONSE
} < <(python3 -c '
import sys, json
d = json.load(sys.stdin)
o = sys.stdout
o.write(str(d.get("tool_name", "")).rstrip("\n").replace("\x00", ""))
o.write("\0")
o.write(str(d.get("tool_response", ""))[:2000].rstrip("\n").replace("\x00", ""))
o.write("\0")
' <<<"${INPUT}" 2>/dev/null)

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
if printf '%s\n' "${RESPONSE_LOWER}" | grep -Eq "${LEAK_ALTERNATION}"; then
  emit_error "SEC-072" "advisory" \
    "System prompt leak pattern detected" \
    "시스템 프롬프트 역유출 패턴 감지" \
    "Review output; ensure system instructions are not disclosed" \
    "출력을 검토하세요; 시스템 지침이 노출되지 않는지 확인" \
    "{\"pattern\":\"leak\"}"
  exit 0
fi

# LLM05: code-injection output patterns (Bash tool only — Block)
if [[ "${TOOL_NAME}" == "Bash" ]]; then
  if printf '%s\n' "${TOOL_RESPONSE}" | grep -qE "(DROP TABLE|DELETE FROM\s+\w+\s*(WHERE|;)|^\s*(exec|eval)\s*\(|^\s*__import__\s*\(|^\s*os\.(system|popen)\s*\()"; then
    emit_error "SEC-012" "block" \
      "Dangerous code pattern in execution output" \
      "실행 결과에 위험한 코드 패턴 포함" \
      "Review and sanitize the command output before proceeding" \
      "진행 전 명령 출력을 검토하고 정제하세요"
    printf '%s\n' '{"decision":"block","reason":"[output-validator] LLM05: Dangerous code pattern in execution output"}'
    exit 2
  fi
fi

exit 0
