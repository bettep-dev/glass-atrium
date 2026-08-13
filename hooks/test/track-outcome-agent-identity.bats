#!/usr/bin/env bats
# track-outcome-agent-identity.bats — W1-B of clauded-docs/1461: the recorder must resolve the
# REGISTERED agent type for a teammate-class spawn.
#
# A teammate sidecar carries the ephemeral instance name in agentType and the registered type in
# customAgentType, and the recovery path that would repair this was gated on an ABSENT envelope
# type — so a teammate envelope, which always carries its ephemeral name, never reached recovery
# and recorded an unregistered identity the ingest allowlist then dropped.
#
# Isolation: HOME is sandboxed, the registry is pointed at a fixture through the same env override
# the aggregator uses, and the dual-write is stubbed by a PATH python3 shim that exits non-zero, so
# the outcome envelope dead-letters into a sandboxed spool dir — that spooled JSON is the assertion
# surface and no live Postgres is touched. Sidecars are reached through the co-located-with-
# transcript-path branch; the home-directory glob branch is not exercised.
#
# CID: 2026-08-13T1230_grader-attribution-impl_r9m5

HOOK_SH="${TRACK_OUTCOME_SH:-${BATS_TEST_DIRNAME}/../track-outcome.sh}"

REGISTERED="glass-atrium-dev-shell"
TEAMMATE_REGISTERED="glass-atrium-qa-code-reviewer"
EPHEMERAL="ashell-impl-opus-980cfc838657ba29"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "track-outcome.sh not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  REAL_PY3="$(command -v python3)"
  ID_TMP="$(mktemp -d -t track-id.XXXXXX)"
  AGENT_ID="idaid${$}x${RANDOM}"
  SESSION_ID="sess-id-$$-${RANDOM}"

  SANDBOX_HOME="${ID_TMP}/home"
  TRANSCRIPT_DIR="${SANDBOX_HOME}/.claude/projects/proj/${SESSION_ID}/subagents"
  mkdir -p "${TRANSCRIPT_DIR}" "${SANDBOX_HOME}/.claude/logs"
  SPOOL_DIR="${SANDBOX_HOME}/.claude/data/outcome-spool"
  TRANSCRIPT="${TRANSCRIPT_DIR}/agent-${AGENT_ID}.jsonl"
  SIDECAR="${TRANSCRIPT_DIR}/agent-${AGENT_ID}.meta.json"
  PAYLOAD_FILE="${ID_TMP}/payload.json"
  REGISTRY="${ID_TMP}/agent-registry.json"

  jq -nc --arg a "${REGISTERED}" --arg b "${TEAMMATE_REGISTERED}" \
    '{version: "1", agents: {($a): {scope: "DEV"}, ($b): {scope: "QA"}}}' >"${REGISTRY}"

  SHIM_DIR="${ID_TMP}/bin"
  mkdir -p "${SHIM_DIR}"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf '%s\n' 'for _a in "$@"; do'
    printf '%s\n' '  case "${_a}" in'
    printf '%s\n' '    *_pg_outcome_dualwrite.py) cat >/dev/null; exit 6 ;;'
    printf '%s\n' '  esac'
    printf '%s\n' 'done'
    printf '%s\n' "exec \"${REAL_PY3}\" \"\$@\""
  } >"${SHIM_DIR}/python3"
  chmod +x "${SHIM_DIR}/python3"

  write_transcript
}

teardown() {
  [[ -n "${ID_TMP:-}" && -d "${ID_TMP}" ]] && rm -rf -- "${ID_TMP}" || true
}

# Subagent transcript carrying one tool_use (deliverable-producing) and a writer [COMPLETION].
write_transcript() {
  "${REAL_PY3}" - "${TRANSCRIPT}" <<'PY'
import json, sys
block = "\n".join([
    "[COMPLETION]", "result: done", "task_type: cleanup", "metric_pass: true",
    "confidence: high", "summary: tidied the imports", "[/COMPLETION]"])
rows = [
    {"type": "user", "message": {"role": "user", "content": "do the work"}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "tool_use", "id": "toolu_id_1", "name": "Bash",
                     "input": {"command": "true"}}]}},
    {"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": "toolu_id_1", "content": "ok"}]}},
    {"type": "assistant", "message": {"role": "assistant",
        "content": [{"type": "text", "text": block}]}},
]
with open(sys.argv[1], "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
PY
}

# $1 = envelope agent_type ("" ⇒ key omitted, the pre-existing absent-type gap).
write_payload() {
  jq -nc --arg aid "${AGENT_ID}" --arg agent "${1}" --arg sess "${SESSION_ID}" \
    --arg tp "${TRANSCRIPT}" '{
      hook_event_name: "SubagentStop",
      agent_id: $aid,
      session_id: $sess,
      transcript_path: $tp
    } + (if $agent == "" then {} else {agent_type: $agent} end)' >"${PAYLOAD_FILE}"
}

