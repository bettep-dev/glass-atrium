#!/usr/bin/env bats
# run-step-fail-return.bats — force-quit-class removal + hash -r keg-inject hardening.
#
# Force-quit-class guard: build_monitor was only ONE instance of a class defect — run_step invokes each
# step as a SAME-SHELL brace group `{ "$@"; }` under `set +e` (glass-atrium run_step), so an
# in-step `exit`/`die` on ANY step terminates the WHOLE TUI process (masked force-quit, no FAIL
# panel; cleanup() restores the terminal). The user's FIRST force-quit may be step-8-origin
# (setup_database → oss-db-setup.sh npm-ci failure), not step-12. AUDIT VERDICT: the engine-level
# subshell mechanism is REJECTED — cleanup() reads parent-shell globals mutated inside step fns
# (GATE_LOG set inside bootstrap_health_gate/STEP#13; RENDER_TMP inside render_config/wire_hooks),
# a subshell would lose those (glass-atrium:273-278 documents exactly this). So the FALLBACK is
# used: routine-failure exit/die → mode-aware exit_step/die_step, gated by GA_TUI_STEP (set by
# run_step only across the "$@" call) — TUI RETURNS (FAIL panel), CLI EXITS (named-code contract).
#
# The regression guard is the SAME-SCOPE SENTINEL (a `( fn )` subshell would isolate the exit and
# false-green): the driver calls the REAL converted step fn via the REAL run_step at TOP LEVEL of a
# child process and asserts a `REACHED_AFTER` marker AFTER the call — ABSENT pre-fix (bare exit
# killed the process), PRESENT post-fix (exit_step returned → run_step's rc → control continues).
#
# hash -r keg hardening (SECONDARY): `hash -r` after the node@24 keg PATH inject (freshly-brewed npm resolves
# in-process) + a guide-only Xcode CLT presence hint before the npm build. Static-scan (plan-
# sanctioned — a behavioral `hash -r` proof is impractical machine-safe).
#
# Machine-safe: GA_ROOT overridden to a mktemp sandbox; psql/curl/node PATH-stubbed; oss-db-setup.sh
# stubbed. NO real npm/brew/psql/node/DB, no machine state. Mirrors test/monitor-build-selfheal.bats
# (launcher-as-library source pattern) + test/deps-preflight-exec-harness.sh (TTY=/dev/null drive).
#
# Run via: bats test/run-step-fail-return.bats
# Requires: bats (brew install bats-core), bash 3.2+

# SC2154: BATS_TEST_DIRNAME injected by bats. SC2016: static-scan assertions single-quote
# `${BOOTSTRAP_EXIT_*}`/`${GA_TUI_STEP}` deliberately — they match LITERAL source text, never
# expand. SC2312: masking a command's exit inside a `[[ ]]` assertion is intentional (the string
# value is the assertion).
# shellcheck disable=SC2154,SC2016,SC2312
bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
TUI="${GA}/glass-atrium"
CORE="${GA}/lib/ga-core.sh"
DB="${GA}/lib/ga-db.sh"
ENVLIB="${GA}/lib/ga-env.sh"

