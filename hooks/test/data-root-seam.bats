#!/usr/bin/env bats
# data-root-seam.bats — pins the T1 shell data/log-root seam: the HOME-anchored
# GA_DATA_ROOT default (${GA_DATA_ROOT:-$HOME/.glass-atrium}) shared by
# hooks/hook-utils.sh (HOOK_LOG_DIR/HOOK_DATA_DIR) and scripts/lib/atrium-config.sh
# (daemon-config default). The seam is DECOUPLED from the install-tree GA_ROOT so
# CLI-fired hooks + launchd daemons (where GA_ROOT is unset) resolve correctly, and
# stays parity-identical with the python twin hooks/ga_paths.py.
#
# Run via: bats hooks/test/data-root-seam.bats
# Hermetic: HOME is repointed to a mktemp sandbox per test; no live ~/.claude or
# ~/.glass-atrium state is read or written. Each source runs in a fresh `bash -c`
# subshell so the sourced library never trips the test's own ERR handling.
#
# Every assertion uses a `|| return 1` fail-fast guard: bats enforces only the
# test body's LAST command status, so an unguarded intermediate assertion would be
# silently masked by a later passing one.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_LIB="${GA}/hooks/hook-utils.sh"
REAL_CONFIG="${GA}/scripts/lib/atrium-config.sh"

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "hook-utils.sh not found: ${REAL_LIB}"
  [[ -f "${REAL_CONFIG}" ]] || skip "atrium-config.sh not found: ${REAL_CONFIG}"
  SANDBOX="$(mktemp -d -t data-root-seam.XXXXXX)"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

@test "hook-utils.sh: no override → data/log roots anchor on \$HOME/.glass-atrium" {
  run env -u GA_DATA_ROOT -u GA_ROOT -u HOOK_DATA_DIR -u HOOK_LOG_DIR HOME="${SANDBOX}" \
    bash -c 'source "$1"; printf "%s\n%s\n" "${HOOK_LOG_DIR}" "${HOOK_DATA_DIR}"' _ "${REAL_LIB}"
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ "${lines[0]}" == "${SANDBOX}/.glass-atrium/logs" ]] || { echo "log=${lines[0]}" >&2; return 1; }
  [[ "${lines[1]}" == "${SANDBOX}/.glass-atrium/data" ]] || { echo "data=${lines[1]}" >&2; return 1; }
}

@test "hook-utils.sh: launchd-context (GA_ROOT unset) → \$HOME/.glass-atrium/data" {
  # The hottest consumer contexts — CLI-fired hooks + launchd daemons — export no
  # GA_ROOT, so the seam MUST resolve without it. Guards the install-tree-coupled
  # ${GA_ROOT:-…} split-brain on a custom-GA_ROOT install.
  run env -u GA_DATA_ROOT -u GA_ROOT -u HOOK_DATA_DIR HOME="${SANDBOX}" \
    bash -c 'source "$1"; printf "%s\n" "${HOOK_DATA_DIR}"' _ "${REAL_LIB}"
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ "${output}" == "${SANDBOX}/.glass-atrium/data" ]] || { echo "data=${output}" >&2; return 1; }
}

@test "hook-utils.sh: decoupled from install-tree GA_ROOT (custom GA_ROOT ignored)" {
  # A custom-GA_ROOT install must NOT drag the runtime data root onto the install
  # tree — the seam anchors on HOME, never on GA_ROOT.
  run env -u GA_DATA_ROOT -u HOOK_DATA_DIR GA_ROOT="/decoy/install/tree" HOME="${SANDBOX}" \
    bash -c 'source "$1"; printf "%s\n" "${HOOK_DATA_DIR}"' _ "${REAL_LIB}"
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ "${output}" == "${SANDBOX}/.glass-atrium/data" ]] || { echo "data=${output} (should ignore GA_ROOT)" >&2; return 1; }
}

@test "hook-utils.sh: GA_DATA_ROOT override honored (seam override keeps working)" {
  run env -u GA_ROOT -u HOOK_DATA_DIR -u HOOK_LOG_DIR GA_DATA_ROOT="${SANDBOX}/custom-root" HOME="${SANDBOX}" \
    bash -c 'source "$1"; printf "%s\n%s\n" "${HOOK_LOG_DIR}" "${HOOK_DATA_DIR}"' _ "${REAL_LIB}"
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ "${lines[0]}" == "${SANDBOX}/custom-root/logs" ]] || { echo "log=${lines[0]}" >&2; return 1; }
  [[ "${lines[1]}" == "${SANDBOX}/custom-root/data" ]] || { echo "data=${lines[1]}" >&2; return 1; }
}

@test "atrium-config.sh: daemon-config default resolves under \$HOME/.glass-atrium/data" {
  command -v jq >/dev/null 2>&1 || skip "jq required for daemon-config resolution"
  mkdir -p "${SANDBOX}/.glass-atrium/data"
  printf '{"haiku_model":"sentinel-model-xyz"}\n' >"${SANDBOX}/.glass-atrium/data/daemon-config.json"
  # Empty arg → the canonical default path; must read the .glass-atrium store, not .claude.
  run env -u GA_DATA_ROOT -u GA_ROOT HOME="${SANDBOX}" \
    bash -c 'source "$1"; atrium_resolve_haiku_model ""' _ "${REAL_CONFIG}"
  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ "${output}" == "sentinel-model-xyz" ]] || { echo "model=${output}" >&2; return 1; }
}
