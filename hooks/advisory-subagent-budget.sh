#!/usr/bin/env bash
# advisory-subagent-budget.sh — PreToolUse advisory on a SUBAGENT's own inner tool_use.
#
# Per-agent_id TOOL_USE counter; fires a STDERR advisory at ~70%/~80% of a TOOL_USE budget.
# ADVISORY-FIRST — exits 0 by default. The block path is the no-progress brake (N consecutive
# exact-duplicate call signatures) over TWO independent limits: a one-shot STDERR advisory at
# SUBAGENT_NOPROGRESS_LIMIT and an exit-2 block at the higher SUBAGENT_NOPROGRESS_BLOCK_LIMIT. The block
# is DEFAULT-ARMED; SUBAGENT_NOPROGRESS_DISARM=1 downgrades it to advisory-only. Everything else always
# fails open to exit 0. The two limits are split (not one nested branch) so the advisory can fire on a
# streak that later blocks — the single-limit shape hid the advisory inside the block branch, so once
# armed it never fired.
# WHY: a subagent has no runtime budget meter, so it runs to its maxTurns hard cap, which kills it
# mid-tool-use → no [COMPLETION] → costly orchestrator recovery. The SubagentStart meter states the
# budget at spawn; THIS hook nudges again as the live count climbs, while the agent can still act.
#
# UNIT HONESTY: maxTurns is a TURN cap; this hook counts TOOL_USES — applying "% of maxTurns" to a
# tool_use count is a category error. So the threshold is an explicit TOOL_USE budget anchored to the
# observed 40-52 tool_use truncation band (orchestrator-role.md Delegation-size discipline), NOT any
# maxTurns. The SubagentStart meter speaks in TURNS; this one speaks in TOOL_USES.
#
# PREMISE (validated, not assumed): a PreToolUse hook DOES fire on a subagent's own inner tool call
# and the envelope carries agent_id (confirmed by enforce-delegation.sh + validate-secret-scan.sh).
# The envelope exposes agent_id (opaque) but NOT agent_type and NO sequence index — so this hook
# keeps its OWN per-agent_id counter, incremented once per call (the count IS the sequence).
#
# Channel: STDERR advisory + exit 0 (PreToolUse accepts only approve/block; STDERR is no validation
# surface). Counter store: ~/.glass-atrium/data/agent-tool-budget/<key> — a DISJOINT path, NOT
# session-spawns/ (consumed by advisory-spawn-budget.sh + enforce-verification-gate.sh; appending
# there would corrupt both).
# fail-open on EVERYTHING: missing agent_id, absent jq, un-writable/corrupt counter, internal error →
# exit 0 silently. No block path exists, so worst case is a missing or spurious advisory line.
#
# OVERAGE RECORDING (record-and-continue): beyond the STDERR advisory, writes a durable best-effort
# PG row (core.budget_overages) at each crossing — 100% (count == budget) then every floor(budget/5)
# tool_uses beyond (min 1 step; default 40 → 40,48,56,...). WHY durable: a maxTurns hard-kill fires
# NO SubagentStop, so synthesis yields zero rows for that death mode; the overage row is written
# BEFORE death, the self-improvement loop's only surviving signal. agent_type recovered from the
# agent-<agent_id>.meta.json sidecar (same pattern as block-doc-routing-leak.sh). The write goes
# through _pg-write.py: any DB/driver/jq error NEVER fails the hook. Cost spent only on a crossing.

set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — never interfere with the tool call.
trap 'printf "[subagent-tool-budget-advisory] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# Instant kill switch — non-empty value disables without touching settings.json (the other disable is
# removing the single PreToolUse entry).
[[ -n "${SUBAGENT_TOOL_BUDGET_OFF:-}" ]] && exit 0

# Counter-store dir override — captured BEFORE sourcing hook-utils.sh (which assigns HOOK_DATA_DIR
# and would clobber a caller env value). Dedicated var name sidesteps the collision.
readonly DEFAULT_BUDGET_DIR="${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data/agent-tool-budget"
budget_dir="${SUBAGENT_TOOL_BUDGET_DIR:-${DEFAULT_BUDGET_DIR}}"

# Overage-writer override — a PATH-shimmable stub replaces _pg-write.py in Bats (count invocations
# without a live DB). Default = sibling _pg-write.py, invoked directly so the stub can be any executable.
readonly DEFAULT_OVERAGE_WRITER="${BASH_SOURCE%/*}/_pg-write.py"
overage_writer="${SUBAGENT_OVERAGE_WRITER:-${DEFAULT_OVERAGE_WRITER}}"

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

