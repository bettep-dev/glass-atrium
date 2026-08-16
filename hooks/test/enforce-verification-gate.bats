#!/usr/bin/env bats
# enforce-verification-gate.bats — Bats suite for the PreToolUse(Agent) verification-gate hook.
#   Three distinct surfaces, asserted independently:
#     1) reviewer-miss BLOCK (channel-a: emit_error stderr JSON + exit 2, VGATE-REVIEWER-001) —
#        orchestrator-origin plan-ref DEV spawn, no qa-code-reviewer recorded. Guarded by
#        hook_is_subagent, so a nested sub-worker origin keeps only the informational advisory (exit 0).
#     2) size-est-miss BLOCK (channel-a: emit_error stderr JSON + exit 2) — ORCHESTRATOR-ORIGIN DEV
#        spawn (agent_id absent) with NO [SIZE-EST] token. Guarded by hook_is_subagent: a nested
#        sub-worker origin (agent_id present) is NEVER blocked. Applies to every DEV spawn, plan-ref
#        included — so the DEV-spawn fixtures below all carry a [SIZE-EST] token to clear this gate.
#     3) entry-miss BLOCK (channel-a: emit_error stderr JSON + exit 2) — DEV spawn with NEITHER a
#        plan-reference NOR an [ENTRY-CLASS] simple-task token (the silent entry-miss). The token is
#        the escape hatch.
#     4) scope-miss ADVISORY (stderr, exit 0) — an orchestrator-origin DEV spawn carrying no [SCOPE]
#        declaration, emitted on the PASS paths. Owned by enforce-verification-gate-scope.bats; here
#        it only means that a case asserting EMPTY output must declare a [SCOPE] line, exactly as the
#        [PLAN-SUBSET] nudge made those cases carry a [PLAN-SUBSET] token. "A pass is silent" is the
#        contract those cases hold — silence for a spawn that is compliant on EVERY surface.
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
  # Block firing-trace sink, isolated per test via the hook's own VGATE_FIRED_LOG override.
  SINK="${BATS_TEST_TMPDIR}/verification-gate-fired.log"
  # Surface 4 is an advisory on the PASS paths (see header), so every prompt whose case asserts an
  # EMPTY output carries this declaration. Canonical ` · ` grammar — a fixture is read as an example.
  SCOPE_DECL="[SCOPE] files=hooks/a.sh · deliverable=fix · out=none"
}

# The ONE Agent-envelope builder. $1=subagent_type $2=prompt; $3=agent_id and $4=hook_event_name
# are optional and their keys are omitted when empty. jq -n --arg escapes every field, so arbitrary
# quotes and newlines in a prompt are safe. Every wrapper below feeds this to the hook and differs
# from its siblings ONLY in the env prefix.
mk_payload() {
  jq -n --arg t "${1}" --arg p "${2}" --arg sid "sess-test-001" \
    --arg aid "${3:-}" --arg ev "${4:-}" \
    '{tool_name:"Agent",session_id:$sid,tool_input:{subagent_type:$t,prompt:$p}}
     + (if $aid == "" then {} else {agent_id:$aid} end)
     + (if $ev == "" then {} else {hook_event_name:$ev} end)'
}

# Orchestrator-origin spawn (no agent_id). HOOK_DATA_DIR is sandboxed to the temp dir.
run_hook() {
  run bash -c 'printf "%s" "$1" | HOOK_DATA_DIR="$2" bash "$3"' \
    _ "$(mk_payload "${1}" "${2}")" "${DATA_DIR}" "${HOOK_SH}"
}

# NESTED sub-worker spawn (top-level agent_id present → hook_is_subagent true), so the [SIZE-EST]
# guard sees a non-orchestrator origin.
run_hook_subagent() {
  run bash -c 'printf "%s" "$1" | HOOK_DATA_DIR="$2" bash "$3"' \
    _ "$(mk_payload "${1}" "${2}" "agent-nested-001")" "${DATA_DIR}" "${HOOK_SH}"
}

