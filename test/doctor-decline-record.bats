#!/usr/bin/env bats
# doctor-decline-record.bats — pins run_doctor §15 (agent-body merge-decline surface).
#
# scripts/update.sh declines the deploy of any agent body whose EDITABLE-region merge conflicts,
# keeps the LOCAL body, and appends one entry per decline to a durable record. Until §15 nothing
# read that record: the divergence it names reached an operator only through a deploy line that
# scrolls past, and the prescribed hand repair was therefore never forced by anything.
#
# THREE DISTINCT VERDICT TOKENS are the point of this suite. A check that printed one line per entry
# with no date handling would satisfy "surfaces the record" while never building the window it needs,
# so each row below asserts a token the other two rows must NOT produce:
#   AC1  an entry inside the window   -> FAIL, naming the record path AND a declined body, exit != 0
#   AC2  no record at all             -> ok   (the state every CI target home is in)
#   AC3  every entry aged out         -> note (a different token from BOTH of the above), no failure
#   AC4  a mixed record               -> FAIL wins over note — an aged sibling never masks a live one
#   AC5  the record path follows the PRODUCER's own derivation (AUTOAGENT_BACKUP_DIR honoured)
#   AC6  the line grammar §15 classifies on is the one scripts/update.sh writes
#   AC7  a truncated entry is counted as malformed, never dropped
#   AC8-AC12  a declined body equal to its base-store entry at the release hash is a repaired note;
#        a differing, absent or off-release base still FAILs, and a mixed record FAILs on the open body
#
# Hermetic: GA_TARGET_HOME + GA_DATA_ROOT point at throwaway temp dirs, AUTOAGENT_BACKUP_DIR points
# the record derivation at the fixture (the SAME var the producer honours — no test-only seam),
# ATRIUM_UPDATE_STATE_DIR points the base store + baseline manifest at a scratch dir, a
# nonexistent manifest-gen skips §8 hashing and an echo-OK claude stub neutralises the auth
# advisory's live probe. No ~/.claude or ~/.glass-atrium state is read or written.
#
# BATS GATING NOTE: @test bodies run UNDER errexit, so a failing mid-body command aborts the test.
#   ONE shape is platform-split: a bare `[[ ]]` / `(( ))` does not abort on macOS bash 3.2 but DOES
#   on CI bash 5.3 (measured: bash 3.2.57 vs 5.3.9, bats 1.13.0 on BOTH legs — bash is the variable,
#   not bats), while `[ ]`, `let` and a failing `grep -q` abort on both.
#   Every assertion `return 1`s on mismatch, so EACH one independently fails the test on either leg.
#
# Run via: bats test/doctor-decline-record.bats
# Requires: bats >= 1.5.0, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_GA="${GA}/glass-atrium"
UPDATE_SH="${GA}/scripts/update.sh"

setup() {
  [[ -f "${REAL_GA}" ]] || skip "glass-atrium not found: ${REAL_GA}"
  TARGET="$(mktemp -d -t ga-doctor-decline-target.XXXXXX)"
  DATA_ROOT="$(mktemp -d -t ga-doctor-decline-data.XXXXXX)"
  WORK="$(cd -- "$(mktemp -d -t ga-doctor-decline-work.XXXXXX)" && pwd -P)"
  BACKUP_DIR="${WORK}/agents-bak"
  STATE_DIR="${WORK}/update-state" # update state seam → no case reads the real ~/.claude/data/update
  DECLINE_LOG="${WORK}/update-declines/conflict-declines.log"
  mkdir -p "${TARGET}/bin" "${BACKUP_DIR}"
  cat >"${TARGET}/bin/claude" <<'SH'
#!/bin/bash
echo OK
exit 0
SH
  chmod +x "${TARGET}/bin/claude"
  export GA_GENERATE_MANIFEST="${TARGET}/no-such-manifest-gen" # nonexistent → §8 SHA hashing skipped
  export GA_AUTH_CLAUDE_BIN="${TARGET}/bin/claude"            # echo-OK stub → no live claude -p probe
}

