#!/usr/bin/env bats
# doctor-migrations.bats — pins run_doctor §21 (pending Prisma migrations).
#
# `glass-atrium update` rebuilds and restarts the monitor without applying migrations, so a
# migrated repo can run new server code over an unmigrated database and nothing says so. This
# section reports that distance. Registration kind A (counted warning): the counter appears in the
# warning total AND in the PASS breakdown, and AC9 asserts both at once.
#
# The verdict is the difference between the migrations directory and the applied-history rows, and
# APPLIED means finished_at non-empty AND rolled_back_at empty — a failed or rolled-back row is a
# distinct report, never a silent "applied". Each row here asserts a state the others cannot
# produce, in particular the three states an earlier design folded together:
#   AC3  probe rc=0, no such database  -> nothing pending yet   (not a warning)
#   AC4  probe rc!=0, server unreachable -> undetermined        (not a warning, distinct wording)
#   AC5  history table absent          -> every migration pending (a WARNING, not "undetermined")
#
# NO DATABASE IS CONTACTED. Every psql invocation resolves to a recording stub placed ahead of
# PATH; the stub reads the SQL from stdin, picks a canned answer per query kind and exits with a
# per-scenario code. The one row that needs psql to be ABSENT (AC2) runs with every directory
# holding a real psql filtered out of PATH.
#
# BATS GATING NOTE: a bare non-final `[[ ]]` does NOT gate — the keyword is read as a tested
# condition — whereas a plain command's non-zero return IS caught mid-body. Every assertion here
# `return 1`s on mismatch, so each one independently fails the test.
#
# Run via: bats test/doctor-migrations.bats
# Requires: bats >= 1.5.0, jq, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"

  SANDBOX="$(mktemp -d -t ga-doctor-migrations-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga"
  TARGET="${SANDBOX}/target"
  MANIFEST="${SANDBOX}/manifest.json"
  STUB="${SANDBOX}/bin"
  STUB_STATE="${SANDBOX}/stub"
  MIGRATIONS="${SANDBOX}/migrations"
  mkdir -p "${TARGET}" "${GA_SANDBOX}/agents" "${STUB}" "${STUB_STATE}" "${MIGRATIONS}"
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${MANIFEST}"
  printf '{"version":"1.0.0","agents":{}}\n' >"${GA_SANDBOX}/agent-registry.json"
  seed_migrations
  seed_psql_stub
}

teardown() {
  unset GA_SKIP_DB_SETUP
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# Three migration directories plus the lock FILE Prisma keeps beside them — the lock is not a
# migration and must never be counted as one.
seed_migrations() {
  mkdir -p "${MIGRATIONS}/20260101000000_alpha" "${MIGRATIONS}/20260202000000_beta" \
    "${MIGRATIONS}/20260303000000_gamma"
  printf 'provider = "postgresql"\n' >"${MIGRATIONS}/migration_lock.toml"
}

# Recording psql stub: the query kind is read off the SQL on stdin, the answer and exit code come
# from per-kind files, and every call is logged so a test can assert psql was reached at all.
seed_psql_stub() {
  cat >"${STUB}/psql" <<'STUB'
#!/usr/bin/env bash
sql="$(cat)"
case "${sql}" in
  *pg_database*) kind=exists ;;
  *to_regclass*) kind=table ;;
  *) kind=history ;;
esac
printf '%s\n' "${kind}" >>"${GA_STUB_STATE}/calls.log"
[[ -f "${GA_STUB_STATE}/${kind}.out" ]] && cat -- "${GA_STUB_STATE}/${kind}.out"
if [[ -f "${GA_STUB_STATE}/${kind}.rc" ]]; then
  exit "$(cat -- "${GA_STUB_STATE}/${kind}.rc")"
fi
exit 0
STUB
  chmod +x "${STUB}/psql"
  # Default scenario: the database exists and its history table exists. Each test overrides what it
  # is about, so a row never silently depends on a state it did not set.
  stub_out exists '1'
  stub_out table 'public._prisma_migrations'
  stub_out history ''
}

# $1 = query kind (exists|table|history), $2 = stdout the stub returns for it.
stub_out() {
  printf '%s' "$2" >"${STUB_STATE}/$1.out"
}

# $1 = query kind, $2 = exit code the stub returns for it.
stub_rc() {
  printf '%s' "$2" >"${STUB_STATE}/$1.rc"
}

# One applied-history row in the stub's output shape: name, finished_at, rolled_back_at, separated
# by the unit separator the reader splits on (a whitespace separator would collapse the empty
# timestamps that decide the applied predicate).
history_row() {
  printf '%s\x1f%s\x1f%s\n' "$1" "${2:-}" "${3:-}"
}

