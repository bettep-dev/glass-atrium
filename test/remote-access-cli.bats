#!/usr/bin/env bats
# shellcheck disable=SC2154,SC2329,SC2312,SC2030,SC2031  # bats injects BATS_*/status/output; the stubs are called by the sourced lib; each @test's subshell owns the stub values its helpers read
# lib/ga-remote.sh — key material, network identity, config writes, the `glass-atrium remote` CLI and the
# Mac page's write step (scripts/remote-access-set.sh).
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
  CONFIGD_GLOBAL=""
  CONFIGD_SERVICE=""
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
      scutil)
        # no argv = a configd query on stdin → the global record or the primary service's record
        if (($# > 0)); then printf 'Test-Mac\n'; elif [[ "$(cat)" == *Global* ]]; then
          printf '%s\n' "${CONFIGD_GLOBAL}"
        else printf '%s\n' "${CONFIGD_SERVICE}"; fi
        ;;
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
# Refuses as the monitor's remote-cli gate does (cli-routes.ts → refuseUnlessCli) before any route answers.
start_monitor_stub() {
  cat >"${SANDBOX}/stub.py" <<'PY'
import http.server, json, re, sys
log, routes, portfile = sys.argv[1:4]
BROWSER = ("sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "origin", "referer", "cookie")
def route_answer(method, path):
    for line in open(routes):
        m, p, code, text = line.rstrip("\n").split(" ", 3)
        if m == method and p == path:
            return int(code), text
    if method == "DELETE" and re.fullmatch(r"/api/remote/cli/devices/[1-9][0-9]{0,17}", path):
        return 404, '{"error":"device_not_found"}'
    return 404, json.dumps({"message": f"Route {method}:{path} not found", "error": "Not Found", "statusCode": 404})
class Handler(http.server.BaseHTTPRequestHandler):
    def answer(self):
        headers = {k.lower(): v for k, v in self.headers.items()}
        with open(log, "a") as f:
            f.write(json.dumps({"method": self.command, "path": self.path, "headers": headers}) + "\n")
        if any(name in headers for name in BROWSER) or headers.get("x-glass-atrium-cli") != "remote-access":
            status, body = 403, '{"error":"not_cli"}'
        elif "transfer-encoding" in headers or headers.get("content-length", "0") != "0":
            status, body = 400, '{"error":"body_not_allowed"}'
        else:
            status, body = route_answer(self.command, self.path)
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

# configd's records as macOS prints them, shared with monitor/test/remote-network.unit.test.ts → one capture, one row set
CONFIGD_FIXTURES="${GA}/monitor/test/fixtures/configd"

# The captured service record (`scutil` → show State:/Network/Service/<id>/IPv4) with this interface and signature.
configd_service_for() {
  INTERFACE="$1" SIGNATURE="$2" awk '
    $1 == "InterfaceName" { sub(/: .*/, ": " ENVIRON["INTERFACE"]) }
    $1 == "NetworkSignature" { sub(/: .*/, ": " ENVIRON["SIGNATURE"]) }
    { print }
  ' "${CONFIGD_FIXTURES}/service-ipv4.txt"
}

@test "network identity is the gateway and its ARP entry on the route's interface, else unreadable" {
  local good_arp="${ARP_OUT}"
  local rows=(
    "matching entry|${good_arp}|192.168.0.1|en1 192.168.0.1 00:1b:2c:0d:4e:5f"
    "no ARP entry, no configd record||192.168.0.1|"
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

@test "with no ARP entry, network identity is configd's record of the same router on the route's interface" {
  ARP_OUT='192.168.45.1 (192.168.45.1) -- no entry'
  ROUTE_OUT=$'    gateway: 192.168.45.1\n  interface: en1\n'
  CONFIGD_GLOBAL="$(<"${CONFIGD_FIXTURES}/global-ipv4.txt")"
  local name network_interface signature address expected actual count=0
  while IFS='|' read -r name network_interface signature address; do
    CONFIGD_SERVICE="$(configd_service_for "${network_interface}" "${signature}")"
    expected="en1 192.168.45.1 ${address}"
    [[ "${address}" != "-" ]] || expected=""
    actual="$(ga_remote_get_network_identity)" || actual=""
    [[ "${actual}" == "${expected}" ]] || { echo "${name}: '${actual}'"; return 1; }
    count=$((count + 1))
  done <"${CONFIGD_FIXTURES}/router-rows.txt"
  ((count > 0)) || { echo "no router rows read"; return 1; }
}

# --- on / trust (interactive, typed confirmation, no skip flag) -----------------------------------

@test "on and trust refuse without a terminal or the typed word, and write nothing" {
  local rows=("on|no terminal|false|on" "on|wrong word|true|yes" "trust|no terminal|false|trust" "trust|wrong word|true|y"
    "on --yes|a skip flag, no terminal|false|" "trust --force|a skip flag, no terminal|false|")
  local row sub name answer config_before
  config_before="$(file_sum "${SANDBOX}/config.toml")"
  for row in "${rows[@]}"; do
    IFS='|' read -r sub name IS_TERMINAL answer <<<"${row}"
    # shellcheck disable=SC2086  # a row's subcommand and its flag are two argv words
    run ga_remote_main ${sub} <<<"${answer}"
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

@test "revoke reports revoked only when the monitor answers revoked:1, and not-found only on its device_not_found" {
  start_monitor_stub
  stub_route 'DELETE /api/remote/cli/devices/7 204 '
  stub_route 'DELETE /api/remote/cli/devices/9 200 {"revoked":0}'
  stub_route 'DELETE /api/remote/cli/devices/6 404 {"message":"Route DELETE:/api/remote/cli/devices/6 not found","error":"Not Found","statusCode":404}'
  local rows=('no confirmation body|7|5|NOT revoked' 'zero revoked|9|5|NOT revoked' 'unknown device|8|1|not found'
    'a 404 that is not device_not_found|6|5|NOT revoked')
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

@test "glass-atrium routes remote to the remote CLI, whose usage and help never name the page's write step" {
  run bash "${GA}/glass-atrium" remote register
  [[ "${status}" -eq 2 && "${output}" == *"usage: glass-atrium remote"* && "${output}" != *"remote-access-set"* ]] \
    || { echo "${output}"; return 1; }
  run bash "${GA}/glass-atrium" --help
  [[ "${status}" -eq 0 && "${output}" == *"glass-atrium remote <sub>"* && "${output}" != *"remote-access-set"* ]] \
    || { echo "${output}"; return 1; }
  # the step's own argv through the public entry reaches the terminal acts, which refuse without a terminal
  local config_before argv
  config_before="$(file_sum "${SANDBOX}/config.toml")"
  for argv in 'on' 'trust en1 192.168.0.1 00:1b:2c:0d:4e:5f'; do
    # shellcheck disable=SC2086  # a row's argv is split into its words
    run bash "${GA}/glass-atrium" remote ${argv} </dev/null
    [[ "${status}" -eq 4 ]] || { echo "remote ${argv}: ${status} ${output}"; return 1; }
  done
  [[ "$(file_sum "${SANDBOX}/config.toml")" == "${config_before}" && ! -e "${KEY_DIR}" ]] || return 1
}

# --- the Mac page's write step (scripts/remote-access-set.sh: no terminal, no restart, no monitor call) --

# config.toml with the tables the env renderer reads
write_render_config() {
  mkdir -p "${SANDBOX}/monitor/data/documents"
  printf '[ports]\nmonitor = 16145\n\n[paths]\nmonitor_docs_html_root = "%s"\n' "${SANDBOX}/monitor/data/documents" \
    >"${SANDBOX}/config.toml"
  printf '\n[daemon.autoagent-cycle]\ntime = "04:30"\n\n[daemon.wiki-compile]\ntime = "04:50"\n' >>"${SANDBOX}/config.toml"
}

# The page step in its own process with this file's tool stubs and no terminal (stdin closed, output captured).
run_page_step() {
  declare -f ga_remote_run >"${SANDBOX}/stubs.sh"
  ROUTE_OUT="${ROUTE_OUT}" ARP_OUT="${ARP_OUT}" WIFI_ADDRESS="${WIFI_ADDRESS}" CALLS="${CALLS}" \
    CONFIGD_GLOBAL="${CONFIGD_GLOBAL}" CONFIGD_SERVICE="${CONFIGD_SERVICE}" \
    run bash -c 'source "$1" && source "$2" && shift 2 && main "$@"' _ \
    "${GA}/scripts/remote-access-set.sh" "${SANDBOX}/stubs.sh" "$@" </dev/null
}

rendered_access() { grep -E '^ATRIUM_REMOTE_ACCESS=' "${SANDBOX}/monitor/.env"; }

@test "the page's on writes the keys, the on state, enabled and the default port, and renders the env without a restart" {
  write_render_config
  mkdir -p "${KEY_DIR}" && printf 'off\n' >"${KEY_DIR}/access-state"
  run_page_step on
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "$(atrium_toml_get "[remote_access]" "enabled")" == "true" ]] || return 1
  [[ "$(atrium_toml_get "[remote_access]" "port")" == "16146" ]] || return 1
  [[ -f "${KEY_DIR}/ca.key" && -f "${KEY_DIR}/leaf.pem" && -z "$(ga_remote_get_loose_modes "${KEY_DIR}")" ]] || return 1
  [[ "$(cat "${KEY_DIR}/access-state")" == "on" ]] || return 1
  [[ "$(rendered_access)" == "ATRIUM_REMOTE_ACCESS=on" ]] || { rendered_access; return 1; }
  ! grep -q launchctl "${CALLS}" || { echo "restarted"; return 1; }
}

@test "the page's on again keeps the CA key and certificate the first on made" {
  write_render_config
  run_page_step on
  local ca_before
  ca_before="$(file_sum "${KEY_DIR}/ca.key")$(file_sum "${KEY_DIR}/ca.pem")"
  run_page_step on
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "$(file_sum "${KEY_DIR}/ca.key")$(file_sum "${KEY_DIR}/ca.pem")" == "${ca_before}" ]] || return 1
}

# A config write either replaces config.toml whole by a rename, or leaves it byte-identical; no temp file stays.
@test "a config write renames a complete file into place, and a failed write leaves config.toml as it was" {
  printf '\n[remote_access]\nenabled = false\n' >>"${SANDBOX}/config.toml"
  local inode_before sum_before
  inode_before="$(ls -i "${SANDBOX}/config.toml")"
  ga_remote_set_config enabled true
  [[ "$(ls -i "${SANDBOX}/config.toml")" != "${inode_before}" ]] || { echo "rewritten in place"; return 1; }
  [[ "$(atrium_toml_get "[remote_access]" "enabled")" == "true" ]] || return 1
  sum_before="$(file_sum "${SANDBOX}/config.toml")"
  awk() { printf '[remote_access]\n'; return 1; }
  ! ga_remote_set_config enabled false || { echo "a failed write reported success"; return 1; }
  unset -f awk
  [[ "$(file_sum "${SANDBOX}/config.toml")" == "${sum_before}" ]] || { echo "partial write reached config.toml"; return 1; }
  [[ -z "$(find "${SANDBOX}" -maxdepth 1 -name '.config.toml.*')" ]] || { echo "temp file left"; return 1; }
}

# The network the stubs read, as the monitor hands the confirm's identity to the step: interface, gateway, address.
SHOWN=(en1 192.168.0.1 00:1b:2c:0d:4e:5f)

@test "the page's trust writes the network it reads itself when it is the one shown, needs no terminal, and writes it once" {
  write_render_config
  printf '\n[remote_access]\nenabled = true\nport = 16146\n' >>"${SANDBOX}/config.toml"
  local rows=('new network|0|192.168.0.1@00:1b:2c:0d:4e:5f' 'already trusted|9|192.168.0.1@00:1b:2c:0d:4e:5f')
  local row name want_status want_list others_before
  others_before="$(grep -v '^trusted_networks' "${SANDBOX}/config.toml")"
  for row in "${rows[@]}"; do
    IFS='|' read -r name want_status want_list <<<"${row}"
    run_page_step trust "${SHOWN[@]}"
    [[ "${status}" -eq "${want_status}" ]] || { echo "${name}: ${status} ${output}"; return 1; }
    [[ "$(atrium_toml_get "[remote_access]" "trusted_networks")" == "${want_list}" ]] || { echo "${name}: list"; return 1; }
  done
  grep -q '^ATRIUM_REMOTE_TRUSTED_NETWORKS=192.168.0.1@00:1b:2c:0d:4e:5f$' "${SANDBOX}/monitor/.env" || return 1
  [[ "$(grep -v '^trusted_networks' "${SANDBOX}/config.toml")" == "${others_before}" ]] \
    || { echo "a line other than the trusted list changed"; return 1; }
  [[ ! -e "${KEY_DIR}" ]] || { echo "trust touched the key dir"; return 1; }
  ! grep -q launchctl "${CALLS}" || { echo "restarted"; return 1; }
}

@test "the page's trust exits 10 and writes nothing when the network it reads is not the one shown" {
  write_render_config
  printf '\n[remote_access]\nenabled = true\nport = 16146\n' >>"${SANDBOX}/config.toml"
  local rows=('another router|en1 192.168.0.254 00:1b:2c:0d:4e:5f' 'another router hardware address|en1 192.168.0.1 00:1b:2c:0d:4e:60'
    'another link to the same router|en0 192.168.0.1 00:1b:2c:0d:4e:5f')
  local row name shown config_before
  config_before="$(file_sum "${SANDBOX}/config.toml")"
  for row in "${rows[@]}"; do
    IFS='|' read -r name shown <<<"${row}"
    # shellcheck disable=SC2086  # a row's network is three argv words
    run_page_step trust ${shown}
    [[ "${status}" -eq 10 ]] || { echo "${name}: ${status} ${output}"; return 1; }
  done
  [[ "$(file_sum "${SANDBOX}/config.toml")" == "${config_before}" && ! -e "${SANDBOX}/monitor/.env" ]] || return 1
}

@test "the page's trust writes nothing and exits apart for an unreadable network and a malformed trusted list" {
  local rows=("unreadable network||${GA_REMOTE_NETWORK_UNREADABLE}|network identity unreadable"
    "malformed trusted list|8.8.8.8@00:1b:2c:0d:4e:5f|${GA_REMOTE_CONFIG_MALFORMED}|trusted_networks is malformed")
  local row name trusted want_status want_text config_before
  for row in "${rows[@]}"; do
    IFS='|' read -r name trusted want_status want_text <<<"${row}"
    write_render_config
    if [[ -n "${trusted}" ]]; then
      printf '\n[remote_access]\ntrusted_networks = "%s"\n' "${trusted}" >>"${SANDBOX}/config.toml"
      ARP_OUT='? (192.168.0.1) at 0:1b:2c:d:4e:5f on en1 ifscope [ethernet]'
    else
      ARP_OUT=""
    fi
    config_before="$(file_sum "${SANDBOX}/config.toml")"
    run_page_step trust "${SHOWN[@]}"
    [[ -n "${want_status}" && "${status}" -eq "${want_status}" && "${output}" == *"${want_text}"* ]] \
      || { echo "${name}: ${status} ${output}"; return 1; }
    [[ "$(file_sum "${SANDBOX}/config.toml")" == "${config_before}" && ! -e "${SANDBOX}/monitor/.env" ]] \
      || { echo "${name}: written"; return 1; }
  done
}

@test "the page's off writes enabled false and renders the env, with no monitor call and no restart" {
  write_render_config
  printf '\n[remote_access]\nenabled = true\nport = 16146\n' >>"${SANDBOX}/config.toml"
  start_monitor_stub
  run_page_step off
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  [[ "$(atrium_toml_get "[remote_access]" "enabled")" == "false" ]] || return 1
  [[ "$(rendered_access)" == "ATRIUM_REMOTE_ACCESS=off" ]] || { rendered_access; return 1; }
  [[ ! -s "${REQUESTS}" ]] || { cat "${REQUESTS}"; return 1; }
  ! grep -q launchctl "${CALLS}" || { echo "restarted"; return 1; }
}

@test "the page's write step reports a written config whose env render failed apart from a refusal" {
  printf '[ports]\nmonitor = 16145\n\n[remote_access]\nenabled = true\n' >"${SANDBOX}/config.toml"
  run_page_step off
  [[ "${status}" -eq 8 ]] || { echo "${status} ${output}"; return 1; }
  [[ "$(atrium_toml_get "[remote_access]" "enabled")" == "false" ]] || return 1
}

@test "the page's write step, run by absolute path, takes on or off alone or trust with a well-formed network, and writes nothing otherwise" {
  local rows=('no act|' 'an unknown act|reissue' 'a second word|on extra' 'a flag|--yes' 'trust with no network|trust'
    'on with a network|on en1 192.168.0.1 00:1b:2c:0d:4e:5f' 'trust with a public gateway|trust en1 8.8.8.8 00:1b:2c:0d:4e:5f'
    'trust with an unpadded hardware address|trust en1 192.168.0.1 0:1b:2c:d:4e:5f' 'trust with an interface that is no name|trust en/1 192.168.0.1 00:1b:2c:0d:4e:5f'
    'trust with a fourth network word|trust en1 192.168.0.1 00:1b:2c:0d:4e:5f extra')
  local row name argv config_before
  config_before="$(file_sum "${SANDBOX}/config.toml")"
  for row in "${rows[@]}"; do
    IFS='|' read -r name argv <<<"${row}"
    # shellcheck disable=SC2086  # a row's argv is split into its words
    run "${GA}/scripts/remote-access-set.sh" ${argv} </dev/null
    [[ "${status}" -eq 2 ]] || { echo "${name}: ${status} ${output}"; return 1; }
  done
  [[ "$(file_sum "${SANDBOX}/config.toml")" == "${config_before}" && ! -e "${KEY_DIR}" ]] || return 1
}
