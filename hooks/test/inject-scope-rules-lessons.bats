#!/usr/bin/env bats
# inject-scope-rules-lessons.bats — AD-3 spawn-time lesson injection (Reflexion / LangMem).
#   The SubagentStart hook injects the current agent's top-K CTM lessons (score >= 4, live) +
#   EPM warnings from the lesson store the learning-aggregator writes. This suite pins the AC:
#   a MATCHED spawn gets <= K lessons within cap; a NO-MATCH spawn is unchanged.
#
#   Isolation: every other scope source is sandboxed to /nonexistent and the meter is off, so the
#   only variable block is the lesson block. The lesson store is a hermetic in-sandbox JSON fixture.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e` — every assertion is a helper that `return 1`s.

HOOKS_DIR="${BATS_TEST_DIRNAME}/.."
HOOK_SH="${HOOKS_DIR}/inject-scope-rules.sh"

LESSON_NEEDLE="Prior-lesson recall"
EMIT_NEEDLE="REQUIRED by the outcome recorder"
LESSON_TOP_K=5

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "inject-scope-rules.sh not found: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"
  command -v python3 >/dev/null 2>&1 || skip "python3 not on PATH"

  # T7: the drop-rate denominator counter defaults under ~/.claude/logs and writes on EVERY spawn —
  # sandbox it into the Bats tmpdir (exported → inherited through each run helper's `env`).
  export INJECT_SCOPE_RULES_SPAWN_COUNTER="${BATS_TEST_TMPDIR}/inject-spawns.count"

  # Hermetic lesson store: dev-shell has 8 CTM (5 score-5, 1 score-4, 1 score-3 to be filtered,
  # 1 tombstoned to be excluded) + 1 EPM; dev-node has an unrelated entry (proves agent scoping).
  LESSON_FIXTURE="${BATS_TEST_TMPDIR}/lessons.json"
  cat >"${LESSON_FIXTURE}" <<'JSON'
{
  "ctm": [
    {"agent":"glass-atrium-dev-shell","task_type":"feature","text":"CTM-A printf not echo","score":5,"frequency":9,"tombstoned":false},
    {"agent":"glass-atrium-dev-shell","task_type":"refactor","text":"CTM-B quote expansions","score":5,"frequency":8,"tombstoned":false},
    {"agent":"glass-atrium-dev-shell","task_type":"bug-fix","text":"CTM-C strict mode","score":5,"frequency":7,"tombstoned":false},
    {"agent":"glass-atrium-dev-shell","task_type":"cleanup","text":"CTM-D mktemp trap","score":5,"frequency":6,"tombstoned":false},
    {"agent":"glass-atrium-dev-shell","task_type":"plan","text":"CTM-E bash 3.2 guard","score":5,"frequency":5,"tombstoned":false},
    {"agent":"glass-atrium-dev-shell","task_type":"doc","text":"CTM-F sixth cut by topK","score":5,"frequency":1,"tombstoned":false},
    {"agent":"glass-atrium-dev-shell","task_type":"feature","text":"CTM-LOWSCORE below floor","score":3,"frequency":9,"tombstoned":false},
    {"agent":"glass-atrium-dev-shell","task_type":"feature","text":"CTM-TOMB excluded","score":5,"frequency":9,"tombstoned":true},
    {"agent":"glass-atrium-dev-node","task_type":"feature","text":"CTM-OTHER agent","score":5,"frequency":9,"tombstoned":false}
  ],
  "epm": [
    {"agent":"glass-atrium-dev-shell","task_type":"bug-fix","text":"EPM-X never eval","score":2,"frequency":5,"tombstoned":false}
  ]
}
JSON
}

# Drive the hook with only the lesson store live (all other sources + meter off).
run_hook_lessons() {
  local agent="${1}" lessons="${2:-${LESSON_FIXTURE}}"
  run bash -c '
    agent="$1"; hook="$2"; lessons="$3"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      SUBAGENT_BUDGET_METER_OFF=1 \
      INJECT_SCOPE_RULES_SRC=/nonexistent \
      INJECT_SCOPE_RULES_STYLEREF_SRC=/nonexistent \
      INJECT_SCOPE_RULES_NAMING_SRC=/nonexistent \
      INJECT_SCOPE_RULES_LESSONS_SRC="${lessons}" \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${lessons}"
}

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
# Count "- [" CTM lesson lines in the assembled context.
ctm_line_count() {
  ctx_of | grep -cE '^- \[' || true
}

# (a) matched spawn → lesson block present, at most K CTM lessons.

