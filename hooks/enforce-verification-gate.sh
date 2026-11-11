#!/usr/bin/env bash
# enforce-verification-gate.sh — PreToolUse(Agent) verification-gate hook.
#
# Six distinct surfaces on a DEV subagent spawn, every one advisory: the hook exits 0 on every path.
#   1) reviewer-miss WARNING (emit_error stderr JSON, severity warn, code VGATE-REVIEWER-001) — a
#      plan-referencing DEV spawn with no qa-code-reviewer recorded this session, surfacing the missing
#      Stage-2 gate. An orchestrator-origin spawn (agent_id absent) gets the structured warning and a
#      trace line; a NESTED sub-worker origin (agent_id present) gets a plain stderr line only.
#   2) size-est-miss WARNING (emit_error stderr JSON, severity warn, code VGATE-SIZE-001) — an
#      ORCHESTRATOR-ORIGIN DEV spawn (agent_id absent) carrying NO [SIZE-EST] token. That contract applies
#      to every DEV spawn except a simple-task entry (skills/glass-atrium-ops-orchestrator-role.md
#      ### Spawn Budget), so it fires even for a plan-bearing spawn. A nested sub-worker origin does NOT
#      load the token-defining rules → never warned. Runs BEFORE surfaces 1/3.
#   3) entry-miss WARNING (emit_error stderr JSON, severity warn, code VGATE-ENTRY-001) — a DEV spawn with
#      NEITHER a plan-reference NOR an [ENTRY-CLASS] simple-task token (the silent entry-miss). Non-DEV
#      spawns exit 0 silently; plan-bearing spawns clear THIS branch (but still face surface 2).
#   Surfaces 1 and 3 exclude each other (plan-reference or none); surface 2 can join either. No
#      warning ends the hook: every warned spawn still reaches surfaces 4-6.
#   SIMPLE-TASK ENTRY — a spawn carrying [ENTRY-CLASS] simple-task and NO plan-reference exits 0
#      silently before surfaces 2-5: it owes no other attestation token and no reviewer.
#   4) scope-miss ADVISORY (stderr, exit 0 — never a block) — an orchestrator-origin DEV spawn whose
#      prompt carries no bare line-opening [SCOPE] declaration, whatever surfaces 1-3 reported.
#   5) deep-review ADVISORY (stderr, exit 0 — never a block) — a carried [SCOPE] declaration listing
#      DEEP_REVIEW_FILE_THRESHOLD or more paths, or any path under DEEP_REVIEW_SENSITIVE_PREFIXES,
#      nudges the orchestrator to compose a Deep (4-pass) review whatever confidence the writer
#      reports. Counts through the shared scope_decl_files parser; an unparseable declaration is
#      silence, never a guess. The routing decision itself stays orchestrator prose (honor-system).
#   6) implementing ADVISORY (stderr, exit 0 — never a block) — an orchestrator-origin, plan-referencing
#      DEV spawn whose cited plan (authored by glass-atrium-intel-planner) is
#      still at doc_review is nudged to record the `implementing` stage, so the session-start open-plan
#      list carries the plan until it closes. Another author's document is never named — a stage write
#      would pin a reporter's standing tracker to that list for good. The hook's only monitor read;
#      PreToolUse-only (the PostToolUse branch exits first); fails open to silence, verdict unchanged.
#
# Nested-spawn scope: the inner envelope exposes only an opaque agent id with no parent linkage, so a
#   spawn-depth predicate would land as a no-op. NESTED spawns therefore remain ungated: they draw no
#   structured warning (the hook_is_subagent guard), only the reviewer-miss plain line.
#
# FIRING TRACE (durable, observability-only): every surface 1-3 warning appends ONE verdict-tagged line
#   to ${GA_DATA_ROOT:-~/.glass-atrium}/data/verification-gate-fired.log (env override VGATE_FIRED_LOG,
#   line cap VGATE_FIRED_LOG_CAP, default 1000). Verdict tags: block-sizeest · block-reviewer ·
#   block-entry — each names the tripped check; the spawn itself still runs. Read it back with
#   `enforce-verification-gate.sh --block-counts`. NOT an outcome row: the spawn's own run records that.
#   emit_gate_trace runs in a parenthesized subshell with stderr suppressed and `|| true`, so a trace
#   failure can neither replace the warning nor change the exit.
#   PRUNE RACE (accepted): the line-cap prune reads with tail into a temp file then renames, so lines
#   appended between the read and the rename are lost; the sink is never read for a verdict.
#   TRACE ONCE: the trace belongs to the PreToolUse warning paths ONLY — the PostToolUse surface stamps
#   executed spawns, a different record.
#
# Manual-path only — ultracode/Workflow agent() spawn does not fire PreToolUse(Agent), so that
#   path's equivalent entry-miss warning lives in enforce-workflow-verify-stage.sh (skills/glass-atrium-ops-orchestrator-role.md).
# Session state: agent_events has no session_id column + async PG write → no synchronous lookup, so
#   an EXECUTED spawn appends its agent_type to a local marker (session-spawns/<key>), read here.
# Dual-event (DF-5): registered on BOTH PreToolUse(Agent) AND PostToolUse(Agent).
#   - PreToolUse: READ the reviewer-present snapshot + run all verdict/advisory logic. NEVER stamps.
#   - PostToolUse: STAMP the marker (the spawn actually executed) + prune. No verdict logic.
#   A spawn a sibling PreToolUse hook blocks reaches no PostToolUse, so it leaves NO stamp — no false
#   reviewer-present, no inflated spawn-budget counter. Sequential reviewer→DEV reads clean: the
#   reviewer's PostToolUse commits its qa-code-reviewer line before the later DEV spawn's PreToolUse
#   read. Same-batch parallel reviewer+DEV finds no reviewer line at the DEV read → VGATE-REVIEWER-001
#   warns — correct, parallel is the wrong pattern.
# fail-open: internal error / marker absent / corrupted payload → exit 0, never interferes.

