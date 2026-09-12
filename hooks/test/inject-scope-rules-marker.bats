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
#     M4  a ceiling under the non-droppable block → emit + accept, NEVER loop, shed never silent.
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
# BATS GATING NOTE: @test bodies run under errexit; a mid-body bare `[[ ]]` / `(( ))` is inert on
#   bash 3.2.57 but GATES on CI's bash 5.3.9 — `[ ]` and plain commands gate on BOTH (measured,
#   bats 1.13.0 on both legs, so bash is the variable, not bats). Each assertion `return 1`s on
#   mismatch, so EVERY one independently fails the test.

HOOK_SH="${BATS_TEST_DIRNAME}/../inject-scope-rules.sh"

# Kept in sync with inject-scope-rules.sh (like nodrop.bats:CEILING). A source change to either
# constant must update this test.
CEILING_DEFAULT=9984
# The engine cap the ceiling above is a conservative byte proxy for: 10,000 UTF-16 code units,
# INCLUSIVE. Units are what the engine counts; bytes are never fewer, so the hook's byte budget is
# conservative rather than wrong.
ENGINE_MAX_UNITS=10000

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

  # C03: the positive-injection manifest sink writes on EVERY spawn and defaults under the live
  # ~/.glass-atrium/logs — sandbox it too (exported → inherited through each run helper's `env`).
  export INJECT_SCOPE_RULES_MANIFEST_LOG="${BATS_TEST_TMPDIR}/inject-manifest.log"
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

# Per-assertion gate helpers — an explicit `return 1` gates on every bash (see header note).
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
# Byte size of the drop marker in the LAST run's context, MEASURED rather than reconstructed from
# the hook's format literal. Which channel a shed's trace takes is not host-invariant — the marker
# embeds each shed block's source path, so its rendered size grows with the fixture's tmpdir — but it
# is fully DETERMINED by that size, so a test that measures it can assert the branch its host lands
# on instead of accepting either. 0 when the run carried no marker.
measure_marker_bytes() {
  local line
  line="$(ctx_of | grep -m1 "${MARKER_NEEDLE}" || true)"
  [[ -n "${line}" ]] || {
    printf '0'
    return 0
  }
  printf '%s' "${line}" | wc -c | tr -cd '0-9'
}
# Count of marker lines in the injected context (must be exactly one when any block is shed).
marker_count() {
  ctx_of | grep -c "${MARKER_NEEDLE}" || true
}
ctx_bytes() {
  ctx_of | wc -c | tr -cd '0-9'
}
# UTF-16 code units of the injected context — the engine's own unit. bash cannot count them and jq
# counts code points, so python3 does it. The trailing newline jq -r adds is stripped first.
ctx_units() {
  ctx_of | python3 -c 'import sys; print(len(sys.stdin.read().rstrip("\n").encode("utf-16-le"))//2)'
}

