#!/usr/bin/env bats
# shellcheck source-path=SCRIPTDIR disable=SC2154,SC2329,SC2312,SC2034  # bats injects BATS_*/status/output; the stubs and globals are read by the sourced libs
# Remote access across the install lifecycle: the installer opt-in, uninstall, the doctor rows and the updater.
# Hermetic: a sandbox GA_ROOT, real LibreSSL in that sandbox, stubbed route/arp/scutil/ipconfig/tmutil/launchctl/psql.
# No real key folder, no real install, no database.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  SANDBOX="$(mktemp -d)"
  export GA_ROOT="${SANDBOX}"
  unset ATRIUM_CONFIG_TOML
  KEY_DIR="${SANDBOX}/monitor/data/remote-access"
  CALLS="${SANDBOX}/calls.log"
  mkdir -p "${SANDBOX}/monitor/data"
  : >"${CALLS}"
  printf '[ports]\nmonitor = 16145\n\n[meta]\ntimezone = "auto"\n' >"${SANDBOX}/config.toml"
  ROUTE_OUT=$'    gateway: 192.168.0.1\n  interface: en1\n'
  ARP_OUT='? (192.168.0.1) at 0:1b:2c:d:4e:5f on en1 ifscope [ethernet]'
  WIFI_ADDRESS="192.168.0.10"
  HOST_NAME="Test-Mac"
  EXCLUDED='[Excluded]'
  LISTEN_NAME="192.168.0.10:16146"
  FIREWALL_OUT='Firewall is enabled. (State = 1)'
  IS_TERMINAL=false
  DRY_RUN=false
  PSQL_RC=0
  # shellcheck source=../scripts/lib/atrium-config.sh
  source "${GA}/scripts/lib/atrium-config.sh"
  # shellcheck source=../lib/ga-remote.sh
  source "${GA}/lib/ga-remote.sh"
  ga_remote_run() {
    local tool="$1"
    shift
    case "${tool}" in
      openssl) /usr/bin/openssl "$@" ;;
      route) printf '%s' "${ROUTE_OUT}" ;;
      arp) printf '%s\n' "${ARP_OUT}" ;;
      scutil) printf '%s\n' "${HOST_NAME}" ;;
      ipconfig) printf '%s\n' "${WIFI_ADDRESS}" ;;
      tmutil)
        printf 'tmutil %s\n' "$*" >>"${CALLS}"
        [[ "$1" != "isexcluded" ]] || printf '%s    %s\n' "${EXCLUDED}" "$2"
        ;;
      launchctl) printf 'launchctl %s\n' "$*" >>"${CALLS}" ;;
      lsof)
        [[ -n "${LISTEN_NAME}" ]] || return 1
        printf 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 501 owner 23u IPv4 0x1 0t0 TCP %s (LISTEN)\n' "${LISTEN_NAME}"
        ;;
      socketfilterfw) printf '%s\n' "${FIREWALL_OUT}" ;;
      *) return 127 ;;
    esac
  }
  psql() {
    printf 'psql %s | %s\n' "$*" "$(tr '\n' ' ')" >>"${CALLS}"
    return "${PSQL_RC}"
  }
  # shellcheck source=../scripts/lib/path-guard.sh
  source "${GA}/scripts/lib/path-guard.sh"
  ga_remote_apply_config() { printf 'apply\n' >>"${CALLS}"; }
  ga_remote_is_terminal() { "${IS_TERMINAL}"; }
}