set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — never interfere with spawn.
trap 'printf "[enforce-verification-gate] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

readonly DEFAULT_DATA_DIR="${GA_DATA_ROOT:-${HOME}/.glass-atrium}/data"
# Capture the data dir BEFORE sourcing hook-utils.sh — that library assigns HOOK_DATA_DIR
# unconditionally, which would clobber the Bats-sandbox env override read here.
data_dir="${HOOK_DATA_DIR:-${DEFAULT_DATA_DIR}}"
spawn_dir="${data_dir}/session-spawns"

# Firing-trace sink — direct sibling of enforce-workflow-verify-stage.sh's WORKFLOW_GATE_FIRED_LOG.
# Its own env override exists so a Bats case can isolate the sink per test (an unwritable-sink case
# cannot be written without it); the default resolves under the same data root as the spawn marker.
VGATE_FIRED_LOG="${VGATE_FIRED_LOG:-${data_dir}/verification-gate-fired.log}"

# Firing-trace line cap. One line per warning with no rotation, so a long-lived install would grow the
# sink unboundedly (no SessionStart reaper sweeps it). Observability-only — no line carries decision
# signal — so bounding to the most-recent N lines is verdict-safe by construction.
readonly DEFAULT_TRACE_LINE_CAP=1000
trace_line_cap="${VGATE_FIRED_LOG_CAP:-${DEFAULT_TRACE_LINE_CAP}}"
# Non-integer / zero override → default (fail-safe: a bad cap must never disable trace pruning).
if [[ ! "${trace_line_cap}" =~ ^[1-9][0-9]*$ ]]; then
  trace_line_cap="${DEFAULT_TRACE_LINE_CAP}"
fi

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"

# The `[SCOPE]` declaration selector and parser are shared with validate-scope-drift.sh and
# track-outcome.sh, so surfaces 4 and 5 cannot disagree with them about which line declares what.
# shellcheck source=lib/scope-match.sh
source "${BASH_SOURCE%/*}/lib/scope-match.sh"
if [[ -r "${BASH_SOURCE%/*}/lib/pipe-drain.sh" ]]; then
  # shellcheck source=lib/pipe-drain.sh
  source "${BASH_SOURCE%/*}/lib/pipe-drain.sh"
else
  # Library missing or unreadable → the same drain_after in place, so the hook keeps its verdict.
  # A test, not a failed source: bash 3.2 exits on a missing sourced file even inside a condition.
  drain_after() {
    local rc=0
    "$@" || rc=$?
    cat >/dev/null || true
    return "${rc}"
  }
