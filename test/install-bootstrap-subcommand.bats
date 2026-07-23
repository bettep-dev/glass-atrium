#!/usr/bin/env bats
# glass-atrium `bootstrap` one-stop path — unit coverage for the engine's
# run_bootstrap that no other suite exercised as-a-unit (bootstrap unit-coverage audit gap):
#   * dry-run: run_bootstrap with DRY_RUN=true short-circuits before build/health.
#   * exit 20 (BOOTSTRAP_EXIT_BUILD): `npm run build` failure is a loud-fail.
#   * exit 21 (BOOTSTRAP_EXIT_HEALTH): no /api/health 200 in the window.
#   * health-gate PASS: build ok + /api/health 200 → rc 0 + the [3/3] PASS log.
#   * env-port fallback: bootstrap_health_gate reads ATRIUM_MONITOR_PORT from
#     monitor/.env, else defaults to 16145 — the curl target proves which port.
#
# Hermetic strategy (mirrors scripts/test/daemon-bootstrap-supervise.bats): copy
# lib/ga-core.sh into a sandbox GA_ROOT (resolving the sandbox monitor/.env),
# SOURCE the engine directly with strict mode + ERR trap, ga_init_env it, and
# override run_install with a no-op so the bootstrap logic is isolated from the
# full install path; PATH-prepend stub npm/node/curl whose behavior is selected
# per test via marker env vars. No live host service, no DB, no launchctl — bats
# CI-job hermetic contract.
#
# Run via: bats test/install-bootstrap-subcommand.bats
# Requires: bats >= 1.5.0, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_LIB="${GA}/lib/ga-core.sh"

