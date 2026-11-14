#!/usr/bin/env bats
# shellcheck disable=SC2154,SC2329,SC2312  # bats injects BATS_*/status/output; the stubs are called by the sourced lib
# lib/ga-remote.sh — key material, network identity, config writes and the `glass-atrium remote` CLI.
# Hermetic: a sandbox GA_ROOT, real LibreSSL in that sandbox, stubbed route/arp/scutil/ipconfig/tmutil/launchctl,
# and a loopback stub of the monitor's three remote-cli routes. No real key folder, no real install.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  SANDBOX="$(mktemp -d)"
  export GA_ROOT="${SANDBOX}"
  unset ATRIUM_CONFIG_TOML
  KEY_DIR="${SANDBOX}/monitor/data/remote-access"
  CALLS="${SANDBOX}/calls.log"
  ROUTES="${SANDBOX}/routes.txt"
  REQUESTS="${SANDBOX}/requests.jsonl"
  mkdir -p "${SANDBOX}/monitor/data"
  : >"${CALLS}" && : >"${ROUTES}" && : >"${REQUESTS}"
  printf '[ports]\nmonitor = 16145\n\n[meta]\ntimezone = "auto"\n' >"${SANDBOX}/config.toml"
  ROUTE_OUT=$'   route to: default\ndestination: default\n    gateway: 192.168.0.1\n  interface: en1\n'
  ARP_OUT='? (192.168.0.1) at 0:1b:2c:d:4e:5f on en1 ifscope [ethernet]'
  WIFI_ADDRESS="192.168.0.10"
  IS_TERMINAL=false
  # shellcheck source=../scripts/lib/atrium-config.sh
  source "${GA}/scripts/lib/atrium-config.sh"
  # shellcheck source=../lib/ga-remote.sh
  source "${GA}/lib/ga-remote.sh"
  ga_remote_run() {
    local tool="$1"
    shift
    case "${tool}" in
      openssl) /usr/bin/openssl "$@" ;;
      curl) /usr/bin/curl "$@" ;;
      route) printf '%s' "${ROUTE_OUT}" ;;
      arp) printf '%s\n' "${ARP_OUT}" ;;
      scutil) printf 'Test-Mac\n' ;;
      ipconfig) printf '%s\n' "${WIFI_ADDRESS}" ;;
      tmutil | launchctl) printf '%s %s\n' "${tool}" "$*" >>"${CALLS}" ;;
      *) return 127 ;;
    esac
  }
  ga_remote_apply_config() { printf 'apply\n' >>"${CALLS}"; }
  ga_remote_is_terminal() { "${IS_TERMINAL}"; }
}

teardown() {
  if [[ -n "${STUB_PID:-}" ]]; then kill "${STUB_PID}" 2>/dev/null || true; wait "${STUB_PID}" 2>/dev/null || true; fi
  # shellcheck source=../scripts/lib/path-guard.sh
  source "${GA}/scripts/lib/path-guard.sh"
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

# Loopback stub of the monitor: answers each request from ${ROUTES} ("METHOD PATH STATUS BODY") and logs it.
start_monitor_stub() {
  cat >"${SANDBOX}/stub.py" <<'PY'
import http.server, json, sys
log, routes, portfile = sys.argv[1:4]
class Handler(http.server.BaseHTTPRequestHandler):
    def answer(self):
        with open(log, "a") as f:
            f.write(json.dumps({"method": self.command, "path": self.path,
                                "headers": {k.lower(): v for k, v in self.headers.items()}}) + "\n")
        status, body = 404, '{"error":"device_not_found"}'
        for line in open(routes):
            method, path, code, text = line.rstrip("\n").split(" ", 3)
            if method == self.command and path == self.path:
                status, body = int(code), text
        self.send_response(status)
        if status == 302:
            self.send_header("Location", body)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body.encode())
    do_GET = do_POST = do_DELETE = answer
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
open(portfile, "w").write(str(server.server_port))
server.serve_forever()
PY
  python3 -I "${SANDBOX}/stub.py" "${REQUESTS}" "${ROUTES}" "${SANDBOX}/port" 3>&- &
  STUB_PID=$!
  local tries=0
  until [[ -s "${SANDBOX}/port" ]] || ((tries++ > 50)); do sleep 0.1; done
  export ATRIUM_MONITOR_PORT
  ATRIUM_MONITOR_PORT="$(cat "${SANDBOX}/port")"
}