fi

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
readonly DEV_SET="glass-atrium-dev-front glass-atrium-dev-react glass-atrium-dev-angular glass-atrium-dev-gsap glass-atrium-dev-android glass-atrium-dev-nestjs glass-atrium-dev-node glass-atrium-dev-python glass-atrium-dev-db glass-atrium-dev-rag glass-atrium-dev-animator glass-atrium-dev-shell glass-atrium-dev-swift glass-atrium-dev-aws"

# Deep-review override (surface 5): a declaration listing this many paths, or any path under one of
# these prefixes, outweighs the writer-reported confidence when the review is composed. The prose SoT
# is skills/glass-atrium-ops-orchestrator.md → Quality Gates; these two constants are the code copy
# of the same values, never a second policy.
readonly DEEP_REVIEW_FILE_THRESHOLD=10
readonly DEEP_REVIEW_SENSITIVE_PREFIXES='hooks/ settings*.json rules/ agents/ autoagent/'

# Surface 6: the only author whose doc_review document the nudge may name, and the per-GET ceiling —
# inside the ~1 s hook budget, same value as enforce-workflow-verify-stage.sh's chain walk.
readonly PLANNER_AUTHOR="glass-atrium-intel-planner"
readonly MONITOR_CURL_TIMEOUT_SEC=1

# emit_gate_trace VERDICT SUBAGENT_TYPE — append one firing-trace line, FAIL-SAFE: every failure mode
# (unwritable dir, mkdir refusal, printf error, a fired ERR trap) stays inside the subshell.
# SECURITY: subagent_type is external payload → allowlist-transform before writing it to the sink, so
# an embedded TAB/newline cannot forge a trace line (core-security.md Input Validation).
# `verdict=` is the LAST field so a reader can anchor an exact tag match at end-of-line.
emit_gate_trace() {
  local verdict="${1}" stype="${2:-}"
  (
    local log_dir ts safe_type
    log_dir="$(dirname -- "${VGATE_FIRED_LOG}")"
    mkdir -p -- "${log_dir}" 2>/dev/null || exit 0
    ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || ts="unknown"
    safe_type="$(printf '%s' "${stype}" | tr -cd 'A-Za-z0-9_-' 2>/dev/null || true)"
    printf '%s\ttool_name=%s\tsubagent_type=%s\tverdict=%s\n' \
      "${ts}" "Agent" "${safe_type:-unknown}" "${verdict}" \
      >>"${VGATE_FIRED_LOG}" 2>/dev/null || exit 0
    # Fail-safe prune — most-recent retention, atomic sibling-temp swap. Any error leaves the sink
    # as-is (a prune must never break the log it bounds). Empty-pattern grep -c counts lines without
    # the `|| echo 0` "0\n0" trap.
    local line_count
    line_count="$(grep -c '' "${VGATE_FIRED_LOG}" 2>/dev/null || true)"
    [[ -z "${line_count}" ]] && line_count=0
    [[ "${line_count}" =~ ^[0-9]+$ ]] || exit 0
    ((line_count <= trace_line_cap)) && exit 0
    local tmp_path
    tmp_path="$(mktemp "${VGATE_FIRED_LOG}.prune.XXXXXX" 2>/dev/null)" || exit 0
    if tail -n "${trace_line_cap}" "${VGATE_FIRED_LOG}" >"${tmp_path}" 2>/dev/null \
      && mv -f "${tmp_path}" "${VGATE_FIRED_LOG}" 2>/dev/null; then
      exit 0
    fi
    # shellcheck disable=SC2310  # pure predicate — nothing inside it for errexit to catch
    if ga_guard_path "${tmp_path}"; then rm -f -- "${tmp_path:?}"; fi
  ) 2>/dev/null || true
}

# warn_tripped_check CODE REASON FIX CONTEXT_JSON TRACE_TAG — the shared warning of surfaces 1-3
# (VGATE-SIZE-001 / VGATE-REVIEWER-001 / VGATE-ENTRY-001): structured warning + one trace line; returns.
warn_tripped_check() {
  local code="${1}" reason="${2}" fix="${3}" ctx="${4}" trace_tag="${5}"
  emit_error "${code}" "warn" "${reason}" "${fix}" "${ctx}"
  emit_gate_trace "${trace_tag}" "${subagent_type:-}"
}

