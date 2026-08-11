#!/usr/bin/env bats
# update-deletion-shape-tripwire.bats — pins the ADVISORY deletion-shape tripwire in
# scripts/update.sh (update_check_deletion_shape + update_editable_region_lines).
#
# The 2026-08-10 base-anchor contamination produced a clean, no-conflict plan: base==local made
# every vendor-differing EDITABLE region resolve take-release, so 83 live-only daemon lines
# read as vendor deletions and sailed through the confirm gate. The tripwire names that exact
# shape (all-take-release + net-negative EDITABLE-region line delta) before the gate.
#
# Contracts pinned:
#   T1 fires    — take-release + net-negative delta → loud per-file WARN naming the drop count
#                 + a durable record in deletion-shape-warnings.log BESIDE conflict-declines.log.
#   T2 silent   — take-release + net-POSITIVE delta → no warning, no record.
#   T3 silent   — a non-take-release verdict (e.g. merge-conflict) → no warning, no record.
#   T4 advisory — the function always returns 0 and writes NOTHING outside its own ledger, so
#                 the confirm-gate flow is byte-identical.
#   T5 counting — only lines INSIDE EDITABLE regions count (markers + vendor prose excluded).
#
# Hermetic: update.sh is SOURCED (its main guard skips orchestration), the two collaborators
# are stubbed (update_log → stdout, update_agents_bak_base → the sandbox), and every path
# stays inside a temp dir. No install, no network, no live ledger.
#
# Run via: bats scripts/test/update-deletion-shape-tripwire.bats
# Requires: bats 1.5+, bash 3.2+, awk

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
UPDATE_SH="${GA}/scripts/update.sh"

setup() {
  [[ -f "${UPDATE_SH}" ]] || skip "update.sh not found: ${UPDATE_SH}"
  WORK="$(cd -- "$(mktemp -d -t ga-tripwire.XXXXXX)" && pwd -P)"
  ROOT="${WORK}/install"
  LEDGER_DIR="${WORK}/bak-parent/update-declines"
  DRIVER="${WORK}/driver.sh"
  mkdir -p "${ROOT}" "${WORK}/bak-parent"

  cat >"${DRIVER}" <<'DRV'
#!/usr/bin/env bash
set -Eeuo pipefail
# shellcheck disable=SC1090,SC2317
source "${UPDATE_SH}" >/dev/null 2>&1
update_log() { printf '%s\n' "$*"; }
update_agents_bak_base() { printf '%s\n' "${BAK_PARENT}/agents-bak"; }
update_check_deletion_shape "${ROOT}" "agents/alpha.md" "${VERDICT}" "${LOCAL_FILE}" "${CANDIDATE}"
DRV
  chmod +x "${DRIVER}"
}

teardown() {
  if [[ -n "${WORK:-}" && -d "${WORK}" ]]; then
    rm -rf -- "${WORK}"
  fi
}

oc() { [[ "${2}" == *"${1}"* ]] || { printf 'assert-contains FAILED: [%s] absent from:\n%s\n' "${1}" "${2}" >&2; return 1; }; }
no() { [[ "${2}" != *"${1}"* ]] || { printf 'assert-omits FAILED: [%s] present in:\n%s\n' "${1}" "${2}" >&2; return 1; }; }

# Write an agent body with $2..$n as the EDITABLE-region lines, wrapped in vendor prose.
seed_body() {
  local path="$1"
  shift
  {
    printf '%s\n' '# vendor header' '<!-- EDITABLE:BEGIN -->'
    printf '%s\n' "$@"
    printf '%s\n' '<!-- EDITABLE:END -->' 'vendor tail'
  } >"${path}"
}

trip() {
  run env \
    UPDATE_SH="${UPDATE_SH}" \
    ROOT="${ROOT}" \
    BAK_PARENT="${WORK}/bak-parent" \
    VERDICT="${VERDICT:-take-release}" \
    LOCAL_FILE="${WORK}/local.md" \
    CANDIDATE="${WORK}/candidate.md" \
    bash "${DRIVER}"
}

@test "T1 all-take-release with a net-negative delta warns and persists a record" {
  seed_body "${WORK}/local.md" 'daemon line 1' 'daemon line 2' 'daemon line 3'
  seed_body "${WORK}/candidate.md" 'daemon line 1'
  trip
  [ "${status}" -eq 0 ] || return 1
  oc "deletion-shape tripwire" "${output}" || return 1
  oc "agents/alpha.md" "${output}" || return 1
  oc "drops 2 EDITABLE-region line(s)" "${output}" || return 1
  oc "deletion-shape-warnings.log" "${output}" || return 1
  [ -f "${LEDGER_DIR}/deletion-shape-warnings.log" ] || return 1
  local record
  record="$(cat "${LEDGER_DIR}/deletion-shape-warnings.log")"
  oc "agents/alpha.md" "${record}" || return 1
  oc "deleted_lines=2" "${record}" || return 1
  # Timestamp, path, delta — the constant verdict and advisory columns are not stored.
  [ "$(printf '%s' "${record}" | awk -F'\t' '{print NF}')" -eq 3 ] || return 1
  # BESIDE the conflict-decline ledger, never inside it.
  [ ! -e "${LEDGER_DIR}/conflict-declines.log" ] || return 1
}

@test "T2 a net-positive delta leaves the tripwire silent" {
  seed_body "${WORK}/local.md" 'daemon line 1'
  seed_body "${WORK}/candidate.md" 'daemon line 1' 'new vendor line'
  trip
  [ "${status}" -eq 0 ] || return 1
  no "deletion-shape tripwire" "${output}" || return 1
  [ ! -e "${LEDGER_DIR}/deletion-shape-warnings.log" ] || return 1
}

@test "T3 a non-take-release verdict leaves the tripwire silent" {
  seed_body "${WORK}/local.md" 'daemon line 1' 'daemon line 2' 'daemon line 3'
  seed_body "${WORK}/candidate.md" 'daemon line 1'
  VERDICT="merge-conflict"
  trip
  [ "${status}" -eq 0 ] || return 1
  no "deletion-shape tripwire" "${output}" || return 1
  [ ! -e "${LEDGER_DIR}/deletion-shape-warnings.log" ] || return 1
}

@test "T4 the tripwire is advisory — rc 0 and no write outside its own ledger" {
  seed_body "${WORK}/local.md" 'daemon line 1' 'daemon line 2'
  seed_body "${WORK}/candidate.md"
  trip
  [ "${status}" -eq 0 ] || return 1
  # The install root is untouched — the candidate is still the caller's to queue.
  [ -z "$(ls -A "${ROOT}")" ] || return 1
}

@test "T5 only EDITABLE-region lines are counted" {
  # Same EDITABLE content, vendor prose differing wildly → delta 0 → silent.
  seed_body "${WORK}/local.md" 'daemon line 1'
  {
    printf '%s\n' '# a much longer vendor header' 'extra vendor prose' 'more prose' '<!-- EDITABLE:BEGIN -->'
    printf '%s\n' 'daemon line 1'
    printf '%s\n' '<!-- EDITABLE:END -->'
  } >"${WORK}/candidate.md"
  trip
  [ "${status}" -eq 0 ] || return 1
  no "deletion-shape tripwire" "${output}" || return 1
}
