#!/usr/bin/env bats
# inject-scope-rules.bats — Bats suite for the SubagentStart inject-scope-rules.sh runtime path.
#   This covers the HOOK's runtime injection (test_inject_sync.py covers only the reconcile tooling
#   that maintains the tracked rosters — it does NOT exercise the hook). Focus = the roster-gated
#   slot-1 blocks: the two BUDGET blocks (BUDGET-DEV → DEV(9, minus the four daemon carriers) ·
#   BUDGET-ANALYSIS → 6 curated analysis consumers) and wiki-untrusted, the ceiling drop order across
#   the droppable blocks, and the five retired scope blocks staying out of slot 1.
#
# Input is the real SubagentStart envelope parsed by the hook: {"agent_type":"<type>"} (read via
#   hook_get_field). Built with jq so the field is escaped safely.
# Env sandbox: AGENTS_DIR → /nonexistent (no maxTurns lookup) and SUBAGENT_BUDGET_METER_OFF=1 so the
#   universal budget-meter block is suppressed — this isolates the roster-block assertions. The budget
#   and wiki-untrusted sources default to HERMETIC in-sandbox fixtures built in setup() (NOT the
#   HOME-anchored real files, absent under a CI checkout) unless a test overrides them.
#
# BATS GATING NOTE: @test bodies run under errexit; a mid-body bare `[[ ]]` / `(( ))` is inert on
#   bash 3.2.57 but GATES on CI's bash 5.3.9 — `[ ]` and plain commands gate on BOTH (measured,
#   bats 1.13.0 on both legs, so bash is the variable, not bats). Every assertion below is guarded
#   with a helper that `return 1`s on mismatch, so EACH one independently fails the test.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/inject-scope-rules.sh"

# The always-on [COMPLETION] emit-format directive needle — a stable, bracket-free substring unique
# to the emit block. This block is delivered to EVERY agent_type independent of
# SUBAGENT_BUDGET_METER_OFF and of maxTurns (the PRIMARY fix for schema-mode/workflow subagents
# emitting the inline single-line [COMPLETION] form).
EMIT_NEEDLE="REQUIRED by the outcome recorder"
METER_NEEDLE="Turn-budget meter"

# The two BUDGET block marker pairs (mirror hooks/inject-scope-rules.sh anchors) + distinct needles.
# BOTH blocks live in ONE source file in production (shared-turn-budget.md) — the fixture mirrors that.
BUDGET_DEV_MARKER_START='<!-- AGENT-INJECT:BUDGET-DEV:START -->'
BUDGET_DEV_MARKER_END='<!-- AGENT-INJECT:BUDGET-DEV:END -->'
BUDGET_ANALYSIS_MARKER_START='<!-- AGENT-INJECT:BUDGET-ANALYSIS:START -->'
BUDGET_ANALYSIS_MARKER_END='<!-- AGENT-INJECT:BUDGET-ANALYSIS:END -->'
BUDGET_DEV_NEEDLE="BUDGET-DEV-CORE-BODY"
BUDGET_ANALYSIS_NEEDLE="BUDGET-ANALYSIS-CORE-BODY"

WIKI_MARKER_START='<!-- AGENT-INJECT:WIKI-UNTRUSTED:START -->'
WIKI_MARKER_END='<!-- AGENT-INJECT:WIKI-UNTRUSTED:END -->'
WIKI_NEEDLE="WIKI-UNTRUSTED-CORE-BODY"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "inject-scope-rules.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"

  # T7: the drop-rate denominator counter defaults under ~/.claude/logs and writes on EVERY spawn —
  # sandbox it into the Bats tmpdir (exported → inherited through each run helper's `env`). The drop
  # sink shares the same live-path risk: the ceiling-drop tests below force real drops, so redirect it
  # too — neither the counter nor the sink may touch live ~/.claude.
  export INJECT_SCOPE_RULES_SPAWN_COUNTER="${BATS_TEST_TMPDIR}/inject-spawns.count"
  export INJECT_SCOPE_RULES_DROP_LOG="${BATS_TEST_TMPDIR}/inject-drop.log"

  # C03: the positive-injection manifest sink writes on EVERY spawn and defaults under the live
  # ~/.glass-atrium/logs — sandbox it too (exported → inherited through each run helper's `env`).
  export INJECT_SCOPE_RULES_MANIFEST_LOG="${BATS_TEST_TMPDIR}/inject-manifest.log"

  # Hermetic BUDGET source fixture — one file, BOTH marker pairs (mirrors shared-turn-budget.md).
  # The HOME-anchored real file is absent in CI.
  BUDGET_FIXTURE="${BATS_TEST_TMPDIR}/turn-budget.md"
  printf '%s\n' \
    'budget preamble (must not reach the child)' \
    "${BUDGET_DEV_MARKER_START}" \
    "${BUDGET_DEV_NEEDLE}" \
    "${BUDGET_DEV_MARKER_END}" \
    "${BUDGET_ANALYSIS_MARKER_START}" \
    "${BUDGET_ANALYSIS_NEEDLE}" \
    "${BUDGET_ANALYSIS_MARKER_END}" \
    'budget trailer (must not reach the child)' >"${BUDGET_FIXTURE}"

  # Hermetic wiki-untrusted source fixture — same rationale as the budget fixture.
  WIKI_FIXTURE="${BATS_TEST_TMPDIR}/wiki-reference.md"
  printf '%s\n' 'wiki preamble' "${WIKI_MARKER_START}" "${WIKI_NEEDLE}" "${WIKI_MARKER_END}" 'wiki trailer' \
    >"${WIKI_FIXTURE}"
}

