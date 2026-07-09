#!/usr/bin/env bats
# token-setup-raw-reduction.bats — Track B regression guard for the Token Setup
# (ITEM 3) cooked-TTY raw-block reduction. The panel is already framed on both
# sides (a work-box pre-cue before the alt-screen drop, a framed done-digest
# after re-entry); the ONE unavoidable cooked-TTY segment previously printed a
# verbose section-header plus multi-line guidance. The reduction REPLACES that
# block with a SINGLE minimal point-of-need line — it does NOT remove the cue
# and does NOT touch the framing or the return-code -> digest mapping.
#
# Strategy: static source-content assertions against the launcher. The panel is
# interactive (claude setup-token owns a live cooked TTY), so it cannot be
# driven headlessly; sourcing the launcher would also execute main under its
# strict-mode ERR trap. Grepping the source mirrors the sibling bats pattern
# (render-launchd-plists.bats) and pins the exact reduction shape.
#
# Run via: bats test/token-setup-raw-reduction.bats
# Requires: bats (brew install bats-core), bash 3.2+

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
REAL_GA="${GA}/glass-atrium"
REDUCED_LINE='approve in your browser, then return here (env-var CLAUDE_CODE_OAUTH_TOKEN only — never the token value)'

setup() {
  [[ -f "${REAL_GA}" ]] || skip "glass-atrium not found: ${REAL_GA}"
}

# Slice the cooked-TTY segment: from the alt-screen drop (tp rmcup) up to the
# UNCHANGED provisioning call. The reduced point-of-need cue lives here, and
# nothing else must print in this out-of-frame window.
cooked_segment() {
  awk '/^  tp rmcup$/{f=1} f{print} /preflight_provision_headless_token \|\| status=/{exit}' "${GA}"/lib/ga-tui-*.sh
}

@test "reduced cue: the single point-of-need line is present next to the URL" {
  run grep -F -- "${REDUCED_LINE}" "${REAL_GA}" "${GA}"/lib/ga-tui-*.sh
  [[ "${status}" -eq 0 ]]
}

@test "reduction not removal: the cooked segment prints exactly one tty_line" {
  local n
  n="$(cooked_segment | grep -cE '^  tty_line ')"
  [[ "${n}" -eq 1 ]]
}

@test "old verbose block gone: section-header + multi-line guidance removed" {
  # The verbose section_header banner must no longer bracket the cooked segment.
  run grep -F 'section_header "Token Setup — OAuth approval"' "${REAL_GA}"
  [[ "${status}" -eq 1 ]]
  # The old two-line phrasing must be gone (proves a reframe, not a keep-both).
  run grep -F 'the OAuth URL appears below.' "${REAL_GA}"
  [[ "${status}" -eq 1 ]]
}

@test "framed pre-cue intact: run-state opener before the drop is unchanged" {
  run grep -F 'STEP_LABEL_ACTIVE_CUR="Opening browser for OAuth approval…"' "${REAL_GA}" "${GA}"/lib/ga-tui-*.sh
  [[ "${status}" -eq 0 ]]
  run grep -qF 'enter_run_state' "${REAL_GA}"
  [[ "${status}" -eq 0 ]]
}

@test "framed return intact: smcup re-entry + done-digest render preserved" {
  local body
  body="$(awk '/^dispatch_action_token_panel\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "${REAL_GA}" "${GA}"/lib/ga-tui-*.sh)"
  printf '%s\n' "${body}" | grep -qF 'tp smcup'
  printf '%s\n' "${body}" | grep -qF 'parse_token_summary "${status}"'
  printf '%s\n' "${body}" | grep -qF 'status_line "${status}" "Token Setup"'
}

@test "digest mapping unchanged: return code drives parse_token_summary" {
  # preflight return code -> status -> parse_token_summary must be byte-for-byte.
  run grep -F 'preflight_provision_headless_token || status=$?' "${REAL_GA}" "${GA}"/lib/ga-tui-*.sh
  [[ "${status}" -eq 0 ]]
}

@test "security invariant: env-var NAME only, token value never printed" {
  # The reduced cue names the env var, never a token value.
  printf '%s\n' "${REDUCED_LINE}" | grep -qF 'CLAUDE_CODE_OAUTH_TOKEN'
  # The cooked segment must not cat/read the secrets file into the terminal.
  run bash -c "cooked=\$(awk '/^  tp rmcup\$/{f=1} f{print} /preflight_provision_headless_token \\|\\| status=/{exit}' ${GA}/lib/ga-tui-*.sh); printf '%s' \"\${cooked}\" | grep -E 'cat .*claude-auth|printf.*OAUTH_TOKEN=[^ ]'"
  [[ "${status}" -ne 0 ]]
}
