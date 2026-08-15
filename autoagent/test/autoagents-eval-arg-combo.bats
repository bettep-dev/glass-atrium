#!/usr/bin/env bats
# autoagents-eval.sh headless arg-combo proxy suite (F1 plan pins E1/E2, AC10/AC12).
# The eval sibling needs NO behavior change: its cwd is an owned dir and its tool
# list is already Write-less, so the /tmp settings-injection vector is absent. These
# rows pin that already-safe shape STATICALLY so it cannot silently regress.
#
# Static-only by design: zero execution of the script. A real behavioral probe needs
# a real CLI, auth and spend, so AC12 deliberately keeps it a manual procedure.
#
# Assertion idiom: `[[ ... ]] || return 1`. Bats does NOT catch a bare non-final
# `[[ ]]` failure, so every assertion is routed through `|| return 1`.
#
# Run via: bats autoagent/test/autoagents-eval-arg-combo.bats
# Requires: bats >= 1.5.0, bash 3.2+

bats_require_minimum_version 1.5.0

GA="$(cd -- "${BATS_TEST_DIRNAME}/../.." && pwd)"
REAL_SCRIPT="${GA}/autoagent/autoagents-eval.sh"

setup() {
  [[ -f "${REAL_SCRIPT}" ]] || skip "autoagents-eval.sh absent"
}

@test "the --tools value carries no Write token (pin E1)" {
  local tools_lines
  # comment lines stripped: the header rationale quotes the same flag verbatim
  tools_lines="$(grep -- '--tools' "${REAL_SCRIPT}" | grep -v '^[[:space:]]*#')"
  [[ -n "${tools_lines}" ]] || return 1
  ! printf '%s\n' "${tools_lines}" | grep -q 'Write' || return 1
  printf '%s\n' "${tools_lines}" | grep -q 'Read,Glob,Grep' || return 1
}

@test "cwd is the owned agents dir and never /tmp (pin E1)" {
  grep -q 'cd "\$AGENTS_DIR"' "${REAL_SCRIPT}" || return 1
  ! grep -qE '(^|[^[:alnum:]_-])cd[[:space:]]+/tmp' "${REAL_SCRIPT}" || return 1
}

@test "the header carries the why-this-arg-combo rationale anchor (AC10)" {
  grep -q 'why this arg combo' "${REAL_SCRIPT}" || return 1
}
