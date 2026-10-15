#!/usr/bin/env bats
# audit-test-smells.bats — pins the three-signal contract of scripts/audit-test-smells.sh.
#
# The suite asserts RELATIONSHIPS over fixture tables rather than enumerating cases: for signal (a)
# the relationship is "a body is reported exactly when its last non-exempt `run` is never inspected",
# and for signal (b) "a comparison is reported exactly when both operands are the same token", and for
# signal (c) "a count over a tree or source anchor is reported exactly when it is pinned to an exact
# census, never when it states absence, a membership floor, or a sandbox artifact's behaviour".
# A loop whose body asserts on EVERY row is the data-driven form the conditional-test-logic carve-out
# in scoped/shared-testing.md -> Detection signature per row explicitly permits.
#
# Every fixture is written into a per-test temp tree — no repository file is read as a fixture.

AUDIT_SH="${BATS_TEST_DIRNAME}/../audit-test-smells.sh"
# shellcheck source-path=SCRIPTDIR source=../lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../lib/path-guard.sh"

setup() {
  TS_TMP="$(mktemp -d -t audit-test-smells.XXXXXX)"
}

teardown() {
  if ga_guard_path "${TS_TMP:-}"; then rm -rf -- "${TS_TMP:?}"; fi
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
    'helper_underscore_prefixed|  run foo\n  _assert_x|0'
    'positive_compare_nonempty_literal|  run foo\n  [[ "$(f)" == "false" ]]|0'
    'positive_compare_empty_literal|  run foo\n  [[ "$(f)" == "" ]]|1'
    'negative_helper_on_substitution|  run foo\n  no x "$(f)"|1'
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

@test "signal (c): a tree-anchored count is reported exactly when it is pinned to an exact census" {
  # Unit-separator rows, not the `|` of the tables above: every fixture here carries a shell pipeline,
  # and splitting on `|` would truncate each body at its first `wc`.
  local -a table=(
    $'exact_git_census\x1f  [ "$(git ls-files | wc -l)" -eq 42 ]\x1f1'
    $'exact_source_census\x1f  [[ "$(grep -c row "${BATS_TEST_DIRNAME}/../lib/x.sh")" -eq 5 ]]\x1f1'
    $'exact_relative_source\x1f  [ "$(grep -c row ../lib/x.sh)" -eq 5 ]\x1f1'
    $'literal_on_the_left\x1f  [ 5 -eq "$(git grep -c row | wc -l)" ]\x1f1'
    $'helper_form\x1f  assert_equal "$(git ls-files | wc -l)" 42\x1f1'
    $'absence_claim\x1f  [ "$(git ls-files bad | wc -l)" -eq 0 ]\x1f0'
    $'membership_floor_ge\x1f  [[ "$(grep -c row "${REAL_SCRIPT}")" -ge 1 ]]\x1f0'
    $'membership_floor_gt\x1f  [[ "$(grep -c row "${REAL_SCRIPT}")" -gt 0 ]]\x1f0'
    $'sandbox_artifact\x1f  [ "$(wc -l <"${CALL_LOG}")" -eq 2 ]\x1f0'
    $'both_sides_derived\x1f  [ "$(git ls-files | wc -l)" -eq "$(git ls-files a | wc -l)" ]\x1f0'
    $'no_count_command\x1f  [ "$(git ls-files)" = x ]\x1f0'
    $'quoted_row_not_an_assertion\x1f  echo "[ \\"$(git ls-files | wc -l)\\" -eq 42 ]"\x1f0'
  )
  local row name body want out
  for row in "${table[@]}"; do
    IFS=$'\x1f' read -r name body want <<<"${row}"
    out="$(audit_body "${name}" "${body}")"
    [[ "${out}" == *"count_pin=${want} "* ]] || {
      echo "row=${row}"
      echo "got=${out}"
      return 1
    }
  done
}

@test "advisory ID-title and incident-header counts report exactly the files that carry an ID or date stamp" {
  local -a table=(
    $'a Bats title carrying a task ID is reported\x1fbats\x1f#!/usr/bin/env bats\\n%%test%% "T19: keeps the pin" {\\n  true\\n}\x1fid_title\x1f1'
    $'a Bats title carrying a qualified task ID is reported\x1fbats\x1f#!/usr/bin/env bats\\n%%test%% "G7(static): reads the file" {\\n  true\\n}\x1fid_title\x1f1'
    $'a Bats title carrying a hyphenated ticket ID is reported\x1fbats\x1f#!/usr/bin/env bats\\n%%test%% "AC-4: renders the label" {\\n  true\\n}\x1fid_title\x1f1'
    $'a title whose digits are not an ID is not reported\x1fbats\x1f#!/usr/bin/env bats\\n%%test%% "runs under bash 3.2" {\\n  true\\n}\\n%%test%% "reports exit 143 on timeout" {\\n  true\\n}\\n%%test%% "hashes with sha256" {\\n  true\\n}\x1fid_title\x1f0'
    $'a TS test title carrying an ID is reported\x1fts\x1fimport test from "node:test";\\ntest("P0-2 keeps the order", () => {});\\nit("renders the label", () => {});\x1fid_title\x1f1'
    $'a Bats file header carrying an ID is reported\x1fbats\x1f#!/usr/bin/env bats\\n# Regression for #14 — keeps the pin.\\n%%test%% "keeps the pin" {\\n  true\\n}\x1fincident_header\x1f1'
    $'a TS file header carrying a date stamp is reported\x1fts\x1f// Incident 2026-04-14: the label overflowed.\\nimport test from "node:test";\x1fincident_header\x1f1'
    $'a purpose-only header is not reported\x1fbats\x1f#!/usr/bin/env bats\\n# Pins the retry budget of the poller.\\n\\n# Fixed by T19.\\n%%test%% "keeps the budget" {\\n  true\\n}\x1fincident_header\x1f0'
    $'a shellcheck directive in the header is not an ID\x1fbats\x1f#!/usr/bin/env bats\\n# shellcheck disable=SC2034\\n# Pins the retry budget of the poller.\\n%%test%% "keeps the budget" {\\n  true\\n}\x1fincident_header\x1f0'
  )
  local row name ext content field want fixture out idx=0
  for row in "${table[@]}"; do
    IFS=$'\x1f' read -r name ext content field want <<<"${row}"
    idx=$((idx + 1))
    fixture="${TS_TMP}/row${idx}.${ext}"
    printf '%b\n' "${content}" | write_fixture "${fixture}"
    out="$(bash "${AUDIT_SH}" --path "${fixture}" --quiet)" || {
      echo "${name}: exit $? ${out}"
      return 1
    }
    [[ " ${out} " == *" ${field}=${want} "* ]] || {
      echo "${name}: want ${field}=${want}, got ${out}"
      return 1
    }
  done
}

@test "an incident-header finding names the header line that triggered it, at that line" {
  # The ratchet keys a header finding on this detail text, so a generic detail would collapse every
  # header into one key.
  local -a table=(
    $'the first trigger below a purpose line\x1fbats\x1f#!/usr/bin/env bats\\n# Pins the retry budget.\\n# Fixed by T19 on 2026-04-14.\\n# Also #14.\\n%%test%% "keeps the budget" {\\n  true\\n}\x1f3\x1f# Fixed by T19 on 2026-04-14.'
    $'a date in a TS line-comment header\x1fts\x1f// Incident 2026-04-14: the label overflowed.\\nimport test from "node:test";\x1f1\x1f// Incident 2026-04-14: the label overflowed.'
    $'an indented line inside a block comment\x1fts\x1f/**\\n * Renders the label.\\n   * Regression for AC-4.\\n */\\nimport test from "node:test";\x1f3\x1f* Regression for AC-4.'
  )
  local row name ext content want_line want_text fixture out hit idx=0
  for row in "${table[@]}"; do
    IFS=$'\x1f' read -r name ext content want_line want_text <<<"${row}"
    idx=$((idx + 1))
    fixture="${TS_TMP}/hdr${idx}.${ext}"
    printf '%b\n' "${content}" | write_fixture "${fixture}"
    out="$(bash "${AUDIT_SH}" --path "${fixture}")" || {
      echo "${name}: exit $? ${out}"
      return 1
    }
    hit="$(printf '%s\n' "${out}" | grep '^INCIDENT_HEADER')" || true
    [[ "${hit}" == *"hdr${idx}.${ext}:${want_line}: ${want_text}" ]] || {
      echo "${name}: want line ${want_line} '${want_text}', got ${out}"
      return 1
    }
    [[ "${out}" == *" incident_header=1"* ]] || {
      echo "${name}: the count must stay one per file, got ${out}"
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
  mkdir -p "${TS_TMP}/monitor/test"
  printf '%s\n' 'test("P0-2 keeps the order", () => {});' >"${TS_TMP}/monitor/test/sample.test.ts"
  run bash "${AUDIT_SH}" --root "${TS_TMP}" --strict
  [ "${status}" -eq 1 ] || {
    echo "exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"no_result_check=3 "* ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *"id_title=1 "* ]] || {
    echo "${output}"
    return 1
  }
  for dir in hooks/test scripts/test autoagent/test; do
    [[ "${output}" == *"${dir}/sample.bats"* ]] || {
      echo "scope dir ${dir} not walked: ${output}"
      return 1
    }
  done
  [[ "${output}" == *"monitor/test/sample.test.ts"* ]] || {
    echo "TS scope dir not walked: ${output}"
    return 1
  }
}

@test "the advisory counts never change the exit status, --strict included" {
  write_fixture "${TS_TMP}/ids.bats" <<'EOF'
#!/usr/bin/env bats
# Regression for T19.
%%test%% "T19: keeps the pin" {
  true
}
EOF
  run bash "${AUDIT_SH}" --path "${TS_TMP}/ids.bats" --strict
  [[ "${status}" -eq 0 ]] || {
    echo "exit ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"id_title=1 incident_header=1"* ]] || {
    echo "${output}"
    return 1
  }
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