# The engine lib tree (ga-core.sh + its 7 domain siblings + the whole scripts/lib) is READ-ONLY
# across every test — the tests only SOURCE it — so build it ONCE here. Per-test setup() symlinks
# it into a fresh sandbox GA_ROOT; each test still writes its OWN monitor/.env (config-port
# isolation the env-port tests depend on is preserved). BATS_FILE_TMPDIR is auto-reaped by bats.
setup_file() {
  [[ -f "${REAL_LIB}" ]] || return 0
  ENGINE_SRC="${BATS_FILE_TMPDIR}/engine"
  export ENGINE_SRC
  mkdir -p "${ENGINE_SRC}/lib" "${ENGINE_SRC}/scripts/lib"
  # ga-core.sh is a THIN LOADER that sources its 7 domain siblings; copy them alongside so a
  # sandbox source resolves the full engine (absent -> loud-fail).
  cp "${REAL_LIB}" \
    "${GA}/lib/ga-env.sh" \
    "${GA}/lib/ga-symlink.sh" \
    "${GA}/lib/ga-config-hooks.sh" \
    "${GA}/lib/ga-launchd.sh" \
    "${GA}/lib/ga-db.sh" \
    "${GA}/lib/ga-daemons.sh" \
    "${GA}/lib/ga-doctor.sh" \
    "${ENGINE_SRC}/lib/"
  # ga_init_env HARD-requires several scripts/lib libs under <GA_ROOT>/scripts/lib and die()s when
  # any is absent (the E5 update-system set PLUS fakechat-cleanup.sh). Copy the WHOLE scripts/lib
  # dir so the next mandatory-lib addition cannot re-break this (the class already recurred:
  # update-pause-flag, then fakechat-cleanup). init sources only the named libs, so the extras sit
  # unread — a SOURCE-time dependency of init, not of run_bootstrap.
  cp "${GA}/scripts/lib/"*.sh "${ENGINE_SRC}/scripts/lib/"
}

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "lib/ga-core.sh not found: ${REAL_LIB}"
  SANDBOX="$(mktemp -d -t install-bootstrap-bats.XXXXXX)"
  GA_SBX="${SANDBOX}/glass-atrium"
  STUB_BIN="${SANDBOX}/bin"
  # curl writes the URL it was asked to fetch here so a test can assert the port.
  CURL_URL_LOG="${SANDBOX}/curl-url.log"
  mkdir -p "${GA_SBX}/monitor" "${GA_SBX}/scripts" "${STUB_BIN}"
  # symlink the read-only engine tree built once in setup_file (source-only). monitor/.env stays a
  # real per-test dir so each test's config port is isolated; rm -rf of the sandbox drops the
  # symlink entries only, never the shared engine tree they point at.
  ln -s "${ENGINE_SRC}/lib" "${GA_SBX}/lib"
  ln -s "${ENGINE_SRC}/scripts/lib" "${GA_SBX}/scripts/lib"
  install_stubs
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# --- PATH stubs (behavior keyed on marker env vars, exported into the run) -----
# npm    : `npm run build` succeeds unless STUB_NPM_BUILD_FAIL=1.
# node   : the monitor server stand-in — sleeps so the gate's kill/wait path is
#          exercised against a real child PID (never actually serves HTTP).
# curl   : logs the requested URL, then returns the health response keyed on
#          STUB_HEALTH (200|fail). 200 → a db:open BODY + the 200 code (the db-field gate
#          needs the body, not just the status); fail → 000.
# sleep  : the FIRST call (the gate's early-liveness `sleep 1` probe) does a tiny
#          REAL settle so the just-backgrounded stub node is scheduled to write its
#          up-marker before polling starts; EVERY subsequent call (the poll loop)
#          is a true instant no-op, so the health-fail window never stalls the suite
#          on the readonly 30s production constant (left untouched).
install_stubs() {
  cat >"${STUB_BIN}/npm" <<'NPM'
#!/usr/bin/env bash
if [[ "$1" == "run" && "$2" == "build" ]]; then
  [[ "${STUB_NPM_BUILD_FAIL:-0}" == "1" ]] && { echo "stub npm: build FAILED" >&2; exit 1; }
  echo "stub npm: build ok"
  exit 0
fi
exit 0
NPM
  cat >"${STUB_BIN}/node" <<NODE
#!/usr/bin/env bash
# stand-in monitor server: mark itself "up" (so the post-spawn curl probe and the
# lsof listener check see a started server) and stay alive so the gate has a live
# PID to kill/wait. The marker carries this stub's own PID for the lsof stub.
#
# exec the ABSOLUTE /bin/sleep, NOT bare 'sleep': STUB_BIN is PATH-prepended and
# installs a no-op 'sleep' stub (exit 0) for the gate's instant poll loop. A bare
# 'exec sleep 30' would resolve to that no-op stub, so this stub monitor would die
# instantly and the gate's early-liveness probe (kill -0 after sleep 1) would see
# a dead PID and exit 21 before ever polling /api/health. /bin/sleep bypasses the
# PATH shadow so the stub monitor genuinely stays alive past the 1s liveness probe.
printf '%s\n' "\$\$" >"${SANDBOX}/monitor-up.marker"
exec /bin/sleep 30
NODE
  cat >"${STUB_BIN}/curl" <<CURL
#!/usr/bin/env bash
# log the last argument (the URL) so a test can assert the resolved port. Honour
# --fail (non-2xx → non-zero, real curl semantics): the pre-spawn precondition
# probe runs BEFORE the monitor marker exists, so it must see a connection failure
# (no stale listener); the post-spawn poll returns the STUB_HEALTH-keyed code.
fail_mode=0
for a in "\$@"; do url="\$a"; [[ "\$a" == "--fail" ]] && fail_mode=1; done
printf '%s\n' "\${url}" >>"${CURL_URL_LOG}"
if [[ ! -f "${SANDBOX}/monitor-up.marker" ]]; then
  # nothing listening yet (pre-spawn probe) — connection refused.
  [[ "\${fail_mode}" == "1" ]] && exit 7
  printf '000'; exit 0
fi
if [[ "\${STUB_HEALTH:-fail}" == "200" ]]; then
  # healthy monitor: emit the /api/health BODY (db:open) THEN the http_code on its own
  # trailing line, matching the gate's -w '\n%{http_code}' parse (body = all-but-last line).
  # A bare '200' (no db:open body) now FAILS the db-field gate (lib/ga-core.sh STEP 5 db-open),
  # so the healthy-path stub must report a db-open monitor to reach the PASS branch.
  printf '{"db":"open"}\n200'; exit 0
fi
[[ "\${fail_mode}" == "1" ]] && exit 22
printf '000'; exit 0
CURL
  cat >"${STUB_BIN}/lsof" <<LSOF
#!/usr/bin/env bash
# stand-in for 'lsof -ti tcp:<port>': report the started monitor stub's PID (from
# the marker) as the listener so the gate's listener-binding assertion passes only
# when the monitor actually came up.
[[ -f "${SANDBOX}/monitor-up.marker" ]] && cat "${SANDBOX}/monitor-up.marker"
exit 0
LSOF
  cat >"${STUB_BIN}/sleep" <<SLEEP
#!/usr/bin/env bash
# Mostly-no-op sleep with ONE real settle. The gate backgrounds the stub node
# (which writes its up-marker asynchronously) then does its early-liveness probe
# (sleep 1; kill -0). With a pure no-op sleep that probe returns instantly, often
# BEFORE the async node stub has been scheduled to write the marker, so the poll
# loop (also no-op-slept) can lap the marker write and never observe the 200 →
# a flaky health-gate failure on the otherwise-healthy STUB_HEALTH=200 path.
# Fix: the FIRST sleep call — the gate's single early-liveness $(sleep 1) — does a
# 0.1s REAL settle (via the absolute /bin/sleep, bypassing this PATH stub) so the
# marker has reliably landed before polling begins. EVERY later call (the 30-iter
# poll loop) is a true instant no-op, so a health-fail window still completes fast
# and never stalls the suite. The production 30s window constant is untouched.
if [[ ! -f "${SANDBOX}/sleep-first-call.seen" ]]; then
  : >"${SANDBOX}/sleep-first-call.seen"
  exec /bin/sleep 0.1
fi
exit 0
SLEEP
  chmod +x "${STUB_BIN}/npm" "${STUB_BIN}/node" "${STUB_BIN}/curl" "${STUB_BIN}/sleep" "${STUB_BIN}/lsof"
}