# Named aggregation query over the trace sink — reports tripped-check counts by verdict tag.
# Read-only: never writes, never touches a verdict. Absent sink reads as 0 (a first run is 0 trips),
# NOT missing data. jq-free (grep only), so it works even where the gate path would fail-open on
# absent jq. Mirrors inject-scope-rules.sh --drop-rate.
aggregate_block_counts() {
  local total=0 tag count
  if [[ -f "${VGATE_FIRED_LOG}" ]]; then
    # grep -c prints "0" AND exits 1 on zero matches — capture with `|| true`, never `|| echo 0`
    # (the latter yields "0\n0"); the empty-guard then covers a read error.
    total="$(grep -c 'verdict=' "${VGATE_FIRED_LOG}" 2>/dev/null || true)"
    [[ -z "${total}" ]] && total=0
  fi
  printf 'enforce-verification-gate block-counts: total=%s' "${total}"
  for tag in block-sizeest block-reviewer block-entry; do
    count=0
    if [[ -f "${VGATE_FIRED_LOG}" ]]; then
      count="$(grep -c "verdict=${tag}\$" "${VGATE_FIRED_LOG}" 2>/dev/null || true)"
      [[ -z "${count}" ]] && count=0
    fi
    printf ' %s=%s' "${tag}" "${count}"
  done
  printf '\n'
}

# Operator aggregation-query mode — dispatched BEFORE the stdin drain below so
# `enforce-verification-gate.sh --block-counts` never blocks waiting on standard input. The hook path
# is invoked with NO args, so ${1:-} is empty and this is skipped there.
if [[ "${1:-}" == "--block-counts" ]]; then
  aggregate_block_counts
  exit 0
fi

# stdin non-interactive → drain once, otherwise fail-open.
# Payload names: an inherited export would carry them into every child's environment, capped per string on Linux.
export -n input gate_tsv hook_event session_id prompt_b64 prompt_full text scope_line files line scan
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
#      entry-miss warning into a pass, while a real reference (plan-6569, docs/plan-42, 2026-plan) matches.
# Keep in sync with enforce-workflow-verify-stage.sh's inline PLAN_REF_RE copy — both raw-scan these
# self-attestation tokens (P0), matching regardless of comment placement (the anchors are mirrored).
references_plan() {
  local text="${1}"
  [[ -z "${text}" ]] && return 1
  printf '%s' "${text}" \
    | drain_after grep -qE 'clauded-docs/[0-9]+|[A-Za-z0-9_./-]*plan[A-Za-z0-9_-]*\.html|documents/[A-Za-z0-9_./-]+\.html|(^|[^A-Za-z0-9_])plan-[0-9]+([^A-Za-z0-9]|$)|(^|[^A-Za-z0-9_])[0-9]+-plan([^A-Za-z0-9]|$)' 2>/dev/null
}

# Shared attestation-token predicate: fixed-string (grep -qF) presence of an anchored bracketed
# literal in the delegation prompt. One definition so a new token cannot drift from its siblings.
has_token() {
  local text="${1}" literal="${2}"
  [[ -z "${text}" ]] && return 1
  printf '%s' "${text}" | drain_after grep -qF "${literal}" 2>/dev/null
}

# Entry-classification token — the orchestrator's conscious "this DEV task is simple/exempt"
# signal. Anchored bracketed literal (grep -qF, not a bare 'simple' substring) to avoid the
# FP-storm a loose match would cause — mirrors references_plan()'s structured-match discipline.
has_simple_task_token() { has_token "${1}" '[ENTRY-CLASS] simple-task'; }

# [SIZE-EST] self-attestation token — the orchestrator's per-delegation packing estimate emitted at
# every DEV spawn not classified simple-task (format `[SIZE-EST] bundles=N tool_uses~=N — <reason>`, skills/glass-atrium-ops-orchestrator-role.md
# ### Spawn Budget). Anchored bracketed literal (grep -qF, mirrors has_simple_task_token's
# structured-match discipline) — checks PRESENCE only, never the estimate's correctness (same
# existence-only boundary as the [ENTRY-CLASS] entry tokens).
has_size_est_token() { has_token "${1}" '[SIZE-EST]'; }

# [PLAN-SUBSET] attestation token — the orchestrator's record that a plan-derived delegation had its
# predecessor edges classified before spawning (skills/glass-atrium-ops-orchestrator-role.md ### Phase Notes, plan edge
# discovery). Anchored bracketed literal, PRESENCE only — never the classification's correctness.
has_plan_subset_token() { has_token "${1}" '[PLAN-SUBSET]'; }

