#!/usr/bin/env bats
# monitor/scripts/prune-dist.sh tests: a deleted screen's BUILT bundle is removed
# from the esbuild outdir, a still-live screen's bundle is byte-preserved, the
# never-built and no-counterpart paths are no-ops, an absent source tree is a
# loud refusal (never a wipe), and the npm wiring that runs it stays in place.
#
# Regression: esbuild never cleans its --outdir, and public/dist is gitignored so
# a build product can never enter the manifest's `retired` map — a deleted
# screen's bundle was therefore served forever (measured: 200, 32,390 bytes for
# a screen whose source the updater had already retired to Trash).
#
# Every case runs against a synthetic monitor root under BATS_TEST_TMPDIR via the
# ATRIUM_MONITOR_DIR seam — the live ~/.glass-atrium tree is unreachable from here.
#
# EVERY assertion carries `|| return 1`: a bare `[[ ... ]]` that fails mid-body
# does NOT fail the test on bats 1.13 (only the final command's status is
# consulted), so an unguarded mid-body assertion is silently vacuous.
#
# Run via: bats scripts/test/monitor-prune-dist.bats
# Requires: bats (brew install bats-core), bash 3.2+

SCRIPT="${BATS_TEST_DIRNAME}/../../monitor/scripts/prune-dist.sh"

setup() {
  load '../../test/lib/bats-hermetic-env'
  MON="${BATS_TEST_TMPDIR}/monitor"
  SRC="${MON}/public/src"
  DIST="${MON}/public/dist"
  export ATRIUM_MONITOR_DIR="${MON}"
}

# A monitor tree shaped like the real one: three top-level entries plus a screens
# dir, built. `health` is the deleted screen — its source is absent, its bundle
# is not. `wiki` is still live on both sides.
fixture_built_tree() {
  mkdir -p "${SRC}/screens" "${DIST}/screens"
  local name
  for name in app ui tweaks-panel; do
    printf 'source of %s\n' "${name}" >"${SRC}/${name}.jsx"
    printf 'bundle of %s\n' "${name}" >"${DIST}/${name}.js"
  done
  printf 'source of wiki\n' >"${SRC}/screens/wiki.jsx"
  printf 'bundle of wiki\n' >"${DIST}/screens/wiki.js"
  # The deleted screen: bundle only, no source.
  printf 'stale bundle of health\n' >"${DIST}/screens/health.js"
}

@test "a deleted screen's built bundle is removed from the outdir" {
  fixture_built_tree
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! -e "${DIST}/screens/health.js" ]] || return 1
  [[ "${output}" == *'removed orphaned bundle'*'screens/health.js'* ]] || return 1
}

@test "a still-live screen's bundle and the top-level bundles are byte-preserved" {
  fixture_built_tree
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(cat "${DIST}/screens/wiki.js")" == 'bundle of wiki' ]] || return 1
  [[ "$(cat "${DIST}/app.js")" == 'bundle of app' ]] || return 1
  [[ "$(cat "${DIST}/ui.js")" == 'bundle of ui' ]] || return 1
  [[ "$(cat "${DIST}/tweaks-panel.js")" == 'bundle of tweaks-panel' ]] || return 1
}

@test "a bundle backed by a same-named .js source is kept" {
  mkdir -p "${SRC}/data" "${DIST}/data"
  printf 'plain source\n' >"${SRC}/data/pricing.js"
  printf 'copied through\n' >"${DIST}/data/pricing.js"
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ -e "${DIST}/data/pricing.js" ]] || return 1
}

@test "an install that never built the client is a no-op" {
  mkdir -p "${SRC}/screens"
  printf 'source of wiki\n' >"${SRC}/screens/wiki.jsx"
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! -d "${DIST}" ]] || return 1
}

@test "a retired source with no built counterpart is a no-op" {
  mkdir -p "${SRC}/screens" "${DIST}/screens"
  printf 'source of wiki\n' >"${SRC}/screens/wiki.jsx"
  printf 'bundle of wiki\n' >"${DIST}/screens/wiki.js"
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ -e "${DIST}/screens/wiki.js" ]] || return 1
  [[ "${output}" != *'removed orphaned bundle'* ]] || return 1
}

@test "an absent source tree is a loud refusal, never a wipe" {
  mkdir -p "${DIST}/screens"
  printf 'bundle of wiki\n' >"${DIST}/screens/wiki.js"
  run "${SCRIPT}"
  [[ "${status}" -eq 3 ]] || return 1
  [[ "${output}" == *'REFUSING to prune'* ]] || return 1
  [[ -e "${DIST}/screens/wiki.js" ]] || return 1
}

@test "a second run is idempotent and silent" {
  fixture_built_tree
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${output}" ]] || return 1
}

@test "a symlink inside the outdir is never followed to its target" {
  mkdir -p "${SRC}/screens" "${DIST}/screens"
  printf 'source of wiki\n' >"${SRC}/screens/wiki.jsx"
  printf 'outside the outdir\n' >"${BATS_TEST_TMPDIR}/outside.js"
  ln -s "${BATS_TEST_TMPDIR}/outside.js" "${DIST}/screens/escape.js"
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ -e "${BATS_TEST_TMPDIR}/outside.js" ]] || return 1
}

@test "build:jsx still chains the prune after esbuild" {
  local pkg="${BATS_TEST_DIRNAME}/../../monitor/package.json"
  run grep -F 'scripts/prune-dist.sh' "${pkg}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *'"build:jsx"'* ]] || return 1
}
