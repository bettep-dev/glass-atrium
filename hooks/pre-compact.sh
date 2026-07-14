#!/usr/bin/env bash
# pre-compact.sh — backup transcript + emit a "survival packet" before context compaction.
# Gathers open progress files + recent outcomes + active correlation IDs into a markdown packet
# a future SessionStart re-injects — without it, auto-compact drops "what was unfinished".
# Side-effect only — never blocks, exit 0 always.

set -Eeuo pipefail
IFS=$'\n\t'

# OS-portable bulk stat args — BSD `-f '%m %N'` vs GNU `-c '%Y %n'` (both emit `<epoch> <path>`).
# GNU `-f` = --file-system → bare BSD `-f '%m %N'` is misparsed as a path, giving garbage sort keys on Linux.
# Detect ONCE at load: a plain var is inherited by the `$(...)`/xargs subshells, keeping the O(1)-fork scan.
_GA_OS="$(uname -s 2>/dev/null || printf 'unknown')"
if [[ "${_GA_OS}" == "Darwin" ]]; then
  _GA_STAT_MP=(-f '%m %N')
else
  _GA_STAT_MP=(-c '%Y %n')
fi

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

# 3a. Collect + sort ALL outcome paths ONCE, newest-first (shared by 3d summary + 3e correlation).
# Path priority mirrors track-outcome.sh: 1. ~/.claude/data/outcomes/*.md (canonical)
#   2. ${PWD}/memory/outcomes/*.md (deprecated legacy).
# Bounded fan-out: one `find | xargs stat | sort` (a CONSTANT number of processes — NOT a stat fork
# per file; mirrors the retention-prune pattern below), yielding every outcome path newest-first. The
# perf win is the single sort + single-pass awk (3b), NOT a head-cap — so no head slice bounds the
# corpus. The `2>/dev/null` here is best-effort scanning (the packet degrades to `(none)`/`?`), NOT an
# error-signal path — so it is not a new suppression on a loud-fail path.
#
# Coverage: correlation reads the FULL corpus so an active CID older than the newest few outcomes
# still surfaces (a multi-wave session can hold a CID active well below the recent-summary window).
# The two consumers window independently in 3d/3e: SUMMARY_LIMIT windows the recent-outcomes TABLE
# only, while CORRELATION_LIMIT is an OPTIONAL operator safety bound (PRECOMPACT_CORRELATION_LIMIT)
# that windows the active-CID scan to the newest K WITHOUT ever truncating the summary. Empty / unset
# / non-integer / 0 = unbounded (full corpus) — the default.
SUMMARY_LIMIT=5
CORRELATION_LIMIT="${PRECOMPACT_CORRELATION_LIMIT:-0}"
# Non-integer / negative operator input → unbounded; also guards the -gt comparison in 3e.
[[ "${CORRELATION_LIMIT}" =~ ^[0-9]+$ ]] || CORRELATION_LIMIT=0

outcome_dirs=()
[[ -d "${HOME}/.claude/data/outcomes" ]] && outcome_dirs+=("${HOME}/.claude/data/outcomes")
[[ -d "${PWD}/memory/outcomes" ]] && outcome_dirs+=("${PWD}/memory/outcomes")

