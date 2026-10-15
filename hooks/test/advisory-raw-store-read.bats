#!/usr/bin/env bats
# advisory-raw-store-read.sh — PreToolUse(Bash) raw-store read advisory: a command referencing
# wiki/raw/ gets a note and exits 0. Direct-invocation probe (the hook reads only stdin).
#
# Run via: bats hooks/test/advisory-raw-store-read.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3 (field extraction; absent → the hook
# fails open silent, so the probe would see no note — skip rather than mis-assert).
#
# Hermetic strategy: WIKI_ROOT and the durable record point into the per-test temp dir, so no real
# ~/.glass-atrium or ~/.claude state is touched.

HOOK_SH="${BATS_TEST_DIRNAME}/../advisory-raw-store-read.sh"

setup() {
  [[ -x "${HOOK_SH}" ]] || skip "hook not found or not executable: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  export WIKI_ROOT="${BATS_TEST_TMPDIR}/wiki"
  export RAW_STORE_READ_ADVISORY_FIRED_LOG="${BATS_TEST_TMPDIR}/raw-read-fired.log"
}

# ~160 KiB of JSON-escaped lines: above the 64 KiB pipe capacity, so a reader that stops at a
# line-1 match leaves its writer to die of SIGPIPE, which pipefail reports as "no match".
pipe_overflow_padding() {
  seq -f 'padding line %05g of an ordinary build log' 1 4000 | awk '{ printf "%s\\n", $0 }'
}

@test "a raw-store path on line 1 of a command larger than the pipe buffer still gets the note" {
  local padding
  padding="$(pipe_overflow_padding)"
  run bash "${HOOK_SH}" <<<"{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"cat ${WIKI_ROOT}/raw/page.md\\n${padding}\"}}"
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"[raw-store-read-advisory]"* ]] || { echo "${output}"; return 1; }
}
