#!/usr/bin/env bats
# inject-scope-rules-nodrop.bats — recurrence-prevention pin for the SubagentStart slot-1 ceiling.
#
#   Slot 1 carries the non-droppable emit/meter pair plus the roster-gated wiki-untrusted and budget
#   blocks; scope-file text rides the part slots. This suite PINS, against the REAL repo
#   sources with the meter ON: every DEV agent's slot 1 is EXACTLY emit + meter (+ budget-dev for a
#   BUDGET_DEV_AGENTS member) with ZERO drops — a byte sum measured in the same run, so any extra
#   block (a retired one creeping back, or a new one) breaks equality. The BUDGET-DEV source block
#   additionally carries a byte contract pinned numerically below.
#
#   REAL-SOURCE wiring: the hook's BUDGET_SRC / WIKI_UNTRUSTED_SRC / AGENTS_DIR env overrides point
#   at the repo files + real agents/ frontmatter (maxTurns → the real meter size). The drop log,
#   spawn counter and manifest sink are redirected into the Bats tmpdir.
#
#   HOST INVARIANCE: no expectation here is a literal byte count. The assembled context carries no
#   absolute path (the block leads use `~/`), and every size is derived from an emit of the same run.
#
# BATS GATING NOTE: @test bodies run under errexit; a mid-body bare `[[ ]]` / `(( ))` is inert on
#   bash 3.2.57 but GATES on CI's bash 5.3.9 — `[ ]` and plain commands gate on BOTH (measured,
#   bats 1.13.0 on both legs, so bash is the variable, not bats). Every assertion is guarded with a
#   helper that `return 1`s on mismatch, so EACH one independently fails.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/inject-scope-rules.sh"
REPO_ROOT="${BATS_TEST_DIRNAME}/../.."

# Real repo sources (single source of truth for the injected blocks).
BUDGET_SRC="${REPO_ROOT}/scoped/shared-turn-budget.md"   # BUDGET-DEV + BUDGET-ANALYSIS both live here
WIKI_UNTRUSTED_SRC="${REPO_ROOT}/rules/glass-atrium/core-wiki-reference.md"
AGENTS_DIR="${REPO_ROOT}/agents"

# The ceiling constant the hook enforces — kept in sync with inject-scope-rules.sh:INJECT_CTX_MAX_BYTES.
CEILING=9984
# BUDGET-DEV source-block byte contract (hard bound; target 260B) — a guard on this block's growth.
BUDGET_DEV_MAX_BYTES=300

# Stable first-line needles for the slot-1 blocks.
EMIT_NEEDLE="REQUIRED by the outcome recorder"
METER_NEEDLE="Turn-budget meter"
BUDGET_DEV_NEEDLE="Budget sizing (auto-injected DEV"
BUDGET_ANALYSIS_NEEDLE="Budget sizing (auto-injected analysis"
WIKI_UNTRUSTED_NEEDLE="Wiki raw-store untrusted-data clause"

# Leads of the five blocks slot 1 no longer extracts — the part slots deliver their sources.
# The "Plan-gate verdict" entry cannot fail: that lead exists in no source. The guard is the
# retired plan-gate case in hooks/test/inject-scope-rules.bats, which plants the block's
# marker pair and asserts slot 1 omits it.
RETIRED_NEEDLES=(
  "Comment-rule core"
  "style_ref emit"
  "Minimalism reflex"
  "Naming delta-core"
  "Plan-gate verdict"
)

DEV_AGENTS=(
  glass-atrium-dev-front glass-atrium-dev-react glass-atrium-dev-angular glass-atrium-dev-gsap
  glass-atrium-dev-android glass-atrium-dev-nestjs glass-atrium-dev-node glass-atrium-dev-python
  glass-atrium-dev-db glass-atrium-dev-rag glass-atrium-dev-animator glass-atrium-dev-shell
  glass-atrium-dev-swift
)
# The four daemon-carrier agents excluded from BUDGET_DEV_AGENTS (their bodies keep daemon-evolved
# in-body budget bullets) — kept in sync with inject-scope-rules.sh:BUDGET_DEV_AGENTS rationale.
BUDGET_DEV_CARRIERS=" glass-atrium-dev-nestjs glass-atrium-dev-python glass-atrium-dev-react glass-atrium-dev-shell "

