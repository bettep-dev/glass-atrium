#!/usr/bin/env bats
# style-ref-verify.sh — [COMPLETION] style_ref cross-check against the session Read history; an
# unreadable transcript is a loud-fail (exit 5). Hermetic: the hook reads only its stdin payload.

HOOK_SH="${BATS_TEST_DIRNAME}/../style-ref-verify.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
}

# Payload with a style_ref-bearing [COMPLETION] block and transcript_path $1. The path reaches jq and
# the payload the hook on stdin → no argument nears Linux's 128 KiB per-string exec limit.
run_hook() {
  local payload
  payload="$(printf '%s' "${1}" | jq -Rsc --arg m "$(printf '[COMPLETION]\nresult: done\nstyle_ref: hooks/sibling.sh\n[/COMPLETION]')" \
    '{last_assistant_message: $m, transcript_path: .}')"
  run bash "${HOOK_SH}" <<<"${payload}"
}

# ~160 KiB of duplicated tpath-key lines → a multi-write writer, which races a reader that stops at line 1
# at any size; a writer left with a write dies of SIGPIPE, which pipefail turns into an ERR-trap internal error.
@test "an unreadable transcript loud-fails with no internal error when its reported path exceeds the pipe buffer" {
  local padding
  padding="$(seq -f '@@tpath@@padding line %05g of a duplicated tpath key' 1 3000)"
  run_hook "${BATS_TEST_TMPDIR}/absent-transcript.jsonl
${padding}"

  [[ "${status}" -eq 5 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"LOUD-FAIL: transcript precondition unmet (reason=unreadable, tpath=${BATS_TEST_TMPDIR}/absent-transcript.jsonl)"* ]] \
    || { echo "${output}"; return 1; }
  [[ "${output}" != *"internal error"* ]] || { echo "${output}"; return 1; }
}
