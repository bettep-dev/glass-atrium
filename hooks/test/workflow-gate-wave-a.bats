#!/usr/bin/env bats
# workflow-gate-wave-a.bats — pins the INSTRUMENTATION added to enforce-workflow-verify-stage.sh: the
#   two trace measurement fields (dev / impl_slots) and the two cardinality advisory tags (size-map /
#   entry-cardinality), plus the verdict-completeness corpus the instrumentation is measured against.
#
# The change under test decides NOTHING. Every assertion here is therefore written so that a wrong
# implementation cannot satisfy it while a verdict-neutral one can: each advisory criterion asserts its
# own POSITIVE firing (asserting `pass` is nearly worthless against a fail-open-dominant gate), and each
# additionally asserts the verdict is unchanged.
#
# HARNESS SPLIT (normative). L = the offline `--lint` preview, whose only observable is the exit status
#   — it returns from the trace emitter immediately and writes NO line, so any trace assertion on it
#   would be satisfied silently by an absent line. E = the live PreToolUse envelope with the trace log
#   redirected to a per-test temp file, whose observables are the exit status AND the appended line.
#   Criteria whose subject is a verdict TOKEN run on E even where the plan named L, because an exit
#   status cannot discriminate twelve block tokens; the deviation is noted at each such test.
#
# bats-1.13 LAST-COMMAND SEMANTICS (load-bearing, mirrors the sibling suites): a test fails ONLY on its
#   final command's exit, so every assertion is written `[[ ... ]] || return 1`.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/enforce-workflow-verify-stage.sh"
CORPUS_DIR="${BATS_TEST_DIRNAME}/corpus"
VERDICT_DIR="${CORPUS_DIR}/verdict"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-workflow-verify-stage.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  TRACE_LOG="${BATS_TEST_TMPDIR}/workflow-gate-fired.log"
  : >"${TRACE_LOG}"
}

# --- Harness E ------------------------------------------------------------------------------------
# Drive the hook AS a command (never `bash <path>`) with a real Workflow envelope wrapping $1.
run_hook_exec() {
  run bash -c '
    script="$1"; hook="$2"; trace="$3"
    payload="$(jq -n --arg s "${script}" '\''{tool_name:"Workflow",tool_input:{script:$s}}'\'')"
    printf "%s" "${payload}" | WORKFLOW_GATE_FIRED_LOG="${trace}" "${hook}"
  ' _ "${1}" "${HOOK_SH}" "${TRACE_LOG}"
}

# Same, script body read from a FILE so the exact bytes reach the hook.
run_hook_file_exec() {
  run bash -c '
    file="$1"; hook="$2"; trace="$3"
    payload="$(jq -n --rawfile s "${file}" '\''{tool_name:"Workflow",tool_input:{script:$s}}'\'')"
    printf "%s" "${payload}" | WORKFLOW_GATE_FIRED_LOG="${trace}" "${hook}"
  ' _ "${1}" "${HOOK_SH}" "${TRACE_LOG}"
}

# --- Harness L ------------------------------------------------------------------------------------
run_lint_file() {
  run bash -c '
    file="$1"; hook="$2"; trace="$3"
    WORKFLOW_GATE_FIRED_LOG="${trace}" "${hook}" --lint "${file}"
  ' _ "${1}" "${HOOK_SH}" "${TRACE_LOG}"
}

run_lint() {
  run bash -c '
    script="$1"; hook="$2"; trace="$3"
    printf "%s" "${script}" | WORKFLOW_GATE_FIRED_LOG="${trace}" "${hook}" --lint
  ' _ "${1}" "${HOOK_SH}" "${TRACE_LOG}"
}

# --- trace readers --------------------------------------------------------------------------------
# The value of TAB-field $1 (`verdict` / `advisory` / `dev` / `impl_slots`) on the LAST recorded line,
# or the literal MISSING when the field is absent.
last_field() {
  awk -F'\t' -v k="${1}=" '
    { line = $0 }
    END {
      n = split(line, f, "\t")
      for (i = 1; i <= n; i++) if (index(f[i], k) == 1) { print substr(f[i], length(k) + 1); exit }
      print "MISSING"
    }' "${TRACE_LOG}"
}

