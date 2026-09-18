#!/usr/bin/env bats
# daemon-apply.sh ZERO-ELIGIBLE post-gate row suite (T3-1) — pins the heartbeat row a cycle with
# nothing to apply writes.
#
# WHY THIS ROW EXISTS. doctor §14 reports an apply-preflight abort as a live condition until a LATER
# post-gate row proves the gate re-opened. A cycle that clears the gate and finds zero eligible
# patches used to print to stderr and exit 0 having written NOTHING, so a recovered-but-idle daemon
# never superseded its own earlier abort: the launchd path discards that stderr, and the applied log
# — the only durable trace — stayed silent. The row is the missing evidence, not a cosmetic log line.
#
# LITERAL CHOICE. The row carries the EXISTING `skip` literal with a new `reason`, never a dedicated
# one. The producer's status-literal set is pinned by string equality in test/doctor-apply-abort-rows
# .bats (AC7) under a preflight test root, so a new literal would redden that suite, trip the fatal
# green-suite preflight, abort the live apply and write the very abort row this row exists to
# supersede. AC5 below pins that the literal actually used stays inside that already-pinned set.
#
#   AC1  backlog source, zero eligible → exactly ONE row: status skip, reason zero_eligible
#   AC2  report source, zero eligible  → the SAME row (the second silent exit, stated separately)
#   AC3  preflight abort               → the abort row and NO post-gate row (never self-supersede)
#   AC4  one eligible patch            → per-patch rows only, no extra heartbeat (no double count)
#   AC5  the row's status literal is inside the set §14's producer pin already fixes
#   AC9  a failed backlog query / an unreadable backlog row / an unreadable report → exit 21 / 23 / 22,
#        one abort row, NO heartbeat; a present-but-unreadable PATH SHAPE (a directory, a dangling
#        link) is unreadable too, while a report absent from the filesystem is still a clean exit 0
#
# Hermetic: a whole-PATH mirror (precedent: daemon-apply-landing-zone.bats) with psql either MASKED
# (report fallback) or replaced by a zero-row STUB (backlog fallback with an empty eligible set), a
# git shim that allows only `git apply`, an echo-OK claude stub so a claude-less CI runner behaves
# like a claude-bearing one, and AUTOAGENT_REPORTS_DIR pointed at a temp dir. No PG, no live agents
# dir, no ~/.glass-atrium state is read or written.
#
# BATS GATING NOTE: @test bodies run UNDER errexit, so a failing mid-body command aborts the test.
#   ONE shape is platform-split: a bare `[[ ]]` / `(( ))` does not abort on macOS bash 3.2 but DOES
#   on CI bash 5.3 (measured: bash 3.2.57 vs 5.3.9, bats 1.13.0 on BOTH legs — bash is the variable,
#   not bats), while `[ ]`, `let` and a failing `grep -q` abort on both.
#   Every assertion `return 1`s on mismatch, so EACH one independently fails the test on either leg.
#
# Run via: bats autoagent/test/daemon-apply-zero-eligible-row.bats
# Requires: bats >= 1.5.0, bash 3.2+, git (for `git apply` only), python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/daemon-apply.sh"
ABORT_PIN_SUITE="${GA}/test/doctor-apply-abort-rows.bats"

# mirror_path — symlink every real-PATH executable into $1 except the names in $2.. (whole-PATH
# mirror per build_psql_masked_stub: an allowlist that misses one coreutil makes the daemon exit 127
# opaquely). psql, git and claude are always excluded — this suite supplies its own of each.
mirror_path() {
  local dest="$1"
  shift
  # EVERY name this suite later stubs MUST appear here.
  # A `cat >` onto a mirrored symlink follows it and truncates the REAL binary at the far end.
  # Precedent: daemon-apply-stale-drain-haiku-guard.bats — "a fresh file, not a symlink onto real psql".
  local excl=" $* psql git claude "
  mkdir -p -- "${dest}"
  local d f name
  local old_ifs="${IFS}"
  IFS=:
  for d in ${PATH}; do
    [[ -d "${d}" ]] || continue
    for f in "${d}"/*; do
      [[ -x "${f}" && ! -d "${f}" ]] || continue
      name="${f##*/}"
      case "${excl}" in
        *" ${name} "*) continue ;;
      esac
      [[ -e "${dest}/${name}" ]] || ln -sf "${f}" "${dest}/${name}"
    done
  done
  IFS="${old_ifs}"
}

