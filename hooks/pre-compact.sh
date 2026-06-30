#!/usr/bin/env bash
# pre-compact.sh — backup transcript + emit a "survival packet" before context compaction.
#
# Gathers open progress files + recent outcomes + active correlation IDs into a markdown packet
# a future SessionStart can re-inject — without it, auto-compact drops "what was unfinished".
# Side-effect only — never blocks, exit 0 always.

set -Eeuo pipefail
IFS=$'\n\t'

_HOOK_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# emit_error (structured stderr) — must precede any error path.
# shellcheck source=hook-utils.sh
source "${_HOOK_DIR}/hook-utils.sh"

# Source progress-tracker defensively — degrade silently if absent (transcript backup MUST run).
PROGRESS_TRACKER_AVAILABLE=0
if [[ -r "${_HOOK_DIR}/../scripts/progress-tracker.sh" ]]; then
  # shellcheck source=/dev/null
  if source "${_HOOK_DIR}/../scripts/progress-tracker.sh" 2>/dev/null; then
    PROGRESS_TRACKER_AVAILABLE=1
  fi
fi

# 1. Read hook input.
INPUT="$(cat 2>/dev/null)" || exit 0
SESSION_ID="$(printf '%s' "${INPUT}" | jq -r '.session_id // "unknown"' 2>/dev/null || printf '%s' "unknown")"
TRIGGER="$(printf '%s' "${INPUT}" | jq -r '.trigger // "unknown"' 2>/dev/null || printf '%s' "unknown")"
TRANSCRIPT="$(printf '%s' "${INPUT}" | jq -r '.transcript_path // ""' 2>/dev/null || printf '%s' "")"
TIMESTAMP="$(date +"%Y-%m-%d_%H-%M-%S")"

BACKUP_DIR="${HOME}/.claude/compact-backups"
mkdir -p -- "${BACKUP_DIR}"

# 2. Transcript backup — non-fatal on failure: warn so silent backup loss is visible.
if [[ -n "${TRANSCRIPT}" && -f "${TRANSCRIPT}" ]]; then
  if ! cp -- "${TRANSCRIPT}" "${BACKUP_DIR}/${TIMESTAMP}_${SESSION_ID}.jsonl" 2>/dev/null; then
    emit_error "DATA-191" "warn" \
      "pre-compact transcript backup failed" \
      "Check ${BACKUP_DIR} write permissions and free disk space" \
      "{\"session_id\":\"${SESSION_ID}\"}"
  fi
fi

# 3. Survival packet — built into a temp file then atomically moved (partial writes invisible to
# a concurrent SessionStart reader during a fast compact-then-resume).
SURVIVAL_PATH="${BACKUP_DIR}/${TIMESTAMP}_${SESSION_ID}_survival.md"
SURVIVAL_TMP="$(mktemp -t "compact-survival-XXXXXX")"
trap 'rm -f -- "${SURVIVAL_TMP}" 2>/dev/null || true' EXIT

# 3a. Collect outcome candidates once (shared by 3d + 3e). Path priority mirrors track-outcome.sh:
#   1. ~/.claude/data/outcomes/*.md (canonical) 2. ${PWD}/memory/outcomes/*.md (deprecated legacy).
# nullglob makes "no matches" expand to zero args.
prev_nullglob="$(shopt -p nullglob 2>/dev/null || printf '%s' '')"
shopt -s nullglob
outcome_candidates=()
if [[ -d "${HOME}/.claude/data/outcomes" ]]; then
  for f in "${HOME}"/.claude/data/outcomes/*.md; do
    outcome_candidates+=("${f}")
  done
fi
if [[ -d "${PWD}/memory/outcomes" ]]; then
  for f in "${PWD}"/memory/outcomes/*.md; do
    outcome_candidates+=("${f}")
  done
fi
if [[ -n "${prev_nullglob}" ]]; then
  eval "${prev_nullglob}" || true
fi

# 3b. Sort outcome paths newest-first via stat -f (macOS BSD has no GNU find -printf).
sorted_outcome_paths=""
if [[ ${#outcome_candidates[@]} -gt 0 ]]; then
  sorted_outcome_paths="$(
    for f in "${outcome_candidates[@]}"; do
      stat -f '%m %N' -- "${f}" 2>/dev/null || true
    done | sort -rn | awk '{ $1=""; sub(/^ /, ""); print }'
  )"
fi
# `|| true` absorbs the benign SIGPIPE when head closes stdin early (set -o pipefail would abort).
recent_outcomes="$( { printf '%s\n' "${sorted_outcome_paths}" 2>/dev/null | head -n 5; } || true)"

# 3c. Open-progress block. progress_list_open prints absolute paths newest-first or stays silent.
open_progress_block=""
if [[ "${PROGRESS_TRACKER_AVAILABLE}" -eq 1 ]]; then
  open_progress_paths="$(progress_list_open 2>/dev/null || printf '')"
  if [[ -n "${open_progress_paths}" ]]; then
    while IFS= read -r path; do
      [[ -n "${path}" ]] && open_progress_block+="- ${path}"$'\n'
    done <<<"${open_progress_paths}"
  fi
fi

# 3d. Recent-outcomes table rows.
recent_outcome_rows=""
if [[ -n "${recent_outcomes}" ]]; then
  while IFS= read -r outcome_path; do
    [[ -z "${outcome_path}" ]] && continue
    # First `result:` in the YAML frontmatter (between the leading and second '---').
    result_value="$(
      awk '
        BEGIN { in_fm = 0; fence_count = 0 }
        /^---[[:space:]]*$/ {
          fence_count++
          if (fence_count == 1) { in_fm = 1; next }
          if (fence_count == 2) { exit }
        }
        in_fm && /^result:[[:space:]]*/ {
          sub(/^result:[[:space:]]*/, "")
          gsub(/[[:space:]]*$/, "")
          print
          exit
        }
      ' "${outcome_path}" 2>/dev/null || printf '?'
    )"
    [[ -z "${result_value}" ]] && result_value="?"
    recent_outcome_rows+="| ${result_value} | ${outcome_path} |"$'\n'
  done <<<"${recent_outcomes}"
