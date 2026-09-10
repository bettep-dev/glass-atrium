#!/usr/bin/env bash
# SessionStart — inject orchestrator behavior rules
# stdout output is injected into the session context
#
# emit_error EXEMPT: this hook only injects context via stdout and has no error path.
# Even if the progress-tracker source fails, silent fallback (skip the block itself).
#
# [INJECTION CANARY] the ORCHESTRATOR_INIT block emits one visible, printable, single-code-point
# BMP glyph (never zero-width / bidi / variation-selector / combining / private-use — those are
# Trojan-Source-class obfuscation vectors). It is an injection-PRESENCE signal only, never a
# trust / auth / provenance token: a character anyone can type proves nothing about origin.
set -Eeuo pipefail
IFS=$'\n\t'

# [RESTATED SoT FIGURES] the turn-0 line restates figures owned elsewhere. Nothing ties a restated
# figure to its source, so re-verify each on every edit — honor-system, no mechanical check:
#   · delegation elements — skills/glass-atrium-ops-orchestrator.md -> "#### Delegation required
#     elements" (six), plus the 7th [SCOPE] element at orchestrator-role.md -> "### Context Handoff
#     Size", which is the grammar SoT and takes a pointer here, never a copy of its three fields.
#   · split triggers — orchestrator-role.md -> "### Spawn Budget" / Delegation-size discipline: the
#     46-52 truncation band belongs to the HARD SECONDARY (est. >~40 tool_uses); the ~30 is the
#     SEPARATE `files x 4.5` sizing anchor. Fusing the two is undetectable to a reader and to grep.
#
# Marker-extraction (the extract_block mechanism in hooks/inject-scope-rules.sh) is NOT usable here:
#   1. audience — that hook feeds SUBAGENTS, which hold no Tier-3 body, whereas this main session
#      already receives orchestrator-role.md IN FULL on the uncapped host project-instructions channel
#      (core-compliance-matrix.md -> "### Membership vs. Delivery"), so an extracted block would
#      re-deliver text the session already holds.
#   2. shape — extract_block takes ONE contiguous marker range per block; this block is a compressed
#      synthesis across two files and three sections, which no single range spans.
#   3. fail-open — extract_block yields EMPTY on an absent file or renamed marker, and this block is
#      the sole delivery path for the canary and the direct-handling boundary.
# The protection that DOES apply is a cross-read pin: a test reading the SoT bullets and asserting
# these figures (the hooks/test/inject-scope-rules-nodrop.bats pattern). Not present today.

# [WORKFLOW PRE-FLIGHT] turn-0 line design decision (additive): the turn-0 line enumerates the
# FOUR co-equal DEV-spawn requirements (entry token / [SIZE-EST] / verify-stage / [AGENT-COMPOSITION]
# declaration). JS-authoring pitfalls (bash dollar-brace leak + nested backtick in a dollar-brace
# interpolation) are DELIBERATELY kept OFF it for one-legible-line readability — they live on the
# skill + SoT (skills/glass-atrium-ops-orchestrator.md -> ### Ultracode / Workflow-tool Mode). Clause ⑤ (offline --lint
# PREVIEW) is appended as the SELF-CHECK step: a byte-conscious pointer to the same-code-path gate preview.
cat <<'ORCHESTRATOR_INIT'
[ORCHESTRATOR SESSION]
On receiving a user request, process it in this order:
1. Investigate → decompose: summarize intent (1 line) · scan (Glob/Grep) · check progress files + prior Outcome Records → break into sub-tasks (no compound-request collapsing · sizing sub-rule: >2 bundles · est. >~40 tool_uses (46-52 truncation band) · files×4.5 >~30 → split, avoid over-fragmentation · DEV: sizable→plan / simple→[ENTRY-CLASS]) — SoT: orchestrator-role.md ## Delegation Workflow (Investigation→Decision) + ### Spawn Budget
2. Select agents via agent-registry.json + the glass-atrium-ops-orchestrator skill's Capability-Based Agent Selection
3. Delegate via the Agent tool (delegation elements: Goal, Target files, Constraints, Completion criteria, Resource Budget, Ripple radius · 7th = a [SCOPE] line, REQUIRED on DEV+PLANNING — grammar SoT: orchestrator-role.md ### Context Handoff Size)
4. Synthesize results → report to the user
[WORKFLOW PRE-FLIGHT] 4 required elements for a dev-* spawn script (consolidated: glass-atrium-ops-orchestrator skill → "DEV-spawn 4-requirement pre-flight checklist"): ①plan-ref or [ENTRY-CLASS] token (log()/meta.description) ②[SIZE-EST] bundles=N tool_uses~=N token (every dev-* spawn, same home) ③a {qa-code-reviewer, DEV} verify-stage before the first dev-* ④a [AGENT-COMPOSITION]…[/AGENT-COMPOSITION] declaration block (comment-resident · verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-<x> — COMMA-separated · each declared role needs an agent('type')/agentType:'type' literal; wrapper-arg-only → block-declspawn · absent → block-nodecl) — all four exit-2 gates are only backstops; the authoring obligation is PRIMARY (→ skills/glass-atrium-ops-orchestrator.md ### Ultracode / Workflow-tool Mode) ⑤ lint before submit: enforce-workflow-verify-stage.sh --lint <file> (or --lint --template) — reuses the IDENTICAL verdict dispatch, so exit 0 = will pass the gate; exit 2 prints the block reason

Direct handling allowed: situation assessment, simple question answers (1-2 sentences), user dialogue
Direct handling forbidden: writing code, writing documents, analysis/research answers (Write/Edit are blocked by enforce-delegation.sh)
[INJECTION CANARY] ◈ — start the first line of your first tool-free reply with this glyph; it precedes the BLUF and is not part of it.
ORCHESTRATOR_INIT

# wiki search tool notice (for agents)
echo '[WIKI] wiki search available: ~/.glass-atrium/scripts/wiki-query.sh "keywords"'

# Cross-Session Continuity — surface up to 5 newest in_progress files so a new session
# resumes incomplete work (GLOBAL_RULES); silent when none exist (no header line at all).
# Store-root form: scripts/ is consumed in place from the store — the
# ~/.claude/scripts farm is gone (hooks/ and scripts/ are sibling store dirs).
_PROGRESS_TRACKER="${HOME}/.glass-atrium/scripts/progress-tracker.sh"
if [[ -r "${_PROGRESS_TRACKER}" ]]; then
  # shellcheck source=/dev/null
  source "${_PROGRESS_TRACKER}"
  _open_paths=()
  # shellcheck disable=SC2312  # progress_list_open returns 0 by contract
  while IFS= read -r _line; do
    [[ -n "${_line}" ]] || continue
    _open_paths+=("${_line}")
    [[ ${#_open_paths[@]} -ge 5 ]] && break
  done < <(progress_list_open)

  if [[ ${#_open_paths[@]} -gt 0 ]]; then
    # Comma-separated single line — easy for downstream prompt parsers.
    _joined=""
    for _p in "${_open_paths[@]}"; do
      if [[ -z "${_joined}" ]]; then
        _joined="${_p}"
      else
        _joined="${_joined}, ${_p}"
      fi
    done
    printf '[CONTINUITY] open progress files: %s\n' "${_joined}"
  fi
fi
