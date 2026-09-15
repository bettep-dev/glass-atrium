#!/usr/bin/env bash
# PreToolUse(Write|Edit) raw-ingestion gate for wiki/raw/*.md (1 URL = 1 immutable file), no bypass.
# Blocks (exit 2): V1 frontmatter fields · V2 single URL · V5 50KB · V6 body envelope · V7 any Edit · V8 symlinked destination.
# V6 is self-suppression-proof: path-keyed and agent-id-independent, it runs outside the process that fetched the content.
#
# Honest limits:
# - V6 enforces the untrusted-source LABEL, never sanitizes the content; read-side clauses are adherence-layer only.
# - V8 asserts destination state at check time, not a race control; only the destination and its immediate parent are tested.
# - SCOPE-009 is advisory telemetry (exit 0): Write immutability is policy only, and delete-then-Write is silent by design.
# - stderr on an exit-0 PreToolUse is not shown to be model-visible; the fired log, written only with transcript_path, is the record.
# - SCOPE-010 (fetch ledger) is advisory telemetry and sees WebFetch only: Bash curl, MCP fetch tools and content handed in
#   through a delegation prompt are invisible (the last raises a false SCOPE-010). It records URLs, never content.
# - A matched fetch proves no body match: WebFetch returns model-processed text, not page bytes.
# - The PreToolUse transcript_path target for a subagent is unmeasured; the resolver covers the parent and the own file.
#   An unresolved transcript or a failed scanner is silent on stderr and logs ledger=unavailable, never a false code.
# RAW_FETCH_LEDGER_PY: scanner-only interpreter (default python3); envelope parsing stays on PATH python3
set -Eeuo pipefail
IFS=$'\n\t'

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

RAW_FETCH_LEDGER_FIRED_LOG="${RAW_FETCH_LEDGER_FIRED_LOG:-${HOOK_DATA_DIR}/raw-fetch-ledger-fired.log}"

INPUT=$(hook_read_input)
[[ "${INPUT}" == "{}" ]] && exit 0

TOOL_NAME=$(hook_get_field "${INPUT}" "tool_name")
case "${TOOL_NAME}" in
  Write | Edit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(printf "%s" "${INPUT}" | jq -r '.tool_input.file_path // ""' 2>/dev/null)
[[ -z "${FILE_PATH}" ]] && exit 0

# Physical path of ${1}, which need not exist yet: canonicalize the deepest EXISTING ancestor, re-append the missing tail.
# BSD realpath fails on a missing leaf and readlink -f is absent on macOS → `cd -P` + `pwd -P` is the portable form.
# A `..` inside the missing tail stays textual → can only over-match containment (an extra trigger, never a skipped one).
canon_path() {
  local p="${1}" base rest="" dir up phys
  base="${p##*/}"
  dir="${p%/*}"
  [[ "${dir}" == "${p}" ]] && dir="."
  while [[ ! -d "${dir}" ]]; do
    rest="${dir##*/}${rest:+/}${rest}"
    up="${dir%/*}"
    [[ "${up}" == "${dir}" ]] && up="/"
    dir="${up}"
  done
  phys=$(cd -P "${dir}" 2>/dev/null && pwd -P) || return 1
  printf '%s' "${phys%/}/${rest:+${rest}/}${base}"
}

