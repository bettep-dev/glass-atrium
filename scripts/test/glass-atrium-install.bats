#!/usr/bin/env bats
# install.sh suite (P2-T1/P2-T4 acceptance — plan test family 2) — pins the
# no-.git bundle-install contract of the root install.sh, driven hermetically
# through its documented test seam (GA_INSTALL_SRC_BUNDLE + GA_INSTALL_SRC_MANIFEST:
# both set → install from a local bundle + manifest verbatim, no gh/network).
#
# The 7 cases pinned here:
#   1. fresh install from a locally-built bundle+manifest  → a runnable no-.git
#      tree: lib/ga-core.sh, monitor/ tree, config.toml.example,
#      requirements.txt, executable launcher, persisted install manifest
#      {version}, and NO .git directory
#   2. reinstall over an existing tree is merge-not-wipe   → the preserve-set
#      (agents-bak/, wiki/, secrets/, rendered/, data/, config.toml,
#      .update-state) stays BYTE-INTACT across a version-bump extract-in-place
#   3. idempotency                                         → same version +
#      passing verify is the documented no-op ("already installed … no extract
#      needed"), zero content churn in GA_DIR
#   4. same-version-different-bytes                        → per-file SHA-256
#      verify rejects loudly with the named exit code 15 (EXIT_VERIFY_FAILED)
#      and writes NOTHING into GA_DIR
#   5. release scope                                       → the file list built
#      the way the release builds it (generate-manifest.sh → manifest.files →
#      tar -T) carries NO agents-bak/wiki/secrets/rendered/data member, even
#      when those state dirs are adversarially git-tracked (SCOPE_PATHS is the
#      structural exclusion layer; .gitignore is only belt-and-suspenders)
#   6. consent gate holds on manifest-only                  → a prior EXTRACT
#      (manifest.json present, ZERO GA-pointing facade links — the curl|bash
#      then exit-the-menu-without-installing corner) never fires the mirror
#      farm on a re-run: `agents-only` is not invoked, the facade stays empty
#   7. consent gate arms on links                           → GA-pointing
#      facade links (the artifact only the consented menu Install creates)
#      fire the reinstall-parity refresh (incident #58325 coverage preserved)
#
# Run via: bats scripts/test/glass-atrium-install.bats
# Requires: bats >= 1.5.0, jq, tar, shasum (or sha256sum); cases 1-4 + 6-7 need
#           macOS (install.sh's preflight loud-fails exit 10 elsewhere →
#           skipped on Linux CI, same idiom as daemon-daily-restart.bats);
#           case 5 needs git
#
# Hermetic strategy: a per-test mktemp sandbox holds a SYNTHETIC minimal source
# tree (executable launcher + lib/ + monitor/ + config/deps stubs + a REAL copy
# of scripts/lib/apply-spine.sh — load-bearing, because install.sh::verify_bundle
# sources the spine FROM THE EXTRACTED bundle) and a release built exactly like
# publish-release.sh::build_assets (manifest {version, files, hashes} +
# `tar -czf … -C <root> -T <filelist>`). install.sh runs against a sandbox
# GA_DIR under a sandbox HOME with GA_NO_RUN=1, so the live ~/.glass-atrium
# install, the real HOME, launchd, and the launcher exec are NEVER touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
INSTALL_SH="${GA}/install.sh"
REAL_SPINE="${GA}/scripts/lib/apply-spine.sh"
REAL_FARM="${GA}/scripts/lib/mirror-farm.sh"
REAL_GENMAN="${GA}/scripts/generate-manifest.sh"

