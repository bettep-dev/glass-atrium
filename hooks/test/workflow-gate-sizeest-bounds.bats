#!/usr/bin/env bats
# workflow-gate-sizeest-bounds.bats — pins the [SIZE-EST] plausibility-bounds ADVISORY added to
#   enforce-workflow-verify-stage.sh: the declared DEV-mode tool_uses~ value bounded against the
#   implementation-slot count the gate already computes (below slots x 4.5 -> `:low`, above ~40 ->
#   `:high`). Advisory-only, so every firing test also asserts the exit code is untouched.
#
# bats-1.13 LAST-COMMAND SEMANTICS: a test fails ONLY on its final command's exit, so every assertion
#   is written `[[ ... ]] || return 1`.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/enforce-workflow-verify-stage.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-workflow-verify-stage.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  TRACE_LOG="${BATS_TEST_TMPDIR}/workflow-gate-fired.log"
  : >"${TRACE_LOG}"
}

run_hook_exec() {
  run bash -c '
    script="$1"; hook="$2"; trace="$3"
    payload="$(jq -n --arg s "${script}" '\''{tool_name:"Workflow",tool_input:{script:$s}}'\'')"
    printf "%s" "${payload}" | WORKFLOW_GATE_FIRED_LOG="${trace}" "${hook}"
  ' _ "${1}" "${HOOK_SH}" "${TRACE_LOG}"
}

# The `advisory=` field of the last recorded trace line, or MISSING.
last_advisory() {
  awk -F'\t' '
    { line = $0 }
    END {
      n = split(line, f, "\t")
      for (i = 1; i <= n; i++) if (index(f[i], "advisory=") == 1) { print substr(f[i], 10); exit }
      print "MISSING"
    }' "${TRACE_LOG}"
}

# In-script verify form with FOUR literal implementation spawns of one declared impl type (the verify
# pair is a different type, so no spawn is absorbed as a verify slot): slot count is exactly 4, so the
# derived floor is 18 tool_uses. $1 = the sizing-token line under test.
four_slot_script() {
  cat <<EOF
/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
log('plan-ref: clauded-docs/3634');
${1}
await parallel(
  agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' }),
  agent('glass-atrium-dev-nestjs',       { goal: 'judge -> feasible|infeasible' }),
);
await agent('glass-atrium-dev-shell', { goal: 'slice one' });
await agent('glass-atrium-dev-shell', { goal: 'slice two' });
await agent('glass-atrium-dev-shell', { goal: 'slice three' });
await agent('glass-atrium-dev-shell', { goal: 'slice four' });
EOF
}

@test "bounds(low): a declaration under the slots x 4.5 floor nudges, traces :low, exits 0" {
  run_hook_exec "$(four_slot_script "log('[SIZE-EST] bundles=1 tool_uses~=10 — under-declared');")"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"ADVISORY ([SIZE-EST] plausibility"* ]] || return 1
  [[ "${output}" == *"BELOW the slot-count floor"* ]] || return 1
  [[ "$(last_advisory)" == *"sizeest-bounds:low"* ]] || return 1
}

@test "bounds(high): a declaration over the ~40 ceiling nudges, traces :high, exits 0" {
  run_hook_exec "$(four_slot_script "log('[SIZE-EST] bundles=4 tool_uses~=55 — oversized');")"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"EXCEEDS the ~40 delegation ceiling"* ]] || return 1
  [[ "$(last_advisory)" == *"sizeest-bounds:high"* ]] || return 1
}

@test "bounds(silent): a plausible declaration inside both bounds fires neither nudge nor tag" {
  run_hook_exec "$(four_slot_script "log('[SIZE-EST] bundles=1 tool_uses~=18 — at the floor');")"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"ADVISORY ([SIZE-EST] plausibility"* ]] || return 1
  [[ "$(last_advisory)" != *"sizeest-bounds"* ]] || return 1
}

@test "bounds(analysis-mode): a reads~ token carries no tool_uses~ value and stays silent" {
  run_hook_exec "$(four_slot_script "log('[SIZE-EST] reads~=8 fields=2 effort=medium scope=allowlist — analysis');")"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"ADVISORY ([SIZE-EST] plausibility"* ]] || return 1
  [[ "$(last_advisory)" != *"sizeest-bounds"* ]] || return 1
}

@test "bounds(no-double-advise): a token-absent DEV script still blocks and carries no bounds tag" {
  run_hook_exec "$(four_slot_script "log('no sizing token here');")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" != *"ADVISORY ([SIZE-EST] plausibility"* ]] || return 1
  [[ "$(last_advisory)" != *"sizeest-bounds"* ]] || return 1
}

# A DEV spawn whose only declared dev-* role is the verify-team member: `impl: none` scores no
# implementation slot, so before the DEV-presence floor this shape counted zero and every slot-derived
# bound was vacuously satisfied on it — the dominant `dev=yes impl_slots=0` reading in the trace log.
# The floor makes it one, so the derived floor is 5 tool_uses. $1 = the sizing-token line under test.
verify_only_script() {
  cat <<EOF
/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: none
[/AGENT-COMPOSITION] */
log('plan-ref: clauded-docs/3634');
${1}
await parallel(
  agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' }),
  agent('glass-atrium-dev-nestjs',       { goal: 'judge -> feasible|infeasible' }),
);
EOF
}

@test "bounds(floor): the previously-vacuous verify-only DEV shape now draws :low when under-declared" {
  run_hook_exec "$(verify_only_script "log('[SIZE-EST] bundles=1 tool_uses~=2 — under-declared');")"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"BELOW the slot-count floor"* ]] || return 1
  [[ "$(last_advisory)" == *"sizeest-bounds:low"* ]] || return 1
}

@test "bounds(floor): the same shape declared at its floor stays silent — the floor is one, not more" {
  run_hook_exec "$(verify_only_script "log('[SIZE-EST] bundles=1 tool_uses~=5 — at the floor');")"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" != *"ADVISORY ([SIZE-EST] plausibility"* ]] || return 1
  [[ "$(last_advisory)" != *"sizeest-bounds"* ]] || return 1
}

# SEAM: the fail-open fallback literal must carry the new silent token; the equal-arity assertion
# across emit() / literal / read group lives in the sibling suite's arity pin and is untouched here.
@test "bounds(seam): the fail-open fallback literal carries SIZEEST_BOUNDS_SILENT" {
  grep -F "helper_out=\$'PASS" "${HOOK_SH}" | grep -qF "SIZEEST_BOUNDS_SILENT" || return 1
}
