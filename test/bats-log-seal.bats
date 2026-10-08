#!/usr/bin/env bats
# shellcheck disable=SC2154  # BATS_* come from bats
# shellcheck disable=SC2030,SC2031  # the hostile ambient roots are set in a subshell on purpose
# Live-log seal: the hermetic baseline (test/lib/bats-hermetic-env.bash) points the runtime log/data
# root at the run's scratch tree, so a hook a test runs with no seam of its own never appends to the
# live ~/.glass-atrium/logs, whose spawn-manifest lines a daemon cycle ingests into the DB.
# Each probe swaps HOME for a recorder dir: a broken baseline writes into the recorder and fails the
# test instead of reaching the live dir.
# That root is shared by every file of a `bats --jobs` run → a suite that sandboxes HOME names its own
# root on the same command, so its hook state (outcome spool, breaker, *-fired.log) stays its own.

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

# file:line of each sandbox HOME assignment whose command names no GA_DATA_ROOT, in a file that never
# resets the root itself (a line-leading unset or export) — such a command falls onto the run-wide root.
find_unrooted_sandbox_homes() {
  awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*(unset[[:space:]]+GA_DATA_ROOT|export[[:space:]]+GA_DATA_ROOT=)/ { owned = 1 }
    {
      if (!open) { cmd = ""; home = 0 }
      cmd = cmd $0 "\n"
      if (!home && $0 ~ /(^|[^A-Za-z0-9_$])HOME=["$\/]/) home = FNR
      open = ($0 ~ /\\$/)
      if (!open && home && cmd !~ /GA_DATA_ROOT/) unrooted[++n] = FILENAME ":" home
    }
    END { if (!owned) for (i = 1; i <= n; i++) print unrooted[i] }
  ' "$1"
}

@test "the sandbox-HOME detector flags a command only when neither it nor its file names a data root" {
  # shellcheck disable=SC2016  # fixture rows carry literal ${…} on purpose
  local rows=(
    'HOME paired with a root on its own line|HOME="${H}" GA_DATA_ROOT="${H}/.glass-atrium" bash "${S}"|0'
    'HOME with no root|HOME="${H}" bash "${S}"|1'
    'quoted env argument with no root|run env "HOME=${H}" "${S}"|1'
    'root unset on an earlier continuation line|run env -u GA_DATA_ROOT \\\n  HOME="${H}" bash "${S}"|0'
    'root named only by the next command|HOME="${H}" bash "${S}"\nGA_DATA_ROOT="${R}" bash "${S}"|1'
    'file resets the root in setup|setup() {\n  unset GA_DATA_ROOT\n}\n@test "x" {\n  HOME="${H}" bash "${S}"\n}|0'
    'HOME only in a comment, a printf format or a longer name|# HOME="${H}" bash\nprintf "under HOME=%s"\nSANDBOX_HOME="${T}/home"|0'
  )
  local row name body want fixture="${BATS_TEST_TMPDIR:?}/fixture.bats" got
  for row in "${rows[@]}"; do
    IFS='|' read -r name body want <<<"${row}"
    printf '%b\n' "${body}" >"${fixture}"
    got="$(find_unrooted_sandbox_homes "${fixture}" | grep -c . || true)"
    [[ "${got}" == "${want}" ]] || {
      echo "${name}: flagged ${got}, want ${want}"
      return 1
    }
  done
}

@test "every suite that sandboxes HOME gives the hooks it drives a data root of their own" {
  # this file's recorder probe proves the baseline on purpose; bats-db-seal names HOME only in fixtures
  local exempt=" test/bats-log-seal.bats test/bats-db-seal.bats " list="${BATS_TEST_TMPDIR:?}/suites" file rel hits
  local unrooted=""
  find "${GA}/test" "${GA}/hooks/test" "${GA}/scripts/test" "${GA}/autoagent/test" \
    -type f \( -name '*.bats' -o -name '*.bash' \) -print0 >"${list}"
  while IFS= read -r -d '' file; do
    rel="${file#"${GA}/"}"
    [[ "${exempt}" != *" ${rel} "* ]] || continue
    hits="$(find_unrooted_sandbox_homes "${file}")"
    [[ -z "${hits}" ]] || unrooted+="${hits#"${GA}/"}"$'\n'
  done <"${list}"
  [[ -z "${unrooted}" ]] || {
    printf 'sandbox HOME on the shared run-wide data root:\n%s' "${unrooted}"
    return 1
  }
}