# The 1-based TAB-field INDEX of key $1 on the last line, or 0 when absent (positional assertions).
field_index() {
  awk -F'\t' -v k="${1}=" '
    { line = $0 }
    END {
      n = split(line, f, "\t")
      for (i = 1; i <= n; i++) if (index(f[i], k) == 1) { print i; exit }
      print 0
    }' "${TRACE_LOG}"
}

# Run a fixture FILE through Harness E and echo its recorded verdict token.
verdict_of_file() {
  : >"${TRACE_LOG}"
  run_hook_file_exec "${1}"
  last_field verdict
}

# --- shared fixtures ------------------------------------------------------------------------------
# In-script verify form with FOUR literal implementation spawns of one declared impl type. The verify
# pair is a different type, so no spawn is absorbed as a verify slot: slot count is exactly 4.
# $1 = the sizing-token block (occurrence count is what each caller varies).
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

size_token() { printf "log('[SIZE-EST] bundles=1 tool_uses~=10 — %s');\n" "${1}"; }

# ===================================================================================================
# AC1 — corpus completeness by verdict token, against the hook's OWN emit sites.
# ===================================================================================================
# HARNESS DEVIATION (stated): the plan names Harness L, whose sole observable is an exit status — it
# cannot discriminate twelve block tokens, and set equality is the assertion. Harness E is used so the
# produced set is read from the recorded verdict token itself.
@test "AC1: every content-producible verdict token the hook can emit is produced by some fixture" {
  local expected produced tok
  # Emit-site enumeration — the trace-tag assignments plus the two non-block tags, read from the hook
  # source rather than from a histogram of what live authors happened to trip.
  expected="$(
    {
      grep -o 'trace_tag="block-[a-z]*"' "${HOOK_SH}" | sed 's/.*"\(.*\)"/\1/'
      printf 'pass\n'
    } | sort -u
  )"
  # pass-noscript keys on script ABSENCE, so no fixture FILE can produce it — excluded from the domain.
  expected="$(printf '%s\n' "${expected}" | grep -v '^pass-noscript$' | sort -u)"
  produced=""
  for f in "${CORPUS_DIR}"/*.js "${VERDICT_DIR}"/*.js; do
    produced="${produced}$(verdict_of_file "${f}")"$'\n'
  done
  produced="$(printf '%s' "${produced}" | grep -v '^$' | sort -u)"
  for tok in ${expected}; do
    printf '%s\n' "${produced}" | grep -qx "${tok}" || {
      echo "AC1: no fixture produces verdict token: ${tok}" >&2
      echo "produced set: $(printf '%s' "${produced}" | tr '\n' ' ')" >&2
      return 1
    }
  done
  [[ -n "${expected}" ]] || return 1
}

# ===================================================================================================
# AC2 — every historically observed block reason is represented (presence only; the live counts are a
# property of 25 days of traffic, not of a fixture set, and are deliberately NOT matched).
# ===================================================================================================
@test "AC2: each historically observed reason is produced by at least one fixture" {
  local produced tok
  produced=""
  for f in "${CORPUS_DIR}"/*.js "${VERDICT_DIR}"/*.js; do
    produced="${produced}$(verdict_of_file "${f}")"$'\n'
  done
  for tok in block-declspawn block-norev block-undecl block-order block-nodecl block-grammar block-entry; do
    printf '%s' "${produced}" | grep -qx "${tok}" || {
      echo "AC2: observed reason unrepresented: ${tok}" >&2
      return 1
    }
  done
}

# ===================================================================================================
# AC4 — the two highest-volume verdicts pinned directly (13 of the 23 measured catches).
# ===================================================================================================
@test "AC4(norev): a declaration whose reviewer is never spawned blocks as block-norev" {
  run_hook_file_exec "${VERDICT_DIR}/block-norev.js"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "$(last_field verdict)" == "block-norev" ]] || return 1
}

@test "AC4(declspawn): a declared role with no spawn-position token blocks as block-declspawn" {
  run_hook_file_exec "${VERDICT_DIR}/block-declspawn.js"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "$(last_field verdict)" == "block-declspawn" ]] || return 1
}

# ===================================================================================================
# AC6' — slot-count equality, total over BOTH dispatch branches. Each fixture asserts the slot count
# as the LITERAL integer stated by the plan, never a value the implementation chose.
# AC6-ADV' rides the same fixtures: advisory present AND verdict unchanged.
# ===================================================================================================
@test "AC6'(i): 4 literal impl spawns vs 1 sizing entry — slots=4, size-map fires, verdict unchanged" {
  # Discriminator: fails any implementation that checks TYPE MEMBERSHIP instead of counting slots.
  run_hook_exec "$(four_slot_script "$(size_token 'one entry for four slots')")"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_field impl_slots)" == "4" ]] || return 1
  [[ "$(last_field advisory)" == *"size-map"* ]] || return 1
  [[ "$(last_field verdict)" == "pass" ]] || return 1
}

@test "AC6'(ii): the same script with 4 sizing entries — slots=4, size-map silent" {
  # Discriminator: fails an always-true condition.
  local tokens
  tokens="$(size_token 'slice one')$(size_token 'slice two')$(size_token 'slice three')$(size_token 'slice four')"
  run_hook_exec "$(four_slot_script "${tokens}")"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_field impl_slots)" == "4" ]] || return 1
  [[ "$(last_field advisory)" != *"size-map"* ]] || return 1
  [[ "$(last_field verdict)" == "pass" ]] || return 1
}

@test "AC6'(iii): 1 impl spawn vs 0 sizing entries — slots=1, size-map fires" {
  # Discriminator: fails a zero-entries blind spot. The verdict here is block-sizeest, which is the
  # PRE-EXISTING missing-token gate and not a product of the advisory — normalizing the occurrence
  # count would clear that gate, so the AC6-ADV' verdict-identity clause is inapplicable to this row
  # and the pre-existing token is asserted exactly instead.
  run_hook_file_exec "${VERDICT_DIR}/block-sizeest.js"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "$(last_field impl_slots)" == "1" ]] || return 1
  [[ "$(last_field advisory)" == *"size-map"* ]] || return 1
  [[ "$(last_field verdict)" == "block-sizeest" ]] || return 1
}

@test "AC6'(iv): upstream form, 2 impl spawns vs 1 sizing entry — slots=2, size-map fires" {
  # THE branch-totality discriminator: an implementation that computes the count only inside the
  # in-script branch raises here, the fail-open handler converts the raise to a pass, and the asserted
  # advisory never arrives.
  local script
  script="$(cat <<'EOF'
/* [AGENT-COMPOSITION]
verify: upstream clauded-docs/3634
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
log('plan-ref: clauded-docs/3634');
log('[SIZE-EST] bundles=1 tool_uses~=10 — one entry for two slots');
await agent('glass-atrium-qa-code-reviewer', { goal: 'spot-check the executed plan' });
await agent('glass-atrium-dev-shell', { goal: 'slice one' });
await agent('glass-atrium-dev-shell', { goal: 'slice two' });
EOF
  )"
  run_hook_exec "${script}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_field impl_slots)" == "2" ]] || return 1
  [[ "$(last_field advisory)" == *"size-map"* ]] || return 1
  [[ "$(last_field verdict)" == "pass" ]] || return 1
}

# The computed carve-out fixture, parameterised only over its sizing-entry count.
computed_carveout_script() {
  cat <<EOF
/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-shell
impl-computed: glass-atrium-dev-node
[/AGENT-COMPOSITION] */
log('plan-ref: clauded-docs/3634');
${1}
const BATCHES = [{ agent: 'glass-atrium-dev-node' }];
await parallel(
  agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' }),
  agent('glass-atrium-dev-nestjs',       { goal: 'judge -> feasible|infeasible' }),
);
await agent('glass-atrium-dev-shell', { goal: 'the one literal implementation slice' });
EOF
}

