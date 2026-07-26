#!/usr/bin/env bats
# audit-absorption.bats — pins the presence-only contract of scripts/audit-absorption.sh.
#
# The auditor must never adjudicate a category (the disambiguating evidence for a suppression is
# block-scoped, so a classifier confident enough to decide is wrong on exactly the sites that matter).
# What it MAY enforce is annotation grammar: an empty reason, an out-of-vocabulary label, or a
# `handled` label naming no location are rejected, and an unannotated site is reported.
#
# Every fixture is written into a per-test temp tree — no repository file is read as a fixture.

AUDIT_SH="${BATS_TEST_DIRNAME}/../audit-absorption.sh"

setup() {
  [[ -f "${AUDIT_SH}" ]] || skip "audit-absorption.sh not found"
  AA_TMP="$(mktemp -d -t audit-absorption.XXXXXX)"
}

teardown() {
  [[ -n "${AA_TMP:-}" && -d "${AA_TMP}" ]] && rm -rf -- "${AA_TMP}" || true
}

# Writes stdin to a fixture path, creating parent directories.
write_fixture() {
  local path="${1}"
  mkdir -p "$(dirname "${path}")"
  cat >"${path}"
}

assert_summary() {
  local expected="${1}"
  [[ "${output}" == *"${expected}"* ]] || {
    echo "expected summary '${expected}' in:"
    echo "${output}"
    return 1
  }
}

@test "F1: empty reason is rejected" {
  write_fixture "${AA_TMP}/f1.sh" <<'EOF'
#!/usr/bin/env bash
foo || true  # GA-ABSORB[benign]:
EOF
  run bash "${AUDIT_SH}" --path "${AA_TMP}/f1.sh"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  assert_summary "annotated=0 converted=0 unannotated=0 quality_reject=1"
  [[ "${output}" == *"QUALITY_REJECT"*"empty-reason"* ]] || return 1
}

@test "F2: out-of-vocabulary label is rejected (closed two-label vocabulary)" {
  write_fixture "${AA_TMP}/f2.sh" <<'EOF'
#!/usr/bin/env bash
foo || true  # GA-ABSORB[cat3]: real reason
EOF
  run bash "${AUDIT_SH}" --path "${AA_TMP}/f2.sh"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  assert_summary "annotated=0 converted=0 unannotated=0 quality_reject=1"
  [[ "${output}" == *"bad-label"* ]] || return 1
}

@test "F3: handled label naming no location is rejected (bare line numbers included)" {
  write_fixture "${AA_TMP}/f3.sh" <<'EOF'
#!/usr/bin/env bash
alpha || true  # GA-ABSORB[handled]: reason
beta || true  # GA-ABSORB[handled@]: reason
gamma || true  # GA-ABSORB[handled@127]: reason
delta || true  # GA-ABSORB[handled@:127]: reason
EOF
  run bash "${AUDIT_SH}" --path "${AA_TMP}/f3.sh"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  assert_summary "annotated=0 converted=0 unannotated=0 quality_reject=4"
  [[ "${output}" == *"handled-no-location"* ]] || return 1
}

@test "F4: unannotated site is reported as file:line (one physical line is one site)" {
  write_fixture "${AA_TMP}/f4.sh" <<'EOF'
#!/usr/bin/env bash
t=/tmp/x
rm -f "$t" 2>/dev/null || true
EOF
  run bash "${AUDIT_SH}" --path "${AA_TMP}/f4.sh"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  # Two alternatives match the same line; the site count stays 1.
  assert_summary "annotated=0 converted=0 unannotated=1 quality_reject=0"
  [[ "${output}" == *"UNANNOTATED"*"${AA_TMP}/f4.sh:3"* ]] || { echo "${output}"; return 1; }
}

@test "F5: annotated and converted counts are distinct fields" {
  write_fixture "${AA_TMP}/f5.sh" <<'EOF'
#!/usr/bin/env bash
alpha || true  # GA-ABSORB[benign]: no-match is data, not failure
beta 2>/dev/null  # GA-ABSORB[handled@caller_branch]: status captured by the caller
report || {
  st=$?
  echo "warn: report failed (${st})" >&2
}  # GA-CONVERTED: reporting failure surfaced to stderr + drop sink
EOF
  run bash "${AUDIT_SH}" --path "${AA_TMP}/f5.sh"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  assert_summary "annotated=2 converted=1 unannotated=0 quality_reject=0"
}

@test "F6: a comment line carrying the idiom is not a site" {
  write_fixture "${AA_TMP}/f6.sh" <<'EOF'
#!/usr/bin/env bash
  # historical note: this used to read `foo || true` before the conversion
EOF
  run bash "${AUDIT_SH}" --path "${AA_TMP}/f6.sh"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  assert_summary "annotated=0 converted=0 unannotated=0 quality_reject=0"
}

@test "F7: surfaced stderr channels (2>&1, 2>>) are not sites" {
  write_fixture "${AA_TMP}/f7.sh" <<'EOF'
#!/usr/bin/env bash
run_it >>"$LOG" 2>&1
run_it 2>>"$LOG"
EOF
  run bash "${AUDIT_SH}" --path "${AA_TMP}/f7.sh"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  assert_summary "annotated=0 converted=0 unannotated=0 quality_reject=0"
}

