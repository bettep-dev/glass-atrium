#!/usr/bin/env bats
# prune-job-scratch.bats — pins the per-entry-type behaviour of the job-scratch prune and the five
# root refusals that bound it.
#
# The behaviour under test that is easiest to get wrong: an aged top-level SYMLINK. A `-type d` walk
# tests the link itself (type `l`), so before the fix such a link survived every prune and job
# scratch accumulated stray links forever. Reaping it must stay link-semantic — the link goes, the
# target and everything under it stays — which is what the sentinel assertions below prove.
#
# Ages are set with `touch -t 202001010000` (and `touch -h` for links, which sets the link's own
# mtime rather than the target's), well past the fixed 14-day window. FRESH entries are left at
# their natural mtime.

PRUNE_SH="${BATS_TEST_DIRNAME}/../prune-job-scratch.sh"
STALE_STAMP='202001010000'

setup() {
  [[ -f "${PRUNE_SH}" ]] || skip "prune-job-scratch.sh not found"
  PJ_TMP="$(mktemp -d -t prune-job-scratch.XXXXXX)"
  ROOT="${PJ_TMP}/jobs"
  # The target tree lives OUTSIDE the scratch root: a prune that followed a link instead of
  # unlinking it would reach in here, so its survival is the link-semantics proof.
  OUTSIDE="${PJ_TMP}/outside"
  mkdir -p "${ROOT}" "${OUTSIDE}"
  printf 'sentinel\n' >"${OUTSIDE}/sentinel.txt"
  export GA_JOB_SCRATCH_ROOT="${ROOT}"
}

teardown() {
  [[ -n "${PJ_TMP:-}" && -d "${PJ_TMP}" ]] && rm -rf -- "${PJ_TMP}" || true
}

# Asserts the outside target tree is exactly as setup left it — nothing followed, nothing deleted.
assert_target_intact() {
  [ -d "${OUTSIDE}" ] || { echo "target dir removed"; return 1; }
  [ -f "${OUTSIDE}/sentinel.txt" ] || { echo "target sentinel removed"; return 1; }
  [ "$(cat "${OUTSIDE}/sentinel.txt")" == "sentinel" ] || { echo "target sentinel mutated"; return 1; }
}

@test "aged top-level symlink: pruned as a link, target tree provably intact" {
  ln -s "${OUTSIDE}" "${ROOT}/linkdir"
  touch -h -t "${STALE_STAMP}" "${ROOT}/linkdir"
  # readlink before the run, so the comparison after proves the target string was never rewritten.
  local target_before
  target_before="$(readlink "${ROOT}/linkdir")"

  run bash "${PRUNE_SH}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [[ "${output}" == *"pruned: ${ROOT}/linkdir"* ]] || { echo "aged link not pruned: ${output}"; return 1; }
  [[ "${output}" == *"pruned=1"* ]] || { echo "summary count wrong: ${output}"; return 1; }
  [ ! -L "${ROOT}/linkdir" ] || { echo "link survived the prune"; return 1; }
  [ ! -e "${ROOT}/linkdir" ] || { echo "link path still resolves"; return 1; }
  [ "${target_before}" == "${OUTSIDE}" ] || { echo "test setup wrong: ${target_before}"; return 1; }
  assert_target_intact
}

@test "aged top-level symlink to a FILE: unlinked, the file itself survives" {
  ln -s "${OUTSIDE}/sentinel.txt" "${ROOT}/linkfile"
  touch -h -t "${STALE_STAMP}" "${ROOT}/linkfile"

  run bash "${PRUNE_SH}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [ ! -L "${ROOT}/linkfile" ] || { echo "link survived"; return 1; }
  assert_target_intact
}

@test "fresh top-level symlink: survives the prune" {
  ln -s "${OUTSIDE}" "${ROOT}/freshlink"

  run bash "${PRUNE_SH}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [ -L "${ROOT}/freshlink" ] || { echo "fresh link was pruned"; return 1; }
  [[ "${output}" == *"pruned=0"* ]] || { echo "unexpected removal: ${output}"; return 1; }
  assert_target_intact
}

@test "top-level regular files: survive regardless of age" {
  printf '{}\n' >"${ROOT}/pins.json"
  printf 'idx\n' >"${ROOT}/index"
  touch -t "${STALE_STAMP}" "${ROOT}/pins.json" "${ROOT}/index"

  run bash "${PRUNE_SH}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [ -f "${ROOT}/pins.json" ] || { echo "aged top-level file removed"; return 1; }
  [ -f "${ROOT}/index" ] || { echo "aged top-level file removed"; return 1; }
  [[ "${output}" == *"pruned=0"* ]] || { echo "unexpected removal: ${output}"; return 1; }
}