stub_route() { printf '%s\n' "$*" >>"${ROUTES}"; }

file_sum() { cksum <"$1"; }

# --- key material -----------------------------------------------------------------------------------

@test "CA and leaf are owner-only under a permissive umask, chain to the CA and name the host and address" {
  umask 022
  ga_remote_create_ca "${KEY_DIR}"
  ga_remote_issue_leaf "${KEY_DIR}"
  local loose path
  loose="$(ga_remote_get_loose_modes "${KEY_DIR}")"
  [[ -z "${loose}" ]] || { echo "not owner-only: ${loose}"; return 1; }
  [[ "$(ga_remote_get_mode "${KEY_DIR}")" == "700" ]] || return 1
  for path in ca.key ca.pem leaf.key leaf.pem; do
    [[ "$(ga_remote_get_mode "${KEY_DIR}/${path}")" == "600" ]] || { echo "${path}"; return 1; }
  done
  ga_remote_is_leaf_for "${KEY_DIR}" "${KEY_DIR}/leaf.pem" "test-mac.local" "${WIFI_ADDRESS}"
}

@test "the key dir gets the sticky Time Machine exclusion, never the root-only fixed-path form" {
  ga_remote_create_ca "${KEY_DIR}"
  grep -qx "tmutil addexclusion ${KEY_DIR}" "${CALLS}"
}

@test "a leaf that does not verify against the CA never replaces the current leaf" {
  ga_remote_create_ca "${KEY_DIR}"
  ga_remote_issue_leaf "${KEY_DIR}"
  local before
  before="$(file_sum "${KEY_DIR}/leaf.pem")"
  # same CA key, but a certificate whose name constraints exclude the Mac's names → signing works, verify fails
  printf '%s\n' '[req]' 'distinguished_name = dn' 'x509_extensions = v3_ca' 'prompt = no' '[dn]' 'CN = narrow' \
    '[v3_ca]' 'basicConstraints = critical, CA:TRUE, pathlen:0' 'keyUsage = critical, keyCertSign' \
    'nameConstraints = critical, permitted;DNS:example.invalid' >"${SANDBOX}/narrow.cnf"
  /usr/bin/openssl req -x509 -new -key "${KEY_DIR}/ca.key" -days 30 -config "${SANDBOX}/narrow.cnf" \
    -out "${KEY_DIR}/ca.pem"
  run ga_remote_main reissue
  [[ "${status}" -eq 7 ]] || { echo "${output}"; return 1; }
  [[ "$(file_sum "${KEY_DIR}/leaf.pem")" == "${before}" ]] || return 1
  [[ -z "$(find "${KEY_DIR}" -name '.work.*')" ]] || return 1
}

@test "reissue writes a new leaf and leaves config.toml untouched" {
  ga_remote_create_ca "${KEY_DIR}"
  ga_remote_issue_leaf "${KEY_DIR}"
  local leaf_before config_before
  leaf_before="$(file_sum "${KEY_DIR}/leaf.pem")"
  config_before="$(file_sum "${SANDBOX}/config.toml")"
  run ga_remote_main reissue
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "$(file_sum "${KEY_DIR}/leaf.pem")" != "${leaf_before}" ]] || return 1
  [[ "$(file_sum "${SANDBOX}/config.toml")" == "${config_before}" ]] || return 1
}

@test "a leaf is due when missing or when it no longer names the current address, and not when current" {
  ga_remote_create_ca "${KEY_DIR}"
  ga_remote_is_leaf_due "${KEY_DIR}" || { echo "missing leaf not due"; return 1; }
  ga_remote_issue_leaf "${KEY_DIR}"
  ! ga_remote_is_leaf_due "${KEY_DIR}" || { echo "current leaf due"; return 1; }
  WIFI_ADDRESS="192.168.0.77"
  ga_remote_is_leaf_due "${KEY_DIR}" || { echo "moved address not due"; return 1; }
}

# --- network identity -------------------------------------------------------------------------------

