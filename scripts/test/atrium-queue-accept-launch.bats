#!/usr/bin/env bats
# shellcheck disable=SC2154,SC2312  # BATS_* and run results are set by bats; a masked status fails its comparison
# The opt-in accept launch wrapper against a stand-in claude. Protects the accept file passed only through
# --settings from a 0700 temp dir, its removal on exit, the refused --bg, the refusal that deletes nothing
# for a forced temp dir value that is empty, relative, a link or no directory, the env marker the
# SessionStart register turns into the accept-wrapper hint, and the same-uid risk in the help.
#
# Run via: bats scripts/test/atrium-queue-accept-launch.bats
# Requires: bats, bash 3.2+, jq, curl, python3

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
WRAPPER="${GA}/scripts/atrium-queue-accept-launch.sh"
SESSION_ID="3f1c2b9a-7d4e-4f5a-9b6c-0e1d2c3b4a59"

setup() {
  unset CLAUDE_CODE_SESSION_ID CLAUDE_PID CLAUDE_CONFIG_DIR CLAUDE_CODE_MESSAGING_SOCKET \
    CLAUDE_CODE_MESSAGING_TOKEN ATRIUM_QUEUE_ACCEPT_WRAPPER ATRIUM_MONITOR_PORT
  export HOME="${BATS_TEST_TMPDIR}/home"
  export GA_DATA_ROOT="${HOME}/.glass-atrium"
  mkdir -p "${HOME}" "${BATS_TEST_TMPDIR}/bin"
  CALLS="${BATS_TEST_TMPDIR}/claude-calls"
  # stand-in claude: records its argv, its env marker and the --settings file as it sees it, then exits $CLAUDE_STUB_EXIT
  cat >"${BATS_TEST_TMPDIR}/bin/claude" <<'STUB'
#!/usr/bin/env bash
{
  printf 'argv:'
  printf ' <%s>' "$@"
  printf '\nmarker: %s\n' "${ATRIUM_QUEUE_ACCEPT_WRAPPER:-}"
  if [[ "${1:-}" == --settings ]]; then
    printf 'settings: %s\n' "$2"
    listing="$(ls -ld -- "$2")"
    printf 'file mode: %s\n' "${listing:0:10}"
    listing="$(ls -ld -- "${2%/*}")"
    printf 'dir mode: %s\n' "${listing:0:10}"
    printf 'content: %s\n' "$(cat -- "$2")"
  fi
} >>"${CALLS}"
if [[ -n "${CLAUDE_STUB_HOOK:-}" ]]; then "${CLAUDE_STUB_HOOK}" </dev/null; fi
exit "${CLAUDE_STUB_EXIT:-0}"
STUB
  chmod 755 "${BATS_TEST_TMPDIR}/bin/claude"
  export CALLS PATH="${BATS_TEST_TMPDIR}/bin:${PATH}"
}

teardown() {
  if [[ -n "${STUB_PID:-}" ]]; then
    kill "${STUB_PID}" 2>/dev/null || true
    wait "${STUB_PID}" 2>/dev/null || true
  fi
}

calls_field() {
  sed -n "s/^$1: //p" "${CALLS}"
}

@test "the accept file reaches the session only through --settings, 0600 in a 0700 dir, removed on exit" {
  export CLAUDE_STUB_EXIT=7
  run --separate-stderr "${WRAPPER}" --dangerously-skip-permissions --model haiku
  local settings
  settings="$(calls_field settings)"
  [[ "${status}" -eq 7 ]] || {
    echo "status=${status} ${stderr}"
    return 1
  }
  [[ "$(calls_field argv)" == "<--settings> <${settings}> <--dangerously-skip-permissions> <--model> <haiku>" &&
  "$(calls_field 'file mode')" == -rw------- &&
  "$(calls_field 'dir mode')" == drwx------ &&
  "$(calls_field content)" == '{"crossSessionInbound":"accept"}' ]] || {
    cat "${CALLS}"
    return 1
  }
  [[ -n "${settings}" && ! -e "${settings%/*}" && -z "$(ls -A "${HOME}")" ]] || {
    echo "left behind: ${settings%/*} · wrote under HOME: $(ls -A "${HOME}")"
    return 1
  }
}

@test "a background or second settings launch is refused before any temp dir or session" {
  # mktemp recorder on the wrapper's PATH only → a refusal that made a temp dir shows up in its log
  mkdir -p "${BATS_TEST_TMPDIR}/recorded"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>"%s"\nexec "%s" "$@"\n' \
    "${BATS_TEST_TMPDIR}/mktemp.log" "$(command -v mktemp)" >"${BATS_TEST_TMPDIR}/recorded/mktemp"
  chmod 755 "${BATS_TEST_TMPDIR}/recorded/mktemp"
  local row name args
  for row in "bg|--bg" "background|--background -p hi" "bg value|--bg=1" "settings|--settings /tmp/s.json"; do
    IFS='|' read -r name args <<<"${row}"
    IFS=' ' read -r -a argv <<<"${args}"
    run --separate-stderr env PATH="${BATS_TEST_TMPDIR}/recorded:${PATH}" "${WRAPPER}" "${argv[@]}"
    [[ "${status}" -eq 64 && "${stderr}" == *refused* && ! -e "${CALLS}" && ! -e "${BATS_TEST_TMPDIR}/mktemp.log" ]] || {
      echo "row ${name}: status=${status} ${stderr}"
      return 1
    }
  done
}

@test "a temp dir value that is empty, relative, a link or no directory deletes nothing and exits non-zero with no session" {
  mkdir -p "${BATS_TEST_TMPDIR}/cwd/rel" "${BATS_TEST_TMPDIR}/link-target"
  : >"${BATS_TEST_TMPDIR}/cwd/rel/keep"
  : >"${BATS_TEST_TMPDIR}/cwd/keep"
  : >"${BATS_TEST_TMPDIR}/plain-file"
  ln -s "${BATS_TEST_TMPDIR}/link-target" "${BATS_TEST_TMPDIR}/dir-link"
  local row name value reason kept
  for row in "empty||refusing|keep" "relative|rel|refusing|rel/keep" \
    "link to a directory|${BATS_TEST_TMPDIR}/dir-link|not this user's own directory|${BATS_TEST_TMPDIR}/dir-link" \
    "regular file|${BATS_TEST_TMPDIR}/plain-file|not this user's own directory|${BATS_TEST_TMPDIR}/plain-file"; do
    IFS='|' read -r name value reason kept <<<"${row}"
    # mktemp stand-in on the wrapper's PATH only (bats' own run needs the real one) → the forced temp dir value
    mkdir -p "${BATS_TEST_TMPDIR}/forced"
    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "%s"\n' "${value}" >"${BATS_TEST_TMPDIR}/forced/mktemp"
    chmod 755 "${BATS_TEST_TMPDIR}/forced/mktemp"
    cd "${BATS_TEST_TMPDIR}/cwd"
    run --separate-stderr env PATH="${BATS_TEST_TMPDIR}/forced:${PATH}" "${WRAPPER}"
    [[ "${status}" -ne 0 && "${stderr}" == *"${reason}"* && ! -e "${CALLS}" && -e "${kept}" && -e keep &&
      ! -e rel/accept-settings.json ]] || {
      echo "row ${name}: status=${status} ${stderr}"
      ls -la . rel "${BATS_TEST_TMPDIR}"
      return 1
    }
  done
}

@test "a session launched through the wrapper registers with the accept-wrapper launch hint" {
  export GA_ROOT="${BATS_TEST_TMPDIR}/ga-root"
  mkdir -p "${GA_ROOT}/secrets"
  printf 'k3yV4lue_0123456789abcdefABCDEF-xyz\n' >"${GA_ROOT}/secrets/queue-key"
  printf '200\n{"answeredWaiting":0}' >"${BATS_TEST_TMPDIR}/reply"
  python3 -I "${GA}/hooks/test/lib/queue-monitor-stub.py" "${BATS_TEST_TMPDIR}/port" \
    "${BATS_TEST_TMPDIR}/requests.log" "${BATS_TEST_TMPDIR}/reply" &
  STUB_PID=$!
  local tries=0
  while [[ ! -s "${BATS_TEST_TMPDIR}/port" ]] && ((tries < 100)); do
    sleep 0.05
    tries=$((tries + 1))
  done
  export ATRIUM_MONITOR_PORT CLAUDE_CODE_SESSION_ID="${SESSION_ID}" CLAUDE_PID=4242
  ATRIUM_MONITOR_PORT="$(cat "${BATS_TEST_TMPDIR}/port")"
  export CLAUDE_STUB_HOOK="${GA}/hooks/queue-session-register.sh"
  run --separate-stderr "${WRAPPER}"
  local hints
  hints="$(jq -r 'select(.path == "/api/queue/sessions/register") | .body | fromjson | .launchHint // "none"' \
    "${BATS_TEST_TMPDIR}/requests.log")"
  [[ "${status}" -eq 0 && "$(calls_field marker)" == 1 && "${hints}" == accept_wrapper ]] || {
    echo "status=${status} marker=$(calls_field marker) hints=${hints} ${stderr}"
    return 1
  }
}

@test "the help names the same-uid risk and the refused --bg" {
  run --separate-stderr "${WRAPPER}" --help
  [[ "${status}" -eq 0 && "${output}" == *"any process running as your user"* &&
    "${output}" == *"no prompt"* && "${output}" == *"--bg is refused"* && ! -e "${CALLS}" ]] || {
    echo "status=${status} ${output}"
    return 1
  }
}
