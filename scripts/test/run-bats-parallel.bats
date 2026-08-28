#!/usr/bin/env bats
# run-bats-parallel.bats — stage + exit-code contract of scripts/run-bats-parallel.sh.
#
# The self-improvement daemon reaches the test suite ONLY through this runner and
# consumes only its exit code (autoagent/daemon-apply.sh green-suite gate), so the
# runner's rc IS the gate's verdict. This suite pins the three properties that make
# that verdict trustworthy:
#   - the stages RUN rather than `exec`, so a later stage can still be reached and
#     the rc folds to the MAXIMUM stage rc, never to the last one;
#   - stage 3 is conditional on pytest being importable, and its absence is loud
#     (one stderr line) rather than silent;
#   - the bytecode-suppression variable is exported into every child, so a
#     daemon-driven run leaves no __pycache__ for the live recovery-repo snapshot
#     screen to refuse.
#
# Hermetic: the runner is COPIED into a sandbox, so its REPO_ROOT resolves to that
# sandbox and never to this checkout — no real suite is ever shelled. bats, GNU
# parallel and python3 are stubbed on PATH; the stubs read their behaviour from
# exported STUB_* variables at run time, which keeps every heredoc fully quoted.
# The one exception is the scenario-6 probe, which deliberately calls the REAL
# python3 by absolute path: only a real interpreter can demonstrate that no
# __pycache__ appears.

bats_require_minimum_version 1.5.0

REAL_RUNNER="${BATS_TEST_DIRNAME}/../run-bats-parallel.sh"

# Writes stdin to an executable stub of the given name in the stub bin dir.
write_stub() {
  local name="${1}"
  cat >"${STUB_BIN}/${name}"
  chmod +x "${STUB_BIN}/${name}"
}

setup() {
  if [[ ! -f "${REAL_RUNNER}" ]]; then
    echo "broken tree: run-bats-parallel.sh missing at ${REAL_RUNNER}" >&2
    return 1
  fi
  REAL_PYTHON3="$(command -v python3)" || skip "python3 not found"
  export REAL_PYTHON3

  TMPROOT="$(mktemp -d -t run-bats-parallel-bats.XXXXXX)"
  SANDBOX="${TMPROOT}/repo"
  STUB_BIN="${TMPROOT}/bin"
  STUB_LOG_DIR="${TMPROOT}/log"
  RUNNER="${SANDBOX}/scripts/run-bats-parallel.sh"
  STUB_PATH="${STUB_BIN}:${PATH}"
  export STUB_LOG_DIR
  mkdir -p "${STUB_BIN}" "${STUB_LOG_DIR}/pyprobe" "${SANDBOX}/scripts" \
    "${SANDBOX}/test" "${SANDBOX}/hooks/test" "${SANDBOX}/scripts/test" \
    "${SANDBOX}/autoagent/test"
  cp -- "${REAL_RUNNER}" "${RUNNER}"
  chmod +x "${RUNNER}"

  # The module scenario 6 imports through the REAL interpreter. Its mere import is
  # what would produce __pycache__ next to it.
  printf 'GA_PROBE = 1\n' >"${STUB_LOG_DIR}/pyprobe/ga_probe_mod.py"

  # Records its argv and the bytecode-suppression value it INHERITED, then exits
  # with the rc the scenario asked for. The import probe runs only when armed.
  write_stub bats <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_LOG_DIR}/bats-args.log"
printf '%s\n' "${PYTHONDONTWRITEBYTECODE-__UNSET__}" >>"${STUB_LOG_DIR}/bats-env.log"
if [[ -n "${STUB_BATS_IMPORT_PROBE:-}" ]]; then
  cd -- "${STUB_LOG_DIR}/pyprobe" && "${REAL_PYTHON3}" -c 'import ga_probe_mod'
fi
exit "${STUB_BATS_RC:-0}"
STUB

  # One stub serving all three python3 call shapes. The pytest IMPORT probe is
  # matched first: its argv also contains the word "pytest".
  write_stub python3 <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${STUB_LOG_DIR}/python3-args.log"
case "$*" in
  *'import pytest'*) exit "${STUB_PYTEST_IMPORT_RC:-0}" ;;
  *unittest*) exit "${STUB_UNITTEST_RC:-0}" ;;
  *pytest*) exit "${STUB_PYTEST_RC:-0}" ;;
esac
exit 0
STUB

  # Present only so the runner's `command -v parallel` hard dependency check passes.
  write_stub parallel <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  # A suppression value inherited from the ambient shell would make the export
  # assertions pass without the runner exporting anything.
  unset PYTHONDONTWRITEBYTECODE
}

