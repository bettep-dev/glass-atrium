#!/usr/bin/env bats
# doctor-proposal-provenance.bats — pins run_doctor §25 (terminal proposal rows naming no actor).
#
# Every status writer stamps core.autoagent_proposals.reviewed_by from this release on, but the
# unadjudicated backfill, which relabels status only and keeps the stored actor; nothing backfills
# the actor of rows written before it. This section is the standing surface that would notice the
# gap reopening. Registration kind B (report-only): its log line only, and AC5 asserts the warning
# total does not move — a counted warning would be red on every established install forever, and
# scoping it by id or date to go green is the workaround class this item exists to avoid.
#
# The report is a SPLIT, never a total: a row carrying a review instant with NO actor was stamped by
# a writer that recorded WHEN but not WHO (the stale-drain class), while a row carrying NEITHER was
# never stamped at all. Different causes, different repairs, so AC5 asserts both numbers survive and
# AC6 asserts the SQL asks the two questions separately of the terminal set alone.
#
# The four no-read branches are kept apart for the reason §21 keeps its own apart: the documented
# opt-out (AC1), the documented psql-less mode (AC2), a database that does not exist yet (AC3) and a
# read this run could not make (AC4/AC7/AC9) are four different facts, and folding any into "0 rows"
# would report a database nobody read as clean. An unread state says `unread` rather than §21's
# `undetermined`: two sections reporting one word for two different unread things is ambiguous to
# an operator grepping the report, and §21's own rows are pinned against the whole output.
#
# NO DATABASE IS CONTACTED. Every psql invocation resolves to a recording stub placed ahead of PATH;
# the stub reads the SQL from stdin, picks a canned answer per query kind and exits with a
# per-scenario code. The row that needs psql ABSENT (AC2) runs against a PATH rebuilt as a symlink
# farm of the real one with psql omitted. GA_DB_NAME names a throwaway database so no live name is
# ever spoken, and GA_MIGRATIONS_DIR points at an empty directory so §21 contributes a constant 0 to
# the warning total and cannot move the comparand AC5 measures.
#
# BATS GATING NOTE (measured, bats 1.13.0 both legs — bash is the variable, not bats): @test bodies run
# under errexit, but a bare non-final `[[ ]]` / `(( ))` does NOT gate on macOS bash 3.2.57 — it DOES on
# Linux bash 5.3.9 (CI) — whereas a plain command (`[ ]`, `grep -q`, `let`) and any final command gate on
# BOTH. Every assertion here `return 1`s on mismatch, so each one independently fails the test.
#
# Run via: bats test/doctor-proposal-provenance.bats
# Requires: bats >= 1.5.0, jq, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

setup() {
  load 'lib/bats-db-seal'
  ga_bats_db_seal
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"

  SANDBOX="$(mktemp -d -t ga-doctor-provenance-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga"
  TARGET="${SANDBOX}/target"
  MANIFEST="${SANDBOX}/manifest.json"
  STUB="${SANDBOX}/bin"
  STUB_STATE="${SANDBOX}/stub"
  MIGRATIONS="${SANDBOX}/migrations"
  mkdir -p "${TARGET}" "${GA_SANDBOX}/agents" "${STUB}" "${STUB_STATE}" "${MIGRATIONS}"
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${MANIFEST}"
  printf '{"version":"1.0.0","agents":{}}\n' >"${GA_SANDBOX}/agent-registry.json"
  seed_psql_stub
}

teardown() {
  unset GA_SKIP_DB_SETUP
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

# Recording psql stub: the query kind is read off the SQL on stdin, the answer and exit code come
# from per-kind files, and every call is logged with its statement so a row can assert both that
# psql was reached and what it was asked.
seed_psql_stub() {
  cat >"${STUB}/psql" <<'STUB'
#!/usr/bin/env bash
sql="$(cat)"
case "${sql}" in
  *pg_database*) kind=exists ;;
  *autoagent_proposals*) kind=provenance ;;
  *) kind=other ;;
esac
{
  printf '%s\n' "${kind}"
  printf 'sql<<<\n%s\n>>>\n' "${sql}"
} >>"${GA_STUB_STATE}/calls.log"
[[ -f "${GA_STUB_STATE}/${kind}.out" ]] && cat -- "${GA_STUB_STATE}/${kind}.out"
if [[ -f "${GA_STUB_STATE}/${kind}.rc" ]]; then
  exit "$(cat -- "${GA_STUB_STATE}/${kind}.rc")"
