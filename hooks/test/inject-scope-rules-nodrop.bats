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
#   write never touches the real ~/.glass-atrium/logs.
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
# Engine persist threshold: additionalContext larger than this is file-persisted + delivered as a
# ~2KB preview (stripping later blocks). A lesson-drop marker legitimately overflows the 9984 ceiling
# into the 256B margin below THIS threshold ("emit + accept"), so a full-drop assembly (7 proven blocks
# + a lesson-drop marker) is bounded by THIS, not CEILING. In sync with INJECT_CTX_MAX_BYTES header.
ENGINE_MAX_BYTES=10240
# The lesson truncate-keep residual floor — in sync with inject-scope-rules.sh LESSON_MIN_RESIDUAL_BYTES.
LESSON_FLOOR=150
# Lesson-path needles.
LESSON_HEADER_NEEDLE="Prior-lesson recall"
LESSON_KEPT_LINE="- [bug-fix] KEPTLINE_ONE_WHOLE"
DROP_MARKER_NEEDLE="Injection shed"

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

# HERMETIC lesson driver: meter OFF + all scope sources /nonexistent, so the assembled base is JUST
# the emit block. That makes the lesson residual a precise function of the injected ceiling, letting a
# test dial the truncate-keep / full-drop boundary deterministically without depending on real-source
# sizes. $1=agent $2=lessons.json path $3=ceiling override.
run_hook_lesson() {
  local agent="${1}" lessons="${2}" ceiling="${3}"
  run bash -c '
    agent="$1"; hook="$2"; lessons="$3"; ceiling="$4"; droplog="$5"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env \
      SUBAGENT_BUDGET_METER_OFF=1 \
      INJECT_SCOPE_RULES_SRC=/nonexistent \
      INJECT_SCOPE_RULES_STYLEREF_SRC=/nonexistent \
      INJECT_SCOPE_RULES_NAMING_SRC=/nonexistent \
      INJECT_SCOPE_RULES_BUDGET_SRC=/nonexistent \
      INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC=/nonexistent \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      INJECT_SCOPE_RULES_DROP_LOG="${droplog}" \
      INJECT_SCOPE_RULES_LESSONS_SRC="${lessons}" \
      INJECT_SCOPE_RULES_CTX_MAX_BYTES="${ceiling}" \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${lessons}" "${ceiling}" "${BATS_TEST_TMPDIR}/inject-drop-lesson.log"
}

# REAL-SOURCE lesson driver: like run_hook_real (meter ON, real repo sources) but with a populated
# lessons store, so the nodrop invariant is verified with a lesson present beside the proven blocks.
run_hook_real_lesson() {
  local agent="${1}" lessons="${2}"
  run bash -c '
    agent="$1"; hook="$2"; comment="$3"; styleref="$4"; naming="$5"; budget="$6"; agents="$7"; droplog="$8"; lessons="$9"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env \
      INJECT_SCOPE_RULES_SRC="${comment}" \
      INJECT_SCOPE_RULES_STYLEREF_SRC="${styleref}" \
      INJECT_SCOPE_RULES_NAMING_SRC="${naming}" \
      INJECT_SCOPE_RULES_BUDGET_SRC="${budget}" \
      INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC=/nonexistent \
      INJECT_SCOPE_RULES_AGENTS_DIR="${agents}" \
      INJECT_SCOPE_RULES_DROP_LOG="${droplog}" \
      INJECT_SCOPE_RULES_LESSONS_SRC="${lessons}" \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${COMMENT_SRC}" "${STYLEREF_SRC}" "${NAMING_SRC}" "${BUDGET_SRC}" \
    "${AGENTS_DIR}" "${BATS_TEST_TMPDIR}/inject-drop-realL.log" "${lessons}"
}

