# shellcheck shell=bash
# ga-remote.sh — monitor access from other devices on a trusted Wi-Fi (plan clauded-docs/44077):
# the value rules shared by the env renderer and the CLI, the key material, and the `glass-atrium remote` CLI.
# Sourced library: sets no shell options. Every system tool runs by absolute path with a fixed argv.

GA_REMOTE_PORT_DEFAULT=16146 # config.toml.example → [remote_access].port

# --- value rules (one owner: the renderer and every CLI write validate through these) -------------

# Remote port: 1024-65535 and never the monitor's own port (monitor/src/server/remote/settings.ts → getPort).
# Args: $1 = candidate · $2 = monitor port.
ga_remote_is_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] || return 1
  local port=$((10#$1))
  ((port >= 1024 && port <= 65535 && port != $2))
}

# RFC 1918 IPv4 only — the CA's name constraints permit exactly these three ranges.
ga_remote_is_private_ipv4() {
  local address="$1" a b c d
  [[ "${address}" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  a=$((10#${BASH_REMATCH[1]})) b=$((10#${BASH_REMATCH[2]})) c=$((10#${BASH_REMATCH[3]})) d=$((10#${BASH_REMATCH[4]}))
  ((a <= 255 && b <= 255 && c <= 255 && d <= 255)) || return 1
  ((a == 10)) || ((a == 172 && b >= 16 && b <= 31)) || ((a == 192 && b == 168))
}

# Hardware address as the monitor normalizes it (network.ts → getNormalizedHardwareAddress): lower-case,
# each octet zero-padded, six octets. Prints it; returns 1 on anything else.
ga_remote_get_hardware_address() {
  local text octet out=""
  text="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [[ "${text}" =~ ^[0-9a-f]{1,2}(:[0-9a-f]{1,2}){5}$ ]] || return 1
  local IFS=':'
  for octet in ${text}; do
    ((${#octet} == 2)) || octet="0${octet}"
    out="${out:+${out}:}${octet}"
  done
  printf '%s\n' "${out}"
}

# One stored trusted entry, `<private gateway IPv4>@<normalized hardware address>`, already normalized.
ga_remote_is_trusted_entry() {
  local entry="$1" normalized
  [[ "${entry}" == *@* && "${entry#*@}" != *@* ]] || return 1
  ga_remote_is_private_ipv4 "${entry%@*}" || return 1
  normalized="$(ga_remote_get_hardware_address "${entry#*@}")" || return 1
  [[ "${normalized}" == "${entry#*@}" ]]
}

# Comma-separated trusted list → the same list trimmed and joined by `,`; returns 1 on any invalid entry.
ga_remote_get_trusted_list() {
  local list="$1" entry out=""
  local IFS=','
  for entry in ${list}; do
    entry="${entry//[[:space:]]/}"
    [[ -n "${entry}" ]] || continue
    ga_remote_is_trusted_entry "${entry}" || return 1
    out="${out:+${out},}${entry}"
  done
  printf '%s\n' "${out}"
}

# --- system tools (the one seam: tests redefine this function after sourcing; nothing reads it from env) --

ga_remote_run() {
  local tool="$1"
  shift
  case "${tool}" in
    openssl) /usr/bin/openssl "$@" ;;
    route) /sbin/route "$@" ;;
    arp) /usr/sbin/arp "$@" ;;
    scutil) /usr/sbin/scutil "$@" ;;
    ipconfig) /usr/sbin/ipconfig "$@" ;;
    tmutil) /usr/bin/tmutil "$@" ;;
    curl) /usr/bin/curl "$@" ;;
    launchctl) /bin/launchctl "$@" ;;
    *) return 127 ;;
  esac
}

# --- network facts (the monitor's own procedure: monitor/src/server/remote/network.ts) -------------

