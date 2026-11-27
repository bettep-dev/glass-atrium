#!/usr/bin/env bats
# shellcheck disable=SC2030,SC2031,SC2154  # BATS_* and run results are set by bats
# bounded-wait.bats — unit pin for `run_with_deadline`, the hook's bounded wait without a timeout binary:
# a command that ends in time keeps its own status, output and stdin; one still running at the deadline
# is killed with its whole process tree and reported as 124; no run leaves a process behind.
#
# Run via: bats hooks/test/bounded-wait.bats
# Requires: bats, bash 3.2+, pgrep

bats_require_minimum_version 1.5.0

LIB_SH="${BATS_TEST_DIRNAME}/../lib/bounded-wait.sh"
# a deadline no other process on the machine sleeps for → its watchdog sleep is findable by command line
SPARE_DEADLINE=287

# Runs `run_with_deadline "$@"` in a strict-mode child shell, the stdin file given as $1 on its stdin.
run_bounded() {
  local stdin_file="$1"
  shift
  # shellcheck disable=SC2016  # the inner script expands its own arguments
  run --separate-stderr bash -c '
    set -Eeuo pipefail
    trap "echo ERR-TRAP >&2" ERR
    source "$1"
    shift
    child_pid_file="$1"
    shift
    hang() {
      # off the capture pipe → a leaked child fails the check below instead of holding bats open
      sleep 300 </dev/null >/dev/null 2>&1 &
      printf "%s\n" "$!" >"${child_pid_file}"
      wait
    }
    # ends after the watchdog is armed → its cancel path runs, not only an early TERM
    slow_cat() {
      sleep 0.5
      cat
    }
    fail_fast() { return 7; }
    run_with_deadline "$@" || exit "$?"
  ' _ "${LIB_SH}" "${BATS_TEST_TMPDIR}/child.pid" "$@" <"${stdin_file}"
}

# 0 when no process runs `sleep <seconds>` any more
has_no_sleep() {
  ! pgrep -f "^sleep $1\$" >/dev/null
}

@test "a command that ends before the deadline keeps its own status, its output and the caller's stdin, and leaves no watchdog behind" {
  local row name command expected_status expected_output started elapsed
  printf 'stdin line one\nstdin line two\n' >"${BATS_TEST_TMPDIR}/stdin"
  # name | command | expected status | expected stdout
  local rows=(
    "returns in time, reading stdin|slow_cat|0|stdin line one
stdin line two"
    "fails fast|fail_fast|7|"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r -d '' name command expected_status expected_output <<<"${row}" || true
    expected_output="${expected_output%$'\n'}"
    started="${SECONDS}"
    run_bounded "${BATS_TEST_TMPDIR}/stdin" "${SPARE_DEADLINE}" "${command}"
    elapsed=$((SECONDS - started))
    [[ "${status}" -eq "${expected_status}" && "${output}" == "${expected_output}" && -z "${stderr}" && "${elapsed}" -lt 5 ]] || {
      echo "${name}: status=${status} elapsed=${elapsed}s output=${output} stderr=${stderr}"
      return 1
    }
    has_no_sleep "${SPARE_DEADLINE}" || {
      echo "${name}: the watchdog's sleep outlived the call"
      return 1
    }
  done
}

@test "a command still running at the deadline is killed with its children and reported as 124" {
  local started elapsed child_pid
  : >"${BATS_TEST_TMPDIR}/stdin"
  started="${SECONDS}"
  run_bounded "${BATS_TEST_TMPDIR}/stdin" 1 hang
  elapsed=$((SECONDS - started))
  [[ "${status}" -eq 124 && -z "${stderr}" && "${elapsed}" -lt 5 ]] || {
    echo "status=${status} elapsed=${elapsed}s output=${output} stderr=${stderr}"
    return 1
  }
  child_pid="$(<"${BATS_TEST_TMPDIR}/child.pid")"
  if kill -0 "${child_pid}" 2>/dev/null; then
    echo "the hung command's child ${child_pid} outlived the deadline"
    kill -KILL "${child_pid}" 2>/dev/null || true
    return 1
  fi
}