fi
exit 0
STUB
  chmod +x "${STUB}/psql"
  # Default scenario: the database exists and every terminal row names its mover. Each test
  # overrides what it is about, so a row never silently depends on a state it did not set.
  stub_out exists '1'
  provenance_counts 240 0 0
}

# $1 = query kind (exists|provenance|other), $2 = stdout the stub returns for it.
stub_out() {
  printf '%s' "$2" >"${STUB_STATE}/$1.out"
}

# $1 = query kind, $2 = exit code the stub returns for it.
stub_rc() {
  printf '%s' "$2" >"${STUB_STATE}/$1.rc"
}

# The probe's one output row: total terminal, instant-without-actor, neither — unit-separator
# delimited, which is what the reader splits on (a whitespace separator would collapse a run).
provenance_counts() {
  printf '%s\x1f%s\x1f%s' "$1" "$2" "$3" >"${STUB_STATE}/provenance.out"
}

# A PATH that holds every command the doctor needs but no psql: one directory of symlinks to the
# real PATH entries, with the psql link removed. Dropping psql's whole DIRECTORY from PATH is not
# portable — on a Linux runner psql lives in /usr/bin beside bash, so the sandbox would lose its own
# interpreter before the branch under test is reached.
path_without_psql() {
  local farm="${SANDBOX}/nopsql-bin" part
  local -a parts=()
  if [[ ! -d "${farm}" ]]; then
    mkdir -p "${farm}"
    IFS=: read -r -a parts <<<"${PATH}"
    for part in "${parts[@]}"; do
      [[ -d "${part}" ]] || continue
      # a name already linked from an earlier entry loses, mirroring PATH precedence
      ln -s -- "${part}"/* "${farm}/" 2>/dev/null || true
    done
    if ga_guard_path "${farm}"; then
      rm -f -- "${farm:?}/psql"
    else
      return 1
    fi
  fi
  printf '%s' "${farm}"
}

# Strict-mode driver: $1 = GA checkout, $2 = sandbox GA_ROOT, the rest = the lib call to make.
DOCTOR_DRIVER='
  set -Eeuo pipefail
  source "$1/lib/ga-core.sh"
  ga_init_env "$2"
  shift 2
  "$@"
'

# Step driver: the doctor driver plus a mode word ($3, cli|tui; tui sets GA_TUI_STEP as run_step
# does) and an ERR trap that ends a call RETURNING N with 100+N. A call that exits N ends the
# shell with N without firing the trap, so the status alone tells a return from an exit.
STEP_DRIVER='
  set -Eeuo pipefail
  source "$1/lib/ga-core.sh"
  ga_init_env "$2"
  if [[ "$3" == tui ]]; then GA_TUI_STEP=1; fi
  shift 3
  trap "exit \$(( \$? + 100 ))" ERR
  "$@"
'

# The sandbox environment every driver runs in. GA_DB_NAME points the whole DB path at a throwaway
# name and PATH puts the stub first, so no live database name is ever spoken and no real psql is
# ever reached. $1 = PATH override.
set_sandbox_env() {
  SANDBOX_ENV=(PATH="${1:-${STUB}:${PATH}}"
    GA_LIB_DIR="${GA}/scripts/lib" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}"
    GA_GENERATE_MANIFEST="${SANDBOX}/no-such-manifest-gen"
    GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${SANDBOX}/state"
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT:-9}"
    GA_DB_NAME="ga_doctor_provenance_sandbox"
    GA_MIGRATIONS_DIR="${MIGRATIONS}" GA_STUB_STATE="${STUB_STATE}")
}

# Run the REAL run_doctor against the sandbox GA_ROOT in a fresh strict-mode subprocess.
run_doctor_sandbox() {
  set_sandbox_env "${1:-}"
  run env "${SANDBOX_ENV[@]}" bash -c "${DOCTOR_DRIVER}" _ "${GA}" "${GA_SANDBOX}" run_doctor
}

# Forced-interrupt harness: the driver's shell owns one late child (kept through exec), its stderr
# pipe is full before the first write, and the reader drains only after that child has exited → on
# bash 3.2 the child's SIGCHLD interrupts a builtin write blocked in the driver's shell.
FORCED_HARNESS_PY="$(
  cat <<'PY'
import fcntl, os, subprocess, sys, time

stdout_path = sys.argv[1]
read_fd, write_fd = os.pipe()
flags = fcntl.fcntl(write_fd, fcntl.F_GETFL)
fcntl.fcntl(write_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
filler = 0
try:
    while True:
        os.write(write_fd, b".")
        filler += 1
except BlockingIOError:
    pass
fcntl.fcntl(write_fd, fcntl.F_SETFL, flags)
with open(os.devnull, "rb") as stdin, open(stdout_path, "wb") as stdout:
    proc = subprocess.Popen(
        ["/bin/bash", "-c", '( sleep 0.6 ) & exec /bin/bash "$@"', "_"] + sys.argv[2:],
        stdin=stdin, stdout=stdout, stderr=write_fd)
os.close(write_fd)
time.sleep(1.5)
drained = b""
while True:
    chunk = os.read(read_fd, 65536)
    if not chunk:
        break
    drained += chunk
sys.stdout.buffer.write(drained[filler:])
sys.exit(proc.wait())
PY
)"

# Run one lib call through a driver under the forced harness. Args: the driver text, the lib call.
# Sets status · output = the driver's stderr · FORCED_STDOUT = the file holding its stdout.
run_forced_driver() {
  local python_bin driver="${1}"
  shift
  python_bin="$(command -v python3)"
  # shellcheck disable=SC2154  # BATS_TEST_TMPDIR is assigned by the Bats runner
  FORCED_STDOUT="$(mktemp "${BATS_TEST_TMPDIR}/forced-stdout.XXXXXX")"
  set_sandbox_env
  run --separate-stderr env "${SANDBOX_ENV[@]}" "${python_bin}" -c "${FORCED_HARNESS_PY}" \
    "${FORCED_STDOUT}" -c "${driver}" _ "${GA}" "${GA_SANDBOX}" "$@"
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

# The warning total the PASS summary reports: 0 on a bare PASS, the parenthesised number otherwise.
warn_total_of_output() {
  local pass_line
  pass_line="$(printf '%s\n' "${output}" | grep -F -- '== doctor: PASS' | head -n 1 || true)"
  [[ -n "${pass_line}" ]] || {
    echo "no doctor PASS line in output — output:" >&2
    echo "${output}" >&2
    return 1
  }
  case "${pass_line}" in
    *'PASS (with '*) printf '%s' "${pass_line}" | sed -n 's/.*PASS (with \([0-9][0-9]*\) warning.*/\1/p' ;;
    *) printf '0' ;;
  esac
}

