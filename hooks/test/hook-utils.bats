#!/usr/bin/env bats
# hooks/lib/hook-utils.sh unit suite — pins the monitor-port wrapper contract:
#   * env-prefer: exported ATRIUM_MONITOR_PORT returned directly (hot path)
#   * delegate on env-miss to atrium_monitor_port (GA_ROOT override path)
#   * AC-S1.3b: GA-root resolved through the wrapper's OWN symlink even when the
#     reach-through parent directory has NO sibling scripts/ (the ~/.claude/hooks
#     symlink-farm shape) — NOT a BASH_SOURCE-relative ../scripts miss
#   * AC-S1.3a: the wrapper carries NO literal port default of its own
#
# Run via: bats hooks/test/hook-utils.bats
# Hermetic: a real GA tree is built under mktemp WORK; the live monitor/.env,
# config.toml and ~/.glass-atrium install root are never read.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_WRAP="${GA}/hooks/lib/hook-utils.sh"
REAL_CONFIG="${GA}/scripts/lib/atrium-config.sh"

setup() {
  [[ -f "${REAL_WRAP}" ]] || skip "hook-utils.sh not found: ${REAL_WRAP}"
  [[ -f "${REAL_CONFIG}" ]] || skip "atrium-config.sh not found: ${REAL_CONFIG}"
  WORK="$(mktemp -d -t hook-utils-bats.XXXXXX)"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Build a real GA install tree under WORK/real: the wrapper + resolver copied
# from the live files (tests the actual code) + a fixture config.toml.
build_ga_fixture() {
  mkdir -p "${WORK}/real/hooks/lib" "${WORK}/real/scripts/lib"
  cp "${REAL_WRAP}" "${WORK}/real/hooks/lib/hook-utils.sh"
  cp "${REAL_CONFIG}" "${WORK}/real/scripts/lib/atrium-config.sh"
  printf '[ports]\nmonitor = 21000\n' >"${WORK}/real/config.toml"
}

@test "env-prefer: exported ATRIUM_MONITOR_PORT returned directly (no resolver needed)" {
  run env ATRIUM_MONITOR_PORT=31000 \
    bash -c 'source "$1"; hook_monitor_port' _ "${REAL_WRAP}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "31000" ]]
}

@test "delegate on env-miss: GA_ROOT override → resolver reads config.toml" {
  build_ga_fixture
  run env -u ATRIUM_MONITOR_PORT GA_ROOT="${WORK}/real" \
    ATRIUM_MONITOR_ENV="${WORK}/nonexistent.env" ATRIUM_CONFIG_TOML="${WORK}/real/config.toml" \
    bash -c 'source "$1"; hook_monitor_port' _ "${REAL_WRAP}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "21000" ]]
}

@test "AC-S1.3b: GA root resolved through the wrapper's symlink (parent has no scripts/)" {
  build_ga_fixture
  # Reach-through location mimicking ~/.claude/hooks/lib: a symlink to the real
  # wrapper whose GA-root level (../..) has NO sibling scripts/ dir.
  mkdir -p "${WORK}/fake/hooks/lib"
  ln -s "${WORK}/real/hooks/lib/hook-utils.sh" "${WORK}/fake/hooks/lib/hook-utils.sh"
  # Validity guard: the naive BASH_SOURCE-relative ../scripts path MUST be absent
  # — so a resolve can only succeed via the symlink-follow to the real location.
  [[ ! -d "${WORK}/fake/scripts" ]]
  run env -u ATRIUM_MONITOR_PORT -u GA_ROOT \
    ATRIUM_MONITOR_ENV="${WORK}/nonexistent.env" ATRIUM_CONFIG_TOML="${WORK}/real/config.toml" \
    bash -c 'source "$1"; hook_monitor_port' _ "${WORK}/fake/hooks/lib/hook-utils.sh"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "21000" ]]
}

@test "AC-S1.3b: relative symlink target also resolves to the real GA root" {
  build_ga_fixture
  # A RELATIVE symlink target exercises the against-the-link-dir resolution arm.
  mkdir -p "${WORK}/fake/hooks/lib"
  ( cd "${WORK}/fake/hooks/lib" \
    && ln -s ../../../real/hooks/lib/hook-utils.sh hook-utils.sh )
  [[ ! -d "${WORK}/fake/scripts" ]]
  run env -u ATRIUM_MONITOR_PORT -u GA_ROOT \
    ATRIUM_MONITOR_ENV="${WORK}/nonexistent.env" ATRIUM_CONFIG_TOML="${WORK}/real/config.toml" \
    bash -c 'source "$1"; hook_monitor_port' _ "${WORK}/fake/hooks/lib/hook-utils.sh"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "21000" ]]
}

@test "unlocatable atrium-config.sh → rc 1 + loud stderr" {
  # GA_ROOT points at a tree with no scripts/lib/atrium-config.sh.
  mkdir -p "${WORK}/empty"
  run env -u ATRIUM_MONITOR_PORT GA_ROOT="${WORK}/empty" \
    bash -c 'source "$1"; hook_monitor_port' _ "${REAL_WRAP}"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"cannot locate atrium-config.sh"* ]]
}

@test "AC-S1.3a: wrapper carries no literal port default (16145 / 7842)" {
  # Comment-aware: the wrapper's L8 comment MENTIONS the terminal default (16145) to
  # document that the LITERAL lives in the resolver, not here. A comment is not a
  # hardcoded default, so count the literal only on NON-COMMENT (code) lines. This
  # still FAILS if a real code line (e.g. `PORT_DEFAULT=16145`) hardcodes the port.
  run bash -c "grep -vE '^[[:space:]]*#' \"${REAL_WRAP}\" | grep -c '16145' || true"
  [[ "${output}" == "0" ]]
  run bash -c "grep -vE '^[[:space:]]*#' \"${REAL_WRAP}\" | grep -c '7842' || true"
  [[ "${output}" == "0" ]]
}
