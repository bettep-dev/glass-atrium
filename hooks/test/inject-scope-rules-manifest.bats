#!/usr/bin/env bats
# inject-scope-rules-manifest.bats — C03: the bounded per-spawn injection manifest and its reader.
#
#   The drop sink records only what was SHED, so "did this agent actually see that rule at that spawn"
#   was an assumption. C03 emits one bounded manifest line per injection-attempted spawn naming the
#   kept block labels with their source paths, the assembled byte size, an optional digest and — for
#   the runtime-derived lesson block alone — the injected lesson ids and scores. Its reader
#   (`--manifest-coverage`) is a required co-deliverable: the writer alone is an orphaned signal.
#
#   ACs pinned here:
#     AC1  an injection-attempted spawn emits EXACTLY one manifest line naming the kept block labels
#          and the assembled byte size (which equals the bytes actually delivered to the child).
#     AC2  an operator introspection mode (--drop-rate / --manifest-coverage) emits NO manifest line.
#     AC3  the manifest writes to its OWN sink: the drop-rate numerator and denominator are identical
#          with manifest emission enabled.
#     AC4  an unwritable manifest sink leaves the injection and the exit status unchanged (fail-open).
#     AC5  an absent digest tool still writes the line, without a digest field, exit status unchanged.
#     AC6  the kept lesson carries its ids and scores plus a truncation flag that never over-claims.
#     AC7  the reader reports per-agent block coverage matching the fixture sink.
#
#   FAIL-AT-HEAD: 12 of the 14 rows fail against the pre-C03 hook, which writes no manifest sink at all
#   and treats the reader flag as an ordinary no-arg hook invocation. Every row that could pass VACUOUSLY
#   on an absent sink (the two that assert a field is NOT present) is anchored by an accompanying
#   line-count assertion, so absence of the whole sink fails them. AC3 and AC4 are the two deliberate
#   exceptions — preserved invariants guarding that the new sink never corrupts the drop-rate signal and
#   that its append can never trip the ERR trap into a spawn-suppressing exit.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail. Every
#   assertion `return 1`s on mismatch, so EACH one independently fails the test.

HOOK_SH="${BATS_TEST_DIRNAME}/../inject-scope-rules.sh"

setup() {
  [[ -x "${HOOK_SH}" ]] || skip "hook not executable: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"

  MANIFEST="${BATS_TEST_TMPDIR}/manifest.log"
  DROPLOG="${BATS_TEST_TMPDIR}/drop.log"
  COUNTER="${BATS_TEST_TMPDIR}/spawns.count"
  LESSONS="${BATS_TEST_TMPDIR}/lessons.json"

  # A comment fixture whose one small block sits well under the ceiling → a no-drop spawn.
  COMMENT_FIT="${BATS_TEST_TMPDIR}/comment-fit.md"
  printf '%s\n' \
    'preamble (must not reach the child)' \
    '<!-- AGENT-INJECT:START -->' \
    '**Comment-rule core (test block)**' \
    'body line' \
    '<!-- AGENT-INJECT:END -->' \
    'trailer (must not reach the child)' >"${COMMENT_FIT}"

  # An oversized (~12 KB) comment fixture whose block alone exceeds the ceiling → forces a drop.
  COMMENT_BIG="${BATS_TEST_TMPDIR}/comment-big.md"
  {
    printf '%s\n' 'preamble' '<!-- AGENT-INJECT:START -->' '**Comment-rule core (test block)**'
    head -c 11000 /dev/zero | tr '\0' 'x'
    printf '\n%s\n%s\n' '<!-- AGENT-INJECT:END -->' 'trailer'
  } >"${COMMENT_BIG}"
}

