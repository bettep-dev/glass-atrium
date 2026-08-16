#!/usr/bin/env bats
# doctor-apply-abort-rows.bats — pins run_doctor §14 (autoagent apply-abort surface).
#
# WHY THIS SECTION EXISTS: daemon-apply.sh loud-fails exit 16 when the green-suite gate cannot
# certify the harness, and the launchd path discards its stderr. The abort row in the daily
# applied-log JSONL is the only durable trace, and until §14 nothing ever read it — doctor reported
# a healthy install while the daemon had applied nothing for days.
#
# GRAMMAR: §14 classifies on row tokens owned by another file. `"status":"abort"` is the sole
# abort-class literal — written by the pre-gate preflight abort AND by the post-gate backlog
# anomaly tripwire, which is why the axis is the literal rather than the gate stage; every other
# literal is a non-abort literal the classifier treats alike. The abort fixture is therefore
# PRODUCER-AUTHORED (the real daemon-apply.sh is driven into its root-absence abort against the
# fixture reports dir), so a producer-side rename fails these tests instead of degrading the check.
# Superseding rows need the heavier producer harness (PATH mirror, psql shim, report fixture), so
# they are hand-written AND the producer's whole literal set is pinned in AC5 and AC7.
#
# ACs pinned here:
#   AC1  an in-window abort row with no later non-abort row FAILs and names the clause.
#   AC2  a later landed-patch row supersedes the abort → ok.
#   AC3  no rows at all → ok, never an error.
#   AC4  an abort row older than the window is history → ok.
#   AC5  the producer literals §14 classifies on are the ones daemon-apply.sh writes.
#   AC6  a later NON-landing non-abort row (skip/reject/needs_regen/dryrun/error) also supersedes —
#        a recovered daemon with nothing eligible to apply never lands a patch, so keying only on
#        `applied` would hold the verdict red for the rest of the window.
#   AC7  the producer's full status-literal set is the one the abort/non-abort split assumes, so a
#        NEW unclassified literal fails loudly instead of being read as recovery.
#   AC8  a post-gate backlog-anomaly abort is classified as an abort (not as recovery) and its FAIL
#        line names ITS remedy, not the green-suite gate's.
#
# Run via: bats test/doctor-apply-abort-rows.bats
# Requires: bats, bash 3.2+, python3
#
# Hermetic: GA_TARGET_HOME + GA_DATA_ROOT point at throwaway temp dirs and DOCTOR_AUTH_REPORTS_DIR
# points the daemon-reports seam at the fixture dir (the SAME seam var the headless-auth advisory
# already honours — one dir, never two). A nonexistent manifest-gen skips §8 hashing and an echo-OK
# claude stub neutralises the auth advisory's live probe. No ~/.claude or ~/.glass-atrium state is
# read or written.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail.
#   Every assertion `return 1`s on mismatch, so EACH one independently fails the test.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_GA="${GA}/glass-atrium"
APPLY_SH="${GA}/autoagent/daemon-apply.sh"

setup() {
  [[ -f "${REAL_GA}" ]] || skip "glass-atrium not found: ${REAL_GA}"
  [[ -f "${APPLY_SH}" ]] || skip "daemon-apply.sh not found: ${APPLY_SH}"
  TARGET="$(mktemp -d -t ga-doctor-abort-target.XXXXXX)"
  DATA_ROOT="$(mktemp -d -t ga-doctor-abort-data.XXXXXX)"
  WORK="$(cd -- "$(mktemp -d -t ga-doctor-abort-work.XXXXXX)" && pwd -P)"
  REPORTS="${DATA_ROOT}/data/daemon-reports"
  mkdir -p "${TARGET}/bin" "${REPORTS}" "${WORK}/agents" "${WORK}/home"
  cat >"${TARGET}/bin/claude" <<'SH'
#!/bin/bash
echo OK
exit 0
SH
  chmod +x "${TARGET}/bin/claude"
  export GA_GENERATE_MANIFEST="${TARGET}/no-such-manifest-gen" # nonexistent → §8 SHA hashing skipped
  export GA_AUTH_CLAUDE_BIN="${TARGET}/bin/claude"            # echo-OK stub → no live claude -p probe
  TODAY="$(date -u +%Y-%m-%d)"
}

teardown() {
  [[ -n "${TARGET:-}" && -d "${TARGET}" ]] && rm -rf -- "${TARGET}" || true
  [[ -n "${DATA_ROOT:-}" && -d "${DATA_ROOT}" ]] && rm -rf -- "${DATA_ROOT}" || true
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# Drive the REAL doctor with the target, runtime-data and daemon-reports seams at the sandbox.
# run_doctor returns 1 on any FAIL, but a sandboxed tree fails other sections too, so the assertions
# are on the §14 verdict LINE (its `FAIL :` prefix is exactly what feeds the aggregate), not $status.
run_doctor_seam() {
  GA_TARGET_HOME="${TARGET}" GA_DATA_ROOT="${DATA_ROOT}" \
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT}" \
    DOCTOR_AUTH_REPORTS_DIR="${REPORTS}" run "${REAL_GA}" doctor
}

