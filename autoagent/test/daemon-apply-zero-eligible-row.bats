#!/usr/bin/env bats
# daemon-apply.sh ZERO-ELIGIBLE post-gate row suite (T3-1) — pins the heartbeat row a cycle with
# nothing to apply writes.
#
# WHY THIS ROW EXISTS. doctor §14 reports an apply-preflight abort as a live condition until a LATER
# post-gate row proves the gate re-opened. A cycle that clears the gate and finds zero eligible
# patches used to print to stderr and exit 0 having written NOTHING, so a recovered-but-idle daemon
# never superseded its own earlier abort: on the launchd path that stderr survives only in the
# rotating /tmp/autoagent-daemon-loop.log, and the applied log — the only durable trace — stayed
# silent. The row is the missing evidence, not a cosmetic log line.
#
# LITERAL CHOICE. The row carries the EXISTING `skip` literal with a new `reason`, never a dedicated
# one. The producer's status-literal set is pinned by string equality in test/doctor-apply-abort-rows
# .bats (AC7) under a preflight test root, so a new literal would redden that suite, trip the fatal
# green-suite preflight, abort the live apply and write the very abort row this row exists to
# supersede. AC5 below pins that the literal actually used stays inside that already-pinned set.
#
#   closed  batch mode, whatever either source holds → exit 0 and exactly ONE row: status skip, reason
#           zero_eligible, patch_source closed; no backlog SELECT, no report read, nothing applied
#   AC3  preflight abort               → the abort row and NO post-gate row (never self-supersede)
#   AC4  one eligible --proposal-id row → per-patch rows only, no extra heartbeat (no double count)
#   AC5  the row's status literal is inside the set §14's producer pin already fixes
#
# Batch-source cases (backlog/report selection, abort rows 21/22/23) are unreachable while batch mode
# is closed; restore point for the reopening: git show 896d318d:autoagent/test/daemon-apply-zero-eligible-row.bats
#
# Hermetic: a whole-PATH mirror (precedent: daemon-apply-landing-zone.bats) with psql either MASKED
# (report fallback) or replaced by a recording STUB, a daemon_cycle.py stand-in that records every
# call, a git shim that allows only `git apply`, an echo-OK claude stub so a claude-less CI runner
# behaves like a claude-bearing one, and AUTOAGENT_REPORTS_DIR pointed at a temp dir. No PG, no live
# agents dir, no ~/.glass-atrium state is read or written.
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
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

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
  # never redirect onto an inherited symlink
  if ga_guard_path "${stub}"; then
    rm -f -- "${stub:?}/git"
  else
    return 1
  fi
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
  local stub="$1"
  # never redirect onto an inherited symlink
  if ga_guard_path "${stub}"; then
    rm -f -- "${stub:?}/claude"
  else
    return 1
  fi
  cat >"${stub}/claude" <<'SH'
#!/usr/bin/env bash
echo OK
exit 0
SH
  chmod +x "${stub}/claude"
}

# make_recording_psql — a psql that logs every call (argv + SQL) to STUB_PSQL_LOG and answers by
# statement. The backlog SELECT answers per STUB_BACKLOG: `empty`, `fail` (an unreachable server), or
# N eligible rows; the single lookup answers proposal 401; the flip, record probe and record insert
# answer healthy. Every row targets STUB_TARGET with the diff STUB_DIFF_B64.
make_recording_psql() {
  local dir="$1"
  # never redirect onto an inherited symlink
  if ga_guard_path "${dir}"; then
    rm -f -- "${dir:?}/psql"
  else
    return 1
  fi
  cat >"${dir}/psql" <<'SH'
#!/usr/bin/env bash
sql="$(cat)"
printf '=== psql %s\n%s\n' "$*" "${sql}" >>"${STUB_PSQL_LOG:?}"
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
row() {
  printf '%s|2026-09-01|%s|%s|%s|%s' "$1" "$(b64 "probe-pattern-$1")" "$(b64 probe)" \
    "$(b64 "${STUB_TARGET:?}")" "${STUB_DIFF_B64:?}"
}
case "${sql}" in
  *"id::text = :'pid'"*) printf '%s|pending|ok\n' "$(row 401)" ;;
  *"ORDER BY cycle_date ASC, id ASC"*)
    case "${STUB_BACKLOG:-empty}" in
      empty) ;;
      fail)
        echo 'psql: error: connection to server on socket failed: No such file or directory' >&2
        exit 2
        ;;
      *) for ((i = 1; i <= STUB_BACKLOG; i++)); do printf '%s\n' "$(row "$((400 + i))")"; done ;;
    esac
    ;;
  *"'applied'::core"*) printf '1\n' ;;
  *"to_regclass('core.autoagent_apply_records')"*) printf 't\n' ;;
  *"INSERT INTO core.autoagent_apply_records"*) printf '1\n' ;;
  *stale_attempt_count*) printf 'incremented\n' ;;
  *) ;;
