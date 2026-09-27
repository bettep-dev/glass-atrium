#!/usr/bin/env bats
# daemon-apply.sh's own delete paths — the backup-retention prune and the RETURN-trap scratch
# teardown — each gated on the shared path guard (scripts/lib/path-guard.sh).
#
# daemon-apply.sh runs top-level code and is not sourceable, so the functions under test are
# extracted from the header line through the first column-0 close brace.
#
# Run via: bats autoagent/test/daemon-apply-delete-paths.bats
# Requires: bats >= 1.5.0, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
APPLY_SH="${GA}/autoagent/daemon-apply.sh"

setup() {
  # shellcheck source=../../scripts/lib/path-guard.sh
  source "${GA}/scripts/lib/path-guard.sh"
  [[ -f "${APPLY_SH}" ]] || skip "daemon-apply.sh not found: ${APPLY_SH}"
  WORK="$(cd -- "$(mktemp -d -t daemon-apply-delete.XXXXXX)" && pwd -P)"
  local name
  for name in prune_backup_retention remove_expired_backups delete_scratch_files; do
    sed -n "/^${name}() {\$/,/^}\$/p" "${APPLY_SH}"
  done >"${WORK}/fns.sh"
  # shellcheck source=/dev/null
  source "${WORK}/fns.sh"
  BACKUP_TTL_DAYS=14
}

teardown() {
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
}

# make_cycles — $1 = backup root; one cycle subdir per remaining arg, each aged to that YYYYMMDD.
make_cycles() {
  local root="${1}" stamp
  shift
  for stamp in "$@"; do
    mkdir -p -- "${root}/cycle-${stamp}"
    touch -t "${stamp}0000" "${root}/cycle-${stamp}"
  done
}

@test "retention prune removes every expired cycle except the newest" {
  BACKUP_DIR="${WORK}/agents-bak"
  make_cycles "${BACKUP_DIR}" 20200101 20200102 20200103
  prune_backup_retention
  [[ ! -e "${BACKUP_DIR}/cycle-20200101" ]] || { echo "expired cycle 20200101 kept" >&2; return 1; }
  [[ ! -e "${BACKUP_DIR}/cycle-20200102" ]] || { echo "expired cycle 20200102 kept" >&2; return 1; }
  [[ -d "${BACKUP_DIR}/cycle-20200103" ]] || { echo "the newest cycle was pruned" >&2; return 1; }
}

@test "retention prune under a relative backup root removes nothing and warns" {
  # The suite seats every test in its scratch cwd, so the relative root lands there.
  BACKUP_DIR="rel-${BATS_TEST_NUMBER}/agents-bak"
  make_cycles "${BACKUP_DIR}" 20200101 20200102
  run --separate-stderr prune_backup_retention
  [[ "${status}" -eq 0 ]] || { echo "prune must stay a WARN, got status ${status}" >&2; return 1; }
  [[ -d "${BACKUP_DIR}/cycle-20200101" ]] || { echo "a relative cycle was deleted" >&2; return 1; }
  [[ "${stderr}" == *"refusing a non-absolute delete target"* ]] || return 1
  [[ "${stderr}" == *"backup retention prune hit errors"* ]] || return 1
}

@test "the scratch teardown removes every absolute path it is given and skips an empty one" {
  local first="${WORK}/scratch-a" second="${WORK}/scratch-b"
  : >"${first}"
  : >"${second}"
  delete_scratch_files "${first}" "" "${second}"
  [[ ! -e "${first}" && ! -e "${second}" ]] || { echo "a scratch file survived the teardown" >&2; return 1; }
}