@test "AC6'(v-silent): 1 computed type + 1 literal impl spawn, 2 sizing entries — slots=2, silent" {
  # Discriminator: pins the zero-position carve-out — a computed type contributes exactly one slot.
  local tokens
  tokens="$(size_token 'literal slice')$(size_token 'computed fan-out')"
  run_hook_exec "$(computed_carveout_script "${tokens}")"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_field impl_slots)" == "2" ]] || return 1
  [[ "$(last_field advisory)" != *"size-map"* ]] || return 1
  [[ "$(last_field verdict)" == "pass" ]] || return 1
}

@test "AC6'(v-fires): the same script with 1 sizing entry — slots=2, size-map fires, verdict unchanged" {
  run_hook_exec "$(computed_carveout_script "$(size_token 'only one entry')")"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_field impl_slots)" == "2" ]] || return 1
  [[ "$(last_field advisory)" == *"size-map"* ]] || return 1
  # AC6-ADV' verdict-identity: normalizing the entry count to the slot count (the v-silent row above)
  # yields the same verdict, so the advisory decided nothing.
  [[ "$(last_field verdict)" == "pass" ]] || return 1
}

# ===================================================================================================
# AC7 — entry-cardinality fires at 4+ slots and NOT below. Both directions are required: the positive
# alone admits an always-fire implementation, the negative alone a never-fire one.
# ===================================================================================================
entry_card_script() {
  # $1 = the number of literal impl spawns to emit; the entry classification is always present.
  local n="${1}" spawns="" i
  i=1
  while [[ "${i}" -le "${n}" ]]; do
    spawns="${spawns}await agent('glass-atrium-dev-shell', { goal: 'slice ${i}' });"$'\n'
    i=$((i + 1))
  done
  cat <<EOF
/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-shell
[/AGENT-COMPOSITION] */
log('[ENTRY-CLASS] simple-task: multi-file=no cross-module=no turns<3 contract=no — small change');
log('[SIZE-EST] bundles=1 tool_uses~=10 — one entry');
await parallel(
  agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' }),
  agent('glass-atrium-dev-nestjs',       { goal: 'judge -> feasible|infeasible' }),
);
${spawns}
EOF
}

