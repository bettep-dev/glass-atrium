#!/usr/bin/env bats
# manifest-mode-integrity.bats — FB-2 manifest mode integrity (D6 R1 apply-then-verify).
#
# CONTRACT UNDER TEST:
#   * generate-manifest.sh emits a modes map (path -> octal) covering EVERY
#     files[] entry, additive-inert to the pre-existing required-key shape gate
#     and the --check consumer (both-direction compat), with --check flagging
#     mode drift (chmod with unchanged content — invisible to the hash gate).
#   * install.sh converges every installed file on manifest.modes post-extract:
#     a mode-stripped bundle member lands executable (apply logged, then
#     verified); a modes-less manifest skips fail-open with ONE notice; a
#     malformed octal is a loud named failure (exit 19).
#   * update.sh: _update_agent_apply re-applies the mapped mode post-copy (the
#     plain-copy hole), and update_enforce_manifest_modes fixes + logs drift,
#     warn-skips missing targets, and notices ONCE on a modes-less manifest.
#
# STRATEGY: generator + installer are invoked DIRECTLY as commands (exec bit
# exercised — governing lesson from the shipped-inert incident). The generator
# runs from a COPY inside a throwaway fixture git repo (it resolves GA_ROOT from
# its own location); install.sh uses the GA_INSTALL_SRC_* local seams (no
# network). update.sh internals are driven through a DRIVER command that sources
# update.sh (update_main skipped when sourced — established suite pattern) and
# clears the inherited ERR trap. No ~/.claude or ~/.glass-atrium mutation.
#
# Every assertion is gated `|| return 1`.
#
# Run via: bats scripts/test/manifest-mode-integrity.bats
# Requires: bats 1.5+, git, jq, tar, bash 3.2+
bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"

# Octal permission of a file — BSD stat (macOS) first, GNU coreutils fallback.
mode_of() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v git >/dev/null 2>&1 || skip "git required"
  command -v tar >/dev/null 2>&1 || skip "tar required"
  SANDBOX="$(mktemp -d -t ga-mode-integrity.XXXXXX)"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX:-}" ]] && rm -rf -- "${SANDBOX}"
}

# Throwaway git fixture holding a COPY of the generator (GA_ROOT = the fixture),
# one 755 hook + one 644 agent file, and a seed manifest carrying the required
# _doc_settings_json contract key. git index only — ls-files needs no commit.
make_gen_fixture() {
  FIX="${SANDBOX}/genfix"
  mkdir -p "${FIX}/scripts" "${FIX}/hooks" "${FIX}/agents"
  cp -p -- "${GA}/scripts/generate-manifest.sh" "${FIX}/scripts/generate-manifest.sh"
  printf '#!/usr/bin/env bash\nprintf ok\n' >"${FIX}/hooks/probe.sh"
  chmod 755 "${FIX}/hooks/probe.sh"
  printf 'agent body\n' >"${FIX}/agents/a.md"
  chmod 644 "${FIX}/agents/a.md"
  printf '{"version":"0.0.0","_doc_settings_json":"contract","files":["x"],"hashes":{}}\n' \
    >"${FIX}/manifest.json"
  git -C "${FIX}" init -q
  git -C "${FIX}" add hooks agents scripts
}

