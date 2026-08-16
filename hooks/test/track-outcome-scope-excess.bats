#!/usr/bin/env bats
# track-outcome-scope-excess.bats — the recorder's scope-excess leg: authored paths compared
# against the delegation's record-0 `[SCOPE] files=` declaration.
#
# Pins the detection itself plus the four exemptions that keep it off compliant work: the
# code-task_type restriction of the files: leg (a review row lists paths it READ), the shared
# tool-artifact shape, the companion test file, and the disclosure-gated standing-rule carve-out
# (closed vocabulary AND the path named — a blanket sentence exempts nothing).
#
# Isolation: the sibling recorder harness verbatim — HOME sandboxed, dual-write stubbed by a PATH
# python3 shim, spooled envelope as the assertion surface. No live-install path is referenced.

HOOK_SH="${TRACK_OUTCOME_SH:-${BATS_TEST_DIRNAME}/../track-outcome.sh}"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  REAL_PY3="$(command -v python3)"
  SE_TMP="$(mktemp -d -t track-se.XXXXXX)"
  AGENT_TYPE="glass-atrium-dev-shell"
  AGENT_ID="seaid${$}x${RANDOM}"
  SESSION_ID="sess-se-$$-${RANDOM}"

  SANDBOX_HOME="${SE_TMP}/home"
  TRANSCRIPT_DIR="${SANDBOX_HOME}/.claude/projects/proj/${SESSION_ID}/subagents"
  mkdir -p "${TRANSCRIPT_DIR}" "${SANDBOX_HOME}/.claude/logs"
  SPOOL_DIR="${SANDBOX_HOME}/.claude/data/outcome-spool"
  PAYLOAD_FILE="${SE_TMP}/payload.json"

  SHIM_DIR="${SE_TMP}/bin"
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
  [[ -n "${SE_TMP:-}" && -d "${SE_TMP}" ]] && rm -rf -- "${SE_TMP}" || true
}

# $1 = record-0 delegation prompt, $2 = the completion block text,
# $3 = optional child-authored text placed between them.
write_transcript() {
  local tfile="${TRANSCRIPT_DIR}/agent-${AGENT_ID}.jsonl"
  jq -nc --arg t "${1}" '{type:"user", message:{role:"user", content:$t}}' >"${tfile}"
  jq -nc '{type:"assistant", message:{role:"assistant", content:[{type:"tool_use", id:"toolu_se1", name:"Edit", input:{}}]}}' \
    >>"${tfile}"
  if [[ -n "${3:-}" ]]; then
    jq -nc --arg t "${3}" '{type:"assistant", message:{role:"assistant", content:[{type:"text", text:$t}]}}' \
      >>"${tfile}"
  fi
  jq -nc --arg t "${2}" '{type:"assistant", message:{role:"assistant", content:[{type:"text", text:$t}]}}' \
    >>"${tfile}"
}

# A silent verdict is only meaningful once the row itself was recorded — an absent spool would
# otherwise let every negative fixture pass by writing nothing at all.
refute_scope_excess() {
  [[ "$(spooled_field result)" == "done" ]] || { echo "row not recorded — silence is vacuous" >&2; return 1; }
  [[ "$(spooled_field review_flag_reasons)" != *"scope-excess"* ]]
}

completion_block() {
  printf '%s\n' '[COMPLETION]'
  printf '%s\n' "$@"
  printf '%s\n' '[/COMPLETION]'
}