# recover_agent_type — resolve agent_type from the agent-<agent_id>.meta.json sidecar (same pattern as
# block-doc-routing-leak.sh). Echoes agentType on success, empty on ANY failure (null fallback,
# accepted). Args: $1=transcript_path $2=session_id $3=agent_key.
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

  # (2) bounded glob keyed by session_id + agent_id (cwd-independent), two layouts (flat subagents/ +
  #     workflow-nested). agent_key is path-safe; the session_id glob segment is wildcard-bounded,
  #     never interpolated raw into a traversal-capable position.
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

# record_overage — best-effort durable overage row via _pg-write.py into core.budget_overages. Builds
# the JSON row with python3 (json.dumps escapes the opaque agent_id), pipes it to the writer. EVERY
# failure path is swallowed — a DB/driver/writer error never fails the hook.
# Args: $1=agent_id $2=agent_type $3=tool_use_count $4=budget $5=crossed_pct.
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

# compute_signature — stable sha256 of the call signature (tool_name + canonical tool_input JSON). Two
# consecutive IDENTICAL signatures = the same operation re-issued with the same inputs, which produces no
# new state (zero forward delta); a signature CHANGE means the loop varied and made progress. json.dumps
# is sort_keys+compact so key-order jitter never perturbs the hash. Echoes the hex digest, or EMPTY on ANY
# failure (absent python3 / malformed input / non-object root) → the caller then skips the brake (fail-open).
# Args: $1=json_input.
compute_signature() {
  printf '%s\n' "${1}" | python3 -c '
import sys, json, hashlib
try:
    d = json.load(sys.stdin)
    if not isinstance(d, dict):
        raise ValueError
except Exception:
    sys.exit(0)
tool = str(d.get("tool_name", ""))
ti = d.get("tool_input", {})
try:
    canon = json.dumps(ti, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
except Exception:
    canon = repr(ti)
print(hashlib.sha256((tool + "\x00" + canon).encode("utf-8", "replace")).hexdigest())
' 2>/dev/null || true
}

# TUNE: TOOL_USE budget — anchored to the 40-52 tool_use truncation band (orchestrator-role.md HARD
# SECONDARY trigger). 40 = the band's lower edge, so the 80% advisory lands at 32, before the danger
# zone. Env-overridable.
readonly DEFAULT_TOOL_BUDGET=40
tool_budget="${SUBAGENT_TOOL_BUDGET:-${DEFAULT_TOOL_BUDGET}}"
# Non-integer override → default (silent; must not affect the tool call). Force base-10 in the
# zero-check: a leading-zero budget (08/09) is a valid [0-9]+ string but bare ((08 == 0)) re-reads it
# as OCTAL ("value too great for base"). The =~ guard runs first, so tool_budget is a confirmed digit
# string before 10#.
if [[ ! "${tool_budget}" =~ ^[0-9]+$ ]] || ((10#${tool_budget} == 0)); then
  tool_budget="${DEFAULT_TOOL_BUDGET}"
fi

# TUNE: no-progress brake — two INDEPENDENT limits over the streak of consecutive exact-duplicate call
# signatures (same tool_name + tool_input = a stuck loop with zero forward delta, identical op → no new
# state). The advisory limit fires a one-shot warning; the higher block limit exits 2. 6 leaves room for
# a legitimate short retry burst before the advisory. Both use the same octal-safe validation as the
# tool_budget (digit-string guard, then 10#-forced zero-check), and are normalized to a base-10 int so
# every downstream (( )) is octal-safe (a leading-zero override like 08 is read as decimal, never octal).
readonly DEFAULT_NOPROGRESS_LIMIT=6
noprogress_limit="${SUBAGENT_NOPROGRESS_LIMIT:-${DEFAULT_NOPROGRESS_LIMIT}}"
if [[ ! "${noprogress_limit}" =~ ^[0-9]+$ ]] || ((10#${noprogress_limit} == 0)); then
  noprogress_limit="${DEFAULT_NOPROGRESS_LIMIT}"
fi
noprogress_limit=$((10#${noprogress_limit}))

readonly DEFAULT_NOPROGRESS_BLOCK_LIMIT=10
noprogress_block_limit="${SUBAGENT_NOPROGRESS_BLOCK_LIMIT:-${DEFAULT_NOPROGRESS_BLOCK_LIMIT}}"
if [[ ! "${noprogress_block_limit}" =~ ^[0-9]+$ ]] || ((10#${noprogress_block_limit} == 0)); then
  noprogress_block_limit="${DEFAULT_NOPROGRESS_BLOCK_LIMIT}"
fi
noprogress_block_limit=$((10#${noprogress_block_limit}))

# Clamp block-limit >= advisory-limit — a lower block limit fires BEFORE the advisory, inverting them.
# The live install raises the advisory limit (to 100) without a block override, so an un-clamped lower
# default would silently invert the ordering there.
if ((noprogress_block_limit < noprogress_limit)); then
  noprogress_block_limit="${noprogress_limit}"
fi

# Block is DEFAULT-ARMED. SUBAGENT_NOPROGRESS_DISARM=1 disarms it (advisory-only, exit 0 at any depth) —
# a NEW flag with an un-inverted meaning. The OLD arming flag SUBAGENT_NOPROGRESS_BLOCK is now IGNORED:
# repurposing it as a disarm would invert its meaning for anyone who had set it to arm. Staging: an
# operator sets SUBAGENT_NOPROGRESS_DISARM=1 while observing the sibling reviewer-miss block in an
# earlier release, then clears it to arm this brake in a later release.
noprogress_disarmed=0
[[ "${SUBAGENT_NOPROGRESS_DISARM:-}" == "1" ]] && noprogress_disarmed=1

# 1. Read input. This hook has matcher "" (all tools) — every inner tool_use is one count.
input="$(hook_read_input)"
[[ "${input}" == "{}" ]] && exit 0

# 2. agent_id gate — the counter key AND the subagent-context signal. Absent = main-session tool call
#    (no maxTurns budget → not this hook's concern).
agent_id="$(hook_get_field "${input}" "agent_id")"
[[ -z "${agent_id}" ]] && exit 0

# 3. SECURITY (LLM01): agent_id is external payload → allowlist-transform to a path-safe single
#    segment (delete every byte outside [A-Za-z0-9_-]) before path interpolation, blocking traversal.
#    Empty result → fail-open.
agent_key="$(hook_path_safe_key "${agent_id}")"
[[ -z "${agent_key}" ]] && exit 0

counter_file="${budget_dir}/${agent_key}"

# Advisory thresholds — 70%/80% of the TOOL_USE budget (integer-floor; already a positive integer).
# TOOL_USE thresholds, NOT maxTurns %. Computed AFTER the agent_id gate (pre-gate calls skip the math).
# Layer 2: init the arithmetic targets to a safe default BEFORE the math, so no edge leaves them
# unbound under set -u (which exits 1, breaking fail-open). Layer 1: force base-10 — a leading-zero
# budget (08) is a valid [0-9]+ string but bare $(( 08 )) re-reads as OCTAL → error → unbound → exit 1.
warn_threshold=0
crit_threshold=0
warn_threshold=$((10#${tool_budget} * 7 / 10))
crit_threshold=$((10#${tool_budget} * 8 / 10))

# 4. Increment the per-agent counter (once per tool call). fail-open: un-creatable dir / un-writable
#    file → exit 0. A corrupt/non-integer existing value resets to this call's count, never crashes.
[[ -d "${budget_dir}" ]] || mkdir -p "${budget_dir}" 2>/dev/null || exit 0

prior_count=0
if [[ -f "${counter_file}" && -r "${counter_file}" ]]; then
  # Strip to digits — a corrupt/racing/non-integer file degrades to 0, never an arithmetic error.
  prior_count="$(tr -cd '0-9' <"${counter_file}" 2>/dev/null || true)"
  # Empty (no digits) → 0; the documented corrupt-counter degrade target.
  [[ -z "${prior_count}" ]] && prior_count=0
fi

# Layers 1+2 (same octal-safety as above): default-init before the math (no set -u unbound → exit 1),
# and force base-10 — a leading-zero counter (08/007) is a valid [0-9]+ string but bare $(( 08 + 1 ))
# re-reads as OCTAL → error → exit 1. 10# also fixes the silent MIS-count of 007/012, not just the crash.
new_count=0
new_count=$((10#${prior_count} + 1))
# Persist the incremented count; write failure → fail-open (advisory may misfire next call, never blocks).
printf '%s\n' "${new_count}" >"${counter_file}" 2>/dev/null || exit 0

# 5. No-progress mechanical brake. Track the per-agent streak of exact-duplicate call signatures in a
#    DISJOINT sibling state file (.sig, TTL-swept with the counter). A repeated identical signature is
#    zero forward delta; a varied signature resets the streak (a legitimate loop is unaffected). At the
#    hard limit → BLOCK (exit 2) when the burn-in flag is armed, else a one-shot STDERR advisory.
#    AD-4 deviation: plan specified "signature + zero-file-delta", but signature-only ships — the exact-duplicate call-signature sha256 is the tractable PreToolUse-only proxy; true zero-file-delta needs PostToolUse file-diff state not available in this hook's event.
#    Precedent note: the ag2/AutoGen max_consecutive_auto_reply citation is goal-level only — that API is absent from ag2 1.0.0b0 (it lived in legacy AutoGen 0.x), so this streak brake is Atrium-designed, not a 1:1 port.
signature="$(compute_signature "${input}")"
if [[ -n "${signature}" ]]; then
  sig_file="${counter_file}.sig"
  prior_signature=""
  prior_repeat=0
  if [[ -f "${sig_file}" && -r "${sig_file}" ]]; then
    # Two-line state: signature on line 1, streak count on line 2. A partial/corrupt read degrades to a
    # fresh streak, never an arithmetic error (same fail-open posture as the counter).
    {
      IFS= read -r prior_signature
      IFS= read -r prior_repeat
    } <"${sig_file}" 2>/dev/null || true
    prior_signature="$(printf '%s' "${prior_signature}" | tr -cd 'a-f0-9')"
    [[ "${prior_repeat}" =~ ^[0-9]+$ ]] || prior_repeat=0
  fi

  repeat=1
  if [[ -n "${prior_signature}" && "${signature}" == "${prior_signature}" ]]; then
    repeat=$((10#${prior_repeat} + 1))
  fi
  # Persist the streak; write failure → fail-open (the brake may misfire next call, never crashes).
  printf '%s\n%s\n' "${signature}" "${repeat}" >"${sig_file}" 2>/dev/null || true

  # Two INDEPENDENT branches over the same streak. BLOCK first (armed + streak at the block limit) so a
  # streak that climbed past both limits blocks rather than re-advising. Otherwise a one-shot advisory
  # fires at EXACTLY the advisory limit (== not >=) so a continuing loop does not spam every call — this
  # fires whether or not the block is armed, since block_limit >= advisory_limit (clamped) leaves a window
  # between them (or, when they coincide, the block branch takes the crossing).
  if ((noprogress_disarmed == 0 && repeat >= noprogress_block_limit)); then
    emit_error "NOPROGRESS-001" "block" \
      "No-progress loop blocked: ${repeat} consecutive identical tool calls (same tool + input) with zero forward delta" \
      "Vary the approach or emit a terminal [COMPLETION] (result: needs_context); set SUBAGENT_NOPROGRESS_DISARM=1 to downgrade to advisory-only" \
      "{\"consecutive_identical_calls\":${repeat},\"limit\":${noprogress_block_limit}}"
    exit 2
  elif ((repeat == noprogress_limit)); then
    printf '[subagent-tool-budget-advisory] %s\n' \
      "NO-PROGRESS advisory: ${repeat} consecutive identical tool calls (same tool + input) — a stuck loop with zero forward delta. Vary the approach or emit a terminal [COMPLETION] (result: needs_context). Non-blocking (advisory only; the separate SUBAGENT_NOPROGRESS_BLOCK_LIMIT gates exit 2)." >&2
  fi
fi

# 6. Threshold comparison. Fire ONCE at each crossing (equality test → not repeated every call).
if ((new_count == crit_threshold)); then
  printf '[subagent-tool-budget-advisory] %s\n' \
    "TOOL_USE budget advisory: this subagent has made ${new_count} tool calls, crossing 80% of the ${tool_budget}-tool_use budget (anchored to the observed 40-52 tool_use truncation band, orchestrator-role.md). NOTE: this is a TOOL_USE count, NOT a maxTurns/% — distinct units. Consider checkpointing to memory/progress-{task}.md and emitting a terminal [COMPLETION] (result: needs_context) with a resume point before truncation. Non-blocking — the tool call proceeds." >&2
elif ((new_count == warn_threshold)); then
  printf '[subagent-tool-budget-advisory] %s\n' \
    "TOOL_USE budget advisory: this subagent has made ${new_count} tool calls, crossing 70% of the ${tool_budget}-tool_use budget. NOTE: TOOL_USE count, NOT maxTurns/%. Plan to wrap up: finish the current work-unit, checkpoint remaining work to memory/progress-{task}.md. Non-blocking — the tool call proceeds." >&2
fi

# 7. Overage recording (durable signal). Fires ONLY on a crossing, so sidecar recovery + PG write cost
#    is spent at most once per crossing. Crossings: 100% (new_count == budget) then every
#    floor(budget/5) beyond (min 1 step; default 40 → 40,48,56,...). Base-10 forced (10#) as above.
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
  # Single-pass extraction of both (one python3, not two) — kept inside the crossing branch so the
  # common no-crossing path still pays zero interpreter cold-starts for them.
  {
    IFS= read -r -d '' transcript_path
    IFS= read -r -d '' session_id
  } \
    < <(hook_get_fields "${input}" transcript_path session_id || true)
  agent_type="$(recover_agent_type "${transcript_path}" "${session_id}" "${agent_key}")"
  record_overage "${agent_id}" "${agent_type}" "${new_count}" "${budget_n}" "${crossed_pct}"
fi

exit 0