# Prints the first sensitive prefix matched by the declared paths (empty when none). Read into an
# array rather than word-split in place: an unquoted expansion would also glob `settings*.json`
# against the cwd. Args: $1=newline-separated declared paths. Always returns 0.
scope_files_sensitive_prefix() {
  local files="${1}" path prefix
  local -a prefixes=()
  IFS=' ' read -r -a prefixes <<<"${DEEP_REVIEW_SENSITIVE_PREFIXES}"
  for prefix in "${prefixes[@]}"; do
    while IFS= read -r path; do
      [[ -n "${path}" ]] || continue
      # shellcheck disable=SC2254  # unquoted on purpose — the constant carries glob patterns.
      case "${path}" in
        ${prefix}*)
          printf '%s' "${prefix}"
          return 0
          ;;
        *) ;;
      esac
    done <<<"${files}"
  done
  return 0
}

# Surface 5 emitter — the file-count / sensitive-path Deep-review advisory. Counts through the shared
# scope_decl_files parser: an unparseable or empty declaration is SILENCE (fail-open), never a guess.
# Only the count and the matched prefix reach stderr — the prompt itself never does.
# Args: $1=the selected declaration line.
warn_deep_review() {
  local scope_line="${1}" files count prefix prefix_note=""
  files="$(scope_decl_files "${scope_line}")"
  [[ -n "${files}" ]] || return 0
  count="$(printf '%s' "${files}" | grep -c '[^[:space:]]' || true)"
  prefix="$(scope_files_sensitive_prefix "${files}")"
  if ((count < DEEP_REVIEW_FILE_THRESHOLD)) && [[ -z "${prefix}" ]]; then
    return 0
  fi
  if [[ -n "${prefix}" ]]; then
    prefix_note=", one of them under the sensitive prefix ${prefix}"
  fi
  printf '[enforce-verification-gate] This delegation declares %d [SCOPE] file(s)%s — compose a Deep (4-pass) review of the result regardless of the writer-reported confidence (thresholds: skills/glass-atrium-ops-orchestrator.md → Quality Gates). Advisory only — the declaration is counted here, the routing decision is not enforced.\n' \
    "${count}" "${prefix_note}" >&2
}

# Surfaces 4+5 emitter, after any surface 1-3 warning. A missing declaration is nudged; a present one is sized.
# [SCOPE] = the orchestrator's record of the delegation's literal scope, checked for PRESENCE only —
# a line the shared scope_decl_select accepts, so a quoted `[SCOPE]` mention does not silence the nudge.
# Selector status 2 = the declaration was never read → reported as unread, neither nudged nor sized.
warn_scope_advisories() {
  [[ "${orchestrator_origin}" == true ]] || return 0
  local scope_line decl_status=0
  # `trap - ERR` inside the $( ): the inherited fail-open trap would exit the subshell 0 and mask the 2.
  # shellcheck disable=SC2310  # the selector's status IS the answer, captured by the || below
  scope_line="$(
    trap - ERR
    printf '%s\n' "${prompt_full}" | drain_after scope_decl_select
  )" || decl_status=$?
  if ((decl_status != 0)); then
    (printf '[enforce-verification-gate] DEV spawn of %s: a [SCOPE] declaration could not be read (selector status %d), so neither its presence nor its file count was checked — the prompt may still carry one, so this is not a missing-declaration report. Advisory only.\n' \
      "${subagent_type}" "${decl_status}") >&2 || true
    return 0
  fi
  if [[ -z "${scope_line}" ]]; then
    printf '[enforce-verification-gate] DEV spawn of %s carries no [SCOPE] declaration — a mid-line or quoted [SCOPE] does not count, and neither does a [SCOPE] token wrapped in backticks or ** — the declaration must open its own line with the bare token. Record it in the canonical middot-separated grammar — [SCOPE] files=path/one, path/two · deliverable=<type> · out=none — so the delegation'"'"'s literal scope is fixed in text before the work starts (grammar SoT: skills/glass-atrium-ops-orchestrator-role.md → Context Handoff Size). Advisory only — presence is checked here, fidelity to the user instruction is not.\n' \
      "${subagent_type}" >&2
    return 0
  fi
  warn_deep_review "${scope_line}"
}

