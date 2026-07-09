#!/usr/bin/env bash
# block-doc-routing-leak.sh — PreToolUse(Write) ADDITIONAL backstop against the
# doc-routing leak (intel-reporter/intel-planner writing a document to a local file
# instead of POSTing it to the monitor clauded-docs API).
#
# DESIGN INVARIANT (T11) — ADDITIONAL PreToolUse(Write) backstop, NOT the primary
# control. Default FAIL-OPEN (exit 0) on any uncertainty (absent agent_id, unrecoverable
# agent_type, absent jq, unresolved monitor root, ERR trap). A BLOCK (channel-a: stderr
# emit_error + exit 2) fires ONLY when all FOUR conditions hold:
#   (1) tool is Write,
#   (2) recovered agent_type ∈ {intel-reporter, intel-planner},
#   (3) file extension ∈ {.md,.yaml,.yml,.json,.txt},
#   (4) the normalized target path is OUTSIDE the deterministic allowlist.
# PreToolUse PRE-blocks the write (file never created) → stderr only routes to the
# monitor API, no leaked-file cleanup. Asymmetric-cost: a false-block on the high-
# frequency Write tool costs more than a rare leak past this backstop, so FAIL-OPEN.
#
# Block channel = stderr emit_error + exit 2 (channel-a) — mirrors enforce-delegation.sh's
# verified PreToolUse(Write|Edit) block (non-substitutable with the stdout decision
# channel — see shared-hook-capability-contract.md).
#
# agent_type recovery mirrors track-outcome.sh recover_agent_type_from_sidecar: sidecar =
# agent-<agent_id>.meta.json, key "agentType"; resolved co-located with transcript_path's
# dirname, or via a bounded glob keyed by session_id + agent_id (cwd-independent).
set -Eeuo pipefail
IFS=$'\n\t'

# fail-open ERR trap — a hook bug must NEVER block a Write. Any unexpected error
# falls through to exit 0 (mirrors advisory-subagent-budget.sh).
trap 'printf "[block-doc-routing-leak] internal error at line %d: %s — fail-open (exit 0)\n" "${LINENO}" "${BASH_COMMAND}" >&2; exit 0' ERR

# Firing-trace log override — captured BEFORE sourcing hook-utils.sh (which assigns
# HOOK_DATA_DIR) so the default resolves to the real runtime path; the override is for
# Bats fail-safe testing (mirrors enforce-workflow-verify-stage.sh's WORKFLOW_GATE_FIRED_LOG).
DOC_ROUTING_LEAK_FIRED_LOG="${DOC_ROUTING_LEAK_FIRED_LOG:-${HOME}/.claude/data/doc-routing-leak-fired.log}"

# Instant kill switch — non-empty disables without touching settings.json.
[[ -n "${DOC_ROUTING_LEAK_OFF:-}" ]] && exit 0

# shellcheck source=hook-utils.sh
source "${BASH_SOURCE%/*}/hook-utils.sh"
# shellcheck source=lib/hook-utils.sh
source "${BASH_SOURCE%/*}/lib/hook-utils.sh"

# POST-API hint port (guidance text only — never a block-verdict dependency). Derived via
# the hook_monitor_port wrapper (ADR-1: env → monitor/.env → config → 16145) — NO literal
# fallback here (the single default lives in the resolver); a resolver failure degrades to
# '' (cosmetic in the guidance string only).
monitor_port="$(hook_monitor_port || true)"

# Normalize a POSIX path by collapsing "." and ".." segments without touching the filesystem
# (the target may not exist yet). Traversal-safety: "memory/../x" resolves to "x", so a
# "memory" segment cannot be forged via "..". Mirrors enforce-delegation.sh normalize_path.
# Args: $1 = path. Echoes normalized.
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

