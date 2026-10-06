#!/usr/bin/env bats
# inject-scope-rules-canary.bats — home of the slot-1 canary block: the per-agent canary file contract,
# its 1200 B cap, byte-exact delivery and the shed order wiki-untrusted → budget-analysis → budget-dev
# → canary.
#
#   Delivered is read from two observables: the canary text in additionalContext, and a `canary:` entry
#   in the manifest line's `blocks=` list (the only witness for an empty text, which adds no bytes).
#   Only the treatment arm (sha256 of the salt then the agent_id, mod 2, equal to 1) receives the text;
#   the fixtures' salt 7 puts agent_id a1 in that arm (test_manifest_ingest.py pins the arm to hashlib).
#
# BATS GATING NOTE: @test bodies run under errexit; a mid-body bare `[[ ]]` is inert on bash 3.2.57 but
#   gates on CI's bash 5.x, so every assertion `return 1`s on mismatch.

HOOK_SH="${BATS_TEST_DIRNAME}/../inject-scope-rules.sh"
REPO_ROOT="${BATS_TEST_DIRNAME}/../.."
AGENT="glass-atrium-dev-front"
EMIT_NEEDLE="REQUIRED by the outcome recorder"
SENTINEL="CANARY_TRIAL_SENTINEL"
# The hook's maximum lease (inject-scope-rules.sh → CANARY_MAX_LEASE_MINUTES), in minutes.
MAX_LEASE_MINUTES=5760
# The hook's tolerance for an mtime ahead of now (inject-scope-rules.sh → CANARY_MTIME_SKEW_SECONDS).
MTIME_SKEW_MINUTES=5

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  export GA_DATA_ROOT="${BATS_TEST_TMPDIR}/data-root"
  CANARY_DIR="${GA_DATA_ROOT}/data/learning/canary"
  mkdir -p "${CANARY_DIR}"
  export INJECT_SCOPE_RULES_DROP_LOG="${BATS_TEST_TMPDIR}/drop.log"
  export INJECT_SCOPE_RULES_SPAWN_COUNTER="${BATS_TEST_TMPDIR}/spawns.count"
  export INJECT_SCOPE_RULES_MANIFEST_LOG="${BATS_TEST_TMPDIR}/manifest.log"
}

# Write a canary file for $1 holding text $2, expiring $3 seconds from now; $4 (optional) replaces the
# stored hash; $5 (optional, default 7) is the salt. The stored hash is Python hashlib over the UTF-8
# text — the daemon's side of the contract.
write_canary() {
  python3 - "${CANARY_DIR}/${1}.json" "${2}" "${3}" "${4:-}" "${5:-7}" <<'PY'
import hashlib, json, sys, time
path, text, offset, forced, salt = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], int(sys.argv[5])
digest = forced or hashlib.sha256(text.encode("utf-8")).hexdigest()
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"salt": salt, "text_sha256": digest, "expires_at": int(time.time()) + offset, "text": text}, fh)
PY
}

# Value of field $1 on the last manifest line; empty when absent.
manifest_field() {
  tail -n 1 "${INJECT_SCOPE_RULES_MANIFEST_LOG}" 2>/dev/null | sed -n "s/.* ${1}=\([^ ]*\) .*/\1/p"
}

# Set $1's mtime to $2 minutes ago, ahead of now when negative (touch -t takes one form on BSD and GNU).
age_file() {
  touch -t "$(python3 -c 'import sys, time; print(time.strftime("%Y%m%d%H%M.%S", time.localtime(time.time() - float(sys.argv[1]) * 60)))' "${2}")" "${1}"
}

# Text of exactly $1 bytes opening with the sentinel.
padded_text() {
  python3 -c 'import sys; s = sys.argv[2] + " "; print(s + "C" * (int(sys.argv[1]) - len(s)), end="")' "${1}" "${SENTINEL}"
}

