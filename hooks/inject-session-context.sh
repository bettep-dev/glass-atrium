#!/usr/bin/env bash
# SessionStart — inject orchestrator behavior rules; stdout is the injected session context
# emit_error EXEMPT: context injection only, no error path — a failed progress-tracker source skips its block
#
# [INJECTION CANARY] ORCHESTRATOR_INIT emits one visible, printable, single-code-point BMP glyph
#   · never zero-width / bidi / variation-selector / combining / private-use (Trojan-Source vectors)
#   · injection-PRESENCE signal only — never a trust / auth / provenance token
set -Eeuo pipefail
IFS=$'\n\t'

# No $(cat): with fd 0 closed, the capture pipe takes fd 0 and cat deadlocks on it; read just fails.
_envelope=""
if [[ ! -t 0 ]]; then
  IFS= read -r -d '' _envelope 2>/dev/null || true # EOF before a NUL is the normal end of the envelope
fi

# [RESTATED SoT FIGURES] turn-0 lines restate figures owned elsewhere → re-verify each on every edit
#   · no mechanical check: the re-verify duty is honor-system
#   · delegation elements — skills/glass-atrium-ops-orchestrator.md -> "#### Delegation required elements" (six)
#   · 7th element [SCOPE] — orchestrator-role.md -> "### Context Handoff Size" (grammar SoT, pointer only)
#   · split triggers — orchestrator-role.md -> "### Spawn Budget" / Delegation-size discipline
#     46-52 truncation band = HARD SECONDARY (est. >~40 tool_uses) · ~30 = SEPARATE `files x 4.5` anchor — never fuse
#   · reply language — GLASS_ATRIUM_GLOBAL_RULES.md -> "## Absolute Rules [ALL]" -> "### Output Language"
#   · the response-language rule and its children are restated by the three "Reply language" heredoc lines
#   · flow steps 3 and 5 — skills/glass-atrium-ops-orchestrator.md -> "## Managed Document Completion (Direct Handling)" Step 1 / Step 3
#
# Marker extraction (extract_block in hooks/inject-scope-rules.sh) is NOT usable here:
#   1. audience — that hook feeds SUBAGENTS, not this main session
#      main session holds orchestrator-role.md IN FULL (uncapped host channel) → extraction re-delivers held text
#      host-channel delivery SoT: core-compliance-matrix.md -> "### Membership vs. Delivery"
#   2. shape — one contiguous marker range per block; this block synthesizes two files and three sections
#   3. fail-open — EMPTY on an absent file or renamed marker; this block is the sole canary + direct-handling path
# Protection that DOES apply, absent today: a cross-read pin of these figures against the SoT bullets
#   pattern to copy: hooks/test/inject-scope-rules-nodrop.bats

