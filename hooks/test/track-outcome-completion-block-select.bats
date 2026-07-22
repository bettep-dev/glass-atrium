#!/usr/bin/env bats
# track-outcome-completion-block-select.bats — tier-1 [COMPLETION] block SELECTION + KNOWN_FIELDS
# folding guard for track-outcome.sh.
#
# Contract pinned:
#  #25 — validity-aware LAST-preference over ALL tier-1 matches. A subagent that quotes the
#        emit-format template (whose [COMPLETION] block carries a pipe-joined
#        `result: done|...|fail` placeholder) BEFORE its real block must NOT have the template
#        shadow the writer signal. A bare re.search binds the FIRST match → the template's
#        result is not a single valid token → the row synthesizes and the writer signal is lost.
#        (a) template-then-real  → parse_tier=1, result=done (last-preference alone suffices)
#        (b) real-then-template  → parse_tier=1, result=done (the LAST match is the invalid
#            template, so the validity-aware reverse-scan MUST fall back to the earlier valid
#            block — the regression a naive last-match-only fix would fail).
#  #35 — qa_score + concerns are in KNOWN_FIELDS, so an emitted `qa_score:`/`concerns:` line
#        starts its own field instead of folding into the preceding value (white-box parser test).
#
# The #25 cases run DB-free: PG is fail-opened via PGHOST and the parse decision is read off the
# stderr diagnostic channel (the DIAG parse_tier line + the auto-generated record marker carrying
# `"result":"done"`), mirroring the [inline] cases in track-outcome-schema-mode-completion.bats.
# result=done is the distinguishing recovery signal — the synthesis branch can only ever emit
# done_with_concerns (or blocked), never done. HOME is sandboxed so the transcript resolution and
# the diag log stay inside the test temp dir.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/track-outcome.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  BS_TMP="$(mktemp -d)"
  SANDBOX_HOME="${BS_TMP}/home"
  mkdir -p "${SANDBOX_HOME}/.glass-atrium/logs"
  PAYLOAD_FILE="${BS_TMP}/payload.json"

  # The canonical emit-format template block (pipe-joined placeholders) an agent might quote.
  TEMPLATE_BLOCK="$(printf '%s\n' \
    '[COMPLETION]' \
    'result: done|done_with_concerns|blocked|needs_context|fail' \
    'task_type: bug-fix|feature|refactor|research|plan|review|diagnosis|doc|cleanup' \
    'metric_pass: true|false' \
    'confidence: high|medium|low' \
    'summary: 1-line summary' \
    '[/COMPLETION]')"
  # The real writer block (single valid tokens).
  REAL_BLOCK="$(printf '%s\n' \
    '[COMPLETION]' \
    'result: done' \
    'task_type: bug-fix' \
    'metric_pass: true' \
    'confidence: high' \
    'summary: the real deliverable' \
    '[/COMPLETION]')"
}

teardown() {
  # `if` (not `[[ ]] && cmd`) so a false guard returns 0 — a setup-skip (BS_TMP unset) must not
  # turn the clean skip into a non-zero teardown exit (which bats reports as `not ok`).
  if [[ -n "${BS_TMP:-}" && -d "${BS_TMP}" ]]; then
    rm -rf "${BS_TMP}"
  fi
}

# bats 1.13 checks only the LAST command's status, so a bare intermediate `[[ ]]` assertion is
# silently ignored (a false one never fails the test). oc/no echo a diagnostic + return non-zero
# so each caller's `|| return 1` aborts the test AT the failing assertion.
oc() { [[ "${2}" == *"${1}"* ]] || { printf 'assert-contains FAILED: [%s] absent from output:\n%s\n' "${1}" "${2}" >&2; return 1; }; }
no() { [[ "${2}" != *"${1}"* ]] || { printf 'assert-omits FAILED: [%s] present in output:\n%s\n' "${1}" "${2}" >&2; return 1; }; }

