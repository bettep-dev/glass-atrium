#!/usr/bin/env bats
# enforce-harness-critical.sh — envelope-driven suite (plan clauded-docs/285 T2).
#
# PreToolUse(Write|Edit + Bash) harness-critical gate, agent_id-INDEPENDENT:
#   Write|Edit arm → live settings.json/settings.local.json · live hook dirs ·
#   agents/*.md frontmatter identity keys {name, tools, scope} (model excluded,
#   body edits pass) · NEW agents/*.md Write. Bash arm → best-effort mutation-verb
#   + protected-path-literal text match (indirection residual PASSES by design).
# Block channel: HAR-001/HAR-002 emit_error + exit 2 · fail-closed HAR-003 on a
# python3-less PATH · HARNESS_PROTECTION_APPROVE=1 launch-env grant passes.
#
# Run via: bats hooks/test/enforce-harness-critical.bats
# Requires: bats (brew install bats-core), bash 3.2+, python3, jq.
#
# Hermetic strategy: the hook is HOME-anchored, so every protected path lives
# under a per-test FAKE_HOME (BATS_TEST_TMPDIR) — no live-install dependency.

HOOK_SH="${BATS_TEST_DIRNAME}/../enforce-harness-critical.sh"

setup() {
  [[ -f "${HOOK_SH}" ]] || skip "hook not found: ${HOOK_SH}"
  command -v python3 >/dev/null 2>&1 || skip "python3 required"
  command -v jq >/dev/null 2>&1 || skip "jq required"

  FAKE_HOME="${BATS_TEST_TMPDIR}/home"
  mkdir -p "${FAKE_HOME}/.claude/hooks" "${FAKE_HOME}/.claude/agents" \
    "${FAKE_HOME}/.glass-atrium/hooks" "${FAKE_HOME}/.glass-atrium/agents"

  # Seeded EXISTING agent file — identity keys + excluded model key + a body whose
  # text deliberately contains an identity-SHAPED line (must NOT block a body edit).
  cat >"${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" <<'MD'
---
name: glass-atrium-dev-shell
tools: [Read, Bash]
scope: DEV
model: claude-model-a
---
# Body

Body paragraph mentioning name: not-frontmatter inside the body.
MD
}

# Build an envelope with jq and run the hook under FAKE_HOME.
# Args: $1=tool_name $2=tool_input JSON object $3=agent_id (optional, "" = main session).
run_hook() {
  local tool="${1}" tin="${2}" agent="${3:-}" envelope
  if [[ -n "${agent}" ]]; then
    envelope="$(jq -cn --arg t "${tool}" --arg a "${agent}" --argjson ti "${tin}" \
      '{tool_name: $t, agent_id: $a, tool_input: $ti}')"
  else
    envelope="$(jq -cn --arg t "${tool}" --argjson ti "${tin}" \
      '{tool_name: $t, tool_input: $ti}')"
  fi
  run env "HOME=${FAKE_HOME}" bash "${HOOK_SH}" <<<"${envelope}"
}

# jq-built Write/Edit tool_input helpers (nested quotes stay well-formed).
write_input() { jq -cn --arg p "${1}" --arg c "${2}" '{file_path: $p, content: $c}'; }
edit_input() { jq -cn --arg p "${1}" --arg o "${2}" --arg n "${3}" '{file_path: $p, old_string: $o, new_string: $n}'; }
bash_input() { jq -cn --arg c "${1}" '{command: $c}'; }

# ── AC2-1: block classes, each with AND without agent_id ─────────────────────

@test "live settings.json Write (main session) → HAR-001 block (exit 2)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.claude/settings.json" '{"hooks":{}}')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-001"* ]] || return 1
}

@test "live settings.json Write (subagent, agent_id present) → block (agent_id-independent)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.claude/settings.json" '{"hooks":{}}')" "a1"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "live settings.local.json Edit → block (exit 2)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.claude/settings.local.json" 'x' 'y')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "live GA hooks dir Write (main session) → block (exit 2)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/hooks/track-outcome.sh" 'echo pwned')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "live GA hooks dir Write (subagent) → block (agent_id-independent)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/hooks/track-outcome.sh" 'echo pwned')" "a1"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "legacy claude hooks dir Edit → block (exit 2)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.claude/hooks/legacy.sh" 'a' 'b')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "traversal cannot dodge the prefix: .claude/x/../settings.json → block" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.claude/x/../settings.json" '{}')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "agents identity Edit: tools line (main session) → block (exit 2)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    'tools: [Read, Bash]' 'tools: [Read, Bash, Write]')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"identity-frontmatter-edit"* ]] || return 1
}

