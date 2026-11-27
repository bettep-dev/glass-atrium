#!/usr/bin/env bash
# PreToolUse(Write|Edit) — orchestrator sensitive-file write gate. A subagent (agent_id present), an
# allowed basename (CLAUDE/MEMORY/GLASS_ATRIUM_GLOBAL_RULES.md) or a */memory/* session-state path
# passes. Any other orchestrator write passes unless its target is a sensitive file:
#   DEL-004 sensitive file — .env-class, secrets/credentials, private keys, or an .ssh/.aws/.gnupg dir,
#           judged on the path as written AND on its physical path, every symlink hop followed (a link
#           chain cannot launder it); a relative path, a chain that cannot be resolved or passes 40
#           hops, or an internal error past the subagent check cannot be judged and blocks under
#           DEL-004 too
# Block channel = stderr emit_error + exit 2 (non-substitutable with the stdout decision channel — see shared-hook-capability-contract.md)
#
# memory/* path-prefix exception: the orchestrator MAY directly Write/Edit session-state files under
# any */memory/* segment — low-risk transient state, not a delegation surface. A memory/ nested under a
# protected dir name (agents/, rules/, hooks/, skills/, autoagent/, monitor/, scripts/) stays gated.
# SCOPE NOTE: this hook governs tool-call PERMISSION only — the user-facing one-line judgment before a
# direct edit is a behavioral gate it does not check.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"
# shellcheck source=lib/hook-utils.sh
source "${BASH_SOURCE%/*}/lib/hook-utils.sh"

INPUT=$(hook_read_input)

# Fail-closed on a python3-less PATH, but ONLY when there is real input to guard.
# WHY: without python3 the tool_input probe fail-opens to `empty` (T3 AC4) — which the
# empty-state ALLOW below would misread as "nothing to guard" → ALLOW an orchestrator
# sensitive-file write. Blocking non-empty input here keeps that fail-open from disarming the
# gate; a genuinely-empty stdin ("" / "{}" / "{ }") still passes (nothing to guard).
hook_require_python3_unless_empty "${INPUT}" "DEL-002" \
  "Delegation gate unavailable: python3 is required to parse hook input"

# 1. Consume T3's three-state tool_input probe (present · empty · unrecognized).
#    The old `empty path → ALLOW` conflated a legitimately-empty field with a DRIFTED
#    envelope (host renamed/dropped tool_input) — the drift silently, permanently
#    DISARMED the gate (empty misread as "no file"). The probe tells the two apart.
STATE=""
FILE_PATH=""
# SC2312: the probe's own exit is deliberately unread — the in-band NUL-framed state
# record, not the pipeline exit, is what this gate consumes (the probe always fail-opens to 0).
# shellcheck disable=SC2312
{
  IFS= read -r -d '' STATE || true
  IFS= read -r -d '' FILE_PATH || true
} < <(hook_probe_tool_input "${INPUT}" "file_path")

case "${STATE}" in
  present) : ;; # real file_path in FILE_PATH — fall through to the path/basename/subagent checks
  unrecognized)
    # A degenerate empty stdin ("" / "{}" / "{ }") is nothing-to-guard, not drift →
    # keep the silent allow the DEL-002 input-empty carve-out already grants.
    # shellcheck disable=SC2310
    #   Intended predicate call in an if-condition (hook_input_is_empty returns 0/1).
    if hook_input_is_empty "${INPUT}"; then
      exit 0
    fi
    # A real drift (renamed / malformed / non-object tool_input) would disarm the gate →
    # emit a loud, aggregation-visible error, then ALLOW (ADR-2: emit-and-allow, not block).
    emit_error "DEL-003" "warn" \
      "Delegation gate disarmed: tool_input envelope unrecognized (host schema drift?)" \
      "Verify the PreToolUse tool_input schema — the gate is failing OPEN until it is fixed" \
      "{}"
    exit 0
    ;;
  *) exit 0 ;; # empty (legit-empty field OR python3-absent fail-open) — today's silent allow
esac

# 2. Allow exact basenames (memory-index + root-rule files).
BASENAME=$(basename "${FILE_PATH}")
case "${BASENAME}" in
  CLAUDE.md | MEMORY.md | GLASS_ATRIUM_GLOBAL_RULES.md) exit 0 ;;
  *) : ;;
esac

