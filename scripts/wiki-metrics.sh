#!/usr/bin/env bash
# wiki-metrics.sh — KPI measurement + integration healthcheck reporter.
#
# KPIs:
#   1) compile time/file          (target < 60s)
#   2) compile cost/file          (target < $0.05)
#   3) tool calls/file            (target < 20)
#   4) raw convention violations  (PreToolUse hook rejects, target 0)
#   5) wiki-query p50/avg         (target < 100ms)
#   6) index automation           (master-index.md frontmatter type=index + generated)
#
# Modes:
#   --md            Markdown table output (default: TTY-friendly table)
#   --since DATE    only trace logs on/after YYYY-MM-DD
#   --last N        only the most recent N trace logs
#   --health        KPI + integration healthcheck together
#   -h|--help       help

set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Claude-Code project-dir cwd encoding: $HOME with '/' -> '-' (leading '-').
proj_dir="-${HOME#/}"
proj_dir="${proj_dir//\//-}"
readonly TRACE_DIR="${HOME}/.claude-work/projects/${proj_dir}/memory/traces"
# WIKI_ROOT: single source of truth for the wiki data root. Default = the
# glass-atrium store; WIKI_ROOT env overrides for tests / alternate roots.
WIKI_ROOT="${WIKI_ROOT:-${HOME}/.glass-atrium/wiki}"
readonly WIKI_ROOT
readonly WIKI_BASE="${WIKI_ROOT}"
readonly RAW_DIR="${WIKI_ROOT}/raw"
readonly INDEX_FILE="${WIKI_ROOT}/index/master-index.md"
readonly QUERY_SH="${SCRIPT_DIR}/wiki-query.sh"
readonly SYNC_SH="${SCRIPT_DIR}/wiki-sync.sh"
readonly INIT_SH="${SCRIPT_DIR}/wiki-init-db.sh"
readonly LOCK_SH="${SCRIPT_DIR}/wiki-lock.sh"
readonly VALIDATOR_SH="${HOME}/.claude/hooks/validate-pre-write-raw.sh"

# KPI target values.
readonly TARGET_TIME_S=60
readonly TARGET_COST=0.05
readonly TARGET_TOOLS=20
readonly TARGET_QUERY_MS=100

MODE_MD=0
MODE_HEALTH=0
SINCE=""
LAST=0

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while (( $# > 0 )); do
  case "$1" in
    --md)     MODE_MD=1; shift ;;
    --health) MODE_HEALTH=1; shift ;;
    --since)  SINCE="${2:-}"; shift 2 ;;
    --last)   LAST="${2:-0}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

log() { printf '[wiki-metrics] %s\n' "$*" >&2; }

