#!/usr/bin/env bash
# Sandbox-seal client (test/lib/bats-db-seal.bash): runs the real postgres client only when the call
# provably targets the sandbox socket directory; any other target, or one it cannot read, is refused.
# Usage: bats-db-seal-client.bash <client> <real-client-path> <sandbox-socket-dir> [client args...]
set -Eeuo pipefail
IFS=$'\n\t'

readonly CLIENT="${1:?client name}" REAL="${2:?real client path}" SANDBOX="${3:?sandbox socket dir}"
shift 3

refuse() {
  printf '%s: refused by the bats live-DB seal (test/lib/bats-db-seal.bash): %s\n' "${CLIENT}" "$1" >&2
  exit 2
}

# host= value of a postgres URI query string, empty when absent or unreadable; the URI's
# authority host is never a sandbox socket
uri_host() {
  local query="${1#*\?}" pair
  local -a pairs
  [[ "${1}" == *\?* && "${query}" != *%* ]] || return 0
  IFS='&' read -r -a pairs <<<"${query}"
  for pair in "${pairs[@]}"; do
    [[ "${pair}" != hostaddr=* ]] || return 0
    if [[ "${pair}" == host=* ]]; then
      printf '%s' "${pair#host=}"
      return 0
    fi
  done
}

[[ -z "${PGHOSTADDR:-}" && -z "${PGSERVICE:-}" ]] || refuse "PGHOSTADDR or PGSERVICE routes past the socket host"

host="${PGHOST:-}" uri_target="" pending=""
for arg in "$@"; do
  if [[ -n "${pending}" ]]; then
    host="${arg}" pending=""
    continue
  fi
  case "${arg}" in
    -h | --host) pending=1 ;;
    --host=*) host="${arg#--host=}" ;;
    -h*) host="${arg#-h}" ;;
    -[!-]*h*) refuse "host flag inside a short-option cluster: ${arg}" ;;
    postgres://* | postgresql://*)
      uri_target="$(uri_host "${arg}")"
      [[ -n "${uri_target}" ]] || refuse "URI without a socket host= query: ${arg}"
      ;;
    *host=* | *hostaddr=* | *service=*) refuse "connection-string argument: ${arg}" ;;
    *) ;;
  esac
done
[[ -z "${pending}" ]] || refuse "host flag without a value"
# a URI's parameters override the separate command-line options
[[ -z "${uri_target}" ]] || host="${uri_target}"
[[ "${host}" == "${SANDBOX}" ]] || refuse "target host '${host:-<default socket>}' is not the sandbox ${SANDBOX}"
exec "${REAL}" "$@"
