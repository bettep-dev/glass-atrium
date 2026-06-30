#!/usr/bin/env bash
# render-monitor-env.sh — render config.toml values into monitor/.env
# Usage: render-monitor-env.sh
#
# Renders six keys (all gitignored render outputs of config.toml, the upper
# SoT — see config.toml header):
#   ATRIUM_MONITOR_PORT     ← [ports].monitor          (bindable integer 1-65535)
#   CLAUDED_DOCS_HTML_ROOT  ← [paths].monitor_docs_html_root  (absolute dir path)
#   ATRIUM_TIMEZONE         ← [meta].timezone RESOLVED  ('auto'→host IANA via the
#                             shared resolver; explicit name used verbatim)
#   ATRIUM_SCHEDULE_AUTOAGENT     ← [daemon.autoagent-cycle].time      ("HH:MM" 24h)
#   ATRIUM_SCHEDULE_WIKI          ← [daemon.wiki-compile].time         ("HH:MM" 24h)
#   ATRIUM_SCHEDULE_DAILY_RESTART ← [daemon.daemon-daily-restart].time ("HH:MM" 24h)
#
# The three ATRIUM_SCHEDULE_* keys mirror the proven ATRIUM_TIMEZONE render-then-
# consume path: config.toml [daemon.*].time is the upper SoT, the monitor reads
# env only, and schedule-next-fire.ts builds DAEMON_CRON_SCHEDULE from these env
# values at module load — so the monitor's "next due" can never again drift from
# the launchd reality that render-launchd-plists.sh derives from the SAME config.
#
# Behavior:
#   1. Parse each value from its config.toml table via the shared table-scoped
#      extractor (lib/atrium-config.sh atrium_toml_get — no TOML-parser
#      dependency; a same-named key in another section can never collide,
#      [ports].monitor vs [paths].monitor).
#   2. Validate (port = integer range · html-root = existing absolute dir).
#   3. Upsert KEY=<value> into monitor/.env (replace if present, append if
#      absent).
#
# Rationale: config.toml is the declarative SoT; the running monitor reads env
# only. dist/server/main.js loads monitor/.env via `dotenv/config`, so writing
# the rendered values here is the lowest-friction wiring — the launchd plist runs
# `node dist/server/main.js` directly (no wrapper to hook), and the plist lives
# outside the git repo. Keeping the render in .env avoids editing the plist.
#
# CLAUDED_DOCS_MD_ROOT (Obsidian vault, legacy read-only) is deliberately NOT
# rendered — storage.ts's built-in default is correct and migration left it
# unchanged.
#
# Idempotency: safe to invoke repeatedly — upsert replaces the same key in place.
# Re-run after any change to the rendered config.toml keys; no rebuild needed
# (env is read at process start) — only a monitor restart picks up new values.
set -euo pipefail

readonly GA_ROOT="${GA_ROOT:-${HOME}/.glass-atrium}"
readonly ENV_FILE="${GA_ROOT}/monitor/.env"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

# Shared table-scoped TOML extractor (single parser SoT for shell consumers).
# shellcheck source=lib/atrium-config.sh
source "${SCRIPT_DIR}/lib/atrium-config.sh"
CONFIG_TOML="$(atrium_config_file)"
readonly CONFIG_TOML

[[ -f "${CONFIG_TOML}" ]] || {
  echo "render-monitor-env: config.toml not found at ${CONFIG_TOML}" >&2
  exit 5
}

