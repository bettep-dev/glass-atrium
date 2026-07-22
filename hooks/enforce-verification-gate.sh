#!/usr/bin/env bash
# enforce-verification-gate.sh — PreToolUse(Agent) verification-gate hook.
#
# Three distinct surfaces on a DEV subagent spawn:
#   1) reviewer-miss BLOCK (channel-a: emit_error stderr JSON + exit 2, code VGATE-REVIEWER-001) — a
#      plan-referencing DEV spawn with no qa-code-reviewer recorded this session, surfacing the missing
#      Stage-2 gate. Promoted from a stderr-advisory to a block so it matches its sibling attestation
#      checks (VGATE-ENTRY-001 / VGATE-SIZE-001). GUARDED by hook_is_subagent like surface 2: only an
#      orchestrator-origin spawn (agent_id absent) composes the Stage-2 {qa-code-reviewer, DEV} team, so
#      it blocks there; a NESTED sub-worker origin (agent_id present) keeps only the informational
#      stderr advisory (exit 0) and is never false-blocked (see the nested-spawn scope note below).
#   2) size-est-miss BLOCK (channel-a: emit_error stderr JSON + exit 2) — an ORCHESTRATOR-ORIGIN DEV
#      spawn (agent_id absent) carrying NO [SIZE-EST] token. That contract applies to EVERY DEV spawn
#      (orchestrator-role.md ### Spawn Budget), so it fires even for a plan-bearing spawn. GUARDED by
#      hook_is_subagent: a nested sub-worker origin (agent_id present) does NOT load the token-defining
#      rules → never blocked (directionally fail-safe: misread ⇒ skipped block, never a false-block).
#      Runs BEFORE surfaces 1/3 so plan-bearing spawns are checked.
#   3) entry-miss BLOCK (channel-a: emit_error stderr JSON + exit 2) — a DEV spawn with NEITHER a
#      plan-reference NOR an [ENTRY-CLASS] simple-task token (the silent entry-miss); that token is the
#      escape hatch for legitimate small DEV work. Non-DEV spawns exit 0; plan/token-bearing spawns
#      clear THIS branch (but still face surface 2).
#
# Nested-spawn scope (T6): the former spawn-depth predicate is dropped, not deferred — the inner
#   envelope exposes only an opaque agent id with no parent linkage, so such a check would land as a
#   no-op. NESTED spawns therefore remain UNGATED (recorded here, not masked): both the reviewer-miss
#   and [SIZE-EST] blocks fire on orchestrator origin only (the hook_is_subagent guard), so a nested
#   sub-worker origin is never false-blocked.
#
# Manual-path only — ultracode/Workflow agent() spawn does not fire PreToolUse(Agent), so that
#   path's equivalent entry-miss block lives in enforce-workflow-verify-stage.sh (orchestrator-role.md).
# Session state: agent_events has no session_id column + async PG write → no synchronous lookup, so
#   an EXECUTED spawn appends its agent_type to a local marker (session-spawns/<key>), read here.
# Dual-event (DF-5): registered on BOTH PreToolUse(Agent) AND PostToolUse(Agent).
#   - PreToolUse: READ the reviewer-present snapshot + run all verdict/advisory logic. NEVER stamps.
#   - PostToolUse: STAMP the marker (the spawn actually executed) + prune. No verdict logic.
#   A spawn blocked at PreToolUse (this gate's exit 2, or a sibling hook) reaches no PostToolUse, so
#   it leaves NO stamp — no false reviewer-present, no inflated spawn-budget counter. Sequential
#   reviewer→DEV still passes: the reviewer's PostToolUse commits its qa-code-reviewer line before the
#   later DEV spawn's PreToolUse read. Same-batch parallel reviewer+DEV raises the advisory (reviewer
#   not yet completed at the DEV read) — correct, parallel is the wrong pattern.
# fail-open: internal error / marker absent / corrupted payload → exit 0, never interferes.

set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — never interfere with spawn.
trap 'printf "[enforce-verification-gate] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

readonly DEFAULT_DATA_DIR="${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data"
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
# (a lifetime-cumulative runaway anchor), far below this cap, so a count clamped at the cap still trips it correctly.
readonly DEFAULT_MARKER_LINE_CAP=500
marker_line_cap="${SESSION_SPAWN_MARKER_CAP:-${DEFAULT_MARKER_LINE_CAP}}"
# Non-integer / zero override → default (fail-safe: a bad cap must never disable the marker).
if [[ ! "${marker_line_cap}" =~ ^[1-9][0-9]*$ ]]; then
  marker_line_cap="${DEFAULT_MARKER_LINE_CAP}"
fi

# DEV-set — core-compliance-matrix.md Scope Legend canonical DEV agents. Space-separated tokens for
# bash 3.2 (no declare -A). AUTO-SYNCED from the scope-dev.md DEV roster by agent_lifecycle (the
# add/delete transaction + `python -m agent_lifecycle sync-gate-roster`) — do NOT hand-edit.
readonly DEV_SET="glass-atrium-dev-front glass-atrium-dev-react glass-atrium-dev-angular glass-atrium-dev-gsap glass-atrium-dev-android glass-atrium-dev-nestjs glass-atrium-dev-node glass-atrium-dev-python glass-atrium-dev-db glass-atrium-dev-rag glass-atrium-dev-animator glass-atrium-dev-shell glass-atrium-dev-swift"

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