fi

# 3e. Active correlation IDs. "Active" = result in {done_with_concerns, blocked, needs_context}.
# Single awk pass extracts result + correlation_id from frontmatter; empty CIDs skipped (legacy).
active_cid_lines=""
if [[ -n "${sorted_outcome_paths}" ]]; then
  while IFS= read -r outcome_path; do
    [[ -z "${outcome_path}" ]] && continue
    pair="$(
      awk '
        BEGIN { in_fm = 0; fence_count = 0; result = ""; cid = "" }
        /^---[[:space:]]*$/ {
          fence_count++
          if (fence_count == 1) { in_fm = 1; next }
          if (fence_count == 2) {
            gsub(/^"/, "", cid); gsub(/"$/, "", cid)
            printf "%s\t%s", result, cid
            exit
          }
        }
        in_fm && /^result:[[:space:]]*/ {
          sub(/^result:[[:space:]]*/, "")
          gsub(/[[:space:]]*$/, "")
          result = $0
        }
        in_fm && /^correlation_id:[[:space:]]*/ {
          sub(/^correlation_id:[[:space:]]*/, "")
          gsub(/[[:space:]]*$/, "")
          cid = $0
        }
      ' "${outcome_path}" 2>/dev/null || printf '\t'
    )"
    result_value="${pair%%	*}"
    cid_value="${pair#*	}"
    [[ -z "${cid_value}" ]] && continue
    case "${result_value}" in
      done_with_concerns | blocked | needs_context)
        active_cid_lines+="- ${cid_value} (status: ${result_value})"$'\n'
        ;;
      *) ;;
    esac
  done <<<"${sorted_outcome_paths}"
fi

# 3f. Single survival-packet write — all sections in one redirect block (avoids SC2129).
{
  printf '# Survival packet — %s\n' "${TIMESTAMP}"
  printf 'session: %s\n' "${SESSION_ID}"
  printf 'trigger: %s\n' "${TRIGGER}"
  printf '\n'

  printf '## Open progress files\n'
  if [[ -n "${open_progress_block}" ]]; then
    printf '%s' "${open_progress_block}"
  elif [[ "${PROGRESS_TRACKER_AVAILABLE}" -eq 1 ]]; then
    printf -- '- (none)\n'
  else
    printf -- '- (progress-tracker.sh unavailable)\n'
  fi
  printf '\n'

  printf '## Recent outcomes (newest 5)\n\n'
  printf '| result | path |\n'
  printf '|--------|------|\n'
  if [[ -n "${recent_outcome_rows}" ]]; then
    printf '%s' "${recent_outcome_rows}"
  else
    printf '| (none) | - |\n'
  fi
  printf '\n'

  printf '## Active correlation IDs\n'
  if [[ -n "${active_cid_lines}" ]]; then
    printf '%s' "${active_cid_lines}"
  else
    printf -- '- (none)\n'
  fi
  printf '\n'
} >"${SURVIVAL_TMP}"

# 3g. Atomic publish — mv is POSIX-atomic within one FS (reader sees old or new, never partial).
# Failure → SessionStart replays a stale packet → warn so the gap is visible.
if ! mv -f -- "${SURVIVAL_TMP}" "${SURVIVAL_PATH}" 2>/dev/null; then
  emit_error "DATA-192" "warn" \
    "pre-compact survival packet publish failed" \
    "Check ${BACKUP_DIR} write permissions; SessionStart will use the stale packet" \
    "{\"session_id\":\"${SESSION_ID}\"}"
fi

# 4. Retention prune — keep newest 5 of each kind (backups are regenerable cache → rm allowed).
# find + stat (not `ls -t | tail`, SC2012) handles non-alphanumeric filenames safely; errors swallowed.
prune_old_backups() {
  local pattern="${1}"
  find "${BACKUP_DIR}" -maxdepth 1 -type f -name "${pattern}" -print0 2>/dev/null \
    | xargs -0 stat -f '%m %N' 2>/dev/null \
    | sort -rn \
    | tail -n +6 \
    | awk '{ $1=""; sub(/^ /, ""); print }' \
    | while IFS= read -r victim; do
      [[ -n "${victim}" && -f "${victim}" ]] && rm -f -- "${victim}" 2>/dev/null || true
    done
}
prune_old_backups '*.jsonl'
prune_old_backups '*_survival.md'

exit 0
