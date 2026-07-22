#!/usr/bin/env bash
# PostToolUse(Write) — Outcome → progress.md status sync.
# Why: GLOBAL_RULES Cross-Session Continuity auto-completes a progress file when its owning
# task's Outcome Record = `result: done`. This hook watches Write events for new outcome files,
# then flips the status of any open progress file whose slug the outcome references.
# Matching rule (conservative — false positives worse than misses):
#   1. path ends in /.glass-atrium/data/outcomes/*.md (canonical) OR /memory/outcomes/*.md (deprecated
#      legacy stray matches; primary sink is PG core.outcomes, not the file system).
#   2. frontmatter contains `result: done`.
#   3. slug (length >= 4) appears verbatim in the outcome body/frontmatter; short slugs ignored
#      to avoid noise ("api"/"ui").
# Always exits 0 — never blocks downstream PostToolUse hooks.

set -Eeuo pipefail
IFS=$'\n\t'

# Resolve sibling script dir portably.
_HOOK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=/dev/null
source "${_HOOK_DIR}/hook-utils.sh"
# shellcheck source=/dev/null
source "${_HOOK_DIR}/../scripts/progress-tracker.sh"

INPUT="$(hook_read_input)"
[[ "${INPUT}" == "{}" ]] && exit 0

TOOL_NAME="$(hook_get_field "${INPUT}" "tool_name")"
[[ "${TOOL_NAME}" == "Write" ]] || exit 0

FILE_PATH="$(hook_get_tool_input "${INPUT}" "file_path")"
[[ -n "${FILE_PATH}" ]] || exit 0

# Path filter — outcome records only (canonical /.glass-atrium/data/outcomes/*.md · deprecated
# legacy /memory/outcomes/*.md for stray writes).
case "${FILE_PATH}" in
  */.glass-atrium/data/outcomes/*.md) ;;
  */memory/outcomes/*.md) ;;
  *) exit 0 ;;
esac

# File must actually exist (PostToolUse fires after the write completes).
[[ -f "${FILE_PATH}" ]] || exit 0

# Parse `result:` from outcome frontmatter. Bounded read keeps it cheap.
RESULT_VAL="$(
  awk '
    /^---[[:space:]]*$/ { fence++; if (fence == 2) exit; next }
    fence == 1 && /^result:[[:space:]]*/ {
      sub(/^result:[[:space:]]*/, "")
      gsub(/[[:space:]"\047]/, "")
      print
      exit
    }
  ' "${FILE_PATH}" 2>/dev/null
)"

[[ "${RESULT_VAL}" == "done" ]] || exit 0

# Collect open progress files. Empty list = nothing to do.
mapfile_safe_open_progress() {
  # progress_list_open prints absolute paths newline-separated, exit 0 if none.
  # Bash 3.2 lacks mapfile, so read into a positional array via process subst.
  local line
  # shellcheck disable=SC2312  # progress_list_open returns 0 by contract
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    OPEN_FILES+=("${line}")
  done < <(progress_list_open)
}

OPEN_FILES=()
mapfile_safe_open_progress

[[ ${#OPEN_FILES[@]} -gt 0 ]] || exit 0

# Read the outcome file once into a variable for substring scans.
OUTCOME_TEXT="$(cat -- "${FILE_PATH}" 2>/dev/null || printf '%s' '')"
[[ -n "${OUTCOME_TEXT}" ]] || exit 0

MATCHED_COUNT=0
for progress_file in "${OPEN_FILES[@]}"; do
  # Extract slug from frontmatter — sole authoritative source.
  slug="$(
    awk '
      /^---[[:space:]]*$/ { fence++; if (fence == 2) exit; next }
      fence == 1 && /^slug:[[:space:]]*/ {
        sub(/^slug:[[:space:]]*/, "")
        gsub(/^["\047]|["\047]$/, "")
        print
        exit
      }
    ' "${progress_file}" 2>/dev/null
  )"

  # Conservative gating: skip empty/short slugs to avoid noisy matches
  # against common substrings ("api", "ui", etc.).
  [[ -n "${slug}" ]] || continue
  [[ ${#slug} -ge 4 ]] || continue

  # Substring presence — case-sensitive. Slugs are lowercase ASCII.
  case "${OUTCOME_TEXT}" in
    *"${slug}"*)
      progress_complete "${slug}" || true
      MATCHED_COUNT=$((MATCHED_COUNT + 1))
      ;;
    *) ;;
  esac
done

if ((MATCHED_COUNT > 0)); then
  emit_error "DATA-074" "info" \
    "Progress file(s) auto-completed via outcome sync" \
    "N/A (automatic)" \
    "{\"matched\":${MATCHED_COUNT},\"outcome\":\"${FILE_PATH}\"}"
fi

exit 0