# Drive the hook's SubagentStart injection path. All scope sources except the comment block are
# sandboxed to /nonexistent and the meter is off, so the assembly is emit + comment (+ lesson when a
# store is given). $1=agent $2=comment source $3=lessons store $4=extra env assignment (may be empty).
run_inject() {
  local agent="${1}" comment_src="${2}" lessons="${3:-/nonexistent}" extra="${4:-IGNORED_BY_HOOK=1}"
  run bash -c '
    agent="$1"; hook="$2"; comment="$3"; lessons="$4"; extra="$5"
    manifest="$6"; droplog="$7"; counter="$8"; ceiling="$9"
    printf "%s" "{\"agent_type\":\"${agent}\",\"agent_id\":\"sess-A1\"}" | env \
      INJECT_SCOPE_RULES_MANIFEST_LOG="${manifest}" \
      INJECT_SCOPE_RULES_DROP_LOG="${droplog}" \
      INJECT_SCOPE_RULES_SPAWN_COUNTER="${counter}" \
      INJECT_SCOPE_RULES_CTX_MAX_BYTES="${ceiling}" \
      SUBAGENT_BUDGET_METER_OFF=1 \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      INJECT_SCOPE_RULES_SRC="${comment}" \
      INJECT_SCOPE_RULES_STYLEREF_SRC=/nonexistent \
      INJECT_SCOPE_RULES_NAMING_SRC=/nonexistent \
      INJECT_SCOPE_RULES_BUDGET_SRC=/nonexistent \
      INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC=/nonexistent \
      INJECT_SCOPE_RULES_LESSONS_SRC="${lessons}" \
      "${extra}" \
      "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${comment_src}" "${lessons}" "${extra}" \
    "${MANIFEST}" "${DROPLOG}" "${COUNTER}" "${CEILING_OVERRIDE:-9984}"
}

# Drive an operator introspection mode. stdin is /dev/null so a pre-C03 hook (no dispatch for the new
# mode → hook_read_input's blocking cat) cannot hang the suite. $1=mode flag.
run_query() {
  run bash -c '
    hook="$1"; mode="$2"; manifest="$3"; droplog="$4"; counter="$5"
    env INJECT_SCOPE_RULES_MANIFEST_LOG="${manifest}" \
      INJECT_SCOPE_RULES_DROP_LOG="${droplog}" \
      INJECT_SCOPE_RULES_SPAWN_COUNTER="${counter}" \
      "${hook}" "${mode}" </dev/null
  ' _ "${HOOK_SH}" "${1}" "${MANIFEST}" "${DROPLOG}" "${COUNTER}"
}

# A lesson store for $1 with a short first CTM line plus a $2-char filler, mirroring the dropsink
# suite's fixture so the truncate-keep boundary is dialable.
write_lessons() {
  local agent="${1}" fill="${2}"
  jq -nc --arg a "${agent}" --argjson n "${fill}" '{
    ctm: [
      {agent: $a, task_type: "bug-fix", text: "KEPTLINE_ONE_WHOLE", score: 5, frequency: 9},
      {agent: $a, task_type: "feature", text: ("F" * $n), score: 4, frequency: 8}
    ],
    epm: [{agent: $a, task_type: "refactor", text: "EPM_NEVER_EVAL", score: 2, frequency: 3}]
  }' >"${LESSONS}"
}

manifest_lines() {
  if [[ -f "${MANIFEST}" ]]; then
    grep -c ' MANIFEST ' "${MANIFEST}" || true
  else
    printf '0'
  fi
}

assert_status() {
  [[ "${status}" -eq "${1}" ]] || {
    echo "expected status ${1}, got ${status} (output: ${output})" >&2
    return 1
  }
}

assert_contains() {
  printf '%s' "${output}" | grep -qF "${1}" || {
    echo "output missing '${1}' (output: ${output})" >&2
    return 1
  }
}

assert_manifest_has() {
  grep -qF "${1}" "${MANIFEST}" || {
    echo "manifest missing '${1}' (log: $(cat "${MANIFEST}" 2>/dev/null))" >&2
    return 1
  }
}

# ── AC1 — exactly one line per attempted spawn, naming kept labels + assembled bytes ───────────────