# Upsert KEY=value into monitor/.env (replace in place if present, else append).
# Args: $1 = key · $2 = value.
upsert_env() {
  local env_key="$1" env_val="$2"
  touch "${ENV_FILE}"
  if grep -qE "^${env_key}=" "${ENV_FILE}"; then
    # Rewrite the matching line via awk, passing the value through ENVIRON (the
    # process environment) rather than sed's replacement string. WHY: sed's
    # replacement interprets `&` (whole-match backreference), `\`, and the `|`
    # delimiter — a path value containing `&` (e.g. /Users/a&b/docs, a legal macOS
    # path) would corrupt/duplicate the line, so the monitor would read a wrong
    # HTML root. awk's ENVIRON[] is read byte-for-byte with NO metachar
    # interpretation (unlike `-v val=`, which DOES process backslash escapes like
    # `\b` — so it is also unsafe for paths). The key is a fixed internal constant
    # → safe to pass via -v; match on an exact key field (split at first `=`) so
    # the rewrite cannot misfire on a key prefix.
    local tmp
    tmp="$(mktemp)"
    UPSERT_VAL="${env_val}" awk -v key="${env_key}" '
      index($0, key "=") == 1 { print key "=" ENVIRON["UPSERT_VAL"]; next }
      { print }
    ' "${ENV_FILE}" >"${tmp}" && cat "${tmp}" >"${ENV_FILE}"
    rm -f "${tmp}"
  else
    # 마지막 줄이 개행 없이 끝나면 append 가 그 줄에 이어붙어 기존 키와 새 키가
    # 한 줄로 합쳐진다 (dotenv 양쪽 모두 유실) → 줄 경계 보장 후 추가.
    local last_byte
    last_byte="$(tail -c 1 "${ENV_FILE}")"
    if [[ -n "${last_byte}" ]]; then
      printf '\n' >>"${ENV_FILE}"
    fi
    printf '%s=%s\n' "${env_key}" "${env_val}" >>"${ENV_FILE}"
  fi
  echo "render-monitor-env: ${env_key}=${env_val} → ${ENV_FILE}"
}

