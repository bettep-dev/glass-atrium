#!/usr/bin/env bats
# manifest drift-exclusion suite — lib/ga-doctor.sh §8 (manifest_hash_drift) against the
# merge-claim predicate scripts/lib/apply-spine.sh::spine_is_merge_claimed_path.
#
# The drift report compares live content to manifest.hashes for every row the merge does NOT
# claim, and skips that comparison for every row it does. The rows it claims carry live content
# by design — daemon-written EDITABLE regions and an operator `model:` pin in an agent body, a
# union of vendor and live rows in each roster file — so a whole-file hash reads them as drift
# under a remedy that cannot clear it.
#
# The fourth test is the agreement gate: it iterates the manifest and drives BOTH sides per row
# (mutate → is it reported, ask the predicate → is it claimed), so a family added to one side and
# not the other fails here rather than silently converting a loud false warning into a quiet
# wrong one. Neither implementation is inspected.
#
# Run via: bats scripts/test/manifest-drift-exclusion.bats
# Requires: bats >= 1.5.0, jq, shasum, bash 3.2+
#
# Hermetic: a throwaway tree under a pwd -P temp root is GA_ROOT, so the live ~/.glass-atrium
# tree is never read or written. The doctor lib and the spine lib are sourced from the REAL
# repo — they are the artifacts under test.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_DOCTOR="${GA}/lib/ga-doctor.sh"
REAL_SPINE="${GA}/scripts/lib/apply-spine.sh"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v shasum >/dev/null 2>&1 || skip "shasum required"
  [[ -f "${REAL_DOCTOR}" ]] || skip "ga-doctor.sh not found: ${REAL_DOCTOR}"
  [[ -f "${REAL_SPINE}" ]] || skip "apply-spine.sh not found: ${REAL_SPINE}"

  # pwd -P resolves /var -> /private/var so GA_ROOT matches the paths the test computes.
  WORK="$(cd -- "$(mktemp -d -t driftexcl-bats.XXXXXX)" && pwd -P)"
  MANIFEST="${WORK}/manifest.json"
  PRISTINE="${WORK}.pristine"
  seed_fixture_tree
  write_manifest
  cp -R -- "${WORK}" "${PRISTINE}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
  [[ -n "${PRISTINE:-}" && -d "${PRISTINE}" ]] && rm -rf -- "${PRISTINE}" || true
}

# The manifest's row set: two claimed shapes (a top-level agent body, each roster path) and two
# unclaimed ones (the non-agent charter that lives under agents/, a rule file).
fixture_paths() {
  printf '%s\n' \
    'agent-registry.json' \
    'agents/GLASS_ATRIUM_GLOBAL_RULES.md' \
    'agents/evolvable.md' \
    'hooks/inject-scope-rules.sh' \
    'hooks/lib/styleref-roster.sh' \
    'rules/beta.md' \
    'scoped/scope-dev.md'
}

seed_fixture_tree() {
  mkdir -p "${WORK}/agents" "${WORK}/hooks/lib" "${WORK}/rules" "${WORK}/scoped"
  cat >"${WORK}/agents/evolvable.md" <<'MD'
---
name: evolvable
tools: Read, Write
---

# Evolvable agent

## Goal
<!-- EDITABLE:BEGIN -->
Learned goal line.
<!-- EDITABLE:END -->

Vendor-owned prose the daemon never touches.
MD
  printf '# Agent Global Rules\n\nCharter prose.\n' >"${WORK}/agents/GLASS_ATRIUM_GLOBAL_RULES.md"
  printf '{"agents":[{"name":"vendor-agent"}]}\n' >"${WORK}/agent-registry.json"
  printf '# DEV Scope Rules\n\nVendor rule prose.\n' >"${WORK}/scoped/scope-dev.md"
  printf '#!/usr/bin/env bash\nINJECT_AGENTS=(vendor-agent)\n' >"${WORK}/hooks/inject-scope-rules.sh"
  printf '#!/usr/bin/env bash\nSTYLEREF_AGENTS=(vendor-agent)\n' >"${WORK}/hooks/lib/styleref-roster.sh"
  printf '# rule beta\n' >"${WORK}/rules/beta.md"
}

sha_of() {
  shasum -a 256 -- "$1" | awk '{ print $1 }'
}

# Build the fixture manifest from the on-disk bytes: files[] plus the parallel hashes map, the
# two keys manifest_hash_drift reads.
write_manifest() {
  local rel lines=""
  while IFS= read -r rel; do
    lines="${lines}${rel}	$(sha_of "${WORK}/${rel}")
"
  done < <(fixture_paths)
  printf '%s' "${lines}" | jq -R -s '
    split("\n") | map(select(length > 0) | split("\t"))
    | { version: "0.0.0", files: map(.[0]), hashes: (map({ (.[0]): .[1] }) | add) }
  ' >"${MANIFEST}"
}

