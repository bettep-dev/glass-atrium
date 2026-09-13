#!/usr/bin/env bats
# update-editable-reset.bats — pins the LANDING path of the operator EDITABLE reset in
# scripts/update.sh: run validation, the reset-to-release merge arm, the sanctioned ledger,
# the per-run outcome record and per-body consumption of the request.
#
# Why: a plain redeploy keeps daemon-evolved EDITABLE lines by design (release == base →
# keep-local), so removing them needs a recorded operator request. The request must remove
# exactly the marked bodies' lines, leave every other body alone, stay consumed, and refuse
# a body that changed after the operator reviewed it.
#
# Contracts pinned:
#   L1 landing    — the marked body equals the release apart from its operator model line;
#                   the base entry equals the release; the request moves to consumed/; the
#                   sanctioned ledger names it; the outcome record quotes the dropped line.
#   L2 unmarked   — a body the request does not name keeps its daemon line, byte-identical.
#   L3 idempotent — a second run writes nothing and no dropped line comes back.
#   L4 live-moved — a body whose live hash differs from the recorded one is refused, kept
#                   byte-identical, and retained in the request with an outcome=refused row.
#   L5 malformed  — a malformed request exits 16 before anything is applied.
#   L6 consumed   — a request id already in consumed/ exits 16 before anything is applied.
#
# And the OPERATOR surface:
#   O1 record     — writes a request the next run consumes; the run keeps durable images.
#   O2 headless   — record is refused with --headless and writes nothing.
#   O3 lock       — record is refused while another writer holds the apply-lock.
#   O4 refusals   — an absent body, the charter, a region-less body and a second request
#                   exit 16 and record nothing.
#   O5 show       — previews exactly the lines the reset drops and writes nothing.
#   O6 cancel     — moves the request to cancelled/, and a later run leaves the body alone.
#   O7 restore    — puts the body and its base entry back to their pre-reset images.
#   O8 stale      — a body edited after the reset is refused unless --allow-live-moved.
#   O9 image fail — a before-image that cannot be written retains the body.
#
# The landing cases seed pending.json directly in the format autoagent/lib/editable_reset.py
# validates, so they do not depend on the record subcommand.
#
# Every assertion is gated `|| return 1`: a bare mid-body `[[ ]]` is exempt from errexit on
# macOS bash 3.2 and gates on Linux bash 5, so an ungated one is silently ignored locally.
#
# Hermetic: per-test mktemp sandbox with GA_ROOT / AUTOAGENT_REPORTS_DIR /
# ATRIUM_UPDATE_STATE_DIR redirected into it; the download is bypassed via
# ATRIUM_UPDATE_SRC_DIR, and AUTOAGENT_CLAUDE_BIN names a path that is never created.
#
# Run via: bats scripts/test/update-editable-reset.bats
# Requires: bats 1.5+, bash 3.2+, jq, python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
export SKILL="${GA}/scripts/update.sh"

REQUEST_ID='er-20260913-probe'

MARKED_LOCAL='---
name: dev-r
model: opus
---
# dev-r
## Goal
<!-- EDITABLE:BEGIN -->
vendor goal
- MUST daemon-evolved line to drop
<!-- EDITABLE:END -->
## Rules
vendor rules'
MARKED_RELEASE='---
name: dev-r
---
# dev-r
## Goal
<!-- EDITABLE:BEGIN -->
vendor goal
<!-- EDITABLE:END -->
## Rules
vendor rules'
UNMARKED_LOCAL='---
name: dev-u
---
# dev-u
## Goal
<!-- EDITABLE:BEGIN -->
vendor goal
- MUST daemon line that stays
<!-- EDITABLE:END -->'
UNMARKED_RELEASE='---
name: dev-u
---
# dev-u
## Goal
<!-- EDITABLE:BEGIN -->
vendor goal
<!-- EDITABLE:END -->'

