#!/usr/bin/env bats
# doctor-inject-drop-seam.bats — pins run_doctor §10 (inject-scope-rules shed surface) to the
# migrated Tier-A seam AND to the producer's own event grammar.
#
# SEAM: the producer (inject-scope-rules.sh) persists each shed to INJECT_DROP_LOG = HOOK_LOG_DIR =
# ${GA_DATA_ROOT}/logs/inject-scope-rules.diag.log; §10 MUST read the SAME root. The prior default
# (${TARGET_HOME}/.claude/logs/…) was doubly wrong: TARGET_HOME already = ~/.claude so it named a
# ~/.claude/.claude/logs path that never exists, AND it missed the ~/.glass-atrium/logs relocation.
#
# GRAMMAR: §10 classifies on the DROP event token, owned by another file. Hand-written fixture
# lines would let a producer-side rename silently mis-partition the check (the exact coupling failure
# that let a stale warning outlive its mechanism), so every live-class fixture row here is produced by
# INVOKING THE REAL HOOK. A token rename fails these tests instead of degrading the check.
# The one literal class is `block=lesson` (DROP + PARTIAL): no producer path writes it, so its rows
# are the fixed shapes an existing log may still hold.
#
# WINDOW: the log is append-only and lifetime-scoped, so §10 windows by date. Aged fixtures are the
# emitter's own rows with only the leading ISO-8601 timestamp rewritten — the classified tokens stay
# emitter-authored.
#
# ACs pinned here:
#   AC1  an in-window non-lesson drop WARNs, names the seam path, and feeds the warning aggregate.
#   AC2  in-window block=lesson rows (full DROP + truncate-and-keep PARTIAL) are ignored: OK verdict,
#        no remedy, lifetime total only, and NO feed into the warning aggregate.
#   AC3  a log whose rows all predate the window is OK, and still reports the historical total.
#   AC4  no log at the seam is OK.
#   AC5  the split scope-rule channel's own aggregate stays SEPARATE from inject-drop: the two
#        surfaces answer different questions (a block shed from the marker-block slot vs. the
#        part-slot channel's wiring and capacity) and share a section, so a folded counter would
#        let a live shed be reported as a wiring warn or the reverse.
#   AC6  a BOUND part slot that cannot deliver — no runnable python3, or an unreadable agent-registry —
#        WARNs and names the blocker; a healthy bound channel and an unbound broken one stay silent.
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
# BATS GATING NOTE: @test bodies run UNDER errexit, so a failing mid-body command aborts the test.
#   ONE shape is platform-split: a bare `[[ ]]` / `(( ))` does not abort on macOS bash 3.2 but DOES
#   on CI bash 5.3 (measured: bash 3.2.57 vs 5.3.9, bats 1.13.0 on BOTH legs — bash is the variable,
#   not bats), while `[ ]`, `let` and a failing `grep -q` abort on both.
#   Every assertion `return 1`s on mismatch, so EACH one independently fails the test on either leg.

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_GA="${GA}/glass-atrium"
HOOK_SH="${GA}/hooks/inject-scope-rules.sh"
# shellcheck source-path=SCRIPTDIR source=../scripts/lib/path-guard.sh
source "${GA}/scripts/lib/path-guard.sh"

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
  printf '%s\n' '{"files": []}' >"${TARGET}/empty-manifest.json"

  # An oversized (~11 KB) BUDGET-DEV fixture whose block alone exceeds the ceiling → forces a
  # non-lesson (block=budget-dev) full drop at the production ceiling for a BUDGET_DEV_AGENTS member.
  BUDGET_BIG="${TARGET}/budget-big.md"
  {
    printf '%s\n' 'preamble' '<!-- AGENT-INJECT:BUDGET-DEV:START -->' '**Budget sizing (test block)**'
    head -c 11000 /dev/zero | tr '\0' 'x'
    printf '\n%s\n%s\n' '<!-- AGENT-INJECT:BUDGET-DEV:END -->' 'trailer'
  } >"${BUDGET_BIG}"
}

teardown() {
  if ga_guard_path "${TARGET:-}"; then rm -rf -- "${TARGET:?}"; fi
  if ga_guard_path "${DATA_ROOT:-}"; then rm -rf -- "${DATA_ROOT:?}"; fi
}

