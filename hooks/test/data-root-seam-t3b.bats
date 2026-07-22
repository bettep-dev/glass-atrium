#!/usr/bin/env bats
# data-root-seam-t3b.bats — pins the T3b advisory/enforce/prune consumer conversion (+ the
# post-edit-typecheck T3a marker-dir straggler) onto the
# HOME-anchored GA_DATA_ROOT seam (${GA_DATA_ROOT:-$HOME/.glass-atrium}). Each hook's DEFAULT
# runtime data/log path (no per-file override) must resolve under $HOME/.glass-atrium/data, not
# $HOME/.claude/data. Every assertion is behavioral: the hook READS a seeded default-path store or
# WRITES its trace/marker to the default path — never a source grep.
#
# HEAD (pre-conversion) resolves these defaults to $HOME/.claude/data, so every @test below FAILS
# at HEAD (the seeded/asserted .glass-atrium path is untouched) and PASSES after the conversion.
#
# Run via: bats hooks/test/data-root-seam-t3b.bats
# Hermetic: HOME is repointed to a per-test mktemp sandbox; GA_DATA_ROOT + each per-file override
# are `env -u`-cleared so the DEFAULT resolves; no live ~/.claude or ~/.glass-atrium state touched.
# Hooks are invoked DIRECTLY as commands (shebang + exec bit) — never interpreter-prefixed.
#
# Each assertion uses `|| return 1` fail-fast: bats gates only the test body's LAST command, so an
# unguarded intermediate assertion would be silently masked by a later passing one.

bats_require_minimum_version 1.5.0

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  SANDBOX="$(mktemp -d -t data-root-seam-t3b.XXXXXX)"
  GA_DATA="${SANDBOX}/.glass-atrium/data"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}" || true
}

@test "advisory-spawn-budget.sh: no override → counts spawns from \$HOME/.glass-atrium/data/session-spawns" {
  local hook="${HOOKS_DIR}/advisory-spawn-budget.sh"
  [[ -x "${hook}" ]] || skip "hook not executable: ${hook}"
  mkdir -p "${GA_DATA}/session-spawns"
  printf 'glass-atrium-dev-shell\nglass-atrium-dev-shell\nglass-atrium-dev-shell\n' \
    >"${GA_DATA}/session-spawns/sess-t3b"

  run env -u GA_DATA_ROOT -u SESSION_SPAWNS_DIR HOME="${SANDBOX}" SPAWN_BUDGET_ADVISORY_THRESHOLD=2 \
    bash -c 'printf "%s" "$1" | "$2" 2>&1' _ '{"tool_name":"Agent","session_id":"sess-t3b"}' "${hook}"

  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ "${output}" == *"Spawn-budget advisory"* ]] || { echo "no advisory (default read missed new path): ${output}" >&2; return 1; }
}

@test "prune-session-spawns.sh: no override → sweeps \$HOME/.glass-atrium/data/{session-spawns,agent-tool-budget}" {
  local hook="${HOOKS_DIR}/prune-session-spawns.sh"
  [[ -x "${hook}" ]] || skip "hook not executable: ${hook}"
  local trash="${SANDBOX}/trash"
  mkdir -p "${GA_DATA}/session-spawns" "${GA_DATA}/agent-tool-budget" "${trash}"
  printf 'stale\n' >"${GA_DATA}/session-spawns/stale-spawn"
  printf 'stale\n' >"${GA_DATA}/agent-tool-budget/stale-budget"
  # 2020-01-01 — far outside the default 86400s TTL.
  touch -t 202001010000 "${GA_DATA}/session-spawns/stale-spawn" "${GA_DATA}/agent-tool-budget/stale-budget"

  run env -u GA_DATA_ROOT -u SESSION_SPAWNS_DIR -u AGENT_TOOL_BUDGET_DIR \
    HOME="${SANDBOX}" PRUNE_TRASH_DIR="${trash}" SESSION_SPAWNS_TTL=86400 \
    bash -c 'printf "%s" "{}" | "$1"' _ "${hook}"

  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ ! -f "${GA_DATA}/session-spawns/stale-spawn" ]] || { echo "spawn marker not pruned from new default" >&2; return 1; }
  [[ ! -f "${GA_DATA}/agent-tool-budget/stale-budget" ]] || { echo "budget counter not pruned from new default" >&2; return 1; }
  ls "${trash}"/stale-spawn_* >/dev/null 2>&1 || { echo "spawn marker not moved to Trash" >&2; return 1; }
  ls "${trash}"/stale-budget_* >/dev/null 2>&1 || { echo "budget counter not moved to Trash" >&2; return 1; }
}

@test "advisory-subagent-budget.sh: no override → counter store lands at \$HOME/.glass-atrium/data/agent-tool-budget" {
  local hook="${HOOKS_DIR}/advisory-subagent-budget.sh"
  [[ -x "${hook}" ]] || skip "hook not executable: ${hook}"

  run env -u GA_DATA_ROOT -u SUBAGENT_TOOL_BUDGET_DIR HOME="${SANDBOX}" \
    bash -c 'printf "%s" "$1" | "$2"' _ '{"agent_id":"agent-a"}' "${hook}"

  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  # The writer/reaper pair (this hook writes, prune-session-spawns.sh reaps) must share the new root.
  ls "${GA_DATA}/agent-tool-budget/"* >/dev/null 2>&1 || { echo "counter not written under new default" >&2; return 1; }
}

