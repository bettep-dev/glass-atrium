#!/usr/bin/env bash
# shellcheck disable=SC2310  # file-wide: each act's status is captured into the exit code, never left to errexit
# remote-access-set.sh — the Mac page's write step for remote access: on · off · trust.
# Internal: run only by the monitor's loopback routes, never listed by `glass-atrium remote` or its help.
# Writes config.toml, the keys and monitor/.env only → the monitor applies the change itself (no restart, no
# monitor call); the typed confirmation stays with the terminal entries, whose write steps these are.
# Exit: 0 written · 2 argv not exactly one act · 6 network unreadable or trusted list malformed · 7 keys not
# created · 8 config written, env not rendered · 9 network already trusted (nothing written) · 1 other write failure.
set -Eeuo pipefail
IFS=$'\n\t'
trap 'printf "remote-access-set: line %s: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2' ERR

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=lib/atrium-config.sh
source "${SCRIPT_DIR}/lib/atrium-config.sh"
# shellcheck source=../lib/ga-remote.sh
source "${SCRIPT_DIR}/../lib/ga-remote.sh"

readonly RENDER_FAILED=8

main() {
  local rc=0
  if (($# != 1)); then
    print_usage
    return 2
  fi
  case "$1" in
    on) ga_remote_enable || rc=$? ;;
    off) set_off || rc=$? ;;
    trust) set_trust || rc=$? ;;
    *)
      print_usage
      return 2
      ;;
  esac
  ((rc == 0)) || return "${rc}"
  if ! ga_remote_render_env; then
    printf 'remote: config.toml written, but monitor/.env was not rendered\n' >&2
    return "${RENDER_FAILED}"
  fi
}

print_usage() {
  printf 'usage: remote-access-set.sh on|off|trust\n' >&2
}

set_off() {
  if ! ga_remote_set_config enabled false; then
    printf 'remote: config.toml could not be written — access stays as it was\n' >&2
    return 1
  fi
}

set_trust() {
  local identity
  identity="$(ga_remote_get_trust_identity)" || return
  ga_remote_trust_network "${identity}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  exit_code=0
  main "$@" || exit_code=$?
  exit "${exit_code}"
fi