# Drive the injection for $1 against the REAL repo sources with an overridable ceiling $2 — the only
# way to put four or more PRESENT droppable blocks under ceiling pressure (the fixture harness above
# isolates comment + lesson, so it tops out at two sheds).
run_marker_real() {
  local agent="${1}" ceiling="${2}" repo="${BATS_TEST_DIRNAME}/../.."
  run bash -c '
    agent="$1"; hook="$2"; repo="$3"; droplog="$4"; counter="$5"; ceiling="$6"
    printf "%s" "{\"agent_type\":\"${agent}\"}" | env \
      INJECT_SCOPE_RULES_CTX_MAX_BYTES="${ceiling}" \
      INJECT_SCOPE_RULES_DROP_LOG="${droplog}" \
      INJECT_SCOPE_RULES_SPAWN_COUNTER="${counter}" \
      SUBAGENT_BUDGET_METER_OFF=1 \
      INJECT_SCOPE_RULES_AGENTS_DIR="${repo}/agents" \
      INJECT_SCOPE_RULES_SRC="${repo}/scoped/shared-comment-logging.md" \
      INJECT_SCOPE_RULES_STYLEREF_SRC="${repo}/scoped/scope-dev.md" \
      INJECT_SCOPE_RULES_NAMING_SRC="${repo}/scoped/shared-naming.md" \
      INJECT_SCOPE_RULES_BUDGET_SRC="${repo}/scoped/shared-turn-budget.md" \
      INJECT_SCOPE_RULES_LESSONS_SRC=/nonexistent \
      "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${repo}" "${DROPLOG}" "${COUNTER}" "${ceiling}"
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

@test "M2: a no-shed spawn keeps the FULL ceiling — the marker budget is conditional" {
  # The marker budget only exists once a block has shed, because only then is there a marker to
  # carry. This pins that conditionality: an assembly ABOVE the budgeted ceiling but at or under the
  # full one is kept whole. A small overridden ceiling makes the window cheap to hit precisely.
  local ceiling=4000 emit_bytes lowered target filler bytes
  # 1) Measure the emit-only byte size (comment block empty).
  make_comment 0
  run_marker "glass-atrium-dev-shell" "${ceiling}"
  assert_status 0
  emit_bytes="$(ctx_bytes)"
  # 2) Derive the budgeted ceiling from the hook itself rather than a hardcoded reserve: force a shed
  #    at the same ceiling and read the value it reports.
  make_comment 9000
  run_marker "glass-atrium-dev-shell" "${ceiling}"
  assert_status 0
  lowered="$(printf '%s\n' "${output}" | sed -n 's/.*injection ceiling lowered to \([0-9][0-9]*\) bytes.*/\1/p' | head -1)"
  [[ -n "${lowered}" ]] || {
    echo "no ceiling-lowered diagnostic to derive the marker budget from" >&2
    return 1
  }
  # CROSS-CHECK the parsed value against an independent computation, so a wrong budget is caught
  # rather than absorbed: reading the window's lower edge out of the hook's own diagnostic would
  # otherwise make this test agree with whatever the hook computed. The budget is definitionally the
  # full ceiling minus the join minus the RENDERED marker, and that marker is in this very run's
  # context — measured there, not rebuilt from the hook's format string.
  local marker_bytes expected_lowered
  marker_bytes="$(measure_marker_bytes)"
  [[ -n "${marker_bytes}" && "${marker_bytes}" -gt 0 ]] || {
    echo "the forced shed carried no marker to measure the budget against" >&2
    return 1
  }
  expected_lowered=$((ceiling - 2 - marker_bytes))
  [[ "${lowered}" -eq "${expected_lowered}" ]] || {
    echo "hook reported a budgeted ceiling of ${lowered}; ceiling ${ceiling} - 2 - marker ${marker_bytes} = ${expected_lowered}" >&2
    return 1
  }
  # 3) Size the comment block so the assembly lands in (lowered, full].
  target=$((ceiling - 16))
  [[ "${target}" -gt "${lowered}" ]] || skip "marker budget leaves no window (lowered=${lowered})"
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
  # The FULL ceiling was used: the assembly sits ABOVE the budgeted ceiling yet was kept (had the
  # hook budgeted unconditionally, it would have shed the comment block and emitted a marker).
  bytes="$(ctx_bytes)"
  [[ "${bytes}" -gt "${lowered}" && "${bytes}" -le $((ceiling + 1)) ]] || {
    echo "assembly ${bytes}B not in the conditional window (${lowered}, ${ceiling}]" >&2
    return 1
  }
}

# ── M3 — the ceiling lowers at MOST once per invocation (multi-shed) ─────────────────────────────

@test "M3: the ceiling-lowered diagnostic fires exactly once however many blocks shed" {
  make_lessons
  make_comment 9000 # lesson + comment both shed under the default ceiling
  run_marker "glass-atrium-dev-shell" "${CEILING_DEFAULT}" "${LESSONS}"
  assert_status 0
  # The budgeted ceiling is re-derived on EVERY shed (the marker grows with each entry), but the
  # operator needs the fact once — so the "ceiling lowered" diagnostic (merged stderr) fires EXACTLY
  # once, never per-shed.
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

# ── M4 — a ceiling under the non-droppable block → shed once, never loop, never shed silently ─────

@test "M4: a ceiling below the non-droppable block sheds once, never loops, and records the shed" {
  # A tiny ceiling below the non-droppable emit block: the one droppable block sheds, and the marker
  # is what yields if it then does not fit — it is budgeted inside the size check, so the alternative
  # would be an over-cap emit, which collapses the whole context to the ~2KB preview and costs the
  # emit directive's tail.
  #
  # WHICH channel carries the trace is host-dependent (the marker embeds the fixture's tmpdir path)
  # but it is not host-UNKNOWABLE: it is decided entirely by emit + join + rendered marker against
  # the ceiling, and every term is measurable here. So this pins the exact branch this host must
  # take. Accepting either channel would pass on a host where the marker silently stopped rendering.
  local ceiling=1300 emit_bytes marker_bytes needed
  # 1) The non-droppable emit block alone (comment block empty). ctx_of's `jq -r` appends one
  #    newline, so the reported count is one byte long.
  make_comment 0
  run_marker "glass-atrium-dev-shell" "${ceiling}"
  assert_status 0
  emit_bytes=$(($(ctx_bytes) - 1))
  [[ "${emit_bytes}" -gt 0 ]] || {
    echo "could not measure the non-droppable emit block" >&2
    return 1
  }
  # 2) The marker THIS shed renders, measured from a run of the same shed under a ceiling with room
  #    for it. Same fixture path, same shed set ⇒ byte-identical to the marker the real run builds.
  make_comment 1500
  run_marker "glass-atrium-dev-shell" $((emit_bytes + 1002))
  assert_status 0
  marker_bytes="$(measure_marker_bytes)"
  [[ -n "${marker_bytes}" && "${marker_bytes}" -gt 0 ]] || {
    echo "no marker rendered at a ceiling sized to hold one" >&2
    return 1
  }
  # 3) The real run, against a sink cleared of the probe rows above.
  : >"${DROPLOG}"
  make_comment 1500
  run_marker "glass-atrium-dev-shell" "${ceiling}"
  assert_status 0 # terminates (no infinite loop) and fails open to exit 0
  assert_ctx_contains "${EMIT_NEEDLE}"
  # At most one marker line — never re-appended by a loop.
  [[ "$(marker_count)" -le 1 ]] || {
    echo "expected at most 1 marker line under overflow, got $(marker_count)" >&2
    return 1
  }
  needed=$((emit_bytes + 2 + marker_bytes))
  if [[ "${needed}" -le "${ceiling}" ]]; then
    # The marker fits: it must be IN CONTEXT, and nothing may claim it was lost.
    assert_ctx_contains "${MARKER_NEEDLE}"
    ! grep -q ' MARKERLOST ' "${DROPLOG}" || {
      echo "marker fits (${needed}B <= ${ceiling}B) yet a MARKERLOST row was written" >&2
      return 1
    }
  else
    # The marker does not fit: it must be ABSENT from context and recorded in the sink instead.
    assert_ctx_not_contains "${MARKER_NEEDLE}"
    grep -q ' MARKERLOST ' "${DROPLOG}" || {
      echo "marker cannot fit (${needed}B > ${ceiling}B) yet no MARKERLOST row was written (log: $(cat "${DROPLOG}"))" >&2
      return 1
    }
  fi
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
  # Total injected UTF-16 units (marker included) stay at or under the ceiling.
  local units
  units="$(ctx_units)"
  [[ -n "${units}" && "${units}" -le "${CEILING_DEFAULT}" ]] || {
    echo "widened assembly ${units} units exceeds the ceiling ${CEILING_DEFAULT}" >&2
    return 1
  }
  # Exactly one real shed (comment) is named — the marker's own budget costs no additional block.
  assert_ctx_contains "Injection shed 01"
}

# ── A6 — four or more sheds: the marker is budgeted INSIDE the size check ─────────────────────────

@test "A6: a marker naming four or more sheds keeps the emitted total within the ceiling" {
  # The defect this pins: a fixed 256B reserve was appended-to AFTER the size check, so a marker
  # naming four or more shed blocks outgrew the reserve and pushed the emit past the cap. At the 3975
  # ceiling below, the retired model stops shedding the dev-front assembly at 3717B, appends a 261B
  # marker and emits 3980B over a 3975B ceiling; the marker-budgeted model sheds once more and emits
  # 1430B.
  #
  # THE GOVERNING VARIABLE IS THE REPO CHECKOUT PATH LENGTH, not the source-block sizes: the marker
  # names each shed block by its ABSOLUTE source path, so every entry grows one-for-one with the
  # length of the checkout root this suite runs from. Measured on the retired model at three roots,
  # the over-ceiling emit is 4004 units at a 19-character root, 4094 at the 38-character CI root and
  # 4244 at this worktree's 68-character root — all of them above 3975, so the discrimination holds
  # across the whole realistic range rather than in a narrow byte window. It fails only BELOW roughly
  # a 13-character root, where the retired model's emit would drop under the ceiling and this test
  # would pass on the defective code. Re-derive the ceiling if a source block size moves, and keep it
  # low enough that the shortest plausible checkout still discriminates.
  run_marker_real "glass-atrium-dev-front" 3975
  assert_status 0
  local sheds units
  sheds="$(ctx_of | grep -o 'Injection shed [0-9][0-9]' | head -1 | tr -cd '0-9')"
  [[ -n "${sheds}" && "$((10#${sheds}))" -ge 4 ]] || {
    echo "fixture did not produce four or more sheds (got '${sheds}')" >&2
    return 1
  }
  units="$(ctx_units)"
  [[ -n "${units}" && "${units}" -le 3975 ]] || {
    echo "assembly with a ${sheds}-shed marker is ${units} units, over the 3975 ceiling" >&2
    return 1
  }
  # The marker survived: the budget made room for it rather than the emit exceeding the cap.
  assert_ctx_contains "${MARKER_NEEDLE}"
  # And the emitted total also sits under the engine cap the ceiling proxies for.
  [[ "${units}" -le "${ENGINE_MAX_UNITS}" ]] || {
    echo "assembly ${units} units exceeds the engine cap ${ENGINE_MAX_UNITS}" >&2
    return 1
  }
}