# Drive the REAL doctor with the target + data-root seams redirected at the sandbox.
# GA_ROOT stays the checkout this suite runs from, and any doctor FAIL suppresses the PASS-only warn
# rollup the `<n> inject-drop` assertions read → two FAIL sources outside §10 are sandboxed:
#   GA_MANIFEST (empty files[]) — §4 FAILs on any manifest source missing from the checkout
#   AUTOAGENT_BACKUP_DIR — §15 derives the merge-decline record from GA_ROOT's sibling
# `run` records the exit in $status; run_doctor returns 1 on any §1-12 FAIL, so we assert
# on the merged output lines (log() → stderr, captured by bats `run`), never $status.
run_doctor_seam() {
  GA_TARGET_HOME="${TARGET}" GA_DATA_ROOT="${DATA_ROOT}" \
    GA_MANIFEST="${TARGET}/empty-manifest.json" AUTOAGENT_BACKUP_DIR="${TARGET}/agents-bak" \
    ATRIUM_MONITOR_PORT="${GA_DOCTOR_DEAD_PORT}" run "${REAL_GA}" doctor
}

# Drive the REAL producer's SubagentStart injection path so the shed rows under test are
# emitter-authored. Every scope source is sandboxed to /nonexistent except the two the caller
# names, isolating which block sheds. $1=agent $2=ceiling $3=BUDGET-DEV src.
emit_shed_row() {
  local agent="${1}" ceiling="${2}" budget_src="${3}"
  printf '%s' "{\"agent_type\":\"${agent}\"}" | env \
    INJECT_SCOPE_RULES_DROP_LOG="${DROPLOG}" \
    INJECT_SCOPE_RULES_SPAWN_COUNTER="${SPAWN_COUNTER}" \
    SUBAGENT_BUDGET_METER_OFF=1 \
    INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
    INJECT_SCOPE_RULES_BUDGET_SRC="${budget_src}" \
    INJECT_SCOPE_RULES_WIKI_UNTRUSTED_SRC=/nonexistent \
    INJECT_SCOPE_RULES_CTX_MAX_BYTES="${ceiling}" \
    "${HOOK_SH}" >/dev/null 2>&1
}

# Append the two block=lesson row shapes an existing log may still hold — a truncate-and-keep
# PARTIAL and a full DROP — stamped now so both sit inside the window.
append_lesson_rows() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s [inject-scope-rules] PARTIAL agent=glass-atrium-dev-shell block=lesson pre_drop_bytes=10282 ceiling=9984 overage_bytes=298 kept_bytes=296\n' "${ts}" >>"${DROPLOG}"
  printf '%s [inject-scope-rules] DROP agent=glass-atrium-dev-shell block=lesson pre_drop_bytes=10082 ceiling=9984 overage_bytes=98\n' "${ts}" >>"${DROPLOG}"
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

# sole carrier of the `<n> inject-drop` counts; a §1-12 FAIL suppresses it → every count check anchors here
ROLLUP='== doctor: PASS (with '

# ── AC1 — in-window non-lesson drop → WARN at the seam path ────────────────────────────────────

@test "AC1: an in-window non-lesson drop WARNs, names the seam path, and feeds the warning count" {
  emit_shed_row "glass-atrium-dev-front" 9984 "${BUDGET_BIG}"
  grep -q 'block=budget-dev ' "${DROPLOG}" || {
    echo "producer wrote no block=budget-dev row — log: $(cat "${DROPLOG}" 2>&1)" >&2
    return 1
  }
  run_doctor_seam
  assert_output_has "inject-scope-rules scope-block drop(s) in the last" || return 1
  assert_output_has "recompress the AGENT-INJECT source blocks" || return 1
  # the WARN must name the seam path, not a ~/.claude root
  assert_output_has "${DROPLOG}" || return 1
  assert_output_lacks "/.claude/.claude/logs/" || return 1
  # an actionable drop is a warning, so the aggregate must not report zero inject-drop warnings
  assert_output_has "${ROLLUP}" || return 1
  assert_output_lacks "0 inject-drop"
}

# ── AC2 — lesson rows in an existing log are history, never a warning ──────────────────────────

@test "in-window lesson DROP + PARTIAL rows are ignored — OK verdict, no remedy, no warning" {
  append_lesson_rows
  run_doctor_seam
  assert_output_has "ok   : no inject-scope-rules scope-block drops in the last" || return 1
  assert_output_has "(2 historical event(s) on record in ${DROPLOG})" || return 1
  assert_output_lacks "recompress the AGENT-INJECT source blocks" || return 1
  assert_output_has "${ROLLUP}" || return 1
  assert_output_has "0 inject-drop"
}

# ── AC3 — rows outside the window are history, not a present condition ─────────────────────────

