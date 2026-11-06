#!/usr/bin/env bats
# shellcheck disable=SC2154  # BATS_* come from bats
# deps-preflight-exec-harness.bats — the CI home of deps-preflight-exec-harness.sh's own assertion
# helpers. The harness itself runs on demand only, so these rows pull its helpers out with awk and
# execute them alone, never sourcing the launcher or reaching its live-postgres paths.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
HARNESS="${GA}/test/deps-preflight-exec-harness.sh"

setup() {
  [[ -f "${HARNESS}" ]] || skip "harness not found: ${HARNESS}"
}

# _extract_harness_fns — source the named harness functions into the test shell.
_extract_harness_fns() {
  local fn fn_file
  for fn in "$@"; do
    fn_file="${BATS_TEST_TMPDIR:?}/${fn}.sh"
    awk -v fn="${fn}" 'index($0, fn "() {") == 1 {f = 1} f {print} f && /^}/ {exit}' "${HARNESS}" >"${fn_file}" || return 1
    [[ -s "${fn_file}" ]] || {
      echo "${fn} not found in ${HARNESS}"
      return 1
    }
    # shellcheck source=/dev/null
    source "${fn_file}"
  done
}

@test "scenario_assert checks service-start ordering when a recorder log runs past one pipe buffer" {
  _extract_harness_fns pass fail assert_eq assert_contains assert_absent counters_ok scenario_assert
  local filler
  filler="$(awk 'BEGIN { for (i = 0; i < 100000; i++) print "filler-" i }')"
  # name|log head (\n-separated)|expected verdict line
  local rows=(
    'wait after start|pg_service\npg_wait_ready|PASS  readiness wait runs AFTER service start'
    'wait before start|pg_wait_ready\npg_service|FAIL  readiness wait ordering'
  )
  local row name head want rec out
  for row in "${rows[@]}"; do
    IFS='|' read -r name head want <<<"${row}"
    # the match first, then ~1 MB: an early-exit reader leaves its writer mid-write
    rec="$(printf '%b\nkeg_inject:18\nkeg_inject:node@24' "${head}")"$'\n'"${filler}"
    # the harness's own runtime — pipefail on, errexit and the ERR trap off — scoped to a subshell
    out="$(
      set +eE -o pipefail
      trap - ERR
      # shellcheck disable=SC2034  # the extracted pass/fail count into these
      FAILS=0 PASSES=0
      scenario_assert "${name}" "scroll" 0 "${rec}" skips 18 scroll
    )"
    [[ "${out}" == *"${want}"* ]] || {
      echo "${name}: verdict '${want}' missing from: ${out}"
      return 1
    }
  done
}
