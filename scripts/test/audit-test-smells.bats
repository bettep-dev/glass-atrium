#!/usr/bin/env bats
# audit-test-smells.bats — pins the two-signal contract of scripts/audit-test-smells.sh.
#
# The suite asserts RELATIONSHIPS over fixture tables rather than enumerating cases: for signal (a)
# the relationship is "a body is reported exactly when its last non-exempt `run` is never inspected",
# and for signal (b) "a comparison is reported exactly when both operands are the same token".
# A loop whose body asserts on EVERY row is the data-driven form the conditional-test-logic carve-out
# in scoped/shared-testing.md -> Meaningless-Test Prohibitions explicitly permits.
#
# Every fixture is written into a per-test temp tree — no repository file is read as a fixture.

AUDIT_SH="${BATS_TEST_DIRNAME}/../audit-test-smells.sh"

setup() {
  TS_TMP="$(mktemp -d -t audit-test-smells.XXXXXX)"
}

teardown() {
  [[ -n "${TS_TMP:-}" && -d "${TS_TMP}" ]] && rm -rf -- "${TS_TMP}" || true
}

# Writes stdin to a fixture path, creating parent directories. Bats rewrites every column-0 `@test`
# line while loading this file — heredoc content included — so a fixture spells it `%%test%%` and
# this helper expands the marker on the way out.
write_fixture() {
  local path="${1}"
  mkdir -p "$(dirname "${path}")"
  sed 's/^%%test%%/@test/' >"${path}"
}

# Wraps a `\n`-escaped snippet in a single @test block and audits that file quietly.
audit_body() {
  local name="${1}" body="${2}" fixture
  fixture="${TS_TMP}/${name}.bats"
  {
    printf '%s\n' '#!/usr/bin/env bats'
    printf '@test "%s" {\n' "${name}"
    printf '%b\n' "${body}"
    printf '%s\n' '}'
  } >"${fixture}"
  bash "${AUDIT_SH}" --path "${fixture}" --quiet
}

@test "signal (a): a body is reported exactly when its last non-exempt run is never inspected" {
  local -a table=(
    'uninspected|  run foo|1'
    'inspect_status|  run foo\n  [ "$status" -eq 0 ]|0'
    'inspect_braced_status|  run foo\n  [ "${status}" -eq 0 ]|0'
    'inspect_output|  run foo\n  [[ "$output" == x ]]|0'
    'inspect_braced_output|  run foo\n  echo "${output}"|0'
    'inspect_lines|  run foo\n  [[ "${lines[0]}" == x ]]|0'
    'inspect_stderr|  run foo\n  [ -n "$stderr" ]|0'
    'helper_call|  run foo\n  assert_output x|0'
    'helper_custom|  run foo\n  assert_no_drop|0'
    'exempt_bang|  run ! foo|0'
    'exempt_status_arg|  run -0 foo|0'
    'exempt_status_arg_wide|  run -19 foo|0'
    'exempt_separate_stderr|  run --separate-stderr foo|0'
    'quoted_run_token|  echo "run foo"|0'
    'commented_run_token|  # run foo|0'
    'inspection_before_only|  [ -n "$output" ]\n  run foo|1'
    'last_run_inspected|  run foo\n  run bar\n  [ "$status" -eq 0 ]|0'
    'no_run_at_all|  true|0'
  )
  local row name body want out
  for row in "${table[@]}"; do
    IFS='|' read -r name body want <<<"${row}"
    out="$(audit_body "${name}" "${body}")"
    [[ "${out}" == *"no_result_check=${want} "* ]] || {
      echo "row=${row}"
      echo "got=${out}"
      return 1
    }
  done
}