# Drive the hook with a SubagentStart envelope wrapping $1 (agent_type). AGENTS_DIR is sandboxed to
# /nonexistent and the meter is off, isolating the roster blocks. $2 (optional) overrides
# INJECT_SCOPE_RULES_BUDGET_SRC and $3 (optional) INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC; both default
# to the hermetic fixtures built in setup().
run_hook() {
  local agent="${1}" budget_src="${2:-${BUDGET_FIXTURE}}" wiki_src="${3:-${WIKI_FIXTURE}}"
  run bash -c '
    agent="$1"; hook="$2"; budget_src="$3"; wiki_src="$4"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      SUBAGENT_BUDGET_METER_OFF=1 \
      INJECT_SCOPE_RULES_BUDGET_SRC="${budget_src}" \
      INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC="${wiki_src}" \
      INJECT_SCOPE_RULES_LESSONS_SRC=/nonexistent \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${budget_src}" "${wiki_src}"
}

# Extract the additionalContext string from the hook's JSON stdout (empty if no JSON emitted).
# Operates on $output (bats merges stdout+stderr, but the only JSON line is the hook's stdout).
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
    print(d.get("hookSpecificOutput", {}).get("additionalContext", ""))
    break
' 2>/dev/null
}

# Per-assertion gate helpers — an explicit `return 1` gates on every bash (see header note).
assert_status() {
  [[ "${status}" -eq "${1}" ]] || {
    echo "expected status ${1}, got ${status} (output: ${output})" >&2
    return 1
  }
}
assert_ctx_contains() {
  local ctx; ctx="$(ctx_of)"
  [[ "${ctx}" == *"${1}"* ]] || {
    echo "expected additionalContext to contain [${1}], got: [${ctx}]" >&2
    return 1
  }
}
assert_ctx_not_contains() {
  local ctx; ctx="$(ctx_of)"
  [[ "${ctx}" != *"${1}"* ]] || {
    echo "expected additionalContext to NOT contain [${1}], got: [${ctx}]" >&2
    return 1
  }
}

# (a) BUDGET rosters — BUDGET-DEV goes to DEV(9) minus the four daemon carriers (dev-nestjs,
# dev-python, dev-react, dev-shell keep daemon-evolved in-body bullets — injecting on top would
# double-deliver); BUDGET-ANALYSIS goes to the 6 curated analysis consumers (intel-researcher is
# a carrier, qa-debugger was never a recipient). Both blocks share ONE source file, mirrored by
# the hermetic BUDGET_FIXTURE.

@test "dev-front (BUDGET_DEV_AGENTS member) → budget-dev block injected, exit 0" {
  run_hook "glass-atrium-dev-front"
  assert_status 0
  assert_ctx_contains "${BUDGET_DEV_NEEDLE}"
  assert_ctx_not_contains "${BUDGET_ANALYSIS_NEEDLE}"
}

@test "dev-swift (BUDGET_DEV_AGENTS member) → budget-dev block injected, exit 0" {
  run_hook "glass-atrium-dev-swift"
  assert_status 0
  assert_ctx_contains "${BUDGET_DEV_NEEDLE}"
}