# ── AC1 — branch 1: the documented opt-out reports and counts nothing ──────────────────────────

@test "AC1: GA_SKIP_DB_SETUP reports a skip note and reads no rows" {
  export GA_SKIP_DB_SETUP=1
  run_doctor_sandbox
  assert_output_has "proposal provenance check skipped (GA_SKIP_DB_SETUP set)" || return 1
  assert_output_lacks "name no actor" || return 1
  assert_output_lacks "name the actor that moved them" || return 1
  [[ ! -f "${STUB_STATE}/calls.log" ]] || {
    echo "psql was queried under the opt-out: $(cat -- "${STUB_STATE}/calls.log")" >&2
    return 1
  }
}

# ── AC2 — branch 2: psql absent is a supported mode, not a finding ─────────────────────────────

@test "AC2: no psql on PATH reports a skip note and reads no rows" {
  local nopsql
  nopsql="$(path_without_psql)"
  run_doctor_sandbox "${nopsql}"
  assert_output_has "proposal provenance check skipped — psql not found" || return 1
  assert_output_lacks "name no actor" || return 1
  # the branch is decided before any query, so the stub must not have been consulted either
  [[ ! -f "${STUB_STATE}/calls.log" ]] || {
    echo "psql was queried on the psql-absent path: $(cat -- "${STUB_STATE}/calls.log")" >&2
    return 1
  }
}

# ── AC3 — branch 3: the database does not exist yet, which is not a provenance gap ─────────────

@test "AC3: an absent database reports no-rows-to-check, worded apart from an unreadable one" {
  stub_out exists ''
  run_doctor_sandbox
  assert_output_has "no proposal rows to check for actor coverage" || return 1
  assert_output_lacks "proposal actor coverage unread" || return 1
  assert_output_lacks "name no actor" || return 1
  grep -qx 'provenance' "${STUB_STATE}/calls.log" && {
    echo "the counts were read against a database that does not exist" >&2
    return 1
  }
  return 0
}

