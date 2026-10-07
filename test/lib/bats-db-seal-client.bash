#!/usr/bin/env bash
# Sandbox-seal client (test/lib/bats-db-seal.bash): runs the real postgres client only when every host
# the call can reach is the sandbox socket directory; any other target, or one it cannot read, is refused.
# Usage: bats-db-seal-client.bash <client> <real-client-path> <sandbox-socket-dir> [client args...]
# Argv is read as the client's getopt_long reads it, from a per-client option table; an option outside
# the table, an abbreviated long option included, is refused rather than guessed.
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

# PostgreSQL 18 getopt_long tables: short options taking a value, short flags, then blank-delimited long
# options taking a value and long flags. pg_dump and pg_restore list their connection options only.
case "${CLIENT}" in
  psql)
    SHORT_VALUE=cdfFhLopPRTUv SHORT_FLAG='aAbeEHlnqsStVwWxXz01?'
    LONG_VALUE=' command dbname file field-separator host log-file output port pset record-separator'
    LONG_VALUE+=' table-attr username set variable '
    LONG_FLAG=' echo-all no-align echo-errors echo-queries echo-hidden field-separator-zero html list'
    LONG_FLAG+=' no-readline single-transaction quiet record-separator-zero single-step single-line'
    LONG_FLAG+=' tuples-only version no-password password expanded no-psqlrc csv help '
    ;;
  pg_isready)
    SHORT_VALUE=dhptU SHORT_FLAG='qV?'
    LONG_VALUE=' dbname host port timeout username ' LONG_FLAG=' quiet version help '
    ;;
  createdb)
    SHORT_VALUE=hpUODTElS SHORT_FLAG='wWeV?'
    LONG_VALUE=' host port username owner tablespace template encoding strategy lc-collate lc-ctype locale'
    LONG_VALUE+=' maintenance-db locale-provider builtin-locale icu-locale icu-rules '
    LONG_FLAG=' no-password password echo version help '
    ;;
  dropdb)
    SHORT_VALUE=hpU SHORT_FLAG='efiwWV?'
    LONG_VALUE=' host port username maintenance-db '
    LONG_FLAG=' echo force interactive if-exists no-password password version help '
    ;;
  pg_dump | pg_restore)
    SHORT_VALUE=dfFhpU SHORT_FLAG='wWV?'
    LONG_VALUE=' dbname file format host port username ' LONG_FLAG=' no-password password version help '
    ;;
  *) refuse "no option table for this client" ;;
esac
readonly SHORT_VALUE SHORT_FLAG LONG_VALUE LONG_FLAG

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

# Args: $1=option letter or long name, $2=its value. The last host value wins, as in the client.
take_value() {
  case "$1" in
    h | host) host="$2" ;;
    *) inspect_value "$2" ;;
  esac
}

# Flags up to the first option taking a value, which takes the rest of the cluster or, when nothing is
# left, the next argument. Arg: $1=the cluster, leading dash included.
scan_short_cluster() {
  local rest="${1#-}" opt
  while [[ -n "${rest}" ]]; do
    opt="${rest:0:1}" rest="${rest:1}"
    if [[ "${SHORT_VALUE}" == *"${opt}"* ]]; then
      if [[ -n "${rest}" ]]; then take_value "${opt}" "${rest}"; else pending="${opt}"; fi
      return 0
    fi
    [[ "${SHORT_FLAG}" == *"${opt}"* ]] || refuse "option -${opt} is not in the ${CLIENT} table: $1"
  done
}

# Exact names only: getopt_long also takes an unambiguous prefix, which the table cannot vouch for.
# Arg: $1=the argument, --name or --name=value.
scan_long_option() {
  local name="${1#--}"
  name="${name%%=*}"
  [[ "${name}" =~ ^[a-z][a-z0-9-]*$ ]] || refuse "malformed long option: $1"
  if [[ "${LONG_VALUE}" == *" ${name} "* ]]; then
    if [[ "$1" == *=* ]]; then take_value "${name}" "${1#*=}"; else pending="${name}"; fi
  elif [[ "${LONG_FLAG}" != *" ${name} "* || "$1" == *=* ]]; then
    refuse "long option outside the ${CLIENT} table, or a flag given a value: $1"
  fi
}

[[ -z "${PGHOSTADDR:-}" && -z "${PGSERVICE:-}" ]] || refuse "PGHOSTADDR or PGSERVICE routes past the socket host"
# measured on psql 18: with it set, parsing stops at the first operand, so a later -h is no host
[[ -z "${POSIXLY_CORRECT+set}" ]] || refuse "POSIXLY_CORRECT stops option parsing at the first operand"

# A dbname URI overrides the host, and one in another slot does not; requiring both to name the
# sandbox makes the verdict independent of which slot libpq reads. After --, every argument is an
# operand (dbname or user name).
host="${PGHOST:-}" pending="" operands=""
for arg in "$@"; do
  [[ ! "${arg}" =~ ${CONNECT_META} ]] || refuse "psql connect meta-command: ${arg}"
  if [[ -n "${pending}" ]]; then
    take_value "${pending}" "${arg}"
    pending=""
  elif [[ -n "${operands}" || "${arg}" == - || "${arg}" != -* ]]; then
    inspect_value "${arg}"
  elif [[ "${arg}" == -- ]]; then
    operands=1
  elif [[ "${arg}" == --* ]]; then
    scan_long_option "${arg}"
  else
    scan_short_cluster "${arg}"
  fi
done
[[ -z "${pending}" ]] || refuse "option ${pending} without a value"
[[ "${host}" == "${SANDBOX}" ]] || refuse "target host '${host:-<default socket>}' is not the sandbox ${SANDBOX}"
exec "${REAL}" "$@"
