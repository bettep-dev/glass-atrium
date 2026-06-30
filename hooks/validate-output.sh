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

TOOL_NAME=$(hook_get_field "${INPUT}" "tool_name")
TOOL_RESPONSE=$(printf '%s\n' "${INPUT}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('tool_response',''))[:2000])" 2>/dev/null)

# LLM07: system-prompt reverse-leak patterns
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
RESPONSE_LOWER=$(printf '%s\n' "${TOOL_RESPONSE}" | tr '[:upper:]' '[:lower:]')
for pattern in "${LEAK_PATTERNS[@]}"; do
  if printf '%s\n' "${RESPONSE_LOWER}" | grep -q "${pattern}"; then
    emit_error "SEC-072" "advisory" \
      "System prompt leak pattern detected" \
      "시스템 프롬프트 역유출 패턴 감지" \
      "Review output; ensure system instructions are not disclosed" \
      "출력을 검토하세요; 시스템 지침이 노출되지 않는지 확인" \
      "{\"pattern\":\"${pattern}\"}"
    exit 0
  fi
done

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
