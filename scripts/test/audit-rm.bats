#!/usr/bin/env bats
# audit-rm.bats — pins scripts/audit-rm.sh: exactly one converted delete shape, the three named unsafe
# kinds, the closed two-label annotation vocabulary, and the five-tree scope minus the probe file.
#
# Every fixture line is test data the auditor reads and no shell runs.
# This file is in the auditor's own scope, so each such line it flags is annotated not-executed in one of two ways:
#   - a comment line directly above it, which stays out of every fixture;
#   - a GA-RM token following the site inside the fixture text itself.

# shellcheck disable=SC2016  # fixtures are literal shell text written to files, never expanded here

AUDIT_SH="${BATS_TEST_DIRNAME}/../audit-rm.sh"

# Writes the remaining arguments to the fixture path, one per line.
write_fixture() {
  local path="${1}"
  shift
  mkdir -p "${path%/*}"
  printf '%s\n' "$@" >"${path}"
}

# Audits one fixture file built from the arguments, on the advisory --path surface.
audit_fixture() {
  local path="${BATS_TEST_TMPDIR}/fixture.sh"
  write_fixture "${path}" '#!/usr/bin/env bash' "$@"
  run bash "${AUDIT_SH}" --path "${path}"
}

# Fails, naming the row, unless the advisory run exited 0 with the expected summary as its last line.
assert_summary() {
  local name="${1}" expected="${2}"
  [[ "${status}" -eq 0 && "${lines[${#lines[@]} - 1]}" == "${expected}" ]] || {
    echo "${name}: exit ${status}, expected summary '${expected}' in:"
    echo "${output}"
    return 1
  }
}

make_scope_root() {
  local root="${1}" tree=""
  for tree in hooks scripts autoagent lib test; do
    mkdir -p "${root}/${tree}"
  done
}

@test "a guard-gated delete of the colon-question operand is converted, on one line or under its if line" {
  local fixture=(
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'if ga_guard_path "${WORK}"; then rm -rf -- "${WORK:?}"; fi'
    'if ga_guard_path "${tmp:-}"; then'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    '  rm -f "${tmp:?}/run.stamp" # its own sub-path'
    'fi'
  )
  audit_fixture "${fixture[@]}"
  assert_summary "converted shapes" "converted=2 annotated=0 unconverted=0 quality_reject=0"
}

@test "every departure from the one converted shape is reported as unconverted" {
  local rows=(
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'guard on another variable|if ga_guard_path "${A}"; then rm -rf -- "${B:?}"; fi'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'another guard function|if check_dir "${A}"; then rm -rf -- "${A:?}"; fi'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'operand without the colon-question form|if ga_guard_path "${A}"; then rm -rf -- "${A}"; fi'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'and-list gate instead of an if|ga_guard_path "${A}" && rm -rf -- "${A:?}"'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'delete in the else branch|if ga_guard_path "${A}"; then :; else rm -rf -- "${A:?}"; fi'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    $'if line not directly above|if ga_guard_path "${A}"; then\n  cd /tmp\n  rm -rf -- "${A:?}"\nfi'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'dot-dot segment in the sub-path|if ga_guard_path "${A}"; then rm -rf -- "${A:?}/../x"; fi'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'variable sub-path|if ga_guard_path "${A}"; then rm -rf -- "${A:?}/${B}"; fi'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'second operand|if ga_guard_path "${A}"; then rm -rf -- "${A:?}" "${B:?}"; fi'
  )
  local row=""
  for row in "${rows[@]}"; do
    audit_fixture "${row#*|}"
    assert_summary "${row%%|*}" "converted=0 annotated=0 unconverted=1 quality_reject=0"
  done
}

@test "a non-empty test alone, an unquoted target and a glob target are each reported under their own kind" {
  local rows=(
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'NONEMPTY_ONLY|[[ -n "${D}" ]] && rm -rf -- "${D}"'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'UNQUOTED_TARGET|rm -rf -- $D'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'GLOB_TARGET|rm -rf .*'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'GLOB_TARGET|rm -rf -- "${D:?}"/*'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'UNCONVERTED|rm -rf -- "${D}"'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    "UNCONVERTED|bash -c 'rm -f -- /tmp/x'"
  )
  local row="" kind=""
  for row in "${rows[@]}"; do
    kind="${row%%|*}"
    audit_fixture "${row#*|}"
    assert_summary "${row}" "converted=0 annotated=0 unconverted=1 quality_reject=0"
    [[ "${output}" == *"${kind} "*"fixture.sh:2: "* ]] || {
      echo "${row}: kind ${kind} not reported at line 2 in: ${output}"
      return 1
    }
  done
}