# ── AC4 — branch 4: an unreachable server is unread, never a clean zero ───────────────────────

@test "AC4: a failed existence probe is reported unread and never reads as full coverage" {
  stub_rc exists 2
  run_doctor_sandbox
  assert_output_has "proposal actor coverage unread" || return 1
  assert_output_has "existence probe failed" || return 1
  assert_output_lacks "name the actor that moved them" || return 1
  assert_output_lacks "no proposal rows to check" || return 1
}

# ── AC5 — the report: both populations survive, and kind B keeps the total still ───────────────

@test "AC5: the gap is reported as two populations and moves no warning total" {
  run_doctor_sandbox
  local green
  green="$(warn_total_of_output)" || return 1
  assert_output_has "all 240 terminal proposal row(s) name the actor that moved them" || return 1

  # The two-population shape: most terminal rows carry neither column, a smaller set
  # carries the stale drain's instant with no actor. Both numbers must survive into the line.
  provenance_counts 240 70 145
  run_doctor_sandbox
  assert_output_has "215 of 240 terminal row(s) name no actor" || return 1
  assert_output_has "70 carry a review instant with no actor" || return 1
  assert_output_has "145 carry neither" || return 1
  assert_output_has "report-only" || return 1
  assert_output_lacks "all 240 terminal proposal row(s) name the actor" || return 1

  # Registration kind B: the line prints, the total does not move, the exit code does not change.
  local gap
  gap="$(warn_total_of_output)" || return 1
  [[ "${gap}" -eq "${green}" ]] || {
    echo "the provenance gap reached the warning total: ${green} -> ${gap}" >&2
    echo "${output}" >&2
    return 1
  }
  [[ "${status}" -eq 0 ]] || {
    echo "a 215-row provenance gap failed the doctor (exit ${status}) — it must never do that" >&2
    return 1
  }
  assert_output_lacks "provenance-gap" || return 1
}

# ── AC6 — one population alone still names which one it is ─────────────────────────────────────

@test "AC6: a gap in one population alone keeps the split, never a bare total" {
  provenance_counts 240 3 0
  run_doctor_sandbox
  assert_output_has "3 of 240 terminal row(s) name no actor" || return 1
  assert_output_has "3 carry a review instant with no actor" || return 1
  assert_output_has "0 carry neither" || return 1

  provenance_counts 240 0 12
  run_doctor_sandbox
  assert_output_has "12 of 240 terminal row(s) name no actor" || return 1
  assert_output_has "0 carry a review instant with no actor" || return 1
  assert_output_has "12 carry neither" || return 1
}

# ── AC7 — branch 5: a failed counts read is unread, worded apart from AC4 ─────────────────────

@test "AC7: a failed counts read is reported unread and distinct from the existence-probe failure" {
  stub_rc provenance 2
  run_doctor_sandbox
  assert_output_has "the terminal-row read against" || return 1
  assert_output_lacks "existence probe failed" || return 1
  assert_output_lacks "name the actor that moved them" || return 1
  assert_output_lacks "name no actor" || return 1
}

# ── AC8 — the statement asks the two questions separately, of the terminal set alone ───────────