setup() {
  [[ -f "${INSTALL_SH}" ]] || skip "install.sh not found: ${INSTALL_SH}"
  [[ -f "${REAL_SPINE}" ]] || skip "apply-spine.sh not found: ${REAL_SPINE}"
  [[ -f "${REAL_FARM}" ]] || skip "mirror-farm.sh not found: ${REAL_FARM}"
  # pwd -P resolves /var -> /private/var so paths the test computes match the
  # paths install.sh derives (same idiom as generate-manifest.bats).
  WORK="$(cd -- "$(mktemp -d -t ga-install-bats.XXXXXX)" && pwd -P)"
  FAKE_HOME="${WORK}/home" # belt-and-suspenders: nothing may deref the real HOME
  TARGET="${WORK}/target"  # the GA_DIR under test — never the real ~/.glass-atrium
  SRC="${WORK}/src"        # synthetic minimal release source tree
  RELEASE="${WORK}/release"
  mkdir -p "${FAKE_HOME}" "${RELEASE}"
  build_src_tree
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# install.sh's preflight requires Darwin (named exit 10 elsewhere) — cases 1-4
# drive the real script, so they skip on non-macOS runners.
require_darwin() {
  [[ "$(uname -s)" == "Darwin" ]] || skip "install.sh preflight requires macOS"
}

# The synthetic release member set (== manifest.files of every built release).
# scripts/lib/apply-spine.sh and scripts/lib/mirror-farm.sh are load-bearing:
# verify_bundle sources the spine and refresh_mirror_farm sources the farm lib
# from the EXTRACTED bundle, so both must be hashed members like everything else.
list_members() {
  cat <<'MEMBERS'
agents/alpha.md
config.toml.example
glass-atrium
lib/ga-core.sh
monitor/package.json
requirements.txt
scripts/lib/apply-spine.sh
scripts/lib/mirror-farm.sh
MEMBERS
}

# Minimal source tree that makes the installed result "runnable" by install.sh's
# own definition: an executable launcher (the handoff -x gate) plus the
# INCLUDE-B runtime members the plan requires present after a fresh install.
build_src_tree() {
  mkdir -p "${SRC}/agents" "${SRC}/lib" "${SRC}/monitor" "${SRC}/scripts/lib"
  printf '# agent alpha v1\n' >"${SRC}/agents/alpha.md"
  printf '# config template v1\n' >"${SRC}/config.toml.example"
  # Recording stub launcher: the consent-gate cases (6-7) assert whether the
  # installer's mirror refresh actually shelled out to `glass-atrium agents-only`
  # (the farm subprocess inherits GA_FARM_CALL_LOG from run_install's env).
  cat >"${SRC}/glass-atrium" <<'LAUNCHER'
#!/usr/bin/env bash
if [[ "${1:-}" == "agents-only" && -n "${GA_FARM_CALL_LOG:-}" ]]; then
  printf 'agents-only\n' >>"${GA_FARM_CALL_LOG}"
fi
exit 0
LAUNCHER
  chmod +x "${SRC}/glass-atrium"
  printf '# ga-core stub v1\n' >"${SRC}/lib/ga-core.sh"
  printf '{"name":"monitor-stub"}\n' >"${SRC}/monitor/package.json"
  printf 'stub-dep==0.0.0\n' >"${SRC}/requirements.txt"
  cp -p "${REAL_SPINE}" "${SRC}/scripts/lib/apply-spine.sh"
  cp -p "${REAL_FARM}" "${SRC}/scripts/lib/mirror-farm.sh"
}

# Echo the lowercase 64-hex SHA-256 of a file — shasum (macOS) preferred,
# sha256sum (GNU) fallback, same precedence as generate-manifest.sh.
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    sha256sum -- "$1" | awk '{print $1}'
  fi
}

# Build a release the way publish-release.sh::build_assets does: a manifest
# {version, files, hashes} over EXACTLY the member list, then
# `tar -czf … -C <src> -T <filelist>`. Overwrites ${RELEASE}/manifest.json +
# ${RELEASE}/bundle.tar.gz. Args: $1 = version to stamp.
build_release() {
  local version="$1" f files_json hashes_json
  files_json="$(list_members | jq -R . | jq -s .)"
  hashes_json="$(
    while IFS= read -r f; do
      printf '%s\t%s\n' "${f}" "$(sha256_of "${SRC}/${f}")"
    done < <(list_members) | jq -R 'split("\t") | {(.[0]): .[1]}' | jq -s 'add // {}'
  )"
  jq -n --arg ver "${version}" \
    --argjson files "${files_json}" --argjson hashes "${hashes_json}" \
    '{version: $ver, files: $files, hashes: $hashes}' >"${RELEASE}/manifest.json"
  list_members >"${RELEASE}/filelist.txt"
  tar -czf "${RELEASE}/bundle.tar.gz" -C "${SRC}" -T "${RELEASE}/filelist.txt"
}