setup() {
  [[ -f "${SKILL}" ]] || skip "update.sh not found: ${SKILL}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  WORK="$(cd -- "$(mktemp -d -t ga-update-reset.XXXXXX)" && pwd -P)"
  INSTALL="${WORK}/install"
  NEWSRC="${WORK}/newsrc"
  STATE="${WORK}/state/update-state"
  REQ_DIR="${STATE}/editable-reset"
  mkdir -p "${INSTALL}/agents" "${NEWSRC}/agents" "${STATE}/base-agents" "${REQ_DIR}"

  printf '%s\n' "${MARKED_LOCAL}" >"${INSTALL}/agents/dev-r.md"
  printf '%s\n' "${UNMARKED_LOCAL}" >"${INSTALL}/agents/dev-u.md"
  printf '%s\n' "${MARKED_RELEASE}" >"${NEWSRC}/agents/dev-r.md"
  printf '%s\n' "${UNMARKED_RELEASE}" >"${NEWSRC}/agents/dev-u.md"
  # base == release: the state in which a plain redeploy keeps every daemon line.
  cp "${NEWSRC}/agents/dev-r.md" "${STATE}/base-agents/dev-r.md"
  cp "${NEWSRC}/agents/dev-u.md" "${STATE}/base-agents/dev-u.md"
  write_manifest agents/dev-r.md agents/dev-u.md
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}"
  return 0
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    sha256sum -- "$1" | awk '{print $1}'
  fi
}

write_manifest() {
  local p hashes="" files=""
  for p in "$@"; do
    files="${files}$(printf '%s' "${p}" | jq -R .),"
    hashes="${hashes}$(printf '%s' "${p}" | jq -R .):$(sha256_of "${NEWSRC}/${p}" | jq -R .),"
  done
  printf '{"version":"1.0.0","files":[%s],"hashes":{%s}}\n' \
    "${files%,}" "${hashes%,}" >"${WORK}/manifest.json"
}

# $1 = live_sha256 recorded for agents/dev-r.md (defaults to the body's current hash).
seed_request() {
  jq -n --arg id "${REQUEST_ID}" --arg sha "${1:-$(sha256_of "${INSTALL}/agents/dev-r.md")}" \
    '{request_id: $id, recorded_utc: "2026-09-13T00:00:00Z", reason: "canonical dieted bodies win",
      bodies: [{target: "agents/dev-r.md", live_sha256: $sha}]}' >"${REQ_DIR}/pending.json"
}

run_update() {
  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${WORK}/state/daemon-reports" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    AUTOAGENT_CLAUDE_BIN="${WORK}/no-such-claude" \
    bash "${SKILL}" "$@"
}

@test "L1 a marked body lands at the release, keeps its model line, and consumes the request" {
  seed_request
  run_update
  [ "${status}" -eq 0 ] || return 1
  [[ "${output}" == *"editable reset: request ${REQUEST_ID} pending for 1 body(ies): agents/dev-r.md"* ]] || return 1
  [[ "${output}" == *"(state dir ${STATE})"* ]] || return 1

  # live minus the operator model line == release; the model line survived.
  [[ "$(grep -v '^model: ' "${INSTALL}/agents/dev-r.md")" == "${MARKED_RELEASE}" ]] || return 1
  grep -qx 'model: opus' "${INSTALL}/agents/dev-r.md" || return 1
  cmp -s "${STATE}/base-agents/dev-r.md" "${NEWSRC}/agents/dev-r.md" || return 1

  [ ! -e "${REQ_DIR}/pending.json" ] || return 1
  [[ "$(jq -r '.request_id' "${REQ_DIR}/consumed/${REQUEST_ID}.json")" == "${REQUEST_ID}" ]] || return 1

  local ledger="${INSTALL}/update-declines/editable-resets.log"
  grep -q "agents/dev-r.md.*outcome=queued.*deleted_lines=1.*request=${REQUEST_ID}" "${ledger}" || return 1
  grep -q "agents/dev-r.md.*outcome=landed.*request=${REQUEST_ID}" "${ledger}" || return 1
  [ ! -e "${INSTALL}/update-declines/deletion-shape-warnings.log" ] || return 1

  local record
  record="$(find "${INSTALL}/update-declines/editable-resets/${REQUEST_ID}" -name 'outcome-*.json')"
  [[ "$(jq -r '.bodies[0].dropped_text[0]' "${record}")" == '- MUST daemon-evolved line to drop' ]] || return 1
  [[ "$(jq -r '.bodies[0].post_reset_sha256' "${record}")" == "$(sha256_of "${INSTALL}/agents/dev-r.md")" ]] || return 1
}

