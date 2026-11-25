#!/usr/bin/env bats
# track-outcome-needs-context-streak.bats — the per-agent-id needs_context streak in track-outcome.sh:
# the fire whose streak reaches the threshold carries one replace-do-not-continue advisory (DATA-081).
#
# The streak keys by agent id, never agent type: a teammate resumed by message fires SubagentStop under
# the same agent id each time, while parallel teammates of one type each carry their own id.
# The DB helper is stubbed by a PATH python3 shim, so no live Postgres is touched.

HOOK_SH="${TRACK_OUTCOME_SH:-${BATS_TEST_DIRNAME}/../track-outcome.sh}"
PG_HELPER_SRC="${BATS_TEST_DIRNAME}/../_pg_outcome_dualwrite.py"

# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  [[ -x "${PG_HELPER_SRC}" ]] || skip "_pg_outcome_dualwrite.py not executable: ${PG_HELPER_SRC}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  REAL_PY3="$(command -v python3)"
  NCS_TMP="$(mktemp -d -t track-ncs.XXXXXX)"
  AGENT_TYPE="glass-atrium-dev-shell"
  SESSION_ID="sess-ncs-$$-${RANDOM}"

  SANDBOX_HOME="${NCS_TMP}/home"
  PROJ_SLUG="${SANDBOX_HOME//\//-}"
  TRANSCRIPT_DIR="${SANDBOX_HOME}/.claude/projects/${PROJ_SLUG}/${SESSION_ID}/subagents"
  mkdir -p "${TRANSCRIPT_DIR}" "${SANDBOX_HOME}/.claude/logs"
  PAYLOAD_FILE="${NCS_TMP}/payload.json"

  SHIM_DIR="${NCS_TMP}/bin"
  mkdir -p "${SHIM_DIR}"
  # shellcheck disable=SC2016  # the shim's own expansions stay literal
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' 'for _a in "$@"; do'
    printf '%s\n' '  case "${_a}" in'
    printf '%s\n' '    *_pg_outcome_dualwrite.py) cat >/dev/null; exit 0 ;;'
    printf '%s\n' '  esac'
    printf '%s\n' 'done'
    printf '%s\n' "exec \"${REAL_PY3}\" \"\$@\""
  } >"${SHIM_DIR}/python3"
  chmod +x "${SHIM_DIR}/python3"
}

teardown() {
  if ga_guard_path "${NCS_TMP:-}"; then rm -rf -- "${NCS_TMP:?}"; fi
}

# The agent's own transcript: one tool_use, then a terminal [COMPLETION] carrying the given result.
write_transcript() {
  local agent_id="${1}" result="${2}"
  "${REAL_PY3}" - "${TRANSCRIPT_DIR}/agent-${agent_id}.jsonl" "${result}" <<'PY'
import json, sys
path, result = sys.argv[1], sys.argv[2]
completion = (
    "[COMPLETION]\n"
    f"result: {result}\n"
    "task_type: feature\n"
    "metric_pass: false\n"
    "confidence: medium\n"
    "summary: hook edit stopped at a work-unit boundary, resume point in the progress file\n"
    "[/COMPLETION]"
)
rows = [
    {"type": "user", "message": {"role": "user", "content": "continue from the progress file"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "name": "Read", "input": {}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "content": "ok"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": completion}]}},
]
with open(path, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

write_payload() {
  jq -nc \
    --arg aid "${1}" \
    --arg sess "${SESSION_ID}" \
    --arg agent "${AGENT_TYPE}" \
    --arg cwd "${SANDBOX_HOME}" \
    '{
      hook_event_name: "SubagentStop",
      agent_type: $agent,
      agent_id: $aid,
      session_id: $sess,
      cwd: $cwd,
      transcript_path: "/nonexistent/parent.jsonl"
    }' >"${PAYLOAD_FILE}"
}

run_hook() {
  # shellcheck disable=SC2016  # positional args expand inside the child shell
  run env \
    HOME="${SANDBOX_HOME}" GA_DATA_ROOT="${SANDBOX_HOME}/.glass-atrium" \
    PATH="${SHIM_DIR}:${PATH}" \
    CLAUDE_GATE_INFLIGHT="" \
    T9_CORRECTION_DETECTION="false" \
    OUTCOME_SPOOL_DIR="${NCS_TMP}/spool" \
    CIRCUIT_BREAKER_DIR="${CB_DIR}" \
    bash -c '"$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

# One SubagentStop per "<agent-id>=<result>" step, in a fresh state dir → the 1-based steps whose
# output carried the streak advisory, space-joined.
get_advisory_steps() {
  local step i=0 fired=""
  CB_DIR="$(mktemp -d "${NCS_TMP}/cb.XXXXXX")"
  for step in "$@"; do
    i=$((i + 1))
    write_transcript "${step%%=*}" "${step#*=}"
    write_payload "${step%%=*}"
    run_hook
    [[ "${status}" -eq 0 ]] || {
      echo "step ${i} exit ${status}: ${output}" >&2
      return 1
    }
    if [[ "${output}" == *'"DATA-081"'* ]]; then
      fired="${fired:+${fired} }${i}"
    fi
  done
  printf '%s' "${fired}"
}

@test "the advisory fires once, on the step whose same-agent-id needs_context streak reaches two" {
  local a="adev-shell-1-4dd2f008f010ab67" b="adev-shell-2-9c41e07a5b33d210"
  local rows=(
    "second needs_context in a row|${a}=needs_context ${a}=needs_context|2"
    "a longer streak advises only once|${a}=needs_context ${a}=needs_context ${a}=needs_context ${a}=needs_context|2"
    "a non-needs_context result resets the streak|${a}=needs_context ${a}=done ${a}=needs_context|"
    "a streak restarts after a reset|${a}=needs_context ${a}=done ${a}=needs_context ${a}=needs_context|4"
    "teammates of one type keep separate streaks|${a}=needs_context ${b}=needs_context|"
    "an interleaved teammate does not break the streak|${a}=needs_context ${b}=done ${a}=needs_context|3"
    "a lone needs_context stays silent|${a}=needs_context|"
  )
  local row name steps want got step_list
  for row in "${rows[@]}"; do
    IFS='|' read -r name steps want <<<"${row}"
    IFS=' ' read -r -a step_list <<<"${steps}"
    got="$(get_advisory_steps "${step_list[@]}")"
    [[ "${got}" == "${want}" ]] || {
      echo "${name}: advisory at steps [${got}], want [${want}]"
      return 1
    }
  done
}

@test "the advisory names the agent id and says to replace it from its progress file" {
  local a="adev-shell-1-4dd2f008f010ab67"
  CB_DIR="$(mktemp -d "${NCS_TMP}/cb.XXXXXX")"
  write_transcript "${a}" needs_context
  write_payload "${a}"
  run_hook
  run_hook
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"${a}"*"fresh spawn from its progress file"* ]] || {
    echo "${output}"
    return 1
  }
}