# Explicit hook_event_name ($1=event PreToolUse|PostToolUse, $2=stype, $3=prompt). Exercises the
# DF-5 dual-event split: PreToolUse = read/verdict only (no stamp); PostToolUse = spawn-success stamp.
run_hook_event() {
  run bash -c 'printf "%s" "$1" | HOOK_DATA_DIR="$2" bash "$3"' \
    _ "$(mk_payload "${2}" "${3}" "" "${1}")" "${DATA_DIR}" "${HOOK_SH}"
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
# DF-5 marker assertions — the session-spawns marker records EXECUTED spawns only (PostToolUse).
assert_marker_absent() {
  ! grep -qx "${1}" "${DATA_DIR}/session-spawns/sess-test-001" 2>/dev/null || {
    echo "expected marker to NOT contain line [${1}]" >&2
    return 1
  }
}
assert_marker_present() {
  grep -qx "${1}" "${DATA_DIR}/session-spawns/sess-test-001" 2>/dev/null || {
    echo "expected marker to contain line [${1}]" >&2
    return 1
  }
}

# --- Block firing-trace harness (DSH-D06) ---
# The same three wrappers with the hook's own VGATE_FIRED_LOG override, so each case owns its sink.

# $1=subagent_type $2=prompt $3=sink path (default ${SINK}) $4=line cap (default 1000)
run_hook_trace() {
  run bash -c 'printf "%s" "$1" | HOOK_DATA_DIR="$2" VGATE_FIRED_LOG="$4" VGATE_FIRED_LOG_CAP="$5" bash "$3"' \
    _ "$(mk_payload "${1}" "${2}")" "${DATA_DIR}" "${HOOK_SH}" "${3:-${SINK}}" "${4:-1000}"
}

# Nested sub-worker origin with the sink override — the advisory-only path must leave it untouched.
run_hook_subagent_trace() {
  run bash -c 'printf "%s" "$1" | HOOK_DATA_DIR="$2" VGATE_FIRED_LOG="$4" bash "$3"' \
    _ "$(mk_payload "${1}" "${2}" "agent-nested-001")" "${DATA_DIR}" "${HOOK_SH}" "${SINK}"
}

# PostToolUse (or explicit-event) variant with the sink override — the post-tool surface must append
# NOTHING to a sink whose whole meaning is "never started".
run_hook_event_trace() {
  run bash -c 'printf "%s" "$1" | HOOK_DATA_DIR="$2" VGATE_FIRED_LOG="$4" bash "$3"' \
    _ "$(mk_payload "${2}" "${3}" "" "${1}")" "${DATA_DIR}" "${HOOK_SH}" "${SINK}"
}

count_sink() {
  local path="${1:-${SINK}}" n
  [[ -f "${path}" ]] || {
    printf '0'
    return 0
  }
  n="$(grep -c '' "${path}" 2>/dev/null || true)"
  [[ -z "${n}" ]] && n=0
  printf '%s' "${n}"
}

# $1 = expected line count. SINK lives under BATS_TEST_TMPDIR, which bats mints fresh per test, so
# a case that does not seed the sink itself starts from zero and an absolute count is what it means;
# a captured `before` there is a constant dressed up as a measurement.
assert_sink_count() {
  local after
  after="$(count_sink)"
  [[ "${after}" -eq "${1}" ]] || {
    echo "expected sink to hold ${1} line(s), got ${after}" >&2
    return 1
  }
}

# $1 = expected delta, $2 = count captured before the run. For the cases that DO seed the sink first.
assert_sink_delta() {
  local after
  after="$(count_sink)"
  [[ $((after - ${2})) -eq "${1}" ]] || {
    echo "expected sink delta ${1}, got $((after - ${2})) (before=${2} after=${after})" >&2
    return 1
  }
}

assert_sink_tag() {
  grep -q "verdict=${1}\$" "${SINK}" 2>/dev/null || {
    echo "expected sink to carry verdict=${1}; sink contents: $(cat "${SINK}" 2>/dev/null)" >&2
    return 1
  }
}

# Prints the path of a sink that cannot be appended to, in the SHAPE named by $1 ($2 = a suffix
# keeping concurrent rows apart). Returns non-zero when the shape cannot be made unwritable in this
# environment, so the caller can skip that row rather than assert against a writable sink.
#   blocker-parent — the parent path component is a REGULAR FILE, so mkdir -p can never succeed
#                    (deterministic even when the suite runs as root, unlike the chmod shapes)
#   readonly-dir   — the parent directory exists and denies writes
#   sink-is-dir    — the sink path IS a directory, so an append is impossible
mint_bad_sink() {
  local dest="${BATS_TEST_TMPDIR}/bad-sink-${2}"
  case "${1}" in
    blocker-parent)
      : >"${dest}"
      printf '%s' "${dest}/fired.log"
      ;;
    readonly-dir)
      mkdir -p "${dest}"
      chmod 0555 "${dest}"
      if [[ -w "${dest}" ]]; then return 1; fi
      printf '%s' "${dest}/fired.log"
      ;;
    sink-is-dir)
      mkdir -p "${dest}"
      printf '%s' "${dest}"
      ;;
    *)
      echo "mint_bad_sink: unknown shape [${1}]" >&2
      return 1
      ;;
  esac
}

