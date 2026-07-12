#!/usr/bin/env bash
# advisory-context-budget.sh — PreToolUse(Agent) per-turn context-occupancy advisory.
#
# Non-blocking STDERR advisory when the most-recent-turn context occupancy crosses a threshold,
# nudging toward GLOBAL_RULES Context Engineering (compact/summarize before the 80% boundary).
# Honest distinctness from advisory-spawn-cost.sh: that sums LIFETIME session tokens (delegation
# truncation risk); THIS reads only the LATEST event's cache_read (current-turn context) for CONTEXT
# DRIFT — different measure + advisory, so the co-fire on one Agent event is intentional.
# ADVISORY ONLY, never blocks — behavioral acts (progress.md creation, snip/micro/auto compaction)
# stay honor-system. cache_read is a proxy; the persisted row lags the live turn by ~1 turn.
# Manual-path only — ultracode/Workflow agent() spawn does not fire PreToolUse(Agent).
#
# Cost source: PG core.cost_events latest row by session_id (read-only). fail-open: ANY DB
# error/timeout/absent psycopg/corrupted payload → exit 0 silently. SELECT double-capped (connect 1s
# + statement 1500ms). psycopg Unix-socket only, never -h/-p.
#
# Latency: a short-TTL per-session read cache lets repeated spawns in one session reuse the last read
# instead of re-importing psycopg + reconnecting each time (the value already lags ~1 turn, so a
# few-second TTL adds no material staleness). Optimization ONLY — a miss/stale/error falls back to the
# live read, so the advisory value/verdict is identical to the uncached path within the TTL.

set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — never interfere with spawn.
trap 'printf "[context-budget-advisory] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

# TUNE: per-turn occupancy threshold (tokens). Set far above the GLOBAL_RULES "Context drift at
# 80K+" onset so it speaks only on a genuinely heavy turn, not routine cache reads. Env-overridable.
readonly DEFAULT_CONTEXT_TOKEN_THRESHOLD=350000
context_threshold="${CONTEXT_BUDGET_ADVISORY_THRESHOLD:-${DEFAULT_CONTEXT_TOKEN_THRESHOLD}}"
# Non-integer override → default (silent). Input-validation failure must not block the spawn.
if [[ ! "${context_threshold}" =~ ^[0-9]+$ ]]; then
  context_threshold="${DEFAULT_CONTEXT_TOKEN_THRESHOLD}"
fi

# Read the LATEST event's cache_read_tokens (1 integer line). STUBBABLE via
# CONTEXT_ADVISORY_TEST_TOKENS (Bats). fail-open → '0'. session_id via env-var + parameterized %s
# binding (neutralizes injection).
read_latest_context_tokens() {
  local sid="${1:-}"
  if [[ -n "${CONTEXT_ADVISORY_TEST_TOKENS:-}" ]]; then
    printf '%s\n' "${CONTEXT_ADVISORY_TEST_TOKENS}"
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
            # Latest-turn occupancy proxy: cache_read_tokens of the most recent event. NOT a SUM.
            cur.execute(
                "SELECT COALESCE(cache_read_tokens,0) FROM core.cost_events "
                "WHERE session_id=%s ORDER BY inserted_at DESC LIMIT 1",
                (sid,),
            )
            row = cur.fetchone()
            occ = int(row[0]) if row and row[0] is not None else 0
            sys.stdout.write(str(occ))
except Exception:
    # ANY DB error/timeout → fail-open(0).
    sys.stdout.write("0")
    sys.exit(0)
' 2>/dev/null || printf '0\n'
}

# Cached-or-live latest-turn occupancy. A fresh within-TTL cache hit SKIPS the psycopg import +
# connect entirely; a miss/stale/unreadable/error degrades to the live read (never suppresses the
# advisory, never fabricates a value). The stored + returned value is the integer-normalized token
# count, so a hit yields a value byte-identical to the live path (verdict parity). Caching is disabled
# when the session key is empty (no shared key) or CONTEXT_BUDGET_ADVISORY_CACHE_BYPASS is set.
# Default TTL 10s, env-overridable via CONTEXT_BUDGET_ADVISORY_CACHE_TTL (non-integer → default).
read_latest_context_tokens_cached() {
  local sid="${1}"
  local safe_sid ttl cache_dir cache_file value

  ttl="${CONTEXT_BUDGET_ADVISORY_CACHE_TTL:-10}"
  [[ "${ttl}" =~ ^[0-9]+$ ]] || ttl=10
  safe_sid="$(hook_path_safe_key "${sid}")"
  cache_dir="${CONTEXT_BUDGET_ADVISORY_CACHE_DIR:-${HOOK_LOG_DIR}/context-budget-advisory-cache}"
  cache_file=""
  [[ -n "${safe_sid}" ]] && cache_file="${cache_dir}/${safe_sid}.cache"

  # Cache hit → reuse (no psycopg import, no connect). Direct call in the if-condition (NOT $( )) so
  # set -e is disabled inside hook_cache_read → its miss `return 1` never trips the fail-open ERR
  # trap; the hit value comes back via the global HOOK_CACHE_VALUE. Predicate call → SC2310.
  if [[ -n "${cache_file}" ]] && [[ -z "${CONTEXT_BUDGET_ADVISORY_CACHE_BYPASS:-}" ]]; then
    # shellcheck disable=SC2310
    if hook_cache_read "${cache_file}" "${ttl}"; then
      printf '%s\n' "${HOOK_CACHE_VALUE}"
      return 0
    fi
  fi

  # Live read + integer-normalize (non-digit bytes stripped, empty → 0) — same normalization the
  # uncached path applied inline, kept here so the cached value equals the live value exactly.
  value="$(read_latest_context_tokens "${sid}")"
  value="$(printf '%s' "${value}" | tr -cd '0-9')"
  [[ -z "${value}" ]] && value=0

  # Persist for subsequent same-session spawns (best-effort — a write failure only forces a re-read).
  if [[ -n "${cache_file}" ]]; then
    # shellcheck disable=SC2310
    hook_cache_write "${cache_file}" "${value}" || true
  fi

  printf '%s\n' "${value}"
  return 0
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

# 3. Read latest-turn context occupancy (short-TTL per-session cache; any cache anomaly → live read).
#    The helper returns the integer-normalized value, identical to the live path.
context_tokens="$(read_latest_context_tokens_cached "${session_id}")"

# 4. Threshold comparison — at-or-below threshold stays silent.
if ((context_tokens <= context_threshold)); then
  exit 0
fi

# 5. STDERR advisory fire (no stdout JSON · not a block · exit 0).
tokens_k=$((context_tokens / 1000))
reason="Context-budget advisory: the most recent turn carried ~${tokens_k}k context tokens (cache_read), past the $((context_threshold / 1000))k per-turn-occupancy threshold — context drift degrades system-rule adherence at 80k+ (GLOBAL_RULES Context Engineering). Compact completed sections now: snip finished tool results to summaries, drop redundant context, summarize before the 80% auto-compact boundary. Non-blocking — the spawn proceeds. NOTE: cache_read is a per-turn occupancy PROXY and the persisted row lags the live turn by ~1 turn. This complements (does NOT duplicate) the lifetime-SUM session-cost advisory."
printf '[context-budget-advisory] %s\n' "${reason}" >&2

exit 0
