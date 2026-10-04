#!/usr/bin/env bats
# update-migrate-deploy.bats — pins update_migrate_deploy_post_apply (scripts/update.sh step 9).
#
# `glass-atrium update` was a hash-diff file-copy transaction that shipped the new prisma/migrations
# directories and applied none of them, so an install that only ever updated ran new server code
# over an old schema until somebody hand-ran `glass-atrium db-setup`. The step under test closes
# that window: it applies PENDING migrations after the verified file apply and before the monitor
# restart, and it loud-fails with the named code 15 rather than skipping silently.
#
# Rows split into three groups, each proving something the others cannot:
#   T1-T2b the three documented no-ops (the GA_SKIP_DB_SETUP opt-out, an absent migrations dir, a
#          monitor whose dependencies were never installed)
#   T3-T5  the loud-fail contract (unresolvable CLI, a failing deploy) on a recording stub
#   T6-T7  the REAL prisma binary against a REAL throwaway database — the only rows that prove a
#          migration actually lands, and the only rows that can observe an unreachable server
#   T8-T9  position inside update_run: after the apply + wire step, and no rollback on failure
#
# NO LIVE DATABASE IS EVER CONTACTED. T6/T7 start their own socket-only PostgreSQL cluster and
# create their throwaway database on it, and their monitor fixture carries a prisma.config.ts that
# deliberately does NOT `import "dotenv/config"` — the live monitor's .env (which names the
# production database) is therefore unreadable from the fixture, and DATABASE_URL can only come from
# the environment this suite sets. Both rows skip when the PostgreSQL tools or a built prisma CLI are
# unavailable, so a CI host without them stays green rather than silently weakening the contract.
# The backfill mode a clean deploy hands off to is always the recording stub at
# ATRIUM_UPDATE_BACKFILL_PY, set in every driver below — no row runs the real mode.
#
# Each row names its MUTATION — the single change that flips it — because a row that passes on both
# sides of its own subject proves nothing. The stub-based rows record every invocation, so "prisma
# was never reached" is asserted against a log rather than inferred from an exit code.
#
# BATS GATING NOTE (measured, bats 1.13.0 both legs — bash is the variable, not bats): @test bodies run
# under errexit, but a bare non-final `[[ ]]` / `(( ))` does NOT gate on macOS bash 3.2.57 — it DOES on
# Linux bash 5.3.9 (CI) — whereas a plain command (`[ ]`, `grep -q`, `let`) and any final command gate on
# BOTH. Every assertion here `return 1`s on mismatch, so each one independently fails the test.
#
# Run via: bats scripts/test/update-migrate-deploy.bats
# Requires: bats >= 1.5.0, bash 3.2+ (T6/T7 additionally: postgres + a built monitor prisma CLI)

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
export SKILL="${GA}/scripts/update.sh"

# shellcheck source-path=SCRIPTDIR source=../lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

setup() {
  [[ -f "${SKILL}" ]] || skip "update.sh not found: ${SKILL}"
  WORK="$(cd -- "$(mktemp -d -t ga-update-migrate-bats.XXXXXX)" && pwd -P)"
  INSTALL="${WORK}/install" # sandbox GA_ROOT
  MONITOR="${INSTALL}/monitor"
  STATE="${WORK}/state"
  CALLS="${WORK}/calls.log" # every stub invocation, in order
  REPORTS="${STATE}/daemon-reports"
  BACKFILL_LOG="${WORK}/backfill.log" # every backfill-mode invocation, one line each
  mkdir -p "${INSTALL}" "${MONITOR}" "${STATE}"
  seed_backfill_stub 0
  # Both roots the finalize retire step reads → sandboxed, so no run reaches a live store.
  export GA_DATA_ROOT="${WORK}/data-root"
  export GA_TARGET_HOME="${WORK}/target-home"
}

teardown() {
  drop_scratch_db
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
}

# ── fixtures ───────────────────────────────────────────────────────────────────────────────────

# The migrations directory the step gates on, holding one migration plus the lock FILE prisma keeps
# beside them. $1 (optional) = SQL body, so a real-database row can assert a specific effect.
seed_migrations() {
  local dir="${MONITOR}/prisma/migrations/20260101000000_ga_update_probe"
  mkdir -p -- "${dir}"
  printf 'provider = "postgresql"\n' >"${MONITOR}/prisma/migrations/migration_lock.toml"
  printf '%s\n' "${1:-SELECT 1;}" >"${dir}/migration.sql"
}