teardown() {
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

file_sum() { cksum <"$1"; }

create_keys() {
  ga_remote_create_ca "${KEY_DIR}"
  ga_remote_issue_leaf "${KEY_DIR}"
}

turn_on_config() {
  printf '\n[remote_access]\nenabled = true\nport = 16146\ntrusted_networks = "%s"\n' "$1" >>"${SANDBOX}/config.toml"
}

# --- installer opt-in ---------------------------------------------------------------------------------

@test "the installer keeps the monitor loopback-only unless the owner answers yes on a terminal" {
  local rows=('no terminal|false|y' 'empty answer|true|' 'no|true|n' 'anything else|true|yes please')
  local row name answer config_before
  config_before="$(file_sum "${SANDBOX}/config.toml")"
  for row in "${rows[@]}"; do
    IFS='|' read -r name IS_TERMINAL answer <<<"${row}"
    run ga_remote_install_opt_in <<<"${answer}"
    [[ "${status}" -eq 0 && "${output}" == *"loopback-only"* ]] || {
      echo "${name}: ${status} ${output}"
      return 1
    }
    [[ "$(file_sum "${SANDBOX}/config.toml")" == "${config_before}" ]] || {
      echo "${name}: config written"
      return 1
    }
    [[ ! -e "${KEY_DIR}" ]] || {
      echo "${name}: keys created"
      return 1
    }
  done
}

@test "a yes at install creates the keys, turns access on, trusts the Wi-Fi and prints the CA fingerprint, without a restart" {
  IS_TERMINAL=true
  run ga_remote_install_opt_in <<<$'y\ntrust'
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(atrium_toml_get "[remote_access]" "enabled")" == "true" ]] || return 1
  [[ "$(atrium_toml_get "[remote_access]" "port")" == "16146" ]] || return 1
  [[ "$(atrium_toml_get "[remote_access]" "trusted_networks")" == "192.168.0.1@00:1b:2c:0d:4e:5f" ]] || return 1
  [[ -z "$(ga_remote_get_loose_modes "${KEY_DIR}")" ]] || return 1
  local fingerprint
  fingerprint="$(/usr/bin/openssl x509 -fingerprint -sha256 -noout -in "${KEY_DIR}/ca.pem")"
  [[ "${output}" == *"${fingerprint#*=}"* && "${output}" == *"https://test-mac.local:16146"* ]] || {
    echo "${output}"
    return 1
  }
  ! grep -q apply "${CALLS}" || {
    echo "restarted during install"
    return 1
  }
}

@test "a re-install with access already on asks nothing and keeps the config" {
  turn_on_config "192.168.0.1@00:1b:2c:0d:4e:5f"
  create_keys
  IS_TERMINAL=true
  local config_before
  config_before="$(file_sum "${SANDBOX}/config.toml")"
  run ga_remote_install_opt_in </dev/null
  [[ "${status}" -eq 0 && "${output}" == *"already on"* && "${output}" != *"[y/N]"* ]] || {
    echo "${output}"
    return 1
  }
  [[ "$(file_sum "${SANDBOX}/config.toml")" == "${config_before}" ]] || return 1
}

# The TUI's install steps read no terminal (stdin pinned to EOF), so the TUI asks after its install
# panel instead: lift the panel and the gate out of the dispatch lib and run them with stub chrome.
run_tui_install_panel() {
  local plan_rc="$1" enabled="$2" answer="$3" body="${SANDBOX}/panel.sh"
  awk '/^(dispatch_action_install_panel|tui_remote_opt_in_gate|_tui_remote_ask|_run_cooked)\(\) \{/ { f = 1 } f { print } f && /^}/ { f = 0 }' \
    "${GA}/lib/ga-tui-dispatch.sh" >"${body}"
  printf '%s\n' "${answer}" >"${SANDBOX}/tty"
  printf '%s\n' "${enabled}" >"${SANDBOX}/enabled"
  PLAN_RC="${plan_rc}" STATE="${SANDBOX}" TTY="${SANDBOX}/tty" bash -c '
    apply_plate_geometry() { :; }
    enter_run_state() { :; }
    start_idle_spinner() { :; }
    stop_idle_spinner() { :; }
    run_gate_quiet() { :; }
    run_action_panel() { return "${PLAN_RC}"; }
    tp() { :; }
    stty() { :; }
    reset_plate_geometry() { :; }
    atrium_toml_get() { cat "${STATE}/enabled"; }
    ga_remote_install_opt_in() {
      local reply
      IFS= read -r reply || reply=""
      printf "asked\n" >>"${STATE}/calls.log"
      [[ "${reply}" != "y" ]] || printf "true\n" >"${STATE}/enabled"
    }
    ga_remote_apply_config() { printf "applied\n" >>"${STATE}/calls.log"; }
    source "$1"
    rc=0
    dispatch_action_install_panel || rc=$?
    printf "%s\n" "${rc}"
  ' _ "${body}"
}

@test "the TUI asks the opt-in only after an install that succeeded with access off, and a yes restarts the monitor" {
  local rows=(
    'install failed|3|false|y|-|3'
    'owner answers no|0|false|n|asked|0'
    'owner answers yes|0|false|y|asked applied|0'
    'access already on|0|true|y|-|0'
  )
  local row name plan_rc enabled answer want_calls want_rc got_rc calls
  for row in "${rows[@]}"; do
    IFS='|' read -r name plan_rc enabled answer want_calls want_rc <<<"${row}"
    : >"${CALLS}"
    got_rc="$(run_tui_install_panel "${plan_rc}" "${enabled}" "${answer}")" || {
      echo "${name}: panel did not run"
      return 1
    }
    calls="$(tr '\n' ' ' <"${CALLS}")"
    [[ "${calls% }" == "${want_calls#-}" ]] || {
      echo "${name}: calls '${calls}', want '${want_calls}'"
      return 1
    }
    [[ "${got_rc}" == "${want_rc}" ]] || {
      echo "${name}: returned ${got_rc}, want ${want_rc}"
      return 1
    }
  done
}

# --- uninstall ----------------------------------------------------------------------------------------

@test "uninstall removes the keys and the device rows, turns access off and tells the owner to drop each device's trust" {
  turn_on_config "192.168.0.1@00:1b:2c:0d:4e:5f"
  create_keys
  run ga_remote_uninstall
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ ! -e "${KEY_DIR}" ]] || return 1
  grep -q 'psql .*DELETE FROM monitor.remote_devices' "${CALLS}" || {
    cat "${CALLS}"
    return 1
  }
  [[ "$(atrium_toml_get "[remote_access]" "enabled")" == "false" ]] || return 1
  [[ "${output}" == *"Glass Atrium Local CA"* && "${output}" == *"each device"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "uninstall still removes the keys when the device rows cannot be deleted, and says so" {
  create_keys
  PSQL_RC=2
  run ga_remote_uninstall
  [[ "${status}" -eq 0 && "${output}" == *"device rows were not deleted"* ]] || {
    echo "${output}"
    return 1
  }
  [[ ! -e "${KEY_DIR}" ]] || return 1
}

@test "a dry-run uninstall touches neither the keys nor the database" {
  turn_on_config ""
  create_keys
  DRY_RUN=true
  run ga_remote_uninstall
  [[ "${status}" -eq 0 && -f "${KEY_DIR}/ca.key" ]] || {
    echo "${output}"
    return 1
  }
  ! grep -q psql "${CALLS}" || return 1
  [[ "$(atrium_toml_get "[remote_access]" "enabled")" == "true" ]] || return 1
}

# --- doctor -------------------------------------------------------------------------------------------

doctor_level_for() {
  local rows
  rows="$(ga_remote_get_doctor_rows)"
  printf '%s\n' "${rows}" | awk -F'|' -v want="$1" 'index($2, want) { print $1; exit }'
}

@test "doctor reports off as ok when no remote listener is open, and checks nothing else" {
  LISTEN_NAME=""
  run ga_remote_get_doctor_rows
  [[ "${status}" -eq 0 && "${output}" == "ok|remote access off"* && "${#lines[@]}" -eq 1 ]] || {
    echo "${output}"
    return 1
  }
}

@test "doctor rows: each broken property of an enabled setup gets its own level, a sound setup only ok rows" {
  local rows=(
    'sound setup||ok|owner-only'
    'missing keys|rm-keys|FAIL|certificates are missing'
    'a key file readable by others|loose|FAIL|not owner-only'
    'no backup exclusion|included|warn|Time Machine'
    'Mac renamed|renamed|warn|reissue'
    'leaf near expiry|near-expiry|warn|expires within'
    'Wi-Fi address changed|moved|warn|current Wi-Fi address'
    'listener on all interfaces|all-interfaces|FAIL|all interfaces'
    'untrusted network with the listener open|untrusted|FAIL|not trusted'
    'untrusted network with the listener closed|untrusted-closed|ok|listener closed'
    'firewall off|firewall-off|warn|firewall'
  )
  local row name breakage level text actual
  for row in "${rows[@]}"; do
    IFS='|' read -r name breakage level text <<<"${row}"
    turn_on_config "192.168.0.1@00:1b:2c:0d:4e:5f"
    create_keys
    case "${breakage}" in
      rm-keys) mv -- "${KEY_DIR}/leaf.pem" "${SANDBOX}/leaf.pem.aside" ;;
      loose) chmod 644 "${KEY_DIR}/leaf.key" ;;
      included) EXCLUDED='[Included]' ;;
      renamed) HOST_NAME="Other-Mac" ;;
      near-expiry) GA_REMOTE_REISSUE_AHEAD_SECONDS=$((900 * 86400)) ;;
      moved) WIFI_ADDRESS="192.168.0.77" LISTEN_NAME="192.168.0.77:16146" ;;
      all-interfaces) LISTEN_NAME="*:16146" ;;
      untrusted) ARP_OUT='? (192.168.0.1) at 0:aa:bb:cc:dd:ee on en1 ifscope [ethernet]' ;;
      untrusted-closed) ARP_OUT='? (192.168.0.1) at 0:aa:bb:cc:dd:ee on en1 ifscope [ethernet]' LISTEN_NAME="" ;;
      firewall-off) FIREWALL_OUT='Firewall is disabled. (State = 0)' ;;
      *) ;;
    esac
    actual="$(doctor_level_for "${text}")"
    [[ "${actual}" == "${level}" ]] || {
      echo "${name}: '${actual}' — $(ga_remote_get_doctor_rows)"
      return 1
    }
    if [[ "${breakage}" == "" ]]; then
      ! ga_remote_get_doctor_rows | grep -qv '^ok|' || {
        echo "${name}: $(ga_remote_get_doctor_rows)"
        return 1
      }
    fi
    if ga_guard_path "${KEY_DIR}"; then rm -rf -- "${KEY_DIR:?}"; fi
    printf '[ports]\nmonitor = 16145\n' >"${SANDBOX}/config.toml"
    EXCLUDED='[Excluded]' HOST_NAME="Test-Mac" GA_REMOTE_REISSUE_AHEAD_SECONDS=$((30 * 86400))
    WIFI_ADDRESS="192.168.0.10" LISTEN_NAME="192.168.0.10:16146" FIREWALL_OUT='Firewall is enabled. (State = 1)'
    ARP_OUT='? (192.168.0.1) at 0:1b:2c:d:4e:5f on en1 ifscope [ethernet]'
  done
}

