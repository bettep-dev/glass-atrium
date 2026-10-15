#!/usr/bin/env bats
# naming-ratchet.bats — pins scripts/naming-ratchet.sh: a run fails exactly when the auditor's
# id_title and incident_header findings exceed the committed baseline as a multiset, or when the
# baseline holds more than it did at the merge base. Every fixture is a throwaway root scanned
# through --root, as audit-test-smells.bats does.

# shellcheck disable=SC2154  # bats sets BATS_TEST_DIRNAME before loading this file
RATCHET_SH="${BATS_TEST_DIRNAME}/../naming-ratchet.sh"
BASELINE_REL='scripts/naming-ratchet-baseline.txt'
# shellcheck source-path=SCRIPTDIR source=../lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../lib/path-guard.sh"

setup() {
  WORK="$(mktemp -d)"
  WORK="$(cd -- "${WORK}" && pwd -P)"
  # Hermetic git: no host config, so a global gpgsign or hooksPath never reaches a fixture commit.
  export HOME="${WORK}/home" GIT_CONFIG_NOSYSTEM=1
  export GIT_AUTHOR_NAME='ga-fixture' GIT_AUTHOR_EMAIL='ga@fixture.invalid'
  export GIT_COMMITTER_NAME='ga-fixture' GIT_COMMITTER_EMAIL='ga@fixture.invalid'
  mkdir -p "${HOME}"
}

teardown() {
  if ga_guard_path "${WORK:-}"; then rm -rf -- "${WORK:?}"; fi
}

