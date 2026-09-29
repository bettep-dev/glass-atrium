#!/usr/bin/env bats
# render-claude-auth.bats — pins render-claude-auth.sh's own exit contract; the preflight provisioning
# flow that drives it end to end is pinned in test/token-paste-provisioning.bats.

# BATS_TEST_DIRNAME / BATS_TEST_TMPDIR are assigned by the bats runtime (SC2154 false positive).
# shellcheck disable=SC2154

RENDER_SH="${BATS_TEST_DIRNAME}/../render-claude-auth.sh"
# Clears the plausible-shape guard (16+ chars, no whitespace or control chars); belongs to no account.
PLAUSIBLE_VALUE='sk-ant-oat01-bats-sandbox-value'

setup() {
  [[ -f "${RENDER_SH}" ]] || skip "render-claude-auth.sh not found"
  export GA_ROOT="${BATS_TEST_TMPDIR}/ga"
  SANDBOX_DIR="${BATS_TEST_TMPDIR}/sandbox"
  mkdir -p "${GA_ROOT}" "${SANDBOX_DIR}"
}

@test "a copy without the shared path guard beside it exits 4 with a named FATAL and writes nothing" {
  cp "${RENDER_SH}" "${SANDBOX_DIR}/render-claude-auth.sh"
  local oauth_env="CLAUDE_CODE_OAUTH_TOKEN"
  export "${oauth_env}=${PLAUSIBLE_VALUE}"

  run bash "${SANDBOX_DIR}/render-claude-auth.sh"
  # 4, never errexit's generic 1: the preflight render self-test shows this rc to the operator.
  [[ "${status}" -eq 4 ]] || {
    echo "expected exit 4, got ${status}: ${output}"
    return 1
  }
  [[ "${output}" == *"render-claude-auth: FATAL: cannot source the shared path guard"*"path-guard.sh"* ]] || {
    echo "no named FATAL: ${output}"
    return 1
  }
  local written
  written="$(ls -A "${GA_ROOT}")"
  [[ -z "${written}" ]] || {
    echo "a guard-less run still wrote under GA_ROOT: ${written}"
    return 1
  }
}
