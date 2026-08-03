#!/usr/bin/env bats
# vendor-region digest suite — the SHARED-FIXTURE agreement gate for the two sides
# of manifest.vendor_hashes:
#   PRODUCER  scripts/generate-manifest.sh   (emits the map)
#   CONSUMER  lib/ga-doctor.sh §8            (manifest_hash_drift reconciles it)
# Both read the region boundary from scripts/lib/vendor-digest.sh, and every test
# below drives BOTH sides over ONE fixture tree, so a future edit that moves a
# region edge on one side fails here instead of silently converting a loud false
# warning into a quiet wrong one.
#
# Fixture tree (one manifest, then per-test mutations of the SAME bodies):
#   agents/evolvable.md   frontmatter + two EDITABLE regions + vendor prose
#   agents/plain.md       agent body with NO EDITABLE region at all
#   agents/unpaired.md    body ending on an UNPAIRED BEGIN (pairing edge case)
#   rules/marked.md       NON-agent file that CONTAINS the marker strings
#
# Polarities pinned: sanctioned evolution (EDITABLE content, `model:` pin) is NOT
# drift · altered vendor prose IS drift · a marker line is vendor structure · a
# non-agent file keeps the whole-file verdict · a manifest with no vendor_hashes
# degrades to the pre-vendor_hashes behaviour without crashing.
#
# Run via: bats scripts/test/vendor-region-digest.bats
# Requires: bats >= 1.5.0, git, jq, shasum (macOS/CI) or sha256sum, bash 3.2+
#
# Hermetic: a throwaway git repo under a pwd -P temp root holding COPIES of the
# generator + the leaf, so the script's BASH_SOURCE-derived GA_ROOT resolves to the
# sandbox and the live ~/.glass-atrium tree is never read or written.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/scripts/generate-manifest.sh"
REAL_VENDOR_LIB="${GA}/scripts/lib/vendor-digest.sh"
REAL_DOCTOR="${GA}/lib/ga-doctor.sh"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || skip "shasum/sha256sum required"
  [[ -f "${REAL_SCRIPT}" ]] || skip "generate-manifest.sh not found: ${REAL_SCRIPT}"
  [[ -f "${REAL_VENDOR_LIB}" ]] || skip "vendor-digest.sh not found: ${REAL_VENDOR_LIB}"
  [[ -f "${REAL_DOCTOR}" ]] || skip "ga-doctor.sh not found: ${REAL_DOCTOR}"

  WORK="$(cd -- "$(mktemp -d -t vendordigest-bats.XXXXXX)" && pwd -P)"
  SCRIPT="${WORK}/scripts/generate-manifest.sh"
  MANIFEST="${WORK}/manifest.json"
  mkdir -p "${WORK}/scripts/lib" "${WORK}/agents" "${WORK}/rules"
  cp "${REAL_SCRIPT}" "${SCRIPT}"
  cp "${REAL_VENDOR_LIB}" "${WORK}/scripts/lib/vendor-digest.sh"

  seed_fixture_tree
  printf '{"_doc_settings_json":"sandbox settings.json contract doc","files":[],"hashes":{}}\n' \
    >"${MANIFEST}"
  git -C "${WORK}" init -q
  git -C "${WORK}" config user.email bats@test.local
  git -C "${WORK}" config user.name bats
  git -C "${WORK}" add -A
  git -C "${WORK}" commit -qm init
  run "${SCRIPT}"
  [[ "${status}" -eq 0 ]]
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# The shared fixture bodies. Written by setup (the manifest baseline) and re-written
# verbatim by each mutation helper, so producer and consumer always see the same
# starting bytes.
seed_fixture_tree() {
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

## Guardrails
<!-- EDITABLE:BEGIN -->
- learned guardrail
<!-- EDITABLE:END -->

Closing vendor prose.
MD
  cat >"${WORK}/agents/plain.md" <<'MD'
---
name: plain
tools: Read
---

# Plain agent

Vendor prose with no editable region at all.
MD
  # An agent whose body already carries an UNPAIRED trailing BEGIN at manifest
  # time — the shape where a running in-region flag would swallow every following
  # line into the "evolvable" bucket and go blind to tampering there.
  cat >"${WORK}/agents/unpaired.md" <<'MD'
---
name: unpaired
tools: Read
---

# Unpaired agent

<!-- EDITABLE:BEGIN -->
Vendor prose after an unpaired BEGIN.
MD
  # NON-agent file that CONTAINS the marker strings (a rule doc documenting the
  # mechanism, the shape that would become blind under a marker-only scope).
  cat >"${WORK}/rules/marked.md" <<'MD'
# Marker documentation

<!-- EDITABLE:BEGIN -->
documented sample content
<!-- EDITABLE:END -->
MD
}

