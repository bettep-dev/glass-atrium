#!/usr/bin/env bats
# shellcheck disable=SC2154,SC2312 # BATS_* vars are bats-provided; a failing payload builder surfaces as a failed assertion
# Raw-ingestion gate: V7 Edit immutability, V8 destination state, the V1-V6 floor and the SCOPE-009/010/011 advisories.
# Every check `return 1`s on mismatch: bash 3.2 does not abort on a failing mid-body `[[ ]]`, bash 5.3 does.

RAW_HOOK="${BATS_TEST_DIRNAME}/../validate-pre-write-raw.sh"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  [[ -x "${RAW_HOOK}" ]] || skip "raw-write hook missing: ${RAW_HOOK}"
  # Raw store, HOME and fired log rooted in the Bats tmpdir — no real ~/.glass-atrium state is touched.
  export WIKI_ROOT="${BATS_TEST_TMPDIR}/wiki"
  export HOME="${BATS_TEST_TMPDIR}/home"
  export RAW_FETCH_LEDGER_FIRED_LOG="${BATS_TEST_TMPDIR}/ledger/raw-fetch-ledger-fired.log"
  # An inherited scanner interpreter would move the ledger control rows.
  unset RAW_FETCH_LEDGER_PY
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

# A Write-tool envelope for the raw page carrying session + transcript fields. Args: $1=content $2=transcript_path.
raw_write_payload_with_transcript() {
  jq -nc --arg fp "${WIKI_ROOT}/raw/page.md" --arg c "${1}" --arg tp "${2}" \
    '{tool_name:"Write", session_id:"sess-1", transcript_path:$tp, tool_input:{file_path:$fp, content:$c}}'
}

# A WebFetch tool_use line and its paired result line, in the result shapes real transcripts carry.
# FETCH_SHAPE=lean (default): no toolUseResult and no tool name — a non-2xx outcome shows only as harness text.
# FETCH_SHAPE=full: toolUseResult object carrying url and code.
# FETCH_TEXT: result text in place of the code-derived text, to pin a code the text does not signal.
# $4=true emits the error shape in either mode: is_error plus a string toolUseResult.
# Args: $1=tool_use id $2=url $3=HTTP code, or none for no result $4=is_error (true|false, default false)
#       $5=post-redirect url (default $2).
webfetch_lines() {
  jq -nc --arg id "${1}" --arg u "${2}" \
    '{type:"assistant", message:{content:[{type:"tool_use", id:$id, name:"WebFetch", input:{url:$u}}]}}'
  [[ "${3}" != none ]] || return 0
  jq -nc --arg id "${1}" --arg in "${2}" --arg u "${5:-${2}}" --argjson code "${3}" --argjson err "${4:-false}" \
    --arg shape "${FETCH_SHAPE:-lean}" --arg override "${FETCH_TEXT:-}" '
    (if $code >= 300 and $code < 400 then "REDIRECT DETECTED: The URL redirects to a different host.\n\nOriginal URL: \($in)"
     elif $code >= 400 then "The server returned HTTP \($code).\n\nThe response body was not retrieved."
     else "FETCHED-SUMMARY" end) as $text
    | (if $override != "" then $override else $text end) as $text
    | if $err then
        {type:"user", message:{role:"user", content:[{type:"tool_result", tool_use_id:$id, is_error:true, content:"Invalid URL"}]},
         toolUseResult:"Error: Invalid URL"}
      else
        {type:"user", isSidechain:true, message:{role:"user", content:[{type:"tool_result", tool_use_id:$id, content:$text}]}}
        + (if $shape == "full" then {toolUseResult:{url:$u, code:$code, codeText:"-", bytes:1024, durationMs:300, result:$text}}
           else {} end)
      end'
}

# A transcript that fetched the raw_doc source URL. Args: $1=destination file.
fetched_transcript() {
  webfetch_lines t1 https://example.com/page 200 >"${1}"
}