# One spawn of $1 with the meter off and every rule source absent, so the context is emit + canary;
# extra env assignments ride in $2... The envelope's agent_id is SPAWN_AGENT_ID (default a1; empty →
# no agent_id field). Writes the context to ${BATS_TEST_TMPDIR}/ctx.txt.
spawn() {
  local agent="${1}"
  shift
  run bash -c '
    agent="$1"; hook="$2"; id="$3"; shift 3
    jq -nc --arg a "${agent}" --arg i "${id}" "{agent_type:\$a} + (if \$i == \"\" then {} else {agent_id:\$i} end)" \
      | env SUBAGENT_BUDGET_METER_OFF=1 \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent INJECT_SCOPE_RULES_BUDGET_SRC=/nonexistent \
      INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC=/nonexistent "$@" bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${SPAWN_AGENT_ID-a1}" "$@"
  printf '%s' "${output}" | python3 -c '
import json, sys
for line in sys.stdin:
    if line.startswith("{"):
        sys.stdout.write(json.loads(line)["hookSpecificOutput"]["additionalContext"])
        break
' >"${BATS_TEST_TMPDIR}/ctx.txt"
}

# 0 when the last spawn's manifest line lists the canary block.
manifest_lists_canary() {
  tail -n 1 "${INJECT_SCOPE_RULES_MANIFEST_LOG}" 2>/dev/null | grep -Eq ' blocks=(.*;)?canary:'
}

# Assert the last spawn delivered ($1=1) or withheld ($1=0) the sentinel text, by context and manifest.
assert_delivered() {
  local want="${1}" in_ctx=0 in_manifest=0
  [[ "${status}" -eq 0 ]] || { echo "status ${status}: ${output}"; return 1; }
  # A canary state is a decision, never the fail-open ERR exit.
  [[ "${output}" != *"internal error"* ]] || { echo "ERR trap fired: ${output}"; return 1; }
  grep -qF "${SENTINEL}" "${BATS_TEST_TMPDIR}/ctx.txt" && in_ctx=1
  manifest_lists_canary && in_manifest=1
  [[ "${in_ctx}" -eq "${want}" && "${in_manifest}" -eq "${want}" ]] || {
    echo "delivered want=${want}: context=${in_ctx} manifest=${in_manifest} (${output})"
    return 1
  }
  grep -qF "${EMIT_NEEDLE}" "${BATS_TEST_TMPDIR}/ctx.txt" || { echo "emit block lost: ${output}"; return 1; }
}

# Put a stat stub first on PATH that answers only the $1 form (bsd: -f %m · gnu: -c %Y, with GNU's
# --file-system text and exit 1 for -f · none: every call fails); prints the PATH assignment.
stub_stat() {
  local bin="${BATS_TEST_TMPDIR}/stub-bin-${1}"
  mkdir -p "${bin}"
  cat >"${bin}/stat" <<SH
#!/bin/sh
mtime() { python3 -c 'import os, sys; print(int(os.stat(sys.argv[1]).st_mtime))' "\$1"; }
case "${1}:\$1 \$2" in
  "bsd:-f %m") mtime "\$3" ;;
  "gnu:-c %Y") mtime "\$3" ;;
  "gnu:-f %m") printf '  File: "%s"\n    ID: 0 Namelen: 255\n' "\$3"; exit 1 ;;
  *) exit 1 ;;
esac
SH
  chmod +x "${bin}/stat"
  printf 'PATH=%s\n' "${bin}:${PATH}"
}

# Bring the canary file for ${AGENT} into the state a file-contract row names; prints the extra env the
# spawn needs (one assignment per line), if any.
prepare_row() {
  local file="${CANARY_DIR}/${AGENT}.json"
  case "${1}" in
    absent) : ;;
    valid) write_canary "${AGENT}" "$(padded_text 64)" 3600 ;;
    unparseable) printf '{"salt": 7, "text": "%s"' "${SENTINEL}" >"${file}" ;;
    "field of the wrong type") write_canary "${AGENT}" "$(padded_text 64)" 3600 && python3 -c '
