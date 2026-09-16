#!/usr/bin/env bats
# shellcheck disable=SC2154,SC2312 # BATS_* vars are bats-provided; a failing payload builder surfaces as a failed assertion
# Raw-ingestion gate: V7 Edit immutability, V8 destination state and the V1-V6 blocking floor.
# The gate has no advisory channel: every code it emits blocks, and the retired warn codes are pinned silent below.
# Every check `return 1`s on mismatch: bash 3.2 does not abort on a failing mid-body `[[ ]]`, bash 5.3 does.

RAW_HOOK="${BATS_TEST_DIRNAME}/../validate-pre-write-raw.sh"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  [[ -x "${RAW_HOOK}" ]] || skip "raw-write hook missing: ${RAW_HOOK}"
  # Raw store and HOME rooted in the Bats tmpdir — no real ~/.glass-atrium state is touched.
  export WIKI_ROOT="${BATS_TEST_TMPDIR}/wiki"
  export HOME="${BATS_TEST_TMPDIR}/home"
}

# Valid 3-field frontmatter followed by $1 (body). Args: $1=body $2=source_url (default https://example.com/page).
raw_doc() {
  printf '%s\n' \
    '---' \
    "source_url: ${2:-https://example.com/page}" \
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

# A Write-tool envelope for an explicit destination. Args: $1=file_path $2=content.
write_payload_at() {
  jq -nc --arg fp "${1}" --arg c "${2}" \
    '{tool_name:"Write", tool_input:{file_path:$fp, content:$c}}'
}

# A Write-tool envelope for the raw page carrying session + transcript fields the gate no longer reads.
# Args: $1=content $2=transcript_path.
raw_write_payload_with_transcript() {
  jq -nc --arg fp "${WIKI_ROOT}/raw/page.md" --arg c "${1}" --arg tp "${2}" \
    '{tool_name:"Write", session_id:"sess-1", transcript_path:$tp, tool_input:{file_path:$fp, content:$c}}'
}

# A fully conforming raw document (3-field frontmatter + body envelope): V1-V6 all pass.
# Any code observed on it comes from a non-content check (V7 or V8). Args: $1=source_url (optional).
conforming_doc() {
  raw_doc "$(printf '%s\n' '<!-- UNTRUSTED-SOURCE -->' 'Preserved source content.' \
    '<!-- /UNTRUSTED-SOURCE -->')" "${1:-}"
}

# ================================ V7 — Edit on the raw store =====================================

# No legitimate Edit flow exists, so an Edit stripping the envelope from an existing raw file blocks.
@test "V7: Edit removing the UNTRUSTED-SOURCE envelope from raw/*.md → blocked, exit 2 (SCOPE-007)" {
  run bash "${RAW_HOOK}" <<<"$(edit_payload "${WIKI_ROOT}/raw/page.md" \
    '<!-- UNTRUSTED-SOURCE -->' '')"
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"SCOPE-007"* ]] || {
    echo "expected SCOPE-007 block: ${output}" >&2
    return 1
  }
}

# Immutability semantic pin: the block is UNCONDITIONAL — an Edit that touches only body prose
# (envelope untouched) still blocks; V7 enforces immutability, it does NOT simulate the post-state.
@test "V7: envelope-preserving Edit on raw/*.md → still blocked, exit 2 (unconditional immutability)" {
  run bash "${RAW_HOOK}" <<<"$(edit_payload "${WIKI_ROOT}/raw/page.md" 'typo' 'fixed')"
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"SCOPE-007"* ]] || {
    echo "expected SCOPE-007 block: ${output}" >&2
    return 1
  }
}

# The block names the correction path (delete + Write re-save), not a dead end.
@test "V7: SCOPE-007 suggestion names the delete + Write re-save correction path" {
  run bash "${RAW_HOOK}" <<<"$(edit_payload "${WIKI_ROOT}/raw/page.md" 'a' 'b')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"immutable"* ]] || {
    echo "message must name immutability: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"re-save"* ]] || {
    echo "suggestion must name re-save path: ${output}" >&2
    return 1
  }
}

# Belt-and-suspenders trigger (literal glass-atrium store path) covers Edit too.
@test "V7: Edit on literal .glass-atrium/wiki/raw path → blocked, exit 2" {
  run bash "${RAW_HOOK}" <<<"$(edit_payload "/Users/u/.glass-atrium/wiki/raw/page.md" 'a' 'b')"
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"SCOPE-007"* ]] || return 1
}

