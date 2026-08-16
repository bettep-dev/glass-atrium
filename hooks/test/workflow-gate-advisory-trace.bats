#!/usr/bin/env bats
# workflow-gate-advisory-trace.bats — pins the firing-trace ADVISORY field added to
#   enforce-workflow-verify-stage.sh so the schema-cap advisory's promotion condition becomes
#   MEASURABLE. The condition's first clause ("zero adjudicated false positives across a full rolling
#   firing-log window") was unconstructible: the trace record carried four TAB-separated fields —
#   timestamp, tool_name, verdict, script_len — and no advisory signal of any kind, so no window
#   existed to adjudicate. This suite pins that a firing is now RECORDED, per rule, without promoting
#   the advisory and without touching any verdict or exit code.
#
# FROZEN HEAD OBSERVATION (produced by RUNNING the hook at f5c4883 against the R1 fixture below, not
# derived from the code's shape) — the trace line was exactly:
#   2026-07-31T13:58:34Z<TAB>tool_name=Workflow<TAB>verdict=pass<TAB>script_len=101
# Four fields, no advisory field. Every "fails at HEAD" claim here is measured against that line.
#
# bats-1.13 LAST-COMMAND SEMANTICS (load-bearing, mirrors the sibling suite): a test fails ONLY on its
#   final command's exit, so every assertion is written `[[ ... ]] || return 1`.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/enforce-workflow-verify-stage.sh"
SKILL_MD="${BATS_TEST_DIRNAME}/../../skills/glass-atrium-ops-orchestrator.md"

# Fixtures — one per scoped rule, plus the silent floor.
CAP_R1="const Out = { type: 'object', properties: { completion_block: { type: 'string', maxLength: 600 } } };"
CAP_R2="const Out = { properties: { rows: { items: { maxLength: 900 } } } };"
CAP_R3="const Out = { properties: { note: { maxLength: 120 } } };"
NO_CAP="const x = 1;"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "enforce-workflow-verify-stage.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  TRACE_LOG="${BATS_TEST_TMPDIR}/workflow-gate-fired.log"
}

# Drive the hook DIRECTLY as a command (never `bash <path>`) with a Workflow envelope wrapping $1.
# $2 (optional) overrides the hook binary.
run_hook_exec() {
  run bash -c '
    script="$1"; hook="$2"; trace="$3"
    payload="$(jq -n --arg s "${script}" '\''{tool_name:"Workflow",tool_input:{script:$s}}'\'')"
    printf "%s" "${payload}" | WORKFLOW_GATE_FIRED_LOG="${trace}" "${hook}"
  ' _ "${1}" "${2:-${HOOK_SH}}" "${TRACE_LOG}"
}

# Same, but the script body is read from a FILE so the exact bytes reach the hook.
run_hook_file_exec() {
  run bash -c '
    file="$1"; hook="$2"; trace="$3"
    payload="$(jq -n --rawfile s "${file}" '\''{tool_name:"Workflow",tool_input:{script:$s}}'\'')"
    printf "%s" "${payload}" | WORKFLOW_GATE_FIRED_LOG="${trace}" "${hook}"
  ' _ "${1}" "${2:-${HOOK_SH}}" "${TRACE_LOG}"
}

# The advisory field of the LAST recorded trace line, or the literal MISSING when absent.
last_advisory() {
  awk -F'\t' 'END { for (i = 1; i <= NF; i++) if (index($i, "advisory=") == 1) { print substr($i, 10); exit } print "MISSING" }' "${TRACE_LOG}"
}

@test "advisory-trace(R1): a completion-block cap records the schema-cap tag naming rule R1" {
  run_hook_exec "${CAP_R1}"
  [[ "${status}" -eq 0 ]] || return 1
  # Fails at HEAD: the frozen line above carries four fields, so last_advisory returns MISSING.
  [[ "$(last_advisory)" == "schema-cap:R1" ]] || {
    echo "advisory field = $(last_advisory); trace: $(cat "${TRACE_LOG}")" >&2
    return 1
  }
}

@test "advisory-trace(rules): the items-scoped and risk-band caps record R2 and R3 distinctly" {
  run_hook_exec "${CAP_R2}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_advisory)" == "schema-cap:R2" ]] || {
    echo "R2 fixture recorded $(last_advisory)" >&2
    return 1
  }
  run_hook_exec "${CAP_R3}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_advisory)" == "schema-cap:R3" ]] || {
    echo "R3 fixture recorded $(last_advisory)" >&2
    return 1
  }
}

# Backward compatibility is the whole risk of a field addition: the field goes LAST and every existing
# position keeps its meaning.
@test "advisory-trace(compat): the advisory field is field 5; fields 1-4 keep their positions" {
  run_hook_exec "${CAP_R1}"
  [[ "${status}" -eq 0 ]] || return 1
  local line nf
  line="$(tail -n 1 "${TRACE_LOG}")"
  nf="$(printf '%s' "${line}" | awk -F'\t' '{print NF}')"
  # At LEAST five: the contract is that the advisory field sits at position 5 and positions 1-4 keep
  # their meaning, not that the line never grows — later measurement fields append after it under the
  # same append-only contract, and pinning an exact width would forbid the very thing it permits.
  [[ "${nf}" -ge 5 ]] || {
    echo "expected at least 5 TAB fields, found ${nf}: ${line}" >&2
    return 1
  }
  printf '%s' "${line}" | awk -F'\t' '
    { ok = ($2 ~ /^tool_name=Workflow$/) && ($3 ~ /^verdict=/) && ($4 ~ /^script_len=/) && ($5 ~ /^advisory=/) }
    END { exit ok ? 0 : 1 }
  ' || {
    echo "field order drifted: ${line}" >&2
    return 1
  }
}