@test "AC7(positive): simple-task alongside 4 implementation slots records entry-cardinality" {
  run_hook_exec "$(entry_card_script 4)"
  [[ "$(last_field impl_slots)" == "4" ]] || return 1
  [[ "$(last_field advisory)" == *"entry-cardinality"* ]] || return 1
  # Verdict identical to the same script without the classification is `pass` either way — the token
  # only ever ADDS an entry signal, and the advisory adds nothing to the decision.
  [[ "$(last_field verdict)" == "pass" ]] || return 1
}

@test "AC7(negative): simple-task alongside 3 implementation slots records no such tag" {
  run_hook_exec "$(entry_card_script 3)"
  [[ "$(last_field impl_slots)" == "3" ]] || return 1
  [[ "$(last_field advisory)" != *"entry-cardinality"* ]] || return 1
  [[ "$(last_field verdict)" == "pass" ]] || return 1
}

# ===================================================================================================
# AC8 — the entry-cardinality condition NEVER alters the exit code. Satisfied by construction (a
# 4-slot script carrying the classification), never by forcing an internal flag.
# ===================================================================================================
@test "AC8: a script satisfying the entry-cardinality condition still exits 0" {
  run_hook_exec "$(entry_card_script 4)"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_field advisory)" == *"entry-cardinality"* ]] || return 1
}

@test "AC8(6 slots): a larger cardinality still exits 0 — the tag is advisory at any count" {
  run_hook_exec "$(entry_card_script 6)"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_field impl_slots)" == "6" ]] || return 1
  [[ "$(last_field advisory)" == *"entry-cardinality"* ]] || return 1
}

# ===================================================================================================
# AC10' — the non-DEV analysis-size consumer survives the advisory-field append. Required precisely
# because that consumer emits no verdict token, so no verdict-based criterion can see its regression.
# ===================================================================================================
@test "AC10'(silent): a non-DEV schema spawn WITH the bare token records no analysis-size tag" {
  local script
  script="$(cat <<'EOF'
const schema = { type: 'object', properties: { verdict: { type: 'string' } } };
log('[SIZE-EST] reads~=8 fields=2 effort=medium scope=allowlist — narrow audit');
await agent('glass-atrium-intel-researcher', { schema, goal: 'survey the three candidates' });
EOF
  )"
  run_hook_exec "${script}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_field advisory)" != *"analysis-size"* ]] || return 1
  [[ "$(last_field dev)" == "no" ]] || return 1
}

