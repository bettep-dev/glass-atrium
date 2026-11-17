#!/usr/bin/env bash
# shellcheck disable=SC2310  # file-wide: each act's status is captured into the exit code, never left to errexit
# remote-access-set.sh — the Mac page's write step for remote access: on · off · trust.
# Internal: run only by the monitor's loopback routes, never listed by `glass-atrium remote` or its help.
# Writes config.toml, the keys and monitor/.env only → the monitor applies the change itself (no restart, no
# monitor call); the typed confirmation stays with the terminal entries, whose write steps these are.
# Argv: `on` · `off` · `trust <interface> <gateway> <hardware address>` — the network the monitor's confirm showed.
# Exit: 0 written · 2 argv not one of those · a GA_REMOTE_* write-step code (lib/ga-remote.sh) · 1 other write failure.
set -Eeuo pipefail
IFS=$'\n\t'
trap 'printf "remote-access-set: line %s: %s\n" "${LINENO}" "${BASH_COMMAND}" >&2' ERR

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
# shellcheck source=lib/atrium-config.sh
source "${SCRIPT_DIR}/lib/atrium-config.sh"
# shellcheck source=../lib/ga-remote.sh
source "${SCRIPT_DIR}/../lib/ga-remote.sh"

main() {
  local rc=0
  case "$#:${1:-}" in
    1:on) ga_remote_enable || rc=$? ;;
    1:off) set_off || rc=$? ;;
    4:trust)
      if ! is_network_identity "$2" "$3" "$4"; then
        print_usage
        return 2
      fi
      set_trust "$2 $3 $4" || rc=$?
      ;;
    *)
      print_usage
      return 2
      ;;
  esac
  ((rc == 0)) || return "${rc}"
  if ! ga_remote_render_env; then
    printf 'remote: config.toml written, but monitor/.env was not rendered\n' >&2
    return "${GA_REMOTE_ENV_NOT_RENDERED}"
  fi
}

print_usage() {
  printf 'usage: remote-access-set.sh on|off|trust <interface> <gateway> <hardware address>\n' >&2
}

# The identity's form as ga_remote_get_network_identity prints it: an interface name, a private gateway, a normalized address.
is_network_identity() {
  [[ "$1" =~ ^[a-z0-9]+$ ]] && ga_remote_is_trusted_entry "$2@$3"
}

set_off() {
  if ! ga_remote_set_config enabled false; then
    printf 'remote: config.toml could not be written — access stays as it was\n' >&2
    return 1
  fi
}

# Trusts only the network shown: a change between the monitor's match and this read writes nothing.
set_trust() {
  local shown="$1" identity
  identity="$(ga_remote_get_trust_identity)" || return
  if [[ "${identity}" != "${shown}" ]]; then
    printf 'remote: the network now is not the one shown — nothing written\n' >&2
    return "${GA_REMOTE_NETWORK_NOT_SHOWN}"
  fi
  ga_remote_trust_network "${identity}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  exit_code=0
  main "$@" || exit_code=$?
  exit "${exit_code}"
fi