@test "aged directory: pruned with contents; fresh directory survives" {
  mkdir -p "${ROOT}/oldjob/state" "${ROOT}/newjob"
  printf 'x\n' >"${ROOT}/oldjob/state/f"
  touch -t "${STALE_STAMP}" "${ROOT}/oldjob"

  run bash "${PRUNE_SH}"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [ ! -d "${ROOT}/oldjob" ] || { echo "aged dir survived"; return 1; }
  [ -d "${ROOT}/newjob" ] || { echo "fresh dir pruned"; return 1; }
  [[ "${output}" == *"pruned=1"* ]] || { echo "summary count wrong: ${output}"; return 1; }
}

@test "dry-run: aged directory AND aged link listed, neither removed" {
  mkdir -p "${ROOT}/oldjob"
  touch -t "${STALE_STAMP}" "${ROOT}/oldjob"
  ln -s "${OUTSIDE}" "${ROOT}/linkdir"
  touch -h -t "${STALE_STAMP}" "${ROOT}/linkdir"

  run bash "${PRUNE_SH}" --dry-run
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }

  [[ "${output}" == *"would prune: ${ROOT}/linkdir"* ]] || { echo "link not listed: ${output}"; return 1; }
  [[ "${output}" == *"would prune: ${ROOT}/oldjob"* ]] || { echo "dir not listed: ${output}"; return 1; }
  [[ "${output}" != *"pruned: "* ]] || { echo "dry run reported a real removal: ${output}"; return 1; }
  [[ "${output}" == *"dry_run=1"* ]] || { echo "summary missing dry_run: ${output}"; return 1; }
  [ -L "${ROOT}/linkdir" ] || { echo "dry run removed the link"; return 1; }
  [ -d "${ROOT}/oldjob" ] || { echo "dry run removed the dir"; return 1; }
  assert_target_intact
}

# --- root refusals: each exits 3 with nothing removed -------------------------------------------

@test "refusal: symlinked root is refused, never followed, contents untouched" {
  mkdir -p "${PJ_TMP}/realjobs"
  mkdir -p "${PJ_TMP}/realjobs/oldjob"
  touch -t "${STALE_STAMP}" "${PJ_TMP}/realjobs/oldjob"
  # basename is `jobs` and the target is a real writable dir, so only the -L refusal can stop this.
  mkdir -p "${PJ_TMP}/nest"
  ln -s "${PJ_TMP}/realjobs" "${PJ_TMP}/nest/jobs"

  run env GA_JOB_SCRATCH_ROOT="${PJ_TMP}/nest/jobs" bash "${PRUNE_SH}"
  [ "${status}" -eq 3 ] || { echo "expected exit 3, got ${status}: ${output}"; return 1; }
  [[ "${output}" == *"symlink"* ]] || { echo "wrong refusal reason: ${output}"; return 1; }
  [ -d "${PJ_TMP}/realjobs/oldjob" ] || { echo "refused run still removed an entry"; return 1; }
}

@test "refusal: traversal path whose basename is not jobs exits 3, nothing removed" {
  mkdir -p "${ROOT}/oldjob"
  touch -t "${STALE_STAMP}" "${ROOT}/oldjob"

  run env GA_JOB_SCRATCH_ROOT="${ROOT}/../jobs/.." bash "${PRUNE_SH}"
  [ "${status}" -eq 3 ] || { echo "expected exit 3, got ${status}: ${output}"; return 1; }
  [ -d "${ROOT}/oldjob" ] || { echo "refused run still removed an entry"; return 1; }
}

@test "refusal: relative root, wrong basename, and missing root each exit 3" {
  run env GA_JOB_SCRATCH_ROOT="relative/jobs" bash "${PRUNE_SH}"
  [ "${status}" -eq 3 ] || { echo "relative: expected 3, got ${status}"; return 1; }

  run env GA_JOB_SCRATCH_ROOT="${PJ_TMP}/outside" bash "${PRUNE_SH}"
  [ "${status}" -eq 3 ] || { echo "basename: expected 3, got ${status}"; return 1; }

  run env GA_JOB_SCRATCH_ROOT="${PJ_TMP}/absent/jobs" bash "${PRUNE_SH}"
  [ "${status}" -eq 3 ] || { echo "missing: expected 3, got ${status}"; return 1; }

  assert_target_intact
}

@test "usage error: unknown argument exits 2 without touching the tree" {
  mkdir -p "${ROOT}/oldjob"
  touch -t "${STALE_STAMP}" "${ROOT}/oldjob"

  run bash "${PRUNE_SH}" --wipe
  [ "${status}" -eq 2 ] || { echo "expected exit 2, got ${status}: ${output}"; return 1; }
  [ -d "${ROOT}/oldjob" ] || { echo "usage error still removed an entry"; return 1; }
}
