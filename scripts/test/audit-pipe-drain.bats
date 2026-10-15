#!/usr/bin/env bats
# audit-pipe-drain.bats — pins scripts/audit-pipe-drain.sh: every early-exit pipe reader in a hooks/
# shell file is reported unless drain_after wraps it or the `|| true` right after its pipeline discards its status,
# the deferred-site allowance demotes only its two named files, and the scope run is clean on this tree.

# shellcheck disable=SC2016  # fixtures are literal shell text written to files, never expanded here

AUDIT_SH="${BATS_TEST_DIRNAME}/../audit-pipe-drain.sh"

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
  write_fixture "${path}" '#!/usr/bin/env bash' 'set -Eeuo pipefail' "$@"
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

@test "every early-exit reader at a pipe stage is reported as undrained" {
  local rows=(
    'grep -q|if printf "%s" "${x}" | grep -q foo; then :; fi'
    'grep option cluster|printf "%s" "${x}" | grep -qiF -- foo && exit 2'
    'grep -q after another option|printf "%s" "${x}" | grep -E -q foo || exit 0'
    'grep -m|line="$(printf "%s" "${x}" | grep -m 1 foo)"'
    'grep long quiet|printf "%s" "${x}" | grep --quiet foo && exit 2'
    'head in a substitution|first="$(printf "%s\n" "${x}" | head -1)"'
    'head mid-pipe|printf "%s\n" "${x}" | head -1 | awk "{print}"'
    'pipe-and|printf "%s" "${x}" |& grep -q foo && exit 2'
    $'reader on a backslash continuation|printf "%s" "${x}" \\\n  | grep -q foo && exit 2'
    $'reader after a trailing pipe|printf "%s" "${x}" |\n  head -1'
    'helper wrapping a reader|decl="$(printf "%s\n" "${x}" | scope_decl_select)"'
    'and-list ahead of a trailing or-true|printf "%s" "${x}" | grep -qF secret && exit 2 || true'
    'or-true inside the then branch|if printf "%s" "${x}" | grep -q foo; then rm_tmp || true; fi'
    'or-true in a later command|printf "%s" "${x}" | grep -q foo; v=$(cat f || true)'
  )
  local row=""
  for row in "${rows[@]}"; do
    audit_fixture "${row#*|}"
    assert_summary "${row%%|*}" "drained=0 discarded=0 undrained=1 allowed=0"
  done
}

@test "a drained reader, a discarded status and a non-reader are not reported" {
  local rows=(
    'drained grep|drained=1 discarded=0|if printf "%s" "${x}" | drain_after grep -qF foo; then :; fi'
    'drained head|drained=1 discarded=0|printf "%s\n" "${x}" | drain_after head -1 | awk "{print}"'
    'drained helper|drained=1 discarded=0|decl="$(printf "%s\n" "${x}" | drain_after scope_decl_select)"'
    'or-true discard|drained=0 discarded=1|v="$(printf "%s" "${x}" | grep -o y | head -1 || true)"'
    $'or-true on a continuation|drained=0 discarded=1|v="$(printf "%s" "${x}" \\\n  | head -1 || true)"'
    'or-true after the closing subshell|drained=0 discarded=1|(printf "%s" "${x}" | head -20) || true'
    'grep reading a file|drained=0 discarded=0|if grep -q foo "${file}"; then :; fi'
    'head reading a file|drained=0 discarded=0|first="$(head -n 1 "${file}")"'
    'or-list, not a pipe|drained=0 discarded=0|[[ -z "${x}" ]] || grep -q foo "${file}"'
    'full-read grep|drained=0 discarded=0|n="$(printf "%s" "${x}" | grep -c foo || true)"; printf "%s" "${x}" | grep foo >/dev/null'
    'comment line|drained=0 discarded=0|# printf x | grep -q foo'
    'trailing comment|drained=0 discarded=0|: # then x | head -1'
    'single-quoted text|drained=0 discarded=0|msg='"'"'pipe it | head -1'"'"''
    $'heredoc body|drained=0 discarded=0|cat <<\'EOF\'\nprintf x | grep -q foo\nEOF'
  )
  local row="" name="" counts=""
  for row in "${rows[@]}"; do
    name="${row%%|*}"
    counts="${row#*|}"
    counts="${counts%%|*}"
    audit_fixture "${row#*|*|}"
    assert_summary "${name}" "${counts} undrained=0 allowed=0"
  done
}

@test "a scope run blocks on a planted undrained site and names it" {
  local root="${BATS_TEST_TMPDIR}/root"
  write_fixture "${root}/hooks/planted.sh" '#!/usr/bin/env bash' 'printf x | grep -q x && exit 2'
  write_fixture "${root}/hooks/test/fixture.bats" '@test "t" { printf x | grep -q x; }'
  run bash "${AUDIT_SH}" --root "${root}"
  [[ "${status}" -eq 1 && "${output}" == *"UNDRAINED"*"hooks/planted.sh:2"* &&
    "${output}" != *"hooks/test/"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "the deferred-site allowance reports its two files' sites as allowed and blocks nothing" {
  local root="${BATS_TEST_TMPDIR}/root" file=""
  for file in hooks/track-outcome.sh hooks/lib/scope-match.sh; do
    write_fixture "${root}/${file}" '#!/usr/bin/env bash' 'printf x | grep -q x && exit 2'
  done
  run bash "${AUDIT_SH}" --root "${root}"
  [[ "${status}" -eq 0 && "${lines[${#lines[@]} - 1]}" == "drained=0 discarded=0 undrained=0 allowed=2" ]] || {
    echo "${output}"
    return 1
  }
}

@test "the scope run over this tree reports no undrained site" {
  run bash "${AUDIT_SH}"
  [[ "${status}" -eq 0 && "${lines[${#lines[@]} - 1]}" == *" undrained=0 "* ]] || {
    echo "${output}"
    return 1
  }
}