setup() {
  # A pin target that VANISHED is the most complete form of the drift this suite exists to
  # catch, and `skip` is exactly the wrong answer to it: bats scores a skip as `ok` and the run
  # still exits 0, so a deleted or moved pin target would make this suite go quiet and green.
  # Every path below is one the repository always ships, so its absence is drift and FAILS.
  local required
  for required in "${HOOK_SH}" "${BUDGET_SRC}" "${WIKI_UNTRUSTED_SRC}" "${AGENTS_DIR}"; do
    [[ -e "${required}" ]] || {
      printf 'pin target absent: %s — the repository always ships it, so this is drift, not an optional dependency\n' \
        "${required}" >&2
      return 1
    }
  done
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"

  # T7: the drop-rate denominator counter defaults under ~/.claude/logs and writes on EVERY spawn —
  # sandbox it into the Bats tmpdir (exported → inherited through each run helper's `env`).
  export INJECT_SCOPE_RULES_SPAWN_COUNTER="${BATS_TEST_TMPDIR}/inject-spawns.count"

  # C03: the positive-injection manifest sink writes on EVERY spawn and defaults under the live
  # ~/.glass-atrium/logs — sandbox it too (exported → inherited through each run helper's `env`).
  export INJECT_SCOPE_RULES_MANIFEST_LOG="${BATS_TEST_TMPDIR}/inject-manifest.log"
}

# Drive the hook with a SubagentStart envelope for $1, assembling from the REAL repo sources with the
# meter ON. The drop log goes to the Bats tmpdir.
run_hook_real() {
  local agent="${1}" droplog="${BATS_TEST_TMPDIR}/inject-drop.log"
  run bash -c '
    agent="$1"; hook="$2"; budget="$3"; wiki="$4"; agents="$5"; droplog="$6"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env -u SUBAGENT_BUDGET_METER_OFF \
      INJECT_SCOPE_RULES_BUDGET_SRC="${budget}" \
      INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC="${wiki}" \
      INJECT_SCOPE_RULES_AGENTS_DIR="${agents}" \
      INJECT_SCOPE_RULES_DROP_LOG="${droplog}" \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${BUDGET_SRC}" "${WIKI_UNTRUSTED_SRC}" "${AGENTS_DIR}" "${droplog}"
}

# The additionalContext text one hook run emits for $1 under the extra env assignments in $2..; a
# sandboxed drop log. stdout: the context, no trailing newline.
emit_ctx() {
  local agent="${1}"
  shift
  printf '%s' "$(jq -nc --arg a "${agent}" '{agent_type:$a}')" | env -u SUBAGENT_BUDGET_METER_OFF "$@" \
    INJECT_SCOPE_RULES_DROP_LOG="${BATS_TEST_TMPDIR}/measure-drop.log" \
    bash "${HOOK_SH}" 2>/dev/null | jq -j '.hookSpecificOutput.additionalContext // empty'
}

# Emit-only context (meter OFF, no block source).
emit_base_ctx() {
  emit_ctx "${1}" SUBAGENT_BUDGET_METER_OFF=1 \
    INJECT_SCOPE_RULES_BUDGET_SRC=/nonexistent INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC=/nonexistent \
    INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent INJECT_SCOPE_RULES_CTX_MAX_BYTES=20000
}

# Emit + separator + meter context (real maxTurns frontmatter, no block source).
emit_meter_ctx() {
  emit_ctx "${1}" \
    INJECT_SCOPE_RULES_BUDGET_SRC=/nonexistent INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC=/nonexistent \
    INJECT_SCOPE_RULES_AGENTS_DIR="${AGENTS_DIR}" INJECT_SCOPE_RULES_CTX_MAX_BYTES=20000
}

# Emit-only base byte count.
measure_base_bytes() {
  emit_base_ctx "${1}" | wc -c | tr -cd '0-9'
}