# A raw-page Write envelope sent by a subagent. Args: $1=content $2=transcript_path $3=agent_id.
subagent_write_payload() {
  jq -nc --arg fp "${WIKI_ROOT}/raw/page.md" --arg c "${1}" --arg tp "${2}" --arg aid "${3}" \
    '{tool_name:"Write", session_id:"sess-1", agent_id:$aid, transcript_path:$tp, tool_input:{file_path:$fp, content:$c}}'
}

# Line count of the fired log; 0 when the log does not exist.
fired_log_lines() {
  if [[ -f "${RAW_FETCH_LEDGER_FIRED_LOG}" ]]; then
    wc -l <"${RAW_FETCH_LEDGER_FIRED_LOG}" | tr -d ' '
  else
    echo 0
  fi
}

# A fully conforming raw document (3-field frontmatter + body envelope): V1-V6 all pass.
# Any code observed on it comes from a non-content check (V7, V8 or an advisory). Args: $1=source_url (optional).
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

# ====================== SCOPE-009 — overwrite advisory and the fired log ==========================
#
# Advisory only: exit status never changes.
# The fired log needs a transcript_path in the envelope, so suites that send none never touch a real log.

@test "SCOPE-009: overwrite with transcript_path → exit 0, advisory only, exactly one log line codes=SCOPE-009" {
  mkdir -p "${WIKI_ROOT}/raw"
  : >"${WIKI_ROOT}/raw/page.md"
  fetched_transcript "${BATS_TEST_TMPDIR}/session.jsonl"
  run bash "${RAW_HOOK}" \
    <<<"$(raw_write_payload_with_transcript "$(conforming_doc)" "${BATS_TEST_TMPDIR}/session.jsonl")"
  [[ "${status}" -eq 0 ]] || {
    echo "expected exit 0, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"SCOPE-009"* ]] || {
    echo "expected SCOPE-009: ${output}" >&2
    return 1
  }
  [[ ! "${output}" =~ SCOPE-00[1-8] ]] || {
    echo "no blocking code may fire: ${output}" >&2
    return 1
  }
  [[ "$(fired_log_lines)" -eq 1 ]] || {
    echo "expected exactly one log line, got $(fired_log_lines)" >&2
    return 1
  }
  grep -q $'\tcodes=SCOPE-009\t' "${RAW_FETCH_LEDGER_FIRED_LOG}" || {
    echo "log line must carry codes=SCOPE-009: $(cat "${RAW_FETCH_LEDGER_FIRED_LOG}")" >&2
    return 1
  }
}

# Hermetic pin for the log rule: no transcript_path → stderr only, the log file is never created.
# An existing regular file is no symlink, so V8 stays silent.
@test "SCOPE-009: overwrite without transcript_path → exit 0, advisory on stderr, no SCOPE-008, log not created" {
  mkdir -p "${WIKI_ROOT}/raw"
  : >"${WIKI_ROOT}/raw/page.md"
  run bash "${RAW_HOOK}" <<<"$(raw_write_payload "$(conforming_doc)")"
  [[ "${status}" -eq 0 ]] || {
    echo "expected exit 0, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"SCOPE-009"* && "${output}" != *"SCOPE-008"* ]] || {
    echo "expected SCOPE-009 and no SCOPE-008: ${output}" >&2
    return 1
  }
  [[ ! -e "${RAW_FETCH_LEDGER_FIRED_LOG}" ]] || {
    echo "log must not be created without transcript_path" >&2
    return 1
  }
}

# ================== Fetch ledger (advisory) — SCOPE-010 and the unavailable path ===================
#
# On the permit path the ledger scans the writer's own transcript for a successful WebFetch of the declared source_url.
# An unresolved transcript or a failed scanner is silent on stderr and leaves one ledger=unavailable log line.
# Neither raises a false SCOPE-010 or changes the exit status.