# Drive the REAL daemon into its root-absence preflight abort so the abort row under test is
# producer-authored. $1 = the applied-log date to write under (the daemon keys on the UTC date, so a
# non-today date is produced by writing today's file then renaming it).
emit_abort_row() {
  local sandbox="${WORK}/real"
  mkdir -p -- "${sandbox}/autoagent/lib" "${sandbox}/scripts/lib"
  cp -p -- "${APPLY_SH}" "${sandbox}/autoagent/daemon-apply.sh"
  cp -p -- "${GA}/autoagent/lib/git-txn.sh" "${sandbox}/autoagent/lib/git-txn.sh"
  cp -p -- "${GA}/autoagent/daemon_cycle.py" "${sandbox}/autoagent/daemon_cycle.py"
  cp -p -- "${GA}/scripts/lib/apply-lock.sh" "${sandbox}/scripts/lib/apply-lock.sh"
  printf '%s\n' '{"patches": []}' >"${WORK}/report.json"
  # No test roots under the sandbox → the first preflight abort site fires (exit 16 + one row).
  env -u AUTOAGENT_ALLOW_UNVERIFIED -u AUTOAGENT_PREFLIGHT_ACTIVE \
    HOME="${WORK}/home" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    bash "${sandbox}/autoagent/daemon-apply.sh" \
    --report "${WORK}/report.json" --agents-dir "${WORK}/agents" >/dev/null 2>&1 || true
  [[ -s "${REPORTS}/autoagent-applied-${TODAY}.jsonl" ]] || return 1
}

# Append one non-abort row ($2 = its status literal) under the date $1. Hand-written: reaching the
# producer sites needs the heavier producer harness. The literals used here are pinned against the
# producer source by AC5 and AC7.
append_non_abort_row() {
  local date_key="$1" status="$2"
  printf '%s\n' \
    '{"ts":"'"${date_key}"'T12:00:00.000Z","status":"'"${status}"'","pattern_label":"probe","target_file":"agents/probe.md"}' \
    >>"${REPORTS}/autoagent-applied-${date_key}.jsonl"
}