@test "enforce-verification-gate.sh: no override → PostToolUse stamps \$HOME/.glass-atrium/data/session-spawns" {
  local hook="${HOOKS_DIR}/enforce-verification-gate.sh"
  [[ -x "${hook}" ]] || skip "hook not executable: ${hook}"
  local payload='{"hook_event_name":"PostToolUse","tool_name":"Agent","session_id":"sess-vg","tool_input":{"subagent_type":"glass-atrium-dev-shell"}}'

  run env -u GA_DATA_ROOT -u HOOK_DATA_DIR HOME="${SANDBOX}" \
    bash -c 'printf "%s" "$1" | "$2"' _ "${payload}" "${hook}"

  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ -f "${GA_DATA}/session-spawns/sess-vg" ]] || { echo "marker not stamped under new default" >&2; return 1; }
  grep -qx "glass-atrium-dev-shell" "${GA_DATA}/session-spawns/sess-vg" || { echo "marker content wrong" >&2; return 1; }
}

@test "enforce-workflow-verify-stage.sh: no override → firing trace lands at \$HOME/.glass-atrium/data/workflow-gate-fired.log" {
  local hook="${HOOKS_DIR}/enforce-workflow-verify-stage.sh"
  [[ -x "${hook}" ]] || skip "hook not executable: ${hook}"
  # Non-DEV reporter workflow → gate passes and emit_trace appends one 'pass' line.
  local payload
  payload="$(jq -n --arg s "pipeline(agent('glass-atrium-intel-reporter',{goal:'read background'}))" \
    '{tool_name:"Workflow",tool_input:{script:$s}}')"

  run env -u GA_DATA_ROOT -u WORKFLOW_GATE_FIRED_LOG HOME="${SANDBOX}" \
    bash -c 'printf "%s" "$1" | "$2"' _ "${payload}" "${hook}"

  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ -f "${GA_DATA}/workflow-gate-fired.log" ]] || { echo "trace not appended to new default log" >&2; return 1; }
}

@test "block-doc-routing-leak.sh: no override → firing trace lands at \$HOME/.glass-atrium/data/doc-routing-leak-fired.log" {
  local hook="${HOOKS_DIR}/block-doc-routing-leak.sh"
  [[ -x "${hook}" ]] || skip "hook not executable: ${hook}"

  run env -u GA_DATA_ROOT -u DOC_ROUTING_LEAK_FIRED_LOG HOME="${SANDBOX}" \
    ATRIUM_MONITOR_PORT="16145" CLAUDED_DOCS_HTML_ROOT="${SANDBOX}/monitor-root" \
    bash -c 'printf "%s" "$1" | "$2"' _ '{"tool_name":"Edit","agent_id":"reporter1"}' "${hook}"

  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ -f "${GA_DATA}/doc-routing-leak-fired.log" ]] || { echo "trace not appended to new default log" >&2; return 1; }
}

@test "post-edit-typecheck.sh: no override → PostToolUse marker lands at \$HOME/.glass-atrium/data" {
  local hook="${HOOKS_DIR}/post-edit-typecheck.sh"
  [[ -x "${hook}" ]] || skip "hook not executable: ${hook}"
  command -v git >/dev/null 2>&1 || skip "git not on PATH"
  # record_marker resolves PROJECT_ROOT from the file's git top-level, so the .ts edit must sit in a repo.
  local repo="${SANDBOX}/proj"
  mkdir -p "${repo}"
  git -C "${repo}" init -q
  local payload
  payload="$(jq -n --arg fp "${repo}/app.ts" \
    '{hook_event_name:"PostToolUse",tool_name:"Edit",session_id:"sess-tc",tool_input:{file_path:$fp}}')"

  run env -u GA_DATA_ROOT -u TYPECHECK_MARKER_DIR HOME="${SANDBOX}" \
    bash -c 'printf "%s" "$1" | "$2"' _ "${payload}" "${hook}"

  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ -f "${GA_DATA}/typecheck-pending_sess-tc.json" ]] || { echo "marker not written under new default" >&2; return 1; }
}

@test "post-edit-typecheck.sh: TYPECHECK_MARKER_DIR override wins over the default seam" {
  local hook="${HOOKS_DIR}/post-edit-typecheck.sh"
  [[ -x "${hook}" ]] || skip "hook not executable: ${hook}"
  command -v git >/dev/null 2>&1 || skip "git not on PATH"
  local repo="${SANDBOX}/proj" override="${SANDBOX}/override-markers"
  mkdir -p "${repo}" "${override}"
  git -C "${repo}" init -q
  local payload
  payload="$(jq -n --arg fp "${repo}/app.ts" \
    '{hook_event_name:"PostToolUse",tool_name:"Edit",session_id:"sess-ov",tool_input:{file_path:$fp}}')"

  run env -u GA_DATA_ROOT HOME="${SANDBOX}" TYPECHECK_MARKER_DIR="${override}" \
    bash -c 'printf "%s" "$1" | "$2"' _ "${payload}" "${hook}"

  [[ "${status}" -eq 0 ]] || { echo "status=${status} output=${output}" >&2; return 1; }
  [[ -f "${override}/typecheck-pending_sess-ov.json" ]] || { echo "override marker not written" >&2; return 1; }
  [[ ! -f "${GA_DATA}/typecheck-pending_sess-ov.json" ]] || { echo "default path wrongly written despite override" >&2; return 1; }
}