# DB-free hook driver: the combined message in last_assistant_message, PG fail-opened (PGHOST →
# nonexistent socket), stderr merged into stdout. $1 = last_assistant_message.
run_hook_dbfree() {
  jq -nc --arg m "${1}" '{
    hook_event_name: "SubagentStop",
    agent_type: "glass-atrium-dev-shell",
    agent_id: "bsagent01",
    session_id: "sess-bs-1",
    last_assistant_message: $m,
    messages: [
      {role: "user", content: "run the work"},
      {role: "assistant", content: [{type: "tool_use", name: "Edit", input: {}}]}
    ]
  }' >"${PAYLOAD_FILE}"
  run env \
    HOME="${SANDBOX_HOME}" \
    PGHOST="/nonexistent-socket-xyzzy" \
    CLAUDE_GATE_INFLIGHT="" \
    bash -c 'bash "$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

@test "#25(a) template-quote BEFORE the real block does not shadow the writer signal (result=done)" {
  run_hook_dbfree "Here is the format I use:"$'\n\n'"${TEMPLATE_BLOCK}"$'\n\n'"Actual result:"$'\n\n'"${REAL_BLOCK}"
  [ "${status}" -eq 0 ] || return 1
  # The real block (last, valid) is selected — NOT the leading template placeholder.
  oc "parse_tier=1" "${output}" || return 1
  oc '"result":"done"' "${output}" || return 1
  # A shadowed template would leave an invalid result → synthesis branch.
  no "attribution=completion-synthesized" "${output}" || return 1
}

@test "#25(b) real block THEN a trailing template quote still selects the real block (validity reverse-scan)" {
  run_hook_dbfree "${REAL_BLOCK}"$'\n\n'"(for reference the template is:)"$'\n\n'"${TEMPLATE_BLOCK}"
  [ "${status}" -eq 0 ] || return 1
  # The LAST tier-1 match is the invalid template; a naive last-match-only fix would synthesize.
  # The validity-aware reverse-scan MUST fall back to the earlier valid block → result=done.
  oc "parse_tier=1" "${output}" || return 1
  oc '"result":"done"' "${output}" || return 1
  no "attribution=completion-synthesized" "${output}" || return 1
}

@test "#25 single invalid (template-only) block still synthesizes — no crash, behavior preserved" {
  # No valid earlier match exists, so the last (invalid) block is kept and the row synthesizes,
  # exactly as before the fix. Guards the m_tier1/m_tier2 rebind (the downstream _block_text
  # grader-body extraction would NameError if either were left unbound).
  run_hook_dbfree "${TEMPLATE_BLOCK}"
  [ "${status}" -eq 0 ] || return 1
  no "Traceback" "${output}" || return 1
  no "NameError" "${output}" || return 1
  oc "attribution=completion-synthesized" "${output}" || return 1
}

@test "#35 qa_score / concerns are KNOWN_FIELDS — a qa_score line does not fold into summary" {
  # White-box: exec the hook's embedded parser prefix (KNOWN_FIELDS + parse_completion_body live
  # above the stdin json.load) and assert a qa_score line starts its own field. Reads the ACTUAL
  # hook source (no duplication) so it tracks the real KNOWN_FIELDS set.
  run python3 - "${HOOK_SH}" <<'PY'
import sys, re
src = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r"<<'PYEOF'\n(.*?)\nPYEOF", src, re.DOTALL)
assert m, "PYEOF heredoc not found"
prefix = m.group(1).split('\ntry:\n    d = json.load(sys.stdin)')[0]
ns = {}
exec(compile(prefix, 'embedded', 'exec'), ns)
parsed = ns['parse_completion_body'](
    "result: done\nsummary: CLEANSUMMARY\nqa_score: cov=4,ins=4,instr=4,clar=4\nlesson: keep")
assert parsed.get('summary') == 'CLEANSUMMARY', repr(parsed.get('summary'))
assert parsed.get('qa_score') == 'cov=4,ins=4,instr=4,clar=4', repr(parsed.get('qa_score'))
assert 'qa_score' in ns['KNOWN_FIELDS'], 'qa_score not in KNOWN_FIELDS'
assert 'concerns' in ns['KNOWN_FIELDS'], 'concerns not in KNOWN_FIELDS'
print('OK')
PY
  [ "${status}" -eq 0 ] || return 1
  [[ "${output}" == *"OK"* ]] || return 1
}