measure_emit_meter_bytes() {
  emit_meter_ctx "${1}" | wc -c | tr -cd '0-9'
}

# Extract the BUDGET-DEV block exactly as the hook's extract_block does (sed range + marker strip; the
# command substitution drops the trailing newline, as the hook's own capture does). stdout: block text.
extract_budget_dev_block() {
  sed -n '/<!-- AGENT-INJECT:BUDGET-DEV:START -->/,/<!-- AGENT-INJECT:BUDGET-DEV:END -->/p' "${BUDGET_SRC}" \
    | grep -vxF '<!-- AGENT-INJECT:BUDGET-DEV:START -->' \
    | grep -vxF '<!-- AGENT-INJECT:BUDGET-DEV:END -->'
}

# additionalContext string from the hook's JSON stdout (empty if no JSON emitted).
ctx_of() {
  printf '%s' "${output}" | python3 -c '
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        d = json.loads(line)
    except ValueError:
        continue
    sys.stdout.write(d.get("hookSpecificOutput", {}).get("additionalContext", ""))
    break
' 2>/dev/null
}

# Per-assertion gate helpers — an explicit `return 1` gates on every bash (see header note).
assert_status() {
  [[ "${status}" -eq "${1}" ]] || { echo "expected status ${1}, got ${status} (output: ${output})" >&2; return 1; }
}
assert_ctx_contains() {
  local ctx; ctx="$(ctx_of)"
  [[ "${ctx}" == *"${1}"* ]] || { echo "expected additionalContext to contain [${1}]" >&2; return 1; }
}
assert_ctx_not_contains() {
  local ctx; ctx="$(ctx_of)"
  [[ "${ctx}" != *"${1}"* ]] || { echo "expected additionalContext to NOT contain [${1}]" >&2; return 1; }
}
assert_no_retired_block() {
  local needle
  for needle in "${RETIRED_NEEDLES[@]}"; do
    assert_ctx_not_contains "${needle}" || return 1
  done
}
# Zero drop-loop iterations: the hook prints the drop diagnostic to stderr (merged into $output by
# bats) ONLY when it sheds a block. Its ABSENCE proves no block was dropped.
assert_no_drop() {
  [[ "${output}" != *"injected context exceeded"* ]] || { echo "a block was DROPPED (ceiling exceeded): ${output}" >&2; return 1; }
  [[ "${output}" != *"dropped "* ]] || { echo "a block was DROPPED: ${output}" >&2; return 1; }
}
ctx_bytes_of() {
  printf '%s' "$(ctx_of)" | wc -c | tr -cd '0-9'
}
# The assembled context byte length must not exceed the ceiling (byte-accurate via wc -c, matching
# the hook's own byte_len). Directly corroborates the fit.
assert_ctx_within_ceiling() {
  local bytes; bytes="$(ctx_bytes_of)"
  [[ -n "${bytes}" && "${bytes}" -le "${CEILING}" ]] || { echo "ctx ${bytes}B exceeds ceiling ${CEILING}B" >&2; return 1; }
}

# (a) Every DEV agent: slot 1 is exactly emit + meter (+ budget-dev for a roster member), zero drops.
#     The sum is derived per agent from this run's own emits, so it holds on any host and any root.