@test "AC1: an injection-attempted spawn emits exactly one manifest line naming kept blocks and bytes" {
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}"
  assert_status 0
  [[ "$(manifest_lines)" == "1" ]] || {
    echo "expected 1 manifest line, got $(manifest_lines) (log: $(cat "${MANIFEST}" 2>/dev/null))" >&2
    return 1
  }
  assert_manifest_has 'agent=glass-atrium-dev-shell'
  assert_manifest_has 'agent_id=sess-A1'
  # Kept labels carry their source path; the comment block's path is the fixture it was extracted from.
  assert_manifest_has "comment:${COMMENT_FIT}"
  assert_manifest_has 'blocks=emit:'
  # The recorded size equals the bytes actually delivered to the child.
  local recorded delivered
  recorded="$(grep -o 'ctx_bytes=[0-9]*' "${MANIFEST}" | head -1 | cut -d= -f2)"
  # `run` merges stderr (the fail-open diagnostics for the /nonexistent sources) into $output — the
  # JSON envelope is the one line starting with '{'.
  delivered="$(printf '%s\n' "${output}" | grep -m1 '^{' | jq -j '.hookSpecificOutput.additionalContext' | wc -c | tr -cd '0-9')"
  [[ -n "${recorded}" && "${recorded}" == "${delivered}" ]] || {
    echo "ctx_bytes=${recorded} != delivered ${delivered}" >&2
    return 1
  }
}

@test "AC1: three attempted spawns emit exactly three manifest lines" {
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}"
  assert_status 0
  run_inject "glass-atrium-dev-node" "${COMMENT_FIT}"
  assert_status 0
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}"
  assert_status 0
  [[ "$(manifest_lines)" == "3" ]] || {
    echo "expected 3 manifest lines, got $(manifest_lines)" >&2
    return 1
  }
}

@test "AC1: a shed block is absent from the manifest's kept-block list" {
  run_inject "glass-atrium-dev-shell" "${COMMENT_BIG}"
  assert_status 0
  assert_manifest_has 'blocks=emit:'
  ! grep -q 'comment:' "${MANIFEST}" || {
    echo "manifest names a block that was shed (log: $(cat "${MANIFEST}"))" >&2
    return 1
  }
}

# ── AC2 — introspection modes emit no manifest line ────────────────────────────────────────────────

@test "AC2: the operator introspection modes emit no manifest line (delta 0)" {
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}"
  assert_status 0
  # Anchored, not vacuous: the spawn above must have written exactly one line, and neither query may
  # add to it (an absent sink would fail the anchor rather than pass the delta).
  [[ "$(manifest_lines)" == "1" ]] || {
    echo "expected 1 manifest line before the queries, got $(manifest_lines)" >&2
    return 1
  }
  run_query --drop-rate
  assert_status 0
  run_query --manifest-coverage
  assert_status 0
  [[ "$(manifest_lines)" == "1" ]] || {
    echo "introspection changed the manifest count to $(manifest_lines)" >&2
    return 1
  }
}

# ── AC3 — the manifest has its OWN sink: drop-rate numerator and denominator are untouched ─────────

@test "AC3: with manifest emission enabled the drop-rate reports the same numerator and denominator" {
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}"
  assert_status 0
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}"
  assert_status 0
  run_inject "glass-atrium-dev-shell" "${COMMENT_BIG}"
  assert_status 0
  run_query --drop-rate
  assert_status 0
  assert_contains "drops=1"
  assert_contains "injection_attempted=3"
  # The manifest never lands in the drop sink (the two sinks are distinct files).
  ! grep -q ' MANIFEST ' "${DROPLOG}" || {
    echo "a manifest row polluted the drop sink (log: $(cat "${DROPLOG}"))" >&2
    return 1
  }
}

# ── AC4 — unwritable manifest sink → injection and exit status unchanged ───────────────────────────

@test "AC4: an unwritable manifest sink still exits 0 with the injection intact" {
  local blocker="${BATS_TEST_TMPDIR}/blocker"
  : >"${blocker}"
  MANIFEST="${blocker}/sub/manifest.log"
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}"
  assert_status 0
  assert_contains 'additionalContext'
  assert_contains 'REQUIRED by the outcome recorder'
  assert_contains 'Comment-rule core (test block)'
}

# ── AC5 — absent digest tool → line still written, digest field omitted ────────────────────────────

