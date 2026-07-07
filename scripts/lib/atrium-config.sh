#!/usr/bin/env bash
# atrium-config.sh — read-only config.toml accessors shared by shell consumers
# (daemon bootstraps/healthchecks, inject, daily-restart, wiki-compile,
# render-monitor-env.sh). Sourced, not executable. config.toml is the upper SoT
# (see config.toml.example header); every accessor takes a caller-supplied
# default so a checkout WITHOUT a rendered config.toml — or with the key absent
# — preserves stock behavior (fresh-clone safety, no hard config dependency).
#
# Parsing: table-scoped awk (no TOML-parser dependency) — a same-named key in
# another section can never collide ([ports].monitor vs [paths].monitor).
#
# Config file resolution: ATRIUM_CONFIG_TOML env (test/sandbox override) →
# ${GA_ROOT:-$HOME/.glass-atrium}/config.toml.

# Resolved config.toml path (may not exist — accessors degrade to defaults).
atrium_config_file() {
  printf '%s\n' "${ATRIUM_CONFIG_TOML:-${GA_ROOT:-${HOME}/.glass-atrium}/config.toml}"
}

# Raw table-scoped read: echoes the value (quotes + trailing comment stripped),
# empty when the file or key is absent. Args: $1 = table header literal
# (e.g. "[ports]") · $2 = key name.
atrium_toml_get() {
  local section="$1" key="$2" config_file
  config_file="$(atrium_config_file)"
  [[ -f "${config_file}" ]] || return 0
  awk -v want="${section}" -v key="${key}" '
    /^[[:space:]]*\[/ { cur = $0; gsub(/[[:space:]]/, "", cur) }
    cur == want && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      val = $0
      sub(/^[^=]*=[[:space:]]*/, "", val)
      sub(/[[:space:]]*(#.*)?$/, "", val)
      gsub(/^"|"$/, "", val) # strip surrounding double quotes (strings are quoted)
      print val
      exit
    }
  ' "${config_file}"
}

# Defaulted read: configured value when present, else $3 verbatim.
atrium_config_get() {
  local section="$1" key="$2" default="$3" val
  val="$(atrium_toml_get "${section}" "${key}")"
  if [[ -n "${val}" ]]; then
    printf '%s\n' "${val}"
  else
    printf '%s\n' "${default}"
  fi
}

# Port read: defaulted + bindable-integer guard. A CONFIGURED invalid value is
# a user error — loud fail (stderr + rc 1, caller exits), never a silent
# fallback that masks the misconfiguration.
atrium_config_port() {
  local section="$1" key="$2" default="$3" val
  val="$(atrium_config_get "${section}" "${key}" "${default}")"
  if ! [[ "${val}" =~ ^[0-9]+$ ]] || ((val < 1 || val > 65535)); then
    printf 'atrium-config: invalid %s.%s=%s in %s — must be an integer 1-65535\n' \
      "${section}" "${key}" "${val}" "$(atrium_config_file)" >&2
    return 1
  fi
  printf '%s\n' "${val}"
}

# Private bindable-port predicate — integer 1-65535. Returns 0/1, no output.
# Shared by atrium_monitor_port for the env / rendered-.env value guards
# (atrium_config_port keeps its own inline check untouched).
_atrium_port_is_valid() {
  local val="$1"
  [[ "${val}" =~ ^[0-9]+$ ]] && ((val >= 1 && val <= 65535))
}

# Resolved rendered monitor/.env path (may not exist — the resolver degrades to
# config.toml then the terminal default). ATRIUM_MONITOR_ENV env overrides for
# test/sandbox, mirroring the ATRIUM_CONFIG_TOML override on atrium_config_file.
atrium_monitor_env_file() {
  printf '%s\n' "${ATRIUM_MONITOR_ENV:-${GA_ROOT:-${HOME}/.glass-atrium}/monitor/.env}"
}

# Extract ATRIUM_MONITOR_PORT from a rendered monitor/.env — the sibling idiom
# already used by lib/ga-db.sh and test/bootstrap-health-gate-exec-harness.sh.
# Echoes the value (empty when the key is absent); last assignment wins (env-file
# override semantics). Args: $1 = env file path (assumed to exist).
atrium_monitor_env_port() {
  local env_file="$1" val
  val="$(grep -E '^ATRIUM_MONITOR_PORT=[0-9]+$' -- "${env_file}" 2>/dev/null | tail -n 1 | cut -d= -f2 || true)"
  printf '%s\n' "${val}"
}

# Resolve the effective monitor port — the single shell SoT for the live port.
# Precedence (ADR-1): exported ATRIUM_MONITOR_PORT (the value a running monitor
# actually bound) → rendered monitor/.env ATRIUM_MONITOR_PORT → config.toml
# [ports].monitor (via atrium_config_port) → terminal default 16145. A CONFIGURED
# invalid value (env or .env) is a user error → loud fail (stderr + rc 1), never
# a silent fallback; config.toml invalids are loud-failed by atrium_config_port.
# The literal 16145 lives HERE as the terminal default and NOWHERE else in shell.
atrium_monitor_port() {
  local val env_file
  # 1. exported env — the live monitor's bound value.
  if [[ -n "${ATRIUM_MONITOR_PORT:-}" ]]; then
    val="${ATRIUM_MONITOR_PORT}"
    if ! _atrium_port_is_valid "${val}"; then
      printf 'atrium-config: invalid ATRIUM_MONITOR_PORT=%s (env) — must be an integer 1-65535\n' \
        "${val}" >&2
      return 1
    fi
    printf '%s\n' "${val}"
    return 0
  fi
  # 2. rendered monitor/.env value.
  env_file="$(atrium_monitor_env_file)"
  if [[ -f "${env_file}" ]]; then
    val="$(atrium_monitor_env_port "${env_file}")"
    if [[ -n "${val}" ]]; then
      if ! _atrium_port_is_valid "${val}"; then
        printf 'atrium-config: invalid ATRIUM_MONITOR_PORT=%s in %s — must be an integer 1-65535\n' \
          "${val}" "${env_file}" >&2
        return 1
      fi
      printf '%s\n' "${val}"
      return 0
    fi
  fi
  # 3. config.toml [ports].monitor, terminal default 16145 (loud-fails invalids).
  atrium_config_port '[ports]' 'monitor' '16145'
}

# Escape ERE metacharacters so a config value embeds literally in a grep -E
# pattern (IANA tz ids may carry '+', e.g. Etc/GMT+9 — unescaped, detection
# would silently mismatch).
atrium_ere_escape() {
  printf '%s' "$1" | sed -e 's/[][\.^$|?*+(){}\\]/\\&/g'
}

# Detect the host IANA timezone from the /etc/localtime symlink target, ANCHORED
# on the '/zoneinfo/' path segment: the zone is everything AFTER '/zoneinfo/'.
# Echoes the zone, empty on any failure. The anchor is portable — macOS resolves
# the link under /var/db/timezone/zoneinfo/<Zone>, Linux under
# /usr/share/zoneinfo/<Zone> — whereas a fixed-prefix strip would break on the
# other OS. TZ-IMMUNE: a symlink read cannot be shadowed by the launchd TZ=UTC
# pin that fools runtime Intl, so this is the build-time PRIMARY host detector.
atrium_get_host_timezone() {
  local link zone
  # `|| true` absorbs a readlink failure INSIDE the substitution so a consumer
  # under `set -Eeuo pipefail` with an ERR trap gets no spurious error line.
  link="$(readlink /etc/localtime 2>/dev/null || true)"
  [[ -n "${link}" ]] || return 0
  case "${link}" in
    */zoneinfo/*) zone="${link##*/zoneinfo/}" ;; # everything after the anchor
    *) return 0 ;;                               # no anchor → no reliable zone
  esac
  [[ -n "${zone}" ]] || return 0
  printf '%s\n' "${zone}"
}