@test "matched agent (dev-shell) → lesson block injected with <= K CTM lessons" {
  run_hook_lessons "glass-atrium-dev-shell"
  assert_status 0
  assert_ctx_contains "${LESSON_NEEDLE}"
  local n; n="$(ctm_line_count)"
  [[ "${n}" -le "${LESSON_TOP_K}" && "${n}" -ge 1 ]] || { echo "expected 1..${LESSON_TOP_K} CTM lines, got ${n}" >&2; return 1; }
}

@test "matched agent → score<4 CTM filtered out, tombstoned excluded" {
  run_hook_lessons "glass-atrium-dev-shell"
  assert_status 0
  assert_ctx_not_contains "CTM-LOWSCORE"
  assert_ctx_not_contains "CTM-TOMB"
}

@test "matched agent → EPM warning injected as an AVOID line" {
  run_hook_lessons "glass-atrium-dev-shell"
  assert_status 0
  assert_ctx_contains "AVOID"
  assert_ctx_contains "EPM-X"
}

@test "lesson selection is agent-scoped — another agent's lesson never leaks" {
  run_hook_lessons "glass-atrium-dev-shell"
  assert_status 0
  assert_ctx_not_contains "CTM-OTHER"
}

# (b) no-match spawn → unchanged (no lesson block); emit directive still present.

@test "no-match agent (dev-python absent from store) → no lesson block, emit unchanged" {
  run_hook_lessons "glass-atrium-dev-python"
  assert_status 0
  assert_ctx_not_contains "${LESSON_NEEDLE}"
  assert_ctx_contains "${EMIT_NEEDLE}"
}

# (c) store absent → fail-open, no lesson block, emit still delivered.

@test "store file absent → fail-open, no lesson block, emit still delivered" {
  run_hook_lessons "glass-atrium-dev-shell" "/nonexistent/lessons.json"
  assert_status 0
  assert_ctx_not_contains "${LESSON_NEEDLE}"
  assert_ctx_contains "${EMIT_NEEDLE}"
}

# (d) byte cap — the lesson block never exceeds its hard cap even with an oversized lesson.

@test "oversized lesson text → lesson block byte-capped (<= 1200 bytes over its own lines)" {
  local big="${BATS_TEST_TMPDIR}/lessons-big.json"
  python3 -c '
import json
big = "Z" * 5000
json.dump({"ctm":[{"agent":"glass-atrium-dev-shell","task_type":"feature","text":big,"score":5,"frequency":9,"tombstoned":False}],"epm":[]}, open("'"${big}"'","w"))
'
  run_hook_lessons "glass-atrium-dev-shell" "${big}"
  assert_status 0
  # The whole additionalContext with the emit block + a byte-capped lesson block stays bounded;
  # the lesson block itself is capped at LESSON_MAX_BYTES (1200) so the total cannot balloon to 5000.
  local ctx nbytes; ctx="$(ctx_of)"; nbytes="$(printf '%s' "${ctx}" | wc -c | tr -cd '0-9')"
  [[ "${nbytes}" -lt 3000 ]] || { echo "expected capped ctx < 3000 bytes, got ${nbytes}" >&2; return 1; }
}

# (e) DEFAULT lesson path (no INJECT_SCOPE_RULES_LESSONS_SRC override) resolves under the seam root
# HOOK_DATA_DIR = ~/.glass-atrium/data. Seam-flip AC: at HEAD the default was ~/.claude/data/lessons.json
# (absent in the sandbox → no block), so this row FAILS pre-flip and PASSES post-flip. -u GA_DATA_ROOT
# forces HOME-anchoring so a leaked GA_DATA_ROOT cannot mask the default.
@test "default lesson path resolves under seam root ~/.glass-atrium/data (no override)" {
  local home="${BATS_TEST_TMPDIR}/seam-home"
  mkdir -p "${home}/.glass-atrium/data"
  cp "${LESSON_FIXTURE}" "${home}/.glass-atrium/data/lessons.json"
  run bash -c '
    agent="$1"; hook="$2"; home="$3"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env -u GA_DATA_ROOT \
      HOME="${home}" \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      SUBAGENT_BUDGET_METER_OFF=1 \
      INJECT_SCOPE_RULES_SRC=/nonexistent \
      INJECT_SCOPE_RULES_STYLEREF_SRC=/nonexistent \
      INJECT_SCOPE_RULES_NAMING_SRC=/nonexistent \
      bash "${hook}"
  ' _ "glass-atrium-dev-shell" "${HOOK_SH}" "${home}"
  assert_status 0
  assert_ctx_contains "${LESSON_NEEDLE}"
}
