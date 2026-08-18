#!/usr/bin/env bats
# update-charter-sync-exemption.bats — the charter's CHANGED-FILE sync carve-out.
#
# THE CONDITION: agents/GLASS_ATRIUM_GLOBAL_RULES.md matched the compiled
# sensitive-refusal tuple, so the updater — the sole live write seam — partitioned
# it out of every apply. No deploy path could reach the file, while ga-doctor
# advertised that same updater as the remedy for the drift the refusal caused.
#
# THE CONTRACT NOW UNDER TEST — the carve-out is ONE cell of a 4-consumer grid:
#   * the CHANGED-FILE partition (preview + apply) ALLOWS the charter;
#   * the VENDOR-REMOVAL sweep still REFUSES it — a vendor drop is reported, never
#     auto-Trashed, and relaxing that partition would convert a report into a
#     deletion;
#   * a retained sensitive entry (scoped/scope-security.md) refuses on BOTH;
#   * the SYMLINK row (rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md) is NOT
#     exempt: the spine stages with a dereferencing `cp -p` and commits by rename,
#     so routing it through the byte-swap would replace the link with a regular
#     file. Syncing the real file alone clears BOTH manifest rows, because the
#     link resolves through it — proven end-to-end below, not argued.
# The daemon-tier + agent-merge halves of the grid are pinned python-side in
# autoagent/test/test_sensitive_patterns.py (they never traverse the shell).
#
# STRATEGY mirrors the established suite pattern: update.sh is SOURCED (update_main
# is skipped when sourced) inside a per-test mktemp sandbox with GA_ROOT and the
# state dirs redirected into it; the end-to-end test drives the real entry point
# through the ATRIUM_UPDATE_SRC_DIR seam with the confirm injected. No ~/.claude or
# ~/.glass-atrium mutation, and Trash is redirected via ATRIUM_UPDATE_TRASH_DIR.
#
# Every assertion is gated `|| return 1` inside a helper, or asserted directly by
# bats in the test body (the final command decides the verdict).
#
# Run via: bats scripts/test/update-charter-sync-exemption.bats
# Requires: bats 1.5+, jq, python3, diff, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
export SKILL="${GA}/scripts/update.sh"
export REAL_LIB_ROOT="${GA}"

CHARTER="agents/GLASS_ATRIUM_GLOBAL_RULES.md"
CHARTER_LINK="rules/glass-atrium/GLASS_ATRIUM_GLOBAL_RULES.md"
RETAINED="scoped/scope-security.md"

setup() {
  [[ -f "${SKILL}" ]] || skip "update.sh not found: ${SKILL}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v diff >/dev/null 2>&1 || skip "diff required"
  WORK="$(cd -- "$(mktemp -d -t ga-charter-bats.XXXXXX)" && pwd -P)"
  INSTALL="${WORK}/install"
  NEWSRC="${WORK}/newsrc"
  STATE="${WORK}/state"
  mkdir -p "${INSTALL}" "${NEWSRC}" "${STATE}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    sha256sum -- "$1" | awk '{print $1}'
  fi
}

seed_file() {
  local root="$1" rel="$2" content="$3"
  mkdir -p -- "$(dirname -- "${root}/${rel}")"
  printf '%s' "${content}" >"${root}/${rel}"
}

# Seed the charter pair as the live tree carries it: a real file plus the symlink
# row pointing at it. Args: $1 = root · $2 = charter content.
seed_charter_pair() {
  local root="$1" content="$2"
  seed_file "${root}" "${CHARTER}" "${content}"
  mkdir -p -- "${root}/rules/glass-atrium"
  ln -sfn "../../agents/GLASS_ATRIUM_GLOBAL_RULES.md" "${root}/${CHARTER_LINK}"
}

# Manifest with a modes map (644 for every row — the shipped manifest records the
# symlink row at 644 too, which is what makes the mode reconciler's symlink skip
# load-bearing). Hashes are read from NEWSRC, following links like the generator.
write_manifest_with_modes() {
  local out="$1"
  shift
  local p hashes="" files="" modes=""
  for p in "$@"; do
    files="${files}$(printf '%s' "${p}" | jq -R .),"
    hashes="${hashes}$(printf '%s' "${p}" | jq -R .):$(sha256_of "${NEWSRC}/${p}" | jq -R .),"
    modes="${modes}$(printf '%s' "${p}" | jq -R .):\"644\","
  done
  printf '{"version":"1.0.0","files":[%s],"hashes":{%s},"modes":{%s}}\n' \
    "${files%,}" "${hashes%,}" "${modes%,}" >"${out}"
}

load_skill() {
  set -Eeuo pipefail
  IFS=$'\n\t'
  export GA_ROOT="${INSTALL}"
  export AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports"
  export ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state"
  export ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state"
  export ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py"
  # shellcheck source=/dev/null
  source "${SKILL}"
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/atrium-config.sh"
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/update-pause-flag.sh"
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/apply-spine.sh"
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/apply-gate.sh"
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/sensitive-refusal.sh"
  # shellcheck source=/dev/null
  source "${REAL_LIB_ROOT}/scripts/lib/apply-lock.sh"
  trap - ERR
}