# Recording prisma stub: logs its argv AND the directory it was invoked from (the step's `cd` into
# the monitor root is part of the contract — prisma resolves its config relative to cwd), then exits
# with $1. Any stderr it writes must reach the caller untouched, so it writes a marker.
seed_prisma_stub() {
  local rc="${1:-0}"
  PRISMA_STUB="${WORK}/prisma-stub"
  cat >"${PRISMA_STUB}" <<STUB
#!/usr/bin/env bash
printf 'prisma %s (pwd=%s)\n' "\$*" "\${PWD}" >>"${CALLS}"
printf 'PRISMA-STDERR-MARKER\n' >&2
exit ${rc}
STUB
  chmod +x "${PRISMA_STUB}"
}

# Recording backfill-mode stub: logs its argv plus whether the reports dir's .apply-lock pid names
# one of its ancestors (the mode's own lock gate), then exits with $1.
seed_backfill_stub() {
  local rc="${1:-0}"
  BACKFILL_STUB="${WORK}/backfill-stub.py"
  cat >"${BACKFILL_STUB}" <<STUB
import os, subprocess, sys
args = sys.argv[1:]
reports = args[args.index("--reports-dir") + 1] if "--reports-dir" in args else ""
holder = "nolock"
try:
    with open(os.path.join(reports, ".apply-lock", "pid")) as handle:
        lock_pid = int(handle.read().strip())
    pid, chain = os.getpid(), []
    while pid > 1:
        ps = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True)
        pid = int(ps.stdout.strip() or 0)
        chain.append(pid)
    holder = "ancestor" if lock_pid in chain else "foreign"
except (OSError, ValueError):
    pass
with open("${BACKFILL_LOG}", "a") as handle:
    handle.write(" ".join(args) + " lock=" + holder + "\n")
sys.exit(${rc})
STUB
}

# Run the step alone, in a fresh strict-mode subprocess, against the sandbox. The DB-target inputs
# are cleared first so the caller's shell cannot flip a row; extra env assignments may be passed as
# NAME=VALUE arguments.
run_step() {
  run env -u DATABASE_URL -u ATRIUM_UPDATE_DB_NAME -u GA_SKIP_DB_SETUP -u GA_DB_NAME \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    ATRIUM_UPDATE_BACKFILL_PY="${BACKFILL_STUB}" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_MONITOR_DIR="${MONITOR}" \
    ATRIUM_UPDATE_PRISMA="${PRISMA_STUB:-${WORK}/absent-prisma}" \
    "$@" \
    bash -c '
      set -Eeuo pipefail
      IFS=$'"'"'\n\t'"'"'
      source "$1"
      update_migrate_deploy_post_apply
    ' _ "${SKILL}"
}

