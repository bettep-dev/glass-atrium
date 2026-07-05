#!/usr/bin/env bash
# advisory-subagent-budget.sh — PreToolUse advisory firing on a SUBAGENT's own inner tool_use.
#
# Maintains a per-agent_id TOOL_USE counter and prints a STDERR advisory once the count crosses
# ~70% / ~80% of a TOOL_USE budget. ADVISORY ONLY — always exit 0, NEVER blocks (no exit 2 path).
#
# WHY this exists: a subagent has no runtime budget meter, so the documented "stop before the cap"
# rule is dead text — the agent runs to its maxTurns hard cap, which kills it mid-tool-use → no
# [COMPLETION] block → costly orchestrator SendMessage-recovery. The SubagentStart meter
# (inject-scope-rules.sh) states the budget at spawn; THIS hook nudges again as the live count
# climbs, the moment the agent can still act on it.
#
# UNIT HONESTY (qa-reviewer mandatory): maxTurns is a TURN cap; this hook counts TOOL_USES. The two
# are NOT interchangeable — applying "% of maxTurns" to a tool_use count is a category error. So the
# threshold here is an explicit TOOL_USE budget, anchored to the empirically-observed 40-52 tool_use
# truncation band (orchestrator-role.md Delegation-size discipline HARD SECONDARY trigger), NOT to
# any agent's maxTurns. The SubagentStart meter speaks in TURNS (honest there); this one speaks in
# TOOL_USES (honest here). Each names its own unit.
#
# PREMISE (validated against the shipped codebase, NOT assumed): a PreToolUse hook DOES fire on a
# subagent's own inner tool call, and that envelope carries agent_id — confirmed by
# enforce-delegation.sh (PreToolUse(Write|Edit) branching on hook_is_subagent) and
# validate-secret-scan.sh (registered on Bash, scanning inner-subagent Bash calls). The envelope
# exposes agent_id (opaque) but NOT agent_type and NO per-call sequence index — so this hook keeps
# its OWN per-agent_id counter file, incremented once per call (the count IS the sequence).
#
# Channel: STDERR advisory + exit 0 — the PreToolUse schema accepts only approve/block, so a stdout
# "advisory" JSON would be rejected; STDERR creates no validation surface (advisory-spawn-budget.sh
# precedent).
#
# Counter store: ~/.claude/data/agent-tool-budget/<sanitized_key> — a DISJOINT path, NOT
# session-spawns/ (whose line count is consumed by advisory-spawn-budget.sh +
# enforce-verification-gate.sh — appending there would corrupt both).
#
# fail-open on EVERYTHING (qa-reviewer mandatory): missing agent_id, absent jq, un-writable/corrupt
# counter, internal error → exit 0 silently. A hook bug must NEVER block a session; for v1 there is
# no block path at all, so worst case is a missing or spurious advisory line.
#
# OVERAGE RECORDING (record-and-continue): beyond the STDERR advisory, this hook writes a durable
# best-effort PG row (core.budget_overages) at each budget crossing — the 100% crossing (count ==
# budget) then every floor(budget/5) tool_uses beyond (min 1 step). For the default budget 40 the
# crossings are 40, 48, 56, ... (each step = +20%). WHY durable: an engine hard-kill at maxTurns fires
# NO SubagentStop event, so SubagentStop synthesis produces zero outcome rows for that death mode; the
# overage row is written BEFORE death, surviving the kill as the self-improvement loop's only signal.
# agent_type is recovered from the agent-<agent_id>.meta.json sidecar (same recover pattern as
# block-doc-routing-leak.sh, same PreToolUse event) — null fallback is accepted, resolution the norm.
# The write goes through _pg-write.py: a DB outage, absent driver, absent jq, or any error NEVER fails
# the hook (exit 0 preserved). Recovery + write cost is spent ONLY on a crossing, never every tool call.

set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — never interfere with the tool call.
trap 'printf "[subagent-tool-budget-advisory] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# Instant kill switch — set a non-empty value to disable without touching settings.json. The other
# disable property is the single settings.json PreToolUse entry removal.
[[ -n "${SUBAGENT_TOOL_BUDGET_OFF:-}" ]] && exit 0

