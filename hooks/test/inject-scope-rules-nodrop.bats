#!/usr/bin/env bats
# inject-scope-rules-nodrop.bats — recurrence-prevention pin for the SubagentStart injection ceiling.
#
#   Root cause (redteam finding #24): the assembled worst-case DEV additionalContext (emit + meter +
#   comment + style_ref + minimalism + naming + separators) exceeded INJECT_CTX_MAX_BYTES, so the
#   drop-loop silently shed STYLE-REF (all 13 DEV) and NAMING (12 DEV) — those scope rules never
#   reached the subagents. The fix is compression of the AGENT-INJECT source blocks + a ceiling
#   raise to 9984 (still under the ~10240 engine persist threshold; the margin was halved from
#   512B to 256B to admit the byte-contracted BUDGET-DEV block). This test PINS the invariant:
#   assembled from the REAL repo sources (NOT hermetic fixtures) with the meter ON (worst case), the
#   worst-case DEV assembly for every NAMING-roster DEV member fits the ceiling with ZERO drop-loop
#   iterations — every roster-due block survives (seven blocks for a BUDGET_DEV_AGENTS member like
#   dev-front). It is satisfiable ONLY with the compression; a ceiling raise alone cannot fit the
#   pre-compression ~11540B sum. A future block edit that re-inflates the assembly past the ceiling
#   re-triggers a drop and fails this test. The BUDGET-DEV source block additionally carries a
#   <=300B byte contract (the D3 ceiling math input) pinned numerically below.
#
#   REAL-SOURCE wiring: the hook's INJECT_SCOPE_RULES_SRC / STYLEREF_SRC / NAMING_SRC / BUDGET_SRC /
#   AGENTS_DIR env overrides are pointed at the repo files + real agents/ frontmatter (maxTurns →
#   the real meter size). Meter is LEFT ON (SUBAGENT_BUDGET_METER_OFF unset) — the meter is part of
#   the worst-case sum. INJECT_SCOPE_RULES_DROP_LOG is redirected into the Bats tmpdir so any marker
#   write never touches the real ~/.claude/logs.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail. Every
#   assertion is guarded with a helper that `return 1`s on mismatch, so EACH one independently fails.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/inject-scope-rules.sh"
REPO_ROOT="${BATS_TEST_DIRNAME}/../.."

# Real repo sources (single source of truth for the injected blocks).
COMMENT_SRC="${REPO_ROOT}/scoped/shared-comment-logging.md"
STYLEREF_SRC="${REPO_ROOT}/scoped/scope-dev.md"          # STYLE-REF + MINIMALISM both live here
NAMING_SRC="${REPO_ROOT}/skills/glass-atrium-dev-naming/SKILL.md"
BUDGET_SRC="${REPO_ROOT}/scoped/shared-turn-budget.md"   # BUDGET-DEV + BUDGET-ANALYSIS both live here
AGENTS_DIR="${REPO_ROOT}/agents"

# The ceiling constant the hook enforces — kept in sync with inject-scope-rules.sh:INJECT_CTX_MAX_BYTES.
CEILING=9984
# The D3 plan bound for the worst-case dev-front seven-block assembly (9635B six-block sum + the
# <=300B byte-contracted BUDGET-DEV block) — tighter than CEILING, pinned so source-block growth
# surfaces here BEFORE it erodes the 256B engine margin.
DEV_FRONT_MAX_BYTES=9935
# BUDGET-DEV source-block byte contract (hard bound; target 260B) — the D3 ceiling math input: the
# 9984 ceiling admits the seven-block assembly ONLY while this block stays <=300B.
BUDGET_DEV_MAX_BYTES=300

# Stable, unique first-line needles for each of the eight blocks (proves none was dropped).
EMIT_NEEDLE="REQUIRED by the outcome recorder"
METER_NEEDLE="Turn-budget meter"
COMMENT_NEEDLE="Comment-rule core"
STYLEREF_NEEDLE="style_ref emit"
MINIMALISM_NEEDLE="Minimalism reflex"
NAMING_NEEDLE="Naming delta-core"
BUDGET_DEV_NEEDLE="Budget sizing (auto-injected DEV"
BUDGET_ANALYSIS_NEEDLE="Budget sizing (auto-injected analysis"

