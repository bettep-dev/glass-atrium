#!/usr/bin/env bats
# inject-scope-rules-dropsink.bats — T7: the injection drop sink is a measured FILE, plus a named
# aggregation query over it.
#
#   A dropped scope block is silent to every consumer that matters — Claude Code DISCARDS SubagentStart
#   hook stderr, so a stderr-only diagnostic records nothing. T7 turns the drop marker into a structured
#   FILE record (agent · block · byte overage), keeps a SEPARATE injection-attempted spawn counter as the
#   drop-rate DENOMINATOR, and exposes a named aggregation query (`--drop-rate`) over the two.
#
#   ACs pinned here:
#     AC1  a dropped block appends a structured record naming agent, block, and byte overage.
#     AC2  a spawn with no drop writes NO drop record (yet still advances the denominator).
#     AC3  a named aggregation query reports drops over spawns-with-injection-attempted; an absent
#          sink counts as 0, NOT missing data.
#     AC4  an unwritable sink still exits 0 with the injected content unaltered (fail-open preserved).
#
#   FAIL-AT-HEAD: AC1 (no overage_bytes field at HEAD), AC2 (no denominator counter at HEAD), and AC3
#   (no aggregation-query mode at HEAD) each fail against the pre-T7 hook and pass after. AC4 is a
#   preserved fail-open invariant — it guards that the new overage arithmetic + counter write never
#   trip the spawn-suppressing ERR trap.
#
# BATS GATING NOTE: @test bodies run WITHOUT `set -e`, so only the LAST command gates pass/fail. Every
#   assertion `return 1`s on mismatch, so EACH one independently fails the test.

HOOK_SH="${BATS_TEST_DIRNAME}/../inject-scope-rules.sh"

setup() {
  [[ -x "${HOOK_SH}" ]] || skip "hook not executable: ${HOOK_SH}"
  command -v jq >/dev/null 2>&1 || skip "jq not on PATH"

  DROPLOG="${BATS_TEST_TMPDIR}/drop.log"
  COUNTER="${BATS_TEST_TMPDIR}/spawns.count"

  # A comment fixture that injects one small block well under the 9984 ceiling → no drop.
  COMMENT_FIT="${BATS_TEST_TMPDIR}/comment-fit.md"
  printf '%s\n' \
    'preamble (must not reach the child)' \
    '<!-- AGENT-INJECT:START -->' \
    '**Comment-rule core (test block)**' \
    'body line' \
    '<!-- AGENT-INJECT:END -->' \
    'trailer (must not reach the child)' >"${COMMENT_FIT}"

  # An oversized (~12 KB) comment fixture whose block alone exceeds the ceiling → forces the drop loop.
  COMMENT_BIG="${BATS_TEST_TMPDIR}/comment-big.md"
  {
    printf '%s\n' 'preamble' '<!-- AGENT-INJECT:START -->' '**Comment-rule core (test block)**'
    head -c 11000 /dev/zero | tr '\0' 'x'
    printf '\n%s\n%s\n' '<!-- AGENT-INJECT:END -->' 'trailer'
  } >"${COMMENT_BIG}"
}

# Drive the hook's SubagentStart injection path for agent_type $1 with comment source $2. All other
# scope sources are sandboxed to /nonexistent and the meter is off, isolating the comment block; the
# drop sink + spawn counter are redirected into the Bats tmpdir. Invokes the hook DIRECTLY (executable,
# never interpreter-prefixed).
run_inject() {
  local agent="${1}" comment_src="${2}"
  run bash -c '
    agent="$1"; hook="$2"; comment="$3"; droplog="$4"; counter="$5"
    printf "%s" "{\"agent_type\":\"${agent}\"}" | env \
      INJECT_SCOPE_RULES_DROP_LOG="${droplog}" \
      INJECT_SCOPE_RULES_SPAWN_COUNTER="${counter}" \
      SUBAGENT_BUDGET_METER_OFF=1 \
      INJECT_SCOPE_RULES_AGENTS_DIR=/nonexistent \
      INJECT_SCOPE_RULES_SRC="${comment}" \
      INJECT_SCOPE_RULES_STYLEREF_SRC=/nonexistent \
      INJECT_SCOPE_RULES_NAMING_SRC=/nonexistent \
      INJECT_SCOPE_RULES_BUDGET_SRC=/nonexistent \
      INJECT_SCOPE_RULES_LESSONS_SRC=/nonexistent \
      "${hook}"
  ' _ "${agent}" "${HOOK_SH}" "${comment_src}" "${DROPLOG}" "${COUNTER}"
}