@test "dev-react (daemon carrier, NOT in BUDGET_DEV_AGENTS) → no budget-dev block, exit 0" {
  run_hook "glass-atrium-dev-react"
  assert_status 0
  assert_ctx_not_contains "${BUDGET_DEV_NEEDLE}"
  assert_ctx_not_contains "${BUDGET_ANALYSIS_NEEDLE}"
}

@test "dev-shell (daemon carrier, NOT in BUDGET_DEV_AGENTS) → no budget-dev block, exit 0" {
  run_hook "glass-atrium-dev-shell"
  assert_status 0
  assert_ctx_not_contains "${BUDGET_DEV_NEEDLE}"
}

@test "intel-planner (BUDGET_ANALYSIS_AGENTS member) → budget-analysis block injected, no budget-dev, exit 0" {
  run_hook "glass-atrium-intel-planner"
  assert_status 0
  assert_ctx_contains "${BUDGET_ANALYSIS_NEEDLE}"
  assert_ctx_not_contains "${BUDGET_DEV_NEEDLE}"
}

@test "qa-code-reviewer (BUDGET_ANALYSIS_AGENTS member) → budget-analysis block injected, exit 0" {
  run_hook "glass-atrium-qa-code-reviewer"
  assert_status 0
  assert_ctx_contains "${BUDGET_ANALYSIS_NEEDLE}"
  assert_ctx_not_contains "${BUDGET_DEV_NEEDLE}"
}

@test "intel-researcher (daemon carrier, NOT in BUDGET_ANALYSIS_AGENTS) → no budget block, exit 0" {
  run_hook "glass-atrium-intel-researcher"
  assert_status 0
  assert_ctx_not_contains "${BUDGET_ANALYSIS_NEEDLE}"
  assert_ctx_not_contains "${BUDGET_DEV_NEEDLE}"
}

@test "qa-debugger (never a budget recipient) → no budget block, exit 0" {
  run_hook "glass-atrium-qa-debugger"
  assert_status 0
  assert_ctx_not_contains "${BUDGET_ANALYSIS_NEEDLE}"
  assert_ctx_not_contains "${BUDGET_DEV_NEEDLE}"
}

# (b) budget fail-open: markers/file absent → no hard error, budget omitted, OTHER blocks emit.
#     qa-code-reviewer carries both budget-analysis and wiki-untrusted, so the survivor is a real
#     droppable block rather than the always-on emit directive.

@test "budget markers absent → fail-open exit 0, budget omitted, wiki-untrusted block still emits" {
  budget_src="${BATS_TEST_TMPDIR}/budget-no-markers.md"
  printf 'no budget markers here\n' >"${budget_src}"
  run_hook "glass-atrium-qa-code-reviewer" "${budget_src}"
  assert_status 0
  assert_ctx_contains "${WIKI_NEEDLE}"
  assert_ctx_not_contains "${BUDGET_ANALYSIS_NEEDLE}"
  # The fail-open path emits a single stderr diagnostic naming the empty source (bats merges it).
  [[ "${output}" == *"budget-analysis block empty or markers absent"* ]] || {
    echo "expected budget-analysis fail-open stderr diagnostic, got: ${output}" >&2
    return 1
  }
}

@test "budget source file absent entirely → fail-open exit 0, budget omitted, wiki-untrusted unaffected" {
  run_hook "glass-atrium-qa-code-reviewer" "/nonexistent/turn-budget.md"
  assert_status 0
  assert_ctx_contains "${WIKI_NEEDLE}"
  assert_ctx_not_contains "${BUDGET_ANALYSIS_NEEDLE}"
}

# Even with every block source sandboxed to /nonexistent AND the meter off, the ALWAYS-ON emit-format
# directive is still delivered — so JSON IS emitted (the directive is the one universally-present
# block, independent of every source and of the meter). This is the R3 delivery-hole guard.
@test "qa-debugger with all block sources absent + meter off → emit directive still delivered, JSON emitted (exit 0)" {
  run_hook "glass-atrium-qa-debugger" /nonexistent /nonexistent
  assert_status 0
  assert_ctx_contains "${EMIT_NEEDLE}"
  assert_ctx_not_contains "${WIKI_NEEDLE}"
}

# (c) Retired scope blocks — comment-logging, style_ref, minimalism, naming and plan-gate ride the part
# slots, so slot 1 must never extract them. Each case plants that block's real marker pair in a
# sandbox HOME at the source path the hook once defaulted to, AND points the retired env seam at it,
# then drives a former roster member: a re-added extraction would pick the block up on either path.