# 3. Allow direct orchestrator writes to session-state files under any */memory/* segment.
#    Normalize first so "memory/../hooks/x.sh" cannot spoof the segment. A "memory/" nested
#    directly under a protected dir name (agents/, rules/, hooks/, skills/, autoagent/, monitor/,
#    scripts/) gets no exemption here: it falls through to the checks below like any other path.
#    It passes unless a later check blocks it.
#
#    DUPLICATED LIST — READ BEFORE ADDING AN EIGHTH ARM. hooks/advisory-worktree-writer-lock.sh
#    mirrors these seven arms VERBATIM to keep its lock exemption from contradicting this gate, and
#    the two lists have NO shared source: each side pins its own copy, and no test compares them. So
#    adding a protected dir here and not there silently leaves the advisory exempting it, and NOTHING
#    FAILS to tell you. Extracting hook_is_session_state_path() into hook-utils.sh would make that
#    drift impossible; it is DEFERRED, not overlooked, because it rewrites the predicate of a
#    security-relevant gate and that deserves its own change with its own test. Until then: edit both.
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

# 5. Orchestrator write → block a sensitive target; anything else is direct work.
#    Any unexpected failure past this point blocks: an exit 1 would read as allow.
#    The trap acts in the hook's own shell only: set -E carries it into every $( ) subshell, where a
#    guarded failure (an unreadable symlink hop) would emit a false internal-error record before the
#    caller's real one. A subshell failure still exits that subshell, and its caller answers it.
trap 'if [[ "${BASH_SUBSHELL}" -eq 0 ]]; then emit_error "DEL-004" "block" "Delegation gate internal error — blocking (fail closed)" "Delegate the edit to a sub-agent" "{}"; exit 2; fi' ERR

# .env-class / secrets / credentials basenames (mirrors validate-secret-scan.sh SECRETS_FILE) + key files.
readonly SENSITIVE_NAME_RE='^(\.env(\..+)?|\.envrc|secrets?(\..+)?|credentials?(\..+)?|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|key|p12|pfx))$'

# Physical path of $1, every symlink hop followed: the nearest existing ancestor is resolved with
# cd -P (which also resolves `..` physically), then a link at the remaining tail — a final-component
# link, or a dangling directory link — is replaced by its target and the walk restarts. rc 1 when a
# hop cannot be read or the chain passes 40 hops (a loop); the caller blocks on it.
get_physical_path() {
  local path="${1}" dir base link tail target hops=0
  while :; do
    dir="$(dirname -- "${path}")"
    base="$(basename -- "${path}")"
    while [[ ! -d "${dir}" && ! -L "${dir}" ]]; do
      base="$(basename -- "${dir}")/${base}"
      dir="$(dirname -- "${dir}")"
    done
    if [[ -L "${dir}" && ! -d "${dir}" ]]; then
      link="${dir}"
      tail="/${base}"
    else
      dir="$(cd -P -- "${dir}" && pwd -P)" || return 1
      path="${dir%/}/${base}"
      if [[ ! -L "${path}" ]]; then
        printf '%s' "${path}"
        return 0
      fi
      link="${path}"
      tail=""
    fi
    hops=$((hops + 1))
    [[ "${hops}" -le 40 ]] || return 1
    target="$(readlink -- "${link}")" || return 1
    [[ "${target}" == /* ]] || target="$(dirname -- "${link}")/${target}"
    path="${target}${tail}"
  done
}

is_sensitive_path() {
  case "${1}/" in
    */.ssh/* | */.aws/* | */.gnupg/*) return 0 ;;
    *) : ;;
  esac
  [[ "$(basename -- "${1}")" =~ ${SENSITIVE_NAME_RE} ]]
}

# Block with one of this hook's codes. Args: $1=code  $2=message  $3=suggestion.
block_write() {
  local context
  # shellcheck disable=SC2016  # $p is a jq variable
  context="$(jq -cn --arg p "${FILE_PATH}" '{file_path:$p}' 2>/dev/null)" || context='{}'
  emit_error "${1}" "block" "${2}" "${3}" "${context}"
  exit 2
}

# The sensitive-file judgment needs an absolute path and its physical path; without either it fails closed.
[[ "${NORM_PATH}" == /* ]] || block_write "DEL-004" \
  "Orchestrator direct write blocked: a relative path cannot be judged against the sensitive-file rule" \
  "Retry with the absolute path, or delegate the edit to a sub-agent"
# shellcheck disable=SC2310  # an unresolvable chain is answered by the DEL-004 block
PHYSICAL_PATH="$(get_physical_path "${NORM_PATH}")" || block_write "DEL-004" \
  "Orchestrator direct write blocked: the path's symlink chain could not be resolved (unreadable link or a loop), so it cannot be judged against the sensitive-file rule" \
  "Retry with the resolved path, or delegate the edit to a sub-agent"

# shellcheck disable=SC2310  # predicate calls
if is_sensitive_path "${NORM_PATH}" || is_sensitive_path "${PHYSICAL_PATH}"; then
  block_write "DEL-004" \
    "Orchestrator direct write blocked: sensitive file (.env, secrets, credentials or a key)" \
    "Never a direct edit — ask the user, or delegate the change to a sub-agent with the user's explicit approval"
fi
exit 0
