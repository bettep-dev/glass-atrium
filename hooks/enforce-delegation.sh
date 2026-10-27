#!/usr/bin/env bash
# PreToolUse(Write|Edit) — orchestrator direct-write gate. A subagent (agent_id present), an allowed
# basename (CLAUDE/MEMORY/GLASS_ATRIUM_GLOBAL_RULES.md) or a */memory/* session-state path passes.
# An orchestrator write passes as tiny direct work unless its target is one of the kinds that stay
# delegated, each blocked with exit 2 under its own code:
#   DEL-001 harness path — a .claude / .claude-* segment or the .glass-atrium install root, judged on
#           the path as written AND on its physical path (a symlink cannot launder it)
#   DEL-004 sensitive file — .env-class, secrets/credentials, private keys, or an .ssh/.aws/.gnupg dir
#   DEL-005 new document file — the target does not exist yet and carries a document extension
#           (md/markdown/mdx/html/htm/rst/adoc/txt), anywhere: creating one is report/plan/spec authoring
#   DEL-006 a Target File of a plan at stage implementing — plan work stays delegated
#   DEL-007 the implementing plans' Target Files cannot be read — fail closed
# Block channel = stderr emit_error + exit 2 (non-substitutable with the stdout decision channel — see shared-hook-capability-contract.md)
#
# memory/* path-prefix exception: the orchestrator MAY directly Write/Edit session-state files under
# any */memory/* segment — low-risk transient state, not a delegation surface. A memory/ nested under a
# protected harness dir (agents/, rules/, hooks/, skills/, autoagent/, monitor/, scripts/) stays gated.
# SCOPE NOTE: this hook governs tool-call PERMISSION only — the user-facing one-line judgment before a
# direct edit and the Harness Path Protection approval are behavioral gates it does not check.
set -Eeuo pipefail
IFS=$'\n\t'

source "${BASH_SOURCE%/*}/hook-utils.sh"
# shellcheck source=lib/hook-utils.sh
source "${BASH_SOURCE%/*}/lib/hook-utils.sh"
# shellcheck source=lib/scope-match.sh
source "${BASH_SOURCE%/*}/lib/scope-match.sh"

INPUT=$(hook_read_input)

# Fail-closed on a python3-less PATH, but ONLY when there is real input to guard.
# WHY: without python3 the tool_input probe fail-opens to `empty` (T3 AC4) — which the
# empty-state ALLOW below would misread as "nothing to guard" → ALLOW an orchestrator
# harness write. Blocking non-empty input here keeps that fail-open from disarming the
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
#    directly under a protected harness dir (agents/, rules/, hooks/, skills/, autoagent/,
#    monitor/, scripts/) is NOT a session-state root — those stay BLOCKED so a harness write
#    cannot bypass via a "memory" segment (e.g. agents/memory/x.md must route through delegation).
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

# 5. Orchestrator write → block the kinds that stay delegated; anything else is tiny direct work.
#    Any unexpected failure past this point blocks: an exit 1 would read as allow.
trap 'emit_error "DEL-007" "block" "Delegation gate internal error — blocking (fail closed)" "Delegate the edit to a sub-agent" "{}"; exit 2' ERR

# .env-class / secrets / credentials basenames (mirrors validate-secret-scan.sh SECRETS_FILE) + key files.
readonly SENSITIVE_NAME_RE='^(\.env(\..+)?|\.envrc|secrets?(\..+)?|credentials?(\..+)?|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|key|p12|pfx))$'
readonly DOC_EXT_RE='\.(md|markdown|mdx|html|htm|rst|adoc|txt)$'
# shellcheck disable=SC2310  # a resolver miss leaves an unbindable URL, which the plan leg blocks on
monitor_port="$(hook_monitor_port 2>/dev/null || true)"
readonly PLAN_LIST_URL="${DELEGATION_MONITOR_URL:-http://127.0.0.1:${monitor_port}/api/clauded-docs}"
readonly CURL_TIMEOUT="${DELEGATION_CURL_TIMEOUT:-2}"

