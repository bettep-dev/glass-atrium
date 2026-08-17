#!/usr/bin/env bats
# doctor-inject-drop-seam.bats — pins run_doctor §10 (inject-scope-rules shed surface) to the
# migrated Tier-A seam AND to the producer's own event grammar.
#
# SEAM: the producer (inject-scope-rules.sh) persists each shed to INJECT_DROP_LOG = HOOK_LOG_DIR =
# ${GA_DATA_ROOT}/logs/inject-scope-rules.diag.log; §10 MUST read the SAME root. The prior default
# (${TARGET_HOME}/.claude/logs/…) was doubly wrong: TARGET_HOME already = ~/.claude so it named a
# ~/.claude/.claude/logs path that never exists, AND it missed the ~/.glass-atrium/logs relocation.
#
# GRAMMAR: §10 classifies on three literals owned by another file — the DROP and PARTIAL event
# tokens and the `block=lesson` label. Hand-written fixture lines would let a producer-side rename
# silently mis-partition the check (the exact coupling failure that let a stale warning outlive its
# mechanism), so EVERY fixture row here is produced by INVOKING THE REAL HOOK. A token rename fails
# these tests instead of degrading the check.
#
# WINDOW: the log is append-only and lifetime-scoped, so §10 windows by date. Aged fixtures are the
# emitter's own rows with only the leading ISO-8601 timestamp rewritten — the classified tokens stay
# emitter-authored.
#
# ACs pinned here:
#   AC1  an in-window non-lesson drop WARNs, names the seam path, and feeds the warning aggregate.
#   AC2  in-window lesson shedding (full DROP + truncate-and-keep PARTIAL) is INFO with NO remedy and
#        does NOT feed the warning aggregate — designed shedding of the lowest-priority block.
#   AC3  a log whose rows all predate the window is OK, and still reports the historical total.
#   AC4  no log at the seam is OK.
#   AC5  the fixture rows carry the literals §10 classifies on (producer-grammar pin).
#
# Run via: bats test/doctor-inject-drop-seam.bats
# Requires: bats, jq, bash 3.2+
#
# Hermetic: GA_TARGET_HOME + GA_DATA_ROOT point the target + runtime-data roots at throwaway temp
# dirs, and the doctor-hook-bindings seam set (nonexistent manifest-gen, echo-OK claude stub, empty
# daemon-reports dir) skips §8 SHA hashing + neutralizes the post-§10 headless-auth advisory's live
# `claude -p` probe. Every producer run sandboxes each scope source to /nonexistent. No ~/.claude or
# ~/.glass-atrium state is read or written.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail.
#   Every assertion `return 1`s on mismatch, so EACH one independently fails the test.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_GA="${GA}/glass-atrium"
HOOK_SH="${GA}/hooks/inject-scope-rules.sh"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
  [[ -f "${REAL_GA}" ]] || skip "glass-atrium not found: ${REAL_GA}"
  [[ -x "${HOOK_SH}" ]] || skip "producer hook not executable: ${HOOK_SH}"
  TARGET="$(mktemp -d -t ga-doctor-drop-target.XXXXXX)"
  DATA_ROOT="$(mktemp -d -t ga-doctor-drop-data.XXXXXX)"
  mkdir -p "${TARGET}/bin" "${TARGET}/empty-reports" "${DATA_ROOT}/logs"
  DROPLOG="${DATA_ROOT}/logs/inject-scope-rules.diag.log"
  SPAWN_COUNTER="${TARGET}/spawns.count"
  # echo-OK claude stub → the post-§10 headless-auth advisory's self-test never networks.
  cat >"${TARGET}/bin/claude" <<'SH'
#!/bin/bash
echo OK
exit 0
SH
  chmod +x "${TARGET}/bin/claude"
  export GA_GENERATE_MANIFEST="${TARGET}/no-such-manifest-gen" # nonexistent → §8 SHA hashing skipped
  export GA_AUTH_CLAUDE_BIN="${TARGET}/bin/claude"             # echo-OK stub → no live claude -p probe
  export DOCTOR_AUTH_REPORTS_DIR="${TARGET}/empty-reports"     # empty dir → trivial daemon-report scan

  # An oversized (~12 KB) comment fixture whose block alone exceeds the ceiling → forces a
  # non-lesson (block=comment) full drop at the production ceiling.
  COMMENT_BIG="${TARGET}/comment-big.md"
  {
    printf '%s\n' 'preamble' '<!-- AGENT-INJECT:START -->' '**Comment-rule core (test block)**'
    head -c 11000 /dev/zero | tr '\0' 'x'
    printf '\n%s\n%s\n' '<!-- AGENT-INJECT:END -->' 'trailer'
  } >"${COMMENT_BIG}"
}

teardown() {
  [[ -n "${TARGET:-}" && -d "${TARGET}" ]] && rm -rf -- "${TARGET}" || true
  [[ -n "${DATA_ROOT:-}" && -d "${DATA_ROOT}" ]] && rm -rf -- "${DATA_ROOT}" || true
}

