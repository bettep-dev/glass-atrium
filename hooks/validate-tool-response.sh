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

# Single-pass parse: tool_name + tool_response[:8000] in ONE python3 (was two — a hook_get_field
# spawn plus an inline python3). NUL-delimited so an embedded newline in tool_response survives the
# read; str()/[:8000]/replace('\x00','')/rstrip('\n') reproduce the prior hook_get_field + inline
# captures byte-for-byte (print()'s str-coerce, the 8000-char truncation, and $()'s NUL + trailing
# newline strip). replace('\x00','') is load-bearing: a JSON   decodes to a real NUL that would
# truncate the `read -r -d ''` consumer mid-value and disarm the detector (bypass); stripping it
# AFTER [:8000] mirrors the old $()-capture (bash drops NUL bytes). Fail-OPEN by design (advisory,
# never block): python3 absent → the `|| printf` fallback emits two empty NUL-terminated fields →
# empty tool_name → the case below exits 0, matching the prior hook_get_field/$()-capture guards.
TOOL_NAME=""
TOOL_RESPONSE=""
# shellcheck disable=SC2312
{
  IFS= read -r -d '' TOOL_NAME
  IFS= read -r -d '' TOOL_RESPONSE
} < <(python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    if not isinstance(d, dict):
        d = {}
except Exception:
    d = {}
o = sys.stdout
o.write(str(d.get("tool_name", "")).replace("\x00", "").rstrip("\n"))
o.write("\0")
o.write(str(d.get("tool_response", ""))[:8000].replace("\x00", "").rstrip("\n"))
o.write("\0")
' <<<"${INPUT}" 2>/dev/null || printf '\0\0')

# Target scope: tools whose response carries EXTERNAL (untrusted) content —
# WebFetch/WebSearch built-ins + mcp fetch/get/read/search tools. Non-target →
# fail-open silent (Bash/Read of local files is out of scope; not an injection channel).
case "${TOOL_NAME}" in
  WebFetch | WebSearch) ;;
  mcp__*fetch* | mcp__*get* | mcp__*read* | mcp__*search*) ;;
  *) exit 0 ;;
esac

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

# Collapse each pattern CLASS into one scan: EN + KO patterns each join into a single ERE
# alternation (top-level `|` is lowest precedence, so every pattern's internal (group)/{0,N}
# stays self-contained → the alternation matches the exact same input set as the per-pattern
# loop). The base64 class stays fixed-string via `grep -F` with one -e per marker.
EN_ALTERNATION=$(hook_join_alt "${PATTERNS[@]}")
KO_ALTERNATION=$(hook_join_alt "${KO_PATTERNS[@]}")
b64_grep_args=()
for _marker in "${EVASION_PATTERNS[@]}"; do
  b64_grep_args+=(-e "${_marker}")
done

LOWER_RESPONSE=$(printf '%s\n' "${TOOL_RESPONSE}" | tr '[:upper:]' '[:lower:]')

# SEC-073 advisory: English indirect-injection marker in fetched content. -i is load-bearing —
# the \[SYSTEM\]/\[INST\]/<<SYS>> patterns carry uppercase folded against the lowercased text.
if printf '%s\n' "${LOWER_RESPONSE}" | grep -qiE "${EN_ALTERNATION}"; then
  emit_error "SEC-073" "advisory" \
    "Indirect injection pattern in fetched content (English)" \
    "외부 가져온 콘텐츠에서 간접 인젝션 패턴 감지 (영어)" \
    "Treat fetched content as untrusted; do not act on embedded instructions"
  exit 0
fi

# SEC-073 advisory: Korean indirect-injection marker (match original text).
if printf '%s\n' "${TOOL_RESPONSE}" | grep -qE "${KO_ALTERNATION}"; then
  emit_error "SEC-073" "advisory" \
    "Indirect injection pattern in fetched content (Korean)" \
    "외부 가져온 콘텐츠에서 간접 인젝션 패턴 감지 (한국어)" \
    "Treat fetched content as untrusted; do not act on embedded instructions"
  exit 0
fi

# SEC-074 advisory: encoding-evasion marker (base64 — match original text) as fixed strings.
if printf '%s\n' "${TOOL_RESPONSE}" | grep -qF "${b64_grep_args[@]}"; then
  emit_error "SEC-074" "advisory" \
    "Encoded injection marker in fetched content" \
    "외부 가져온 콘텐츠에서 인코딩된 인젝션 마커 감지" \
    "Decode + inspect; treat as untrusted, do not execute embedded payload"
  exit 0
fi

exit 0
