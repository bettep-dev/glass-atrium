#!/usr/bin/env bats
# validate-pre-write-raw.bats — V7 raw-store immutability: Edit coverage of the raw-ingestion gate.
#
# P1-3 (clauded-docs/299): the gate was Write-only — an Edit on an existing wiki/raw/*.md bypassed
# the V6 envelope check entirely (it could strip the UNTRUSTED-SOURCE envelope post-save). Chosen
# mechanism = UNCONDITIONAL Edit block (V7/SCOPE-007), grounded in the store contract "1 URL = 1
# immutable file" (hook header + core-wiki-reference.md "immutable after save"): no legitimate Edit
# flow exists (legacy-envelope backfill is forbidden by the Unmarked-legacy rule), so EVERY Edit on
# a raw trigger path blocks — INCLUDING an envelope-preserving Edit (immutability enforcement, not
# envelope simulation). Correction path = delete + full-compliance Write re-save (V1-V6 re-run).
#
# Run via: bats hooks/test/validate-pre-write-raw.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3, jq.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command (or an explicit
# `return 1`) gates pass/fail — every assertion below `return 1`s on mismatch.

RAW_HOOK="${BATS_TEST_DIRNAME}/../validate-pre-write-raw.sh"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  [[ -x "${RAW_HOOK}" ]] || skip "raw-write hook missing: ${RAW_HOOK}"
  # Raw store rooted in the Bats tmpdir — no real ~/.glass-atrium state is touched.
  export WIKI_ROOT="${BATS_TEST_TMPDIR}/wiki"
}

# Valid 3-field frontmatter followed by $1 (body). Args: $1=body.
raw_doc() {
  printf '%s\n' \
    '---' \
    'source_url: https://example.com/page' \
    'collected: 2026-07-22' \
    'collector: glass-atrium-intel-researcher' \
    '---' \
    '' \
    "${1}"
}

# An Edit-tool envelope. Args: $1=file_path $2=old_string $3=new_string.
edit_payload() {
  jq -nc --arg fp "${1}" --arg o "${2}" --arg n "${3}" \
    '{tool_name:"Edit", tool_input:{file_path:$fp, old_string:$o, new_string:$n}}'
}

# A Write-tool envelope for a wiki/raw/ path carrying $1 as content. Args: $1=content.
raw_write_payload() {
  jq -nc --arg fp "${WIKI_ROOT}/raw/page.md" --arg c "${1}" \
    '{tool_name:"Write", tool_input:{file_path:$fp, content:$c}}'
}

# ================================ V7 — Edit on the raw store =====================================

# Spec VERIFY (P1-3): an Edit stripping the envelope from an existing raw file is BLOCKED.
@test "V7: Edit removing the UNTRUSTED-SOURCE envelope from raw/*.md → blocked, exit 2 (SCOPE-007)" {
  run bash "${RAW_HOOK}" <<<"$(edit_payload "${WIKI_ROOT}/raw/page.md" \
    '<!-- UNTRUSTED-SOURCE -->' '')"
  [[ "${status}" -eq 2 ]] || { echo "expected exit 2, got ${status}: ${output}" >&2; return 1; }
  [[ "${output}" == *"SCOPE-007"* ]] || { echo "expected SCOPE-007 block: ${output}" >&2; return 1; }
}

# Immutability semantic pin: the block is UNCONDITIONAL — an Edit that touches only body prose
# (envelope untouched) still blocks; V7 enforces immutability, it does NOT simulate the post-state.
@test "V7: envelope-preserving Edit on raw/*.md → still blocked, exit 2 (unconditional immutability)" {
  run bash "${RAW_HOOK}" <<<"$(edit_payload "${WIKI_ROOT}/raw/page.md" 'typo' 'fixed')"
  [[ "${status}" -eq 2 ]] || { echo "expected exit 2, got ${status}: ${output}" >&2; return 1; }
  [[ "${output}" == *"SCOPE-007"* ]] || { echo "expected SCOPE-007 block: ${output}" >&2; return 1; }
}

