#!/usr/bin/env bats
# t12-silent-fail-triage.bats — pins two of T12's three frozen-manifest silent-fail sites, each of
# which formerly swallowed an anomalous failure with no operator signal:
#
#   Site A (cross-hook/cross-session state persistence) — enforce-verification-gate.sh PostToolUse
#     marker append. The line was `printf ... >>"${marker_path}" 2>/dev/null || true`; a write failure
#     silently lost the spawn-success signal that a LATER session's reviewer-presence gate AND
#     advisory-spawn-budget.sh both read. Now emits VGATE-STAMP-001, exit unchanged (0).
#
#   Site B (gate-evaluation) — enforce-workflow-verify-stage.sh verdict-helper call. The `||` branch
#     fires only when the python3 verdict engine cannot run (crash / interpreter failure — presence is
#     checked upstream), silently defaulting the gate to fail-open PASS. Now emits WFG-VERDICT-FAILOPEN,
#     fail-open verdict + exit unchanged (0).
#
# Both hooks are invoked as a DIRECT command (via the hook path / shebang), never interpreter-prefixed.
# Site C (track-outcome.sh spool write-failure → DATA-080) is pinned in
# track-outcome-spool-circuit-breaker.bats, which already carries the DB-outage spool harness.

# VGATE_SH / WFG_SH let a fail-at-HEAD run point the same suite at a pre-fix hook copy.
HOOK_VGATE="${VGATE_SH:-${BATS_TEST_DIRNAME}/../enforce-verification-gate.sh}"
HOOK_WFG="${WFG_SH:-${BATS_TEST_DIRNAME}/../enforce-workflow-verify-stage.sh}"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  T12_TMP="$(mktemp -d -t t12-triage.XXXXXX)"
  DATA_DIR="${T12_TMP}/data"
  mkdir -p "${DATA_DIR}/session-spawns"
  PAYLOAD="${T12_TMP}/payload.json"
}

teardown() {
  # session-spawns marker may be pre-seeded as a dir with restricted perms — restore before rm.
  [[ -n "${T12_TMP:-}" && -d "${T12_TMP}" ]] && chmod -R u+rwx "${T12_TMP}" 2>/dev/null
  [[ -n "${T12_TMP:-}" && -d "${T12_TMP}" ]] && rm -rf -- "${T12_TMP}" || true
}

# ---------------------------------------------------------------------------
# Site A — enforce-verification-gate.sh cross-hook marker append
# ---------------------------------------------------------------------------

# Drive the gate with a PostToolUse(Agent) spawn-success envelope. session_id is chosen so its
# path-safe key is byte-identical (all [A-Za-z0-9_-]), making the marker path deterministic.
seed_postuse_payload() {
  jq -nc --arg sid "sessT12A" --arg t "glass-atrium-dev-shell" --arg p "spawn body" \
    '{hook_event_name:"PostToolUse",tool_name:"Agent",session_id:$sid,
      tool_input:{subagent_type:$t,prompt:$p}}' >"${PAYLOAD}"
}

@test "Site A: marker append failure emits VGATE-STAMP-001 (cross-hook state), exit stays 0" {
  [[ -x "${HOOK_VGATE}" ]] || skip "enforce-verification-gate.sh not executable"
  seed_postuse_payload
  # Force the append to fail deterministically: pre-create the marker PATH as a directory so the
  # `>>"${marker_path}"` redirect cannot open it as a file.
  mkdir -p "${DATA_DIR}/session-spawns/sessT12A"

  run env HOOK_DATA_DIR="${DATA_DIR}" bash -c '"$1" < "$2" 2>&1' _ "${HOOK_VGATE}" "${PAYLOAD}"

  [ "${status}" -eq 0 ] || { echo "expected exit 0, got ${status}: ${output}"; return 1; }
  echo "${output}" | grep -qF "VGATE-STAMP-001" || {
    echo "expected VGATE-STAMP-001 named code on the failed cross-hook write; got: ${output}"
    return 1
  }
}

@test "Site A: successful marker append stays silent (no VGATE-STAMP-001) and exits 0" {
  [[ -x "${HOOK_VGATE}" ]] || skip "enforce-verification-gate.sh not executable"
  seed_postuse_payload
  run env HOOK_DATA_DIR="${DATA_DIR}" bash -c '"$1" < "$2" 2>&1' _ "${HOOK_VGATE}" "${PAYLOAD}"

  [ "${status}" -eq 0 ] || { echo "expected exit 0, got ${status}: ${output}"; return 1; }
  ! echo "${output}" | grep -qF "VGATE-STAMP-001" || {
    echo "success path must not emit the named code; got: ${output}"
    return 1
  }
  grep -qx "glass-atrium-dev-shell" "${DATA_DIR}/session-spawns/sessT12A" || {
    echo "marker line was not persisted on the success path"
    return 1
  }
}

# ---------------------------------------------------------------------------
# Site B — enforce-workflow-verify-stage.sh verdict-helper crash
# ---------------------------------------------------------------------------

@test "Site B: verdict-helper crash emits WFG-VERDICT-FAILOPEN, gate stays fail-open PASS (exit 0)" {
  [[ -x "${HOOK_WFG}" ]] || skip "enforce-workflow-verify-stage.sh not executable"
  # python3 shim: present on PATH so the upstream `command -v python3` presence check passes, but any
  # ACTUAL run exits non-zero — reproducing an interpreter crash exactly at the verdict-helper call.
  local shim_dir="${T12_TMP}/bin"
  mkdir -p "${shim_dir}"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 1' >"${shim_dir}/python3"
  chmod +x "${shim_dir}/python3"

  # A DEV-spawning workflow script — non-empty so the gate reaches the verdict helper (an empty script
  # short-circuits to a no-inspect PASS before the helper runs).
  local script="pipeline(agent('glass-atrium-dev-shell'));"
  jq -nc --arg s "${script}" '{tool_name:"Workflow",tool_input:{script:$s}}' >"${PAYLOAD}"

  run env PATH="${shim_dir}:${PATH}" WORKFLOW_GATE_FIRED_LOG="${T12_TMP}/wfg.log" \
    bash -c '"$1" < "$2" 2>&1' _ "${HOOK_WFG}" "${PAYLOAD}"

  [ "${status}" -eq 0 ] || { echo "expected fail-open exit 0, got ${status}: ${output}"; return 1; }
  echo "${output}" | grep -qF "WFG-VERDICT-FAILOPEN" || {
    echo "expected WFG-VERDICT-FAILOPEN named code on the disarmed gate; got: ${output}"
    return 1
  }
}