# Trigger = UNION of the WIKI_ROOT-derived path, the literal glass-atrium store, and physical containment.
# The physical arm catches dot-dot traversal and inbound symlinks; both sides are canonicalized (macOS /tmp → /private/tmp).
# Never a replacement: a store whose own raw/ is a symlink canonicalizes out of the physical arm.
WIKI_ROOT="${WIKI_ROOT:-${HOME}/.glass-atrium/wiki}"
WIKI_RAW_DIR="${WIKI_ROOT}/raw"
case "${FILE_PATH}" in
  "${WIKI_RAW_DIR}"/*.md) ;;
  */.glass-atrium/wiki/raw/*.md) ;;
  *)
    # Deferred to this arm → non-matching writes pay no subshell. The `||` literal fallback is the intended
    # set -e disabling (SC2310): an unresolvable span leaves the literal arms in charge, never aborts the gate.
    # shellcheck disable=SC2310
    PHYS_FILE=$(canon_path "${FILE_PATH}" || printf '%s' "${FILE_PATH}")
    # shellcheck disable=SC2310
    PHYS_RAW_DIR=$(canon_path "${WIKI_RAW_DIR}" || printf '%s' "${WIKI_RAW_DIR}")
    case "${PHYS_FILE}" in
      "${PHYS_RAW_DIR}"/*.md) ;;
      */.glass-atrium/wiki/raw/*.md) ;;
      *) exit 0 ;;
    esac
    ;;
esac

# V7: no sanctioned Edit flow exists (legacy-envelope backfill is forbidden) → any Edit blocks; correction = delete + Write.
if [[ "${TOOL_NAME}" = "Edit" ]]; then
  emit_error "SCOPE-007" "block" \
    "Raw store is immutable — Edit forbidden" \
    "Delete the raw file and re-save the corrected full content via Write (V1-V6 re-validated)" \
    "{\"file\":\"${FILE_PATH}\"}"
  exit 2
fi

# V8: symlink-ness only, never existence — a new destination under a real parent falls through to the content checks.
PARENT_DIR="${FILE_PATH%/*}"
if [[ -L "${FILE_PATH}" ]] || [[ -L "${PARENT_DIR}" ]]; then
  emit_error "SCOPE-008" "block" \
    "Raw destination state rejected — destination or its parent directory is a symbolic link" \
    "Write to a real path inside the raw store: remove the link and re-save, or correct the store layout" \
    "{\"file\":\"${FILE_PATH}\",\"parent\":\"${PARENT_DIR}\"}"
  exit 2
fi

CONTENT=$(printf "%s" "${INPUT}" | jq -r '.tool_input.content // ""' 2>/dev/null)

VIOLATIONS=()

# V5: 50KB upper bound
BYTES=$(printf '%s' "${CONTENT}" | wc -c | tr -d ' ')
if [[ "${BYTES}" -gt 51200 ]]; then
  VIOLATIONS+=("V5: ${BYTES} bytes over the 51200-byte limit")
fi

# Frontmatter = lines between the first and second ---
FM=$(printf '%s\n' "${CONTENT}" | awk '
  BEGIN { in_fm=0; cnt=0 }
  /^---[[:space:]]*$/ { cnt++; if (cnt==1) { in_fm=1; next } else if (cnt==2) { in_fm=0; exit } }
  in_fm { print }
')

# V1: exactly 3 fields (source_url, collected, collector)
SRC_CNT=$(printf '%s\n' "${FM}" | grep -c '^source_url:' || true)
COL_CNT=$(printf '%s\n' "${FM}" | grep -c '^collected:' || true)
CTR_CNT=$(printf '%s\n' "${FM}" | grep -c '^collector:' || true)
TOTAL_FIELDS=$(printf '%s\n' "${FM}" | grep -c '^[a-zA-Z_][a-zA-Z0-9_]*:' || true)

if [[ "${SRC_CNT}" != "1" ]] || [[ "${COL_CNT}" != "1" ]] || [[ "${CTR_CNT}" != "1" ]] || [[ "${TOTAL_FIELDS}" != "3" ]]; then
  VIOLATIONS+=("V1: frontmatter needs exactly source_url, collected, collector")
fi

# V2: source_url is a single URL
SRC_LINE=$(printf '%s\n' "${FM}" | grep '^source_url:' | head -1 || true)
if [[ -n "${SRC_LINE}" ]]; then
  if ! printf '%s' "${SRC_LINE}" | grep -Eq '^source_url:[[:space:]]+https?://[^[:space:],]+$'; then
    VIOLATIONS+=("V2: source_url is not a single URL")
  elif printf '%s' "${SRC_LINE}" | grep -Eiq 'https?://.*https?://'; then
    VIOLATIONS+=("V2: source_url carries several URLs")
  fi
fi

BODY=$(printf '%s\n' "${CONTENT}" | awk '
  BEGIN { cnt=0; started=0 }
  /^---[[:space:]]*$/ { cnt++; if (cnt<=2) next }
  cnt>=2 { print }
')

# V3 vacant: a body pasting several pages under one declared URL is caught by no check; V1/V2 hold only the frontmatter half.
# V4 vacant: no translation check — a language signal cannot tell a translated source from one written in that language.

# V6: body-resident envelope, opening marker on an earlier line than the closing one; markers are HTML comments (non-rendering).
# The opening regex cannot match the closing form — the leading `/` breaks it.
ENV_OPEN=$(printf '%s\n' "${BODY}" | grep -nE '^<!--[[:space:]]*UNTRUSTED-SOURCE' | head -1 || true)
ENV_CLOSE=$(printf '%s\n' "${BODY}" | grep -nE '^<!--[[:space:]]*/UNTRUSTED-SOURCE[[:space:]]*-->' | head -1 || true)
if [[ -z "${ENV_OPEN}" ]] || [[ -z "${ENV_CLOSE}" ]]; then
  VIOLATIONS+=("V6: envelope marker missing")