# get_monitor_docs_url — the clauded-docs collection URL, or rc 1 when none resolves. A full
# VGATE_MONITOR_URL override wins outright so a suite never reaches the live monitor; otherwise the
# port comes from the shared wrapper, sourced lazily — this gate's own hook-utils.sh lacks it.
get_monitor_docs_url() {
  if [[ -n "${VGATE_MONITOR_URL:-}" ]]; then
    printf '%s' "${VGATE_MONITOR_URL}"
    return 0
  fi
  local lib port
  lib="${BASH_SOURCE%/*}/lib/hook-utils.sh"
  [[ -r "${lib}" ]] || return 1
  # shellcheck source=lib/hook-utils.sh
  source "${lib}" || return 1
  # shellcheck disable=SC2310  # a resolver miss leaves port empty, which the integer test rejects
  port="$(hook_monitor_port 2>/dev/null || true)"
  [[ "${port}" =~ ^[0-9]+$ ]] || return 1
  printf 'http://127.0.0.1:%s/api/clauded-docs' "${port}"
}

# get_unstarted_plan_id — prints the first cited plan still at doc_review, nothing otherwise. Walks the
# prompt's clauded-docs ids in citation order; the first planner-authored document ends the walk,
# nudged or not, and so does the first failed GET — a hung monitor costs one timeout. Always rc 0.
get_unstarted_plan_id() {
  local ids base id doc_tsv author stage
  ids="$(printf '%s\n' "${prompt_full}" | grep -oE 'clauded-docs/[0-9]+' | sed 's|.*/||' | awk '!seen[$0]++' || true)"
  [[ -n "${ids}" ]] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  # shellcheck disable=SC2310  # an unresolvable URL is this leg's silent answer, not an error
  base="$(get_monitor_docs_url)" || return 0
  while IFS= read -r id; do
    doc_tsv="$(curl -sf --max-time "${MONITOR_CURL_TIMEOUT_SEC}" "${base}/${id}" \
      | jq -r '[(.author // ""), (.doc_status // "")] | join("\u001f")')" || return 0
    [[ -n "${doc_tsv}" ]] || return 0
    IFS=$'\x1f' read -r author stage <<<"${doc_tsv}"
    [[ "${author}" == "${PLANNER_AUTHOR}" ]] || continue
    [[ "${stage}" == "doc_review" ]] && printf '%s' "${id}"
    return 0
  done <<<"${ids}"
  return 0
}

# Surface 6 emitter — isolated the way emit_gate_trace is: the subshell's own stderr is discarded and
# the enclosing statement always succeeds, so no failure here can alter the exit code; only the
# advisory line reaches stderr, through fd 3.
warn_unstarted_plan() {
  [[ "${orchestrator_origin}" == true ]] || return 0
  (
    local plan_id
    # shellcheck disable=SC2310  # errexit is off in this ||-guarded subshell by design; every step fails explicitly
    plan_id="$(get_unstarted_plan_id)"
    [[ -n "${plan_id}" ]] || exit 0
    printf '[enforce-verification-gate] Plan clauded-docs/%s is still at doc_review while DEV agent %s starts on it — record the implementing stage before this first DEV spawn, so the session-start open-plan list carries the plan until it closes (stage write recipe: skills/glass-atrium-ops-orchestrator.md → Managed Document Completion (Direct Handling)). Advisory only — the stage is read live, and a monitor that is down or unreachable yields silence, so no nudge never means checked-and-clean.\n' \
      "${plan_id}" "${subagent_type}" >&3
  ) 3>&2 2>/dev/null || true
}

# 1. READ reviewer-present snapshot from PRIOR EXECUTED spawns (PostToolUse stamps only — DF-5).
# Sequential reviewer→DEV: the reviewer's PostToolUse durably commits the qa-code-reviewer line when
# it completes → this DEV spawn's PreToolUse read observes it → pass. Same-batch parallel reviewer+DEV:
# the reviewer has not completed at the DEV read → snapshot absent → VGATE-REVIEWER-001 warning on
# orchestrator origin, stderr advisory on a nested sub-worker origin (surface 1). This PreToolUse read is
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
  if {
    grep -x 'glass-atrium-qa-code-reviewer' "${path}" 2>/dev/null || true
    grep -vx 'glass-atrium-qa-code-reviewer' "${path}" 2>/dev/null | tail -n "${budget}" || true
  } >"${tmp_path}" 2>/dev/null && mv -f "${tmp_path}" "${path}" 2>/dev/null; then
    return 0
  fi
  # shellcheck disable=SC2310  # pure predicate — nothing inside it for errexit to catch
  if ga_guard_path "${tmp_path}"; then
    rm -f -- "${tmp_path:?}"
  fi || true
}