# The 12 NAMING-roster DEV agents — the worst case, receiving the six proven blocks (emit + meter +
# comment + style_ref + minimalism + naming) PLUS budget-dev for BUDGET_DEV_AGENTS members (the four
# daemon carriers below are excluded from that roster). dev-swift (no naming, budget-dev member) and
# qa-* are covered separately below.
WORST_DEV_AGENTS=(
  glass-atrium-dev-front glass-atrium-dev-react glass-atrium-dev-angular glass-atrium-dev-gsap
  glass-atrium-dev-android glass-atrium-dev-nestjs glass-atrium-dev-node glass-atrium-dev-python
  glass-atrium-dev-db glass-atrium-dev-rag glass-atrium-dev-animator glass-atrium-dev-shell
)
# The four daemon-carrier agents excluded from BUDGET_DEV_AGENTS (their bodies keep daemon-evolved
# in-body budget bullets) — kept in sync with inject-scope-rules.sh:BUDGET_DEV_AGENTS rationale.
BUDGET_DEV_CARRIERS=" glass-atrium-dev-nestjs glass-atrium-dev-python glass-atrium-dev-react glass-atrium-dev-shell "

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "inject-scope-rules.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  [[ -f "${COMMENT_SRC}" ]] || skip "real comment source missing: ${COMMENT_SRC}"
  [[ -f "${STYLEREF_SRC}" ]] || skip "real scope-dev source missing: ${STYLEREF_SRC}"
  [[ -f "${NAMING_SRC}" ]] || skip "real naming source missing: ${NAMING_SRC}"
  [[ -f "${BUDGET_SRC}" ]] || skip "real turn-budget source missing: ${BUDGET_SRC}"
  [[ -d "${AGENTS_DIR}" ]] || skip "real agents dir missing: ${AGENTS_DIR}"

  # T7: the drop-rate denominator counter defaults under ~/.claude/logs and writes on EVERY spawn —
  # sandbox it into the Bats tmpdir (exported → inherited through each run helper's `env`).
  export INJECT_SCOPE_RULES_SPAWN_COUNTER="${BATS_TEST_TMPDIR}/inject-spawns.count"
}

# Drive the hook with a SubagentStart envelope for $1, assembling from the REAL repo sources with the
# meter ON. The drop log is redirected into the Bats tmpdir.
run_hook_real() {
  local agent="${1}"
  run bash -c '
    agent="$1"; hook="$2"; comment="$3"; styleref="$4"; naming="$5"; budget="$6"; agents="$7"; droplog="$8"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env \
      INJECT_SCOPE_RULES_SRC="${comment}" \
      INJECT_SCOPE_RULES_STYLEREF_SRC="${styleref}" \
      INJECT_SCOPE_RULES_NAMING_SRC="${naming}" \
      INJECT_SCOPE_RULES_BUDGET_SRC="${budget}" \
      INJECT_SCOPE_RULES_AGENTS_DIR="${agents}" \
      INJECT_SCOPE_RULES_DROP_LOG="${droplog}" \
      INJECT_SCOPE_RULES_LESSONS_SRC=/nonexistent \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${COMMENT_SRC}" "${STYLEREF_SRC}" "${NAMING_SRC}" "${BUDGET_SRC}" \
    "${AGENTS_DIR}" "${BATS_TEST_TMPDIR}/inject-drop.log"
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
    print(d.get("hookSpecificOutput", {}).get("additionalContext", ""))
    break
' 2>/dev/null
}

# Per-assertion gate helpers (bodies are NOT under set -e).
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
# Zero drop-loop iterations: the hook prints the drop diagnostic to stderr (merged into $output by
# bats) ONLY when it sheds a block. Its ABSENCE proves no block was dropped.
assert_no_drop() {
  [[ "${output}" != *"injected context exceeded"* ]] || { echo "a block was DROPPED (ceiling exceeded): ${output}" >&2; return 1; }
  [[ "${output}" != *"dropped "* ]] || { echo "a block was DROPPED: ${output}" >&2; return 1; }
}
# The assembled context byte length must not exceed the ceiling (byte-accurate via wc -c, matching
# the hook's own byte_len). Directly corroborates the fit.
assert_ctx_within_ceiling() {
  local ctx bytes; ctx="$(ctx_of)"
  bytes="$(printf '%s' "${ctx}" | wc -c | tr -cd '0-9')"
  [[ -n "${bytes}" && "${bytes}" -le "${CEILING}" ]] || { echo "ctx ${bytes}B exceeds ceiling ${CEILING}B" >&2; return 1; }
}

# (a) Every NAMING-roster DEV member: the six proven blocks present, budget-dev present for roster
# members / ABSENT for the four daemon carriers, zero drops, within ceiling.

@test "worst-case DEV agents (real sources, meter ON) → all due blocks, ZERO drops, within ceiling" {
  for agent in "${WORST_DEV_AGENTS[@]}"; do
    run_hook_real "${agent}"
    assert_status 0                           || { echo "FAIL agent=${agent} (status)" >&2; return 1; }
    assert_no_drop                            || { echo "FAIL agent=${agent} (drop)" >&2; return 1; }
    assert_ctx_within_ceiling                 || { echo "FAIL agent=${agent} (ceiling)" >&2; return 1; }
    assert_ctx_contains "${EMIT_NEEDLE}"      || { echo "FAIL agent=${agent} (emit)" >&2; return 1; }
    assert_ctx_contains "${METER_NEEDLE}"     || { echo "FAIL agent=${agent} (meter)" >&2; return 1; }
    assert_ctx_contains "${COMMENT_NEEDLE}"   || { echo "FAIL agent=${agent} (comment)" >&2; return 1; }
    assert_ctx_contains "${STYLEREF_NEEDLE}"  || { echo "FAIL agent=${agent} (style_ref)" >&2; return 1; }
    assert_ctx_contains "${MINIMALISM_NEEDLE}" || { echo "FAIL agent=${agent} (minimalism)" >&2; return 1; }
    assert_ctx_contains "${NAMING_NEEDLE}"    || { echo "FAIL agent=${agent} (naming)" >&2; return 1; }
    if [[ "${BUDGET_DEV_CARRIERS}" == *" ${agent} "* ]]; then
      assert_ctx_not_contains "${BUDGET_DEV_NEEDLE}" || { echo "FAIL agent=${agent} (budget-dev leaked to carrier)" >&2; return 1; }
    else
      assert_ctx_contains "${BUDGET_DEV_NEEDLE}"     || { echo "FAIL agent=${agent} (budget-dev)" >&2; return 1; }
    fi
  done
}