# Local release bundle + manifest for the GA_INSTALL_SRC_* seams. The bundled
# hook ships MODE-STRIPPED (644) while the manifest maps it 755 — the
# post-extract enforcement must close that gap. $1 = with-modes|no-modes|bad-octal.
make_install_fixture() {
  local variant="$1" h_probe h_launcher h_spine m_spine modes_json
  BUNDLE_ROOT="${SANDBOX}/bundle-root"
  GA_DIR_FIX="${SANDBOX}/ga-home"
  mkdir -p "${BUNDLE_ROOT}/hooks" "${BUNDLE_ROOT}/scripts/lib"
  printf '#!/usr/bin/env bash\nprintf mode-probe-ok\n' >"${BUNDLE_ROOT}/hooks/probe.sh"
  chmod 644 "${BUNDLE_ROOT}/hooks/probe.sh" # STRIPPED on purpose
  printf '#!/usr/bin/env bash\nexit 0\n' >"${BUNDLE_ROOT}/glass-atrium"
  chmod 755 "${BUNDLE_ROOT}/glass-atrium"
  cp -p -- "${GA}/scripts/lib/apply-spine.sh" "${BUNDLE_ROOT}/scripts/lib/apply-spine.sh"
  h_probe="$(shasum -a 256 "${BUNDLE_ROOT}/hooks/probe.sh" | awk '{print $1}')"
  h_launcher="$(shasum -a 256 "${BUNDLE_ROOT}/glass-atrium" | awk '{print $1}')"
  h_spine="$(shasum -a 256 "${BUNDLE_ROOT}/scripts/lib/apply-spine.sh" | awk '{print $1}')"
  m_spine="$(mode_of "${BUNDLE_ROOT}/scripts/lib/apply-spine.sh")"
  case "${variant}" in
    with-modes)
      modes_json="{\"glass-atrium\":\"755\",\"hooks/probe.sh\":\"755\",\"scripts/lib/apply-spine.sh\":\"${m_spine}\"}"
      ;;
    bad-octal)
      modes_json="{\"glass-atrium\":\"755\",\"hooks/probe.sh\":\"9zz\",\"scripts/lib/apply-spine.sh\":\"${m_spine}\"}"
      ;;
    no-modes)
      modes_json=""
      ;;
  esac
  SRC_MANIFEST="${SANDBOX}/manifest.json"
  jq -n \
    --arg hp "${h_probe}" --arg hl "${h_launcher}" --arg hs "${h_spine}" \
    '{version:"9.9.9", _doc_settings_json:"t",
      files:["glass-atrium","hooks/probe.sh","scripts/lib/apply-spine.sh"],
      hashes:{"glass-atrium":$hl,"hooks/probe.sh":$hp,"scripts/lib/apply-spine.sh":$hs}}' \
    >"${SRC_MANIFEST}"
  if [[ -n "${modes_json}" ]]; then
    jq --argjson m "${modes_json}" '. + {modes:$m}' "${SRC_MANIFEST}" >"${SRC_MANIFEST}.tmp"
    mv -f -- "${SRC_MANIFEST}.tmp" "${SRC_MANIFEST}"
  fi
  SRC_BUNDLE="${SANDBOX}/bundle.tar.gz"
  tar -czf "${SRC_BUNDLE}" -C "${BUNDLE_ROOT}" glass-atrium hooks scripts
}

# DRIVER command: source update.sh, clear the inherited ERR trap, assign the
# context globals from DRV_* env (top-level source resets them), run "$@".
make_update_driver() {
  DRIVER="${SANDBOX}/driver.sh"
  cat >"${DRIVER}" <<DRV
#!/usr/bin/env bash
set -uo pipefail
source "${GA}/scripts/update.sh"
trap - ERR
_update_agent_install_root="\${DRV_ROOT:-}"
_update_modes_manifest="\${DRV_MODES_MANIFEST:-}"
"\$@"
DRV
  chmod 755 "${DRIVER}"
}

# --- generator -------------------------------------------------------------

@test "generator: modes map covers every files[] entry with on-disk octals" {
  make_gen_fixture
  run -0 "${FIX}/scripts/generate-manifest.sh"
  jq -e '
    . as $m
    | (.files | length) > 0
    and (.modes | type == "object")
    and ((.modes | length) == (.files | length))
    and all(.files[]; . as $f | $m.modes | has($f))
  ' "${FIX}/manifest.json" >/dev/null || return 1
  [ "$(jq -r '.modes["hooks/probe.sh"]' "${FIX}/manifest.json")" = "755" ] || return 1
  [ "$(jq -r '.modes["agents/a.md"]' "${FIX}/manifest.json")" = "644" ] || return 1
}

@test "generator: modes key inert to the pre-existing required-key gate and --check" {
  make_gen_fixture
  run -0 "${FIX}/scripts/generate-manifest.sh"
  # precondition: this IS a modes-bearing manifest (unsatisfiable pre-emission)
  jq -e '.modes | type == "object"' "${FIX}/manifest.json" >/dev/null || return 1
  # old-consumer required-key gate (pinned pre-modes shape) — additive key inert
  jq -e '
    (.version | type == "string")
    and (._doc_settings_json | type == "string")
    and (.files | type == "array" and length > 0)
    and (.hashes | type == "object")
    and ((.hashes | length) == (.files | length))
    and (.hashes | to_entries | all(.value | test("^[0-9a-f]{64}$")))
  ' "${FIX}/manifest.json" >/dev/null || return 1
  run -0 "${FIX}/scripts/generate-manifest.sh" --check
}

@test "generator --check: flags mode drift (chmod, content unchanged)" {
  make_gen_fixture
  run -0 "${FIX}/scripts/generate-manifest.sh"
  chmod 644 "${FIX}/hooks/probe.sh"
  run -1 "${FIX}/scripts/generate-manifest.sh" --check
  [[ "${output}" == *"MODE mismatch"* ]] || return 1
}

# --- install.sh ------------------------------------------------------------