@test "L2 a body the request does not name keeps its daemon line" {
  seed_request
  run_update
  [ "${status}" -eq 0 ] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-u.md")" == "${UNMARKED_LOCAL}" ]] || return 1
  grep -q 'agents/dev-u.md' "${INSTALL}/update-declines/editable-resets.log" && return 1
  return 0
}

@test "L3 a second run writes nothing and no dropped line comes back" {
  seed_request
  run_update
  [ "${status}" -eq 0 ] || return 1
  local after_first rows_first
  after_first="$(cat "${INSTALL}/agents/dev-r.md")"
  rows_first="$(wc -l <"${INSTALL}/update-declines/editable-resets.log")"

  run_update
  [ "${status}" -eq 0 ] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-r.md")" == "${after_first}" ]] || return 1
  [[ "${after_first}" != *"daemon-evolved line to drop"* ]] || return 1
  [[ "${output}" != *"editable reset"* ]] || return 1
  [[ "$(wc -l <"${INSTALL}/update-declines/editable-resets.log")" == "${rows_first}" ]] || return 1
}

@test "L4 a body that moved after the operator reviewed it is refused and retained" {
  seed_request "$(printf '0%.0s' {1..64})"
  run_update
  [ "${status}" -eq 0 ] || return 1
  [[ "${output}" == *"agents/dev-r.md REFUSED (reason=live-moved)"* ]] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-r.md")" == "${MARKED_LOCAL}" ]] || return 1
  [[ "$(jq -r '.bodies[0].target' "${REQ_DIR}/pending.json")" == 'agents/dev-r.md' ]] || return 1
  [ ! -e "${REQ_DIR}/consumed/${REQUEST_ID}.json" ] || return 1
  # Skipped before planning, so it is neither planned nor declined as a merge conflict.
  [ ! -e "${INSTALL}/update-declines/conflict-declines.log" ] || return 1
  grep -q "agents/dev-r.md.*outcome=refused.*reason=live-moved.*request=${REQUEST_ID}" \
    "${INSTALL}/update-declines/editable-resets.log" || return 1
}

@test "L5 a malformed request exits 16 before anything is applied" {
  printf '{"request_id": "two tokens", "bodies": []}\n' >"${REQ_DIR}/pending.json"
  run_update
  [ "${status}" -eq 16 ] || return 1
  [[ "${output}" == *"reason=malformed"* ]] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-r.md")" == "${MARKED_LOCAL}" ]] || return 1
  [ ! -e "${STATE}/baseline-manifest.json" ] || return 1
}

@test "L6 a request id that was already consumed exits 16 before anything is applied" {
  seed_request
  mkdir -p "${REQ_DIR}/consumed"
  cp "${REQ_DIR}/pending.json" "${REQ_DIR}/consumed/${REQUEST_ID}.json"
  run_update
  [ "${status}" -eq 16 ] || return 1
  [[ "${output}" == *"reason=already-consumed"* ]] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-r.md")" == "${MARKED_LOCAL}" ]] || return 1
}