@test "signal (b): a comparison is reported exactly when both operands are the same token" {
  local -a table=(
    'literal_single|  [ "x" = "x" ]|1'
    'literal_double|  [[ "x" == "x" ]]|1'
    'numeric|  [ 1 -eq 1 ]|1'
    'same_variable|  [ "$foo" = "$foo" ]|1'
    'distinct_variables|  [ "$foo" = "$bar" ]|0'
    'distinct_literals|  [ "x" = "y" ]|0'
    'distinct_numeric|  [ 1 -eq 2 ]|0'
  )
  local row name body want out
  for row in "${table[@]}"; do
    IFS='|' read -r name body want <<<"${row}"
    out="$(audit_body "${name}" "${body}")"
    [[ "${out}" == *"tautology=${want} "* ]] || {
      echo "row=${row}"
      echo "got=${out}"
      return 1
    }
  done
}

@test "heredoc awareness: heredoc lines feed neither signal and a column-0 brace does not end the body" {
  write_fixture "${TS_TMP}/heredoc.bats" <<'OUTER'
#!/usr/bin/env bats

%%test%% "fixture bearing test" {
  cat >"${TMP}/f.sh" <<'INNER'
run foo
[ "x" = "x" ]
}
INNER
  run real_cmd
  [ "${status}" -eq 0 ]
}

%%test%% "trailing test is still parsed" {
  run other
}
OUTER
  run bash "${AUDIT_SH}" --path "${TS_TMP}/heredoc.bats"
  [ "${status}" -eq 0 ] || {
    echo "exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"no_result_check=1 "* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"tautology=0 "* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"tests_scanned=2"* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"trailing test is still parsed"* ]] || {
    echo "${output}"
    return 1
  }
}

@test "advisory is the default and --strict is the only blocking mode" {
  write_fixture "${TS_TMP}/dirty.bats" <<'EOF'
#!/usr/bin/env bats
%%test%% "dirty" {
  run foo
}
EOF
  write_fixture "${TS_TMP}/clean.bats" <<'EOF'
#!/usr/bin/env bats
%%test%% "clean" {
  run foo
  [ "${status}" -eq 0 ]
}
EOF
  run bash "${AUDIT_SH}" --path "${TS_TMP}/dirty.bats"
  [ "${status}" -eq 0 ] || {
    echo "default run with findings must stay advisory: ${status}"
    return 1
  }
  run bash "${AUDIT_SH}" --path "${TS_TMP}/dirty.bats" --advisory
  [ "${status}" -eq 0 ] || return 1
  run bash "${AUDIT_SH}" --path "${TS_TMP}/dirty.bats" --strict
  [ "${status}" -eq 1 ] || {
    echo "strict with findings must block: ${status}"
    return 1
  }
  run bash "${AUDIT_SH}" --path "${TS_TMP}/clean.bats" --strict
  [ "${status}" -eq 0 ] || {
    echo "strict without findings must pass: ${status} ${output}"
    return 1
  }
}

@test "the in-script scope list is the SoT and resolves under --root" {
  local dir
  for dir in hooks/test scripts/test autoagent/test; do
    mkdir -p "${TS_TMP}/${dir}"
    write_fixture "${TS_TMP}/${dir}/sample.bats" <<'EOF'
#!/usr/bin/env bats
%%test%% "sample" {
  run foo
}
EOF
  done
  run bash "${AUDIT_SH}" --root "${TS_TMP}" --strict
  [ "${status}" -eq 1 ] || {
    echo "exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"no_result_check=3 "* ]] || {
    echo "${output}"
    return 1
  }
  for dir in hooks/test scripts/test autoagent/test; do
    [[ "${output}" == *"${dir}/sample.bats"* ]] || {
      echo "scope dir ${dir} not walked: ${output}"
      return 1
    }
  done
}

@test "the ported exit convention: 2 on usage error, 3 on IO error, 0 on --help" {
  run bash "${AUDIT_SH}" --advisory --strict
  [ "${status}" -eq 2 ] || return 1
  run bash "${AUDIT_SH}" --no-such-flag
  [ "${status}" -eq 2 ] || return 1
  run bash "${AUDIT_SH}" --path "${TS_TMP}/missing.bats"
  [ "${status}" -eq 3 ] || return 1
  run bash "${AUDIT_SH}" --root "${TS_TMP}/no-such-root"
  [ "${status}" -eq 3 ] || return 1
  run bash "${AUDIT_SH}" --help
  [ "${status}" -eq 0 ] || return 1
}
