#!/usr/bin/env bats
# inject-scope-rules-nodrop.bats — recurrence-prevention pin for the SubagentStart slot-1 ceiling.
#
#   Slot 1 carries the non-droppable emit/meter pair plus the roster-gated wiki-untrusted, budget and
#   lesson blocks; scope-file text rides the part slots. This suite PINS, against the REAL repo
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
# Engine persist cap: additionalContext larger than this is file-persisted + delivered as a ~2KB
# preview (stripping later blocks). 10,000 UTF-16 code UNITS, INCLUSIVE — measured by the W1 channel
# probe on a SINGLE host build, which is the whole provenance: no producer-side check can see a real
# cap LOWER than this, since a short cap is observable only at the consumer (W9(b) is that detector).
# Raising this guard above the measured figure would let an emit the engine persists pass the suite,
# so it moves only on a new measurement. The hook budgets bytes, which are never fewer than units for
# this corpus, so its byte ceiling stays a conservative proxy for this cap.
ENGINE_MAX_UNITS=10000
# The lesson truncate-keep residual floor — in sync with inject-scope-rules.sh LESSON_MIN_RESIDUAL_BYTES.
LESSON_FLOOR=150
# Lesson-path needles.
LESSON_HEADER_NEEDLE="Prior-lesson recall"
LESSON_KEPT_LINE="- [bug-fix] KEPTLINE_ONE_WHOLE"
DROP_MARKER_NEEDLE="Injection shed"

# Stable first-line needles for the slot-1 blocks.
EMIT_NEEDLE="REQUIRED by the outcome recorder"
METER_NEEDLE="Turn-budget meter"
BUDGET_DEV_NEEDLE="Budget sizing (auto-injected DEV"
BUDGET_ANALYSIS_NEEDLE="Budget sizing (auto-injected analysis"
WIKI_UNTRUSTED_NEEDLE="Wiki raw-store untrusted-data clause"

# Leads of the five blocks slot 1 no longer extracts — the part slots deliver their sources.
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
# meter ON. $2 (optional) = lessons.json path; $3 (optional) = drop log path.
run_hook_real() {
  local agent="${1}" lessons="${2:-/nonexistent}" droplog="${3:-${BATS_TEST_TMPDIR}/inject-drop.log}"
  run bash -c '
    agent="$1"; hook="$2"; budget="$3"; wiki="$4"; agents="$5"; droplog="$6"; lessons="$7"
    payload="$(jq -nc --arg a "${agent}" '\''{agent_type:$a}'\'')"
    printf "%s" "${payload}" | env -u SUBAGENT_BUDGET_METER_OFF \
      INJECT_SCOPE_RULES_BUDGET_SRC="${budget}" \
      INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC="${wiki}" \
      INJECT_SCOPE_RULES_AGENTS_DIR="${agents}" \
      INJECT_SCOPE_RULES_DROP_LOG="${droplog}" \
      INJECT_SCOPE_RULES_LESSONS_SRC="${lessons}" \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${BUDGET_SRC}" "${WIKI_UNTRUSTED_SRC}" "${AGENTS_DIR}" "${droplog}" "${lessons}"
}

# HERMETIC lesson driver: meter OFF + every block source /nonexistent, so the assembled base is JUST
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
      INJECT_SCOPE_RULES_BUDGET_SRC=/nonexistent \
      INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC=/nonexistent \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      INJECT_SCOPE_RULES_DROP_LOG="${droplog}" \
      INJECT_SCOPE_RULES_LESSONS_SRC="${lessons}" \
      INJECT_SCOPE_RULES_CTX_MAX_BYTES="${ceiling}" \
      bash "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${lessons}" "${ceiling}" "${BATS_TEST_TMPDIR}/inject-drop-lesson.log"
}