# 2. Spawn-SUCCESS stamp — PostToolUse ONLY (DF-5). PreToolUse fires BEFORE the spawn runs, so
# stamping there records a mere ATTEMPT: a spawn a sibling PreToolUse hook blocks never executes yet
# still leaves a marker line — falsely satisfying a later DEV spawn's reviewer-presence check AND inflating advisory-spawn-budget.sh's counter with
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

# Spawn ORIGIN, computed ONCE over the immutable ${input} and reused by both the [SIZE-EST] check (3a)
# and the reviewer-miss check (4). hook_is_subagent spawns a python3 read, so a single evaluation drops
# a redundant interpreter cold-start on this PreToolUse hot path. orchestrator_origin=true ⇔ agent_id
# ABSENT (main-session/orchestrator spawn, which loads the token-defining rules); a nested sub-worker
# origin (agent_id present) draws no structured warning.
orchestrator_origin=false
# SC2310: hook_is_subagent is a pure predicate — set -e disable under `if !` intended.
# shellcheck disable=SC2310
if ! hook_is_subagent "${input}"; then
  orchestrator_origin=true
fi

# Simple-task entry — [ENTRY-CLASS] simple-task with no plan-reference. Such a spawn owes no other
# attestation token, so the [SIZE-EST] check and the [SCOPE] / [PLAN-SUBSET] advisories pass it
# silently; a plan-reference keeps every token check, whatever classification travels beside it.
# shellcheck disable=SC2310  # pure predicates — set -e disable under `if` intended
if has_simple_task_token "${prompt_full}" && ! references_plan "${prompt_full}"; then
  exit 0
fi

# 3a. [SIZE-EST] presence check — every non-simple-task orchestrator DEV spawn owes a [SIZE-EST]
# self-attestation token (skills/glass-atrium-ops-orchestrator-role.md ### Spawn Budget). Placed BEFORE
# the entry-decision branch so a plan-bearing orchestrator spawn is still size-checked.
# SC2310: has_size_est_token is a pure predicate — set -e disable under `if` intended.
# shellcheck disable=SC2310
if [[ "${orchestrator_origin}" == true ]] && ! has_size_est_token "${prompt_full}"; then
  size_reason="Spawning DEV agent '${subagent_type}' from the orchestrator with NO [SIZE-EST] self-attestation token — a DEV spawn that is not an [ENTRY-CLASS] simple-task entry MUST declare its delegation-size estimate (skills/glass-atrium-ops-orchestrator-role.md ### Spawn Budget)."
  size_fix="Record [SIZE-EST] bundles=N tool_uses~=N — <1-line reason> in the prompt: bundles = count of {implement, write-tests, run-full-suite, report-consolidation} packed into THIS delegation, tool_uses~=N = your rough pre-spawn estimate. On a borderline count, round up: an under-estimate hides an oversized delegation from the split discipline. A genuinely simple task with no plan-reference records [ENTRY-CLASS] simple-task: multi-file=no cross-module=no turns<3 contract=no — <1-line> instead: that alone clears this gate and every other token check."
  warn_tripped_check "VGATE-SIZE-001" "${size_reason}" "${size_fix}" \
    "{\"subagent_type\":\"${subagent_type}\",\"reason\":\"size-est-miss\"}" "block-sizeest"
fi