run_hook() {
  run env \
    HOME="${SANDBOX_HOME}" \
    PATH="${SHIM_DIR}:${PATH}" \
    CLAUDE_GATE_INFLIGHT="" \
    T9_CORRECTION_DETECTION="false" \
    OUTCOME_SPOOL_DIR="${SPOOL_DIR}" \
    bash -c '"$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

spooled_field() {
  local f
  f="$(find "${SPOOL_DIR}" -type f 2>/dev/null | head -1)"
  [[ -n "${f}" ]] || return 1
  jq -r ".outcome.${1} // \"\"" "${f}"
}

@test "code row authoring a path outside the declaration → scope-excess" {
  write_transcript '[SCOPE] files=hooks/a.sh · deliverable=fix · out=none' \
    "$(completion_block 'result: done' 'task_type: bug-fix' 'metric_pass: true' 'confidence: high' \
      'files: hooks/a.sh, hooks/undeclared.sh' 'style_ref: hooks/a.sh' 'summary: fixed a')"
  run_hook
  [[ "$(spooled_field review_flag_reasons)" == *"scope-excess"* ]] \
    || { echo "no scope-excess: $(spooled_field review_flag_reasons)" >&2; return 1; }
  [[ "$(spooled_field metric_pass)" == "true" ]] \
    || { echo "writer field mutated" >&2; return 1; }
}

@test "separator-less declaration of the authored path → silent (no false excess)" {
  # The shape the two spawn advisories used to print. Parsed as one entry it ended `out=none`, so the
  # declared path missed and this compliant row was flagged — the accusation the parser now refuses.
  write_transcript '[SCOPE] files=hooks/a.sh deliverable=bug-fix out=none' \
    "$(completion_block 'result: done' 'task_type: bug-fix' 'metric_pass: true' 'confidence: high' \
      'files: hooks/a.sh' 'style_ref: hooks/a.sh' 'summary: fixed a')"
  run_hook
  refute_scope_excess || { echo "false fire on a separator-less declaration" >&2; return 1; }
}

@test "review row listing read-only paths → silent (files: leg is code-task_type only)" {
  write_transcript '[SCOPE] files=hooks/a.sh · deliverable=verdict · out=none' \
    "$(completion_block 'result: done' 'task_type: review' 'metric_pass: true' 'confidence: high' \
      'files: hooks/x.sh, hooks/y.sh, hooks/z.sh' 'summary: reviewed three files')"
  run_hook
  refute_scope_excess || { echo "false fire on a review row" >&2; return 1; }
}

@test "delegation with no [SCOPE] declaration → comparison skipped (fail-open)" {
  write_transcript 'plain delegation prompt with no declaration' \
    "$(completion_block 'result: done' 'task_type: bug-fix' 'metric_pass: true' 'confidence: high' \
      'files: hooks/anything.sh' 'style_ref: hooks/a.sh' 'summary: undeclared delegation')"
  run_hook
  refute_scope_excess || { echo "fired without a declaration" >&2; return 1; }
}

@test "companion test file + regenerated manifest → silent (artifact and test-sibling exemptions)" {
  write_transcript '[SCOPE] files=hooks/a.sh · deliverable=fix · out=none' \
    "$(completion_block 'result: done' 'task_type: feature' 'metric_pass: true' 'confidence: high' \
      'files: hooks/a.sh, hooks/test/a.bats, manifest.json' 'style_ref: hooks/a.sh' \
      'summary: implementation with its test')"
  run_hook
  refute_scope_excess || { echo "false fire on compliant co-deliverables" >&2; return 1; }
}

@test "standing-rule side edit disclosed with the path named → silent" {
  write_transcript '[SCOPE] files=hooks/a.sh · deliverable=fix · out=none' \
    "$(completion_block 'result: done' 'task_type: refactor' 'metric_pass: true' 'confidence: high' \
      'files: hooks/a.sh, hooks/side.sh' 'style_ref: hooks/a.sh' \
      'concerns: removed a 0-consumer export in hooks/side.sh as the standing rule requires' \
      'summary: refactor with a forced side edit')"
  run_hook
  refute_scope_excess || { echo "disclosed standing-rule edit still fired" >&2; return 1; }
}

@test "same side edit with no disclosed rationale → scope-excess" {
  write_transcript '[SCOPE] files=hooks/a.sh · deliverable=fix · out=none' \
    "$(completion_block 'result: done' 'task_type: refactor' 'metric_pass: true' 'confidence: high' \
      'files: hooks/a.sh, hooks/side.sh' 'style_ref: hooks/a.sh' \
      'concerns: nothing in particular' 'summary: refactor with an undisclosed side edit')"
  run_hook
  [[ "$(spooled_field review_flag_reasons)" == *"scope-excess"* ]] \
    || { echo "undisclosed excess went silent" >&2; return 1; }
}

@test "blanket rationale naming no path → scope-excess (per-path disclosure only)" {
  write_transcript '[SCOPE] files=hooks/a.sh · deliverable=fix · out=none' \
    "$(completion_block 'result: done' 'task_type: refactor' 'metric_pass: true' 'confidence: high' \
      'files: hooks/a.sh, hooks/side.sh' 'style_ref: hooks/a.sh' \
      'concerns: some 0-consumer export cleanups were required along the way' \
      'summary: refactor with a blanket rationale')"
  run_hook
  [[ "$(spooled_field review_flag_reasons)" == *"scope-excess"* ]] \
    || { echo "blanket rationale bought an exemption" >&2; return 1; }
}

@test "all three new state-bearing matches miss → the recorder still completes normally" {
  write_transcript '[SCOPE] files=hooks/a.sh' \
    "$(completion_block 'result: done' 'task_type: doc' 'metric_pass: true' 'confidence: high' \
      'summary: no files, no concerns, no code task_type')"
  run_hook
  [[ "${status}" -eq 0 ]] || { echo "recorder exited ${status}: ${output}" >&2; return 1; }
  [[ "$(spooled_field result)" == "done" ]] || { echo "row not recorded" >&2; return 1; }
}

@test "record-0 pin: a wider [SCOPE] the child emitted itself cannot nullify the check" {
  write_transcript '[SCOPE] files=hooks/a.sh · deliverable=fix · out=none' \
    "$(completion_block 'result: done' 'task_type: bug-fix' 'metric_pass: true' 'confidence: high' \
      'files: hooks/a.sh, hooks/undeclared.sh' 'style_ref: hooks/a.sh' 'summary: fixed a')" \
    '[SCOPE] files=hooks/, everything · deliverable=fix · out=none'
  run_hook
  [[ "$(spooled_field review_flag_reasons)" == *"scope-excess"* ]] \
    || { echo "self-nullified by a child-authored declaration" >&2; return 1; }
}

@test "the declaration reaches bash through the emit seam, not a second transcript read" {
  grep -qF 'out(' "${HOOK_SH}" && grep -qF "scope_decl" "${HOOK_SH}" \
    || { echo "no scope_decl emit seam" >&2; return 1; }
  grep -qF 'extract_field scope_decl' "${HOOK_SH}" \
    || { echo "bash leg does not read the emit row" >&2; return 1; }
  ! grep -qF 'scope_decl_from_record0' "${HOOK_SH}" \
    || { echo "bash side re-reads the transcript" >&2; return 1; }
}

@test "honesty label: Write/Edit-authored wording only, and the ④ exemption is marked weaker" {
  grep -qiF 'Write/Edit-AUTHORED excess' "${HOOK_SH}" \
    || { echo "narrow wording missing" >&2; return 1; }
  ! grep -qiF 'detects scope excess' "${HOOK_SH}" \
    || { echo "general 'detects scope excess' claim present" >&2; return 1; }
  grep -qiF 'DISCLOSURE-GATED, NOT verification-gated' "${BATS_TEST_DIRNAME}/../lib/scope-match.sh" \
    || { echo "standing-rule exemption not labelled disclosure-gated" >&2; return 1; }
}
