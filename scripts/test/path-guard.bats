#!/usr/bin/env bats
# path-guard.bats — pins the refusal contract of ga_guard_path (scripts/lib/path-guard.sh):
# a delete target passes only when it is absolute and not the filesystem root.

GUARD_LIB="${BATS_TEST_DIRNAME}/../lib/path-guard.sh"

@test "the guard passes only an absolute non-root path, and names every refusal except an empty value" {
  # name|value|refused|stderr message
  local rows=(
    'empty value||1|0'
    'filesystem root|/|1|1'
    'root spelled with repeated slashes|//|1|1'
    'cwd-relative dot|.|1|1'
    'absolute path|/tmp/ga-guard-x|0|0'
    'absolute path with a trailing slash|/tmp/ga-guard-x/|0|0'
  )
  local row="" name="" value="" refused="" noisy="" got_refused=0 got_noisy=0
  local err="${BATS_TEST_TMPDIR}/stderr"
  # shellcheck source-path=SCRIPTDIR source=../lib/path-guard.sh
  source "${GUARD_LIB}"
  for row in "${rows[@]}"; do
    IFS='|' read -r name value refused noisy <<<"${row}"
    got_refused=0
    got_noisy=0
    ga_guard_path "${value}" 2>"${err}" || got_refused=1
    if [[ -s "${err}" ]]; then
      got_noisy=1
    fi
    [[ "${got_refused}${got_noisy}" == "${refused}${noisy}" ]] || {
      echo "${name}: refused/stderr ${got_refused}/${got_noisy}, expected ${refused}/${noisy}: $(cat "${err}")"
      return 1
    }
  done
}

@test "the gated delete leaves an unset target a silent no-op under strict mode" {
  local script="${BATS_TEST_TMPDIR}/teardown-like.sh"
  cat >"${script}" <<'EOF'
set -Eeuo pipefail
trap 'echo "ERR trap fired" >&2' ERR
source "${1}"
if ga_guard_path "${WORK_DIR:-}"; then rm -rf -- "${WORK_DIR:?}"; fi
echo reached
EOF
  run bash "${script}" "${GUARD_LIB}"
  [[ "${status}" -eq 0 && "${output}" == "reached" ]] || {
    echo "exit ${status}: ${output}"
    return 1
  }
}
