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

# 3a. Recent-outcome tuple stream — DB-primary (PG core.outcomes), legacy .md scan as fallback.
# Outcome records migrated to PG core.outcomes (DB-only sink written by _pg_outcome_dualwrite.py;
# per-outcome .md files are retired — no longer written). The primary source is now the DB, read via
# the SELECT-only _pg_outcome_read.py helper (identical host/port-less connection contract). The legacy
# .md scan is kept ONLY as a fallback for pre-migration residue OR a DB that is unavailable/empty — so
# the packet degrades gracefully and NEVER blocks compaction. Both sources emit the SAME newest-first
# tuple stream `detail<TAB>result<TAB>cid`, so the 3d/3e formatter below is source-agnostic (detail =
# the outcome summary on the DB path, the file path on the legacy .md path).
#
# Windowing (unchanged): SUMMARY_LIMIT windows the recent-outcomes TABLE only, while CORRELATION_LIMIT
# is an OPTIONAL operator safety bound (PRECOMPACT_CORRELATION_LIMIT) that windows the active-CID scan
# to the newest K WITHOUT truncating the summary. Empty / unset / non-integer / 0 = unbounded — default.
SUMMARY_LIMIT=5
CORRELATION_LIMIT="${PRECOMPACT_CORRELATION_LIMIT:-0}"
# Non-integer / negative operator input → unbounded; also guards the -gt comparison in 3e.
[[ "${CORRELATION_LIMIT}" =~ ^[0-9]+$ ]] || CORRELATION_LIMIT=0

# DB fetch cap — the shared multi-project core.outcomes carries NO cwd/project key and unbounded
# history, so (unlike the .md scan's full-corpus walk) the DB path bounds the fetch to the newest N
# rows. Correlation coverage within that window is preserved; an active CID older than the window is
# out of scope for the DB path (raise PRECOMPACT_DB_FETCH_LIMIT to widen it).
DB_FETCH_LIMIT="${PRECOMPACT_DB_FETCH_LIMIT:-100}"
[[ "${DB_FETCH_LIMIT}" =~ ^[0-9]+$ && "${DB_FETCH_LIMIT}" -gt 0 ]] || DB_FETCH_LIMIT=100

outcome_tuples=""
# detail_label names the recent-outcomes table's 2nd column: the DB path shows the outcome summary,
# the legacy .md fallback the file path.
detail_label="summary"

# DB-primary read. Skipped when disabled (PRECOMPACT_DB_DISABLE — the .md-fallback test seam), the
# helper is unreadable, or python3 is absent. The helper is SELECT-only and self-degrades: a genuine
# DB-unreachable case prints its OWN 1-line stderr note (loud-fail), `|| true` keeps this hook alive
# regardless, and an empty result simply falls through to the legacy .md scan below.
PG_READ_HELPER="${_HOOK_DIR}/_pg_outcome_read.py"
if [[ -z "${PRECOMPACT_DB_DISABLE:-}" && -r "${PG_READ_HELPER}" ]] && command -v python3 >/dev/null 2>&1; then
  db_tuples="$(python3 "${PG_READ_HELPER}" "${DB_FETCH_LIMIT}" || true)"
  [[ -n "${db_tuples}" ]] && outcome_tuples="${db_tuples}"
fi

# Legacy .md fallback path selection — runs ONLY when the DB path yielded nothing (unavailable / empty
# / disabled). Path priority mirrors track-outcome.sh: 1. ~/.glass-atrium/data/outcomes/*.md (canonical)
#   2. ${PWD}/memory/outcomes/*.md (deprecated legacy). Bounded fan-out: one `find | xargs stat | sort`
# (a CONSTANT number of processes — NOT a stat fork per file; mirrors the retention-prune pattern
# below). The `2>/dev/null` is best-effort scanning (the packet degrades to `(none)`/`?`), NOT an
# error-signal path — so it is not a new suppression on a loud-fail path.
sorted_paths=()
if [[ -z "${outcome_tuples}" ]]; then
  detail_label="path"
  outcome_dirs=()
  [[ -d "${HOOK_DATA_DIR}/outcomes" ]] && outcome_dirs+=("${HOOK_DATA_DIR}/outcomes")
  [[ -d "${PWD}/memory/outcomes" ]] && outcome_dirs+=("${PWD}/memory/outcomes")

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
fi

# 3b. Legacy .md awk pass over the sorted corpus → one `path<TAB>result<TAB>cid` tuple per file (newest
# first). Runs ONLY on the fallback path (sorted_paths is empty when the DB read already populated
# outcome_tuples, so this is skipped and the DB result is preserved). One awk process regardless of
# corpus size. `result` = first result: in the opening frontmatter; `cid` is emitted only once the
# closing frontmatter fence (#2) is seen — so an unterminated frontmatter yields no correlation.
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
  while IFS=$'\t' read -r t_detail t_result t_cid; do
    # Skip only a fully-blank line (e.g. a trailing newline). A DB row may carry an empty detail
    # (null summary) yet a valid result/cid, so the guard MUST NOT key on t_detail alone.
    [[ -z "${t_detail}" && -z "${t_result}" && -z "${t_cid}" ]] && continue
    scan_pos=$((scan_pos + 1))
    # Summary window — exactly the newest SUMMARY_LIMIT rows, decoupled from CORRELATION_LIMIT.
    if [[ "${summary_seen}" -lt "${SUMMARY_LIMIT}" ]]; then
      row_result="${t_result}"
      [[ -z "${row_result}" ]] && row_result="?"
      row_detail="${t_detail}"
      [[ -z "${row_detail}" ]] && row_detail="-"
      recent_outcome_rows+="| ${row_result} | ${row_detail} |"$'\n'
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
  printf '| result | %s |\n' "${detail_label}"
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
