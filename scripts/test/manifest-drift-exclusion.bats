#!/usr/bin/env bats
# manifest drift-exclusion suite — lib/ga-doctor.sh §8 (manifest_hash_drift) against the
# merge-claim predicate scripts/lib/apply-spine.sh::spine_is_merge_claimed_path.
#
# The drift report compares live content to manifest.hashes for every row the merge does NOT
# claim, and hands every claimed row whose hash moved to the vendor-owned-part comparison. The rows
# it claims carry live content by design — daemon-written EDITABLE regions and an operator `model:`
# pin in an agent body, a union of vendor and live rows in each roster file — so a whole-file hash
# alone cannot tell that evolution from tamper. Which evolution reads clean against the base@install
# anchor: test/harness-integrity.bats.
#
# The routing gate is the test named "the hash comparison and the claim predicate agree on every
# manifest row" — named rather than numbered, because an ordinal renumbers on the next insertion.
# It iterates the manifest and drives BOTH sides per row (mutate → which comparison reported it,
# ask the predicate → is it claimed), so a family added to one side and not the other fails here.
# Neither implementation is inspected.
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
# shellcheck source-path=SCRIPTDIR source=../lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

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
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
  if ga_guard_path "${PRISTINE:-}"; then rm -rf -- "${PRISTINE:?}"; fi
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
  ATRIUM_UPDATE_STATE_DIR="${WORK}.state" bash -c '
    set -Eeuo pipefail
    log() { printf "%s\n" "$*" >&2; }
    GA_ROOT="$1"; MANIFEST="$2"
    source "$3"
    manifest_hash_drift shasum -a 256
  ' _ "${WORK}" "${MANIFEST}" "${REAL_DOCTOR}" 2>/dev/null
}

# Echo the doctor's report lines (stderr) for the current fixture tree.
doctor_drift_detail() {
  ATRIUM_UPDATE_STATE_DIR="${WORK}.state" bash -c '
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

@test "a pristine tree reports zero drift" {
  [[ "$(doctor_drift_count)" -eq 0 ]] || return 1
}

@test "an altered non-agent file is still reported" {
  printf 'tampered rule line\n' >>"${WORK}/rules/beta.md"
  [[ "$(doctor_drift_count)" -eq 1 ]] || return 1
  [[ "$(doctor_drift_detail)" == *"content hash mismatch: rules/beta.md"* ]] || return 1
}

@test "an excluded row that is MISSING is still reported" {
  if ga_guard_path "${WORK}"; then rm -f -- "${WORK:?}/agents/evolvable.md"; fi
  [[ "$(doctor_drift_count)" -eq 1 ]] || return 1
  [[ "$(doctor_drift_detail)" == *"listed file missing on disk: agents/evolvable.md"* ]] || return 1
}

# The split scope-rule channel's claim partition, asserted BY NAME. The routing gate proves the doctor
# and the predicate agree with each other; it cannot prove that a given family sits on the
# side it was designed for, because it derives both verdicts from the same predicate.
#
# Why the partition is load-bearing in both directions:
#   * inject-scope-rules.sh is one of the four merge-claimed roster paths, and
#     autoagent/lib/roster_merge.py::_get_shell_slots raises ShapeError when a claimed shell file
#     declares no space-padded `readonly NAME=" … "` array. The updater DECLINES that path on a
#     ShapeError and silently keeps the LIVE file — so the deploy would ship the new part wrappers
#     and leave slot 1 at the old revision, which is the failure this row exists to make loud.
#   * the part wrappers and the shared library must stay UNCLAIMED: they carry no roster, so a
#     claim would route them through a merge that has nothing to merge, and it would move them out
#     of the deterministic hash-verified sync that is what actually guarantees they land.

@test "split-channel claim partition: slot 1 is claimed, the wrappers and library are not" {
  local slots n rel
  claim_verdict "hooks/inject-scope-rules.sh" || {
    echo "hooks/inject-scope-rules.sh is NOT merge-claimed — roster_merge no longer owns slot 1" >&2
    return 1
  }
  slots="$(python3 -c 'import sys;sys.path.insert(0,sys.argv[1]);import inject_chunk;print(inject_chunk.CHUNK_SLOTS)' "${GA}/hooks/lib")" || {
    echo "cannot read CHUNK_SLOTS from hooks/lib/inject_chunk.py" >&2
    return 1
  }
  [[ "${slots}" -gt 0 ]] || {
    echo "the core reports no slot count — the wrapper loop below would pass vacuously" >&2
    return 1
  }
  for ((n = 1; n <= slots; n++)); do
    rel="$(printf 'hooks/inject-scope-part-%02d.sh' "${n}")"
    if claim_verdict "${rel}"; then
      echo "${rel} is merge-claimed — a wrapper carries no roster, so the merge has nothing to merge" >&2
      return 1
    fi
  done
  for rel in hooks/lib/inject-chunk.sh hooks/lib/inject_chunk.py; do
    if claim_verdict "${rel}"; then
      echo "${rel} is merge-claimed — the shared library carries no roster" >&2
      return 1
    fi
  done
}

@test "split-channel claim partition: slot 1 still declares a space-padded roster array" {
  # The ShapeError precondition, read from the real file rather than inferred from the claim.
  # roster_merge selects a slot by this exact shape; losing every one of them turns a successful
  # deploy into a silently declined path.
  grep -Eq '^[[:space:]]*readonly [A-Z_]+=" .* "$' "${GA}/hooks/inject-scope-rules.sh" || {
    echo "hooks/inject-scope-rules.sh declares no space-padded roster array — roster_merge would raise ShapeError and the updater would DECLINE the path, keeping the live file" >&2
    return 1
  }
}

@test "the hash comparison and the claim predicate agree on every manifest row" {
  local rel count hashed claimed claimed_rows=0 compared_rows=0
  while IFS= read -r rel; do
    printf 'mutation\n' >>"${WORK}/${rel}"
    count="$(doctor_drift_count)"
    hashed=no
    if [[ "$(doctor_drift_detail)" == *"content hash mismatch: ${rel}"* ]]; then hashed=yes; fi
    cp -p -- "${PRISTINE}/${rel}" "${WORK}/${rel}"
    claimed=no
    if claim_verdict "${rel}"; then claimed=yes; fi
    # every row's mutation is one drift; hashed XOR claimed, per row: a claimed row goes to the
    # vendor-part comparison, an unclaimed one to the hash. Equal verdicts mean the two sides disagree.
    [[ "${count}" == "1" && "${hashed}" != "${claimed}" ]] || {
      echo "${rel}: drift ${count}, hash-compared ${hashed}, claimed ${claimed}"
      return 1
    }
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