import json, sys
d = json.load(open(sys.argv[1])); d["expires_at"] = str(d["expires_at"]); json.dump(d, open(sys.argv[1], "w"))
' "${file}" ;;
    "hash mismatch") write_canary "${AGENT}" "$(padded_text 64)" 3600 "$(printf '%064d' 0)" ;;
    "two concatenated JSON values") write_canary "${AGENT}" "$(padded_text 64)" 3600 && printf '%s' '{"text": ""}' >>"${file}" ;;
    expired) write_canary "${AGENT}" "$(padded_text 64)" -60 ;;
    "embedded expiry within the maximum lease") write_canary "${AGENT}" "$(padded_text 64)" $(((MAX_LEASE_MINUTES - 60) * 60)) ;;
    "embedded expiry beyond now + maximum lease") write_canary "${AGENT}" "$(padded_text 64)" $(((MAX_LEASE_MINUTES + 60) * 60)) ;;
    "aged within the lease") write_canary "${AGENT}" "$(padded_text 64)" 3600 && age_file "${file}" $((MAX_LEASE_MINUTES - 60)) ;;
    "aged past the lease") write_canary "${AGENT}" "$(padded_text 64)" 3600 && age_file "${file}" $((MAX_LEASE_MINUTES + 60)) ;;
    "mtime ahead within the skew tolerance") write_canary "${AGENT}" "$(padded_text 64)" 3600 && age_file "${file}" $((1 - MTIME_SKEW_MINUTES)) ;;
    "mtime in the future") write_canary "${AGENT}" "$(padded_text 64)" 3600 && age_file "${file}" $((-1 - MTIME_SKEW_MINUTES)) ;;
    "mtime unreadable") write_canary "${AGENT}" "$(padded_text 64)" 3600 && stub_stat none ;;
    "mtime read by the BSD stat form") write_canary "${AGENT}" "$(padded_text 64)" 3600 && stub_stat bsd ;;
    "mtime read by the GNU stat form") write_canary "${AGENT}" "$(padded_text 64)" 3600 && stub_stat gnu ;;
    "at the cap") write_canary "${AGENT}" "$(padded_text 1200)" 3600 ;;
    "over the cap by one byte") write_canary "${AGENT}" "$(padded_text 1201)" 3600 ;;
    "no digest tool")
      write_canary "${AGENT}" "$(padded_text 64)" 3600
      printf 'INJECT_SCOPE_RULES_DIGEST_CMD=%s\n' "${BATS_TEST_TMPDIR}/absent-digest-tool"
      ;;
    "symlink to a valid file")
      mkdir -p "${BATS_TEST_TMPDIR}/elsewhere"
      CANARY_DIR="${BATS_TEST_TMPDIR}/elsewhere" write_canary "${AGENT}" "$(padded_text 64)" 3600
      ln -s "${BATS_TEST_TMPDIR}/elsewhere/${AGENT}.json" "${file}"
      ;;
    *) echo "unknown row ${1}" >&2; return 1 ;;
  esac
}

@test "the canary text is delivered exactly when its file meets the file contract" {
  local row want env_lines line
  local -a extra rows=(
    "absent:0" "valid:1" "unparseable:0" "two concatenated JSON values:0"
    "field of the wrong type:0" "hash mismatch:0" "expired:0"
    "embedded expiry within the maximum lease:1" "embedded expiry beyond now + maximum lease:0"
    "aged within the lease:1" "aged past the lease:0" "mtime ahead within the skew tolerance:1"
    "mtime in the future:0" "mtime unreadable:0" "mtime read by the BSD stat form:1"
    "mtime read by the GNU stat form:1" "at the cap:1"
    "over the cap by one byte:0" "no digest tool:0" "symlink to a valid file:0"
  )
  for entry in "${rows[@]}"; do
    row="${entry%:*}"
    want="${entry##*:}"
    # A fresh data root per row, so no row inherits another's file.
    GA_DATA_ROOT="${BATS_TEST_TMPDIR}/root-${row// /-}"
    CANARY_DIR="${GA_DATA_ROOT}/data/learning/canary"
    mkdir -p "${CANARY_DIR}"
    env_lines="$(prepare_row "${row}")" || { echo "${row}: fixture failed"; return 1; }
    extra=()
    while IFS= read -r line; do
      if [[ -n "${line}" ]]; then extra+=("${line}"); fi
    done <<<"${env_lines}"
    spawn "${AGENT}" ${extra[@]+"${extra[@]}"}
    assert_delivered "${want}" || { echo "row: ${row}"; return 1; }
  done
}

