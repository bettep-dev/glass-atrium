#!/usr/bin/env bats
# doctor-apply-abort-supersession.bats — pins run_doctor §14's SUPERSESSION POLARITY against the
# zero-eligible heartbeat row daemon-apply.sh now writes (T3-2 over T3-1).
#
# WHY A SECOND §14 SUITE. doctor-apply-abort-rows.bats pins the classifier's row vocabulary (which
# literal is pre-gate, which set supersedes). This one pins the three-way VERDICT the operator reads,
# across the file boundary the heartbeat row introduced: an abort in one daily log, the superseding
# row in a LATER one. The two failure shapes it guards are opposite and both silent —
#   * a recovered-but-idle daemon held red forever (nothing ever superseded its abort), and
#   * an idle install told its abort was superseded when it never aborted at all.
#
# FIXTURE PROVENANCE. The abort row is PRODUCER-AUTHORED: the real daemon-apply.sh is driven into its
# root-absence preflight abort, so a producer-side rename fails these tests instead of degrading the
# check. The heartbeat row cannot be produced without a full post-gate cycle (PATH mirror, psql shim,
# report fixture — that is autoagent/test/daemon-apply-zero-eligible-row.bats' job), so it is
# hand-written here AND its field sequence is pinned against the producer source by AC4.
#
#   AC1  an in-window abort + a LATER file whose only content is the heartbeat row → superseded, ok
#   AC2  an in-window abort with no later post-gate row of any kind → FAIL, the row echoed, exit != 0
#   AC3  post-gate rows with NO abort anywhere in the window → the no-aborts ok line, never a
#        supersession claim (the polarity that is RED at HEAD: any post-gate row marks the window
#        clean, so an install that has never aborted reads "abort superseded" every day)
#   AC4  the heartbeat fixture's field sequence is the one daemon-apply.sh writes
#
# Hermetic: GA_TARGET_HOME + GA_DATA_ROOT point at throwaway temp dirs and DOCTOR_AUTH_REPORTS_DIR
# points the daemon-reports seam at the fixture dir. A nonexistent manifest-gen skips §8 hashing and
# an echo-OK claude stub — written into a plain mkdir'd dir, never a symlink mirror — neutralises the
# auth advisory's live probe. No ~/.claude or ~/.glass-atrium state is read or written.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail.
#   Every assertion `return 1`s on mismatch, so EACH one independently fails the test.
#
# Run via: bats test/doctor-apply-abort-supersession.bats
# Requires: bats >= 1.5.0, bash 3.2+, python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_GA="${GA}/glass-atrium"
APPLY_SH="${GA}/autoagent/daemon-apply.sh"

