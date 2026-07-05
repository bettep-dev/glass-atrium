#!/bin/bash
# Daily 04:00 cron: batch-compile unprocessed raw/ files via glass-atrium-wiki-compiler skill.
# Pipeline: 1 claude -p call (Step 1 Convert) -> wiki-sync.sh (Step 2 Sync).
# Persists compiled_count/compiled_total to core.daemon_runs for monitor card.

# WIKI_ROOT: single source of truth for the wiki data root. Resolved BEFORE the
# pre-strict-mode fork-OK probe so the diagnostic reports the configured raw/
# path. Default = the glass-atrium store; WIKI_ROOT env overrides. Re-asserted
# (idempotently) at the main resolver below.
WIKI_ROOT="${WIKI_ROOT:-${HOME}/.glass-atrium/wiki}"

echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] cron fork OK pid=$$ ppid=$PPID HOME=${HOME:-EMPTY} PWD=$PWD USER=${USER:-EMPTY} SHELL=${SHELL:-EMPTY} raw_count=$(ls "${WIKI_ROOT}/raw/"*.md 2>/dev/null | wc -l | tr -d ' ') glob_test=$(printf '%s\n' "${WIKI_ROOT}/raw/"*.md | head -1)" >>/tmp/wiki-compile.log

set -euo pipefail
set +f # defensive: ensure pathname expansion is enabled
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Shared config.toml accessors (atrium_config_get / atrium_ere_escape) —
# resolved relative to this script so the symlink-farm copy finds its lib.
WIKI_COMPILE_SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/atrium-config.sh
. "$WIKI_COMPILE_SELF_DIR/lib/atrium-config.sh"

# claude CLI resolution: WIKI_COMPILE_CLAUDE_BIN (Bats stub override) →
# [paths].claude_bin (config.toml) → daemon-cycle.sh fallback chain (PATH →
# Homebrew Apple Silicon → Homebrew Intel). Loud-fail when nothing is runnable
# — exit 4 mirrors daemon-cycle.sh's "claude binary not found" code.
if [ -n "${WIKI_COMPILE_CLAUDE_BIN:-}" ]; then
  CLAUDE="$WIKI_COMPILE_CLAUDE_BIN"
else
  CLAUDE="$(atrium_config_get '[paths]' 'claude_bin' '')"
  if [ -n "$CLAUDE" ] && [ ! -x "$CLAUDE" ]; then
    # configured-but-broken path: WARN (no silent absorption), re-detect below
    echo "[wiki-daily-compile] WARN: [paths].claude_bin='$CLAUDE' not executable — falling back to PATH detection" >&2
    CLAUDE=""
  fi
  if [ -z "$CLAUDE" ]; then
    if command -v claude >/dev/null 2>&1; then
      CLAUDE="$(command -v claude)"
    elif [ -x /opt/homebrew/bin/claude ]; then
      CLAUDE="/opt/homebrew/bin/claude"
    elif [ -x /usr/local/bin/claude ]; then
      CLAUDE="/usr/local/bin/claude"
    else
      echo "[wiki-daily-compile] FATAL: claude binary not found ([paths].claude_bin, PATH, /opt/homebrew/bin, /usr/local/bin)" >&2
      exit 4
    fi
  fi
fi

# Headless claude auth (launchd keychain-bypass): a launchd-spawned `claude -p`
# (non-GUI session) authenticating ONLY via the GUI macOS Keychain OAuth item
# returns 401; the env token bypasses it. Source the 0600 secrets file
# (render-claude-auth.sh output) BEFORE the claude call below so
# CLAUDE_CODE_OAUTH_TOKEN is exported. Absent file → loud WARN + keychain
# fallback. Lib lives beside this script's lib/ dir.
CLAUDE_AUTH_ENV_LIB="$WIKI_COMPILE_SELF_DIR/lib/claude-auth-env.sh"
if [ -f "$CLAUDE_AUTH_ENV_LIB" ]; then
  # shellcheck source=lib/claude-auth-env.sh
  . "$CLAUDE_AUTH_ENV_LIB"
  claude_auth_load_env
else
  echo "[wiki-daily-compile] WARN: claude-auth-env lib missing ($CLAUDE_AUTH_ENV_LIB) — keychain auth only" >&2
fi