@test "an over-cap canary is refused whole: no truncated prefix reaches the context" {
  write_canary "${AGENT}" "$(padded_text 1300)" 3600
  spawn "${AGENT}"
  assert_delivered 0 || return 1
  ! grep -qF "CCCC" "${BATS_TEST_TMPDIR}/ctx.txt" || { echo "a truncated canary prefix was injected"; return 1; }
}

@test "the hook's text hash equals Python hashlib over the exact text bytes, delivered byte-exact" {
  local row text
  # name|text — each text must reach the context unchanged, as the context's last block.
  local -a rows=(
    "trailing newline|${SENTINEL} line one
line two
"
    "multibyte|${SENTINEL} 한글 · → 🚀"
    "plain|${SENTINEL} plain"
  )
  for entry in "${rows[@]}"; do
    row="${entry%%|*}"
    text="${entry#*|}"
    write_canary "${AGENT}" "${text}" 3600
    spawn "${AGENT}"
    assert_delivered 1 || { echo "row: ${row}"; return 1; }
    python3 -c '
import sys
ctx = open(sys.argv[1], "rb").read()
sys.exit(0 if ctx.endswith(b"\n\n" + sys.argv[2].encode("utf-8")) else 1)
' "${BATS_TEST_TMPDIR}/ctx.txt" "${text}" || { echo "row: ${row} — delivered bytes differ from the file text"; return 1; }
  done
}

@test "a hash taken over the newline-stripped text does not match a text ending in a newline" {
  local text="${SENTINEL} ends in a newline
"
  write_canary "${AGENT}" "${text}" 3600 "$(printf '%s' "${SENTINEL} ends in a newline" | python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())')"
  spawn "${AGENT}"
  assert_delivered 0
}