@test "every DEV agent (real sources, meter ON) → slot 1 == emit + 2 + meter [+ 2 + budget-dev], zero drops" {
  local agent emit_meter_bytes budget_bytes expected actual budget_block
  budget_block="$(extract_budget_dev_block)"
  [[ "${budget_block}" == *"${BUDGET_DEV_NEEDLE}"* ]] || { echo "BUDGET-DEV extraction empty (markers moved?)" >&2; return 1; }
  budget_bytes="$(printf '%s' "${budget_block}" | wc -c | tr -cd '0-9')"
  for agent in "${DEV_AGENTS[@]}"; do
    emit_meter_bytes="$(measure_emit_meter_bytes "${agent}")"
    [[ -n "${emit_meter_bytes}" && "${emit_meter_bytes}" -gt "$(measure_base_bytes "${agent}")" ]] \
      || { echo "FAIL agent=${agent} (meter did not add bytes: ${emit_meter_bytes})" >&2; return 1; }
    run_hook_real "${agent}"
    assert_status 0                         || { echo "FAIL agent=${agent} (status)" >&2; return 1; }
    assert_no_drop                          || { echo "FAIL agent=${agent} (drop)" >&2; return 1; }
    assert_ctx_contains "${EMIT_NEEDLE}"    || { echo "FAIL agent=${agent} (emit)" >&2; return 1; }
    assert_ctx_contains "${METER_NEEDLE}"   || { echo "FAIL agent=${agent} (meter)" >&2; return 1; }
    assert_no_retired_block                 || { echo "FAIL agent=${agent} (retired block present)" >&2; return 1; }
    if [[ "${BUDGET_DEV_CARRIERS}" == *" ${agent} "* ]]; then
      assert_ctx_not_contains "${BUDGET_DEV_NEEDLE}" || { echo "FAIL agent=${agent} (budget-dev leaked to carrier)" >&2; return 1; }
      expected="${emit_meter_bytes}"
    else
      assert_ctx_contains "${BUDGET_DEV_NEEDLE}"     || { echo "FAIL agent=${agent} (budget-dev)" >&2; return 1; }
      expected=$((emit_meter_bytes + 2 + budget_bytes))
    fi
    actual="$(ctx_bytes_of)"
    [[ "${actual}" -eq "${expected}" ]] || {
      echo "FAIL agent=${agent}: slot 1 is ${actual}B, the measured block sum is ${expected}B — an extra or missing block" >&2
      return 1
    }
  done
}

# (b) The pin's own non-vacuity: the emit+meter measurement really is emit + 2 + meter, i.e. emit-only
#     is a strict prefix of it. Without this, (a) could compare two equally wrong sums.

@test "dev-front measurement chain: emit-only + separator opens emit + meter, which opens slot 1" {
  emit_base_ctx glass-atrium-dev-front >"${BATS_TEST_TMPDIR}/emit.txt"
  emit_meter_ctx glass-atrium-dev-front >"${BATS_TEST_TMPDIR}/emit-meter.txt"
  run_hook_real "glass-atrium-dev-front"
  assert_status 0 || return 1
  ctx_of >"${BATS_TEST_TMPDIR}/slot1.txt"
  python3 -c '
import sys
emit, em, slot1 = (open(p, "rb").read() for p in sys.argv[1:4])
meter_lead = b"\n\n**" + sys.argv[4].encode()
sys.exit(0 if emit and em.startswith(emit + meter_lead) and slot1.startswith(em) else 1)
' "${BATS_TEST_TMPDIR}/emit.txt" "${BATS_TEST_TMPDIR}/emit-meter.txt" "${BATS_TEST_TMPDIR}/slot1.txt" "${METER_NEEDLE}" || {
    echo "measurement chain broken: emit + separator + meter lead does not open emit+meter, or emit+meter does not open slot 1" >&2
    return 1
  }
}

# (c) qa-code-reviewer (BUDGET-ANALYSIS + wiki-untrusted rosters) → those two + emit + meter, zero drops.

@test "qa-code-reviewer (real sources) → budget-analysis + wiki-untrusted injected, no retired block, zero drops" {
  run_hook_real "glass-atrium-qa-code-reviewer"
  assert_status 0                                 || return 1
  assert_no_drop                                  || return 1
  assert_ctx_contains "${BUDGET_ANALYSIS_NEEDLE}" || return 1
  assert_ctx_contains "${WIKI_UNTRUSTED_NEEDLE}"  || return 1
  assert_ctx_not_contains "${BUDGET_DEV_NEEDLE}"  || return 1
  assert_no_retired_block                         || return 1
  assert_ctx_within_ceiling                       || return 1
}

# (c2) intel-planner — BUDGET_ANALYSIS_AGENTS member: the budget-analysis block reaches an analysis
# consumer, and no DEV-only block leaks to it.