esac
exit 0
SH
  chmod +x "${dir}/psql"
}

# write_cycle_stub PATH — daemon_cycle.py stand-in (run as `python3 <seam>`): records every call to
# STUB_CYCLE_CALLS; the parked guard answers "nothing guarded", removal evidence answers none.
write_cycle_stub() {
  cat >"$1" <<'PY'
import json
import os
import sys

args = sys.argv[1:]
with open(os.environ["STUB_CYCLE_CALLS"], "a") as fh:
    fh.write(json.dumps(args) + "\n")
if "--parked-pattern-guard" in args:
    sys.stdin.read()
    sys.stdout.write('{"guarded": [], "rejected": []}\n')
    sys.exit(0)
if "--removal-evidence" in args:
    sys.stdin.read()
    sys.stdout.write("no_removal\t0\t0\n")
    sys.exit(0)
sys.exit("stub: unexpected daemon_cycle mode %s" % args)
PY
}

# write_probe — the agent the eligible rows target: one protected section, one editable region.
write_probe() {
  printf '%s\n' \
    '# Probe Agent' '' '## Absolute Rules' '' '- protected rule line alpha' '' \
    '## Goal' '<!-- EDITABLE:BEGIN -->' \
    'editable goal line one' 'editable goal line two' \
    '<!-- EDITABLE:END -->' >"${AGENTS}/probe.md"
  cp -p -- "${AGENTS}/probe.md" "${WORK}/probe.original"
}

# probe_diff — an in-region addition to probe.md that lands.
probe_diff() {
  printf '%s\n' '--- a/probe.md' '+++ b/probe.md' '@@ -8,2 +8,3 @@' \
    ' editable goal line one' '+inserted editable line' ' editable goal line two'
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
  PSQL_BIN="${WORK}/bin-psql"
  PSQL_LOG="${WORK}/psql.log"
  CYCLE_STUB="${WORK}/daemon_cycle_stub.py"
  CYCLE_CALLS="${WORK}/cycle-calls.jsonl"
  mkdir -p -- "${AGENTS}" "${REPORTS}" "${WORK}/home" "${PSQL_BIN}"
  make_recording_psql "${PSQL_BIN}"
  write_cycle_stub "${CYCLE_STUB}"
  printf '%s\n' '{"patches": []}' >"${WORK}/report.json"
  TODAY="$(date -u +%Y-%m-%d)"
  APPLIED_LOG="${REPORTS}/autoagent-applied-${TODAY}.jsonl"
  DRYRUN_LOG="${REPORTS}/autoagent-applied-${TODAY}.dryrun.jsonl"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && chmod -R u+rwX -- "${WORK}" 2>/dev/null || true
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
}

