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
# alt-screen re-entry (tp smcup). The reduced point-of-need cue lives here, and
# nothing else must print in this out-of-frame window.
#
# The terminator is smcup, NOT the provisioning call: output stays cooked and
# out-of-frame until the alt-screen is back, so terminating at the provisioning
# call left the three lines between it and smcup scanned by nothing once the
# file-wide "old verbose block gone" rows were cut.
cooked_segment() {
  awk '/^  tp rmcup$/{f=1} f{print} f&&/^  tp smcup$/{exit}' "${GA}"/lib/ga-tui-*.sh
}

@test "reduction not removal: the cooked segment prints exactly one line" {
  # Every print primitive counts, not tty_line alone: re-introducing a verbose block through
  # section_header or a bare printf is the same out-of-frame regression, and a count is
  # independent of whatever wording the reintroduced block would carry.
  local n
  n="$(cooked_segment | grep -cE '^[[:space:]]*(tty_line|section_header|printf|echo|cat)[[:space:]]' || true)"
  n="${n:-0}"
  [[ "${n}" -eq 1 ]]
}

@test "framed return intact: smcup re-entry + done-digest render preserved" {
  local body
  body="$(awk '/^dispatch_action_token_panel\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "${REAL_GA}" "${GA}"/lib/ga-tui-*.sh)"
  # Scoped to the panel body on purpose: enter_run_state is defined and called across the tui
  # libs, so a file-wide grep for it holds whether or not this panel still opens the frame.
  printf '%s\n' "${body}" | grep -qF 'enter_run_state'
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
  # The one cue reaching the cooked TTY is this line, and it names the env var, never a value.
  cooked_segment | grep -qF -- "${REDUCED_LINE}"
  printf '%s\n' "${REDUCED_LINE}" | grep -qF 'CLAUDE_CODE_OAUTH_TOKEN'
  # The cooked segment must not cat/read the secrets file into the terminal. The awk is a hand
  # copy of cooked_segment (run bash -c spawns a subshell that cannot see the bats function), so
  # its terminator MUST track cooked_segment's: left at the provisioning call it skipped the same
  # out-of-frame window, and a secrets cat placed there was measured to pass this row.
  run bash -c "cooked=\$(awk '/^  tp rmcup\$/{f=1} f{print} f&&/^  tp smcup\$/{exit}' ${GA}/lib/ga-tui-*.sh); printf '%s' \"\${cooked}\" | grep -E 'cat .*claude-auth|printf.*OAUTH_TOKEN=[^ ]'"
  [[ "${status}" -ne 0 ]]
}