@test "AC5: an absent digest tool writes the manifest line without a digest field" {
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}" /nonexistent \
    "INJECT_SCOPE_RULES_DIGEST_CMD=ga-no-such-digest-tool"
  assert_status 0
  [[ "$(manifest_lines)" == "1" ]] || {
    echo "expected 1 manifest line, got $(manifest_lines)" >&2
    return 1
  }
  ! grep -q 'digest=' "${MANIFEST}" || {
    echo "digest field present despite an absent tool (log: $(cat "${MANIFEST}"))" >&2
    return 1
  }
  assert_manifest_has 'ctx_bytes='
  assert_contains 'Comment-rule core (test block)'
}

@test "AC5: a present digest tool records a digest field" {
  command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || skip "no digest tool"
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}"
  assert_status 0
  grep -qE 'digest=[0-9a-f]{64}' "${MANIFEST}" || {
    echo "no hex digest recorded (log: $(cat "${MANIFEST}"))" >&2
    return 1
  }
}

# ── AC6 — kept lesson carries its ids and scores; the flag never over-claims ───────────────────────

@test "AC6: a kept lesson block records its ids and scores with lesson_truncated=0" {
  write_lessons "glass-atrium-dev-shell" 40
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}" "${LESSONS}"
  assert_status 0
  assert_manifest_has 'lessons=ctm:bug-fix/keptline-one-whole@5'
  assert_manifest_has 'epm:refactor/epm-never-eval@2'
  assert_manifest_has 'lesson_truncated=0'
  assert_manifest_has "lesson:${LESSONS}"
}

@test "AC6: a source-capped lesson records lesson_truncated=1 rather than over-claiming" {
  # A filler far past LESSON_MAX_BYTES (1200) forces the in-source cap.
  write_lessons "glass-atrium-dev-shell" 4000
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}" "${LESSONS}"
  assert_status 0
  assert_manifest_has 'lesson_truncated=1'
}

@test "AC6: a fully shed lesson is named neither as a kept block nor by its ids" {
  write_lessons "glass-atrium-dev-shell" 40
  # COMMENT_BIG breaches the ceiling → the lesson is the first real shed for this assembly.
  run_inject "glass-atrium-dev-shell" "${COMMENT_BIG}" "${LESSONS}"
  assert_status 0
  # Anchored: the line must exist and simply lack the lesson fields (an absent sink would pass the two
  # negative assertions below vacuously).
  [[ "$(manifest_lines)" == "1" ]] || {
    echo "expected 1 manifest line, got $(manifest_lines)" >&2
    return 1
  }
  ! grep -q 'lessons=' "${MANIFEST}" || {
    echo "manifest lists lesson ids for a shed lesson (log: $(cat "${MANIFEST}"))" >&2
    return 1
  }
  ! grep -q 'lesson:' "${MANIFEST}" || {
    echo "manifest names the lesson as kept after it was shed (log: $(cat "${MANIFEST}"))" >&2
    return 1
  }
}

# ── AC7 — the reader reports per-agent block coverage over the sink ────────────────────────────────

@test "AC7: the reader reports per-agent block coverage matching the fixture" {
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}"
  assert_status 0
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}"
  assert_status 0
  run_inject "glass-atrium-dev-node" "${COMMENT_FIT}"
  assert_status 0
  run_query --manifest-coverage
  assert_status 0
  assert_contains "records=3 agents=2"
  assert_contains "agent=glass-atrium-dev-shell spawns=2 blocks=emit:2,comment:2"
  assert_contains "agent=glass-atrium-dev-node spawns=1 blocks=emit:1,comment:1"
}

@test "AC7: the reader reads an absent sink as zero records, not missing data" {
  run_query --manifest-coverage
  assert_status 0
  assert_contains "records=0 agents=0"
}

@test "AC7: coverage distinguishes a spawn that kept a block from one that shed it" {
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}"
  assert_status 0
  run_inject "glass-atrium-dev-shell" "${COMMENT_BIG}"
  assert_status 0
  run_query --manifest-coverage
  assert_status 0
  # Two spawns, but the comment block reached the child only once.
  assert_contains "agent=glass-atrium-dev-shell spawns=2 blocks=emit:2,comment:1"
}