assert_has() {
  [[ "${output}" == *"${1}"* ]] || {
    echo "output missing '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

assert_lacks() {
  [[ "${output}" != *"${1}"* ]] || {
    echo "output unexpectedly contains '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# prisma reached / not reached, asserted against the recorded log rather than inferred.
assert_prisma_ran() {
  [[ -s "${CALLS}" ]] || {
    echo "prisma was never invoked (empty ${CALLS})" >&2
    return 1
  }
}

assert_prisma_never_ran() {
  [[ ! -s "${CALLS}" ]] || {
    echo "prisma was invoked when it must not have been: $(cat -- "${CALLS}")" >&2
    return 1
  }
}

# ── T1 — the documented opt-out is a LOUD no-op, and the guard is what silences it ──────────────

@test "T1: GA_SKIP_DB_SETUP skips the deploy, says so with the remedy, and never reaches prisma" {
  seed_migrations
  seed_prisma_stub 0

  run_step GA_SKIP_DB_SETUP=1
  [[ "${status}" -eq 0 ]] || return 1
  assert_has "migrate: SKIPPED (GA_SKIP_DB_SETUP set)" || return 1
  assert_has "db-setup" || return 1
  assert_prisma_never_ran || return 1

  # MUTATION — drop the opt-out and nothing else: prisma is now reached, proving the skip above was
  # the guard's doing and not a fixture that could never have run in the first place.
  run_step
  [[ "${status}" -eq 0 ]] || return 1
  assert_prisma_ran || return 1
}

# ── T2 — no migrations directory: nothing to apply, and the directory is what decides it ────────

@test "T2: an absent migrations directory is a no-op that names itself and never reaches prisma" {
  seed_prisma_stub 0

  run_step
  [[ "${status}" -eq 0 ]] || return 1
  assert_has "no migrations directory" || return 1
  assert_prisma_never_ran || return 1

  # MUTATION — create the directory and nothing else: the step now runs.
  seed_migrations
  run_step
  [[ "${status}" -eq 0 ]] || return 1
  assert_prisma_ran || return 1
}

# ── T2b — a monitor whose dependencies were never installed is a loud skip, NOT a failed update ──

# The migrations directory SHIPS with the release, so every install gains it by updating — while
# node_modules never ships and is deliberately removed by uninstall as a regenerable artifact
# (lib/ga-core.sh). "migrations present, node_modules absent" is therefore a state a normal machine
# reaches by updating, and failing the whole update there would brick `glass-atrium update` on it.
# The row pins the skip AND its remedy text, because a skip nobody can act on is the silent failure
# this step exists to remove.
@test "T2b: an uninstalled monitor skips loudly with the npm ci remedy instead of failing the update" {
  seed_migrations # migrations present; node_modules deliberately absent

  # No ATRIUM_UPDATE_PRISMA override: the default derivation is what has to notice.
  run env -u DATABASE_URL -u ATRIUM_UPDATE_DB_NAME -u GA_SKIP_DB_SETUP -u GA_DB_NAME \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    ATRIUM_UPDATE_BACKFILL_PY="${BACKFILL_STUB}" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_MONITOR_DIR="${MONITOR}" \
    bash -c '
      set -Eeuo pipefail
      source "$1"
      update_migrate_deploy_post_apply
    ' _ "${SKILL}"
  [[ "${status}" -eq 0 ]] || {
    echo "an uninstalled monitor failed the update instead of skipping, got ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  assert_has "monitor dependencies not installed" || return 1
  assert_has "npm ci" || return 1     # how to recover
  assert_has "db-setup" || return 1   # how to finish afterwards
  assert_has "doctor" || return 1     # where the still-pending migrations stay visible

  # MUTATION — create node_modules WITHOUT a prisma binary in it, changing nothing else. The
  # install is now broken rather than uninstalled, and the same step loud-fails.
  mkdir -p -- "${MONITOR}/node_modules"
  run env -u DATABASE_URL -u ATRIUM_UPDATE_DB_NAME -u GA_SKIP_DB_SETUP -u GA_DB_NAME \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    ATRIUM_UPDATE_BACKFILL_PY="${BACKFILL_STUB}" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_MONITOR_DIR="${MONITOR}" \
    bash -c '
      set -Eeuo pipefail
      source "$1"
      update_migrate_deploy_post_apply
    ' _ "${SKILL}"
  [[ "${status}" -eq 15 ]] || {
    echo "a broken (not uninstalled) monitor did not loud-fail 15, got ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  assert_has "prisma CLI missing or not executable" || return 1
}

# ── T3 — an unresolvable prisma CLI loud-fails 15 and names both the path and the recovery ──────

@test "T3: a missing prisma CLI exits 15 naming the path, the dependency fix and db-setup" {
  seed_migrations
  PRISMA_STUB="${WORK}/not-installed/prisma" # nothing at this path at all

  run_step
  [[ "${status}" -eq 15 ]] || {
    echo "expected named exit 15, got ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  assert_has "prisma CLI missing or not executable" || return 1
  assert_has "${WORK}/not-installed/prisma" || return 1 # the path, so the operator can look
  assert_has "npm ci" || return 1                       # how to get the CLI back
  assert_has "db-setup" || return 1                     # how to finish the migration afterwards
  assert_has "PENDING migrations were NOT applied" || return 1

  # MUTATION — same path, now a real executable: the loud-fail is the CLI's absence, nothing else.
  mkdir -p -- "$(dirname -- "${PRISMA_STUB}")"
  printf '#!/usr/bin/env bash\nexit 0\n' >"${PRISMA_STUB}"
  chmod +x "${PRISMA_STUB}"
  run_step
  [[ "${status}" -eq 0 ]] || return 1
}

# ── T4 — the happy path invokes `migrate deploy` FROM the monitor root ──────────────────────────

@test "T4: the step runs 'migrate deploy' with the monitor root as cwd" {
  seed_migrations
  seed_prisma_stub 0

  run_step
  [[ "${status}" -eq 0 ]] || return 1
  assert_has "migrate: applying pending Prisma migrations" || return 1
  assert_has "migrate: pending Prisma migrations applied" || return 1

  # `deploy`, not `dev`: the interactive first-install path must never be what an update runs.
  grep -qF 'prisma migrate deploy' "${CALLS}" || {
    echo "recorded calls did not carry 'migrate deploy': $(cat -- "${CALLS}")" >&2
    return 1
  }
  # cwd is the monitor root — prisma resolves prisma.config.ts relative to it, so a step that ran
  # from anywhere else would read a different datasource or none at all.
  grep -qF "pwd=${MONITOR}" "${CALLS}" || {
    echo "prisma did not run from the monitor root (${MONITOR}): $(cat -- "${CALLS}")" >&2
    return 1
  }
  # exactly one invocation — no retry loop, no double-apply
  [[ "$(grep -c 'prisma migrate deploy' "${CALLS}")" -eq 1 ]] || return 1
}

# ── T5 — a failing deploy loud-fails 15, keeps prisma's own diagnosis, and names the recovery ───

@test "T5: a failing 'migrate deploy' exits 15, passes prisma's stderr through and names db-setup" {
  seed_migrations
  seed_prisma_stub 3

  run_step
  [[ "${status}" -eq 15 ]] || {
    echo "expected named exit 15, got ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  assert_has "prisma migrate deploy failed (rc=3)" || return 1
  assert_has "database schema was NOT migrated" || return 1
  assert_has "db-setup" || return 1
  # prisma's OWN stderr is the diagnosis and must not be swallowed — the step carries no 2>/dev/null
  assert_has "PRISMA-STDERR-MARKER" || return 1

  # MUTATION — same fixture, stub exits 0: the 15 came from prisma's status, not from the fixture.
  seed_prisma_stub 0
  run_step
  [[ "${status}" -eq 0 ]] || return 1
}

# ── real-database rows ─────────────────────────────────────────────────────────────────────────

# A monitor fixture the REAL prisma CLI can run in. Two safety properties, both deliberate:
#   * the config does NOT import "dotenv/config", so no .env is ever read and the live monitor's
#     production DATABASE_URL is unreachable from here — the URL can only come from the environment
#   * node_modules is a symlink to an already-built tree; nothing is installed or fetched
seed_real_monitor_fixture() {
  seed_migrations 'CREATE TABLE ga_update_migrate_probe (id integer PRIMARY KEY);'
  ln -sfn "${REAL_NODE_MODULES}" "${MONITOR}/node_modules"
  cat >"${MONITOR}/prisma.config.ts" <<'CONFIG'
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
CONFIG
  cat >"${MONITOR}/prisma/schema.prisma" <<'SCHEMA'
datasource db {
  provider = "postgresql"
}
SCHEMA
}

# Skip unless a real prisma CLI and the PostgreSQL tools are both present; start a private cluster
# and export the fixture inputs the two rows below need. Sets REAL_NODE_MODULES / SCRATCH_DB /
# SCRATCH_URL, and PGHOST/PGPORT = the cluster; teardown stops it.
require_real_prisma_and_db() {
  local prisma_bin=""
  local candidate
  for candidate in "${GA}/monitor/node_modules/.bin/prisma" \
    "${HOME}/.glass-atrium/monitor/node_modules/.bin/prisma"; do
    if [[ -x "${candidate}" ]]; then
      prisma_bin="${candidate}"
      break
    fi
  done
  [[ -n "${prisma_bin}" ]] || skip "no built monitor prisma CLI"
  REAL_NODE_MODULES="$(cd -- "$(dirname -- "$(dirname -- "${prisma_bin}")")" && pwd -P)"
  PRISMA_STUB="${prisma_bin}" # the seam takes the REAL binary for these rows

  local tool
  for tool in initdb pg_ctl createdb dropdb psql; do
    command -v "${tool}" >/dev/null 2>&1 || skip "${tool} unavailable"
  done

  # A private socket-only cluster, never the default one: an ambient PGHOSTADDR would route the
  # bring-up's own createdb/psql over TCP, so the libpq redirects are cleared before the first PG call.
  unset PGPORT PGHOSTADDR PGSERVICE PGDATABASE PGPASSFILE
  # shellcheck source-path=SCRIPTDIR source=../../hooks/test/lib/ephemeral-pg.bash
  source "${GA}/hooks/test/lib/ephemeral-pg.bash"
  EPH_DATADIR="${BATS_TEST_TMPDIR}/pgdata"
  EPH_SOCKDIR="${BATS_TEST_TMPDIR}/sock"
  EPH_PORT="55455"
  eph_pg_start "${EPH_DATADIR}" "${EPH_SOCKDIR}" "${EPH_PORT}" "eph_bootstrap" || return 1
  export PGHOST="${EPH_SOCKDIR}" PGPORT="${EPH_PORT}"
  [[ "${PGHOST}" == "${EPH_SOCKDIR}" ]] || {
    echo "PGHOST is not the ephemeral cluster's socket dir — refusing to write" >&2
    return 1
  }

  SCRATCH_DB="ga_upd_mig_bats_$$"
  createdb -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" "${SCRATCH_DB}" || return 1
  # The port rides the authority, the form libpq and prisma's engine both parse.
  SCRATCH_URL="postgresql://${USER}@localhost:${EPH_PORT}/${SCRATCH_DB}?host=${EPH_SOCKDIR}"
  psql -d "${SCRATCH_URL}" -tAc 'SELECT 1' >/dev/null || return 1
}

drop_scratch_db() {
  if [[ -n "${SCRATCH_DB:-}" ]]; then
    dropdb -h "${EPH_SOCKDIR}" -p "${EPH_PORT}" --if-exists "${SCRATCH_DB}" >/dev/null 2>&1 || true
    SCRATCH_DB=""
  fi
  if [[ -n "${EPH_DATADIR:-}" ]]; then
    eph_pg_stop "${EPH_DATADIR}"
    EPH_DATADIR=""
  fi
}

# ── T6 — an unreachable database is a loud 15, carrying prisma's own connection diagnosis ───────

@test "T6: an unreachable database loud-fails 15 with the connection error visible" {
  require_real_prisma_and_db
  seed_real_monitor_fixture

  # MUTATION — the connection string, and only the connection string: a socket directory that holds
  # no server. Everything else is byte-identical to T7, which passes.
  run_step DATABASE_URL="postgresql://${USER}@localhost/${SCRATCH_DB}?host=${WORK}/no-such-socket-dir"
  [[ "${status}" -eq 15 ]] || {
    echo "expected named exit 15 on an unreachable database, got ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  assert_has "prisma migrate deploy failed" || return 1
  assert_has "database schema was NOT migrated" || return 1
  assert_has "db-setup" || return 1

  # the probe table must NOT exist — a failed deploy applies nothing
  local present
  present="$(psql -d "${SCRATCH_URL}" -tAc "SELECT to_regclass('public.ga_update_migrate_probe')" 2>/dev/null || true)"
  [[ -z "${present}" ]] || {
    echo "a failed deploy still created the table: '${present}'" >&2
    return 1
  }
}

# ── T7 — the real step APPLIES a pending migration, and re-running it is a clean no-op ──────────

@test "T7: a pending migration is applied to a throwaway database and a re-run is idempotent" {
  require_real_prisma_and_db
  seed_real_monitor_fixture

  # Pre-state: the migration is genuinely PENDING — the table the row asserts does not exist yet,
  # so its later presence can only come from this step.
  local before
  before="$(psql -d "${SCRATCH_URL}" -tAc "SELECT to_regclass('public.ga_update_migrate_probe')" 2>/dev/null || true)"
  [[ -z "${before}" ]] || {
    echo "the probe table already existed before the step: '${before}'" >&2
    return 1
  }

  run_step DATABASE_URL="${SCRATCH_URL}"
  [[ "${status}" -eq 0 ]] || {
    echo "expected the deploy to succeed, got ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  assert_has "migrate: pending Prisma migrations applied" || return 1

  local after
  after="$(psql -d "${SCRATCH_URL}" -tAc "SELECT to_regclass('public.ga_update_migrate_probe')" 2>/dev/null || true)"
  [[ "${after}" == "ga_update_migrate_probe" ]] || {
    echo "the pending migration did not land — to_regclass returned '${after}'" >&2
    echo "${output}" >&2
    return 1
  }
  # prisma recorded the migration as applied, which is what makes the next run a no-op
  local applied
  applied="$(psql -d "${SCRATCH_URL}" -tAc \
    "SELECT count(*) FROM _prisma_migrations WHERE migration_name = '20260101000000_ga_update_probe' AND finished_at IS NOT NULL" 2>/dev/null || true)"
  [[ "${applied}" == "1" ]] || {
    echo "history does not carry exactly one finished row: '${applied}'" >&2
    return 1
  }

  # Idempotency — the step runs on EVERY update, so a repeat with nothing pending must succeed and
  # apply nothing new rather than error or re-run the SQL (a re-run of the CREATE would fail).
  run_step DATABASE_URL="${SCRATCH_URL}"
  [[ "${status}" -eq 0 ]] || {
    echo "the no-pending re-run did not succeed, got ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  local applied_again
  applied_again="$(psql -d "${SCRATCH_URL}" -tAc \
    "SELECT count(*) FROM _prisma_migrations WHERE migration_name = '20260101000000_ga_update_probe'" 2>/dev/null || true)"
  [[ "${applied_again}" == "1" ]] || {
    echo "the re-run duplicated the history row: '${applied_again}'" >&2
    return 1
  }
}

# ── update_run integration: position, and no rollback on failure ────────────────────────────────

# The end-to-end rows drive the REAL update_run through the ATRIUM_UPDATE_SRC_DIR seam, so the
# migrate step is observed where it actually sits rather than called directly.
seed_e2e() {
  NEWSRC="${WORK}/newsrc"
  mkdir -p "${NEWSRC}/scripts" "${WORK}/facade"
  printf 'old' >"${INSTALL}/scripts/tool.sh" 2>/dev/null || {
    mkdir -p "${INSTALL}/scripts"
    printf 'old' >"${INSTALL}/scripts/tool.sh"
  }
  printf 'new content' >"${NEWSRC}/scripts/tool.sh"
  local sha
  if command -v shasum >/dev/null 2>&1; then
    sha="$(shasum -a 256 -- "${NEWSRC}/scripts/tool.sh" | awk '{print $1}')"
  else
    sha="$(sha256sum -- "${NEWSRC}/scripts/tool.sh" | awk '{print $1}')"
  fi
  printf '{"version":"1.0.0","files":["scripts/tool.sh"],"hashes":{"scripts/tool.sh":"%s"}}\n' \
    "${sha}" >"${WORK}/manifest.json"
  # The launcher the farm + wire steps shell out to, recording into the SAME log as the prisma stub
  # so the two steps' relative ORDER is observable.
  cat >"${INSTALL}/glass-atrium" <<STUB
#!/usr/bin/env bash
printf 'launcher %s\n' "\$*" >>"${CALLS}"
exit 0
STUB
  chmod +x "${INSTALL}/glass-atrium"
  seed_migrations
}

run_e2e() {
  run env -u DATABASE_URL -u ATRIUM_UPDATE_DB_NAME -u GA_SKIP_DB_SETUP -u GA_DB_NAME \
    GA_ROOT="${INSTALL}" \
    GA_TARGET_HOME="${WORK}/facade" \
    AUTOAGENT_REPORTS_DIR="${REPORTS}" \
    ATRIUM_UPDATE_BACKFILL_PY="${BACKFILL_STUB}" \
    ATRIUM_UPDATE_STATE_DIR="${STATE}/update-state" \
    ATRIUM_UPDATE_SRC_DIR="${NEWSRC}" \
    ATRIUM_UPDATE_SRC_MANIFEST="${WORK}/manifest.json" \
    ATRIUM_UPDATE_MONITOR_DIR="${MONITOR}" \
    ATRIUM_UPDATE_PRISMA="${PRISMA_STUB}" \
    bash "${SKILL}"
}

@test "T8: update_run applies migrations AFTER the file apply and the wire step" {
  seed_e2e
  seed_prisma_stub 0

  run_e2e
  [[ "${status}" -eq 0 ]] || {
    echo "the driven update did not succeed, got ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new content" ]] || return 1 # the apply landed first

  # Ordering, read off the shared call log: the migrate deploy is the LAST recorded step, after the
  # facade refresh and the hook wiring — which is what puts it before the monitor restart.
  grep -qF 'launcher wire-hooks' "${CALLS}" || {
    echo "wire-hooks never ran: $(cat -- "${CALLS}")" >&2
    return 1
  }
  [[ "$(tail -n 1 "${CALLS}")" == prisma\ migrate\ deploy* ]] || {
    echo "migrate deploy was not the last step: $(cat -- "${CALLS}")" >&2
    return 1
  }
}

@test "T9: a failing migrate step loud-fails 15 from update_run and leaves the applied files in place" {
  seed_e2e
  seed_prisma_stub 4

  run_e2e
  [[ "${status}" -eq 15 ]] || {
    echo "expected named exit 15 from the driven update, got ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  assert_has "prisma migrate deploy failed (rc=4)" || return 1
  # Files stay APPLIED — the shipped code carries legacy read paths for exactly this window, and a
  # half-reverted install is worse than a migration left pending (exit-11/exit-12 precedent).
  [[ "$(cat "${INSTALL}/scripts/tool.sh")" == "new content" ]] || {
    echo "the failing migrate step rolled back the applied files" >&2
    return 1
  }
  # The run stopped here rather than reporting success downstream.
  assert_lacks "update complete" || return 1
  # The trap still released the writer-serialization state on the failure path.
  [[ ! -d "${STATE}/daemon-reports/.apply-lock" ]] || {
    echo "the apply lock survived the loud-fail" >&2
    return 1
  }

  # MUTATION — same driven run, stub exits 0: the 15 is the deploy's status, not the harness.
  seed_prisma_stub 0
  printf 'old' >"${INSTALL}/scripts/tool.sh"
  run_e2e
  [[ "${status}" -eq 0 ]] || return 1
}

# ── re-arm marker and the unadjudicated backfill hand-off ───────────────────────────────────────

# The daemon cycle head runs the backfill while this marker exists, so the step writes it before any
# branch can return; the step itself runs the mode only after a deploy that exited 0.
marker_path() { printf '%s\n' "${REPORTS}/.unadjudicated-backfill-pending"; }

assert_backfill_never_ran() {
  [[ ! -s "${BACKFILL_LOG}" ]] || {
    echo "the backfill mode ran when it must not have: $(cat -- "${BACKFILL_LOG}")" >&2
    return 1
  }
}

assert_backfill_ran_once_with() {
  local reports="$1" lines
  lines="$(wc -l <"${BACKFILL_LOG}" 2>/dev/null | tr -d ' ')"
  [[ "${lines}" == "1" ]] || {
    echo "expected exactly one backfill invocation, got '${lines}': $(cat -- "${BACKFILL_LOG}" 2>/dev/null)" >&2
    return 1
  }
  grep -qF -- "--backfill-unadjudicated --reports-dir ${reports} lock=" "${BACKFILL_LOG}" || {
    echo "backfill argv did not name the reports dir ${reports}: $(cat -- "${BACKFILL_LOG}")" >&2
    return 1
  }
}

@test "a failing deploy leaves the re-arm marker for the cycle and never runs the backfill" {
  seed_migrations
  seed_prisma_stub 3

  run_step
  [[ "${status}" -eq 15 ]] || {
    echo "expected named exit 15, got ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  [[ -f "$(marker_path)" ]] || {
    echo "no re-arm marker at $(marker_path) — output:" >&2
    echo "${output}" >&2
    return 1
  }
  assert_backfill_never_ran || return 1
}

@test "every documented no-op still writes the re-arm marker and never runs the backfill" {
  local row name
  for row in skip-opt-out no-migrations-dir no-node-modules; do
    name="${row}"
    MONITOR="${WORK}/${row}/monitor"
    REPORTS="${WORK}/${row}/reports"
    BACKFILL_LOG="${WORK}/${row}/backfill.log"
    mkdir -p -- "${MONITOR}"
    seed_backfill_stub 0
    seed_prisma_stub 0
    case "${row}" in
      skip-opt-out)
        seed_migrations
        run_step GA_SKIP_DB_SETUP=1
        ;;
      no-migrations-dir) run_step ;;
      no-node-modules)
        seed_migrations
        run_step ATRIUM_UPDATE_PRISMA=
        ;;
    esac
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: expected rc 0, got ${status} — output:" >&2
      echo "${output}" >&2
      return 1
    }
    [[ -f "$(marker_path)" ]] || {
      echo "${name}: no re-arm marker at $(marker_path) — output:" >&2
      echo "${output}" >&2
      return 1
    }
    assert_backfill_never_ran || {
      echo "${name}" >&2
      return 1
    }
  done
}

@test "a clean deploy runs the backfill once, under the reports dir the marker went to" {
  local row
  for row in reports-env data-root-only; do
    seed_migrations
    seed_prisma_stub 0
    BACKFILL_LOG="${WORK}/${row}.log"
    seed_backfill_stub 0
    if [[ "${row}" == reports-env ]]; then
      REPORTS="${WORK}/${row}/reports"
      run_step
    else
      REPORTS="${WORK}/${row}/data/daemon-reports"
      # a nested env drops the AUTOAGENT_REPORTS_DIR run_step sets, leaving GA_DATA_ROOT to decide
      run_step env -u AUTOAGENT_REPORTS_DIR GA_DATA_ROOT="${WORK}/${row}"
    fi
    [[ "${status}" -eq 0 ]] || {
      echo "${row}: expected rc 0, got ${status} — output:" >&2
      echo "${output}" >&2
      return 1
    }
    [[ -f "$(marker_path)" ]] || {
      echo "${row}: no re-arm marker at $(marker_path) — output:" >&2
      echo "${output}" >&2
      return 1
    }
    assert_backfill_ran_once_with "${REPORTS}" || {
      echo "${row}" >&2
      return 1
    }
  done
}

@test "an overridden migrate target skips the backfill by name and leaves the update rc at 0" {
  local row input expect_ran needle
  local secret="postgresql://sentinel-user:sentinel-pass@db.invalid/elsewhere"
  for row in database-url sandbox-db-name install-db-name; do
    BACKFILL_LOG="${WORK}/${row}.log"
    seed_backfill_stub 0
    seed_migrations
    seed_prisma_stub 0
    case "${row}" in
      database-url) input="DATABASE_URL=${secret}" expect_ran=0 needle="DATABASE_URL is set" ;;
      sandbox-db-name) input="ATRIUM_UPDATE_DB_NAME=sbx_db" expect_ran=0 needle="ATRIUM_UPDATE_DB_NAME=sbx_db" ;;
      install-db-name) input="ATRIUM_UPDATE_DB_NAME=glass_atrium" expect_ran=1 needle="" ;;
    esac
    run_step "${input}"
    [[ "${status}" -eq 0 ]] || {
      echo "${row}: expected rc 0, got ${status} — output:" >&2
      echo "${output}" >&2
      return 1
    }
    if [[ "${expect_ran}" -eq 1 ]]; then
      assert_backfill_ran_once_with "${REPORTS}" || {
        echo "${row}" >&2
        return 1
      }
    else
      assert_backfill_never_ran || {
        echo "${row}" >&2
        return 1
      }
      assert_has "unadjudicated backfill SKIPPED — ${needle}" || {
        echo "${row}" >&2
        return 1
      }
    fi
    # The connection string is never expanded into the log.
    assert_lacks "sentinel-pass" || {
      echo "${row}" >&2
      return 1
    }
  done
}

@test "each backfill exit code gets its own named line and never changes the update rc" {
  local row rc needle
  for row in "0|unadjudicated backfill done" \
    "7|unadjudicated backfill hit a PostgreSQL fault (rc=7)" \
    "10|unadjudicated backfill deferred (rc=10)" \
    "11|unadjudicated backfill refused — apply lock not held (rc=11)" \
    "13|unadjudicated backfill failed (rc=13)" \
    "2|unadjudicated backfill failed (rc=2)"; do
    rc="${row%%|*}"
    needle="${row#*|}"
    BACKFILL_LOG="${WORK}/rc-${rc}.log"
    seed_backfill_stub "${rc}"
    seed_migrations
    seed_prisma_stub 0
    run_step
    [[ "${status}" -eq 0 ]] || {
      echo "mode rc ${rc}: expected update rc 0, got ${status} — output:" >&2
      echo "${output}" >&2
      return 1
    }
    assert_has "${needle}" || {
      echo "mode rc ${rc}" >&2
      return 1
    }
  done
}

@test "a missing backfill entry point is a named warning, not a failed update" {
  seed_migrations
  seed_prisma_stub 0

  run_step ATRIUM_UPDATE_BACKFILL_PY="${WORK}/absent-backfill.py"
  [[ "${status}" -eq 0 ]] || {
    echo "expected rc 0, got ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  assert_has "WARN: unadjudicated backfill skipped — no entry point at ${WORK}/absent-backfill.py" || return 1
  [[ -f "$(marker_path)" ]] || return 1
}

@test "an unwritable reports dir warns by name and the deploy still runs" {
  seed_migrations
  seed_prisma_stub 0
  printf 'not a directory' >"${WORK}/blocker"
  REPORTS="${WORK}/blocker/reports"

  run_step
  [[ "${status}" -eq 0 ]] || {
    echo "expected rc 0, got ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  assert_has "WARN: could not write the unadjudicated-backfill re-arm marker" || return 1
  assert_prisma_ran || return 1
}

@test "update_run hands the backfill the reports dir while its own apply lock is held" {
  seed_e2e
  seed_prisma_stub 0

  run_e2e
  [[ "${status}" -eq 0 ]] || {
    echo "the driven update did not succeed, got ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
  grep -qF -- "--backfill-unadjudicated --reports-dir ${REPORTS} lock=ancestor" "${BACKFILL_LOG}" || {
    echo "the backfill did not run under the updater's lock: $(cat -- "${BACKFILL_LOG}" 2>/dev/null)" >&2
    return 1
  }
}