# Quota-footer timezone — RESOLVED [meta].timezone, env-overridable; ERE-escaped
# for the quota greps below. The resolution rationale (concrete-zone requirement,
# TZ-immune /etc/localtime read) lives once in atrium_load_timezone
# (lib/atrium-config.sh).
ATRIUM_TIMEZONE="$(atrium_load_timezone)"
TZ_ERE="$(atrium_ere_escape "$ATRIUM_TIMEZONE")"

export OTEL_METRICS_EXPORTER=none
export OTEL_LOGS_EXPORTER=none
export CLAUDE_CODE_ENABLE_TELEMETRY=0

# WIKI_ROOT: single source of truth for the wiki data root. Default = the
# glass-atrium store; WIKI_ROOT env overrides for tests / alternate roots.
WIKI_ROOT="${WIKI_ROOT:-${HOME}/.glass-atrium/wiki}"
WIKI_BASE="$WIKI_ROOT"
RAW_DIR="$WIKI_ROOT/raw"
NOTES_DIR="$WIKI_ROOT/notes"
INDEX_FILE="$WIKI_ROOT/index/master-index.md"
# Claude-Code project-dir cwd encoding: $HOME with '/' -> '-' (leading '-').
PROJ_DIR="-${HOME#/}"
PROJ_DIR="${PROJ_DIR//\//-}"
LOG_DIR="$HOME/.claude-work/projects/$PROJ_DIR/memory/traces"
# UTC date keys the LOG_FILE so its date component matches the daemon_runs
# run_date (the daemon keys UTC) — one (run_date, daemon_name) row per cycle.
LOG_FILE="$LOG_DIR/wiki-compile-$(date -u +%Y-%m-%d).log"
LOCK_SCRIPT="$HOME/.claude/scripts/wiki-lock.sh"
SYNC_SCRIPT="$HOME/.claude/scripts/wiki-sync.sh"

# Resolve the haiku model id from the daemon-config.json SoT (avoids dated-pin
# drift). Missing jq/file/key → alias literal claude-haiku-4-5 fallback (same
# policy as daemon_config.py).
DAEMON_CONFIG="$HOME/.claude/data/daemon-config.json"
HAIKU_MODEL="claude-haiku-4-5"
if command -v jq >/dev/null 2>&1 && [ -f "$DAEMON_CONFIG" ]; then
  _cfg_model=$(jq -r '.haiku_model // empty' "$DAEMON_CONFIG" 2>/dev/null || true)
  [ -n "$_cfg_model" ] && HAIKU_MODEL="$_cfg_model"
fi

# WIKI_STARTED_AT for the PG aggregate row.
WIKI_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# UTC run_date so cron and the daemon (wiki-daemon-cycle.sh, UTC) UPSERT the
# SAME (run_date, daemon_name) daemon_runs row — a local-time key splits the row
# at the KST/UTC date boundary, leaving the cron side without its payload.
WIKI_RUN_DATE="$(date -u +%Y-%m-%d)"
PG_HELPER="$HOME/.claude/scripts/_pg_dual_write_daemon.py"

# 0. Concurrency guard (wiki-lock)
if [ -x "$LOCK_SCRIPT" ]; then
  if ! "$LOCK_SCRIPT" acquire wiki-compile 5 2>>/tmp/wiki-compile.log; then
    echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] wiki-daily-compile: another run holds wiki-compile lock, skipping pid=$$" >>/tmp/wiki-compile.log
    exit 0
  fi
  trap '"$LOCK_SCRIPT" release wiki-compile 2>/dev/null || true' EXIT INT TERM
fi

