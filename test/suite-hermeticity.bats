#!/usr/bin/env bats
# Suite-level hermetic baseline pin for this bats directory.
#
# Fails when setup_suite.bash is not auto-loaded (a bats action default below 1.7, a moved
# file), so the hermetic baseline can never be silently unpinned by silent discovery.

setup() {
  load 'lib/bats-hermetic-env'
}

@test "setup_suite discovery sentinel is exported" {
  [[ "${GA_BATS_SUITE_SETUP:-}" == "1" ]]
}

@test "hook kill switches are cleared from the suite environment" {
  ga_bats_assert_hermetic
}

# Runs the seat against the given bats tmpdirs inside `run`'s subshell, then reports the cwd
# it left, so neither the cd nor the unset switches reach this test's own shell.
seat_in() {
  BATS_RUN_TMPDIR="$1" BATS_SUITE_TMPDIR="$2" ga_bats_hermetic_env && pwd -P
}

# The empty row keeps the real run root on purpose: this test's cwd already sits under it,
# so only an explicit empty check can refuse — `cd ""` is a no-op success in bash.
@test "the scratch-cwd seat enters BATS_SUITE_TMPDIR and refuses a suite dir it cannot enter or that sits outside BATS_RUN_TMPDIR" {
  local run_dir="${BATS_TEST_TMPDIR:?}/run" outside="${BATS_TEST_TMPDIR:?}/outside"
  mkdir -p "${run_dir}/suite" "${outside}"
  local entered
  entered="$(cd -P -- "${run_dir}/suite" && pwd)"

  local rows=(
    "enters the suite dir|${run_dir}|${run_dir}/suite|0|${entered}"
    "suite dir missing|${run_dir}|${run_dir}/absent|1|refusing the run"
    "suite dir outside the run root|${run_dir}|${outside}|1|refusing the run"
    "suite dir empty|${BATS_RUN_TMPDIR:?}||1|refusing the run"
    "run root unset||${run_dir}/suite|1|refusing the run"
  )
  local row name run_tmpdir suite_tmpdir want_status want_text
  for row in "${rows[@]}"; do
    IFS='|' read -r name run_tmpdir suite_tmpdir want_status want_text <<<"${row}"
    run seat_in "${run_tmpdir}" "${suite_tmpdir}"
    [[ "${status}" -eq "${want_status}" && "${output}" == *"${want_text}"* ]] || {
      printf '%s: status %s, output: %s\n' "${name}" "${status}" "${output}"
      return 1
    }
  done
}
