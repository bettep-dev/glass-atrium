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
# - SCOPE-010/011 (fetch ledger) are advisory telemetry and see WebFetch only.
# - Invisible to them: WebSearch snippets, Bash curl/gh and MCP fetch tools; the researcher holds WebSearch.
# - Content handed in through a delegation prompt is invisible too, and raises a false SCOPE-010.
# - The fired log records the source host only, never the full URL, query or content.
# - A matched fetch proves no body match: WebFetch returns model-processed text, not page bytes.
# - A result without toolUseResult carries no HTTP code.
#   Such a non-error result is a page unless its text opens with a harness failure prefix (HTTP status, redirect).
#   The prefix set is closed: a harness failure wording outside it counts as a page.
# - The redirect arm needs toolUseResult.url: without it a followed redirect leaves no final URL.
#   Declaring that final URL then raises SCOPE-010.
# - SCOPE-011 is correlated only: fetch-all-then-save-all raises a false positive.
#   Pages fetched before an earlier save and pasted later raise nothing (false negative).
# - The PreToolUse transcript_path target for a subagent is unmeasured; the resolver accepts either parent or own file.
# - For a subagent the ledger scans only the subagent's own transcript, never the parent.
# - An unresolved transcript or a failed scanner is silent on stderr and logs ledger=unavailable, never a false code.
#
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
    # Deferred to this arm → non-matching writes pay no subshell.
    # The `||` literal fallback disables set -e on purpose (SC2310): an unresolvable span never aborts the gate.
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
  BEGIN { cnt=0 }
  /^---[[:space:]]*$/ { cnt++; if (cnt<=2) next }
  cnt>=2 { print }
')

# V3 vacant: a body pasting several pages under one declared URL is caught by no check.
# V1/V2 hold only the frontmatter half of one-URL-per-file; SCOPE-011 is a weak correlated signal, not a replacement.
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
      || ts=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
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

# match=1: a WebFetch of the declared URL (input url, or result url after a redirect) has a page result.
# Page result: not an error, no harness failure text, and a 2xx code where toolUseResult records one.
# pages: distinct pages fetched after the last raw Write with a non-error result.
# Results pair with their tool_use by id alone: a result line names no tool. An unpaired raw Write is the one in flight.
# URLs compare normalized: http→https, lowercase scheme + host, no fragment, no trailing `/`, query kept.
# A malformed line is skipped, never fatal. Args: $1=transcript $2=declared URL $3=raw dir.
run_scanner() {
  "${RAW_FETCH_LEDGER_PY:-python3}" - "${1}" "${2}" "${3}" <<'PY'
import json
import sys
from urllib.parse import urlsplit, urlunsplit


def field(obj, key):
    return obj.get(key) if isinstance(obj, dict) else None


def normalize(url):
    if not isinstance(url, str):
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    scheme = "https" if parts.scheme.lower() == "http" else parts.scheme.lower()
    return urlunsplit((scheme, parts.netloc.lower(), parts.path.rstrip("/"), parts.query, ""))


def is_raw(path, raw_dir):
    return isinstance(path, str) and path.endswith(".md") and (
        path.startswith(raw_dir + "/") or "/.glass-atrium/wiki/raw/" in path
    )


# Harness-written text a non-error result carries instead of a page (an HTTP error status, a redirect not followed).
HARNESS_FAILURE_PREFIXES = ("The server returned HTTP ", "REDIRECT DETECTED: ")


def is_page(item, result):
    if field(item, "is_error"):
        return False
    body = field(item, "content")
    if isinstance(body, str) and body.startswith(HARNESS_FAILURE_PREFIXES):
        return False
    code = field(result, "code")
    return code is None or (isinstance(code, int) and 200 <= code < 300)


transcript, declared, raw_dir = sys.argv[1], normalize(sys.argv[2]), sys.argv[3]
pending_fetches = {}
pending_writes = {}
pages = []
window = -1
matched = False
with open(transcript, "rb") as lines:
    for position, line in enumerate(lines):
        # A result line names no tool → admitted by its pending id; a paired id is dropped and admits nothing more.
        if (
            b'"WebFetch"' not in line
            and b'"Write"' not in line
            and not any(fetch_id in line for fetch_id in pending_fetches)
            and not any(write_id in line for write_id in pending_writes)
        ):
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        content = field(field(entry, "message"), "content")
        result = field(entry, "toolUseResult")
        for item in content if isinstance(content, list) else []:
            kind = field(item, "type")
            item_id = field(item, "id") if kind == "tool_use" else field(item, "tool_use_id")
            if not isinstance(item_id, str):
                continue
            if kind == "tool_use" and field(item, "name") == "WebFetch":
                pending_fetches[item_id.encode()] = normalize(field(field(item, "input"), "url"))
            elif kind == "tool_use" and field(item, "name") == "Write":
                if is_raw(field(field(item, "input"), "file_path"), raw_dir):
                    pending_writes[item_id.encode()] = position
            elif kind == "tool_result" and item_id.encode() in pending_fetches:
                fetched = pending_fetches.pop(item_id.encode())
                ok = is_page(item, result)
                urls = (fetched, normalize(field(result, "url")))
                matched = matched or (ok and declared is not None and declared in urls)
                if ok and fetched is not None:
                    pages.append((position, fetched))
            elif kind == "tool_result" and item_id.encode() in pending_writes:
                started = pending_writes.pop(item_id.encode())
                if not field(item, "is_error"):
                    window = max(window, started)
page_count = len({url for position, url in pages if position > window})
print("match=%d\tpages=%d" % (matched, page_count))
PY
}

