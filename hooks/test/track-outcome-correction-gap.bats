#!/usr/bin/env bats
# track-outcome-correction-gap.bats — pins the F3 correction-gap loud flag in track-outcome.sh.
#
# Contract pinned (plan clauded-docs/224 T4): the Correction-emission rule requires the agent to
# co-emit all three of revision_count + evaluative_signal=-1 + directive_hint. When an agent emits
# evaluative_signal=-1 but OMITS directive_hint, the correction is lesson-less — the recorder now
# raises a loud aggregation-visible review_flag + a 1-line stderr note so the gap is surfaced. The
# recorder NEVER distills the hint from the user message, so the flag is READ-ONLY vs the correction
# WRITE path (AGENT_PROVIDED_CORRECTION / EVALUATIVE_SIGNAL / DIRECTIVE_HINT / SIG_EMIT untouched).
#
#  #1 gap        — evaluative_signal=-1 + empty directive_hint ⇒ loud correction-gap note fires,
#                  record still auto-generated (flow continues past the flag into the dualwrite).
#  #2 hint       — evaluative_signal=-1 WITH a directive_hint ⇒ no note (3-element co-emission met).
#  #3 neutral    — evaluative_signal=0 ⇒ no note (0 is not a correction).
#  #4 absent     — no evaluative_signal ⇒ no note (absent is not a correction).
#  #5 read-only  — white-box: the gap-flag application block assigns ONLY REVIEW_FLAG and the
#                  correction WRITE anchors survive verbatim (the READ-ONLY invariant).
#
# All cases run DB-free: PG is fail-opened via PGHOST → nonexistent socket and the decision is read
# off the stderr diagnostic channel (the loud note + the DATA-070 auto-generated record marker),
# mirroring track-outcome-completion-block-select.bats / track-outcome-budget-truncation.bats. HOME
# is sandboxed so the transcript resolution and the diag log stay inside the test temp dir.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/track-outcome.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  CG_TMP="$(mktemp -d)"
  SANDBOX_HOME="${CG_TMP}/home"
  mkdir -p "${SANDBOX_HOME}/.claude/logs"
  PAYLOAD_FILE="${CG_TMP}/payload.json"
}

teardown() {
  # `if` (not `[[ ]] && cmd`) so a false guard returns 0 — a setup-skip (CG_TMP unset) must not
  # turn the clean skip into a non-zero teardown exit (which bats reports as `not ok`).
  if [[ -n "${CG_TMP:-}" && -d "${CG_TMP}" ]]; then
    rm -rf "${CG_TMP}"
  fi
}

# bats 1.13 checks only the LAST command's status, so a bare intermediate `[[ ]]` assertion is
# silently ignored (a false one never fails the test). oc/no echo a diagnostic + return non-zero so
# each caller's `|| return 1` aborts the test AT the failing assertion.
oc() { [[ "${2}" == *"${1}"* ]] || { printf 'assert-contains FAILED: [%s] absent from output:\n%s\n' "${1}" "${2}" >&2; return 1; }; }
no() { [[ "${2}" != *"${1}"* ]] || { printf 'assert-omits FAILED: [%s] present in output:\n%s\n' "${1}" "${2}" >&2; return 1; }; }

# DB-free hook driver: a real [COMPLETION] block in last_assistant_message + one tool_use, PG
# fail-opened (PGHOST → nonexistent socket), stderr merged into stdout. $1 = the [COMPLETION] block.
run_hook_dbfree() {
  jq -nc --arg m "${1}" '{
    hook_event_name: "SubagentStop",
    agent_type: "glass-atrium-qa-code-reviewer",
    agent_id: "cgagent01",
    session_id: "sess-cg-1",
    last_assistant_message: $m,
    messages: [
      {role: "user", content: "review it"},
      {role: "assistant", content: [{type: "tool_use", name: "Read", input: {}}]}
    ]
  }' >"${PAYLOAD_FILE}"
  run env \
    HOME="${SANDBOX_HOME}" \
    PGHOST="/nonexistent-socket-xyzzy" \
    CLAUDE_GATE_INFLIGHT="" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