# build_git_apply_shim — allow-only-apply `git`: `git [-C <dir>] apply …` execs the REAL git, every
# other subcommand hard-fails (precedent: daemon-apply-landing-zone.bats). A suppressed non-apply git
# call inside the git-free daemon therefore breaks loudly instead of passing unnoticed.
build_git_apply_shim() {
  local stub="$1" real_git
  real_git="$(command -v git)"
  rm -f -- "${stub}/git" # never redirect onto an inherited symlink
  cat >"${stub}/git" <<EOF
#!/usr/bin/env bash
sub="\${1:-}"
[[ "\${sub}" == "-C" ]] && sub="\${3:-}"
if [[ "\${sub}" == "apply" ]]; then
  exec "${real_git}" "\$@"
fi
printf 'git-shim: BLOCKED non-apply git subcommand: %s\n' "\${sub:-\${1:-}}" >&2
exit 97
EOF
  chmod +x "${stub}/git"
}

# make_claude_stub — echo-OK `claude` so this suite behaves identically on a claude-less CI runner
# and a developer machine (the fixtures below pre-set haiku_status, so no live model call is needed —
# but a PATH without claude and one with it must not diverge silently).
make_claude_stub() {
  rm -f -- "${1}/claude" # never redirect onto an inherited symlink
  cat >"${1}/claude" <<'SH'
#!/usr/bin/env bash
echo OK
exit 0
SH
  chmod +x "${1}/claude"
}

# make_empty_backlog_psql — a psql that answers EVERY query with zero rows and exits 0. Present on
# PATH, so backlog_source_available() is true and the daemon takes the BACKLOG source with an empty
# eligible set — the exact live shape (a drained backlog) the heartbeat row exists for.
make_empty_backlog_psql() {
  rm -f -- "${1}/psql" # never redirect onto an inherited symlink
  cat >"${1}/psql" <<'SH'
#!/usr/bin/env bash
exit 0
SH
  chmod +x "${1}/psql"
}

# make_failing_backlog_psql — a psql that fails EVERY query the way an unreachable server does. Present
# on PATH, so the daemon still takes the BACKLOG source; the outage must never read as an empty backlog.
make_failing_backlog_psql() {
  rm -f -- "${1}/psql" # never redirect onto an inherited symlink
  cat >"${1}/psql" <<'SH'
#!/usr/bin/env bash
echo 'psql: error: connection to server on socket failed: No such file or directory' >&2
exit 2
SH
  chmod +x "${1}/psql"
}

# make_unreadable_backlog_psql — a psql whose backlog answer is one raw, unencoded row whose
# '|'-bearing label splits it into 7 fields. The query succeeded, so this is not an outage.
make_unreadable_backlog_psql() {
  rm -f -- "${1}/psql" # never redirect onto an inherited symlink
  cat >"${1}/psql" <<'SH'
#!/usr/bin/env bash
printf '%s\n' '7|2026-09-01|probe|pipe|probe|/tmp/unreadable-probe.md|'
exit 0
SH
  chmod +x "${1}/psql"
}

setup_file() {
  MIRROR="${BATS_FILE_TMPDIR}/bin"
  if [[ -f "${REAL_SCRIPT}" ]]; then
    mirror_path "${MIRROR}"
    build_git_apply_shim "${MIRROR}"
    make_claude_stub "${MIRROR}"
  fi
  export MIRROR
}

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "daemon-apply.sh not found: ${REAL_SCRIPT}"
  # pwd -P resolves /var -> /private/var so the daemon's realpath containment check passes.
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-zeroelig-bats.XXXXXX)" && pwd -P)"
  AGENTS="${WORK}/agents" # PLAIN dir — the git-free daemon needs NO repo here.
  REPORTS="${WORK}/reports"
  BACKLOG_BIN="${WORK}/bin-backlog"
  mkdir -p -- "${AGENTS}" "${REPORTS}" "${WORK}/home" "${BACKLOG_BIN}"
  printf '%s\n' '{"patches": []}' >"${WORK}/report.json"
  TODAY="$(date -u +%Y-%m-%d)"
  APPLIED_LOG="${REPORTS}/autoagent-applied-${TODAY}.jsonl"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && chmod -R u+rwX -- "${WORK}" 2>/dev/null || true
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
}