@test "agents identity Edit: tools line (subagent) → block (agent_id-independent)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    'tools: [Read, Bash]' 'tools: [Read, Bash, Write]')" "a1"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "agents identity Write: existing file with changed scope line → block" {
  local content
  content="$(printf -- '---\nname: glass-atrium-dev-shell\ntools: [Read, Bash]\nscope: QA\nmodel: claude-model-a\n---\n# Body\n')"
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" "${content}")"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"identity-frontmatter-write"* ]] || return 1
}

@test "NEW agents/*.md Write (main session) → block (agent_lifecycle CLI owns creation)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-new.md" $'---\nname: x\n---\nbody')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"new-agent-creation"* ]] || return 1
}

@test "NEW agents/*.md Write (subagent) → block (agent_id-independent)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/.claude/agents/glass-atrium-dev-new.md" $'---\nname: x\n---\nbody')" "a1"
  [[ "${status}" -eq 2 ]] || return 1
}

# ── Fence-tamper guards: the 3-step fence-removal bypass is cut ──────────────

@test "agents fence-removal Edit (closing ---, no identity key) → block" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    $'---\n# Body' '# Body')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"frontmatter-fence-edit"* ]] || return 1
}

@test "agents fence-insertion Edit inside frontmatter → block (span-shrink attempt)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    'model: claude-model-a' $'---\nmodel: claude-model-a')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"frontmatter-fence-edit"* ]] || return 1
}

@test "agents Edit on UNTERMINATED-fence file (value-only old_string) → block" {
  cat >"${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-broken.md" <<'MD'
---
name: glass-atrium-dev-broken
tools: [Read]
scope: DEV
# Body without a closing fence
MD
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-broken.md" \
    '[Read]' '[Read, Bash, Write]')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"unterminated-frontmatter"* ]] || return 1
}

@test "agents Write onto UNTERMINATED-fence file → block (tampered state frozen)" {
  cat >"${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-broken.md" <<'MD'
---
name: glass-atrium-dev-broken
# Body without a closing fence
MD
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-broken.md" 'anything')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"unterminated-frontmatter"* ]] || return 1
}