# (a) BLOCK: dev-* spawn, no plan-ref, no token → entry-miss block (exit 2)

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

# (a'') PLAN-REF WORD-BOUNDARY (#28) — the plan-slug alternations are word-anchored so an incidental
# token that merely CONTAINS the slug (workplan-2026) does NOT silently satisfy references_plan and
# thereby convert an entry-miss BLOCK into a pass; a real slug (plan-6569) still matches. Keep-in-sync
# with the enforce-workflow-verify-stage.sh PLAN_REF_RE mirror.

@test "plan-ref word-boundary (#28): 'workplan-2026' does NOT satisfy references_plan → entry-miss BLOCK" {
  run_hook "glass-atrium-dev-nestjs" "advance the workplan-2026 milestone across the service layer [SIZE-EST] bundles=1 tool_uses~=20 — service work"
  assert_status 2
  assert_contains "entry-miss"
}

@test "plan-ref word-boundary (#28): real 'plan-6569' slug satisfies references_plan → reviewer-miss BLOCK, exit 2" {
  run_hook "glass-atrium-dev-react" "implement per plan-6569 [SIZE-EST] bundles=1 tool_uses~=15 — impl"
  assert_status 2
  assert_contains "VGATE-REVIEWER-001"
  assert_contains "reviewer-miss"
  assert_not_contains "entry-miss"
}

# (a') SYNCED-ROSTER MEMBERSHIP PROBE — a real synced DEV member (dev-swift) is gated; a
# non-member (intel-reporter) is not. Proves the gate keys on DEV_SET membership: dev-swift is the
# agent whose DEV_SET absence originally motivated the gate-roster auto-sync (agent_lifecycle
# add/delete + `sync-gate-roster`). This case fails RED if dev-swift is ever dropped from DEV_SET,
# confirming the gate actually reads the synced list rather than a stale hand-edited copy.

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

# (b) ALLOW: dev-* spawn WITH plan-ref → reviewer advisory path, exit 0 (NOT blocked)

@test "dev spawn with plan-ref (SIZE-EST present), no reviewer → reviewer-miss BLOCK exit 2 (NOT entry-miss)" {
  run_hook "glass-atrium-dev-react" "implement per plan clauded-docs/1234 [SIZE-EST] bundles=1 tool_uses~=15 — impl"
  assert_status 2
  assert_contains "VGATE-REVIEWER-001"
  assert_contains "reviewer-miss"
  assert_not_contains "entry-miss"
}

@test "dev spawn with plan-ref (SIZE-EST present) AND reviewer present → silent, exit 0, no output" {
  seed_reviewer
  run_hook "glass-atrium-dev-python" "implement per plan clauded-docs/9999 [SIZE-EST] bundles=1 tool_uses~=15 — impl [PLAN-SUBSET] included=T1 landed=none excluded=none order=n/a ${SCOPE_DECL}"
  assert_status 0
  assert_empty
}

# (c) ALLOW: dev-* spawn with [ENTRY-CLASS] simple-task token → exit 0 (escape hatch)

@test "dev spawn with [ENTRY-CLASS] simple-task token (SIZE-EST present) → silent, exit 0, no output" {
  run_hook "glass-atrium-dev-shell" "fix a typo [ENTRY-CLASS] simple-task: single-char typo (sizable-floor: none) [SIZE-EST] bundles=1 tool_uses~=3 — trivial ${SCOPE_DECL}"
  assert_status 0
  assert_empty
}

@test "token present AND plan-ref (SIZE-EST present) → plan-ref branch wins (checked first) → reviewer-miss BLOCK exit 2" {
  run_hook "glass-atrium-dev-nestjs" "implement plan-7001 [ENTRY-CLASS] simple-task: noise [SIZE-EST] bundles=1 tool_uses~=5 — small"
  assert_status 2
  assert_contains "VGATE-REVIEWER-001"
  assert_contains "reviewer-miss"
  assert_not_contains "entry-miss"
}