# Source the sandbox engine under entry-point conditions (strict mode + ERR trap,
# which ga-core.sh deliberately leaves to its callers), neutralize the heavy
# install path, and call the bootstrap function. Runs inside `bats run` so the
# subshell exit code is captured; set -e + the ERR trap make a named-exit-code
# path exit the subshell with that code. STUB_BIN is prepended so the stubs win.
source_and_call() {
  local fn="$1"
  run env PATH="${STUB_BIN}:${PATH}" \
    STUB_NPM_BUILD_FAIL="${STUB_NPM_BUILD_FAIL:-0}" \
    STUB_HEALTH="${STUB_HEALTH:-fail}" \
    bash -c "
      set -Eeuo pipefail
      IFS=\$'\n\t'
      trap 'echo \"ERROR: line \${LINENO}: \${BASH_COMMAND}\" >&2' ERR
      source '${GA_SBX}/lib/ga-core.sh'
      ga_init_env '${GA_SBX}'
      run_install() { log 'stub run_install: no-op (install path covered by oss-e2e-bootstrap.sh)'; }
      ${fn}
    "
}

# === dry-run short-circuit ===================================================
@test "run_bootstrap with DRY_RUN=true short-circuits before build/health" {
  # dry-run returns before build/health, so no DB/monitor is needed. This proves
  # run_bootstrap's DRY_RUN branch skips the monitor build + health gate.
  run env PATH="${STUB_BIN}:${PATH}" bash -c "
    set -Eeuo pipefail
    IFS=\$'\n\t'
    trap 'echo \"ERROR: line \${LINENO}: \${BASH_COMMAND}\" >&2' ERR
    source '${GA_SBX}/lib/ga-core.sh'
    ga_init_env '${GA_SBX}'
    run_install() { log 'stub run_install: no-op'; }
    DRY_RUN=true
    run_bootstrap
  "
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"bootstrap [1/3]"* ]]
  [[ "${output}" == *"dry-run — skipping monitor build + health gate"* ]]
}