# Drop every directory holding a real psql from PATH, so `command -v psql` genuinely fails.
path_without_psql() {
  local path="${PATH}" found dir out part guard=0
  local -a parts=()
  while [[ "${guard}" -lt 10 ]]; do
    found="$(PATH="${path}" command -v psql 2>/dev/null || true)"
    [[ -n "${found}" ]] || break
    dir="$(dirname -- "${found}")"
    out=""
    IFS=: read -r -a parts <<<"${path}"
    for part in "${parts[@]}"; do
      [[ "${part}" == "${dir}" ]] && continue
      out="${out}${out:+:}${part}"
    done
    path="${out}"
    guard=$((guard + 1))
  done
  printf '%s' "${path}"
}

# Run the REAL run_doctor against the sandbox GA_ROOT in a fresh strict-mode subprocess. GA_DB_NAME
# points the whole DB path at a throwaway name and PATH puts the stub first, so no live database
# name is ever spoken and no real psql is ever reached.
run_doctor_sandbox() {
  run env PATH="${1:-${STUB}:${PATH}}" \
    GA_LIB_DIR="${GA}/scripts/lib" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    GA_GENERATE_MANIFEST="${SANDBOX}/no-such-manifest-gen" \
    GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${SANDBOX}/state" \
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT:-9}" \
    GA_DB_NAME="ga_doctor_migrations_sandbox" \
    GA_MIGRATIONS_DIR="${MIGRATIONS}" GA_STUB_STATE="${STUB_STATE}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      run_doctor
    ' _ "${GA}" "${GA_SANDBOX}"
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

# Every migration applied — the green baseline other rows measure their warning delta against.
seed_fully_applied() {
  stub_out history "$(
    history_row 20260101000000_alpha 2026-01-01T00:00:00Z
    history_row 20260202000000_beta 2026-02-02T00:00:00Z
    history_row 20260303000000_gamma 2026-03-03T00:00:00Z
  )"
}

# ── AC1 — branch 1: the documented opt-out reports and counts nothing ──────────────────────────

@test "AC1: GA_SKIP_DB_SETUP reports a skip note and adds no warning" {
  seed_fully_applied
  run_doctor_sandbox
  local base
  base="$(warn_total_of_output)" || return 1

  export GA_SKIP_DB_SETUP=1
  run_doctor_sandbox
  assert_output_has "pending-migration check skipped (GA_SKIP_DB_SETUP set)" || return 1
  assert_output_lacks "migration(s) pending" || return 1
  local skipped
  skipped="$(warn_total_of_output)" || return 1
  [[ "${skipped}" -eq "${base}" ]] || {
    echo "the opt-out moved the warning total: ${base} -> ${skipped}" >&2
    return 1
  }
}

# ── AC2 — branch 2: psql absent is a supported mode, not a finding ─────────────────────────────

@test "AC2: no psql on PATH reports a skip note and adds no warning" {
  local nopsql
  nopsql="$(path_without_psql)"
  run_doctor_sandbox "${nopsql}"
  assert_output_has "pending-migration check skipped — psql not found" || return 1
  assert_output_lacks "migration(s) pending" || return 1
  local skipped
  skipped="$(warn_total_of_output)" || return 1
  # the stub must not have been consulted either — the branch is decided before any query
  [[ ! -f "${STUB_STATE}/calls.log" ]] || {
    echo "psql was queried on the psql-absent path: $(cat -- "${STUB_STATE}/calls.log")" >&2
    return 1
  }

  # The comparand runs LAST on purpose: it consults the stub, so measuring the green total first
  # would create calls.log and make the check above unfailable.
  seed_fully_applied
  run_doctor_sandbox
  local base
  base="$(warn_total_of_output)" || return 1
  [[ "${skipped}" -eq "${base}" ]] || {
    echo "the psql-less mode moved the warning total: ${base} -> ${skipped}" >&2
    return 1
  }
}

# ── AC3 — branch 3: the database does not exist yet, which is not a pending migration ──────────

@test "AC3: an absent database reports nothing-applied-yet, not a warning" {
  seed_fully_applied
  run_doctor_sandbox
  local base
  base="$(warn_total_of_output)" || return 1

  stub_out exists ''
  run_doctor_sandbox
  assert_output_has "no migrations applied yet" || return 1
  assert_output_lacks "migration(s) pending" || return 1
  assert_output_lacks "undetermined" || return 1
  local absent
  absent="$(warn_total_of_output)" || return 1
  [[ "${absent}" -eq "${base}" ]] || {
    echo "an absent database was counted as a warning: ${base} -> ${absent}" >&2
    return 1
  }
}