# Args: $1=label $2=former roster member $3=marker infix ("" for the plain comment-logging pair)
#       $4=source basename under ~/.glass-atrium/scoped
run_retired_case() {
  local label="${1}" agent="${2}" infix="${3}" src_name="${4}"
  local home="${BATS_TEST_TMPDIR}/retired-home" src start end body
  src="${home}/.glass-atrium/scoped/${src_name}"
  start="<!-- AGENT-INJECT${infix:+:${infix}}:START -->"
  end="<!-- AGENT-INJECT${infix:+:${infix}}:END -->"
  body="RETIRED-${label}-CORE-BODY"
  mkdir -p "${src%/*}"
  printf '%s\n' 'preamble' "${start}" "${body}" "${end}" 'trailer' >"${src}"
  grep -qxF "${start}" "${src}" || { echo "fixture lacks its marker pair: ${src}" >&2; return 1; }

  run bash -c '
    agent="$1"; hook="$2"; home="$3"; src="$4"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env -u GA_DATA_ROOT \
      HOME="${home}" \
      INJECT_SCOPE_RULES_SRC="${src}" \
      INJECT_SCOPE_RULES_STYLEREF_SRC="${src}" \
      INJECT_SCOPE_RULES_NAMING_SRC="${src}" \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      SUBAGENT_BUDGET_METER_OFF=1 \
      INJECT_SCOPE_RULES_BUDGET_SRC=/nonexistent \
      INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC=/nonexistent \
      INJECT_SCOPE_RULES_LESSONS_SRC=/nonexistent \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${home}" "${src}"

  assert_status 0 || return 1
  assert_ctx_contains "${EMIT_NEEDLE}" || return 1
  assert_ctx_not_contains "${body}" || return 1
  if grep -qE "(=|;)${label}:" "${INJECT_SCOPE_RULES_MANIFEST_LOG}" 2>/dev/null; then
    echo "manifest names retired block '${label}': $(cat "${INJECT_SCOPE_RULES_MANIFEST_LOG}")" >&2
    return 1
  fi
}

@test "retired comment block → qa-debugger slot 1 carries no comment-logging core" {
  run_retired_case comment glass-atrium-qa-debugger "" shared-comment-logging.md
}

@test "retired styleref block → dev-swift slot 1 carries no style_ref block" {
  run_retired_case styleref glass-atrium-dev-swift STYLE-REF scope-dev.md
}

@test "retired minimalism block → dev-react slot 1 carries no minimalism block" {
  run_retired_case minimalism glass-atrium-dev-react MINIMALISM scope-dev.md
}

@test "retired naming block → qa-code-reviewer slot 1 carries no naming block" {
  run_retired_case naming glass-atrium-qa-code-reviewer NAMING shared-naming.md
}

@test "retired plan-gate block → dev-shell slot 1 carries no plan-gate block" {
  run_retired_case plan-gate glass-atrium-dev-shell PLAN-GATE scope-dev.md
}

# (d) always-on [COMPLETION] emit-format directive (PRIMARY emit-side fix, T2/T3).
# The directive is delivered to EVERY agent independent of SUBAGENT_BUDGET_METER_OFF and of maxTurns,
# and is ordered before every droppable block so it survives the ~2KB persistence preview.
# These assertions key on the 9984-byte ceiling and directive-first ordering, NOT on the 2KB preview.

# Drive the hook with the meter ENABLED (kill-switch explicitly unset) but AGENTS_DIR absent, so
# read_max_turns returns empty → METER_BLOCK is empty. All block sources absent. This isolates the
# emit directive as the sole delivered block and proves it is INDEPENDENT of maxTurns (empty meter).
run_hook_no_meter() {
  local agent="${1}"
  run bash -c '
    agent="$1"; hook="$2"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env -u SUBAGENT_BUDGET_METER_OFF \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      INJECT_SCOPE_RULES_BUDGET_SRC=/nonexistent \
      INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC=/nonexistent \
      INJECT_SCOPE_RULES_LESSONS_SRC=/nonexistent \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}"
}

# Assert the assembled additionalContext is at most $1 bytes (byte-accurate via wc -c).
assert_ctx_max_bytes() {
  local ctx nbytes
  ctx="$(ctx_of)"
  nbytes="$(printf '%s' "${ctx}" | wc -c | tr -cd '0-9')"
  [[ "${nbytes}" -le "${1}" ]] || {
    echo "expected additionalContext <= ${1} bytes, got ${nbytes} (ctx: [${ctx}])" >&2
    return 1
  }
}