# Creates a root carrying the named auditor scope dirs (all four by default), and prints its path.
# Each dir holds a clean suite: the auditor exits 1 on an empty scope dir under bash 3.2.
make_root() {
  local root="${WORK}/${1}" dir
  shift
  (($# > 0)) || set -- hooks/test scripts/test autoagent/test monitor/test
  for dir in "$@"; do
    mkdir -p "${root}/${dir}"
    write_titles "${root}/${dir}/clean.bats" 'keeps the budget'
  done
  printf '%s\n' "${root}"
}

# Writes a Bats file under the root carrying one trivial @test per remaining title argument.
write_titles() {
  local file="${1}" title
  shift
  {
    printf '%s\n' '#!/usr/bin/env bats'
    for title in "$@"; do
      printf '@test "%s" {\n  true\n}\n' "${title}"
    done
  } >"${file}"
}

# Writes the baseline from `\n`-escaped text; an empty argument writes an empty baseline.
write_baseline() {
  local root="${1}" text="${2}"
  if [[ -z "${text}" ]]; then
    : >"${root}/${BASELINE_REL}"
    return 0
  fi
  printf '%b\n' "${text}" >"${root}/${BASELINE_REL}"
}

@test "a run fails exactly when a finding's key occurs more often than the baseline holds it" {
  local -a table=(
    $'a listed title passes\x1fT19: keeps the pin\x1f\x1fID_TITLE @test T19: keeps the pin\x1f0'
    $'an unlisted title fails\x1fT20: keeps the order\x1f\x1fID_TITLE @test T19: keeps the pin\x1f1'
    $'a listed title occurring twice fails\x1fT19: keeps the pin\x1fT19: keeps the pin\x1fID_TITLE @test T19: keeps the pin\x1f1'
    $'a title listed twice may occur twice\x1fT19: keeps the pin\x1fT19: keeps the pin\x1fID_TITLE @test T19: keeps the pin\\nID_TITLE @test T19: keeps the pin\x1f0'
    $'a clean title against an empty baseline passes\x1fkeeps the pin\x1f\x1f\x1f0'
  )
  local row name first second baseline want root idx=0
  for row in "${table[@]}"; do
    IFS=$'\x1f' read -r name first second baseline want <<<"${row}"
    idx=$((idx + 1))
    root="$(make_root "row${idx}")"
    write_titles "${root}/hooks/test/a.bats" "${first}"
    if [[ -n "${second}" ]]; then
      write_titles "${root}/scripts/test/b.bats" "${second}"
    fi
    write_baseline "${root}" "${baseline}"
    run bash "${RATCHET_SH}" --root "${root}"
    [[ "${status}" -eq "${want}" ]] || {
      echo "${name}: want exit ${want}, got ${status}: ${output}"
      return 1
    }
    [[ "${want}" -eq 0 || "${output}" == *'NEW '*"T"* ]] || {
      echo "${name}: a failing run must name the new key: ${output}"
      return 1
    }
  done
}

@test "the key ignores location: a finding moved to another line and file still matches its entry" {
  local root
  root="$(make_root moved)"
  write_titles "${root}/autoagent/test/renamed.bats" 'keeps the budget' 'T19: keeps the pin'
  printf '%s\n' '#!/usr/bin/env bats' '' '# Fixed by T19.' >"${root}/scripts/test/moved.bats"
  write_baseline "${root}" 'ID_TITLE @test T19: keeps the pin\nINCIDENT_HEADER # Fixed by T19.'
  run bash "${RATCHET_SH}" --root "${root}"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
}

@test "an edited incident-header line is a new key the run blocks" {
  local root
  root="$(make_root header)"
  printf '%s\n' '#!/usr/bin/env bats' '# Fixed by T19 and T20.' >"${root}/hooks/test/h.bats"
  write_baseline "${root}" 'INCIDENT_HEADER # Fixed by T19.'
  run bash "${RATCHET_SH}" --root "${root}"
  [[ "${status}" -eq 1 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *'NEW '*'INCIDENT_HEADER # Fixed by T19 and T20.'* ]] || {
    echo "${output}"
    return 1
  }
}

@test "a baseline entry whose finding is gone is reported stale and never fails the run" {
  local root
  root="$(make_root stale)"
  write_titles "${root}/hooks/test/a.bats" 'T19: keeps the pin'
  write_baseline "${root}" 'ID_TITLE @test T19: keeps the pin\nID_TITLE @test T20: keeps the order'
  run bash "${RATCHET_SH}" --root "${root}"
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  [[ "${output}" == *'STALE '*'ID_TITLE @test T20: keeps the order'* && "${output}" == *'stale=1 '* ]] || {
    echo "${output}"
    return 1
  }
}

@test "write mode creates a missing baseline that makes the same tree pass" {
  local root written sorted
  root="$(make_root create)"
  write_titles "${root}/hooks/test/a.bats" 'T20: keeps the order' 'T19: keeps the pin'
  printf '%s\n' '#!/usr/bin/env bats' '# Regression for #14.' >"${root}/scripts/test/h.bats"
  run bash "${RATCHET_SH}" --root "${root}" --write
  [[ "${status}" -eq 0 ]] || {
    echo "${output}"
    return 1
  }
  written="$(cat "${root}/${BASELINE_REL}")"
  sorted="$(LC_ALL=C sort "${root}/${BASELINE_REL}")"
  [[ "${written}" == "${sorted}" ]] || {
    echo "the written baseline must be sorted: ${written}"
    return 1
  }
  run bash "${RATCHET_SH}" --root "${root}"
  [[ "${status}" -eq 0 && "${output}" == *'new=0 stale=0 '*'baseline=3 findings=3'* ]] || {
    echo "${output}"
    return 1
  }
}

@test "write mode on an existing baseline drops stale entries and never adds a new finding" {
  local root written
  root="$(make_root shrink)"
  write_titles "${root}/hooks/test/a.bats" 'T19: keeps the pin' 'T21: keeps the label'
  write_baseline "${root}" 'ID_TITLE @test T19: keeps the pin\nID_TITLE @test T20: keeps the order'
  run bash "${RATCHET_SH}" --root "${root}" --write
  [[ "${status}" -eq 1 ]] || {
    echo "a new finding must still fail a write run: ${status} ${output}"
    return 1
  }
  written="$(cat "${root}/${BASELINE_REL}")"
  [[ "${written}" == 'ID_TITLE @test T19: keeps the pin' ]] || {
    echo "baseline after write: ${written}"
    return 1
  }
}

@test "the growth check fails exactly when the baseline holds an entry the merge-base baseline lacks" {
  local t19='ID_TITLE @test T19: keeps the pin' t20='ID_TITLE @test T20: keeps the order'
  local -a table=(
    "an added entry fails"$'\x1f'"${t19}"$'\x1f'"${t19}\\n${t20}"$'\x1f1'
    "a raised count of an existing entry fails"$'\x1f'"${t19}"$'\x1f'"${t19}\\n${t19}"$'\x1f1'
    "a shrunk baseline passes"$'\x1f'"${t19}\\n${t20}"$'\x1f'"${t19}"$'\x1f0'
    "the creating change, with no baseline at the merge base, passes"$'\x1f-\x1f'"${t19}\\n${t20}"$'\x1f0'
  )
  local row name base_text change_text want root idx=0
  for row in "${table[@]}"; do
    IFS=$'\x1f' read -r name base_text change_text want <<<"${row}"
    idx=$((idx + 1))
    root="$(make_root "growth${idx}")"
    git -C "${root}" init -q
    if [[ "${base_text}" != '-' ]]; then
      write_baseline "${root}" "${base_text}"
      git -C "${root}" add "${BASELINE_REL}"
    fi
    git -C "${root}" commit -q --allow-empty -m base
    git -C "${root}" tag base
    write_baseline "${root}" "${change_text}"
    # No finding in the tree: every entry is merely stale, so the growth check alone decides the status.
    write_titles "${root}/hooks/test/a.bats" 'keeps the pin'
    run bash "${RATCHET_SH}" --root "${root}" --base base
    [[ "${status}" -eq "${want}" ]] || {
      echo "${name}: want exit ${want}, got ${status}: ${output}"
      return 1
    }
    [[ "${want}" -eq 0 || "${output}" == *'GROWN '* ]] || {
      echo "${name}: a growth failure must name the added entry: ${output}"
      return 1
    }
  done
}

@test "a merge-base baseline that exists but cannot be read fails loudly with exit 3, never a skipped check" {
  local root real_git stub_dir="${WORK}/gitstub"
  real_git="$(command -v git)"
  root="$(make_root unreadable)"
  git -C "${root}" init -q
  write_baseline "${root}" ''
  git -C "${root}" add "${BASELINE_REL}"
  git -C "${root}" commit -q -m base
  git -C "${root}" tag base
  # A git whose `show` fails while `cat-file -e` still reports the blob present.
  mkdir -p "${stub_dir}"
  cat >"${stub_dir}/git" <<'EOF'
#!/usr/bin/env bash
for arg in "$@"; do [[ "${arg}" == show ]] && exit 128; done
exec "${REAL_GIT}" "$@"
EOF
  chmod +x "${stub_dir}/git"
  run env PATH="${stub_dir}:${PATH}" REAL_GIT="${real_git}" bash "${RATCHET_SH}" --root "${root}" --base base
  [[ "${status}" -eq 3 && "${output}" == *'cannot read the baseline at merge base'* ]] || {
    echo "unreadable base baseline: ${status} ${output}"
    return 1
  }
}

@test "a failed or unreadable auditor run fails loudly with exit 3" {
  local partial stub_dir="${WORK}/stub" root
  # The auditor's own scope error: its monitor/test scope dir is absent.
  partial="$(make_root partial hooks/test scripts/test autoagent/test)"
  write_baseline "${partial}" ''
  run bash "${RATCHET_SH}" --root "${partial}"
  [[ "${status}" -eq 3 && "${output}" == *'scope directory missing'*'exited 3'* ]] || {
    echo "auditor failure: ${status} ${output}"
    return 1
  }
  # An auditor whose finding lines no longer add up to its own summary counts.
  root="$(make_root loud)"
  write_baseline "${root}" 'ID_TITLE @test T19: keeps the pin'
  mkdir -p "${stub_dir}/lib"
  cp "${RATCHET_SH}" "${stub_dir}/naming-ratchet.sh"
  cp "${BATS_TEST_DIRNAME}/../lib/path-guard.sh" "${stub_dir}/lib/path-guard.sh"
  cat >"${stub_dir}/audit-test-smells.sh" <<'EOF'
printf '%s\n' 'ID_TITLE         hooks/test/a.bats:3: @test T19: keeps the pin'
printf '%s\n' 'no_result_check=0 tautology=0 count_pin=0 tests_scanned=1 id_title=2 incident_header=0'
EOF
  run bash "${stub_dir}/naming-ratchet.sh" --root "${root}"
  [[ "${status}" -eq 3 && "${output}" == *'does not match its summary'* ]] || {
    echo "count mismatch: ${status} ${output}"
    return 1
  }
}

@test "the exit convention: 3 on a missing baseline or unresolvable base, 2 on a usage error, 0 on --help" {
  local root
  root="$(make_root exits)"
  run bash "${RATCHET_SH}" --root "${root}"
  [[ "${status}" -eq 3 && "${output}" == *'baseline missing'* ]] || {
    echo "missing baseline: ${status} ${output}"
    return 1
  }
  write_baseline "${root}" ''
  run bash "${RATCHET_SH}" --root "${root}" --base no-such-rev
  [[ "${status}" -eq 3 && "${output}" == *'merge base'* ]] || {
    echo "unresolvable base: ${status} ${output}"
    return 1
  }
  run bash "${RATCHET_SH}" --no-such-flag
  [[ "${status}" -eq 2 ]] || {
    echo "unknown flag: ${status} ${output}"
    return 1
  }
  run bash "${RATCHET_SH}" --root
  [[ "${status}" -eq 2 ]] || {
    echo "missing --root value: ${status} ${output}"
    return 1
  }
  run bash "${RATCHET_SH}" --help
  [[ "${status}" -eq 0 ]] || {
    echo "help: ${status} ${output}"
    return 1
  }
}
