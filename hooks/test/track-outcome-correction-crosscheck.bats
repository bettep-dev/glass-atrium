#!/usr/bin/env bats
# track-outcome-correction-crosscheck.bats — DSH-C08: the transcript correction detector runs as an
# always-on cross-check, gated on the feature flag alone.
#
# Contract pinned:
#  * The SCAN runs whenever T9_CORRECTION_DETECTION=true, whether or not the agent emitted a
#    correction field. The fallback CAPTURE keeps its own agent-emitted-nothing guard, so T9_STAGE1 /
#    T9_NEW_COUNT still mean "the fallback capture applied" and their three consumers (capture branch,
#    SIG_EMIT gate, SIG_DELTA numeric delta) behave exactly as under the old conjunction.
#  * The agent's emitted correction fields are authoritative — the detector never overwrites them,
#    including the correction-signal numeric delta (the overwrite a naive un-gating would introduce).
#  * A verdict that contradicts an agent-emitted correction stamps the `correction-disagreement`
#    review-flag reason. It never fires on the no-emit fallback path (no claim to disagree with) and
#    never fires on a scan that reached no verdict (transcript unavailable / skipped before the regex).
#
# Isolation: sandboxed HOME, dual-write stubbed by a PATH python3 shim that exits non-zero for the
# helper only (the detector still runs on real python3), spooled envelope as the assertion surface —
# the same harness as track-outcome-flag-reasons.bats.

HOOK_SH="${TRACK_OUTCOME_SH:-${BATS_TEST_DIRNAME}/../track-outcome.sh}"
REASONS_LIB="${BATS_TEST_DIRNAME}/../lib/review-flag-reasons.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  REAL_PY3="$(command -v python3)"
  CC_TMP="$(mktemp -d -t track-cc.XXXXXX)"
  AGENT_TYPE="glass-atrium-dev-shell"
  AGENT_ID="ccaid${$}x${RANDOM}"
  SESSION_ID="sess-cc-$$-${RANDOM}"

  SANDBOX_HOME="${CC_TMP}/home"
  PROJECT_DIR="${CC_TMP}/proj"
  mkdir -p "${SANDBOX_HOME}/.claude/logs" "${PROJECT_DIR}"
  SPOOL_DIR="${SANDBOX_HOME}/.claude/data/outcome-spool"
  PAYLOAD_FILE="${CC_TMP}/payload.json"
  PARENT_TRANSCRIPT="${PROJECT_DIR}/parent.jsonl"
  # Per-session detector cache lives under TMPDIR — isolate it so one test cannot serve another a
  # cached resolve of a different transcript.
  CACHE_TMP="${CC_TMP}/cache"
  mkdir -p "${CACHE_TMP}"

  SHIM_DIR="${CC_TMP}/bin"
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
}

teardown() {
  if [[ -n "${CC_TMP:-}" && -d "${CC_TMP}" ]]; then
    rm -rf -- "${CC_TMP}"
  fi
}

# bats checks only the LAST command's status, so a bare intermediate assertion is silently ignored.
# Each helper echoes a diagnostic and returns non-zero so the caller's `|| return 1` aborts AT the
# failing assertion.
eq() { [[ "${2}" == "${1}" ]] || { printf 'assert-eq FAILED: expected [%s], got [%s]\n' "${1}" "${2}" >&2; return 1; }; }
oc() { [[ "${2}" == *"${1}"* ]] || { printf 'assert-contains FAILED: [%s] absent from:\n%s\n' "${1}" "${2}" >&2; return 1; }; }
no() { [[ "${2}" != *"${1}"* ]] || { printf 'assert-omits FAILED: [%s] present in:\n%s\n' "${1}" "${2}" >&2; return 1; }; }