@test "AC10'(fires): the same spawn WITHOUT the bare token still records analysis-size" {
  local script
  script="$(cat <<'EOF'
const schema = { type: 'object', properties: { verdict: { type: 'string' } } };
await agent('glass-atrium-intel-researcher', { schema, goal: 'survey the three candidates' });
EOF
  )"
  run_hook_exec "${script}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_field advisory)" == *"analysis-size"* ]] || return 1
}

# ===================================================================================================
# AC11 — fail-open preservation under helper fault injection. The gate is fail-open dominant and that
# posture must survive, which is also why every new check above asserts its own positive firing.
# ===================================================================================================
@test "AC11: an unusable python3 on PATH still exits 0 (fail-open preserved)" {
  local stub_dir
  stub_dir="${BATS_TEST_TMPDIR}/stub"
  mkdir -p "${stub_dir}"
  printf '#!/bin/sh\nexit 9\n' >"${stub_dir}/python3"
  chmod +x "${stub_dir}/python3"
  run bash -c '
    file="$1"; hook="$2"; trace="$3"; stub="$4"
    PATH="${stub}:${PATH}" WORKFLOW_GATE_FIRED_LOG="${trace}" "${hook}" --lint "${file}"
  ' _ "${VERDICT_DIR}/block-norev.js" "${HOOK_SH}" "${TRACE_LOG}" "${stub_dir}"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "AC11(absent): no python3 on PATH at all still exits 0" {
  # A PATH holding every utility the hook shells out to EXCEPT python3 — an emptied PATH would fail
  # for the unrelated reason that `cat` is gone, which would pass this assertion for a wrong cause.
  local nopy_dir tool src
  nopy_dir="${BATS_TEST_TMPDIR}/nopy"
  mkdir -p "${nopy_dir}"
  # env + bash are required by the hook's own shebang resolution, not by its body.
  for tool in env bash sh cat dirname date grep tail mv rm mkdir mktemp jq base64; do
    src="$(command -v "${tool}" 2>/dev/null)" || continue
    ln -sf "${src}" "${nopy_dir}/${tool}"
  done
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  [[ ! -e "${nopy_dir}/python3" ]] || return 1
  run bash -c '
    file="$1"; hook="$2"; trace="$3"; nopy="$4"
    PATH="${nopy}" WORKFLOW_GATE_FIRED_LOG="${trace}" "${hook}" --lint "${file}"
  ' _ "${VERDICT_DIR}/block-norev.js" "${HOOK_SH}" "${TRACE_LOG}" "${nopy_dir}"
  [[ "${status}" -eq 0 ]] || return 1
}

# ===================================================================================================
# AC12 — string-literal inertness. A block quoted into a prompt template must stay inert.
# ===================================================================================================
@test "AC12: a composition block resident only in a string literal is treated as absent" {
  local script
  script="$(cat <<'EOF'
const worked = "[AGENT-COMPOSITION] verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-shell [/AGENT-COMPOSITION]";
log('plan-ref: clauded-docs/3634');
log('[SIZE-EST] bundles=1 tool_uses~=10 — one entry');
await agent('glass-atrium-dev-shell', { goal: 'implement', hint: worked });
EOF
  )"
  run_hook_exec "${script}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "$(last_field verdict)" == "block-nodecl" ]] || return 1
}