# Trigger scope: an Edit outside the raw store passes untouched.
@test "V7: Edit outside raw/ → exit 0, silent" {
  run bash "${RAW_HOOK}" <<<"$(edit_payload "/tmp/notes/x.md" 'a' 'b')"
  [[ "${status}" -eq 0 ]] || {
    echo "expected exit 0, got ${status}: ${output}" >&2
    return 1
  }
  [[ -z "${output}" ]] || {
    echo "expected silence on non-raw path: ${output}" >&2
    return 1
  }
}

# Trigger scope: the gate is *.md-scoped, so a non-md raw path is out of scope.
@test "V7: Edit on a raw non-.md path → exit 0, silent" {
  run bash "${RAW_HOOK}" <<<"$(edit_payload "${WIKI_ROOT}/raw/page.txt" 'a' 'b')"
  [[ "${status}" -eq 0 ]] || return 1
  [[ -z "${output}" ]] || return 1
}

# ================================== Write — V1-V6 floor ==========================================

# The preserved content carries its own bibliography, the shape retired V3 blocked.
# The zero-output assertion therefore also guards the SCOPE-003 retirement.
@test "Write: conforming raw write (envelope + 3-field frontmatter) → permitted, exit 0" {
  local body content
  body="$(printf '%s\n' '<!-- UNTRUSTED-SOURCE -->' 'Preserved source content.' \
    '## References' '- https://rfc-editor.org/rfc/rfc9110' '<!-- /UNTRUSTED-SOURCE -->')"
  content="$(raw_doc "${body}")"
  run bash "${RAW_HOOK}" <<<"$(raw_write_payload "${content}")"
  [[ "${status}" -eq 0 ]] || {
    echo "expected exit 0 (permit), got ${status}: ${output}" >&2
    return 1
  }
  [[ -z "${output}" ]] || {
    echo "expected no violation output on permit: ${output}" >&2
    return 1
  }
}

# V6 fires on Write: the Edit branch leaves the envelope gate intact.
@test "Write: raw write WITHOUT body envelope → blocked, exit 2 (SCOPE-006 — V6 intact)" {
  local content
  content="$(raw_doc 'Fetched content with no envelope wrapper.')"
  run bash "${RAW_HOOK}" <<<"$(raw_write_payload "${content}")"
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"SCOPE-006"* ]] || {
    echo "expected SCOPE-006 block: ${output}" >&2
    return 1
  }
}

# =========== Bypass guard for the retired content checks (SCOPE-003 / SCOPE-004) ================
# A language signal or a bibliography cannot separate preserved content from aggregation or translation.
# Both checks are retired; a body carrying both shapes still blocks on V6, asserted on non-empty output.
@test "retired checks: Korean heading + bibliography, no envelope → still blocked (SCOPE-006, no SCOPE-003/004)" {
  local content
  content="$(raw_doc "$(printf '%s\n' '## 한국어 섹션 제목' '## References' \
    '- https://rfc-editor.org/rfc/rfc9110' '- https://example.org/spec')")"
  run bash "${RAW_HOOK}" <<<"$(raw_write_payload "${content}")"
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"SCOPE-006"* ]] || {
    echo "expected SCOPE-006: ${output}" >&2
    return 1
  }
  [[ "${output}" != *"SCOPE-003"* ]] || {
    echo "SCOPE-003 is retired, must not fire: ${output}" >&2
    return 1
  }
  [[ "${output}" != *"SCOPE-004"* ]] || {
    echo "SCOPE-004 is retired, must not fire: ${output}" >&2
    return 1
  }
}

# ========================== V8 — destination-state guard (SCOPE-008) ============================
# Check-time state only: no race control, and no ancestor above the immediate parent is resolved.

# Content is fully conforming, so the block can only come from the destination-state guard.
@test "V8: Write onto a symlinked destination → blocked, exit 2 (SCOPE-008)" {
  mkdir -p "${WIKI_ROOT}/raw"
  ln -s "${BATS_TEST_TMPDIR}/elsewhere.md" "${WIKI_ROOT}/raw/page.md"
  run bash "${RAW_HOOK}" <<<"$(raw_write_payload "$(conforming_doc)")"
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"SCOPE-008"* ]] || {
    echo "expected SCOPE-008 block: ${output}" >&2
    return 1
  }
}

