#!/usr/bin/env bash
# advisory-context-budget.sh — PreToolUse(Agent) per-turn context-occupancy advisory hook.
#
# Fires a non-blocking advisory once the session's MOST-RECENT-turn context occupancy crosses a
# threshold, nudging the orchestrator toward the GLOBAL_RULES Context Engineering discipline
# (compact completed sections, summarize before 80% consumption, drop redundant tool results).
#
# WHY THIS IS NOT A DUPLICATE OF advisory-spawn-cost.sh (honest distinctness — the whole point):
#   advisory-spawn-cost.sh sums LIFETIME session tokens (input+output+cache_read+cache_creation
#   across EVERY event) and warns about over-packed DELEGATIONS (truncation risk). That lifetime SUM
#   grows unboundedly across a long-but-healthy session and says NOTHING about whether the CURRENT
#   context window is near full — its own comment admits "per-turn context occupancy is the true
#   driver" it cannot measure. THIS hook fills exactly that gap: it reads only the LATEST event's
#   cache_read_tokens (≈ the context carried into the current turn) and warns about CONTEXT DRIFT /
#   compaction discipline (GLOBAL_RULES "Context drift at 80K+ tokens" / "80% context consumption").
#   Distinct measurement (latest-turn occupancy, not lifetime SUM), distinct advisory (compact-now,
#   not split-the-delegation). Co-fire on the same Agent event is intentional and complementary.
#
# WHAT THIS CANNOT DO (honest limits — no fake enforcement):
#   - It is ADVISORY ONLY and NEVER blocks. Behavioral context-engineering acts (progress.md
#     creation, snip/micro/auto compaction) stay HONOR-SYSTEM — they are irreducibly behavioral and
#     this hook makes NO claim to enforce them.
#   - cache_read_tokens is a PROXY for live context occupancy, and the cost_events row is written by
#     cost-tracker.sh on Stop, so the latest persisted row LAGS the live turn by ~1 turn.
#   - Manual-path only — the ultracode/Workflow agent() spawn does not fire PreToolUse(Agent).
#
# Cost source: PG core.cost_events latest row by session_id (read-only). Channel: STDERR advisory +
# exit 0 (PreToolUse schema accepts only approve/block; STDERR creates no validation surface).
# fail-open: ANY DB error/timeout/absent psycopg/corrupted payload → exit 0 silently. SELECT
# double-capped (connect 1s + statement 1500ms). psycopg Unix-socket only, never -h/-p.

set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — never interfere with spawn.
trap 'printf "[context-budget-advisory] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

# TUNE: per-turn context occupancy threshold (tokens). Anchored on GLOBAL_RULES "Context drift at
# 80K+ tokens" (the empirical drift onset) — but set well above it so the advisory speaks only when
# the current turn is carrying a genuinely heavy context, not on routine 80-200k cache reads. 350k
# ≈ a large fraction of the working window: heavy enough that compaction discipline is warranted,
# quiet on normal operation. Env-overridable for recalibration as core.cost_events accumulates.
readonly DEFAULT_CONTEXT_TOKEN_THRESHOLD=350000
context_threshold="${CONTEXT_BUDGET_ADVISORY_THRESHOLD:-${DEFAULT_CONTEXT_TOKEN_THRESHOLD}}"
# Non-integer override → default (silent). Input-validation failure must not block the spawn.
if [[ ! "${context_threshold}" =~ ^[0-9]+$ ]]; then
  context_threshold="${DEFAULT_CONTEXT_TOKEN_THRESHOLD}"
fi

# Read the LATEST event's context occupancy (cache_read_tokens) — echoes 1 integer line.
# STUBBABLE: CONTEXT_ADVISORY_TEST_TOKENS bypasses the live PG read (Bats). fail-open: ANY DB
# error/timeout/absent psycopg → '0'. session_id passed via env-var (neutralizes injection;
# parameterized %s binding).
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
            # Latest-turn occupancy proxy: cache_read_tokens of the most recent event for this
            # session (the context re-read into the current turn). NOT a lifetime SUM.
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

# 3. Read latest-turn context occupancy + integer-normalize (non-digit bytes stripped, empty → 0).
context_tokens="$(read_latest_context_tokens "${session_id}")"
context_tokens="$(printf '%s' "${context_tokens}" | tr -cd '0-9')"
[[ -z "${context_tokens}" ]] && context_tokens=0

# 4. Threshold comparison — at-or-below threshold stays silent.
if ((context_tokens <= context_threshold)); then
  exit 0
fi

# 5. STDERR advisory fire (no stdout JSON · not a block · exit 0).
tokens_k=$((context_tokens / 1000))
reason="Context-budget advisory: the most recent turn carried ~${tokens_k}k context tokens (cache_read), past the $((context_threshold / 1000))k per-turn-occupancy threshold — context drift degrades system-rule adherence at 80k+ (GLOBAL_RULES Context Engineering). Compact completed sections now: snip finished tool results to summaries, drop redundant context, summarize before the 80% auto-compact boundary. Non-blocking — the spawn proceeds. NOTE: cache_read is a per-turn occupancy PROXY and the persisted row lags the live turn by ~1 turn. This complements (does NOT duplicate) the lifetime-SUM session-cost advisory."
printf '[context-budget-advisory] %s\n' "${reason}" >&2

exit 0
