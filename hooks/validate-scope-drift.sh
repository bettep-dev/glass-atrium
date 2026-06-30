#!/usr/bin/env bash
# PreToolUse(Edit|Write) — Scope Drift Detection
# Compares the plan's target-file list vs the actual edit target.
# Warns when a file outside the list is edited (exit 0, non-blocking).
set -Eeuo pipefail
IFS=$'\n\t'

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

# Monitor-API config — env-overridable (test isolation), loopback-pinned.
# Default-URL port consumed from the config-rendered env key (config.toml
# [ports].monitor → ATRIUM_MONITOR_PORT); non-numeric → default (URL-injection
# guard). A full SCOPE_DRIFT_MONITOR_URL override wins over the derived default.
monitor_port="${ATRIUM_MONITOR_PORT:-7842}"
[[ "${monitor_port}" =~ ^[0-9]+$ ]] || monitor_port=7842
MONITOR_URL="${SCOPE_DRIFT_MONITOR_URL:-http://127.0.0.1:${monitor_port}/api/clauded-docs}"
CURL_TIMEOUT="${SCOPE_DRIFT_CURL_TIMEOUT:-2}"

# Match file_path against the target-file list (newline-separated): full/partial path OR basename.
# Strips markdown list prefixes (- * N.), backticks, whitespace. Shared by both parsers below.
# Args: $1=file_path  $2=allowed_files. Returns: 0 = match, 1 = no match.
match_file_against_allowed() {
  local file_path="${1}" allowed_files="${2}"
  local file_basename line clean clean_basename
  file_basename="$(basename "${file_path}")"

  while IFS= read -r line; do
    [[ "${line}" =~ ^[[:space:]]*$ ]] && continue

    clean="$(echo "${line}" | sed -e 's/^[[:space:]]*[-*][[:space:]]*//' -e 's/^[[:space:]]*[0-9]*\.[[:space:]]*//')"
    clean="$(echo "${clean}" | tr -d '`')"
    clean="$(echo "${clean}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"

    [[ -z "${clean}" ]] && continue

    if [[ "${file_path}" == *"${clean}"* ]]; then
      return 0
    fi

    clean_basename="$(basename "${clean}")"
    if [[ "${file_basename}" == "${clean_basename}" ]]; then
      return 0
    fi
  done <<<"${allowed_files}"

  return 1
}

# Extract path-like tokens from the `<section id="target-files">` slice → newline list.
# Relies on the T1 flat-leaf contract (slices to the first </section>). sed-only (no awk).
# P1 nesting guard: a nested opening <section> in the slice violates the leaf contract → a
# truncated list could mis-fire SCOPE-070, so emit empty (fail-open, no guessing).
# Args: $1=html body. Prints cleaned list to stdout (empty on parse anomaly · always return 0).
extract_target_files_section() {
  local body="${1}"
  # Flatten to one line, then slice between opening tag and first </section>.
  local flattened from_open sliced
  flattened="$(printf '%s' "${body}" | tr '\n' ' ')"

  # After the opening tag (close not yet applied) — source for the nesting guard.
  from_open="$(printf '%s' "${flattened}" \
    | sed -n 's/.*<section[^>]*id="target-files"[^>]*>\(.*\)/\1/p')"
  [[ -z "${from_open}" ]] && return 0

  # Slice up to the first </section>.
  sliced="$(printf '%s' "${from_open}" | sed 's/<\/section>.*//')"
  [[ -z "${sliced}" ]] && return 0

  # P1 guard: nested opening <section> → leaf violation → fail-open.
  if printf '%s' "${sliced}" | grep -q '<section[^>]*>'; then
    return 0
  fi

  # <li>/<br> → newlines (one item per line), then strip remaining tags + decode entities.
  printf '%s' "${sliced}" \
    | sed 's/<li[^>]*>/\n/g; s/<\/li>/\n/g; s/<br[^>]*>/\n/g' \
    | sed 's/<[^>]*>//g' \
    | sed 's/&amp;/\&/g; s/&lt;/</g; s/&gt;/>/g'
}

# Drain stdin once — capture file_path before any branch (needed for the system-path
# short-circuit). Non-zero/empty input → fail-open.
INPUT=$(cat 2>/dev/null) || exit 0
FILE_PATH=$(echo "${INPUT}" | jq -r '.tool_input.file_path // ""' 2>/dev/null)