# Engine cap on one hook's additionalContext: 10,000 UTF-16 code UNITS, INCLUSIVE — the unit the
# engine itself counts, measured by the W1 channel probe on a single host build. The hook budgets
# BYTES, which are never fewer than units for UTF-8 input, so its byte ceiling is a conservative
# proxy: it can under-spend the channel, never overflow it.
ENGINE_MAX_UNITS=10000

# Assert the assembled additionalContext is at most $1 UTF-16 code units. bash cannot count them and
# jq counts code points, so python3 does it; the trailing newline jq -r adds is stripped first.
assert_ctx_max_units() {
  local ctx nunits
  ctx="$(ctx_of)"
  nunits="$(printf '%s' "${ctx}" | python3 -c 'import sys; print(len(sys.stdin.read().rstrip("\n").encode("utf-16-le"))//2)')"
  [[ -n "${nunits}" && "${nunits}" -le "${1}" ]] || {
    echo "expected additionalContext <= ${1} units, got ${nunits}" >&2
    return 1
  }
}

@test "emit directive delivered under SUBAGENT_BUDGET_METER_OFF=1 (kill-switch independent)" {
  # run_hook forces SUBAGENT_BUDGET_METER_OFF=1 → meter suppressed; the emit directive must survive.
  run_hook "glass-atrium-dev-react"
  assert_status 0
  assert_ctx_contains "${EMIT_NEEDLE}"
  assert_ctx_not_contains "${METER_NEEDLE}"
}

@test "emit directive delivered when agent has no maxTurns frontmatter (empty METER_BLOCK, meter enabled)" {
  # Meter NOT killed (kill-switch unset) but AGENTS_DIR absent → read_max_turns empty → METER_BLOCK
  # empty; the emit directive must still reach the child, independent of the maxTurns coupling.
  run_hook_no_meter "glass-atrium-dev-react"
  assert_status 0
  assert_ctx_contains "${EMIT_NEEDLE}"
  assert_ctx_not_contains "${METER_NEEDLE}"
}

# (e) meter-first assembly + universal 9984-byte ceiling drop order.
# Unlike run_hook (which suppresses the meter), these tests ENABLE it: they build a maxTurns
# frontmatter fixture + padded block sources, then assert emit and meter lead the assembly and the
# ceiling sheds droppable blocks in the pinned order wiki-untrusted → lesson → budget-analysis →
# budget-dev while never dropping emit or meter. Distinct needles per block make each assertion
# mutation-falsifiable.

# Build the padded block sources + a maxTurns frontmatter dir, then drive the hook with the meter
# ENABLED. The two budget blocks share ONE source file, mirroring production; a block only lands when
# the agent is in its roster, so an out-of-roster pad is inert.
# Args: $1=agent $2=budget_dev_pad $3=budget_analysis_pad $4=wiki_pad $5=lessons path (optional)
run_hook_full() {
  local agent="${1}" bdpad="${2:-16}" bapad="${3:-16}" wpad="${4:-16}" lessons="${5:-/nonexistent}"
  local budget_src="${BATS_TEST_TMPDIR}/turn-budget-full.md"
  local wiki_src="${BATS_TEST_TMPDIR}/wiki-full.md"
  local agents_dir="${BATS_TEST_TMPDIR}/agents"

  {
    printf '%s\n' 'preamble'
    printf '%s\n' "${BUDGET_DEV_MARKER_START}"
    printf '%s\n' "${BUDGET_DEV_NEEDLE}"
    head -c "${bdpad}" /dev/zero | tr '\0' 'X'
    printf '\n'
    printf '%s\n' "${BUDGET_DEV_MARKER_END}"
    printf '%s\n' "${BUDGET_ANALYSIS_MARKER_START}"
    printf '%s\n' "${BUDGET_ANALYSIS_NEEDLE}"
    head -c "${bapad}" /dev/zero | tr '\0' 'X'
    printf '\n'
    printf '%s\n' "${BUDGET_ANALYSIS_MARKER_END}"
    printf '%s\n' 'trailer'
  } >"${budget_src}"
  {
    printf '%s\n' 'preamble' "${WIKI_MARKER_START}" "${WIKI_NEEDLE}"
    head -c "${wpad}" /dev/zero | tr '\0' 'X'
    printf '\n'
    printf '%s\n' "${WIKI_MARKER_END}" 'trailer'
  } >"${wiki_src}"

  mkdir -p "${agents_dir}"
  printf 'maxTurns: 40\n' >"${agents_dir}/${agent}.md"

  run bash -c '
    agent="$1"; hook="$2"; budget_src="$3"; wiki_src="$4"; agents_dir="$5"; lessons="$6"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env -u SUBAGENT_BUDGET_METER_OFF \
      INJECT_SCOPE_RULES_AGENTS_DIR="${agents_dir}" \
      INJECT_SCOPE_RULES_BUDGET_SRC="${budget_src}" \
      INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC="${wiki_src}" \
      INJECT_SCOPE_RULES_LESSONS_SRC="${lessons}" \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${budget_src}" "${wiki_src}" "${agents_dir}" "${lessons}"
}