# Scanner contract: exactly one `match=<0|1>\tpages=<n>` line and exit 0; sets SCAN_MATCH and SCAN_PAGES.
# Anything else returns 1, never a no-match: a misread failure would raise a false SCOPE-010/011.
# Args: $1=transcript $2=declared URL.
scan_transcript() {
  local out contract=$'^match=([01])\tpages=([0-9]+)$'
  # shellcheck disable=SC2310
  out=$(run_scanner "${1}" "${2}" "${WIKI_RAW_DIR}" 2>/dev/null) || return 1
  [[ "${out}" =~ ${contract} ]] || return 1
  SCAN_MATCH="${BASH_REMATCH[1]}"
  SCAN_PAGES="${BASH_REMATCH[2]}"
}

# Sets LEDGER_STATE, LEDGER_REASON and LEDGER_CODES.
# SCOPE-010: no successful fetch of the declared URL. SCOPE-011: 2+ pages fetched since the last completed raw write.
run_ledger() {
  local transcript url
  LEDGER_STATE="unavailable"
  LEDGER_REASON="transcript"
  LEDGER_CODES=""
  # shellcheck disable=SC2310
  transcript=$(resolve_transcript) || return 0
  LEDGER_REASON="scanner"
  url="${SRC_LINE#source_url:}"
  url="${url#"${url%%[![:space:]]*}"}"
  # shellcheck disable=SC2310
  scan_transcript "${transcript}" "${url}" || return 0
  LEDGER_STATE="ok"
  LEDGER_REASON="-"
  if [[ "${SCAN_MATCH}" == "0" ]]; then
    emit_error "SCOPE-010" "warn" \
      "Declared source_url was not fetched by WebFetch in this session — body provenance is unverified" \
      "Fetch the declared source with WebFetch before saving, or declare the URL the content was fetched from" \
      "{\"file\":\"${FILE_PATH}\"}"
    LEDGER_CODES="SCOPE-010"
  fi
  if [[ "${SCAN_PAGES}" -ge 2 ]]; then
    emit_error "SCOPE-011" "warn" \
      "Several pages were fetched since the last raw save — a one-URL raw file may carry pasted content from more than one" \
      "Save each fetched page as its own raw file under its own source_url" \
      "{\"file\":\"${FILE_PATH}\"}"
    LEDGER_CODES="${LEDGER_CODES}${LEDGER_CODES:+,}SCOPE-011"
  fi
}

# Permit-path advisories: warn-severity stderr plus at most one fired-log line.
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
