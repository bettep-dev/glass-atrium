#!/usr/bin/env bats
# Manifest key containment at the lib/ entry points (install · agents-only · uninstall · prune · doctor).
#
# read_manifest_files feeds process substitutions, where a die only truncates the loop and the
# caller still exits 0 — so the containment check runs in the PARENT shell before every manifest
# loop, and each test pins a non-zero exit, never a truncated loop. Offender keys follow the spine
# rule (spine_is_escaping_key): empty, absolute, or carrying a `..` segment.
#
# Hermetic: GA_ROOT and the target live under one mktemp -d, in sibling parents (a/ga, b/target),
# so an escaping key lands in a sandbox dir the assertions can inspect. Collaborators that reach
# launchd, databases or shell rc files are shadowed in the same shell before run_uninstall runs.
#
# Run via: bats test/manifest-key-containment.bats
# Requires: bats >= 1.5.0, jq, shasum, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
readonly ESCAPING_KEY_EXIT=25

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  SANDBOX="$(cd -- "$(mktemp -d -t ga-manifest-contain.XXXXXX)" && pwd -P)"
  GA_SANDBOX="${SANDBOX}/a/ga"
  TARGET="${SANDBOX}/b/target"
  MANIFEST="${SANDBOX}/manifest.json"
  STATE="${SANDBOX}/state"
  RECORD="${SANDBOX}/mutators.log"
  mkdir -p "${GA_SANDBOX}/agents" "${TARGET}" "${SANDBOX}/a/esc" "${STATE}"
  printf 'agent body\n' >"${GA_SANDBOX}/agents/dev-x.md"
  printf 'outside payload\n' >"${SANDBOX}/a/esc/x.md"
  printf 'outside secret\n' >"${SANDBOX}/a/esc/secret.md"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# write_manifest KEY… — files[] in the given order; a key naming an existing sandbox file gets its REAL sha256, any other key no hash row.
write_manifest() {
  local key src hashes="{}" modes="{}" sum
  for key in "$@"; do
    src="${GA_SANDBOX}/${key}"
    [[ -n "${key}" && -f "${src}" ]] || continue
    sum="$(shasum -a 256 -- "${src}" | awk '{print $1}')"
    hashes="$(jq -c --arg k "${key}" --arg v "${sum}" '. + {($k): $v}' <<<"${hashes}")"
    modes="$(jq -c --arg k "${key}" '. + {($k): "644"}' <<<"${modes}")"
  done
  printf '%s\n' "$@" | jq -R . | jq -s --argjson h "${hashes}" --argjson m "${modes}" \
    '{version:"1.0.0", files:., hashes:$h, modes:$m}' >"${MANIFEST}"
}

# run_engine SCRIPT — the REAL engine sourced fresh under the entry point's strict mode, then SCRIPT.
run_engine() {
  run env GA_LIB_DIR="${GA}/scripts/lib" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}" GA_DATA_ROOT="${SANDBOX}/data" RECORD="${RECORD}" \
    GA_GENERATE_MANIFEST="${SANDBOX}/no-such-generator" ATRIUM_MONITOR_PORT=1 \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      DRY_RUN=false
      eval "$3"
    ' _ "${GA}" "${GA_SANDBOX}" "$1"
}

# run_launcher ARG… — the REAL glass-atrium passthrough against the sandboxed target + manifest.
run_launcher() {
  run env GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" ATRIUM_UPDATE_STATE_DIR="${STATE}" \
    "${GA}/glass-atrium" "$@"
}

# run_passthrough ARG… — the REAL launcher passthrough, with run_install / run_uninstall shadowed by
# recorders in the same shell: a refusal must happen before either starts.
run_passthrough() {
  run env GA_LAUNCHER="${GA}/glass-atrium" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}" RECORD="${RECORD}" \
    bash -c '
      source "${GA_LAUNCHER}" >/dev/null 2>&1
      run_install() { printf "run_install\n" >>"${RECORD}"; }
      run_uninstall() { printf "run_uninstall\n" >>"${RECORD}"; }
      passthrough "$@"
    ' _ "$@"
}