# === exit 20 — build failure =================================================
@test "monitor build failure exits 20 (BOOTSTRAP_EXIT_BUILD)" {
  printf 'ATRIUM_MONITOR_PORT=17842\n' >"${GA_SBX}/monitor/.env"
  STUB_NPM_BUILD_FAIL=1 STUB_HEALTH=200 source_and_call run_bootstrap
  [[ "${status}" -eq 20 ]]
  [[ "${output}" == *"monitor build failed"* ]]
}

# === exit 21 — health-gate failure ===========================================
@test "health gate failure (no 200 in window) exits 21 (BOOTSTRAP_EXIT_HEALTH)" {
  printf 'ATRIUM_MONITOR_PORT=17842\n' >"${GA_SBX}/monitor/.env"
  # the stub sleep is instant, so the full-window poll loop completes fast — the
  # production 30s window constant is never reassigned (it is readonly).
  STUB_HEALTH=fail source_and_call run_bootstrap
  [[ "${status}" -eq 21 ]]
  [[ "${output}" == *"health gate FAILED"* ]]
}

# === health PASS — rc 0 + [3/3] PASS log =====================================
@test "build ok + health 200 → rc 0 and the [3/3] health-gate PASS log" {
  printf 'ATRIUM_MONITOR_PORT=17842\n' >"${GA_SBX}/monitor/.env"
  STUB_HEALTH=200 source_and_call run_bootstrap
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"monitor health gate PASS"* ]]
  [[ "${output}" == *"bootstrap COMPLETE"* ]]
}

# === env-port read — config-driven port reaches the curl target ==============
@test "bootstrap_health_gate reads ATRIUM_MONITOR_PORT from monitor/.env" {
  printf 'ATRIUM_MONITOR_PORT=18888\n' >"${GA_SBX}/monitor/.env"
  STUB_HEALTH=200 source_and_call bootstrap_health_gate
  [[ "${status}" -eq 0 ]]
  # the stubbed curl logged the URL it was handed — assert the .env port, not the 16145 default.
  grep -q 'http://127.0.0.1:18888/api/health' "${CURL_URL_LOG}"
  run ! grep -q '127.0.0.1:16145' "${CURL_URL_LOG}"
}

# === env-port fallback — absent .env defaults to 16145 ======================
@test "bootstrap_health_gate falls back to port 16145 when monitor/.env is absent" {
  # no monitor/.env written → the gate keeps its default port. STUB_HEALTH=fail
  # exits 21 after the (instant-sleep) poll loop, having probed the default port.
  STUB_HEALTH=fail source_and_call bootstrap_health_gate
  [[ "${status}" -eq 21 ]]
  grep -q 'http://127.0.0.1:16145/api/health' "${CURL_URL_LOG}"
}

# === install.sh one-line bootstrap fetch path (T6 pre-bundle de-dependency) ==
# install.sh must fetch WITHOUT gh via unauthenticated curl against the fixed
# release-asset URL forms, MANIFEST-FIRST (latest-form manifest → parse .version
# → tag-form releases/download/v<version>/<bundle>), and must run end-to-end on
# a STOCK Mac (no gh, no jq — runnable-python3 manifest parse, incl. the spine's
# per-file hash lookups). Driven with a PATH-STUB curl (NOT the
# GA_INSTALL_SRC_* local-bundle seam — that seam covers install-tree acceptance
# only; fetch coverage must exercise the URL builder). The stub serves a REAL
# hash-true fixture bundle so download → verify → install completes genuinely.
# These tests build their own FETCH_BIN/TOOLBIN and ignore the engine stubs above.

INSTALL_SH="${GA}/install.sh"