sorted_paths=()
if [[ ${#outcome_dirs[@]} -gt 0 ]]; then
  # `{ ...; } || true` absorbs a benign non-zero pipe status under pipefail (e.g. stat racing a
  # vanished file, or empty-input xargs); the scan degrades to empty, which the guard below tolerates.
  # Command-sub + here-string read keeps `sorted_paths` in the current shell (a `| while` would
  # populate a lost subshell).
  sorted_raw="$(
    {
      find "${outcome_dirs[@]}" -maxdepth 1 -type f -name '*.md' -print0 2>/dev/null \
        | xargs -0 stat "${_GA_STAT_MP[@]}" 2>/dev/null \
        | sort -rn \
        | awk '{ $1=""; sub(/^ /, ""); print }'
    } || true
  )"
  if [[ -n "${sorted_raw}" ]]; then
    while IFS= read -r outcome_path; do
      [[ -n "${outcome_path}" ]] && sorted_paths+=("${outcome_path}")
    done <<<"${sorted_raw}"
  fi
fi

# 3b. Single awk pass over the full sorted corpus → one `path<TAB>result<TAB>cid` tuple per file
# (newest first). One awk process regardless of corpus size (replaces the prior per-file awk fork —
# one per outcome, ×2 for summary + correlation). `result` = first result: in the opening
# frontmatter. `cid` is emitted only once the closing frontmatter fence (#2) is seen — so an
# unterminated frontmatter yields no correlation.
outcome_tuples=""
if [[ ${#sorted_paths[@]} -gt 0 ]]; then
  outcome_tuples="$(
    awk '
      function flush() {
        if (have) { printf "%s\t%s\t%s\n", cur, result, (closed ? cid : "") }
      }
      FNR == 1 {
        flush()
        cur = FILENAME
        have = 1
        in_fm = 0
        fence = 0
        done_fm = 0
        closed = 0
        got_result = 0
        got_cid = 0
        result = ""
        cid = ""
      }
      done_fm { next }
      /^---[[:space:]]*$/ {
        fence++
        if (fence == 1) {
          in_fm = 1
          next
        }
        if (fence == 2) {
          closed = 1
          done_fm = 1
          next
        }
      }
      in_fm && !got_result && /^result:[[:space:]]*/ {
        line = $0
        sub(/^result:[[:space:]]*/, "", line)
        gsub(/[[:space:]]*$/, "", line)
        result = line
        got_result = 1
      }
      in_fm && !got_cid && /^correlation_id:[[:space:]]*/ {
        line = $0
        sub(/^correlation_id:[[:space:]]*/, "", line)
        gsub(/[[:space:]]*$/, "", line)
        gsub(/^"/, "", line)
        gsub(/"$/, "", line)
        cid = line
        got_cid = 1
      }
      END { flush() }
    ' "${sorted_paths[@]}" 2>/dev/null || true
  )"
fi

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

# 3d + 3e. Format the recent-outcomes table + active-correlation lines from the single tuple stream —
# no per-file fork. The two windows are INDEPENDENT: the summary is always the newest SUMMARY_LIMIT
# rows, while the correlation scan covers the FULL corpus by default (an optional CORRELATION_LIMIT
# windows only the active-CID scan to the newest K, never the summary). Active = result in
# {done_with_concerns, blocked, needs_context} with a non-empty CID. Both read the same newest-first
# tuple order.
recent_outcome_rows=""
active_cid_lines=""
summary_seen=0
scan_pos=0
if [[ -n "${outcome_tuples}" ]]; then
  while IFS=$'\t' read -r t_path t_result t_cid; do
    [[ -z "${t_path}" ]] && continue
    scan_pos=$((scan_pos + 1))
    # Summary window — exactly the newest SUMMARY_LIMIT rows, decoupled from CORRELATION_LIMIT.
    if [[ "${summary_seen}" -lt "${SUMMARY_LIMIT}" ]]; then
      row_result="${t_result}"
      [[ -z "${row_result}" ]] && row_result="?"
      recent_outcome_rows+="| ${row_result} | ${t_path} |"$'\n'
      summary_seen=$((summary_seen + 1))
    fi
    # Correlation window — full corpus by default; a positive operator bound windows the active-CID
    # scan to the newest CORRELATION_LIMIT without touching the summary above.
    if [[ "${CORRELATION_LIMIT}" -gt 0 && "${scan_pos}" -gt "${CORRELATION_LIMIT}" ]]; then
      continue
    fi
    [[ -z "${t_cid}" ]] && continue
    case "${t_result}" in
      done_with_concerns | blocked | needs_context)
        active_cid_lines+="- ${t_cid} (status: ${t_result})"$'\n'
        ;;
      *) ;;
    esac
  done <<<"${outcome_tuples}"
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

  printf '## Recent outcomes (newest %s)\n\n' "${SUMMARY_LIMIT}"
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
    | xargs -0 stat "${_GA_STAT_MP[@]}" 2>/dev/null \
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