# Recover agentType from the .meta.json sidecar — ALGORITHMICALLY EQUIVALENT to
# track-outcome.sh recover_agent_type_from_sidecar (reimplemented in bash + jq, not copied).
# Echoes agentType on success, empty on any failure (caller fail-opens).
# Args: $1 = transcript_path · $2 = session_id · $3 = sanitized agent_key.
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

  # (2) bounded glob keyed by session_id + agent_id (cwd-independent). Two layouts: the flat
  #     subagents/ dir + the workflow-nested location for Dynamic-Workflow agents. agent_key is
  #     already path-safe (hook_path_safe_key); the session_id glob segment is wildcard-bounded,
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

# Append one fail-SAFE firing-trace line (T10). The verdict is decided BEFORE this runs; every
# failure mode here is swallowed so the trace can NEVER alter the exit code or verdict. Subshell
# + `|| true` isolates the ERR trap.
# Args: $1=tool_name · $2=agent_id_present(yes/no) · $3=agent_type · $4=file_path · $5=verdict.
emit_trace() {
  local tool_name="${1}" id_present="${2}" agent_type="${3}" file_path="${4}" verdict="${5}"
  (
    local log_dir ts
    log_dir="$(dirname -- "${DOC_ROUTING_LEAK_FIRED_LOG}")"
    mkdir -p -- "${log_dir}" 2>/dev/null || exit 0
    ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)" || ts="unknown"
    printf '%s\ttool=%s\tagent_id_present=%s\tagent_type=%s\tfile_path=%s\tverdict=%s\n' \
      "${ts}" "${tool_name}" "${id_present}" "${agent_type}" "${file_path}" "${verdict}" \
      >>"${DOC_ROUTING_LEAK_FIRED_LOG}" 2>/dev/null || exit 0
  ) 2>/dev/null || true
}

# Allow-and-exit shorthand for the allowlist branches, where the trace prefix is fixed (Write ·
# agent present · recovered AGENT_TYPE · FILE_PATH) and only the verdict label varies.
# Args: $1 = verdict label. Traces then exits 0 (ALLOW).
allow() {
  emit_trace "Write" "yes" "${AGENT_TYPE}" "${FILE_PATH}" "${1}"
  exit 0
}

INPUT="$(hook_read_input)"
TOOL_NAME="$(hook_get_field "${INPUT}" "tool_name")"

# Condition (1): only Write is in scope.
if [[ "${TOOL_NAME:-}" != "Write" ]]; then
  emit_trace "${TOOL_NAME:-}" "n/a" "n/a" "n/a" "allow-non-write"
  exit 0
fi

# agent_id gate — absent = main session (orchestrator), fail-open. agent_id presence is the
# subagent-context signal (mirrors advisory-subagent-budget.sh).
AGENT_ID="$(hook_get_field "${INPUT}" "agent_id")"
if [[ -z "${AGENT_ID}" ]]; then
  emit_trace "Write" "no" "n/a" "n/a" "fail-open-no-agent-id"
  exit 0
fi

# SECURITY (LLM01): agent_id is external payload → allowlist-transform to a
# path-safe single segment BEFORE any filesystem-path interpolation (traversal
# guard). Empty result → fail-open.
AGENT_KEY="$(hook_path_safe_key "${AGENT_ID}")"
if [[ -z "${AGENT_KEY}" ]]; then
  emit_trace "Write" "yes" "n/a" "n/a" "fail-open-bad-agent-id"
  exit 0
fi

TRANSCRIPT_PATH="$(hook_get_field "${INPUT}" "transcript_path")"
SESSION_ID="$(hook_get_field "${INPUT}" "session_id")"

# Condition (2): recover agent_type; unrecoverable → fail-open.
AGENT_TYPE="$(recover_agent_type "${TRANSCRIPT_PATH}" "${SESSION_ID}" "${AGENT_KEY}")"
if [[ -z "${AGENT_TYPE}" ]]; then
  emit_trace "Write" "yes" "unrecoverable" "n/a" "fail-open-no-agent-type"
  exit 0