teardown() {
  [[ -n "${TARGET:-}" && -d "${TARGET}" ]] && rm -rf -- "${TARGET}" || true
  [[ -n "${DATA_ROOT:-}" && -d "${DATA_ROOT}" ]] && rm -rf -- "${DATA_ROOT}" || true
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Drive the REAL doctor with the target, runtime-data and backup-dir seams at the sandbox. run_doctor
# returns 1 on any FAIL and a sandboxed tree fails other sections too, so an `ok`/`note` row asserts
# on its own verdict LINE rather than on $status; only the FAIL rows assert the exit as well (a FAIL
# line that did not feed the aggregate would be a surface with no consequence).
run_doctor_seam() {
  GA_TARGET_HOME="${TARGET}" GA_DATA_ROOT="${DATA_ROOT}" \
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT}" \
    AUTOAGENT_BACKUP_DIR="${BACKUP_DIR}" ATRIUM_UPDATE_STATE_DIR="${STATE_DIR}" \
    run "${REAL_GA}" doctor
}

# Lay the release anchor §15 compares a declined body against, for the REPO body $1 (GA_ROOT is the
# entry point's own tree, so the live side is never written — only the scratch state dir varies).
# $2 = base entry shape: `equal` copies the live body, `differs` appends a line, `absent` writes none.
# $3 = manifest hash shape: `base` records sha256(base entry), `other` records a hash of nothing.
seed_release_anchor() {
  local rel="$1" base_shape="$2" hash_shape="$3" base_entry hash
  base_entry="${STATE_DIR}/base-agents/${rel##*/}"
  mkdir -p -- "${STATE_DIR}/base-agents"
  case "${base_shape}" in
    equal) cp -- "${GA}/${rel}" "${base_entry}" ;;
    differs) { cat -- "${GA}/${rel}" && printf 'hand edit\n'; } >"${base_entry}" ;;
    absent) ;;
  esac
  hash="$(printf '' | shasum -a 256 | awk '{print $1}')"
  if [[ "${hash_shape}" == base && -f "${base_entry}" ]]; then
    hash="$(shasum -a 256 -- "${base_entry}" | awk '{print $1}')"
  fi
  printf '{"version":"test","hashes":{"%s":"%s"}}\n' "${rel}" "${hash}" >"${STATE_DIR}/baseline-manifest.json"
}

# Append one decline entry dated $1 days ago (0 = now) for the body $2, in the producer's grammar:
# <ISO8601Z>\t<verdict>\t<repo-relative body>\tlocal-body-kept\trepair=<hint>. Hand-written because
# the producer entry needs a genuinely conflicted merge against a full install root; AC6 pins this
# fixture's field order against the producer source so the two cannot drift apart silently.
append_decline() {
  local days_ago="$1" body="$2" ts
  ts="$(date -u -v-"${days_ago}"d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "${days_ago} days ago" +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p -- "$(dirname -- "${DECLINE_LOG}")"
  printf '%s\t%s\t%s\tlocal-body-kept\trepair=live-body-edit+base-store-sync\n' \
    "${ts}" "merge-conflict" "${body}" >>"${DECLINE_LOG}"
}