# run_apply — drive the REAL daemon over the fixture. AUTOAGENT_PREFLIGHT_ACTIVE=1: this suite
# exercises the post-gate emit, not the green-suite gate, so the sentinel skips the recursive suite
# run. $1 = the PATH to run under (mirror = psql masked → report source; a dir carrying the zero-row
# psql stub → backlog source).
run_apply() {
  run env -u AUTOAGENT_ALLOW_UNVERIFIED PATH="$1" HOME="${WORK}/home" \
    AUTOAGENT_REPORTS_DIR="${REPORTS}" AUTOAGENT_PREFLIGHT_ACTIVE=1 \
    bash "${REAL_SCRIPT}" --report "${WORK}/report.json" --agents-dir "${AGENTS}"
}

# backlog_path — the mirror PLUS the zero-row psql stub, ahead of it so `command -v psql` resolves.
backlog_path() {
  make_empty_backlog_psql "${BACKLOG_BIN}"
  printf '%s:%s' "${BACKLOG_BIN}" "${MIRROR}"
}

# Count rows in today's applied log matching the grep pattern $1 (0 when the log does not exist).
row_count() {
  [[ -f "${APPLIED_LOG}" ]] || {
    printf '0'
    return 0
  }
  grep -c -- "$1" "${APPLIED_LOG}" || true
}

dump_log() {
  echo "applied log (${APPLIED_LOG}):" >&2
  cat "${APPLIED_LOG}" 2>&1 >&2 || true
  echo "daemon output: ${output}" >&2
}

# ── AC1 — the backlog source drained: ONE post-gate row ────────────────────────────────────────

@test "AC1: a zero-eligible BACKLOG cycle writes exactly one skip/zero_eligible row" {
  run_apply "$(backlog_path)"
  [[ "${status}" -eq 0 ]] || {
    dump_log
    return 1
  }
  [[ -f "${APPLIED_LOG}" ]] || {
    echo "no applied log written — a recovered-but-idle cycle left nothing to supersede an abort" >&2
    echo "daemon output: ${output}" >&2
    return 1
  }
  [[ "$(wc -l <"${APPLIED_LOG}" | tr -d ' ')" -eq 1 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"status":"skip"')" -eq 1 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"reason":"zero_eligible"')" -eq 1 ]] || {
    dump_log
    return 1
  }
  # the row has to name WHICH source drained, or an operator cannot tell a drained backlog from a
  # report-fallback cycle that never had a DB at all.
  [[ "$(row_count '"patch_source":"backlog"')" -eq 1 ]] || {
    dump_log
    return 1
  }
}

# ── AC2 — the report fallback is the second silent exit, and gets the same row ─────────────────

@test "AC2: a zero-eligible REPORT cycle writes the same single post-gate row" {
  run_apply "${MIRROR}" # psql masked → report fallback over the empty-patches fixture
  [[ "${status}" -eq 0 ]] || {
    dump_log
    return 1
  }
  [[ "$(wc -l <"${APPLIED_LOG}" | tr -d ' ')" -eq 1 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"status":"skip"')" -eq 1 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"reason":"zero_eligible"')" -eq 1 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"patch_source":"report"')" -eq 1 ]] || {
    dump_log
    return 1
  }
}

# ── AC3 — an aborting cycle never supersedes its own abort ─────────────────────────────────────