@test "install: mode-stripped hook lands executable via apply-then-verify (direct command)" {
  [[ "$(uname -s)" == "Darwin" ]] || skip "install.sh is macOS-only"
  make_install_fixture with-modes
  run -0 env GA_DIR="${GA_DIR_FIX}" GA_NO_RUN=1 \
    GA_INSTALL_SRC_MANIFEST="${SRC_MANIFEST}" GA_INSTALL_SRC_BUNDLE="${SRC_BUNDLE}" \
    "${GA}/install.sh"
  local install_out="${output}"
  [[ "${install_out}" == *"mode applied: hooks/probe.sh 644 -> 755"* ]] || return 1
  [ -x "${GA_DIR_FIX}/hooks/probe.sh" ] || return 1
  [ "$(mode_of "${GA_DIR_FIX}/hooks/probe.sh")" = "755" ] || return 1
  run -0 "${GA_DIR_FIX}/hooks/probe.sh"
  [ "${output}" = "mode-probe-ok" ] || return 1
}

@test "install: modes-less manifest skips fail-open with one notice" {
  [[ "$(uname -s)" == "Darwin" ]] || skip "install.sh is macOS-only"
  make_install_fixture no-modes
  run -0 env GA_DIR="${GA_DIR_FIX}" GA_NO_RUN=1 \
    GA_INSTALL_SRC_MANIFEST="${SRC_MANIFEST}" GA_INSTALL_SRC_BUNDLE="${SRC_BUNDLE}" \
    "${GA}/install.sh"
  [ "$(grep -c 'no modes map' <<<"${output}")" -eq 1 ] || return 1
  # fail-open means SKIP: the stripped hook stays as the archive shipped it
  [ ! -x "${GA_DIR_FIX}/hooks/probe.sh" ] || return 1
}

@test "install: malformed octal in modes map is a loud named failure (exit 19)" {
  [[ "$(uname -s)" == "Darwin" ]] || skip "install.sh is macOS-only"
  make_install_fixture bad-octal
  run -19 env GA_DIR="${GA_DIR_FIX}" GA_NO_RUN=1 \
    GA_INSTALL_SRC_MANIFEST="${SRC_MANIFEST}" GA_INSTALL_SRC_BUNDLE="${SRC_BUNDLE}" \
    "${GA}/install.sh"
  [[ "${output}" == *"not a valid octal mode"* ]] || return 1
}

# --- update.sh -------------------------------------------------------------

@test "update: _update_agent_apply re-applies the manifest mode post-copy" {
  make_update_driver
  local root="${SANDBOX}/root" cand="${SANDBOX}/cand.md" mm="${SANDBOX}/mm.json"
  mkdir -p "${root}/agents"
  printf 'merged body\n' >"${cand}"
  chmod 600 "${cand}" # mktemp-like candidate mode
  printf 'old\n' >"${root}/agents/a.md"
  chmod 600 "${root}/agents/a.md"
  jq -n '{modes:{"agents/a.md":"644"}}' >"${mm}"
  run -0 env DRV_ROOT="${root}" DRV_MODES_MANIFEST="${mm}" \
    "${DRIVER}" _update_agent_apply "${root}/agents/a.md" "${cand}"
  [ "$(cat "${root}/agents/a.md")" = "merged body" ] || return 1
  [ "$(mode_of "${root}/agents/a.md")" = "644" ] || return 1
}

@test "update: enforce fixes drift, logs delta, warn-skips missing targets" {
  make_update_driver
  local root="${SANDBOX}/uroot" mm="${SANDBOX}/um.json" enf_out
  mkdir -p "${root}/hooks"
  printf '#!/usr/bin/env bash\nprintf u-ok\n' >"${root}/hooks/u.sh"
  chmod 644 "${root}/hooks/u.sh"
  jq -n '{files:[], hashes:{}, modes:{"hooks/u.sh":"755","hooks/ghost.sh":"755"}}' >"${mm}"
  run -0 "${DRIVER}" update_enforce_manifest_modes "${mm}" "${root}"
  enf_out="${output}"
  [[ "${enf_out}" == *"mode applied: hooks/u.sh 644 -> 755"* ]] || return 1
  [[ "${enf_out}" == *"mode target missing"* ]] || return 1
  [ "$(mode_of "${root}/hooks/u.sh")" = "755" ] || return 1
  run -0 "${root}/hooks/u.sh" # direct-command execution proof
  [ "${output}" = "u-ok" ] || return 1
}

@test "update: modes-less manifest notices once and returns 0" {
  make_update_driver
  printf '{"files":[],"hashes":{}}\n' >"${SANDBOX}/old.json"
  run -0 "${DRIVER}" update_enforce_manifest_modes "${SANDBOX}/old.json" "${SANDBOX}"
  [ "$(grep -c 'no modes map' <<<"${output}")" -eq 1 ] || return 1
}

@test "update: update_run wires post-landing enforcement on all three exit paths" {
  # wiring pin: one enforcement call after each update_finalize_merge_and_anchors
  # site (already-up-to-date, sensitive-only, full-apply) — behavior rows above
  # cover the function; this pins the call sites.
  [ "$(grep -c 'update_enforce_manifest_modes "${manifest}" "${root}"' \
    "${GA}/scripts/update.sh")" -eq 3 ] || return 1
}