# run_apply — drive the REAL daemon over the fixture. AUTOAGENT_PREFLIGHT_ACTIVE=1: this suite
# exercises the post-gate emit, not the green-suite gate, so the sentinel skips the recursive suite
# run. $1 = the PATH to run under (mirror = psql masked; "${PSQL_BIN}:${MIRROR}" = the recording
# psql); the rest is forwarded to the daemon.
run_apply() {
  local path="$1"
  shift
  run env -u AUTOAGENT_ALLOW_UNVERIFIED PATH="${path}" HOME="${WORK}/home" GA_DATA_ROOT="${WORK}/home/.glass-atrium" \
    AUTOAGENT_REPORTS_DIR="${REPORTS}" AUTOAGENT_PREFLIGHT_ACTIVE=1 \
    AUTOAGENT_DAEMON_CYCLE_PY="${CYCLE_STUB}" STUB_CYCLE_CALLS="${CYCLE_CALLS}" \
    STUB_PSQL_LOG="${PSQL_LOG}" STUB_TARGET="${AGENTS}/probe.md" \
    STUB_DIFF_B64="$(probe_diff | base64 | tr -d '\n')" \
    bash "${REAL_SCRIPT}" --report "${WORK}/report.json" --agents-dir "${AGENTS}" "$@"
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

# ── closed — batch mode selects nothing, whatever either source holds ─────────────────────────

# write_report SHAPE — the report fixture: empty · patches (body-auto, one haiku-skipped) · truncated
# (unreadable) · absent.
write_report() {
  local report="${WORK}/report.json"
  if ga_guard_path "${report}"; then rm -f -- "${report:?}"; fi
  case "$1" in
    empty) printf '%s\n' '{"patches": []}' >"${report}" ;;
    truncated) printf '%s\n' '{"patches": [' >"${report}" ;;
    absent) ;;
    patches)
      DIFF="$(probe_diff)" TARGET="${AGENTS}/probe.md" python3 -c '
import json, os
patch = {"classification": "body-auto", "approval_tier": "auto", "pre_verify_passed": True,
         "pattern_agent": "probe", "target_file": os.environ["TARGET"],
         "proposed_diff": os.environ["DIFF"] + "\n"}
rows = [dict(patch, haiku_status="skipped", pattern_label="probe-skipped"),
        dict(patch, haiku_status="ok", pattern_label="probe-ok")]
print(json.dumps({"patches": rows}))
' >"${report}"
      ;;
    *) return 1 ;;
  esac
}