# Emit-only base byte count for an agent (meter OFF, no scope, no lesson). The hermetic lesson
# residual = ceiling - this base - 2 (the join separator), so tests compute ceilings from it.
measure_base_bytes() {
  local agent="${1}" out
  out="$(printf '%s' "$(jq -nc --arg a "${agent}" '{agent_type:$a}')" | env \
    SUBAGENT_BUDGET_METER_OFF=1 \
    INJECT_SCOPE_RULES_SRC=/nonexistent \
    INJECT_SCOPE_RULES_STYLEREF_SRC=/nonexistent \
    INJECT_SCOPE_RULES_NAMING_SRC=/nonexistent \
    INJECT_SCOPE_RULES_BUDGET_SRC=/nonexistent \
    INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC=/nonexistent \
    INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
    INJECT_SCOPE_RULES_DROP_LOG="${BATS_TEST_TMPDIR}/measure-drop.log" \
    INJECT_SCOPE_RULES_LESSONS_SRC=/nonexistent \
    INJECT_SCOPE_RULES_CTX_MAX_BYTES=20000 \
    bash "${HOOK_SH}" 2>/dev/null)"
  printf '%s' "${out}" | python3 -c '
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
' 2>/dev/null | wc -c | tr -cd '0-9'
}

# Write a lessons.json fixture with a SHORT first CTM line (KEPTLINE_ONE_WHOLE) plus a long filler
# second line, so a truncate-keep preserves the whole first line while the filler is what gets cut.
# $1=agent $2=output path $3=filler char-count.
write_lessons_short_first() {
  local agent="${1}" out="${2}" fill="${3}"
  python3 -c "
import json, sys
agent, out, fill = sys.argv[1], sys.argv[2], int(sys.argv[3])
data = {
    'ctm': [
        {'agent': agent, 'task_type': 'bug-fix', 'text': 'KEPTLINE_ONE_WHOLE', 'score': 5, 'frequency': 9},
        {'agent': agent, 'task_type': 'feature', 'text': 'F' * fill, 'score': 5, 'frequency': 8},
    ],
    'epm': [],
}
open(out, 'w').write(json.dumps(data))
" "${agent}" "${out}" "${fill}"
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
# The assembled context must decode as valid UTF-8. A mid-multibyte truncation would emit invalid
# UTF-8 → jq rejects it → OUTPUT_JSON empty → fail-open drops the WHOLE injection, so an empty ctx is
# ALSO a failure here (that is the exact corruption / fail-open this pins).
assert_ctx_valid_utf8() {
  local ctx; ctx="$(ctx_of)"
  [[ -n "${ctx}" ]] || { echo "ctx empty — fail-open (invalid UTF-8 → jq rejection) suspected" >&2; return 1; }
  printf '%s' "${ctx}" | python3 -c 'import sys; sys.stdin.buffer.read().decode("utf-8")' 2>/dev/null \
    || { echo "ctx is NOT valid UTF-8 (mid-codepoint truncation)" >&2; return 1; }
}
# The assembled context must fit under the ENGINE persist threshold (a full-drop marker may overflow
# CEILING into the 256B engine margin, but must never reach the ~2KB-preview-stripping threshold).
assert_ctx_within_engine() {
  local ctx bytes; ctx="$(ctx_of)"
  bytes="$(printf '%s' "${ctx}" | wc -c | tr -cd '0-9')"
  [[ -n "${bytes}" && "${bytes}" -le "${ENGINE_MAX_BYTES}" ]] || { echo "ctx ${bytes}B exceeds engine threshold ${ENGINE_MAX_BYTES}B" >&2; return 1; }
}
# jq-version-robust corruption guard for the multibyte-boundary case: a naive mid-codepoint cut is
# handled DIFFERENTLY by jq builds — an older/strict jq REJECTS it → empty OUTPUT_JSON → fail-open
# (empty ctx, caught by assert_ctx_valid_utf8) — while jq-1.7.x-apple SUBSTITUTES the split byte with
# U+FFFD (�), yielding a non-empty but CORRUPTED lesson. Assert the replacement char is absent so the
# pin bites regardless of the local jq's leniency.
assert_ctx_no_replacement_char() {
  local ctx; ctx="$(ctx_of)"
  printf '%s' "${ctx}" | python3 -c 'import sys; sys.exit(1 if "�" in sys.stdin.buffer.read().decode("utf-8", "replace") else 0)' \
    || { echo "ctx contains U+FFFD replacement char — mid-codepoint corruption leaked through jq" >&2; return 1; }
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

# ─────────────────────────────────────────────────────────────────────────────────────────────────
# FIX #2 (inject-block-drop): a near-ceiling lesson is TRUNCATED-AND-KEPT (not fully shed), the
# truncation is UTF-8-boundary-safe, a sub-floor residual full-drops, and the proven blocks never
# shed beside a lesson. These pin the CTM/EPM signal-loss root cause + its 3 review-caught defects.
# ─────────────────────────────────────────────────────────────────────────────────────────────────

# (i)+(ii) TRUNCATE-AND-KEEP: with a residual well above the floor, the lesson is kept as a UTF-8-safe
# truncation containing >=1 WHOLE CTM line, bounded by the residual, with NO in-context drop marker —
# the only sink record is a PARTIAL row (never a DROP row; row-shape pins live in the dropsink suite).

@test "lesson truncate-and-keep: >=1 whole CTM line kept, within residual, no drop marker" {
  local base residual ceiling
  base="$(measure_base_bytes glass-atrium-dev-front)"
  [[ -n "${base}" && "${base}" -gt 0 ]] || { echo "could not measure base bytes" >&2; return 1; }
  residual=400
  ceiling=$((base + 2 + residual))
  write_lessons_short_first "glass-atrium-dev-front" "${BATS_TEST_TMPDIR}/lessons-keep.json" 1000
  run_hook_lesson "glass-atrium-dev-front" "${BATS_TEST_TMPDIR}/lessons-keep.json" "${ceiling}"
  assert_status 0                              || return 1
  assert_ctx_contains "${EMIT_NEEDLE}"         || return 1   # non-droppable block survives
  assert_ctx_contains "${LESSON_HEADER_NEEDLE}" || return 1  # lesson PRESENT (not fully shed)
  assert_ctx_contains "${LESSON_KEPT_LINE}"    || return 1   # >=1 WHOLE CTM line, not just header
  assert_ctx_not_contains "${DROP_MARKER_NEEDLE}" || return 1 # kept ⇒ no post-loop drop marker
  assert_ctx_within_ceiling                    || return 1   # bounded by base+2+residual = ceiling
  assert_ctx_valid_utf8                         || return 1
  [[ "${output}" != *"dropped lesson block"* ]] || { echo "lesson was shed, not kept: ${output}" >&2; return 1; }
  # A kept lesson records a PARTIAL sink row — never a DROP row (which would inflate the drop count).
  ! grep -q ' DROP ' "${BATS_TEST_TMPDIR}/inject-drop-lesson.log" 2>/dev/null || { echo "unexpected DROP row on a KEPT lesson: $(cat "${BATS_TEST_TMPDIR}/inject-drop-lesson.log")" >&2; return 1; }
  grep -q ' PARTIAL ' "${BATS_TEST_TMPDIR}/inject-drop-lesson.log" 2>/dev/null || { echo "missing PARTIAL sink row on a KEPT lesson" >&2; return 1; }
}

# (iii) FULL-DROP: a residual BELOW the floor cannot hold a whole CTM line, so the lesson is fully
# dropped (drop marker + drop-log emitted) while the non-droppable emit block still survives.

@test "lesson full-drop below floor: lesson absent, drop marker + drop-log emitted, emit survives" {
  local base residual ceiling
  base="$(measure_base_bytes glass-atrium-dev-front)"
  [[ -n "${base}" && "${base}" -gt 0 ]] || { echo "could not measure base bytes" >&2; return 1; }
  residual=$((LESSON_FLOOR - 50))            # 100 < floor(150) ⇒ full-drop
  ceiling=$((base + 2 + residual))
  write_lessons_short_first "glass-atrium-dev-front" "${BATS_TEST_TMPDIR}/lessons-drop.json" 1000
  run_hook_lesson "glass-atrium-dev-front" "${BATS_TEST_TMPDIR}/lessons-drop.json" "${ceiling}"
  assert_status 0                                 || return 1
  assert_ctx_not_contains "${LESSON_HEADER_NEEDLE}" || return 1  # lesson fully dropped
  assert_ctx_not_contains "${LESSON_KEPT_LINE}"   || return 1
  assert_ctx_contains "${DROP_MARKER_NEEDLE}"     || return 1    # a genuine shed ⇒ marker present
  assert_ctx_contains "${EMIT_NEEDLE}"            || return 1    # non-droppable block survives
  assert_ctx_valid_utf8                            || return 1
  [[ "${output}" == *"dropped lesson block"* ]] || { echo "expected a lesson full-drop diagnostic" >&2; return 1; }
  [[ -s "${BATS_TEST_TMPDIR}/inject-drop-lesson.log" ]] || { echo "expected a drop-log entry on full-drop" >&2; return 1; }
}

# (iv) UTF-8 MUST-FIX: force the truncation boundary onto a MULTIBYTE char (em-dash run, residual
# offset ≡ 1 mod 3) — a naive head -c would split the codepoint → invalid UTF-8 → jq rejection →
# fail-open (empty ctx). The boundary-safe helper strips the partial tail, so ctx is valid + non-empty.

@test "lesson truncation on a multibyte boundary yields VALID UTF-8 (no fail-open corruption)" {
  local base prefix_len residual ceiling
  base="$(measure_base_bytes glass-atrium-dev-front)"
  [[ -n "${base}" && "${base}" -gt 0 ]] || { echo "could not measure base bytes" >&2; return 1; }
  # Byte length of the lesson block PREFIX before the first CTM line's text (header + Apply sub-header
  # + "- [bug-fix] "), mirroring build_lesson_block. residual = prefix + 100 lands 100 bytes into a
  # 3-byte-em-dash run (100 mod 3 = 1 ⇒ mid-codepoint) and stays above the 150B floor (prefix ~120).
  prefix_len="$(printf '%s\nApply (worked before):\n- [bug-fix] ' \
    '**Prior-lesson recall (auto-injected · CTM success + EPM warnings, agent-matched)**' \
    | wc -c | tr -cd '0-9')"
  residual=$((prefix_len + 100))
  ceiling=$((base + 2 + residual))
  # Lesson text = a 500-em-dash run (3 bytes each), so the residual cut is guaranteed inside it.
  python3 -c "
import json
open('${BATS_TEST_TMPDIR}/lessons-utf8.json', 'w').write(json.dumps({
    'ctm': [{'agent': 'glass-atrium-dev-front', 'task_type': 'bug-fix', 'text': '—' * 500, 'score': 5, 'frequency': 9}],
    'epm': [],
}))
"
  run_hook_lesson "glass-atrium-dev-front" "${BATS_TEST_TMPDIR}/lessons-utf8.json" "${ceiling}"
  assert_status 0                               || return 1
  assert_ctx_valid_utf8                          || return 1   # non-empty + valid (strict-jq fail-open path)
  assert_ctx_no_replacement_char                 || return 1   # THE must-fix: no U+FFFD (lenient-jq path)
  assert_ctx_contains "${LESSON_HEADER_NEEDLE}"  || return 1   # lesson kept (truncate path), not fail-open
  assert_ctx_contains "${EMIT_NEEDLE}"           || return 1   # whole injection survived (no fail-open)
}

# (v) NODROP INVARIANT beside a lesson (REAL sources, meter ON): dev-front's 7 proven blocks all
# survive even when a lesson is present — the marker-reserve cascade into budget-dev is prevented, and
# the assembly (proven blocks + lesson-drop marker) stays under the engine persist threshold.

@test "real dev-front + lesson: 7 proven blocks never shed, within engine threshold" {
  python3 -c "
import json
open('${BATS_TEST_TMPDIR}/lessons-real.json', 'w').write(json.dumps({
    'ctm': [{'agent': 'glass-atrium-dev-front', 'task_type': 'bug-fix', 'text': 'R' * 400, 'score': 5, 'frequency': 9}],
    'epm': [],
}))
"
  run_hook_real_lesson "glass-atrium-dev-front" "${BATS_TEST_TMPDIR}/lessons-real.json"
  assert_status 0                              || return 1
  assert_ctx_contains "${EMIT_NEEDLE}"         || return 1
  assert_ctx_contains "${METER_NEEDLE}"        || return 1
  assert_ctx_contains "${COMMENT_NEEDLE}"      || return 1
  assert_ctx_contains "${STYLEREF_NEEDLE}"     || return 1
  assert_ctx_contains "${MINIMALISM_NEEDLE}"   || return 1
  assert_ctx_contains "${NAMING_NEEDLE}"       || return 1
  assert_ctx_contains "${BUDGET_DEV_NEEDLE}"   || return 1
  assert_ctx_valid_utf8                         || return 1
  assert_ctx_within_engine                      || return 1
  # NO proven block may appear in a drop diagnostic (the lesson itself MAY be dropped).
  for proven in budget-dev naming styleref minimalism comment; do
    [[ "${output}" != *"dropped ${proven} block"* ]] || { echo "proven block '${proven}' was SHED beside a lesson: ${output}" >&2; return 1; }
  done
}
