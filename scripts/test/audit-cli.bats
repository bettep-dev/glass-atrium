#!/usr/bin/env bats
# audit-cli.bats — pins the surface scripts/lib/audit-cli.sh gives both auditors.
#
# The relationship asserted is "the two auditors present the SAME command-line surface and differ on
# exactly ONE axis" — whether a bare scope-list run blocks. The flag set, the four exit codes and
# --root validation must answer identically, which is why the cases below drive both scripts from one
# table instead of being written twice: a table that passes for one script and not the other IS the
# drift this lib exists to prevent (--root was validated in one and silently accepted in the other).
#
# The one axis that must NOT converge is pinned on its own: promoting the unpromoted auditor to
# blocking is a governance decision, and an accidental promotion would red the build for work that
# was never gated on it.
#
# Every fixture is written into a per-test temp tree — no repository file is read as a fixture.

ABSORPTION="${BATS_TEST_DIRNAME}/../audit-absorption.sh"
TEST_SMELLS="${BATS_TEST_DIRNAME}/../audit-test-smells.sh"

setup() {
  [[ -f "${ABSORPTION}" && -f "${TEST_SMELLS}" ]] || skip "auditor scripts not found"
  AC_TMP="$(mktemp -d -t audit-cli.XXXXXX)"
}

teardown() {
  [[ -n "${AC_TMP:-}" && -d "${AC_TMP}" ]] && rm -rf -- "${AC_TMP}" || true
}

# Materializes a root that satisfies BOTH scope walks: an empty stand-in for every path
# audit-absorption.sh names, and the three Bats corpora audit-test-smells.sh walks. Both lists are
# read out of the auditor sources rather than restated here, so a scope change cannot silently
# desynchronize this fixture from the tools.
make_dual_root() {
  local root="${1}" rel="" dir=""
  while IFS= read -r rel; do
    mkdir -p "${root}/$(dirname "${rel}")"
    printf '#!/usr/bin/env bash\n:\n' >"${root}/${rel}"
  done < <(awk '/^SCOPE_FILES=\(/ { inside = 1; next }
                inside && /^\)/ { exit }
                inside { gsub(/[[:space:]]/, ""); if ($0 != "") print }' "${ABSORPTION}")
  while IFS= read -r dir; do
    mkdir -p "${root}/${dir}"
    printf '#!/usr/bin/env bats\n' >"${root}/${dir}/clean.bats"
  done < <(awk '/^SCOPE_DIRS=\(/ { inside = 1; next }
                inside && /^\)/ { exit }
                inside { gsub(/[[:space:]]/, ""); if ($0 != "") print }' "${TEST_SMELLS}")
}

# Appends one finding to each auditor's scope: an unannotated absorption idiom and a Bats body whose
# `run` result is never inspected.
seed_dual_finding() {
  local root="${1}"
  printf 'stale_probe || true\n' >>"${root}/scripts/pii-scan.sh"
  printf '@test "dirty" {\n  run foo\n}\n' >>"${root}/scripts/test/clean.bats"
}

@test "the shared exit contract answers identically for both auditors" {
  printf '#!/usr/bin/env bash\n:\n' >"${AC_TMP}/ok.sh"
  local -a table=(
    "--advisory --strict|2"
    "--no-such-flag|2"
    "--help|0"
    "--path ${AC_TMP}/missing-target|3"
    "--root ${AC_TMP}/missing-root|3"
  )
  local row flags want script failures=""
  for row in "${table[@]}"; do
    IFS='|' read -r flags want <<<"${row}"
    for script in "${ABSORPTION}" "${TEST_SMELLS}"; do
      # shellcheck disable=SC2086  # the table column is a flag list, split on purpose
      run bash "${script}" --quiet ${flags}
      [ "${status}" -eq "${want}" ] || failures+="${script##*/} [${flags}] want ${want} got ${status}"$'\n'
    done
  done
  [ -z "${failures}" ] || {
    echo "${failures}"
    return 1
  }
}

@test "a bogus --root fails at the flag on both, not several frames later in the scope walk" {
  printf '#!/usr/bin/env bash\nprobe || true\n' >"${AC_TMP}/probe.sh"
  printf '#!/usr/bin/env bats\n' >"${AC_TMP}/probe.bats"
  local -a table=(
    "${ABSORPTION}|${AC_TMP}/probe.sh"
    "${TEST_SMELLS}|${AC_TMP}/probe.bats"
  )
  local row script target failures=""
  for row in "${table[@]}"; do
    IFS='|' read -r script target <<<"${row}"
    # The --path form is the one that used to slip: with an override in hand neither auditor reached
    # its scope walk, so the bogus --root was simply ignored.
    run bash "${script}" --quiet --root "${AC_TMP}/no-such-root" --path "${target}"
    [ "${status}" -eq 3 ] || failures+="${script##*/} want 3 got ${status}"$'\n'
    [[ "${output}" == *"--root directory not found"* ]] || failures+="${script##*/} message: ${output}"$'\n'
  done
  [ -z "${failures}" ] || {
    echo "${failures}"
    return 1
  }
}

@test "the ONE intended difference: a scope run blocks for the promoted auditor only" {
  make_dual_root "${AC_TMP}/repo"
  seed_dual_finding "${AC_TMP}/repo"

  # Both auditors see a finding in their own scope on this root...
  run bash "${ABSORPTION}" --root "${AC_TMP}/repo"
  [ "${status}" -eq 1 ] || {
    echo "promoted auditor must block on a scope finding: ${status} ${output}"
    return 1
  }
  [[ "${output}" == *"unannotated=1"* ]] || {
    echo "${output}"
    return 1
  }

  # ...and only the promoted one turns that finding into a failing exit.
  run bash "${TEST_SMELLS}" --root "${AC_TMP}/repo"
  [ "${status}" -eq 0 ] || {
    echo "unpromoted auditor must stay advisory on a scope finding: ${status} ${output}"
    return 1
  }
  [[ "${output}" == *"no_result_check=1"* ]] || {
    echo "the finding must still be reported, only not blocking: ${output}"
    return 1
  }

  # --strict is the sanctioned way to block the unpromoted auditor, and it changes nothing else.
  run bash "${TEST_SMELLS}" --strict --root "${AC_TMP}/repo"
  [ "${status}" -eq 1 ] || {
    echo "exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"no_result_check=1"* ]]
}

@test "--quiet suppresses the finding lines but never the summary, on both" {
  printf '#!/usr/bin/env bash\nprobe || true\n' >"${AC_TMP}/probe.sh"
  printf '#!/usr/bin/env bats\n@test "dirty" {\n  run foo\n}\n' >"${AC_TMP}/probe.bats"

  run bash "${ABSORPTION}" --quiet --path "${AC_TMP}/probe.sh"
  [ "${status}" -eq 0 ] || return 1
  [[ "${output}" != *"UNANNOTATED"* && "${output}" == *"unannotated=1"* ]] || {
    echo "${output}"
    return 1
  }

  run bash "${TEST_SMELLS}" --quiet --path "${AC_TMP}/probe.bats"
  [ "${status}" -eq 0 ] || return 1
  [[ "${output}" != *"NO_RESULT_CHECK"* && "${output}" == *"no_result_check=1"* ]]
}