# Secondary host detection: Node's Intl-resolved timezone. Build-time only — a
# launchd-pinned TZ=UTC would make Intl echo 'UTC', so this runs ONLY as the
# fallback after the TZ-immune symlink read above. Absent node → empty (the
# resolver then drops to its last-resort; never a hard-fail).
atrium_get_node_timezone() {
  command -v node >/dev/null 2>&1 || return 0
  node -e 'const tz=Intl.DateTimeFormat().resolvedOptions().timeZone; if(tz)process.stdout.write(tz)' 2>/dev/null || true
}

# Host-tz detection cascade shared by both atrium_resolve_timezone branches:
# /etc/localtime symlink (TZ-immune primary) → Node Intl (secondary). Echoes the
# detected zone, empty on a full miss — NO last-resort here (the auto path
# appends Asia/Seoul, the explicit path uses the detected value only to warn).
_atrium_detect_host_tz() {
  local host_tz
  host_tz="$(atrium_get_host_timezone)"
  [[ -n "${host_tz}" ]] || host_tz="$(atrium_get_node_timezone)"
  printf '%s\n' "${host_tz}"
}

# Resolve a configured [meta].timezone value to a CONCRETE IANA zone name.
# 'auto'/empty → the host-detection cascade; an explicit value is returned
# verbatim. NEVER echoes the literal 'auto' — downstream render outputs (.env,
# launchd plists) must carry a concrete zone (the monitor reads the value
# verbatim and feeds it to Intl/PG, where 'auto' is not a valid zone).
#
# Auto-path cascade: /etc/localtime symlink (TZ-immune primary) → Node Intl
# (secondary) → Asia/Seoul (last-resort, backward-compat). Never hard-fails.
#
# An EXPLICIT value diverging from the detected host zone emits a one-line stderr
# WARNING (loud divergence surface); the explicit value is still used. The auto
# path has no explicit value, so it never warns.
#
# Args: $1 = configured value ('auto' | '' | explicit IANA name).
atrium_resolve_timezone() {
  local configured="${1:-}" host_tz
  if [[ -z "${configured}" || "${configured}" == "auto" ]]; then
    host_tz="$(_atrium_detect_host_tz)"
    [[ -n "${host_tz}" ]] || host_tz="Asia/Seoul"
    printf '%s\n' "${host_tz}"
    return 0
  fi
  # Explicit value: surface divergence (warn-only), then use it verbatim.
  host_tz="$(_atrium_detect_host_tz)"
  if [[ -n "${host_tz}" && "${host_tz}" != "${configured}" ]]; then
    printf 'atrium-config: WARNING: explicit [meta].timezone=%s differs from detected host tz %s — schedules/timestamps follow the explicit value\n' \
      "${configured}" "${host_tz}" >&2
  fi
  printf '%s\n' "${configured}"
}

# Resolve the effective ATRIUM_TIMEZONE for the quota-detection consumers
# (daemon-daily-restart.sh, wiki-daily-compile.sh): honor a pre-set/env
# ATRIUM_TIMEZONE verbatim, else read [meta].timezone (default 'auto') and
# resolve it to a concrete host IANA zone. WHY a concrete zone: the REPL prints
# quota reset times in the HOST timezone, so detection must key on the resolved
# zone — a literal 'auto' (the config default) would never match the quota greps,
# and a hardcoded Asia/Seoul silently breaks detection on non-KST deploys.
atrium_load_timezone() {
  printf '%s\n' "${ATRIUM_TIMEZONE:-$(atrium_resolve_timezone "$(atrium_config_get '[meta]' 'timezone' 'auto')")}"
}