@test "changed-file partition ALLOWS the charter and still refuses the symlink row + a retained entry" {
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    printf "%s\n%s\n%s\n" \
      "'"${CHARTER}"'" "'"${CHARTER_LINK}"'" "'"${RETAINED}"'" \
      | update_partition_sensitive_sync "'"${WORK}"'/clean" "'"${WORK}"'/sens"
    echo "CLEAN:"; cat "'"${WORK}"'/clean"
    echo "SENS:"; cat "'"${WORK}"'/sens"
  ' 2>/dev/null
  [ "$status" -eq 0 ]
  # the real charter path is the ONLY exemption
  [[ "$(sed -n '/^CLEAN:/,/^SENS:/p' <<<"$output" | grep -c "${CHARTER}$")" -eq 1 ]]
  [[ "$(sed -n '/^SENS:/,$p' <<<"$output" | grep -c "${CHARTER_LINK}$")" -eq 1 ]]
  [[ "$(sed -n '/^SENS:/,$p' <<<"$output" | grep -c "${RETAINED}$")" -eq 1 ]]
}

@test "REGRESSION: the strict partition still refuses the charter (removal sweep must not relax)" {
  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    printf "%s\n" "'"${CHARTER}"'" \
      | update_partition_sensitive "'"${WORK}"'/clean" "'"${WORK}"'/sens"
    echo "CLEAN:"; cat "'"${WORK}"'/clean"
    echo "SENS:"; cat "'"${WORK}"'/sens"
  ' 2>/dev/null
  [ "$status" -eq 0 ]
  [[ "$(sed -n '/^SENS:/,$p' <<<"$output" | grep -c "${CHARTER}$")" -eq 1 ]]
  [[ "$(sed -n '/^CLEAN:/,/^SENS:/p' <<<"$output" | grep -c "${CHARTER}$")" -eq 0 ]]
}

@test "REGRESSION: a vendor DROP of the charter is reported, never Trashed" {
  # baseline ships the charter, the new release drops it — the sweep's provenance
  # check clears (live content == baseline hash), so only the sensitive partition
  # stands between the file and the Trash sink.
  seed_file "${NEWSRC}" "${CHARTER}" "charter body"
  seed_file "${NEWSRC}" "scripts/tool.sh" "tool"
  write_manifest_with_modes "${WORK}/baseline.json" "${CHARTER}" "scripts/tool.sh"
  write_manifest_with_modes "${WORK}/new.json" "scripts/tool.sh"
  seed_file "${INSTALL}" "${CHARTER}" "charter body"
  seed_file "${INSTALL}" "scripts/tool.sh" "tool"

  run bash -c '
    '"$(declare -f load_skill)"'
    INSTALL="'"${INSTALL}"'"; STATE="'"${STATE}"'"
    load_skill
    export ATRIUM_UPDATE_TRASH_DIR="'"${WORK}"'/trash"
    mkdir -p "${ATRIUM_UPDATE_TRASH_DIR}"
    # CONFIRM INJECTED ON PURPOSE: without it the gate declines for want of a tty
    # and the charter survives for a reason that has nothing to do with the
    # partition — the test would pass even with the refusal removed. With a "y"
    # queued, the ONLY thing standing between the charter and the Trash sink is
    # the strict partition, which is what this test exists to pin.
    export ATRIUM_UPDATE_CONFIRM_ANSWER="y"
    update_sweep_removed_files "'"${WORK}"'/baseline.json" "'"${WORK}"'/new.json" "'"${INSTALL}"'"
  ' 2>/dev/null
  [ "$status" -eq 0 ]
  [[ "$output" == *"sensitive vendor-drop, NOT removed"* ]]
  [[ "$output" == *"GLASS_ATRIUM_GLOBAL_RULES.md"* ]]
  # the file survived and nothing reached the Trash sink
  [ -f "${INSTALL}/${CHARTER}" ]
  [[ -z "$(find "${WORK}/trash" -type f 2>/dev/null)" ]]
}

@test "C5: a full run syncs the charter, leaves the symlink a symlink, and clears BOTH manifest rows" {
  seed_charter_pair "${INSTALL}" "old charter"
  seed_charter_pair "${NEWSRC}" "new charter"
  write_manifest_with_modes "${WORK}/manifest.json" "${CHARTER}" "${CHARTER_LINK}"

  # precondition — the live tree really carries the link shape the release does
  [ -L "${INSTALL}/${CHARTER_LINK}" ]

  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
    ATRIUM_PAUSE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_SENSITIVE_HELPER="${REAL_LIB_ROOT}/autoagent/lib/sensitive_patterns.py" \
    ATRIUM_UPDATE_TRASH_DIR="${WORK}/trash" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_CONFIRM_ANSWER="y" \
    bash "${SKILL}"
  [ "$status" -eq 0 ]

  # the real file was replaced through the sync
  [[ "$(cat "${INSTALL}/${CHARTER}")" == "new charter" ]]
  # the symlink row was NOT byte-swapped — still a link, still resolving
  [ -L "${INSTALL}/${CHARTER_LINK}" ]
  [[ "$(cat "${INSTALL}/${CHARTER_LINK}")" == "new charter" ]]
  # and BOTH manifest rows now reconcile: syncing the real file alone clears the
  # drift the symlink row reported, which is why exempting the link is unnecessary
  [[ "$(sha256_of "${INSTALL}/${CHARTER}")" == "$(jq -r --arg p "${CHARTER}" '.hashes[$p]' "${WORK}/manifest.json")" ]]
  [[ "$(sha256_of "${INSTALL}/${CHARTER_LINK}")" == "$(jq -r --arg p "${CHARTER_LINK}" '.hashes[$p]' "${WORK}/manifest.json")" ]]
}
