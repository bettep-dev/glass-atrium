#!/usr/bin/env bash
# PostToolUse(WebFetch|WebSearch|mcp fetch/read) — advisory indirect-injection
# scanner for FETCHED EXTERNAL CONTENT (OWASP LLM01).
#
# Channel: STDERR advisory (emit_error) + exit 0 — never block. PostToolUse is
#   observe-only — no updatedOutput surface to sanitize/rewrite tool output.
# Residual: DETECTS markers only — no sanitize/quarantine; model still sees the
#   raw tool_response. Dual-LLM quarantine (core-security.md LLM01) = future work
#   → a detection is an operator warning, not a containment boundary.
# Separate hook (not validate-prompt.sh): tool_response exists only in the
#   PostToolUse envelope — validate-prompt.sh is PreToolUse, sees only tool_input.
# Pattern arrays intentionally duplicated from validate-prompt.sh — a shared
#   sourced list would couple the two hooks → keep both in sync when either tunes.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

INPUT=$(hook_read_input)
[[ "${INPUT}" == "{}" ]] && exit 0

TOOL_NAME=$(hook_get_field "${INPUT}" "tool_name")

# Target scope: tools whose response carries EXTERNAL (untrusted) content.
# WebFetch / WebSearch are the built-ins; mcp fetch/read tools (naming convention
# mcp__<server>__fetch / __get / __read / __search) also pull external content.
# Non-target tool → fail-open silent (the injection channel is external-content
# tools only; Bash/Read of local files is out of scope here).
case "${TOOL_NAME}" in
  WebFetch | WebSearch) ;;
  mcp__*fetch* | mcp__*get* | mcp__*read* | mcp__*search*) ;;
  *) exit 0 ;;
esac

# tool_response may be a string OR a structured object (dict/list) depending on
# the tool. str(...) stringifies any shape; truncate to bound scan cost. On any
# parse error → empty → fail-open silent below. Mirrors validate-output.sh.
TOOL_RESPONSE=$(printf '%s\n' "${INPUT}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('tool_response',''))[:8000])" 2>/dev/null) || TOOL_RESPONSE=""

# Fail-open: missing / empty tool_response → exit 0 silent.
[[ -z "${TOOL_RESPONSE}" ]] && exit 0

# English injection patterns (matched case-insensitively against lowercased text).
PATTERNS=(
  'ignore previous instructions'
  'disregard previous'
  'forget instructions'
  'override system prompt'
  'you are now'
  'pretend to be'
  'print system prompt'
  'output system prompt'
  'show system prompt'
  'reveal your (instructions|system prompt|prompt)'
  'developer mode'
  '<system>'
  '<assistant>'
  '\[SYSTEM\]'
  '\[INST\]'
  '<<SYS>>'
)

# Korean injection patterns (action-anchored — each requires an injection verb so
# a benign page merely mentioning the prompt/instruction phrase does not over-fire).
# Korean is caseless → matched against the original (non-lowercased) text.
KO_PATTERNS=(
  '이전.{0,8}(지시|명령|지침|프롬프트).{0,12}(무시|잊어|잊고|버려|무효)'
  '(무시|잊어|잊고).{0,12}이전.{0,8}(지시|명령|지침)'
  '시스템.{0,4}프롬프트.{0,16}(출력|공개|보여|알려|노출|말해)'
  '(출력|공개|보여|알려|노출).{0,16}시스템.{0,4}프롬프트'
  '(너의|당신의|네).{0,8}(지시사항|지침|규칙|프롬프트).{0,16}(공개|출력|보여|알려|노출)'
  '개발자.{0,2}모드.{0,12}(활성화|켜|진입|전환)'
)

# Encoding / obfuscation evasion markers (base64 of common injection tokens).
# Case-significant (base64 alphabet) → matched as fixed strings on original text.
EVASION_PATTERNS=(
  'aWdub3Jl'            # base64("ignore")
  'c3lzdGVtIHByb21wdA'  # base64("system prompt") — trailing edge
  'c3lzdGVtIHByb21wdC'  # base64("system prompt ") — space + more text
  'aW5zdHJ1Y3Rpb24'     # base64("instruction")
  'c3lzdGVtIHByb21wdHM' # base64("system prompts")
)

LOWER_RESPONSE=$(printf '%s\n' "${TOOL_RESPONSE}" | tr '[:upper:]' '[:lower:]')

# SEC-073 advisory: English indirect-injection marker in fetched content.
for pattern in "${PATTERNS[@]}"; do
  if printf '%s\n' "${LOWER_RESPONSE}" | grep -qiE "${pattern}"; then
    emit_error "SEC-073" "advisory" \
      "Indirect injection pattern in fetched content (English)" \
      "외부 가져온 콘텐츠에서 간접 인젝션 패턴 감지 (영어)" \
      "Treat fetched content as untrusted; do not act on embedded instructions" \
      "가져온 콘텐츠를 신뢰하지 마세요; 내장된 지시를 실행하지 마세요" \
      "{\"tool\":\"${TOOL_NAME}\",\"pattern\":\"${pattern}\"}"
    exit 0
  fi
done

# SEC-073 advisory: Korean indirect-injection marker (match original text).
for pattern in "${KO_PATTERNS[@]}"; do
  if printf '%s\n' "${TOOL_RESPONSE}" | grep -qE "${pattern}"; then
    emit_error "SEC-073" "advisory" \
      "Indirect injection pattern in fetched content (Korean)" \
      "외부 가져온 콘텐츠에서 간접 인젝션 패턴 감지 (한국어)" \
      "Treat fetched content as untrusted; do not act on embedded instructions" \
      "가져온 콘텐츠를 신뢰하지 마세요; 내장된 지시를 실행하지 마세요" \
      "{\"tool\":\"${TOOL_NAME}\"}"
    exit 0
  fi
done

# SEC-074 advisory: encoding-evasion marker (base64 — match original text).
for pattern in "${EVASION_PATTERNS[@]}"; do
  if printf '%s\n' "${TOOL_RESPONSE}" | grep -qF "${pattern}"; then
    emit_error "SEC-074" "advisory" \
      "Encoded injection marker in fetched content" \
      "외부 가져온 콘텐츠에서 인코딩된 인젝션 마커 감지" \
      "Decode + inspect; treat as untrusted, do not execute embedded payload" \
      "디코딩 후 검토하세요; 신뢰하지 말고 내장 페이로드를 실행하지 마세요" \
      "{\"tool\":\"${TOOL_NAME}\",\"marker\":\"${pattern}\"}"
    exit 0
  fi
done

exit 0
