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
# NO LIVE DATABASE IS EVER CONTACTED. T6/T7 create their own throwaway database, and their monitor
# fixture carries a prisma.config.ts that deliberately does NOT `import "dotenv/config"` — the live
# monitor's .env (which names the production database) is therefore unreadable from the fixture,
# and DATABASE_URL can only come from the environment this suite sets. Both rows skip when
# PostgreSQL, createdb/dropdb or a built prisma CLI is unavailable, so a CI host without them stays
# green rather than silently weakening the contract.
#
# Each row names its MUTATION — the single change that flips it — because a row that passes on both
# sides of its own subject proves nothing. The stub-based rows record every invocation, so "prisma
# was never reached" is asserted against a log rather than inferred from an exit code.
#
# BATS GATING NOTE: a bare non-final `[[ ]]` does NOT gate — the keyword is read as a tested
# condition — whereas a plain command's non-zero return IS caught mid-body. Every assertion here
# `return 1`s on mismatch, so each one independently fails the test.
#
# Run via: bats scripts/test/update-migrate-deploy.bats
# Requires: bats >= 1.5.0, bash 3.2+ (T6/T7 additionally: postgres + a built monitor prisma CLI)

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
export SKILL="${GA}/scripts/update.sh"

setup() {
  [[ -f "${SKILL}" ]] || skip "update.sh not found: ${SKILL}"
  WORK="$(cd -- "$(mktemp -d -t ga-update-migrate-bats.XXXXXX)" && pwd -P)"
  INSTALL="${WORK}/install" # sandbox GA_ROOT
  MONITOR="${INSTALL}/monitor"
  STATE="${WORK}/state"
  CALLS="${WORK}/calls.log" # every stub invocation, in order
  mkdir -p "${INSTALL}" "${MONITOR}" "${STATE}"
}

teardown() {
  drop_scratch_db
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf -- "${WORK}" || true
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

# Run the step alone, in a fresh strict-mode subprocess, against the sandbox.
# Extra env assignments may be passed as NAME=VALUE arguments.
run_step() {
  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
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
  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
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
  run env \
    GA_ROOT="${INSTALL}" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
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

# Skip unless a real prisma CLI and a usable local PostgreSQL are both present, and export the
# fixture inputs the two rows below need. Sets REAL_NODE_MODULES / SCRATCH_DB / SCRATCH_URL.
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

  command -v createdb >/dev/null 2>&1 || skip "createdb unavailable"
  command -v dropdb >/dev/null 2>&1 || skip "dropdb unavailable"
  command -v psql >/dev/null 2>&1 || skip "psql unavailable"

  # A throwaway database of this suite's own making. The name is namespaced and carries the pid, so
  # it can never collide with — or be mistaken for — the live one.
  SCRATCH_DB="ga_upd_mig_bats_$$"
  createdb "${SCRATCH_DB}" 2>/dev/null || skip "cannot create a throwaway database"
  SCRATCH_URL="postgresql://${USER}@localhost/${SCRATCH_DB}?host=/tmp"
  psql -d "${SCRATCH_URL}" -tAc 'SELECT 1' >/dev/null 2>&1 || skip "throwaway database unreachable over the socket URL"
}

drop_scratch_db() {
  [[ -n "${SCRATCH_DB:-}" ]] || return 0
  dropdb --if-exists "${SCRATCH_DB}" >/dev/null 2>&1 || true
  SCRATCH_DB=""
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
  run env \
    GA_ROOT="${INSTALL}" \
    GA_TARGET_HOME="${WORK}/facade" \
    AUTOAGENT_REPORTS_DIR="${STATE}/daemon-reports" \
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