# (c') SIZE-EST gate: orchestrator-origin DEV spawn MUST carry a [SIZE-EST] token; guarded by
# hook_is_subagent so a nested sub-worker origin (agent_id present) is never blocked.

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
  run_hook "glass-atrium-dev-shell" "fix a typo [ENTRY-CLASS] simple-task: single-char typo [SIZE-EST] bundles=1 tool_uses~=3 — trivial ${SCOPE_DECL}"
  assert_status 0
  assert_empty
}

# (d) ALLOW: non-dev spawn → exit 0 (gate only blocks DEV)

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

# (e) FAIL-OPEN on the hook's OWN errors → exit 0 (never block on internal/input faults)

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

# (f) DF-5 — the spawn stamp moved from PreToolUse (attempt) to PostToolUse (spawn-SUCCESS). A
# blocked/never-executed spawn reaches no PostToolUse, so it must leave NO marker line: no false
# reviewer-present for a later DEV spawn, and no inflated advisory-spawn-budget.sh counter.

@test "DF-5: PreToolUse reviewer spawn does NOT stamp → blocked-spawn leaves no reviewer-present" {
  run_hook_event "PreToolUse" "glass-atrium-qa-code-reviewer" "review plan clauded-docs/5555"
  assert_status 0
  assert_marker_absent "glass-atrium-qa-code-reviewer"
}

@test "DF-5: PostToolUse reviewer spawn stamps reviewer-present (only an executed spawn records)" {
  run_hook_event "PostToolUse" "glass-atrium-qa-code-reviewer" "review plan clauded-docs/5555"
  assert_status 0
  assert_marker_present "glass-atrium-qa-code-reviewer"
}

@test "DF-5: PreToolUse DEV entry-miss BLOCK (exit 2) leaves NO marker line (no counter inflation)" {
  run_hook_event "PreToolUse" "glass-atrium-dev-nestjs" "implement the auth refactor [SIZE-EST] bundles=1 tool_uses~=20 — svc"
  assert_status 2
  assert_contains "entry-miss"
  assert_marker_absent "glass-atrium-dev-nestjs"
}

@test "DF-5: PostToolUse-stamped reviewer → later PreToolUse DEV plan-ref spawn passes silently" {
  run_hook_event "PostToolUse" "glass-atrium-qa-code-reviewer" "review plan clauded-docs/5555"
  assert_status 0
  run_hook_event "PreToolUse" "glass-atrium-dev-python" "implement per plan clauded-docs/9999 [SIZE-EST] bundles=1 tool_uses~=15 — impl [PLAN-SUBSET] included=T1 landed=none excluded=none order=n/a ${SCOPE_DECL}"
  assert_status 0
  assert_empty
}

@test "DF-5: PreToolUse DEV plan-ref spawn (reviewer-miss BLOCK) does NOT stamp itself (read-only on PreToolUse)" {
  run_hook_event "PreToolUse" "glass-atrium-dev-react" "implement per plan clauded-docs/1234 [SIZE-EST] bundles=1 tool_uses~=15 — impl"
  assert_status 2
  assert_contains "VGATE-REVIEWER-001"
  assert_marker_absent "glass-atrium-dev-react"
}

# (g) DSH-D06 — BLOCK FIRING TRACE (durable, observability-only) + its reader.
# The gate's ERR trap exits ZERO, so the load-bearing property under test is not "a line is written"
# but "a broken sink can never convert a BLOCK into a PASS". Every block path therefore carries BOTH
# a delta-exactly-1 case and an unwritable-sink exit-2 case.

@test "D06 writer: every block path appends exactly 1 line carrying its own verdict tag" {
  # One row per block path — the three differ only in (subagent_type, prompt, code, tag).
  local -a table=(
    'glass-atrium-dev-nestjs|implement the auth refactor [SIZE-EST] bundles=1 tool_uses~=20 — svc|VGATE-ENTRY-001|block-entry'
    'glass-atrium-dev-react|implement per plan clauded-docs/1234 [SIZE-EST] bundles=1 tool_uses~=15 — impl|VGATE-REVIEWER-001|block-reviewer'
    'glass-atrium-dev-python|implement per plan clauded-docs/1234|VGATE-SIZE-001|block-sizeest'
  )
  local row stype prompt code tag
  for row in "${table[@]}"; do
    IFS='|' read -r stype prompt code tag <<<"${row}"
    echo "row=${row}"
    rm -f "${SINK}"
    run_hook_trace "${stype}" "${prompt}"
    assert_status 2
    assert_contains "${code}"
    assert_sink_count 1
    assert_sink_tag "${tag}"
  done
}