# Read + validate a [daemon.<job>].time value, storing the validated "HH:MM"
# string in the SCHEDULE_TIME global (REPLY-style out-param). HH:MM + range
# validation mirrors render-launchd-plists.sh lifecycle_xml exactly
# (^([0-9]{1,2}):([0-9]{2})$ + hour<=23, minute<=59) so the two renderers agree.
# Loud-fail on missing/malformed: distinct named exit + stderr. MUST be called
# DIRECTLY (never inside "$(...)") — an `exit` inside a command-substitution
# subshell would terminate only the subshell, not this script.
# Args: $1 = table header literal (e.g. "[daemon.wiki-compile]") · $2 = exit code
# for a MISSING key · $3 = exit code for a MALFORMED/out-of-range value.
require_schedule_time() {
  local section="$1" exit_missing="$2" exit_malformed="$3"
  local val hour minute
  val="$(atrium_toml_get "${section}" "time")"
  [[ -n "${val}" ]] || {
    echo "render-monitor-env: ${section}.time not found in ${CONFIG_TOML}" >&2
    exit "${exit_missing}"
  }
  [[ "${val}" =~ ^([0-9]{1,2}):([0-9]{2})$ ]] || {
    echo "render-monitor-env: invalid ${section}.time='${val}' — must be \"HH:MM\" (24h)" >&2
    exit "${exit_malformed}"
  }
  # 10# base prefix — "04"/"08" would otherwise parse as invalid octal.
  hour=$((10#${BASH_REMATCH[1]}))
  minute=$((10#${BASH_REMATCH[2]}))
  ((hour <= 23 && minute <= 59)) || {
    echo "render-monitor-env: ${section}.time='${val}' out of range (hour<=23, minute<=59)" >&2
    exit "${exit_malformed}"
  }
  SCHEDULE_TIME="${val}"
}

# --- 1. ATRIUM_MONITOR_PORT ← [ports].monitor --------------------------------
PORT="$(atrium_toml_get "[ports]" "monitor")"
[[ -n "${PORT}" ]] || {
  echo "render-monitor-env: [ports].monitor not found in ${CONFIG_TOML}" >&2
  exit 6
}

# Validate bindable integer range — fail loud, never render a wrong port.
if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  echo "render-monitor-env: invalid [ports].monitor='${PORT}' — must be 1-65535" >&2
  exit 7
fi

# --- 2. CLAUDED_DOCS_HTML_ROOT ← [paths].monitor_docs_html_root ---------------
DOCS_HTML_ROOT="$(atrium_toml_get "[paths]" "monitor_docs_html_root")"
[[ -n "${DOCS_HTML_ROOT}" ]] || {
  echo "render-monitor-env: [paths].monitor_docs_html_root not found in ${CONFIG_TOML}" >&2
  exit 8
}

# Validate absolute path to an existing directory — fail loud, never render a
# path the server would reject as "path escapes root".
if [[ "${DOCS_HTML_ROOT}" != /* ]] || [[ ! -d "${DOCS_HTML_ROOT}" ]]; then
  echo "render-monitor-env: invalid [paths].monitor_docs_html_root='${DOCS_HTML_ROOT}' — must be an existing absolute directory" >&2
  exit 9
fi

# --- 3. ATRIUM_TIMEZONE ← [meta].timezone (RESOLVED) --------------------------
# Read the configured value (default 'auto' when the key is absent) then RESOLVE
# it to a CONCRETE IANA name — the rendered ATRIUM_TIMEZONE must NEVER carry the
# literal 'auto' (the monitor reads env verbatim and feeds it to Intl/PG, where
# 'auto' is not a valid zone). Host detection runs HERE at build time via the
# shared resolver's TZ-immune /etc/localtime read, sidestepping the launchd
# TZ=UTC pin that shadows the monitor's runtime Intl. An explicit value triggers
# the resolver's OD-2 stderr warning when it differs from the host zone.
# Authoritative IANA validation stays server-side (timezone.ts boot guard); here
# only a charset guard blocks values that could corrupt the .env line.
TZ_CONFIGURED="$(atrium_config_get "[meta]" "timezone" "auto")"
TZ_VALUE="$(atrium_resolve_timezone "${TZ_CONFIGURED}")"
if ! [[ "${TZ_VALUE}" =~ ^[A-Za-z0-9_+/-]+$ ]]; then
  echo "render-monitor-env: invalid resolved timezone='${TZ_VALUE}' (from [meta].timezone='${TZ_CONFIGURED}') — must be an IANA timezone name (e.g. Asia/Seoul)" >&2
  exit 10
fi

# --- 4. ATRIUM_SCHEDULE_* ← [daemon.*].time -----------------------------------
# Read + validate ALL THREE daemon schedule times BEFORE any upsert below, so a
# missing/malformed time loud-fails with ZERO schedule keys written (no partial
# render — the whole upsert block runs only after every value is validated).
# Distinct exit codes per (key, failure-mode) continue the existing 5-10 ladder.
# The shell owns the config-job-name → monitor-logical-env-key transform; the
# backend (schedule-next-fire.ts) fans ATRIUM_SCHEDULE_DAILY_RESTART out to both
# daily-restart rows. Concrete values render here; the monitor never re-parses
# config.toml.
require_schedule_time "[daemon.autoagent-cycle]" 11 12
SCHED_AUTOAGENT="${SCHEDULE_TIME}"
require_schedule_time "[daemon.wiki-compile]" 13 14
SCHED_WIKI="${SCHEDULE_TIME}"
require_schedule_time "[daemon.daemon-daily-restart]" 15 16
SCHED_DAILY_RESTART="${SCHEDULE_TIME}"

# --- render all keys -----------------------------------------------------------
upsert_env "ATRIUM_MONITOR_PORT" "${PORT}"
upsert_env "CLAUDED_DOCS_HTML_ROOT" "${DOCS_HTML_ROOT}"
upsert_env "ATRIUM_TIMEZONE" "${TZ_VALUE}"
upsert_env "ATRIUM_SCHEDULE_AUTOAGENT" "${SCHED_AUTOAGENT}"
upsert_env "ATRIUM_SCHEDULE_WIKI" "${SCHED_WIKI}"
upsert_env "ATRIUM_SCHEDULE_DAILY_RESTART" "${SCHED_DAILY_RESTART}"
