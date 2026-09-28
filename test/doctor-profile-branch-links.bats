#!/usr/bin/env bats
# doctor-profile-branch-links.bats — pins run_doctor §27 (profile-branch links).
#
# A CLAUDE_CONFIG_DIR branch beside the target home (~/.claude-work, …) loads Atrium only through
# links to the target home's items, and Atrium never installed the branch. The section reports each
# item a branch fails to link, with a fix line that runs as printed, and never writes (kind B).
#
# Hermetic: the target home is a sandbox dir named `.claude`, so `.claude-<x>` siblings sit beside
# it; a printed fix line runs with HOME pointed at the sandbox, so its Trash is the sandbox's.
#
# Run via: bats test/doctor-profile-branch-links.bats
# Requires: bats >= 1.5.0, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"

# The set the sandbox manifest below yields: its non-excluded top-level components plus settings.json.
REQUIRED=(agents rules skills settings.json)

setup() {
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"
  SANDBOX="$(mktemp -d -t ga-doctor-profile-link-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga"
  HOMEDIR="${SANDBOX}/home"
  TARGET="${HOMEDIR}/.claude"
  BRANCH="${HOMEDIR}/.claude-work"
  MANIFEST="${SANDBOX}/manifest.json"
  mkdir -p "${GA_SANDBOX}" "${HOMEDIR}/.Trash" "${TARGET}/agents" "${TARGET}/rules" "${TARGET}/skills"
  printf '{}\n' >"${TARGET}/settings.json"
  printf '{"version":"1.0.0","agents":{}}\n' >"${GA_SANDBOX}/agent-registry.json"
  seed_manifest agents/a.md rules/r.md skills/s/SKILL.md hooks/h.sh lib/l.sh glass-atrium
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# Manifest listing $@, each seeded as a source file so the §4 source check stays green.
seed_manifest() {
  local rel files=""
  for rel in "$@"; do
    mkdir -p "${GA_SANDBOX}/$(dirname "${rel}")"
    printf 'x\n' >"${GA_SANDBOX}/${rel}"
    files="${files}${files:+,}\"${rel}\""
  done
  printf '{"version":"1.0.1","files":[%s],"hashes":{}}\n' "${files}" >"${MANIFEST}"
}

# A launched profile branch ($1, holding .claude.json) linking each item in $2.. to the target home.
seed_branch() {
  local branch="${1}" item
  shift
  mkdir -p "${branch}"
  printf '{}\n' >"${branch}/.claude.json"
  for item in "$@"; do
    ln -s "${TARGET}/${item}" "${branch}/${item}"
  done
}

# ENGINE (optional) swaps the sourced engine tree; unset → the repo itself.
run_doctor_sandbox() {
  local engine="${ENGINE:-${GA}}"
  run env GA_LIB_DIR="${engine}/scripts/lib" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    GA_GENERATE_MANIFEST="${SANDBOX}/no-such-manifest-gen" \
    GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${SANDBOX}/state" \
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT:-9}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      run_doctor
    ' _ "${engine}" "${GA_SANDBOX}"
}

assert_output_has() {
  [[ "${output}" == *"${1}"* ]] || {
    echo "doctor output missing '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

assert_output_lacks() {
  [[ "${output}" != *"${1}"* ]] || {
    echo "doctor output unexpectedly contains '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# The warning total the PASS summary reports: 0 on a bare PASS, the parenthesised number otherwise.
warn_total_of_output() {
  local line
  line="$(printf '%s\n' "${output}" | grep -F '== doctor: PASS' || true)"
  [[ -n "${line}" ]] || {
    echo "no PASS summary line — harness defect, not a link verdict:" >&2
    echo "${output}" >&2
    return 1
  }
  case "${line}" in
    *"with "*" warning(s)"*)
      printf '%s' "${line}" | sed -e 's/.*with \([0-9][0-9]*\) warning(s).*/\1/'
      ;;
    *) printf '0' ;;
  esac
}

# Break the branch's rules link into defect class $1.
break_rules_link() {
  case "${1}" in
    missing) rm -- "${BRANCH}/rules" ;;
    dangling) ln -sfn "${SANDBOX}/gone" "${BRANCH}/rules" ;;
    elsewhere)
      mkdir -p "${SANDBOX}/elsewhere"
      ln -sfn "${SANDBOX}/elsewhere" "${BRANCH}/rules"
      ;;
    real)
      rm -- "${BRANCH}/rules"
      mkdir "${BRANCH}/rules"
      printf 'owner content\n' >"${BRANCH}/rules/own.md"
      ;;
    *) return 1 ;;
  esac
}

