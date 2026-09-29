#!/usr/bin/env bats
# Guard: every security-critical hook stays bound in EXPECTED_HOOK_BINDINGS (lib/ga-env.sh), and
# every row names an event Claude Code dispatches. wire_hooks iterates this array, so a vanished
# row silently leaves its gate DORMANT; this test fails naming the binding that vanished. Rows are
# split on a literal TAB (IFS=$'\t'), mirroring wire_hooks — a space-delimited row mis-parses, and
# the event-name row fails on it whatever hook it binds.
#
# Run via: bats test/hook-bindings-complete.bats
# Requires: bats (brew install bats-core), awk, sed (BSD or GNU), bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
CORE="${GA}/lib/ga-env.sh"

# hooks whose ABSENCE from the array silently disarms a gate rather than dropping a
# convenience — the set membership must name, so a vanished binding fails by name.
SECURITY_CRITICAL_HOOKS=(
  block-dangerous-commands.sh
  block-no-verify.sh
  detect-secret-file-write.sh
  enforce-config-protection.sh
  enforce-foreground-harness.sh
  enforce-harness-critical.sh
  validate-pre-write-raw.sh
  validate-prompt.sh
  validate-secret-scan.sh
)

# The hook-event set of the installed CLI (2.1.283 bundle). wire_hooks creates any event key it is
# handed and the doctor reads that key back as bound, so a misspelled event is wired, reported ok and
# never fires; only this list catches it. A newly bound event joins here once checked against the CLI.
CLI_HOOK_EVENTS=(
  PreToolUse PostToolUse PostToolUseFailure PostToolBatch Notification UserPromptSubmit
  UserPromptExpansion SessionStart SessionEnd Stop StopFailure SubagentStart SubagentStop PreCompact
  PostCompact PreModelSwitch PostModelSwitch PermissionRequest PermissionDenied Setup TeammateIdle
  TaskCreated TaskCompleted Elicitation ElicitationResult ConfigChange WorktreeCreate WorktreeRemove
  InstructionsLoaded CwdChanged FileChanged DirectoryAdded MessageDisplay
)

# fail, never skip: a skipped security guard reports ok and exits 0
setup() {
  [[ -f "${CORE}" ]] || {
    echo "ga-env.sh not found: ${CORE}"
    return 1
  }
}

# emit each EXPECTED_HOOK_BINDINGS row body as "event<TAB>basename<TAB>matcher",
# the array indent + surrounding double-quotes stripped.
array_rows() {
  awk '
    /^[[:space:]]*EXPECTED_HOOK_BINDINGS=\(/ { f = 1; next }
    f && /^[[:space:]]*\)[[:space:]]*$/      { f = 0 }
    f                                        { print }
  ' "${CORE}" | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//'
}

@test "membership: every security-critical hook is bound in EXPECTED_HOOK_BINDINGS" {
  local name basename_field rest found missing="" rows
  rows="$(array_rows)"
  if [[ -z "${rows}" ]]; then
    echo "EXPECTED_HOOK_BINDINGS parsed 0 rows from ${CORE} — array format drifted from array_rows"
    return 1
  fi
  for name in "${SECURITY_CRITICAL_HOOKS[@]}"; do
    found=""
    while IFS=$'\t' read -r _ basename_field rest; do
      [[ "${basename_field}" == "${name}" ]] && found=1
    done <<<"${rows}"
    [[ -n "${found}" ]] || missing="${missing} ${name}"
  done
  if [[ -n "${missing}" ]]; then
    echo "unbound security-critical hook(s):${missing}"
    return 1
  fi
}

@test "event names: every EXPECTED_HOOK_BINDINGS row names an event Claude Code dispatches" {
  local event rest known unknown="" rows
  rows="$(array_rows)"
  if [[ -z "${rows}" ]]; then
    echo "EXPECTED_HOOK_BINDINGS parsed 0 rows from ${CORE} — array format drifted from array_rows"
    return 1
  fi
  known=" $(printf '%s ' "${CLI_HOOK_EVENTS[@]}")"
  while IFS=$'\t' read -r event rest; do
    [[ "${known}" == *" ${event} "* ]] || unknown="${unknown} [${event}]"
  done <<<"${rows}"
  if [[ -n "${unknown}" ]]; then
    echo "row event(s) Claude Code never dispatches:${unknown}"
    return 1
  fi
}