@test "O1 record writes a request the next run consumes, keeping durable before-images" {
  run_update --record-editable-reset --reason 'canonical dieted bodies win' dev-r
  [ "${status}" -eq 0 ] || return 1
  local rid images
  rid="$(jq -r '.request_id' "${REQ_DIR}/pending.json")"
  [[ "$(jq -r '.bodies[0].target' "${REQ_DIR}/pending.json")" == 'agents/dev-r.md' ]] || return 1
  [[ "$(jq -r '.bodies[0].live_sha256' "${REQ_DIR}/pending.json")" == "$(sha256_of "${INSTALL}/agents/dev-r.md")" ]] || return 1
  [[ "$(jq -r '.bodies[0].base_sha256' "${REQ_DIR}/pending.json")" == "$(sha256_of "${STATE}/base-agents/dev-r.md")" ]] || return 1
  [[ "${output}" == *'    - - MUST daemon-evolved line to drop'* ]] || return 1
  [[ "${output}" == *"ATRIUM_UPDATE_STATE_DIR=${STATE} glass-atrium update"* ]] || return 1
  grep -q "agents/dev-r.md.*outcome=recorded.*request=${rid}" "${INSTALL}/update-declines/editable-resets.log" || return 1

  run_update
  [ "${status}" -eq 0 ] || return 1
  [[ "$(grep -v '^model: ' "${INSTALL}/agents/dev-r.md")" == "${MARKED_RELEASE}" ]] || return 1
  [ -f "${REQ_DIR}/consumed/${rid}.json" ] || return 1
  images="${INSTALL}/update-declines/editable-resets/${rid}"
  [[ "$(cat "${images}/dev-r.md.bak")" == "${MARKED_LOCAL}" ]] || return 1
  cmp -s "${images}/dev-r.md.base.bak" "${NEWSRC}/agents/dev-r.md" || return 1
}

@test "O2 record is refused with --headless and writes nothing" {
  run_update --headless --record-editable-reset --reason 'r' dev-r
  [ "${status}" -eq 2 ] || return 1
  [[ "${output}" == *"refused with --headless"* ]] || return 1
  [ ! -e "${REQ_DIR}/pending.json" ] || return 1
}

@test "O3 record is refused while another writer holds the apply-lock" {
  mkdir -p "${WORK}/state/daemon-reports/.apply-lock"
  run_update --record-editable-reset --reason 'r' dev-r
  [ "${status}" -eq 1 ] || return 1
  [[ "${output}" == *"another apply is in progress"* ]] || return 1
  [ ! -e "${REQ_DIR}/pending.json" ] || return 1
}

@test "O4 a refused record exits 16 and records nothing" {
  printf '%s\n' '---' 'name: dev-flat' '---' '# dev-flat' 'no regions' >"${INSTALL}/agents/dev-flat.md"
  local name reason
  while IFS='|' read -r name reason; do
    run_update --record-editable-reset --reason 'r' "${name}"
    [ "${status}" -eq 16 ] || return 1
    [[ "${output}" == *"reason=${reason}"* ]] || return 1
    [ ! -e "${REQ_DIR}/pending.json" ] || return 1
  done <<'CASES'
dev-missing|body-absent
GLASS_ATRIUM_GLOBAL_RULES|not-merge-claimed
../dev-r|invalid-name
dev-flat|no-editable-regions
CASES
  seed_request
  local before
  before="$(cat "${REQ_DIR}/pending.json")"
  run_update --record-editable-reset --reason 'r' dev-u
  [ "${status}" -eq 16 ] || return 1
  [[ "${output}" == *"reason=pending-exists"* ]] || return 1
  [[ "$(cat "${REQ_DIR}/pending.json")" == "${before}" ]] || return 1
}

@test "O5 show previews exactly the lines the reset drops and writes nothing" {
  seed_request
  local before
  before="$(cat "${REQ_DIR}/pending.json")"
  run_update --show-editable-reset
  [ "${status}" -eq 0 ] || return 1
  [[ "${output}" == *"editable reset request ${REQUEST_ID}"* ]] || return 1
  [[ "${output}" == *'agents/dev-r.md: drops 1 line(s)'* ]] || return 1
  [[ "${output}" == *'- MUST daemon-evolved line to drop'* ]] || return 1
  [[ "${output}" != *'daemon line that stays'* ]] || return 1
  [[ "$(cat "${REQ_DIR}/pending.json")" == "${before}" ]] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-r.md")" == "${MARKED_LOCAL}" ]] || return 1
  [ ! -e "${INSTALL}/update-declines" ] || return 1
}

