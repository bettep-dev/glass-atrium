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
#   T3 silent   — a non-take-release verdict (e.g. merge-pending-arbitration) → no warning, no record.
#   T4 advisory — the function always returns 0 and writes NOTHING outside its own ledger, so
#                 the confirm-gate flow is byte-identical.
#   T5 counting — only lines INSIDE EDITABLE regions count (markers + vendor prose excluded).
#   T6 sanctioned — reset-to-release WITH a request id → INFO + an editable-resets.log row naming
#                 the request, and NO deletion-shape-warnings.log row (that ledger stays defect-only).
#   T6b unmeasured — the sanctioned row is written even when the delta cannot be measured.
#   T6c retain  — a sanctioned row that cannot be written returns non-zero, so the caller retains.
#   T7 defect   — reset-to-release with `none` → the defect WARN + a deletion-shape-warnings.log row.
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
update_check_deletion_shape "${ROOT}" "agents/alpha.md" "${VERDICT}" "${LOCAL_FILE}" "${CANDIDATE}" ${RESET_ID+"${RESET_ID}"}
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
    ${RESET_ID+RESET_ID="${RESET_ID}"} \
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

@test "T1b merge-arbiter-resolved with a net-negative delta warns and persists a record" {
  # The second deletion-capable verdict, and the one this branch added to the case
  # list. take-release drops local lines because the daemon never wrote them;
  # merge-arbiter-resolved drops lines the daemon DID write, by taking the release
  # side of a conflicting gap. That is a strictly larger loss reaching the same
  # advisory, so covering only take-release would leave the newer route — the one
  # every contested gap now takes — untested at the guard built for it.
  seed_body "${WORK}/local.md" 'daemon line 1' 'daemon line 2' 'daemon line 3'
  seed_body "${WORK}/candidate.md" 'vendor line 1'
  VERDICT="merge-arbiter-resolved"
  trip
  [ "${status}" -eq 0 ] || return 1
  oc "deletion-shape tripwire" "${output}" || return 1
  oc "agents/alpha.md" "${output}" || return 1
  oc "resolves merge-arbiter-resolved" "${output}" || return 1
  oc "drops 2 EDITABLE-region line(s)" "${output}" || return 1
  [ -f "${LEDGER_DIR}/deletion-shape-warnings.log" ] || return 1
  local record
  record="$(cat "${LEDGER_DIR}/deletion-shape-warnings.log")"
  oc "agents/alpha.md" "${record}" || return 1
  oc "deleted_lines=2" "${record}" || return 1
  # Advisory only: the verdict never blocks, and the record lands beside the
  # conflict-decline ledger rather than inside it.
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
  VERDICT="merge-pending-arbitration"
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

@test "T6 a reset-to-release with a request id is recorded as sanctioned, never as a defect" {
  seed_body "${WORK}/local.md" 'daemon line 1' 'daemon line 2' 'daemon line 3'
  seed_body "${WORK}/candidate.md" 'release line 1'
  VERDICT="reset-to-release"
  RESET_ID="er-20260913-a"
  trip
  [ "${status}" -eq 0 ] || return 1
  oc "sanctioned editable reset — agents/alpha.md drops 2 EDITABLE-region line(s) (request er-20260913-a)" "${output}" || return 1
  no "deletion-shape tripwire" "${output}" || return 1
  [ ! -e "${LEDGER_DIR}/deletion-shape-warnings.log" ] || return 1
  local record
  record="$(cat "${LEDGER_DIR}/editable-resets.log")"
  oc "agents/alpha.md" "${record}" || return 1
  oc "outcome=queued" "${record}" || return 1
  oc "deleted_lines=2" "${record}" || return 1
  oc "request=er-20260913-a" "${record}" || return 1
}

@test "T6b the sanctioned row is written even when the line delta cannot be measured" {
  seed_body "${WORK}/local.md" 'daemon line 1'
  # No candidate file: the counter fails, which must not skip the record.
  VERDICT="reset-to-release"
  RESET_ID="er-20260913-b"
  trip
  [ "${status}" -eq 0 ] || return 1
  oc "deleted_lines=unmeasured" "$(cat "${LEDGER_DIR}/editable-resets.log")" || return 1
}

@test "T6c an unwritable sanctioned ledger returns non-zero so the caller retains the body" {
  seed_body "${WORK}/local.md" 'daemon line 1' 'daemon line 2'
  seed_body "${WORK}/candidate.md"
  # The declines dir is a FILE, so the ledger cannot be created under it.
  printf 'not a dir' >"${WORK}/bak-parent/update-declines"
  VERDICT="reset-to-release"
  RESET_ID="er-20260913-c"
  trip
  [ "${status}" -ne 0 ] || return 1
  oc "could not write the editable-resets.log row" "${output}" || return 1
}

@test "T7 a reset-to-release without a request is still reported as a defect" {
  seed_body "${WORK}/local.md" 'daemon line 1' 'daemon line 2' 'daemon line 3'
  seed_body "${WORK}/candidate.md" 'release line 1'
  VERDICT="reset-to-release"
  RESET_ID="none"
  trip
  [ "${status}" -eq 0 ] || return 1
  oc "deletion-shape tripwire" "${output}" || return 1
  oc "reset verdict without a request — defect" "${output}" || return 1
  oc "deleted_lines=2" "$(cat "${LEDGER_DIR}/deletion-shape-warnings.log")" || return 1
  [ ! -e "${LEDGER_DIR}/editable-resets.log" ] || return 1
}
