#!/usr/bin/env bats
# apply-gate.sh suite — pins the E3 T12 foreground diff/confirm gate contract:
# render_diff (loud-fail on missing proposed) · build_nonagent_records (record
# bridge, fields joined by ASCII Unit Separator 0x1f) · confirm_changes (rc 0
# confirm / 1 decline / 2 empty) · apply_confirmed (structural
# zero-write-on-decline: callback runs ONLY post-confirm, covering both non-agent
# sync and the agent EDITABLE-region merge via the same gate).
# Hermetic: the confirm answer is injected via ATRIUM_UPDATE_CONFIRM_ANSWER so
# /dev/tty is never read (the sole test seam); pipelines run `bash -c` sourcing the
# lib under set -Eeuo pipefail, proving the functions strict-mode-safe.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_LIB="${GA}/scripts/lib/apply-gate.sh"
# The record field separator (ASCII Unit Separator 0x1f) — a non-whitespace
# delimiter so an empty <current> field (new file) never collapses on the read.
SEP=$'\x1f'

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

# helpers

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

# gate_render_diff

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

# gate_build_nonagent_records

@test "build: bridges relative paths into label/current/proposed 0x1f records" {
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
  # existing file → current = live path (0x1f-separated)
  [[ "${output}" == *"hooks/a.sh${SEP}${LIVE}/hooks/a.sh${SEP}${NEW}/hooks/a.sh"* ]]
  # new file → empty current field (two adjacent 0x1f separators before proposed)
  [[ "${output}" == *"scripts/fresh.sh${SEP}${SEP}${NEW}/scripts/fresh.sh"* ]]
}

# new-file deploy regression (the latent updater bug)
#
# At HEAD 1dfbb3a the record used a TAB separator. gate_build_nonagent_records
# emits an EMPTY <current> for a new file, so the record was `path\t\tproposed`.
# On the read, `IFS=$'\t'` is IFS-whitespace: the two adjacent tabs collapse into
# one delimiter, so the reader bound current=proposed_path and proposed="" (empty).
# gate_render_diff then fail-closed ("proposed content missing") → the whole
# confirm gate declined → ZERO new files written (only new bundle files ever hit
# this; a modified file's non-empty current never collapses). The 0x1f separator
# preserves the empty <current>, so proposed survives and the new file deploys.

@test "regress: a NEW file's record round-trips with proposed NON-EMPTY (fails at HEAD)" {
  seed_file "${NEW}" "hooks/ga_paths.py" "new"
  [[ ! -e "${LIVE}/hooks/ga_paths.py" ]] # genuinely new → empty current
  # Read the real producer's new-file record back with the gate's own separator and
  # assert proposed survived. At HEAD (tab) proposed collapsed to empty here.
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    sep="$(printf "\x1f")"
    printf "%s\n" "hooks/ga_paths.py" \
      | gate_build_nonagent_records "$1" "$2" \
      | { IFS="${sep}" read -r label current proposed
          printf "label=[%s] current=[%s] proposed=[%s]" \
            "${label}" "${current}" "${proposed}"; }
  ' _ "${REAL_LIB}" "${NEW}" "${LIVE}"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == "label=[hooks/ga_paths.py] current=[] proposed=[${NEW}/hooks/ga_paths.py]" ]]
}

@test "regress: a NEW file is CONFIRMED and WRITTEN end-to-end via the real gate (fails at HEAD)" {
  seed_file "${NEW}" "hooks/ga_paths.py" "brand-new-bundle-file"
  mkdir -p -- "${LIVE}/hooks" # install root has the dir; the FILE is the new one
  [[ ! -e "${LIVE}/hooks/ga_paths.py" ]] # no live original → empty current
  # Real producer → real gate → write callback. At HEAD the empty-current collapse
  # dropped proposed, gate_render_diff fail-closed, the gate DECLINED (rc 1) and the
  # callback never ran → the new file was NOT written.
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    export ATRIUM_UPDATE_CONFIRM_ANSWER="yes"
    new_dir="$1"; live="$2"
    printf "%s\n" "hooks/ga_paths.py" \
      | gate_build_nonagent_records "${new_dir}" "${live}" \
      | gate_apply_confirmed cp -- \
          "${new_dir}/hooks/ga_paths.py" "${live}/hooks/ga_paths.py"
  ' _ "${REAL_LIB}" "${NEW}" "${LIVE}"
  [[ "${status}" -eq 0 ]]
  [[ -f "${LIVE}/hooks/ga_paths.py" ]]
  [[ "$(cat "${LIVE}/hooks/ga_paths.py")" == "brand-new-bundle-file" ]]
}

# gate_confirm_changes

@test "confirm: 'yes' confirms the change set (rc 0)" {
  seed_file "${LIVE}" "hooks/a.sh" "old"
  seed_file "${NEW}" "hooks/a.sh" "new"
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    export ATRIUM_UPDATE_CONFIRM_ANSWER="$1"; shift
    printf "%s\x1f%s\x1f%s\n" "hooks/a.sh" "$1" "$2" | gate_confirm_changes
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
    printf "%s\x1f%s\x1f%s\n" "hooks/a.sh" "$1" "$2" | gate_confirm_changes
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

# gate_apply_confirmed — structural zero-write-on-decline

@test "apply: confirmation invokes the write callback (files written)" {
  seed_file "${LIVE}" "hooks/a.sh" "old"
  seed_file "${NEW}" "hooks/a.sh" "new"
  # callback copies proposed → live, proving the apply happens only post-confirm
  run bash -c '
    set -Eeuo pipefail
    source "$1"; shift
    export ATRIUM_UPDATE_CONFIRM_ANSWER="$1"; shift
    printf "%s\x1f%s\x1f%s\n" "hooks/a.sh" "$1" "$2" \
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
    printf "%s\x1f%s\x1f%s\n" "hooks/a.sh" "$1" "$2" \
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
    printf "%s\x1f%s\x1f%s\n" "agents/dev-shell.md (merge)" "$1" "$2" \
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
    printf "%s\x1f%s\x1f%s\n" "agents/dev-shell.md (merge)" "$1" "$2" \
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