@test "SCOPE-010: declared source has no successful WebFetch → exit 0 + SCOPE-010 on every row, in both result shapes" {
  local shape row tp FETCH_SHAPE
  for shape in lean full; do
    FETCH_SHAPE="${shape}"
    for row in never-fetched http-404 cross-host-redirect is-error code-only-403; do
      tp="${BATS_TEST_TMPDIR}/${shape}-${row}.jsonl"
      case "${row}" in
        never-fetched) webfetch_lines t1 https://other.example/a 200 >"${tp}" ;;
        http-404) webfetch_lines t1 https://example.com/page 404 >"${tp}" ;;
        cross-host-redirect) webfetch_lines t1 https://example.com/page 301 >"${tp}" ;;
        # The error shape does not vary with FETCH_SHAPE.
        is-error)
          [[ "${shape}" == lean ]] || continue
          webfetch_lines t1 https://example.com/page 200 true >"${tp}"
          ;;
        # Page text with a 403 code: only the code check rejects it.
        code-only-403)
          [[ "${shape}" == full ]] || continue
          FETCH_TEXT=FETCHED-SUMMARY webfetch_lines t1 https://example.com/page 403 >"${tp}"
          ;;
        *) return 1 ;;
      esac
      run bash "${RAW_HOOK}" <<<"$(raw_write_payload_with_transcript "$(conforming_doc)" "${tp}")"
      [[ "${status}" -eq 0 ]] || {
        echo "${shape}/${row}: expected exit 0, got ${status}: ${output}" >&2
        return 1
      }
      [[ "${output}" == *"SCOPE-010"* ]] || {
        echo "${shape}/${row}: expected SCOPE-010: ${output}" >&2
        return 1
      }
    done
  done
}

# A subagent's parent transcript holds none of its fetches, so falling back to it would raise a false SCOPE-010.
# The parent here carries only an unrelated fetch, which makes that fallback visible.
@test "ledger: transcript does not resolve → exit 0, silent, one log line ledger=unavailable reason=transcript" {
  local row payload parent="${BATS_TEST_TMPDIR}/proj/sess-1.jsonl"
  mkdir -p "${parent%/*}"
  webfetch_lines t1 https://other.example/a 200 >"${parent}"
  for row in subagent-own-missing main-session-missing-file; do
    RAW_FETCH_LEDGER_FIRED_LOG="${BATS_TEST_TMPDIR}/ledger/${row}.log"
    case "${row}" in
      subagent-own-missing) payload="$(subagent_write_payload "$(conforming_doc)" "${parent}" a1)" ;;
      main-session-missing-file)
        payload="$(raw_write_payload_with_transcript "$(conforming_doc)" "${BATS_TEST_TMPDIR}/no-such.jsonl")"
        ;;
      *) return 1 ;;
    esac
    run bash "${RAW_HOOK}" <<<"${payload}"
    [[ "${status}" -eq 0 ]] || {
      echo "${row}: expected exit 0, got ${status}: ${output}" >&2
      return 1
    }
    [[ -z "${output}" ]] || {
      echo "${row}: expected no output: ${output}" >&2
      return 1
    }
    [[ "$(fired_log_lines)" -eq 1 ]] || {
      echo "${row}: expected exactly one log line, got $(fired_log_lines)" >&2
      return 1
    }
    grep -q $'\tledger=unavailable\treason=transcript$' "${RAW_FETCH_LEDGER_FIRED_LOG}" || {
      echo "${row}: log must carry ledger=unavailable reason=transcript: $(cat "${RAW_FETCH_LEDGER_FIRED_LOG}")" >&2
      return 1
    }
  done
}