# [WORKFLOW PRE-FLIGHT] the turn-0 line enumerates the FOUR co-equal DEV-spawn requirements
#   · the four: entry token / [SIZE-EST] / verify-stage / [AGENT-COMPOSITION] declaration
#   · JS-authoring pitfalls (bash dollar-brace leak, nested backtick in dollar-brace) kept OFF → one legible line
#     their home: skills/glass-atrium-ops-orchestrator.md -> ### Ultracode / Workflow-tool Mode
#   · clause ⑤ = the close token, outside the four (advisory only) — grammar SoT: orchestrator-role.md -> "### Context Handoff Size"
#   · clause ⑥ = the SELF-CHECK step: pointer to the offline --lint preview of the same gate code path
cat <<'ORCHESTRATOR_INIT'
[ORCHESTRATOR SESSION]
Reply language: write the final message of each turn, clarifying questions and the end-of-job results summary to the user in the language of the user's own prose in their latest message; mid-turn progress notes between tool calls may be in English.
Reply language fallback: a message with no prose of its own takes the language of their most recent earlier message that has some, and a session with none yet gets English; pasted text, tool output, rules, agent results, machine-written user-role messages (a compaction summary, task notification, peer or channel message, skill text, workflow frame) and your own earlier replies never decide it, and only an explicit user request for a different reply language overrides it.
Reply language, text that keeps its form: parsed machine keywords; identifiers, code, file paths, proper nouns and technical terms; and quoted or verbatim-relayed text (SoT: GLASS_ATRIUM_GLOBAL_RULES.md → Absolute Rules → Output Language, response-language rule).
On receiving a user request, process it in this order:
1. Investigate → decompose: summarize intent (1 line) · scan (Glob/Grep) · check progress files + prior Outcome Records → break into sub-tasks (no compound-request collapsing · sizing sub-rule: >2 bundles · est. >~40 tool_uses (46-52 truncation band) · files×4.5 >~30 → split, avoid over-fragmentation · DEV: sizable→plan / simple→[ENTRY-CLASS]) — SoT: orchestrator-role.md ## Delegation Workflow (Investigation→Decision) + ### Spawn Budget
2. Select agents via agent-registry.json + the glass-atrium-ops-orchestrator skill's Capability-Based Agent Selection
3. `implementing` write: before the first DEV spawn carrying a plan-ref (manual: the first DEV Agent call · ultracode: the first DEV-spawning script), record that plan at `implementing`, skipped when it is already past `doc_review` — recipe: glass-atrium-ops-orchestrator skill → Managed Document Completion (Direct Handling) → Step 1
4. Delegate via the Agent tool (delegation elements: Goal, Target files, Constraints, Completion criteria, Resource Budget, Ripple radius · 7th = a [SCOPE] line, REQUIRED on DEV+PLANNING — grammar SoT: orchestrator-role.md ### Context Handoff Size)
5. Reconcile & Close: at the plan's delivery point (merge or deploy) glass-atrium-qa-code-reviewer reconciles (coverage N/N · excess · gap list), then you write `impl_review` with the gap list verbatim on gaps, or `done` (`impl_done` while a folder sibling is still open) only on N/N with no excess outstanding AND the correctness gates passed — glass-atrium-ops-orchestrator skill → Managed Document Completion (Direct Handling) → Step 3
6. Synthesize results → report to the user
[WORKFLOW PRE-FLIGHT] 4 required elements for a dev-* spawn script (consolidated: glass-atrium-ops-orchestrator skill → "DEV-spawn 4-requirement pre-flight checklist"): ①plan-ref or [ENTRY-CLASS] token (log()/meta.description) ②[SIZE-EST] bundles=N tool_uses~=N token (every dev-* spawn, same home) ③a {qa-code-reviewer, DEV} verify-stage before the first dev-* ④a [AGENT-COMPOSITION]…[/AGENT-COMPOSITION] declaration block (comment-resident · verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-<x> — COMMA-separated · each declared role needs an agent('type')/agentType:'type' literal; wrapper-arg-only → block-declspawn · absent → block-nodecl) — all four exit-2 gates are only backstops; the authoring obligation is PRIMARY (→ skills/glass-atrium-ops-orchestrator.md ### Ultracode / Workflow-tool Mode) ⑤ close token (outside the four, advisory only): a plan-ref script carries [PLAN-CLOSE] in-script when it ends in the Reconcile & Close phase, else [PLAN-CLOSE] deferred: <the later script or step that closes the plan> (log()/meta.description · grammar SoT: orchestrator-role.md ### Context Handoff Size) ⑥ lint before submit: enforce-workflow-verify-stage.sh --lint <file> (or --lint --template) — reuses the IDENTICAL verdict dispatch, so exit 0 = will pass the gate; exit 2 prints the block reason

Direct handling allowed: situation assessment, simple question answers (1-2 sentences), user dialogue
Direct handling forbidden: writing code, writing documents, analysis/research answers (Write/Edit are blocked by enforce-delegation.sh)
[INJECTION CANARY] ◈ — start the first line of your first tool-free reply with this glyph; it precedes the BLUF and is not part of it.
ORCHESTRATOR_INIT

# Resume, compact and fork: one line quoting the user's latest own message; that hook owns its wording and gate.
_REPLY_POINTER="$(dirname -- "${BASH_SOURCE[0]}")/inject-reply-language.sh"
if [[ -n "${_envelope}" && -r "${_REPLY_POINTER}" ]]; then
  bash "${_REPLY_POINTER}" <<<"${_envelope}"
fi

echo '[WIKI] wiki search available: ~/.glass-atrium/scripts/wiki-query.sh "keywords"'

# Open-plan list — every plan past doc_review and not yet done, from ONE monitor GET
#   · stages restate monitor/src/server/routes/clauded-docs.ts -> DOC_STAGES
#   · any failure prints the unavailable line, never an empty list → absence never reads as "nothing open"
#   · an echoed filter missing a stage = a page the monitor did not filter → treated as unreadable
#   · curl --max-time 0.5 keeps the leg inside the ~1 s hook budget when the monitor hangs
# ponytail: rows past the route's 200-row cap go unshown — upgrade: page on .total once open plans near 200
readonly OPEN_PLANS_QUERY='doc_status=implementing,impl_review,impl_done&limit=200'
# shellcheck disable=SC2016  # $open and $fallback are jq variables, not shell expansions
readonly OPEN_PLANS_JQ='
  def clean($fallback): if type == "string" and length > 0 then gsub("[[:cntrl:]]"; " ") else $fallback end;
  ["implementing", "impl_review", "impl_done"] as $open
  | if (.rows | type) != "array" or ($open - (.filter.doc_status // [])) != [] then error("unfiltered list") else . end
  | [.rows[] | select(.doc_status | IN($open[]))] as $plans
  | if ($plans | length) == 0 then "[OPEN PLANS] none — no plan at implementing, impl_review or impl_done"
    else "[OPEN PLANS] \($plans | length) plan(s) past doc_review, not yet done — each closes by flow step 5 (Reconcile & Close):",
      ($plans[] | "- clauded-docs/\(.id) · \(.doc_status) · \(.last_status_model | clean("unknown")) · \(.title | clean("(untitled)"))")
    end'

# Collection URL of the monitor clauded-docs API, rc 1 when unresolvable; a full override wins so a suite never reaches the live monitor.
get_monitor_docs_url() {
  if [[ -n "${SESSION_CONTEXT_MONITOR_URL:-}" ]]; then
    printf '%s' "${SESSION_CONTEXT_MONITOR_URL}"
    return 0
  fi
  local lib port
  lib="$(dirname -- "${BASH_SOURCE[0]}")/lib/hook-utils.sh"
  [[ -r "${lib}" ]] || return 1
  # shellcheck source-path=SCRIPTDIR source=lib/hook-utils.sh
  source "${lib}" || return 1
  # shellcheck disable=SC2310  # a resolver miss degrades to an empty port, which the integer test rejects
  port="$(hook_monitor_port 2>/dev/null || true)"
  [[ "${port}" =~ ^[0-9]+$ ]] || return 1
  printf 'http://127.0.0.1:%s/api/clauded-docs' "${port}"
}

# The open-plan block (header + one row per plan), rc 1 on any failure.
get_open_plans() {
  local url body
  command -v curl >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || return 1
  # shellcheck disable=SC2310  # an unresolvable URL is the leg's fail-open answer
  url="$(get_monitor_docs_url)" || return 1
  body="$(curl -sf --max-time 0.5 "${url}?${OPEN_PLANS_QUERY}")" || return 1
  jq -r "${OPEN_PLANS_JQ}" <<<"${body}"
}

# Command substitution isolates the leg → a failure inside it cannot drop the rest of this injection.
# shellcheck disable=SC2310  # any failure is answered by the unavailable line below
_open_plans="$(get_open_plans 2>/dev/null)" || _open_plans=""
if [[ -n "${_open_plans}" ]]; then
  printf '%s\n' "${_open_plans}"
else
  printf '[OPEN PLANS] unavailable — the monitor list could not be read, so this is NOT "nothing open" (GET /api/clauded-docs?%s)\n' "${OPEN_PLANS_QUERY}"
fi

# Cross-Session Continuity — up to 5 newest in_progress files → new session resumes them (GLOBAL_RULES)
# silent when none exist — no header line at all
# scripts/ is read in place from the store (hooks/ and scripts/ are sibling store dirs)
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