# Counter-store dir override — captured BEFORE sourcing hook-utils.sh, which unconditionally
# assigns HOOK_DATA_DIR and would clobber a caller's env value (advisory-spawn-budget.sh precedent
# for the pre-source capture). Dedicated var name sidesteps the collision.
readonly DEFAULT_BUDGET_DIR="${HOME}/.claude/data/agent-tool-budget"
budget_dir="${SUBAGENT_TOOL_BUDGET_DIR:-${DEFAULT_BUDGET_DIR}}"

# Overage-writer override — captured for Bats fail-safe testing: a PATH-shimmable stub replaces the
# real _pg-write.py to count invocations without a live DB. Default = sibling _pg-write.py (executable,
# `#!/usr/bin/env python3` shebang), invoked directly so the stub can be any executable.
readonly DEFAULT_OVERAGE_WRITER="${BASH_SOURCE%/*}/_pg-write.py"
overage_writer="${SUBAGENT_OVERAGE_WRITER:-${DEFAULT_OVERAGE_WRITER}}"

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

# recover_agent_type — resolve agent_type from the agent-<agent_id>.meta.json sidecar, ALGORITHMICALLY
# EQUIVALENT to block-doc-routing-leak.sh recover_agent_type (same PreToolUse envelope: transcript_path +
# session_id). Echoes the agentType on success, empty on ANY failure (absent jq, no sidecar, unreadable →
# null fallback, an accepted overage-row value). Args: $1=transcript_path $2=session_id $3=agent_key.
recover_agent_type() {
  local transcript_val="${1}" session_val="${2}" agent_key="${3}"
  # Need agent_key AND at least one resolution anchor.
  [[ -z "${agent_key}" ]] && return 0
  [[ -z "${transcript_val}" && -z "${session_val}" ]] && return 0
  local filename="agent-${agent_key}.meta.json"
  local sidecar recovered

  # (1) sidecar co-located with transcript_path's dirname.
  if [[ -n "${transcript_val}" ]]; then
    sidecar="$(dirname -- "${transcript_val}")/${filename}"
    if [[ -f "${sidecar}" && -r "${sidecar}" ]]; then
      recovered="$(jq -r '.agentType // empty' "${sidecar}" 2>/dev/null || true)"
      if [[ -n "${recovered}" ]]; then
        printf '%s\n' "${recovered}"
        return 0
      fi
    fi
  fi

  # (2) bounded glob keyed by session_id + agent_id (cwd-independent). Two layouts: the flat subagents/
  #     dir + the workflow-nested location used by Dynamic-Workflow agents. agent_key is already
  #     path-safe; the session_id glob segment is wildcard-bounded, never interpolated raw into a
  #     traversal-capable position.
  if [[ -n "${session_val}" ]]; then
    local session_key match
    session_key="$(hook_path_safe_key "${session_val}")"
    if [[ -n "${session_key}" ]]; then
      local -a patterns=(
        "${HOME}/.claude/projects/"*"/${session_key}/subagents/${filename}"
        "${HOME}/.claude/projects/"*"/${session_key}/subagents/workflows/wf_"*"/${filename}"
      )
      local pat
      for pat in "${patterns[@]}"; do
        # Glob expansion; nullglob-equivalent via the -f test inside the loop.
        for match in ${pat}; do
          if [[ -f "${match}" && -r "${match}" ]]; then
            recovered="$(jq -r '.agentType // empty' "${match}" 2>/dev/null || true)"
            if [[ -n "${recovered}" ]]; then
              printf '%s\n' "${recovered}"
              return 0
            fi
          fi
        done
      done
    fi
  fi
  return 0
}