assert_output_has() {
  [[ "${output}" == *"${1}"* ]] || {
    echo "doctor output missing '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

assert_output_lacks() {
  [[ "${output}" != *"${1}"* ]] || {
    echo "doctor output unexpectedly contains '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# ── AC1 — an in-window entry FAILs, names the record and the body, and exits non-zero ──────────

@test "AC1: an in-window decline entry FAILs, naming the record path and a declined body" {
  append_decline 0 "agents/glass-atrium-dev-shell.md"
  run_doctor_seam
  assert_output_has "FAIL : 1 agent body/bodies declined a merge" || return 1
  assert_output_has "${DECLINE_LOG}" || return 1
  assert_output_has "agents/glass-atrium-dev-shell.md" || return 1
  # the prescribed remedy is a HAND repair, so the line has to carry it — a bare failure would leave
  # an operator with a verdict and no next step.
  assert_output_has "hand-repaired" || return 1
  # a well-formed record raises no malformed-entry note (AC7's negative polarity)
  assert_output_lacks "carry fewer than 3 tab-separated fields" || return 1
  [[ "${status}" -ne 0 ]] || {
    echo "doctor exited 0 despite the §15 FAIL line — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# ── AC2 — no record is the never-declined install, and must stay green ─────────────────────────

@test "AC2: no decline record emits ok and raises no failure of its own" {
  run_doctor_seam
  assert_output_has "ok   : no agent-body merge declines recorded" || return 1
  assert_output_lacks "declined a merge in the last" || return 1
  assert_output_lacks "merge decline(s) recorded, all older than" || return 1
}

# ── AC3 — an aged entry is history: a THIRD token, and no failure ──────────────────────────────

@test "AC3: an entry older than the window emits note — not FAIL and not the absent-record ok" {
  append_decline 30 "agents/glass-atrium-dev-shell.md"
  run_doctor_seam
  assert_output_has "note : 1 agent-body merge decline(s) recorded, all older than" || return 1
  # the token that must NOT appear: a no-parse implementation would emit AC1's line here.
  assert_output_lacks "declined a merge in the last" || return 1
  # nor may it collapse into the absent-record branch — the record IS present.
  assert_output_lacks "no agent-body merge declines recorded" || return 1
}

# ── AC4 — an aged sibling never masks a live entry ─────────────────────────────────────────────

@test "AC4: a record holding both an aged and a live entry FAILs on the live one" {
  append_decline 30 "agents/aged-body.md"
  append_decline 0 "agents/live-body.md"
  run_doctor_seam
  assert_output_has "FAIL : 1 agent body/bodies declined a merge" || return 1
  assert_output_has "agents/live-body.md" || return 1
  # the aged entry is counted out of the window, so the note branch must not also fire.
  assert_output_lacks "all older than" || return 1
}

# ── AC5 — the reader derives the path the way the WRITER does ──────────────────────────────────

@test "AC5: the record is found through the producer's own AUTOAGENT_BACKUP_DIR derivation" {
  # A reader hardcoding a GA_ROOT sibling would report `absent` here: the record sits beside the
  # REDIRECTED backup dir, exactly where update_record_conflict_decline puts it.
  append_decline 0 "agents/redirected-body.md"
  [[ -f "${DECLINE_LOG}" ]] || return 1
  run_doctor_seam
  assert_output_has "${WORK}/update-declines/conflict-declines.log" || return 1
  assert_output_has "agents/redirected-body.md" || return 1
}

# ── AC6 — the grammar §15 classifies on is the producer's ──────────────────────────────────────

@test "AC6: the decline line grammar is the one scripts/update.sh writes" {
  [[ -f "${UPDATE_SH}" ]] || skip "update.sh not found: ${UPDATE_SH}"
  # §15 reads field 1 as the ISO-8601 timestamp and field 3 as the declined body, tab-separated. Pin
  # BOTH against the producer's format string, so a field reorder there fails here instead of
  # silently ageing every entry into (or out of) the window.
  grep -qF "%s\t%s\t%s\tlocal-body-kept" "${UPDATE_SH}" || {
    echo "producer decline-line format changed — §15 keys on <ts>TAB<verdict>TAB<body>" >&2
    grep -n "local-body-kept" "${UPDATE_SH}" >&2
    return 1
  }
  grep -qF 'date -u +%Y-%m-%dT%H:%M:%SZ' "${UPDATE_SH}" || {
    echo "producer decline timestamp is no longer ISO-8601 UTC — the window compare is a string compare" >&2
    return 1
  }
}

# ── AC7 — a truncated entry is counted and surfaced, never silently dropped ────────────────────

@test "AC7: an entry with fewer than three fields is surfaced as a malformed count" {
  append_decline 0 "agents/live-body.md"
  # A truncated write (the updater interrupted mid-append) names no body and carries no timestamp:
  # unclassifiable, so it was dropped and the record read as if it held only the entries it could
  # parse. A blank separator line is NOT an entry and must stay uncounted.
  printf 'truncated-entry-with-no-body\n\n' >>"${DECLINE_LOG}"
  run_doctor_seam
  assert_output_has "note : 1 merge-decline entry/entries carry fewer than 3 tab-separated fields" || return 1
  # additive, never a substitute: the live entry still drives its own FAIL verdict
  assert_output_has "FAIL : 1 agent body/bodies declined a merge" || return 1
  assert_output_has "agents/live-body.md" || return 1
}

# ── AC8-AC12 — a declined body now at its release anchor is repaired, never a standing FAIL ────
# The FAIL claims divergence from the base store, so the check that falsifies it is: live body
# byte-equal to its base-store entry AND that entry at the release hash the updater recorded. Each
# row varies ONE side of that conjunction; GA_ROOT is this repo tree, so only the scratch state moves.

@test "AC8: a declined body equal to its base entry at the release hash is a repaired note, not FAIL" {
  append_decline 0 "agents/glass-atrium-dev-shell.md"
  seed_release_anchor "agents/glass-atrium-dev-shell.md" equal base
  run_doctor_seam
  assert_output_has "note : 1 in-window decline(s) repaired — live body equals its base-store entry at the release hash (reset or landed)" || return 1
  assert_output_lacks "declined a merge in the last" || return 1
  assert_output_lacks "not comparable" || return 1
}

@test "AC9: a declined body differing from its base entry still FAILs" {
  append_decline 0 "agents/glass-atrium-dev-shell.md"
  seed_release_anchor "agents/glass-atrium-dev-shell.md" differs base
  run_doctor_seam
  assert_output_has "FAIL : 1 agent body/bodies declined a merge" || return 1
  assert_output_has "declined body: agents/glass-atrium-dev-shell.md" || return 1
  assert_output_lacks "repaired — live body equals" || return 1
}

@test "AC10: a declined body with no base entry FAILs and says why it is not comparable" {
  append_decline 0 "agents/glass-atrium-dev-shell.md"
  seed_release_anchor "agents/glass-atrium-dev-shell.md" absent base
  run_doctor_seam
  assert_output_has "FAIL : 1 agent body/bodies declined a merge" || return 1
  assert_output_has "note : agents/glass-atrium-dev-shell.md not comparable — no base-store entry" || return 1
}

@test "AC11: a base entry equal to the live body but off the release hash still FAILs" {
  # a hand-synced or contaminated base: live == base proves nothing unless base is the release
  append_decline 0 "agents/glass-atrium-dev-shell.md"
  seed_release_anchor "agents/glass-atrium-dev-shell.md" equal other
  run_doctor_seam
  assert_output_has "FAIL : 1 agent body/bodies declined a merge" || return 1
  assert_output_lacks "repaired — live body equals" || return 1
}

@test "AC12: one repaired and one open body FAIL on the open body alone" {
  append_decline 0 "agents/glass-atrium-dev-shell.md"
  append_decline 0 "agents/glass-atrium-dev-node.md"
  seed_release_anchor "agents/glass-atrium-dev-shell.md" equal base # dev-node gets no base entry
  run_doctor_seam
  assert_output_has "FAIL : 1 agent body/bodies declined a merge" || return 1
  assert_output_has "declined body: agents/glass-atrium-dev-node.md" || return 1
  assert_output_lacks "declined body: agents/glass-atrium-dev-shell.md" || return 1
  assert_output_has "note : 1 in-window decline(s) repaired" || return 1
  [[ "${status}" -ne 0 ]] || return 1
}
