#!/usr/bin/env bats
# track-outcome-style-ref-empty-history.bats — the style_ref verifier's empty-Read-history leg.
#
# Pins the asymmetry fix: an EMPTY Read history cannot DEMONSTRATE that the emitted style_ref
# went unread, because the collector keys strictly on a Read tool_use `file_path` and is blind
# to a `sed`/`cat`/`grep` read issued through Bash. The write side withholds on exactly that
# input in hooks/lib/code-based-grader.sh::_cbg_classify_write_crosscheck (its documented
# outcome (c)) — the collector _compute_write_crosscheck merely reports ('verifiable', []).
# This pins the read-side verdict to the same shape — null (verification N/A), never false.
#
#   * EMPTY Read history + a real style_ref path  → null   (unverifiable, the fix)
#   * NON-EMPTY Read history missing that path     → false  (the real negative, preserved)
#   * Read history containing that path            → true   (regression pin)
#
# Isolation: the sibling recorder harness verbatim (track-outcome-scope-excess.bats) — HOME
# sandboxed, dual-write stubbed by a PATH python3 shim, spooled envelope as the assertion
# surface, read-cache off. No live-install path is referenced, no PG contact.

HOOK_SH="${TRACK_OUTCOME_SH:-${BATS_TEST_DIRNAME}/../track-outcome.sh}"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  REAL_PY3="$(command -v python3)"
  SR_TMP="$(mktemp -d -t track-sreh.XXXXXX)"
  AGENT_TYPE="glass-atrium-dev-shell"
  AGENT_ID="srehaid${$}x${RANDOM}"
  SESSION_ID="sess-sreh-$$-${RANDOM}"

  SANDBOX_HOME="${SR_TMP}/home"
  TRANSCRIPT_DIR="${SANDBOX_HOME}/.claude/projects/proj/${SESSION_ID}/subagents"
  mkdir -p "${TRANSCRIPT_DIR}" "${SANDBOX_HOME}/.claude/logs"
  SPOOL_DIR="${SANDBOX_HOME}/.claude/data/outcome-spool"
  PAYLOAD_FILE="${SR_TMP}/payload.json"

  SHIM_DIR="${SR_TMP}/bin"
  mkdir -p "${SHIM_DIR}"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' 'for _a in "$@"; do'
    printf '%s\n' '  case "${_a}" in'
    printf '%s\n' '    *_pg_outcome_dualwrite.py) cat >/dev/null; exit 6 ;;'
    printf '%s\n' '  esac'
    printf '%s\n' 'done'
    printf '%s\n' "exec \"${REAL_PY3}\" \"\$@\""
  } >"${SHIM_DIR}/python3"
  chmod +x "${SHIM_DIR}/python3"

  jq -nc --arg aid "${AGENT_ID}" --arg agent "${AGENT_TYPE}" --arg sess "${SESSION_ID}" '{
    hook_event_name: "SubagentStop",
    agent_type: $agent,
    agent_id: $aid,
    session_id: $sess,
    transcript_path: "/nonexistent/parent.jsonl"
  }' >"${PAYLOAD_FILE}"
}

teardown() {
  [[ -n "${SR_TMP:-}" && -d "${SR_TMP}" ]] && rm -rf -- "${SR_TMP}" || true
}

completion_block() {
  printf '%s\n' '[COMPLETION]'
  printf '%s\n' "$@"
  printf '%s\n' '[/COMPLETION]'
}

# $1 = Read file_path to record ('' → record a Bash tool_use instead, leaving the Read
#      history EMPTY exactly as a sed/grep-reading agent does), $2 = completion block text.
write_transcript() {
  local tfile="${TRANSCRIPT_DIR}/agent-${AGENT_ID}.jsonl"
  jq -nc '{type:"user", message:{role:"user", content:"delegation prompt"}}' >"${tfile}"
  if [[ -n "${1:-}" ]]; then
    jq -nc --arg p "${1}" '{type:"assistant", message:{role:"assistant",
      content:[{type:"tool_use", id:"toolu_sr1", name:"Read", input:{file_path:$p}}]}}' >>"${tfile}"
  else
    jq -nc '{type:"assistant", message:{role:"assistant",
      content:[{type:"tool_use", id:"toolu_sr1", name:"Bash",
        input:{command:"sed -n 1,40p hooks/a.sh"}}]}}' >>"${tfile}"
  fi
  jq -nc '{type:"assistant", message:{role:"assistant",
    content:[{type:"tool_use", id:"toolu_sr2", name:"Edit", input:{file_path:"/repo/hooks/a.sh"}}]}}' \
    >>"${tfile}"
  jq -nc --arg t "${2}" '{type:"assistant", message:{role:"assistant", content:[{type:"text", text:$t}]}}' \
    >>"${tfile}"
}

run_hook() {
  run env \
    HOME="${SANDBOX_HOME}" \
    PATH="${SHIM_DIR}:${PATH}" \
    CLAUDE_GATE_INFLIGHT="" \
    T9_CORRECTION_DETECTION="false" \
    STYLE_REF_READCACHE_OFF="1" \
    OUTCOME_SPOOL_DIR="${SPOOL_DIR}" \
    bash -c '"$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

# jq's `//` treats a JSON false as absent, so the three states are read explicitly instead.
verified_state() {
  local f
  f="$(find "${SPOOL_DIR}" -type f 2>/dev/null | head -1)"
  [[ -n "${f}" ]] || { echo "no spooled envelope" >&2; return 1; }
  jq -r '.outcome.style_ref_verified | if . == null then "null" else tostring end' "${f}"
}

emit_row() {
  completion_block 'result: done' 'task_type: bug-fix' 'metric_pass: true' 'confidence: high' \
    'files: hooks/a.sh' 'style_ref: hooks/a.sh' 'summary: fixed a'
}

@test "EMPTY Read history + real style_ref → null (unverifiable, mirrors the grader's write-side withhold)" {
  write_transcript '' "$(emit_row)"
  run_hook
  [[ "$(verified_state)" == "null" ]] \
    || { echo "empty Read history must withhold → null, got: $(verified_state)" >&2; return 1; }
}

@test "NON-EMPTY Read history missing the style_ref path → false (the real negative survives)" {
  write_transcript '/repo/hooks/unrelated.sh' "$(emit_row)"
  run_hook
  [[ "$(verified_state)" == "false" ]] \
    || { echo "a populated history that misses the path must stay false, got: $(verified_state)" >&2; return 1; }
}

@test "Read history containing the style_ref path → true (regression pin)" {
  write_transcript '/repo/hooks/a.sh' "$(emit_row)"
  run_hook
  [[ "$(verified_state)" == "true" ]] \
    || { echo "a corroborated path must stay true, got: $(verified_state)" >&2; return 1; }
}