# Whichever file the envelope names, the scan reads the subagent's OWN transcript.
# Each parent-side file holds only an unrelated fetch, so a parent read raises SCOPE-010.
# The envelope-names-own row has no parent file; a wrong route there shows as a ledger=unavailable log line.
@test "ledger: subagent's own transcript holds the fetch → silent, no log line, every route and result shape" {
  local shape row own tp aid FETCH_SHAPE
  for shape in lean full; do
    FETCH_SHAPE="${shape}"
    for row in flat workflow envelope-names-own home-fallback; do
      RAW_FETCH_LEDGER_FIRED_LOG="${BATS_TEST_TMPDIR}/ledger/${shape}-${row}.log"
      tp="${BATS_TEST_TMPDIR}/proj/sess-1.jsonl"
      case "${row}" in
        flat)
          aid=a1
          own="${BATS_TEST_TMPDIR}/proj/sess-1/subagents/agent-a1.jsonl"
          ;;
        workflow)
          aid=a2
          own="${BATS_TEST_TMPDIR}/proj/sess-1/subagents/workflows/wf_1/agent-a2.jsonl"
          ;;
        envelope-names-own)
          aid=a3
          own="${BATS_TEST_TMPDIR}/detached/agent-a3.jsonl"
          tp="${own}"
          ;;
        home-fallback)
          aid=a4
          tp="${BATS_TEST_TMPDIR}/elsewhere/sess-1.jsonl"
          own="${HOME}/.claude/projects/p/sess-1/subagents/agent-a4.jsonl"
          ;;
        *) return 1 ;;
      esac
      mkdir -p "${tp%/*}" "${own%/*}"
      [[ "${tp}" == "${own}" ]] || webfetch_lines t0 https://other.example/a 200 >"${tp}"
      webfetch_lines t1 https://example.com/page 200 >"${own}"
      run bash "${RAW_HOOK}" <<<"$(subagent_write_payload "$(conforming_doc)" "${tp}" "${aid}")"
      [[ "${status}" -eq 0 ]] || {
        echo "${shape}/${row}: expected exit 0, got ${status}: ${output}" >&2
        return 1
      }
      [[ -z "${output}" ]] || {
        echo "${shape}/${row}: expected no output: ${output}" >&2
        return 1
      }
      [[ "$(fired_log_lines)" -eq 0 ]] || {
        echo "${shape}/${row}: expected no log line: $(cat "${RAW_FETCH_LEDGER_FIRED_LOG}")" >&2
        return 1
      }
    done
  done
}

# A scanner failure misread as no-match would raise SCOPE-010, which is what lets each failure row fail.
# Only RAW_FETCH_LEDGER_PY varies, so PATH python3 still parses the envelope and the hook reaches the ledger.
@test "ledger: scanner failure → exit 0, silent, one log line ledger=unavailable reason=scanner; control row → SCOPE-010" {
  local shape row py tp payload FETCH_SHAPE
  printf '#!/bin/sh\nexit 3\n' >"${BATS_TEST_TMPDIR}/py-exit3"
  printf '#!/bin/sh\necho not-a-contract-line\n' >"${BATS_TEST_TMPDIR}/py-garbage"
  chmod +x "${BATS_TEST_TMPDIR}/py-exit3" "${BATS_TEST_TMPDIR}/py-garbage"
  tp="${BATS_TEST_TMPDIR}/session.jsonl"
  {
    webfetch_lines t1 https://other.example/a 200
    webfetch_lines t2 https://other.example/b 200
  } >"${tp}"
  payload="$(raw_write_payload_with_transcript "$(conforming_doc)" "${tp}")"
  for row in no-such-python3 py-exit3 py-garbage; do
    RAW_FETCH_LEDGER_FIRED_LOG="${BATS_TEST_TMPDIR}/ledger/${row}.log"
    py="${BATS_TEST_TMPDIR}/${row}"
    RAW_FETCH_LEDGER_PY="${py}" run bash "${RAW_HOOK}" <<<"${payload}"
    [[ "${status}" -eq 0 ]] || {
      echo "${row}: expected exit 0, got ${status}: ${output}" >&2
      return 1
    }
    [[ -z "${output}" ]] || {
      echo "${row}: expected no output (no SCOPE-010, scanner stderr contained): ${output}" >&2
      return 1
    }
    [[ "$(fired_log_lines)" -eq 1 ]] || {
      echo "${row}: expected exactly one log line, got $(fired_log_lines)" >&2
      return 1
    }
    grep -q $'\tledger=unavailable\treason=scanner$' "${RAW_FETCH_LEDGER_FIRED_LOG}" || {
      echo "${row}: log must carry ledger=unavailable reason=scanner: $(cat "${RAW_FETCH_LEDGER_FIRED_LOG}")" >&2
      return 1
    }
  done
  # The failure rows never run a working scanner, so only the control row varies the result shape.
  for shape in lean full; do
    FETCH_SHAPE="${shape}"
    tp="${BATS_TEST_TMPDIR}/${shape}-session.jsonl"
    {
      webfetch_lines t1 https://other.example/a 200
      webfetch_lines t2 https://other.example/b 200
    } >"${tp}"
    payload="$(raw_write_payload_with_transcript "$(conforming_doc)" "${tp}")"
    # Control row doubles as the both-codes case: never-fetched source plus two other pages → one line, both codes.
    RAW_FETCH_LEDGER_FIRED_LOG="${BATS_TEST_TMPDIR}/ledger/${shape}-control.log"
    run bash "${RAW_HOOK}" <<<"${payload}"
    [[ "${status}" -eq 0 && "${output}" == *"SCOPE-010"* && "${output}" == *"SCOPE-011"* ]] || {
      echo "${shape}/control: expected exit 0 + SCOPE-010 + SCOPE-011, got ${status}: ${output}" >&2
      return 1
    }
    [[ "$(fired_log_lines)" -eq 1 ]] || {
      echo "${shape}/control: expected exactly one log line, got $(fired_log_lines)" >&2
      return 1
    }
    grep -q $'\tcodes=SCOPE-010,SCOPE-011\t.*\tledger=ok\treason=-$' "${RAW_FETCH_LEDGER_FIRED_LOG}" || {
      echo "${shape}/control: log must carry codes=SCOPE-010,SCOPE-011 ledger=ok: $(cat "${RAW_FETCH_LEDGER_FIRED_LOG}")" >&2
      return 1
    }
  done
}