# Run install.sh through the local-bundle seam against the sandbox GA_DIR.
# GA_NO_RUN keeps handoff() from exec'ing the launcher; `run` sets the usual
# $status/$output globals for the calling test.
run_install() {
  run env HOME="${FAKE_HOME}" \
    GA_DIR="${TARGET}" \
    GA_NO_RUN=1 \
    GA_FARM_CALL_LOG="${WORK}/farm-calls.log" \
    GA_INSTALL_SRC_BUNDLE="${RELEASE}/bundle.tar.gz" \
    GA_INSTALL_SRC_MANIFEST="${RELEASE}/manifest.json" \
    bash "${INSTALL_SH}"
}

# --- 1. fresh install → runnable no-.git tree -------------------------------

@test "fresh install from a local bundle+manifest (test seam) yields a runnable no-.git tree" {
  require_darwin
  build_release "1.0.0-test"
  run_install
  [ "$status" -eq 0 ]
  [[ "$output" == *"test seam"* ]]     # the network path was never taken
  [[ "$output" == *"fresh extract"* ]] # fresh-install branch, not update-in-place
  [[ "$output" == *"GA_NO_RUN set"* ]] # install-only: launcher hint, no exec
  [[ -f "${TARGET}/lib/ga-core.sh" ]]
  [[ -f "${TARGET}/monitor/package.json" ]]
  [[ -f "${TARGET}/config.toml.example" ]]
  [[ -f "${TARGET}/requirements.txt" ]]
  [[ -f "${TARGET}/agents/alpha.md" ]]
  [[ -x "${TARGET}/glass-atrium" ]] # mode preserved through staging + cp -Rp
  # the release manifest is persisted as the install manifest (idempotency key)
  [[ "$(jq -r '.version' "${TARGET}/manifest.json")" == "1.0.0-test" ]]
  [[ ! -e "${TARGET}/.git" ]] # no-.git topology — a bundle extract, not a clone
}

# --- 2. reinstall preserves runtime data byte-intact (merge-not-wipe) -------

@test "reinstall over an existing tree keeps the preserve-set byte-intact (merge-not-wipe)" {
  require_darwin
  build_release "1.0.0-test"
  run_install
  [ "$status" -eq 0 ]

  # seed runtime data — NONE of these is a bundle member, so the additive
  # extract-in-place below must leave every byte alone
  local -a preserved=(
    "agents-bak/2026-01-01_p1/alpha.md.bak"
    "wiki/notes/note.md"
    "secrets/placeholder.txt"
    "rendered/report.html"
    "data/state.json"
    "config.toml"
    ".update-state"
  )
  local rel
  for rel in "${preserved[@]}"; do
    mkdir -p "${TARGET}/$(dirname -- "${rel}")" "${WORK}/expected/$(dirname -- "${rel}")"
    printf 'SENTINEL %s pre-reinstall bytes\n' "${rel}" >"${TARGET}/${rel}"
    cp -p "${TARGET}/${rel}" "${WORK}/expected/${rel}"
  done

  # a version-bump release with a changed member → a REAL extract-in-place runs
  # (a same-version reinstall would no-op and prove nothing about preservation)
  printf '# agent alpha v2\n' >"${SRC}/agents/alpha.md"
  build_release "1.0.1-test"
  run_install
  [ "$status" -eq 0 ]
  [[ "$output" == *"Updating in place"* ]]

  # the extract genuinely ran: member updated + install manifest bumped …
  [[ "$(cat "${TARGET}/agents/alpha.md")" == "# agent alpha v2" ]]
  [[ "$(jq -r '.version' "${TARGET}/manifest.json")" == "1.0.1-test" ]]
  # … and every preserve-set file survived BYTE-INTACT
  for rel in "${preserved[@]}"; do
    cmp -s -- "${TARGET}/${rel}" "${WORK}/expected/${rel}" || {
      echo "preserve-set file mutated by reinstall: ${rel}" >&2
      return 1
    }
  done
}

