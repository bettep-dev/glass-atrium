#!/usr/bin/env bats
# pipe-drain.bats — unit pin for `drain_after`: under pipefail, a pipe-end reader wrapped in it
# yields its OWN exit status and output even when the writer still has data past the 64 KiB pipe
# capacity — the size at which an early-exiting reader otherwise turns its verdict into SIGPIPE 141.

LIB_SH="${BATS_TEST_DIRNAME}/../lib/pipe-drain.sh"

setup() {
  [[ -f "${LIB_SH}" ]] || skip "pipe-drain.sh not found: ${LIB_SH}"
}

# Pipes a ~170 KiB text whose first line is `needle-line` into `drain_after "$@"` in a strict-mode
# child shell (reader stderr discarded), so the parent's own stdin never reaches the drain.
run_drained_reader() {
  run bash -c '
    set -Eeuo pipefail
    lib="$1"
    shift
    source "${lib}"
    { printf "needle-line\n"; seq -f "filler line %05g of ordinary text" 1 5000; } | drain_after "$@" 2>/dev/null
  ' _ "${LIB_SH}" "$@"
}

@test "a reader that stops early yields its own status and output, never the writer's SIGPIPE" {
  local row name expected_status expected_output reader_argv
  local -a reader
  # name | expected status | expected stdout | reader argv (space-separated)
  local rows=(
    "match on line 1|0||grep -q needle-line"
    "no match anywhere|1||grep -q absent-word"
    "reader error|2||grep -qE ("
    "first-line extraction|0|needle-line|head -1"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name expected_status expected_output reader_argv <<<"${row}"
    IFS=' ' read -r -a reader <<<"${reader_argv}"
    run_drained_reader "${reader[@]}"
    [[ "${status}" -eq "${expected_status}" ]] || {
      echo "${name}: expected status ${expected_status}, got ${status}: ${output}"
      return 1
    }
    [[ "${output}" == "${expected_output}" ]] || {
      echo "${name}: expected output [${expected_output}], got [${output}]"
      return 1
    }
  done
}
