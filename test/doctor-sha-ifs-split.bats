#!/usr/bin/env bats
# run_doctor §8 sha-command word-split regression under the launcher's strict IFS
# (lib/ga-doctor.sh).
#
# BUG (live-reproduced on macOS): the `glass-atrium` launcher runs the whole engine
# under strict-mode IFS=$'\n\t' (glass-atrium:58 — space is NOT a field separator).
# _resolve_sha256_cmd emits the sha tool as the STRING "shasum -a 256"; §8/§11 capture
# it with `read -ra <arr> < <(_resolve_sha256_cmd)`. Under IFS=$'\n\t' that read does
# NOT split on the spaces, so the array holds ONE word "shasum -a 256" → _sha_hex runs
# it as a single command name → "command not found" (rc 127) → EVERY manifest hash
# comparison aborts (357 false manifest-drift warnings live). Linux CI never saw it
# because sha256sum (the CI-resolved tool) has no spaces to be swallowed.
#
# WHY THE EXISTING SUITE IS BLIND: doctor-consumer-install.bats drives run_doctor via
# `bash -c` whose IFS is the DEFAULT $' \t\n' (space IS a separator), so the read splits
# correctly and the bug never shows. This suite deliberately reproduces the launcher's
# strict IFS=$'\n\t' immediately before run_doctor — the only environment the bug fires
# in — and forces the multi-word `shasum -a 256` resolution on every host (a stub shasum
# on PATH) so the regression is NOT Linux-CI-blind.
#
# fail-before/pass-after: pre-fix the strict-IFS read yields a one-word array → _sha_hex
# emits "command not found" and §8 aborts before its verdict line; post-fix the
# `IFS=$' \t' read` prefix splits the words → the stub runs → §8 reconciles clean.
#
# Run via: bats test/doctor-sha-ifs-split.bats
# Requires: bats >= 1.5.0, jq, bash 3.2+ (no host sha tool needed — a stub is supplied)
#
# Hermetic strategy (mirrors doctor-consumer-install.bats): a throwaway sandbox GA_ROOT
# with NO .git (consumer-install §8 path), a stub `shasum` on PATH that REQUIRES the
# multi-word `-a 256` invocation, and a manifest whose recorded hashes equal the stub's
# deterministic digest so a correctly-split call reconciles clean. No real ~/.claude,
# host sha tool, or launchd job is touched.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

# Deterministic digest the stub emits and the manifest records — a single SoT (passed to
# the stub via env, referenced in the manifest writer) so the two never drift out of sync.
FIXED_HASH="0000000000000000000000000000000000000000000000000000000000000000"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"

  SANDBOX="$(mktemp -d -t ga-doctor-sha-ifs-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga" # sandbox GA_ROOT (consumer install root — NO .git)
  TARGET="${SANDBOX}/target" # throwaway ~/.claude target
  MANIFEST="${SANDBOX}/manifest.json"
  STUB_BIN="${SANDBOX}/stub-bin" # holds the multi-arg-requiring `shasum` stub
  mkdir -p -- "${TARGET}" "${STUB_BIN}"

  export GA_LIB_DIR="${GA}/scripts/lib"
  export GA_TARGET_HOME="${TARGET}"
  export GA_MANIFEST="${MANIFEST}"

  # farmed (symlinked) surfaces; §7 finds these deployed.
  FARMED=(
    "agents/dev-a.md"
    "skills/skill-a/SKILL.md"
    "rules/glass-atrium/rule-a.md"
  )
  # install-internal surfaces §7 skips but §8 hash-reconciles — the sha-drift surface.
  INTERNAL=(
    "lib/ga-core.sh"
    "monitor/package.json"
    "hooks/hook-a.sh"
    "glass-atrium"
  )

  seed_stub_shasum
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# A `shasum` stub that HARD-REQUIRES the split multi-word form `shasum -a 256 -- <file>`.
# Pre-fix, the strict-IFS read collapses the resolver output into one argv word, so the
# executed command name is literally "shasum -a 256" and this stub is never found
# (command-not-found). Post-fix the words split and the stub runs with `-a 256` present.
# It delegates NOTHING — it echoes the shared FIXED_HASH (env GA_STUB_HASH) in real
# shasum's `<hash>  <file>` stdout shape so _sha_hex's ${out%% *} yields the digest.
seed_stub_shasum() {
  cat >"${STUB_BIN}/shasum" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" != "-a" || "${2:-}" != "256" ]]; then
  printf 'stub-shasum: require multi-arg "-a 256", got: [%s]\n' "$*" >&2
  exit 64
fi
printf '%s  -\n' "${GA_STUB_HASH:?stub hash env missing}"
SH
  chmod +x "${STUB_BIN}/shasum"
}

