#!/usr/bin/env bats
# harness-290-t21-capability-confinement.bats — plan clauded-docs/290 T21.
#
# T21 (premise corrected, W4): the real Bash-prune set is the TWO meta agents —
# nothing else. Verifies three deliverables:
#   1. Bash absent from both meta agents' frontmatter tools allowlist (the
#      LLM06 spawn-freeze surface — frontmatter is the enforced tool grant).
#   2. Inline shell-interpreter negations present + EXPRESSIBLE as command-prefix
#      matchers in settings.template.json permissions.deny — they close a
#      Bash(rm:*) bypass an agent could otherwise smuggle via `bash -c 'rm …'`;
#      the npm publish row sits in permissions.ask (user-approval gate).
#   3. The redirect-into-harness pattern is INEXPRESSIBLE as a command-prefix
#      matcher (so it is absent from the settings deny/ask) and is instead specified
#      in enforce-harness-critical.sh's redirect regex (asserted by a direct
#      hook invocation that blocks such a redirect).
#
# Every row reads its SoT live — settings.template.json .permissions, the agents'
# frontmatter, the committed manifest. Expected values are test-side literals, so
# a SoT edit and the oracle can never move together.
#
# Run via: bats test/harness-290-t21-capability-confinement.bats
# Requires: bats, bash 3.2+, jq; python3 only for the hook-redirect regression row.
#
# INVOCATION CONVENTION — the hook is executed DIRECTLY as a command, never
# interpreter-prefixed: an interpreter prefix bypasses the executable bit, so a
# mode-644 hook (inert to Claude Code) would still pass. Direct execution
# exercises the real path.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
# settings.template.json is a manifest bundle member, so it resolves under GA in a
# consumer install exactly as in the checkout — the rows below need no skip guard.
SETTINGS="${GA}/settings.template.json"
HOOK_SH="${GA}/hooks/enforce-harness-critical.sh"
MANIFEST="${GA}/manifest.json"

# "<agent basename>|<grants that MUST survive the surgical prune>" — the survivor
# column is the anti-vacuity half: a wiped or mis-parsed frontmatter passes the
# Bash negation trivially, and only a positive grant catches that.
META_AGENT_GRANTS=(
  "glass-atrium-meta-agent.md|Read,Write"
  "glass-atrium-meta-prompt-engineer.md|WebSearch,Edit"
)

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
}

# Emit the frontmatter block (lines strictly between the first two `---` fences).
frontmatter_block() {
  awk 'NR==1 && $0=="---"{infm=1; next} infm && $0=="---"{exit} infm{print}' "${1}"
}

@test "meta agents: Bash pruned from frontmatter, surviving grants intact (LLM06 grant surface)" {
  local row file grants block tool
  local -a want
  for row in "${META_AGENT_GRANTS[@]}"; do
    file="${GA}/agents/${row%%|*}"
    grants="${row#*|}"
    [[ -f "${file}" ]] || {
      echo "agent file not found: ${file}"
      return 1
    }
    block="$(frontmatter_block "${file}")"
    # -w: reject the standalone Bash token (block-list `- Bash` or inline `, Bash]`).
    if grep -qw 'Bash' <<<"${block}"; then
      echo "Bash grant still present in frontmatter: ${file}"
      return 1
    fi
    IFS=',' read -r -a want <<<"${grants}"
    for tool in "${want[@]}"; do
      grep -qw "${tool}" <<<"${block}" || {
        echo "surviving grant absent (prune was a wipe, or frontmatter unparsed): ${file} ${tool}"
        return 1
      }
    done
  done
}

@test "settings deny: interpreter negations present, each a well-formed command-prefix matcher" {
  # A settings command-prefix matcher is Bash(<non-empty prefix>:*), anchored on
  # the leading command token — the shape that makes these negations expressible
  # at all (contrast the redirect row below). Membership AND shape in one jq whose
  # status is the test's last command.
  run jq -e '
    ["Bash(rm:*)", "Bash(rm -rf:*)",
     "Bash(bash -c:*)", "Bash(sh -c:*)", "Bash(zsh -c:*)", "Bash(eval:*)"] as $need
    | (($need - .permissions.deny) == [])
      and ([.permissions.deny[] | select(test("^Bash\\([^()]+:\\*\\)$") | not)] | length) == 0
  ' "${SETTINGS}"
  [[ "${status}" -eq 0 ]]
}

@test "settings: blanket allow is exactly Bash(*), auto mode, npm publish gated in ask not deny" {
  # Full-array equality on allow (the widest grant — a surplus member here is the
  # whole security story) plus the explicit negative on the ask/deny split: a row
  # left in BOTH arrays is deny-shadowed and the user-approval gate never fires.
  run jq -e '
    .permissions.allow == ["Bash(*)"]
    and .permissions.defaultMode == "auto"
    and (.permissions.ask | index("Bash(npm publish:*)")) != null
    and (.permissions.deny | index("Bash(npm publish:*)")) == null
  ' "${SETTINGS}"
  [[ "${status}" -eq 0 ]]
}

@test "redirect-into-harness is INEXPRESSIBLE in settings deny/ask (no harness-path entry)" {
  # A '> harness-path' redirect cannot be a command-prefix matcher: the > operator
  # and its target appear anywhere in the command, not at the leading-token anchor.
  # The length guard is the anti-vacuity half — empty deny/ask arrays would satisfy
  # the absence clause without asserting anything.
  run jq -e '
    (.permissions.deny + .permissions.ask) as $rows
    | ($rows | length) > 0
      and ([$rows[] | select(test("\\.claude|\\.glass-atrium"))] | length) == 0
  ' "${SETTINGS}"
  [[ "${status}" -eq 0 ]]
}

@test "the redirect pattern is specified in the hook: redirect into live hooks dir blocks" {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  local fake_home="${BATS_TEST_TMPDIR}/home"
  mkdir -p "${fake_home}/.claude/hooks"
  local cmd='echo pwned > $HOME/.claude/hooks/evil.sh'
  local tin envelope
  tin="$(jq -cn --arg c "${cmd}" '{command: $c}')"
  envelope="$(jq -cn --argjson ti "${tin}" '{tool_name: "Bash", tool_input: $ti}')"
  run env "HOME=${fake_home}" "${HOOK_SH}" <<<"${envelope}"
  [[ "${status}" -eq 2 ]]
}

@test "committed manifest carries the three shipped root artifacts" {
  # The sandbox membership row runs against a synthetic tree, so it stays green in
  # the state this row exists for: SCOPE_PATHS fixed, manifest.json never regenerated.
  # Membership only — a count assertion would go red on the next legitimate addition.
  run jq -e '(.files | index("settings.template.json")) != null
             and (.files | index("LICENSE")) != null
             and (.files | index("LICENSES-THIRD-PARTY.md")) != null' "${MANIFEST}"
  [[ "${status}" -eq 0 ]]
}