# Echo the doctor's drift COUNT over the current fixture tree. Sources the REAL lib with only the
# globals manifest_hash_drift consumes; the lib resolves the spine itself.
doctor_drift_count() {
  bash -c '
    set -Eeuo pipefail
    log() { printf "%s\n" "$*" >&2; }
    GA_ROOT="$1"; MANIFEST="$2"
    source "$3"
    manifest_hash_drift shasum -a 256
  ' _ "${WORK}" "${MANIFEST}" "${REAL_DOCTOR}" 2>/dev/null
}

# Echo the doctor's report lines (stderr) for the current fixture tree.
doctor_drift_detail() {
  bash -c '
    set -Eeuo pipefail
    log() { printf "%s\n" "$*" >&2; }
    GA_ROOT="$1"; MANIFEST="$2"
    source "$3"
    manifest_hash_drift shasum -a 256 >/dev/null
  ' _ "${WORK}" "${MANIFEST}" "${REAL_DOCTOR}" 2>&1
}

# rc 0 when the merge claims the path, rc 1 when it does not — the predicate's own verdict,
# asked of the spine directly.
claim_verdict() {
  bash -c '
    set -Eeuo pipefail
    source "$1"
    spine_is_merge_claimed_path "$2"
  ' _ "${REAL_SPINE}" "$1"
}

# Daemon-shaped evolution: a learned bullet inside the EDITABLE region.
evolve_editable_region() {
  local file="${WORK}/agents/evolvable.md" tmp="${WORK}/agents/evolvable.mut"
  awk '{ print } /^Learned goal line\.$/ { print "- a newly learned bullet" }' \
    "${file}" >"${tmp}"
  mv -f -- "${tmp}" "${file}"
}

# Operator-shaped evolution: the live-only `model:` frontmatter pin.
pin_model_key() {
  local file="${WORK}/agents/evolvable.md" tmp="${WORK}/agents/evolvable.mut"
  awk '{ print } /^tools: Read, Write$/ { print "model: pinned-model-id" }' \
    "${file}" >"${tmp}"
  mv -f -- "${tmp}" "${file}"
}

@test "a pristine tree reports zero drift" {
  [[ "$(doctor_drift_count)" -eq 0 ]] || return 1
}

@test "region content and a live-only frontmatter pin are NOT drift" {
  evolve_editable_region
  pin_model_key
  printf 'live-only roster row\n' >>"${WORK}/hooks/lib/styleref-roster.sh"
  [[ "$(doctor_drift_count)" -eq 0 ]] || return 1
  [[ "$(doctor_drift_detail)" == *"excluded from the content comparison"* ]] || return 1
}

@test "an altered non-agent file is still reported" {
  printf 'tampered rule line\n' >>"${WORK}/rules/beta.md"
  [[ "$(doctor_drift_count)" -eq 1 ]] || return 1
  [[ "$(doctor_drift_detail)" == *"content hash mismatch: rules/beta.md"* ]] || return 1
}

@test "an excluded row that is MISSING is still reported" {
  rm -f -- "${WORK}/agents/evolvable.md"
  [[ "$(doctor_drift_count)" -eq 1 ]] || return 1
  [[ "$(doctor_drift_detail)" == *"listed file missing on disk: agents/evolvable.md"* ]] || return 1
}

@test "the exclusion and the claim predicate agree on every manifest row" {
  local rel reported claimed claimed_rows=0 compared_rows=0
  while IFS= read -r rel; do
    printf 'mutation\n' >>"${WORK}/${rel}"
    reported=no
    if [[ "$(doctor_drift_count)" -eq 1 ]]; then reported=yes; fi
    cp -p -- "${PRISTINE}/${rel}" "${WORK}/${rel}"
    claimed=no
    if claim_verdict "${rel}"; then claimed=yes; fi
    # reported XOR claimed, per row: a claimed row is excluded from the comparison, an unclaimed
    # one is compared. Equal verdicts mean the two sides disagree about this family.
    [[ "${reported}" != "${claimed}" ]] || return 1
    if [[ "${claimed}" == "yes" ]]; then
      claimed_rows=$((claimed_rows + 1))
    else
      compared_rows=$((compared_rows + 1))
    fi
    # the restore must land, or every later row is judged against a dirty tree.
    [[ "$(doctor_drift_count)" -eq 0 ]] || return 1
  done < <(jq -r '.files[]' "${MANIFEST}")
  # both arms must have been exercised, or an agreement over one arm proves nothing.
  [[ "${claimed_rows}" -gt 0 ]] || return 1
  [[ "${compared_rows}" -gt 0 ]] || return 1
}