setup() {
  [[ -f "${TUI}" ]] || skip "glass-atrium launcher not found: ${TUI}"
  [[ -f "${CORE}" && -f "${DB}" && -f "${ENVLIB}" ]] || skip "lib sources not found"
  SANDBOX="$(mktemp -d -t ga-fqclass-bats.XXXXXX)"
  SANDBOX_ROOT="${SANDBOX}/ga-root"
  STUB_BIN="${SANDBOX}/bin"
  DB_DRIVER="${SANDBOX}/db-driver.sh"
  GATE_DRIVER="${SANDBOX}/gate-driver.sh"
  mkdir -p "${SANDBOX_ROOT}/monitor/scripts" "${STUB_BIN}"

  # psql stub: the setup_database db-exists probe prints NOTHING (DB absent) so control falls
  # through to run_db_setup; exit 0 so `|| true` is a no-op. NEVER touches a real cluster.
  cat >"${STUB_BIN}/psql" <<'PSQL'
#!/usr/bin/env bash
exit 0
PSQL
  # oss-db-setup.sh stub: exit code driven by OSS_DB_EXIT (6 = prisma-failure default; 0 = success
  # control). run_db_setup runs `(cd monitor && bash oss-db-setup.sh)` — NO real DB/npm.
  cat >"${SANDBOX_ROOT}/monitor/scripts/oss-db-setup.sh" <<'OSS'
#!/usr/bin/env bash
exit "${OSS_DB_EXIT:-6}"
OSS
  # curl stub: always non-zero → the gate's stale-listener precondition (line ~230) passes and the
  # poll never sees a 200. node stub: exits immediately → the gate's early-liveness probe (kill -0
  # after sleep 1) fails → the FATAL "monitor exited immediately" exit path (converted site 250).
  cat >"${STUB_BIN}/curl" <<'CURL'
#!/usr/bin/env bash
exit 1
CURL
  cat >"${STUB_BIN}/node" <<'NODE'
#!/usr/bin/env bash
exit 1
NODE
  chmod +x "${STUB_BIN}/psql" "${STUB_BIN}/curl" "${STUB_BIN}/node" \
    "${SANDBOX_ROOT}/monitor/scripts/oss-db-setup.sh"

  # DB driver: source the REAL launcher as a library (GA_ROOT pinned to the sandbox via
  # ga_init_env BEFORE the launcher's no-op re-init), then drive the REAL setup_database through the
  # REAL run_step at TOP LEVEL. A pre-fix in-step `exit` kills THIS process before REACHED_AFTER.
  cat >"${DB_DRIVER}" <<'DRV'
#!/usr/bin/env bash
# shellcheck source=/dev/null disable=SC1091
source "${GA_REAL}/lib/ga-core.sh"
ga_init_env "${GA_SANDBOX_ROOT}"
source "${GA_REAL}/glass-atrium" >/dev/null 2>&1
set +e
trap - ERR EXIT INT TERM
TTY="/dev/null"                                  # run_step scroll rows do `>"${TTY}"`; /dev/null sinks them
rc=0
run_step "Database bootstrap" setup_database || rc=$?
set +e                                           # run_step re-arms set -e at its tail; disarm so REACHED prints
printf 'REACHED_AFTER rc=%s\n' "${rc}"
exit 0
DRV
  # Gate driver: drive the REAL bootstrap_health_gate (STEP #13) through the REAL run_step.
  cat >"${GATE_DRIVER}" <<'DRV'
#!/usr/bin/env bash
# shellcheck source=/dev/null disable=SC1091
source "${GA_REAL}/lib/ga-core.sh"
ga_init_env "${GA_SANDBOX_ROOT}"
source "${GA_REAL}/glass-atrium" >/dev/null 2>&1
set +e
trap - ERR EXIT INT TERM
TTY="/dev/null"
rc=0
run_step "Monitor health gate" bootstrap_health_gate || rc=$?
set +e
printf 'REACHED_AFTER rc=%s\n' "${rc}"
exit 0
DRV
  chmod +x "${DB_DRIVER}" "${GATE_DRIVER}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# GA_LIB_DIR points ga_init_env's lib source at the real repo (the sandbox root has none).
drive_db() {
  run env \
    GA_REAL="${GA}" \
    GA_SANDBOX_ROOT="${SANDBOX_ROOT}" \
    GA_LIB_DIR="${GA}/scripts/lib" \
    GA_DB_NAME="ga_fqclass_throwaway" \
    OSS_DB_EXIT="${1:-6}" \
    PATH="${STUB_BIN}:${PATH}" \
    bash "${DB_DRIVER}"
}

drive_gate() {
  run env \
    GA_REAL="${GA}" \
    GA_SANDBOX_ROOT="${SANDBOX_ROOT}" \
    GA_LIB_DIR="${GA}/scripts/lib" \
    ATRIUM_MONITOR_PORT="16145" \
    PATH="${STUB_BIN}:${PATH}" \
    bash "${GATE_DRIVER}"
}

# NB: bats fails a test only on its LAST command's status — intermediate `[[ ]]` failures do NOT
# abort. Every multi-condition assertion below is a short-circuiting `&&` chain so ANY unmet
# condition propagates to the final status.

# === Force-quit-guard behavioral — step-8 (setup_database → run_db_setup) same-scope sentinel ===========

@test "force-quit-guard: a step-8 (setup_database) routine failure RETURNS a FAIL rc — TUI process survives" {
  # oss-db-setup.sh exits 6 (prisma-failure). Pre-fix run_db_setup `exit 6` inside run_step's
  # same-shell brace group kills the driver before REACHED_AFTER. Post-fix exit_step returns 6.
  drive_db 6
  [[ "${status}" -eq 0 ]] \
    && [[ "${output}" == *"REACHED_AFTER rc=6"* ]]
}

@test "force-quit-guard: a step-8 SUCCESS still returns 0 (mechanism does not break the happy path)" {
  drive_db 0
  [[ "${status}" -eq 0 ]] \
    && [[ "${output}" == *"REACHED_AFTER rc=0"* ]]
}

# === Force-quit-guard behavioral — step-13 (bootstrap_health_gate) same-scope sentinel ==================

@test "force-quit-guard: a step-13 (health gate) routine failure RETURNS BOOTSTRAP_EXIT_HEALTH — process survives" {
  # node exits immediately → the gate's early-liveness probe fails → the converted exit-21 path.
  # Pre-fix `exit 21` kills the driver before REACHED_AFTER; post-fix exit_step returns 21.
  drive_gate
  [[ "${status}" -eq 0 ]] \
    && [[ "${output}" == *"REACHED_AFTER rc=21"* ]]
}

# === static — the mode-aware exit helpers + run_step's GA_TUI_STEP contract ================

@test "force-quit-guard(static): exit_step + die_step gate on GA_TUI_STEP and keep the CLI exit branch" {
  local es ds
  es="$(awk '/^exit_step\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${ENVLIB}")"
  ds="$(awk '/^die_step\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${ENVLIB}")"
  [[ -n "${es}" ]] \
    && [[ "${es}" == *'GA_TUI_STEP'* ]] \
    && [[ "${es}" == *'return 1'* ]] \
    && [[ "${es}" == *'exit '* ]] \
    && [[ -n "${ds}" ]] \
    && [[ "${ds}" == *'GA_TUI_STEP'* ]] \
    && [[ "${ds}" == *'FATAL'* ]] \
    && [[ "${ds}" == *'exit '* ]]
}

