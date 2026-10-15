#!/usr/bin/env bats
# audit-rm.bats — pins scripts/audit-rm.sh: exactly one converted delete shape, the three named unsafe
# kinds, the closed two-label annotation vocabulary, the scope (five trees plus two root scripts, no file
# exempt), the blocking exit contract, and the NOT_READ disclosure of every tracked shell file it skips.
#
# Every fixture line is test data the auditor reads and no shell runs.
# This file is in the auditor's own scope, so each such line it flags is annotated not-executed in one of two ways:
#   - a comment line directly above it, which stays out of every fixture;
#   - a GA-RM token following the site inside the fixture text itself.

# shellcheck disable=SC2016  # fixtures are literal shell text written to files, never expanded here

AUDIT_SH="${BATS_TEST_DIRNAME}/../audit-rm.sh"
# Physical path → a symlinked scripts/ dir cannot re-aim the root at the symlink's parent.
REPO_ROOT="$(cd -P -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
SCOPE_TREES=(hooks scripts autoagent lib test)
SCOPE_ROOT_FILES=(glass-atrium install.sh)
PROBE_FILE='test/scratch-cwd-violation-probe.bats'

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

# Builds every scope entry under the root, except the one named by the optional second argument.
make_scope_root() {
  local root="${1}" omit="${2:-}" tree="" file=""
  for tree in "${SCOPE_TREES[@]}"; do
    [[ "${tree}" == "${omit}" ]] || mkdir -p "${root}/${tree}"
  done
  for file in "${SCOPE_ROOT_FILES[@]}"; do
    [[ "${file}" == "${omit}" ]] || : >"${root}/${file}"
  done
}

# 0 when a scope run reaches the repository-relative path.
is_in_scope() {
  local path="${1}" tree=""
  for tree in "${SCOPE_TREES[@]}"; do
    if [[ "${path}" == "${tree}/"* ]]; then
      return 0
    fi
  done
  [[ " ${SCOPE_ROOT_FILES[*]} " == *" ${path} "* ]]
}

# The SC2115 CI step's selection: a shell extension, or an extensionless regular file with an sh-family shebang.
is_shell_file() {
  local path="${REPO_ROOT}/${1}" first="" shebang_re='^#!.*[/[:space:]](ba|da|k)?sh([[:space:]]|$)'
  case "${path##*/}" in
    *.sh | *.bash | *.bats) return 0 ;;
    *.*) return 1 ;;
    *) ;;
  esac
  if [[ ! -f "${path}" || -L "${path}" ]]; then
    return 1
  fi
  # A first line with no trailing newline fails the read yet still fills first.
  IFS= read -r first <"${path}" || [[ -n "${first}" ]] || return 1
  [[ "${first}" =~ ${shebang_re} ]]
}