@test "agents body Edit touching a body --- hr → pass (fence guard is overlap-scoped)" {
  cat >"${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-hr.md" <<'MD'
---
name: glass-atrium-dev-hr
tools: [Read]
scope: DEV
---
# Body

---

After the horizontal rule.
MD
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-hr.md" \
    $'---\n\nAfter the horizontal rule.' 'After the rule.')"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── AC2-2: body / model-line edits pass (0 false blocks) ─────────────────────

@test "agents body-only Edit → pass (exit 0)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    'Body paragraph mentioning' 'Body paragraph now mentioning')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "agents body Edit touching an identity-SHAPED body line → pass (no frontmatter overlap)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    'name: not-frontmatter' 'name: still-not-frontmatter')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "agents model-line Edit → pass (model excluded from identity set)" {
  run_hook "Edit" "$(edit_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" \
    'model: claude-model-a' 'model: claude-model-b')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "agents Write of existing file: identity unchanged, model+body changed → pass" {
  local content
  content="$(printf -- '---\nname: glass-atrium-dev-shell\ntools: [Read, Bash]\nscope: DEV\nmodel: claude-model-b\n---\n# New body\n')"
  run_hook "Write" "$(write_input "${FAKE_HOME}/.glass-atrium/agents/glass-atrium-dev-shell.md" "${content}")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "repo-tree agents path (outside HOME anchors) → pass (git tree untouched)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/git/glass-atrium/agents/glass-atrium-dev-shell.md" 'x')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "unprotected path Write → pass (exit 0)" {
  run_hook "Write" "$(write_input "${FAKE_HOME}/project/src/app.ts" 'code')"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── AC2-3: launch-env approval grant ─────────────────────────────────────────

@test "HARNESS_PROTECTION_APPROVE=1 launch env passes an otherwise-blocked write" {
  local envelope
  envelope="$(jq -cn --arg p "${FAKE_HOME}/.claude/settings.json" \
    '{tool_name: "Write", tool_input: {file_path: $p, content: "{}"}}')"
  run env "HOME=${FAKE_HOME}" HARNESS_PROTECTION_APPROVE=1 bash "${HOOK_SH}" <<<"${envelope}"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── AC2-4: python3-absent fail-closed (HAR-003) ──────────────────────────────

# Build a PATH containing only the coreutils the hook needs, EXCLUDING python3
# (mirrors enforce-delegation.bats H-3). Echoes the stripped bin dir on stdout.
minimal_bin_without_python3() {
  local bindir="${BATS_TEST_TMPDIR}/minbin" tool src
  mkdir -p "${bindir}"
  for tool in bash cat grep basename tr sed env mktemp dirname; do
    src="$(command -v "${tool}")"
    [[ -n "${src}" ]] && ln -sf "${src}" "${bindir}/${tool}"
  done
  printf '%s\n' "${bindir}"
}

@test "python3 absent + protected write → HAR-003 block (fail-closed, exit 2)" {
  local bindir
  bindir="$(minimal_bin_without_python3)"
  run env "PATH=${bindir}" "HOME=${FAKE_HOME}" bash -c '
    printf "%s" "$1" | bash "$2"
  ' _ "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"${FAKE_HOME}/.claude/settings.json\",\"content\":\"{}\"}}" "${HOOK_SH}"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-003"* ]] || return 1
}

@test "python3 absent + empty stdin → pass (no over-block of empty input)" {
  local bindir
  bindir="$(minimal_bin_without_python3)"
  run env "PATH=${bindir}" "HOME=${FAKE_HOME}" bash -c '
    printf "%s" "" | bash "$1"
  ' _ "${HOOK_SH}"
  [[ "${status}" -eq 0 ]] || return 1
}

# ── AC2-5: Bash arm — mutation verb + protected-path literal ─────────────────

@test "bash: redirection overwrite into live settings → HAR-002 block" {
  run_hook "Bash" "$(bash_input 'echo x > ~/.claude/settings.json')"
  [[ "${status}" -eq 2 ]] || return 1
  [[ "${output}" == *"HAR-002"* ]] || return 1
}

@test "bash: redirection append into live settings → block" {
  run_hook "Bash" "$(bash_input 'echo x >> ~/.claude/settings.json')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: tee into live GA hooks dir → block" {
  run_hook "Bash" "$(bash_input 'echo pwn | tee ~/.glass-atrium/hooks/track-outcome.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: cp into legacy claude hooks dir → block" {
  run_hook "Bash" "$(bash_input 'cp /tmp/evil.sh ~/.claude/hooks/evil.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: mv onto live agents file → block" {
  run_hook "Bash" "$(bash_input 'mv /tmp/x.md ~/.glass-atrium/agents/glass-atrium-dev-shell.md')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: ln -sfn into live hooks dir → block" {
  run_hook "Bash" "$(bash_input 'ln -sfn /tmp/evil.sh ~/.claude/hooks/x.sh')"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: sed -i in-place on live hook (\$HOME form) → block" {
  run_hook "Bash" "$(bash_input "sed -i '' 's/a/b/' \$HOME/.glass-atrium/hooks/a.sh")"
  [[ "${status}" -eq 2 ]] || return 1
}

@test "bash: read-only use of a protected path (cat | tee /tmp) → pass" {
  run_hook "Bash" "$(bash_input 'cat ~/.claude/settings.json | tee /tmp/out')"
  [[ "${status}" -eq 0 ]] || return 1
}

# Quoted '>' inside an argument is NOT a redirect shape — read-only commands on
# protected paths must not false-block (reproduced review false-positives).

@test "bash: grep -- '->' on live settings → pass (quoted >, not a redirect)" {
  run_hook "Bash" "$(bash_input "grep -- '->' ~/.claude/settings.json")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "bash: grep '=>' on live agents file → pass (quoted >, not a redirect)" {
  run_hook "Bash" "$(bash_input "grep '=>' ~/.glass-atrium/agents/glass-atrium-dev-shell.md")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "bash: awk comparison '\$1 > 5' on live hook → pass (target token is not protected)" {
  run_hook "Bash" "$(bash_input "awk '\$1 > 5' ~/.glass-atrium/hooks/a.sh")"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "bash: variable-indirection residual → pass (documented, bar-raising only)" {
  run_hook "Bash" "$(bash_input 'P=~/.claude/settings.json; echo x > "$P"')"
  [[ "${status}" -eq 0 ]] || return 1
}

@test "bash: unrelated command → pass" {
  run_hook "Bash" "$(bash_input 'ls -la /tmp')"
  [[ "${status}" -eq 0 ]] || return 1
}
