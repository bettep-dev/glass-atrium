#!/usr/bin/env bats
# validate-scope-drift-sysdir.bats — system-path short-circuit suite.
#
# The short-circuit used to enumerate `.claude` and `.claude-work` literally, so an edit under
# `~/.claude-personal/` or `~/.claude-work-dev/` fell through to plan matching and drew a bogus
# SCOPE-070 advisory. Coverage now derives from the single-sited root grammar in
# lib/claude-config-dirs.sh; the `*/memory/*` arm stays first and untouched.
#
# Decision channel: the hook is non-blocking (always exit 0), so the discriminator is the ADVISORY —
# a short-circuited path emits nothing, a non-system out-of-scope path emits SCOPE-070.
#
# Hermetic: PLAN_FILE points at a temp plan whose target list matches none of the probes; HOME is
# redirected so any hook log write stays inside the temp dir.

bats_require_minimum_version 1.5.0

HOOK="${BATS_TEST_DIRNAME}/../validate-scope-drift.sh"

setup() {
  [[ -f "${HOOK}" ]] || skip "hook not found: ${HOOK}"
  command -v jq >/dev/null 2>&1 || skip "jq required"
  WORK="$(mktemp -d -t scope-drift-sysdir.XXXXXX)"
  PLAN="${WORK}/plan.md"
  printf '%s\n' '# Plan' '' '## Target Files' '' '- docs/only-this.md' >"${PLAN}"
}

teardown() {
  [[ -n "${WORK:-}" && -d "${WORK}" ]] && rm -rf "${WORK}"
}

# Args: $1 = file_path probe.
run_edit() {
  local payload
  payload="$(jq -n --arg f "$1" '{tool_name:"Edit", tool_input:{file_path:$f}}')"
  run env HOME="${WORK}" PLAN_FILE="${PLAN}" \
    bash -c 'printf "%s" "$1" | bash "$2"' _ "${payload}" "${HOOK}"
}

# Control row: without the short-circuit the probe DOES draw an advisory — this is what the
# silence assertions below are silence *against*.

@test "out-of-plan non-system path → SCOPE-070 advisory (control)" {
  run_edit "/Users/x/src/feature/foo.ts"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"SCOPE-070"* ]]
}

# AC5 — branch roots short-circuit silently

@test "~/.claude-work-dev/ path → silent short-circuit (AC5)" {
  run_edit "/Users/x/.claude-work-dev/settings.json"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"SCOPE-070"* ]]
}

@test "~/.claude-personal/ path → silent short-circuit (AC5)" {
  run_edit "/Users/x/.claude-personal/agents/reviewer.md"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"SCOPE-070"* ]]
}

@test "dormant backup dir path → silent short-circuit" {
  run_edit "/Users/x/.claude-pre-glass-atrium-backup-20260603T043853Z/settings.json"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"SCOPE-070"* ]]
}

# Non-regression: the two roots enumerated before the generalization

@test "~/.claude/ path → silent short-circuit (unchanged)" {
  run_edit "/Users/x/.claude/hooks/x.sh"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"SCOPE-070"* ]]
}

@test "~/.claude-work/ path → silent short-circuit (unchanged)" {
  run_edit "/Users/x/.claude-work/settings.json"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"SCOPE-070"* ]]
}

@test "memory arm → silent short-circuit (evaluated first, untouched)" {
  run_edit "/Users/x/project/memory/progress-foo.md"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" != *"SCOPE-070"* ]]
}

# Root-grammar negatives: a lookalike name is NOT a system path

@test "~/.claudex/ lookalike → advisory still emitted (not a config root)" {
  run_edit "/Users/x/.claudex/settings.json"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"SCOPE-070"* ]]
}

@test "dot-less claude-work/ → advisory still emitted (leading-dot discipline)" {
  run_edit "/Users/x/claude-work/settings.json"
  [[ "${status}" -eq 0 ]]
  [[ "${output}" == *"SCOPE-070"* ]]
}
