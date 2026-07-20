#!/usr/bin/env bash
# no-python3.bash — shared python3-absent PATH fixture for the fail-closed
# security-gate suites (block-dangerous-commands · enforce-delegation ·
# enforce-harness-critical).
#
# WHY: each gate must fail CLOSED when python3 is off PATH (extraction otherwise
# degrades to EMPTY → silent allow) while keeping genuinely-empty stdin fail-open.
# The suites drive that condition by running the hook under a PATH containing only
# the coreutils the hook needs — python3 excluded (and jq — emit_error falls back
# to the pure-bash escaper).
#
# Bash 3.2+ (macOS stock). Callers source this from setup():
#   source "${BATS_TEST_DIRNAME}/lib/no-python3.bash"

# Build the stripped PATH dir. Args: tool names to link (default: the superset the
# consuming suites need). Echoes the bin dir.
minimal_bin_without_python3() {
  # SC2154: BATS_TEST_TMPDIR is assigned by the Bats runner (per-test tmpdir).
  # shellcheck disable=SC2154
  local bindir="${BATS_TEST_TMPDIR}/minbin" tool src
  mkdir -p "${bindir}"
  [[ "$#" -eq 0 ]] && set -- bash cat grep basename tr sed env mktemp dirname
  for tool in "$@"; do
    src="$(command -v "${tool}")"
    [[ -n "${src}" ]] && ln -sf "${src}" "${bindir}/${tool}"
  done
  printf '%s\n' "${bindir}"
}

# Drive a hook with python3 stripped from PATH via Bats `run`. HOME is preserved by
# default (hook-utils.sh derives its log/data dirs from it under set -u) — pass $3
# to pin a fixture HOME instead; only PATH is narrowed so `command -v python3`
# fails, the precise real-world condition the fail-closed rows guard.
# Args: $1=hook path · $2=raw stdin · $3=HOME override (default: real $HOME).
run_hook_with_no_python3() {
  local hook="${1}" input="${2}" home="${3:-${HOME}}" bindir
  bindir="$(minimal_bin_without_python3)"
  # SC2016: the inner $1/$2 are the child bash's OWN positionals — no expansion here.
  # shellcheck disable=SC2016
  run env "PATH=${bindir}" "HOME=${home}" bash -c '
    printf "%s" "$1" | bash "$2"
  ' _ "${input}" "${hook}"
}
