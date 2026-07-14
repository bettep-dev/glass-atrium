#!/usr/bin/env bash
# advisory-spawn-cost.sh — PreToolUse(Agent) session-cost advisory.
#
# When cumulative session tokens exceed the threshold, fires a non-blocking advisory once before
# spawn ("session heavy, split remaining work") — guards against a single overpacked delegation
# truncating the sub-agent (missing [COMPLETION]), which the turn-based guard misses.
# Manual-path only — ultracode/Workflow agent() spawn does not fire PreToolUse(Agent).
# Cost source: PG core.cost_events by session_id (read-only; total lags the current turn by ~1 turn —
# harmless for an "already heavy" threshold). Channel: STDERR advisory + exit 0. fail-open: ANY DB
# error/timeout/absent psycopg/corrupted payload → exit 0. SELECT double-capped (connect 1s +
# statement 1500ms; no timeout binary on stock macOS). psycopg Unix-socket only, never -h/-p.
#
# Latency: a short-TTL per-session read cache lets repeated spawns in one session reuse the last read
# instead of re-importing psycopg + reconnecting each time (the total already lags ~1 turn, so a
# few-second TTL adds no material staleness). Optimization ONLY — a miss/stale/error falls back to the
# live read, so the advisory value/verdict is identical to the uncached path within the TTL.

set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — never interfere with spawn.
trap 'printf "[agent-spawn-cost-advisory] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

# TUNE: above p95 (~1.13M), below the ~7M p99 truncation cluster → ~5x margin. Tokens (price-stable +
# truncation-relevant). Caveat: cumulative tokens is a proxy; per-turn occupancy is the true driver.
readonly CUMULATIVE_TOKEN_THRESHOLD=2000000

# Read cumulative session tokens (1 integer). STUBBABLE via COST_ADVISORY_TEST_TOKENS (Bats).
# fail-open → '0'. session_id via env-var + parameterized %s binding (neutralizes injection).
# SC2329: invoked indirectly by name via hook_cached_int_read's dynamic dispatch — not dead code.
# shellcheck disable=SC2329
read_session_tokens() {
  local sid="${1:-}"
  if [[ -n "${COST_ADVISORY_TEST_TOKENS:-}" ]]; then
    printf '%s\n' "${COST_ADVISORY_TEST_TOKENS}"
    return 0
  fi
  [[ -z "${sid}" ]] && {
    printf '0\n'
    return 0
  }
  SESSION_ID="${sid}" python3 -c '
import os, sys
try:
    import psycopg
except Exception:
    sys.stdout.write("0")
    sys.exit(0)
sid = os.environ.get("SESSION_ID", "")
if not sid:
    sys.stdout.write("0")
    sys.exit(0)
try:
    with psycopg.connect(
        "dbname=glass_atrium", connect_timeout=1, options="-c statement_timeout=1500"
    ) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COALESCE(SUM("
                "input_tokens+output_tokens+cache_read_tokens+cache_creation_tokens"
                "),0) FROM core.cost_events WHERE session_id=%s",
                (sid,),
            )
            row = cur.fetchone()
            total = int(row[0]) if row and row[0] is not None else 0
            sys.stdout.write(str(total))
except Exception:
    # ANY DB error/timeout → fail-open(0).
    sys.stdout.write("0")
    sys.exit(0)
' 2>/dev/null || printf '0\n'
}

# 1. Read input + Agent tool gate.
input="$(hook_read_input)"

tool_name="$(hook_get_field "${input}" "tool_name")"
[[ "${tool_name}" != "Agent" ]] && exit 0

# 2. Resolve session_id (stdin → CLAUDE_SESSION_ID fallback); absent → fail-open.
session_id="$(hook_get_field "${input}" "session_id")"
if [[ -z "${session_id}" ]]; then
  session_id="${CLAUDE_SESSION_ID:-}"
fi
[[ -z "${session_id}" ]] && exit 0

# 3. Read cumulative tokens (short-TTL per-session cache; any cache anomaly → live read).
#    hook_cached_int_read (hook-utils.sh) returns the integer-normalized value, identical to the live path.
total_tokens="$(hook_cached_int_read SPAWN_COST_ADVISORY spawn-cost-advisory-cache read_session_tokens "${session_id}")"

# 4. Threshold comparison — applied uniformly to every Agent spawn (cost is agent-independent).
if ((total_tokens < CUMULATIVE_TOKEN_THRESHOLD)); then
  exit 0
fi

# 5. STDERR advisory fire (no stdout JSON · not a block · exit 0).
tokens_k=$((total_tokens / 1000))
reason="Session-cost advisory: cumulative session tokens ~${tokens_k}k exceed the ${CUMULATIVE_TOKEN_THRESHOLD} threshold (this session is already heavy). Split remaining work into smaller one-budget-sized delegations (avoid bundling implement+test+full-suite+report in one spawn), prefer fewer spawns over over-fragmentation, and consider direct verification or a fresh session. Non-blocking — the spawn proceeds. NOTE: PG total lags the current turn by ~1 turn."
printf '[agent-spawn-cost-advisory] %s\n' "${reason}" >&2

exit 0