# Echo the doctor's drift COUNT over the current sandbox tree (stderr detail is
# dropped here; the lines assertion below captures it separately). Sources the REAL
# lib/ga-doctor.sh with only the globals manifest_hash_drift consumes.
doctor_drift_count() {
  bash -c '
    set -Eeuo pipefail
    log() { printf "%s\n" "$*" >&2; }
    GA_ROOT="$1"; MANIFEST="$2"
    source "$3"
    manifest_hash_drift shasum -a 256
  ' _ "${WORK}" "${MANIFEST}" "${REAL_DOCTOR}" 2>/dev/null
}

# Echo the doctor's per-file warn lines (stderr) for the current sandbox tree.
doctor_drift_detail() {
  bash -c '
    set -Eeuo pipefail
    log() { printf "%s\n" "$*" >&2; }
    GA_ROOT="$1"; MANIFEST="$2"
    source "$3"
    manifest_hash_drift shasum -a 256 >/dev/null
  ' _ "${WORK}" "${MANIFEST}" "${REAL_DOCTOR}" 2>&1
}

# --- producer -----------------------------------------------------------------

@test "producer: vendor_hashes covers exactly the agents/*.md subset of files[]" {
  [[ "$(jq -r '.vendor_hashes | keys | join(",")' "${MANIFEST}")" == "agents/evolvable.md,agents/plain.md,agents/unpaired.md" ]]
  # subset invariant — every key is a files[] member.
  [[ "$(jq -r '(.vendor_hashes | keys) - .files | length' "${MANIFEST}")" -eq 0 ]]
}

@test "producer: a vendor digest differs from the whole-file hash only where a region exists" {
  local whole vendor
  whole="$(jq -r '.hashes["agents/evolvable.md"]' "${MANIFEST}")"
  vendor="$(jq -r '.vendor_hashes["agents/evolvable.md"]' "${MANIFEST}")"
  [[ "${whole}" != "${vendor}" ]]
  # the region-less agent has no in-region content and no live-only pin, so both
  # digests hash the same line set.
  [[ "$(jq -r '.hashes["agents/plain.md"]' "${MANIFEST}")" == "$(jq -r '.vendor_hashes["agents/plain.md"]' "${MANIFEST}")" ]]
}

@test "producer: --check flags vendor-region drift and stays clean on EDITABLE-only drift" {
  # EDITABLE-only change: the whole-file hash gate still fires (the source tree is
  # deliberately STRICT — the hash IS the regeneration trigger), but the vendor gate
  # must NOT, which is what separates the two signals.
  evolve_editable_region
  run "${SCRIPT}" --check
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"HASH mismatches"* ]]
  [[ "${output}" != *"VENDOR-REGION mismatches"* ]]

  seed_fixture_tree
  alter_vendor_prose
  run "${SCRIPT}" --check
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"VENDOR-REGION mismatches"* ]]
  [[ "${output}" == *"agents/evolvable.md"* ]]
}

# --- consumer (doctor §8) ------------------------------------------------------

@test "consumer: a pristine tree reports zero drift" {
  [[ "$(doctor_drift_count)" -eq 0 ]]
}

@test "consumer: EDITABLE-region evolution is NOT drift" {
  evolve_editable_region
  [[ "$(doctor_drift_count)" -eq 0 ]]
  [[ "$(doctor_drift_detail)" == *"designed local evolution, not drift"* ]]
}

@test "consumer: a live-only model: frontmatter pin is NOT drift" {
  pin_model_key
  [[ "$(doctor_drift_count)" -eq 0 ]]
}

@test "consumer: a model: pin PLUS region evolution together are NOT drift" {
  pin_model_key
  evolve_editable_region
  [[ "$(doctor_drift_count)" -eq 0 ]]
}

@test "consumer: a one-character change in vendor prose IS drift" {
  alter_vendor_prose
  [[ "$(doctor_drift_count)" -eq 1 ]]
  [[ "$(doctor_drift_detail)" == *"vendor-owned content altered outside the EDITABLE regions: agents/evolvable.md"* ]]
}

@test "consumer: stripping the FINAL newline IS drift" {
  # The one byte-class a record-rebuilt stream cannot see: `awk print` appends ORS
  # to EVERY record, so a body with its trailing newline and the same body without
  # it emit byte-identical streams unless the emitter carries the input's
  # trailing-newline state. The whole-file hash catches this shape, so a vendor
  # digest that did not would be the single hole in "any change to vendor-owned
  # content is drift".
  strip_final_newline "${WORK}/agents/evolvable.md"
  [[ "$(doctor_drift_count)" -eq 1 ]]
  [[ "$(doctor_drift_detail)" == *"vendor-owned content altered outside the EDITABLE regions: agents/evolvable.md"* ]]
}

@test "consumer: a marker line is vendor structure — deleting one IS drift" {
  # The marker pair is the boundary itself: dropping an END would otherwise let a
  # single unpaired BEGIN swallow the rest of the file's vendor prose.
  grep -v 'EDITABLE:END' "${WORK}/agents/evolvable.md" >"${WORK}/agents/evolvable.mut"
  mv -f "${WORK}/agents/evolvable.mut" "${WORK}/agents/evolvable.md"
  [[ "$(doctor_drift_count)" -ge 1 ]]
}