@test "AC3: a preflight-aborting cycle writes the abort row and NO post-gate row" {
  # A sandbox copy WITHOUT the four test roots drives the real preflight into its abort (precedent:
  # test/doctor-apply-abort-rows.bats emit_abort_row) — the sentinel is dropped so the gate runs.
  local sandbox="${WORK}/real"
  mkdir -p -- "${sandbox}/autoagent/lib" "${sandbox}/scripts/lib"
  cp -p -- "${REAL_SCRIPT}" "${sandbox}/autoagent/daemon-apply.sh"
  cp -p -- "${GA}/autoagent/lib/git-txn.sh" "${sandbox}/autoagent/lib/git-txn.sh"
  cp -p -- "${GA}/autoagent/daemon_cycle.py" "${sandbox}/autoagent/daemon_cycle.py"
  cp -p -- "${GA}/scripts/lib/apply-lock.sh" "${sandbox}/scripts/lib/apply-lock.sh"
  run env -u AUTOAGENT_ALLOW_UNVERIFIED -u AUTOAGENT_PREFLIGHT_ACTIVE \
    PATH="${MIRROR}" HOME="${WORK}/home" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    bash "${sandbox}/autoagent/daemon-apply.sh" \
    --report "${WORK}/report.json" --agents-dir "${AGENTS}"
  [[ "${status}" -eq 16 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"status":"abort"')" -eq 1 ]] || {
    dump_log
    return 1
  }
  # the load-bearing half: a cycle that never opened the gate must not claim post-gate progress.
  [[ "$(row_count '"reason":"zero_eligible"')" -eq 0 ]] || {
    echo "an aborting cycle wrote the superseding row — it would clear its own abort" >&2
    dump_log
    return 1
  }
}

# ── AC4 — the normal path is untouched (no double counting) ────────────────────────────────────

@test "AC4: a cycle with one eligible patch writes the per-patch row only, no heartbeat" {
  printf '%s\n' \
    '# Probe Agent' '' '## Absolute Rules' '' '- protected rule line alpha' '' \
    '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"
  local diff='--- a/probe.md
+++ b/probe.md
@@ -8,2 +8,3 @@
 editable goal line one
+inserted editable line
 editable goal line two'
  python3 - "${AGENTS}/probe.md" "${diff}" >"${WORK}/report.json" <<'PY'
import json
import sys

target, diff = sys.argv[1], sys.argv[2]
print(
    json.dumps(
        {
            "patches": [
                {
                    "classification": "body-auto",
                    "approval_tier": "auto",
                    "pre_verify_passed": True,
                    "haiku_status": "ok",
                    "pattern_label": "probe-in",
                    "pattern_agent": "probe",
                    "target_file": target,
                    "proposed_diff": diff + "\n",
                }
            ]
        }
    )
)
PY
  run_apply "${MIRROR}"
  [[ "${status}" -eq 0 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"status":"applied"')" -eq 1 ]] || {
    dump_log
    return 1
  }
  # negative polarity: the heartbeat is for the EMPTY cycle only — a cycle that applied something
  # already testifies to post-gate progress, and a second row would double-count it.
  [[ "$(row_count '"reason":"zero_eligible"')" -eq 0 ]] || {
    echo "a cycle that applied a patch also wrote the zero-eligible heartbeat" >&2
    dump_log
    return 1
  }
}

# ── AC5 — the literal stays inside the already-pinned producer set ─────────────────────────────

@test "AC5: the heartbeat row's status literal is inside the set §14's producer pin fixes" {
  [[ -f "${ABORT_PIN_SUITE}" ]] || skip "abort-rows pin suite not found: ${ABORT_PIN_SUITE}"
  # Read the EXPECTED set out of the pin suite rather than restating it here: a second hand-copied
  # copy of that string is exactly the drift the pin exists to prevent.
  local expected
  expected="$(sed -n 's/^  expected="\(.*\)"$/\1/p' "${ABORT_PIN_SUITE}")"
  [[ -n "${expected}" ]] || {
    echo "could not read the pinned literal set from ${ABORT_PIN_SUITE}" >&2
    return 1
  }
  run_apply "${MIRROR}"
  local literal
  literal="$(sed -n 's/.*"status":"\([^"]*\)".*/\1/p' "${APPLIED_LOG}")"
  [[ -n "${literal}" ]] || {
    dump_log
    return 1
  }
  # membership, by the same whitespace-delimited form the pin uses.
  [[ " ${expected} " == *" ${literal} "* ]] || {
    echo "heartbeat literal '${literal}' is OUTSIDE the pinned set '${expected}' — adding it would" >&2
    echo "redden the pin under the preflight test root, aborting the live apply." >&2
    return 1
  }
}

# ── AC6/AC7 — the row states WHICH of the two things the preflight gate did ────────────────────
#
# The row's own comment used to claim it was proof the cycle CLEARED the gate. That is false on the
# operator-override hatch: the gate was skipped, nothing was verified, and doctor §14 read the row as
# a recovery and silently cleared a real abort. A FIELD rather than a new status literal, because a
# new literal reddens the AC5 pin under the preflight test root — tripping a fatal preflight and
# writing the very abort row this row exists to supersede.

# run_apply_gate — the same fixture cycle WITHOUT the re-entry sentinel, so the gate genuinely runs.
# A stub runner exits 0 in place of the full suite (this suite exercises the emit, not the suite), and
# the four test roots the gate requires are the repo's own — the real script runs in place.
run_apply_gate() {
  local runner="${WORK}/bats-runner-ok"
  rm -f -- "${runner}" # a fresh file, never a redirect onto an inherited symlink
  printf '#!/bin/bash\nexit 0\n' >"${runner}"
  chmod +x "${runner}"
  run env -u AUTOAGENT_ALLOW_UNVERIFIED -u AUTOAGENT_PREFLIGHT_ACTIVE \
    PATH="${MIRROR}" HOME="${WORK}/home" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    AUTOAGENT_BATS_RUNNER="${runner}" \
    bash "${REAL_SCRIPT}" --report "${WORK}/report.json" --agents-dir "${AGENTS}"
}

@test "AC6: a cycle that CLEARED the gate writes gate=cleared on the heartbeat row" {
  run_apply_gate
  [[ "${status}" -eq 0 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"gate":"cleared"')" -eq 1 ]] || {
    dump_log
    return 1
  }
}

@test "AC7: a cycle that SKIPPED the gate via the operator override writes gate=skipped" {
  run env PATH="${MIRROR}" HOME="${WORK}/home" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    AUTOAGENT_ALLOW_UNVERIFIED=1 \
    bash "${REAL_SCRIPT}" --report "${WORK}/report.json" --agents-dir "${AGENTS}"
  [[ "${status}" -eq 0 ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"gate":"skipped"')" -eq 1 ]] || {
    dump_log
    return 1
  }
}

@test "AC8: the gate field is additive — the pinned status-literal set is untouched" {
  # The guard that keeps AC6/AC7 cheap: doctor-apply-abort-rows.bats AC7 derives its expected set by
  # extracting `"status":"<lit>"` occurrences from this producer, so a new FIELD leaves it intact.
  # Asserted here against the producer source, so a later drift toward a dedicated literal fails on
  # the row that introduces it rather than three suites away.
  [[ "$(grep -c '"gate":"' "${REAL_SCRIPT}")" -ge 1 ]] || {
    echo "producer no longer writes a gate field" >&2
    return 1
  }
  local observed
  observed="$(grep -o '"status":"[a-z_]*"' "${REAL_SCRIPT}" | sed 's/^"status":"//;s/"$//' | sort -u | tr '\n' ' ')"
  [[ "${observed}" == "abort applied dryrun error needs_regen reject skip " ]] || {
    echo "producer status-literal set changed: ${observed}" >&2
    return 1
  }
}

# ── AC9 — a patch source that could not be READ is an abort, never a zero-eligible cycle ────────
#
# The heartbeat supersedes an earlier abort, so writing it for a cycle that never saw its source
# would clear a live condition with a false "nothing to do": a DB outage or a corrupt report must
# exit non-zero with an abort row, never print "0 … patches" and write the heartbeat.

# assert_one_abort_row REASON EXIT_CODE SOURCE — the log holds exactly ONE row, and it is that abort
# (so no heartbeat rode along with it).
assert_one_abort_row() {
  [[ -f "${APPLIED_LOG}" && "$(wc -l <"${APPLIED_LOG}" | tr -d ' ')" -eq 1 ]] \
    && grep '"status":"abort"' "${APPLIED_LOG}" | grep "\"reason\":\"$1\"" \
    | grep "\"exit_code\":$2," | grep -q "\"patch_source\":\"$3\"" || {
    echo "expected exactly one abort row: reason=$1 exit_code=$2 patch_source=$3" >&2
    dump_log
    return 1
  }
}

@test "AC9: a failed BACKLOG query exits 21 with one abort row and no heartbeat" {
  make_failing_backlog_psql "${BACKLOG_BIN}"
  run_apply "${BACKLOG_BIN}:${MIRROR}"
  [[ "${status}" -eq 21 ]] || {
    dump_log
    return 1
  }
  [[ "${output}" == *"backlog_query failed rc=2"* && "${output}" != *"0 pending backlog patches"* ]] || {
    echo "the outage is not named, or still reads as an empty backlog" >&2
    dump_log
    return 1
  }
  assert_one_abort_row proposal_query_failed 21 backlog
}

@test "AC9: an unreadable BACKLOG row exits 23 with one abort row and no heartbeat, never as an outage" {
  make_unreadable_backlog_psql "${BACKLOG_BIN}"
  run_apply "${BACKLOG_BIN}:${MIRROR}"
  [[ "${status}" -eq 23 ]] || {
    dump_log
    return 1
  }
  [[ "${output}" == *"FATAL: a backlog row is unreadable"* && "${output}" == *"7 fields, expected 6"* &&
    "${output}" != *"backlog query failed"* && "${output}" != *"0 pending backlog patches"* ]] || {
    echo "the unreadable row is not named, or reads as an outage or an empty backlog" >&2
    dump_log
    return 1
  }
  assert_one_abort_row proposal_row_unreadable 23 backlog
}

@test "AC9: an unreadable REPORT exits 22 with one abort row, no heartbeat and no traceback" {
  printf '%s\n' '{"patches": [' >"${WORK}/report.json" # a truncated write
  run_apply "${MIRROR}"
  [[ "${status}" -eq 22 ]] || {
    dump_log
    return 1
  }
  [[ "${output}" == *"FATAL: report ${WORK}/report.json is unreadable"* &&
    "${output}" != *"0 body-auto patches"* && "${output}" != *Traceback* ]] || {
    echo "the unreadable report is not named, reads as zero patches, or leaks a traceback" >&2
    dump_log
    return 1
  }
  assert_one_abort_row report_unreadable 22 report
}

@test "AC9: a DIRECTORY at the report path exits 22 with one abort row, never a silent exit 0" {
  rm -f -- "${WORK}/report.json"
  mkdir -- "${WORK}/report.json" # present but unreadable: absence is about presence, not file kind
  run_apply "${MIRROR}"
  [[ "${status}" -eq 22 ]] || {
    dump_log
    return 1
  }
  [[ "${output}" == *"FATAL: report ${WORK}/report.json is unreadable"* &&
    "${output}" != *"no report at"* && "${output}" != *"0 body-auto patches"* &&
    "${output}" != *Traceback* ]] || {
    echo "a directory at the report path reads as absent, as zero patches, or leaks a traceback" >&2
    dump_log
    return 1
  }
  assert_one_abort_row report_unreadable 22 report
}

@test "AC9: a DANGLING SYMLINK at the report path exits 22 with one abort row, never a silent exit 0" {
  # The link-only half of the absence test: it exists as a link, and resolves to nothing.
  rm -f -- "${WORK}/report.json"
  ln -s -- "${WORK}/no-such-report.json" "${WORK}/report.json"
  run_apply "${MIRROR}"
  [[ "${status}" -eq 22 ]] || {
    dump_log
    return 1
  }
  [[ "${output}" == *"FATAL: report ${WORK}/report.json is unreadable"* &&
    "${output}" != *"no report at"* && "${output}" != *"0 body-auto patches"* &&
    "${output}" != *Traceback* ]] || {
    echo "a dangling link at the report path reads as absent, as zero patches, or leaks a traceback" >&2
    dump_log
    return 1
  }
  assert_one_abort_row report_unreadable 22 report
}

@test "AC9: an ABSENT report stays a clean exit 0 with no abort row" {
  rm -f -- "${WORK}/report.json"
  run_apply "${MIRROR}"
  [[ "${status}" -eq 0 && "${output}" == *"no report at ${WORK}/report.json"* ]] || {
    dump_log
    return 1
  }
  [[ "$(row_count '"status":"abort"')" -eq 0 ]] || {
    echo "an absent report was recorded as an abort — there was nothing to read" >&2
    dump_log
    return 1
  }
}