# Assert $1 appears strictly BEFORE $2 in the assembled additionalContext (both must be present).
assert_ctx_order() {
  local ctx first="${1}" second="${2}"
  ctx="$(ctx_of)"
  printf '%s' "${ctx}" | python3 -c '
import sys
ctx = sys.stdin.read()
a, b = sys.argv[1], sys.argv[2]
ia, ib = ctx.find(a), ctx.find(b)
sys.exit(0 if (ia != -1 and ib != -1 and ia < ib) else 1)
' "${first}" "${second}" || {
    echo "expected [${first}] to precede [${second}] in ctx: [${ctx}]" >&2
    return 1
  }
}

# Byte length of the last run's assembled additionalContext.
ctx_bytes() {
  printf '%s' "$(ctx_of)" | wc -c | tr -cd '0-9'
}

@test "emit directive ordered BEFORE the meter, wiki-untrusted and budget-analysis (qa-code-reviewer)" {
  run_hook_full "glass-atrium-qa-code-reviewer"
  assert_status 0
  assert_ctx_order "${EMIT_NEEDLE}" "${METER_NEEDLE}"
  assert_ctx_order "${METER_NEEDLE}" "${WIKI_NEEDLE}"
  assert_ctx_order "${WIKI_NEEDLE}" "${BUDGET_ANALYSIS_NEEDLE}"
}

@test "meter block assembled right after emit — precedes budget-dev (dev-front)" {
  run_hook_full "glass-atrium-dev-front"
  assert_status 0
  assert_ctx_order "${EMIT_NEEDLE}" "${METER_NEEDLE}"
  assert_ctx_order "${METER_NEEDLE}" "${BUDGET_DEV_NEEDLE}"
}

@test "assembled additionalContext stays <= 10000 units under drop pressure, drop marker included" {
  run_hook_full "glass-atrium-dev-front" 12000
  assert_status 0
  assert_ctx_contains "${EMIT_NEEDLE}"
  # Drop pressure means a block sheds, so a drop marker is part of what gets emitted — and it is
  # budgeted INSIDE the ceiling rather than appended past it, so the marker-inclusive total is what
  # must fit. Measured in the engine's own unit; the hook's byte ceiling is the tighter proxy.
  assert_ctx_contains "Injection shed"
  assert_ctx_max_units "${ENGINE_MAX_UNITS}"
  assert_ctx_max_bytes 9984
}

@test "meter is NEVER dropped — a single oversized block cannot evict it" {
  # budget-dev alone = 12000B > the 9984 ceiling, so it sheds — but emit and meter are not drop
  # candidates and MUST survive.
  run_hook_full "glass-atrium-dev-front" 12000
  assert_status 0
  assert_ctx_contains "${EMIT_NEEDLE}"
  assert_ctx_contains "${METER_NEEDLE}"
  assert_ctx_not_contains "${BUDGET_DEV_NEEDLE}"
}

