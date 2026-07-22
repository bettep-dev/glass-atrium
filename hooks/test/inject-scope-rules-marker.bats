#!/usr/bin/env bats
# inject-scope-rules-marker.bats — T16 (in-context drop marker) + AM-T16 (per-block source path).
#
#   A dropped scope block is silent to the subagent — it learns nothing about what it is missing.
#   T16 appends ONE terse, NON-DROPPABLE marker line (placed AFTER the shed loop) naming each shed
#   block, under a CONDITIONALLY reserved ceiling that lowers exactly ONCE. AM-T16 gives each
#   RULE-DOC-SOURCED named block its Read-resolvable source path (+ a "you MAY Read it" clause); the
#   LESSON block is the runtime-derived exception, tagged and carrying NO path.
#
#   ACs pinned here (T16):
#     M1  a forced shed → exactly one fixed-width marker line naming each shed block (also AM-T16's
#         positive-coupling precondition: >=1 block named under a forced shed).
#     M2  no shed → NO marker AND the FULL ceiling was used (fixture sized between the two ceilings).
#     M3  the ceiling lowers at MOST once per invocation (multi-shed → one "ceiling lowered" diag).
#     M4  overflow (non-droppable + marker over the reduced ceiling) → emit + accept, NEVER loop.
#     M5  every present droppable block shed → the non-droppable emit + marker survive, exit 0.
#   ACs pinned here (AM-T16):
#     A2  a rule-doc-sourced named block carries its resolvable source path.
#     A3  an emitted rule-doc-sourced path EXISTS.
#     A4  the lesson block is tagged "runtime-derived, no source path" and carries ZERO path.
#     A5  the widened marker stays within the ceiling (byte accounting converges, no extra shed).
#
#   FAIL-AT-HEAD: HEAD appends NO marker at all, so every marker-presence AC (M1, M3-M5, A2-A5)
#   fails against the pre-T16 hook and passes after. M2 is a preserved invariant (the pre-T16 hook
#   also emits no marker on a no-shed spawn) but its full-ceiling assertion pins the conditional
#   reserve the pre-T16 hook lacks.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail. Each
#   assertion `return 1`s on mismatch, so EVERY one independently fails the test.

HOOK_SH="${BATS_TEST_DIRNAME}/../inject-scope-rules.sh"

# Kept in sync with inject-scope-rules.sh (like nodrop.bats:CEILING). A source change to either
# constant must update this test.
CEILING_DEFAULT=9984
MARKER_RESERVE=256
REDUCED_DEFAULT=9728 # CEILING_DEFAULT - MARKER_RESERVE (impl: INJECT_MARKER_RESERVE)

MARKER_NEEDLE='Injection shed'
EMIT_NEEDLE='REQUIRED by the outcome recorder'
# The EXACT AM-T16 lesson tag — asserted verbatim (the amendment says "tag it exactly").
LESSON_TAG='lesson: runtime-derived, no source path — recovers via re-spawn, not Read'

setup() {
  [[ -x "${HOOK_SH}" ]] || skip "hook not executable: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"

  DROPLOG="${BATS_TEST_TMPDIR}/drop.log"
  COUNTER="${BATS_TEST_TMPDIR}/spawns.count"
  COMMENT="${BATS_TEST_TMPDIR}/comment.md"
  LESSONS="${BATS_TEST_TMPDIR}/lessons.json"
}

# Write a comment fixture whose EXTRACTED block is exactly $1 bytes (a single line of x's, no header
# so the block byte size is controllable). $1 == 0 → an empty block (isolates the emit block).
make_comment() {
  local n="${1}"
  {
    printf '%s\n' 'pre' '<!-- AGENT-INJECT:START -->'
    if [[ "${n}" -gt 0 ]]; then
      head -c "${n}" /dev/zero | tr '\0' 'x'
      printf '\n'
    fi
    printf '%s\n' '<!-- AGENT-INJECT:END -->' 'post'
  } >"${COMMENT}"
}

# Write a lesson store with one big CTM lesson for glass-atrium-dev-shell (present → shed candidate).
make_lessons() {
  local text
  text="$(head -c 4000 /dev/zero | tr '\0' 'L')"
  jq -nc --arg t "${text}" \
    '{ctm:[{agent:"glass-atrium-dev-shell",task_type:"bug-fix",text:$t,score:5,frequency:3}]}' \
    >"${LESSONS}"
}