teardown() {
  [[ -n "${TMPROOT:-}" && -d "${TMPROOT}" ]] && rm -rf -- "${TMPROOT}" || true
}

@test "(1) the bats child inherits the bytecode-suppression variable" {
  run --separate-stderr env "PATH=${STUB_PATH}" "${RUNNER}"
  [[ "${status}" -eq 0 ]] || {
    printf 'runner rc=%s stderr:\n%s\n' "${status}" "${stderr}" >&2
    return 1
  }
  local seen
  seen="$(cat "${STUB_LOG_DIR}/bats-env.log")"
  [[ "${seen}" == "1" ]] || {
    printf 'child PYTHONDONTWRITEBYTECODE=%s (want 1)\n' "${seen}" >&2
    return 1
  }
}

@test "(2) a bats rc of 3 becomes the runner rc while later stages still run" {
  export STUB_BATS_RC=3
  run --separate-stderr env "PATH=${STUB_PATH}" "${RUNNER}"
  # Folded to the MAXIMUM, not to the last stage: stages 2 and 3 return 0 here.
  [[ "${status}" -eq 3 ]] || {
    printf 'runner rc=%s (want 3) stderr:\n%s\n' "${status}" "${stderr}" >&2
    return 1
  }
  # An `exec bats` tail would end the process at stage 1 and never reach python3.
  grep -q -- '-m unittest discover' "${STUB_LOG_DIR}/python3-args.log" || {
    printf 'stage 2 never ran; recorded python3 calls:\n%s\n' \
      "$(cat "${STUB_LOG_DIR}/python3-args.log" 2>/dev/null)" >&2
    return 1
  }
}

@test "(3) a failing hooks unittest stage fails the runner even when bats passes" {
  export STUB_BATS_RC=0
  export STUB_UNITTEST_RC=1
  run --separate-stderr env "PATH=${STUB_PATH}" "${RUNNER}"
  [[ "${status}" -ne 0 ]] || {
    printf 'runner rc=0 despite a failing hooks stage; stderr:\n%s\n' "${stderr}" >&2
    return 1
  }
}

@test "(4) an unimportable pytest skips stage 3 loudly on one line and keeps rc 0" {
  export STUB_PYTEST_IMPORT_RC=1
  run --separate-stderr env "PATH=${STUB_PATH}" "${RUNNER}"
  [[ "${status}" -eq 0 ]] || {
    printf 'runner rc=%s (want 0) stderr:\n%s\n' "${status}" "${stderr}" >&2
    return 1
  }
  if grep -q -- '-m pytest' "${STUB_LOG_DIR}/python3-args.log"; then
    printf 'stage 3 ran despite an unimportable pytest:\n%s\n' \
      "$(cat "${STUB_LOG_DIR}/python3-args.log")" >&2
    return 1
  fi
  local skips
  # `grep -c` prints 0 AND exits 1 on zero matches, so `|| true` (never `|| echo 0`,
  # which would append a second zero to grep's own).
  skips="$(printf '%s\n' "${stderr}" | grep -c 'SKIP' || true)"
  if [[ -z "${skips}" ]]; then
    skips=0
  fi
  [[ "${skips}" -eq 1 ]] || {
    printf 'SKIP lines=%s (want exactly 1) stderr:\n%s\n' "${skips}" "${stderr}" >&2
    return 1
  }
}

@test "(5) an importable pytest runs stage 3 against scripts/test" {
  run --separate-stderr env "PATH=${STUB_PATH}" "${RUNNER}"
  [[ "${status}" -eq 0 ]] || {
    printf 'runner rc=%s (want 0) stderr:\n%s\n' "${status}" "${stderr}" >&2
    return 1
  }
  grep -q -- '-m pytest.*scripts/test' "${STUB_LOG_DIR}/python3-args.log" || {
    printf 'no scripts/test pytest call recorded; recorded python3 calls:\n%s\n' \
      "$(cat "${STUB_LOG_DIR}/python3-args.log" 2>/dev/null)" >&2
    return 1
  }
}

@test "(6) a child importing a module leaves no __pycache__ behind" {
  export STUB_BATS_IMPORT_PROBE=1
  run --separate-stderr env "PATH=${STUB_PATH}" "${RUNNER}"
  [[ "${status}" -eq 0 ]] || {
    printf 'runner rc=%s (want 0) stderr:\n%s\n' "${status}" "${stderr}" >&2
    return 1
  }
  [[ ! -e "${STUB_LOG_DIR}/pyprobe/__pycache__" ]] || {
    printf 'bytecode cache written next to the imported module:\n%s\n' \
      "$(ls -a "${STUB_LOG_DIR}/pyprobe")" >&2
    return 1
  }
}