@test "AC8: the probe splits the two populations in one snapshot over terminal rows only" {
  run_doctor_sandbox
  local sql
  sql="$(cat -- "${STUB_STATE}/calls.log")"
  # One statement, so all three numbers describe the same snapshot rather than three reads.
  [[ "$(grep -c '^provenance$' "${STUB_STATE}/calls.log")" -eq 1 ]] || {
    echo "the provenance counts took more than one statement:" >&2
    echo "${sql}" >&2
    return 1
  }
  local needle
  for needle in \
    "FILTER (WHERE reviewed_at IS NOT NULL AND reviewed_by IS NULL)" \
    "FILTER (WHERE reviewed_at IS NULL AND reviewed_by IS NULL)"; do
    grep -qF -- "${needle}" "${STUB_STATE}/calls.log" || {
      echo "the probe does not ask for '${needle}', so the two populations would merge" >&2
      echo "${sql}" >&2
      return 1
    }
  done
  # Terminal rows only: a pending or snoozed row has not been moved to a final state by anyone, so
  # it names no missing mover and would inflate the report with rows that are not a gap.
  for needle in applied approved rejected reverted unadjudicated; do
    grep -qF -- "'${needle}'" "${STUB_STATE}/calls.log" || {
      echo "the probe's status filter omits ${needle}" >&2
      echo "${sql}" >&2
      return 1
    }
  done
  # A schema without the unadjudicated label rejects an enum cast of it when planning the
  # statement, so the list is compared as text (proposal-status-label-fallback.bats runs it).
  grep -qF -- "status::text IN" "${STUB_STATE}/calls.log" || {
    echo "the probe compares status against enum casts, which a pre-label schema cannot plan" >&2
    echo "${sql}" >&2
    return 1
  }
  grep -qF -- "'pending'" "${STUB_STATE}/calls.log" && {
    echo "the probe counts non-terminal rows as a provenance gap" >&2
    return 1
  }
  # Read-only: the detector reports, it never repairs.
  run grep -inE "UPDATE|INSERT|DELETE" "${STUB_STATE}/calls.log"
  [[ "${status}" -ne 0 ]] || {
    echo "the detector sent a mutating statement: ${output}" >&2
    return 1
  }
}

# ── AC9 — a read that answers something else is unread, never zero and never a crash ──────────

@test "AC9: an answer that is not three counts is reported unread and never aborts the doctor" {
  local answer
  # A NOTICE riding on the row, a reply to a different question, and a short row: none of the three
  # answers THIS question, and arithmetic over any of them would abort the whole run.
  for answer in "NOTICE: relation rebuilt" "20260101000000_alpha	2026-01-01T00:00:00Z	" "240"; do
    printf '%s' "${answer}" >"${STUB_STATE}/provenance.out"
    run_doctor_sandbox
    [[ "${status}" -eq 0 ]] || {
      echo "answer '${answer}': a report-only row failed the doctor (exit ${status})" >&2
      echo "${output}" >&2
      return 1
    }
    assert_output_has "answered something other than three counts" || return 1
    assert_output_lacks "name the actor that moved them" || return 1
    assert_output_lacks "name no actor" || return 1
  done
}

# ── Forced write: a log or die line blocked by an interrupt never decides the exit ─────────────

# The doctor's shell owns a late child, so its SIGCHLD lands while a log/die write is blocked on a
# full stderr pipe. A builtin write in that shell fails, and under errexit that failure becomes the
# exit, dropping the rest of the report. Each row asserts the fixed state: its own exit, the line
# exactly once on stderr, nothing on stdout. The doctor keeps no trace log, so stderr is the only
# channel to check. The die_step rows use a code other than 1, so a failed write's errexit status
# cannot pass for the code; the step driver reports a return as 100+N, so the CLI row must exit
# its code and the TUI row must return it.
@test "a log or die line blocked under an interrupt still arrives once and leaves the exit to the code path" {
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  local row name expected needle driver_name call_line driver rest
  local -a call
  for row in \
    'doctor report|0|== doctor: Glass Atrium preflight ==|doctor|run_doctor' \
    'die|1|FATAL: forced die probe|doctor|die forced die probe' \
    'die_step on the CLI exits its code|3|FATAL: forced die_step probe|step|cli die_step 3 forced die_step probe' \
    'die_step under the TUI returns its code|103|FATAL: forced die_step probe|step|tui die_step 3 forced die_step probe'; do
    IFS='|' read -r name expected needle driver_name call_line <<<"${row}"
    IFS=' ' read -r -a call <<<"${call_line}"
    case "${driver_name}" in
      step) driver="${STEP_DRIVER}" ;;
      *) driver="${DOCTOR_DRIVER}" ;;
    esac
    run_forced_driver "${driver}" "${call[@]}"
    [[ "${status}" -eq "${expected}" ]] || {
      echo "${name}: status ${status}, expected ${expected}: ${output} ${stderr}"
      return 1
    }
    rest="${output#*"${needle}"}"
    [[ "${output}" == *"${needle}"* && "${rest}" != *"${needle}"* ]] || {
      echo "${name}: '${needle}' not exactly once on stderr: ${output}"
      return 1
    }
    [[ ! -s "${FORCED_STDOUT}" ]] || {
      echo "${name}: stdout not empty:"
      cat -- "${FORCED_STDOUT}"
      return 1
    }
  done
}