# Seed a GA_ROOT source file for <rel> with deterministic content.
seed_src() {
  local rel="$1"
  mkdir -p -- "$(dirname -- "${GA_SANDBOX}/${rel}")"
  printf 'ga-source: %s\n' "${rel}" >"${GA_SANDBOX}/${rel}"
}

# Symlink one farmed <rel> into the target (TARGET/rel -> GA_ROOT/rel).
deploy_link() {
  local rel="$1"
  mkdir -p -- "$(dirname -- "${TARGET}/${rel}")"
  ln -s "${GA_SANDBOX}/${rel}" "${TARGET}/${rel}"
}

# Write {version, files, hashes} with the shared FIXED_HASH for every entry — so a
# correctly-split sha call (stub → FIXED_HASH) reconciles clean against the manifest.
write_manifest_fixed() {
  local rel files_json hashes_json
  files_json="$(printf '%s\n' "$@" | jq -R . | jq -s .)"
  hashes_json="$(
    for rel in "$@"; do
      printf '%s\t%s\n' "${rel}" "${FIXED_HASH}"
    done | jq -R 'split("\t") | {(.[0]): .[1]}' | jq -s 'add // {}'
  )"
  jq -n --arg ver "1.0.1" --argjson files "${files_json}" --argjson hashes "${hashes_json}" \
    '{version:$ver, files:$files, hashes:$hashes}' >"${MANIFEST}"
}

# Seed sources, deploy the farmed symlinks, and write the matching manifest.
seed_fixture() {
  local rel
  for rel in "${FARMED[@]}" "${INTERNAL[@]}"; do
    seed_src "${rel}"
  done
  for rel in "${FARMED[@]}"; do
    deploy_link "${rel}"
  done
  write_manifest_fixed "${FARMED[@]}" "${INTERNAL[@]}"
}

# Run the REAL run_doctor against the sandbox, reproducing the launcher's strict
# IFS=$'\n\t' immediately before the call — the exact field-splitting under which the
# sha resolver output "shasum -a 256" must still split into separate argv words. The
# stub shasum is prepended to PATH so _resolve_sha256_cmd resolves the multi-word form
# on every host. printf -v builds IFS without the nested single-quote pain of an inline
# IFS=$'\n\t' literal inside the single-quoted bash -c body.
run_doctor_strict_ifs() {
  run env PATH="${STUB_BIN}:${PATH}" GA_STUB_HASH="${FIXED_HASH}" \
    GA_LIB_DIR="${GA_LIB_DIR}" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      printf -v IFS "\n\t"
      run_doctor
    ' _ "${GA}" "${GA_SANDBOX}"
}

# === §8 sha reconciliation survives the launcher's strict IFS ==================

@test "§8 splits the sha command words under strict IFS -> reconciles clean, no command-not-found" {
  seed_fixture
  # precondition: consumer install — no .git at the GA root (drives the §8 sha path)
  [[ ! -e "${GA_SANDBOX}/.git" ]]

  run_doctor_strict_ifs

  # POST-FIX: the split words invoke the stub with `-a 256` -> a digest is produced and
  # §8's git-independent reconciliation matches. PRE-FIX this line never appears (the
  # single-word command aborts §8 before its verdict).
  [[ "${output}" == *"ok   : manifest matches on-disk hashes (git-independent consumer-install reconciliation)"* ]] || return 1
  # PRE-FIX symptom is ABSENT: the one-word "shasum -a 256" is never run as a bad command.
  [[ "${output}" != *"command not found"* ]] || return 1
  # no false drift — a correctly-split digest equals the recorded hash for every entry.
  [[ "${output}" != *"manifest DRIFT"* ]] || return 1
}