# Both sides are normalized: the fetched-side row varies the input URL.
# Its distinct result url keeps the redirect arm from supplying the match.
@test "ledger: declared URL matches its fetch after normalization → silent, no log line, every row and shape" {
  local shape row declared fetched result tp FETCH_SHAPE
  for shape in lean full; do
    FETCH_SHAPE="${shape}"
    for row in http-upgrade host-case trailing-slash fragment fetched-side; do
      RAW_FETCH_LEDGER_FIRED_LOG="${BATS_TEST_TMPDIR}/ledger/${shape}-${row}.log"
      tp="${BATS_TEST_TMPDIR}/${shape}-${row}.jsonl"
      declared='https://example.com/page'
      fetched='https://example.com/page'
      result=''
      case "${row}" in
        http-upgrade) declared='http://example.com/page' ;;
        host-case) declared='https://Example.COM/page' ;;
        trailing-slash) declared='https://example.com/page/' ;;
        fragment) declared='https://example.com/page#intro' ;;
        fetched-side)
          fetched='HTTP://EXAMPLE.com/page/#top'
          result='https://example.com/landing'
          ;;
        *) return 1 ;;
      esac
      webfetch_lines t1 "${fetched}" 200 false "${result}" >"${tp}"
      run bash "${RAW_HOOK}" <<<"$(raw_write_payload_with_transcript "$(conforming_doc "${declared}")" "${tp}")"
      [[ "${status}" -eq 0 ]] || {
        echo "${shape}/${row}: expected exit 0, got ${status}: ${output}" >&2
        return 1
      }
      [[ -z "${output}" ]] || {
        echo "${shape}/${row}: expected no output: ${output}" >&2
        return 1
      }
      [[ "$(fired_log_lines)" -eq 0 ]] || {
        echo "${shape}/${row}: expected no log line: $(cat "${RAW_FETCH_LEDGER_FIRED_LOG}")" >&2
        return 1
      }
    done
  done
}

