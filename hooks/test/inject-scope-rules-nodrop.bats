#!/usr/bin/env bats
# inject-scope-rules-nodrop.bats — recurrence-prevention pin for the SubagentStart injection ceiling.
#
#   Root cause (redteam finding #24): the assembled worst-case DEV additionalContext (emit + meter +
#   comment + style_ref + minimalism + naming + separators) exceeded INJECT_CTX_MAX_BYTES, so the
#   drop-loop silently shed STYLE-REF (all 13 DEV) and NAMING (12 DEV) — those scope rules never
#   reached the subagents. The fix is compression of the four AGENT-INJECT source blocks + a ceiling
#   raise to 9728 (still under the ~10240 engine persist threshold). This test PINS the invariant:
#   assembled from the REAL repo sources (NOT hermetic fixtures) with the meter ON (worst case), the
#   worst-case DEV assembly for every NAMING-roster DEV member fits the ceiling with ZERO drop-loop
#   iterations — all six blocks survive. It is satisfiable ONLY after the compression; a ceiling raise
#   alone cannot fit the pre-compression ~11540B sum. A future block edit that re-inflates the
#   assembly past the ceiling re-triggers a drop and fails this test.
#
#   REAL-SOURCE wiring: the hook's INJECT_SCOPE_RULES_SRC / STYLEREF_SRC / NAMING_SRC / AGENTS_DIR
#   env overrides are pointed at the repo files + real agents/ frontmatter (maxTurns → the real meter
#   size). Meter is LEFT ON (SUBAGENT_BUDGET_METER_OFF unset) — the meter is part of the worst-case
#   sum. INJECT_SCOPE_RULES_DROP_LOG is redirected into the Bats tmpdir so any marker write never
#   touches the real ~/.claude/logs.
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
AGENTS_DIR="${REPO_ROOT}/agents"

# The ceiling constant the hook enforces — kept in sync with inject-scope-rules.sh:INJECT_CTX_MAX_BYTES.
CEILING=9728

# Stable, unique first-line needles for each of the six blocks (proves none was dropped).
EMIT_NEEDLE="REQUIRED by the outcome recorder"
METER_NEEDLE="Turn-budget meter"
COMMENT_NEEDLE="Comment-rule core"
STYLEREF_NEEDLE="style_ref emit"
MINIMALISM_NEEDLE="Minimalism reflex"
NAMING_NEEDLE="Naming delta-core"

# The 12 NAMING-roster DEV agents — the worst case, receiving ALL SIX blocks (emit + meter + comment
# + style_ref + minimalism + naming). dev-swift (no naming) and qa-* are covered separately below.
WORST_DEV_AGENTS=(
  glass-atrium-dev-front glass-atrium-dev-react glass-atrium-dev-angular glass-atrium-dev-gsap
  glass-atrium-dev-android glass-atrium-dev-nestjs glass-atrium-dev-node glass-atrium-dev-python
  glass-atrium-dev-db glass-atrium-dev-rag glass-atrium-dev-animator glass-atrium-dev-shell
)

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "inject-scope-rules.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"
  [[ -f "${COMMENT_SRC}" ]] || skip "real comment source missing: ${COMMENT_SRC}"
  [[ -f "${STYLEREF_SRC}" ]] || skip "real scope-dev source missing: ${STYLEREF_SRC}"
  [[ -f "${NAMING_SRC}" ]] || skip "real naming source missing: ${NAMING_SRC}"
  [[ -d "${AGENTS_DIR}" ]] || skip "real agents dir missing: ${AGENTS_DIR}"
}

# Drive the hook with a SubagentStart envelope for $1, assembling from the REAL repo sources with the
# meter ON. The drop log is redirected into the Bats tmpdir.
run_hook_real() {
  local agent="${1}"
  run bash -c '
    agent="$1"; hook="$2"; comment="$3"; styleref="$4"; naming="$5"; agents="$6"; droplog="$7"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env \
      INJECT_SCOPE_RULES_SRC="${comment}" \
      INJECT_SCOPE_RULES_STYLEREF_SRC="${styleref}" \
      INJECT_SCOPE_RULES_NAMING_SRC="${naming}" \
      INJECT_SCOPE_RULES_AGENTS_DIR="${agents}" \
      INJECT_SCOPE_RULES_DROP_LOG="${droplog}" \
      INJECT_SCOPE_RULES_LESSONS_SRC=/nonexistent \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${COMMENT_SRC}" "${STYLEREF_SRC}" "${NAMING_SRC}" "${AGENTS_DIR}" \
    "${BATS_TEST_TMPDIR}/inject-drop.log"
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

# (a) Every NAMING-roster DEV member: all six blocks present, zero drops, within ceiling.

@test "worst-case DEV agents (real sources, meter ON) → all six blocks, ZERO drops, within ceiling" {
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
  done
}

# (b) The canonical worst-case member (maxTurns=80 → largest meter) as an explicit single case.

@test "dev-front (maxTurns=80 worst case) → STYLE-REF + NAMING both survive, zero drops" {
  run_hook_real "glass-atrium-dev-front"
  assert_status 0                           || return 1
  assert_no_drop                            || return 1
  assert_ctx_contains "${STYLEREF_NEEDLE}"  || return 1
  assert_ctx_contains "${NAMING_NEEDLE}"    || return 1
  assert_ctx_within_ceiling                 || return 1
}

# (c) qa-code-reviewer (NAMING roster, NOT style_ref/minimalism roster) → comment + naming survive.

@test "qa-code-reviewer (real sources) → comment + naming injected, zero drops" {
  run_hook_real "glass-atrium-qa-code-reviewer"
  assert_status 0                         || return 1
  assert_no_drop                          || return 1
  assert_ctx_contains "${COMMENT_NEEDLE}" || return 1
  assert_ctx_contains "${NAMING_NEEDLE}"  || return 1
  assert_ctx_within_ceiling               || return 1
}

# (d) No drop marker file is created on the happy path (a drop is a genuine regression signal only).

@test "happy path leaves no persisted drop marker" {
  run_hook_real "glass-atrium-dev-front"
  assert_status 0 || return 1
  [[ ! -s "${BATS_TEST_TMPDIR}/inject-drop.log" ]] || { echo "unexpected drop marker written: $(cat "${BATS_TEST_TMPDIR}/inject-drop.log")" >&2; return 1; }
}