# Rename today's applied log to a date $1 days back, so the whole file falls outside the window.
age_applied_log() {
  local days="$1" old
  old="$(date -u -v-"${days}"d +%Y-%m-%d 2>/dev/null || date -u -d "${days} days ago" +%Y-%m-%d)"
  mv -f "${REPORTS}/autoagent-applied-${TODAY}.jsonl" "${REPORTS}/autoagent-applied-${old}.jsonl"
  printf '%s\n' "${old}"
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

# ── AC1 — an unsuperseded in-window abort FAILs and names the clause ───────────────────────────

@test "AC1: an in-window abort row with no later non-abort row FAILs and names the clause" {
  emit_abort_row || {
    echo "producer wrote no abort row" >&2
    return 1
  }
  run_doctor_seam
  assert_output_has "FAIL : autoagent apply aborted in the last" || return 1
  # the clause the producer wrote must reach the operator, not just a count
  assert_output_has "test root absent" || return 1
  assert_output_has "abort row:" || return 1
}

# ── AC2 — a later landed-patch row supersedes the abort ────────────────────────────────────────

@test "AC2: a later landed-patch (applied) row supersedes the abort → ok" {
  emit_abort_row || {
    echo "producer wrote no abort row" >&2
    return 1
  }
  append_non_abort_row "${TODAY}" "applied"
  run_doctor_seam
  assert_output_has 'abort superseded by a later non-abort row not marked "gate":"skipped"' || return 1
  assert_output_lacks "FAIL : autoagent apply aborted"
}

# ── AC3 — no rows at all is a pass, never an error ─────────────────────────────────────────────

@test "AC3: an empty daemon-reports dir passes rather than erroring" {
  [[ -z "$(ls -A "${REPORTS}")" ]] || return 1
  run_doctor_seam
  assert_output_has "no autoagent apply aborts in the last" || return 1
  assert_output_lacks "FAIL : autoagent apply aborted"
}

# ── AC4 — an aged-out abort is history ─────────────────────────────────────────────────────────

@test "AC4: an abort row older than the window is history, not a live condition" {
  emit_abort_row || {
    echo "producer wrote no abort row" >&2
    return 1
  }
  age_applied_log 30 >/dev/null
  run_doctor_seam
  assert_output_has "no autoagent apply aborts in the last" || return 1
  assert_output_lacks "FAIL : autoagent apply aborted"
}

# ── AC5 — producer-grammar pin ─────────────────────────────────────────────────────────────────

@test "AC5: the row literals §14 classifies on are the ones daemon-apply.sh writes" {
  emit_abort_row || {
    echo "producer wrote no abort row" >&2
    return 1
  }
  local missing=""
  grep -q '"status":"abort"' "${REPORTS}/autoagent-applied-${TODAY}.jsonl" || missing="${missing} abort-token"
  # the clean-apply literal is hand-written in the fixture, so pin it against the PRODUCER source
  grep -q '"status":"applied"' "${APPLY_SH}" || missing="${missing} applied-token"
  [[ -z "${missing}" ]] || {
    echo "producer grammar changed — §14 classifier literals absent:${missing}" >&2
    return 1
  }
}

# ── AC6 — a non-landing non-abort row supersedes too ──────────────────────────────────────────

@test "AC6: any non-abort row supersedes the abort, not only a landed patch" {
  local status failed=""
  for status in skip reject needs_regen dryrun error; do
    rm -f -- "${REPORTS}"/autoagent-applied-*.jsonl
    emit_abort_row || {
      echo "producer wrote no abort row (${status})" >&2
      return 1
    }
    append_non_abort_row "${TODAY}" "${status}"
    run_doctor_seam
    [[ "${output}" == *'abort superseded by a later non-abort row not marked "gate":"skipped"'* ]] || failed="${failed} ${status}(no-ok)"
    [[ "${output}" != *"FAIL : autoagent apply aborted"* ]] || failed="${failed} ${status}(fail-line)"
  done
  [[ -z "${failed}" ]] || {
    echo "non-abort literals that did not clear the abort:${failed}" >&2
    echo "last doctor output: ${output}" >&2
    return 1
  }
}

# ── AC7 — producer literal-SET pin (guards the abort/non-abort split) ──────────────────────────

@test "AC7: the producer's status-literal set is the one the abort/non-abort split assumes" {
  local observed expected
  # grep -o yields one `"status":"<lit>"` per emit site; strip to the bare literal and dedupe.
  observed="$(grep -o '"status":"[a-z_]*"' "${APPLY_SH}" | sed 's/^"status":"//;s/"$//' | sort -u | tr '\n' ' ')"
  expected="abort applied dryrun error needs_regen reject skip "
  [[ "${observed}" == "${expected}" ]] || {
    echo "producer status-literal set changed — §14 treats 'abort' as the ONLY abort-class literal" >&2
    echo "(both the pre-gate preflight abort and the post-gate backlog anomaly write it) and every" >&2
    echo "other literal as non-abort. Classify the new literal before widening." >&2
    echo "observed: ${observed}" >&2
    echo "expected: ${expected}" >&2
    return 1
  }
}

# ── AC8 — the POST-gate abort producer: classified as an abort, remedied as itself ──────────────
#
# Reaching the tripwire needs a psql-stubbed backlog the doctor sandbox has no mirror for, so the
# row is hand-written here for the same reason the superseding rows above are — and its two literals
# are pinned against the producer source so a rename fails this test rather than degrading it. The
# producer-authored half lives in autoagent/test/daemon-apply-backlog-anomaly-row.bats.

append_anomaly_abort_row() {
  printf '%s\n' \
    '{"ts":"'"${TODAY}"'T12:00:00.000Z","status":"abort","reason":"backlog_anomaly","exit_code":7,"eligible_pending":137,"threshold":100,"patch_source":"backlog"}' \
    >>"${REPORTS}/autoagent-applied-${TODAY}.jsonl"
}

@test "AC8: a post-gate backlog-anomaly abort FAILs and names the backlog remedy, not the gate" {
  local missing=""
  grep -q '"status":"abort","reason":"backlog_anomaly"' "${APPLY_SH}" || missing="${missing} anomaly-reason"
  grep -q '"reason":"preflight_fatal"' "${APPLY_SH}" || missing="${missing} preflight-reason"
  [[ -z "${missing}" ]] || {
    echo "producer grammar changed — the reason literals §14 branches on are absent:${missing}" >&2
    return 1
  }
  append_anomaly_abort_row
  run_doctor_seam
  assert_output_has "FAIL : autoagent apply aborted in the last" || return 1
  assert_output_has "abort row:" || return 1
  # the remedy has to be THIS producer's: the green-suite clause would send the operator at a suite
  # that was never red, which is the same wrong-cause report the silent tripwire used to cause.
  assert_output_has "core.autoagent_proposals" || return 1
  assert_output_lacks "re-open the gate"
}

@test "AC8b: a later non-abort row supersedes the anomaly abort too" {
  append_anomaly_abort_row
  append_non_abort_row "${TODAY}" "applied"
  run_doctor_seam
  assert_output_has 'abort superseded by a later non-abort row not marked "gate":"skipped"' || return 1
  assert_output_lacks "FAIL : autoagent apply aborted"
}
