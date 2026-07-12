#!/usr/bin/env bats
# block-doc-routing-leak.sh — verdict/exit-code parity + single-pass field-batch perf coverage.
#
# Pins the block/pass verdict and exit code on EVERY path after the T6b migration that folded
# the transcript_path + session_id reads into one hook_get_fields batch call (was two separate
# hook_get_field calls). Both fields sit AFTER the tool_name/agent_id/agent_key early-exits and
# have no early-exit between them, so the batch cannot read a field an early-exit would skip —
# these tests prove every early-exit branch and both allowlist/block verdicts stay byte-identical.
#
# Run via: bats hooks/test/block-doc-routing-leak.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3, jq (sidecar recovery).
#
# Hermetic strategy: no live monitor/DB touched. ATRIUM_MONITOR_PORT is pinned so the port
# resolver never sources atrium-config.sh (keeps the python3 spawn count deterministic), the
# firing-trace log is redirected into the sandbox, and agent_type recovery is driven by a
# sandbox-local .meta.json sidecar (transcript-dirname co-location OR the session_id glob).

HOOK_SH="${BATS_TEST_DIRNAME}/../block-doc-routing-leak.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  SANDBOX="$(mktemp -d -t ga-docleak-bats.XXXXXX)"
  FIRED_LOG="${SANDBOX}/fired.log"
  INPUT_JSON="${SANDBOX}/input.json"
  mkdir -p "${SANDBOX}/tx"
}

teardown() {
  [[ -n "${SANDBOX:-}" && -d "${SANDBOX}" ]] && rm -rf -- "${SANDBOX}"
}

# Write a transcript-co-located sidecar. Args: $1=agent_key $2=agentType.
seed_sidecar_transcript() {
  printf '{"agentType":"%s"}\n' "$2" >"${SANDBOX}/tx/agent-$1.meta.json"
}

# Run the hook hermetically. Args: $1=input JSON. Extra env pairs may follow as $2..$N (VAR=val).
run_hook() {
  local input="$1"
  shift
  printf '%s' "${input}" >"${INPUT_JSON}"
  run env \
    ATRIUM_MONITOR_PORT="16145" \
    DOC_ROUTING_LEAK_FIRED_LOG="${FIRED_LOG}" \
    CLAUDED_DOCS_HTML_ROOT="${SANDBOX}/monitor-root" \
    "$@" \
    bash "${HOOK_SH}" <"${INPUT_JSON}"
}

# ── Early-exit branches BEFORE the batch (transcript/session never reached) ──────────────

@test "E1 non-Write tool → allow (exit 0)" {
  run_hook '{"tool_name":"Edit","agent_id":"reporter1"}'
  [[ "${status}" -eq 0 ]] || return 1
  grep -q 'verdict=allow-non-write' "${FIRED_LOG}" || return 1
}

@test "E2 Write with no agent_id → fail-open (exit 0)" {
  run_hook '{"tool_name":"Write"}'
  [[ "${status}" -eq 0 ]] || return 1
  grep -q 'verdict=fail-open-no-agent-id' "${FIRED_LOG}" || return 1
}

@test "E3 Write with a fully-stripped agent_id → fail-open (exit 0)" {
  # agent_id "///" reduces to an empty path-safe key → early-exit before the batch.
  run_hook '{"tool_name":"Write","agent_id":"///"}'
  [[ "${status}" -eq 0 ]] || return 1
  grep -q 'verdict=fail-open-bad-agent-id' "${FIRED_LOG}" || return 1
}

# ── Paths that REACH the batch (verdict depends on transcript_path/session_id extraction) ─

@test "E4 Write + valid agent_id but no recoverable agent_type → fail-open (exit 0)" {
  # Reaches the batch; no sidecar exists → recovery empty → fail-open. Proves the batched
  # transcript_path/session_id feed recovery without crashing when both resolve to nothing.
  run_hook "{\"tool_name\":\"Write\",\"agent_id\":\"reporter1\",\"transcript_path\":\"${SANDBOX}/tx/transcript.jsonl\",\"session_id\":\"sess-abc\"}"
  [[ "${status}" -eq 0 ]] || return 1
  grep -q 'verdict=fail-open-no-agent-type' "${FIRED_LOG}" || return 1
}

@test "E5 Write + non-doc agent recovered via sidecar → allow-non-doc-agent (exit 0)" {
  command -v jq >/dev/null 2>&1 || skip "jq required for sidecar recovery"
  seed_sidecar_transcript "reporter1" "glass-atrium-dev-shell"
  run_hook "{\"tool_name\":\"Write\",\"agent_id\":\"reporter1\",\"transcript_path\":\"${SANDBOX}/tx/transcript.jsonl\",\"session_id\":\"sess-abc\"}"
  [[ "${status}" -eq 0 ]] || return 1
  grep -q 'verdict=allow-non-doc-agent' "${FIRED_LOG}" || return 1
}

@test "E6 Write + doc agent + empty file_path → fail-open (exit 0)" {
  command -v jq >/dev/null 2>&1 || skip "jq required for sidecar recovery"
  seed_sidecar_transcript "reporter1" "glass-atrium-intel-reporter"
  run_hook "{\"tool_name\":\"Write\",\"agent_id\":\"reporter1\",\"transcript_path\":\"${SANDBOX}/tx/transcript.jsonl\",\"tool_input\":{\"file_path\":\"\"}}"
  [[ "${status}" -eq 0 ]] || return 1
  grep -q 'verdict=fail-open-no-file-path' "${FIRED_LOG}" || return 1
}

