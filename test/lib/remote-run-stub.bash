# shellcheck shell=bash
# ga_remote_run shadow — the system tools lib/ga-remote.sh calls, answered from the test's variables.
# Sourced after lib/ga-remote.sh: in the shell that calls it (a bats body, a `bash -c` doctor driver after
# lib/ga-core.sh), or in a doctor run as its own process through make_remote_stub_lib.
# An unset variable answers as nothing found, so a child that inherits none sees no listener and records nothing.

ga_remote_run() {
  local tool="$1"
  shift
  case "${tool}" in
    openssl) /usr/bin/openssl "$@" ;;
    route) printf '%s' "${ROUTE_OUT:-}" ;;
    arp) printf '%s\n' "${ARP_OUT:-}" ;;
    scutil) printf '%s\n' "${HOST_NAME:-}" ;;
    ipconfig) printf '%s\n' "${WIFI_ADDRESS:-}" ;;
    tmutil)
      printf 'tmutil %s\n' "$*" >>"${CALLS:-/dev/null}"
      [[ "$1" != "isexcluded" ]] || printf '%s    %s\n' "${EXCLUDED:-}" "$2"
      ;;
    launchctl) printf 'launchctl %s\n' "$*" >>"${CALLS:-/dev/null}" ;;
    lsof)
      [[ -n "${LISTEN_NAME:-}" ]] || return 1
      printf 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 501 owner 23u IPv4 0x1 0t0 TCP %s (LISTEN)\n' "${LISTEN_NAME}"
      ;;
    socketfilterfw) printf '%s\n' "${FIREWALL_OUT:-}" ;;
    *) return 127 ;;
  esac
}

# Doctor-child seam: <root>/lib links every real lib file, and its ga-remote.sh sources the real one, then this shadow.
# Args: $1 = GA root being built · $2 = the repo root whose lib/ is linked.
make_remote_stub_lib() {
  local root="$1" repo="$2" src
  mkdir -p "${root}/lib"
  for src in "${repo}"/lib/*.sh; do
    [[ "${src##*/}" == "ga-remote.sh" ]] || ln -s "${src}" "${root}/lib/${src##*/}"
  done
  printf '# shellcheck shell=bash\nsource %q && source %q\n' "${repo}/lib/ga-remote.sh" \
    "${repo}/test/lib/remote-run-stub.bash" >"${root}/lib/ga-remote.sh"
}

# Doctor-process GA root: the entry point COPIED (resolve_self follows a symlinked one back to the checkout),
# lib/ from make_remote_stub_lib, every other top-level entry linked — .git included, so the source-dev routing holds.
# Args: $1 = GA root being built (an existing directory) · $2 = the repo root it mirrors.
make_remote_stub_root() {
  local root="$1" repo="$2" entry
  cp "${repo}/glass-atrium" "${root}/glass-atrium"
  make_remote_stub_lib "${root}" "${repo}"
  for entry in "${repo}"/* "${repo}"/.[!.]*; do
    [[ -e "${root}/${entry##*/}" ]] || ln -s "${entry}" "${root}/${entry##*/}"
  done
}