# The destination itself does not exist, so only the parent arm can fire.
@test "V8: Write under a symlinked parent directory → blocked, exit 2 (SCOPE-008)" {
  mkdir -p "${WIKI_ROOT}" "${BATS_TEST_TMPDIR}/real-store"
  ln -s "${BATS_TEST_TMPDIR}/real-store" "${WIKI_ROOT}/raw"
  run bash "${RAW_HOOK}" <<<"$(raw_write_payload "$(conforming_doc)")"
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"SCOPE-008"* ]] || {
    echo "expected SCOPE-008 block: ${output}" >&2
    return 1
  }
}

# The guard neither short-circuits the content checks nor substitutes for them.
@test "V8: non-existent destination under real dirs still reaches V6 (SCOPE-006, not SCOPE-008)" {
  mkdir -p "${WIKI_ROOT}/raw"
  run bash "${RAW_HOOK}" <<<"$(raw_write_payload "$(raw_doc 'No envelope here.')")"
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"SCOPE-006"* ]] || {
    echo "expected SCOPE-006: ${output}" >&2
    return 1
  }
  [[ "${output}" != *"SCOPE-008"* ]] || {
    echo "guard must not fire on a real parent: ${output}" >&2
    return 1
  }
}

# Reach pin: V7 precedes V8, so an Edit onto a symlinked destination reports SCOPE-007; the guard is Write-only in practice.
@test "V8: Edit onto a symlinked raw destination → SCOPE-007 (V7 precedes the guard)" {
  mkdir -p "${WIKI_ROOT}/raw"
  ln -s "${BATS_TEST_TMPDIR}/elsewhere.md" "${WIKI_ROOT}/raw/page.md"
  run bash "${RAW_HOOK}" <<<"$(edit_payload "${WIKI_ROOT}/raw/page.md" 'a' 'b')"
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"SCOPE-007"* ]] || {
    echo "expected SCOPE-007: ${output}" >&2
    return 1
  }
  [[ "${output}" != *"SCOPE-008"* ]] || {
    echo "V7 must win the ordering: ${output}" >&2
    return 1
  }
}

# Trigger scope: a symlinked destination outside the raw store is none of the gate's business.
@test "V8: symlinked destination outside raw/ → exit 0, silent" {
  mkdir -p "${BATS_TEST_TMPDIR}/notes"
  ln -s "${BATS_TEST_TMPDIR}/elsewhere.md" "${BATS_TEST_TMPDIR}/notes/x.md"
  run bash "${RAW_HOOK}" <<<"$(write_payload_at "${BATS_TEST_TMPDIR}/notes/x.md" 'anything')"
  [[ "${status}" -eq 0 ]] || {
    echo "expected exit 0, got ${status}: ${output}" >&2
    return 1
  }
  [[ -z "${output}" ]] || {
    echo "expected silence on non-raw path: ${output}" >&2
    return 1
  }
}

# =================== S1 — physical containment of the trigger (inbound directions) ==============
# The literal trigger arms spell one path apiece.
# A dot-dot traversal or an inbound symlink reaches the store only through physical containment.

@test "S1: dot-dot traversal into raw/ is triggered → envelope-less write blocked (SCOPE-006)" {
  mkdir -p "${WIKI_ROOT}/raw" "${WIKI_ROOT}/notes"
  run bash "${RAW_HOOK}" <<<"$(write_payload_at "${WIKI_ROOT}/notes/../raw/b.md" "$(raw_doc 'no envelope')")"
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"SCOPE-006"* ]] || {
    echo "expected SCOPE-006: ${output}" >&2
    return 1
  }
}

# Containment brings the inbound link into scope, and V8 is what refuses it.
@test "S1: symlink from outside pointing INTO raw/ is triggered → blocked (SCOPE-008)" {
  mkdir -p "${WIKI_ROOT}/raw"
  ln -s "${WIKI_ROOT}/raw" "${BATS_TEST_TMPDIR}/link-in"
  run bash "${RAW_HOOK}" <<<"$(write_payload_at "${BATS_TEST_TMPDIR}/link-in/c.md" "$(raw_doc 'no envelope')")"
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"SCOPE-008"* ]] || {
    echo "expected SCOPE-008: ${output}" >&2
    return 1
  }
}