# Helper: extract source_url from a raw/note file's frontmatter — reads only the
# first source_url: line inside the --- block, returns blank if absent/malformed.
# bash 3.2 compatible (awk, no declare -A).
_extract_source_url() {
  local file="$1"
  # A frontmatter delimiter is three dashes + ONLY ASCII space/tab (^---[ \t]*$)
  # — locale-independent, so `---x` is not a delimiter and the block keeps
  # scanning. The [[:space:]] class is locale-dependent (matches nbsp under
  # UTF-8 but not under C); [ \t] is deterministic across locales. The extracted
  # value is CR-stripped so it byte-matches the Python detector's CR-stripped
  # value, keeping the two detectors in ASCII-deterministic lockstep.
  # Leading sub(/\r$/,"") strips a trailing CR from every record BEFORE the
  # delimiter test so a CRLF file's `---\r` matches ^---[ \t]*$ — awk splits
  # records on \n only, leaving the \r that Python's \r\n→\n normalize removes;
  # without the strip the delimiter never matches on a fully-CRLF file, so the
  # block never opens (the cross-detector divergence this closes).
  # awk: n=1 after the first delimiter, exit at the second; print + exit on the
  # first source_url within the block.
  awk '{sub(/\r$/,"")} /^---[ \t]*$/{n++; if(n==2)exit} n==1 && /^source_url:/{sub(/^source_url:[ \t]*/,""); sub(/[ \t]*$/,""); gsub(/\r/,""); print; exit}' "$file" 2>/dev/null || true
}

# Extract source_raw (a note's stable back-reference to its originating raw
# basename) from frontmatter — byte-parity with _extract_source_url so the Python
# detector mirrors it exactly. source_raw is the only collision-immune identity:
# raw basenames are unique (1 URL = 1 file, immutable), whereas a slug-renamed
# note loses both its basename match and its source_url, leaving a colliding raw
# eternally re-detected as backlog. Same ASCII delimiter, same per-record CR
# strip, same ASCII trailing-trim as _extract_source_url — only the key differs.
_extract_source_raw() {
  local file="$1"
  awk '{sub(/\r$/,"")} /^---[ \t]*$/{n++; if(n==2)exit} n==1 && /^source_raw:/{sub(/^source_raw:[ \t]*/,""); sub(/[ \t]*$/,""); gsub(/\r/,""); print; exit}' "$file" 2>/dev/null || true
}

