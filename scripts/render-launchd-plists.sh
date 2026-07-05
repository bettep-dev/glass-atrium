#!/usr/bin/env bash
# render-launchd-plists.sh — render the 8 com.glass-atrium.* launchd plists
# from the rendered config.toml (single upper SoT — see config.toml.example).
#
# RENDER-ONLY contract (T32): writes plist FILES into an output dir; NEVER
# touches launchctl or ~/Library/LaunchAgents. Loading the rendered plists
# stays a manual user action (scripts/daemon-README.md "Loading the launchd
# Plists"); the engine's only launchctl mutation stays behind --repoint-launchd.
#
# Every absolute path in the output derives from config values — the target
# user's HOME is the parent of [paths].target_home, NOT the running $HOME —
# so rendering a config prepared for ANOTHER user yields only target-user
# paths. A foreign render containing the running user's HOME loud-fails.
#
# Env overrides (mirror the engine's GA_* sandbox pattern):
#   GA_CONFIG_TOML  config to read            (default <GA root>/config.toml)
#   GA_PLIST_OUT    rendered-plist output dir (default <GA root>/rendered/launchd)
#
# Named exit codes: 3=config missing · 4=config key missing/invalid ·
# 5=plutil lint failure · 6=authoring-user path leaked into a foreign render.
set -Eeuo pipefail
IFS=$'\n\t'

# bash 5.2+ turns patsub_replacement ON by default, making a bare '&' in a
# ${var//pat/repl} REPLACEMENT expand to the matched text — that corrupts
# xml_escape's entity strings (e.g. ${s//</&lt;} → '<lt;', dropping the '&').
# Disable it so '&' is a literal replacement char on every bash. Guarded so
# bash 3.2 (which has no such option) is a harmless no-op — NOT '\&' escaping,
# which bash 3.2 would emit literally.
shopt -u patsub_replacement 2>/dev/null || true

# GA root = parent of this script's scripts/ dir (portable, same idiom as the engine)
GA_ROOT_DEFAULT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
readonly GA_ROOT="${GA_ROOT:-${GA_ROOT_DEFAULT}}"
readonly CONFIG_TOML="${GA_CONFIG_TOML:-${GA_ROOT}/config.toml}"
readonly OUT_DIR="${GA_PLIST_OUT:-${GA_ROOT}/rendered/launchd}"
readonly LABEL_PREFIX="com.glass-atrium"

# Shared timezone resolver (atrium_resolve_timezone) — resolves the 'auto'
# sentinel to a concrete host IANA zone so the rendered plist NEVER embeds 'auto'
# (launchd + the monitor consume the literal value). Sourced relative to this
# script so the symlink-farm copy finds its lib. Sourcing only defines functions
# (no top-level commands), so it is side-effect-free under strict mode.
SCRIPT_SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
readonly SCRIPT_SELF_DIR
# shellcheck source=lib/atrium-config.sh
source "${SCRIPT_SELF_DIR}/lib/atrium-config.sh"
# job names match the [daemon.<name>] stanzas in config.toml 1:1
readonly -a JOBS=(
  monitor
  autoagent-daemon
  wiki-daemon
  monitor-log-rotate
  pg-backup
  autoagent-cycle
  wiki-compile
  daemon-daily-restart
)