# Drive the hook's SubagentStart injection for $1 with the comment fixture, an overridable ceiling
# $2, and an optional lesson store $3 (default absent). All other scope sources are /nonexistent and
# the meter is off, isolating comment (+ lesson). The drop sink + counter go to the Bats tmpdir.
run_marker() {
  local agent="${1}" ceiling="${2}" lessons="${3:-/nonexistent}"
  run bash -c '
    agent="$1"; hook="$2"; comment="$3"; droplog="$4"; counter="$5"; ceiling="$6"; lessons="$7"
    printf "%s" "{\"agent_type\":\"${agent}\"}" | env \
      INJECT_SCOPE_RULES_CTX_MAX_BYTES="${ceiling}" \
      INJECT_SCOPE_RULES_DROP_LOG="${droplog}" \
      INJECT_SCOPE_RULES_SPAWN_COUNTER="${counter}" \
      SUBAGENT_BUDGET_METER_OFF=1 \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      INJECT_SCOPE_RULES_SRC="${comment}" \
      INJECT_SCOPE_RULES_STYLEREF_SRC=/nonexistent \
      INJECT_SCOPE_RULES_NAMING_SRC=/nonexistent \
      INJECT_SCOPE_RULES_BUDGET_SRC=/nonexistent \
      INJECT_SCOPE_RULES_LESSONS_SRC="${lessons}" \
      "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${COMMENT}" "${DROPLOG}" "${COUNTER}" "${ceiling}" "${lessons}"
}

# additionalContext string from the hook's JSON stdout (the JSON line is the only one starting '{';
# merged stderr diagnostics are filtered out). Empty on no JSON.
ctx_of() {
  local json
  json="$(printf '%s\n' "${output}" | grep -m1 '^{' || true)"
  [[ -n "${json}" ]] || return 0
  printf '%s' "${json}" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || true
}

# Per-assertion gate helpers (bodies are NOT under set -e).
assert_status() {
  [[ "${status}" -eq "${1}" ]] || {
    echo "expected status ${1}, got ${status} (output: ${output})" >&2
    return 1
  }
}
assert_ctx_contains() {
  local ctx
  ctx="$(ctx_of)"
  [[ "${ctx}" == *"${1}"* ]] || {
    echo "expected additionalContext to contain [${1}]; ctx=[${ctx}]" >&2
    return 1
  }
}
assert_ctx_not_contains() {
  local ctx
  ctx="$(ctx_of)"
  [[ "${ctx}" != *"${1}"* ]] || {
    echo "expected additionalContext to NOT contain [${1}]" >&2
    return 1
  }
}
# Count of marker lines in the injected context (must be exactly one when any block is shed).
marker_count() {
  ctx_of | grep -c "${MARKER_NEEDLE}" || true
}
ctx_bytes() {
  ctx_of | wc -c | tr -cd '0-9'
}

# ── M1 / AM-T16 positive precondition — forced shed → exactly one marker naming each shed block ───

@test "M1: a forced shed emits exactly one fixed-width marker naming the shed block (>=1 named)" {
  make_comment 11000 # a block that alone blows the ceiling → forces the drop loop
  run_marker "glass-atrium-dev-shell" "${CEILING_DEFAULT}"
  assert_status 0
  # Exactly ONE marker line (T16 AC: "exactly one fixed-width marker line").
  [[ "$(marker_count)" -eq 1 ]] || {
    echo "expected exactly 1 marker line, got $(marker_count)" >&2
    return 1
  }
  # AM-T16 positive-coupling precondition: the marker NAMES at least one block (fixed-width count).
  assert_ctx_contains "Injection shed 01"
  assert_ctx_contains "comment: "
}

# ── AM-T16 A2 / A3 — a rule-doc-sourced named block carries a RESOLVABLE, EXISTING source path ────

@test "A2/A3: a rule-doc-sourced shed block carries its resolvable, existing source path" {
  make_comment 11000
  run_marker "glass-atrium-dev-shell" "${CEILING_DEFAULT}"
  assert_status 0
  # The marker carries the ACTUAL source path the comment block was extracted from (the fixture).
  assert_ctx_contains "comment: ${COMMENT}"
  # A3: that emitted path RESOLVES to an existing file.
  [[ -f "${COMMENT}" ]] || {
    echo "marker-carried path does not exist: ${COMMENT}" >&2
    return 1
  }
}

# ── AM-T16 A4 — the lesson block is tagged runtime-derived and carries ZERO path ─────────────────

@test "A4: the lesson block is tagged 'runtime-derived, no source path' with zero path claimed" {
  make_lessons
  make_comment 9000 # emit + lesson + comment all exceed the ceiling → lesson (lowest) sheds first
  run_marker "glass-atrium-dev-shell" "${CEILING_DEFAULT}" "${LESSONS}"
  assert_status 0
  # The EXACT runtime-derived tag is present (AM-T16: "tag it exactly").
  assert_ctx_contains "${LESSON_TAG}"
  # The lesson entry claims no path: the runtime-derived tag itself contains "no source path", and
  # no LESSONS store path leaks into the marker (only rule-doc paths appear as "<label>: <path>").
  assert_ctx_not_contains "lesson: ${LESSONS}"
  assert_ctx_not_contains "${LESSONS}"
}

# ── M2 — no shed → NO marker AND the FULL ceiling was used (fixture between the two ceilings) ─────

