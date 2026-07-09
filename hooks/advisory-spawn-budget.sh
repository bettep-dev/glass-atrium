#!/usr/bin/env bash
# advisory-spawn-budget.sh — PreToolUse(Agent) cumulative-spawn-count advisory.
#
# Non-blocking advisory once a session's CUMULATIVE spawn count crosses a conservative threshold —
# a cost-discipline safety net for runaway fan-out. ADVISORY ONLY, never blocks.
# HONEST FRAMING: counts CUMULATIVE session spawns (lifetime append count), NOT concurrent children
# or chain depth — the PreToolUse(Agent) envelope carries neither, and the timestamp-less
# session-spawns append trace (written by enforce-verification-gate.sh) cannot reconstruct them, so
# concurrency/depth BLOCKING is an explicit Non-Goal. The cumulative count is a coarse proxy (a
# healthy multi-wave session spawns many agents sequentially), so the threshold sits high (see TUNE).
# Manual-path only — ultracode/Workflow agent() spawn fires no PreToolUse(Agent) and leaves no trace
# (fail-open under-count, never a false advisory).
#
# Trace source: ~/.claude/data/session-spawns/<session-key> (one subagent_type per line, read-only
# line count). session-key = session_id run through the writer's path-safe allowlist transform.
# Channel: STDERR advisory + exit 0 (PreToolUse accepts only approve/block; STDERR is no validation
# surface). fail-open on EVERYTHING: missing session_id / absent-or-unreadable / malformed trace /
# internal error → exit 0 silently.
# Ordering caveat: enforce-verification-gate.sh appends THIS spawn's line on the same event, so the
# read count may include or exclude the current spawn (±1) — immaterial for a coarse threshold.

set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — never interfere with spawn.
trap 'printf "[agent-spawn-budget-advisory] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# Trace dir override — captured BEFORE sourcing hook-utils.sh (which assigns HOOK_DATA_DIR and would
# clobber a caller env value). Dedicated var name (SESSION_SPAWNS_DIR) sidesteps the collision.
readonly DEFAULT_SPAWN_DIR="${HOME}/.claude/data/session-spawns"
spawn_dir="${SESSION_SPAWNS_DIR:-${DEFAULT_SPAWN_DIR}}"

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

# TUNE: concurrency is bounded by the Workflow engine runtime self-cap (orchestrator-role.md Spawn
# Budget), NOT a fixed number; this is a SEPARATE lifetime-CUMULATIVE runaway backstop with an
# ABSOLUTE threshold. A healthy multi-wave session was observed at ~20 cumulative, so 30 sits above
# that but below the 40-52 truncation range (orchestrator-role.md Delegation-size discipline).
# Env-overridable (SPAWN_BUDGET_ADVISORY_THRESHOLD).
readonly DEFAULT_THRESHOLD=30
threshold="${SPAWN_BUDGET_ADVISORY_THRESHOLD:-${DEFAULT_THRESHOLD}}"
# Non-integer override → default (silent). Input-validation failure must not block the spawn.
if [[ ! "${threshold}" =~ ^[0-9]+$ ]]; then
  threshold="${DEFAULT_THRESHOLD}"
fi

# Count cumulative spawn lines (1 integer). fail-open: absent/unreadable/empty trace → '0'.
# session_key is the path-safe single segment of session_id.
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
  # `grep -c ''` zero-match trap: grep prints "0" on no match, so `|| echo 0` would yield "0\n0" —
  # use `|| true` + empty-guard. `-c ''` counts every line.
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