# install.sh is a REPO-ONLY bootstrap (deliberately not a manifest bundle member), so a
# consumer install has no T6 target — skip there; PER-TEST (not setup-wide) because the
# ga-core/bootstrap engine tests above guard on the BUNDLED lib and must keep running.
t6_require_install_sh() {
  [[ -f "${INSTALL_SH}" ]] || skip "install.sh absent (consumer install — repo-only bootstrap)"
}

# Build a hash-true release fixture: mini install tree (launcher + the real
# apply-spine.sh, which install.sh sources from the extracted bundle), its
# manifest {version, files, hashes} (plain heredoc — no jq needed), and the
# tar.gz bundle. Exports FIXTURE_MANIFEST / FIXTURE_BUNDLE.
t6_build_release_fixture() {
  local version="$1" fix="${SANDBOX}/fixture" tree h_launcher h_spine
  tree="${fix}/tree"
  mkdir -p "${tree}/scripts/lib"
  printf '#!/usr/bin/env bash\necho fixture-launcher\n' >"${tree}/glass-atrium"
  chmod +x "${tree}/glass-atrium"
  cp "${GA}/scripts/lib/apply-spine.sh" "${tree}/scripts/lib/apply-spine.sh"
  h_launcher="$(shasum -a 256 "${tree}/glass-atrium" | awk '{print $1}')"
  h_spine="$(shasum -a 256 "${tree}/scripts/lib/apply-spine.sh" | awk '{print $1}')"
  cat >"${fix}/manifest.json" <<MANIFEST
{"version":"${version}",
 "files":["glass-atrium","scripts/lib/apply-spine.sh"],
 "hashes":{"glass-atrium":"${h_launcher}","scripts/lib/apply-spine.sh":"${h_spine}"}}
MANIFEST
  tar -czf "${fix}/bundle.tar.gz" -C "${tree}" glass-atrium scripts
  export FIXTURE_MANIFEST="${fix}/manifest.json" FIXTURE_BUNDLE="${fix}/bundle.tar.gz"
}

# PATH-stub curl: record argv + URL, then serve the fixture asset at the -o path.
# FETCH_FAIL_MANIFEST/FETCH_FAIL_BUNDLE → curl's HTTP-error rc 22 (the -f contract).
# FETCH_BIN also fronts a Darwin uname stub: the live-PATH runs (tag-pin / HTTP-fail /
# tamper) exercise the macOS-only install contract, and the real uname would exit-10
# the preflight on Linux CI before the fetch stage under test.
t6_build_fetch_stub() {
  FETCH_BIN="${SANDBOX}/fetch-bin"
  FETCH_URL_LOG="${SANDBOX}/fetch-url.log"
  FETCH_ARGV_LOG="${SANDBOX}/fetch-argv.log"
  export FETCH_URL_LOG FETCH_ARGV_LOG
  mkdir -p "${FETCH_BIN}"
  cat >"${FETCH_BIN}/uname" <<'SH'
#!/bin/bash
printf '%s\n' "Darwin"
SH
  chmod +x "${FETCH_BIN}/uname"
  cat >"${FETCH_BIN}/curl" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
out="" url="" prev=""
for tok in "$@"; do
  [[ "${prev}" == "-o" ]] && out="${tok}"
  prev="${tok}"
  url="${tok}"
done
printf '%s\n' "$*" >>"${FETCH_ARGV_LOG}"
printf '%s\n' "${url}" >>"${FETCH_URL_LOG}"
case "${url}" in
  */manifest.json)
    [[ -n "${FETCH_FAIL_MANIFEST:-}" ]] && exit 22
    cp "${FIXTURE_MANIFEST}" "${out}"
    ;;
  *.tar.gz)
    [[ -n "${FETCH_FAIL_BUNDLE:-}" ]] && exit 22
    cp "${FIXTURE_BUNDLE}" "${out}"
    ;;
  *) exit 9 ;;
esac
STUB
  chmod +x "${FETCH_BIN}/curl"
}