@test "network identity is the gateway and its ARP entry on the route's interface, else unreadable" {
  local good_arp="${ARP_OUT}"
  local rows=(
    "matching entry|${good_arp}|192.168.0.1|en1 192.168.0.1 00:1b:2c:0d:4e:5f"
    "no ARP entry||192.168.0.1|"
    "entry on another interface|? (192.168.0.1) at 0:1b:2c:d:4e:5f on en0 ifscope [ethernet]|192.168.0.1|"
    "incomplete entry|? (192.168.0.1) at (incomplete) on en1 ifscope [ethernet]|192.168.0.1|"
    "public gateway|? (8.8.8.8) at 0:1b:2c:d:4e:5f on en1 ifscope [ethernet]|8.8.8.8|"
  )
  local row name gateway expected actual
  for row in "${rows[@]}"; do
    IFS='|' read -r name ARP_OUT gateway expected <<<"${row}"
    ROUTE_OUT=$'    gateway: '"${gateway}"$'\n  interface: en1\n'
    actual="$(ga_remote_get_network_identity)" || actual=""
    [[ "${actual}" == "${expected}" ]] || { echo "${name}: '${actual}'"; return 1; }
  done
}

# --- on / trust (interactive, typed confirmation, no skip flag) -----------------------------------

@test "on and trust refuse without a terminal or the typed word, and write nothing" {
  local rows=("on|no terminal|false|on" "on|wrong word|true|yes" "trust|no terminal|false|trust" "trust|wrong word|true|y")
  local row sub name answer config_before
  config_before="$(file_sum "${SANDBOX}/config.toml")"
  for row in "${rows[@]}"; do
    IFS='|' read -r sub name IS_TERMINAL answer <<<"${row}"
    run ga_remote_main "${sub}" <<<"${answer}"
    [[ "${status}" -eq 4 ]] || { echo "${sub} ${name}: ${status} ${output}"; return 1; }
  done
  [[ "$(file_sum "${SANDBOX}/config.toml")" == "${config_before}" ]] || return 1
  [[ ! -e "${KEY_DIR}" ]] || return 1
  [[ ! -s "${CALLS}" ]] || return 1
}

@test "on creates the keys, writes enabled and the default port owner-only, restarts and prints the device count" {
  start_monitor_stub
  stub_route 'GET /api/remote/cli/devices 200 {"devices":[{"id":"3","label":"phone","createdAt":"2026-11-14T05:20:11.123Z","lastSeenAt":"2026-11-14T06:01:02.456Z"}]}'
  IS_TERMINAL=true
  run ga_remote_main on <<<"on"
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "$(atrium_toml_get "[remote_access]" "enabled")" == "true" ]] || return 1
  [[ "$(atrium_toml_get "[remote_access]" "port")" == "16146" ]] || return 1
  [[ "$(atrium_toml_get "[ports]" "monitor")" == "16145" ]] || return 1
  [[ "$(ga_remote_get_mode "${SANDBOX}/config.toml")" == "600" ]] || return 1
  [[ -f "${KEY_DIR}/ca.key" && -f "${KEY_DIR}/leaf.pem" ]] || return 1
  grep -qx apply "${CALLS}"
  [[ "${output}" == *"1 active device(s)"* ]] || return 1
}

@test "on replaces a device's off with on, owner-only, so the next monitor start follows config" {
  start_monitor_stub
  stub_route 'GET /api/remote/cli/devices 200 {"devices":[]}'
  mkdir -p "${KEY_DIR}"
  printf 'off\n' >"${KEY_DIR}/access-state"
  IS_TERMINAL=true
  run ga_remote_main on <<<"on"
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "$(cat "${KEY_DIR}/access-state")" == "on" ]] || return 1
  [[ "$(ga_remote_get_mode "${KEY_DIR}/access-state")" == "600" ]] || return 1
}

@test "trust shows the identity and the accident-guard notice, then appends it once" {
  IS_TERMINAL=true
  run ga_remote_main trust <<<"trust"
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *"gateway hardware address: 00:1b:2c:0d:4e:5f"* && "${output}" == *"not authentication"* ]] || return 1
  [[ "$(atrium_toml_get "[remote_access]" "trusted_networks")" == "192.168.0.1@00:1b:2c:0d:4e:5f" ]] || return 1
  run ga_remote_main trust <<<"trust"
  [[ "${status}" -eq 0 && "${output}" == *"already trusted"* ]] || { echo "${output}"; return 1; }
  [[ "$(grep -c apply "${CALLS}")" -eq 1 ]] || return 1
}

@test "trust on an unreadable network writes nothing" {
  IS_TERMINAL=true
  ARP_OUT=""
  run ga_remote_main trust <<<"trust"
  [[ "${status}" -eq 6 ]] || { echo "${output}"; return 1; }
  [[ -z "$(atrium_toml_get "[remote_access]" "trusted_networks")" ]] || return 1
  [[ ! -s "${CALLS}" ]] || return 1
}

