#!/usr/bin/env bash
# Sandbox-seal client (test/lib/bats-db-seal.bash): runs the real postgres client only when every host
# the call can reach is the sandbox socket directory; any other target, or one it cannot read, is refused.
# Usage: bats-db-seal-client.bash <client> <real-client-path> <sandbox-socket-dir> [client args...]
# Limit: psql meta-commands are read from argv only — a \connect arriving on stdin, through -f, \i or
# a psqlrc is not seen, since reading a script stream here would consume it before the client does.
set -Eeuo pipefail
IFS=$'\n\t'

readonly CLIENT="${1:?client name}" REAL="${2:?real client path}" SANDBOX="${3:?sandbox socket dir}"
shift 3

# conninfo keyword that routes the connection; libpq allows blanks before "=" and no blank after a quote
readonly CONNINFO_ROUTE='(host|hostaddr|service)[[:space:]]*='
# psql's connect meta-command (\c or \connect); a meta-command name ends at a blank, a backslash or the end
readonly CONNECT_META='\\c(onnect)?([[:space:]]|\\|$)'

refuse() {
  printf '%s: refused by the bats live-DB seal (test/lib/bats-db-seal.bash): %s\n' "${CLIENT}" "$1" >&2
  exit 2
}

# libpq lets a URI query parameter override the authority and keeps the last of a repeated one, so a
# URI passes only with exactly one host= naming the sandbox, no hostaddr or service, and no %-escape.
check_uri() {
  local uri="$1" rest pair hosts=0
  [[ "${uri}" == *\?* ]] || refuse "URI without a socket host= query: ${uri}"
  rest="${uri#*\?}"
  [[ "${rest}" != *%* ]] || refuse "percent-encoded URI query: ${uri}"
  rest+="&"
  while [[ -n "${rest}" ]]; do
    pair="${rest%%&*}" rest="${rest#*&}"
    case "${pair}" in
      hostaddr=* | service=*) refuse "URI routes past the socket host: ${uri}" ;;
      host=*)
        hosts=$((hosts + 1))
        [[ "${pair#host=}" == "${SANDBOX}" ]] || refuse "URI host is not the sandbox ${SANDBOX}: ${uri}"
        ;;
      *) ;;
    esac
  done
  [[ "${hosts}" -eq 1 ]] || refuse "URI repeats host=: ${uri}"
}

# A value libpq may read as a dbname: a URI is checked, a URI anywhere else inside it is refused, and
# so is a conninfo routing keyword.
inspect_value() {
  case "$1" in
    postgres://* | postgresql://*) check_uri "$1" ;;
    *postgres://* | *postgresql://*) refuse "URI inside another argument: $1" ;;
    *) [[ ! "$1" =~ ${CONNINFO_ROUTE} ]] || refuse "connection-string routing keyword: $1" ;;
  esac
}

[[ -z "${PGHOSTADDR:-}" && -z "${PGSERVICE:-}" ]] || refuse "PGHOSTADDR or PGSERVICE routes past the socket host"

# A dbname URI overrides the host, and one in another slot does not; requiring both to name the
# sandbox makes the verdict independent of which slot libpq reads.
host="${PGHOST:-}" pending=""
for arg in "$@"; do
  [[ ! "${arg}" =~ ${CONNECT_META} ]] || refuse "psql connect meta-command: ${arg}"
  if [[ -n "${pending}" ]]; then
    host="${arg}" pending=""
    continue
  fi
  case "${arg}" in
    -h | --host) pending=1 ;;
    --host=*) host="${arg#--host=}" ;;
    --h*) refuse "abbreviated or non-host --h option: ${arg}" ;;
    -h*) host="${arg#-h}" ;;
    --*=*) inspect_value "${arg#*=}" ;;
    -d?*) inspect_value "${arg#-d}" ;;
    -[!-]*h*) refuse "host flag inside a short-option cluster: ${arg}" ;;
    *) inspect_value "${arg}" ;;
  esac
done
[[ -z "${pending}" ]] || refuse "host flag without a value"
[[ "${host}" == "${SANDBOX}" ]] || refuse "target host '${host:-<default socket>}' is not the sandbox ${SANDBOX}"
exec "${REAL}" "$@"