# ── AC4 — branch 4: an unreachable server is undetermined, worded differently from AC3 ─────────

@test "AC4: a failed existence probe is undetermined and distinct from the absent-database note" {
  # One run per scenario: the existence probe fails first, so a history seeded after it is never
  # consulted and a second undetermined run would repeat the first exactly.
  seed_fully_applied
  run_doctor_sandbox
  local green
  green="$(warn_total_of_output)" || return 1

  stub_rc exists 2
  run_doctor_sandbox
  assert_output_has "pending migrations undetermined" || return 1
  assert_output_lacks "no migrations applied yet" || return 1
  assert_output_lacks "migration(s) pending" || return 1
  local undetermined
  undetermined="$(warn_total_of_output)" || return 1
  [[ "${undetermined}" -eq "${green}" ]] || {
    echo "an unreachable server was counted as a warning: ${green} -> ${undetermined}" >&2
    return 1
  }
}

# ── AC5 — branch 5: an absent history table is every migration pending, and IS a warning ───────

@test "AC5: an absent history table warns that every migration is pending" {
  seed_fully_applied
  run_doctor_sandbox
  local base
  base="$(warn_total_of_output)" || return 1

  stub_out table ''
  run_doctor_sandbox
  assert_output_has "migration history table" || return 1
  assert_output_has "3 migration(s) pending" || return 1
  assert_output_lacks "undetermined" || return 1
  # kind A: this branch's pending count must reach the warning total and the PASS
  # breakdown too — a warn line printed beside a 0-warning summary is the false
  # green the registration contract exists to prevent.
  local pending
  pending="$(warn_total_of_output)" || return 1
  [[ "${pending}" -eq $((base + 3)) ]] || {
    echo "the table-absent branch did not feed the warning total: ${base} -> ${pending} (expected +3)" >&2
    echo "${output}" >&2
    return 1
  }
  assert_output_has "3 pending-migration" || return 1
}

# ── AC6 — branch 6: the table exists with no rows at all — same pending set, own wording ───────

@test "AC6: an empty history table warns that every migration is pending" {
  stub_out history ''
  run_doctor_sandbox
  assert_output_has "3 migration(s) pending" || return 1
  assert_output_has "20260101000000_alpha" || return 1
  assert_output_has "20260303000000_gamma" || return 1
  assert_output_lacks "migration history table" || return 1
  # the lock file sits beside the directories and is not a migration
  assert_output_lacks "migration_lock.toml" || return 1
}

# ── AC7 — branch 7: partial history names only what is missing; full history is green ──────────

@test "AC7: a partial history names only the unapplied migrations and a full history is green" {
  stub_out history "$(history_row 20260101000000_alpha 2026-01-01T00:00:00Z)"
  run_doctor_sandbox
  assert_output_has "2 migration(s) pending" || return 1
  assert_output_has "20260202000000_beta" || return 1
  assert_output_lacks "pending: 20260101000000_alpha" || return 1

  seed_fully_applied
  run_doctor_sandbox
  assert_output_has "all 3 migration(s) applied" || return 1
  assert_output_lacks "migration(s) pending" || return 1
}

# ── AC8 — the applied predicate: unfinished and rolled-back rows are pending AND reported ──────

@test "AC8: unfinished and rolled-back rows are not applied and are reported separately" {
  # alpha finished cleanly; beta never finished; gamma finished and was then rolled back.
  stub_out history "$(
    history_row 20260101000000_alpha 2026-01-01T00:00:00Z
    history_row 20260202000000_beta '' ''
    history_row 20260303000000_gamma 2026-03-03T00:00:00Z 2026-03-04T00:00:00Z
  )"
  run_doctor_sandbox
  assert_output_has "2 migration(s) pending" || return 1
  assert_output_has "failed/rolled-back" || return 1
  assert_output_has "20260202000000_beta" || return 1
  assert_output_has "20260303000000_gamma" || return 1
}

# ── AC9 — registration kind A: the counter reaches BOTH the total and the PASS breakdown ───────

@test "AC9: the pending counter is registered in the warning total and the PASS breakdown" {
  seed_fully_applied
  run_doctor_sandbox
  local base
  base="$(warn_total_of_output)" || return 1
  assert_output_lacks "1 pending-migration" || return 1

  stub_out history "$(history_row 20260101000000_alpha 2026-01-01T00:00:00Z)"
  run_doctor_sandbox
  local pending
  pending="$(warn_total_of_output)" || return 1
  [[ "${pending}" -eq $((base + 2)) ]] || {
    echo "the pending counter did not reach the warning total: ${base} -> ${pending} (expected +2)" >&2
    echo "${output}" >&2
    return 1
  }
  assert_output_has "2 pending-migration" || return 1
}