# The query stays in the match key (so this write fires SCOPE-010) but never reaches stderr or the log: it can carry a token.
@test "ledger: SCOPE-010 log line carries code and host, never the query string" {
  local tp="${BATS_TEST_TMPDIR}/session.jsonl" line
  RAW_FETCH_LEDGER_FIRED_LOG="${BATS_TEST_TMPDIR}/ledger/query.log"
  webfetch_lines t1 https://example.com/page 200 >"${tp}"
  run bash "${RAW_HOOK}" \
    <<<"$(raw_write_payload_with_transcript "$(conforming_doc 'https://example.com/page?token=s3cret')" "${tp}")"
  [[ "${status}" -eq 0 && "${output}" == *"SCOPE-010"* ]] || {
    echo "expected exit 0 + SCOPE-010 (the query is part of the match), got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" != *"s3cret"* ]] || {
    echo "stderr must not echo the query: ${output}" >&2
    return 1
  }
  [[ "$(fired_log_lines)" -eq 1 ]] || {
    echo "expected exactly one log line, got $(fired_log_lines)" >&2
    return 1
  }
  line="$(cat "${RAW_FETCH_LEDGER_FIRED_LOG}")"
  [[ "${line}" == *$'\tcodes=SCOPE-010\thost=example.com\t'* ]] || {
    echo "log line must carry codes=SCOPE-010 and host=example.com: ${line}" >&2
    return 1
  }
  [[ "${line}" != *"s3cret"* && "${line}" != *"?"* ]] || {
    echo "log line must carry no query string: ${line}" >&2
    return 1
  }
}

# WebFetch reports the post-redirect address in toolUseResult.url, which differs from input.url.
# Full shape only: a lean result carries no final url, so this match cannot exist there.
@test "ledger: redirect whose result url is the declared URL → silent, no log line" {
  local tp="${BATS_TEST_TMPDIR}/session.jsonl" FETCH_SHAPE=full
  RAW_FETCH_LEDGER_FIRED_LOG="${BATS_TEST_TMPDIR}/ledger/redirect.log"
  webfetch_lines t1 https://example.com/old-page 200 false https://example.com/page >"${tp}"
  run bash "${RAW_HOOK}" <<<"$(raw_write_payload_with_transcript "$(conforming_doc)" "${tp}")"
  [[ "${status}" -eq 0 ]] || {
    echo "expected exit 0, got ${status}: ${output}" >&2
    return 1
  }
  [[ -z "${output}" ]] || {
    echo "expected no output: ${output}" >&2
    return 1
  }
  [[ "$(fired_log_lines)" -eq 0 ]] || {
    echo "expected no log line: $(cat "${RAW_FETCH_LEDGER_FIRED_LOG}")" >&2
    return 1
  }
}

# Advisories belong to landing writes: a blocked write never reaches the ledger.
@test "ledger: envelope-less write with an unfetched URL → exit 2 + SCOPE-006, no SCOPE-010, no log line" {
  local tp="${BATS_TEST_TMPDIR}/session.jsonl"
  RAW_FETCH_LEDGER_FIRED_LOG="${BATS_TEST_TMPDIR}/ledger/blocked.log"
  webfetch_lines t1 https://other.example/a 200 >"${tp}"
  run bash "${RAW_HOOK}" <<<"$(raw_write_payload_with_transcript "$(raw_doc 'No envelope here.')" "${tp}")"
  [[ "${status}" -eq 2 && "${output}" == *"SCOPE-006"* ]] || {
    echo "expected exit 2 + SCOPE-006, got ${status}: ${output}" >&2
    return 1
  }
  [[ "${output}" != *"SCOPE-010"* ]] || {
    echo "a blocked write must not draw SCOPE-010: ${output}" >&2
    return 1
  }
  [[ "$(fired_log_lines)" -eq 0 ]] || {
    echo "expected no log line: $(cat "${RAW_FETCH_LEDGER_FIRED_LOG}")" >&2
    return 1
  }
}