@test "AC3: a log whose rows all predate the window is OK and still reports the historical total" {
  emit_shed_row "glass-atrium-dev-front" 9984 "${BUDGET_BIG}"
  age_log_out_of_window
  run_doctor_seam
  assert_output_has "no inject-scope-rules scope-block drops in the last" || return 1
  assert_output_has "historical event(s) on record" || return 1
  assert_output_lacks "recompress the AGENT-INJECT source blocks" || return 1
  assert_output_has "${ROLLUP}" || return 1
  assert_output_has "0 inject-drop"
}

# ── AC4 — no log at the seam ───────────────────────────────────────────────────────────────────

@test "AC4: §10 clean-ok when no drop log exists at the seam" {
  [[ ! -e "${DROPLOG}" ]] || return 1
  run_doctor_seam
  assert_output_has "no inject-scope-rules drop log"
}

@test "AC5: the split-channel aggregate is its own counter, never folded into inject-drop" {
  # Drives the REAL producer, per this file's fixture discipline: one emitter-authored non-lesson
  # drop, which AC1 already pins as exactly 1 inject-drop. What is new here is that the §10b
  # split-channel counter carries its own name in the same rollup, so neither can absorb the other.
  emit_shed_row "glass-atrium-dev-front" 9984 "${BUDGET_BIG}"
  grep -q 'block=budget-dev ' "${DROPLOG}" || {
    echo "producer wrote no block=budget-dev row — log: $(cat "${DROPLOG}" 2>&1)" >&2
    return 1
  }
  run_doctor_seam
  assert_output_has "${ROLLUP}" || return 1
  assert_output_has "1 inject-drop"
  assert_output_has "inject-slot"
  # A shed of a marker block says nothing about the slot wiring, so the two totals must differ in
  # KIND: this run has a live shed and a healthy channel.
  [[ "${output}" == *"0 inject-slot"* ]] || {
    echo "a live block shed inflated the split-channel counter — output:" >&2
    printf '%s\n' "${output}" >&2
    return 1
  }
}

# ── AC6 — a bound part slot that cannot deliver ─────────────────────────────────────────────────

# Bind every part wrapper present under the tree in the sandbox settings.json, so §10b counts them bound.
bind_part_slots() {
  local wrappers=()
  local w
  for w in "${GA}"/hooks/inject-scope-part-[0-9][0-9].sh; do
    [[ -f "${w}" ]] && wrappers+=("${w##*/}")
  done
  [[ "${#wrappers[@]}" -gt 0 ]] || return 1
  BOUND_COUNT="${#wrappers[@]}"
  printf '%s\n' "${wrappers[@]}" | jq -R '{hooks: [{type: "command", command: ("~/.claude/hooks/" + .)}]}' \
    | jq -s '{hooks: {SubagentStart: .}}' >"${TARGET}/settings.json"
}

UNDELIVERABLE='scope-rule part slot(s) bound but undeliverable'

@test "AC6: bound part slots with no runnable python3 WARN that no scope-rule body is delivered" {
  bind_part_slots || skip "no part wrappers under ${GA}/hooks"
  # A python3 that exists on PATH but cannot run: `command -v` finds it, the probe must not trust it.
  printf '#!/bin/sh\nexit 127\n' >"${TARGET}/bin/python3"
  chmod +x "${TARGET}/bin/python3"
  PATH="${TARGET}/bin:${PATH}" run_doctor_seam
  assert_output_has "${UNDELIVERABLE} — no runnable python3" || return 1
  assert_output_lacks "the agent-registry is unreadable"
}

@test "AC6: bound part slots with an unreadable agent-registry WARN and name the registry path" {
  bind_part_slots || skip "no part wrappers under ${GA}/hooks"
  printf '{ not json\n' >"${TARGET}/registry.json"
  GA_CHUNK_REGISTRY="${TARGET}/registry.json" run_doctor_seam
  assert_output_has "${UNDELIVERABLE} — the agent-registry is unreadable (${TARGET}/registry.json)" || return 1
  assert_output_lacks "no runnable python3"
}

@test "AC6: a healthy bound channel and an unbound broken one both stay silent" {
  bind_part_slots || skip "no part wrappers under ${GA}/hooks"
  run_doctor_seam
  # Anchored, not vacuous: the fixture really is a bound channel.
  assert_output_has "ok   : all ${BOUND_COUNT} scope-rule part slots bound" || return 1
  assert_output_lacks "${UNDELIVERABLE}" || return 1
  # Unbound: the same broken registry reaches no agent through a slot, so it is not this warning.
  mv -f "${TARGET}/settings.json" "${TARGET}/settings.unbound.json"
  printf '{ not json\n' >"${TARGET}/registry.json"
  GA_CHUNK_REGISTRY="${TARGET}/registry.json" run_doctor_seam
  assert_output_lacks "${UNDELIVERABLE}"
}
