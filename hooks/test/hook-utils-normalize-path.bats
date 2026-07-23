#!/usr/bin/env bats
# hooks/hook-utils.sh — hook_normalize_path unit suite (P0-2 tilde-bypass fix).
#
# Pins the leading-tilde expansion contract: envelope paths arrive verbatim (never
# shell-expanded), so "~" / "~/x" must expand to ${HOME} at function ENTRY or every
# ${HOME}-anchored caller match arm is dodged. "~user" stays literal, a post-collapse
# "~" segment is never re-expanded, empty HOME leaves the tilde untouched, and the
# existing "."/".." collapse behavior is unchanged.
#
# Run via: bats hooks/test/hook-utils-normalize-path.bats
# Hermetic: HOME is pinned per invocation; no filesystem or live-install state read.
#
# SC2088 disabled file-wide: every quoted leading ~ in this suite IS the literal
# under test — a verbatim envelope byte, never a tilde meant for shell expansion.
# shellcheck disable=SC2088

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_LIB="${GA}/hooks/hook-utils.sh"

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "hook-utils.sh not found: ${REAL_LIB}"
  FAKE_HOME="/nonexistent-fixture-home"
}

# Run hook_normalize_path under a pinned HOME. Args: $1=HOME value $2=input path.
normalize_with_home() {
  run env HOME="${1}" bash -c 'source "$1"; hook_normalize_path "$2"' _ "${REAL_LIB}" "${2}"
}

@test "exact ~ expands to HOME" {
  normalize_with_home "${FAKE_HOME}" '~'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "${FAKE_HOME}" ]] || return 1
}

@test "leading ~/ expands to HOME/ and traversal still collapses" {
  normalize_with_home "${FAKE_HOME}" '~/x/../.glass-atrium/hooks/a.sh'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == "${FAKE_HOME}/.glass-atrium/hooks/a.sh" ]] || return 1
}

@test "~user form stays literal (no portable resolution on stock Bash 3.2)" {
  normalize_with_home "${FAKE_HOME}" '~other/.glass-atrium/hooks/a.sh'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == '~other/.glass-atrium/hooks/a.sh' ]] || return 1
}

@test "post-collapse ~ segment is NOT re-expanded (entry-only expansion)" {
  normalize_with_home "${FAKE_HOME}" 'a/../~/b'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == '~/b' ]] || return 1
}

@test "empty HOME leaves a leading ~/ untouched (guard, no /-anchored mangling)" {
  normalize_with_home "" '~/x'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == '~/x' ]] || return 1
}

@test "regression: absolute-path ./.. collapse unchanged" {
  normalize_with_home "${FAKE_HOME}" '/a/./b/../c'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == '/a/c' ]] || return 1
}

@test "regression: relative traversal collapse unchanged (hooks/../x → x)" {
  normalize_with_home "${FAKE_HOME}" 'hooks/../x'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == 'x' ]] || return 1
}
