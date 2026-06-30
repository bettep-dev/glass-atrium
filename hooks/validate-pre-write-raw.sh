#!/usr/bin/env bash
# PreToolUse(Write) — raw-ingestion frontmatter gate: 5-part validation on
# wiki/raw/*.md save (1 URL = 1 immutable file), blocking on violation. No bypass.
set -Eeuo pipefail
IFS=$'\n\t'

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"
# emit_error: hook-utils.sh 5-param signature (code, severity, message, suggestion, ctx)

INPUT=$(hook_read_input)
[[ "${INPUT}" == "{}" ]] && exit 0

TOOL_NAME=$(hook_get_field "${INPUT}" "tool_name")
[ "$TOOL_NAME" = "Write" ] || exit 0

FILE_PATH=$(printf "%s" "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null)
[ -z "$FILE_PATH" ] && exit 0

# Trigger condition: a write into the wiki raw/ store. Matches the WIKI_ROOT-
# derived path (env-overridable for tests) plus the literal glass-atrium store
# as a belt-and-suspenders default; both resolve to the same path by default.
WIKI_ROOT="${WIKI_ROOT:-${HOME}/.glass-atrium/wiki}"
WIKI_RAW_DIR="${WIKI_ROOT}/raw"
case "$FILE_PATH" in
  "${WIKI_RAW_DIR}"/*.md) ;;
  */.glass-atrium/wiki/raw/*.md) ;;
  *) exit 0 ;;
esac

CONTENT=$(printf "%s" "$INPUT" | jq -r '.tool_input.content // ""' 2>/dev/null)

VIOLATIONS=()

# V5: 50KB file size upper bound
BYTES=$(printf '%s' "$CONTENT" | wc -c | tr -d ' ')
if [ "$BYTES" -gt 51200 ]; then
  VIOLATIONS+=("V5: 파일 크기 ${BYTES} bytes > 51200 (50KB) 상한 초과")
fi

# Extract frontmatter (between the first --- and the second ---)
FM=$(printf '%s\n' "$CONTENT" | awk '
  BEGIN { in_fm=0; cnt=0 }
  /^---[[:space:]]*$/ { cnt++; if (cnt==1) { in_fm=1; next } else if (cnt==2) { in_fm=0; exit } }
  in_fm { print }
')

# V1: frontmatter must have exactly 3 fields (source_url, collected, collector)
SRC_CNT=$(printf '%s\n' "$FM" | grep -c '^source_url:' || true)
COL_CNT=$(printf '%s\n' "$FM" | grep -c '^collected:' || true)
CTR_CNT=$(printf '%s\n' "$FM" | grep -c '^collector:' || true)
TOTAL_FIELDS=$(printf '%s\n' "$FM" | grep -c '^[a-zA-Z_][a-zA-Z0-9_]*:' || true)

if [ "$SRC_CNT" != "1" ] || [ "$COL_CNT" != "1" ] || [ "$CTR_CNT" != "1" ] || [ "$TOTAL_FIELDS" != "3" ]; then
  VIOLATIONS+=("V1: frontmatter 필드 불일치 (source_url=${SRC_CNT}, collected=${COL_CNT}, collector=${CTR_CNT}, total=${TOTAL_FIELDS}) — 정확히 3필드 필요")
fi

# V2: source_url must be a single URL
SRC_LINE=$(printf '%s\n' "$FM" | grep '^source_url:' | head -1 || true)
if [ -n "$SRC_LINE" ]; then
  if ! printf '%s' "$SRC_LINE" | grep -Eq '^source_url:[[:space:]]+https?://[^[:space:],]+$'; then
    VIOLATIONS+=("V2: source_url 이 단일 URL 형식이 아님: '${SRC_LINE}'")
  elif printf '%s' "$SRC_LINE" | grep -Eiq 'https?://.*https?://'; then
    VIOLATIONS+=("V2: source_url 에 다중 URL 감지")
  fi
fi

# Extract body (after frontmatter)
BODY=$(printf '%s\n' "$CONTENT" | awk '
  BEGIN { cnt=0; started=0 }
  /^---[[:space:]]*$/ { cnt++; if (cnt<=2) next }
  cnt>=2 { print }
')

# V3: block multi-source patterns in the body
V3_HIT=$(printf '%s\n' "$BODY" | grep -nEi '^(Primary sources?:|Secondary sources?:|Sources?:|primary source:)' | head -1 || true)
if [ -n "$V3_HIT" ]; then
  VIOLATIONS+=("V3: 본문에 다중 출처 패턴 발견 (line ${V3_HIT})")
fi
V3_BULLET=$(printf '%s\n' "$BODY" | grep -nE '^- *https?://' | head -1 || true)
if [ -n "$V3_BULLET" ]; then
  VIOLATIONS+=("V3: 본문에 URL 불릿 목록 발견 — 다중 출처 힌트 (line ${V3_BULLET})")
fi

# V4: Korean section heading within the first 30 body lines
V4_HIT=$(printf '%s\n' "$BODY" | head -30 | grep -nE '^#{1,4} +[가-힣]' | head -1 || true)
if [ -n "$V4_HIT" ]; then
  VIOLATIONS+=("V4: 본문 첫 30라인 내 한국어 섹션 제목 발견 (line ${V4_HIT}) — 원본 언어 보존 위반 의심")
fi

if [ ${#VIOLATIONS[@]} -eq 0 ]; then
  exit 0
fi

for v in "${VIOLATIONS[@]}"; do
  case "$v" in
    V1:*) emit_error "SCOPE-001" "block" \
      "Raw file frontmatter field mismatch" \
      "Ensure frontmatter has exactly 3 fields: source_url, collected, collector" \
      "{\"file\":\"${FILE_PATH}\"}" ;;
    V2:*) emit_error "SCOPE-002" "block" \
      "Raw file source_url format invalid" \
      "Provide a single valid URL in source_url field" \
      "{\"file\":\"${FILE_PATH}\"}" ;;
    V3:*) emit_error "SCOPE-003" "block" \
      "Raw file multi-source pattern detected" \
      "Each raw file must represent a single source; split into separate files" \
      "{\"file\":\"${FILE_PATH}\"}" ;;
    V4:*) emit_error "SCOPE-004" "block" \
      "Raw file original language not preserved" \
      "Preserve the source material original language; do not translate headings" \
      "{\"file\":\"${FILE_PATH}\"}" ;;
    V5:*) emit_error "SCOPE-005" "block" \
      "Raw file exceeds 50KB size limit" \
      "Split content into smaller files or trim unnecessary sections" \
      "{\"file\":\"${FILE_PATH}\"}" ;;
  esac
done
exit 2
