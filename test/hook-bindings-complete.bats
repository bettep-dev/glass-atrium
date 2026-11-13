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
  detect-secret-file-write.sh
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

@test "every binding-options row is a JSON object of managed keys for an expected (event, hook) pair" {
  local rows expected event hook options bad=""
  rows="$(drive_engine get_expected_binding_option_rows)" || {
    echo "the options reader did not run: ${rows}"
    return 1
  }
  expected="$(drive_engine _get_expected_binding_keys)"
  while IFS=$'\t' read -r event hook options; do
    [[ -n "${event}" ]] || continue
    jq -e 'type == "object" and length > 0 and ((keys - ["asyncRewake", "timeout"]) | length) == 0' \
      <<<"${options}" >/dev/null 2>&1 || bad="${bad} ${event}/${hook}:unmanaged-or-not-an-object"
    [[ $'\n'"${expected}" == *$'\n'"${event}"$'\x1f'"${hook}"$'\x1f'* ]] || bad="${bad} ${event}/${hook}:no-binding-row"
  done <<<"${rows}"
  [[ -z "${bad}" ]] || {
    echo "invalid binding-options row(s):${bad}"
    return 1
  }
}

@test "the queue listener is bound asyncRewake on SessionStart and Stop, with a timeout its own lifetime ends inside" {
  local rows lifetime poll_s max_s event options bad=""
  rows="$(drive_engine get_expected_binding_option_rows)"
  # the CLI's own constants: the host SIGTERMs the hook at the timeout, so the last poll must end before it
  lifetime="$(sed -n 's/^readonly LISTEN_LIFETIME_S=\([0-9]*\)$/\1/p' "${GA}/scripts/atrium-queue.sh")"
  poll_s="$(sed -n 's/^readonly WAIT_POLL_S=\([0-9]*\)$/\1/p' "${GA}/scripts/atrium-queue.sh")"
  max_s="$(sed -n 's/^readonly CLI_MAX_TIME_S=\([0-9]*\)$/\1/p' "${GA}/scripts/atrium-queue.sh")"
  for event in SessionStart Stop; do
    options="$(awk -F '\t' -v e="${event}" '$1 == e && $2 == "queue-listener.sh" { print $3 }' <<<"${rows}")"
    jq -e --argjson floor "$((lifetime + poll_s + max_s))" '.asyncRewake == true and .timeout > $floor' \
      <<<"${options}" >/dev/null 2>&1 || bad="${bad} ${event}:${options:-unbound}"
  done
  [[ -n "${lifetime}" && -z "${bad}" ]] || {
    echo "lifetime=${lifetime} listener binding options:${bad}"
    return 1
  }
}

# Run one engine function inside the initialized engine; stdout = its output.
drive_engine() {
  env GA_TARGET_HOME="${BATS_TEST_TMPDIR}" GA_DATA_ROOT="${BATS_TEST_TMPDIR}/data" bash -c '
    set -Eeuo pipefail
    source "$1/lib/ga-core.sh"
    ga_init_env "$1"
    shift
    "$@"
  ' _ "${GA}" "$@" 2>&1
}