@test "batch mode is closed: every pre-closure source class lands one closed row, selects nothing and applies nothing" {
  # name | psql (stub = recording psql on PATH, masked = absent) | backlog answer | report | extra flag
  local rows=(
    "empty backlog (was: heartbeat, backlog)|stub|empty|empty|"
    "backlog holding eligible pending auto rows (was: apply)|stub|1|empty|"
    "backlog above the anomaly threshold (was: exit-7 abort)|stub|3|empty|"
    "backlog query fails (was: exit-21 abort)|stub|fail|empty|"
    "empty report (was: heartbeat, report)|masked|empty|empty|"
    "report carrying body-auto patches, haiku-skipped included (was: apply)|masked|empty|patches|"
    "unreadable report (was: exit-22 abort)|masked|empty|truncated|"
    "absent report (was: exit 0, no row)|masked|empty|absent|"
    "dry-run batch (was: dryrun rows)|stub|1|patches|--dry-run"
  )
  local row name psql backlog report flag path log other
  for row in "${rows[@]}"; do
    IFS='|' read -r name psql backlog report flag <<<"${row}"
    for log in "${APPLIED_LOG}" "${DRYRUN_LOG}" "${PSQL_LOG}" "${CYCLE_CALLS}"; do
      if ga_guard_path "${log}"; then rm -f -- "${log:?}"; fi
    done
    write_probe
    write_report "${report}"
    path="${MIRROR}"
    [[ "${psql}" == stub ]] && path="${PSQL_BIN}:${MIRROR}"
    log="${APPLIED_LOG}" other="${DRYRUN_LOG}"
    [[ "${flag}" == --dry-run ]] && log="${DRYRUN_LOG}" other="${APPLIED_LOG}"
    # the haiku override and a low threshold make the haiku guard and the tripwire speak if reached
    STUB_BACKLOG="${backlog}" AUTOAGENT_ALLOW_HAIKU_SKIP=1 AUTOAGENT_ANOMALY_THRESHOLD=2 \
      run_apply "${path}" ${flag:+"${flag}"}
    [[ "${status}" -eq 0 && "${output}" == *"batch auto-apply closed until live trials"* ]] || {
      echo "${name}: rc=${status}, or the closure is not named" >&2
      dump_log
      cat -- "${DRYRUN_LOG}" >&2 2>/dev/null || true
      return 1
    }
    [[ -f "${log}" && "$(wc -l <"${log}" | tr -d ' ')" -eq 1 && ! -e "${other}" ]] \
      && grep -q '"status":"skip","reason":"zero_eligible","patch_source":"closed"' "${log}" || {
      echo "${name}: expected exactly one closed zero-eligible row in ${log##*/}" >&2
      cat -- "${log}" "${other}" >&2 2>/dev/null || true
      echo "daemon output: ${output}" >&2
      return 1
    }
    [[ ! -f "${PSQL_LOG}" ]] || ! grep -q 'autoagent_proposals' "${PSQL_LOG}" || {
      echo "${name}: a proposal query reached psql" >&2
      cat -- "${PSQL_LOG}" >&2
      return 1
    }
    cmp -s -- "${AGENTS}/probe.md" "${WORK}/probe.original" && [[ ! -f "${CYCLE_CALLS}" ]] || {
      echo "${name}: a patch landed, or daemon_cycle.py (parked guard) was asked" >&2
      echo "daemon output: ${output}" >&2
      return 1
    }
    [[ "${output}" != *"haiku-skip guard"* && "${output}" != *"backlog anomaly"* ]] || {
      echo "${name}: the haiku guard or the anomaly tripwire was reached" >&2
      echo "daemon output: ${output}" >&2
      return 1
    }
  done
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
  cp -p -- "${GA}/scripts/lib/path-guard.sh" "${sandbox}/scripts/lib/path-guard.sh"
  run env -u AUTOAGENT_ALLOW_UNVERIFIED -u AUTOAGENT_PREFLIGHT_ACTIVE \
    PATH="${MIRROR}" HOME="${WORK}/home" GA_DATA_ROOT="${WORK}/home/.glass-atrium" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
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

@test "AC4: a --proposal-id run with one eligible row writes the per-patch row only, no heartbeat" {
  write_probe
  run_apply "${PSQL_BIN}:${MIRROR}" --proposal-id 401
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
  # a fresh file, never a redirect onto an inherited symlink
  if ga_guard_path "${runner}"; then
    rm -f -- "${runner:?}"
  else
    return 1
  fi
  printf '#!/bin/bash\nexit 0\n' >"${runner}"
  chmod +x "${runner}"
  run env -u AUTOAGENT_ALLOW_UNVERIFIED -u AUTOAGENT_PREFLIGHT_ACTIVE \
    PATH="${MIRROR}" HOME="${WORK}/home" GA_DATA_ROOT="${WORK}/home/.glass-atrium" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
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
  run env PATH="${MIRROR}" HOME="${WORK}/home" GA_DATA_ROOT="${WORK}/home/.glass-atrium" AUTOAGENT_REPORTS_DIR="${REPORTS}" \
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

@test "a stub or runner builder refuses a relative dir and writes nothing through its inherited link" {
  # A name still linked into the dir would take the builder's write through to the link's target;
  # each builder's delete is what prevents it, so a refused dir has to fail the builder, not skip.
  local row builder name dir noop="${WORK}/noop.sh"
  cd -- "${WORK}"
  printf 'real\n' >real-binary
  cp -- real-binary pristine
  printf '#!/bin/bash\nexit 0\n' >"${noop}"
  for row in build_git_apply_shim:git make_claude_stub:claude make_recording_psql:psql \
    run_apply_gate:bats-runner-ok; do
    builder="${row%%:*}"
    name="${row##*:}"
    dir="rel-${builder}"
    mkdir -- "${dir}"
    ln -s -- "${WORK}/real-binary" "${dir}/${name}"
    if [[ "${builder}" == run_apply_gate ]]; then
      # the runner path derives from WORK, so the relative dir goes in as WORK; the no-op script
      # stands in for the daemon, which this row does not exercise
      WORK="${dir}" REAL_SCRIPT="${noop}" run run_apply_gate
    else
      run "${builder}" "${dir}"
    fi
    [[ "${status}" -ne 0 && "${output}" == *"refusing a non-absolute delete target"* ]] || {
      echo "${builder}: a relative dir was accepted: rc=${status}: ${output}" >&2
      return 1
    }
    [[ -L "${dir}/${name}" ]] || {
      echo "${builder}: the inherited link was replaced" >&2
      return 1
    }
    cmp -s -- real-binary pristine || {
      echo "${builder}: the write went through the inherited link" >&2
      return 1
    }
  done
}