# The real downstream risk of widening a record: an EXISTING reader must still parse it. parse_gate_log
# splits on TAB and reads `verdict=` by key, so the widened line must count identically.
@test "advisory-trace(reader): compliance_telemetry.parse_gate_log still counts the widened line" {
  run_hook_exec "${CAP_R1}"
  [[ "${status}" -eq 0 ]] || return 1
  run_hook_exec "const s = { schema: {} }; agent('glass-atrium-dev-shell', { goal: 'x' });"
  [[ "${status}" -eq 2 ]] || return 1
  run python3 -c '
import sys
sys.path.insert(0, sys.argv[1])
from pathlib import Path
import compliance_telemetry as ct
counts = ct.parse_gate_log(Path(sys.argv[2]))
print(counts["pass"], counts["trip"], counts["total"])
' "${HOOKS_DIR}" "${TRACE_LOG}"
  [[ "${status}" -eq 0 ]] || {
    echo "reader failed: ${output}" >&2
    return 1
  }
  [[ "${output}" == "1 1 2" ]] || {
    echo "reader counts drifted: ${output}" >&2
    return 1
  }
}

# FALSE-POSITIVE FLOOR — the same probe that satisfies the promotion condition's second clause. The
# skill's copy-verbatim skeletons must record NO schema-cap tag.
@test "advisory-trace(floor): the skill's copy-verbatim skeletons record no schema-cap tag" {
  [[ -f "${SKILL_MD}" ]] || skip "skill file not found: ${SKILL_MD}"
  local outdir="${BATS_TEST_TMPDIR}/skill-fences"
  mkdir -p "${outdir}"
  awk -v dir="${outdir}" '
    /^[[:space:]]*```js/ { infence = 1; buf = ""; hasdecl = 0; next }
    /^[[:space:]]*```[[:space:]]*$/ {
      if (infence) {
        if (hasdecl) { n++; f = dir "/fence_" n ".js"; printf "%s", buf > f; close(f) }
        infence = 0
      }
      next
    }
    infence { buf = buf $0 "\n"; if ($0 ~ /\[AGENT-COMPOSITION\]/) hasdecl = 1 }
    END { print n + 0 }
  ' "${SKILL_MD}" >"${outdir}/.count"
  local count i
  count="$(cat "${outdir}/.count")"
  [[ "${count}" -ge 3 ]] || {
    echo "expected >=3 declaration-bearing skill skeletons, found ${count}" >&2
    return 1
  }
  for ((i = 1; i <= count; i++)); do
    run_hook_file_exec "${outdir}/fence_${i}.js"
    [[ "$(last_advisory)" != *"schema-cap"* ]] || {
      echo "FALSE POSITIVE: skill skeleton ${i} recorded $(last_advisory)" >&2
      return 1
    }
  done
  [[ -s "${TRACE_LOG}" ]] || return 1
}

@test "advisory-trace(silent): a workflow firing no advisory records advisory=none" {
  run_hook_exec "${NO_CAP}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "$(last_advisory)" == "none" ]] || {
    echo "expected none, got $(last_advisory)" >&2
    return 1
  }
}

# Several advisories on one firing join with a comma, so a window can be read per advisory kind.
@test "advisory-trace(multi): a schema-mode unhandled spawn plus a cap records both tags" {
  run_hook_exec "const S = { completion_block: { maxLength: 600 } };
const r = await agent('glass-atrium-intel-researcher', { goal: 'survey', schema: S });"
  [[ "${status}" -eq 0 ]] || return 1
  local adv
  adv="$(last_advisory)"
  [[ "${adv}" == *"schema-cap:R1"* && "${adv}" == *","* ]] || {
    echo "expected a comma-joined multi-advisory record, got ${adv}" >&2
    return 1
  }
}

# The preview path stays side-effect-free: --lint appends nothing even when an advisory fires.
@test "advisory-trace(preview): --lint fires the advisory yet appends zero trace lines" {
  run bash -c '
    script="$1"; hook="$2"; trace="$3"
    printf "%s" "${script}" | WORKFLOW_GATE_FIRED_LOG="${trace}" "${hook}" --lint
  ' _ "${CAP_R1}" "${HOOK_SH}" "${TRACE_LOG}"
  [[ "${status}" -eq 0 ]] || return 1
  [[ "${output}" == *"ADVISORY (schema-cap"* ]] || return 1
  [[ ! -e "${TRACE_LOG}" ]] || {
    echo "preview wrote a trace: $(cat "${TRACE_LOG}")" >&2
    return 1
  }
}

# The field inherits the emitter's fail-safe posture: a trace that cannot be written changes nothing.
@test "advisory-trace(failsafe): an unwritable trace path leaves verdict and exit unchanged" {
  local blocked_dir="${BATS_TEST_TMPDIR}/nowrite"
  mkdir -p "${blocked_dir}"
  chmod 500 "${blocked_dir}"
  run bash -c '
    script="$1"; hook="$2"; trace="$3"
    payload="$(jq -n --arg s "${script}" '\''{tool_name:"Workflow",tool_input:{script:$s}}'\'')"
    printf "%s" "${payload}" | WORKFLOW_GATE_FIRED_LOG="${trace}" "${hook}"
  ' _ "${CAP_R1}" "${HOOK_SH}" "${blocked_dir}/sub/t.log"
  chmod 700 "${blocked_dir}"
  [[ "${status}" -eq 0 ]] || {
    echo "fail-safe broken: exit ${status}" >&2
    return 1
  }
  [[ "${output}" == *"ADVISORY (schema-cap"* ]] || return 1
}
