#!/usr/bin/env bats
# advisory-subagent-budget.sh — overage-recording (record-and-continue) coverage.
#
# Proves the durable-signal path added on top of the STDERR advisory: a best-effort
# core.budget_overages row is emitted EXACTLY at each budget crossing — the 100%
# crossing (count == budget) then every floor(budget/5) tool_uses beyond (min 1 step).
# All assertions are pinned to the DEFAULT budget 40 (crossings 40, 48, 56, ...).
#
# Run via: bats hooks/test/advisory-subagent-budget-overage.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3
#
# Hermetic strategy: no live DB is touched. The PG writer is replaced by a stub
# (SUBAGENT_OVERAGE_WRITER PATH shim) that records each invocation + captures the
# emitted row JSON, and the per-agent counter dir is redirected (SUBAGENT_TOOL_BUDGET_DIR)
# so the counter can be pre-seeded to a value just below the crossing under test.

HOOK_SH="${BATS_TEST_DIRNAME}/../advisory-subagent-budget.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  SANDBOX="$(mktemp -d -t ga-overage-bats.XXXXXX)"
  BUDGET_DIR="${SANDBOX}/counters"
  OVERAGE_MARKER="${SANDBOX}/writer-calls"
  OVERAGE_ROWS="${SANDBOX}/writer-rows"
  STUB_WRITER="${SANDBOX}/stub-writer.sh"
  mkdir -p "${BUDGET_DIR}"
  # stub writer: capture the row JSON (stdin) + append one line per invocation.
  {
    printf '#!/bin/bash\n'
    printf 'cat >>"%s"\n' "${OVERAGE_ROWS}"
    printf 'printf "called\\n" >>"%s"\n' "${OVERAGE_MARKER}"
    printf 'exit 0\n'
  } >"${STUB_WRITER}"
  chmod +x "${STUB_WRITER}"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# Pre-seed the per-agent counter. Args: $1=agent_key $2=value.
seed_counter() {
  printf '%s\n' "$2" >"${BUDGET_DIR}/$1"
}

# Count writer invocations (0 when the marker file is absent — avoids the grep -c zero trap).
writer_calls() {
  [[ -f "${OVERAGE_MARKER}" ]] || {
    printf '0\n'
    return 0
  }
  wc -l <"${OVERAGE_MARKER}" | tr -d ' '
}

# Run the hook with the stub writer + redirected counter dir. Args: $1=input JSON.
run_hook() {
  printf '%s' "$1" >"${SANDBOX}/input.json"
  run env \
    SUBAGENT_TOOL_BUDGET_DIR="${BUDGET_DIR}" \
    SUBAGENT_OVERAGE_WRITER="${STUB_WRITER}" \
    bash "${HOOK_SH}" <"${SANDBOX}/input.json"
}

@test "no overage row below the budget (count 31 of 40)" {
  seed_counter "agent-a" 30
  run_hook '{"agent_id":"agent-a"}'
  [[ "${status}" -eq 0 ]]
  [[ "$(writer_calls)" -eq 0 ]]
}

@test "one overage row at the 100% crossing (count 40) with crossed_pct 100" {
  seed_counter "agent-a" 39
  run_hook '{"agent_id":"agent-a"}'
  [[ "${status}" -eq 0 ]]
  [[ "$(writer_calls)" -eq 1 ]]
  grep -q '"tool_use_count": 40' "${OVERAGE_ROWS}"
  grep -q '"budget": 40' "${OVERAGE_ROWS}"
  grep -q '"crossed_pct": 100' "${OVERAGE_ROWS}"
  # agent_type unrecoverable (no transcript/session) → JSON null fallback
  grep -q '"agent_type": null' "${OVERAGE_ROWS}"
  grep -q '"agent_id": "agent-a"' "${OVERAGE_ROWS}"
}

@test "no overage row between crossings (count 41 of 40)" {
  seed_counter "agent-a" 40
  run_hook '{"agent_id":"agent-a"}'
  [[ "${status}" -eq 0 ]]
  [[ "$(writer_calls)" -eq 0 ]]
}