# Symmetry pin: the store root is canonicalized too. A /tmp-rooted store (macOS /tmp → /private/tmp)
# would false-negative every physical comparison if only the destination side were resolved.
@test "S1: /tmp-rooted store still triggers through the inbound link (both sides canonicalized)" {
  local root
  root="$(mktemp -d /tmp/rawstore.XXXXXX)"
  mkdir -p "${root}/wiki/raw"
  ln -s "${root}/wiki/raw" "${root}/link-in"
  WIKI_ROOT="${root}/wiki" run bash "${RAW_HOOK}" \
    <<<"$(write_payload_at "${root}/link-in/c.md" "$(raw_doc 'no envelope')")"
  rm -rf "${root}"
  [[ "${status}" -eq 2 ]] || {
    echo "expected exit 2, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"SCOPE-008"* ]] || {
    echo "expected SCOPE-008: ${output}" >&2
    return 1
  }
}

# Containment is a trigger widening, not a blanket block: a conforming labelled write to a real
# path inside the store still lands, dot-dot spelling included.
@test "S1: labelled write via dot-dot traversal → permitted, exit 0" {
  mkdir -p "${WIKI_ROOT}/raw" "${WIKI_ROOT}/notes"
  run bash "${RAW_HOOK}" <<<"$(write_payload_at "${WIKI_ROOT}/notes/../raw/ok.md" "$(conforming_doc)")"
  [[ "${status}" -eq 0 ]] || {
    echo "expected exit 0, got ${status}: ${output}" >&2
    return 1
  }
}

# The block names the correction path, and the context carries both inspected arms.
@test "V8: SCOPE-008 block names the real-path correction and reports the parent in context" {
  mkdir -p "${WIKI_ROOT}/raw"
  ln -s "${BATS_TEST_TMPDIR}/elsewhere.md" "${WIKI_ROOT}/raw/page.md"
  run bash "${RAW_HOOK}" <<<"$(raw_write_payload "$(conforming_doc)")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"symbolic link"* ]] || {
    echo "message must name the state: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"real path"* ]] || {
    echo "suggestion must name the correction: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"${WIKI_ROOT}/raw"* ]] || {
    echo "context must carry the parent: ${output}" >&2
    return 1
  }
}

# ============ Retired advisory surface (SCOPE-009 / SCOPE-010 / SCOPE-011) ======================
#
# The gate once carried a warn channel: an overwrite advisory plus a WebFetch-ledger pair, both exit-0
# telemetry. All three codes are retired, so the permit path is silent and no warn code may ever appear.
# These two cases are the retirement guard, in the same role the SCOPE-003/004 case plays above.

# An overwrite is now a silent permit. An existing regular file is also no symlink, so V8 must stay quiet
# on it — the destination-exists class that the non-existent-destination case above cannot cover.
@test "permit path: Write over an existing raw file → exit 0, silent (no SCOPE-009, no SCOPE-008)" {
  mkdir -p "${WIKI_ROOT}/raw"
  : >"${WIKI_ROOT}/raw/page.md"
  run bash "${RAW_HOOK}" <<<"$(raw_write_payload "$(conforming_doc)")"
  [[ "${status}" -eq 0 ]] || {
    echo "expected exit 0, got ${status}: ${output}" >&2
    return 1
  }
  [[ -z "${output}" ]] || {
    echo "overwrite must be silent — the advisory channel is retired: ${output}" >&2
    return 1
  }
}

# Blocking is independent of the envelope's session metadata: transcript_path and session_id are no longer
# read at all, and no retired warn code may appear beside the block.
@test "blocked write with session + transcript envelope fields → SCOPE-006 alone, no retired warn code" {
  run bash "${RAW_HOOK}" \
    <<<"$(raw_write_payload_with_transcript "$(raw_doc 'No envelope here.')" "${BATS_TEST_TMPDIR}/session.jsonl")"
  [[ "${status}" -eq 2 && "${output}" == *"SCOPE-006"* ]] || {
    echo "expected exit 2 + SCOPE-006, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" != *"SCOPE-009"* && "${output}" != *"SCOPE-010"* && "${output}" != *"SCOPE-011"* ]] || {
    echo "retired warn codes must never fire: ${output}" >&2
    return 1
  }
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