@test "D06 writer: the trace line carries the spawn's subagent_type" {
  run_hook_trace "glass-atrium-dev-android" "implement the settings screen [SIZE-EST] bundles=1 tool_uses~=12 — ui"
  assert_status 2
  grep -q "subagent_type=glass-atrium-dev-android" "${SINK}" 2>/dev/null || {
    echo "expected the trace line to name the subagent_type; sink: $(cat "${SINK}" 2>/dev/null)" >&2
    return 1
  }
}

# Negative cases — a sink that fires on a pass is worse than no sink.

@test "D06 negative: a spawn the gate passes appends NOTHING to the sink" {
  # Each row is a different reason the gate passes; column 3 seeds a reviewer first when set.
  local -a table=(
    "glass-atrium-dev-shell|fix a typo [ENTRY-CLASS] simple-task: single-char typo [SIZE-EST] bundles=1 tool_uses~=3 — trivial ${SCOPE_DECL}|"
    'glass-atrium-intel-planner|draft a plan for the auth refactor|'
    "glass-atrium-dev-python|implement per plan clauded-docs/9999 [SIZE-EST] bundles=1 tool_uses~=15 — impl [PLAN-SUBSET] included=T1 landed=none excluded=none order=n/a ${SCOPE_DECL}|seed-reviewer"
  )
  local row stype prompt seed
  for row in "${table[@]}"; do
    IFS='|' read -r stype prompt seed <<<"${row}"
    echo "row=${row}"
    rm -f "${SINK}" "${DATA_DIR}/session-spawns/sess-test-001"
    if [[ "${seed}" == "seed-reviewer" ]]; then seed_reviewer; fi
    run_hook_trace "${stype}" "${prompt}"
    assert_status 0
    assert_empty
    assert_sink_count 0
  done
}

@test "D06 negative: nested sub-worker advisory (exit 0) appends NOTHING to the sink" {
  run_hook_subagent_trace "glass-atrium-dev-react" "implement per plan clauded-docs/1234"
  assert_status 0
  assert_contains "no qa-code-reviewer recorded"
  assert_sink_count 0
}

# REGISTER ONCE, TRACE ONCE — the PostToolUse surface records EXECUTED spawns by design; a line there
# would record a started spawn in a sink whose whole meaning is "never started".

@test "D06 register-once: PostToolUse stamp appends NOTHING to the block sink" {
  run_hook_event_trace "PostToolUse" "glass-atrium-qa-code-reviewer" "review plan clauded-docs/5555"
  assert_status 0
  assert_marker_present "glass-atrium-qa-code-reviewer"
  assert_sink_count 0
}

@test "D06 register-once: PostToolUse DEV spawn appends NOTHING to the block sink" {
  run_hook_event_trace "PostToolUse" "glass-atrium-dev-nestjs" "implement the auth refactor"
  assert_status 0
  assert_sink_count 0
}

# BLOCK PRESERVATION — the sharpest hazard: this gate's ERR trap exits 0, so a trace-write failure
# reaching the gate's exit status would silently convert a BLOCK into a PASS.

@test "D06 block-preservation: an unwritable sink never converts a block into a pass" {
  # Three sink shapes over three block paths: each block path meets an unwritable sink, and the two
  # further shapes re-run already-covered paths against a different reason the append fails.
  local -a table=(
    'blocker-parent|glass-atrium-dev-nestjs|implement the auth refactor [SIZE-EST] bundles=1 tool_uses~=20 — svc|VGATE-ENTRY-001|entry-miss'
    'blocker-parent|glass-atrium-dev-react|implement per plan clauded-docs/1234 [SIZE-EST] bundles=1 tool_uses~=15 — impl|VGATE-REVIEWER-001|reviewer-miss'
    'blocker-parent|glass-atrium-dev-python|implement per plan clauded-docs/1234|VGATE-SIZE-001|size-est-miss'
    'readonly-dir|glass-atrium-dev-nestjs|implement the auth refactor [SIZE-EST] bundles=1 tool_uses~=20 — svc|VGATE-ENTRY-001|entry-miss'
    'sink-is-dir|glass-atrium-dev-react|implement per plan clauded-docs/1234 [SIZE-EST] bundles=1 tool_uses~=15 — impl|VGATE-REVIEWER-001|reviewer-miss'
  )
  local row shape stype prompt code phrase bad_sink n=0
  for row in "${table[@]}"; do
    IFS='|' read -r shape stype prompt code phrase <<<"${row}"
    echo "row=${row}"
    n=$((n + 1))
    bad_sink="$(mint_bad_sink "${shape}" "${n}")" || skip "cannot make a ${shape} sink unwritable (root?)"
    run_hook_trace "${stype}" "${prompt}" "${bad_sink}"
    assert_status 2
    assert_contains "${code}"
    assert_contains "${phrase}"
  done
}

