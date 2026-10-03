#!/usr/bin/env bats
# agent-tracker-live-child-marker.bats — pins the C1-H/C2-H live-child marker written by
# agent-tracker.sh on SubagentStart and removed on SubagentStop.
#
# The marker is ADVISORY OBSERVABILITY ONLY — it does not enforce worktree isolation, and these
# tests assert its file-level contract, never an enforcement claim.
# Four branches: created on Start · removed on Stop · a write malfunction and a delete malfunction
# or refusal are each LOUD (named warn code on stderr: DATA-074, DATA-075) rather than silently
# absorbed, with the hook staying non-blocking (exit 0).
#
# The hook's real dual-write runs on every fire, and `|| true` only tolerates a failed write, so fire()
# points it at a socket that cannot exist; agent-tracker.bats owns the write-contract coverage.
# GA_DATA_ROOT sandboxes HOOK_DATA_DIR into BATS_TEST_TMPDIR so no live runtime path is touched.
#
# BATS GATING NOTE: @test bodies run under errexit; a mid-body bare `[[ ]]` / `(( ))` is inert on
# bash 3.2.57 but GATES on CI's bash 5.3.9 — `[ ]` and plain commands gate on BOTH (measured, bats
# 1.13.0 on both legs, so bash is the variable, not bats). Every assertion carries `|| return 1`.

HOOK_SH="${BATS_TEST_DIRNAME}/../agent-tracker.sh"
# shellcheck source-path=SCRIPTDIR source=lib/ephemeral-pg.bash
source "${BATS_TEST_DIRNAME}/lib/ephemeral-pg.bash"

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
  run bash -c 'printf "%s" "$1" | GA_DATA_ROOT="$2" PGHOST="/nonexistent-socket-xyzzy" bash "$3" 2>&1' \
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

@test "a marker the Stop cannot delete survives and is LOUD (DATA-075)" {
  local row name root lockdown marker
  local rows=("unwritable marker dir|${GA_DATA}|yes" "relative data root|ga-rel|no")
  cd "${BATS_TEST_TMPDIR}" || return 1
  for row in "${rows[@]}"; do
    IFS='|' read -r name root lockdown <<<"${row}"
    GA_DATA="${root}"
    marker="${root}/data/live-children/${AID}"
    fire "SubagentStart" "${AID}"
    [[ -f "${marker}" ]] || {
      echo "${name}: Start wrote no marker" >&2
      return 1
    }
    if [[ "${lockdown}" == yes ]]; then chmod 500 "${marker%/*}"; fi
    fire "SubagentStop" "${AID}"
    chmod 700 "${marker%/*}"
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: hook must stay non-blocking" >&2
      return 1
    }
    [[ "${output}" == *'DATA-075'* ]] || {
      echo "${name}: silent — no DATA-075 in: ${output}" >&2
      return 1
    }
    [[ -f "${marker}" ]] || {
      echo "${name}: the marker was deleted" >&2
      return 1
    }
  done
}

@test "the tracker's event write never lands in the invoking shell's database" {
  # Per-run id → a write is a NEW row, never absorbed by the ON CONFLICT arbiter of an earlier run.
  local aid="bats-live-child-gate-$$-${RANDOM}" before after
  local query="SELECT count(*) FROM core.agent_events WHERE agent_id = '${aid}';"
  before="$(eph_pg_query_caller_target "${query}")"
  fire "SubagentStart" "${aid}"
  fire "SubagentStop" "${aid}"
  after="$(eph_pg_query_caller_target "${query}")"
  [[ "${before}" == "${after}" ]] || {
    echo "fixture rows reached the invoking shell's database: before=${before} after=${after}" >&2
    return 1
  }
}
