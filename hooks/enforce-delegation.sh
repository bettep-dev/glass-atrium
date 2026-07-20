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
# WHY: without python3, hook_get_tool_input degrades to EMPTY — which the `[[ -z FILE_PATH ]] && exit 0`
# below would misread as "no file" → ALLOW an orchestrator harness write.
hook_require_python3_unless_empty "${INPUT}" "DEL-002" \
  "Delegation gate unavailable: python3 is required to parse hook input"

# 1. Extract file_path
FILE_PATH=$(hook_get_tool_input "${INPUT}" "file_path")
[[ -z "${FILE_PATH}" ]] && exit 0

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