# ===================================================================================================
# AC13 — lint/live fidelity. The preview guarantee is what keeps the convention-surface cost low, so
# any divergence is zero-tolerance.
# ===================================================================================================
@test "AC13: --lint exit status equals the live gate decision for every corpus script" {
  local f lint_status live_status
  for f in "${CORPUS_DIR}"/*.js "${VERDICT_DIR}"/*.js; do
    run_lint_file "${f}"
    lint_status="${status}"
    : >"${TRACE_LOG}"
    run_hook_file_exec "${f}"
    live_status="${status}"
    [[ "${lint_status}" -eq "${live_status}" ]] || {
      echo "AC13 divergence on $(basename "${f}"): lint=${lint_status} live=${live_status}" >&2
      return 1
    }
  done
  [[ -n "${f}" ]] || return 1
}

@test "AC13(no trace): a --lint preview writes no trace line at all" {
  run_lint_file "${CORPUS_DIR}/variant_team.js"
  [[ "${status}" -eq 0 ]] || return 1
  [[ ! -s "${TRACE_LOG}" ]] || return 1
}

# ===================================================================================================
# AC14' — append safety and field correctness. Field ORDER is asserted positionally because a field
# inserted ahead of verdict= is the exact failure this criterion names, and a tally alone is blind
# to it. Field CORRECTNESS is load-bearing: a wrong count poisons the measurement.
# ===================================================================================================
@test "AC14'(order): the new fields sit AFTER advisory=, which sits after verdict=" {
  run_hook_file_exec "${CORPUS_DIR}/variant_team.js"
  local i_verdict i_advisory i_dev i_slots
  i_verdict="$(field_index verdict)"
  i_advisory="$(field_index advisory)"
  i_dev="$(field_index dev)"
  i_slots="$(field_index impl_slots)"
  [[ "${i_verdict}" -gt 0 && "${i_advisory}" -gt "${i_verdict}" ]] || return 1
  [[ "${i_dev}" -gt "${i_advisory}" && "${i_slots}" -gt "${i_dev}" ]] || return 1
}

@test "AC14'(tally): the verdict tally over a mixed-format log is unchanged by the new fields" {
  # A pre-change line (five fields) and a post-change line (seven) in one log must tally identically
  # to the same command over a log of pre-change lines only.
  local mixed pre
  mixed="${BATS_TEST_TMPDIR}/mixed.log"
  pre="${BATS_TEST_TMPDIR}/pre.log"
  printf '2026-08-01T00:00:00Z\ttool_name=Workflow\tverdict=pass\tscript_len=10\tadvisory=none\n' >"${pre}"
  cp "${pre}" "${mixed}"
  run_hook_file_exec "${CORPUS_DIR}/variant_team.js"
  cat "${TRACE_LOG}" >>"${mixed}"
  [[ "$(grep -c 'verdict=pass' "${mixed}")" -eq 2 ]] || return 1
  [[ "$(grep -c 'verdict=pass' "${pre}")" -eq 1 ]] || return 1
}

@test "AC14'(dev field): a non-DEV script records dev=no and a DEV script records dev=yes" {
  run_hook_exec "const x = 1; log('nothing to see');"
  [[ "$(last_field dev)" == "no" ]] || return 1
  [[ "$(last_field impl_slots)" == "0" ]] || return 1
  : >"${TRACE_LOG}"
  run_hook_file_exec "${CORPUS_DIR}/variant_team.js"
  [[ "$(last_field dev)" == "yes" ]] || return 1
}

@test "AC14'(slot correctness): both dispatch branches report the literal expected count" {
  # In-script branch: the four-slot fixture reports 4.
  run_hook_exec "$(four_slot_script "$(size_token 'one entry')")"
  [[ "$(last_field impl_slots)" == "4" ]] || return 1
  # Upstream branch: the real corpus upstream-form variant reports its own literal count.
  : >"${TRACE_LOG}"
  run_hook_file_exec "${CORPUS_DIR}/variant_team.js"
  [[ "$(last_field impl_slots)" == "1" ]] || return 1
}

@test "AC14'(pre-helper paths): an envelope with no script still records well-formed defaults" {
  run bash -c '
    hook="$1"; trace="$2"
    printf "%s" "{\"tool_name\":\"Workflow\",\"tool_input\":{}}" \
      | WORKFLOW_GATE_FIRED_LOG="${trace}" "${hook}"
  ' _ "${HOOK_SH}" "${TRACE_LOG}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_field verdict)" == "pass-noscript" ]] || return 1
  [[ "$(last_field dev)" == "no" ]] || return 1
  [[ "$(last_field impl_slots)" == "0" ]] || return 1
}

# ===================================================================================================
# AC15' — `impl-computed: none` remains malformed. Pins the corrected key table against the tool so
# the two cannot drift apart again.
# ===================================================================================================
@test "AC15'(none): impl-computed: none blocks as block-grammar" {
  local script
  script="$(cat <<'EOF'
/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
impl-computed: none
[/AGENT-COMPOSITION] */
log('plan-ref: clauded-docs/3634');
log('[SIZE-EST] bundles=1 tool_uses~=10 — one entry');
await parallel(
  agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' }),
  agent('glass-atrium-dev-nestjs',       { goal: 'judge -> feasible|infeasible' }),
);
await agent('glass-atrium-dev-nestjs', { goal: 'implement' });
EOF
  )"
  run_hook_exec "${script}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "$(last_field verdict)" == "block-grammar" ]] || return 1
}