@test "O6 cancel moves the request aside and a later run leaves the body alone" {
  seed_request
  run_update --cancel-editable-reset
  [ "${status}" -eq 0 ] || return 1
  [ ! -e "${REQ_DIR}/pending.json" ] || return 1
  [[ "$(jq -r '.request_id' "${REQ_DIR}/cancelled/${REQUEST_ID}.json")" == "${REQUEST_ID}" ]] || return 1
  grep -q "agents/dev-r.md.*outcome=cancelled.*request=${REQUEST_ID}" "${INSTALL}/update-declines/editable-resets.log" || return 1

  run_update
  [ "${status}" -eq 0 ] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-r.md")" == "${MARKED_LOCAL}" ]] || return 1
}

@test "O7 restore puts the body and its base entry back to their pre-reset images" {
  # A base that differs from the release, so reverting the advanced base entry is observable.
  printf '%s\n' '<!-- prior base -->' >>"${STATE}/base-agents/dev-r.md"
  local prior_base
  prior_base="$(cat "${STATE}/base-agents/dev-r.md")"
  seed_request
  run_update
  [ "${status}" -eq 0 ] || return 1
  cmp -s "${STATE}/base-agents/dev-r.md" "${NEWSRC}/agents/dev-r.md" || return 1

  run_update --restore-editable-reset "${REQUEST_ID}"
  [ "${status}" -eq 0 ] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-r.md")" == "${MARKED_LOCAL}" ]] || return 1
  [[ "$(cat "${STATE}/base-agents/dev-r.md")" == "${prior_base}" ]] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-u.md")" == "${UNMARKED_LOCAL}" ]] || return 1
  grep -q "agents/dev-r.md.*outcome=restored.*request=${REQUEST_ID}" "${INSTALL}/update-declines/editable-resets.log" || return 1

  run_update --restore-editable-reset 'er-no-such-request'
  [ "${status}" -eq 10 ] || return 1
}

@test "O8 restore refuses a body edited after the reset unless --allow-live-moved" {
  seed_request
  run_update
  [ "${status}" -eq 0 ] || return 1
  printf '%s\n' 'operator edit after the reset' >>"${INSTALL}/agents/dev-r.md"
  local edited
  edited="$(cat "${INSTALL}/agents/dev-r.md")"

  run_update --restore-editable-reset "${REQUEST_ID}"
  [ "${status}" -eq 10 ] || return 1
  [[ "${output}" == *"agents/dev-r.md REFUSED (reason=live-moved)"* ]] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-r.md")" == "${edited}" ]] || return 1

  run_update --restore-editable-reset "${REQUEST_ID}" --allow-live-moved
  [ "${status}" -eq 0 ] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-r.md")" == "${MARKED_LOCAL}" ]] || return 1
}

@test "O9 a before-image that cannot be written retains the body in the request" {
  seed_request
  mkdir -p "${INSTALL}/update-declines/editable-resets"
  : >"${INSTALL}/update-declines/editable-resets/${REQUEST_ID}" # a file where the image dir must go
  run_update
  [ "${status}" -eq 0 ] || return 1
  [[ "${output}" == *"agents/dev-r.md RETAINED — its restore images could not be written"* ]] || return 1
  [[ "$(cat "${INSTALL}/agents/dev-r.md")" == "${MARKED_LOCAL}" ]] || return 1
  [[ "$(jq -r '.bodies[0].target' "${REQ_DIR}/pending.json")" == 'agents/dev-r.md' ]] || return 1
  grep -q "agents/dev-r.md.*outcome=retained.*reason=before-image-failed" "${INSTALL}/update-declines/editable-resets.log" || return 1
}
