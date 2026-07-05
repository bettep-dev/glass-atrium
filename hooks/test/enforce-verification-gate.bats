#!/usr/bin/env bats
# enforce-verification-gate.bats — Bats suite for the PreToolUse(Agent) verification-gate hook.
#   Three distinct surfaces, asserted independently:
#     1) reviewer-advisory (STDERR + exit 0) — plan-ref DEV spawn, no qa-code-reviewer recorded.
#     2) size-est-miss BLOCK (channel-a: emit_error stderr JSON + exit 2) — ORCHESTRATOR-ORIGIN DEV
#        spawn (agent_id absent) with NO [SIZE-EST] token. Guarded by hook_is_subagent: a nested
#        sub-worker origin (agent_id present) is NEVER blocked. Applies to every DEV spawn, plan-ref
#        included — so the DEV-spawn fixtures below all carry a [SIZE-EST] token to clear this gate.
#     3) entry-miss BLOCK (channel-a: emit_error stderr JSON + exit 2) — DEV spawn with NEITHER a
#        plan-reference NOR an [ENTRY-CLASS] simple-task token (the silent entry-miss). The token is
#        the escape hatch.
#   Non-DEV / plan-bearing / token-bearing spawns exit 0 (zero false-block for the entry-miss branch).
#   The hook is FAIL-OPEN on its OWN errors (malformed/empty/non-Agent input → exit 0).
#
# Decision channel: surface 1 = STDERR advisory + exit 0; surface 2 = STDERR JSON + exit 2. bats
#   default `run` MERGES stderr into $output, so both surfaces are asserted via $output.
# Input is the real PreToolUse(Agent) envelope:
#   {"tool_name":"Agent","tool_input":{"subagent_type":"<type>","prompt":"<text>"}}
#   built with jq so arbitrary quotes/newlines in the prompt are escaped safely.
# HOOK_DATA_DIR is sandboxed to a temp dir so the session-spawns marker (reviewer_present
#   state) never touches the live runtime data dir.
#
# BATS GATING NOTE: this bats version runs @test bodies WITHOUT `set -e`, so only the LAST command
#   gates pass/fail — a non-final failing `[[ ]]` is silently ignored. Every assertion below is
#   therefore guarded with `|| { echo ...; return 1; }` so EACH one independently fails the test.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/enforce-verification-gate.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-verification-gate.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  DATA_DIR="${BATS_TEST_TMPDIR}/data"
  mkdir -p "${DATA_DIR}/session-spawns"
}

# Drive the hook with an Agent envelope wrapping $1 (subagent_type) + $2 (prompt text).
# jq -n --arg escapes both fields; HOOK_DATA_DIR is sandboxed to the temp dir.
run_hook() {
  run bash -c '
    stype="$1"; prompt="$2"; hook="$3"; data="$4"
    payload="$(jq -n --arg t "${stype}" --arg p "${prompt}" --arg sid "sess-test-001" \
      '\''{tool_name:"Agent",session_id:$sid,tool_input:{subagent_type:$t,prompt:$p}}'\'')"
    printf "%s" "${payload}" | HOOK_DATA_DIR="${data}" bash "${hook}"
  ' _ "${1}" "${2}" "${HOOK_SH}" "${DATA_DIR}"
}

# Drive the hook as a NESTED sub-worker spawn (top-level agent_id present → hook_is_subagent true).
# Same envelope as run_hook plus an agent_id, so the [SIZE-EST] guard sees a non-orchestrator origin.
run_hook_subagent() {
  run bash -c '
    stype="$1"; prompt="$2"; hook="$3"; data="$4"
    payload="$(jq -n --arg t "${stype}" --arg p "${prompt}" --arg sid "sess-test-001" --arg aid "agent-nested-001" \
      '\''{tool_name:"Agent",session_id:$sid,agent_id:$aid,tool_input:{subagent_type:$t,prompt:$p}}'\'')"
    printf "%s" "${payload}" | HOOK_DATA_DIR="${data}" bash "${hook}"
  ' _ "${1}" "${2}" "${HOOK_SH}" "${DATA_DIR}"
}

# Pre-seed a qa-code-reviewer line into the session marker so reviewer_present=true.
seed_reviewer() {
  printf '%s\n' "glass-atrium-qa-code-reviewer" >"${DATA_DIR}/session-spawns/sess-test-001"
}