# `route -n get default` → "<gateway> <interface>"; returns 1 when either is unreadable.
ga_remote_get_default_route() {
  local route gateway network_interface
  route="$(ga_remote_run route -n get default)" || return 1
  gateway="$(printf '%s\n' "${route}" | awk '$1 == "gateway:" { print $2; exit }')"
  network_interface="$(printf '%s\n' "${route}" | awk '$1 == "interface:" { print $2; exit }')"
  [[ "${gateway}" =~ ^[0-9.]+$ && "${network_interface}" =~ ^[a-z0-9]+$ ]] || return 1
  printf '%s %s\n' "${gateway}" "${network_interface}"
}

# Network identity "<interface> <gateway> <hardware address>" — the ARP entry must name this gateway on this
# interface; a missing entry or a public gateway is unreadable (returns 1), so nothing is trusted.
ga_remote_get_network_identity() {
  local route gateway network_interface arp hardware
  route="$(ga_remote_get_default_route)" || return 1
  gateway="${route% *}" network_interface="${route#* }"
  ga_remote_is_private_ipv4 "${gateway}" || return 1
  arp="$(ga_remote_run arp -n "${gateway}")" || return 1
  hardware="$(printf '%s\n' "${arp}" | awk -v gw="(${gateway})" -v nif="${network_interface}" \
    '$2 == gw && $3 == "at" && $5 == "on" && $6 == nif { print $4; exit }')"
  hardware="$(ga_remote_get_hardware_address "${hardware}")" || return 1
  printf '%s %s %s\n' "${network_interface}" "${gateway}" "${hardware}"
}

