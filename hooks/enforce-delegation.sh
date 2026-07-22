#!/usr/bin/env bash
# PreToolUse(Write|Edit) — block ALL orchestrator direct writes regardless of path
# (only sub-agents may modify files).
# Sub-agents (agent_id present), allowed basenames (CLAUDE/MEMORY/GLASS_ATRIUM_GLOBAL_RULES.md), or */memory/* session-state paths pass; everything else is blocked with exit 2
# Block channel = stderr emit_error + exit 2 (non-substitutable with the stdout decision channel — see shared-hook-capability-contract.md)
#
# memory/* path-prefix exception (clauded-doc #8478 T6): the orchestrator MAY directly Write/Edit
# session-state files under any */memory/* segment — low-risk transient state, not a delegation surface.
# agents/*.md and every other harness path (rules/, hooks/, skills/, autoagent/, ...) stay BLOCKED:
# agent prompts are identity/PROMPTS (frontmatter name/tools/scope is a Safety-tier surface) and MUST
# route through delegation (meta-prompt-engineer), not a direct orchestrator write.
# SCOPE NOTE: this hook governs tool-call PERMISSION only — the Harness Path Protection user-approval
# obligation (orchestrator-role.md) is a SEPARATE behavioral gate that this exception does NOT weaken.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"

INPUT=$(hook_read_input)

# Fail-closed on a python3-less PATH, but ONLY when there is real input to guard.
# WHY: without python3 the tool_input probe fail-opens to `empty` (T3 AC4) — which the
# empty-state ALLOW below would misread as "nothing to guard" → ALLOW an orchestrator
# harness write. Blocking non-empty input here keeps that fail-open from disarming the
# gate; a genuinely-empty stdin ("" / "{}" / "{ }") still passes (nothing to guard).
hook_require_python3_unless_empty "${INPUT}" "DEL-002" \
  "Delegation gate unavailable: python3 is required to parse hook input"

# 1. Consume T3's three-state tool_input probe (present · empty · unrecognized).
#    The old `empty path → ALLOW` conflated a legitimately-empty field with a DRIFTED
#    envelope (host renamed/dropped tool_input) — the drift silently, permanently
#    DISARMED the gate (empty misread as "no file"). The probe tells the two apart.
STATE=""
FILE_PATH=""
# SC2312: the probe's own exit is deliberately unread — the in-band NUL-framed state
# record, not the pipeline exit, is what this gate consumes (the probe always fail-opens to 0).
# shellcheck disable=SC2312
{
  IFS= read -r -d '' STATE || true
  IFS= read -r -d '' FILE_PATH || true
} < <(hook_probe_tool_input "${INPUT}" "file_path")

case "${STATE}" in
  present) : ;; # real file_path in FILE_PATH — fall through to the path/basename/subagent checks
  unrecognized)
    # A degenerate empty stdin ("" / "{}" / "{ }") is nothing-to-guard, not drift →
    # keep the silent allow the DEL-002 input-empty carve-out already grants.
    # shellcheck disable=SC2310
    #   Intended predicate call in an if-condition (hook_input_is_empty returns 0/1).
    if hook_input_is_empty "${INPUT}"; then
      exit 0
    fi
    # A real drift (renamed / malformed / non-object tool_input) would disarm the gate →
    # emit a loud, aggregation-visible error, then ALLOW (ADR-2: emit-and-allow, not block).
    emit_error "DEL-003" "warn" \
      "Delegation gate disarmed: tool_input envelope unrecognized (host schema drift?)" \
      "Verify the PreToolUse tool_input schema — the gate is failing OPEN until it is fixed" \
      "{}"
    exit 0
    ;;
  *) exit 0 ;; # empty (legit-empty field OR python3-absent fail-open) — today's silent allow
esac

# 2. Allow exact basenames (memory-index + root-rule files).
BASENAME=$(basename "${FILE_PATH}")
case "${BASENAME}" in
  CLAUDE.md | MEMORY.md | GLASS_ATRIUM_GLOBAL_RULES.md) exit 0 ;;
  *) : ;;
esac

# 3. Allow direct orchestrator writes to session-state files under any */memory/* segment.
#    Normalize first so "memory/../hooks/x.sh" cannot spoof the segment. A "memory/" nested
#    directly under a protected harness dir (agents/, rules/, hooks/, skills/, autoagent/,
#    monitor/, scripts/) is NOT a session-state root — those stay BLOCKED so a harness write
#    cannot bypass via a "memory" segment (e.g. agents/memory/x.md must route through delegation).
NORM_PATH=$(hook_normalize_path "${FILE_PATH}")
case "/${NORM_PATH}/" in
  */agents/memory/* | */rules/memory/* | */hooks/memory/* | */skills/memory/* | \
    */autoagent/memory/* | */monitor/memory/* | */scripts/memory/*) : ;;
  */memory/*) exit 0 ;;
  *) : ;;
esac

# 4. Extract agent_id — if present, this is a sub-agent, so pass.
#    Intended predicate call (hook_is_subagent returns 0/1) → SC2310 disabled.
# shellcheck disable=SC2310
if hook_is_subagent "${INPUT}"; then
  exit 0
fi

# 5. Block orchestrator direct modification (agents/*.md and all other harness paths)
emit_error "DEL-001" "block" \
  "Orchestrator direct file modification blocked" \
  "Delegate file modification to a sub-agent" \
  "{\"file_path\":\"${FILE_PATH}\"}"
exit 2