@test "no profile branch beside the target home prints no profile-branch row" {
  run_doctor_sandbox
  assert_output_lacks "profile branch"
}

@test "a branch linking every required item gets one ok row and no note" {
  seed_branch "${BRANCH}" "${REQUIRED[@]}"
  run_doctor_sandbox
  assert_output_has "ok   : profile branch ${BRANCH} links"
  assert_output_lacks "note : profile branch"
}

@test "each defect class is named, and its class-specific fix line repairs the branch when run as printed" {
  local class defect form fix
  for class in missing dangling elsewhere real; do
    rm -rf -- "${BRANCH}"
    seed_branch "${BRANCH}" "${REQUIRED[@]}"
    break_rules_link "${class}"
    case "${class}" in
      missing) defect="missing" form="ln -s ${TARGET}/rules ${BRANCH}/rules" ;;
      dangling) defect="is a dangling link" form="ln -sfn ${TARGET}/rules ${BRANCH}/rules" ;;
      elsewhere) defect="links elsewhere (${SANDBOX}/elsewhere)" form="ln -sfn ${TARGET}/rules ${BRANCH}/rules" ;;
      real)
        defect="is a real file or directory"
        form="mv ${BRANCH}/rules ~/.Trash/claude-work-rules.ga-replaced.* && ln -s ${TARGET}/rules ${BRANCH}/rules"
        ;;
    esac
    run_doctor_sandbox
    [[ "${output}" == *"note : profile branch ${BRANCH}: rules ${defect}"* ]] || {
      echo "${class}: defect row not named — output:" >&2
      echo "${output}" >&2
      return 1
    }
    fix="$(printf '%s\n' "${output}" | sed -n 's/^ *fix : //p')"
    # shellcheck disable=SC2053  # unquoted RHS on purpose: the real-dir form carries a timestamp glob
    [[ "${fix}" == ${form} ]] || {
      echo "${class}: fix line '${fix}' does not take the form '${form}'" >&2
      return 1
    }
    HOME="${HOMEDIR}" bash -c "${fix}" || {
      echo "${class}: fix line failed when run as printed: ${fix}" >&2
      return 1
    }
    run_doctor_sandbox
    [[ "${output}" == *"ok   : profile branch ${BRANCH} links"* ]] || {
      echo "${class}: branch not ok after running the printed fix — output:" >&2
      echo "${output}" >&2
      return 1
    }
  done
  # The real-dir fix moved the owner's content to the Trash rather than removing it.
  [[ -f "$(printf '%s\n' "${HOMEDIR}"/.Trash/claude-work-rules.ga-replaced.*)/own.md" ]]
}

# A link fix toward an absent target recreates a dangling link, so the next run repeats the row;
# the repair belongs to the target home, whose own doctor rows name it.
@test "an item the target home lacks gets a target-home repair row and no link fix, whatever the branch holds" {
  local state fix
  rm -- "${TARGET}/settings.json"
  for state in dangling-link real-file missing; do
    rm -rf -- "${BRANCH}"
    seed_branch "${BRANCH}" "${REQUIRED[@]}"
    case "${state}" in
      dangling-link) ;; # the seeded link already points at the absent target
      real-file) rm -- "${BRANCH}/settings.json" && printf '{}\n' >"${BRANCH}/settings.json" ;;
      missing) rm -- "${BRANCH}/settings.json" ;;
      *) return 1 ;;
    esac
    run_doctor_sandbox
    [[ "${output}" == *"note : profile branch ${BRANCH}: settings.json has no link target — the target home lacks ${TARGET}/settings.json; repair the target home first"* ]] || {
      echo "${state}: target-home repair row not named — output:" >&2
      echo "${output}" >&2
      return 1
    }
    fix="$(printf '%s\n' "${output}" | sed -n 's/^ *fix : //p')"
    [[ -z "${fix}" ]] || {
      echo "${state}: a link fix was printed toward the absent target: ${fix}" >&2
      return 1
    }
  done
}