assert_status() {
  [ "${status}" -eq "${1}" ] || {
    printf 'status=%s (expected %s):\n%s\n' "${status}" "${1}" "${output}" >&2
    return 1
  }
}

assert_has() {
  [[ "${output}" == *"${1}"* ]] || {
    printf 'output missing [%s]:\n%s\n' "${1}" "${output}" >&2
    return 1
  }
}

@test "agents-only: an escaping files[] key fails the run before any symlink is farmed" {
  write_manifest "agents/dev-x.md" "../esc/x.md"
  run_engine 'run_agents_only'
  assert_status "${ESCAPING_KEY_EXIT}"
  assert_has "manifest key escapes the install root: ../esc/x.md"
  [ ! -e "${SANDBOX}/b/esc" ]
  [ ! -L "${TARGET}/agents/dev-x.md" ]
}

@test "agents-only: a non-array files member is refused as unreadable, not read as an empty farm" {
  printf '{"version":"1.0.0","files":"agents/dev-x.md"}\n' >"${MANIFEST}"
  run_engine 'run_agents_only'
  assert_status "${ESCAPING_KEY_EXIT}"
  assert_has "manifest files[] unreadable"
}

@test "CLI install: an escaping key exits non-zero before run_install starts" {
  write_manifest "agents/dev-x.md" "../esc/x.md"
  run_passthrough install
  assert_status "${ESCAPING_KEY_EXIT}"
  assert_has "manifest key escapes the install root: ../esc/x.md"
  [ ! -s "${RECORD}" ]
}

@test "CLI uninstall: an escaping key exits non-zero before run_uninstall starts" {
  write_manifest "agents/dev-x.md" "../esc/sub/x.md"
  run_passthrough uninstall --yes
  assert_status "${ESCAPING_KEY_EXIT}"
  assert_has "manifest key escapes the install root: ../esc/sub/x.md"
  [ ! -s "${RECORD}" ]
}

@test "uninstall TUI step: remove_empty_dirs returns non-zero under GA_TUI_STEP instead of killing the process" {
  write_manifest "../esc/sub/x.md"
  mkdir -p "${SANDBOX}/b/esc/sub"
  run_engine 'GA_TUI_STEP=1; rc=0; remove_empty_dirs || rc=$?; printf "step-rc=%s\n" "${rc}"'
  assert_status 0
  assert_has "step-rc=${ESCAPING_KEY_EXIT}"
  [ -d "${SANDBOX}/b/esc/sub" ]
}

@test "install baseline: an escaping agents/ key never copies an outside file into the base store" {
  write_manifest "agents/dev-x.md" "agents/../../esc/secret.md"
  run_engine 'capture_base_agent_store'
  assert_status 0
  assert_has "manifest key escapes the install root: agents/../../esc/secret.md"
  assert_has "base-content store NOT seeded"
  [ ! -e "${STATE}/base-agents/secret.md" ]
  [ ! -e "${STATE}/base-agents/dev-x.md" ]
}

@test "CLI agents-only: an empty files[] key exits non-zero" {
  write_manifest ""
  run_launcher agents-only
  assert_status "${ESCAPING_KEY_EXIT}"
  assert_has "manifest key escapes the install root: ''"
}

@test "CLI prune: an escaping files[] key exits non-zero" {
  write_manifest "../../x"
  run_launcher prune
  assert_status "${ESCAPING_KEY_EXIT}"
  assert_has "manifest key escapes the install root: ../../x"
}

@test "CLI uninstall --orphan-scan: an absolute files[] key exits non-zero" {
  write_manifest "/etc/hosts"
  run_launcher uninstall --orphan-scan
  assert_status "${ESCAPING_KEY_EXIT}"
  assert_has "manifest key escapes the install root: /etc/hosts"
}

@test "doctor: an escaping files[] key is a FAIL row and the report still completes" {
  write_manifest "agents/dev-x.md" "../esc/x.md"
  run_engine 'run_doctor'
  assert_has "manifest key escapes the install root: ../esc/x.md"
  assert_has "FAIL : manifest carries escaping or unreadable files[] key(s)"
  assert_has "== doctor: FAIL =="
}