@test "AC15'(omitted): the same declaration with the line omitted passes" {
  local script
  script="$(cat <<'EOF'
/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: glass-atrium-dev-nestjs
[/AGENT-COMPOSITION] */
log('plan-ref: clauded-docs/3634');
log('[SIZE-EST] bundles=1 tool_uses~=10 — one entry');
await parallel(
  agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' }),
  agent('glass-atrium-dev-nestjs',       { goal: 'judge -> feasible|infeasible' }),
);
await agent('glass-atrium-dev-nestjs', { goal: 'implement' });
EOF
  )"
  run_hook_exec "${script}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_field verdict)" == "pass" ]] || return 1
}

@test "AC15'(impl none): the none literal on impl: remains valid" {
  local script
  script="$(cat <<'EOF'
/* [AGENT-COMPOSITION]
verify: glass-atrium-qa-code-reviewer, glass-atrium-dev-nestjs
impl: none
[/AGENT-COMPOSITION] */
log('plan-ref: clauded-docs/3634');
log('[SIZE-EST] bundles=1 tool_uses~=10 — one entry');
await parallel(
  agent('glass-atrium-qa-code-reviewer', { goal: 'judge -> pass|revise' }),
  agent('glass-atrium-dev-nestjs',       { goal: 'judge -> feasible|infeasible' }),
);
EOF
  )"
  run_hook_exec "${script}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_field verdict)" == "pass" ]] || return 1
  # DEV-presence floor: `impl: none` scores no implementation slot, but a dev-* verify-team member is
  # statically spawned here and spends a real budget, so the count floors at one rather than reading
  # zero on a script that demonstrably spawns a DEV agent.
  [[ "$(last_field impl_slots)" == "1" ]] || return 1
}

# ===================================================================================================
# D13 re-adjudication — every pre-existing corpus fixture's verdict established by EXECUTION, not by
# its filename. passed_9599_resubmit.js blocks despite its name; that is the recorded expectation.
# ===================================================================================================
@test "D13: the seven pre-existing corpus fixtures produce their re-adjudicated verdicts" {
  [[ "$(verdict_of_file "${CORPUS_DIR}/variant_A.js")" == "pass" ]] || return 1
  [[ "$(verdict_of_file "${CORPUS_DIR}/variant_B.js")" == "pass" ]] || return 1
  [[ "$(verdict_of_file "${CORPUS_DIR}/variant_resubmit.js")" == "pass" ]] || return 1
  [[ "$(verdict_of_file "${CORPUS_DIR}/variant_team.js")" == "pass" ]] || return 1
  [[ "$(verdict_of_file "${CORPUS_DIR}/blocked_7938.js")" == "block-nodecl" ]] || return 1
  [[ "$(verdict_of_file "${CORPUS_DIR}/blocked_9599.js")" == "block-nodecl" ]] || return 1
  # The name says passed; the hardened gate says block-nodecl. Execution is the authority.
  [[ "$(verdict_of_file "${CORPUS_DIR}/passed_9599_resubmit.js")" == "block-nodecl" ]] || return 1
}

# ===================================================================================================
# VERDICT NEUTRALITY — the wave's central claim, asserted directly: adding the instrumentation changed
# no fixture's decision. The expected column is the re-adjudicated one above plus the eleven novel
# fixtures, each named with its own token.
# ===================================================================================================
@test "neutrality: every novel fixture blocks with exactly its named verdict token" {
  local f expected actual
  for f in "${VERDICT_DIR}"/block-*.js; do
    expected="$(basename "${f}" .js)"
    actual="$(verdict_of_file "${f}")"
    [[ "${actual}" == "${expected}" ]] || {
      echo "neutrality: $(basename "${f}") produced ${actual}, expected ${expected}" >&2
      return 1
    }
  done
}