@test "intel-planner (real sources) → budget-analysis injected, zero drops" {
  run_hook_real "glass-atrium-intel-planner"
  assert_status 0                                  || return 1
  assert_no_drop                                   || return 1
  assert_ctx_contains "${BUDGET_ANALYSIS_NEEDLE}"  || return 1
  assert_ctx_not_contains "${BUDGET_DEV_NEEDLE}"   || return 1
  assert_no_retired_block                          || return 1
  assert_ctx_within_ceiling                        || return 1
}

# (c3) Numeric source-contract pin (D3/AC9): the extracted BUDGET-DEV block MUST stay <=300B, so its
# growth fails HERE, at the source. Extraction mirrors the hook's extract_block.

@test "BUDGET-DEV source block byte contract: extracted block non-empty and <= ${BUDGET_DEV_MAX_BYTES}B" {
  local block bytes
  block="$(extract_budget_dev_block)"
  [[ "${block}" == *"${BUDGET_DEV_NEEDLE}"* ]] || {
    echo "BUDGET-DEV extraction empty or needle missing (markers moved?): [${block}]" >&2
    return 1
  }
  bytes="$(printf '%s' "${block}" | wc -c | tr -cd '0-9')"
  [[ -n "${bytes}" && "${bytes}" -le "${BUDGET_DEV_MAX_BYTES}" ]] || {
    echo "BUDGET-DEV source block ${bytes}B exceeds the ${BUDGET_DEV_MAX_BYTES}B byte contract" >&2
    return 1
  }
}

# (d) No drop marker file is created on the happy path (a drop is a genuine regression signal only).

@test "happy path leaves no persisted drop marker" {
  run_hook_real "glass-atrium-dev-front"
  assert_status 0 || return 1
  [[ ! -s "${BATS_TEST_TMPDIR}/inject-drop.log" ]] || { echo "unexpected drop marker written: $(cat "${BATS_TEST_TMPDIR}/inject-drop.log")" >&2; return 1; }
}

# (e) A populated lesson store reaches no prompt: slot 1 and the manifest record of a real dev-front
#     spawn stay exactly what a store-free spawn produces. The store sits at both the retired override
#     path and the former default under the data root, so neither route can feed it back.

@test "a populated lesson store leaves slot 1 and the manifest record unchanged (real dev-front)" {
  local data_root store without
  data_root="${BATS_TEST_TMPDIR}/data-root"
  store="${data_root}/data/lessons.json"
  mkdir -p "${data_root}/data"
  export GA_DATA_ROOT="${data_root}" INJECT_SCOPE_RULES_LESSONS_SRC="${store}"

  run_hook_real "glass-atrium-dev-front"
  assert_status 0 || return 1
  without="$(ctx_of)"
  [[ -n "${without}" ]] || { echo "store-free spawn injected nothing" >&2; return 1; }

  python3 -c '
import json, sys
row = {"agent": "glass-atrium-dev-front", "task_type": "bug-fix", "score": 5, "frequency": 9}
json.dump({"ctm": [dict(row, text="CTM_RECALL_SENTINEL")], "epm": [dict(row, text="EPM_RECALL_SENTINEL")]},
          open(sys.argv[1], "w"))
' "${store}"
  run_hook_real "glass-atrium-dev-front"
  assert_status 0 || return 1
  assert_no_drop  || return 1
  [[ "$(ctx_of)" == "${without}" ]] || {
    echo "slot 1 changed once the store held lessons: $(ctx_bytes_of)B vs $(printf '%s' "${without}" | wc -c | tr -cd '0-9')B" >&2
    return 1
  }
  [[ "$(grep -c ' MANIFEST ' "${INJECT_SCOPE_RULES_MANIFEST_LOG}" || true)" == "2" ]] || {
    echo "expected 2 manifest lines: $(cat "${INJECT_SCOPE_RULES_MANIFEST_LOG}" 2>/dev/null)" >&2
    return 1
  }
  ! grep -Eq ' lessons=| lesson_truncated=|[=;]lesson:' "${INJECT_SCOPE_RULES_MANIFEST_LOG}" || {
    echo "manifest records a lesson: $(cat "${INJECT_SCOPE_RULES_MANIFEST_LOG}")" >&2
    return 1
  }
}