# Drive the REAL doctor with the target + data-root seams redirected at the sandbox.
# AUTOAGENT_BACKUP_DIR is sandboxed because GA_ROOT stays the REAL install here: §15 derives the
# merge-decline record from GA_ROOT's sibling, so an open decline on the host would FAIL the run and
# suppress the PASS-only warn rollup the `0 inject-drop` assertions read.
# `run` records the exit in $status; run_doctor returns 1 on any §1-12 FAIL, so we assert
# on the merged output lines (log() → stderr, captured by bats `run`), never $status.
run_doctor_seam() {
  GA_TARGET_HOME="${TARGET}" GA_DATA_ROOT="${DATA_ROOT}" \
    AUTOAGENT_BACKUP_DIR="${TARGET}/agents-bak" \
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT}" run "${REAL_GA}" doctor
}

# Drive the REAL producer's SubagentStart injection path so the shed rows under test are
# emitter-authored. Every scope source is sandboxed to /nonexistent except the two the caller
# names, isolating which block sheds. $1=agent $2=ceiling $3=comment src $4=lessons src.
emit_shed_row() {
  local agent="${1}" ceiling="${2}" comment_src="${3}" lessons_src="${4}"
  printf '%s' "{\"agent_type\":\"${agent}\"}" | env \
    INJECT_SCOPE_RULES_DROP_LOG="${DROPLOG}" \
    INJECT_SCOPE_RULES_SPAWN_COUNTER="${SPAWN_COUNTER}" \
    SUBAGENT_BUDGET_METER_OFF=1 \
    INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
    INJECT_SCOPE_RULES_SRC="${comment_src}" \
    INJECT_SCOPE_RULES_STYLEREF_SRC=/nonexistent \
    INJECT_SCOPE_RULES_NAMING_SRC=/nonexistent \
    INJECT_SCOPE_RULES_BUDGET_SRC=/nonexistent \
    INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC=/nonexistent \
    INJECT_SCOPE_RULES_LESSONS_SRC="${lessons_src}" \
    INJECT_SCOPE_RULES_CTX_MAX_BYTES="${ceiling}" \
    "${HOOK_SH}" >/dev/null 2>&1
}

# Emit-only base byte count for an agent (meter OFF, no scope source, no lesson). The hermetic
# lesson residual = ceiling - base - 2 (the join separator), so the lesson-class tests below derive
# their ceilings from this rather than hardcoding one. Mirrors inject-scope-rules-dropsink.bats.
measure_base_bytes() {
  local agent="${1}"
  printf '%s' "{\"agent_type\":\"${agent}\"}" | env \
    SUBAGENT_BUDGET_METER_OFF=1 \
    INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
    INJECT_SCOPE_RULES_SRC=/nonexistent \
    INJECT_SCOPE_RULES_STYLEREF_SRC=/nonexistent \
    INJECT_SCOPE_RULES_NAMING_SRC=/nonexistent \
    INJECT_SCOPE_RULES_BUDGET_SRC=/nonexistent \
    INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC=/nonexistent \
    INJECT_SCOPE_RULES_LESSONS_SRC=/nonexistent \
    INJECT_SCOPE_RULES_DROP_LOG="${TARGET}/measure-drop.log" \
    INJECT_SCOPE_RULES_SPAWN_COUNTER="${TARGET}/measure-spawns.count" \
    INJECT_SCOPE_RULES_CTX_MAX_BYTES=20000 \
    "${HOOK_SH}" 2>/dev/null | jq -j '.hookSpecificOutput.additionalContext // ""' 2>/dev/null | wc -c | tr -cd '0-9'
}

# Write a lessons.json fixture with a SHORT first CTM line plus a filler second line, so a
# truncate-keep preserves the first line while the filler is what gets cut.
write_lessons() {
  local agent="${1}" out="${2}" fill="${3}"
  jq -nc --arg a "${agent}" --argjson n "${fill}" '{
    ctm: [
      {agent: $a, task_type: "bug-fix", text: "KEPTLINE_ONE_WHOLE", score: 5, frequency: 9},
      {agent: $a, task_type: "feature", text: ("F" * $n), score: 5, frequency: 8}
    ],
    epm: []
  }' >"${out}"
}

# Emit one emitter-authored lesson-class pair: a truncate-and-keep PARTIAL (residual above the
# 150 B floor) and a full lesson DROP (residual below it). Both ceilings derive from the measured
# emit-only base, so neither depends on a hardcoded assembly size.
emit_lesson_pair() {
  local agent="${1}" base lessons="${TARGET}/lessons.json"
  base="$(measure_base_bytes "${agent}")"
  [[ -n "${base}" && "${base}" -gt 0 ]] || return 1
  write_lessons "${agent}" "${lessons}" 900
  emit_shed_row "${agent}" "$((base + 300))" /nonexistent "${lessons}" # residual 298 → PARTIAL
  emit_shed_row "${agent}" "$((base + 100))" /nonexistent "${lessons}" # residual  98 → full DROP
}