@test "doctor reports off as FAIL while a remote listener is still open on the remote port" {
  run ga_remote_get_doctor_rows
  [[ "${status}" -eq 0 && "${output}" == "FAIL|remote access off but a listener is open"* ]] || {
    echo "${output}"
    return 1
  }
}

# --- updater ------------------------------------------------------------------------------------------

@test "the updater's render step leaves the remote config and keys untouched and never turns access on" {
  local rows=('on with two networks|on' 'off|off')
  local row name state config_before keys_before access
  printf '#!/usr/bin/env bash\nexit 0\n' >"${SANDBOX}/render-launchd" && chmod +x "${SANDBOX}/render-launchd"
  mkdir -p "${SANDBOX}/monitor/data/documents"
  for row in "${rows[@]}"; do
    IFS='|' read -r name state <<<"${row}"
    printf '[ports]\nmonitor = 16145\n\n[paths]\nmonitor_docs_html_root = "%s"\n' "${SANDBOX}/monitor/data/documents" >"${SANDBOX}/config.toml"
    printf '\n[daemon.autoagent-cycle]\ntime = "04:30"\n\n[daemon.wiki-compile]\ntime = "04:50"\n' >>"${SANDBOX}/config.toml"
    if [[ "${state}" == "on" ]]; then
      turn_on_config "192.168.0.1@00:1b:2c:0d:4e:5f, 10.0.0.1@aa:bb:cc:dd:ee:ff"
      create_keys
    fi
    config_before="$(file_sum "${SANDBOX}/config.toml")"
    keys_before="$(cat "${KEY_DIR}"/* 2>/dev/null | cksum)"
    ATRIUM_UPDATE_RENDER_LAUNCHD="${SANDBOX}/render-launchd" ATRIUM_UPDATE_RENDER_MONITOR_ENV="${GA}/scripts/render-monitor-env.sh" \
      run bash -c 'source "$1/scripts/update.sh" && update_render_oneshot_plist() { :; } && update_render_parity' _ "${GA}"
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: ${output}"
      return 1
    }
    [[ "$(file_sum "${SANDBOX}/config.toml")" == "${config_before}" ]] || {
      echo "${name}: config changed"
      return 1
    }
    [[ "$(cat "${KEY_DIR}"/* 2>/dev/null | cksum)" == "${keys_before}" ]] || {
      echo "${name}: keys changed"
      return 1
    }
    access="$(grep -E '^ATRIUM_REMOTE_ACCESS=' "${SANDBOX}/monitor/.env")"
    [[ "${access}" == "ATRIUM_REMOTE_ACCESS=${state}" ]] || {
      echo "${name}: ${access}"
      return 1
    }
  done
}
