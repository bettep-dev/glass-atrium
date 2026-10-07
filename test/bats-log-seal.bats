#!/usr/bin/env bats
# shellcheck disable=SC2154  # BATS_* come from bats
# shellcheck disable=SC2030,SC2031  # the hostile ambient roots are set in a subshell on purpose
# Live-log seal: the hermetic baseline (test/lib/bats-hermetic-env.bash) points the runtime log/data
# root at the run's scratch tree, so a hook a test runs with no seam of its own never appends to the
# live ~/.glass-atrium/logs, whose spawn-manifest lines a daemon cycle ingests into the DB.
# Each probe swaps HOME for a recorder dir: a broken baseline writes into the recorder and fails the
# test instead of reaching the live dir.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

setup() {
  load 'lib/bats-hermetic-env'
}

# Apply the baseline over ambient roots naming the live install, then print the roots it left.
print_baseline_log_roots() {
  (
    export GA_DATA_ROOT="${HOME}/.glass-atrium" \
      GA_CHUNK_SINK="${HOME}/.glass-atrium/logs/inject-scope-chunk.diag.log"
    ga_bats_hermetic_env >/dev/null 2>&1 || exit 1
    printf '%s\n' "${GA_DATA_ROOT}" "${GA_CHUNK_SINK}"
  )
}

@test "the hermetic baseline replaces an ambient live log root with one under the run's scratch tree" {
  local run_root root
  run_root="$(ga_bats_get_run_root)"
  run print_baseline_log_roots
  [[ "${status}" -eq 0 && "${#lines[@]}" -eq 2 ]] || {
    echo "ga_bats_hermetic_env failed or printed no roots: ${output}"
    return 1
  }
  for root in "${lines[@]}" "${GA_DATA_ROOT:-}" "${GA_CHUNK_SINK:-}"; do
    [[ "${root}" == "${BATS_RUN_TMPDIR:?}/"* || "${root}" == "${run_root}/"* ]] || {
      echo "a log root outside the run's scratch tree: '${root}' — baseline output: ${output}"
      return 1
    }
  done
}

@test "a hook run with no log seam of its own writes under the run's scratch tree and nothing under HOME" {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  local home="${BATS_TEST_TMPDIR:?}/home" probe="log-seal-${BATS_TEST_NUMBER}-$$" written
  mkdir -p "${home}/.glass-atrium/logs" "${home}/.glass-atrium/data"
  printf '%s' "{\"agent_type\":\"glass-atrium-dev-shell\",\"session_id\":\"${probe}\"}" \
    | HOME="${home}" "${GA}/hooks/inject-scope-rules.sh" >/dev/null 2>&1 || {
    echo "inject-scope-rules.sh exited non-zero under the recorder HOME"
    return 1
  }
  written="$(find "${home}" -type f)"
  [[ -z "${written}" ]] || {
    printf 'the hook wrote under HOME/.glass-atrium:\n%s\n' "${written}"
    return 1
  }
  grep -q " session_id=${probe} " "${GA_DATA_ROOT:?}/logs/inject-scope-rules.manifest.log" || {
    echo "no manifest line for ${probe} under ${GA_DATA_ROOT}/logs — the hook wrote nowhere observed"
    return 1
  }
}