# Rewrite only the leading ISO-8601 timestamp of every emitter-authored row so the whole log falls
# outside the recency window. The classified tokens stay exactly as the producer wrote them.
age_log_out_of_window() {
  local aged="${DROPLOG}.aged"
  sed -e 's/^[0-9][0-9]*-[0-9][0-9]-[0-9][0-9]T[0-9:]*Z/2020-01-01T00:00:00Z/' "${DROPLOG}" >"${aged}"
  mv -f "${aged}" "${DROPLOG}"
}

assert_output_has() {
  [[ "${output}" == *"${1}"* ]] || {
    echo "doctor output missing '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

assert_output_lacks() {
  [[ "${output}" != *"${1}"* ]] || {
    echo "doctor output unexpectedly contains '${1}' — output:" >&2
    echo "${output}" >&2
    return 1
  }
}

# ── AC1 — in-window non-lesson drop → WARN at the seam path ────────────────────────────────────

@test "AC1: an in-window non-lesson drop WARNs, names the seam path, and feeds the warning count" {
  emit_shed_row "glass-atrium-dev-shell" 9984 "${COMMENT_BIG}" /nonexistent
  grep -q 'block=comment ' "${DROPLOG}" || {
    echo "producer wrote no block=comment row — log: $(cat "${DROPLOG}" 2>&1)" >&2
    return 1
  }
  run_doctor_seam
  assert_output_has "inject-scope-rules scope-block drop(s) in the last" || return 1
  assert_output_has "recompress the AGENT-INJECT source blocks" || return 1
  # the WARN must name the seam path, not a ~/.claude root
  assert_output_has "${DROPLOG}" || return 1
  assert_output_lacks "/.claude/.claude/logs/" || return 1
  # an actionable drop is a warning, so the aggregate must not report zero inject-drop warnings
  assert_output_lacks "0 inject-drop"
}

# ── AC2 — lesson shedding is INFO with no remedy, and never a warning ──────────────────────────

@test "AC2: in-window lesson DROP + PARTIAL are INFO with no remedy and do not warn" {
  emit_lesson_pair "glass-atrium-dev-shell" || {
    echo "could not emit the lesson-class pair" >&2
    return 1
  }
  grep -q '] PARTIAL .*block=lesson ' "${DROPLOG}" || {
    echo "producer wrote no lesson PARTIAL row — log: $(cat "${DROPLOG}" 2>&1)" >&2
    return 1
  }
  grep -q '] DROP .*block=lesson ' "${DROPLOG}" || {
    echo "producer wrote no lesson DROP row — log: $(cat "${DROPLOG}" 2>&1)" >&2
    return 1
  }
  run_doctor_seam
  assert_output_has "lesson-block drop(s) +" || return 1
  assert_output_has "lesson truncation(s) in the last" || return 1
  # designed shedding has no remedy, so the actionable remedy must NOT be attached to it
  assert_output_lacks "recompress the AGENT-INJECT source blocks" || return 1
  # and it must not be counted as a warning
  assert_output_has "0 inject-drop"
}

# ── AC3 — rows outside the window are history, not a present condition ─────────────────────────

@test "AC3: a log whose rows all predate the window is OK and still reports the historical total" {
  emit_shed_row "glass-atrium-dev-shell" 9984 "${COMMENT_BIG}" /nonexistent
  age_log_out_of_window
  run_doctor_seam
  assert_output_has "no inject-scope-rules shed events in the last" || return 1
  assert_output_has "historical event(s) on record" || return 1
  assert_output_lacks "recompress the AGENT-INJECT source blocks" || return 1
  assert_output_has "0 inject-drop"
}

# ── AC4 — no log at the seam ───────────────────────────────────────────────────────────────────

@test "AC4: §10 clean-ok when no drop log exists at the seam" {
  [[ ! -e "${DROPLOG}" ]] || return 1
  run_doctor_seam
  assert_output_has "no inject-scope-rules drop log"
}

# ── AC5 — producer-grammar pin ─────────────────────────────────────────────────────────────────

@test "AC5: emitter rows carry the DROP, PARTIAL and block=lesson literals §10 classifies on" {
  emit_shed_row "glass-atrium-dev-shell" 9984 "${COMMENT_BIG}" /nonexistent
  emit_lesson_pair "glass-atrium-dev-shell" || {
    echo "could not emit the lesson-class pair" >&2
    return 1
  }
  local missing=""
  grep -q ' \[inject-scope-rules\] DROP ' "${DROPLOG}" || missing="${missing} DROP-token"
  grep -q ' \[inject-scope-rules\] PARTIAL ' "${DROPLOG}" || missing="${missing} PARTIAL-token"
  grep -q ' block=lesson ' "${DROPLOG}" || missing="${missing} block=lesson-label"
  grep -q ' block=comment ' "${DROPLOG}" || missing="${missing} non-lesson-label"
  [[ -z "${missing}" ]] || {
    echo "producer grammar changed — §10 classifier literals absent:${missing}" >&2
    echo "log: $(cat "${DROPLOG}" 2>&1)" >&2
    return 1
  }
}
