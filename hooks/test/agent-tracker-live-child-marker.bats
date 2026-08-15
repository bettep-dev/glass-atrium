#!/usr/bin/env bats
# agent-tracker-live-child-marker.bats — pins the C1-H/C2-H live-child marker written by
# agent-tracker.sh on SubagentStart and removed on SubagentStop.
#
# The marker is ADVISORY OBSERVABILITY ONLY — it does not enforce worktree isolation, and these
# tests assert its file-level contract, never an enforcement claim.
# Three branches: created on Start · removed on Stop · a write malfunction is LOUD (named warn code
# on stderr) rather than silently absorbed, with the hook staying non-blocking (exit 0).
#
# PG-free by construction: the hook's dual-write helper is tolerated non-blocking (`|| true`), so no
# ephemeral cluster is needed here — agent-tracker.bats owns the write-contract coverage.
# GA_DATA_ROOT sandboxes HOOK_DATA_DIR into BATS_TEST_TMPDIR so no live runtime path is touched.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e` — only the LAST command gates the verdict, so
# every assertion carries `|| return 1`.

HOOK_SH="${BATS_TEST_DIRNAME}/../agent-tracker.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "agent-tracker.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  GA_DATA="${BATS_TEST_TMPDIR}/ga"
  MARKER_DIR="${GA_DATA}/data/live-children"
  AID="bats-live-child-aid-001"
}

# $1=hook_event_name $2=agent_id
fire() {
  local payload
  payload="$(jq -n --arg e "${1}" --arg a "${2}" --arg t "glass-atrium-dev-shell" \
    '{hook_event_name:$e, agent_id:$a, agent_type:$t}')"
  run bash -c 'printf "%s" "$1" | GA_DATA_ROOT="$2" bash "$3" 2>&1' \
    _ "${payload}" "${GA_DATA}" "${HOOK_SH}"
}

@test "SubagentStart creates a live-child marker named after the agent id" {
  fire "SubagentStart" "${AID}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ -f "${MARKER_DIR}/${AID}" ]] || { echo "marker absent: ${MARKER_DIR}/${AID}" >&2; return 1; }
}

@test "SubagentStop removes the marker its Start created" {
  fire "SubagentStart" "${AID}"
  [[ -f "${MARKER_DIR}/${AID}" ]] || return 1
  fire "SubagentStop" "${AID}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! -e "${MARKER_DIR}/${AID}" ]] || { echo "marker survived Stop" >&2; return 1; }
}

@test "a main-session event (Stop) writes no marker" {
  fire "Stop" ""
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! -d "${MARKER_DIR}" ]] || { echo "marker dir created for a main-session event" >&2; return 1; }
}

@test "an unwritable marker dir is LOUD (DATA-074 warn) and still non-blocking" {
  mkdir -p "${MARKER_DIR}"
  chmod 500 "${MARKER_DIR}"
  fire "SubagentStart" "${AID}"
  chmod 700 "${MARKER_DIR}"
  [[ "${status}" -eq 0 ]] || { echo "hook must stay non-blocking" >&2; return 1; }
  [[ "${output}" == *'DATA-074'* ]] || { echo "silent absorption — no DATA-074 in: ${output}" >&2; return 1; }
}