@test "force-quit-guard(static): run_step sets GA_TUI_STEP across the step invocation" {
  local body
  body="$(awk '/^run_step\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${TUI}" "${GA}"/lib/ga-tui-*.sh)"
  [[ "${body}" == *'GA_TUI_STEP=1'* ]] \
    && [[ "${body}" == *'GA_TUI_STEP=""'* ]]
}

@test "force-quit-guard(static): converted ga-db.sh routine-failure sites use exit_step/die_step + return" {
  local setup rundb recreate gate
  setup="$(awk '/^setup_database\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${DB}")"
  rundb="$(awk '/^run_db_setup\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${DB}")"
  recreate="$(awk '/^recreate_db_gate\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${DB}")"
  gate="$(awk '/^bootstrap_health_gate\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${DB}")"
  # setup_database: the psql-absent die became die_step + return
  [[ "${setup}" == *'die_step'* ]] \
    && [[ "${setup}" == *'return'* ]] \
    && [[ "${setup}" != *$'\n''  die '* ]] \
    && [[ "${rundb}" == *'exit_step "${db_rc}" || return "${db_rc}"'* ]] \
    && [[ "${recreate}" == *'exit_step "${db_rc}" || return "${db_rc}"'* ]] \
    && [[ "${gate}" == *'exit_step "${BOOTSTRAP_EXIT_HEALTH}" || return "${BOOTSTRAP_EXIT_HEALTH}"'* ]]
}

@test "force-quit-guard(static): the health gate no longer bare-exits BOOTSTRAP_EXIT_HEALTH (all 4 converted)" {
  local gate
  gate="$(awk '/^bootstrap_health_gate\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${DB}")"
  # no orphan `exit "${BOOTSTRAP_EXIT_HEALTH}"` remains (only exit_step wraps it)
  [[ "$(grep -c 'exit "${BOOTSTRAP_EXIT_HEALTH}"' <<<"${gate}")" -eq 0 ]] \
    && [[ "$(grep -c 'exit_step "${BOOTSTRAP_EXIT_HEALTH}"' <<<"${gate}")" -eq 4 ]]
}

@test "force-quit-guard(static): run_doctor_preflight (TUI-only) returns instead of bare die" {
  local body
  body="$(awk '/^run_doctor_preflight\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${TUI}" "${GA}"/lib/ga-tui-*.sh)"
  [[ "${body}" == *'return'* ]] \
    && [[ "${body}" != *$'|| die '* ]]
}

# === CLI-safety static-scan — the passthrough exit contract is unchanged ===================

@test "CLI-safety: ga-core.sh run_bootstrap phase-2 still bare-exits BOOTSTRAP_EXIT_BUILD (build-return guard)" {
  local body
  body="$(awk '/^run_bootstrap\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${CORE}")"
  [[ "${body}" == *'exit "${BOOTSTRAP_EXIT_BUILD}"'* ]]
}

@test "CLI-safety: run_install still calls setup_database directly (CLI exit via exit_step CLI branch)" {
  local body
  body="$(awk '/^run_install\(\) \{/{f=1} f{print} f&&/^}/{exit}' "${CORE}")"
  # the CLI reaches the shared fn directly (GA_TUI_STEP unset → exit_step exits, named-code contract)
  [[ "${body}" == *'setup_database'* ]]
}

# === hash -r static-scan — hash -r after node@24 keg inject + guide-only CLT check ===============

@test "hash-r(static): hash -r follows every preflight_keg_path_inject node@24 (both render paths)" {
  # exactly the two keg-inject node@24 sites (scroll + boxed) each get a following `hash -r`.
  [[ "$(grep -c 'preflight_keg_path_inject node@24' "${TUI}")" -eq 2 ]] \
    && [[ "$(grep -cE '^[[:space:]]*hash -r' "${TUI}")" -ge 2 ]]
}

@test "hash-r(static): the guide-only Xcode CLT gate is invoked before the build path (pre-existing coverage)" {
  # The hash -r round's "CLT check before npm" is ALREADY satisfied by preflight_guide_xcode_clt (install-order
  # step 1, invoked in BOTH the scroll + boxed preflight paths) — NO duplicate added (minimalism).
  # Assert it is CALLED (not merely defined) in both render paths and references the CLT install
  # command (guide-only, no silent failure). Regression guard if a reorder drops the gate.
  [[ "$(grep -c 'if ! preflight_guide_xcode_clt' "${TUI}")" -ge 1 ]] \
    && grep -q 'preflight_bracket preflight_guide_xcode_clt' "${TUI}" \
    && grep -q 'ga_detect_xcode_clt' "${TUI}" \
    && grep -q 'xcode-select --install' "${TUI}"
}