# Physical path of $1: nearest existing ancestor resolved with cd -P, plus one final-component link.
get_physical_path() {
  local dir base target
  dir="$(dirname -- "${1}")"
  base="$(basename -- "${1}")"
  while [[ ! -d "${dir}" ]]; do
    base="$(basename -- "${dir}")/${base}"
    dir="$(dirname -- "${dir}")"
  done
  dir="$(cd -P -- "${dir}" && pwd -P)"
  if [[ -L "${dir}/${base}" ]]; then
    target="$(readlink -- "${dir}/${base}")"
    [[ "${target}" == /* ]] || target="${dir}/${target}"
    printf '%s' "${target}"
    return 0
  fi
  printf '%s' "${dir}/${base}"
}

is_harness_path() {
  case "${1}/" in
    */.claude/* | */.claude-*/* | */.glass-atrium/*) return 0 ;;
    *) return 1 ;;
  esac
}

is_sensitive_path() {
  case "${1}/" in
    */.ssh/* | */.aws/* | */.gnupg/*) return 0 ;;
    *) : ;;
  esac
  [[ "$(basename -- "${1}")" =~ ${SENSITIVE_NAME_RE} ]]
}

# A new file with a document extension: the write would author a document, not fix one.
is_new_document() {
  local name
  [[ -e "${1}" || -L "${1}" ]] && return 1
  name="$(basename -- "${1}")"
  name="$(printf '%s' "${name}" | tr '[:upper:]' '[:lower:]')"
  [[ "${name}" =~ ${DOC_EXT_RE} ]]
}

# Block with one of this hook's codes. Args: $1=code  $2=message  $3=suggestion.
block_write() {
  local context
  # shellcheck disable=SC2016  # $p is a jq variable
  context="$(jq -cn --arg p "${FILE_PATH}" '{file_path:$p}' 2>/dev/null)" || context='{}'
  emit_error "${1}" "block" "${2}" "${3}" "${context}"
  exit 2
}

# Ids of the plans at implementing, one per line; rc 1 when the full list cannot be read.
get_implementing_plan_ids() {
  local body
  command -v curl >/dev/null 2>&1 || return 1
  command -v jq >/dev/null 2>&1 || return 1
  body="$(curl -sf --max-time "${CURL_TIMEOUT}" "${PLAN_LIST_URL}?doc_status=implementing&limit=200" 2>/dev/null)" || return 1
  # A page shorter than .total hides plans → unreadable, never a partial answer.
  jq -er 'if (.rows | type) == "array" and (.total // 0) <= (.rows | length)
          then ([.rows[] | select(.doc_status == "implementing") | .id | tostring] | join("\n"))
          else error("partial list") end' <<<"${body}" 2>/dev/null
}

# Target Files of plan $1 as path tokens, one per line (none when the plan declares no list); rc 1
# when the plan cannot be read. md: list items only, so prose naming a path binds nothing.
get_plan_target_files() {
  local doc body format items
  doc="$(curl -sf --max-time "${CURL_TIMEOUT}" "${PLAN_LIST_URL}/${1}" 2>/dev/null)" || return 1
  # One jq pass: format on the first line, the body after it.
  body="$(jq -er 'if (.body | type) == "string" then "\(.format // "")\n\(.body)" else error("no body") end' \
    <<<"${doc}" 2>/dev/null)" || return 1
  format="${body%%$'\n'*}"
  body="${body#*$'\n'}"
  case "${format}" in
    html) items="$(extract_target_files_section "${body}" 2>/dev/null)" ;;
    md)
      items="$(extract_target_files_heading "${body}")"
      items="$(printf '%s\n' "${items}" | sed -n -E 's/^[[:space:]]*([-*]|[0-9]+\.)[[:space:]]+//p')"
      ;;
    *) return 1 ;;
  esac
  get_item_paths "${items}"
}

# Each item's path: its first backticked token, else its first word; kept only when path-like.
get_item_paths() {
  local item token
  while IFS= read -r item; do
    if [[ "${item}" =~ \`([^\`]+)\` ]]; then
      token="${BASH_REMATCH[1]}"
    else
      token="$(printf '%s' "${item}" | sed -E 's/^[[:space:]]*//; s/[[:space:]].*//')"
    fi
    [[ "${token}" =~ [[:alnum:]] && "${token}" =~ [./] ]] && printf '%s\n' "${token}"
  done <<<"${1}"
  return 0
}

# FILE_PATH contains a listed path, or shares its basename — match_file_against_allowed's rule,
# fork-free here because the tokens arrive already cleaned and a plan lists hundreds of them.
is_listed_path() {
  local token name="${FILE_PATH##*/}"
  while IFS= read -r token; do
    [[ -n "${token}" ]] || continue
    [[ "${FILE_PATH}" == *"${token}"* || "${name}" == "${token##*/}" ]] && return 0
  done <<<"${1}"
  return 1
}

check_plan_target_files() {
  local ids id list
  # shellcheck disable=SC2310  # an unreadable list is answered by the DEL-007 block
  ids="$(get_implementing_plan_ids)" || block_write "DEL-007" \
    "Orchestrator direct write blocked: the implementing plans' Target Files could not be read (monitor unreachable or list unreadable), so the gate fails closed" \
    "Delegate the edit to a sub-agent, or restore the monitor at ${PLAN_LIST_URL} and retry"
  while IFS= read -r id; do
    [[ "${id}" =~ ^[0-9]+$ ]] || continue
    # shellcheck disable=SC2310  # an unreadable plan is answered by the DEL-007 block
    list="$(get_plan_target_files "${id}")" || block_write "DEL-007" \
      "Orchestrator direct write blocked: the Target Files of implementing plan clauded-docs/${id} could not be read, so the gate fails closed" \
      "Delegate the edit to a sub-agent, or fix the plan's Target Files list"
    # shellcheck disable=SC2310  # predicate call
    if is_listed_path "${list}"; then
      block_write "DEL-006" \
        "Orchestrator direct write blocked: the file is a Target File of implementing plan clauded-docs/${id} — plan work stays delegated" \
        "Delegate it to the plan's DEV agent with the plan reference"
    fi
  done <<<"${ids}"
}

[[ "${NORM_PATH}" == /* ]] || block_write "DEL-001" \
  "Orchestrator direct write blocked: a relative path cannot be judged against the harness roots" \
  "Retry with the absolute path, or delegate the edit to a sub-agent"
PHYSICAL_PATH="$(get_physical_path "${NORM_PATH}")"

# shellcheck disable=SC2310  # predicate calls
if is_harness_path "${NORM_PATH}" || is_harness_path "${PHYSICAL_PATH}"; then
  block_write "DEL-001" \
    "Orchestrator direct write blocked: harness path (~/.claude, a ~/.claude-* profile dir or the .glass-atrium install root)" \
    "Edit the repo path for an install-managed file, or take the staged lane for a profile-local file (orchestrator-role.md → Write routes)"
fi
# shellcheck disable=SC2310  # predicate calls
if is_sensitive_path "${NORM_PATH}" || is_sensitive_path "${PHYSICAL_PATH}"; then
  block_write "DEL-004" \
    "Orchestrator direct write blocked: sensitive file (.env, secrets, credentials or a key)" \
    "Never a direct edit — ask the user, or delegate the change to a sub-agent with the user's explicit approval"
fi
# shellcheck disable=SC2310  # predicate call
if is_new_document "${NORM_PATH}"; then
  block_write "DEL-005" \
    "Orchestrator direct write blocked: creating a new document file is report/plan/spec authoring" \
    "Delegate the document to glass-atrium-intel-reporter or glass-atrium-intel-planner, which POST it to the monitor"
fi
check_plan_target_files
exit 0