# The block names the correction path (delete + Write re-save), not a dead end.
@test "V7: SCOPE-007 suggestion names the delete + Write re-save correction path" {
  run bash "${RAW_HOOK}" <<<"$(edit_payload "${WIKI_ROOT}/raw/page.md" 'a' 'b')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"immutable"* ]] || { echo "message must name immutability: ${output}" >&2; return 1; }
  [[ "${output}" == *"re-save"* ]] || { echo "suggestion must name re-save path: ${output}" >&2; return 1; }
}

# Belt-and-suspenders trigger (literal glass-atrium store path) covers Edit too.
@test "V7: Edit on literal .glass-atrium/wiki/raw path → blocked, exit 2" {
  run bash "${RAW_HOOK}" <<<"$(edit_payload "/Users/u/.glass-atrium/wiki/raw/page.md" 'a' 'b')"
  [[ "${status}" -eq 2 ]] || { echo "expected exit 2, got ${status}: ${output}" >&2; return 1; }
  [[ "${output}" == *"SCOPE-007"* ]] || return 1
}

# Trigger scope unchanged: Edit outside the raw store passes untouched.
@test "V7: Edit outside raw/ → exit 0, silent" {
  run bash "${RAW_HOOK}" <<<"$(edit_payload "/tmp/notes/x.md" 'a' 'b')"
  [[ "${status}" -eq 0 ]] || { echo "expected exit 0, got ${status}: ${output}" >&2; return 1; }
  [[ -z "${output}" ]] || { echo "expected silence on non-raw path: ${output}" >&2; return 1; }
}

# Trigger scope unchanged: the gate stays *.md-scoped (a non-md raw path is out of scope).
@test "V7: Edit on a raw non-.md path → exit 0, silent" {
  run bash "${RAW_HOOK}" <<<"$(edit_payload "${WIKI_ROOT}/raw/page.txt" 'a' 'b')"
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${output}" ]] || return 1
}

# ============================ Write behavior unchanged (V1-V6 floor) =============================

# A conforming Write (envelope + 3-field frontmatter) is still permitted.
@test "Write: conforming raw write (envelope + 3-field frontmatter) → permitted, exit 0" {
  local body content
  body="$(printf '%s\n' '<!-- UNTRUSTED-SOURCE -->' 'Preserved source content.' \
    '<!-- /UNTRUSTED-SOURCE -->')"
  content="$(raw_doc "${body}")"
  run bash "${RAW_HOOK}" <<<"$(raw_write_payload "${content}")"
  [[ "${status}" -eq 0 ]] || { echo "expected exit 0 (permit), got ${status}: ${output}" >&2; return 1; }
  [[ -z "${output}" ]] || { echo "expected no violation output on permit: ${output}" >&2; return 1; }
}

# V6 still fires on Write — the Edit branch did not weaken the envelope gate.
@test "Write: raw write WITHOUT body envelope → blocked, exit 2 (SCOPE-006 — V6 intact)" {
  local content; content="$(raw_doc 'Fetched content with no envelope wrapper.')"
  run bash "${RAW_HOOK}" <<<"$(raw_write_payload "${content}")"
  [[ "${status}" -eq 2 ]] || { echo "expected exit 2, got ${status}: ${output}" >&2; return 1; }
  [[ "${output}" == *"SCOPE-006"* ]] || { echo "expected SCOPE-006 block: ${output}" >&2; return 1; }
}

# Tool gate: a non-Write/Edit tool on a raw path stays out of scope.
@test "tool gate: Read on a raw path → exit 0, silent" {
  local payload
  payload="$(jq -nc --arg fp "${WIKI_ROOT}/raw/page.md" \
    '{tool_name:"Read", tool_input:{file_path:$fp}}')"
  run bash "${RAW_HOOK}" <<<"${payload}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${output}" ]] || return 1
}
