#!/usr/bin/env bats
# monitor/scripts/prune-dist.sh tests: across BOTH compiled trees, an orphaned build
# product is removed while a source-backed one is byte-preserved. Client side — a
# deleted screen's esbuild bundle goes. Server side — a retired module's tsc output
# goes together with its `.js.map`, while a build:assets-copied `.json` and the
# compiled prisma client under dist/generated stay out of the walk's reach. An absent
# source tree is a loud refusal that prunes NEITHER tree, and the npm wiring that runs
# the prune once at the end of the build stays in place.
#
# Regression: a compiler never cleans its outdir, and both dist trees are gitignored so
# a build product can never enter the manifest's `retired` map. Measured twice — a
# deleted screen's bundle served forever (200, 32,390 bytes for a screen whose source
# the updater had already retired to Trash), and two compiled server modules surviving
# their deleted `.ts` sources on the live install.
#
# Every case runs against a synthetic monitor root under BATS_TEST_TMPDIR via the
# ATRIUM_MONITOR_DIR seam — the live ~/.glass-atrium tree is unreachable from here.
#
# EVERY assertion carries `|| return 1`: @test bodies do run under errexit, but
# a bare `[[ ... ]]` that fails mid-body does NOT abort on macOS bash 3.2 — it
# does on CI bash 5.3 (measured: bash 3.2.57 vs 5.3.9, bats 1.13.0 on both
# legs, so bash is the variable, not bats). Unguarded, the assertion is
# silently vacuous locally and aborts the body on CI.
#
# Run via: bats scripts/test/monitor-prune-dist.bats
# Requires: bats (brew install bats-core), bash 3.2+

SCRIPT="${BATS_TEST_DIRNAME}/../../monitor/scripts/prune-dist.sh"

setup() {
  load '../../test/lib/bats-hermetic-env'
  MON="${BATS_TEST_TMPDIR}/monitor"
  SRC="${MON}/public/src"
  DIST="${MON}/public/dist"
  SSRC="${MON}/src/server"
  SDIST="${MON}/dist/server"
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

# The compiled server tree as tsc + build:assets leave it: a `<rel>.js` plus its
# `<rel>.js.map` per source module (sourceMap true, declaration false in
# monitor/tsconfig.json), and every `.json` source copied across verbatim.
# `arch-invariants` is the retired module — its source is gone, its output is not.
fixture_compiled_server_tree() {
  mkdir -p "${SSRC}/architecture" "${SDIST}/architecture" \
    "${SSRC}/clauded-docs" "${SDIST}/clauded-docs"
  printf 'source of db\n' >"${SSRC}/db.ts"
  printf 'compiled db\n' >"${SDIST}/db.js"
  printf 'map of db\n' >"${SDIST}/db.js.map"
  printf 'source of parser\n' >"${SSRC}/architecture/parser.ts"
  printf 'compiled parser\n' >"${SDIST}/architecture/parser.js"
  printf 'map of parser\n' >"${SDIST}/architecture/parser.js.map"
  # The second accepted source extension, exercised in the same equivalence class.
  printf 'source of panel\n' >"${SSRC}/architecture/panel.tsx"
  printf 'compiled panel\n' >"${SDIST}/architecture/panel.js"
  # build:assets copies JSON across; no compiled counterpart exists or should.
  printf '{"k":1}\n' >"${SSRC}/clauded-docs/diagram-types.json"
  printf '{"k":1}\n' >"${SDIST}/clauded-docs/diagram-types.json"
  # The retired module: compiled output and map, no source.
  printf 'stale compiled arch-invariants\n' >"${SDIST}/architecture/arch-invariants.js"
  printf 'stale map of arch-invariants\n' >"${SDIST}/architecture/arch-invariants.js.map"
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

@test "a retired server module's compiled output and its map are both removed" {
  fixture_compiled_server_tree
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! -e "${SDIST}/architecture/arch-invariants.js" ]] || return 1
  [[ ! -e "${SDIST}/architecture/arch-invariants.js.map" ]] || return 1
  [[ "${output}" == *'removed orphaned module'*'architecture/arch-invariants.js'* ]] || return 1
}

@test "a source-backed server module, its map and a copied JSON are byte-preserved" {
  fixture_compiled_server_tree
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(cat "${SDIST}/db.js")" == 'compiled db' ]] || return 1
  [[ "$(cat "${SDIST}/db.js.map")" == 'map of db' ]] || return 1
  [[ "$(cat "${SDIST}/architecture/parser.js")" == 'compiled parser' ]] || return 1
  [[ "$(cat "${SDIST}/architecture/parser.js.map")" == 'map of parser' ]] || return 1
  [[ "$(cat "${SDIST}/architecture/panel.js")" == 'compiled panel' ]] || return 1
  [[ "$(cat "${SDIST}/clauded-docs/diagram-types.json")" == '{"k":1}' ]] || return 1
}

@test "an absent server source tree is a loud refusal that prunes neither tree" {
  fixture_built_tree
  mkdir -p "${SDIST}/architecture"
  printf 'compiled arch-invariants\n' >"${SDIST}/architecture/arch-invariants.js"
  run "${SCRIPT}"
  [[ "${status}" -eq 3 ]] || return 1
  [[ "${output}" == *'REFUSING to prune'* ]] || return 1
  [[ -e "${SDIST}/architecture/arch-invariants.js" ]] || return 1
  # Both pairs are validated before any unlink, so the client orphan survives too.
  [[ -e "${DIST}/screens/health.js" ]] || return 1
}

@test "the compiled prisma client survives an absent src/generated" {
  mkdir -p "${SSRC}" "${SDIST}" "${MON}/dist/generated/prisma"
  printf 'source of db\n' >"${SSRC}/db.ts"
  printf 'compiled db\n' >"${SDIST}/db.js"
  # src/generated is gitignored and exists only after `prisma generate`, so a walk
  # keyed on dist/** against src/** would unlink the whole compiled client here.
  printf 'compiled prisma client\n' >"${MON}/dist/generated/prisma/client.js"
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ -e "${MON}/dist/generated/prisma/client.js" ]] || return 1
  [[ "${output}" != *'REFUSING to prune'* ]] || return 1
  [[ "${output}" != *'removed orphaned'* ]] || return 1
}

@test "the monitor build chains the prune once, after tsc and esbuild" {
  local pkg="${BATS_TEST_DIRNAME}/../../monitor/package.json"
  run grep -F 'scripts/prune-dist.sh' "${pkg}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${#lines[@]}" -eq 1 ]] || return 1
  [[ "${output}" == *'"build":'* ]] || return 1
  [[ "${output}" == *'npm run build:client && scripts/prune-dist.sh'* ]] || return 1
}
