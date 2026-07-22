#!/usr/bin/env bats
# track-outcome-data-root-seam.bats — pins the T3a1 data/log-root seam conversion in
# track-outcome.sh: the HOME-anchored ${GA_DATA_ROOT:-$HOME/.glass-atrium} default now
# backs the grader-disable safety-override marker dir and the embedded-python diag log,
# parity with the shell seam (hooks/hook-utils.sh) + the python twin (hooks/ga_paths.py).
#
# Every code-behavior row here FAILS at the pre-seam HEAD (paths still default to
# ~/.claude) and PASSES after the flip — the DATA-101/DATA-102 emit polarity flips with
# the marker-dir default, and the diag log lands under the new root.
#
# Direct invocation: the hook runs via its own shebang ("$1", never `bash "$1"`); the
# bash -c wrapper only wires stdin redirection + stderr merge. HOME is sandboxed so no
# live ~/.claude or ~/.glass-atrium state is read or written.
#
# Each assertion carries a `|| return 1` fail-fast guard — bats enforces only the test
# body's LAST command status, so an unguarded intermediate assertion is silently masked.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/track-outcome.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  DS_TMP="$(mktemp -d)"
  SANDBOX_HOME="${DS_TMP}/home"
  mkdir -p "${SANDBOX_HOME}/.glass-atrium/logs"
  PAYLOAD_FILE="${DS_TMP}/payload.json"

  # A single-valid-token writer block → HAS_STRUCTURED=true, so the CODE_BASED_GATE=off
  # branch (which reads the safety-override marker dir) is reached.
  local real_block
  real_block="$(printf '%s\n' \
    '[COMPLETION]' \
    'result: done' \
    'task_type: bug-fix' \
    'metric_pass: true' \
    'confidence: high' \
    'summary: the real deliverable' \
    '[/COMPLETION]')"
  jq -nc --arg m "${real_block}" '{
    hook_event_name: "SubagentStop",
    agent_type: "glass-atrium-dev-shell",
    agent_id: "dsagent01",
    session_id: "sess-ds-1",
    last_assistant_message: $m,
    messages: [
      {role: "user", content: "run the work"},
      {role: "assistant", content: [{type: "tool_use", name: "Edit", input: {}}]}
    ]
  }' >"${PAYLOAD_FILE}"
}

teardown() {
  if [[ -n "${DS_TMP:-}" && -d "${DS_TMP}" ]]; then
    rm -rf "${DS_TMP}"
  fi
}

oc() { [[ "${2}" == *"${1}"* ]] || { printf 'assert-contains FAILED: [%s] absent from output:\n%s\n' "${1}" "${2}" >&2; return 1; }; }
no() { [[ "${2}" != *"${1}"* ]] || { printf 'assert-omits FAILED: [%s] present in output:\n%s\n' "${1}" "${2}" >&2; return 1; }; }

# run_hook <extra VAR=val ...> — direct hook invocation with stderr merged.
run_hook() {
  run env HOME="${SANDBOX_HOME}" PGHOST="/nonexistent-socket-xyzzy" CLAUDE_GATE_INFLIGHT="" "$@" \
    bash -c '"$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

@test "safety-override marker honored at the new \$HOME/.glass-atrium default (DATA-101)" {
  mkdir -p "${SANDBOX_HOME}/.glass-atrium/data/safety-overrides"
  : >"${SANDBOX_HOME}/.glass-atrium/data/safety-overrides/code-based-gate.authorized"
  run_hook CODE_BASED_GATE=off
  [ "${status}" -eq 0 ] || return 1
  # Marker found at the NEW default → authorized disable → DATA-101 (not the absent-marker DATA-102).
  oc '"code":"DATA-101"' "${output}" || return 1
  no '"code":"DATA-102"' "${output}" || return 1
}

@test "safety-override marker at the legacy ~/.claude path is IGNORED (DATA-102)" {
  # Marker planted ONLY at the old location; the new default no longer reads it, so the
  # off-request is unauthorized → DATA-102. FAILS at HEAD (old path still read → DATA-101).
  mkdir -p "${SANDBOX_HOME}/.claude/data/safety-overrides"
  : >"${SANDBOX_HOME}/.claude/data/safety-overrides/code-based-gate.authorized"
  run_hook CODE_BASED_GATE=off
  [ "${status}" -eq 0 ] || return 1
  oc '"code":"DATA-102"' "${output}" || return 1
  no '"code":"DATA-101"' "${output}" || return 1
}

@test "SAFETY_OVERRIDE_DIR override still honored (regression guard — unchanged pre/post)" {
  local custom="${SANDBOX_HOME}/custom-safety"
  mkdir -p "${custom}"
  : >"${custom}/code-based-gate.authorized"
  run_hook CODE_BASED_GATE=off SAFETY_OVERRIDE_DIR="${custom}"
  [ "${status}" -eq 0 ] || return 1
  oc '"code":"DATA-101"' "${output}" || return 1
}

@test "embedded-python diag log lands under the new \$HOME/.glass-atrium/logs root" {
  run_hook
  [ "${status}" -eq 0 ] || return 1
  # The diag log is the ~/.claude/{data,logs} default that the seam flips to .glass-atrium.
  [[ -f "${SANDBOX_HOME}/.glass-atrium/logs/track-outcome.diag.log" ]] || {
    echo "diag log absent at new root; tree:" >&2
    find "${SANDBOX_HOME}" -name 'track-outcome.diag.log' >&2
    return 1
  }
  # And NOT at the legacy location.
  [[ ! -f "${SANDBOX_HOME}/.claude/logs/track-outcome.diag.log" ]] || return 1
}