@test "M2: a spawn sized between the two ceilings sheds nothing and emits no marker" {
  # Use a small overridden ceiling so the between-ceilings window is cheap to hit precisely.
  local ceiling=4000 reduced=3744 target=3872 emit_bytes filler
  # 1) Measure the emit-only byte size (comment block empty).
  make_comment 0
  run_marker "glass-atrium-dev-shell" "${ceiling}"
  assert_status 0
  emit_bytes="$(ctx_bytes)"
  # 2) Size the comment block so the assembly lands in (reduced, full]: target ~3872, safely inside.
  filler=$((target - emit_bytes - 2)) # 2 = the "\n\n" join between emit and comment
  [[ "${filler}" -gt 0 ]] || skip "emit block larger than target window (emit=${emit_bytes})"
  make_comment "${filler}"
  run_marker "glass-atrium-dev-shell" "${ceiling}"
  assert_status 0
  # No block was shed → NO marker line at all.
  [[ "$(marker_count)" -eq 0 ]] || {
    echo "unexpected marker on a no-shed spawn: $(ctx_of)" >&2
    return 1
  }
  # The FULL ceiling was used: the assembly is ABOVE the reduced ceiling yet was kept (had the hook
  # reserved unconditionally, it would have shed the comment block and emitted a marker).
  local bytes
  bytes="$(ctx_bytes)"
  [[ "${bytes}" -gt "${reduced}" && "${bytes}" -le $((ceiling + 1)) ]] || {
    echo "assembly ${bytes}B not in the between-ceilings window (${reduced}, ${ceiling}]" >&2
    return 1
  }
}

# ── M3 — the ceiling lowers at MOST once per invocation (multi-shed) ─────────────────────────────

@test "M3: the ceiling lowers at most once even when multiple blocks shed" {
  make_lessons
  make_comment 9000 # lesson + comment both shed under the default ceiling
  run_marker "glass-atrium-dev-shell" "${CEILING_DEFAULT}" "${LESSONS}"
  assert_status 0
  # The "ceiling lowered" diagnostic (merged stderr) fires EXACTLY once — the conditional reserve
  # lowers the ceiling one time, never per-shed.
  local lowered
  lowered="$(printf '%s\n' "${output}" | grep -c 'injection ceiling lowered' || true)"
  [[ "${lowered}" -eq 1 ]] || {
    echo "ceiling-lowered diagnostic fired ${lowered} times, expected 1" >&2
    return 1
  }
  # Both real sheds are named (2 present blocks): the fixed-width count reads 02.
  assert_ctx_contains "Injection shed 02"
  assert_ctx_contains "${LESSON_TAG}"
  assert_ctx_contains "comment: ${COMMENT}"
}

# ── M4 — overflow: non-droppable content + marker over the reduced ceiling → emit + accept, no loop ─

@test "M4: non-droppable content plus the marker over the reduced ceiling is emitted, not looped" {
  # A tiny ceiling (reduced = 1300 - 256 = 1044) below the emit block size: after the one droppable
  # block sheds, emit + marker exceed the reduced ceiling. The hook must emit and NOT loop.
  make_comment 1500
  run_marker "glass-atrium-dev-shell" 1300
  assert_status 0 # terminates (no infinite loop) and fails open to exit 0
  # The non-droppable emit block survives, and the marker is appended despite the overflow.
  assert_ctx_contains "${EMIT_NEEDLE}"
  assert_ctx_contains "${MARKER_NEEDLE}"
  # Exactly one marker line (never re-appended by a loop).
  [[ "$(marker_count)" -eq 1 ]] || {
    echo "expected exactly 1 marker line under overflow, got $(marker_count)" >&2
    return 1
  }
}

# ── M5 — every present droppable block shed → non-droppable emit + marker survive, exit 0 ─────────

@test "M5: with the only droppable block shed, the non-droppable emit and the marker still emit" {
  make_comment 11000 # comment is the sole present droppable → shedding it leaves only emit + marker
  run_marker "glass-atrium-dev-shell" "${CEILING_DEFAULT}"
  assert_status 0
  # The CTX-empty fail-open skip must NOT fire (emit is non-droppable) → a valid injection is emitted.
  local ctx
  ctx="$(ctx_of)"
  [[ -n "${ctx}" ]] || {
    echo "no injection emitted after shedding the only droppable block" >&2
    return 1
  }
  assert_ctx_contains "${EMIT_NEEDLE}"
  assert_ctx_contains "${MARKER_NEEDLE}"
}

# ── AM-T16 A5 — the widened marker stays within the ceiling (byte accounting converges) ───────────

@test "A5: the widened marker keeps total injected bytes within the ceiling, no unintended shed" {
  make_comment 11000
  run_marker "glass-atrium-dev-shell" "${CEILING_DEFAULT}"
  assert_status 0
  # Total injected bytes (marker included) stay at or under the ceiling (+1 tolerance for jq's
  # trailing newline in ctx_of).
  local bytes
  bytes="$(ctx_bytes)"
  [[ -n "${bytes}" && "${bytes}" -le $((CEILING_DEFAULT + 1)) ]] || {
    echo "widened assembly ${bytes}B exceeds the ceiling ${CEILING_DEFAULT}B" >&2
    return 1
  }
  # Exactly one real shed (comment) is named — no unintended extra shed beyond the designed reserve.
  assert_ctx_contains "Injection shed 01"
}
