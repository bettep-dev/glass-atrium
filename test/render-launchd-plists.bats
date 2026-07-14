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

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_RENDERER="${GA}/scripts/render-launchd-plists.sh"
REAL_GA="${GA}/glass-atrium"
TEMPLATE="${GA}/config.toml.example"
FAKE_HOME="/Users/ga-fake-user"

setup() {
  [[ -f "${REAL_RENDERER}" ]] || skip "renderer not found: ${REAL_RENDERER}"
  [[ -f "${TEMPLATE}" ]] || skip "config template not found: ${TEMPLATE}"
  [[ "${HOME}" != "${FAKE_HOME}" ]] || skip "real HOME collides with fixture home"
  SANDBOX="$(mktemp -d -t ga-plist-bats.XXXXXX)"
  FAKE_CONFIG="${SANDBOX}/config.toml"
  OUT="${SANDBOX}/launchd"
  # same substitution glass-atrium render_config performs, against the fake home.
  # Pin [meta].timezone to an EXPLICIT zone (template default is 'auto', which
  # resolves via the host — Asia/Seoul on a KST dev box but Etc/UTC on CI). An
  # explicit value round-trips verbatim through atrium_resolve_timezone, so the
  # TZ assertion below is deterministic on any host.
  sed -e "s|\${HOME}|${FAKE_HOME}|g" \
    -e 's|^timezone = .*|timezone = "Asia/Seoul"|' \
    "${TEMPLATE}" >"${FAKE_CONFIG}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
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

# bats 1.13 checks ONLY the last command's status, so intermediate `[[ ]]` assertions
# are non-gating — the new tests below carry `|| return 1` on every gating assertion.

@test "rendered PATH carries the Homebrew bin dir (config-derived from claude_bin)" {
  # Point node_bin at a NON-Homebrew dir so NODE_DIR alone cannot supply
  # /opt/homebrew/bin — the fix must derive it from [paths].claude_bin's dirname.
  # RED before the fix: PATH_VALUE had only NODE_DIR + /usr/local/bin + system dirs,
  # so tmux/claude/bun/lsof could not resolve under launchd (daily restarts died).
  sed -e 's|^node_bin = .*|node_bin = "/opt/ga-nonbrew/bin/node"|' \
    -e 's|^claude_bin = .*|claude_bin = "/opt/homebrew/bin/claude"|' \
    "${FAKE_CONFIG}" >"${FAKE_CONFIG}.brew"
  mv -f "${FAKE_CONFIG}.brew" "${FAKE_CONFIG}"
  GA_SKIP_DEP_PROBE=1 GA_CONFIG_TOML="${FAKE_CONFIG}" GA_PLIST_OUT="${OUT}" run "${REAL_RENDERER}"
  [[ "${status}" -eq 0 ]] || return 1
  # every plist's PATH must carry the Homebrew bin dir (from claude_bin's dirname)
  run grep -RlF '/opt/homebrew/bin' "${OUT}"
  [[ "${#lines[@]}" -eq 8 ]] || return 1
  # inside the monitor plist's PATH string specifically (positive control), and the
  # configured non-brew node dir still leads the PATH (the strongest discriminator)
  run grep -A1 '<key>PATH</key>' "${OUT}/com.glass-atrium.monitor.plist"
  [[ "${output}" == *'/opt/ga-nonbrew/bin:/opt/homebrew/bin:'* ]] || return 1
}

@test "claude_bin absent -> PATH falls back to /opt/homebrew/bin (inert on Intel)" {
  # Drop the claude_bin key entirely; the fallback must still list the canonical
  # Homebrew bin dir (a non-existent dir is simply ignored by launchd).
  sed -e '/^claude_bin = /d' \
    -e 's|^node_bin = .*|node_bin = "/opt/ga-nonbrew/bin/node"|' \
    "${FAKE_CONFIG}" >"${FAKE_CONFIG}.nobrew"
  mv -f "${FAKE_CONFIG}.nobrew" "${FAKE_CONFIG}"
  GA_SKIP_DEP_PROBE=1 GA_CONFIG_TOML="${FAKE_CONFIG}" GA_PLIST_OUT="${OUT}" run "${REAL_RENDERER}"
  [[ "${status}" -eq 0 ]] || return 1
  run grep -RlF '/opt/homebrew/bin' "${OUT}"
  [[ "${#lines[@]}" -eq 8 ]] || return 1
}

@test "dependency probe is WARN-only + honors same-host gate and GA_SKIP_DEP_PROBE" {
  # Build a SAME-HOST config (target_home under the REAL $HOME) so the probe's
  # same-host gate is active, then assert the render still SUCCEEDS (never die) and
  # that GA_SKIP_DEP_PROBE=1 fully silences the probe (no WARN, no probe log).
  local same_host_cfg="${SANDBOX}/config.samehost.toml"
  sed -e "s|\${HOME}|${HOME}|g" \
    -e 's|^timezone = .*|timezone = "Asia/Seoul"|' \
    "${TEMPLATE}" >"${same_host_cfg}"
  GA_SKIP_DEP_PROBE=1 GA_CONFIG_TOML="${same_host_cfg}" GA_PLIST_OUT="${OUT}" run "${REAL_RENDERER}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"WARN:"* ]] || return 1
  [[ "${output}" != *"dependency probe:"* ]] || return 1
}

@test "same-host render runs the probe (WARN-only positive path, still exit 0)" {
  # The silence-only tests above cover the two SKIP branches (kill-switch + foreign
  # gate) but never let the probe body RUN — a regression making it die would go
  # uncaught. Here a SAME-HOST render (RENDER_HOME == real $HOME) WITHOUT the
  # kill-switch opens the probe, so it executes and must still exit 0.
  # Machine-independent: with the probe running, EXACTLY one branch logs — a 'WARN:'
  # on any unresolved tool, or the all-resolve 'dependency probe:' line — so the OR
  # holds on any host regardless of which of tmux/claude/bun/lsof are installed.
  local same_host_cfg="${SANDBOX}/config.samehost.toml"
  sed -e "s|\${HOME}|${HOME}|g" \
    -e 's|^timezone = .*|timezone = "Asia/Seoul"|' \
    "${TEMPLATE}" >"${same_host_cfg}"
  GA_CONFIG_TOML="${same_host_cfg}" GA_PLIST_OUT="${OUT}" run "${REAL_RENDERER}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"WARN:"* || "${output}" == *"dependency probe:"* ]] || return 1
}

@test "foreign-user render never triggers the dependency probe (RENDER-ONLY T32 intact)" {
  # The default fake-user render is FOREIGN (FAKE_HOME != real $HOME); the probe must
  # self-skip there regardless of the kill-switch, so no probe output ever appears.
  run_render
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"WARN:"* ]] || return 1
  [[ "${output}" != *"dependency probe:"* ]] || return 1
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
