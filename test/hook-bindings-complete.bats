#!/usr/bin/env bats
# Guard: every security-critical hook stays bound in EXPECTED_HOOK_BINDINGS (lib/ga-env.sh).
# wire_hooks iterates this array, so a vanished row silently leaves its gate DORMANT; this test
# fails naming the binding that vanished. Rows are split on a literal TAB (IFS=$'\t'), mirroring
# wire_hooks — a space-delimited row mis-parses its basename, which fails here only when that row
# binds one of SECURITY_CRITICAL_HOOKS; no other row is checked.
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