# Allowlisted TOOLBIN (the ONLY PATH entry for the stock-Mac run): the stub curl
# + real stock tools, with jq and gh deliberately never linked. The python3
# symlink resolves off /usr/bin, so the probe's Apple-shim CLT gate stays out of
# the way (brew-like path) and the REAL python3 backs the manifest parse.
# `uname` is a Darwin STUB, never a symlink: the run exercises the macOS-only
# install contract, and the real uname would exit-10 the preflight on Linux CI.
# `gzip` is on the list for GNU tar: bsdtar (macOS) decompresses -z in-process
# via libarchive, but GNU tar (Linux CI) forks an external gzip resolved via
# PATH — without it the hermetic `tar -xzf` extract dies (exit 17). Stock macOS
# ships gzip, so linking it keeps the stock-Mac model faithful on both hosts.
t6_build_stock_toolbin() {
  TOOLBIN="${SANDBOX}/stock-bin"
  mkdir -p "${TOOLBIN}"
  local t src
  # bash is on the list for the stub curl's own #!/usr/bin/env bash shebang.
  for t in bash tar gzip shasum python3 mktemp mkdir dirname ls cat cp rm mv; do
    src="$(command -v "${t}")" || return 1
    ln -s "${src}" "${TOOLBIN}/${t}"
  done
  cat >"${TOOLBIN}/uname" <<'SH'
#!/bin/bash
printf '%s\n' "Darwin"
SH
  chmod +x "${TOOLBIN}/uname"
  ln -s "${FETCH_BIN}/curl" "${TOOLBIN}/curl"
}

@test "install.sh fetch: STOCK-Mac end-to-end — no gh, no jq → preflight passes, download verifies, install lands" {
  t6_require_install_sh
  t6_build_release_fixture 1.0.9
  t6_build_fetch_stub
  t6_build_stock_toolbin || return 1
  run env -i PATH="${TOOLBIN}" HOME="${SANDBOX}" TMPDIR="${SANDBOX}" \
    FIXTURE_MANIFEST="${FIXTURE_MANIFEST}" FIXTURE_BUNDLE="${FIXTURE_BUNDLE}" \
    FETCH_URL_LOG="${FETCH_URL_LOG}" FETCH_ARGV_LOG="${FETCH_ARGV_LOG}" \
    GA_DIR="${SANDBOX}/ga-install" GA_RELEASE_REPO="owner/repo" GA_NO_RUN=1 \
    /bin/bash "${INSTALL_SH}"
  [[ "${status}" -eq 0 ]] || return 1
  # verified install landed: launcher executable + persisted install manifest.
  [[ -x "${SANDBOX}/ga-install/glass-atrium" ]] || return 1
  [[ -f "${SANDBOX}/ga-install/manifest.json" ]] || return 1
  [[ -f "${SANDBOX}/ga-install/scripts/lib/apply-spine.sh" ]] || return 1
}

@test "install.sh fetch: latest-form manifest URL then v<version> tag-form bundle URL (manifest-first)" {
  t6_require_install_sh
  t6_build_release_fixture 1.0.9
  t6_build_fetch_stub
  t6_build_stock_toolbin || return 1
  run env -i PATH="${TOOLBIN}" HOME="${SANDBOX}" TMPDIR="${SANDBOX}" \
    FIXTURE_MANIFEST="${FIXTURE_MANIFEST}" FIXTURE_BUNDLE="${FIXTURE_BUNDLE}" \
    FETCH_URL_LOG="${FETCH_URL_LOG}" FETCH_ARGV_LOG="${FETCH_ARGV_LOG}" \
    GA_DIR="${SANDBOX}/ga-install" GA_RELEASE_REPO="owner/repo" GA_NO_RUN=1 \
    /bin/bash "${INSTALL_SH}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(wc -l <"${FETCH_URL_LOG}" | tr -d ' ')" -eq 2 ]] || return 1
  [[ "$(sed -n 1p "${FETCH_URL_LOG}")" == "https://github.com/owner/repo/releases/latest/download/manifest.json" ]] || return 1
  [[ "$(sed -n 2p "${FETCH_URL_LOG}")" == "https://github.com/owner/repo/releases/download/v1.0.9/glass-atrium-bundle-1.0.9.tar.gz" ]] || return 1
  # -f fail-on-HTTP-error + bounded retries on BOTH requests.
  run grep -cE -- '-fSL --retry 3' "${FETCH_ARGV_LOG}"
  [[ "${output}" == "2" ]] || return 1
}