# Each malformed line carries the prefilter's "WebFetch" substring, so it reaches the JSON parse instead of being skipped.
@test "ledger: malformed line before the fetch → silent, no log line, fetch still matched, both result shapes" {
  local shape row tp FETCH_SHAPE
  for shape in lean full; do
    FETCH_SHAPE="${shape}"
    for row in truncated-json non-object string-message; do
      RAW_FETCH_LEDGER_FIRED_LOG="${BATS_TEST_TMPDIR}/ledger/${shape}-${row}.log"
      tp="${BATS_TEST_TMPDIR}/${shape}-${row}.jsonl"
      {
        # A 404 is no page, so SCOPE-011 stays out of this case.
        webfetch_lines t0 https://other.example/a 404
        case "${row}" in
          truncated-json) printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"WebFetch"' ;;
          non-object) printf '%s\n' '["WebFetch"]' ;;
          string-message) printf '%s\n' '{"type":"assistant","message":"WebFetch"}' ;;
          *) return 1 ;;
        esac
        webfetch_lines t1 https://example.com/page 200
      } >"${tp}"
      run bash "${RAW_HOOK}" <<<"$(raw_write_payload_with_transcript "$(conforming_doc)" "${tp}")"
      [[ "${status}" -eq 0 ]] || {
        echo "${shape}/${row}: expected exit 0, got ${status}: ${output}" >&2
        return 1
      }
      [[ -z "${output}" ]] || {
        echo "${shape}/${row}: expected no output: ${output}" >&2
        return 1
      }
      [[ "$(fired_log_lines)" -eq 0 ]] || {
        echo "${shape}/${row}: expected no log line: $(cat "${RAW_FETCH_LEDGER_FIRED_LOG}")" >&2
        return 1
      }
    done
  done
}

# Two transcript lines: a Write tool_use and, unless $3 is none, its paired result.
# A real ok result carries neither toolUseResult nor the tool name, so it can only be found by its id.
# Args: $1=tool_use id $2=file_path $3=result (ok|error|none).
write_lines() {
  jq -nc --arg id "${1}" --arg fp "${2}" \
    '{type:"assistant", message:{content:[{type:"tool_use", id:$id, name:"Write", input:{file_path:$fp, content:"x"}}]}}'
  case "${3}" in
    ok) jq -nc --arg id "${1}" \
      '{type:"user", message:{content:[{type:"tool_result", tool_use_id:$id, content:"File created successfully"}]}}' ;;
    error) jq -nc --arg id "${1}" \
      '{type:"user", message:{content:[{type:"tool_result", tool_use_id:$id, is_error:true}]}, toolUseResult:"Error: blocked"}' ;;
    *) ;;
  esac
}

