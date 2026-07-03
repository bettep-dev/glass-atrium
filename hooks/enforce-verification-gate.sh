#!/usr/bin/env bash
# enforce-verification-gate.sh — PreToolUse(Agent) verification-gate hook.
#
# Three distinct surfaces on a DEV subagent spawn:
#   1) reviewer-advisory (STDERR + exit 0) — a plan-referencing DEV spawn with no qa-code-reviewer
#      recorded this session, surfacing the missing Stage-2 gate. ADVISORY-ONLY (complex/simple plan
#      judgment is the orchestrator's) → never blocks.
#   2) size-est-miss BLOCK (channel-a: emit_error stderr JSON + exit 2) — an ORCHESTRATOR-ORIGIN DEV
#      spawn (agent_id absent) carrying NO [SIZE-EST] self-attestation token. The [SIZE-EST] contract
#      applies to EVERY DEV spawn (orchestrator-role.md ### Spawn Budget), so this fires even for a
#      plan-bearing spawn — the former "plan-bearing → zero false-block" guarantee is REVOKED for this
#      [SIZE-EST] dimension. GUARDED by hook_is_subagent: a nested sub-worker origin (agent_id present)
#      does NOT load the token-defining rules → never blocked (directionally fail-safe: misread ⇒
#      skipped block, never a false-block). Runs BEFORE surfaces 1/3 so plan-bearing spawns are checked.
#   3) entry-miss BLOCK (channel-a: emit_error stderr JSON + exit 2) — a DEV spawn with NEITHER a
#      plan-reference NOR an [ENTRY-CLASS] simple-task token (the silent entry-miss). The [ENTRY-CLASS]
#      simple-task token is the escape hatch for legitimate small DEV work. Non-DEV spawns exit 0;
#      plan-bearing / token-bearing spawns clear THIS branch (but still face surface 2 above).
#
# Manual-path only — ultracode/Workflow agent() spawn does not fire PreToolUse(Agent), so that
#   path's equivalent entry-miss block lives in enforce-workflow-verify-stage.sh (orchestrator-role.md).
# Channel: STDERR advisory (exit 0) for surface 1 · channel-a emit_error + exit 2 for surface 2.
# Session state: agent_events has no session_id column + async PG write → no synchronous lookup,
#   so each spawn appends agent_type to a local marker (session-spawns/<key>) read here.
# Ordering: READ-BEFORE-STAMP — reviewer-present snapshot taken BEFORE this spawn appends its own
#   type → sequential reviewer→DEV passes (reviewer's PreToolUse durably committed first), same-batch
#   parallel reviewer+DEV raises (reviewer stamp not yet committed at DEV-read). Avoids a
#   write-after-read inversion where the DEV's own append pollutes its read.
# fail-open: internal error / marker absent / corrupted payload → exit 0, never interferes.

set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — never interfere with spawn.
trap 'printf "[enforce-verification-gate] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

readonly DEFAULT_DATA_DIR="${HOME}/.claude/data"
# Capture the data dir BEFORE sourcing hook-utils.sh — that library assigns HOOK_DATA_DIR
# unconditionally, which would clobber the Bats-sandbox env override read here. (block-doc-routing-leak.sh
# captures its override path before sourcing for the same reason.)
data_dir="${HOOK_DATA_DIR:-${DEFAULT_DATA_DIR}}"
spawn_dir="${data_dir}/session-spawns"

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

# Per-session marker line cap. The marker appends one subagent_type line per spawn with no
# rotation; a marathon session would grow it unboundedly (the SessionStart reaper
# prune-session-spawns.sh only sweeps WHOLE stale files across sessions — it cannot bound
# intra-session growth). Cap chosen >> both downstream consumers' decision thresholds so the
# prune never alters a verdict: the gate's read is presence-only (grep -qx qa-code-reviewer) and
# every reviewer line is retained on prune; advisory-spawn-budget.sh's runaway threshold is ~30
# (≈6x MAX_CHILDREN), far below this cap, so a count clamped at the cap still trips it correctly.
readonly DEFAULT_MARKER_LINE_CAP=500
marker_line_cap="${SESSION_SPAWN_MARKER_CAP:-${DEFAULT_MARKER_LINE_CAP}}"
# Non-integer / zero override → default (fail-safe: a bad cap must never disable the marker).
if [[ ! "${marker_line_cap}" =~ ^[1-9][0-9]*$ ]]; then
  marker_line_cap="${DEFAULT_MARKER_LINE_CAP}"
fi