# Sorted list of every tracked shell file no scope entry reaches.
get_unread_shell_files() {
  local tracked="" unread="" path=""
  tracked="$(git -C "${REPO_ROOT}" -c core.quotePath=false ls-files)"
  while IFS= read -r path; do
    if is_shell_file "${path}" && ! is_in_scope "${path}"; then
      unread="${unread}${path}"$'\n'
    fi
  done <<<"${tracked}"
  printf '%s' "${unread}" | LC_ALL=C sort
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

@test "a scope run audits every shell file of the five trees and the two root scripts, exempting no file" {
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
  write_fixture "${root}/glass-atrium" '#!/usr/bin/env bash' "${site}"
  write_fixture "${root}/install.sh" "${site}"
  write_fixture "${root}/other.sh" "${site}"
  write_fixture "${root}/monitor/scripts/prune-dist.sh" "${site}"
  run bash "${AUDIT_SH}" --root "${root}" --advisory
  # No file is exempt by path → the probe's site is reported like any other.
  [[ "${output}" == *"${PROBE_FILE}:1: "* ]] || {
    echo "the probe file was not audited: ${output}"
    return 1
  }
  assert_summary "scope run" "converted=0 annotated=0 unconverted=8 quality_reject=0"
}

@test "the violation probe's one delete site counts as an annotated exception" {
  run bash "${AUDIT_SH}" --path "${REPO_ROOT}/${PROBE_FILE}"
  assert_summary "violation probe" "converted=0 annotated=1 unconverted=0 quality_reject=0"
}

@test "a scope run blocks on an unconverted site or a grammar reject, an --advisory or --path run does not" {
  local base="${BATS_TEST_TMPDIR}" row="" name="" expected="" surface="" root_name="" flag="" summary="" target=""
  make_scope_root "${base}/clean"
  make_scope_root "${base}/site"
  make_scope_root "${base}/reject"
  # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
  write_fixture "${base}/site/hooks/a.sh" 'rm -f -- "${A}"'
  # GA-RM[not-executed]: auditor fixture text, written to a file no shell runs
  write_fixture "${base}/reject/hooks/a.sh" '# GA-RM[benign]: a reason' 'rm -f -- "${A}"'
  # name|exit status|surface|fixture root|mode flag|summary line
  local rows=(
    'clean scope run|0|root|clean||converted=0 annotated=0 unconverted=0 quality_reject=0'
    'unconverted site on a scope run|1|root|site||converted=0 annotated=0 unconverted=1 quality_reject=0'
    'grammar reject on a scope run|1|root|reject||converted=0 annotated=0 unconverted=0 quality_reject=1'
    'site on an --advisory scope run|0|root|site|--advisory|converted=0 annotated=0 unconverted=1 quality_reject=0'
    'site on a --path run|0|path|site||converted=0 annotated=0 unconverted=1 quality_reject=0'
    'site on a --strict --path run|1|path|site|--strict|converted=0 annotated=0 unconverted=1 quality_reject=0'
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name expected surface root_name flag summary <<<"${row}"
    target="${base}/${root_name}"
    if [[ "${surface}" == path ]]; then
      target="${target}/hooks/a.sh"
    fi
    run bash "${AUDIT_SH}" "--${surface}" "${target}" ${flag:+"${flag}"}
    [[ "${status}" -eq "${expected}" && $'\n'"${output}"$'\n' == *$'\n'"${summary}"$'\n'* ]] || {
      echo "${name}: exit ${status}, expected ${expected} with '${summary}' in:"
      echo "${output}"
      return 1
    }
  done
}

@test "a scope run names as NOT_READ exactly the tracked shell files outside scope" {
  local toplevel="" root="${BATS_TEST_TMPDIR}/root" expected="" named=""
  if ! toplevel="$(git -C "${REPO_ROOT}" rev-parse --show-toplevel 2>/dev/null)" \
    || [[ "${toplevel}" != "${REPO_ROOT}" ]]; then
    skip "Repo-only: the tracked file list needs the source work tree, which an install lacks"
  fi
  make_scope_root "${root}"
  expected="$(get_unread_shell_files)"
  run bash "${AUDIT_SH}" --root "${root}"
  named="$(sed -n 's/^NOT_READ[[:space:]]*\([^:]*\): .*/\1/p' <<<"${output}")"
  named="$(LC_ALL=C sort <<<"${named}")"
  [[ "${status}" -eq 0 && "${named}" == "${expected}" ]] || {
    printf 'exit %s\n--- expected ---\n%s\n--- named ---\n%s\n' "${status}" "${expected}" "${named}"
    return 1
  }
}

@test "a missing scope tree or scope file is an IO error (exit 3)" {
  local entry="" root=""
  for entry in lib install.sh; do
    root="${BATS_TEST_TMPDIR}/${entry}"
    make_scope_root "${root}" "${entry}"
    run bash "${AUDIT_SH}" --root "${root}"
    [[ "${status}" -eq 3 && "${output}" == *"missing"*"/${entry}"* ]] || {
      echo "missing ${entry}: exit ${status}: ${output}"
      return 1
    }
  done
}
