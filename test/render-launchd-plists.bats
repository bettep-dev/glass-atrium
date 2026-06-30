#!/usr/bin/env bats
# render-launchd-plists.sh — T32 pin: rendering plists for a TARGET user must
# produce ONLY target-user paths (zero authoring-user path hits), with valid
# plist XML and config-driven schedules. The renderer is file-write only — it
# must never invoke launchctl (the --repoint-launchd guard owns that).
#
# Run via: bats test/render-launchd-plists.bats
# Requires: bats (brew install bats-core), bash 3.2+
#
# Hermetic strategy: a fake-user config is rendered from config.toml.example
# (the exact render_config sed), and GA_CONFIG_TOML + GA_PLIST_OUT point the
# REAL renderer at a mktemp sandbox — the real config.toml and rendered/ dir
# are never touched.

REAL_RENDERER="${HOME}/.glass-atrium/scripts/render-launchd-plists.sh"
REAL_GA="${HOME}/.glass-atrium/glass-atrium"
TEMPLATE="${HOME}/.glass-atrium/config.toml.example"
FAKE_HOME="/Users/ga-fake-user"

setup() {
  [[ -f "${REAL_RENDERER}" ]] || skip "renderer not found: ${REAL_RENDERER}"
  [[ -f "${TEMPLATE}" ]] || skip "config template not found: ${TEMPLATE}"
  [[ "${HOME}" != "${FAKE_HOME}" ]] || skip "real HOME collides with fixture home"
  SANDBOX="$(mktemp -d -t ga-plist-bats.XXXXXX)"
  FAKE_CONFIG="${SANDBOX}/config.toml"
  OUT="${SANDBOX}/launchd"
  # same substitution glass-atrium render_config performs, against the fake home
  sed "s|\${HOME}|${FAKE_HOME}|g" "${TEMPLATE}" >"${FAKE_CONFIG}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

run_render() {
  GA_CONFIG_TOML="${FAKE_CONFIG}" GA_PLIST_OUT="${OUT}" run "${REAL_RENDERER}"
}

@test "fake-user render -> 8 plists, zero authoring-user paths, target paths present" {
  run_render
  [[ "${status}" -eq 0 ]]
  # all 8 daemon plists rendered
  run find "${OUT}" -name 'com.glass-atrium.*.plist'
  [[ "${#lines[@]}" -eq 8 ]]
  # T32 AC: zero authoring-user path hits (grep -F exits 1 = no match)
  run grep -RF "${HOME}" "${OUT}"
  [[ "${status}" -eq 1 ]]
  # every plist carries the fake target home (positive control)
  run grep -RlF "${FAKE_HOME}" "${OUT}"
  [[ "${#lines[@]}" -eq 8 ]]
}

@test "rendered plists pass plutil -lint" {
  command -v plutil >/dev/null 2>&1 || skip "plutil not available"
  run_render
  [[ "${status}" -eq 0 ]]
  local f
  for f in "${OUT}"/com.glass-atrium.*.plist; do
    plutil -lint -s "${f}"
  done
}

@test "schedules + lifecycle come from config ([daemon.*] stanzas)" {
  run_render
  [[ "${status}" -eq 0 ]]
  # pg-backup: time = "02:30" -> Hour 2 / Minute 30
  run grep -A1 '<key>Hour</key>' "${OUT}/com.glass-atrium.pg-backup.plist"
  [[ "${output}" == *"<integer>2</integer>"* ]]
  run grep -A1 '<key>Minute</key>' "${OUT}/com.glass-atrium.pg-backup.plist"
  [[ "${output}" == *"<integer>30</integer>"* ]]
  # monitor: mode = "keepalive" -> KeepAlive dict + RunAtLoad true
  grep -q '<key>SuccessfulExit</key>' "${OUT}/com.glass-atrium.monitor.plist"
  grep -qF '<true/>' "${OUT}/com.glass-atrium.monitor.plist"
  # autoagent-cycle: TZ = [meta].timezone
  grep -qF '<string>Asia/Seoul</string>' "${OUT}/com.glass-atrium.autoagent-cycle.plist"
}

@test "shell redirection in wiki-compile command is XML-escaped" {
  run_render
  [[ "${status}" -eq 0 ]]
  grep -qF '&gt;&gt; /tmp/wiki-daemon-loop.log 2&gt;&amp;1' \
    "${OUT}/com.glass-atrium.wiki-compile.plist"
  # raw unescaped redirect chars must NOT survive inside the <string> value
  run grep -F '>> /tmp/wiki-daemon-loop.log' "${OUT}/com.glass-atrium.wiki-compile.plist"
  [[ "${status}" -eq 1 ]]
}

@test "missing config -> named exit 3" {
  GA_CONFIG_TOML="${SANDBOX}/no-such-config.toml" GA_PLIST_OUT="${OUT}" run "${REAL_RENDERER}"
  [[ "${status}" -eq 3 ]]
  [[ "${output}" == *"config not found"* ]]
}

@test "authoring-user path in a foreign-user config -> leak gate exit 6" {
  # corrupt one path key with the REAL home while target_home stays fake —
  # the foreign-render leak gate must refuse the mixed output
  sed "s|^log_root = .*|log_root = \"${HOME}/.claude/logs\"|" \
    "${FAKE_CONFIG}" >"${FAKE_CONFIG}.mixed"
  mv -f "${FAKE_CONFIG}.mixed" "${FAKE_CONFIG}"
  run_render
  [[ "${status}" -eq 6 ]]
  [[ "${output}" == *"leaked into foreign render"* ]]
}

@test "renderer never invokes launchctl (render-only contract)" {
  # static pin: the render path must stay file-write only; loading is manual.
  # launchctl may appear ONLY in comment lines — code lines must have zero hits
  run grep -v '^[[:space:]]*#' "${REAL_RENDERER}"
  [[ "${output}" != *"launchctl"* ]]
}

@test "glass-atrium render-plists subcommand renders into GA_PLIST_OUT (wiring)" {
  [[ -f "${REAL_GA}" ]] || skip "glass-atrium not found: ${REAL_GA}"
  GA_CONFIG_TOML="${FAKE_CONFIG}" GA_PLIST_OUT="${OUT}" run "${REAL_GA}" render-plists
  [[ "${status}" -eq 0 ]]
  run find "${OUT}" -name 'com.glass-atrium.*.plist'
  [[ "${#lines[@]}" -eq 8 ]]
  # the wired path inherits the leak gate: zero authoring-user paths
  run grep -RF "${HOME}" "${OUT}"
  [[ "${status}" -eq 1 ]]
}