# $1 = last user message text, $2 = age in hours (0 = now).
write_parent_transcript() {
  "${REAL_PY3}" - "${PARENT_TRANSCRIPT}" "${1}" "${2:-0}" <<'PY'
import json, sys
from datetime import datetime, timezone, timedelta
path, text, age_h = sys.argv[1], sys.argv[2], float(sys.argv[3])
ts = (datetime.now(timezone.utc) - timedelta(hours=age_h)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
rows = [
    {"type": "user", "message": {"role": "user", "content": "the original delegation"},
     "timestamp": ts},
    {"type": "assistant", "message": {"role": "assistant",
                                      "content": [{"type": "text", "text": "working on it"}]}},
    {"type": "user", "message": {"role": "user", "content": text}, "timestamp": ts},
]
with open(path, "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

# $1 = the [COMPLETION] block, $2 = transcript path ('' → omit the key entirely).
write_payload() {
  jq -nc --arg m "${1}" --arg tp "${2-${PARENT_TRANSCRIPT}}" --arg aid "${AGENT_ID}" \
    --arg agent "${AGENT_TYPE}" --arg sess "${SESSION_ID}" '{
    hook_event_name: "SubagentStop",
    agent_type: $agent,
    agent_id: $aid,
    session_id: $sess,
    last_assistant_message: $m,
    messages: [
      {role: "user", content: "do the work"},
      {role: "assistant", content: [{type: "tool_use", name: "Edit", input: {}}]}
    ]
  } + (if $tp == "" then {} else {transcript_path: $tp} end)' >"${PAYLOAD_FILE}"
}

run_hook() {
  run env \
    HOME="${SANDBOX_HOME}" \
    PATH="${SHIM_DIR}:${PATH}" \
    TMPDIR="${CACHE_TMP}" \
    CLAUDE_GATE_INFLIGHT="" \
    OUTCOME_SPOOL_DIR="${SPOOL_DIR}" \
    bash -c '"$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

spooled_field() {
  local f
  f="$(find "${SPOOL_DIR}" -type f 2>/dev/null | head -1)"
  [[ -n "${f}" ]] || { printf 'no spooled envelope under %s\n' "${SPOOL_DIR}" >&2; return 1; }
  jq -r ".outcome.${1} // \"\"" "${f}"
}

spooled_signal() {
  local f
  f="$(find "${SPOOL_DIR}" -type f 2>/dev/null | head -1)"
  [[ -n "${f}" ]] || { printf 'no spooled envelope under %s\n' "${SPOOL_DIR}" >&2; return 1; }
  # `// ""` is unusable here: jq treats a literal false as falsy, so a false boolean would read as
  # empty and a stage1_matched assertion could never fail.
  jq -r "if (.signals | length) > 0 then (.signals[0].${1}) else \"\" end | tostring" "${f}"
}

spooled_signal_count() {
  local f
  f="$(find "${SPOOL_DIR}" -type f 2>/dev/null | head -1)"
  [[ -n "${f}" ]] || { printf 'no spooled envelope under %s\n' "${SPOOL_DIR}" >&2; return 1; }
  jq -r '.signals | length' "${f}"
}

completion_block() {
  printf '%s\n' '[COMPLETION]'
  printf '%s\n' "$@"
  printf '%s\n' '[/COMPLETION]'
}

# An agent-emitted correction: all three co-emitted elements, revision_count deliberately 2 so a
# detector-sourced prior+1 delta (which would be 1) is distinguishable in the signal envelope.
emitted_correction_block() {
  completion_block 'result: done' 'task_type: cleanup' 'metric_pass: true' 'confidence: high' \
    'revision_count: 2' 'evaluative_signal: -1' \
    'directive_hint: User wanted the gate moved, not the regex removed' \
    'summary: applied the requested rework'
}

clean_block() {
  completion_block 'result: done' 'task_type: cleanup' 'metric_pass: true' 'confidence: high' \
    'summary: tidied the imports'
}

# ---------------------------------------------------------------------------
# AC-1 — the agent-emitted values survive an AGREEING detector unchanged
# ---------------------------------------------------------------------------

@test "agent-emitted correction is persisted verbatim when the detector also matches" {
  write_parent_transcript "다시 해줘 please redo this" 0
  write_payload "$(emitted_correction_block)"
  run_hook
  # SubagentStop has no block channel — the always-run scan must never change the exit status.
  eq "0" "${status}" || return 1
  eq "2" "$(spooled_field revision_count)" || return 1
  eq "-1" "$(spooled_field evaluative_signal)" || return 1
  eq "User wanted the gate moved, not the regex removed" "$(spooled_field directive_hint)" || return 1
  # The numeric delta is the agent's own count — the detector's prior+1 (1) must not reach the sink.
  eq "2" "$(spooled_signal revision_count_delta)" || return 1
  # T9_STAGE1 stays unset off the fallback arm, so the stage-1 consumer reads its old value.
  eq "false" "$(spooled_signal stage1_matched)" || return 1
  no "correction-disagreement" "$(spooled_field review_flag_reasons)" || return 1
}

# ---------------------------------------------------------------------------
# AC-3 — disagreement raises the reason, and still overwrites nothing
# ---------------------------------------------------------------------------

@test "detector verdict contradicting an agent-emitted correction stamps the disagreement reason" {
  write_parent_transcript "진행해" 0
  write_payload "$(emitted_correction_block)"
  run_hook
  eq "0" "${status}" || return 1
  oc "correction-disagreement" "$(spooled_field review_flag_reasons)" || return 1
  eq "true" "$(spooled_field review_flag)" || return 1
  oc "correction-disagreement: agent-emitted correction not corroborated" "${output}" || return 1
  # ADVISORY: every writer-side correction field is untouched by the flag.
  eq "2" "$(spooled_field revision_count)" || return 1
  eq "-1" "$(spooled_field evaluative_signal)" || return 1
  eq "User wanted the gate moved, not the regex removed" "$(spooled_field directive_hint)" || return 1
  eq "2" "$(spooled_signal revision_count_delta)" || return 1
}

@test "the disagreement fires on every disagreeing fixture, whichever correction field carried it" {
  local emit
  for emit in 'revision_count: 3' 'evaluative_signal: -1' 'directive_hint: User asked for the other approach'; do
    rm -rf -- "${SPOOL_DIR}" "${CACHE_TMP:?}"/*
    write_parent_transcript "계속 진행해 주세요" 0
    write_payload "$(completion_block 'result: done' 'task_type: cleanup' 'metric_pass: true' \
      'confidence: high' "${emit}" 'summary: did the work')"
    run_hook
    oc "correction-disagreement" "$(spooled_field review_flag_reasons)" || return 1
  done
}

# ---------------------------------------------------------------------------
# AC — the no-emit fallback path keeps today's behavior and never disagrees
# ---------------------------------------------------------------------------

@test "no-emit fallback still captures a detector match under the split gate" {
  write_parent_transcript "다시 해줘 please redo this" 0
  write_payload "$(clean_block)"
  run_hook
  eq "1" "$(spooled_field revision_count)" || return 1
  eq "-1" "$(spooled_field evaluative_signal)" || return 1
  eq "" "$(spooled_field directive_hint)" || return 1
  eq "true" "$(spooled_signal stage1_matched)" || return 1
  eq "1" "$(spooled_signal revision_count_delta)" || return 1
  # No agent claim exists on this path, so there is nothing to disagree with.
  no "correction-disagreement" "$(spooled_field review_flag_reasons)" || return 1
}

@test "no-emit with a non-matching transcript records no correction signal and no disagreement" {
  write_parent_transcript "이어서 진행해" 0
  write_payload "$(clean_block)"
  run_hook
  eq "0" "$(spooled_signal_count)" || return 1
  eq "false" "$(spooled_field review_flag)" || return 1
  eq "" "$(spooled_field review_flag_reasons)" || return 1
}

# ---------------------------------------------------------------------------
# AC — continuation-verb precision holds under the always-on gate
# ---------------------------------------------------------------------------

@test "continuation utterances do not fire the detector under the always-on gate" {
  # The detector's precision contract excludes the continuation verbs (진행 / 이어서 / 계속) and the
  # bare `다시` that is not bound to a redo verb. Known limit, out of scope here: the English arm
  # matches `try again` as a whole word, so `try again to continue` fires — a property of the
  # shipped regex, which this task does not alter.
  local utterance
  for utterance in '진행해' '이어서 진행해' '계속' '다시 이어서 진행해 주세요' 'resume' \
    'continue' 'status?' '계속 진행해 주세요'; do
    rm -rf -- "${SPOOL_DIR}" "${CACHE_TMP:?}"/*
    write_parent_transcript "${utterance}" 0
    write_payload "$(clean_block)"
    run_hook
    # 0 matches: no fallback capture, so no correction signal is emitted at all.
    eq "0" "$(spooled_signal_count)" || return 1
    eq "0" "$(spooled_field revision_count)" || return 1
  done
}

# ---------------------------------------------------------------------------
# AC — a scan with NO verdict can never manufacture a disagreement
# ---------------------------------------------------------------------------

@test "an unreadable transcript yields no verdict, so no disagreement reason" {
  write_payload "$(emitted_correction_block)" "${CC_TMP}/absent-parent.jsonl"
  run_hook
  no "correction-disagreement" "$(spooled_field review_flag_reasons)" || return 1
  eq "2" "$(spooled_field revision_count)" || return 1
}

@test "a payload with no transcript at all yields no verdict, so no disagreement reason" {
  write_payload "$(emitted_correction_block)" ""
  run_hook
  no "correction-disagreement" "$(spooled_field review_flag_reasons)" || return 1
}

@test "a scan skipped before the regex (stale utterance) yields no verdict, not a negative one" {
  # 3h-old last user message → the detector's staleness skip fires BEFORE the regex evaluates.
  write_parent_transcript "진행해" 3
  write_payload "$(emitted_correction_block)"
  run_hook
  no "correction-disagreement" "$(spooled_field review_flag_reasons)" || return 1
}

@test "the feature flag still disables the whole pipeline" {
  write_parent_transcript "진행해" 0
  write_payload "$(emitted_correction_block)"
  run env \
    HOME="${SANDBOX_HOME}" \
    PATH="${SHIM_DIR}:${PATH}" \
    TMPDIR="${CACHE_TMP}" \
    CLAUDE_GATE_INFLIGHT="" \
    T9_CORRECTION_DETECTION="false" \
    OUTCOME_SPOOL_DIR="${SPOOL_DIR}" \
    bash -c '"$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
  no "correction-disagreement" "$(spooled_field review_flag_reasons)" || return 1
}

# ---------------------------------------------------------------------------
# White-box — the consumer split and the READ-ONLY posture, on the real source
# ---------------------------------------------------------------------------

@test "the fallback capture keeps its own agent-emitted-nothing guard around T9_STAGE1" {
  # The scan gate names the flag alone; the agent-emitted condition sits on the capture arm, which
  # is what keeps T9_STAGE1 / T9_NEW_COUNT out of the always-run path.
  local scan_gate capture_arm
  scan_gate="$(grep -n 'if \[ "${T9_CORRECTION_DETECTION}" = "true" \]' "${HOOK_SH}")"
  oc 'T9_CORRECTION_DETECTION' "${scan_gate}" || return 1
  no 'AGENT_PROVIDED_CORRECTION' "${scan_gate}" || return 1
  # The T9_STAGE1 assignment is nested inside the agent-emitted-nothing arm.
  capture_arm="$(awk '
    index($0, "${AGENT_PROVIDED_CORRECTION}") && index($0, "-eq 0") { f=1 }
    f { print }
    f && index($0, "T9_STAGE1=") { exit }
  ' "${HOOK_SH}")"
  oc 'T9_STAGE1=$(t9_extract stage1_matched)' "${capture_arm}" || return 1
}

@test "READ-ONLY: the disagreement block assigns only REVIEW_FLAG" {
  local dis_apply
  dis_apply="$(awk '
    index($0, "${AGENT_PROVIDED_CORRECTION}") && index($0, "-eq 1") { f=1 }
    f { print }
    f && $0 == "fi" { exit }
  ' "${HOOK_SH}")"
  oc 'REVIEW_FLAG="true"' "${dis_apply}" || return 1
  oc 'review_flag_add_reason "correction-disagreement"' "${dis_apply}" || return 1
  no 'AGENT_PROVIDED_CORRECTION=' "${dis_apply}" || return 1
  no 'EVALUATIVE_SIGNAL=' "${dis_apply}" || return 1
  no 'DIRECTIVE_HINT=' "${dis_apply}" || return 1
  no 'REVISION_COUNT=' "${dis_apply}" || return 1
  no 'SIG_EMIT=' "${dis_apply}" || return 1
  no 'T9_DETECTOR_VERDICT=' "${dis_apply}" || return 1
}

@test "the disagreement token is stamped by the recorder and declared in the shared registry" {
  grep -qF 'review_flag_add_reason "correction-disagreement"' "${HOOK_SH}" || return 1
  grep -qF 'correction-disagreement' "${REASONS_LIB}"
}