# --- 3. idempotency: same version + passing verify = no-op ------------------

@test "idempotent reinstall: same version + passing verify is a documented no-op (zero churn)" {
  require_darwin
  build_release "1.0.0-test"
  run_install
  [ "$status" -eq 0 ]

  # churn canary: a local mutation of a BUNDLE MEMBER — a re-extract would
  # clobber it back to the bundle bytes; the same-version no-op must not
  printf '# locally mutated after install\n' >>"${TARGET}/agents/alpha.md"

  run_install
  [ "$status" -eq 0 ]
  [[ "$output" == *"already installed"* ]] # the documented no-op signal
  [[ "$output" == *"no extract needed"* ]]
  grep -q 'locally mutated after install' "${TARGET}/agents/alpha.md" # untouched → genuine no-op
  [[ "$(jq -r '.version' "${TARGET}/manifest.json")" == "1.0.0-test" ]]
}

# --- 4. same-version-different-bytes → per-file verify rejects (exit 15) ----

@test "same-version-different-bytes: per-file SHA-256 verify rejects loudly (exit 15), zero writes" {
  require_darwin
  build_release "1.0.0-test"
  run_install
  [ "$status" -eq 0 ]

  # tamper: rebuild ONLY the bundle from mutated bytes, keeping the v1 manifest
  # (same version, same recorded hashes) → the staging hash gate must trip
  # BEFORE the same-version idempotency check can silently no-op it
  printf '# agent alpha TAMPERED\n' >"${SRC}/agents/alpha.md"
  tar -czf "${RELEASE}/bundle.tar.gz" -C "${SRC}" -T "${RELEASE}/filelist.txt"

  run_install
  [ "$status" -eq 15 ]                       # EXIT_VERIFY_FAILED, the named code
  [[ "$output" == *"hash mismatch"* ]]       # apply-spine names the failing check
  [[ "$output" == *"refusing to install"* ]] # install.sh loud-fail wrapper
  # the reject happened in scratch staging — the live target saw ZERO writes
  [[ "$(cat "${TARGET}/agents/alpha.md")" == "# agent alpha v1" ]]
  [[ "$(jq -r '.version' "${TARGET}/manifest.json")" == "1.0.0-test" ]]
}

# --- 5. release scope: state dirs never enter files[] or the bundle ---------