# LINE CAP — the prune bounds the sink; it is observability-only, so it may never alter a verdict.

@test "D06 prune: sink over the line cap is bounded at or below the cap" {
  for i in $(seq 1 12); do
    printf '2026-01-01T00:00:0%sZ\ttool_name=Agent\tsubagent_type=seed\tverdict=block-entry\n' "0" >>"${SINK}"
  done
  run_hook_trace "glass-atrium-dev-nestjs" "implement the auth refactor [SIZE-EST] bundles=1 tool_uses~=20 — svc" "${SINK}" 5
  assert_status 2
  after="$(count_sink)"
  [[ "${after}" -le 5 ]] || {
    echo "expected sink bounded at or below cap 5, got ${after}" >&2
    return 1
  }
}

# READER — operator aggregation mode, dispatched BEFORE the stdin drain.

@test "D06 reader: --block-counts over a fixture sink reports counts by verdict tag" {
  {
    printf 'ts\ttool_name=Agent\tsubagent_type=a\tverdict=block-entry\n'
    printf 'ts\ttool_name=Agent\tsubagent_type=b\tverdict=block-entry\n'
    printf 'ts\ttool_name=Agent\tsubagent_type=c\tverdict=block-reviewer\n'
    printf 'ts\ttool_name=Agent\tsubagent_type=d\tverdict=block-sizeest\n'
    printf 'ts\ttool_name=Agent\tsubagent_type=e\tverdict=block-sizeest\n'
    printf 'ts\ttool_name=Agent\tsubagent_type=f\tverdict=block-sizeest\n'
  } >"${SINK}"
  run bash -c 'VGATE_FIRED_LOG="$2" bash "$1" --block-counts' _ "${HOOK_SH}" "${SINK}"
  assert_status 0
  assert_contains "total=6"
  assert_contains "block-entry=2"
  assert_contains "block-reviewer=1"
  assert_contains "block-sizeest=3"
}

@test "D06 reader: absent sink reads as zeros, not missing data" {
  run bash -c 'VGATE_FIRED_LOG="$2" bash "$1" --block-counts' _ "${HOOK_SH}" "${BATS_TEST_TMPDIR}/nope.log"
  assert_status 0
  assert_contains "total=0"
  assert_contains "block-entry=0"
  assert_contains "block-reviewer=0"
  assert_contains "block-sizeest=0"
}

@test "D06 reader: reports without draining stdin (no operator hang)" {
  fifo="${BATS_TEST_TMPDIR}/stdin.fifo"
  mkfifo "${fifo}"
  # Holds the FIFO open for 5s without ever writing: a reader that drained stdin would block on it.
  sleep 5 >"${fifo}" &
  writer_pid=$!
  start="${SECONDS}"
  run bash -c 'VGATE_FIRED_LOG="$2" bash "$1" --block-counts <"$3"' _ "${HOOK_SH}" "${SINK}" "${fifo}"
  elapsed=$((SECONDS - start))
  kill "${writer_pid}" 2>/dev/null || true
  assert_status 0
  assert_contains "block-counts:"
  [[ "${elapsed}" -lt 4 ]] || {
    echo "reader blocked on stdin for ${elapsed}s (expected immediate report)" >&2
    return 1
  }
}

@test "D06 reader: read-only — invoking it appends nothing to the sink" {
  printf 'ts\ttool_name=Agent\tsubagent_type=a\tverdict=block-entry\n' >"${SINK}"
  before="$(count_sink)"
  run bash -c 'VGATE_FIRED_LOG="$2" bash "$1" --block-counts' _ "${HOOK_SH}" "${SINK}"
  assert_status 0
  assert_sink_delta 0 "${before}"
}

@test "D06 default sink: with no VGATE_FIRED_LOG override the trace lands under the data root" {
  run_hook "glass-atrium-dev-nestjs" "implement the auth refactor [SIZE-EST] bundles=1 tool_uses~=20 — svc"
  assert_status 2
  grep -q 'verdict=block-entry$' "${DATA_DIR}/verification-gate-fired.log" 2>/dev/null || {
    echo "expected the default sink at ${DATA_DIR}/verification-gate-fired.log to carry the block" >&2
    return 1
  }
}