@test "consumer: an unpaired trailing BEGIN opens NO region — its tail is still vendor-owned" {
  # Region pairing mirrors daemon_cycle._editable_spans, which yields a span only
  # for a BEGIN that actually closes. A running in-region flag would instead treat
  # everything after this file's unpaired BEGIN as evolvable and never report the
  # tamper below — swapping the false warning for real blindness.
  substitute_line "${WORK}/agents/unpaired.md" \
    "Vendor prose after an unpaired BEGIN." "Vendor prose after an unpaired BEGIN!"
  [[ "$(doctor_drift_count)" -eq 1 ]]
  [[ "$(doctor_drift_detail)" == *"vendor-owned content altered outside the EDITABLE regions: agents/unpaired.md"* ]]
}

@test "consumer: a model: pin in the BODY (outside the frontmatter) IS drift" {
  # The live-only key is tolerated only inside the frontmatter span — a body line
  # that merely starts with `model:` is vendor prose.
  printf 'model: smuggled-into-the-body\n' >>"${WORK}/agents/evolvable.md"
  [[ "$(doctor_drift_count)" -eq 1 ]]
}

@test "consumer: an agent with NO editable region still drifts on any prose change" {
  printf 'appended vendor line\n' >>"${WORK}/agents/plain.md"
  [[ "$(doctor_drift_count)" -eq 1 ]]
}

@test "consumer: a NON-agent file carrying marker strings keeps the whole-file verdict" {
  # rules/marked.md has no vendor_hashes entry, so an edit BETWEEN its markers —
  # invisible to a vendor digest — must still read as drift (no blindness outside agents/).
  substitute_line "${WORK}/rules/marked.md" "documented sample content" "tampered sample content"
  [[ "$(doctor_drift_count)" -eq 1 ]]
  [[ "$(doctor_drift_detail)" == *"content hash mismatch: rules/marked.md"* ]]
}

@test "consumer: a manifest WITHOUT vendor_hashes falls back to the whole-file verdict" {
  # Backward compatibility: an older/foreign manifest must not crash the doctor —
  # it degrades to exactly the pre-vendor_hashes behaviour (EDITABLE evolution reads
  # as drift again), never to a skipped gate.
  local stripped="${WORK}/manifest.novendor.json"
  jq 'del(.vendor_hashes)' "${MANIFEST}" >"${stripped}"
  mv -f "${stripped}" "${MANIFEST}"
  evolve_editable_region
  [[ "$(doctor_drift_count)" -eq 1 ]]
  [[ "$(doctor_drift_detail)" == *"content hash mismatch: agents/evolvable.md"* ]]
}

# --- producer/consumer agreement ----------------------------------------------

@test "agreement: the doctor recomputes byte-identical digests to the ones the generator emitted" {
  local rel recomputed recorded
  for rel in agents/evolvable.md agents/plain.md agents/unpaired.md; do
    recorded="$(jq -r --arg p "${rel}" '.vendor_hashes[$p]' "${MANIFEST}")"
    recomputed="$(
      bash -c '
        set -Eeuo pipefail
        source "$1"
        vendor_digest_of "$2" shasum -a 256
      ' _ "${WORK}/scripts/lib/vendor-digest.sh" "${WORK}/${rel}"
    )"
    [[ "${recorded}" == "${recomputed}" ]]
  done
}

# --- fixture mutations (shared by both sides) ---------------------------------

# Replace the first line of file $1 that equals $2 with lines $3 (and $4 when given).
# awk + rename, so the suite needs no `sed -i` dialect branch and no perl.
substitute_line() {
  local file="$1" old="$2" first="$3" second="${4:-}" tmp="$1.mut"
  awk -v old="${old}" -v first="${first}" -v second="${second}" '
    !hit && $0 == old {
      print first
      if (second != "") { print second }
      hit = 1
      next
    }
    { print }
  ' "${file}" >"${tmp}"
  mv -f "${tmp}" "${file}"
}

# Daemon-shaped evolution: a learned bullet INSIDE the first region.
evolve_editable_region() {
  substitute_line "${WORK}/agents/evolvable.md" \
    "Learned goal line." "Learned goal line." "- a newly learned bullet"
}

# Operator-shaped evolution: the live-only `model:` frontmatter pin.
pin_model_key() {
  substitute_line "${WORK}/agents/evolvable.md" \
    "tools: Read, Write" "tools: Read, Write" "model: pinned-model-id"
}

# Tampering: drop the file's FINAL byte — its trailing newline — leaving every
# other byte untouched. head -c on the size-1 prefix (not `$(cat)`, which would
# strip a whole run of trailing newlines) so exactly one terminator disappears.
strip_final_newline() {
  local file="$1" tmp="$1.mut"
  head -c "$(($(wc -c <"${file}") - 1))" <"${file}" >"${tmp}"
  mv -f "${tmp}" "${file}"
}

# Tampering: one character of vendor-owned prose, outside every region.
alter_vendor_prose() {
  substitute_line "${WORK}/agents/evolvable.md" \
    "Closing vendor prose." "Closing vendor prosE."
}