@test "a valid empty canary is delivered with zero added bytes: treatment context equals control" {
  local repo_env=(
    INJECT_SCOPE_RULES_BUDGET_SRC="${REPO_ROOT}/scoped/shared-turn-budget.md"
    INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC="${REPO_ROOT}/rules/glass-atrium/core-wiki-reference.md"
    INJECT_SCOPE_RULES_AGENTS_DIR="${REPO_ROOT}/agents"
  )
  run bash -c 'jq -nc "{agent_type:\"glass-atrium-qa-code-reviewer\"}" | env -u SUBAGENT_BUDGET_METER_OFF "$@" bash "'"${HOOK_SH}"'"' _ "${repo_env[@]}"
  [[ "${status}" -eq 0 ]] || { echo "control: ${output}"; return 1; }
  printf '%s' "${output}" | jq -j '.hookSpecificOutput.additionalContext' >"${BATS_TEST_TMPDIR}/control.txt"
  ! manifest_lists_canary || { echo "control spawn lists a canary"; return 1; }

  write_canary "glass-atrium-qa-code-reviewer" "" 3600
  run bash -c 'jq -nc "{agent_type:\"glass-atrium-qa-code-reviewer\", agent_id:\"a1\"}" | env -u SUBAGENT_BUDGET_METER_OFF "$@" bash "'"${HOOK_SH}"'"' _ "${repo_env[@]}"
  [[ "${status}" -eq 0 ]] || { echo "treatment: ${output}"; return 1; }
  printf '%s' "${output}" | jq -j '.hookSpecificOutput.additionalContext' >"${BATS_TEST_TMPDIR}/treatment.txt"
  manifest_lists_canary || { echo "empty canary not recorded as delivered: $(tail -n 1 "${INJECT_SCOPE_RULES_MANIFEST_LOG}")"; return 1; }
  # The record carries the empty text's hash, the value the daemon's hashlib computes for b"".
  local empty_hash
  empty_hash="$(python3 -c 'import hashlib; print(hashlib.sha256(b"").hexdigest())')"
  [[ "${empty_hash}" == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" ]] || { echo "hashlib: ${empty_hash}"; return 1; }
  [[ "$(manifest_field delivered)" == "1" && "$(manifest_field delivered_hash)" == "${empty_hash}" ]] || {
    echo "empty canary record: $(tail -n 1 "${INJECT_SCOPE_RULES_MANIFEST_LOG}")"
    return 1
  }
  cmp -s "${BATS_TEST_TMPDIR}/control.txt" "${BATS_TEST_TMPDIR}/treatment.txt" || {
    echo "treatment context differs from control: $(wc -c <"${BATS_TEST_TMPDIR}/treatment.txt")B vs $(wc -c <"${BATS_TEST_TMPDIR}/control.txt")B"
    return 1
  }
}

@test "the canary reaches exactly the treatment-arm spawns, and the arms split near evenly" {
  local i arm delivered in_ctx treated=0 n=48
  write_canary "${AGENT}" "$(padded_text 64)" 3600
  for ((i = 0; i < n; i++)); do
    SPAWN_AGENT_ID="spawn-${i}" spawn "${AGENT}"
    [[ "${status}" -eq 0 ]] || { echo "spawn-${i}: ${output}"; return 1; }
    arm="$(manifest_field arm)"
    delivered="$(manifest_field delivered)"
    in_ctx=0
    grep -qF "${SENTINEL}" "${BATS_TEST_TMPDIR}/ctx.txt" && in_ctx=1
    [[ "${arm}" == "0" || "${arm}" == "1" ]] || { echo "spawn-${i}: arm [${arm}]"; return 1; }
    [[ "${delivered}" == "${arm}" && "${in_ctx}" == "${arm}" ]] || {
      echo "spawn-${i}: arm ${arm}, delivered ${delivered}, in context ${in_ctx}"
      return 1
    }
    treated=$((treated + arm))
  done
  # Fixed ids, so the split is fixed; the bound is about 3 standard deviations of a fair split.
  ((treated >= 14 && treated <= 34)) || { echo "treatment arm holds ${treated} of ${n}"; return 1; }
}

@test "a spawn with no agent_id gets no canary and no arm, even beside a valid file" {
  write_canary "${AGENT}" "$(padded_text 64)" 3600
  SPAWN_AGENT_ID="" spawn "${AGENT}"
  assert_delivered 0 || return 1
  [[ "$(manifest_field agent_id)" == "unknown" && "$(manifest_field arm)" == "none" ]] || {
    echo "unknown spawn record: $(tail -n 1 "${INJECT_SCOPE_RULES_MANIFEST_LOG}")"
    return 1
  }
}

# Padded block sources for the shed-order rows: every droppable block carries $1 pad bytes.
write_padded_sources() {
  local pad="${1}"
  {
    printf '%s\n' '<!-- AGENT-INJECT:BUDGET-DEV:START -->' '**BD_NEEDLE**'
    head -c "${pad}" /dev/zero | tr '\0' 'X'
    printf '\n%s\n' '<!-- AGENT-INJECT:BUDGET-DEV:END -->'
    printf '%s\n' '<!-- AGENT-INJECT:BUDGET-ANALYSIS:START -->' '**BA_NEEDLE**'
    head -c "${pad}" /dev/zero | tr '\0' 'X'
    printf '\n%s\n' '<!-- AGENT-INJECT:BUDGET-ANALYSIS:END -->'
  } >"${BATS_TEST_TMPDIR}/budget.md"
  {
    printf '%s\n' '<!-- AGENT-INJECT:WIKI-UNTRUSTED:START -->' '**WIKI_NEEDLE**'
    head -c "${pad}" /dev/zero | tr '\0' 'X'
    printf '\n%s\n' '<!-- AGENT-INJECT:WIKI-UNTRUSTED:END -->'
  } >"${BATS_TEST_TMPDIR}/wiki.md"
}

# One spawn of $1 over the padded sources under ceiling $2.
spawn_padded() {
  spawn "${1}" INJECT_SCOPE_RULES_BUDGET_SRC="${BATS_TEST_TMPDIR}/budget.md" \
    INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC="${BATS_TEST_TMPDIR}/wiki.md" INJECT_SCOPE_RULES_CTX_MAX_BYTES="${2}"
}

@test "under full pressure the droppable blocks shed in the order wiki-untrusted, budget-analysis, budget-dev, canary" {
  local row agent want got
  # agent|shed sequence — the rosters are disjoint, so two agents cover every droppable block.
  local -a rows=(
    "glass-atrium-qa-code-reviewer|wiki-untrusted budget-analysis canary"
    "glass-atrium-dev-front|budget-dev canary"
  )
  write_padded_sources 2000
  for entry in "${rows[@]}"; do
    agent="${entry%%|*}"
    want="${entry#*|}"
    : >"${INJECT_SCOPE_RULES_DROP_LOG}"
    write_canary "${agent}" "$(padded_text 1200)" 3600
    # Emit alone exceeds 600 B, so every droppable block must go.
    spawn_padded "${agent}" 600
    [[ "${status}" -eq 0 ]] || { echo "${agent}: ${output}"; return 1; }
    got="$(sed -n 's/.* DROP agent=[^ ]* block=\([^ ]*\) .*/\1/p' "${INJECT_SCOPE_RULES_DROP_LOG}" | tr '\n' ' ')"
    [[ "${got}" == "${want} " ]] || { echo "${agent}: shed [${got}], want [${want} ]"; return 1; }
    ! manifest_lists_canary || { echo "${agent}: a shed canary is recorded as delivered"; return 1; }
    grep -qF "${EMIT_NEEDLE}" "${BATS_TEST_TMPDIR}/ctx.txt" || { echo "${agent}: emit lost"; return 1; }
  done
}

@test "the canary is the last droppable block: when shedding budget-dev restores the fit, the canary stays" {
  local base ceiling
  write_padded_sources 3000
  write_canary "${AGENT}" "$(padded_text 1200)" 3600
  spawn_padded "${AGENT}" 20000
  [[ "${status}" -eq 0 ]] || { echo "${output}"; return 1; }
  base="$(wc -c <"${BATS_TEST_TMPDIR}/ctx.txt" | tr -cd '0-9')"
  # Over by 500 B: shedding the 1200 B canary would also fit, so only the order keeps it.
  ceiling=$((base - 500))
  spawn_padded "${AGENT}" "${ceiling}"
  assert_delivered 1 || return 1
  ! grep -qF "BD_NEEDLE" "${BATS_TEST_TMPDIR}/ctx.txt" || { echo "budget-dev kept, canary order wrong"; return 1; }
}

@test "a shed canary's marker entry names no source path to Read" {
  write_canary "${AGENT}" "$(padded_text 1200)" 3600
  # Emit plus a 1200 B canary cannot fit 1500 B, but emit plus the marker can.
  spawn "${AGENT}" INJECT_SCOPE_RULES_CTX_MAX_BYTES=1500
  assert_delivered 0 || return 1
  grep -qF "canary:" "${BATS_TEST_TMPDIR}/ctx.txt" || { echo "no marker entry for the shed canary: ${output}"; return 1; }
  ! grep -qF "${CANARY_DIR}" "${BATS_TEST_TMPDIR}/ctx.txt" || { echo "marker hands the agent the canary path"; return 1; }
}