@test "one overage row at the first floor(budget/5) step (count 48) with crossed_pct 120" {
  seed_counter "agent-a" 47
  run_hook '{"agent_id":"agent-a"}'
  [[ "${status}" -eq 0 ]]
  [[ "$(writer_calls)" -eq 1 ]]
  grep -q '"tool_use_count": 48' "${OVERAGE_ROWS}"
  grep -q '"crossed_pct": 120' "${OVERAGE_ROWS}"
}

@test "one overage row at the second step (count 56) with crossed_pct 140" {
  seed_counter "agent-a" 55
  run_hook '{"agent_id":"agent-a"}'
  [[ "${status}" -eq 0 ]]
  [[ "$(writer_calls)" -eq 1 ]]
  grep -q '"tool_use_count": 56' "${OVERAGE_ROWS}"
  grep -q '"crossed_pct": 140' "${OVERAGE_ROWS}"
}

@test "no overage row just before a step (count 55 of 40)" {
  seed_counter "agent-a" 54
  run_hook '{"agent_id":"agent-a"}'
  [[ "${status}" -eq 0 ]]
  [[ "$(writer_calls)" -eq 0 ]]
}

@test "agent_type resolved from the .meta.json sidecar populates the row" {
  command -v jq >/dev/null 2>&1 || skip "jq required for sidecar recovery"
  mkdir -p "${SANDBOX}/tx"
  printf '{"agentType":"glass-atrium-dev-shell"}\n' \
    >"${SANDBOX}/tx/agent-agent-b.meta.json"
  seed_counter "agent-b" 39
  printf '%s' \
    "{\"agent_id\":\"agent-b\",\"transcript_path\":\"${SANDBOX}/tx/transcript.jsonl\"}" \
    >"${SANDBOX}/input.json"
  run env \
    SUBAGENT_TOOL_BUDGET_DIR="${BUDGET_DIR}" \
    SUBAGENT_OVERAGE_WRITER="${STUB_WRITER}" \
    bash "${HOOK_SH}" <"${SANDBOX}/input.json"
  [[ "${status}" -eq 0 ]]
  [[ "$(writer_calls)" -eq 1 ]]
  grep -q '"agent_type": "glass-atrium-dev-shell"' "${OVERAGE_ROWS}"
}

@test "a failing writer never fails the hook (best-effort, exit 0 preserved)" {
  # writer exits non-zero; the crossing still occurs but recording is best-effort.
  printf '#!/bin/bash\ncat >/dev/null\nexit 1\n' >"${STUB_WRITER}"
  chmod +x "${STUB_WRITER}"
  seed_counter "agent-a" 39
  run_hook '{"agent_id":"agent-a"}'
  [[ "${status}" -eq 0 ]]
}

@test "the 70/80% STDERR advisory still fires and does NOT emit an overage row" {
  # count 32 == 80% of 40: STDERR advisory fires, but 32 < 40 so no overage row.
  seed_counter "agent-a" 31
  run_hook '{"agent_id":"agent-a"}'
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"80%"* ]]
  [[ "$(writer_calls)" -eq 0 ]]
}

@test "kill switch disables recording even at a crossing" {
  seed_counter "agent-a" 39
  printf '%s' '{"agent_id":"agent-a"}' >"${SANDBOX}/input.json"
  run env \
    SUBAGENT_TOOL_BUDGET_OFF=1 \
    SUBAGENT_TOOL_BUDGET_DIR="${BUDGET_DIR}" \
    SUBAGENT_OVERAGE_WRITER="${STUB_WRITER}" \
    bash "${HOOK_SH}" <"${SANDBOX}/input.json"
  [[ "${status}" -eq 0 ]]
  [[ "$(writer_calls)" -eq 0 ]]
}

@test "main-session call (no agent_id) records nothing" {
  run_hook '{}'
  [[ "${status}" -eq 0 ]]
  [[ "$(writer_calls)" -eq 0 ]]
}
