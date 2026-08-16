#!/usr/bin/env bats
# enforce-commit-guard-live-child-advisory.bats — pins the C1-H/C2-H commit-time live-child note.
#
# ADVISORY ONLY: the note is emitted on stderr with exit 0. The decisive assertion in every case
# below is therefore `status -eq 0` alongside the presence/absence of GIT-ADV-001 — a future change
# that promoted this observation to a block would fail here, which is the point (the plan forbids
# describing or implementing it as enforcement while the marker carries no worktree).
#
# Branches: fires for a main-session `git commit` with a fresh marker · silent with no marker ·
# silent when the caller is itself a subagent · silent when the only marker is past its TTL ·
# silent for a non-commit git command.
#
# GA_DATA_ROOT sandboxes the marker dir into BATS_TEST_TMPDIR.
# BATS GATING NOTE: only the LAST command gates a test — every assertion carries `|| return 1`.

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-commit-guard.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-commit-guard.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  GA_DATA="${BATS_TEST_TMPDIR}/ga"
  MARKER_DIR="${GA_DATA}/data/live-children"
  mkdir -p "${MARKER_DIR}"
}

# $1=command $2=agent_id (empty → main-session origin)
run_guard() {
  local payload
  payload="$(jq -n --arg c "${1}" --arg a "${2:-}" \
    '{tool_name:"Bash", tool_input:{command:$c}}
     + (if $a == "" then {} else {agent_id:$a} end)')"
  run bash -c 'printf "%s" "$1" | GA_DATA_ROOT="$2" bash "$3" 2>&1' \
    _ "${payload}" "${GA_DATA}" "${HOOK_SH}"
}

@test "main-session git commit with a live child raises GIT-ADV-001 (advisory, exit 0)" {
  : >"${MARKER_DIR}/child-001"
  run_guard 'git commit -m "wip"'
  [[ "${status}" -eq 0 ]] || { echo "advisory must never block (status ${status})" >&2; return 1; }
  [[ "${output}" == *'GIT-ADV-001'* ]] || { echo "no advisory in: ${output}" >&2; return 1; }
}

@test "no live-child marker → silent" {
  run_guard 'git commit -m "wip"'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *'GIT-ADV-001'* ]] || { echo "false advisory: ${output}" >&2; return 1; }
}

@test "a subagent caller committing its own work is silent" {
  : >"${MARKER_DIR}/child-001"
  run_guard 'git commit -m "wip"' "agent-abc-123"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *'GIT-ADV-001'* ]] || { echo "fired for a subagent caller: ${output}" >&2; return 1; }
}

@test "a marker past its TTL is swept and does not raise" {
  local stale="${MARKER_DIR}/child-stale"
  : >"${stale}"
  # 7h old — past the 360-minute TTL (a truncated subagent never fires SubagentStop).
  touch -t "$(date -v-7H +%Y%m%d%H%M 2>/dev/null || date -d '7 hours ago' +%Y%m%d%H%M)" "${stale}"
  run_guard 'git commit -m "wip"'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *'GIT-ADV-001'* ]] || { echo "stale marker raised: ${output}" >&2; return 1; }
  [[ ! -e "${stale}" ]] || { echo "stale marker not swept" >&2; return 1; }
}

@test "a non-commit git command is silent even with a live child" {
  : >"${MARKER_DIR}/child-001"
  run_guard 'git status --short'
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *'GIT-ADV-001'* ]] || { echo "fired on a non-commit command: ${output}" >&2; return 1; }
}