# ---------- trace log selection ----------
select_logs() {
  local -a all=()
  local f
  if [[ ! -d "${TRACE_DIR}" ]]; then
    return 0
  fi
  local date_part
  shopt -s nullglob
  for f in "${TRACE_DIR}"/wiki-compile-*.log; do
    if [[ -n "${SINCE}" ]]; then
      date_part="${f##*wiki-compile-}"
      date_part="${date_part%.log}"
      [[ "${date_part}" < "${SINCE}" ]] && continue
    fi
    all+=("${f}")
  done
  shopt -u nullglob

  if (( LAST > 0 )) && (( ${#all[@]} > LAST )); then
    local start=$(( ${#all[@]} - LAST ))
    printf '%s\n' "${all[@]:${start}}"
  else
    (( ${#all[@]} > 0 )) && printf '%s\n' "${all[@]}"
  fi
}

# ---------- KPI parsing (single awk pass) ----------
# Input: newline-separated trace log file list. Output: "files tools total_cost avg_time_s"
parse_logs() {
  local -a logs=()
  local line
  while IFS= read -r line; do
    [[ -n "${line}" ]] && logs+=("${line}")
  done

  if (( ${#logs[@]} == 0 )); then
    printf '0 0 0 0\n'
    return 0
  fi

  awk '
    function epoch(ts,   y,mo,d,h,mi,s,cmd,out) {
      # ts = YYYY-MM-DDThh:mm:ssZ → epoch via date -j (BSD date).
      y=substr(ts,1,4); mo=substr(ts,6,2); d=substr(ts,9,2)
      h=substr(ts,12,2); mi=substr(ts,15,2); s=substr(ts,18,2)
      cmd="date -j -u -f %Y-%m-%dT%H:%M:%SZ " ts " +%s 2>/dev/null"
      cmd | getline out
      close(cmd)
      return out+0
    }
    /^\[[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\] compiling:/ {
      ts=substr($1,2,20)
      cur_start=epoch(ts)
      in_file=1
      next
    }
    /^\[[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\] (success|failed):/ {
      if (in_file && cur_start>0) {
        ts=substr($1,2,20)
        end=epoch(ts)
        total_time += (end - cur_start)
        files++
        in_file=0
      }
      next
    }
    /cost_usd:/ {
      match($0, /[0-9]+\.[0-9]+/)
      if (RSTART>0) total_cost += substr($0,RSTART,RLENGTH)+0
    }
    /tool_name:/ { tools++ }
    END {
      avg = (files>0) ? total_time/files : 0
      printf "%d %d %.4f %.1f\n", files, tools, total_cost, avg
    }
  ' "${logs[@]}"
}

# ---------- wiki-query benchmark ----------
bench_query() {
  local n=5
  local i total=0 t0 t1 dt_ms
  if [[ ! -x "${QUERY_SH}" ]]; then
    printf 'N/A\n'
    return 0
  fi
  for (( i=0; i<n; i++ )); do
    t0=$(python3 -c 'import time;print(int(time.time()*1000))')
    "${QUERY_SH}" "test" >/dev/null 2>&1 || true
    t1=$(python3 -c 'import time;print(int(time.time()*1000))')
    dt_ms=$(( t1 - t0 ))
    total=$(( total + dt_ms ))
  done
  printf '%d\n' $(( total / n ))
}

# ---------- index automation check ----------
check_index() {
  if [[ ! -f "${INDEX_FILE}" ]]; then
    printf 'MISSING\n'
    return 0
  fi
  local head
  head="$(head -10 "${INDEX_FILE}")"
  if grep -qE '^type: index' <<<"${head}" && grep -qE '^generated:' <<<"${head}"; then
    printf 'OK\n'
  else
    printf 'STALE\n'
  fi
}

# ---------- verdict helper ----------
verdict() {
  # $1=value $2=target $3=mode(lt|eq)
  local v="$1" t="$2" m="$3"
  case "${m}" in
    lt)  awk -v v="${v}" -v t="${t}" 'BEGIN{exit !(v<t)}' && printf 'PASS' || printf 'FAIL' ;;
    eq)  [[ "${v}" == "${t}" ]] && printf 'PASS' || printf 'FAIL' ;;
  esac
}

# ---------- integration healthcheck ----------
run_health() {
  local -a results=()
  local status

  # 1) wiki-init-db idempotency
  if [[ -x "${INIT_SH}" ]] && "${INIT_SH}" >/dev/null 2>&1; then
    status="OK"
  else
    status="FAIL"
  fi
  results+=("init-db idempotent: ${status}")

  # 2) wiki-sync idempotency (two consecutive runs)
  if [[ -x "${SYNC_SH}" ]]; then
    if "${SYNC_SH}" >/dev/null 2>&1 && "${SYNC_SH}" >/dev/null 2>&1; then
      status="OK"
    else
      status="FAIL"
    fi
  else
    status="SKIP (missing)"
  fi
  results+=("wiki-sync idempotent: ${status}")

  # 3) PreToolUse hook reject (bad) / pass (good)
  if [[ -x "${VALIDATOR_SH}" ]] && command -v jq >/dev/null 2>&1; then
    local bad_json good_json bad_rc good_rc
    bad_json='{"tool_name":"Write","tool_input":{"file_path":"'"${RAW_DIR}"'/__dummy_bad.md","content":"no frontmatter here"}}'
    good_json='{"tool_name":"Write","tool_input":{"file_path":"'"${RAW_DIR}"'/__dummy_good.md","content":"---\nsource_url: https://example.com/x\ncollected: 2026-04-08T00:00:00Z\ncollector: intel-researcher\n---\n\n# Dummy\n\nBody text here.\n"}}'
    set +e
    printf '%s' "${bad_json}"  | "${VALIDATOR_SH}" >/dev/null 2>&1; bad_rc=$?
    printf '%s' "${good_json}" | "${VALIDATOR_SH}" >/dev/null 2>&1; good_rc=$?
    set -e
    if (( bad_rc != 0 )) && (( good_rc == 0 )); then
      status="OK (bad=${bad_rc}, good=${good_rc})"
    else
      status="FAIL (bad=${bad_rc}, good=${good_rc})"
    fi
  else
    status="SKIP (missing jq or validator)"
  fi
  results+=("raw validator hook: ${status}")

  # 4) wiki-lock acquire/release
  if [[ -x "${LOCK_SH}" ]]; then
    if "${LOCK_SH}" acquire metrics-selftest >/dev/null 2>&1 \
       && "${LOCK_SH}" release metrics-selftest >/dev/null 2>&1; then
      status="OK"
    else
      status="FAIL"
    fi
  else
    status="SKIP"
  fi
  results+=("wiki-lock acquire/release: ${status}")

  # 5) verify crontab wiki-daily-compile is disabled
  if crontab -l 2>/dev/null | grep -qE '^[^#]*wiki-daily-compile'; then
    status="FAIL (enabled!)"
  else
    status="OK (disabled)"
  fi
  results+=("cron wiki-daily-compile: ${status}")

  printf '%s\n' "${results[@]}"
}

# ---------- report rendering ----------
render_report() {
  local files="$1" tools="$2" total_cost="$3" avg_time="$4" query_ms="$5" index_state="$6"
  local today
  today="$(date -u +%Y-%m-%d)"

  local avg_cost tools_per_file cost_v time_v tools_v query_v index_v
  if (( files > 0 )); then
    avg_cost=$(awk -v c="${total_cost}" -v f="${files}" 'BEGIN{printf "%.4f", c/f}')
    tools_per_file=$(awk -v t="${tools}" -v f="${files}" 'BEGIN{printf "%.1f", t/f}')
  else
    avg_cost="N/A"
    tools_per_file="N/A"
  fi

  if [[ "${avg_cost}" == "N/A" ]]; then
    time_v="N/A"; cost_v="N/A"; tools_v="N/A"
  else
    time_v="$(verdict "${avg_time}"      "${TARGET_TIME_S}" lt)"
    cost_v="$(verdict "${avg_cost}"      "${TARGET_COST}"   lt)"
    tools_v="$(verdict "${tools_per_file}" "${TARGET_TOOLS}" lt)"
  fi

  if [[ "${query_ms}" == "N/A" ]]; then
    query_v="N/A"
  else
    query_v="$(verdict "${query_ms}" "${TARGET_QUERY_MS}" lt)"
  fi

  case "${index_state}" in
    OK) index_v="PASS" ;;
    *)  index_v="FAIL" ;;
  esac

  if (( MODE_MD == 1 )); then
    cat <<EOF
# Wiki KPI Report (${today})

samples: ${files} files · total_cost: \$${total_cost} · total_tools: ${tools}

| KPI | 목표 | 실측 | 판정 |
|---|---|---|---|
| 파일당 컴파일 시간 | < ${TARGET_TIME_S}s | ${avg_time}s | ${time_v} |
| 파일당 비용 | < \$${TARGET_COST} | \$${avg_cost} | ${cost_v} |
| tool call/file | < ${TARGET_TOOLS} | ${tools_per_file} | ${tools_v} |
| wiki-query avg | < ${TARGET_QUERY_MS}ms | ${query_ms}ms | ${query_v} |
| 인덱스 자동화 | type=index+generated | ${index_state} | ${index_v} |
| raw 규약 위반 | 0 | N/A (log 미집계) | N/A |
EOF
  else
    printf '=== Wiki KPI Report (%s) ===\n' "${today}"
    printf 'samples: %s files · total_cost: $%s · total_tools: %s\n\n' "${files}" "${total_cost}" "${tools}"
    printf '%-26s %-18s %-14s %s\n' "KPI" "TARGET" "ACTUAL" "VERDICT"
    printf '%-26s %-18s %-14s %s\n' "compile time/file" "< ${TARGET_TIME_S}s"    "${avg_time}s"       "${time_v}"
    printf '%-26s %-18s %-14s %s\n' "cost/file"          "< \$${TARGET_COST}"    "\$${avg_cost}"     "${cost_v}"
    printf '%-26s %-18s %-14s %s\n' "tool calls/file"    "< ${TARGET_TOOLS}"     "${tools_per_file}"  "${tools_v}"
    printf '%-26s %-18s %-14s %s\n' "wiki-query avg"     "< ${TARGET_QUERY_MS}ms" "${query_ms}ms"      "${query_v}"
    printf '%-26s %-18s %-14s %s\n' "index automated"    "type=index"            "${index_state}"     "${index_v}"
    printf '%-26s %-18s %-14s %s\n' "raw violations"     "0"                      "N/A"                "N/A"
  fi
}

# ---------- main ----------
main() {
  local logs parsed files tools total_cost avg_time query_ms index_state
  logs="$(select_logs)"

  if [[ -z "${logs}" ]]; then
    log "No trace logs found — run wiki-daily-compile first."
    printf 'No data (trace logs missing). Run wiki-daily-compile then retry.\n'
    parsed="0 0 0 0"
  else
    parsed="$(printf '%s\n' "${logs}" | parse_logs)"
  fi

  # shellcheck disable=SC2034
  IFS=' ' read -r files tools total_cost avg_time <<< "${parsed}"

  query_ms="$(bench_query)"
  index_state="$(check_index)"

  render_report "${files}" "${tools}" "${total_cost}" "${avg_time}" "${query_ms}" "${index_state}"

  if (( MODE_HEALTH == 1 )); then
    printf '\n=== Integration Healthcheck ===\n'
    run_health
  fi
}

main "$@"
