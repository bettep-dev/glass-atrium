#!/usr/bin/env bats
# enforce-verification-gate-reviewer-block.bats — T1c fail-at-HEAD coverage for T6
# (Reviewer-miss becomes a block). This suite is the ACCEPTANCE SPEC the T6 DEV
# implements against: a plan-referencing DEV spawn with no qa-code-reviewer recorded
# must be PROMOTED from stderr-advisory-and-exit-0 to a channel-a exit-2 BLOCK,
# matching its sibling attestation checks (entry-miss VGATE-ENTRY-001,
# size-est-miss VGATE-SIZE-001).
#
# FAIL-AT-HEAD (the behavioral ACs — RED against a627de7, GREEN after T6):
#   * a plan-ref DEV spawn with no reviewer exits 2 (HEAD exits 0 — line 276).
#   * the block carries a distinct reviewer-miss code (VGATE-REVIEWER-001) plus a
#     reviewer-miss reason phrase, distinct from entry-miss / size-est-miss.
# REGRESSION GUARDS (GREEN at HEAD and after — the no-false-block envelope):
#   * a reviewer-present plan-ref DEV spawn still exits 0.
#   * a simple-task-token DEV spawn still exits 0.
#   * a non-DEV spawn still exits 0.
#   * fail-open on the hook's own errors still exits 0.
# STRUCTURAL / DOC ACs:
#   * the hook contains no spawn-depth predicate (dropped, not deferred).
#   * the header records that nested spawns remain ungated and why.
#
# CONTRACT DEFINED HERE (the T6 DEV conforms to these names):
#   reviewer-miss coded error is VGATE-REVIEWER-001, reason phrase reviewer-miss.
#
# Harness mirrors enforce-verification-gate.bats: the real PreToolUse(Agent)
# envelope is built with jq, HOOK_DATA_DIR is sandboxed, and every DEV prompt
# carries a [SIZE-EST] marker so the VGATE-SIZE-001 gate never masks the branch
# under test. Run via: bats hooks/test/enforce-verification-gate-reviewer-block.bats
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command
# gates pass/fail. Every assertion is routed through a helper that `return 1`s on
# mismatch, so each independently fails the test.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/enforce-verification-gate.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-verification-gate.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  DATA_DIR="${BATS_TEST_TMPDIR}/data"
  mkdir -p "${DATA_DIR}/session-spawns"
  # DSH-D06 block firing-trace sink, isolated per test via the hook's VGATE_FIRED_LOG override.
  SINK="${BATS_TEST_TMPDIR}/verification-gate-fired.log"
}

# The ONE Agent-envelope builder ($1=subagent_type $2=prompt). jq -n --arg escapes both fields, so
# arbitrary quotes and newlines in a prompt are safe. Both wrappers here feed it to the hook and
# differ only in the env prefix.
mk_payload() {
  jq -n --arg t "${1}" --arg p "${2}" --arg sid "sess-t6-001" \
    '{tool_name:"Agent",session_id:$sid,tool_input:{subagent_type:$t,prompt:$p}}'
}

run_hook() {
  run bash -c 'printf "%s" "$1" | HOOK_DATA_DIR="$2" "$3"' \
    _ "$(mk_payload "${1}" "${2}")" "${DATA_DIR}" "${HOOK_SH}"
}

# Pre-seed a qa-code-reviewer line into the session marker so reviewer_present=true.
seed_reviewer() {
  printf '%s\n' "glass-atrium-qa-code-reviewer" >"${DATA_DIR}/session-spawns/sess-t6-001"
}

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

# DSH-D06 variant: the standard plan-ref prompt with the block firing-trace sink pinned to $2
# (default ${SINK}).
run_hook_sink() {
  run bash -c 'printf "%s" "$1" | HOOK_DATA_DIR="$2" VGATE_FIRED_LOG="$4" "$3"' \
    _ "$(mk_payload "${1}" "implement per plan clauded-docs/290 [SIZE-EST] bundles=1 tool_uses~=15 — impl")" \
    "${DATA_DIR}" "${HOOK_SH}" "${2:-${SINK}}"
}

# --- FAIL-AT-HEAD: reviewer-miss on a plan-ref DEV spawn now BLOCKS (exit 2) ---

@test "plan-ref DEV spawn, no reviewer → reviewer-miss BLOCK (exit 2) [FAIL-AT-HEAD: HEAD exits 0]" {
  run_hook "glass-atrium-dev-react" "implement per plan clauded-docs/290 [SIZE-EST] bundles=1 tool_uses~=15 — impl"
  assert_status 2
}

@test "reviewer-miss BLOCK carries the distinct VGATE-REVIEWER-001 code [FAIL-AT-HEAD]" {
  run_hook "glass-atrium-dev-nestjs" "implement per plan clauded-docs/290 [SIZE-EST] bundles=1 tool_uses~=18 — svc"
  assert_status 2
  assert_contains "VGATE-REVIEWER-001"
}

@test "reviewer-miss BLOCK carries a reviewer-miss reason phrase [FAIL-AT-HEAD]" {
  run_hook "glass-atrium-dev-python" "implement per plan clauded-docs/290 [SIZE-EST] bundles=2 tool_uses~=22 — data layer"
  assert_status 2
  assert_contains "reviewer-miss"
}