# Per-assertion gate helpers (the bats body is NOT under set -e — see header note).
assert_status() {
  [[ "${status}" -eq "${1}" ]] || {
    echo "expected status ${1}, got ${status} (output: ${output})" >&2
    return 1
  }
}
assert_contains() {
  [[ "${output}" == *"${1}"* ]] || {
    echo "expected output to contain [${1}], got: ${output}" >&2
    return 1
  }
}
assert_not_contains() {
  [[ "${output}" != *"${1}"* ]] || {
    echo "expected output to NOT contain [${1}], got: ${output}" >&2
    return 1
  }
}
assert_empty() {
  [[ -z "${output}" ]] || {
    echo "expected empty output, got: ${output}" >&2
    return 1
  }
}

# --- (a) BLOCK: dev-* spawn, no plan-ref, no token → entry-miss block (exit 2) ---

@test "dev spawn, no plan-ref, no token (SIZE-EST present) → entry-miss BLOCK (exit 2 + stderr JSON)" {
  run_hook "glass-atrium-dev-nestjs" "implement the auth refactor across the service layer [SIZE-EST] bundles=1 tool_uses~=20 — service-layer auth work"
  assert_status 2
  assert_contains "VGATE-ENTRY-001"
  assert_contains "entry-miss"
}

@test "different dev-* agent, no plan-ref, no token (SIZE-EST present) → entry-miss BLOCK (exit 2)" {
  run_hook "glass-atrium-dev-android" "wire up the new settings screen across modules [SIZE-EST] bundles=2 tool_uses~=25 — settings screen wiring"
  assert_status 2
  assert_contains "entry-miss"
}

# --- (a') SYNCED-ROSTER MEMBERSHIP PROBE — a real synced DEV member (dev-swift) is gated; a
# non-member (intel-reporter) is not. Proves the gate keys on DEV_SET membership: dev-swift is the
# agent whose DEV_SET absence originally motivated the gate-roster auto-sync (agent_lifecycle
# add/delete + `sync-gate-roster`). This case fails RED if dev-swift is ever dropped from DEV_SET,
# confirming the gate actually reads the synced list rather than a stale hand-edited copy. ---

@test "synced member dev-swift, no plan-ref, no token (SIZE-EST present) → entry-miss BLOCK (exit 2)" {
  run_hook "glass-atrium-dev-swift" "implement the SwiftUI settings flow across modules [SIZE-EST] bundles=2 tool_uses~=22 — swiftui settings flow"
  assert_status 2
  assert_contains "entry-miss"
}

@test "non-member intel-reporter, no plan-ref, no token → silent exit 0 (not a DEV spawn)" {
  run_hook "glass-atrium-intel-reporter" "synthesize the findings into a report"
  assert_status 0
  assert_empty
}

# --- (b) ALLOW: dev-* spawn WITH plan-ref → reviewer advisory path, exit 0 (NOT blocked) ---

@test "dev spawn with plan-ref (SIZE-EST present), no reviewer → reviewer advisory + exit 0 (NOT entry-miss block)" {
  run_hook "glass-atrium-dev-react" "implement per plan clauded-docs/1234 [SIZE-EST] bundles=1 tool_uses~=15 — impl"
  assert_status 0
  assert_contains "no qa-code-reviewer recorded"
  assert_not_contains "entry-miss"
}

@test "dev spawn with plan-ref (SIZE-EST present) AND reviewer present → silent, exit 0, no output" {
  seed_reviewer
  run_hook "glass-atrium-dev-python" "implement per plan clauded-docs/9999 [SIZE-EST] bundles=1 tool_uses~=15 — impl"
  assert_status 0
  assert_empty
}

# --- (c) ALLOW: dev-* spawn with [ENTRY-CLASS] simple-task token → exit 0 (escape hatch) ---

@test "dev spawn with [ENTRY-CLASS] simple-task token (SIZE-EST present) → silent, exit 0, no output" {
  run_hook "glass-atrium-dev-shell" "fix a typo [ENTRY-CLASS] simple-task: single-char typo (sizable-floor: none) [SIZE-EST] bundles=1 tool_uses~=3 — trivial"
  assert_status 0
  assert_empty
}