else
  ENV_OPEN_LN=${ENV_OPEN%%:*}
  ENV_CLOSE_LN=${ENV_CLOSE%%:*}
  if [[ "${ENV_OPEN_LN}" -ge "${ENV_CLOSE_LN}" ]]; then
    VIOLATIONS+=("V6: opening envelope marker does not precede the closing one")
  fi
fi

# One fired-log TSV line; the subshell contains every failure, so an unwritable log degrades to silence.
# Args: $1=codes $2=ledger state $3=reason.
write_fired_log() {
  local codes="${1}" ledger="${2}" reason="${3}"
  (
    local host ts
    host="${SRC_LINE#*://}"
    host="${host%%[/?#]*}"
    host="${host##*@}"
    ts=$(python3 -c 'import datetime as d; t=d.datetime.now(d.timezone.utc); print(t.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (t.microsecond // 1000))') \
      || ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    mkdir -p -- "${RAW_FETCH_LEDGER_FIRED_LOG%/*}"
    printf '%s\tcodes=%s\thost=%s\tsession=%s\tledger=%s\treason=%s\n' \
      "${ts}" "${codes}" "${host}" "${SESSION_ID}" "${ledger}" "${reason}" >>"${RAW_FETCH_LEDGER_FIRED_LOG}"
  ) 2>/dev/null || true
}

# Subagent's own transcript under both layouts (flat, workflows/wf_*), envelope project dir first, then ~/.claude/projects.
# Never the parent transcript: it holds none of the subagent's fetches, so reading it raises a false SCOPE-010.
find_subagent_transcript() {
  local name="agent-${AGENT_ID}.jsonl" root candidate
  local -a roots=("${HOME}/.claude/projects/"*)
  [[ "${AGENT_ID}" =~ ^[A-Za-z0-9_-]+$ && "${SESSION_ID}" =~ ^[A-Za-z0-9_-]+$ ]] || return 1
  [[ -z "${TRANSCRIPT_PATH}" ]] || roots=("${TRANSCRIPT_PATH%/*}" "${roots[@]}")
  for root in "${roots[@]}"; do
    for candidate in "${root}/${SESSION_ID}/subagents/${name}" "${root}/${SESSION_ID}/subagents/workflows/"wf_*"/${name}"; do
      [[ -f "${candidate}" ]] || continue
      printf '%s' "${candidate}"
      return 0
    done
  done
  return 1
}

# Transcript the ledger scans: the envelope file for the main session or when it already names agent-<id>.jsonl.
resolve_transcript() {
  if [[ -z "${AGENT_ID}" ]] || [[ "${TRANSCRIPT_PATH##*/}" == "agent-${AGENT_ID}.jsonl" ]]; then
    [[ -n "${TRANSCRIPT_PATH}" && -f "${TRANSCRIPT_PATH}" ]] || return 1
    printf '%s' "${TRANSCRIPT_PATH}"
    return 0
  fi
  find_subagent_transcript
}

# Prints match=1 when the declared URL has a WebFetch whose paired result is 2xx and not is_error, else match=0.
# Args: $1=transcript $2=declared URL.
run_scanner() {
  "${RAW_FETCH_LEDGER_PY:-python3}" - "${1}" "${2}" <<'PY'
import json
import sys

transcript, declared = sys.argv[1], sys.argv[2]
fetch_ids = set()
matched = False
with open(transcript, "rb") as lines:
    for line in lines:
        if b'"WebFetch"' not in line and b"toolUseResult" not in line:
            continue
        entry = json.loads(line)
        content = (entry.get("message") or {}).get("content")
        result = entry.get("toolUseResult")
        code = result.get("code") if isinstance(result, dict) else None
        for item in content if isinstance(content, list) else []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "tool_use" and item.get("name") == "WebFetch":
                if (item.get("input") or {}).get("url") == declared:
                    fetch_ids.add(item.get("id"))
            elif item.get("type") == "tool_result" and item.get("tool_use_id") in fetch_ids:
                if not item.get("is_error") and isinstance(code, int) and 200 <= code < 300:
                    matched = True
print("match=%d" % matched)
PY
}