@test "reviewer-miss BLOCK code is distinct from entry-miss and size-est-miss [FAIL-AT-HEAD]" {
  run_hook "glass-atrium-dev-shell" "implement per plan clauded-docs/290 [SIZE-EST] bundles=1 tool_uses~=12 — hook"
  assert_status 2
  assert_not_contains "VGATE-ENTRY-001"
  assert_not_contains "VGATE-SIZE-001"
}

# --- REGRESSION GUARDS: the no-false-block envelope (GREEN at HEAD and after) ---

@test "reviewer-present plan-ref DEV spawn → exit 0 (compliant reviewer-first composition)" {
  seed_reviewer
  # Carries a [PLAN-SUBSET] attestation so the C3-H nudge (a separate advisory surface, covered by
  # enforce-verification-gate-plan-subset.bats) does not break this file's no-output contract.
  run_hook "glass-atrium-dev-python" "implement per plan clauded-docs/290 [SIZE-EST] bundles=1 tool_uses~=15 — impl [PLAN-SUBSET] included=T1 landed=none excluded=none order=n/a"
  assert_status 0
  assert_empty
}

@test "simple-task-token DEV spawn → exit 0 (entry-class escape hatch, no reviewer needed)" {
  run_hook "glass-atrium-dev-shell" "fix a typo [ENTRY-CLASS] simple-task: single-char typo [SIZE-EST] bundles=1 tool_uses~=3 — trivial"
  assert_status 0
  assert_empty
}

@test "non-DEV plan-ref spawn → exit 0 (gate only blocks DEV)" {
  run_hook "glass-atrium-qa-code-reviewer" "review plan clauded-docs/290"
  assert_status 0
  assert_empty
}

@test "fail-open: empty payload → exit 0 silent (never blocks on the hook's own errors)" {
  run bash -c 'printf "%s" "" | HOOK_DATA_DIR="$2" "$1"' _ "${HOOK_SH}" "${DATA_DIR}"
  assert_status 0
  assert_empty
}

@test "fail-open: garbage non-JSON stdin → exit 0 (jq fails, never blocks)" {
  run bash -c 'printf "%s" "not json at all <<<" | HOOK_DATA_DIR="$2" "$1"' _ "${HOOK_SH}" "${DATA_DIR}"
  assert_status 0
}

# --- STRUCTURAL / DOC ACs: depth predicate dropped, nested-spawn caveat recorded ---

@test "the hook contains no spawn-depth predicate (dropped, not deferred)" {
  run grep -nE 'spawn_depth|parent_agent_id|depth[[:space:]]*[<>=]|nesting_depth' "${HOOK_SH}"
  [[ "${status}" -ne 0 ]] || {
    echo "found a spawn-depth predicate in the hook: ${output}" >&2
    return 1
  }
}

@test "the header records that nested spawns remain ungated [FAIL-AT-HEAD until T6 header edit]" {
  # T6 AC: "The header shall record that nested spawns remain ungated and why."
  # Assert the distinctive T6 word (ungated) co-occurs with nested — absent at HEAD.
  run bash -c 'h="$(sed -n "1,50p" "$1")"; printf "%s" "$h" | grep -iq "ungated" && printf "%s" "$h" | grep -iq "nested"' _ "${HOOK_SH}"
  [[ "${status}" -eq 0 ]] || {
    echo "hook header does not record the nested-spawns-remain-ungated limitation" >&2
    return 1
  }
}

# --- DSH-D06: the reviewer-miss block leaves a durable trace, and never trades the block for it ---

@test "D06: reviewer-miss BLOCK appends exactly one block-reviewer trace line" {
  run_hook_sink "glass-atrium-dev-react"
  assert_status 2
  assert_contains "VGATE-REVIEWER-001"
  lines_written="$(grep -c 'verdict=block-reviewer$' "${SINK}" 2>/dev/null || true)"
  [[ "${lines_written}" == "1" ]] || {
    echo "expected exactly 1 block-reviewer trace line, got [${lines_written}]; sink: $(cat "${SINK}" 2>/dev/null)" >&2
    return 1
  }
}

@test "D06: reviewer-present pass appends NO trace line (delta 0)" {
  seed_reviewer
  run_hook_sink "glass-atrium-dev-python"
  assert_status 0
  [[ ! -s "${SINK}" ]] || {
    echo "expected an empty sink on the pass path, got: $(cat "${SINK}" 2>/dev/null)" >&2
    return 1
  }
}

@test "D06 block-preservation: an unwritable sink must NOT convert the reviewer-miss block into a pass" {
  # The gate's ERR trap exits ZERO, so an unisolated trace append would fail-open here.
  blocker="${BATS_TEST_TMPDIR}/blocker"
  : >"${blocker}"
  run_hook_sink "glass-atrium-dev-nestjs" "${blocker}/fired.log"
  assert_status 2
  assert_contains "VGATE-REVIEWER-001"
  assert_contains "reviewer-miss"
}
