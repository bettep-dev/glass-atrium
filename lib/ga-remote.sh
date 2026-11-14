# shellcheck shell=bash
# ga-remote.sh — monitor access from other devices on a trusted Wi-Fi (plan clauded-docs/44077):
# the value rules shared by the env renderer and the CLI, the key material, and the `glass-atrium remote` CLI.
# Sourced library: sets no shell options. Every system tool runs by absolute path with a fixed argv.

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
