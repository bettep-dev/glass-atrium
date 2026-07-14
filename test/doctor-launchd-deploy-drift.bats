#!/usr/bin/env bats
# run_doctor §11 launchd deploy-drift gate (lib/ga-doctor.sh).
#
# The plist renderer (render-launchd-plists.sh) is RENDER-ONLY (T32): it writes plists
# into RENDERED_PLIST_DIR but NEVER deploys/reloads them — deploy+reload is a SEPARATE
# step (load_launchd_jobs / --load-launchd). So a renderer change (e.g. the PATH_VALUE
# fix) that is re-rendered but NEVER re-deployed leaves the plists LOADED under
# ~/Library/LaunchAgents diverged from the current renderer output — the daemons run for
# days on stale content (the exact PATH-drift incident this guard prevents from recurring).
# render-time probe_launchd_deps() guards only render-time resolvability, not this deploy
# gap. §11 re-renders into a TEMP dir (GA_PLIST_OUT override, side-effect-free per the
# render-only contract) and sha256-compares each DEPLOYED plist against its twin, surfacing
# drift as an advisory WARN (never a hard FAIL — mirrors §8 manifest drift).
#
# fail-before/pass-after: the drift-warn line did not exist before §11 was added.
#
# Run via: bats test/doctor-launchd-deploy-drift.bats
# Requires: bats >= 1.5.0, bash 3.2+, shasum (macOS/CI) or sha256sum
#
# Hermetic strategy: GA_ROOT stays the REAL tree (so PLIST_RENDERER + its lib exist), but
# HOME is a throwaway sandbox (LAUNCH_AGENTS -> sandbox), GA_CONFIG_TOML a fake config
# rendered from config.toml.example against the sandbox home (RENDER_HOME == sandbox HOME,
# so no T32 leak gate), GA_TARGET_HOME/GA_MANIFEST a throwaway sandbox, and
# GA_GENERATE_MANIFEST a fast exit-0 stub (so §8 never shells the real generator under the
# fake HOME). No real ~/.claude, ~/Library/LaunchAgents, config.toml, or launchd job is
# touched. The reference plists are pre-rendered in setup with the EXACT renderer + config +
# GA_SKIP_DEP_PROBE doctor §11 uses internally, so a copied plist is byte-identical to
# doctor's re-render.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_RENDERER="${GA}/scripts/render-launchd-plists.sh"
TEMPLATE="${GA}/config.toml.example"

# the 8 com.glass-atrium.* jobs (mirrors LAUNCHD_JOBS / render-launchd-plists.sh JOBS)
JOBS=(
  monitor
  autoagent-daemon
  wiki-daemon
  monitor-log-rotate
  pg-backup
  autoagent-cycle
  wiki-compile
  daemon-daily-restart
)

