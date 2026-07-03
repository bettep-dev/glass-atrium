#!/usr/bin/env bats
# apply-gate.sh suite — pins the E3 T12 foreground diff/confirm gate contract:
#   * gate_render_diff           — per-file unified diff preview; new file vs
#                                  /dev/null; loud-fail on a missing proposed file
#   * gate_build_nonagent_records — spine_find_changed_files → TSV record bridge
#   * gate_confirm_changes       — render-all + confirm; rc 0 confirm / 1 decline
#                                  / 2 empty; declines on empty / non-yes answers
#   * gate_apply_confirmed       — structural zero-write-on-decline (the callback
#                                  is invoked ONLY on explicit confirmation),
#                                  covering BOTH the non-agent sync AND the agent
#                                  EDITABLE-region merge via the same gate
#
# Run via: bats scripts/test/apply-gate.bats
# Requires: bats >= 1.5.0, diff
#
# Hermetic strategy: every test runs inside a per-test mktemp sandbox. The
# confirmation answer is injected via ATRIUM_UPDATE_CONFIRM_ANSWER (passed as a
# positional and exported inside the sourced subshell) so /dev/tty is never read
# — the gate's only test/non-interactive seam. Pipelines run in a `bash -c`
# subshell that sources the lib under full `set -Eeuo pipefail`, proving the
# functions are strict-mode-safe (the same pattern as apply-spine.bats).

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_LIB="${GA}/scripts/lib/apply-gate.sh"

setup() {
  [[ -f "${REAL_LIB}" ]] || skip "apply-gate.sh not found: ${REAL_LIB}"
  command -v diff >/dev/null 2>&1 || skip "diff required"
  WORK="$(cd -- "$(mktemp -d -t apply-gate-bats.XXXXXX)" && pwd -P)"
  NEW="${WORK}/new"   # staged new-release / proposed-content tree
  LIVE="${WORK}/live" # live install root
  mkdir -p "${NEW}" "${LIVE}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# --- helpers ---------------------------------------------------------------

# Write file $2 (relative) with content $3 under root $1, creating parent dirs.
seed_file() {
  local root="$1" rel="$2" content="$3"
  mkdir -p -- "$(dirname -- "${root}/${rel}")"
  printf '%s' "${content}" >"${root}/${rel}"
}

# Source the lib under strict mode and run a SIMPLE direct call "$@" in the same
# shell (no pipeline). Pipeline + env-injection cases use `run bash -c` instead.
gate() {
  set -Eeuo pipefail
  IFS=$'\n\t'
  # shellcheck source=/dev/null
  source "${REAL_LIB}"
  "$@"
}

# ===========================================================================
# gate_render_diff
# ===========================================================================

@test "render: shows a unified diff between current and proposed" {
  seed_file "${LIVE}" "hooks/a.sh" "old line"
  seed_file "${NEW}" "hooks/a.sh" "new line"
  run gate gate_render_diff "hooks/a.sh" "${LIVE}/hooks/a.sh" "${NEW}/hooks/a.sh"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"=== hooks/a.sh ==="* ]]
  [[ "${output}" == *"-old line"* ]]
  [[ "${output}" == *"+new line"* ]]
}

@test "render: a new file (empty current) is diffed against /dev/null" {
  seed_file "${NEW}" "scripts/new.sh" "brand-new"
  run gate gate_render_diff "scripts/new.sh" "" "${NEW}/scripts/new.sh"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"(new file — no current version)"* ]]
  [[ "${output}" == *"+brand-new"* ]]
}

@test "render: loud-fail (rc 1) when the proposed file is missing" {
  run gate gate_render_diff "hooks/a.sh" "${LIVE}/hooks/a.sh" "${NEW}/ghost.sh"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"proposed content missing for hooks/a.sh"* ]]
}

# ===========================================================================
# gate_build_nonagent_records
# ===========================================================================

@test "build: bridges relative paths into label/current/proposed TSV records" {
  seed_file "${LIVE}" "hooks/a.sh" "old"
  seed_file "${NEW}" "hooks/a.sh" "new"
  seed_file "${NEW}" "scripts/fresh.sh" "fresh" # no live original → empty current
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    printf "%s\n" "hooks/a.sh" "scripts/fresh.sh" \
      | gate_build_nonagent_records "$1" "$2"
  ' _ "${REAL_LIB}" "${NEW}" "${LIVE}"
  [[ "${status}" -eq 0 ]]
  # existing file → current = live path (TAB-separated)
  [[ "${output}" == *"hooks/a.sh"$'\t'"${LIVE}/hooks/a.sh"$'\t'"${NEW}/hooks/a.sh"* ]]
  # new file → empty current field (two adjacent tabs before the proposed path)
  [[ "${output}" == *"scripts/fresh.sh"$'\t'$'\t'"${NEW}/scripts/fresh.sh"* ]]
}

# ===========================================================================
# gate_confirm_changes
# ===========================================================================

