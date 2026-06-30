#!/bin/bash
# llm-preflight.sh — LLM API availability preflight check / cost advisor
#
# Two modes:
#   1. Sourced (legacy):   source ~/.claude/scripts/llm-preflight.sh
#                          REASON=$(llm_preflight 10.00) || { echo "Preflight failed: $REASON"; exit 1; }
#      → Performs daily cost gate + 30s LLM ping; returns non-zero on failure.
#
#   2. Standalone (new):   bash ~/.claude/scripts/llm-preflight.sh [budget]
#      → Emits a single-line advisory like:
#          [llm-preflight] cost_today=$1.23 budget=$10.00 status=OK
#        Always exits 0 (advisory only — never blocks). Skips the costly LLM ping.
#
# NOTE: standalone mode is intended for cron-driven cost visibility.
# It MUST NOT be wired into SessionStart (per audit plan: 30s ping per session is too expensive).
#
# COST SOURCE: the daily-cost figure comes from PG core.cost_events (event_date =
# current_date), the live single sink. See _llm_preflight_today_cost.

PREFLIGHT_CLAUDE="${AUTOAGENT_CLAUDE_BIN:-claude}"

# Resolve the haiku model id from the daemon-config.json SoT — prevents dated-pin drift.
# jq missing / file missing / key missing → fall back to the alias literal claude-haiku-4-5 (same policy as daemon_config.py).
# Resolved once for both sourced and direct-execution paths (ping happens only in Check B).
PREFLIGHT_DAEMON_CONFIG="${HOME}/.claude/data/daemon-config.json"
PREFLIGHT_HAIKU_MODEL="claude-haiku-4-5"
if command -v jq >/dev/null 2>&1 && [[ -f "${PREFLIGHT_DAEMON_CONFIG}" ]]; then
  _preflight_cfg_model="$(jq -r '.haiku_model // empty' "${PREFLIGHT_DAEMON_CONFIG}" 2>/dev/null || true)"
  [[ -n "${_preflight_cfg_model}" ]] && PREFLIGHT_HAIKU_MODEL="${_preflight_cfg_model}"
fi

# Compute today's accumulated cost from PG core.cost_events (the live single
# sink). Echoes a "%.2f" formatted USD figure on stdout:
# SUM(cost_usd) WHERE event_date = current_date.
#
# fail-open: DB unreachable / psycopg absent / query error → echo 0.00. To keep a
# dead gate VISIBLE, a live-read failure also emits a one-line stderr advisory —
# the threshold gate still passes on a DB hiccup, but the unreachable cost source
# is no longer silent.
#
# psycopg Unix-socket only (never -h/-p), connect double-capped (connect 1s +
# statement 1500ms) — mirrors advisory-spawn-cost.sh. STUBBABLE for Bats:
# LLM_PREFLIGHT_TEST_COST bypasses the live PG read entirely.
_llm_preflight_today_cost() {
  if [[ -n "${LLM_PREFLIGHT_TEST_COST:-}" ]]; then
    printf '%.2f\n' "${LLM_PREFLIGHT_TEST_COST}"
    return 0
  fi

  # Python writes the cost figure to stdout; on any failure it writes the literal
  # sentinel "ERR" instead, which the wrapper converts to a visible advisory + 0.00.
  local raw
  raw="$(python3 -c '
import sys
try:
    import psycopg
except Exception:
    sys.stdout.write("ERR")
    sys.exit(0)
try:
    with psycopg.connect(
        "dbname=glass_atrium", connect_timeout=1, options="-c statement_timeout=1500"
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COALESCE(SUM(cost_usd),0) "
                "FROM core.cost_events WHERE event_date = current_date"
            )
            row = cur.fetchone()
            total = float(row[0]) if row and row[0] is not None else 0.0
            sys.stdout.write("%.2f" % total)
except Exception:
    # ANY DB error/timeout → sentinel → fail-open(0.00) + stderr advisory.
    sys.stdout.write("ERR")
    sys.exit(0)
' 2>/dev/null || printf 'ERR')"

  if [[ "${raw}" == "ERR" || -z "${raw}" ]]; then
    # Visibility: a dead/unreachable cost source must not silently always-pass.
    printf '[llm-preflight] WARN: cost source (PG core.cost_events) unreachable — daily-cost gate failing open to %s0.00\n' '$' >&2
    printf '%.2f\n' 0
    return 0
  fi
  printf '%.2f\n' "${raw}"
}

# Existing public API — sourced callers depend on this signature/behavior.
llm_preflight() {
  local threshold="${1:-10.00}"
  local total

  # Check A: daily cost threshold
  total="$(_llm_preflight_today_cost)"
  if awk "BEGIN{exit(!(${total} >= ${threshold}))}"; then
    echo "Daily cost threshold exceeded (\$${total} / \$${threshold})"
    return 1
  fi

  # Check B: minimal LLM ping (timeout 30s, no GNU coreutils needed)
  local ping_result ping_tmp ping_pid wdog_pid ping_exit
  ping_tmp="$(mktemp)"

  OTEL_METRICS_EXPORTER=none OTEL_LOGS_EXPORTER=none CLAUDE_CODE_ENABLE_TELEMETRY=0 \
    "${PREFLIGHT_CLAUDE}" -p "respond OK" \
    --max-budget-usd 1.00 \
    --model "${PREFLIGHT_HAIKU_MODEL}" \
    --output-format text >"${ping_tmp}" 2>/dev/null &
  ping_pid=$!

  # Watchdog: kill the command after 30 seconds
  (sleep 30 && kill "${ping_pid}" 2>/dev/null) &
  wdog_pid=$!

  wait "${ping_pid}" 2>/dev/null
  ping_exit=$?
  # Cancel watchdog if command finished before timeout
  kill "${wdog_pid}" 2>/dev/null || true
  wait "${wdog_pid}" 2>/dev/null || true

  if [[ "${ping_exit}" -ne 0 ]]; then
    rm -f "${ping_tmp}"
    echo "LLM ping failed (claude -p exit=${ping_exit})"
    return 1
  fi

  ping_result="$(cat "${ping_tmp}")"
  rm -f "${ping_tmp}"

  if [[ -z "${ping_result}" ]]; then
    echo "LLM ping returned empty response"
    return 1
  fi

  return 0
}

# Standalone advisory mode — no LLM ping, no blocking, single-line stdout, exit 0.
# Status bands: CRITICAL >= 90% of budget, WARN >= 70% of budget, otherwise OK.
_llm_preflight_main() {
  local budget="${1:-10.00}"
  local total status

  total="$(_llm_preflight_today_cost)"
  # awk-driven banding keeps macOS Bash 3.2 compatibility (no `bc`, no float math).
  status="$(awk -v t="${total}" -v b="${budget}" 'BEGIN{
    if (b <= 0) { print "OK"; exit }
    r = t / b
    if (r >= 0.9)      print "CRITICAL"
    else if (r >= 0.7) print "WARN"
    else               print "OK"
  }')"

  printf '[llm-preflight] cost_today=$%s budget=$%s status=%s\n' "${total}" "${budget}" "${status}"
  return 0
}

# Detect direct invocation. When sourced, BASH_SOURCE[0] != $0.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  _llm_preflight_main "$@"
  exit 0
fi
