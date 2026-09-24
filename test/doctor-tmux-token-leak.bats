#!/usr/bin/env bats
# doctor-tmux-token-leak.bats — pins run_doctor §26 (OAuth token leaked into the default tmux
# server's global environment or the launchd user domain). Registration kind A: each leaking
# surface adds one to the warning total AND to the `token-leak` breakdown term.
#
# No real tmux server and no real launchd are touched: both binaries resolve to recording stubs
# placed ahead of PATH. The dummy value is asserted ABSENT from the output — the row reports names
# and counts only.
#
# Run via: bats test/doctor-tmux-token-leak.bats
# Requires: bats >= 1.5.0, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
LEAK_NAME="CLAUDE_CODE_OAUTH_TOKEN"
DUMMY_VALUE="dummy01"

setup() {
  [[ -f "${GA}/lib/ga-core.sh" ]] || skip "ga-core.sh not found: ${GA}/lib/ga-core.sh"

  SANDBOX="$(mktemp -d -t ga-doctor-token-leak-bats.XXXXXX)"
  GA_SANDBOX="${SANDBOX}/ga"
  TARGET="${SANDBOX}/target"
  MANIFEST="${SANDBOX}/manifest.json"
  STUB="${SANDBOX}/bin"
  STUB_STATE="${SANDBOX}/stub"
  mkdir -p "${TARGET}" "${GA_SANDBOX}/agents" "${STUB}" "${STUB_STATE}"
  printf '{"version":"1.0.1","files":[],"hashes":{}}\n' >"${MANIFEST}"
  printf '{"version":"1.0.0","agents":{}}\n' >"${GA_SANDBOX}/agent-registry.json"
  seed_stubs
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

# tmux stub: a server "runs" iff the server flag file exists — otherwise it fails with tmux's own
# no-server text, or the seeded tmux-error text; show-environment -g replays the
# seeded global env. launchctl stub: getenv replays a per-name file, exit 0 either way (the real
# launchctl exits 0 on an unset name too). Every call is logged for the no-server-start assertion.
seed_stubs() {
  cat >"${STUB}/tmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$1" >>"${GA_STUB_STATE}/tmux-calls.log"
if [[ ! -f "${GA_STUB_STATE}/tmux-server" ]]; then
  if [[ -f "${GA_STUB_STATE}/tmux-error" ]]; then
    cat -- "${GA_STUB_STATE}/tmux-error" >&2
  else
    printf 'no server running on /private/tmp/tmux-501/default\n' >&2
  fi
  exit 1
fi
case "$1" in
  list-sessions) printf 'daemon: 1 windows\n' ;;
  show-environment) cat -- "${GA_STUB_STATE}/tmux-env" ;;
esac
exit 0
STUB
  cat >"${STUB}/launchctl" <<'STUB'
#!/usr/bin/env bash
[[ "$1" == "getenv" && -f "${GA_STUB_STATE}/launchd-$2" ]] && cat -- "${GA_STUB_STATE}/launchd-$2"
exit 0
STUB
  chmod +x "${STUB}/tmux" "${STUB}/launchctl"
  # Clean default: a running server whose env carries a removal marker and a prefix-sharing name,
  # neither of which is the leaked variable itself.
  : >"${STUB_STATE}/tmux-server"
  printf 'PATH=/usr/bin:/bin\n-%s\n%s_EXTRA=%s\n' "${LEAK_NAME}" "${LEAK_NAME}" "${DUMMY_VALUE}" \
    >"${STUB_STATE}/tmux-env"
}

seed_server_leak() {
  printf '%s=%s\n' "${LEAK_NAME}" "${DUMMY_VALUE}" >>"${STUB_STATE}/tmux-env"
}

seed_launchd_leak() {
  printf '%s\n' "${DUMMY_VALUE}" >"${STUB_STATE}/launchd-${LEAK_NAME}"
}