@test "over the ceiling — wiki-untrusted sheds BEFORE budget-analysis; budget-analysis + meter retained (qa-code-reviewer)" {
  # Every size here is MEASURED from an emit, none assumed: both quantities move with the sandbox
  # path length, which the drop marker embeds. budget-analysis is large enough that shedding it alone
  # would ALSO restore the fit, so only the pinned order can make wiki-untrusted the one that goes.
  local ceiling=9984 overshoot=200 bapad=3000 base_bytes wpad
  run_hook_full "glass-atrium-qa-code-reviewer" 16 "${bapad}" 16
  assert_status 0
  base_bytes="$(ctx_bytes)"
  [ "${base_bytes}" -le "${ceiling}" ]
  # One pad byte is one context byte: grow the wiki block until the assembly clears the ceiling by
  # `overshoot`.
  wpad=$((16 + ceiling + overshoot - base_bytes))
  [ "${wpad}" -gt "${bapad}" ]
  run_hook_full "glass-atrium-qa-code-reviewer" 16 "${bapad}" "${wpad}"
  assert_status 0
  assert_ctx_not_contains "${WIKI_NEEDLE}"
  assert_ctx_contains "${BUDGET_ANALYSIS_NEEDLE}"
  assert_ctx_contains "${METER_NEEDLE}"
  assert_ctx_contains "Injection shed 01"
  assert_ctx_max_bytes "${ceiling}"
}

@test "over the ceiling — lesson yields BEFORE budget-dev; budget-dev + meter retained (dev-front)" {
  # The lesson-free assembly is sized to leave a 400B residual — above the 150B truncate-keep floor —
  # while a 1200B-capped lesson overflows it, and budget-dev is far larger than the overflow. So
  # budget-dev could restore the fit on its own, yet the lesson is what gives way.
  local ceiling=9984 residual=400 base_bytes bdpad lessons="${BATS_TEST_TMPDIR}/lessons.json"
  python3 -c '
import json, sys
json.dump({"ctm": [{"agent": "glass-atrium-dev-front", "task_type": "bug-fix", "text": "L" * 3000, "score": 5, "frequency": 9}], "epm": []}, open(sys.argv[1], "w"))
' "${lessons}"
  run_hook_full "glass-atrium-dev-front" 16
  assert_status 0
  base_bytes="$(ctx_bytes)"
  bdpad=$((16 + ceiling - 2 - residual - base_bytes))
  [ "${bdpad}" -gt 2000 ]
  run_hook_full "glass-atrium-dev-front" "${bdpad}" 16 16 "${lessons}"
  assert_status 0
  assert_ctx_contains "${BUDGET_DEV_NEEDLE}"
  assert_ctx_contains "${METER_NEEDLE}"
  assert_ctx_contains "Prior-lesson recall"
  [[ "${output}" != *"dropped budget-dev block"* ]] || {
    echo "budget-dev shed while a lesson could still yield: ${output}" >&2
    return 1
  }
  [[ "${output}" == *"lesson block truncated"* ]] || {
    echo "expected the lesson to be the block that yields: ${output}" >&2
    return 1
  }
  assert_ctx_max_bytes "${ceiling}"
}

# (f) T1 numeric preview-survival guard: EMIT + METER combined MUST fit the ~2KB persistence
# preview (Claude Code delivers only a ~2KB preview of additionalContext, so both non-droppable
# blocks must lead within that budget). This is the ACTUAL constraint the emit/meter-first ordering
# protects — no other @test asserts it numerically. Drive the meter ENABLED (maxTurns frontmatter)
# with every block source absent, isolating ctx to EMIT + METER only, then bound its byte length.
run_hook_emit_meter_only() {
  local agent="${1}"
  local agents_dir="${BATS_TEST_TMPDIR}/emit-meter-agents"
  mkdir -p "${agents_dir}"
  printf 'maxTurns: 40\n' >"${agents_dir}/${agent}.md"
  run bash -c '
    agent="$1"; hook="$2"; agents_dir="$3"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env -u SUBAGENT_BUDGET_METER_OFF \
      INJECT_SCOPE_RULES_AGENTS_DIR="${agents_dir}" \
      INJECT_SCOPE_RULES_BUDGET_SRC=/nonexistent \
      INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC=/nonexistent \
      INJECT_SCOPE_RULES_LESSONS_SRC=/nonexistent \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${agents_dir}"
}

@test "EMIT + METER combined stays < 2048 bytes (~2KB persistence-preview survival, T1)" {
  run_hook_emit_meter_only "glass-atrium-dev-react"
  assert_status 0
  assert_ctx_contains "${EMIT_NEEDLE}"
  assert_ctx_contains "${METER_NEEDLE}"
  local ctx nbytes
  ctx="$(ctx_of)"
  nbytes="$(printf '%s' "${ctx}" | wc -c | tr -cd '0-9')"
  [[ "${nbytes}" -lt 2048 ]] || {
    echo "expected EMIT+METER < 2048 bytes, got ${nbytes}" >&2
    return 1
  }
}
