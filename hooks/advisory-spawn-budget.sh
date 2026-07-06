#!/usr/bin/env bash
# advisory-spawn-budget.sh — PreToolUse(Agent) cumulative-spawn-count advisory hook.
#
# Fires a non-blocking advisory once a session's CUMULATIVE spawn count crosses a conservative
# threshold, reminding the orchestrator of the cumulative-spawn cost-discipline safety net when a
# session fans out far past it.
#
# HONEST FRAMING — what this measures and what it CANNOT:
#   This counts CUMULATIVE session spawns (lifetime append count for the session), NOT concurrent
#   children and NOT chain depth. The PreToolUse(Agent) stdin envelope exposes only
#   session_id / subagent_type / agent_id / prompt — it carries NO concurrent-child count and NO
#   chain-depth signal. The ~/.claude/data/session-spawns/<key> trace (written by
#   enforce-verification-gate.sh) is a timestamp-less cumulative append (one line per spawn), so
#   reconstructing true concurrency or depth from it is INFEASIBLE. True concurrency/depth BLOCKING
#   is therefore an explicit Non-Goal. This hook is ADVISORY ONLY and NEVER blocks.
#
#   The cumulative count is a coarse proxy: a long, healthy multi-wave session legitimately spawns
#   many agents sequentially. The threshold is set high enough (≈30 cumulative, see TUNE below) to stay quiet on
#   normal sequential-wave work and only speak up on a runaway fan-out.
#
# Manual-path only — the ultracode/Workflow engine's agent() spawn does not fire PreToolUse(Agent),
# so it leaves no session-spawns trace; this hook is silent on that path (a fail-open under-count,
# never a false advisory).
#
# Trace source: ~/.claude/data/session-spawns/<session-key> (cumulative spawn lines, one
# subagent_type per line). Read-only line count. session-key derived from session_id by the same
# path-safe allowlist transform the writer uses (delete every byte outside [A-Za-z0-9_-]).
#
# Channel: STDERR advisory + exit 0 — the PreToolUse schema accepts only approve/block, so any
# stdout "advisory" JSON would be rejected; STDERR creates no validation surface.
#
# fail-open on EVERYTHING: missing session_id / absent or unreadable / malformed trace / internal
# error → exit 0 silently (no false advisory).
#
# Ordering caveat: enforce-verification-gate.sh appends THIS spawn's line on the same
# PreToolUse(Agent) event. Depending on hook registration order, the count this hook reads may
# include or exclude the current spawn (±1). For a coarse "far past budget" threshold the ±1 is
# immaterial.

set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — never interfere with spawn.
trap 'printf "[agent-spawn-budget-advisory] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# Trace dir override — captured BEFORE sourcing hook-utils.sh, which unconditionally assigns
# HOOK_DATA_DIR="${HOME}/.claude/data" and would clobber a caller's env value. Dedicated var name
# (SESSION_SPAWNS_DIR, same convention as prune-session-spawns.sh) sidesteps that collision.
readonly DEFAULT_SPAWN_DIR="${HOME}/.claude/data/session-spawns"
spawn_dir="${SESSION_SPAWNS_DIR:-${DEFAULT_SPAWN_DIR}}"

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

# TUNE: concurrency is bounded by the Workflow engine's runtime self-cap (core-derived, per-machine;
# orchestrator-role.md Spawn Budget) — NOT by a fixed per-orchestrator number. This advisory is a
# SEPARATE, lifetime-CUMULATIVE runaway backstop, so it keeps an ABSOLUTE threshold. Cumulative
# spawns naturally climb across sequential waves — a healthy multi-wave session was observed at ~20
# cumulative. The cost concern is a RUNAWAY fan-out, so the threshold sits at 30: above the
# observed-healthy ~20, below the empirically-anchored 40-52 truncation range (orchestrator-role.md
# Delegation-size discipline HARD SECONDARY trigger). Env-overridable
# (SPAWN_BUDGET_ADVISORY_THRESHOLD) for recalibration as session-spawn percentiles accumulate.
readonly DEFAULT_THRESHOLD=30
threshold="${SPAWN_BUDGET_ADVISORY_THRESHOLD:-${DEFAULT_THRESHOLD}}"
# Non-integer override → default (silent). Input-validation failure must not block the spawn.
if [[ ! "${threshold}" =~ ^[0-9]+$ ]]; then
  threshold="${DEFAULT_THRESHOLD}"
fi

# Count cumulative spawn lines for the session — echoes 1 integer line. fail-open: absent /
# unreadable / empty trace → '0'. session_key is the path-safe single segment of session_id.
count_session_spawns() {
  local session_key="${1:-}"
  [[ -z "${session_key}" ]] && {
    printf '0\n'
    return 0
  }
  local marker_path="${spawn_dir}/${session_key}"
  # Absent or non-readable trace → fail-open count 0.
  [[ -f "${marker_path}" && -r "${marker_path}" ]] || {
    printf '0\n'
    return 0
  }
  # `grep -c ''` zero-match trap (Key Patterns): grep already prints "0" on no match, so a trailing
  # `|| echo 0` would yield "0\n0". Use `|| true` then empty-guard. `-c ''` counts every line.
  local lines
  lines="$(grep -c '' "${marker_path}" 2>/dev/null || true)"
  [[ -z "${lines}" ]] && lines=0
  printf '%s\n' "${lines}"
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

# 3. SECURITY: session_id is external payload → allowlist-transform to a path-safe single segment
# (delete every byte outside [A-Za-z0-9_-]) before path interpolation, blocking path-traversal.
# Empty result → fail-open. (core-security.md Input Validation · LLM01 untrusted input.)
session_key="$(hook_path_safe_key "${session_id}")"
[[ -z "${session_key}" ]] && exit 0

# 4. Count cumulative spawns + integer-normalize (non-digit bytes stripped, empty → 0).
spawn_count="$(count_session_spawns "${session_key}")"
spawn_count="$(printf '%s' "${spawn_count}" | tr -cd '0-9')"
[[ -z "${spawn_count}" ]] && spawn_count=0

# 5. Threshold comparison — at-or-below threshold stays silent.
if ((spawn_count <= threshold)); then
  exit 0
fi

# 6. STDERR advisory fire (no stdout JSON · not a block · exit 0).
reason="Spawn-budget advisory: this session has cumulative ${spawn_count} agent spawns, past the ${threshold} runaway-fan-out threshold (a lifetime-cumulative safety net; concurrency itself is bounded by the Workflow engine's runtime self-cap, not a fixed number — orchestrator-role.md Spawn Budget). Consider sequential waves over parallel overflow, and one-budget-sized delegations over many tiny spawns (each spawn re-tokenizes system prompt + tool schemas). Non-blocking — the spawn proceeds. NOTE: this is CUMULATIVE lifetime spawns, NOT concurrent children or chain depth (the PreToolUse envelope cannot provide those)."
printf '[agent-spawn-budget-advisory] %s\n' "${reason}" >&2

exit 0