@test "E7 Write + doc agent + non-target extension → allow-non-target-ext (exit 0)" {
  command -v jq >/dev/null 2>&1 || skip "jq required for sidecar recovery"
  seed_sidecar_transcript "reporter1" "glass-atrium-intel-reporter"
  run_hook "{\"tool_name\":\"Write\",\"agent_id\":\"reporter1\",\"transcript_path\":\"${SANDBOX}/tx/transcript.jsonl\",\"tool_input\":{\"file_path\":\"/Users/nobody/x.py\"}}"
  [[ "${status}" -eq 0 ]] || return 1
  grep -q 'verdict=allow-non-target-ext' "${FIRED_LOG}" || return 1
}

@test "ALLOW doc agent writing under memory/progress → allow (exit 0)" {
  command -v jq >/dev/null 2>&1 || skip "jq required for sidecar recovery"
  seed_sidecar_transcript "reporter1" "glass-atrium-intel-planner"
  run_hook "{\"tool_name\":\"Write\",\"agent_id\":\"reporter1\",\"transcript_path\":\"${SANDBOX}/tx/transcript.jsonl\",\"tool_input\":{\"file_path\":\"/proj/memory/progress-task.md\"}}"
  [[ "${status}" -eq 0 ]] || return 1
  grep -q 'verdict=allow-memory-progress' "${FIRED_LOG}" || return 1
}

@test "BLOCK doc agent (transcript sidecar) writing a non-allowlisted .md → block (exit 2)" {
  # Full path through the batch. agent_type recovered from the transcript-co-located sidecar
  # proves transcript_path is extracted byte-identically by the batch call.
  command -v jq >/dev/null 2>&1 || skip "jq required for sidecar recovery"
  seed_sidecar_transcript "reporter1" "glass-atrium-intel-reporter"
  run_hook "{\"tool_name\":\"Write\",\"agent_id\":\"reporter1\",\"transcript_path\":\"${SANDBOX}/tx/transcript.jsonl\",\"tool_input\":{\"file_path\":\"/Users/nobody/reports/leak.md\"}}"
  [[ "${status}" -eq 2 ]] || return 1
  grep -q 'verdict=block' "${FIRED_LOG}" || return 1
  [[ "${output}" == *'DOC-001'* ]] || return 1
}

@test "BLOCK doc agent recovered via session_id glob → block (exit 2)" {
  # transcript_path absent → recovery falls to the session_id glob under HOME/.claude/projects.
  # Proves session_id is extracted byte-identically by the batch (the SECOND batched field).
  command -v jq >/dev/null 2>&1 || skip "jq required for sidecar recovery"
  local glob_dir="${SANDBOX}/home/.claude/projects/proj1/sess-xyz/subagents"
  mkdir -p "${glob_dir}"
  printf '{"agentType":"glass-atrium-intel-planner"}\n' >"${glob_dir}/agent-reporter1.meta.json"
  run_hook "{\"tool_name\":\"Write\",\"agent_id\":\"reporter1\",\"session_id\":\"sess-xyz\",\"tool_input\":{\"file_path\":\"/Users/nobody/reports/leak.md\"}}" \
    HOME="${SANDBOX}/home"
  [[ "${status}" -eq 2 ]] || return 1
  grep -q 'verdict=block' "${FIRED_LOG}" || return 1
}

# ── Perf-invariant: the batch collapses transcript+session into one python3 cold-start ────

@test "PERF full block path spawns exactly 4 python3 (transcript+session batched into one)" {
  # Pre-migration this path spawned 5 (tool_name, agent_id, transcript_path, session_id,
  # file_path). The batch folds transcript_path+session_id into one call → 4. A revert to two
  # separate reads raises the count to 5 and fails this guard. ATRIUM_MONITOR_PORT pins the
  # port resolver so no config-sourcing python3 spawn perturbs the count.
  command -v jq >/dev/null 2>&1 || skip "jq required for sidecar recovery"
  local real_py stub_bin py_calls
  real_py="$(command -v python3)"
  stub_bin="${SANDBOX}/bin"
  py_calls="${SANDBOX}/py-calls"
  mkdir -p "${stub_bin}"
  {
    printf '#!/bin/bash\n'
    printf 'printf "x\\n" >>"%s"\n' "${py_calls}"
    printf 'exec "%s" "$@"\n' "${real_py}"
  } >"${stub_bin}/python3"
  chmod +x "${stub_bin}/python3"

  seed_sidecar_transcript "reporter1" "glass-atrium-intel-reporter"
  run_hook "{\"tool_name\":\"Write\",\"agent_id\":\"reporter1\",\"transcript_path\":\"${SANDBOX}/tx/transcript.jsonl\",\"session_id\":\"sess-abc\",\"tool_input\":{\"file_path\":\"/Users/nobody/reports/leak.md\"}}" \
    PATH="${stub_bin}:${PATH}"
  [[ "${status}" -eq 2 ]] || return 1
  local n=0
  [[ -f "${py_calls}" ]] && n="$(wc -l <"${py_calls}" | tr -d ' ')"
  [[ "${n}" -eq 4 ]] || {
    printf 'expected 4 python3 spawns, got %s\n' "${n}" >&2
    return 1
  }
}