# Sidecar in the observed teammate shape. $1 = agentType, $2 = customAgentType ("" ⇒ null),
# $3 = taskKind.
write_sidecar() {
  jq -nc --arg at "${1}" --arg ct "${2}" --arg tk "${3}" '{
    agentType: $at,
    customAgentType: (if $ct == "" then null else $ct end),
    taskKind: $tk,
    agentId: null,
    model: "opus",
    name: "seat"
  }' >"${SIDECAR}"
}

# $1 = registry path override (defaults to the fixture registry).
run_hook() {
  run env \
    HOME="${SANDBOX_HOME}" \
    PATH="${SHIM_DIR}:${PATH}" \
    CLAUDE_AGENT_REGISTRY_FILE="${1:-${REGISTRY}}" \
    CLAUDE_GATE_INFLIGHT="" \
    T9_CORRECTION_DETECTION="false" \
    OUTCOME_SPOOL_DIR="${SPOOL_DIR}" \
    bash -c '"$1" < "$2" 2>&1' _ "${HOOK_SH}" "${PAYLOAD_FILE}"
}

spooled_field() {
  local f
  f="$(find "${SPOOL_DIR}" -type f 2>/dev/null | head -1)"
  [[ -n "${f}" ]] || return 1
  jq -r ".outcome.${1} // \"\"" "${f}"
}

# ---------------------------------------------------------------------------
# AC-3.1 / AC-3.2 — the teammate gap
# ---------------------------------------------------------------------------

@test "teammate sidecar records the registered type, not the ephemeral instance name" {
  write_sidecar "${EPHEMERAL}" "${TEAMMATE_REGISTERED}" "in_process_teammate"
  write_payload "${EPHEMERAL}"
  run_hook
  [[ "$(spooled_field agent)" == "${TEAMMATE_REGISTERED}" ]]
}

@test "a present-but-unregistered envelope type reaches sidecar recovery with a diagnostic" {
  write_sidecar "${EPHEMERAL}" "${TEAMMATE_REGISTERED}" "in_process_teammate"
  write_payload "${EPHEMERAL}"
  run_hook
  [[ "${output}" == *"agent_type recovered from sidecar: ${TEAMMATE_REGISTERED}"* ]]
}

# ---------------------------------------------------------------------------
# AC-3.3 — preservation, including the counterexample shape observed on disk
# ---------------------------------------------------------------------------

@test "normal-subagent sidecar (customAgentType null) still records the agentType value" {
  write_sidecar "${REGISTERED}" "" "subagent"
  write_payload ""
  run_hook
  [[ "$(spooled_field agent)" == "${REGISTERED}" ]]
}

@test "teammate task kind WITHOUT a registered-type key falls back to agentType" {
  # 12 such sidecars exist in the live corpus — the task kind is not a hard gate.
  "${REAL_PY3}" - "${SIDECAR}" "${REGISTERED}" <<'PY'
import json, sys
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump({"agentType": sys.argv[2], "taskKind": "in_process_teammate"}, f)
PY
  write_payload ""
  run_hook
  [[ "$(spooled_field agent)" == "${REGISTERED}" ]]
}

@test "a registry-resolvable envelope type is recorded verbatim (no recovery attempted)" {
  write_sidecar "${EPHEMERAL}" "${TEAMMATE_REGISTERED}" "in_process_teammate"
  write_payload "${REGISTERED}"
  run_hook
  [[ "$(spooled_field agent)" == "${REGISTERED}" ]] \
    && [[ "${output}" != *"agent_type recovered from sidecar"* ]]
}

# ---------------------------------------------------------------------------
# AC-3.4 — fail-open on an unusable registry
# ---------------------------------------------------------------------------

@test "absent registry skips validation and still records the row" {
  write_sidecar "${EPHEMERAL}" "${TEAMMATE_REGISTERED}" "in_process_teammate"
  write_payload "${EPHEMERAL}"
  run_hook "${ID_TMP}/nonexistent-registry.json"
  [[ "$(spooled_field agent)" == "${EPHEMERAL}" ]]
}

@test "malformed registry skips validation and still records the row" {
  printf '%s' '{not json' >"${ID_TMP}/malformed.json"
  write_sidecar "${EPHEMERAL}" "${TEAMMATE_REGISTERED}" "in_process_teammate"
  write_payload "${EPHEMERAL}"
  run_hook "${ID_TMP}/malformed.json"
  [[ "$(spooled_field agent)" == "${EPHEMERAL}" ]]
}

# ---------------------------------------------------------------------------
# AC-3.8 — one unregistered name is never rewritten into another
# ---------------------------------------------------------------------------

@test "unregistered recovered value is discarded and the envelope identity retained" {
  write_sidecar "${EPHEMERAL}" "asecond-unregistered-name" "in_process_teammate"
  write_payload "${EPHEMERAL}"
  run_hook
  [[ "$(spooled_field agent)" == "${EPHEMERAL}" ]] \
    && [[ "$(spooled_field agent)" != "subagent_stop_missing" ]] \
    && [[ "${output}" == *"sidecar recovery discarded"* ]]
}
