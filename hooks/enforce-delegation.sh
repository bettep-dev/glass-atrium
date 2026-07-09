#!/usr/bin/env bash
# PreToolUse(Write|Edit) — block the orchestrator's direct file modification across ~/.claude/,
# ~/.claude-work/, ~/.claude-personal/ (only sub-agents may modify).
# Sub-agents (agent_id present) or allowed basenames (CLAUDE/MEMORY/GLASS_ATRIUM_GLOBAL_RULES.md) pass; everything else is blocked with exit 2
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

# Normalize a POSIX path — collapse "." / ".." segments without touching the filesystem
# (target may not exist yet). Traversal-safety: "memory/../hooks/x.sh" resolves to "hooks/x.sh",
# so a "memory" segment cannot be forged via "..". Args: $1 = path. Echoes normalized path.
normalize_path() {
  local path="${1}" seg
  local -a out=()
  local lead=""
  [[ "${path}" == /* ]] && lead="/"
  local saved_ifs="${IFS}"
  IFS='/'
  # Word-split on "/" intentionally to walk each segment.
  # shellcheck disable=SC2206
  local -a parts=(${path})
  IFS="${saved_ifs}"
  # ${arr[@]+"${arr[@]}"} guards empty-array expansion under set -u on bash 3.2.
  for seg in ${parts[@]+"${parts[@]}"}; do
    case "${seg}" in
      "" | ".") : ;;
      "..")
        # Pop the last real segment (do not pop past root / a leading "..").
        if [[ ${#out[@]} -gt 0 && "${out[${#out[@]} - 1]}" != ".." ]]; then
          unset 'out[${#out[@]}-1]'
          out=(${out[@]+"${out[@]}"})
        elif [[ -z "${lead}" ]]; then
          out+=("..")
        fi
        ;;
      *) out+=("${seg}") ;;
    esac
  done
  local joined=""
  if [[ ${#out[@]} -gt 0 ]]; then
    local saved_ifs2="${IFS}"
    IFS='/'
    joined="${out[*]}"
    IFS="${saved_ifs2}"
  fi
  printf '%s\n' "${lead}${joined}"
}

INPUT=$(hook_read_input)

# Fail-closed on a python3-less PATH, but ONLY when there is real input to guard.
# WHY: without python3, hook_get_tool_input degrades to EMPTY — which the `[[ -z FILE_PATH ]] && exit 0`
# below would misread as "no file" → ALLOW an orchestrator harness write. Empty input ("{}") stays
# exit 0 (nothing to guard); a non-trivial INPUT whose extraction we cannot trust MUST block.
case "${INPUT}" in
  "" | "{}" | "{ }") : ;; # nothing to guard — empty-input case stays exit 0
  *) hook_require_python3 "DEL-002" \
    "Delegation gate unavailable: python3 is required to parse hook input" ;;
esac

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
NORM_PATH=$(normalize_path "${FILE_PATH}")
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
