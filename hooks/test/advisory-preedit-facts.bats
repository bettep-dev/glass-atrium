#!/usr/bin/env bats
# advisory-preedit-facts.sh — Stop-time advisory naming an edited file that carries no Pre-Edit Facts
# declaration. Hermetic: the transcript is a per-test JSONL fixture; the hook reads only stdin and it.

HOOK_SH="${BATS_TEST_DIRNAME}/../advisory-preedit-facts.sh"
ADVISORY_PHRASE='ADVISORY: edited without a Pre-Edit Facts declaration'

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  TRANSCRIPT="${BATS_TEST_TMPDIR}/transcript.jsonl"
}

# One assistant entry carrying a single Edit tool_use on $1, and no declaration.
write_edit_transcript() {
  jq -cn --arg fp "${1}" \
    '{type: "assistant", message: {content: [{type: "tool_use", name: "Edit", input: {file_path: $fp}}]}}' \
    >"${TRANSCRIPT}"
}

run_hook() {
  run bash -c 'jq -cn --arg t "$1" "{transcript_path: \$t}" | bash "$2" 2>&1' _ "${TRANSCRIPT}" "${HOOK_SH}"
}

# ~160 KiB of duplicated files-key lines: above the 64 KiB pipe capacity, so a reader that stops at
# line 1 leaves its writer to die of SIGPIPE, which pipefail turns into an ERR-trap internal error.
@test "an undeclared edit is reported with no internal error when its extracted field exceeds the pipe buffer" {
  local padding
  padding="$(seq -f '@@files@@padding line %05g of a duplicated files key' 1 3000)"
  write_edit_transcript "/work/repo/edited.sh
${padding}"

  run_hook
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"${ADVISORY_PHRASE}: edited.sh ("* ]] || { echo "${output}"; return 1; }
  [[ "${output}" != *"internal error"* ]] || { echo "${output}"; return 1; }
}