# Collect every notes/*.md source_url into a newline-separated string. Per-file
# _extract_source_url calls reset FNR, avoiding body --- HR contamination.
# bash 3.2 compatible (for glob + string concat).
_collect_note_source_urls() {
  local _dir="$1"
  local _result=""
  local _nf _u
  for _nf in "${_dir}"/*.md; do
    # Guard against a non-matching glob (0 notes) — process only real files.
    [[ -f "${_nf}" ]] || continue
    _u=$(_extract_source_url "${_nf}")
    [[ -n "${_u}" ]] && _result="${_result}${_u}"$'\n'
  done
  printf '%s' "${_result}"
}

# Collect every notes/*.md source_raw into a newline-separated string — the
# note-side set that _classify_raw tests a raw basename against for the
# collision-immune primary match. bash 3.2 compatible (for glob + string concat).
_collect_note_source_raws() {
  local _dir="$1"
  local _result=""
  local _nf _r
  for _nf in "${_dir}"/*.md; do
    # Guard against a non-matching glob (0 notes) — process only real files.
    [[ -f "${_nf}" ]] || continue
    _r=$(_extract_source_raw "${_nf}")
    [[ -n "${_r}" ]] && _result="${_result}${_r}"$'\n'
  done
  printf '%s' "${_result}"
}

# Build the COLLISION SET: source_urls shared by MORE THAN ONE raw/*.md. A
# source_url claimed by several raws cannot identify a single processed raw — one
# raw's compiled note would otherwise mark its url-twins as processed and they
# would never compile (silent loss). Such raws are instead matched by basename
# only. Output is a newline-separated, deduplicated string. bash 3.2 compatible
# (sort | uniq -d, no declare -A).
_collect_collision_source_urls() {
  local _dir="$1"
  local _rf _u
  local _all=""
  for _rf in "${_dir}"/*.md; do
    # Guard against a non-matching glob (0 raws) — process only real files.
    [[ -f "${_rf}" ]] || continue
    _u=$(_extract_source_url "${_rf}")
    [[ -n "${_u}" ]] && _all="${_all}${_u}"$'\n'
  done
  # uniq -d keeps only lines occurring 2+ times → the collision set. The trailing
  # blank line from the concat is dropped by grep -v before sorting. The 0-url
  # case makes grep -v match nothing (exit 1) → with pipefail the pipeline returns
  # 1, which under set -e would abort the standalone COLLISION_URLS assignment; the
  # empty collision set is the correct result, so the non-match is suppressed.
  printf '%s' "${_all}" | grep -v '^$' | sort | uniq -d || true
}

# List, per colliding source_url, the basenames of the raws sharing it — the body
# of the loud collision WARN. bash 3.2 compatible (string scan, no declare -A).
_collision_warn_lines() {
  local _dir="$1"
  local _collisions="$2"
  local _u _rf _ru _sharers
  while IFS= read -r _u; do
    [[ -n "${_u}" ]] || continue
    _sharers=""
    for _rf in "${_dir}"/*.md; do
      [[ -f "${_rf}" ]] || continue
      _ru=$(_extract_source_url "${_rf}")
      [[ "${_ru}" == "${_u}" ]] && _sharers="${_sharers}$(basename "${_rf}") "
    done
    printf '  source_url=%s shared by: %s\n' "${_u}" "${_sharers% }"
  done <<<"${_collisions}"
}

# Classify a raw as processed/unprocessed. Echoes "processed" or "unprocessed".
# Args: raw file, note-url set, collision set, note-source_raw set. The primary
# match is the raw's basename appearing as some note's source_raw value: raw
# basenames are unique (1 URL = 1 file, immutable), so this identity is
# unambiguous and needs NO collision guard — it is the only path that survives a
# slug-rename + source_url drop. The basename match (notes/<basename>.md) and the
# guarded source_url match remain as fallbacks so legacy notes lacking source_raw
# still classify as processed.
_classify_raw() {
  local _file="$1"
  local _note_urls="$2"
  local _collisions="$3"
  local _note_raws="$4"
  local _slug _base _url
  _base=$(basename "${_file}")
  if printf '%s\n' "${_note_raws}" | grep -qxF "${_base}"; then
    printf 'processed'
    return 0
  fi
  _slug=$(basename "${_file}" .md)
  if [[ -f "${NOTES_DIR}/${_slug}.md" ]]; then
    printf 'processed'
    return 0
  fi
  _url=$(_extract_source_url "${_file}")
  if [[ -n "${_url}" ]] \
    && ! printf '%s\n' "${_collisions}" | grep -qxF "${_url}" \
    && printf '%s\n' "${_note_urls}" | grep -qxF "${_url}"; then
    printf 'processed'
    return 0
  fi
  printf 'unprocessed'
}

# Stamp a note's frontmatter with the script-authoritative source_raw (and a
# source_url backfill when absent), repairing whatever the LLM emitted — the
# script, not the prompt, owns this identity. Args: note file, source_raw value
# (raw basename), source_url value (may be empty). Idempotent (existing keys are
# left untouched), CRLF-safe (records compared with a CR-stripped copy, original
# bytes re-emitted), atomic (temp + mv). No-op unless the file opens with a `---`
# frontmatter delimiter — a malformed note is never rewritten. bash 3.2 (awk, no
# declare -A).
_inject_source_raw() {
  local _note="$1"
  local _raw="$2"
  local _url="$3"
  # Skip when already present so a re-run never double-inserts (idempotency).
  local _have_raw _have_url
  _have_raw=$(_extract_source_raw "${_note}")
  _have_url=$(_extract_source_url "${_note}")
  local _need_raw=1 _need_url=1
  [[ -n "${_have_raw}" ]] && _need_raw=0
  { [[ -n "${_have_url}" ]] || [[ -z "${_url}" ]]; } && _need_url=0
  [[ "${_need_raw}" -eq 0 && "${_need_url}" -eq 0 ]] && return 0
  local _tmp
  _tmp=$(mktemp "${_note}.inject.XXXXXX") || return 0
  # Inject right after the opening delimiter only — the CR-stripped copy drives the
  # `^---[ \t]*$` test (ASCII, locale-independent), while each existing record is
  # printed unmodified so it keeps its own ending; the injected key line is LF.
  # Parity holds regardless: both extractors strip \r on read. injected=1 fires once.
  if awk -v raw="${_raw}" -v url="${_url}" -v need_raw="${_need_raw}" -v need_url="${_need_url}" '
    { line=$0; t=$0; sub(/\r$/,"",t) }
    !injected && t ~ /^---[ \t]*$/ {
      print line
      if (need_raw) print "source_raw: " raw
      if (need_url) print "source_url: " url
      injected=1
      next
    }
    { print line }
  ' "${_note}" >"${_tmp}" 2>/dev/null; then
    mv -f "${_tmp}" "${_note}" 2>/dev/null || rm -f "${_tmp}" 2>/dev/null || true
  else
    rm -f "${_tmp}" 2>/dev/null || true
  fi
}

# 0.5 Named precondition (Loud-Fail): distinguish a relocation-miss from a
#     legitimately-not-yet-seeded store BEFORE the raw-glob find. The find at the
#     loop tail redirects stderr to the log, which would otherwise mask a missing
#     RAW_DIR as a silent "0 unprocessed" — identical to an empty store. If the
#     configured WIKI_ROOT itself is absent → relocation-miss, fail loud + record
#     PG status 'error'. If WIKI_ROOT exists but raw/ does not → store simply has
#     no raw sources yet → benign, fall through (find yields 0, normal exit-0).
if [ ! -d "$RAW_DIR" ]; then
  if [ ! -d "$WIKI_ROOT" ]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] FATAL: configured wiki root missing: $WIKI_ROOT (possible relocation-miss; verify WIKI_ROOT)" >>"$LOG_FILE" 2>/dev/null || true
    echo "[wiki-daily-compile] FATAL: configured wiki root missing: $WIKI_ROOT — possible relocation-miss, verify WIKI_ROOT" >&2
    if [ -x "$PG_HELPER" ]; then
      MISS_ENVELOPE=$(printf '{"op":"write_daemon_run","args":{"daemon_name":"wiki","run_date":"%s","started_at":"%s","ended_at":"%s","status":"error","compiled_count":%d,"compiled_total":%d,"notes":"wiki-daily-compile aborted: configured wiki root missing (%s) — possible relocation-miss"}}' \
        "$WIKI_RUN_DATE" "$WIKI_STARTED_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 0 0 "$WIKI_ROOT")
      printf '%s\n' "$MISS_ENVELOPE" | python3 "$PG_HELPER" >>"$LOG_FILE" 2>&1 || true
    fi
    exit 1
  fi
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] wiki root present but raw/ absent: $RAW_DIR — no raw sources to compile, exiting" >>"$LOG_FILE"
fi

# 1. Detect unprocessed raws — hybrid match: a raw is unprocessed when
#    notes/<basename>.md is absent AND (raw has no source_url, or that url is not
#    in any note OR is a collision url). wiki-curator normalizes the slug (strips
#    date/hash), so a basename-only check would miss matches. bash 3.2: NOTE_URLS
#    and COLLISION_URLS are newline-separated strings, membership via grep -qxF.
NOTE_URLS=$(_collect_note_source_urls "${NOTES_DIR}")
# NOTE_RAWS keys the collision-immune primary match — a raw basename present here
# is processed regardless of any source_url collision.
NOTE_RAWS=$(_collect_note_source_raws "${NOTES_DIR}")
COLLISION_URLS=$(_collect_collision_source_urls "${RAW_DIR}")
# A non-empty collision set means several raws claim one source_url — those raws
# are basename-matched only, so the shared url cannot mask an uncompiled twin.
# Surface it loudly (Precondition Loud-Fail / observability).
if [ -n "$COLLISION_URLS" ]; then
  mkdir -p "$LOG_DIR"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] WARN: source_url collisions detected (basename-only match enforced for these raws):" >>"$LOG_FILE"
  _collision_warn_lines "${RAW_DIR}" "${COLLISION_URLS}" >>"$LOG_FILE"
fi
UNPROCESSED=()
while IFS= read -r -d '' file; do
  if [ "$(_classify_raw "$file" "$NOTE_URLS" "$COLLISION_URLS" "$NOTE_RAWS")" = "unprocessed" ]; then
    UNPROCESSED+=("$file")
  fi
done < <(find "$RAW_DIR" -maxdepth 1 -type f -name '*.md' -print0 2>>/tmp/wiki-compile.log)

if [ ${#UNPROCESSED[@]} -eq 0 ]; then
  # 0 unprocessed files → record PG status 'ok' (with monitor-card counts), exit.
  # Emit an explicit human-readable trace line so a clean 0-work day is visibly
  # distinct from a crash (Precondition Loud-Fail / observability). LOG_DIR is not
  # yet created at this early-exit branch (mkdir happens later), so ensure it
  # exists before the trace + envelope writes.
  mkdir -p "$LOG_DIR"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] wiki-daily-compile: 0 unprocessed raw sources — nothing to compile, exiting clean" >>"$LOG_FILE"
  if [ -x "$PG_HELPER" ]; then
    SKIP_ENVELOPE=$(printf '{"op":"write_daemon_run","args":{"daemon_name":"wiki","run_date":"%s","started_at":"%s","ended_at":"%s","status":"ok","compiled_count":%d,"compiled_total":%d,"notes":"wiki-daily-compile skipped: no unprocessed files"}}' \
      "$WIKI_RUN_DATE" "$WIKI_STARTED_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 0 0)
    printf '%s\n' "$SKIP_ENVELOPE" | python3 "$PG_HELPER" >>"$LOG_FILE" 2>&1 || true
  fi
  exit 0
fi
TOTAL=${#UNPROCESSED[@]}

# 2. Start log
mkdir -p "$LOG_DIR"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] wiki-daily-compile started pid=$$ total=${TOTAL}" >>"$LOG_FILE"
printf '  - %s\n' "${UNPROCESSED[@]}" >>"$LOG_FILE"

# 3. Dynamic budget: $0.10/file, clamped [0.50, 5.00]
BUDGET=$(awk -v n="$TOTAL" 'BEGIN{b=n*0.10; if(b<0.50)b=0.50; if(b>5.00)b=5.00; printf "%.2f", b}')

# 4. Build batched prompt (Step 1 Convert only)
FILE_LIST=$(printf '  - %s\n' "${UNPROCESSED[@]}")
PROMPT="Convert the following raw files to wiki/notes/ markdown files (1:1 mapping).
Keep the original language (English raw -> English notes, Korean raw -> Korean notes).
Do not cross-link, do not edit master-index, do not modify any other files.
Preserve frontmatter from raw; add type:source-summary and tags extracted from content.
Copy the raw's source_url frontmatter value verbatim into the note.

Files to process:
${FILE_LIST}
Output: for each input raw, reuse its filename verbatim — write to
${NOTES_DIR}/<exact-input-basename>.md (absolute path); do not rename or slugify
the basename. Print a 1-line summary when done."

# 4.5 Cost ceiling: the per-call --max-budget-usd (Step 5, clamped [0.50, 5.00])
# bounds this cron's own spend — the same per-CALL ceiling the wiki daemon
# (wiki_daemon_cycle.py HAIKU_MAX_BUDGET_USD) relies on. A daily-total gate
# against core.cost_events is unusable here: the table carries no
# component/workload tag, so a wiki-scoped daily sum is not queryable, and the
# GLOBAL total (all workloads) blocks this cron every day once non-wiki spend
# crosses the threshold. Post-call detection (5.4 budget-config, 5.5 quota) plus
# the CLAUDE_EXIT generic-failure envelope below handle the failure modes.

# 5. Single batched claude -p call (--bare minimal mode + wiki-curator system prompt)
CLAUDE_EXIT=0
SYSTEM_PROMPT_CONTENT="$(cat "$HOME/.claude/agents/glass-atrium-wiki-curator.md")"
# Derive the log label from the actual model var (no hardcoded-model drift).
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] claude -p batch call (budget=\$${BUDGET}, model=${HAIKU_MODEL})" >>"$LOG_FILE"
cd /tmp
"$CLAUDE" -p \
  --model "$HAIKU_MODEL" \
  --system-prompt "$SYSTEM_PROMPT_CONTENT" \
  --setting-sources project,local \
  --tools "Read,Write,Glob,Grep" \
  --permission-mode bypassPermissions \
  --max-budget-usd "$BUDGET" \
  --output-format text \
  "$PROMPT" \
  >>"$LOG_FILE" 2>&1 || CLAUDE_EXIT=$?
if [ "$CLAUDE_EXIT" -ne 0 ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] claude -p exited ${CLAUDE_EXIT}" >>"$LOG_FILE"
  # A non-zero exit that is NEITHER a local --max-budget-usd shortfall NOR a
  # Claude Max quota cap is a generic LLM-unavailable failure (CLI missing /
  # auth / network). The dedicated 5.4 budget-config and 5.5 quota branches own
  # their own envelopes + exit 0, so this branch defers to them; only the
  # residual generic case emits here. Without this row the health-check readback
  # finds no envelope and false-negatives "missing" — the late aggregate row at
  # step 7 can be skipped if a downstream step aborts under set -e.
  # compiled_count=0 — the LLM call did not complete.
  if ! grep -qE 'Exceeded USD budget' "$LOG_FILE" 2>/dev/null \
    && ! grep -qE 'Limit reached|Usage ⚠|out of extra usage|/rate-limit-options|resets .* \('"$TZ_ERE"'\)' "$LOG_FILE" 2>/dev/null; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [wiki-llm-fail] generic claude -p failure (exit=${CLAUDE_EXIT}) — recording status='error', aborting cycle" >>"$LOG_FILE"
    if [ -x "$PG_HELPER" ]; then
      LLM_FAIL_ENVELOPE=$(printf '{"op":"write_daemon_run","args":{"daemon_name":"wiki","run_date":"%s","started_at":"%s","ended_at":"%s","status":"error","compiled_count":%d,"compiled_total":%d,"notes":"wiki-daily-compile aborted: generic claude -p failure (exit=%d); not budget-config, not quota"}}' \
        "$WIKI_RUN_DATE" "$WIKI_STARTED_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 0 "$TOTAL" "$CLAUDE_EXIT")
      printf '%s\n' "$LLM_FAIL_ENVELOPE" | python3 "$PG_HELPER" >>"$LOG_FILE" 2>&1 || true
    fi
    exit 1
  fi
fi

# 5.4 / 5.5 Post-call abort detection — gated on a non-zero CLAUDE_EXIT, the only
# legitimate context for a quota/budget abort. $LOG_FILE is append-mode and also
# captures the Haiku model's own summary text, so a SUCCESSFUL compile whose
# summary echoes 'Limit reached'/'Usage'/'out of extra usage' would false-positive
# a quota/budget envelope and skip sync+aggregate. Gating both scans on the
# failure exit prevents a successful run from ever matching.
if [ "$CLAUDE_EXIT" -ne 0 ]; then
  # 5.4 Local budget-config detection (PRIOR to quota check). 'Exceeded USD
  # budget' is a local --max-budget-usd ceiling shortfall (self-inflicted config
  # error), NOT an external Claude Max quota — kept separate so a too-low budget
  # bug is not masked (same split as python _detect_budget_too_low). DaemonStatus
  # has no budget-specific value → record status='error', distinct from
  # quota_exceeded (excluded from the alert-suppress set).
  if grep -qE 'Exceeded USD budget' "$LOG_FILE" 2>/dev/null; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [wiki-budget-config] local --max-budget-usd ceiling too low (budget=\$${BUDGET}) — recording status='error' (not quota), aborting cycle" >>"$LOG_FILE"
    if [ -x "$PG_HELPER" ]; then
      # compiled_count=0 — LLM call aborted, so confirmed completions = 0.
      BUDGET_ENVELOPE=$(printf '{"op":"write_daemon_run","args":{"daemon_name":"wiki","run_date":"%s","started_at":"%s","ended_at":"%s","status":"error","compiled_count":%d,"compiled_total":%d,"notes":"wiki-daily-compile aborted: local --max-budget-usd ceiling too low (budget=%s); NOT an external quota cap"}}' \
        "$WIKI_RUN_DATE" "$WIKI_STARTED_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 0 "$TOTAL" "$BUDGET")
      printf '%s\n' "$BUDGET_ENVELOPE" | python3 "$PG_HELPER" >>"$LOG_FILE" 2>&1 || true
    fi
    exit 0
  fi

  # 5.5 Quota detection — scan combined claude -p output for Claude Max quota
  # tokens; on match, dual-write PG status='quota_exceeded', exit 0 (avoid noisy
  # "N failed" downstream). 'Exceeded USD budget' is handled by the 5.4
  # budget-config branch above (kept out of this alternation).
  if grep -qE 'Limit reached|Usage ⚠|out of extra usage|/rate-limit-options|resets .* \('"$TZ_ERE"'\)' "$LOG_FILE" 2>/dev/null; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [wiki-quota-detect] Claude Max quota reached — recording status='quota_exceeded', aborting cycle" >>"$LOG_FILE"
    if [ -x "$PG_HELPER" ]; then
      # compiled_count=0 — LLM call aborted, so confirmed completions = 0.
      QUOTA_ENVELOPE=$(printf '{"op":"write_daemon_run","args":{"daemon_name":"wiki","run_date":"%s","started_at":"%s","ended_at":"%s","status":"quota_exceeded","compiled_count":%d,"compiled_total":%d,"notes":"wiki-daily-compile aborted: Claude Max quota reached"}}' \
        "$WIKI_RUN_DATE" "$WIKI_STARTED_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 0 "$TOTAL")
      printf '%s\n' "$QUOTA_ENVELOPE" | python3 "$PG_HELPER" >>"$LOG_FILE" 2>&1 || true
    fi
    exit 0
  fi
fi

# 5.6 Stamp source_raw on each compiled note — the script-authoritative identity
# the LLM cannot be trusted to write. For each input raw with basename B, a
# note at notes/B.md (the deterministic filename contract from the prompt) gets
# source_raw:B (and a source_url backfill) so the recount and every future cycle
# match it collision-immune. Runs before sync so the regenerated master-index +
# sqlite reflect the stamped frontmatter.
for file in "${UNPROCESSED[@]}"; do
  inj_base=$(basename "$file")
  inj_note="${NOTES_DIR}/${inj_base}"
  [ -f "$inj_note" ] || continue
  inj_url=$(_extract_source_url "$file")
  _inject_source_raw "$inj_note" "$inj_base" "$inj_url"
done

# 6. Sync (Step 2, no LLM) — regenerates master-index + wiki.sqlite
SYNC_EXIT=0
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] invoking wiki-sync" >>"$LOG_FILE"
bash "$SYNC_SCRIPT" >>"$LOG_FILE" 2>&1 || SYNC_EXIT=$?

# 7. Verify success — same classification as step 1. Rebuild NOTE_URLS and
# NOTE_RAWS to include the newly compiled + stamped notes before verifying;
# COLLISION_URLS is unchanged (same raw/*.md set).
NOTE_URLS=$(_collect_note_source_urls "${NOTES_DIR}")
NOTE_RAWS=$(_collect_note_source_raws "${NOTES_DIR}")
SUCCESS=0
FAILED=()
for file in "${UNPROCESSED[@]}"; do
  slug=$(basename "$file" .md)
  if [ "$(_classify_raw "$file" "$NOTE_URLS" "$COLLISION_URLS" "$NOTE_RAWS")" = "processed" ]; then
    SUCCESS=$((SUCCESS + 1))
    continue
  fi
  FAILED+=("${slug}.md")
done
FAIL_COUNT=${#FAILED[@]}
if [ "$SYNC_EXIT" -ne 0 ]; then
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] wiki-daily-compile finished success=${SUCCESS}/${TOTAL} failed=${#FAILED[@]} sync_exit=${SYNC_EXIT}" >>"$LOG_FILE"

# Write the aggregate core.daemon_runs row for the wiki cycle.
# wiki-sync.sh writes per-step metrics; this aggregate row guarantees the
# 09:00 health-check cron-readback finds a wiki-daemon row for today.
# status: sync fail or SUCCESS=0 → error / some fail → partial / all ok → ok.
# PG DaemonStatus enum has no 'fail' value. Best-effort: a PG failure MUST NOT
# block the script.
WIKI_AGG_STATUS="ok"
if [ "$SYNC_EXIT" -ne 0 ] || [ "$SUCCESS" -eq 0 ]; then
  WIKI_AGG_STATUS="error"
elif [ "$FAIL_COUNT" -gt 0 ]; then
  WIKI_AGG_STATUS="partial"
fi
if [ -x "$PG_HELPER" ]; then
  WIKI_AGG_ENVELOPE=$(printf '{"op":"write_daemon_run","args":{"daemon_name":"wiki","run_date":"%s","started_at":"%s","ended_at":"%s","status":"%s","compiled_count":%d,"compiled_total":%d,"notes":"wiki-daily-compile via cron, wiki-sync exit=%d"}}' \
    "$WIKI_RUN_DATE" "$WIKI_STARTED_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$WIKI_AGG_STATUS" "$SUCCESS" "$TOTAL" "$SYNC_EXIT")
  printf '%s\n' "$WIKI_AGG_ENVELOPE" | python3 "$PG_HELPER" >>"$LOG_FILE" 2>&1 || true
fi