# Entry-decision branch — three mutually exclusive paths:
#   plan-ref present       → task entered the flow → the reviewer check.
#   [ENTRY-CLASS] token    → orchestrator consciously classified it simple → exited 0 silent above.
#   NEITHER                → silent entry-miss → VGATE-ENTRY-001 warning.
# Both remaining paths fall through to surfaces 4-6.
# SC2310: references_plan/has_simple_task_token are pure predicates — set -e disable under `if`
# intended (same posture as is_dev_agent above).
# shellcheck disable=SC2310
if references_plan "${prompt_full}"; then
  # 3b. C3-H — [PLAN-SUBSET] presence NUDGE (stderr advisory, exit 0, NEVER a block). A plan-derived
  # delegation classifies its included tasks' declared predecessors before spawning; the token records
  # that the check ran. The token is conditional on the delegation being a strict SUBSET of the plan,
  # so its absence is often correct, and the nudge says so. HONEST BACKING: presence-checkable only; whether the classification
  # beneath the token is true is never verifiable here, and the edge-ordering obligation itself lives in
  # guardrail (c), which no token gates.
  # SC2310: has_plan_subset_token is a pure predicate — set -e disable under `if` intended.
  # shellcheck disable=SC2310
  if [[ "${orchestrator_origin}" == true ]] && ! has_plan_subset_token "${prompt_full}"; then
    # Subshell owns no child → no SIGCHLD can interrupt the write (bash 3.2 EINTR); status ignored.
    (printf '[enforce-verification-gate] Plan-referencing spawn of %s carries no [PLAN-SUBSET] token. If this delegation is a strict subset of the plan, classify each included task'"'"'s declared predecessors first and record [PLAN-SUBSET] included=<ids> landed=<ids|none> excluded=<ids|none> order=<edges|n/a>. Advisory only — absence is correct for a whole-plan delegation.\n' \
      "${subagent_type}") >&2 || true
  fi
  # 4. Reviewer-miss: a plan-referencing DEV spawn with no qa-code-reviewer recorded before it
  # (sequential reviewer→DEV satisfies it). An orchestrator-origin spawn (agent_id absent) composes
  # the Stage-2 {qa-code-reviewer, DEV} team, so it gets the structured VGATE-REVIEWER-001 warning; a
  # NESTED sub-worker origin gets the plain line only. "no qa-code-reviewer recorded" stays verbatim
  # in both, so a downstream log scan keys on one phrase.
  if [[ "${reviewer_present}" != true ]]; then
    reviewer_reason="Verification-gate reviewer-miss: spawning DEV agent '${subagent_type}' on a plan-referencing task, but no qa-code-reviewer recorded in this session. Complex plans require a {qa-code-reviewer, DEV} Plan Direction Verification team before implementation entry (skills/glass-atrium-ops-orchestrator-role.md Stage-2 gate)."
    if [[ "${orchestrator_origin}" == true ]]; then
      reviewer_fix="Spawn glass-atrium-qa-code-reviewer FIRST (sequentially, before this DEV spawn) so its PostToolUse stamp records the Stage-2 verdict — the later DEV spawn then reads clean. If this task is genuinely simple/exempt, record [ENTRY-CLASS] simple-task in the prompt instead of a plan-reference."
      warn_tripped_check "VGATE-REVIEWER-001" "${reviewer_reason}" "${reviewer_fix}" \
        "{\"subagent_type\":\"${subagent_type}\",\"reason\":\"reviewer-miss\"}" "block-reviewer"
    else
      printf '[enforce-verification-gate] %s\n' "${reviewer_reason}" >&2
    fi
  fi
else
  # 5. Entry-miss — no plan-reference AND no [ENTRY-CLASS] simple-task classification (the silent
  # entry-miss): DEV ∧ !references_plan ∧ !has_simple_task_token; the simple-task token exited above.
  entry_reason="Spawning DEV agent '${subagent_type}' with NEITHER a plan-reference NOR an [ENTRY-CLASS] simple-task classification — sizable DEV work MUST enter the Document-Driven Workflow (author a plan first)."
  entry_fix="If this task meets the sizable floor (multi-file blast radius — ~3+ COORDINATED target files; 3+ files is a STRONG sizable signal, borderline → SIZABLE / cross-module / >=3 turns / public-contract — see scoped/maintainers/scope-dev.md -> Sizable-task definition) author a plan and reference it. If genuinely simple, record [ENTRY-CLASS] simple-task: multi-file=no cross-module=no turns<3 contract=no — <1-line> in the prompt to silence this check. NOTE: a plan-referencing spawn must ALSO carry a [SIZE-EST] bundles=N tool_uses~=N — <1-line> delegation-size token (checked separately by VGATE-SIZE-001); a simple-task spawn needs no other token."
  warn_tripped_check "VGATE-ENTRY-001" "${entry_reason}" "${entry_fix}" \
    "{\"subagent_type\":\"${subagent_type}\",\"reason\":\"entry-miss\"}" "block-entry"
fi

# 6. Surfaces 4-6 — every DEV spawn that reaches here, warned or not.
warn_scope_advisories
warn_unstarted_plan
exit 0
