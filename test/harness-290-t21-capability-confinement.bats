#!/usr/bin/env bats
# harness-290-t21-capability-confinement.bats — plan clauded-docs/290 T21.
#
# T21 (premise corrected, W4): the real Bash-prune set is the TWO meta agents —
# nothing else. Verifies three deliverables:
#   1. Bash absent from both meta agents' frontmatter tools allowlist (the
#      LLM06 spawn-freeze surface — frontmatter is the enforced tool grant).
#   2. Inline shell-interpreter negations present + EXPRESSIBLE as command-prefix
#      matchers in settings.template.json permissions.deny — they close a
#      Bash(rm:*) bypass an agent could otherwise smuggle via `bash -c 'rm …'`.
#   3. The redirect-into-harness pattern is INEXPRESSIBLE as a command-prefix
#      matcher (so it is absent from the settings deny) and is instead specified
#      in enforce-harness-critical.sh's redirect regex (asserted by a direct
#      hook invocation that blocks such a redirect).
#
# Fail-at-HEAD: rows 1-2 fail before the prune (Bash present) / before the deny
# additions (negations absent); row on the hook redirect passes at HEAD by design
# (T21 W4: the redirect regex was already correct — this row regression-guards it).
#
# Run via: bats test/harness-290-t21-capability-confinement.bats
# Requires: bats, bash 3.2+, jq; python3 only for the hook-redirect regression row.
#
# INVOCATION CONVENTION — the hook is executed DIRECTLY as a command, never
# interpreter-prefixed: an interpreter prefix bypasses the executable bit, so a
# mode-644 hook (inert to Claude Code) would still pass. Direct execution
# exercises the real path.

GA="$(cd -- "${BATS_TEST_DIRNAME}/.." && pwd)"
META_AGENT="${GA}/agents/glass-atrium-meta-agent.md"
META_PROMPT="${GA}/agents/glass-atrium-meta-prompt-engineer.md"
SETTINGS="${GA}/settings.template.json"
HOOK_SH="${GA}/hooks/enforce-harness-critical.sh"

setup() {
  command -v jq >/dev/null 2>&1 || skip "jq required"
}

# settings.template.json is a REPO-ONLY template (not a manifest bundle member), so a
# consumer install has no settings target — skip there; PER-TEST (not setup-wide)
# because the agents/hook rows target BUNDLED files and must keep running.
require_settings_template() {
  [[ -f "${SETTINGS}" ]] || skip "settings.template.json absent (consumer install — repo-only template)"
}

# Emit the frontmatter block (lines strictly between the first two `---` fences).
frontmatter_block() {
  awk 'NR==1 && $0=="---"{infm=1; next} infm && $0=="---"{exit} infm{print}' "${1}"
}

@test "meta-agent frontmatter: Bash pruned (LLM06 grant absent)" {
  [[ -f "${META_AGENT}" ]] || skip "agent file not found: ${META_AGENT}"
  run frontmatter_block "${META_AGENT}"
  [[ "${status}" -eq 0 ]]
  # -w: reject the standalone Bash token (block-list `- Bash` or inline `, Bash]`).
  ! grep -qw 'Bash' <<<"${output}"
}

@test "meta-prompt-engineer frontmatter: Bash pruned (LLM06 grant absent)" {
  [[ -f "${META_PROMPT}" ]] || skip "agent file not found: ${META_PROMPT}"
  run frontmatter_block "${META_PROMPT}"
  [[ "${status}" -eq 0 ]]
  ! grep -qw 'Bash' <<<"${output}"
}

@test "meta agents retain their non-Bash tools (prune is surgical, not a wipe)" {
  # Guards against an over-broad edit — Read/Grep/Edit/Write MUST survive.
  frontmatter_block "${META_AGENT}" | grep -qw 'Read'
  frontmatter_block "${META_AGENT}" | grep -qw 'Write'
  frontmatter_block "${META_PROMPT}" | grep -qw 'WebSearch'
  frontmatter_block "${META_PROMPT}" | grep -qw 'Edit'
}

@test "settings deny carries the four interpreter-invocation negations" {
  require_settings_template
  local negation
  for negation in 'Bash(bash -c:*)' 'Bash(sh -c:*)' 'Bash(zsh -c:*)' 'Bash(eval:*)'; do
    run jq -e --arg n "${negation}" '.permissions.deny | index($n)' "${SETTINGS}"
    [[ "${status}" -eq 0 ]] || {
      echo "missing deny negation: ${negation}"
      return 1
    }
  done
}

@test "each interpreter negation is a well-formed command-prefix matcher (expressible)" {
  require_settings_template
  # A settings command-prefix matcher is Bash(<non-empty prefix>:*), anchored on
  # the leading command token. Every interpreter negation MUST fit this shape.
  run jq -r '.permissions.deny[] | select(test("^Bash\\((bash|sh|zsh) -c:\\*\\)$") or . == "Bash(eval:*)")' "${SETTINGS}"
  [[ "${status}" -eq 0 ]]
  [[ "$(printf '%s\n' "${output}" | grep -c .)" -eq 4 ]]
}

@test "redirect-into-harness is INEXPRESSIBLE in settings deny (no harness-path entry)" {
  require_settings_template
  # A '> harness-path' redirect cannot be a command-prefix matcher: the > operator
  # and its target appear anywhere in the command, not at the leading-token anchor.
  # Proof: no deny row references a harness path — such a matcher would be inert.
  run jq -r '.permissions.deny[] | select(test("\\.claude|\\.glass-atrium"))' "${SETTINGS}"
  [[ "${status}" -eq 0 ]]
  [[ -z "${output}" ]]
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

@test "AC6 regression: blanket grant + auto mode + rm denies unchanged" {
  require_settings_template
  run jq -e '.permissions.allow == ["Bash(*)"]' "${SETTINGS}"
  [[ "${status}" -eq 0 ]]
  run jq -e '.permissions.defaultMode == "auto"' "${SETTINGS}"
  [[ "${status}" -eq 0 ]]
  run jq -e '.permissions.deny | index("Bash(rm:*)")' "${SETTINGS}"
  [[ "${status}" -eq 0 ]]
  run jq -e '.permissions.deny | index("Bash(rm -rf:*)")' "${SETTINGS}"
  [[ "${status}" -eq 0 ]]
}