@test "release scope: agents-bak/wiki/secrets/rendered/data never enter manifest.files or the bundle" {
  command -v git >/dev/null 2>&1 || skip "git required"
  [[ -f "${REAL_GENMAN}" ]] || skip "generate-manifest.sh not found: ${REAL_GENMAN}"

  # sandbox repo, generate-manifest.bats hermetic idiom: a COPY of the real
  # generator so its BASH_SOURCE-derived GA_ROOT resolves to the sandbox
  local repo="${WORK}/repo"
  mkdir -p "${repo}/scripts" "${repo}/agents" "${repo}/rules" \
    "${repo}/agents-bak/2026-01-01_p1" "${repo}/wiki" "${repo}/secrets" \
    "${repo}/rendered" "${repo}/data"
  cp "${REAL_GENMAN}" "${repo}/scripts/generate-manifest.sh"
  printf '{"_doc_settings_json":"sandbox settings.json contract doc","files":[],"hashes":{}}\n' \
    >"${repo}/manifest.json"
  printf '# agent alpha\n' >"${repo}/agents/alpha.md"
  printf '# rule beta\n' >"${repo}/rules/beta.md"
  # state files, ADVERSARIALLY git-tracked below: SCOPE_PATHS (not .gitignore)
  # is the structural exclusion layer the release relies on — prove it holds
  # even when a state file has been committed
  printf 'bak sentinel\n' >"${repo}/agents-bak/2026-01-01_p1/alpha.md.bak"
  printf 'wiki sentinel\n' >"${repo}/wiki/note.md"
  printf 'secret-placeholder sentinel\n' >"${repo}/secrets/placeholder.txt"
  printf 'rendered sentinel\n' >"${repo}/rendered/report.html"
  printf 'data sentinel\n' >"${repo}/data/state.json"
  git -C "${repo}" init -q
  git -C "${repo}" config user.email bats@test.local
  git -C "${repo}" config user.name bats
  git -C "${repo}" add -A
  git -C "${repo}" commit -qm init

  run "${repo}/scripts/generate-manifest.sh"
  [ "$status" -eq 0 ]

  # manifest.files (the release member-list SoT): zero state-dir entries …
  local files
  files="$(jq -r '.files[]' "${repo}/manifest.json")"
  [[ -n "${files}" ]]
  run grep -E '^(agents-bak|wiki|secrets|rendered|data)/' <<<"${files}"
  [ "$status" -ne 0 ]
  [[ -z "$output" ]]
  # … while in-scope members ARE listed (the exclusion is not an empty set)
  grep -qx 'agents/alpha.md' <<<"${files}"

  # build the bundle the way publish-release.sh::build_assets does and assert
  # the ACTUAL tar member list carries no state-dir member either
  local filelist="${WORK}/repo-filelist.txt" bundle="${WORK}/repo-bundle.tar.gz" members
  jq -r '.files[]' "${repo}/manifest.json" >"${filelist}"
  tar -czf "${bundle}" -C "${repo}" -T "${filelist}"
  members="$(tar -tzf "${bundle}")"
  run grep -E '^(agents-bak|wiki|secrets|rendered|data)/' <<<"${members}"
  [ "$status" -ne 0 ]
  [[ -z "$output" ]]
  grep -qx 'agents/alpha.md' <<<"${members}"
}

# --- 6. consent gate: manifest-present + zero-links → NO farm write ---------

@test "consent gate: a prior extract without a consented deploy never fires the mirror farm" {
  require_darwin
  build_release "1.0.0-test"
  run_install # fresh extract — the user then exits the menu WITHOUT installing
  [ "$status" -eq 0 ]

  # the reachable corner: GA_DIR/manifest.json persisted (extract evidence
  # only), a real facade home exists, but it holds ZERO GA-pointing links —
  # no consented deploy ever ran
  mkdir -p "${FAKE_HOME}/.claude"
  run_install # re-run the installer over the existing extract
  [ "$status" -eq 0 ]
  [[ "$output" == *"consent gate"* ]]        # the gate skip is the taken path
  [[ ! -e "${WORK}/farm-calls.log" ]]        # `agents-only` was never invoked
  [[ -z "$(ls -A "${FAKE_HOME}/.claude")" ]] # the facade saw zero writes
}

# --- 7. consent gate: GA-pointing links present → reinstall refresh fires ---

@test "consent gate: an existing consented deploy (GA-pointing links) arms the reinstall refresh" {
  require_darwin
  build_release "1.0.0-test"
  run_install
  [ "$status" -eq 0 ]

  # evidence of a prior consented deploy: a facade symlink pointing into
  # GA_DIR — the artifact only the menu Install / agents-only path creates
  mkdir -p "${FAKE_HOME}/.claude/agents"
  ln -s "${TARGET}/agents/alpha.md" "${FAKE_HOME}/.claude/agents/alpha.md"

  # a version-bump reinstall (the incident #58325 scenario: new files land)
  printf '# agent alpha v2\n' >"${SRC}/agents/alpha.md"
  build_release "1.0.1-test"
  run_install
  [ "$status" -eq 0 ]
  [[ "$output" == *"refreshing facade mirrors"* ]] # the farm path was taken
  grep -qx 'agents-only' "${WORK}/farm-calls.log"  # the canonical entrypoint ran
}
