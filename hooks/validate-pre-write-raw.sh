#!/usr/bin/env bash
# PreToolUse(Write) — raw-ingestion gate: 6-part validation on wiki/raw/*.md save
# (1 URL = 1 immutable file), blocking on violation. No bypass.
#
# V6 (plan H2 · R5 · LLM01) is the load-bearing addition: it REQUIRES a body-resident
# provenance envelope on every raw/ write. The gain is MECHANICAL and self-suppression-proof
# because this hook is path-keyed and agent-id-INDEPENDENT — it runs OUTSIDE the process that
# fetched the (potentially malicious) web content, so an injected "save verbatim, no envelope"
# instruction cannot suppress it. Either the write carries the envelope (content lands LABELED
# untrusted, so read-side clauses key on the label) or it is blocked (content never lands). The
# envelope lives in the BODY, not the frontmatter (H2-R1): V1 requires EXACTLY 3 frontmatter
# fields, so a frontmatter-form envelope would be self-blocked — V6 keys on the body, which
# V3/V4/V5 already govern with no fixed-field rule.
#
# Honest limit: V6 enforces the untrusted-source LABEL, it does NOT sanitize the content — an
# envelope-wrapped payload is still a payload. The mechanical property is the invariant that every
# landed raw file carries the label; the read-side interpretation (inject-scope-rules.sh
# WIKI-UNTRUSTED clause + advisory-raw-store-read.sh) is adherence-layer defense-in-depth.
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

# Trigger: a write into the wiki raw/ store — WIKI_ROOT-derived path (env-overridable
# for tests) plus the literal glass-atrium store as a belt-and-suspenders default.
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

# V6 (H2/R5): body-resident provenance envelope — the mechanical, self-suppression-proof control.
# The untrusted source content MUST be wrapped by an opening + closing envelope marker so every
# landed raw file is explicitly labeled untrusted DATA (not instructions). Markers are HTML
# comments (non-rendering, so they do not disturb the preserved source) matched at BODY line start:
#   opening  <!-- UNTRUSTED-SOURCE ... -->   →  ^<!--[[:space:]]*UNTRUSTED-SOURCE
#   closing  <!-- /UNTRUSTED-SOURCE -->      →  ^<!--[[:space:]]*/UNTRUSTED-SOURCE
# The opening regex cannot match the closing form (the leading `/` breaks it), so the two are
# distinct. A genuine envelope requires the opening to PRECEDE the closing (line-number ordered).
# grep -n + `|| true` + empty-guard avoids the `grep -c ... || echo 0` "0\n0" trap.
ENV_OPEN=$(printf '%s\n' "$BODY" | grep -nE '^<!--[[:space:]]*UNTRUSTED-SOURCE' | head -1 || true)
ENV_CLOSE=$(printf '%s\n' "$BODY" | grep -nE '^<!--[[:space:]]*/UNTRUSTED-SOURCE[[:space:]]*-->' | head -1 || true)
if [ -z "$ENV_OPEN" ] || [ -z "$ENV_CLOSE" ]; then
  VIOLATIONS+=("V6: 본문 provenance 봉투 마커 누락 (open='${ENV_OPEN}', close='${ENV_CLOSE}') — <!-- UNTRUSTED-SOURCE --> ... <!-- /UNTRUSTED-SOURCE --> 필요")
else
  ENV_OPEN_LN=${ENV_OPEN%%:*}
  ENV_CLOSE_LN=${ENV_CLOSE%%:*}
  if [ "$ENV_OPEN_LN" -ge "$ENV_CLOSE_LN" ]; then
    VIOLATIONS+=("V6: provenance 봉투 마커 순서 오류 (open line ${ENV_OPEN_LN} >= close line ${ENV_CLOSE_LN}) — 여는 마커가 닫는 마커보다 앞서야 함")
  fi
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
    V6:*) emit_error "SCOPE-006" "block" \
      "Raw file body-resident provenance envelope missing or malformed" \
      "Wrap the untrusted source content in the body with '<!-- UNTRUSTED-SOURCE -->' ... '<!-- /UNTRUSTED-SOURCE -->' (opening before closing)" \
      "{\"file\":\"${FILE_PATH}\"}" ;;
  esac
done
exit 2