# --- the monitor channel ----------------------------------------------------------------------------

@test "off reports revoked only on the monitor's confirmation and writes off either way" {
  start_monitor_stub
  local rows=('confirmed|200 {"revoked":2}|0|revoked 2 device(s)' 'refused|500 {"error":"x"}|3|devices were NOT revoked')
  local row name answer expected_status expected_text
  for row in "${rows[@]}"; do
    IFS='|' read -r name answer expected_status expected_text <<<"${row}"
    printf 'POST /api/remote/cli/devices/revoke-all %s\n' "${answer}" >"${ROUTES}"
    printf '\n[remote_access]\nenabled = true\nport = 16146\n' >>"${SANDBOX}/config.toml"
    run ga_remote_main off
    [[ "${status}" -eq "${expected_status}" && "${output}" == *"${expected_text}"* ]] \
      || { echo "${name}: ${status} ${output}"; return 1; }
    [[ "$(atrium_toml_get "[remote_access]" "enabled")" == "false" ]] || { echo "${name}: still on"; return 1; }
    printf '[ports]\nmonitor = 16145\n' >"${SANDBOX}/config.toml"
  done
  [[ "$(grep -c apply "${CALLS}")" -eq 2 ]] || return 1
}

@test "channel requests go to loopback past a proxy, carry the CLI header and no browser header, and follow no redirect" {
  start_monitor_stub
  stub_route 'GET /api/remote/cli/devices 302 /elsewhere'
  export http_proxy=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9
  run ga_remote_main list
  [[ "${status}" -eq 5 ]] || { echo "${output}"; return 1; }
  [[ "$(wc -l <"${REQUESTS}")" -eq 1 ]] || return 1
  jq -e '.headers["x-glass-atrium-cli"] == "remote-access"
    and ([.headers | keys[] | select(test("^(origin|referer|cookie|sec-fetch-.*)$"))] | length == 0)' "${REQUESTS}"
}

@test "revoke builds a request only for a decimal id within the monitor's bound" {
  start_monitor_stub
  local id
  for id in '1;rm' '0' '-1' 'abc' '1234567890123456789' '' '../x'; do
    run ga_remote_main revoke "${id}"
    [[ "${status}" -eq 2 ]] || { echo "id '${id}': ${status}"; return 1; }
  done
  [[ ! -s "${REQUESTS}" ]] || return 1
  stub_route 'DELETE /api/remote/cli/devices/123456789012345678 200 {"revoked":1}'
  run ga_remote_main revoke 123456789012345678
  [[ "${status}" -eq 0 && "${output}" == *"revoked device 123456789012345678"* ]] || { echo "${output}"; return 1; }
}

@test "revoke reports revoked only when the monitor answers revoked:1, and not-found on its 404" {
  start_monitor_stub
  stub_route 'DELETE /api/remote/cli/devices/7 204 '
  stub_route 'DELETE /api/remote/cli/devices/9 200 {"revoked":0}'
  local rows=('no confirmation body|7|5|NOT revoked' 'zero revoked|9|5|NOT revoked' 'unknown device|8|1|not found')
  local row name id expected_status expected_text
  for row in "${rows[@]}"; do
    IFS='|' read -r name id expected_status expected_text <<<"${row}"
    run ga_remote_main revoke "${id}"
    [[ "${status}" -eq "${expected_status}" && "${output}" == *"${expected_text}"* ]] \
      || { echo "${name}: ${status} ${output}"; return 1; }
  done
}

@test "list prints labels as data with control characters stripped" {
  start_monitor_stub
  stub_route 'GET /api/remote/cli/devices 200 {"devices":[{"id":"1","label":"ph\u001b[31mone","createdAt":"c","lastSeenAt":"s"}]}'
  run ga_remote_main list
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "${output}" == *$'1\tph[31mone\tc\ts'* && "${output}" != *$'\e'* ]] || return 1
}

@test "registration has no CLI path: register and unknown subcommands are usage errors" {
  local sub
  for sub in register open-registration ''; do
    run ga_remote_main "${sub}"
    [[ "${status}" -eq 2 && "${output}" == *"no CLI registration"* ]] || { echo "'${sub}': ${output}"; return 1; }
  done
}

@test "glass-atrium routes remote to the remote CLI" {
  run bash "${GA}/glass-atrium" remote register
  [[ "${status}" -eq 2 && "${output}" == *"usage: glass-atrium remote"* ]] || { echo "${output}"; return 1; }
}