# The page window opens at the last raw Write with a non-error result.
# Every row ends on the in-flight Write, as a real PreToolUse transcript does.
# Every row declares page B, so SCOPE-010 never fires.
@test "SCOPE-011: two distinct pages since the last completed raw write → SCOPE-011, else silent, both shapes" {
  local shape row tp raw="${WIKI_ROOT}/raw" a=https://example.com/a b=https://example.com/page want FETCH_SHAPE
  for shape in lean full; do
    FETCH_SHAPE="${shape}"
    for row in session-start errored-write non-raw-write completed-write same-page failed-fetch \
      cross-host-redirect unpaired-fetch; do
      RAW_FETCH_LEDGER_FIRED_LOG="${BATS_TEST_TMPDIR}/ledger/${shape}-${row}.log"
      tp="${BATS_TEST_TMPDIR}/${shape}-${row}.jsonl"
      want=SCOPE-011
      {
        case "${row}" in
          session-start) webfetch_lines f1 "${a}" 200 ;;
          errored-write) webfetch_lines f1 "${a}" 200 && write_lines w1 "${raw}/a.md" error ;;
          non-raw-write) webfetch_lines f1 "${a}" 200 && write_lines w1 "${BATS_TEST_TMPDIR}/notes/a.md" ok ;;
          completed-write) webfetch_lines f1 "${a}" 200 && write_lines w1 "${raw}/a.md" ok && want='' ;;
          same-page) webfetch_lines f1 'http://Example.com/page/' 200 && want='' ;;
          failed-fetch) webfetch_lines f1 "${a}" 404 && want='' ;;
          # The redirect notice is no page; the follow-up fetch of the declared URL supplies the match.
          cross-host-redirect) webfetch_lines f1 https://old.example/page 301 && want='' ;;
          # An interrupted fetch never got a result.
          unpaired-fetch) webfetch_lines f1 "${a}" none && want='' ;;
          *) return 1 ;;
        esac
        webfetch_lines f2 "${b}" 200
        write_lines w2 "${raw}/page.md" none
      } >"${tp}"
      run bash "${RAW_HOOK}" <<<"$(raw_write_payload_with_transcript "$(conforming_doc)" "${tp}")"
      [[ "${status}" -eq 0 ]] || {
        echo "${shape}/${row}: expected exit 0, got ${status}: ${output}" >&2
        return 1
      }
      if [[ -z "${want}" ]]; then
        [[ -z "${output}" && "$(fired_log_lines)" -eq 0 ]] || {
          echo "${shape}/${row}: expected no output and no log line, got: ${output}" >&2
          return 1
        }
      else
        [[ "${output}" == *"SCOPE-011"* && "${output}" != *"SCOPE-010"* ]] || {
          echo "${shape}/${row}: expected SCOPE-011 alone: ${output}" >&2
          return 1
        }
        grep -q $'\tcodes=SCOPE-011\t.*\tledger=ok\treason=-$' "${RAW_FETCH_LEDGER_FIRED_LOG}" || {
          echo "${shape}/${row}: log must carry codes=SCOPE-011 ledger=ok: $(cat "${RAW_FETCH_LEDGER_FIRED_LOG}" 2>&1)" >&2
          return 1
        }
      fi
    done
  done
}

# A current-CLI success result in the flat subagent layout (lines in the real record shape).
# The result line names no tool and carries no toolUseResult: only its tool_use_id ties it to the fetch.
@test "ledger: fetch result without toolUseResult, then the in-flight raw Write, in a subagent transcript → silent" {
  local tp="${BATS_TEST_TMPDIR}/proj/sess-1.jsonl"
  local own="${BATS_TEST_TMPDIR}/proj/sess-1/subagents/agent-a0000001.jsonl"
  RAW_FETCH_LEDGER_FIRED_LOG="${BATS_TEST_TMPDIR}/ledger/census-s1.log"
  mkdir -p "${own%/*}"
  cat >"${own}" <<'JSONL'
{"type":"assistant","uuid":"u-a1","parentUuid":"u-p0","isSidechain":true,"agentId":"a0000001","sessionId":"s-0001","timestamp":"2026-09-01T00:00:00.000Z","version":"2.1.270","message":{"role":"assistant","id":"msg_01","content":[{"type":"tool_use","id":"toolu_01","name":"WebFetch","input":{"url":"https://example.com/page","prompt":"summarize"}}]}}
{"type":"user","uuid":"u-r1","parentUuid":"u-a1","isSidechain":true,"agentId":"a0000001","sessionId":"s-0001","sessionKind":"bg","slug":"slug-a","promptId":"p-1","sourceToolAssistantUUID":"u-a1","cwd":"/tmp/x","gitBranch":"main","entrypoint":"cli","userType":"external","timestamp":"2026-09-01T00:00:01.000Z","version":"2.1.270","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"FETCHED-SUMMARY"}]}}
JSONL
  write_lines toolu_02 "${WIKI_ROOT}/raw/page.md" none >>"${own}"
  run bash "${RAW_HOOK}" <<<"$(subagent_write_payload "$(conforming_doc)" "${tp}" a0000001)"
  [[ "${status}" -eq 0 ]] || {
    echo "expected exit 0, got ${status}: ${output}" >&2
    return 1
  }
  [[ -z "${output}" ]] || {
    echo "expected no output (no false SCOPE-010): ${output}" >&2
    return 1
  }
  [[ "$(fired_log_lines)" -eq 0 ]] || {
    echo "expected no log line: $(cat "${RAW_FETCH_LEDGER_FIRED_LOG}")" >&2
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