setup() {
  command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || skip "shasum/sha256sum required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  [[ -f "${REAL_RENDERER}" ]] || skip "renderer not found: ${REAL_RENDERER}"
  [[ -f "${TEMPLATE}" ]] || skip "config template not found: ${TEMPLATE}"

  SANDBOX="$(mktemp -d -t ga-doctor-launchd-bats.XXXXXX)"
  SANDBOX_HOME="${SANDBOX}/home"
  LA="${SANDBOX_HOME}/Library/LaunchAgents" # deployed-plist dir (= ${HOME}/Library/LaunchAgents)
  TARGET="${SANDBOX_HOME}/.claude"          # throwaway ~/.claude
  FAKE_CONFIG="${SANDBOX}/config.toml"
  FAKE_MANIFEST="${SANDBOX}/manifest.json"
  REF="${SANDBOX}/ref-render" # pre-rendered reference (the "current renderer output")
  mkdir -p -- "${LA}" "${TARGET}" "${REF}"

  # fake config: the exact render_config sed against the SANDBOX home, timezone pinned to
  # an explicit zone so atrium_resolve_timezone round-trips verbatim (host-independent).
  sed -e "s|\${HOME}|${SANDBOX_HOME}|g" \
    -e 's|^timezone = .*|timezone = "Asia/Seoul"|' \
    "${TEMPLATE}" >"${FAKE_CONFIG}"

  # minimal valid manifest so §4/§7 stay clean; the §8 generator is stubbed exit-0.
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${FAKE_MANIFEST}"
  GEN_STUB="${SANDBOX}/generate-manifest.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' >"${GEN_STUB}"
  chmod +x "${GEN_STUB}"

  # pre-render the reference plists with the SAME renderer + config + GA_SKIP_DEP_PROBE +
  # HOME doctor §11 uses internally, so a copied plist is byte-identical to doctor's re-render.
  GA_SKIP_DEP_PROBE=1 GA_CONFIG_TOML="${FAKE_CONFIG}" GA_PLIST_OUT="${REF}" \
    HOME="${SANDBOX_HOME}" bash "${REAL_RENDERER}" >/dev/null 2>&1 \
    || skip "reference render failed (renderer/plutil unavailable in this env)"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# Copy the reference plist for <job> into the deployed LaunchAgents dir (the loaded shape).
deploy_ref() {
  cp -f -- "${REF}/com.glass-atrium.$1.plist" "${LA}/com.glass-atrium.$1.plist"
}

# Deploy byte-identical references for all 8 jobs (the healthy loaded install).
deploy_all() {
  local job
  for job in "${JOBS[@]}"; do
    deploy_ref "${job}"
  done
}

# Run the REAL run_doctor against the sandbox in a fresh strict-mode subprocess.
run_doctor_sandbox() {
  run env HOME="${SANDBOX_HOME}" GA_TARGET_HOME="${TARGET}" \
    GA_CONFIG_TOML="${FAKE_CONFIG}" GA_MANIFEST="${FAKE_MANIFEST}" \
    GA_GENERATE_MANIFEST="${GEN_STUB}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$1"
      run_doctor
    ' _ "${GA}"
}

# === 1. matching deployed plists -> no drift (§11 ok) =========================

@test "matching deployed plists -> §11 reports match, no drift warn" {
  deploy_all

  run_doctor_sandbox

  [[ "${output}" == *"deployed launchd plist(s) match the current renderer output"* ]] || return 1
  [[ "${output}" != *"stale-deployed launchd plist drift"* ]] || return 1
}

# === 2. a diverging deployed plist -> drift warn fires (advisory, not FAIL) ====

@test "a deployed plist diverging from the rendered reference -> drift warn fires" {
  deploy_all
  # tamper ONE deployed plist so its content diverges from the current renderer output
  # (the stale-deploy shape: a renderer/PATH change that was never re-deployed).
  printf '<!-- stale -->\n' >>"${LA}/com.glass-atrium.autoagent-daemon.plist"

  run_doctor_sandbox

  [[ "${output}" == *"stale-deployed launchd plist drift: com.glass-atrium.autoagent-daemon"* ]] || return 1
  # advisory: the drift feeds the warn summary, never a hard FAIL banner.
  [[ "${output}" == *"stale-deployed launchd plist(s) — re-render + --load-launchd to redeploy"* ]] || return 1
  [[ "${output}" == *"launchd-drift warning(s)"* ]] || return 1
  [[ "${output}" != *"== doctor: FAIL =="* ]] || return 1
}

# === 3. no deployed com.glass-atrium plists -> clean skip =====================

@test "no deployed com.glass-atrium plists -> clean skip (not-yet-loaded install)" {
  # LaunchAgents dir is empty (nothing loaded) — §11 must skip cleanly, never a false warn.
  run_doctor_sandbox

  [[ "${output}" == *"no deployed com.glass-atrium launchd plists"* ]] || return 1
  [[ "${output}" != *"stale-deployed launchd plist drift"* ]] || return 1
}

# === 4. mktemp failure -> loud skip, renderer NEVER invoked ====================

# fail-before/pass-after: a failed mktemp leaves ld_tmp EMPTY. The renderer resolves an empty
# GA_PLIST_OUT via ${GA_PLIST_OUT:-<default>} to its PRODUCTION default (<GA root>/rendered/launchd),
# so the PRE-guard body would re-render into the LIVE rendered dir — breaking §11's temp-isolation
# contract (§11 must NEVER touch the real rendered dir). The guard skips the render when ld_tmp is
# empty/non-dir, emitting a LOUD skip instead. This case stubs mktemp to emit an empty string (exit 0,
# so strict mode does not abort the assignment) and asserts: (a) §11 emits the loud skip warn, and
# (b) the renderer is NEVER invoked — proven output-only by the ABSENCE of every render-verdict line
# (the ok "match" line, the drift line, and the "renderer anomaly" line launchd_deploy_drift "" emits),
# so the production rendered dir is never written. Pre-guard, the render runs -> the ok "match" line
# appears and the loud skip warn does not, failing (a)+(b).

# Run run_doctor with a stubbed mktemp on PATH (emits empty, exit 0) so §11's ld_tmp is empty.
# mktemp is used by run_doctor ONLY at §11, so stubbing it does not disturb any other section; the
# reference render in setup ran earlier with the real mktemp (before this stub is on PATH).
run_doctor_sandbox_mktemp_empty() {
  local stub_dir="${SANDBOX}/stub-bin"
  mkdir -p -- "${stub_dir}"
  printf '#!/usr/bin/env bash\nexit 0\n' >"${stub_dir}/mktemp" # emits empty stdout, exit 0
  chmod +x "${stub_dir}/mktemp"

  run env PATH="${stub_dir}:${PATH}" HOME="${SANDBOX_HOME}" GA_TARGET_HOME="${TARGET}" \
    GA_CONFIG_TOML="${FAKE_CONFIG}" GA_MANIFEST="${FAKE_MANIFEST}" \
    GA_GENERATE_MANIFEST="${GEN_STUB}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$1"
      run_doctor
    ' _ "${GA}"
}

@test "mktemp failure -> §11 loud skip, renderer never invoked (production dir untouched)" {
  deploy_all # deployed_count > 0 so §11 reaches the mktemp branch (not the empty-install skip)

  run_doctor_sandbox_mktemp_empty

  # (a) loud skip warn fired (never a silent swallow / false OK)
  [[ "${output}" == *"temp render dir unavailable (mktemp failed)"* ]] || return 1
  # (b) renderer NEVER invoked -> none of the render-verdict lines appear (had the render run into the
  #     production default, one of these would). This is the "production rendered dir never written" proof.
  [[ "${output}" != *"match the current renderer output"* ]] || return 1
  [[ "${output}" != *"stale-deployed launchd plist"* ]] || return 1
  [[ "${output}" != *"renderer anomaly"* ]] || return 1
}