# Drive the named aggregation-query mode directly. stdin is /dev/null so a pre-T7 hook (no mode
# dispatch → hook_read_input's blocking cat) does not hang the suite.
run_drop_rate() {
  run bash -c '
    hook="$1"; droplog="$2"; counter="$3"
    env INJECT_SCOPE_RULES_DROP_LOG="${droplog}" INJECT_SCOPE_RULES_SPAWN_COUNTER="${counter}" \
      "${hook}" --drop-rate </dev/null
  ' _ "${HOOK_SH}" "${DROPLOG}" "${COUNTER}"
}

# Per-assertion gate helpers (the bats body is NOT under set -e — see header note).
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

# ── AC1 — dropped block appends a record naming agent, block, and byte overage ──────────────────────

@test "AC1: a dropped block appends a structured record naming agent, block, and byte overage" {
  run_inject "glass-atrium-dev-shell" "${COMMENT_BIG}"
  assert_status 0
  [[ -f "${DROPLOG}" ]] || {
    echo "drop sink not written after a drop" >&2
    return 1
  }
  grep -q 'agent=glass-atrium-dev-shell' "${DROPLOG}" || {
    echo "record missing agent (log: $(cat "${DROPLOG}"))" >&2
    return 1
  }
  grep -q 'block=comment ' "${DROPLOG}" || {
    echo "record missing block=comment (log: $(cat "${DROPLOG}"))" >&2
    return 1
  }
  # byte overage present AND positive (= pre_drop_bytes − ceiling) — the field HEAD does not emit.
  local ov
  ov="$(grep -m1 -o 'overage_bytes=[0-9]*' "${DROPLOG}" | head -1 | cut -d= -f2)"
  [[ -n "${ov}" && "${ov}" -gt 0 ]] || {
    echo "overage_bytes absent or non-positive: '${ov}' (log: $(cat "${DROPLOG}"))" >&2
    return 1
  }
}

# ── AC2 — no drop → no record, yet the denominator still advances ────────────────────────────────

@test "AC2: a no-drop spawn writes no drop record but advances the injection-attempted denominator" {
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}"
  assert_status 0
  # Injection was attempted → the denominator counter advanced to exactly 1.
  [[ -f "${COUNTER}" ]] || {
    echo "spawn counter not written (no denominator)" >&2
    return 1
  }
  [[ "$(tr -cd '0-9' <"${COUNTER}")" == "1" ]] || {
    echo "denominator != 1: '$(cat "${COUNTER}")'" >&2
    return 1
  }
  # The DROP sink carries NO drop record (absent file, or present with zero DROP lines).
  if [[ -f "${DROPLOG}" ]]; then
    ! grep -q ' DROP ' "${DROPLOG}" || {
      echo "drop sink has a DROP record but nothing should have dropped (log: $(cat "${DROPLOG}"))" >&2
      return 1
    }
  fi
}

# ── AC3 — named aggregation query, denominator = spawns with injection attempted ───────────────────

@test "AC3: the named aggregation query reports drops over spawns-with-injection-attempted" {
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}"
  assert_status 0
  run_inject "glass-atrium-dev-shell" "${COMMENT_FIT}"
  assert_status 0
  run_inject "glass-atrium-dev-shell" "${COMMENT_BIG}"
  assert_status 0
  run_drop_rate
  assert_status 0
  # Denominator is the injection-attempted spawn count (3), not a drop-record count.
  assert_contains "injection_attempted=3"
  assert_contains "drops="
  assert_contains "drop_rate="
}

@test "AC3: an absent sink and counter yield rate 0, not missing data" {
  # No spawn has run, so neither the drop sink nor the counter exists.
  run_drop_rate
  assert_status 0
  assert_contains "drops=0"
  assert_contains "injection_attempted=0"
  assert_contains "drop_rate=0"
}

# ── AC4 — unwritable sink → exit 0, injected content unaltered (fail-open preserved) ───────────────

@test "AC4: an unwritable drop sink and counter still exit 0 with the injection intact" {
  # Put both sink paths UNDER a regular file so mkdir -p of the parent dir fails (unwritable sink).
  local blocker="${BATS_TEST_TMPDIR}/blocker"
  : >"${blocker}"
  DROPLOG="${blocker}/sub/drop.log"
  COUNTER="${blocker}/sub/spawns.count"
  # COMMENT_BIG forces the drop path → append_drop_log runs against the unwritable sink.
  run_inject "glass-atrium-dev-shell" "${COMMENT_BIG}"
  assert_status 0
  # The injection is unaltered: the JSON envelope + the always-on emit block still reach the child.
  assert_contains 'additionalContext'
  assert_contains 'REQUIRED by the outcome recorder'
}