@test "install.sh fetch: GA_RELEASE_TAG pins BOTH assets to the tag-form URLs" {
  t6_require_install_sh
  t6_build_release_fixture 1.0.9
  t6_build_fetch_stub
  run env PATH="${FETCH_BIN}:${PATH}" \
    GA_DIR="${SANDBOX}/ga-install" GA_RELEASE_REPO="owner/repo" GA_NO_RUN=1 \
    GA_RELEASE_TAG="v9.9.9" \
    bash "${INSTALL_SH}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(sed -n 1p "${FETCH_URL_LOG}")" == "https://github.com/owner/repo/releases/download/v9.9.9/manifest.json" ]] || return 1
  [[ "$(sed -n 2p "${FETCH_URL_LOG}")" == "https://github.com/owner/repo/releases/download/v9.9.9/glass-atrium-bundle-1.0.9.tar.gz" ]] || return 1
}

@test "install.sh fetch: manifest download HTTP failure → exit 14 naming the failing URL" {
  t6_require_install_sh
  t6_build_release_fixture 1.0.9
  t6_build_fetch_stub
  run env PATH="${FETCH_BIN}:${PATH}" FETCH_FAIL_MANIFEST=1 \
    GA_DIR="${SANDBOX}/ga-install" GA_RELEASE_REPO="owner/repo" GA_NO_RUN=1 \
    bash "${INSTALL_SH}"
  [[ "${status}" -eq 14 ]] || return 1
  [[ "${output}" == *"manifest download failed: https://github.com/owner/repo/releases/latest/download/manifest.json"* ]] || return 1
}

@test "install.sh fetch: bundle download HTTP failure → exit 14 naming the tag-form URL" {
  t6_require_install_sh
  t6_build_release_fixture 1.0.9
  t6_build_fetch_stub
  run env PATH="${FETCH_BIN}:${PATH}" FETCH_FAIL_BUNDLE=1 \
    GA_DIR="${SANDBOX}/ga-install" GA_RELEASE_REPO="owner/repo" GA_NO_RUN=1 \
    bash "${INSTALL_SH}"
  [[ "${status}" -eq 14 ]] || return 1
  [[ "${output}" == *"bundle download failed: https://github.com/owner/repo/releases/download/v1.0.9/glass-atrium-bundle-1.0.9.tar.gz"* ]] || return 1
}

@test "install.sh fetch: hash mismatch after download still exits 15 (SHA-256 manifest = sole trust anchor)" {
  t6_require_install_sh
  t6_build_release_fixture 1.0.9
  # tamper AFTER hashing: rebuild the bundle with a drifted launcher so the
  # downloaded content no longer matches manifest.hashes.
  printf '#!/usr/bin/env bash\necho TAMPERED\n' >"${SANDBOX}/fixture/tree/glass-atrium"
  tar -czf "${SANDBOX}/fixture/bundle.tar.gz" -C "${SANDBOX}/fixture/tree" glass-atrium scripts
  t6_build_fetch_stub
  run env PATH="${FETCH_BIN}:${PATH}" \
    GA_DIR="${SANDBOX}/ga-install" GA_RELEASE_REPO="owner/repo" GA_NO_RUN=1 \
    bash "${INSTALL_SH}"
  [[ "${status}" -eq 15 ]] || return 1
  [[ "${output}" == *"hash verification failed"* ]] || return 1
  # nothing installed from the tampered bundle.
  [[ ! -e "${SANDBOX}/ga-install/glass-atrium" ]] || return 1
}