# The names the leaf must carry: "<LocalHostName lower-case>.local <private Wi-Fi IPv4>".
ga_remote_get_leaf_names() {
  local host route address
  host="$(ga_remote_run scutil --get LocalHostName)" || return 1
  host="$(printf '%s' "${host}" | tr '[:upper:]' '[:lower:]')"
  [[ "${host}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || return 1
  route="$(ga_remote_get_default_route)" || return 1
  address="$(ga_remote_run ipconfig getifaddr "${route#* }")" || return 1
  ga_remote_is_private_ipv4 "${address}" || return 1
  printf '%s.local %s\n' "${host}" "${address}"
}

# --- key material (recipe: the plan's probe record — LibreSSL, P-256, CA name constraints, path length 0) ---

GA_REMOTE_DAYS_CA=3650
GA_REMOTE_DAYS_LEAF=820 # inside the measured macOS 825-day ceiling for a custom anchor
GA_REMOTE_REISSUE_AHEAD_SECONDS=$((30 * 86400))

if ! declare -F ga_guard_path >/dev/null; then
  # shellcheck source=../scripts/lib/path-guard.sh
  source "$(dirname -- "${BASH_SOURCE[0]}")/../scripts/lib/path-guard.sh"
fi

ga_remote_get_key_dir() {
  printf '%s\n' "${GA_ROOT:-${HOME}/.glass-atrium}/monitor/data/remote-access"
}

# Owner-only scratch dir inside the key dir → each finished file is renamed into place on the same volume.
_ga_remote_create_work_dir() {
  (umask 077 && mkdir -p -- "$1" && chmod 700 "$1" && mktemp -d "$1/.work.XXXXXX")
}

_ga_remote_drop_work_dir() {
  local work="$1"
  # shellcheck disable=SC2310  # pure predicate — nothing inside it for errexit to catch
  if ga_guard_path "${work}"; then rm -rf -- "${work:?}"; fi
}

# CA key + certificate, created once; an existing CA is kept (every device trusts it).
# The sticky Time Machine exclusion goes on the key dir (no elevation; the doctor re-checks it).
ga_remote_create_ca() {
  local dir="$1" work rc=0
  [[ -f "${dir}/ca.key" && -f "${dir}/ca.pem" ]] && return 0
  work="$(_ga_remote_create_work_dir "${dir}")" || return 1
  printf '%s\n' '[req]' 'distinguished_name = dn' 'x509_extensions = v3_ca' 'prompt = no' '[dn]' \
    'CN = Glass Atrium Local CA' '[v3_ca]' 'basicConstraints = critical, CA:TRUE, pathlen:0' \
    'keyUsage = critical, keyCertSign, cRLSign' 'subjectKeyIdentifier = hash' \
    'nameConstraints = critical, permitted;DNS:local, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:172.16.0.0/255.240.0.0, permitted;IP:192.168.0.0/255.255.0.0' \
    >"${work}/ca.cnf" || rc=1
  ((rc == 0)) && (umask 077 && ga_remote_run openssl ecparam -name prime256v1 -out "${work}/ec.param" \
    && ga_remote_run openssl req -x509 -newkey "ec:${work}/ec.param" -nodes -keyout "${work}/ca.key" \
      -out "${work}/ca.pem" -days "${GA_REMOTE_DAYS_CA}" -sha256 -config "${work}/ca.cnf") >/dev/null 2>&1 || rc=1
  ((rc == 0)) && mv -f -- "${work}/ca.key" "${dir}/ca.key" && mv -f -- "${work}/ca.pem" "${dir}/ca.pem" || rc=1
  _ga_remote_drop_work_dir "${work}"
  ((rc == 0)) && ga_remote_run tmutil addexclusion "${dir}" >/dev/null 2>&1 || rc=1
  return "${rc}"
}

# New leaf for the current names, signed by the CA, verified before it replaces the old one; on any failure
# the old leaf stays. Key content only ever moves file to file — never an argument or output.
ga_remote_issue_leaf() {
  local dir="$1" names work rc=0
  [[ -f "${dir}/ca.key" && -f "${dir}/ca.pem" ]] || return 1
  names="$(ga_remote_get_leaf_names)" || return 1
  work="$(_ga_remote_create_work_dir "${dir}")" || return 1
  _ga_remote_sign_leaf "${dir}" "${work}" "${names% *}" "${names#* }" \
    && ga_remote_is_leaf_for "${dir}" "${work}/leaf.pem" "${names% *}" "${names#* }" \
    && mv -f -- "${work}/leaf.key" "${dir}/leaf.key" && mv -f -- "${work}/leaf.pem" "${dir}/leaf.pem" || rc=1
  _ga_remote_drop_work_dir "${work}"
  return "${rc}"
}

_ga_remote_sign_leaf() {
  local dir="$1" work="$2" host="$3" address="$4"
  printf '%s\n' 'basicConstraints = critical, CA:FALSE' 'keyUsage = critical, digitalSignature' \
    'extendedKeyUsage = serverAuth' "subjectAltName = DNS:${host}, IP:${address}" \
    'authorityKeyIdentifier = keyid' >"${work}/leaf.ext" || return 1
  (umask 077 && ga_remote_run openssl ecparam -name prime256v1 -genkey -noout -out "${work}/leaf.key" \
    && ga_remote_run openssl req -new -key "${work}/leaf.key" -subj "/CN=${host}" -out "${work}/leaf.csr" \
    && ga_remote_run openssl x509 -req -in "${work}/leaf.csr" -CA "${dir}/ca.pem" -CAkey "${dir}/ca.key" \
      -CAserial "${work}/ca.srl" -CAcreateserial -days "${GA_REMOTE_DAYS_LEAF}" -sha256 \
      -extfile "${work}/leaf.ext" -out "${work}/leaf.pem") >/dev/null 2>&1
}

# The leaf chains to the CA and names exactly this host and address.
ga_remote_is_leaf_for() {
  local dir="$1" pem="$2" host="$3" address="$4" verdict text
  verdict="$(ga_remote_run openssl verify -CAfile "${dir}/ca.pem" "${pem}" 2>&1)" || return 1
  [[ "${verdict}" == *": OK" ]] || return 1
  text="$(ga_remote_run openssl x509 -in "${pem}" -noout -text 2>/dev/null)" || return 1
  [[ "${text}" == *"DNS:${host}, IP Address:${address}"* ]]
}

# Reissue due: the leaf is missing, expires within 30 days, or no longer names the current host and address.
ga_remote_is_leaf_due() {
  local dir="$1" names
  [[ -f "${dir}/leaf.pem" ]] || return 0
  ga_remote_run openssl x509 -checkend "${GA_REMOTE_REISSUE_AHEAD_SECONDS}" -noout -in "${dir}/leaf.pem" \
    >/dev/null 2>&1 || return 0
  names="$(ga_remote_get_leaf_names)" || return 1
  ! ga_remote_is_leaf_for "${dir}" "${dir}/leaf.pem" "${names% *}" "${names#* }"
}

# Permission bits in octal (perl: one form on BSD and GNU, where `stat` flags differ).
ga_remote_get_mode() {
  perl -e 'printf "%o\n", (stat $ARGV[0])[2] & 07777' -- "$1"
}

# Paths under the key dir that are not owner-only (dir 700, files 600), one per line.
ga_remote_get_loose_modes() {
  local dir="$1" path mode
  mode="$(ga_remote_get_mode "${dir}")"
  [[ "${mode}" == "700" ]] || printf '%s\n' "${dir}"
  for path in "${dir}"/*; do
    [[ -e "${path}" ]] || continue
    mode="$(ga_remote_get_mode "${path}")"
    [[ "${mode}" == "600" ]] || printf '%s\n' "${path}"
  done
}

# --- config (owner-only, atomic: temp file in the same dir, then rename) -----------------------------

# Set one [remote_access] key to an already-validated TOML literal; the table is appended when absent.
ga_remote_set_config() {
  local key="$1" value="$2" config tmp
  config="$(atrium_config_file)"
  [[ -f "${config}" ]] || return 1
  tmp="$(umask 077 && mktemp "$(dirname -- "${config}")/.config.toml.XXXXXX")" || return 1
  if KEY="${key}" VALUE="${value}" awk '
    function put() { if (in_table && !done) { print ENVIRON["KEY"] " = " ENVIRON["VALUE"]; done = 1 } }
    /^[[:space:]]*\[/ { h = $0; gsub(/[[:space:]]/, "", h); put(); in_table = (h == "[remote_access]"); seen = seen || in_table; print; next }
    in_table && $0 ~ "^[[:space:]]*" ENVIRON["KEY"] "[[:space:]]*=" { put(); next }
    { print }
    END { put(); if (!seen) { print ""; print "[remote_access]"; print ENVIRON["KEY"] " = " ENVIRON["VALUE"] } }
  ' "${config}" >"${tmp}"; then
    mv -f -- "${tmp}" "${config}"
  else
    _ga_remote_drop_work_dir "${tmp}"
    return 1
  fi
}

# Re-render monitor/.env (its output holds env values → discarded) and restart the monitor to pick it up.
ga_remote_apply_config() {
  bash "$(dirname -- "${BASH_SOURCE[0]}")/../scripts/render-monitor-env.sh" >/dev/null || return 1
  ga_remote_run launchctl kickstart -k "gui/${UID}/com.glass-atrium.monitor" >/dev/null
}

# --- the CLI channel: the monitor's loopback remote-cli routes (cli-channel-verdict.md, shape b) ------

GA_REMOTE_CLI_HEADER='X-Glass-Atrium-Cli: remote-access'
GA_REMOTE_CLI_PATH='/api/remote/cli/devices'

# Loopback literal, no proxy, no curlrc, no redirect, bounded time; no Origin, Referer or Cookie is sent.
# Prints the body, a newline, then the HTTP status.
ga_remote_call_monitor() {
  local method="$1" path="$2" port
  port="$(atrium_monitor_port)" || return 1
  [[ "${port}" =~ ^[0-9]{1,5}$ ]] || return 1
  ga_remote_run curl -q -sS --noproxy '*' --proto '=http' --max-time 10 --max-redirs 0 \
    --max-filesize 1048576 -X "${method}" -H "${GA_REMOTE_CLI_HEADER}" -w '\n%{http_code}' \
    "http://127.0.0.1:${port}${path}"
}

# Revoke every device through the monitor; prints the revoked count only on the monitor's confirmation.
_ga_remote_revoke_all() {
  local reply
  reply="$(ga_remote_call_monitor POST "${GA_REMOTE_CLI_PATH}/revoke-all")" || return 1
  [[ "${reply##*$'\n'}" == "200" ]] || return 1
  printf '%s' "${reply%$'\n'*}" | jq -er '.revoked | select(type == "number")'
}

# --- subcommands -----------------------------------------------------------------------------------

ga_remote_main() {
  local sub="${1:-}"
  if (($# > 0)); then shift; fi
  case "${sub}" in
    on) ga_remote_cmd_on ;;
    off) ga_remote_cmd_off ;;
    list) ga_remote_cmd_list ;;
    revoke) ga_remote_cmd_revoke "${1:-}" ;;
    revoke-all) ga_remote_cmd_revoke_all ;;
    trust) ga_remote_cmd_trust ;;
    reissue) ga_remote_cmd_reissue ;;
    *)
      printf '%s\n' 'usage: glass-atrium remote on|off|list|revoke <id>|revoke-all|trust|reissue' \
        'Devices register only from the Mac'"'"'s monitor page; there is no CLI registration.' >&2
      return 2
      ;;
  esac
}

ga_remote_is_terminal() { [[ -t 0 && -t 1 ]]; }

# A typed confirmation word on an interactive terminal; there is no skip flag.
ga_remote_require_confirmation() {
  local word="$1" prompt="$2" answer
  # shellcheck disable=SC2310  # pure predicate — nothing inside it for errexit to catch
  if ! ga_remote_is_terminal; then
    printf "remote: '%s' needs an interactive terminal — refused, nothing changed\n" "${word}" >&2
    return 1
  fi
  printf '%s' "${prompt}"
  IFS= read -r answer || answer=""
  [[ "${answer}" == "${word}" ]] && return 0
  printf 'remote: not confirmed — nothing changed\n' >&2
  return 1
}

ga_remote_cmd_list() {
  local reply
  if ! reply="$(ga_remote_call_monitor GET "${GA_REMOTE_CLI_PATH}")" || [[ "${reply##*$'\n'}" != "200" ]]; then
    printf 'remote: the monitor did not list the devices\n' >&2
    return 5
  fi
  # labels are data → control characters stripped; only id, label, created, last seen are printed
  printf '%s' "${reply%$'\n'*}" | jq -r '.devices
    | (.[] | [.id, (.label | explode | map(select(. >= 32 and (. < 127 or . > 159))) | implode), .createdAt, (.lastSeenAt // "-")] | @tsv),
      "\(length) active device(s)"'
}

ga_remote_cmd_revoke() {
  local id="$1" reply status
  if ! [[ "${id}" =~ ^[1-9][0-9]{0,8}$ ]]; then
    printf 'remote: revoke takes one device id (decimal digits)\n' >&2
    return 2
  fi
  reply="$(ga_remote_call_monitor DELETE "${GA_REMOTE_CLI_PATH}/${id}")" || status="none"
  status="${status:-${reply##*$'\n'}}"
  case "${status}" in
    200 | 204) printf 'remote: revoked device %s\n' "${id}" ;;
    404) printf 'remote: device %s not found (unknown or already revoked)\n' "${id}" >&2 && return 1 ;;
    *) printf 'remote: the monitor did not confirm — device %s was NOT revoked\n' "${id}" >&2 && return 5 ;;
  esac
}

ga_remote_cmd_revoke_all() {
  local count
  if ! count="$(_ga_remote_revoke_all)"; then
    printf 'remote: the monitor did not confirm — devices were NOT revoked\n' >&2
    return 5
  fi
  printf 'remote: revoked %s device(s)\n' "${count}"
}

# off: revoke every device through the monitor, then write off and restart — the off write happens even when
# the revoke is not confirmed, and only the monitor's confirmation is reported as revoked.
ga_remote_cmd_off() {
  local count="" is_revoked=false
  if count="$(_ga_remote_revoke_all)"; then is_revoked=true; fi
  if ! ga_remote_set_config enabled false || ! ga_remote_apply_config; then
    printf 'remote: off was not applied (config.toml or the monitor restart failed)\n' >&2
    return 1
  fi
  if ! "${is_revoked}"; then
    printf 'remote: access off; devices were NOT revoked — the monitor did not confirm\n' >&2
    return 3
  fi
  printf 'remote: access off; revoked %s device(s)\n' "${count}"
}

ga_remote_cmd_on() {
  local dir port count trusted
  ga_remote_require_confirmation on \
    "Turn on monitor access for registered devices on trusted Wi-Fi networks? Type 'on' to confirm: " || return 4
  dir="$(ga_remote_get_key_dir)"
  if ! ga_remote_create_ca "${dir}" || { ga_remote_is_leaf_due "${dir}" && ! ga_remote_issue_leaf "${dir}"; }; then
    printf 'remote: the certificates could not be created — nothing changed\n' >&2
    return 7
  fi
  port="$(atrium_toml_get "[remote_access]" "port")"
  if [[ -z "${port}" ]] && ! ga_remote_set_config port "${GA_REMOTE_PORT_DEFAULT}"; then return 1; fi
  if ! ga_remote_set_config enabled true || ! ga_remote_apply_config; then
    printf 'remote: on was not applied (config.toml or the monitor restart failed)\n' >&2
    return 1
  fi
  count="$(ga_remote_cmd_list 2>/dev/null)" || count=""
  count="${count##*$'\n'}"
  printf 'remote: access on; %s\n' "${count:-active devices unknown — the monitor is not answering yet}"
  trusted="$(atrium_toml_get "[remote_access]" "trusted_networks")"
  [[ -n "${trusted}" ]] \
    || printf "remote: no trusted network yet — run 'glass-atrium remote trust' on the Wi-Fi to open on\n"
}

ga_remote_cmd_trust() {
  local identity entry current list
  if ! identity="$(ga_remote_get_network_identity)"; then
    printf 'remote: network identity unreadable (no default gateway, a public gateway, or no ARP entry) — nothing written\n' >&2
    return 6
  fi
  entry="${identity#* }"
  entry="${entry% *}@${identity##* }"
  printf 'interface: %s\ngateway: %s\ngateway hardware address: %s\n' "${identity%% *}" "${entry%@*}" "${entry#*@}"
  printf '%s\n' 'This is an accident guard against opening on another Wi-Fi, not authentication.'
  ga_remote_require_confirmation trust "Trust this network? Type 'trust' to confirm: " || return 4
  current="$(atrium_toml_get "[remote_access]" "trusted_networks")"
  if ! list="$(ga_remote_get_trusted_list "${current}")"; then
    printf 'remote: [remote_access].trusted_networks is malformed — nothing written\n' >&2
    return 6
  fi
  if [[ ",${list}," == *",${entry},"* ]]; then
    printf 'remote: this network is already trusted\n'
    return 0
  fi
  if ! ga_remote_set_config trusted_networks "\"${list:+${list},}${entry}\"" || ! ga_remote_apply_config; then
    printf 'remote: trust was not applied (config.toml or the monitor restart failed)\n' >&2
    return 1
  fi
  printf 'remote: network trusted\n'
}

ga_remote_cmd_reissue() {
  local dir
  dir="$(ga_remote_get_key_dir)"
  if [[ ! -f "${dir}/ca.key" ]]; then
    printf "remote: no local CA — run 'glass-atrium remote on' first\n" >&2
    return 7
  fi
  if ! ga_remote_issue_leaf "${dir}"; then
    printf 'remote: the leaf was not reissued — the current leaf stays\n' >&2
    return 7
  fi
  printf 'remote: leaf reissued; the monitor serves it from its next network check\n'
}