# The additionalContext text one hook run emits for $1 under the extra env assignments in $2..; no
# lesson store, a sandboxed drop log. stdout: the context, no trailing newline.
emit_ctx() {
  local agent="${1}"
  shift
  printf '%s' "$(jq -nc --arg a "${agent}" '{agent_type:$a}')" | env -u SUBAGENT_BUDGET_METER_OFF "$@" \
    INJECT_SCOPE_RULES_DROP_LOG="${BATS_TEST_TMPDIR}/measure-drop.log" \
    INJECT_SCOPE_RULES_LESSONS_SRC=/nonexistent \
    bash "${HOOK_SH}" 2>/dev/null | jq -j '.hookSpecificOutput.additionalContext // empty'
}

# Emit-only context (meter OFF, no block source, no lesson).
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

# Emit-only base byte count. The hermetic lesson residual = ceiling - this base - 2 (the join
# separator), so tests compute ceilings from it.
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
# The assembled context must decode as valid UTF-8. A mid-multibyte truncation would emit invalid
# UTF-8 → jq rejects it → OUTPUT_JSON empty → fail-open drops the WHOLE injection, so an empty ctx is
# ALSO a failure here (that is the exact corruption / fail-open this pins).
assert_ctx_valid_utf8() {
  local ctx; ctx="$(ctx_of)"
  [[ -n "${ctx}" ]] || { echo "ctx empty — fail-open (invalid UTF-8 → jq rejection) suspected" >&2; return 1; }
  printf '%s' "${ctx}" | python3 -c 'import sys; sys.stdin.buffer.read().decode("utf-8")' 2>/dev/null \
    || { echo "ctx is NOT valid UTF-8 (mid-codepoint truncation)" >&2; return 1; }
}
# The assembled context must fit the ENGINE persist cap, counted in the engine's own unit.
assert_ctx_within_engine() {
  local ctx units; ctx="$(ctx_of)"
  units="$(printf '%s' "${ctx}" | python3 -c 'import sys; print(len(sys.stdin.read().encode("utf-16-le"))//2)')"
  [[ -n "${units}" && "${units}" -le "${ENGINE_MAX_UNITS}" ]] || { echo "ctx ${units} units exceeds engine cap ${ENGINE_MAX_UNITS}" >&2; return 1; }
}
# A LESSON full-drop can never carry its in-context marker, on any host — so this asserts the one
# branch rather than accepting either, which would also pass on a host where the marker silently
# stopped being written at all. The proof is arithmetic, not a measurement of this host: the room
# left for the marker after the lesson is dropped IS the room the lesson was denied
# (ceiling - base - 2); a full drop happens only when that room is below LESSON_FLOOR; and the lesson
# is the one block whose marker entry carries no source path, so its marker renders at a constant
# 167B whatever the checkout or tmpdir. 167 > 150, always. Args: $1=drop log path.
assert_marker_lost() {
  local log="${1}"
  assert_ctx_not_contains "${DROP_MARKER_NEEDLE}" || return 1
  grep -q ' MARKERLOST ' "${log}" || {
    echo "a shed whose marker cannot fit left no MARKERLOST record (log: $(cat "${log}" 2>/dev/null))" >&2
    return 1
  }
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

# ─────────────────────────────────────────────────────────────────────────────────────────────────
# FIX #2 (inject-block-drop): a near-ceiling lesson is TRUNCATED-AND-KEPT (not fully shed), the
# truncation is UTF-8-boundary-safe, and a sub-floor residual full-drops. These pin the CTM/EPM
# signal-loss root cause + its 3 review-caught defects.
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
  local bytes; bytes="$(ctx_bytes_of)"
  [[ "${bytes}" -le "${ceiling}" ]] || { echo "ctx ${bytes}B exceeds the dialled ceiling ${ceiling}B" >&2; return 1; }
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
  # A genuine shed is never silent. The marker is budgeted INSIDE the ceiling, and this case pins a
  # deliberately tiny one (base + 102B) with no room for it, so the recorded omission is the only
  # channel left — asserted as that one branch, not as either.
  assert_marker_lost "${BATS_TEST_TMPDIR}/inject-drop-lesson.log" || return 1
  # And the branch is DERIVED, not assumed: the MARKERLOST row's pre_drop_bytes is base + 2 + the
  # rendered marker, so the marker's own size falls out of it — and it must exceed the residual the
  # lesson was denied, which is what makes the omission inevitable rather than incidental.
  local pre marker_bytes
  pre="$(grep -m1 ' MARKERLOST ' "${BATS_TEST_TMPDIR}/inject-drop-lesson.log" | grep -o 'pre_drop_bytes=[0-9]*' | cut -d= -f2)"
  [[ -n "${pre}" ]] || { echo "MARKERLOST row carries no pre_drop_bytes" >&2; return 1; }
  marker_bytes=$((pre - base - 2))
  [[ "${marker_bytes}" -gt "${residual}" ]] || { echo "marker ${marker_bytes}B would have fit the ${residual}B residual, yet was dropped" >&2; return 1; }
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

# (v) REAL sources, meter ON, a one-entry lesson store: dev-front's lesson block arrives WHOLE beside
# emit + meter + budget-dev, nothing sheds, and the drop sink stays empty. Slot 1 = the lesson-free
# assembly + 2 + the lesson block, so the lesson is neither truncated nor accompanied by anything else.

@test "real dev-front + one-entry lesson store → lesson kept whole, emit + meter + budget-dev kept, drop sink empty" {
  local lesson_text lessons base_bytes lesson_block_bytes
  lesson_text="$(python3 -c 'print("R" * 400)')"
  lessons="${BATS_TEST_TMPDIR}/lessons-real.json"
  python3 -c "
import json, sys
open(sys.argv[1], 'w').write(json.dumps({
    'ctm': [{'agent': 'glass-atrium-dev-front', 'task_type': 'bug-fix', 'text': sys.argv[2], 'score': 5, 'frequency': 9}],
    'epm': [],
}))
" "${lessons}" "${lesson_text}"

  run_hook_real "glass-atrium-dev-front"
  assert_status 0 || return 1
  base_bytes="$(ctx_bytes_of)"

  run_hook_real "glass-atrium-dev-front" "${lessons}" "${BATS_TEST_TMPDIR}/inject-drop-realL.log"
  assert_status 0                                   || return 1
  assert_no_drop                                    || return 1
  assert_ctx_contains "${EMIT_NEEDLE}"              || return 1
  assert_ctx_contains "${METER_NEEDLE}"             || return 1
  assert_ctx_contains "${BUDGET_DEV_NEEDLE}"        || return 1
  assert_ctx_contains "${LESSON_HEADER_NEEDLE}"     || return 1
  assert_ctx_contains "- [bug-fix] ${lesson_text}"  || return 1
  assert_ctx_not_contains "${DROP_MARKER_NEEDLE}"   || return 1
  assert_no_retired_block                           || return 1
  assert_ctx_valid_utf8                             || return 1
  assert_ctx_within_engine                          || return 1
  [[ ! -s "${BATS_TEST_TMPDIR}/inject-drop-realL.log" ]] || {
    echo "drop sink written beside a whole lesson: $(cat "${BATS_TEST_TMPDIR}/inject-drop-realL.log")" >&2
    return 1
  }
  lesson_block_bytes="$(printf '%s\nApply (worked before):\n- [bug-fix] %s' \
    '**Prior-lesson recall (auto-injected · CTM success + EPM warnings, agent-matched)**' "${lesson_text}" \
    | wc -c | tr -cd '0-9')"
  [[ "$(ctx_bytes_of)" -eq $((base_bytes + 2 + lesson_block_bytes)) ]] || {
    echo "slot 1 with lesson is $(ctx_bytes_of)B, expected ${base_bytes} + 2 + ${lesson_block_bytes}" >&2
    return 1
  }
}