# DEV-set — core-compliance-matrix.md Scope Legend canonical DEV agents. Space-separated tokens for
# bash 3.2 (no declare -A). AUTO-SYNCED from the scope-dev.md DEV roster by agent_lifecycle (the
# add/delete transaction + `python -m agent_lifecycle sync-gate-roster`) — do NOT hand-edit.
readonly DEV_SET="dev-front dev-react dev-angular dev-gsap dev-android dev-nestjs dev-node dev-python dev-db dev-rag dev-animator dev-shell dev-swift"

# stdin non-interactive → drain once, otherwise fail-open.
input=""
if [[ ! -t 0 ]]; then
  input="$(cat 2>/dev/null)" || input=""
fi
[[ -z "${input}" ]] && exit 0

# Absent jq is a system misconfiguration — fail-open.
if ! command -v jq >/dev/null 2>&1; then
  printf '[enforce-verification-gate] jq not found on PATH; skipping\n' >&2
  exit 0
fi

# In-pipe `|| true` absorbs jq failure on corrupted JSON → ERR trap fires only on genuine errors.
tool_name=""
tool_name="$(printf '%s' "${input}" | jq -r '.tool_name // ""' 2>/dev/null || true)" || tool_name=""
[[ "${tool_name}" != "Agent" ]] && exit 0