setup() {
  [[ -f "${REAL_GA}" ]] || skip "glass-atrium not found: ${REAL_GA}"
  [[ -f "${APPLY_SH}" ]] || skip "daemon-apply.sh not found: ${APPLY_SH}"
  TARGET="$(mktemp -d -t ga-doctor-supersede-target.XXXXXX)"
  DATA_ROOT="$(mktemp -d -t ga-doctor-supersede-data.XXXXXX)"
  WORK="$(cd -- "$(mktemp -d -t ga-doctor-supersede-work.XXXXXX)" && pwd -P)"
  REPORTS="${DATA_ROOT}/data/daemon-reports"
  mkdir -p "${TARGET}/bin" "${REPORTS}" "${WORK}/agents" "${WORK}/home"
  # A fresh file in a plain dir: a `cat >` onto an inherited symlink would follow it and truncate the
  # REAL claude binary at the far end.
  rm -f -- "${TARGET}/bin/claude"
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
run_doctor_seam() {
  GA_TARGET_HOME="${TARGET}" GA_DATA_ROOT="${DATA_ROOT}" \
    DOCTOR_AUTH_REPORTS_DIR="${REPORTS}" run "${REAL_GA}" doctor
}

# Drive the REAL daemon into its root-absence preflight abort, so the abort row under test carries
# the producer's own grammar (precedent: test/doctor-apply-abort-rows.bats emit_abort_row).
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

# Append the zero-eligible heartbeat row under the date $1, in daemon-apply.sh zero_eligible_row's
# field sequence ($2 = the drained source, default report). AC4 pins the sequence against the source.
# $3 = the gate outcome; EMPTY (the default) writes the LEGACY field-less shape every row already in
# the window carries, which is the polarity AC7 exists to keep passing.
append_zero_eligible_row() {
  local date_key="$1" source="${2:-report}" gate="${3:-}" gate_field=""
  [[ -z "${gate}" ]] || gate_field="\"gate\":\"${gate}\","
  printf '{"ts":"%sT04:35:00.000Z","status":"skip","reason":"zero_eligible","patch_source":"%s",%s"cycle_date":"%s"}\n' \
    "${date_key}" "${source}" "${gate_field}" "${date_key}" \
    >>"${REPORTS}/autoagent-applied-${date_key}.jsonl"
}

# Rename today's applied log to a date $1 days back, so a LATER file can hold the superseding row.
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

# ── AC1 — the heartbeat row supersedes an abort recorded in an EARLIER file ────────────────────

@test "AC1: a later file holding only the zero-eligible row supersedes an in-window abort" {
  emit_abort_row || {
    echo "producer wrote no abort row" >&2
    return 1
  }
  # The abort moves to yesterday's log (still in-window) so the heartbeat lands in a strictly LATER
  # file — the cross-file ordering a recovered-but-idle daemon actually produces.
  local aborted_on
  aborted_on="$(age_applied_log 1)"
  append_zero_eligible_row "${TODAY}" backlog
  [[ -s "${REPORTS}/autoagent-applied-${aborted_on}.jsonl" ]] || return 1
  run_doctor_seam
  assert_output_has "abort superseded by a later post-gate cycle" || return 1
  assert_output_lacks "FAIL : autoagent apply aborted"
}

# ── AC2 — an abort with nothing after it stays a live condition ────────────────────────────────

@test "AC2: an in-window abort with no later post-gate row FAILs and echoes the row" {
  emit_abort_row || {
    echo "producer wrote no abort row" >&2
    return 1
  }
  run_doctor_seam
  assert_output_has "FAIL : autoagent apply aborted in the last" || return 1
  assert_output_has "abort row:" || return 1
  # The exit code is the aggregate of every section, so a sandboxed tree can redden it on its own —
  # the ATTRIBUTION is the FAIL line above. This asserts only that §14 did not report a failure the
  # aggregate then swallowed.
  [[ "${status}" -ne 0 ]] || {
    echo "doctor exited 0 despite the §14 FAIL line — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# ── AC3 — post-gate rows alone are not a supersession ──────────────────────────────────────────

@test "AC3: post-gate rows with no abort in the window report no aborts, not a supersession" {
  # The steady state of every healthy install once T3-1 landed: a heartbeat row every cycle and no
  # abort anywhere. Claiming a supersession here reports a recovery from a condition that never
  # happened — a daily false line on an install that has never aborted.
  append_zero_eligible_row "${TODAY}" backlog
  append_zero_eligible_row "${TODAY}" report
  run_doctor_seam
  assert_output_has "ok   : no autoagent apply-preflight aborts in the last" || return 1
  assert_output_lacks "abort superseded by a later post-gate cycle" || return 1
  assert_output_lacks "FAIL : autoagent apply aborted"
}

# ── AC4 — the hand-written heartbeat fixture matches the producer ──────────────────────────────

@test "AC4: the heartbeat row's field sequence is the one daemon-apply.sh writes" {
  grep -qF '"status":"skip","reason":"zero_eligible","patch_source":' "${APPLY_SH}" || {
    echo "producer heartbeat row shape changed — this suite's fixture no longer matches it" >&2
    grep -n 'zero_eligible' "${APPLY_SH}" >&2
    return 1
  }
  # The gate field sits AFTER patch_source, which is what keeps the status-literal pin intact. The
  # producer-side polarities live in autoagent/test/daemon-apply-zero-eligible-row.bats (AC6-AC8);
  # this row only pins that the fixture below spells the field where the producer does.
  grep -qF '"patch_source":%s,"gate":"%s"' "${APPLY_SH}" || {
    echo "producer gate-field position changed — the AC5..AC7 fixtures no longer match it" >&2
    grep -n 'zero_eligible' "${APPLY_SH}" >&2
    return 1
  }
}

# ── AC5 — a skipped-gate heartbeat is NOT a recovery ──────────────────────────────────────────

@test "AC5: an abort followed only by a skipped-gate heartbeat stays a live condition" {
  emit_abort_row || {
    echo "producer wrote no abort row" >&2
    return 1
  }
  append_zero_eligible_row "${TODAY}" backlog skipped
  run_doctor_seam
  assert_output_has "FAIL : autoagent apply aborted in the last" || return 1
  assert_output_has "abort row:" || return 1
  assert_output_lacks "abort superseded by a later post-gate cycle" || return 1
  [[ "${status}" -ne 0 ]] || {
    echo "doctor exited 0 despite the §14 FAIL line — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# ── AC6 — a cleared-gate heartbeat still supersedes ───────────────────────────────────────────

@test "AC6: an abort followed by a cleared-gate heartbeat is superseded" {
  emit_abort_row || {
    echo "producer wrote no abort row" >&2
    return 1
  }
  append_zero_eligible_row "${TODAY}" backlog cleared
  run_doctor_seam
  assert_output_has "abort superseded by a later post-gate cycle" || return 1
  assert_output_lacks "FAIL : autoagent apply aborted"
}

# ── AC7 — a row carrying NO gate field supersedes, which is the correctness condition ─────────

@test "AC7: every field-less post-gate row still supersedes an in-window abort" {
  # Every row already in the fourteen-day window predates the field, and five of the six producer
  # statuses will never carry one. Keying as "supersede only when it says cleared" would report
  # every recovered daemon as still-aborted — a wider false-red than the one this task closes.
  local st failed=""
  for st in applied reject needs_regen dryrun error; do
    rm -f -- "${REPORTS}"/autoagent-applied-*.jsonl
    emit_abort_row || {
      echo "producer wrote no abort row (${st})" >&2
      return 1
    }
    printf '{"ts":"%sT12:00:00.000Z","status":"%s","pattern_label":"probe","target_file":"agents/probe.md"}\n' \
      "${TODAY}" "${st}" >>"${REPORTS}/autoagent-applied-${TODAY}.jsonl"
    run_doctor_seam
    [[ "${output}" == *"abort superseded by a later post-gate cycle"* ]] || failed="${failed} ${st}(no-ok)"
    [[ "${output}" != *"FAIL : autoagent apply aborted"* ]] || failed="${failed} ${st}(fail-line)"
  done
  # The legacy heartbeat shape: skip + zero_eligible, written before the gate field existed.
  rm -f -- "${REPORTS}"/autoagent-applied-*.jsonl
  emit_abort_row || {
    echo "producer wrote no abort row (legacy heartbeat)" >&2
    return 1
  }
  append_zero_eligible_row "${TODAY}" backlog
  run_doctor_seam
  [[ "${output}" == *"abort superseded by a later post-gate cycle"* ]] || failed="${failed} legacy-heartbeat(no-ok)"
  [[ "${output}" != *"FAIL : autoagent apply aborted"* ]] || failed="${failed} legacy-heartbeat(fail-line)"
  [[ -z "${failed}" ]] || {
    echo "field-less rows that did NOT supersede:${failed}" >&2
    echo "last doctor output: ${output}" >&2
    return 1
  }
}

# ── AC8 — the classifier reads the field identically under both awk implementations ──────────

@test "AC8: the gate-keyed classifier gives identical verdicts under BSD and GNU awk" {
  # CI is ubuntu-only and the deployment host is BSD userland, so a GNU-only construct passes CI and
  # fails on the only machine that matters. The shim is a plain wrapper script in a fresh dir on a
  # PREPENDED PATH — never a symlink-populated mirror of a real bin dir.
  # HONEST COVERAGE SPLIT. On a macOS host with no gawk/mawk installed this row SKIPS, and the BSD
  # side is still covered — every other row here resolves `awk` to the BSD one-true-awk. The GNU side
  # is covered by CI, which runs these same rows on ubuntu where `awk` IS gawk or mawk. This row is
  # what closes the gap on a host carrying both, and it is a skip rather than a silent pass so the
  # difference is visible rather than assumed.
  local gnu bsd shimdir verdicts=""
  gnu="$(command -v gawk 2>/dev/null || command -v mawk 2>/dev/null || true)"
  bsd="/usr/bin/awk"
  [[ -n "${gnu}" ]] || skip "no gawk/mawk on this host — BSD side covered by the rows above, GNU side by CI"
  [[ -x "${bsd}" ]] || skip "BSD awk not present at ${bsd}"
  local impl fixture
  for fixture in skipped cleared; do
    for impl in "${bsd}" "${gnu}"; do
      shimdir="${WORK}/awkshim-$(basename "${impl}")"
      mkdir -p -- "${shimdir}"
      printf '#!/bin/bash\nexec %s "$@"\n' "${impl}" >"${shimdir}/awk"
      chmod +x "${shimdir}/awk"
      rm -f -- "${REPORTS}"/autoagent-applied-*.jsonl
      emit_abort_row || {
        echo "producer wrote no abort row (${fixture}/${impl})" >&2
        return 1
      }
      append_zero_eligible_row "${TODAY}" backlog "${fixture}"
      GA_TARGET_HOME="${TARGET}" GA_DATA_ROOT="${DATA_ROOT}" \
        DOCTOR_AUTH_REPORTS_DIR="${REPORTS}" PATH="${shimdir}:${PATH}" \
        run "${REAL_GA}" doctor
      if [[ "${output}" == *"abort superseded by a later post-gate cycle"* ]]; then
        verdicts="${verdicts} ${fixture}:superseded"
      elif [[ "${output}" == *"FAIL : autoagent apply aborted"* ]]; then
        verdicts="${verdicts} ${fixture}:aborted"
      else
        verdicts="${verdicts} ${fixture}:unrecognised"
      fi
    done
  done
  [[ "${verdicts}" == " skipped:aborted skipped:aborted cleared:superseded cleared:superseded" ]] || {
    echo "awk implementations disagree (or a verdict was unrecognised): ${verdicts}" >&2
    return 1
  }
}