# (b) The canonical worst-case member (maxTurns=80 → largest meter; seven blocks incl. budget-dev)
# as an explicit single case, numerically bounded at the D3 plan figure (tighter than the ceiling).

@test "dev-front (maxTurns=80 worst case) → seven blocks incl. BUDGET-DEV, zero drops, <= ${DEV_FRONT_MAX_BYTES}B" {
  run_hook_real "glass-atrium-dev-front"
  assert_status 0                             || return 1
  assert_no_drop                              || return 1
  assert_ctx_contains "${STYLEREF_NEEDLE}"    || return 1
  assert_ctx_contains "${NAMING_NEEDLE}"      || return 1
  assert_ctx_contains "${BUDGET_DEV_NEEDLE}"  || return 1
  assert_ctx_within_ceiling                   || return 1
  local ctx bytes; ctx="$(ctx_of)"
  bytes="$(printf '%s' "${ctx}" | wc -c | tr -cd '0-9')"
  [[ -n "${bytes}" && "${bytes}" -le "${DEV_FRONT_MAX_BYTES}" ]] || {
    echo "dev-front assembly ${bytes}B exceeds the D3 plan bound ${DEV_FRONT_MAX_BYTES}B" >&2
    return 1
  }
}

# (c) qa-code-reviewer (NAMING + BUDGET-ANALYSIS rosters, NOT style_ref/minimalism/budget-dev) →
# five blocks (emit + meter + comment + naming + budget-analysis) survive, zero drops.

@test "qa-code-reviewer (real sources) → comment + naming + budget-analysis injected, zero drops" {
  run_hook_real "glass-atrium-qa-code-reviewer"
  assert_status 0                                  || return 1
  assert_no_drop                                   || return 1
  assert_ctx_contains "${COMMENT_NEEDLE}"          || return 1
  assert_ctx_contains "${NAMING_NEEDLE}"           || return 1
  assert_ctx_contains "${BUDGET_ANALYSIS_NEEDLE}"  || return 1
  assert_ctx_not_contains "${BUDGET_DEV_NEEDLE}"   || return 1
  assert_ctx_within_ceiling                        || return 1
}

# (c2) dev-swift — BUDGET_DEV_AGENTS member OUTSIDE the naming roster: budget-dev survives with
# zero drops even though its block mix (no naming) differs from the 12-agent loop above.

@test "dev-swift (real sources) → budget-dev injected without naming, zero drops" {
  run_hook_real "glass-atrium-dev-swift"
  assert_status 0                                 || return 1
  assert_no_drop                                  || return 1
  assert_ctx_contains "${BUDGET_DEV_NEEDLE}"      || return 1
  assert_ctx_not_contains "${NAMING_NEEDLE}"      || return 1
  assert_ctx_within_ceiling                       || return 1
}

# (c3) intel-planner — BUDGET_ANALYSIS_AGENTS member outside every other scope roster: the
# budget-analysis block reaches an analysis consumer whose assembly is otherwise emit + meter only.

@test "intel-planner (real sources) → budget-analysis injected, zero drops" {
  run_hook_real "glass-atrium-intel-planner"
  assert_status 0                                  || return 1
  assert_no_drop                                   || return 1
  assert_ctx_contains "${BUDGET_ANALYSIS_NEEDLE}"  || return 1
  assert_ctx_not_contains "${BUDGET_DEV_NEEDLE}"   || return 1
  assert_ctx_within_ceiling                        || return 1
}

# (c4) Numeric source-contract pin (D3/AC9): the extracted BUDGET-DEV block MUST stay <=300B —
# the ceiling math (9984 admits the seven-block worst case) relies on this bound, so growth past
# it must fail HERE, at the source, before it silently erodes the engine margin. Extraction
# mirrors the hook's extract_block (sed range + grep -vxF marker strip).

@test "BUDGET-DEV source block byte contract: extracted block non-empty and <= ${BUDGET_DEV_MAX_BYTES}B" {
  local block bytes
  block="$(sed -n '/<!-- AGENT-INJECT:BUDGET-DEV:START -->/,/<!-- AGENT-INJECT:BUDGET-DEV:END -->/p' "${BUDGET_SRC}" \
    | grep -vxF '<!-- AGENT-INJECT:BUDGET-DEV:START -->' \
    | grep -vxF '<!-- AGENT-INJECT:BUDGET-DEV:END -->')"
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