# Single jq fan-out — session_id / subagent_type / prompt at once.
gate_sep=$'\x1f'
gate_tsv=""
gate_tsv="$(printf '%s' "${input}" | jq -r --arg sep "${gate_sep}" '[
  (.session_id // ""),
  (.tool_input.subagent_type // ""),
  ((.tool_input.prompt // "") | @base64)
] | join($sep)' 2>/dev/null || true)" || gate_tsv=""
[[ -z "${gate_tsv}" ]] && exit 0

session_id=""
subagent_type=""
prompt_b64=""
{
  IFS=$'\x1f' read -r session_id subagent_type prompt_b64
} <<<"${gate_tsv}"

# session_id absent → marker key impossible → fail-open.
[[ -z "${session_id}" ]] && exit 0

# SECURITY: session_id is external payload → allowlist-transform to a path-safe single segment
# (delete every byte outside [A-Za-z0-9_-]) before path interpolation, blocking path-traversal.
# Empty result → fail-open. (core-security.md Input Validation · LLM01 untrusted input.)
session_key=""
session_key="$(printf '%s' "${session_id}" | tr -cd 'A-Za-z0-9_-')" || session_key=""
[[ -z "${session_key}" ]] && exit 0

# Base64-decode the prompt (safe passage of control chars/newlines).
prompt_full=""
if [[ -n "${prompt_b64}" ]]; then
  prompt_full="$(printf '%s' "${prompt_b64}" | base64 --decode 2>/dev/null)" || prompt_full=""
fi

# DEV-set membership — space-padded exact-token match.
is_dev_agent() {
  local candidate="${1}"
  [[ -z "${candidate}" ]] && return 1
  case " ${DEV_SET} " in
    *" ${candidate} "*) return 0 ;;
    *) return 1 ;;
  esac
}

# Plan-reference — STRUCTURED match only: id ∪ plan-path ∪ id-bearing slug. A bare 'plan'
# substring must NOT trip the gate (FP-storm guard), so
# every alternation requires structure (a path separator, a .html doc shape, or digit-adjacency):
#   1) clauded-docs/<id>      — the API id citation (original, unchanged).
#   2) <name>plan<…>.html     — a plan-named HTML doc file (g7-plan.html, plan-6569-rev.html).
#   3) documents/<…>.html     — any HTML primary under a documents/ directory (monitor-internal root shape).
#   4) plan-<digits> / <digits>-plan — an id-bearing topic-slug; the digit-adjacency is what makes
#      it a structured REFERENCE rather than incidental hyphenated prose (cross-plan, well-planned).
# Keep in sync with enforce-workflow-verify-stage.sh's inline PLAN_REF_RE copy — both raw-scan these
# self-attestation tokens (P0), matching regardless of comment placement.
references_plan() {
  local text="${1}"
  [[ -z "${text}" ]] && return 1
  printf '%s' "${text}" \
    | grep -qE 'clauded-docs/[0-9]+|[A-Za-z0-9_./-]*plan[A-Za-z0-9_-]*\.html|documents/[A-Za-z0-9_./-]+\.html|plan-[0-9]+|[0-9]+-plan' 2>/dev/null
}

# Entry-classification token — the orchestrator's conscious "this DEV task is simple/exempt"
# signal. Anchored bracketed literal (grep -qF, not a bare 'simple' substring) to avoid the
# FP-storm a loose match would cause — mirrors references_plan()'s structured-match discipline.
has_simple_task_token() {
  local text="${1}"
  [[ -z "${text}" ]] && return 1
  printf '%s' "${text}" | grep -qF '[ENTRY-CLASS] simple-task' 2>/dev/null
}

# [SIZE-EST] self-attestation token — the orchestrator's per-delegation packing estimate emitted at
# EVERY DEV spawn (format `[SIZE-EST] bundles=N tool_uses~=N — <reason>`, orchestrator-role.md
# ### Spawn Budget). Anchored bracketed literal (grep -qF, mirrors has_simple_task_token's
# structured-match discipline) — checks PRESENCE only, never the estimate's correctness (same
# existence-only boundary as the [ENTRY-CLASS] entry tokens).
has_size_est_token() {
  local text="${1}"
  [[ -z "${text}" ]] && return 1
  printf '%s' "${text}" | grep -qF '[SIZE-EST]' 2>/dev/null
}

# 1. READ-BEFORE-STAMP — snapshot reviewer-present state from PRIOR invocations BEFORE this spawn
# appends its own type. Sequential reviewer→DEV: reviewer's completed PreToolUse durably commits the
# qa-code-reviewer line → DEV read observes it → pass. Same-batch parallel reviewer+DEV: reviewer
# stamp not guaranteed committed before the DEV read → snapshot absent → raise. Reading first keeps
# the DEV's own append from polluting its own read. (Append is O_APPEND atomic per line.)
marker_path="${spawn_dir}/${session_key}"
reviewer_present=false
if [[ -f "${marker_path}" ]] && grep -qx "qa-code-reviewer" "${marker_path}" 2>/dev/null; then
  reviewer_present=true
fi

# Fail-safe marker prune — bound the per-session marker to marker_line_cap lines. VERDICT-SAFE
# by construction: every `qa-code-reviewer` line is retained (the gate's read is presence-only),
# and the kept count is clamped AT the cap (far above advisory-spawn-budget.sh's ~30 runaway
# threshold), so neither downstream consumer's decision changes. Any error leaves the file as-is
# (the marker stays usable) — a prune must never break the marker it bounds.
prune_marker_file() {
  local path="${1}"
  [[ -f "${path}" && -r "${path}" && -w "${path}" ]] || return 0
  local line_count
  line_count="$(grep -c '' "${path}" 2>/dev/null || true)"
  [[ -z "${line_count}" ]] && line_count=0
  # At or below the cap → no rewrite needed (hot-path no-op for the common case).
  [[ "${line_count}" =~ ^[0-9]+$ ]] || return 0
  ((line_count <= marker_line_cap)) && return 0
  # Over cap: keep ALL reviewer lines (verdict signal) + the most recent non-reviewer lines up to
  # the remaining budget. Reviewer lines come first so a later presence-check still passes; recency
  # on the rest keeps the freshest spawn context. Atomic swap via a sibling temp file.
  local tmp_path
  tmp_path="$(mktemp "${path}.prune.XXXXXX" 2>/dev/null)" || return 0
  local reviewer_lines budget
  reviewer_lines="$(grep -xc 'qa-code-reviewer' "${path}" 2>/dev/null || true)"
  [[ "${reviewer_lines}" =~ ^[0-9]+$ ]] || reviewer_lines=0
  budget=$((marker_line_cap - reviewer_lines))
  ((budget < 0)) && budget=0
  {
    grep -x 'qa-code-reviewer' "${path}" 2>/dev/null || true
    grep -vx 'qa-code-reviewer' "${path}" 2>/dev/null | tail -n "${budget}" || true
  } >"${tmp_path}" 2>/dev/null || {
    rm -f "${tmp_path}" 2>/dev/null || true
    return 0
  }
  mv -f "${tmp_path}" "${path}" 2>/dev/null || rm -f "${tmp_path}" 2>/dev/null || true
}

# 2. Self-stamp (record own spawn) AFTER the snapshot — keeps this spawn discoverable by a
# LATER sequential spawn without retroactively affecting the snapshot just taken above.
if [[ -n "${subagent_type}" ]]; then
  mkdir -p "${spawn_dir}" 2>/dev/null || true
  printf '%s\n' "${subagent_type}" >>"${marker_path}" 2>/dev/null || true
  prune_marker_file "${marker_path}"
fi

# 3. Advisory-fire condition.
# SC2310: is_dev_agent/references_plan are pure predicates — set -e disable under `if !` intended.
# shellcheck disable=SC2310
if ! is_dev_agent "${subagent_type}"; then
  exit 0
fi

# 3a. [SIZE-EST] presence gate — EVERY orchestrator DEV spawn MUST carry a [SIZE-EST] self-attestation
# token (T1 contract, orchestrator-role.md ### Spawn Budget). Placed BEFORE the entry-decision branch
# so a plan-bearing orchestrator spawn is STILL size-checked — revoking the header's former
# plan-bearing zero-false-block guarantee for this dimension. GUARDED by hook_is_subagent (reused
# VERBATIM from hook-utils.sh, as enforce-delegation.sh / advisory-subagent-budget.sh do): block ONLY
# when agent_id is ABSENT (main-session/orchestrator origin, which loads the token-defining rules); a
# nested sub-worker origin (agent_id present) does NOT load those rules → never blocked. Directionally
# fail-safe — a misread ⇒ skipped block, never a false-block — inheriting the fail-open ERR trap above.
# SC2310: hook_is_subagent/has_size_est_token are pure predicates — set -e disable under `if` intended.
# shellcheck disable=SC2310
if ! hook_is_subagent "${input}" && ! has_size_est_token "${prompt_full}"; then
  size_reason="Spawning DEV agent '${subagent_type}' from the orchestrator with NO [SIZE-EST] self-attestation token — every DEV spawn MUST declare its delegation-size estimate (orchestrator-role.md ### Spawn Budget)."
  size_fix="Record [SIZE-EST] bundles=N tool_uses~=N — <1-line reason> in the prompt: bundles = count of {implement, write-tests, run-full-suite, report-consolidation} packed into THIS delegation, tool_uses~=N = your rough pre-spawn estimate. Under-estimating is the DANGEROUS error — round UP on a borderline count."
  emit_error "VGATE-SIZE-001" "block" "${size_reason}" "${size_fix}" \
    "{\"subagent_type\":\"${subagent_type}\",\"reason\":\"size-est-miss\"}"
  exit 2
fi

# Entry-decision branch — three mutually exclusive paths:
#   plan-ref present       → task entered the flow → fall through to the reviewer check (advisory).
#   [ENTRY-CLASS] token    → orchestrator consciously classified it simple → exit 0 silent.
#   NEITHER                → silent entry-miss → channel-a BLOCK (emit_error + exit 2). The token is
#                            the escape hatch; this is the only branch that blocks.
# SC2310: references_plan/has_simple_task_token are pure predicates — set -e disable under `if`
# intended (same posture as is_dev_agent above).
# shellcheck disable=SC2310
if references_plan "${prompt_full}"; then
  # Reviewer durably recorded BEFORE this spawn (sequential reviewer→DEV) → gate satisfied.
  if [[ "${reviewer_present}" == true ]]; then
    exit 0
  fi
  # 4. STDERR reviewer-advisory fire (no stdout JSON · not a block · exit 0).
  reason="Verification-gate advisory: spawning DEV agent '${subagent_type}' on a plan-referencing task, but no qa-code-reviewer recorded in this session. Complex plans require a {qa-code-reviewer, DEV} Plan Direction Verification team before implementation entry (orchestrator-role.md Stage-2 gate). If this is a simple task (typo/import/config) the gate is exempt — ignore this advisory."
  printf '[enforce-verification-gate] %s\n' "${reason}" >&2
  exit 0
fi

# shellcheck disable=SC2310
if has_simple_task_token "${prompt_full}"; then
  exit 0
fi

# 5. Entry-miss BLOCK — no plan-reference AND no [ENTRY-CLASS] simple-task classification (the
# silent entry-miss). This is the ONLY blocking branch: DEV ∧ !references_plan ∧ !has_simple_task_token.
# Every other path (non-DEV, plan-bearing, simple-task-token) already exited 0 above, so zero
# legitimate work is false-blocked here. The [ENTRY-CLASS] simple-task token remains the escape hatch
# (record it in the prompt to pass instantly). Channel-a (emit_error stderr JSON + exit 2) per the
# PreToolUse block surface — mirrors block-doc-routing-leak.sh. The fail-open ERR trap above still
# governs the hook's OWN errors → an internal failure never reaches this block.
entry_reason="Spawning DEV agent '${subagent_type}' with NEITHER a plan-reference NOR an [ENTRY-CLASS] simple-task classification — sizable DEV work MUST enter the Document-Driven Workflow (author a plan first)."
entry_fix="If this task meets the sizable floor (multi-file blast radius — ~3+ COORDINATED target files; 3+ files is a STRONG sizable signal, borderline → SIZABLE / cross-module / >=3 turns / public-contract — see scope-dev.md Sprint Contract Gate -> Sizable-task definition) author a plan and reference it. If genuinely simple, record [ENTRY-CLASS] simple-task: multi-file=no cross-module=no turns<3 contract=no — <1-line> in the prompt to silence this gate. NOTE: this entry token is ONE of TWO required per DEV spawn — you must ALSO carry a [SIZE-EST] bundles=N tool_uses~=N — <1-line> delegation-size token (checked separately by VGATE-SIZE-001)."
emit_error "VGATE-ENTRY-001" "block" "${entry_reason}" "${entry_fix}" \
  "{\"subagent_type\":\"${subagent_type}\",\"reason\":\"entry-miss\"}"
exit 2