# record_overage — best-effort durable overage row via _pg-write.py into core.budget_overages. Builds the
# JSON row with python3 (agent_type empty → JSON null; json.dumps escapes the opaque agent_id), then pipes
# it to the writer. EVERY failure path is swallowed (`|| true`, `2>/dev/null`) — a DB outage, absent driver,
# or a missing writer never fails the hook. Args: $1=agent_id $2=agent_type $3=tool_use_count $4=budget $5=crossed_pct.
record_overage() {
  local a_id="${1}" a_type="${2}" count="${3}" budget="${4}" pct="${5}" row_json
  row_json="$(AID="${a_id}" ATYPE="${a_type}" CNT="${count}" BUD="${budget}" PCT="${pct}" python3 -c '
import json, os
atype = os.environ.get("ATYPE", "") or None
print(json.dumps({
    "agent_id": os.environ.get("AID", ""),
    "agent_type": atype,
    "tool_use_count": int(os.environ.get("CNT", "0")),
    "budget": int(os.environ.get("BUD", "0")),
    "crossed_pct": int(os.environ.get("PCT", "0")),
}))
' 2>/dev/null || true)"
  [[ -z "${row_json}" ]] && return 0
  printf '%s' "${row_json}" | "${overage_writer}" advisory-subagent-budget core.budget_overages >/dev/null 2>&1 || true
}

