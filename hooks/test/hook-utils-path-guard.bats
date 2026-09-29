#!/usr/bin/env bats
# hooks/hook-utils.sh — delivery of the shared delete-target guard (ga_guard_path) every hook delete
# site gates on. The guard's own semantics are pinned in scripts/test/path-guard.bats.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_LIB="${GA}/hooks/hook-utils.sh"

# Sources the library at $1 in a clean shell → prints whether ga_guard_path is defined.
get_guard_state() {
  bash -c 'source "$1" || exit 3
    if declare -F ga_guard_path >/dev/null; then echo defined; else echo undefined; fi' _ "${1}"
}

@test "sourcing hook-utils.sh defines the delete guard exactly when its install tree is reachable" {
  local row="" name="" lib="" want=""
  ln -s "${REAL_LIB}" "${BATS_TEST_TMPDIR}/linked-hook-utils.sh"
  cp "${REAL_LIB}" "${BATS_TEST_TMPDIR}/copied-hook-utils.sh"
  for row in \
    "direct|${REAL_LIB}|defined" \
    "symlink into a tree-less dir|${BATS_TEST_TMPDIR}/linked-hook-utils.sh|defined" \
    "copy with no tree beside it|${BATS_TEST_TMPDIR}/copied-hook-utils.sh|undefined"; do
    IFS='|' read -r name lib want <<<"${row}"
    run get_guard_state "${lib}"
    [[ "${status}" -eq 0 && "${output}" == "${want}" ]] \
      || {
        echo "${name}: status=${status} output=${output} want=${want}"
        return 1
      }
  done
}