@test "token present AND plan-ref (SIZE-EST present) → reviewer branch wins (plan-ref checked first), exit 0" {
  run_hook "glass-atrium-dev-nestjs" "implement plan-7001 [ENTRY-CLASS] simple-task: noise [SIZE-EST] bundles=1 tool_uses~=5 — small"
  assert_status 0
  assert_contains "no qa-code-reviewer recorded"
  assert_not_contains "entry-miss"
}

# --- (c') SIZE-EST gate: orchestrator-origin DEV spawn MUST carry a [SIZE-EST] token; guarded by
# hook_is_subagent so a nested sub-worker origin (agent_id present) is never blocked. ---

@test "orchestrator DEV, plan-ref present but NO [SIZE-EST] → VGATE-SIZE-001 BLOCK (exit 2, size gate reachable for plan-bearing spawns)" {
  run_hook "glass-atrium-dev-react" "implement per plan clauded-docs/1234"
  assert_status 2
  assert_contains "VGATE-SIZE-001"
  assert_contains "size-est-miss"
  assert_not_contains "entry-miss"
}

@test "orchestrator DEV, plain prompt, NO [SIZE-EST] → VGATE-SIZE-001 BLOCK (exit 2)" {
  run_hook "glass-atrium-dev-nestjs" "implement the auth refactor across the service layer"
  assert_status 2
  assert_contains "VGATE-SIZE-001"
  assert_contains "size-est-miss"
}

@test "nested sub-worker (agent_id present), same plan-ref NO-[SIZE-EST] prompt → size guard SKIPPED, exit 0 (NOT VGATE-SIZE-001)" {
  run_hook_subagent "glass-atrium-dev-react" "implement per plan clauded-docs/1234"
  assert_status 0
  assert_contains "no qa-code-reviewer recorded"
  assert_not_contains "VGATE-SIZE-001"
}

@test "orchestrator DEV with [SIZE-EST] token + simple-task token → size gate satisfied, exit 0" {
  run_hook "glass-atrium-dev-shell" "fix a typo [ENTRY-CLASS] simple-task: single-char typo [SIZE-EST] bundles=1 tool_uses~=3 — trivial"
  assert_status 0
  assert_empty
}

# --- (d) ALLOW: non-dev spawn → exit 0 (gate only blocks DEV) ---

@test "non-dev subagent_type, no plan-ref, no token → silent, exit 0 (not a DEV spawn)" {
  run_hook "glass-atrium-intel-planner" "draft a plan for the auth refactor"
  assert_status 0
  assert_empty
}

@test "non-dev subagent_type WITH plan-ref → silent, exit 0 (gate only fires on dev)" {
  run_hook "glass-atrium-qa-code-reviewer" "review plan clauded-docs/5555"
  assert_status 0
  assert_empty
}

# --- (e) FAIL-OPEN on the hook's OWN errors → exit 0 (never block on internal/input faults) ---

@test "fail-open: empty payload → exit 0 silent" {
  run bash -c 'printf "%s" "" | HOOK_DATA_DIR="$2" bash "$1"' _ "${HOOK_SH}" "${DATA_DIR}"
  assert_status 0
  assert_empty
}

@test "fail-open: non-Agent tool_name → exit 0 silent (out of scope)" {
  run bash -c '
    printf "%s" "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"/tmp/x\"}}" | HOOK_DATA_DIR="$2" bash "$1"
  ' _ "${HOOK_SH}" "${DATA_DIR}"
  assert_status 0
  assert_empty
}

@test "fail-open: garbage non-JSON stdin → exit 0 (jq fails, never blocks)" {
  run bash -c '
    printf "%s" "not json at all <<<" | HOOK_DATA_DIR="$2" bash "$1"
  ' _ "${HOOK_SH}" "${DATA_DIR}"
  assert_status 0
}

@test "fail-open: Agent envelope with no subagent_type / no prompt → exit 0 (no DEV match)" {
  run bash -c '
    printf "%s" "{\"tool_name\":\"Agent\",\"session_id\":\"s1\",\"tool_input\":{}}" | HOOK_DATA_DIR="$2" bash "$1"
  ' _ "${HOOK_SH}" "${DATA_DIR}"
  assert_status 0
  assert_empty
}
