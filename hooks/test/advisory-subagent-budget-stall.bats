#!/usr/bin/env bats
# advisory-subagent-budget-stall.bats — the main-session stall listing of advisory-subagent-budget.sh:
# a running agent of this session (live-child marker from agent-tracker.sh) whose last tool call is older
# than the stall threshold gets one stderr advisory line on the main session's next tool call.
#
# Every state is built by its producer — the marker by agent-tracker.sh, the per-agent counter by a
# subagent call through the hook — and only aged afterwards (os.utime), standing in for elapsed time.
# Hermetic: GA_DATA_ROOT and SUBAGENT_TOOL_BUDGET_DIR point into a mktemp sandbox; the tracker's database
# write targets a socket that cannot exist.
# shellcheck disable=SC2154,SC2312  # bats assigns BATS_TEST_DIRNAME · jq builds fixed fixtures

HOOK_SH="${BATS_TEST_DIRNAME}/../advisory-subagent-budget.sh"
TRACKER_SH="${BATS_TEST_DIRNAME}/../agent-tracker.sh"
# shellcheck source-path=SCRIPTDIR source=../../scripts/lib/path-guard.sh
source "${BATS_TEST_DIRNAME}/../../scripts/lib/path-guard.sh"

AID="astall-probe-1f2e3d4c5b6a7980"
STALL_TAG="[subagent-stall-advisory]"

setup() {
  [[ -f "${HOOK_SH}" && -f "${TRACKER_SH}" ]] || skip "hook not found"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  SANDBOX="$(mktemp -d -t ga-stall-bats.XXXXXX)"
}

teardown() {
  if ga_guard_path "${SANDBOX:-}"; then rm -rf -- "${SANDBOX:?}"; fi
}

# $1=root name — a fresh data root, counter dir and two sessions' transcript trees
use_root() {
  ROOT="${SANDBOX}/${1}"
  mkdir -p "${ROOT}/counters" "${ROOT}/proj/S1/subagents" "${ROOT}/proj/S2/subagents"
}

# $1=hook_event_name — agent-tracker.sh writes or removes the live-child marker of AID
tracker() {
  jq -nc --arg e "${1}" --arg a "${AID}" '{hook_event_name:$e, agent_id:$a, agent_type:"glass-atrium-dev-android"}' \
    | GA_DATA_ROOT="${ROOT}/ga" PGHOST="/nonexistent-socket-xyzzy" bash "${TRACKER_SH}" >/dev/null 2>&1
}

# $1=input JSON
budget_hook() {
  printf '%s' "${1}" | env GA_DATA_ROOT="${ROOT}/ga" SUBAGENT_TOOL_BUDGET_DIR="${ROOT}/counters" \
    SUBAGENT_TOOL_BUDGET_OFF="" bash "${HOOK_SH}" 2>&1
}

# one tool call of AID — the hook writes its per-agent counter
agent_call() {
  budget_hook "$(jq -nc --arg a "${AID}" \
    '{agent_id:$a, session_id:"S1", tool_name:"Bash", tool_input:{command:"./gradlew test"}}')" >/dev/null
}

# the main session's next tool call, session S1
main_call() {
  run budget_hook "$(jq -nc --arg t "${ROOT}/proj/S1.jsonl" \
    '{session_id:"S1", transcript_path:$t, tool_name:"Read", tool_input:{file_path:"/tmp/notes.md"}}')"
}

# $1=path $2=minutes ago
age() {
  python3 -c 'import os, sys, time; t = time.time() - int(sys.argv[2]) * 60; os.utime(sys.argv[1], (t, t))' "${1}" "${2}"
}

@test "a main-session call lists exactly this session's running agents idle past the threshold" {
  local row name layout marker_age counter_age expect transcript listed
  local rows=(
    "idle past the threshold|flat|30|30|yes"
    "made a tool call within the threshold|flat|30|5|no"
    "no tool call yet, spawned past the threshold|flat|30|none|yes"
    "workflow agent idle past the threshold|workflow|30|30|yes"
    "agent of another session|other|30|30|no"
    "idle past the live-child marker TTL|flat|400|400|no"
    "stopped agent|stopped|30|30|no"
  )
  for row in "${rows[@]}"; do
    IFS='|' read -r name layout marker_age counter_age expect <<<"${row}"
    use_root "${name// /-}"
    case "${layout}" in
      workflow) transcript="${ROOT}/proj/S1/subagents/workflows/wf_1a2b3c4d-5e6/agent-${AID}.jsonl" ;;
      other) transcript="${ROOT}/proj/S2/subagents/agent-${AID}.jsonl" ;;
      *) transcript="${ROOT}/proj/S1/subagents/agent-${AID}.jsonl" ;;
    esac
    mkdir -p "${transcript%/*}" && : >"${transcript}"
    tracker SubagentStart
    [[ "${counter_age}" == none ]] || { agent_call && age "${ROOT}/counters/${AID}" "${counter_age}"; }
    [[ "${layout}" != stopped ]] || tracker SubagentStop
    [[ "${layout}" == stopped ]] || age "${ROOT}/ga/data/live-children/${AID}" "${marker_age}"
    main_call
    [[ "${status}" -eq 0 ]] || {
      echo "${name}: status ${status}: ${output}"
      return 1
    }
    listed=no
    [[ "${output}" != *"${STALL_TAG} agent ${AID} "* ]] || listed=yes
    [[ "${listed}" == "${expect}" ]] || {
      echo "${name}: listed=${listed}, want ${expect}: ${output}"
      return 1
    }
  done
}

@test "a listed stall is not listed again on the next main-session call" {
  use_root once
  : >"${ROOT}/proj/S1/subagents/agent-${AID}.jsonl"
  tracker SubagentStart
  agent_call
  age "${ROOT}/counters/${AID}" 30
  main_call
  [[ "${output}" == *"${STALL_TAG} agent ${AID} "* ]] || {
    echo "first call did not list: ${output}"
    return 1
  }
  main_call
  [[ "${output}" != *"${STALL_TAG}"* ]] || {
    echo "listed twice: ${output}"
    return 1
  }
}

@test "an agent idle again after a tool call made since its advisory is listed again" {
  use_root rearm
  : >"${ROOT}/proj/S1/subagents/agent-${AID}.jsonl"
  tracker SubagentStart
  agent_call
  age "${ROOT}/counters/${AID}" 60
  main_call
  [[ "${output}" == *"${STALL_TAG} agent ${AID} "* ]] || {
    echo "first stall not listed: ${output}"
    return 1
  }
  local state
  for state in "${ROOT}/counters/"*; do age "${state}" 50; done
  agent_call
  age "${ROOT}/counters/${AID}" 30
  main_call
  [[ "${output}" == *"${STALL_TAG} agent ${AID} "* ]] || {
    echo "second stall not listed: ${output}"
    return 1
  }
}
