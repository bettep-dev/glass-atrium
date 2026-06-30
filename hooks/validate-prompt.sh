#!/usr/bin/env bash
# PreToolUse(Write|Edit) — advisory detection of prompt-injection patterns
# On detection: STDERR warning (emit_error) + exit 0 (no block · no stdout JSON)
# On error: no output + exit 0 (never block tool execution)
#
# Channel (shared-hook-capability-contract.md):
#   STDERR advisory + exit 0. The PreToolUse decision schema only accepts
#   approve/block ("advisory" is rejected → "Hook JSON output validation failed
#   — (root): Invalid input"). A non-blocking advisory emits via emit_error
#   STDERR only → schema-safe. Precedent: validate-scope-drift.sh /
#   validate-large-diff.sh.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

INPUT=$(hook_read_input)

# extract content + new_string combined
CONTENT=$(printf '%s\n' "${INPUT}" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('tool_input', {}).get('content', '') + d.get('tool_input', {}).get('new_string', ''))
except:
    pass
" 2>/dev/null) || CONTENT=""

[[ -z "${CONTENT}" ]] && exit 0

# English injection patterns (matched case-insensitively against lowercased content).
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

# Korean injection patterns (literal detection regexes, NOT prose) — Korean is
# caseless, so matched against the original (non-lowercased) content. Each anchors
# an injection ACTION verb (ignore/forget/print/reveal/activate) so a benign
# mention of the instruction/system-prompt phrase does not over-fire.
KO_PATTERNS=(
  # "ignore/forget previous instructions" — requires an ignore/forget verb nearby
  '이전.{0,8}(지시|명령|지침|프롬프트).{0,12}(무시|잊어|잊고|버려|무효)'
  '(무시|잊어|잊고).{0,12}이전.{0,8}(지시|명령|지침)'
  # "reveal/print the system prompt" — system-prompt phrase + reveal/output verb
  '시스템.{0,4}프롬프트.{0,16}(출력|공개|보여|알려|노출|말해)'
  '(출력|공개|보여|알려|노출).{0,16}시스템.{0,4}프롬프트'
  # "reveal your instructions/rules"
  '(너의|당신의|네).{0,8}(지시사항|지침|규칙|프롬프트).{0,16}(공개|출력|보여|알려|노출)'
  # "developer mode" activation
  '개발자.{0,2}모드.{0,12}(활성화|켜|진입|전환)'
)

# Encoding-evasion markers — base64 of common injection tokens. Case-significant
# (base64 alphabet) → matched as fixed strings. Standard encodings of
# "ignore"/"system prompt"/"instruction", unlikely to occur by accident.
EVASION_PATTERNS=(
  'aWdub3Jl'            # base64("ignore")
  'c3lzdGVtIHByb21wdA'  # base64("system prompt") — at trailing edge of payload
  'c3lzdGVtIHByb21wdC'  # base64("system prompt ") — followed by a space + more text
  'aW5zdHJ1Y3Rpb24'     # base64("instruction")
  'c3lzdGVtIHByb21wdHM' # base64("system prompts")
)

LOWER_CONTENT=$(printf '%s\n' "${CONTENT}" | tr '[:upper:]' '[:lower:]')

# SEC-070 advisory: English injection pattern hit (case-insensitive on lowercased).
for pattern in "${PATTERNS[@]}"; do
  if printf '%s\n' "${LOWER_CONTENT}" | grep -qiE "${pattern}"; then
    emit_error "SEC-070" "advisory" \
      "Prompt injection pattern detected" \
      "프롬프트 인젝션 패턴 감지" \
      "Verify content is intentional; not an injection attempt" \
      "의도된 내용인지 확인하세요; 인젝션 시도가 아닌지 점검"
    exit 0
  fi
done

# SEC-070 advisory: Korean injection pattern hit. Korean is caseless → match the
# original content (lowercasing only folds ASCII and would not help here).
for pattern in "${KO_PATTERNS[@]}"; do
  if printf '%s\n' "${CONTENT}" | grep -qE "${pattern}"; then
    emit_error "SEC-070" "advisory" \
      "Prompt injection pattern detected (Korean)" \
      "프롬프트 인젝션 패턴 감지 (한국어)" \
      "Verify content is intentional; not an injection attempt" \
      "의도된 내용인지 확인하세요; 인젝션 시도가 아닌지 점검"
    exit 0
  fi
done

# SEC-072 advisory: encoding-evasion marker. base64 is case-significant → match
# the original content (NOT the lowercased copy).
for pattern in "${EVASION_PATTERNS[@]}"; do
  if printf '%s\n' "${CONTENT}" | grep -qF "${pattern}"; then
    emit_error "SEC-072" "advisory" \
      "Encoded injection marker detected" \
      "인코딩된 인젝션 마커 감지" \
      "Verify base64/encoded payload is intentional, not an evasion attempt" \
      "base64/인코딩 페이로드가 의도된 것인지 확인하세요; 우회 시도가 아닌지 점검"
    exit 0
  fi
done

# Zero-width / invisible Unicode detection (zero-width space, joiner, BOM, etc.).
# The helper signals via a TRISTATE exit code, NOT a binary success/failure:
#   0 = scanned clean (no suspects) · 1 = suspects found (fire advisory) ·
#   any other code = a python tooling failure (interpreter absent, crash, OOM).
# A tooling failure MUST NOT be conflated with a positive detection — the prior
# `if python3 …; then pass; else advisory; fi` form fired a false SEC-071 on every
# non-zero exit, so a python crash looked identical to a real zero-width hit.
# Capturing the exact exit code lets a genuine error fail-open (no advisory),
# matching the advisory-only, never-block contract.
zw_rc=0
printf '%s\n' "${CONTENT}" | python3 -c "
import sys
text = sys.stdin.read()
suspects = [c for c in text if ord(c) in (0x200B, 0x200C, 0x200D, 0xFEFF, 0x2060, 0x180E)]
sys.exit(0 if not suspects else 1)
" 2>/dev/null || zw_rc=$?

if [[ "${zw_rc}" -eq 1 ]]; then
  emit_error "SEC-071" "advisory" \
    "Suspicious Unicode characters detected" \
    "유니코드 비정상 문자 감지" \
    "Verify zero-width/invisible characters are intentional" \
    "제로 폭/보이지 않는 문자가 의도된 것인지 확인하세요"
fi
# Clean (0) or tooling failure (other) → no advisory. Never block.
exit 0