@test "confirm: 'yes' confirms the change set (rc 0)" {
  seed_file "${LIVE}" "hooks/a.sh" "old"
  seed_file "${NEW}" "hooks/a.sh" "new"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    export ATRIUM_UPDATE_CONFIRM_ANSWER="$1"; shift
    printf "%s\t%s\t%s\n" "hooks/a.sh" "$1" "$2" | gate_confirm_changes
  ' _ "${REAL_LIB}" "yes" "${LIVE}/hooks/a.sh" "${NEW}/hooks/a.sh"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"=== hooks/a.sh ==="* ]]
}

@test "confirm: an empty / non-yes answer declines (rc 1)" {
  seed_file "${LIVE}" "hooks/a.sh" "old"
  seed_file "${NEW}" "hooks/a.sh" "new"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    export ATRIUM_UPDATE_CONFIRM_ANSWER="$1"; shift
    printf "%s\t%s\t%s\n" "hooks/a.sh" "$1" "$2" | gate_confirm_changes
  ' _ "${REAL_LIB}" "" "${LIVE}/hooks/a.sh" "${NEW}/hooks/a.sh"
  [[ "${status}" -eq 1 ]]
  [[ "${output}" == *"declined — no files written"* ]]
}

@test "confirm: an empty change set returns rc 2 (nothing to confirm)" {
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    export ATRIUM_UPDATE_CONFIRM_ANSWER="yes"
    printf "" | gate_confirm_changes
  ' _ "${REAL_LIB}"
  [[ "${status}" -eq 2 ]]
  [[ "${output}" == *"no changes to apply"* ]]
}

# ===========================================================================
# gate_apply_confirmed — structural zero-write-on-decline
# ===========================================================================

@test "apply: confirmation invokes the write callback (files written)" {
  seed_file "${LIVE}" "hooks/a.sh" "old"
  seed_file "${NEW}" "hooks/a.sh" "new"
  # callback copies proposed → live, proving the apply happens only post-confirm
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    export ATRIUM_UPDATE_CONFIRM_ANSWER="$1"; shift
    printf "%s\t%s\t%s\n" "hooks/a.sh" "$1" "$2" \
      | gate_apply_confirmed cp -- "$2" "$1"
  ' _ "${REAL_LIB}" "y" "${LIVE}/hooks/a.sh" "${NEW}/hooks/a.sh"
  [[ "${status}" -eq 0 ]]
  [[ "$(cat "${LIVE}/hooks/a.sh")" == "new" ]]
}

@test "apply: decline performs ZERO writes (callback never runs)" {
  seed_file "${LIVE}" "hooks/a.sh" "old"
  seed_file "${NEW}" "hooks/a.sh" "new"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    export ATRIUM_UPDATE_CONFIRM_ANSWER="$1"; shift
    printf "%s\t%s\t%s\n" "hooks/a.sh" "$1" "$2" \
      | gate_apply_confirmed cp -- "$2" "$1"
  ' _ "${REAL_LIB}" "n" "${LIVE}/hooks/a.sh" "${NEW}/hooks/a.sh"
  [[ "${status}" -eq 1 ]]
  # live file is UNCHANGED — the callback was never invoked
  [[ "$(cat "${LIVE}/hooks/a.sh")" == "old" ]]
}

@test "apply: the SAME gate covers the agent EDITABLE-region merge path" {
  # Agent-merge producer: current = live agent file, proposed = a merged temp
  # file built elsewhere (T17/T18). The gate is agnostic to the producer.
  seed_file "${LIVE}" "agents/dev-shell.md" "local-learned-body"
  seed_file "${NEW}" "merged/dev-shell.md" "merged-three-anchor-body"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    export ATRIUM_UPDATE_CONFIRM_ANSWER="$1"; shift
    printf "%s\t%s\t%s\n" "agents/dev-shell.md (merge)" "$1" "$2" \
      | gate_apply_confirmed cp -- "$2" "$1"
  ' _ "${REAL_LIB}" "yes" "${LIVE}/agents/dev-shell.md" "${NEW}/merged/dev-shell.md"
  [[ "${status}" -eq 0 ]]
  [[ "$(cat "${LIVE}/agents/dev-shell.md")" == "merged-three-anchor-body" ]]
}

@test "apply: decline on the agent-merge path also writes nothing" {
  seed_file "${LIVE}" "agents/dev-shell.md" "local-learned-body"
  seed_file "${NEW}" "merged/dev-shell.md" "merged-three-anchor-body"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    export ATRIUM_UPDATE_CONFIRM_ANSWER="$1"; shift
    printf "%s\t%s\t%s\n" "agents/dev-shell.md (merge)" "$1" "$2" \
      | gate_apply_confirmed cp -- "$2" "$1"
  ' _ "${REAL_LIB}" "" "${LIVE}/agents/dev-shell.md" "${NEW}/merged/dev-shell.md"
  [[ "${status}" -eq 1 ]]
  [[ "$(cat "${LIVE}/agents/dev-shell.md")" == "local-learned-body" ]]
}

@test "apply: an empty change set returns rc 2 and never calls the callback" {
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    export ATRIUM_UPDATE_CONFIRM_ANSWER="yes"
    printf "" | gate_apply_confirmed touch "$1"
  ' _ "${REAL_LIB}" "${WORK}/should-not-exist"
  [[ "${status}" -eq 2 ]]
  [[ ! -e "${WORK}/should-not-exist" ]]
}