# Scanner contract: exactly one `match=<0|1>` line and exit 0. Anything else is a failure (return 1), never a no-match,
# because a misread failure would raise a false SCOPE-010. Prints 0 or 1. Args: $1=transcript $2=declared URL.
scan_transcript() {
  local out
  # shellcheck disable=SC2310
  out=$(run_scanner "${1}" "${2}" 2>/dev/null) || return 1
  [[ "${out}" == "match=0" || "${out}" == "match=1" ]] || return 1
  printf '%s' "${out#match=}"
}

# Sets LEDGER_STATE, LEDGER_REASON and LEDGER_CODES; emits SCOPE-010 when the scan finds no successful fetch.
run_ledger() {
  local transcript url match
  LEDGER_STATE="unavailable"
  LEDGER_REASON="transcript"
  LEDGER_CODES=""
  # shellcheck disable=SC2310
  transcript=$(resolve_transcript) || return 0
  LEDGER_REASON="scanner"
  url="${SRC_LINE#source_url:}"
  url="${url#"${url%%[![:space:]]*}"}"
  # shellcheck disable=SC2310
  match=$(scan_transcript "${transcript}" "${url}") || return 0
  LEDGER_STATE="ok"
  LEDGER_REASON="-"
  [[ "${match}" == "0" ]] || return 0
  emit_error "SCOPE-010" "warn" \
    "Declared source_url was not fetched by WebFetch in this session — body provenance is unverified" \
    "Fetch the declared source with WebFetch before saving, or declare the URL the content was fetched from" \
    "{\"file\":\"${FILE_PATH}\"}"
  LEDGER_CODES="SCOPE-010"
}

# Permit-path advisories: warn-severity stderr plus the fired log; the log is written only when the envelope carries
# transcript_path, and only when a code fired or the ledger was unavailable.
run_advisories() {
  local codes="" fields
  if [[ -f "${FILE_PATH}" ]]; then
    emit_error "SCOPE-009" "warn" \
      "Raw file already exists — raw files are immutable after save; this Write replaces an existing source file" \
      "Correction path is delete, then Write the corrected content" \
      "{\"file\":\"${FILE_PATH}\"}"
    codes="SCOPE-009"
  fi
  # Unit separator, not whitespace: an empty field must survive the split.
  fields=$(printf '%s' "${INPUT}" | jq -r '[.transcript_path, .agent_id, .session_id] | map(. // "" | tostring) | join("")') \
    || return 0
  IFS=$'\x1f' read -r TRANSCRIPT_PATH AGENT_ID SESSION_ID <<<"${fields}"
  run_ledger
  codes="${codes}${codes:+${LEDGER_CODES:+,}}${LEDGER_CODES}"
  [[ -n "${TRANSCRIPT_PATH}" ]] || return 0
  [[ -n "${codes}" || "${LEDGER_STATE}" == "unavailable" ]] || return 0
  write_fired_log "${codes:--}" "${LEDGER_STATE}" "${LEDGER_REASON}"
}

if [[ ${#VIOLATIONS[@]} -eq 0 ]]; then
  # Called from an `if` → errexit is off inside, so no advisory failure can change the exit status (SC2310 intended).
  # shellcheck disable=SC2310
  if ! run_advisories; then :; fi
  exit 0
fi

for v in "${VIOLATIONS[@]}"; do
  case "${v}" in
    V1:*) emit_error "SCOPE-001" "block" \
      "Raw file frontmatter field mismatch" \
      "Ensure frontmatter has exactly 3 fields: source_url, collected, collector" \
      "{\"file\":\"${FILE_PATH}\"}" ;;
    V2:*) emit_error "SCOPE-002" "block" \
      "Raw file source_url format invalid" \
      "Provide a single valid URL in source_url field" \
      "{\"file\":\"${FILE_PATH}\"}" ;;
    # SCOPE-003 and SCOPE-004 are retired, never reassigned.
    V5:*) emit_error "SCOPE-005" "block" \
      "Raw file exceeds 50KB size limit" \
      "Split content into smaller files or trim unnecessary sections" \
      "{\"file\":\"${FILE_PATH}\"}" ;;
    V6:*) emit_error "SCOPE-006" "block" \
      "Raw file body-resident provenance envelope missing or malformed" \
      "Wrap the untrusted source content in the body with '<!-- UNTRUSTED-SOURCE -->' ... '<!-- /UNTRUSTED-SOURCE -->' (opening before closing)" \
      "{\"file\":\"${FILE_PATH}\"}" ;;
    # Unreachable: VIOLATIONS only holds V1/V2/V5/V6 prefixes, and the exit 2 below blocks regardless.
    *) ;;
  esac
done
exit 2