# A [COMPLETION] block carrying evaluative_signal=-1 with NO directive_hint line (the gap shape).
gap_block() {
  printf '%s\n' \
    '[COMPLETION]' \
    'result: done' \
    'task_type: review' \
    'metric_pass: true' \
    'confidence: high' \
    'summary: reviewed the change' \
    'evaluative_signal: -1' \
    '[/COMPLETION]'
}

@test "#1 evaluative_signal=-1 with empty directive_hint fires the correction-gap loud flag" {
  block="$(gap_block)"
  run_hook_dbfree "${block}"
  [ "${status}" -eq 0 ] || return 1
  oc "correction-gap: evaluative_signal=-1 with empty directive_hint" "${output}" || return 1
  # Flow continues past the flag → the record is still auto-generated (READ-ONLY: correction path intact).
  oc '"result":"done"' "${output}" || return 1
  no "Traceback" "${output}" || return 1
}

@test "#2 evaluative_signal=-1 WITH a directive_hint does NOT fire the flag (3-element co-emission met)" {
  block="$(printf '%s\n' \
    '[COMPLETION]' 'result: done' 'task_type: review' 'metric_pass: true' 'confidence: high' \
    'summary: reviewed the change' 'evaluative_signal: -1' \
    'directive_hint: User wanted the API gate moved, not the regex removed' '[/COMPLETION]')"
  run_hook_dbfree "${block}"
  [ "${status}" -eq 0 ] || return 1
  no "correction-gap" "${output}" || return 1
  oc '"result":"done"' "${output}" || return 1
}

@test "#3 evaluative_signal=0 does NOT fire the flag (0 is a neutral signal, not a correction)" {
  block="$(printf '%s\n' \
    '[COMPLETION]' 'result: done' 'task_type: review' 'metric_pass: true' 'confidence: high' \
    'summary: reviewed the change' 'evaluative_signal: 0' '[/COMPLETION]')"
  run_hook_dbfree "${block}"
  [ "${status}" -eq 0 ] || return 1
  no "correction-gap" "${output}" || return 1
}

@test "#4 absent evaluative_signal does NOT fire the flag (absent is not a correction)" {
  block="$(printf '%s\n' \
    '[COMPLETION]' 'result: done' 'task_type: review' 'metric_pass: true' 'confidence: high' \
    'summary: reviewed the change' '[/COMPLETION]')"
  run_hook_dbfree "${block}"
  [ "${status}" -eq 0 ] || return 1
  no "correction-gap" "${output}" || return 1
}

@test "#5 READ-ONLY: the gap-flag block assigns only REVIEW_FLAG and the correction WRITE anchors survive" {
  # White-box on the ACTUAL hook source (no duplication). Extract the gap-flag APPLICATION block
  # (the `"${CORRECTION_HINT_GAP}" -eq 1` if … fi region) and assert it mutates ONLY REVIEW_FLAG —
  # it must never assign the correction WRITE-path vars. index() avoids awk regex-escaping the [[ ]].
  gap_apply="$(awk '
    index($0, "${CORRECTION_HINT_GAP}") && index($0, "-eq 1") { f=1 }
    f { print }
    f && $0 == "fi" { exit }
  ' "${HOOK_SH}")"
  oc 'REVIEW_FLAG="true"' "${gap_apply}" || return 1
  # The block is READ-ONLY vs the correction WRITE path — no assignment to any of these inside it.
  no 'AGENT_PROVIDED_CORRECTION=' "${gap_apply}" || return 1
  no 'EVALUATIVE_SIGNAL=' "${gap_apply}" || return 1
  no 'DIRECTIVE_HINT=' "${gap_apply}" || return 1
  no 'SIG_EMIT=' "${gap_apply}" || return 1
  # The correction WRITE-path anchors remain present verbatim in the full source (not deleted/moved).
  src="$(cat "${HOOK_SH}")"
  oc 'DIRECTIVE_HINT=""' "${src}" || return 1
  oc 'SIG_EMIT=1' "${src}" || return 1
  oc 'AGENT_PROVIDED_CORRECTION=1' "${src}" || return 1
}