# Single jq fan-out — hook_event / session_id / subagent_type / prompt at once.
gate_sep=$'\x1f'
gate_tsv=""
gate_tsv="$(printf '%s' "${input}" | jq -r --arg sep "${gate_sep}" '[
  (.hook_event_name // ""),
  (.session_id // ""),
  (.tool_input.subagent_type // ""),
  ((.tool_input.prompt // "") | @base64)
] | join($sep)' 2>/dev/null || true)" || gate_tsv=""
[[ -z "${gate_tsv}" ]] && exit 0

hook_event=""
session_id=""
subagent_type=""
prompt_b64=""
{
  IFS=$'\x1f' read -r hook_event session_id subagent_type prompt_b64
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
#      WORD-ANCHORED: the slug alternations are bounded by (^|[^A-Za-z0-9_]) … ([^A-Za-z0-9]|$) so an
#      incidental token that merely CONTAINS the slug (workplan-2026) does NOT silently convert an
#      entry-miss BLOCK into a pass, while a real reference (plan-6569, docs/plan-42, 2026-plan) matches.
# Keep in sync with enforce-workflow-verify-stage.sh's inline PLAN_REF_RE copy — both raw-scan these
# self-attestation tokens (P0), matching regardless of comment placement (the anchors are mirrored).
references_plan() {
  local text="${1}"
  [[ -z "${text}" ]] && return 1
  printf '%s' "${text}" \
    | grep -qE 'clauded-docs/[0-9]+|[A-Za-z0-9_./-]*plan[A-Za-z0-9_-]*\.html|documents/[A-Za-z0-9_./-]+\.html|(^|[^A-Za-z0-9_])plan-[0-9]+([^A-Za-z0-9]|$)|(^|[^A-Za-z0-9_])[0-9]+-plan([^A-Za-z0-9]|$)' 2>/dev/null
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

# 1. READ reviewer-present snapshot from PRIOR EXECUTED spawns (PostToolUse stamps only — DF-5).
# Sequential reviewer→DEV: the reviewer's PostToolUse durably commits the qa-code-reviewer line when
# it completes → this DEV spawn's PreToolUse read observes it → pass. Same-batch parallel reviewer+DEV:
# the reviewer has not completed at the DEV read → snapshot absent → raise. This PreToolUse read is
# used only by the verdict logic below; the marker is never written on PreToolUse. (Append is
# O_APPEND atomic per line.)
marker_path="${spawn_dir}/${session_key}"
reviewer_present=false
if [[ -f "${marker_path}" ]] && grep -qx "glass-atrium-qa-code-reviewer" "${marker_path}" 2>/dev/null; then
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
  reviewer_lines="$(grep -xc 'glass-atrium-qa-code-reviewer' "${path}" 2>/dev/null || true)"
  [[ "${reviewer_lines}" =~ ^[0-9]+$ ]] || reviewer_lines=0
  budget=$((marker_line_cap - reviewer_lines))
  ((budget < 0)) && budget=0
  {
    grep -x 'glass-atrium-qa-code-reviewer' "${path}" 2>/dev/null || true
    grep -vx 'glass-atrium-qa-code-reviewer' "${path}" 2>/dev/null | tail -n "${budget}" || true
  } >"${tmp_path}" 2>/dev/null || {
    rm -f "${tmp_path}" 2>/dev/null || true
    return 0
  }
  mv -f "${tmp_path}" "${path}" 2>/dev/null || rm -f "${tmp_path}" 2>/dev/null || true
}

# 2. Spawn-SUCCESS stamp — PostToolUse ONLY (DF-5). PreToolUse fires BEFORE the spawn runs, so
# stamping there records a mere ATTEMPT: a spawn later blocked (by THIS gate's exit 2, or by a
# sibling PreToolUse hook) never executes yet still leaves a marker line — falsely satisfying a
# later DEV spawn's reviewer-presence check AND inflating advisory-spawn-budget.sh's counter with
# never-executed spawns. PostToolUse fires only after the Agent actually executed, so it is the
# reliable spawn-success signal: a blocked spawn reaches no PostToolUse → leaves NO stamp. The
# PreToolUse path reads the reviewer-present snapshot above but MUST NOT stamp. An empty/unknown
# hook_event (legacy payloads without hook_event_name) defaults to the read-only PreToolUse path —
# fail-safe: never stamp on ambiguity.
if [[ "${hook_event}" == "PostToolUse" ]]; then
  if [[ -n "${subagent_type}" ]]; then
    # T12 manifest site (cross-hook/cross-session state persistence): this marker line is the ONLY
    # record of the spawn-success, read by a LATER session's reviewer-presence gate (line ~179) AND by
    # advisory-spawn-budget.sh (a DIFFERENT hook). A swallowed append silently loses that signal → both
    # consumers read stale state. A genuine write failure now emits a named code; exit stays 0 and the
    # success path is unchanged (mkdir failure is folded in — it makes the append fail too).
    if { mkdir -p "${spawn_dir}" 2>/dev/null && printf '%s\n' "${subagent_type}" >>"${marker_path}" 2>/dev/null; }; then
      prune_marker_file "${marker_path}"
    else
      emit_error "VGATE-STAMP-001" "warn" \
        "session-spawns marker append failed — spawn-success signal not persisted; cross-hook reviewer-presence + spawn-count consumers see stale state" \
        "Check permissions/free space on ${spawn_dir}" \
        "{\"marker\":\"${session_key}\"}"
    fi
  fi
  exit 0
fi

# 3. Advisory-fire condition.
# SC2310: is_dev_agent/references_plan are pure predicates — set -e disable under `if !` intended.
# shellcheck disable=SC2310
if ! is_dev_agent "${subagent_type}"; then
  exit 0
fi

# Spawn ORIGIN, computed ONCE over the immutable ${input} and reused by both the [SIZE-EST] gate (3a)
# and the reviewer-miss gate (4). hook_is_subagent spawns a python3 read, so a single evaluation drops
# a redundant interpreter cold-start on this PreToolUse hot path. orchestrator_origin=true ⇔ agent_id
# ABSENT (main-session/orchestrator spawn, which loads the token-defining rules); a nested sub-worker
# origin (agent_id present) is never false-blocked. Directionally fail-safe — a misread ⇒ skipped
# block, never a false-block — inheriting the fail-open ERR trap above.
orchestrator_origin=false
# SC2310: hook_is_subagent is a pure predicate — set -e disable under `if !` intended.
# shellcheck disable=SC2310
if ! hook_is_subagent "${input}"; then
  orchestrator_origin=true
fi

# 3a. [SIZE-EST] presence gate — EVERY orchestrator DEV spawn MUST carry a [SIZE-EST] self-attestation
# token (T1 contract, orchestrator-role.md ### Spawn Budget). Placed BEFORE the entry-decision branch
# so a plan-bearing orchestrator spawn is STILL size-checked — revoking the header's former
# plan-bearing zero-false-block guarantee for this dimension. GUARDED by orchestrator_origin (the cached
# hook_is_subagent, reused VERBATIM from hook-utils.sh as enforce-delegation.sh / advisory-subagent-budget.sh
# do): block ONLY when agent_id is ABSENT (main-session/orchestrator origin, which loads the token-defining
# rules); a nested sub-worker origin (agent_id present) does NOT load those rules → never blocked.
# SC2310: has_size_est_token is a pure predicate — set -e disable under `if` intended.
# shellcheck disable=SC2310
if [[ "${orchestrator_origin}" == true ]] && ! has_size_est_token "${prompt_full}"; then
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
  # 4. Reviewer-miss (T6): a plan-referencing DEV spawn with no qa-code-reviewer recorded is PROMOTED
  # from a stderr-advisory to a channel-a BLOCK (emit_error stderr JSON + exit 2, code
  # VGATE-REVIEWER-001, reason phrase reviewer-miss), matching its sibling attestation checks
  # (VGATE-ENTRY-001 / VGATE-SIZE-001). GUARDED by orchestrator_origin exactly like the [SIZE-EST] gate:
  # only an orchestrator-origin spawn (agent_id absent) composes the Stage-2 {qa-code-reviewer, DEV}
  # verification team, so it blocks there; a NESTED sub-worker origin (agent_id present) keeps only the
  # informational advisory and is never false-blocked (nested spawns remain ungated per the header
  # note). "no qa-code-reviewer recorded" is retained verbatim in both messages so a downstream log
  # scan keys on one phrase across both surfaces.
  reviewer_reason="Verification-gate reviewer-miss: spawning DEV agent '${subagent_type}' on a plan-referencing task, but no qa-code-reviewer recorded in this session. Complex plans require a {qa-code-reviewer, DEV} Plan Direction Verification team before implementation entry (orchestrator-role.md Stage-2 gate)."
  if [[ "${orchestrator_origin}" == true ]]; then
    reviewer_fix="Spawn glass-atrium-qa-code-reviewer FIRST (sequentially, before this DEV spawn) so its PostToolUse stamp records the Stage-2 verdict — the later DEV spawn then passes. If this task is genuinely simple/exempt, record [ENTRY-CLASS] simple-task in the prompt instead of a plan-reference."
    emit_error "VGATE-REVIEWER-001" "block" "${reviewer_reason}" "${reviewer_fix}" \
      "{\"subagent_type\":\"${subagent_type}\",\"reason\":\"reviewer-miss\"}"
    exit 2
  fi
  # Nested sub-worker origin → informational advisory only (never a false-block).
  printf '[enforce-verification-gate] %s\n' "${reviewer_reason}" >&2
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