# TUNE: TOOL_USE budget — anchored to the 40-52 tool_use truncation band (orchestrator-role.md HARD
# SECONDARY trigger: a single delegation expected to exceed ~40 tool_uses SPLITs regardless of bundle
# count). 40 = the band's lower edge, so the 80% advisory lands at 32 — before the danger zone.
# Env-overridable for recalibration as per-agent tool_use percentiles accumulate.
readonly DEFAULT_TOOL_BUDGET=40
tool_budget="${SUBAGENT_TOOL_BUDGET:-${DEFAULT_TOOL_BUDGET}}"
# Non-integer override → default (silent). Input-validation failure must not affect the tool call.
# Force base-10 in the zero-check: a leading-zero budget (08/09) is a valid [0-9]+ string, but a bare
# ((08 == 0)) re-reads it as OCTAL ("value too great for base"). The =~ guard runs first (|| short-
# circuit), so tool_budget is a confirmed non-empty digit string before 10# — no empty/non-digit edge.
if [[ ! "${tool_budget}" =~ ^[0-9]+$ ]] || ((10#${tool_budget} == 0)); then
  tool_budget="${DEFAULT_TOOL_BUDGET}"
fi

# 1. Read input. This hook has matcher "" (all tools) — every inner tool_use is one count.
input="$(hook_read_input)"
[[ "${input}" == "{}" ]] && exit 0

# 2. agent_id gate — the per-agent counter key AND the subagent-context signal. Absent agent_id =
#    main-session (orchestrator) tool call, which has no maxTurns budget → not this hook's concern.
agent_id="$(hook_get_field "${input}" "agent_id")"
[[ -z "${agent_id}" ]] && exit 0

# 3. SECURITY (LLM01): agent_id is external payload → allowlist-transform to a path-safe single
#    segment (delete every byte outside [A-Za-z0-9_-]) before path interpolation, blocking traversal.
#    Empty result → fail-open. (Same transform advisory-spawn-budget.sh applies to session_id.)
agent_key="$(hook_path_safe_key "${agent_id}")"
[[ -z "${agent_key}" ]] && exit 0

counter_file="${budget_dir}/${agent_key}"

# Advisory thresholds — 70% and 80% of the TOOL_USE budget (native integer-floor math; tool_budget is
# already validated as a positive integer). These are TOOL_USE thresholds, NOT maxTurns %. Computed
# AFTER the agent_id gate so main-session / pre-gate-exit calls never spend the arithmetic.
# Layer 2 (defense-in-depth): initialize the arithmetic targets to a safe default BEFORE the math, so
# no arithmetic edge can ever leave them unbound under set -u (which would exit 1, breaking fail-open).
# Layer 1 (root cause): force base-10 — a leading-zero budget like 08 is a valid [0-9]+ string but a
# bare $(( 08 )) re-interprets it as OCTAL → "value too great for base" → unbound target → exit 1.
warn_threshold=0
crit_threshold=0
warn_threshold=$((10#${tool_budget} * 7 / 10))
crit_threshold=$((10#${tool_budget} * 8 / 10))

# 4. Increment the per-agent counter (count once per tool call — idempotent per call). fail-open:
#    an un-creatable dir or un-writable file → exit 0 (no advisory, no block). A corrupt/non-integer
#    existing value resets to this call's count rather than crashing.
[[ -d "${budget_dir}" ]] || mkdir -p "${budget_dir}" 2>/dev/null || exit 0

prior_count=0
if [[ -f "${counter_file}" && -r "${counter_file}" ]]; then
  # Strip to digits — a corrupt/racing/non-integer file degrades to 0, never an arithmetic error.
  prior_count="$(tr -cd '0-9' <"${counter_file}" 2>/dev/null || true)"
  # Empty (no digits) → 0; the documented corrupt-counter degrade target.
  [[ -z "${prior_count}" ]] && prior_count=0
fi

# Layer 2: default-initialize before the math (set -u cannot read an unbound target → no exit 1).
# Layer 1: force base-10 — a leading-zero counter (08/09/0008) survives the digit-strip above as a
# valid [0-9]+ string, but a bare $(( 08 + 1 )) re-reads it as OCTAL → arithmetic error → unbound
# new_count → exit 1, violating the hook's own fail-open promise on the corrupt-counter path. 10#08
# = 8, 10#007 = 7 — this also fixes the silent octal MIS-count of 007/012, not just the crash.
new_count=0
new_count=$((10#${prior_count} + 1))
# Persist the incremented count; write failure → fail-open (advisory may misfire next call, never blocks).
printf '%s\n' "${new_count}" >"${counter_file}" 2>/dev/null || exit 0

# 5. Threshold comparison. Fire ONCE at the 80% crossing and ONCE at the 70% crossing (the equality
#    test fires on the exact crossing call, so an agent does not get the same advisory every call).
if ((new_count == crit_threshold)); then
  printf '[subagent-tool-budget-advisory] %s\n' \
    "TOOL_USE budget advisory: this subagent has made ${new_count} tool calls, crossing 80% of the ${tool_budget}-tool_use budget (anchored to the observed 40-52 tool_use truncation band, orchestrator-role.md). NOTE: this is a TOOL_USE count, NOT a maxTurns/% — distinct units. Consider checkpointing to memory/progress-{task}.md and emitting a terminal [COMPLETION] (result: needs_context) with a resume point before truncation. Non-blocking — the tool call proceeds." >&2
elif ((new_count == warn_threshold)); then
  printf '[subagent-tool-budget-advisory] %s\n' \
    "TOOL_USE budget advisory: this subagent has made ${new_count} tool calls, crossing 70% of the ${tool_budget}-tool_use budget. NOTE: TOOL_USE count, NOT maxTurns/%. Plan to wrap up: finish the current work-unit, checkpoint remaining work to memory/progress-{task}.md. Non-blocking — the tool call proceeds." >&2
fi

# 6. Overage recording (record-and-continue durable signal). Fires ONLY on a budget crossing so the
#    sidecar recovery + PG write cost is spent at most once per crossing, never on every tool call.
#    Crossings: the 100% crossing (new_count == budget) then every floor(budget/5) tool_uses beyond
#    (min 1 step) — for the default budget 40 that is 40, 48, 56, ... (each step = +20%). Base-10 is
#    forced (10#) for the same octal-safety reason as the threshold math above.
budget_n=$((10#${tool_budget}))
overage_step=$((budget_n / 5))
((overage_step >= 1)) || overage_step=1

is_crossing=0
if ((new_count == budget_n)); then
  is_crossing=1
elif ((new_count > budget_n && (new_count - budget_n) % overage_step == 0)); then
  is_crossing=1
fi

if ((is_crossing == 1)); then
  # crossed_pct: integer percentage at the crossing (100 at budget, +20% per default-budget step).
  crossed_pct=$((new_count * 100 / budget_n))
  # transcript_path + session_id are read lazily HERE — needed only for sidecar recovery on a crossing.
  transcript_path="$(hook_get_field "${input}" "transcript_path")"
  session_id="$(hook_get_field "${input}" "session_id")"
  agent_type="$(recover_agent_type "${transcript_path}" "${session_id}" "${agent_key}")"
  record_overage "${agent_id}" "${agent_type}" "${new_count}" "${budget_n}" "${crossed_pct}"
fi

exit 0