run_doctor_sandbox() {
  run env PATH="${STUB}:${PATH}" \
    GA_LIB_DIR="${GA}/scripts/lib" GA_TARGET_HOME="${TARGET}" GA_MANIFEST="${MANIFEST}" \
    GA_GENERATE_MANIFEST="${SANDBOX}/no-such-manifest-gen" \
    GA_DATA_ROOT="${SANDBOX}/data" ATRIUM_UPDATE_STATE_DIR="${SANDBOX}/state" \
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT:-9}" \
    GA_DB_NAME="ga_doctor_token_leak_sandbox" GA_SKIP_DB_SETUP=1 \
    GA_STUB_STATE="${STUB_STATE}" \
    bash -c '
      set -Eeuo pipefail
      source "$1/lib/ga-core.sh"
      ga_init_env "$2"
      run_doctor
    ' _ "${GA}" "${GA_SANDBOX}"
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
  local pass_line
  pass_line="$(printf '%s\n' "${output}" | grep -F -- '== doctor: PASS' | head -n 1 || true)"
  [[ -n "${pass_line}" ]] || {
    echo "no doctor PASS line in output — output:" >&2
    echo "${output}" >&2
    return 1
  }
  case "${pass_line}" in
    *'PASS (with '*) printf '%s' "${pass_line}" | sed -n 's/.*PASS (with \([0-9][0-9]*\) warning.*/\1/p' ;;
    *) printf '0' ;;
  esac
}

# The token-leak term of the breakdown, or empty on a bare PASS.
token_leak_term() {
  printf '%s\n' "${output}" | sed -n 's/.* \([0-9][0-9]*\) token-leak — see above.*/\1/p' | head -n 1
}

# Warning delta a scenario adds over the clean baseline, and its token-leak term.
assert_leak_delta() {
  local expected="$1" base now term
  run_doctor_sandbox
  base="$(warn_total_of_output)" || return 1
  "${@:2}"
  run_doctor_sandbox
  [[ "${status}" -eq 0 ]] || return 1
  now="$(warn_total_of_output)" || return 1
  term="$(token_leak_term)"
  [[ "$((now - base))" -eq "${expected}" && "${term:-0}" -eq "${expected}" ]] || {
    printf 'leak delta: base=%s now=%s term=%s expected=+%s\n' "${base}" "${now}" "${term}" "${expected}" >&2
    return 1
  }
  assert_output_lacks "${DUMMY_VALUE}"
}

@test "clean: a running server without the token, empty launchd value -> ok rows, no warning" {
  run_doctor_sandbox
  [[ "${status}" -eq 0 ]] || return 1
  assert_output_has "ok   : default tmux server global environment carries no ${LEAK_NAME}" || return 1
  assert_output_has "ok   : launchd user domain carries no ${LEAK_NAME}" || return 1
  assert_output_lacks "warn : ${LEAK_NAME}" || return 1
  [[ "$(token_leak_term)" == "" || "$(token_leak_term)" == "0" ]]
}

@test "server leak: the token in the global env adds exactly one counted warning, value never shown" {
  assert_leak_delta 1 seed_server_leak || return 1
  assert_output_has "warn : ${LEAK_NAME} is set in the default tmux server's global environment" || return 1
}

@test "launchd leak: a non-empty getenv value adds exactly one counted warning, value never shown" {
  assert_leak_delta 1 seed_launchd_leak || return 1
  assert_output_has "warn : ${LEAK_NAME} is set in the launchd user domain" || return 1
}

@test "no server running: clean, and no tmux subcommand that could start a server is issued" {
  mv -- "${STUB_STATE}/tmux-server" "${SANDBOX}/tmux-server.off"
  seed_server_leak
  run_doctor_sandbox
  [[ "${status}" -eq 0 ]] || return 1
  assert_output_has "ok   : no default tmux server running" || return 1
  assert_output_lacks "warn : ${LEAK_NAME} is set in the default tmux server" || return 1
  local unexpected
  grep -qx 'list-sessions' "${STUB_STATE}/tmux-calls.log" || return 1
  unexpected="$(grep -vx 'list-sessions' "${STUB_STATE}/tmux-calls.log" || true)"
  [[ -z "${unexpected}" ]] || {
    printf 'tmux called beyond list-sessions with no server: %s\n' "${unexpected}" >&2
    return 1
  }
}

@test "unreadable server: a list-sessions failure other than no-server is a note, never a clean pass" {
  mv -- "${STUB_STATE}/tmux-server" "${SANDBOX}/tmux-server.off"
  printf 'error connecting to /private/tmp/tmux-501/default (Permission denied)\n' \
    >"${STUB_STATE}/tmux-error"
  run_doctor_sandbox
  [[ "${status}" -eq 0 ]] || return 1
  assert_output_has "note : default tmux server unreadable" || return 1
  assert_output_lacks "ok   : no default tmux server running" || return 1
  assert_output_lacks "ok   : default tmux server global environment carries no" || return 1
  assert_output_lacks "${DUMMY_VALUE}"
}