@test "a branch directory holding no .claude.json gets no row" {
  seed_branch "${BRANCH}" "${REQUIRED[@]}"
  mkdir -p "${HOMEDIR}/.claude-pre-glass-atrium-backup-20260603T043853Z"
  run_doctor_sandbox
  assert_output_has "ok   : profile branch ${BRANCH} links"
  assert_output_lacks "backup"
}

@test "the target home is never reported as a branch of itself" {
  printf '{}\n' >"${TARGET}/.claude.json"
  seed_branch "${BRANCH}" "${REQUIRED[@]}"
  run_doctor_sandbox
  assert_output_has "ok   : profile branch ${BRANCH} links"
  assert_output_lacks "profile branch ${TARGET}:"
  assert_output_lacks "profile branch ${TARGET} links"
}

@test "the required set is every non-excluded top-level manifest component plus settings.json" {
  seed_manifest agents/a.md rules/r.md skills/s/SKILL.md commands/c.md hooks/h.sh lib/l.sh glass-atrium
  mkdir -p "${TARGET}/commands"
  seed_branch "${BRANCH}"
  run_doctor_sandbox
  local item
  for item in agents rules skills commands settings.json; do
    [[ "${output}" == *"note : profile branch ${BRANCH}: ${item} missing"* ]] || {
      echo "required item '${item}' not reported — output:" >&2
      echo "${output}" >&2
      return 1
    }
  done
  for item in hooks lib glass-atrium; do
    [[ "${output}" != *"note : profile branch ${BRANCH}: ${item} "* ]] || {
      echo "install-internal item '${item}' reported as required — output:" >&2
      echo "${output}" >&2
      return 1
    }
  done
}

@test "a manifest whose files member is not an array skips the check with one note" {
  seed_branch "${BRANCH}" "${REQUIRED[@]}"
  printf '{"version":"1.0.1","files":{},"hashes":{}}\n' >"${MANIFEST}"
  run_doctor_sandbox
  assert_output_has "note : profile branch link check skipped"
  assert_output_lacks "ok   : profile branch"
}

@test "an engine without the config-root grammar helper skips the check with one note and the doctor still reaches its verdict" {
  seed_branch "${BRANCH}" "${REQUIRED[@]}"
  run_doctor_sandbox
  local full_status="${status}"
  # an engine tree carrying lib/ and scripts/lib/ but no hooks/lib/ (the staged-engine fixture shape)
  ENGINE="${SANDBOX}/engine"
  mkdir -p "${ENGINE}/lib" "${ENGINE}/scripts/lib"
  cp "${GA}/lib/"ga-*.sh "${ENGINE}/lib/"
  cp "${GA}/scripts/lib/"*.sh "${ENGINE}/scripts/lib/"
  run_doctor_sandbox
  assert_output_has "note : profile branch link check skipped"
  assert_output_has "== doctor: "
  [[ "${status}" == "${full_status}" ]] || {
    echo "helper-less engine changed the doctor status ${full_status} -> ${status} — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

@test "the warning total and exit status are identical with and without a branch gap (kind B)" {
  seed_branch "${BRANCH}" "${REQUIRED[@]}"
  run_doctor_sandbox
  local clean_status="${status}" clean_total gap_total
  clean_total="$(warn_total_of_output)"
  rm -- "${BRANCH}/rules"
  run_doctor_sandbox
  assert_output_has "note : profile branch ${BRANCH}: rules missing"
  gap_total="$(warn_total_of_output)"
  [[ "${status}" == "${clean_status}" && "${gap_total}" == "${clean_total}" ]] || {
    echo "kind-B violation: status ${clean_status} -> ${status}, total ${clean_total} -> ${gap_total} — output:" >&2
    echo "${output}" >&2
    return 1
  }
}