# System file paths always allowed — highest-priority short-circuit (silent, no advisory noise).
# Absent file_path → do NOT short-circuit (empty path is not a system path).
if [[ -n "${FILE_PATH}" ]] \
  && { [[ "${FILE_PATH}" == */memory/* ]] \
    || [[ "${FILE_PATH}" == */.claude/* ]] \
    || [[ "${FILE_PATH}" == */.claude-work/* ]]; }; then
  exit 0
fi

# PLAN_FILE unset → auto-restore per-file scope binding via the monitor API: pick the in-progress
# doc → GET its HTML body → parse `<section id="target-files">` → feed the same match loop.
# fail-open (a false-positive SCOPE-070 is forbidden): curl absent / monitor down / 0 or ambiguous
# docs / GET failure / section absent / 0 path-like tokens → pass silently, never promote to SCOPE-070.
if [[ -z "${PLAN_FILE:-}" ]]; then
  if ! command -v curl >/dev/null 2>&1; then
    exit 0
  fi

  # file_path absent → no per-file matching → skip the API call.
  [[ -z "${FILE_PATH}" ]] && exit 0

  # 1. List API → pick the in-progress doc ID. Response {"total":N,"rows":[...]}.
  #    Selection: newest created_at, tie → max id (deterministic). --max-time enforced.
  PLAN_LIST_JSON=""
  PLAN_LIST_JSON="$(curl -sf --max-time "${CURL_TIMEOUT}" "${MONITOR_URL}" 2>/dev/null || true)"
  [[ -z "${PLAN_LIST_JSON}" ]] && exit 0

  PLAN_ID=""
  PLAN_ID="$(printf '%s' "${PLAN_LIST_JSON}" \
    | jq -r '[.rows[]? | select(.doc_status == "progress")]
             | sort_by(.created_at // "", .id) | last | .id // empty' 2>/dev/null || true)"

  # No in-progress doc / parse failure → "absent" is NOT "drift" → fail-open.
  if [[ -z "${PLAN_ID}" ]] || [[ ! "${PLAN_ID}" =~ ^[0-9]+$ ]]; then
    exit 0
  fi

  # 2. GET-by-id → HTML body. Separate --max-time (double-call worst-case <5s).
  PLAN_DOC_JSON=""
  PLAN_DOC_JSON="$(curl -sf --max-time "${CURL_TIMEOUT}" "${MONITOR_URL}/${PLAN_ID}" 2>/dev/null || true)"
  [[ -z "${PLAN_DOC_JSON}" ]] && exit 0

  PLAN_BODY=""
  PLAN_BODY="$(printf '%s' "${PLAN_DOC_JSON}" | jq -r '.body // empty' 2>/dev/null || true)"
  [[ -z "${PLAN_BODY}" ]] && exit 0

  # 3. Parse target-files section. Separate assignment (function always returns 0) avoids SC2310.
  ALLOWED_FILES=""
  ALLOWED_FILES="$(extract_target_files_section "${PLAN_BODY}" 2>/dev/null)"

  # Section absent / extraction failure → fail-open. A suspect list is absorbed by the match loop.
  [[ -z "${ALLOWED_FILES}" ]] && exit 0
  # Pass if 0 path-like tokens (/ or .) — guards a whitespace/tag-residue slice.
  if ! printf '%s' "${ALLOWED_FILES}" | grep -q '[./]'; then
    exit 0
  fi

  # 4. Match → file outside the list → SCOPE-070 advisory (exit 0, non-blocking).
  #    Intended predicate call (explicit return 0/1, no set -e reliance) → SC2310 disabled.
  # shellcheck disable=SC2310
  if ! match_file_against_allowed "${FILE_PATH}" "${ALLOWED_FILES}"; then
    emit_error "SCOPE-070" "advisory" \
      "Scope drift: file not in plan target list" \
      "Scope drift: file not in plan target list" \
      "Update plan target files or confirm modification is intentional" \
      "Update plan target files or confirm the modification is intentional" \
      "{\"file\":\"${FILE_PATH}\",\"plan_id\":${PLAN_ID}}"
  fi
  exit 0
fi
[[ ! -f "${PLAN_FILE}" ]] && exit 0

# file_path absent → no per-file matching.
[[ -z "${FILE_PATH}" ]] && exit 0

# Read plan content into a variable first — TOCTOU defense. SC2155: separate declare/assign.
PLAN_CONTENT=""
if ! PLAN_CONTENT=$(cat "${PLAN_FILE}" 2>/dev/null) || [[ -z "${PLAN_CONTENT}" ]]; then
  hook_log "plan file read failed: ${PLAN_FILE}"
  exit 0
fi

# Extract from the `## Target Files` heading to the next ## (case-insensitive, English-only).
HEADING_RE='^##[[:space:]]+[Tt]arget [Ff]iles'
ALLOWED_FILES=$(echo "${PLAN_CONTENT}" | sed -E -n "/${HEADING_RE}/,/^## /{ /${HEADING_RE}/d; /^## /d; p; }")

# No target-files section → pass.
[[ -z "${ALLOWED_FILES}" ]] && exit 0

# Match → file outside the list → SCOPE-070 advisory (exit 0, non-blocking). SC2310 disabled (above).
# shellcheck disable=SC2310
if ! match_file_against_allowed "${FILE_PATH}" "${ALLOWED_FILES}"; then
  emit_error "SCOPE-070" "advisory" \
    "Scope drift: file not in plan target list" \
    "Scope drift: file not in plan target list" \
    "Update plan target files or confirm modification is intentional" \
    "Update plan target files or confirm the modification is intentional" \
    "{\"file\":\"${FILE_PATH}\"}"
fi

exit 0