@test "F8: token accepted one line above, never two" {
  write_fixture "${AA_TMP}/f8.sh" <<'EOF'
#!/usr/bin/env bash
# GA-ABSORB[benign]: own-line placement, forced out of the trailing position
alpha || true
# GA-ABSORB[benign]: too far above to bind to any site
: filler
beta || true
EOF
  run bash "${AUDIT_SH}" --path "${AA_TMP}/f8.sh"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  assert_summary "annotated=1 converted=0 unannotated=1 quality_reject=0"
  [[ "${output}" == *"UNANNOTATED"*"${AA_TMP}/f8.sh:6"* ]] || { echo "${output}"; return 1; }
}

@test "F9: continuation walk accepts the token on the statement's first line" {
  write_fixture "${AA_TMP}/f9.sh" <<'EOF'
#!/usr/bin/env bash
while IFS= read -r p; do
  keep+=("$p")
done < <(  # GA-ABSORB[benign]: pipeline failure yields an empty set — a no-op, not a lost deliverable
  printf '%s\n' "${all[@]}" \
    | sort -r 2>/dev/null \
    | awk 'NR>1'
)
EOF
  run bash "${AUDIT_SH}" --path "${AA_TMP}/f9.sh"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  assert_summary "annotated=1 converted=0 unannotated=0 quality_reject=0"
}

@test "F10: || exit 0 is required in a sourced library, not in an executed script" {
  write_fixture "${AA_TMP}/lib/thing.sh" <<'EOF'
#!/usr/bin/env bash
probe || exit 0
EOF
  write_fixture "${AA_TMP}/plain.sh" <<'EOF'
#!/usr/bin/env bash
probe || exit 0
EOF
  run bash "${AUDIT_SH}" --path "${AA_TMP}/lib/thing.sh"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  assert_summary "annotated=0 converted=0 unannotated=1 quality_reject=0"

  run bash "${AUDIT_SH}" --path "${AA_TMP}/plain.sh"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  assert_summary "annotated=0 converted=0 unannotated=0 quality_reject=0"

  # The annotated form is accepted on both surfaces — the auditor never demands more than presence.
  write_fixture "${AA_TMP}/lib/annotated.sh" <<'EOF'
#!/usr/bin/env bash
probe || exit 0  # GA-ABSORB[benign]: absent input is a no-op-and-succeed contract
EOF
  run bash "${AUDIT_SH}" --path "${AA_TMP}/lib/annotated.sh"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  assert_summary "annotated=1 converted=0 unannotated=0 quality_reject=0"
}

@test "F11: missing --path target and scope drift both exit 3" {
  run bash "${AUDIT_SH}" --path "${AA_TMP}/nonexistent.sh"
  [ "${status}" -eq 3 ] || { echo "exit ${status}: ${output}"; return 1; }

  # An empty root stands in for a scope entry that no longer exists in the tree.
  run bash "${AUDIT_SH}" --root "${AA_TMP}"
  [ "${status}" -eq 3 ] || { echo "exit ${status}: ${output}"; return 1; }
  [[ "${output}" == *"scope file missing"* ]] || { echo "${output}"; return 1; }
}

@test "F12: unknown argument is a usage error (exit 2)" {
  run bash "${AUDIT_SH}" --bogus
  [ "${status}" -eq 2 ] || { echo "exit ${status}: ${output}"; return 1; }
}

@test "F13: valid benign and handled@<where> annotations pass" {
  write_fixture "${AA_TMP}/f13.sh" <<'EOF'
#!/usr/bin/env bash
alpha || true  # GA-ABSORB[handled@pg_write_run]: status routed to the caller's warn branch
beta 2>/dev/null  # GA-ABSORB[benign]: no-match exit is data, not failure
EOF
  run bash "${AUDIT_SH}" --path "${AA_TMP}/f13.sh"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  assert_summary "annotated=2 converted=0 unannotated=0 quality_reject=0"
}

@test "advisory mode: findings never change the exit status, --quiet prints the summary only" {
  write_fixture "${AA_TMP}/adv.sh" <<'EOF'
#!/usr/bin/env bash
rm -f /tmp/x 2>/dev/null || true
EOF
  run bash "${AUDIT_SH}" --quiet --path "${AA_TMP}/adv.sh"
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  [[ "${output}" != *"UNANNOTATED"* ]] || { echo "${output}"; return 1; }
  assert_summary "annotated=0 converted=0 unannotated=1 quality_reject=0"
}

@test "default scope run resolves the in-script file list and exits 0" {
  run bash "${AUDIT_SH}" --quiet
  [ "${status}" -eq 0 ] || { echo "exit ${status}: ${output}"; return 1; }
  [[ "${output}" =~ annotated=[0-9]+\ converted=[0-9]+\ unannotated=[0-9]+\ quality_reject=[0-9]+ ]] || {
    echo "${output}"
    return 1
  }
}