fi
case "${AGENT_TYPE}" in
  glass-atrium-intel-reporter | glass-atrium-intel-planner) : ;;
  *)
    emit_trace "Write" "yes" "${AGENT_TYPE}" "n/a" "allow-non-doc-agent"
    exit 0
    ;;
esac

FILE_PATH="$(hook_get_tool_input "${INPUT}" "file_path")"
if [[ -z "${FILE_PATH}" ]]; then
  emit_trace "Write" "yes" "${AGENT_TYPE}" "" "fail-open-no-file-path"
  exit 0
fi

# Condition (3): only document extensions are in scope.
case "${FILE_PATH}" in
  *.md | *.yaml | *.yml | *.json | *.txt) : ;;
  *)
    emit_trace "Write" "yes" "${AGENT_TYPE}" "${FILE_PATH}" "allow-non-target-ext"
    exit 0
    ;;
esac

# Condition (4): allowlist check. Normalize FIRST so "memory/../x" cannot spoof a
# session-state segment (traversal guard, mirrors enforce-delegation.sh).
NORM_PATH="$(normalize_path "${FILE_PATH}")"

# (a) session-state file under any */memory/progress-* — the progress-file write the
#     doc agents hold in their frozen allowlist.
case "/${NORM_PATH}" in
  */memory/progress-*) allow "allow-memory-progress" ;;
  *) : ;; # fall through to the next allowlist check
esac

# (b) /tmp staging-for-curl buffer under $TMPDIR or /tmp — the normal staging
#     pattern (e.g. cat-pipe to the monitor POST). TMPDIR may carry a trailing "/".
TMPDIR_NORM="${TMPDIR:-}"
TMPDIR_NORM="${TMPDIR_NORM%/}"
case "${NORM_PATH}" in
  /tmp/*) allow "allow-tmp-staging" ;;
  *) : ;; # fall through to the next allowlist check
esac
if [[ -n "${TMPDIR_NORM}" ]]; then
  case "${NORM_PATH}" in
    "${TMPDIR_NORM}"/*) allow "allow-tmpdir-staging" ;;
    *) : ;; # fall through to the next allowlist check
  esac
fi

# (c) monitor data root — resolved the block-md-creation.sh:39 way: CLAUDED_DOCS_HTML_ROOT
#     if set, ELSE dual-suffix match (.glass-atrium live root AND .claude legacy root).
#     No env-required loud-fail — CLAUDED_DOCS_HTML_ROOT is OPTIONAL by server contract.
MONITOR_ROOT="${CLAUDED_DOCS_HTML_ROOT:-}"
if [[ -n "${MONITOR_ROOT}" ]]; then
  MONITOR_ROOT="${MONITOR_ROOT%/}"
  case "${NORM_PATH}" in
    "${MONITOR_ROOT}"/* | "${MONITOR_ROOT}") allow "allow-monitor-root-env" ;;
    *) : ;; # not under the env-supplied monitor root → fall through to BLOCK
  esac
else
  case "${NORM_PATH}" in
    */.glass-atrium/monitor/data/documents/* | */.claude/monitor/data/documents/*)
      allow "allow-monitor-root-suffix"
      ;;
    *) : ;; # not under either monitor-root suffix → fall through to BLOCK
  esac
fi

# All 4 conditions hold → BLOCK via channel-a (stderr emit_error + exit 2).
# PreToolUse pre-blocks the write (file never created) → routing guidance only.
emit_trace "Write" "yes" "${AGENT_TYPE}" "${FILE_PATH}" "block"
emit_error "DOC-001" "block" \
  "Document write to a non-allowlisted local path blocked for ${AGENT_TYPE}" \
  "Route this document to the monitor clauded-docs API: POST /api/clauded-docs (127.0.0.1:${monitor_port}) instead of writing a local file" \
  "{\"file_path\":\"${FILE_PATH}\",\"agent_type\":\"${AGENT_TYPE}\",\"reason\":\"doc-routing-leak\"}"
exit 2