@test "the two labels with a reason annotate a site, any other label or an empty reason is a grammar reject" {
  # name|expected summary|fixture text
  local rows=(
    'trailing not-executed|converted=0 annotated=1 unconverted=0 quality_reject=0|rm -f -- "${A}" # GA-RM[not-executed]: fixture literal'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    $'unvalidatable on the line above|converted=0 annotated=1 unconverted=0 quality_reject=0|# GA-RM[unvalidatable]: find hands the path in as a placeholder\nfind "${A}" -exec rm -f {} +'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    $'unknown label|converted=0 annotated=0 unconverted=0 quality_reject=1|# GA-RM[benign]: a reason\nrm -f -- "${A}"'
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    $'empty reason|converted=0 annotated=0 unconverted=0 quality_reject=1|# GA-RM[not-executed]:\nrm -f -- "${A}"'
    $'token on a code line above|converted=0 annotated=1 unconverted=1 quality_reject=0|rm -f -- "${A}" # GA-RM[not-executed]: fixture literal\nrm -f -- "${B}"'
  )
  local row="" rest=""
  for row in "${rows[@]}"; do
    rest="${row#*|}"
    audit_fixture "${rest#*|}"
    assert_summary "${row%%|*}" "${rest%%|*}"
  done
}

@test "text that is not a recursive or forced delete command is not a site" {
  local rows=(
    # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
    'comment line|# rm -rf "${A}" runs in cleanup'
    'interactive flag only|rm -i -- "${A}"'
    'word ending in the command name|confirm -rf "${A}"'
  )
  local row=""
  for row in "${rows[@]}"; do
    audit_fixture "${row#*|}"
    assert_summary "${row%%|*}" "converted=0 annotated=0 unconverted=0 quality_reject=0"
  done
}

@test "a scope run covers the shell files of the five trees and skips only the violation probe" {
  local root="${BATS_TEST_TMPDIR}/root"
  # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
  local site='rm -f -- "${A}"'
  make_scope_root "${root}"
  write_fixture "${root}/hooks/a.sh" "${site}"
  write_fixture "${root}/scripts/test/b.bats" "${site}"
  write_fixture "${root}/lib/c.bash" "${site}"
  write_fixture "${root}/autoagent/tool" '#!/bin/sh' "${site}"
  write_fixture "${root}/test/e.bats" "${site}"
  write_fixture "${root}/test/scratch-cwd-violation-probe.bats" "${site}"
  write_fixture "${root}/test/notes.md" "${site}"
  write_fixture "${root}/monitor/d.sh" "${site}"
  run bash "${AUDIT_SH}" --root "${root}"
  assert_summary "scope run" "converted=0 annotated=0 unconverted=5 quality_reject=0"
  [[ "${output}" != *scratch-cwd-violation-probe* ]] || {
    echo "the probe file was audited: ${output}"
    return 1
  }
}

@test "findings leave a scope run exit 0 and fail it only under --strict" {
  local root="${BATS_TEST_TMPDIR}/root" row=""
  make_scope_root "${root}"
  # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
  write_fixture "${root}/hooks/a.sh" 'rm -f -- "${A}"'
  local rows=('default|0' 'strict|1')
  for row in "${rows[@]}"; do
    if [[ "${row%%|*}" == strict ]]; then
      run bash "${AUDIT_SH}" --root "${root}" --strict
    else
      run bash "${AUDIT_SH}" --root "${root}"
    fi
    [[ "${status}" -eq "${row#*|}" && "${output}" == *"UNCONVERTED"*"hooks/a.sh:1: "* ]] || {
      echo "${row}: exit ${status}: ${output}"
      return 1
    }
  done
}

@test "a missing scope tree is an IO error (exit 3)" {
  local root="${BATS_TEST_TMPDIR}/root"
  make_scope_root "${root}"
  rmdir "${root}/lib"
  run bash "${AUDIT_SH}" --root "${root}"
  [[ "${status}" -eq 3 && "${output}" == *"lib"* ]] || {
    echo "exit ${status}: ${output}"
    return 1
  }
}