# --- temp + cleanup ----------------------------------------------------------
CUR_TMP=""
cleanup() {
  local exit_code=$?
  [[ -n "${CUR_TMP}" && -f "${CUR_TMP}" ]] && rm -f -- "${CUR_TMP}"
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM
trap 'echo "ERROR: line ${LINENO}: ${BASH_COMMAND}" >&2' ERR

# --- logging -----------------------------------------------------------------
log() { printf 'render-launchd-plists: %s\n' "$*" >&2; }
die() {
  local code="$1"
  shift
  printf 'render-launchd-plists: FATAL: %s\n' "$*" >&2
  exit "${code}"
}

[[ -f "${CONFIG_TOML}" ]] \
  || die 3 "config not found: ${CONFIG_TOML} (run 'glass-atrium render-config' first)"

# --- TOML value extraction (table-scoped, same idiom as render-monitor-env.sh)
# awk tracks the active table header so a same-named key in another section is
# never matched. Args: $1 = table header literal · $2 = key name.
extract_toml_value() {
  local section="$1" key="$2"
  awk -v want="${section}" -v key="${key}" '
    /^[[:space:]]*\[/ { cur = $0; gsub(/[[:space:]]/, "", cur) }
    cur == want && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      val = $0
      sub(/^[^=]*=[[:space:]]*/, "", val)
      sub(/[[:space:]]*(#.*)?$/, "", val)
      gsub(/^"|"$/, "", val)
      print val
      exit
    }
  ' "${CONFIG_TOML}"
}

require_toml_value() {
  local section="$1" key="$2" val
  val="$(extract_toml_value "${section}" "${key}")"
  [[ -n "${val}" ]] || die 4 "missing ${section}.${key} in ${CONFIG_TOML}"
  printf '%s\n' "${val}"
}

# absolute-path variant — an unexpanded ${HOME} template literal fails here
require_abs_path() {
  local val
  val="$(require_toml_value "$1" "$2")"
  [[ "${val}" == /* ]] \
    || die 4 "$1.$2='${val}' must be an absolute path (unrendered template?)"
  printf '%s\n' "${val}"
}

# --- config load ---------------------------------------------------------------
# [meta].timezone may be the 'auto' sentinel (host-default) — resolve it to a
# CONCRETE IANA name here so the rendered plist NEVER embeds 'auto'. The
# require_toml_value read still loud-fails (exit 4) on an absent key; resolution
# is build-time host detection via the shared helper's TZ-immune symlink read.
TIMEZONE_CONFIGURED="$(require_toml_value "[meta]" "timezone")"
TIMEZONE="$(atrium_resolve_timezone "${TIMEZONE_CONFIGURED}")"
ROOT_PATH="$(require_abs_path "[paths]" "root")"
TARGET_HOME_PATH="$(require_abs_path "[paths]" "target_home")"
MONITOR_DIR="$(require_abs_path "[paths]" "monitor")"
NODE_BIN="$(require_abs_path "[paths]" "node_bin")"
LOG_ROOT="$(require_abs_path "[paths]" "log_root")"
readonly TIMEZONE ROOT_PATH TARGET_HOME_PATH MONITOR_DIR NODE_BIN LOG_ROOT

# target user's HOME = parent of the harness home anchor ([paths].target_home,
# canonically <home>/.claude) — config-derived so ONE input drives the render
RENDER_HOME="$(dirname -- "${TARGET_HOME_PATH}")"
[[ "${RENDER_HOME}" != "/" && "${RENDER_HOME}" == /* ]] \
  || die 4 "cannot derive target HOME from [paths].target_home='${TARGET_HOME_PATH}'"
readonly RENDER_HOME

# launchd jobs get a minimal fixed PATH; the node dir leads (config-derived,
# no hardcoded Homebrew assumption)
NODE_DIR="$(dirname -- "${NODE_BIN}")"
readonly PATH_VALUE="${NODE_DIR}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
readonly WIKI_ROOT="${ROOT_PATH}/wiki"

# --- XML escaping --------------------------------------------------------------
xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"
  s="${s//</&lt;}"
  s="${s//>/&gt;}"
  printf '%s\n' "${s}"
}

E_HOME="$(xml_escape "${RENDER_HOME}")"
E_PATH="$(xml_escape "${PATH_VALUE}")"
E_ROOT="$(xml_escape "${ROOT_PATH}")"
E_MONITOR="$(xml_escape "${MONITOR_DIR}")"
E_NODE="$(xml_escape "${NODE_BIN}")"
E_LOGROOT="$(xml_escape "${LOG_ROOT}")"
E_TZ="$(xml_escape "${TIMEZONE}")"
E_WIKI="$(xml_escape "${WIKI_ROOT}")"
readonly E_HOME E_PATH E_ROOT E_MONITOR E_NODE E_LOGROOT E_TZ E_WIKI

# --- XML fragment helpers --------------------------------------------------------
# one <string> element per argument (ProgramArguments entries)
arg_xml() { printf '\t\t<string>%s</string>\n' "$@"; }
# one <key>/<string> pair (EnvironmentVariables entries)
env_kv() { printf '\t\t<key>%s</key>\n\t\t<string>%s</string>\n' "$1" "$2"; }

# lifecycle keys from the job's [daemon.<name>] stanza — mode="keepalive" →
# resident job · time="HH:MM" → daily StartCalendarInterval; anything else dies
lifecycle_xml() {
  local job="$1" mode time_val hour minute
  mode="$(extract_toml_value "[daemon.${job}]" "mode")"
  time_val="$(extract_toml_value "[daemon.${job}]" "time")"
  if [[ "${mode}" == "keepalive" ]]; then
    cat <<'XML'
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>30</integer>
XML
    return 0
  fi
  [[ "${time_val}" =~ ^([0-9]{1,2}):([0-9]{2})$ ]] \
    || die 4 "[daemon.${job}] needs mode=\"keepalive\" or time=\"HH:MM\" (mode='${mode}' time='${time_val}')"
  # 10# base prefix — "04"/"08" would otherwise parse as invalid octal
  hour=$((10#${BASH_REMATCH[1]}))
  minute=$((10#${BASH_REMATCH[2]}))
  ((hour <= 23 && minute <= 59)) \
    || die 4 "[daemon.${job}].time '${time_val}' out of range"
  cat <<XML
	<key>RunAtLoad</key>
	<false/>
	<key>KeepAlive</key>
	<false/>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>${hour}</integer>
		<key>Minute</key>
		<integer>${minute}</integer>
	</dict>
XML
}

# --- per-job render ---------------------------------------------------------------
# Shapes mirror the proven live plists 1:1. /tmp log paths are deliberate
# (machine-shared, no user path; the daemon healthcheck scripts tail them).
render_job() {
  local job="$1"
  local label="${LABEL_PREFIX}.${job}"
  local args_xml env_xml workdir out_log err_log lifecycle cmd
  lifecycle="$(lifecycle_xml "${job}")"

  case "${job}" in
    monitor)
      args_xml="$(arg_xml "${E_NODE}" "${E_MONITOR}/dist/server/main.js")"
      # TZ/PGTZ=UTC pin the server clock; [meta].timezone applies to schedules
      env_xml="$(
        env_kv HOME "${E_HOME}"
        env_kv NODE_ENV production
        env_kv PATH "${E_PATH}"
        env_kv PGTZ UTC
        env_kv TZ UTC
      )"
      workdir="${E_MONITOR}"
      out_log="${E_LOGROOT}/monitor.out.log"
      err_log="${E_LOGROOT}/monitor.err.log"
      ;;
    autoagent-daemon)
      args_xml="$(arg_xml /bin/bash "${E_ROOT}/scripts/autoagent-daemon-bootstrap.sh")"
      env_xml="$(
        env_kv HOME "${E_HOME}"
        env_kv PATH "${E_PATH}"
      )"
      workdir="${E_HOME}"
      out_log="/tmp/autoagent-daemon.log"
      err_log="/tmp/autoagent-daemon.log"
      ;;
    wiki-daemon)
      args_xml="$(arg_xml /bin/bash "${E_ROOT}/scripts/wiki-daemon-bootstrap.sh")"
      env_xml="$(
        env_kv HOME "${E_HOME}"
        env_kv PATH "${E_PATH}"
        env_kv WIKI_ROOT "${E_WIKI}"
      )"
      workdir="${E_HOME}"
      out_log="/tmp/wiki-daemon.log"
      err_log="/tmp/wiki-daemon.log"
      ;;
    monitor-log-rotate)
      args_xml="$(arg_xml /bin/bash "${E_ROOT}/scripts/monitor-log-rotate.sh")"
      env_xml="$(
        env_kv HOME "${E_HOME}"
        env_kv PATH "${E_PATH}"
      )"
      workdir="${E_HOME}"
      out_log="/tmp/monitor-log-rotate.out.log"
      err_log="/tmp/monitor-log-rotate.err.log"
      ;;
    pg-backup)
      args_xml="$(arg_xml /bin/bash -c "${E_ROOT}/scripts/pg-backup.sh")"
      env_xml="$(
        env_kv HOME "${E_HOME}"
        env_kv PATH "${E_PATH}"
      )"
      workdir="${E_HOME}"
      out_log="/tmp/pg-backup.log"
      err_log="/tmp/pg-backup.log"
      ;;
    autoagent-cycle)
      # daemon-cycle.sh is consumed in place from the store (GA root) — the
      # ~/.claude/autoagent farm is gone, same store-path form as wiki-compile.
      cmd="$(xml_escape "bash ${ROOT_PATH}/autoagent/daemon-cycle.sh")"
      args_xml="$(arg_xml /bin/bash -l -c "${cmd}")"
      env_xml="$(
        env_kv HOME "${E_HOME}"
        env_kv PATH "${E_PATH}"
        env_kv TZ "${E_TZ}"
      )"
      workdir="${E_HOME}"
      out_log="/tmp/autoagent-daemon-loop.log"
      err_log="/tmp/autoagent-daemon-loop.log"
      ;;
    wiki-compile)
      cmd="$(xml_escape "${ROOT_PATH}/scripts/wiki-daily-compile.sh; ${ROOT_PATH}/scripts/wiki-daemon-cycle.sh >> /tmp/wiki-daemon-loop.log 2>&1")"
      args_xml="$(arg_xml /bin/bash -lc "${cmd}")"
      env_xml="$(
        env_kv HOME "${E_HOME}"
        env_kv PATH "${E_PATH}"
        env_kv WIKI_ROOT "${E_WIKI}"
      )"
      workdir="${E_HOME}"
      out_log="/tmp/wiki-compile.log"
      err_log="/tmp/wiki-compile.log"
      ;;
    daemon-daily-restart)
      cmd="$(xml_escape "/bin/bash ${ROOT_PATH}/scripts/daemon-daily-restart.sh autoagent; /bin/bash ${ROOT_PATH}/scripts/daemon-daily-restart.sh wiki")"
      args_xml="$(arg_xml /bin/bash -c "${cmd}")"
      env_xml="$(
        env_kv HOME "${E_HOME}"
        env_kv PATH "${E_PATH}"
        env_kv WIKI_ROOT "${E_WIKI}"
      )"
      workdir="${E_HOME}"
      out_log="/tmp/daemon-daily-restart.log"
      err_log="/tmp/daemon-daily-restart.log"
      ;;
    *) die 4 "unknown job: ${job}" ;;
  esac

  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${label}</string>
	<key>ProgramArguments</key>
	<array>
${args_xml}
	</array>
${lifecycle}
	<key>WorkingDirectory</key>
	<string>${workdir}</string>
	<key>StandardOutPath</key>
	<string>${out_log}</string>
	<key>StandardErrorPath</key>
	<string>${err_log}</string>
	<key>EnvironmentVariables</key>
	<dict>
${env_xml}
	</dict>
</dict>
</plist>
PLIST
}

main() {
  mkdir -p -- "${OUT_DIR}"
  local job dest
  for job in "${JOBS[@]}"; do
    dest="${OUT_DIR}/${LABEL_PREFIX}.${job}.plist"
    # atomic write: render to a temp, mv over the target (never a half file)
    CUR_TMP="${dest}.ga-render.$$"
    render_job "${job}" >"${CUR_TMP}"
    mv -f -- "${CUR_TMP}" "${dest}"
    CUR_TMP=""
    log "rendered ${dest}"
  done

  if command -v plutil >/dev/null 2>&1; then
    for job in "${JOBS[@]}"; do
      plutil -lint -s "${OUT_DIR}/${LABEL_PREFIX}.${job}.plist" \
        || die 5 "plutil lint failed: ${LABEL_PREFIX}.${job}.plist"
    done
    log "plutil lint: ${#JOBS[@]} plists valid"
  else
    log "plutil not found — lint skipped (non-macOS host?)"
  fi

  # T32 leak gate: a FOREIGN-user render (target home != running $HOME) must
  # contain ZERO authoring-user paths — loud-fail, never a silent leak
  if [[ "${RENDER_HOME}" != "${HOME}" ]]; then
    local leaks
    leaks="$(grep -lF "${HOME}" "${OUT_DIR}/${LABEL_PREFIX}".*.plist 2>/dev/null || true)"
    [[ -z "${leaks}" ]] \
      || die 6 "authoring-user path leaked into foreign render: ${leaks}"
    log "foreign-user render verified: 0 authoring-user path hits (target home=${RENDER_HOME})"
  fi
  log "done — ${#JOBS[@]} plists in ${OUT_DIR} (loading stays manual: scripts/daemon-README.md)"
}

main
